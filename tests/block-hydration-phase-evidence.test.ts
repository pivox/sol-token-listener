import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertValidRuntimeBlockHydrationPhaseEvidence,
  createRuntimeBlockHydrationPhaseEvidence,
} from '../src/domain/block-hydration-phase-evidence.js';
import { createBlockHydrationPhaseRecorder } from '../src/solana/rpc/block-hydration-phase-recorder.js';

const zeroPhase = () => ({
  started: 0, completed: 0, failed: 0, inFlight: 0, maxInFlight: 0,
  settledLatencyBuckets: Array<number>(10).fill(0), maxSettledLatencyMs: 0,
});
const validInput = () => ({ version: 1, overflowed: false, rpc: zeroPhase(), snapshot: zeroPhase() });

void test('creates detached deeply frozen evidence with exact fields and no identifiers', () => {
  const input = validInput();
  const evidence = createRuntimeBlockHydrationPhaseEvidence(input);
  assert.deepEqual(Reflect.ownKeys(evidence), ['version', 'overflowed', 'rpc', 'snapshot']);
  assert.deepEqual(Reflect.ownKeys(evidence.rpc), [
    'started', 'completed', 'failed', 'inFlight', 'maxInFlight',
    'settledLatencyBuckets', 'maxSettledLatencyMs',
  ]);
  for (const phase of [evidence.rpc, evidence.snapshot]) {
    assert.ok(Object.isFrozen(phase));
    assert.ok(Object.isFrozen(phase.settledLatencyBuckets));
  }
  assert.ok(Object.isFrozen(evidence));
  assert.notStrictEqual(evidence.rpc, input.rpc);
  input.rpc.settledLatencyBuckets[0] = 1;
  assert.equal(evidence.rpc.settledLatencyBuckets[0], 0);
  assert.doesNotThrow(() => { assertValidRuntimeBlockHydrationPhaseEvidence(evidence); });
});

void test('rejects malformed shape, counters and nonoverflowed accounting', () => {
  const valid = validInput();
  const malformedPhases = [
    { ...valid.rpc, identifier: 'private' },
    { ...valid.rpc, started: -0 }, { ...valid.rpc, failed: -1 },
    { ...valid.rpc, completed: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid.rpc, maxSettledLatencyMs: 0.5 },
    { ...valid.rpc, settledLatencyBuckets: Array<number>(9).fill(0) },
    { ...valid.rpc, settledLatencyBuckets: Array<number>(11).fill(0) },
    { ...valid.rpc, settledLatencyBuckets: [NaN, ...Array<number>(9).fill(0)] },
    { ...valid.rpc, started: 1 },
    { ...valid.rpc, started: 1, completed: 1 },
    { ...valid.rpc, started: 1, inFlight: 1 },
  ];
  for (const malformed of [null, [], { ...valid, version: 2 }, { ...valid, overflowed: 1 },
    { ...valid, endpoint: 'private' }, ...malformedPhases.map((rpc) => ({ ...valid, rpc }))]) {
    assert.throws(() => { createRuntimeBlockHydrationPhaseEvidence(malformed); }, TypeError);
  }
  assert.doesNotThrow(() => { assertValidRuntimeBlockHydrationPhaseEvidence({
    ...valid, overflowed: true, rpc: { ...valid.rpc, started: Number.MAX_SAFE_INTEGER },
  }); });
  assert.throws(() => { assertValidRuntimeBlockHydrationPhaseEvidence({
    ...valid, overflowed: true, snapshot: { ...valid.snapshot, started: Infinity },
  }); }, TypeError);
});

void test('rejects proxies, accessors, symbols, nonplain objects and sparse arrays without reads', () => {
  const valid = validInput();
  let reads = 0;
  const hostile = (): never => { reads += 1; throw new Error('unexpected read'); };
  const accessor = { ...valid.rpc };
  Object.defineProperty(accessor, 'started', { enumerable: true, get: hostile });
  const topAccessor = { ...valid };
  Object.defineProperty(topAccessor, 'rpc', { enumerable: true, get: hostile });
  const buckets = Array<number>(10).fill(0);
  Object.defineProperty(buckets, '0', { enumerable: true, get: hostile });
  for (const malformed of [
    new Proxy(valid, { ownKeys: hostile }), topAccessor,
    { ...valid, rpc: new Proxy(valid.rpc, { ownKeys: hostile }) },
    { ...valid, rpc: accessor }, { ...valid, rpc: Object.create(null) as unknown },
    { ...valid, [Symbol('extra')]: 0 },
    { ...valid, rpc: { ...valid.rpc, settledLatencyBuckets: buckets } },
    { ...valid, rpc: { ...valid.rpc, settledLatencyBuckets: Array<number>(10) } },
    { ...valid, rpc: { ...valid.rpc, settledLatencyBuckets: new Proxy(Array<number>(10).fill(0), { ownKeys: hostile }) } },
    { ...valid, rpc: { ...valid.rpc, settledLatencyBuckets: Object.assign(Array<number>(10).fill(0), { [Symbol('extra')]: 0 }) } },
  ]) assert.throws(() => { createRuntimeBlockHydrationPhaseEvidence(malformed); }, TypeError);
  assert.equal(reads, 0);
});

void test('default monotonic clock produces valid aggregate evidence', () => {
  const recorder = createBlockHydrationPhaseRecorder();
  recorder.begin('rpc')('completed');
  const evidence = recorder.snapshot();
  assert.ok(evidence);
  assert.equal(evidence.overflowed, false);
  assertValidRuntimeBlockHydrationPhaseEvidence(evidence);
});

void test('recorder tracks both phase outcomes, concurrency and idempotent settlement', () => {
  let time = 0;
  const recorder = createBlockHydrationPhaseRecorder({ now: () => time });
  assert.equal(recorder.snapshot(), null);
  const first = recorder.begin('rpc');
  const second = recorder.begin('rpc');
  const snapshot = recorder.begin('snapshot');
  const before = recorder.snapshot();
  assert.equal(before?.rpc.inFlight, 2);
  time = 25.1;
  first('completed');
  first('failed');
  snapshot('failed');
  const after = recorder.snapshot();
  assert.equal(after?.rpc.started, 2);
  assert.equal(after?.rpc.completed, 1);
  assert.equal(after?.rpc.failed, 0);
  assert.equal(after?.rpc.inFlight, 1);
  assert.equal(after?.rpc.maxInFlight, 2);
  assert.equal(after?.rpc.maxSettledLatencyMs, 26);
  assert.equal(after?.snapshot.failed, 1);
  assert.equal(after?.snapshot.settledLatencyBuckets[0], 1);
  assert.equal(before?.rpc.completed, 0);
  second('failed');
  assert.equal(recorder.snapshot()?.rpc.failed, 1);
  assert.equal(recorder.snapshot()?.rpc.inFlight, 0);
});

void test('records inclusive fixed histogram boundaries for successful and failed settlements', () => {
  let time = 0;
  const recorder = createBlockHydrationPhaseRecorder({ now: () => time });
  const durations = [0, 50, 51, 100, 101, 250, 251, 500, 501, 1000,
    1001, 2500, 2501, 5000, 5001, 10000, 10001, 30000, 30001];
  for (const [index, duration] of durations.entries()) {
    time = 0;
    const settle = recorder.begin('rpc');
    time = duration;
    settle(index % 2 === 0 ? 'completed' : 'failed');
  }
  assert.deepEqual(recorder.snapshot()?.rpc.settledLatencyBuckets, [2, 2, 2, 2, 2, 2, 2, 2, 2, 1]);
  assert.equal(recorder.snapshot()?.rpc.maxSettledLatencyMs, 30001);
  assert.equal(recorder.snapshot()?.overflowed, false);
});

void test('saturates oversized latency and contains bad or throwing clocks', () => {
  let time = 0;
  const recorder = createBlockHydrationPhaseRecorder({ now: () => time });
  const settle = recorder.begin('rpc');
  time = Number.MAX_VALUE;
  settle('completed');
  assert.equal(recorder.snapshot()?.overflowed, true);
  assert.equal(recorder.snapshot()?.rpc.maxSettledLatencyMs, Number.MAX_SAFE_INTEGER);
  assert.equal(recorder.snapshot()?.rpc.settledLatencyBuckets[9], 1);
  for (const now of [() => NaN, () => Infinity, () => { throw new Error('clock'); }]) {
    const broken = createBlockHydrationPhaseRecorder({ now });
    assert.doesNotThrow(() => { broken.begin('snapshot')('failed'); });
    assert.equal(broken.snapshot()?.snapshot.failed, 1);
    assert.equal(broken.snapshot()?.snapshot.inFlight, 0);
    assert.equal(broken.snapshot()?.overflowed, true);
  }
  let backwards = 2;
  const reversed = createBlockHydrationPhaseRecorder({ now: () => backwards-- });
  reversed.begin('rpc')('completed');
  assert.equal(reversed.snapshot()?.overflowed, true);
});
