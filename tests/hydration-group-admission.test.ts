import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HydrationGroupAdmission,
  HydrationGroupAdmissionContractError,
  type HydrationAdmissionPermit,
} from '../src/application/hydration-group-admission.js';

interface RoleMetrics {
  grants: number; cancellations: number; oldestWaitMs: number | null;
  lastWaitMs: number | null; maximumWaitMs: number | null;
}
interface Metrics {
  version: 1; enabled: true; registeredWorkers: number; pendingWorkers: number;
  maximumPendingWorkers: number; pendingClassifierGroups: number;
  maximumPendingClassifierGroups: number; unboundReservations: number;
  activeGroups: number; maximumAdmitted: number; worker: RoleMetrics; classifier: RoleMetrics;
}
const metrics = (admission: HydrationGroupAdmission): Metrics => admission.metrics() as Metrics;

const signal = (): AbortSignal => new AbortController().signal;
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
const required = (permit: HydrationAdmissionPermit | null): HydrationAdmissionPermit => {
  assert.ok(permit);
  return permit;
};

/** A microtask barrier makes an accidental missing grant fail, never hang the suite. */
const settled = async <T>(promise: Promise<T> | undefined): Promise<T> => {
  assert.ok(promise);
  const waiting = Symbol('still-waiting');
  const barrier = async (): Promise<typeof waiting> => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    return waiting;
  };
  const result = await Promise.race([promise, barrier()]);
  assert.notEqual(result, waiting, 'request must settle before the microtask barrier');
  return result as T;
};

void test('two workers waiting on a classifier admit exactly one before promise continuation', async () => {
  const admission = new HydrationGroupAdmission({ now: () => 0 });
  const held = required(await admission.acquireClassifier('held', signal()));
  const first = admission.registerWorker();
  const second = admission.registerWorker();
  let firstPermit: HydrationAdmissionPermit | null = null;
  let secondPermit: HydrationAdmissionPermit | null = null;
  const firstResult = first.acquire(signal()).then((permit) => { firstPermit = permit; });
  const secondResult = second.acquire(signal()).then((permit) => { secondPermit = permit; });
  await flush();
  assert.equal(firstPermit, null);
  assert.equal(secondPermit, null);
  held.release();
  assert.equal(metrics(admission).unboundReservations, 1);
  await flush();
  assert.notEqual(firstPermit, null);
  assert.equal(secondPermit, null);
  required(firstPermit).release();
  await settled(Promise.all([firstResult, secondResult]));
  required(secondPermit).release();
  admission.close();
});

void test('initial metrics are exact detached frozen snapshots', () => {
  const admission = new HydrationGroupAdmission({ now: () => 0.25 });
  const snapshot = metrics(admission);
  const role = { grants: 0, cancellations: 0, oldestWaitMs: null, lastWaitMs: null, maximumWaitMs: null };
  assert.deepEqual(snapshot, {
    version: 1, enabled: true, registeredWorkers: 0, pendingWorkers: 0,
    maximumPendingWorkers: 0, pendingClassifierGroups: 0, maximumPendingClassifierGroups: 0,
    unboundReservations: 0, activeGroups: 0, maximumAdmitted: 0,
    worker: role, classifier: role,
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.worker), true);
  assert.equal(Object.isFrozen(snapshot.classifier), true);
  const worker = admission.registerWorker();
  assert.equal(snapshot.registeredWorkers, 0);
  assert.equal(metrics(admission).registeredWorkers, 1);
  worker.close();
  assert.equal(metrics(admission).registeredWorkers, 0);
  admission.close();
});

void test('contested dispatch starts with worker then alternates worker and classifier with FIFO workers', async () => {
  const admission = new HydrationGroupAdmission({ now: () => 0 });
  const held = required(await admission.acquireClassifier('held', signal()));
  const workers = [admission.registerWorker(), admission.registerWorker(), admission.registerWorker()];
  const order: string[] = [];
  const workerResults = workers.map((worker, index) => worker.acquire(signal()).then((permit) => {
    order.push(`w${index}`);
    return permit;
  }));
  const classifierResult = admission.acquireClassifier('next', signal()).then((permit) => {
    order.push('c1');
    return permit;
  });
  held.release();
  await flush();
  assert.deepEqual(order, ['w0']);
  required(await settled(workerResults[0])).release();
  await flush();
  assert.deepEqual(order, ['w0', 'c1']);
  const classifier = required(await settled(classifierResult));
  const nextClassifierResult = admission.acquireClassifier('last', signal()).then((permit) => {
    order.push('c2'); return permit;
  });
  classifier.release();
  await flush();
  assert.deepEqual(order, ['w0', 'c1', 'w1']);
  required(await settled(workerResults[1])).release();
  await flush();
  assert.deepEqual(order, ['w0', 'c1', 'w1', 'c2']);
  required(await settled(nextClassifierResult)).release();
  required(await settled(workerResults[2])).release();
  assert.equal(metrics(admission).maximumAdmitted, 1);
  admission.close();
});

void test('worker reservation binds once and same-group classifier references retain budget until last release', async () => {
  const admission = new HydrationGroupAdmission({ now: () => 0 });
  const worker = admission.registerWorker();
  const reservation = required(await worker.acquire(signal()));
  assert.equal(Object.isFrozen(reservation), true);
  assert.equal(metrics(admission).unboundReservations, 1);
  reservation.bindGroup('opaque');
  assert.equal(metrics(admission).unboundReservations, 0);
  assert.equal(metrics(admission).activeGroups, 1);
  assert.throws(() => { reservation.bindGroup('opaque'); }, HydrationGroupAdmissionContractError);
  const follower = required(await admission.acquireClassifier('opaque', signal()));
  let other: HydrationAdmissionPermit | null = null;
  const pending = admission.acquireClassifier('other', signal()).then((permit) => { other = permit; });
  reservation.release();
  reservation.release();
  await flush();
  assert.equal(other, null);
  assert.equal(metrics(admission).activeGroups, 1);
  follower.release();
  await settled(pending);
  required(other).release();
  assert.throws(() => { reservation.bindGroup('opaque'); }, HydrationGroupAdmissionContractError);
  assert.equal(metrics(admission).classifier.grants, 2);
  admission.close();
});

void test('classifier followers share one pending group and each consumer gets its own permit', async () => {
  const admission = new HydrationGroupAdmission({ now: () => 0 });
  const worker = admission.registerWorker();
  const held = required(await worker.acquire(signal()));
  const first = admission.acquireClassifier('next', signal());
  const second = admission.acquireClassifier('next', signal());
  assert.equal(metrics(admission).pendingClassifierGroups, 1);
  held.release();
  assert.equal(metrics(admission).activeGroups, 1);
  const a = required(await settled(first));
  const b = required(await settled(second));
  assert.notEqual(a, b);
  assert.throws(() => { a.bindGroup('next'); }, HydrationGroupAdmissionContractError);
  a.release();
  assert.equal(metrics(admission).activeGroups, 1);
  b.release();
  assert.equal(metrics(admission).activeGroups, 0);
  assert.equal(metrics(admission).classifier.grants, 2);
  admission.close();
});

void test('same-active-group join bypasses a distinct pending group without consuming its pending allowance', async () => {
  const admission = new HydrationGroupAdmission({ now: () => 0 });
  const held = required(await admission.acquireClassifier('active', signal()));
  const pending = admission.acquireClassifier('pending', signal());
  let follower: HydrationAdmissionPermit | null = null;
  const joined = admission.acquireClassifier('active', signal()).then((permit) => { follower = permit; });
  await flush();
  assert.notEqual(follower, null);
  assert.equal(metrics(admission).pendingClassifierGroups, 1);
  held.release();
  required(follower).release();
  await settled(joined);
  required(await settled(pending)).release();
  admission.close();
});

void test('a second distinct pending classifier group is refused with a redacted typed contract error', async () => {
  const admission = new HydrationGroupAdmission({ now: () => 0 });
  const held = required(await admission.registerWorker().acquire(signal()));
  const pending = admission.acquireClassifier('first-secret', signal());
  await assert.rejects(admission.acquireClassifier('second-secret', signal()), (error: unknown) => {
    assert.ok(error instanceof HydrationGroupAdmissionContractError);
    assert.equal(error.code, 'pending_classifier_group_conflict');
    assert.equal(JSON.stringify(error).includes('secret'), false);
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
  assert.equal(metrics(admission).pendingClassifierGroups, 1);
  held.release();
  required(await settled(pending)).release();
  admission.close();
});

void test('one outstanding acquire per worker is enforced and released workers can acquire again', async () => {
  const admission = new HydrationGroupAdmission({ now: () => 0 });
  const worker = admission.registerWorker();
  const first = required(await worker.acquire(signal()));
  await assert.rejects(worker.acquire(signal()), HydrationGroupAdmissionContractError);
  first.bindGroup('bound');
  await assert.rejects(worker.acquire(signal()), HydrationGroupAdmissionContractError);
  first.release();
  const second = required(await worker.acquire(signal()));
  assert.notEqual(first, second);
  assert.throws(() => { first.bindGroup('stale'); }, HydrationGroupAdmissionContractError);
  first.release();
  assert.equal(metrics(admission).unboundReservations, 1);
  second.release();
  admission.close();
});

void test('abort before grant removes its listener, settles null and allows the same handle to retry', async () => {
  let time = 0;
  const admission = new HydrationGroupAdmission({ now: () => time });
  const held = required(await admission.acquireClassifier('held', signal()));
  const worker = admission.registerWorker();
  const abort = new AbortController();
  let added = 0;
  let removed = 0;
  const originalAdd = abort.signal.addEventListener.bind(abort.signal);
  const originalRemove = abort.signal.removeEventListener.bind(abort.signal);
  abort.signal.addEventListener = (...args) => { added += 1; originalAdd(...args); };
  abort.signal.removeEventListener = (...args) => { removed += 1; originalRemove(...args); };
  const pending = worker.acquire(abort.signal);
  time = 2.9;
  abort.abort();
  assert.equal(await settled(pending), null);
  assert.equal(added, 1);
  assert.equal(removed, 1);
  assert.equal(metrics(admission).pendingWorkers, 0);
  assert.deepEqual(metrics(admission).worker, {
    grants: 0, cancellations: 1, oldestWaitMs: null, lastWaitMs: 2, maximumWaitMs: 2,
  });
  const retry = worker.acquire(signal());
  held.release();
  required(await settled(retry)).release();
  admission.close();
});

void test('aborting a queued classifier follower preserves the remaining consumers', async () => {
  const admission = new HydrationGroupAdmission({ now: () => 0 });
  const held = required(await admission.registerWorker().acquire(signal()));
  const abort = new AbortController();
  const cancelled = admission.acquireClassifier('next', abort.signal);
  const remaining = admission.acquireClassifier('next', signal());
  abort.abort();
  assert.equal(await settled(cancelled), null);
  assert.equal(metrics(admission).pendingClassifierGroups, 1);
  held.release();
  required(await settled(remaining)).release();
  assert.equal(metrics(admission).classifier.cancellations, 1);
  admission.close();
});

void test('abort after synchronous grant cannot revoke ownership before the promise is observed', async () => {
  const admission = new HydrationGroupAdmission({ now: () => 0 });
  const held = required(await admission.acquireClassifier('held', signal()));
  const abort = new AbortController();
  const pending = admission.registerWorker().acquire(abort.signal);
  held.release();
  abort.abort();
  assert.equal(metrics(admission).unboundReservations, 1);
  const granted = required(await settled(pending));
  assert.equal(metrics(admission).worker.cancellations, 0);
  granted.release();
  admission.close();
});

void test('already-aborted requests never claim ownership or listeners', async () => {
  const admission = new HydrationGroupAdmission({ now: () => 0 });
  const abort = new AbortController();
  abort.abort();
  assert.equal(await admission.registerWorker().acquire(abort.signal), null);
  assert.equal(await admission.acquireClassifier('key', abort.signal), null);
  assert.equal(metrics(admission).maximumAdmitted, 0);
  admission.close();
});

void test('worker close cancels pending work but does not abandon an active group', async () => {
  const admission = new HydrationGroupAdmission({ now: () => 0 });
  const worker = admission.registerWorker();
  const held = required(await worker.acquire(signal()));
  held.bindGroup('held');
  const pendingWorker = admission.registerWorker();
  const pending = pendingWorker.acquire(signal());
  pendingWorker.close();
  pendingWorker.close();
  assert.equal(await settled(pending), null);
  worker.close();
  assert.equal(metrics(admission).registeredWorkers, 0);
  assert.equal(metrics(admission).activeGroups, 1);
  assert.equal(await worker.acquire(signal()), null);
  const follower = required(await admission.acquireClassifier('held', signal()));
  held.release();
  assert.equal(metrics(admission).activeGroups, 1);
  follower.release();
  admission.close();
});

void test('controller close settles all pending requests but retains granted references until release', async () => {
  const admission = new HydrationGroupAdmission({ now: () => 0 });
  const held = required(await admission.acquireClassifier('held', signal()));
  const worker = admission.registerWorker();
  const workerPending = worker.acquire(signal());
  const classifierPending = admission.acquireClassifier('next', signal());
  admission.close();
  admission.close();
  assert.deepEqual(await settled(Promise.all([workerPending, classifierPending])), [null, null]);
  assert.equal(metrics(admission).registeredWorkers, 0);
  assert.equal(metrics(admission).pendingWorkers, 0);
  assert.equal(metrics(admission).pendingClassifierGroups, 0);
  assert.equal(metrics(admission).activeGroups, 1);
  assert.equal(await worker.acquire(signal()), null);
  assert.equal(await admission.acquireClassifier('held', signal()), null);
  assert.throws(() => admission.registerWorker(), HydrationGroupAdmissionContractError);
  held.release();
  assert.equal(metrics(admission).activeGroups, 0);
});

void test('wait metrics floor fractional elapsed time, clear live ages and preserve historical maxima', async () => {
  let time = 0.25;
  const admission = new HydrationGroupAdmission({ now: () => time });
  const held = required(await admission.acquireClassifier('held', signal()));
  const worker = admission.registerWorker();
  time = 1.75;
  const pendingWorker = worker.acquire(signal());
  time = 2.25;
  const pendingClassifier = admission.acquireClassifier('next', signal());
  time = 5.9;
  assert.equal(metrics(admission).worker.oldestWaitMs, 4);
  assert.equal(metrics(admission).classifier.oldestWaitMs, 3);
  held.release();
  const workerPermit = required(await settled(pendingWorker));
  assert.equal(metrics(admission).worker.oldestWaitMs, null);
  assert.equal(metrics(admission).worker.lastWaitMs, 4);
  time = 8.5;
  workerPermit.release();
  required(await settled(pendingClassifier)).release();
  const next = required(await worker.acquire(signal()));
  next.release();
  const snapshot = metrics(admission);
  assert.equal(snapshot.worker.lastWaitMs, 0);
  assert.equal(snapshot.worker.maximumWaitMs, 4);
  assert.equal(snapshot.classifier.lastWaitMs, 6);
  assert.equal(snapshot.classifier.maximumWaitMs, 6);
  assert.equal(snapshot.maximumPendingWorkers, 1);
  assert.equal(snapshot.maximumPendingClassifierGroups, 1);
  assert.equal(snapshot.maximumAdmitted, 1);
  assert.equal(snapshot.classifier.oldestWaitMs, null);
  admission.close();
});

void test('empty group keys are typed contract violations without losing a worker reservation', async () => {
  const admission = new HydrationGroupAdmission({ now: () => 0 });
  await assert.rejects(admission.acquireClassifier('', signal()), HydrationGroupAdmissionContractError);
  const reservation = required(await admission.registerWorker().acquire(signal()));
  assert.throws(() => { reservation.bindGroup(''); }, HydrationGroupAdmissionContractError);
  assert.equal(metrics(admission).unboundReservations, 1);
  reservation.bindGroup(' ');
  reservation.release();
  admission.close();
});

void test('nonfinite, throwing and backwards clocks fail closed with redacted typed errors', async () => {
  for (const invalid of [Number.NaN, Infinity, -Infinity, -1]) {
    let time = 0;
    const admission = new HydrationGroupAdmission({ now: () => time });
    const held = required(await admission.acquireClassifier('held', signal()));
    const pending = admission.registerWorker().acquire(signal());
    const rejection = assert.rejects(pending, HydrationGroupAdmissionContractError);
    time = invalid;
    assert.throws(() => admission.metrics(), (error: unknown) => {
      assert.ok(error instanceof HydrationGroupAdmissionContractError);
      assert.equal(error.code, 'invalid_clock');
      return true;
    });
    await settled(rejection);
    await assert.rejects(admission.acquireClassifier('held', signal()), HydrationGroupAdmissionContractError);
    held.release();
  }
  let throwClock = false;
  const admission = new HydrationGroupAdmission({ now: () => {
    if (throwClock) throw new Error('secret-clock-value');
    return 0;
  } });
  throwClock = true;
  assert.throws(() => admission.metrics(), (error: unknown) => {
    assert.ok(error instanceof HydrationGroupAdmissionContractError);
    assert.equal(error.message.includes('secret'), false);
    assert.equal(JSON.stringify(error).includes('secret'), false);
    return true;
  });
});

void test('unsafe elapsed durations fail closed instead of exposing imprecise counters', async () => {
  let time = 0;
  const admission = new HydrationGroupAdmission({ now: () => time });
  const held = required(await admission.acquireClassifier('held', signal()));
  const pending = admission.registerWorker().acquire(signal());
  const rejected = assert.rejects(pending, HydrationGroupAdmissionContractError);
  time = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => admission.metrics(), HydrationGroupAdmissionContractError);
  await settled(rejected);
  held.release();
});
