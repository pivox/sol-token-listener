import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MarketPoolTracker,
  type MarketPoolCycleReport,
  type MarketPoolTrackerDependencies,
  type MarketPoolTrackerOptions,
  type PoolSweepReport,
} from '../src/application/market-pool-tracker.js';
import type { TrackedPoolCandidate } from '../src/application/market-pool-selection.js';
import {
  PoolCatchUpWindowExceededError,
  PoolCheckpointNotFoundError,
  type PoolSweepResult,
} from '../src/application/pool-catch-up-scanner.js';

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

function candidate(pool: string, ageHours = 1, engaged = false): TrackedPoolCandidate {
  return Object.freeze({
    poolAddress: pool, baseMint: `mint-${pool}`, engaged,
    activatedAtMs: NOW - ageHours * HOUR, activationSignature: `sig-${pool}`, activationSlot: 1n,
  });
}

function sweep(pool: string): PoolSweepResult {
  return Object.freeze({
    poolAddress: pool, checkpointSlotBefore: '1', checkpointSlotAfter: '2', pageCount: 1, probeCount: 1,
    signaturesRead: 1, signaturesEnqueued: 1, newestSlot: '2', oldestSlot: '2',
  });
}

interface ScheduledTimer { readonly callback: () => void; readonly delayMs: number; cancelled: boolean }

class ManualScheduler {
  public readonly timers: ScheduledTimer[] = [];
  schedule(callback: () => void, delayMs: number): unknown {
    const timer: ScheduledTimer = { callback, delayMs, cancelled: false };
    this.timers.push(timer);
    return timer;
  }
  cancel(handle: unknown): void { (handle as ScheduledTimer).cancelled = true; }
  /** Every timer ever scheduled with this delay (the loop never cancels a fired timer). */
  scheduled(delayMs: number): ScheduledTimer[] { return this.timers.filter((timer) => timer.delayMs === delayMs); }
  pending(delayMs: number): ScheduledTimer[] {
    return this.scheduled(delayMs).filter((timer) => !timer.cancelled);
  }
  get callbacks(): (() => void)[] { return this.scheduled(5_000).map((timer) => timer.callback); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness(options: {
  candidates: () => readonly TrackedPoolCandidate[];
  failingPools?: ReadonlySet<string>;
  maxPools?: number;
}) {
  const seeded: string[] = [];
  const synced: (readonly string[])[] = [];
  const healthy = new Set<string>();
  const reports: PoolSweepReport[] = [];
  const tracker = new MarketPoolTracker(
    {
      repository: {
        async listCandidates() { return options.candidates(); },
        async seedFromActivation(pool) { seeded.push(pool.poolAddress); },
      },
      scanner: {
        async scanPool(pool) {
          if (options.failingPools?.has(pool)) throw new PoolCatchUpWindowExceededError(pool, 20, 20_000);
          return sweep(pool);
        },
      },
      subscriber: {
        async sync(pools) { synced.push(pools); pools.forEach((pool) => healthy.add(pool)); },
        isHealthy: (pool) => healthy.has(pool),
        async close() {},
      },
    },
    {
      intervalMs: 5_000, windowMs: 6 * HOUR, maxPools: options.maxPools ?? 50,
      scheduler: new ManualScheduler(), now: () => NOW,
      onSweep: (report) => { reports.push(report); },
    },
  );
  return { tracker, seeded, synced, healthy, reports };
}

void test('start seeds, subscribes and sweeps every tracked pool, then reports HEALTHY', async () => {
  const { tracker, seeded, synced, reports } = harness({ candidates: () => [candidate('a'), candidate('b')] });
  await tracker.start();
  assert.deepEqual(seeded, ['a', 'b']);
  assert.deepEqual(synced, [['a', 'b']]);
  assert.deepEqual(reports.map((report) => [report.poolAddress, report.outcome]), [['a', 'SUCCEEDED'], ['b', 'SUCCEEDED']]);
  assert.equal(tracker.coverageState(), 'HEALTHY');
  await tracker.close();
});

void test('a failing pool is DEGRADED alone and only blocks its own mint', async () => {
  const { tracker, reports } = harness({
    candidates: () => [candidate('a'), candidate('b')],
    failingPools: new Set(['b']),
  });
  await tracker.start();
  assert.equal(tracker.coverageState(), 'DEGRADED');
  assert.equal(tracker.isMintCovered('mint-a'), true);
  assert.equal(tracker.isMintCovered('mint-b'), false);
  assert.equal(reports.find((report) => report.poolAddress === 'b')?.errorCode, 'CATCH_UP_WINDOW_EXCEEDED');
  await tracker.close();
});

void test('a mint without a tracked pool has no market requirement, a capped one is not covered', async () => {
  const { tracker } = harness({ candidates: () => [candidate('a', 1), candidate('b', 2)], maxPools: 1 });
  await tracker.start();
  assert.equal(tracker.isMintCovered('mint-bonding-curve'), true);
  assert.equal(tracker.isMintCovered('mint-b'), false);
  await tracker.close();
});

void test('no tracked pool is HEALTHY', async () => {
  const { tracker } = harness({ candidates: () => [] });
  await tracker.start();
  assert.equal(tracker.coverageState(), 'HEALTHY');
  await tracker.close();
});

void test('a refresh failure degrades coverage without throwing from start', async () => {
  const tracker = new MarketPoolTracker(
    {
      repository: {
        async listCandidates() { throw new Error('db down'); },
        async seedFromActivation() {},
      },
      scanner: { async scanPool(pool) { return sweep(pool); } },
      subscriber: { async sync() {}, isHealthy: () => true, async close() {} },
    },
    { intervalMs: 5_000, windowMs: 6 * HOUR, maxPools: 50, scheduler: new ManualScheduler(), now: () => NOW },
  );
  await tracker.start();
  assert.equal(tracker.coverageState(), 'DEGRADED');
  await tracker.close();
});

void test('a pool that leaves tracking is unsubscribed and forgotten', async () => {
  let pools = [candidate('a'), candidate('b')];
  const scheduler = new ManualScheduler();
  const synced: (readonly string[])[] = [];
  const tracker = new MarketPoolTracker(
    {
      repository: { async listCandidates() { return pools; }, async seedFromActivation() {} },
      scanner: { async scanPool(pool) { return sweep(pool); } },
      subscriber: { async sync(value) { synced.push(value); }, isHealthy: () => true, async close() {} },
    },
    { intervalMs: 5_000, windowMs: 6 * HOUR, maxPools: 50, scheduler, now: () => NOW },
  );
  await tracker.start();
  pools = [candidate('a')];
  await tracker.runCycleForTest();
  assert.deepEqual(synced.at(-1), ['a']);
  assert.equal(tracker.isMintCovered('mint-b'), true, 'b is no longer tracked, so no market requirement');
  await tracker.close();
});

void test('a seeding failure on one pool fails that pool only, without failing the refresh', async () => {
  const swept: string[] = [];
  const reports: PoolSweepReport[] = [];
  const cycles: boolean[] = [];
  const tracker = new MarketPoolTracker(
    {
      repository: {
        async listCandidates() { return [candidate('a'), candidate('b')]; },
        async seedFromActivation(pool) { if (pool.poolAddress === 'b') throw new Error('insert failed'); },
      },
      scanner: { async scanPool(pool) { swept.push(pool); return sweep(pool); } },
      subscriber: { async sync() {}, isHealthy: () => true, async close() {} },
    },
    {
      intervalMs: 5_000, windowMs: 6 * HOUR, maxPools: 50, scheduler: new ManualScheduler(), now: () => NOW,
      onSweep: (report) => { reports.push(report); },
      onCycle: (report) => { cycles.push(report.refreshFailed); },
    },
  );
  await tracker.start();
  assert.deepEqual(swept, ['a']);
  assert.deepEqual(cycles, [false]);
  const failed = reports.find((report) => report.poolAddress === 'b');
  assert.equal(failed?.outcome, 'FAILED');
  assert.equal(failed?.errorCode, 'POOL_CHECKPOINT_SEED_FAILED');
  assert.equal(failed?.result, null);
  assert.equal(tracker.isMintCovered('mint-a'), true);
  assert.equal(tracker.isMintCovered('mint-b'), false);
  assert.equal(tracker.coverageState(), 'DEGRADED');
  await tracker.close();
});

void test('a subscriber sync failure degrades coverage for the cycle', async () => {
  const cycles: boolean[] = [];
  let failSync = true;
  const tracker = new MarketPoolTracker(
    {
      repository: { async listCandidates() { return [candidate('a')]; }, async seedFromActivation() {} },
      scanner: { async scanPool(pool) { return sweep(pool); } },
      subscriber: {
        async sync() { if (failSync) throw new Error('ws down'); },
        isHealthy: () => true,
        async close() {},
      },
    },
    {
      intervalMs: 5_000, windowMs: 6 * HOUR, maxPools: 50, scheduler: new ManualScheduler(), now: () => NOW,
      onCycle: (report) => { cycles.push(report.refreshFailed); },
    },
  );
  await tracker.start();
  assert.equal(tracker.coverageState(), 'DEGRADED');
  failSync = false;
  await tracker.runCycleForTest();
  assert.equal(tracker.coverageState(), 'HEALTHY');
  assert.deepEqual(cycles, [true, false]);
  await tracker.close();
});

void test('close is safe before start and idempotent', async () => {
  let closes = 0;
  let lists = 0;
  const scheduler = new ManualScheduler();
  const tracker = new MarketPoolTracker(
    {
      repository: { async listCandidates() { lists += 1; return []; }, async seedFromActivation() {} },
      scanner: { async scanPool(pool) { return sweep(pool); } },
      subscriber: { async sync() {}, isHealthy: () => true, async close() { closes += 1; } },
    },
    { intervalMs: 5_000, windowMs: 6 * HOUR, maxPools: 50, scheduler, now: () => NOW },
  );
  await tracker.close();
  await tracker.close();
  await Promise.all([tracker.close(), tracker.close()]);
  assert.equal(closes, 1);
  await tracker.start();
  assert.equal(lists, 0, 'a closed tracker never refreshes');
  assert.equal(scheduler.callbacks.length, 0, 'a closed tracker never schedules');
});

void test('the scheduled loop never runs two cycles concurrently', async () => {
  let lists = 0;
  let active = 0;
  let maxActive = 0;
  let release: (() => void) | null = null;
  let block = false;
  const scheduler = new ManualScheduler();
  const tracker = new MarketPoolTracker(
    {
      repository: { async listCandidates() { lists += 1; return [candidate('a')]; }, async seedFromActivation() {} },
      scanner: {
        async scanPool(pool) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (block) await new Promise<void>((resolve) => { release = resolve; });
          active -= 1;
          return sweep(pool);
        },
      },
      subscriber: { async sync() {}, isHealthy: () => true, async close() {} },
    },
    { intervalMs: 5_000, windowMs: 6 * HOUR, maxPools: 50, scheduler, now: () => NOW },
  );
  await tracker.start();
  assert.equal(scheduler.callbacks.length, 1);
  block = true;
  scheduler.callbacks[0]?.();
  const concurrent = tracker.runCycleForTest();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lists, 2, 'the concurrent request joins the in-flight cycle');
  assert.equal(scheduler.callbacks.length, 1, 'the next cycle is scheduled only after the current one ends');
  assert.notEqual(release, null);
  (release as unknown as () => void)();
  await concurrent;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxActive, 1);
  assert.equal(scheduler.callbacks.length, 2);
  await tracker.close();
});

const TIMEOUT = 30_000;

function build(
  overrides: {
    readonly repository?: Partial<MarketPoolTrackerDependencies['repository']>;
    readonly scanner?: MarketPoolTrackerDependencies['scanner'];
    readonly subscriber?: Partial<MarketPoolTrackerDependencies['subscriber']>;
    readonly candidates?: () => readonly TrackedPoolCandidate[];
  },
  options: Partial<MarketPoolTrackerOptions> = {},
) {
  const scheduler = new ManualScheduler();
  const clock = { now: NOW };
  const sweeps: PoolSweepReport[] = [];
  const cycles: MarketPoolCycleReport[] = [];
  let closes = 0;
  const tracker = new MarketPoolTracker(
    {
      repository: {
        async listCandidates() { return overrides.candidates?.() ?? [candidate('a')]; },
        async seedFromActivation() {},
        ...overrides.repository,
      },
      scanner: overrides.scanner ?? { async scanPool(pool) { return sweep(pool); } },
      subscriber: {
        async sync() {},
        isHealthy: () => true,
        async close() { closes += 1; },
        ...overrides.subscriber,
      },
    },
    {
      intervalMs: 5_000, windowMs: 6 * HOUR, maxPools: 50, scheduler, now: () => clock.now,
      onSweep: (report) => { sweeps.push(report); },
      onCycle: (report) => { cycles.push(report); },
      ...options,
    },
  );
  return { tracker, scheduler, clock, sweeps, cycles, closes: () => closes };
}

void test('fails closed before start: no mint is covered and coverage is WARMING_UP', () => {
  const { tracker } = build({});
  assert.equal(tracker.isMintCovered('mint-a'), false);
  assert.equal(tracker.isMintCovered('mint-bonding-curve'), false);
  assert.equal(tracker.coverageState(), 'WARMING_UP');
});

void test('fails closed while the first refresh is in flight', async () => {
  const list = deferred<readonly TrackedPoolCandidate[]>();
  const { tracker } = build({ repository: { listCandidates: () => list.promise } });
  const started = tracker.start();
  await tick();
  assert.equal(tracker.isMintCovered('mint-bonding-curve'), false);
  assert.equal(tracker.isMintCovered('mint-a'), false);
  assert.equal(tracker.coverageState(), 'WARMING_UP');
  list.resolve([candidate('a')]);
  await started;
  assert.equal(tracker.isMintCovered('mint-bonding-curve'), true);
  assert.equal(tracker.isMintCovered('mint-a'), true);
  assert.equal(tracker.coverageState(), 'HEALTHY');
  await tracker.close();
});

void test('fails closed while the first sweep is in flight', async () => {
  const scan = deferred<PoolSweepResult>();
  const { tracker } = build({ scanner: { scanPool: () => scan.promise } });
  const started = tracker.start();
  await tick();
  assert.equal(tracker.isMintCovered('mint-bonding-curve'), false);
  assert.equal(tracker.isMintCovered('mint-a'), false);
  assert.equal(tracker.coverageState(), 'WARMING_UP');
  scan.resolve(sweep('a'));
  await started;
  assert.equal(tracker.isMintCovered('mint-bonding-curve'), true);
  assert.equal(tracker.coverageState(), 'HEALTHY');
  await tracker.close();
});

void test('database down at boot: no mint is covered and coverage is DEGRADED', async () => {
  const { tracker, cycles } = build({ repository: { async listCandidates() { throw new Error('db down'); } } });
  await tracker.start();
  assert.equal(tracker.isMintCovered('mint-anything'), false);
  assert.equal(tracker.coverageState(), 'DEGRADED');
  assert.deepEqual(cycles.at(-1)?.errorCodes, ['MARKET_POOL_REFRESH_FAILED']);
  await tracker.close();
});

void test('a failed refresh fails every mint closed until a refresh succeeds again', async () => {
  let failSync = false;
  const { tracker, cycles } = build({
    subscriber: {
      async sync() {
        if (failSync) throw Object.assign(new Error('ws down'), { code: 'WS_DOWN' });
      },
    },
  });
  await tracker.start();
  assert.equal(tracker.isMintCovered('mint-a'), true);
  assert.deepEqual(cycles.at(-1)?.errorCodes, []);
  failSync = true;
  await tracker.runCycleForTest();
  assert.equal(tracker.isMintCovered('mint-a'), false);
  assert.equal(tracker.isMintCovered('mint-bonding-curve'), false);
  assert.equal(tracker.coverageState(), 'DEGRADED');
  assert.deepEqual(cycles.at(-1)?.errorCodes, ['WS_DOWN']);
  failSync = false;
  await tracker.runCycleForTest();
  assert.equal(tracker.isMintCovered('mint-a'), true);
  assert.equal(tracker.isMintCovered('mint-bonding-curve'), true);
  await tracker.close();
});

void test('a sync failure without a usable code reports MARKET_POOL_SYNC_FAILED', async () => {
  const { tracker, cycles } = build({ subscriber: { async sync() { throw new Error('ws down'); } } });
  await tracker.start();
  assert.deepEqual(cycles.at(-1)?.errorCodes, ['MARKET_POOL_SYNC_FAILED']);
  await tracker.close();
});

void test('without a cycle completed within maxStalenessMs a mint is no longer covered until the next cycle', async () => {
  const { tracker, clock } = build({}, { maxStalenessMs: 20_000 });
  await tracker.start();
  assert.equal(tracker.isMintCovered('mint-a'), true);
  clock.now = NOW + 20_000;
  assert.equal(tracker.isMintCovered('mint-a'), true, 'exactly at the bound is still fresh');
  assert.equal(tracker.coverageState(), 'HEALTHY');
  clock.now = NOW + 20_001;
  assert.equal(tracker.isMintCovered('mint-a'), false);
  assert.equal(tracker.coverageState(), 'DEGRADED');
  await tracker.runCycleForTest();
  assert.equal(tracker.isMintCovered('mint-a'), true);
  await tracker.close();
});

void test('default maxStalenessMs is 3 * intervalMs + sweepTimeoutMs', async () => {
  const { tracker, clock } = build({}, { sweepTimeoutMs: 1_000 });
  await tracker.start();
  clock.now = NOW + 16_000;
  assert.equal(tracker.isMintCovered('mint-a'), true);
  clock.now = NOW + 16_001;
  assert.equal(tracker.isMintCovered('mint-a'), false);
  await tracker.close();
});

void test('a hanging sweep times out as POOL_SWEEP_TIMEOUT and the next pool is still swept', async () => {
  const swept: string[] = [];
  let lateRejection: ((error: unknown) => void) | null = null;
  const { tracker, scheduler, sweeps } = build({
    candidates: () => [candidate('a', 1), candidate('b', 2)],
    scanner: {
      scanPool(pool) {
        swept.push(pool);
        if (pool === 'a') return new Promise<PoolSweepResult>((_resolve, reject) => { lateRejection = reject; });
        return Promise.resolve(sweep(pool));
      },
    },
  });
  const started = tracker.start();
  await tick();
  const timers = scheduler.pending(TIMEOUT);
  assert.equal(timers.length, 1);
  timers[0]?.callback();
  await started;
  assert.deepEqual(swept, ['a', 'b']);
  const timedOut = sweeps.find((report) => report.poolAddress === 'a');
  assert.equal(timedOut?.outcome, 'FAILED');
  assert.equal(timedOut?.errorCode, 'POOL_SWEEP_TIMEOUT');
  assert.equal(sweeps.find((report) => report.poolAddress === 'b')?.outcome, 'SUCCEEDED');
  assert.equal(tracker.isMintCovered('mint-a'), false);
  assert.equal(tracker.isMintCovered('mint-b'), true);
  assert.deepEqual(
    scheduler.pending(TIMEOUT).filter((timer) => timer !== timers[0]),
    [],
    'the timer of the sweep that settled in time is cancelled',
  );
  (lateRejection as unknown as (error: unknown) => void)(new Error('late'));
  await tick();
  await tracker.close();
});

void test('close() with a hung cycle resolves within sweepTimeoutMs and closes the subscriber', async () => {
  const list = deferred<readonly TrackedPoolCandidate[]>();
  const { tracker, scheduler, closes } = build({ repository: { listCandidates: () => list.promise } });
  void tracker.start();
  await tick();
  let closed = false;
  const closing = tracker.close().then(() => { closed = true; });
  await tick();
  assert.equal(closed, false);
  // Fire only the close bound (scheduled last), not the refresh bound, to prove close() is bounded itself.
  scheduler.pending(TIMEOUT).at(-1)?.callback();
  await closing;
  assert.equal(closes(), 1);
  assert.equal(tracker.isMintCovered('mint-a'), false);
});

void test('a cycle interrupted by close still publishes its report', async () => {
  const scan = deferred<PoolSweepResult>();
  const { tracker, cycles } = build({
    candidates: () => [candidate('a', 1), candidate('b', 2)],
    scanner: { scanPool: (pool) => (pool === 'a' ? scan.promise : Promise.resolve(sweep(pool))) },
  });
  const started = tracker.start();
  await tick();
  const closing = tracker.close();
  scan.resolve(sweep('a'));
  await started;
  await closing;
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0]?.trackedPools, ['a', 'b']);
});

void test('a mint with two tracked pools is covered only when both are covered', async () => {
  const second = Object.freeze({ ...candidate('b'), baseMint: 'mint-a' });
  let failing = true;
  const { tracker } = build({
    candidates: () => [candidate('a'), second],
    scanner: {
      async scanPool(pool) {
        if (pool === 'b' && failing) throw new Error('rpc');
        return sweep(pool);
      },
    },
  });
  await tracker.start();
  assert.equal(tracker.isMintCovered('mint-a'), false);
  failing = false;
  await tracker.runCycleForTest();
  assert.equal(tracker.isMintCovered('mint-a'), true);
  await tracker.close();
});

void test('a mint with one tracked and one capped pool is not covered', async () => {
  const capped = Object.freeze({ ...candidate('b', 3), baseMint: 'mint-a' });
  const { tracker } = build({ candidates: () => [candidate('a', 1), capped] }, { maxPools: 1 });
  await tracker.start();
  assert.equal(tracker.isMintCovered('mint-a'), false);
  await tracker.close();
});

void test('start() twice runs one loop', async () => {
  let lists = 0;
  const { tracker, scheduler } = build({ repository: { async listCandidates() { lists += 1; return []; } } });
  await Promise.all([tracker.start(), tracker.start()]);
  await tracker.start();
  assert.equal(lists, 1);
  assert.equal(scheduler.scheduled(5_000).length, 1);
  await tracker.close();
});

void test('the constructor rejects invalid options', () => {
  const invalid: Partial<MarketPoolTrackerOptions>[] = [
    { windowMs: -1 }, { windowMs: 1.5 }, { windowMs: Number.NaN },
    { maxPools: 0 }, { maxPools: 2.5 },
    { sweepTimeoutMs: 0 }, { sweepTimeoutMs: 1.5 },
    { maxStalenessMs: 4_999 }, { maxStalenessMs: Number.POSITIVE_INFINITY },
    { finalizationGraceMs: -1 }, { finalizationGraceMs: 1.5 },
  ];
  for (const options of invalid) {
    assert.throws(() => build({}, options), TypeError, JSON.stringify(options));
  }
  assert.doesNotThrow(() => build({}, {
    windowMs: 0, maxPools: 1, sweepTimeoutMs: 1, maxStalenessMs: 5_000, finalizationGraceMs: 0,
  }));
});

async function expectRefreshTimeout(hang: 'list' | 'seed' | 'sync') {
  let hung = true;
  const never = () => new Promise<never>(() => undefined);
  const { tracker, scheduler, cycles } = build({
    repository: {
      listCandidates: () => (hang === 'list' && hung ? never() : Promise.resolve([candidate('a')])),
      seedFromActivation: () => (hang === 'seed' && hung ? never() : Promise.resolve()),
    },
    subscriber: { sync: () => (hang === 'sync' && hung ? never() : Promise.resolve()) },
  });
  const started = tracker.start();
  await tick();
  const timers = scheduler.pending(TIMEOUT);
  assert.equal(timers.length, 1, 'the hung refresh step is bounded');
  timers[0]?.callback();
  await started;
  assert.equal(tracker.coverageState(), 'DEGRADED');
  assert.equal(tracker.isMintCovered('mint-a'), false);
  assert.equal(tracker.isMintCovered('mint-bonding-curve'), false);
  assert.deepEqual(cycles.at(-1)?.errorCodes, ['MARKET_POOL_REFRESH_TIMEOUT']);
  assert.equal(cycles.at(-1)?.refreshFailed, true);
  assert.equal(scheduler.pending(5_000).length, 1, 'the loop keeps scheduling');
  hung = false;
  scheduler.pending(5_000)[0]?.callback();
  await tick();
  await tick();
  assert.equal(tracker.coverageState(), 'HEALTHY');
  assert.equal(tracker.isMintCovered('mint-a'), true);
  assert.deepEqual(cycles.at(-1)?.errorCodes, []);
  await tracker.close();
}

void test('a hung listCandidates times out as a refresh failure and the next cycle recovers', async () => {
  await expectRefreshTimeout('list');
});

void test('a hung seed times out as a refresh failure and the next cycle recovers', async () => {
  await expectRefreshTimeout('seed');
});

void test('a hung subscriber sync times out as a refresh failure and the next cycle recovers', async () => {
  await expectRefreshTimeout('sync');
});

function windowExceeded(pool: string): Error {
  return new PoolCatchUpWindowExceededError(pool, 20, 20_000);
}

function checkpointNotFound(pool: string): Error {
  return new PoolCheckpointNotFoundError(pool, 1, 0);
}

/** Runs `cycles` cycles and returns, per cycle, whether scanPool was called for `pool`. */
async function scannedPerCycle(
  tracker: MarketPoolTracker,
  calls: string[],
  pool: string,
  cycles: number,
): Promise<boolean[]> {
  const scanned: boolean[] = [];
  for (let index = 0; index < cycles; index += 1) {
    const before = calls.filter((value) => value === pool).length;
    await tracker.runCycleForTest();
    scanned.push(calls.filter((value) => value === pool).length > before);
  }
  return scanned;
}

void test('a window-exceeded pool backs off 1, 2, 4 cycles without calling scanPool, then resets on success', async () => {
  const calls: string[] = [];
  let failing = true;
  const { tracker, sweeps } = build({
    candidates: () => [candidate('a'), candidate('b', 2)],
    scanner: {
      async scanPool(pool) {
        calls.push(pool);
        if (pool === 'a' && failing) throw windowExceeded(pool);
        return sweep(pool);
      },
    },
  });
  await tracker.start();
  assert.equal(sweeps.at(-2)?.errorCode, 'CATCH_UP_WINDOW_EXCEEDED');
  // Cycle 1 (start) scanned and failed: skip 1, scan, skip 2, scan, skip 4, scan.
  const scanned = await scannedPerCycle(tracker, calls, 'a', 10);
  assert.deepEqual(scanned, [false, true, false, false, true, false, false, false, false, true]);
  assert.equal(calls.filter((pool) => pool === 'b').length, 11, 'other pools are swept every cycle');
  const skipped = sweeps.filter((report) => report.poolAddress === 'a' && report.errorCode === 'POOL_SWEEP_BACKOFF');
  assert.equal(skipped.length, 7);
  for (const report of skipped) {
    assert.equal(report.outcome, 'FAILED');
    assert.equal(report.result, null);
  }
  assert.equal(tracker.isMintCovered('mint-a'), false, 'a backing-off pool stays uncovered');
  assert.equal(tracker.isMintCovered('mint-b'), true);
  assert.equal(tracker.coverageState(), 'DEGRADED');
  // Cycle 12 is the next scan (skip 8 pending after cycle 11): let it succeed after the skips.
  failing = false;
  const afterRecovery = await scannedPerCycle(tracker, calls, 'a', 9);
  assert.deepEqual(afterRecovery, [false, false, false, false, false, false, false, false, true]);
  assert.equal(tracker.isMintCovered('mint-a'), true);
  assert.equal(tracker.coverageState(), 'HEALTHY');
  failing = true;
  assert.deepEqual(await scannedPerCycle(tracker, calls, 'a', 3), [true, false, true], 'success reset the schedule');
  await tracker.close();
});

void test('the backoff is capped at 64 cycles', async () => {
  const calls: string[] = [];
  const { tracker } = build({
    scanner: { async scanPool(pool) { calls.push(pool); throw windowExceeded(pool); } },
  });
  await tracker.start();
  const scanned = await scannedPerCycle(tracker, calls, 'a', 1 + 2 + 4 + 8 + 16 + 32 + 64 + 64 + 8);
  const gaps: number[] = [];
  let gap = 0;
  for (const value of scanned) {
    if (value) {
      gaps.push(gap);
      gap = 0;
    } else {
      gap += 1;
    }
  }
  assert.deepEqual(gaps, [1, 2, 4, 8, 16, 32, 64, 64]);
  await tracker.close();
});

void test('POOL_CHECKPOINT_NOT_FOUND on an old pool is FAILED and backs off', async () => {
  const calls: string[] = [];
  const { tracker, sweeps } = build({
    scanner: { async scanPool(pool) { calls.push(pool); throw checkpointNotFound(pool); } },
  });
  await tracker.start();
  assert.equal(sweeps.at(-1)?.errorCode, 'POOL_CHECKPOINT_NOT_FOUND');
  assert.equal(tracker.coverageState(), 'DEGRADED');
  assert.deepEqual(await scannedPerCycle(tracker, calls, 'a', 2), [false, true]);
  assert.equal(sweeps.at(-2)?.errorCode, 'POOL_SWEEP_BACKOFF');
  await tracker.close();
});

void test('a fresh migration awaiting finalization is uncovered without degrading coverage, then FAILED after the grace', async () => {
  const calls: string[] = [];
  const young = Object.freeze({ ...candidate('a'), activatedAtMs: NOW - 10_000 });
  const { tracker, sweeps, clock } = build({
    candidates: () => [young, candidate('b', 2)],
    scanner: {
      async scanPool(pool) {
        calls.push(pool);
        if (pool === 'a') throw checkpointNotFound(pool);
        return sweep(pool);
      },
    },
  });
  await tracker.start();
  const awaiting = sweeps.find((report) => report.poolAddress === 'a');
  assert.equal(awaiting?.outcome, 'FAILED');
  assert.equal(awaiting?.errorCode, 'POOL_AWAITING_FINALIZATION');
  assert.equal(tracker.isMintCovered('mint-a'), false);
  assert.equal(tracker.isMintCovered('mint-b'), true);
  assert.equal(tracker.coverageState(), 'HEALTHY');
  clock.now = NOW + 79_999;
  assert.deepEqual(await scannedPerCycle(tracker, calls, 'a', 1), [true], 'no backoff while awaiting finalization');
  assert.equal(sweeps.at(-2)?.errorCode, 'POOL_AWAITING_FINALIZATION');
  assert.equal(tracker.coverageState(), 'HEALTHY');
  clock.now = NOW + 80_000;
  assert.deepEqual(await scannedPerCycle(tracker, calls, 'a', 1), [true]);
  assert.equal(sweeps.at(-2)?.errorCode, 'POOL_CHECKPOINT_NOT_FOUND');
  assert.equal(tracker.isMintCovered('mint-a'), false);
  assert.equal(tracker.coverageState(), 'DEGRADED');
  assert.deepEqual(await scannedPerCycle(tracker, calls, 'a', 1), [false], 'past the grace the pool backs off');
  await tracker.close();
});

void test('the finalization grace only applies to pools that never succeeded', async () => {
  let failing = false;
  const young = Object.freeze({ ...candidate('a'), activatedAtMs: NOW - 1_000 });
  const { tracker, sweeps } = build({
    candidates: () => [young],
    scanner: {
      async scanPool(pool) {
        if (failing) throw checkpointNotFound(pool);
        return sweep(pool);
      },
    },
  });
  await tracker.start();
  failing = true;
  await tracker.runCycleForTest();
  assert.equal(sweeps.at(-1)?.errorCode, 'POOL_CHECKPOINT_NOT_FOUND');
  assert.equal(tracker.coverageState(), 'DEGRADED');
  await tracker.close();
});

void test('a pool still WARMING_UP keeps the global state WARMING_UP while an awaiting pool does not', async () => {
  const young = Object.freeze({ ...candidate('a'), activatedAtMs: NOW - 10_000 });
  const scan = deferred<PoolSweepResult>();
  let second = false;
  const { tracker } = build({
    candidates: () => (second ? [young, candidate('b', 2)] : [young]),
    scanner: {
      scanPool(pool) {
        if (pool === 'a') return Promise.reject(checkpointNotFound(pool));
        return scan.promise;
      },
    },
  });
  await tracker.start();
  assert.equal(tracker.coverageState(), 'HEALTHY');
  second = true;
  const cycle = tracker.runCycleForTest();
  await tick();
  assert.equal(tracker.coverageState(), 'WARMING_UP');
  scan.resolve(sweep('b'));
  await cycle;
  assert.equal(tracker.coverageState(), 'HEALTHY');
  await tracker.close();
});

void test('a hanging pool lengthening the cycle does not make the other pools stale', async () => {
  const hangs = new Map<string, (error: unknown) => void>();
  const hanging = new Set(['c']);
  const { tracker, scheduler, clock } = build({
    // Sweep order follows recency: a, b, c.
    candidates: () => [candidate('a', 1), candidate('b', 2), candidate('c', 3)],
    scanner: {
      scanPool(pool) {
        if (hanging.has(pool)) {
          return new Promise<PoolSweepResult>((_resolve, reject) => { hangs.set(pool, reject); });
        }
        return Promise.resolve(sweep(pool));
      },
    },
  });
  const started = tracker.start();
  await tick();
  clock.now = NOW + TIMEOUT;
  scheduler.pending(TIMEOUT)[0]?.callback();
  await started;
  hangs.get('c')?.(new Error('late'));
  await tick();
  assert.equal(tracker.isMintCovered('mint-b'), true);
  hanging.delete('c');
  // Next cycle: a hangs first; b's last success (at NOW) is older than maxStalenessMs (45 s) but it
  // succeeded in the previous completed cycle and the loop completed a cycle 20 s ago.
  hanging.add('a');
  clock.now = NOW + TIMEOUT + 5_000;
  const second = tracker.runCycleForTest();
  await tick();
  clock.now = NOW + 50_000;
  assert.equal(tracker.isMintCovered('mint-b'), true, 'a healthy pool is not made stale by a slow one');
  assert.equal(tracker.isMintCovered('mint-a'), true, 'a was covered by the previous cycle');
  assert.equal(tracker.isMintCovered('mint-c'), false);
  scheduler.pending(TIMEOUT).at(-1)?.callback();
  await second;
  assert.equal(tracker.isMintCovered('mint-a'), false);
  assert.equal(tracker.isMintCovered('mint-b'), true);
  hangs.get('a')?.(new Error('late'));
  await tick();
  await tracker.close();
});

void test('a loop that has not completed a cycle within maxStalenessMs covers nothing', async () => {
  const { tracker, clock } = build({});
  await tracker.start();
  clock.now = NOW + 45_000;
  assert.equal(tracker.isMintCovered('mint-a'), true);
  assert.equal(tracker.isMintCovered('mint-bonding-curve'), true);
  clock.now = NOW + 45_001;
  assert.equal(tracker.isMintCovered('mint-a'), false);
  assert.equal(tracker.isMintCovered('mint-bonding-curve'), false, 'a stuck loop fails every mint closed');
  assert.equal(tracker.coverageState(), 'DEGRADED');
  await tracker.close();
});

void test('a timed-out scan still running is not started again until it settles', async () => {
  const calls: string[] = [];
  let reject: ((error: unknown) => void) | null = null;
  let hang = true;
  const { tracker, scheduler, sweeps } = build({
    scanner: {
      scanPool(pool) {
        calls.push(pool);
        if (hang) return new Promise<PoolSweepResult>((_resolve, onReject) => { reject = onReject; });
        return Promise.resolve(sweep(pool));
      },
    },
  });
  const started = tracker.start();
  await tick();
  scheduler.pending(TIMEOUT)[0]?.callback();
  await started;
  assert.equal(sweeps.at(-1)?.errorCode, 'POOL_SWEEP_TIMEOUT');
  hang = false;
  await tracker.runCycleForTest();
  assert.equal(calls.length, 1, 'no second concurrent scan of the same pool');
  assert.equal(sweeps.at(-1)?.outcome, 'FAILED');
  assert.equal(sweeps.at(-1)?.errorCode, 'POOL_SWEEP_STILL_RUNNING');
  assert.equal(tracker.isMintCovered('mint-a'), false);
  (reject as unknown as (error: unknown) => void)(new Error('late'));
  await tick();
  await tracker.runCycleForTest();
  assert.equal(calls.length, 2);
  assert.equal(sweeps.at(-1)?.outcome, 'SUCCEEDED');
  assert.equal(tracker.isMintCovered('mint-a'), true);
  await tracker.close();
});
