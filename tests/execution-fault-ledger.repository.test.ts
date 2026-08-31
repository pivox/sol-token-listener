import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresExecutionRiskRepository } from '../src/storage/execution-risk.repository.js';

const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
const wallet = '11111111111111111111111111111111';

void test('technical faults survive restart, block on the second failure and replay exactly', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution fault ledger test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_fault_ledger', async (pool) => {
    await migrateDatabase({ pool });
    const firstRepository = new PostgresExecutionRiskRepository(pool);
    await firstRepository.registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: wallet,
      cluster: 'mainnet-beta', genesisHash: '2'.repeat(32), generation: 1,
    });
    const first = fault('b', 'BUILD', 'EXECUTION_BUILD_FAILED');
    const firstResult = await firstRepository.recordFault(first);
    assert.equal(firstResult.consecutiveTechnicalFailures, 1);
    assert.equal(firstResult.retryDecision, 'RETRY_PRE_SIGNATURE');
    assert.equal(firstResult.buyBlocked, false);
    assert.deepEqual(await firstRepository.recordFault(first), firstResult);

    const restartedRepository = new PostgresExecutionRiskRepository(pool);
    const second = await restartedRepository.recordFault(
      fault('c', 'SIMULATION', 'BUY_SIMULATION_FAILED'),
    );
    assert.equal(second.consecutiveTechnicalFailures, 2);
    assert.equal(second.retryDecision, 'DO_NOT_RETRY');
    assert.equal(second.buyBlocked, true);

    const validation = await restartedRepository.recordFault(Object.freeze({
      ...fault('d', 'VALIDATION', 'EXECUTION_EVIDENCE_INVALID'),
      classification: 'DETERMINISTIC' as const,
    }));
    assert.equal(validation.consecutiveTechnicalFailures, 2);
    assert.equal(validation.retryDecision, 'DO_NOT_RETRY');
    const state = await pool.query(`SELECT consecutive_technical_failures,
      last_technical_failure_reason_code FROM execution_wallet_risk_state`);
    assert.deepEqual(state.rows, [{
      consecutive_technical_failures: 2,
      last_technical_failure_reason_code: 'BUY_SIMULATION_FAILED',
    }]);
  });
});

void test('provider, confirmation and reconciliation faults increment the durable gate', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution technical stage ledger test');
  if (databaseUrl === null) return;
  const cases = [
    ['PROVIDER', 'EXECUTION_PROVIDER_FAILED', 'e'],
    ['CONFIRMATION', 'CONFIRMATION_TIMEOUT', 'f'],
    ['RECONCILIATION', 'RECONCILIATION_REQUIRED', '1'],
  ] as const;
  for (const [stage, reasonCode, seed] of cases) {
    await withTemporarySchema(databaseUrl, `execution_fault_${stage.toLowerCase()}`, async (pool) => {
      await migrateDatabase({ pool });
      const repository = new PostgresExecutionRiskRepository(pool);
      await repository.registerWalletGeneration({
        generationId, payloadVersion: 1, walletPublicKey: wallet,
        cluster: 'mainnet-beta', genesisHash: '2'.repeat(32), generation: 1,
      });
      const recorded = await repository.recordFault(fault(seed, stage, reasonCode));
      assert.equal(recorded.consecutiveTechnicalFailures, 1);
      assert.equal(recorded.retryDecision, stage === 'PROVIDER'
        ? 'RETRY_PRE_SIGNATURE' : 'RECONCILE_ONLY');
      const state = await pool.query(`SELECT consecutive_technical_failures,
        last_technical_failure_reason_code FROM execution_wallet_risk_state`);
      assert.deepEqual(state.rows, [{
        consecutive_technical_failures: 1,
        last_technical_failure_reason_code: reasonCode,
      }]);
    });
  }
});

function fault(
  seed: string,
  stage: 'BUILD' | 'SIMULATION' | 'PROVIDER' | 'CONFIRMATION' | 'RECONCILIATION' | 'VALIDATION',
  reasonCode: 'EXECUTION_BUILD_FAILED' | 'BUY_SIMULATION_FAILED' | 'EXECUTION_PROVIDER_FAILED'
    | 'CONFIRMATION_TIMEOUT' | 'RECONCILIATION_REQUIRED' | 'EXECUTION_EVIDENCE_INVALID',
) {
  return Object.freeze({
    faultId: `execution_fault_${seed.repeat(64)}`,
    payloadVersion: 1 as const,
    generationId,
    intentId: null,
    activationPhase: 'NONE' as const,
    stage,
    side: 'BUY' as const,
    timing: stage === 'CONFIRMATION' || stage === 'RECONCILIATION'
      ? 'AFTER_SIGNATURE' as const : 'PRE_SIGNATURE' as const,
    classification: 'TRANSIENT' as const,
    exactSignedBytesAvailable: false,
    reasonCode,
    observedAtMs: Date.now(),
  });
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
    max: 2,
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
