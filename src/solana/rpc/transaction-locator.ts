import type { VersionedTransactionResponse } from '@solana/web3.js';
import type { TransactionIngestionErrorCode } from '../../domain/transaction-ingestion.js';
import { normalizeTransaction } from './transaction-fetcher.js';
import type {
  LegacyConfirmationStatus,
  NormalizedTransaction,
} from './types.js';

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
    if (safeResponseSlot(response) !== target.slot) throw new TransactionIndexNotFoundError();

    const signatures = await this.fetchBlockSignatures(target);
    if (signatures === null) throw new BlockUnavailableError();
    const transactionIndex = safeUniqueSignatureIndex(signatures, target.signature);
    if (transactionIndex === null) throw new TransactionIndexNotFoundError();

    try {
      return normalizeTransaction(response, target.confirmationStatus, transactionIndex);
    } catch {
      throw new TransactionNormalizationError();
    }
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

function safeResponseSlot(response: VersionedTransactionResponse): bigint {
  try {
    const slot = response.slot;
    if (!Number.isSafeInteger(slot) || slot < 0) {
      throw new TransactionNormalizationError();
    }
    return BigInt(slot);
  } catch (error) {
    if (error instanceof TransactionNormalizationError) throw error;
    throw new TransactionNormalizationError();
  }
}

function safeUniqueSignatureIndex(
  signatures: readonly string[],
  target: string,
): number | null {
  try {
    return uniqueSignatureIndex(signatures, target);
  } catch {
    throw new RpcTransientError();
  }
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
