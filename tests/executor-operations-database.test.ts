import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionOperationsBootstrapDatabase,
  createExecutionOperationsDatabase,
  ExecutionOperationsDatabaseError,
} from '../src/executor-operations/database.js';

const ROLE_QUERIES = Object.freeze([
  'SET ROLE sol_token_executor_operations',
  'SET search_path = pg_catalog, public',
  'SELECT current_user AS current_user, session_user AS session_user, '
    + "current_setting('search_path') AS search_path, "
    + "current_setting('session_replication_role') AS session_replication_role",
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
    { ...validAuthority(), current_user: 'postgres' },
    { ...validAuthority(), session_user: 'sol_token_executor_operations' },
    { ...validAuthority(), session_user: '' },
    { ...validAuthority(), search_path: 'public, pg_catalog' },
    { ...validAuthority(), session_replication_role: 'replica' },
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
    current_user: 'sol_token_executor_operations',
    session_user: 'deployer',
    search_path: 'pg_catalog, public',
    session_replication_role: 'origin',
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
