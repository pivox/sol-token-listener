import {
  createExecutorDatabase,
  type ExecutorDatabase,
  type ExecutorDatabaseClient,
  type ExecutorDatabaseSource,
} from '../executor/database.js';
import pg from 'pg';
import { PostgresExecutionPreflightSourceRepository } from './repository.js';

export const EXECUTION_PREFLIGHT_SOURCE_ROLE = 'sol_token_operator_reader';
export const EXECUTION_PREFLIGHT_SOURCE_TABLES = Object.freeze([
  'execution_activation_armaments', 'execution_activation_events',
  'execution_control_events', 'execution_control_state', 'execution_exposure_reservations',
  'execution_provider_usage_snapshots', 'execution_reconciliation_evidence',
  'execution_safety_gate_evidence', 'execution_safety_qualifications',
  'execution_simulation_artifacts', 'execution_wallet_generations',
  'execution_wallet_risk_state', 'execution_wallet_snapshots', 'migration_history',
] as const);
export const EXECUTION_PREFLIGHT_SOURCE_INTENT_COLUMNS = Object.freeze([
  'attempt_count', 'base_amount_raw', 'created_at', 'decision_event_id',
  'decision_fingerprint', 'expires_at', 'id', 'last_reason_code', 'lease_expires_at',
  'lease_owner', 'logical_command_id', 'logical_order_key', 'minimum_amount_out_raw',
  'mint', 'payload_version', 'position_id', 'purge_after', 'quote_amount_raw',
  'quote_decimals', 'quote_mint', 'quote_token_program', 'reconciliation_completed_at',
  'requested_at', 'side', 'state_revision', 'status', 'strategy_id', 'strategy_version',
  'terminal_at', 'updated_at', 'venue_policy',
] as const);

const tableSql = EXECUTION_PREFLIGHT_SOURCE_TABLES.map((value) => `'${value}'`).join(',');
const intentColumnSql = EXECUTION_PREFLIGHT_SOURCE_INTENT_COLUMNS
  .map((value) => `'${value}'`).join(',');

export const EXECUTION_PREFLIGHT_SOURCE_AUTHORITY_SQL = `SELECT
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
  pg_has_role(session_user,'sol_token_operator_reader','MEMBER') AS reader_membership,
  (SELECT COUNT(*)::TEXT FROM pg_auth_members parent WHERE parent.member=target.oid)
    AS role_parent_count,
  has_database_privilege(current_user,current_database(),'CREATE') AS role_database_create,
  (SELECT COUNT(*)::TEXT FROM (
    SELECT 1 FROM pg_database object WHERE object.datdba=target.oid
    UNION ALL SELECT 1 FROM pg_namespace object WHERE object.nspowner=target.oid
    UNION ALL SELECT 1 FROM pg_class object WHERE object.relowner=target.oid
    UNION ALL SELECT 1 FROM pg_proc object WHERE object.proowner=target.oid
    UNION ALL SELECT 1 FROM pg_type object WHERE object.typowner=target.oid
    UNION ALL SELECT 1 FROM pg_language object WHERE object.lanowner=target.oid
    UNION ALL SELECT 1 FROM pg_default_acl object WHERE object.defaclrole=target.oid
  ) owned) AS role_owned_object_count,
  (SELECT COUNT(*)::TEXT FROM pg_namespace namespace
    WHERE namespace.nspname NOT IN ('pg_catalog','information_schema')
      AND NOT namespace.nspname LIKE 'pg_temp_%'
      AND NOT namespace.nspname LIKE 'pg_toast%'
      AND has_schema_privilege(current_user,namespace.oid,'CREATE'))
    AS creatable_schema_count,
  (SELECT COUNT(*)::TEXT FROM pg_namespace namespace
    WHERE namespace.nspname NOT IN ('pg_catalog','information_schema','public')
      AND NOT namespace.nspname LIKE 'pg_temp_%'
      AND NOT namespace.nspname LIKE 'pg_toast%'
      AND has_schema_privilege(current_user,namespace.oid,'USAGE'))
    AS unexpected_schema_usage_count,
  (SELECT COUNT(*)::TEXT FROM pg_parameter_acl object
    CROSS JOIN LATERAL aclexplode(object.paracl) acl WHERE acl.grantee=target.oid)
    AS role_parameter_authority_count,
  (SELECT COUNT(*)::TEXT FROM (
    SELECT 1 FROM pg_database object CROSS JOIN LATERAL aclexplode(object.datacl) acl
      WHERE object.datname=current_database() AND acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_database object
      WHERE object.datname=current_database() AND object.datdba=login.oid
    UNION ALL SELECT 1 FROM pg_namespace object CROSS JOIN LATERAL aclexplode(object.nspacl) acl
      WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_namespace object WHERE object.nspowner=login.oid
    UNION ALL SELECT 1 FROM pg_class object CROSS JOIN LATERAL aclexplode(object.relacl) acl
      WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_class object WHERE object.relowner=login.oid
    UNION ALL SELECT 1 FROM pg_attribute object CROSS JOIN LATERAL aclexplode(object.attacl) acl
      WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_proc object CROSS JOIN LATERAL aclexplode(object.proacl) acl
      WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_proc object WHERE object.proowner=login.oid
    UNION ALL SELECT 1 FROM pg_type object CROSS JOIN LATERAL aclexplode(object.typacl) acl
      WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_type object WHERE object.typowner=login.oid
    UNION ALL SELECT 1 FROM pg_language object CROSS JOIN LATERAL aclexplode(object.lanacl) acl
      WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_default_acl object
      CROSS JOIN LATERAL aclexplode(object.defaclacl) acl WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_default_acl object WHERE object.defaclrole=login.oid
    UNION ALL SELECT 1 FROM pg_parameter_acl object
      CROSS JOIN LATERAL aclexplode(object.paracl) acl WHERE acl.grantee=login.oid
  ) authority) AS session_direct_authority_count,
  (SELECT COUNT(*)::TEXT FROM (
    SELECT privilege_type FROM information_schema.table_privileges
      WHERE grantee IN (current_user,'PUBLIC')
        AND table_schema NOT IN ('pg_catalog','information_schema')
    UNION ALL
    SELECT privilege_type FROM information_schema.column_privileges
      WHERE grantee IN (current_user,'PUBLIC')
        AND table_schema NOT IN ('pg_catalog','information_schema')
  ) privilege WHERE privilege_type<>'SELECT') AS mutation_privilege_count,
  (SELECT COUNT(*)::TEXT FROM information_schema.column_privileges privilege
    WHERE privilege.grantee IN (current_user,'PUBLIC')
      AND privilege.table_schema NOT IN ('pg_catalog','information_schema')
      AND (privilege.privilege_type<>'SELECT'
        OR privilege.table_schema<>'public'
        OR privilege.table_name NOT IN (${tableSql},'execution_intents')
        OR (privilege.table_name='execution_intents'
          AND privilege.column_name NOT IN (${intentColumnSql}))))
    AS unexpected_column_privilege_count,
  (SELECT COALESCE(jsonb_agg(jsonb_build_array(privilege.grantee,privilege.table_schema,
      privilege.table_name,privilege.privilege_type)
      ORDER BY privilege.grantee,privilege.table_schema,privilege.table_name,
        privilege.privilege_type),'[]'::jsonb)::TEXT
    FROM information_schema.table_privileges privilege
    WHERE privilege.grantee IN (current_user,'PUBLIC')
      AND privilege.table_schema NOT IN ('pg_catalog','information_schema'))
    AS table_privileges,
  (SELECT COALESCE(jsonb_agg(jsonb_build_array(privilege.grantee,privilege.table_schema,
      privilege.column_name,privilege.privilege_type)
      ORDER BY privilege.grantee,privilege.table_schema,privilege.column_name,
        privilege.privilege_type),'[]'::jsonb)::TEXT
    FROM information_schema.column_privileges privilege
    WHERE privilege.grantee IN (current_user,'PUBLIC') AND privilege.table_schema='public'
      AND privilege.table_name='execution_intents') AS intent_columns,
  has_schema_privilege(current_user,'public','USAGE') AS schema_usage,
  has_schema_privilege(current_user,'public','CREATE') AS schema_create,
  EXISTS(SELECT 1 FROM migration_history WHERE version='039_execution_canary_operator_binding.sql')
    AS migration_039_present,
  (SELECT COUNT(*)::TEXT FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog','information_schema') AND routine.prosecdef
      AND (has_function_privilege(current_user,routine.oid,'EXECUTE')
        OR has_function_privilege(session_user,routine.oid,'EXECUTE')))
    AS executable_security_definer_count,
  has_parameter_privilege(current_user,'session_replication_role','SET')
    AS role_can_set_replication,
  has_parameter_privilege(session_user,'session_replication_role','SET')
    AS session_can_set_replication
  FROM pg_roles target CROSS JOIN pg_roles login
  JOIN pg_auth_members membership ON membership.member=login.oid
    AND membership.roleid=target.oid
  WHERE target.rolname=current_user AND login.rolname=session_user`;

export class ExecutionPreflightSourceDatabaseError extends Error {
  public readonly code = 'DATABASE_ROLE_INVALID' as const;
  public constructor() {
    super('Execution preflight source database authority is invalid.');
    this.name = 'ExecutionPreflightSourceDatabaseError';
  }
}

export interface ExecutionPreflightSourceDatabase {
  readonly repository: PostgresExecutionPreflightSourceRepository;
  readonly close: () => Promise<void>;
  readonly evict: () => void;
}

export function openExecutionPreflightSourceDatabase(options: Readonly<{
  databaseUrl: string;
  statementTimeoutMs: number;
  onIdleError: () => void;
}>): ExecutionPreflightSourceDatabase {
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 1,
    connectionTimeoutMillis: options.statementTimeoutMs,
    query_timeout: options.statementTimeoutMs, statement_timeout: options.statementTimeoutMs,
    lock_timeout: options.statementTimeoutMs,
    idle_in_transaction_session_timeout: options.statementTimeoutMs });
  pool.on('error', options.onIdleError);
  const database = createExecutionPreflightSourceDatabase(pool);
  return Object.freeze({ repository: new PostgresExecutionPreflightSourceRepository(database.pool),
    close: () => pool.end(), evict: database.evictActive });
}

export function createExecutionPreflightSourceDatabase(
  source: ExecutorDatabaseSource,
): ExecutorDatabase {
  return createExecutorDatabase(Object.freeze({
    connect: async (): Promise<ExecutorDatabaseClient> => {
      let client: ExecutorDatabaseClient;
      try { client = await source.connect(); } catch { throw invalid(); }
      try {
        await client.query(`SET ROLE ${EXECUTION_PREFLIGHT_SOURCE_ROLE}`);
        await client.query('SET search_path = pg_catalog, public');
        const result = await client.query(EXECUTION_PREFLIGHT_SOURCE_AUTHORITY_SQL);
        if (result.rowCount !== 1 || result.rows.length !== 1
          || !validAuthority(result.rows[0])) throw new TypeError();
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
  return row !== undefined && sameKeys(row, [
    'creatable_schema_count', 'current_role', 'executable_security_definer_count', 'intent_columns',
    'membership_admin', 'membership_count', 'membership_inherit', 'membership_set',
    'migration_039_present', 'mutation_privilege_count', 'reader_membership',
    'role_bypass_rls', 'role_can_set_replication', 'role_createdb', 'role_createrole',
    'role_database_create', 'role_inherit', 'role_login', 'role_owned_object_count',
    'role_parameter_authority_count', 'role_parent_count', 'role_replication', 'role_super',
    'schema_create', 'schema_usage', 'search_path', 'server_version_number',
    'session_bypass_rls', 'session_can_set_replication', 'session_createdb',
    'session_createrole', 'session_direct_authority_count', 'session_inherit',
    'session_login', 'session_replication', 'session_replication_role', 'session_role',
    'session_super', 'table_privileges', 'unexpected_column_privilege_count',
    'unexpected_schema_usage_count',
  ])
    && typeof row.server_version_number === 'number'
    && row.server_version_number >= 160_000 && row.server_version_number < 170_000
    && row.current_role === EXECUTION_PREFLIGHT_SOURCE_ROLE
    && typeof row.session_role === 'string' && row.session_role.length > 0
    && row.session_role !== row.current_role && row.search_path === 'pg_catalog, public'
    && row.session_replication_role === 'origin'
    && row.role_super === false && row.role_login === false && row.role_inherit === false
    && row.role_createdb === false && row.role_createrole === false
    && row.role_bypass_rls === false && row.role_replication === false
    && row.session_super === false && row.session_login === true
    && row.session_inherit === false && row.session_createdb === false
    && row.session_createrole === false && row.session_bypass_rls === false
    && row.session_replication === false && row.membership_count === '1'
    && row.membership_admin === false && row.membership_inherit === false
    && row.membership_set === true && row.reader_membership === true
    && row.role_parent_count === '0' && row.role_database_create === false
    && row.role_owned_object_count === '0' && row.creatable_schema_count === '0'
    && row.unexpected_schema_usage_count === '0'
    && row.role_parameter_authority_count === '0'
    && row.session_direct_authority_count === '0'
    && row.mutation_privilege_count === '0' && row.unexpected_column_privilege_count === '0'
    && validPrivileges(row.table_privileges, EXECUTION_PREFLIGHT_SOURCE_TABLES.map(
      (table) => [EXECUTION_PREFLIGHT_SOURCE_ROLE, 'public', table, 'SELECT'] as const))
    && validPrivileges(row.intent_columns, EXECUTION_PREFLIGHT_SOURCE_INTENT_COLUMNS.map(
      (column) => [EXECUTION_PREFLIGHT_SOURCE_ROLE, 'public', column, 'SELECT'] as const))
    && row.schema_usage === true && row.schema_create === false
    && row.migration_039_present === true && row.executable_security_definer_count === '0'
    && row.role_can_set_replication === false && row.session_can_set_replication === false;
}
function sameKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
function validPrivileges(
  value: unknown,
  expected: readonly (readonly string[])[],
): boolean {
  if (typeof value !== 'string' || value.length > 65_536) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.length === expected.length
      && parsed.every((entry, index) => {
        const wanted = expected[index];
        if (wanted === undefined || !Array.isArray(entry)) return false;
        return entry.length === wanted.length
          && entry.every((item, itemIndex) => item === wanted[itemIndex]);
      });
  } catch { return false; }
}
function invalid(): ExecutionPreflightSourceDatabaseError {
  return new ExecutionPreflightSourceDatabaseError();
}
