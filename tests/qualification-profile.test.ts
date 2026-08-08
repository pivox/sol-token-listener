import assert from 'node:assert/strict';
import test from 'node:test';
import { QUALIFICATION_REASON_CODES } from '../src/domain/qualification-reasons.js';
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

const assertInvalidFacts = (facts: unknown): void => {
  assert.throws(() => { assertValidQualificationFacts(facts as QualificationCalibrationFacts); });
};

void test('publishes stable calibration registries and accepts deeply frozen bigint facts', () => {
  assert.deepEqual(QUALIFICATION_CONDITION_MODES, [
    'DISABLED', 'REPORT_ONLY', 'ENFORCED',
  ]);
  assert.deepEqual(QUALIFICATION_CONDITION_STATUSES, [
    'PASSED', 'TRIGGERED', 'UNKNOWN', 'NOT_CONFIGURED', 'DISABLED',
  ]);
  assert.doesNotThrow(() => { assertValidQualificationFacts(canonicalFacts()); });
});

void test('accepts deeply frozen null-prototype calibration facts and entries', () => {
  const entry = Object.freeze(Object.assign(Object.create(null), {
    code: 'STALE_DATA' as const,
    triggered: false,
  }));
  const facts = Object.freeze(Object.assign(Object.create(null), {
    ...canonicalFacts(),
    upstreamConditions: Object.freeze([entry]),
  }));

  assert.doesNotThrow(() => { assertValidQualificationFacts(facts); });
});

void test('rejects invalid basis-point values without numeric coercion', () => {
  const facts = canonicalFacts();
  const fields = [
    'top1HolderBps',
    'top5HoldersBps',
    'top10HoldersBps',
    'maximumRelatedClusterBps',
    'roundTripLossBps',
  ] as const;

  for (const field of fields) {
    for (const value of [-1n, 0n, 10_000n, 10_001n]) {
      const candidate = Object.freeze({ ...facts, [field]: value });
      if (value === 0n || value === 10_000n) {
        assert.doesNotThrow(() => { assertValidQualificationFacts(candidate); });
      } else {
        assertInvalidFacts(candidate);
      }
    }
  }
  assertInvalidFacts(Object.freeze({ ...facts, top1HolderBps: '2000' }));
});

void test('rejects invalid shared-funder counts and nullable booleans', () => {
  const facts = canonicalFacts();
  for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, -0]) {
    assertInvalidFacts(Object.freeze({ ...facts, maximumSharedFunderCount: value }));
  }
  for (const field of ['buySimulationSucceeded', 'sellQuoteAvailable'] as const) {
    assertInvalidFacts(Object.freeze({ ...facts, [field]: 1 }));
  }
});

void test('rejects duplicate, foreign, and malformed upstream conditions', () => {
  const facts = canonicalFacts();
  assertInvalidFacts(Object.freeze({
    ...facts,
    upstreamConditions: Object.freeze([
      Object.freeze({ code: 'STALE_DATA' as const, triggered: false }),
      Object.freeze({ code: 'STALE_DATA' as const, triggered: true }),
    ]),
  }));
  assertInvalidFacts(Object.freeze({
    ...facts,
    upstreamConditions: Object.freeze([Object.freeze({ code: 'NOT_A_REASON', triggered: false })]),
  }));
  assertInvalidFacts(Object.freeze({
    ...facts,
    upstreamConditions: Object.freeze([Object.freeze({ code: 'STALE_DATA' as const })]),
  }));
  assertInvalidFacts(Object.freeze({
    ...facts,
    upstreamConditions: Object.freeze([Object.freeze({
      code: 'STALE_DATA' as const,
      triggered: false,
      extra: true,
    })]),
  }));
  assertInvalidFacts(Object.freeze({
    ...facts,
    upstreamConditions: Object.freeze([Object.freeze(Object.assign(
      { code: 'STALE_DATA' as const, triggered: false },
      { [Symbol('extra')]: true },
    ))]),
  }));
  const accessorEntry = Object.freeze(Object.defineProperty(
    { code: 'STALE_DATA' as const },
    'triggered',
    { enumerable: true, get(): boolean { throw new Error('must not run'); } },
  ));
  assertInvalidFacts(Object.freeze({
    ...facts,
    upstreamConditions: Object.freeze([accessorEntry]),
  }));
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
  }) }));
  const mutableEntry = { code: 'STALE_DATA' as const, triggered: false };

  assertInvalidFacts(accessor);
  assert.equal(accessorRead, false);
  assertInvalidFacts(withSymbol);
  assertInvalidFacts(Object.freeze({ ...facts, upstreamConditions: sparse }));
  assertInvalidFacts(Object.freeze({ ...facts, upstreamConditions: Object.freeze([mutableEntry]) }));
  assertInvalidFacts(Object.freeze({ ...facts, extra: true }));
  const { sellQuoteAvailable: _missing, ...missing } = facts;
  assertInvalidFacts(Object.freeze(missing));
  assertInvalidFacts({ ...facts });
  assertInvalidFacts(Object.freeze({ ...facts, upstreamConditions: [] }));
});

void test('rejects proxies before invoking any root, array, or entry trap', () => {
  let rootTraps = 0;
  let arrayTraps = 0;
  let entryTraps = 0;
  const root = new Proxy(canonicalFacts(), hostileProxyHandler(() => { rootTraps += 1; }));
  const upstreamArray = new Proxy([], hostileProxyHandler(() => { arrayTraps += 1; }));
  const upstreamEntry = new Proxy({}, hostileProxyHandler(() => { entryTraps += 1; }));

  assertInvalidFacts(root);
  assertInvalidFacts(Object.freeze({ ...canonicalFacts(), upstreamConditions: upstreamArray }));
  assertInvalidFacts(Object.freeze({
    ...canonicalFacts(),
    upstreamConditions: Object.freeze([upstreamEntry]),
  }));
  assert.equal(rootTraps, 0);
  assert.equal(arrayTraps, 0);
  assert.equal(entryTraps, 0);
});

void test('uses an immutable private reason-code registry snapshot', () => {
  const exportedCodes = QUALIFICATION_REASON_CODES as unknown as string[];
  exportedCodes.push('NOT_A_REASON');
  try {
    assertInvalidFacts(Object.freeze({
      ...canonicalFacts(),
      upstreamConditions: Object.freeze([Object.freeze({
        code: 'NOT_A_REASON',
        triggered: false,
      })]),
    }));
  } finally {
    exportedCodes.pop();
  }
});

function hostileProxyHandler(onTrap: () => void): ProxyHandler<object> {
  const trap = (): never => {
    onTrap();
    throw new Error('proxy trap must not run');
  };
  return {
    get: trap,
    getOwnPropertyDescriptor: trap,
    getPrototypeOf: trap,
    isExtensible: trap,
    ownKeys: trap,
  };
}
