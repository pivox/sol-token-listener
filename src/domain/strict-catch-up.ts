import { createHash } from 'node:crypto';
import type { ProcessingCheckpoint, ProcessingCheckpointKey } from './transaction-ingestion.js';

export const STRICT_CATCH_UP_FAILURE_ID_VERSION = 1 as const;
export const STRICT_CATCH_UP_FAILURE_REASON = 'CATCH_UP_WINDOW_EXCEEDED' as const;

export type StrictCatchUpProviderId = 'primary' | 'fallback-1' | 'fallback-2' | 'fallback-3';
export type RpcProviderId = StrictCatchUpProviderId;

export interface StrictCatchUpFailure {
  readonly failureId: string;
  readonly checkpointKey: ProcessingCheckpointKey;
  readonly previous: ProcessingCheckpoint | null;
  readonly providerId: StrictCatchUpProviderId;
  readonly observedHeadSlot: bigint | null;
  readonly reasonCode: typeof STRICT_CATCH_UP_FAILURE_REASON;
  readonly detectedAtMs: number;
}

export class StrictCatchUpFailureValidationError extends TypeError {
  public constructor() {
    super('Invalid strict catch-up failure.');
    this.name = 'StrictCatchUpFailureValidationError';
  }
}

export function createStrictCatchUpFailure(input: unknown): StrictCatchUpFailure {
  const record = ownEnumerableDataRecord(input, [
    'checkpointKey', 'previous', 'providerId', 'observedHeadSlot', 'detectedAtMs',
  ]);
  const checkpointKey = checkpointKeyFrom(record.checkpointKey);
  const previous = snapshotPrevious(record.previous, checkpointKey);
  const providerId = providerIdFrom(record.providerId);
  const observedHeadSlot = nullableSlotFrom(record.observedHeadSlot);
  const detectedAtMs = millisecondsFrom(record.detectedAtMs);
  const result: StrictCatchUpFailure = Object.freeze({
    failureId: strictCatchUpFailureId(checkpointKey, previous, providerId, observedHeadSlot),
    checkpointKey,
    previous,
    providerId,
    observedHeadSlot,
    reasonCode: STRICT_CATCH_UP_FAILURE_REASON,
    detectedAtMs,
  });
  assertValidStrictCatchUpFailure(result);
  return result;
}

export function assertValidStrictCatchUpFailure(
  value: unknown,
): asserts value is StrictCatchUpFailure {
  try {
    if (!Object.isFrozen(value)) throw invalid();
    const record = ownEnumerableDataRecord(value, [
      'failureId', 'checkpointKey', 'previous', 'providerId', 'observedHeadSlot', 'reasonCode',
      'detectedAtMs',
    ]);
    const checkpointKey = checkpointKeyFrom(record.checkpointKey);
    const previous = checkedPrevious(record.previous, checkpointKey);
    const providerId = providerIdFrom(record.providerId);
    const observedHeadSlot = nullableSlotFrom(record.observedHeadSlot);
    millisecondsFrom(record.detectedAtMs);
    if (record.reasonCode !== STRICT_CATCH_UP_FAILURE_REASON) throw invalid();
    if (typeof record.failureId !== 'string') throw invalid();
    if (record.failureId !== strictCatchUpFailureId(
      checkpointKey, previous, providerId, observedHeadSlot,
    )) throw invalid();
  } catch {
    throw invalid();
  }
}

function checkedPrevious(
  value: unknown,
  checkpointKey: ProcessingCheckpointKey,
): ProcessingCheckpoint | null {
  if (value === null) return null;
  if (!Object.isFrozen(value)) throw invalid();
  return snapshotCheckpoint(value, checkpointKey);
}

function snapshotPrevious(
  value: unknown,
  checkpointKey: ProcessingCheckpointKey,
): ProcessingCheckpoint | null {
  if (value === null) return null;
  return snapshotCheckpoint(value, checkpointKey);
}

function snapshotCheckpoint(
  value: unknown,
  checkpointKey: ProcessingCheckpointKey,
): ProcessingCheckpoint {
  const record = ownEnumerableDataRecord(value, ['key', 'slot', 'signature', 'updatedAtMs']);
  const key = checkpointKeyFrom(record.key);
  const slot = slotFrom(record.slot);
  const signature = signatureFrom(record.signature);
  const updatedAtMs = millisecondsFrom(record.updatedAtMs);
  if (key !== checkpointKey) throw invalid();
  return Object.freeze({ key, slot, signature, updatedAtMs });
}

function strictCatchUpFailureId(
  checkpointKey: ProcessingCheckpointKey,
  previous: ProcessingCheckpoint | null,
  providerId: StrictCatchUpProviderId,
  observedHeadSlot: bigint | null,
): string {
  const boundary = previous === null ? null : [previous.slot.toString(), previous.signature];
  const canonical = JSON.stringify([
    STRICT_CATCH_UP_FAILURE_ID_VERSION,
    checkpointKey,
    boundary,
    providerId,
    observedHeadSlot?.toString() ?? null,
    STRICT_CATCH_UP_FAILURE_REASON,
  ]);
  return `strict_catchup_failure_${createHash('sha256').update(canonical).digest('hex')}`;
}

function ownEnumerableDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
    const prototype: object | null = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length) throw invalid();
    const result: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      if (!keys.includes(key)) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw invalid();
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw invalid();
  }
}

function checkpointKeyFrom(value: unknown): ProcessingCheckpointKey {
  if (value !== 'launchpad' && value !== 'market') throw invalid();
  return value;
}

function providerIdFrom(value: unknown): StrictCatchUpProviderId {
  if (value === 'primary' || value === 'fallback-1' || value === 'fallback-2' || value === 'fallback-3') {
    return value;
  }
  throw invalid();
}

function nullableSlotFrom(value: unknown): bigint | null {
  if (value === null) return null;
  return slotFrom(value);
}

function slotFrom(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw invalid();
  return value;
}

function signatureFrom(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > 128
  ) throw invalid();
  return value;
}

function millisecondsFrom(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw invalid();
  }
  return value as number;
}

function invalid(): StrictCatchUpFailureValidationError {
  return new StrictCatchUpFailureValidationError();
}
