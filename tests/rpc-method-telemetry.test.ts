import assert from 'node:assert/strict';
import test from 'node:test';
import { RpcMethodTelemetry } from '../src/solana/rpc/rpc-method-telemetry.js';

function request(method: string): RequestInit {
  return { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) };
}

const ok = (): Response => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 });
const tooMany = (retryAfter?: string): Response => new Response('', {
  status: 429,
  ...(retryAfter === undefined ? {} : { headers: { 'retry-after': retryAfter } }),
});

void test('counts requests per JSON-RPC method', async () => {
  const telemetry = new RpcMethodTelemetry({ fetch: async () => ok() });

  await telemetry.fetch('https://rpc.invalid', request('getTransaction'));
  await telemetry.fetch('https://rpc.invalid', request('getTransaction'));
  await telemetry.fetch('https://rpc.invalid', request('getBlock'));

  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.getTransaction?.requestCount, 2);
  assert.equal(snapshot.getBlock?.requestCount, 1);
});

void test('a 429 honours Retry-After, retries, and records the backoff', async () => {
  let now = 0;
  const waits: number[] = [];
  const responses = [tooMany('1'), ok()];
  const telemetry = new RpcMethodTelemetry({
    fetch: async () => responses.shift() ?? ok(),
    now: () => now,
    sleep: async (ms) => { waits.push(ms); now += ms; },
  });

  const response = await telemetry.fetch('https://rpc.invalid', request('getBlock'));

  assert.equal(response.status, 200);
  assert.deepEqual(waits, [1_000]);
  assert.deepEqual(telemetry.snapshot().getBlock, {
    requestCount: 2,
    http429Count: 1,
    retryCount: 1,
    retryBackoffTotalMs: 1_000,
    otherRpcErrors: 0,
  });
});

void test('stops retrying after the inline retry budget and returns the 429', async () => {
  let now = 0;
  let calls = 0;
  const telemetry = new RpcMethodTelemetry({
    fetch: async () => { calls += 1; return tooMany(); },
    now: () => now,
    sleep: async (ms) => { now += ms; },
    maxInlineRetries: 2,
  });

  const response = await telemetry.fetch('https://rpc.invalid', request('getTransaction'));

  assert.equal(response.status, 429);
  assert.equal(calls, 3);
  assert.equal(telemetry.snapshot().getTransaction?.http429Count, 3);
});

void test('a 429 on one method defers the next request of any method', async () => {
  let now = 0;
  const waits: number[] = [];
  const responses = [tooMany('3')];
  const telemetry = new RpcMethodTelemetry({
    fetch: async () => responses.shift() ?? ok(),
    now: () => now,
    sleep: async (ms) => { waits.push(ms); now += ms; },
    maxInlineRetries: 0,
  });

  assert.equal((await telemetry.fetch('https://rpc.invalid', request('getBlock'))).status, 429);
  assert.equal((await telemetry.fetch('https://rpc.invalid', request('getSlot'))).status, 200);

  assert.deepEqual(waits, [3_000]);
  assert.equal(telemetry.snapshot().getSlot?.retryBackoffTotalMs, 3_000);
});

void test('counts HTTP and JSON-RPC errors without retrying them', async () => {
  const responses = [
    new Response('', { status: 503 }),
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32004 } }), { status: 200 }),
  ];
  const telemetry = new RpcMethodTelemetry({ fetch: async () => responses.shift() ?? ok() });

  await telemetry.fetch('https://rpc.invalid', request('getBlock'));
  await telemetry.fetch('https://rpc.invalid', request('getBlock'));

  assert.equal(telemetry.snapshot().getBlock?.otherRpcErrors, 2);
  assert.equal(telemetry.snapshot().getBlock?.requestCount, 2);
});

void test('requests without a readable method are counted as unknown', async () => {
  const telemetry = new RpcMethodTelemetry({ fetch: async () => ok() });

  await telemetry.fetch('https://rpc.invalid', { method: 'POST', body: '[{"method":"getSlot"}]' });

  assert.equal(telemetry.snapshot().unknown?.requestCount, 1);
});
