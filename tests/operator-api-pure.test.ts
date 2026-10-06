import assert from 'node:assert/strict';
import test from 'node:test';
import { createBalanceCache } from '../src/operator-api/balance-cache.js';
import { spotValueLamports, unrealizedLamports } from '../src/operator-api/pnl.js';
import { createRpcBalanceReader } from '../src/operator-api/rpc-balance.js';

const WALLET = '11111111111111111111111111111111';

void test('spot value multiplies before dividing and rounds down', () => {
  // 2.8e-5 lamport per raw unit: a per-unit price would round down to zero.
  const reserves = { quoteReservesRaw: 30_000_000_000n, baseReservesRaw: 1_073_000_000_000_000n };
  assert.equal(spotValueLamports(35_000_000_000n, reserves), 978_564n);
  assert.equal(spotValueLamports(0n, reserves), 0n);
  assert.equal(spotValueLamports(1n, { quoteReservesRaw: 1n, baseReservesRaw: 3n }), 0n);
});

void test('spot value is unavailable without usable reserves', () => {
  assert.equal(spotValueLamports(10n, null), null);
  assert.equal(spotValueLamports(10n, { quoteReservesRaw: 5n, baseReservesRaw: 0n }), null);
});

void test('unrealized PnL is the spot value minus cost and stays unknown without a spot value', () => {
  assert.equal(unrealizedLamports(978_564n, 1_005_000n), -26_436n);
  assert.equal(unrealizedLamports(1_200_000n, 1_005_000n), 195_000n);
  assert.equal(unrealizedLamports(null, 1_005_000n), null);
});

void test('the balance cache serves 15 s from memory and shares one in-flight RPC', async () => {
  let nowMs = 1_000;
  let calls = 0;
  let release: (value: bigint) => void = () => undefined;
  const cache = createBalanceCache({
    now: () => nowMs,
    fetchLamports: () => {
      calls += 1;
      return new Promise<bigint>((resolve) => { release = resolve; });
    },
  });

  const first = cache.read(WALLET);
  const second = cache.read(WALLET);
  assert.equal(calls, 1);
  release(5_000_000_000n);
  assert.deepEqual(await first, { lamports: 5_000_000_000n, observedAtMs: 1_000 });
  assert.equal(await second, await first);

  nowMs = 15_999;
  assert.deepEqual(await cache.read(WALLET), { lamports: 5_000_000_000n, observedAtMs: 1_000 });
  assert.equal(calls, 1);

  nowMs = 16_000;
  const refreshed = cache.read(WALLET);
  assert.equal(calls, 2);
  release(6_000_000_000n);
  assert.deepEqual(await refreshed, { lamports: 6_000_000_000n, observedAtMs: 16_000 });
});

void test('the balance cache keeps the last known value on RPC failure and is null before any success', async () => {
  let nowMs = 0;
  let fail = true;
  const cache = createBalanceCache({
    now: () => nowMs,
    fetchLamports: () => (fail ? Promise.reject(new Error('429')) : Promise.resolve(7n)),
  });

  assert.equal(await cache.read(WALLET), null);
  fail = false;
  assert.deepEqual(await cache.read(WALLET), { lamports: 7n, observedAtMs: 0 });
  fail = true;
  nowMs = 20_000;
  assert.deepEqual(await cache.read(WALLET), { lamports: 7n, observedAtMs: 0 });
});

void test('the RPC balance reader asks getBalance only and parses a safe integer', async () => {
  const requests: { readonly url: string; readonly body: unknown }[] = [];
  const respond = (payload: unknown, status = 200) => (
    url: string | URL | Request, init?: RequestInit,
  ): Promise<Response> => {
    assert.equal(typeof url, 'string');
    assert.equal(typeof init?.body, 'string');
    requests.push({ url: url as string, body: JSON.parse(init?.body as string) as unknown });
    return Promise.resolve(new Response(JSON.stringify(payload), { status }));
  };
  const read = createRpcBalanceReader({
    rpcUrl: 'https://rpc.example',
    fetchFn: respond({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: 1_234_567_890 } }),
  });

  assert.equal(await read(WALLET), 1_234_567_890n);
  assert.deepEqual(requests, [{
    url: 'https://rpc.example',
    body: {
      jsonrpc: '2.0', id: 1, method: 'getBalance',
      params: [WALLET, { commitment: 'confirmed' }],
    },
  }]);
  for (const payload of [{ result: { value: -1 } }, { result: { value: 1.5 } }, { error: {} }, null]) {
    await assert.rejects(createRpcBalanceReader({ rpcUrl: 'https://rpc.example', fetchFn: respond(payload) })(WALLET));
  }
  await assert.rejects(createRpcBalanceReader({
    rpcUrl: 'https://rpc.example', fetchFn: respond({}, 429),
  })(WALLET));
});
