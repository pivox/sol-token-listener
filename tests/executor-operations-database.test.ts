import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionOperationsBootstrapDatabase,
  createExecutionOperationsDatabase,
  EXECUTION_OPERATIONS_AUTHORITY_SQL,
  ExecutionOperationsDatabaseError,
} from '../src/executor-operations/database.js';

const ROLE_QUERIES = Object.freeze([
  'SET ROLE sol_token_executor_operations',
  'SET search_path = pg_catalog, public',
  EXECUTION_OPERATIONS_AUTHORITY_SQL,
]);

void test('operations database pins and verifies its role for every checkout', async () => {
  const queries: string[] = [];
  const releases: boolean[] = [];
  const database = createExecutionOperationsDatabase({
    connect: async () => ({
      query: async (text) => {
        queries.push(text);
        return text.startsWith('SELECT')
          ? result(validAuthority())
          : { rows: [], rowCount: null };
      },
      release: (evict = false) => { releases.push(evict); },
    }),
  });

  const first = await database.pool.connect();
  first.release();
  const second = await database.pool.connect();
  second.release();

  assert.deepEqual(queries, [...ROLE_QUERIES, ...ROLE_QUERIES]);
  assert.deepEqual(releases, [false, false]);
  assert.equal(database.hasActiveClient(), false);
});

void test('operations database rejects authority drift and evicts the checkout', async () => {
  for (const authority of [
    { ...validAuthority(), current_role: 'postgres' },
    { ...validAuthority(), session_role: 'sol_token_executor_operations' },
    { ...validAuthority(), session_role: '' },
    { ...validAuthority(), search_path: 'public, pg_catalog' },
    { ...validAuthority(), session_replication_role: 'replica' },
    { ...validAuthority(), session_super: true },
    { ...validAuthority(), session_inherit: true },
    { ...validAuthority(), session_createdb: true },
    { ...validAuthority(), membership_count: '2' },
    { ...validAuthority(), membership_admin: true },
    { ...validAuthority(), membership_inherit: true },
    { ...validAuthority(), membership_set: false },
    { ...validAuthority(), operations_membership: false },
    { ...validAuthority(), role_parent_count: '1' },
    { ...validAuthority(), session_direct_authority_count: '1' },
    { ...validAuthority(), executable_security_definer_count: '1' },
    { ...validAuthority(), role_can_set_replication: true },
    { ...validAuthority(), session_can_set_replication: true },
  ]) {
    const releases: boolean[] = [];
    const database = createExecutionOperationsDatabase({
      connect: async () => ({
        query: async (text) => text.startsWith('SELECT')
          ? result(authority)
          : { rows: [], rowCount: null },
        release: (evict = false) => { releases.push(evict); },
      }),
    });

    await assert.rejects(database.pool.connect(), isRedactedAuthorityError);
    assert.deepEqual(releases, [true]);
    assert.equal(database.hasActiveClient(), false);
  }
});

void test('operations bootstrap exposes only the repository and bounded lifecycle', async () => {
  let closeCalls = 0;
  const database = createExecutionOperationsBootstrapDatabase({
    connect: async () => ({
      query: async (text) => text.startsWith('SELECT')
        ? result(validAuthority())
        : { rows: [], rowCount: null },
      release: () => undefined,
    }),
  }, async () => { closeCalls += 1; });

  assert.deepEqual(Object.keys(database), ['repository', 'close', 'evict']);
  assert.equal(Object.isFrozen(database), true);
  assert.equal(Object.hasOwn(database, 'pool'), false);
  assert.equal(Object.hasOwn(database, 'query'), false);
  await database.close();
  await database.close();
  assert.equal(closeCalls, 1);
});

function validAuthority(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    server_version_number: 160_000,
    current_role: 'sol_token_executor_operations', session_role: 'deployer',
    search_path: 'pg_catalog, public',
    session_replication_role: 'origin',
    role_super: false, role_login: false, role_inherit: false,
    role_createdb: false, role_createrole: false, role_bypass_rls: false,
    role_replication: false,
    session_super: false, session_login: true, session_inherit: false,
    session_createdb: false, session_createrole: false, session_bypass_rls: false,
    session_replication: false,
    membership_count: '1', membership_admin: false, membership_inherit: false,
    membership_set: true, operations_membership: true, role_parent_count: '0',
    session_direct_authority_count: '0', executable_security_definer_count: '0',
    role_can_set_replication: false, session_can_set_replication: false,
  });
}

function result(row: Readonly<Record<string, unknown>>) {
  return Object.freeze({ rows: Object.freeze([row]), rowCount: 1 });
}

function isRedactedAuthorityError(error: unknown): boolean {
  return error instanceof ExecutionOperationsDatabaseError
    && error.code === 'DATABASE_ROLE_INVALID'
    && !error.message.includes('postgres')
    && !error.message.includes('secret');
}
