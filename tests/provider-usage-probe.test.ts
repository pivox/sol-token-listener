import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProviderUsageSnapshot,
  type ProviderUsageSnapshotInput,
} from '../src/ports/provider-usage-probe.js';
import { UnavailableProviderUsageProbe } from '../src/application/unavailable-provider-usage.probe.js';

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
    { status: 'AVAILABLE', creditsUsedStart: 0n, creditsUsedEnd: 1n, rateLimitedCount: -1 },
    { status: 'AVAILABLE', creditsUsedStart: 0n, creditsUsedEnd: 1n, rateLimitedCount: 0.5 },
    { status: 'UNAVAILABLE', creditsUsedStart: 0n, creditsUsedEnd: null, rateLimitedCount: 0 },
    { status: 'UNAVAILABLE', creditsUsedStart: null, creditsUsedEnd: null, rateLimitedCount: 0, apiKey: 'secret' },
  ];

  for (const evidence of malformed) {
    assert.throws(() => createProviderUsageSnapshot(evidence as ProviderUsageSnapshotInput), /invalid/iu);
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
