import { types } from 'node:util';

export const FIRST_PROCESSING_THRESHOLD_MS = 45_000;
export const FIRST_PROCESSING_COHORT_DURATION_MS = 900_000;
export const FIRST_PROCESSING_COHORT_CAPACITY = 50_000;

const EVIDENCE_FIELDS = [
  'version', 'thresholdMs', 'cohortCapacity', 'cohortStartedAtMs', 'cohortEndsAtMs',
  'sampledAtMs', 'overflowed', 'eligibleCount', 'completedCount', 'underThresholdCount',
  'atOrAboveThresholdCount', 'pendingCount', 'rightCensoredCount', 'tailCensoredCount',
  'terminalCount', 'unavailableCount', 'invalidDurationCount', 'p95Ms', 'verdict',
] as const;

type EvidenceField = (typeof EVIDENCE_FIELDS)[number];
export type FirstProcessingCanaryVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface RuntimeFirstProcessingCanaryEvidenceV1 {
  readonly version: 1;
  readonly thresholdMs: 45_000;
  readonly cohortCapacity: 50_000;
  readonly cohortStartedAtMs: number;
  readonly cohortEndsAtMs: number;
  readonly sampledAtMs: number;
  readonly overflowed: boolean;
  readonly eligibleCount: number;
  readonly completedCount: number;
  readonly underThresholdCount: number;
  readonly atOrAboveThresholdCount: number;
  readonly pendingCount: number;
  readonly rightCensoredCount: number;
  readonly tailCensoredCount: number;
  readonly terminalCount: number;
  readonly unavailableCount: number;
  readonly invalidDurationCount: number;
  readonly p95Ms: number | null;
  readonly verdict: FirstProcessingCanaryVerdict;
}

export function assertValidFirstProcessingCanaryEvidence(
  value: unknown,
): asserts value is RuntimeFirstProcessingCanaryEvidenceV1 {
  const evidence = fields(value);
  if (evidence.version !== 1
    || evidence.thresholdMs !== FIRST_PROCESSING_THRESHOLD_MS
    || evidence.cohortCapacity !== FIRST_PROCESSING_COHORT_CAPACITY
    || typeof evidence.overflowed !== 'boolean'
    || !isVerdict(evidence.verdict)
    || !safeNonNegativeInteger(evidence.cohortStartedAtMs)
    || !safeNonNegativeInteger(evidence.cohortEndsAtMs)
    || !safeNonNegativeInteger(evidence.sampledAtMs)
    || !safeNonNegativeInteger(evidence.eligibleCount)
    || !safeNonNegativeInteger(evidence.completedCount)
    || !safeNonNegativeInteger(evidence.underThresholdCount)
    || !safeNonNegativeInteger(evidence.atOrAboveThresholdCount)
    || !safeNonNegativeInteger(evidence.pendingCount)
    || !safeNonNegativeInteger(evidence.rightCensoredCount)
    || !safeNonNegativeInteger(evidence.tailCensoredCount)
    || !safeNonNegativeInteger(evidence.terminalCount)
    || !safeNonNegativeInteger(evidence.unavailableCount)
    || !safeNonNegativeInteger(evidence.invalidDurationCount)) {
    invalid();
  }
  const expectedEnd = safeAdd(evidence.cohortStartedAtMs, FIRST_PROCESSING_COHORT_DURATION_MS);
  const verdictDeadline = expectedEnd === null ? null : safeAdd(expectedEnd, FIRST_PROCESSING_THRESHOLD_MS);
  if (expectedEnd === null || verdictDeadline === null || evidence.cohortEndsAtMs !== expectedEnd
    || evidence.sampledAtMs < evidence.cohortStartedAtMs
    || evidence.eligibleCount > FIRST_PROCESSING_COHORT_CAPACITY
    || (evidence.overflowed && evidence.eligibleCount !== FIRST_PROCESSING_COHORT_CAPACITY)
    || safeAdd(evidence.rightCensoredCount, evidence.tailCensoredCount) !== evidence.pendingCount
    || safeAdd(evidence.underThresholdCount, evidence.atOrAboveThresholdCount) !== evidence.completedCount
    || sum([evidence.completedCount, evidence.pendingCount, evidence.terminalCount,
      evidence.unavailableCount, evidence.invalidDurationCount]) !== evidence.eligibleCount) {
    invalid();
  }
  if (evidence.p95Ms === null) {
    if (evidence.completedCount !== 0) invalid();
  } else {
    if (!safeNonNegativeInteger(evidence.p95Ms) || evidence.completedCount === 0) invalid();
    const rank = (95n * BigInt(evidence.completedCount) + 99n) / 100n;
    if ((rank <= BigInt(evidence.underThresholdCount)
      && evidence.p95Ms >= FIRST_PROCESSING_THRESHOLD_MS)
      || (rank > BigInt(evidence.underThresholdCount)
      && evidence.p95Ms < FIRST_PROCESSING_THRESHOLD_MS)) {
      invalid();
    }
  }
  const validated = evidence as unknown as RuntimeFirstProcessingCanaryEvidenceV1;
  if (validated.verdict !== derivedVerdict(validated)) invalid();
}

export function createFirstProcessingCanaryEvidence(input: unknown): RuntimeFirstProcessingCanaryEvidenceV1 {
  assertValidFirstProcessingCanaryEvidence(input);
  return Object.freeze({
    version: 1,
    thresholdMs: FIRST_PROCESSING_THRESHOLD_MS,
    cohortCapacity: FIRST_PROCESSING_COHORT_CAPACITY,
    cohortStartedAtMs: input.cohortStartedAtMs,
    cohortEndsAtMs: input.cohortEndsAtMs,
    sampledAtMs: input.sampledAtMs,
    overflowed: input.overflowed,
    eligibleCount: input.eligibleCount,
    completedCount: input.completedCount,
    underThresholdCount: input.underThresholdCount,
    atOrAboveThresholdCount: input.atOrAboveThresholdCount,
    pendingCount: input.pendingCount,
    rightCensoredCount: input.rightCensoredCount,
    tailCensoredCount: input.tailCensoredCount,
    terminalCount: input.terminalCount,
    unavailableCount: input.unavailableCount,
    invalidDurationCount: input.invalidDurationCount,
    p95Ms: input.p95Ms,
    verdict: input.verdict,
  });
}

function fields(value: unknown): Record<EvidenceField, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== EVIDENCE_FIELDS.length
      || keys.some((key) => typeof key !== 'string' || !EVIDENCE_FIELDS.includes(key as EvidenceField))) {
      invalid();
    }
    const result = {} as Record<EvidenceField, unknown>;
    for (const key of EVIDENCE_FIELDS) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) invalid();
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    invalid();
  }
}

function derivedVerdict(value: RuntimeFirstProcessingCanaryEvidenceV1): FirstProcessingCanaryVerdict {
  if (value.invalidDurationCount > 0
    || (value.p95Ms !== null && value.p95Ms >= FIRST_PROCESSING_THRESHOLD_MS)) return 'FAIL';
  if (value.sampledAtMs < value.cohortEndsAtMs + FIRST_PROCESSING_THRESHOLD_MS
    || value.eligibleCount === 0 || value.overflowed || value.pendingCount > 0
    || value.terminalCount > 0 || value.unavailableCount > 0) return 'INCONCLUSIVE';
  return 'PASS';
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function safeAdd(left: number, right: number): number | null {
  const total = left + right;
  return Number.isSafeInteger(total) ? total : null;
}

function sum(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    const next = safeAdd(total, value);
    if (next === null) return null;
    total = next;
  }
  return total;
}

function isVerdict(value: unknown): value is FirstProcessingCanaryVerdict {
  return value === 'PASS' || value === 'FAIL' || value === 'INCONCLUSIVE';
}

function invalid(): never {
  throw new TypeError('First processing canary evidence is invalid.');
}
