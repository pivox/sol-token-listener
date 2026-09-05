import pg from 'pg';
import {
  createExecutorDatabase,
  type ExecutorDatabase,
  type ExecutorDatabaseClient,
  type ExecutorDatabaseSource,
} from '../executor/database.js';
import { PostgresExecutionReadinessRepository } from
  '../storage/execution-readiness.repository.js';

export const EXECUTION_READINESS_ROLE = 'sol_token_executor_readiness';
type ColumnPrivilege = readonly [
  grantee: string,
  table: string,
  column: string,
  privilege: string,
];

export const EXECUTION_READINESS_COLUMN_PRIVILEGES: readonly ColumnPrivilege[] = Object.freeze([
  ...columnPrivileges('migration_history', 'SELECT', ['version']),
  ...columnPrivileges('execution_wallet_generations', 'SELECT', [
    'generation_id', 'payload_version', 'wallet_public_key', 'cluster', 'genesis_hash',
    'generation', 'retired_at',
  ]),
  ...columnPrivileges('execution_wallet_generations', 'INSERT', [
    'generation_id', 'payload_version', 'wallet_public_key', 'cluster', 'genesis_hash',
    'generation',
  ]),
  ...columnPrivileges('execution_wallet_risk_state', 'SELECT', [
    'generation_id', 'state_revision', 'reconciled_capital_lamports',
    'reserved_exposure_raw', 'open_positions', 'conservative_drawdown_raw',
    'consecutive_technical_failures', 'last_technical_failure_reason_code', 'unknown_block',
  ]),
  ...columnPrivileges('execution_wallet_risk_state', 'INSERT', [
    'generation_id', 'reconciled_capital_lamports', 'reserved_exposure_raw',
    'conservative_drawdown_raw',
  ]),
  ...columnPrivileges('execution_wallet_snapshots', 'SELECT', [
    'snapshot_id', 'payload_version', 'snapshot_fingerprint', 'generation_id', 'provider_id',
    'state_revision', 'slot', 'block_time', 'observed_at', 'commitment', 'wallet_lamports',
    'token_balance_count', 'open_positions', 'position_1_id', 'position_1_cost_basis_lamports',
    'position_1_conservative_liquidation_lamports', 'position_1_reconciliation_status',
    'position_2_id', 'position_2_cost_basis_lamports',
    'position_2_conservative_liquidation_lamports', 'position_2_reconciliation_status',
    'realized_net_pnl_raw', 'superseded_at', 'purge_after',
  ]),
  ...columnPrivileges('execution_wallet_snapshots', 'INSERT', [
    'snapshot_id', 'payload_version', 'snapshot_fingerprint', 'generation_id', 'provider_id',
    'state_revision', 'slot', 'block_time', 'observed_at', 'commitment', 'wallet_lamports',
    'token_balance_count', 'open_positions', 'position_1_id', 'position_1_cost_basis_lamports',
    'position_1_conservative_liquidation_lamports', 'position_1_reconciliation_status',
    'position_2_id', 'position_2_cost_basis_lamports',
    'position_2_conservative_liquidation_lamports', 'position_2_reconciliation_status',
    'realized_net_pnl_raw',
  ]),
  ...columnPrivileges('execution_wallet_snapshots', 'UPDATE', ['superseded_at', 'purge_after']),
  ...columnPrivileges('execution_provider_usage_snapshots', 'SELECT', [
    'snapshot_id', 'payload_version', 'snapshot_fingerprint', 'provider_id', 'plan_id',
    'billing_period_id', 'billing_period_started_at', 'billing_period_ends_at', 'limit_units',
    'used_units', 'measured_at', 'expires_at', 'provenance', 'superseded_at', 'purge_after',
  ]),
  ...columnPrivileges('execution_provider_usage_snapshots', 'INSERT', [
    'snapshot_id', 'payload_version', 'snapshot_fingerprint', 'provider_id', 'plan_id',
    'billing_period_id', 'billing_period_started_at', 'billing_period_ends_at', 'limit_units',
    'used_units', 'measured_at', 'expires_at', 'provenance',
  ]),
  ...columnPrivileges('execution_provider_usage_snapshots', 'UPDATE', [
    'superseded_at', 'purge_after',
  ]),
  ...columnPrivileges('execution_live_positions', 'SELECT', ['wallet_public_key', 'state']),
].sort(compareColumnPrivileges));

export const EXECUTION_READINESS_AUTHORITY_SQL = `SELECT
  current_setting('server_version_num')::INTEGER AS server_version_number,
  current_user AS current_role,session_user AS session_role,
  current_setting('search_path') AS search_path,
  current_setting('session_replication_role') AS session_replication_role,
  target.rolsuper AS role_super,target.rolcanlogin AS role_login,
  target.rolinherit AS role_inherit,target.rolcreatedb AS role_createdb,
  target.rolcreaterole AS role_createrole,target.rolbypassrls AS role_bypass_rls,
  target.rolreplication AS role_replication,
  login.rolsuper AS session_super,login.rolcanlogin AS session_login,
  login.rolinherit AS session_inherit,login.rolcreatedb AS session_createdb,
  login.rolcreaterole AS session_createrole,login.rolbypassrls AS session_bypass_rls,
  login.rolreplication AS session_replication,
  (SELECT COUNT(*)::TEXT FROM pg_auth_members direct WHERE direct.member=login.oid)
    AS membership_count,
  membership.admin_option AS membership_admin,
  membership.inherit_option AS membership_inherit,membership.set_option AS membership_set,
  pg_has_role(session_user,'sol_token_executor_readiness','MEMBER')
    AS readiness_membership,
  (SELECT COUNT(*)::TEXT FROM pg_auth_members parent WHERE parent.member=target.oid)
    AS role_parent_count,
  (SELECT COUNT(*)::TEXT FROM (
    SELECT 1 FROM pg_database object CROSS JOIN LATERAL aclexplode(object.datacl) acl
      WHERE object.datname=current_database() AND acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_database object
      WHERE object.datname=current_database() AND object.datdba=login.oid
    UNION ALL SELECT 1 FROM pg_namespace object
      CROSS JOIN LATERAL aclexplode(object.nspacl) acl WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_namespace object WHERE object.nspowner=login.oid
    UNION ALL SELECT 1 FROM pg_class object
      CROSS JOIN LATERAL aclexplode(object.relacl) acl WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_class object WHERE object.relowner=login.oid
    UNION ALL SELECT 1 FROM pg_attribute object
      CROSS JOIN LATERAL aclexplode(object.attacl) acl WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_proc object
      CROSS JOIN LATERAL aclexplode(object.proacl) acl WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_proc object WHERE object.proowner=login.oid
    UNION ALL SELECT 1 FROM pg_type object
      CROSS JOIN LATERAL aclexplode(object.typacl) acl WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_type object WHERE object.typowner=login.oid
    UNION ALL SELECT 1 FROM pg_language object
      CROSS JOIN LATERAL aclexplode(object.lanacl) acl WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_language object WHERE object.lanowner=login.oid
    UNION ALL SELECT 1 FROM pg_default_acl object
      CROSS JOIN LATERAL aclexplode(object.defaclacl) acl WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_default_acl object WHERE object.defaclrole=login.oid
    UNION ALL SELECT 1 FROM pg_parameter_acl object
      CROSS JOIN LATERAL aclexplode(object.paracl) acl WHERE acl.grantee=login.oid
  ) direct_authority) AS session_direct_authority_count,
  (SELECT COUNT(*)::TEXT FROM information_schema.table_privileges privilege
    WHERE privilege.grantee IN (current_user,'PUBLIC')
      AND privilege.table_schema='public') AS effective_table_privilege_count,
  (SELECT COALESCE(jsonb_agg(jsonb_build_array(privilege.grantee,
      privilege.table_name,privilege.column_name,privilege.privilege_type)
      ORDER BY privilege.grantee,privilege.table_name,privilege.column_name,
        privilege.privilege_type),
      '[]'::jsonb)::TEXT
    FROM information_schema.column_privileges privilege
    WHERE privilege.grantee IN (current_user,'PUBLIC')
      AND privilege.table_schema='public')
    AS column_privileges,
  has_schema_privilege(current_user,'public','USAGE') AS schema_usage,
  has_schema_privilege(current_user,'public','CREATE') AS schema_create,
  EXISTS(SELECT 1 FROM migration_history WHERE version='039_execution_canary_operator_binding.sql')
    AS migration_039_present,
  (SELECT COUNT(*)::TEXT FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog','information_schema')
      AND routine.prosecdef
      AND (has_function_privilege(current_user,routine.oid,'EXECUTE')
        OR has_function_privilege(session_user,routine.oid,'EXECUTE'))
  ) AS executable_security_definer_count,
  has_parameter_privilege(current_user,'session_replication_role','SET')
    AS role_can_set_replication,
  has_parameter_privilege(session_user,'session_replication_role','SET')
    AS session_can_set_replication
  FROM pg_roles target CROSS JOIN pg_roles login
  JOIN pg_auth_members membership ON membership.member=login.oid
    AND membership.roleid=target.oid
  WHERE target.rolname=current_user AND login.rolname=session_user`;

export class ExecutionReadinessDatabaseError extends Error {
  public readonly code = 'DATABASE_ROLE_INVALID' as const;
  public constructor() {
    super('Execution readiness database authority is invalid.');
    this.name = 'ExecutionReadinessDatabaseError';
  }
}

export interface ExecutionReadinessBootstrapDatabase {
  readonly repository: PostgresExecutionReadinessRepository;
  readonly close: () => Promise<void>;
  readonly evict: () => void;
}

export function openExecutionReadinessDatabase(options: Readonly<{
  databaseUrl: string;
  statementTimeoutMs: number;
  onIdleError: () => void;
}>): ExecutionReadinessBootstrapDatabase {
  const pool = new pg.Pool({ connectionString: options.databaseUrl,
    connectionTimeoutMillis: options.statementTimeoutMs,
    query_timeout: options.statementTimeoutMs, statement_timeout: options.statementTimeoutMs,
    lock_timeout: options.statementTimeoutMs,
    idle_in_transaction_session_timeout: options.statementTimeoutMs });
  pool.on('error', options.onIdleError);
  return createExecutionReadinessBootstrapDatabase(pool, () => pool.end());
}

export function createExecutionReadinessBootstrapDatabase(
  source: ExecutorDatabaseSource,
  closeSource: () => Promise<void>,
): ExecutionReadinessBootstrapDatabase {
  const tracked = createExecutionReadinessDatabase(source);
  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    repository: new PostgresExecutionReadinessRepository(tracked.pool),
    close: () => { closePromise ??= closeSource(); return closePromise; },
    evict: tracked.evictActive,
  });
}

export function createExecutionReadinessDatabase(source: ExecutorDatabaseSource): ExecutorDatabase {
  return createExecutorDatabase(Object.freeze({
    connect: async (): Promise<ExecutorDatabaseClient> => {
      let client: ExecutorDatabaseClient;
      try { client = await source.connect(); } catch { throw invalid(); }
      try {
        await client.query(`SET ROLE ${EXECUTION_READINESS_ROLE}`);
        await client.query('SET search_path = pg_catalog, public');
        const result = await client.query(EXECUTION_READINESS_AUTHORITY_SQL);
        if (result.rowCount !== 1 || result.rows.length !== 1
          || !validAuthority(result.rows[0])) throw new Error();
      } catch {
        try { client.release(true); } catch { /* closed error wins */ }
        throw invalid();
      }
      let released = false;
      return Object.freeze({
        query: (text: string, values?: readonly unknown[]) => client.query(text, values),
        release: (evict = false) => {
          if (released) return;
          released = true;
          client.release(evict);
        },
      });
    },
  }));
}

function validAuthority(row: Readonly<Record<string, unknown>> | undefined): boolean {
  return row !== undefined
    && sameKeys(row, [
      'column_privileges', 'current_role', 'effective_table_privilege_count',
      'executable_security_definer_count', 'membership_admin', 'membership_count',
      'membership_inherit', 'membership_set', 'migration_039_present',
      'readiness_membership', 'role_bypass_rls', 'role_can_set_replication',
      'role_createdb', 'role_createrole', 'role_inherit', 'role_login',
      'role_parent_count', 'role_replication', 'role_super', 'schema_create',
      'schema_usage', 'search_path', 'server_version_number', 'session_bypass_rls',
      'session_can_set_replication', 'session_createdb', 'session_createrole',
      'session_direct_authority_count', 'session_inherit', 'session_login',
      'session_replication', 'session_replication_role', 'session_role', 'session_super',
    ])
    && typeof row.server_version_number === 'number'
    && row.server_version_number >= 160_000 && row.server_version_number < 170_000
    && row.current_role === EXECUTION_READINESS_ROLE
    && typeof row.session_role === 'string' && row.session_role.length > 0
    && row.session_role !== row.current_role
    && row.search_path === 'pg_catalog, public' && row.session_replication_role === 'origin'
    && row.role_super === false && row.role_login === false && row.role_inherit === false
    && row.role_createdb === false && row.role_createrole === false
    && row.role_bypass_rls === false && row.role_replication === false
    && row.session_super === false && row.session_login === true
    && row.session_inherit === false && row.session_createdb === false
    && row.session_createrole === false && row.session_bypass_rls === false
    && row.session_replication === false
    && row.membership_count === '1' && row.membership_admin === false
    && row.membership_inherit === false && row.membership_set === true
    && row.readiness_membership === true && row.role_parent_count === '0'
    && row.session_direct_authority_count === '0'
    && row.effective_table_privilege_count === '0'
    && validColumnPrivileges(row.column_privileges)
    && row.schema_usage === true && row.schema_create === false
    && row.migration_039_present === true
    && row.executable_security_definer_count === '0'
    && row.role_can_set_replication === false && row.session_can_set_replication === false;
}

function sameKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function columnPrivileges(
  table: string,
  privilege: string,
  columns: readonly string[],
): ColumnPrivilege[] {
  return columns.map((column) => Object.freeze([
    EXECUTION_READINESS_ROLE, table, column, privilege,
  ] as const));
}

function compareColumnPrivileges(left: ColumnPrivilege, right: ColumnPrivilege): number {
  return left[0].localeCompare(right[0]) || left[1].localeCompare(right[1])
    || left[2].localeCompare(right[2]) || left[3].localeCompare(right[3]);
}

function validColumnPrivileges(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 65_536) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)
      || parsed.length !== EXECUTION_READINESS_COLUMN_PRIVILEGES.length) return false;
    return parsed.every((entry, index) => {
      const expected = EXECUTION_READINESS_COLUMN_PRIVILEGES[index];
      return Array.isArray(entry) && entry.length === 4 && expected !== undefined
        && entry[0] === expected[0] && entry[1] === expected[1]
        && entry[2] === expected[2] && entry[3] === expected[3];
    });
  } catch {
    return false;
  }
}

function invalid(): ExecutionReadinessDatabaseError {
  return new ExecutionReadinessDatabaseError();
}
