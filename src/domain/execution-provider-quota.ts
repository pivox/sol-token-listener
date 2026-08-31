import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  createExecutionRiskPolicy,
  type ExecutionRiskPolicyV1,
} from './execution-risk-policy.js';

const PAYLOAD_VERSION = 1 as const;
const U64_MAX = 18_446_744_073_709_551_615n;
const DATE_MAX_MS = 8_640_000_000_000_000;
const MAX_POSITION_INPUTS = 16;
const MAX_RATE_LIMIT_EVENTS = 1_000;
const RATE_LIMIT_WINDOW_MS = 30_000;

const SNAPSHOT_INPUT_KEYS = Object.freeze([
  'providerId', 'planId', 'billingPeriodId', 'billingPeriodStartedAtMs',
  'billingPeriodEndsAtMs', 'limitUnits', 'usedUnits', 'measuredAtMs',
  'expiresAtMs', 'provenance',
] as const);
const SNAPSHOT_KEYS = Object.freeze([
  'snapshotId', 'payloadVersion', 'snapshotFingerprint', ...SNAPSHOT_INPUT_KEYS,
] as const);
const OPERATION_ID_KEYS = Object.freeze([
  'providerId', 'billingPeriodId', 'category', 'logicalOperationId',
] as const);
const QUOTA_INPUT_KEYS = Object.freeze([
  'policy', 'previousSnapshot', 'snapshot', 'localUsedSinceMeasurement',
  'openPositions', 'consecutiveRateLimits', 'allEndpointsUnavailable', 'nowMs',
] as const);
const POLICY_KEYS = Object.freeze([
  'payloadVersion', 'policyFingerprint', 'quoteMintAllowlist',
  'initialCapitalLamports', 'maximumCapitalLamports', 'positionSizeBps',
  'maximumOpenPositions', 'maximumTotalExposureBps', 'drawdownPauseBps',
  'feeReserveLamports', 'walletSnapshotMaxAgeMs', 'providerUsageMaxAgeMs',
  'providerEntryCostUnits', 'providerExitCostUnitsPerPosition',
  'providerConfirmationCostUnitsPerPosition',
  'providerReconciliationCostUnitsPerPosition', 'providerSafetyMarginUnits',
  'maximumConsecutiveTechnicalFailures',
] as const);
const POLICY_INPUT_KEYS = Object.freeze(POLICY_KEYS.slice(2));
const CATEGORIES = Object.freeze([
  'ENTRY', 'EXIT', 'CONFIRMATION', 'RECONCILIATION', 'TELEMETRY',
] as const);
const PROVENANCES = Object.freeze([
  'AUTHORITATIVE_PROBE', 'OPERATOR_REPORT',
] as const);

export type ExecutionProviderQuotaState =
  | 'NORMAL' | 'ENTRY_BLOCKED' | 'EXIT_ONLY' | 'UNKNOWN';
export type ExecutionProviderQuotaReasonCode =
  | 'PROVIDER_USAGE_UNKNOWN'
  | 'PROVIDER_ENTRY_LIMIT_REACHED'
  | 'PROVIDER_EXIT_ONLY';
export type ExecutionProviderUsageCategory = (typeof CATEGORIES)[number];
export type ExecutionProviderUsageProvenance = (typeof PROVENANCES)[number];

export interface ProviderUsageSnapshotInputV1 {
  readonly providerId: string;
  readonly planId: string;
  readonly billingPeriodId: string;
  readonly billingPeriodStartedAtMs: number;
  readonly billingPeriodEndsAtMs: number;
  readonly limitUnits: bigint;
  readonly usedUnits: bigint;
  readonly measuredAtMs: number;
  readonly expiresAtMs: number;
  readonly provenance: ExecutionProviderUsageProvenance;
}

export interface ProviderUsageSnapshotV1 extends ProviderUsageSnapshotInputV1 {
  readonly snapshotId: string;
  readonly payloadVersion: 1;
  readonly snapshotFingerprint: string;
}

export interface ProviderQuotaDecisionV1 {
  readonly payloadVersion: 1;
  readonly state: ExecutionProviderQuotaState;
  readonly reasonCode: ExecutionProviderQuotaReasonCode | null;
  readonly remainingUnits: bigint | null;
  readonly protectedUnits: bigint;
  readonly entryCostUnits: bigint;
  readonly recentRateLimitCount: number;
  readonly snapshotFingerprint: string | null;
}

export class ExecutionProviderQuotaValidationError extends TypeError {
  public constructor() {
    super('Invalid execution provider quota input.');
    this.name = 'ExecutionProviderQuotaValidationError';
  }
}

export function createProviderUsageSnapshot(input: unknown): ProviderUsageSnapshotV1 {
  try {
    const fields = snapshotInputFrom(input);
    const snapshotFingerprint = snapshotFingerprintFor(fields);
    return Object.freeze({
      snapshotId: `execution_provider_usage_${snapshotFingerprint}`,
      payloadVersion: PAYLOAD_VERSION,
      snapshotFingerprint,
      ...fields,
    });
  } catch {
    throw invalid();
  }
}

export function createProviderUsageOperationId(input: unknown): string {
  try {
    const record = exactRecord(input, OPERATION_ID_KEYS);
    const providerId = identifier(record.providerId);
    const billingPeriodId = text(record.billingPeriodId, 128);
    const category = enumValue(record.category, CATEGORIES);
    const logicalOperationId = text(record.logicalOperationId, 256);
    return `execution_provider_operation_${hash([
      'execution-provider-operation-v1', providerId, billingPeriodId,
      category, logicalOperationId,
    ])}`;
  } catch {
    throw invalid();
  }
}

export function evaluateProviderQuota(input: unknown): ProviderQuotaDecisionV1 {
  try {
    const fields = quotaInputFrom(input);
    const policy = fields.policy;
    const protectedUnits = BigInt(fields.openPositions) * (
      policy.providerExitCostUnitsPerPosition
      + policy.providerConfirmationCostUnitsPerPosition
      + policy.providerReconciliationCostUnitsPerPosition
    ) + policy.providerSafetyMarginUnits;
    const recentRateLimitCount = fields.consecutiveRateLimits.filter(
      (observedAtMs) => observedAtMs >= fields.nowMs - RATE_LIMIT_WINDOW_MS,
    ).length;
    if (fields.snapshot === null
      || !snapshotIsCoherent(fields.previousSnapshot, fields.snapshot)
      || fields.nowMs > fields.snapshot.expiresAtMs
      || fields.nowMs > fields.snapshot.measuredAtMs + policy.providerUsageMaxAgeMs) {
      return quotaDecision(
        'UNKNOWN', 'PROVIDER_USAGE_UNKNOWN', null, protectedUnits,
        policy.providerEntryCostUnits, recentRateLimitCount,
        fields.snapshot?.snapshotFingerprint ?? null,
      );
    }
    const remainingUnits = fields.snapshot.limitUnits
      - fields.snapshot.usedUnits
      - fields.localUsedSinceMeasurement;
    if (fields.allEndpointsUnavailable || remainingUnits < protectedUnits) {
      return quotaDecision(
        'EXIT_ONLY', 'PROVIDER_EXIT_ONLY', remainingUnits, protectedUnits,
        policy.providerEntryCostUnits, recentRateLimitCount,
        fields.snapshot.snapshotFingerprint,
      );
    }
    if (recentRateLimitCount >= 3
      || remainingUnits - policy.providerEntryCostUnits < protectedUnits) {
      return quotaDecision(
        'ENTRY_BLOCKED', 'PROVIDER_ENTRY_LIMIT_REACHED', remainingUnits,
        protectedUnits, policy.providerEntryCostUnits, recentRateLimitCount,
        fields.snapshot.snapshotFingerprint,
      );
    }
    return quotaDecision(
      'NORMAL', null, remainingUnits, protectedUnits,
      policy.providerEntryCostUnits, recentRateLimitCount,
      fields.snapshot.snapshotFingerprint,
    );
  } catch {
    throw invalid();
  }
}

function quotaInputFrom(value: unknown): Readonly<{
  policy: ExecutionRiskPolicyV1;
  previousSnapshot: ProviderUsageSnapshotV1 | null;
  snapshot: ProviderUsageSnapshotV1 | null;
  localUsedSinceMeasurement: bigint;
  openPositions: number;
  consecutiveRateLimits: readonly number[];
  allEndpointsUnavailable: boolean;
  nowMs: number;
}> {
  const record = exactRecord(value, QUOTA_INPUT_KEYS);
  const policy = policyFrom(record.policy);
  const previousSnapshot = nullableSnapshotFrom(record.previousSnapshot);
  const snapshot = nullableSnapshotFrom(record.snapshot);
  const localUsedSinceMeasurement = unsignedBigint(record.localUsedSinceMeasurement);
  const openPositions = boundedInteger(record.openPositions, 0, MAX_POSITION_INPUTS);
  const consecutiveRateLimits = timestampsFrom(record.consecutiveRateLimits);
  const allEndpointsUnavailable = booleanValue(record.allEndpointsUnavailable);
  const nowMs = timestamp(record.nowMs);
  if (consecutiveRateLimits.some((observedAtMs) => observedAtMs > nowMs)) throw invalid();
  return Object.freeze({
    policy, previousSnapshot, snapshot, localUsedSinceMeasurement, openPositions,
    consecutiveRateLimits, allEndpointsUnavailable, nowMs,
  });
}

function policyFrom(value: unknown): ExecutionRiskPolicyV1 {
  if (!isFrozenPlainObject(value)) throw invalid();
  const record = exactRecord(value, POLICY_KEYS);
  if (record.payloadVersion !== 1 || typeof record.policyFingerprint !== 'string') throw invalid();
  const input = Object.create(null) as Record<string, unknown>;
  for (const key of POLICY_INPUT_KEYS) input[key] = record[key];
  const reconstructed = createExecutionRiskPolicy(input);
  if (reconstructed.policyFingerprint !== record.policyFingerprint) throw invalid();
  return reconstructed;
}

function snapshotInputFrom(value: unknown): ProviderUsageSnapshotInputV1 {
  const record = exactRecord(value, SNAPSHOT_INPUT_KEYS);
  const providerId = identifier(record.providerId);
  const planId = text(record.planId, 128);
  const billingPeriodId = text(record.billingPeriodId, 128);
  const billingPeriodStartedAtMs = timestamp(record.billingPeriodStartedAtMs);
  const billingPeriodEndsAtMs = timestamp(record.billingPeriodEndsAtMs);
  const limitUnits = positiveBigint(record.limitUnits);
  const usedUnits = unsignedBigint(record.usedUnits);
  const measuredAtMs = timestamp(record.measuredAtMs);
  const expiresAtMs = timestamp(record.expiresAtMs);
  const provenance = enumValue(record.provenance, PROVENANCES);
  if (billingPeriodEndsAtMs <= billingPeriodStartedAtMs
    || measuredAtMs < billingPeriodStartedAtMs
    || measuredAtMs >= billingPeriodEndsAtMs
    || expiresAtMs < measuredAtMs + 30_000
    || expiresAtMs > measuredAtMs + 900_000
    || expiresAtMs > billingPeriodEndsAtMs
    || usedUnits > limitUnits) throw invalid();
  return Object.freeze({
    providerId, planId, billingPeriodId, billingPeriodStartedAtMs,
    billingPeriodEndsAtMs, limitUnits, usedUnits, measuredAtMs, expiresAtMs,
    provenance,
  });
}

function nullableSnapshotFrom(value: unknown): ProviderUsageSnapshotV1 | null {
  if (value === null) return null;
  if (!isFrozenPlainObject(value)) throw invalid();
  const record = exactRecord(value, SNAPSHOT_KEYS);
  if (record.payloadVersion !== PAYLOAD_VERSION) throw invalid();
  const fields = snapshotInputFrom(Object.freeze(pick(record, SNAPSHOT_INPUT_KEYS)));
  const snapshotFingerprint = fingerprint(record.snapshotFingerprint);
  const expectedFingerprint = snapshotFingerprintFor(fields);
  if (snapshotFingerprint !== expectedFingerprint
    || record.snapshotId !== `execution_provider_usage_${expectedFingerprint}`) throw invalid();
  return Object.freeze({
    snapshotId: record.snapshotId,
    payloadVersion: PAYLOAD_VERSION,
    snapshotFingerprint,
    ...fields,
  });
}

function snapshotIsCoherent(
  previous: ProviderUsageSnapshotV1 | null,
  current: ProviderUsageSnapshotV1,
): boolean {
  if (previous === null) return true;
  if (current.providerId !== previous.providerId || current.planId !== previous.planId) return false;
  if (current.billingPeriodId === previous.billingPeriodId) {
    return current.billingPeriodStartedAtMs === previous.billingPeriodStartedAtMs
      && current.billingPeriodEndsAtMs === previous.billingPeriodEndsAtMs
      && current.measuredAtMs >= previous.measuredAtMs
      && current.usedUnits >= previous.usedUnits;
  }
  return current.billingPeriodStartedAtMs >= previous.billingPeriodEndsAtMs;
}

function quotaDecision(
  state: ExecutionProviderQuotaState,
  reasonCode: ExecutionProviderQuotaReasonCode | null,
  remainingUnits: bigint | null,
  protectedUnits: bigint,
  entryCostUnits: bigint,
  recentRateLimitCount: number,
  snapshotFingerprint: string | null,
): ProviderQuotaDecisionV1 {
  return Object.freeze({
    payloadVersion: PAYLOAD_VERSION,
    state,
    reasonCode,
    remainingUnits,
    protectedUnits,
    entryCostUnits,
    recentRateLimitCount,
    snapshotFingerprint,
  });
}

function snapshotFingerprintFor(value: ProviderUsageSnapshotInputV1): string {
  return hash([
    'execution-provider-usage-v1', value.providerId, value.planId,
    value.billingPeriodId, value.billingPeriodStartedAtMs,
    value.billingPeriodEndsAtMs, value.limitUnits.toString(), value.usedUnits.toString(),
    value.measuredAtMs, value.expiresAtMs, value.provenance,
  ]);
}

function hash(value: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function timestampsFrom(value: unknown): readonly number[] {
  if (!Array.isArray(value) || isProxy(value) || value.length > MAX_RATE_LIMIT_EVENTS) {
    throw invalid();
  }
  const result: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
    const observedAtMs = timestamp(descriptor.value);
    if (index > 0 && observedAtMs < (result[index - 1] ?? -1)) throw invalid();
    result.push(observedAtMs);
  }
  return Object.freeze(result);
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  if (!isPlainObject(value)) throw invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string'
    || !keys.includes(key))) throw invalid();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function pick<const Keys extends readonly string[]>(
  record: Readonly<Record<string, unknown>>,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) result[key] = record[key];
  return result as Readonly<Record<Keys[number], unknown>>;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw invalid();
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
    throw invalid();
  }
  return value;
}

function text(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string' || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximumBytes) throw invalid();
  return value;
}

function fingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw invalid();
  return value;
}

function unsignedBigint(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) throw invalid();
  return value;
}

function positiveBigint(value: unknown): bigint {
  const parsed = unsignedBigint(value);
  if (parsed === 0n) throw invalid();
  return parsed;
}

function timestamp(value: unknown): number {
  return boundedInteger(value, 0, DATE_MAX_MS);
}

function boundedInteger(value: unknown, minimumValue: number, maximumValue: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimumValue
    || (value as number) > maximumValue) throw invalid();
  return value as number;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFrozenPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return isPlainObject(value) && Object.isFrozen(value);
}

function invalid(): ExecutionProviderQuotaValidationError {
  return new ExecutionProviderQuotaValidationError();
}
