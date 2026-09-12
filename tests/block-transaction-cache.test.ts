import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { BLOCK_TRANSACTION_CACHE_DEFAULTS, CachedSolanaBlockTransactionLocator } from '../src/solana/rpc/block-transaction-cache.js';
import {
  BlockUnavailableError, RpcTransientError, TransactionIndexNotFoundError,
  TransactionNormalizationError, type TransactionLocationTarget,
  trustedTransactionLocatorFailure,
} from '../src/solana/rpc/transaction-locator.js';

const KEY = new PublicKey('11111111111111111111111111111111');
function target(signature = 'one', slot = 42n, confirmationStatus: TransactionLocationTarget['confirmationStatus'] = 'CONFIRMED'): TransactionLocationTarget {
  return { signature, slot, confirmationStatus };
}
function entry(signature: string, version: 'legacy' | 0 = 'legacy') {
  return {
    version,
    transaction: {
      signatures: [signature],
      message: {
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
        ...(version === 0
          ? { staticAccountKeys: [KEY], addressTableLookups: [{ writableIndexes: [0], readonlyIndexes: [] }] }
          : { accountKeys: [KEY] }),
        compiledInstructions: [{ programIdIndex: 0, accountKeyIndexes: [0], data: new Uint8Array([1, 2]) }],
      },
    },
    meta: { fee: 5000, err: null, preBalances: [10000], postBalances: [5000],
      loadedAddresses: { writable: version === 0 ? [KEY] : [], readonly: [] } },
  };
}
function block(signatures = ['one', 'two'], slot = 42n) {
  return { blockhash: KEY.toBase58(), previousBlockhash: KEY.toBase58(), parentSlot: Number(slot - 1n),
    blockTime: null, transactions: signatures.map((signature) => entry(signature)) };
}
function harness(options: { maxEntries?: number; maxBytes?: number; maxEntryBytes?: number; confirmedTtlMs?: number } = {}) {
  let now = 0;
  let epoch = 0;
  const calls: { slot: bigint; status: string; time: number }[] = [];
  let fetch: (slot: bigint) => Promise<unknown> = async (slot) => block(['one', 'two'], slot);
  const locator = new CachedSolanaBlockTransactionLocator({
    get httpTransportEpoch() { return epoch; },
    async getBlockTransactions(slot, status) {
      calls.push({ slot, status, time: now });
      return fetch(slot);
    },
  }, { ...options, now: () => now, sleep: async (ms) => { now += ms; } });
  return { locator, calls, setNow(value: number) { now = value; },
    setEpoch(value: number) { epoch = value; }, setFetch(value: typeof fetch) { fetch = value; } };
}

void test('whole-slot single-flight and sequential hits preserve canonical indexes and caller isolation', async () => {
  const h = harness();
  const [one, two] = await Promise.all([h.locator.locate(target()), h.locator.locate(target('two'))]);
  assert.equal(one.transactionIndex, 0);
  assert.equal(two.transactionIndex, 1);
  const instruction = one.instructions[0];
  assert.ok(instruction);
  instruction.data[0] = 99;
  one.confirmationStatus = 'ORPHANED';
  assert.equal((await h.locator.locate(target())).instructions[0]?.data[0], 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.locator.stats.entries, 1);
  assert.equal(h.locator.stats.inFlight, 0);
});

void test('publishes one frozen bounded V1 metrics snapshot for hits and shared misses', async () => {
  const h = harness();

  assert.deepEqual(h.locator.metrics, {
    version: 1,
    locates: 0,
    hits: 0,
    misses: 0,
    inFlightJoins: 0,
    fetches: 0,
    forcedRefreshes: 0,
    evictions: 0,
    oversizeBypasses: 0,
    fetchFailures: 0,
    epochInvalidations: 0,
    retainedEntries: 0,
    retainedBytes: 0,
    inFlightFetches: 0,
    queuedFetches: 0,
    queueDelayMs: { last: null, maximum: null },
  });
  assert.equal(Object.isFrozen(h.locator.metrics), true);
  assert.equal(Object.isFrozen(h.locator.metrics.queueDelayMs), true);

  await Promise.all([h.locator.locate(target()), h.locator.locate(target('two'))]);
  await h.locator.locate(target());

  assert.deepEqual(h.locator.metrics, {
    version: 1,
    locates: 3,
    hits: 1,
    misses: 2,
    inFlightJoins: 1,
    fetches: 1,
    forcedRefreshes: 0,
    evictions: 0,
    oversizeBypasses: 0,
    fetchFailures: 0,
    epochInvalidations: 0,
    retainedEntries: 1,
    retainedBytes: h.locator.stats.bytes,
    inFlightFetches: 0,
    queuedFetches: 0,
    queueDelayMs: { last: 0, maximum: 0 },
  });
});

void test('metrics distinguish forced refreshes, evictions, oversize bypasses and fetch failures', async () => {
  const h = harness();
  await h.locator.locate(target());
  h.setFetch(async () => block(['one', 'new']));
  await h.locator.locate(target('new'));
  assert.equal(h.locator.metrics.forcedRefreshes, 1);
  assert.equal(h.locator.metrics.evictions, 1);

  const oversized = harness({ maxEntryBytes: 1 });
  await Promise.all([
    oversized.locator.locate(target()),
    oversized.locator.locate(target('two')),
  ]);
  assert.equal(oversized.locator.metrics.oversizeBypasses, 1);
  assert.equal(oversized.locator.metrics.retainedEntries, 0);

  const failed = harness();
  failed.setFetch(async () => null);
  await Promise.allSettled([
    failed.locator.locate(target()),
    failed.locator.locate(target('two')),
  ]);
  assert.equal(failed.locator.metrics.fetchFailures, 1);
  assert.equal(failed.locator.metrics.fetches, 1);
});

void test('metrics expose FIFO queue delay and epoch invalidations without identities', async () => {
  const h = harness();
  await Promise.all(Array.from(
    { length: 4 },
    (_unused, index) => h.locator.locate(target('one', BigInt(42 + index))),
  ));
  assert.deepEqual(h.locator.metrics.queueDelayMs, { last: 500, maximum: 500 });
  assert.equal(h.locator.metrics.fetches, 4);

  h.setEpoch(1);
  void h.locator.metrics;
  assert.equal(h.locator.metrics.epochInvalidations, 1);
  assert.equal(h.locator.metrics.retainedEntries, 0);
  assert.doesNotMatch(JSON.stringify(h.locator.metrics), /one|42|primary|https?:/u);
});

void test('effective commitments coalesce processed/confirmed and isolate finalized', async () => {
  const h = harness();
  assert.equal((await h.locator.locate(target('one', 42n, 'PROCESSED'))).confirmationStatus, 'PROCESSED');
  assert.equal((await h.locator.locate(target())).confirmationStatus, 'CONFIRMED');
  await h.locator.locate(target('one', 42n, 'FINALIZED'));
  assert.deepEqual(h.calls.map(({ status }) => status), ['CONFIRMED', 'FINALIZED']);
});

void test('TTL expiration and entry LRU are deterministic', async () => {
  const h = harness({ confirmedTtlMs: 1000, maxEntries: 2 });
  await h.locator.locate(target('one', 42n));
  await h.locator.locate(target('one', 43n));
  await h.locator.locate(target('one', 42n));
  await h.locator.locate(target('one', 44n));
  await h.locator.locate(target('one', 43n));
  assert.deepEqual(h.calls.map(({ slot }) => slot), [42n, 43n, 44n, 43n]);
  h.setNow(2000);
  await h.locator.locate(target('one', 43n));
  assert.equal(h.calls.length, 5);
});

void test('byte LRU and oversize responses do not retain more than their budget', async () => {
  const measure = harness();
  await measure.locator.locate(target());
  const bytes = measure.locator.stats.bytes;
  assert.ok(bytes > 0);
  const h = harness({ maxBytes: bytes });
  await h.locator.locate(target());
  await h.locator.locate(target('one', 43n));
  assert.equal(h.locator.stats.entries, 1);
  assert.ok(h.locator.stats.bytes <= bytes);
  const oversized = harness({ maxBytes: 1 });
  assert.equal((await oversized.locator.locate(target())).signature, 'one');
  await oversized.locator.locate(target());
  assert.equal(oversized.calls.length, 2);
  assert.equal(oversized.locator.stats.bytes, 0);
});

void test('null, malformed blocks, misses and RPC errors are never negatively cached', async () => {
  for (const [value, error] of [[null, BlockUnavailableError], [{}, BlockUnavailableError], [block(['other']), TransactionIndexNotFoundError]] as const) {
    const h = harness();
    h.setFetch(async () => value);
    await assert.rejects(h.locator.locate(target()), error);
    await assert.rejects(h.locator.locate(target()), error);
    assert.equal(h.calls.length, 2);
    assert.equal(h.locator.stats.entries, 0);
    assert.equal(h.locator.stats.inFlight, 0);
  }
  const h = harness();
  h.setFetch(async () => { throw new Error('private provider payload'); });
  await assert.rejects(h.locator.locate(target()), RpcTransientError);
  h.setFetch(async () => block());
  await h.locator.locate(target());
  assert.equal(h.calls.length, 2);
});

void test('a cached target miss shares exactly one forced refresh, without legacy fallback', async () => {
  const h = harness();
  await h.locator.locate(target());
  h.setFetch(async () => block(['one', 'two', 'new']));
  const results = await Promise.all([h.locator.locate(target('new')), h.locator.locate(target('new'))]);
  assert.equal(results[0]?.transactionIndex, 2);
  assert.equal(h.calls.length, 2);
  await assert.rejects(h.locator.locate(target('absent')), TransactionIndexNotFoundError);
  assert.equal(h.calls.length, 3);
});

void test('FIFO pacing spaces all cold/refresh fetch starts by at least 250ms', async () => {
  const h = harness();
  await Promise.all(Array.from({ length: 8 }, (_unused, index) => h.locator.locate(target('one', BigInt(42 + index)))));
  assert.deepEqual(h.calls.map(({ slot }) => slot), [42n, 43n, 44n, 45n, 46n, 47n, 48n, 49n]);
  assert.deepEqual(h.calls.map(({ time }) => time), [0, 250, 500, 750, 1000, 1250, 1500, 1750]);
});

void test('epoch changes invalidate cached entries and old in-flight responses cannot be retained', async () => {
  const h = harness();
  let release!: (value: unknown) => void;
  h.setFetch(async () => new Promise((resolve) => { release = resolve; }));
  const old = h.locator.locate(target());
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.setEpoch(1);
  h.setFetch(async () => block());
  await h.locator.locate(target('two'));
  release(block());
  await old;
  assert.equal(h.locator.stats.entries, 1);
  assert.equal(h.locator.stats.inFlight, 0);
  await h.locator.locate(target());
  assert.equal(h.calls.length, 2);
  h.setEpoch(2);
  await h.locator.locate(target());
  assert.equal(h.calls.length, 3);
});

void test('an epoch change drains stale queued admissions without consuming their pacing slots', async () => {
  const h = harness();
  const first = h.locator.locate(target('one', 42n));
  const stale = [
    h.locator.locate(target('one', 43n)),
    h.locator.locate(target('one', 44n)),
  ];
  h.setEpoch(1);
  const fresh = h.locator.locate(target('one', 45n));

  assert.equal((await first).slot, 42n);
  const staleResults = await Promise.allSettled(stale);
  assert.equal(staleResults.every(({ status }) => status === 'rejected'), true);
  assert.equal((await fresh).slot, 45n);
  assert.deepEqual(h.calls.map(({ slot }) => slot), [42n, 45n]);
  assert.deepEqual(h.calls.map(({ time }) => time), [0, 250]);
});

void test('the pacing pump drains a stale backlog even without a fresh caller', async () => {
  const h = harness();
  const first = h.locator.locate(target('one', 42n));
  const stale = [
    h.locator.locate(target('one', 43n)),
    h.locator.locate(target('one', 44n)),
  ];
  h.setEpoch(1);

  assert.equal((await first).slot, 42n);
  const staleResults = await Promise.allSettled(stale);
  assert.equal(staleResults.every(({ status }) => status === 'rejected'), true);
  assert.equal((await h.locator.locate(target('one', 45n))).slot, 45n);
  assert.deepEqual(h.calls.map(({ slot }) => slot), [42n, 45n]);
  assert.deepEqual(h.calls.map(({ time }) => time), [0, 250]);
});

void test('clear invalidates in-flight retention and close releases queued callers', async () => {
  const h = harness();
  let release!: (value: unknown) => void;
  h.setFetch(async () => new Promise((resolve) => { release = resolve; }));
  const pending = h.locator.locate(target());
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.locator.clear();
  release(block());
  await pending;
  assert.equal(h.locator.stats.entries, 0);
  h.locator.close();
  await assert.rejects(h.locator.locate(target()), RpcTransientError);
});

void test('legacy and v0 ALT normalize without retaining provider-owned arrays or methods', async () => {
  const h = harness();
  const data = block();
  data.transactions[1] = entry('two', 0);
  h.setFetch(async () => data);
  assert.equal((await h.locator.locate(target())).version, 'legacy');
  const instruction = data.transactions[1]?.transaction.message.compiledInstructions[0];
  assert.ok(instruction);
  instruction.data[0] = 99;
  const two = await h.locator.locate(target('two'));
  assert.equal(two.version, 0);
  assert.equal(two.accountKeys.length, 2);
  assert.equal(two.instructions[0]?.data[0], 1);
});

void test('unrelated malformed normalization does not reject a valid current target or get cached', async () => {
  const h = harness();
  const data = block();
  let reads = 0;
  const malformed = data.transactions[1];
  assert.ok(malformed);
  Object.defineProperty(malformed, 'meta', { enumerable: true, get() { reads += 1; throw new Error(); } });
  h.setFetch(async () => data);
  assert.equal((await h.locator.locate(target())).signature, 'one');
  assert.equal(h.locator.stats.entries, 0);
  await assert.rejects(h.locator.locate(target('two')), TransactionNormalizationError);
  assert.equal(reads, 0);
  assert.equal(h.calls.length, 2);
});

void test('single-flight failures provide an independent trusted error for every caller', async () => {
  const h = harness();
  h.setFetch(async () => null);
  const results = await Promise.allSettled([h.locator.locate(target()), h.locator.locate(target('two'))]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status !== 'rejected') throw new Error();
    assert.equal(trustedTransactionLocatorFailure(result.reason)?.code, 'BLOCK_NOT_AVAILABLE');
  }
});

void test('safe defaults enforce distinct confirmed/finalized TTLs and a per-block byte cap', async () => {
  assert.deepEqual(BLOCK_TRANSACTION_CACHE_DEFAULTS, {
    maxEntries: 64, maxBytes: 64 * 1024 * 1024, maxEntryBytes: 8 * 1024 * 1024,
    confirmedTtlMs: 10000, finalizedTtlMs: 60000, fetchIntervalMs: 250,
  });
  const h = harness();
  await h.locator.locate(target());
  await h.locator.locate(target('one', 42n, 'FINALIZED'));
  h.setNow(10000);
  await h.locator.locate(target('one', 42n, 'FINALIZED'));
  assert.equal(h.calls.length, 2);
  await h.locator.locate(target());
  assert.equal(h.calls.length, 3);
  h.setNow(60250);
  await h.locator.locate(target('one', 42n, 'FINALIZED'));
  assert.equal(h.calls.length, 4);
  const oversized = harness({ maxEntryBytes: 1 });
  await oversized.locator.locate(target());
  assert.equal(oversized.locator.stats.entries, 0);
});

void test('close cancels the pacing sleeper and rejects all queued flights', async () => {
  let calls = 0;
  let aborted = false;
  const locator = new CachedSolanaBlockTransactionLocator({
    httpTransportEpoch: 0,
    async getBlockTransactions(slot) { calls += 1; return block(['one'], slot); },
  }, {
    now: () => 0,
    sleep: async (_ms, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error()); }, { once: true });
    }),
  });
  await locator.locate(target());
  const second = locator.locate(target('one', 43n));
  const third = locator.locate(target('one', 44n));
  assert.equal(locator.metrics.inFlightFetches, 0);
  assert.equal(locator.metrics.queuedFetches, 2);
  locator.close();
  await assert.rejects(second, RpcTransientError);
  await assert.rejects(third, RpcTransientError);
  assert.equal(aborted, true);
  assert.equal(calls, 1);
  assert.deepEqual(locator.stats, { entries: 0, bytes: 0, inFlight: 0, queued: 0 });
});

void test('an epoch change inside the only in-flight fetch prevents retention', async () => {
  const h = harness();
  h.setFetch(async () => { h.setEpoch(1); return block(); });
  await h.locator.locate(target());
  assert.equal(h.locator.stats.entries, 0);
  await h.locator.locate(target());
  assert.equal(h.calls.length, 2);
});

void test('active RPC gauge survives clear until the detached request settles', async () => {
  const h = harness();
  let release!: (value: unknown) => void;
  h.setFetch(async () => new Promise((resolve) => { release = resolve; }));
  const locating = h.locator.locate(target());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.locator.metrics.inFlightFetches, 1);
  h.locator.clear();
  assert.equal(h.locator.stats.inFlight, 0);
  assert.equal(h.locator.metrics.inFlightFetches, 1);
  release(block());
  await locating;
  assert.equal(h.locator.metrics.inFlightFetches, 0);
});

void test('duplicate signatures and malformed selected transactions retain no cache entry', async () => {
  for (const [signatures, error] of [
    [['one', 'one'], TransactionIndexNotFoundError],
    [['other', 'other', 'one'], BlockUnavailableError],
  ] as const) {
    const h = harness();
    h.setFetch(async () => block([...signatures]));
    await assert.rejects(h.locator.locate(target()), error);
    assert.equal(h.locator.stats.entries, 0);
  }
  const h = harness();
  const data = block();
  Object.defineProperty(data.transactions[0], 'version', { enumerable: true, value: 1 });
  h.setFetch(async () => data);
  await assert.rejects(h.locator.locate(target()), TransactionNormalizationError);
  assert.equal(h.locator.stats.entries, 0);
});
