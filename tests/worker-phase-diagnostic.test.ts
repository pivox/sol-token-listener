import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WorkerPhaseDiagnosticRecorder,
  type WorkerAttemptOutcome,
  type WorkerClaimOutcome,
  type WorkerDiagnosticPhase,
} from '../src/application/worker-phase-diagnostic.js';

const bounds = [1, 5, 10, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000];

void test('rejects runtime invalid phases without retaining or exposing raw values', () => {
  for (const value of ['secret-signature', '__proto__', 'constructor', 'toString']) {
    const recorder = new WorkerPhaseDiagnosticRecorder(() => 0);
    const before = recorder.snapshot();
    assert.throws(() => { recorder.beginPhase(value as WorkerDiagnosticPhase); },
      { name: 'TypeError', message: 'Invalid diagnostic phase' });
    assert.deepEqual(recorder.snapshot(), before);
  }
});

void test('rejects runtime invalid claim outcomes without retaining or exposing raw values', () => {
  for (const value of ['secret-signature', '__proto__', 'constructor', 'toString']) {
    const recorder = new WorkerPhaseDiagnosticRecorder(() => 0);
    const before = recorder.snapshot();
    assert.throws(() => { recorder.recordClaimOutcome(value as WorkerClaimOutcome); },
      { name: 'TypeError', message: 'Invalid diagnostic claim outcome' });
    assert.deepEqual(recorder.snapshot(), before);
  }
});

void test('rejects runtime invalid attempt outcomes without consuming valid finish', () => {
  for (const value of ['secret-signature', '__proto__', 'constructor', 'toString']) {
    const recorder = new WorkerPhaseDiagnosticRecorder(() => 0);
    const finish = recorder.beginAttempt();
    const active = recorder.snapshot();
    assert.throws(() => { finish(value as WorkerAttemptOutcome); },
      { name: 'TypeError', message: 'Invalid diagnostic attempt outcome' });
    assert.deepEqual(recorder.snapshot(), active);
    finish('processed');
    assert.equal(recorder.snapshot().attemptOutcomes.processed, 1);
  }
});

void test('records an exact 11ms phase in the 50ms bucket', () => {
  let now = 0;
  const recorder = new WorkerPhaseDiagnosticRecorder(() => now);
  const finish = recorder.beginPhase('locator');
  assert.equal(recorder.snapshot().phases.locator.active, 1);
  now = 11;
  finish();
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.scope, 'ALL_WORKER_ATTEMPTS_PROCESS_LIFETIME');
  assert.deepEqual(snapshot.bucketUpperBoundsMs, bounds);
  assert.deepEqual(snapshot.phases.locator, {
    entered: 1, exited: 1, active: 0, count: 1, sumMs: 11, maxMs: 11, invalid: 0,
    buckets: bounds.map((_, index) => index === 3 ? 1 : 0).concat(0),
  });
});

void test('uses inclusive integer millisecond bounds and a final overflow bucket', () => {
  for (const duration of [0, ...bounds, ...bounds.map(value => value + 1), 0.1, 1.1]) {
    let now = 0;
    const recorder = new WorkerPhaseDiagnosticRecorder(() => now);
    const finish = recorder.beginPhase('pipeline');
    now = duration;
    finish();
    const phase = recorder.snapshot().phases.pipeline;
    const integerDuration = Math.ceil(duration);
    const index = bounds.findIndex(bound => integerDuration <= bound);
    assert.equal(phase.buckets[index === -1 ? bounds.length : index], 1);
    assert.equal(phase.sumMs, integerDuration);
    assert.equal(phase.maxMs, integerDuration);
  }
});

void test('invalid and throwing clock readings never fabricate zero samples or throw', () => {
  for (const readings of [[NaN, 1], [0, Infinity], [2, 1], [0, Number.MAX_SAFE_INTEGER + 1],
    [new Error('start'), 1], [0, new Error('end')], [-1, Number.MAX_SAFE_INTEGER]]) {
    const recorder = new WorkerPhaseDiagnosticRecorder(() => {
      const value = readings.shift();
      if (value instanceof Error) throw value;
      assert.notEqual(value, undefined);
      return value ?? NaN;
    });
    assert.doesNotThrow(() => { recorder.beginPhase('claim_call')(); });
    const phase = recorder.snapshot().phases.claim_call;
    assert.equal(phase.invalid, 1);
    assert.equal(phase.count, 0);
    assert.equal(phase.sumMs, 0);
    assert.equal(phase.exited, 1);
    assert.equal(phase.active, 0);
    assert.ok(phase.buckets.every(value => value === 0));
  }
});

void test('concurrent finish closures and attempts are independent and idempotent', () => {
  let now = 0;
  const recorder = new WorkerPhaseDiagnosticRecorder(() => now);
  const first = recorder.beginPhase('locator');
  const attempt = recorder.beginAttempt();
  now = 5;
  const second = recorder.beginPhase('locator');
  assert.equal(recorder.snapshot().phases.locator.active, 2);
  now = 11;
  second(); second(); attempt('processed'); attempt('failed');
  assert.equal(recorder.snapshot().phases.locator.active, 1);
  now = 20;
  first(); first();
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.phases.locator.sumMs, 26);
  assert.equal(snapshot.phases.locator.count, 2);
  assert.equal(snapshot.phases.locator.entered, 2);
  assert.equal(snapshot.phases.locator.exited, 2);
  assert.equal(snapshot.phases.locator.active, 0);
  assert.equal(snapshot.totalAttempt.sumMs, 11);
  assert.equal(snapshot.attemptOutcomes.processed, 1);
  assert.equal(snapshot.attemptOutcomes.failed, 0);
});

void test('records fixed outcomes and reuse without fabricating locator samples', () => {
  const recorder = new WorkerPhaseDiagnosticRecorder(() => 0);
  for (const outcome of ['processed', 'failed', 'lease-lost', 'exceptional'] as const) recorder.beginAttempt()(outcome);
  for (const outcome of ['claimed', 'idle', 'exceptional'] as const) recorder.recordClaimOutcome(outcome);
  recorder.recordSnapshotReuse();
  const snapshot = recorder.snapshot();
  assert.deepEqual(snapshot.attemptOutcomes, { processed: 1, failed: 1, 'lease-lost': 1, exceptional: 1 });
  assert.deepEqual(snapshot.claimOutcomes, { claimed: 1, idle: 1, exceptional: 1 });
  assert.equal(snapshot.snapshotReuse, 1);
  assert.equal(snapshot.phases.locator.count, 0);
  assert.equal(snapshot.totalAttempt.count, 4);
});

void test('snapshots are detached, deeply frozen and fixed size after many attempts', () => {
  const recorder = new WorkerPhaseDiagnosticRecorder(() => 0);
  const before = recorder.snapshot();
  for (let i = 0; i < 10000; i++) {
    recorder.beginPhase('completion')();
    recorder.beginAttempt()('processed');
  }
  const after = recorder.snapshot();
  function checkFrozen(value: unknown): void {
    if (value !== null && typeof value === 'object') {
      assert.ok(Object.isFrozen(value));
      for (const nested of Object.values(value)) checkFrozen(nested);
    }
  }
  checkFrozen(after);
  assert.equal(before.totalAttempt.count, 0);
  assert.equal(after.totalAttempt.count, 10000);
  assert.equal(Object.keys(after.phases).length, 6);
  assert.ok(Object.values(after.phases).every(phase => phase.buckets.length === 15));
  assert.ok(JSON.stringify(after).length < JSON.stringify(before).length + 200);
});

void test('duration sum saturates safely with overflow flag, without test setters', () => {
  let now = 0;
  const recorder = new WorkerPhaseDiagnosticRecorder(() => now);
  for (let i = 0; i < 2; i++) {
    now = 0;
    const finish = recorder.beginPhase('pipeline');
    now = Number.MAX_SAFE_INTEGER;
    finish();
  }
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.phases.pipeline.sumMs, Number.MAX_SAFE_INTEGER);
  assert.equal(snapshot.phases.pipeline.count, 2);
  assert.equal(snapshot.phases.pipeline.invalid, 0);
  assert.equal(snapshot.overflow, true);
});
