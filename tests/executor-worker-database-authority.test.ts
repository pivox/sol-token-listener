import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';
import { acquireExecutorRoleTestLock } from './postgres-role-test-lock.js';

const scriptUrl = new URL('../scripts/provision-executor-roles.sql', import.meta.url);
const WORKER_ROLE = 'sol_token_executor_worker';

type Privilege = 'SELECT' | 'INSERT' | 'UPDATE';
type TableAuthority = Readonly<Record<Privilege, readonly string[]>>;

const NONE = Object.freeze([]) as readonly string[];
const WORKER_EXECUTION_TABLES = Object.freeze([
  'execution_attempts',
  'execution_dry_run_assessments',
  'execution_intent_transitions',
  'execution_intents',
  'execution_simulation_artifacts',
] as const);
const WORKER_TABLE_AUTHORITY: Readonly<Record<string, TableAuthority>> = Object.freeze({
  execution_intents: authority({
    SELECT: [
      'id', 'payload_version', 'logical_order_key', 'strategy_id', 'strategy_version',
      'position_id', 'logical_command_id', 'mint', 'side', 'venue_policy', 'quote_mint',
      'quote_token_program', 'quote_decimals', 'quote_amount_raw', 'base_amount_raw',
      'minimum_amount_out_raw', 'decision_event_id', 'decision_fingerprint',
      'requested_at', 'expires_at', 'status', 'attempt_count', 'state_revision',
      'lease_owner', 'lease_token', 'lease_expires_at', 'last_reason_code', 'terminal_at',
      'reconciliation_completed_at', 'created_at', 'updated_at', 'purge_after',
    ],
    UPDATE: [
      'status', 'attempt_count', 'state_revision', 'lease_owner', 'lease_token',
      'lease_expires_at', 'last_reason_code', 'terminal_at',
      'reconciliation_completed_at', 'updated_at', 'purge_after',
    ],
  }),
  execution_dry_run_assessments: authority({
    SELECT: [
      'assessment_id', 'payload_version', 'specification_version', 'evaluator_version',
      'intent_id', 'strategy_id', 'strategy_version', 'decision_fingerprint',
      'intent_state_revision', 'intent_status', 'input_fingerprint', 'result_fingerprint',
      'outcome', 'coverage', 'quote_status', 'build_status', 'simulation_status',
      'signature_status', 'submission_status', 'recorded_at',
    ],
    INSERT: [
      'assessment_id', 'payload_version', 'specification_version', 'evaluator_version',
      'intent_id', 'strategy_id', 'strategy_version', 'decision_fingerprint',
      'intent_state_revision', 'intent_status', 'input_fingerprint', 'result_fingerprint',
      'outcome', 'coverage', 'quote_status', 'build_status', 'simulation_status',
      'signature_status', 'submission_status', 'recorded_at',
    ],
  }),
  execution_attempts: authority({
    SELECT: [
      'intent_id', 'attempt_number', 'status', 'effective_venue', 'provider_id',
      'started_at', 'completed_at', 'reason_code', 'purge_after',
    ],
    INSERT: ['intent_id', 'attempt_number', 'status', 'started_at'],
    UPDATE: ['status', 'effective_venue', 'provider_id', 'completed_at', 'reason_code'],
  }),
  execution_intent_transitions: authority({
    SELECT: ['intent_id'],
    INSERT: [
      'intent_id', 'previous_status', 'next_status', 'reason_code', 'human_message',
      'activation_phase', 'attempt_number', 'evidence', 'occurred_at',
    ],
  }),
  execution_simulation_artifacts: authority({
    SELECT: [
      'artifact_id', 'payload_version', 'specification_version', 'evaluator_version',
      'intent_id', 'attempt_number', 'intent_state_revision', 'strategy_id',
      'strategy_version', 'decision_fingerprint', 'result_kind', 'effective_venue',
      'provider_id', 'executor_public_key', 'expected_genesis_hash',
      'observed_genesis_hash', 'configuration_fingerprint', 'quote_fingerprint',
      'snapshot_fingerprint', 'build_fingerprint', 'message_hash', 'blockhash',
      'last_valid_block_height', 'blockhash_context_slot', 'snapshot_slot',
      'fee_context_slot', 'simulation_slot', 'amount_in_raw', 'expected_amount_out_raw',
      'protected_amount_out_raw', 'fees_raw', 'estimated_fee_lamports',
      'simulated_fee_payer_lamport_debit', 'units_consumed',
      'simulated_base_delta_raw', 'simulated_quote_delta_raw', 'rpc_calls_used',
      'rpc_calls_limit', 'quote_status', 'build_status', 'simulation_status',
      'failure_stage', 'failure_code', 'terminal_reason_code', 'logs_fingerprint',
      'logs_line_count', 'result_fingerprint', 'recorded_at',
    ],
    INSERT: [
      'artifact_id', 'payload_version', 'specification_version', 'evaluator_version',
      'intent_id', 'attempt_number', 'intent_state_revision', 'strategy_id',
      'strategy_version', 'decision_fingerprint', 'result_kind', 'effective_venue',
      'provider_id', 'executor_public_key', 'expected_genesis_hash',
      'observed_genesis_hash', 'configuration_fingerprint', 'quote_fingerprint',
      'snapshot_fingerprint', 'build_fingerprint', 'message_hash', 'blockhash',
      'last_valid_block_height', 'blockhash_context_slot', 'snapshot_slot',
      'fee_context_slot', 'simulation_slot', 'amount_in_raw', 'expected_amount_out_raw',
      'protected_amount_out_raw', 'fees_raw', 'estimated_fee_lamports',
      'simulated_fee_payer_lamport_debit', 'units_consumed',
      'simulated_base_delta_raw', 'simulated_quote_delta_raw', 'rpc_calls_used',
      'rpc_calls_limit', 'quote_status', 'build_status', 'simulation_status',
      'failure_stage', 'failure_code', 'terminal_reason_code', 'logs_fingerprint',
      'logs_line_count', 'result_fingerprint', 'recorded_at',
    ],
  }),
  migrations: authority({
    SELECT: [
      'migration_id', 'mint', 'announced_pool', 'instruction_kind', 'quote_mint',
      'quote_decimals', 'base_token_program', 'quote_token_program',
      'confirmation_status',
    ],
  }),
  market_pools: authority({
    SELECT: [
      'pool_address', 'market', 'program_id', 'pool_index', 'creator', 'base_mint',
      'quote_mint', 'quote_decimals', 'base_token_program', 'quote_token_program',
      'base_vault', 'quote_vault', 'lp_mint', 'migration_id', 'pool_state',
      'confirmation_status', 'slot', 'transaction_index', 'instruction_index',
      'inner_instruction_index',
    ],
  }),
});

void test('worker provisioning declares the exact non-signing column allowlist', async () => {
  const sql = await readFile(scriptUrl, 'utf8');
  const executable = withoutSqlComments(sql);

  for (const [tableName, expected] of Object.entries(WORKER_TABLE_AUTHORITY)) {
    assert.deepEqual(
      workerColumnAuthority(executable, tableName),
      expected,
      `missing or overbroad worker positive column ACL for ${tableName}`,
    );
  }
  assert.match(executable,
    /ALTER ROLE sol_token_executor_worker NOLOGIN NOSUPERUSER NOCREATEDB\s+NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/iu);
  assert.match(executable,
    /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM sol_token_executor_worker/u);
  assert.match(executable,
    /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM sol_token_executor_worker/u);
  assert.match(executable,
    /REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM sol_token_executor_worker/u);
  assert.match(executable,
    /REVOKE ALL PRIVILEGES ON TYPE %I\.%I FROM sol_token_executor_worker/u);
  assert.match(executable,
    /REVOKE ALL PRIVILEGES ON DATABASE %I FROM sol_token_executor_worker/u);
  assert.match(executable,
    /REVOKE ALL PRIVILEGES ON LANGUAGE %I FROM sol_token_executor_worker/u);
  assert.match(executable,
    /ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE ALL PRIVILEGES ON %s FROM sol_token_executor_worker/u);
  assert.match(executable, /REVOKE %I FROM sol_token_executor_worker/u);
  assert.match(executable, /REVOKE ALL PRIVILEGES ON TABLE %I\.%I FROM PUBLIC/u);
  assert.match(executable, /REVOKE ALL PRIVILEGES ON SEQUENCE %I\.%I FROM PUBLIC/u);
  assert.match(executable, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/iu);
  assert.match(executable, /REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC/iu);
  assert.match(executable,
    /REVOKE SET, ALTER SYSTEM ON PARAMETER session_replication_role FROM PUBLIC/iu);
  assert.match(executable, /GRANT USAGE ON SCHEMA public TO sol_token_executor_worker/iu);
  assert.deepEqual(
    workerTableGrantNames(executable), Object.keys(WORKER_TABLE_AUTHORITY).sort(),
  );
  assert.deepEqual(workerSequenceAuthority(executable), [{
    privilege: 'USAGE', sequence: 'execution_intent_transitions_sequence_seq',
  }]);
  assert.doesNotMatch(executable,
    /GRANT\s+(?:ALL(?:\s+PRIVILEGES)?|DELETE|TRUNCATE|REFERENCES|TRIGGER)\b[^;]*TO\s+sol_token_executor_worker/iu);
  assert.doesNotMatch(executable,
    /GRANT\s+(?:SELECT|INSERT|UPDATE)\s+ON\s+TABLE[^;]*TO\s+sol_token_executor_worker/iu);
  assert.doesNotMatch(executable,
    /GRANT[^;]*TO\s+sol_token_executor_worker[^;]*WITH\s+GRANT\s+OPTION/iu);
  const ownershipGuard = /DO \$worker_ownership_guard\$([\s\S]*?)\$worker_ownership_guard\$/u
    .exec(executable)?.[1];
  assert.ok(ownershipGuard);
  for (const ownershipCatalog of [
    /pg_database[\s\S]*datdba/u,
    /pg_namespace[\s\S]*nspowner/u,
    /pg_class[\s\S]*relowner/u,
    /pg_proc[\s\S]*proowner/u,
    /pg_type[\s\S]*typowner/u,
    /pg_language[\s\S]*lanowner/u,
    /pg_default_acl[\s\S]*defaclrole/u,
  ]) assert.match(ownershipGuard, ownershipCatalog);
});

void test('PostgreSQL 16 worker login has only the effective simulation authority',
  async (context) => {
    const configuredUrl = process.env.TEST_EXECUTOR_ROLE_DATABASE_URL;
    if (configuredUrl === undefined || configuredUrl.trim() === '') {
      context.skip('TEST_EXECUTOR_ROLE_DATABASE_URL is required for the disposable role cluster.');
      return;
    }
    const baseUrl = new URL(configuredUrl);
    const maintenance = new pg.Pool({ connectionString: baseUrl.href });
    const suffix = randomUUID().replaceAll('-', '');
    const databaseName = `h2j_worker_${suffix}`;
    const loginName = `h2j_login_${suffix}`;
    const parentName = `h2j_parent_${suffix}`;
    const privateSchema = `h2j_private_${suffix}`;
    const ownedTable = `h2j_owned_${suffix}`;
    const password = randomUUID().replaceAll('-', '');
    const isolatedUrl = new URL(baseUrl);
    isolatedUrl.pathname = `/${databaseName}`;
    let isolated: InstanceType<typeof pg.Pool> | undefined;
    let worker: InstanceType<typeof pg.Pool> | undefined;
    let parentCreated = false;
    let databaseCreated = false;
    let loginCreated = false;
    let ownedDriftCreated = false;
    let release: (() => Promise<void>) | undefined;
    let bodyFailed = false;
    let bodyFailure: unknown;
    try {
      const capability = (await maintenance.query<{
        readonly rolsuper: boolean;
        readonly rolcreatedb: boolean;
        readonly server_version_number: number;
      }>(`SELECT rolsuper,rolcreatedb,
        current_setting('server_version_num')::INTEGER AS server_version_number
        FROM pg_roles WHERE rolname=current_user`)).rows[0];
      if (!capability?.rolsuper || !capability.rolcreatedb
        || capability.server_version_number < 160_000
        || capability.server_version_number >= 170_000) {
        context.skip('PostgreSQL 16 superuser with CREATEDB is required.');
      } else {
        release = await acquireExecutorRoleTestLock(maintenance);
      await maintenance.query(`CREATE ROLE ${quoteIdentifier(parentName)} NOLOGIN NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      parentCreated = true;
      await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0`);
      databaseCreated = true;
      isolated = new pg.Pool({ connectionString: isolatedUrl.href });
      await migrateDatabase({ pool: isolated });
      const provisioningSql = await readFile(scriptUrl, 'utf8');
      await isolated.query(provisioningSql);

      const clusterDrift = await isolated.connect();
      let clusterDriftFailed = false;
      let clusterDriftFailure: unknown;
      try {
        await clusterDrift.query('BEGIN');
        await clusterDrift.query(`GRANT ${quoteIdentifier(parentName)} TO ${WORKER_ROLE}
          WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`);
        await clusterDrift.query(
          `GRANT SET ON PARAMETER statement_timeout TO ${WORKER_ROLE}`,
        );
        await clusterDrift.query(
          'GRANT SET ON PARAMETER session_replication_role TO PUBLIC',
        );
        await clusterDrift.query(provisioningSql);
        assert.deepEqual((await clusterDrift.query<{
          readonly parent_count: string;
          readonly parameter_acl_count: string;
        }>(`SELECT
            (SELECT COUNT(*)::TEXT FROM pg_auth_members membership
              JOIN pg_roles member ON member.oid=membership.member
              WHERE member.rolname=$1) AS parent_count,
            (SELECT COUNT(*)::TEXT FROM pg_parameter_acl parameter_acl
              CROSS JOIN LATERAL aclexplode(parameter_acl.paracl) acl
              WHERE acl.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1))
              AS parameter_acl_count`, [WORKER_ROLE])).rows, [{
          parent_count: '0', parameter_acl_count: '0',
        }]);
        await clusterDrift.query(`SET LOCAL ROLE ${WORKER_ROLE}`);
        assert.deepEqual((await clusterDrift.query<{
          readonly statement_timeout: boolean;
          readonly replication_role: boolean;
        }>(`SELECT
            has_parameter_privilege(current_user,'statement_timeout','SET')
              AS statement_timeout,
            has_parameter_privilege(current_user,'session_replication_role','SET')
              AS replication_role`)).rows, [{
          statement_timeout: false, replication_role: false,
        }]);
      } catch (error) {
        clusterDriftFailed = true;
        clusterDriftFailure = error;
      }
      throwWithCleanupFailures(
        clusterDriftFailed,
        clusterDriftFailure,
        await collectCleanupFailures([
          async () => clusterDrift.query('ROLLBACK'),
          () => { clusterDrift.release(); },
        ]),
      );

      await isolated.query(`CREATE SCHEMA ${quoteIdentifier(privateSchema)}`);
      await isolated.query(`CREATE TABLE ${quoteIdentifier(privateSchema)}.secrets (
        signed_transaction_bytes BYTEA NOT NULL
      )`);
      await isolated.query(`CREATE SEQUENCE ${quoteIdentifier(privateSchema)}.private_sequence`);
      await isolated.query(`CREATE FUNCTION ${quoteIdentifier(privateSchema)}.private_function()
        RETURNS INTEGER LANGUAGE SQL AS 'SELECT 1'`);
      await isolated.query(`CREATE TYPE ${quoteIdentifier(privateSchema)}.private_state
        AS ENUM ('PRIVATE')`);
      await isolated.query(`REVOKE ALL ON FUNCTION
        ${quoteIdentifier(privateSchema)}.private_function() FROM PUBLIC`);
      await isolated.query(`REVOKE ALL ON TYPE
        ${quoteIdentifier(privateSchema)}.private_state FROM PUBLIC`);
      await isolated.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(privateSchema)}
        TO ${WORKER_ROLE}`);
      await isolated.query(`GRANT SELECT ON TABLE ${quoteIdentifier(privateSchema)}.secrets
        TO ${WORKER_ROLE} WITH GRANT OPTION`);
      await isolated.query(`GRANT USAGE,UPDATE ON SEQUENCE
        ${quoteIdentifier(privateSchema)}.private_sequence TO ${WORKER_ROLE}`);
      await isolated.query(`GRANT EXECUTE ON FUNCTION
        ${quoteIdentifier(privateSchema)}.private_function() TO ${WORKER_ROLE}`);
      await isolated.query(`GRANT USAGE ON TYPE
        ${quoteIdentifier(privateSchema)}.private_state TO ${WORKER_ROLE}`);
      await isolated.query(`GRANT CREATE,TEMPORARY ON DATABASE
        ${quoteIdentifier(databaseName)} TO ${WORKER_ROLE}`);
      await isolated.query('REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC');
      await isolated.query(`GRANT USAGE ON LANGUAGE plpgsql TO ${WORKER_ROLE}`);
      await isolated.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(privateSchema)}
        TO ${quoteIdentifier(parentName)}`);
      await isolated.query(`GRANT SELECT ON TABLE ${quoteIdentifier(privateSchema)}.secrets
        TO ${quoteIdentifier(parentName)} WITH GRANT OPTION`);
      await isolated.query('GRANT SELECT ON TABLE execution_wallet_generations TO PUBLIC');
      await isolated.query(`GRANT SELECT (signed_transaction_bytes)
        ON TABLE execution_signed_transactions TO PUBLIC`);
      await isolated.query('GRANT SELECT ON TABLE migrations,market_pools TO PUBLIC');
      await isolated.query(`GRANT USAGE,UPDATE ON SEQUENCE
        execution_intent_transitions_sequence_seq TO PUBLIC`);
      await isolated.query(`GRANT USAGE,SELECT,UPDATE ON SEQUENCE
        api_event_stream_sequence_seq TO PUBLIC`);
      await isolated.query('GRANT CREATE ON SCHEMA public TO PUBLIC');
      await isolated.query(`GRANT CREATE,TEMPORARY ON DATABASE
        ${quoteIdentifier(databaseName)} TO PUBLIC`);
      await isolated.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT ON TABLES TO ${WORKER_ROLE}`);
      await isolated.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE ON SEQUENCES TO ${WORKER_ROLE}`);
      await isolated.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT EXECUTE ON FUNCTIONS TO ${WORKER_ROLE}`);
      await isolated.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE ON TYPES TO ${WORKER_ROLE}`);
      await isolated.query(`ALTER DEFAULT PRIVILEGES
        GRANT USAGE ON SCHEMAS TO ${WORKER_ROLE}`);
      await isolated.query(provisioningSql);

      await maintenance.query(`CREATE ROLE ${quoteIdentifier(loginName)} LOGIN NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
        PASSWORD ${quoteLiteral(password)}`);
      loginCreated = true;
      await maintenance.query(`GRANT ${WORKER_ROLE} TO ${quoteIdentifier(loginName)}
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      const workerUrl = new URL(isolatedUrl);
      workerUrl.username = loginName;
      workerUrl.password = password;
      workerUrl.searchParams.set(
        'options',
        `-c role=${WORKER_ROLE} -c search_path=pg_catalog,public`,
      );
      worker = new pg.Pool({ connectionString: workerUrl.href, max: 1 });

      assert.deepEqual((await worker.query(
        `SELECT session_user,current_user,current_setting('search_path') AS search_path`,
      )).rows, [{
        session_user: loginName,
        current_user: WORKER_ROLE,
        search_path: 'pg_catalog,public',
      }]);
      assert.deepEqual((await maintenance.query<{
        readonly parent_count: string;
        readonly login_membership_count: string;
        readonly login_inherit: boolean;
      }>(`SELECT
          (SELECT COUNT(*)::TEXT FROM pg_auth_members membership
            JOIN pg_roles member ON member.oid=membership.member
            WHERE member.rolname=$1) AS parent_count,
          (SELECT COUNT(*)::TEXT FROM pg_auth_members membership
            JOIN pg_roles member ON member.oid=membership.member
            WHERE member.rolname=$2) AS login_membership_count,
          (SELECT rolinherit FROM pg_roles WHERE rolname=$2) AS login_inherit`,
      [WORKER_ROLE, loginName])).rows, [{
        parent_count: '0', login_membership_count: '1', login_inherit: false,
      }]);

      assert.deepEqual((await worker.query<{
        readonly migration_event_id: boolean;
        readonly migration_payload: boolean;
        readonly pool_activation_event_id: boolean;
        readonly pool_payload: boolean;
      }>(`SELECT
          has_column_privilege(current_user,'migrations','event_id','SELECT')
            AS migration_event_id,
          has_column_privilege(current_user,'migrations','payload','SELECT')
            AS migration_payload,
          has_column_privilege(current_user,'market_pools','activation_event_id','SELECT')
            AS pool_activation_event_id,
          has_column_privilege(current_user,'market_pools','payload','SELECT') AS pool_payload`,
      )).rows, [{
        migration_event_id: false,
        migration_payload: false,
        pool_activation_event_id: false,
        pool_payload: false,
      }]);
      await assertExactColumnAuthority(isolated);
      await assertDynamicExecutionInventory(isolated);
      await assertClosedObjectAuthority(worker, privateSchema, isolated);

      const publicParameterProbe = await isolated.connect();
      let parameterProbeFailed = false;
      let parameterProbeFailure: unknown;
      try {
        await publicParameterProbe.query('BEGIN');
        await publicParameterProbe.query(
          'GRANT SET ON PARAMETER session_replication_role TO PUBLIC',
        );
        await publicParameterProbe.query(provisioningSql);
        await publicParameterProbe.query(`SET LOCAL ROLE ${WORKER_ROLE}`);
        assert.equal((await publicParameterProbe.query<{ readonly allowed: boolean }>(
          `SELECT has_parameter_privilege(
            current_user,'session_replication_role','SET'
          ) AS allowed`,
        )).rows[0]?.allowed, false);
      } catch (error) {
        parameterProbeFailed = true;
        parameterProbeFailure = error;
      }
      throwWithCleanupFailures(
        parameterProbeFailed,
        parameterProbeFailure,
        await collectCleanupFailures([
          async () => publicParameterProbe.query('ROLLBACK'),
          () => { publicParameterProbe.release(); },
        ]),
      );

      await isolated.query(`CREATE TABLE ${quoteIdentifier(ownedTable)} (id INTEGER PRIMARY KEY)`);
      await isolated.query(`ALTER TABLE ${quoteIdentifier(ownedTable)} OWNER TO ${WORKER_ROLE}`);
      ownedDriftCreated = true;
      await assert.rejects(
        isolated.query(provisioningSql),
        /Worker role owns database objects/u,
      );
      }
    } catch (error) {
      bodyFailed = true;
      bodyFailure = error;
    }
    const cleanupFailures = await collectCleanupFailures([
      async () => { if (worker !== undefined) await worker.end(); },
      async () => {
        if (isolated !== undefined && ownedDriftCreated) {
          await isolated.query(
            `ALTER TABLE ${quoteIdentifier(ownedTable)} OWNER TO CURRENT_USER`,
          );
        }
      },
      async () => { if (isolated !== undefined) await isolated.end(); },
      async () => {
        if (databaseCreated) {
          await maintenance.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname=$1 AND pid<>pg_backend_pid()`, [databaseName]);
        }
      },
      async () => {
        if (databaseCreated) {
          await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
        }
      },
      async () => {
        if (parentCreated) {
          await maintenance.query(`REVOKE ${quoteIdentifier(parentName)} FROM ${WORKER_ROLE}`);
        }
      },
      async () => {
        if (loginCreated) {
          await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(loginName)}`);
        }
      },
      async () => {
        if (parentCreated) {
          await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(parentName)}`);
        }
      },
      async () => { if (release !== undefined) await release(); },
      async () => maintenance.end(),
    ]);
    throwWithCleanupFailures(bodyFailed, bodyFailure, cleanupFailures);
  });

function authority(value: Partial<TableAuthority>): TableAuthority {
  return Object.freeze({
    SELECT: Object.freeze(value.SELECT ?? NONE),
    INSERT: Object.freeze(value.INSERT ?? NONE),
    UPDATE: Object.freeze(value.UPDATE ?? NONE),
  });
}

function withoutSqlComments(sql: string): string {
  return sql
    .replace(/--[^\r\n]*/gu, ' ')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ');
}

function workerColumnAuthority(sql: string, tableName: string): TableAuthority {
  const statements = sql.split(';').filter((statement) => (
    new RegExp(`ON\\s+TABLE\\s+${tableName}\\s+TO\\s+${WORKER_ROLE}`, 'iu').test(statement)
  ));
  const found: Record<Privilege, string[]> = { SELECT: [], INSERT: [], UPDATE: [] };
  for (const statement of statements) {
    for (const match of statement.matchAll(/\b(SELECT|INSERT|UPDATE)\s*\(([^)]*)\)/giu)) {
      const privilege = match[1]?.toUpperCase() as Privilege | undefined;
      if (privilege === undefined) continue;
      found[privilege].push(...(match[2] ?? '').split(',').map((column) => column.trim()));
    }
  }
  return authority({
    SELECT: found.SELECT,
    INSERT: found.INSERT,
    UPDATE: found.UPDATE,
  });
}

function workerTableGrantNames(sql: string): string[] {
  const names = new Set<string>();
  for (const statement of sql.split(';')) {
    const match = new RegExp(
      `\\bGRANT\\s+[\\s\\S]*?\\bON\\s+TABLE\\s+([a-z_][a-z0-9_]*)\\s+TO\\s+${WORKER_ROLE}\\b`,
      'iu',
    ).exec(statement);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return [...names].sort();
}

function workerSequenceAuthority(sql: string): readonly Readonly<{
  privilege: string;
  sequence: string;
}>[] {
  const authorityRows: { privilege: string; sequence: string }[] = [];
  for (const statement of sql.split(';')) {
    const match = new RegExp(
      `\\bGRANT\\s+([^;]+?)\\s+ON\\s+SEQUENCE\\s+([a-z_][a-z0-9_]*)\\s+TO\\s+${WORKER_ROLE}\\b`,
      'iu',
    ).exec(statement);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    for (const privilege of match[1].split(',')) {
      authorityRows.push({ privilege: privilege.trim().toUpperCase(), sequence: match[2] });
    }
  }
  return authorityRows.sort((left, right) => (
    `${left.sequence}:${left.privilege}`.localeCompare(`${right.sequence}:${right.privilege}`)
  ));
}

async function assertExactColumnAuthority(
  admin: InstanceType<typeof pg.Pool>,
): Promise<void> {
  const result = await admin.query<{
      readonly table_name: string;
      readonly column_name: string;
      readonly select_allowed: boolean;
      readonly insert_allowed: boolean;
      readonly update_allowed: boolean;
      readonly references_allowed: boolean;
      readonly select_grant: boolean;
      readonly insert_grant: boolean;
      readonly update_grant: boolean;
    }>(`SELECT class.relname AS table_name,attribute.attname AS column_name,
        has_column_privilege($1,class.oid,attribute.attnum,'SELECT') AS select_allowed,
        has_column_privilege($1,class.oid,attribute.attnum,'INSERT') AS insert_allowed,
        has_column_privilege($1,class.oid,attribute.attnum,'UPDATE') AS update_allowed,
        has_column_privilege($1,class.oid,attribute.attnum,'REFERENCES') AS references_allowed,
        has_column_privilege($1,class.oid,attribute.attnum,
          'SELECT WITH GRANT OPTION') AS select_grant,
        has_column_privilege($1,class.oid,attribute.attnum,
          'INSERT WITH GRANT OPTION') AS insert_grant,
        has_column_privilege($1,class.oid,attribute.attnum,
          'UPDATE WITH GRANT OPTION') AS update_grant
      FROM pg_class class
      JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid=class.oid
      WHERE namespace.nspname='public' AND class.relname=ANY($2::TEXT[])
        AND class.relkind IN ('r','p','v','m','f')
        AND attribute.attnum>0 AND NOT attribute.attisdropped
      ORDER BY class.relname,attribute.attnum`,
  [WORKER_ROLE, Object.keys(WORKER_TABLE_AUTHORITY)]);
  for (const [tableName, expected] of Object.entries(WORKER_TABLE_AUTHORITY)) {
    const tableRows = result.rows.filter((row) => row.table_name === tableName);
    assert.ok(tableRows.length > 0, tableName);
    for (const row of tableRows) {
      assert.deepEqual(row, {
        table_name: tableName,
        column_name: row.column_name,
        select_allowed: expected.SELECT.includes(row.column_name),
        insert_allowed: expected.INSERT.includes(row.column_name),
        update_allowed: expected.UPDATE.includes(row.column_name),
        references_allowed: false,
        select_grant: false,
        insert_grant: false,
        update_grant: false,
      }, `${tableName}.${row.column_name}`);
    }
  }
}

async function assertDynamicExecutionInventory(
  admin: InstanceType<typeof pg.Pool>,
): Promise<void> {
  const relations = await admin.query<{
    readonly relation_name: string;
    readonly table_allowed: boolean;
    readonly column_allowed: boolean;
  }>(`SELECT class.relname AS relation_name,
      has_table_privilege($1,class.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table_allowed,
      has_any_column_privilege($1,class.oid,
        'SELECT,INSERT,UPDATE,REFERENCES') AS column_allowed
    FROM pg_class class JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
    WHERE namespace.nspname='public' AND class.relkind IN ('r','p','v','m','f')
      AND class.relname LIKE 'execution\\_%' ESCAPE '\\'
    ORDER BY class.relname`, [WORKER_ROLE]);
  assert.ok(relations.rowCount !== null && relations.rowCount > 5);
  for (const row of relations.rows) {
    assert.equal(row.table_allowed, false, row.relation_name);
    assert.equal(
      row.column_allowed,
      WORKER_EXECUTION_TABLES.includes(
        row.relation_name as typeof WORKER_EXECUTION_TABLES[number],
      ),
      row.relation_name,
    );
  }
  assert.deepEqual(
    relations.rows.filter((row) => row.column_allowed).map((row) => row.relation_name),
    [...WORKER_EXECUTION_TABLES].sort(),
  );
  const sequences = await admin.query<{
    readonly sequence_name: string;
    readonly usage_allowed: boolean;
    readonly select_allowed: boolean;
    readonly update_allowed: boolean;
  }>(`SELECT class.relname AS sequence_name,
      has_sequence_privilege($1,class.oid,'USAGE') AS usage_allowed,
      has_sequence_privilege($1,class.oid,'SELECT') AS select_allowed,
      has_sequence_privilege($1,class.oid,'UPDATE') AS update_allowed
    FROM pg_class class JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
    WHERE namespace.nspname='public' AND class.relkind='S'
    ORDER BY class.relname`, [WORKER_ROLE]);
  assert.ok(sequences.rowCount !== null && sequences.rowCount > 1);
  for (const row of sequences.rows) {
    const expected = row.sequence_name === 'execution_intent_transitions_sequence_seq';
    assert.deepEqual(row, {
      sequence_name: row.sequence_name,
      usage_allowed: expected,
      select_allowed: false,
      update_allowed: false,
    }, row.sequence_name);
  }
}

async function assertClosedObjectAuthority(
  worker: InstanceType<typeof pg.Pool>,
  privateSchema: string,
  isolated: InstanceType<typeof pg.Pool>,
): Promise<void> {
  assert.deepEqual((await worker.query<{
    readonly public_usage: boolean;
    readonly public_usage_grant: boolean;
    readonly public_create: boolean;
    readonly database_create: boolean;
    readonly database_temporary: boolean;
    readonly language_usage: boolean;
    readonly sequence_usage_grant: boolean;
  }>(`SELECT
      has_schema_privilege(current_user,'public','USAGE') AS public_usage,
      COALESCE((SELECT bool_or(acl.is_grantable) FROM pg_namespace namespace
        CROSS JOIN LATERAL aclexplode(namespace.nspacl) acl
        WHERE namespace.nspname='public'
          AND acl.grantee=(SELECT oid FROM pg_roles WHERE rolname=current_user)
          AND acl.privilege_type='USAGE'),false) AS public_usage_grant,
      has_schema_privilege(current_user,'public','CREATE') AS public_create,
      has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
      has_database_privilege(current_user,current_database(),'TEMPORARY') AS database_temporary,
      has_language_privilege(current_user,'plpgsql','USAGE') AS language_usage,
      COALESCE((SELECT bool_or(acl.is_grantable) FROM pg_class class
        JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
        CROSS JOIN LATERAL aclexplode(class.relacl) acl
        WHERE namespace.nspname='public'
          AND class.relname='execution_intent_transitions_sequence_seq'
          AND acl.grantee=(SELECT oid FROM pg_roles WHERE rolname=current_user)
          AND acl.privilege_type='USAGE'),false) AS sequence_usage_grant`,
  )).rows, [{
    public_usage: true,
    public_usage_grant: false,
    public_create: false,
    database_create: false,
    database_temporary: false,
    language_usage: false,
    sequence_usage_grant: false,
  }]);
  assert.equal((await worker.query<{ readonly allowed: boolean }>(
    `SELECT has_schema_privilege(current_user,$1,'USAGE') AS allowed`, [privateSchema],
  )).rows[0]?.allowed, false);
  assert.equal((await worker.query<{ readonly allowed: boolean }>(
    `SELECT has_column_privilege(
      current_user,'execution_wallet_generations','wallet_public_key','SELECT'
    ) AS allowed`,
  )).rows[0]?.allowed, false);
  assert.equal((await worker.query<{ readonly allowed: boolean }>(
    `SELECT has_column_privilege(
      current_user,'execution_signed_transactions','signed_transaction_bytes','SELECT'
    ) AS allowed`,
  )).rows[0]?.allowed, false);
  const privateObjects = (await isolated.query<{
    readonly table_oid: string;
    readonly sequence_oid: string;
    readonly function_oid: string;
    readonly type_oid: string;
  }>(`SELECT
      (SELECT class.oid::TEXT FROM pg_class class
        JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
        WHERE namespace.nspname=$1 AND class.relname='secrets') AS table_oid,
      (SELECT class.oid::TEXT FROM pg_class class
        JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
        WHERE namespace.nspname=$1 AND class.relname='private_sequence') AS sequence_oid,
      (SELECT procedure.oid::TEXT FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
        WHERE namespace.nspname=$1 AND procedure.proname='private_function') AS function_oid,
      (SELECT type.oid::TEXT FROM pg_type type
        JOIN pg_namespace namespace ON namespace.oid=type.typnamespace
        WHERE namespace.nspname=$1 AND type.typname='private_state') AS type_oid`,
  [privateSchema])).rows[0];
  assert.ok(privateObjects);
  assert.deepEqual((await worker.query<{
    readonly table_allowed: boolean;
    readonly sequence_usage_allowed: boolean;
    readonly sequence_update_allowed: boolean;
    readonly function_allowed: boolean;
    readonly type_allowed: boolean;
  }>(`SELECT
      has_table_privilege(current_user,$1::OID,'SELECT') AS table_allowed,
      has_sequence_privilege(current_user,$2::OID,'USAGE') AS sequence_usage_allowed,
      has_sequence_privilege(current_user,$2::OID,'UPDATE') AS sequence_update_allowed,
      has_function_privilege(current_user,$3::OID,'EXECUTE') AS function_allowed,
      has_type_privilege(current_user,$4::OID,'USAGE') AS type_allowed`,
  [privateObjects.table_oid, privateObjects.sequence_oid, privateObjects.function_oid,
    privateObjects.type_oid])).rows, [{
    table_allowed: false,
    sequence_usage_allowed: false,
    sequence_update_allowed: false,
    function_allowed: false,
    type_allowed: false,
  }]);
  assert.equal((await isolated.query<{ readonly count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM pg_default_acl defaults
      CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
      WHERE acl.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1)`, [WORKER_ROLE],
  )).rows[0]?.count, '0');
  assert.equal((await isolated.query<{ readonly count: string }>(
    `SELECT COUNT(*)::TEXT AS count FROM pg_class class
      JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
      WHERE class.relowner=(SELECT oid FROM pg_roles WHERE rolname=$1)
        AND namespace.nspname NOT IN ('pg_catalog','information_schema','pg_toast')`,
    [WORKER_ROLE],
  )).rows[0]?.count, '0');
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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

function throwWithCleanupFailures(
  bodyFailed: boolean,
  bodyFailure: unknown,
  cleanupFailures: readonly Error[],
): void {
  if (bodyFailed) {
    if (cleanupFailures.length === 0) throw bodyFailure;
    throw new AggregateError(
      [bodyFailure, ...cleanupFailures],
      'Test failed and cleanup also failed.',
      { cause: bodyFailure },
    );
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'Test cleanup failed.');
  }
}
