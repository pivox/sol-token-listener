import { isProxy } from 'node:util/types';
import {
  assertValidTransactionNotification,
  isCanonicalSolanaProgramId,
  type TransactionNotification,
  type TransactionNotificationIngestionHint,
} from './transaction-ingestion.js';
import { MAX_STRICT_CATCH_UP_SLOT } from './strict-catch-up.js';

export const CATCH_UP_CLASSIFICATION_VERSION = 1 as const;
export const CATCH_UP_CLASSIFICATION_DISPOSITIONS = Object.freeze([
  'ACTIONABLE',
  'DEFERRED',
  'IGNORED',
  'QUARANTINED',
] as const);
export const CATCH_UP_CLASSIFICATION_REASON_CODES = Object.freeze([
  'PUMP_ACTION_SUPPORTED',
  'PUMP_TRADE_UNTRACKED',
  'SOLANA_TRANSACTION_FAILED',
  'NO_SUPPORTED_PUMP_ACTION',
  'PUMP_SCHEMA_UNSUPPORTED',
  'PROVIDER_SIGNATURE_MISSING',
] as const);

export type CatchUpClassificationDisposition =
  (typeof CATCH_UP_CLASSIFICATION_DISPOSITIONS)[number];
export type CatchUpClassificationReasonCode =
  (typeof CATCH_UP_CLASSIFICATION_REASON_CODES)[number];

export const CATCH_UP_CLASSIFICATION_PERSISTENCE = Object.freeze([
  'RECORDED',
  'REPLAYED',
  'ALREADY_ADMITTED',
] as const);

export const CATCH_UP_CLASSIFICATION_ADMISSIONS = Object.freeze([
  'ENQUEUED',
  'NOT_ENQUEUED',
] as const);

export const CATCH_UP_CLASSIFICATION_INGESTION_PRIORITIES = Object.freeze([
  'NORMAL',
  'LAUNCH_CANDIDATE',
  'TRACKED_TRADE',
] as const);

export type CatchUpClassificationPersistence =
  (typeof CATCH_UP_CLASSIFICATION_PERSISTENCE)[number];
export type CatchUpClassificationAdmission =
  (typeof CATCH_UP_CLASSIFICATION_ADMISSIONS)[number];
export type CatchUpClassificationIngestionPriority =
  (typeof CATCH_UP_CLASSIFICATION_INGESTION_PRIORITIES)[number];

/** Immutable, per-write evidence returned by the durable catch-up ledger. */
interface CatchUpClassificationReceiptIdentity {
  readonly signature: string;
  readonly slot: bigint;
  readonly persistence: CatchUpClassificationPersistence;
}

export type CatchUpClassificationReceipt =
  | Readonly<CatchUpClassificationReceiptIdentity & {
      readonly disposition: CatchUpClassificationDisposition;
      readonly persistence: 'RECORDED' | 'REPLAYED';
      readonly admission: CatchUpClassificationAdmission;
      readonly ingestionPriority: CatchUpClassificationIngestionPriority | null;
    }>
  | Readonly<CatchUpClassificationReceiptIdentity & {
      readonly disposition: null;
      readonly persistence: 'ALREADY_ADMITTED';
      readonly admission: 'NOT_ENQUEUED';
      readonly ingestionPriority: null;
    }>;

export interface CatchUpClassification {
  readonly signature: string;
  readonly slot: bigint;
  readonly programIds: readonly string[];
  readonly confirmationStatus: TransactionNotification['confirmationStatus'];
  readonly observedAtMs: number;
  readonly ingestionHint: TransactionNotificationIngestionHint | null;
  readonly ingestionHintMint: string | null;
  readonly classificationVersion: typeof CATCH_UP_CLASSIFICATION_VERSION;
  readonly disposition: CatchUpClassificationDisposition;
  readonly reasonCode: CatchUpClassificationReasonCode;
  readonly mints: readonly string[];
  readonly evidenceFingerprint: string;
  readonly classifiedAtMs: number;
}

const CLASSIFICATION_KEYS = Object.freeze([
  'signature',
  'slot',
  'programIds',
  'confirmationStatus',
  'observedAtMs',
  'ingestionHint',
  'ingestionHintMint',
  'classificationVersion',
  'disposition',
  'reasonCode',
  'mints',
  'evidenceFingerprint',
  'classifiedAtMs',
] as const);

export class CatchUpClassificationValidationError extends TypeError {
  public constructor() {
    super('Invalid catch-up classification.');
    this.name = 'CatchUpClassificationValidationError';
  }
}

export class CatchUpClassificationReceiptValidationError extends TypeError {
  public constructor() {
    super('Invalid catch-up classification receipt.');
    this.name = 'CatchUpClassificationReceiptValidationError';
  }
}

export function createCatchUpClassification(input: unknown): CatchUpClassification {
  try {
    const record = exactDataRecord(input, CLASSIFICATION_KEYS);
    const value = Object.freeze({
      signature: record.signature,
      slot: record.slot,
      programIds: snapshotStringArray(record.programIds),
      confirmationStatus: record.confirmationStatus,
      observedAtMs: record.observedAtMs,
      ingestionHint: record.ingestionHint,
      ingestionHintMint: record.ingestionHintMint,
      classificationVersion: record.classificationVersion,
      disposition: record.disposition,
      reasonCode: record.reasonCode,
      mints: snapshotStringArray(record.mints),
      evidenceFingerprint: record.evidenceFingerprint,
      classifiedAtMs: record.classifiedAtMs,
    });
    assertValidCatchUpClassification(value);
    return value;
  } catch {
    throw invalid();
  }
}

export function assertValidCatchUpClassification(
  value: unknown,
): asserts value is CatchUpClassification {
  try {
    if (!isRecord(value) || isProxy(value) || !Object.isFrozen(value)) throw invalid();
    const record = exactDataRecord(value, CLASSIFICATION_KEYS);
    const programIds = checkedFrozenStringArray(record.programIds);
    const mints = checkedFrozenStringArray(record.mints);
    const notification: TransactionNotification = Object.freeze({
      signature: record.signature as string,
      slot: record.slot as bigint,
      source: 'CATCH_UP',
      ingestionHint: null,
      ingestionHintMint: null,
      programIds,
      confirmationStatus: record.confirmationStatus as TransactionNotification['confirmationStatus'],
      observedAtMs: record.observedAtMs as number,
    });
    assertValidTransactionNotification(notification);
    if (notification.signature !== notification.signature.trim()
      || Buffer.byteLength(notification.signature, 'utf8') > 128
      || record.classificationVersion !== CATCH_UP_CLASSIFICATION_VERSION
      || !isDisposition(record.disposition)
      || !isReasonCode(record.reasonCode)
      || typeof record.evidenceFingerprint !== 'string'
      || !/^[0-9a-f]{64}$/u.test(record.evidenceFingerprint)
      || !validMilliseconds(record.classifiedAtMs)
      || record.classifiedAtMs < notification.observedAtMs) {
      throw invalid();
    }
    assertCanonicalMints(mints);
    assertClassificationDecision(
      record.disposition,
      record.reasonCode,
      record.ingestionHint,
      record.ingestionHintMint,
      mints,
    );
  } catch {
    throw invalid();
  }
}

export function createCatchUpClassificationReceipt(input: unknown): CatchUpClassificationReceipt {
  try {
    const record = exactDataRecord(input, [
      'signature', 'slot', 'disposition', 'persistence', 'admission', 'ingestionPriority',
    ]);
    const value = Object.freeze(record.persistence === 'ALREADY_ADMITTED'
      ? {
        signature: record.signature,
        slot: record.slot,
        disposition: record.disposition,
        persistence: 'ALREADY_ADMITTED' as const,
        admission: record.admission,
        ingestionPriority: record.ingestionPriority,
      }
      : {
        signature: record.signature,
        slot: record.slot,
        disposition: record.disposition,
        persistence: record.persistence,
        admission: record.admission,
        ingestionPriority: record.ingestionPriority,
      });
    assertValidCatchUpClassificationReceipt(value);
    return value;
  } catch {
    throw invalidReceipt();
  }
}

export function assertValidCatchUpClassificationReceipt(
  value: unknown,
): asserts value is CatchUpClassificationReceipt {
  try {
    if (!isRecord(value) || isProxy(value) || !Object.isFrozen(value)) throw invalidReceipt();
    const record = exactDataRecord(value, [
      'signature', 'slot', 'disposition', 'persistence', 'admission', 'ingestionPriority',
    ]);
    if (typeof record.signature !== 'string'
      || record.signature.length === 0
      || record.signature !== record.signature.trim()
      || Buffer.byteLength(record.signature, 'utf8') > 128
      || typeof record.slot !== 'bigint'
      || record.slot < 0n
      || record.slot > MAX_STRICT_CATCH_UP_SLOT
      || !isPersistence(record.persistence)
      || !isAdmission(record.admission)
      || !isIngestionPriorityOrNull(record.ingestionPriority)) {
      throw invalidReceipt();
    }
    if (record.persistence === 'ALREADY_ADMITTED') {
      if (record.disposition !== null || record.admission !== 'NOT_ENQUEUED'
        || record.ingestionPriority !== null) throw invalidReceipt();
      return;
    }
    if (!isDisposition(record.disposition)) throw invalidReceipt();
    if (record.admission === 'ENQUEUED') {
      if (record.ingestionPriority === null
        || record.disposition === 'IGNORED'
        || record.disposition === 'QUARANTINED') throw invalidReceipt();
    } else if (record.ingestionPriority !== null) {
      throw invalidReceipt();
    }
  } catch {
    throw invalidReceipt();
  }
}

function assertClassificationDecision(
  disposition: CatchUpClassificationDisposition,
  reasonCode: CatchUpClassificationReasonCode,
  ingestionHint: unknown,
  ingestionHintMint: unknown,
  mints: readonly string[],
): void {
  if (disposition === 'ACTIONABLE') {
    if (reasonCode !== 'PUMP_ACTION_SUPPORTED' || mints.length === 0
      || !validActionHint(ingestionHint, ingestionHintMint, mints)) throw invalid();
    return;
  }
  if (disposition === 'DEFERRED') {
    if (reasonCode !== 'PUMP_TRADE_UNTRACKED' || mints.length === 0
      || ingestionHint !== 'PUMPFUN_TRADE'
      || !canonicalMintIn(ingestionHintMint, mints)) throw invalid();
    return;
  }
  if (ingestionHint !== null || ingestionHintMint !== null) throw invalid();
  if (disposition === 'IGNORED') {
    if (reasonCode !== 'SOLANA_TRANSACTION_FAILED'
      && reasonCode !== 'NO_SUPPORTED_PUMP_ACTION') throw invalid();
    return;
  }
  if (reasonCode !== 'PUMP_SCHEMA_UNSUPPORTED'
    && reasonCode !== 'PROVIDER_SIGNATURE_MISSING') throw invalid();
}

function validActionHint(
  hint: unknown,
  mint: unknown,
  mints: readonly string[],
): boolean {
  return (hint === 'PUMPFUN_CREATE' && mint === null)
    || (hint === 'PUMPFUN_TRADE' && canonicalMintIn(mint, mints));
}

function canonicalMintIn(value: unknown, mints: readonly string[]): value is string {
  return typeof value === 'string'
    && isCanonicalSolanaProgramId(value)
    && mints.includes(value);
}

function assertCanonicalMints(mints: readonly string[]): void {
  if (mints.length > 16) throw invalid();
  let previous: string | null = null;
  for (const mint of mints) {
    if (!isCanonicalSolanaProgramId(mint)
      || (previous !== null && mint <= previous)) throw invalid();
    previous = mint;
  }
}

function snapshotStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || isProxy(value)) throw invalid();
  const length = exactArrayLength(value);
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)
      || typeof descriptor.value !== 'string') throw invalid();
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function checkedFrozenStringArray(value: unknown): readonly string[] {
  if (!Object.isFrozen(value)) throw invalid();
  return snapshotStringArray(value);
}

function exactArrayLength(value: readonly unknown[]): number {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || (lengthDescriptor.value as number) < 0) throw invalid();
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes('length')) throw invalid();
  return length;
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || isProxy(value) || Array.isArray(value)) throw invalid();
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length) throw invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (!actual.includes(key)) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function isDisposition(value: unknown): value is CatchUpClassificationDisposition {
  return typeof value === 'string'
    && (CATCH_UP_CLASSIFICATION_DISPOSITIONS as readonly string[]).includes(value);
}

function isReasonCode(value: unknown): value is CatchUpClassificationReasonCode {
  return typeof value === 'string'
    && (CATCH_UP_CLASSIFICATION_REASON_CODES as readonly string[]).includes(value);
}

function isPersistence(value: unknown): value is CatchUpClassificationPersistence {
  return typeof value === 'string'
    && (CATCH_UP_CLASSIFICATION_PERSISTENCE as readonly string[]).includes(value);
}

function isAdmission(value: unknown): value is CatchUpClassificationAdmission {
  return typeof value === 'string'
    && (CATCH_UP_CLASSIFICATION_ADMISSIONS as readonly string[]).includes(value);
}

function isIngestionPriorityOrNull(
  value: unknown,
): value is CatchUpClassificationIngestionPriority | null {
  return value === null || (typeof value === 'string'
    && (CATCH_UP_CLASSIFICATION_INGESTION_PRIORITIES as readonly string[]).includes(value));
}

function validMilliseconds(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 8_640_000_000_000_000
    && !Object.is(value, -0);
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function invalid(): CatchUpClassificationValidationError {
  return new CatchUpClassificationValidationError();
}

function invalidReceipt(): CatchUpClassificationReceiptValidationError {
  return new CatchUpClassificationReceiptValidationError();
}
