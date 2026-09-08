import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClaimedExecutionPreflightPreparation } from '../src/domain/execution-preflight-preparation.js';
import {
  createExactPreflightSimulationIntentAdapter,
  createExactPreflightTargetIntentAdapter,
} from '../src/executor-preflight-preparation/exact-intent-adapter.js';
import type {
  ClaimedExecutionIntent,
  ExecutionBeginAttemptResult,
  ExecutionIntentRepository,
  ExecutionIntentTransitionInput,
} from '../src/ports/execution-intent-repository.js';

const HASH = 'a'.repeat(64);
const PAIR_ID = `execution_preflight_intent_pair_${HASH}`;
const TARGET_ID = `execution_intent_${'b'.repeat(64)}`;
const SIMULATION_ID = `execution_intent_${'c'.repeat(64)}`;
const RUN_ID = `execution_preflight_preparation_${'d'.repeat(64)}`;
const SIGNAL = new AbortController().signal;

void test('TARGET exposes only one exact DRY_RUN claim bound to the preparation', async () => {
  const repository = new IntentRepositoryProbe();
  const preparationClaim = claimedPreparation('prep-owner', uuid(1), 0n);
  const adapter = createExactPreflightTargetIntentAdapter(Object.freeze({
    intents: repository,
    preparationClaim,
    pairId: PAIR_ID,
    intentId: TARGET_ID,
    ownerId: 'target-owner',
    leaseMs: 30_000,
  }));

  assert.deepEqual(Object.keys(adapter), ['claim']);
  assert.equal(await adapter.claim(Object.freeze({
    ownerId: 'target-owner', leaseMs: 30_000, purpose: 'DRY_RUN',
  }), SIGNAL), null);
  assert.deepEqual(repository.exactClaims, [Object.freeze({
    runId: RUN_ID,
    preparationLeaseOwner: 'prep-owner',
    preparationLeaseToken: uuid(1),
    pairId: PAIR_ID,
    intentId: TARGET_ID,
    lane: 'TARGET',
    purpose: 'DRY_RUN',
    ownerId: 'target-owner',
    leaseMs: 30_000,
  })]);
  assert.equal(repository.signals[0], SIGNAL);
});

void test('TARGET rejects every non-exact worker option before repository access', async () => {
  const repository = new IntentRepositoryProbe();
  const adapter = createExactPreflightTargetIntentAdapter(Object.freeze({
    intents: repository,
    preparationClaim: claimedPreparation('prep-owner', uuid(1), 0n),
    pairId: PAIR_ID,
    intentId: TARGET_ID,
    ownerId: 'target-owner',
    leaseMs: 30_000,
  }));
  const hostile = [
    { ownerId: 'target-owner', leaseMs: 30_000, purpose: 'DRY_RUN' },
    Object.freeze({ ownerId: 'other', leaseMs: 30_000, purpose: 'DRY_RUN' }),
    Object.freeze({ ownerId: 'target-owner', leaseMs: 29_999, purpose: 'DRY_RUN' }),
    Object.freeze({ ownerId: 'target-owner', leaseMs: 30_000, purpose: 'EXECUTE' }),
    Object.freeze({ ownerId: 'target-owner', leaseMs: 30_000, purpose: 'DRY_RUN', extra: true }),
  ];
  for (const options of hostile) {
    await assert.rejects(adapter.claim(options as never, SIGNAL), TypeError);
  }
  assert.equal(repository.exactClaims.length, 0);
});

void test('SIMULATION delegates bound lifecycle methods and renews preparation first', async () => {
  const calls: string[] = [];
  const repository = new IntentRepositoryProbe(calls);
  const initial = claimedPreparation('prep-owner-1', uuid(1), 0n);
  const renewed = claimedPreparation('prep-owner-1', uuid(1), 1n);
  const adapter = createExactPreflightSimulationIntentAdapter(Object.freeze({
    intents: repository,
    preparationClaim: initial,
    renewPreparation: async (
      claim: ClaimedExecutionPreflightPreparation,
      leaseMs: number,
    ) => {
      calls.push('renew-preparation');
      assert.equal(claim, initial);
      assert.equal(leaseMs, 40_000);
      return renewed;
    },
    preparationLeaseMs: 40_000,
    pairId: PAIR_ID,
    intentId: SIMULATION_ID,
    ownerId: 'simulation-owner',
    leaseMs: 30_000,
  }));
  const intentClaim = claimedSimulation('PENDING', 0, 0n);
  const processingClaim = claimedSimulation('PROCESSING', 0, 1n);
  const begunClaim = claimedSimulation('PROCESSING', 1, 1n);
  const transition = Object.freeze({}) as ExecutionIntentTransitionInput;

  assert.deepEqual(Object.keys(adapter), [
    'claim', 'transition', 'beginAttempt', 'renew', 'currentPreparationClaim',
  ]);
  await adapter.claim(Object.freeze({
    ownerId: 'simulation-owner', leaseMs: 30_000, purpose: 'EXECUTE',
  }), SIGNAL);
  await adapter.transition(intentClaim, transition);
  await adapter.beginAttempt(processingClaim);
  await adapter.renew(begunClaim, 30_000);

  assert.deepEqual(calls, [
    'claim-exact', 'transition-exact', 'begin-attempt-exact',
    'renew-preparation', 'renew-intent-exact',
  ]);
  assert.equal(adapter.currentPreparationClaim(), renewed);
  await adapter.claim(Object.freeze({
    ownerId: 'simulation-owner', leaseMs: 30_000, purpose: 'EXECUTE',
  }), SIGNAL);
  assert.equal(repository.exactClaims[1]?.preparationLeaseOwner, 'prep-owner-1');
  assert.equal(repository.exactClaims[1]?.preparationLeaseToken, uuid(1));
});

void test('SIMULATION rejects another intent, owner, or lifecycle state before mutation',
  async () => {
    const calls: string[] = [];
    const repository = new IntentRepositoryProbe(calls);
    const adapter = createExactPreflightSimulationIntentAdapter(Object.freeze({
      intents: repository,
      preparationClaim: claimedPreparation('prep-owner', uuid(1), 0n),
      renewPreparation: async (claim: ClaimedExecutionPreflightPreparation) => claim,
      preparationLeaseMs: 40_000,
      pairId: PAIR_ID,
      intentId: SIMULATION_ID,
      ownerId: 'simulation-owner',
      leaseMs: 30_000,
    }));
    const transition = Object.freeze({}) as ExecutionIntentTransitionInput;
    await assert.rejects(
      adapter.transition(
        claimedSimulation('PENDING', 0, 0n, 'simulation-owner', TARGET_ID),
        transition,
      ),
      TypeError,
    );
    await assert.rejects(
      adapter.beginAttempt(claimedSimulation('PROCESSING', 0, 1n, 'other-owner')),
      TypeError,
    );
    await assert.rejects(
      adapter.renew(claimedSimulation('PENDING', 0, 0n), 30_000),
      TypeError,
    );
    assert.deepEqual(calls, []);
  });

void test('SIMULATION does not renew the intent when preparation renewal fails', async () => {
  const calls: string[] = [];
  const repository = new IntentRepositoryProbe(calls);
  const initial = claimedPreparation('prep-owner', uuid(1), 0n);
  const failure = new Error('closed preparation renewal');
  const adapter = createExactPreflightSimulationIntentAdapter(Object.freeze({
    intents: repository,
    preparationClaim: initial,
    renewPreparation: async () => { calls.push('renew-preparation'); throw failure; },
    preparationLeaseMs: 40_000,
    pairId: PAIR_ID,
    intentId: SIMULATION_ID,
    ownerId: 'simulation-owner',
    leaseMs: 30_000,
  }));

  await assert.rejects(
    adapter.renew(claimedSimulation('PROCESSING', 1, 1n), 30_000),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(calls, ['renew-preparation']);
  assert.equal(adapter.currentPreparationClaim(), initial);
});

class IntentRepositoryProbe implements Pick<ExecutionIntentRepository,
'claimExactPreflightIntent' | 'transition' | 'beginAttempt' | 'renew'> {
  public readonly exactClaims: Parameters<ExecutionIntentRepository['claimExactPreflightIntent']>[0][] = [];
  public readonly signals: (AbortSignal | undefined)[] = [];

  public constructor(private readonly calls: string[] = []) {}

  public async claimExactPreflightIntent(
    options: Parameters<ExecutionIntentRepository['claimExactPreflightIntent']>[0],
    signal?: AbortSignal,
  ): Promise<ClaimedExecutionIntent | null> {
    assert.equal(this, repositoryReceiver(this));
    this.calls.push('claim-exact');
    this.exactClaims.push(options);
    this.signals.push(signal);
    return null;
  }

  public async transition(
    _claim: ClaimedExecutionIntent,
    _input: ExecutionIntentTransitionInput,
  ): Promise<never> {
    assert.equal(this, repositoryReceiver(this));
    this.calls.push('transition');
    return undefined as never;
  }

  public async beginAttempt(_claim: ClaimedExecutionIntent): Promise<ExecutionBeginAttemptResult> {
    assert.equal(this, repositoryReceiver(this));
    this.calls.push('begin-attempt');
    return undefined as never;
  }

  public async renew(
    claim: ClaimedExecutionIntent,
    _leaseMs: number,
  ): Promise<ClaimedExecutionIntent> {
    assert.equal(this, repositoryReceiver(this));
    this.calls.push('renew-intent');
    return claim;
  }

  public async transitionExactPreflightSimulation(
    _fence: unknown,
    _claim: ClaimedExecutionIntent,
    _input: ExecutionIntentTransitionInput,
  ): Promise<never> {
    this.calls.push('transition-exact');
    return undefined as never;
  }

  public async beginExactPreflightSimulationAttempt(
    _fence: unknown,
    _claim: ClaimedExecutionIntent,
  ): Promise<ExecutionBeginAttemptResult> {
    this.calls.push('begin-attempt-exact');
    return undefined as never;
  }

  public async renewExactPreflightSimulation(
    _fence: unknown,
    claim: ClaimedExecutionIntent,
    _leaseMs: number,
  ): Promise<ClaimedExecutionIntent> {
    this.calls.push('renew-intent-exact');
    return claim;
  }
}

function repositoryReceiver<Value extends IntentRepositoryProbe>(value: Value): Value {
  return value;
}

function claimedPreparation(
  owner: string,
  token: string,
  revision: bigint,
): ClaimedExecutionPreflightPreparation {
  return Object.freeze({
    preparation: Object.freeze({
      payloadVersion: 1,
      runId: RUN_ID,
      runFingerprint: HASH,
      state: 'PREPARING',
      stateRevision: revision,
      watermarkAtMs: 1_800_000_000_000,
      deadlineAtMs: 1_800_000_060_000,
      pairId: PAIR_ID,
      assessmentId: null,
      assessmentFingerprint: null,
      artifactId: null,
      artifactFingerprint: null,
      manifestFingerprint: null,
      failureCode: null,
      createdAtMs: 1_800_000_000_000,
      updatedAtMs: 1_800_000_000_000 + Number(revision),
      selectedAtMs: 1_800_000_000_001,
      completedAtMs: null,
      purgeAfterMs: null,
    }),
    leaseOwner: owner,
    leaseToken: token,
    leaseExpiresAtMs: 1_800_000_040_000,
  });
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function claimedSimulation(
  status: 'PENDING' | 'PROCESSING',
  attemptCount: number,
  stateRevision: bigint,
  owner = 'simulation-owner',
  intentId = SIMULATION_ID,
): ClaimedExecutionIntent {
  const now = 1_800_000_000_000;
  return Object.freeze({
    intent: Object.freeze({
      id: intentId,
      payloadVersion: 1,
      logicalOrderKey: `execution_preflight_probe_${HASH}`,
      strategyId: 'creation-entry-v1',
      strategyVersion: 1,
      positionId: 'position:exact-preflight',
      candidateId: `candidate_${'c'.repeat(64)}`,
      logicalCommandId: `execution_preflight_probe_${HASH}`,
      mint: '11111111111111111111111111111111',
      side: 'BUY',
      venuePolicy: 'PUMP_FUN_ONLY',
      quoteMint: 'So11111111111111111111111111111111111111112',
      quoteTokenProgram: 'SPL_TOKEN',
      quoteDecimals: 9,
      quoteAmountRaw: 1n,
      baseAmountRaw: null,
      minimumAmountOutRaw: 1n,
      decisionEventId: 'decision:exact-preflight',
      decisionFingerprint: HASH,
      requestedAtMs: now,
      expiresAtMs: now + 60_000,
      status,
      attemptCount,
      stateRevision,
      lastReasonCode: status === 'PENDING' ? null : 'EXECUTION_STARTED',
      terminalAtMs: null,
      reconciliationCompletedAtMs: null,
      purgeAfterMs: null,
      createdAtMs: now,
      updatedAtMs: now,
    }),
    leaseOwner: owner,
    leaseToken: uuid(2),
    leaseExpiresAtMs: now + 30_000,
  });
}
