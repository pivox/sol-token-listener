import type { NormalizedTransaction } from '../solana/rpc/types.js';
import type { ChainConfirmationStatus } from './types.js';

export const TRANSACTION_INBOX_STATUSES = Object.freeze([
  'PENDING',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
] as const);

export const LISTENER_RUNTIME_STATES = Object.freeze([
  'STARTING',
  'RUNNING',
  'DEGRADED',
  'STOPPING',
  'STOPPED',
] as const);

export const TRANSACTION_INGESTION_ERROR_CODES = Object.freeze([
  'RPC_TRANSIENT',
  'TRANSACTION_NOT_AVAILABLE',
  'BLOCK_NOT_AVAILABLE',
  'TRANSACTION_INDEX_NOT_FOUND',
  'NORMALIZATION_FAILED',
  'PIPELINE_STAGE_FAILED',
  'FINALITY_INCONSISTENT',
  'CATCH_UP_WINDOW_EXCEEDED',
] as const);

export type TransactionInboxStatus = (typeof TRANSACTION_INBOX_STATUSES)[number];
export type ListenerRuntimeState = (typeof LISTENER_RUNTIME_STATES)[number];
export type IngestionComponentState = ListenerRuntimeState;
export type TransactionDiscoverySource = 'WEBSOCKET' | 'CATCH_UP';
export type TransactionIngestionErrorCode =
  | 'RPC_TRANSIENT'
  | 'TRANSACTION_NOT_AVAILABLE'
  | 'BLOCK_NOT_AVAILABLE'
  | 'TRANSACTION_INDEX_NOT_FOUND'
  | 'NORMALIZATION_FAILED'
  | 'PIPELINE_STAGE_FAILED'
  | 'FINALITY_INCONSISTENT'
  | 'CATCH_UP_WINDOW_EXCEEDED';
export type ProcessingCheckpointKey = 'launchpad' | 'market';

export interface TransactionNotification {
  readonly signature: string;
  readonly slot: bigint;
  readonly source: TransactionDiscoverySource;
  readonly confirmationStatus: Exclude<ChainConfirmationStatus, 'orphaned'>;
  readonly observedAtMs: number;
}

export interface ClaimedTransaction {
  readonly signature: string;
  readonly slot: bigint;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly attempts: number;
  readonly leaseToken: string;
  readonly leaseExpiresAtMs: number;
  readonly normalizedTransaction: Readonly<NormalizedTransaction> | null;
}

export interface IngestionFailure {
  readonly code: TransactionIngestionErrorCode;
  readonly errorName: string;
  readonly retryable: boolean;
}

export interface ProcessingCheckpoint {
  readonly key: ProcessingCheckpointKey;
  readonly slot: bigint;
  readonly signature: string;
  readonly updatedAtMs: number;
}

export interface FinalityCandidate {
  readonly signature: string;
  readonly slot: bigint;
  readonly confirmationStatus: Extract<ChainConfirmationStatus, 'processed' | 'confirmed'>;
  readonly missingFinalityPolls: number;
  readonly processedAtMs: number;
}

export interface FinalityRevision {
  readonly signature: string;
  readonly confirmationStatus: Extract<ChainConfirmationStatus, 'finalized' | 'orphaned'>;
  readonly observedAtMs: number;
}

export interface RuntimeHeartbeat {
  readonly runtimeState: ListenerRuntimeState;
  readonly subscriberState: IngestionComponentState;
  readonly scannerState: IngestionComponentState;
  readonly workerState: IngestionComponentState;
  readonly reconcilerState: IngestionComponentState;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly lastHttpSlot: bigint | null;
  readonly lastWebsocketSlot: bigint | null;
  readonly lastFinalizedSlot: bigint | null;
  readonly lastSignature: string | null;
  readonly backlogCount: number;
  readonly leasedCount: number;
}

export interface InboxCounts {
  readonly pending: number;
  readonly processing: number;
  readonly processed: number;
  readonly failed: number;
}

export function assertValidTransactionNotification(
  value: unknown,
): asserts value is TransactionNotification {
  const record = frozenRecord(value, 'Transaction notification');
  assertText(record.signature, 'Transaction notification signature');
  assertSlot(record.slot, 'Transaction notification slot');
  if (record.source !== 'WEBSOCKET' && record.source !== 'CATCH_UP') {
    throw new TypeError('Transaction notification source is invalid.');
  }
  if (!isObservedConfirmationStatus(record.confirmationStatus)) {
    throw new TypeError('Transaction notification confirmation status is invalid.');
  }
  assertMilliseconds(record.observedAtMs, 'Transaction notification observedAtMs');
}

export function assertValidClaimedTransaction(
  value: unknown,
): asserts value is ClaimedTransaction {
  const record = frozenRecord(value, 'Claimed transaction');
  assertText(record.signature, 'Claimed transaction signature');
  assertSlot(record.slot, 'Claimed transaction slot');
  if (!isChainConfirmationStatus(record.confirmationStatus)) {
    throw new TypeError('Claimed transaction confirmation status is invalid.');
  }
  assertCount(record.attempts, 'Claimed transaction attempts');
  assertText(record.leaseToken, 'Claimed transaction leaseToken');
  assertMilliseconds(record.leaseExpiresAtMs, 'Claimed transaction leaseExpiresAtMs');
  if (record.normalizedTransaction !== null) {
    frozenRecord(record.normalizedTransaction, 'Claimed normalized transaction');
  }
}

export function assertValidIngestionFailure(
  value: unknown,
): asserts value is IngestionFailure {
  const record = frozenRecord(value, 'Ingestion failure');
  if (!TRANSACTION_INGESTION_ERROR_CODES.includes(record.code as TransactionIngestionErrorCode)) {
    throw new TypeError('Ingestion failure code is invalid.');
  }
  assertText(record.errorName, 'Ingestion failure errorName');
  if (typeof record.retryable !== 'boolean') {
    throw new TypeError('Ingestion failure retryable must be boolean.');
  }
}

export function assertValidProcessingCheckpoint(
  value: unknown,
): asserts value is ProcessingCheckpoint {
  const record = frozenRecord(value, 'Processing checkpoint');
  if (record.key !== 'launchpad' && record.key !== 'market') {
    throw new TypeError('Processing checkpoint key is invalid.');
  }
  assertSlot(record.slot, 'Processing checkpoint slot');
  assertText(record.signature, 'Processing checkpoint signature');
  assertMilliseconds(record.updatedAtMs, 'Processing checkpoint updatedAtMs');
}

export function assertValidFinalityCandidate(
  value: unknown,
): asserts value is FinalityCandidate {
  const record = frozenRecord(value, 'Finality candidate');
  assertText(record.signature, 'Finality candidate signature');
  assertSlot(record.slot, 'Finality candidate slot');
  if (record.confirmationStatus !== 'processed' && record.confirmationStatus !== 'confirmed') {
    throw new TypeError('Finality candidate confirmation status is invalid.');
  }
  assertCount(record.missingFinalityPolls, 'Finality candidate missingFinalityPolls');
  assertMilliseconds(record.processedAtMs, 'Finality candidate processedAtMs');
}

export function assertValidFinalityRevision(
  value: unknown,
): asserts value is FinalityRevision {
  const record = frozenRecord(value, 'Finality revision');
  assertText(record.signature, 'Finality revision signature');
  if (record.confirmationStatus !== 'finalized' && record.confirmationStatus !== 'orphaned') {
    throw new TypeError('Finality revision confirmation status is invalid.');
  }
  assertMilliseconds(record.observedAtMs, 'Finality revision observedAtMs');
}

export function assertValidRuntimeHeartbeat(
  value: unknown,
): asserts value is RuntimeHeartbeat {
  const record = frozenRecord(value, 'Runtime heartbeat');
  for (const field of [
    'runtimeState',
    'subscriberState',
    'scannerState',
    'workerState',
    'reconcilerState',
  ] as const) {
    if (!LISTENER_RUNTIME_STATES.includes(record[field] as ListenerRuntimeState)) {
      throw new TypeError(`Runtime heartbeat ${field} is invalid.`);
    }
  }
  assertMilliseconds(record.startedAtMs, 'Runtime heartbeat startedAtMs');
  assertMilliseconds(record.updatedAtMs, 'Runtime heartbeat updatedAtMs');
  if (record.updatedAtMs < record.startedAtMs) {
    throw new TypeError('Runtime heartbeat updatedAtMs precedes startedAtMs.');
  }
  assertNullableSlot(record.lastHttpSlot, 'Runtime heartbeat lastHttpSlot');
  assertNullableSlot(record.lastWebsocketSlot, 'Runtime heartbeat lastWebsocketSlot');
  assertNullableSlot(record.lastFinalizedSlot, 'Runtime heartbeat lastFinalizedSlot');
  assertNullableText(record.lastSignature, 'Runtime heartbeat lastSignature');
  assertCount(record.backlogCount, 'Runtime heartbeat backlogCount');
  assertCount(record.leasedCount, 'Runtime heartbeat leasedCount');
  if (record.leasedCount > record.backlogCount) {
    throw new TypeError('Runtime heartbeat leasedCount exceeds backlogCount.');
  }
}

export function assertValidInboxCounts(value: unknown): asserts value is InboxCounts {
  const record = frozenRecord(value, 'Inbox counts');
  assertCount(record.pending, 'Inbox counts pending');
  assertCount(record.processing, 'Inbox counts processing');
  assertCount(record.processed, 'Inbox counts processed');
  assertCount(record.failed, 'Inbox counts failed');
}

function frozenRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  if (!Object.isFrozen(value)) throw new TypeError(`${name} must be frozen.`);
  return value as Readonly<Record<string, unknown>>;
}

function assertSlot(value: unknown, name: string): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new TypeError(`${name} must be a non-negative bigint.`);
  }
}

function assertNullableSlot(value: unknown, name: string): asserts value is bigint | null {
  if (value === null) return;
  assertSlot(value, name);
}

function assertMilliseconds(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw new TypeError(`${name} must be non-negative safe integer milliseconds.`);
  }
}

function assertCount(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
}

function assertText(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be non-empty text.`);
  }
}

function assertNullableText(value: unknown, name: string): asserts value is string | null {
  if (value === null) return;
  assertText(value, name);
}

function isObservedConfirmationStatus(
  value: unknown,
): value is Exclude<ChainConfirmationStatus, 'orphaned'> {
  return value === 'processed' || value === 'confirmed' || value === 'finalized';
}

function isChainConfirmationStatus(value: unknown): value is ChainConfirmationStatus {
  return isObservedConfirmationStatus(value) || value === 'orphaned';
}
