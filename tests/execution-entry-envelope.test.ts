import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createEntryEnvelope,
  createEnvelopeArmAuthorization,
  createEnvelopeProviderSnapshot,
  ENVELOPE_ARMAMENT_MAXIMUM_TTL_MS,
  ENVELOPE_EXIT_MARGIN_MS,
  evaluateEnvelopeArming,
  type EntryEnvelopeV2,
  type EnvelopeArmingFacts,
} from '../src/domain/execution-entry-envelope.js';
import { createExecutionRiskPolicy } from '../src/domain/execution-risk-policy.js';
import { createProviderUsageSnapshot } from '../src/domain/execution-provider-quota.js';
import {
  canaryEvidenceInput,
  envelopeCanaryEvidenceInput,
  ENVELOPE_QUALIFICATION_TTL_MS,
  NOW_MS,
  WSOL_MINT,
} from './helpers/execution-canary-fixture.js';

const INVALID = /Invalid execution entry envelope/u;
const OPERATOR_ID = 'operator-1';

function policy(overrides: Readonly<Record<string, unknown>> = {}) {
  return createExecutionRiskPolicy({
    quoteMintAllowlist: [WSOL_MINT], initialCapitalLamports: 230_000_000n,
    maximumCapitalLamports: 230_000_000n, positionSizeBps: 1_000n, maximumOpenPositions: 1,
    maximumTotalExposureBps: 500n, drawdownPauseBps: 2_500n, feeReserveLamports: 20_000_000n,
    walletSnapshotMaxAgeMs: 300_000, providerUsageMaxAgeMs: 300_000, providerEntryCostUnits: 8n,
    providerExitCostUnitsPerPosition: 4n, providerConfirmationCostUnitsPerPosition: 2n,
    providerReconciliationCostUnitsPerPosition: 3n, providerSafetyMarginUnits: 5n,
    maximumConsecutiveTechnicalFailures: 2, ...overrides,
  });
}

function envelopeInput(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const qualification = envelopeCanaryEvidenceInput().qualification;
  return {
    payloadVersion: 2, qualification, operatorId: OPERATOR_ID,
    perBuyQuoteAmountRaw: 10_000_000n, maxBuys: 10, maxTotalExposureRaw: 100_000_000n,
    maxRealizedLossRaw: 30_000_000n, maximumHoldingMs: 120_000,
    validFromMs: NOW_MS, validUntilMs: qualification.expiresAtMs, policy: policy(),
    ...overrides,
  };
}

function envelope(overrides: Readonly<Record<string, unknown>> = {}): EntryEnvelopeV2 {
  return createEntryEnvelope(envelopeInput(overrides));
}

void test('creates the 0.01 SOL envelope with a stable identity bound to its qualification', () => {
  const first = envelope();
  const second = envelope();
  assert.equal(first.envelopeId, second.envelopeId);
  assert.equal(first.envelopeId, `execution_entry_envelope_${first.fingerprint}`);
  assert.equal(first.payloadVersion, 2);
  assert.equal(first.qualificationId, envelopeCanaryEvidenceInput().qualification.qualificationId);
  assert.equal(first.generationId, envelopeCanaryEvidenceInput().qualification.generationId);
  assert.equal(first.policy.policyFingerprint, policy().policyFingerprint);
  assert.ok(Object.isFrozen(first));
  const expected = createHash('sha256').update(JSON.stringify([
    'execution-entry-envelope-v2', first.generationId, OPERATOR_ID, first.qualificationId,
    first.policy.policyFingerprint, '10000000', 10, 1, '100000000', '30000000', 120_000,
    NOW_MS, NOW_MS + ENVELOPE_QUALIFICATION_TTL_MS,
  ])).digest('hex');
  assert.equal(first.fingerprint, expected);
});

void test('changes the fingerprint with each field', () => {
  const base = envelope().fingerprint;
  const variants: Readonly<Record<string, unknown>>[] = [
    { operatorId: 'operator-2' },
    { perBuyQuoteAmountRaw: 9_000_000n },
    { maxBuys: 9 },
    { maxTotalExposureRaw: 90_000_000n },
    { maxRealizedLossRaw: 29_000_000n },
    { maximumHoldingMs: 121_000 },
    { validFromMs: NOW_MS + 1 },
    { policy: policy({ drawdownPauseBps: 2_000n }) },
  ];
  const seen = new Set([base]);
  for (const variant of variants) {
    const fingerprint = envelope(variant).fingerprint;
    assert.ok(!seen.has(fingerprint), JSON.stringify(Object.keys(variant)));
    seen.add(fingerprint);
  }
  const otherQualification = envelopeCanaryEvidenceInput({
    qualification: { buildHash: 'f'.repeat(64) },
  }).qualification;
  assert.ok(!seen.has(envelope({ qualification: otherQualification }).fingerprint));
});

void test('rejects a v1 CANARY qualification or a forged qualification', () => {
  const v1 = canaryEvidenceInput().qualification;
  assert.throws(() => envelope({ qualification: v1, validUntilMs: v1.expiresAtMs }), INVALID);
  const v2 = envelopeCanaryEvidenceInput().qualification;
  assert.throws(() => envelope({ qualification: Object.freeze({ ...v2, providerId: 'other' }) }), INVALID);
});

void test('rejects invalid caps', () => {
  assert.throws(() => envelope({ perBuyQuoteAmountRaw: 0n }), INVALID);
  assert.throws(() => envelope({ maxTotalExposureRaw: 9_999_999n }), INVALID);
  assert.throws(() => envelope({ maxBuys: 0 }), INVALID);
  assert.throws(() => envelope({ maxBuys: 1_001 }), INVALID);
  assert.doesNotThrow(() => envelope({ maxBuys: 1_000 }));
  assert.throws(() => envelope({ maxRealizedLossRaw: 0n }), INVALID);
  assert.throws(() => envelope({ maximumHoldingMs: 29_999 }), INVALID);
  assert.throws(() => envelope({ maximumHoldingMs: 900_001 }), INVALID);
});

void test('rejects a window that does not end with the qualification or that is too short', () => {
  const qualification = envelopeCanaryEvidenceInput().qualification;
  assert.throws(() => envelope({ validUntilMs: qualification.expiresAtMs - 1 }), INVALID);
  assert.throws(() => envelope({ validFromMs: qualification.expiresAtMs }), INVALID);
  assert.throws(() => envelope({ validFromMs: NOW_MS - 1 }), INVALID);
  const tooShortFrom = qualification.expiresAtMs - (120_000 + ENVELOPE_EXIT_MARGIN_MS) + 1;
  assert.throws(() => envelope({ validFromMs: tooShortFrom }), INVALID);
  assert.doesNotThrow(() => envelope({ validFromMs: tooShortFrom - 1 }));
});

void test('rejects a window starting before the qualification, which also bounds it to 24 hours', () => {
  // The explicit 24 h branch cannot be reached on its own: validFrom >= qualifiedAt and a
  // qualification TTL <= 24 h already bound the window. This input is refused by validFrom.
  const qualification = envelopeCanaryEvidenceInput().qualification;
  assert.throws(() => envelope({
    validFromMs: qualification.expiresAtMs - 86_400_001,
  }), INVALID);
});

void test('rejects policies that could block a buy before the envelope loss cap', () => {
  assert.throws(() => envelope({ policy: policy({ maximumOpenPositions: 2 }) }), INVALID);
  assert.throws(() => envelope({ policy: policy({ maximumTotalExposureBps: 501n }) }), INVALID);
  assert.throws(() => envelope({ maxRealizedLossRaw: 30_000_001n }), INVALID);
  assert.throws(() => envelope({ policy: policy({ positionSizeBps: 500n }) }), INVALID);
});

void test('rejects loss-capped reconciled capital below 20 times the per-buy amount (A17)', () => {
  // 0.01 SOL example: 230M initial - 30M loss = 200M = 20 x 10M, exactly admissible.
  // The A17 guard is redundant with evaluateBuyRisk at <= 500 bps; either rejects these inputs.
  assert.doesNotThrow(() => envelope());
  assert.throws(() => envelope({ perBuyQuoteAmountRaw: 10_000_001n }), INVALID);
  assert.throws(() => envelope({
    policy: policy({ initialCapitalLamports: 229_999_999n }),
  }), INVALID);
});

void test('rejects a policy whose quote mint allowlist is not WSOL', () => {
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  assert.throws(() => envelope({
    policy: Object.freeze({ ...policy(), quoteMintAllowlist: Object.freeze([usdc]) }),
  }), INVALID);
  assert.throws(() => envelope({
    policy: Object.freeze({ ...policy(), quoteMintAllowlist: Object.freeze([WSOL_MINT, usdc]) }),
  }), INVALID);
});

void test('rejects a policy with a forged fingerprint', () => {
  assert.throws(() => envelope({
    policy: Object.freeze({ ...policy(), policyFingerprint: 'f'.repeat(64) }),
  }), INVALID);
});

void test('exports the armament and exit margins', () => {
  assert.equal(ENVELOPE_EXIT_MARGIN_MS, 900_000);
  assert.equal(ENVELOPE_ARMAMENT_MAXIMUM_TTL_MS, 900_000);
});

function facts(overrides: Partial<EnvelopeArmingFacts> = {}): EnvelopeArmingFacts {
  return {
    envelope: envelope(), buysArmed: 0, realizedLossRaw: 0n, controlState: 'RUNNING',
    unknownBlock: false, activeArmament: false, openPosition: false, intentAvailable: true,
    runtimeLeaseMs: 40_000, nowMs: NOW_MS + 1_000, ...overrides,
  };
}

void test('arms when every envelope condition holds', () => {
  assert.deepEqual(evaluateEnvelopeArming(facts()), { kind: 'ARMABLE' });
});

void test('returns idle reasons in priority order', () => {
  const lateNow = NOW_MS + ENVELOPE_QUALIFICATION_TTL_MS - 120_000 - ENVELOPE_EXIT_MARGIN_MS + 1;
  const all: Partial<EnvelopeArmingFacts> = {
    envelope: null, controlState: 'ENTRY_STOP', unknownBlock: true, activeArmament: true,
    openPosition: true, nowMs: lateNow, buysArmed: 10, realizedLossRaw: 30_000_000n,
    runtimeLeaseMs: 135_001, intentAvailable: false,
  };
  const order: [keyof EnvelopeArmingFacts, string][] = [
    ['envelope', 'NO_ENVELOPE'], ['controlState', 'CONTROL_NOT_RUNNING'],
    ['unknownBlock', 'UNKNOWN_BLOCK'], ['activeArmament', 'ACTIVE_ARMAMENT'],
    ['openPosition', 'OPEN_POSITION'], ['nowMs', 'WINDOW_CUTOFF'], ['buysArmed', 'CAPACITY'],
    ['realizedLossRaw', 'LOSS_CAP'], ['runtimeLeaseMs', 'POLICY_FRESHNESS'],
    ['intentAvailable', 'NO_INTENT'],
  ];
  for (const [index, [key, reason]] of order.entries()) {
    const cleared = new Set(order.slice(0, index).map(([name]) => name));
    const current = Object.fromEntries(Object.entries(all)
      .filter(([name]) => !cleared.has(name as keyof EnvelopeArmingFacts)));
    assert.deepEqual(evaluateEnvelopeArming(facts(current)), { kind: 'IDLE', reason }, key);
  }
  assert.deepEqual(evaluateEnvelopeArming(facts()), { kind: 'ARMABLE' });
});

void test('cuts arming off when the window cannot hold the position until its deadline sell', () => {
  const lastArmable = NOW_MS + ENVELOPE_QUALIFICATION_TTL_MS - 120_000 - ENVELOPE_EXIT_MARGIN_MS;
  assert.deepEqual(evaluateEnvelopeArming(facts({ nowMs: lastArmable })), { kind: 'ARMABLE' });
  assert.deepEqual(evaluateEnvelopeArming(facts({ nowMs: lastArmable + 1 })),
    { kind: 'IDLE', reason: 'WINDOW_CUTOFF' });
  assert.deepEqual(evaluateEnvelopeArming(facts({ nowMs: NOW_MS - 1 })),
    { kind: 'IDLE', reason: 'WINDOW_CUTOFF' });
});

void test('applies the cumulative exposure cap and the loss cap', () => {
  const tight = envelope({ maxTotalExposureRaw: 25_000_000n });
  assert.deepEqual(evaluateEnvelopeArming(facts({ envelope: tight, buysArmed: 1 })), { kind: 'ARMABLE' });
  assert.deepEqual(evaluateEnvelopeArming(facts({ envelope: tight, buysArmed: 2 })),
    { kind: 'IDLE', reason: 'CAPACITY' });
  assert.deepEqual(evaluateEnvelopeArming(facts({ buysArmed: 9 })), { kind: 'ARMABLE' });
  assert.deepEqual(evaluateEnvelopeArming(facts({ realizedLossRaw: 29_999_999n })), { kind: 'ARMABLE' });
});

void test('requires snapshot max ages to cover two leases plus thirty seconds', () => {
  // 2 x 135 000 + 30 000 = 300 000 = both max ages.
  assert.deepEqual(evaluateEnvelopeArming(facts({ runtimeLeaseMs: 135_000 })), { kind: 'ARMABLE' });
  assert.deepEqual(evaluateEnvelopeArming(facts({ runtimeLeaseMs: 135_001 })),
    { kind: 'IDLE', reason: 'POLICY_FRESHNESS' });
  const walletShort = envelope({ policy: policy({ walletSnapshotMaxAgeMs: 109_999 }) });
  assert.deepEqual(evaluateEnvelopeArming(facts({ envelope: walletShort })),
    { kind: 'IDLE', reason: 'POLICY_FRESHNESS' });
  const providerShort = envelope({ policy: policy({ providerUsageMaxAgeMs: 109_999 }) });
  assert.deepEqual(evaluateEnvelopeArming(facts({ envelope: providerShort })),
    { kind: 'IDLE', reason: 'POLICY_FRESHNESS' });
});

void test('rejects malformed arming facts', () => {
  assert.throws(() => evaluateEnvelopeArming({ ...facts(), extra: true } as unknown as EnvelopeArmingFacts),
    INVALID);
  assert.throws(() => evaluateEnvelopeArming(facts({ buysArmed: -1 })), INVALID);
});

function latestProvider(overrides: Readonly<Record<string, unknown>> = {}) {
  return createProviderUsageSnapshot({
    providerId: 'primary', planId: 'canary-v1', billingPeriodId: 'period-1',
    billingPeriodStartedAtMs: NOW_MS - 60_000, billingPeriodEndsAtMs: NOW_MS + 3_600_000,
    limitUnits: 1_000n, usedUnits: 100n, measuredAtMs: NOW_MS, expiresAtMs: NOW_MS + 300_000,
    provenance: 'AUTHORITATIVE_PROBE', ...overrides,
  });
}

void test('carries the provider snapshot forward with local executor counters', () => {
  const latest = latestProvider();
  const next = createEnvelopeProviderSnapshot({
    latest, localUsedUnits: 25n, measuredAtMs: NOW_MS + 10_000, maximumAgeMs: 300_000,
  });
  assert.equal(next.usedUnits, 125n);
  assert.equal(next.provenance, 'EXECUTOR_COUNTERS');
  assert.equal(next.providerId, latest.providerId);
  assert.equal(next.planId, latest.planId);
  assert.equal(next.billingPeriodId, latest.billingPeriodId);
  assert.equal(next.billingPeriodStartedAtMs, latest.billingPeriodStartedAtMs);
  assert.equal(next.billingPeriodEndsAtMs, latest.billingPeriodEndsAtMs);
  assert.equal(next.limitUnits, latest.limitUnits);
  assert.equal(next.measuredAtMs, NOW_MS + 10_000);
  assert.equal(next.expiresAtMs, NOW_MS + 310_000);
  assert.deepEqual(next, createProviderUsageSnapshot({
    providerId: 'primary', planId: 'canary-v1', billingPeriodId: 'period-1',
    billingPeriodStartedAtMs: NOW_MS - 60_000, billingPeriodEndsAtMs: NOW_MS + 3_600_000,
    limitUnits: 1_000n, usedUnits: 125n, measuredAtMs: NOW_MS + 10_000,
    expiresAtMs: NOW_MS + 310_000, provenance: 'EXECUTOR_COUNTERS',
  }));
});

void test('caps the carried-forward expiry at the billing period end', () => {
  const latest = latestProvider({ billingPeriodEndsAtMs: NOW_MS + 100_000, expiresAtMs: NOW_MS + 100_000 });
  const next = createEnvelopeProviderSnapshot({
    latest, localUsedUnits: 0n, measuredAtMs: NOW_MS + 10_000, maximumAgeMs: 300_000,
  });
  assert.equal(next.expiresAtMs, NOW_MS + 100_000);
});

void test('refuses a stale, over-limit or out-of-period carry-forward', () => {
  const latest = latestProvider();
  assert.throws(() => createEnvelopeProviderSnapshot({
    latest, localUsedUnits: 0n, measuredAtMs: NOW_MS, maximumAgeMs: 300_000,
  }), INVALID);
  assert.throws(() => createEnvelopeProviderSnapshot({
    latest, localUsedUnits: 901n, measuredAtMs: NOW_MS + 1, maximumAgeMs: 300_000,
  }), INVALID);
  assert.equal(createEnvelopeProviderSnapshot({
    latest, localUsedUnits: 900n, measuredAtMs: NOW_MS + 1, maximumAgeMs: 300_000,
  }).usedUnits, 1_000n);
  assert.throws(() => createEnvelopeProviderSnapshot({
    latest, localUsedUnits: 0n, measuredAtMs: NOW_MS + 3_600_000, maximumAgeMs: 300_000,
  }), INVALID);
  assert.throws(() => createEnvelopeProviderSnapshot({
    latest: Object.freeze({ ...latest, usedUnits: 0n }), localUsedUnits: 0n,
    measuredAtMs: NOW_MS + 1, maximumAgeMs: 300_000,
  }), INVALID);
});

void test('builds a deterministic ARM CANARY authorization per envelope intent', () => {
  const env = envelope();
  const intentId = `execution_intent_${'e'.repeat(64)}`;
  const input = {
    generationId: env.generationId, operatorId: env.operatorId, envelopeId: env.envelopeId,
    intentId, contextFingerprint: 'c'.repeat(64), nowMs: NOW_MS + 5_000,
  };
  const first = createEnvelopeArmAuthorization(input);
  assert.deepEqual(createEnvelopeArmAuthorization({ ...input }), first);
  assert.equal(first.payloadVersion, 2);
  assert.equal(first.action, 'ARM');
  assert.equal(first.phase, 'CANARY');
  assert.equal(first.operatorId, OPERATOR_ID);
  assert.equal(first.issuedAtMs, NOW_MS + 5_000);
  assert.equal(first.expiresAtMs, NOW_MS + 65_000);
  assert.equal(first.nonceHash, createHash('sha256').update(JSON.stringify([
    'execution-envelope-arm-nonce-v1', env.envelopeId, intentId, NOW_MS + 5_000,
  ])).digest('hex'));
  assert.notEqual(createEnvelopeArmAuthorization({ ...input, intentId: `execution_intent_${'f'.repeat(64)}` })
    .authorizationId, first.authorizationId);
  assert.throws(() => createEnvelopeArmAuthorization({ ...input, envelopeId: 'bogus' }), INVALID);
});
