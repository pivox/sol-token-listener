import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
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
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TYPE %I\.%I FROM sol_token_listener_writer/u);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE ALL PRIVILEGES ON %s FROM sol_token_listener_writer/u);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE %I\.%I FROM PUBLIC/u);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON SEQUENCE %I\.%I FROM PUBLIC/u);
  assert.match(sql, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/iu);
  assert.match(sql, /REVOKE CREATE ON DATABASE %I FROM PUBLIC/iu);
  assert.match(sql,
    /REVOKE SET, ALTER SYSTEM ON PARAMETER session_replication_role FROM PUBLIC/iu);
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
      const publicParameterProbe = await isolated.connect();
      try {
        await publicParameterProbe.query('BEGIN');
        await publicParameterProbe.query(
          `GRANT SET ON PARAMETER session_replication_role TO PUBLIC`,
        );
        await publicParameterProbe.query(provisioningSql);
        await publicParameterProbe.query('SET LOCAL ROLE sol_token_listener_writer');
        assert.equal((await publicParameterProbe.query<{ readonly allowed: boolean }>(
          `SELECT has_parameter_privilege(
            current_user,'session_replication_role','SET'
          ) AS allowed`,
        )).rows[0]?.allowed, false);
      } finally {
        await publicParameterProbe.query('ROLLBACK');
        publicParameterProbe.release();
      }
      await isolated.query(provisioningSql);
      await isolated.query(`CREATE SCHEMA ${quoteIdentifier(privateSchema)}`);
      await isolated.query(`CREATE TABLE ${quoteIdentifier(privateSchema)}.secrets (
        signed_transaction_bytes BYTEA NOT NULL
      )`);
      await isolated.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(privateSchema)}
        TO sol_token_listener_writer`);
      await isolated.query(`GRANT SELECT ON TABLE ${quoteIdentifier(privateSchema)}.secrets
        TO sol_token_listener_writer WITH GRANT OPTION`);
      await isolated.query(`GRANT SELECT ON TABLE execution_wallet_generations TO PUBLIC`);
      await isolated.query(`GRANT USAGE,UPDATE ON SEQUENCE
        execution_intent_transitions_sequence_seq TO PUBLIC`);
      await isolated.query(`GRANT CREATE ON SCHEMA public TO PUBLIC`);
      await isolated.query(`GRANT CREATE ON DATABASE ${quoteIdentifier(databaseName)} TO PUBLIC`);
      await isolated.query(`CREATE TYPE ${quoteIdentifier(privateSchema)}.private_state
        AS ENUM ('PRIVATE')`);
      await isolated.query(`GRANT USAGE ON TYPE
        ${quoteIdentifier(privateSchema)}.private_state TO sol_token_listener_writer`);
      await isolated.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT ON TABLES TO sol_token_listener_writer`);
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
      assert.equal((await listener.query<{ readonly allowed: boolean }>(
        `SELECT has_schema_privilege(current_user,'public','CREATE') AS allowed`,
      )).rows[0]?.allowed, false);
      assert.equal((await listener.query<{ readonly allowed: boolean }>(
        `SELECT has_database_privilege(
          current_user,current_database(),'CREATE'
        ) AS allowed`,
      )).rows[0]?.allowed, false);
      assert.deepEqual((await listener.query<{
        readonly usage_allowed: boolean;
        readonly update_allowed: boolean;
      }>(`SELECT
          has_sequence_privilege(current_user,
            'execution_intent_transitions_sequence_seq','USAGE') AS usage_allowed,
          has_sequence_privilege(current_user,
            'execution_intent_transitions_sequence_seq','UPDATE') AS update_allowed`,
      )).rows[0], { usage_allowed: false, update_allowed: false });
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
      const nowMs = Date.now();
      const intentRepository = new PostgresExecutionIntentRepository(listener);
      const intentDraft = createExecutionIntentDraft(Object.freeze({
        strategyId: 'listener-role-test', strategyVersion: 1,
        positionId: `position-${suffix}`, logicalCommandId: `command-${suffix}`,
        mint: '11111111111111111111111111111111', side: 'BUY',
        venuePolicy: 'PUMP_FUN_ONLY',
        quoteMint: 'So11111111111111111111111111111111111111112',
        quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
        quoteAmountRaw: 1n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
        decisionEventId: `decision-${suffix}`, decisionFingerprint: 'd'.repeat(64),
        requestedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
      }));
      assert.equal((await intentRepository.create(intentDraft)).kind, 'CREATED');
      assert.equal((await intentRepository.create(intentDraft)).kind, 'REPLAYED');
      const executionRelations = await listener.query<{
        readonly relation_name: string;
        readonly table_allowed: boolean;
        readonly column_allowed: boolean;
      }>(`SELECT class.relname AS relation_name,
          has_table_privilege(current_user,class.oid,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table_allowed,
          has_any_column_privilege(current_user,class.oid,
            'SELECT,INSERT,UPDATE,REFERENCES') AS column_allowed
        FROM pg_class class JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
        WHERE namespace.nspname='public' AND class.relkind IN ('r','p','v','m','f')
          AND class.relname LIKE 'execution\\_%' ESCAPE '\\'
        ORDER BY class.relname`);
      assert.ok(executionRelations.rowCount !== null
        && executionRelations.rowCount >= FORBIDDEN_EXECUTION_TABLES.length + 2);
      for (const row of executionRelations.rows) {
        if (row.relation_name === 'execution_intents'
          || row.relation_name === 'execution_intent_tombstones') {
          assert.equal(row.table_allowed, false, row.relation_name);
          assert.equal(row.column_allowed, true, row.relation_name);
        } else {
          assert.deepEqual(row, {
            relation_name: row.relation_name,
            table_allowed: false,
            column_allowed: false,
          }, row.relation_name);
        }
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
      const privateTypeOid = (await isolated.query<{ readonly oid: string }>(
        `SELECT format('%s',type.oid) AS oid FROM pg_type type
          JOIN pg_namespace namespace ON namespace.oid=type.typnamespace
          WHERE namespace.nspname=$1 AND type.typname='private_state'`, [privateSchema],
      )).rows[0]?.oid;
      assert.ok(privateTypeOid);
      assert.equal((await isolated.query<{ readonly count: string }>(
        `SELECT COUNT(*)::TEXT AS count FROM pg_type type
          CROSS JOIN LATERAL aclexplode(type.typacl) acl
          WHERE type.oid=$1::OID AND acl.grantee=(SELECT oid FROM pg_roles
            WHERE rolname='sol_token_listener_writer')`, [privateTypeOid],
      )).rows[0]?.count, '0');
      assert.equal((await isolated.query<{ readonly count: string }>(
        `SELECT COUNT(*)::TEXT AS count FROM pg_default_acl defaults
          CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
          WHERE acl.grantee=(SELECT oid FROM pg_roles
            WHERE rolname='sol_token_listener_writer')`,
      )).rows[0]?.count, '0');
      await isolated.query(`CREATE TABLE listener_owned_drift (id INTEGER PRIMARY KEY)`);
      await isolated.query(`ALTER TABLE listener_owned_drift
        OWNER TO sol_token_listener_writer`);
      await assert.rejects(
        isolated.query(provisioningSql),
        /Listener role owns database objects/u,
      );
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
