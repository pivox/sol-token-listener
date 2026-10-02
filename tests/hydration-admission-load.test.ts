import assert from 'node:assert/strict';
import test from 'node:test';
import { HydrationGroupAdmission, type HydrationAdmissionPermit } from '../src/application/hydration-group-admission.js';

void test('100 mixed admission cycles retain fairness, bounded demand and no live references', async () => {
  let now = 0;
  const admission = new HydrationGroupAdmission({ now: () => now });
  const first = admission.registerWorker();
  const second = admission.registerWorker();
  const signal = new AbortController().signal;
  let live: HydrationAdmissionPermit | null = null;
  try {
    for (let cycle = 0; cycle < 100; cycle += 1) {
      live = await ready(admission.acquireClassifier(`seed:${cycle}`, signal));
      const order: string[] = [];
      const firstWorker = first.acquire(signal).then((permit) => { order.push('first'); return permit; });
      const secondWorker = second.acquire(signal).then((permit) => { order.push('second'); return permit; });
      const classifier = admission.acquireClassifier(`next:${cycle}`, signal)
        .then((permit) => { order.push('classifier'); return permit; });
      assert.equal(admission.metrics().pendingWorkers, 2);
      assert.equal(admission.metrics().pendingClassifierGroups, 1);
      now += 5;
      live.release();
      live = await ready(firstWorker);
      live.bindGroup(`worker:first:${cycle}`);
      assert.deepEqual(order, ['first']);
      assertBound(admission);
      now += 7;
      live.release();
      live = await ready(classifier);
      assert.deepEqual(order, ['first', 'classifier']);
      assertBound(admission);
      now += 11;
      live.release();
      live = await ready(secondWorker);
      live.bindGroup(`worker:second:${cycle}`);
      assert.deepEqual(order, ['first', 'classifier', 'second']);
      assertBound(admission);
      live.release();
      live = null;
      const metrics = admission.metrics();
      assert.equal(metrics.activeGroups + metrics.unboundReservations, 0);
      assert.equal(metrics.pendingWorkers + metrics.pendingClassifierGroups, 0);
      assert.equal(metrics.worker.oldestWaitMs, null);
      assert.equal(metrics.classifier.oldestWaitMs, null);
      assert.equal(metrics.registeredWorkers, 2);
    }
    const metrics = admission.metrics();
    assert.equal(metrics.worker.grants, 200);
    assert.equal(metrics.classifier.grants, 200);
    assert.equal(metrics.worker.cancellations + metrics.classifier.cancellations, 0);
    assert.equal(metrics.maximumPendingWorkers, 2);
    assert.equal(metrics.maximumPendingClassifierGroups, 1);
    assert.equal(metrics.maximumAdmitted, 1);
  } finally {
    live?.release();
    first.close();
    second.close();
    admission.close();
  }
  assert.equal(admission.metrics().registeredWorkers, 0);
});

function assertBound(admission: HydrationGroupAdmission): void {
  const metrics = admission.metrics();
  assert.equal(metrics.activeGroups + metrics.unboundReservations, 1);
  assert.equal(metrics.maximumAdmitted, 1);
}

async function ready(promise: Promise<HydrationAdmissionPermit | null>): Promise<HydrationAdmissionPermit> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  for (let turn = 0; turn < 8 && !settled; turn += 1) await Promise.resolve();
  assert.equal(settled, true, 'an eligible admission must settle without polling');
  const permit = await promise;
  assert.ok(permit);
  return permit;
}
