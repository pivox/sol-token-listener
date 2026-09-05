import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import {
  createExecutionPreflightSourceDatabase,
  EXECUTION_PREFLIGHT_SOURCE_AUTHORITY_SQL,
  EXECUTION_PREFLIGHT_SOURCE_INTENT_COLUMNS,
  EXECUTION_PREFLIGHT_SOURCE_TABLES,
  ExecutionPreflightSourceDatabaseError,
} from '../src/preflight-source/database.js';
import { migrateDatabase } from '../src/storage/database.js';
import { acquireExecutorRoleTestLock } from './postgres-role-test-lock.js';

void test('pins and validates the operator reader role on every checkout', async () => {
  const queries: string[] = [];
  const releases: boolean[] = [];
  const database = createExecutionPreflightSourceDatabase({ connect: async () => ({
    query: async (text) => {
      queries.push(text);
      return text.startsWith('SELECT') ? result(validAuthority()) : { rows: [], rowCount: null };
    },
    release: (evict = false) => { releases.push(evict); },
  }) });
  const client = await database.pool.connect();
  client.release();
  assert.deepEqual(queries, ['SET ROLE sol_token_operator_reader',
    'SET search_path = pg_catalog, public', EXECUTION_PREFLIGHT_SOURCE_AUTHORITY_SQL]);
  assert.deepEqual(releases, [false]);
});

void test('evicts authority drift and exposes one redacted error', async () => {
  for (const changed of [{ mutation_privilege_count: '1' },
    { unexpected_column_privilege_count: '1' }, { session_direct_authority_count: '1' },
    { table_privileges: '[]' }, { intent_columns: '[]' }, { membership_count: '2' },
    { role_database_create: true }, { role_owned_object_count: '1' },
    { creatable_schema_count: '1' }, { unexpected_schema_usage_count: '1' },
    { role_parameter_authority_count: '1' }, { server_version_number: 170_000 }]) {
    const releases: boolean[] = [];
    const database = createExecutionPreflightSourceDatabase({ connect: async () => ({
      query: async (text) => text.startsWith('SELECT')
        ? result(Object.freeze({ ...validAuthority(), ...changed }))
        : { rows: [], rowCount: null },
      release: (evict = false) => { releases.push(evict); },
    }) });
    await assert.rejects(database.pool.connect(), (error: unknown) =>
      error instanceof ExecutionPreflightSourceDatabaseError
      && error.code === 'DATABASE_ROLE_INVALID' && !error.message.includes('secret'));
    assert.deepEqual(releases, [true]);
  }
});

void test('PostgreSQL 16 operator login has exact source-only authority', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    context.skip('TEST_DATABASE_URL absent: preflight source role integration skipped');
    return;
  }
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const suffix = randomUUID().replaceAll('-', '');
  const databaseName = `preflight_source_${suffix}`;
  const login = `preflight_source_${suffix}`;
  const password = randomUUID().replaceAll('-', '');
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.pathname = `/${databaseName}`;
  let isolated: InstanceType<typeof pg.Pool> | undefined;
  let loginPool: InstanceType<typeof pg.Pool> | undefined;
  let databaseCreated = false;
  let loginCreated = false;
  const releaseRoleLock = await acquireExecutorRoleTestLock(maintenance);
  try {
    const capability = (await maintenance.query<{
      server_version_number: number;
      rolsuper: boolean;
      rolcreatedb: boolean;
    }>(`SELECT current_setting('server_version_num')::INTEGER AS server_version_number,
      role.rolsuper,role.rolcreatedb FROM pg_roles role WHERE role.rolname=current_user`)).rows[0];
    if (capability === undefined || capability.server_version_number < 160_000
      || capability.server_version_number >= 170_000
      || !capability.rolsuper || !capability.rolcreatedb) {
      context.skip('PostgreSQL 16 superuser with CREATEDB is required for source integration');
      return;
    }
    await maintenance.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    databaseCreated = true;
    const isolatedPool = new pg.Pool({ connectionString: isolatedUrl.href });
    isolated = isolatedPool;
    await migrateDatabase({ pool: isolatedPool });
    const sql = await readFile(new URL('../scripts/provision-executor-roles.sql', import.meta.url),
      'utf8');
    await isolatedPool.query(sql);
    await isolatedPool.query(sql);
    await maintenance.query(`CREATE ROLE "${login}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    loginCreated = true;
    await maintenance.query(`GRANT sol_token_operator_reader TO "${login}"
      WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
    const url = new URL(isolatedUrl);
    url.username = login;
    url.password = password;
    const activePool = new pg.Pool({ connectionString: url.href, max: 1 });
    loginPool = activePool;
    const database = createExecutionPreflightSourceDatabase(activePool);
    const client = await database.pool.connect();
    try {
      await client.query('SELECT generation_id FROM execution_wallet_generations LIMIT 1');
      await client.query('SELECT status FROM execution_intents LIMIT 1');
      await client.query('SELECT version FROM migration_history LIMIT 1');
      for (const statement of [
        'SELECT lease_token FROM execution_intents LIMIT 1',
        'SELECT signed_transaction_bytes FROM execution_signed_transactions LIMIT 1',
        'INSERT INTO execution_control_state DEFAULT VALUES',
        'DELETE FROM execution_wallet_snapshots WHERE FALSE',
      ]) await assert.rejects(client.query(statement), permissionDenied);
    } finally {
      client.release();
    }
    await isolatedPool.query(`GRANT SELECT (version) ON TABLE migration_history TO "${login}"`);
    try {
      await assert.rejects(database.pool.connect(), ExecutionPreflightSourceDatabaseError);
    } finally {
      await isolatedPool.query(`REVOKE SELECT (version) ON TABLE migration_history FROM "${login}"`);
    }
    await isolatedPool.query(`GRANT CREATE ON DATABASE "${databaseName}"
      TO sol_token_operator_reader`);
    try {
      await assert.rejects(database.pool.connect(), ExecutionPreflightSourceDatabaseError);
    } finally {
      await isolatedPool.query(`REVOKE CREATE ON DATABASE "${databaseName}"
        FROM sol_token_operator_reader`);
    }
    const privateSchema = `preflight_private_${suffix}`;
    await isolatedPool.query(`CREATE SCHEMA "${privateSchema}"`);
    await isolatedPool.query(`CREATE TABLE "${privateSchema}".extra (value INTEGER)`);
    await isolatedPool.query(`GRANT USAGE ON SCHEMA "${privateSchema}"
      TO sol_token_operator_reader`);
    await isolatedPool.query(`GRANT SELECT ON TABLE "${privateSchema}".extra
      TO sol_token_operator_reader`);
    await assert.rejects(database.pool.connect(), ExecutionPreflightSourceDatabaseError);
    await isolatedPool.query(sql);
    const restored = await database.pool.connect();
    restored.release();
    await isolatedPool.query(`GRANT SET ON PARAMETER statement_timeout
      TO sol_token_operator_reader`);
    await assert.rejects(database.pool.connect(), ExecutionPreflightSourceDatabaseError);
    await isolatedPool.query(sql);
    const parameterRestored = await database.pool.connect();
    parameterRestored.release();
  } finally {
    try {
      if (loginPool !== undefined) await loginPool.end();
      if (isolated !== undefined) await isolated.end();
      if (loginCreated) await maintenance.query(`DROP ROLE IF EXISTS "${login}"`);
      if (databaseCreated) await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } finally {
      try { await releaseRoleLock(); } finally { await maintenance.end(); }
    }
  }
});

function validAuthority(): Readonly<Record<string, unknown>> {
  return Object.freeze({ server_version_number: 160_000,
    current_role: 'sol_token_operator_reader', session_role: 'preflight_login',
    search_path: 'pg_catalog, public', session_replication_role: 'origin',
    role_super: false, role_login: false, role_inherit: false, role_createdb: false,
    role_createrole: false, role_bypass_rls: false, role_replication: false,
    session_super: false, session_login: true, session_inherit: false,
    session_createdb: false, session_createrole: false, session_bypass_rls: false,
    session_replication: false, membership_count: '1', membership_admin: false,
    membership_inherit: false, membership_set: true, reader_membership: true,
    role_parent_count: '0', role_database_create: false, role_owned_object_count: '0',
    creatable_schema_count: '0', unexpected_schema_usage_count: '0',
    role_parameter_authority_count: '0', session_direct_authority_count: '0',
    mutation_privilege_count: '0', unexpected_column_privilege_count: '0',
    table_privileges: JSON.stringify(EXECUTION_PREFLIGHT_SOURCE_TABLES.map(
      (table) => ['sol_token_operator_reader', 'public', table, 'SELECT'],
    )),
    intent_columns: JSON.stringify(EXECUTION_PREFLIGHT_SOURCE_INTENT_COLUMNS.map(
      (column) => ['sol_token_operator_reader', 'public', column, 'SELECT'],
    )),
    schema_usage: true, schema_create: false, migration_039_present: true,
    executable_security_definer_count: '0', role_can_set_replication: false,
    session_can_set_replication: false });
}
function result(row: Readonly<Record<string, unknown>>) {
  return Object.freeze({ rows: Object.freeze([row]), rowCount: 1 });
}
function permissionDenied(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '42501';
}
