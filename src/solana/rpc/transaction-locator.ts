import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import { isProxy, isUint8Array } from 'node:util/types';
import { serialize } from 'node:v8';
import type {
  IngestionFailure,
  TransactionIngestionErrorCode,
} from '../../domain/transaction-ingestion.js';
import { normalizeTransaction } from './transaction-fetcher.js';
import type {
  LegacyConfirmationStatus,
  NormalizedTransaction,
} from './types.js';

// Bounds hostile descriptor scans and the trusted copy while remaining far above practical blocks.
export const MAX_BLOCK_SIGNATURE_COUNT = 100_000;
export const MAX_TRANSACTION_SIGNATURES = 32;
export const MAX_LEGACY_INSTRUCTION_DATA_BYTES = 1_700;
export const MAX_DECODED_INSTRUCTION_DATA_BYTES = 1_232;
// Solana signatures are base58 text; this byte cap admits canonical signatures with safety margin.
export const MAX_TRANSACTION_SIGNATURE_LENGTH = 128;

type LocatableConfirmationStatus = Exclude<LegacyConfirmationStatus, 'ORPHANED'>;
const trustedTransactionLocatorErrors = new WeakMap<object, IngestionFailure>();

export interface TransactionLocationTarget {
  readonly signature: string;
  readonly slot: bigint;
  readonly confirmationStatus: LocatableConfirmationStatus;
}

export interface TransactionLocatorRpc {
  getTransaction(
    signature: string,
    confirmationStatus: LocatableConfirmationStatus,
  ): Promise<VersionedTransactionResponse | null>;
  getBlockSignatures(
    slot: bigint,
    confirmationStatus: LocatableConfirmationStatus,
  ): Promise<readonly string[] | null>;
}

/** Read-only complete block source used by the experimental, non-production locator. */
export interface TransactionBlockRpc {
  getBlockTransactions(
    slot: bigint,
    confirmationStatus: LocatableConfirmationStatus,
  ): Promise<unknown>;
}

export abstract class TransactionLocatorError extends Error {
  protected constructor(
    public readonly code: TransactionIngestionErrorCode,
    public readonly retryable: boolean,
  ) {
    super('Solana transaction location failed.');
    this.name = 'TransactionLocatorError';
  }
}

export function trustedTransactionLocatorFailure(
  value: unknown,
): IngestionFailure | null {
  if (typeof value !== 'object' || value === null) return null;
  const failure = trustedTransactionLocatorErrors.get(value) ?? null;
  if (failure !== null) trustedTransactionLocatorErrors.delete(value);
  return failure;
}

export class RpcTransientError extends TransactionLocatorError {
  public constructor() {
    super('RPC_TRANSIENT', true);
    this.name = 'RpcTransientError';
  }
}

export class TransactionUnavailableError extends TransactionLocatorError {
  public constructor() {
    super('TRANSACTION_NOT_AVAILABLE', true);
    this.name = 'TransactionUnavailableError';
  }
}

export class BlockUnavailableError extends TransactionLocatorError {
  public constructor() {
    super('BLOCK_NOT_AVAILABLE', true);
    this.name = 'BlockUnavailableError';
  }
}

export class TransactionIndexNotFoundError extends TransactionLocatorError {
  public constructor() {
    super('TRANSACTION_INDEX_NOT_FOUND', false);
    this.name = 'TransactionIndexNotFoundError';
  }
}

export class TransactionNormalizationError extends TransactionLocatorError {
  public constructor() {
    super('NORMALIZATION_FAILED', false);
    this.name = 'TransactionNormalizationError';
  }
}

export class SolanaTransactionLocator {
  public constructor(private readonly rpc: TransactionLocatorRpc) {}

  public async locate(target: TransactionLocationTarget): Promise<NormalizedTransaction> {
    const response = await this.fetchTransaction(target);
    if (response === null) throw internalLocatorError(new TransactionUnavailableError());

    const rawSignatures = await this.fetchBlockSignatures(target);
    if (rawSignatures === null) throw internalLocatorError(new BlockUnavailableError());
    const signatures = snapshotBlockSignatures(rawSignatures, target.signature);
    const transactionIndex = uniqueSignatureIndex(signatures, target.signature);
    if (transactionIndex === null) throw internalLocatorError(new TransactionIndexNotFoundError());
    const rawSlot = readCanonicalRawSlot(response);
    if (rawSlot === null) throw internalLocatorError(new TransactionNormalizationError());

    let normalized: NormalizedTransaction;
    try {
      normalized = normalizeTransaction(response, target.confirmationStatus, transactionIndex);
    } catch {
      throw internalLocatorError(new TransactionNormalizationError());
    }
    if (normalized.slot !== BigInt(rawSlot)) {
      throw internalLocatorError(new TransactionNormalizationError());
    }
    if (normalized.signature !== target.signature || normalized.slot !== target.slot) {
      throw internalLocatorError(new TransactionIndexNotFoundError());
    }
    return normalized;
  }

  private async fetchTransaction(
    target: TransactionLocationTarget,
  ): Promise<VersionedTransactionResponse | null> {
    try {
      return await this.rpc.getTransaction(target.signature, target.confirmationStatus);
    } catch {
      throw internalLocatorError(new RpcTransientError());
    }
  }

  private async fetchBlockSignatures(
    target: TransactionLocationTarget,
  ): Promise<readonly string[] | null> {
    try {
      return await this.rpc.getBlockSignatures(target.slot, target.confirmationStatus);
    } catch {
      throw internalLocatorError(new RpcTransientError());
    }
  }
}

/**
 * Locates one transaction from the complete block response. It is deliberately
 * not wired into the production listener until its bounded cache/admission
 * policy has been separately validated against the configured RPC provider.
 */
export class SolanaBlockTransactionLocator {
  public constructor(private readonly rpc: TransactionBlockRpc) {}

  public async locate(target: TransactionLocationTarget): Promise<NormalizedTransaction> {
    if (!validTargetSlot(target.slot)) throw internalLocatorError(new BlockUnavailableError());
    let block: unknown;
    try {
      block = await this.rpc.getBlockTransactions(target.slot, target.confirmationStatus);
    } catch {
      throw internalLocatorError(new RpcTransientError());
    }
    if (block === null) throw internalLocatorError(new BlockUnavailableError());

    const selected = snapshotBlockTransaction(block, target);
    if (selected === null) throw internalLocatorError(new TransactionIndexNotFoundError());
    if (selected === 'invalid') throw internalLocatorError(new BlockUnavailableError());
    if (selected === 'normalization-invalid') {
      throw internalLocatorError(new TransactionNormalizationError());
    }

    let normalized: NormalizedTransaction;
    try {
      normalized = normalizeTransaction(selected.response, target.confirmationStatus, selected.index);
    } catch {
      throw internalLocatorError(new TransactionNormalizationError());
    }
    if (normalized.signature !== target.signature || normalized.slot !== target.slot) {
      throw internalLocatorError(new TransactionIndexNotFoundError());
    }
    return normalized;
  }
}

export { SolanaTransactionLocator as TransactionLocator };

function fixedLocatorFailure(code: TransactionIngestionErrorCode): IngestionFailure {
  switch (code) {
    case 'RPC_TRANSIENT':
      return Object.freeze({ code, errorName: 'RpcTransientError', retryable: true });
    case 'TRANSACTION_NOT_AVAILABLE':
      return Object.freeze({ code, errorName: 'TransactionUnavailableError', retryable: true });
    case 'BLOCK_NOT_AVAILABLE':
      return Object.freeze({ code, errorName: 'BlockUnavailableError', retryable: true });
    case 'TRANSACTION_INDEX_NOT_FOUND':
      return Object.freeze({ code, errorName: 'TransactionIndexNotFoundError', retryable: false });
    case 'NORMALIZATION_FAILED':
      return Object.freeze({ code, errorName: 'TransactionNormalizationError', retryable: false });
    default:
      return Object.freeze({
        code: 'RPC_TRANSIENT', errorName: 'TransactionLocatorError', retryable: true,
      });
  }
}

export function internalLocatorError<TError extends TransactionLocatorError>(error: TError): TError {
  trustedTransactionLocatorErrors.set(error, fixedLocatorFailure(error.code));
  return error;
}

function readCanonicalRawSlot(response: VersionedTransactionResponse): number | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(response, 'slot');
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      return null;
    }
    const slot: unknown = descriptor.value;
    return typeof slot === 'number'
      && Number.isSafeInteger(slot)
      && slot >= 0
      && !Object.is(slot, -0)
      ? slot
      : null;
  } catch {
    return null;
  }
}

type SignatureSnapshotResult =
  | { readonly kind: 'valid'; readonly signatures: readonly string[] }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'target-duplicate' };

function snapshotBlockSignatures(
  value: readonly string[],
  target: string,
): readonly string[] {
  let result: SignatureSnapshotResult;
  try {
    result = inspectBlockSignatures(value, target);
  } catch {
    throw internalLocatorError(new BlockUnavailableError());
  }
  if (result.kind === 'target-duplicate') {
    throw internalLocatorError(new TransactionIndexNotFoundError());
  }
  if (result.kind === 'invalid') throw internalLocatorError(new BlockUnavailableError());
  return result.signatures;
}

function inspectBlockSignatures(
  value: readonly string[],
  target: string,
): SignatureSnapshotResult {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return { kind: 'invalid' };
  }
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
    return { kind: 'invalid' };
  }
  const length: unknown = lengthDescriptor.value;
  if (typeof length !== 'number'
    || !Number.isSafeInteger(length)
    || length < 0
    || length > MAX_BLOCK_SIGNATURE_COUNT
    || value.length !== length
    || keys.length !== length + 1
    || keys[length] !== 'length') {
    return { kind: 'invalid' };
  }

  const copy: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (keys[index] !== key) return { kind: 'invalid' };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return { kind: 'invalid' };
    const signature: unknown = descriptor.value;
    if (typeof signature !== 'string'
      || signature.length === 0
      || Buffer.byteLength(signature, 'utf8') > MAX_TRANSACTION_SIGNATURE_LENGTH) {
      return { kind: 'invalid' };
    }
    if (seen.has(signature)) {
      return { kind: signature === target ? 'target-duplicate' : 'invalid' };
    }
    seen.add(signature);
    copy.push(signature);
  }
  return { kind: 'valid', signatures: Object.freeze(copy) };
}

function uniqueSignatureIndex(
  signatures: readonly string[],
  target: string,
): number | null {
  let found: number | null = null;
  for (let index = 0; index < signatures.length; index += 1) {
    if (signatures[index] !== target) continue;
    if (found !== null) return null;
    found = index;
  }
  return found;
}

type BlockTransactionSnapshot = Readonly<{
  index: number;
  response: VersionedTransactionResponse;
}>;

/** Immutable, data-only normalized payloads. No provider graph survives this boundary. */
export interface BlockTransactionDataSnapshot {
  readonly transactions: readonly Readonly<{ signature: string; payload: string | null }>[];
  readonly duplicateSignature: string | null;
  readonly cacheable: boolean;
  readonly bytes: number;
}

/** Single linear block scan; malformed unrelated normalization only disables retention. */
export function snapshotBlockTransactionData(
  value: unknown,
  slot: bigint,
  confirmationStatus: LocatableConfirmationStatus,
): BlockTransactionDataSnapshot | null {
  try {
    if (!validTargetSlot(slot)) return null;
    const record = ownRecord(value);
    const blockTime = ownData(record, 'blockTime');
    if (!validBlockhash(ownData(record, 'blockhash'))
      || !validBlockhash(ownData(record, 'previousBlockhash'))
      || !validParentSlot(ownData(record, 'parentSlot'), slot)
      || !validBlockTime(blockTime)) return null;
    const entries = denseBlockTransactions(ownData(record, 'transactions'));
    if (entries === null) return null;
    const transactions: { readonly signature: string; readonly payload: string | null }[] = [];
    const seen = new Set<string>();
    let cacheable = true;
    let bytes = 64;
    for (const [index, entry] of entries.entries()) {
      const entryRecord = ownRecord(entry);
      const transaction = ownData(entryRecord, 'transaction');
      const signature = primaryTransactionSignature(transaction);
      if (signature === null) return null;
      if (seen.has(signature)) {
        return Object.freeze({ transactions: Object.freeze([]), duplicateSignature: signature, cacheable: false, bytes: 0 });
      }
      seen.add(signature);
      let payload: string | null = null;
      try {
        const version = ownOptionalData(entryRecord, 'version');
        const meta = ownData(entryRecord, 'meta');
        if (!validBlockTransactionVersion(version) || !validBlockTransactionMeta(meta)) throw new TypeError();
        const snapshot = snapshotSelectedTransaction(transaction, meta, version ?? 'legacy');
        if (snapshot === null) throw new TypeError();
        const normalized = normalizeTransaction({
          slot: Number(slot), blockTime, transaction: snapshot.transaction, meta: snapshot.meta,
          ...(version === undefined ? {} : { version }),
        }, confirmationStatus, index);
        if (normalized.signature !== signature || normalized.slot !== slot) throw new TypeError();
        // V8 preserves bigint and typed arrays, but the retained representation is just text.
        payload = serialize(normalized).toString('base64');
      } catch {
        cacheable = false;
      }
      transactions.push(Object.freeze({ signature, payload }));
      bytes += Buffer.byteLength(signature, 'utf8') + (payload?.length ?? 0) + 32;
    }
    return Object.freeze({ transactions: Object.freeze(transactions), duplicateSignature: null, cacheable, bytes });
  } catch {
    return null;
  }
}

function validTargetSlot(value: unknown): value is bigint {
  return typeof value === 'bigint'
    && value >= 0n
    && value <= BigInt(Number.MAX_SAFE_INTEGER);
}

function snapshotBlockTransaction(
  value: unknown,
  target: TransactionLocationTarget,
): BlockTransactionSnapshot | null | 'invalid' | 'normalization-invalid' {
  try {
    const record = ownRecord(value);
    const blockhash = ownData(record, 'blockhash');
    const previousBlockhash = ownData(record, 'previousBlockhash');
    const parentSlot = ownData(record, 'parentSlot');
    const blockTime = ownData(record, 'blockTime');
    const transactions = ownData(record, 'transactions');
    if (!validBlockhash(blockhash) || !validBlockhash(previousBlockhash)
      || !validParentSlot(parentSlot, target.slot) || !validBlockTime(blockTime)) return 'invalid';
    const entries = denseBlockTransactions(transactions);
    if (entries === null) return 'invalid';
    let match: BlockTransactionSnapshot | null = null;
    const seen = new Set<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined) return 'invalid';
      const entryRecord = ownRecord(entry);
      const transaction = ownData(entryRecord, 'transaction');
      const signature = primaryTransactionSignature(transaction);
      if (signature === null) return 'invalid';
      if (seen.has(signature)) return signature === target.signature ? null : 'invalid';
      seen.add(signature);
      if (signature !== target.signature) continue;
      if (match !== null) return null;
      let meta: unknown;
      let version: unknown;
      try {
        meta = ownData(entryRecord, 'meta');
        version = ownOptionalData(entryRecord, 'version');
      } catch {
        return 'normalization-invalid';
      }
      if (!validBlockTransactionMeta(meta) || !validBlockTransactionVersion(version)) {
        return 'normalization-invalid';
      }
      const snapshot = snapshotSelectedTransaction(transaction, meta, version ?? 'legacy');
      if (snapshot === null) return 'normalization-invalid';
      match = Object.freeze({
        index,
        response: Object.freeze({
          slot: Number(target.slot),
          blockTime,
          transaction: snapshot.transaction,
          meta: snapshot.meta,
          ...(version === undefined ? {} : { version }),
        }),
      });
    }
    return match;
  } catch {
    return 'invalid';
  }
}

type SelectedTransactionSnapshot = Readonly<{
  transaction: VersionedTransactionResponse['transaction'];
  meta: VersionedTransactionResponse['meta'];
}>;

type SnapshotAccountKey = Readonly<{
  toBase58(): string;
}>;

type SnapshotLoadedAddresses = Readonly<{
  writable: readonly SnapshotAccountKey[];
  readonly: readonly SnapshotAccountKey[];
}>;

type MetaSnapshot = Readonly<{
  response: VersionedTransactionResponse['meta'];
  loadedAddresses: SnapshotLoadedAddresses | undefined;
}>;

function snapshotSelectedTransaction(
  transaction: unknown,
  meta: unknown,
  expectedVersion: 'legacy' | 0,
): SelectedTransactionSnapshot | null {
  try {
    if (!validBlockTransactionMeta(meta)) return null;
    const record = ownRecord(transaction);
    const signatures = snapshotSignatureArray(ownData(record, 'signatures'));
    const metaSnapshot = snapshotMeta(meta);
    const message = snapshotMessage(
      ownData(record, 'message'),
      metaSnapshot.loadedAddresses,
      expectedVersion,
    );
    if (signatures === null || message === null) return null;
    return Object.freeze({
      transaction: Object.freeze({ signatures, message }) as VersionedTransactionResponse['transaction'],
      meta: metaSnapshot.response,
    });
  } catch {
    return null;
  }
}

function snapshotMessage(
  value: unknown,
  loadedAddresses: SnapshotLoadedAddresses | undefined,
  expectedVersion: 'legacy' | 0,
): VersionedTransactionResponse['transaction']['message'] | null {
  try {
    const record = ownRecord(value);
    const header = snapshotHeader(ownData(record, 'header'));
    const compiledInstructions = snapshotCompiledInstructions(record);
    const accountKeys = snapshotMessageAccountKeys(record);
    if (header === null || compiledInstructions === null
      || accountKeys?.messageVersion !== expectedVersion) return null;
    return Object.freeze({
      header,
      compiledInstructions,
      getAccountKeys: (args?: unknown) => snapshotMessageAccountKeysForNormalization(
        accountKeys,
        loadedAddresses,
        args,
      ),
    }) as unknown as VersionedTransactionResponse['transaction']['message'];
  } catch {
    return null;
  }
}

function snapshotHeader(value: unknown): object | null {
  try {
    const record = ownRecord(value);
    const result: Record<string, unknown> = {};
    for (const key of ['numRequiredSignatures', 'numReadonlySignedAccounts', 'numReadonlyUnsignedAccounts']) {
      const field = ownData(record, key);
      if (!validNumericSlot(field)) return null;
      result[key] = field;
    }
    return Object.freeze(result);
  } catch {
    return null;
  }
}

function snapshotCompiledInstructions(message: object): readonly unknown[] | null {
  const compiled = ownOptionalData(message, 'compiledInstructions');
  if (compiled !== undefined) return snapshotPlainData(compiled) as readonly unknown[] | null;
  const legacy = ownData(message, 'instructions');
  const entries = denseBlockTransactions(legacy);
  if (entries === null) return null;
  const compiledEntries: unknown[] = [];
  for (const entry of entries) {
    const record = ownRecord(entry);
    const programIdIndex = ownData(record, 'programIdIndex');
    const accounts = snapshotPlainData(ownData(record, 'accounts'));
    const data = ownData(record, 'data');
    if (!validNumericSlot(programIdIndex) || !Array.isArray(accounts) || typeof data !== 'string'
      || Buffer.byteLength(data, 'utf8') > MAX_LEGACY_INSTRUCTION_DATA_BYTES) return null;
    const decoded = bs58.decode(data);
    if (decoded.length > MAX_DECODED_INSTRUCTION_DATA_BYTES) return null;
    compiledEntries.push(Object.freeze({
      programIdIndex,
      accountKeyIndexes: accounts,
      data: Uint8Array.from(decoded),
    }));
  }
  return Object.freeze(compiledEntries);
}

type SnapshotMessageAccountKeys = Readonly<{
  staticAccountKeys: readonly SnapshotAccountKey[];
  lookupAccountKeyCount: number;
  messageVersion: 'legacy' | 0;
}>;

function snapshotMessageAccountKeys(value: object): SnapshotMessageAccountKeys | null {
  try {
    const staticAccountKeys = ownOptionalData(value, 'staticAccountKeys');
    if (staticAccountKeys === undefined) {
      return Object.freeze({
        staticAccountKeys: snapshotPublicKeys(ownData(value, 'accountKeys')),
        lookupAccountKeyCount: 0,
        messageVersion: 'legacy',
      });
    }
    return Object.freeze({
      staticAccountKeys: snapshotPublicKeys(staticAccountKeys),
      lookupAccountKeyCount: snapshotLookupAccountKeyCount(ownData(value, 'addressTableLookups')),
      messageVersion: 0,
    });
  } catch {
    return null;
  }
}

function snapshotMessageAccountKeysForNormalization(
  snapshot: SnapshotMessageAccountKeys,
  loadedAddresses: SnapshotLoadedAddresses | undefined,
  args: unknown,
): { readonly length: number; get(index: number): SnapshotAccountKey | undefined } {
  let keys = snapshot.staticAccountKeys;
  if (snapshot.lookupAccountKeyCount > 0) {
    if (!hasSnapshotLookupArguments(args) || loadedAddresses === undefined) throw new TypeError();
    const loaded = [...loadedAddresses.writable, ...loadedAddresses.readonly];
    if (loaded.length !== snapshot.lookupAccountKeyCount) throw new TypeError();
    keys = Object.freeze([...keys, ...loaded]);
  }
  return Object.freeze({
    length: keys.length,
    get(index: number): SnapshotAccountKey | undefined {
      return Number.isSafeInteger(index) && index >= 0 ? keys[index] : undefined;
    },
  });
}

function hasSnapshotLookupArguments(value: unknown): boolean {
  try {
    const record = ownRecord(value);
    const accountKeysFromLookups = ownData(record, 'accountKeysFromLookups');
    return accountKeysFromLookups !== undefined && !isProxy(accountKeysFromLookups);
  } catch {
    return false;
  }
}

function snapshotLookupAccountKeyCount(value: unknown): number {
  const entries = denseBlockTransactions(value);
  if (entries === null) throw new TypeError();
  let count = 0;
  for (const entry of entries) {
    const record = ownRecord(entry);
    const writable = denseBlockTransactions(ownData(record, 'writableIndexes'));
    const readonly = denseBlockTransactions(ownData(record, 'readonlyIndexes'));
    if (writable === null || readonly === null
      || !writable.every(validNumericSlot) || !readonly.every(validNumericSlot)) throw new TypeError();
    count += writable.length + readonly.length;
    if (!Number.isSafeInteger(count) || count > MAX_BLOCK_SIGNATURE_COUNT) throw new TypeError();
  }
  return count;
}

function snapshotMeta(value: object | null): MetaSnapshot {
  if (value === null) return Object.freeze({ response: null, loadedAddresses: undefined });
  const record = ownRecord(value);
  const result: Record<string, unknown> = {};
  for (const key of ['innerInstructions', 'preTokenBalances', 'postTokenBalances', 'preBalances', 'postBalances', 'fee', 'computeUnitsConsumed', 'logMessages', 'err']) {
    const field = ownOptionalData(record, key);
    if (field !== undefined) result[key] = snapshotPlainData(field);
  }
  const loadedAddresses = ownOptionalData(record, 'loadedAddresses');
  const snapshot = loadedAddresses === undefined ? undefined : snapshotLoadedAddresses(loadedAddresses);
  if (snapshot !== undefined) result.loadedAddresses = snapshot;
  return Object.freeze({
    response: Object.freeze(result) as unknown as VersionedTransactionResponse['meta'],
    loadedAddresses: snapshot,
  });
}

function snapshotLoadedAddresses(value: unknown): SnapshotLoadedAddresses {
  const record = ownRecord(value);
  return Object.freeze({
    writable: snapshotPublicKeys(ownData(record, 'writable')),
    readonly: snapshotPublicKeys(ownData(record, 'readonly')),
  });
}

function snapshotPublicKeys(value: unknown): readonly SnapshotAccountKey[] {
  const entries = denseBlockTransactions(value);
  if (entries === null) throw new TypeError();
  const keys: SnapshotAccountKey[] = [];
  for (const entry of entries) {
    keys.push(snapshotPublicKey(entry));
  }
  return Object.freeze(keys);
}

function snapshotPublicKey(value: unknown): SnapshotAccountKey {
  const record = ownRecord(value);
  if (Object.getPrototypeOf(record) !== PublicKey.prototype) throw new TypeError();
  const bn = ownRecord(ownData(record, '_bn'));
  const words = denseBlockTransactions(ownData(bn, 'words'));
  const length = ownData(bn, 'length');
  if (words === null || !validPublicKeyBnLength(length, words.length)
    || ownData(bn, 'negative') !== 0 || ownData(bn, 'red') !== null) throw new TypeError();

  let numeric = 0n;
  for (let index = length - 1; index >= 0; index -= 1) {
    const word = words[index];
    if (typeof word !== 'number' || !Number.isSafeInteger(word) || word < 0 || word > 0x3ffffff) {
      throw new TypeError();
    }
    numeric = (numeric << 26n) | BigInt(word);
  }
  if (numeric >= (1n << 256n)) throw new TypeError();
  const bytes = new Uint8Array(32);
  for (let index = 31; index >= 0; index -= 1) {
    bytes[index] = Number(numeric & 0xffn);
    numeric >>= 8n;
  }
  const text = bs58.encode(bytes);
  return Object.freeze({ toBase58: () => text });
}

function validPublicKeyBnLength(value: unknown, wordCount: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value > 0 && value <= 10 && wordCount >= value && wordCount <= 11;
}

function snapshotSignatureArray(value: unknown): readonly string[] | null {
  const entries = denseBlockTransactions(value);
  if (entries === null || entries.length === 0 || entries.length > MAX_TRANSACTION_SIGNATURES) return null;
  const signatures: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0 || Buffer.byteLength(entry, 'utf8') > MAX_TRANSACTION_SIGNATURE_LENGTH) return null;
    signatures.push(entry);
  }
  return Object.freeze(signatures);
}

function snapshotPlainData(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'object' || isProxy(value)) throw new TypeError();
  const bytes = snapshotUint8Array(value);
  if (bytes !== null) return bytes;
  if (depth >= 32) throw new TypeError();
  if (Array.isArray(value)) {
    const entries = denseBlockTransactions(value);
    if (entries === null) throw new TypeError();
    return Object.freeze(entries.map((entry) => snapshotPlainData(entry, depth + 1)));
  }
  const record = ownRecord(value);
  const prototype = Reflect.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      value: snapshotPlainData(ownData(record, key), depth + 1),
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

function snapshotUint8Array(value: object): Uint8Array | null {
  if (!isUint8Array(value)) return null;
  if (intrinsicTypedArrayByteLength(value) > MAX_DECODED_INSTRUCTION_DATA_BYTES) {
    throw new TypeError();
  }
  return new Uint8Array(value);
}

function intrinsicTypedArrayByteLength(value: Uint8Array): number {
  const prototype: object | null = Reflect.getPrototypeOf(Uint8Array.prototype);
  if (prototype === null) throw new TypeError();
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'byteLength');
  if (descriptor?.get === undefined) throw new TypeError();
  const readByteLength = descriptor.get.bind(value);
  const result: unknown = readByteLength();
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) {
    throw new TypeError();
  }
  return result;
}

function validBlockTransactionMeta(value: unknown): value is object | null {
  return value === null || (typeof value === 'object' && !isProxy(value) && !Array.isArray(value));
}

function validBlockTransactionVersion(value: unknown): value is undefined | 'legacy' | 0 {
  return value === undefined || value === 'legacy' || value === 0;
}

function ownRecord(value: unknown): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw new TypeError();
  }
  return value;
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
  return descriptor.value;
}

function ownOptionalData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
  return descriptor.value;
}

function validBlockhash(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0
    || Buffer.byteLength(value, 'utf8') > MAX_TRANSACTION_SIGNATURE_LENGTH) return false;
  try {
    const decoded = bs58.decode(value);
    return decoded.length === 32 && bs58.encode(decoded) === value;
  } catch {
    return false;
  }
}

function validNumericSlot(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0);
}

function validParentSlot(value: unknown, targetSlot: bigint): value is number {
  if (!validNumericSlot(value)) return false;
  return targetSlot === 0n ? value === 0 : value < Number(targetSlot);
}

function validBlockTime(value: unknown): value is number | null {
  return value === null || (typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= Math.floor(Number.MAX_SAFE_INTEGER / 1_000));
}

function denseBlockTransactions(value: unknown): readonly unknown[] | null {
  if (typeof value !== 'object' || value === null || isProxy(value)
    || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const keys = Reflect.ownKeys(value);
  const length = ownLength(value);
  if (typeof length !== 'number' || !Number.isSafeInteger(length)
    || length < 0 || length > MAX_BLOCK_SIGNATURE_COUNT
    || keys.length !== length + 1 || keys[length] !== 'length') return null;
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (keys[index] !== key) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return null;
    entries.push(descriptor.value);
  }
  return Object.freeze(entries);
}

function ownLength(value: object): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (descriptor === undefined || !('value' in descriptor)) throw new TypeError();
  return descriptor.value;
}

function primaryTransactionSignature(value: unknown): string | null {
  const signatures = ownData(ownRecord(value), 'signatures');
  const entries = denseBlockTransactions(signatures);
  if (entries === null || entries.length === 0 || entries.length > MAX_TRANSACTION_SIGNATURES) return null;
  for (const signature of entries) {
    if (typeof signature !== 'string' || signature.length === 0
      || Buffer.byteLength(signature, 'utf8') > MAX_TRANSACTION_SIGNATURE_LENGTH) return null;
  }
  const primary = entries[0];
  return typeof primary === 'string' ? primary : null;
}
