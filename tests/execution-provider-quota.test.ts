import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProviderUsageOperationId,
  createProviderUsageSnapshot,
  evaluateProviderQuota,
  ExecutionProviderQuotaValidationError,
} from '../src/domain/execution-provider-quota.js';
import { createExecutionRiskPolicy } from '../src/domain/execution-risk-policy.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

void test('creates a deterministic frozen provider snapshot and operation identity', () => {
  const snapshot = createProviderUsageSnapshot(snapshotInput());
  const replay = createProviderUsageSnapshot(snapshotInput());

  assert.deepEqual(snapshot, replay);
  assert.match(snapshot.snapshotId, /^execution_provider_usage_[0-9a-f]{64}$/u);
  assert.match(snapshot.snapshotFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.notEqual(
    createProviderUsageSnapshot(snapshotInput({ usedUnits: 801n })).snapshotFingerprint,
    snapshot.snapshotFingerprint,
  );

  const operation = {
    providerId: 'primary', billingPeriodId: '2026-08', category: 'ENTRY',
    logicalOperationId: 'intent-1-attempt-1-genesis',
  } as const;
  assert.equal(createProviderUsageOperationId(operation), createProviderUsageOperationId(operation));
  assert.notEqual(
    createProviderUsageOperationId(operation),
    createProviderUsageOperationId({ ...operation, category: 'EXIT' }),
  );
});

void test('keeps a fresh provider NORMAL while entry and protected exit capacity fit', () => {
  const result = evaluateProviderQuota(quotaInput());

  assert.deepEqual(result, {
    payloadVersion: 1,
    state: 'NORMAL',
    reasonCode: null,
    remainingUnits: 180n,
    protectedUnits: 23n,
    entryCostUnits: 8n,
    recentRateLimitCount: 0,
    snapshotFingerprint: createProviderUsageSnapshot(snapshotInput()).snapshotFingerprint,
  });
  assert.equal(Object.isFrozen(result), true);
});

void test('distinguishes the exact NORMAL, ENTRY_BLOCKED and EXIT_ONLY boundaries', () => {
  const normal = evaluateProviderQuota(quotaInput({
    snapshot: createProviderUsageSnapshot(snapshotInput({ usedUnits: 969n })),
    localUsedSinceMeasurement: 0n,
  }));
  assert.equal(normal.remainingUnits, 31n);
  assert.equal(normal.state, 'NORMAL');

  const entryBlocked = evaluateProviderQuota(quotaInput({
    snapshot: createProviderUsageSnapshot(snapshotInput({ usedUnits: 970n })),
    localUsedSinceMeasurement: 0n,
  }));
  assert.equal(entryBlocked.remainingUnits, 30n);
  assert.equal(entryBlocked.state, 'ENTRY_BLOCKED');
  assert.equal(entryBlocked.reasonCode, 'PROVIDER_ENTRY_LIMIT_REACHED');

  const exitOnly = evaluateProviderQuota(quotaInput({
    snapshot: createProviderUsageSnapshot(snapshotInput({ usedUnits: 978n })),
    localUsedSinceMeasurement: 0n,
  }));
  assert.equal(exitOnly.remainingUnits, 22n);
  assert.equal(exitOnly.state, 'EXIT_ONLY');
  assert.equal(exitOnly.reasonCode, 'PROVIDER_EXIT_ONLY');
});

void test('treats the exact expiry boundary as fresh and the next millisecond as UNKNOWN', () => {
  assert.equal(evaluateProviderQuota(quotaInput({ nowMs: 301_000 })).state, 'NORMAL');
  const stale = evaluateProviderQuota(quotaInput({ nowMs: 301_001 }));
  assert.equal(stale.state, 'UNKNOWN');
  assert.equal(stale.reasonCode, 'PROVIDER_USAGE_UNKNOWN');
  assert.equal(stale.remainingUnits, null);

  const missing = evaluateProviderQuota(quotaInput({ snapshot: null }));
  assert.equal(missing.state, 'UNKNOWN');
  assert.equal(missing.snapshotFingerprint, null);
});

void test('blocks entry after three recent 429 events and prioritizes exit when endpoints exhaust', () => {
  const rateLimited = evaluateProviderQuota(quotaInput({
    nowMs: 50_000,
    consecutiveRateLimits: [19_999, 20_000, 35_000, 50_000],
  }));
  assert.equal(rateLimited.recentRateLimitCount, 3);
  assert.equal(rateLimited.state, 'ENTRY_BLOCKED');
  assert.equal(rateLimited.reasonCode, 'PROVIDER_ENTRY_LIMIT_REACHED');

  const unavailable = evaluateProviderQuota(quotaInput({ allEndpointsUnavailable: true }));
  assert.equal(unavailable.state, 'EXIT_ONLY');
  assert.equal(unavailable.reasonCode, 'PROVIDER_EXIT_ONLY');
});

void test('fails UNKNOWN on non-monotone usage, plan changes and regressed billing periods', () => {
  const previous = createProviderUsageSnapshot(snapshotInput());
  for (const snapshot of [
    createProviderUsageSnapshot(snapshotInput({ measuredAtMs: 2_000, usedUnits: 799n })),
    createProviderUsageSnapshot(snapshotInput({ measuredAtMs: 2_000, planId: 'plan-v2' })),
    createProviderUsageSnapshot(snapshotInput({
      billingPeriodId: '2026-09', billingPeriodStartedAtMs: 2_000_000,
      billingPeriodEndsAtMs: 4_678_400_000, measuredAtMs: 2_000_001, usedUnits: 1n,
      expiresAtMs: 2_300_001,
    })),
  ]) {
    const result = evaluateProviderQuota(quotaInput({ previousSnapshot: previous, snapshot }));
    assert.equal(result.state, 'UNKNOWN');
    assert.equal(result.reasonCode, 'PROVIDER_USAGE_UNKNOWN');
  }

  const nextPeriod = createProviderUsageSnapshot(snapshotInput({
    billingPeriodId: '2026-09',
    billingPeriodStartedAtMs: 2_678_400_000,
    billingPeriodEndsAtMs: 5_356_800_000,
    measuredAtMs: 2_678_401_000,
    expiresAtMs: 2_678_701_000,
    usedUnits: 1n,
  }));
  assert.equal(evaluateProviderQuota(quotaInput({
    previousSnapshot: previous,
    snapshot: nextPeriod,
    nowMs: 2_678_401_001,
    localUsedSinceMeasurement: 0n,
  })).state, 'NORMAL');
});

void test('rejects malformed periods, TTLs, counters, operations and hostile inputs', () => {
  for (const invalid of [
    { usedUnits: 1_001n },
    { measuredAtMs: -1 },
    { billingPeriodStartedAtMs: 1_001 },
    { billingPeriodEndsAtMs: 1_000 },
    { expiresAtMs: 30_999 },
    { expiresAtMs: 901_001 },
    { provenance: 'SCRAPED' },
    { providerId: 'provider with spaces' },
  ]) assertInvalid(() => createProviderUsageSnapshot(snapshotInput(invalid)));

  assertInvalid(() => createProviderUsageOperationId({
    providerId: 'primary', billingPeriodId: '2026-08', category: 'BUY',
    logicalOperationId: 'operation',
  }));
  assertInvalid(() => evaluateProviderQuota(quotaInput({ localUsedSinceMeasurement: 1 })));
  assertInvalid(() => evaluateProviderQuota(quotaInput({ consecutiveRateLimits: [2_000, 1_000] })));

  let traps = 0;
  const proxy = new Proxy(quotaInput(), {
    getOwnPropertyDescriptor: () => { traps += 1; throw new Error('quota-secret'); },
    getPrototypeOf: () => { traps += 1; throw new Error('quota-secret'); },
  });
  assertInvalid(() => evaluateProviderQuota(proxy));
  assert.equal(traps, 0);
});

function quotaInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    policy: createExecutionRiskPolicy(policyInput()),
    previousSnapshot: null,
    snapshot: createProviderUsageSnapshot(snapshotInput()),
    localUsedSinceMeasurement: 20n,
    openPositions: 2,
    consecutiveRateLimits: [],
    allEndpointsUnavailable: false,
    nowMs: 2_000,
    ...overrides,
  };
}

function snapshotInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    providerId: 'primary',
    planId: 'plan-v1',
    billingPeriodId: '2026-08',
    billingPeriodStartedAtMs: 0,
    billingPeriodEndsAtMs: 2_678_400_000,
    limitUnits: 1_000n,
    usedUnits: 800n,
    measuredAtMs: 1_000,
    expiresAtMs: 301_000,
    provenance: 'AUTHORITATIVE_PROBE',
    ...overrides,
  };
}

function policyInput(): Record<string, unknown> {
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
  };
}

function assertInvalid(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof ExecutionProviderQuotaValidationError);
    assert.equal(error.name, 'ExecutionProviderQuotaValidationError');
    assert.equal(error.message, 'Invalid execution provider quota input.');
    return true;
  });
}
