import { isProxy } from 'node:util/types';
import type { QualificationReasonCode } from './qualification-reasons.js';
import { QUALIFICATION_REASON_CODES } from './qualification-reasons.js';

export const QUALIFICATION_DIMENSIONS = [
  'preparation',
  'socialAuthenticity',
  'onchainHealth',
] as const;

export type QualificationDimension = (typeof QUALIFICATION_DIMENSIONS)[number];
export type QualificationVerdict = 'QUALIFIED' | 'WATCHLISTED' | 'REJECTED';
export type QualificationEvidenceStatus = 'SATISFIED' | 'NOT_SATISFIED' | 'UNKNOWN';

export const QUALIFICATION_CONDITION_MODES = [
  'DISABLED',
  'REPORT_ONLY',
  'ENFORCED',
] as const;

export type QualificationConditionMode =
  (typeof QUALIFICATION_CONDITION_MODES)[number];

export const QUALIFICATION_CONDITION_STATUSES = [
  'PASSED',
  'TRIGGERED',
  'UNKNOWN',
  'NOT_CONFIGURED',
  'DISABLED',
] as const;

export type QualificationConditionStatus =
  (typeof QUALIFICATION_CONDITION_STATUSES)[number];

export const QUALIFICATION_SIGNAL_KEYS = [
  'imageValid',
  'descriptionAvailable',
  'linksReachable',
  'socialCrossLinkConfirmed',
  'creatorHasNotSold',
  'reverseQuoteAvailable',
  'externalBuyersObserved',
] as const;

export type QualificationSignalKey = (typeof QUALIFICATION_SIGNAL_KEYS)[number];

export interface QualificationRule {
  readonly signal: QualificationSignalKey;
  readonly dimension: QualificationDimension;
  readonly weight: number;
  readonly required: boolean;
  readonly message: string;
}

export interface QualificationRuleSet {
  readonly id: string;
  readonly version: number;
  readonly status: 'UNVALIDATED_RULE_SET';
  readonly minimumTotalScore: number;
  readonly rules: readonly QualificationRule[];
}

export interface QualificationUpstreamCondition {
  readonly code: QualificationReasonCode;
  readonly triggered: boolean;
}

export interface QualificationCalibrationFacts {
  readonly top1HolderBps: bigint | null;
  readonly top5HoldersBps: bigint | null;
  readonly top10HoldersBps: bigint | null;
  readonly maximumRelatedClusterBps: bigint | null;
  readonly maximumSharedFunderCount: number | null;
  readonly buySimulationSucceeded: boolean | null;
  readonly sellQuoteAvailable: boolean | null;
  readonly roundTripLossBps: bigint | null;
  readonly upstreamConditions: readonly QualificationUpstreamCondition[];
}

export interface QualificationConditionPolicy {
  readonly code: QualificationReasonCode;
  readonly mode: QualificationConditionMode;
  readonly maximumTop1Bps: number | null;
  readonly maximumTop5Bps: number | null;
  readonly maximumTop10Bps: number | null;
  readonly maximumClusterBps: number | null;
  readonly minimumSharedFunders: number | null;
  readonly maximumRoundTripLossBps: number | null;
}

export interface EffectiveQualificationProfile extends QualificationRuleSet {
  readonly schemaVersion: 1;
  readonly fingerprint: string;
  readonly dimensionMaximums: Readonly<Record<QualificationDimension, number>>;
  readonly conditionPolicies: readonly QualificationConditionPolicy[];
}

export interface QualificationConditionEvidence {
  readonly code: QualificationReasonCode;
  readonly mode: QualificationConditionMode;
  readonly status: QualificationConditionStatus;
  readonly observed: Readonly<Record<string, bigint | number | boolean | null>>;
  readonly thresholds: Readonly<Record<string, bigint | number | null>>;
  readonly message: string;
}

const QUALIFICATION_FACT_FIELDS = [
  'top1HolderBps',
  'top5HoldersBps',
  'top10HoldersBps',
  'maximumRelatedClusterBps',
  'maximumSharedFunderCount',
  'buySimulationSucceeded',
  'sellQuoteAvailable',
  'roundTripLossBps',
  'upstreamConditions',
] as const;

const QUALIFICATION_UPSTREAM_CONDITION_FIELDS = ['code', 'triggered'] as const;
const BASIS_POINTS_MAXIMUM = 10_000n;
const QUALIFICATION_REASON_CODE_SET: ReadonlySet<string> = new Set(QUALIFICATION_REASON_CODES);

export function assertValidQualificationFacts(
  facts: QualificationCalibrationFacts,
): void {
  assertFrozenPlainObject(facts, 'Qualification facts');
  const values = assertExactDataFields(facts, QUALIFICATION_FACT_FIELDS, 'Qualification facts');

  for (const field of [
    'top1HolderBps',
    'top5HoldersBps',
    'top10HoldersBps',
    'maximumRelatedClusterBps',
    'roundTripLossBps',
  ] as const) assertNullableBasisPoints(values[field], field);
  assertNullableSharedFunderCount(
    values.maximumSharedFunderCount,
    'maximumSharedFunderCount',
  );
  assertNullableBoolean(values.buySimulationSucceeded, 'buySimulationSucceeded');
  assertNullableBoolean(values.sellQuoteAvailable, 'sellQuoteAvailable');
  assertValidUpstreamConditions(values.upstreamConditions);
}

function assertValidUpstreamConditions(value: unknown): void {
  if (
    typeof value !== 'object'
    || value === null
    || isProxy(value)
    || !Array.isArray(value)
    || !Object.isFrozen(value)
  ) {
    throw new TypeError('Qualification upstream conditions must be a frozen array.');
  }
  const conditions = assertDenseDataArray(value, 'Qualification upstream conditions');
  const codes = new Set<QualificationReasonCode>();
  for (let index = 0; index < conditions.length; index += 1) {
    const condition = conditions[index];
    assertFrozenPlainObject(condition, `Qualification upstream condition ${index}`);
    const fields = assertExactDataFields(
      condition,
      QUALIFICATION_UPSTREAM_CONDITION_FIELDS,
      `Qualification upstream condition ${index}`,
    );
    if (!isQualificationReasonCode(fields.code)) {
      throw new TypeError('Qualification upstream condition code is invalid.');
    }
    if (typeof fields.triggered !== 'boolean') {
      throw new TypeError('Qualification upstream condition triggered must be a boolean.');
    }
    if (codes.has(fields.code)) {
      throw new TypeError('Qualification upstream condition codes must be unique.');
    }
    codes.add(fields.code);
  }
}

function assertNullableBasisPoints(value: unknown, field: string): void {
  if (value === null) return;
  if (typeof value !== 'bigint' || value < 0n || value > BASIS_POINTS_MAXIMUM) {
    throw new TypeError(`Qualification ${field} must be null or basis points from 0 through 10000.`);
  }
}

function assertNullableSharedFunderCount(value: unknown, field: string): void {
  if (value === null) return;
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || Object.is(value, -0)
  ) {
    throw new TypeError(`Qualification ${field} must be null or a non-negative safe integer.`);
  }
}

function assertNullableBoolean(value: unknown, field: string): void {
  if (value !== null && typeof value !== 'boolean') {
    throw new TypeError(`Qualification ${field} must be null or a boolean.`);
  }
}

function assertFrozenPlainObject(value: unknown, name: string): asserts value is object {
  if (
    typeof value !== 'object'
    || value === null
    || isProxy(value)
    || Array.isArray(value)
    || !Object.isFrozen(value)
    || !isPlainObject(value)
  ) throw new TypeError(`${name} must be a frozen plain object.`);
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactDataFields(
  value: object,
  expectedFields: readonly string[],
  name: string,
): Record<string, unknown> {
  if (isProxy(value)) throw new TypeError(`${name} must not be a proxy.`);
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${name} must not contain symbol fields.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (
    keys.length !== expectedFields.length
    || expectedFields.some((field) => !Object.hasOwn(descriptors, field))
  ) throw new TypeError(`${name} must contain exactly the required fields.`);
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of expectedFields) {
    const descriptor = descriptors[field];
    if (
      descriptor === undefined
      || !('value' in descriptor)
      || !descriptor.enumerable
    ) throw new TypeError(`${name}.${field} must be an enumerable data field.`);
    const fieldValue: unknown = descriptor.value;
    fields[field] = fieldValue;
  }
  return fields;
}

function assertDenseDataArray(value: readonly unknown[], name: string): readonly unknown[] {
  if (isProxy(value)) throw new TypeError(`${name} must not be a proxy.`);
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${name} must not contain symbol fields.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expectedKeys = new Set<string>(['length']);
  for (let index = 0; index < value.length; index += 1) expectedKeys.add(String(index));
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== value.length + 1 || keys.some((key) => !expectedKeys.has(key))) {
    throw new TypeError(`${name} must be dense and contain no extra fields.`);
  }
  const entries: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${name} must contain only enumerable data entries.`);
    }
    const entry: unknown = descriptor.value;
    entries.push(entry);
  }
  return entries;
}

function isQualificationReasonCode(value: unknown): value is QualificationReasonCode {
  return typeof value === 'string' && QUALIFICATION_REASON_CODE_SET.has(value);
}

export interface QualificationEvaluationInput {
  readonly evaluatedAtMs: number;
  readonly signals: Readonly<Partial<Record<QualificationSignalKey, boolean>>>;
  readonly blockers: readonly QualificationReasonCode[];
  readonly calibrationFacts: QualificationCalibrationFacts | null;
}

export interface QualificationEvidence {
  readonly signal: QualificationSignalKey;
  readonly dimension: QualificationDimension;
  readonly status: QualificationEvidenceStatus;
  readonly required: boolean;
  readonly weight: number;
  readonly message: string;
}

export interface QualificationScore {
  readonly score: number;
  readonly maximum: number;
}

export interface QualificationScores {
  readonly preparation: QualificationScore;
  readonly socialAuthenticity: QualificationScore;
  readonly onchainHealth: QualificationScore;
  readonly total: QualificationScore;
}

export interface QualificationBlocker {
  readonly code: QualificationReasonCode;
  readonly message: string;
}

export interface QualificationReport {
  /** Legacy persisted reports may not contain the calibration fingerprint. */
  readonly ruleSet: Pick<QualificationRuleSet, 'id' | 'version' | 'status' | 'minimumTotalScore'> &
    Readonly<{ fingerprint?: string }>;
  readonly scores: QualificationScores;
  readonly evidence: readonly QualificationEvidence[];
  /** Legacy persisted reports may predate calibrated condition evidence. */
  readonly conditions?: readonly QualificationConditionEvidence[];
  readonly blockers: readonly QualificationBlocker[];
  readonly verdict: QualificationVerdict;
  readonly evaluatedAtMs: number;
}
