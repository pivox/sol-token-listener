import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { isRpcProviderId, type RpcProviderId } from './rpc-provider.js';
import {
  MAX_DATE_MS,
  MAX_STRICT_CATCH_UP_SLOT,
} from './strict-catch-up.js';
import type {
  ProcessingCheckpoint,
  ProcessingCheckpointKey,
} from './transaction-ingestion.js';

export const STRICT_CATCH_UP_RUN_ID_VERSION = 1 as const;
export const STRICT_CATCH_UP_RUN_RETENTION_MS = 14_400_000;
export const MAX_STRICT_CATCH_UP_RUN_COUNTER = 9_223_372_036_854_775_807n;
export const STRICT_CATCH_UP_RUN_STATES = Object.freeze([
  'ACTIVE',
  'COMPLETED',
  'FAILED',
  'SUPERSEDED',
] as const);

export type StrictCatchUpRunState = (typeof STRICT_CATCH_UP_RUN_STATES)[number];
export type StrictCatchUpRunTerminalReason =
  | 'CATCH_UP_WINDOW_EXCEEDED'
  | 'CHECKPOINT_SUPERSEDED';

export interface StrictCatchUpRunHead {
  readonly slot: bigint;
  readonly signature: string;
}

export interface StrictCatchUpRun {
  readonly runId: string;
  readonly checkpointKey: ProcessingCheckpointKey;
  readonly previous: ProcessingCheckpoint;
  readonly providerId: RpcProviderId;
  readonly observedHead: StrictCatchUpRunHead;
  readonly beforeSignature: string;
  readonly lastAcceptedSlot: bigint;
  readonly pagesScanned: bigint;
  readonly signaturesEnqueued: bigint;
  readonly revision: bigint;
  readonly state: StrictCatchUpRunState;
  readonly terminalReason: StrictCatchUpRunTerminalReason | null;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly completedAtMs: number | null;
  readonly purgeAfterMs: number | null;
}

export class StrictCatchUpRunValidationError extends TypeError {
  public constructor() {
    super('Invalid strict catch-up run.');
    this.name = 'StrictCatchUpRunValidationError';
  }
}

export function createStrictCatchUpRun(input: unknown): StrictCatchUpRun {
  try {
    const record = ownEnumerableDataRecord(input, [
      'checkpointKey',
      'previous',
      'providerId',
      'observedHead',
      'beforeSignature',
      'lastAcceptedSlot',
      'pagesScanned',
      'signaturesEnqueued',
      'revision',
      'startedAtMs',
      'updatedAtMs',
    ]);
    const checkpointKey = checkpointKeyFrom(record.checkpointKey);
    const previous = snapshotCheckpoint(record.previous, checkpointKey);
    const providerId = providerIdFrom(record.providerId);
    const observedHead = snapshotHead(record.observedHead);
    const beforeSignature = signatureFrom(record.beforeSignature);
    const lastAcceptedSlot = slotFrom(record.lastAcceptedSlot);
    const pagesScanned = positiveCounterFrom(record.pagesScanned);
    const signaturesEnqueued = counterFrom(record.signaturesEnqueued);
    const revision = counterFrom(record.revision);
    const startedAtMs = millisecondsFrom(record.startedAtMs);
    const updatedAtMs = millisecondsFrom(record.updatedAtMs);
    const initialSingleRowHead = beforeSignature === observedHead.signature
      && lastAcceptedSlot === observedHead.slot
      && pagesScanned === 1n
      && signaturesEnqueued === 1n
      && revision === 0n;
    if (
      previous.updatedAtMs > startedAtMs
      || updatedAtMs < startedAtMs
      || observedHead.slot < previous.slot
      || lastAcceptedSlot < previous.slot
      || beforeSignature === previous.signature
      || (beforeSignature === observedHead.signature && !initialSingleRowHead)
      || lastAcceptedSlot > observedHead.slot
    ) throw invalid();

    const result: StrictCatchUpRun = Object.freeze({
      runId: strictCatchUpRunId(checkpointKey, previous, providerId),
      checkpointKey,
      previous,
      providerId,
      observedHead,
      beforeSignature,
      lastAcceptedSlot,
      pagesScanned,
      signaturesEnqueued,
      revision,
      state: 'ACTIVE',
      terminalReason: null,
      startedAtMs,
      updatedAtMs,
      completedAtMs: null,
      purgeAfterMs: null,
    });
    assertValidStrictCatchUpRun(result);
    return result;
  } catch {
    throw invalid();
  }
}

export function advanceStrictCatchUpRun(
  current: unknown,
  input: unknown,
): StrictCatchUpRun {
  try {
    assertValidStrictCatchUpRun(current);
    if (current.state !== 'ACTIVE' || current.revision === MAX_STRICT_CATCH_UP_RUN_COUNTER) {
      throw invalid();
    }
    const record = ownEnumerableDataRecord(input, [
      'beforeSignature',
      'lastAcceptedSlot',
      'pagesScanned',
      'signaturesEnqueued',
      'updatedAtMs',
    ]);
    const beforeSignature = signatureFrom(record.beforeSignature);
    const lastAcceptedSlot = slotFrom(record.lastAcceptedSlot);
    const pagesScanned = positiveCounterFrom(record.pagesScanned);
    const signaturesEnqueued = counterFrom(record.signaturesEnqueued);
    const updatedAtMs = millisecondsFrom(record.updatedAtMs);
    if (
      beforeSignature === current.beforeSignature
      || beforeSignature === current.previous.signature
      || beforeSignature === current.observedHead.signature
      || lastAcceptedSlot < current.previous.slot
      || lastAcceptedSlot > current.lastAcceptedSlot
      || pagesScanned <= current.pagesScanned
      || signaturesEnqueued < current.signaturesEnqueued
      || updatedAtMs < current.updatedAtMs
    ) throw invalid();

    const result = snapshotRun({
      ...current,
      beforeSignature,
      lastAcceptedSlot,
      pagesScanned,
      signaturesEnqueued,
      revision: current.revision + 1n,
      updatedAtMs,
    });
    assertValidStrictCatchUpRun(result);
    return result;
  } catch {
    throw invalid();
  }
}

export function terminalizeStrictCatchUpRun(
  current: unknown,
  input: unknown,
): StrictCatchUpRun {
  try {
    assertValidStrictCatchUpRun(current);
    if (current.state !== 'ACTIVE' || current.revision === MAX_STRICT_CATCH_UP_RUN_COUNTER) {
      throw invalid();
    }
    const record = ownEnumerableDataRecord(input, [
      'state', 'terminalReason', 'completedAtMs',
    ]);
    const state = terminalStateFrom(record.state);
    const terminalReason = terminalReasonFrom(record.terminalReason);
    const completedAtMs = millisecondsFrom(record.completedAtMs);
    if (
      completedAtMs < current.updatedAtMs
      || !terminalReasonMatchesState(state, terminalReason)
      || completedAtMs > MAX_DATE_MS - STRICT_CATCH_UP_RUN_RETENTION_MS
    ) throw invalid();
    const purgeAfterMs = completedAtMs + STRICT_CATCH_UP_RUN_RETENTION_MS;

    const result = snapshotRun({
      ...current,
      revision: current.revision + 1n,
      state,
      terminalReason,
      updatedAtMs: completedAtMs,
      completedAtMs,
      purgeAfterMs,
    });
    assertValidStrictCatchUpRun(result);
    return result;
  } catch {
    throw invalid();
  }
}

export function assertValidStrictCatchUpRun(
  value: unknown,
): asserts value is StrictCatchUpRun {
  try {
    if (!isObject(value) || isProxy(value) || !Object.isFrozen(value)) throw invalid();
    const record = ownEnumerableDataRecord(value, [
      'runId',
      'checkpointKey',
      'previous',
      'providerId',
      'observedHead',
      'beforeSignature',
      'lastAcceptedSlot',
      'pagesScanned',
      'signaturesEnqueued',
      'revision',
      'state',
      'terminalReason',
      'startedAtMs',
      'updatedAtMs',
      'completedAtMs',
      'purgeAfterMs',
    ]);
    const checkpointKey = checkpointKeyFrom(record.checkpointKey);
    const previous = checkedCheckpoint(record.previous, checkpointKey);
    const providerId = providerIdFrom(record.providerId);
    const observedHead = checkedHead(record.observedHead);
    const beforeSignature = signatureFrom(record.beforeSignature);
    const lastAcceptedSlot = slotFrom(record.lastAcceptedSlot);
    const pagesScanned = positiveCounterFrom(record.pagesScanned);
    const signaturesEnqueued = counterFrom(record.signaturesEnqueued);
    const revision = counterFrom(record.revision);
    const state = stateFrom(record.state);
    const terminalReason = terminalReasonFrom(record.terminalReason);
    const startedAtMs = millisecondsFrom(record.startedAtMs);
    const updatedAtMs = millisecondsFrom(record.updatedAtMs);
    const completedAtMs = nullableMillisecondsFrom(record.completedAtMs);
    const purgeAfterMs = nullableMillisecondsFrom(record.purgeAfterMs);
    const initialSingleRowHead = beforeSignature === observedHead.signature
      && lastAcceptedSlot === observedHead.slot
      && pagesScanned === 1n
      && signaturesEnqueued === 1n
      && ((state === 'ACTIVE' && revision === 0n)
        || (state !== 'ACTIVE' && revision === 1n));
    if (
      typeof record.runId !== 'string'
      || record.runId !== strictCatchUpRunId(checkpointKey, previous, providerId)
      || previous.updatedAtMs > startedAtMs
      || updatedAtMs < startedAtMs
      || observedHead.slot < previous.slot
      || lastAcceptedSlot < previous.slot
      || beforeSignature === previous.signature
      || (beforeSignature === observedHead.signature && !initialSingleRowHead)
      || lastAcceptedSlot > observedHead.slot
    ) throw invalid();

    if (state === 'ACTIVE') {
      if (terminalReason !== null || completedAtMs !== null || purgeAfterMs !== null) throw invalid();
      return;
    }
    if (
      completedAtMs === null
      || purgeAfterMs === null
      || completedAtMs !== updatedAtMs
      || completedAtMs < startedAtMs
      || completedAtMs > MAX_DATE_MS - STRICT_CATCH_UP_RUN_RETENTION_MS
      || purgeAfterMs !== completedAtMs + STRICT_CATCH_UP_RUN_RETENTION_MS
      || !terminalReasonMatchesState(state, terminalReason)
    ) throw invalid();
  } catch {
    throw invalid();
  }
}

function snapshotRun(value: StrictCatchUpRun): StrictCatchUpRun {
  return Object.freeze({
    ...value,
    previous: Object.freeze({ ...value.previous }),
    observedHead: Object.freeze({ ...value.observedHead }),
  });
}

function checkedCheckpoint(
  value: unknown,
  checkpointKey: ProcessingCheckpointKey,
): ProcessingCheckpoint {
  if (!isObject(value) || isProxy(value) || !Object.isFrozen(value)) throw invalid();
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

function checkedHead(value: unknown): StrictCatchUpRunHead {
  if (!isObject(value) || isProxy(value) || !Object.isFrozen(value)) throw invalid();
  return snapshotHead(value);
}

function snapshotHead(value: unknown): StrictCatchUpRunHead {
  const record = ownEnumerableDataRecord(value, ['slot', 'signature']);
  return Object.freeze({
    slot: slotFrom(record.slot),
    signature: signatureFrom(record.signature),
  });
}

function strictCatchUpRunId(
  checkpointKey: ProcessingCheckpointKey,
  previous: ProcessingCheckpoint,
  providerId: RpcProviderId,
): string {
  const canonical = JSON.stringify([
    STRICT_CATCH_UP_RUN_ID_VERSION,
    checkpointKey,
    previous.slot.toString(),
    previous.signature,
    providerId,
  ]);
  return `strict_catchup_run_${createHash('sha256').update(canonical).digest('hex')}`;
}

function ownEnumerableDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (!isObject(value) || isProxy(value) || Array.isArray(value)) throw invalid();
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

function providerIdFrom(value: unknown): RpcProviderId {
  if (!isRpcProviderId(value)) throw invalid();
  return value;
}

function stateFrom(value: unknown): StrictCatchUpRunState {
  if (typeof value !== 'string' || !(STRICT_CATCH_UP_RUN_STATES as readonly string[]).includes(value)) {
    throw invalid();
  }
  return value as StrictCatchUpRunState;
}

function terminalStateFrom(value: unknown): Exclude<StrictCatchUpRunState, 'ACTIVE'> {
  const state = stateFrom(value);
  if (state === 'ACTIVE') throw invalid();
  return state;
}

function terminalReasonFrom(value: unknown): StrictCatchUpRunTerminalReason | null {
  if (
    value !== null
    && value !== 'CATCH_UP_WINDOW_EXCEEDED'
    && value !== 'CHECKPOINT_SUPERSEDED'
  ) throw invalid();
  return value;
}

function terminalReasonMatchesState(
  state: Exclude<StrictCatchUpRunState, 'ACTIVE'>,
  terminalReason: StrictCatchUpRunTerminalReason | null,
): boolean {
  return (state === 'COMPLETED' && terminalReason === null)
    || (state === 'FAILED' && terminalReason === 'CATCH_UP_WINDOW_EXCEEDED')
    || (state === 'SUPERSEDED' && terminalReason === 'CHECKPOINT_SUPERSEDED');
}

function slotFrom(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_STRICT_CATCH_UP_SLOT) {
    throw invalid();
  }
  return value;
}

function positiveCounterFrom(value: unknown): bigint {
  const counter = counterFrom(value);
  if (counter === 0n) throw invalid();
  return counter;
}

function counterFrom(value: unknown): bigint {
  if (
    typeof value !== 'bigint'
    || value < 0n
    || value > MAX_STRICT_CATCH_UP_RUN_COUNTER
  ) throw invalid();
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

function nullableMillisecondsFrom(value: unknown): number | null {
  if (value === null) return null;
  return millisecondsFrom(value);
}

function millisecondsFrom(value: unknown): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < 0
    || (value as number) > MAX_DATE_MS
    || Object.is(value, -0)
  ) throw invalid();
  return value as number;
}

function invalid(): StrictCatchUpRunValidationError {
  return new StrictCatchUpRunValidationError();
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}
