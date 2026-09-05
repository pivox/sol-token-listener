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
export const EXECUTION_READINESS_COLUMN_PRIVILEGE_COUNT = 105;

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
  (SELECT COUNT(*)::TEXT FROM information_schema.column_privileges privilege
    WHERE privilege.grantee=current_user AND privilege.table_schema='public')
    AS column_privilege_count,
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
    && row.column_privilege_count === String(EXECUTION_READINESS_COLUMN_PRIVILEGE_COUNT)
    && row.schema_usage === true && row.schema_create === false
    && row.migration_039_present === true
    && row.executable_security_definer_count === '0'
    && row.role_can_set_replication === false && row.session_can_set_replication === false;
}

function invalid(): ExecutionReadinessDatabaseError {
  return new ExecutionReadinessDatabaseError();
}
