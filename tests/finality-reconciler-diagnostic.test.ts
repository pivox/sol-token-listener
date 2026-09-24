import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FINALITY_RECONCILER_DIAGNOSTIC_REASONS,
  createFinalityReconcilerDiagnostic,
  saturatingDiagnosticIncrement,
} from '../src/domain/finality-reconciler-diagnostic.js';

const REASONS = [
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_CHANGED',
  'FINALITY_LIST',
  'FINALITY_PASS',
  'FINALITY_HISTORY',
  'FINALITY_ROOT',
  'FINALITY_POLL',
  'FINALITY_BLOCK',
  'FINALITY_REVISION',
  'FINALITY_CLOCK',
  'FINALITY_CONTRADICTION',
  'UNKNOWN',
] as const;

void test('publishes the exact frozen diagnostic reason vocabulary', () => {
  assert.deepEqual(FINALITY_RECONCILER_DIAGNOSTIC_REASONS, REASONS);
  assert.equal(Object.isFrozen(FINALITY_RECONCILER_DIAGNOSTIC_REASONS), true);
});

void test('creates exact detached frozen degraded and recovered diagnostics', () => {
  const degradedInput = validDiagnostic();
  const degraded = createFinalityReconcilerDiagnostic(degradedInput);
  const recovered = createFinalityReconcilerDiagnostic(validDiagnostic({
    phase: 'RECOVERED',
    reasonCode: null,
    observedAtMs: 1_300,
    durationMs: 300,
    consecutiveFailures: Number.MAX_SAFE_INTEGER,
    suppressedFailures: Number.MAX_SAFE_INTEGER - 1,
  }));

  assert.deepEqual(Object.keys(degraded), [
    'version',
    'phase',
    'reasonCode',
    'degradedAtMs',
    'observedAtMs',
    'durationMs',
    'consecutiveFailures',
    'suppressedFailures',
  ]);
  assert.equal(Object.isFrozen(degraded), true);
  assert.equal(Object.isFrozen(recovered), true);
  assert.notStrictEqual(degraded, degradedInput);
  assert.deepEqual(degraded, degradedInput);
  assert.equal(recovered.phase, 'RECOVERED');
  assert.equal(recovered.reasonCode, null);
  assert.equal(recovered.durationMs, 300);
});

void test('accepts every closed reason only for a degraded diagnostic', () => {
  for (const reasonCode of REASONS) {
    const diagnostic = createFinalityReconcilerDiagnostic(validDiagnostic({ reasonCode }));
    assert.equal(diagnostic.reasonCode, reasonCode);
  }

  for (const input of [
    validDiagnostic({ reasonCode: null }),
    validDiagnostic({ reasonCode: 'FINALITY_BOGUS' }),
    validDiagnostic({ phase: 'RECOVERED' }),
    validDiagnostic({ phase: 'BROKEN' }),
  ]) {
    assert.throws(() => createFinalityReconcilerDiagnostic(input), isDiagnosticError);
  }
});

void test('rejects non-exact, accessor, proxy and non-plain diagnostic inputs', () => {
  let accessorReads = 0;
  const accessor = Object.defineProperty(validDiagnostic(), 'reasonCode', {
    configurable: true,
    enumerable: true,
    get: () => {
      accessorReads += 1;
      return 'UNKNOWN';
    },
  });
  const symbolExtended = validDiagnostic();
  Object.defineProperty(symbolExtended, Symbol('extra'), {
    enumerable: true,
    value: 'forbidden',
  });

  for (const input of [
    null,
    [],
    new Proxy(validDiagnostic(), {}),
    Object.freeze({ ...validDiagnostic(), extra: true }),
    accessor,
    symbolExtended,
    Object.assign(Object.create(null), validDiagnostic()),
    Object.assign(Object.create({ inherited: true }), validDiagnostic()),
  ]) {
    assert.throws(() => createFinalityReconcilerDiagnostic(input), isDiagnosticError);
  }
  assert.equal(accessorReads, 0);
});

void test('enforces non-negative safe integer bounds and coherent incident timing', () => {
  for (const input of [
    validDiagnostic({ degradedAtMs: -1 }),
    validDiagnostic({ degradedAtMs: -0 }),
    validDiagnostic({ observedAtMs: 999 }),
    validDiagnostic({ observedAtMs: Number.MAX_SAFE_INTEGER + 1 }),
    validDiagnostic({ durationMs: 1 }),
    validDiagnostic({ durationMs: Number.NaN }),
    validDiagnostic({ consecutiveFailures: 0 }),
    validDiagnostic({ consecutiveFailures: 1.5 }),
    validDiagnostic({ consecutiveFailures: Number.MAX_SAFE_INTEGER + 1 }),
    validDiagnostic({ suppressedFailures: -1 }),
    validDiagnostic({ suppressedFailures: 2 }),
  ]) {
    assert.throws(() => createFinalityReconcilerDiagnostic(input), isDiagnosticError);
  }

  const boundary = createFinalityReconcilerDiagnostic(validDiagnostic({
    degradedAtMs: Number.MAX_SAFE_INTEGER,
    observedAtMs: Number.MAX_SAFE_INTEGER,
    consecutiveFailures: Number.MAX_SAFE_INTEGER,
    suppressedFailures: Number.MAX_SAFE_INTEGER,
  }));
  assert.equal(boundary.consecutiveFailures, Number.MAX_SAFE_INTEGER);
  assert.equal(boundary.suppressedFailures, Number.MAX_SAFE_INTEGER);
});

void test('increments valid counters and saturates at Number.MAX_SAFE_INTEGER', () => {
  assert.equal(saturatingDiagnosticIncrement(0), 1);
  assert.equal(
    saturatingDiagnosticIncrement(Number.MAX_SAFE_INTEGER - 1),
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    saturatingDiagnosticIncrement(Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  );

  for (const value of [-1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, '1']) {
    assert.throws(() => saturatingDiagnosticIncrement(value as number), isDiagnosticError);
  }
});

function validDiagnostic(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    phase: 'DEGRADED',
    reasonCode: 'FINALITY_POLL',
    degradedAtMs: 1_000,
    observedAtMs: 1_000,
    durationMs: 0,
    consecutiveFailures: 1,
    suppressedFailures: 0,
    ...overrides,
  };
}

function isDiagnosticError(error: unknown): boolean {
  assert.ok(error instanceof TypeError);
  assert.equal(error.message, 'Invalid finality reconciler diagnostic.');
  return true;
}
