import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { createProviderUsageSnapshot } from '../src/domain/execution-provider-quota.js';
import { evaluateExecutionReconciliation } from '../src/domain/execution-reconciliation.js';
import { createExecutionRiskPolicy } from '../src/domain/execution-risk-policy.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
import { PostgresExecutionRiskRepository } from '../src/storage/execution-risk.repository.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import { LIVE_RECOVERY_DATABASE_AUTHORITY } from
  '../src/executor-live-recovery/database-authority.js';
import { LIVE_RECOVERY_EFFECTIVE_PRIVILEGES_SQL } from
  '../src/executor-live-recovery/startup-validator.js';
import { validateLiveRecoveryStartup } from
  '../src/executor-live-recovery/startup-validator.js';
import { createLiveRecoveryBootstrapDatabase } from
  '../src/executor-live-recovery/database.js';
import type { LiveRecoveryConfig } from '../src/executor-live-recovery/config.js';

const scriptUrl = new URL('../scripts/provision-executor-roles.sql', import.meta.url);
const repositoryUrl = new URL('../src/storage/execution-operations.repository.ts', import.meta.url);
const riskRepositoryUrl = new URL('../src/storage/execution-risk.repository.ts', import.meta.url);
const packageUrl = new URL('../package.json', import.meta.url);
const environmentUrl = new URL('../.env.example', import.meta.url);
const smokeUrl = new URL('../scripts/deployment-smoke.mjs', import.meta.url);
const runbookUrl = new URL('../docs/operations/executor-live-canary.md', import.meta.url);
const databaseUrl = new URL('../src/storage/database.ts', import.meta.url);

void test('executor role provisioning is explicit, passwordless and least-privilege', async () => {
  const sql = await readFile(scriptUrl, 'utf8');
  const repository = await readFile(repositoryUrl, 'utf8');
  const riskRepository = await readFile(riskRepositoryUrl, 'utf8');
  const executable = sql.replace(/--[^\r\n]*/gu, ' ');
  for (const role of [
    'sol_token_listener_writer', 'sol_token_executor_worker',
    'sol_token_executor_live',
    'sol_token_executor_live_recovery',
    'sol_token_executor_operations', 'sol_token_operator_reader', 'sol_token_public_api',
    'sol_token_retention_worker',
  ]) assert.match(sql, new RegExp(`CREATE ROLE ${role} NOLOGIN`, 'u'));
  assert.doesNotMatch(executable, /\b(?:PASSWORD|SUPERUSER|CREATEDB|CREATEROLE|BYPASSRLS)\b/iu);
  assert.match(sql, /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC/iu);
  assert.match(sql, /TO sol_token_executor_operations/u);
  assert.match(sql, /TO sol_token_operator_reader/u);
  assert.match(sql, /FROM sol_token_public_api,sol_token_listener_writer,sol_token_executor_worker/u);
  assert.match(sql, /GRANT USAGE ON SCHEMA public\s+TO sol_token_executor_live,sol_token_executor_operations,sol_token_operator_reader/iu);
  assert.doesNotMatch(
    executable,
    /GRANT\s+[^;]*\bDELETE\b[^;]*\bTO\s+(?!sol_token_retention_worker\b)/iu,
  );
  assert.match(sql, /GRANT INSERT ON TABLE\s+execution_safety_qualifications,\s+execution_safety_gate_evidence/iu);
  assert.match(sql, /GRANT INSERT,UPDATE ON TABLE\s+execution_control_state/iu);
  assert.match(sql, /GRANT INSERT ON TABLE\s+execution_control_events/iu);
  assert.match(sql, /GRANT INSERT,UPDATE ON TABLE\s+execution_operator_authorizations,\s+execution_activation_armaments/iu);
  assert.match(sql, /GRANT INSERT ON TABLE\s+execution_activation_events/iu);
  assert.doesNotMatch(sql, /(?:private_key|secret_key|seed_phrase|signed_bytes|rpc_url)/iu);
  for (const readOnlyTable of [
    'execution_wallet_generations',
    'execution_wallet_risk_state',
    'execution_safety_qualifications',
  ]) {
    assert.doesNotMatch(
      repository,
      new RegExp(`FROM\\s+${readOnlyTable}[^;]*FOR UPDATE`, 'iu'),
      `${readOnlyTable} must remain usable with SELECT-only privileges`,
    );
  }
  for (const statement of [...riskRepository.matchAll(/`([^`]*FOR UPDATE[^`]*)`/gs)]
    .map((match) => match[1] ?? '')) {
    for (const [table, alias] of [
      ['execution_wallet_generations', 'generation'],
      ['execution_wallet_snapshots', 'snapshot'],
      ['execution_provider_usage_snapshots', 'provider_snapshot'],
    ] as const) {
      if (!statement.includes(table)) continue;
      const targets = /FOR UPDATE OF\s+([a-z_,\s]+)/iu.exec(statement)?.[1]
        ?.split(',').map((target) => target.trim());
      assert.ok(targets !== undefined && !targets.includes(alias),
        `${table} must not be row-locked by the SELECT-only live role`);
    }
  }
});

void test('read-only recovery provisioning matches its closed authority policy', async () => {
  const sql = await readFile(scriptUrl, 'utf8');
  const executable = sql.replace(/--[^\r\n]*/gu, ' ');
  const authority = LIVE_RECOVERY_DATABASE_AUTHORITY;

  assert.equal(Object.isFrozen(authority), true);
  assert.equal(Object.isFrozen(authority.tables), true);
  assert.match(sql, /ALTER ROLE sol_token_executor_live_recovery NOLOGIN NOSUPERUSER NOCREATEDB\s+NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/iu);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM sol_token_executor_live_recovery/u);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM sol_token_executor_live_recovery/u);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM sol_token_executor_live_recovery/u);
  assert.match(sql, /namespace\.nspname NOT IN \('pg_catalog','information_schema','pg_toast'\)/u);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON SCHEMA %I FROM sol_token_executor_live_recovery/u);
  assert.match(sql, /GRANT USAGE ON SCHEMA public TO sol_token_executor_live_recovery/iu);
  assert.match(sql, /GRANT USAGE ON SEQUENCE execution_intent_transitions_sequence_seq\s+TO sol_token_executor_live_recovery/iu);
  assert.doesNotMatch(executable, /GRANT\s+(?:ALL(?:\s+PRIVILEGES)?|DELETE|TRUNCATE|TRIGGER|REFERENCES)\b[^;]*TO\s+sol_token_executor_live_recovery/iu);
  assert.doesNotMatch(executable, /signed_transaction_bytes[^;]*TO\s+sol_token_executor_live_recovery/iu);
  assert.doesNotMatch(executable, /GRANT\s+(?:SELECT|INSERT|UPDATE)\s+ON\s+TABLE[^;]*TO\s+sol_token_executor_live_recovery/iu);

  for (const table of authority.tables) {
    assert.equal(Object.isFrozen(table), true);
    assert.equal(Object.isFrozen(table.select), true);
    assert.equal(Object.isFrozen(table.insert), true);
    assert.equal(Object.isFrozen(table.update), true);
    assert.ok(sql.includes(table.name), `missing recovery ACL for ${table.name}`);
  }
  const signed = authority.tables.find((table) => (
    table.name === 'execution_signed_transactions'
  ));
  assert.ok(signed !== undefined);
  assert.equal(signed.select.includes('signature'), true);
  assert.equal(signed.select.includes('signed_transaction_bytes'), false);
  assert.equal(signed.update.includes('submission_started_at'), false);

  const reconciliation = authority.tables.find((table) => (
    table.name === 'execution_reconciliation_evidence'
  ));
  assert.ok(reconciliation !== undefined);
  assert.deepEqual(reconciliation.select, [
    'evidence_id', 'payload_version', 'evidence_fingerprint', 'intent_id',
    'attempt_number', 'reservation_id', 'generation_id', 'provider_id', 'side',
    'signature', 'blockhash', 'last_valid_block_height', 'message_hash',
    'build_fingerprint', 'snapshot_fingerprint', 'maximum_fee_lamports',
    'maximum_fee_payer_lamport_debit', 'signature_history', 'confirmation_status',
    'finalized_block_height', 'observed_slot', 'observed_transaction_fingerprint',
    'fee_lamports', 'wallet_lamport_delta', 'base_delta_raw', 'quote_delta_raw',
    'unexpected_residual_token_balance_raw', 'observed_at', 'finalized_at',
    'result', 'reason_code', 'resolved_by_evidence_id', 'resolved_at', 'purge_after',
  ]);
  const submissionEvents = authority.tables.find((table) => (
    table.name === 'execution_submission_events'
  ));
  assert.ok(submissionEvents !== undefined);
  assert.deepEqual(submissionEvents.select, [
    'artifact_id', 'generation_id', 'previous_state', 'next_state', 'reason_code',
  ]);
});

void test('signed live capability is visible only to the dedicated executor role', async () => {
  const sql = await readFile(scriptUrl, 'utf8');
  assert.match(sql, /GRANT USAGE ON SCHEMA public[\s\S]*?sol_token_executor_live/iu);
  assert.match(sql, /GRANT SELECT ON TABLE migration_history\s+TO sol_token_executor_live/iu);
  assert.match(sql, /REVOKE ALL ON TABLE\s+execution_signed_transactions,\s+execution_live_unsigned_simulation_evidence,\s+execution_signed_simulation_evidence,\s+execution_submission_preflight_evidence,\s+execution_pre_submission_revocations,\s+execution_submission_events,\s+execution_live_positions,\s+execution_exit_authorizations,\s+execution_reconciliation_evidence\s+FROM PUBLIC,sol_token_listener_writer,sol_token_executor_worker,\s+sol_token_executor_operations,sol_token_operator_reader,sol_token_public_api/iu);
  assert.match(sql, /REVOKE UPDATE ON TABLE\s+execution_signed_transactions,[\s\S]*?execution_reconciliation_evidence\s+FROM sol_token_executor_live/iu);
  assert.match(sql, /GRANT INSERT ON TABLE\s+execution_signed_transactions,\s+execution_live_positions,\s+execution_exit_authorizations\s+TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT UPDATE \(state,state_revision,signed_simulated_at,[\s\S]*?revoked_at,purge_after\)\s+ON TABLE execution_signed_transactions TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT UPDATE \(state,state_revision,exit_intent_id,[\s\S]*?purge_after\)\s+ON TABLE execution_live_positions TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT UPDATE \(state,state_revision,locked_intent_id,[\s\S]*?purge_after\)\s+ON TABLE execution_exit_authorizations TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT SELECT,INSERT ON TABLE\s+execution_submission_events,\s+execution_live_unsigned_simulation_evidence,\s+execution_signed_simulation_evidence,\s+execution_submission_preflight_evidence,\s+execution_pre_submission_revocations\s+TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT SELECT,INSERT ON TABLE[\s\S]*execution_signed_simulation_evidence[\s\S]*TO sol_token_executor_live/iu);
  assert.match(sql, /REVOKE ALL ON TABLE[\s\S]*?execution_submission_preflight_evidence[\s\S]*?FROM PUBLIC,sol_token_listener_writer/iu);
  assert.doesNotMatch(sql, /GRANT\s+(?:UPDATE|DELETE|ALL)\s+ON TABLE\s+execution_submission_preflight_evidence/iu);
  assert.doesNotMatch(sql, /GRANT\s+(?:UPDATE|DELETE|ALL)\s+ON TABLE\s+execution_pre_submission_revocations/iu);
  assert.doesNotMatch(sql, /GRANT\s+(?:UPDATE|DELETE|ALL)\s+ON TABLE\s+execution_signed_simulation_evidence/iu);
  assert.doesNotMatch(sql, /GRANT\s+(?:UPDATE|DELETE|ALL)\s+ON TABLE\s+execution_live_unsigned_simulation_evidence/iu);
  assert.match(sql, /GRANT INSERT ON TABLE\s+execution_intents,\s+execution_attempts,\s+execution_wallet_risk_state,\s+execution_provider_usage_counters,\s+execution_exposure_reservations,\s+execution_activation_armaments\s+TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT UPDATE \(status,state_revision,attempt_count,[\s\S]*?updated_at\)\s+ON TABLE execution_intents TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT UPDATE \(status,effective_venue,provider_id,[\s\S]*?reconciliation_maximum_fee_payer_lamport_debit\)\s+ON TABLE execution_attempts TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT UPDATE \(state_revision,reconciled_capital_lamports,[\s\S]*?updated_at\)\s+ON TABLE execution_wallet_risk_state TO sol_token_executor_live/iu);
  assert.doesNotMatch(sql, /GRANT\s+(?:INSERT,)?UPDATE ON TABLE\s+(?:execution_signed_transactions|execution_intents)/iu);
  assert.match(sql, /GRANT INSERT ON TABLE\s+execution_intent_transitions,\s+execution_risk_admission_reports,\s+execution_reconciliation_evidence,\s+execution_fault_ledger,\s+execution_activation_events\s+TO sol_token_executor_live/iu);
  assert.match(sql, /GRANT UPDATE \(resolved_by_evidence_id,resolved_at,purge_after\)\s+ON TABLE execution_reconciliation_evidence\s+TO sol_token_executor_live/iu);
  assert.doesNotMatch(sql, /GRANT[^;]*execution_signed_transactions[^;]*TO\s+(?:sol_token_listener_writer|sol_token_executor_worker|sol_token_executor_operations|sol_token_operator_reader|sol_token_public_api)/iu);
  assert.doesNotMatch(
    sql.replace(/--[^\r\n]*/gu, ' '),
    /GRANT\s+[^;]*\bDELETE\b[^;]*\bTO\s+(?!sol_token_retention_worker\b)/iu,
  );
});

void test('foundation retention has an isolated executable role without signed-byte access', async () => {
  const sql = await readFile(scriptUrl, 'utf8');
  const database = await readFile(databaseUrl, 'utf8');
  const executable = sql.replace(/--[^\r\n]*/gu, ' ');
  const purge = database.slice(
    database.indexOf('export async function purgeExpiredFoundationData'),
    database.indexOf('\nasync function migrationExists'),
  );

  assert.match(sql, /CREATE ROLE sol_token_retention_worker NOLOGIN NOSUPERUSER\s+NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/iu);
  assert.match(sql, /GRANT USAGE ON SCHEMA public[\s\S]*?sol_token_retention_worker/iu);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON SCHEMA public\s+FROM sol_token_retention_worker/iu);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public\s+FROM sol_token_retention_worker/iu);
  assert.match(sql, /GRANT DELETE ON TABLE[\s\S]*?execution_signed_transactions[\s\S]*?TO sol_token_retention_worker/iu);
  assert.match(sql, /GRANT INSERT ON TABLE\s+execution_risk_tombstones,\s+execution_intent_tombstones\s+TO sol_token_retention_worker/iu);
  assert.match(sql, /GRANT UPDATE \([^)]+\)\s+ON TABLE paper_mvp_runs TO sol_token_retention_worker/iu);
  assert.match(sql, /GRANT SELECT \(artifact_id,state,purge_after,exit_authorization_id\)\s+ON TABLE execution_signed_transactions TO sol_token_retention_worker/iu);
  assert.doesNotMatch(
    executable,
    /GRANT\s+SELECT\s+ON\s+TABLE\s+execution_signed_transactions[^;]*TO\s+sol_token_retention_worker/iu,
  );
  assert.doesNotMatch(executable, /signed_transaction_bytes[^;]*sol_token_retention_worker/iu);
  assert.doesNotMatch(
    executable,
    /GRANT\s+(?:ALL(?:\s+PRIVILEGES)?|UPDATE\s+ON\s+TABLE)[^;]*TO\s+sol_token_retention_worker/iu,
  );
  assert.match(purge, /pg_advisory_xact_lock\(hashtextextended\('foundation-retention-fence:v1', 0\)\)/u);
  assert.doesNotMatch(purge, /FOR UPDATE/iu);
});

void test('PostgreSQL 16 recovery login is exact, reacquired and fails without membership',
  async (context) => {
    const configuredUrl = process.env.TEST_DATABASE_URL;
    if (configuredUrl === undefined || configuredUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL is not configured.');
      return;
    }
    const baseUrl = new URL(configuredUrl);
    const maintenance = new pg.Pool({ connectionString: baseUrl.href });
    const capabilities = await maintenance.query<{
      readonly rolsuper: boolean;
      readonly rolcreatedb: boolean;
      readonly server_version_number: number;
    }>(`SELECT role.rolsuper,role.rolcreatedb,
      current_setting('server_version_num')::INTEGER AS server_version_number
      FROM pg_roles role WHERE role.rolname=current_user`);
    const capability = capabilities.rows[0];
    if (!capability?.rolsuper || !capability.rolcreatedb
      || capability.server_version_number < 160_000) {
      await maintenance.end();
      context.skip('PostgreSQL 16 superuser with CREATEDB is required.');
      return;
    }

    const suffix = randomUUID().replaceAll('-', '');
    const databaseName = `h2a_role_test_${suffix}`;
    const loginName = `h2a_recovery_${suffix}`;
    const deniedLoginName = `h2a_denied_${suffix}`;
    const password = randomUUID().replaceAll('-', '');
    const isolatedUrl = new URL(baseUrl);
    isolatedUrl.pathname = `/${databaseName}`;
    let isolated: InstanceType<typeof pg.Pool> | undefined;
    let loginPool: InstanceType<typeof pg.Pool> | undefined;
    let deniedPool: InstanceType<typeof pg.Pool> | undefined;
    try {
      await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0`);
      isolated = new pg.Pool({ connectionString: isolatedUrl.href });
      await migrateDatabase({ pool: isolated });
      const provisioningSql = await readFile(scriptUrl, 'utf8');
      await isolated.query(provisioningSql);
      await isolated.query(provisioningSql);
      await maintenance.query(`CREATE ROLE ${quoteIdentifier(loginName)} LOGIN NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
        PASSWORD ${quoteLiteral(password)}`);
      await maintenance.query(`CREATE ROLE ${quoteIdentifier(deniedLoginName)} LOGIN NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
        PASSWORD ${quoteLiteral(password)}`);
      await maintenance.query(`GRANT sol_token_executor_live_recovery
        TO ${quoteIdentifier(loginName)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);

      const publicKey = '11111111111111111111111111111111';
      const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
      await isolated.query(`INSERT INTO execution_wallet_generations (
        generation_id,payload_version,wallet_public_key,cluster,genesis_hash,generation
      ) VALUES ($1,1,$2,'mainnet-beta',$2,1)`, [generationId, publicKey]);

      const loginUrl = new URL(isolatedUrl);
      loginUrl.username = loginName;
      loginUrl.password = password;
      const activeLoginPool = new pg.Pool({ connectionString: loginUrl.href, max: 1 });
      loginPool = activeLoginPool;
      const database = createLiveRecoveryBootstrapDatabase(
        activeLoginPool,
        () => activeLoginPool.end(),
      );
      const expectedConfig = recoveryConfig(generationId, publicKey);
      const evidence = await validateLiveRecoveryStartup(
        database.startup,
        expectedConfig,
        { validateFiles: false },
      );
      assert.equal(evidence.role, 'sol_token_executor_live_recovery');
      for (let checkout = 0; checkout < 2; checkout += 1) {
        assert.deepEqual((await database.startup.query(
          `SELECT session_user,current_user,current_setting('search_path') AS search_path`,
        )).rows, [{
          session_user: loginName,
          current_user: 'sol_token_executor_live_recovery',
          search_path: 'pg_catalog, public',
        }]);
      }
      await isolated.query(`GRANT SELECT (version) ON migration_history
        TO ${quoteIdentifier(loginName)}`);
      await assert.rejects(
        validateLiveRecoveryStartup(database.startup, expectedConfig, { validateFiles: false }),
        (error: unknown) => error instanceof Error
          && 'code' in error && error.code === 'DATABASE_ROLE_INVALID',
      );
      await isolated.query(`REVOKE SELECT (version) ON migration_history
        FROM ${quoteIdentifier(loginName)}`);
      await isolated.query(`GRANT SELECT (version) ON migration_history
        TO sol_token_executor_live_recovery WITH GRANT OPTION`);
      await assert.rejects(
        validateLiveRecoveryStartup(database.startup, expectedConfig, { validateFiles: false }),
        (error: unknown) => error instanceof Error
          && 'code' in error && error.code === 'DATABASE_ROLE_INVALID',
      );
      await isolated.query(`REVOKE GRANT OPTION FOR SELECT (version) ON migration_history
        FROM sol_token_executor_live_recovery`);
      await isolated.query(`CREATE SCHEMA ${quoteIdentifier(`h2a_private_${suffix}`)}`);
      await isolated.query(`CREATE TABLE ${quoteIdentifier(`h2a_private_${suffix}`)}.secrets (
        signed_transaction_bytes BYTEA NOT NULL
      )`);
      await isolated.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(`h2a_private_${suffix}`)}
        TO sol_token_executor_live_recovery`);
      await isolated.query(`GRANT SELECT ON TABLE
        ${quoteIdentifier(`h2a_private_${suffix}`)}.secrets
        TO sol_token_executor_live_recovery WITH GRANT OPTION`);
      await assert.rejects(
        validateLiveRecoveryStartup(database.startup, expectedConfig, { validateFiles: false }),
        (error: unknown) => error instanceof Error
          && 'code' in error && error.code === 'DATABASE_ROLE_INVALID',
      );
      await isolated.query(provisioningSql);
      await validateLiveRecoveryStartup(
        database.startup,
        expectedConfig,
        { validateFiles: false },
      );
      await isolated.query(`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES
        TO ${quoteIdentifier(loginName)}`);
      await assert.rejects(
        validateLiveRecoveryStartup(database.startup, expectedConfig, { validateFiles: false }),
        (error: unknown) => error instanceof Error
          && 'code' in error && error.code === 'DATABASE_ROLE_INVALID',
      );
      await isolated.query(`ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES
        FROM ${quoteIdentifier(loginName)}`);
      await isolated.query(`GRANT SET ON PARAMETER session_replication_role
        TO ${quoteIdentifier(loginName)}`);
      await assert.rejects(
        validateLiveRecoveryStartup(database.startup, expectedConfig, { validateFiles: false }),
        (error: unknown) => error instanceof Error
          && 'code' in error && error.code === 'DATABASE_ROLE_INVALID',
      );
      await isolated.query(`REVOKE SET ON PARAMETER session_replication_role
        FROM ${quoteIdentifier(loginName)}`);
      await isolated.query(`CREATE FUNCTION h2a_forbidden_${suffix}()
        RETURNS INTEGER LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`);
      await assert.rejects(
        validateLiveRecoveryStartup(database.startup, expectedConfig, { validateFiles: false }),
        (error: unknown) => error instanceof Error
          && 'code' in error && error.code === 'DATABASE_ROLE_INVALID',
      );
      await isolated.query(`DROP FUNCTION h2a_forbidden_${suffix}()`);
      await database.close();
      loginPool = undefined;

      const deniedUrl = new URL(isolatedUrl);
      deniedUrl.username = deniedLoginName;
      deniedUrl.password = password;
      const activeDeniedPool = new pg.Pool({ connectionString: deniedUrl.href, max: 1 });
      deniedPool = activeDeniedPool;
      const denied = createLiveRecoveryBootstrapDatabase(
        activeDeniedPool,
        () => activeDeniedPool.end(),
      );
      await assert.rejects(denied.startup.query('SELECT 1'), (error: unknown) => (
        error instanceof Error && error.name === 'LiveRecoveryDatabaseError'
      ));
      await denied.close();
      deniedPool = undefined;

      await maintenance.query(`GRANT sol_token_executor_live_recovery
        TO ${quoteIdentifier(deniedLoginName)}
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      await maintenance.query(`ALTER ROLE ${quoteIdentifier(deniedLoginName)}
        SET session_replication_role=replica`);
      const replicaPool = new pg.Pool({ connectionString: deniedUrl.href, max: 1 });
      deniedPool = replicaPool;
      const replica = createLiveRecoveryBootstrapDatabase(
        replicaPool,
        () => replicaPool.end(),
      );
      await assert.rejects(replica.startup.query('SELECT 1'), (error: unknown) => (
        error instanceof Error && error.name === 'LiveRecoveryDatabaseError'
      ));
      await replica.close();
      deniedPool = undefined;
    } finally {
      if (loginPool !== undefined) await loginPool.end();
      if (deniedPool !== undefined) await deniedPool.end();
      if (isolated !== undefined) await isolated.end();
      await maintenance.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [databaseName],
      );
      await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(loginName)}`);
      await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(deniedLoginName)}`);
      await maintenance.end();
    }
  });

void test('provisioned retention role runs the complete purge without reading signed bytes', async (context) => {
  const configuredUrl = process.env.TEST_DATABASE_URL;
  if (configuredUrl === undefined || configuredUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL is not configured.');
    return;
  }
  const baseUrl = new URL(configuredUrl);
  const maintenanceUrl = new URL(baseUrl);
  const maintenance = new pg.Pool({ connectionString: maintenanceUrl.href });
  const capabilities = await maintenance.query<{ rolsuper: boolean; rolcreatedb: boolean }>(
    'SELECT rolsuper,rolcreatedb FROM pg_roles WHERE rolname=current_user',
  );
  if (!capabilities.rows[0]?.rolsuper || !capabilities.rows[0].rolcreatedb) {
    await maintenance.end();
    context.skip('A PostgreSQL superuser with CREATEDB is required for isolated role testing.');
    return;
  }

  const databaseName = `retention_role_test_${randomUUID().replaceAll('-', '')}`;
  const isolatedUrl = new URL(baseUrl);
  isolatedUrl.pathname = `/${databaseName}`;
  let isolated: InstanceType<typeof pg.Pool> | undefined;
  try {
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0`);
    isolated = new pg.Pool({ connectionString: isolatedUrl.href });
    await migrateDatabase({ pool: isolated });
    const provisioningSql = await readFile(scriptUrl, 'utf8');
    await isolated.query(provisioningSql);
    await isolated.query('CREATE SCHEMA h2a_private');
    await isolated.query(`CREATE TABLE h2a_private.secrets (
      signed_transaction_bytes BYTEA NOT NULL
    )`);
    await isolated.query(`GRANT USAGE ON SCHEMA h2a_private
      TO sol_token_executor_live_recovery`);
    await isolated.query(`GRANT SELECT ON TABLE h2a_private.secrets
      TO sol_token_executor_live_recovery WITH GRANT OPTION`);
    await isolated.query(provisioningSql);
    const staleRecoveryAuthority = await isolated.query<{
      readonly schema_usage: boolean;
      readonly table_select: boolean;
      readonly table_grant: boolean;
    }>(`SELECT
      has_schema_privilege('sol_token_executor_live_recovery',
        'h2a_private','USAGE') AS schema_usage,
      has_table_privilege('sol_token_executor_live_recovery',
        'h2a_private.secrets','SELECT') AS table_select,
      has_table_privilege('sol_token_executor_live_recovery',
        'h2a_private.secrets','SELECT WITH GRANT OPTION') AS table_grant`);
    assert.deepEqual(staleRecoveryAuthority.rows, [{
      schema_usage: false,
      table_select: false,
      table_grant: false,
    }]);
    await assertRecoveryRoleAcl(isolated);

    const publicKey = '11111111111111111111111111111111';
    const quoteMint = 'So11111111111111111111111111111111111111112';
    const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
    const nowMs = Date.now();
    const adminRisk = new PostgresExecutionRiskRepository(isolated);
    await adminRisk.registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: '2'.repeat(32), generation: 1,
    });
    const walletSnapshot = await adminRisk.appendWalletSnapshot(Object.freeze({
      snapshotId: `execution_wallet_snapshot_${'b'.repeat(64)}`,
      payloadVersion: 1 as const, snapshotFingerprint: 'b'.repeat(64), generationId,
      providerId: 'rpc-primary', stateRevision: 0n, slot: 123n,
      blockTimeMs: nowMs - 100, observedAtMs: nowMs - 50,
      commitment: 'finalized' as const, walletLamports: 1_000_000n,
      tokenBalanceCount: 0, openPositions: Object.freeze([]), realizedNetPnlRaw: 0n,
    }));
    const providerSnapshot = createProviderUsageSnapshot({
      providerId: 'rpc-primary', planId: 'public-v1', billingPeriodId: 'current',
      billingPeriodStartedAtMs: nowMs - 1_000,
      billingPeriodEndsAtMs: nowMs + 300_000,
      limitUnits: 10_000n, usedUnits: 10n, measuredAtMs: nowMs - 100,
      expiresAtMs: nowMs + 60_000, provenance: 'AUTHORITATIVE_PROBE',
    });
    await adminRisk.appendProviderUsage(providerSnapshot);
    const created = await new PostgresExecutionIntentRepository(isolated).create(
      createExecutionIntentDraft({
        strategyId: 'live-role-test', strategyVersion: 1,
        positionId: 'position:live-role', logicalCommandId: 'command:live-role',
        mint: publicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint,
        quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
        quoteAmountRaw: 90_000n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
        decisionEventId: 'decision:live-role', decisionFingerprint: 'c'.repeat(64),
        requestedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
      }),
    );
    const policy = createExecutionRiskPolicy({
      quoteMintAllowlist: [quoteMint], initialCapitalLamports: 1_000_000n,
      maximumCapitalLamports: 1_000_000n, positionSizeBps: 1_000n,
      maximumOpenPositions: 2, maximumTotalExposureBps: 2_000n,
      drawdownPauseBps: 2_500n, feeReserveLamports: 100_000n,
      walletSnapshotMaxAgeMs: 60_000, providerUsageMaxAgeMs: 300_000,
      providerEntryCostUnits: 8n, providerExitCostUnitsPerPosition: 4n,
      providerConfirmationCostUnitsPerPosition: 2n,
      providerReconciliationCostUnitsPerPosition: 3n,
      providerSafetyMarginUnits: 5n, maximumConsecutiveTechnicalFailures: 2,
    });
    const immutableBefore = await isolated.query(`SELECT
      (SELECT xmin::TEXT FROM execution_wallet_generations WHERE generation_id=$1)
        AS generation_xmin,
      (SELECT xmin::TEXT FROM execution_wallet_snapshots WHERE snapshot_id=$2)
        AS wallet_snapshot_xmin,
      (SELECT xmin::TEXT FROM execution_provider_usage_snapshots WHERE snapshot_id=$3)
        AS provider_snapshot_xmin`, [
      generationId, walletSnapshot.snapshotId, providerSnapshot.snapshotId,
    ]);

    const liveClient = await isolated.connect();
    try {
      await liveClient.query('SET ROLE sol_token_executor_live');
      await liveClient.query('BEGIN');
      await liveClient.query('SELECT generation_id FROM execution_wallet_generations');
      await liveClient.query('SELECT generation_id FROM execution_wallet_risk_state FOR UPDATE');
      await liveClient.query('SELECT id FROM execution_intents FOR UPDATE');
      await liveClient.query('ROLLBACK');
      const livePool = {
        connect: async () => ({
          query: async (text: string, values?: readonly unknown[]) => values === undefined
            ? liveClient.query(text)
            : liveClient.query(text, [...values]),
          release() {},
        }),
      };
      const liveRisk = new PostgresExecutionRiskRepository(livePool);
      const admitted = await liveRisk.admitBuy(Object.freeze({
        payloadVersion: 1, intent: created.intent, policy, generationId,
        walletSnapshot, providerSnapshot, allEndpointsUnavailable: false, nowMs,
      }));
      assert.equal(admitted.decision, 'ADMITTED');
      await liveClient.query(`UPDATE execution_intents SET
        status='SUBMITTED',attempt_count=1,state_revision=1,
        last_reason_code='SUBMISSION_ACCEPTED',updated_at=date_trunc('milliseconds',now())
        WHERE id=$1`, [created.intent.id]);
      const signature = '3'.repeat(88);
      await liveClient.query(`INSERT INTO execution_attempts (
        intent_id,attempt_number,status,effective_venue,provider_id,
        reconciliation_signature,reconciliation_blockhash,
        reconciliation_last_valid_block_height,reconciliation_message_hash,
        reconciliation_build_fingerprint,reconciliation_snapshot_fingerprint,
        reconciliation_maximum_fee_lamports,
        reconciliation_maximum_fee_payer_lamport_debit
      ) VALUES ($1,1,'STARTED','PUMP_FUN','rpc-primary',$2,$3,1000,$4,$5,$6,10,1000)`, [
        created.intent.id, signature, publicKey, 'd'.repeat(64), 'e'.repeat(64),
        walletSnapshot.snapshotFingerprint,
      ]);
      const finalizedAtMs = nowMs + 2_000;
      const evidence = evaluateExecutionReconciliation({
        expected: Object.freeze({
          intentId: created.intent.id, attemptNumber: 1, walletGeneration: 1,
          providerId: 'rpc-primary', side: 'BUY', signature, blockhash: publicKey,
          lastValidBlockHeight: 1_000n, messageHash: 'd'.repeat(64),
          buildFingerprint: 'e'.repeat(64),
          snapshotFingerprint: walletSnapshot.snapshotFingerprint,
          maximumFeeLamports: 10n, maximumFeePayerLamportDebit: 1_000n,
        }),
        observed: Object.freeze({
          signatureHistory: 'PRESENT', confirmationStatus: 'FINALIZED',
          finalizedBlockHeight: 999n, observedSlot: 500n,
          transaction: Object.freeze({
            signature, blockhash: publicKey, messageHash: 'd'.repeat(64),
            buildFingerprint: 'e'.repeat(64),
            snapshotFingerprint: walletSnapshot.snapshotFingerprint,
          }),
          feeLamports: 5n, walletLamportDelta: -105n,
          baseDeltaRaw: 500n, quoteDeltaRaw: -100n,
          unexpectedResidualTokenBalanceRaw: 0n,
          observedAtMs: finalizedAtMs - 1, finalizedAtMs,
        }),
      });
      const reconciled = await liveRisk.reconcile({ payloadVersion: 1, evidence });
      assert.equal(reconciled.result, 'MATCHED');
      const durable = await liveClient.query(`SELECT reservation.state,intent.status,
        risk.open_positions,risk.unknown_block,
        (SELECT COUNT(*)::INTEGER FROM execution_reconciliation_evidence
          WHERE intent_id=intent.id) AS evidence_count
        FROM execution_exposure_reservations reservation
        JOIN execution_intents intent ON intent.id=reservation.intent_id
        JOIN execution_wallet_risk_state risk ON risk.generation_id=reservation.generation_id
        WHERE intent.id=$1`, [created.intent.id]);
      assert.deepEqual(durable.rows, [{
        state: 'CONSUMED', status: 'SUCCEEDED', open_positions: 1,
        unknown_block: false, evidence_count: 1,
      }]);
      const immutableAfter = await liveClient.query(`SELECT
        (SELECT xmin::TEXT FROM execution_wallet_generations WHERE generation_id=$1)
          AS generation_xmin,
        (SELECT xmin::TEXT FROM execution_wallet_snapshots WHERE snapshot_id=$2)
          AS wallet_snapshot_xmin,
        (SELECT xmin::TEXT FROM execution_provider_usage_snapshots WHERE snapshot_id=$3)
          AS provider_snapshot_xmin`, [
        generationId, walletSnapshot.snapshotId, providerSnapshot.snapshotId,
      ]);
      assert.deepEqual(immutableAfter.rows, immutableBefore.rows);
      for (const forbidden of [
        'UPDATE execution_wallet_generations SET generation=generation WHERE FALSE',
        'UPDATE execution_wallet_snapshots SET slot=slot WHERE FALSE',
        `UPDATE execution_provider_usage_snapshots
          SET used_units=used_units WHERE FALSE`,
      ]) {
        await assert.rejects(liveClient.query(forbidden),
          (error: unknown) => typeof error === 'object' && error !== null
            && 'code' in error && error.code === '42501');
      }
    } finally {
      try { await liveClient.query('RESET ROLE'); } finally { liveClient.release(); }
    }

    const restrictedClient = await isolated.connect();
    await restrictedClient.query('SET ROLE sol_token_retention_worker');
    const restrictedPool = { connect: async () => restrictedClient };
    await purgeExpiredFoundationData(restrictedPool as never);

    const byteProbe = await isolated.connect();
    try {
      await byteProbe.query('SET ROLE sol_token_retention_worker');
      await assert.rejects(
        byteProbe.query('SELECT signed_transaction_bytes FROM execution_signed_transactions'),
        (error: unknown) => typeof error === 'object' && error !== null
          && 'code' in error && error.code === '42501',
      );
    } finally {
      try { await byteProbe.query('RESET ROLE'); } finally { byteProbe.release(); }
    }
  } finally {
    if (isolated !== undefined) await isolated.end();
    await maintenance.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [databaseName],
    );
    await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await maintenance.end();
  }
});

void test('live canary operational wiring stays explicit, inert and smoke-visible', async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, 'utf8')) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  const environment = await readFile(environmentUrl, 'utf8');
  const smoke = await readFile(smokeUrl, 'utf8');
  const runbook = await readFile(runbookUrl, 'utf8');
  assert.equal(packageJson.scripts?.['executor:live:start'], undefined);
  assert.match(environment, /^EXECUTOR_MODE=dry-run$/mu);
  assert.match(environment, /^LIVE_TRADING_ENABLED=false$/mu);
  assert.match(environment, /^EXECUTOR_KEYPAIR_PATH=$/mu);
  assert.match(smoke, /'036_execution_live_canary\.sql'/u);
  for (const counter of [
    'executionExitAuthorizations', 'executionLivePositions',
    'executionSignedTransactions', 'executionSubmissionEvents',
  ]) assert.match(smoke, new RegExp(`'${counter}'`, 'u'));
  assert.match(runbook, /npm run live:preflight/u);
  assert.match(runbook, /npm run live:resume/u);
  assert.match(runbook, /npm run live:arm --/u);
  assert.match(runbook, /npm run live:status/u);
  assert.match(runbook, /npm run live:kill-switch --/u);
  assert.match(runbook, /NON_EXECUTED\s*\/\s*NON_VALIDATED/u);
  assert.match(runbook, /aucune commande[\s\S]{0,80}enchaîne\s+automatiquement/iu);
  assert.match(runbook, /(?:ne modifie|ne change|maintient|laisse)[^\n]*ENTRY_STOP/iu);
  assert.match(runbook, /binaire[\s\S]{0,160}(?:non composé|indémarrable|pas démarrable)/iu);
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function recoveryConfig(generationId: string, publicKey: string): LiveRecoveryConfig {
  return Object.freeze({
    mode: 'live', recoveryEnabled: true, cluster: 'mainnet-beta',
    databaseUrl: 'postgresql://not-read-by-test', pollMs: 1_000, leaseMs: 60_000,
    databaseStatementTimeoutMs: 3_000, shutdownGraceMs: 10_000,
    generationId, executorPublicKey: publicKey, providerId: 'primary',
    httpRpcUrl: 'https://rpc.example.test', expectedGenesisHash: publicKey,
    rpcTimeoutMs: 5_000, maxRpcCallsPerPass: 8, ownerId: 'recovery-test',
  });
}

async function assertRecoveryRoleAcl(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SET ROLE sol_token_executor_live_recovery');
    const actual = await client.query<{
      readonly kind: string;
      readonly object_name: string;
      readonly subobject_name: string | null;
      readonly privilege: string;
      readonly is_grantable: boolean;
    }>(LIVE_RECOVERY_EFFECTIVE_PRIVILEGES_SQL);
    const server = await client.query<{ readonly server_version_number: number }>(
      "SELECT current_setting('server_version_num')::INTEGER AS server_version_number",
    );
    const expected = recoveryPrivilegeKeys();
    if ((server.rows[0]?.server_version_number ?? 0) < 160_000) {
      expected.push(privilegeKey('SCHEMA', 'public', null, 'CREATE', false));
    }
    assert.deepEqual(actual.rows.map((row) => privilegeKey(
      row.kind, row.object_name, row.subobject_name, row.privilege, row.is_grantable,
    )).sort(), expected.sort());
    for (const forbidden of [
      'SELECT signed_transaction_bytes FROM execution_signed_transactions',
      `UPDATE execution_signed_transactions
        SET submission_started_at=submission_started_at WHERE FALSE`,
      'INSERT INTO execution_signed_transactions DEFAULT VALUES',
      'INSERT INTO execution_signed_simulation_evidence DEFAULT VALUES',
      'INSERT INTO execution_submission_preflight_evidence DEFAULT VALUES',
    ]) {
      await assert.rejects(client.query(forbidden), permissionDenied);
    }
  } finally {
    try { await client.query('RESET ROLE'); } finally { client.release(); }
  }
}

function recoveryPrivilegeKeys(): string[] {
  const keys = [privilegeKey('SCHEMA', 'public', null, 'USAGE', false)];
  for (const table of LIVE_RECOVERY_DATABASE_AUTHORITY.tables) {
    for (const [privilege, columns] of [
      ['SELECT', table.select], ['INSERT', table.insert], ['UPDATE', table.update],
    ] as const) {
      for (const column of columns) {
        keys.push(privilegeKey('COLUMN', `public.${table.name}`, column, privilege, false));
      }
    }
  }
  for (const sequence of LIVE_RECOVERY_DATABASE_AUTHORITY.sequences) {
    for (const privilege of sequence.privileges) {
      keys.push(privilegeKey(
        'SEQUENCE', `public.${sequence.name}`, null, privilege, false,
      ));
    }
  }
  return keys;
}

function privilegeKey(
  kind: string,
  objectName: string,
  subobjectName: string | null,
  privilege: string,
  isGrantable: boolean,
): string {
  return `${kind}\u0000${objectName}\u0000${subobjectName ?? ''}\u0000${privilege}`
    + `\u0000${isGrantable ? 'GRANTABLE' : 'NOT_GRANTABLE'}`;
}

function permissionDenied(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === '42501';
}
