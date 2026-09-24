import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFinalityDiagnosticTrackerState,
  recordFinalityDiagnosticFailure,
  recordFinalityDiagnosticRecovery,
} from '../src/application/finality-reconciler-diagnostic-tracker.js';

void test('emits the first failure, suppresses failures 2 to 11 and summarizes failure 12', () => {
  let state = createFinalityDiagnosticTrackerState();
  const diagnostics = [];

  for (let failure = 1; failure <= 12; failure += 1) {
    const reduction = recordFinalityDiagnosticFailure(
      state,
      failure === 11 ? 'FINALITY_BLOCK' : 'FINALITY_POLL',
      1_000 + failure,
    );
    assert.equal(Object.isFrozen(reduction), true);
    assert.equal(Object.isFrozen(reduction.state), true);
    assert.notStrictEqual(reduction.state, state);
    state = reduction.state;
    if (reduction.diagnostic !== null) diagnostics.push(reduction.diagnostic);
  }

  assert.deepEqual(diagnostics, [
    {
      version: 1,
      phase: 'DEGRADED',
      reasonCode: 'FINALITY_POLL',
      degradedAtMs: 1_001,
      observedAtMs: 1_001,
      durationMs: 0,
      consecutiveFailures: 1,
      suppressedFailures: 0,
    },
    {
      version: 1,
      phase: 'DEGRADED',
      reasonCode: 'FINALITY_POLL',
      degradedAtMs: 1_001,
      observedAtMs: 1_012,
      durationMs: 11,
      consecutiveFailures: 12,
      suppressedFailures: 10,
    },
  ]);
  assert.ok(diagnostics.every((diagnostic) => Object.isFrozen(diagnostic)));
});

void test('keeps cumulative suppression and emits one recovery after summaries 12 and 24', () => {
  let state = createFinalityDiagnosticTrackerState();
  const degraded = [];
  for (let failure = 1; failure <= 24; failure += 1) {
    const reduction = recordFinalityDiagnosticFailure(
      state,
      failure === 24 ? 'PROVIDER_CHANGED' : 'FINALITY_HISTORY',
      2_000 + failure,
    );
    state = reduction.state;
    if (reduction.diagnostic !== null) degraded.push(reduction.diagnostic);
  }

  assert.deepEqual(degraded.map((diagnostic) => ({
    failures: diagnostic.consecutiveFailures,
    suppressed: diagnostic.suppressedFailures,
    reason: diagnostic.reasonCode,
  })), [
    { failures: 1, suppressed: 0, reason: 'FINALITY_HISTORY' },
    { failures: 12, suppressed: 10, reason: 'FINALITY_HISTORY' },
    { failures: 24, suppressed: 21, reason: 'PROVIDER_CHANGED' },
  ]);

  const recovered = recordFinalityDiagnosticRecovery(state, 2_100);
  assert.deepEqual(recovered.diagnostic, {
    version: 1,
    phase: 'RECOVERED',
    reasonCode: null,
    degradedAtMs: 2_001,
    observedAtMs: 2_100,
    durationMs: 99,
    consecutiveFailures: 24,
    suppressedFailures: 21,
  });
  assert.deepEqual(recovered.state, createFinalityDiagnosticTrackerState());
  assert.equal(Object.isFrozen(recovered.diagnostic), true);

  const noSecondRecovery = recordFinalityDiagnosticRecovery(recovered.state, 2_101);
  assert.equal(noSecondRecovery.diagnostic, null);
  assert.notStrictEqual(noSecondRecovery.state, recovered.state);
  assert.deepEqual(noSecondRecovery.state, recovered.state);
});

void test('saturates incident totals without stopping the independent cadence', () => {
  const saturationSuppressionBaseline = Number.MAX_SAFE_INTEGER
    - 1
    - Math.floor(Number.MAX_SAFE_INTEGER / 12);
  const seeded = createFinalityDiagnosticTrackerState({
    degradedAtMs: 3_000,
    lastObservedAtMs: 3_010,
    consecutiveFailures: Number.MAX_SAFE_INTEGER,
    suppressedFailures: saturationSuppressionBaseline,
    cadencePosition: Number.MAX_SAFE_INTEGER % 12,
    latestReasonCode: 'FINALITY_ROOT',
  });

  let state = seeded;
  for (let index = 1; index < 5; index += 1) {
    const suppressed = recordFinalityDiagnosticFailure(
      state,
      'FINALITY_CLOCK',
      3_010 + index,
    );
    assert.equal(suppressed.diagnostic, null);
    state = suppressed.state;
  }
  const summary = recordFinalityDiagnosticFailure(state, 'FINALITY_CLOCK', 3_015);
  assert.equal(summary.state.consecutiveFailures, Number.MAX_SAFE_INTEGER);
  assert.equal(summary.state.suppressedFailures, saturationSuppressionBaseline + 4);
  assert.equal(summary.state.cadencePosition, 0);
  assert.equal(summary.diagnostic?.reasonCode, 'FINALITY_CLOCK');

  state = summary.state;
  let emitted = 0;
  for (let index = 0; index < 12; index += 1) {
    const reduction = recordFinalityDiagnosticFailure(state, 'UNKNOWN', 3_016 + index);
    state = reduction.state;
    if (reduction.diagnostic !== null) emitted += 1;
  }
  assert.equal(emitted, 1);
  assert.equal(state.consecutiveFailures, Number.MAX_SAFE_INTEGER);
  assert.equal(state.suppressedFailures, saturationSuppressionBaseline + 15);
  assert.equal(state.cadencePosition, 0);
});

void test('clamps observation time and rejects malformed state, reason and time inputs', () => {
  const first = recordFinalityDiagnosticFailure(
    createFinalityDiagnosticTrackerState(),
    'FINALITY_LIST',
    5_000,
  );
  const second = recordFinalityDiagnosticFailure(first.state, 'FINALITY_PASS', 4_000);
  const recovered = recordFinalityDiagnosticRecovery(second.state, 3_000);

  assert.equal(second.state.lastObservedAtMs, 5_000);
  assert.equal(recovered.diagnostic?.observedAtMs, 5_000);
  assert.equal(recovered.diagnostic?.durationMs, 0);

  for (const seed of [
    null,
    {},
    { ...first.state, extra: true },
    { ...first.state, cadencePosition: 12 },
    { ...first.state, consecutiveFailures: 0 },
    { ...first.state, latestReasonCode: 'FINALITY_BOGUS' },
    {
      ...first.state,
      consecutiveFailures: Number.MAX_SAFE_INTEGER - 1,
      suppressedFailures: Number.MAX_SAFE_INTEGER - 1,
      cadencePosition: 11,
    },
    new Proxy(first.state, {}),
  ]) {
    assert.throws(() => createFinalityDiagnosticTrackerState(seed), TypeError);
  }
  assert.throws(
    () => recordFinalityDiagnosticFailure(first.state, 'BOGUS' as never, 5_001),
    TypeError,
  );
  assert.throws(
    () => recordFinalityDiagnosticFailure(first.state, 'FINALITY_LIST', -1),
    TypeError,
  );
});
