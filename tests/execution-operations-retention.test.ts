import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  migrateDatabase,
  purgeExpiredFoundationData,
} from '../src/storage/database.js';
import { PostgresExecutionRiskRepository } from '../src/storage/execution-risk.repository.js';

const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
const publicKey = '11111111111111111111111111111111';

void test('retention purges terminal #51-F payloads after four hours and preserves control state', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    await insertExpiredFixture(pool);

    const purged = await purgeExpiredFoundationData(pool);

    assert.equal(purged.executionControlEvents, 0);
    assert.equal(purged.executionActivationEvents, 1);
    assert.equal(purged.executionActivationArmaments, 1);
    assert.equal(purged.executionOperatorAuthorizations, 1);
    assert.equal(purged.executionSafetyQualifications, 1);
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_control_state`)).rows[0]?.count, 1);
    for (const table of [
      'execution_activation_events', 'execution_activation_armaments',
      'execution_operator_authorizations',
      'execution_safety_gate_evidence', 'execution_safety_qualifications',
    ]) assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM ${table}`))
      .rows[0]?.count, 0);
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_control_events`)).rows[0]?.count, 1);
  });
});

async function insertExpiredFixture(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  const qualificationId = `execution_safety_qualification_${'b'.repeat(64)}`;
  const qualificationFingerprint = 'c'.repeat(64);
  const authorizationId = `execution_operator_authorization_${'d'.repeat(64)}`;
  const armamentId = `execution_activation_armament_${'e'.repeat(64)}`;
  const controlEventId = `execution_control_event_${'f'.repeat(64)}`;
  const activationEventId = `execution_activation_event_${'1'.repeat(64)}`;
  await pool.query(`INSERT INTO execution_safety_qualifications (
    qualification_id,payload_version,evaluator_version,qualification_fingerprint,
    phase,build_hash,configuration_fingerprint,strategy_fingerprint,generation_id,
    wallet_public_key,cluster,genesis_hash,provider_id,qualified_at,expires_at,purge_after
  ) VALUES ($1,1,1,$2,'CANARY',$3,$4,$5,$6,$7,'mainnet-beta',$7,'primary',
    TIMESTAMPTZ '2020-01-01T00:00:00.000Z',TIMESTAMPTZ '2020-01-01T00:05:00.000Z',
    TIMESTAMPTZ '2020-01-01T04:05:00.000Z')`, [
    qualificationId, qualificationFingerprint, '2'.repeat(64), '3'.repeat(64),
    '4'.repeat(64), generationId, publicKey,
  ]);
  const gateIds = [
    'QUALITY_GATES_PASSED', 'MIGRATIONS_VERIFIED', 'ARCHITECTURE_BOUNDARIES_VERIFIED',
    'DRY_RUN_RECOVERY_VERIFIED', 'SIMULATION_MATRIX_VERIFIED', 'FAULT_MATRIX_VERIFIED',
    'RECONCILIATION_CLEAN', 'PROVIDER_EXIT_CAPACITY_VERIFIED',
    'STOP_CONTROLS_VERIFIED', 'WALLET_CHAIN_LIMITS_VERIFIED',
    'MAINNET_PREFLIGHT_SIMULATED',
  ];
  const evidenceTypes = [
    'CI_RUN', 'MIGRATION_TEST', 'ARCHITECTURE_TEST', 'DRY_RUN_TEST',
    'SIMULATION_ARTIFACT', 'FAULT_TEST', 'RECONCILIATION_STATE',
    'PROVIDER_SNAPSHOT', 'STOP_CONTROL_TEST', 'WALLET_SNAPSHOT',
    'MAINNET_SIMULATION_ARTIFACT',
  ];
  for (let index = 0; index < gateIds.length; index += 1) {
    await pool.query(`INSERT INTO execution_safety_gate_evidence (
      qualification_id,gate_index,payload_version,gate_id,status,evidence_type,
      evidence_id,evidence_fingerprint,observed_at,expires_at
    ) VALUES ($1,$2,1,$3,'PASSED',$4,$5,$6,
      TIMESTAMPTZ '2020-01-01T00:00:00.000Z',TIMESTAMPTZ '2020-01-01T00:05:00.000Z')`, [
      qualificationId, index, gateIds[index], evidenceTypes[index],
      `evidence:${index}`, index.toString(16).repeat(64),
    ]);
  }
  await pool.query(`ALTER TABLE execution_operator_authorizations
    DISABLE TRIGGER execution_operator_authorizations_v2_insert`);
  await pool.query(`INSERT INTO execution_operator_authorizations (
    authorization_id,payload_version,authorization_fingerprint,generation_id,
    action,phase,context_fingerprint,nonce_hash,operator_id,issued_at,expires_at,
    consumed_at,purge_after
  ) VALUES ($1,1,$2,$3,'ARM','CANARY',$4,$5,'operator-primary',
    TIMESTAMPTZ '2020-01-01T00:00:00.000Z',TIMESTAMPTZ '2020-01-01T00:01:00.000Z',
    TIMESTAMPTZ '2020-01-01T00:00:01.000Z',TIMESTAMPTZ '2020-01-01T04:00:01.000Z')`, [
    authorizationId, '6'.repeat(64), generationId,
    qualificationFingerprint, '7'.repeat(64),
  ]);
  await pool.query(`ALTER TABLE execution_operator_authorizations
    ENABLE TRIGGER execution_operator_authorizations_v2_insert`);
  await pool.query(`ALTER TABLE execution_activation_armaments
    DISABLE TRIGGER execution_activation_armaments_guarded_insert`);
  await pool.query(`INSERT INTO execution_activation_armaments (
    armament_id,payload_version,armament_fingerprint,qualification_id,
    qualification_fingerprint,generation_id,authorization_id,state,state_revision,phase,
    build_hash,configuration_fingerprint,strategy_fingerprint,wallet_public_key,
    cluster,genesis_hash,provider_id,maximum_buys,consumed_buys,
    maximum_capital_lamports,maximum_exposure_bps,maximum_open_positions,
    maximum_holding_ms,operator_id,operator_reason,armed_at,expires_at,terminal_at,purge_after
  ) VALUES ($1,1,$2,$3,$4,$5,$6,'REVOKED',1,'CANARY',$7,$8,$9,$10,
    'mainnet-beta',$10,'primary',1,0,1000,500,1,30000,'operator-primary','Canary.',
    TIMESTAMPTZ '2020-01-01T00:00:00.000Z',TIMESTAMPTZ '2020-01-01T00:01:00.000Z',
    TIMESTAMPTZ '2020-01-01T00:02:00.000Z',TIMESTAMPTZ '2020-01-01T04:02:00.000Z')`, [
    armamentId, '8'.repeat(64), qualificationId, qualificationFingerprint,
    generationId, authorizationId, '2'.repeat(64), '3'.repeat(64),
    '4'.repeat(64), publicKey,
  ]);
  await pool.query(`ALTER TABLE execution_activation_armaments
    ENABLE TRIGGER execution_activation_armaments_guarded_insert`);
  await pool.query(`INSERT INTO execution_activation_events (
    event_id,payload_version,event_fingerprint,armament_id,generation_id,
    previous_state,next_state,reason_code,occurred_at
  ) VALUES ($1,1,$2,$3,$4,'ARMED','REVOKED','ARMAMENT_REVOKED',
    TIMESTAMPTZ '2020-01-01T00:02:00.000Z')`, [
    activationEventId, '9'.repeat(64), armamentId, generationId,
  ]);
  await pool.query(`INSERT INTO execution_control_events (
    event_id,payload_version,event_fingerprint,generation_id,previous_state,next_state,
    reason_code,qualification_id,authorization_id,operator_id,occurred_at,actor_type,actor_id
  ) VALUES ($1,1,$2,$3,NULL,'ENTRY_STOP','OPERATOR_ENTRY_STOP',NULL,NULL,
    'operator-primary',TIMESTAMPTZ '2020-01-01T00:00:00.000Z','OPERATOR','operator-primary')`, [
    controlEventId, 'a'.repeat(64), generationId,
  ]);
  await pool.query(`INSERT INTO execution_control_state (
    generation_id,payload_version,state,state_revision,last_event_id,updated_at
  ) VALUES ($1,1,'ENTRY_STOP',1,$2,TIMESTAMPTZ '2020-01-01T00:00:00.000Z')`, [
    generationId, controlEventId,
  ]);
}

function testDatabaseUrl(context: Readonly<{ skip(message?: string): void }>): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') return databaseUrl;
  context.skip('TEST_DATABASE_URL absent: execution operations retention test skipped');
  return null;
}

async function withTemporarySchema(
  databaseUrl: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `execution_operations_retention_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl, max: 1,
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
