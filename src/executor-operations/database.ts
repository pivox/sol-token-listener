import pg from 'pg';
import {
  createExecutorDatabase,
  type ExecutorDatabase,
  type ExecutorDatabaseClient,
  type ExecutorDatabaseSource,
} from '../executor/database.js';
import { PostgresExecutionOperationsRepository } from
  '../storage/execution-operations.repository.js';

export const EXECUTION_OPERATIONS_ROLE = 'sol_token_executor_operations';

export const EXECUTION_OPERATIONS_AUTHORITY_SQL = `SELECT
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
  pg_has_role(session_user,'sol_token_executor_operations','MEMBER')
    AS operations_membership,
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

export class ExecutionOperationsDatabaseError extends Error {
  public readonly code = 'DATABASE_ROLE_INVALID' as const;

  public constructor() {
    super('Execution operations database authority is invalid.');
    this.name = 'ExecutionOperationsDatabaseError';
  }
}

export interface ExecutionOperationsBootstrapDatabase {
  readonly repository: PostgresExecutionOperationsRepository;
  readonly close: () => Promise<void>;
  readonly evict: () => void;
}

export interface OpenExecutionOperationsDatabaseOptions {
  readonly databaseUrl: string;
  readonly statementTimeoutMs: number;
  readonly onIdleError: () => void;
}

export function openExecutionOperationsDatabase(
  options: OpenExecutionOperationsDatabaseOptions,
): ExecutionOperationsBootstrapDatabase {
  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: options.statementTimeoutMs,
    query_timeout: options.statementTimeoutMs,
    statement_timeout: options.statementTimeoutMs,
    lock_timeout: options.statementTimeoutMs,
    idle_in_transaction_session_timeout: options.statementTimeoutMs,
  });
  pool.on('error', options.onIdleError);
  return createExecutionOperationsBootstrapDatabase(pool, () => pool.end());
}

export function createExecutionOperationsBootstrapDatabase(
  source: ExecutorDatabaseSource,
  closeSource: () => Promise<void>,
): ExecutionOperationsBootstrapDatabase {
  const tracked = createExecutionOperationsDatabase(source);
  const repository = new PostgresExecutionOperationsRepository(tracked.pool);
  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    repository,
    close: () => {
      closePromise ??= closeSource();
      return closePromise;
    },
    evict: tracked.evictActive,
  });
}

export function createExecutionOperationsDatabase(
  source: ExecutorDatabaseSource,
): ExecutorDatabase {
  return createExecutorDatabase(Object.freeze({
    connect: async (): Promise<ExecutorDatabaseClient> => {
      let client: ExecutorDatabaseClient;
      try {
        client = await source.connect();
      } catch {
        throw new ExecutionOperationsDatabaseError();
      }
      try {
        await client.query(`SET ROLE ${EXECUTION_OPERATIONS_ROLE}`);
        await client.query('SET search_path = pg_catalog, public');
        const result = await client.query(EXECUTION_OPERATIONS_AUTHORITY_SQL);
        const row = result.rows[0];
        if (result.rowCount !== 1 || result.rows.length !== 1
          || row === undefined || !validOperationsAuthority(row)) throw new Error();
      } catch {
        safeRelease(client, true);
        throw new ExecutionOperationsDatabaseError();
      }
      let released = false;
      return Object.freeze({
        query: (text: string, values?: readonly unknown[]) => client.query(text, values),
        release: (evict?: boolean): void => {
          if (released) return;
          released = true;
          client.release(evict === true);
        },
      });
    },
  }));
}

function validOperationsAuthority(row: Readonly<Record<string, unknown>>): boolean {
  return sameKeys(row, [
    'current_role', 'executable_security_definer_count', 'membership_admin',
    'membership_count', 'membership_inherit', 'membership_set', 'operations_membership',
    'role_bypass_rls', 'role_can_set_replication', 'role_createdb', 'role_createrole',
    'role_inherit', 'role_login', 'role_parent_count', 'role_replication', 'role_super',
    'search_path', 'server_version_number', 'session_bypass_rls',
    'session_can_set_replication', 'session_createdb', 'session_createrole',
    'session_direct_authority_count', 'session_inherit', 'session_login',
    'session_replication', 'session_replication_role', 'session_role', 'session_super',
  ])
    && typeof row.server_version_number === 'number'
    && row.server_version_number >= 160_000 && row.server_version_number < 170_000
    && row.current_role === EXECUTION_OPERATIONS_ROLE
    && typeof row.session_role === 'string' && row.session_role.length > 0
    && row.session_role !== row.current_role
    && row.search_path === 'pg_catalog, public'
    && row.session_replication_role === 'origin'
    && row.role_super === false && row.role_login === false && row.role_inherit === false
    && row.role_createdb === false && row.role_createrole === false
    && row.role_bypass_rls === false && row.role_replication === false
    && row.session_super === false && row.session_login === true
    && row.session_inherit === false && row.session_createdb === false
    && row.session_createrole === false && row.session_bypass_rls === false
    && row.session_replication === false
    && row.membership_count === '1' && row.operations_membership === true
    && row.membership_admin === false && row.membership_inherit === false
    && row.membership_set === true && row.role_parent_count === '0'
    && row.session_direct_authority_count === '0'
    && row.executable_security_definer_count === '0'
    && row.role_can_set_replication === false
    && row.session_can_set_replication === false;
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

function safeRelease(client: ExecutorDatabaseClient, evict: boolean): void {
  try {
    client.release(evict);
  } catch {
    // A release failure must not replace the closed, redacted authority error.
  }
}
