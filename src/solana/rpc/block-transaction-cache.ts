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

export interface BlockTransactionCacheMetricsV1 {
  readonly version: 1;
  readonly locates: number;
  readonly hits: number;
  readonly misses: number;
  readonly inFlightJoins: number;
  readonly fetches: number;
  readonly forcedRefreshes: number;
  readonly evictions: number;
  readonly oversizeBypasses: number;
  readonly fetchFailures: number;
  readonly epochInvalidations: number;
  readonly retainedEntries: number;
  readonly retainedBytes: number;
  readonly inFlightFetches: number;
  readonly queuedFetches: number;
  readonly queueDelayMs: Readonly<{ last: number | null; maximum: number | null }>;
}

interface CacheEntry {
  readonly snapshot: BlockTransactionDataSnapshot;
  readonly fetchedAt: number;
  readonly generation: number;
  readonly epoch: number;
  readonly ttlMs: number;
}

interface Admission {
  readonly enqueuedAt: number;
  readonly start: () => void;
  readonly reject: (error: Error) => void;
}

/** Restart-only production opt-in; disabled by default and never paired with a legacy fallback. */
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
  private locates = 0;
  private hits = 0;
  private misses = 0;
  private inFlightJoins = 0;
  private fetches = 0;
  private forcedRefreshes = 0;
  private evictions = 0;
  private oversizeBypasses = 0;
  private fetchFailures = 0;
  private epochInvalidations = 0;
  private lastQueueDelayMs: number | null = null;
  private maximumQueueDelayMs: number | null = null;
  private activeFetches = 0;

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

  public get metrics(): BlockTransactionCacheMetricsV1 {
    this.synchronizeEpoch();
    this.pruneExpired();
    return Object.freeze({
      version: 1,
      locates: this.locates,
      hits: this.hits,
      misses: this.misses,
      inFlightJoins: this.inFlightJoins,
      fetches: this.fetches,
      forcedRefreshes: this.forcedRefreshes,
      evictions: this.evictions,
      oversizeBypasses: this.oversizeBypasses,
      fetchFailures: this.fetchFailures,
      epochInvalidations: this.epochInvalidations,
      retainedEntries: this.entries.size,
      retainedBytes: this.bytes,
      inFlightFetches: this.activeFetches,
      queuedFetches: this.queue.length,
      queueDelayMs: Object.freeze({
        last: this.lastQueueDelayMs,
        maximum: this.maximumQueueDelayMs,
      }),
    });
  }

  public async locate(target: TransactionLocationTarget): Promise<NormalizedTransaction> {
    if (this.closed) throw internalLocatorError(new RpcTransientError());
    if (typeof target.slot !== 'bigint' || target.slot < 0n || target.slot > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw internalLocatorError(new BlockUnavailableError());
    }
    this.locates = increment(this.locates);
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
        this.forcedRefreshes = increment(this.forcedRefreshes);
        this.remove(key, true);
        entry = undefined;
      }
    }
    if (entry === undefined) {
      this.misses = increment(this.misses);
      try {
        entry = await this.fetch(key, { ...target, confirmationStatus: status });
      } catch (error) {
        // Shared flights must not share the single-use trusted failure identity.
        throw internalLocatorError(error instanceof BlockUnavailableError
          ? new BlockUnavailableError() : new RpcTransientError());
      }
    } else {
      this.hits = increment(this.hits);
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
      this.remove(key, true);
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
    this.epochInvalidations = increment(this.epochInvalidations);
    this.clear();
  }

  private fetch(key: string, target: TransactionLocationTarget): Promise<CacheEntry> {
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      this.inFlightJoins = increment(this.inFlightJoins);
      return existing;
    }
    const epoch = this.epoch;
    const generation = this.generation;
    const ttlMs = target.confirmationStatus === 'FINALIZED' ? this.finalizedTtlMs : this.confirmedTtlMs;
    const enqueuedAt = this.now();
    const promise = new Promise<CacheEntry>((resolve, reject) => {
      this.queue.push({
        enqueuedAt,
        reject,
        start: () => {
          if (epoch !== this.rpc.httpTransportEpoch || generation !== this.generation) {
            reject(internalLocatorError(new RpcTransientError()));
            return;
          }
          this.fetches = increment(this.fetches);
          this.activeFetches += 1;
          void this.fetchSnapshot(target).then(
            (snapshot) => { resolve({ snapshot, fetchedAt: this.now(), epoch, generation, ttlMs }); }, reject,
          ).finally(() => { this.activeFetches -= 1; });
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
      this.fetchFailures = increment(this.fetchFailures);
      throw internalLocatorError(new RpcTransientError());
    }
    const snapshot = snapshotBlockTransactionData(raw, target.slot, target.confirmationStatus);
    if (snapshot === null) {
      this.fetchFailures = increment(this.fetchFailures);
      throw internalLocatorError(new BlockUnavailableError());
    }
    if (snapshot.bytes > Math.min(this.maxBytes, this.maxEntryBytes)) {
      this.oversizeBypasses = increment(this.oversizeBypasses);
    }
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
        const startedAt = this.now();
        this.recordQueueDelay(startedAt - admission.enqueuedAt);
        this.nextStart = startedAt + this.fetchIntervalMs;
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
    const oversized = entry.snapshot.bytes > Math.min(this.maxBytes, this.maxEntryBytes);
    if (this.closed || !entry.snapshot.cacheable || oversized
      || entry.epoch !== this.epoch || entry.generation !== this.generation
      || this.now() - entry.fetchedAt >= entry.ttlMs) return;
    this.remove(key);
    this.entries.set(key, entry);
    this.bytes += entry.snapshot.bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest, true);
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.fetchedAt >= entry.ttlMs) this.remove(key, true);
    }
  }

  private remove(key: string, eviction = false): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.bytes -= entry.snapshot.bytes;
    this.entries.delete(key);
    if (eviction) this.evictions = increment(this.evictions);
  }

  private recordQueueDelay(value: number): void {
    const delayMs = Number.isFinite(value) && value > 0
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(value))
      : 0;
    this.lastQueueDelayMs = delayMs;
    this.maximumQueueDelayMs = Math.max(this.maximumQueueDelayMs ?? 0, delayMs);
  }

  private rejectQueuedAdmissions(): void {
    for (const admission of this.queue.splice(0)) {
      admission.reject(internalLocatorError(new RpcTransientError()));
    }
  }
}

function increment(value: number): number {
  return value < Number.MAX_SAFE_INTEGER ? value + 1 : value;
}
