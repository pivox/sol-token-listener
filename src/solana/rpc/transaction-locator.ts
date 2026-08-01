import type { VersionedTransactionResponse } from '@solana/web3.js';
import type { TransactionIngestionErrorCode } from '../../domain/transaction-ingestion.js';
import { normalizeTransaction } from './transaction-fetcher.js';
import type {
  LegacyConfirmationStatus,
  NormalizedTransaction,
} from './types.js';

// Bounds hostile descriptor scans and the trusted copy while remaining far above practical blocks.
export const MAX_BLOCK_SIGNATURE_COUNT = 100_000;
// Solana signatures are base58 text; this byte cap admits canonical signatures with safety margin.
export const MAX_TRANSACTION_SIGNATURE_LENGTH = 128;

type LocatableConfirmationStatus = Exclude<LegacyConfirmationStatus, 'ORPHANED'>;

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

export abstract class TransactionLocatorError extends Error {
  protected constructor(
    public readonly code: TransactionIngestionErrorCode,
    public readonly retryable: boolean,
  ) {
    super('Solana transaction location failed.');
    this.name = 'TransactionLocatorError';
  }
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
    if (response === null) throw new TransactionUnavailableError();

    const rawSignatures = await this.fetchBlockSignatures(target);
    if (rawSignatures === null) throw new BlockUnavailableError();
    const signatures = snapshotBlockSignatures(rawSignatures, target.signature);
    const transactionIndex = uniqueSignatureIndex(signatures, target.signature);
    if (transactionIndex === null) throw new TransactionIndexNotFoundError();

    let normalized: NormalizedTransaction;
    try {
      normalized = normalizeTransaction(response, target.confirmationStatus, transactionIndex);
    } catch {
      throw new TransactionNormalizationError();
    }
    if (!hasStableRawSlot(response)) throw new TransactionNormalizationError();
    if (normalized.signature !== target.signature || normalized.slot !== target.slot) {
      throw new TransactionIndexNotFoundError();
    }
    return normalized;
  }

  private async fetchTransaction(
    target: TransactionLocationTarget,
  ): Promise<VersionedTransactionResponse | null> {
    try {
      return await this.rpc.getTransaction(target.signature, target.confirmationStatus);
    } catch {
      throw new RpcTransientError();
    }
  }

  private async fetchBlockSignatures(
    target: TransactionLocationTarget,
  ): Promise<readonly string[] | null> {
    try {
      return await this.rpc.getBlockSignatures(target.slot, target.confirmationStatus);
    } catch {
      throw new RpcTransientError();
    }
  }
}

export { SolanaTransactionLocator as TransactionLocator };

function hasStableRawSlot(response: VersionedTransactionResponse): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(response, 'slot');
    return descriptor !== undefined && 'value' in descriptor;
  } catch {
    return false;
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
    throw new BlockUnavailableError();
  }
  if (result.kind === 'target-duplicate') throw new TransactionIndexNotFoundError();
  if (result.kind === 'invalid') throw new BlockUnavailableError();
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
