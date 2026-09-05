import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  createExecutionIntentDraft,
  type ExecutionIntentDraftV1,
  type ExecutionIntentStatus,
  type ExecutionIntentV1,
} from '../src/domain/execution-intent.js';
import type {
  ClaimedExecutionIntent,
  ExecutionClaimOptions,
  ExecutionClaimPurpose,
  ExecutionIntentTransitionInput,
} from '../src/ports/execution-intent-repository.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import {
  ExecutionIntentRepositoryError,
  PostgresExecutionIntentRepository,
  lockLiveSellPresenceInTransaction,
  type ExecutionIntentPool,
} from '../src/storage/execution-intent.repository.js';

const UUID = '00000000-0000-4000-8000-000000000001';
const NOW_MS = 1_788_000_000_000;
const INT32_MAX = 2_147_483_647;

void test('create uses database timestamps and replays only an exactly matching durable row', async () => {
  const draft = executionDraft('create');
  const stored = intentRow(draft);
  const client = new ScriptedClient([
    command('BEGIN'),
    result([stored], 1),
    result([], 0),
    command('COMMIT'),
    command('BEGIN'),
    result([], 0),
    result([], 0),
    result([stored], 1),
    command('COMMIT'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  const created = await repository.create(draft);
  const replayed = await repository.create(draft);

  assert.equal(created.kind, 'CREATED');
  assert.equal(replayed.kind, 'REPLAYED');
  assert.deepEqual(replayed.intent, created.intent);
  assert.ok(Object.isFrozen(created));
  assert.ok(Object.isFrozen(created.intent));
  const insert = client.calls.find((call) => call.text.includes('INSERT INTO execution_intents'));
  assert.ok(insert);
  const insertedColumns = required(/execution_intents AS intent \(([\s\S]*?)\) VALUES/u.exec(insert.text)?.[1]);
  assert.doesNotMatch(insertedColumns, /created_at|updated_at/u);
  assert.equal(insert.values?.some((value) => value instanceof Date), false);
  const conflictRead = client.calls.find((call) => call.text.includes('FOR SHARE'));
  assert.ok(conflictRead);
  assert.match(conflictRead.text, /intent\.id\s*=\s*\$1\s+OR\s+intent\.logical_order_key\s*=\s*\$2/u);
});

void test('create rejects logical-key and id collisions with fixed redacted typed errors', async () => {
  const incoming = executionDraft('collision', { positionId: 'position-incoming' });
  const conflicts = [
    executionDraft('collision', { positionId: 'position-durable' }),
    executionDraft('collision', { positionId: 'position-incoming', quoteAmountRaw: 2n }),
    executionDraft('collision', {
      positionId: 'position-incoming', requestedAtMs: NOW_MS - 2_000,
    }),
  ];
  for (const conflicting of conflicts) {
    const client = new ScriptedClient([
      command('BEGIN'), result([], 0), result([], 0),
      result([intentRow(conflicting)], 1), command('ROLLBACK'),
    ]);
    const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

    await expectCode(repository.create(incoming), 'INTENT_DUPLICATE');
    assertRedacted(client.calls);
  }
});

void test('create rejects and rolls back when a durable tombstone matches the inserted identity', async () => {
  const incoming = executionDraft('tombstoned-create');
  const client = new ScriptedClient([
    command('BEGIN'),
    result([intentRow(incoming)], 1),
    result([{
      intent_id: incoming.id,
      logical_order_key: incoming.logicalOrderKey,
    }], 1),
    command('ROLLBACK'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.create(incoming), 'INTENT_DUPLICATE');

  const tombstoneRead = client.calls.find((call) => call.text.includes('execution_intent_tombstones'));
  assert.ok(tombstoneRead);
  assert.match(
    tombstoneRead.text,
    /tombstone\.intent_id\s*=\s*\$1\s+OR\s+tombstone\.logical_order_key\s*=\s*\$2/u,
  );
  assert.deepEqual(tombstoneRead.values, [incoming.id, incoming.logicalOrderKey]);
  assertRedacted(client.calls);
});

void test('create rejects a contradictory INSERT RETURNING identity', async () => {
  const incoming = executionDraft('returning-incoming');
  const other = executionDraft('returning-other');
  const client = new ScriptedClient([
    command('BEGIN'), result([intentRow(other)], 1), result([], 0), command('ROLLBACK'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.create(incoming), 'INVALID_DATA');
});

void test('claim validates a closed purpose and preserves each selected business state', async () => {
  const cases: readonly [ExecutionClaimPurpose, ExecutionIntentStatus, readonly string[]][] = [
    ['EXECUTE', 'PROCESSING', ['PENDING', 'RETRY_READY', 'PROCESSING']],
    ['CONFIRM', 'SUBMITTED', ['SUBMITTED']],
    ['RECONCILE', 'UNKNOWN_REQUIRES_RECONCILIATION', [
      'CONFIRMED', 'RECONCILING', 'UNKNOWN_REQUIRES_RECONCILIATION',
    ]],
    ['DRY_RUN', 'PENDING', ['PENDING', 'RETRY_READY']],
    ['DRY_RUN', 'RETRY_READY', ['PENDING', 'RETRY_READY']],
  ];
  for (const [purpose, status, statuses] of cases) {
    const draft = executionDraft(`claim-${purpose}`);
    const client = new ScriptedClient([(_text, values) => result([{
      ...claimRow(draft, status), lease_token: values?.[2],
      claim_at_ms: String(NOW_MS),
    }], 1)]);
    const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

    const claim = await repository.claim({ ownerId: 'worker-1', leaseMs: 30_000, purpose });

    assert.ok(claim);
    assert.equal(claim.intent.status, status);
    assert.ok(Object.isFrozen(claim));
    assert.ok(Object.isFrozen(claim.intent));
    const call = required(client.calls[0]);
    if (purpose === 'DRY_RUN') assert.match(call.text, /FOR UPDATE OF intent SKIP LOCKED/u);
    else assert.match(call.text, /FOR UPDATE SKIP LOCKED/u);
    if (purpose === 'EXECUTE') {
      assert.match(call.text, /expires_at\s*>\s*statement_timestamp\(\)/u);
    } else if (purpose === 'DRY_RUN') {
      assert.match(call.text, /expires_at\s*>\s*operation\.at\s*\+\s*\(\$2::BIGINT/u);
    } else {
      assert.doesNotMatch(call.text, /expires_at\s*>\s*statement_timestamp\(\)/u);
    }
    if (purpose === 'DRY_RUN') {
      assert.match(call.text, /lease_expires_at\s+IS NULL\s+OR\s+.*<=\s*operation\.at/su);
    } else {
      assert.match(call.text, /lease_expires_at\s+IS NULL\s+OR\s+.*<=\s*statement_timestamp\(\)/su);
    }
    assert.match(call.text, /ORDER BY\s+(?:intent\.)?requested_at,\s*(?:intent\.)?id/u);
    assert.doesNotMatch(call.text, /gen_random_uuid|uuid_generate/u);
    for (const candidate of statuses) assert.match(call.text, new RegExp(`'${candidate}'`, 'u'));
    if (purpose === 'EXECUTE') assert.doesNotMatch(call.text, /'SIMULATED'/u);
    const setClause = required(/SET([\s\S]*?)FROM candidate/u.exec(call.text)?.[1]);
    assert.doesNotMatch(setClause, /\bstatus\b|attempt_count|last_reason_code|terminal_at/u);
    if (purpose === 'DRY_RUN') {
      const setColumns = [...setClause.matchAll(/^\s*([a-z_]+)\s*=/gmu)]
        .map((match) => required(match[1]))
        .sort();
      assert.deepEqual(setColumns, ['lease_expires_at', 'lease_owner', 'lease_token']);
      assert.doesNotMatch(call.text, /execution_attempts/u);
      assert.match(call.text, /NOT EXISTS\s*\(\s*SELECT 1\s+FROM execution_dry_run_assessments/u);
      assert.match(call.text, /assessment\.intent_id\s*=\s*intent\.id/u);
      assert.match(call.text, /assessment\.evaluator_version\s*=\s*1/u);
      assert.match(call.text, /^WITH operation AS MATERIALIZED/mu);
      assert.match(call.text, /FROM execution_intents AS intent CROSS JOIN operation/u);
    }
    assert.doesNotMatch(call.text, /execution_intent_transitions/u);
    assert.equal(call.values?.[0], 'worker-1');
    assert.equal(call.values?.[1], 30_000);
    assert.match(String(call.values?.[2]), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  }

  const pool = new ScriptedPool(new ScriptedClient([]));
  const repository = new PostgresExecutionIntentRepository(pool);
  await expectCode(repository.claim({ ownerId: 'worker', leaseMs: 1, purpose: 'OTHER' as never }), 'INVALID_INPUT');
  assert.equal(pool.connectCount, 0);
});

void test('live claims separate BUY, SELL, recovery, and reconciliation SQL', async () => {
  const cases: readonly Readonly<{
    options: ExecutionClaimOptions;
    status: ExecutionIntentStatus;
    side: 'BUY' | 'SELL';
  }>[] = [
    {
      options: { ownerId: 'worker-1', leaseMs: 30_000, purpose: 'LIVE_EXECUTE', side: 'SELL' },
      status: 'PROCESSING', side: 'SELL',
    },
    {
      options: {
        ownerId: 'worker-1', leaseMs: 30_000, purpose: 'LIVE_EXECUTE', side: 'BUY',
        generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
      },
      status: 'PENDING', side: 'BUY',
    },
    {
      options: { ownerId: 'worker-1', leaseMs: 30_000, purpose: 'LIVE_RECOVER' },
      status: 'SIGNED_NOT_SUBMITTED', side: 'SELL',
    },
    {
      options: {
        ownerId: 'worker-1', leaseMs: 30_000, purpose: 'LIVE_RECOVER', side: 'SELL',
      },
      status: 'SIGNED_NOT_SUBMITTED', side: 'SELL',
    },
    {
      options: {
        ownerId: 'worker-1', leaseMs: 30_000, purpose: 'LIVE_RECOVER', side: 'BUY',
      },
      status: 'SIGNED_NOT_SUBMITTED', side: 'BUY',
    },
  ];
  for (const { options, status, side } of cases) {
    const draft = side === 'BUY'
      ? executionDraft(`live-${options.purpose}-${side}`)
      : executionDraft(`live-${options.purpose}-${side}`, {
        side: 'SELL', venuePolicy: 'CANONICAL_EXIT',
        quoteAmountRaw: null, baseAmountRaw: 1n,
      });
    const claimStep: Step = (_text, values) => result([{
      ...claimRow(draft, status), lease_token: values?.[2],
      claim_at_ms: String(NOW_MS),
    }], 1);
    const priorityFencedBuy = (options.purpose === 'LIVE_EXECUTE'
      || options.purpose === 'LIVE_RECOVER') && options.side === 'BUY';
    const client = new ScriptedClient(priorityFencedBuy
      ? [command('BEGIN ISOLATION LEVEL READ COMMITTED'), result([], 1), claimStep, command('COMMIT')]
      : [claimStep]);
    const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

    const claim = await repository.claim(options);

    assert.ok(claim);
    assert.equal(claim.intent.side, side);
    assert.equal(claim.intent.status, status);
    const claimCall = required(client.calls.find((call) => call.text.includes(
      'UPDATE execution_intents AS intent',
    )));
    const sql = claimCall.text;
    if (options.purpose === 'LIVE_EXECUTE') {
      assert.match(sql, new RegExp(`intent\\.side\\s*=\\s*'${options.side}'`, 'u'));
      if (options.side === 'SELL') {
        assert.match(sql, /intent\.status IN \('PENDING', 'RETRY_READY', 'PROCESSING'\)/u);
      } else {
        assert.match(sql, /intent\.status\s*=\s*'PENDING'/u);
        assert.doesNotMatch(sql, /intent\.status IN \('PENDING', 'RETRY_READY', 'PROCESSING'\)/u);
        assert.match(sql, /execution_activation_armaments AS armament/u);
        assert.match(sql, /armament\.generation_id\s*=\s*\$4/u);
        assert.match(sql, /armament\.payload_version\s*=\s*2/u);
        assert.match(sql, /armament\.state\s*=\s*'ARMED'/u);
        assert.match(sql, /armament\.state_revision\s*=\s*0/u);
        assert.match(sql, /armament\.consumed_buys\s*=\s*0/u);
        assert.equal(claimCall.values?.[3], options.generationId);
      }
      if (options.side === 'SELL') {
        assert.match(sql, /intent\.expires_at\s*>\s*statement_timestamp\(\)/u);
      } else {
        assert.match(sql, /intent\.expires_at>operation\.at\+\(\$2::BIGINT\*INTERVAL '1 millisecond'\)/u);
      }
      if (options.side === 'BUY') {
        assert.equal(client.calls[0]?.text, 'BEGIN ISOLATION LEVEL READ COMMITTED');
        assert.match(client.calls[1]?.text ?? '', /execution-live-sell-presence:v1/u);
        assert.equal(client.calls.at(-1)?.text, 'COMMIT');
        assert.match(sql, /NOT EXISTS\s*\(\s*SELECT 1\s+FROM execution_intents AS blocking_sell/su);
        assert.match(sql, /blocking_sell\.side\s*=\s*'SELL'/u);
        assert.match(sql, /blocking_sell\.status\s*=\s*'SIGNED_NOT_SUBMITTED'/u);
        const blockingStart = sql.indexOf('NOT EXISTS');
        const blockingEnd = sql.indexOf('ORDER BY', blockingStart);
        const blockingPredicate = blockingStart < 0 || blockingEnd < 0
          ? undefined : sql.slice(blockingStart, blockingEnd);
        assert.ok(blockingPredicate);
        assert.doesNotMatch(blockingPredicate, /blocking_sell\.lease_expires_at/u);
      } else {
        assert.doesNotMatch(sql, /blocking_sell/u);
      }
    } else if (options.purpose === 'LIVE_RECOVER') {
      assert.match(sql, /intent\.status\s*=\s*'SIGNED_NOT_SUBMITTED'/u);
      assert.doesNotMatch(sql, /intent\.expires_at\s*>\s*statement_timestamp\(\)/u);
      if (options.side === undefined) {
        assert.doesNotMatch(sql, /intent\.side\s*=/u);
      } else {
        assert.match(sql, new RegExp(`intent\\.side\\s*=\\s*'${options.side}'`, 'u'));
      }
      if (options.side === 'BUY') {
        assert.equal(client.calls[0]?.text, 'BEGIN ISOLATION LEVEL READ COMMITTED');
        assert.match(client.calls[1]?.text ?? '', /execution-live-sell-presence:v1/u);
        assert.equal(client.calls.at(-1)?.text, 'COMMIT');
        assert.match(sql, /NOT EXISTS\s*\(\s*SELECT 1\s+FROM execution_intents AS blocking_sell/su);
        assert.match(sql, /blocking_sell\.side\s*=\s*'SELL'/u);
        assert.match(
          sql,
          /blocking_sell\.status IN \('PENDING', 'RETRY_READY', 'PROCESSING'\)[\s\S]*?blocking_sell\.expires_at\s*>\s*statement_timestamp\(\)/u,
        );
        assert.match(sql, /blocking_sell\.status\s*=\s*'SIGNED_NOT_SUBMITTED'/u);
        const blockingPredicate = required(
          /NOT EXISTS\s*\(([\s\S]*?)\)\s*AND\s*\(intent\.lease_expires_at/u.exec(sql)?.[1],
        );
        assert.doesNotMatch(blockingPredicate, /blocking_sell\.lease_expires_at/u);
      } else {
        assert.doesNotMatch(sql, /blocking_sell/u);
      }
    }
  }
});

void test('live claim options are closed and rejected before connecting', async () => {
  const invalid: readonly unknown[] = [
    { ownerId: 'worker', leaseMs: 30_000, purpose: 'LIVE_EXECUTE' },
    { ownerId: 'worker', leaseMs: 30_000, purpose: 'LIVE_EXECUTE', side: 'OTHER' },
    { ownerId: 'worker', leaseMs: 30_000, purpose: 'LIVE_EXECUTE', side: 'BUY' },
    { ownerId: 'worker', leaseMs: 30_000, purpose: 'LIVE_EXECUTE', side: 'BUY', generationId: 'other' },
    {
      ownerId: 'worker', leaseMs: 30_000, purpose: 'LIVE_EXECUTE', side: 'SELL',
      generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    },
    { ownerId: 'worker', leaseMs: 30_000, purpose: 'LIVE_RECOVER', side: 'OTHER' },
    { ownerId: 'worker', leaseMs: 30_000, purpose: 'EXECUTE', side: 'BUY' },
  ];
  for (const options of invalid) {
    const pool = new ScriptedPool(new ScriptedClient([]));
    const repository = new PostgresExecutionIntentRepository(pool);
    await expectCode(repository.claim(options as never), 'INVALID_INPUT');
    assert.equal(pool.connectCount, 0);
  }
});

void test('DRY_RUN rejects equality at the lease-expiry boundary and hostile claim rows evict the client', async () => {
  const draft = executionDraft('dry-run-boundary');
  const equalityClient = new ScriptedClient([(_text, values) => result([{
    ...claimRow(draft, 'PENDING'), lease_owner: values?.[0], lease_token: values?.[2],
    lease_expires_at_ms: String(NOW_MS + 30_000), expires_at_ms: String(NOW_MS + 30_000),
    claim_at_ms: String(NOW_MS),
  }], 1)]);
  const equalityRepository = new PostgresExecutionIntentRepository(new ScriptedPool(equalityClient));
  await expectCode(equalityRepository.claim({
    ownerId: 'worker-1', leaseMs: 30_000, purpose: 'DRY_RUN',
  }), 'INVALID_DATA');
  assert.deepEqual(equalityClient.releaseErrors, [true]);

  const cleanupFailureClient = new ScriptedClient([(_text, values) => result([{
    ...claimRow(draft, 'PENDING'), lease_owner: values?.[0], lease_token: values?.[2],
    lease_expires_at_ms: String(NOW_MS + 30_000), expires_at_ms: String(NOW_MS + 30_000),
    claim_at_ms: String(NOW_MS),
  }], 1)], () => { throw new Error('release cleanup secret'); });
  await expectCode(new PostgresExecutionIntentRepository(new ScriptedPool(cleanupFailureClient)).claim({
    ownerId: 'worker-1', leaseMs: 30_000, purpose: 'DRY_RUN',
  }), 'DATABASE_FAILURE');
  assert.deepEqual(cleanupFailureClient.releaseErrors, [true]);

  const validClient = new ScriptedClient([(_text, values) => result([{
    ...claimRow(draft, 'RETRY_READY'), lease_owner: values?.[0], lease_token: values?.[2],
    lease_expires_at_ms: String(NOW_MS + 30_000), expires_at_ms: String(NOW_MS + 30_001),
    claim_at_ms: String(NOW_MS),
  }], 1)]);
  const validRepository = new PostgresExecutionIntentRepository(new ScriptedPool(validClient));
  const valid = await validRepository.claim({
    ownerId: 'worker-1', leaseMs: 30_000, purpose: 'DRY_RUN',
  });
  assert.ok(valid);
  assert.deepEqual(validClient.releaseErrors, [undefined]);
});

void test('DRY_RUN query failures evict the client without exposing database details', async () => {
  const client = new ScriptedClient([() => { throw new Error('postgres secret query'); }]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.claim({
    ownerId: 'worker-1', leaseMs: 30_000, purpose: 'DRY_RUN',
  }), 'DATABASE_FAILURE');
  assert.deepEqual(client.releaseErrors, [true]);
});

void test('claim cancellation fences connect without dispatching SQL and preserves cleanup failures', async (context) => {
  await context.test('pre-aborted signal does not connect', async () => {
    const controller = new AbortController();
    controller.abort();
    const pool = new ScriptedPool(new ScriptedClient([]));
    const repository = new PostgresExecutionIntentRepository(pool);

    await expectCode(repository.claim({
      ownerId: 'worker-1', leaseMs: 30_000, purpose: 'DRY_RUN',
    }, controller.signal), 'OPERATION_ABORTED');
    assert.equal(pool.connectCount, 0);
  });

  await context.test('abort while connect waits releases cleanly without a query', async () => {
    const controller = new AbortController();
    const connectGate = deferred<ScriptedClient>();
    let connectCount = 0;
    const pool: ExecutionIntentPool = {
      connect: async () => {
        connectCount += 1;
        return connectGate.promise;
      },
    };
    const client = new ScriptedClient([]);
    const repository = new PostgresExecutionIntentRepository(pool);
    const pending = repository.claim({
      ownerId: 'worker-1', leaseMs: 30_000, purpose: 'DRY_RUN',
    }, controller.signal);

    await Promise.resolve();
    assert.equal(connectCount, 1);
    controller.abort();
    connectGate.resolve(client);

    await expectCode(pending, 'OPERATION_ABORTED');
    assert.equal(client.calls.length, 0);
    assert.deepEqual(client.releaseErrors, [undefined]);
  });

  for (const purpose of ['LIVE_EXECUTE', 'LIVE_RECOVER'] as const) {
    await context.test(`${purpose} BUY aborts after its advisory wait without dispatching claim SQL`,
      async () => {
      const controller = new AbortController();
      const lockStarted = deferred<true>();
      const lockGate = deferred<QueryResult>();
      const calls: string[] = [];
      const releaseErrors: (boolean | undefined)[] = [];
      const repository = new PostgresExecutionIntentRepository({
        connect: async () => ({
          query: async (text: string) => {
            calls.push(text);
            if (text === 'BEGIN ISOLATION LEVEL READ COMMITTED' || text === 'ROLLBACK') {
              return result([], null);
            }
            if (text.includes('execution-live-sell-presence:v1')) {
              lockStarted.resolve(true);
              return lockGate.promise;
            }
            assert.fail(`Claim SQL was dispatched after cancellation: ${text}`);
          },
          release: (error?: boolean) => { releaseErrors.push(error); },
        }),
      });
      const pending = repository.claim(purpose === 'LIVE_EXECUTE'
        ? {
          ownerId: 'live-buy-cancelled-after-lock-wait', leaseMs: 30_000,
          purpose, side: 'BUY', generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
        }
        : {
          ownerId: 'live-buy-cancelled-after-lock-wait', leaseMs: 30_000,
          purpose, side: 'BUY',
        }, controller.signal);
      await lockStarted.promise;
      controller.abort();
      lockGate.resolve(result([], 1));

      await expectCode(pending, 'OPERATION_ABORTED');
      assert.deepEqual(calls, [
        'BEGIN ISOLATION LEVEL READ COMMITTED',
        calls[1],
        'ROLLBACK',
      ]);
      assert.match(calls[1] ?? '', /execution-live-sell-presence:v1/u);
      assert.deepEqual(releaseErrors, [false]);
      });
  }

  await context.test('connect and abort-cleanup failures remain database failures', async () => {
    const connectController = new AbortController();
    const connectGate = deferred<ScriptedClient>();
    const connectFailure = new PostgresExecutionIntentRepository({
      connect: async () => connectGate.promise,
    });
    const connecting = connectFailure.claim({
      ownerId: 'worker-1', leaseMs: 30_000, purpose: 'DRY_RUN',
    }, connectController.signal);
    await Promise.resolve();
    connectController.abort();
    connectGate.reject(new Error('connect secret'));
    await expectCode(connecting, 'DATABASE_FAILURE');

    const cleanupController = new AbortController();
    const cleanupGate = deferred<ScriptedClient>();
    const cleanupClient = new ScriptedClient([], () => { throw new Error('release secret'); });
    const cleanupFailure = new PostgresExecutionIntentRepository({
      connect: async () => cleanupGate.promise,
    });
    const cleaning = cleanupFailure.claim({
      ownerId: 'worker-1', leaseMs: 30_000, purpose: 'DRY_RUN',
    }, cleanupController.signal);
    await Promise.resolve();
    cleanupController.abort();
    cleanupGate.resolve(cleanupClient);
    await expectCode(cleaning, 'DATABASE_FAILURE');
    assert.equal(cleanupClient.calls.length, 0);
    assert.deepEqual(cleanupClient.releaseErrors, [undefined, true]);
  });
});

void test('claim keeps dispatched-query semantics when cancellation races SQL', async (context) => {
  const draft = executionDraft('claim-cancel-dispatched');

  await context.test('query failure remains a database failure', async () => {
    const controller = new AbortController();
    const client = new ScriptedClient([() => {
      controller.abort();
      throw new Error('query secret');
    }]);
    const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

    await expectCode(repository.claim({
      ownerId: 'worker-1', leaseMs: 30_000, purpose: 'DRY_RUN',
    }, controller.signal), 'DATABASE_FAILURE');
    assert.deepEqual(client.releaseErrors, [true]);
  });

  await context.test('successful dispatched query returns its claim', async () => {
    const controller = new AbortController();
    const client = new ScriptedClient([(_text, values) => {
      controller.abort();
      return result([{
        ...claimRow(draft, 'PENDING'),
        lease_owner: values?.[0], lease_token: values?.[2],
        claim_at_ms: String(NOW_MS),
      }], 1);
    }]);
    const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

    const claimed = await repository.claim({
      ownerId: 'worker-1', leaseMs: 30_000, purpose: 'DRY_RUN',
    }, controller.signal);
    assert.ok(claimed);
    assert.equal(claimed.intent.id, draft.id);
    assert.deepEqual(client.releaseErrors, [undefined]);
  });
});

void test('claim SQL admits a modeled lease exactly equal to statement_timestamp', async () => {
  const draft = executionDraft('claim-equality-boundary');
  const client = new ScriptedClient([(text, values) => {
    const admitsExactEquality = /\(intent\.lease_expires_at IS NULL\s+OR\s+intent\.lease_expires_at <= statement_timestamp\(\)\)/su
      .test(text);
    if (!admitsExactEquality) return result([], 0);
    return result([{
      ...claimRow(draft, 'PENDING'),
      lease_owner: values?.[0],
      lease_token: values?.[2],
      claim_at_ms: String(NOW_MS),
    }], 1);
  }]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  const claim = await repository.claim({
    ownerId: 'boundary-worker', leaseMs: 30_000, purpose: 'EXECUTE',
  });

  assert.ok(claim);
  assert.equal(claim.intent.id, draft.id);
  const capturedClaim = required(client.calls[0]);
  assert.match(capturedClaim.text, /lease_expires_at <= statement_timestamp\(\)/u);
  assert.doesNotMatch(capturedClaim.text, /execution_intent_transitions/u);
});

void test('renew and release fence on id, status, UUID token, and strict database lease freshness', async () => {
  const draft = executionDraft('lease');
  const claim = claimedIntent(draft, 'PROCESSING');
  const client = new ScriptedClient([
    command('BEGIN'), result([], 0), command('ROLLBACK'),
    command('BEGIN'), result([], 0), command('ROLLBACK'),
    command('BEGIN'), result([claimRow(draft, 'PROCESSING')], 1), result([
      {
        ...claimRow(draft, 'PROCESSING'),
        updated_at_ms: String(NOW_MS + 30_000),
        lease_expires_at_ms: String(NOW_MS + 35_000),
      },
    ], 1), command('COMMIT'),
    command('BEGIN'), result([claimRow(draft, 'PROCESSING')], 1), result([], 1), command('COMMIT'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.renew(claim, 5_000), 'INTENT_LEASE_LOST');
  await expectCode(repository.release(claim), 'INTENT_LEASE_LOST');
  assert.deepEqual(await repository.renew(claim, 5_000), Object.freeze({
    ...claim,
    intent: Object.freeze({ ...claim.intent, updatedAtMs: NOW_MS + 30_000 }),
    leaseExpiresAtMs: NOW_MS + 35_000,
  }));
  assert.equal(await repository.release(claim), true);

  for (const call of client.calls.filter((candidate) => /^(?:\s*SELECT|\s*WITH)/u.test(candidate.text))) {
    assert.match(call.text, /id\s*=\s*\$1/u);
    assert.match(call.text, /status\s*=\s*\$2/u);
    assert.match(call.text, /lease_token\s*=\s*\$3::UUID/u);
    assert.match(call.text, /lease_expires_at\s*>\s*statement_timestamp\(\)/u);
    assert.deepEqual(call.values?.slice(0, 3), [draft.id, 'PROCESSING', UUID]);
  }
  assert.match(required(client.calls[8]).text, /statement_timestamp\(\)\s*\+\s*\(\$5::BIGINT/u);
  assert.match(required(client.calls[12]).text, /lease_owner\s*=\s*NULL/u);
});

void test('renew remains available for expired CONFIRM and RECONCILE claims without an intent expiry fence', async () => {
  const cases: readonly [ExecutionIntentStatus, string][] = [
    ['SUBMITTED', 'CONFIRM'],
    ['UNKNOWN_REQUIRES_RECONCILIATION', 'RECONCILE'],
  ];
  for (const [status, purpose] of cases) {
    const draft = executionDraft(`renew-${purpose.toLowerCase()}`, { expiresAtMs: NOW_MS - 1 });
    const claim = claimedIntent(draft, status);
    const client = new ScriptedClient([
      command('BEGIN'), result([claimRow(draft, status)], 1), result([
        {
          ...claimRow(draft, status),
          updated_at_ms: String(NOW_MS + 30_000),
          lease_expires_at_ms: String(NOW_MS + 35_000),
        },
      ], 1), command('COMMIT'),
    ]);
    const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

    const renewed = await repository.renew(claim, 5_000);
    assert.equal(renewed.leaseExpiresAtMs, NOW_MS + 35_000);
    assert.equal(renewed.intent.status, status);
    const renew = required(client.calls.find((call) => call.text.includes('SET lease_expires_at')));
    assert.doesNotMatch(renew.text.split('RETURNING')[0] ?? '', /intent\.expires_at/u);
    assert.match(renew.text, /lease_expires_at\s*>\s*statement_timestamp\(\)/u);
  }
});

void test('renew rejects a contradictory RETURNING claim instead of issuing an unfenced lease', async () => {
  const draft = executionDraft('renew-returning');
  const claim = claimedIntent(draft, 'PROCESSING');
  for (const overrides of [
    { lease_owner: 'different-worker' },
    { lease_token: '00000000-0000-4000-8000-000000000002' },
    { status: 'SIMULATED', last_reason_code: 'SIMULATION_SUCCEEDED' },
    { attempt_count: 2 },
    { state_revision: '1' },
    { minimum_amount_out_raw: '2' },
    { lease_expires_at_ms: String(NOW_MS + 29_999) },
    { lease_expires_at_ms: String(NOW_MS + 35_001) },
  ]) {
    const client = new ScriptedClient([
      command('BEGIN'), result([claimRow(draft, 'PROCESSING')], 1), result([{
        ...claimRow(draft, 'PROCESSING'),
        lease_expires_at_ms: String(NOW_MS + 35_000),
        ...overrides,
      }], 1), command('ROLLBACK'),
    ]);
    const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

    await expectCode(repository.renew(claim, 5_000), 'INVALID_DATA');
    assert.deepEqual(client.releaseErrors, [false]);
  }
});

void test('claim rejects a well-shaped row that contradicts the requested lease identity', async () => {
  const draft = executionDraft('claim-contradiction');
  const client = new ScriptedClient([result([{
    ...claimRow(draft, 'PENDING'),
    lease_owner: 'different-worker',
    lease_token: '00000000-0000-4000-8000-000000000002',
    claim_at_ms: String(NOW_MS),
  }], 1)]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.claim({
    ownerId: 'expected-worker', leaseMs: 30_000, purpose: 'EXECUTE',
  }), 'INVALID_DATA');
});

void test('DRY_RUN rejects returned statuses and lease identities outside its exact claim', async () => {
  const draft = executionDraft('dry-run-contradiction');
  const rows: readonly Readonly<Record<string, unknown>>[] = [
    { status: 'PROCESSING' },
    { lease_owner: 'different-worker' },
    { lease_token: '00000000-0000-4000-8000-000000000002' },
    { lease_expires_at_ms: String(NOW_MS + 30_001) },
  ];
  for (const overrides of rows) {
    const client = new ScriptedClient([(_text, values) => result([{
      ...claimRow(draft, 'PENDING'), lease_owner: values?.[0], lease_token: values?.[2],
      claim_at_ms: String(NOW_MS), ...overrides,
    }], 1)]);
    const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

    await expectCode(repository.claim({
      ownerId: 'expected-worker', leaseMs: 30_000, purpose: 'DRY_RUN',
    }), 'INVALID_DATA');
    assert.deepEqual(client.releaseErrors, [true]);
  }
});

void test('claim rejects a RETRY_READY parent without durable no-effect proof', async () => {
  const draft = executionDraft('claim-unsafe-retry-parent');
  const client = new ScriptedClient([(_text, values) => result([{
    ...claimRow(draft, 'RETRY_READY', 0),
    last_reason_code: 'RETRY_AUTHORIZED',
    lease_token: values?.[2], claim_at_ms: String(NOW_MS),
  }], 1)]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.claim({
    ownerId: 'worker-1', leaseMs: 30_000, purpose: 'EXECUTE',
  }), 'INVALID_DATA');
});

void test('claim validates its database claim instant and EXECUTE expiry postconditions', async () => {
  const draft = executionDraft('claim-postconditions');
  const malformedRows = [
    { claim_at_ms: String(NOW_MS + 1) },
    { expires_at_ms: String(NOW_MS) },
  ];
  for (const override of malformedRows) {
    const client = new ScriptedClient([(_text, values) => result([{
      ...claimRow(draft, 'PENDING'), lease_token: values?.[2], claim_at_ms: String(NOW_MS),
      ...override,
    }], 1)]);
    const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));
    await expectCode(repository.claim({
      ownerId: 'worker-1', leaseMs: 30_000, purpose: 'EXECUTE',
    }), 'INVALID_DATA');
  }
});

void test('transition locks and fences the parent, appends evidence, then updates atomically', async () => {
  const draft = executionDraft('transition');
  const claim = claimedIntent(draft, 'PENDING');
  const updated = claimRow(draft, 'PROCESSING', 0);
  Object.assign(updated, {
    status: 'PROCESSING', last_reason_code: 'EXECUTION_STARTED',
    state_revision: '1',
    updated_at_ms: String(NOW_MS + 1),
  });
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PENDING')], 1),
    result([ledgerRow(0)], 1), result([], 1),
    result([updated], 1), command('COMMIT'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));
  const input = transitionInput(claim, 'PROCESSING');

  const transitioned = await repository.transition(claim, input);

  assert.equal(transitioned.status, 'PROCESSING');
  assert.equal(transitioned.stateRevision, 1n);
  assert.equal(Object.isFrozen(transitioned), true);
  assert.deepEqual(client.calls.map((call) => normalizedCommand(call.text)), [
    'BEGIN', 'SELECT', 'UPDATE', 'INSERT', 'UPDATE', 'COMMIT',
  ]);
  const locked = required(client.calls[1]);
  assert.match(locked.text, /FOR UPDATE/u);
  assert.match(locked.text, /status\s*=\s*\$2/u);
  assert.match(locked.text, /lease_token\s*=\s*\$3::UUID/u);
  assert.match(locked.text, /lease_expires_at\s*>\s*statement_timestamp\(\)/u);
  const journal = required(client.calls[3]);
  assert.match(journal.text, /INSERT INTO execution_intent_transitions/u);
  assert.equal(journal.values?.includes('claimed for processing'), true);
  assert.equal(journal.values?.includes('NONE'), true);
  assert.match(String(journal.values?.find((value) => typeof value === 'string' && value.startsWith('{'))), /"payloadVersion":1/u);
  const parentUpdate = required(client.calls[4]);
  assert.doesNotMatch(parentUpdate.text, /lease_owner\s*=\s*NULL/u);
  assert.match(parentUpdate.text, /state_revision\s*=\s*intent\.state_revision \+ 1/u);
  assert.match(parentUpdate.text, /intent\.state_revision\s*=\s*\$5::BIGINT/u);
});

void test('state revision prevents same-millisecond ABA replay with the original claim', async () => {
  const draft = executionDraft('state-revision-aba');
  const original = claimedIntent(draft, 'UNKNOWN_REQUIRES_RECONCILIATION', 0, 0n);
  const confirmed = claimedIntent(draft, 'CONFIRMED', 0, 1n);
  const confirmedRow = claimRow(draft, 'CONFIRMED', 0);
  Object.assign(confirmedRow, { state_revision: '1', last_reason_code: 'CONFIRMATION_OBSERVED' });
  const unknownRow = claimRow(draft, 'UNKNOWN_REQUIRES_RECONCILIATION', 0);
  Object.assign(unknownRow, { state_revision: '2', last_reason_code: 'RECONCILIATION_REQUIRED' });
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, original.intent.status, 0)], 1),
    result([ledgerRow(0)], 1), result([], 1),
    result([confirmedRow], 1), command('COMMIT'),
    command('BEGIN'), result([{
      ...claimRow(draft, confirmed.intent.status, 0), state_revision: '1',
    }], 1), result([ledgerRow(0)], 1), result([], 1), result([unknownRow], 1), command('COMMIT'),
    command('BEGIN'), result([], 0), command('ROLLBACK'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  const first = await repository.transition(original, transitionInput(original, 'CONFIRMED'));
  const second = await repository.transition(confirmed, transitionInput(
    confirmed, 'UNKNOWN_REQUIRES_RECONCILIATION',
  ));
  await expectCode(
    repository.transition(original, transitionInput(original, 'CONFIRMED')),
    'INTENT_LEASE_LOST',
  );

  assert.equal(first.updatedAtMs, second.updatedAtMs);
  assert.equal(first.stateRevision, 1n);
  assert.equal(second.stateRevision, 2n);
  assert.equal(client.calls.filter((call) => call.text.includes('execution_intent_transitions')).length, 2);
});

void test('nonterminal transition fail-closes every mismatched retained lease triplet', async () => {
  const draft = executionDraft('transition-lease-returning');
  const claim = claimedIntent(draft, 'PENDING');
  const variants = [
    { lease_owner: null, lease_token: null, lease_expires_at_ms: null },
    { lease_owner: 'different-worker' },
    { lease_token: '00000000-0000-4000-8000-000000000002' },
    { lease_expires_at_ms: String(NOW_MS + 30_001) },
  ] as const;

  for (const leaseOverride of variants) {
    const returned = claimRow(draft, 'PROCESSING', 0);
    Object.assign(returned, {
      last_reason_code: 'EXECUTION_STARTED', updated_at_ms: String(NOW_MS + 1),
      ...leaseOverride,
    });
    const client = new ScriptedClient([
      command('BEGIN'), result([claimRow(draft, 'PENDING', 0)], 1),
      result([ledgerRow(0)], 1), result([], 1),
      result([returned], 1), (text) => {
        assert.match(text, /^(?:COMMIT|ROLLBACK)$/u);
        return result([], null);
      },
    ]);
    const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

    await expectCode(
      repository.transition(claim, transitionInput(claim, 'PROCESSING')),
      'INVALID_DATA',
    );
  }
});

void test('transition rolls back both journal and parent update when fencing is lost', async () => {
  const draft = executionDraft('transition-lost');
  const claim = claimedIntent(draft, 'PENDING');
  const client = new ScriptedClient([
    command('BEGIN'), result([], 0), command('ROLLBACK'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.transition(claim, transitionInput(claim, 'PROCESSING')), 'INTENT_LEASE_LOST');
  assert.equal(client.released, true);
  assert.deepEqual(client.calls.map((call) => normalizedCommand(call.text)), ['BEGIN', 'SELECT', 'ROLLBACK']);
});

void test('fenced transactions reject a contradictory locked parent identity', async () => {
  const draft = executionDraft('locked-parent');
  const other = executionDraft('locked-parent-other');
  const claim = claimedIntent(draft, 'PENDING');
  const client = new ScriptedClient([
    command('BEGIN'), result([{
      ...claimRow(other, 'PENDING'), lease_owner: claim.leaseOwner,
      lease_token: claim.leaseToken,
    }], 1), command('ROLLBACK'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.transition(claim, transitionInput(claim, 'PROCESSING')), 'INVALID_DATA');
});

void test('terminal pre-signature transitions release the lease and schedule coherent retention', async () => {
  const draft = executionDraft('terminal');
  const claim = claimedIntent(draft, 'SIMULATED', 1);
  const terminal = intentRow(draft, {
    status: 'SUCCEEDED', attempt_count: 1, last_reason_code: 'INTENT_SUCCEEDED',
    state_revision: '1',
    terminal_at_ms: String(NOW_MS + 1), reconciliation_completed_at_ms: String(NOW_MS + 1),
    purge_after_ms: String(NOW_MS + 14_400_001), updated_at_ms: String(NOW_MS + 1),
  });
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'SIMULATED', 1)], 1),
    result([ledgerRow(1, 'COMPLETED')], 1), result([], 1),
    result([terminal], 1), command('COMMIT'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  const transitioned = await repository.transition(claim, transitionInput(claim, 'SUCCEEDED', 1));

  assert.equal(transitioned.reconciliationCompletedAtMs, transitioned.terminalAtMs);
  assert.equal(required(transitioned.purgeAfterMs) - required(transitioned.terminalAtMs), 14_400_000);
  const update = required(client.calls[4]);
  assert.match(update.text, /lease_owner\s*=\s*NULL/u);
  assert.match(update.text, /reconciliation_completed_at\s*=\s*CASE[\s\S]*operation\.at/u);
  assert.match(update.text, /purge_after\s*=\s*CASE[\s\S]*operation\.at\s*\+\s*INTERVAL '4 hours'/u);
});

void test('terminal reconciled transitions mark reconciliation complete and become purgeable', async () => {
  const draft = executionDraft('terminal-reconciled');
  const claim = claimedIntent(draft, 'RECONCILING', 1);
  const terminal = intentRow(draft, {
    status: 'SUCCEEDED', attempt_count: 1, last_reason_code: 'INTENT_SUCCEEDED',
    state_revision: '1',
    terminal_at_ms: String(NOW_MS + 1), reconciliation_completed_at_ms: String(NOW_MS + 1),
    purge_after_ms: String(NOW_MS + 14_400_001), updated_at_ms: String(NOW_MS + 1),
  });
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'RECONCILING', 1)], 1),
    result([ledgerRow(1, 'COMPLETED')], 1), result([], 1),
    result([terminal], 1), command('COMMIT'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  const transitioned = await repository.transition(claim, transitionInput(claim, 'SUCCEEDED', 1));

  assert.equal(transitioned.reconciliationCompletedAtMs, transitioned.terminalAtMs);
  assert.equal(required(client.calls[4]).values?.[6], true);
});

void test('terminal transitions reject RETURNING rows without required reconciliation retention', async () => {
  const draft = executionDraft('terminal-retention-missing');
  const claim = claimedIntent(draft, 'SIMULATED', 1);
  const terminal = intentRow(draft, {
    status: 'SUCCEEDED', attempt_count: 1, last_reason_code: 'INTENT_SUCCEEDED',
    terminal_at_ms: String(NOW_MS + 1), updated_at_ms: String(NOW_MS + 1),
  });
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'SIMULATED', 1)], 1),
    result([ledgerRow(1, 'COMPLETED')], 1), result([], 1),
    result([terminal], 1), (text) => {
      assert.match(text, /^(?:COMMIT|ROLLBACK)$/u);
      return result([], null);
    },
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(
    repository.transition(claim, transitionInput(claim, 'SUCCEEDED', 1)),
    'INVALID_DATA',
  );
});

void test('transition rejects a contradictory UPDATE RETURNING status', async () => {
  const draft = executionDraft('transition-returning');
  const claim = claimedIntent(draft, 'PENDING');
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PENDING')], 1),
    result([ledgerRow(0)], 1), result([], 1),
    result([intentRow(draft, {
      status: 'SIMULATED', updated_at_ms: String(NOW_MS + 1),
    })], 1), command('ROLLBACK'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.transition(claim, transitionInput(claim, 'PROCESSING')), 'INVALID_DATA');
});

void test('beginAttempt increments the locked processing parent and creates one STARTED row', async () => {
  const draft = executionDraft('begin-attempt');
  const claim = claimedIntent(draft, 'PROCESSING', 0);
  const refreshed = {
    ...claimRow(draft, 'PROCESSING', 1), updated_at_ms: String(NOW_MS + 3),
  };
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', 0)], 1),
    result([ledgerRow(0)], 1),
    result([{ started_at_ms: String(NOW_MS + 2) }], 1), result([refreshed], 1), command('COMMIT'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  const attempt = await repository.beginAttempt(claim);

  assert.deepEqual(attempt, {
    claim: Object.freeze({
      intent: Object.freeze({
        ...claim.intent,
        attemptCount: 1,
        updatedAtMs: NOW_MS + 3,
      }),
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
      leaseExpiresAtMs: claim.leaseExpiresAtMs,
    }),
    attempt: Object.freeze({ intentId: draft.id, attemptNumber: 1, startedAtMs: NOW_MS + 2 }),
  });
  assert.ok(Object.isFrozen(attempt));
  assert.match(required(client.calls[2]).text, /status\s*=\s*'STARTED'/u);
  assert.match(required(client.calls[2]).text, /FOR UPDATE/u);
  assert.match(required(client.calls[3]).text, /INSERT INTO execution_attempts/u);
  assert.match(required(client.calls[3]).text, /'STARTED'/u);
  assert.match(required(client.calls[3]).text, /lease_expires_at\s*>\s*statement_timestamp\(\)/u);
  assert.match(required(client.calls[4]).text, /attempt_count\s*=\s*\$5/u);
  assert.match(required(client.calls[4]).text, /lease_expires_at\s*>\s*statement_timestamp\(\)/u);
});

void test('beginAttempt replays the current STARTED attempt after an ambiguous commit', async () => {
  const draft = executionDraft('attempt-replay');
  const claim = claimedIntent(draft, 'PROCESSING', 1);
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', 1)], 1),
    result([ledgerRow(1, 'STARTED', { latest_started_at_ms: String(NOW_MS + 2) })], 1),
    (text) => {
      assert.match(text, /^(?:COMMIT|ROLLBACK)$/u);
      return result([], null);
    },
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  assert.deepEqual(await repository.beginAttempt(claim), {
    claim,
    attempt: { intentId: draft.id, attemptNumber: 1, startedAtMs: NOW_MS + 2 },
  });
  const replayQuery = required(client.calls[2]);
  assert.match(replayQuery.text, /intent\.id\s*=\s*attempt\.intent_id/u);
  assert.match(replayQuery.text, /intent\.status\s*=\s*\$2/u);
  assert.match(replayQuery.text, /intent\.lease_token\s*=\s*\$3::UUID/u);
  assert.match(replayQuery.text, /intent\.lease_expires_at\s*>\s*statement_timestamp\(\)/u);
  assert.deepEqual(replayQuery.values, [draft.id, 'PROCESSING', UUID, '0']);
  assert.equal(client.calls.some((call) => call.text.includes('INSERT INTO execution_attempts')), false);
});

void test('beginAttempt rejects every contradictory refreshed fenced claim', async () => {
  const draft = executionDraft('attempt-refreshed-claim');
  const claim = claimedIntent(draft, 'PROCESSING', 0);
  for (const overrides of [
    { attempt_count: 0 },
    { state_revision: '1' },
    { minimum_amount_out_raw: '2' },
    { lease_owner: 'other-worker' },
    { lease_token: '00000000-0000-4000-8000-000000000002' },
    { lease_expires_at_ms: String(NOW_MS + 30_001) },
    { updated_at_ms: String(NOW_MS - 1) },
  ]) {
    const client = new ScriptedClient([
      command('BEGIN'), result([claimRow(draft, 'PROCESSING', 0)], 1), result([ledgerRow(0)], 1),
      result([{ started_at_ms: String(NOW_MS + 2) }], 1), result([{
        ...claimRow(draft, 'PROCESSING', 1), ...overrides,
      }], 1), command('ROLLBACK'),
    ]);

    await expectCode(
      new PostgresExecutionIntentRepository(new ScriptedPool(client)).beginAttempt(claim),
      'INVALID_DATA',
    );
  }
});

void test('beginAttempt rejects int32 overflow without inserting an attempt', async () => {
  const draft = executionDraft('attempt-overflow');
  const claim = claimedIntent(draft, 'PROCESSING', INT32_MAX);
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', INT32_MAX)], 1),
    result([ledgerRow(INT32_MAX, 'COMPLETED')], 1), command('ROLLBACK'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.beginAttempt(claim), 'ATTEMPT_EXHAUSTED');
  assert.deepEqual(client.calls.map((call) => normalizedCommand(call.text)), [
    'BEGIN', 'SELECT', 'UPDATE', 'ROLLBACK',
  ]);
});

void test('beginAttempt validates the fresh fence before exhaustion and rejects ledger gaps', async () => {
  const draft = executionDraft('attempt-fence-before-overflow');
  const exhausted = claimedIntent(draft, 'PROCESSING', INT32_MAX);
  const stale = new ScriptedClient([command('BEGIN'), result([], 0), command('ROLLBACK')]);
  await expectCode(
    new PostgresExecutionIntentRepository(new ScriptedPool(stale)).beginAttempt(exhausted),
    'INTENT_LEASE_LOST',
  );

  const claim = claimedIntent(draft, 'PROCESSING', 1);
  const gap = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', 1)], 1),
    result([ledgerRow(0)], 1), command('ROLLBACK'),
  ]);
  await expectCode(
    new PostgresExecutionIntentRepository(new ScriptedPool(gap)).beginAttempt(claim),
    'ATTEMPT_CONFLICT',
  );
});

void test('PROCESSING cannot transition while its latest attempt is STARTED', async () => {
  const draft = executionDraft('transition-active-attempt');
  const claim = claimedIntent(draft, 'PROCESSING', 1);
  const returned = claimRow(draft, 'SIMULATED', 1);
  Object.assign(returned, {
    state_revision: '1', last_reason_code: 'SIMULATION_SUCCEEDED', updated_at_ms: String(NOW_MS + 1),
  });
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', 1)], 1),
    result([ledgerRow(1, 'STARTED')], 1), command('ROLLBACK'),
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', 1)], 1),
    result([ledgerRow(1, 'COMPLETED')], 1), result([], 1), result([returned], 1), command('COMMIT'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(
    repository.transition(claim, transitionInput(claim, 'SIMULATED', 1)),
    'ATTEMPT_CONFLICT',
  );
  assert.equal((await repository.transition(
    claim, transitionInput(claim, 'SIMULATED', 1),
  )).status, 'SIMULATED');
  assert.equal(client.calls.filter((call) => call.text.includes('execution_intent_transitions')).length, 1);
});

void test('transition rejects an orphan STARTED child when the parent attempt count is zero', async () => {
  const draft = executionDraft('transition-orphan-attempt');
  const claim = claimedIntent(draft, 'PROCESSING', 0);
  const returned = claimRow(draft, 'SIMULATED', 0);
  Object.assign(returned, {
    state_revision: '1', last_reason_code: 'SIMULATION_SUCCEEDED', updated_at_ms: String(NOW_MS + 1),
  });
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', 0)], 1),
    result([ledgerRow(1, 'STARTED')], 1),
    (text) => text === 'ROLLBACK' ? result([], null) : result([returned], 1),
    command('COMMIT'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(
    repository.transition(claim, transitionInput(claim, 'SIMULATED')),
    'ATTEMPT_CONFLICT',
  );
  assert.equal(client.calls.some((call) => call.text.includes('execution_intent_transitions')), false);
});

void test('finishAttempt performs one fenced STARTED CAS and exact replay returns false', async () => {
  const draft = executionDraft('finish-attempt');
  const claim = claimedIntent(draft, 'PROCESSING', 1);
  const finish = {
    attemptNumber: 1, status: 'COMPLETED' as const, effectiveVenue: 'PUMP_FUN' as const,
    providerId: 'provider-1', reasonCode: 'ATTEMPT_COMPLETED' as const,
  };
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', 1)], 1),
    result([ledgerRow(1, 'STARTED')], 1),
    result([{ intent_id: draft.id }], 1), command('COMMIT'),
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', 1)], 1),
    result([ledgerRow(1, 'COMPLETED', {
      latest_effective_venue: 'PUMP_FUN', latest_provider_id: 'provider-1',
      latest_completed_at_ms: String(NOW_MS + 3), latest_reason_code: 'ATTEMPT_COMPLETED',
    })], 1), command('COMMIT'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  assert.equal(await repository.finishAttempt(claim, finish), true);
  assert.equal(await repository.finishAttempt(claim, finish), false);

  const update = client.calls.find((call) => call.text.includes('UPDATE execution_attempts'));
  assert.ok(update);
  assert.match(update.text, /attempt\.status\s*=\s*'STARTED'/u);
  assert.match(update.text, /lease_expires_at\s*>\s*statement_timestamp\(\)/u);
  assert.doesNotMatch(update.text, /purge_after\s*=/u);
});

void test('finishAttempt refuses a divergent or malformed terminal replay', async () => {
  const draft = executionDraft('finish-conflict');
  const claim = claimedIntent(draft, 'PROCESSING', 1);
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', 1)], 1),
    result([ledgerRow(1, 'ABANDONED', {
      latest_completed_at_ms: String(NOW_MS + 4), latest_reason_code: 'QUOTE_STALE',
    })], 1), command('ROLLBACK'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.finishAttempt(claim, {
    attemptNumber: 1, status: 'COMPLETED', effectiveVenue: 'PUMP_FUN',
    providerId: 'provider', reasonCode: 'ATTEMPT_COMPLETED',
  }), 'ATTEMPT_CONFLICT');
});

void test('finishAttempt fail-closes a contradictory selected attempt number', async () => {
  const draft = executionDraft('finish-number');
  const claim = claimedIntent(draft, 'PROCESSING', 1);
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', 1)], 1),
    result([ledgerRow(1, 'STARTED', { latest_attempt_number: 2 })], 1), command('ROLLBACK'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.finishAttempt(claim, {
    attemptNumber: 1, status: 'COMPLETED', effectiveVenue: null,
    providerId: null, reasonCode: 'ATTEMPT_COMPLETED',
  }), 'ATTEMPT_CONFLICT');
});

void test('finishAttempt reports stale fencing instead of conflating it with exact replay', async () => {
  const draft = executionDraft('finish-stale');
  const claim = claimedIntent(draft, 'PROCESSING', 1);
  const finish = {
    attemptNumber: 1, status: 'ABANDONED' as const, effectiveVenue: null,
    providerId: null, reasonCode: 'INTENT_LEASE_LOST' as const,
  };
  const staleParent = new ScriptedClient([
    command('BEGIN'), result([], 0), (text) => {
      assert.match(text, /^(?:COMMIT|ROLLBACK)$/u);
      return result([], null);
    },
  ]);
  const staleCas = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', 1)], 1),
    result([ledgerRow(1, 'STARTED')], 1),
    result([], 0), (text) => {
      assert.match(text, /^(?:COMMIT|ROLLBACK)$/u);
      return result([], null);
    },
  ]);

  await expectCode(
    new PostgresExecutionIntentRepository(new ScriptedPool(staleParent)).finishAttempt(claim, finish),
    'INTENT_LEASE_LOST',
  );
  await expectCode(
    new PostgresExecutionIntentRepository(new ScriptedPool(staleCas)).finishAttempt(claim, finish),
    'INTENT_LEASE_LOST',
  );
});

void test('expirePreSubmission locks a bounded ordered batch and journals explicit pre-signature proof', async () => {
  const client = new ScriptedClient([
    command('BEGIN'), result([{ expired_count: 3 }], 1), command('COMMIT'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  assert.equal(await repository.expirePreSubmission(10), 3);

  const call = required(client.calls[1]);
  assert.match(call.text, /FOR UPDATE(?: OF intent)? SKIP LOCKED/u);
  assert.match(call.text, /expires_at\s*<=\s*statement_timestamp\(\)/u);
  assert.match(call.text, /lease_expires_at\s+IS NULL[\s\S]*<=\s*statement_timestamp\(\)/u);
  assert.match(call.text, /ORDER BY\s+intent\.requested_at,\s*intent\.id/u);
  assert.match(call.text, /LIMIT\s+\$1/u);
  for (const status of ['PENDING', 'RETRY_READY', 'PROCESSING', 'SIMULATED']) {
    assert.match(call.text, new RegExp(`'${status}'`, 'u'));
  }
  assert.match(call.text, /INSERT INTO execution_intent_transitions/u);
  assert.match(call.text, /UPDATE execution_attempts AS attempt[\s\S]*status='ABANDONED'/u);
  assert.match(call.text, /completed_at=operation\.at[\s\S]*reason_code='INTENT_EXPIRED'/u);
  assert.match(call.text, /'INTENT_EXPIRED'/u);
  assert.match(call.text, /'NONE'/u);
  assert.match(call.text, /jsonb_build_object\([\s\S]*'payloadVersion'[\s\S]*'observedAtMs'/u);
  assert.match(call.text, /terminal_at\s*=\s*operation\.at/u);
  assert.match(call.text, /reconciliation_completed_at\s*=\s*operation\.at/u);
  assert.match(call.text, /purge_after\s*=\s*operation\.at\s*\+\s*INTERVAL '4 hours'/u);
  assert.match(call.text, /lease_owner\s*=\s*NULL/u);
  assert.match(call.text, /state_revision=candidate\.state_revision \+ 1/u);
  assert.match(call.text, /intent\.state_revision < 9223372036854775807/u);
  assert.match(call.text, /COUNT\(\*\)[\s\S]*= intent\.attempt_count/u);
  assert.match(call.text, /MAX\(attempt\.attempt_number\)[\s\S]*= intent\.attempt_count/u);
  assert.doesNotMatch(call.text, /signed_transaction|keypair|signer capability/iu);
});

void test('read decodes exact canonical strings and rejects extra, fractional, or hostile row fields', async () => {
  const draft = executionDraft('decode');
  const extra = { ...intentRow(draft), extra: 'database-secret' };
  const fractional = { ...intentRow(draft), quote_amount_raw: '1.0' };
  const partialLease = { ...intentRow(draft), lease_owner: 'worker-without-token' };
  const contradictoryReason = intentRow(draft, {
    status: 'PROCESSING', last_reason_code: 'QUOTE_STALE',
  });
  const invalidRevisions = ['-1', '01', '9223372036854775808'].map((state_revision) => ({
    ...intentRow(draft), state_revision,
  }));
  const leasedTerminal = intentRow(draft, {
    status: 'SUCCEEDED', last_reason_code: 'INTENT_SUCCEEDED',
    terminal_at_ms: String(NOW_MS), lease_owner: 'worker-1', lease_token: UUID,
    lease_expires_at_ms: String(NOW_MS + 30_000),
  });
  let getterCalls = 0;
  const hostile = intentRow(draft) as Record<string, unknown>;
  Object.defineProperty(hostile, 'status', {
    enumerable: true,
    get: () => { getterCalls += 1; throw new Error('getter-secret'); },
  });
  const client = new ScriptedClient([
    result([extra], 1), result([fractional], 1), result([hostile], 1),
    result([partialLease], 1), result([leasedTerminal], 1), result([contradictoryReason], 1),
    ...invalidRevisions.map((row) => result([row], 1)), result([intentRow(draft)], 1),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.read(draft.id), 'INVALID_DATA');
  await expectCode(repository.read(draft.id), 'INVALID_DATA');
  await expectCode(repository.read(draft.id), 'INVALID_DATA');
  await expectCode(repository.read(draft.id), 'INVALID_DATA');
  await expectCode(repository.read(draft.id), 'INVALID_DATA');
  await expectCode(repository.read(draft.id), 'INVALID_DATA');
  for (const _revision of invalidRevisions) {
    await expectCode(repository.read(draft.id), 'INVALID_DATA');
  }
  assert.equal((await repository.read(draft.id))?.id, draft.id);
  const canonicalRead = required(client.calls.at(-1));
  assert.match(canonicalRead.text, /lease_owner[\s\S]*lease_token::TEXT[\s\S]*lease_expires_at_ms/u);
  assert.equal(getterCalls, 0);
});

void test('read rejects a canonical row whose decoded id differs from the requested id', async () => {
  const requested = executionDraft('read-requested');
  const returned = executionDraft('read-returned');
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(
    new ScriptedClient([result([intentRow(returned)], 1)]),
  ));

  await expectCode(repository.read(requested.id), 'INVALID_DATA');
});

void test('every fenced operation binds the complete immutable claim payload and state revision', async () => {
  const draft = executionDraft('immutable-fence');
  const claim = claimedIntent(draft, 'PROCESSING');
  const mutated = claimRow(draft, 'PROCESSING');
  mutated.minimum_amount_out_raw = '2';
  const client = new ScriptedClient([
    command('BEGIN'), result([mutated], 1), command('ROLLBACK'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.renew(claim, 5_000), 'INVALID_DATA');
  assert.equal(client.calls.some((call) => /state_revision\s*=\s*\$4::BIGINT/u.test(call.text)), true);
});

void test('transaction rollback and release failures are attempted, aggregated, and fully redacted', async () => {
  const secret = 'postgresql://user:password@secret-host/private';
  const client = new ScriptedClient([
    command('BEGIN'), () => { throw new Error(secret); },
    () => { throw new Error(`rollback ${secret}`); },
  ], () => { throw new Error(`release ${secret}`); });
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await assert.rejects(repository.create(executionDraft('cleanup')), (error: unknown) => {
    assert.ok(error instanceof ExecutionIntentRepositoryError);
    assert.equal(error.code, 'DATABASE_FAILURE');
    assert.equal(error.message, 'Execution intent repository operation failed.');
    assert.ok(error.cause instanceof AggregateError);
    assert.doesNotMatch(errorTree(error), /password|secret-host|private|postgresql:/iu);
    return true;
  });
  assert.equal(client.releaseAttempts, 1);
  assert.equal(normalizedCommand(required(client.calls.at(-1)).text), 'ROLLBACK');
});

void test('a rejected BEGIN is rolled back and rollback failure evicts the client', async () => {
  const rejectedBegin = new ScriptedClient([
    () => { throw new Error('BEGIN acknowledgement lost'); }, command('ROLLBACK'),
  ]);
  await expectCode(
    new PostgresExecutionIntentRepository(new ScriptedPool(rejectedBegin))
      .create(executionDraft('begin-rejected')),
    'DATABASE_FAILURE',
  );
  assert.deepEqual(rejectedBegin.calls.map((call) => normalizedCommand(call.text)), ['BEGIN', 'ROLLBACK']);
  assert.deepEqual(rejectedBegin.releaseErrors, [false]);

  const failedRollback = new ScriptedClient([
    () => { throw new Error('BEGIN acknowledgement lost'); },
    () => { throw new Error('ROLLBACK failed'); },
  ]);
  await expectCode(
    new PostgresExecutionIntentRepository(new ScriptedPool(failedRollback))
      .create(executionDraft('begin-rollback-failed')),
    'DATABASE_FAILURE',
  );
  assert.deepEqual(failedRollback.releaseErrors, [true]);
});

void test('hostile database error proxies are redacted without invoking traps', async () => {
  let proxyTraps = 0;
  const hostile = new Proxy(new Error('database-proxy-secret'), {
    getPrototypeOf: () => {
      proxyTraps += 1;
      throw new Error('database-proxy-secret');
    },
  });
  const client = new ScriptedClient([
    () => { throw hostile; },
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.read(executionDraft('hostile-error').id), 'DATABASE_FAILURE');
  assert.equal(proxyTraps, 0);
  assert.equal(client.released, true);
});

void test('public input validation is exact, bounded, typed, and does not invoke hostile accessors', async () => {
  let getterCalls = 0;
  const claim = claimedIntent(executionDraft('hostile'), 'PROCESSING');
  const hostile = { ownerId: 'worker', leaseMs: 1, purpose: 'EXECUTE' };
  Object.defineProperty(hostile, 'ownerId', {
    enumerable: true,
    get: () => { getterCalls += 1; throw new Error('input-secret'); },
  });
  const pool = new ScriptedPool(new ScriptedClient([]));
  const repository = new PostgresExecutionIntentRepository(pool);

  await expectCode(repository.claim(hostile as never), 'INVALID_INPUT');
  await expectCode(repository.renew(claim, 0), 'INVALID_INPUT');
  await expectCode(repository.expirePreSubmission(0), 'INVALID_INPUT');
  await expectCode(repository.transition(claim, {
    ...transitionInput(claim, 'SIMULATED'), extra: true,
  } as never), 'INVALID_INPUT');
  await expectCode(repository.transition(claim, {
    ...transitionInput(claim, 'SIMULATED'), reasonCode: 'INTENT_DUPLICATE',
  }), 'INVALID_INPUT');
  await expectCode(repository.finishAttempt(claim, {
    attemptNumber: 1, status: 'COMPLETED', effectiveVenue: 'PUMP_FUN',
    providerId: 'provider', reasonCode: 'QUOTE_STALE',
  }), 'INVALID_INPUT');
  await expectCode(repository.finishAttempt(claim, {
    attemptNumber: 1, status: 'ABANDONED', effectiveVenue: 'PUMP_FUN',
    providerId: 'provider', reasonCode: 'ATTEMPT_COMPLETED',
  }), 'INVALID_INPUT');
  assert.equal(getterCalls, 0);
  assert.equal(pool.connectCount, 0);
});

void test('transition rejects unsafe UNKNOWN terminalization before acquiring a database client', async () => {
  for (const reasonCode of [
    'SUBMISSION_AMBIGUOUS',
    'CONFIRMATION_TIMEOUT',
    'RECONCILIATION_REQUIRED',
    'QUOTE_STALE',
  ] as const) {
    const claim = claimedIntent(executionDraft(`unsafe-unknown-${reasonCode}`),
      'UNKNOWN_REQUIRES_RECONCILIATION', 0);
    const pool = new ScriptedPool(new ScriptedClient([]));
    const repository = new PostgresExecutionIntentRepository(pool);
    await expectCode(repository.transition(claim, {
      ...transitionInput(claim, 'FAILED'), reasonCode,
    }), 'INVALID_INPUT');
    assert.equal(pool.connectCount, 0);
  }
  {
    const claim = claimedIntent(executionDraft('unsafe-unknown-retry'),
      'UNKNOWN_REQUIRES_RECONCILIATION', 0);
    const pool = new ScriptedPool(new ScriptedClient([]));
    const repository = new PostgresExecutionIntentRepository(pool);
    await expectCode(repository.transition(claim, {
      ...transitionInput(claim, 'RETRY_READY'), reasonCode: 'RETRY_AUTHORIZED',
    }), 'INVALID_INPUT');
    assert.equal(pool.connectCount, 0);
  }
  for (const status of ['PROCESSING', 'SIMULATED'] as const) {
    const claim = claimedIntent(executionDraft(`misplaced-proof-${status}`), status, 0);
    const pool = new ScriptedPool(new ScriptedClient([]));
    const repository = new PostgresExecutionIntentRepository(pool);
    await expectCode(repository.transition(claim, {
      ...transitionInput(claim, 'FAILED'),
      reasonCode: 'RECONCILIATION_PROVED_NO_EFFECT',
    }), 'INVALID_INPUT');
    assert.equal(pool.connectCount, 0);
  }
});

void test('transition accepts exact no-effect proof for UNKNOWN and persists terminal retention', async () => {
  const draft = executionDraft('proved-no-effect');
  const claim = claimedIntent(draft, 'UNKNOWN_REQUIRES_RECONCILIATION', 0);
  const terminal = intentRow(draft, {
    status: 'FAILED', attempt_count: 0,
    last_reason_code: 'RECONCILIATION_PROVED_NO_EFFECT', state_revision: '1',
    terminal_at_ms: String(NOW_MS + 1), reconciliation_completed_at_ms: String(NOW_MS + 1),
    purge_after_ms: String(NOW_MS + 14_400_001), updated_at_ms: String(NOW_MS + 1),
  });
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'UNKNOWN_REQUIRES_RECONCILIATION', 0)], 1),
    result([ledgerRow(0)], 1), result([], 1), result([terminal], 1), command('COMMIT'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  const transitioned = await repository.transition(claim, {
    ...transitionInput(claim, 'FAILED'),
    reasonCode: 'RECONCILIATION_PROVED_NO_EFFECT',
  });

  assert.equal(transitioned.status, 'FAILED');
  assert.equal(transitioned.lastReasonCode, 'RECONCILIATION_PROVED_NO_EFFECT');
  assert.equal(transitioned.reconciliationCompletedAtMs, transitioned.terminalAtMs);
  assert.equal(required(client.calls[3]).values?.[3], 'RECONCILIATION_PROVED_NO_EFFECT');
});

void test('transition accepts exact no-effect proof before making UNKNOWN retryable', async () => {
  const draft = executionDraft('proved-retry-safe', {
    side: 'SELL', venuePolicy: 'CANONICAL_EXIT', quoteAmountRaw: null, baseAmountRaw: 1n,
  });
  const claim = claimedIntent(draft, 'UNKNOWN_REQUIRES_RECONCILIATION', 0);
  const retryReady = claimRow(draft, 'RETRY_READY', 0);
  Object.assign(retryReady, {
    last_reason_code: 'RECONCILIATION_PROVED_NO_EFFECT', state_revision: '1',
    updated_at_ms: String(NOW_MS + 1),
  });
  const client = new ScriptedClient([
    command('BEGIN'), result([], 1),
    result([claimRow(draft, 'UNKNOWN_REQUIRES_RECONCILIATION', 0)], 1),
    result([ledgerRow(0)], 1), result([], 1), result([retryReady], 1), command('COMMIT'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  const transitioned = await repository.transition(claim, {
    ...transitionInput(claim, 'RETRY_READY'),
    reasonCode: 'RECONCILIATION_PROVED_NO_EFFECT',
  });

  assert.equal(transitioned.status, 'RETRY_READY');
  assert.equal(transitioned.lastReasonCode, 'RECONCILIATION_PROVED_NO_EFFECT');
  assert.equal(transitioned.reconciliationCompletedAtMs, null);
  assert.match(required(client.calls[1]).text, /execution-live-sell-presence:v1/u);
  assert.equal(required(client.calls[4]).values?.[3], 'RECONCILIATION_PROVED_NO_EFFECT');
});

void test('a purged logical order cannot be recreated with fresh evidence and timestamps', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: post-purge replay test skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, 'execution_intent_post_purge_replay', async (pool) => {
    await migrateDatabase({ pool });
    const repository = new PostgresExecutionIntentRepository(pool);
    const now = await databaseNowMs(pool);
    const live = executionDraft('post-purge-replay', {
      requestedAtMs: now - 1_000, expiresAtMs: now + 60_000,
    });
    await repository.create(live);
    const claim = required(await repository.claim({
      ownerId: 'terminal-worker', leaseMs: 30_000, purpose: 'EXECUTE',
    }));
    await repository.transition(claim, transitionInput(claim, 'CANCELLED'));

    const aged = await pool.query<{ readonly requested_at_ms: string; readonly expires_at_ms: string }>(`
      WITH operation AS MATERIALIZED (
        SELECT date_trunc('milliseconds', statement_timestamp()) AS at
      )
      UPDATE execution_intents AS intent
      SET requested_at=operation.at - INTERVAL '8 hours',
        expires_at=operation.at - INTERVAL '4 hours',
        terminal_at=operation.at - INTERVAL '4 hours',
        reconciliation_completed_at=operation.at - INTERVAL '4 hours',
        purge_after=operation.at,
        created_at=operation.at - INTERVAL '8 hours',
        updated_at=operation.at - INTERVAL '4 hours'
      FROM operation WHERE intent.id=$1
      RETURNING trunc(EXTRACT(EPOCH FROM requested_at) * 1000)::TEXT AS requested_at_ms,
        trunc(EXTRACT(EPOCH FROM expires_at) * 1000)::TEXT AS expires_at_ms`, [live.id]);
    required(aged.rows[0]);
    assert.equal((await purgeExpiredFoundationData(pool)).executionIntents, 1);
    const freshNow = await databaseNowMs(pool);
    const replay = executionDraft('post-purge-replay', {
      decisionEventId: 'event-post-purge-replay-fresh',
      decisionFingerprint: 'b'.repeat(64),
      requestedAtMs: freshNow,
      expiresAtMs: freshNow + 60_000,
    });
    assert.equal(replay.id, live.id);
    assert.equal(replay.logicalOrderKey, live.logicalOrderKey);
    await expectCode(repository.create(replay), 'INTENT_DUPLICATE');
    assert.equal(await repository.read(live.id), null);
    assert.equal(await repository.claim({
      ownerId: 'replay-worker', leaseMs: 30_000, purpose: 'EXECUTE',
    }), null);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_intents WHERE id=$1', [live.id],
    )).rows[0]?.count, 0);
  });
});

void test('create racing a locked purge fails closed on the committed tombstone', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: concurrent tombstone test skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, 'execution_intent_concurrent_tombstone', async (
    firstPool,
    secondPool,
  ) => {
    await migrateDatabase({ pool: firstPool });
    const original = executionDraft('concurrent-post-purge');
    await firstPool.query(`INSERT INTO execution_intents (
      id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,
      logical_command_id,mint,side,venue_policy,quote_mint,quote_token_program,
      quote_decimals,quote_amount_raw,base_amount_raw,minimum_amount_out_raw,
      decision_event_id,decision_fingerprint,requested_at,expires_at,status,
      last_reason_code,terminal_at,reconciliation_completed_at,purge_after
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
      to_timestamp(0),to_timestamp(1),'SUCCEEDED','INTENT_SUCCEEDED',to_timestamp(1),
      to_timestamp(2),to_timestamp(14402))`, [
      original.id, original.payloadVersion, original.logicalOrderKey, original.strategyId,
      original.strategyVersion, original.positionId, original.logicalCommandId, original.mint,
      original.side, original.venuePolicy, original.quoteMint, original.quoteTokenProgram,
      original.quoteDecimals, original.quoteAmountRaw?.toString(), original.baseAmountRaw,
      original.minimumAmountOutRaw.toString(), original.decisionEventId,
      original.decisionFingerprint,
    ]);
    const advisoryKey = 5_100_091;
    await firstPool.query(`CREATE FUNCTION block_execution_intent_parent_delete()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        PERFORM pg_advisory_lock(${advisoryKey});
        PERFORM pg_advisory_unlock(${advisoryKey});
        RETURN OLD;
      END
      $function$`);
    await firstPool.query(`CREATE TRIGGER block_execution_intent_parent_delete_trigger
      AFTER DELETE ON execution_intents FOR EACH ROW
      EXECUTE FUNCTION block_execution_intent_parent_delete()`);

    const blocker = await secondPool.connect();
    let blockerLocked = false;
    let purge: Promise<Awaited<ReturnType<typeof purgeExpiredFoundationData>>> | undefined;
    let replay: Promise<unknown> | undefined;
    try {
      await blocker.query('SELECT pg_advisory_lock($1)', [advisoryKey]);
      blockerLocked = true;
      purge = purgeExpiredFoundationData(firstPool);
      await waitForDatabaseQuery(secondPool, '%DELETE FROM execution_intents intent%');
      const now = await databaseNowMs(secondPool);
      const fresh = executionDraft('concurrent-post-purge', {
        decisionEventId: 'event-concurrent-post-purge-fresh',
        decisionFingerprint: 'c'.repeat(64), requestedAtMs: now, expiresAtMs: now + 60_000,
      });
      replay = new PostgresExecutionIntentRepository(secondPool).create(fresh);
      await waitForDatabaseQuery(firstPool, '%INSERT INTO execution_intents AS intent%');
      await blocker.query('SELECT pg_advisory_unlock($1)', [advisoryKey]);
      blockerLocked = false;
      assert.equal((await purge).executionIntents, 1);
      await expectCode(replay, 'INTENT_DUPLICATE');
    } finally {
      if (blockerLocked) await blocker.query('SELECT pg_advisory_unlock($1)', [advisoryKey]);
      blocker.release();
      await Promise.allSettled([purge, replay].filter((value) => value !== undefined));
    }
    assert.equal((await firstPool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_intents WHERE id=$1', [original.id],
    )).rows[0]?.count, 0);
    assert.equal((await firstPool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_intent_tombstones WHERE intent_id=$1',
      [original.id],
    )).rows[0]?.count, 1);
  });
});

void test('real PostgreSQL enforces live SELL priority, recovery, and reconciliation claims', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live lane claim integration skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'execution_live_lane_claims', async (
    firstPool,
    secondPool,
  ) => {
    await migrateDatabase({ pool: firstPool });
    const first = new PostgresExecutionIntentRepository(firstPool);
    const second = new PostgresExecutionIntentRepository(secondPool);
    const now = await databaseNowMs(firstPool);
    const sellShape = Object.freeze({
      side: 'SELL' as const,
      venuePolicy: 'CANONICAL_EXIT' as const,
      quoteAmountRaw: null,
      baseAmountRaw: 1n,
    });

    const oldestBuy = executionDraft('live-priority-buy', {
      requestedAtMs: now - 3_000, expiresAtMs: now + 120_000,
    });
    const oldestSell = executionDraft('live-priority-sell-oldest', {
      ...sellShape, requestedAtMs: now - 2_000, expiresAtMs: now + 120_000,
    });
    const newestSell = executionDraft('live-priority-sell-newest', {
      ...sellShape, requestedAtMs: now - 1_000, expiresAtMs: now + 120_000,
    });
    await first.create(oldestBuy);
    await first.create(newestSell);
    await first.create(oldestSell);

    const firstSellClaim = required(await first.claim({
      ownerId: 'live-sell-a', leaseMs: 60_000, purpose: 'LIVE_EXECUTE', side: 'SELL',
    }));
    assert.equal(firstSellClaim.intent.id, oldestSell.id);
    assert.equal(await second.claim({
      ownerId: 'live-buy-blocked-a', leaseMs: 60_000, purpose: 'LIVE_EXECUTE', side: 'BUY',
      generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    }), null);
    assert.equal(await first.release(firstSellClaim), true);
    await firstPool.query('DELETE FROM execution_intents WHERE id=$1', [oldestSell.id]);

    const secondSellClaim = required(await second.claim({
      ownerId: 'live-sell-b', leaseMs: 60_000, purpose: 'LIVE_EXECUTE', side: 'SELL',
    }));
    assert.equal(secondSellClaim.intent.id, newestSell.id);
    assert.equal(await first.claim({
      ownerId: 'live-buy-blocked-b', leaseMs: 60_000, purpose: 'LIVE_EXECUTE', side: 'BUY',
      generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    }), null);
    await firstPool.query('DELETE FROM execution_intents WHERE id=$1', [newestSell.id]);
    assert.equal(await first.claim({
      ownerId: 'live-buy-unarmed', leaseMs: 60_000, purpose: 'LIVE_EXECUTE', side: 'BUY',
      generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    }), null);
    await seedLiveExecuteBuyTarget(firstPool, oldestBuy);
    const buyClaim = required(await first.claim({
      ownerId: 'live-buy', leaseMs: 60_000, purpose: 'LIVE_EXECUTE', side: 'BUY',
      generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    }));
    assert.equal(buyClaim.intent.id, oldestBuy.id);
    assert.equal(await first.release(buyClaim), true);
    const concurrentTargetBuy = await Promise.all([
      first.claim({
        ownerId: 'live-target-buy-a', leaseMs: 60_000, purpose: 'LIVE_EXECUTE', side: 'BUY',
        generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
      }),
      second.claim({
        ownerId: 'live-target-buy-b', leaseMs: 60_000, purpose: 'LIVE_EXECUTE', side: 'BUY',
        generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
      }),
    ]);
    assert.equal(concurrentTargetBuy.filter((claim) => claim !== null).length, 1);
    assert.equal(required(concurrentTargetBuy.find((claim) => claim !== null)).intent.id, oldestBuy.id);
    await firstPool.query('DELETE FROM execution_activation_armaments WHERE target_intent_id=$1', [oldestBuy.id]);
    await firstPool.query('DELETE FROM execution_exposure_reservations WHERE intent_id=$1', [oldestBuy.id]);
    await firstPool.query('DELETE FROM execution_risk_admission_reports WHERE intent_id=$1', [oldestBuy.id]);
    await firstPool.query('DELETE FROM execution_intents WHERE id=$1', [oldestBuy.id]);

    const concurrentSell = executionDraft('live-concurrent-sell', {
      ...sellShape, requestedAtMs: now - 1_000, expiresAtMs: now + 120_000,
    });
    await first.create(concurrentSell);
    const concurrent = await Promise.all([
      first.claim({
        ownerId: 'live-concurrent-a', leaseMs: 60_000,
        purpose: 'LIVE_EXECUTE', side: 'SELL',
      }),
      second.claim({
        ownerId: 'live-concurrent-b', leaseMs: 60_000,
        purpose: 'LIVE_EXECUTE', side: 'SELL',
      }),
    ]);
    assert.equal(concurrent.filter((claim) => claim !== null).length, 1);
    assert.equal(required(concurrent.find((claim) => claim !== null)).intent.id, concurrentSell.id);
    await firstPool.query('DELETE FROM execution_intents WHERE id=$1', [concurrentSell.id]);

    const racedBuy = executionDraft('live-raced-buy', {
      requestedAtMs: now - 2_000, expiresAtMs: now + 120_000,
    });
    const racedSell = executionDraft('live-raced-sell', {
      ...sellShape, requestedAtMs: now - 1_000, expiresAtMs: now + 120_000,
    });
    await first.create(racedBuy);
    await first.create(racedSell);
    const [racedBuyClaim, racedSellClaim] = await Promise.all([
      first.claim({
        ownerId: 'live-raced-buy-worker', leaseMs: 60_000,
        purpose: 'LIVE_EXECUTE', side: 'BUY',
        generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
      }),
      second.claim({
        ownerId: 'live-raced-sell-worker', leaseMs: 60_000,
        purpose: 'LIVE_EXECUTE', side: 'SELL',
      }),
    ]);
    assert.equal(racedBuyClaim, null);
    assert.equal(racedSellClaim?.intent.id, racedSell.id);
    await firstPool.query('DELETE FROM execution_intents WHERE id=ANY($1::TEXT[])', [[
      racedBuy.id, racedSell.id,
    ]]);

    const recoverBlockingBuy = executionDraft('live-recover-blocked-buy', {
      requestedAtMs: now - 1_000, expiresAtMs: now + 120_000,
    });
    const expiredRecoverSell = executionDraft('live-recover-expired-sell', {
      ...sellShape, requestedAtMs: now - 120_000, expiresAtMs: now - 60_000,
    });
    await first.create(recoverBlockingBuy);
    await first.create(expiredRecoverSell);
    await firstPool.query(`UPDATE execution_intents SET status='SIGNED_NOT_SUBMITTED',
      attempt_count=1,last_reason_code='SIGNATURE_PERSISTED' WHERE id=$1`, [
      expiredRecoverSell.id,
    ]);
    const recoverClaim = required(await first.claim({
      ownerId: 'live-recover', leaseMs: 60_000, purpose: 'LIVE_RECOVER',
    }));
    assert.equal(recoverClaim.intent.id, expiredRecoverSell.id);
    assert.equal(recoverClaim.intent.status, 'SIGNED_NOT_SUBMITTED');
    assert.equal(await second.claim({
      ownerId: 'live-buy-blocked-recovery', leaseMs: 60_000,
      purpose: 'LIVE_EXECUTE', side: 'BUY',
      generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    }), null);
    assert.equal(await second.claim({
      ownerId: 'reconcile-must-not-recover', leaseMs: 60_000, purpose: 'RECONCILE',
    }), null);
    await firstPool.query('DELETE FROM execution_intents WHERE id=ANY($1::TEXT[])', [[
      recoverBlockingBuy.id, expiredRecoverSell.id,
    ]]);

    const sideRecoverBuy = executionDraft('live-side-recover-buy', {
      requestedAtMs: now - 3_000, expiresAtMs: now - 2_000,
    });
    const activePendingSell = executionDraft('live-side-recover-active-sell', {
      ...sellShape, requestedAtMs: now - 1_000, expiresAtMs: now + 120_000,
    });
    await first.create(sideRecoverBuy);
    await first.create(activePendingSell);
    await firstPool.query(`UPDATE execution_intents SET status='SIGNED_NOT_SUBMITTED',
      attempt_count=1,last_reason_code='SIGNATURE_PERSISTED' WHERE id=$1`, [sideRecoverBuy.id]);
    assert.equal(await second.claim({
      ownerId: 'live-side-recover-buy-blocked', leaseMs: 60_000,
      purpose: 'LIVE_RECOVER', side: 'BUY',
    }), null);
    await firstPool.query("UPDATE execution_intents SET expires_at=date_trunc('milliseconds', statement_timestamp() - INTERVAL '1 second') WHERE id=$1", [
      activePendingSell.id,
    ]);
    const recoveredBuy = required(await second.claim({
      ownerId: 'live-side-recover-buy', leaseMs: 60_000,
      purpose: 'LIVE_RECOVER', side: 'BUY',
    }));
    assert.equal(recoveredBuy.intent.id, sideRecoverBuy.id);
    await firstPool.query('DELETE FROM execution_intents WHERE id=ANY($1::TEXT[])', [[
      sideRecoverBuy.id, activePendingSell.id,
    ]]);

    const signedRecoverBuy = executionDraft('live-side-recover-signed-buy', {
      requestedAtMs: now - 3_000, expiresAtMs: now - 2_000,
    });
    const signedRecoverSell = executionDraft('live-side-recover-signed-sell', {
      ...sellShape, requestedAtMs: now - 2_000, expiresAtMs: now - 1_000,
    });
    await first.create(signedRecoverBuy);
    await first.create(signedRecoverSell);
    await firstPool.query(`UPDATE execution_intents SET status='SIGNED_NOT_SUBMITTED',
      attempt_count=1,last_reason_code='SIGNATURE_PERSISTED'
      WHERE id=ANY($1::TEXT[])`, [[signedRecoverBuy.id, signedRecoverSell.id]]);
    assert.equal(await second.claim({
      ownerId: 'live-side-recover-buy-blocked-by-signed-sell', leaseMs: 60_000,
      purpose: 'LIVE_RECOVER', side: 'BUY',
    }), null);
    const recoveredSell = required(await first.claim({
      ownerId: 'live-side-recover-sell-first', leaseMs: 60_000,
      purpose: 'LIVE_RECOVER', side: 'SELL',
    }));
    assert.equal(recoveredSell.intent.id, signedRecoverSell.id);
    await firstPool.query('DELETE FROM execution_intents WHERE id=ANY($1::TEXT[])', [[
      signedRecoverBuy.id, signedRecoverSell.id,
    ]]);

    const reconciliationStatuses = [
      ['SIGNED_NOT_SUBMITTED', 'SIGNATURE_PERSISTED'],
      ['CONFIRMED', 'CONFIRMATION_OBSERVED'],
      ['RECONCILING', 'RECONCILIATION_STARTED'],
      ['UNKNOWN_REQUIRES_RECONCILIATION', 'RECONCILIATION_REQUIRED'],
    ] as const;
    const reconciliationDrafts: ExecutionIntentDraftV1[] = [];
    for (const [index, [status, reason]] of reconciliationStatuses.entries()) {
      const requestedAtMs = now - 240_000 + index * 1_000;
      const draft = executionDraft(`live-reconcile-${status.toLowerCase()}`, {
        requestedAtMs, expiresAtMs: requestedAtMs + 60_000,
      });
      reconciliationDrafts.push(draft);
      await first.create(draft);
      await firstPool.query(`UPDATE execution_intents SET status=$2,
        attempt_count=1,last_reason_code=$3 WHERE id=$1`, [draft.id, status, reason]);
    }

    for (const expectedStatus of [
      'CONFIRMED', 'RECONCILING', 'UNKNOWN_REQUIRES_RECONCILIATION',
    ] as const) {
      const claim = required(await first.claim({
        ownerId: `reconcile-${expectedStatus.toLowerCase()}`,
        leaseMs: 60_000,
        purpose: 'RECONCILE',
      }));
      assert.equal(claim.intent.status, expectedStatus);
    }
    assert.equal(await first.claim({
      ownerId: 'reconcile-empty', leaseMs: 60_000, purpose: 'RECONCILE',
    }), null);
    const signedRecovery = required(await second.claim({
      ownerId: 'signed-recovery-only', leaseMs: 60_000, purpose: 'LIVE_RECOVER',
    }));
    assert.equal(signedRecovery.intent.status, 'SIGNED_NOT_SUBMITTED');
    await firstPool.query('DELETE FROM execution_intents WHERE id=ANY($1::TEXT[])', [
      reconciliationDrafts.map((draft) => draft.id),
    ]);
  });
});

void test('LIVE_EXECUTE BUY forces READ COMMITTED and observes an uncommitted SELL after its commit',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: live BUY versus SELL creation race skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, 'execution_live_buy_sell_creation_race', async (
      firstPool,
      secondPool,
    ) => {
      await migrateDatabase({ pool: firstPool });
      const first = new PostgresExecutionIntentRepository(firstPool);
      const buySession = await secondPool.connect();
      await buySession.query(
        "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ",
      );
      const second = new PostgresExecutionIntentRepository({
        connect: async () => buySession,
      });
      const now = await databaseNowMs(firstPool);
      const buy = executionDraft('live-buy-sell-creation-race-buy', {
        requestedAtMs: now - 2_000, expiresAtMs: now + 120_000,
      });
      const sell = executionDraft('live-buy-sell-creation-race-sell', {
        side: 'SELL', venuePolicy: 'CANONICAL_EXIT', quoteAmountRaw: null, baseAmountRaw: 1n,
        requestedAtMs: now - 1_000, expiresAtMs: now + 120_000,
      });
      await first.create(buy);

      const triggerLockKey = 5_100_092;
      await firstPool.query(`CREATE FUNCTION block_live_sell_intent_insert()
        RETURNS trigger LANGUAGE plpgsql AS $function$
        BEGIN
          IF NEW.side = 'SELL' THEN
            PERFORM pg_advisory_lock(${triggerLockKey});
            PERFORM pg_advisory_unlock(${triggerLockKey});
          END IF;
          RETURN NEW;
        END
        $function$`);
      await firstPool.query(`CREATE TRIGGER block_live_sell_intent_insert_trigger
        AFTER INSERT ON execution_intents FOR EACH ROW
        EXECUTE FUNCTION block_live_sell_intent_insert()`);

      const blocker = await secondPool.connect();
      let blockerLocked = false;
      let sellCreation: Promise<unknown> | undefined;
      let buyClaim: Promise<ClaimedExecutionIntent | null> | undefined;
      try {
        await blocker.query('SELECT pg_advisory_lock($1)', [triggerLockKey]);
        blockerLocked = true;
        sellCreation = first.create(sell);
        await waitForDatabaseQuery(firstPool, '%INSERT INTO execution_intents AS intent%');

        buyClaim = second.claim({
          ownerId: 'live-buy-sell-creation-race-worker', leaseMs: 60_000,
          purpose: 'LIVE_EXECUTE', side: 'BUY',
          generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
        });
        const outcome = await Promise.race([
          buyClaim.then(() => 'CLAIM_SETTLED' as const),
          waitForDatabaseQuery(firstPool, '%execution-live-sell-presence:v1%')
            .then(() => 'CLAIM_BLOCKED' as const),
        ]);
        assert.equal(outcome, 'CLAIM_BLOCKED');

        await blocker.query('SELECT pg_advisory_unlock($1)', [triggerLockKey]);
        blockerLocked = false;
        assert.equal((await sellCreation as { readonly kind: string }).kind, 'CREATED');
        assert.equal(await buyClaim, null);
      } finally {
        if (blockerLocked) await blocker.query('SELECT pg_advisory_unlock($1)', [triggerLockKey]);
        blocker.release();
        await Promise.allSettled(
          [sellCreation, buyClaim].filter((value) => value !== undefined),
        );
      }
    });
  });

void test('LIVE_RECOVER BUY waits for an uncommitted SELL creation and observes it after commit',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: live recovery versus SELL creation race skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, 'execution_live_recover_sell_creation_race', async (
      firstPool,
      secondPool,
    ) => {
      await migrateDatabase({ pool: firstPool });
      const first = new PostgresExecutionIntentRepository(firstPool);
      const second = new PostgresExecutionIntentRepository(secondPool);
      const now = await databaseNowMs(firstPool);
      const buy = executionDraft('live-recover-sell-creation-race-buy', {
        requestedAtMs: now - 2_000, expiresAtMs: now - 1_000,
      });
      const sell = executionDraft('live-recover-sell-creation-race-sell', {
        side: 'SELL', venuePolicy: 'CANONICAL_EXIT', quoteAmountRaw: null, baseAmountRaw: 1n,
        requestedAtMs: now - 1_000, expiresAtMs: now + 120_000,
      });
      await first.create(buy);
      await firstPool.query(`UPDATE execution_intents SET status='SIGNED_NOT_SUBMITTED',
        attempt_count=1,last_reason_code='SIGNATURE_PERSISTED' WHERE id=$1`, [buy.id]);

      const triggerLockKey = 5_100_093;
      await firstPool.query(`CREATE FUNCTION block_live_recovery_sell_intent_insert()
        RETURNS trigger LANGUAGE plpgsql AS $function$
        BEGIN
          IF NEW.side = 'SELL' THEN
            PERFORM pg_advisory_lock(${triggerLockKey});
            PERFORM pg_advisory_unlock(${triggerLockKey});
          END IF;
          RETURN NEW;
        END
        $function$`);
      await firstPool.query(`CREATE TRIGGER block_live_recovery_sell_intent_insert_trigger
        AFTER INSERT ON execution_intents FOR EACH ROW
        EXECUTE FUNCTION block_live_recovery_sell_intent_insert()`);

      const blocker = await secondPool.connect();
      let blockerLocked = false;
      let sellCreation: Promise<unknown> | undefined;
      let buyRecovery: Promise<ClaimedExecutionIntent | null> | undefined;
      try {
        await blocker.query('SELECT pg_advisory_lock($1)', [triggerLockKey]);
        blockerLocked = true;
        sellCreation = first.create(sell);
        await waitForDatabaseQuery(firstPool, '%INSERT INTO execution_intents AS intent%');

        buyRecovery = second.claim({
          ownerId: 'live-recover-sell-creation-race-worker', leaseMs: 60_000,
          purpose: 'LIVE_RECOVER', side: 'BUY',
        });
        const outcome = await Promise.race([
          buyRecovery.then(() => 'CLAIM_SETTLED' as const),
          waitForDatabaseQuery(firstPool, '%execution-live-sell-presence:v1%')
            .then(() => 'CLAIM_BLOCKED' as const),
        ]);
        assert.equal(outcome, 'CLAIM_BLOCKED');

        await blocker.query('SELECT pg_advisory_unlock($1)', [triggerLockKey]);
        blockerLocked = false;
        assert.equal((await sellCreation as { readonly kind: string }).kind, 'CREATED');
        assert.equal(await buyRecovery, null);
      } finally {
        if (blockerLocked) await blocker.query('SELECT pg_advisory_unlock($1)', [triggerLockKey]);
        blocker.release();
        await Promise.allSettled(
          [sellCreation, buyRecovery].filter((value) => value !== undefined),
        );
      }
    });
  });

void test('LIVE_RECOVER BUY waits for an uncommitted signed SELL persistence boundary',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: live recovery versus signed SELL race skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, 'execution_live_recover_signed_sell_race', async (
      firstPool,
      secondPool,
    ) => {
      await migrateDatabase({ pool: firstPool });
      const first = new PostgresExecutionIntentRepository(firstPool);
      const second = new PostgresExecutionIntentRepository(secondPool);
      const now = await databaseNowMs(firstPool);
      const buy = executionDraft('live-recover-signed-sell-race-buy', {
        requestedAtMs: now - 3_000, expiresAtMs: now - 2_000,
      });
      const sell = executionDraft('live-recover-signed-sell-race-sell', {
        side: 'SELL', venuePolicy: 'CANONICAL_EXIT', quoteAmountRaw: null, baseAmountRaw: 1n,
        requestedAtMs: now - 2_000, expiresAtMs: now - 1_000,
      });
      await first.create(buy);
      await first.create(sell);
      await firstPool.query(`UPDATE execution_intents SET status='SIGNED_NOT_SUBMITTED',
        attempt_count=1,last_reason_code='SIGNATURE_PERSISTED' WHERE id=$1`, [buy.id]);

      const signingSession = await firstPool.connect();
      let transactionOpen = false;
      let buyRecovery: Promise<ClaimedExecutionIntent | null> | undefined;
      try {
        await signingSession.query('BEGIN');
        transactionOpen = true;
        await lockLiveSellPresenceInTransaction(signingSession);
        const persisted = await signingSession.query(`UPDATE execution_intents
          SET status='SIGNED_NOT_SUBMITTED',attempt_count=1,
            last_reason_code='SIGNATURE_PERSISTED'
          WHERE id=$1 AND side='SELL' AND status='PENDING'`, [sell.id]);
        assert.equal(persisted.rowCount, 1);

        buyRecovery = second.claim({
          ownerId: 'live-recover-signed-sell-race-worker', leaseMs: 60_000,
          purpose: 'LIVE_RECOVER', side: 'BUY',
        });
        const outcome = await Promise.race([
          buyRecovery.then(() => 'CLAIM_SETTLED' as const),
          waitForDatabaseQuery(firstPool, '%execution-live-sell-presence:v1%')
            .then(() => 'CLAIM_BLOCKED' as const),
        ]);
        assert.equal(outcome, 'CLAIM_BLOCKED');

        await signingSession.query('COMMIT');
        transactionOpen = false;
        assert.equal(await buyRecovery, null);
      } finally {
        if (transactionOpen) await signingSession.query('ROLLBACK');
        signingSession.release();
        await Promise.allSettled(
          [buyRecovery].filter((value) => value !== undefined),
        );
      }
    });
  });

void test('concurrent LIVE_RECOVER BUY claims elect one winner without deadlock', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: concurrent live recovery claims skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, 'execution_live_recover_buy_concurrency', async (
    firstPool,
    secondPool,
  ) => {
    await migrateDatabase({ pool: firstPool });
    const first = new PostgresExecutionIntentRepository(firstPool);
    const second = new PostgresExecutionIntentRepository(secondPool);
    const now = await databaseNowMs(firstPool);
    const buy = executionDraft('live-recover-buy-concurrent', {
      requestedAtMs: now - 2_000, expiresAtMs: now - 1_000,
    });
    await first.create(buy);
    await firstPool.query(`UPDATE execution_intents SET status='SIGNED_NOT_SUBMITTED',
      attempt_count=1,last_reason_code='SIGNATURE_PERSISTED' WHERE id=$1`, [buy.id]);

    const claims = await Promise.all([
      first.claim({
        ownerId: 'live-recover-buy-concurrent-a', leaseMs: 60_000,
        purpose: 'LIVE_RECOVER', side: 'BUY',
      }),
      second.claim({
        ownerId: 'live-recover-buy-concurrent-b', leaseMs: 60_000,
        purpose: 'LIVE_RECOVER', side: 'BUY',
      }),
    ]);

    assert.equal(claims.filter((claim) => claim !== null).length, 1);
    assert.equal(required(claims.find((claim) => claim !== null)).intent.id, buy.id);
  });
});

void test('real PostgreSQL provides replay, concurrent claims, near-boundary reclaim, attempts, and ordered lifecycle journal', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: execution intent repository integration skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'execution_intent_repository', async (firstPool, secondPool) => {
    await migrateDatabase({ pool: firstPool });
    const first = new PostgresExecutionIntentRepository(firstPool);
    const second = new PostgresExecutionIntentRepository(secondPool);
    const now = await databaseNowMs(firstPool);
    const draft = executionDraft('postgres-lifecycle', {
      requestedAtMs: now - 1_000, expiresAtMs: now + 120_000,
    });

    assert.equal((await first.create(draft)).kind, 'CREATED');
    assert.equal((await second.create(draft)).kind, 'REPLAYED');
    await expectCode(first.create(executionDraft('postgres-lifecycle', {
      positionId: 'different-position', requestedAtMs: now - 1_000, expiresAtMs: now + 120_000,
    })), 'INTENT_DUPLICATE');

    const concurrent = await Promise.all([
      first.claim({ ownerId: 'worker-a', leaseMs: 60_000, purpose: 'EXECUTE' }),
      second.claim({ ownerId: 'worker-b', leaseMs: 60_000, purpose: 'EXECUTE' }),
    ]);
    assert.equal(concurrent.filter((value) => value !== null).length, 1);
    const initialClaim = required(concurrent.find((value) => value !== null));
    const processing = await first.transition(initialClaim, transitionInput(initialClaim, 'PROCESSING'));
    let activeClaim = Object.freeze({ ...initialClaim, intent: processing });
    const begun = await first.beginAttempt(activeClaim);
    activeClaim = begun.claim;
    const attempt = begun.attempt;
    assert.deepEqual(await first.beginAttempt(activeClaim), begun);
    activeClaim = Object.freeze({ ...activeClaim, intent: required(await first.read(draft.id)) });
    await expectCode(
      first.transition(activeClaim, transitionInput(activeClaim, 'SIMULATED', attempt.attemptNumber)),
      'ATTEMPT_CONFLICT',
    );
    await expectCode(
      first.transition(activeClaim, transitionInput(activeClaim, 'FAILED', attempt.attemptNumber)),
      'ATTEMPT_CONFLICT',
    );
    const finishedAttempt = {
      attemptNumber: attempt.attemptNumber, status: 'COMPLETED', effectiveVenue: 'PUMP_FUN',
      providerId: 'provider-a', reasonCode: 'ATTEMPT_COMPLETED',
    } as const;
    assert.equal(await first.finishAttempt(activeClaim, finishedAttempt), true);

    await firstPool.query(`UPDATE execution_intents
      SET lease_expires_at = date_trunc('milliseconds', statement_timestamp())
      WHERE id = $1`, [draft.id]);
    await expectCode(first.renew(activeClaim, 60_000), 'INTENT_LEASE_LOST');
    await expectCode(first.finishAttempt(activeClaim, finishedAttempt), 'INTENT_LEASE_LOST');
    const reclaimed = await second.claim({ ownerId: 'worker-reclaimer', leaseMs: 60_000, purpose: 'EXECUTE' });
    assert.ok(reclaimed);
    assert.equal(reclaimed.intent.status, 'PROCESSING');
    assert.notEqual(reclaimed.leaseToken, initialClaim.leaseToken);
    await expectCode(first.release(activeClaim), 'INTENT_LEASE_LOST');

    const simulated = await second.transition(reclaimed, transitionInput(reclaimed, 'SIMULATED', 1));
    const simulatedClaim = Object.freeze({ ...reclaimed, intent: simulated });
    const succeeded = await second.transition(simulatedClaim, transitionInput(simulatedClaim, 'SUCCEEDED', 1));
    assert.equal(succeeded.status, 'SUCCEEDED');
    assert.equal(succeeded.reconciliationCompletedAtMs, succeeded.terminalAtMs);
    assert.equal(required(succeeded.purgeAfterMs) - required(succeeded.terminalAtMs), 14_400_000);

    const counts = await firstPool.query(`SELECT intent.attempt_count,
      COUNT(attempt.*)::INTEGER AS attempts
      FROM execution_intents intent
      LEFT JOIN execution_attempts attempt ON attempt.intent_id = intent.id
      WHERE intent.id = $1 GROUP BY intent.attempt_count`, [draft.id]);
    assert.deepEqual(counts.rows, [{ attempt_count: 1, attempts: 1 }]);
    const attemptRows = await firstPool.query(`SELECT attempt_number,status,effective_venue,
      provider_id,reason_code,purge_after FROM execution_attempts WHERE intent_id=$1`, [draft.id]);
    assert.deepEqual(attemptRows.rows, [{
      attempt_number: 1, status: 'COMPLETED', effective_venue: 'PUMP_FUN',
      provider_id: 'provider-a', reason_code: 'ATTEMPT_COMPLETED', purge_after: null,
    }]);
    const journal = await firstPool.query<{
      readonly previous_status: string;
      readonly next_status: string;
      readonly attempt_number: number | null;
      readonly evidence: { readonly payloadVersion: unknown };
    }>(`SELECT previous_status,next_status,reason_code,
      human_message,activation_phase,attempt_number,evidence
      FROM execution_intent_transitions WHERE intent_id=$1 ORDER BY sequence`, [draft.id]);
    assert.deepEqual(journal.rows.map((row) => [row.previous_status, row.next_status]), [
      ['PENDING', 'PROCESSING'], ['PROCESSING', 'SIMULATED'], ['SIMULATED', 'SUCCEEDED'],
    ]);
    assert.deepEqual(journal.rows.map((row) => row.attempt_number), [null, 1, 1]);
    assert.ok(journal.rows.every((row) => row.evidence.payloadVersion === 1));

    const submittedAfterDeadline = executionDraft('postgres-submitted-after-deadline', {
      requestedAtMs: 0, expiresAtMs: 1,
    });
    await first.create(submittedAfterDeadline);
    await firstPool.query(`UPDATE execution_intents
      SET status='SUBMITTED',last_reason_code='SUBMISSION_ACCEPTED' WHERE id=$1`, [
      submittedAfterDeadline.id,
    ]);
    const confirmationClaim = await second.claim({
      ownerId: 'confirmation-worker', leaseMs: 30_000, purpose: 'CONFIRM',
    });
    assert.ok(confirmationClaim);
    assert.equal(confirmationClaim.intent.id, submittedAfterDeadline.id);
    assert.equal(confirmationClaim.intent.status, 'SUBMITTED');
    assert.equal(await second.release(confirmationClaim), true);

    const expiredDraft = executionDraft('postgres-expired', {
      requestedAtMs: 0, expiresAtMs: 1,
    });
    await first.create(expiredDraft);
    assert.equal(await first.expirePreSubmission(10), 1);
    const expired = required(await first.read(expiredDraft.id));
    assert.equal(expired.status, 'EXPIRED');
    assert.equal(expired.reconciliationCompletedAtMs, expired.terminalAtMs);
    const expiryJournal = await firstPool.query(`SELECT previous_status,next_status,
      reason_code,human_message,activation_phase,attempt_number,evidence
      FROM execution_intent_transitions WHERE intent_id=$1`, [expiredDraft.id]);
    assert.equal(expiryJournal.rowCount, 1);
    assert.deepEqual(expiryJournal.rows[0], {
      previous_status: 'PENDING', next_status: 'EXPIRED', reason_code: 'INTENT_EXPIRED',
      human_message: 'Execution intent expired before signature.', activation_phase: 'NONE',
      attempt_number: null,
      evidence: {
        payloadVersion: 1, attemptNumber: null, sourceEventId: null,
        observedAtMs: required(expired.terminalAtMs),
      },
    });

    const activeExpiryDraft = executionDraft('postgres-active-expiry', {
      requestedAtMs: now - 1_000, expiresAtMs: now + 120_000,
    });
    await first.create(activeExpiryDraft);
    const activeExpiryInitialClaim = required(await first.claim({
      ownerId: 'expiry-worker', leaseMs: 60_000, purpose: 'EXECUTE',
    }));
    const activeExpiryProcessing = await first.transition(
      activeExpiryInitialClaim,
      transitionInput(activeExpiryInitialClaim, 'PROCESSING'),
    );
    const activeExpiryClaim = Object.freeze({
      ...activeExpiryInitialClaim, intent: activeExpiryProcessing,
    });
    const activeExpiryAttempt = await first.beginAttempt(activeExpiryClaim);
    await firstPool.query(`UPDATE execution_intents
      SET expires_at=date_trunc('milliseconds', statement_timestamp()),
        lease_expires_at=date_trunc('milliseconds', statement_timestamp())
      WHERE id=$1`, [activeExpiryDraft.id]);
    await expectCode(first.beginAttempt(activeExpiryClaim), 'INTENT_LEASE_LOST');
    assert.equal(await first.expirePreSubmission(10), 1);
    const abandoned = await firstPool.query(`SELECT status,reason_code,
      trunc(EXTRACT(EPOCH FROM completed_at) * 1000)::TEXT AS completed_at_ms
      FROM execution_attempts WHERE intent_id=$1 AND attempt_number=$2`, [
      activeExpiryDraft.id, activeExpiryAttempt.attempt.attemptNumber,
    ]);
    assert.deepEqual(abandoned.rows, [{
      status: 'ABANDONED', reason_code: 'INTENT_EXPIRED',
      completed_at_ms: String(required((await first.read(activeExpiryDraft.id))?.terminalAtMs)),
    }]);
  });
});

void test('real PostgreSQL rejects ABA replay, immutable drift, and parent-attempt gaps', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: execution intent hardening integration skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'execution_intent_hardening', async (pool) => {
    await migrateDatabase({ pool });
    const repository = new PostgresExecutionIntentRepository(pool);
    const now = await databaseNowMs(pool);

    const abaDraft = executionDraft('postgres-aba', {
      requestedAtMs: now - 1_000, expiresAtMs: now + 120_000,
    });
    await repository.create(abaDraft);
    await pool.query(`UPDATE execution_intents
      SET status='UNKNOWN_REQUIRES_RECONCILIATION',
        last_reason_code='RECONCILIATION_REQUIRED' WHERE id=$1`, [abaDraft.id]);
    const original = required(await repository.claim({
      ownerId: 'aba-worker', leaseMs: 60_000, purpose: 'RECONCILE',
    }));
    const confirmedIntent = await repository.transition(
      original, transitionInput(original, 'CONFIRMED'),
    );
    const confirmed = Object.freeze({ ...original, intent: confirmedIntent });
    const unknown = await repository.transition(
      confirmed, transitionInput(confirmed, 'UNKNOWN_REQUIRES_RECONCILIATION'),
    );
    await expectCode(
      repository.transition(original, transitionInput(original, 'CONFIRMED')),
      'INTENT_LEASE_LOST',
    );
    assert.equal(confirmedIntent.stateRevision, 1n);
    assert.equal(unknown.stateRevision, 2n);
    assert.deepEqual((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_intent_transitions WHERE intent_id=$1`, [abaDraft.id])).rows, [{ count: 2 }]);

    const immutableDraft = executionDraft('postgres-immutable-drift', {
      requestedAtMs: now - 900, expiresAtMs: now + 120_000,
    });
    await repository.create(immutableDraft);
    const immutableClaim = required(await repository.claim({
      ownerId: 'immutable-worker', leaseMs: 60_000, purpose: 'EXECUTE',
    }));
    await pool.query(`UPDATE execution_intents SET minimum_amount_out_raw=2 WHERE id=$1`, [
      immutableDraft.id,
    ]);
    await expectCode(repository.renew(immutableClaim, 60_000), 'INVALID_DATA');

    const gapDraft = executionDraft('postgres-attempt-gap', {
      requestedAtMs: now - 800, expiresAtMs: now + 120_000,
    });
    await repository.create(gapDraft);
    await pool.query(`UPDATE execution_intents SET status='PROCESSING',attempt_count=1,
      last_reason_code='EXECUTION_STARTED' WHERE id=$1`, [
      gapDraft.id,
    ]);
    const gapClaim = required(await repository.claim({
      ownerId: 'gap-worker', leaseMs: 60_000, purpose: 'EXECUTE',
    }));
    await expectCode(repository.beginAttempt(gapClaim), 'ATTEMPT_CONFLICT');

    const orphanDraft = executionDraft('postgres-orphan-attempt', {
      requestedAtMs: now - 700, expiresAtMs: now + 120_000,
    });
    await repository.create(orphanDraft);
    await pool.query(`UPDATE execution_intents SET status='PROCESSING',
      last_reason_code='EXECUTION_STARTED' WHERE id=$1`, [
      orphanDraft.id,
    ]);
    await pool.query(`INSERT INTO execution_attempts (
      intent_id,attempt_number,status,started_at
    ) VALUES ($1,1,'STARTED',date_trunc('milliseconds',statement_timestamp()))`, [orphanDraft.id]);
    const orphanClaim = required(await repository.claim({
      ownerId: 'orphan-worker', leaseMs: 60_000, purpose: 'EXECUTE',
    }));
    await expectCode(
      repository.transition(orphanClaim, transitionInput(orphanClaim, 'SIMULATED')),
      'ATTEMPT_CONFLICT',
    );
    assert.deepEqual((await pool.query(`SELECT intent.status,intent.attempt_count,
      attempt.status AS attempt_status,
      (SELECT COUNT(*)::INTEGER FROM execution_intent_transitions AS transition
        WHERE transition.intent_id=intent.id) AS transition_count
      FROM execution_intents AS intent
      JOIN execution_attempts AS attempt ON attempt.intent_id=intent.id
      WHERE intent.id=$1`, [orphanDraft.id])).rows, [{
      status: 'PROCESSING', attempt_count: 0, attempt_status: 'STARTED', transition_count: 0,
    }]);
  });
});

void test('real PostgreSQL replays one STARTED attempt under a reclaimed fresh fence', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: STARTED reclaim integration skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'execution_attempt_reclaim', async (firstPool, secondPool) => {
    await migrateDatabase({ pool: firstPool });
    const first = new PostgresExecutionIntentRepository(firstPool);
    const second = new PostgresExecutionIntentRepository(secondPool);
    const now = await databaseNowMs(firstPool);
    const draft = executionDraft('postgres-started-reclaim', {
      requestedAtMs: now - 1_000, expiresAtMs: now + 120_000,
    });
    await first.create(draft);
    const initial = required(await first.claim({
      ownerId: 'attempt-worker-a', leaseMs: 60_000, purpose: 'EXECUTE',
    }));
    const processing = await first.transition(initial, transitionInput(initial, 'PROCESSING'));
    const active = Object.freeze({ ...initial, intent: processing });
    const started = await first.beginAttempt(active);

    await firstPool.query(`UPDATE execution_intents
      SET lease_expires_at=date_trunc('milliseconds', statement_timestamp())
      WHERE id=$1`, [draft.id]);
    await expectCode(first.beginAttempt(active), 'INTENT_LEASE_LOST');
    const reclaimed = required(await second.claim({
      ownerId: 'attempt-worker-b', leaseMs: 60_000, purpose: 'EXECUTE',
    }));
    assert.notEqual(reclaimed.leaseToken, initial.leaseToken);
    assert.deepEqual((await second.beginAttempt(reclaimed)).attempt, started.attempt);

    const counts = await firstPool.query(`SELECT intent.attempt_count,
      COUNT(attempt.*)::INTEGER AS attempts
      FROM execution_intents AS intent
      LEFT JOIN execution_attempts AS attempt ON attempt.intent_id=intent.id
      WHERE intent.id=$1 GROUP BY intent.attempt_count`, [draft.id]);
    assert.deepEqual(counts.rows, [{ attempt_count: 1, attempts: 1 }]);
    const transitionCount = await firstPool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_intent_transitions WHERE intent_id=$1`, [draft.id]);
    assert.deepEqual(transitionCount.rows, [{ count: 1 }]);
  });
});

void test('real PostgreSQL covers reclaim and pre-submission expiry near database-time boundaries', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: reclaim boundary integration skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'execution_intent_boundaries', async (firstPool, secondPool) => {
    await migrateDatabase({ pool: firstPool });
    const first = new PostgresExecutionIntentRepository(firstPool);
    const second = new PostgresExecutionIntentRepository(secondPool);
    const now = await databaseNowMs(firstPool);
    const liveTimes = { requestedAtMs: now - 1_000, expiresAtMs: now + 120_000 } as const;

    const boundaryReclaimDraft = executionDraft('postgres-boundary-reclaim', liveTimes);
    await first.create(boundaryReclaimDraft);
    const boundaryOriginal = required(await first.claim({
      ownerId: 'exact-owner-a', leaseMs: 60_000, purpose: 'EXECUTE',
    }));
    await firstPool.query(`UPDATE execution_intents
      SET lease_expires_at=date_trunc('milliseconds', statement_timestamp())
      WHERE id=$1`, [boundaryReclaimDraft.id]);
    const boundaryReclaimed = required(await second.claim({
      ownerId: 'exact-owner-b', leaseMs: 60_000, purpose: 'EXECUTE',
    }));
    assert.equal(boundaryReclaimed.intent.id, boundaryReclaimDraft.id);
    assert.notEqual(boundaryReclaimed.leaseToken, boundaryOriginal.leaseToken);
    const reclaimJournal = await firstPool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_intent_transitions WHERE intent_id=$1`, [boundaryReclaimDraft.id]);
    assert.deepEqual(reclaimJournal.rows, [{ count: 0 }]);

    const freshReclaimDraft = executionDraft('postgres-fresh-reclaim', liveTimes);
    await first.create(freshReclaimDraft);
    const freshClaim = required(await first.claim({
      ownerId: 'fresh-owner', leaseMs: 60_000, purpose: 'EXECUTE',
    }));
    assert.equal(freshClaim.intent.id, freshReclaimDraft.id);
    assert.equal(await second.claim({
      ownerId: 'fresh-contender', leaseMs: 60_000, purpose: 'EXECUTE',
    }), null);

    const expiredFreshDraft = executionDraft('postgres-expired-fresh', liveTimes);
    await first.create(expiredFreshDraft);
    const expiredFreshClaim = required(await first.claim({
      ownerId: 'expired-fresh-owner', leaseMs: 60_000, purpose: 'EXECUTE',
    }));
    assert.equal(expiredFreshClaim.intent.id, expiredFreshDraft.id);
    await firstPool.query(`UPDATE execution_intents
      SET expires_at=requested_at + INTERVAL '1 millisecond'
      WHERE id=$1`, [expiredFreshDraft.id]);

    const expiredLeaseDraft = executionDraft('postgres-expired-lease', liveTimes);
    await first.create(expiredLeaseDraft);
    const expiredLeaseClaim = required(await first.claim({
      ownerId: 'expired-lease-owner', leaseMs: 60_000, purpose: 'EXECUTE',
    }));
    assert.equal(expiredLeaseClaim.intent.id, expiredLeaseDraft.id);
    await firstPool.query(`UPDATE execution_intents
      SET expires_at=requested_at + INTERVAL '1 millisecond',
        lease_expires_at=date_trunc('milliseconds', statement_timestamp())
      WHERE id=$1`, [expiredLeaseDraft.id]);

    const liveUnleasedDraft = executionDraft('postgres-live-unleased', liveTimes);
    await first.create(liveUnleasedDraft);
    const expiredAbsentDraft = executionDraft('postgres-expired-absent', {
      requestedAtMs: 0, expiresAtMs: 1,
    });
    await first.create(expiredAbsentDraft);

    assert.equal(await first.expirePreSubmission(10), 2);
    const liveUnleased = required(await first.read(liveUnleasedDraft.id));
    const expiredFresh = required(await first.read(expiredFreshDraft.id));
    assert.equal(liveUnleased.status, 'PENDING');
    assert.equal(liveUnleased.terminalAtMs, null);
    assert.equal(expiredFresh.status, 'PENDING');
    assert.equal(expiredFresh.terminalAtMs, null);

    const expiredAbsent = required(await first.read(expiredAbsentDraft.id));
    const expiredLease = required(await first.read(expiredLeaseDraft.id));
    for (const expired of [expiredAbsent, expiredLease]) {
      assert.equal(expired.status, 'EXPIRED');
      assert.equal(expired.reconciliationCompletedAtMs, expired.terminalAtMs);
      assert.equal(required(expired.purgeAfterMs) - required(expired.terminalAtMs), 14_400_000);
    }
    const boundaryJournal = await firstPool.query(`SELECT intent_id,previous_status,
      next_status,reason_code FROM execution_intent_transitions
      WHERE intent_id IN ($1,$2) ORDER BY intent_id`, [expiredAbsentDraft.id, expiredLeaseDraft.id]);
    assert.deepEqual(boundaryJournal.rows, [expiredAbsentDraft.id, expiredLeaseDraft.id]
      .sort()
      .map((intentId) => ({
        intent_id: intentId, previous_status: 'PENDING', next_status: 'EXPIRED',
        reason_code: 'INTENT_EXPIRED',
      })));
    const unchangedJournal = await firstPool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_intent_transitions WHERE intent_id IN ($1,$2)`, [
      liveUnleasedDraft.id, expiredFreshDraft.id,
    ]);
    assert.deepEqual(unchangedJournal.rows, [{ count: 0 }]);
  });
});

function executionDraft(
  logicalCommandId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): ExecutionIntentDraftV1 {
  return createExecutionIntentDraft({
    strategyId: 'execution-intent-repository', strategyVersion: 1,
    positionId: `position-${logicalCommandId}`, logicalCommandId,
    mint: '11111111111111111111111111111111', side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112', quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9, quoteAmountRaw: 1n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: `event-${logicalCommandId}`, decisionFingerprint: 'a'.repeat(64),
    requestedAtMs: NOW_MS - 1_000, expiresAtMs: NOW_MS + 60_000,
    ...overrides,
  });
}

async function seedLiveExecuteBuyTarget(
  pool: InstanceType<typeof pg.Pool>,
  intent: ExecutionIntentDraftV1,
): Promise<void> {
  const client = await pool.connect();
  const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
  const qualificationId = `execution_safety_qualification_${'b'.repeat(64)}`;
  const reportId = `execution_risk_admission_${'e'.repeat(64)}`;
  const reservationId = `execution_exposure_reservation_${'f'.repeat(64)}`;
  const now = "date_trunc('milliseconds',statement_timestamp())";
  try {
    // The armament itself is tested by its own guarded write suite. This fixture
    // isolates the repository claim predicate from that upstream construction path.
    await client.query('SET session_replication_role=replica');
    await client.query(`INSERT INTO execution_wallet_generations (
      generation_id,wallet_public_key,cluster,genesis_hash,generation
    ) VALUES ($1,'11111111111111111111111111111111','mainnet-beta',
      '11111111111111111111111111111111',1)`, [generationId]);
    await client.query(`INSERT INTO execution_safety_qualifications (
      qualification_id,evaluator_version,qualification_fingerprint,phase,build_hash,
      configuration_fingerprint,strategy_fingerprint,generation_id,wallet_public_key,cluster,
      genesis_hash,provider_id,qualified_at,expires_at,purge_after
    ) VALUES ($1,1,'${'1'.repeat(64)}','CANARY','${'2'.repeat(64)}','${'3'.repeat(64)}',
      '${'4'.repeat(64)}',$2,'11111111111111111111111111111111','mainnet-beta',
      '11111111111111111111111111111111','provider',${now},${now}+INTERVAL '5 minutes',
      ${now}+INTERVAL '4 hours 5 minutes')`, [qualificationId, generationId]);
    await client.query(`INSERT INTO execution_provider_usage_snapshots (
      snapshot_id,snapshot_fingerprint,provider_id,plan_id,billing_period_id,
      billing_period_started_at,billing_period_ends_at,limit_units,used_units,measured_at,
      expires_at,provenance
    ) VALUES ('execution_provider_usage_${'b'.repeat(64)}','${'d'.repeat(64)}','provider',
      'plan','period',${now}-INTERVAL '1 minute',${now}+INTERVAL '10 minutes',100,0,
      ${now}-INTERVAL '1 second',${now}+INTERVAL '5 minutes','OPERATOR_REPORT')`);
    await client.query(`INSERT INTO execution_risk_admission_reports (
      report_id,report_fingerprint,input_fingerprint,intent_id,generation_id,policy_fingerprint,
      wallet_snapshot_fingerprint,provider_snapshot_fingerprint,decision,quote_amount_raw,
      projected_capital_raw,projected_exposure_raw,projected_drawdown_raw,quota_state,
      wallet_state_revision
    ) VALUES ($1,'${'9'.repeat(64)}','${'a'.repeat(64)}',$2,$3,'${'b'.repeat(64)}',
      '${'c'.repeat(64)}','${'d'.repeat(64)}','ADMITTED',$4,1,1,0,'NORMAL',0)`, [
      reportId, intent.id, generationId, intent.quoteAmountRaw?.toString(),
    ]);
    await client.query(`INSERT INTO execution_exposure_reservations (
      reservation_id,intent_id,generation_id,admission_report_id,position_id,side,mint,quote_mint,
      maximum_amount_raw,intent_fingerprint,policy_fingerprint,wallet_snapshot_fingerprint,
      provider_snapshot_fingerprint,state
    ) VALUES ($1,$2,$3,$4,$5,'BUY',$6,$7,$8,'${'e'.repeat(64)}','${'b'.repeat(64)}',
      '${'c'.repeat(64)}','${'d'.repeat(64)}','RESERVED')`, [
      reservationId, intent.id, generationId, reportId, intent.positionId, intent.mint,
      intent.quoteMint, intent.quoteAmountRaw?.toString(),
    ]);
    await client.query(`INSERT INTO execution_activation_armaments (
      armament_id,payload_version,armament_fingerprint,qualification_id,qualification_fingerprint,
      generation_id,authorization_id,state,phase,build_hash,configuration_fingerprint,
      strategy_fingerprint,wallet_public_key,cluster,genesis_hash,provider_id,maximum_buys,
      maximum_capital_lamports,maximum_exposure_bps,maximum_open_positions,maximum_holding_ms,
      operator_id,operator_reason,armed_at,expires_at,armament_request_fingerprint,
      canary_evidence_fingerprint,target_intent_id,target_intent_state_revision,target_strategy_id,
      target_strategy_version,target_decision_fingerprint,target_mint,target_quote_mint,
      target_quote_amount_raw,target_admission_report_id,target_reservation_id,target_policy_fingerprint,
      target_wallet_snapshot_fingerprint,target_provider_snapshot_fingerprint,runtime_quote_max_age_ms,
      runtime_slippage_bps,runtime_snapshot_max_slot_lag,runtime_max_compute_units,
      runtime_max_fee_lamports,runtime_max_fee_payer_lamport_debit,runtime_max_rpc_calls_per_attempt,
      runtime_lease_ms
    ) VALUES (
      'execution_activation_armament_${'0'.repeat(64)}',2,'${'1'.repeat(64)}',$1,'${'1'.repeat(64)}',
      $2,'execution_operator_authorization_${'c'.repeat(64)}','ARMED','CANARY','${'2'.repeat(64)}',
      '${'3'.repeat(64)}','${'4'.repeat(64)}','11111111111111111111111111111111','mainnet-beta',
      '11111111111111111111111111111111','provider',1,$7,500,1,30000,'operator','reason',${now},
      ${now}+INTERVAL '4 minutes','${'6'.repeat(64)}','${'7'.repeat(64)}',$3,0,$4,$5,$6,$8,$9,$7,
      $10,$11,'${'b'.repeat(64)}','${'c'.repeat(64)}','${'d'.repeat(64)}',60000,0,128,1400000,
      10000000,10000000000,12,3000
    )`, [
      qualificationId, generationId, intent.id, intent.strategyId, intent.strategyVersion,
      intent.decisionFingerprint, intent.quoteAmountRaw?.toString(), intent.mint, intent.quoteMint,
      reportId, reservationId,
    ]);
  } finally {
    try { await client.query('SET session_replication_role=origin'); } finally { client.release(); }
  }
}

type Row = Record<string, unknown>;

function intentRow(
  draft: ExecutionIntentDraftV1,
  overrides: Readonly<Record<string, unknown>> = {},
): Row {
  const rowStatus = (overrides.status ?? 'PENDING') as ExecutionIntentStatus;
  return {
    id: draft.id,
    payload_version: draft.payloadVersion,
    logical_order_key: draft.logicalOrderKey,
    strategy_id: draft.strategyId,
    strategy_version: draft.strategyVersion,
    position_id: draft.positionId,
    logical_command_id: draft.logicalCommandId,
    mint: draft.mint,
    side: draft.side,
    venue_policy: draft.venuePolicy,
    quote_mint: draft.quoteMint,
    quote_token_program: draft.quoteTokenProgram,
    quote_decimals: draft.quoteDecimals,
    quote_amount_raw: draft.quoteAmountRaw?.toString() ?? null,
    base_amount_raw: draft.baseAmountRaw?.toString() ?? null,
    minimum_amount_out_raw: draft.minimumAmountOutRaw.toString(),
    decision_event_id: draft.decisionEventId,
    decision_fingerprint: draft.decisionFingerprint,
    requested_at_ms: String(draft.requestedAtMs),
    expires_at_ms: String(draft.expiresAtMs),
    status: rowStatus,
    attempt_count: 0,
    state_revision: '0',
    last_reason_code: reasonForStatus(rowStatus),
    terminal_at_ms: null,
    reconciliation_completed_at_ms: null,
    purge_after_ms: null,
    created_at_ms: String(NOW_MS),
    updated_at_ms: String(NOW_MS),
    lease_owner: null,
    lease_token: null,
    lease_expires_at_ms: null,
    ...overrides,
  };
}

function claimRow(
  draft: ExecutionIntentDraftV1,
  status: ExecutionIntentStatus,
  attemptCount = status === 'PENDING' ? 0 : 1,
): Row {
  return {
    ...intentRow(draft, { status, attempt_count: attemptCount }),
    lease_owner: 'worker-1', lease_token: UUID, lease_expires_at_ms: String(NOW_MS + 30_000),
  };
}

function claimedIntent(
  draft: ExecutionIntentDraftV1,
  status: ExecutionIntentStatus,
  attemptCount = status === 'PENDING' ? 0 : 1,
  stateRevision = 0n,
): ClaimedExecutionIntent {
  const intent = Object.freeze({
    ...draft, status, attemptCount, stateRevision, lastReasonCode: reasonForStatus(status), terminalAtMs: null,
    reconciliationCompletedAtMs: null, purgeAfterMs: null,
    createdAtMs: NOW_MS, updatedAtMs: NOW_MS,
  } satisfies ExecutionIntentV1);
  return Object.freeze({
    intent, leaseOwner: 'worker-1', leaseToken: UUID, leaseExpiresAtMs: NOW_MS + 30_000,
  });
}

function ledgerRow(
  attemptCount: number,
  latestStatus: 'STARTED' | 'COMPLETED' | 'ABANDONED' | null = null,
  overrides: Readonly<Record<string, unknown>> = {},
): Row {
  const terminal = latestStatus === 'COMPLETED' || latestStatus === 'ABANDONED';
  return {
    fenced_count: 1,
    attempt_count: attemptCount,
    max_attempt_number: attemptCount,
    started_count: latestStatus === 'STARTED' ? 1 : 0,
    latest_attempt_number: attemptCount === 0 ? null : attemptCount,
    latest_status: latestStatus,
    latest_effective_venue: null,
    latest_provider_id: null,
    latest_started_at_ms: attemptCount === 0 ? null : String(NOW_MS + 2),
    latest_completed_at_ms: terminal ? String(NOW_MS + 3) : null,
    latest_reason_code: latestStatus === 'COMPLETED'
      ? 'ATTEMPT_COMPLETED'
      : latestStatus === 'ABANDONED' ? 'QUOTE_STALE' : null,
    ...overrides,
  };
}

function transitionInput(
  claim: ClaimedExecutionIntent,
  nextStatus: ExecutionIntentStatus,
  attemptNumber: number | null = null,
): ExecutionIntentTransitionInput {
  return Object.freeze({
    intentId: claim.intent.id,
    expectedStatus: claim.intent.status,
    nextStatus,
    leaseToken: claim.leaseToken,
    reasonCode: reasonForStatus(nextStatus) ?? 'QUOTE_STALE',
    humanMessage: 'claimed for processing',
    activationPhase: 'NONE',
    evidence: Object.freeze({
      payloadVersion: 1, attemptNumber, sourceEventId: null,
      observedAtMs: claim.intent.updatedAtMs,
    }),
  });
}

function reasonForStatus(status: ExecutionIntentStatus): ExecutionIntentV1['lastReasonCode'] {
  const reasons: Readonly<Partial<Record<ExecutionIntentStatus, ExecutionIntentV1['lastReasonCode']>>> = {
    PROCESSING: 'EXECUTION_STARTED',
    SIMULATED: 'SIMULATION_SUCCEEDED',
    RETRY_READY: 'RECONCILIATION_PROVED_NO_EFFECT',
    SIGNED_NOT_SUBMITTED: 'SIGNATURE_PERSISTED',
    SUBMITTED: 'SUBMISSION_ACCEPTED',
    CONFIRMED: 'CONFIRMATION_OBSERVED',
    RECONCILING: 'RECONCILIATION_STARTED',
    SUCCEEDED: 'INTENT_SUCCEEDED',
    FAILED: 'QUOTE_STALE',
    EXPIRED: 'INTENT_EXPIRED',
    CANCELLED: 'INTENT_CANCELLED',
    UNKNOWN_REQUIRES_RECONCILIATION: 'RECONCILIATION_REQUIRED',
  };
  return reasons[status] ?? null;
}

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

interface QueryResult {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

type Step = QueryResult | ((text: string, values: readonly unknown[] | undefined) => QueryResult);

class ScriptedClient {
  public readonly calls: QueryCall[] = [];
  public released = false;
  public releaseAttempts = 0;
  public readonly releaseErrors: (boolean | undefined)[] = [];

  public constructor(
    private readonly steps: Step[],
    private readonly onRelease?: () => void,
  ) {}

  public async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
    this.calls.push({ text, values });
    const step = this.steps.shift();
    if (step === undefined) throw new Error(`Unexpected query: ${text}`);
    return typeof step === 'function' ? step(text, values) : step;
  }

  public release(error?: boolean): void {
    this.releaseAttempts += 1;
    this.releaseErrors.push(error);
    this.released = true;
    this.onRelease?.();
  }
}

class ScriptedPool implements ExecutionIntentPool {
  public connectCount = 0;

  public constructor(private readonly client: ScriptedClient) {}

  public async connect(): Promise<ScriptedClient> {
    this.connectCount += 1;
    return this.client;
  }
}

function deferred<TValue>(): Readonly<{
  promise: Promise<TValue>;
  resolve: (value: TValue) => void;
  reject: (reason?: unknown) => void;
}> {
  let resolve!: (value: TValue) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<TValue>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function result(rows: readonly Row[], rowCount: number | null): QueryResult {
  return { rows, rowCount };
}

function command(
  expected: 'BEGIN' | 'BEGIN ISOLATION LEVEL READ COMMITTED' | 'COMMIT' | 'ROLLBACK',
): Step {
  return (text) => {
    assert.equal(text, expected);
    return result([], null);
  };
}

function normalizedCommand(text: string): string {
  const commandName = required(text.trim().split(/\s+/u)[0]).toUpperCase();
  if (commandName !== 'WITH') return commandName;
  if (/\bUPDATE\b/u.test(text)) return 'UPDATE';
  if (/\bINSERT\b/u.test(text)) return 'INSERT';
  if (/\bSELECT\b/u.test(text)) return 'SELECT';
  return commandName;
}

async function expectCode(
  promise: Promise<unknown>,
  code: ExecutionIntentRepositoryError['code'],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ExecutionIntentRepositoryError);
    assert.equal(error.code, code);
    assert.equal(error.message, 'Execution intent repository operation failed.');
    assert.doesNotMatch(errorTree(error), /password|secret|postgres|query|logicalCommandId/iu);
    return true;
  });
}

function assertRedacted(calls: readonly QueryCall[]): void {
  assert.ok(calls.length > 0);
}

function errorTree(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  const nested = cause instanceof AggregateError
    ? [...cause.errors].map((value) => errorTree(value)).join(' ')
    : cause === undefined ? '' : errorTree(cause);
  return `${error.name} ${error.message} ${nested}`;
}

function required<TValue>(value: TValue | null | undefined): TValue {
  if (value === null || value === undefined) assert.fail('Expected a value.');
  return value;
}

async function databaseNowMs(pool: InstanceType<typeof pg.Pool>): Promise<number> {
  const result = await pool.query<{ readonly now_ms: string }>(
    "SELECT trunc(EXTRACT(EPOCH FROM statement_timestamp()) * 1000)::TEXT AS now_ms",
  );
  return Number(required(result.rows[0]).now_ms);
}

async function waitForDatabaseQuery(
  pool: InstanceType<typeof pg.Pool>,
  pattern: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query(`SELECT 1 FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND state='active' AND wait_event IS NOT NULL
        AND query ILIKE $1 LIMIT 1`, [pattern]);
    if (result.rowCount === 1) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for blocked PostgreSQL query matching ${pattern}.`);
}

async function withTemporarySchema(
  databaseUrl: string,
  prefix: string,
  callback: (
    firstPool: InstanceType<typeof pg.Pool>,
    secondPool: InstanceType<typeof pg.Pool>,
  ) => Promise<void>,
): Promise<void> {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const configuration = {
    connectionString: databaseUrl,
    max: 2,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  } as const;
  const firstPool = new pg.Pool(configuration);
  const secondPool = new pg.Pool(configuration);
  let schemaCreated = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    schemaCreated = true;
    await callback(firstPool, secondPool);
  } finally {
    try {
      await Promise.all([firstPool.end(), secondPool.end()]);
    } finally {
      try {
        if (schemaCreated) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}
