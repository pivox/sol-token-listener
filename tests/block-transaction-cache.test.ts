import assert from 'node:assert/strict';
import test from 'node:test';
import { serialize } from 'node:v8';
import { PublicKey } from '@solana/web3.js';
import { BLOCK_TRANSACTION_CACHE_DEFAULTS, CachedSolanaBlockTransactionLocator } from '../src/solana/rpc/block-transaction-cache.js';
import {
  decodeBlockTransactionPayload, encodeBlockTransactionPayload,
  MAX_BLOCK_COMPRESSION_INPUT_BYTES, MAX_COMPRESSED_TRANSACTION_BYTES,
} from '../src/solana/rpc/block-transaction-payload-codec.js';
import {
  ListenerRpcWorkGate,
  gateBlockTransactionRpc,
} from '../src/application/listener-rpc-work-gate.js';
import {
  BlockUnavailableError, RpcTransientError, TransactionIndexNotFoundError,
  TransactionNormalizationError, type TransactionLocationTarget,
  SolanaBlockTransactionLocator, snapshotBlockTransactionData, trustedTransactionLocatorFailure,
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
    meta: { fee: 5000, err: null, preBalances: [10000], postBalances: [5000], logMessages: [] as string[],
      loadedAddresses: { writable: version === 0 ? [KEY] : [], readonly: [] } },
  };
}
function block(signatures = ['one', 'two'], slot = 42n) {
  return { blockhash: KEY.toBase58(), previousBlockhash: KEY.toBase58(), parentSlot: Number(slot - 1n),
    blockTime: null, transactions: signatures.map((signature) => entry(signature)) };
}
function loggedBlock(count: number, log: string) {
  const data = block(Array.from({ length: count }, (_unused, index) => `logged-${index}`));
  for (const transaction of data.transactions) transaction.meta.logMessages = [log];
  return data;
}
function incompressibleLog(length: number): string {
  const bytes = Buffer.alloc(length);
  let state = 0x12345678;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state >>> 24;
  }
  return bytes.toString('latin1');
}
function uncachedLocator(data: ReturnType<typeof block>) {
  return new SolanaBlockTransactionLocator({ async getBlockTransactions() { return data; } });
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
function harness(options: { maxEntries?: number; maxBytes?: number; maxEntryBytes?: number; confirmedTtlMs?: number; phaseNow?: () => number } = {}) {
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

void test('phase evidence measures one physical single-flight fetch independently of cache metrics and TTL clock', async () => {
  const times = [10, 110, 200, 225];
  const h = harness({ phaseNow: () => {
    const time = times.shift();
    assert.ok(time !== undefined);
    return time;
  } });
  const initial = h.locator.phaseEvidence;
  assert.equal(initial, null);
  const flight = deferred<unknown>();
  h.setFetch(async () => flight.promise);
  const first = h.locator.locate(target());
  const second = h.locator.locate(target('two'));
  const pending = h.locator.phaseEvidence;
  assert.ok(pending);
  assert.equal(pending.rpc.started, 1);
  assert.equal(pending.rpc.inFlight, 1);
  assert.equal(pending.snapshot.started, 0);
  assert.equal(h.calls.length, 1);
  flight.resolve(block());
  await Promise.all([first, second]);
  const settled = h.locator.phaseEvidence;
  assert.ok(settled);
  assert.deepEqual(settled.rpc, {
    started: 1, completed: 1, failed: 0, inFlight: 0, maxInFlight: 1,
    settledLatencyBuckets: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0], maxSettledLatencyMs: 100,
  });
  assert.deepEqual(settled.snapshot, {
    started: 1, completed: 1, failed: 0, inFlight: 0, maxInFlight: 1,
    settledLatencyBuckets: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], maxSettledLatencyMs: 25,
  });
  assert.equal(Object.isFrozen(settled.snapshot.settledLatencyBuckets), true);
  assert.equal(pending.rpc.inFlight, 1);
  await h.locator.locate(target());
  assert.deepEqual(h.locator.phaseEvidence, settled);
  assert.equal(h.locator.stats.entries, 1);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.locator.metrics, {
    version: 1, locates: 3, hits: 1, misses: 2, inFlightJoins: 1, fetches: 1,
    forcedRefreshes: 0, evictions: 0, oversizeBypasses: 0, fetchFailures: 0,
    epochInvalidations: 0, retainedEntries: 1, retainedBytes: h.locator.stats.bytes,
    inFlightFetches: 0, queuedFetches: 0, queueDelayMs: { last: 0, maximum: 0 },
  });
  assert.deepEqual(times, []);
});

void test('phase evidence settles RPC rejection and counts a retry as a distinct physical attempt', async () => {
  const h = harness({ phaseNow: () => 0 });
  h.setFetch(async () => { throw new Error('private provider payload'); });
  await assert.rejects(h.locator.locate(target()), RpcTransientError);
  const failed = h.locator.phaseEvidence;
  assert.ok(failed);
  assert.equal(failed.rpc.started, 1);
  assert.equal(failed.rpc.failed, 1);
  assert.equal(failed.rpc.inFlight, 0);
  assert.equal(failed.snapshot.started, 0);
  h.setFetch(async () => block());
  await h.locator.locate(target());
  const retried = h.locator.phaseEvidence;
  assert.ok(retried);
  assert.equal(retried.rpc.started, 2);
  assert.equal(retried.rpc.completed, 1);
  assert.equal(retried.rpc.failed, 1);
  assert.equal(retried.rpc.settledLatencyBuckets[0], 2);
  assert.equal(retried.snapshot.completed, 1);
  assert.equal(h.locator.metrics.fetchFailures, 1);
  assert.equal(h.calls.length, 2);
});

void test('invalid blocks settle snapshot failures without changing trusted locator errors', async () => {
  for (const value of [null, {}, new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private payload'); } })]) {
    const h = harness({ phaseNow: () => 0 });
    h.setFetch(async () => value);
    await assert.rejects(h.locator.locate(target()), BlockUnavailableError);
    const evidence = h.locator.phaseEvidence;
    assert.ok(evidence);
    assert.equal(evidence.rpc.completed, 1);
    assert.equal(evidence.rpc.failed, 0);
    assert.equal(evidence.snapshot.started, 1);
    assert.equal(evidence.snapshot.failed, 1);
    assert.equal(evidence.snapshot.inFlight, 0);
    assert.equal(evidence.snapshot.settledLatencyBuckets[0], 1);
    assert.equal(h.locator.metrics.fetchFailures, 1);
    assert.equal(h.locator.stats.entries, 0);
  }
});

void test('a throwing phase clock cannot replace success or failure outcomes', async () => {
  const h = harness({ phaseNow: () => { throw new Error('measurement unavailable'); } });
  assert.equal((await h.locator.locate(target())).signature, 'one');
  h.setFetch(async () => { throw new Error('provider unavailable'); });
  await assert.rejects(h.locator.locate(target('one', 43n)), RpcTransientError);
  h.setFetch(async () => null);
  await assert.rejects(h.locator.locate(target('one', 44n)), BlockUnavailableError);
  const evidence = h.locator.phaseEvidence;
  assert.ok(evidence);
  assert.equal(evidence.overflowed, true);
  assert.equal(evidence.rpc.completed, 2);
  assert.equal(evidence.rpc.failed, 1);
  assert.equal(evidence.snapshot.completed, 1);
  assert.equal(evidence.snapshot.failed, 1);
  assert.equal(evidence.rpc.inFlight, 0);
  assert.equal(evidence.snapshot.inFlight, 0);
});

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

void test('the default cache retains a compressible block above the old 8 MiB representation', async () => {
  const data = loggedBlock(12, 'Program log: repeated payload '.repeat(28_000));
  const uncached = uncachedLocator(data);
  const expected = await Promise.all(data.transactions.map(({ transaction }) =>
    uncached.locate(target(transaction.signatures[0]))));
  const oldBytes = 64 + expected.reduce((sum, normalized) =>
    sum + Buffer.byteLength(normalized.signature, 'utf8') + serialize(normalized).toString('base64').length + 32, 0);
  assert.ok(expected.every((normalized) => serialize(normalized).byteLength <= MAX_COMPRESSED_TRANSACTION_BYTES));
  assert.ok(oldBytes > BLOCK_TRANSACTION_CACHE_DEFAULTS.maxEntryBytes);

  const h = harness();
  h.setFetch(async () => data);
  assert.deepEqual(await h.locator.locate(target('logged-0')), expected[0]);
  assert.equal(h.locator.stats.entries, 1);
  assert.ok(h.locator.stats.bytes < BLOCK_TRANSACTION_CACHE_DEFAULTS.maxEntryBytes);
  assert.deepEqual(await h.locator.locate(target('logged-1')), expected[1]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.locator.metrics.hits, 1);
  assert.equal(h.locator.metrics.oversizeBypasses, 0);

  const snapshot = snapshotBlockTransactionData(data, 42n, 'CONFIRMED');
  assert.ok(snapshot?.cacheable);
  assert.equal(snapshot.bytes, 64 + snapshot.transactions.reduce((sum, tx) =>
    sum + Buffer.byteLength(tx.signature, 'utf8') + (tx.payload?.length ?? 0) + 32, 0));
  assert.equal(h.locator.stats.bytes, snapshot.bytes);
  assert.deepEqual(snapshot.transactions.map(({ signature, payload }) => {
    assert.ok(payload);
    assert.match(payload, /^b1:d:/u);
    return { signature, normalized: decodeBlockTransactionPayload(payload) };
  }), expected.map((normalized) => ({ signature: normalized.signature, normalized })));
});

void test('tagged payload accounting admits exact entry/global budgets but bypasses one byte under', async () => {
  const data = loggedBlock(2, 'repeated log '.repeat(2048));
  const uncached = uncachedLocator(data);
  const expected = await Promise.all(data.transactions.map(({ transaction }) =>
    uncached.locate(target(transaction.signatures[0]))));
  const bytes = 64 + expected.reduce((sum, normalized) => {
    const encoded = encodeBlockTransactionPayload(serialize(normalized), MAX_BLOCK_COMPRESSION_INPUT_BYTES);
    return sum + Buffer.byteLength(normalized.signature, 'utf8') + encoded.payload.length + 32;
  }, 0);
  for (const options of [
    { maxEntryBytes: bytes }, { maxBytes: bytes },
    { maxEntryBytes: bytes - 1 }, { maxBytes: bytes - 1 },
  ]) {
    const h = harness(options);
    h.setFetch(async () => data);
    assert.deepEqual(await h.locator.locate(target('logged-0')), expected[0]);
    const retained = !Object.values(options).includes(bytes - 1);
    assert.equal(h.locator.stats.entries, retained ? 1 : 0);
    assert.equal(h.locator.stats.bytes, retained ? bytes : 0);
    assert.deepEqual(await h.locator.locate(target('logged-1')), expected[1]);
    assert.equal(h.calls.length, retained ? 1 : 2);
    assert.equal(h.locator.metrics.oversizeBypasses, retained ? 0 : 2);
  }
});

void test('genuine incompressible oversize blocks bypass retention while sharing one physical fetch', async () => {
  const data = loggedBlock(10, incompressibleLog(MAX_COMPRESSED_TRANSACTION_BYTES - 1024));
  const snapshot = snapshotBlockTransactionData(data, 42n, 'CONFIRMED');
  assert.ok(snapshot?.cacheable);
  assert.ok(snapshot.bytes > BLOCK_TRANSACTION_CACHE_DEFAULTS.maxEntryBytes);
  const release = deferred<unknown>();
  const h = harness();
  h.setFetch(async () => release.promise);
  const first = h.locator.locate(target('logged-0'));
  const joined = h.locator.locate(target('logged-1'));
  await flushMicrotasks();
  assert.equal(h.calls.length, 1);
  release.resolve(data);
  const uncached = uncachedLocator(data);
  assert.deepEqual(await first, await uncached.locate(target('logged-0')));
  assert.deepEqual(await joined, await uncached.locate(target('logged-1')));
  assert.equal(h.calls.length, 1);
  assert.equal(h.locator.stats.entries, 0);
  assert.equal(h.locator.stats.bytes, 0);
  assert.equal(h.locator.metrics.inFlightJoins, 1);
  assert.equal(h.locator.metrics.oversizeBypasses, 1);
  h.setFetch(async () => data);
  await h.locator.locate(target('logged-2'));
  assert.equal(h.calls.length, 2);
  assert.equal(h.locator.metrics.oversizeBypasses, 2);
});

void test('snapshot compression budget counts incompressible attempts and leaves later eligible transactions raw', async () => {
  const data = loggedBlock(34, 'x'.repeat(MAX_COMPRESSED_TRANSACTION_BYTES - 1024));
  const first = data.transactions[0];
  assert.ok(first);
  first.meta.logMessages = [incompressibleLog(MAX_COMPRESSED_TRANSACTION_BYTES - 1024)];
  const uncached = uncachedLocator(data);
  const snapshot = snapshotBlockTransactionData(data, 42n, 'CONFIRMED');
  assert.ok(snapshot?.cacheable);
  let remaining = MAX_BLOCK_COMPRESSION_INPUT_BYTES;
  let totalOriginalBytes = 0;
  let attemptedBytes = 0;
  let skippedEligible = 0;
  for (const [index, transaction] of snapshot.transactions.entries()) {
    const normalized = await uncached.locate(target(transaction.signature));
    const serialized = serialize(normalized);
    assert.ok(serialized.byteLength <= MAX_COMPRESSED_TRANSACTION_BYTES);
    totalOriginalBytes += serialized.byteLength;
    const expected = encodeBlockTransactionPayload(serialized, remaining);
    if (index === 0) {
      assert.match(expected.payload, /^b1:r:/u);
      assert.equal(expected.compressionInputBytes, serialized.byteLength);
    }
    assert.equal(transaction.payload === expected.payload, true, `transaction ${index} uses the bounded codec`);
    assert.deepEqual(decodeBlockTransactionPayload(expected.payload), normalized);
    if (expected.compressionInputBytes === 0) {
      assert.ok(serialized.byteLength > remaining);
      assert.match(expected.payload, /^b1:r:/u);
      skippedEligible += 1;
    }
    remaining -= expected.compressionInputBytes;
    attemptedBytes += expected.compressionInputBytes;
  }
  assert.ok(totalOriginalBytes > MAX_BLOCK_COMPRESSION_INPUT_BYTES);
  assert.ok(attemptedBytes <= MAX_BLOCK_COMPRESSION_INPUT_BYTES);
  assert.ok(skippedEligible > 0);
  assert.equal(remaining, MAX_BLOCK_COMPRESSION_INPUT_BYTES - attemptedBytes);
  assert.equal(snapshot.bytes, 64 + snapshot.transactions.reduce((sum, tx) =>
    sum + Buffer.byteLength(tx.signature, 'utf8') + (tx.payload?.length ?? 0) + 32, 0));
  const fresh = snapshotBlockTransactionData(loggedBlock(1, 'x'.repeat(4096)), 42n, 'CONFIRMED');
  assert.match(fresh?.transactions[0]?.payload ?? '', /^b1:d:/u);
});

void test('a low-level RPC gate preserves same-slot single-flight even when the block is not retained', async () => {
  const release = deferred<unknown>();
  let calls = 0;
  const gate = new ListenerRpcWorkGate();
  const gated = gateBlockTransactionRpc(gate, {
    async getBlockTransactions() {
      calls += 1;
      return release.promise;
    },
  });
  const locator = new CachedSolanaBlockTransactionLocator({
    httpTransportEpoch: 0,
    getBlockTransactions: gated.getBlockTransactions,
  }, { maxEntryBytes: 1 });

  const first = locator.locate(target());
  const joined = locator.locate(target());
  await flushMicrotasks();
  assert.equal(calls, 1);
  assert.equal(locator.metrics.inFlightJoins, 1);

  release.resolve(block());
  await Promise.all([first, joined]);
  assert.equal(calls, 1);
  assert.equal(locator.stats.entries, 0);
  locator.close();
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
  assert.deepEqual(h.locator.metrics.queueDelayMs, { last: 750, maximum: 750 });
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

void test('FIFO admission keeps exactly one slow block fetch active', async () => {
  const h = harness();
  const pending = new Map<bigint, ReturnType<typeof deferred<unknown>>>();
  let active = 0;
  let maximumActive = 0;
  h.setFetch(async (slot) => {
    const flight = deferred<unknown>();
    pending.set(slot, flight);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      return await flight.promise;
    } finally {
      active -= 1;
    }
  });

  const first = h.locator.locate(target('one', 42n));
  const second = h.locator.locate(target('one', 43n));
  await flushMicrotasks();

  assert.deepEqual(h.calls.map(({ slot }) => slot), [42n]);
  assert.equal(h.locator.metrics.inFlightFetches, 1);
  assert.equal(h.locator.metrics.queuedFetches, 1);
  const firstFlight = pending.get(42n);
  assert.ok(firstFlight);
  firstFlight.resolve(block(['one'], 42n));
  assert.equal((await first).slot, 42n);
  await flushMicrotasks();

  assert.deepEqual(h.calls.map(({ slot }) => slot), [42n, 43n]);
  assert.deepEqual(h.calls.map(({ time }) => time), [0, 250]);
  assert.equal(h.locator.metrics.inFlightFetches, 1);
  const secondFlight = pending.get(43n);
  assert.ok(secondFlight);
  secondFlight.resolve(block(['one'], 43n));
  assert.equal((await second).slot, 43n);
  assert.equal(maximumActive, 1);
});

void test('a failed admitted fetch releases the next FIFO admission', async () => {
  const h = harness();
  const pending = new Map<bigint, ReturnType<typeof deferred<unknown>>>();
  let active = 0;
  let maximumActive = 0;
  h.setFetch(async (slot) => {
    const flight = deferred<unknown>();
    pending.set(slot, flight);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      return await flight.promise;
    } finally {
      active -= 1;
    }
  });

  const first = h.locator.locate(target('one', 42n));
  const second = h.locator.locate(target('one', 43n));
  await flushMicrotasks();
  assert.deepEqual(h.calls.map(({ slot }) => slot), [42n]);

  const firstFlight = pending.get(42n);
  assert.ok(firstFlight);
  firstFlight.reject(new Error('provider unavailable'));
  await assert.rejects(first, RpcTransientError);
  await flushMicrotasks();
  assert.deepEqual(h.calls.map(({ slot }) => slot), [42n, 43n]);
  const secondFlight = pending.get(43n);
  assert.ok(secondFlight);
  secondFlight.resolve(block(['one'], 43n));
  assert.equal((await second).slot, 43n);
  assert.equal(maximumActive, 1);
});

void test('epoch changes invalidate cached entries and old in-flight responses cannot be retained', async () => {
  const h = harness();
  let release!: (value: unknown) => void;
  h.setFetch(async () => new Promise((resolve) => { release = resolve; }));
  const old = h.locator.locate(target());
  await flushMicrotasks();
  h.setEpoch(1);
  h.setFetch(async () => block());
  const fresh = h.locator.locate(target('two'));
  await flushMicrotasks();
  assert.equal(h.calls.length, 1);
  assert.equal(h.locator.metrics.inFlightFetches, 1);
  assert.equal(h.locator.metrics.queuedFetches, 1);
  release(block());
  await old;
  await fresh;
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
