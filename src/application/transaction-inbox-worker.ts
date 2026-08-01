import {
  assertValidClaimedTransaction,
  restoreNormalizedTransactionSnapshot,
  type ClaimedTransaction,
  type IngestionFailure,
} from '../domain/transaction-ingestion.js';
import type { ChainConfirmationStatus } from '../domain/types.js';
import type { TransactionInboxRepository } from '../ports/transaction-inbox-repository.js';
import {
  trustedTransactionLocatorFailure,
  type TransactionLocationTarget,
} from '../solana/rpc/transaction-locator.js';
import type { LegacyConfirmationStatus, NormalizedTransaction } from '../solana/rpc/types.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type TransactionInboxWorkerState =
  | 'RUNNING'
  | 'DEGRADED'
  | 'STOPPING'
  | 'STOPPED';

export type TransactionInboxWorkerErrorStage =
  | 'claim'
  | 'save-snapshot'
  | 'mark-failed'
  | 'mark-processed'
  | 'clock';

export type TransactionInboxRunResult =
  | { readonly kind: 'idle' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'processed'; readonly signature: string }
  | { readonly kind: 'lease-lost'; readonly signature: string }
  | { readonly kind: 'failed'; readonly signature: string; readonly failure: IngestionFailure };

export type TransactionInboxWorkerRepository = Pick<
  TransactionInboxRepository,
  'claim' | 'renewLease' | 'saveSnapshot' | 'markProcessed' | 'markFailed'
>;

export interface TransactionInboxWorkerLocator {
  locate(target: TransactionLocationTarget): Promise<NormalizedTransaction>;
}

export interface TransactionInboxWorkerPipeline {
  process(transaction: NormalizedTransaction): Promise<unknown>;
}

export interface TransactionInboxWorkerScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface TransactionInboxWorkerOptions {
  readonly leaseSeconds: number;
  readonly renewalIntervalMs: number;
  readonly idlePollMs: number;
  readonly now?: () => number;
  readonly scheduler?: TransactionInboxWorkerScheduler;
}

export class TransactionInboxWorkerError extends Error {
  public constructor(public readonly stage: TransactionInboxWorkerErrorStage) {
    super('Transaction inbox worker operation failed.');
    this.name = 'TransactionInboxWorkerError';
    Object.freeze(this);
  }
}

const systemScheduler: TransactionInboxWorkerScheduler = Object.freeze({
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delayMs);
  },
  cancel(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

export class TransactionInboxWorker {
  private readonly leaseSeconds: number;
  private readonly leaseDurationMs: number;
  private readonly renewalIntervalMs: number;
  private readonly idlePollMs: number;
  private readonly now: () => number;
  private readonly scheduler: TransactionInboxWorkerScheduler;
  private currentState: TransactionInboxWorkerState = 'STOPPED';
  private runTail: Promise<void> = Promise.resolve();
  private loopPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private idleHandle: unknown = null;
  private idleResolve: (() => void) | null = null;
  private permanentlyClosed = false;
  private degraded = false;

  public constructor(
    private readonly repository: TransactionInboxWorkerRepository,
    private readonly locator: TransactionInboxWorkerLocator,
    private readonly pipeline: TransactionInboxWorkerPipeline,
    options: TransactionInboxWorkerOptions,
  ) {
    if (!positiveSafeInteger(options.leaseSeconds)
      || !positiveTimer(options.renewalIntervalMs)
      || !positiveTimer(options.idlePollMs)) {
      throw new TypeError('Transaction inbox worker timing options are invalid.');
    }
    const leaseDurationMs = options.leaseSeconds * 1_000;
    if (!Number.isSafeInteger(leaseDurationMs)
      || options.renewalIntervalMs >= leaseDurationMs) {
      throw new TypeError('Transaction inbox worker lease options are invalid.');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('Transaction inbox worker clock is invalid.');
    }
    if (options.scheduler !== undefined && !validScheduler(options.scheduler)) {
      throw new TypeError('Transaction inbox worker scheduler is invalid.');
    }
    this.leaseSeconds = options.leaseSeconds;
    this.leaseDurationMs = leaseDurationMs;
    this.renewalIntervalMs = options.renewalIntervalMs;
    this.idlePollMs = options.idlePollMs;
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? systemScheduler;
  }

  public get state(): TransactionInboxWorkerState {
    return this.currentState;
  }

  public runOnce(): Promise<TransactionInboxRunResult> {
    const operation = this.runTail.then(() => this.performRunOnce());
    this.runTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  public start(): Promise<void> {
    if (this.permanentlyClosed) return Promise.resolve();
    if (this.loopPromise !== null) return Promise.resolve();
    this.currentState = this.degraded ? 'DEGRADED' : 'RUNNING';
    const loop = this.runLoop();
    this.loopPromise = loop;
    void loop.then(
      () => { if (this.loopPromise === loop) this.loopPromise = null; },
      () => { if (this.loopPromise === loop) this.loopPromise = null; },
    );
    return Promise.resolve();
  }

  public close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.permanentlyClosed = true;
    this.currentState = 'STOPPING';
    this.cancelIdleWait();
    const operation = this.performClose();
    this.closePromise = operation;
    return operation;
  }

  private async runLoop(): Promise<void> {
    while (!this.permanentlyClosed) {
      try {
        const result = await this.runOnce();
        if (this.isClosed()) break;
        if (result.kind === 'idle') await this.waitForIdlePoll();
      } catch {
        this.reportDegraded();
        if (!this.isClosed()) await this.waitForIdlePoll();
      }
    }
  }

  private async performClose(): Promise<void> {
    const loop = this.loopPromise;
    if (loop !== null) await loop;
    await this.runTail;
    this.currentState = this.degraded ? 'DEGRADED' : 'STOPPED';
  }

  private async performRunOnce(): Promise<TransactionInboxRunResult> {
    if (this.permanentlyClosed) return frozenResult({ kind: 'closed' });
    let claimed: ClaimedTransaction | null;
    try {
      claimed = await this.repository.claim(this.readNow(), this.leaseSeconds);
    } catch {
      this.reportDegraded();
      throw new TransactionInboxWorkerError('claim');
    }
    if (claimed === null) return frozenResult({ kind: 'idle' });
    try {
      assertValidClaimedTransaction(claimed);
    } catch {
      if (hasPotentialCorruptSnapshot(claimed)) {
        return this.failClaim(claimed, normalizationFailure());
      }
      this.reportDegraded();
      throw new TransactionInboxWorkerError('claim');
    }
    return this.processClaim(claimed);
  }

  private async processClaim(claim: ClaimedTransaction): Promise<TransactionInboxRunResult> {
    let transaction: NormalizedTransaction;
    if (claim.normalizedTransaction === null) {
      if (claim.confirmationStatus === 'orphaned') {
        return this.failClaim(claim, normalizationFailure());
      }
      try {
        transaction = await this.locator.locate(Object.freeze({
          signature: claim.signature,
          slot: claim.slot,
          confirmationStatus: legacyStatus(claim.confirmationStatus),
        }));
      } catch (error) {
        return this.failClaim(claim, locatorFailure(error));
      }
      try {
        await this.repository.saveSnapshot(claim.signature, claim.leaseToken, transaction);
      } catch {
        this.reportDegraded();
        throw new TransactionInboxWorkerError('save-snapshot');
      }
    } else {
      try {
        transaction = restoreNormalizedTransactionSnapshot(claim.normalizedTransaction);
      } catch {
        return this.failClaim(claim, normalizationFailure());
      }
    }

    const lease = new LeaseGuard(
      claim,
      this.repository,
      this.scheduler,
      this.renewalIntervalMs,
      this.leaseDurationMs,
      () => this.readNow(),
      () => { this.reportDegraded(); },
    );
    if (!await lease.start()) return frozenResult({ kind: 'lease-lost', signature: claim.signature });

    let pipelineFailed = false;
    try {
      await this.pipeline.process(transaction);
    } catch {
      pipelineFailed = true;
    }
    const owned = await lease.finish();
    if (!owned) return frozenResult({ kind: 'lease-lost', signature: claim.signature });
    if (pipelineFailed) return this.markFailed(claim, pipelineFailure());

    try {
      await this.repository.markProcessed(
        claim.signature,
        claim.leaseToken,
        claim.confirmationStatus,
      );
    } catch {
      this.reportDegraded();
      throw new TransactionInboxWorkerError('mark-processed');
    }
    return frozenResult({ kind: 'processed', signature: claim.signature });
  }

  private async failClaim(
    claim: ClaimedTransaction,
    failure: IngestionFailure,
  ): Promise<TransactionInboxRunResult> {
    const owned = await renewOnce(
      claim,
      this.repository,
      this.leaseDurationMs,
      () => this.readNow(),
    );
    if (!owned) {
      this.reportDegraded();
      return frozenResult({ kind: 'lease-lost', signature: claim.signature });
    }
    return this.markFailed(claim, failure);
  }

  private async markFailed(
    claim: ClaimedTransaction,
    failure: IngestionFailure,
  ): Promise<TransactionInboxRunResult> {
    try {
      await this.repository.markFailed(claim.signature, claim.leaseToken, failure);
    } catch {
      this.reportDegraded();
      throw new TransactionInboxWorkerError('mark-failed');
    }
    return frozenResult({ kind: 'failed', signature: claim.signature, failure });
  }

  private readNow(): number {
    let value: number;
    try {
      value = this.now();
    } catch {
      this.reportDegraded();
      throw new TransactionInboxWorkerError('clock');
    }
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      this.reportDegraded();
      throw new TransactionInboxWorkerError('clock');
    }
    return value;
  }

  private waitForIdlePoll(): Promise<void> {
    if (this.permanentlyClosed) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleResolve = resolve;
      try {
        this.idleHandle = this.scheduler.schedule(() => {
          this.idleHandle = null;
          this.idleResolve = null;
          resolve();
        }, this.idlePollMs);
      } catch {
        this.idleHandle = null;
        this.reportDegraded();
      }
    });
  }

  private cancelIdleWait(): void {
    if (this.idleHandle !== null) {
      try {
        this.scheduler.cancel(this.idleHandle);
      } catch {
        this.reportDegraded();
      }
    }
    this.idleHandle = null;
    const resolve = this.idleResolve;
    this.idleResolve = null;
    resolve?.();
  }

  private reportDegraded(): void {
    this.degraded = true;
    if (this.currentState !== 'STOPPING') this.currentState = 'DEGRADED';
  }

  private isClosed(): boolean {
    return this.permanentlyClosed;
  }
}

class LeaseGuard {
  private handle: unknown = null;
  private pending: Promise<void> | null = null;
  private stopped = false;
  private owned = true;
  private untilMs: number;

  public constructor(
    private readonly claim: ClaimedTransaction,
    private readonly repository: TransactionInboxWorkerRepository,
    private readonly scheduler: TransactionInboxWorkerScheduler,
    private readonly intervalMs: number,
    private readonly leaseDurationMs: number,
    private readonly now: () => number,
    private readonly lost: () => void,
  ) {
    this.untilMs = claim.leaseExpiresAtMs;
  }

  public async start(): Promise<boolean> {
    await this.renew();
    if (this.owned) this.schedule();
    return this.owned;
  }

  public async finish(): Promise<boolean> {
    this.stopped = true;
    if (this.handle !== null) {
      try {
        this.scheduler.cancel(this.handle);
      } catch {
        this.owned = false;
        this.lost();
      }
    }
    this.handle = null;
    if (this.pending !== null) await this.pending;
    return this.owned;
  }

  private schedule(): void {
    if (this.stopped || !this.owned) return;
    try {
      this.handle = this.scheduler.schedule(() => {
        this.handle = null;
        const renewal = this.renew();
        this.pending = renewal;
        void renewal.then(() => {
          if (this.pending === renewal) this.pending = null;
          this.schedule();
        });
      }, this.intervalMs);
    } catch {
      this.handle = null;
      this.owned = false;
      this.lost();
    }
  }

  private async renew(): Promise<void> {
    if (!this.owned) return;
    try {
      this.untilMs = Math.max(this.untilMs, safeAdd(this.now(), this.leaseDurationMs));
      await this.repository.renewLease(this.claim.signature, this.claim.leaseToken, this.untilMs);
    } catch {
      this.owned = false;
      this.lost();
    }
  }
}

async function renewOnce(
  claim: ClaimedTransaction,
  repository: TransactionInboxWorkerRepository,
  leaseDurationMs: number,
  now: () => number,
): Promise<boolean> {
  try {
    const until = Math.max(claim.leaseExpiresAtMs, safeAdd(now(), leaseDurationMs));
    await repository.renewLease(claim.signature, claim.leaseToken, until);
    return true;
  } catch {
    return false;
  }
}

function locatorFailure(value: unknown): IngestionFailure {
  const trusted = trustedTransactionLocatorFailure(value);
  if (trusted !== null) return trusted;
  return Object.freeze({ code: 'RPC_TRANSIENT', errorName: 'TransactionLocatorError', retryable: true });
}

function normalizationFailure(): IngestionFailure {
  return Object.freeze({
    code: 'NORMALIZATION_FAILED', errorName: 'TransactionNormalizationError', retryable: false,
  });
}

function pipelineFailure(): IngestionFailure {
  return Object.freeze({
    code: 'PIPELINE_STAGE_FAILED', errorName: 'ObservedPipelineError', retryable: true,
  });
}

function legacyStatus(
  status: Exclude<ChainConfirmationStatus, 'orphaned'>,
): Exclude<LegacyConfirmationStatus, 'ORPHANED'> {
  switch (status) {
    case 'processed': return 'PROCESSED';
    case 'confirmed': return 'CONFIRMED';
    case 'finalized': return 'FINALIZED';
  }
}

function frozenResult<TResult extends TransactionInboxRunResult>(value: TResult): TResult {
  return Object.freeze(value);
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && !Object.is(value, -0);
}

function positiveTimer(value: number): boolean {
  return positiveSafeInteger(value) && value <= MAX_TIMER_DELAY_MS;
}

function validScheduler(value: TransactionInboxWorkerScheduler): boolean {
  return typeof value.schedule === 'function' && typeof value.cancel === 'function';
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new TransactionInboxWorkerError('clock');
  return result;
}

function hasPotentialCorruptSnapshot(value: unknown): value is ClaimedTransaction {
  try {
    if (typeof value !== 'object' || value === null) return false;
    const snapshot = Object.getOwnPropertyDescriptor(value, 'normalizedTransaction');
    const signature = Object.getOwnPropertyDescriptor(value, 'signature');
    const slot = Object.getOwnPropertyDescriptor(value, 'slot');
    const token = Object.getOwnPropertyDescriptor(value, 'leaseToken');
    const expiry = Object.getOwnPropertyDescriptor(value, 'leaseExpiresAtMs');
    return snapshot !== undefined && 'value' in snapshot && snapshot.value !== null
      && signature !== undefined && 'value' in signature && typeof signature.value === 'string'
      && slot !== undefined && 'value' in slot && typeof slot.value === 'bigint'
      && token !== undefined && 'value' in token && typeof token.value === 'string'
      && expiry !== undefined && 'value' in expiry && typeof expiry.value === 'number';
  } catch {
    return false;
  }
}
