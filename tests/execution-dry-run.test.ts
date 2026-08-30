import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertExecutionDryRunAssessment,
  assertExecutionDryRunAssessmentDraft,
  createExecutionDryRunAssessment,
  EXECUTION_DRY_RUN_EVALUATOR_VERSION,
  EXECUTION_DRY_RUN_PAYLOAD_VERSION,
  EXECUTION_DRY_RUN_SPECIFICATION_VERSION,
  ExecutionDryRunValidationError,
} from '../src/domain/execution-dry-run.js';
import {
  assertExecutionIntent,
  createExecutionIntentDraft,
  type ExecutionIntentV1,
} from '../src/domain/execution-intent.js';

const U64_MAX = 18_446_744_073_709_551_615n;

void test('creates the specified immutable deterministic BUY assessment vector', () => {
  const assessment = createExecutionDryRunAssessment(intent());

  assert.equal(EXECUTION_DRY_RUN_PAYLOAD_VERSION, 1);
  assert.equal(EXECUTION_DRY_RUN_SPECIFICATION_VERSION, '1.4.0');
  assert.equal(EXECUTION_DRY_RUN_EVALUATOR_VERSION, 1);
  assert.deepEqual(assessment, {
    assessmentId: 'execution_dry_run_assessment_eb23c443c27d692f29ed0aa96610e6b6ba248b39ab67b7cd459eff1683beaa0d',
    payloadVersion: 1,
    specificationVersion: '1.4.0',
    evaluatorVersion: 1,
    intentId: 'execution_intent_4489ca76a7b24b40a5f6a2330873a06bd96f4ec1f53d92452b562913e5dc99d7',
    strategyId: 'dry-run-strategy',
    strategyVersion: 1,
    decisionFingerprint: 'a'.repeat(64),
    intentStateRevision: 0n,
    intentStatus: 'PENDING',
    inputFingerprint: 'ec733e4d262abad089b77a07dff3877ff95b2cda98875098d8336d65c5fd8b2c',
    resultFingerprint: '725f65dd813e14b6bfbec289964dcd94c58ac030694a76c26df13a03a80c9679',
    outcome: 'FOUNDATION_VALIDATED',
    coverage: 'INTENT_AND_LEASE_ONLY',
    quoteStatus: 'NOT_RUN',
    buildStatus: 'NOT_RUN',
    simulationStatus: 'NOT_RUN',
    signatureStatus: 'NOT_RUN',
    submissionStatus: 'NOT_RUN',
  });
  assert.equal(Object.isFrozen(assessment), true);
  assert.doesNotThrow(() => { assertExecutionDryRunAssessmentDraft(assessment); });
});

void test('creates identical assessments for RETRY_READY and supports SELL intents', () => {
  const retry = createExecutionDryRunAssessment(intent({
    status: 'RETRY_READY', attemptCount: 1, stateRevision: 1n,
    lastReasonCode: 'RECONCILIATION_PROVED_NO_EFFECT',
  }));
  const sell = createExecutionDryRunAssessment(intent({
    input: { side: 'SELL', venuePolicy: 'CANONICAL_EXIT', quoteAmountRaw: null, baseAmountRaw: 1n },
  }));

  assert.equal(retry.intentStatus, 'RETRY_READY');
  assert.equal(retry.intentStateRevision, 1n);
  assert.equal(sell.intentStatus, 'PENDING');
  assert.notEqual(sell.inputFingerprint, createExecutionDryRunAssessment(intent()).inputFingerprint);
});

void test('uses null marker segments and accepts exact u64 raw amounts', () => {
  const buy = createExecutionDryRunAssessment(intent({ input: { quoteAmountRaw: U64_MAX } }));
  const sell = createExecutionDryRunAssessment(intent({
    input: { side: 'SELL', venuePolicy: 'CANONICAL_EXIT', quoteAmountRaw: null, baseAmountRaw: U64_MAX },
  }));

  assert.notEqual(buy.inputFingerprint, sell.inputFingerprint);
  assert.equal(buy.inputFingerprint.length, 64);
  assert.equal(sell.inputFingerprint.length, 64);
});

void test('changes the input fingerprint for every covered intent field', () => {
  const baseline = createExecutionDryRunAssessment(intent()).inputFingerprint;
  const variants: readonly ExecutionIntentV1[] = [
    intent({ input: { strategyId: 'other-strategy' } }),
    intent({ input: { strategyVersion: 2 } }),
    intent({ input: { positionId: 'position-2' } }),
    intent({ input: { logicalCommandId: 'command-2' } }),
    intent({ input: { mint: 'So11111111111111111111111111111111111111112' } }),
    intent({ input: { side: 'SELL', venuePolicy: 'CANONICAL_EXIT', quoteAmountRaw: null, baseAmountRaw: 1n } }),
    intent({ input: { quoteMint: '11111111111111111111111111111111' } }),
    intent({ input: { quoteTokenProgram: 'TOKEN_2022' } }),
    intent({ input: { quoteDecimals: 8 } }),
    intent({ input: { quoteAmountRaw: 2n } }),
    intent({ input: { minimumAmountOutRaw: 2n } }),
    intent({ input: { decisionEventId: 'event-2' } }),
    intent({ input: { decisionFingerprint: 'b'.repeat(64) } }),
    intent({ input: { requestedAtMs: 1_001, expiresAtMs: 10_001 } }),
    intent({ input: { expiresAtMs: 9_999 } }),
    intent({ status: 'RETRY_READY', attemptCount: 1, stateRevision: 1n, lastReasonCode: 'RECONCILIATION_PROVED_NO_EFFECT' }),
    intent({ status: 'RETRY_READY', attemptCount: 2, stateRevision: 0n, lastReasonCode: 'RECONCILIATION_PROVED_NO_EFFECT' }),
  ];

  for (const variant of variants) {
    assert.notEqual(createExecutionDryRunAssessment(variant).inputFingerprint, baseline);
  }
  const sellBaseline = createExecutionDryRunAssessment(intent({
    input: { side: 'SELL', venuePolicy: 'CANONICAL_EXIT', quoteAmountRaw: null, baseAmountRaw: 1n },
  })).inputFingerprint;
  const changedBaseAmount = createExecutionDryRunAssessment(intent({
    input: { side: 'SELL', venuePolicy: 'CANONICAL_EXIT', quoteAmountRaw: null, baseAmountRaw: 2n },
  })).inputFingerprint;
  assert.notEqual(changedBaseAmount, sellBaseline);
});

void test('rejects execution intents outside PENDING and RETRY_READY', () => {
  const active = (status: Exclude<ExecutionIntentV1['status'], 'PENDING'>,
    lastReasonCode: NonNullable<ExecutionIntentV1['lastReasonCode']>) => intent({
    status, attemptCount: 1, lastReasonCode,
  });
  const terminal = (status: 'SUCCEEDED' | 'FAILED' | 'EXPIRED' | 'CANCELLED',
    lastReasonCode: NonNullable<ExecutionIntentV1['lastReasonCode']>) => intent({
    status, attemptCount: 1, lastReasonCode, terminalAtMs: 1_000,
    reconciliationCompletedAtMs: 1_000, purgeAfterMs: 14_401_000,
  });
  const forbidden: readonly ExecutionIntentV1[] = [
    active('PROCESSING', 'EXECUTION_STARTED'),
    active('SIMULATED', 'SIMULATION_SUCCEEDED'),
    active('SIGNED_NOT_SUBMITTED', 'SIGNATURE_PERSISTED'),
    active('SUBMITTED', 'SUBMISSION_ACCEPTED'),
    active('CONFIRMED', 'CONFIRMATION_OBSERVED'),
    active('RECONCILING', 'RECONCILIATION_STARTED'),
    terminal('SUCCEEDED', 'INTENT_SUCCEEDED'),
    terminal('FAILED', 'QUOTE_STALE'),
    terminal('EXPIRED', 'INTENT_EXPIRED'),
    terminal('CANCELLED', 'INTENT_CANCELLED'),
    active('UNKNOWN_REQUIRES_RECONCILIATION', 'RECONCILIATION_REQUIRED'),
  ];
  for (const record of forbidden) {
    assert.doesNotThrow(() => { assertExecutionIntent(record); });
    assertValidationFailure(() => { createExecutionDryRunAssessment(record); });
  }
});

void test('asserts exact frozen own-data draft and recorded assessment shapes', () => {
  const draft = createExecutionDryRunAssessment(intent());
  const recorded = Object.freeze({ ...draft, recordedAtMs: 1_000 });

  assert.doesNotThrow(() => { assertExecutionDryRunAssessmentDraft(draft); });
  assert.doesNotThrow(() => { assertExecutionDryRunAssessment(recorded); });
  assertValidationFailure(() => { assertExecutionDryRunAssessmentDraft({ ...draft }); });
  assertValidationFailure(() => { assertExecutionDryRunAssessment({ ...recorded }); });
  assertValidationFailure(() => { assertExecutionDryRunAssessment(Object.freeze({ ...recorded, extra: true })); });
  const { resultFingerprint: _removed, ...missing } = recorded;
  assertValidationFailure(() => { assertExecutionDryRunAssessment(Object.freeze(missing)); });
});

void test('rejects hostile accessor and proxy assessment inputs without invoking them', () => {
  const draft = createExecutionDryRunAssessment(intent());
  let getterCalls = 0;
  const getter = { ...draft };
  Object.defineProperty(getter, 'assessmentId', {
    enumerable: true,
    get: () => { getterCalls += 1; return draft.assessmentId; },
  });
  Object.freeze(getter);
  let proxyTraps = 0;
  const proxy = new Proxy(draft, {
    getPrototypeOf: () => { proxyTraps += 1; throw new Error('must not run'); },
    ownKeys: () => { proxyTraps += 1; throw new Error('must not run'); },
    getOwnPropertyDescriptor: () => { proxyTraps += 1; throw new Error('must not run'); },
  });

  assertValidationFailure(() => { assertExecutionDryRunAssessmentDraft(getter); });
  assertValidationFailure(() => { assertExecutionDryRunAssessmentDraft(proxy); });
  assert.equal(getterCalls, 0);
  assert.equal(proxyTraps, 0);
});

void test('rejects invalid assessment versions, values, dates, hashes, and enums', () => {
  const draft = createExecutionDryRunAssessment(intent());
  const invalidDrafts: readonly Readonly<Record<string, unknown>>[] = [
    { payloadVersion: 2 }, { specificationVersion: '1.4.0 ' }, { evaluatorVersion: 2 },
    { assessmentId: draft.assessmentId.toUpperCase() }, { inputFingerprint: 'A'.repeat(64) },
    { resultFingerprint: 'x'.repeat(64) }, { intentStateRevision: -1n }, { intentStatus: 'PROCESSING' },
    { outcome: 'OTHER' }, { coverage: 'OTHER' }, { quoteStatus: 'DONE' },
    { strategyVersion: 0 }, { decisionFingerprint: 'A'.repeat(64) },
  ];
  for (const overrides of invalidDrafts) {
    assertValidationFailure(() => { assertExecutionDryRunAssessmentDraft(Object.freeze({ ...draft, ...overrides })); });
  }
  for (const recordedAtMs of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, -0]) {
    assertValidationFailure(() => { assertExecutionDryRunAssessment(Object.freeze({ ...draft, recordedAtMs })); });
  }
});

function intent(overrides: Readonly<{
  input?: Readonly<Record<string, unknown>>;
  status?: ExecutionIntentV1['status'];
  attemptCount?: number;
  stateRevision?: bigint;
  lastReasonCode?: ExecutionIntentV1['lastReasonCode'];
  terminalAtMs?: number | null;
  reconciliationCompletedAtMs?: number | null;
  purgeAfterMs?: number | null;
}> = {}): ExecutionIntentV1 {
  const draft = createExecutionIntentDraft({
    strategyId: 'dry-run-strategy', strategyVersion: 1, positionId: 'position-1',
    logicalCommandId: 'command-1', mint: '11111111111111111111111111111111',
    side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112', quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9, quoteAmountRaw: 1n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: 'event-1', decisionFingerprint: 'a'.repeat(64), requestedAtMs: 1_000,
    expiresAtMs: 10_000, ...overrides.input,
  });
  return Object.freeze({
    ...draft, status: overrides.status ?? 'PENDING', attemptCount: overrides.attemptCount ?? 0,
    stateRevision: overrides.stateRevision ?? 0n, lastReasonCode: overrides.lastReasonCode ?? null,
    terminalAtMs: overrides.terminalAtMs ?? null,
    reconciliationCompletedAtMs: overrides.reconciliationCompletedAtMs ?? null,
    purgeAfterMs: overrides.purgeAfterMs ?? null, createdAtMs: 1_000, updatedAtMs: 1_000,
  });
}

function assertValidationFailure(action: () => void): void {
  assert.throws(action, (error: unknown) => (
    error instanceof ExecutionDryRunValidationError
    && error.message === 'Invalid execution dry-run assessment.'
    && error.name === 'ExecutionDryRunValidationError'
  ));
}
