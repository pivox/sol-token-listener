import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey, type FetchFn } from '@solana/web3.js';
import {
  SolanaRpcClient,
  createSolanaConnectionConfig,
  type SolanaRpcClientDependencies,
} from '../src/solana/rpc/rpc-client.js';
import type { RpcHttpFailoverEvent } from '../src/solana/rpc/http-failover-transport.js';

type FetchInput = Parameters<FetchFn>[0];

void test('keeps the exact legacy Connection config unless fallback transport is active', () => {
  const injectedFetch: FetchFn = async () => {
    throw new Error('must remain unused without fallbacks');
  };
  const base = {
    httpRpcUrl: 'https://primary.invalid/rpc',
    wsRpcUrl: 'wss://websocket.invalid/private',
    commitment: 'confirmed' as const,
  };

  const mono = createSolanaConnectionConfig(
    { ...base, httpRpcFallbackUrls: Object.freeze([]) },
    {
      fetch: injectedFetch,
      now: () => Number.NaN,
      onHttpFailoverEvent: 'invalid but inactive',
    } as unknown as SolanaRpcClientDependencies,
  );
  assert.deepEqual(mono, {
    commitment: 'confirmed',
    wsEndpoint: 'wss://websocket.invalid/private',
  });
  assert.deepEqual(Object.keys(mono), ['commitment', 'wsEndpoint']);

  const failover = createSolanaConnectionConfig(
    { ...base, httpRpcFallbackUrls: Object.freeze(['https://fallback.invalid/rpc']) },
    { fetch: injectedFetch },
  );
  assert.equal(failover.commitment, 'confirmed');
  assert.equal(failover.wsEndpoint, 'wss://websocket.invalid/private');
  assert.equal(typeof failover.fetch, 'function');
  assert.equal(failover.disableRetryOnRateLimit, true);
});

void test('fails over real client calls in order and shares the sticky HTTP transport', async () => {
  const primaryUrl = 'https://primary.invalid/rpc';
  const fallbackUrl = 'https://fallback.invalid/rpc';
  const calls: string[] = [];
  const events: RpcHttpFailoverEvent[] = [];
  let fallbackCalls = 0;
  const fetch: FetchFn = async (input, init) => {
    const url = inputUrl(input);
    calls.push(url);
    if (url === primaryUrl) return new Response('unavailable', { status: 503 });

    fallbackCalls += 1;
    const request = parseRequestBody(init) as { readonly id: string; readonly method: string };
    const result = request.method === 'getSlot'
      ? 42
      : [{
        signature: '1111111111111111111111111111111111111111111111111111111111111111',
        slot: 41,
        err: null,
        memo: null,
        blockTime: null,
        confirmationStatus: 'confirmed',
      }];
    return jsonRpcResponse(request.id, result);
  };
  const rpc = new SolanaRpcClient({
    httpRpcUrl: primaryUrl,
    httpRpcFallbackUrls: Object.freeze([fallbackUrl]),
    wsRpcUrl: 'wss://websocket.invalid/rpc',
    commitment: 'confirmed',
    finality: 'finalized',
  }, {
    fetch,
    now: () => 100,
    onHttpFailoverEvent: (event) => { events.push(event); },
  });

  assert.equal(await rpc.getSlot(), 42n);
  const signatures = await rpc.http.getSignaturesForAddress(new PublicKey(new Uint8Array(32)));

  assert.equal(fallbackCalls, 2);
  assert.equal(signatures[0]?.slot, 41);
  assert.deepEqual(calls, [primaryUrl, fallbackUrl, fallbackUrl]);
  assert.deepEqual(events, [
    { event: 'rpc.http_endpoint_degraded', endpointId: 'primary', reason: 'UNAVAILABLE', cooldownMs: 1000 },
    { event: 'rpc.http_failover', fromEndpointId: 'primary', toEndpointId: 'fallback-1', reason: 'UNAVAILABLE' },
  ]);
  assert.equal(events.every(Object.isFrozen), true);
});

void test('forwards web3 RequestInit and attempts a rate-limited primary exactly once', async () => {
  const primaryUrl = 'https://primary.invalid/rpc';
  const fallbackUrl = 'https://fallback.invalid/rpc';
  const calls: { readonly url: string; readonly init: Parameters<FetchFn>[1] }[] = [];
  const fetch: FetchFn = async (input, init) => {
    const url = inputUrl(input);
    calls.push({ url, init });
    if (url === primaryUrl) {
      return new Response('limited', { status: 429, headers: { 'retry-after': '2' } });
    }
    const request = parseRequestBody(init) as { readonly id: string };
    return jsonRpcResponse(request.id, 7);
  };
  const rpc = new SolanaRpcClient({
    httpRpcUrl: primaryUrl,
    httpRpcFallbackUrls: Object.freeze([fallbackUrl]),
    wsRpcUrl: 'wss://websocket.invalid/rpc',
    commitment: 'confirmed',
    finality: 'finalized',
  }, { fetch, now: () => 100 });

  assert.equal(await rpc.getSlot(), 7n);
  assert.deepEqual(calls.map(({ url }) => url), [primaryUrl, fallbackUrl]);
  assert.equal(calls.filter(({ url }) => url === primaryUrl).length, 1);
  for (const { init } of calls) {
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
    const body = parseRequestBody(init) as {
      readonly jsonrpc: string;
      readonly method: string;
      readonly params: readonly unknown[];
    };
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.method, 'getSlot');
    assert.deepEqual(body.params, [{ commitment: 'confirmed' }]);
  }
});

void test('uses web3 getBlockSignatures so getBlock receives its official signatures-only request and returns signatures', async () => {
  const calls: { readonly method: string; readonly params: readonly unknown[] }[] = [];
  const fetch: FetchFn = async (_input, init) => {
    const request = parseRequestBody(init) as {
      readonly id: string;
      readonly method: string;
      readonly params: readonly unknown[];
    };
    calls.push({ method: request.method, params: request.params });
    return jsonRpcResponse(request.id, {
      blockhash: 'blockhash',
      previousBlockhash: 'previous-blockhash',
      parentSlot: 3,
      signatures: ['signature-one', 'signature-two'],
      blockTime: null,
    });
  };
  const rpc = new SolanaRpcClient({
    httpRpcUrl: 'https://primary.invalid/rpc',
    httpRpcFallbackUrls: Object.freeze(['https://fallback.invalid/rpc']),
    wsRpcUrl: 'wss://websocket.invalid/rpc',
    commitment: 'confirmed',
    finality: 'finalized',
  }, { fetch });

  const signatures = await rpc.getBlockSignatures(4n, 'FINALIZED');

  assert.deepEqual(signatures, ['signature-one', 'signature-two']);
  assert.equal(Object.isFrozen(signatures), true);
  assert.deepEqual(calls, [{
    method: 'getBlock',
    params: [4, { commitment: 'finalized', transactionDetails: 'signatures', rewards: false }],
  }]);
});

function inputUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function parseRequestBody(init: Parameters<FetchFn>[1]): unknown {
  const body = init?.body;
  assert.ok(typeof body === 'string');
  return JSON.parse(body) as unknown;
}

function jsonRpcResponse(id: string, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
