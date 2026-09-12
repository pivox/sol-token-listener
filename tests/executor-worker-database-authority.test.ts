import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';
import { acquireExecutorRoleTestLock } from './postgres-role-test-lock.js';
import { insertExecutionDecisionEvent } from './helpers/execution-decision-event.js';

const scriptUrl = new URL('../scripts/provision-executor-roles.sql', import.meta.url);
const WORKER_ROLE = 'sol_token_executor_worker';
const BACKEND_DRAIN_DELAY_MS = 100;
const BACKEND_DRAIN_TIMEOUT_MS = 5_000;

void test('waits for database backends to close before destructive test cleanup', async () => {
  const counts = ['1', '0'];
  const queryCalls: BackendDrainQuery[] = [];
  const delays: number[] = [];
  let now = 0;
  const maintenance = Object.freeze({
    async query(query: BackendDrainQuery) {
      queryCalls.push(query);
      return Object.freeze({ rows: Object.freeze([{ count: counts.shift() ?? '0' }]) });
    },
  }) as unknown as Pick<InstanceType<typeof pg.Pool>, 'query'>;

  await waitForBackendDrain(
    maintenance, 'isolated_database', {
      now: () => now,
      wait: async (delayMs) => { delays.push(delayMs); now += delayMs; },
    },
  );

  assert.equal(queryCalls.length, 2);
  assert.deepEqual(queryCalls[0]?.values, ['isolated_database']);
  assert.match(queryCalls[0]?.text ?? '', /pg_stat_activity/u);
  assert.equal(queryCalls[0]?.query_timeout, BACKEND_DRAIN_TIMEOUT_MS);
  assert.deepEqual(delays, [BACKEND_DRAIN_DELAY_MS]);
});

void test('bounds the database-backend drain barrier before cleanup can continue', async () => {
  let queryCount = 0;
  let delayCount = 0;
  let now = 0;
  const maintenance = Object.freeze({
    async query(query: BackendDrainQuery) {
      queryCount += 1;
      assert.equal(query.query_timeout, BACKEND_DRAIN_TIMEOUT_MS - now);
      return Object.freeze({ rows: Object.freeze([{ count: '1' }]) });
    },
  }) as unknown as Pick<InstanceType<typeof pg.Pool>, 'query'>;

  await assert.rejects(
    waitForBackendDrain(
      maintenance, 'isolated_database', {
        now: () => now,
        wait: async (delayMs) => { delayCount += 1; now += delayMs; },
      },
    ),
    /Database backends did not close before forced teardown/u,
  );
  assert.equal(queryCount, BACKEND_DRAIN_TIMEOUT_MS / BACKEND_DRAIN_DELAY_MS);
  assert.equal(delayCount, queryCount);
});

void test('preserves the original cleanup failure as a diagnostic cause', async () => {
  const cause = new Error('backend drain failed');
  const failures = await collectCleanupFailures([async () => { throw cause; }]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.cause, cause);
});

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
      'position_id', 'candidate_id', 'logical_command_id', 'mint', 'side', 'venue_policy',
      'quote_mint',
      'quote_token_program', 'quote_decimals', 'quote_amount_raw', 'base_amount_raw',
      'minimum_amount_out_raw', 'decision_event_id', 'decision_fingerprint',
      'requested_at', 'expires_at', 'status', 'attempt_count', 'state_revision',
      'lease_owner', 'lease_token', 'lease_expires_at', 'last_reason_code', 'terminal_at',
      'reconciliation_completed_at', 'created_at', 'updated_at', 'purge_after',
      'live_reserved',
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
  execution_preflight_intent_pair_memberships: authority({
    SELECT: ['intent_id', 'lane'],
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

void test('PostgreSQL 16 provisioning replay revokes a stale worker policy target',
  async (context) => {
    const configuredUrl = process.env.TEST_EXECUTOR_ROLE_DATABASE_URL;
    if (configuredUrl === undefined || configuredUrl.trim() === '') {
      context.skip('TEST_EXECUTOR_ROLE_DATABASE_URL is required for the disposable role cluster.');
      return;
    }
    const baseUrl = new URL(configuredUrl);
    const maintenance = new pg.Pool({ connectionString: baseUrl.href });
    const suffix = randomUUID().replaceAll('-', '');
    const databaseName = `h2j_stale_${suffix}`;
    const loginName = `h2j_stale_login_${suffix}`;
    const staleRoleName = `h2j_stale_worker_${suffix}`;
    const hostileSchema = `h2j_hostile_${suffix}`;
    const password = randomUUID().replaceAll('-', '');
    const isolatedUrl = new URL(baseUrl);
    isolatedUrl.pathname = `/${databaseName}`;
    let isolated: InstanceType<typeof pg.Pool> | undefined;
    let workerPool: InstanceType<typeof pg.Pool> | undefined;
    let activeWorker: pg.PoolClient | undefined;
    let databaseCreated = false;
    let loginCreated = false;
    let staleRoleCreated = false;
    let release: (() => Promise<void>) | undefined;
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
        await maintenance.query(
          `CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0`,
        );
        databaseCreated = true;
        await maintenance.query(`CREATE ROLE ${quoteIdentifier(staleRoleName)} NOLOGIN NOINHERIT
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        staleRoleCreated = true;
        isolated = new pg.Pool({ connectionString: isolatedUrl.href, max: 3 });
        await migrateDatabase({ pool: isolated });
        const provisioningSql = await readFile(scriptUrl, 'utf8');
        await isolated.query(provisioningSql);
        await isolated.query(`CREATE SCHEMA ${quoteIdentifier(hostileSchema)}`);
        await isolated.query(`CREATE TABLE ${quoteIdentifier(hostileSchema)}.execution_intents (
          id TEXT PRIMARY KEY
        )`);
        await isolated.query(`CREATE TABLE ${quoteIdentifier(hostileSchema)}.execution_attempts (
          intent_id TEXT PRIMARY KEY
        )`);
        await isolated.query(`GRANT SELECT ON TABLE
          ${quoteIdentifier(hostileSchema)}.execution_intents TO ${WORKER_ROLE}`);
        const hostileReplay = await isolated.connect();
        try {
          await hostileReplay.query(
            `SET search_path=${quoteIdentifier(hostileSchema)},public`,
          );
          await hostileReplay.query('CREATE TEMP TABLE execution_intents (id TEXT PRIMARY KEY)');
          await hostileReplay.query(provisioningSql);
          assert.match(
            (await hostileReplay.query<{ readonly search_path: string }>(
              `SELECT current_setting('search_path') AS search_path`,
            )).rows[0]?.search_path ?? '',
            new RegExp(`^${hostileSchema}, public$`, 'u'),
          );
        } finally {
          await hostileReplay.query('ROLLBACK');
          await hostileReplay.query('DROP TABLE IF EXISTS pg_temp.execution_intents');
          await hostileReplay.query('RESET search_path');
          hostileReplay.release();
        }
        assert.deepEqual((await isolated.query<{
          readonly public_select: boolean;
          readonly hostile_select: boolean;
        }>(`SELECT
            has_column_privilege($1,'public.execution_intents','id','SELECT')
              AS public_select,
            has_column_privilege($1,$2,'id','SELECT') AS hostile_select`, [
          WORKER_ROLE, `${hostileSchema}.execution_intents`,
        ])).rows, [{ public_select: true, hostile_select: false }]);

        await isolated.query(
          `GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(staleRoleName)}`,
        );
        await isolated.query(`GRANT SELECT (id,live_reserved), UPDATE (
          status,state_revision,last_reason_code,terminal_at,updated_at
        ) ON TABLE execution_intents TO ${quoteIdentifier(staleRoleName)}`);
        for (const [tableName, policyName] of [
          ['execution_intents', 'execution_intents_worker_partition'],
          ['execution_dry_run_assessments',
            'execution_dry_run_assessments_worker_partition'],
          ['execution_attempts', 'execution_attempts_worker_partition'],
          ['execution_intent_transitions',
            'execution_intent_transitions_worker_partition'],
          ['execution_simulation_artifacts',
            'execution_simulation_artifacts_worker_partition'],
        ] as const) {
          await isolated.query(`ALTER POLICY ${quoteIdentifier(policyName)}
            ON ${quoteIdentifier(tableName)} TO ${quoteIdentifier(staleRoleName)}`);
        }

        await maintenance.query(`CREATE ROLE ${quoteIdentifier(loginName)} LOGIN NOINHERIT
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
          PASSWORD ${quoteLiteral(password)}`);
        loginCreated = true;
        await maintenance.query(`GRANT ${quoteIdentifier(staleRoleName)}
          TO ${quoteIdentifier(loginName)}
          WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
        const workerUrl = new URL(isolatedUrl);
        workerUrl.username = loginName;
        workerUrl.password = password;
        workerUrl.searchParams.set(
          'options',
          `-c role=${staleRoleName} -c search_path=pg_catalog,public`,
        );
        workerPool = new pg.Pool({ connectionString: workerUrl.href, max: 1 });
        activeWorker = await workerPool.connect();

        const nonLiveId = `execution_intent_${'7'.repeat(64)}`;
        const liveId = `execution_intent_${'8'.repeat(64)}`;
        await insertPartitionIntent(isolated, nonLiveId, 'stale-non-live', false);
        await insertPartitionIntent(isolated, liveId, 'stale-live', true);
        const roleOids = (await isolated.query<{
          readonly canonical_oid: string;
          readonly stale_oid: string;
        }>(`SELECT
            (SELECT oid::TEXT FROM pg_roles WHERE rolname=$1) AS canonical_oid,
            (SELECT oid::TEXT FROM pg_roles WHERE rolname=$2) AS stale_oid`,
        [WORKER_ROLE, staleRoleName])).rows[0];
        assert.ok(roleOids !== undefined);
        const { canonical_oid: canonicalOid, stale_oid: staleOid } = roleOids;
        assert.ok(staleOid !== undefined);
        assert.notEqual(canonicalOid, staleOid);
        assert.deepEqual((await activeWorker.query<{
          readonly session_user: string;
          readonly current_user: string;
        }>('SELECT session_user,current_user')).rows, [{
          session_user: loginName, current_user: staleRoleName,
        }]);
        assert.equal((await isolated.query<{ readonly count: string }>(
          `SELECT COUNT(*)::TEXT AS count FROM pg_policy policy
            WHERE $1::OID=ANY(policy.polroles)
              AND policy.polname LIKE 'execution%worker_partition'`, [staleOid],
        )).rows[0]?.count, String(WORKER_EXECUTION_TABLES.length));
        assert.deepEqual((await activeWorker.query<{ readonly id: string }>(
          'SELECT id FROM execution_intents WHERE id=ANY($1::TEXT[]) ORDER BY id',
          [[nonLiveId, liveId]],
        )).rows, [{ id: nonLiveId }]);
        assert.equal((await activeWorker.query(`UPDATE execution_intents SET
          status='FAILED',state_revision=1,last_reason_code='BUY_SIMULATION_FAILED',
          terminal_at=date_trunc('milliseconds',statement_timestamp()),
          updated_at=date_trunc('milliseconds',statement_timestamp()) WHERE id=$1`,
        [liveId])).rowCount, 0);

        await isolated.query(`ALTER TABLE ${quoteIdentifier(hostileSchema)}.execution_attempts
          OWNER TO ${quoteIdentifier(staleRoleName)}`);
        await isolated.query(`GRANT SELECT ON TABLE
          ${quoteIdentifier(hostileSchema)}.execution_intents TO ${WORKER_ROLE}`);
        const failingReplay = await isolated.connect();
        try {
          await failingReplay.query(
            `SET search_path=${quoteIdentifier(hostileSchema)},public`,
          );
          await assert.rejects(
            failingReplay.query(provisioningSql),
            /stale worker policy role owns database objects/iu,
          );
        } finally {
          await failingReplay.query('ROLLBACK');
          await failingReplay.query('RESET search_path');
          failingReplay.release();
        }
        assert.deepEqual((await isolated.query<{
          readonly marker_select: boolean;
          readonly stale_policy_count: string;
          readonly stale_membership_count: string;
        }>(`SELECT
            has_table_privilege($1,$2,'SELECT') AS marker_select,
            (SELECT COUNT(*)::TEXT FROM pg_policy policy
              WHERE $3::OID=ANY(policy.polroles)) AS stale_policy_count,
            (SELECT COUNT(*)::TEXT FROM pg_auth_members edge
              WHERE edge.roleid=$3::OID OR edge.member=$3::OID)
              AS stale_membership_count`, [
          WORKER_ROLE, `${hostileSchema}.execution_intents`, staleOid,
        ])).rows, [{
          marker_select: true,
          stale_policy_count: String(WORKER_EXECUTION_TABLES.length),
          stale_membership_count: '1',
        }]);
        await isolated.query(`ALTER TABLE ${quoteIdentifier(hostileSchema)}.execution_attempts
          OWNER TO CURRENT_USER`);
        const successfulReplay = await isolated.connect();
        try {
          await successfulReplay.query(
            `SET search_path=${quoteIdentifier(hostileSchema)},public`,
          );
          await successfulReplay.query(provisioningSql);
        } finally {
          await successfulReplay.query('ROLLBACK');
          await successfulReplay.query('RESET search_path');
          successfulReplay.release();
        }

        let liveReadFailure: unknown;
        let liveWriteFailure: unknown;
        try {
          await activeWorker.query('SELECT id FROM execution_intents WHERE id=$1', [liveId]);
        } catch (error) {
          liveReadFailure = error;
        }
        try {
          await activeWorker.query(`UPDATE execution_intents SET
            status='FAILED',state_revision=1,last_reason_code='BUY_SIMULATION_FAILED',
            terminal_at=date_trunc('milliseconds',statement_timestamp()),
            updated_at=date_trunc('milliseconds',statement_timestamp()) WHERE id=$1`, [liveId]);
        } catch (error) {
          liveWriteFailure = error;
        }
        assert.match(String(liveReadFailure), /permission denied/iu,
          'the active stale SET ROLE session must lose live read authority on replay');
        assert.match(String(liveWriteFailure), /permission denied/iu,
          'the active stale SET ROLE session must lose live write authority on replay');

        const staleAuthority = (await isolated.query<{
          readonly membership_count: string;
          readonly column_acl_count: string;
          readonly policy_count: string;
        }>(`SELECT
            (SELECT COUNT(*)::TEXT FROM pg_auth_members
              WHERE roleid=$1::OID OR member=$1::OID) AS membership_count,
            (SELECT COUNT(*)::TEXT FROM pg_attribute attribute
              CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
              WHERE acl.grantee=$1::OID) AS column_acl_count,
            (SELECT COUNT(*)::TEXT FROM pg_policy policy
              WHERE $1::OID=ANY(policy.polroles)) AS policy_count`, [staleOid])).rows[0];
        assert.deepEqual(staleAuthority, {
          membership_count: '0', column_acl_count: '0', policy_count: '0',
        });
        assert.equal((await isolated.query<{ readonly allowed: boolean }>(
          `SELECT has_table_privilege($1,$2,'SELECT') AS allowed`, [
            WORKER_ROLE, `${hostileSchema}.execution_intents`,
          ],
        )).rows[0]?.allowed, false);
        assert.equal((await isolated.query<{ readonly count: string }>(
          `SELECT COUNT(*)::TEXT AS count FROM pg_policy policy
            WHERE $1::OID=ANY(policy.polroles)
              AND policy.polname LIKE 'execution%worker_partition'`, [canonicalOid],
        )).rows[0]?.count, String(WORKER_EXECUTION_TABLES.length));
      }
    } catch (error) {
      bodyFailure = error;
    }
    const cleanupFailures = await collectCleanupFailures([
      () => { if (activeWorker !== undefined) activeWorker.release(); },
      async () => { if (workerPool !== undefined) await workerPool.end(); },
      async () => { if (isolated !== undefined) await isolated.end(); },
      async () => {
        if (isolated !== undefined) {
          await waitForBackendDrain(maintenance, databaseName);
        }
      },
      async () => {
        if (databaseCreated) {
          await maintenance.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname=$1 AND pid<>pg_backend_pid()`, [databaseName]);
          await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
        }
      },
      async () => {
        if (loginCreated && staleRoleCreated) {
          await maintenance.query(
            `REVOKE ${quoteIdentifier(staleRoleName)} FROM ${quoteIdentifier(loginName)}`,
          );
        }
      },
      async () => {
        if (loginCreated) {
          await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(loginName)}`);
        }
      },
      async () => {
        if (staleRoleCreated) {
          await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(staleRoleName)}`);
        }
      },
      async () => { if (release !== undefined) await release(); },
      async () => maintenance.end(),
    ]);
    if (bodyFailure !== undefined) {
      throw new AggregateError(
        [bodyFailure, ...cleanupFailures],
        'Stale worker replay test failed.',
        { cause: bodyFailure },
      );
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, 'Stale worker replay cleanup failed.');
    }
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
        await clusterDrift.query(`SET ROLE ${WORKER_ROLE}`);
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
          async () => clusterDrift.query('RESET ROLE'),
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
      await assertWorkerLivePartition(worker, isolated);
      const activeWorkerPool = worker;
      const partitionAdmin = isolated;
      await context.test(
        'an active worker SET ROLE session stays partitioned after membership revocation',
        async () => assertRevokedWorkerSessionPartition(
          activeWorkerPool, partitionAdmin, loginName,
        ),
      );

      const publicParameterProbe = await isolated.connect();
      let parameterProbeFailed = false;
      let parameterProbeFailure: unknown;
      try {
        await publicParameterProbe.query(
          'GRANT SET ON PARAMETER session_replication_role TO PUBLIC',
        );
        await publicParameterProbe.query(provisioningSql);
        await publicParameterProbe.query(`SET ROLE ${WORKER_ROLE}`);
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
          async () => publicParameterProbe.query('RESET ROLE'),
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
      async () => {
        if (worker === undefined) return;
        await worker.end();
      },
      async () => {
        if (isolated !== undefined && ownedDriftCreated) {
          await isolated.query(
            `ALTER TABLE ${quoteIdentifier(ownedTable)} OWNER TO CURRENT_USER`,
          );
        }
      },
      async () => { if (isolated !== undefined) await isolated.end(); },
      async () => {
        if (isolated !== undefined) await waitForBackendDrain(maintenance, databaseName);
      },
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
  const authorityTables = Object.keys(WORKER_TABLE_AUTHORITY)
    .filter((tableName) => tableName.startsWith('execution_'));
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
      authorityTables.includes(row.relation_name),
      row.relation_name,
    );
  }
  assert.deepEqual(
    relations.rows.filter((row) => row.column_allowed).map((row) => row.relation_name),
    authorityTables.sort(),
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

async function assertWorkerLivePartition(
  worker: InstanceType<typeof pg.Pool>,
  admin: InstanceType<typeof pg.Pool>,
): Promise<void> {
  const nonLiveId = `execution_intent_${'1'.repeat(64)}`;
  const liveId = `execution_intent_${'2'.repeat(64)}`;
  const raceId = `execution_intent_${'3'.repeat(64)}`;
  const liveEvidenceId = `execution_intent_${'4'.repeat(64)}`;
  await insertPartitionIntent(admin, nonLiveId, 'non-live', false);
  await insertPartitionIntent(admin, liveId, 'live', true);
  await insertPartitionIntent(admin, raceId, 'race', false);
  await insertPartitionIntent(admin, liveEvidenceId, 'live-evidence', true);
  await admin.query(`INSERT INTO execution_attempts (
    intent_id,attempt_number,status,started_at
  ) VALUES ($1,1,'STARTED',date_trunc('milliseconds',statement_timestamp()))`, [liveId]);
  await admin.query(`INSERT INTO execution_attempts (
    intent_id,attempt_number,status,started_at
  ) VALUES ($1,1,'STARTED',date_trunc('milliseconds',statement_timestamp()))`, [liveEvidenceId]);
  await insertPartitionDryRunAssessment(admin, liveEvidenceId, '4');
  await insertPartitionTransition(admin, liveEvidenceId);
  await insertPartitionProviderFailure(admin, liveEvidenceId, '4');

  assert.deepEqual((await worker.query<{ readonly id: string }>(
    'SELECT id FROM execution_intents WHERE id=ANY($1::TEXT[]) ORDER BY id',
    [[nonLiveId, liveId]],
  )).rows, [{ id: nonLiveId }]);
  assert.deepEqual((await worker.query<{ readonly intent_id: string }>(
    'SELECT intent_id FROM execution_attempts WHERE intent_id=$1', [liveId],
  )).rows, []);
  for (const childTable of [
    'execution_dry_run_assessments',
    'execution_intent_transitions',
    'execution_simulation_artifacts',
  ]) {
    assert.deepEqual((await worker.query(
      `SELECT intent_id FROM ${childTable} WHERE intent_id=$1`, [liveEvidenceId],
    )).rows, [], childTable);
  }
  assert.equal((await worker.query(`UPDATE execution_intents SET
      status='PROCESSING',attempt_count=1,state_revision=1,lease_owner='worker',
      lease_token=$2,lease_expires_at=date_trunc('milliseconds',statement_timestamp())+INTERVAL '1 minute',
      last_reason_code='EXECUTION_STARTED',updated_at=date_trunc('milliseconds',statement_timestamp())
    WHERE id=$1`, [liveId, randomUUID()])).rowCount, 0);
  assert.equal((await worker.query(`UPDATE execution_intents SET
      status='FAILED',state_revision=1,last_reason_code='BUY_SIMULATION_FAILED',
      terminal_at=date_trunc('milliseconds',statement_timestamp()),
      updated_at=date_trunc('milliseconds',statement_timestamp()) WHERE id=$1`, [liveId])).rowCount, 0);
  await assert.rejects(worker.query(`INSERT INTO execution_attempts (
    intent_id,attempt_number,status,started_at
  ) VALUES ($1,2,'STARTED',date_trunc('milliseconds',statement_timestamp()))`, [liveId]),
  /row-level security|live_reserved|reserved/iu);
  await assert.rejects(insertPartitionDryRunAssessment(worker, liveId, '2'),
    /row-level security|live_reserved|reserved/iu);
  await assert.rejects(insertPartitionTransition(worker, liveId),
    /row-level security|live_reserved|reserved/iu);
  await assert.rejects(insertPartitionProviderFailure(worker, liveId, '2'),
    /row-level security|live_reserved|reserved/iu);
  await worker.query(`INSERT INTO execution_attempts (
    intent_id,attempt_number,status,started_at
  ) VALUES ($1,1,'STARTED',date_trunc('milliseconds',statement_timestamp()))`, [nonLiveId]);
  assert.deepEqual((await worker.query<{ readonly intent_id: string }>(
    'SELECT intent_id FROM execution_attempts WHERE intent_id=$1', [nonLiveId],
  )).rows, [{ intent_id: nonLiveId }]);

  await worker.query('SET row_security=off');
  try {
    await assert.rejects(
      worker.query('SELECT id FROM execution_intents WHERE id=ANY($1::TEXT[])', [
        [nonLiveId, liveId],
      ]),
      /row-level security/iu,
    );
  } finally {
    await worker.query('RESET row_security');
  }

  const childWriter = await worker.connect();
  const promoter = await admin.connect();
  let writerCommitted = false;
  try {
    await childWriter.query('BEGIN');
    await childWriter.query(`INSERT INTO execution_attempts (
      intent_id,attempt_number,status,started_at
    ) VALUES ($1,1,'STARTED',date_trunc('milliseconds',statement_timestamp()))`, [raceId]);
    const promoterPid = (await promoter.query<{ readonly pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    )).rows[0]?.pid;
    assert.ok(promoterPid !== undefined);
    const promotion = promoter.query(
      'UPDATE execution_intents SET live_reserved=TRUE WHERE id=$1', [raceId],
    );
    await waitForLock(admin, promoterPid);
    await childWriter.query('COMMIT');
    writerCommitted = true;
    assert.equal((await promotion).rowCount, 1);
  } finally {
    if (!writerCommitted) await childWriter.query('ROLLBACK');
    childWriter.release();
    promoter.release();
  }
  assert.deepEqual((await worker.query(
    'SELECT intent_id FROM execution_attempts WHERE intent_id=$1', [raceId],
  )).rows, []);
  await assert.rejects(worker.query(`INSERT INTO execution_attempts (
    intent_id,attempt_number,status,started_at
  ) VALUES ($1,2,'STARTED',date_trunc('milliseconds',statement_timestamp()))`, [raceId]),
  /row-level security|live_reserved|reserved/iu);
}

async function assertRevokedWorkerSessionPartition(
  workerPool: InstanceType<typeof pg.Pool>,
  admin: InstanceType<typeof pg.Pool>,
  loginName: string,
): Promise<void> {
  const nonLiveId = `execution_intent_${'5'.repeat(64)}`;
  const liveId = `execution_intent_${'6'.repeat(64)}`;
  const renamedWorkerRole = `h2j_worker_${loginName.slice(-24)}`;
  await insertPartitionIntent(admin, nonLiveId, 'revoked-non-live', false);
  await insertPartitionIntent(admin, liveId, 'revoked-live', true);

  const activeWorker = await workerPool.connect();
  let workerRenamed = false;
  try {
    assert.deepEqual((await activeWorker.query<{
      readonly session_user: string;
      readonly current_user: string;
      readonly configured_role: string;
      readonly worker_member: boolean;
    }>(`SELECT session_user,current_user,current_setting('role') AS configured_role,
        pg_has_role(session_user,$1,'MEMBER') AS worker_member`, [WORKER_ROLE])).rows, [{
      session_user: loginName,
      current_user: WORKER_ROLE,
      configured_role: WORKER_ROLE,
      worker_member: true,
    }]);

    await admin.query(`REVOKE ${WORKER_ROLE} FROM ${quoteIdentifier(loginName)}`);

    assert.deepEqual((await activeWorker.query<{
      readonly session_user: string;
      readonly current_user: string;
      readonly configured_role: string;
      readonly worker_member: boolean;
    }>(`SELECT session_user,current_user,current_setting('role') AS configured_role,
        pg_has_role(session_user,$1,'MEMBER') AS worker_member`, [WORKER_ROLE])).rows, [{
      session_user: loginName,
      current_user: WORKER_ROLE,
      configured_role: WORKER_ROLE,
      worker_member: false,
    }]);

    const visible = await activeWorker.query<{ readonly id: string }>(
      'SELECT id FROM execution_intents WHERE id=ANY($1::TEXT[]) ORDER BY id',
      [[nonLiveId, liveId]],
    );
    let childWriteFailure: unknown;
    try {
      await activeWorker.query(`INSERT INTO execution_attempts (
        intent_id,attempt_number,status,started_at
      ) VALUES ($1,1,'STARTED',date_trunc('milliseconds',statement_timestamp()))`, [liveId]);
    } catch (error) {
      childWriteFailure = error;
    }

    assert.deepEqual(visible.rows, [{ id: nonLiveId }]);
    assert.match(
      String(childWriteFailure),
      /row-level security|live_reserved|reserved/iu,
    );

    const workerOid = (await admin.query<{ readonly oid: string }>(
      'SELECT oid::TEXT AS oid FROM pg_roles WHERE rolname=$1', [WORKER_ROLE],
    )).rows[0]?.oid;
    assert.ok(workerOid !== undefined);
    await admin.query(
      `ALTER ROLE ${WORKER_ROLE} RENAME TO ${quoteIdentifier(renamedWorkerRole)}`,
    );
    workerRenamed = true;

    assert.deepEqual((await activeWorker.query<{ readonly current_user: string }>(
      'SELECT current_user',
    )).rows, [{ current_user: renamedWorkerRole }]);
    const policyTargets = await admin.query<{
      readonly policy_name: string;
      readonly target_oid: string;
    }>(`SELECT policy.polname AS policy_name,target.oid::TEXT AS target_oid
      FROM pg_policy policy
      CROSS JOIN LATERAL unnest(policy.polroles) target_oid
      JOIN pg_roles target ON target.oid=target_oid
      WHERE policy.polname LIKE 'execution%worker_partition'
      ORDER BY policy.polname`);
    assert.equal(policyTargets.rows.length, WORKER_EXECUTION_TABLES.length);
    assert.equal(policyTargets.rows.every((row) => row.target_oid === workerOid), true);
    assert.deepEqual((await activeWorker.query<{ readonly id: string }>(
      'SELECT id FROM execution_intents WHERE id=ANY($1::TEXT[]) ORDER BY id',
      [[nonLiveId, liveId]],
    )).rows, [{ id: nonLiveId }]);
  } finally {
    if (workerRenamed) {
      await admin.query(
        `ALTER ROLE ${quoteIdentifier(renamedWorkerRole)} RENAME TO ${WORKER_ROLE}`,
      );
    }
    activeWorker.release();
  }
}

async function insertPartitionIntent(
  admin: InstanceType<typeof pg.Pool>, id: string, suffix: string, liveReserved: boolean,
): Promise<void> {
  await insertExecutionDecisionEvent(
    admin, `decision-${suffix}`, '11111111111111111111111111111111',
  );
  await admin.query(`INSERT INTO execution_intents (
    id,logical_order_key,strategy_id,strategy_version,position_id,logical_command_id,mint,side,
    venue_policy,quote_mint,quote_token_program,quote_decimals,quote_amount_raw,
    minimum_amount_out_raw,decision_event_id,decision_fingerprint,requested_at,expires_at,status,
    live_reserved
  ) VALUES ($1,$2,'worker-partition',1,$3,$4,$5,'BUY','PUMP_FUN_ONLY',$5,'SPL_TOKEN',9,
    1,1,$6,$7,date_trunc('milliseconds',statement_timestamp()),
    date_trunc('milliseconds',statement_timestamp())+INTERVAL '1 minute','PENDING',$8)`, [
    id, `worker-partition-${suffix}`, `position-${suffix}`, `command-${suffix}`,
    '11111111111111111111111111111111', `decision-${suffix}`, 'a'.repeat(64), liveReserved,
  ]);
}

async function insertPartitionDryRunAssessment(
  database: InstanceType<typeof pg.Pool>, intentId: string, marker: string,
): Promise<void> {
  await database.query(`INSERT INTO execution_dry_run_assessments (
    assessment_id,intent_id,strategy_id,strategy_version,decision_fingerprint,
    intent_state_revision,intent_status,input_fingerprint,result_fingerprint
  ) VALUES ($1,$2,'worker-partition',1,$3,0,'PENDING',$4,$5)`, [
    `execution_dry_run_assessment_${marker.repeat(64)}`, intentId,
    'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64),
  ]);
}

async function insertPartitionTransition(
  database: InstanceType<typeof pg.Pool>, intentId: string,
): Promise<void> {
  await database.query(`INSERT INTO execution_intent_transitions (
    intent_id,previous_status,next_status,reason_code,human_message,activation_phase,
    attempt_number,evidence
  ) VALUES ($1,'PENDING','PROCESSING','EXECUTION_STARTED','partition test','NONE',1,
    '{"payloadVersion":1,"attemptNumber":1,"sourceEventId":null,"observedAtMs":1}'::JSONB)`, [
    intentId,
  ]);
}

async function insertPartitionProviderFailure(
  database: InstanceType<typeof pg.Pool>, intentId: string, marker: string,
): Promise<void> {
  await database.query(`INSERT INTO execution_simulation_artifacts (
    artifact_id,intent_id,attempt_number,intent_state_revision,strategy_id,strategy_version,
    decision_fingerprint,result_kind,provider_id,executor_public_key,expected_genesis_hash,
    configuration_fingerprint,rpc_calls_used,rpc_calls_limit,quote_status,build_status,
    simulation_status,failure_stage,failure_code,terminal_reason_code,result_fingerprint
  ) VALUES ($1,$2,1,0,'worker-partition',1,$3,'PROVIDER_FAILED','provider',$4,$4,$5,
    1,1,'FAILED','NOT_RUN','NOT_RUN','PROVIDER','RPC_UNAVAILABLE',
    'EXECUTION_PROVIDER_FAILED',$6)`, [
    `execution_simulation_artifact_${marker.repeat(64)}`, intentId, 'a'.repeat(64),
    '11111111111111111111111111111111', 'b'.repeat(64), 'c'.repeat(64),
  ]);
}

async function waitForLock(
  admin: InstanceType<typeof pg.Pool>, processId: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const row = (await admin.query<{ readonly wait_event_type: string | null }>(
      'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [processId],
    )).rows[0];
    if (row?.wait_event_type === 'Lock') return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  }
  assert.fail('Concurrent live promotion did not wait for the child writer parent lock.');
}

type BackendDrainQuery = pg.QueryConfig & Readonly<{ query_timeout: number }>;

type BackendDrainDependencies = Readonly<{
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}>;

async function waitForBackendDrain(
  maintenance: Pick<InstanceType<typeof pg.Pool>, 'query'>,
  databaseName: string,
  dependencies: BackendDrainDependencies = {},
): Promise<void> {
  const now = dependencies.now ?? performance.now.bind(performance);
  const wait = dependencies.wait ?? (async (delayMs) => new Promise<void>(
    (resolve) => { setTimeout(resolve, delayMs); },
  ));
  const deadline = now() + BACKEND_DRAIN_TIMEOUT_MS;
  for (;;) {
    const remainingMs = Math.ceil(deadline - now());
    if (remainingMs <= 0) break;
    const query: BackendDrainQuery = {
      text: `SELECT COUNT(*)::TEXT AS count FROM pg_stat_activity
        WHERE datname=$1`,
      values: [databaseName],
      query_timeout: remainingMs,
    };
    const activeCount = (await settleBeforeDeadline(
      maintenance.query<{ readonly count: string }>(query), remainingMs,
    )).rows[0]?.count;
    if (activeCount === '0') return;
    const delayMs = Math.min(BACKEND_DRAIN_DELAY_MS, Math.max(0, deadline - now()));
    if (delayMs <= 0) break;
    await wait(delayMs);
  }
  throw new Error('Database backends did not close before forced teardown.');
}

async function settleBeforeDeadline<TResult>(operation: Promise<TResult>, timeoutMs: number): Promise<TResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => { reject(new Error('Database backend drain query exceeded its deadline.')); },
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
    } catch (cause) {
      failures.push(new Error(`Cleanup operation ${index + 1} failed.`, { cause }));
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
