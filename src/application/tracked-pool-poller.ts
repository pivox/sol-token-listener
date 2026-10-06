import { PublicKey } from '@solana/web3.js';
import type {
  ListenerRuntimeState,
  TransactionNotification,
} from '../domain/transaction-ingestion.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import { snapshotCatchUpPage, type CatchUpSignature } from '../solana/rpc/catch-up-source.js';
import {
  MAX_TRACKED_POOLS,
  type PoolCheckpoint,
  type TrackedPool,
} from '../storage/tracked-pool.repository.js';

const PAGE_SIZE = 1_000;
const MAX_PAGES = 5;
const SWEEP_TIMEOUT_MS = 30_000;

export type TrackedPoolOutcome = 'SUCCEEDED' | 'AWAITING_BOUNDARY' | 'GAP_SKIPPED' | 'FAILED';

export interface TrackedPoolCycleReport {
  readonly tracked: number;
  readonly capReached: boolean;
  readonly succeeded: number;
  readonly awaitingBoundary: number;
  readonly gapSkipped: number;
  readonly failed: number;
  readonly enqueued: number;
  readonly durationMs: number;
  /** Set when the whole cycle failed (selection or database error). */
  readonly errorName: string | null;
}

export interface TrackedPoolReport {
  readonly poolAddress: string;
  readonly outcome: TrackedPoolOutcome;
  readonly pageCount: number;
  readonly signaturesRead: number;
  /** Oldest slot read when the page budget ran out before the checkpoint (GAP_SKIPPED). */
  readonly gapClosedAtSlot: bigint | null;
  readonly errorName: string | null;
}

export interface TrackedPoolPollerOptions {
  readonly repository: {
    listTrackedPools(trackingWindowSeconds: number): Promise<readonly TrackedPool[]>;
    readCheckpoint(poolAddress: string): Promise<PoolCheckpoint | null>;
    seedCheckpoint(poolAddress: string, value: PoolCheckpoint, nowMs: number): Promise<void>;
    storeCheckpoint(poolAddress: string, value: PoolCheckpoint, nowMs: number): Promise<void>;
  };
  readonly inbox: { enqueue(value: TransactionNotification): Promise<void> };
  readonly rpc: {
    getSignaturesForAddress(
      address: PublicKey,
      options: { readonly before?: string | undefined; readonly until?: string; readonly limit: number },
      commitment: 'finalized',
    ): Promise<unknown>;
  };
  readonly intervalMs: number;
  readonly trackingWindowSeconds: number;
  readonly shutdownTimeoutMs: number;
  readonly scheduler: { schedule(callback: () => void, delayMs: number): unknown; cancel(handle: unknown): void };
  readonly now?: () => number;
  readonly onCycle?: (report: TrackedPoolCycleReport) => void;
  readonly onPool?: (report: TrackedPoolReport) => void;
}

interface PollResult {
  outcome: TrackedPoolOutcome;
  pageCount: number;
  signaturesRead: number;
  gapClosedAtSlot: bigint | null;
  enqueued: number;
}

export class TrackedPoolPoller {
  private currentState: ListenerRuntimeState = 'STOPPED';
  private readonly now: () => number;
  private readonly lastOutcome = new Map<string, TrackedPoolOutcome>();
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private closed = false;

  public constructor(private readonly options: TrackedPoolPollerOptions) {
    this.now = options.now ?? Date.now;
  }

  public async start(): Promise<void> {
    if (this.closed) return;
    this.currentState = 'STARTING';
    await this.runAndSchedule();
  }

  public close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    if (this.timer !== null) this.options.scheduler.cancel(this.timer);
    this.timer = null;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  public state(): ListenerRuntimeState {
    return this.currentState;
  }

  private async runAndSchedule(): Promise<void> {
    const operation = this.cycle();
    this.inFlight = operation;
    try {
      await operation;
      if (!this.closed) this.currentState = 'RUNNING';
    } catch {
      if (!this.closed) this.currentState = 'DEGRADED';
    } finally {
      if (this.inFlight === operation) this.inFlight = null;
    }
    if (this.closed) return;
    this.timer = this.options.scheduler.schedule(() => {
      this.timer = null;
      if (!this.closed) void this.runAndSchedule();
    }, this.options.intervalMs);
  }

  private async performClose(): Promise<void> {
    const running = this.inFlight;
    if (running !== null) {
      const settled = running.then(() => 'complete' as const, () => 'complete' as const);
      if (await withTimeout(settled, this.options.shutdownTimeoutMs, this.options.scheduler) === 'timeout') {
        this.currentState = 'DEGRADED';
        throw new Error('Tracked pool poller close timed out.');
      }
    }
    this.currentState = 'STOPPED';
  }

  private async cycle(): Promise<void> {
    const startedAtMs = this.now();
    const report = {
      tracked: 0, capReached: false, succeeded: 0, awaitingBoundary: 0, gapSkipped: 0,
      failed: 0, enqueued: 0, durationMs: 0, errorName: null as string | null,
    };
    try {
      const pools = await this.options.repository.listTrackedPools(this.options.trackingWindowSeconds);
      report.tracked = pools.length;
      report.capReached = pools.length >= MAX_TRACKED_POOLS;
      for (const pool of pools) {
        if (this.closed) break;
        const result = await this.pollWithTimeout(pool);
        report.enqueued += result.enqueued;
        if (result.outcome === 'SUCCEEDED') report.succeeded += 1;
        else if (result.outcome === 'AWAITING_BOUNDARY') report.awaitingBoundary += 1;
        else if (result.outcome === 'GAP_SKIPPED') report.gapSkipped += 1;
        else report.failed += 1;
      }
    } catch (error) {
      report.errorName = errorName(error);
      throw error;
    } finally {
      report.durationMs = Math.max(0, this.now() - startedAtMs);
      this.options.onCycle?.(Object.freeze({ ...report }));
    }
  }

  private async pollWithTimeout(pool: TrackedPool): Promise<PollResult> {
    const deadline = { expired: false };
    const progress: PollResult = {
      outcome: 'FAILED', pageCount: 0, signaturesRead: 0, gapClosedAtSlot: null, enqueued: 0,
    };
    let error: unknown = null;
    try {
      const result = await withTimeout(
        this.pollPool(pool, progress, deadline),
        SWEEP_TIMEOUT_MS,
        this.options.scheduler,
      );
      if (result === 'timeout') {
        deadline.expired = true;
        error = new Error('Tracked pool sweep timed out.');
      } else {
        progress.outcome = result;
      }
    } catch (caught) {
      error = caught;
    }
    if (error !== null) progress.outcome = 'FAILED';
    this.recordOutcome(pool.poolAddress, progress, error);
    return progress;
  }

  private recordOutcome(poolAddress: string, result: PollResult, error: unknown): void {
    const previous = this.lastOutcome.get(poolAddress);
    this.lastOutcome.set(poolAddress, result.outcome);
    if (result.outcome === 'SUCCEEDED' && previous === 'SUCCEEDED') return;
    this.options.onPool?.(Object.freeze({
      poolAddress,
      outcome: result.outcome,
      pageCount: result.pageCount,
      signaturesRead: result.signaturesRead,
      gapClosedAtSlot: result.gapClosedAtSlot,
      errorName: error === null ? null : errorName(error),
    }));
  }

  private async pollPool(
    pool: TrackedPool,
    progress: PollResult,
    deadline: { expired: boolean },
  ): Promise<TrackedPoolOutcome> {
    const { repository, rpc } = this.options;
    let checkpoint = await repository.readCheckpoint(pool.poolAddress);
    if (checkpoint === null) {
      checkpoint = { slot: pool.activationSlot, signature: pool.activationSignature };
      await repository.seedCheckpoint(pool.poolAddress, checkpoint, this.now());
    }
    const address = new PublicKey(pool.poolAddress);
    const rows: CatchUpSignature[] = [];
    const seen = new Set<string>([checkpoint.signature]);
    let reachedEnd = false;
    while (progress.pageCount < MAX_PAGES) {
      assertNotExpired(deadline);
      const before = rows.at(-1)?.signature;
      const page = snapshotCatchUpPage(
        await rpc.getSignaturesForAddress(
          address,
          { before, until: checkpoint.signature, limit: PAGE_SIZE },
          'finalized',
        ),
        PAGE_SIZE,
      );
      progress.pageCount += 1;
      progress.signaturesRead += page.length;
      for (const entry of page) {
        const previousSlot = rows.at(-1)?.slot;
        if ((previousSlot !== undefined && entry.slot > previousSlot)
          || entry.slot < checkpoint.slot || seen.has(entry.signature)
          || entry.confirmationStatus !== 'finalized') {
          throw new Error('Tracked pool signature page is inconsistent.');
        }
        seen.add(entry.signature);
        rows.push(entry);
      }
      if (page.length < PAGE_SIZE) {
        reachedEnd = true;
        break;
      }
    }
    assertNotExpired(deadline);
    const probe = snapshotCatchUpPage(
      await rpc.getSignaturesForAddress(
        address,
        { before: rows.at(-1)?.signature, limit: 1 },
        'finalized',
      ),
      1,
    );
    const confirmed = probe.length === 1
      && probe[0]?.signature === checkpoint.signature
      && probe[0].slot === checkpoint.slot;
    // Unconfirmed boundary: a short page waits for it; an exhausted page budget skips the gap and
    // catches up to the live edge (enqueue what was read, checkpoint at the newest row).
    if (!confirmed && reachedEnd) return 'AWAITING_BOUNDARY';
    for (const entry of rows) {
      if (deadline.expired) throw new Error('Tracked pool sweep timed out.');
      if (entry.transactionFailed) continue;
      await this.options.inbox.enqueue(Object.freeze({
        signature: entry.signature,
        slot: entry.slot,
        source: 'CATCH_UP',
        ingestionHint: 'PUMPSWAP_POOL_TRADE',
        ingestionHintMint: pool.baseMint,
        programIds: Object.freeze([PUMPSWAP_PROGRAM_ID]),
        confirmationStatus: 'finalized',
        observedAtMs: this.now(),
      }));
      progress.enqueued += 1;
    }
    const newest = rows[0];
    if (newest !== undefined && !deadline.expired) {
      await repository.storeCheckpoint(
        pool.poolAddress,
        { slot: newest.slot, signature: newest.signature },
        this.now(),
      );
    }
    if (confirmed) return 'SUCCEEDED';
    progress.gapClosedAtSlot = rows.at(-1)?.slot ?? null;
    return 'GAP_SKIPPED';
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  scheduler: TrackedPoolPollerOptions['scheduler'],
): Promise<T | 'timeout'> {
  let handle: unknown;
  const timeout = new Promise<'timeout'>((resolve) => {
    handle = scheduler.schedule(() => { resolve('timeout'); }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    scheduler.cancel(handle);
  }
}

function assertNotExpired(deadline: { readonly expired: boolean }): void {
  if (deadline.expired) throw new Error('Tracked pool sweep timed out.');
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
