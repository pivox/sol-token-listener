import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionDryRunAssessment } from '../src/domain/execution-dry-run.js';
import { createExecutionIntentDraft, type ExecutionIntentV1 } from '../src/domain/execution-intent.js';
import { createDryRunWorker } from '../src/executor/dry-run-worker.js';
import type { ExecutionDryRunRepository } from '../src/ports/execution-dry-run-repository.js';
import type {
  ClaimedExecutionIntent,
  ExecutionIntentRepository,
} from '../src/ports/execution-intent-repository.js';
import { ExecutionDryRunRepositoryError } from '../src/storage/execution-dry-run.repository.js';

void test('returns IDLE after one exact DRY_RUN claim and performs no other repository operation', async () => {
  const fake = fakes(null);
  const result = await createDryRunWorker(fake.dependencies).runOnce();

  assert.equal(result, 'IDLE');
  assert.deepEqual(fake.claimOptions, [Object.freeze({
    ownerId: 'executor-dry-run-worker-1', leaseMs: 30_000, purpose: 'DRY_RUN',
  })]);
  assert.equal(Object.isFrozen(fake.claimOptions[0]), true);
  assertForbiddenCalls(fake);
});

void test('creates the pure frozen assessment, completes it and returns RECORDED', async () => {
  const claimed = claim();
  const fake = fakes(claimed);
  const result = await createDryRunWorker(fake.dependencies).runOnce();

  assert.equal(result, 'RECORDED');
  assert.equal(fake.completed.length, 1);
  assert.equal(fake.completed[0]?.claim, claimed);
  assert.deepEqual(fake.completed[0]?.assessment, createExecutionDryRunAssessment(claimed.intent));
  assert.equal(Object.isFrozen(fake.completed[0]?.assessment), true);
  assert.equal(fake.findInputs.length, 0);
  assertForbiddenCalls(fake);
});

void test('recovers only an exact committed assessment after COMMIT_OUTCOME_UNKNOWN', async () => {
  const claimed = claim();
  const commitError = new ExecutionDryRunRepositoryError('COMMIT_OUTCOME_UNKNOWN');
  const fake = fakes(claimed, { completeError: commitError, find: 'EXACT' });

  assert.equal(await createDryRunWorker(fake.dependencies).runOnce(), 'COMMIT_RECOVERED');
  assert.equal(fake.findInputs.length, 1);
  assert.deepEqual(fake.findInputs[0], createExecutionDryRunAssessment(claimed.intent));
  assertForbiddenCalls(fake);
});

void test('rethrows the original ambiguous commit error when findExact returns no row', async () => {
  const commitError = new ExecutionDryRunRepositoryError('COMMIT_OUTCOME_UNKNOWN');
  const fake = fakes(claim(), { completeError: commitError, find: 'MISSING' });

  await assert.rejects(createDryRunWorker(fake.dependencies).runOnce(), (error) => error === commitError);
  assert.equal(fake.findInputs.length, 1);
  assertForbiddenCalls(fake);
});

void test('propagates a contradictory findExact failure after an ambiguous commit', async () => {
  const commitError = new ExecutionDryRunRepositoryError('COMMIT_OUTCOME_UNKNOWN');
  const contradiction = new ExecutionDryRunRepositoryError('INVALID_DATA');
  const fake = fakes(claim(), { completeError: commitError, findError: contradiction });

  await assert.rejects(createDryRunWorker(fake.dependencies).runOnce(), (error) => error === contradiction);
  assert.equal(fake.findInputs.length, 1);
  assertForbiddenCalls(fake);
});

void test('never calls findExact for database, fencing, conflict or spoofed commit errors', async () => {
  const errors: readonly Error[] = [
    new ExecutionDryRunRepositoryError('DATABASE_FAILURE'),
    new ExecutionDryRunRepositoryError('INTENT_FENCE_LOST'),
    new ExecutionDryRunRepositoryError('ASSESSMENT_CONFLICT'),
    Object.assign(new Error('spoofed commit error'), { code: 'COMMIT_OUTCOME_UNKNOWN' }),
  ];
  for (const expected of errors) {
    const fake = fakes(claim(), { completeError: expected });
    await assert.rejects(createDryRunWorker(fake.dependencies).runOnce(), (error) => error === expected);
    assert.equal(fake.findInputs.length, 0);
    assertForbiddenCalls(fake);
  }
});

void test('propagates a lost claim without attempting assessment completion or recovery', async () => {
  const claimError = new Error('claim lost');
  const fake = fakes(null, { claimError });

  await assert.rejects(createDryRunWorker(fake.dependencies).runOnce(), (error) => error === claimError);
  assert.equal(fake.completed.length, 0);
  assert.equal(fake.findInputs.length, 0);
  assertForbiddenCalls(fake);
});

void test('shares one in-flight pass across concurrent runOnce calls', async () => {
  const gate = deferred<ClaimedExecutionIntent | null>();
  const fake = fakes(null, { claimResult: gate.promise });
  const worker = createDryRunWorker(fake.dependencies);

  const first = worker.runOnce();
  const second = worker.runOnce();
  assert.equal(first, second);
  assert.equal(fake.claimOptions.length, 1);
  gate.resolve(null);
  assert.deepEqual(await Promise.all([first, second]), ['IDLE', 'IDLE']);
  assertForbiddenCalls(fake);
});

function fakes(
  claimed: ClaimedExecutionIntent | null,
  behavior: Readonly<{
    claimError?: Error;
    claimResult?: Promise<ClaimedExecutionIntent | null>;
    completeError?: Error;
    find?: 'EXACT' | 'MISSING';
    findError?: Error;
  }> = {},
) {
  const claimOptions: Readonly<{ ownerId: string; leaseMs: number; purpose: string }>[] = [];
  const completed: Readonly<{ claim: ClaimedExecutionIntent; assessment: ReturnType<typeof createExecutionDryRunAssessment> }>[] = [];
  const findInputs: ReturnType<typeof createExecutionDryRunAssessment>[] = [];
  const forbidden = { renew: 0, release: 0, beginAttempt: 0, finishAttempt: 0, transition: 0 };
  const intents = {
    claim: async (options: Readonly<{ ownerId: string; leaseMs: number; purpose: 'EXECUTE' | 'CONFIRM' | 'RECONCILE' | 'DRY_RUN' }>) => {
      claimOptions.push(options);
      if (behavior.claimError !== undefined) return Promise.reject(behavior.claimError);
      return behavior.claimResult ?? claimed;
    },
    renew: async () => { forbidden.renew += 1; return true; },
    release: async () => { forbidden.release += 1; return true; },
    beginAttempt: async () => { forbidden.beginAttempt += 1; throw new Error('forbidden'); },
    finishAttempt: async () => { forbidden.finishAttempt += 1; return true; },
    transition: async () => { forbidden.transition += 1; throw new Error('forbidden'); },
  } as unknown as ExecutionIntentRepository;
  const assessments: ExecutionDryRunRepository = {
    complete: async (claimValue, assessment) => {
      completed.push({ claim: claimValue, assessment });
      if (behavior.completeError !== undefined) return Promise.reject(behavior.completeError);
      return Object.freeze({ ...assessment, recordedAtMs: 1_000 });
    },
    findExact: async (assessment) => {
      findInputs.push(assessment);
      if (behavior.findError !== undefined) return Promise.reject(behavior.findError);
      return behavior.find === 'EXACT'
        ? Object.freeze({ ...assessment, recordedAtMs: 1_000 })
        : null;
    },
  };
  return {
    dependencies: Object.freeze({
      intents, assessments, ownerId: 'executor-dry-run-worker-1', leaseMs: 30_000,
    }),
    claimOptions, completed, findInputs, forbidden,
  };
}

function claim(): ClaimedExecutionIntent {
  const draft = createExecutionIntentDraft({
    strategyId: 'dry-run-strategy', strategyVersion: 1, positionId: 'position-1',
    logicalCommandId: 'command-1', mint: '11111111111111111111111111111111',
    side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112', quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9, quoteAmountRaw: 1n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: 'event-1', decisionFingerprint: 'a'.repeat(64),
    requestedAtMs: 1_000, expiresAtMs: 100_000,
  });
  const intent: ExecutionIntentV1 = Object.freeze({
    ...draft, status: 'PENDING', attemptCount: 0, stateRevision: 0n, lastReasonCode: null,
    terminalAtMs: null, reconciliationCompletedAtMs: null, purgeAfterMs: null,
    createdAtMs: 1_000, updatedAtMs: 1_000,
  });
  return Object.freeze({
    intent, leaseOwner: 'executor-dry-run-worker-1',
    leaseToken: '123e4567-e89b-42d3-a456-426614174000', leaseExpiresAtMs: 31_000,
  });
}

function assertForbiddenCalls(fake: ReturnType<typeof fakes>): void {
  assert.deepEqual(fake.forbidden, {
    renew: 0, release: 0, beginAttempt: 0, finishAttempt: 0, transition: 0,
  });
}

function deferred<Value>(): Readonly<{
  promise: Promise<Value>;
  resolve(value: Value): void;
}> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => { resolve = settle; });
  return { promise, resolve };
}
