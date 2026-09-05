import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import {
  createExecutionReadinessBootstrapDatabase,
  createExecutionReadinessDatabase,
  EXECUTION_READINESS_AUTHORITY_SQL,
  EXECUTION_READINESS_COLUMN_PRIVILEGES,
  ExecutionReadinessDatabaseError,
} from '../src/executor-readiness/database.js';
import { migrateDatabase } from '../src/storage/database.js';
import { acquireExecutorRoleTestLock } from './postgres-role-test-lock.js';

void test('pins and validates the readiness role on every checkout', async () => {
  const queries: string[] = [];
  const releases: boolean[] = [];
  const database = createExecutionReadinessDatabase({ connect: async () => ({
    query: async (text) => {
      queries.push(text);
      return text.startsWith('SELECT') ? result(validAuthority()) : { rows: [], rowCount: null };
    },
    release: (evict = false) => { releases.push(evict); },
  }) });
  const first = await database.pool.connect();
  first.release();
  const second = await database.pool.connect();
  second.release();
  assert.deepEqual(queries, [
    'SET ROLE sol_token_executor_readiness', 'SET search_path = pg_catalog, public',
    EXECUTION_READINESS_AUTHORITY_SQL,
    'SET ROLE sol_token_executor_readiness', 'SET search_path = pg_catalog, public',
    EXECUTION_READINESS_AUTHORITY_SQL,
  ]);
  assert.deepEqual(releases, [false, false]);
});

void test('evicts every authority drift with a redacted error', async () => {
  for (const changed of [
    { column_privileges: driftedPrivileges() }, { schema_create: true },
    { migration_039_present: false }, { readiness_membership: false },
    { membership_count: '2' }, { session_inherit: true },
    { server_version_number: 170_000 },
  ]) {
    const releases: boolean[] = [];
    const database = createExecutionReadinessDatabase({ connect: async () => ({
      query: async (text) => text.startsWith('SELECT')
        ? result(Object.freeze({ ...validAuthority(), ...changed }))
        : { rows: [], rowCount: null },
      release: (evict = false) => { releases.push(evict); },
    }) });
    await assert.rejects(database.pool.connect(),
      (error: unknown) => error instanceof ExecutionReadinessDatabaseError
        && error.code === 'DATABASE_ROLE_INVALID'
        && !error.message.includes('secret'));
    assert.deepEqual(releases, [true]);
  }
});

void test('bootstrap exposes only repository and bounded lifecycle', async () => {
  let closes = 0;
  const database = createExecutionReadinessBootstrapDatabase({ connect: async () => ({
    query: async (text) => text.startsWith('SELECT')
      ? result(validAuthority()) : { rows: [], rowCount: null },
    release() {},
  }) }, async () => { closes += 1; });
  assert.deepEqual(Object.keys(database), ['repository', 'close', 'evict']);
  await database.close();
  await database.close();
  assert.equal(closes, 1);
});

void test('PostgreSQL 16 login has exact readiness authority and no live authority', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    context.skip('TEST_DATABASE_URL absent: readiness role integration skipped');
    return;
  }
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const suffix = randomUUID().replaceAll('-', '');
  const databaseName = `readiness_role_${suffix}`;
  const login = `readiness_${suffix}`;
  const password = randomUUID().replaceAll('-', '');
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.pathname = `/${databaseName}`;
  let isolated: InstanceType<typeof pg.Pool> | undefined;
  let loginPool: InstanceType<typeof pg.Pool> | undefined;
  let databaseCreated = false;
  let loginCreated = false;
  const releaseRoleLock = await acquireExecutorRoleTestLock(maintenance);
  try {
    const server = await maintenance.query<{
      server_version_number: number;
      rolsuper: boolean;
      rolcreatedb: boolean;
    }>(
      `SELECT current_setting('server_version_num')::INTEGER AS server_version_number,
        role.rolsuper,role.rolcreatedb FROM pg_roles role WHERE role.rolname=current_user`,
    );
    const capability = server.rows[0];
    if (capability === undefined || capability.server_version_number < 160_000
      || capability.server_version_number >= 170_000
      || !capability.rolsuper || !capability.rolcreatedb) {
      context.skip('PostgreSQL 16 superuser with CREATEDB is required for readiness role integration');
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
    await maintenance.query(`GRANT sol_token_executor_readiness TO "${login}"
      WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
    const url = new URL(isolatedUrl);
    url.username = login;
    url.password = password;
    const activePool = new pg.Pool({ connectionString: url.href, max: 1 });
    loginPool = activePool;
    const database = createExecutionReadinessDatabase(activePool);
    const client = await database.pool.connect();
    try {
      await client.query('SELECT version FROM migration_history LIMIT 1');
      for (const statement of [
        'SELECT id FROM execution_intents LIMIT 1',
        'SELECT armament_id FROM execution_activation_armaments LIMIT 1',
        'SELECT signed_transaction_bytes FROM execution_signed_transactions LIMIT 1',
        'INSERT INTO execution_control_state DEFAULT VALUES',
        'DELETE FROM execution_wallet_snapshots WHERE FALSE',
      ]) await assert.rejects(client.query(statement), permissionDenied);
    } finally {
      client.release();
    }
    await isolatedPool.query(`GRANT SELECT (signed_transaction_bytes)
      ON TABLE execution_signed_transactions TO PUBLIC`);
    try {
      await assert.rejects(database.pool.connect(), ExecutionReadinessDatabaseError);
    } finally {
      await isolatedPool.query(`REVOKE SELECT (signed_transaction_bytes)
        ON TABLE execution_signed_transactions FROM PUBLIC`);
    }
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
    current_role: 'sol_token_executor_readiness', session_role: 'deployer',
    search_path: 'pg_catalog, public', session_replication_role: 'origin',
    role_super: false, role_login: false, role_inherit: false, role_createdb: false,
    role_createrole: false, role_bypass_rls: false, role_replication: false,
    session_super: false, session_login: true, session_inherit: false,
    session_createdb: false, session_createrole: false, session_bypass_rls: false,
    session_replication: false, membership_count: '1', membership_admin: false,
    membership_inherit: false, membership_set: true, readiness_membership: true,
    role_parent_count: '0',
    column_privileges: JSON.stringify(EXECUTION_READINESS_COLUMN_PRIVILEGES),
    schema_usage: true,
    schema_create: false, migration_039_present: true,
    executable_security_definer_count: '0', role_can_set_replication: false,
    session_can_set_replication: false });
}

function driftedPrivileges(): string {
  const privileges = EXECUTION_READINESS_COLUMN_PRIVILEGES.map((entry) => [...entry]);
  privileges[0] = ['PUBLIC', 'execution_signed_transactions',
    'signed_transaction_bytes', 'SELECT'];
  return JSON.stringify(privileges);
}

function result(row: Readonly<Record<string, unknown>>) {
  return Object.freeze({ rows: Object.freeze([row]), rowCount: 1 });
}

function permissionDenied(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '42501';
}
