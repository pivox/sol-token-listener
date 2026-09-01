import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { ExecutionIntentReasonCode } from './execution-intent.js';

const PAYLOAD_VERSION = 1 as const;
const U64_MAX = 18_446_744_073_709_551_615n;
const I128_MAX = (1n << 127n) - 1n;
const I128_MIN = -(1n << 127n);
const DATE_MAX_MS = 8_640_000_000_000_000;
const ROOT_KEYS = Object.freeze(['expected', 'observed'] as const);
const EXPECTED_KEYS = Object.freeze([
  'intentId', 'attemptNumber', 'walletGeneration', 'providerId', 'side',
  'signature', 'blockhash', 'lastValidBlockHeight', 'messageHash',
  'buildFingerprint', 'snapshotFingerprint', 'maximumFeeLamports',
  'maximumFeePayerLamportDebit',
] as const);
const OBSERVED_KEYS = Object.freeze([
  'signatureHistory', 'confirmationStatus', 'finalizedBlockHeight',
  'observedSlot', 'transaction', 'feeLamports', 'walletLamportDelta',
  'baseDeltaRaw', 'quoteDeltaRaw', 'unexpectedResidualTokenBalanceRaw',
  'observedAtMs', 'finalizedAtMs',
] as const);
const TRANSACTION_KEYS = Object.freeze([
  'signature', 'blockhash', 'messageHash', 'buildFingerprint',
  'snapshotFingerprint',
] as const);
const SIGNATURE_HISTORY = Object.freeze(['PRESENT', 'ABSENT', 'UNKNOWN'] as const);
const CONFIRMATION_STATUSES = Object.freeze([
  'FINALIZED', 'CONFIRMED', 'ORPHANED', 'NOT_FOUND',
] as const);
const SIDES = Object.freeze(['BUY', 'SELL'] as const);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/u;

export type ExecutionReconciliationResult =
  | 'MATCHED' | 'NO_EFFECT' | 'MISMATCH' | 'UNKNOWN';
export type ExecutionReconciliationReasonCode = Extract<ExecutionIntentReasonCode,
  | 'INTENT_SUCCEEDED'
  | 'RECONCILIATION_PROVED_NO_EFFECT'
  | 'RECONCILIATION_REQUIRED'
  | 'BALANCE_MISMATCH'
  | 'RESIDUAL_TOKEN_BALANCE'
  | 'DOUBLE_ORDER_SUSPECTED'>;

export interface ExecutionReconciliationEvidenceV1 {
  readonly evidenceId: string;
  readonly payloadVersion: 1;
  readonly evidenceFingerprint: string;
  readonly intentId: string;
  readonly attemptNumber: number;
  readonly walletGeneration: number;
  readonly providerId: string;
  readonly side: 'BUY' | 'SELL';
  readonly signature: string;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly messageHash: string;
  readonly buildFingerprint: string;
  readonly snapshotFingerprint: string;
  readonly maximumFeeLamports: bigint;
  readonly maximumFeePayerLamportDebit: bigint;
  readonly signatureHistory: 'PRESENT' | 'ABSENT' | 'UNKNOWN';
  readonly confirmationStatus: 'FINALIZED' | 'CONFIRMED' | 'ORPHANED' | 'NOT_FOUND';
  readonly finalizedBlockHeight: bigint;
  readonly observedSlot: bigint | null;
  readonly observedTransactionFingerprint: string | null;
  readonly feeLamports: bigint;
  readonly walletLamportDelta: bigint;
  readonly baseDeltaRaw: bigint;
  readonly quoteDeltaRaw: bigint;
  readonly unexpectedResidualTokenBalanceRaw: bigint;
  readonly observedAtMs: number;
  readonly finalizedAtMs: number | null;
  readonly result: ExecutionReconciliationResult;
  readonly reasonCode: ExecutionReconciliationReasonCode;
}

type ExecutionReconciliationEvidenceFields = Omit<ExecutionReconciliationEvidenceV1,
  'evidenceId' | 'payloadVersion' | 'evidenceFingerprint'>;

interface ExpectedEvidence {
  readonly intentId: string;
  readonly attemptNumber: number;
  readonly walletGeneration: number;
  readonly providerId: string;
  readonly side: 'BUY' | 'SELL';
  readonly signature: string;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly messageHash: string;
  readonly buildFingerprint: string;
  readonly snapshotFingerprint: string;
  readonly maximumFeeLamports: bigint;
  readonly maximumFeePayerLamportDebit: bigint;
}

interface NormalizedTransaction {
  readonly signature: string;
  readonly blockhash: string;
  readonly messageHash: string;
  readonly buildFingerprint: string;
  readonly snapshotFingerprint: string;
}

interface ObservedEvidence {
  readonly signatureHistory: 'PRESENT' | 'ABSENT' | 'UNKNOWN';
  readonly confirmationStatus: 'FINALIZED' | 'CONFIRMED' | 'ORPHANED' | 'NOT_FOUND';
  readonly finalizedBlockHeight: bigint;
  readonly observedSlot: bigint | null;
  readonly transaction: NormalizedTransaction | null;
  readonly feeLamports: bigint;
  readonly walletLamportDelta: bigint;
  readonly baseDeltaRaw: bigint;
  readonly quoteDeltaRaw: bigint;
  readonly unexpectedResidualTokenBalanceRaw: bigint;
  readonly observedAtMs: number;
  readonly finalizedAtMs: number | null;
}

export class ExecutionReconciliationValidationError extends TypeError {
  public constructor() {
    super('Invalid execution reconciliation input.');
    this.name = 'ExecutionReconciliationValidationError';
  }
}

export function evaluateExecutionReconciliation(
  input: unknown,
): ExecutionReconciliationEvidenceV1 {
  try {
    const root = exactRecord(input, ROOT_KEYS);
    const expected = expectedFrom(root.expected);
    const observed = observedFrom(root.observed);
    const outcome = classify(expected, observed);
    const observedTransactionFingerprint = observed.transaction === null
      ? null
      : transactionFingerprint(observed.transaction);
    const fields = {
      intentId: expected.intentId,
      attemptNumber: expected.attemptNumber,
      walletGeneration: expected.walletGeneration,
      providerId: expected.providerId,
      side: expected.side,
      signature: expected.signature,
      blockhash: expected.blockhash,
      lastValidBlockHeight: expected.lastValidBlockHeight,
      messageHash: expected.messageHash,
      buildFingerprint: expected.buildFingerprint,
      snapshotFingerprint: expected.snapshotFingerprint,
      maximumFeeLamports: expected.maximumFeeLamports,
      maximumFeePayerLamportDebit: expected.maximumFeePayerLamportDebit,
      signatureHistory: observed.signatureHistory,
      confirmationStatus: observed.confirmationStatus,
      finalizedBlockHeight: observed.finalizedBlockHeight,
      observedSlot: observed.observedSlot,
      observedTransactionFingerprint,
      feeLamports: observed.feeLamports,
      walletLamportDelta: observed.walletLamportDelta,
      baseDeltaRaw: observed.baseDeltaRaw,
      quoteDeltaRaw: observed.quoteDeltaRaw,
      unexpectedResidualTokenBalanceRaw: observed.unexpectedResidualTokenBalanceRaw,
      observedAtMs: observed.observedAtMs,
      finalizedAtMs: observed.finalizedAtMs,
      result: outcome.result,
      reasonCode: outcome.reasonCode,
    } as const;
    return evidenceFromFields(fields);
  } catch {
    throw invalid();
  }
}

export function assertExecutionReconciliationEvidenceIdentity(
  evidence: ExecutionReconciliationEvidenceV1,
): void {
  try {
    const { evidenceId, payloadVersion, evidenceFingerprint, ...fields } = evidence;
    const canonical = evidenceFromFields(fields);
    if (!Object.is(payloadVersion, PAYLOAD_VERSION)
      || evidenceId !== canonical.evidenceId
      || evidenceFingerprint !== canonical.evidenceFingerprint) throw invalid();
  } catch {
    throw invalid();
  }
}

function classify(
  expected: ExpectedEvidence,
  observed: ObservedEvidence,
): Readonly<{
  result: ExecutionReconciliationResult;
  reasonCode: ExecutionReconciliationReasonCode;
}> {
  if (observed.unexpectedResidualTokenBalanceRaw > 0n) {
    return outcome('MISMATCH', 'RESIDUAL_TOKEN_BALANCE');
  }
  if (observed.transaction !== null && !sameTransaction(expected, observed.transaction)) {
    return outcome('MISMATCH', 'DOUBLE_ORDER_SUSPECTED');
  }
  const hasAnyDelta = observed.feeLamports !== 0n
    || observed.walletLamportDelta !== 0n
    || observed.baseDeltaRaw !== 0n
    || observed.quoteDeltaRaw !== 0n;
  if ((observed.signatureHistory === 'ABSENT' || observed.transaction === null)
    && hasAnyDelta) return outcome('MISMATCH', 'BALANCE_MISMATCH');
  if (isMatched(expected, observed)) return outcome('MATCHED', 'INTENT_SUCCEEDED');
  if (observed.signatureHistory === 'PRESENT'
    && observed.confirmationStatus === 'FINALIZED'
    && observed.transaction !== null) {
    return outcome('MISMATCH', 'BALANCE_MISMATCH');
  }
  if (observed.signatureHistory === 'ABSENT'
    && observed.confirmationStatus === 'NOT_FOUND'
    && observed.finalizedBlockHeight > expected.lastValidBlockHeight
    && observed.transaction === null
    && !hasAnyDelta
    && observed.finalizedAtMs !== null) {
    return outcome('NO_EFFECT', 'RECONCILIATION_PROVED_NO_EFFECT');
  }
  return outcome('UNKNOWN', 'RECONCILIATION_REQUIRED');
}

function isMatched(expected: ExpectedEvidence, observed: ObservedEvidence): boolean {
  if (observed.signatureHistory !== 'PRESENT'
    || observed.confirmationStatus !== 'FINALIZED'
    || observed.finalizedAtMs === null
    || observed.observedSlot === null
    || observed.transaction === null
    || observed.feeLamports > expected.maximumFeeLamports) return false;
  if (expected.side === 'BUY') {
    return observed.baseDeltaRaw > 0n
      && observed.quoteDeltaRaw < 0n
      && observed.walletLamportDelta < 0n
      && -observed.walletLamportDelta <= expected.maximumFeePayerLamportDebit;
  }
  return observed.baseDeltaRaw < 0n
    && observed.quoteDeltaRaw > 0n
    && observed.walletLamportDelta > 0n;
}

function sameTransaction(expected: ExpectedEvidence, observed: NormalizedTransaction): boolean {
  return observed.signature === expected.signature
    && observed.blockhash === expected.blockhash
    && observed.messageHash === expected.messageHash
    && observed.buildFingerprint === expected.buildFingerprint
    && observed.snapshotFingerprint === expected.snapshotFingerprint;
}

function expectedFrom(value: unknown): ExpectedEvidence {
  if (!isFrozenPlainObject(value)) throw invalid();
  const record = exactRecord(value, EXPECTED_KEYS);
  return Object.freeze({
    intentId: intentId(record.intentId),
    attemptNumber: positiveInteger(record.attemptNumber),
    walletGeneration: positiveInteger(record.walletGeneration),
    providerId: identifier(record.providerId),
    side: enumValue(record.side, SIDES),
    signature: base58(record.signature, 64, 96),
    blockhash: base58(record.blockhash, 32, 64),
    lastValidBlockHeight: unsignedBigint(record.lastValidBlockHeight),
    messageHash: fingerprint(record.messageHash),
    buildFingerprint: fingerprint(record.buildFingerprint),
    snapshotFingerprint: fingerprint(record.snapshotFingerprint),
    maximumFeeLamports: unsignedBigint(record.maximumFeeLamports),
    maximumFeePayerLamportDebit: unsignedBigint(record.maximumFeePayerLamportDebit),
  });
}

function observedFrom(value: unknown): ObservedEvidence {
  if (!isFrozenPlainObject(value)) throw invalid();
  const record = exactRecord(value, OBSERVED_KEYS);
  const result: ObservedEvidence = Object.freeze({
    signatureHistory: enumValue(record.signatureHistory, SIGNATURE_HISTORY),
    confirmationStatus: enumValue(record.confirmationStatus, CONFIRMATION_STATUSES),
    finalizedBlockHeight: unsignedBigint(record.finalizedBlockHeight),
    observedSlot: nullableUnsignedBigint(record.observedSlot),
    transaction: transactionFrom(record.transaction),
    feeLamports: unsignedBigint(record.feeLamports),
    walletLamportDelta: signedBigint(record.walletLamportDelta),
    baseDeltaRaw: signedBigint(record.baseDeltaRaw),
    quoteDeltaRaw: signedBigint(record.quoteDeltaRaw),
    unexpectedResidualTokenBalanceRaw: unsignedBigint(
      record.unexpectedResidualTokenBalanceRaw,
    ),
    observedAtMs: timestamp(record.observedAtMs),
    finalizedAtMs: nullableTimestamp(record.finalizedAtMs),
  });
  if (result.finalizedAtMs !== null && result.finalizedAtMs < result.observedAtMs) throw invalid();
  if (result.confirmationStatus === 'FINALIZED'
    && (result.finalizedAtMs === null || result.observedSlot === null
      || result.signatureHistory !== 'PRESENT' || result.transaction === null)) throw invalid();
  if (result.confirmationStatus === 'CONFIRMED'
    && (result.finalizedAtMs !== null || result.observedSlot === null)) throw invalid();
  if (result.confirmationStatus === 'NOT_FOUND'
    && (result.observedSlot !== null || result.transaction !== null
      || result.signatureHistory === 'PRESENT')) throw invalid();
  return result;
}

function transactionFrom(value: unknown): NormalizedTransaction | null {
  if (value === null) return null;
  if (!isFrozenPlainObject(value)) throw invalid();
  const record = exactRecord(value, TRANSACTION_KEYS);
  return Object.freeze({
    signature: base58(record.signature, 64, 96),
    blockhash: base58(record.blockhash, 32, 64),
    messageHash: fingerprint(record.messageHash),
    buildFingerprint: fingerprint(record.buildFingerprint),
    snapshotFingerprint: fingerprint(record.snapshotFingerprint),
  });
}

function transactionFingerprint(value: NormalizedTransaction): string {
  return hash([
    'normalized-execution-transaction-v1', value.signature, value.blockhash,
    value.messageHash, value.buildFingerprint, value.snapshotFingerprint,
  ]);
}

function evidenceFingerprintFor(
  value: ExecutionReconciliationEvidenceFields,
): string {
  return hash([
    'execution-reconciliation-evidence-v1', value.intentId, value.attemptNumber,
    value.walletGeneration, value.providerId, value.side, value.signature,
    value.blockhash, value.lastValidBlockHeight.toString(), value.messageHash,
    value.buildFingerprint, value.snapshotFingerprint, value.maximumFeeLamports.toString(),
    value.maximumFeePayerLamportDebit.toString(), value.signatureHistory,
    value.confirmationStatus, value.finalizedBlockHeight.toString(),
    value.observedSlot?.toString() ?? null, value.observedTransactionFingerprint,
    value.feeLamports.toString(), value.walletLamportDelta.toString(),
    value.baseDeltaRaw.toString(), value.quoteDeltaRaw.toString(),
    value.unexpectedResidualTokenBalanceRaw.toString(), value.observedAtMs,
    value.finalizedAtMs, value.result, value.reasonCode,
  ]);
}

function evidenceFromFields(
  fields: ExecutionReconciliationEvidenceFields,
): ExecutionReconciliationEvidenceV1 {
  const evidenceFingerprint = evidenceFingerprintFor(fields);
  const evidenceId = `execution_reconciliation_${hash([
    'execution-reconciliation-id-v1', fields.intentId,
    fields.attemptNumber, evidenceFingerprint,
  ])}`;
  return Object.freeze({
    evidenceId,
    payloadVersion: PAYLOAD_VERSION,
    evidenceFingerprint,
    ...fields,
  });
}

function outcome(
  result: ExecutionReconciliationResult,
  reasonCode: ExecutionReconciliationReasonCode,
): Readonly<{ result: ExecutionReconciliationResult; reasonCode: ExecutionReconciliationReasonCode }> {
  return Object.freeze({ result, reasonCode });
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

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw invalid();
  return value;
}

function intentId(value: unknown): string {
  if (typeof value !== 'string' || !/^execution_intent_[0-9a-f]{64}$/u.test(value)) throw invalid();
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
    throw invalid();
  }
  return value;
}

function base58(value: unknown, minimumLength: number, maximumLength: number): string {
  if (typeof value !== 'string' || value.length < minimumLength
    || value.length > maximumLength || !BASE58.test(value)) throw invalid();
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

function nullableUnsignedBigint(value: unknown): bigint | null {
  return value === null ? null : unsignedBigint(value);
}

function signedBigint(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < I128_MIN || value > I128_MAX) throw invalid();
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw invalid();
  return value as number;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0
    || (value as number) > DATE_MAX_MS) throw invalid();
  return value as number;
}

function nullableTimestamp(value: unknown): number | null {
  return value === null ? null : timestamp(value);
}

function hash(value: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFrozenPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return isPlainObject(value) && Object.isFrozen(value);
}

function invalid(): ExecutionReconciliationValidationError {
  return new ExecutionReconciliationValidationError();
}
