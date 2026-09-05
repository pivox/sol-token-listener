import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionArmament,
  createExecutionArmamentRequestV2,
  createExecutionArmamentV2,
  createOperatorAuthorization,
  createOperatorAuthorizationV2,
  decideExecutionControlTransition,
  ExecutionOperationsValidationError,
} from '../src/domain/execution-operations.js';
import {
  createSafetyQualification,
  EXECUTION_SAFETY_GATE_IDS,
} from '../src/domain/execution-safety-qualification.js';
import { canaryEvidenceInput, NOW_MS as CANARY_NOW_MS } from './helpers/execution-canary-fixture.js';

const NOW_MS = 1_788_134_400_000;

void test('creates a deterministic short-lived operator authorization without retaining its nonce', () => {
  const authorization = createOperatorAuthorization({
    payloadVersion: 1,
    generationId: `execution_wallet_generation_${'d'.repeat(64)}`,
    action: 'ARM',
    phase: 'CANARY',
    contextFingerprint: 'a'.repeat(64),
    nonceHash: 'b'.repeat(64),
    operatorId: 'operator-primary',
    issuedAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 60_000,
  });
  assert.match(authorization.authorizationId,
    /^execution_operator_authorization_[0-9a-f]{64}$/u);
  assert.equal('nonce' in authorization, false);
  assert.equal(Object.isFrozen(authorization), true);
  assert.throws(() => createOperatorAuthorization({
    ...authorization,
    rawNonce: 'forbidden',
  }), ExecutionOperationsValidationError);
  assert.throws(() => createOperatorAuthorization({
    payloadVersion: 1,
    generationId: authorization.generationId,
    action: 'RESUME',
    phase: 'CANARY',
    contextFingerprint: authorization.contextFingerprint,
    nonceHash: authorization.nonceHash,
    operatorId: authorization.operatorId,
    issuedAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 300_001,
  }), ExecutionOperationsValidationError);
});

void test('creates a deterministic frozen inert canary armament', () => {
  const armament = createExecutionArmament(armamentInput());
  assert.match(armament.armamentId, /^execution_activation_armament_[0-9a-f]{64}$/u);
  assert.match(armament.armamentFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(armament.state, 'ARMED');
  assert.equal(armament.maximumCapitalLamports, 500_000n);
  assert.equal(Object.isFrozen(armament), true);
  assert.deepEqual(createExecutionArmament(armamentInput()), armament);
});

void test('enforces exact phase buy, position, exposure and holding limits', () => {
  for (const candidate of [
    armamentInput({ maximumBuys: 2 }),
    armamentInput({ maximumOpenPositions: 2 }),
    armamentInput({ maximumExposureBps: 501n }),
    armamentInput({ maximumHoldingMs: 29_999 }),
    armamentInput({ maximumHoldingMs: 900_001 }),
    armamentInput({ maximumCapitalLamports: 0n }),
    armamentInput({ maximumCapitalLamports: 1 }),
  ]) assert.throws(() => createExecutionArmament(candidate), ExecutionOperationsValidationError);

  const micro = qualification('MICRO_LIVE');
  assert.equal(createExecutionArmament(armamentInput({
    qualification: micro,
    maximumBuys: 3,
  })).maximumBuys, 3);
  const pilot = qualification('PILOT');
  assert.equal(createExecutionArmament(armamentInput({
    qualification: pilot,
    maximumBuys: 10,
    maximumOpenPositions: 2,
    maximumExposureBps: 2_000n,
  })).maximumOpenPositions, 2);
});

void test('rejects armament outside its qualification window or with fabricated authority', () => {
  const valid = qualification('CANARY');
  for (const candidate of [
    armamentInput({ armedAtMs: valid.qualifiedAtMs - 1 }),
    armamentInput({ expiresAtMs: valid.expiresAtMs + 1 }),
    armamentInput({ expiresAtMs: NOW_MS }),
    armamentInput({ authorizationId: 'invalid' }),
    armamentInput({ authorizationFingerprint: 'f'.repeat(63) }),
    { ...armamentInput(), secret: 'forbidden' },
    new Proxy(armamentInput(), {}),
  ]) assert.throws(
    () => createExecutionArmament(candidate),
    (error) => error instanceof ExecutionOperationsValidationError
      && error.message === 'Invalid execution operations input.',
  );
});

void test('control transitions are fail-closed and never let stop arm live', () => {
  assert.deepEqual(decideExecutionControlTransition({
    currentState: 'RUNNING', action: 'ENTRY_STOP',
    freshQualification: false, unknownRisk: true,
  }), { nextState: 'ENTRY_STOP', reasonCode: 'OPERATOR_ENTRY_STOP' });
  assert.deepEqual(decideExecutionControlTransition({
    currentState: 'ENTRY_STOP', action: 'HARD_STOP',
    freshQualification: false, unknownRisk: false,
  }), { nextState: 'HARD_STOP', reasonCode: 'OPERATOR_HARD_STOP' });
  assert.deepEqual(decideExecutionControlTransition({
    currentState: 'HARD_STOP', action: 'RESUME',
    freshQualification: true, unknownRisk: false,
  }), { nextState: 'RUNNING', reasonCode: null });
  for (const candidate of [
    { currentState: 'ENTRY_STOP', action: 'RESUME', freshQualification: false, unknownRisk: false },
    { currentState: 'ENTRY_STOP', action: 'RESUME', freshQualification: true, unknownRisk: true },
    { currentState: 'HARD_STOP', action: 'ENTRY_STOP', freshQualification: true, unknownRisk: false },
  ]) assert.throws(
    () => decideExecutionControlTransition(candidate),
    ExecutionOperationsValidationError,
  );
});

void test('creates a frozen exact-target V2 request and armament without changing V1 reconstruction', () => {
  const evidence = canaryEvidenceInput();
  const request = createExecutionArmamentRequestV2({
    ...evidence, payloadVersion: 2, target: {
      intentId: evidence.targetIntentId, stateRevision: 7n, strategyId: 'live-canary',
      strategyVersion: 1, decisionFingerprint: '8'.repeat(64), mint: '11111111111111111111111111111111',
      quoteMint: 'So11111111111111111111111111111111111111112', quoteAmountRaw: 500_000n,
    }, maximumBuys: 1, maximumCapitalLamports: 500_000n, maximumExposureBps: 500n,
    maximumOpenPositions: 1, maximumHoldingMs: 300_000,
    runtimeQuoteMaxAgeMs: 30_000, runtimeSlippageBps: 500n, runtimeSnapshotMaxSlotLag: 50,
    runtimeMaxComputeUnits: 1_400_000n, runtimeMaxFeeLamports: 10_000n,
    runtimeMaxFeePayerLamportDebit: 20_000n, runtimeMaxRpcCallsPerAttempt: 12,
    runtimeLeaseMs: 120_000, armedAtMs: CANARY_NOW_MS + 1, armamentExpiresAtMs: CANARY_NOW_MS + 299_999,
    operatorId: 'operator-primary', operatorReason: 'Exact Mainnet canary approval.',
  });
  const armament = createExecutionArmamentV2({
    payloadVersion: 2, request, authorizationId: `execution_operator_authorization_${'9'.repeat(64)}`,
    authorizationFingerprint: 'a'.repeat(64), admissionReportId: `execution_risk_admission_${'b'.repeat(64)}`,
    reservationId: `execution_exposure_reservation_${'c'.repeat(64)}`,
  });
  assert.equal(request.armamentRequestFingerprint, armament.armamentRequestFingerprint);
  assert.notEqual(request.armamentRequestFingerprint, createExecutionArmamentRequestV2({
    ...evidence, payloadVersion: 2, capturedAtMs: CANARY_NOW_MS + 1, target: request.target,
    maximumBuys: 1, maximumCapitalLamports: 500_000n, maximumExposureBps: 500n,
    maximumOpenPositions: 1, maximumHoldingMs: 300_000, runtimeQuoteMaxAgeMs: 30_000,
    runtimeSlippageBps: 500n, runtimeSnapshotMaxSlotLag: 50, runtimeMaxComputeUnits: 1_400_000n,
    runtimeMaxFeeLamports: 10_000n, runtimeMaxFeePayerLamportDebit: 20_000n,
    runtimeMaxRpcCallsPerAttempt: 12, runtimeLeaseMs: 120_000, armedAtMs: CANARY_NOW_MS + 1,
    armamentExpiresAtMs: CANARY_NOW_MS + 299_999, operatorId: 'operator-primary',
    operatorReason: 'Exact Mainnet canary approval.',
  }).armamentRequestFingerprint);
  assert.equal(armament.payloadVersion, 2);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(createExecutionArmament(armamentInput()).payloadVersion, 1);
});

void test('V2 request fingerprint covers each known pre-TTY input and rejects non-CANARY bounds', () => {
  const input = canaryEvidenceInput();
  const requestFor = (evidence: ReturnType<typeof canaryEvidenceInput>, overrides: Readonly<Record<string, unknown>> = {}) => createExecutionArmamentRequestV2({
    ...evidence, payloadVersion: 2, target: {
      intentId: evidence.targetIntentId, stateRevision: 7n, strategyId: 'live-canary', strategyVersion: 1,
      decisionFingerprint: '8'.repeat(64), mint: '11111111111111111111111111111111',
      quoteMint: 'So11111111111111111111111111111111111111112', quoteAmountRaw: 500_000n,
    }, maximumBuys: 1, maximumCapitalLamports: 500_000n, maximumExposureBps: 500n,
    maximumOpenPositions: 1, maximumHoldingMs: 300_000, runtimeQuoteMaxAgeMs: 30_000,
    runtimeSlippageBps: 500n, runtimeSnapshotMaxSlotLag: 50, runtimeMaxComputeUnits: 1_400_000n,
    runtimeMaxFeeLamports: 10_000n, runtimeMaxFeePayerLamportDebit: 20_000n,
    runtimeMaxRpcCallsPerAttempt: 12, runtimeLeaseMs: 120_000, armedAtMs: CANARY_NOW_MS + 1,
    armamentExpiresAtMs: CANARY_NOW_MS + 299_999, operatorId: 'operator-primary',
    operatorReason: 'Exact Mainnet canary approval.', ...overrides,
  });
  const request = (overrides: Readonly<Record<string, unknown>> = {}) => requestFor(input, overrides);
  const valid = request();
  for (const changed of [
    { maximumCapitalLamports: 500_001n }, { maximumHoldingMs: 300_001 },
    { runtimeQuoteMaxAgeMs: 30_001 }, { runtimeSlippageBps: 501n },
    { runtimeSnapshotMaxSlotLag: 51 }, { runtimeMaxComputeUnits: 1_399_999n },
    { runtimeMaxFeeLamports: 9_999n }, { runtimeMaxFeePayerLamportDebit: 19_999n },
    { runtimeMaxRpcCallsPerAttempt: 13 }, { runtimeLeaseMs: 60_000 },
    { armedAtMs: CANARY_NOW_MS + 2 }, { armamentExpiresAtMs: CANARY_NOW_MS + 299_998 },
    { operatorId: 'operator-secondary' }, { operatorReason: 'A distinct operator reason.' },
    { target: { ...valid.target, stateRevision: 8n } }, { target: { ...valid.target, strategyId: 'canary-two' } },
    { target: { ...valid.target, strategyVersion: 2 } }, { target: { ...valid.target, decisionFingerprint: '9'.repeat(64) } },
    { target: { ...valid.target, mint: '11111111111111111111111111111112' } },
    { target: { ...valid.target, quoteAmountRaw: 499_999n } },
  ]) assert.notEqual(request(changed).armamentRequestFingerprint, valid.armamentRequestFingerprint);
  const alternateIntentId = `execution_intent_${'f'.repeat(64)}`;
  const variantEvidence = [
    canaryEvidenceInput({ targetIntentId: alternateIntentId }),
    canaryEvidenceInput({ expiresAtMs: CANARY_NOW_MS + 299_999 }),
    canaryEvidenceInput({ qualification: { buildHash: 'd'.repeat(64) } }),
    canaryEvidenceInput({ policy: { feeReserveLamports: 99_999n } }),
    canaryEvidenceInput({ walletSnapshot: { walletLamports: 999_999n } }),
    canaryEvidenceInput({ providerSnapshot: { usedUnits: 2n } }),
  ];
  for (const evidence of variantEvidence) assert.notEqual(requestFor(evidence).armamentRequestFingerprint,
    valid.armamentRequestFingerprint);
  assert.throws(() => request({ target: { ...valid.target, quoteMint: '11111111111111111111111111111111' } }),
    ExecutionOperationsValidationError);
  assert.throws(() => requestFor(canaryEvidenceInput({ policy: {
    maximumTotalExposureBps: 2_000n, maximumOpenPositions: 2,
  } })), ExecutionOperationsValidationError);
  assert.notEqual(request({ runtimeLeaseMs: 60_000 }).armamentRequestFingerprint,
    valid.armamentRequestFingerprint);
  assert.throws(() => request({ runtimeLeaseMs: 120_001 }),
    ExecutionOperationsValidationError);
  assert.throws(() => request({ target: { ...valid.target, quoteAmountRaw: 500_001n } }),
    ExecutionOperationsValidationError);
  for (const invalid of [
    { runtimeQuoteMaxAgeMs: 60_001 }, { runtimeSlippageBps: 10_001n },
    { runtimeSnapshotMaxSlotLag: 129 }, { runtimeMaxComputeUnits: 1_400_001n },
    { runtimeMaxFeeLamports: 10_000_001n }, { runtimeMaxFeePayerLamportDebit: 10_000_000_001n },
    { runtimeMaxRpcCallsPerAttempt: 11 }, { runtimeLeaseMs: 2_999 },
    { target: { ...valid.target, stateRevision: 9_223_372_036_854_775_808n } },
  ]) assert.throws(() => request(invalid), ExecutionOperationsValidationError);
});

void test('creates an exact short-lived V2 operator authorization for the V2 request context', () => {
  const authorization = createOperatorAuthorizationV2({
    payloadVersion: 2, generationId: `execution_wallet_generation_${'d'.repeat(64)}`,
    action: 'ARM', phase: 'CANARY', contextFingerprint: 'a'.repeat(64), nonceHash: 'b'.repeat(64),
    operatorId: 'operator-primary', issuedAtMs: NOW_MS, expiresAtMs: NOW_MS + 60_000,
  });
  assert.equal(authorization.payloadVersion, 2);
  assert.match(authorization.authorizationId, /^execution_operator_authorization_[0-9a-f]{64}$/u);
  assert.notEqual(authorization.authorizationFingerprint, createOperatorAuthorization({
    payloadVersion: 1, generationId: authorization.generationId, action: authorization.action,
    phase: authorization.phase, contextFingerprint: authorization.contextFingerprint,
    nonceHash: authorization.nonceHash, operatorId: authorization.operatorId,
    issuedAtMs: authorization.issuedAtMs, expiresAtMs: authorization.expiresAtMs,
  }).authorizationFingerprint);
  assert.throws(() => createOperatorAuthorizationV2({ ...authorization, payloadVersion: 2, rawNonce: 'forbidden' }),
    ExecutionOperationsValidationError);
});

function armamentInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    payloadVersion: 1,
    qualification: qualification('CANARY'),
    maximumBuys: 1,
    maximumCapitalLamports: 500_000n,
    maximumExposureBps: 500n,
    maximumOpenPositions: 1,
    maximumHoldingMs: 300_000,
    armedAtMs: NOW_MS + 1,
    expiresAtMs: NOW_MS + 299_999,
    operatorId: 'operator-primary',
    operatorReason: 'Mainnet canary manually approved.',
    authorizationId: `execution_operator_authorization_${'e'.repeat(64)}`,
    authorizationFingerprint: 'f'.repeat(64),
    ...overrides,
  };
}

function qualification(phase: 'CANARY' | 'MICRO_LIVE' | 'PILOT') {
  const evidenceTypes = [
    'CI_RUN', 'MIGRATION_TEST', 'ARCHITECTURE_TEST', 'DRY_RUN_TEST',
    'SIMULATION_ARTIFACT', 'FAULT_TEST', 'RECONCILIATION_STATE',
    'PROVIDER_SNAPSHOT', 'STOP_CONTROL_TEST', 'WALLET_SNAPSHOT',
    'MAINNET_SIMULATION_ARTIFACT',
  ] as const;
  return createSafetyQualification({
    payloadVersion: 1,
    evaluatorVersion: 1,
    phase,
    buildHash: 'a'.repeat(64),
    configurationFingerprint: 'b'.repeat(64),
    strategyFingerprint: 'c'.repeat(64),
    generationId: `execution_wallet_generation_${'d'.repeat(64)}`,
    walletPublicKey: '11111111111111111111111111111111',
    cluster: 'mainnet-beta',
    genesisHash: '11111111111111111111111111111111',
    providerId: 'primary',
    qualifiedAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 300_000,
    gates: EXECUTION_SAFETY_GATE_IDS.map((gateId, index) => ({
      payloadVersion: 1,
      gateId,
      status: 'PASSED',
      evidenceType: evidenceTypes[index],
      evidenceId: `evidence:${index}`,
      evidenceFingerprint: index.toString(16).repeat(64),
      observedAtMs: NOW_MS - 1_000 + index,
      expiresAtMs: NOW_MS + 300_000,
    })),
  });
}
