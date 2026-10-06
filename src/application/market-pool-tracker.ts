import { selectTrackedPools, type TrackedPoolCandidate } from './market-pool-selection.js';
import type { PoolSweepResult } from './pool-catch-up-scanner.js';

export type MarketCoverageState = 'WARMING_UP' | 'HEALTHY' | 'DEGRADED';

export interface MarketPoolTrackerDependencies {
  readonly repository: {
    listCandidates(windowStartMs: number): Promise<readonly TrackedPoolCandidate[]>;
    seedFromActivation(candidate: TrackedPoolCandidate, nowMs: number): Promise<void>;
  };
  readonly scanner: { scanPool(poolAddress: string): Promise<PoolSweepResult> };
  readonly subscriber: {
    sync(pools: readonly string[]): Promise<void>;
    isHealthy(pool: string): boolean;
    close(): Promise<void>;
  };
}

export interface MarketPoolTrackerScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface MarketPoolTrackerOptions {
  readonly intervalMs: number;
  readonly windowMs: number;
  readonly maxPools: number;
  /** Per-pool sweep bound, also the bound close() waits for an in-flight cycle. Default 30 s. */
  readonly sweepTimeoutMs?: number;
  /**
   * Loop liveness bound: when no cycle has completed for longer than this, no mint is covered.
   * Default 3 * intervalMs + sweepTimeoutMs.
   */
  readonly maxStalenessMs?: number;
  /**
   * A pool that never succeeded and was activated less than this ago is AWAITING_FINALIZATION (not
   * DEGRADED) when its activation checkpoint is not finalized yet. Default 90 s.
   */
  readonly finalizationGraceMs?: number;
  readonly scheduler?: MarketPoolTrackerScheduler;
  readonly now?: () => number;
  readonly onSweep?: (report: PoolSweepReport) => void;
  readonly onCycle?: (report: MarketPoolCycleReport) => void;
}

export interface PoolSweepReport {
  readonly poolAddress: string;
  readonly outcome: 'SUCCEEDED' | 'FAILED';
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly durationMs: number;
  readonly result: PoolSweepResult | null;
  readonly errorCode: string | null;
}

export interface MarketPoolCycleReport {
  readonly coverageState: MarketCoverageState;
  readonly trackedPools: readonly string[];
  readonly droppedByCap: readonly string[];
  readonly refreshFailed: boolean;
  /** Refresh error code(s) of this cycle; empty when the refresh succeeded. */
  readonly errorCodes: readonly string[];
}

type PoolOutcome = 'SUCCEEDED' | 'FAILED' | 'AWAITING_FINALIZATION';

interface PoolStatus {
  lastOutcome: PoolOutcome | null;
  // Number of completed cycles when the last success happened: the success belongs to the cycle
  // that becomes completion number `lastSucceededCycle + 1`.
  lastSucceededCycle: number | null;
  sweepsSucceeded: number;
  sweepsFailed: number;
  // Consecutive backoff-worthy failures (reset on success) and cycles left to skip.
  backoffLevel: number;
  backoffRemaining: number;
}

const DEFAULT_SWEEP_TIMEOUT_MS = 30_000;
const DEFAULT_FINALIZATION_GRACE_MS = 90_000;
const MAX_BACKOFF_CYCLES = 64;
const BACKOFF_ERROR_CODES: ReadonlySet<string> = new Set(['CATCH_UP_WINDOW_EXCEEDED', 'POOL_CHECKPOINT_NOT_FOUND']);
const CHECKPOINT_NOT_FOUND_CODE = 'POOL_CHECKPOINT_NOT_FOUND';
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_.-]{1,63}$/u;

class PoolSweepTimeoutError extends Error {
  public readonly code = 'POOL_SWEEP_TIMEOUT' as const;

  public constructor() {
    super('Pool sweep timed out.');
    this.name = 'PoolSweepTimeoutError';
  }
}

class RefreshError extends Error {
  public constructor(public readonly errorCode: string) {
    super('Market pool refresh failed.');
    this.name = 'RefreshError';
  }
}

const REFRESH_TIMEOUT_CODE = 'MARKET_POOL_REFRESH_TIMEOUT';

const defaultScheduler: MarketPoolTrackerScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

export class MarketPoolTracker {
  private readonly scheduler: MarketPoolTrackerScheduler;
  private readonly now: () => number;
  private readonly sweepTimeoutMs: number;
  private readonly maxStalenessMs: number;
  private readonly finalizationGraceMs: number;
  private tracked = new Map<string, TrackedPoolCandidate>();
  private mintToPools = new Map<string, string[]>();
  private droppedMints = new Set<string>();
  private readonly status = new Map<string, PoolStatus>();
  // Scans abandoned on timeout that have not settled yet: never start a second scan of those pools.
  private readonly scanning = new Set<string>();
  private refreshFailed = false;
  // Counts whole cycles (refresh, seeding, subscriber sync and sweeps) completed after a successful
  // refresh. Until the first one nothing is covered: the guard must fail closed at boot.
  private completedCycles = 0;
  private lastCycleCompletedAtMs: number | null = null;
  private started: Promise<void> | null = null;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;

  public constructor(
    private readonly dependencies: MarketPoolTrackerDependencies,
    private readonly options: MarketPoolTrackerOptions,
  ) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1_000) {
      throw new TypeError('Market pool tracker interval is invalid.');
    }
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 0) {
      throw new TypeError('Market pool tracker window is invalid.');
    }
    if (!Number.isSafeInteger(options.maxPools) || options.maxPools < 1) {
      throw new TypeError('Market pool tracker pool cap is invalid.');
    }
    const sweepTimeoutMs = options.sweepTimeoutMs ?? DEFAULT_SWEEP_TIMEOUT_MS;
    if (!Number.isSafeInteger(sweepTimeoutMs) || sweepTimeoutMs < 1) {
      throw new TypeError('Market pool tracker sweep timeout is invalid.');
    }
    const maxStalenessMs = options.maxStalenessMs ?? 3 * options.intervalMs + sweepTimeoutMs;
    if (!Number.isSafeInteger(maxStalenessMs) || maxStalenessMs < options.intervalMs) {
      throw new TypeError('Market pool tracker staleness bound is invalid.');
    }
    const finalizationGraceMs = options.finalizationGraceMs ?? DEFAULT_FINALIZATION_GRACE_MS;
    if (!Number.isSafeInteger(finalizationGraceMs) || finalizationGraceMs < 0) {
      throw new TypeError('Market pool tracker finalization grace is invalid.');
    }
    this.sweepTimeoutMs = sweepTimeoutMs;
    this.maxStalenessMs = maxStalenessMs;
    this.finalizationGraceMs = finalizationGraceMs;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? Date.now;
  }

  /** Idempotent: repeated calls share the first start, so only one timer loop ever exists. */
  public start(): Promise<void> {
    this.started ??= this.runCycleForTest().then(() => { this.schedule(); });
    return this.started;
  }

  /** Safe before start() and idempotent: concurrent and repeated calls share one shutdown. */
  public close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) this.scheduler.cancel(this.timer);
    this.timer = null;
    // A hung refresh (DB/RPC) must not block shutdown forever: wait at most sweepTimeoutMs.
    if (this.inFlight !== null) await this.bounded(this.inFlight.catch(() => undefined), () => undefined);
    await this.dependencies.subscriber.close();
  }

  public coverageState(): MarketCoverageState {
    if (this.refreshFailed) return 'DEGRADED';
    if (this.completedCycles === 0) return 'WARMING_UP';
    if (!this.isLoopAlive()) return 'DEGRADED';
    let warming = false;
    for (const pool of this.tracked.keys()) {
      const outcome = this.status.get(pool)?.lastOutcome ?? null;
      if (outcome === null) {
        warming = true;
      } else if (outcome === 'AWAITING_FINALIZATION') {
        // Its own mint stays uncovered; a fresh migration must not flap global coverage.
        continue;
      } else if (!this.isPoolCovered(pool)) {
        return 'DEGRADED';
      }
    }
    return warming ? 'WARMING_UP' : 'HEALTHY';
  }

  // Fails closed: nothing is covered before the first complete cycle, while the latest refresh
  // failed (a new pool for any mint cannot be ruled out), nor when no cycle has completed within
  // maxStalenessMs (the loop is stuck). Otherwise a mint in its bonding-curve phase has no pool,
  // hence no market requirement; a mint with a pool dropped by the cap is not covered; a mint with
  // tracked pools is covered only if every one of them is.
  public isMintCovered(mint: string): boolean {
    if (this.completedCycles === 0 || this.refreshFailed || !this.isLoopAlive()) return false;
    if (this.droppedMints.has(mint)) return false;
    const pools = this.mintToPools.get(mint);
    if (pools === undefined) return true;
    return pools.every((pool) => this.isPoolCovered(pool));
  }

  private isLoopAlive(): boolean {
    return this.lastCycleCompletedAtMs !== null && this.now() - this.lastCycleCompletedAtMs <= this.maxStalenessMs;
  }

  // Freshness is counted in cycles, not wall-clock time, so a slow pool lengthening a cycle cannot
  // make the others stale: a pool is fresh if it succeeded in the cycle in progress or in the last
  // completed one. Loop liveness (isLoopAlive) bounds the wall-clock age.
  private isPoolCovered(pool: string): boolean {
    const status = this.status.get(pool);
    return status?.lastOutcome === 'SUCCEEDED'
      && status.lastSucceededCycle !== null
      && this.completedCycles - status.lastSucceededCycle <= 1
      && this.dependencies.subscriber.isHealthy(pool);
  }

  /**
   * Runs one refresh-and-sweep cycle; public for deterministic tests, also used by start() and the
   * scheduled loop. A call made while a cycle is in flight joins it, so cycles never overlap.
   */
  public runCycleForTest(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const operation = this.runCycle().finally(() => { this.inFlight = null; });
    this.inFlight = operation;
    return operation;
  }

  private async runCycle(): Promise<void> {
    if (this.closed) return;
    const nowMs = this.now();
    let droppedByCap: readonly TrackedPoolCandidate[] = [];
    const seedFailures = new Set<string>();
    try {
      let selection: ReturnType<typeof selectTrackedPools>;
      try {
        const candidates = await this.boundedRefresh(
          this.dependencies.repository.listCandidates(nowMs - this.options.windowMs),
        );
        selection = selectTrackedPools(candidates, {
          nowMs, windowMs: this.options.windowMs, maxPools: this.options.maxPools,
        });
      } catch (error) {
        if (error instanceof RefreshError) throw error;
        throw new RefreshError(ownErrorCode(error) ?? 'MARKET_POOL_REFRESH_FAILED');
      }
      // A seeding failure is isolated to its pool: that pool fails this cycle, the others proceed.
      for (const pool of selection.tracked) {
        try {
          await this.boundedRefresh(this.dependencies.repository.seedFromActivation(pool, nowMs));
        } catch (error) {
          // A hung seed means the store is stalled for everyone: fail the whole refresh.
          if (error instanceof RefreshError) throw error;
          seedFailures.add(pool.poolAddress);
        }
      }
      this.tracked = new Map(selection.tracked.map((pool) => [pool.poolAddress, pool]));
      const mintToPools = new Map<string, string[]>();
      for (const pool of selection.tracked) {
        const pools = mintToPools.get(pool.baseMint) ?? [];
        pools.push(pool.poolAddress);
        mintToPools.set(pool.baseMint, pools);
      }
      this.mintToPools = mintToPools;
      this.droppedMints = new Set(selection.droppedByCap.map((pool) => pool.baseMint));
      droppedByCap = selection.droppedByCap;
      for (const pool of [...this.status.keys()]) if (!this.tracked.has(pool)) this.status.delete(pool);
      try {
        await this.boundedRefresh(this.dependencies.subscriber.sync([...this.tracked.keys()]));
      } catch (error) {
        if (error instanceof RefreshError) throw error;
        throw new RefreshError(ownErrorCode(error) ?? 'MARKET_POOL_SYNC_FAILED');
      }
      this.refreshFailed = false;
    } catch (error) {
      this.refreshFailed = true;
      this.publishCycle(droppedByCap, [error instanceof RefreshError ? error.errorCode : 'MARKET_POOL_REFRESH_FAILED']);
      return;
    }
    for (const pool of this.tracked.keys()) {
      // close() may run during any await of this cycle; stop sweeping as soon as it does, but still
      // publish what this cycle observed. The tracker stays uninitialized if this was the first cycle.
      if (this.isClosed()) {
        this.publishCycle(droppedByCap, []);
        return;
      }
      if (seedFailures.has(pool)) {
        this.recordSeedFailure(pool);
      } else {
        await this.sweepPool(pool);
      }
    }
    if (!this.isClosed()) {
      this.completedCycles += 1;
      this.lastCycleCompletedAtMs = this.now();
    }
    this.publishCycle(droppedByCap, []);
  }

  private isClosed(): boolean {
    return this.closed;
  }

  private statusOf(pool: string): PoolStatus {
    const status: PoolStatus = this.status.get(pool) ?? {
      lastOutcome: null, lastSucceededCycle: null, sweepsSucceeded: 0, sweepsFailed: 0,
      backoffLevel: 0, backoffRemaining: 0,
    };
    this.status.set(pool, status);
    return status;
  }

  // Without a checkpoint the pool cannot be swept; it is FAILED (hence DEGRADED) until a seed succeeds.
  private recordSeedFailure(pool: string): void {
    this.recordSkippedSweep(pool, 'POOL_CHECKPOINT_SEED_FAILED');
  }

  // A sweep that is not attempted (no RPC call) leaves the pool FAILED.
  private recordSkippedSweep(pool: string, errorCode: string): void {
    const status = this.statusOf(pool);
    status.lastOutcome = 'FAILED';
    status.sweepsFailed += 1;
    const nowMs = this.now();
    this.publishSweep({
      poolAddress: pool, outcome: 'FAILED', startedAtMs: nowMs, completedAtMs: nowMs, durationMs: 0,
      result: null, errorCode,
    });
  }

  private async sweepPool(pool: string): Promise<void> {
    const status = this.statusOf(pool);
    // A pool whose history exceeds the catch-up window (or whose checkpoint the RPC cannot confirm)
    // would burn pages every cycle for nothing: skip it for 1, 2, 4, ... 64 cycles.
    if (status.backoffRemaining > 0) {
      status.backoffRemaining -= 1;
      this.recordSkippedSweep(pool, 'POOL_SWEEP_BACKOFF');
      return;
    }
    // A scan abandoned on timeout may still be running: never run two scans of one pool at once.
    if (this.scanning.has(pool)) {
      this.recordSkippedSweep(pool, 'POOL_SWEEP_STILL_RUNNING');
      return;
    }
    const startedAtMs = this.now();
    let result: PoolSweepResult | null = null;
    let errorCode: string | null = null;
    try {
      const scan = this.dependencies.scanner.scanPool(pool);
      this.scanning.add(pool);
      const settled = (): void => { this.scanning.delete(pool); };
      scan.then(settled, settled);
      result = await this.bounded(scan, () => {
        // The abandoned sweep is left to settle on its own; never surface its late rejection.
        scan.catch(() => undefined);
        throw new PoolSweepTimeoutError();
      });
      status.lastOutcome = 'SUCCEEDED';
      status.lastSucceededCycle = this.completedCycles;
      status.sweepsSucceeded += 1;
      status.backoffLevel = 0;
      status.backoffRemaining = 0;
    } catch (error) {
      errorCode = readErrorCode(error);
      status.sweepsFailed += 1;
      if (errorCode === CHECKPOINT_NOT_FOUND_CODE && this.isAwaitingFinalization(pool, status)) {
        // A fresh activation checkpoint is often only `processed`: the finalized sweep cannot confirm
        // it yet. The pool stays uncovered but is retried every cycle without backoff.
        status.lastOutcome = 'AWAITING_FINALIZATION';
        errorCode = 'POOL_AWAITING_FINALIZATION';
      } else {
        status.lastOutcome = 'FAILED';
        if (BACKOFF_ERROR_CODES.has(errorCode)) {
          status.backoffLevel += 1;
          status.backoffRemaining = Math.min(2 ** (status.backoffLevel - 1), MAX_BACKOFF_CYCLES);
        }
      }
    }
    const completedAtMs = this.now();
    this.publishSweep({
      poolAddress: pool,
      outcome: status.lastOutcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
      startedAtMs,
      completedAtMs,
      durationMs: completedAtMs - startedAtMs,
      result,
      errorCode,
    });
  }

  private isAwaitingFinalization(pool: string, status: PoolStatus): boolean {
    const activatedAtMs = this.tracked.get(pool)?.activatedAtMs;
    return status.sweepsSucceeded === 0
      && activatedAtMs !== undefined
      && this.now() - activatedAtMs < this.finalizationGraceMs;
  }

  private publishSweep(report: PoolSweepReport): void {
    try {
      this.options.onSweep?.(Object.freeze(report));
    } catch {
      // Telemetry must never affect coverage.
    }
  }

  /**
   * Races `operation` against a sweepTimeoutMs timer from the injectable scheduler. On timeout the
   * result of `onTimeout` (or its throw) settles the race; the timer is always cancelled.
   */
  private bounded<T>(operation: Promise<T>, onTimeout: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const handle = this.scheduler.schedule(() => {
        if (settled) return;
        settled = true;
        try {
          resolve(onTimeout());
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }, this.sweepTimeoutMs);
      operation.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.scheduler.cancel(handle);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          this.scheduler.cancel(handle);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /** Bounds one refresh step; a timeout is a refresh failure coded MARKET_POOL_REFRESH_TIMEOUT. */
  private boundedRefresh<T>(step: Promise<T>): Promise<T> {
    return this.bounded(step, () => {
      // The abandoned step is left to settle on its own; never surface its late rejection.
      step.catch(() => undefined);
      throw new RefreshError(REFRESH_TIMEOUT_CODE);
    });
  }

  private publishCycle(droppedByCap: readonly TrackedPoolCandidate[], errorCodes: readonly string[]): void {
    try {
      this.options.onCycle?.(Object.freeze({
        coverageState: this.coverageState(),
        trackedPools: Object.freeze([...this.tracked.keys()]),
        droppedByCap: Object.freeze(droppedByCap.map((pool) => pool.poolAddress)),
        refreshFailed: this.refreshFailed,
        errorCodes: Object.freeze([...errorCodes]),
      }));
    } catch {
      // Telemetry must never affect coverage.
    }
  }

  // The next cycle is only scheduled once the current one has settled, so the loop never overlaps.
  private schedule(): void {
    if (this.closed) return;
    this.timer = this.scheduler.schedule(() => {
      this.timer = null;
      void this.runCycleForTest()
        .catch(() => { this.refreshFailed = true; })
        .finally(() => { this.schedule(); });
    }, this.options.intervalMs);
  }
}

function ownErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : null;
}

function readErrorCode(error: unknown): string {
  const code = ownErrorCode(error);
  if (code !== null) return code;
  if (typeof error === 'object' && error !== null) {
    const stage = (error as { readonly stage?: unknown }).stage;
    if (typeof stage === 'string' && /^[a-z-]{1,32}$/u.test(stage)) return `POOL_CATCH_UP_${stage.toUpperCase()}`;
  }
  return 'POOL_CATCH_UP_FAILED';
}
