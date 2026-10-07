import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  createOperatorAuthorizationV2,
  type ExecutionControlState,
  type ExecutionOperatorAuthorizationV2,
} from './execution-operations.js';
import {
  createProviderUsageSnapshot,
  type ProviderUsageSnapshotV1,
} from './execution-provider-quota.js';
import {
  createExecutionRiskPolicy,
  evaluateBuyRisk,
  type ExecutionRiskPolicyV1,
} from './execution-risk-policy.js';
import {
  createSafetyQualification,
  ENVELOPE_QUALIFICATION_MAXIMUM_TTL_MS,
  type ExecutionSafetyQualificationV2,
} from './execution-safety-qualification.js';

/** Minimum time left in the envelope after the holding deadline (mirrored in the 065 trigger). */
export const ENVELOPE_EXIT_MARGIN_MS = 900_000;
/** An envelope armament expires within 15 minutes of arming (035 CHECK armed_at + 15 min). */
export const ENVELOPE_ARMAMENT_MAXIMUM_TTL_MS = 900_000;

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const U64_MAX = 18_446_744_073_709_551_615n;
const DATE_MAX_MS = 8_640_000_000_000_000;
const BPS_DENOMINATOR = 10_000n;
/** BUY submission requires reserved_exposure x 10 000 <= reconciled_capital x 500. */
const SUBMISSION_EXPOSURE_BPS = 500n;
const MAXIMUM_TOTAL_EXPOSURE_BPS = 500n;
const POLICY_FRESHNESS_MARGIN_MS = 30_000;
const ARM_AUTHORIZATION_TTL_MS = 60_000;
const OPERATOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ENVELOPE_ID_PATTERN = /^execution_entry_envelope_[0-9a-f]{64}$/u;
const INTENT_ID_PATTERN = /^execution_intent_[0-9a-f]{64}$/u;
const GENERATION_ID_PATTERN = /^execution_wallet_generation_[0-9a-f]{64}$/u;

const ENVELOPE_INPUT_KEYS = Object.freeze([
  'payloadVersion', 'qualification', 'operatorId', 'perBuyQuoteAmountRaw', 'maxBuys',
  'maxTotalExposureRaw', 'maxRealizedLossRaw', 'maximumHoldingMs', 'validFromMs',
  'validUntilMs', 'policy',
] as const);
const ENVELOPE_KEYS = Object.freeze([
  'envelopeId', 'payloadVersion', 'fingerprint', 'generationId', 'operatorId',
  'perBuyQuoteAmountRaw', 'maxBuys', 'maxTotalExposureRaw', 'maxRealizedLossRaw',
  'maximumHoldingMs', 'validFromMs', 'validUntilMs', 'policy', 'qualificationId',
] as const);
const ARMING_FACT_KEYS = Object.freeze([
  'envelope', 'buysArmed', 'realizedLossRaw', 'controlState', 'unknownBlock',
  'activeArmament', 'openPosition', 'intentAvailable', 'runtimeLeaseMs', 'nowMs',
] as const);
const PROVIDER_CARRY_KEYS = Object.freeze([
  'latest', 'localUsedUnits', 'measuredAtMs', 'maximumAgeMs',
] as const);
const ARM_AUTHORIZATION_KEYS = Object.freeze([
  'generationId', 'operatorId', 'envelopeId', 'intentId', 'contextFingerprint', 'nowMs',
] as const);
const CONTROL_STATES = Object.freeze(['RUNNING', 'ENTRY_STOP', 'HARD_STOP'] as const);

export interface EntryEnvelopeV2 {
  readonly envelopeId: string;
  readonly payloadVersion: 2;
  readonly fingerprint: string;
  readonly generationId: string;
  readonly operatorId: string;
  readonly perBuyQuoteAmountRaw: bigint;
  readonly maxBuys: number;
  readonly maxTotalExposureRaw: bigint;
  readonly maxRealizedLossRaw: bigint;
  readonly maximumHoldingMs: number;
  readonly validFromMs: number;
  readonly validUntilMs: number;
  readonly policy: ExecutionRiskPolicyV1;
  readonly qualificationId: string;
}

export interface EntryEnvelopeInputV2 {
  readonly payloadVersion: 2;
  readonly qualification: ExecutionSafetyQualificationV2;
  readonly operatorId: string;
  readonly perBuyQuoteAmountRaw: bigint;
  readonly maxBuys: number;
  readonly maxTotalExposureRaw: bigint;
  readonly maxRealizedLossRaw: bigint;
  readonly maximumHoldingMs: number;
  readonly validFromMs: number;
  readonly validUntilMs: number;
  readonly policy: ExecutionRiskPolicyV1;
}

export type EnvelopeIdleReason =
  | 'NO_ENVELOPE'
  | 'CONTROL_NOT_RUNNING'
  | 'UNKNOWN_BLOCK'
  | 'ACTIVE_ARMAMENT'
  | 'OPEN_POSITION'
  | 'WINDOW_CUTOFF'
  | 'CAPACITY'
  | 'LOSS_CAP'
  | 'NO_INTENT'
  | 'POLICY_FRESHNESS';

/** What the auto-arm daemon knows at one tick; `envelope` is the ACTIVE envelope, if any. */
export interface EnvelopeArmingFacts {
  readonly envelope: EntryEnvelopeV2 | null;
  readonly buysArmed: number;
  readonly realizedLossRaw: bigint;
  readonly controlState: ExecutionControlState;
  readonly unknownBlock: boolean;
  readonly activeArmament: boolean;
  readonly openPosition: boolean;
  readonly intentAvailable: boolean;
  readonly runtimeLeaseMs: number;
  readonly nowMs: number;
}

export type EnvelopeArmingDecision =
  | Readonly<{ kind: 'ARMABLE' }>
  | Readonly<{ kind: 'IDLE'; reason: EnvelopeIdleReason }>;

export interface EnvelopeProviderCarryForwardInput {
  readonly latest: ProviderUsageSnapshotV1;
  readonly localUsedUnits: bigint;
  readonly measuredAtMs: number;
  readonly maximumAgeMs: number;
}

export interface EnvelopeArmAuthorizationInput {
  readonly generationId: string;
  readonly operatorId: string;
  readonly envelopeId: string;
  readonly intentId: string;
  readonly contextFingerprint: string;
  readonly nowMs: number;
}

export class ExecutionEntryEnvelopeValidationError extends TypeError {
  public constructor() {
    super('Invalid execution entry envelope.');
    this.name = 'ExecutionEntryEnvelopeValidationError';
  }
}

export function createEntryEnvelope(input: unknown): EntryEnvelopeV2 {
  try {
    const record = exactRecord(input, ENVELOPE_INPUT_KEYS);
    if (record.payloadVersion !== 2) throw invalid();
    const qualification = qualificationFrom(record.qualification);
    const policy = policyFrom(record.policy);
    const operatorId = patterned(record.operatorId, OPERATOR_ID_PATTERN, 64);
    const perBuyQuoteAmountRaw = boundedBigint(record.perBuyQuoteAmountRaw, 1n, U64_MAX);
    const maxBuys = integer(record.maxBuys, 1, 1_000);
    const maxTotalExposureRaw = boundedBigint(record.maxTotalExposureRaw, 1n, U64_MAX);
    const maxRealizedLossRaw = boundedBigint(record.maxRealizedLossRaw, 1n, U64_MAX);
    const maximumHoldingMs = integer(record.maximumHoldingMs, 30_000, 900_000);
    const validFromMs = timestamp(record.validFromMs);
    const validUntilMs = timestamp(record.validUntilMs);
    const windowMs = validUntilMs - validFromMs;
    if (maxTotalExposureRaw < perBuyQuoteAmountRaw
      || validUntilMs !== qualification.expiresAtMs
      || validFromMs < qualification.qualifiedAtMs
      || windowMs <= 0 || windowMs > ENVELOPE_QUALIFICATION_MAXIMUM_TTL_MS
      || windowMs < maximumHoldingMs + ENVELOPE_EXIT_MARGIN_MS) throw invalid();
    assertPolicyAdmitsEnvelope(policy, perBuyQuoteAmountRaw, maxRealizedLossRaw);
    const fingerprint = hash([
      'execution-entry-envelope-v2', qualification.generationId, operatorId,
      qualification.qualificationId, policy.policyFingerprint,
      perBuyQuoteAmountRaw.toString(), maxBuys, 1, maxTotalExposureRaw.toString(),
      maxRealizedLossRaw.toString(), maximumHoldingMs, validFromMs, validUntilMs,
    ]);
    return Object.freeze({
      envelopeId: `execution_entry_envelope_${fingerprint}`,
      payloadVersion: 2,
      fingerprint,
      generationId: qualification.generationId,
      operatorId,
      perBuyQuoteAmountRaw,
      maxBuys,
      maxTotalExposureRaw,
      maxRealizedLossRaw,
      maximumHoldingMs,
      validFromMs,
      validUntilMs,
      policy,
      qualificationId: qualification.qualificationId,
    });
  } catch {
    throw invalid();
  }
}

export function evaluateEnvelopeArming(context: EnvelopeArmingFacts): EnvelopeArmingDecision {
  let facts: Readonly<Record<(typeof ARMING_FACT_KEYS)[number], unknown>>;
  let envelope: EntryEnvelopeV2 | null;
  let buysArmed: number;
  let realizedLossRaw: bigint;
  let runtimeLeaseMs: number;
  let nowMs: number;
  try {
    facts = exactRecord(context, ARMING_FACT_KEYS);
    envelope = facts.envelope === null ? null : envelopeFrom(facts.envelope);
    buysArmed = integer(facts.buysArmed, 0, 1_000);
    realizedLossRaw = boundedBigint(facts.realizedLossRaw, 0n, U64_MAX);
    if (typeof facts.controlState !== 'string'
      || !(CONTROL_STATES as readonly string[]).includes(facts.controlState)) throw invalid();
    for (const flag of ['unknownBlock', 'activeArmament', 'openPosition', 'intentAvailable'] as const) {
      if (typeof facts[flag] !== 'boolean') throw invalid();
    }
    runtimeLeaseMs = integer(facts.runtimeLeaseMs, 1, 3_600_000);
    nowMs = timestamp(facts.nowMs);
  } catch {
    throw invalid();
  }
  if (envelope === null) return idle('NO_ENVELOPE');
  if (facts.controlState !== 'RUNNING') return idle('CONTROL_NOT_RUNNING');
  if (facts.unknownBlock === true) return idle('UNKNOWN_BLOCK');
  if (facts.activeArmament === true) return idle('ACTIVE_ARMAMENT');
  if (facts.openPosition === true) return idle('OPEN_POSITION');
  if (nowMs < envelope.validFromMs
    || envelope.validUntilMs < nowMs + envelope.maximumHoldingMs + ENVELOPE_EXIT_MARGIN_MS) {
    return idle('WINDOW_CUTOFF');
  }
  if (buysArmed >= envelope.maxBuys
    || BigInt(buysArmed + 1) * envelope.perBuyQuoteAmountRaw > envelope.maxTotalExposureRaw) {
    return idle('CAPACITY');
  }
  if (realizedLossRaw >= envelope.maxRealizedLossRaw) return idle('LOSS_CAP');
  const minimumMaxAgeMs = 2 * runtimeLeaseMs + POLICY_FRESHNESS_MARGIN_MS;
  if (envelope.policy.walletSnapshotMaxAgeMs < minimumMaxAgeMs
    || envelope.policy.providerUsageMaxAgeMs < minimumMaxAgeMs) return idle('POLICY_FRESHNESS');
  if (facts.intentAvailable !== true) return idle('NO_INTENT');
  return Object.freeze({ kind: 'ARMABLE' });
}

/**
 * Carries the latest provider measurement forward with the executor's own counters. The
 * result is never signed: provenance EXECUTOR_COUNTERS.
 */
export function createEnvelopeProviderSnapshot(
  input: EnvelopeProviderCarryForwardInput,
): ProviderUsageSnapshotV1 {
  try {
    const record = exactRecord(input, PROVIDER_CARRY_KEYS);
    const latest = providerFrom(record.latest);
    const localUsedUnits = boundedBigint(record.localUsedUnits, 0n, U64_MAX);
    const measuredAtMs = timestamp(record.measuredAtMs);
    const maximumAgeMs = integer(record.maximumAgeMs, 30_000, 900_000);
    const usedUnits = latest.usedUnits + localUsedUnits;
    if (measuredAtMs <= latest.measuredAtMs || measuredAtMs >= latest.billingPeriodEndsAtMs
      || usedUnits > latest.limitUnits) throw invalid();
    return createProviderUsageSnapshot({
      providerId: latest.providerId,
      planId: latest.planId,
      billingPeriodId: latest.billingPeriodId,
      billingPeriodStartedAtMs: latest.billingPeriodStartedAtMs,
      billingPeriodEndsAtMs: latest.billingPeriodEndsAtMs,
      limitUnits: latest.limitUnits,
      usedUnits,
      measuredAtMs,
      expiresAtMs: Math.min(measuredAtMs + maximumAgeMs, latest.billingPeriodEndsAtMs),
      provenance: 'EXECUTOR_COUNTERS',
    });
  } catch {
    throw invalid();
  }
}

/** The per-armament v2 ARM CANARY authorization, issued by the daemon for the envelope operator. */
export function createEnvelopeArmAuthorization(
  input: EnvelopeArmAuthorizationInput,
): ExecutionOperatorAuthorizationV2 {
  try {
    const record = exactRecord(input, ARM_AUTHORIZATION_KEYS);
    const envelopeId = patterned(record.envelopeId, ENVELOPE_ID_PATTERN, 89);
    const intentId = patterned(record.intentId, INTENT_ID_PATTERN, 81);
    const nowMs = timestamp(record.nowMs);
    return createOperatorAuthorizationV2({
      payloadVersion: 2,
      generationId: record.generationId,
      action: 'ARM',
      phase: 'CANARY',
      contextFingerprint: record.contextFingerprint,
      nonceHash: hash(['execution-envelope-arm-nonce-v1', envelopeId, intentId, nowMs]),
      operatorId: record.operatorId,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + ARM_AUTHORIZATION_TTL_MS,
    });
  } catch {
    throw invalid();
  }
}

function assertPolicyAdmitsEnvelope(
  policy: ExecutionRiskPolicyV1,
  perBuyQuoteAmountRaw: bigint,
  maxRealizedLossRaw: bigint,
): void {
  if (policy.quoteMintAllowlist[0] !== WSOL_MINT
    || policy.maximumOpenPositions !== 1
    || policy.maximumTotalExposureBps > MAXIMUM_TOTAL_EXPOSURE_BPS) throw invalid();
  // Reconciled capital once the whole loss cap is realized, computed like evaluateBuyRisk.
  const lossCappedCapital = minimum(
    maximum(0n, policy.initialCapitalLamports - maxRealizedLossRaw),
    policy.maximumCapitalLamports,
  );
  if (perBuyQuoteAmountRaw * BPS_DENOMINATOR > lossCappedCapital * SUBMISSION_EXPOSURE_BPS) {
    throw invalid();
  }
  const decision = evaluateBuyRisk(Object.freeze({
    policy,
    quoteMint: WSOL_MINT,
    requestedQuoteAmountRaw: perBuyQuoteAmountRaw,
    realizedNetPnlLamports: -maxRealizedLossRaw,
    reservedExposureLamports: 0n,
    openPositions: Object.freeze([]),
    consecutiveTechnicalFailures: 0,
    lastTechnicalFailureReasonCode: null,
  }));
  if (decision.kind !== 'ADMISSIBLE') throw invalid();
}

function qualificationFrom(value: unknown): ExecutionSafetyQualificationV2 {
  if (!isPlainObject(value) || !Object.isFrozen(value)) throw invalid();
  const { qualificationId, qualificationFingerprint, ...fields } = value;
  const qualification = createSafetyQualification(fields);
  if (qualification.payloadVersion !== 2
    || qualificationId !== qualification.qualificationId
    || qualificationFingerprint !== qualification.qualificationFingerprint) throw invalid();
  return qualification;
}

function policyFrom(value: unknown): ExecutionRiskPolicyV1 {
  if (!isPlainObject(value) || !Object.isFrozen(value)) throw invalid();
  const { payloadVersion, policyFingerprint, ...fields } = value;
  const policy = createExecutionRiskPolicy(fields);
  if (payloadVersion !== 1 || policyFingerprint !== policy.policyFingerprint) throw invalid();
  return policy;
}

function providerFrom(value: unknown): ProviderUsageSnapshotV1 {
  if (!isPlainObject(value) || !Object.isFrozen(value)) throw invalid();
  const { snapshotId, payloadVersion, snapshotFingerprint, ...fields } = value;
  const snapshot = createProviderUsageSnapshot(fields);
  if (payloadVersion !== 1 || snapshotId !== snapshot.snapshotId
    || snapshotFingerprint !== snapshot.snapshotFingerprint) throw invalid();
  return snapshot;
}

/** Validates the fields arming relies on; identity is the repository's (and the trigger's) concern. */
function envelopeFrom(value: unknown): EntryEnvelopeV2 {
  if (!Object.isFrozen(value)) throw invalid();
  const record = exactRecord(value, ENVELOPE_KEYS);
  if (record.payloadVersion !== 2) throw invalid();
  const policy = policyFrom(record.policy);
  const fingerprint = patterned(record.fingerprint, /^[0-9a-f]{64}$/u, 64);
  if (record.envelopeId !== `execution_entry_envelope_${fingerprint}`) throw invalid();
  const perBuyQuoteAmountRaw = boundedBigint(record.perBuyQuoteAmountRaw, 1n, U64_MAX);
  const maxBuys = integer(record.maxBuys, 1, 1_000);
  const maxTotalExposureRaw = boundedBigint(record.maxTotalExposureRaw, 1n, U64_MAX);
  const maxRealizedLossRaw = boundedBigint(record.maxRealizedLossRaw, 1n, U64_MAX);
  const maximumHoldingMs = integer(record.maximumHoldingMs, 30_000, 900_000);
  const validFromMs = timestamp(record.validFromMs);
  const validUntilMs = timestamp(record.validUntilMs);
  return Object.freeze({
    envelopeId: record.envelopeId,
    payloadVersion: 2,
    fingerprint,
    generationId: patterned(record.generationId, GENERATION_ID_PATTERN, 96),
    operatorId: patterned(record.operatorId, OPERATOR_ID_PATTERN, 64),
    perBuyQuoteAmountRaw,
    maxBuys,
    maxTotalExposureRaw,
    maxRealizedLossRaw,
    maximumHoldingMs,
    validFromMs,
    validUntilMs,
    policy,
    qualificationId: patterned(record.qualificationId,
      /^execution_safety_qualification_[0-9a-f]{64}$/u, 95),
  });
}

function idle(reason: EnvelopeIdleReason): EnvelopeArmingDecision {
  return Object.freeze({ kind: 'IDLE', reason });
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Readonly<Record<Keys[number], unknown>> {
  if (!isPlainObject(value)) throw invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length
    || own.some((key) => typeof key !== 'string' || !keys.includes(key))) throw invalid();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw invalid();
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function patterned(value: unknown, pattern: RegExp, maximumBytes: number): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximumBytes
    || !pattern.test(value)) throw invalid();
  return value;
}

function boundedBigint(value: unknown, minimumValue: bigint, maximumValue: bigint): bigint {
  if (typeof value !== 'bigint' || value < minimumValue || value > maximumValue) throw invalid();
  return value;
}

function integer(value: unknown, minimumValue: number, maximumValue: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimumValue
    || (value as number) > maximumValue) throw invalid();
  return value as number;
}

function timestamp(value: unknown): number {
  return integer(value, 0, DATE_MAX_MS);
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maximum(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function hash(value: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function invalid(): ExecutionEntryEnvelopeValidationError {
  return new ExecutionEntryEnvelopeValidationError();
}
