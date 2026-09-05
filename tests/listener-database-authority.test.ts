import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';
import { acquireExecutorRoleTestLock } from './postgres-role-test-lock.js';

const scriptUrl = new URL('../scripts/provision-executor-roles.sql', import.meta.url);

const BUSINESS_TABLES = Object.freeze([
  'api_event_stream', 'api_event_stream_state', 'bonding_curve_snapshots',
  'chain_transaction_finality_replay_receipts', 'chain_transaction_inbox',
  'creator_profiles', 'discovered_pools', 'domain_events', 'ignored_assets',
  'launch_trades', 'listener_catch_up_gaps', 'listener_checkpoints',
  'listener_heartbeats', 'listener_strict_catch_up_failures',
  'listener_websocket_health', 'market_pools', 'market_reserve_snapshots',
  'market_trades', 'migrations', 'observed_wallet_positions',
  'paper_decision_jobs', 'paper_external_buy_events', 'paper_mvp_position_samples',
  'paper_mvp_runs', 'paper_positions', 'paper_strategy_sessions', 'paper_trades',
  'processing_checkpoints', 'qualification_reports', 'raw_chain_events',
  'risk_settings', 'social_enrichment_jobs', 'social_evidence_collections',
  'social_http_observations', 'social_links', 'social_verification_evidence',
  'state_transitions', 'swap_events', 'token_holders_snapshots', 'token_launches',
  'token_metadata_snapshots', 'token_risk_reports', 'token_sessions', 'trades',
  'trading_candidates', 'transaction_inbox_recoveries', 'wallet_cluster_members',
  'wallet_clusters', 'wallet_funding_evidence', 'wallet_funding_observations',
  'wallet_graph_profiles', 'wallet_graph_snapshots', 'wallet_relationships',
] as const);

const FORBIDDEN_EXECUTION_TABLES = Object.freeze([
  'execution_activation_armaments', 'execution_activation_events',
  'execution_attempts', 'execution_control_events', 'execution_control_state',
  'execution_dry_run_assessments', 'execution_exit_authorizations',
  'execution_exposure_reservations', 'execution_fault_ledger',
  'execution_intent_transitions', 'execution_live_positions',
  'execution_live_rpc_budgets', 'execution_live_unsigned_simulation_evidence',
  'execution_operator_authorizations', 'execution_pre_signature_locks',
  'execution_pre_submission_revocations', 'execution_provider_rate_limit_events',
  'execution_provider_usage_counters', 'execution_provider_usage_snapshots',
  'execution_reconciliation_evidence', 'execution_risk_admission_reports',
  'execution_risk_tombstones', 'execution_safety_gate_evidence',
  'execution_safety_qualifications', 'execution_signed_simulation_evidence',
  'execution_signed_transactions', 'execution_simulation_artifacts',
  'execution_submission_events', 'execution_submission_preflight_evidence',
  'execution_wallet_generations', 'execution_wallet_risk_state',
  'execution_wallet_snapshots',
] as const);

void test('listener provisioning rebuilds one closed non-live database authority', async () => {
  const sql = await readFile(scriptUrl, 'utf8');
  assert.match(sql, /ALTER ROLE sol_token_listener_writer NOLOGIN NOSUPERUSER NOCREATEDB\s+NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/iu);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM sol_token_listener_writer/u);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM sol_token_listener_writer/u);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM sol_token_listener_writer/u);
  assert.match(sql, /GRANT USAGE ON SCHEMA public TO sol_token_listener_writer/iu);
  assert.match(sql, /GRANT SELECT ON TABLE migration_history TO sol_token_listener_writer/iu);
  for (const table of BUSINESS_TABLES) {
    assert.match(sql, new RegExp(`GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE[\\s\\S]*?\\b${table}\\b[\\s\\S]*?TO sol_token_listener_writer`, 'iu'));
  }
  assert.match(sql, /GRANT USAGE ON SEQUENCE\s+api_event_stream_sequence_seq,\s+paper_decision_claim_scan_generation_seq\s+TO sol_token_listener_writer/iu);
  assert.match(sql, /GRANT SELECT \([^)]+\), INSERT \([^)]+\)\s+ON TABLE execution_intents TO sol_token_listener_writer/iu);
  assert.match(sql, /GRANT SELECT \([^)]+\)\s+ON TABLE execution_intent_tombstones TO sol_token_listener_writer/iu);
  for (const table of FORBIDDEN_EXECUTION_TABLES) {
    assert.doesNotMatch(sql, new RegExp(`GRANT[^;]*\\b${table}\\b[^;]*TO sol_token_listener_writer`, 'iu'));
  }
  assert.doesNotMatch(sql, /GRANT[^;]*\b(?:UPDATE|DELETE)\b[^;]*execution_intents[^;]*TO sol_token_listener_writer/iu);
});

void test('PostgreSQL 16 listener login can write business projections but no live state',
  async (context) => {
    const configuredUrl = process.env.TEST_DATABASE_URL;
    if (configuredUrl === undefined || configuredUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL is not configured.');
      return;
    }
    const baseUrl = new URL(configuredUrl);
    const maintenance = new pg.Pool({ connectionString: baseUrl.href });
    const capability = (await maintenance.query<{
      readonly rolsuper: boolean;
      readonly rolcreatedb: boolean;
      readonly server_version_number: number;
    }>(`SELECT rolsuper,rolcreatedb,
      current_setting('server_version_num')::INTEGER AS server_version_number
      FROM pg_roles WHERE rolname=current_user`)).rows[0];
    if (!capability?.rolsuper || !capability.rolcreatedb
      || capability.server_version_number < 160_000) {
      await maintenance.end();
      context.skip('PostgreSQL 16 superuser with CREATEDB is required.');
      return;
    }
    const release = await acquireExecutorRoleTestLock(maintenance);
    const suffix = randomUUID().replaceAll('-', '');
    const databaseName = `listener_role_test_${suffix}`;
    const loginName = `listener_login_${suffix}`;
    const privateSchema = `listener_private_${suffix}`;
    const password = randomUUID().replaceAll('-', '');
    const isolatedUrl = new URL(baseUrl);
    isolatedUrl.pathname = `/${databaseName}`;
    let isolated: InstanceType<typeof pg.Pool> | undefined;
    let listener: InstanceType<typeof pg.Pool> | undefined;
    try {
      await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0`);
      isolated = new pg.Pool({ connectionString: isolatedUrl.href });
      await migrateDatabase({ pool: isolated });
      const provisioningSql = await readFile(scriptUrl, 'utf8');
      await isolated.query(provisioningSql);
      await isolated.query(`CREATE SCHEMA ${quoteIdentifier(privateSchema)}`);
      await isolated.query(`CREATE TABLE ${quoteIdentifier(privateSchema)}.secrets (
        signed_transaction_bytes BYTEA NOT NULL
      )`);
      await isolated.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(privateSchema)}
        TO sol_token_listener_writer`);
      await isolated.query(`GRANT SELECT ON TABLE ${quoteIdentifier(privateSchema)}.secrets
        TO sol_token_listener_writer WITH GRANT OPTION`);
      await isolated.query(provisioningSql);
      await maintenance.query(`CREATE ROLE ${quoteIdentifier(loginName)} LOGIN NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
        PASSWORD ${quoteLiteral(password)}`);
      await maintenance.query(`GRANT sol_token_listener_writer
        TO ${quoteIdentifier(loginName)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      const listenerUrl = new URL(isolatedUrl);
      listenerUrl.username = loginName;
      listenerUrl.password = password;
      listenerUrl.searchParams.set('options', '-c role=sol_token_listener_writer');
      listener = new pg.Pool({ connectionString: listenerUrl.href, max: 1 });
      assert.deepEqual((await listener.query(
        `SELECT session_user,current_user,current_setting('search_path') AS search_path`,
      )).rows, [{
        session_user: loginName,
        current_user: 'sol_token_listener_writer',
        search_path: '"$user", public',
      }]);
      for (const table of BUSINESS_TABLES) {
        const row: {
          readonly select_ok: boolean;
          readonly insert_ok: boolean;
          readonly update_ok: boolean;
          readonly delete_ok: boolean;
        } | undefined = (await listener.query<{
          readonly select_ok: boolean;
          readonly insert_ok: boolean;
          readonly update_ok: boolean;
          readonly delete_ok: boolean;
        }>(`SELECT
          has_table_privilege(current_user,$1,'SELECT') AS select_ok,
          has_table_privilege(current_user,$1,'INSERT') AS insert_ok,
          has_table_privilege(current_user,$1,'UPDATE') AS update_ok,
          has_table_privilege(current_user,$1,'DELETE') AS delete_ok`, [table])).rows[0];
        assert.deepEqual(row, {
          select_ok: true, insert_ok: true, update_ok: true, delete_ok: true,
        }, table);
      }
      for (const table of FORBIDDEN_EXECUTION_TABLES) {
        assert.equal((await listener.query<{ readonly allowed: boolean }>(
          `SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE') AS allowed`,
          [table],
        )).rows[0]?.allowed, false, table);
      }
      assert.equal((await listener.query<{ readonly allowed: boolean }>(
        `SELECT has_schema_privilege(current_user,$1,'USAGE') AS allowed`, [privateSchema],
      )).rows[0]?.allowed, false);
      const privateTableOid = (await isolated.query<{ readonly oid: string }>(
        `SELECT format('%s',class.oid) AS oid FROM pg_class class
          JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
          WHERE namespace.nspname=$1 AND class.relname='secrets'`, [privateSchema],
      )).rows[0]?.oid;
      assert.ok(privateTableOid);
      assert.equal((await listener.query<{ readonly allowed: boolean }>(
        `SELECT has_table_privilege(current_user,$1::OID,'SELECT') AS allowed`,
        [privateTableOid],
      )).rows[0]?.allowed, false);
      assert.equal((await listener.query<{ readonly allowed: boolean }>(
        `SELECT has_column_privilege(current_user,'execution_intents','id','INSERT') AS allowed`,
      )).rows[0]?.allowed, true);
      assert.equal((await listener.query<{ readonly allowed: boolean }>(
        `SELECT has_column_privilege(current_user,'execution_intents','status','UPDATE') AS allowed`,
      )).rows[0]?.allowed, false);
    } finally {
      if (listener !== undefined) await listener.end();
      if (isolated !== undefined) await isolated.end();
      await maintenance.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname=$1 AND pid<>pg_backend_pid()`, [databaseName]);
      await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(loginName)}`);
      try { await release(); } finally { await maintenance.end(); }
    }
  });

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
