import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCANNER_DIAGNOSTIC_OUTCOMES,
  SCANNER_DIAGNOSTIC_PHASES,
  ScannerPhaseDiagnosticsCollector,
  snapshotScannerPhaseDiagnostics,
} from '../src/domain/scanner-phase-diagnostics.js';

void test('records finite phases, provider/program dimensions and exact timings', () => {
  const collector = new ScannerPhaseDiagnosticsCollector();
  for (const phase of SCANNER_DIAGNOSTIC_PHASES) {
    collector.recordPhase({
      provider: 'primary', program: 'pumpfun', phase,
      durationMs: 7, outcome: 'OK', code: null,
    });
  }
  const snapshot = collector.snapshot(1_000);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.sampledAtMs, 1_000);
  assert.equal(snapshot.buckets.length, SCANNER_DIAGNOSTIC_PHASES.length);
  assert.deepEqual(snapshot.buckets[0], {
    provider: 'primary', program: 'pumpfun', phase: 'SOURCE_PAGE',
    count: 1, totalDurationMs: 7, maxDurationMs: 7, lastOutcome: 'OK', lastCode: null,
  });
  assert.deepEqual(snapshot.fronts.map(front => front.program), ['pumpfun', 'pumpswap']);
});

void test('preserves finite outcomes and trusted original codes but never retains an exception', () => {
  const collector = new ScannerPhaseDiagnosticsCollector();
  for (const outcome of SCANNER_DIAGNOSTIC_OUTCOMES) {
    collector.recordPhase({
      provider: 'secondary', program: 'pumpswap', phase: 'SUPERVISOR',
      durationMs: 1, outcome,
      code: outcome === 'ERROR' ? 'SOURCE_RESPONSE'
        : outcome === 'PAUSED' ? 'CATCH_UP_PAGE_BUDGET_EXHAUSTED'
          : outcome === 'REFRESH_REQUIRED' ? 'CATCH_UP_REFRESH_REQUIRED' : null,
    });
  }
  const snapshot = collector.snapshot(2_000);
  assert.equal(snapshot.buckets[0]?.count, SCANNER_DIAGNOSTIC_OUTCOMES.length);
  assert.equal(snapshot.buckets[0]?.lastOutcome, 'ABORTED');
  assert.equal(snapshot.buckets[0]?.lastCode, null);
  collector.recordPhase({
    provider: 'secondary', program: 'pumpswap', phase: 'BLOCK_HYDRATE',
    durationMs: 3, outcome: 'ERROR', code: 'UNKNOWN',
  });
  assert.equal(collector.snapshot(2_001).buckets.find(bucket => bucket.phase === 'BLOCK_HYDRATE')?.lastCode, 'UNKNOWN');
  assert.ok(!JSON.stringify(collector.snapshot(2_001)).includes('secret-signature'));
});

void test('rejects malformed or identity-bearing dimensions without changing state', () => {
  const collector = new ScannerPhaseDiagnosticsCollector();
  const before = collector.snapshot(10);
  const good = {
    provider: 'primary', program: 'pumpfun', phase: 'SOURCE_PAGE',
    durationMs: 1, outcome: 'OK', code: null,
  };
  for (const bad of [
    { ...good, provider: 'secret-rpc-url' },
    { ...good, program: 'secret-mint' },
    { ...good, phase: '__proto__' },
    { ...good, outcome: 'secret-error' },
    { ...good, code: 'secret-signature' },
    { ...good, durationMs: -1 },
    { ...good, signature: 'secret-signature' },
  ]) {
    assert.throws(() => { collector.recordPhase(bad as never); }, TypeError);
  }
  assert.deepEqual(collector.snapshot(10), before);
});

void test('saturates duration totals and reports overflow', () => {
  const collector = new ScannerPhaseDiagnosticsCollector();
  const event = {
    provider: 'primary', program: 'pumpfun', phase: 'SOURCE_PAGE',
    durationMs: Number.MAX_SAFE_INTEGER, outcome: 'OK', code: null,
  } as const;
  collector.recordPhase(event);
  collector.recordPhase(event);
  const snapshot = collector.snapshot(1);
  assert.equal(snapshot.overflow, true);
  assert.equal(snapshot.buckets[0]?.count, 2);
  assert.equal(snapshot.buckets[0]?.totalDurationMs, Number.MAX_SAFE_INTEGER);
  assert.equal(snapshot.buckets[0]?.maxDurationMs, Number.MAX_SAFE_INTEGER);
});

void test('tracks durable front age and observation-window checkpoint advancement without a cursor', () => {
  const collector = new ScannerPhaseDiagnosticsCollector();
  collector.recordFront({ program: 'pumpfun', kind: 'PROGRESS', atMs: 100 });
  collector.recordFront({ program: 'pumpfun', kind: 'COMPLETE', atMs: 110 });
  collector.recordFront({ program: 'pumpfun', kind: 'CHECKPOINT_ADVANCED', atMs: 120 });
  const first = collector.snapshot(150);
  assert.deepEqual(first.fronts[0], {
    program: 'pumpfun', progressCount: 1, completedCount: 1,
    lastProgressAgeMs: 50, checkpointAdvanced: true,
  });
  assert.equal(collector.snapshot(151).fronts[0]?.checkpointAdvanced, false);
  assert.equal(collector.snapshot(151).fronts[0]?.lastProgressAgeMs, 51);
  assert.ok(!JSON.stringify(first).includes('cursor'));
});

void test('snapshots are detached, deeply frozen and replayed without repeating window flags', () => {
  const collector = new ScannerPhaseDiagnosticsCollector();
  collector.recordPhase({
    provider: 'primary', program: 'pumpfun', phase: 'SOURCE_PAGE',
    durationMs: 4, outcome: 'ERROR', code: 'SOURCE_RESPONSE',
  });
  collector.recordFront({ program: 'pumpfun', kind: 'CHECKPOINT_ADVANCED', atMs: 100 });
  const first = collector.snapshot(100);
  const replay = ScannerPhaseDiagnosticsCollector.fromSnapshot(first);
  const copied = snapshotScannerPhaseDiagnostics(first);
  assert.notEqual(copied, first);
  assert.notEqual(copied.buckets, first.buckets);
  assert.ok(Object.isFrozen(copied));
  assert.ok(Object.isFrozen(copied.buckets));
  assert.ok(Object.isFrozen(copied.buckets[0]));
  assert.ok(Object.isFrozen(copied.fronts));
  assert.ok(Object.isFrozen(copied.fronts[0]));
  assert.equal(replay.snapshot(101).buckets[0]?.count, 1);
  assert.equal(replay.snapshot(101).fronts[0]?.checkpointAdvanced, false);
  collector.recordPhase({
    provider: 'primary', program: 'pumpfun', phase: 'SOURCE_PAGE',
    durationMs: 5, outcome: 'OK', code: null,
  });
  assert.equal(first.buckets[0]?.count, 1);
});

void test('strict snapshot validation rejects extra fields, duplicate keys, unsafe counters and accessors', () => {
  const snapshot = new ScannerPhaseDiagnosticsCollector().snapshot(1);
  for (const malformed of [
    { ...snapshot, signature: 'secret-signature' },
    { ...snapshot, buckets: [{
      provider: 'primary', program: 'pumpfun', phase: 'SOURCE_PAGE', count: -1,
      totalDurationMs: 0, maxDurationMs: 0, lastOutcome: 'OK', lastCode: null,
    }] },
    { ...snapshot, fronts: [...snapshot.fronts, snapshot.fronts[0]] },
    { ...snapshot, sampledAtMs: Number.MAX_SAFE_INTEGER + 1 },
    Object.defineProperty({ ...snapshot }, 'overflow', { get: () => false, enumerable: true }),
  ]) {
    assert.throws(() => snapshotScannerPhaseDiagnostics(malformed), TypeError);
  }
});

void test('unavailable diagnostics remain explicit and cannot masquerade as empty healthy samples', () => {
  const collector = new ScannerPhaseDiagnosticsCollector();
  collector.markUnavailable();
  assert.equal(collector.snapshot(1).unavailable, true);
});
