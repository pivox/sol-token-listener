import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionIntentRepository } from
  '../src/ports/execution-intent-repository.js';
import type { ExecutionLiveRepository } from
  '../src/ports/execution-live-repository.js';
import type { ExecutionSimulationRepository } from
  '../src/ports/execution-simulation-repository.js';
import type { ExecutionVenueRepository } from
  '../src/ports/execution-venue-repository.js';
import {
  createLiveExecutorBootstrapDatabase,
  createLiveExecutorDatabase,
  LiveExecutorDatabaseError,
  LiveExecutorStartupValidationConsumedError,
} from '../src/executor-live/database.js';
import {
  createExecutionLiveRuntimeIntentRepository,
  createExecutionLiveRuntimeRepository,
  createExecutionLiveRuntimeSimulationRepository,
  createExecutionLiveRuntimeVenueRepository,
} from '../src/ports/execution-live-runtime-repository.js';

const ROLE_QUERIES = Object.freeze([
  'SET ROLE sol_token_executor_live',
  'SET search_path = pg_catalog, public',
  'SELECT current_user AS current_user, session_user AS session_user, '
    + "current_setting('search_path') AS search_path, "
    + "current_setting('session_replication_role') AS session_replication_role",
]);

void test('sets and verifies the live executor authority for every checkout', async () => {
  const queries: string[] = [];
  const releases: boolean[] = [];
  const database = createLiveExecutorDatabase({
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

void test('rejects divergent current and session roles and evicts each checkout', async () => {
  for (const authority of [
    { ...validAuthority(), current_user: 'postgres' },
    { ...validAuthority(), session_user: 'sol_token_executor_live' },
    { ...validAuthority(), session_user: '' },
    { ...validAuthority(), search_path: 'public, pg_catalog' },
    { ...validAuthority(), session_replication_role: 'replica' },
  ]) {
    const releases: boolean[] = [];
    const database = createLiveExecutorDatabase({
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

for (const [description, rejectedNumber] of [
  ['SET ROLE', 1],
  ['search path', 2],
  ['identity', 3],
] as const) {
  void test(`fails closed and evicts when ${description} setup fails`, async () => {
    const releases: boolean[] = [];
    let queryNumber = 0;
    const database = createLiveExecutorDatabase({
      connect: async () => ({
        query: async () => {
          queryNumber += 1;
          if (queryNumber === rejectedNumber) {
            throw new Error('postgresql://secret@database');
          }
          return result(validAuthority());
        },
        release: (evict = false) => { releases.push(evict); },
      }),
    });

    await assert.rejects(database.pool.connect(), isRedactedAuthorityError);
    assert.deepEqual(releases, [true]);
    assert.equal(database.hasActiveClient(), false);
  });
}

void test('redacts checkout failures and tolerates a failing eviction release', async () => {
  const database = createLiveExecutorDatabase({
    connect: async () => { throw new Error('postgresql://secret@database'); },
  });
  await assert.rejects(database.pool.connect(), isRedactedAuthorityError);

  const invalid = createLiveExecutorDatabase({
    connect: async () => ({
      query: async () => { throw new Error('private database detail'); },
      release: () => { throw new Error('private release detail'); },
    }),
  });
  await assert.rejects(invalid.pool.connect(), isRedactedAuthorityError);
  assert.equal(invalid.hasActiveClient(), false);
});

void test('evicts active work and keeps client release idempotent', async () => {
  const releases: boolean[] = [];
  const database = createLiveExecutorDatabase({
    connect: async () => ({
      query: async (text) => text.startsWith('SELECT')
        ? result(validAuthority())
        : { rows: [], rowCount: null },
      release: (evict = false) => { releases.push(evict); },
    }),
  });
  const client = await database.pool.connect();

  database.evictActive();
  database.evictActive();
  client.release();

  assert.deepEqual(releases, [true]);
  assert.equal(database.hasActiveClient(), false);
});

void test('exposes exact frozen null-prototype runtime facades', async () => {
  const intentCalls: string[] = [];
  const intentMethods = methodSource([
    'claim', 'transition', 'beginAttempt', 'finishAttempt', 'renew', 'release',
  ], intentCalls);
  const intentSource = intentMethods as unknown as Pick<ExecutionIntentRepository,
    'claim' | 'transition' | 'beginAttempt' | 'finishAttempt' | 'renew' | 'release'>;
  const intents = createExecutionLiveRuntimeIntentRepository(intentSource);

  assertExactFacade(intents, [
    'claim', 'transition', 'beginAttempt', 'finishAttempt', 'renew', 'release',
  ]);
  assert.equal(Object.hasOwn(intents, 'create'), false);
  assert.equal(Object.hasOwn(intents, 'expirePreSubmission'), false);
  await intents.claim(undefined as never);
  await intents.transition(undefined as never, undefined as never);
  await intents.beginAttempt(undefined as never);
  await intents.finishAttempt(undefined as never, undefined as never);
  await intents.renew(undefined as never, 1);
  await intents.release(undefined as never);
  assert.deepEqual(intentCalls, [
    'claim', 'transition', 'beginAttempt', 'finishAttempt', 'renew', 'release',
  ]);

  const venueCalls: string[] = [];
  const venueSource = {
    findFinalizedCanonicalPumpSwapPool: async () => {
      venueCalls.push('findFinalizedCanonicalPumpSwapPool');
      return null;
    },
  } satisfies ExecutionVenueRepository;
  const venues = createExecutionLiveRuntimeVenueRepository(venueSource);
  assertExactFacade(venues, ['findFinalizedCanonicalPumpSwapPool']);
  await venues.findFinalizedCanonicalPumpSwapPool({ mint: 'mint', quoteMint: 'quote' });
  assert.deepEqual(venueCalls, ['findFinalizedCanonicalPumpSwapPool']);

  const liveCalls: string[] = [];
  const liveMethods = methodSource([
    'readPreparationBinding', 'persistSigned', 'inspectSignedTransaction',
    'recordSignedSimulation', 'revokeBeforeSubmission', 'beginSubmission',
    'recordSubmissionOutcome',
  ], liveCalls);
  const liveSource = liveMethods as unknown as Pick<ExecutionLiveRepository,
    | 'readPreparationBinding'
    | 'persistSigned'
    | 'inspectSignedTransaction'
    | 'recordSignedSimulation'
    | 'revokeBeforeSubmission'
    | 'beginSubmission'
    | 'recordSubmissionOutcome'>;
  const live = createExecutionLiveRuntimeRepository(liveSource);

  assertExactFacade(live, [
    'readPreparationBinding', 'persistSigned', 'inspectSignedTransaction',
    'recordSignedSimulation', 'revokeBeforeSubmission', 'beginSubmission',
    'recordSubmissionOutcome',
  ]);
  for (const absent of [
    'authenticatePersistedSignedTransaction', 'recordConfirmation',
    'readConfirmationWork', 'readReconciliationWork', 'commitReconciliation',
    'createDeadlineExitIntent', 'createNextDeadlineExitIntent', 'arm', 'admit',
  ]) assert.equal(Object.hasOwn(live, absent), false);

  await live.readPreparationBinding(undefined as never);
  await live.persistSigned(undefined as never);
  await live.inspectSignedTransaction(undefined as never);
  await live.recordSignedSimulation(undefined as never, undefined as never);
  await live.revokeBeforeSubmission(undefined as never);
  await live.beginSubmission(undefined as never);
  await live.recordSubmissionOutcome(undefined as never, undefined as never);
  assert.deepEqual(liveCalls, [
    'readPreparationBinding', 'persistSigned', 'inspectSignedTransaction',
    'recordSignedSimulation', 'revokeBeforeSubmission', 'beginSubmission',
    'recordSubmissionOutcome',
  ]);

  const simulationCalls: string[] = [];
  const simulationSource = methodSource([
    'complete', 'findExact',
  ], simulationCalls) as unknown as ExecutionSimulationRepository;
  const simulations = createExecutionLiveRuntimeSimulationRepository(simulationSource);
  assertExactFacade(simulations, ['complete']);
  assert.equal(Object.hasOwn(simulations, 'findExact'), false);
  await simulations.complete(undefined as never, undefined as never, undefined as never);
  assert.deepEqual(simulationCalls, ['complete']);
});

void test('composes an exact bootstrap with a one-shot validator and closes once', async () => {
  const queries: string[] = [];
  const releases: boolean[] = [];
  let closeCalls = 0;
  let validationCalls = 0;
  const expectedEvidence = Object.freeze({ payloadVersion: 1 as const });
  const database = createLiveExecutorBootstrapDatabase({
    connect: async () => ({
      query: async (text) => {
        queries.push(text);
        if (text.includes('current_user')) return result(validAuthority());
        return result({ value: 'ok' });
      },
      release: (evict = false) => { releases.push(evict); },
    }),
  }, async () => { closeCalls += 1; }, async (startupDatabase, config) => {
    validationCalls += 1;
    assert.equal(config, expectedEvidence);
    const client = await startupDatabase.query('SELECT startup');
    assert.deepEqual(client, result({ value: 'ok' }));
    return expectedEvidence as never;
  });

  assert.deepEqual(Object.keys(database), [
    'validateStartup', 'intents', 'venues', 'live', 'simulations', 'close', 'evict',
  ]);
  assert.equal(Object.isFrozen(database), true);
  assert.equal(Object.hasOwn(database, 'pool'), false);
  assert.equal(Object.hasOwn(database, 'arm'), false);
  assert.equal(Object.hasOwn(database, 'admit'), false);
  assert.equal(Object.hasOwn(database, 'startup'), false);
  assert.equal(Object.hasOwn(database, 'query'), false);
  assertExactFacade(database.intents, [
    'claim', 'transition', 'beginAttempt', 'finishAttempt', 'renew', 'release',
  ]);
  assertExactFacade(database.venues, ['findFinalizedCanonicalPumpSwapPool']);
  assertExactFacade(database.live, [
    'readPreparationBinding', 'persistSigned', 'inspectSignedTransaction',
    'recordSignedSimulation', 'revokeBeforeSubmission', 'beginSubmission',
    'recordSubmissionOutcome',
  ]);
  assertExactFacade(database.simulations, ['complete']);
  assert.equal(await database.validateStartup(expectedEvidence as never), expectedEvidence);
  await assert.rejects(
    database.validateStartup(expectedEvidence as never),
    (error: unknown) => error instanceof LiveExecutorStartupValidationConsumedError
      && error.code === 'STARTUP_VALIDATION_CONSUMED'
      && !error.message.includes('secret')
      && !error.message.includes('postgres'),
  );
  await database.close();
  await database.close();

  assert.equal(closeCalls, 1);
  assert.equal(validationCalls, 1);
  assert.deepEqual(queries, [...ROLE_QUERIES, 'SELECT startup']);
  assert.deepEqual(releases, [false]);
});

void test('startup validation evicts its checkout when the operation fails', async () => {
  const releases: boolean[] = [];
  const failure = new Error('startup failed');
  const database = createLiveExecutorBootstrapDatabase({
    connect: async () => ({
      query: async (text) => {
        if (text.includes('current_user')) return result(validAuthority());
        if (text === 'SELECT startup') throw failure;
        return { rows: [], rowCount: null };
      },
      release: (evict = false) => { releases.push(evict); },
    }),
  }, async () => undefined, async (startupDatabase) => {
    await startupDatabase.query('SELECT startup');
    return undefined as never;
  });

  await assert.rejects(database.validateStartup(undefined as never), failure);
  assert.deepEqual(releases, [true]);
});

function validAuthority(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    current_user: 'sol_token_executor_live',
    session_user: 'deployer',
    search_path: 'pg_catalog, public',
    session_replication_role: 'origin',
  });
}

function isRedactedAuthorityError(error: unknown): boolean {
  return error instanceof LiveExecutorDatabaseError
    && error.code === 'DATABASE_ROLE_INVALID'
    && !error.message.includes('secret')
    && !error.message.includes('postgres');
}

function assertExactFacade(value: object, keys: readonly string[]): void {
  assert.deepEqual(Object.keys(value), keys);
  assert.equal(Object.getPrototypeOf(value), null);
  assert.equal(Object.isFrozen(value), true);
}

function methodSource(
  names: readonly string[],
  calls: string[],
): Readonly<Record<string, () => Promise<undefined>>> {
  return Object.fromEntries(names.map((name) => [
    name,
    async () => { calls.push(name); return undefined; },
  ]));
}

function result(row: Readonly<Record<string, unknown>>) {
  return { rows: [row], rowCount: 1 };
}
