import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import * as factory from '../src/application/production-listener-factory.js';
import { WorkerPhaseDiagnosticRecorder } from '../src/application/worker-phase-diagnostic.js';

void test('worker phase summary is emitted once after drain with shared final counters', async () => {
  assert.ok('workerPhaseDiagnosticComponent' in factory);
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let closed = 0;
  let now = 0;
  const recorder = new WorkerPhaseDiagnosticRecorder(() => now);
  const events: unknown[] = [];
  const start = Promise.resolve();
  const wrapped = factory.workerPhaseDiagnosticComponent({
    start: () => start,
    state: () => 'STOPPED' as const,
    close: () => { closed += 1; return pending; },
  }, recorder, (event) => { events.push(event); });
  assert.equal(wrapped.start(), start);
  assert.equal(wrapped.state(), 'STOPPED');
  const a = recorder.beginAttempt();
  const b = recorder.beginAttempt();
  const first = wrapped.close();
  assert.equal(wrapped.close(), first);
  assert.equal(events.length, 0);
  assert.equal(closed, 1);
  now = 10;
  a('processed'); b('failed');
  assert.ok(finish);
  finish();
  await first;
  await wrapped.close();
  wrapped.onCloseTimeout();
  assert.deepEqual(events, [{
    ...recorder.snapshot(),
    event: 'listener_worker_phase_diagnostic_shutdown',
    closeStatus: 'COMPLETED',
  }]);
});

void test('worker close failures remain original and publish incomplete diagnostic', async () => {
  assert.ok('workerPhaseDiagnosticComponent' in factory);
  for (const synchronous of [true, false]) {
    const original = new Error('private original close failure');
    const recorder = new WorkerPhaseDiagnosticRecorder(() => 0);
    recorder.beginAttempt();
    const events: unknown[] = [];
    const wrapped = factory.workerPhaseDiagnosticComponent({
      async start() {}, state: () => 'DEGRADED' as const,
      close() { if (synchronous) throw original; return Promise.reject(original); },
    }, recorder, (event) => { events.push(event); });
    await assert.rejects(wrapped.close(), (error: unknown) => error === original);
    assert.deepEqual(events, [{ ...recorder.snapshot(),
      event: 'listener_worker_phase_diagnostic_shutdown', closeStatus: 'INCOMPLETE' }]);
    assert.equal(JSON.stringify(events).includes(original.message), false);
  }
});

void test('diagnostic snapshot and sink failures never replace close outcome', async () => {
  assert.ok('workerPhaseDiagnosticComponent' in factory);
  for (const closeFails of [false, true]) {
    for (const snapshotFails of [false, true]) {
      const original = new Error('original');
      const recorder = new WorkerPhaseDiagnosticRecorder(() => 0);
      const wrapped = factory.workerPhaseDiagnosticComponent({
        async start() {}, state: () => 'STOPPED' as const,
        close: () => closeFails ? Promise.reject(original) : Promise.resolve(),
      }, { snapshot() {
        if (snapshotFails) throw new Error('snapshot failed');
        return recorder.snapshot();
      } }, () => { throw new Error('sink failed'); });
      if (closeFails) await assert.rejects(wrapped.close(), (error: unknown) => error === original);
      else await wrapped.close();
    }
  }
});

void test('resolved but degraded close never claims a completed drain', async () => {
  assert.ok('workerPhaseDiagnosticComponent' in factory);
  const recorder = new WorkerPhaseDiagnosticRecorder(() => 0);
  const events: unknown[] = [];
  const wrapped = factory.workerPhaseDiagnosticComponent({
    async start() {}, async close() {}, state: () => 'DEGRADED' as const,
  }, recorder, (event) => { events.push(event); });
  await wrapped.close();
  assert.deepEqual(events, [{ ...recorder.snapshot(),
    event: 'listener_worker_phase_diagnostic_shutdown', closeStatus: 'INCOMPLETE' }]);
});

void test('active measurements prevent a completed drain claim even with STOPPED state', async () => {
  const recorder = new WorkerPhaseDiagnosticRecorder(() => 0);
  recorder.beginPhase('locator');
  const events: unknown[] = [];
  const wrapped = factory.workerPhaseDiagnosticComponent({
    async start() {}, async close() {}, state: () => 'STOPPED' as const,
  }, recorder, (event) => { events.push(event); });
  await wrapped.close();
  assert.deepEqual(events, [{ ...recorder.snapshot(),
    event: 'listener_worker_phase_diagnostic_shutdown', closeStatus: 'INCOMPLETE' }]);
});

void test('production shares one recorder across the pool and shutdown wrapper', async () => {
  const source = await readFile(new URL('../src/application/production-listener-factory.ts', import.meta.url), 'utf8');
  assert.equal([...source.matchAll(/new WorkerPhaseDiagnosticRecorder\(\)/gu)].length, 1);
  assert.match(source, /new TransactionInboxWorker\([^]*?phaseObserver: workerPhaseRecorder/u);
  assert.match(source, /worker: workerPhaseDiagnosticComponent\(workerComponent, workerPhaseRecorder,/u);
});

void test('timeout publication is once-only and never changes a late close outcome', async () => {
  for (const closeFails of [false, true]) {
    for (const failure of ['none', 'snapshot', 'state', 'sink', 'clock'] as const) {
      const original = new Error('original close outcome');
      let finish!: () => void;
      const pending = new Promise<void>((resolve, reject) => {
        finish = () => { if (closeFails) reject(original); else resolve(); };
      });
      const recorder = new WorkerPhaseDiagnosticRecorder(() => {
        if (failure === 'clock') throw new Error('clock failed');
        return 0;
      });
      const endPhase = recorder.beginPhase('pipeline');
      let snapshots = 0;
      const events: unknown[] = [];
      const wrapped = factory.workerPhaseDiagnosticComponent({
        async start() {}, close: () => pending,
        state() { if (failure === 'state') throw new Error('state failed'); return 'STOPPED'; },
      }, { snapshot() {
        snapshots += 1;
        if (failure === 'snapshot') throw new Error('snapshot failed');
        return recorder.snapshot();
      } }, (event) => {
        events.push(event);
        if (failure === 'sink') throw new Error('sink failed');
      });
      const closing = wrapped.close();
      assert.equal(wrapped.close(), closing);
      assert.equal(typeof wrapped.onCloseTimeout, 'function');
      assert.doesNotThrow(() => { wrapped.onCloseTimeout(); wrapped.onCloseTimeout(); });
      assert.equal(snapshots, 1);
      assert.deepEqual(events, failure === 'snapshot' ? [] : [{ ...recorder.snapshot(),
        event: 'listener_worker_phase_diagnostic_shutdown', closeStatus: 'INCOMPLETE' }]);
      endPhase();
      finish();
      if (closeFails) await assert.rejects(closing, (error: unknown) => error === original);
      else await closing;
      wrapped.onCloseTimeout();
      assert.equal(snapshots, 1);
      assert.equal(events.length, failure === 'snapshot' ? 0 : 1);
    }
  }
});
