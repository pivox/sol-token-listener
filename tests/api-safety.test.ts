import assert from 'node:assert/strict';
import { request as requestHttp, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ApiServer } from '../src/interfaces/http/api-server.js';
import type { ApiHealth } from '../src/api/contracts.js';
import type { ApiEventStreamRepository } from '../src/ports/api-event-stream-repository.js';
import type { ApiProjectionRepository } from '../src/ports/api-projection-repository.js';

const FORBIDDEN = /(?:execution\/(?:wallet|transaction-confirmer|trade-executor)|transaction-builder|Keypair|sendTransaction|sendRawTransaction|simulateTransaction|private.?key)/iu;

const health: ApiHealth = {
  status: 'OK', observedAt: '2026-07-29T00:00:00.000Z', postgresql: { status: 'AVAILABLE' },
  http: { status: 'AVAILABLE' }, pipeline: { pumpfun: 'IDLE', pumpswap: 'IDLE', qualification: 'IDLE', paperDecision: 'IDLE', social: 'IDLE' },
  qualification: { currentCount: 0, lastSuccessAt: null },
  socialJobs: { pendingCount: 0, leasedCount: 0, retryableFailedCount: 0, exhaustedCount: 0 },
  paperDecisionJobs: {
    pendingCount: 0, leasedCount: 0, retryableFailedCount: 0, exhaustedCount: 0,
    lastSuccessAt: null, lastErrorCode: null,
  },
  checkpoints: { launchpad: null, market: null },
  heartbeat: { startedAt: null, updatedAt: null, lastHttpSlot: null, lastWebsocketSlot: null,
    lastFinalizedSlot: null, lastSignature: null, pendingTransactions: null, activeSessions: null,
    websocket: {
      version: 1, supervision: 'INACTIVE', state: 'STOPPED', phase: 'STOPPED',
      providerId: null, candidateProviderId: null, updatedAt: null, heartbeatAt: null,
      acknowledgedAt: null, lastObservation: null, disconnect: null,
      recovery: { status: 'NOT_REQUIRED', startedAt: null, completedAt: null, reasonCode: null },
    } }, lagSlots: null,
};

const projections: ApiProjectionRepository = {
  async listLaunches() { return { items: [], nextCursor: null }; },
  async getLaunch() { return null; },
  async listLaunchEvents() { return { items: [], nextCursor: null }; },
  async getLaunchRisk() { return null; },
  async getLaunchSocial() { return null; },
  async getLaunchHolders() { return null; },
  async listPaperPositions() { return { items: [], nextCursor: null }; },
  async getHealth() { return health; },
};

const stream: ApiEventStreamRepository = {
  async highWaterMark() { return 0n; },
  async resolve(sequence) { return { status: 'CURRENT' as const, sequence }; },
  async readAfter() { return []; },
};

void test('ApiServer sert les projections en HTTP puis ferme idempotemment', async () => {
  const server = new ApiServer({ host: '127.0.0.1', port: 0, projections, stream, now: () => 0, correlationId: () => 'test', logError: () => {} });
  const address = await server.listen();
  const response = await new Promise<Readonly<{ status: number; body: string }>>((resolve, reject) => {
    const request = requestHttp({ host: address.host, port: address.port, path: '/api/v1/health' }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      incoming.once('error', reject);
      incoming.once('end', () => { resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    request.once('error', reject);
    request.end();
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /"status":"OK"/u);
  await assert.rejects(server.listen(), /already listening/u);
  const firstClose = server.close();
  const secondClose = server.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
});

void test('ApiServer accepte une fermeture idempotente avant toute écoute', async () => {
  const server = new ApiServer({ host: '127.0.0.1', port: 0, projections, stream });
  const firstClose = server.close();
  const secondClose = server.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
  await assert.rejects(server.listen(), /closed/u);
});

void test('ApiServer suit les sessions SSE et leur envoie l’arrêt avant de fermer', async () => {
  const server = new ApiServer({ host: '127.0.0.1', port: 0, projections, stream, now: () => 0, correlationId: () => 'test', logError: () => {} });
  const address = await server.listen();
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = requestHttp({ host: address.host, port: address.port, path: '/api/v1/events', headers: { accept: 'text/event-stream' } }, resolve);
    request.once('error', reject);
    request.end();
  });
  const chunks: Buffer[] = [];
  const ended = new Promise<void>((resolve, reject) => {
    response.once('end', resolve);
    response.once('error', reject);
  });
  response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
  assert.equal(server.activeSessionCount, 1);
  await server.close();
  await ended;
  assert.match(Buffer.concat(chunks).toString('utf8'), /event: server_shutdown/u);
  assert.equal(server.activeSessionCount, 0);
});

void test('ApiServer contient une promesse de handler rejetée sans exposer son erreur', async () => {
  const logs: string[] = [];
  const server = new ApiServer({
    host: '127.0.0.1', port: 0, projections, stream,
    createRouter: () => async () => { throw new Error('credential-like-detail'); },
    logError: (context) => { logs.push(context.errorName); },
  });
  const address = await server.listen();
  const response = await new Promise<string>((resolve, reject) => {
    const request = requestHttp({ host: address.host, port: address.port, path: '/api/v1/health' }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      incoming.once('error', reject);
      incoming.once('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
    });
    request.once('error', reject);
    request.end();
  });
  assert.equal(response, '');
  assert.deepEqual(logs, ['Error']);
  await server.close();
});

void test('ApiServer ne crée aucune session SSE lorsqu’une poignée de main se termine pendant sa fermeture', async () => {
  let releaseHighWater: ((value: bigint) => void) | undefined;
  let polls = 0;
  let markHighWaterStarted: (() => void) | undefined;
  const highWaterStarted = new Promise<void>((resolve) => { markHighWaterStarted = resolve; });
  const delayedStream: ApiEventStreamRepository = {
    async highWaterMark() {
      markHighWaterStarted?.();
      return new Promise<bigint>((release) => { releaseHighWater = release; });
    },
    async resolve(sequence) { return { status: 'CURRENT' as const, sequence }; },
    async readAfter() {
      polls += 1;
      return new Promise<never>(() => undefined);
    },
  };
  const server = new ApiServer({ host: '127.0.0.1', port: 0, projections, stream: delayedStream });
  const address = await server.listen();
  const outgoing = requestHttp({ host: address.host, port: address.port, path: '/api/v1/events', headers: { accept: 'text/event-stream' } });
  outgoing.on('response', (incoming) => { incoming.resume(); });
  outgoing.on('error', () => undefined);
  outgoing.end();
  await highWaterStarted;
  const closing = server.close();
  releaseHighWater?.(0n);
  try {
    await within(closing, 300, 'server close');
    assert.equal(server.activeSessionCount, 0);
    assert.equal(polls, 0);
  } finally {
    outgoing.destroy();
    await closing.catch(() => undefined);
  }
});

void test('ApiServer force la fermeture bornée d’une poignée de main SSE qui ne répond jamais', async () => {
  let markHighWaterStarted: (() => void) | undefined;
  const highWaterStarted = new Promise<void>((resolve) => { markHighWaterStarted = resolve; });
  let polls = 0;
  const stalledStream: ApiEventStreamRepository = {
    async highWaterMark() {
      markHighWaterStarted?.();
      return new Promise<never>(() => undefined);
    },
    async resolve(sequence) { return { status: 'CURRENT' as const, sequence }; },
    async readAfter() { polls += 1; return []; },
  };
  const server = new ApiServer({
    host: '127.0.0.1', port: 0, projections, stream: stalledStream,
    shutdownGraceMs: 25,
  });
  const address = await server.listen();
  const outgoing = requestHttp({ host: address.host, port: address.port, path: '/api/v1/events', headers: { accept: 'text/event-stream' } });
  const socketClosed = new Promise<void>((resolve) => { outgoing.once('close', resolve); });
  outgoing.on('error', () => undefined);
  outgoing.end();
  await highWaterStarted;
  try {
    await within(server.close(), 250, 'bounded server close');
    await within(socketClosed, 250, 'client socket close');
    assert.equal(server.activeSessionCount, 0);
    assert.equal(polls, 0);
  } finally {
    outgoing.destroy();
  }
});

void test('les sources HTTP publiques ne chargent aucune capacité de signature ou de mutation', async () => {
  const files = ['../src/interfaces/http/api-server.ts', '../src/interfaces/http/api-router.ts', '../src/interfaces/http/sse-session.ts', '../src/app.ts'];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, FORBIDDEN);
    assert.doesNotMatch(source, /(?:POST|PUT|PATCH|DELETE)/u);
  }
});

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => { reject(new Error(`${label} timed out`)); }, timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
