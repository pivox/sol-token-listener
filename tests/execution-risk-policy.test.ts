import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionRiskPolicy,
  evaluateBuyRisk,
  ExecutionRiskValidationError,
} from '../src/domain/execution-risk-policy.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

void test('creates the exact frozen V1 policy and deterministic fingerprint', () => {
  const first = createExecutionRiskPolicy(policyInput());
  const replay = createExecutionRiskPolicy(policyInput());

  assert.deepEqual(first, replay);
  assert.equal(first.payloadVersion, 1);
  assert.match(first.policyFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.quoteMintAllowlist), true);
  assert.deepEqual(Reflect.ownKeys(first), [
    'payloadVersion', 'policyFingerprint', 'quoteMintAllowlist',
    'initialCapitalLamports', 'maximumCapitalLamports', 'positionSizeBps',
    'maximumOpenPositions', 'maximumTotalExposureBps', 'drawdownPauseBps',
    'feeReserveLamports', 'walletSnapshotMaxAgeMs', 'providerUsageMaxAgeMs',
    'providerEntryCostUnits', 'providerExitCostUnitsPerPosition',
    'providerConfirmationCostUnitsPerPosition',
    'providerReconciliationCostUnitsPerPosition', 'providerSafetyMarginUnits',
    'maximumConsecutiveTechnicalFailures',
  ]);
  assert.notEqual(
    createExecutionRiskPolicy(policyInput({ feeReserveLamports: 100_001n })).policyFingerprint,
    first.policyFingerprint,
  );
});

void test('admits an exact BUY at the fee-adjusted position limit', () => {
  const decision = evaluateBuyRisk(riskInput());

  assert.deepEqual(decision, {
    payloadVersion: 1,
    kind: 'ADMISSIBLE',
    reasonCode: null,
    reconciledCapitalLamports: 1_000_000n,
    capitalAfterFeeReserveLamports: 900_000n,
    positionLimitLamports: 90_000n,
    totalExposureLimitLamports: 200_000n,
    projectedExposureLamports: 90_000n,
    conservativeUnrealizedLossLamports: 0n,
    drawdownBps: 0n,
    openPositionCount: 0,
  });
  assert.equal(Object.isFrozen(decision), true);
});

void test('caps realized gains, clamps realized losses and never increases sizing from open PnL', () => {
  const capped = evaluateBuyRisk(riskInput({ realizedNetPnlLamports: 5_000_000n }));
  assert.equal(capped.reconciledCapitalLamports, 1_000_000n);
  assert.equal(capped.positionLimitLamports, 90_000n);

  const depleted = evaluateBuyRisk(riskInput({
    realizedNetPnlLamports: -2_000_000n,
    requestedQuoteAmountRaw: 1n,
  }));
  assert.equal(depleted.reconciledCapitalLamports, 0n);
  assert.equal(depleted.positionLimitLamports, 0n);
  assert.equal(depleted.kind, 'REJECTED');
  assert.equal(depleted.reasonCode, 'CAPITAL_LIMIT_EXCEEDED');
});

void test('rejects position and total exposure limit violations independently', () => {
  const position = evaluateBuyRisk(riskInput({ requestedQuoteAmountRaw: 90_001n }));
  assert.equal(position.kind, 'REJECTED');
  assert.equal(position.reasonCode, 'CAPITAL_LIMIT_EXCEEDED');

  const exposure = evaluateBuyRisk(riskInput({
    requestedQuoteAmountRaw: 90_000n,
    reservedExposureLamports: 110_001n,
  }));
  assert.equal(exposure.kind, 'REJECTED');
  assert.equal(exposure.reasonCode, 'EXPOSURE_LIMIT_EXCEEDED');
  assert.equal(exposure.projectedExposureLamports, 200_001n);
});

void test('saturates persisted exposure and loss aggregates at u64 max', () => {
  const u64Max = (1n << 64n) - 1n;
  const exposure = evaluateBuyRisk(riskInput({
    requestedQuoteAmountRaw: 1n,
    reservedExposureLamports: u64Max,
  }));
  assert.equal(exposure.kind, 'REJECTED');
  assert.equal(exposure.reasonCode, 'EXPOSURE_LIMIT_EXCEEDED');
  assert.equal(exposure.projectedExposureLamports, u64Max);

  const loss = evaluateBuyRisk(riskInput({
    requestedQuoteAmountRaw: 1n,
    openPositions: [position('one', u64Max, 0n), position('two', u64Max, 0n)],
  }));
  assert.equal(loss.conservativeUnrealizedLossLamports, u64Max);
  assert.equal(loss.reasonCode, 'EXPOSURE_LIMIT_EXCEEDED');
});

void test('rejects another BUY when the open-position count is already full', () => {
  const decision = evaluateBuyRisk(riskInput({
    openPositions: [position('one', 50_000n, 50_000n), position('two', 50_000n, 50_000n)],
    requestedQuoteAmountRaw: 1n,
  }));

  assert.equal(decision.kind, 'REJECTED');
  assert.equal(decision.reasonCode, 'EXPOSURE_LIMIT_EXCEEDED');
  assert.equal(decision.openPositionCount, 2);
});

void test('uses a missing SELL quote as zero and blocks at the exact drawdown threshold', () => {
  const missingQuote = evaluateBuyRisk(riskInput({
    requestedQuoteAmountRaw: 1n,
    openPositions: [position('missing', 250_000n, null)],
  }));
  assert.equal(missingQuote.conservativeUnrealizedLossLamports, 250_000n);
  assert.equal(missingQuote.drawdownBps, 2_500n);
  assert.equal(missingQuote.kind, 'REJECTED');
  assert.equal(missingQuote.reasonCode, 'DRAWDOWN_LIMIT_EXCEEDED');

  const roundedUp = evaluateBuyRisk(riskInput({
    requestedQuoteAmountRaw: 1n,
    openPositions: [position('rounded', 1n, 0n)],
  }));
  assert.equal(roundedUp.drawdownBps, 1n);
});

void test('blocks unknown positions and the second consecutive technical failure', () => {
  const unknown = evaluateBuyRisk(riskInput({
    requestedQuoteAmountRaw: 1n,
    openPositions: [position('unknown', 1n, 1n, 'UNKNOWN')],
  }));
  assert.equal(unknown.kind, 'REJECTED');
  assert.equal(unknown.reasonCode, 'RECONCILIATION_REQUIRED');

  const first = evaluateBuyRisk(riskInput({
    consecutiveTechnicalFailures: 1,
    lastTechnicalFailureReasonCode: 'EXECUTION_BUILD_FAILED',
  }));
  assert.equal(first.kind, 'ADMISSIBLE');

  const second = evaluateBuyRisk(riskInput({
    consecutiveTechnicalFailures: 2,
    lastTechnicalFailureReasonCode: 'EXECUTION_BUILD_FAILED',
  }));
  assert.equal(second.kind, 'REJECTED');
  assert.equal(second.reasonCode, 'EXECUTION_BUILD_FAILED');
});

void test('rejects a quote mint outside the exact V1 allowlist', () => {
  const decision = evaluateBuyRisk(riskInput({ quoteMint: '11111111111111111111111111111111' }));
  assert.equal(decision.kind, 'REJECTED');
  assert.equal(decision.reasonCode, 'QUOTE_MINT_NOT_ALLOWED');
});

void test('enforces the conservative pilot policy bounds and exact failure-count relation', () => {
  for (const invalid of [
    { initialCapitalLamports: 1_000_001n },
    { positionSizeBps: 1_001n },
    { maximumOpenPositions: 3 },
    { maximumTotalExposureBps: 2_001n },
    { drawdownPauseBps: 2_501n },
    { feeReserveLamports: 1_000_001n },
    { walletSnapshotMaxAgeMs: 0 },
    { providerUsageMaxAgeMs: 29_999 },
    { providerUsageMaxAgeMs: 900_001 },
    { maximumConsecutiveTechnicalFailures: 1 },
    { quoteMintAllowlist: ['11111111111111111111111111111111'] },
  ]) assertInvalid(() => createExecutionRiskPolicy(policyInput(invalid)));

  assertInvalid(() => evaluateBuyRisk(riskInput({
    consecutiveTechnicalFailures: 0,
    lastTechnicalFailureReasonCode: 'EXECUTION_BUILD_FAILED',
  })));
  assertInvalid(() => evaluateBuyRisk(riskInput({
    consecutiveTechnicalFailures: 1,
    lastTechnicalFailureReasonCode: null,
  })));
});

void test('rejects numbers, mutable policy objects, extra keys, accessors and proxies', () => {
  assertInvalid(() => createExecutionRiskPolicy({
    ...policyInput(), initialCapitalLamports: 1_000_000,
  }));
  assertInvalid(() => createExecutionRiskPolicy({ ...policyInput(), extra: true }));

  const mutablePolicy = { ...createExecutionRiskPolicy(policyInput()) };
  assertInvalid(() => evaluateBuyRisk(riskInput({ policy: mutablePolicy })));

  let getterCalls = 0;
  const accessor = riskInput() as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, 'requestedQuoteAmountRaw', {
    enumerable: true,
    get: () => { getterCalls += 1; return 1n; },
  });
  assertInvalid(() => evaluateBuyRisk(accessor));
  assert.equal(getterCalls, 0);

  let traps = 0;
  const proxy = new Proxy(riskInput(), {
    getOwnPropertyDescriptor: () => { traps += 1; throw new Error('proxy-secret'); },
    getPrototypeOf: () => { traps += 1; throw new Error('proxy-secret'); },
  });
  assertInvalid(() => evaluateBuyRisk(proxy));
  assert.equal(traps, 0);
});

function policyInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    quoteMintAllowlist: [WSOL_MINT],
    initialCapitalLamports: 1_000_000n,
    maximumCapitalLamports: 1_000_000n,
    positionSizeBps: 1_000n,
    maximumOpenPositions: 2,
    maximumTotalExposureBps: 2_000n,
    drawdownPauseBps: 2_500n,
    feeReserveLamports: 100_000n,
    walletSnapshotMaxAgeMs: 60_000,
    providerUsageMaxAgeMs: 300_000,
    providerEntryCostUnits: 8n,
    providerExitCostUnitsPerPosition: 4n,
    providerConfirmationCostUnitsPerPosition: 2n,
    providerReconciliationCostUnitsPerPosition: 3n,
    providerSafetyMarginUnits: 5n,
    maximumConsecutiveTechnicalFailures: 2,
    ...overrides,
  };
}

function riskInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    policy: createExecutionRiskPolicy(policyInput()),
    quoteMint: WSOL_MINT,
    requestedQuoteAmountRaw: 90_000n,
    realizedNetPnlLamports: 0n,
    reservedExposureLamports: 0n,
    openPositions: [],
    consecutiveTechnicalFailures: 0,
    lastTechnicalFailureReasonCode: null,
    ...overrides,
  };
}

function position(
  positionId: string,
  costBasisLamports: bigint,
  conservativeLiquidationLamports: bigint | null,
  reconciliationStatus: 'RECONCILED' | 'UNKNOWN' = 'RECONCILED',
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    positionId,
    costBasisLamports,
    conservativeLiquidationLamports,
    reconciliationStatus,
  });
}

function assertInvalid(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof ExecutionRiskValidationError);
    assert.equal(error.name, 'ExecutionRiskValidationError');
    assert.equal(error.message, 'Invalid execution risk input.');
    return true;
  });
}
