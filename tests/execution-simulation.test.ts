import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertExecutionSimulationArtifact,
  assertExecutionSimulationArtifactDraft,
  createExecutionSimulationArtifact,
  createExecutionSimulationArtifactDraft,
  EXECUTION_SIMULATION_EVALUATOR_VERSION,
  EXECUTION_SIMULATION_FAILURE_CODES,
  EXECUTION_SIMULATION_PAYLOAD_VERSION,
  EXECUTION_SIMULATION_SPECIFICATION_VERSION,
  ExecutionSimulationValidationError,
  type ExecutionSimulationArtifactDraftV1,
} from '../src/domain/execution-simulation.js';

const HASH = 'a'.repeat(64);
const PUBLIC_KEY = '11111111111111111111111111111111';
const INTENT_ID = `execution_intent_${'b'.repeat(64)}`;

void test('publishes the frozen versioned simulation-only vocabulary', () => {
  assert.equal(EXECUTION_SIMULATION_PAYLOAD_VERSION, 1);
  assert.equal(EXECUTION_SIMULATION_SPECIFICATION_VERSION, '1.5.0');
  assert.equal(EXECUTION_SIMULATION_EVALUATOR_VERSION, 1);
  assert.deepEqual(EXECUTION_SIMULATION_FAILURE_CODES, [
    'QUOTE_REJECTED', 'BUILD_POLICY_REJECTED', 'RPC_RATE_LIMITED',
    'RPC_TIMEOUT', 'RPC_UNAVAILABLE', 'RPC_RESPONSE_INVALID',
    'SIMULATION_EVIDENCE_INVALID', 'SIMULATION_PROGRAM_ERROR',
  ]);
  assert.equal(Object.isFrozen(EXECUTION_SIMULATION_FAILURE_CODES), true);
});

void test('creates one frozen deterministic successful artifact and records it safely', () => {
  const first = createExecutionSimulationArtifactDraft(successInput());
  const second = createExecutionSimulationArtifactDraft(successInput());

  assert.equal(first.artifactId, second.artifactId);
  assert.equal(first.resultFingerprint, second.resultFingerprint);
  assert.match(first.artifactId, /^execution_simulation_artifact_[0-9a-f]{64}$/u);
  assert.match(first.resultFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(first.payloadVersion, 1);
  assert.equal(first.specificationVersion, '1.5.0');
  assert.equal(first.evaluatorVersion, 1);
  assert.equal(Object.isFrozen(first), true);
  assert.doesNotThrow(() => {
    assertExecutionSimulationArtifactDraft(first);
  });

  const recorded = createExecutionSimulationArtifact(first, 1_787_990_400_000);
  assert.equal(recorded.recordedAtMs, 1_787_990_400_000);
  assert.equal(Object.isFrozen(recorded), true);
  assert.doesNotThrow(() => {
    assertExecutionSimulationArtifact(recorded);
  });
});

void test('pins artifact and result identities and changes every causal identity segment', () => {
  const draft = createExecutionSimulationArtifactDraft(successInput());
  assert.equal(
    draft.artifactId,
    'execution_simulation_artifact_54f7b19039c691ef2ab0fd346b80dae9ad65cec9107838870cf7f7548521d6fd',
  );
  assert.equal(
    draft.resultFingerprint,
    '06dbb29bf8a85f5de8a1533047bc21323fa4094236ff7b573c34477a735cff58',
  );
  for (const overrides of [
    { attemptNumber: 2 },
    { intentStateRevision: 8n },
    { strategyId: 'strategy-2' },
    { decisionFingerprint: 'c'.repeat(64) },
    { quoteFingerprint: 'd'.repeat(64) },
    { unitsConsumed: 200_001n },
    { logsLineCount: 2 },
  ]) {
    const changed = createExecutionSimulationArtifactDraft(successInput(overrides));
    if ('attemptNumber' in overrides) assert.notEqual(changed.artifactId, draft.artifactId);
    else assert.equal(changed.artifactId, draft.artifactId);
    assert.notEqual(changed.resultFingerprint, draft.resultFingerprint);
  }
});

void test('accepts the closed provider and build failure shapes', () => {
  const provider = createExecutionSimulationArtifactDraft(providerFailureInput());
  assert.equal(provider.resultKind, 'PROVIDER_FAILED');
  assert.equal(provider.quoteStatus, 'FAILED');
  assert.equal(provider.quoteFingerprint, null);
  assert.equal(provider.terminalReasonCode, 'EXECUTION_PROVIDER_FAILED');

  const build = createExecutionSimulationArtifactDraft(buildFailureInput());
  assert.equal(build.resultKind, 'BUILD_FAILED');
  assert.equal(build.quoteStatus, 'SUCCEEDED');
  assert.equal(build.buildStatus, 'FAILED');
  assert.equal(build.messageHash, null);
  assert.equal(build.terminalReasonCode, 'EXECUTION_BUILD_FAILED');
});

void test('rejects impossible stage, status, reason and nullability combinations', () => {
  const invalid = [
    { resultKind: 'SUCCESS', failureCode: 'RPC_TIMEOUT' },
    { resultKind: 'SUCCESS', simulationStatus: 'FAILED' },
    { resultKind: 'BUILD_FAILED', buildStatus: 'SUCCEEDED' },
    { resultKind: 'BUILD_FAILED', messageHash: HASH },
    { resultKind: 'PROVIDER_FAILED', quoteFingerprint: HASH },
    { resultKind: 'SIMULATION_FAILED', terminalReasonCode: 'INTENT_SUCCEEDED' },
    { resultKind: 'SUCCESS', quoteStatus: 'FAILED' },
    { resultKind: 'SUCCESS', logsFingerprint: null },
    { resultKind: 'SUCCESS', observedGenesisHash: null },
    { resultKind: 'SUCCESS', rpcCallsUsed: 9 },
  ] as const;
  for (const overrides of invalid) assertInvalid(() => {
    createExecutionSimulationArtifactDraft(successInput(overrides));
  });
});

void test('rejects unsafe numbers, noncanonical hashes, keys and hostile objects', () => {
  const invalid = [
    { amountInRaw: 1 }, { amountInRaw: 0n },
    { estimatedFeeLamports: 18_446_744_073_709_551_616n },
    { simulatedBaseDeltaRaw: 18_446_744_073_709_551_616n },
    { simulatedQuoteDeltaRaw: -18_446_744_073_709_551_616n },
    { snapshotSlot: -1n }, { attemptNumber: 0 }, { strategyVersion: 0 },
    { quoteFingerprint: 'A'.repeat(64) }, { executorPublicKey: 'not-a-key' },
    { blockhash: 'not-a-blockhash' }, { providerId: '' },
    { extra: true },
  ] as const;
  for (const overrides of invalid) assertInvalid(() => {
    createExecutionSimulationArtifactDraft(successInput(overrides));
  });
  assertInvalid(() => {
    createExecutionSimulationArtifactDraft(new Proxy(successInput(), {}));
  });
  const accessor = successInput() as Record<string, unknown>;
  Object.defineProperty(accessor, 'providerId', { enumerable: true, get: () => 'primary' });
  assertInvalid(() => createExecutionSimulationArtifactDraft(accessor));
  assertInvalid(() => {
    assertExecutionSimulationArtifactDraft({ ...successInput() });
  });
});

void test('rejects mutation, invalid recording timestamps and spoofed drafts', () => {
  const draft = createExecutionSimulationArtifactDraft(successInput());
  assertInvalid(() => createExecutionSimulationArtifact({ ...draft } as never, 1));
  assertInvalid(() => createExecutionSimulationArtifact(draft, -1));
  assertInvalid(() => createExecutionSimulationArtifact(draft, 1.5));
  const spoofed = Object.freeze({ ...draft, resultFingerprint: 'f'.repeat(64) });
  assertInvalid(() => {
    assertExecutionSimulationArtifactDraft(spoofed);
  });
});

function successInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    intentId: INTENT_ID, attemptNumber: 1, intentStateRevision: 7n,
    strategyId: 'strategy-1', strategyVersion: 1, decisionFingerprint: HASH,
    resultKind: 'SUCCESS', effectiveVenue: 'PUMP_FUN', providerId: 'primary',
    executorPublicKey: PUBLIC_KEY, expectedGenesisHash: PUBLIC_KEY,
    observedGenesisHash: PUBLIC_KEY, configurationFingerprint: HASH,
    quoteFingerprint: HASH, snapshotFingerprint: HASH, buildFingerprint: HASH,
    messageHash: HASH, blockhash: PUBLIC_KEY, lastValidBlockHeight: 1_000n,
    blockhashContextSlot: 900n, snapshotSlot: 899n, feeContextSlot: 900n,
    simulationSlot: 901n, amountInRaw: 1_000n, expectedAmountOutRaw: 900n,
    protectedAmountOutRaw: 850n, feesRaw: 10n, estimatedFeeLamports: 5_000n,
    simulatedFeePayerLamportDebit: 6_000n, unitsConsumed: 200_000n,
    simulatedBaseDeltaRaw: 900n, simulatedQuoteDeltaRaw: -1_000n,
    rpcCallsUsed: 5, rpcCallsLimit: 8, quoteStatus: 'SUCCEEDED',
    buildStatus: 'SUCCEEDED', simulationStatus: 'SUCCEEDED', failureStage: null,
    failureCode: null, terminalReasonCode: 'INTENT_SUCCEEDED',
    logsFingerprint: HASH, logsLineCount: 1,
    ...overrides,
  };
}

function providerFailureInput(): Readonly<Record<string, unknown>> {
  return {
    ...successInput(), resultKind: 'PROVIDER_FAILED', effectiveVenue: null,
    observedGenesisHash: null, quoteFingerprint: null, snapshotFingerprint: null,
    buildFingerprint: null, messageHash: null, blockhash: null,
    lastValidBlockHeight: null, blockhashContextSlot: null, snapshotSlot: null,
    feeContextSlot: null, simulationSlot: null, amountInRaw: null,
    expectedAmountOutRaw: null, protectedAmountOutRaw: null, feesRaw: null,
    estimatedFeeLamports: null, simulatedFeePayerLamportDebit: null,
    unitsConsumed: null, simulatedBaseDeltaRaw: null, simulatedQuoteDeltaRaw: null,
    rpcCallsUsed: 1, quoteStatus: 'FAILED', buildStatus: 'NOT_RUN',
    simulationStatus: 'NOT_RUN', failureStage: 'PROVIDER',
    failureCode: 'RPC_UNAVAILABLE', terminalReasonCode: 'EXECUTION_PROVIDER_FAILED',
    logsFingerprint: null, logsLineCount: null,
  };
}

function buildFailureInput(): Readonly<Record<string, unknown>> {
  return {
    ...successInput(), resultKind: 'BUILD_FAILED', buildFingerprint: null,
    messageHash: null, blockhash: null, lastValidBlockHeight: null,
    blockhashContextSlot: null, feeContextSlot: null, simulationSlot: null,
    estimatedFeeLamports: null, simulatedFeePayerLamportDebit: null,
    unitsConsumed: null, simulatedBaseDeltaRaw: null, simulatedQuoteDeltaRaw: null,
    buildStatus: 'FAILED', simulationStatus: 'NOT_RUN', failureStage: 'BUILD',
    failureCode: 'BUILD_POLICY_REJECTED', terminalReasonCode: 'EXECUTION_BUILD_FAILED',
    logsFingerprint: null, logsLineCount: null,
  };
}

function assertInvalid(run: () => unknown): void {
  assert.throws(run, ExecutionSimulationValidationError);
}

void (null as unknown as ExecutionSimulationArtifactDraftV1);
