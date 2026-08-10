import { isProxy } from 'node:util/types';
import {
  assertValidQualificationFacts,
  type EffectiveQualificationProfile,
  type QualificationCalibrationFacts,
  type QualificationConditionEvidence,
  type QualificationConditionMode,
  type QualificationConditionPolicy,
  type QualificationConditionStatus,
} from '../domain/qualification.js';
import type { QualificationReasonCode } from '../domain/qualification-reasons.js';

const REASON_CODES = Object.freeze([
  'CREATOR_EARLY_SELL', 'CREATOR_REPEAT_DUMPER', 'MINT_SOCIAL_MISMATCH', 'IMPERSONATION_SUSPECTED',
  'HOLDER_CONCENTRATION_EXCEEDED', 'RELATED_WALLET_CLUSTER_EXCEEDED', 'SHARED_FUNDER_CLUSTER',
  'BUY_SIMULATION_FAILED', 'SELL_QUOTE_UNAVAILABLE', 'ROUND_TRIP_LOSS_EXCEEDED', 'STALE_DATA',
  'UNSUPPORTED_TOKEN_EXTENSION', 'METADATA_FETCH_FAILED', 'UNSUPPORTED_QUOTE_MINT',
] as const);
const REASON_SET: ReadonlySet<string> = new Set(REASON_CODES);
const MODES: ReadonlySet<string> = new Set(['DISABLED', 'REPORT_ONLY', 'ENFORCED']);
const PROFILE_FIELDS = ['schemaVersion', 'fingerprint', 'id', 'version', 'status', 'minimumTotalScore', 'dimensionMaximums', 'rules', 'conditionPolicies'] as const;
const POLICY_FIELDS = ['code', 'mode', 'maximumTop1Bps', 'maximumTop5Bps', 'maximumTop10Bps', 'maximumClusterBps', 'minimumSharedFunders', 'maximumRoundTripLossBps'] as const;

export interface QualificationConditionResult {
  readonly conditions: readonly QualificationConditionEvidence[];
  readonly blockers: readonly QualificationReasonCode[];
}

export function evaluateQualificationConditions(
  profile: EffectiveQualificationProfile,
  facts: QualificationCalibrationFacts,
  legacyTriggeredCodes: readonly QualificationReasonCode[],
): QualificationConditionResult {
  const policies = validatedPolicies(profile);
  assertValidQualificationFacts(facts);
  const legacy = validatedLegacyCodes(legacyTriggeredCodes);
  const upstream = new Map<QualificationReasonCode, boolean>();
  for (const item of facts.upstreamConditions) upstream.set(item.code, item.triggered);
  const conditions = REASON_CODES.map((code) => {
    const policy = policies.get(code);
    if (policy === undefined) throw new TypeError('Qualification condition policy is invalid.');
    return evaluate(code, policy, facts, upstream, legacy);
  });
  const blockers = conditions.filter((item) => item.status === 'TRIGGERED' && item.mode === 'ENFORCED').map((item) => item.code);
  return Object.freeze({ conditions: Object.freeze(conditions), blockers: Object.freeze(blockers) });
}

function evaluate(code: QualificationReasonCode, policy: QualificationConditionPolicy, facts: QualificationCalibrationFacts, upstream: ReadonlyMap<QualificationReasonCode, boolean>, legacy: ReadonlySet<QualificationReasonCode>): QualificationConditionEvidence {
  if (policy.mode === 'DISABLED') return evidence(code, policy.mode, 'DISABLED', {}, {}, 'Condition disabled.');
  switch (code) {
    case 'HOLDER_CONCENTRATION_EXCEEDED': return holder(policy, facts);
    case 'RELATED_WALLET_CLUSTER_EXCEEDED': return maximum(code, policy.mode, facts.maximumRelatedClusterBps, policy.maximumClusterBps, 'Related wallet cluster exceeds the configured threshold.');
    case 'SHARED_FUNDER_CLUSTER': return minimum(policy, facts.maximumSharedFunderCount);
    case 'BUY_SIMULATION_FAILED': return booleanCondition(code, policy.mode, facts.buySimulationSucceeded, 'Buy simulation failed.');
    case 'SELL_QUOTE_UNAVAILABLE': return booleanCondition(code, policy.mode, facts.sellQuoteAvailable, 'Sell quote is unavailable.');
    case 'ROUND_TRIP_LOSS_EXCEEDED': return maximum(code, policy.mode, facts.roundTripLossBps, policy.maximumRoundTripLossBps, 'Perte aller-retour supérieure au seuil configuré.');
    default: {
      const triggered = upstream.get(code) ?? (legacy.has(code) ? true : undefined);
      return evidence(code, policy.mode, triggered === true ? 'TRIGGERED' : triggered === false ? 'PASSED' : 'UNKNOWN', {}, {}, triggered === true ? 'Upstream condition triggered.' : triggered === false ? 'Upstream condition passed.' : 'Upstream condition is unavailable.');
    }
  }
}

function holder(policy: QualificationConditionPolicy, facts: QualificationCalibrationFacts): QualificationConditionEvidence {
  const pairs = [
    ['top1HolderBps', facts.top1HolderBps, policy.maximumTop1Bps],
    ['top5HoldersBps', facts.top5HoldersBps, policy.maximumTop5Bps],
    ['top10HoldersBps', facts.top10HoldersBps, policy.maximumTop10Bps],
  ] as const;
  const configured = pairs.filter(([, , threshold]) => threshold !== null);
  const observed = Object.fromEntries(pairs.map(([key, value]) => [key, value]));
  const thresholds = Object.fromEntries(pairs.map(([key, , value]) => [key, value === null ? null : BigInt(value)]));
  if (configured.length === 0) return evidence('HOLDER_CONCENTRATION_EXCEEDED', policy.mode, 'NOT_CONFIGURED', observed, thresholds, 'Holder concentration is not configured.');
  if (configured.some(([, value, threshold]) => value !== null && threshold !== null && value > BigInt(threshold))) return evidence('HOLDER_CONCENTRATION_EXCEEDED', policy.mode, 'TRIGGERED', observed, thresholds, 'Holder concentration exceeds the configured threshold.');
  const status: QualificationConditionStatus = configured.some(([, value]) => value === null) ? 'UNKNOWN' : 'PASSED';
  return evidence('HOLDER_CONCENTRATION_EXCEEDED', policy.mode, status, observed, thresholds, status === 'UNKNOWN' ? 'Holder concentration is unavailable.' : 'Holder concentration passed.');
}

function maximum(code: QualificationReasonCode, mode: QualificationConditionMode, observedValue: bigint | null, thresholdValue: number | null, triggeredMessage: string): QualificationConditionEvidence {
  const observed = { value: observedValue };
  const thresholds = { maximum: thresholdValue === null ? null : BigInt(thresholdValue) };
  if (thresholdValue === null) return evidence(code, mode, 'NOT_CONFIGURED', observed, thresholds, 'Condition is not configured.');
  if (observedValue === null) return evidence(code, mode, 'UNKNOWN', observed, thresholds, 'Condition observation is unavailable.');
  return evidence(code, mode, observedValue > BigInt(thresholdValue) ? 'TRIGGERED' : 'PASSED', observed, thresholds, observedValue > BigInt(thresholdValue) ? triggeredMessage : 'Condition passed.');
}

function minimum(policy: QualificationConditionPolicy, observedValue: number | null): QualificationConditionEvidence {
  const threshold = policy.minimumSharedFunders;
  if (threshold === null) return evidence('SHARED_FUNDER_CLUSTER', policy.mode, 'NOT_CONFIGURED', { count: observedValue }, { minimum: null }, 'Shared funder cluster is not configured.');
  const observed = { count: observedValue }; const thresholds = { minimum: threshold };
  if (observedValue === null) return evidence('SHARED_FUNDER_CLUSTER', policy.mode, 'UNKNOWN', observed, thresholds, 'Shared funder observation is unavailable.');
  return evidence('SHARED_FUNDER_CLUSTER', policy.mode, observedValue >= threshold ? 'TRIGGERED' : 'PASSED', observed, thresholds, observedValue >= threshold ? 'Shared funder cluster meets the configured minimum.' : 'Shared funder cluster passed.');
}

function booleanCondition(code: QualificationReasonCode, mode: QualificationConditionMode, observedValue: boolean | null, triggeredMessage: string): QualificationConditionEvidence {
  const observed = { available: observedValue }; const thresholds = {};
  if (observedValue === null) return evidence(code, mode, 'UNKNOWN', observed, thresholds, 'Condition observation is unavailable.');
  return evidence(code, mode, observedValue ? 'PASSED' : 'TRIGGERED', observed, thresholds, observedValue ? 'Condition passed.' : triggeredMessage);
}

function evidence(code: QualificationReasonCode, mode: QualificationConditionMode, status: QualificationConditionStatus, observed: Record<string, bigint | number | boolean | null>, thresholds: Record<string, bigint | number | null>, message: string): QualificationConditionEvidence {
  return Object.freeze({ code, mode, status, observed: Object.freeze({ ...observed }), thresholds: Object.freeze({ ...thresholds }), message });
}

function validatedLegacyCodes(value: readonly QualificationReasonCode[]): ReadonlySet<QualificationReasonCode> {
  const entries = denseFrozenArray(value, 'Legacy triggered codes');
  const result = new Set<QualificationReasonCode>();
  for (const entry of entries) { if (typeof entry !== 'string' || !REASON_SET.has(entry)) throw new TypeError('Legacy triggered code is invalid.'); result.add(entry as QualificationReasonCode); }
  return result;
}

function validatedPolicies(profile: EffectiveQualificationProfile): ReadonlyMap<QualificationReasonCode, QualificationConditionPolicy> {
  exactFrozenObject(profile, PROFILE_FIELDS, 'Qualification profile');
  const profileValues = descriptors(profile, PROFILE_FIELDS, 'Qualification profile');
  if (profileValues.schemaVersion !== 1 || profileValues.status !== 'UNVALIDATED_RULE_SET') throw new TypeError('Qualification profile is invalid.');
  const entries = denseFrozenArray(profileValues.conditionPolicies, 'Qualification condition policies');
  if (entries.length !== REASON_CODES.length) throw new TypeError('Qualification condition policies are invalid.');
  const result = new Map<QualificationReasonCode, QualificationConditionPolicy>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]; exactFrozenObject(entry, POLICY_FIELDS, 'Qualification condition policy');
    const values = descriptors(entry, POLICY_FIELDS, 'Qualification condition policy');
    if (values.code !== REASON_CODES[index] || typeof values.mode !== 'string' || !MODES.has(values.mode)) throw new TypeError('Qualification condition policy is invalid.');
    for (const key of ['maximumTop1Bps', 'maximumTop5Bps', 'maximumTop10Bps', 'maximumClusterBps', 'maximumRoundTripLossBps']) {
      const value = values[key];
      if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000)) throw new TypeError('Qualification condition policy is invalid.');
    }
    if (values.minimumSharedFunders !== null && (!Number.isSafeInteger(values.minimumSharedFunders) || (values.minimumSharedFunders as number) < 1)) throw new TypeError('Qualification condition policy is invalid.');
    result.set(values.code as QualificationReasonCode, entry as QualificationConditionPolicy);
  }
  return result;
}

function exactFrozenObject(value: unknown, fields: readonly string[], name: string): asserts value is object {
  if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value) || !Object.isFrozen(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError(`${name} must be a frozen plain object.`);
  const own = Object.getOwnPropertyNames(value);
  if (own.length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) throw new TypeError(`${name} must contain exact fields.`);
}
function descriptors(value: object, fields: readonly string[], name: string): Record<string, unknown> {
  const source = Object.getOwnPropertyDescriptors(value); const result = Object.create(null) as Record<string, unknown>;
  for (const field of fields) { const descriptor = source[field]; if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError(`${name} must contain data fields.`); result[field] = descriptor.value; }
  return result;
}
function denseFrozenArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value) || isProxy(value) || !Object.isFrozen(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError(`${name} must be a frozen array.`);
  const source = Object.getOwnPropertyDescriptors(value); if (Object.getOwnPropertyNames(value).length !== value.length + 1) throw new TypeError(`${name} must be dense.`);
  const entries: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) { const descriptor = source[String(index)]; if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError(`${name} must contain data entries.`); entries.push(descriptor.value); }
  return entries;
}
