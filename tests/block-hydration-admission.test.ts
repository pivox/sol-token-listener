import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotRuntimeBlockHydrationAdmissionMetrics } from '../src/domain/block-hydration-admission.js';

const role = () => ({ grants: 0, cancellations: 0, oldestWaitMs: null, lastWaitMs: null, maximumWaitMs: null });
const input = () => ({
  version: 1, enabled: true, registeredWorkers: 2, pendingWorkers: 0,
  maximumPendingWorkers: 0, pendingClassifierGroups: 0, maximumPendingClassifierGroups: 0,
  unboundReservations: 0, activeGroups: 0, maximumAdmitted: 0,
  worker: role(), classifier: role(),
});

void test('admission evidence is a detached immutable snapshot, including role counters', () => {
  const value = input();
  const snapshot = snapshotRuntimeBlockHydrationAdmissionMetrics(value);
  assert.deepEqual(snapshot, value);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.worker));
  assert.ok(Object.isFrozen(snapshot.classifier));
  value.worker.grants = 99;
  assert.equal(snapshot.worker.grants, 0);
  assert.deepEqual(snapshotRuntimeBlockHydrationAdmissionMetrics(JSON.parse(JSON.stringify(snapshot))), snapshot);
});

void test('admission evidence rejects invalid counts, bounds and inconsistent live waits', () => {
  const invalid = [
    { ...input(), version: 2 }, { ...input(), enabled: 'true' },
    { ...input(), activeGroups: 2, maximumAdmitted: 2 },
    { ...input(), activeGroups: 1, unboundReservations: 1, maximumAdmitted: 1 },
    { ...input(), activeGroups: 1 },
    { ...input(), pendingWorkers: 3, maximumPendingWorkers: 3 },
    { ...input(), pendingWorkers: 1, maximumPendingWorkers: 1 },
    { ...input(), pendingClassifierGroups: 2, maximumPendingClassifierGroups: 2 },
    { ...input(), registeredWorkers: Number.MAX_SAFE_INTEGER + 1 },
    { ...input(), maximumPendingWorkers: 0.5 }, { ...input(), maximumPendingWorkers: -0 },
    { ...input(), worker: { ...role(), grants: 1 } },
    { ...input(), worker: { ...role(), oldestWaitMs: 1 } },
    { ...input(), worker: { ...role(), grants: 1, lastWaitMs: 5, maximumWaitMs: 4 } },
    { ...input(), worker: { ...role(), grants: 1, lastWaitMs: 1, maximumWaitMs: NaN } },
  ];
  for (const value of invalid) assert.throws(() => snapshotRuntimeBlockHydrationAdmissionMetrics(value), TypeError);
});

void test('admission evidence permits historical maxima after worker deregistration', () => {
  const value = {
    ...input(), registeredWorkers: 0, maximumPendingWorkers: 2,
    maximumPendingClassifierGroups: 1, maximumAdmitted: 1,
    worker: { ...role(), grants: 1, lastWaitMs: 0, maximumWaitMs: 20 },
  };
  assert.deepEqual(snapshotRuntimeBlockHydrationAdmissionMetrics(value), value);
});

void test('admission evidence accepts ongoing wait beyond a completed maximum', () => {
  const value = {
    ...input(), pendingWorkers: 1, maximumPendingWorkers: 1,
    worker: { ...role(), cancellations: 1, oldestWaitMs: 20, lastWaitMs: 0, maximumWaitMs: 5 },
  };
  assert.deepEqual(snapshotRuntimeBlockHydrationAdmissionMetrics(value), value);
});

void test('admission evidence rejects getters, proxies and extra fields without reading them', () => {
  let touched = false;
  const getter = input();
  Object.defineProperty(getter, 'worker', { enumerable: true, get() { touched = true; return role(); } });
  const proxy = new Proxy(input(), { get() { touched = true; throw new Error('secret'); } });
  const symbol = { ...input(), [Symbol('secret')]: 'private' };
  for (const value of [getter, proxy, symbol, { ...input(), endpoint: 'secret' },
    { ...input(), worker: { ...role(), endpoint: 'secret' } }, null, []]) {
    assert.throws(() => snapshotRuntimeBlockHydrationAdmissionMetrics(value), TypeError);
  }
  assert.equal(touched, false);
});
