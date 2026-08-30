import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  createExecutionDryRunAssessment,
  type ExecutionDryRunAssessmentDraftV1,
} from '../src/domain/execution-dry-run.js';
import {
  createExecutionIntentDraft,
  type ExecutionIntentV1,
} from '../src/domain/execution-intent.js';
import type { ClaimedExecutionIntent } from '../src/ports/execution-intent-repository.js';
import { migrateDatabase } from '../src/storage/database.js';
import {
  ExecutionDryRunRepositoryError,
  PostgresExecutionDryRunRepository,
  type ExecutionDryRunPool,
} from '../src/storage/execution-dry-run.repository.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';

type Row = Readonly<Record<string, unknown>>;
type QueryResult = Readonly<{ rows: readonly Row[]; rowCount: number | null }>;
type Step = QueryResult | ((text: string, values?: readonly unknown[]) => QueryResult | Promise<QueryResult>);

const UUID = '00000000-0000-4000-8000-000000000001';
const NOW_MS = 1_788_000_000_000;

void test('complete validates and snapshots hostile inputs before connecting', async () => {
  const validClaim = claim('validation');
  const validAssessment = createExecutionDryRunAssessment(validClaim.intent);
  const pool = new ScriptedPool(new ScriptedClient([]));
  const repository = new PostgresExecutionDryRunRepository(pool);
  let getterCalls = 0;
  const accessor = { ...validClaim };
  Object.defineProperty(accessor, 'leaseOwner', {
    enumerable: true,
    get: () => { getterCalls += 1; return validClaim.leaseOwner; },
  });
  Object.freeze(accessor);
  let proxyTraps = 0;
  const proxy = new Proxy(validAssessment, {
    getPrototypeOf: () => { proxyTraps += 1; throw new Error('secret proxy'); },
  });

  for (const [candidateClaim, candidateAssessment] of [
    [{ ...validClaim }, validAssessment],
    [Object.freeze(accessor), validAssessment],
    [validClaim, proxy],
    [validClaim, Object.freeze({ ...validAssessment, intentStatus: 'PROCESSING' })],
    [validClaim, createExecutionDryRunAssessment(claim('other').intent)],
  ] as const) {
    await expectCode(repository.complete(
      candidateClaim as ClaimedExecutionIntent,
      candidateAssessment as ExecutionDryRunAssessmentDraftV1,
      activeSignal(),
    ), 'INVALID_INPUT');
  }
  await expectCode(repository.findExact(proxy, activeSignal()), 'INVALID_INPUT');
  assert.equal(pool.connectCount, 0);
  assert.equal(getterCalls, 0);
  assert.equal(proxyTraps, 0);
});

void test('complete dispatches exactly one autocommit CTE and fences every input field', async () => {
  const claimed = claim('sql');
  const assessment = createExecutionDryRunAssessment(claimed.intent);
  const client = new ScriptedClient([result([assessmentRow(assessment)], 1)]);
  const repository = new PostgresExecutionDryRunRepository(new ScriptedPool(client));

  const stored = await repository.complete(claimed, assessment, activeSignal());

  assert.deepEqual(stored, Object.freeze({ ...assessment, recordedAtMs: NOW_MS }));
  assert.ok(Object.isFrozen(stored));
  assert.equal(client.calls.length, 1);
  const call = required(client.calls[0]);
  assert.match(call.text, /^WITH operation AS MATERIALIZED\s*\(/u);
  assert.match(call.text, /\), locked AS MATERIALIZED\s*\([\s\S]*FOR UPDATE OF intent/u);
  assert.match(call.text, /\), inserted AS MATERIALIZED\s*\([\s\S]*INSERT INTO execution_dry_run_assessments/u);
  assert.match(call.text, /\), released AS MATERIALIZED\s*\([\s\S]*UPDATE execution_intents AS intent/u);
  assert.doesNotMatch(call.text, /\bBEGIN\b|\bCOMMIT\b|ON CONFLICT DO NOTHING/iu);
  assert.equal((call.text.match(/\bINSERT INTO\b/gu) ?? []).length, 1);
  assert.equal((call.text.match(/\bUPDATE execution_intents\b/gu) ?? []).length, 1);
  for (const column of [
    'id', 'payload_version', 'logical_order_key', 'strategy_id', 'strategy_version',
    'position_id', 'logical_command_id', 'mint', 'side', 'venue_policy', 'quote_mint',
    'quote_token_program', 'quote_decimals', 'quote_amount_raw', 'base_amount_raw',
    'minimum_amount_out_raw', 'decision_event_id', 'decision_fingerprint', 'requested_at',
    'expires_at', 'status', 'attempt_count', 'state_revision', 'last_reason_code',
    'lease_owner', 'lease_token', 'lease_expires_at',
  ]) assert.match(call.text, new RegExp(`intent\\.${column}`, 'u'));
  assert.match(call.text, /intent\.lease_expires_at\s*=\s*TIMESTAMPTZ 'epoch'\s*\+\s*\(\$\d+::BIGINT/u);
  assert.match(call.text, /intent\.lease_expires_at\s*>\s*operation\.at/u);
  assert.match(call.text, /intent\.expires_at\s*>\s*operation\.at/u);
  const releaseSet = required(/UPDATE execution_intents AS intent\s+SET([\s\S]*?)FROM locked/u.exec(call.text)?.[1]);
  assert.deepEqual(
    [...releaseSet.matchAll(/^\s*([a-z_]+)\s*=/gmu)].map((match) => required(match[1])).sort(),
    ['lease_expires_at', 'lease_owner', 'lease_token'],
  );
  assert.doesNotMatch(releaseSet, /status|attempt_count|state_revision|last_reason_code|updated_at/u);
  assert.match(call.text, /locked_count/u);
  assert.match(call.text, /inserted_count/u);
  assert.match(call.text, /released_count/u);
  assert.deepEqual(client.releaseErrors, [undefined]);
  assert.equal(call.values?.includes(claimed.intent.stateRevision.toString()), true);
  assert.equal(call.values?.includes(claimed.intent.quoteAmountRaw?.toString()), true);
  assert.equal(call.values?.includes(claimed.intent.requestedAtMs.toString()), true);
  assert.equal(call.values?.includes(claimed.leaseExpiresAtMs.toString()), true);
});

void test('complete classifies known cardinalities and treats post-ACK protocol data as ambiguous', async () => {
  const claimed = claim('cardinality');
  const assessment = createExecutionDryRunAssessment(claimed.intent);
  const cases = [
    [{ ...assessmentRow(assessment), locked_count: 0, inserted_count: 0, released_count: 0 }, 'INTENT_FENCE_LOST'],
    [{ ...assessmentRow(assessment), inserted_count: 0, released_count: 0 }, 'ASSESSMENT_CONFLICT'],
    [{ ...assessmentRow(assessment), released_count: 0 }, 'INTENT_FENCE_LOST'],
    [{ ...assessmentRow(assessment), locked_count: 2 }, 'COMMIT_OUTCOME_UNKNOWN'],
    [{ ...assessmentRow(assessment), result_fingerprint: 'f'.repeat(64) }, 'COMMIT_OUTCOME_UNKNOWN'],
    [{ ...assessmentRow(assessment), extra: 'hostile' }, 'COMMIT_OUTCOME_UNKNOWN'],
  ] as const;
  for (const [row, code] of cases) {
    const client = new ScriptedClient([result([row], 1)]);
    await expectCode(
      new PostgresExecutionDryRunRepository(new ScriptedPool(client)).complete(
        claimed, assessment, activeSignal(),
      ),
      code,
    );
    assert.deepEqual(client.releaseErrors, [true]);
  }
});

void test('complete distinguishes pre-dispatch database failure from ambiguous dispatch or release', async () => {
  const claimed = claim('failures');
  const assessment = createExecutionDryRunAssessment(claimed.intent);
  await expectCode(
    new PostgresExecutionDryRunRepository(new RejectingPool()).complete(
      claimed, assessment, activeSignal(),
    ),
    'DATABASE_FAILURE',
  );

  const queryFailure = new ScriptedClient([() => { throw new Error('postgresql://secret'); }]);
  await expectCode(
    new PostgresExecutionDryRunRepository(new ScriptedPool(queryFailure)).complete(
      claimed, assessment, activeSignal(),
    ),
    'COMMIT_OUTCOME_UNKNOWN',
  );
  assert.deepEqual(queryFailure.releaseErrors, [true]);

  const releaseFailure = new ScriptedClient(
    [result([assessmentRow(assessment)], 1)],
    () => { throw new Error('release secret'); },
  );
  await expectCode(
    new PostgresExecutionDryRunRepository(new ScriptedPool(releaseFailure)).complete(
      claimed, assessment, activeSignal(),
    ),
    'COMMIT_OUTCOME_UNKNOWN',
  );
  assert.deepEqual(releaseFailure.releaseErrors, [undefined, true]);
});

void test('complete fences cancellation before connect and after deferred connect without dispatching SQL', async () => {
  const claimed = claim('cancel-connect');
  const assessment = createExecutionDryRunAssessment(claimed.intent);
  const preAborted = new AbortController();
  preAborted.abort();
  const unusedPool = new ScriptedPool(new ScriptedClient([]));

  await expectCode(
    new PostgresExecutionDryRunRepository(unusedPool).complete(
      claimed, assessment, preAborted.signal,
    ),
    'OPERATION_ABORTED',
  );
  assert.equal(unusedPool.connectCount, 0);

  const controller = new AbortController();
  const connectGate = deferred<ScriptedClient>();
  let connectCount = 0;
  const pool: ExecutionDryRunPool = {
    connect: () => { connectCount += 1; return connectGate.promise; },
  };
  const client = new ScriptedClient([]);
  const pending = new PostgresExecutionDryRunRepository(pool).complete(
    claimed, assessment, controller.signal,
  );

  await Promise.resolve();
  assert.equal(connectCount, 1);
  controller.abort();
  connectGate.resolve(client);

  await expectCode(pending, 'OPERATION_ABORTED');
  assert.equal(client.calls.length, 0);
  assert.deepEqual(client.releaseErrors, [undefined]);
});

void test('complete never masks connect, dispatched query or cancellation cleanup failures', async () => {
  const claimed = claim('cancel-failures');
  const assessment = createExecutionDryRunAssessment(claimed.intent);

  const connectController = new AbortController();
  const connectGate = deferred<ScriptedClient>();
  const connectFailure = new PostgresExecutionDryRunRepository({
    connect: () => connectGate.promise,
  }).complete(claimed, assessment, connectController.signal);
  connectController.abort();
  connectGate.reject(new Error('connect secret'));
  await expectCode(connectFailure, 'DATABASE_FAILURE');

  const queryController = new AbortController();
  const queryFailure = new ScriptedClient([() => {
    queryController.abort();
    throw new Error('query secret');
  }]);
  await expectCode(
    new PostgresExecutionDryRunRepository(new ScriptedPool(queryFailure)).complete(
      claimed, assessment, queryController.signal,
    ),
    'COMMIT_OUTCOME_UNKNOWN',
  );
  assert.deepEqual(queryFailure.releaseErrors, [true]);

  const releaseController = new AbortController();
  const releaseGate = deferred<ScriptedClient>();
  const releaseFailure = new ScriptedClient([], () => { throw new Error('release secret'); });
  const cancelled = new PostgresExecutionDryRunRepository({
    connect: () => releaseGate.promise,
  }).complete(claimed, assessment, releaseController.signal);
  releaseController.abort();
  releaseGate.resolve(releaseFailure);
  await expectCode(cancelled, 'DATABASE_FAILURE');
  assert.equal(releaseFailure.calls.length, 0);
  assert.deepEqual(releaseFailure.releaseErrors, [undefined, true]);
});

void test('findExact performs one lease-free exact read, returns null, and rejects contradictions', async () => {
  const assessment = createExecutionDryRunAssessment(claim('find').intent);
  const exactClient = new ScriptedClient([result([assessmentRow(assessment, false)], 1)]);
  const exactRepository = new PostgresExecutionDryRunRepository(new ScriptedPool(exactClient));
  const found = await exactRepository.findExact(assessment, activeSignal());
  assert.deepEqual(found, Object.freeze({ ...assessment, recordedAtMs: NOW_MS }));
  const call = required(exactClient.calls[0]);
  assert.equal(exactClient.calls.length, 1);
  assert.match(call.text, /WHERE assessment\.assessment_id=\$1\s+OR\s+\(assessment\.intent_id=\$2\s+AND assessment\.evaluator_version=\$3\)/u);
  assert.doesNotMatch(call.text, /lease|FOR UPDATE|BEGIN|COMMIT/iu);
  assert.match(call.text, /intent_state_revision::TEXT AS intent_state_revision/u);
  assert.match(call.text, /EXTRACT\(EPOCH FROM assessment\.recorded_at\) \* 1000\)::TEXT AS recorded_at_ms/u);
  assert.deepEqual(call.values, [assessment.assessmentId, assessment.intentId, assessment.evaluatorVersion]);
  assert.deepEqual(exactClient.releaseErrors, [undefined]);

  const missing = new ScriptedClient([result([], 0)]);
  assert.equal(await new PostgresExecutionDryRunRepository(new ScriptedPool(missing)).findExact(assessment, activeSignal()), null);

  for (const row of [
    { ...assessmentRow(assessment, false), input_fingerprint: 'f'.repeat(64) },
    { ...assessmentRow(assessment, false), recorded_at_ms: '001' },
    { ...assessmentRow(assessment, false), payload_version: '1' },
  ]) {
    const contradictory = new ScriptedClient([result([row], 1)]);
    await expectCode(
      new PostgresExecutionDryRunRepository(new ScriptedPool(contradictory)).findExact(assessment, activeSignal()),
      'INVALID_DATA',
    );
    assert.deepEqual(contradictory.releaseErrors, [true]);
  }

  let getterCalls = 0;
  const accessor = assessmentRow(assessment, false) as Record<string, unknown>;
  Object.defineProperty(accessor, 'recorded_at_ms', {
    enumerable: true,
    get: () => { getterCalls += 1; return String(NOW_MS); },
  });
  Object.freeze(accessor);
  let proxyTraps = 0;
  const proxy = new Proxy(assessmentRow(assessment, false), {
    getPrototypeOf: () => { proxyTraps += 1; throw new Error('row proxy secret'); },
    ownKeys: () => { proxyTraps += 1; throw new Error('row proxy secret'); },
  });
  for (const hostile of [accessor, proxy]) {
    const client = new ScriptedClient([result([hostile], 1)]);
    await expectCode(
      new PostgresExecutionDryRunRepository(new ScriptedPool(client)).findExact(assessment, activeSignal()),
      'INVALID_DATA',
    );
    assert.deepEqual(client.releaseErrors, [true]);
  }
  assert.equal(getterCalls, 0);
  assert.equal(proxyTraps, 0);
});

void test('findExact rejects another assessment id under the expected logical identity', async () => {
  const assessment = createExecutionDryRunAssessment(claim('logical-conflict').intent);
  const conflicting = {
    ...assessmentRow(assessment, false),
    assessment_id: createExecutionDryRunAssessment(claim('other-assessment-id').intent).assessmentId,
  };
  const client = new ScriptedClient([logicalIdentityResult([conflicting])]);

  await expectCode(
    new PostgresExecutionDryRunRepository(new ScriptedPool(client)).findExact(assessment, activeSignal()),
    'INVALID_DATA',
  );
  assert.deepEqual(client.releaseErrors, [true]);
});

void test('findExact rejects the expected assessment id under another logical identity', async () => {
  const assessment = createExecutionDryRunAssessment(claim('assessment-id-conflict').intent);
  const other = createExecutionDryRunAssessment(claim('other-logical-identity').intent);
  const conflicting = {
    ...assessmentRow(other, false),
    assessment_id: assessment.assessmentId,
  };
  const client = new ScriptedClient([logicalIdentityResult([conflicting])]);

  await expectCode(
    new PostgresExecutionDryRunRepository(new ScriptedPool(client)).findExact(assessment, activeSignal()),
    'INVALID_DATA',
  );
  assert.deepEqual(client.releaseErrors, [true]);
});

void test('findExact rejects two rows that split the deterministic and logical identities', async () => {
  const assessment = createExecutionDryRunAssessment(claim('split-conflicts').intent);
  const other = createExecutionDryRunAssessment(claim('split-conflicts-other').intent);
  const logicalConflict = {
    ...assessmentRow(assessment, false), assessment_id: other.assessmentId,
  };
  const idConflict = {
    ...assessmentRow(other, false), assessment_id: assessment.assessmentId,
  };
  const client = new ScriptedClient([logicalIdentityResult([logicalConflict, idConflict])]);

  await expectCode(
    new PostgresExecutionDryRunRepository(new ScriptedPool(client)).findExact(assessment, activeSignal()),
    'INVALID_DATA',
  );
  assert.deepEqual(client.releaseErrors, [true]);
});

void test('findExact evicts on database and cleanup failures with fixed redacted errors', async () => {
  const assessment = createExecutionDryRunAssessment(claim('find-failure').intent);
  const queryFailure = new ScriptedClient([() => { throw new Error('query secret'); }]);
  await expectCode(
    new PostgresExecutionDryRunRepository(new ScriptedPool(queryFailure)).findExact(assessment, activeSignal()),
    'DATABASE_FAILURE',
  );
  assert.deepEqual(queryFailure.releaseErrors, [true]);
  const releaseFailure = new ScriptedClient(
    [result([assessmentRow(assessment, false)], 1)],
    () => { throw new Error('cleanup secret'); },
  );
  await expectCode(
    new PostgresExecutionDryRunRepository(new ScriptedPool(releaseFailure)).findExact(assessment, activeSignal()),
    'DATABASE_FAILURE',
  );
  assert.deepEqual(releaseFailure.releaseErrors, [undefined, true]);
});

void test('findExact cancellation fences connect without dispatching SQL', async () => {
  const assessment = createExecutionDryRunAssessment(claim('find-cancel-connect').intent);
  const preAborted = new AbortController();
  preAborted.abort();
  const unusedPool = new ScriptedPool(new ScriptedClient([]));

  await expectCode(
    new PostgresExecutionDryRunRepository(unusedPool).findExact(assessment, preAborted.signal),
    'OPERATION_ABORTED',
  );
  assert.equal(unusedPool.connectCount, 0);

  const controller = new AbortController();
  const connectGate = deferred<ScriptedClient>();
  let connectCount = 0;
  const pool: ExecutionDryRunPool = {
    connect: () => { connectCount += 1; return connectGate.promise; },
  };
  const client = new ScriptedClient([]);
  const pending = new PostgresExecutionDryRunRepository(pool).findExact(
    assessment,
    controller.signal,
  );

  await Promise.resolve();
  assert.equal(connectCount, 1);
  controller.abort();
  connectGate.resolve(client);

  await expectCode(pending, 'OPERATION_ABORTED');
  assert.equal(client.calls.length, 0);
  assert.deepEqual(client.releaseErrors, [undefined]);
});

void test('findExact never masks connect, dispatched query or cancellation cleanup failures', async (context) => {
  const assessment = createExecutionDryRunAssessment(claim('find-cancel-failures').intent);

  await context.test('connect rejection remains a database failure', async () => {
    const controller = new AbortController();
    const connectGate = deferred<ScriptedClient>();
    const pending = new PostgresExecutionDryRunRepository({
      connect: () => connectGate.promise,
    }).findExact(assessment, controller.signal);
    controller.abort();
    connectGate.reject(new Error('connect secret'));
    await expectCode(pending, 'DATABASE_FAILURE');
  });

  await context.test('abort cleanup failure remains a database failure without SQL', async () => {
    const controller = new AbortController();
    const connectGate = deferred<ScriptedClient>();
    const client = new ScriptedClient([], () => { throw new Error('release secret'); });
    const pending = new PostgresExecutionDryRunRepository({
      connect: () => connectGate.promise,
    }).findExact(assessment, controller.signal);
    controller.abort();
    connectGate.resolve(client);
    await expectCode(pending, 'DATABASE_FAILURE');
    assert.equal(client.calls.length, 0);
    assert.deepEqual(client.releaseErrors, [undefined, true]);
  });

  await context.test('dispatched query failure remains a database failure', async () => {
    const controller = new AbortController();
    const client = new ScriptedClient([() => {
      controller.abort();
      throw new Error('query secret');
    }]);
    await expectCode(
      new PostgresExecutionDryRunRepository(new ScriptedPool(client)).findExact(
        assessment,
        controller.signal,
      ),
      'DATABASE_FAILURE',
    );
    assert.deepEqual(client.releaseErrors, [true]);
  });

  await context.test('successful dispatched query returns its exact result', async () => {
    const controller = new AbortController();
    const client = new ScriptedClient([() => {
      controller.abort();
      return result([assessmentRow(assessment, false)], 1);
    }]);
    const found = await new PostgresExecutionDryRunRepository(new ScriptedPool(client)).findExact(
      assessment,
      controller.signal,
    );
    assert.deepEqual(found, Object.freeze({ ...assessment, recordedAtMs: NOW_MS }));
    assert.deepEqual(client.releaseErrors, [undefined]);
  });
});

void test('real PostgreSQL atomically records, releases only the lease, and leaves EXECUTE claimable', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'dry-run repository integration');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'dry_run_repository', async (pool) => {
    await migrateDatabase({ pool });
    const intents = new PostgresExecutionIntentRepository(pool);
    const assessments = new PostgresExecutionDryRunRepository(pool);
    const created = await intents.create(freshDraft('atomic'));
    const claimed = required(await intents.claim({ ownerId: 'worker-atomic', leaseMs: 30_000, purpose: 'DRY_RUN' }));
    const assessment = createExecutionDryRunAssessment(claimed.intent);
    const before = await parentSnapshot(pool, created.intent.id);

    const recorded = await assessments.complete(claimed, assessment, activeSignal());

    assert.deepEqual(await assessments.findExact(assessment, activeSignal()), recorded);
    const after = await parentSnapshot(pool, created.intent.id);
    assert.deepEqual(after.business, before.business);
    assert.deepEqual(after.lease, { lease_owner: null, lease_token: null, lease_expires_at: null });
    assert.equal((await pool.query('SELECT 1 FROM execution_attempts WHERE intent_id=$1', [created.intent.id])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM execution_intent_transitions WHERE intent_id=$1', [created.intent.id])).rowCount, 0);
    assert.equal(await intents.claim({ ownerId: 'worker-dry-again', leaseMs: 30_000, purpose: 'DRY_RUN' }), null);
    const execute = await intents.claim({ ownerId: 'worker-execute', leaseMs: 30_000, purpose: 'EXECUTE' });
    assert.ok(execute);
    assert.equal(execute.intent.id, created.intent.id);
  });
});

void test('real PostgreSQL fails closed on fence drift, ABA, lease loss, and business expiry', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'dry-run repository fencing integration');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'dry_run_fencing', async (pool) => {
    await migrateDatabase({ pool });
    const intents = new PostgresExecutionIntentRepository(pool);
    const assessments = new PostgresExecutionDryRunRepository(pool);
    const mutations = [
      "logical_command_id='mutated'",
      "status='RETRY_READY',last_reason_code='RECONCILIATION_PROVED_NO_EFFECT'",
      'state_revision=state_revision+2',
      "lease_owner='other-worker'",
      `lease_token='${randomUUID()}'::UUID`,
      "lease_expires_at=date_trunc('milliseconds',statement_timestamp())",
      "expires_at=date_trunc('milliseconds',statement_timestamp())",
    ];
    for (const [index, mutation] of mutations.entries()) {
      const created = await intents.create(freshDraft(`fence-${index}`));
      const claimed = required(await intents.claim({ ownerId: `worker-${index}`, leaseMs: 30_000, purpose: 'DRY_RUN' }));
      const assessment = createExecutionDryRunAssessment(claimed.intent);
      await pool.query(`UPDATE execution_intents SET ${mutation} WHERE id=$1`, [created.intent.id]);
      await expectCode(
        assessments.complete(claimed, assessment, activeSignal()),
        'INTENT_FENCE_LOST',
        `mutation ${index}: ${mutation}`,
      );
      assert.equal((await pool.query(
        'SELECT 1 FROM execution_dry_run_assessments WHERE intent_id=$1', [created.intent.id],
      )).rowCount, 0);
      await insertAssessment(pool, assessment);
    }
  });
});

void test('real PostgreSQL keeps a conflicting assessment and its lease fail-closed', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'dry-run repository conflict integration');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'dry_run_conflict', async (pool) => {
    await migrateDatabase({ pool });
    const intents = new PostgresExecutionIntentRepository(pool);
    const repository = new PostgresExecutionDryRunRepository(pool);
    const created = await intents.create(freshDraft('conflict'));
    const claimed = required(await intents.claim({ ownerId: 'conflict-worker', leaseMs: 30_000, purpose: 'DRY_RUN' }));
    const assessment = createExecutionDryRunAssessment(claimed.intent);
    await insertAssessment(pool, assessment, { inputFingerprint: 'f'.repeat(64) });

    await expectCode(
      repository.complete(claimed, assessment, activeSignal()), 'ASSESSMENT_CONFLICT',
    );
    await expectCode(repository.findExact(assessment, activeSignal()), 'INVALID_DATA');
    assert.equal((await pool.query(
      'SELECT lease_token::TEXT AS lease_token FROM execution_intents WHERE id=$1', [created.intent.id],
    )).rows[0]?.lease_token, claimed.leaseToken);
    assert.equal((await pool.query(
      'SELECT 1 FROM execution_dry_run_assessments WHERE intent_id=$1', [created.intent.id],
    )).rowCount, 1);
  });
});

void test('real PostgreSQL exposes deterministic and logical identity contradictions to findExact', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'dry-run exact identity conflict integration');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'dry_run_exact_conflict', async (pool) => {
    await migrateDatabase({ pool });
    const intents = new PostgresExecutionIntentRepository(pool);
    const repository = new PostgresExecutionDryRunRepository(pool);
    const expected = createExecutionDryRunAssessment(
      (await intents.create(freshDraft('exact-conflict-expected'))).intent,
    );
    const other = createExecutionDryRunAssessment(
      (await intents.create(freshDraft('exact-conflict-other'))).intent,
    );
    const logicalConflict = Object.freeze({ ...expected, assessmentId: other.assessmentId });
    const idConflict = Object.freeze({ ...other, assessmentId: expected.assessmentId });

    await insertAssessment(pool, logicalConflict);
    await expectCode(repository.findExact(expected, activeSignal()), 'INVALID_DATA');
    await pool.query('DELETE FROM execution_dry_run_assessments');

    await insertAssessment(pool, idConflict);
    await expectCode(repository.findExact(expected, activeSignal()), 'INVALID_DATA');
    await pool.query('DELETE FROM execution_dry_run_assessments');

    await insertAssessment(pool, logicalConflict);
    await insertAssessment(pool, idConflict);
    await expectCode(repository.findExact(expected, activeSignal()), 'INVALID_DATA');
  });
});

void test('real PostgreSQL rolls back insert when release fails and findExact proves an ACK-lost commit', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'dry-run repository rollback and ACK integration');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'dry_run_rollback', async (pool) => {
    await migrateDatabase({ pool });
    const intents = new PostgresExecutionIntentRepository(pool);
    const repository = new PostgresExecutionDryRunRepository(pool);
    const rollbackCreated = await intents.create(freshDraft('rollback'));
    const rollbackClaim = required(await intents.claim({ ownerId: 'rollback-worker', leaseMs: 30_000, purpose: 'DRY_RUN' }));
    const rollbackAssessment = createExecutionDryRunAssessment(rollbackClaim.intent);
    await pool.query(`CREATE FUNCTION reject_dry_run_release() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.lease_token IS NOT NULL AND NEW.lease_token IS NULL THEN
          RAISE EXCEPTION 'release rejected';
        END IF;
        RETURN NEW;
      END $$`);
    await pool.query(`CREATE TRIGGER reject_dry_run_release_trigger BEFORE UPDATE ON execution_intents
      FOR EACH ROW EXECUTE FUNCTION reject_dry_run_release()`);
    await expectCode(
      repository.complete(rollbackClaim, rollbackAssessment, activeSignal()),
      'COMMIT_OUTCOME_UNKNOWN',
    );
    assert.equal(await repository.findExact(rollbackAssessment, activeSignal()), null);
    assert.equal((await pool.query(
      'SELECT lease_token::TEXT AS lease_token FROM execution_intents WHERE id=$1', [rollbackCreated.intent.id],
    )).rows[0]?.lease_token, rollbackClaim.leaseToken);
    await pool.query('DROP TRIGGER reject_dry_run_release_trigger ON execution_intents');

    const ackCreated = await intents.create(freshDraft('ack-lost'));
    const ackClaim = required(await intents.claim({ ownerId: 'ack-worker', leaseMs: 30_000, purpose: 'DRY_RUN' }));
    const ackAssessment = createExecutionDryRunAssessment(ackClaim.intent);
    const ambiguous = new PostgresExecutionDryRunRepository(new AckLostPool(pool));
    await expectCode(
      ambiguous.complete(ackClaim, ackAssessment, activeSignal()), 'COMMIT_OUTCOME_UNKNOWN',
    );
    const exact = await repository.findExact(ackAssessment, activeSignal());
    assert.ok(exact);
    assert.equal(exact.intentId, ackCreated.intent.id);
  });
});

void test('real PostgreSQL allows only one concurrent completion for the same fenced claim', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'dry-run repository concurrency integration');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'dry_run_concurrency', async (pool) => {
    await migrateDatabase({ pool });
    const intents = new PostgresExecutionIntentRepository(pool);
    const repository = new PostgresExecutionDryRunRepository(pool);
    const created = await intents.create(freshDraft('concurrent'));
    const claimed = required(await intents.claim({ ownerId: 'concurrent-worker', leaseMs: 30_000, purpose: 'DRY_RUN' }));
    const assessment = createExecutionDryRunAssessment(claimed.intent);
    const settled = await Promise.allSettled([
      repository.complete(claimed, assessment, activeSignal()),
      repository.complete(claimed, assessment, activeSignal()),
    ]);
    assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(settled.filter((item) => item.status === 'rejected').length, 1);
    assert.equal((await pool.query(
      'SELECT 1 FROM execution_dry_run_assessments WHERE intent_id=$1', [created.intent.id],
    )).rowCount, 1);
  });
});

class ScriptedClient {
  public readonly calls: { readonly text: string; readonly values?: readonly unknown[] }[] = [];
  public readonly releaseErrors: (boolean | undefined)[] = [];

  public constructor(
    private readonly steps: Step[],
    private readonly onRelease?: (error?: boolean) => void,
  ) {}

  public async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
    this.calls.push(values === undefined ? { text } : { text, values });
    const step = this.steps.shift();
    if (step === undefined) throw new Error('Unexpected scripted query.');
    return typeof step === 'function' ? step(text, values) : step;
  }

  public release(error?: boolean): void {
    this.releaseErrors.push(error);
    this.onRelease?.(error);
  }
}

class ScriptedPool implements ExecutionDryRunPool {
  public connectCount = 0;
  public constructor(private readonly client: ScriptedClient) {}
  public async connect(): Promise<ScriptedClient> {
    this.connectCount += 1;
    return this.client;
  }
}

class RejectingPool implements ExecutionDryRunPool {
  public async connect(): Promise<never> { throw new Error('database secret'); }
}

class AckLostPool implements ExecutionDryRunPool {
  public constructor(private readonly pool: InstanceType<typeof pg.Pool>) {}
  public async connect(): Promise<Readonly<{
    query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
    release(error?: boolean): void;
  }>> {
    const client = await this.pool.connect();
    return {
      query: async (text, values) => {
        const resultValue = await client.query(text, values as unknown[] | undefined);
        throw new Error(`ACK lost after ${String(resultValue.rowCount)} rows`);
      },
      release: (error) => { client.release(error); },
    };
  }
}

function result(rows: readonly Row[], rowCount: number): QueryResult {
  return { rows, rowCount };
}

function logicalIdentityResult(rows: readonly Row[]): Step {
  return (text) => {
    const exposesContradictions = /WHERE assessment\.assessment_id=\$1\s+OR\s+\(assessment\.intent_id=\$2\s+AND assessment\.evaluator_version=\$3\)/u
      .test(text);
    return exposesContradictions ? result(rows, rows.length) : result([], 0);
  };
}

function claim(suffix: string): ClaimedExecutionIntent {
  const intentValue = intent(suffix);
  return Object.freeze({
    intent: intentValue,
    leaseOwner: `worker-${suffix}`,
    leaseToken: UUID,
    leaseExpiresAtMs: NOW_MS + 30_000,
  });
}

function intent(suffix: string): ExecutionIntentV1 {
  const draft = createExecutionIntentDraft({
    strategyId: 'dry-run-strategy', strategyVersion: 1,
    positionId: `position-${suffix}`, logicalCommandId: `command-${suffix}`,
    mint: '11111111111111111111111111111111', side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 1n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: `event-${suffix}`, decisionFingerprint: 'a'.repeat(64),
    requestedAtMs: NOW_MS, expiresAtMs: NOW_MS + 60_000,
  });
  return Object.freeze({
    ...draft, status: 'PENDING', attemptCount: 0, stateRevision: 0n,
    lastReasonCode: null, terminalAtMs: null, reconciliationCompletedAtMs: null,
    purgeAfterMs: null, createdAtMs: NOW_MS, updatedAtMs: NOW_MS,
  });
}

function freshDraft(suffix: string): ReturnType<typeof createExecutionIntentDraft> {
  const now = Date.now();
  return createExecutionIntentDraft({
    strategyId: 'dry-run-integration', strategyVersion: 1,
    positionId: `position-${suffix}`, logicalCommandId: `command-${suffix}-${randomUUID()}`,
    mint: '11111111111111111111111111111111', side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 1n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: `event-${suffix}`, decisionFingerprint: 'a'.repeat(64),
    requestedAtMs: now, expiresAtMs: now + 120_000,
  });
}

function assessmentRow(
  assessment: ExecutionDryRunAssessmentDraftV1,
  counters = true,
): Row {
  return {
    assessment_id: assessment.assessmentId,
    payload_version: assessment.payloadVersion,
    specification_version: assessment.specificationVersion,
    evaluator_version: assessment.evaluatorVersion,
    intent_id: assessment.intentId,
    strategy_id: assessment.strategyId,
    strategy_version: assessment.strategyVersion,
    decision_fingerprint: assessment.decisionFingerprint,
    intent_state_revision: assessment.intentStateRevision.toString(),
    intent_status: assessment.intentStatus,
    input_fingerprint: assessment.inputFingerprint,
    result_fingerprint: assessment.resultFingerprint,
    outcome: assessment.outcome,
    coverage: assessment.coverage,
    quote_status: assessment.quoteStatus,
    build_status: assessment.buildStatus,
    simulation_status: assessment.simulationStatus,
    signature_status: assessment.signatureStatus,
    submission_status: assessment.submissionStatus,
    recorded_at_ms: String(NOW_MS),
    ...(counters ? { locked_count: 1, inserted_count: 1, released_count: 1 } : {}),
  };
}

async function insertAssessment(
  pool: InstanceType<typeof pg.Pool>,
  assessment: ExecutionDryRunAssessmentDraftV1,
  overrides: Readonly<{ readonly inputFingerprint?: string }> = {},
): Promise<void> {
  await pool.query(`INSERT INTO execution_dry_run_assessments (
    assessment_id,payload_version,specification_version,evaluator_version,intent_id,
    strategy_id,strategy_version,decision_fingerprint,intent_state_revision,intent_status,
    input_fingerprint,result_fingerprint,outcome,coverage,quote_status,build_status,
    simulation_status,signature_status,submission_status
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, [
    assessment.assessmentId, assessment.payloadVersion, assessment.specificationVersion,
    assessment.evaluatorVersion, assessment.intentId, assessment.strategyId,
    assessment.strategyVersion, assessment.decisionFingerprint,
    assessment.intentStateRevision.toString(), assessment.intentStatus,
    overrides.inputFingerprint ?? assessment.inputFingerprint, assessment.resultFingerprint,
    assessment.outcome, assessment.coverage, assessment.quoteStatus, assessment.buildStatus,
    assessment.simulationStatus, assessment.signatureStatus, assessment.submissionStatus,
  ]);
}

async function expectCode(
  promise: Promise<unknown>,
  code: InstanceType<typeof ExecutionDryRunRepositoryError>['code'],
  message?: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ExecutionDryRunRepositoryError);
    assert.equal(error.code, code);
    assert.equal(error.message, 'Execution dry-run repository operation failed.');
    assert.doesNotMatch(String(error), /secret|postgresql:\/\//iu);
    return true;
  }, message);
}

async function parentSnapshot(
  pool: InstanceType<typeof pg.Pool>,
  intentId: string,
): Promise<Readonly<{ readonly business: Row; readonly lease: Row }>> {
  const selected = await pool.query<Row>(`SELECT status,attempt_count,state_revision::TEXT AS state_revision,
    last_reason_code,updated_at::TEXT AS updated_at,lease_owner,lease_token::TEXT AS lease_token,
    lease_expires_at::TEXT AS lease_expires_at FROM execution_intents WHERE id=$1`, [intentId]);
  const row = required(selected.rows[0]);
  return {
    business: {
      status: row.status, attempt_count: row.attempt_count, state_revision: row.state_revision,
      last_reason_code: row.last_reason_code, updated_at: row.updated_at,
    },
    lease: {
      lease_owner: row.lease_owner, lease_token: row.lease_token,
      lease_expires_at: row.lease_expires_at,
    },
  };
}

function testDatabaseUrl(
  context: Readonly<{ skip(message?: string): void }>,
  label: string,
): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') return databaseUrl;
  context.skip(`TEST_DATABASE_URL absent: ${label} skipped`);
  return null;
}

async function withTemporarySchema(
  databaseUrl: string,
  prefix: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    created = true;
    await callback(pool);
  } finally {
    try { await pool.end(); } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      } finally { await admin.end(); }
    }
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}

function required<Value>(value: Value | null | undefined): Value {
  assert.notEqual(value, null);
  assert.notEqual(value, undefined);
  return value as Value;
}

function deferred<Value>(): Readonly<{
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
}> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

function activeSignal(): AbortSignal {
  return new AbortController().signal;
}
