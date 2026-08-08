import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QUALIFICATION_CONDITION_MODES,
  QUALIFICATION_CONDITION_STATUSES,
  assertValidQualificationFacts,
  type QualificationCalibrationFacts,
} from '../src/domain/qualification.js';

const canonicalFacts = (): QualificationCalibrationFacts => Object.freeze({
  top1HolderBps: 2_000n,
  top5HoldersBps: 5_000n,
  top10HoldersBps: 7_000n,
  maximumRelatedClusterBps: 3_000n,
  maximumSharedFunderCount: 1,
  buySimulationSucceeded: true,
  sellQuoteAvailable: true,
  roundTripLossBps: 3_000n,
  upstreamConditions: Object.freeze([
    Object.freeze({ code: 'STALE_DATA' as const, triggered: false }),
  ]),
});

void test('publishes stable calibration registries and accepts deeply frozen bigint facts', () => {
  assert.deepEqual(QUALIFICATION_CONDITION_MODES, [
    'DISABLED', 'REPORT_ONLY', 'ENFORCED',
  ]);
  assert.deepEqual(QUALIFICATION_CONDITION_STATUSES, [
    'PASSED', 'TRIGGERED', 'UNKNOWN', 'NOT_CONFIGURED', 'DISABLED',
  ]);
  assert.doesNotThrow(() => assertValidQualificationFacts(canonicalFacts()));
});

void test('rejects invalid calibration fact values without numeric coercion', () => {
  const facts = canonicalFacts();

  for (const invalid of [
    Object.freeze({ ...facts, top1HolderBps: -1n }),
    Object.freeze({ ...facts, top5HoldersBps: 10_001n }),
    Object.freeze({ ...facts, maximumSharedFunderCount: Number.MAX_SAFE_INTEGER + 1 }),
    Object.freeze({ ...facts, maximumSharedFunderCount: -0 }),
    Object.freeze({ ...facts, buySimulationSucceeded: 1 }),
  ]) {
    assert.throws(() => assertValidQualificationFacts(invalid as QualificationCalibrationFacts));
  }
});

void test('rejects duplicate or foreign upstream condition codes', () => {
  const facts = canonicalFacts();
  assert.throws(() => assertValidQualificationFacts(Object.freeze({
    ...facts,
    upstreamConditions: Object.freeze([
      Object.freeze({ code: 'STALE_DATA' as const, triggered: false }),
      Object.freeze({ code: 'STALE_DATA' as const, triggered: true }),
    ]),
  })));
  assert.throws(() => assertValidQualificationFacts(Object.freeze({
    ...facts,
    upstreamConditions: Object.freeze([
      Object.freeze({ code: 'NOT_A_REASON', triggered: false }),
    ]),
  }) as unknown as QualificationCalibrationFacts));
});

void test('rejects hostile object and array shapes without invoking accessors', () => {
  const facts = canonicalFacts();
  let accessorRead = false;
  const accessor = Object.freeze(Object.defineProperty({ ...facts }, 'top1HolderBps', {
    enumerable: true,
    get(): bigint { accessorRead = true; return 2_000n; },
  }));
  const withSymbol = Object.freeze(Object.assign({ ...facts }, { [Symbol('extra')]: 1 }));
  const sparse = Object.freeze(Object.assign(new Array(2), { 0: Object.freeze({
    code: 'STALE_DATA' as const,
    triggered: false,
  }) })) as unknown as readonly { readonly code: 'STALE_DATA'; readonly triggered: boolean }[];
  const mutableEntry = { code: 'STALE_DATA' as const, triggered: false };

  assert.throws(() => assertValidQualificationFacts(accessor as QualificationCalibrationFacts));
  assert.equal(accessorRead, false);
  assert.throws(() => assertValidQualificationFacts(withSymbol as QualificationCalibrationFacts));
  assert.throws(() => assertValidQualificationFacts(Object.freeze({ ...facts, upstreamConditions: sparse })));
  assert.throws(() => assertValidQualificationFacts(Object.freeze({ ...facts, upstreamConditions: Object.freeze([mutableEntry]) })));
  assert.throws(() => assertValidQualificationFacts(Object.freeze({ ...facts, extra: true }) as QualificationCalibrationFacts));
  const { sellQuoteAvailable: _missing, ...missing } = facts;
  assert.throws(() => assertValidQualificationFacts(Object.freeze(missing) as QualificationCalibrationFacts));
  assert.throws(() => assertValidQualificationFacts({ ...facts }));
  assert.throws(() => assertValidQualificationFacts(Object.freeze({ ...facts, upstreamConditions: [] })));
});
