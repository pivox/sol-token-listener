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
    response: validLegacyResponse(), measuredAtMs: MEASURED_AT_MS, ttlMs: 300_000,
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

void test('maps the current Helius contract with a null billing cycle to the canonical snapshot', () => {
  const legacy = createUsage(validLegacyResponse());
  const current = createUsage(validCurrentResponse());
  assert.deepEqual(current, legacy);
  assert.equal(current.snapshot.limitUnits, 550_000n);
  assert.equal(current.snapshot.usedUnits, 12_500n);
});

void test('uses current creditCycle when the informational billing cycle is a different object', () => {
  const response = validCurrentResponse();
  const subscription = response.subscriptionDetails as Readonly<Record<string, unknown>>;
  const current = createUsage(Object.freeze({
    ...response,
    subscriptionDetails: Object.freeze({
      ...subscription,
      billingCycle: Object.freeze({ start: '2026-08-01', end: '2026-09-01' }),
    }),
  }));
  assert.deepEqual(current, createUsage(validCurrentResponse()));
  assert.equal(current.snapshot.billingPeriodStartedAtMs, Date.parse('2026-09-01T00:00:00.000Z'));
  assert.equal(current.snapshot.billingPeriodEndsAtMs, Date.parse('2026-10-01T00:00:00.000Z'));
});

void test('rejects hybrid and partial Helius response contracts', () => {
  const current = validCurrentResponse();
  for (const response of [
    { ...current, usage: validLegacyResponse().usage },
    withoutKey(current, 'dataTransfer'),
    { ...current, futureTopLevelField: 0 },
  ]) assert.throws(() => createUsage(response), HeliusProviderUsageValidationError);
});

void test('rejects missing and unknown current nested keys', () => {
  const current = validCurrentResponse();
  const credits = current.credits as Readonly<Record<string, unknown>>;
  const requests = current.requests as Readonly<Record<string, unknown>>;
  const dataTransfer = current.dataTransfer as Readonly<Record<string, unknown>>;
  const subscription = current.subscriptionDetails as Readonly<Record<string, unknown>>;
  for (const response of [
    { ...current, credits: withoutKey(credits, 'other') },
    { ...current, credits: { ...credits, futureProduct: 0 } },
    { ...current, requests: withoutKey(requests, 'photon') },
    { ...current, requests: { ...requests, futureProduct: 0 } },
    { ...current, dataTransfer: withoutKey(dataTransfer, 'laserstreamGrpc') },
    { ...current, dataTransfer: { ...dataTransfer, futureTransport: 0 } },
    { ...current, subscriptionDetails: withoutKey(subscription, 'creditsLimit') },
    { ...current, subscriptionDetails: { ...subscription, futureDetail: 0 } },
  ]) assert.throws(() => createUsage(response), HeliusProviderUsageValidationError);
});

void test('rejects unsafe current-contract product counters without reconciling breakdown totals', () => {
  const current = validCurrentResponse();
  const credits = current.credits as Readonly<Record<string, unknown>>;
  const requests = current.requests as Readonly<Record<string, unknown>>;
  const dataTransfer = current.dataTransfer as Readonly<Record<string, unknown>>;
  for (const response of [
    { ...current, credits: { ...credits, rpc: Number.MAX_SAFE_INTEGER + 1 } },
    { ...current, requests: { ...requests, enhancedApi: -1 } },
    { ...current, dataTransfer: { ...dataTransfer, laserstreamWebsocket: 1.5 } },
  ]) assert.throws(() => createUsage(response), HeliusProviderUsageValidationError);
  assert.doesNotThrow(() => createUsage(current));
});

void test('rejects an unsafe value in every current-contract breakdown counter', () => {
  const current = validCurrentResponse();
  for (const breakdown of ['credits', 'requests', 'dataTransfer'] as const) {
    const counters = current[breakdown] as Readonly<Record<string, unknown>>;
    for (const key of Object.keys(counters)) {
      assert.throws(() => createUsage(Object.freeze({
        ...current,
        [breakdown]: Object.freeze({ ...counters, [key]: Number.MAX_SAFE_INTEGER + 1 }),
      })), HeliusProviderUsageValidationError, `${breakdown}.${key}`);
    }
  }
});

void test('rejects invalid authoritative and informational current cycles', () => {
  const current = validCurrentResponse();
  const subscription = current.subscriptionDetails as Readonly<Record<string, unknown>>;
  for (const response of [
    { ...current, creditCycle: { start: '2026-09-01' } },
    { ...current, creditCycle: { start: '2026-09-01', end: '2026-09-01' } },
    { ...current, creditCycle: { start: '2026-09-31', end: '2026-10-01' } },
    { ...current, subscriptionDetails: {
      ...subscription, billingCycle: { start: '2026-09-01' },
    } },
    { ...current, subscriptionDetails: {
      ...subscription, billingCycle: { start: '2026-10-01', end: '2026-09-01' },
    } },
  ]) assert.throws(() => createUsage(response), HeliusProviderUsageValidationError);
});

void test('fails closed on schema drift, invalid dates and unsafe credit values', () => {
  const base = validLegacyResponse();
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
    response: validLegacyResponse(), measuredAtMs: Date.parse('2026-09-30T23:59:31.000Z'),
    ttlMs: 300_000,
  })), HeliusProviderUsageValidationError);
});

function createUsage(response: Readonly<Record<string, unknown>>) {
  return createHeliusProviderUsage(Object.freeze({
    providerId: 'helius-primary', projectId: PROJECT_ID,
    response, measuredAtMs: MEASURED_AT_MS, ttlMs: 300_000,
  }));
}

function validLegacyResponse(): Readonly<Record<string, unknown>> {
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

function validCurrentResponse(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    creditCycle: Object.freeze({ start: '2026-09-01', end: '2026-10-01' }),
    credits: Object.freeze({
      rpc: 1, enhancedApi: 2, walletApi: 3, das: 4, webhooks: 5,
      laserstreamGrpc: 6, laserstreamWebsocket: 7, preConfirmations: 8,
      preprocessedTransactions: 9, archival: 10, photon: 11, other: 12,
    }),
    creditsRemaining: 487_500,
    creditsUsed: 12_500,
    dataTransfer: Object.freeze({ laserstreamGrpc: 13, laserstreamWebsocket: 14 }),
    prepaidCreditsRemaining: 50_000,
    prepaidCreditsUsed: 0,
    requests: Object.freeze({
      rpc: 15, enhancedApi: 16, walletApi: 17, das: 18, webhooks: 19,
      preConfirmations: 20, preprocessedTransactions: 21, archival: 22,
      photon: 23, other: 24,
    }),
    subscriptionDetails: Object.freeze({
      billingCycle: null,
      creditsLimit: 500_000,
      plan: 'business',
    }),
  });
}

function withoutKey(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}
