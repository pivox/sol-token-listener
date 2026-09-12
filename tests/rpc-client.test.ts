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

void test('configures the mono-endpoint Connection exactly without injecting a custom fetch', () => {
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
    disableRetryOnRateLimit: true,
  });
  assert.deepEqual(Object.keys(mono), ['commitment', 'wsEndpoint', 'disableRetryOnRateLimit']);

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
  const epochsObservedByPublicEvents: number[] = [];
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
    onHttpFailoverEvent: (event) => {
      events.push(event);
      epochsObservedByPublicEvents.push(rpc.httpTransportEpoch);
    },
  });

  assert.equal(rpc.httpTransportEpoch, 0);
  assert.equal(await rpc.getSlot(), 42n);
  assert.equal(rpc.httpTransportEpoch, 1);
  const signatures = await rpc.http.getSignaturesForAddress(new PublicKey(new Uint8Array(32)));
  assert.equal(rpc.httpTransportEpoch, 1);

  assert.equal(fallbackCalls, 2);
  assert.equal(signatures[0]?.slot, 41);
  assert.deepEqual(calls, [primaryUrl, fallbackUrl, fallbackUrl]);
  assert.deepEqual(events, [
    { event: 'rpc.http_endpoint_degraded', endpointId: 'primary', reason: 'UNAVAILABLE', cooldownMs: 1000 },
    { event: 'rpc.http_failover', fromEndpointId: 'primary', toEndpointId: 'fallback-1', reason: 'UNAVAILABLE' },
  ]);
  assert.deepEqual(epochsObservedByPublicEvents, [0, 1]);
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

void test('uses web3 getBlock with the exact full-transaction source request', async () => {
  const calls: { readonly method: string; readonly params: readonly unknown[] }[] = [];
  const fetch: FetchFn = async (_input, init) => {
    const request = parseRequestBody(init) as {
      readonly id: string;
      readonly method: string;
      readonly params: readonly unknown[];
    };
    calls.push({ method: request.method, params: request.params });
    return jsonRpcResponse(request.id, {
      blockhash: '11111111111111111111111111111111',
      previousBlockhash: '11111111111111111111111111111111',
      parentSlot: 3,
      blockHeight: 4,
      transactions: [],
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

  const block = await rpc.getBlockTransactions(4n, 'FINALIZED');

  assert.ok(block);
  assert.deepEqual(calls, [{
    method: 'getBlock',
    params: [4, {
      commitment: 'finalized', transactionDetails: 'full',
      maxSupportedTransactionVersion: 0, rewards: false,
    }],
  }]);
});

void test('rejects non-bigint and out-of-range block slots before any RPC request', async () => {
  let fetchCalls = 0;
  const fetch: FetchFn = async (_input, init) => {
    fetchCalls += 1;
    const request = parseRequestBody(init) as { readonly id: string };
    return jsonRpcResponse(request.id, {
      blockhash: 'blockhash', previousBlockhash: 'previous-blockhash', parentSlot: 0,
      signatures: [], blockTime: null,
    });
  };
  const rpc = new SolanaRpcClient({
    httpRpcUrl: 'https://primary.invalid/rpc',
    httpRpcFallbackUrls: Object.freeze(['https://fallback.invalid/rpc']),
    wsRpcUrl: 'wss://websocket.invalid/rpc',
    commitment: 'confirmed',
    finality: 'finalized',
  }, { fetch });
  const getBlockSignatures = rpc.getBlockSignatures.bind(rpc) as (
    slot: unknown,
    confirmationStatus: 'FINALIZED',
  ) => Promise<unknown>;

  for (const slot of [4, '4', null, false, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
    await assert.rejects(getBlockSignatures(slot, 'FINALIZED'), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'Solana block slot is invalid.');
      return true;
    });
  }
  assert.equal(fetchCalls, 0);
});

function inputUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

void test('transport epoch follows sticky resets without relying on public failover events', async () => {
  let now = 0;
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const rpc = new SolanaRpcClient({
    httpRpcUrl: 'https://primary.invalid/rpc',
    httpRpcFallbackUrls: ['https://fallback.invalid/rpc'],
    wsRpcUrl: 'wss://websocket.invalid/rpc', commitment: 'confirmed', finality: 'finalized',
  }, {
    now: () => now,
    onHttpFailoverEvent: () => { throw new Error('untrusted observer'); },
    fetch: async (input, init) => {
      if (inputUrl(input).includes('primary')) {
        primaryCalls += 1;
        if (primaryCalls === 1) return new Response('unavailable', { status: 503 });
      } else {
        fallbackCalls += 1;
        if (fallbackCalls === 2) return new Response('bad request', { status: 400 });
      }
      const request = parseRequestBody(init) as { readonly id: string };
      return jsonRpcResponse(request.id, 42);
    },
  });
  await rpc.getSlot();
  assert.equal(rpc.httpTransportEpoch, 1);
  await assert.rejects(rpc.getSlot());
  assert.equal(rpc.httpTransportEpoch, 1);
  now = 1000;
  await rpc.getSlot();
  assert.equal(rpc.httpTransportEpoch, 2);
  assert.equal(primaryCalls, 2);
});

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
