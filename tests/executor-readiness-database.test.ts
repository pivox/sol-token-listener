import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import {
  createExecutionReadinessBootstrapDatabase,
  createExecutionReadinessDatabase,
  EXECUTION_READINESS_AUTHORITY_SQL,
  ExecutionReadinessDatabaseError,
} from '../src/executor-readiness/database.js';

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
    { column_privilege_count: '106' }, { schema_create: true },
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
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const suffix = randomUUID().replaceAll('-', '');
  const login = `readiness_${suffix}`;
  const password = randomUUID().replaceAll('-', '');
  let loginPool: InstanceType<typeof pg.Pool> | undefined;
  try {
    const server = await admin.query<{ server_version_number: number }>(
      "SELECT current_setting('server_version_num')::INTEGER AS server_version_number",
    );
    const serverVersion = server.rows[0]?.server_version_number ?? 0;
    if (serverVersion < 160_000 || serverVersion >= 170_000) {
      context.skip('PostgreSQL 16 is required for readiness role integration');
      return;
    }
    const sql = await readFile(new URL('../scripts/provision-executor-roles.sql', import.meta.url),
      'utf8');
    await admin.query(sql);
    await admin.query(sql);
    await admin.query(`CREATE ROLE "${login}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`GRANT sol_token_executor_readiness TO "${login}"
      WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
    const url = new URL(databaseUrl);
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
  } finally {
    if (loginPool !== undefined) await loginPool.end();
    await admin.query(`DROP ROLE IF EXISTS "${login}"`);
    await admin.end();
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
    role_parent_count: '0', column_privilege_count: '105', schema_usage: true,
    schema_create: false, migration_039_present: true,
    executable_security_definer_count: '0', role_can_set_replication: false,
    session_can_set_replication: false });
}

function result(row: Readonly<Record<string, unknown>>) {
  return Object.freeze({ rows: Object.freeze([row]), rowCount: 1 });
}

function permissionDenied(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '42501';
}
