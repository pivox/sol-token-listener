import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '039_execution_canary_operator_binding.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);

void test('migration 039 defines V2 armament bindings and pre-signature locks', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const column of [
    'armament_request_fingerprint', 'canary_evidence_fingerprint', 'target_intent_id',
    'target_intent_state_revision', 'target_strategy_id', 'target_strategy_version',
    'target_decision_fingerprint', 'target_mint', 'target_quote_mint',
    'target_quote_amount_raw', 'target_admission_report_id', 'target_reservation_id',
    'target_policy_fingerprint', 'target_wallet_snapshot_fingerprint',
    'target_provider_snapshot_fingerprint', 'runtime_quote_max_age_ms',
    'runtime_slippage_bps', 'runtime_snapshot_max_slot_lag', 'runtime_max_compute_units',
    'runtime_max_fee_lamports', 'runtime_max_fee_payer_lamport_debit',
    'runtime_max_rpc_calls_per_attempt', 'runtime_lease_ms', 'locked_intent_id',
    'locked_attempt_number', 'locked_reservation_id', 'locked_lease_token', 'locked_at',
  ]) assert.match(sql, new RegExp(`ADD COLUMN(?: IF NOT EXISTS)? ${column}`, 'u'));
  assert.match(sql, /CREATE TABLE IF NOT EXISTS execution_pre_signature_locks/u);
  assert.match(sql, /octet_length\(unsigned_message_bytes\) BETWEEN 1 AND 1232/u);
  assert.match(sql, /octet_length\(unsigned_transaction_bytes\) BETWEEN 1 AND 1232/u);
  assert.match(sql, /state IN \('AUTHORIZED','SIGNED_PERSISTED','REVOKED'\)/u);
  assert.match(sql, /UNIQUE \(intent_id,attempt_number\)/u);
  assert.match(sql, /UNIQUE \(armament_id\)/u);
  assert.match(sql, /payload_version=1 AND state IN \('ARMED','LOCKED'\)/u);
  assert.match(sql, /cannot upgrade active V1 execution armament/u);
  assert.match(sql, /new V1 ARM authorization is forbidden/u);
  assert.match(sql, /octet_length\(target_strategy_id\) BETWEEN 1 AND 128/u);
  assert.match(sql, /runtime_quote_max_age_ms BETWEEN 1 AND 60000/u);
  assert.match(sql, /runtime_snapshot_max_slot_lag BETWEEN 0 AND 128/u);
  assert.match(sql, /runtime_max_fee_lamports <=10000000/u);
  assert.match(sql, /runtime_max_fee_payer_lamport_debit <=10000000000/u);
  assert.match(sql, /runtime_lease_ms BETWEEN 3000 AND 120000/u);
  assert.match(sql, /execution_pre_signature_locks_recovery_idx/u);
  assert.match(sql, /execution_pre_signature_locks_purge_idx/u);
  assert.match(sql, /state='AUTHORIZED' AND state_revision=0/u);
  assert.match(sql, /state IN \('SIGNED_PERSISTED','REVOKED'\) AND state_revision=1/u);
  assert.match(sql, /payload_version=2/u);
  assert.match(sql, /actor_type IN \('OPERATOR','SYSTEM'\)/u);
  assert.match(sql, /SYSTEM_PRE_SIGNATURE_LOCK_STRANDED/u);
  assert.match(sql, /SYSTEM_SUBMISSION_AMBIGUOUS/u);
  assert.match(sql, /SYSTEM_RECONCILIATION_UNKNOWN/u);
  assert.doesNotMatch(sql, /private[_ ]?key|keypair|send[_ ]?transaction/iu);
});

void test('migration 039 applies to an empty schema and replays cleanly', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), migrationName);
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await pool.query(await readFile(migrationUrl, 'utf8'));
    const tables = await pool.query<{ readonly table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema=current_schema()
        AND table_name='execution_pre_signature_locks'`);
    assert.equal(tables.rowCount, 1);
    await assert.rejects(
      pool.query(`INSERT INTO execution_activation_armaments (armament_id) VALUES ('execution_activation_armament_${'a'.repeat(64)}')`),
      /only V2 CANARY armament insert is permitted/u,
    );
    const constraints = await pool.query<{ readonly conname: string; readonly definition: string }>(`
      SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='execution_activation_armaments'::regclass
        AND conname IN ('execution_activation_armaments_identity_check',
          'execution_activation_armaments_state_check') ORDER BY conname`);
    assert.match(constraints.rows[0]?.definition ?? '', /runtime_lease_ms >= 3000/u);
    assert.match(constraints.rows[0]?.definition ?? '', /runtime_quote_max_age_ms <= 60000/u);
    assert.match(constraints.rows[0]?.definition ?? '', /target_strategy_id.*128/u);
    assert.match(constraints.rows[1]?.definition ?? '', /state_revision = 1/u);
    const lockConstraint = await pool.query<{ readonly definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='execution_pre_signature_locks'::regclass
        AND conname='execution_pre_signature_locks_state_check'`);
    assert.match(lockConstraint.rows[0]?.definition ?? '', /state_revision = 0/u);
    assert.match(lockConstraint.rows[0]?.definition ?? '', /state_revision = 1/u);
  });
});

void test('migration 039 rejects an upgrade with an active V1 armament', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await applyPriorMigrations(pool);
    await insertV1Armament(pool, 'ARMED');
    await assert.rejects(
      pool.query(await readFile(migrationUrl, 'utf8')),
      /cannot upgrade active V1 execution armament/u,
    );
  });
});

void test('migration 039 rejects an upgrade with a LOCKED V1 armament', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await applyPriorMigrations(pool);
    await insertV1Armament(pool, 'LOCKED');
    await assert.rejects(pool.query(await readFile(migrationUrl, 'utf8')),
      /cannot upgrade active V1 execution armament/u);
  });
});

void test('migration 039 preserves terminal V1 rows with null V2 bindings and backfills operators', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await applyPriorMigrations(pool);
    await insertV1Armament(pool, 'CONSUMED');
    await pool.query('SET session_replication_role = replica');
    await pool.query(`INSERT INTO execution_control_events (
      event_id,payload_version,event_fingerprint,generation_id,previous_state,next_state,
      reason_code,qualification_id,authorization_id,operator_id,occurred_at
    ) VALUES (
      'execution_control_event_${'9'.repeat(64)}',1,'${'8'.repeat(64)}',
      'execution_wallet_generation_${'7'.repeat(64)}','RUNNING','ENTRY_STOP',
      'OPERATOR_ENTRY_STOP',NULL,NULL,'operator',date_trunc('milliseconds',statement_timestamp())
    )`);
    await pool.query('SET session_replication_role = origin');
    await pool.query(await readFile(migrationUrl, 'utf8'));
    const preserved = await pool.query<{ readonly v2_columns_are_null: boolean }>(`
      SELECT ROW(armament_request_fingerprint,canary_evidence_fingerprint,target_intent_id,
        target_intent_state_revision,target_strategy_id,target_strategy_version,
        target_decision_fingerprint,target_mint,target_quote_mint,target_quote_amount_raw,
        target_admission_report_id,target_reservation_id,target_policy_fingerprint,
        target_wallet_snapshot_fingerprint,target_provider_snapshot_fingerprint,
        runtime_quote_max_age_ms,runtime_slippage_bps,runtime_snapshot_max_slot_lag,
        runtime_max_compute_units,runtime_max_fee_lamports,runtime_max_fee_payer_lamport_debit,
        runtime_max_rpc_calls_per_attempt,runtime_lease_ms,locked_intent_id,
        locked_attempt_number,locked_reservation_id,locked_lease_token,locked_at) IS NULL
        AS v2_columns_are_null
      FROM execution_activation_armaments WHERE payload_version=1`);
    assert.deepEqual(preserved.rows, [{ v2_columns_are_null: true }]);
    const actor = await pool.query<{ readonly actor_id: string }>(
      `SELECT actor_id FROM execution_control_events WHERE event_id='execution_control_event_${'9'.repeat(64)}'`,
    );
    assert.deepEqual(actor.rows, [{ actor_id: 'operator' }]);
  });
});

void test('V2 armament insert refuses an expiry after its qualification or target intent', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  for (const boundary of ['qualification', 'intent'] as const) {
    await withTemporarySchema(databaseUrl, async (pool) => {
      await migrateDatabase({ pool });
      await seedV2ArmamentPrerequisites(pool, boundary);
      await assert.rejects(insertV2Armament(pool), /guarded V2 armament insert required/u);
    });
  }
});

void test('V2 armament insert refuses a target whose intent and quote binding are not WSOL', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    await seedV2ArmamentPrerequisites(pool, 'non_wsol');
    await assert.rejects(insertV2Armament(pool, '4 minutes'), /guarded V2 armament insert required/u);
  });
});

void test('V2 ARM authorization insert refuses a validity longer than sixty seconds', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    await seedV2ArmamentPrerequisites(pool, 'valid');
    await assert.rejects(insertV2ArmAuthorization(pool, '61 seconds'), /authorization|constraint/u);
  });
});

void test('V2 armament insert rejects causal snapshot, gate, admission and reservation divergences', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  for (const variant of [
    'wallet_snapshot', 'provider_snapshot', 'wallet_gate', 'provider_gate',
    'wallet_superseded', 'provider_superseded', 'provider_expiry',
    'report_quota', 'report_quote', 'reservation_side', 'reservation_mint',
    'reservation_quote', 'reservation_amount',
  ] as const) {
    await withTemporarySchema(databaseUrl, async (pool) => {
      await migrateDatabase({ pool });
      await seedV2ArmamentPrerequisites(pool, variant);
      await assert.rejects(
        insertV2Armament(pool, '4 minutes', 'So11111111111111111111111111111111111111112'),
        /guarded V2 armament insert required/u,
        variant,
      );
    });
  }
});

void test('V2 armament insert requires a two-lease expiry margin', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    await seedV2ArmamentPrerequisites(pool, 'valid');
    await assert.rejects(
      insertV2Armament(pool, '5 seconds', 'So11111111111111111111111111111111111111112'),
      /guarded V2 armament insert required/u,
    );
  });
});

void test('pre-signature lock deletion waits for terminal retention and its signed artifact cohort', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  for (const mode of ['authorized', 'before_purge', 'signed_artifact'] as const) {
    await withTemporarySchema(databaseUrl, async (pool) => {
      await migrateDatabase({ pool });
      await insertPreSignatureLockFixture(pool, mode);
      await assert.rejects(pool.query(`DELETE FROM execution_pre_signature_locks
        WHERE lock_id='execution_pre_signature_lock_${'1'.repeat(64)}'`),
      /pre-signature lock deletion/u, mode);
      if (mode === 'signed_artifact') {
        await pool.query(`DELETE FROM execution_signed_transactions
          WHERE artifact_id='execution_signed_transaction_${'2'.repeat(64)}'`);
        await pool.query(`DELETE FROM execution_pre_signature_locks
          WHERE lock_id='execution_pre_signature_lock_${'1'.repeat(64)}'`);
      }
    });
  }
});

void test('pre-signature lock INSERT rejects a causally divergent raw row', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    const scenario = await prepareAuthorizedLockScenario(pool);
    await assert.rejects(
      insertAuthorizedLock(pool, scenario, '1', '0'.repeat(64)),
      /guarded pre-signature lock insert required/u,
    );
  });
});

void test('an AUTHORIZED pre-signature lock cannot commit without its exact V2 LOCKED armament', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    const scenario = await prepareAuthorizedLockScenario(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertAuthorizedLock(client, scenario, '2', 'b'.repeat(64));
      await assert.rejects(client.query('COMMIT'), /pre-signature lock requires exact locked V2 armament/u);
    } finally {
      try { await client.query('ROLLBACK'); } catch { /* transaction may already be closed */ }
      client.release();
    }
  });
});

void test('an AUTHORIZED pre-signature lock commits only with its exact V2 lock CAS', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    const scenario = await prepareAuthorizedLockScenario(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertAuthorizedLock(client, scenario, '3', 'b'.repeat(64));
      const updated = await client.query(`UPDATE execution_activation_armaments SET
        state='LOCKED',state_revision=1,consumed_buys=1,
        locked_intent_id=target_intent_id,locked_attempt_number=1,
        locked_reservation_id=target_reservation_id,locked_lease_token=$2::UUID,
        locked_at=date_trunc('milliseconds',statement_timestamp())
        WHERE armament_id=$1`, [scenario.armamentId, scenario.leaseToken]);
      assert.equal(updated.rowCount, 1);
      await client.query('COMMIT');
    } finally {
      try { await client.query('ROLLBACK'); } catch { /* transaction may already be closed */ }
      client.release();
    }
  });
});

interface AuthorizedLockScenario {
  readonly armamentId: string;
  readonly intentId: string;
  readonly reservationId: string;
  readonly generationId: string;
  readonly leaseToken: string;
}

async function prepareAuthorizedLockScenario(
  pool: InstanceType<typeof pg.Pool>,
): Promise<AuthorizedLockScenario> {
  await migrateDatabase({ pool });
  await seedV2ArmamentPrerequisites(pool, 'valid');
  await insertV2Armament(pool, '4 minutes', 'So11111111111111111111111111111111111111112');
  const intentId = `execution_intent_${'d'.repeat(64)}`;
  const leaseToken = '00000000-0000-0000-0000-000000000001';
  // This helper seeds the upstream claim/attempt state so the assertions exercise
  // the new pre-signature-lock triggers, not the intent transition machinery.
  await pool.query('SET session_replication_role = replica');
  try {
    await pool.query(`UPDATE execution_intents SET status='PROCESSING',attempt_count=1,
      state_revision=1,lease_owner='pre-signature-lock-test',lease_token=$2::UUID,
      lease_expires_at=date_trunc('milliseconds',statement_timestamp())+INTERVAL '30 seconds'
      WHERE id=$1`, [intentId, leaseToken]);
    await pool.query(`INSERT INTO execution_attempts (
      intent_id,attempt_number,status,provider_id,started_at
    ) VALUES ($1,1,'STARTED','provider',date_trunc('milliseconds',statement_timestamp()))`, [intentId]);
  } finally {
    await pool.query('SET session_replication_role = origin');
  }
  return Object.freeze({
    armamentId: `execution_activation_armament_${'0'.repeat(64)}`,
    intentId,
    reservationId: `execution_exposure_reservation_${'f'.repeat(64)}`,
    generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    leaseToken,
  });
}

async function insertAuthorizedLock(
  client: Pick<InstanceType<typeof pg.Pool>, 'query'>,
  scenario: AuthorizedLockScenario,
  seed: string,
  policyFingerprint: string,
): Promise<unknown> {
  return client.query(`INSERT INTO execution_pre_signature_locks (
    lock_id,lock_fingerprint,intent_id,attempt_number,intent_state_revision,armament_id,reservation_id,
    generation_id,wallet_public_key,provider_id,lease_token,message_hash,unsigned_message_bytes,
    unsigned_transaction_hash,unsigned_transaction_bytes,build_hash,configuration_fingerprint,
    strategy_fingerprint,decision_fingerprint,policy_fingerprint,wallet_snapshot_fingerprint,
    provider_snapshot_fingerprint,quote_fingerprint,blockhash,last_valid_block_height,state,state_revision
  ) VALUES (
    'execution_pre_signature_lock_${seed.repeat(64)}','${seed.repeat(64)}',$1,1,1,$2,$3,$4,
    '11111111111111111111111111111111','provider',$5::UUID,'${'7'.repeat(64)}',decode('aa','hex'),
    '${'8'.repeat(64)}',decode('bb','hex'),'${'2'.repeat(64)}','${'3'.repeat(64)}',
    '${'4'.repeat(64)}','${'8'.repeat(64)}',$6,'${'c'.repeat(64)}','${'d'.repeat(64)}',
    '${'0'.repeat(64)}','11111111111111111111111111111111',1,'AUTHORIZED',0
  )`, [scenario.intentId, scenario.armamentId, scenario.reservationId,
    scenario.generationId, scenario.leaseToken, policyFingerprint]);
}

async function seedV2ArmamentPrerequisites(
  pool: InstanceType<typeof pg.Pool>,
  variant: V2ArmamentPrerequisiteVariant,
): Promise<void> {
  const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
  const qualificationId = `execution_safety_qualification_${'b'.repeat(64)}`;
  const authorizationId = `execution_operator_authorization_${'c'.repeat(64)}`;
  const intentId = `execution_intent_${'d'.repeat(64)}`;
  const reportId = `execution_risk_admission_${'e'.repeat(64)}`;
  const reservationId = `execution_exposure_reservation_${'f'.repeat(64)}`;
  const now = `date_trunc('milliseconds',statement_timestamp())`;
  const qualificationExpiry = `${now} + INTERVAL '5 minutes'`;
  const intentExpiry = variant === 'intent'
    ? `${now} + INTERVAL '30 seconds'`
    : `${now} + INTERVAL '10 minutes'`;
  const authorizationExpiry = `${now} + INTERVAL '60 seconds'`;
  const quoteMint = variant === 'non_wsol'
    ? '11111111111111111111111111111111'
    : 'So11111111111111111111111111111111111111112';
  const walletSnapshotFingerprint = variant === 'wallet_snapshot' ? '0'.repeat(64) : 'c'.repeat(64);
  const providerSnapshotFingerprint = variant === 'provider_snapshot' ? '0'.repeat(64) : 'd'.repeat(64);
  const walletGateFingerprint = variant === 'wallet_gate' ? '0'.repeat(64) : walletSnapshotFingerprint;
  const providerGateFingerprint = variant === 'provider_gate' ? '0'.repeat(64) : providerSnapshotFingerprint;
  const providerExpiry = variant === 'provider_expiry'
    ? `${now} + INTERVAL '5 seconds'`
    : `${now} + INTERVAL '5 minutes'`;
  await pool.query('SET session_replication_role = replica');
  try {
    await pool.query(`INSERT INTO execution_wallet_generations (
      generation_id,wallet_public_key,cluster,genesis_hash,generation
    ) VALUES ($1,'11111111111111111111111111111111','mainnet-beta',
      '11111111111111111111111111111111',1)`, [generationId]);
    await pool.query(`INSERT INTO execution_wallet_risk_state (
      generation_id,reconciled_capital_lamports,reserved_exposure_raw,conservative_drawdown_raw,unknown_block
    ) VALUES ($1,0,0,0,FALSE)`, [generationId]);
    await pool.query(`INSERT INTO execution_control_state (generation_id,state) VALUES ($1,'RUNNING')`, [generationId]);
    await pool.query(`INSERT INTO execution_safety_qualifications (
      qualification_id,evaluator_version,qualification_fingerprint,phase,build_hash,configuration_fingerprint,
      strategy_fingerprint,generation_id,wallet_public_key,cluster,genesis_hash,provider_id,
      qualified_at,expires_at,purge_after
    ) VALUES ($1,1,'${'1'.repeat(64)}','CANARY','${'2'.repeat(64)}','${'3'.repeat(64)}',
      '${'4'.repeat(64)}',$2,'11111111111111111111111111111111','mainnet-beta',
      '11111111111111111111111111111111','provider',${now},${qualificationExpiry},${qualificationExpiry}+INTERVAL '4 hours')`,
    [qualificationId, generationId]);
    await pool.query(`INSERT INTO execution_operator_authorizations (
      authorization_id,payload_version,authorization_fingerprint,generation_id,action,phase,
      context_fingerprint,nonce_hash,operator_id,issued_at,expires_at,consumed_at,purge_after
    ) VALUES ($1,2,'${'5'.repeat(64)}',$2,'ARM','CANARY','${'6'.repeat(64)}',
      '${'7'.repeat(64)}','operator',${now},${authorizationExpiry},${now},${now}+INTERVAL '4 hours')`,
    [authorizationId, generationId]);
    await pool.query(`INSERT INTO execution_intents (
      id,logical_order_key,strategy_id,strategy_version,position_id,logical_command_id,mint,side,
      venue_policy,quote_mint,quote_token_program,quote_decimals,quote_amount_raw,
      minimum_amount_out_raw,decision_event_id,decision_fingerprint,requested_at,expires_at,status
    ) VALUES ($1,'order','strategy',1,'position','command','11111111111111111111111111111111','BUY',
      'PUMP_FUN_ONLY',$2,'SPL_TOKEN',9,1,1,'decision','${'8'.repeat(64)}',
      ${now},${intentExpiry},'PENDING')`, [intentId, quoteMint]);
    await pool.query(`INSERT INTO execution_wallet_snapshots (
      snapshot_id,snapshot_fingerprint,generation_id,provider_id,state_revision,slot,observed_at,
      commitment,wallet_lamports,token_balance_count,open_positions,realized_net_pnl_raw,
      superseded_at,purge_after
    ) VALUES ('execution_wallet_snapshot_${'a'.repeat(64)}',$1,$2,'provider',0,1,
      ${now}-INTERVAL '1 second','finalized',1,0,0,0,
      CASE WHEN $3::BOOLEAN THEN ${now} ELSE NULL END,
      CASE WHEN $3::BOOLEAN THEN ${now}+INTERVAL '4 hours' ELSE NULL END)`, [
      walletSnapshotFingerprint, generationId, variant === 'wallet_superseded',
    ]);
    await pool.query(`INSERT INTO execution_provider_usage_snapshots (
      snapshot_id,snapshot_fingerprint,provider_id,plan_id,billing_period_id,billing_period_started_at,
      billing_period_ends_at,limit_units,used_units,measured_at,expires_at,provenance,superseded_at,purge_after
    ) VALUES ('execution_provider_usage_${'b'.repeat(64)}',$1,'provider','plan','period',
      ${now}-INTERVAL '1 minute',${now}+INTERVAL '10 minutes',100,0,${now}-INTERVAL '1 second',${providerExpiry},
      'OPERATOR_REPORT',CASE WHEN $2::BOOLEAN THEN ${now} ELSE NULL END,
      CASE WHEN $2::BOOLEAN THEN ${now}+INTERVAL '4 hours' ELSE NULL END)`, [
      providerSnapshotFingerprint, variant === 'provider_superseded',
    ]);
    await pool.query(`INSERT INTO execution_safety_gate_evidence (
      qualification_id,gate_index,gate_id,status,evidence_type,evidence_id,evidence_fingerprint,observed_at,expires_at
    ) VALUES
      ($1,7,'PROVIDER_EXIT_CAPACITY_VERIFIED','PASSED','PROVIDER_SNAPSHOT',
        'execution_provider_usage_${'b'.repeat(64)}',$2,${now}-INTERVAL '1 second',${now}+INTERVAL '5 minutes'),
      ($1,9,'WALLET_CHAIN_LIMITS_VERIFIED','PASSED','WALLET_SNAPSHOT',
        'execution_wallet_snapshot_${'a'.repeat(64)}',$3,${now}-INTERVAL '1 second',${now}+INTERVAL '5 minutes')`, [
      qualificationId, providerGateFingerprint, walletGateFingerprint,
    ]);
    await pool.query(`INSERT INTO execution_risk_admission_reports (
      report_id,report_fingerprint,input_fingerprint,intent_id,generation_id,policy_fingerprint,
      wallet_snapshot_fingerprint,provider_snapshot_fingerprint,decision,quote_amount_raw,
      projected_capital_raw,projected_exposure_raw,projected_drawdown_raw,quota_state,wallet_state_revision
    ) VALUES ($1,'${'9'.repeat(64)}','${'a'.repeat(64)}',$2,$3,'${'b'.repeat(64)}','${'c'.repeat(64)}',
      '${'d'.repeat(64)}','ADMITTED',$4,1,1,0,$5,0)`, [
      reportId, intentId, generationId, variant === 'report_quote' ? 2 : 1,
      variant === 'report_quota' ? 'ENTRY_BLOCKED' : 'NORMAL',
    ]);
    await pool.query(`INSERT INTO execution_exposure_reservations (
      reservation_id,intent_id,generation_id,admission_report_id,position_id,side,mint,quote_mint,
      maximum_amount_raw,intent_fingerprint,policy_fingerprint,wallet_snapshot_fingerprint,
      provider_snapshot_fingerprint,state
    ) VALUES ($1,$2,$3,$4,'position',$5,$6,$7,$8,'${'e'.repeat(64)}','${'b'.repeat(64)}','${'c'.repeat(64)}',
      '${'d'.repeat(64)}','RESERVED')`, [
      reservationId, intentId, generationId, reportId,
      variant === 'reservation_side' ? 'SELL' : 'BUY',
      variant === 'reservation_mint' ? 'So11111111111111111111111111111111111111112' : '11111111111111111111111111111111',
      variant === 'reservation_quote' ? '11111111111111111111111111111111' : quoteMint,
      variant === 'reservation_amount' ? 2 : 1,
    ]);
  } finally {
    await pool.query('SET session_replication_role = origin');
  }
}

async function insertV2Armament(
  pool: InstanceType<typeof pg.Pool>,
  expiresIn = '6 minutes',
  quoteMint = '11111111111111111111111111111111',
): Promise<unknown> {
  return pool.query(`INSERT INTO execution_activation_armaments (
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
    runtime_max_fee_lamports,runtime_max_fee_payer_lamport_debit,runtime_max_rpc_calls_per_attempt,runtime_lease_ms
  ) VALUES (
    'execution_activation_armament_${'0'.repeat(64)}',2,'${'1'.repeat(64)}',
    'execution_safety_qualification_${'b'.repeat(64)}','${'1'.repeat(64)}',
    'execution_wallet_generation_${'a'.repeat(64)}','execution_operator_authorization_${'c'.repeat(64)}',
    'ARMED','CANARY','${'2'.repeat(64)}','${'3'.repeat(64)}','${'4'.repeat(64)}',
    '11111111111111111111111111111111','mainnet-beta','11111111111111111111111111111111',
    'provider',1,1,500,1,30000,'operator','reason',date_trunc('milliseconds',statement_timestamp()),
    date_trunc('milliseconds',statement_timestamp())+INTERVAL '${expiresIn}','${'6'.repeat(64)}',
    '${'7'.repeat(64)}','execution_intent_${'d'.repeat(64)}',0,'strategy',1,'${'8'.repeat(64)}',
    '11111111111111111111111111111111',$1,1,
    'execution_risk_admission_${'e'.repeat(64)}','execution_exposure_reservation_${'f'.repeat(64)}',
    '${'b'.repeat(64)}','${'c'.repeat(64)}','${'d'.repeat(64)}',60000,0,128,1400000,10000000,
    10000000000,12,3000
  )`, [quoteMint]);
}

type V2ArmamentPrerequisiteVariant = 'qualification' | 'intent' | 'non_wsol' | 'valid'
  | 'wallet_snapshot' | 'provider_snapshot' | 'wallet_gate' | 'provider_gate'
  | 'wallet_superseded' | 'provider_superseded' | 'provider_expiry'
  | 'report_quota' | 'report_quote' | 'reservation_side' | 'reservation_mint'
  | 'reservation_quote' | 'reservation_amount';

async function insertV2ArmAuthorization(
  pool: InstanceType<typeof pg.Pool>,
  expiresIn: string,
): Promise<unknown> {
  return pool.query(`INSERT INTO execution_operator_authorizations (
    authorization_id,payload_version,authorization_fingerprint,generation_id,action,phase,
    context_fingerprint,nonce_hash,operator_id,issued_at,expires_at,purge_after
  ) VALUES ('execution_operator_authorization_${'0'.repeat(64)}',2,'${'f'.repeat(64)}',
    'execution_wallet_generation_${'a'.repeat(64)}','ARM','CANARY','${'e'.repeat(64)}',
    '${'d'.repeat(64)}','operator',date_trunc('milliseconds',statement_timestamp()),
    date_trunc('milliseconds',statement_timestamp())+INTERVAL '${expiresIn}',
    date_trunc('milliseconds',statement_timestamp())+INTERVAL '${expiresIn}'+INTERVAL '4 hours')`);
}

async function insertPreSignatureLockFixture(
  pool: InstanceType<typeof pg.Pool>,
  mode: 'authorized' | 'before_purge' | 'signed_artifact',
): Promise<void> {
  const terminal = mode === 'authorized' ? 'NULL' : mode === 'before_purge'
    ? "date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 hour'"
    : "date_trunc('milliseconds',statement_timestamp())-INTERVAL '5 hours'";
  const purgeAfter = mode === 'authorized' ? 'NULL' : mode === 'before_purge'
    ? "date_trunc('milliseconds',statement_timestamp())+INTERVAL '3 hours'"
    : "date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 hour'";
  await pool.query('SET session_replication_role = replica');
  try {
    await pool.query(`INSERT INTO execution_pre_signature_locks (
      lock_id,lock_fingerprint,intent_id,attempt_number,intent_state_revision,armament_id,reservation_id,
      generation_id,wallet_public_key,provider_id,lease_token,message_hash,unsigned_message_bytes,
      unsigned_transaction_hash,unsigned_transaction_bytes,build_hash,configuration_fingerprint,
      strategy_fingerprint,decision_fingerprint,policy_fingerprint,wallet_snapshot_fingerprint,
      provider_snapshot_fingerprint,quote_fingerprint,blockhash,last_valid_block_height,state,state_revision,
      authorized_at,terminal_at,purge_after
    ) VALUES ('execution_pre_signature_lock_${'1'.repeat(64)}','${'2'.repeat(64)}',
      'execution_intent_${'3'.repeat(64)}',1,1,'execution_activation_armament_${'4'.repeat(64)}',
      'execution_exposure_reservation_${'5'.repeat(64)}','execution_wallet_generation_${'6'.repeat(64)}',
      '11111111111111111111111111111111','provider','00000000-0000-0000-0000-000000000001',
      '${'7'.repeat(64)}',decode('aa','hex'),'${'8'.repeat(64)}',decode('bb','hex'),'${'9'.repeat(64)}',
      '${'a'.repeat(64)}','${'b'.repeat(64)}','${'c'.repeat(64)}','${'d'.repeat(64)}','${'e'.repeat(64)}',
      '${'f'.repeat(64)}','${'0'.repeat(64)}','11111111111111111111111111111111',1,
      $1,$2,date_trunc('milliseconds',statement_timestamp())-INTERVAL '6 hours',${terminal},${purgeAfter})`, [
      mode === 'authorized' ? 'AUTHORIZED' : 'SIGNED_PERSISTED', mode === 'authorized' ? 0 : 1,
    ]);
    if (mode === 'signed_artifact') {
      await pool.query(`INSERT INTO execution_signed_transactions (
        artifact_id,payload_version,specification_version,intent_id,attempt_number,generation_id,
        armament_id,reservation_id,provider_id,wallet_public_key,side,effective_venue,message_hash,
        build_fingerprint,snapshot_fingerprint,quote_fingerprint,quote_observed_at,quote_expires_at,
        blockhash,last_valid_block_height,signature,signed_transaction_bytes,signed_transaction_hash,
        state,state_revision,signed_at,revoked_at,purge_after
      ) VALUES ('execution_signed_transaction_${'2'.repeat(64)}',1,1,'execution_intent_${'3'.repeat(64)}',1,
        'execution_wallet_generation_${'6'.repeat(64)}','execution_activation_armament_${'4'.repeat(64)}',
        'execution_exposure_reservation_${'5'.repeat(64)}','provider','11111111111111111111111111111111',
        'BUY','PUMP_FUN','${'7'.repeat(64)}','${'9'.repeat(64)}','${'e'.repeat(64)}','${'0'.repeat(64)}',
        date_trunc('milliseconds',statement_timestamp())-INTERVAL '7 hours',
        date_trunc('milliseconds',statement_timestamp())-INTERVAL '5 hours',
        '11111111111111111111111111111111',1,'${'1'.repeat(64)}',decode('cc','hex'),'${'8'.repeat(64)}',
        'REVOKED_NO_SEND',1,date_trunc('milliseconds',statement_timestamp())-INTERVAL '6 hours',
        date_trunc('milliseconds',statement_timestamp())-INTERVAL '5 hours',
        date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 hour')`);
    }
  } finally {
    await pool.query('SET session_replication_role = origin');
  }
}

async function applyPriorMigrations(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  const migrationsDirectory = new URL('../migrations/', import.meta.url);
  const priorMigrations = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name) && name < migrationName)
    .sort((left, right) => left.localeCompare(right));
  for (const name of priorMigrations) {
    await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
}

async function insertV1Armament(pool: InstanceType<typeof pg.Pool>, state: 'ARMED' | 'LOCKED' | 'CONSUMED'): Promise<void> {
  await pool.query('SET session_replication_role = replica');
  try {
    await pool.query(`
      INSERT INTO execution_activation_armaments (
        armament_id,payload_version,armament_fingerprint,qualification_id,qualification_fingerprint,
        generation_id,authorization_id,state,phase,build_hash,configuration_fingerprint,
        strategy_fingerprint,wallet_public_key,cluster,genesis_hash,provider_id,maximum_buys,
        consumed_buys,maximum_capital_lamports,maximum_exposure_bps,maximum_open_positions,
        maximum_holding_ms,operator_id,operator_reason,armed_at,expires_at,terminal_at,purge_after
      ) VALUES (
        'execution_activation_armament_${'a'.repeat(64)}',1,'${'b'.repeat(64)}',
        'execution_safety_qualification_${'c'.repeat(64)}','${'d'.repeat(64)}',
        'execution_wallet_generation_${'e'.repeat(64)}','execution_operator_authorization_${'f'.repeat(64)}',
        $1,'CANARY','${'1'.repeat(64)}','${'2'.repeat(64)}','${'3'.repeat(64)}',
        '11111111111111111111111111111111','mainnet-beta','11111111111111111111111111111111',
        'provider',1,CASE WHEN $1='CONSUMED' THEN 1 ELSE 0 END,1,500,1,30000,'operator','reason',
        date_trunc('milliseconds',statement_timestamp()),
        date_trunc('milliseconds',statement_timestamp()) + INTERVAL '1 minute',
        CASE WHEN $1='CONSUMED' THEN date_trunc('milliseconds',statement_timestamp()) ELSE NULL END,
        CASE WHEN $1='CONSUMED' THEN date_trunc('milliseconds',statement_timestamp()) + INTERVAL '4 hours' ELSE NULL END
      )`, [state]);
  } finally {
    await pool.query('SET session_replication_role = origin');
  }
}

function testDatabaseUrl(context: Readonly<{ skip(message?: string): void }>): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') return databaseUrl;
  context.skip('TEST_DATABASE_URL absent: execution canary migration test skipped');
  return null;
}

async function withTemporarySchema(
  databaseUrl: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `execution_canary_migration_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
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
