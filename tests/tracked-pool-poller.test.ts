import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicKey } from '@solana/web3.js';
import {
  TrackedPoolPoller,
  type TrackedPoolPollerOptions,
  type TrackedPoolCycleReport,
  type TrackedPoolReport,
} from '../src/application/tracked-pool-poller.js';
import type { TransactionNotification } from '../src/domain/transaction-ingestion.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import type { PoolCheckpoint, TrackedPool } from '../src/storage/tracked-pool.repository.js';

const POOL_A = '11111111111111111111111111111111';
const POOL_B = 'SysvarRent111111111111111111111111111111111';
const MINT_A = 'MintA111111111111111111111111111111111111111';
const MINT_B = 'MintB111111111111111111111111111111111111111';
const NOW = 1_700_000_000_000;

interface RpcOptions {
  readonly before?: string | undefined;
  readonly until?: string | undefined;
  readonly limit: number;
}

type PoolScript = (options: RpcOptions) => unknown[];

function row(signature: string, slot: number): Record<string, unknown> {
  return { signature, slot, confirmationStatus: 'finalized', blockTime: null, err: null };
}

function rows(prefix: string, count: number, topSlot: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => row(`${prefix}-${index}`, topSlot - index));
}

function trackedPool(poolAddress: string, baseMint: string): TrackedPool {
  return { poolAddress, baseMint, activationSignature: `act-${poolAddress}`, activationSlot: 100n };
}

function harness(
  pools: TrackedPool[],
  scripts: Record<string, PoolScript>,
  extra: Partial<TrackedPoolPollerOptions> = {},
) {
  const checkpoints = new Map<string, PoolCheckpoint>();
  const seeded: string[] = [];
  const stored: { pool: string; value: PoolCheckpoint }[] = [];
  const enqueued: TransactionNotification[] = [];
  const calls: { pool: string; options: RpcOptions }[] = [];
  const scheduled: { callback: () => void; delayMs: number; handle: number }[] = [];
  const cancelled: unknown[] = [];
  const cycles: TrackedPoolCycleReport[] = [];
  const poolReports: TrackedPoolReport[] = [];
  const state = {
    listError: null as Error | null,
    listGate: null as Promise<void> | null,
    rpcError: new Set<string>(),
  };
  const repository = {
    listTrackedPools: async (_window: number): Promise<readonly TrackedPool[]> => {
      if (state.listGate !== null) await state.listGate;
      if (state.listError !== null) throw state.listError;
      return pools;
    },
    readCheckpoint: (pool: string): Promise<PoolCheckpoint | null> =>
      Promise.resolve(checkpoints.get(pool) ?? null),
    seedCheckpoint: (target: TrackedPool, value: PoolCheckpoint): Promise<void> => {
      seeded.push(target.poolAddress);
      if (!checkpoints.has(target.poolAddress)) checkpoints.set(target.poolAddress, value);
      return Promise.resolve();
    },
    storeCheckpoint: (pool: string, value: PoolCheckpoint): Promise<void> => {
      stored.push({ pool, value });
      checkpoints.set(pool, value);
      return Promise.resolve();
    },
  };
  const rpc = {
    getSignaturesForAddress: (address: PublicKey, options: RpcOptions, commitment: string) => {
      assert.equal(commitment, 'finalized');
      const pool = address.toBase58();
      calls.push({ pool, options });
      if (state.rpcError.has(pool)) return Promise.reject(new Error('boom'));
      const script = scripts[pool];
      if (script === undefined) throw new Error('unexpected pool');
      return Promise.resolve(script(options));
    },
  };
  let nextHandle = 1;
  const scheduler = {
    schedule: (callback: () => void, delayMs: number) => {
      const handle = nextHandle;
      nextHandle += 1;
      scheduled.push({ callback, delayMs, handle });
      return handle;
    },
    cancel: (handle: unknown) => {
      cancelled.push(handle);
      const index = scheduled.findIndex((entry) => entry.handle === handle);
      if (index !== -1) scheduled.splice(index, 1);
    },
  };
  const poller = new TrackedPoolPoller({
    repository,
    inbox: { enqueue: (value: TransactionNotification) => { enqueued.push(value); return Promise.resolve(); } },
    rpc,
    intervalMs: 10_000,
    trackingWindowSeconds: 3_600,
    shutdownTimeoutMs: 1_000,
    scheduler,
    now: () => NOW,
    onCycle: (report) => { cycles.push(report); },
    onPool: (report) => { poolReports.push(report); },
    ...extra,
  });
  async function tick(): Promise<void> {
    const task = scheduled.pop();
    assert.ok(task !== undefined, 'a cycle is scheduled');
    task.callback();
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  return {
    poller, checkpoints, seeded, stored, enqueued, calls, scheduled, cancelled,
    cycles, poolReports, state, tick,
  };
}

/** Script answering pages from `history` (newest first) with `until` honoured. */
function historyScript(history: Record<string, unknown>[]): PoolScript {
  return (options) => {
    let start = 0;
    if (options.before !== undefined) {
      start = history.findIndex((entry) => entry.signature === options.before) + 1;
    }
    const result: unknown[] = [];
    for (let index = start; index < history.length && result.length < options.limit; index += 1) {
      const entry = history[index];
      if (entry === undefined) break;
      if (options.until !== undefined && entry.signature === options.until) break;
      result.push(entry);
    }
    return result;
  };
}

void test('a pool without checkpoint is seeded from its activation, then polled', async () => {
  const h = harness([trackedPool(POOL_A, MINT_A)], {
    [POOL_A]: historyScript([row('t1', 120), row(`act-${POOL_A}`, 100)]),
  });
  await h.poller.start();
  assert.deepEqual(h.seeded, [POOL_A]);
  assert.equal(h.calls[0]?.options.until, `act-${POOL_A}`);
  assert.deepEqual(h.enqueued.map((entry) => entry.signature), ['t1']);
  assert.deepEqual(h.checkpoints.get(POOL_A), { signature: 't1', slot: 120n });
});

void test('the poller enqueues with the configured hint and program', async () => {
  const h = harness([trackedPool(POOL_A, MINT_A)], {
    [POOL_A]: historyScript([row('s2', 102), row('s1', 101), row(`act-${POOL_A}`, 100)]),
  }, { ingestionHint: 'PUMPFUN_CURVE_TRADE', programId: PUMP_PROGRAM_ID });
  await h.poller.start();
  assert.deepEqual(h.enqueued.map((value) => [value.ingestionHint, value.programIds[0]]), [
    ['PUMPFUN_CURVE_TRADE', PUMP_PROGRAM_ID], ['PUMPFUN_CURVE_TRADE', PUMP_PROGRAM_ID],
  ]);
});

void test('an idle pool reads one empty page and one probe and changes nothing', async () => {
  const h = harness([trackedPool(POOL_A, MINT_A)], {
    [POOL_A]: historyScript([row('cp', 150)]),
  });
  h.checkpoints.set(POOL_A, { signature: 'cp', slot: 150n });
  await h.poller.start();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1]?.options, { before: undefined, limit: 1 });
  assert.equal(h.enqueued.length, 0);
  assert.equal(h.stored.length, 0);
  assert.equal(h.cycles[0]?.succeeded, 1);
  assert.equal(h.cycles[0]?.tracked, 1);
});

void test('two full pages then a short page enqueue every signature and advance', async () => {
  const history = [...rows('s', 2_500, 10_000), row('cp', 1_000)];
  const h = harness([trackedPool(POOL_A, MINT_A)], { [POOL_A]: historyScript(history) });
  h.checkpoints.set(POOL_A, { signature: 'cp', slot: 1_000n });
  await h.poller.start();
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.calls[3]?.options, { before: 's-2499', limit: 1 });
  assert.equal(h.enqueued.length, 2_500);
  assert.deepEqual(h.enqueued[0], {
    signature: 's-0', slot: 10_000n, source: 'CATCH_UP', ingestionHint: 'PUMPSWAP_POOL_TRADE',
    ingestionHintMint: MINT_A, programIds: [PUMPSWAP_PROGRAM_ID],
    confirmationStatus: 'finalized', observedAtMs: NOW,
  });
  assert.deepEqual(h.stored, [{ pool: POOL_A, value: { signature: 's-0', slot: 10_000n } }]);
  assert.equal(h.cycles[0]?.enqueued, 2_500);
});

void test('an unconfirmed boundary enqueues nothing and reports awaitingBoundary', async () => {
  const h = harness([trackedPool(POOL_A, MINT_A)], {
    [POOL_A]: historyScript([row('t1', 120), row('other', 110)]),
  });
  h.checkpoints.set(POOL_A, { signature: 'cp', slot: 100n });
  await h.poller.start();
  assert.equal(h.enqueued.length, 0);
  assert.equal(h.stored.length, 0);
  assert.equal(h.cycles[0]?.awaitingBoundary, 1);
  assert.equal(h.poolReports[0]?.outcome, 'AWAITING_BOUNDARY');
});

void test('an exhausted page budget with an unconfirmed boundary catches up to the live edge', async () => {
  const history = [...rows('w', 6_000, 100_000), row('cp', 1_000)];
  history[1] = { ...row('w-1', 99_999), err: { InstructionError: [0, 'Custom'] } };
  const h = harness([trackedPool(POOL_A, MINT_A)], {
    [POOL_A]: (options) => historyScript(history)(options),
  });
  h.checkpoints.set(POOL_A, { signature: 'cp', slot: 1_000n });
  await h.poller.start();
  assert.equal(h.calls.length, 6);
  assert.equal(h.enqueued.length, 4_999);
  assert.equal(h.enqueued.some((entry) => entry.signature === 'w-1'), false);
  assert.deepEqual(h.stored, [{ pool: POOL_A, value: { signature: 'w-0', slot: 100_000n } }]);
  assert.equal(h.cycles[0]?.gapSkipped, 1);
  assert.equal(h.cycles[0]?.failed, 0);
  assert.equal(h.cycles[0]?.enqueued, 4_999);
  assert.equal(h.poller.state(), 'RUNNING');
  assert.deepEqual(h.poolReports[0], {
    poolAddress: POOL_A, outcome: 'GAP_SKIPPED', pageCount: 5, signaturesRead: 5_000,
    gapClosedAtSlot: 95_001n, errorName: null,
  });
  history.unshift(row('fresh', 200_000));
  await h.tick();
  assert.equal(h.calls[6]?.options.until, 'w-0');
  assert.equal(h.cycles.at(-1)?.succeeded, 1);
  assert.equal(h.cycles.at(-1)?.gapSkipped, 0);
  assert.equal(h.enqueued.at(-1)?.signature, 'fresh');
  assert.deepEqual(h.checkpoints.get(POOL_A), { signature: 'fresh', slot: 200_000n });
});

void test('an exhausted page budget with a confirmed boundary is a plain success', async () => {
  const h = harness([trackedPool(POOL_A, MINT_A)], {
    [POOL_A]: historyScript([...rows('s', 5_000, 10_000), row('cp', 1_000)]),
  });
  h.checkpoints.set(POOL_A, { signature: 'cp', slot: 1_000n });
  await h.poller.start();
  assert.equal(h.cycles[0]?.succeeded, 1);
  assert.equal(h.cycles[0]?.gapSkipped, 0);
  assert.equal(h.enqueued.length, 5_000);
  assert.deepEqual(h.stored, [{ pool: POOL_A, value: { signature: 's-0', slot: 10_000n } }]);
});

void test('invalid pages fail the pool while other pools continue', async () => {
  const cases: Record<string, unknown>[][] = [
    [row('a', 110), row('b', 120), row('cp', 100)],
    [row('a', 120), row('a', 110), row('cp', 100)],
    [row('a', 120), row('b', 90), row('cp', 100)],
  ];
  for (const history of cases) {
    const h = harness([trackedPool(POOL_A, MINT_A), trackedPool(POOL_B, MINT_B)], {
      [POOL_A]: historyScript(history),
      [POOL_B]: historyScript([row('b1', 130), row('cpb', 100)]),
    });
    h.checkpoints.set(POOL_A, { signature: 'cp', slot: 100n });
    h.checkpoints.set(POOL_B, { signature: 'cpb', slot: 100n });
    await h.poller.start();
    assert.equal(h.cycles[0]?.failed, 1);
    assert.equal(h.cycles[0]?.succeeded, 1);
    assert.deepEqual(h.enqueued.map((entry) => entry.signature), ['b1']);
    assert.equal(h.poolReports.find((entry) => entry.poolAddress === POOL_A)?.outcome, 'FAILED');
  }
});

void test('a non-finalized row fails the pool without enqueue or checkpoint change', async () => {
  const h = harness([trackedPool(POOL_A, MINT_A)], {
    [POOL_A]: historyScript([
      row('a', 120), { ...row('b', 110), confirmationStatus: 'confirmed' }, row('cp', 100),
    ]),
  });
  h.checkpoints.set(POOL_A, { signature: 'cp', slot: 100n });
  await h.poller.start();
  assert.equal(h.cycles[0]?.failed, 1);
  assert.equal(h.enqueued.length, 0);
  assert.equal(h.stored.length, 0);
});

void test('failed transactions are not enqueued but still advance the checkpoint', async () => {
  const h = harness([trackedPool(POOL_A, MINT_A)], {
    [POOL_A]: historyScript([
      { ...row('f', 130), err: { InstructionError: [0, 'Custom'] } }, row('ok', 120), row('cp', 100),
    ]),
  });
  h.checkpoints.set(POOL_A, { signature: 'cp', slot: 100n });
  await h.poller.start();
  assert.equal(h.cycles[0]?.succeeded, 1);
  assert.deepEqual(h.enqueued.map((entry) => entry.signature), ['ok']);
  assert.deepEqual(h.stored, [{ pool: POOL_A, value: { signature: 'f', slot: 130n } }]);
});

void test('a timed-out sweep makes no further rpc call for that pool', async () => {
  let releasePage: (value: unknown[]) => void = () => undefined;
  const pageGate = new Promise<unknown[]>((resolve) => { releasePage = resolve; });
  const h = harness([trackedPool(POOL_A, MINT_A)], {
    // The harness resolves the script result, so a pending promise makes the first page hang.
    [POOL_A]: () => (h.calls.length === 1 ? pageGate as unknown as unknown[] : []),
  });
  h.checkpoints.set(POOL_A, { signature: 'cp', slot: 100n });
  const starting = h.poller.start();
  await new Promise((resolve) => { setImmediate(resolve); });
  const sweepTimeout = h.scheduled.find((entry) => entry.delayMs === 30_000);
  assert.ok(sweepTimeout !== undefined, 'the sweep timeout runs on the injected scheduler');
  sweepTimeout.callback();
  await starting;
  assert.equal(h.poolReports[0]?.outcome, 'FAILED');
  releasePage([]);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(h.calls.length, 1, 'no probe after the timeout fired');
});

void test('an rpc error isolates the pool and a selection error fails the cycle', async () => {
  const h = harness([trackedPool(POOL_A, MINT_A), trackedPool(POOL_B, MINT_B)], {
    [POOL_A]: historyScript([row('cp', 100)]),
    [POOL_B]: historyScript([row('b1', 130), row('cpb', 100)]),
  });
  h.checkpoints.set(POOL_A, { signature: 'cp', slot: 100n });
  h.checkpoints.set(POOL_B, { signature: 'cpb', slot: 100n });
  h.state.rpcError.add(POOL_A);
  await h.poller.start();
  assert.equal(h.cycles[0]?.failed, 1);
  assert.deepEqual(h.enqueued.map((entry) => entry.signature), ['b1']);
  assert.equal(h.poolReports.find((entry) => entry.poolAddress === POOL_A)?.errorName, 'Error');
  h.state.listError = new Error('db down');
  await h.tick();
  assert.equal(h.poller.state(), 'DEGRADED');
  assert.equal(h.cycles.at(-1)?.errorName, 'Error');
  h.state.listError = null;
  await h.tick();
  assert.equal(h.poller.state(), 'RUNNING');
});

void test('start schedules at intervalMs and close cancels and waits', async () => {
  const h = harness([], {});
  assert.equal(h.poller.state(), 'STOPPED');
  await h.poller.start();
  assert.equal(h.poller.state(), 'RUNNING');
  assert.equal(h.cycles.length, 1);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0]?.delayMs, 10_000);
  const handle = h.scheduled[0]?.handle;
  await h.poller.close();
  assert.deepEqual(h.cancelled, [handle]);
  assert.equal(h.poller.state(), 'STOPPED');
});

void test('close waits for the in-flight cycle', async () => {
  const h = harness([], {});
  await h.poller.start();
  let release: () => void = () => undefined;
  h.state.listGate = new Promise<void>((resolve) => { release = resolve; });
  const task = h.scheduled.pop();
  assert.ok(task !== undefined);
  task.callback();
  let closed = false;
  const closing = h.poller.close().then(() => { closed = true; });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(h.poller.state(), 'STOPPED');
  assert.equal(h.scheduled.length, 0, 'no cycle scheduled after close');
});

void test('a selection of exactly 20 pools reports capReached', async () => {
  const pools = Array.from({ length: 20 }, () => trackedPool(POOL_A, MINT_A));
  const h = harness(pools, { [POOL_A]: historyScript([row('cp', 100)]) });
  h.checkpoints.set(POOL_A, { signature: 'cp', slot: 100n });
  await h.poller.start();
  assert.equal(h.cycles[0]?.capReached, true);
  assert.equal(h.cycles[0]?.tracked, 20);
});
