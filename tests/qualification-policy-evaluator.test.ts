import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { QUALIFICATION_REASON_CODES, type QualificationReasonCode } from '../src/domain/qualification-reasons.js';
import type { QualificationCalibrationFacts, EffectiveQualificationProfile } from '../src/domain/qualification.js';
import { parseQualificationProfile } from '../src/qualification/qualification-profile.js';
import { evaluateQualificationConditions } from '../src/qualification/qualification-policy-evaluator.js';

function profile(change: Partial<Record<QualificationReasonCode, Partial<EffectiveQualificationProfile['conditionPolicies'][number]>>> = {}): EffectiveQualificationProfile {
  const raw = JSON.parse(readFileSync(new URL('../config/qualification/pumpfun-v1-unvalidated.json', import.meta.url), 'utf8')) as { conditionPolicies: Record<string, unknown>[] };
  raw.conditionPolicies = raw.conditionPolicies.map((policy) => ({ ...policy, ...change[policy.code as QualificationReasonCode] }));
  return parseQualificationProfile(freeze(raw), null);
}

function freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }

function facts(change: Partial<QualificationCalibrationFacts> = {}): QualificationCalibrationFacts {
  return Object.freeze({
    top1HolderBps: null, top5HoldersBps: null, top10HoldersBps: null,
    maximumRelatedClusterBps: null, maximumSharedFunderCount: null,
    buySimulationSucceeded: null, sellQuoteAvailable: null, roundTripLossBps: null,
    upstreamConditions: Object.freeze([]), ...change,
  });
}

function condition(result: ReturnType<typeof evaluateQualificationConditions>, code: QualificationReasonCode) {
  const value = result.conditions.find((item) => item.code === code);
  assert.ok(value); return value;
}

void test('evaluates calibrated thresholds at their strict boundaries', () => {
  const result = evaluateQualificationConditions(profile({
    HOLDER_CONCENTRATION_EXCEEDED: { maximumTop1Bps: 500, maximumTop5Bps: 700, maximumTop10Bps: 900 },
    RELATED_WALLET_CLUSTER_EXCEEDED: { maximumClusterBps: 400 },
    SHARED_FUNDER_CLUSTER: { minimumSharedFunders: 1 },
  }), facts({ top1HolderBps: 500n, top5HoldersBps: 701n, top10HoldersBps: 900n, maximumRelatedClusterBps: 401n, maximumSharedFunderCount: 1 }), Object.freeze([]));
  assert.equal(condition(result, 'HOLDER_CONCENTRATION_EXCEEDED').status, 'TRIGGERED');
  assert.equal(condition(result, 'RELATED_WALLET_CLUSTER_EXCEEDED').status, 'TRIGGERED');
  assert.equal(condition(result, 'SHARED_FUNDER_CLUSTER').status, 'TRIGGERED');
  assert.deepEqual(result.blockers, []);
});

void test('handles unavailable calibrated observations without cross-condition inference', () => {
  const result = evaluateQualificationConditions(profile({
    HOLDER_CONCENTRATION_EXCEEDED: { mode: 'ENFORCED', maximumTop1Bps: null, maximumTop5Bps: 500, maximumTop10Bps: null },
    ROUND_TRIP_LOSS_EXCEEDED: { maximumRoundTripLossBps: 3000 },
  }), facts({ top5HoldersBps: null, roundTripLossBps: 3001n }), Object.freeze([]));
  assert.equal(condition(result, 'HOLDER_CONCENTRATION_EXCEEDED').status, 'NOT_CONFIGURED');
  assert.equal(condition(result, 'ROUND_TRIP_LOSS_EXCEEDED').status, 'TRIGGERED');
  assert.deepEqual(result.blockers, ['ROUND_TRIP_LOSS_EXCEEDED']);
});

void test('rejects incomplete effective profiles before evaluating their policies', () => {
  const base = profile();
  const incomplete = Object.freeze({ ...base, rules: Object.freeze([]) }) as EffectiveQualificationProfile;
  assert.throws(() => evaluateQualificationConditions(incomplete, facts(), Object.freeze([])), /PROFILE_SCHEMA_INVALID/u);
});

void test('uses strict calibrated boundaries and stable upstream blockers', () => {
  const calibrated = profile({
    HOLDER_CONCENTRATION_EXCEEDED: { mode: 'ENFORCED', maximumTop1Bps: 100, maximumTop5Bps: 200, maximumTop10Bps: 300 },
    RELATED_WALLET_CLUSTER_EXCEEDED: { mode: 'ENFORCED', maximumClusterBps: 400 },
    ROUND_TRIP_LOSS_EXCEEDED: { mode: 'ENFORCED', maximumRoundTripLossBps: 3000 },
    METADATA_FETCH_FAILED: { mode: 'REPORT_ONLY' }, STALE_DATA: { mode: 'ENFORCED' },
  });
  const result = evaluateQualificationConditions(calibrated, facts({
    top1HolderBps: 100n, top5HoldersBps: 200n, top10HoldersBps: 300n, maximumRelatedClusterBps: 400n,
    roundTripLossBps: 3000n, sellQuoteAvailable: true,
    upstreamConditions: Object.freeze([Object.freeze({ code: 'METADATA_FETCH_FAILED', triggered: true }), Object.freeze({ code: 'STALE_DATA', triggered: true })]),
  }), Object.freeze([]));
  for (const code of ['HOLDER_CONCENTRATION_EXCEEDED', 'RELATED_WALLET_CLUSTER_EXCEEDED', 'ROUND_TRIP_LOSS_EXCEEDED', 'SELL_QUOTE_UNAVAILABLE'] as const) assert.equal(condition(result, code).status, 'PASSED');
  assert.equal(condition(result, 'METADATA_FETCH_FAILED').status, 'TRIGGERED');
  assert.deepEqual(result.blockers, ['STALE_DATA']);
});

void test('triggers each configured holder threshold only one basis point above its boundary', () => {
  const calibrated = profile({ HOLDER_CONCENTRATION_EXCEEDED: { mode: 'ENFORCED', maximumTop1Bps: 100, maximumTop5Bps: 200, maximumTop10Bps: 300 } });
  for (const change of [
    { top1HolderBps: 101n, top5HoldersBps: 200n, top10HoldersBps: 300n },
    { top1HolderBps: 100n, top5HoldersBps: 201n, top10HoldersBps: 300n },
    { top1HolderBps: 100n, top5HoldersBps: 200n, top10HoldersBps: 301n },
  ]) assert.equal(condition(evaluateQualificationConditions(calibrated, facts(change), Object.freeze([])), 'HOLDER_CONCENTRATION_EXCEEDED').status, 'TRIGGERED');
});

void test('rejects malformed effective profile copies before reading facts', () => {
  const base = profile();
  const candidates = [
    Object.freeze({ ...base, id: '' }),
    Object.freeze({ ...base, dimensionMaximums: Object.freeze({ preparation: 14, socialAuthenticity: 25, onchainHealth: 60 }) }),
    Object.freeze({ ...base, conditionPolicies: Object.freeze(base.conditionPolicies.map((item) => Object.freeze(item.code === 'STALE_DATA' ? { ...item, maximumClusterBps: 1 } : item))) }),
    Object.freeze({ ...base, conditionPolicies: Object.freeze(base.conditionPolicies.map((item) => Object.freeze(item.code === 'ROUND_TRIP_LOSS_EXCEEDED' ? { ...item, maximumRoundTripLossBps: -0 } : item))) }),
    Object.freeze({ ...base, fingerprint: '0'.repeat(64) }),
  ];
  for (const candidate of candidates) assert.throws(() => evaluateQualificationConditions(candidate as EffectiveQualificationProfile, facts(), Object.freeze([])), /PROFILE_SCHEMA_INVALID/u);
});

void test('evaluates boolean calibrated checks and disabled/upstream policies', () => {
  const result = evaluateQualificationConditions(profile({
    CREATOR_EARLY_SELL: { mode: 'DISABLED' },
    MINT_SOCIAL_MISMATCH: { mode: 'REPORT_ONLY' },
    BUY_SIMULATION_FAILED: { mode: 'ENFORCED' }, SELL_QUOTE_UNAVAILABLE: { mode: 'ENFORCED' },
  }), facts({ buySimulationSucceeded: false, sellQuoteAvailable: false, upstreamConditions: Object.freeze([
    Object.freeze({ code: 'CREATOR_EARLY_SELL', triggered: true }),
    Object.freeze({ code: 'MINT_SOCIAL_MISMATCH', triggered: true }),
  ]) }), Object.freeze([]));
  assert.equal(condition(result, 'CREATOR_EARLY_SELL').status, 'DISABLED');
  assert.equal(condition(result, 'MINT_SOCIAL_MISMATCH').status, 'TRIGGERED');
  assert.equal(condition(result, 'BUY_SIMULATION_FAILED').status, 'TRIGGERED');
  assert.equal(condition(result, 'SELL_QUOTE_UNAVAILABLE').status, 'TRIGGERED');
  assert.deepEqual(result.blockers, ['BUY_SIMULATION_FAILED', 'SELL_QUOTE_UNAVAILABLE']);
});

void test('uses stable legacy reason ordering and returns deeply frozen safe results', () => {
  const legacy = Object.freeze(['METADATA_FETCH_FAILED', 'CREATOR_EARLY_SELL', 'METADATA_FETCH_FAILED'] as QualificationReasonCode[]);
  const result = evaluateQualificationConditions(profile({ METADATA_FETCH_FAILED: { mode: 'ENFORCED' } }), facts(), legacy);
  assert.equal(result.conditions.length, QUALIFICATION_REASON_CODES.length);
  assert.deepEqual(result.conditions.map((item) => item.code), QUALIFICATION_REASON_CODES);
  assert.deepEqual(result.blockers, ['CREATOR_EARLY_SELL', 'METADATA_FETCH_FAILED']);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.conditions)); assert.ok(Object.isFrozen(result.blockers));
  for (const item of result.conditions) { assert.ok(Object.isFrozen(item)); assert.ok(Object.isFrozen(item.observed)); assert.ok(Object.isFrozen(item.thresholds)); }
  assert.throws(() => evaluateQualificationConditions(profile(), facts(), ['INVALID'] as unknown as QualificationReasonCode[]));
  assert.throws(() => evaluateQualificationConditions(profile(), facts(), ['CREATOR_EARLY_SELL'] as QualificationReasonCode[]));
});
