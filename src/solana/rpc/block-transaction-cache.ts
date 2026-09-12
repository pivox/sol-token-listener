import { setTimeout as delay } from 'node:timers/promises';
import { deserialize } from 'node:v8';
import {
  BlockUnavailableError, RpcTransientError, TransactionIndexNotFoundError,
  TransactionNormalizationError, internalLocatorError, snapshotBlockTransactionData,
  type BlockTransactionDataSnapshot, type TransactionBlockRpc, type TransactionLocationTarget,
} from './transaction-locator.js';
import type { NormalizedTransaction } from './types.js';

export interface EpochTransactionBlockRpc extends TransactionBlockRpc {
  readonly httpTransportEpoch: number;
}

export interface BlockTransactionCacheOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxEntryBytes?: number;
  readonly confirmedTtlMs?: number;
  readonly finalizedTtlMs?: number;
  readonly fetchIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const BLOCK_TRANSACTION_CACHE_DEFAULTS = Object.freeze({
  maxEntries: 64, maxBytes: 64 * 1024 * 1024, maxEntryBytes: 8 * 1024 * 1024,
  confirmedTtlMs: 10000, finalizedTtlMs: 60000, fetchIntervalMs: 250,
});

interface CacheEntry {
  readonly snapshot: BlockTransactionDataSnapshot;
  readonly fetchedAt: number;
  readonly generation: number;
  readonly epoch: number;
  readonly ttlMs: number;
}

interface Admission {
  readonly start: () => void;
  readonly reject: (error: Error) => void;
}

/** Explicit experimental opt-in only; the production factory does not construct this class. */
export class CachedSolanaBlockTransactionLocator {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CacheEntry>>();
  private readonly queue: Admission[] = [];
  private readonly abort = new AbortController();
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly confirmedTtlMs: number;
  private readonly finalizedTtlMs: number;
  private readonly fetchIntervalMs: number;
  private bytes = 0;
  private epoch: number;
  private generation = 0;
  private nextStart = -Infinity;
  private pumping = false;
  private closed = false;

  public constructor(private readonly rpc: EpochTransactionBlockRpc, options: BlockTransactionCacheOptions = {}) {
    this.now = options.now ?? ((): number => performance.now());
    this.sleep = options.sleep ?? (async (ms, signal): Promise<void> => { await delay(ms, undefined, { signal }); });
    this.maxEntries = options.maxEntries ?? BLOCK_TRANSACTION_CACHE_DEFAULTS.maxEntries;
    this.maxBytes = options.maxBytes ?? BLOCK_TRANSACTION_CACHE_DEFAULTS.maxBytes;
    this.maxEntryBytes = options.maxEntryBytes ?? BLOCK_TRANSACTION_CACHE_DEFAULTS.maxEntryBytes;
    this.confirmedTtlMs = options.confirmedTtlMs ?? BLOCK_TRANSACTION_CACHE_DEFAULTS.confirmedTtlMs;
    this.finalizedTtlMs = options.finalizedTtlMs ?? BLOCK_TRANSACTION_CACHE_DEFAULTS.finalizedTtlMs;
    this.fetchIntervalMs = options.fetchIntervalMs ?? BLOCK_TRANSACTION_CACHE_DEFAULTS.fetchIntervalMs;
    for (const value of [this.maxEntries, this.maxBytes, this.maxEntryBytes, this.confirmedTtlMs, this.finalizedTtlMs, this.fetchIntervalMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Invalid block cache limit.');
    }
    this.epoch = rpc.httpTransportEpoch;
  }

  public get stats(): Readonly<{ entries: number; bytes: number; inFlight: number; queued: number }> {
    this.synchronizeEpoch();
    this.pruneExpired();
    return Object.freeze({ entries: this.entries.size, bytes: this.bytes, inFlight: this.inFlight.size, queued: this.queue.length });
  }

  public async locate(target: TransactionLocationTarget): Promise<NormalizedTransaction> {
    if (this.closed) throw internalLocatorError(new RpcTransientError());
    if (typeof target.slot !== 'bigint' || target.slot < 0n || target.slot > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw internalLocatorError(new BlockUnavailableError());
    }
    this.synchronizeEpoch();
    this.pruneExpired();
    const status = target.confirmationStatus === 'FINALIZED' ? 'FINALIZED' : 'CONFIRMED';
    const key = `${this.epoch}:${target.slot}:${status}`;
    let entry = this.entries.get(key);
    if (entry !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      if (!entry.snapshot.transactions.some(({ signature }) => signature === target.signature)) {
        // A cached miss receives exactly one fresh fetch, shared with other callers.
        this.remove(key);
        entry = undefined;
      }
    }
    if (entry === undefined) {
      try {
        entry = await this.fetch(key, { ...target, confirmationStatus: status });
      } catch (error) {
        // Shared flights must not share the single-use trusted failure identity.
        throw internalLocatorError(error instanceof BlockUnavailableError
          ? new BlockUnavailableError() : new RpcTransientError());
      }
    }
    const duplicate = entry.snapshot.duplicateSignature;
    if (duplicate !== null) {
      throw internalLocatorError(duplicate === target.signature
        ? new TransactionIndexNotFoundError() : new BlockUnavailableError());
    }
    const selected = entry.snapshot.transactions.find(({ signature }) => signature === target.signature);
    if (selected === undefined) throw internalLocatorError(new TransactionIndexNotFoundError());
    if (selected.payload === null) throw internalLocatorError(new TransactionNormalizationError());
    let normalized: NormalizedTransaction;
    try {
      normalized = deserialize(Buffer.from(selected.payload, 'base64')) as NormalizedTransaction;
    } catch {
      this.remove(key);
      throw internalLocatorError(new TransactionNormalizationError());
    }
    normalized.confirmationStatus = target.confirmationStatus;
    this.retain(key, entry);
    return normalized;
  }

  /** Forget values and detach old flights without cancelling their current callers. */
  public clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.inFlight.clear();
    this.bytes = 0;
    this.rejectQueuedAdmissions();
  }

  /** Cancel admission timers/queued work; already-started SDK requests may settle for their callers. */
  public close(): void {
    this.closed = true;
    this.clear();
    this.abort.abort();
  }

  private synchronizeEpoch(): void {
    if (this.epoch === this.rpc.httpTransportEpoch) return;
    this.epoch = this.rpc.httpTransportEpoch;
    this.clear();
  }

  private fetch(key: string, target: TransactionLocationTarget): Promise<CacheEntry> {
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;
    const epoch = this.epoch;
    const generation = this.generation;
    const ttlMs = target.confirmationStatus === 'FINALIZED' ? this.finalizedTtlMs : this.confirmedTtlMs;
    const promise = new Promise<CacheEntry>((resolve, reject) => {
      this.queue.push({
        reject,
        start: () => {
          if (epoch !== this.rpc.httpTransportEpoch || generation !== this.generation) {
            reject(internalLocatorError(new RpcTransientError()));
            return;
          }
          void this.fetchSnapshot(target).then(
            (snapshot) => { resolve({ snapshot, fetchedAt: this.now(), epoch, generation, ttlMs }); }, reject,
          );
        },
      });
    }).finally(() => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    void this.pump();
    return promise;
  }

  private async fetchSnapshot(target: TransactionLocationTarget): Promise<BlockTransactionDataSnapshot> {
    let raw: unknown;
    try {
      raw = await this.rpc.getBlockTransactions(target.slot, target.confirmationStatus);
    } catch {
      throw internalLocatorError(new RpcTransientError());
    }
    const snapshot = snapshotBlockTransactionData(raw, target.slot, target.confirmationStatus);
    if (snapshot === null) throw internalLocatorError(new BlockUnavailableError());
    return snapshot;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        this.synchronizeEpoch();
        if (this.queue.length === 0) break;
        const wait = this.nextStart - this.now();
        if (wait > 0) {
          await this.sleep(wait, this.abort.signal);
          continue;
        }
        const admission = this.queue.shift();
        if (admission === undefined) break;
        this.nextStart = this.now() + this.fetchIntervalMs;
        admission.start();
      }
    } catch {
      for (const admission of this.queue.splice(0)) admission.reject(internalLocatorError(new RpcTransientError()));
    } finally {
      this.pumping = false;
    }
  }

  private retain(key: string, entry: CacheEntry): void {
    this.synchronizeEpoch();
    if (this.closed || !entry.snapshot.cacheable || entry.snapshot.bytes > Math.min(this.maxBytes, this.maxEntryBytes)
      || entry.epoch !== this.epoch || entry.generation !== this.generation
      || this.now() - entry.fetchedAt >= entry.ttlMs) return;
    this.remove(key);
    this.entries.set(key, entry);
    this.bytes += entry.snapshot.bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.fetchedAt >= entry.ttlMs) this.remove(key);
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.bytes -= entry.snapshot.bytes;
    this.entries.delete(key);
  }

  private rejectQueuedAdmissions(): void {
    for (const admission of this.queue.splice(0)) {
      admission.reject(internalLocatorError(new RpcTransientError()));
    }
  }
}
