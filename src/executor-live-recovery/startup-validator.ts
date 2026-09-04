import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

export interface LiveRecoveryMigrationCatalogEntry {
  readonly name: string;
  readonly sha256: string;
}

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
  readonly migrationHead: '037_execution_live_orchestration.sql';
  readonly generationId: string;
  readonly providerId: string;
}

const CATALOG = `
001_initial.sql 4d825efda19d42e9b78ccd4905f0d882907ad52c3956b064f8f16f81363317a6
002_pumpfun_foundation.sql dc04d71f2d6f4ba087e4c720164368637da83e1eb73e58f5e7308faf3d3f7399
003_pumpfun_observations.sql e51e10ed8f42b74c45e595cc904f5553f685c15b685163af822e527348c41123
004_paper_trading.sql 13b54df9f06c7e1a3cd06a7b258853f2e0a3d237807eb695afb838473ae7ef7b
005_pumpswap_market.sql 4227e0f353d073a9115dd04b84180dd66a261ec07f9797e014167ad58b5f76f1
006_api_event_stream.sql 8bed277b894ca1b8e2787065f05ce4cf0d79c302b40b13a69578d3476ceec2c5
007_participant_analytics.sql 44a82da6340c23e8030b672dbe76d56b8c61031d2ed0d865670ef5a3930c3fb8
008_wallet_graph.sql 9e1e37f83dec100c27cbdf4571aa48d8053b25db6dd0a3fe5f720f0e708f4d5c
009_transaction_ingestion.sql f1fab847227212a85725b98f10e85ca0c9174307ffb8fc45d47ee0b67eafab82
010_transaction_inbox_timestamps.sql 15a2a1048c357466ed77fa4b78ac7a3deed88d5e9af527e2854d2ff8077eebee
011_transaction_inbox_retry_recovery.sql 32f5bbd4817df70bde162179d32c59221c27dca6007e693fb76e8a26f2d2b1c9
012_public_social_evidence.sql 2c389681136f3793961267351c63bcd97a8a5efc9e84ef4b6053b1f946a0061b
013_paper_e2e.sql a721229ca987dc03472323953566b788ac77db9968d87bb160935cbdd1879efa
014_social_persistence_retry.sql 08cfa11596886214558e18abedb9c67e52aea2be634495b86eae78f16280247a
015_paper_active_session_per_mint.sql 2dcbb50ccafa0fa7e0b49853383ab338128bd6f64ba2f2034fb483c7f71e3f91
016_listener_catch_up_gaps.sql 3a6257fb9508a8a07aed972f6b5f8c72289df3b9c7ceaf49b5c2f5aac6d9497a
017_creation_entry_strategy.sql 893c747596e1fa6e200743c6cfee97e6cfd74d525056ee1348660954bd7692e3
018_paper_mvp_validation.sql 7cef1b8888c55af975d2dde1f59e874d7386d885eba98bc839533d4b644b0e36
019_paper_mvp_collection.sql 59ef1b78c5e10e6630c1b277941b52ea1f3f642900e245e2df262da36b301028
020_paper_mvp_derived_pnl.sql 2456b5352ea45912ca1e5c53c27c82898261d5b0736ba0f9f9a85a83abdb976c
021_paper_mvp_runner_hardening.sql 1871f85bc106f63424be888a96d957a38a12516703df3a8000221a40a1c6903a
022_paper_mvp_coverage_indexes.sql e76a0a7b46d6af9d527ae617d985d7c34c0e4e8a9df665d104ed62b6f4c5388b
023_paper_mvp_exact_strategy.sql 7f25459deb5c729fd31ff114e224b85ea47fd6a8d3f19e91dfba6742cc461b05
024_paper_mvp_position_coverage.sql 81768974d497cf652452dc8b5a7aec7df278514631b74219a5fc8bc90f23a23a
025_paper_mvp_effective_configuration.sql f882e6d04e0e18b8a350a9a8ed54d1c5bac3658ac2602a7bbf63691151d5d740
026_listener_strict_catch_up_failures.sql 6e3465d6e194419316e1d19bcde459acaa06495189233f06e9dff48b51ddfd64
027_listener_provider_affine_finality.sql 1bf19a1651a0fa7f9f610e9f3f201b75af4ad8b7bb2b84f66ca52964f79ea104
028_paper_finality_replay_evidence.sql 6a1b1cc44fdf9acedf3d87b9c1caea9030bb5226f0b27bc747d018b1f8ab7203
029_paper_finality_claim_scheduler.sql e13e4983501ee6799fa496eed3008cce9700d80be64a871ad3c762926e2d0cc9
030_listener_websocket_health.sql f0c840cb3b4e74c5aa73a066455ecfa621cd919d81a9e2376ff356074f8b49f3
031_execution_intents.sql c8ea25e1152f74cf5b60d853ec442fb47ea225c93dc6e60b9b84f1b49f9395ff
032_execution_dry_run_assessments.sql 45aa9a16f12c2fcfc847a3274814c7473d3148ab6ff20364af94bd9e4f221854
033_execution_simulation_artifacts.sql 68a095552029fcb4773bfcf267bba23993cdce4f2019d9a5b922aeb55628ea6e
034_execution_risk_reconciliation.sql 4068070c90993a008619eb8a54977c058b597a84d02c74150f311d7fa33fe9aa
035_execution_preflight_operations.sql 23b47fc445850180399534638ab2f5b56fb37612caccd19c23c68dbed29806a7
036_execution_live_canary.sql ede09c7dc6eef3dd1ead634ea4aa8f52d8da69f3f269c3e0cbd60bbb0b3249d5
037_execution_live_orchestration.sql 7d07ab8d33d4f13e66cfa9718e673b0333de8135137f3ec8daa8bc7ee6ba1d35
`;

export const LIVE_RECOVERY_MIGRATION_CATALOG: readonly LiveRecoveryMigrationCatalogEntry[] =
  Object.freeze(CATALOG.trim().split('\n').map((line) => {
    const [name, sha256, ...rest] = line.split(' ');
    if (name === undefined || sha256 === undefined || rest.length !== 0) throw new Error();
    return Object.freeze({ name, sha256 });
  }));

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
  migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations'),
): Promise<void> {
  try {
    const names = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name))
      .sort((left, right) => left.localeCompare(right));
    if (!sameStrings(names, LIVE_RECOVERY_MIGRATION_CATALOG.map((item) => item.name))) {
      throw failure('MIGRATION_CATALOG_INVALID');
    }
    for (const entry of LIVE_RECOVERY_MIGRATION_CATALOG) {
      const contents = await readFile(resolve(migrationsDirectory, entry.name));
      if (createHash('sha256').update(contents).digest('hex') !== entry.sha256) {
        throw failure('MIGRATION_CATALOG_INVALID');
      }
    }
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
      migrationHead: '037_execution_live_orchestration.sql',
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
