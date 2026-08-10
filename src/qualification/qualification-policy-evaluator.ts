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
import { QUALIFICATION_REASON_CODES, type QualificationReasonCode } from '../domain/qualification-reasons.js';
import { assertValidEffectiveQualificationProfile } from './qualification-profile.js';

const REASON_CODES = QUALIFICATION_REASON_CODES;
const REASON_SET: ReadonlySet<string> = new Set(REASON_CODES);

export interface QualificationConditionResult {
  readonly conditions: readonly QualificationConditionEvidence[];
  readonly blockers: readonly QualificationReasonCode[];
}

export function evaluateQualificationConditions(
  profile: EffectiveQualificationProfile,
  facts: QualificationCalibrationFacts,
  legacyTriggeredCodes: readonly QualificationReasonCode[],
): QualificationConditionResult {
  assertValidEffectiveQualificationProfile(profile);
  const policies = new Map(profile.conditionPolicies.map((policy) => [policy.code, policy]));
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
    case 'HOLDER_CONCENTRATION_EXCEEDED': return triggeredByTrustedSource(holder(policy, facts), upstream.get(code), legacy.has(code));
    case 'RELATED_WALLET_CLUSTER_EXCEEDED': return triggeredByTrustedSource(maximum(code, policy.mode, facts.maximumRelatedClusterBps, policy.maximumClusterBps, 'maximumRelatedClusterBps', 'maximumClusterBps', 'Related wallet cluster exceeds the configured threshold.'), upstream.get(code), legacy.has(code));
    case 'SHARED_FUNDER_CLUSTER': return triggeredByTrustedSource(minimum(policy, facts.maximumSharedFunderCount), upstream.get(code), legacy.has(code));
    case 'BUY_SIMULATION_FAILED': return triggeredByTrustedSource(booleanCondition(code, policy.mode, facts.buySimulationSucceeded, 'buySimulationSucceeded', 'Buy simulation failed.'), upstream.get(code), legacy.has(code));
    case 'SELL_QUOTE_UNAVAILABLE': return triggeredByTrustedSource(booleanCondition(code, policy.mode, facts.sellQuoteAvailable, 'sellQuoteAvailable', 'Sell quote is unavailable.'), upstream.get(code), legacy.has(code));
    case 'ROUND_TRIP_LOSS_EXCEEDED': return triggeredByTrustedSource(maximum(code, policy.mode, facts.roundTripLossBps, policy.maximumRoundTripLossBps, 'roundTripLossBps', 'maximumRoundTripLossBps', 'Perte aller-retour supérieure au seuil configuré.'), upstream.get(code), legacy.has(code));
    default: {
      const triggered = legacy.has(code) ? true : upstream.get(code);
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
  const observed = { top1HolderBps: facts.top1HolderBps, top5HoldersBps: facts.top5HoldersBps, top10HoldersBps: facts.top10HoldersBps };
  const thresholds = { maximumTop1Bps: policy.maximumTop1Bps === null ? null : BigInt(policy.maximumTop1Bps), maximumTop5Bps: policy.maximumTop5Bps === null ? null : BigInt(policy.maximumTop5Bps), maximumTop10Bps: policy.maximumTop10Bps === null ? null : BigInt(policy.maximumTop10Bps) };
  if (configured.some(([, value, threshold]) => value !== null && threshold !== null && value > BigInt(threshold))) return evidence('HOLDER_CONCENTRATION_EXCEEDED', policy.mode, 'TRIGGERED', observed, thresholds, 'Holder concentration exceeds the configured threshold.');
  if (configured.some(([, value]) => value === null)) return evidence('HOLDER_CONCENTRATION_EXCEEDED', policy.mode, 'UNKNOWN', observed, thresholds, 'Holder concentration is unavailable.');
  if (pairs.some(([, , threshold]) => threshold === null)) return evidence('HOLDER_CONCENTRATION_EXCEEDED', policy.mode, 'NOT_CONFIGURED', observed, thresholds, 'Holder concentration is not fully configured.');
  return evidence('HOLDER_CONCENTRATION_EXCEEDED', policy.mode, 'PASSED', observed, thresholds, 'Holder concentration passed.');
}

function maximum(code: QualificationReasonCode, mode: QualificationConditionMode, observedValue: bigint | null, thresholdValue: number | null, observedKey: string, thresholdKey: string, triggeredMessage: string): QualificationConditionEvidence {
  const observed = { [observedKey]: observedValue };
  const thresholds = { [thresholdKey]: thresholdValue === null ? null : BigInt(thresholdValue) };
  if (thresholdValue === null) return evidence(code, mode, 'NOT_CONFIGURED', observed, thresholds, 'Condition is not configured.');
  if (observedValue === null) return evidence(code, mode, 'UNKNOWN', observed, thresholds, 'Condition observation is unavailable.');
  return evidence(code, mode, observedValue > BigInt(thresholdValue) ? 'TRIGGERED' : 'PASSED', observed, thresholds, observedValue > BigInt(thresholdValue) ? triggeredMessage : 'Condition passed.');
}

function minimum(policy: QualificationConditionPolicy, observedValue: number | null): QualificationConditionEvidence {
  const threshold = policy.minimumSharedFunders;
  if (threshold === null) return evidence('SHARED_FUNDER_CLUSTER', policy.mode, 'NOT_CONFIGURED', { maximumSharedFunderCount: observedValue }, { minimumSharedFunders: null }, 'Shared funder cluster is not configured.');
  const observed = { maximumSharedFunderCount: observedValue }; const thresholds = { minimumSharedFunders: threshold };
  if (observedValue === null) return evidence('SHARED_FUNDER_CLUSTER', policy.mode, 'UNKNOWN', observed, thresholds, 'Shared funder observation is unavailable.');
  return evidence('SHARED_FUNDER_CLUSTER', policy.mode, observedValue >= threshold ? 'TRIGGERED' : 'PASSED', observed, thresholds, observedValue >= threshold ? 'Shared funder cluster meets the configured minimum.' : 'Shared funder cluster passed.');
}

function booleanCondition(code: QualificationReasonCode, mode: QualificationConditionMode, observedValue: boolean | null, observedKey: string, triggeredMessage: string): QualificationConditionEvidence {
  const observed = { [observedKey]: observedValue }; const thresholds = {};
  if (observedValue === null) return evidence(code, mode, 'UNKNOWN', observed, thresholds, 'Condition observation is unavailable.');
  return evidence(code, mode, observedValue ? 'PASSED' : 'TRIGGERED', observed, thresholds, observedValue ? 'Condition passed.' : triggeredMessage);
}

function evidence(code: QualificationReasonCode, mode: QualificationConditionMode, status: QualificationConditionStatus, observed: Record<string, bigint | number | boolean | null>, thresholds: Record<string, bigint | number | null>, message: string): QualificationConditionEvidence {
  return Object.freeze({ code, mode, status, observed: Object.freeze({ ...observed }), thresholds: Object.freeze({ ...thresholds }), message });
}

function validatedLegacyCodes(value: readonly QualificationReasonCode[]): ReadonlySet<QualificationReasonCode> {
  if (!Array.isArray(value) || isProxy(value) || value.length > REASON_CODES.length) throw new TypeError('Legacy triggered codes must be a bounded array.');
  const entries = denseFrozenArray(value, 'Legacy triggered codes');
  const result = new Set<QualificationReasonCode>();
  for (const entry of entries) { if (typeof entry !== 'string' || !REASON_SET.has(entry)) throw new TypeError('Legacy triggered code is invalid.'); result.add(entry as QualificationReasonCode); }
  return result;
}

function triggeredByTrustedSource(condition: QualificationConditionEvidence, upstream: boolean | undefined, legacy: boolean): QualificationConditionEvidence {
  if (upstream === true) return evidence(condition.code, condition.mode, 'TRIGGERED', condition.observed, condition.thresholds, 'Upstream condition triggered.');
  return legacy ? evidence(condition.code, condition.mode, 'TRIGGERED', condition.observed, condition.thresholds, 'Legacy condition triggered.') : condition;
}

function denseFrozenArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value) || isProxy(value) || !Object.isFrozen(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError(`${name} must be a frozen array.`);
  const source = Object.getOwnPropertyDescriptors(value); if (Object.getOwnPropertyNames(value).length !== value.length + 1) throw new TypeError(`${name} must be dense.`);
  const entries: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) { const descriptor = source[String(index)]; if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError(`${name} must contain data entries.`); entries.push(descriptor.value); }
  return entries;
}
