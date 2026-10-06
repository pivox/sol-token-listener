import assert from 'node:assert/strict';
import test from 'node:test';
import { runNetworkPreflight, type PreflightMethod } from '../src/live/network-preflight.js';

const endpoint = 'https://rpc.invalid/?api-key=FAKE_PREFLIGHT_KEY_47f9';
const genesis = '11111111111111111111111111111111';

void test('network preflight makes at most three sequential read-only calls with an explicit timeout', async () => {
  const methods: PreflightMethod[] = [];
  const timeouts: number[] = [];
  const report = await runNetworkPreflight(endpoint, genesis, { request: async (_url, method, timeoutMs) => {
    methods.push(method);
    timeouts.push(timeoutMs);
    const result = method === 'getGenesisHash' ? genesis
      : method === 'getVersion' ? { 'solana-core': 'test-version' } : 42;
    return { httpStatus: 200, body: { jsonrpc: '2.0', id: 1, result } };
  } });
  assert.equal(report.status, 'PASS');
  assert.deepEqual(methods, ['getGenesisHash', 'getVersion', 'getSlot']);
  assert.deepEqual(timeouts, [5_000, 5_000, 5_000]);
  assert.equal(report.requestCount, 3);
  assert.equal(report.maxRequests, 3);
  assert.equal(report.endpoint, '[REDACTED]');
});

void test('transport failure keeps cause and reports no fabricated HTTP response', async () => {
  const sentinel = 'FAKE_PREFLIGHT_KEY_47f9';
  const error = Object.assign(new Error(`fetch failed ${endpoint}`), {
    cause: Object.assign(new Error(`connect ENETUNREACH ${endpoint}`), { code: 'ENETUNREACH' }),
  });
  const report = await runNetworkPreflight(endpoint, genesis, { request: async () => { throw error; } });
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.calls[0]?.status, 'TRANSPORT_ERROR');
  assert.equal(report.calls[0]?.httpStatus, null);
  assert.equal(report.calls[0]?.error?.code, 'ENETUNREACH');
  assert.match(report.calls[0]?.error?.message ?? '', /connect/u);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(sentinel, 'u'));
});

void test('HTTP refusal, JSON-RPC error, null result, and absent metadata remain distinct', async () => {
  const make = (response: unknown) => runNetworkPreflight(endpoint, genesis, { request: async () => response });
  const http = await make({ httpStatus: 403, body: 'refused' });
  const rpc = await make({ httpStatus: 200, body: { error: { code: -32005, message: 'rate limited' } } });
  const nullResult = await make({ httpStatus: 200, body: { result: null } });
  const missing = await make({ httpStatus: 200 });
  assert.equal(http.calls[0]?.status, 'HTTP_REJECTED');
  assert.equal(http.calls[0]?.httpStatus, 403);
  assert.equal(rpc.calls[0]?.status, 'JSON_RPC_ERROR');
  assert.equal(rpc.calls[0]?.error?.code, '-32005');
  assert.equal(nullResult.calls[0]?.status, 'RPC_NULL');
  assert.equal(missing.calls[0]?.status, 'METADATA_ABSENT');
});

void test('genesis mismatch blocks preflight after the first request', async () => {
  let calls = 0;
  const report = await runNetworkPreflight(endpoint, genesis, { request: async () => {
    calls++;
    return { httpStatus: 200, body: { result: 'different-genesis' } };
  } });
  assert.equal(report.status, 'BLOCKED');
  assert.equal(calls, 1);
  assert.equal(report.requestCount, 1);
});
