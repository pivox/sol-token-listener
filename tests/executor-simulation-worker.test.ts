import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionSimulationArtifact,
  createExecutionSimulationArtifactDraft,
  type ExecutionSimulationArtifactDraftV1,
} from '../src/domain/execution-simulation.js';
import { createExecutionIntentDraft, type ExecutionIntentStatus, type ExecutionIntentV1 } from '../src/domain/execution-intent.js';
import {
  createSimulationOnlyWorker,
  type SimulationAttemptEvaluator,
  type SimulationOnlyPassResult,
  type SimulationRenewBoundary,
} from '../src/executor/simulation-worker.js';
import type {
  ClaimedExecutionIntent,
  ExecutionIntentRepository,
  ExecutionIntentTransitionInput,
} from '../src/ports/execution-intent-repository.js';
import type { ExecutionSimulationRepository } from '../src/ports/execution-simulation-repository.js';
import { ExecutionSimulationRepositoryError } from '../src/storage/execution-simulation.repository.js';

const HASH = 'a'.repeat(64);
const PUBLIC_KEY = '11111111111111111111111111111111';
const UUID = '00000000-0000-4000-8000-000000000001';
const NOW = 1_800_000_000_000;

void test('claims EXECUTE once and returns IDLE without constructing an attempt', async () => {
  const fake = fakes(null);
  assert.equal(await createSimulationOnlyWorker(fake.dependencies).runOnce(activeSignal()), 'IDLE');
  assert.deepEqual(fake.claims, [{ ownerId: 'simulation-worker-1', leaseMs: 30_000, purpose: 'EXECUTE' }]);
  assert.deepEqual(fake.calls, ['claim']);
});

void test('does nothing when already aborted and authenticates no repository operation', async () => {
  const controller = new AbortController();
  controller.abort();
  const fake = fakes(claim('PENDING'));
  assert.equal(await createSimulationOnlyWorker(fake.dependencies).runOnce(controller.signal), 'IDLE');
  assert.deepEqual(fake.calls, []);
});

void test('transitions PENDING, recovers one STARTED attempt, renews exact boundaries and commits once', async () => {
  const initial = claim('PENDING');
  const fake = fakes(initial);
  const result = await createSimulationOnlyWorker(fake.dependencies).runOnce(activeSignal());

  assert.deepEqual(fake.calls, [
    'claim', 'transition', 'beginAttempt',
    'renew:AFTER_BEGIN_ATTEMPT', 'evaluate',
    'renew:BEFORE_CANONICAL_SNAPSHOT', 'renew:BEFORE_SIMULATION',
    'renew:BEFORE_COMMIT', 'complete',
  ]);
  assert.equal(fake.transitions.length, 1);
  assert.equal(fake.evaluations[0]?.claim.intent.attemptCount, 1);
  assert.deepEqual(fake.transitions[0]?.input, {
    intentId: initial.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
    leaseToken: UUID, reasonCode: 'EXECUTION_STARTED',
    humanMessage: 'Simulation-only execution intent claimed for processing.',
    activationPhase: 'NONE',
    evidence: { payloadVersion: 1, attemptNumber: null, sourceEventId: null, observedAtMs: NOW },
  });
  assert.equal(fake.completed.length, 1);
  assert.equal(fake.completed[0]?.claim, fake.renewedClaims.at(-1));
  assert.equal(fake.completed[0]?.draft, fake.draft);
  assert.deepEqual(result, passResult('RECORDED', fake.draft));
});

void test('renews immediately after beginAttempt before constructing provider work', async () => {
  const failure = new Error('bootstrap lease lost');
  const fake = fakes(claim('PROCESSING'), {
    renewErrorAt: 'AFTER_BEGIN_ATTEMPT' as SimulationRenewBoundary,
    renewError: failure,
  });

  await assert.rejects(
    createSimulationOnlyWorker(fake.dependencies).runOnce(activeSignal()),
    (error) => error === failure,
  );
  assert.deepEqual(fake.calls, [
    'claim', 'beginAttempt', 'renew:AFTER_BEGIN_ATTEMPT',
  ]);
  assert.equal(fake.evaluations.length, 0);
  assert.equal(fake.completed.length, 0);
});

void test('resumes PROCESSING without another transition and keeps the same attempt number', async () => {
  const fake = fakes(claim('PROCESSING', 1));
  const result = await createSimulationOnlyWorker(fake.dependencies).runOnce(activeSignal());

  assert.equal(fake.transitions.length, 0);
  assert.equal(fake.evaluations[0]?.attempt.attemptNumber, 1);
  assert.deepEqual(result, passResult('RECORDED', fake.draft));
});

void test('stops immediately when an exact renewal loses its fence', async () => {
  const failure = new Error('lease lost');
  const fake = fakes(claim('PROCESSING'), { renewErrorAt: 'BEFORE_SIMULATION', renewError: failure });
  await assert.rejects(createSimulationOnlyWorker(fake.dependencies).runOnce(activeSignal()), (error) => error === failure);
  assert.deepEqual(fake.calls, [
    'claim', 'beginAttempt', 'renew:AFTER_BEGIN_ATTEMPT', 'evaluate',
    'renew:BEFORE_CANONICAL_SNAPSHOT', 'renew:BEFORE_SIMULATION',
  ]);
  assert.equal(fake.completed.length, 0);
});

void test('rejects skipped, repeated or out-of-order evaluator renewal boundaries', async () => {
  for (const boundaries of [
    [] as const,
    ['BEFORE_SIMULATION'] as const,
    ['BEFORE_CANONICAL_SNAPSHOT', 'BEFORE_CANONICAL_SNAPSHOT'] as const,
    ['BEFORE_CANONICAL_SNAPSHOT'] as const,
  ]) {
    const fake = fakes(claim('PROCESSING'), { evaluatorBoundaries: boundaries });
    await assert.rejects(
      createSimulationOnlyWorker(fake.dependencies).runOnce(activeSignal()),
      TypeError,
    );
    assert.equal(fake.completed.length, 0);
    assert.equal(fake.calls.includes('renew:BEFORE_COMMIT'), false);
  }
});

void test('rejects an evaluator draft bound to another state revision before commit', async () => {
  const fake = fakes(claim('PROCESSING'), { draftRevision: 2n });
  await assert.rejects(
    createSimulationOnlyWorker(fake.dependencies).runOnce(activeSignal()),
    TypeError,
  );
  assert.equal(fake.completed.length, 0);
  assert.equal(fake.calls.includes('renew:BEFORE_COMMIT'), false);
});

void test('does not commit when cancellation follows evaluation', async () => {
  const controller = new AbortController();
  const fake = fakes(claim('PROCESSING'), { abortAfterEvaluation: controller });
  assert.equal(await createSimulationOnlyWorker(fake.dependencies).runOnce(controller.signal), 'IDLE');
  assert.equal(fake.completed.length, 0);
  assert.equal(fake.finds.length, 0);
  assert.equal(fake.calls.includes('renew:BEFORE_COMMIT'), false);
});

void test('recovers only the exact draft after an unknown commit without evaluating twice', async () => {
  const unknown = new ExecutionSimulationRepositoryError('COMMIT_OUTCOME_UNKNOWN');
  const fake = fakes(claim('PROCESSING'), { completeError: unknown, find: 'EXACT' });
  const result = await createSimulationOnlyWorker(fake.dependencies).runOnce(activeSignal());

  assert.deepEqual(result, passResult('COMMIT_RECOVERED', fake.draft));
  assert.equal(fake.evaluations.length, 1);
  assert.deepEqual(fake.finds, [fake.draft]);
  assert.equal(fake.completed.length, 1);
});

void test('recovers an unknown dispatched commit even when shutdown aborts the pass signal', async () => {
  const controller = new AbortController();
  const unknown = new ExecutionSimulationRepositoryError('COMMIT_OUTCOME_UNKNOWN');
  const fake = fakes(claim('PROCESSING'), {
    completeError: unknown, find: 'EXACT', abortOnComplete: controller,
  });
  assert.deepEqual(
    await createSimulationOnlyWorker(fake.dependencies).runOnce(controller.signal),
    passResult('COMMIT_RECOVERED', fake.draft),
  );
  assert.equal(fake.findSignals[0]?.aborted, false);
});

void test('rethrows the ambiguous commit when exact recovery is absent', async () => {
  const unknown = new ExecutionSimulationRepositoryError('COMMIT_OUTCOME_UNKNOWN');
  const fake = fakes(claim('PROCESSING'), { completeError: unknown, find: 'MISSING' });
  await assert.rejects(createSimulationOnlyWorker(fake.dependencies).runOnce(activeSignal()), (error) => error === unknown);
  assert.equal(fake.evaluations.length, 1);
  assert.deepEqual(fake.finds, [fake.draft]);
});

void test('shares one in-flight pass across concurrent and reentrant callers', async () => {
  const gate = deferred<ClaimedExecutionIntent | null>();
  const fake = fakes(null, { claimResult: gate.promise });
  const worker = createSimulationOnlyWorker(fake.dependencies);
  const first = worker.runOnce(activeSignal());
  const second = worker.runOnce(activeSignal());
  assert.equal(first, second);
  await Promise.resolve();
  gate.resolve(null);
  assert.deepEqual(await Promise.all([first, second]), ['IDLE', 'IDLE']);
  assert.equal(fake.claims.length, 1);
});

interface FakeOptions {
  readonly claimResult?: Promise<ClaimedExecutionIntent | null>;
  readonly renewErrorAt?: SimulationRenewBoundary;
  readonly renewError?: Error;
  readonly abortAfterEvaluation?: AbortController;
  readonly completeError?: Error;
  readonly find?: 'EXACT' | 'MISSING';
  readonly draftRevision?: bigint;
  readonly evaluatorBoundaries?: readonly Exclude<
    SimulationRenewBoundary,
    'AFTER_BEGIN_ATTEMPT' | 'BEFORE_COMMIT'
  >[];
  readonly abortOnComplete?: AbortController;
}

function fakes(initial: ClaimedExecutionIntent | null, options: FakeOptions = {}) {
  const calls: string[] = [];
  const claims: Readonly<{ ownerId: string; leaseMs: number; purpose: string }>[] = [];
  const transitions: Readonly<{ claim: ClaimedExecutionIntent; input: ExecutionIntentTransitionInput }>[] = [];
  const evaluations: Parameters<SimulationAttemptEvaluator['evaluate']>[0][] = [];
  const renewedClaims: ClaimedExecutionIntent[] = [];
  const completed: Readonly<{ claim: ClaimedExecutionIntent; draft: ExecutionSimulationArtifactDraftV1 }>[] = [];
  const finds: ExecutionSimulationArtifactDraftV1[] = [];
  const findSignals: AbortSignal[] = [];
  let current = initial;
  let renewCount = 0;
  const draft = successDraft(initial?.intent ?? intent('PROCESSING'), options.draftRevision);
  const intents: Pick<ExecutionIntentRepository, 'claim' | 'transition' | 'beginAttempt' | 'renew'> = {
    claim: async (input) => {
      calls.push('claim');
      claims.push(input);
      return options.claimResult ?? current;
    },
    transition: async (claimed, input) => {
      calls.push('transition');
      transitions.push({ claim: claimed, input });
      const next = intent('PROCESSING', claimed.intent.attemptCount, claimed.intent);
      current = Object.freeze({ ...claimed, intent: next });
      return next;
    },
    beginAttempt: async (claimed) => {
      calls.push('beginAttempt');
      const attemptNumber = claimed.intent.attemptCount === 0 ? 1 : claimed.intent.attemptCount;
      const refreshed = Object.freeze({
        ...claimed,
        intent: intent('PROCESSING', attemptNumber, claimed.intent),
      });
      current = refreshed;
      return Object.freeze({
        claim: refreshed,
        attempt: Object.freeze({ intentId: claimed.intent.id, attemptNumber, startedAtMs: NOW }),
      });
    },
    renew: async (claimed, leaseMs) => {
      const boundary = (['AFTER_BEGIN_ATTEMPT', 'BEFORE_CANONICAL_SNAPSHOT',
        'BEFORE_SIMULATION', 'BEFORE_COMMIT'] as const)[renewCount];
      assert.ok(boundary !== undefined);
      calls.push(`renew:${boundary}`);
      if (options.renewErrorAt === boundary) throw options.renewError ?? new Error('renew failed');
      renewCount += 1;
      const renewed = Object.freeze({
        ...claimed, leaseExpiresAtMs: claimed.leaseExpiresAtMs + leaseMs + renewCount,
      });
      renewedClaims.push(renewed);
      current = renewed;
      return renewed;
    },
  };
  const evaluator: SimulationAttemptEvaluator = {
    evaluate: async (input, signal, renew) => {
      calls.push('evaluate');
      evaluations.push(input);
      for (const boundary of options.evaluatorBoundaries ?? [
        'BEFORE_CANONICAL_SNAPSHOT', 'BEFORE_SIMULATION',
      ]) await renew(boundary);
      assert.equal(signal.aborted, false);
      options.abortAfterEvaluation?.abort();
      return draft;
    },
  };
  const artifacts: ExecutionSimulationRepository = {
    complete: async (claimed, value) => {
      calls.push('complete');
      completed.push({ claim: claimed, draft: value });
      options.abortOnComplete?.abort();
      if (options.completeError !== undefined) throw options.completeError;
      return createExecutionSimulationArtifact(value, NOW + 1);
    },
    findExact: async (value, signal) => {
      calls.push('findExact');
      finds.push(value);
      findSignals.push(signal);
      return options.find === 'EXACT' ? createExecutionSimulationArtifact(value, NOW + 1) : null;
    },
  };
  const dependencies = Object.freeze({
    intents, artifacts, evaluator, ownerId: 'simulation-worker-1', leaseMs: 30_000,
    clock: () => NOW,
  });
  return {
    dependencies, calls, claims, transitions, evaluations, renewedClaims,
    completed, finds, findSignals, draft,
  };
}

function passResult(
  kind: 'RECORDED' | 'COMMIT_RECOVERED',
  draft: ExecutionSimulationArtifactDraftV1,
): Exclude<SimulationOnlyPassResult, 'IDLE'> {
  return Object.freeze({
    kind, mode: 'simulation-only', intentId: draft.intentId, side: 'BUY',
    outcome: 'SIMULATION_SUCCEEDED', reasonCode: draft.terminalReasonCode,
    providerId: draft.providerId,
  });
}

function claim(status: 'PENDING' | 'PROCESSING', attemptCount = 0): ClaimedExecutionIntent {
  return Object.freeze({
    intent: intent(status, attemptCount), leaseOwner: 'simulation-worker-1',
    leaseToken: UUID, leaseExpiresAtMs: NOW + 30_000,
  });
}

function intent(
  status: ExecutionIntentStatus,
  attemptCount = 0,
  base?: ExecutionIntentV1,
): ExecutionIntentV1 {
  const draft = base ?? createExecutionIntentDraft({
    strategyId: 'strategy-1', strategyVersion: 1, positionId: 'position-1',
    logicalCommandId: 'command-1', mint: PUBLIC_KEY, side: 'BUY',
    venuePolicy: 'PUMP_FUN_ONLY', quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9, quoteAmountRaw: 1_000n,
    baseAmountRaw: null, minimumAmountOutRaw: 850n, decisionEventId: 'event-1',
    decisionFingerprint: HASH, requestedAtMs: NOW - 1_000, expiresAtMs: NOW + 60_000,
  });
  return Object.freeze({
    ...draft, status, attemptCount,
    stateRevision: status === 'PROCESSING' ? 1n : 0n,
    lastReasonCode: status === 'PROCESSING' ? 'EXECUTION_STARTED' : null,
    terminalAtMs: null, reconciliationCompletedAtMs: null, purgeAfterMs: null,
    createdAtMs: NOW - 1_000, updatedAtMs: NOW,
  });
}

function successDraft(
  value: ExecutionIntentV1,
  revision = value.status === 'PROCESSING' ? value.stateRevision : 1n,
): ExecutionSimulationArtifactDraftV1 {
  return createExecutionSimulationArtifactDraft({
    intentId: value.id, attemptNumber: value.attemptCount === 0 ? 1 : value.attemptCount,
    intentStateRevision: revision,
    strategyId: value.strategyId, strategyVersion: value.strategyVersion,
    decisionFingerprint: value.decisionFingerprint, resultKind: 'SUCCESS',
    effectiveVenue: 'PUMP_FUN', providerId: 'primary', executorPublicKey: PUBLIC_KEY,
    expectedGenesisHash: PUBLIC_KEY, observedGenesisHash: PUBLIC_KEY,
    configurationFingerprint: HASH, quoteFingerprint: HASH, snapshotFingerprint: HASH,
    buildFingerprint: HASH, messageHash: HASH, blockhash: PUBLIC_KEY,
    lastValidBlockHeight: 1_000n, blockhashContextSlot: 900n, snapshotSlot: 899n,
    feeContextSlot: 900n, simulationSlot: 901n, amountInRaw: 1_000n,
    expectedAmountOutRaw: 900n, protectedAmountOutRaw: 850n, feesRaw: 10n,
    estimatedFeeLamports: 5_000n, simulatedFeePayerLamportDebit: 6_000n,
    unitsConsumed: 200_000n, simulatedBaseDeltaRaw: 900n,
    simulatedQuoteDeltaRaw: -1_000n, rpcCallsUsed: 6, rpcCallsLimit: 8,
    quoteStatus: 'SUCCEEDED', buildStatus: 'SUCCEEDED', simulationStatus: 'SUCCEEDED',
    failureStage: null, failureCode: null, terminalReasonCode: 'INTENT_SUCCEEDED',
    logsFingerprint: HASH, logsLineCount: 1,
  });
}

function activeSignal(): AbortSignal { return new AbortController().signal; }

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => { resolve = settle; });
  return { promise, resolve };
}
