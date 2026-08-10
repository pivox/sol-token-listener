import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import test from 'node:test';
import { encodeStreamCursor } from '../src/api/cursor.js';
import { toApiDomainPayload, type ApiDomainEvent } from '../src/api/contracts.js';
import { SseSession } from '../src/interfaces/http/sse-session.js';
import { createApiRouter, type ApiRouter } from '../src/interfaces/http/api-router.js';
import type { ApiEventStreamRepository, ApiStreamRevision } from '../src/ports/api-event-stream-repository.js';
import { ApiEventStreamCursorExpiredError } from '../src/ports/api-event-stream-repository.js';
import type { ApiProjectionRepository } from '../src/ports/api-projection-repository.js';

class FakeResponse extends EventEmitter {
  public readonly chunks: string[] = [];
  public readonly headers: Record<string, string> = {};
  public ended = false;
  public writeHead(status: number, headers: Record<string, string>): this {
    assert.equal(status, 200);
    Object.assign(this.headers, headers);
    return this;
  }
  public flushHeaders(): void {}
  public write(chunk: string): boolean { this.chunks.push(chunk); return true; }
  public end(): this { this.ended = true; return this; }
}

class BackpressureResponse extends FakeResponse {
  public blocked = true;
  public destroyed = false;
  public destroyCalls = 0;

  public override write(chunk: string): boolean {
    this.chunks.push(chunk);
    return !this.blocked;
  }

  public destroy(): this {
    this.destroyCalls += 1;
    this.destroyed = true;
    return this;
  }
}

class FakeTimers {
  private nextId = 1;
  private readonly timers = new Map<number, () => void>();
  public schedule = (callback: () => void): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, callback);
    return id;
  };
  public cancel = (id: unknown): void => { if (typeof id === 'number') this.timers.delete(id); };
  public runOne(): void {
    const next = this.timers.entries().next().value as [number, () => void] | undefined;
    if (next === undefined) throw new Error('No timer scheduled');
    this.timers.delete(next[0]);
    next[1]();
  }
}

const event = (eventId: string): ApiDomainEvent => ({
  eventId, type: 'TokenLaunchDetected', mint: 'mint', source: 'source', program: 'program', signature: 'sig',
  cursor: { slot: '1', transactionIndex: '0', instructionIndex: '0', innerInstructionIndex: null },
  confirmationStatus: 'confirmed', blockchainTime: null, observedAt: '2026-07-29T00:00:00.000Z',
  payloadVersion: 1, payload: {} as ApiDomainEvent['payload'],
});

function makeSseRouter(stream: ApiEventStreamRepository): ApiRouter {
  return createApiRouter({
    projections: {} as ApiProjectionRepository,
    now: () => 0, defaultLimit: 1, maximumLimit: 1, correlationId: () => 'test', logError: () => {},
    stream, sse: { batchSize: 2, pollIntervalMs: 50, heartbeatIntervalMs: 50,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs), cancel: (timer) => { clearTimeout(timer as NodeJS.Timeout); } },
  });
}

async function openServer(router: ApiRouter): Promise<Readonly<{ server: Server; port: number }>> {
  const server = createServer((incoming, outgoing) => { void router(incoming, outgoing); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP server address');
  return { server, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if (error === undefined) resolve(); else reject(error);
  }));
}

async function requestResult(
  port: number,
  method: string,
  headers: Readonly<OutgoingHttpHeaders>,
  body?: string,
): Promise<Readonly<{ status: number; headers: IncomingMessage['headers']; body: string }>> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path: '/api/v1/events', method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      response.once('error', reject);
      response.once('end', () => { resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    outgoing.once('error', reject);
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => { reject(new Error(`${label} timed out`)); }, 500);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

void test('SseSession streams ascending revisions with sequence transport ids', async () => {
  const timers = new FakeTimers();
  const response = new FakeResponse();
  const reads: bigint[] = [];
  const revisions: readonly ApiStreamRevision[] = [
    { sequence: 3n, streamEventId: 'stream-3', event: event('domain-1') },
    { sequence: 4n, streamEventId: 'stream-4', event: event('domain-1') },
  ];
  const stream: ApiEventStreamRepository = {
    async highWaterMark() { return 0n; },
    async resolve() { return { status: 'CURRENT' as const, sequence: 0n }; },
    async readAfter(after) { reads.push(after); return revisions; },
  };
  const session = new SseSession({
    stream, response: response as unknown as ServerResponse, startAfter: 2n, batchSize: 10,
    pollIntervalMs: 10, heartbeatIntervalMs: 100, schedule: timers.schedule, cancel: timers.cancel,
    onClosed: () => undefined,
  });

  session.start();
  timers.runOne();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(reads, [2n]);
  assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.match(response.chunks.join(''), new RegExp(`id: ${encodeStreamCursor(3n)}`, 'u'));
  assert.match(response.chunks.join(''), new RegExp(`id: ${encodeStreamCursor(4n)}`, 'u'));
  assert.match(response.chunks.join(''), /"eventId":"domain-1"/u);
  await session.close('SERVER');
});

void test('events route resolves a missing cursor at the high-water mark before SSE headers', async () => {
  let highWaterCalls = 0;
  const stream: ApiEventStreamRepository = {
    async highWaterMark() { highWaterCalls += 1; return 7n; },
    async resolve() { throw new Error('must not resolve an absent cursor'); },
    async readAfter() { return []; },
  };
  const router = createApiRouter({
    projections: {} as ApiProjectionRepository,
    now: () => 0, defaultLimit: 1, maximumLimit: 1, correlationId: () => 'test', logError: () => {},
    stream, sse: { batchSize: 1, pollIntervalMs: 50, heartbeatIntervalMs: 50,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs), cancel: (timer) => { clearTimeout(timer as NodeJS.Timeout); } },
  });
  const server = createServer((incoming, outgoing) => { void router(incoming, outgoing); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP server address');
  try {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = httpRequest({ host: '127.0.0.1', port: address.port, path: '/api/v1/events', method: 'HEAD',
        headers: { accept: 'application/json, Text/Event-Stream; charset=utf-8' } }, resolve);
      outgoing.once('error', reject);
      outgoing.end();
    });
    await new Promise<void>((resolve) => response.resume().once('end', resolve));
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(highWaterCalls, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve(); else reject(error);
    }));
  }
});

void test('SseSession exposes an expired cursor as a redacted stream error after headers', async () => {
  const timers = new FakeTimers();
  const response = new FakeResponse();
  const session = new SseSession({
    stream: {
      async highWaterMark() { return 0n; }, async resolve() { return { status: 'CURRENT' as const, sequence: 0n }; },
      async readAfter() { throw new ApiEventStreamCursorExpiredError(); },
    },
    response: response as unknown as ServerResponse, startAfter: 0n, batchSize: 1,
    pollIntervalMs: 10, heartbeatIntervalMs: 100, schedule: timers.schedule, cancel: timers.cancel,
    onClosed: () => undefined,
  });
  session.start();
  timers.runOne();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(response.chunks.join(''), /"code":"EVENT_CURSOR_EXPIRED"/u);
  assert.equal(response.ended, true);
});

void test('events route rejects an SSE media range disabled by q=0', async () => {
  const stream: ApiEventStreamRepository = {
    async highWaterMark() { return 0n; }, async resolve() { return { status: 'CURRENT' as const, sequence: 0n }; },
    async readAfter() { return []; },
  };
  const router = createApiRouter({
    projections: {} as ApiProjectionRepository,
    now: () => 0, defaultLimit: 1, maximumLimit: 1, correlationId: () => 'test', logError: () => {},
    stream, sse: { batchSize: 1, pollIntervalMs: 50, heartbeatIntervalMs: 50,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs), cancel: (timer) => { clearTimeout(timer as NodeJS.Timeout); } },
  });
  const server = createServer((incoming, outgoing) => { void router(incoming, outgoing); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP server address');
  try {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = httpRequest({ host: '127.0.0.1', port: address.port, path: '/api/v1/events', method: 'HEAD',
        headers: { accept: 'application/json, text/event-stream; q=0' } }, resolve);
      outgoing.once('error', reject);
      outgoing.end();
    });
    await new Promise<void>((resolve) => response.resume().once('end', resolve));
    assert.equal(response.statusCode, 406);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve(); else reject(error);
    }));
  }
});

void test('SseSession rejects repository batches larger than its configured limit without emitting rows', async () => {
  const timers = new FakeTimers();
  const response = new FakeResponse();
  const session = new SseSession({
    stream: {
      async highWaterMark() { return 0n; }, async resolve() { return { status: 'CURRENT' as const, sequence: 0n }; },
      async readAfter() { return [
        { sequence: 1n, streamEventId: 'stream-1', event: event('domain-1') },
        { sequence: 2n, streamEventId: 'stream-2', event: event('domain-2') },
      ]; },
    },
    response: response as unknown as ServerResponse, startAfter: 0n, batchSize: 1,
    pollIntervalMs: 10, heartbeatIntervalMs: 100, schedule: timers.schedule, cancel: timers.cancel,
    onClosed: () => undefined,
  });
  session.start();
  timers.runOne();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const output = response.chunks.join('');
  assert.doesNotMatch(output, /id: /u);
  assert.match(output, /"code":"DEPENDENCY_UNAVAILABLE"/u);
  assert.equal(response.ended, true);
});

void test('SseSession waits for drain without overlapping polls and closes idempotently', async () => {
  const timers = new FakeTimers();
  const response = new BackpressureResponse();
  let reads = 0;
  let closed = 0;
  const session = new SseSession({
    stream: {
      async highWaterMark() { return 0n; }, async resolve() { return { status: 'CURRENT' as const, sequence: 0n }; },
      async readAfter() { reads += 1; return [{ sequence: 1n, streamEventId: 'stream-1', event: event('event-1') }]; },
    },
    response: response as unknown as ServerResponse, startAfter: 0n, batchSize: 1,
    pollIntervalMs: 10, heartbeatIntervalMs: 100, schedule: timers.schedule, cancel: timers.cancel,
    onClosed: () => { closed += 1; },
  });
  session.start();
  timers.runOne();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  timers.runOne();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  response.blocked = false;
  response.emit('drain');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const firstClose = session.close('SERVER');
  const secondClose = session.close('SERVER');
  assert.equal(firstClose, secondClose);
  await firstClose;
  assert.equal(closed, 1);
  assert.equal((response.chunks.join('').match(/event: server_shutdown/gu) ?? []).length, 1);
});

void test('events route validates cursor, negotiation, body, CORS, HEAD, and OPTIONS over node:http', async () => {
  const resolved: bigint[] = [];
  const stream: ApiEventStreamRepository = {
    async highWaterMark() { return 7n; },
    async resolve(sequence) {
      resolved.push(sequence);
      if (sequence === 8n) return { status: 'FUTURE' as const };
      if (sequence === 9n) return { status: 'EXPIRED' as const };
      return { status: 'CURRENT' as const, sequence };
    },
    async readAfter() { return []; },
  };
  const { server, port } = await openServer(makeSseRouter(stream));
  try {
    const accept = { accept: 'text/event-stream' };
    const invalidCases: readonly [string, OutgoingHttpHeaders, number][] = [
      ['missing accept', {}, 406],
      ['disabled accept', { accept: 'text/event-stream; Q=0' }, 406],
      ['invalid q', { accept: 'text/event-stream; q=1.1' }, 406],
      ['duplicate q', { accept: 'text/event-stream; q=1; Q=0.5' }, 406],
      ['deceptive token', { accept: 'text/event-streaming' }, 406],
      ['empty cursor', { ...accept, 'last-event-id': '' }, 400],
      ['malformed cursor', { ...accept, 'last-event-id': 'not-a-cursor' }, 400],
      ['oversized cursor', { ...accept, 'last-event-id': 'a'.repeat(2_049) }, 400],
      ['duplicate cursor', { ...accept, 'last-event-id': [encodeStreamCursor(1n), encodeStreamCursor(2n)] }, 400],
      ['future cursor', { ...accept, 'last-event-id': encodeStreamCursor(8n) }, 400],
      ['expired cursor', { ...accept, 'last-event-id': encodeStreamCursor(9n) }, 409],
    ];
    for (const [, headers, status] of invalidCases) {
      const result = await requestResult(port, 'HEAD', headers);
      assert.equal(result.status, status);
      assert.match(result.body, /^$/u);
      assert.notEqual(result.headers['content-type'], 'text/event-stream; charset=utf-8');
    }
    const head = await requestResult(port, 'HEAD', { accept: 'application/json, text/event-stream; charset=utf-8; q=0.5' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(head.headers['access-control-allow-origin'], '*');
    assert.equal(head.body, '');
    const options = await requestResult(port, 'OPTIONS', {});
    assert.equal(options.status, 204);
    assert.equal(options.headers['access-control-allow-origin'], '*');
    const body = await requestResult(port, 'GET', { ...accept, 'content-length': '10' }, 'unexpected');
    assert.equal(body.status, 405);
    assert.match(body.body, /METHOD_NOT_ALLOWED/u);
    const current = await requestResult(port, 'HEAD', { ...accept, 'last-event-id': encodeStreamCursor(1n) });
    assert.equal(current.status, 200);
    assert.deepEqual(resolved, [8n, 9n, 1n]);
  } finally {
    await closeServer(server);
  }
});

void test('events GET frames high-water events over node:http and cleans up an aborted client', async () => {
  let highWaterCalls = 0;
  let closeSession: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => { closeSession = resolve; });
  const stream: ApiEventStreamRepository = {
    async highWaterMark() { highWaterCalls += 1; return 5n; },
    async resolve() { throw new Error('an omitted cursor must use the high-water mark'); },
    async readAfter(after) {
      assert.equal(after, 5n);
      return [
        { sequence: 6n, streamEventId: 'stream-6', event: event('stable-event') },
        { sequence: 7n, streamEventId: 'stream-7', event: event('stable-event') },
      ];
    },
  };
  const router = createApiRouter({
    projections: {} as ApiProjectionRepository,
    now: () => 0, defaultLimit: 1, maximumLimit: 1, correlationId: () => 'test', logError: () => {},
    stream, sse: {
      batchSize: 2, pollIntervalMs: 50, heartbeatIntervalMs: 50,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (timer) => { clearTimeout(timer as NodeJS.Timeout); },
      createSession: (options) => new SseSession({ ...options, onClosed: () => { closeSession?.(); } }),
    },
  });
  const { server, port } = await openServer(router);
  try {
    const output = await within(new Promise<string>((resolve, reject) => {
      const outgoing = httpRequest({ host: '127.0.0.1', port, path: '/api/v1/events', method: 'GET',
        headers: { accept: 'text/event-stream' } }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
          if (text.includes(`id: ${encodeStreamCursor(6n)}`) && text.includes(`id: ${encodeStreamCursor(7n)}`)) {
            response.destroy();
            outgoing.destroy();
            resolve(text);
          }
        });
        response.once('error', reject);
      });
      outgoing.once('error', reject);
      outgoing.end();
    }), 'SSE event frames');
    assert.equal(highWaterCalls, 1);
    assert.match(output, new RegExp(`id: ${encodeStreamCursor(6n)}\\nevent: TokenLaunchDetected`, 'u'));
    assert.match(output, new RegExp(`id: ${encodeStreamCursor(7n)}\\nevent: TokenLaunchDetected`, 'u'));
    assert.equal((output.match(/"eventId":"stable-event"/gu) ?? []).length, 2);
    await within(closed, 'aborted SSE cleanup');
  } finally {
    await closeServer(server);
  }
});

void test('an SSE session sends its shutdown frame and ends a real HTTP response', async () => {
  let resolveSession: (session: SseSession | null) => void = () => {};
  const sessionStarted = new Promise<SseSession | null>((resolve) => { resolveSession = resolve; });
  const stream: ApiEventStreamRepository = {
    async highWaterMark() { return 0n; }, async resolve() { return { status: 'CURRENT' as const, sequence: 0n }; },
    async readAfter() { return []; },
  };
  const router = makeSseRouter(stream);
  const server = createServer((incoming, outgoing) => { void router(incoming, outgoing).then(resolveSession); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP server address');
  try {
    const body = new Promise<string>((resolve, reject) => {
      const outgoing = httpRequest({ host: '127.0.0.1', port: address.port, path: '/api/v1/events', method: 'GET',
        headers: { accept: 'text/event-stream' } }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        response.once('error', reject);
        response.once('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
      });
      outgoing.once('error', reject);
      outgoing.end();
    });
    const session = await within(sessionStarted, 'SSE session startup');
    if (session === null) throw new Error('Expected an SSE session');
    await within(session.close('SERVER'), 'SSE session shutdown');
    assert.equal(await within(body, 'SSE shutdown response'), 'event: server_shutdown\ndata: {"apiVersion":"v1"}\n\n');
  } finally {
    await closeServer(server);
  }
});

void test('post-header stream failures are redacted and end real HTTP responses', async () => {
  const failures: readonly [string, () => Error, string][] = [
    ['dependency', () => new Error('SELECT password FROM credentials: super-secret'), 'DEPENDENCY_UNAVAILABLE'],
    ['expired cursor', () => new ApiEventStreamCursorExpiredError(), 'EVENT_CURSOR_EXPIRED'],
  ];
  for (const [, makeError, code] of failures) {
    const stream: ApiEventStreamRepository = {
      async highWaterMark() { return 0n; }, async resolve() { return { status: 'CURRENT' as const, sequence: 0n }; },
      async readAfter() { throw makeError(); },
    };
    const { server, port } = await openServer(makeSseRouter(stream));
    try {
      const result = await within(requestResult(port, 'GET', { accept: 'text/event-stream' }), `${code} stream error`);
      assert.equal(result.status, 200);
      assert.equal(result.headers['content-type'], 'text/event-stream; charset=utf-8');
      assert.match(result.body, /event: stream_error\n/u);
      assert.match(result.body, new RegExp(`"code":"${code}"`, 'u'));
      assert.doesNotMatch(result.body, /SELECT|password|super-secret/u);
    } finally {
      await closeServer(server);
    }
  }
});

void test('SseSession escapes CR/LF payload data without creating injected frames', async () => {
  const timers = new FakeTimers();
  const response = new FakeResponse();
  const newlinePayloadEvent: ApiDomainEvent = {
    ...event('newline-payload'),
    payload: toApiDomainPayload({ message: 'line one\r\nevent: injected\nid: injected' }),
  };
  const session = new SseSession({
    stream: {
      async highWaterMark() { return 0n; }, async resolve() { return { status: 'CURRENT' as const, sequence: 0n }; },
      async readAfter() { return [{ sequence: 1n, streamEventId: 'stream-1', event: newlinePayloadEvent }]; },
    },
    response: response as unknown as ServerResponse, startAfter: 0n, batchSize: 1,
    pollIntervalMs: 10, heartbeatIntervalMs: 100, schedule: timers.schedule, cancel: timers.cancel,
    onClosed: () => undefined,
  });
  session.start();
  timers.runOne();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const output = response.chunks.join('');
  assert.match(output, /"message":"line one\\r\\nevent: injected\\nid: injected"/u);
  assert.doesNotMatch(output, /\r/u);
  assert.doesNotMatch(output, /\nevent: injected\n|\nid: injected\n/u);
  await session.close('CLIENT');
});

void test('SseSession emits a bounded SocialEvidenceCollected summary without raw evidence arrays', async () => {
  const timers = new FakeTimers();
  const response = new FakeResponse();
  const socialEvent: ApiDomainEvent = {
    ...event('social-event'),
    type: 'SocialEvidenceCollected',
    source: 'public_social',
    payload: toApiDomainPayload({
      sourceLaunchEventId: 'launch-event', collectionId: 'social_collection_a',
      metadataSnapshotId: 'pumpfun_metadata_a', collectionStatus: 'COMPLETE',
      inputFingerprint: 'a'.repeat(64), linkCount: 3, evidenceCount: 9,
    }),
  };
  const session = new SseSession({
    stream: {
      async highWaterMark() { return 0n; }, async resolve() { return { status: 'CURRENT' as const, sequence: 0n }; },
      async readAfter() { return [{ sequence: 1n, streamEventId: 'stream-1', event: socialEvent }]; },
    },
    response: response as unknown as ServerResponse, startAfter: 0n, batchSize: 1,
    pollIntervalMs: 10, heartbeatIntervalMs: 100, schedule: timers.schedule, cancel: timers.cancel,
    onClosed: () => undefined,
  });

  session.start();
  timers.runOne();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const output = response.chunks.join('');
  assert.match(output, /event: SocialEvidenceCollected/u);
  assert.match(output, /"collectionId":"social_collection_a"/u);
  assert.doesNotMatch(output, /"links"|"evidence"|rawBody|responseHeaders|dnsAnswers/u);
  assert.ok(Buffer.byteLength(output) < 4_096);
  await session.close('CLIENT');
});

void test('SseSession emits bounded paper progress without quotes or error messages', async () => {
  const timers = new FakeTimers();
  const response = new FakeResponse();
  const paperEvent: ApiDomainEvent = {
    ...event('paper-session-event'),
    type: 'PaperStrategySessionUpdated',
    source: 'paper-decision',
    payload: toApiDomainPayload({
      sessionId: `paper_session_${'a'.repeat(64)}`,
      state: 'WAITING_EXTERNAL_BUYS', reasonCode: 'EXTERNAL_BUY_OBSERVED',
      strategy: { id: 'validated-external-buys', version: 1 },
      positionId: 'position-a', quoteMint: 'quote',
      externalBuyCount: 3, externalBuyTarget: 10, minimumConfirmation: 'confirmed',
      updatedAt: '2026-07-29T00:00:00.000Z',
      lastError: { code: 'QUOTE_UNAVAILABLE', retryable: true },
    }),
  };
  const session = new SseSession({
    stream: {
      async highWaterMark() { return 0n; }, async resolve() { return { status: 'CURRENT' as const, sequence: 0n }; },
      async readAfter() { return [{ sequence: 1n, streamEventId: 'stream-1', event: paperEvent }]; },
    },
    response: response as unknown as ServerResponse, startAfter: 0n, batchSize: 1,
    pollIntervalMs: 10, heartbeatIntervalMs: 100, schedule: timers.schedule, cancel: timers.cancel,
    onClosed: () => undefined,
  });

  session.start();
  timers.runOne();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const output = response.chunks.join('');
  assert.match(output, /event: PaperStrategySessionUpdated/u);
  assert.match(output, /"externalBuyCount":3/u);
  assert.doesNotMatch(output, /countedTradeIds|lastQuote|buyQuote|reverseSellQuote|message/u);
  assert.ok(Buffer.byteLength(output) < 4_096);
  await session.close('CLIENT');
});

void test('SseSession rejects a runtime event type containing CR/LF without frame injection', async () => {
  const timers = new FakeTimers();
  const response = new FakeResponse();
  const unsafeEvent = { ...event('unsafe-type'), type: 'TokenLaunchDetected\nevent: injected\nid: injected' } as unknown as ApiDomainEvent;
  const session = new SseSession({
    stream: {
      async highWaterMark() { return 0n; }, async resolve() { return { status: 'CURRENT' as const, sequence: 0n }; },
      async readAfter() { return [{ sequence: 1n, streamEventId: 'stream-1', event: unsafeEvent }]; },
    },
    response: response as unknown as ServerResponse, startAfter: 0n, batchSize: 1,
    pollIntervalMs: 10, heartbeatIntervalMs: 100, schedule: timers.schedule, cancel: timers.cancel,
    onClosed: () => undefined,
  });
  session.start();
  timers.runOne();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const output = response.chunks.join('');
  assert.match(output, /event: stream_error\n/u);
  assert.match(output, /"code":"DEPENDENCY_UNAVAILABLE"/u);
  assert.doesNotMatch(output, /\nevent: injected\n|\nid: injected\n/u);
  assert.equal(response.ended, true);
});

void test('events route abandons a deferred pre-header high-water read after client abort', async () => {
  let releaseHighWater: (() => void) | undefined;
  let highWaterStarted: (() => void) | undefined;
  const highWaterStartedPromise = new Promise<void>((resolve) => { highWaterStarted = resolve; });
  const highWater = new Promise<bigint>((resolve) => { releaseHighWater = () => { resolve(0n); }; });
  let readAfterCalls = 0;
  let scheduled = 0;
  let returned: ((session: SseSession | null) => void) | undefined;
  const returnedSession = new Promise<SseSession | null>((resolve) => { returned = resolve; });
  const stream: ApiEventStreamRepository = {
    async highWaterMark() { highWaterStarted?.(); return highWater; },
    async resolve() { return { status: 'CURRENT' as const, sequence: 0n }; },
    async readAfter() { readAfterCalls += 1; return []; },
  };
  const router = createApiRouter({
    projections: {} as ApiProjectionRepository,
    now: () => 0, defaultLimit: 1, maximumLimit: 1, correlationId: () => 'test', logError: () => {},
    stream, sse: { batchSize: 1, pollIntervalMs: 50, heartbeatIntervalMs: 50,
      schedule: () => { scheduled += 1; return 1; }, cancel: () => {} },
  });
  let peerClosed: (() => void) | undefined;
  const peerClosedPromise = new Promise<void>((resolve) => { peerClosed = resolve; });
  const server = createServer((incoming, outgoing) => {
    outgoing.once('close', () => { peerClosed?.(); });
    void router(incoming, outgoing).then((session) => { returned?.(session); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP server address');
  try {
    const outgoing = httpRequest({ host: '127.0.0.1', port: address.port, path: '/api/v1/events', method: 'GET',
      headers: { accept: 'text/event-stream' } });
    outgoing.once('error', () => {});
    outgoing.end();
    await within(highWaterStartedPromise, 'deferred high-water start');
    outgoing.destroy();
    await within(peerClosedPromise, 'aborted peer close');
    releaseHighWater?.();
    assert.equal(await within(returnedSession, 'aborted router completion'), null);
    assert.equal(readAfterCalls, 0);
    assert.equal(scheduled, 0);
  } finally {
    await closeServer(server);
  }
});

void test('SseSession flushes an empty-stream handshake before a long heartbeat interval', async () => {
  const stream: ApiEventStreamRepository = {
    async highWaterMark() { return 0n; }, async resolve() { return { status: 'CURRENT' as const, sequence: 0n }; },
    async readAfter() { return []; },
  };
  const router = createApiRouter({
    projections: {} as ApiProjectionRepository,
    now: () => 0, defaultLimit: 1, maximumLimit: 1, correlationId: () => 'test', logError: () => {},
    stream, sse: { batchSize: 1, pollIntervalMs: 60_000, heartbeatIntervalMs: 60_000 },
  });
  const { server, port } = await openServer(router);
  try {
    await within(new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest({ host: '127.0.0.1', port, path: '/api/v1/events', method: 'GET',
        headers: { accept: 'text/event-stream' } }, (response) => {
        assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
        response.destroy();
        outgoing.destroy();
        resolve();
      });
      outgoing.once('error', reject);
      outgoing.end();
    }), 'flushed SSE handshake');
  } finally {
    await closeServer(server);
  }
});

void test('SseSession bounds SERVER close when an accepted event is blocked without drain', async () => {
  const timers = new FakeTimers();
  const response = new BackpressureResponse();
  let closed = 0;
  const session = new SseSession({
    stream: {
      async highWaterMark() { return 0n; }, async resolve() { return { status: 'CURRENT' as const, sequence: 0n }; },
      async readAfter() { return [{ sequence: 1n, streamEventId: 'stream-1', event: event('blocked') }]; },
    },
    response: response as unknown as ServerResponse, startAfter: 0n, batchSize: 1,
    pollIntervalMs: 10, heartbeatIntervalMs: 100, schedule: timers.schedule, cancel: timers.cancel,
    onClosed: () => { closed += 1; },
  });
  session.start();
  timers.runOne();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await within(session.close('SERVER'), 'bounded server close');
  const sameClose = session.close('SERVER');
  assert.equal(sameClose, session.close('SERVER'));
  await sameClose;
  assert.equal(response.ended, true);
  assert.equal(response.destroyed, true);
  assert.equal(response.destroyCalls, 1);
  assert.equal(closed, 1);
});
