import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHeliusProviderUsage,
  HeliusProviderUsageValidationError,
} from '../src/domain/helius-provider-evidence.js';

const PROJECT_ID = 'a1b2c3d4-e5f6-4890-abcd-ef1234567890';
const MEASURED_AT_MS = Date.parse('2026-09-05T12:00:00.000Z');

void test('maps Helius credits to one canonical integer provider snapshot', () => {
  const result = createHeliusProviderUsage(Object.freeze({
    providerId: 'helius-primary', projectId: PROJECT_ID,
    response: validResponse(), measuredAtMs: MEASURED_AT_MS, ttlMs: 300_000,
  }));
  assert.equal(result.snapshot.providerId, 'helius-primary');
  assert.equal(result.snapshot.planId, 'business');
  assert.equal(result.snapshot.limitUnits, 550_000n);
  assert.equal(result.snapshot.usedUnits, 12_500n);
  assert.equal(result.snapshot.provenance, 'AUTHORITATIVE_PROBE');
  assert.equal(result.snapshot.measuredAtMs, MEASURED_AT_MS);
  assert.equal(result.snapshot.expiresAtMs, MEASURED_AT_MS + 300_000);
  assert.match(result.projectFingerprint, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(result.snapshot.billingPeriodId, new RegExp(PROJECT_ID, 'u'));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.snapshot));
});

void test('fails closed on schema drift, invalid dates and unsafe credit values', () => {
  const base = validResponse();
  const subscription = base.subscriptionDetails as Readonly<Record<string, unknown>>;
  const usage = base.usage as Readonly<Record<string, unknown>>;
  for (const response of [
    { ...base, extra: true },
    { ...base, creditsUsed: 1.5 },
    { ...base, creditsRemaining: -1 },
    { ...base, creditsUsed: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, subscriptionDetails: {
      ...subscription,
      billingCycle: { start: '2026-09-01', end: '2026-09-01' },
    } },
    { ...base, usage: { ...usage, futureProduct: 1 } },
  ]) assert.throws(() => createHeliusProviderUsage(Object.freeze({
    providerId: 'helius-primary', projectId: PROJECT_ID,
    response, measuredAtMs: MEASURED_AT_MS, ttlMs: 300_000,
  })), HeliusProviderUsageValidationError);
});

void test('refuses evidence with less than thirty seconds before billing rollover', () => {
  assert.throws(() => createHeliusProviderUsage(Object.freeze({
    providerId: 'helius-primary', projectId: PROJECT_ID,
    response: validResponse(), measuredAtMs: Date.parse('2026-09-30T23:59:31.000Z'),
    ttlMs: 300_000,
  })), HeliusProviderUsageValidationError);
});

function validResponse(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    creditsRemaining: 487_500,
    creditsUsed: 12_500,
    prepaidCreditsRemaining: 50_000,
    prepaidCreditsUsed: 0,
    subscriptionDetails: Object.freeze({
      billingCycle: Object.freeze({ start: '2026-09-01', end: '2026-10-01' }),
      creditsLimit: 500_000,
      plan: 'business',
    }),
    usage: Object.freeze({
      api: 1_200, archival: 0, das: 5_000, grpc: 300, grpcGeyser: 0,
      photon: 0, rpc: 4_500, stream: 100, webhook: 800, websocket: 600,
    }),
  });
}
