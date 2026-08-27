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

  assert.equal((await fetch(endpoints[0].url, { method: 'POST' })).status, 200);
  assert.equal((await fetch(endpoints[0].url, { method: 'POST' })).status, 200);
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

  await assert.rejects(fetch(endpoints[0].url), assertExhausted);
  assert.deepEqual(calls, endpoints.map(({ url }) => url));
  assert.deepEqual(events, [
    { event: 'rpc.http_endpoint_degraded', endpointId: 'primary', reason: 'NETWORK', cooldownMs: 1000 },
    { event: 'rpc.http_failover', fromEndpointId: 'primary', toEndpointId: 'fallback-1', reason: 'NETWORK' },
    { event: 'rpc.http_endpoint_degraded', endpointId: 'fallback-1', reason: 'NETWORK', cooldownMs: 1000 },
    { event: 'rpc.http_failover', fromEndpointId: 'fallback-1', toEndpointId: 'fallback-2', reason: 'NETWORK' },
    { event: 'rpc.http_endpoint_degraded', endpointId: 'fallback-2', reason: 'NETWORK', cooldownMs: 1000 },
    { event: 'rpc.http_endpoints_exhausted', attemptedEndpointIds: ['primary', 'fallback-1', 'fallback-2'] },
  ]);
});

void test('maps every transient status and does not rotate 400, 401, 403, or 418', async () => {
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
    assert.equal(await fetch(endpoints[0].url), expected, String(status));
    assert.equal(events[0]?.event, 'rpc.http_endpoint_degraded');
    if (events[0]?.event === 'rpc.http_endpoint_degraded') assert.equal(events[0].reason, reason);
    assert.deepEqual(events[1], {
      event: 'rpc.http_failover',
      fromEndpointId: 'primary',
      toEndpointId: 'fallback-1',
      reason,
    });
  }

  for (const status of [400, 401, 403, 418]) {
    let nonTransientCalls = 0;
    const expected = reply(status);
    const fetch = createRpcHttpFailoverFetch({
      endpoints: endpoints.slice(0, 2),
      fetch: async () => { nonTransientCalls += 1; return expected; },
    });
    assert.equal(await fetch(endpoints[0].url), expected);
    assert.equal(nonTransientCalls, 1, String(status));
  }
});

void test('returns an HTTP 200 JSON-RPC error body untouched and unconsumed', async () => {
  const expected = new Response(JSON.stringify({
    jsonrpc: '2.0', id: 1, error: { message: 'private provider detail' },
  }), { status: 200 });
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    fetch: async () => expected,
  });

  const actual = await fetch(endpoints[0].url);
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

    await fetch(endpoints[0].url);
    assert.deepEqual(events[0], {
      event: 'rpc.http_endpoint_degraded',
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

  await fetch(endpoints[0].url);
  assert.deepEqual(events[0], {
    event: 'rpc.http_endpoint_degraded', endpointId: 'primary', reason: 'UNAVAILABLE', cooldownMs: 1000,
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
  await assert.rejects(fetch(endpoints[0].url), assertExhausted);
  assert.equal(calls, 2);

  events.length = 0;
  currentTime = 500;
  await assert.rejects(fetch(endpoints[0].url), assertExhausted);
  assert.equal(calls, 2);
  assert.deepEqual(events, [{ event: 'rpc.http_endpoints_exhausted', attemptedEndpointIds: [] }]);
});

void test('makes an endpoint eligible again exactly when its cooldown expires', async () => {
  let currentTime = 0;
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const calls: string[] = [];
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    now: () => currentTime,
    fetch: async (input) => {
      const url = inputUrl(input);
      calls.push(url);
      if (url === endpoints[0].url) {
        primaryCalls += 1;
        if (primaryCalls === 1) throw new Error('network');
        return reply(200);
      }
      fallbackCalls += 1;
      return fallbackCalls === 1 ? reply(200) : reply(503);
    },
  });

  await fetch(endpoints[0].url);
  currentTime = 500;
  await assert.rejects(fetch(endpoints[0].url), assertExhausted);
  currentTime = 1000;
  assert.equal((await fetch(endpoints[0].url)).status, 200);
  assert.deepEqual(calls, [
    endpoints[0].url,
    endpoints[1].url,
    endpoints[1].url,
    endpoints[0].url,
  ]);
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

  assert.equal(await fetch(endpoints[0].url), expected);
  assert.equal(firstCancelled, 1);
  assert.equal(secondCancelled, 1);
});

void test('does not let a never-settling cancellation delay a healthy fallback', async () => {
  let cancelCalls = 0;
  let fallbackCalls = 0;
  const transient = responseWithCancelableBody(503, () => {
    cancelCalls += 1;
    return new Promise<void>(() => undefined);
  });
  const expected = reply(200);
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    fetch: async (input) => {
      if (inputUrl(input) === endpoints[0].url) return transient;
      fallbackCalls += 1;
      return expected;
    },
  });

  const pending = fetch(endpoints[0].url);
  await Promise.resolve();
  assert.equal(cancelCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(await pending, expected);
});

void test('contains a synchronous cancellation throw and still attempts fallback', async () => {
  let cancelCalls = 0;
  let calls = 0;
  const transient = {
    status: 503,
    headers: new Headers(),
    body: {
      cancel: (): Promise<void> => {
        cancelCalls += 1;
        throw new Error('private synchronous cancellation');
      },
    },
  } as unknown as Response;
  const expected = reply(200);
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    fetch: async () => (++calls === 1 ? transient : expected),
  });

  assert.equal(await fetch(endpoints[0].url), expected);
  assert.equal(cancelCalls, 1);
  assert.equal(calls, 2);
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

  await assert.rejects(fetch(endpoints[0].url, { signal: controller.signal }), (error: unknown) => {
    assert.equal(error, abortError);
    return true;
  });
  assert.equal(calls, 1);
  assert.deepEqual(events, []);
});

void test('propagates init signal reason when abort follows a transient response resolution', async () => {
  const requestController = new AbortController();
  const initController = new AbortController();
  const abortReason = new Error('private abort reason');
  const events: RpcHttpFailoverEvent[] = [];
  let calls = 0;
  const input = new Request('https://primary.invalid/rpc', {
    method: 'POST', body: 'body-secret', signal: requestController.signal,
  });
  const fetch = createRpcHttpFailoverFetch({
    endpoints: [
      { id: 'primary', url: 'https://primary.invalid/rpc' },
      { id: 'fallback-1', url: 'https://fallback.invalid/rpc' },
    ],
    fetch: async () => {
      calls += 1;
      initController.abort(abortReason);
      return reply(503);
    },
    onEvent: (event) => { events.push(event); },
  });

  await assert.rejects(fetch(input, { signal: initController.signal }), (error: unknown) => {
    assert.equal(error, abortReason);
    return true;
  });
  assert.equal(input.bodyUsed, false);
  assert.equal(requestController.signal.aborted, false);
  assert.equal(calls, 1);
  assert.deepEqual(events, []);
});

void test('cancels a response discarded because its signal aborted during fetch resolution', async () => {
  const controller = new AbortController();
  const abortReason = new Error('private post-response abort reason');
  const events: RpcHttpFailoverEvent[] = [];
  let calls = 0;
  let cancelCalls = 0;
  const transient = responseWithCancelableBody(503, () => {
    cancelCalls += 1;
    return new Promise<void>(() => undefined);
  });
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    fetch: async () => {
      calls += 1;
      controller.abort(abortReason);
      return transient;
    },
    onEvent: (event) => { events.push(event); },
  });

  await assert.rejects(fetch(endpoints[0].url, { signal: controller.signal }), (error: unknown) => {
    assert.equal(error, abortReason);
    return true;
  });
  assert.equal(cancelCalls, 1);
  assert.equal(calls, 1);
  assert.deepEqual(events, []);
});

void test('propagates abort during pending cancellation without failover or fallback fetch', async () => {
  const controller = new AbortController();
  const abortReason = new Error('private cancellation abort reason');
  const events: RpcHttpFailoverEvent[] = [];
  let calls = 0;
  let cancelCalls = 0;
  const transient = responseWithCancelableBody(503, () => {
    cancelCalls += 1;
    controller.abort(abortReason);
    return new Promise<void>(() => undefined);
  });
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    fetch: async () => { calls += 1; return transient; },
    onEvent: (event) => { events.push(event); },
  });

  const noOutcome = Symbol('no outcome');
  let outcome: unknown = noOutcome;
  void fetch(endpoints[0].url, { signal: controller.signal }).then(
    () => { outcome = new Error('unexpected resolution'); },
    (error: unknown) => { outcome = error; },
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(outcome, abortReason);
  assert.equal(cancelCalls, 1);
  assert.equal(calls, 1);
  assert.equal(events.some((event) => event.event === 'rpc.http_failover'), false);
  assert.doesNotMatch(JSON.stringify(events), /private|cancellation abort/iu);
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

  await fetch(endpoints[0].url, init);
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

void test('preserves a Request POST body across actual failover without consuming the input', async () => {
  const requestEndpoints = Object.freeze([
    Object.freeze({ id: 'primary' as const, url: 'https://primary.invalid/rpc-key' }),
    Object.freeze({ id: 'fallback-1' as const, url: 'https://fallback.invalid/rpc-key' }),
  ] as const);
  const controller = new AbortController();
  const input = new Request(requestEndpoints[0].url, {
    method: 'POST',
    headers: { authorization: 'private' },
    body: 'body-secret',
    signal: controller.signal,
  });
  const seen: {
    readonly url: string;
    readonly method: string;
    readonly authorization: string | null;
    readonly body: string;
    readonly aborted: boolean;
  }[] = [];
  const fetch = createRpcHttpFailoverFetch({
    endpoints: requestEndpoints,
    fetch: async (received) => {
      assert.ok(received instanceof Request);
      seen.push({
        url: received.url,
        method: received.method,
        authorization: received.headers.get('authorization'),
        body: await received.text(),
        aborted: received.signal.aborted,
      });
      return seen.length === 1 ? reply(503) : reply(200);
    },
  });

  await fetch(input);
  assert.equal(input.bodyUsed, false);
  assert.deepEqual(seen, [
    {
      url: requestEndpoints[0].url,
      method: 'POST',
      authorization: 'private',
      body: 'body-secret',
      aborted: false,
    },
    {
      url: requestEndpoints[1].url,
      method: 'POST',
      authorization: 'private',
      body: 'body-secret',
      aborted: false,
    },
  ]);
});

void test('rejects a non-primary string or Request input without fetching, events, or body use', async () => {
  let calls = 0;
  const events: RpcHttpFailoverEvent[] = [];
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    fetch: async () => { calls += 1; return reply(200); },
    onEvent: (event) => { events.push(event); },
  });
  const mismatchedRequest = new Request('https://request-secret.invalid/private', {
    method: 'POST', body: 'body-secret',
  });

  for (const input of ['https://arbitrary-secret.invalid/key', mismatchedRequest]) {
    await assert.rejects(fetch(input), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'HTTP RPC request URL must match the configured primary endpoint.');
      assert.doesNotMatch(String(error), /secret|arbitrary|invalid|key|body/iu);
      return true;
    });
  }
  assert.equal(mismatchedRequest.bodyUsed, false);
  assert.equal(calls, 0);
  assert.deepEqual(events, []);
});

void test('emits closed, frozen, fixed-ID events and a frozen redacted exhaustion error', async () => {
  const events: RpcHttpFailoverEvent[] = [];
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    fetch: async () => { throw new Error('provider hostname body-secret original-error'); },
    onEvent: (event) => { events.push(event); },
  });

  await assert.rejects(fetch(endpoints[0].url), (error: unknown) => {
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
    if (event.event === 'rpc.http_endpoint_degraded') assert.ok(allowedIds.includes(event.endpointId));
    if (event.event === 'rpc.http_failover') {
      assert.ok(allowedIds.includes(event.fromEndpointId));
      assert.ok(allowedIds.includes(event.toEndpointId));
    }
    if (event.event === 'rpc.http_endpoints_exhausted') {
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

  assert.equal(await fetch(endpoints[0].url), expected);
  assert.equal(calls, 2);
});

void test('validates endpoint count, positional IDs, and canonical URL uniqueness with fixed errors', () => {
  const cases: readonly { readonly endpoints: readonly unknown[]; readonly message: string }[] = [
    { endpoints: [], message: 'HTTP RPC failover requires between 2 and 4 endpoints.' },
    { endpoints: [endpoints[0]], message: 'HTTP RPC failover requires between 2 and 4 endpoints.' },
    { endpoints: [...endpoints, { id: 'fallback-3', url: 'https://four.invalid' }, { id: 'primary', url: 'https://five.invalid' }], message: 'HTTP RPC failover requires between 2 and 4 endpoints.' },
    { endpoints: [endpoints[0], { id: 'fallback-9', url: 'https://secret.invalid' }], message: 'HTTP RPC endpoint identifier is invalid.' },
    { endpoints: [endpoints[0], { id: 'primary', url: 'https://secret.invalid' }], message: 'HTTP RPC endpoint identifiers must be unique.' },
    { endpoints: [endpoints[1], endpoints[0]], message: 'HTTP RPC endpoint identifier does not match its position.' },
    { endpoints: [endpoints[0], endpoints[2]], message: 'HTTP RPC endpoint identifier does not match its position.' },
    { endpoints: [endpoints[0], { id: 'fallback-1', url: endpoints[0].url }], message: 'HTTP RPC endpoint URLs must be unique.' },
    { endpoints: [{ id: 'primary', url: 'https://same.invalid' }, { id: 'fallback-1', url: 'https://same.invalid/' }], message: 'HTTP RPC endpoint URLs must be unique.' },
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

void test('canonicalizes configured and incoming URLs before matching and attempts', async () => {
  const canonicalEndpoints = Object.freeze([
    Object.freeze({ id: 'primary' as const, url: 'https://PRIMARY.invalid:443' }),
    Object.freeze({ id: 'fallback-1' as const, url: 'https://FALLBACK.invalid:443/rpc' }),
  ] as const);
  const calls: string[] = [];
  const fetch = createRpcHttpFailoverFetch({
    endpoints: canonicalEndpoints,
    fetch: async (input) => {
      calls.push(inputUrl(input));
      return calls.length === 1 ? reply(503) : reply(200);
    },
  });

  await fetch(new URL('https://primary.invalid/'));
  assert.deepEqual(calls, ['https://primary.invalid/', 'https://fallback.invalid/rpc']);
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

void test('deduplicates concurrent degradation and retains the longest cooldown deadline', async () => {
  const firstPrimary = deferred<Response>();
  const secondPrimary = deferred<Response>();
  const calls: string[] = [];
  const events: RpcHttpFailoverEvent[] = [];
  let currentTime = 0;
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const fetch = createRpcHttpFailoverFetch({
    endpoints: endpoints.slice(0, 2),
    now: () => currentTime,
    fetch: async (input) => {
      const url = inputUrl(input);
      calls.push(url);
      if (url === endpoints[0].url) {
        primaryCalls += 1;
        if (primaryCalls === 1) return firstPrimary.promise;
        if (primaryCalls === 2) return secondPrimary.promise;
        return reply(200);
      }
      fallbackCalls += 1;
      return fallbackCalls <= 2 ? reply(200) : reply(503);
    },
    onEvent: (event) => { events.push(event); },
  });

  const first = fetch(endpoints[0].url);
  const second = fetch(endpoints[0].url);
  assert.equal(primaryCalls, 2);
  firstPrimary.reject(new Error('network'));
  await first;
  currentTime = 100;
  secondPrimary.resolve(reply(429, { headers: { 'retry-after': '5' } }));
  await second;

  const primaryDegraded = events.filter((event) => (
    event.event === 'rpc.http_endpoint_degraded' && event.endpointId === 'primary'
  ));
  assert.deepEqual(primaryDegraded, [{
    event: 'rpc.http_endpoint_degraded',
    endpointId: 'primary',
    reason: 'NETWORK',
    cooldownMs: 1000,
  }]);

  currentTime = 2000;
  await assert.rejects(fetch(endpoints[0].url), assertExhausted);
  assert.equal(primaryCalls, 2);
  currentTime = 5100;
  assert.equal((await fetch(endpoints[0].url)).status, 200);
  assert.equal(primaryCalls, 3);
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value: T): void => { resolvePromise?.(value); },
    reject: (error: unknown): void => { rejectPromise?.(error); },
  };
}

const _fetchTypeCheck: FetchFn = createRpcHttpFailoverFetch({ endpoints: endpoints.slice(0, 2) });
void _fetchTypeCheck;
