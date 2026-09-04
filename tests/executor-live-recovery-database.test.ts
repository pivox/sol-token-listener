import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClaimedExecutionIntent } from '../src/ports/execution-intent-repository.js';
import type { ExecutionLiveRepository } from '../src/ports/execution-live-repository.js';
import {
  createLiveRecoveryBootstrapDatabase,
  createLiveRecoveryDatabase,
  LiveRecoveryDatabaseError,
} from '../src/executor-live-recovery/database.js';
import {
  createExecutionLiveRecoveryIntentRepository,
  createExecutionLiveRecoveryRepository,
} from '../src/ports/execution-live-recovery-repository.js';

void test('sets and verifies the recovery role for every checkout', async () => {
  const queries: string[] = [];
  const releases: boolean[] = [];
  const database = createLiveRecoveryDatabase({
    connect: async () => ({
      query: async (text) => {
        queries.push(text);
        return text.startsWith('SELECT')
          ? result({
            current_user: 'sol_token_executor_live_recovery',
            session_user: 'deployer',
            search_path: 'pg_catalog, public',
            session_replication_role: 'origin',
          })
          : { rows: [], rowCount: null };
      },
      release: (evict = false) => { releases.push(evict); },
    }),
  });

  const first = await database.pool.connect();
  first.release();
  const second = await database.pool.connect();
  second.release();

  assert.deepEqual(queries, [
    'SET ROLE sol_token_executor_live_recovery',
    'SET search_path = pg_catalog, public',
    'SELECT current_user AS current_user, session_user AS session_user, '
      + "current_setting('search_path') AS search_path, "
      + "current_setting('session_replication_role') AS session_replication_role",
    'SET ROLE sol_token_executor_live_recovery',
    'SET search_path = pg_catalog, public',
    'SELECT current_user AS current_user, session_user AS session_user, '
      + "current_setting('search_path') AS search_path, "
      + "current_setting('session_replication_role') AS session_replication_role",
  ]);
  assert.deepEqual(releases, [false, false]);
  assert.equal(database.hasActiveClient(), false);
});

void test('evicts role failures and active work without leaking database details', async () => {
  const releases: boolean[] = [];
  const database = createLiveRecoveryDatabase({
    connect: async () => ({
      query: async (text) => text.startsWith('SELECT')
        ? result({
          current_user: 'postgres', session_user: 'postgres',
          search_path: 'pg_catalog, public',
          session_replication_role: 'origin',
        })
        : { rows: [], rowCount: null },
      release: (evict = false) => { releases.push(evict); },
    }),
  });
  await assert.rejects(database.pool.connect(), (error: unknown) => (
    error instanceof LiveRecoveryDatabaseError
      && error.code === 'DATABASE_ROLE_INVALID'
      && !error.message.includes('postgres')
  ));
  assert.deepEqual(releases, [true]);
  assert.equal(database.hasActiveClient(), false);

  const activeReleases: boolean[] = [];
  const activeDatabase = createLiveRecoveryDatabase({
    connect: async () => ({
      query: async (text) => text.startsWith('SELECT')
        ? result({
          current_user: 'sol_token_executor_live_recovery',
          session_user: 'deployer',
          search_path: 'pg_catalog, public',
          session_replication_role: 'origin',
        })
        : { rows: [], rowCount: null },
      release: (evict = false) => { activeReleases.push(evict); },
    }),
  });
  const client = await activeDatabase.pool.connect();
  assert.equal(activeDatabase.hasActiveClient(), true);
  activeDatabase.evictActive();
  assert.equal(activeDatabase.hasActiveClient(), false);
  client.release();
  assert.deepEqual(activeReleases, [true]);
});

void test('evicts a checkout whose session replication role is not origin', async () => {
  const releases: boolean[] = [];
  const database = createLiveRecoveryDatabase({
    connect: async () => ({
      query: async (text) => text.startsWith('SELECT')
        ? result({
          current_user: 'sol_token_executor_live_recovery',
          session_user: 'deployer',
          search_path: 'pg_catalog, public',
          session_replication_role: 'replica',
        })
        : { rows: [], rowCount: null },
      release: (evict = false) => { releases.push(evict); },
    }),
  });

  await assert.rejects(database.pool.connect(), (error: unknown) => (
    error instanceof LiveRecoveryDatabaseError
      && error.code === 'DATABASE_ROLE_INVALID'
  ));
  assert.deepEqual(releases, [true]);
  assert.equal(database.hasActiveClient(), false);
});

for (const [rejectedQuery, rejectedNumber] of [
  ['SET ROLE', 1], ['search path', 2], ['identity', 3],
] as const) {
  void test(`evicts the client when the ${rejectedQuery} query is rejected`, async () => {
    const releases: boolean[] = [];
    let queryNumber = 0;
    const database = createLiveRecoveryDatabase({
      connect: async () => ({
        query: async () => {
          queryNumber += 1;
          if (queryNumber === rejectedNumber) {
            throw new Error('postgresql://secret@database');
          }
          return { rows: [], rowCount: null };
        },
        release: (evict = false) => { releases.push(evict); },
      }),
    });

    await assert.rejects(database.pool.connect(), (error: unknown) => (
      error instanceof LiveRecoveryDatabaseError
        && error.code === 'DATABASE_ROLE_INVALID'
        && !error.message.includes('secret')
    ));
    assert.deepEqual(releases, [true]);
    assert.equal(database.hasActiveClient(), false);
  });
}

void test('exposes exact frozen null-prototype facades and fixes claim purposes', async () => {
  const calls: unknown[] = [];
  const claim = Object.freeze({}) as ClaimedExecutionIntent;
  const intents = createExecutionLiveRecoveryIntentRepository({
    claim: async (options, signal) => { calls.push(['claim', options, signal]); return claim; },
    renew: async (value, leaseMs) => { calls.push(['renew', value, leaseMs]); return value; },
    release: async (value) => { calls.push(['release', value]); return true; },
  });
  const signal = new AbortController().signal;
  await intents.claimConfirmation('owner-a', 10_000, signal);
  await intents.claimReconciliation('owner-a', 10_000, signal);
  await intents.renew(claim, 10_000);
  await intents.release(claim);

  assert.deepEqual(Object.keys(intents), [
    'claimConfirmation', 'claimReconciliation', 'renew', 'release',
  ]);
  assert.equal(Object.getPrototypeOf(intents), null);
  assert.equal(Object.isFrozen(intents), true);
  assert.deepEqual(calls, [
    ['claim', { ownerId: 'owner-a', leaseMs: 10_000, purpose: 'CONFIRM' }, signal],
    ['claim', { ownerId: 'owner-a', leaseMs: 10_000, purpose: 'RECONCILE' }, signal],
    ['renew', claim, 10_000],
    ['release', claim],
  ]);

  const liveCalls: string[] = [];
  const liveSource = (Object.fromEntries([
    'readConfirmationWork', 'recordConfirmation', 'readReconciliationWork',
    'commitReconciliation', 'createNextDeadlineExitIntent',
  ].map((name) => [name, async () => { liveCalls.push(name); return null; }]))) as unknown as Pick<ExecutionLiveRepository,
      | 'readConfirmationWork'
      | 'recordConfirmation'
      | 'readReconciliationWork'
      | 'commitReconciliation'
      | 'createNextDeadlineExitIntent'>;
  const live = createExecutionLiveRecoveryRepository(liveSource);

  assert.deepEqual(Object.keys(live), [
    'readConfirmationWork', 'recordConfirmation', 'readReconciliationWork',
    'commitReconciliation', 'createNextDeadlineExitIntent',
  ]);
  assert.equal(Object.getPrototypeOf(live), null);
  assert.equal(Object.isFrozen(live), true);
  assert.equal(Object.hasOwn(live, 'persistSigned'), false);
  await live.readConfirmationWork(undefined as never);
  await live.recordConfirmation(undefined as never, undefined as never);
  await live.readReconciliationWork(undefined as never);
  await live.commitReconciliation(undefined as never, undefined as never);
  await live.createNextDeadlineExitIntent();
  assert.deepEqual(liveCalls, [
    'readConfirmationWork', 'recordConfirmation', 'readReconciliationWork',
    'commitReconciliation', 'createNextDeadlineExitIntent',
  ]);
});

void test('composes a dedicated bootstrap without exposing a pool or full repository', async () => {
  const queries: string[] = [];
  let closeCalls = 0;
  const database = createLiveRecoveryBootstrapDatabase({
    connect: async () => ({
      query: async (text) => {
        queries.push(text);
        if (text.includes('current_user')) return result({
          current_user: 'sol_token_executor_live_recovery',
          session_user: 'deployer',
          search_path: 'pg_catalog, public',
          session_replication_role: 'origin',
        });
        return result({ value: 'ok' });
      },
      release: () => undefined,
    }),
  }, async () => { closeCalls += 1; });

  assert.deepEqual(Object.keys(database), ['startup', 'intents', 'live', 'close', 'evict']);
  assert.equal(Object.hasOwn(database, 'pool'), false);
  assert.equal(Object.hasOwn(database.intents, 'claim'), false);
  assert.equal(Object.hasOwn(database.live, 'persistSigned'), false);
  assert.deepEqual(await database.startup.query('SELECT value'), result({ value: 'ok' }));
  await database.close();
  await database.close();
  assert.equal(closeCalls, 1);
  assert.deepEqual(queries, [
    'SET ROLE sol_token_executor_live_recovery',
    'SET search_path = pg_catalog, public',
    'SELECT current_user AS current_user, session_user AS session_user, '
      + "current_setting('search_path') AS search_path, "
      + "current_setting('session_replication_role') AS session_replication_role",
    'SELECT value',
  ]);
});

function result(row: Readonly<Record<string, unknown>>) {
  return { rows: [row], rowCount: 1 };
}
