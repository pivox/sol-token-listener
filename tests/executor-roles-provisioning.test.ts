import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import {
  LIVE_EXECUTOR_DATABASE_AUTHORITY_V1,
  LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL,
} from '../src/executor-live/startup-validator.js';
import { createLiveExecutorBootstrapDatabase } from '../src/executor-live/database.js';
import type { LiveExecutorConfig } from '../src/executor-live/config.js';
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
const liveStartupUrl = new URL('../src/executor-live/startup-validator.ts', import.meta.url);
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
  const startup = await readFile(liveStartupUrl, 'utf8');
  const executable = sql.replace(/--[^\r\n]*/gu, ' ');
  const signedGrant = columnGrantForLiveTable(sql, 'execution_signed_transactions');
  const positionGrant = columnGrantForLiveTable(sql, 'execution_live_positions');
  const exitGrant = columnGrantForLiveTable(sql, 'execution_exit_authorizations');
  assert.match(sql, /ALTER ROLE sol_token_executor_live NOLOGIN NOSUPERUSER NOCREATEDB\s+NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/iu);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM sol_token_executor_live/u);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM sol_token_executor_live/u);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM sol_token_executor_live/u);
  assert.match(sql, /FROM pg_type type[\s\S]*REVOKE ALL PRIVILEGES ON TYPE %I\.%I FROM sol_token_executor_live/iu);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON DATABASE %I FROM sol_token_executor_live/u);
  assert.match(sql, /target_database NAME := current_database\(\)/u);
  assert.match(sql, /REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC/iu);
  assert.match(startup,
    /pg_default_acl object\s+CROSS JOIN LATERAL aclexplode\(object\.defaclacl\) acl[\s\S]*acl\.grantee=login\.oid/u);
  assert.match(startup,
    /pg_language object\s+CROSS JOIN LATERAL aclexplode\(object\.lanacl\) acl[\s\S]*acl\.grantee=login\.oid/u);
  assert.match(startup, /pg_language object WHERE object\.lanowner=login\.oid/u);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON LANGUAGE %I FROM sol_token_executor_live/u);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE %I[\s\S]*?FROM sol_token_executor_live/iu);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON SCHEMA %I FROM sol_token_executor_live/u);
  assert.match(sql, /REVOKE SELECT \(%1\$s\), INSERT \(%1\$s\), UPDATE \(%1\$s\), REFERENCES \(%1\$s\)[\s\S]*?sol_token_executor_live/iu);
  assert.match(sql, /GRANT USAGE ON SCHEMA public[\s\S]*?sol_token_executor_live/iu);
  assert.match(sql, /GRANT SELECT \(version\)\s+ON TABLE migration_history TO sol_token_executor_live/iu);
  assert.match(sql, /REVOKE ALL ON TABLE\s+execution_signed_transactions,\s+execution_live_unsigned_simulation_evidence,\s+execution_signed_simulation_evidence,\s+execution_submission_preflight_evidence,\s+execution_pre_submission_revocations,\s+execution_submission_events,\s+execution_live_positions,\s+execution_exit_authorizations,\s+execution_reconciliation_evidence\s+FROM PUBLIC,sol_token_listener_writer,sol_token_executor_worker,\s+sol_token_executor_operations,sol_token_operator_reader,sol_token_public_api/iu);
  assert.doesNotMatch(executable,
    /GRANT\s+(?:SELECT|INSERT|UPDATE)\s+ON\s+TABLE[^;]*TO\s+sol_token_executor_live(?!_)/iu);
  assert.match(signedGrant, /SELECT \([\s\S]*signed_transaction_bytes/iu);
  assert.match(signedGrant, /INSERT \([\s\S]*signed_transaction_bytes/iu);
  const signedUpdate = /UPDATE \(([^)]*)\)/iu.exec(signedGrant)?.[1] ?? '';
  assert.match(signedUpdate, /revoked_at,purge_after/iu);
  assert.doesNotMatch(signedUpdate, /confirmed_at|confirmed_slot|reconciled_at/iu);
  assert.match(positionGrant,
    /SELECT \([\s\S]*state_revision,exit_intent_id,remaining_base_raw[\s\S]*\), UPDATE \(state,state_revision,exit_intent_id\)/iu);
  assert.match(exitGrant,
    /SELECT \([\s\S]*locked_attempt_number[\s\S]*\), UPDATE \(state,state_revision,locked_intent_id,locked_attempt_number\)/iu);
  assert.match(sql, /REVOKE ALL ON TABLE[\s\S]*?execution_submission_preflight_evidence[\s\S]*?FROM PUBLIC,sol_token_listener_writer/iu);
  assert.doesNotMatch(sql, /GRANT\s+(?:UPDATE|DELETE|ALL)\s+ON TABLE\s+execution_submission_preflight_evidence/iu);
  assert.doesNotMatch(sql, /GRANT\s+(?:UPDATE|DELETE|ALL)\s+ON TABLE\s+execution_pre_submission_revocations/iu);
  assert.doesNotMatch(sql, /GRANT\s+(?:UPDATE|DELETE|ALL)\s+ON TABLE\s+execution_signed_simulation_evidence/iu);
  assert.doesNotMatch(sql, /GRANT\s+(?:UPDATE|DELETE|ALL)\s+ON TABLE\s+execution_live_unsigned_simulation_evidence/iu);
  for (const forbiddenInsert of [
    'execution_intents', 'execution_wallet_risk_state',
    'execution_provider_usage_counters', 'execution_exposure_reservations',
    'execution_activation_armaments', 'execution_live_positions',
    'execution_exit_authorizations', 'execution_risk_admission_reports',
    'execution_reconciliation_evidence', 'execution_fault_ledger',
  ]) assert.doesNotMatch(executable,
    new RegExp(`GRANT[^;]*INSERT\\s*\\([^)]*\\)[^;]*ON\\s+TABLE\\s+${forbiddenInsert}\\s+TO\\s+sol_token_executor_live(?!_)`, 'iu'));
  assert.doesNotMatch(sql, /GRANT\s+(?:INSERT,)?UPDATE ON TABLE\s+(?:execution_signed_transactions|execution_intents)/iu);
  assert.doesNotMatch(executable, /execution_reconciliation_evidence[^;]*TO\s+sol_token_executor_live(?!_)/iu);
  assert.doesNotMatch(executable, /execution_fault_ledger[^;]*TO\s+sol_token_executor_live(?!_)/iu);
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

void test('PostgreSQL 16 recovery and live logins are exact through their wrappers',
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
    const liveLoginName = `h2b_live_${suffix}`;
    const password = randomUUID().replaceAll('-', '');
    const isolatedUrl = new URL(baseUrl);
    isolatedUrl.pathname = `/${databaseName}`;
    let isolated: InstanceType<typeof pg.Pool> | undefined;
    let loginPool: InstanceType<typeof pg.Pool> | undefined;
    let deniedPool: InstanceType<typeof pg.Pool> | undefined;
    let liveLoginPool: InstanceType<typeof pg.Pool> | undefined;
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
      await maintenance.query(`CREATE ROLE ${quoteIdentifier(liveLoginName)} LOGIN NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
        PASSWORD ${quoteLiteral(password)}`);
      await maintenance.query(`GRANT sol_token_executor_live_recovery
        TO ${quoteIdentifier(loginName)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      await maintenance.query(`GRANT sol_token_executor_live
        TO ${quoteIdentifier(liveLoginName)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);

      const publicKey = '11111111111111111111111111111111';
      const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
      await isolated.query(`INSERT INTO execution_wallet_generations (
        generation_id,payload_version,wallet_public_key,cluster,genesis_hash,generation
      ) VALUES ($1,1,$2,'mainnet-beta',$2,1)`, [generationId, publicKey]);

      const liveLoginUrl = new URL(isolatedUrl);
      liveLoginUrl.username = liveLoginName;
      liveLoginUrl.password = password;
      const activeLiveLoginPool = new pg.Pool({ connectionString: liveLoginUrl.href, max: 1 });
      liveLoginPool = activeLiveLoginPool;
      const liveDatabase = createLiveExecutorBootstrapDatabase(
        activeLiveLoginPool,
        () => activeLiveLoginPool.end(),
      );
      const liveEvidence = await liveDatabase.validateStartup(
        liveRoleConfig(generationId, publicKey),
      );
      assert.equal(liveEvidence.role, 'sol_token_executor_live');
      await liveDatabase.close();
      liveLoginPool = undefined;

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
      if (liveLoginPool !== undefined) await liveLoginPool.end();
      if (isolated !== undefined) await isolated.end();
      await maintenance.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [databaseName],
      );
      await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(loginName)}`);
      await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(deniedLoginName)}`);
      await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(liveLoginName)}`);
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
    const nowMs = Date.now();
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

    const liveClient = await isolated.connect();
    try {
      await liveClient.query('SET ROLE sol_token_executor_live');
      await assertLiveRoleAcl(liveClient);
      const livePool = {
        connect: async () => ({
          query: async (text: string, values?: readonly unknown[]) => values === undefined
            ? liveClient.query(text)
            : liveClient.query(text, [...values]),
          release() {},
        }),
      };
      const liveIntents = new PostgresExecutionIntentRepository(livePool);
      const claim = await liveIntents.claim({
        ownerId: 'h2b-role-test', leaseMs: 30_000,
        purpose: 'LIVE_EXECUTE', side: 'BUY',
      });
      assert.ok(claim);
      assert.equal(claim.intent.id, created.intent.id);
      const processing = await liveIntents.transition(claim, Object.freeze({
        intentId: claim.intent.id, expectedStatus: 'PENDING',
        leaseToken: claim.leaseToken, nextStatus: 'PROCESSING',
        reasonCode: 'EXECUTION_STARTED', humanMessage: 'H2b role capability test.',
        activationPhase: 'NONE', evidence: Object.freeze({
          payloadVersion: 1, attemptNumber: null, sourceEventId: null,
          observedAtMs: Date.now(),
        }),
      }));
      const processingClaim = Object.freeze({ ...claim, intent: processing });
      const begun = await liveIntents.beginAttempt(processingClaim);
      assert.equal(begun.attempt.attemptNumber, 1);
      assert.equal(await liveIntents.finishAttempt(begun.claim, Object.freeze({
        attemptNumber: 1, status: 'ABANDONED', effectiveVenue: null,
        providerId: null, reasonCode: 'EXECUTION_PROVIDER_FAILED',
      })), true);
      assert.equal(await liveIntents.release(begun.claim), true);

      const forbiddenStatements = [
        'INSERT INTO execution_intents DEFAULT VALUES',
        'INSERT INTO execution_activation_armaments DEFAULT VALUES',
        'INSERT INTO execution_risk_admission_reports DEFAULT VALUES',
        'INSERT INTO execution_exposure_reservations DEFAULT VALUES',
        'INSERT INTO execution_live_positions DEFAULT VALUES',
        'INSERT INTO execution_exit_authorizations DEFAULT VALUES',
        'INSERT INTO execution_reconciliation_evidence DEFAULT VALUES',
        'INSERT INTO execution_fault_ledger DEFAULT VALUES',
        'DELETE FROM execution_intents WHERE FALSE',
        'COPY execution_reconciliation_evidence TO STDOUT',
        'CREATE TEMP TABLE migration_history(version TEXT)',
        `UPDATE execution_signed_transactions
          SET confirmed_at=confirmed_at WHERE FALSE`,
        `UPDATE execution_signed_transactions
          SET confirmed_slot=confirmed_slot WHERE FALSE`,
        `UPDATE execution_signed_transactions
          SET reconciled_at=reconciled_at WHERE FALSE`,
      ];
      const server = await liveClient.query<{ readonly version: number }>(
        "SELECT current_setting('server_version_num')::INTEGER AS version",
      );
      if ((server.rows[0]?.version ?? 0) >= 160_000) {
        forbiddenStatements.push('CREATE TABLE public.h2b_forbidden(value INTEGER)');
      }
      for (const forbidden of forbiddenStatements) {
        await assert.rejects(liveClient.query(forbidden), permissionDenied);
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

function columnGrantForLiveTable(sql: string, tableName: string): string {
  const marker = `ON TABLE ${tableName} TO sol_token_executor_live;`;
  const end = sql.indexOf(marker);
  assert.notEqual(end, -1, `missing live column grant for ${tableName}`);
  const start = sql.lastIndexOf('GRANT ', end);
  assert.notEqual(start, -1, `missing live GRANT prefix for ${tableName}`);
  return sql.slice(start, end + marker.length);
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

function liveRoleConfig(generationId: string, publicKey: string): LiveExecutorConfig {
  const fingerprint = 'b'.repeat(64);
  return Object.freeze({
    mode: 'live', liveTradingEnabled: true, cluster: 'mainnet-beta',
    databaseUrl: 'postgresql://not-read-by-test', pollMs: 1_000, leaseMs: 60_000,
    databaseStatementTimeoutMs: 3_000, shutdownGraceMs: 10_000,
    generationId, executorPublicKey: publicKey, keypairPath: '/not-read-by-test',
    providerId: 'primary', httpRpcUrl: 'https://not-read-by-test.invalid',
    expectedGenesisHash: publicKey, buildHash: fingerprint,
    configurationFingerprint: fingerprint, strategyFingerprint: fingerprint,
    phase: 'CANARY', quoteMaxAgeMs: 3_000, slippageBps: 50n,
    snapshotMaxSlotLag: 2, maxComputeUnits: 200_000n, maxFeeLamports: 5_000n,
    maxFeePayerLamportDebit: 1_000_000n, maxPriorityFeeLamports: 0n,
    rpcTimeoutMs: 5_000, maxRpcCallsPerAttempt: 12,
    quoteMintAllowlist: Object.freeze([
      'So11111111111111111111111111111111111111112',
    ] as const),
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

async function assertLiveRoleAcl(
  client: Pick<InstanceType<typeof pg.Pool>, 'query'>,
): Promise<void> {
  const actual = await client.query<{
    readonly kind: string;
    readonly object_name: string;
    readonly subobject_name: string | null;
    readonly privilege: string;
    readonly is_grantable: boolean;
  }>(LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL);
  const server = await client.query<{ readonly server_version_number: number }>(
    "SELECT current_setting('server_version_num')::INTEGER AS server_version_number",
  );
  const expected = livePrivilegeKeys();
  if ((server.rows[0]?.server_version_number ?? 0) < 160_000) {
    expected.push(privilegeKey('SCHEMA', 'public', null, 'CREATE', false));
  }
  assert.deepEqual(actual.rows.map((row) => privilegeKey(
    row.kind, row.object_name, row.subobject_name, row.privilege, row.is_grantable,
  )).sort(), expected.sort());
}

function livePrivilegeKeys(): string[] {
  const authority = LIVE_EXECUTOR_DATABASE_AUTHORITY_V1;
  const keys = [privilegeKey('SCHEMA', authority.schema, null, 'USAGE', false)];
  for (const table of authority.tables) {
    for (const [privilege, columns] of [
      ['SELECT', table.select], ['INSERT', table.insert], ['UPDATE', table.update],
    ] as const) {
      for (const column of columns) keys.push(privilegeKey(
        'COLUMN', `${authority.schema}.${table.name}`, column, privilege, false,
      ));
    }
  }
  for (const sequence of authority.sequences) {
    for (const privilege of sequence.privileges) keys.push(privilegeKey(
      'SEQUENCE', `${authority.schema}.${sequence.name}`, null, privilege, false,
    ));
  }
  return keys;
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
