import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { ExecutionIntentReasonCode } from './execution-intent.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const POLICY_PAYLOAD_VERSION = 1 as const;
const DECISION_PAYLOAD_VERSION = 1 as const;
const BPS_DENOMINATOR = 10_000n;
const U64_MAX = 18_446_744_073_709_551_615n;
const I128_MAX = (1n << 127n) - 1n;
const I128_MIN = -(1n << 127n);
const MAX_POSITION_INPUTS = 16;

const POLICY_INPUT_KEYS = Object.freeze([
  'quoteMintAllowlist', 'initialCapitalLamports', 'maximumCapitalLamports',
  'positionSizeBps', 'maximumOpenPositions', 'maximumTotalExposureBps',
  'drawdownPauseBps', 'feeReserveLamports', 'walletSnapshotMaxAgeMs',
  'providerUsageMaxAgeMs', 'providerEntryCostUnits',
  'providerExitCostUnitsPerPosition', 'providerConfirmationCostUnitsPerPosition',
  'providerReconciliationCostUnitsPerPosition', 'providerSafetyMarginUnits',
  'maximumConsecutiveTechnicalFailures',
] as const);
const POLICY_KEYS = Object.freeze([
  'payloadVersion', 'policyFingerprint', ...POLICY_INPUT_KEYS,
] as const);
const RISK_INPUT_KEYS = Object.freeze([
  'policy', 'quoteMint', 'requestedQuoteAmountRaw', 'realizedNetPnlLamports',
  'reservedExposureLamports', 'openPositions', 'consecutiveTechnicalFailures',
  'lastTechnicalFailureReasonCode',
] as const);
const POSITION_KEYS = Object.freeze([
  'positionId', 'costBasisLamports', 'conservativeLiquidationLamports',
  'reconciliationStatus',
] as const);
const TECHNICAL_FAILURE_REASON_CODES = new Set<ExecutionIntentReasonCode>([
  'EXECUTION_BUILD_FAILED', 'BUY_SIMULATION_FAILED', 'SELL_SIMULATION_FAILED',
  'EXECUTION_PROVIDER_FAILED', 'CONFIRMATION_TIMEOUT', 'RECONCILIATION_REQUIRED',
]);

export type ExecutionTechnicalFailureReasonCode =
  | 'EXECUTION_BUILD_FAILED'
  | 'BUY_SIMULATION_FAILED'
  | 'SELL_SIMULATION_FAILED'
  | 'EXECUTION_PROVIDER_FAILED'
  | 'CONFIRMATION_TIMEOUT'
  | 'RECONCILIATION_REQUIRED';

export type ExecutionBuyRiskReasonCode =
  | 'CAPITAL_LIMIT_EXCEEDED'
  | 'EXPOSURE_LIMIT_EXCEEDED'
  | 'DRAWDOWN_LIMIT_EXCEEDED'
  | 'QUOTE_MINT_NOT_ALLOWED'
  | 'RECONCILIATION_REQUIRED'
  | ExecutionTechnicalFailureReasonCode;

export interface ExecutionRiskPolicyInputV1 {
  readonly quoteMintAllowlist: readonly [string];
  readonly initialCapitalLamports: bigint;
  readonly maximumCapitalLamports: bigint;
  readonly positionSizeBps: bigint;
  readonly maximumOpenPositions: number;
  readonly maximumTotalExposureBps: bigint;
  readonly drawdownPauseBps: bigint;
  readonly feeReserveLamports: bigint;
  readonly walletSnapshotMaxAgeMs: number;
  readonly providerUsageMaxAgeMs: number;
  readonly providerEntryCostUnits: bigint;
  readonly providerExitCostUnitsPerPosition: bigint;
  readonly providerConfirmationCostUnitsPerPosition: bigint;
  readonly providerReconciliationCostUnitsPerPosition: bigint;
  readonly providerSafetyMarginUnits: bigint;
  readonly maximumConsecutiveTechnicalFailures: 2;
}

export interface ExecutionRiskPolicyV1 extends ExecutionRiskPolicyInputV1 {
  readonly payloadVersion: 1;
  readonly policyFingerprint: string;
}

export interface ExecutionOpenPositionRiskInputV1 {
  readonly positionId: string;
  readonly costBasisLamports: bigint;
  readonly conservativeLiquidationLamports: bigint | null;
  readonly reconciliationStatus: 'RECONCILED' | 'UNKNOWN';
}

export interface ExecutionBuyRiskInputV1 {
  readonly policy: ExecutionRiskPolicyV1;
  readonly quoteMint: string;
  readonly requestedQuoteAmountRaw: bigint;
  readonly realizedNetPnlLamports: bigint;
  readonly reservedExposureLamports: bigint;
  readonly openPositions: readonly ExecutionOpenPositionRiskInputV1[];
  readonly consecutiveTechnicalFailures: number;
  readonly lastTechnicalFailureReasonCode: ExecutionTechnicalFailureReasonCode | null;
}

export interface ExecutionBuyRiskDecisionV1 {
  readonly payloadVersion: 1;
  readonly kind: 'ADMISSIBLE' | 'REJECTED';
  readonly reasonCode: ExecutionBuyRiskReasonCode | null;
  readonly reconciledCapitalLamports: bigint;
  readonly capitalAfterFeeReserveLamports: bigint;
  readonly positionLimitLamports: bigint;
  readonly totalExposureLimitLamports: bigint;
  readonly projectedExposureLamports: bigint;
  readonly conservativeUnrealizedLossLamports: bigint;
  readonly drawdownBps: bigint;
  readonly openPositionCount: number;
}

export class ExecutionRiskValidationError extends TypeError {
  public constructor() {
    super('Invalid execution risk input.');
    this.name = 'ExecutionRiskValidationError';
  }
}

export function createExecutionRiskPolicy(input: unknown): ExecutionRiskPolicyV1 {
  try {
    const fields = policyInputFrom(input);
    const policyFingerprint = fingerprintPolicy(fields);
    return Object.freeze({
      payloadVersion: POLICY_PAYLOAD_VERSION,
      policyFingerprint,
      ...fields,
    });
  } catch {
    throw invalid();
  }
}

export function evaluateBuyRisk(input: unknown): ExecutionBuyRiskDecisionV1 {
  try {
    const fields = riskInputFrom(input);
    const policy = fields.policy;
    const rawCapital = policy.initialCapitalLamports + fields.realizedNetPnlLamports;
    const reconciledCapitalLamports = minimum(
      maximum(0n, rawCapital),
      policy.maximumCapitalLamports,
    );
    const capitalAfterFeeReserveLamports = maximum(
      0n,
      reconciledCapitalLamports - policy.feeReserveLamports,
    );
    const positionLimitLamports = capitalAfterFeeReserveLamports
      * policy.positionSizeBps / BPS_DENOMINATOR;
    const totalExposureLimitLamports = reconciledCapitalLamports
      * policy.maximumTotalExposureBps / BPS_DENOMINATOR;
    const projectedExposureLamports = saturatedU64Add(
      fields.reservedExposureLamports,
      fields.requestedQuoteAmountRaw,
    );
    const conservativeUnrealizedLossLamports = fields.openPositions.reduce(
      (sum, position) => saturatedU64Add(
        sum,
        maximum(
          0n,
          position.costBasisLamports - (position.conservativeLiquidationLamports ?? 0n),
        ),
      ),
      0n,
    );
    const drawdownBps = drawdownBasisPoints(
      conservativeUnrealizedLossLamports,
      reconciledCapitalLamports,
    );
    const reasonCode = rejectionReason(
      fields,
      positionLimitLamports,
      totalExposureLimitLamports,
      projectedExposureLamports,
      drawdownBps,
    );
    return Object.freeze({
      payloadVersion: DECISION_PAYLOAD_VERSION,
      kind: reasonCode === null ? 'ADMISSIBLE' : 'REJECTED',
      reasonCode,
      reconciledCapitalLamports,
      capitalAfterFeeReserveLamports,
      positionLimitLamports,
      totalExposureLimitLamports,
      projectedExposureLamports,
      conservativeUnrealizedLossLamports,
      drawdownBps,
      openPositionCount: fields.openPositions.length,
    });
  } catch {
    throw invalid();
  }
}

function policyInputFrom(value: unknown): ExecutionRiskPolicyInputV1 {
  const record = exactRecord(value, POLICY_INPUT_KEYS);
  const quoteMintAllowlist = quoteMintAllowlistFrom(record.quoteMintAllowlist);
  const initialCapitalLamports = unsignedBigint(record.initialCapitalLamports);
  const maximumCapitalLamports = positiveBigint(record.maximumCapitalLamports);
  const positionSizeBps = boundedBigint(record.positionSizeBps, 1n, 1_000n);
  const maximumOpenPositions = boundedInteger(record.maximumOpenPositions, 1, 2);
  const maximumTotalExposureBps = boundedBigint(
    record.maximumTotalExposureBps, 1n, 2_000n,
  );
  const drawdownPauseBps = boundedBigint(record.drawdownPauseBps, 1n, 2_500n);
  const feeReserveLamports = unsignedBigint(record.feeReserveLamports);
  const walletSnapshotMaxAgeMs = boundedInteger(record.walletSnapshotMaxAgeMs, 1, 900_000);
  const providerUsageMaxAgeMs = boundedInteger(
    record.providerUsageMaxAgeMs, 30_000, 900_000,
  );
  const providerEntryCostUnits = positiveBigint(record.providerEntryCostUnits);
  const providerExitCostUnitsPerPosition = positiveBigint(
    record.providerExitCostUnitsPerPosition,
  );
  const providerConfirmationCostUnitsPerPosition = positiveBigint(
    record.providerConfirmationCostUnitsPerPosition,
  );
  const providerReconciliationCostUnitsPerPosition = positiveBigint(
    record.providerReconciliationCostUnitsPerPosition,
  );
  const providerSafetyMarginUnits = unsignedBigint(record.providerSafetyMarginUnits);
  const maximumConsecutiveTechnicalFailures = boundedInteger(
    record.maximumConsecutiveTechnicalFailures, 2, 2,
  );
  if (initialCapitalLamports > maximumCapitalLamports
    || feeReserveLamports > maximumCapitalLamports) throw invalid();
  return Object.freeze({
    quoteMintAllowlist,
    initialCapitalLamports,
    maximumCapitalLamports,
    positionSizeBps,
    maximumOpenPositions,
    maximumTotalExposureBps,
    drawdownPauseBps,
    feeReserveLamports,
    walletSnapshotMaxAgeMs,
    providerUsageMaxAgeMs,
    providerEntryCostUnits,
    providerExitCostUnitsPerPosition,
    providerConfirmationCostUnitsPerPosition,
    providerReconciliationCostUnitsPerPosition,
    providerSafetyMarginUnits,
    maximumConsecutiveTechnicalFailures: maximumConsecutiveTechnicalFailures as 2,
  });
}

function policyFrom(value: unknown): ExecutionRiskPolicyV1 {
  if (!isFrozenPlainObject(value)) throw invalid();
  const record = exactRecord(value, POLICY_KEYS);
  if (record.payloadVersion !== POLICY_PAYLOAD_VERSION) throw invalid();
  const policyFingerprint = fingerprintFrom(record.policyFingerprint);
  const fields = policyInputFrom(Object.freeze(pick(record, POLICY_INPUT_KEYS)));
  if (policyFingerprint !== fingerprintPolicy(fields)) throw invalid();
  return Object.freeze({
    payloadVersion: POLICY_PAYLOAD_VERSION,
    policyFingerprint,
    ...fields,
  });
}

function riskInputFrom(value: unknown): ExecutionBuyRiskInputV1 {
  const record = exactRecord(value, RISK_INPUT_KEYS);
  const policy = policyFrom(record.policy);
  const quoteMint = text(record.quoteMint, 64);
  const requestedQuoteAmountRaw = positiveBigint(record.requestedQuoteAmountRaw);
  const realizedNetPnlLamports = signedBigint(record.realizedNetPnlLamports);
  const reservedExposureLamports = unsignedBigint(record.reservedExposureLamports);
  const openPositions = positionsFrom(record.openPositions);
  const consecutiveTechnicalFailures = boundedInteger(
    record.consecutiveTechnicalFailures, 0, 2_147_483_647,
  );
  const lastTechnicalFailureReasonCode = nullableTechnicalFailureReason(
    record.lastTechnicalFailureReasonCode,
  );
  if ((consecutiveTechnicalFailures === 0) !== (lastTechnicalFailureReasonCode === null)) {
    throw invalid();
  }
  return Object.freeze({
    policy,
    quoteMint,
    requestedQuoteAmountRaw,
    realizedNetPnlLamports,
    reservedExposureLamports,
    openPositions,
    consecutiveTechnicalFailures,
    lastTechnicalFailureReasonCode,
  });
}

function positionsFrom(value: unknown): readonly ExecutionOpenPositionRiskInputV1[] {
  if (!Array.isArray(value) || isProxy(value) || value.length > MAX_POSITION_INPUTS) throw invalid();
  const result: ExecutionOpenPositionRiskInputV1[] = [];
  const identities = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
    const record = exactRecord(descriptor.value, POSITION_KEYS);
    const positionId = text(record.positionId, 128);
    if (identities.has(positionId)) throw invalid();
    identities.add(positionId);
    const costBasisLamports = unsignedBigint(record.costBasisLamports);
    const conservativeLiquidationLamports = nullableUnsignedBigint(
      record.conservativeLiquidationLamports,
    );
    const reconciliationStatus = record.reconciliationStatus;
    if (reconciliationStatus !== 'RECONCILED' && reconciliationStatus !== 'UNKNOWN') {
      throw invalid();
    }
    result.push(Object.freeze({
      positionId,
      costBasisLamports,
      conservativeLiquidationLamports,
      reconciliationStatus,
    }));
  }
  return Object.freeze(result);
}

function rejectionReason(
  input: ExecutionBuyRiskInputV1,
  positionLimitLamports: bigint,
  totalExposureLimitLamports: bigint,
  projectedExposureLamports: bigint,
  drawdownBps: bigint,
): ExecutionBuyRiskReasonCode | null {
  if (!input.policy.quoteMintAllowlist.includes(input.quoteMint)) {
    return 'QUOTE_MINT_NOT_ALLOWED';
  }
  if (input.openPositions.some(({ reconciliationStatus }) => reconciliationStatus === 'UNKNOWN')) {
    return 'RECONCILIATION_REQUIRED';
  }
  if (input.consecutiveTechnicalFailures
    >= input.policy.maximumConsecutiveTechnicalFailures) {
    return input.lastTechnicalFailureReasonCode ?? 'RECONCILIATION_REQUIRED';
  }
  if (input.requestedQuoteAmountRaw > positionLimitLamports) {
    return 'CAPITAL_LIMIT_EXCEEDED';
  }
  if (input.openPositions.length >= input.policy.maximumOpenPositions
    || projectedExposureLamports > totalExposureLimitLamports) {
    return 'EXPOSURE_LIMIT_EXCEEDED';
  }
  if (drawdownBps >= input.policy.drawdownPauseBps) {
    return 'DRAWDOWN_LIMIT_EXCEEDED';
  }
  return null;
}

function drawdownBasisPoints(loss: bigint, capital: bigint): bigint {
  if (loss === 0n) return 0n;
  if (capital === 0n) return BPS_DENOMINATOR;
  return (loss * BPS_DENOMINATOR + capital - 1n) / capital;
}

function fingerprintPolicy(value: ExecutionRiskPolicyInputV1): string {
  return createHash('sha256').update(JSON.stringify([
    'execution-risk-policy-v1',
    value.quoteMintAllowlist,
    value.initialCapitalLamports.toString(),
    value.maximumCapitalLamports.toString(),
    value.positionSizeBps.toString(),
    value.maximumOpenPositions,
    value.maximumTotalExposureBps.toString(),
    value.drawdownPauseBps.toString(),
    value.feeReserveLamports.toString(),
    value.walletSnapshotMaxAgeMs,
    value.providerUsageMaxAgeMs,
    value.providerEntryCostUnits.toString(),
    value.providerExitCostUnitsPerPosition.toString(),
    value.providerConfirmationCostUnitsPerPosition.toString(),
    value.providerReconciliationCostUnitsPerPosition.toString(),
    value.providerSafetyMarginUnits.toString(),
    value.maximumConsecutiveTechnicalFailures,
  ])).digest('hex');
}

function quoteMintAllowlistFrom(value: unknown): readonly [string] {
  if (!Array.isArray(value) || isProxy(value) || value.length !== 1) throw invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, '0');
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)
    || descriptor.value !== WSOL_MINT) throw invalid();
  return Object.freeze([WSOL_MINT]);
}

function nullableTechnicalFailureReason(value: unknown): ExecutionTechnicalFailureReasonCode | null {
  if (value === null) return null;
  if (typeof value !== 'string'
    || !TECHNICAL_FAILURE_REASON_CODES.has(value as ExecutionIntentReasonCode)) throw invalid();
  return value as ExecutionTechnicalFailureReasonCode;
}

function unsignedBigint(value: unknown): bigint {
  return boundedBigint(value, 0n, U64_MAX);
}

function positiveBigint(value: unknown): bigint {
  return boundedBigint(value, 1n, U64_MAX);
}

function nullableUnsignedBigint(value: unknown): bigint | null {
  return value === null ? null : unsignedBigint(value);
}

function signedBigint(value: unknown): bigint {
  return boundedBigint(value, I128_MIN, I128_MAX);
}

function boundedBigint(value: unknown, minimumValue: bigint, maximumValue: bigint): bigint {
  if (typeof value !== 'bigint' || value < minimumValue || value > maximumValue) throw invalid();
  return value;
}

function boundedInteger(value: unknown, minimumValue: number, maximumValue: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimumValue
    || (value as number) > maximumValue) throw invalid();
  return value as number;
}

function text(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string' || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximumBytes) throw invalid();
  return value;
}

function fingerprintFrom(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw invalid();
  return value;
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

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFrozenPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return isPlainObject(value) && Object.isFrozen(value);
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maximum(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function saturatedU64Add(left: bigint, right: bigint): bigint {
  return left > U64_MAX - right ? U64_MAX : left + right;
}

function invalid(): ExecutionRiskValidationError {
  return new ExecutionRiskValidationError();
}
