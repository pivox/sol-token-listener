import type { NormalizedTransaction } from '../solana/rpc/types.js';
import { reconcileConfirmationStatus } from './confirmation-status.js';
import { assertValidChainCursor, assertValidTransactionCursor } from './cursor.js';
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
export type TransactionIngestionErrorCode = (typeof TRANSACTION_INGESTION_ERROR_CODES)[number];
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
    assertValidNormalizedTransaction(record.normalizedTransaction);
    if (record.normalizedTransaction.signature !== record.signature) {
      throw new TypeError('Claimed normalized transaction signature does not match claim identity.');
    }
    if (record.normalizedTransaction.slot !== record.slot) {
      throw new TypeError('Claimed normalized transaction slot does not match claim identity.');
    }
    assertCompatibleSnapshotFinality(
      record.normalizedTransaction.confirmationStatus,
      record.confirmationStatus,
    );
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

function assertValidNormalizedTransaction(value: unknown): asserts value is Readonly<NormalizedTransaction> {
  const snapshot = frozenRecord(value, 'Claimed normalized transaction snapshot');
  assertText(snapshot.signature, 'Normalized transaction signature');
  assertSlot(snapshot.slot, 'Normalized transaction slot');
  assertNullableIndex(snapshot.transactionIndex, 'Normalized transaction transactionIndex');
  if (snapshot.transactionIndex === null) {
    throw new TypeError('Normalized transaction transactionIndex must be canonical.');
  }
  assertValidTransactionCursor({
    slot: snapshot.slot,
    transactionIndex: snapshot.transactionIndex,
  });
  if (!isLegacyConfirmationStatus(snapshot.confirmationStatus)) {
    throw new TypeError('Normalized transaction confirmationStatus is invalid.');
  }
  if (snapshot.version !== 'legacy') {
    assertCount(snapshot.version, 'Normalized transaction version');
  }
  assertNullableMilliseconds(snapshot.blockTimeMs, 'Normalized transaction blockTimeMs');

  const accountKeys = frozenStringArray(snapshot.accountKeys, 'Normalized transaction accountKeys');
  const signerKeys = frozenStringArray(snapshot.signerKeys, 'Normalized transaction signerKeys');
  if (signerKeys.length > accountKeys.length) {
    throw new TypeError('Normalized transaction signerKeys exceed accountKeys.');
  }
  signerKeys.forEach((key, index) => {
    if (key !== accountKeys[index]) {
      throw new TypeError('Normalized transaction signerKeys must be an accountKeys prefix.');
    }
  });

  const instructions = frozenArray(snapshot.instructions, 'Normalized transaction instructions');
  for (const [index, instructionValue] of instructions.entries()) {
    const instruction = frozenRecord(
      instructionValue,
      `Normalized transaction instructions[${index}]`,
    );
    assertText(instruction.programId, `Normalized transaction instructions[${index}].programId`);
    frozenStringArray(
      instruction.accounts,
      `Normalized transaction instructions[${index}].accounts`,
    );
    if (!(instruction.data instanceof Uint8Array)) {
      throw new TypeError(`Normalized transaction instructions[${index}].data must be Uint8Array.`);
    }
    assertNullableIndex(
      instruction.innerInstructionIndex,
      `Normalized transaction instructions[${index}].innerInstructionIndex`,
    );
    assertNullableIndex(
      instruction.parentInstructionIndex,
      `Normalized transaction instructions[${index}].parentInstructionIndex`,
    );
    assertNullablePositiveInteger(
      instruction.stackHeight,
      `Normalized transaction instructions[${index}].stackHeight`,
    );
    assertCount(
      instruction.instructionIndex,
      `Normalized transaction instructions[${index}].instructionIndex`,
    );
    assertValidChainCursor({
      slot: snapshot.slot,
      transactionIndex: snapshot.transactionIndex,
      instructionIndex: instruction.instructionIndex,
      innerInstructionIndex: instruction.innerInstructionIndex,
    });
    const isInner = instruction.innerInstructionIndex !== null;
    if (isInner !== (instruction.parentInstructionIndex !== null)) {
      throw new TypeError(`Normalized transaction instructions[${index}] parent cursor is inconsistent.`);
    }
    if (
      instruction.parentInstructionIndex !== null
      && instruction.parentInstructionIndex !== instruction.instructionIndex
    ) {
      throw new TypeError(`Normalized transaction instructions[${index}] parent cursor is inconsistent.`);
    }
  }

  assertTokenBalances(snapshot.preTokenBalances, accountKeys, 'preTokenBalances');
  assertTokenBalances(snapshot.postTokenBalances, accountKeys, 'postTokenBalances');
  assertLamportBalances(snapshot.preBalancesLamports, accountKeys.length, 'preBalancesLamports');
  assertLamportBalances(snapshot.postBalancesLamports, accountKeys.length, 'postBalancesLamports');
  assertAmount(snapshot.feeLamports, 'Normalized transaction feeLamports');
  assertNullableAmount(snapshot.computeUnits, 'Normalized transaction computeUnits');
  frozenStringArray(snapshot.logs, 'Normalized transaction logs');
  assertDeepFrozenData(snapshot.error, 'Normalized transaction error');
}

function assertCompatibleSnapshotFinality(
  snapshotStatus: NormalizedTransaction['confirmationStatus'],
  claimStatus: ChainConfirmationStatus,
): void {
  const current = fromLegacyConfirmationStatus(snapshotStatus);
  let reconciliation: ReturnType<typeof reconcileConfirmationStatus>;
  try {
    reconciliation = reconcileConfirmationStatus(current, claimStatus);
  } catch {
    throw new TypeError('Normalized transaction confirmation finality conflicts with claim.');
  }
  if (reconciliation === 'keep' && current !== claimStatus) {
    throw new TypeError('Normalized transaction confirmation finality regresses from snapshot.');
  }
}

function assertTokenBalances(
  value: unknown,
  accountKeys: readonly string[],
  field: string,
): void {
  const balances = frozenArray(value, `Normalized transaction ${field}`);
  for (const [index, balanceValue] of balances.entries()) {
    const balance = frozenRecord(balanceValue, `Normalized transaction ${field}[${index}]`);
    assertCount(balance.accountIndex, `Normalized transaction ${field}[${index}].accountIndex`);
    if (balance.accountIndex >= accountKeys.length) {
      throw new TypeError(`Normalized transaction ${field}[${index}].accountIndex is out of range.`);
    }
    assertText(balance.account, `Normalized transaction ${field}[${index}].account`);
    if (balance.account !== accountKeys[balance.accountIndex]) {
      throw new TypeError(`Normalized transaction ${field}[${index}].account is inconsistent.`);
    }
    assertText(balance.mint, `Normalized transaction ${field}[${index}].mint`);
    assertNullableText(balance.owner, `Normalized transaction ${field}[${index}].owner`);
    assertText(balance.tokenProgram, `Normalized transaction ${field}[${index}].tokenProgram`);
    assertAmount(balance.amountRaw, `Normalized transaction ${field}[${index}].amountRaw`);
    assertCount(balance.decimals, `Normalized transaction ${field}[${index}].decimals`);
    if (balance.decimals > 255) {
      throw new TypeError(`Normalized transaction ${field}[${index}].decimals exceeds u8.`);
    }
  }
}

function assertLamportBalances(value: unknown, accountCount: number, field: string): void {
  const balances = frozenArray(value, `Normalized transaction ${field}`);
  if (balances.length !== accountCount) {
    throw new TypeError(`Normalized transaction ${field} must align with accountKeys.`);
  }
  balances.forEach((amount, index) => {
    assertAmount(amount, `Normalized transaction ${field}[${index}]`);
  });
}

function frozenArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  if (!Object.isFrozen(value)) throw new TypeError(`${name} must be frozen.`);
  return value;
}

function frozenStringArray(value: unknown, name: string): readonly string[] {
  const values = frozenArray(value, name);
  values.forEach((item, index) => { assertText(item, `${name}[${index}]`); });
  return values as readonly string[];
}

function assertAmount(value: unknown, name: string): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new TypeError(`${name} must be a non-negative bigint.`);
  }
}

function assertNullableAmount(value: unknown, name: string): asserts value is bigint | null {
  if (value === null) return;
  assertAmount(value, name);
}

function assertNullableIndex(value: unknown, name: string): asserts value is number | null {
  if (value === null) return;
  assertCount(value, name);
}

function assertNullablePositiveInteger(value: unknown, name: string): asserts value is number | null {
  if (value === null) return;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} must be a positive safe integer or null.`);
  }
}

function assertNullableMilliseconds(value: unknown, name: string): asserts value is number | null {
  if (value === null) return;
  assertMilliseconds(value, name);
}

function assertDeepFrozenData(value: unknown, name: string): void {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
  ) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${name} number must be finite.`);
    return;
  }
  if (Array.isArray(value)) {
    if (!Object.isFrozen(value)) throw new TypeError(`${name} must be deeply frozen.`);
    value.forEach((item, index) => { assertDeepFrozenData(item, `${name}[${index}]`); });
    return;
  }
  const record = frozenRecord(value, name);
  for (const key of Object.keys(record)) {
    assertDeepFrozenData(record[key], `${name}.${key}`);
  }
}

function isLegacyConfirmationStatus(
  value: unknown,
): value is NormalizedTransaction['confirmationStatus'] {
  return value === 'PROCESSED'
    || value === 'CONFIRMED'
    || value === 'FINALIZED'
    || value === 'ORPHANED';
}

function fromLegacyConfirmationStatus(
  value: NormalizedTransaction['confirmationStatus'],
): ChainConfirmationStatus {
  switch (value) {
    case 'PROCESSED': return 'processed';
    case 'CONFIRMED': return 'confirmed';
    case 'FINALIZED': return 'finalized';
    case 'ORPHANED': return 'orphaned';
  }
}
