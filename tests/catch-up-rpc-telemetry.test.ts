import assert from 'node:assert/strict';
import test from 'node:test';
import { Connection, PublicKey } from '@solana/web3.js';
import { CatchUpRpcTelemetry } from '../src/solana/rpc/catch-up-rpc-telemetry.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';

const marketRequest = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'getSignaturesForAddress',
  params: ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', { limit: 1_000 }],
});

void test('a 429 Retry-After is honored once and its retry/backoff is measured', async () => {
  let now = 10_000;
  const waits: number[] = [];
  let requests = 0;
  const telemetry = new CatchUpRpcTelemetry({
    fetch: async () => {
      requests += 1;
      return requests === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '2' } })
        : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 });
    },
    now: () => now,
    sleep: async (ms) => { waits.push(ms); now += ms; },
  });

  const response = await telemetry.fetch('https://rpc.invalid', {
    method: 'POST', body: marketRequest,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(waits, [2_000]);
  assert.deepEqual(telemetry.snapshot('market'), {
    requestCount: 2,
    http429Count: 1,
    retryCount: 1,
    retryBackoffTotalMs: 2_000,
    otherRpcErrors: 0,
  });
});

void test('repeated 429s stop after one retry and defer the next request to Retry-After', async () => {
  let now = 0;
  const waits: number[] = [];
  let requests = 0;
  const telemetry = new CatchUpRpcTelemetry({
    fetch: async () => {
      requests += 1;
      return new Response('', { status: 429, headers: { 'retry-after': '8' } });
    },
    now: () => now,
    sleep: async (ms) => { waits.push(ms); now += ms; },
  });

  const first = await telemetry.fetch('https://rpc.invalid', { method: 'POST', body: marketRequest });
  assert.equal(first.status, 429);
  assert.equal(requests, 1, 'long Retry-After is not retried inline');

  const second = await telemetry.fetch('https://rpc.invalid', { method: 'POST', body: marketRequest });
  assert.equal(second.status, 429);
  assert.equal(requests, 2);
  assert.deepEqual(waits, [8_000]);
  assert.equal(telemetry.snapshot('market').http429Count, 2);
  assert.equal(telemetry.snapshot('market').retryCount, 0);
  assert.equal(telemetry.snapshot('market').retryBackoffTotalMs, 8_000);
});

void test('JSON-RPC failures are counted without logging endpoint or response secrets', async () => {
  const telemetry = new CatchUpRpcTelemetry({
    fetch: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'limited' } }), { status: 200 }),
  });
  const response = await telemetry.fetch('https://rpc.invalid?token=sentinel-secret', {
    method: 'POST', body: marketRequest,
  });
  assert.equal(response.status, 200);
  assert.equal(telemetry.snapshot('market').otherRpcErrors, 1);
});

void test('the actual web3 catch-up Connection uses bounded retry instead of its default 429 retry burst', async () => {
  let now = 0;
  const waits: number[] = [];
  let requests = 0;
  const telemetry = new CatchUpRpcTelemetry({
    fetch: async (_input, init) => {
      requests += 1;
      assert.ok(init);
      assert.equal(typeof init.body, 'string');
      const id = JSON.parse(init.body as string).id;
      return requests === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '1' } })
        : new Response(JSON.stringify({ jsonrpc: '2.0', id, result: [] }), { status: 200 });
    },
    now: () => now,
    sleep: async (ms) => { waits.push(ms); now += ms; },
  });
  const connection = new Connection('https://rpc.invalid', {
    disableRetryOnRateLimit: true,
    fetch: (input, init) => telemetry.fetch(input, init),
  });

  const rows = await connection.getSignaturesForAddress(new PublicKey(PUMPSWAP_PROGRAM_ID), { limit: 1_000 }, 'finalized');

  assert.deepEqual(rows, []);
  assert.equal(requests, 2);
  assert.deepEqual(waits, [1_000]);
  assert.equal(telemetry.snapshot('market').http429Count, 1);
  assert.equal(telemetry.snapshot('market').retryCount, 1);
});
