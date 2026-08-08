import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { QUALIFICATION_REASON_CODES } from '../src/domain/qualification-reasons.js';
import {
  QUALIFICATION_CONDITION_MODES,
  QUALIFICATION_CONDITION_STATUSES,
  assertValidQualificationFacts,
  type QualificationCalibrationFacts,
} from '../src/domain/qualification.js';
import {
  loadQualificationProfile,
  parseQualificationProfile,
} from '../src/qualification/qualification-profile.js';

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

void test('rejects mutations of the canonical reason-code registry', () => {
  const exportedCodes = QUALIFICATION_REASON_CODES as unknown as string[];
  assert.throws(() => { exportedCodes.push('NOT_A_REASON'); });
  assertInvalidFacts(Object.freeze({
    ...canonicalFacts(),
    upstreamConditions: Object.freeze([Object.freeze({
      code: 'NOT_A_REASON',
      triggered: false,
    })]),
  }));
});

void test('rejects pre-initialization mutations of the canonical reason-code registry', () => {
  const script = `
    import { QUALIFICATION_REASON_CODES } from './src/domain/qualification-reasons.js';
    try { QUALIFICATION_REASON_CODES.push('PREIMPORT_FOREIGN'); } catch {}
    const { assertValidQualificationFacts } = await import('./src/domain/qualification.js');
    const facts = Object.freeze({
      top1HolderBps: 2_000n,
      top5HoldersBps: 5_000n,
      top10HoldersBps: 7_000n,
      maximumRelatedClusterBps: 3_000n,
      maximumSharedFunderCount: 1,
      buySimulationSucceeded: true,
      sellQuoteAvailable: true,
      roundTripLossBps: 3_000n,
      upstreamConditions: Object.freeze([Object.freeze({
        code: 'PREIMPORT_FOREIGN',
        triggered: false,
      })]),
    });
    try {
      assertValidQualificationFacts(facts);
      process.exitCode = 1;
    } catch {}
  `;
  const result = spawnSync(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    script,
  ], { cwd: process.cwd(), encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
});

void test('normalizes, freezes, and canonically fingerprints a complete profile', () => {
  const first = parseQualificationProfile(freeze(validRawProfile()), null);
  const reordered = parseQualificationProfile(freeze(reorderedRawProfile()), null);
  const overridden = parseQualificationProfile(freeze(validRawProfile()), 61);

  assert.match(first.fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(reordered.fingerprint, first.fingerprint);
  assert.notEqual(overridden.fingerprint, first.fingerprint);
  assert.equal(overridden.minimumTotalScore, 61);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.rules), true);
  assert.equal(Object.isFrozen(first.conditionPolicies), true);
  assert.equal(Object.isFrozen(first.dimensionMaximums), true);
  assert.equal(Object.isFrozen(first.rules[0]), true);
  assert.equal(Object.isFrozen(first.conditionPolicies[0]), true);
});

void test('rejects malformed profile schemas and hostile direct-object shapes', () => {
  const invalid = [
    { ...validRawProfile(), extra: true },
    { ...validRawProfile(), schemaVersion: 2 },
    { ...validRawProfile(), status: 'VALIDATED' },
    { ...validRawProfile(), minimumTotalScore: Number.MAX_SAFE_INTEGER + 1 },
    { ...validRawProfile(), rules: [...validRawProfile().rules, validRawProfile().rules[0]] },
    { ...validRawProfile(), dimensionMaximums: { preparation: 14, socialAuthenticity: 25, onchainHealth: 60 } },
    { ...validRawProfile(), conditionPolicies: validRawProfile().conditionPolicies.slice(1) },
    { ...validRawProfile(), conditionPolicies: [...validRawProfile().conditionPolicies, validRawProfile().conditionPolicies[0]] },
    { ...validRawProfile(), conditionPolicies: validRawProfile().conditionPolicies.map((policy) => policy.code === 'STALE_DATA' ? { ...policy, mode: 'BAD' } : policy) },
    { ...validRawProfile(), conditionPolicies: validRawProfile().conditionPolicies.map((policy) => policy.code === 'ROUND_TRIP_LOSS_EXCEEDED' ? { ...policy, maximumRoundTripLossBps: 10_001 } : policy) },
    { ...validRawProfile(), conditionPolicies: validRawProfile().conditionPolicies.map((policy) => policy.code === 'STALE_DATA' ? { ...policy, maximumTop1Bps: 1 } : policy) },
    { ...validRawProfile(), rules: validRawProfile().rules.map((rule, index) => index === 0 ? { ...rule, message: '' } : rule) },
  ];
  for (const profile of invalid) assert.throws(() => parseQualificationProfile(freeze(profile), null), /PROFILE_SCHEMA_INVALID/u);

  let accessorRead = false;
  const accessor = Object.freeze(Object.defineProperty(validRawProfile(), 'id', {
    enumerable: true,
    get(): string { accessorRead = true; return 'pumpfun-v1-initial'; },
  }));
  assert.throws(() => parseQualificationProfile(accessor, null), /PROFILE_SCHEMA_INVALID/u);
  assert.equal(accessorRead, false);
  assert.throws(() => parseQualificationProfile(validRawProfile(), null), /PROFILE_SCHEMA_INVALID/u);
  const proxy = new Proxy(freeze(validRawProfile()), hostileProxyHandler(() => { throw new Error('trap'); }));
  assert.throws(() => parseQualificationProfile(proxy, null), /PROFILE_SCHEMA_INVALID/u);
});

void test('rejects custom object and array prototypes at every profile boundary', () => {
  const raw = validRawProfile();
  const customObjectPrototype = Object.freeze({ custom: true });
  const customArrayPrototype = Object.create(Array.prototype) as unknown[];
  const [firstRule, ...remainingRules] = raw.rules;
  const [firstPolicy, ...remainingPolicies] = raw.conditionPolicies;
  if (firstRule === undefined || firstPolicy === undefined) throw new Error('Fixture must contain rules and policies.');
  const invalid = [
    withPrototype(raw, customObjectPrototype),
    freeze({ ...raw, dimensionMaximums: withPrototype(raw.dimensionMaximums, customObjectPrototype) }),
    freeze({ ...raw, rules: [withPrototype(firstRule, customObjectPrototype), ...remainingRules] }),
    freeze({ ...raw, conditionPolicies: [withPrototype(firstPolicy, customObjectPrototype), ...remainingPolicies] }),
    freeze({ ...raw, rules: withPrototype([...raw.rules], customArrayPrototype) }),
    freeze({ ...raw, conditionPolicies: withPrototype([...raw.conditionPolicies], customArrayPrototype) }),
  ];
  for (const profile of invalid) assert.throws(() => parseQualificationProfile(freeze(profile), null), /PROFILE_SCHEMA_INVALID/u);

  let arrayTraps = 0;
  const rulesProxy = new Proxy([], hostileProxyHandler(() => { arrayTraps += 1; }));
  assert.throws(() => parseQualificationProfile(Object.freeze({ ...raw, rules: rulesProxy }), null), /PROFILE_SCHEMA_INVALID/u);
  assert.equal(arrayTraps, 0);
});

void test('loads default and custom profiles with bounded, redacted failures', () => {
  const defaultProfile = loadQualificationProfile({ profilePath: null, minimumScoreOverride: null });
  assert.equal(defaultProfile.id, 'pumpfun-v1-initial');
  const customProfile = loadQualificationProfile({
    profilePath: './profile.json',
    minimumScoreOverride: null,
    workingDirectory: '/safe',
    readFile: () => Buffer.from(JSON.stringify(validRawProfile())),
  });
  assert.equal(customProfile.id, 'pumpfun-v1-initial');
  for (const readFile of [
    () => Buffer.alloc(65_537),
    () => Buffer.from('{'),
    () => { throw new Error('secret /custom/path'); },
  ]) {
    assert.throws(
      () => loadQualificationProfile({ profilePath: './profile.json', minimumScoreOverride: null, readFile }),
      (error: unknown) => error instanceof Error && /^(PROFILE_TOO_LARGE|PROFILE_JSON_INVALID|PROFILE_READ_FAILED)$/u.test(error.message) && !error.message.includes('secret'),
    );
  }
});

interface RawRule {
  readonly signal: string;
  readonly dimension: string;
  readonly weight: number;
  readonly required: boolean;
  readonly message: string;
}

interface RawPolicy {
  readonly code: string;
  readonly mode: string;
  readonly maximumTop1Bps: number | null;
  readonly maximumTop5Bps: number | null;
  readonly maximumTop10Bps: number | null;
  readonly maximumClusterBps: number | null;
  readonly minimumSharedFunders: number | null;
  readonly maximumRoundTripLossBps: number | null;
}

interface RawProfile {
  readonly schemaVersion: number;
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly minimumTotalScore: number;
  readonly dimensionMaximums: { readonly preparation: number; readonly socialAuthenticity: number; readonly onchainHealth: number };
  readonly rules: readonly RawRule[];
  readonly conditionPolicies: readonly RawPolicy[];
}

function validRawProfile(): RawProfile {
  return {
    schemaVersion: 1,
    id: 'pumpfun-v1-initial',
    version: 1,
    status: 'UNVALIDATED_RULE_SET',
    minimumTotalScore: 60,
    dimensionMaximums: { preparation: 15, socialAuthenticity: 25, onchainHealth: 60 },
    rules: [
      { signal: 'imageValid', dimension: 'preparation', weight: 15, required: true, message: 'Image is valid.' },
      { signal: 'socialCrossLinkConfirmed', dimension: 'socialAuthenticity', weight: 25, required: true, message: 'Social cross-link is confirmed.' },
      { signal: 'creatorHasNotSold', dimension: 'onchainHealth', weight: 20, required: true, message: 'Creator has not sold.' },
      { signal: 'reverseQuoteAvailable', dimension: 'onchainHealth', weight: 20, required: false, message: 'Reverse quote is available.' },
      { signal: 'externalBuyersObserved', dimension: 'onchainHealth', weight: 20, required: false, message: 'External buyers are observed.' },
    ],
    conditionPolicies: QUALIFICATION_REASON_CODES.map((code) => ({
      code,
      mode: code === 'CREATOR_REPEAT_DUMPER' ? 'DISABLED' : [
        'MINT_SOCIAL_MISMATCH', 'IMPERSONATION_SUSPECTED', 'HOLDER_CONCENTRATION_EXCEEDED',
        'RELATED_WALLET_CLUSTER_EXCEEDED', 'SHARED_FUNDER_CLUSTER', 'METADATA_FETCH_FAILED',
      ].includes(code) ? 'REPORT_ONLY' : 'ENFORCED',
      maximumTop1Bps: null,
      maximumTop5Bps: null,
      maximumTop10Bps: null,
      maximumClusterBps: null,
      minimumSharedFunders: code === 'SHARED_FUNDER_CLUSTER' ? 1 : null,
      maximumRoundTripLossBps: code === 'ROUND_TRIP_LOSS_EXCEEDED' ? 3000 : null,
    })),
  };
}

function reorderedRawProfile(): RawProfile {
  const source = validRawProfile();
  return {
    conditionPolicies: [...source.conditionPolicies].reverse().map((policy) => ({ ...policy })),
    rules: [...source.rules].reverse().map((rule) => ({ ...rule })),
    dimensionMaximums: { onchainHealth: 60, preparation: 15, socialAuthenticity: 25 },
    minimumTotalScore: 60,
    status: 'UNVALIDATED_RULE_SET',
    version: 1,
    id: 'pumpfun-v1-initial',
    schemaVersion: 1,
  };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function withPrototype<T extends object>(value: T, prototype: object): T {
  return Object.freeze(Object.assign(Object.create(prototype), value)) as T;
}

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
