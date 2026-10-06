import assert from 'node:assert/strict';
import test from 'node:test';
import { ListenerCoverage } from '../src/application/listener-coverage.js';
import type { MarketCoverageState } from '../src/application/market-pool-tracker.js';
import type { ListenerRuntimeState } from '../src/domain/transaction-ingestion.js';

function parts(
  launchpadState: ListenerRuntimeState,
  launchpadHealthy: boolean,
  market: MarketCoverageState,
  covered = true,
  marketStart: () => Promise<void> = async () => undefined,
) {
  const calls: string[] = [];
  const coverage = new ListenerCoverage(
    {
      async scan() { calls.push('launchpad.scan'); return 'bootstrap'; },
      async close() { calls.push('launchpad.close'); },
      state: () => launchpadState,
      isCoverageHealthy: () => launchpadHealthy,
    },
    {
      async start() { calls.push('market.start'); await marketStart(); },
      async close() { calls.push('market.close'); },
      coverageState: () => market,
      isMintCovered: () => covered,
    },
  );
  return { coverage, calls };
}

void test('scan bootstraps the launchpad before starting the market tracker', async () => {
  const { coverage, calls } = parts('RUNNING', true, 'HEALTHY');
  assert.equal(await coverage.scan(), 'bootstrap');
  assert.deepEqual(calls, ['launchpad.scan', 'market.start']);
});

void test('scan resolves without waiting for the first market cycle and stays fail-closed meanwhile', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const { coverage, calls } = parts('RUNNING', true, 'WARMING_UP', false, () => pending);
  assert.equal(await coverage.scan(), 'bootstrap');
  assert.deepEqual(calls, ['launchpad.scan', 'market.start']);
  assert.equal(coverage.isMintCovered('m'), false);
  assert.equal(coverage.state(), 'STARTING');
  release();
  await pending;
});

void test('a rejected market start is contained: no unhandled rejection, mints uncovered, DEGRADED', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const { coverage } = parts('RUNNING', true, 'HEALTHY', true, () => Promise.reject(new Error('boom')));
    assert.equal(await coverage.scan(), 'bootstrap');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(coverage.isMintCovered('m'), false);
    assert.equal(coverage.state(), 'DEGRADED');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

void test('close stops the market tracker and the launchpad', async () => {
  const { coverage, calls } = parts('RUNNING', true, 'HEALTHY');
  await coverage.close();
  assert.deepEqual(calls, ['market.close', 'launchpad.close']);
});

function closable(market: () => Promise<void>, launchpad: () => Promise<void>) {
  const calls: string[] = [];
  const coverage = new ListenerCoverage(
    {
      async scan() { return 'bootstrap'; },
      close: () => { calls.push('launchpad.close'); return launchpad(); },
      state: () => 'RUNNING',
      isCoverageHealthy: () => true,
    },
    {
      async start() {},
      close: () => { calls.push('market.close'); return market(); },
      coverageState: () => 'HEALTHY',
      isMintCovered: () => true,
    },
  );
  return { coverage, calls };
}

void test('close runs market and launchpad shutdown in parallel', async () => {
  let releaseMarket!: () => void;
  const market = new Promise<void>((resolve) => { releaseMarket = resolve; });
  const { coverage, calls } = closable(() => market, async () => undefined);
  let closed = false;
  const closing = coverage.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['market.close', 'launchpad.close'], 'the launchpad does not wait for the market');
  assert.equal(closed, false, 'close waits for both');
  releaseMarket();
  await closing;
  assert.equal(closed, true);
});

void test('close rethrows the first failure after both shutdowns settled', async () => {
  const marketError = new Error('market');
  let launchpadDone = false;
  const failingMarket = closable(
    () => Promise.reject(marketError),
    async () => { await new Promise((resolve) => setImmediate(resolve)); launchpadDone = true; },
  );
  await assert.rejects(failingMarket.coverage.close(), (error) => error === marketError);
  assert.equal(launchpadDone, true);
  const launchpadError = new Error('launchpad');
  const failingLaunchpad = closable(async () => undefined, () => Promise.reject(launchpadError));
  await assert.rejects(failingLaunchpad.coverage.close(), (error) => error === launchpadError);
  const both = closable(() => Promise.reject(marketError), () => Promise.reject(launchpadError));
  await assert.rejects(both.coverage.close(), (error) => error === marketError);
});

void test('state combines launchpad and market coverage', () => {
  assert.equal(parts('RUNNING', true, 'HEALTHY').coverage.state(), 'RUNNING');
  assert.equal(parts('RUNNING', true, 'DEGRADED').coverage.state(), 'DEGRADED');
  assert.equal(parts('RUNNING', true, 'WARMING_UP').coverage.state(), 'STARTING');
  assert.equal(parts('DEGRADED', false, 'HEALTHY').coverage.state(), 'DEGRADED');
});

void test('a mint is covered only when the launchpad is healthy and its pool is covered', () => {
  assert.equal(parts('RUNNING', true, 'DEGRADED', true).coverage.isMintCovered('m'), true);
  assert.equal(parts('RUNNING', true, 'HEALTHY', false).coverage.isMintCovered('m'), false);
  assert.equal(parts('DEGRADED', false, 'HEALTHY', true).coverage.isMintCovered('m'), false);
});
