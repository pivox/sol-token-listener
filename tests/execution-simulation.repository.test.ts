import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  createExecutionSimulationArtifactDraft,
  type ExecutionSimulationArtifactDraftV1,
} from '../src/domain/execution-simulation.js';
import {
  createExecutionIntentDraft,
  type ExecutionIntentV1,
} from '../src/domain/execution-intent.js';
import type { ClaimedExecutionIntent } from '../src/ports/execution-intent-repository.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
import {
  ExecutionSimulationRepositoryError,
  PostgresExecutionSimulationRepository,
  type ExecutionSimulationPool,
} from '../src/storage/execution-simulation.repository.js';

type Row = Readonly<Record<string, unknown>>;
type QueryResult = Readonly<{ rows: readonly Row[]; rowCount: number | null }>;
type Step = QueryResult | ((text: string, values?: readonly unknown[]) => QueryResult);

const UUID = '00000000-0000-4000-8000-000000000001';
const NOW_MS = 1_788_000_000_000;
const HASH = 'a'.repeat(64);
const PUBLIC_KEY = '11111111111111111111111111111111';

void test('complete snapshots inputs and dispatches one atomic terminal CTE', async () => {
  const claimed = claim('success');
  const artifact = successArtifact(claimed);
  const client = new ScriptedClient([result([artifactRow(artifact, true)], 1)]);
  const repository = new PostgresExecutionSimulationRepository(new ScriptedPool(client));

  const stored = await repository.complete(claimed, artifact, activeSignal());

  assert.deepEqual(stored, Object.freeze({ ...artifact, recordedAtMs: NOW_MS }));
  assert.equal(client.calls.length, 1);
  const call = required(client.calls[0]);
  assert.match(call.text, /^WITH operation AS MATERIALIZED\s*\(/u);
  assert.doesNotMatch(call.text, /\bBEGIN\b|\bCOMMIT\b/iu);
  assert.match(call.text, /FOR UPDATE OF intent/u);
  assert.match(call.text, /attempt\.status='STARTED'/u);
  assert.match(call.text, /INSERT INTO execution_simulation_artifacts/u);
  assert.match(call.text, /UPDATE execution_attempts AS attempt/u);
  assert.match(call.text, /INSERT INTO execution_intent_transitions/u);
  assert.match(call.text, /UPDATE execution_intents AS intent/u);
  assert.match(call.text, /state_revision=locked\.state_revision \+\s*CASE WHEN inserted\.result_kind='SUCCESS' THEN 2 ELSE 1 END/u);
  assert.match(call.text, /terminal_at=operation\.at[\s\S]*reconciliation_completed_at=operation\.at[\s\S]*purge_after=operation\.at \+ INTERVAL '4 hours'/u);
  assert.match(call.text, /lease_owner=NULL[\s\S]*lease_token=NULL[\s\S]*lease_expires_at=NULL/u);
  assert.match(call.text, /locked\.side='BUY' AND \$70='BUY_SIMULATION_FAILED'[\s\S]*locked\.side='SELL' AND \$70='SELL_SIMULATION_FAILED'/u);
  assert.doesNotMatch(call.text, /transaction_bytes|message_bytes|instruction_bytes|signature|secret|rpc_url|raw_logs/iu);
  assert.equal(call.values?.[0], claimed.intent.id);
  assert.ok(call.values?.includes(artifact.resultFingerprint));
  assert.deepEqual(client.releaseErrors, [undefined]);
});

void test('complete validates the PROCESSING fence and exact causal identity before connecting', async () => {
  const claimed = claim('input');
  const artifact = successArtifact(claimed);
  const pool = new ScriptedPool(new ScriptedClient([]));
  const repository = new PostgresExecutionSimulationRepository(pool);

  for (const [candidateClaim, candidateArtifact] of [
    [{ ...claimed }, artifact],
    [claimed, { ...artifact }],
    [claimed, Object.freeze({ ...artifact, strategyId: 'other' })],
    [claimed, Object.freeze({ ...artifact, intentStateRevision: 8n })],
    [claimed, Object.freeze({ ...artifact, attemptNumber: 3 })],
  ] as const) {
    await expectCode(repository.complete(
      candidateClaim as ClaimedExecutionIntent,
      candidateArtifact as ExecutionSimulationArtifactDraftV1,
      activeSignal(),
    ), 'INVALID_INPUT');
  }
  assert.equal(pool.connectCount, 0);
});

void test('complete rejects a simulation program reason that contradicts the intent side', async () => {
  const buy = claim('buy-side');
  const sell = claim('sell-side', 'SELL');
  const pool = new ScriptedPool(new ScriptedClient([]));
  const repository = new PostgresExecutionSimulationRepository(pool);

  await expectCode(repository.complete(
    buy, programFailureArtifact(buy, 'SELL_SIMULATION_FAILED'), activeSignal(),
  ), 'INVALID_INPUT');
  await expectCode(repository.complete(
    sell, programFailureArtifact(sell, 'BUY_SIMULATION_FAILED'), activeSignal(),
  ), 'INVALID_INPUT');
  assert.equal(pool.connectCount, 0);
});

void test('complete distinguishes fence, artifact conflict, hostile data, and ambiguous commit', async () => {
  const claimed = claim('outcomes');
  const artifact = successArtifact(claimed);
  for (const [row, code] of [
    [{ ...artifactRow(artifact, true), locked_count: 0, attempt_count: 0,
      inserted_count: 0, finished_count: 0, transition_count: 0, updated_count: 0 }, 'INTENT_FENCE_LOST'],
    [{ ...artifactRow(artifact, true), inserted_count: 0, finished_count: 0,
      transition_count: 0, updated_count: 0 }, 'ARTIFACT_CONFLICT'],
    [{ ...artifactRow(artifact, true), transition_count: 1 }, 'COMMIT_OUTCOME_UNKNOWN'],
  ] as const) {
    const client = new ScriptedClient([result([row], 1)]);
    await expectCode(
      new PostgresExecutionSimulationRepository(new ScriptedPool(client)).complete(
        claimed, artifact, activeSignal(),
      ), code,
    );
    assert.deepEqual(client.releaseErrors, [true]);
  }

  const queryFailure = new ScriptedClient([() => { throw new Error('database secret'); }]);
  await expectCode(
    new PostgresExecutionSimulationRepository(new ScriptedPool(queryFailure)).complete(
      claimed, artifact, activeSignal(),
    ), 'COMMIT_OUTCOME_UNKNOWN',
  );
  assert.deepEqual(queryFailure.releaseErrors, [true]);

  const releaseFailure = new ScriptedClient(
    [result([artifactRow(artifact, true)], 1)],
    () => { throw new Error('release secret'); },
  );
  await expectCode(
    new PostgresExecutionSimulationRepository(new ScriptedPool(releaseFailure)).complete(
      claimed, artifact, activeSignal(),
    ), 'COMMIT_OUTCOME_UNKNOWN',
  );
});

void test('complete persists one failure transition and one revision increment', async () => {
  const claimed = claim('failure');
  const artifact = providerFailureArtifact(claimed);
  const client = new ScriptedClient([result([artifactRow(artifact, true, {
    transition_count: 1,
  })], 1)]);
  const repository = new PostgresExecutionSimulationRepository(new ScriptedPool(client));

  const stored = await repository.complete(claimed, artifact, activeSignal());

  assert.equal(stored.terminalReasonCode, 'EXECUTION_PROVIDER_FAILED');
  const call = required(client.calls[0]);
  assert.match(call.text, /CASE WHEN inserted\.result_kind='SUCCESS' THEN 'COMPLETED' ELSE 'ABANDONED' END/u);
  assert.match(call.text, /CASE WHEN inserted\.result_kind='SUCCESS'\s+THEN 'ATTEMPT_COMPLETED' ELSE inserted\.terminal_reason_code END/u);
  assert.match(call.text, /SELECT finished\.intent_id AS intent_id,'PROCESSING' AS previous_status,[\s\S]*THEN 'SIMULATED' ELSE 'FAILED' END/u);
});

void test('findExact returns exact, null, and ARTIFACT_CONFLICT without a lease', async () => {
  const artifact = successArtifact(claim('find'));
  const exactClient = new ScriptedClient([result([artifactRow(artifact, false)], 1)]);
  const repository = new PostgresExecutionSimulationRepository(new ScriptedPool(exactClient));
  assert.deepEqual(
    await repository.findExact(artifact, activeSignal()),
    Object.freeze({ ...artifact, recordedAtMs: NOW_MS }),
  );
  const call = required(exactClient.calls[0]);
  assert.match(call.text, /WHERE artifact\.artifact_id=\$1\s+OR\s+\(artifact\.intent_id=\$2 AND artifact\.attempt_number=\$3\)/u);
  assert.doesNotMatch(call.text, /lease|FOR UPDATE|BEGIN|COMMIT/iu);
  assert.deepEqual(call.values, [artifact.artifactId, artifact.intentId, artifact.attemptNumber]);

  const missing = new ScriptedClient([result([], 0)]);
  assert.equal(await new PostgresExecutionSimulationRepository(new ScriptedPool(missing))
    .findExact(artifact, activeSignal()), null);

  const conflicting = providerFailureArtifact(claim('find'));
  const conflictClient = new ScriptedClient([result([artifactRow(conflicting, false)], 1)]);
  await expectCode(
    new PostgresExecutionSimulationRepository(new ScriptedPool(conflictClient))
      .findExact(artifact, activeSignal()),
    'ARTIFACT_CONFLICT',
  );
  assert.deepEqual(conflictClient.releaseErrors, [true]);
});

void test('findExact rejects malformed database rows and cancellation is fail-closed', async () => {
  const artifact = successArtifact(claim('hostile'));
  const malformed = new ScriptedClient([result([{
    ...artifactRow(artifact, false), recorded_at_ms: '001',
  }], 1)]);
  await expectCode(
    new PostgresExecutionSimulationRepository(new ScriptedPool(malformed))
      .findExact(artifact, activeSignal()),
    'INVALID_DATA',
  );

  const controller = new AbortController();
  controller.abort();
  const pool = new ScriptedPool(new ScriptedClient([]));
  await expectCode(
    new PostgresExecutionSimulationRepository(pool).findExact(artifact, controller.signal),
    'OPERATION_ABORTED',
  );
  assert.equal(pool.connectCount, 0);
});

void test('real PostgreSQL completes success atomically and terminalizes without a send state', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'simulation repository integration');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_simulation_repository', async (pool) => {
    await migrateDatabase({ pool });
    const intents = new PostgresExecutionIntentRepository(pool);
    const repository = new PostgresExecutionSimulationRepository(pool);
    const now = Date.now();
    const created = await intents.create(createExecutionIntentDraft({
      strategyId: 'simulation-strategy', strategyVersion: 1,
      positionId: `position-${randomUUID()}`, logicalCommandId: `command-${randomUUID()}`,
      mint: PUBLIC_KEY, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
      quoteMint: 'So11111111111111111111111111111111111111112',
      quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
      quoteAmountRaw: 1_000n, baseAmountRaw: null, minimumAmountOutRaw: 850n,
      decisionEventId: `event-${randomUUID()}`, decisionFingerprint: HASH,
      requestedAtMs: now, expiresAtMs: now + 120_000,
    }));
    const pending = required(await intents.claim({
      ownerId: 'simulation-worker', leaseMs: 30_000, purpose: 'EXECUTE',
    }));
    const processingIntent = await intents.transition(pending, {
      intentId: pending.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
      leaseToken: pending.leaseToken, reasonCode: 'EXECUTION_STARTED',
      humanMessage: 'Execution simulation started.', activationPhase: 'NONE',
      evidence: Object.freeze({
        payloadVersion: 1, attemptNumber: null, sourceEventId: null, observedAtMs: now,
      }),
    });
    const processing = Object.freeze({ ...pending, intent: processingIntent });
    const attempt = await intents.beginAttempt(processing);
    const artifact = createExecutionSimulationArtifactDraft({
      ...successArtifactInput(processing), attemptNumber: attempt.attemptNumber,
    });

    const stored = await repository.complete(processing, artifact, activeSignal());

    assert.deepEqual(await repository.findExact(artifact, activeSignal()), stored);
    const terminal = required(await intents.read(created.intent.id));
    assert.equal(terminal.status, 'SUCCEEDED');
    assert.equal(terminal.stateRevision, processing.intent.stateRevision + 2n);
    assert.equal(terminal.attemptCount, 1);
    assert.equal(terminal.lastReasonCode, 'INTENT_SUCCEEDED');
    assert.equal(terminal.terminalAtMs, stored.recordedAtMs);
    assert.equal(terminal.reconciliationCompletedAtMs, stored.recordedAtMs);
    assert.equal(terminal.purgeAfterMs, stored.recordedAtMs + 14_400_000);
    const attemptRow = required((await pool.query<Row>(`SELECT status,effective_venue,provider_id,
      reason_code FROM execution_attempts WHERE intent_id=$1 AND attempt_number=1`,
    [created.intent.id])).rows[0]);
    assert.deepEqual(attemptRow, {
      status: 'COMPLETED', effective_venue: 'PUMP_FUN', provider_id: 'primary',
      reason_code: 'ATTEMPT_COMPLETED',
    });
    const transitions = await pool.query<Row>(`SELECT previous_status,next_status,reason_code
      FROM execution_intent_transitions WHERE intent_id=$1 ORDER BY sequence`, [created.intent.id]);
    assert.deepEqual(transitions.rows.slice(-2), [
      { previous_status: 'PROCESSING', next_status: 'SIMULATED', reason_code: 'SIMULATION_SUCCEEDED' },
      { previous_status: 'SIMULATED', next_status: 'SUCCEEDED', reason_code: 'INTENT_SUCCEEDED' },
    ]);
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
    if (step === undefined) throw new Error('Unexpected query.');
    return typeof step === 'function' ? step(text, values) : step;
  }
  public release(error?: boolean): void {
    this.releaseErrors.push(error);
    this.onRelease?.(error);
  }
}

class ScriptedPool implements ExecutionSimulationPool {
  public connectCount = 0;
  public constructor(private readonly client: ScriptedClient) {}
  public async connect(): Promise<ScriptedClient> {
    this.connectCount += 1;
    return this.client;
  }
}

function claim(suffix: string, side: 'BUY' | 'SELL' = 'BUY'): ClaimedExecutionIntent {
  const draft = createExecutionIntentDraft({
    strategyId: 'simulation-strategy', strategyVersion: 1,
    positionId: `position-${suffix}`, logicalCommandId: `command-${suffix}`,
    mint: PUBLIC_KEY, side,
    venuePolicy: side === 'BUY' ? 'PUMP_FUN_ONLY' : 'CANONICAL_EXIT',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: side === 'BUY' ? 1_000n : null,
    baseAmountRaw: side === 'SELL' ? 1_000n : null, minimumAmountOutRaw: 850n,
    decisionEventId: `event-${suffix}`, decisionFingerprint: HASH,
    requestedAtMs: NOW_MS - 10_000, expiresAtMs: NOW_MS + 60_000,
  });
  const intent: ExecutionIntentV1 = Object.freeze({
    ...draft, status: 'PROCESSING', attemptCount: 0, stateRevision: 7n,
    lastReasonCode: 'EXECUTION_STARTED', terminalAtMs: null,
    reconciliationCompletedAtMs: null, purgeAfterMs: null,
    createdAtMs: NOW_MS - 10_000, updatedAtMs: NOW_MS - 5_000,
  });
  return Object.freeze({
    intent, leaseOwner: `worker-${suffix}`, leaseToken: UUID,
    leaseExpiresAtMs: NOW_MS + 30_000,
  });
}

function successArtifact(claimed: ClaimedExecutionIntent): ExecutionSimulationArtifactDraftV1 {
  return createExecutionSimulationArtifactDraft(successArtifactInput(claimed));
}

function successArtifactInput(claimed: ClaimedExecutionIntent): Readonly<Record<string, unknown>> {
  return {
    intentId: claimed.intent.id, attemptNumber: 1,
    intentStateRevision: claimed.intent.stateRevision,
    strategyId: claimed.intent.strategyId, strategyVersion: claimed.intent.strategyVersion,
    decisionFingerprint: claimed.intent.decisionFingerprint,
    resultKind: 'SUCCESS', effectiveVenue: 'PUMP_FUN', providerId: 'primary',
    executorPublicKey: PUBLIC_KEY, expectedGenesisHash: PUBLIC_KEY,
    observedGenesisHash: PUBLIC_KEY, configurationFingerprint: HASH,
    quoteFingerprint: HASH, snapshotFingerprint: HASH, buildFingerprint: HASH,
    messageHash: HASH, blockhash: PUBLIC_KEY, lastValidBlockHeight: 1_000n,
    blockhashContextSlot: 900n, snapshotSlot: 899n, feeContextSlot: 900n,
    simulationSlot: 901n, amountInRaw: 1_000n, expectedAmountOutRaw: 900n,
    protectedAmountOutRaw: 850n, feesRaw: 10n, estimatedFeeLamports: 5_000n,
    simulatedFeePayerLamportDebit: 6_000n, unitsConsumed: 200_000n,
    simulatedBaseDeltaRaw: 900n, simulatedQuoteDeltaRaw: -1_000n,
    rpcCallsUsed: 5, rpcCallsLimit: 8, quoteStatus: 'SUCCEEDED',
    buildStatus: 'SUCCEEDED', simulationStatus: 'SUCCEEDED', failureStage: null,
    failureCode: null, terminalReasonCode: 'INTENT_SUCCEEDED',
    logsFingerprint: HASH, logsLineCount: 1,
  };
}

function providerFailureArtifact(
  claimed: ClaimedExecutionIntent,
): ExecutionSimulationArtifactDraftV1 {
  const success = successArtifact(claimed);
  const {
    artifactId: _artifactId,
    payloadVersion: _payloadVersion,
    specificationVersion: _specificationVersion,
    evaluatorVersion: _evaluatorVersion,
    resultFingerprint: _resultFingerprint,
    ...input
  } = success;
  return createExecutionSimulationArtifactDraft({
    ...input,
    resultKind: 'PROVIDER_FAILED', effectiveVenue: null, observedGenesisHash: null,
    quoteFingerprint: null, snapshotFingerprint: null, buildFingerprint: null,
    messageHash: null, blockhash: null, lastValidBlockHeight: null,
    blockhashContextSlot: null, snapshotSlot: null, feeContextSlot: null,
    simulationSlot: null, amountInRaw: null, expectedAmountOutRaw: null,
    protectedAmountOutRaw: null, feesRaw: null, estimatedFeeLamports: null,
    simulatedFeePayerLamportDebit: null, unitsConsumed: null,
    simulatedBaseDeltaRaw: null, simulatedQuoteDeltaRaw: null,
    rpcCallsUsed: 1, quoteStatus: 'FAILED', buildStatus: 'NOT_RUN',
    simulationStatus: 'NOT_RUN', failureStage: 'PROVIDER',
    failureCode: 'RPC_UNAVAILABLE', terminalReasonCode: 'EXECUTION_PROVIDER_FAILED',
    logsFingerprint: null, logsLineCount: null,
  });
}

function programFailureArtifact(
  claimed: ClaimedExecutionIntent,
  reason: 'BUY_SIMULATION_FAILED' | 'SELL_SIMULATION_FAILED',
): ExecutionSimulationArtifactDraftV1 {
  const success = successArtifact(claimed);
  const {
    artifactId: _artifactId,
    payloadVersion: _payloadVersion,
    specificationVersion: _specificationVersion,
    evaluatorVersion: _evaluatorVersion,
    resultFingerprint: _resultFingerprint,
    ...input
  } = success;
  return createExecutionSimulationArtifactDraft({
    ...input, resultKind: 'SIMULATION_FAILED', simulationStatus: 'FAILED',
    failureStage: 'SIMULATION', failureCode: 'SIMULATION_PROGRAM_ERROR',
    terminalReasonCode: reason, simulationSlot: null,
    simulatedFeePayerLamportDebit: null, unitsConsumed: null,
    simulatedBaseDeltaRaw: null, simulatedQuoteDeltaRaw: null,
    logsFingerprint: null, logsLineCount: null,
  });
}

function artifactRow(
  artifact: ExecutionSimulationArtifactDraftV1,
  counters: boolean,
  overrides: Readonly<Record<string, unknown>> = {},
): Row {
  const row = {
    artifact_id: artifact.artifactId, payload_version: artifact.payloadVersion,
    specification_version: artifact.specificationVersion,
    evaluator_version: artifact.evaluatorVersion, intent_id: artifact.intentId,
    attempt_number: artifact.attemptNumber,
    intent_state_revision: artifact.intentStateRevision.toString(),
    strategy_id: artifact.strategyId, strategy_version: artifact.strategyVersion,
    decision_fingerprint: artifact.decisionFingerprint, result_kind: artifact.resultKind,
    effective_venue: artifact.effectiveVenue, provider_id: artifact.providerId,
    executor_public_key: artifact.executorPublicKey,
    expected_genesis_hash: artifact.expectedGenesisHash,
    observed_genesis_hash: artifact.observedGenesisHash,
    configuration_fingerprint: artifact.configurationFingerprint,
    quote_fingerprint: artifact.quoteFingerprint, snapshot_fingerprint: artifact.snapshotFingerprint,
    build_fingerprint: artifact.buildFingerprint, message_hash: artifact.messageHash,
    blockhash: artifact.blockhash,
    last_valid_block_height: dbBigint(artifact.lastValidBlockHeight),
    blockhash_context_slot: dbBigint(artifact.blockhashContextSlot),
    snapshot_slot: dbBigint(artifact.snapshotSlot), fee_context_slot: dbBigint(artifact.feeContextSlot),
    simulation_slot: dbBigint(artifact.simulationSlot), amount_in_raw: dbBigint(artifact.amountInRaw),
    expected_amount_out_raw: dbBigint(artifact.expectedAmountOutRaw),
    protected_amount_out_raw: dbBigint(artifact.protectedAmountOutRaw),
    fees_raw: dbBigint(artifact.feesRaw),
    estimated_fee_lamports: dbBigint(artifact.estimatedFeeLamports),
    simulated_fee_payer_lamport_debit: dbBigint(artifact.simulatedFeePayerLamportDebit),
    units_consumed: dbBigint(artifact.unitsConsumed),
    simulated_base_delta_raw: dbBigint(artifact.simulatedBaseDeltaRaw),
    simulated_quote_delta_raw: dbBigint(artifact.simulatedQuoteDeltaRaw),
    rpc_calls_used: artifact.rpcCallsUsed, rpc_calls_limit: artifact.rpcCallsLimit,
    quote_status: artifact.quoteStatus, build_status: artifact.buildStatus,
    simulation_status: artifact.simulationStatus, failure_stage: artifact.failureStage,
    failure_code: artifact.failureCode, terminal_reason_code: artifact.terminalReasonCode,
    logs_fingerprint: artifact.logsFingerprint, logs_line_count: artifact.logsLineCount,
    result_fingerprint: artifact.resultFingerprint, recorded_at_ms: String(NOW_MS),
    ...(counters ? {
      locked_count: 1, attempt_count: 1, inserted_count: 1, finished_count: 1,
      transition_count: artifact.resultKind === 'SUCCESS' ? 2 : 1, updated_count: 1,
    } : {}),
    ...overrides,
  };
  return row;
}

function dbBigint(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function result(rows: readonly Row[], rowCount: number): QueryResult {
  return { rows, rowCount };
}

async function expectCode(
  promise: Promise<unknown>,
  code: InstanceType<typeof ExecutionSimulationRepositoryError>['code'],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ExecutionSimulationRepositoryError);
    assert.equal(error.code, code);
    assert.equal(error.message, 'Execution simulation repository operation failed.');
    assert.doesNotMatch(String(error), /secret|postgresql:\/\//iu);
    return true;
  });
}

function required<Value>(value: Value | null | undefined): Value {
  assert.notEqual(value, null);
  assert.notEqual(value, undefined);
  return value as Value;
}

function activeSignal(): AbortSignal {
  return new AbortController().signal;
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
