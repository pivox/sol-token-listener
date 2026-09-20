import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FIRST_PROCESSING_COHORT_CAPACITY,
  FIRST_PROCESSING_COHORT_DURATION_MS,
  FIRST_PROCESSING_THRESHOLD_MS,
  assertValidFirstProcessingCanaryEvidence,
  createFirstProcessingCanaryEvidence,
} from '../src/domain/first-processing-canary.js';

const start = 100_000;
const end = start + FIRST_PROCESSING_COHORT_DURATION_MS;

function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    thresholdMs: FIRST_PROCESSING_THRESHOLD_MS,
    cohortCapacity: FIRST_PROCESSING_COHORT_CAPACITY,
    cohortStartedAtMs: start,
    cohortEndsAtMs: end,
    sampledAtMs: end + FIRST_PROCESSING_THRESHOLD_MS,
    overflowed: false,
    eligibleCount: 1,
    completedCount: 1,
    underThresholdCount: 1,
    atOrAboveThresholdCount: 0,
    pendingCount: 0,
    rightCensoredCount: 0,
    tailCensoredCount: 0,
    terminalCount: 0,
    unavailableCount: 0,
    invalidDurationCount: 0,
    p95Ms: FIRST_PROCESSING_THRESHOLD_MS - 1,
    verdict: 'PASS',
    ...overrides,
  };
}

void test('creates an exact detached frozen first-processing canary snapshot', () => {
  const source = evidence();
  const result = createFirstProcessingCanaryEvidence(source);

  assert.deepEqual(Object.keys(result), [
    'version', 'thresholdMs', 'cohortCapacity', 'cohortStartedAtMs', 'cohortEndsAtMs',
    'sampledAtMs', 'overflowed', 'eligibleCount', 'completedCount', 'underThresholdCount',
    'atOrAboveThresholdCount', 'pendingCount', 'rightCensoredCount', 'tailCensoredCount',
    'terminalCount', 'unavailableCount', 'invalidDurationCount', 'p95Ms', 'verdict',
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.notStrictEqual(result, source);
  assert.doesNotThrow(() => { assertValidFirstProcessingCanaryEvidence(result); });
  assert.throws(() => { (result as { verdict: string }).verdict = 'FAIL'; }, TypeError);
});

void test('rejects hostile, non-exact, unsafe, negative, and negative-zero values without reading accessors', () => {
  let accessorReads = 0;
  const invalid = [
    new Proxy(evidence(), {}),
    Object.freeze({ ...evidence(), extra: true }),
    Object.freeze({ ...evidence(), get verdict() { accessorReads += 1; return 'PASS'; } }),
    evidence({ eligibleCount: Number.MAX_SAFE_INTEGER + 1 }),
    evidence({ completedCount: -1 }),
    evidence({ p95Ms: -0 }),
    evidence({ cohortStartedAtMs: -0 }),
  ];
  for (const value of invalid) {
    assert.throws(() => { createFirstProcessingCanaryEvidence(value); }, /invalid/i);
  }
  assert.equal(accessorReads, 0);
});

void test('rejects invalid cohort timing and mismatched totals', () => {
  for (const value of [
    evidence({ cohortEndsAtMs: end + 1 }),
    evidence({ cohortStartedAtMs: Number.MAX_SAFE_INTEGER - 100, cohortEndsAtMs: Number.MAX_SAFE_INTEGER }),
    evidence({ cohortStartedAtMs: Number.MAX_SAFE_INTEGER - FIRST_PROCESSING_COHORT_DURATION_MS
      - FIRST_PROCESSING_THRESHOLD_MS + 1,
    cohortEndsAtMs: Number.MAX_SAFE_INTEGER - FIRST_PROCESSING_THRESHOLD_MS + 1,
    sampledAtMs: Number.MAX_SAFE_INTEGER, verdict: 'INCONCLUSIVE' }),
    evidence({ sampledAtMs: start - 1 }),
    evidence({ pendingCount: 1 }),
    evidence({ completedCount: 2 }),
    evidence({ eligibleCount: 2 }),
    evidence({ eligibleCount: FIRST_PROCESSING_COHORT_CAPACITY + 1,
      completedCount: FIRST_PROCESSING_COHORT_CAPACITY + 1,
      underThresholdCount: FIRST_PROCESSING_COHORT_CAPACITY + 1 }),
    evidence({ overflowed: true, verdict: 'INCONCLUSIVE' }),
  ]) {
    assert.throws(() => { createFirstProcessingCanaryEvidence(value); }, /invalid/i);
  }
});

void test('enforces nullable p95 and bucket consistency at the 44,999/45,000 boundary', () => {
  const zero = evidence({ eligibleCount: 0, completedCount: 0, underThresholdCount: 0,
    p95Ms: null, verdict: 'INCONCLUSIVE' });
  assert.doesNotThrow(() => { createFirstProcessingCanaryEvidence(zero); });
  for (const value of [
    evidence({ p95Ms: null }),
    zeroWithP95(),
    evidence({ p95Ms: FIRST_PROCESSING_THRESHOLD_MS }),
    evidence({ underThresholdCount: 0, atOrAboveThresholdCount: 1,
      p95Ms: FIRST_PROCESSING_THRESHOLD_MS - 1, verdict: 'FAIL' }),
  ]) {
    assert.throws(() => { createFirstProcessingCanaryEvidence(value); }, /invalid/i);
  }
  assert.equal(createFirstProcessingCanaryEvidence(evidence({ p95Ms: 44_999 })).verdict, 'PASS');
  assert.equal(createFirstProcessingCanaryEvidence(evidence({ underThresholdCount: 0,
    atOrAboveThresholdCount: 1, p95Ms: 45_000, verdict: 'FAIL' })).verdict, 'FAIL');
});

void test('derives verdicts for small nearest-rank samples and every incomplete category with failure precedence', () => {
  const cases: readonly [Record<string, unknown>, 'PASS' | 'FAIL' | 'INCONCLUSIVE'][] = [
    [evidence({ eligibleCount: 2, completedCount: 2, underThresholdCount: 2, p95Ms: 44_999 }), 'PASS'],
    [evidence({ eligibleCount: 2, completedCount: 2, underThresholdCount: 1,
      atOrAboveThresholdCount: 1, p95Ms: 45_000, verdict: 'FAIL' }), 'FAIL'],
    [evidence({ sampledAtMs: end + FIRST_PROCESSING_THRESHOLD_MS - 1, verdict: 'INCONCLUSIVE' }), 'INCONCLUSIVE'],
    [evidence({ overflowed: true, eligibleCount: FIRST_PROCESSING_COHORT_CAPACITY,
      completedCount: FIRST_PROCESSING_COHORT_CAPACITY,
      underThresholdCount: FIRST_PROCESSING_COHORT_CAPACITY, verdict: 'INCONCLUSIVE' }), 'INCONCLUSIVE'],
    [evidence({ eligibleCount: 2, completedCount: 1, underThresholdCount: 1,
      pendingCount: 1, rightCensoredCount: 1, verdict: 'INCONCLUSIVE' }), 'INCONCLUSIVE'],
    [evidence({ eligibleCount: 2, completedCount: 1, underThresholdCount: 1,
      pendingCount: 1, tailCensoredCount: 1, verdict: 'INCONCLUSIVE' }), 'INCONCLUSIVE'],
    [evidence({ eligibleCount: 2, terminalCount: 1, verdict: 'INCONCLUSIVE' }), 'INCONCLUSIVE'],
    [evidence({ eligibleCount: 2, unavailableCount: 1, verdict: 'INCONCLUSIVE' }), 'INCONCLUSIVE'],
    [evidence({ eligibleCount: 2, invalidDurationCount: 1, verdict: 'FAIL' }), 'FAIL'],
    [evidence({ eligibleCount: 2, invalidDurationCount: 1, verdict: 'INCONCLUSIVE' }), 'FAIL'],
  ];
  for (const [input, verdict] of cases) {
    if (input.verdict !== verdict) {
      assert.throws(() => { createFirstProcessingCanaryEvidence(input); }, /invalid/i);
    } else {
      assert.equal(createFirstProcessingCanaryEvidence(input).verdict, verdict);
    }
  }
});

function zeroWithP95(): Record<string, unknown> {
  return evidence({ eligibleCount: 0, completedCount: 0, underThresholdCount: 0,
    p95Ms: 0, verdict: 'INCONCLUSIVE' });
}
