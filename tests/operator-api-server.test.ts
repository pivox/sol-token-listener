import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import test from 'node:test';
import { encodeLedgerCursor } from '../src/api/cursor.js';
import type { LiveOverviewPage, LiveOverviewRequest } from '../src/operator-api/repository.js';
import { createOperatorApiHandler } from '../src/operator-api/server.js';

const TOKEN = 't'.repeat(32);
const ORIGIN = 'http://127.0.0.1:4173';

const page: LiveOverviewPage = {
  data: {
    availability: 'AVAILABLE',
    wallet: '11111111111111111111111111111111',
    balance: { lamports: 2_500_000_000n, observedAt: '2026-10-06T11:59:57.000Z' },
    open: [],
    history: [],
    totals: { realizedLamports: -4_205n, unrealizedLamports: 0n, openCount: 0, positionsWithoutPnl: 0 },
  },
  nextCursor: 'next',
};

interface Started {
  readonly requests: LiveOverviewRequest[];
  readonly errors: string[];
  readonly send: (options: {
    readonly method?: string; readonly path?: string; readonly headers?: Record<string, string>;
    readonly host?: string;
  }) => Promise<{ readonly status: number; readonly headers: Record<string, unknown>; readonly body: string }>;
  readonly close: () => Promise<void>;
}

async function start(read?: () => Promise<LiveOverviewPage>): Promise<Started> {
  const requests: LiveOverviewRequest[] = [];
  const errors: string[] = [];
  const server: Server = createServer();
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const allowedHost = `127.0.0.1:${String(address.port)}`;
  server.on('request', createOperatorApiHandler({
    token: TOKEN, allowedHost, allowedOrigin: ORIGIN, now: () => Date.parse('2026-10-06T12:00:00.000Z'),
    overview: { read: (input) => { requests.push(input); return (read ?? (() => Promise.resolve(page)))(); } },
    logError: (name) => { errors.push(name); },
  }));
  return {
    requests, errors,
    send: (options) => new Promise((resolve, reject) => {
      const outgoing = httpRequest({
        host: '127.0.0.1', port: address.port, method: options.method ?? 'GET',
        path: options.path ?? '/operator/v1/live/overview',
        headers: { host: options.host ?? allowedHost, ...options.headers },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        incoming.once('end', () => {
          resolve({
            status: incoming.statusCode ?? 0, headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      outgoing.once('error', reject);
      outgoing.end();
    }),
    close: () => new Promise((resolve) => { server.close(() => { resolve(); }); server.closeAllConnections(); }),
  };
}

const authorized = { authorization: `Bearer ${TOKEN}` };

void test('serves the overview in the public envelope with decimal-string amounts for one origin', async () => {
  const api = await start();
  try {
    const response = await api.send({ path: '/operator/v1/live/overview?limit=20', headers: authorized });

    assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(response.body), {
      apiVersion: 'v1',
      meta: { generatedAt: '2026-10-06T12:00:00.000Z', nextCursor: 'next' },
      data: {
        availability: 'AVAILABLE', wallet: '11111111111111111111111111111111',
        balance: { lamports: '2500000000', observedAt: '2026-10-06T11:59:57.000Z' },
        open: [], history: [],
        totals: { realizedLamports: '-4205', unrealizedLamports: '0', openCount: 0, positionsWithoutPnl: 0 },
      },
    });
    assert.deepEqual(api.requests, [{ limit: 20, cursor: null }]);
  } finally { await api.close(); }
});

void test('rejects a missing, malformed or wrong bearer token before reading anything', async () => {
  const api = await start();
  try {
    for (const headers of [
      {}, { authorization: TOKEN }, { authorization: `Basic ${TOKEN}` },
      { authorization: `Bearer ${TOKEN}x` }, { authorization: 'Bearer ' }, { authorization: `bearer ${TOKEN}` },
    ]) {
      const response = await api.send({ headers });
      assert.equal(response.status, 401, JSON.stringify(headers));
      assert.equal(JSON.parse(response.body).error.code, 'UNAUTHORIZED');
    }
    assert.deepEqual(api.requests, []);
  } finally { await api.close(); }
});

void test('only accepts the exact Host header', async () => {
  const api = await start();
  try {
    for (const host of ['evil.example', 'localhost:3100', '127.0.0.1']) {
      const response = await api.send({ host, headers: authorized });
      assert.equal(response.status, 421, host);
      assert.equal(JSON.parse(response.body).error.code, 'HOST_NOT_ALLOWED');
    }
    assert.deepEqual(api.requests, []);
  } finally { await api.close(); }
});

void test('answers the CORS preflight for the console origin, allowing Authorization, and nothing else', async () => {
  const api = await start();
  try {
    const response = await api.send({ method: 'OPTIONS', headers: {
      origin: ORIGIN, 'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    } });
    assert.equal(response.status, 204);
    assert.equal(response.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(response.headers['access-control-allow-methods'], 'GET, OPTIONS');
    assert.equal(response.headers['access-control-allow-headers'], 'Authorization');
    assert.equal(response.body, '');
    assert.notEqual(response.headers['access-control-allow-origin'], '*');
  } finally { await api.close(); }
});

void test('serves only GET and OPTIONS on the single overview route', async () => {
  const api = await start();
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const response = await api.send({ method, headers: authorized });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.allow, 'GET, OPTIONS');
    }
    const missing = await api.send({ path: '/operator/v1/live/other', headers: authorized });
    assert.equal(missing.status, 404);
    assert.deepEqual(api.requests, []);
  } finally { await api.close(); }
});

void test('validates limit and cursor and forwards the decoded keyset', async () => {
  const api = await start();
  try {
    for (const query of ['limit=0', 'limit=101', 'limit=abc', 'limit=10.5']) {
      const response = await api.send({ path: `/operator/v1/live/overview?${query}`, headers: authorized });
      assert.equal(response.status, 400, query);
      assert.equal(JSON.parse(response.body).error.code, 'INVALID_LIMIT');
    }
    const bad = await api.send({ path: '/operator/v1/live/overview?cursor=not-a-cursor', headers: authorized });
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).error.code, 'INVALID_CURSOR');
    const cursor = encodeLedgerCursor({ closedAtMs: 1_780_000_000_000, id: 'execution_live_position_a' });
    const ok = await api.send({ path: `/operator/v1/live/overview?limit=100&cursor=${cursor}`, headers: authorized });
    assert.equal(ok.status, 200);
    assert.deepEqual(api.requests, [{
      limit: 100, cursor: { closedAtMs: 1_780_000_000_000, id: 'execution_live_position_a' },
    }]);
  } finally { await api.close(); }
});

void test('a failing reader returns a redacted 500 and logs only the error name', async () => {
  const api = await start(() => Promise.reject(new TypeError('connection string postgres://secret')));
  try {
    const response = await api.send({ headers: authorized });
    assert.equal(response.status, 500);
    assert.equal(JSON.parse(response.body).error.code, 'INTERNAL_ERROR');
    assert.equal(response.body.includes('secret'), false);
    assert.deepEqual(api.errors, ['TypeError']);
    const next = await api.send({ headers: authorized });
    assert.equal(next.status, 500);
  } finally { await api.close(); }
});

void test('serializes concurrent overview reads', async () => {
  let active = 0;
  let peak = 0;
  const api = await start(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
    active -= 1;
    return page;
  });
  try {
    const responses = await Promise.all([1, 2, 3].map(() => api.send({ headers: authorized })));
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
    assert.equal(peak, 1);
  } finally { await api.close(); }
});

void test('the 401 carries the console origin so the browser can tell it from a network error', async () => {
  const api = await start();
  try {
    const response = await api.send({});
    assert.equal(response.status, 401);
    assert.equal(response.headers['access-control-allow-origin'], ORIGIN);
  } finally { await api.close(); }
});

void test('an unknown path without a token is a 401, not a 404, and never reaches the reader', async () => {
  const api = await start();
  try {
    for (const path of ['/operator/v1/live/other', '/', 'http://evil.example/operator/v1/live/overview']) {
      const response = await api.send({ path });
      assert.equal(response.status, 401, path);
    }
    assert.deepEqual(api.requests, []);
  } finally { await api.close(); }
});

void test('a failed read does not poison the queue for the next request', async () => {
  let calls = 0;
  const api = await start(() => {
    calls += 1;
    return calls === 1 ? Promise.reject(new TypeError('boom')) : Promise.resolve(page);
  });
  try {
    assert.equal((await api.send({ headers: authorized })).status, 500);
    assert.equal((await api.send({ headers: authorized })).status, 200);
  } finally { await api.close(); }
});

void test('with a valid token only an exact origin-form overview target is routed', async () => {
  const api = await start();
  try {
    for (const path of [
      'http://evil.example/operator/v1/live/overview', '//x/operator/v1/live/overview',
      'http://[/', '*', '/operator/v1/x/../live/overview', '/operator/v1/live/%2e/overview',
      '/operator/v1/live/overview/', '/operator/v1/live/%6fverview',
    ]) {
      const response = await api.send({ path, headers: authorized });
      assert.equal(response.status, 404, path);
      assert.equal(JSON.parse(response.body).error.code, 'ROUTE_NOT_FOUND', path);
    }
    assert.deepEqual(api.requests, []);
    assert.deepEqual(api.errors, []);
  } finally { await api.close(); }
});
