import assert from 'node:assert/strict';
import test from 'node:test';
import * as domain from '../src/domain/two-group-hydration-evidence.js';
import { stoppedTwoGroupHydrationEvidenceFixture, twoGroupHydrationEvidenceFixture } from './helpers/two-group-hydration-evidence-fixture.js';

const invalidEvidence = { name: 'TypeError', message: 'Two-group hydration evidence is invalid.' };
const snapshots = [
  ['blockHydration', domain.snapshotRuntimeBlockHydrationMetricsV2],
  ['blockHydrationAdmission', domain.snapshotRuntimeBlockHydrationAdmissionMetricsV2],
  ['ordinaryRpcBudget', domain.snapshotRuntimeOrdinaryRpcBudgetMetricsV2],
  ['blockResponseMemory', domain.snapshotRuntimeBlockResponseMemoryMetricsV2],
] as const;

void test('V2 bundle snapshots all four sidecars atomically without provenance', () => {
  assert.equal(typeof domain.snapshotRuntimeTwoGroupHydrationEvidenceV2, 'function');
  const value = twoGroupHydrationEvidenceFixture();
  const snapshot = domain.snapshotRuntimeTwoGroupHydrationEvidenceV2(JSON.parse(JSON.stringify(value)));
  assert.deepEqual(snapshot, value); assert.ok(Object.isFrozen(snapshot));
  for (const name of Object.keys(value)) {
    const partial: Record<string, unknown> = { ...value }; Reflect.deleteProperty(partial, name);
    assert.throws(() => domain.snapshotRuntimeTwoGroupHydrationEvidenceV2(partial), invalidEvidence);
    assert.throws(() => domain.snapshotRuntimeTwoGroupHydrationEvidenceV2({ ...value, [name]: undefined }), invalidEvidence);
    const sidecar = value[name as keyof typeof value];
    assert.throws(() => domain.snapshotRuntimeTwoGroupHydrationEvidenceV2({ ...value, [name]: { ...sidecar, version: 1 } }), invalidEvidence);
  }
  assert.throws(() => domain.snapshotRuntimeTwoGroupHydrationEvidenceV2({ ...value, provider: 'private' }), invalidEvidence);
  value.blockHydration.queueDelayMs.last = 5;
  assert.equal(snapshot.blockHydration.queueDelayMs.last, null);
});

void test('bundle rejects hostile original descriptors without evaluating caller graphs', () => {
  const value = twoGroupHydrationEvidenceFixture();
  let calls = 0;
  const hostile = () => { calls++; throw new Error('private bundle input'); };
  const proxy = new Proxy(value, { getPrototypeOf: hostile, ownKeys: hostile, get: hostile });
  for (const bad of [proxy, null, [], { ...value, [Symbol('private')]: 1 }]) {
    assert.throws(() => domain.snapshotRuntimeTwoGroupHydrationEvidenceV2(bad), invalidEvidence);
  }
  for (const name of Object.keys(value)) {
    const accessor = { ...value }; Object.defineProperty(accessor, name, { enumerable: true, get: hostile });
    assert.throws(() => domain.snapshotRuntimeTwoGroupHydrationEvidenceV2(accessor), invalidEvidence);
    const hidden = { ...value }; Object.defineProperty(hidden, name, { enumerable: false });
    assert.throws(() => domain.snapshotRuntimeTwoGroupHydrationEvidenceV2(hidden), invalidEvidence);
  }
  assert.equal(calls, 0);
});

void test('cache pacing and admission populations remain independent', () => {
  assert.equal(typeof domain.snapshotRuntimeTwoGroupHydrationEvidenceV2, 'function');
  const value = twoGroupHydrationEvidenceFixture();
  value.blockHydration.queuedGroups = 1; value.blockHydration.maximumQueuedGroups = 1;
  value.blockHydration.queuedFetches = 1; value.blockHydration.maximumQueuedFetches = 1;
  value.blockHydrationAdmission.activeGroups = 1; value.blockHydrationAdmission.maximumAdmitted = 1;
  const snapshot = domain.snapshotRuntimeTwoGroupHydrationEvidenceV2(value);
  assert.equal(snapshot.blockHydrationAdmission.pendingClassifierGroups, 0);
  assert.equal(snapshot.blockHydration.queuedGroups, 1);
  assert.equal(snapshot.blockHydration.activeGroups, 0);
  assert.equal(snapshot.blockHydrationAdmission.activeGroups, 1);
  value.blockHydrationAdmission.activeGroups = 0;
  value.blockHydration.activeGroups = 2; value.blockHydration.maximumActiveGroups = 2;
  value.blockHydrationAdmission.pendingClassifierGroups = 2;
  value.blockHydrationAdmission.maximumPendingClassifierGroups = 2;
  value.blockHydrationAdmission.classifier.oldestWaitMs = 1;
  assert.doesNotThrow(() => domain.snapshotRuntimeTwoGroupHydrationEvidenceV2(value));
});

void test('lifecycle requires one worker only while RUNNING', () => {
  assert.equal(typeof domain.assertTwoGroupHydrationEvidenceForState, 'function');
  const value = twoGroupHydrationEvidenceFixture();
  assert.doesNotThrow(() => { domain.assertTwoGroupHydrationEvidenceForState(domain.snapshotRuntimeTwoGroupHydrationEvidenceV2(value), 'RUNNING'); });
  value.blockHydrationAdmission.registeredWorkers = 0;
  const snapshot = domain.snapshotRuntimeTwoGroupHydrationEvidenceV2(value);
  assert.throws(() => { domain.assertTwoGroupHydrationEvidenceForState(snapshot, 'RUNNING'); }, invalidEvidence);
  assert.doesNotThrow(() => { domain.assertTwoGroupHydrationEvidenceForState(snapshot, 'OTHER'); });
  assert.throws(() => {
    domain.assertTwoGroupHydrationEvidenceForState({ ...snapshot,
      ordinaryRpcBudget: { ...snapshot.ordinaryRpcBudget, startsInWindow: 9 } }, 'OTHER');
  }, invalidEvidence);
});

void test('STOPPED preserves rolling starts, completed counters and historical maxima', () => {
  assert.equal(typeof domain.assertTwoGroupHydrationEvidenceForState, 'function');
  const value = stoppedTwoGroupHydrationEvidenceFixture();
  value.ordinaryRpcBudget.startsInWindow = 8; value.ordinaryRpcBudget.maximumStartsInWindow = 8;
  value.ordinaryRpcBudget.maximumQueuedWaiters = 64; value.ordinaryRpcBudget.localRejections = 1;
  value.blockHydration.maximumActiveGroups = 2; value.blockHydration.maximumQueuedGroups = 2;
  value.blockHydration.maximumInFlightFetches = 2; value.blockHydration.maximumQueuedFetches = 2;
  value.blockHydration.maximumUnsettledAfterCancel = 2; value.blockHydration.fetches = 20;
  value.blockHydrationAdmission.maximumPendingWorkers = 1;
  value.blockHydrationAdmission.maximumPendingClassifierGroups = 2; value.blockHydrationAdmission.maximumAdmitted = 2;
  value.blockResponseMemory.maximumInFlightBytes = 67_108_864; value.blockResponseMemory.oversizedResponses = 1;
  for (const registeredWorkers of [0, 1]) {
    value.blockHydrationAdmission.registeredWorkers = registeredWorkers;
    const snapshot = domain.snapshotRuntimeTwoGroupHydrationEvidenceV2(value);
    assert.doesNotThrow(() => { domain.assertTwoGroupHydrationEvidenceForState(snapshot, 'STOPPED'); });
    assert.deepEqual(snapshot, value);
  }
  for (const name of ['activeGroups', 'queuedGroups', 'inFlightFetches', 'queuedFetches',
    'unsettledAfterCancel', 'retainedEntries', 'retainedBytes'] as const) {
    const snapshot = domain.snapshotRuntimeTwoGroupHydrationEvidenceV2({ ...value, blockHydration: { ...value.blockHydration, [name]: 1 } });
    assert.throws(() => { domain.assertTwoGroupHydrationEvidenceForState(snapshot, 'STOPPED'); }, invalidEvidence);
    assert.doesNotThrow(() => { domain.assertTwoGroupHydrationEvidenceForState(snapshot, 'OTHER'); });
  }
  for (const name of ['pendingWorkers', 'pendingClassifierGroups', 'unboundReservations', 'activeGroups'] as const) {
    const admission = { ...value.blockHydrationAdmission, [name]: 1,
      worker: { ...value.blockHydrationAdmission.worker, oldestWaitMs: name === 'pendingWorkers' ? 0 : null },
      classifier: { ...value.blockHydrationAdmission.classifier, oldestWaitMs: name === 'pendingClassifierGroups' ? 0 : null } };
    const snapshot = domain.snapshotRuntimeTwoGroupHydrationEvidenceV2({ ...value, blockHydrationAdmission: admission });
    assert.throws(() => { domain.assertTwoGroupHydrationEvidenceForState(snapshot, 'STOPPED'); }, invalidEvidence);
  }
  for (const change of [{ queuedWaiters: 1 }, { closed: false }]) {
    const snapshot = domain.snapshotRuntimeTwoGroupHydrationEvidenceV2({ ...value, ordinaryRpcBudget: { ...value.ordinaryRpcBudget, ...change } });
    assert.throws(() => { domain.assertTwoGroupHydrationEvidenceForState(snapshot, 'STOPPED'); }, invalidEvidence);
  }
  for (const name of ['activeBodies', 'inFlightBytes'] as const) {
    const snapshot = domain.snapshotRuntimeTwoGroupHydrationEvidenceV2({ ...value, blockResponseMemory: { ...value.blockResponseMemory, [name]: 1 } });
    assert.throws(() => { domain.assertTwoGroupHydrationEvidenceForState(snapshot, 'STOPPED'); }, invalidEvidence);
  }
});

for (const [key, snapshot] of snapshots) {
  void test(`${key} rejects hostile and non-exact records without evaluating input`, () => {
    const value = twoGroupHydrationEvidenceFixture()[key];
    let calls = 0;
    const hostile = () => { calls++; throw new Error('private URL/signature must not leak'); };
    const proxy = new Proxy(value, { getPrototypeOf: hostile, ownKeys: hostile, get: hostile,
      getOwnPropertyDescriptor: hostile });
    const revoked = Proxy.revocable(value, {}); revoked.revoke();
    class CustomRecord { readonly version = 2; }
    for (const input of [proxy, revoked.proxy, [], null, new CustomRecord(),
      { ...value, url: 'private' }, { ...value, signature: 'private' },
      { ...value, [Symbol('private')]: 'private' }]) assert.throws(() => snapshot(input), invalidEvidence);
    for (const name of Object.keys(value)) {
      const accessor = { ...value };
      Object.defineProperty(accessor, name, { enumerable: true, get: hostile });
      assert.throws(() => snapshot(accessor), invalidEvidence);
      const missing: Record<string, unknown> = { ...value }; Reflect.deleteProperty(missing, name);
      assert.throws(() => snapshot(missing), invalidEvidence);
      assert.throws(() => snapshot({ ...value, [name]: undefined }), invalidEvidence);
      const hidden = { ...value }; Object.defineProperty(hidden, name, { enumerable: false });
      assert.throws(() => snapshot(hidden), invalidEvidence);
      const field = Object.getOwnPropertyDescriptor(value, name)?.value as unknown;
      if (typeof field === 'number' && name !== 'version' && name !== 'configuredGroups'
        && name !== 'windowMs' && name !== 'maxAttemptsPerWindow' && name !== 'maxWaiters'
        && name !== 'perResponseLimitBytes' && name !== 'totalInFlightLimitBytes') {
        for (const bad of [-0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0']) {
          assert.throws(() => snapshot({ ...value, [name]: bad }), invalidEvidence);
        }
      }
    }
    for (const name of ['version', 'enabled', 'configuredGroups']) {
      if (Object.hasOwn(value, name)) assert.throws(() => snapshot({ ...value, [name]: 1 }), invalidEvidence);
    }
    assert.equal(calls, 0);
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, value);
    assert.deepEqual(snapshot(nullPrototype), snapshot(value));
    const result = snapshot(JSON.parse(JSON.stringify(value)));
    assert.deepEqual(result, value); assert.ok(Object.isFrozen(result));
    assert.notEqual(result, value);
  });
}

void test('nested roles and delays reject hostile descriptors before invoking them', () => {
  const evidence = twoGroupHydrationEvidenceFixture();
  let calls = 0;
  const hostile = () => { calls++; throw new Error('private nested input'); };
  const nested = [
    [evidence.blockHydration, 'queueDelayMs', evidence.blockHydration.queueDelayMs, domain.snapshotRuntimeBlockHydrationMetricsV2],
    [evidence.blockHydrationAdmission, 'worker', evidence.blockHydrationAdmission.worker, domain.snapshotRuntimeBlockHydrationAdmissionMetricsV2],
    [evidence.blockHydrationAdmission, 'classifier', evidence.blockHydrationAdmission.classifier, domain.snapshotRuntimeBlockHydrationAdmissionMetricsV2],
  ] as const;
  for (const [parent, name, value, snapshot] of nested) {
    for (const field of Object.keys(value)) {
      const accessor = { ...value }; Object.defineProperty(accessor, field, { enumerable: true, get: hostile });
      assert.throws(() => snapshot({ ...parent, [name]: accessor }), invalidEvidence);
      assert.throws(() => snapshot({ ...parent, [name]: { ...value, [field]: -0 } }), invalidEvidence);
    }
    for (const bad of [new Proxy(value, { getPrototypeOf: hostile, ownKeys: hostile }),
      { ...value, [Symbol('private')]: 1 }, { ...value, url: 'private' }]) {
      assert.throws(() => snapshot({ ...parent, [name]: bad }), invalidEvidence);
    }
  }
  assert.equal(calls, 0);
});

void test('V2 budget snapshots detach exact observation data', () => {
  const value = twoGroupHydrationEvidenceFixture().ordinaryRpcBudget;
  value.localRejections = 1;
  const snapshot = domain.snapshotRuntimeOrdinaryRpcBudgetMetricsV2(value);
  value.localRejections = 9;
  assert.equal(snapshot.localRejections, 1);
  assert.ok(Object.isFrozen(snapshot));
  assert.deepEqual(domain.snapshotRuntimeOrdinaryRpcBudgetMetricsV2(JSON.parse(JSON.stringify(snapshot))), snapshot);
  for (const startsInWindow of [-0, -1, 0.5, NaN, Infinity, 9, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => domain.snapshotRuntimeOrdinaryRpcBudgetMetricsV2({ ...snapshot, startsInWindow }), TypeError);
  }
  assert.doesNotThrow(() => domain.snapshotRuntimeOrdinaryRpcBudgetMetricsV2({ ...snapshot,
    startsInWindow: 8, maximumStartsInWindow: 8, queuedWaiters: 64, maximumQueuedWaiters: 64 }));
  for (const change of [{ startsInWindow: 1 }, { maximumStartsInWindow: 9 }, { queuedWaiters: 1 },
    { queuedWaiters: 65, maximumQueuedWaiters: 65 }, { maximumQueuedWaiters: 65 },
    { windowMs: 999 }, { maxAttemptsPerWindow: 10 }, { maxWaiters: 65 }, { closed: 0 }]) {
    assert.throws(() => domain.snapshotRuntimeOrdinaryRpcBudgetMetricsV2({ ...snapshot, ...change }), invalidEvidence);
  }
});

void test('V2 admission counts reservations and groups together', () => {
  assert.equal(typeof domain.snapshotRuntimeBlockHydrationAdmissionMetricsV2, 'function');
  const value = twoGroupHydrationEvidenceFixture().blockHydrationAdmission;
  value.activeGroups = 1; value.unboundReservations = 1; value.maximumAdmitted = 2;
  assert.doesNotThrow(() => domain.snapshotRuntimeBlockHydrationAdmissionMetricsV2(value));
  for (const change of [{ activeGroups: 2 }, { registeredWorkers: 2 }, { maximumPendingWorkers: 2 },
    { pendingWorkers: 1 }, { pendingClassifierGroups: 1 }, { maximumPendingClassifierGroups: 3 },
    { maximumAdmitted: 3 }, { registeredWorkers: 0, pendingWorkers: 1, maximumPendingWorkers: 1 }]) {
    assert.throws(() => domain.snapshotRuntimeBlockHydrationAdmissionMetricsV2({ ...value, ...change }), TypeError);
  }
});

void test('V2 admission preserves exact V1 role wait semantics in detached roles', () => {
  assert.equal(typeof domain.snapshotRuntimeBlockHydrationAdmissionMetricsV2, 'function');
  const value = twoGroupHydrationEvidenceFixture().blockHydrationAdmission;
  value.pendingWorkers = 1; value.maximumPendingWorkers = 1;
  value.pendingClassifierGroups = 2; value.maximumPendingClassifierGroups = 2;
  value.worker = { grants: 1, cancellations: 0, oldestWaitMs: 20, lastWaitMs: 1, maximumWaitMs: 2 };
  value.classifier.oldestWaitMs = 0;
  const snapshot = domain.snapshotRuntimeBlockHydrationAdmissionMetricsV2(value);
  value.worker.maximumWaitMs = 9;
  assert.equal(snapshot.worker.maximumWaitMs, 2);
  assert.ok(Object.isFrozen(snapshot.worker)); assert.ok(Object.isFrozen(snapshot.classifier));
  for (const worker of [{ ...value.worker, oldestWaitMs: null }, { ...value.worker, lastWaitMs: null },
    { ...value.worker, grants: 0 }, { ...value.worker, lastWaitMs: 10 },
    { ...value.worker, cancellations: -0 }]) {
    assert.throws(() => domain.snapshotRuntimeBlockHydrationAdmissionMetricsV2({ ...value, worker }), TypeError);
  }
});

void test('V2 hydration enforces independent bounded pairs and detaches queue delays', () => {
  assert.equal(typeof domain.snapshotRuntimeBlockHydrationMetricsV2, 'function');
  const value = twoGroupHydrationEvidenceFixture().blockHydration;
  const pairs = [ ['activeGroups', 'maximumActiveGroups', 2], ['queuedGroups', 'maximumQueuedGroups', 2],
    ['inFlightFetches', 'maximumInFlightFetches', 2], ['queuedFetches', 'maximumQueuedFetches', 2],
    ['unsettledAfterCancel', 'maximumUnsettledAfterCancel', 2] ] as const;
  for (const [current, maximum, limit] of pairs) {
    assert.doesNotThrow(() => domain.snapshotRuntimeBlockHydrationMetricsV2({ ...value, [current]: limit, [maximum]: limit }));
    assert.throws(() => domain.snapshotRuntimeBlockHydrationMetricsV2({ ...value, [current]: limit + 1, [maximum]: limit + 1 }), TypeError);
    assert.throws(() => domain.snapshotRuntimeBlockHydrationMetricsV2({ ...value, [current]: 1 }), TypeError);
  }
  for (const [field, limit] of [['retainedEntries', 64], ['retainedBytes', 67_108_864]] as const) {
    assert.doesNotThrow(() => domain.snapshotRuntimeBlockHydrationMetricsV2({ ...value, [field]: limit }));
    assert.throws(() => domain.snapshotRuntimeBlockHydrationMetricsV2({ ...value, [field]: limit + 1 }), TypeError);
  }
  value.queueDelayMs.last = 5; value.queueDelayMs.maximum = 10;
  const snapshot = domain.snapshotRuntimeBlockHydrationMetricsV2(value);
  value.queueDelayMs.last = 9;
  assert.equal(snapshot.queueDelayMs.last, 5);
  assert.ok(Object.isFrozen(snapshot.queueDelayMs));
  assert.throws(() => domain.snapshotRuntimeBlockHydrationMetricsV2({ ...value, callerConcurrency: 2 }), TypeError);
  for (const queueDelayMs of [{ last: 2, maximum: 1 }, { last: -0, maximum: null }, { last: null, maximum: 0.5 }]) {
    assert.throws(() => domain.snapshotRuntimeBlockHydrationMetricsV2({ ...value, queueDelayMs }), TypeError);
  }
  for (const queueDelayMs of [{ last: 2, maximum: null }, { last: null, maximum: 2 }]) {
    assert.doesNotThrow(() => domain.snapshotRuntimeBlockHydrationMetricsV2({ ...value, queueDelayMs }));
  }
});

void test('V2 memory retains overflow observations within exact byte and body bounds', () => {
  assert.equal(typeof domain.snapshotRuntimeBlockResponseMemoryMetricsV2, 'function');
  const value = twoGroupHydrationEvidenceFixture().blockResponseMemory;
  value.oversizedResponses = 1; value.activeBodies = 2;
  value.inFlightBytes = 67_108_864; value.maximumInFlightBytes = 67_108_864;
  const snapshot = domain.snapshotRuntimeBlockResponseMemoryMetricsV2(value);
  value.oversizedResponses = 2;
  assert.equal(snapshot.oversizedResponses, 1);
  assert.ok(Object.isFrozen(snapshot));
  for (const change of [{ activeBodies: 3 }, { inFlightBytes: 67_108_865, maximumInFlightBytes: 67_108_865 },
    { maximumInFlightBytes: 1 }, { perResponseLimitBytes: 1 }, { totalInFlightLimitBytes: 1 },
    { maximumRssBytes: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => domain.snapshotRuntimeBlockResponseMemoryMetricsV2({ ...value, ...change }), TypeError);
  }
});
