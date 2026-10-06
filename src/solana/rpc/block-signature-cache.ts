import type { VersionedTransactionResponse } from '@solana/web3.js';
import type { TransactionLocatorRpc } from './transaction-locator.js';
import type { LegacyConfirmationStatus } from './types.js';

type LocatableConfirmationStatus = Exclude<LegacyConfirmationStatus, 'ORPHANED'>;

export interface BlockSignatureCacheOptions {
  readonly maxSlots: number;
}

export interface BlockSignatureCacheMetrics {
  readonly hits: number;
  readonly misses: number;
}

// Every transaction of a slot needs the same block signature list to derive its index;
// fetching it once per slot keeps getBlock off the per-transaction RPC budget.
export class CachedBlockSignatureRpc implements TransactionLocatorRpc {
  private readonly maxSlots: number;
  private readonly entries = new Map<string, Promise<readonly string[] | null>>();
  private hits = 0;
  private misses = 0;

  public constructor(
    private readonly rpc: TransactionLocatorRpc,
    options: BlockSignatureCacheOptions,
  ) {
    if (!Number.isSafeInteger(options.maxSlots) || options.maxSlots < 1) {
      throw new TypeError('Block signature cache capacity is invalid.');
    }
    this.maxSlots = options.maxSlots;
  }

  public getTransaction(
    signature: string,
    confirmationStatus: LocatableConfirmationStatus,
  ): Promise<VersionedTransactionResponse | null> {
    return this.rpc.getTransaction(signature, confirmationStatus);
  }

  public getBlockSignatures(
    slot: bigint,
    confirmationStatus: LocatableConfirmationStatus,
  ): Promise<readonly string[] | null> {
    const key = `${slot}:${confirmationStatus}`;
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.hits += 1;
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }

    this.misses += 1;
    const pending = this.rpc.getBlockSignatures(slot, confirmationStatus);
    this.entries.set(key, pending);
    this.evictOverflow();
    pending.then(
      (signatures) => { if (signatures === null) this.forget(key, pending); },
      () => { this.forget(key, pending); },
    );
    return pending;
  }

  public metrics(): BlockSignatureCacheMetrics {
    return Object.freeze({ hits: this.hits, misses: this.misses });
  }

  private forget(key: string, pending: Promise<readonly string[] | null>): void {
    if (this.entries.get(key) === pending) this.entries.delete(key);
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxSlots) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}
