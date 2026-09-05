import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { acquireExecutorRoleTestLock } from './postgres-role-test-lock.js';

const migrationName = '040_execution_worker_live_partition.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);
const partitionedTables = Object.freeze([
  'execution_intents',
  'execution_dry_run_assessments',
  'execution_attempts',
  'execution_intent_transitions',
  'execution_simulation_artifacts',
] as const);
const childTables = partitionedTables.slice(1);

void test('migration 040 declares the monotone worker/live row partition', async () => {
  const migration = withoutSqlComments(await readFile(migrationUrl, 'utf8'));

  assert.match(migration,
    /ALTER TABLE execution_intents[\s\S]*ADD COLUMN(?: IF NOT EXISTS)? live_reserved BOOLEAN NOT NULL DEFAULT FALSE/iu);
  for (const table of partitionedTables) {
    assert.match(migration,
      new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'iu'), table);
    assert.doesNotMatch(migration,
      new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'iu'), table);
  }
  for (const child of childTables) {
    assert.doesNotMatch(migration,
      new RegExp(`ALTER TABLE ${child}[^;]*ADD COLUMN[^;]*live_reserved`, 'iu'), child);
  }
  assert.doesNotMatch(migration, /'sol_token_executor_worker'::regrole/iu);
  assert.match(migration, /pg_roles/iu);
  assert.match(migration, /pg_has_role/iu);
  assert.match(migration, /session_user/iu);
});

void test('PostgreSQL 16 migration 040 backfills only live parents and enables non-forced RLS',
  async (context) => {
    const configuredUrl = process.env.TEST_EXECUTOR_ROLE_DATABASE_URL;
    if (configuredUrl === undefined || configuredUrl.trim() === '') {
      context.skip('TEST_EXECUTOR_ROLE_DATABASE_URL is required for the disposable role cluster.');
      return;
    }
    const baseUrl = new URL(configuredUrl);
    const maintenance = new pg.Pool({ connectionString: baseUrl.href });
    const suffix = randomUUID().replaceAll('-', '');
    const databaseName = `h2j_partition_${suffix}`;
    const isolatedUrl = new URL(baseUrl);
    isolatedUrl.pathname = `/${databaseName}`;
    let isolated: InstanceType<typeof pg.Pool> | undefined;
    let databaseCreated = false;
    let release: (() => Promise<void>) | undefined;
    let bodyFailure: unknown;
    try {
      const capability = await postgres16Capability(maintenance);
      if (!capability) {
        context.skip('PostgreSQL 16 superuser with CREATEDB is required.');
      } else {
        release = await acquireExecutorRoleTestLock(maintenance);
        await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0`);
        databaseCreated = true;
        isolated = new pg.Pool({ connectionString: isolatedUrl.href, max: 3 });
        await applyMigrationsBefore040(isolated);
        const expected = await seedHistoricalLiveRoots(isolated);

        const absentRole = `h2j_absent_${suffix.slice(0, 24)}`;
        assert.equal((await maintenance.query<{ readonly present: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS present', [absentRole],
        )).rows[0]?.present, false);
        const migrationSql = (await readFile(migrationUrl, 'utf8'))
          .replaceAll('sol_token_executor_worker', absentRole);
        await isolated.query(migrationSql);

        const reservation = await isolated.query<{
          readonly id: string;
          readonly live_reserved: boolean;
        }>('SELECT id,live_reserved FROM execution_intents ORDER BY id');
        assert.deepEqual(
          Object.fromEntries(reservation.rows.map((row) => [row.id, row.live_reserved])),
          Object.fromEntries(expected.map((id) => [id, id !== intentId('0')])),
        );
        const columns = await isolated.query<{ readonly table_name: string }>(
          `SELECT table_name FROM information_schema.columns
            WHERE table_schema='public' AND column_name='live_reserved'
              AND table_name=ANY($1::TEXT[]) ORDER BY table_name`, [partitionedTables],
        );
        assert.deepEqual(columns.rows, [{ table_name: 'execution_intents' }]);
        const rls = await isolated.query<{
          readonly relation_name: string;
          readonly enabled: boolean;
          readonly forced: boolean;
          readonly restrictive_policies: string;
        }>(`SELECT class.relname AS relation_name,class.relrowsecurity AS enabled,
            class.relforcerowsecurity AS forced,
            COUNT(policy.oid) FILTER (WHERE NOT policy.polpermissive)::TEXT AS restrictive_policies
          FROM pg_class class
          JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
          LEFT JOIN pg_policy policy ON policy.polrelid=class.oid
          WHERE namespace.nspname='public' AND class.relname=ANY($1::TEXT[])
          GROUP BY class.oid,class.relname,class.relrowsecurity,class.relforcerowsecurity
          ORDER BY class.relname`, [partitionedTables]);
        assert.deepEqual(rls.rows, [...partitionedTables].sort().map((relationName) => ({
          relation_name: relationName, enabled: true, forced: false, restrictive_policies: '1',
        })));
        const guards = await isolated.query<{
          readonly relation_name: string;
          readonly guard_count: string;
          readonly all_security_definer: boolean;
          readonly all_search_path_closed: boolean;
          readonly public_execute_count: string;
        }>(`SELECT class.relname AS relation_name,
            COUNT(trigger.oid)::TEXT AS guard_count,
            bool_and(procedure.prosecdef) AS all_security_definer,
            bool_and(procedure.proconfig @> ARRAY['search_path=pg_catalog, public']::TEXT[]
              OR procedure.proconfig @> ARRAY['search_path=pg_catalog,public']::TEXT[])
              AS all_search_path_closed,
            COUNT(*) FILTER (WHERE has_function_privilege('public',procedure.oid,'EXECUTE'))::TEXT
              AS public_execute_count
          FROM pg_class class
          JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
          JOIN pg_trigger trigger ON trigger.tgrelid=class.oid AND NOT trigger.tgisinternal
          JOIN pg_proc procedure ON procedure.oid=trigger.tgfoid
          WHERE namespace.nspname='public' AND class.relname=ANY($1::TEXT[])
            AND (trigger.tgtype & 2)=2 AND (trigger.tgtype & 4)=4 AND (trigger.tgtype & 16)=16
          GROUP BY class.relname ORDER BY class.relname`, [childTables]);
        assert.deepEqual(guards.rows, [...childTables].sort().map((relationName) => ({
          relation_name: relationName, guard_count: '1', all_security_definer: true,
          all_search_path_closed: true, public_execute_count: '0',
        })));

        await isolated.query('UPDATE execution_intents SET live_reserved=TRUE WHERE id=$1', [
          intentId('0'),
        ]);
        await assert.rejects(
          isolated.query('UPDATE execution_intents SET live_reserved=FALSE WHERE id=$1', [
            intentId('0'),
          ]),
          /live_reserved|monotone|reserved/iu,
        );
      }
    } catch (error) {
      bodyFailure = error;
    }
    const cleanupFailures = await collectCleanupFailures([
      async () => { if (isolated !== undefined) await isolated.end(); },
      async () => {
        if (databaseCreated) {
          await maintenance.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname=$1 AND pid<>pg_backend_pid()`, [databaseName]);
          await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
        }
      },
      async () => { if (release !== undefined) await release(); },
      async () => maintenance.end(),
    ]);
    if (bodyFailure !== undefined) {
      throw new AggregateError([bodyFailure, ...cleanupFailures], 'Migration 040 test failed.', {
        cause: bodyFailure,
      });
    }
    if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'Cleanup failed.');
  });

async function applyMigrationsBefore040(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  const directory = new URL('../migrations/', import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => /^\d{3}_[a-z0-9_-]+\.sql$/u.test(name) && name < migrationName)
    .sort((left, right) => left.localeCompare(right));
  assert.equal(names.at(-1), '039_execution_canary_operator_binding.sql');
  for (const name of names) {
    await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
}

async function seedHistoricalLiveRoots(pool: InstanceType<typeof pg.Pool>): Promise<readonly string[]> {
  const ids = '01234567'.split('').map(intentId);
  for (const [index, id] of ids.entries()) await insertIntent(pool, id, index);
  await pool.query('SET session_replication_role=replica');
  try {
    await insertArmament(pool, ids[1] ?? '', 'ARMED', '1');
    await insertArmament(pool, ids[2] ?? '', 'LOCKED', '2');
    await pool.query(`INSERT INTO execution_pre_signature_locks (
      lock_id,lock_fingerprint,intent_id,attempt_number,intent_state_revision,armament_id,
      reservation_id,generation_id,wallet_public_key,provider_id,lease_token,message_hash,
      unsigned_message_bytes,unsigned_transaction_hash,unsigned_transaction_bytes,build_hash,
      configuration_fingerprint,strategy_fingerprint,decision_fingerprint,policy_fingerprint,
      wallet_snapshot_fingerprint,provider_snapshot_fingerprint,effective_venue,market_snapshot_slot,
      market_snapshot_fingerprint,quote_fingerprint,quote_observed_at,quote_expires_at,
      unsigned_simulation_fingerprint,blockhash,last_valid_block_height,state,state_revision,authorized_at
    ) VALUES ($1,$2,$3,1,1,$4,$5,$6,$7,'provider',$8,$9,decode('aa','hex'),$10,
      decode('bb','hex'),$11,$12,$13,$14,$15,$16,$17,'PUMP_FUN',1,$18,$19,$20,$21,$22,$7,1,
      'AUTHORIZED',0,$20)`, [
      entityId('execution_pre_signature_lock', '3'), hex('3'), ids[3],
      entityId('execution_activation_armament', '3'),
      entityId('execution_exposure_reservation', '3'),
      entityId('execution_wallet_generation', '3'), base58('3'), randomUUID(), hex('4'),
      hex('5'), hex('6'), hex('7'), hex('8'), hex('9'), hex('a'), hex('b'), hex('c'),
      hex('d'), hex('e'), timestamp(-2), timestamp(2), hex('f'),
    ]);
    await pool.query(`INSERT INTO execution_signed_transactions (
      artifact_id,specification_version,intent_id,attempt_number,generation_id,
      exit_authorization_id,provider_id,wallet_public_key,side,effective_venue,message_hash,
      build_fingerprint,snapshot_fingerprint,quote_fingerprint,quote_observed_at,quote_expires_at,
      blockhash,last_valid_block_height,signature,signed_transaction_bytes,signed_transaction_hash,
      state,signed_at
    ) VALUES ($1,1,$2,1,$3,$4,'provider',$5,'SELL','PUMP_SWAP',$6,$7,$8,$9,$10,$11,
      $5,1,$12,decode('aa','hex'),$13,'PERSISTED',$10)`, [
      entityId('execution_signed_transaction', '4'), ids[4],
      entityId('execution_wallet_generation', '4'),
      entityId('execution_exit_authorization', '4'), base58('4'), hex('4'), hex('5'),
      hex('6'), hex('7'), timestamp(-2), timestamp(2), base58('5', 64), hex('8'),
    ]);
    await pool.query(`INSERT INTO execution_live_positions (
      position_id,buy_intent_id,generation_id,armament_id,wallet_public_key,mint,quote_mint,
      entry_venue,quote_cost_raw,base_amount_raw,remaining_base_raw,fee_lamports,
      maximum_holding_ms,opened_at,exit_deadline_at,entry_reconciliation_fingerprint,
      state,exit_intent_id
    ) VALUES ($1,$2,$3,$4,$5,$5,$5,'PUMP_FUN',1,1,1,0,30000,$6::TIMESTAMPTZ,
      $6::TIMESTAMPTZ+INTERVAL '30 seconds',
      $7,'EXIT_PENDING',$8)`, [
      entityId('execution_live_position', '5'), ids[5],
      entityId('execution_wallet_generation', '5'),
      entityId('execution_activation_armament', '5'), base58('6'), timestamp(-1), hex('9'), ids[6],
    ]);
    await pool.query(`INSERT INTO execution_exit_authorizations (
      authorization_id,position_id,generation_id,wallet_public_key,mint,quote_mint,
      maximum_base_amount_raw,state,state_revision,locked_intent_id,locked_attempt_number,created_at
    ) VALUES ($1,$2,$3,$4,$4,$4,1,'LOCKED',1,$5,1,$6)`, [
      entityId('execution_exit_authorization', '7'),
      entityId('execution_live_position', '7'),
      entityId('execution_wallet_generation', '7'), base58('7'), ids[7], timestamp(-1),
    ]);
  } finally {
    await pool.query('SET session_replication_role=origin');
  }
  return ids;
}

async function insertIntent(
  pool: InstanceType<typeof pg.Pool>, id: string, index: number,
): Promise<void> {
  await pool.query(`INSERT INTO execution_intents (
    id,logical_order_key,strategy_id,strategy_version,position_id,logical_command_id,mint,side,
    venue_policy,quote_mint,quote_token_program,quote_decimals,quote_amount_raw,
    minimum_amount_out_raw,decision_event_id,decision_fingerprint,requested_at,expires_at,status
  ) VALUES ($1,$2,'strategy',1,$3,$4,$5,'BUY','PUMP_FUN_ONLY',$5,'SPL_TOKEN',9,1,1,$6,$7,$8,$9,'PENDING')`, [
    id, `order-${index}`, `position-${index}`, `command-${index}`, base58(String(index + 1)),
    `decision-${index}`, hex(String(index)), timestamp(-1), timestamp(3),
  ]);
}

async function insertArmament(
  pool: InstanceType<typeof pg.Pool>, targetIntentId: string,
  state: 'ARMED' | 'LOCKED', marker: string,
): Promise<void> {
  const locked = state === 'LOCKED';
  await pool.query(`INSERT INTO execution_activation_armaments (
    armament_id,payload_version,armament_fingerprint,qualification_id,qualification_fingerprint,
    generation_id,authorization_id,state,state_revision,phase,build_hash,configuration_fingerprint,
    strategy_fingerprint,wallet_public_key,cluster,genesis_hash,provider_id,maximum_buys,
    consumed_buys,maximum_capital_lamports,maximum_exposure_bps,maximum_open_positions,
    maximum_holding_ms,operator_id,operator_reason,armed_at,expires_at,armament_request_fingerprint,
    canary_evidence_fingerprint,target_intent_id,target_intent_state_revision,target_strategy_id,
    target_strategy_version,target_decision_fingerprint,target_mint,target_quote_mint,
    target_quote_amount_raw,target_admission_report_id,target_reservation_id,target_policy_fingerprint,
    target_wallet_snapshot_fingerprint,target_provider_snapshot_fingerprint,runtime_quote_max_age_ms,
    runtime_slippage_bps,runtime_snapshot_max_slot_lag,runtime_max_compute_units,
    runtime_max_fee_lamports,runtime_max_fee_payer_lamport_debit,runtime_max_rpc_calls_per_attempt,
    runtime_lease_ms,locked_intent_id,locked_attempt_number,locked_reservation_id,
    locked_lease_token,locked_at
  ) VALUES ($1,2,$2,$3,$4,$5,$6,$7,$8,'CANARY',$9,$10,$11,$12,'mainnet-beta',$12,
    'provider',1,$13,1,500,1,30000,'operator','partition test',$14,$15,$16,$17,$18,0,
    'strategy',1,$19,$12,$12,1,$20,$21,$22,$23,$24,60000,0,128,1400000,10000000,
    10000000000,12,3000,$25,$26,$27,$28,$29)`, [
    entityId('execution_activation_armament', marker), hex(marker),
    entityId('execution_safety_qualification', marker), hex('a'),
    entityId('execution_wallet_generation', marker),
    entityId('execution_operator_authorization', marker), state, locked ? 1 : 0,
    hex('b'), hex('c'), hex('d'), base58(marker), locked ? 1 : 0,
    timestamp(-1), timestamp(3), hex('e'), hex('f'), targetIntentId, hex(marker),
    entityId('execution_risk_admission', marker),
    entityId('execution_exposure_reservation', marker), hex('a'), hex('b'), hex('c'),
    locked ? targetIntentId : null, locked ? 1 : null,
    locked ? entityId('execution_exposure_reservation', marker) : null,
    locked ? randomUUID() : null, locked ? timestamp(0) : null,
  ]);
}

function intentId(marker: string): string {
  return entityId('execution_intent', marker);
}

function entityId(prefix: string, marker: string): string {
  return `${prefix}_${hex(marker)}`;
}

function hex(marker: string): string {
  return marker.repeat(64).slice(0, 64).replace(/[^0-9a-f]/gu, 'a');
}

function base58(marker: string, length = 32): string {
  return marker.replaceAll('0', '1').repeat(length).slice(0, length);
}

function timestamp(offsetMinutes: number): Date {
  const value = new Date(Date.now() + offsetMinutes * 60_000);
  value.setMilliseconds(0);
  return value;
}

function withoutSqlComments(sql: string): string {
  return sql.replace(/--[^\r\n]*/gu, ' ').replace(/\/\*[\s\S]*?\*\//gu, ' ');
}

async function postgres16Capability(pool: InstanceType<typeof pg.Pool>): Promise<boolean> {
  const row = (await pool.query<{
    readonly rolsuper: boolean;
    readonly rolcreatedb: boolean;
    readonly server_version_number: number;
  }>(`SELECT rolsuper,rolcreatedb,
      current_setting('server_version_num')::INTEGER AS server_version_number
    FROM pg_roles WHERE rolname=current_user`)).rows[0];
  return row !== undefined && row.rolsuper && row.rolcreatedb
    && row.server_version_number >= 160_000 && row.server_version_number < 170_000;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

type Cleanup = () => unknown;

async function collectCleanupFailures(cleanups: readonly Cleanup[]): Promise<Error[]> {
  const failures: Error[] = [];
  for (const [index, cleanup] of cleanups.entries()) {
    try {
      await cleanup();
    } catch {
      failures.push(new Error(`Cleanup operation ${index + 1} failed.`));
    }
  }
  return failures;
}
