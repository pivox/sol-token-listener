import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { encodeStreamCursor } from '../src/api/cursor.js';
import type { ApiDomainEvent } from '../src/api/contracts.js';
import { SseSession } from '../src/interfaces/http/sse-session.js';
import { createApiRouter } from '../src/interfaces/http/api-router.js';
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
  public write(chunk: string): boolean { this.chunks.push(chunk); return true; }
  public end(): this { this.ended = true; return this; }
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
