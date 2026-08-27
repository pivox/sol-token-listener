import assert from 'node:assert/strict';
import test from 'node:test';
import type { FetchFn } from '@solana/web3.js';
import {
  RpcHttpEndpointsExhaustedError,
  createRpcHttpFailoverFetch,
  type RpcHttpEndpointId,
  type RpcHttpFailoverEvent,
  type RpcHttpFailureReason,
} from '../src/solana/rpc/http-failover-transport.js';

type FetchInput = Parameters<FetchFn>[0];

const endpoints = Object.freeze([
  Object.freeze({ id: 'primary' as const, url: 'https://user:primary-secret@primary.invalid/rpc-key' }),
  Object.freeze({ id: 'fallback-1' as const, url: 'https://user:fallback-secret@fallback.invalid/rpc-key' }),
  Object.freeze({ id: 'fallback-2' as const, url: 'https://third.invalid/private-token' }),
] as const);

void test('starts at the sticky healthy endpoint and rotates in circular order', async () => {
  const calls: string[] = [];
  const responses = [reply(503), reply(200), reply(502), reply(200)];
  const fetch = createRpcHttpFailoverFetch({
    endpoints,
    fetch: async (input) => {
      calls.push(inputUrl(input));
      const response = responses.shift();
      if (response === undefined) throw new Error('unexpected test call');
      return response;
    },
  });

  assert.equal((await fetch('https://ignored.invalid', { method: 'POST' })).status, 200);
  assert.equal((await fetch('https://ignored.invalid', { method: 'POST' })).status, 200);
  assert.deepEqual(calls, [
    endpoints[0].url,
    endpoints[1].url,
    endpoints[1].url,
    endpoints[2].url,
  ]);
});

void test('maps network rejection, degrades, fails over, and tries each endpoint at most once', async () => {
  const calls: string[] = [];
  const events: RpcHttpFailoverEvent[] = [];
  const fetch = createRpcHttpFailoverFetch({
    endpoints,
    fetch: async (input) => {
      calls.push(inputUrl(input));
      throw new Error('provider network secret');
    },
    onEvent: (event) => { events.push(event); },
  });

  await assert.rejects(fetch('https://request-secret.invalid'), assertExhausted);
  assert.deepEqual(calls, endpoints.map(({ url }) => url));
  assert.deepEqual(events, [
    { type: 'rpc.http_endpoint_degraded', endpointId: 'primary', reason: 'NETWORK', cooldownMs: 1000 },
    { type: 'rpc.http_failover', fromEndpointId: 'primary', toEndpointId: 'fallback-1', reason: 'NETWORK' },
    { type: 'rpc.http_endpoint_degraded', endpointId: 'fallback-1', reason: 'NETWORK', cooldownMs: 1000 },
    { type: 'rpc.http_failover', fromEndpointId: 'fallback-1', toEndpointId: 'fallback-2', reason: 'NETWORK' },
    { type: 'rpc.http_endpoint_degraded', endpointId: 'fallback-2', reason: 'NETWORK', cooldownMs: 1000 },
    { type: 'rpc.http_endpoints_exhausted', attemptedEndpointIds: ['primary', 'fallback-1', 'fallback-2'] },
  ]);
});

void test('maps every transient HTTP status and returns 400 without retrying', async () => {
  const cases: readonly [number, RpcHttpFailureReason][] = [
    [429, 'RATE_LIMITED'],
    [502, 'BAD_GATEWAY'],
    [503, 'UNAVAILABLE'],
    [504, 'GATEWAY_TIMEOUT'],
  ];

  for (const [status, reason] of cases) {
    const events: RpcHttpFailoverEvent[] = [];
    let calls = 0;
    const expected = reply(201);
    const fetch = createRpcHttpFailoverFetch({
      endpoints: endpoints.slice(0, 2),
      fetch: async () => (++calls === 1 ? reply(status) : expected),
      onEvent: (event) => { events.push(event); },
    });
    assert.equal(await fetch('https://ignored.invalid'), expected, String(status));
    assert.equal(events[0]?.type, 'rpc.http_endpoint_degraded');
    if (events[0]?.type === 'rpc.http_endpoint_degraded') assert.equal(events[0].reason, reason);
    assert.deepEqual(events[1], {
      type: 'rpc.http_failover',
      fromEndpointId: 'primary',
      toEndpointId: 'fallback-1',
      reason,
    });
  }

  let badRequestCalls = 0;
  const badRequest = reply(400);
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    fetch: async () => { badRequestCalls += 1; return badRequest; },
  });
  assert.equal(await fetch('https://ignored.invalid'), badRequest);
  assert.equal(badRequestCalls, 1);
});

void test('returns an HTTP 200 JSON-RPC error body untouched and unconsumed', async () => {
  const expected = new Response(JSON.stringify({
    jsonrpc: '2.0', id: 1, error: { message: 'private provider detail' },
  }), { status: 200 });
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    fetch: async () => expected,
  });

  const actual = await fetch('https://ignored.invalid');
  assert.equal(actual, expected);
  assert.equal(actual.bodyUsed, false);
  assert.deepEqual(await actual.json(), {
    jsonrpc: '2.0', id: 1, error: { message: 'private provider detail' },
  });
});

void test('uses strict Retry-After delta seconds, IMF-fixdate, past dates, fallback, and clamp', async () => {
  const base = Date.parse('Wed, 27 Aug 2025 10:00:00 GMT');
  const cases: readonly { readonly value: string; readonly expectedMs: number }[] = [
    { value: '2', expectedMs: 2000 },
    { value: 'Wed, 27 Aug 2025 10:00:30 GMT', expectedMs: 30000 },
    { value: 'Wed, 27 Aug 2025 09:59:30 GMT', expectedMs: 0 },
    { value: '2seconds', expectedMs: 1000 },
    { value: '02', expectedMs: 1000 },
    { value: 'Wed, 27 Aug 2025 10:02:00 GMT', expectedMs: 60000 },
    { value: '999999999999999999999999', expectedMs: 60000 },
  ];

  for (const entry of cases) {
    const events: RpcHttpFailoverEvent[] = [];
    let calls = 0;
    const fetch = createRpcHttpFailoverFetch({
      endpoints: endpoints.slice(0, 2),
      now: () => base,
      fetch: async () => (++calls === 1
        ? reply(429, { headers: { 'retry-after': entry.value } })
        : reply(200)),
      onEvent: (event) => { events.push(event); },
    });

    await fetch('https://ignored.invalid');
    assert.deepEqual(events[0], {
      type: 'rpc.http_endpoint_degraded',
      endpointId: 'primary',
      reason: 'RATE_LIMITED',
      cooldownMs: entry.expectedMs,
    }, entry.value);
  }
});

void test('ignores Retry-After on non-429 responses', async () => {
  const events: RpcHttpFailoverEvent[] = [];
  let calls = 0;
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    fetch: async () => (++calls === 1
      ? reply(503, { headers: { 'retry-after': '30' } })
      : reply(200)),
    onEvent: (event) => { events.push(event); },
  });

  await fetch('https://ignored.invalid');
  assert.deepEqual(events[0], {
    type: 'rpc.http_endpoint_degraded', endpointId: 'primary', reason: 'UNAVAILABLE', cooldownMs: 1000,
  });
});

void test('immediately exhausts with no attempts when every endpoint is cooling', async () => {
  let currentTime = 100;
  let calls = 0;
  const events: RpcHttpFailoverEvent[] = [];
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    now: () => currentTime,
    fetch: async () => { calls += 1; throw new Error('private'); },
    onEvent: (event) => { events.push(event); },
  });
  await assert.rejects(fetch('https://ignored.invalid'), assertExhausted);
  assert.equal(calls, 2);

  events.length = 0;
  currentTime = 500;
  await assert.rejects(fetch('https://ignored.invalid'), assertExhausted);
  assert.equal(calls, 2);
  assert.deepEqual(events, [{ type: 'rpc.http_endpoints_exhausted', attemptedEndpointIds: [] }]);
});

void test('best-effort cancels discarded responses and survives cancellation rejection', async () => {
  let firstCancelled = 0;
  let secondCancelled = 0;
  const first = responseWithCancelableBody(503, async () => { firstCancelled += 1; });
  const second = responseWithCancelableBody(504, async () => {
    secondCancelled += 1;
    throw new Error('private cancellation failure');
  });
  const expected = reply(200);
  const queue = [first, second, expected];
  const fetch = createRpcHttpFailoverFetch({
    endpoints,
    fetch: async () => {
      const response = queue.shift();
      if (response === undefined) throw new Error('unexpected test call');
      return response;
    },
  });

  assert.equal(await fetch('https://ignored.invalid'), expected);
  assert.equal(firstCancelled, 1);
  assert.equal(secondCancelled, 1);
});

void test('propagates an aborted fetch rejection unchanged and emits no events', async () => {
  const controller = new AbortController();
  const abortError = new Error('abort error includes request secret');
  const events: RpcHttpFailoverEvent[] = [];
  let calls = 0;
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    fetch: async () => {
      calls += 1;
      controller.abort();
      throw abortError;
    },
    onEvent: (event) => { events.push(event); },
  });

  await assert.rejects(fetch('https://ignored.invalid', { signal: controller.signal }), (error: unknown) => {
    assert.equal(error, abortError);
    return true;
  });
  assert.equal(calls, 1);
  assert.deepEqual(events, []);
});

void test('preserves method, headers, body, signal, and init while rewriting only the URL', async () => {
  const controller = new AbortController();
  const headers = new Headers({ 'content-type': 'application/json', authorization: 'private' });
  const body = JSON.stringify({ method: 'getSlot', secret: 'body-secret' });
  const init: RequestInit = { method: 'POST', headers, body, signal: controller.signal };
  const calls: { readonly input: FetchInput; readonly init?: RequestInit }[] = [];
  let count = 0;
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    fetch: async (input, receivedInit) => {
      calls.push(receivedInit === undefined ? { input } : { input, init: receivedInit });
      return ++count === 1 ? reply(503) : reply(200);
    },
  });

  await fetch('https://incoming.invalid/private', init);
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(inputUrl(call.input), endpoints[index]?.url);
    assert.equal(call.init, init);
    assert.equal(call.init?.method, 'POST');
    assert.equal(call.init?.headers, headers);
    assert.equal(call.init?.body, body);
    assert.equal(call.init?.signal, controller.signal);
  }
});

void test('preserves Request input semantics without consuming its body', async () => {
  const requestEndpoints = Object.freeze([
    Object.freeze({ id: 'primary' as const, url: 'https://primary.invalid/rpc-key' }),
    Object.freeze({ id: 'fallback-1' as const, url: 'https://fallback.invalid/rpc-key' }),
  ] as const);
  const controller = new AbortController();
  const input = new Request('https://incoming.invalid/private', {
    method: 'POST',
    headers: { authorization: 'private' },
    body: 'body-secret',
    signal: controller.signal,
  });
  const seen: Request[] = [];
  const fetch = createRpcHttpFailoverFetch({
    endpoints: requestEndpoints,
    fetch: async (received) => {
      assert.ok(received instanceof Request);
      seen.push(received);
      return reply(200);
    },
  });

  await fetch(input);
  assert.equal(input.bodyUsed, false);
  assert.equal(seen[0]?.url, requestEndpoints[0].url);
  assert.equal(seen[0]?.method, 'POST');
  assert.equal(seen[0]?.headers.get('authorization'), 'private');
  assert.equal(seen[0]?.signal.aborted, false);
  assert.equal(await seen[0]?.text(), 'body-secret');
});

void test('emits closed, frozen, fixed-ID events and a frozen redacted exhaustion error', async () => {
  const events: RpcHttpFailoverEvent[] = [];
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    fetch: async () => { throw new Error('provider hostname body-secret original-error'); },
    onEvent: (event) => { events.push(event); },
  });

  await assert.rejects(fetch('https://incoming-secret.invalid/key'), (error: unknown) => {
    assert.ok(error instanceof RpcHttpEndpointsExhaustedError);
    assert.equal(error.name, 'RpcHttpEndpointsExhaustedError');
    assert.equal(error.code, 'RPC_HTTP_ENDPOINTS_EXHAUSTED');
    assert.equal(error.message, 'All configured HTTP RPC endpoints are unavailable.');
    assert.equal(Object.isFrozen(error), true);
    assert.doesNotMatch(String(error), /secret|provider|hostname|original|invalid|rpc-key/iu);
    return true;
  });

  const allowedIds: readonly RpcHttpEndpointId[] = ['primary', 'fallback-1', 'fallback-2', 'fallback-3'];
  for (const event of events) {
    assert.equal(Object.isFrozen(event), true);
    assert.doesNotMatch(JSON.stringify(event), /secret|provider|hostname|original|invalid|rpc-key/iu);
    if (event.type === 'rpc.http_endpoint_degraded') assert.ok(allowedIds.includes(event.endpointId));
    if (event.type === 'rpc.http_failover') {
      assert.ok(allowedIds.includes(event.fromEndpointId));
      assert.ok(allowedIds.includes(event.toEndpointId));
    }
    if (event.type === 'rpc.http_endpoints_exhausted') {
      assert.equal(Object.isFrozen(event.attemptedEndpointIds), true);
    }
  }
});

void test('isolates callback failures from failover behavior', async () => {
  let calls = 0;
  const expected = reply(200);
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    fetch: async () => (++calls === 1 ? reply(503) : expected),
    onEvent: () => { throw new Error('callback failure'); },
  });

  assert.equal(await fetch('https://ignored.invalid'), expected);
  assert.equal(calls, 2);
});

void test('validates endpoint count, IDs, URLs, and uniqueness with fixed secret-free errors', () => {
  const cases: readonly { readonly endpoints: readonly unknown[]; readonly message: string }[] = [
    { endpoints: [], message: 'HTTP RPC failover requires between 2 and 4 endpoints.' },
    { endpoints: [endpoints[0]], message: 'HTTP RPC failover requires between 2 and 4 endpoints.' },
    { endpoints: [...endpoints, { id: 'fallback-3', url: 'https://four.invalid' }, { id: 'primary', url: 'https://five.invalid' }], message: 'HTTP RPC failover requires between 2 and 4 endpoints.' },
    { endpoints: [endpoints[0], { id: 'fallback-9', url: 'https://secret.invalid' }], message: 'HTTP RPC endpoint identifier is invalid.' },
    { endpoints: [endpoints[0], { id: 'primary', url: 'https://secret.invalid' }], message: 'HTTP RPC endpoint identifiers must be unique.' },
    { endpoints: [endpoints[0], { id: 'fallback-1', url: endpoints[0].url }], message: 'HTTP RPC endpoint URLs must be unique.' },
    { endpoints: [endpoints[0], { id: 'fallback-1', url: '' }], message: 'HTTP RPC endpoint URL is invalid.' },
    { endpoints: [endpoints[0], null], message: 'HTTP RPC endpoint is invalid.' },
  ];

  for (const entry of cases) {
    assert.throws(
      () => createRpcHttpFailoverFetch({ endpoints: entry.endpoints as never }),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.equal(error.message, entry.message);
        assert.doesNotMatch(String(error), /secret|primary\.invalid|rpc-key/iu);
        return true;
      },
    );
  }
});

void test('validates malformed options and injected functions with fixed errors', () => {
  const cases: readonly { readonly options: unknown; readonly message: string }[] = [
    { options: null, message: 'HTTP RPC failover options are invalid.' },
    { options: {}, message: 'HTTP RPC failover requires between 2 and 4 endpoints.' },
    { options: { endpoints, fetch: 1 }, message: 'HTTP RPC fetch is invalid.' },
    { options: { endpoints, now: 1 }, message: 'HTTP RPC clock is invalid.' },
    { options: { endpoints, onEvent: 1 }, message: 'HTTP RPC event callback is invalid.' },
  ];

  for (const entry of cases) {
    assert.throws(
      () => createRpcHttpFailoverFetch(entry.options as never),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.equal(error.message, entry.message);
        return true;
      },
    );
  }
});

void test('shares cooldown state so a later concurrent request avoids a just-degraded endpoint', async () => {
  let releasePrimary: (() => void) | undefined;
  const primaryStarted = new Promise<void>((resolve) => { releasePrimary = resolve; });
  let resolvePrimaryFailure: (() => void) | undefined;
  const primaryFailure = new Promise<void>((resolve) => { resolvePrimaryFailure = resolve; });
  const calls: string[] = [];
  let launchLater: (() => void) | undefined;
  const degraded = new Promise<void>((resolve) => { launchLater = resolve; });
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    fetch: async (input) => {
      const url = inputUrl(input);
      calls.push(url);
      if (url === endpoints[0].url) {
        releasePrimary?.();
        await primaryFailure;
        throw new Error('network');
      }
      return reply(200);
    },
    onEvent: (event) => {
      if (event.type === 'rpc.http_endpoint_degraded' && event.endpointId === 'primary') launchLater?.();
    },
  });

  const first = fetch('https://first.invalid');
  await primaryStarted;
  resolvePrimaryFailure?.();
  await degraded;
  const second = fetch('https://second.invalid');
  await Promise.all([first, second]);

  assert.deepEqual(calls, [endpoints[0].url, endpoints[1].url, endpoints[1].url]);
});

function reply(status: number, init: Omit<ResponseInit, 'status'> = {}): Response {
  return new Response(null, { ...init, status });
}

function responseWithCancelableBody(status: number, cancel: () => Promise<void>): Response {
  const body = new ReadableStream<Uint8Array>({ cancel });
  return new Response(body, { status });
}

function inputUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function assertExhausted(error: unknown): boolean {
  assert.ok(error instanceof RpcHttpEndpointsExhaustedError);
  assert.equal(error.code, 'RPC_HTTP_ENDPOINTS_EXHAUSTED');
  return true;
}

const _fetchTypeCheck: FetchFn = createRpcHttpFailoverFetch({ endpoints: endpoints.slice(0, 2) });
void _fetchTypeCheck;
