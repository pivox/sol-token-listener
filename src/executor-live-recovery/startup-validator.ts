import {
  LIVE_EXECUTION_MIGRATION_CATALOG,
  validateLiveExecutionMigrationFiles,
  type LiveExecutionMigrationCatalogEntry,
} from '../execution-migrations/live-catalog.js';
import type { LiveRecoveryConfig } from './config.js';
import { LIVE_RECOVERY_DATABASE_AUTHORITY } from './database-authority.js';

export type LiveRecoveryStartupErrorCode =
  | 'MIGRATION_CATALOG_INVALID'
  | 'DATABASE_ROLE_INVALID'
  | 'MIGRATION_HISTORY_INVALID'
  | 'GENERATION_BINDING_INVALID'
  | 'OPEN_WORK_BINDING_INVALID'
  | 'DATABASE_READ_FAILED';

export class LiveRecoveryStartupError extends Error {
  public constructor(public readonly code: LiveRecoveryStartupErrorCode) {
    super('Live recovery startup validation failed.');
    this.name = 'LiveRecoveryStartupError';
  }
}

export type LiveRecoveryMigrationCatalogEntry = LiveExecutionMigrationCatalogEntry;

export interface LiveRecoveryStartupDatabase {
  readonly query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<Readonly<{
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    readonly rowCount: number | null;
  }>>;
}

export interface LiveRecoveryStartupEvidenceV1 {
  readonly payloadVersion: 1;
  readonly role: 'sol_token_executor_live_recovery';
  readonly migrationHead: '038_execution_live_rpc_budget.sql';
  readonly generationId: string;
  readonly providerId: string;
}

export const LIVE_RECOVERY_MIGRATION_CATALOG: readonly LiveRecoveryMigrationCatalogEntry[] =
  LIVE_EXECUTION_MIGRATION_CATALOG;

export const LIVE_RECOVERY_EFFECTIVE_PRIVILEGES_SQL = `
  /* live_recovery_effective_privileges */
  WITH relations AS (
    SELECT class.oid,namespace.nspname AS schema_name,class.relname,
      class.relowner,class.relkind
    FROM pg_class class JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
    WHERE namespace.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
  ), column_privilege(privilege) AS (
    VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')
  ), table_privilege(privilege) AS (
    VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),
      ('REFERENCES'),('TRIGGER')
  ), sequence_privilege(privilege) AS (
    VALUES ('USAGE'),('SELECT'),('UPDATE')
  ), schema_privilege(privilege) AS (
    VALUES ('USAGE'),('CREATE')
  )
  SELECT 'COLUMN'::TEXT AS kind,
    (relation.schema_name || '.' || relation.relname)::TEXT AS object_name,
    attribute.attname::TEXT AS subobject_name,permission.privilege::TEXT AS privilege,
    has_column_privilege(current_user,relation.oid,attribute.attnum,
      permission.privilege || ' WITH GRANT OPTION') AS is_grantable
  FROM relations relation
  JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
    AND attribute.attnum>0 AND NOT attribute.attisdropped
  CROSS JOIN column_privilege permission
  WHERE relation.relkind IN ('r','p','v','m','f')
    AND has_column_privilege(current_user,relation.oid,attribute.attnum,
      permission.privilege)
  UNION ALL
  SELECT 'TABLE',relation.schema_name || '.' || relation.relname,
    NULL,permission.privilege,
    has_table_privilege(current_user,relation.oid,
      permission.privilege || ' WITH GRANT OPTION')
  FROM relations relation CROSS JOIN table_privilege permission
  WHERE relation.relkind IN ('r','p','v','m','f')
    AND has_table_privilege(current_user,relation.oid,permission.privilege)
  UNION ALL
  SELECT 'OWNER',relation.schema_name || '.' || relation.relname,
    NULL,'OWNER',TRUE
  FROM relations relation
  WHERE relation.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
  UNION ALL
  SELECT 'SEQUENCE',relation.schema_name || '.' || relation.relname,
    NULL,permission.privilege,
    has_sequence_privilege(current_user,relation.oid,
      permission.privilege || ' WITH GRANT OPTION')
  FROM relations relation CROSS JOIN sequence_privilege permission
  WHERE relation.relkind='S'
    AND has_sequence_privilege(current_user,relation.oid,permission.privilege)
  UNION ALL
  SELECT 'SCHEMA',namespace.nspname,NULL,permission.privilege,
    has_schema_privilege(current_user,namespace.oid,
      permission.privilege || ' WITH GRANT OPTION')
  FROM pg_namespace namespace CROSS JOIN schema_privilege permission
  WHERE namespace.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
    AND namespace.nspname NOT LIKE 'pg_temp_%'
    AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
    AND has_schema_privilege(current_user,namespace.oid,permission.privilege)
  ORDER BY kind,object_name,subobject_name NULLS FIRST,privilege`;

export async function validateLiveRecoveryMigrationFiles(
  migrationsDirectory?: string,
): Promise<void> {
  try {
    await validateLiveExecutionMigrationFiles(migrationsDirectory);
  } catch (error) {
    if (error instanceof LiveRecoveryStartupError) throw error;
    throw failure('MIGRATION_CATALOG_INVALID');
  }
}

export async function validateLiveRecoveryStartup(
  database: LiveRecoveryStartupDatabase,
  config: LiveRecoveryConfig,
  options: Readonly<{ readonly validateFiles?: boolean }> = {},
): Promise<LiveRecoveryStartupEvidenceV1> {
  if (options.validateFiles !== false) await validateLiveRecoveryMigrationFiles();
  try {
    const role = oneRow(await database.query(`SELECT
      current_setting('server_version_num')::INTEGER AS server_version_number,
      current_user AS current_role,
      session_user AS session_role,
      target.rolsuper AS role_super,target.rolcanlogin AS role_login,
      target.rolinherit AS role_inherit,target.rolcreatedb AS role_createdb,
      target.rolcreaterole AS role_createrole,target.rolbypassrls AS role_bypass_rls,
      target.rolreplication AS role_replication,
      login.rolsuper AS session_super,login.rolcanlogin AS session_login,
      login.rolinherit AS session_inherit,login.rolcreatedb AS session_createdb,
      login.rolcreaterole AS session_createrole,
      login.rolbypassrls AS session_bypass_rls,
      login.rolreplication AS session_replication,
      (SELECT COUNT(*)::TEXT FROM pg_auth_members membership
        WHERE membership.member=login.oid) AS membership_count,
      membership.admin_option AS membership_admin,
      membership.inherit_option AS membership_inherit,
      membership.set_option AS membership_set,
      (SELECT COUNT(*)::TEXT FROM pg_auth_members parent_membership
        WHERE parent_membership.member=target.oid) AS recovery_parent_count,
      (SELECT COUNT(*)::TEXT FROM (
        SELECT 1 FROM pg_database object
          CROSS JOIN LATERAL aclexplode(object.datacl) acl_entry
          WHERE object.datname=current_database() AND acl_entry.grantee=login.oid
        UNION ALL SELECT 1 FROM pg_database object
          WHERE object.datname=current_database() AND object.datdba=login.oid
        UNION ALL SELECT 1 FROM pg_namespace object
          CROSS JOIN LATERAL aclexplode(object.nspacl) acl_entry
          WHERE acl_entry.grantee=login.oid
        UNION ALL SELECT 1 FROM pg_namespace object WHERE object.nspowner=login.oid
        UNION ALL SELECT 1 FROM pg_class object
          CROSS JOIN LATERAL aclexplode(object.relacl) acl_entry
          WHERE acl_entry.grantee=login.oid
        UNION ALL SELECT 1 FROM pg_class object WHERE object.relowner=login.oid
        UNION ALL SELECT 1 FROM pg_attribute object
          CROSS JOIN LATERAL aclexplode(object.attacl) acl_entry
          WHERE acl_entry.grantee=login.oid
        UNION ALL SELECT 1 FROM pg_proc object
          CROSS JOIN LATERAL aclexplode(object.proacl) acl_entry
          WHERE acl_entry.grantee=login.oid
        UNION ALL SELECT 1 FROM pg_proc object WHERE object.proowner=login.oid
        UNION ALL SELECT 1 FROM pg_type object
          CROSS JOIN LATERAL aclexplode(object.typacl) acl_entry
          WHERE acl_entry.grantee=login.oid
        UNION ALL SELECT 1 FROM pg_type object WHERE object.typowner=login.oid
        UNION ALL SELECT 1 FROM pg_language object
          CROSS JOIN LATERAL aclexplode(object.lanacl) acl_entry
          WHERE acl_entry.grantee=login.oid
        UNION ALL SELECT 1 FROM pg_language object WHERE object.lanowner=login.oid
        UNION ALL SELECT 1 FROM pg_default_acl object WHERE object.defaclrole=login.oid
        UNION ALL SELECT 1 FROM pg_default_acl object
          CROSS JOIN LATERAL aclexplode(object.defaclacl) acl_entry
          WHERE acl_entry.grantee=login.oid
        UNION ALL SELECT 1 FROM pg_parameter_acl object
          CROSS JOIN LATERAL aclexplode(object.paracl) acl_entry
          WHERE acl_entry.grantee=login.oid
      ) direct_authority) AS session_direct_authority_count,
      (SELECT COUNT(*)::TEXT FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
        WHERE namespace.nspname NOT IN ('pg_catalog','information_schema')
          AND routine.prosecdef
          AND (has_function_privilege(current_user,routine.oid,'EXECUTE')
            OR has_function_privilege(session_user,routine.oid,'EXECUTE'))
      ) AS executable_security_definer_count,
      has_function_privilege(current_user,
        'public.execution_live_state_transition_allowed(text,text,text)','EXECUTE')
        AS state_transition_executable,
      has_function_privilege(current_user,
        'public.execution_submission_event_matches_transition(text,text,text)','EXECUTE')
        AS submission_transition_executable,
      has_parameter_privilege(current_user,'session_replication_role','SET')
        AS recovery_can_set_replication_role,
      has_parameter_privilege(session_user,'session_replication_role','SET')
        AS session_can_set_replication_role,
      pg_has_role(session_user,'sol_token_executor_live_recovery','MEMBER')
        AS recovery_membership,
      has_column_privilege(current_user,'execution_signed_transactions',
        'signed_transaction_bytes','SELECT') AS can_read_signed_bytes,
      has_table_privilege(current_user,'execution_signed_transactions','INSERT')
        AS can_insert_signed_transaction,
      has_column_privilege(current_user,'execution_signed_transactions',
        'submission_started_at','UPDATE') AS can_update_submission_started,
      has_table_privilege(current_user,'execution_signed_simulation_evidence','INSERT')
        AS can_insert_signed_simulation,
      has_table_privilege(current_user,'execution_submission_preflight_evidence','INSERT')
        AS can_insert_preflight
      FROM pg_roles target CROSS JOIN pg_roles login
      JOIN pg_auth_members membership ON membership.member=login.oid
        AND membership.roleid=target.oid
      WHERE target.rolname=current_user AND login.rolname=session_user`));
    if (!validRecoveryRole(role)) {
      throw failure('DATABASE_ROLE_INVALID');
    }
    const effectivePrivileges = await database.query(
      LIVE_RECOVERY_EFFECTIVE_PRIVILEGES_SQL,
    );
    if (!sameStrings(
      effectivePrivileges.rows.map(privilegeKey).sort(),
      expectedPrivilegeKeys(),
    )) throw failure('DATABASE_ROLE_INVALID');

    const migrations = await database.query(
      'SELECT version FROM migration_history ORDER BY version',
    );
    const versions = migrations.rows.map((row) => exactTextRow(row, 'version'));
    if (!sameStrings(versions, LIVE_RECOVERY_MIGRATION_CATALOG.map((item) => item.name))) {
      throw failure('MIGRATION_HISTORY_INVALID');
    }

    const generation = oneRow(await database.query(`SELECT generation_id,wallet_public_key,
      cluster,genesis_hash,retired_at FROM execution_wallet_generations
      WHERE generation_id=$1`, [config.generationId]));
    if (generation.generation_id !== config.generationId
      || generation.wallet_public_key !== config.executorPublicKey
      || generation.cluster !== config.cluster
      || generation.genesis_hash !== config.expectedGenesisHash
      || generation.retired_at !== null) throw failure('GENERATION_BINDING_INVALID');

    const work = oneRow(await database.query(`SELECT (
      (SELECT COUNT(*) FROM execution_signed_transactions transaction
        WHERE transaction.state IN ('SUBMISSION_STARTED','ACCEPTED','AMBIGUOUS','CONFIRMED')
          AND (transaction.generation_id<>$1 OR transaction.wallet_public_key<>$2
            OR transaction.provider_id<>$3))
      + (SELECT COUNT(*) FROM execution_live_positions position
          JOIN execution_activation_armaments armament
            ON armament.armament_id=position.armament_id
        WHERE position.state IN ('OPEN','EXIT_PENDING','UNKNOWN')
          AND (position.generation_id<>$1 OR position.wallet_public_key<>$2
            OR armament.provider_id<>$3))
      )::TEXT AS divergent_work_count`, [
      config.generationId, config.executorPublicKey, config.providerId,
    ]));
    if (work.divergent_work_count !== '0') throw failure('OPEN_WORK_BINDING_INVALID');

    return Object.freeze({
      payloadVersion: 1,
      role: 'sol_token_executor_live_recovery',
      migrationHead: '038_execution_live_rpc_budget.sql',
      generationId: config.generationId,
      providerId: config.providerId,
    });
  } catch (error) {
    if (error instanceof LiveRecoveryStartupError) throw error;
    throw failure('DATABASE_READ_FAILED');
  }
}

function validRecoveryRole(role: Readonly<Record<string, unknown>>): boolean {
  return typeof role.server_version_number === 'number'
    && role.server_version_number >= 160_000
    && role.current_role === 'sol_token_executor_live_recovery'
    && typeof role.session_role === 'string'
    && role.session_role !== role.current_role
    && role.role_super === false
    && role.role_login === false
    && role.role_inherit === false
    && role.role_createdb === false
    && role.role_createrole === false
    && role.role_bypass_rls === false
    && role.role_replication === false
    && role.session_super === false
    && role.session_login === true
    && role.session_inherit === false
    && role.session_createdb === false
    && role.session_createrole === false
    && role.session_bypass_rls === false
    && role.session_replication === false
    && role.membership_count === '1'
    && role.recovery_membership === true
    && role.membership_admin === false
    && role.membership_inherit === false
    && role.membership_set === true
    && role.recovery_parent_count === '0'
    && role.session_direct_authority_count === '0'
    && role.executable_security_definer_count === '0'
    && role.state_transition_executable === true
    && role.submission_transition_executable === true
    && role.recovery_can_set_replication_role === false
    && role.session_can_set_replication_role === false
    && role.can_read_signed_bytes === false
    && role.can_insert_signed_transaction === false
    && role.can_update_submission_started === false
    && role.can_insert_signed_simulation === false
    && role.can_insert_preflight === false;
}

function expectedPrivilegeKeys(): string[] {
  const expected = [privilegeKeyFrom('SCHEMA', LIVE_RECOVERY_DATABASE_AUTHORITY.schema,
    null, 'USAGE', false)];
  for (const table of LIVE_RECOVERY_DATABASE_AUTHORITY.tables) {
    for (const [privilege, columns] of [
      ['SELECT', table.select],
      ['INSERT', table.insert],
      ['UPDATE', table.update],
    ] as const) {
      for (const column of columns) {
        expected.push(privilegeKeyFrom(
          'COLUMN',
          `${LIVE_RECOVERY_DATABASE_AUTHORITY.schema}.${table.name}`,
          column,
          privilege,
          false,
        ));
      }
    }
  }
  for (const sequence of LIVE_RECOVERY_DATABASE_AUTHORITY.sequences) {
    for (const privilege of sequence.privileges) {
      expected.push(privilegeKeyFrom(
        'SEQUENCE',
        `${LIVE_RECOVERY_DATABASE_AUTHORITY.schema}.${sequence.name}`,
        null,
        privilege,
        false,
      ));
    }
  }
  return expected.sort();
}

function privilegeKey(row: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(row).sort();
  if (!sameStrings(keys, [
    'is_grantable', 'kind', 'object_name', 'privilege', 'subobject_name',
  ])
    || typeof row.kind !== 'string' || typeof row.object_name !== 'string'
    || (row.subobject_name !== null && typeof row.subobject_name !== 'string')
    || typeof row.privilege !== 'string'
    || typeof row.is_grantable !== 'boolean') throw new Error();
  return privilegeKeyFrom(
    row.kind,
    row.object_name,
    row.subobject_name,
    row.privilege,
    row.is_grantable,
  );
}

function privilegeKeyFrom(
  kind: string,
  objectName: string,
  subobjectName: string | null,
  privilege: string,
  isGrantable: boolean,
): string {
  return `${kind}\u0000${objectName}\u0000${subobjectName ?? ''}\u0000${privilege}`
    + `\u0000${isGrantable ? 'GRANTABLE' : 'NOT_GRANTABLE'}`;
}

function oneRow(result: Readonly<{
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number | null;
}>): Readonly<Record<string, unknown>> {
  if (result.rowCount !== 1 || result.rows.length !== 1 || result.rows[0] === undefined) {
    throw new Error();
  }
  return result.rows[0];
}

function exactTextRow(row: Readonly<Record<string, unknown>>, key: string): string {
  const keys = Object.keys(row);
  if (keys.length !== 1 || keys[0] !== key || typeof row[key] !== 'string') throw new Error();
  return row[key];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function failure(code: LiveRecoveryStartupErrorCode): LiveRecoveryStartupError {
  return new LiveRecoveryStartupError(code);
}
