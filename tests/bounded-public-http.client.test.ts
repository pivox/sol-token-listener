import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BoundedPublicHttpClient,
  type HostResolver,
  type PublicHttpTransport,
  type PublicHttpTransportRequest,
  type PublicHttpTransportResponse,
} from '../src/metadata/bounded-public-http.client.js';

const OPTIONS = Object.freeze({
  timeoutMs: 100,
  maxBytes: 64,
  maxRedirects: 2,
  maxConcurrency: 2,
  maxPerHostConcurrency: 1 as const,
});

void test('pins one validated public address and validates every redirect hop', async () => {
  const transport = scriptedTransport([
    response(302, '', { location: 'https://next.example/private' }),
  ]);
  const client = new BoundedPublicHttpClient(
    transport.request,
    sequenceResolver([['93.184.216.34'], ['127.0.0.1']]),
    OPTIONS,
  );

  assert.deepEqual(await client.get('https://public.example/start', ['text/html']), {
    status: 'FAILED', reason: 'UNSAFE_DESTINATION', retryable: false,
  });
  assert.deepEqual(transport.addresses, ['93.184.216.34']);
});

void test('rejects every non-public range and mixed DNS answers before transport', async () => {
  const unsafe = [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1',
    '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.168.0.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff00::1',
    '2001:db8::1',
  ] as const;
  for (const address of unsafe) {
    let calls = 0;
    const client = new BoundedPublicHttpClient(async () => {
      calls += 1;
      return response(200, 'ok', { 'content-type': 'text/plain' });
    }, async () => [address], OPTIONS);
    assert.deepEqual(await client.get('https://example.test', ['text/plain']), {
      status: 'FAILED', reason: 'UNSAFE_DESTINATION', retryable: false,
    }, address);
    assert.equal(calls, 0, address);
  }

  const mixed = new BoundedPublicHttpClient(async () => {
    throw new Error('transport must not run');
  }, async () => ['93.184.216.34', '127.0.0.1'], OPTIONS);
  assert.equal((await mixed.get('https://example.test', ['text/plain'])).status, 'FAILED');
});

void test('rejects invalid URLs, credentials and unsupported schemes with redacted failures', async () => {
  const transport: PublicHttpTransport = async () => {
    throw new Error('transport must not run');
  };
  const client = new BoundedPublicHttpClient(transport, publicResolver, OPTIONS);
  const cases = [
    ['not a url', 'URL_INVALID'],
    ['ftp://example.test/a', 'SCHEME_UNSUPPORTED'],
    ['https://user:secret@example.test/private', 'UNSAFE_DESTINATION'],
  ] as const;
  for (const [url, reason] of cases) {
    const result = await client.get(url, ['text/plain']);
    assert.deepEqual(result, { status: 'FAILED', reason, retryable: false });
    assert.doesNotMatch(JSON.stringify(result), /secret|private|93\.184/iu);
  }
});

void test('enforces redirect, status, type, length, stream and UTF-8 bounds', async () => {
  const cases = [
    [response(302, '', {}), 'REDIRECT_INVALID'],
    [response(404, 'no', { 'content-type': 'text/plain' }), 'HTTP_STATUS_INVALID'],
    [response(200, '{}', { 'content-type': 'image/png' }), 'CONTENT_TYPE_UNSUPPORTED'],
    [response(200, '{}', { 'content-type': 'application/json', 'content-length': '65' }), 'CONTENT_TOO_LARGE'],
    [response(200, 'x'.repeat(65), { 'content-type': 'text/plain' }), 'CONTENT_TOO_LARGE'],
    [response(200, new Uint8Array([0xc3, 0x28]), { 'content-type': 'text/plain' }), 'UTF8_INVALID'],
  ] as const;
  for (const [reply, reason] of cases) {
    const client = new BoundedPublicHttpClient(scriptedTransport([reply]).request, publicResolver, OPTIONS);
    const result = await client.get('https://example.test/a', ['text/plain', 'application/json']);
    assert.deepEqual(result, { status: 'FAILED', reason, retryable: false });
  }

  const redirects = scriptedTransport([
    response(302, '', { location: '/two' }),
    response(302, '', { location: '/three' }),
    response(302, '', { location: '/four' }),
  ]);
  const limited = new BoundedPublicHttpClient(redirects.request, publicResolver, OPTIONS);
  assert.deepEqual(await limited.get('https://example.test/one', ['text/plain']), {
    status: 'FAILED', reason: 'REDIRECT_LIMIT_EXCEEDED', retryable: false,
  });
});

void test('returns only bounded success data and requests identity encoding', async () => {
  const transport = scriptedTransport([
    response(200, 'hello', { 'content-type': 'text/plain; charset=utf-8' }),
  ]);
  const client = new BoundedPublicHttpClient(transport.request, publicResolver, OPTIONS);
  const result = await client.get('https://example.test/a', ['text/plain']);

  assert.deepEqual(result, {
    status: 'SUCCEEDED',
    finalUrl: 'https://example.test/a',
    httpStatus: 200,
    contentType: 'text/plain',
    redirectCount: 0,
    body: new TextEncoder().encode('hello'),
  });
  assert.equal(transport.requests[0]?.headers['accept-encoding'], 'identity');
  assert.equal(transport.requests[0]?.address, '93.184.216.34');
});

void test('marks DNS, timeout and network failures retryable without leaking causes', async () => {
  const dns = new BoundedPublicHttpClient(async () => response(200, 'ok'), async () => {
    throw new Error('dns-secret.example');
  }, OPTIONS);
  assert.deepEqual(await dns.get('https://example.test', ['text/plain']), {
    status: 'FAILED', reason: 'DNS_FAILED', retryable: true,
  });

  for (const code of ['TIMEOUT', 'NETWORK_FAILED'] as const) {
    const client = new BoundedPublicHttpClient(async () => {
      const error = new Error('socket secret') as Error & { code?: string };
      error.code = code === 'TIMEOUT' ? 'ABORT_ERR' : 'ECONNRESET';
      throw error;
    }, publicResolver, OPTIONS);
    const result = await client.get('https://example.test', ['text/plain']);
    assert.deepEqual(result, { status: 'FAILED', reason: code, retryable: true });
    assert.doesNotMatch(JSON.stringify(result), /socket|secret/iu);
  }
});

void test('bounds global concurrency and serializes requests to one host', async () => {
  let active = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  const transport: PublicHttpTransport = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    return response(200, 'ok', { 'content-type': 'text/plain' });
  };
  const client = new BoundedPublicHttpClient(transport, publicResolver, OPTIONS);
  const requests = [
    client.get('https://a.test/1', ['text/plain']),
    client.get('https://a.test/2', ['text/plain']),
    client.get('https://b.test/1', ['text/plain']),
  ];
  await tick();
  assert.equal(active, 2);
  assert.equal(peak, 2);
  releases.splice(0).forEach((release) => { release(); });
  await tick();
  assert.equal(active, 1);
  releases.splice(0).forEach((release) => { release(); });
  await Promise.all(requests);
  assert.equal(peak, 2);
});

void test('keeps timeout and per-host serialization active while streaming the body', async () => {
  const slow = new BoundedPublicHttpClient(async () => Object.freeze({
    statusCode: 200,
    headers: Object.freeze({ 'content-type': 'text/plain' }),
    body: delayedChunks(20, new TextEncoder().encode('ok')),
  }), publicResolver, Object.freeze({ ...OPTIONS, timeoutMs: 5 }));
  assert.deepEqual(await slow.get('https://a.test/slow', ['text/plain']), {
    status: 'FAILED', reason: 'TIMEOUT', retryable: true,
  });

  let calls = 0;
  let releaseBody: (() => void) | undefined;
  const blocking: PublicHttpTransport = async () => {
    calls += 1;
    return response(200, calls === 1
      ? blockingChunks(new Promise<void>((resolve) => { releaseBody = resolve; }))
      : 'second', { 'content-type': 'text/plain' });
  };
  const client = new BoundedPublicHttpClient(blocking, publicResolver, OPTIONS);
  const first = client.get('https://a.test/first', ['text/plain']);
  await tick();
  const second = client.get('https://a.test/second', ['text/plain']);
  await tick();
  assert.equal(calls, 1);
  releaseBody?.();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
});

void test('validates configuration and accepted media types', async () => {
  assert.throws(() => new BoundedPublicHttpClient(async () => response(200, ''), publicResolver, {
    ...OPTIONS, timeoutMs: 0,
  }), /timeout/iu);
  const client = new BoundedPublicHttpClient(async () => response(200, ''), publicResolver, OPTIONS);
  await assert.rejects(() => client.get('https://example.test', []), /content|media|type/iu);
});

const publicResolver: HostResolver = async () => ['93.184.216.34'];

function sequenceResolver(values: readonly (readonly string[])[]): HostResolver {
  let index = 0;
  return async () => values[Math.min(index++, values.length - 1)] ?? [];
}

function response(
  statusCode: number,
  body: string | Uint8Array | AsyncIterable<Uint8Array>,
  headers: Readonly<Record<string, string>> = { 'content-type': 'text/plain' },
): PublicHttpTransportResponse {
  const stream = typeof body === 'string'
    ? chunks(new TextEncoder().encode(body))
    : body instanceof Uint8Array ? chunks(body) : body;
  return Object.freeze({ statusCode, headers: Object.freeze({ ...headers }), body: stream });
}

async function* chunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

async function* delayedChunks(delayMs: number, bytes: Uint8Array): AsyncIterable<Uint8Array> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  yield bytes;
}

async function* blockingChunks(gate: Promise<void>): AsyncIterable<Uint8Array> {
  await gate;
  yield new TextEncoder().encode('first');
}

function scriptedTransport(replies: readonly PublicHttpTransportResponse[]): Readonly<{
  request: PublicHttpTransport;
  requests: readonly PublicHttpTransportRequest[];
  addresses: readonly string[];
}> {
  const requests: PublicHttpTransportRequest[] = [];
  let index = 0;
  return {
    request: async (request) => {
      requests.push(request);
      const reply = replies[index++];
      if (reply === undefined) throw new Error('unexpected request');
      return reply;
    },
    requests,
    get addresses() { return requests.map((request) => request.address); },
  };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
