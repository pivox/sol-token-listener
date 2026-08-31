import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { createProviderUsageSnapshot } from '../src/domain/execution-provider-quota.js';
import { createExecutionRiskPolicy } from '../src/domain/execution-risk-policy.js';
import { ExecutionAdmissionService } from '../src/executor-risk/admission-service.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
import {
  ExecutionRiskRepositoryError,
  PostgresExecutionRiskRepository,
} from '../src/storage/execution-risk.repository.js';

const NOW_MS = 1_788_000_000_000;
const WSOL = 'So11111111111111111111111111111111111111112';
const walletKey = '11111111111111111111111111111111';
const genesisHash = '2'.repeat(32);

void test('two concurrent BUY admissions serialize exposure and admit exactly one', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution risk concurrent admission test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_risk_admission_race', async (pool) => {
    const fixture = await createFixture(pool);
    const first = await fixture.intentRepository.create(intentDraft('one'));
    const second = await fixture.intentRepository.create(intentDraft('two'));
    const [left, right] = await Promise.all([
      fixture.service.admit(admissionInput(first.intent, fixture)),
      fixture.service.admit(admissionInput(second.intent, fixture)),
    ]);
    assert.deepEqual([left.decision, right.decision].sort(), ['ADMITTED', 'REJECTED']);
    const reservations = await pool.query<{ readonly count: string; readonly amount: string }>(`
      SELECT COUNT(*)::TEXT AS count,COALESCE(SUM(maximum_amount_raw),0)::TEXT AS amount
      FROM execution_exposure_reservations WHERE state='RESERVED'`);
    assert.deepEqual(reservations.rows, [{ count: '1', amount: '90000' }]);
    const reports = await pool.query<{ readonly decision: string; readonly count: string }>(`
      SELECT decision,COUNT(*)::TEXT AS count FROM execution_risk_admission_reports
      GROUP BY decision ORDER BY decision`);
    assert.deepEqual(reports.rows, [
      { decision: 'ADMITTED', count: '1' },
      { decision: 'REJECTED', count: '1' },
    ]);
    const state = await pool.query(`SELECT state_revision::TEXT,reserved_exposure_raw::TEXT,
      open_positions FROM execution_wallet_risk_state`);
    assert.deepEqual(state.rows, [{
      state_revision: '1', reserved_exposure_raw: '90000', open_positions: 1,
    }]);
    assert.equal((await pool.query(
      `SELECT COUNT(*)::INTEGER AS count FROM execution_intents
       WHERE quote_amount_raw=90000 AND status='PENDING'`,
    )).rows[0]?.count, 2);
  });
});

void test('admission replays exactly and changed policy evidence conflicts', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution risk admission replay test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_risk_admission_replay', async (pool) => {
    const fixture = await createFixture(pool);
    const created = await fixture.intentRepository.create(intentDraft('replay'));
    const input = admissionInput(created.intent, fixture);
    const first = await fixture.service.admit(input);
    assert.equal(first.decision, 'ADMITTED');
    assert.deepEqual(await fixture.service.admit(input), first);
    const changedPolicy = createExecutionRiskPolicy({
      ...policyInput(), providerSafetyMarginUnits: 6n,
    });
    await assert.rejects(
      fixture.service.admit({ ...input, policy: changedPolicy }),
      (error) => error instanceof ExecutionRiskRepositoryError && error.code === 'CONFLICT',
    );
    await assert.rejects(
      fixture.service.admit({ ...input, allEndpointsUnavailable: true }),
      (error) => error instanceof ExecutionRiskRepositoryError && error.code === 'CONFLICT',
    );
    assert.equal((await pool.query('SELECT COUNT(*)::INTEGER AS count FROM execution_exposure_reservations'))
      .rows[0]?.count, 1);
  });
});

void test('a stale wallet snapshot rejects without reserving exposure', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution risk stale admission test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_risk_admission_stale', async (pool) => {
    const fixture = await createFixture(pool);
    const created = await fixture.intentRepository.create(intentDraft('stale'));
    const result = await fixture.service.admit({
      ...admissionInput(created.intent, fixture),
      nowMs: NOW_MS + 59_960,
    });
    assert.equal(result.decision, 'REJECTED');
    assert.equal(result.reasonCode, 'WALLET_MISMATCH');
    assert.equal(result.reservationId, null);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM execution_exposure_reservations',
    )).rows[0]?.count, 0);
  });
});

void test('stale provider evidence rejects while a retired generation fences ABA reuse', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution risk stale provider and ABA test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_risk_admission_fences', async (pool) => {
    const fixture = await createFixture(pool);
    const staleIntent = await fixture.intentRepository.create(intentDraft(
      'provider-stale',
      NOW_MS + 120_000,
    ));
    const longWalletPolicy = createExecutionRiskPolicy({
      ...policyInput(), walletSnapshotMaxAgeMs: 120_000,
    });
    const staleResult = await fixture.service.admit({
      ...admissionInput(staleIntent.intent, fixture),
      policy: longWalletPolicy,
      nowMs: NOW_MS + 60_001,
    });
    assert.equal(staleResult.decision, 'REJECTED');
    assert.equal(staleResult.reasonCode, 'PROVIDER_USAGE_UNKNOWN');

    await pool.query(`UPDATE execution_wallet_generations
      SET retired_at=date_trunc('milliseconds',statement_timestamp())
      WHERE generation_id=$1`, [fixture.generation.generationId]);
    await fixture.riskRepository.registerWalletGeneration({
      generationId: `execution_wallet_generation_${'d'.repeat(64)}`,
      payloadVersion: 1,
      walletPublicKey: walletKey,
      cluster: 'mainnet-beta',
      genesisHash,
      generation: 2,
    });
    const abaIntent = await fixture.intentRepository.create(intentDraft('generation-aba'));
    await assert.rejects(
      fixture.service.admit(admissionInput(abaIntent.intent, fixture)),
      (error) => error instanceof ExecutionRiskRepositoryError && error.code === 'CONFLICT',
    );
  });
});

void test('a failure after report insertion rolls back report, reservation and state', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution risk admission rollback test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_risk_admission_rollback', async (pool) => {
    const fixture = await createFixture(pool);
    const created = await fixture.intentRepository.create(intentDraft('rollback'));
    const faultRepository = new PostgresExecutionRiskRepository({
      async connect() {
        const client = await pool.connect();
        return {
          async query(text: string, values?: readonly unknown[]) {
            if (text.includes('INSERT INTO execution_exposure_reservations')) {
              throw new Error('injected sensitive failure');
            }
            return client.query(text, values === undefined ? undefined : [...values]);
          },
          release(error?: boolean) { client.release(error); },
        };
      },
    });
    const service = new ExecutionAdmissionService(faultRepository);
    await assert.rejects(
      service.admit(admissionInput(created.intent, fixture)),
      (error) => error instanceof ExecutionRiskRepositoryError
        && error.code === 'DATABASE_FAILURE'
        && !String(error).includes('sensitive'),
    );
    const counts = await pool.query(`SELECT
      (SELECT COUNT(*) FROM execution_risk_admission_reports)::INTEGER AS reports,
      (SELECT COUNT(*) FROM execution_exposure_reservations)::INTEGER AS reservations,
      (SELECT state_revision FROM execution_wallet_risk_state)::TEXT AS revision`);
    assert.deepEqual(counts.rows, [{ reports: 0, reservations: 0, revision: '0' }]);
  });
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(pool: InstanceType<typeof pg.Pool>) {
  await migrateDatabase({ pool });
  const riskRepository = new PostgresExecutionRiskRepository(pool);
  const intentRepository = new PostgresExecutionIntentRepository(pool);
  const generation = await riskRepository.registerWalletGeneration({
    generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    payloadVersion: 1,
    walletPublicKey: walletKey,
    cluster: 'mainnet-beta',
    genesisHash,
    generation: 1,
  });
  const walletSnapshot = await riskRepository.appendWalletSnapshot({
    snapshotId: `execution_wallet_snapshot_${'b'.repeat(64)}`,
    payloadVersion: 1,
    snapshotFingerprint: 'b'.repeat(64),
    generationId: generation.generationId,
    providerId: 'rpc-primary',
    stateRevision: 0n,
    slot: 123n,
    blockTimeMs: NOW_MS - 100,
    observedAtMs: NOW_MS - 50,
    commitment: 'finalized',
    walletLamports: 1_000_000n,
    tokenBalanceCount: 0,
    openPositions: Object.freeze([]),
    realizedNetPnlRaw: 0n,
  });
  const providerSnapshot = createProviderUsageSnapshot({
    providerId: 'rpc-primary',
    planId: 'public-v1',
    billingPeriodId: 'period-current',
    billingPeriodStartedAtMs: NOW_MS - 1_000,
    billingPeriodEndsAtMs: NOW_MS + 300_000,
    limitUnits: 10_000n,
    usedUnits: 10n,
    measuredAtMs: NOW_MS - 100,
    expiresAtMs: NOW_MS + 60_000,
    provenance: 'AUTHORITATIVE_PROBE',
  });
  await riskRepository.appendProviderUsage(providerSnapshot);
  return Object.freeze({
    riskRepository,
    intentRepository,
    service: new ExecutionAdmissionService(riskRepository),
    generation,
    walletSnapshot,
    providerSnapshot,
    policy: createExecutionRiskPolicy(policyInput()),
  });
}

function admissionInput(intent: Awaited<ReturnType<
  InstanceType<typeof PostgresExecutionIntentRepository>['create']
>>['intent'], fixture: Fixture) {
  return Object.freeze({
    payloadVersion: 1 as const,
    intent,
    policy: fixture.policy,
    generationId: fixture.generation.generationId,
    walletSnapshot: fixture.walletSnapshot,
    providerSnapshot: fixture.providerSnapshot,
    allEndpointsUnavailable: false,
    nowMs: NOW_MS,
  });
}

function intentDraft(seed: string, expiresAtMs = NOW_MS + 60_000) {
  return createExecutionIntentDraft({
    strategyId: 'risk-admission-test',
    strategyVersion: 1,
    positionId: `position:${seed}`,
    logicalCommandId: `command:${seed}`,
    mint: walletKey,
    side: 'BUY',
    venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: WSOL,
    quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9,
    quoteAmountRaw: 90_000n,
    baseAmountRaw: null,
    minimumAmountOutRaw: 1n,
    decisionEventId: `decision:${seed}`,
    decisionFingerprint: 'c'.repeat(64),
    requestedAtMs: NOW_MS - 1_000,
    expiresAtMs,
  });
}

function policyInput() {
  return {
    quoteMintAllowlist: [WSOL] as const,
    initialCapitalLamports: 1_000_000n,
    maximumCapitalLamports: 1_000_000n,
    positionSizeBps: 1_000n,
    maximumOpenPositions: 2,
    maximumTotalExposureBps: 1_000n,
    drawdownPauseBps: 2_500n,
    feeReserveLamports: 100_000n,
    walletSnapshotMaxAgeMs: 60_000,
    providerUsageMaxAgeMs: 300_000,
    providerEntryCostUnits: 8n,
    providerExitCostUnitsPerPosition: 4n,
    providerConfirmationCostUnitsPerPosition: 2n,
    providerReconciliationCostUnitsPerPosition: 3n,
    providerSafetyMarginUnits: 5n,
    maximumConsecutiveTechnicalFailures: 2,
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
    max: 6,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    created = true;
    await pool.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await callback(pool);
  } finally {
    try {
      await pool.end();
    } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
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
