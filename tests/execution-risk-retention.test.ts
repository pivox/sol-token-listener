import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { createProviderUsageSnapshot } from '../src/domain/execution-provider-quota.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
import { PostgresExecutionRiskRepository } from '../src/storage/execution-risk.repository.js';

const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
const wallet = '11111111111111111111111111111111';
const mint = wallet;
const quoteMint = 'So11111111111111111111111111111111111111112';

void test('executor risk purge exposes additive zero counters on an empty database', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: executor risk retention test skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const result = await purgeExpiredFoundationData(pool);
    assert.deepEqual({
      exitAuthorizations: result.executionExitAuthorizations,
      livePositions: result.executionLivePositions,
      rateLimits: result.executionRiskRateLimitEvents,
      evidence: result.executionRiskReconciliationEvidence,
      faults: result.executionRiskFaults,
      reservations: result.executionRiskReservations,
      reports: result.executionRiskAdmissionReports,
      walletSnapshots: result.executionRiskWalletSnapshots,
      providerOperations: result.executionRiskProviderOperations,
      providerSnapshots: result.executionRiskProviderSnapshots,
      tombstones: result.executionRiskTombstones,
      signedTransactions: result.executionSignedTransactions,
      submissionEvents: result.executionSubmissionEvents,
    }, {
      exitAuthorizations: 0, livePositions: 0,
      rateLimits: 0, evidence: 0, faults: 0, reservations: 0, reports: 0,
      walletSnapshots: 0, providerOperations: 0, providerSnapshots: 0, tombstones: 0,
      signedTransactions: 0, submissionEvents: 0,
    });
  });
});

void test('live retention is terminal-only and cannot delete ambiguous or open state', async () => {
  const source = await readFile(new URL('../src/storage/database.ts', import.meta.url), 'utf8');
  const liveStart = source.indexOf('const executionLiveArtifactCohort');
  const liveEnd = source.indexOf('const executionControlEvents', liveStart);
  assert.ok(liveStart >= 0 && liveEnd > liveStart, 'live retention cohort is absent');
  const liveRetention = source.slice(liveStart, liveEnd);
  assert.match(liveRetention, /state IN \('RECONCILED','REVOKED_NO_SEND'\)/u);
  assert.match(liveRetention, /candidate\.state='CLOSED'/u);
  assert.match(liveRetention, /candidate\.state IN \('CONSUMED','REVOKED'\)/u);
  assert.doesNotMatch(liveRetention, /(?:AMBIGUOUS|UNKNOWN|OPEN|EXIT_PENDING|SUBMISSION_STARTED)'?\s*(?:,|\))/u);
  assert.match(liveRetention, /purge_after <= \$1::TIMESTAMPTZ/u);
});

void test('purges only expired executor risk payloads and retains active or ambiguous state', async (context) => {
  const databaseUrl = requiredDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const nowMs = Date.now();
    const repository = new PostgresExecutionRiskRepository(pool);
    await repository.registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: wallet,
      cluster: 'mainnet-beta', genesisHash: '3'.repeat(32), generation: 1,
    });
    await repository.appendWalletSnapshot(walletSnapshot('b', 0n, nowMs - 21_600_000));
    await repository.appendWalletSnapshot(walletSnapshot('c', 1n, nowMs - 1_000));
    await pool.query(`UPDATE execution_wallet_snapshots SET
      superseded_at=TIMESTAMPTZ 'epoch' + ($2::BIGINT * INTERVAL '1 millisecond'),
      purge_after=TIMESTAMPTZ 'epoch' + (($2::BIGINT + 14400000) * INTERVAL '1 millisecond')
      WHERE snapshot_id=$1`, [`execution_wallet_snapshot_${'b'.repeat(64)}`, nowMs - 14_400_000]);

    const oldProvider = providerSnapshot('old', nowMs - 172_800_000, nowMs - 86_400_000,
      nowMs - 129_600_000, nowMs - 129_540_000);
    const currentProvider = providerSnapshot('current', nowMs - 21_600_000, nowMs + 3_600_000,
      nowMs - 18_000_000, nowMs - 17_940_000);
    await repository.appendProviderUsage(oldProvider);
    for (const [snapshot, operationSeed] of [[oldProvider, '6']] as const) {
      await repository.recordProviderOperation({
        operationId: `execution_provider_operation_${operationSeed.repeat(64)}`,
        payloadVersion: 1, snapshotId: snapshot.snapshotId, providerId: snapshot.providerId,
        billingPeriodId: snapshot.billingPeriodId, category: 'TELEMETRY',
        logicalOperationId: `operation:${snapshot.billingPeriodId}`, units: 1n,
      });
    }
    await repository.appendProviderUsage(currentProvider);
    for (const [snapshot, operationSeed] of [[currentProvider, '7']] as const) {
      await repository.recordProviderOperation({
        operationId: `execution_provider_operation_${operationSeed.repeat(64)}`,
        payloadVersion: 1, snapshotId: snapshot.snapshotId, providerId: snapshot.providerId,
        billingPeriodId: snapshot.billingPeriodId, category: 'TELEMETRY',
        logicalOperationId: `operation:${snapshot.billingPeriodId}`, units: 1n,
      });
    }
    for (const snapshot of [oldProvider, currentProvider]) {
      await pool.query(`UPDATE execution_provider_usage_snapshots SET
        superseded_at=TIMESTAMPTZ 'epoch' + ($2::BIGINT * INTERVAL '1 millisecond'),
        purge_after=TIMESTAMPTZ 'epoch' + (($2::BIGINT + 14400000) * INTERVAL '1 millisecond')
        WHERE snapshot_id=$1`, [snapshot.snapshotId, nowMs - 14_400_000]);
    }
    await repository.recordRateLimit(rateLimit('f', nowMs - 14_400_000));
    await repository.recordRateLimit(rateLimit('1', nowMs - 14_399_000));
    await repository.recordFault(fault('2', nowMs - 18_000_000));
    await repository.recordFault(fault('3', nowMs - 1_000));
    await pool.query(`UPDATE execution_fault_ledger SET
      reset_at=TIMESTAMPTZ 'epoch' + ($2::BIGINT * INTERVAL '1 millisecond'),
      purge_after=TIMESTAMPTZ 'epoch' + (($2::BIGINT + 14400000) * INTERVAL '1 millisecond')
      WHERE fault_id=$1`, [`execution_fault_${'2'.repeat(64)}`, nowMs - 14_400_000]);

    const purged = await purgeExpiredFoundationData(pool);
    assert.equal(purged.executionRiskRateLimitEvents, 1);
    assert.equal(purged.executionRiskWalletSnapshots, 1);
    assert.equal(purged.executionRiskProviderOperations, 1);
    assert.equal(purged.executionRiskProviderSnapshots, 1);
    assert.equal(purged.executionRiskFaults, 1);
    assert.deepEqual(await counts(pool, [
      'execution_wallet_generations', 'execution_wallet_snapshots',
      'execution_provider_usage_snapshots', 'execution_provider_usage_counters',
      'execution_provider_rate_limit_events', 'execution_fault_ledger',
    ]), [1, 1, 1, 1, 1, 1]);
    assert.equal((await pool.query(`SELECT billing_period_id
      FROM execution_provider_usage_snapshots`)).rows[0]?.billing_period_id, 'current');
  });
});

void test('a tombstone collision rolls back the complete executor risk cohort', async (context) => {
  const databaseUrl = requiredDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const nowMs = Date.now();
    const repository = new PostgresExecutionRiskRepository(pool);
    await repository.registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: wallet,
      cluster: 'mainnet-beta', genesisHash: '3'.repeat(32), generation: 1,
    });
    const intent = await new PostgresExecutionIntentRepository(pool)
      .create(intentDraft('collision', nowMs));
    await insertReport(pool, intent.intent.id, '6', 'REJECTED', nowMs);
    await repository.recordRateLimit(rateLimit('7', nowMs - 14_400_000));
    await pool.query(`INSERT INTO execution_risk_tombstones (
      tombstone_id,payload_version,source_kind,source_id,source_fingerprint
    ) SELECT
      'execution_risk_tombstone_'
        || md5('ADMISSION_REPORT:' || report_id)
        || md5(report_id || ':ADMISSION_REPORT'),
      1,'ADMISSION_REPORT',report_id,report_fingerprint
      FROM execution_risk_admission_reports WHERE report_id=$1`, [
      `execution_risk_admission_${'6'.repeat(64)}`,
    ]);

    await assert.rejects(purgeExpiredFoundationData(pool), /duplicate key/u);
    assert.deepEqual(await counts(pool, [
      'execution_risk_admission_reports', 'execution_provider_rate_limit_events',
      'execution_risk_tombstones',
    ]), [1, 1, 1]);
  });
});

void test('tombstones precede child-first deletion while UNKNOWN_HELD survives', async (context) => {
  const databaseUrl = requiredDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const nowMs = Date.now();
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: wallet,
      cluster: 'mainnet-beta', genesisHash: '3'.repeat(32), generation: 1,
    });
    const intentRepository = new PostgresExecutionIntentRepository(pool);
    const terminalIntent = await intentRepository.create(intentDraft('terminal', nowMs));
    const heldIntent = await intentRepository.create(intentDraft('held', nowMs));
    await insertReport(pool, terminalIntent.intent.id, '4', 'ADMITTED', nowMs);
    await insertReport(pool, heldIntent.intent.id, '5', 'ADMITTED', nowMs);
    await insertReservation(pool, terminalIntent.intent.id, '4', 'RELEASED', nowMs);
    await insertReservation(pool, heldIntent.intent.id, '5', 'UNKNOWN_HELD', nowMs);
    await pool.query(`INSERT INTO execution_attempts (
      intent_id,attempt_number,status,effective_venue,provider_id,started_at,completed_at,reason_code
    ) VALUES ($1,1,'COMPLETED','PUMP_FUN','rpc-primary',
      TIMESTAMPTZ 'epoch' + ($2::BIGINT * INTERVAL '1 millisecond'),
      TIMESTAMPTZ 'epoch' + ($3::BIGINT * INTERVAL '1 millisecond'),'ATTEMPT_COMPLETED')`, [
      terminalIntent.intent.id, nowMs - 18_001_000, nowMs - 18_000_000,
    ]);
    await insertEvidence(pool, terminalIntent.intent.id, '4', nowMs);
    await insertResolvedUnknownEvidence(pool, terminalIntent.intent.id, nowMs);

    const purged = await purgeExpiredFoundationData(pool);
    assert.equal(purged.executionRiskReconciliationEvidence, 2);
    assert.equal(purged.executionRiskReservations, 1);
    assert.equal(purged.executionRiskAdmissionReports, 1);
    assert.equal(purged.executionRiskTombstones, 2);
    assert.deepEqual(await counts(pool, [
      'execution_reconciliation_evidence', 'execution_exposure_reservations',
      'execution_risk_admission_reports', 'execution_risk_tombstones',
    ]), [0, 1, 1, 2]);
    assert.equal((await pool.query(`SELECT state FROM execution_exposure_reservations`))
      .rows[0]?.state, 'UNKNOWN_HELD');
  });
});

function walletSnapshot(seed: string, stateRevision: bigint, observedAtMs: number) {
  return Object.freeze({
    snapshotId: `execution_wallet_snapshot_${seed.repeat(64)}`,
    payloadVersion: 1 as const,
    snapshotFingerprint: seed.repeat(64),
    generationId,
    providerId: 'rpc-primary',
    stateRevision,
    slot: stateRevision + 1n,
    blockTimeMs: observedAtMs,
    observedAtMs,
    commitment: 'finalized' as const,
    walletLamports: 1_000_000n,
    tokenBalanceCount: 0,
    openPositions: Object.freeze([]),
    realizedNetPnlRaw: 0n,
  });
}

function providerSnapshot(
  billingPeriodId: string,
  billingPeriodStartedAtMs: number,
  billingPeriodEndsAtMs: number,
  measuredAtMs: number,
  expiresAtMs: number,
) {
  return createProviderUsageSnapshot({
    providerId: 'rpc-primary', planId: 'public-v1', billingPeriodId,
    billingPeriodStartedAtMs, billingPeriodEndsAtMs,
    limitUnits: 10_000n, usedUnits: billingPeriodId === 'old' ? 1n : 2n,
    measuredAtMs, expiresAtMs, provenance: 'AUTHORITATIVE_PROBE',
  });
}

function rateLimit(seed: string, observedAtMs: number) {
  return Object.freeze({
    eventId: `execution_provider_rate_limit_${seed.repeat(64)}`,
    payloadVersion: 1 as const,
    providerId: 'rpc-primary', billingPeriodId: 'current', endpointId: `endpoint-${seed}`,
    observedAtMs,
  });
}

function fault(seed: string, observedAtMs: number) {
  return Object.freeze({
    faultId: `execution_fault_${seed.repeat(64)}`,
    payloadVersion: 1 as const,
    generationId,
    intentId: null,
    activationPhase: 'NONE' as const,
    stage: 'BUILD' as const,
    side: 'BUY' as const,
    timing: 'PRE_SIGNATURE' as const,
    classification: 'TRANSIENT' as const,
    exactSignedBytesAvailable: false,
    reasonCode: 'EXECUTION_BUILD_FAILED' as const,
    observedAtMs,
  });
}

function intentDraft(seed: string, nowMs: number) {
  return createExecutionIntentDraft({
    strategyId: 'risk-retention-test', strategyVersion: 1,
    positionId: `position:${seed}`, logicalCommandId: `command:${seed}`,
    mint, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint,
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9, quoteAmountRaw: 100n,
    baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: `decision:${seed}`, decisionFingerprint: 'a'.repeat(64),
    requestedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 60_000,
  });
}

async function insertReport(
  pool: InstanceType<typeof pg.Pool>,
  intentId: string,
  seed: string,
  decision: 'ADMITTED' | 'REJECTED',
  nowMs: number,
): Promise<void> {
  await pool.query(`INSERT INTO execution_risk_admission_reports (
    report_id,payload_version,report_fingerprint,input_fingerprint,intent_id,generation_id,
    policy_fingerprint,wallet_snapshot_fingerprint,provider_snapshot_fingerprint,
    decision,reason_code,quote_amount_raw,projected_capital_raw,projected_exposure_raw,
    projected_drawdown_raw,quota_state,wallet_state_revision,recorded_at,terminal_at,purge_after
  ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,
    CASE WHEN $9='REJECTED' THEN 'DECISION_STALE' ELSE NULL END,
    100,1000,100,0,'NORMAL',0,
    TIMESTAMPTZ 'epoch' + ($10::BIGINT * INTERVAL '1 millisecond'),
    CASE WHEN $9='REJECTED' THEN TIMESTAMPTZ 'epoch'
      + ($11::BIGINT * INTERVAL '1 millisecond') ELSE NULL END,
    CASE WHEN $9='REJECTED' THEN TIMESTAMPTZ 'epoch'
      + (($11::BIGINT + 14400000) * INTERVAL '1 millisecond') ELSE NULL END)`, [
    `execution_risk_admission_${seed.repeat(64)}`, seed.repeat(64), '8'.repeat(64),
    intentId, generationId, '9'.repeat(64), 'a'.repeat(64), 'b'.repeat(64), decision,
    nowMs - 18_000_001, nowMs - 14_400_000,
  ]);
}

async function insertReservation(
  pool: InstanceType<typeof pg.Pool>,
  intentId: string,
  seed: string,
  state: 'RELEASED' | 'UNKNOWN_HELD',
  nowMs: number,
): Promise<void> {
  await pool.query(`INSERT INTO execution_exposure_reservations (
    reservation_id,payload_version,intent_id,generation_id,admission_report_id,
    position_id,side,mint,quote_mint,maximum_amount_raw,intent_fingerprint,
    policy_fingerprint,wallet_snapshot_fingerprint,provider_snapshot_fingerprint,
    state,state_revision,created_at,reconciled_at,purge_after
  ) VALUES ($1,1,$2,$3,$4,$5,'BUY',$6,$7,100,$8,$9,$10,$11,$12,1,
    TIMESTAMPTZ 'epoch' + ($13::BIGINT * INTERVAL '1 millisecond'),
    CASE WHEN $12='RELEASED' THEN TIMESTAMPTZ 'epoch'
      + ($14::BIGINT * INTERVAL '1 millisecond') ELSE NULL END,
    CASE WHEN $12='RELEASED' THEN TIMESTAMPTZ 'epoch'
      + (($14::BIGINT + 14400000) * INTERVAL '1 millisecond') ELSE NULL END)`, [
    `execution_exposure_reservation_${seed.repeat(64)}`, intentId, generationId,
    `execution_risk_admission_${seed.repeat(64)}`, `position:${seed}`, mint, quoteMint,
    seed.repeat(64), '9'.repeat(64), 'a'.repeat(64), 'b'.repeat(64), state,
    nowMs - 18_000_001, nowMs - 14_400_000,
  ]);
}

async function insertEvidence(
  pool: InstanceType<typeof pg.Pool>,
  intentId: string,
  seed: string,
  nowMs: number,
): Promise<void> {
  await pool.query(`INSERT INTO execution_reconciliation_evidence (
    evidence_id,payload_version,evidence_fingerprint,intent_id,attempt_number,reservation_id,
    generation_id,provider_id,side,signature,blockhash,last_valid_block_height,message_hash,
    build_fingerprint,snapshot_fingerprint,maximum_fee_lamports,
    maximum_fee_payer_lamport_debit,signature_history,confirmation_status,
    finalized_block_height,observed_slot,observed_transaction_fingerprint,fee_lamports,
    wallet_lamport_delta,base_delta_raw,quote_delta_raw,unexpected_residual_token_balance_raw,
    observed_at,finalized_at,result,reason_code,purge_after
  ) VALUES ($1,1,$2,$3,1,$4,$5,'rpc-primary','BUY',$6,$7,100,$8,$9,$10,10,1000,
    'PRESENT','FINALIZED',101,102,$11,1,-101,10,-100,0,
    TIMESTAMPTZ 'epoch' + ($12::BIGINT * INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch' + ($13::BIGINT * INTERVAL '1 millisecond'),
    'MATCHED','INTENT_SUCCEEDED',
    TIMESTAMPTZ 'epoch' + (($13::BIGINT + 14400000) * INTERVAL '1 millisecond'))`, [
    `execution_reconciliation_${seed.repeat(64)}`, 'c'.repeat(64), intentId,
    `execution_exposure_reservation_${seed.repeat(64)}`, generationId,
    '3'.repeat(88), wallet, 'd'.repeat(64), 'e'.repeat(64), 'f'.repeat(64),
    '1'.repeat(64), nowMs - 14_400_001, nowMs - 14_400_000,
  ]);
}

async function insertResolvedUnknownEvidence(
  pool: InstanceType<typeof pg.Pool>,
  intentId: string,
  nowMs: number,
): Promise<void> {
  await pool.query(`INSERT INTO execution_reconciliation_evidence (
    evidence_id,payload_version,evidence_fingerprint,intent_id,attempt_number,reservation_id,
    generation_id,provider_id,side,signature,blockhash,last_valid_block_height,message_hash,
    build_fingerprint,snapshot_fingerprint,maximum_fee_lamports,
    maximum_fee_payer_lamport_debit,signature_history,confirmation_status,
    finalized_block_height,observed_slot,observed_transaction_fingerprint,fee_lamports,
    wallet_lamport_delta,base_delta_raw,quote_delta_raw,unexpected_residual_token_balance_raw,
    observed_at,finalized_at,result,reason_code,resolved_by_evidence_id,resolved_at,purge_after
  ) VALUES ($1,1,$2,$3,1,$4,$5,'rpc-primary','BUY',$6,$7,100,$8,$9,$10,10,1000,
    'UNKNOWN','NOT_FOUND',99,NULL,NULL,0,0,0,0,0,
    TIMESTAMPTZ 'epoch' + ($11::BIGINT * INTERVAL '1 millisecond'),NULL,
    'UNKNOWN','RECONCILIATION_REQUIRED',$12,
    TIMESTAMPTZ 'epoch' + ($13::BIGINT * INTERVAL '1 millisecond'),
    TIMESTAMPTZ 'epoch' + (($13::BIGINT + 14400000) * INTERVAL '1 millisecond'))`, [
    `execution_reconciliation_${'8'.repeat(64)}`, '8'.repeat(64), intentId,
    `execution_exposure_reservation_${'4'.repeat(64)}`, generationId,
    '3'.repeat(88), wallet, 'd'.repeat(64), 'e'.repeat(64), 'f'.repeat(64),
    nowMs - 14_400_002, `execution_reconciliation_${'4'.repeat(64)}`,
    nowMs - 14_400_000,
  ]);
}

async function counts(
  pool: InstanceType<typeof pg.Pool>,
  tables: readonly string[],
): Promise<number[]> {
  const values: number[] = [];
  for (const table of tables) {
    if (!/^[a-z_]+$/u.test(table)) throw new Error('Unsafe table name.');
    const result = await pool.query<{ readonly count: number }>(
      `SELECT COUNT(*)::INTEGER AS count FROM ${table}`,
    );
    values.push(result.rows[0]?.count ?? -1);
  }
  return values;
}

function requiredDatabaseUrl(
  context: Readonly<{ skip(message?: string): void }>,
): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') return databaseUrl;
  context.skip('TEST_DATABASE_URL absent: executor risk retention test skipped');
  return null;
}

async function withTemporarySchema(
  databaseUrl: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `execution_risk_retention_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await pool.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await callback(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}
