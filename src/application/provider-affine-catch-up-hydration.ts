import { isNativeError, isProxy } from 'node:util/types';
import { isRpcProviderId, type RpcProviderId } from '../domain/rpc-provider.js';
import type { RuntimeBlockHydrationMetricsV1 } from '../domain/transaction-ingestion.js';
import {
  CachedSolanaBlockTransactionLocator,
  type BlockTransactionCacheOptions,
  type EpochTransactionBlockRpc,
} from '../solana/rpc/block-transaction-cache.js';
import {
  BlockUnavailableError, RpcTransientError, TransactionIndexNotFoundError,
  TransactionNormalizationError, TransactionUnavailableError, internalLocatorError,
  trustedTransactionLocatorFailure, type TransactionBlockRpc, type TransactionLocationTarget,
} from '../solana/rpc/transaction-locator.js';
import type { NormalizedTransaction } from '../solana/rpc/types.js';
import type { PromotedProviderSelection } from './promoted-provider-selector.js';
import type { PumpFunCatchUpTransactionLocator } from './pumpfun-catch-up-block-classifier.js';
import {
  isStrictCatchUpPausedError, isStrictCatchUpRefreshRequiredError,
  StrictCatchUpAbortedError, StrictCatchUpPausedError, StrictCatchUpRefreshRequiredError,
  StrictCatchUpScannerError, StrictCatchUpWindowExceededError, type StrictCatchUpScanResult,
} from './strict-catch-up-scanner.js';
import type { TransactionInboxWorkerLocator } from './transaction-inbox-worker.js';
import {
  HydrationGroupAdmission, type HydrationGroupAdmissionMetrics,
} from './hydration-group-admission.js';
import type {
  TransactionInboxClaimAdmission, TransactionInboxClaimReservation,
} from './transaction-inbox-claim-admission.js';

export interface ProviderAffineCatchUpHydrationOptions extends BlockTransactionCacheOptions {
  readonly currentSelection: () => PromotedProviderSelection;
}

type RouteContext = Readonly<{ providerId: RpcProviderId; token: string }>;
type PermitKind = 'WORKER' | 'SCAN';
type Waiter = Readonly<{
  kind: PermitKind;
  workerContext: RouteContext | undefined;
  signal: AbortSignal | undefined;
  grant: () => void;
  reject: (error: Error) => void;
  detach: () => void;
}>;
interface ScanPermit {
  readonly context: RouteContext;
  readonly signal: AbortSignal;
  readonly pending: Set<Promise<unknown>>;
  readonly calls: Set<Readonly<{ target: TransactionLocationTarget; signal: AbortSignal | undefined }>>;
  readonly workerSelectionRevision: bigint | null;
  workerSharingRevoked: boolean;
  accepting: boolean;
}
const MAX_PERMIT_WAITERS = 1024;
const windowOrigins = new WeakMap<object, StrictCatchUpWindowExceededError>();

export class ProviderAffineCatchUpHydrationError extends Error {
  public readonly retryable = true;

  public constructor() {
    super('Provider-affine catch-up hydration failed.');
    Object.defineProperty(this, 'name', { value: 'ProviderAffineCatchUpHydrationError' });
    Object.freeze(this);
  }
}

export class ProviderAffineCatchUpHydration {
  private readonly cache: CachedSolanaBlockTransactionLocator;
  private readonly worker: TransactionInboxWorkerLocator;
  private readonly classifiers = new Map<RpcProviderId, PumpFunCatchUpTransactionLocator>();
  private readonly providers: ReadonlyMap<RpcProviderId, TransactionBlockRpc>;
  private readonly currentSelection: () => PromotedProviderSelection;
  private readonly queue: Waiter[] = [];
  private readonly shutdown = new AbortController();
  private readonly admission: HydrationGroupAdmission;
  private active: RouteContext | null = null;
  private epoch = 0;
  private scanGeneration = 0n;
  private scanPermit: ScanPermit | null = null;
  private permitKind: PermitKind | null = null;
  private workerRouteContext: RouteContext | null = null;
  private workerRouteReferences = 0;
  private closed = false;

  public constructor(
    providers: ReadonlyMap<RpcProviderId, TransactionBlockRpc>,
    options: ProviderAffineCatchUpHydrationOptions,
  ) {
    try {
      this.providers = snapshotProviders(providers);
      if (isProxy(options) || typeof options.currentSelection !== 'function'
        || isProxy(options.currentSelection)) throw new TypeError();
      this.currentSelection = options.currentSelection;
    } catch { throw new ProviderAffineCatchUpHydrationError(); }
    this.admission = new HydrationGroupAdmission({ now: options.now ?? ((): number => performance.now()) });
    const epoch = (): number => this.epoch;
    const rpc: EpochTransactionBlockRpc = {
      get httpTransportEpoch() { return epoch(); },
      getBlockTransactions: async (slot, status, signal): Promise<unknown> => {
        this.assertOpen();
        const scan = this.scanPermit;
        if (scan !== null) {
          this.assertOpen(scan.signal);
          // Cache pacing can outlive an individual classifier's cancellation.
          const admitted = [...scan.calls].some((call) => call.target.slot === slot
            && (call.target.confirmationStatus === 'FINALIZED' ? 'FINALIZED' : 'CONFIRMED') === status
            && call.signal?.aborted !== true);
          if (!admitted) throw retryableFailure();
        } else {
          const selection = this.selection();
          this.assertOpen();
          if (selection?.providerId === null || selection === null
            || this.active?.token !== `worker:${selection.revision}`) throw retryableFailure();
        }
        const provider = this.active === null ? undefined : this.providers.get(this.active.providerId);
        if (provider === undefined) throw retryableFailure();
        this.assertOpen();
        const requestSignal = AbortSignal.any([
          this.shutdown.signal,
          ...(signal === undefined ? [] : [signal]),
          ...(scan === null ? [] : [scan.signal]),
        ]);
        return provider.getBlockTransactions(slot, status, requestSignal);
      },
    };
    try {
      this.cache = new CachedSolanaBlockTransactionLocator(rpc, {
        ...options, fetchIntervalMs: Math.max(250, options.fetchIntervalMs ?? 250),
      });
    } catch { throw new ProviderAffineCatchUpHydrationError(); }
    this.worker = Object.freeze({
      locate: (target): Promise<NormalizedTransaction> => this.locateWorker(target),
    } satisfies TransactionInboxWorkerLocator);
  }

  public workerLocator(): TransactionInboxWorkerLocator { return this.worker; }

  public workerAdmission(): TransactionInboxClaimAdmission { return this.createWorkerAdmission(); }

  public admissionMetrics(): HydrationGroupAdmissionMetrics { return this.admission.metrics(); }

  public classifierLocator(providerId: RpcProviderId): PumpFunCatchUpTransactionLocator {
    this.assertProvider(providerId);
    let locator = this.classifiers.get(providerId);
    if (locator === undefined) {
      locator = Object.freeze({
        locate: (target, signal): Promise<NormalizedTransaction> => this.locateClassifier(providerId, target, signal),
      } satisfies PumpFunCatchUpTransactionLocator);
      this.classifiers.set(providerId, locator);
    }
    return locator;
  }

  public async runStrictScan(
    providerId: RpcProviderId,
    scan: (signal: AbortSignal) => Promise<StrictCatchUpScanResult>,
    signal: AbortSignal,
  ): Promise<StrictCatchUpScanResult> {
    let acquired = false;
    try {
      this.assertProvider(providerId);
      this.assertOpen(signal);
      const combined = AbortSignal.any([signal, this.shutdown.signal]);
      await this.acquire('SCAN', combined);
      acquired = true;
      this.assertOpen(combined);
      const selection = this.selection();
      this.assertOpen(combined);
      this.scanGeneration += 1n;
      const permit: ScanPermit = {
        context: Object.freeze({ providerId, token: `scan:${this.scanGeneration}` }),
        signal: combined, pending: new Set(), calls: new Set(),
        workerSelectionRevision: selection?.providerId === providerId ? selection.revision : null,
        workerSharingRevoked: false, accepting: true,
      };
      this.scanPermit = permit;
      let result: StrictCatchUpScanResult;
      try {
        this.bind(permit.context);
        result = await scan(combined);
      } finally {
        permit.accepting = false;
        // A callback cannot release provider affinity while its SDK work is settling.
        await Promise.allSettled([...permit.pending]);
        this.scanPermit = null;
        if (combined.aborted && !this.closed) {
          this.active = null;
          this.advanceEpoch();
          void this.cache.metrics;
        }
      }
      this.assertOpen(combined);
      return result;
    } catch (error) {
      if (safeScannerError(error)
        && (error instanceof StrictCatchUpAbortedError || (!this.closed && !signal.aborted))) {
        throw reconstructScannerError(error);
      }
      throw new ProviderAffineCatchUpHydrationError();
    } finally {
      if (acquired) this.release();
    }
  }

  public canWorkerClaim(): boolean {
    const selection = this.closed ? null : this.selection();
    return this.isWorkerClaimReady(selection);
  }

  public metrics(): RuntimeBlockHydrationMetricsV1 {
    if (!this.closed) this.selection();
    return Object.freeze({ enabled: true, callerConcurrency: 1, ...this.cache.metrics });
  }

  public state(): Readonly<{ providerId: RpcProviderId | null; scanActive: boolean; workerClaimReady: boolean }> {
    const selection = this.closed ? null : this.selection();
    return Object.freeze({
      providerId: this.closed ? null : this.scanPermit?.context.providerId ?? selection?.providerId ?? null,
      scanActive: this.scanPermit !== null,
      workerClaimReady: this.isWorkerClaimReady(selection),
    });
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.queue.splice(0)) {
      waiter.detach();
      waiter.reject(retryableFailure());
    }
    this.shutdown.abort();
    this.admission.close();
    this.cache.close();
  }

  private async locateWorker(target: TransactionLocationTarget): Promise<NormalizedTransaction> {
    let handle: TransactionInboxClaimAdmission | undefined;
    let reservation: TransactionInboxClaimReservation | null = null;
    try {
      this.assertOpen();
      handle = this.createWorkerAdmission(target);
      reservation = await handle.acquire(this.shutdown.signal);
      if (reservation === null) throw retryableFailure();
      return await reservation.locate(target);
    } catch (error) {
      throw locatorFailure(error);
    } finally {
      reservation?.release();
      handle?.close();
    }
  }

  private createWorkerAdmission(knownTarget?: TransactionLocationTarget): TransactionInboxClaimAdmission {
    const worker = this.admission.registerWorker();
    const stopped = new AbortController();
    return Object.freeze({
      acquire: async (signal: AbortSignal): Promise<TransactionInboxClaimReservation | null> => {
        const combined = AbortSignal.any([signal, stopped.signal, this.shutdown.signal]);
        const selected = this.selection();
        if (selected?.providerId === undefined || selected.providerId === null || combined.aborted) return null;
        let generation = this.scanGeneration;
        const scan = this.sharedScanPermit(selected);
        const settlePin = scan === null ? undefined : this.pin(scan);
        let ownsRoute = false;
        let ticket: Awaited<ReturnType<typeof worker.acquire>> = null;
        let onReservationAbort: (() => void) | undefined;
        const operationSignal = scan === null ? combined : AbortSignal.any([combined, scan.signal]);
        const validate = (): void => {
          this.assertOpen(operationSignal);
          try { this.assertSelection(selected); }
          catch (error) {
            if (scan !== null) this.revokeWorkerSharing(scan);
            throw error;
          }
          if (this.scanGeneration !== generation
            || (scan !== null && (this.scanPermit !== scan || this.active !== scan.context
              || scan.workerSharingRevoked))) throw retryableFailure();
        };
        const cleanup = (): void => {
          if (onReservationAbort !== undefined) {
            operationSignal.removeEventListener('abort', onReservationAbort);
            onReservationAbort = undefined;
          }
          ticket?.release();
          ticket = null;
          settlePin?.();
          if (ownsRoute) { ownsRoute = false; this.releaseWorkerRoute(); }
        };
        try {
          // Provider eligibility precedes group capacity: an incompatible scan
          // must never be pinned behind an unbound worker waiting for its route.
          if (scan === null) {
            await this.acquire('WORKER', operationSignal, knownTarget === undefined ? undefined
              : { providerId: selected.providerId, token: `worker:${selected.revision}` });
            ownsRoute = true;
            // Legacy locate already has its durable target and may wait through
            // queued scans; pre-claim callers instead return null on that race.
            if (knownTarget !== undefined) generation = this.scanGeneration;
            validate();
            this.bind({ providerId: selected.providerId, token: `worker:${selected.revision}` });
          }
          validate();
          const context = scan?.context ?? this.active;
          if (context === null) throw retryableFailure();
          ticket = knownTarget === undefined
            ? await worker.acquire(operationSignal)
            : await worker.acquireGroup(this.groupKey(context, knownTarget), operationSignal);
          if (ticket === null) { cleanup(); return null; }
          validate();
          let released = false;
          let locating = false;
          let boundKey: string | null = knownTarget === undefined ? null : this.groupKey(context, knownTarget);
          const release = (): void => {
            if (released) return;
            released = true;
            operationSignal.removeEventListener('abort', release);
            // Cancellation is not settlement of an already-started SDK/cache operation.
            if (!locating) cleanup();
          };
          onReservationAbort = release;
          operationSignal.addEventListener('abort', release, { once: true });
          if (operationSignal.aborted) release();
          validate();
          return Object.freeze({
            release,
            locate: async (target: TransactionLocationTarget): Promise<NormalizedTransaction> => {
              let ownsLocate = false;
              try {
                validate();
                if (released || locating) throw retryableFailure();
                const key = this.groupKey(context, target);
                if (boundKey === null) {
                  if (ticket === null) throw retryableFailure();
                  ticket.bindGroup(key);
                  boundKey = key;
                }
                else if (boundKey !== key) throw retryableFailure();
                locating = true;
                ownsLocate = true;
                const result = await this.locateInContext(scan, target, operationSignal);
                validate();
                return result;
              } catch (error) {
                try { validate(); } catch { throw retryableFailure(); }
                throw locatorFailure(error);
              } finally {
                if (ownsLocate) {
                  locating = false;
                  if (released) cleanup();
                }
              }
            },
          });
        } catch {
          cleanup();
          return null;
        }
      },
      close: (): void => { stopped.abort(); worker.close(); },
    });
  }

  private pin(permit: ScanPermit): () => void {
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    permit.pending.add(pending);
    return (): void => { permit.pending.delete(pending); settle(); };
  }

  private groupKey(context: RouteContext, target: TransactionLocationTarget): string {
    return JSON.stringify([context.token, context.providerId, target.slot.toString(),
      target.confirmationStatus === 'FINALIZED' ? 'FINALIZED' : 'CONFIRMED']);
  }

  private async locateInContext(
    permit: ScanPermit | null, target: TransactionLocationTarget, signal: AbortSignal,
  ): Promise<NormalizedTransaction> {
    const call = Object.freeze({ target: Object.freeze({ ...target }), signal });
    permit?.calls.add(call);
    const pending = this.cache.locate(call.target);
    permit?.pending.add(pending);
    try { return await pending; }
    finally { permit?.pending.delete(pending); permit?.calls.delete(call); }
  }

  private async locateClassifier(
    providerId: RpcProviderId, target: TransactionLocationTarget, signal?: AbortSignal,
  ): Promise<NormalizedTransaction> {
    const permit = this.scanPermit;
    let settlePin: (() => void) | undefined;
    let ticket: Awaited<ReturnType<HydrationGroupAdmission['acquireClassifier']>> = null;
    try {
      this.assertOpen(signal);
      if (permit === null || !permit.accepting || permit.context.providerId !== providerId) throw retryableFailure();
      this.assertOpen(permit.signal);
      settlePin = this.pin(permit);
      const combined = AbortSignal.any([permit.signal, this.shutdown.signal,
        ...(signal === undefined ? [] : [signal])]);
      ticket = await this.admission.acquireClassifier(this.groupKey(permit.context, target), combined);
      if (ticket === null) throw retryableFailure();
      this.assertOpen(combined);
      if (this.scanPermit !== permit || this.active !== permit.context) throw retryableFailure();
      const result = await this.locateInContext(permit, target, combined);
      this.assertOpen(combined);
      if (this.scanPermit !== permit || this.active !== permit.context) throw retryableFailure();
      return result;
    } catch (error) {
      if (this.closed || signal?.aborted === true || permit?.signal.aborted === true) throw retryableFailure();
      throw locatorFailure(error);
    } finally {
      ticket?.release();
      settlePin?.();
    }
  }

  private acquire(kind: PermitKind, signal?: AbortSignal, workerContext?: RouteContext): Promise<void> {
    this.assertOpen(signal);
    // Shared routes are admitted consumers too, not a way around the existing
    // finite envelope of one active permit plus MAX_PERMIT_WAITERS followers.
    if (this.queue.length + Math.max(0, this.workerRouteReferences - 1) >= MAX_PERMIT_WAITERS) {
      return Promise.reject(retryableFailure());
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1);
        waiter.detach();
        reject(retryableFailure());
      };
      const waiter: Waiter = Object.freeze({
        kind, workerContext, signal, grant: resolve, reject,
        detach: () => signal?.removeEventListener('abort', onAbort),
      });
      this.queue.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.drain();
    });
  }

  private release(): void {
    this.permitKind = null;
    this.workerRouteContext = null;
    this.drain();
  }

  private releaseWorkerRoute(): void {
    this.workerRouteReferences -= 1;
    if (this.workerRouteReferences === 0) this.release();
  }

  private drain(): void {
    if (this.closed) return;
    if (this.permitKind !== null) {
      const next = this.queue[0];
      // Known-target consumers may share only this provider/revision context.
      // A queued scan stays exclusive and prevents any new route sharing.
      if (this.permitKind !== 'WORKER' || this.workerRouteContext === null
        || this.queue.some(({ kind }) => kind === 'SCAN')
        || next?.kind !== 'WORKER'
        || next.workerContext?.providerId !== this.workerRouteContext.providerId
        || next.workerContext.token !== this.workerRouteContext.token) return;
    }
    const waiter = this.queue.shift();
    if (waiter === undefined) return;
    waiter.detach();
    if (waiter.signal?.aborted === true) {
      waiter.reject(retryableFailure());
      this.drain();
      return;
    }
    this.permitKind = waiter.kind;
    if (waiter.kind === 'WORKER') {
      if (this.workerRouteReferences === 0) {
        this.workerRouteContext = waiter.workerContext ?? null;
        // Publish the compatible route atomically with its first grant so calls
        // in the same turn can reach group admission before any fetch settles.
        if (waiter.workerContext !== undefined) this.bind(waiter.workerContext);
      }
      this.workerRouteReferences += 1;
    }
    waiter.grant();
    this.drain();
  }

  private assertOpen(signal?: AbortSignal): void {
    if (this.closed || signal?.aborted === true) throw retryableFailure();
  }

  private assertProvider(providerId: RpcProviderId): void {
    if (!isRpcProviderId(providerId) || !this.providers.has(providerId)) throw new ProviderAffineCatchUpHydrationError();
  }

  private assertSelection(expected: PromotedProviderSelection): void {
    const actual = this.selection();
    this.assertOpen();
    if (actual?.providerId !== expected.providerId || actual.revision !== expected.revision) throw retryableFailure();
  }

  private sharedScanPermit(selected: PromotedProviderSelection): ScanPermit | null {
    const permit = this.scanPermit;
    if (permit === null || !permit.accepting || permit.signal.aborted
      || permit.context.providerId !== selected.providerId || this.active !== permit.context
      || permit.workerSharingRevoked || this.queue.some(({ kind }) => kind === 'SCAN')) return null;
    if (permit.workerSelectionRevision !== selected.revision) {
      this.revokeWorkerSharing(permit);
      return null;
    }
    return permit;
  }

  private isWorkerClaimReady(selection: PromotedProviderSelection | null): boolean {
    if (this.closed || selection?.providerId === undefined || selection.providerId === null) return false;
    const permit = this.scanPermit;
    if (permit !== null) return this.sharedScanPermit(selection) !== null;
    return this.permitKind !== 'SCAN' && !this.queue.some(({ kind }) => kind === 'SCAN');
  }

  private selection(): PromotedProviderSelection | null {
    let result: PromotedProviderSelection | null = null;
    try {
      const value: unknown = this.currentSelection();
      if (this.closed) return null;
      if (typeof value !== 'object' || value === null || isProxy(value)) throw new TypeError();
      const providerId = Object.getOwnPropertyDescriptor(value, 'providerId');
      const revision = Object.getOwnPropertyDescriptor(value, 'revision');
      if (providerId === undefined || !('value' in providerId)
        || revision === undefined || !('value' in revision)
        || (providerId.value !== null && (!isRpcProviderId(providerId.value) || !this.providers.has(providerId.value)))
        || typeof revision.value !== 'bigint' || revision.value < 0n) throw new TypeError();
      result = Object.freeze({ providerId: providerId.value as RpcProviderId | null, revision: revision.value });
    } catch { /* A malformed selector is equivalent to no promoted provider. */ }
    if (this.closed) return null;
    if (this.scanPermit === null && this.active?.token.startsWith('worker:') === true
      && (result?.providerId !== this.active.providerId
        || `worker:${result.revision}` !== this.active.token)) {
      this.active = null;
      this.advanceEpoch();
      // Synchronize now, including when the just-settled old result was retained.
      void this.cache.metrics;
    }
    return result;
  }

  private bind(context: RouteContext): void {
    if (this.active?.providerId === context.providerId && this.active.token === context.token) return;
    this.active = Object.freeze(context);
    this.advanceEpoch();
    // Apply the new epoch even for scans which never hydrate a block. A later
    // metrics read after close must not discover a pending second cache clear.
    void this.cache.metrics;
  }

  private advanceEpoch(): void {
    this.epoch = this.epoch === Number.MAX_SAFE_INTEGER ? 0 : this.epoch + 1;
  }

  private invalidateActiveCacheEpoch(): void {
    this.advanceEpoch();
    void this.cache.metrics;
  }

  private revokeWorkerSharing(permit: ScanPermit): void {
    if (permit.workerSharingRevoked) return;
    permit.workerSharingRevoked = true;
    this.invalidateActiveCacheEpoch();
  }
}

function retryableFailure(): RpcTransientError {
  return Object.freeze(internalLocatorError(new RpcTransientError()));
}

function locatorFailure(error: unknown): Error {
  const failure = trustedTransactionLocatorFailure(error);
  switch (failure?.code) {
    case 'BLOCK_NOT_AVAILABLE': return Object.freeze(internalLocatorError(new BlockUnavailableError()));
    case 'TRANSACTION_NOT_AVAILABLE': return Object.freeze(internalLocatorError(new TransactionUnavailableError()));
    case 'TRANSACTION_INDEX_NOT_FOUND': return Object.freeze(internalLocatorError(new TransactionIndexNotFoundError()));
    case 'NORMALIZATION_FAILED': return Object.freeze(internalLocatorError(new TransactionNormalizationError()));
    default: return retryableFailure();
  }
}

function snapshotProviders(providers: ReadonlyMap<RpcProviderId, TransactionBlockRpc>): ReadonlyMap<RpcProviderId, TransactionBlockRpc> {
  if (isProxy(providers) || Object.getPrototypeOf(providers) !== Map.prototype) throw new TypeError();
  const snapshot = new Map<RpcProviderId, TransactionBlockRpc>();
  for (const [providerId, rpc] of Map.prototype.entries.call(providers) as MapIterator<[unknown, unknown]>) {
    if (!isRpcProviderId(providerId) || typeof rpc !== 'object' || rpc === null || isProxy(rpc)) throw new TypeError();
    let cursor: object | null = rpc;
    let method: unknown;
    while (cursor !== null) {
      if (isProxy(cursor)) throw new TypeError();
      const descriptor = Object.getOwnPropertyDescriptor(cursor, 'getBlockTransactions');
      if (descriptor !== undefined) {
        if (!('value' in descriptor)) throw new TypeError();
        method = descriptor.value;
        break;
      }
      cursor = Object.getPrototypeOf(cursor) as object | null;
    }
    if (typeof method !== 'function' || isProxy(method)) throw new TypeError();
    const fetch = method as TransactionBlockRpc['getBlockTransactions'];
    snapshot.set(providerId, Object.freeze({
      getBlockTransactions: (slot, status, signal): Promise<unknown> => Reflect.apply(fetch, rpc, [slot, status, signal]),
    } satisfies TransactionBlockRpc));
  }
  if (snapshot.size === 0) throw new TypeError();
  return snapshot;
}

function safeScannerError(value: unknown): value is Error {
  try { return inspectScannerError(value); } catch { return false; }
}

function inspectScannerError(value: unknown): value is Error {
  if (typeof value !== 'object' || value === null || isProxy(value) || !isNativeError(value) || !Object.isFrozen(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  // Read data descriptors only, including on forged objects with a familiar prototype.
  const fields = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === '__proto__') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    // V8 uses a non-enumerable native accessor for Error.stack on newer Node versions.
    if (key === 'stack' && descriptor?.enumerable === false) continue;
    if (descriptor === undefined || !('value' in descriptor)) return false;
    fields[key] = descriptor.value;
  }
  const exact = (keys: readonly string[], name: string, message: string): boolean =>
    Object.keys(fields).every((key) => ['stack', 'message', 'name', ...keys].includes(key))
      && fields.name === name && fields.message === message;
  if (prototype === StrictCatchUpAbortedError.prototype && value instanceof StrictCatchUpAbortedError) {
    return exact([], 'StrictCatchUpAbortedError', 'Strict catch-up scan was aborted.');
  }
  if (prototype === StrictCatchUpRefreshRequiredError.prototype && value instanceof StrictCatchUpRefreshRequiredError) {
    return exact(['code', 'retryable', 'stage', 'providerId'], 'StrictCatchUpRefreshRequiredError', 'Strict catch-up requires a fresh recovery cycle.')
      && isRpcProviderId(fields.providerId) && isStrictCatchUpRefreshRequiredError(value, fields.providerId)
      && fields.code === 'CATCH_UP_REFRESH_REQUIRED'
      && fields.retryable === true && fields.stage === 'head-refresh';
  }
  if (prototype === StrictCatchUpWindowExceededError.prototype && value instanceof StrictCatchUpWindowExceededError) {
    return exact(['code', 'stage', 'retryable', 'providerId', 'checkpointKey'], 'StrictCatchUpWindowExceededError', 'Strict catch-up scan window was exceeded.')
      && isRpcProviderId(fields.providerId) && (fields.checkpointKey === 'launchpad' || fields.checkpointKey === 'market')
      && fields.code === 'CATCH_UP_WINDOW_EXCEEDED' && fields.stage === 'window' && fields.retryable === false
      && StrictCatchUpWindowExceededError.prototype.sameFrontier.call(value, value);
  }
  if (prototype === StrictCatchUpPausedError.prototype && value instanceof StrictCatchUpPausedError) {
    return exact(['code', 'retryable', 'stage', 'providerId', 'checkpointKey', 'runId', 'pagesScanned', 'signaturesEnqueued'],
      'StrictCatchUpPausedError', 'Strict catch-up paused after its page budget.')
      && isRpcProviderId(fields.providerId) && isStrictCatchUpPausedError(value, fields.providerId)
      && (fields.checkpointKey === 'launchpad' || fields.checkpointKey === 'market')
      && fields.code === 'CATCH_UP_PAGE_BUDGET_EXHAUSTED' && fields.retryable === true && fields.stage === 'page-budget'
      && typeof fields.runId === 'string' && /^strict_catchup_run_[0-9a-f]{64}$/u.test(fields.runId)
      && typeof fields.pagesScanned === 'bigint' && fields.pagesScanned >= 0n
      && typeof fields.signaturesEnqueued === 'bigint' && fields.signaturesEnqueued >= 0n;
  }
  if (prototype === StrictCatchUpScannerError.prototype && value instanceof StrictCatchUpScannerError) {
    return exact(['retryable', 'stage', 'providerId', 'checkpointKey', 'sourceStage'],
      'StrictCatchUpScannerError', 'Strict catch-up scanner operation failed.')
      && fields.retryable === true && isRpcProviderId(fields.providerId)
      && (fields.checkpointKey === 'launchpad' || fields.checkpointKey === 'market')
      && typeof fields.stage === 'string' && [
        'checkpoint-read', 'source', 'enqueue', 'page-admit', 'checkpoint-cas', 'failure-write',
        'failure-resolve', 'run-read', 'run-create', 'run-progress', 'run-complete', 'run-fail', 'run-supersede',
      ].includes(fields.stage)
      && (fields.sourceStage === null || fields.sourceStage === 'request'
        || fields.sourceStage === 'response' || fields.sourceStage === 'pagination');
  }
  return false;
}

function reconstructScannerError(error: Error): Error {
  if (error instanceof StrictCatchUpRefreshRequiredError) return new StrictCatchUpRefreshRequiredError(error.providerId);
  if (error instanceof StrictCatchUpPausedError) {
    return new StrictCatchUpPausedError(error.providerId, error.checkpointKey, error.runId, error.pagesScanned, error.signaturesEnqueued);
  }
  if (error instanceof StrictCatchUpScannerError) {
    return new StrictCatchUpScannerError(error.stage, error.providerId, error.checkpointKey, error.sourceStage);
  }
  if (error instanceof StrictCatchUpAbortedError) return new StrictCatchUpAbortedError();
  if (error instanceof StrictCatchUpWindowExceededError) return safeWindowError(error);
  return new ProviderAffineCatchUpHydrationError();
}

function safeWindowError(original: StrictCatchUpWindowExceededError): Error {
  // Keep the scanner's private frontier behind our own provenance map, never on
  // the public error. Neither provider stack data nor a caller method escapes.
  const error = new Error('Strict catch-up scan window was exceeded.');
  Object.setPrototypeOf(error, StrictCatchUpWindowExceededError.prototype);
  Object.defineProperties(error, {
    name: { value: 'StrictCatchUpWindowExceededError' },
    code: { value: 'CATCH_UP_WINDOW_EXCEEDED', enumerable: true },
    stage: { value: 'window', enumerable: true },
    retryable: { value: false, enumerable: true },
    providerId: { value: original.providerId, enumerable: true },
    checkpointKey: { value: original.checkpointKey, enumerable: true },
    sameFrontier: {
      value: (other: StrictCatchUpWindowExceededError): boolean => {
        const peer = windowOrigins.get(other);
        return peer !== undefined && StrictCatchUpWindowExceededError.prototype.sameFrontier.call(original, peer);
      },
    },
  });
  windowOrigins.set(error, original);
  return Object.freeze(error);
}
