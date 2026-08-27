import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProviderUsageSnapshot,
  type ProviderUsageSnapshotInput,
} from '../src/ports/provider-usage-probe.js';
import { UnavailableProviderUsageProbe } from '../src/application/unavailable-provider-usage.probe.js';

const MAX_CREDITS = 10n ** 78n - 1n;

void test('creates immutable available authoritative usage evidence', () => {
  const snapshot = createProviderUsageSnapshot({
    status: 'AVAILABLE', creditsUsedStart: 100n, creditsUsedEnd: 125n, rateLimitedCount: 2,
  });

  assert.deepEqual(snapshot, {
    status: 'AVAILABLE', creditsUsedStart: 100n, creditsUsedEnd: 125n, rateLimitedCount: 2,
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'creditsUsedEnd', 'creditsUsedStart', 'rateLimitedCount', 'status',
  ]);
  assert.throws(() => {
    (snapshot as { rateLimitedCount: number }).rateLimitedCount = 3;
  }, TypeError);
});

void test('accepts exact NUMERIC(78,0) provider credit counter bounds', () => {
  const snapshot = createProviderUsageSnapshot({
    status: 'AVAILABLE', creditsUsedStart: MAX_CREDITS, creditsUsedEnd: MAX_CREDITS,
    rateLimitedCount: 0,
  });

  assert.equal(snapshot.creditsUsedStart, MAX_CREDITS);
  assert.equal(snapshot.creditsUsedEnd, MAX_CREDITS);
});

void test('accepts the exact bounded provider rate-limit counter maximum', () => {
  const snapshot = createProviderUsageSnapshot({
    status: 'AVAILABLE', creditsUsedStart: 100n, creditsUsedEnd: 125n,
    rateLimitedCount: 1_000_000,
  });

  assert.equal(snapshot.rateLimitedCount, 1_000_000);
});

void test('creates immutable unavailable evidence without fabricated credit usage', () => {
  const snapshot = createProviderUsageSnapshot({
    status: 'UNAVAILABLE', creditsUsedStart: null, creditsUsedEnd: null, rateLimitedCount: 0,
  });

  assert.deepEqual(snapshot, {
    status: 'UNAVAILABLE', creditsUsedStart: null, creditsUsedEnd: null, rateLimitedCount: 0,
  });
  assert.equal(Object.isFrozen(snapshot), true);
});

void test('rejects malformed provider usage evidence at the port boundary', () => {
  const malformed: readonly unknown[] = [
    { status: 'AVAILABLE', creditsUsedStart: -1n, creditsUsedEnd: 0n, rateLimitedCount: 0 },
    { status: 'AVAILABLE', creditsUsedStart: 2n, creditsUsedEnd: 1n, rateLimitedCount: 0 },
    {
      status: 'AVAILABLE', creditsUsedStart: MAX_CREDITS + 1n,
      creditsUsedEnd: MAX_CREDITS + 1n, rateLimitedCount: 0,
    },
    {
      status: 'AVAILABLE', creditsUsedStart: 0n,
      creditsUsedEnd: MAX_CREDITS + 1n, rateLimitedCount: 0,
    },
    { status: 'AVAILABLE', creditsUsedStart: 0n, creditsUsedEnd: 1n, rateLimitedCount: -1 },
    { status: 'AVAILABLE', creditsUsedStart: 0n, creditsUsedEnd: 1n, rateLimitedCount: 0.5 },
    { status: 'AVAILABLE', creditsUsedStart: 0n, creditsUsedEnd: 1n, rateLimitedCount: 1_000_001 },
    {
      status: 'AVAILABLE', creditsUsedStart: 0n, creditsUsedEnd: 1n,
      rateLimitedCount: Number.MAX_SAFE_INTEGER,
    },
    { status: 'UNAVAILABLE', creditsUsedStart: 0n, creditsUsedEnd: null, rateLimitedCount: 0 },
    { status: 'UNAVAILABLE', creditsUsedStart: null, creditsUsedEnd: null, rateLimitedCount: 0, apiKey: 'secret' },
  ];

  for (const evidence of malformed) {
    assert.throws(() => createProviderUsageSnapshot(evidence as ProviderUsageSnapshotInput), /invalid/iu);
  }
});

void test('rejects accessor evidence without invoking or leaking the getter', () => {
  let getterReads = 0;
  const evidence = availableEvidence();
  Object.defineProperty(evidence, 'creditsUsedStart', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      throw new Error('provider-accessor-secret');
    },
  });

  assertSafeInvalid(evidence);
  assert.equal(getterReads, 0);
});

void test('contains hostile proxy traps behind the canonical safe error', () => {
  let trapCalls = 0;
  const evidence = new Proxy(availableEvidence(), {
    ownKeys() {
      trapCalls += 1;
      throw new Error('provider-own-keys-secret');
    },
    getOwnPropertyDescriptor() {
      trapCalls += 1;
      throw new Error('provider-descriptor-secret');
    },
    get() {
      trapCalls += 1;
      throw new Error('provider-get-secret');
    },
  });

  assertSafeInvalid(evidence);
  assert.equal(trapCalls, 0);
});

void test('rejects inherited, hidden, symbolic, array and noncanonical descriptor evidence', () => {
  const inherited = Object.assign(Object.create({ status: 'AVAILABLE' }) as Record<string, unknown>, {
    creditsUsedStart: 0n, creditsUsedEnd: 1n, rateLimitedCount: 0,
  });
  const hidden = availableEvidence();
  Object.defineProperty(hidden, 'apiKey', { value: 'hidden-provider-secret' });
  const symbolic = availableEvidence();
  Object.defineProperty(symbolic, Symbol('provider-secret'), { value: 'symbolic-provider-secret' });
  const array = Object.assign([], availableEvidence());
  const noncanonicalDescriptor = availableEvidence();
  Object.defineProperty(noncanonicalDescriptor, 'status', {
    value: 'AVAILABLE', enumerable: true, writable: false, configurable: true,
  });

  for (const evidence of [inherited, hidden, symbolic, array, noncanonicalDescriptor]) {
    assertSafeInvalid(evidence);
  }
});

void test('returns a stable, fail-closed unavailable probe snapshot', async () => {
  const probe = new UnavailableProviderUsageProbe();

  const first = await probe.snapshot();
  const second = await probe.snapshot();

  assert.equal(probe.identity, 'provider-usage:unavailable:v1');
  assert.deepEqual(first, {
    status: 'UNAVAILABLE', creditsUsedStart: null, creditsUsedEnd: null, rateLimitedCount: 0,
  });
  assert.notStrictEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(Object.keys(first).sort(), [
    'creditsUsedEnd', 'creditsUsedStart', 'rateLimitedCount', 'status',
  ]);
});

function availableEvidence(): Record<string, unknown> {
  return {
    status: 'AVAILABLE', creditsUsedStart: 0n, creditsUsedEnd: 1n, rateLimitedCount: 0,
  };
}

function assertSafeInvalid(evidence: unknown): void {
  let caught: unknown;
  try {
    createProviderUsageSnapshot(evidence as ProviderUsageSnapshotInput);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof TypeError);
  assert.equal(caught.message, 'Provider usage snapshot is invalid.');
  assert.equal(Object.hasOwn(caught, 'cause'), false);
}
