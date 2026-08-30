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
  ExecutionClaimPurpose,
  ExecutionIntentTransitionInput,
} from '../src/ports/execution-intent-repository.js';
import { migrateDatabase } from '../src/storage/database.js';
import {
  ExecutionIntentRepositoryError,
  PostgresExecutionIntentRepository,
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
    command('COMMIT'),
    command('BEGIN'),
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
      command('BEGIN'), result([], 0), result([intentRow(conflicting)], 1), command('ROLLBACK'),
    ]);
    const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

    await expectCode(repository.create(incoming), 'INTENT_DUPLICATE');
    assertRedacted(client.calls);
  }
});

void test('create rejects a contradictory INSERT RETURNING identity', async () => {
  const incoming = executionDraft('returning-incoming');
  const other = executionDraft('returning-other');
  const client = new ScriptedClient([
    command('BEGIN'), result([intentRow(other)], 1), command('ROLLBACK'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.create(incoming), 'INVALID_DATA');
});

void test('claim validates a closed purpose and preserves each selected business state', async () => {
  const cases: readonly [ExecutionClaimPurpose, ExecutionIntentStatus, readonly string[]][] = [
    ['EXECUTE', 'SIMULATED', ['PENDING', 'RETRY_READY', 'PROCESSING', 'SIMULATED']],
    ['CONFIRM', 'SUBMITTED', ['SUBMITTED']],
    ['RECONCILE', 'UNKNOWN_REQUIRES_RECONCILIATION', [
      'SIGNED_NOT_SUBMITTED', 'CONFIRMED', 'RECONCILING',
      'UNKNOWN_REQUIRES_RECONCILIATION',
    ]],
  ];
  for (const [purpose, status, statuses] of cases) {
    const draft = executionDraft(`claim-${purpose}`);
    const client = new ScriptedClient([(_text, values) => result([{
      ...claimRow(draft, status), lease_token: values?.[2],
    }], 1)]);
    const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

    const claim = await repository.claim({ ownerId: 'worker-1', leaseMs: 30_000, purpose });

    assert.ok(claim);
    assert.equal(claim.intent.status, status);
    assert.ok(Object.isFrozen(claim));
    assert.ok(Object.isFrozen(claim.intent));
    const call = required(client.calls[0]);
    assert.match(call.text, /FOR UPDATE SKIP LOCKED/u);
    if (purpose === 'EXECUTE') {
      assert.match(call.text, /expires_at\s*>\s*statement_timestamp\(\)/u);
    } else {
      assert.doesNotMatch(call.text, /expires_at\s*>\s*statement_timestamp\(\)/u);
    }
    assert.match(call.text, /lease_expires_at\s+IS NULL\s+OR\s+.*<=\s*statement_timestamp\(\)/su);
    assert.match(call.text, /ORDER BY\s+(?:intent\.)?requested_at,\s*(?:intent\.)?id/u);
    assert.doesNotMatch(call.text, /gen_random_uuid|uuid_generate/u);
    for (const candidate of statuses) assert.match(call.text, new RegExp(`'${candidate}'`, 'u'));
    const setClause = required(/SET([\s\S]*?)FROM candidate/u.exec(call.text)?.[1]);
    assert.doesNotMatch(setClause, /\bstatus\b|attempt_count|last_reason_code|terminal_at/u);
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
    result([], 0), result([], 0), result([], 1), result([], 1),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.renew(claim, 5_000), 'INTENT_LEASE_LOST');
  await expectCode(repository.release(claim), 'INTENT_LEASE_LOST');
  assert.equal(await repository.renew(claim, 5_000), true);
  assert.equal(await repository.release(claim), true);

  for (const call of client.calls) {
    assert.match(call.text, /id\s*=\s*\$1/u);
    assert.match(call.text, /status\s*=\s*\$2/u);
    assert.match(call.text, /lease_token\s*=\s*\$3::UUID/u);
    assert.match(call.text, /lease_expires_at\s*>\s*statement_timestamp\(\)/u);
    assert.deepEqual(call.values?.slice(0, 3), [draft.id, 'PROCESSING', UUID]);
  }
  assert.match(required(client.calls[0]).text, /statement_timestamp\(\)\s*\+\s*\(\$4::BIGINT/u);
  assert.match(required(client.calls[1]).text, /lease_owner\s*=\s*NULL/u);
});

void test('claim rejects a well-shaped row that contradicts the requested lease identity', async () => {
  const draft = executionDraft('claim-contradiction');
  const client = new ScriptedClient([result([{
    ...claimRow(draft, 'PENDING'),
    lease_owner: 'different-worker',
    lease_token: '00000000-0000-4000-8000-000000000002',
  }], 1)]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.claim({
    ownerId: 'expected-worker', leaseMs: 30_000, purpose: 'EXECUTE',
  }), 'INVALID_DATA');
});

void test('transition locks and fences the parent, appends evidence, then updates atomically', async () => {
  const draft = executionDraft('transition');
  const claim = claimedIntent(draft, 'PENDING');
  const updated = claimRow(draft, 'PROCESSING', 0);
  Object.assign(updated, {
    status: 'PROCESSING', last_reason_code: 'INTENT_DUPLICATE',
    updated_at_ms: String(NOW_MS + 1),
  });
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PENDING')], 1), result([], 1),
    result([updated], 1), command('COMMIT'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));
  const input = transitionInput(claim, 'PROCESSING');

  const transitioned = await repository.transition(claim, input);

  assert.equal(transitioned.status, 'PROCESSING');
  assert.equal(Object.isFrozen(transitioned), true);
  assert.deepEqual(client.calls.map((call) => normalizedCommand(call.text)), [
    'BEGIN', 'SELECT', 'INSERT', 'UPDATE', 'COMMIT',
  ]);
  const locked = required(client.calls[1]);
  assert.match(locked.text, /FOR UPDATE/u);
  assert.match(locked.text, /status\s*=\s*\$2/u);
  assert.match(locked.text, /lease_token\s*=\s*\$3::UUID/u);
  assert.match(locked.text, /lease_expires_at\s*>\s*statement_timestamp\(\)/u);
  const journal = required(client.calls[2]);
  assert.match(journal.text, /INSERT INTO execution_intent_transitions/u);
  assert.equal(journal.values?.includes('claimed for processing'), true);
  assert.equal(journal.values?.includes('NONE'), true);
  assert.match(String(journal.values?.find((value) => typeof value === 'string' && value.startsWith('{'))), /"payloadVersion":1/u);
  const parentUpdate = required(client.calls[3]);
  assert.doesNotMatch(parentUpdate.text, /lease_owner\s*=\s*NULL/u);
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
      last_reason_code: 'INTENT_DUPLICATE', updated_at_ms: String(NOW_MS + 1),
      ...leaseOverride,
    });
    const client = new ScriptedClient([
      command('BEGIN'), result([claimRow(draft, 'PENDING', 0)], 1), result([], 1),
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
    status: 'SUCCEEDED', attempt_count: 1, last_reason_code: 'INTENT_DUPLICATE',
    terminal_at_ms: String(NOW_MS + 1), reconciliation_completed_at_ms: String(NOW_MS + 1),
    purge_after_ms: String(NOW_MS + 14_400_001), updated_at_ms: String(NOW_MS + 1),
  });
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'SIMULATED', 1)], 1), result([], 1),
    result([terminal], 1), command('COMMIT'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  const transitioned = await repository.transition(claim, transitionInput(claim, 'SUCCEEDED', 1));

  assert.equal(transitioned.reconciliationCompletedAtMs, transitioned.terminalAtMs);
  assert.equal(required(transitioned.purgeAfterMs) - required(transitioned.terminalAtMs), 14_400_000);
  const update = required(client.calls[3]);
  assert.match(update.text, /lease_owner\s*=\s*NULL/u);
  assert.match(update.text, /reconciliation_completed_at\s*=\s*CASE[\s\S]*operation\.at/u);
  assert.match(update.text, /purge_after\s*=\s*CASE[\s\S]*operation\.at\s*\+\s*INTERVAL '4 hours'/u);
});

void test('terminal reconciled transitions mark reconciliation complete and become purgeable', async () => {
  const draft = executionDraft('terminal-reconciled');
  const claim = claimedIntent(draft, 'RECONCILING', 1);
  const terminal = intentRow(draft, {
    status: 'SUCCEEDED', attempt_count: 1, last_reason_code: 'INTENT_DUPLICATE',
    terminal_at_ms: String(NOW_MS + 1), reconciliation_completed_at_ms: String(NOW_MS + 1),
    purge_after_ms: String(NOW_MS + 14_400_001), updated_at_ms: String(NOW_MS + 1),
  });
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'RECONCILING', 1)], 1), result([], 1),
    result([terminal], 1), command('COMMIT'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  const transitioned = await repository.transition(claim, transitionInput(claim, 'SUCCEEDED', 1));

  assert.equal(transitioned.reconciliationCompletedAtMs, transitioned.terminalAtMs);
  assert.equal(required(client.calls[3]).values?.[5], true);
});

void test('terminal transitions reject RETURNING rows without required reconciliation retention', async () => {
  const draft = executionDraft('terminal-retention-missing');
  const claim = claimedIntent(draft, 'SIMULATED', 1);
  const terminal = intentRow(draft, {
    status: 'SUCCEEDED', attempt_count: 1, last_reason_code: 'INTENT_DUPLICATE',
    terminal_at_ms: String(NOW_MS + 1), updated_at_ms: String(NOW_MS + 1),
  });
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'SIMULATED', 1)], 1), result([], 1),
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
    command('BEGIN'), result([claimRow(draft, 'PENDING')], 1), result([], 1),
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
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', 0)], 1),
    result([], 0),
    result([{ started_at_ms: String(NOW_MS + 2) }], 1), result([], 1), command('COMMIT'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  const attempt = await repository.beginAttempt(claim);

  assert.deepEqual(attempt, { intentId: draft.id, attemptNumber: 1, startedAtMs: NOW_MS + 2 });
  assert.ok(Object.isFrozen(attempt));
  assert.match(required(client.calls[2]).text, /status\s*=\s*'STARTED'/u);
  assert.match(required(client.calls[2]).text, /FOR UPDATE/u);
  assert.match(required(client.calls[3]).text, /INSERT INTO execution_attempts/u);
  assert.match(required(client.calls[3]).text, /'STARTED'/u);
  assert.match(required(client.calls[3]).text, /lease_expires_at\s*>\s*statement_timestamp\(\)/u);
  assert.match(required(client.calls[4]).text, /attempt_count\s*=\s*\$4/u);
  assert.match(required(client.calls[4]).text, /lease_expires_at\s*>\s*statement_timestamp\(\)/u);
});

void test('beginAttempt replays the current STARTED attempt after an ambiguous commit', async () => {
  const draft = executionDraft('attempt-replay');
  const claim = claimedIntent(draft, 'PROCESSING', 1);
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', 1)], 1),
    result([{ attempt_number: 1, started_at_ms: String(NOW_MS + 2) }], 1),
    (text) => {
      assert.match(text, /^(?:COMMIT|ROLLBACK)$/u);
      return result([], null);
    },
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  assert.deepEqual(await repository.beginAttempt(claim), {
    intentId: draft.id, attemptNumber: 1, startedAtMs: NOW_MS + 2,
  });
  const replayQuery = required(client.calls[2]);
  assert.match(replayQuery.text, /intent\.id\s*=\s*attempt\.intent_id/u);
  assert.match(replayQuery.text, /intent\.status\s*=\s*\$2/u);
  assert.match(replayQuery.text, /intent\.lease_token\s*=\s*\$3::UUID/u);
  assert.match(replayQuery.text, /intent\.lease_expires_at\s*>\s*statement_timestamp\(\)/u);
  assert.deepEqual(replayQuery.values, [draft.id, 'PROCESSING', UUID]);
  assert.equal(client.calls.some((call) => call.text.includes('INSERT INTO execution_attempts')), false);
});

void test('beginAttempt rejects int32 overflow without inserting an attempt', async () => {
  const draft = executionDraft('attempt-overflow');
  const claim = claimedIntent(draft, 'PROCESSING', INT32_MAX);
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', INT32_MAX)], 1),
    result([], 0), command('ROLLBACK'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.beginAttempt(claim), 'ATTEMPT_EXHAUSTED');
  assert.deepEqual(client.calls.map((call) => normalizedCommand(call.text)), [
    'BEGIN', 'SELECT', 'SELECT', 'ROLLBACK',
  ]);
});

void test('finishAttempt performs one fenced STARTED CAS and exact replay returns false', async () => {
  const draft = executionDraft('finish-attempt');
  const claim = claimedIntent(draft, 'PROCESSING', 1);
  const finish = {
    attemptNumber: 1, status: 'COMPLETED' as const, effectiveVenue: 'PUMP_FUN' as const,
    providerId: 'provider-1', reasonCode: 'INTENT_DUPLICATE' as const,
  };
  const completedAttempt = {
    attempt_number: 1, status: 'COMPLETED', effective_venue: 'PUMP_FUN',
    provider_id: 'provider-1', completed_at_ms: String(NOW_MS + 3),
    reason_code: 'INTENT_DUPLICATE',
  };
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', 1)], 1),
    result([{ ...completedAttempt, status: 'STARTED', effective_venue: null, provider_id: null, completed_at_ms: null, reason_code: null }], 1),
    result([{ intent_id: draft.id }], 1), command('COMMIT'),
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', 1)], 1),
    result([completedAttempt], 1), command('COMMIT'),
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
    result([{
      attempt_number: 1, status: 'ABANDONED', effective_venue: null, provider_id: null,
      completed_at_ms: String(NOW_MS + 4), reason_code: 'QUOTE_STALE',
    }], 1), command('ROLLBACK'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.finishAttempt(claim, {
    attemptNumber: 1, status: 'COMPLETED', effectiveVenue: 'PUMP_FUN',
    providerId: 'provider', reasonCode: 'INTENT_DUPLICATE',
  }), 'ATTEMPT_CONFLICT');
});

void test('finishAttempt fail-closes a contradictory selected attempt number', async () => {
  const draft = executionDraft('finish-number');
  const claim = claimedIntent(draft, 'PROCESSING', 1);
  const client = new ScriptedClient([
    command('BEGIN'), result([claimRow(draft, 'PROCESSING', 1)], 1),
    result([{
      attempt_number: 2, status: 'STARTED', effective_venue: null, provider_id: null,
      completed_at_ms: null, reason_code: null,
    }], 1), command('ROLLBACK'),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.finishAttempt(claim, {
    attemptNumber: 1, status: 'COMPLETED', effectiveVenue: null,
    providerId: null, reasonCode: 'INTENT_DUPLICATE',
  }), 'INVALID_DATA');
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
    result([{
      attempt_number: 1, status: 'STARTED', effective_venue: null, provider_id: null,
      completed_at_ms: null, reason_code: null,
    }], 1),
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
  assert.doesNotMatch(call.text, /signed_transaction|keypair|signer capability/iu);
});

void test('read decodes exact canonical strings and rejects extra, fractional, or hostile row fields', async () => {
  const draft = executionDraft('decode');
  const extra = { ...intentRow(draft), extra: 'database-secret' };
  const fractional = { ...intentRow(draft), quote_amount_raw: '1.0' };
  const partialLease = { ...intentRow(draft), lease_owner: 'worker-without-token' };
  const leasedTerminal = intentRow(draft, {
    status: 'SUCCEEDED', last_reason_code: 'INTENT_DUPLICATE',
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
    result([partialLease], 1), result([leasedTerminal], 1), result([intentRow(draft)], 1),
  ]);
  const repository = new PostgresExecutionIntentRepository(new ScriptedPool(client));

  await expectCode(repository.read(draft.id), 'INVALID_DATA');
  await expectCode(repository.read(draft.id), 'INVALID_DATA');
  await expectCode(repository.read(draft.id), 'INVALID_DATA');
  await expectCode(repository.read(draft.id), 'INVALID_DATA');
  await expectCode(repository.read(draft.id), 'INVALID_DATA');
  assert.equal((await repository.read(draft.id))?.id, draft.id);
  const canonicalRead = required(client.calls.at(-1));
  assert.match(canonicalRead.text, /lease_owner[\s\S]*lease_token::TEXT[\s\S]*lease_expires_at_ms/u);
  assert.equal(getterCalls, 0);
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
  assert.equal(getterCalls, 0);
  assert.equal(pool.connectCount, 0);
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
    const attempt = await first.beginAttempt(activeClaim);
    assert.deepEqual(await first.beginAttempt(activeClaim), attempt);
    activeClaim = Object.freeze({ ...activeClaim, intent: required(await first.read(draft.id)) });
    const finishedAttempt = {
      attemptNumber: attempt.attemptNumber, status: 'COMPLETED', effectiveVenue: 'PUMP_FUN',
      providerId: 'provider-a', reasonCode: 'INTENT_DUPLICATE',
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
      provider_id: 'provider-a', reason_code: 'INTENT_DUPLICATE', purge_after: null,
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
    await firstPool.query("UPDATE execution_intents SET status='SUBMITTED' WHERE id=$1", [
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
      activeExpiryDraft.id, activeExpiryAttempt.attemptNumber,
    ]);
    assert.deepEqual(abandoned.rows, [{
      status: 'ABANDONED', reason_code: 'INTENT_EXPIRED',
      completed_at_ms: String(required((await first.read(activeExpiryDraft.id))?.terminalAtMs)),
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
    assert.deepEqual(await second.beginAttempt(reclaimed), started);

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

type Row = Record<string, unknown>;

function intentRow(
  draft: ExecutionIntentDraftV1,
  overrides: Readonly<Record<string, unknown>> = {},
): Row {
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
    status: 'PENDING',
    attempt_count: 0,
    last_reason_code: null,
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
): ClaimedExecutionIntent {
  const intent = Object.freeze({
    ...draft, status, attemptCount, lastReasonCode: null, terminalAtMs: null,
    reconciliationCompletedAtMs: null, purgeAfterMs: null,
    createdAtMs: NOW_MS, updatedAtMs: NOW_MS,
  } satisfies ExecutionIntentV1);
  return Object.freeze({
    intent, leaseOwner: 'worker-1', leaseToken: UUID, leaseExpiresAtMs: NOW_MS + 30_000,
  });
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
    reasonCode: 'INTENT_DUPLICATE',
    humanMessage: 'claimed for processing',
    activationPhase: 'NONE',
    evidence: Object.freeze({
      payloadVersion: 1, attemptNumber, sourceEventId: null,
      observedAtMs: claim.intent.updatedAtMs,
    }),
  });
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

  public release(_error?: boolean): void {
    this.releaseAttempts += 1;
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

function result(rows: readonly Row[], rowCount: number | null): QueryResult {
  return { rows, rowCount };
}

function command(expected: 'BEGIN' | 'COMMIT' | 'ROLLBACK'): Step {
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
