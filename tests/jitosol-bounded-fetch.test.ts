import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoundedFetch } from '../src/jitosol/bounded-fetch.js';

void test('bounded fetch returns complete JSON with HTTP metadata and forwards request data', async () => {
  const input = 'https://rpc.example/?api-key=fake-secret';
  const fetch = createBoundedFetch({ fetch: async (url, init) => {
    assert.equal(url, input);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.body, '{"jsonrpc":"2.0"}');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('x-test'), 'present');
    return Response.json({ result: 123 }, { status: 200, headers: { 'x-rpc': 'preserved' } });
  } });
  const response = await fetch(input, { method: 'POST', body: '{"jsonrpc":"2.0"}', headers: { 'x-test': 'present' }, redirect: 'follow' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-rpc'), 'preserved');
  assert.deepEqual(await response.json(), { result: 123 });
  assert.equal(response.bodyUsed, true);
});

void test('bounded fetch resolves only after the complete body and accepts exactly the size bound', async () => {
  let finish: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(Buffer.from('{"a":'));
    finish = (): void => { controller.enqueue(Buffer.from('1}')); controller.close(); };
  } });
  let resolved = false;
  const pending = createBoundedFetch({ maxResponseBytes: 7, fetch: async () => new Response(body) })('https://rpc.example')
    .then((response) => { resolved = true; return response; });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(resolved, false);
  assert.ok(finish); finish();
  assert.deepEqual(await (await pending).json(), { a: 1 });
});

void test('timeout covers stalled response body after headers and cancels the stream', async () => {
  let canceled = false;
  let aborted = false;
  const fetch = createBoundedFetch({ timeoutMs: 20, fetch: async (_input, init) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('{"partial":')); },
      cancel() { canceled = true; },
    }));
  } });
  await assert.rejects(fetch('https://rpc.example/secret'), { message: 'RPC request timed out' });
  assert.equal(canceled, true);
  assert.equal(aborted, true);
});

void test('timeout also bounds a fetch implementation that ignores cancellation before headers', async () => {
  const fetch = createBoundedFetch({ timeoutMs: 10, fetch: () => new Promise<Response>(() => {}) });
  await assert.rejects(fetch('https://rpc.example/secret'), { message: 'RPC request timed out' });
});

void test('oversized Content-Length rejects before reading and cancels body without exposing data', async () => {
  let canceled = false;
  const fetch = createBoundedFetch({ maxResponseBytes: 10, fetch: async () => new Response(new ReadableStream({
    cancel() { canceled = true; },
  }), { headers: { 'content-length': '11' } }) });
  await assert.rejects(fetch('https://rpc.example/secret'), { message: 'RPC response exceeds size limit' });
  assert.equal(canceled, true);
});

void test('streaming bound catches missing or understated Content-Length and cancels remainder', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    let canceled = false;
    const fetch = createBoundedFetch({ maxResponseBytes: 10, fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('123456')); controller.enqueue(Buffer.from('78901')); },
      cancel() { canceled = true; },
    }), { headers }) });
    await assert.rejects(fetch('https://rpc.example/secret'), { message: 'RPC response exceeds size limit' });
    assert.equal(canceled, true);
  }
});

void test('malformed Content-Length is rejected without exposing its text', async () => {
  const fetch = createBoundedFetch({ fetch: async () => new Response('{}', { headers: { 'content-length': 'secret' } }) });
  await assert.rejects(fetch('https://rpc.example'), { message: 'RPC invalid response length' });
});

void test('reconstructed response removes stale compression metadata', async () => {
  const fetch = createBoundedFetch({ fetch: async () => Response.json({ ok: true }, {
    headers: { 'content-encoding': 'gzip', 'content-length': '3' },
  }) });
  const response = await fetch('https://rpc.example');
  assert.equal(response.headers.get('content-encoding'), null);
  const body = await response.text();
  assert.equal(response.headers.get('content-length'), Buffer.byteLength(body).toString());
  assert.deepEqual(JSON.parse(body), { ok: true });
});

void test('default response bound allows 2MiB and rejects one byte more', async () => {
  for (const size of [2 * 1024 * 1024, 2 * 1024 * 1024 + 1]) {
    const fetch = createBoundedFetch({ fetch: async () => new Response(new Uint8Array(size)) });
    if (size === 2 * 1024 * 1024) assert.equal((await (await fetch('https://rpc.example')).arrayBuffer()).byteLength, size);
    else await assert.rejects(fetch('https://rpc.example'), { message: 'RPC response exceeds size limit' });
  }
});

void test('caller cancellation before start skips fetch and sanitizes arbitrary abort reasons', async () => {
  const controller = new AbortController(); controller.abort(new Error('secret-body-and-key'));
  let calls = 0;
  const fetch = createBoundedFetch({ fetch: async () => { calls++; return Response.json({}); } });
  await assert.rejects(fetch('https://rpc.example', { signal: controller.signal }), { message: 'RPC request aborted' });
  assert.equal(calls, 0);
});

void test('caller cancellation during body consumption cancels the body and propagates to underlying fetch', async () => {
  const controller = new AbortController();
  let canceled = false;
  let requestSignal: AbortSignal | null | undefined;
  const fetch = createBoundedFetch({ fetch: async (_input, init) => {
    requestSignal = init?.signal;
    return new Response(new ReadableStream({
      start(stream) { stream.enqueue(Buffer.from('{')); }, cancel() { canceled = true; },
    }));
  } });
  const result = fetch('https://rpc.example', { signal: controller.signal });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  controller.abort('secret abort reason');
  await assert.rejects(result, { message: 'RPC request aborted' });
  assert.equal(canceled, true);
  assert.equal(requestSignal?.aborted, true);
});

void test('a Request object signal is honored when no init signal is supplied', async () => {
  const controller = new AbortController();
  const request = new Request('https://rpc.example', { signal: controller.signal });
  const result = createBoundedFetch({ fetch: () => new Promise<Response>(() => {}) })(request);
  controller.abort();
  await assert.rejects(result, { message: 'RPC request aborted' });
});

void test('redirect responses and redirect-followed responses are rejected', async () => {
  const redirected = Response.json({}); Object.defineProperty(redirected, 'redirected', { value: true });
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/secret' } }), redirected]) {
    await assert.rejects(createBoundedFetch({ fetch: async () => response })('https://rpc.example'), { message: 'RPC redirect is not allowed' });
  }
});

void test('transport and stream errors never include original URL, key, body or cause', async () => {
  const secret = 'https://rpc.example/?api-key=fake-secret response-body-secret';
  for (const fetch of [
    createBoundedFetch({ fetch: async () => { throw new Error(secret); } }),
    createBoundedFetch({ fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(secret)); } })) }),
  ]) {
    await assert.rejects(fetch('https://rpc.example'), (error: Error) => {
      assert.equal(error.message, 'RPC request failed'); assert.equal(error.cause, undefined); return true;
    });
  }
});

void test('nonredirect HTTP errors and empty HTTP responses preserve their status', async () => {
  const failure = await createBoundedFetch({ fetch: async () => Response.json({ error: 'rate limited' }, { status: 429 }) })('https://rpc.example');
  assert.equal(failure.status, 429);
  assert.deepEqual(await failure.json(), { error: 'rate limited' });
  const empty = await createBoundedFetch({ fetch: async () => new Response(null, { status: 204 }) })('https://rpc.example');
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), '');
});

void test('invalid options fail synchronously without rendering their values', () => {
  for (const timeoutMs of [0, -1, NaN, 0.5, Infinity, 2 ** 31]) assert.throws(() => createBoundedFetch({ timeoutMs }), { message: 'Invalid bounded fetch timeout' });
  for (const maxResponseBytes of [0, -1, NaN, 0.5, Infinity]) assert.throws(() => createBoundedFetch({ maxResponseBytes }), { message: 'Invalid bounded fetch response limit' });
});
