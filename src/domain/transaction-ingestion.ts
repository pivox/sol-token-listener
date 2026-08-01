import { PublicKey } from '@solana/web3.js';
import type { NormalizedTransaction } from '../solana/rpc/types.js';
import { reconcileConfirmationStatus } from './confirmation-status.js';
import { assertValidChainCursor, assertValidTransactionCursor } from './cursor.js';
import type { ChainConfirmationStatus } from './types.js';

export const MAX_TRANSACTION_SNAPSHOT_DEPTH = 64;
export const MAX_TRANSACTION_SNAPSHOT_NODES = 10_000;
export const MAX_TRANSACTION_SNAPSHOT_ARRAY_LENGTH = 4_096;
export const MAX_TRANSACTION_SNAPSHOT_STRING_LENGTH = 16_384;
export const MAX_TRANSACTION_SNAPSHOT_TEXT_BYTES = 1_048_576;
export const MAX_TRANSACTION_SNAPSHOT_INSTRUCTION_BYTES = 1_232;
export const MAX_TRANSACTION_NOTIFICATION_PROGRAM_IDS = 16;
export const MIN_TRANSACTION_NOTIFICATION_PROGRAM_ID_BYTES = 32;
export const MAX_TRANSACTION_NOTIFICATION_PROGRAM_ID_BYTES = 44;

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
export type DurableSnapshotValue =
  | null
  | string
  | boolean
  | number
  | bigint
  | readonly DurableSnapshotValue[]
  | DurableSnapshotObject;

export interface DurableSnapshotObject {
  readonly [key: string]: DurableSnapshotValue;
}

export interface DurableNormalizedInstruction {
  readonly programId: string;
  readonly accounts: readonly string[];
  readonly dataBase64: string;
  readonly instructionIndex: number;
  readonly innerInstructionIndex: number | null;
  readonly parentInstructionIndex: number | null;
  readonly stackHeight: number | null;
}

export interface DurableNormalizedTokenBalance {
  readonly accountIndex: number;
  readonly account: string;
  readonly mint: string;
  readonly owner: string | null;
  readonly tokenProgram: string;
  readonly amountRaw: bigint;
  readonly decimals: number;
}

export interface DurableNormalizedTransaction {
  readonly signature: string;
  readonly slot: bigint;
  readonly transactionIndex: number;
  readonly confirmationStatus: NormalizedTransaction['confirmationStatus'];
  readonly version: number | 'legacy';
  readonly blockTimeMs: number | null;
  readonly accountKeys: readonly string[];
  readonly signerKeys: readonly string[];
  readonly instructions: readonly DurableNormalizedInstruction[];
  readonly preTokenBalances: readonly DurableNormalizedTokenBalance[];
  readonly postTokenBalances: readonly DurableNormalizedTokenBalance[];
  readonly preBalancesLamports: readonly bigint[];
  readonly postBalancesLamports: readonly bigint[];
  readonly feeLamports: bigint;
  readonly computeUnits: bigint | null;
  readonly logs: readonly string[];
  readonly error: DurableSnapshotValue;
}

export interface TransactionNotification {
  readonly signature: string;
  readonly slot: bigint;
  readonly source: TransactionDiscoverySource;
  readonly programIds: readonly string[];
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
  readonly normalizedTransaction: DurableNormalizedTransaction | null;
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

export interface FinalityPollObservation {
  readonly signature: string;
  readonly confirmationStatus: Extract<ChainConfirmationStatus, 'processed' | 'confirmed'> | null;
  readonly expectedMissingFinalityPolls: number;
  readonly observedAtMs: number;
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

export function createDurableTransactionSnapshot(
  transaction: NormalizedTransaction,
): DurableNormalizedTransaction {
  const instructions = Object.freeze(transaction.instructions.map((instruction, index) => {
    if (!(instruction.data instanceof Uint8Array)) {
      throw new TypeError(`Normalized transaction instructions[${index}].data must be Uint8Array.`);
    }
    assertInstructionByteLength(instruction.data.byteLength);
    return Object.freeze({
      programId: instruction.programId,
      accounts: Object.freeze([...instruction.accounts]),
      dataBase64: Buffer.from(instruction.data).toString('base64'),
      instructionIndex: instruction.instructionIndex,
      innerInstructionIndex: instruction.innerInstructionIndex,
      parentInstructionIndex: instruction.parentInstructionIndex,
      stackHeight: instruction.stackHeight,
    });
  }));
  const snapshot = Object.freeze({
    signature: transaction.signature,
    slot: transaction.slot,
    transactionIndex: transaction.transactionIndex,
    confirmationStatus: transaction.confirmationStatus,
    version: transaction.version,
    blockTimeMs: transaction.blockTimeMs,
    accountKeys: Object.freeze([...transaction.accountKeys]),
    signerKeys: Object.freeze([...transaction.signerKeys]),
    instructions,
    preTokenBalances: freezeTokenBalances(transaction.preTokenBalances),
    postTokenBalances: freezeTokenBalances(transaction.postTokenBalances),
    preBalancesLamports: Object.freeze([...transaction.preBalancesLamports]),
    postBalancesLamports: Object.freeze([...transaction.postBalancesLamports]),
    feeLamports: transaction.feeLamports,
    computeUnits: transaction.computeUnits,
    logs: Object.freeze([...transaction.logs]),
    error: freezeDurableSnapshotValue(transaction.error),
  });
  return readValidDurableNormalizedTransaction(snapshot);
}

export function restoreNormalizedTransactionSnapshot(
  snapshot: DurableNormalizedTransaction,
): NormalizedTransaction {
  const validated = readValidDurableNormalizedTransaction(snapshot);
  return {
    signature: validated.signature,
    slot: validated.slot,
    transactionIndex: validated.transactionIndex,
    confirmationStatus: validated.confirmationStatus,
    version: validated.version,
    blockTimeMs: validated.blockTimeMs,
    accountKeys: [...validated.accountKeys],
    signerKeys: [...validated.signerKeys],
    instructions: validated.instructions.map((instruction) => ({
      programId: instruction.programId,
      accounts: [...instruction.accounts],
      data: Uint8Array.from(Buffer.from(instruction.dataBase64, 'base64')),
      instructionIndex: instruction.instructionIndex,
      innerInstructionIndex: instruction.innerInstructionIndex,
      parentInstructionIndex: instruction.parentInstructionIndex,
      stackHeight: instruction.stackHeight,
    })),
    preTokenBalances: validated.preTokenBalances.map((balance) => ({ ...balance })),
    postTokenBalances: validated.postTokenBalances.map((balance) => ({ ...balance })),
    preBalancesLamports: [...validated.preBalancesLamports],
    postBalancesLamports: [...validated.postBalancesLamports],
    feeLamports: validated.feeLamports,
    computeUnits: validated.computeUnits,
    logs: [...validated.logs],
    error: restoreDurableSnapshotValue(validated.error),
  };
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
  assertCanonicalProgramIds(record.programIds);
  if (!isObservedConfirmationStatus(record.confirmationStatus)) {
    throw new TypeError('Transaction notification confirmation status is invalid.');
  }
  assertMilliseconds(record.observedAtMs, 'Transaction notification observedAtMs');
}

function assertCanonicalProgramIds(value: unknown): void {
  const programIds = frozenStringArray(value, 'Transaction notification programIds');
  if (programIds.length < 1 || programIds.length > MAX_TRANSACTION_NOTIFICATION_PROGRAM_IDS) {
    throw new TypeError('Transaction notification programIds count is invalid.');
  }
  let previous: string | null = null;
  for (const programId of programIds) {
    const byteLength = Buffer.byteLength(programId, 'utf8');
    if (programId !== programId.trim()
      || byteLength < MIN_TRANSACTION_NOTIFICATION_PROGRAM_ID_BYTES
      || byteLength > MAX_TRANSACTION_NOTIFICATION_PROGRAM_ID_BYTES
      || !isCanonicalSolanaProgramId(programId)
      || (previous !== null && programId <= previous)) {
      throw new TypeError('Transaction notification programIds are not canonical.');
    }
    previous = programId;
  }
}

export function isCanonicalSolanaProgramId(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
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
    const snapshot = readValidDurableNormalizedTransaction(record.normalizedTransaction);
    if (snapshot.signature !== record.signature) {
      throw new TypeError('Claimed normalized transaction signature does not match claim identity.');
    }
    if (snapshot.slot !== record.slot) {
      throw new TypeError('Claimed normalized transaction slot does not match claim identity.');
    }
    assertCompatibleSnapshotFinality(
      snapshot.confirmationStatus,
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

export function assertValidFinalityPollObservation(
  value: unknown,
): asserts value is FinalityPollObservation {
  const record = frozenRecord(value, 'Finality poll observation');
  assertText(record.signature, 'Finality poll observation signature');
  if (record.confirmationStatus !== null
    && record.confirmationStatus !== 'processed'
    && record.confirmationStatus !== 'confirmed') {
    throw new TypeError('Finality poll observation confirmationStatus is invalid.');
  }
  assertCount(
    record.expectedMissingFinalityPolls,
    'Finality poll observation expectedMissingFinalityPolls',
  );
  assertMilliseconds(record.observedAtMs, 'Finality poll observation observedAtMs');
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
  const snapshot = snapshotSafeDurableData(value, name, true);
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return snapshot as Readonly<Record<string, unknown>>;
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

function readValidDurableNormalizedTransaction(
  value: unknown,
): DurableNormalizedTransaction {
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
    assertCanonicalBase64(
      instruction.dataBase64,
      `Normalized transaction instructions[${index}].dataBase64`,
    );
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
  return snapshot as unknown as DurableNormalizedTransaction;
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
    assertString(balance.tokenProgram, `Normalized transaction ${field}[${index}].tokenProgram`);
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
  const snapshot = snapshotSafeDurableData(value, name, true);
  if (!Array.isArray(snapshot)) throw new TypeError(`${name} must be an array.`);
  return snapshot;
}

function frozenStringArray(value: unknown, name: string): readonly string[] {
  const values = frozenArray(value, name);
  values.forEach((item, index) => { assertText(item, `${name}[${index}]`); });
  return values as readonly string[];
}

function freezeTokenBalances(
  balances: NormalizedTransaction['preTokenBalances'],
): readonly DurableNormalizedTokenBalance[] {
  return Object.freeze(balances.map((balance) => Object.freeze({ ...balance })));
}

function freezeDurableSnapshotValue(value: unknown): DurableSnapshotValue {
  return snapshotSafeDurableData(value, 'Normalized transaction error', false);
}

function restoreDurableSnapshotValue(value: DurableSnapshotValue): unknown {
  if (Array.isArray(value)) {
    const items = value as readonly DurableSnapshotValue[];
    return items.map((item) => restoreDurableSnapshotValue(item));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      restoreDurableSnapshotValue(item),
    ]));
  }
  return value;
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
    if (Object.is(value, -0)) throw new TypeError(`${name} must not be negative zero.`);
    return;
  }
  if (Array.isArray(value)) {
    const items = frozenArray(value, name);
    items.forEach((item, index) => { assertDeepFrozenData(item, `${name}[${index}]`); });
    return;
  }
  const record = frozenRecord(value, name);
  for (const key of Object.keys(record)) {
    assertDeepFrozenData(record[key], `${name}.${key}`);
  }
}

function assertCanonicalBase64(value: unknown, name: string): asserts value is string {
  assertString(value, name);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TypeError(`${name} must be canonical base64.`);
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedLength = (value.length / 4 * 3) - padding;
  assertInstructionByteLength(decodedLength);
  if (Buffer.from(value, 'base64').toString('base64') !== value) {
    throw new TypeError(`${name} must be canonical base64.`);
  }
}

function assertInstructionByteLength(value: number): void {
  if (value > MAX_TRANSACTION_SNAPSHOT_INSTRUCTION_BYTES) {
    throw new TypeError('Durable transaction snapshot exceeds maximum instruction bytes.');
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string.`);
}

function snapshotSafeDurableData(
  value: unknown,
  name: string,
  requireFrozen: boolean,
  state: DurableSnapshotState = { ancestors: new WeakSet(), nodes: 0, textBytes: 0 },
  depth = 0,
): DurableSnapshotValue {
  if (depth > MAX_TRANSACTION_SNAPSHOT_DEPTH) {
    throw new TypeError('Durable transaction snapshot exceeds maximum depth.');
  }
  state.nodes += 1;
  if (state.nodes > MAX_TRANSACTION_SNAPSHOT_NODES) {
    throw new TypeError('Durable transaction snapshot exceeds maximum node count.');
  }
  if (
    value === null
    || typeof value === 'boolean'
    || typeof value === 'bigint'
  ) return value;
  if (typeof value === 'string') {
    addSnapshotTextBytes(state, value, name);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${name} number must be finite.`);
    if (Object.is(value, -0)) throw new TypeError(`${name} must not be negative zero.`);
    return value;
  }
  if (typeof value !== 'object') throw new TypeError(`${name} must be durable data.`);
  if (requireFrozen && !Object.isFrozen(value)) throw new TypeError(`${name} must be frozen.`);
  if (state.ancestors.has(value)) throw new TypeError(`${name} must not contain cycles.`);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return snapshotSafeDurableArray(value, name, requireFrozen, state, depth);
    }
    return snapshotSafeDurableRecord(value, name, requireFrozen, state, depth);
  } finally {
    state.ancestors.delete(value);
  }
}

interface DurableSnapshotState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
  textBytes: number;
}

function snapshotSafeDurableArray(
  value: unknown[],
  name: string,
  requireFrozen: boolean,
  state: DurableSnapshotState,
  depth: number,
): readonly DurableSnapshotValue[] {
  if (Reflect.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${name} array prototype is invalid.`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
    throw new TypeError(`${name} array length must be a data property.`);
  }
  const length: unknown = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    throw new TypeError(`${name} array length is invalid.`);
  }
  if ((length as number) > MAX_TRANSACTION_SNAPSHOT_ARRAY_LENGTH) {
    throw new TypeError(`${name} exceeds maximum array length.`);
  }
  if (state.nodes + (length as number) > MAX_TRANSACTION_SNAPSHOT_NODES) {
    throw new TypeError('Durable transaction snapshot exceeds maximum node count.');
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key === 'symbol') throw new TypeError(`${name} array must not have symbol properties.`);
    if (key === 'length') continue;
    if (!isCanonicalArrayIndex(key)) throw new TypeError(`${name} array has a custom property.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${name}[${key}] must be an enumerable data property, not an accessor.`);
    }
  }
  const snapshot = new Array<DurableSnapshotValue>(length as number);
  for (let index = 0; index < snapshot.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) throw new TypeError(`${name} array must not be sparse.`);
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${name}[${index}] must be an enumerable data property, not an accessor.`);
    }
    Object.defineProperty(snapshot, index, {
      value: snapshotSafeDurableData(
        descriptor.value,
        `${name}[${index}]`,
        requireFrozen,
        state,
        depth + 1,
      ),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return Object.freeze(snapshot);
}

function snapshotSafeDurableRecord(
  value: object,
  name: string,
  requireFrozen: boolean,
  state: DurableSnapshotState,
  depth: number,
): DurableSnapshotObject {
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must use a plain or null prototype.`);
  }
  const keys = Reflect.ownKeys(value);
  if (state.nodes + keys.length > MAX_TRANSACTION_SNAPSHOT_NODES) {
    throw new TypeError('Durable transaction snapshot exceeds maximum node count.');
  }
  const snapshot = Object.create(prototype) as Record<string, DurableSnapshotValue>;
  for (const key of keys) {
    if (typeof key === 'symbol') throw new TypeError(`${name} must not have symbol properties.`);
    addSnapshotTextBytes(state, key, `${name} property key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${name}.${key} must be an enumerable data property, not an accessor.`);
    }
    Object.defineProperty(snapshot, key, {
      value: snapshotSafeDurableData(
        descriptor.value,
        `${name}.${key}`,
        requireFrozen,
        state,
        depth + 1,
      ),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

function addSnapshotTextBytes(state: DurableSnapshotState, value: string, name: string): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_TRANSACTION_SNAPSHOT_STRING_LENGTH) {
    throw new TypeError(`${name} exceeds maximum string length.`);
  }
  if (bytes > MAX_TRANSACTION_SNAPSHOT_TEXT_BYTES - state.textBytes) {
    throw new TypeError('Durable transaction snapshot exceeds maximum text bytes.');
  }
  state.textBytes += bytes;
}

function isCanonicalArrayIndex(key: string): boolean {
  if (!/^(?:0|[1-9]\d*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < 4_294_967_295;
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
