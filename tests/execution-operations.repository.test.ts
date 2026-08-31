import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  createExecutionArmament,
  createOperatorAuthorization,
} from '../src/domain/execution-operations.js';
import {
  createSafetyQualification,
  EXECUTION_SAFETY_GATE_IDS,
} from '../src/domain/execution-safety-qualification.js';
import { migrateDatabase } from '../src/storage/database.js';
import {
  ExecutionOperationsRepositoryError,
  PostgresExecutionOperationsRepository,
} from '../src/storage/execution-operations.repository.js';
import { PostgresExecutionRiskRepository } from '../src/storage/execution-risk.repository.js';

const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
const publicKey = '11111111111111111111111111111111';

void test('qualification, resume and inert armament replay durably without live capability', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId,
      payloadVersion: 1,
      walletPublicKey: publicKey,
      cluster: 'mainnet-beta',
      genesisHash: publicKey,
      generation: 1,
    });
    const repository = new PostgresExecutionOperationsRepository(pool);
    const nowMs = Date.now();
    const qualification = safetyQualification(nowMs);
    assert.deepEqual(await repository.persistQualification(qualification), qualification);
    assert.deepEqual(await repository.persistQualification(qualification), qualification);

    const stopped = await repository.setStop({
      payloadVersion: 1,
      commandId: 'command:initial-entry-stop',
      generationId,
      operatorId: 'operator-primary',
      occurredAtMs: nowMs + 1,
    }, 'ENTRY_STOP');
    assert.equal(stopped.controlState, 'ENTRY_STOP');
    assert.equal(stopped.controlRevision, 1n);

    const resumeAuthorization = createOperatorAuthorization({
      payloadVersion: 1,
      generationId,
      action: 'RESUME',
      phase: null,
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: 'b'.repeat(64),
      operatorId: 'operator-primary',
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + 60_000,
    });
    assert.equal(await repository.recordAuthorization(resumeAuthorization), 'RECORDED');
    assert.equal(await repository.recordAuthorization(resumeAuthorization), 'REPLAYED');
    const running = await repository.resume({
      payloadVersion: 1,
      commandId: 'command:resume',
      generationId,
      qualificationId: qualification.qualificationId,
      authorization: resumeAuthorization,
      operatorId: 'operator-primary',
      occurredAtMs: nowMs + 2,
    });
    assert.equal(running.controlState, 'RUNNING');

    const armAuthorization = createOperatorAuthorization({
      payloadVersion: 1,
      generationId,
      action: 'ARM',
      phase: 'CANARY',
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: 'c'.repeat(64),
      operatorId: 'operator-primary',
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + 60_000,
    });
    await repository.recordAuthorization(armAuthorization);
    const armament = createExecutionArmament({
      payloadVersion: 1,
      qualification,
      maximumBuys: 1,
      maximumCapitalLamports: 500_000n,
      maximumExposureBps: 500n,
      maximumOpenPositions: 1,
      maximumHoldingMs: 300_000,
      armedAtMs: nowMs + 3,
      expiresAtMs: nowMs + 299_999,
      operatorId: 'operator-primary',
      operatorReason: 'Mainnet canary manually approved.',
      authorizationId: armAuthorization.authorizationId,
      authorizationFingerprint: armAuthorization.authorizationFingerprint,
    });
    assert.deepEqual(await repository.arm(armament), armament);
    assert.deepEqual(await repository.arm(armament), armament);
    const status = await repository.readStatus(generationId);
    assert.equal(status.controlState, 'RUNNING');
    assert.equal(status.activeArmamentId, armament.armamentId);
    assert.equal(status.activeArmamentPhase, 'CANARY');
    assert.equal(status.latestQualificationId, qualification.qualificationId);
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_activation_events`)).rows[0]?.count, 1);
  });
});

void test('armament fails closed while stopped and a hard stop cannot be downgraded', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    const repository = new PostgresExecutionOperationsRepository(pool);
    const nowMs = Date.now();
    const qualification = safetyQualification(nowMs);
    await repository.persistQualification(qualification);
    const authorization = createOperatorAuthorization({
      payloadVersion: 1, generationId, action: 'ARM', phase: 'CANARY',
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: 'd'.repeat(64), operatorId: 'operator-primary',
      issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
    });
    await repository.recordAuthorization(authorization);
    const armament = createExecutionArmament({
      payloadVersion: 1, qualification, maximumBuys: 1,
      maximumCapitalLamports: 1n, maximumExposureBps: 500n,
      maximumOpenPositions: 1, maximumHoldingMs: 30_000,
      armedAtMs: nowMs + 1, expiresAtMs: nowMs + 60_000,
      operatorId: 'operator-primary', operatorReason: 'Canary.',
      authorizationId: authorization.authorizationId,
      authorizationFingerprint: authorization.authorizationFingerprint,
    });
    await assert.rejects(repository.arm(armament), isRepositoryError('CONTROL_STOPPED'));
    await repository.setStop({
      payloadVersion: 1, commandId: 'command:hard-stop', generationId,
      operatorId: 'operator-primary', occurredAtMs: nowMs + 2,
    }, 'HARD_STOP');
    await assert.rejects(repository.setStop({
      payloadVersion: 1, commandId: 'command:downgrade', generationId,
      operatorId: 'operator-primary', occurredAtMs: nowMs + 3,
    }, 'ENTRY_STOP'), isRepositoryError('CONFLICT'));
  });
});

function safetyQualification(nowMs: number) {
  const evidenceTypes = [
    'CI_RUN', 'MIGRATION_TEST', 'ARCHITECTURE_TEST', 'DRY_RUN_TEST',
    'SIMULATION_ARTIFACT', 'FAULT_TEST', 'RECONCILIATION_STATE',
    'PROVIDER_SNAPSHOT', 'STOP_CONTROL_TEST', 'WALLET_SNAPSHOT',
    'MAINNET_SIMULATION_ARTIFACT',
  ] as const;
  return createSafetyQualification({
    payloadVersion: 1, evaluatorVersion: 1, phase: 'CANARY',
    buildHash: '1'.repeat(64), configurationFingerprint: '2'.repeat(64),
    strategyFingerprint: '3'.repeat(64), generationId, walletPublicKey: publicKey,
    cluster: 'mainnet-beta', genesisHash: publicKey, providerId: 'primary',
    qualifiedAtMs: nowMs, expiresAtMs: nowMs + 300_000,
    gates: EXECUTION_SAFETY_GATE_IDS.map((gateId, index) => ({
      payloadVersion: 1, gateId, status: 'PASSED', evidenceType: evidenceTypes[index],
      evidenceId: `evidence:${index}`,
      evidenceFingerprint: index.toString(16).repeat(64),
      observedAtMs: nowMs - 1_000 + index, expiresAtMs: nowMs + 300_000,
    })),
  });
}

function isRepositoryError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ExecutionOperationsRepositoryError && error.code === code;
}

function testDatabaseUrl(context: Readonly<{ skip(message?: string): void }>): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') return databaseUrl;
  context.skip('TEST_DATABASE_URL absent: execution operations repository test skipped');
  return null;
}

async function withTemporarySchema(
  databaseUrl: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `execution_operations_repository_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl, max: 2,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    created = true;
    await pool.query(`SET search_path TO ${quoteIdentifier(schema)}`);
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
