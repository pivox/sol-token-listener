import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import bs58 from 'bs58';
import type {
  ApiHealth,
  ApiHolders,
  ApiLaunchDetail,
  ApiLaunchSummary,
  ApiPage,
  ApiPaperPosition,
  ApiQualification,
  ApiSocial,
  ApiTimelineEntry,
} from '../src/api/contracts.js';
import { ApiError } from '../src/api/errors.js';
import { encodeLaunchCursor, encodePaperPositionCursor, encodeTimelineCursor } from '../src/api/cursor.js';
import { failure, success, writeJson } from '../src/interfaces/http/api-response.js';
import { createApiRouter } from '../src/interfaces/http/api-router.js';
import { MAX_API_PAGE_LIMIT, type ApiProjectionRepository } from '../src/ports/api-projection-repository.js';

const MINT = bs58.encode(new Uint8Array(32).fill(7));
const OTHER_MINT = bs58.encode(new Uint8Array(32).fill(8));
const NOW = 1_720_000_000_000;

interface CapturedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | number | readonly string[]>>;
  readonly body: string;
}

class ResponseCapture {
  public status = 0;
  public headers: Record<string, string | number | readonly string[]> = {};
  public body = '';

  public writeHead(status: number, headers: Record<string, string | number | readonly string[]>): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  public end(chunk?: string): this {
    this.body = chunk ?? '';
    return this;
  }

  public captured(): CapturedResponse {
    return { status: this.status, headers: this.headers, body: this.body };
  }
}

function invoke(
  router: ReturnType<typeof createApiRouter>,
  method: string,
  url: string,
  headers: Readonly<Record<string, string | undefined>> = {},
): Promise<CapturedResponse> {
  const response = new ResponseCapture();
  const request = { method, url, headers } as unknown as IncomingMessage;
  return router(request, response as unknown as ServerResponse).then(() => response.captured());
}

function makeRepository(): ApiProjectionRepository & { readonly calls: string[] } {
  const calls: string[] = [];
  const summary: ApiLaunchSummary = {
    mint: MINT, detectedAt: '2024-07-03T09:46:40.000Z', detectedSlot: '1', status: 'DETECTED',
    name: 'Token', symbol: 'TOK', quoteMint: null, quoteDecimals: null,
    marketCapQuote: null, liquidityQuote: null,
  };
  const social: ApiSocial = { status: 'NOT_AVAILABLE', links: [], evidence: [] };
  const holders: ApiHolders = {
    status: 'NOT_AVAILABLE', snapshots: [], positions: [], clusters: [],
    clusterAnalysisStatus: 'NOT_AVAILABLE',
  };
  const detail: ApiLaunchDetail = {
    ...summary, creator: MINT, tokenProgram: MINT, launchpad: 'pumpfun', initialTokenAmount: null,
    initialQuoteAmount: null, reserveBase: null, reserveQuote: null, feeBps: null, social, holders,
  };
  const timeline: ApiTimelineEntry = {
    id: 'event-1', type: 'TokenLaunchDetected', occurredAt: summary.detectedAt, slot: '1',
    confirmationStatus: 'confirmed', payloadVersion: 1, payload: {} as ApiTimelineEntry['payload'],
  };
  const risk: ApiQualification = {
    ruleSet: {
      id: 'v1', version: 1, status: 'UNVALIDATED_RULE_SET', minimumTotalScore: 60,
      fingerprint: null,
    },
    scores: {
      preparation: { score: 0, maximum: 30 }, socialAuthenticity: { score: 0, maximum: 30 },
      onchainHealth: { score: 0, maximum: 40 }, total: { score: 0, maximum: 100 },
    }, evidence: [], conditions: [], blockers: [], verdict: 'WATCHLISTED', evaluatedAt: summary.detectedAt,
  };
  const position: ApiPaperPosition = {
    id: 'position-1', mint: MINT, status: 'PAPER_HOLDING', openedAt: summary.detectedAt, closedAt: null,
    quoteMint: MINT, quantity: '1', entryQuoteAmount: '1', exitQuoteAmount: null,
    realizedPnlQuote: null, estimatedFeesQuote: '0',
  };
  const health: ApiHealth = {
    status: 'OK', observedAt: summary.detectedAt, postgresql: { status: 'AVAILABLE' },
    http: { status: 'AVAILABLE' }, pipeline: { pumpfun: 'IDLE', pumpswap: 'IDLE', social: 'IDLE' },
    socialJobs: { pendingCount: 0, leasedCount: 0, retryableFailedCount: 0, exhaustedCount: 0 },
    checkpoints: { launchpad: null, market: null },
    heartbeat: { startedAt: null, updatedAt: null, lastHttpSlot: null, lastWebsocketSlot: null,
      lastFinalizedSlot: null, lastSignature: null, pendingTransactions: null, activeSessions: null }, lagSlots: null,
  };
  const page = <T>(items: readonly T[]): ApiPage<T> => ({ items, nextCursor: null });
  return {
    calls,
    async listLaunches(request) { calls.push(`launches:${request.limit}:${request.after?.mint ?? 'none'}`); return page([summary]); },
    async getLaunch(mint) { calls.push(`launch:${mint}`); return mint === MINT ? detail : null; },
    async listLaunchEvents(mint, request) { calls.push(`events:${mint}:${request.limit}:${request.after?.id ?? 'none'}`); return page([timeline]); },
    async getLaunchRisk(mint) { calls.push(`risk:${mint}`); return risk; },
    async getLaunchSocial(mint) { calls.push(`social:${mint}`); return social; },
    async getLaunchHolders(mint) { calls.push(`holders:${mint}`); return holders; },
    async listPaperPositions(request) { calls.push(`positions:${request.limit}:${request.after?.id ?? 'none'}`); return page([position]); },
    async getHealth() { calls.push('health'); return health; },
  };
}

function makeRouter(repository = makeRepository(), now: () => number = () => NOW) {
  const logged: unknown[] = [];
  const router = createApiRouter({
    projections: repository, now, defaultLimit: 20, maximumLimit: 100,
    correlationId: () => 'corr_test',
    logError: (context, error) => { logged.push({ context, error }); },
  });
  return { router, repository, logged };
}

function parseBody(response: CapturedResponse): unknown {
  return JSON.parse(response.body) as unknown;
}

void test('response helpers create safe envelopes, JSON headers, bigint conversion, and HEAD-compatible lengths', () => {
  const ok = success({ total: 1n }, NOW, 'cursor');
  const bad = failure(new ApiError({ code: 'INVALID_LIMIT', httpStatus: 400 }));
  const response = new ResponseCapture();
  writeJson(response as unknown as ServerResponse, 200, ok, true);

  assert.deepEqual(ok, { apiVersion: 'v1', meta: { generatedAt: '2024-07-03T09:46:40.000Z', nextCursor: 'cursor' }, data: { total: 1n } });
  assert.deepEqual(bad, { apiVersion: 'v1', error: { code: 'INVALID_LIMIT', message: 'The limit is invalid' } });
  assert.equal(response.body, '');
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-origin'], '*');
  assert.equal(response.headers['content-length'], Buffer.byteLength(JSON.stringify({ apiVersion: 'v1', meta: { generatedAt: '2024-07-03T09:46:40.000Z', nextCursor: 'cursor' }, data: { total: '1' } })));
  assert.throws(() => success({}, Number.NaN), TypeError);
});

void test('serves every public GET route with its projection and validates route-specific pagination', async () => {
  const { router, repository } = makeRouter();
  const cases: readonly [string, string][] = [
    ['/api/v1/launches?limit=2', 'launches:2:none'],
    [`/api/v1/launches/${MINT}`, `launch:${MINT}`],
    [`/api/v1/launches/${MINT}/events?cursor=${encodeTimelineCursor({ slot: '1', transactionIndex: 0, instructionIndex: 0, innerInstructionIndex: null, id: 'event-0' })}`, `events:${MINT}:20:event-0`],
    [`/api/v1/launches/${MINT}/risk`, `risk:${MINT}`],
    [`/api/v1/launches/${MINT}/social`, `social:${MINT}`],
    [`/api/v1/launches/${MINT}/holders`, `holders:${MINT}`],
    [`/api/v1/paper-positions?cursor=${encodePaperPositionCursor({ openedAtMs: 1, id: 'position-0' })}`, 'positions:20:position-0'],
    ['/api/v1/health', 'health'],
  ];

  for (const [url, expectedCall] of cases) {
    const response = await invoke(router, 'GET', url);
    assert.equal(response.status, 200, url);
    assert.equal(response.headers['access-control-allow-origin'], '*');
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
    assert.equal((parseBody(response) as { apiVersion: string }).apiVersion, 'v1');
    assert.equal(repository.calls.includes(expectedCall), true, expectedCall);
  }
  assert.equal(repository.calls.filter((call) => call.startsWith('launch:')).length, 5);
});

void test('serves the additive AVAILABLE social contract without exposing raw content', async () => {
  const repository = makeRepository();
  const available: ApiSocial = {
    status: 'AVAILABLE', collectionStatus: 'COMPLETE', collectionId: 'social_collection_a',
    metadataSnapshotId: 'pumpfun_metadata_a', observedAt: '2026-08-10T12:00:00.000Z',
    linkCount: 0, linksTruncated: false, links: [], evidenceCount: 1,
    evidenceTruncated: false,
    evidence: [{
      id: 'social_evidence_a', type: 'VERIFICATION_UNKNOWN', outcome: 'UNKNOWN',
      subjectKind: null, relatedKind: null, subjectUrl: null, finalUrl: null,
      httpStatus: null, redirectCount: 0, contentSha256: null,
      reasonCode: 'METADATA_UNAVAILABLE', observedAt: '2026-08-10T12:00:00.000Z',
    }],
    coverage: {
      declaredLinkCount: 0, inspectedLinkCount: 0, confirmedEvidenceCount: 0,
      rejectedEvidenceCount: 0, unknownEvidenceCount: 1,
    },
  };
  Object.assign(repository, { async getLaunchSocial() { return available; } });
  const { router } = makeRouter(repository);

  const response = await invoke(router, 'GET', `/api/v1/launches/${MINT}/social`);
  const body = parseBody(response) as { readonly data: Record<string, unknown> };

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, available);
  assert.equal('rawBody' in body.data, false);
  assert.equal('responseHeaders' in body.data, false);
  assert.equal('dnsAnswers' in body.data, false);
});

void test('HEAD mirrors GET headers and status without a response body, and OPTIONS is public', async () => {
  const { router } = makeRouter();
  const routes = [
    '/api/v1/launches', `/api/v1/launches/${MINT}`, `/api/v1/launches/${MINT}/events`,
    `/api/v1/launches/${MINT}/risk`, `/api/v1/launches/${MINT}/social`,
    `/api/v1/launches/${MINT}/holders`, '/api/v1/paper-positions', '/api/v1/health',
  ];

  for (const route of routes) {
    const get = await invoke(router, 'GET', route);
    const head = await invoke(router, 'HEAD', route);
    const options = await invoke(router, 'OPTIONS', route);
    assert.equal(head.status, get.status, route);
    assert.equal(head.body, '', route);
    assert.deepEqual(head.headers, get.headers, route);
    assert.equal(options.status, 204, route);
    assert.equal(options.headers.allow, 'GET, HEAD, OPTIONS', route);
    assert.equal(options.headers['access-control-allow-origin'], '*', route);
    assert.equal(options.headers['access-control-allow-credentials'], undefined, route);
  }
});

void test('maps missing launches across every detail and subroute without route-specific reads', async () => {
  const cases: readonly [string, string | null][] = [
    ['', null], ['/events', 'events'], ['/risk', 'risk'], ['/social', 'social'], ['/holders', 'holders'],
  ];
  for (const [suffix, routeMethod] of cases) {
    const { router, repository } = makeRouter();
    const missing = await invoke(router, 'GET', `/api/v1/launches/${OTHER_MINT}${suffix}`);
    assert.equal(missing.status, 404, suffix);
    assert.deepEqual(parseBody(missing), {
      apiVersion: 'v1', error: { code: 'LAUNCH_NOT_FOUND', message: 'The launch was not found' },
    }, suffix);
    assert.deepEqual(repository.calls, [`launch:${OTHER_MINT}`], suffix);
    if (routeMethod !== null) {
      assert.equal(repository.calls.some((call) => call.startsWith(`${routeMethod}:`)), false, suffix);
    }
  }

  const { router, repository } = makeRouter();
  const original = repository.getLaunchRisk;
  Object.assign(repository, { getLaunchRisk: async (_mint: string) => null });
  const risk = await invoke(router, 'GET', `/api/v1/launches/${MINT}/risk`);
  assert.equal(risk.status, 200);
  assert.deepEqual((parseBody(risk) as { data: unknown }).data, null);
  Object.assign(repository, { getLaunchRisk: original });
});

void test('rejects malformed, duplicate, foreign, and non-canonical API inputs before repository reads', async () => {
  const { router, repository } = makeRouter();
  const invalid: readonly [string, string, string][] = [
    ['/api/v1/launches?limit=01', 'INVALID_LIMIT', '400'],
    ['/api/v1/launches?limit=101', 'INVALID_LIMIT', '400'],
    ['/api/v1/launches?limit=1&limit=2', 'INVALID_LIMIT', '400'],
    ['/api/v1/launches?unknown=1', 'INVALID_LIMIT', '400'],
    [`/api/v1/launches?cursor=${encodePaperPositionCursor({ openedAtMs: 1, id: 'position-0' })}`, 'INVALID_CURSOR', '400'],
    [`/api/v1/launches/${MINT}/events?cursor=${encodeLaunchCursor({ detectedAtMs: 1, mint: MINT })}`, 'INVALID_CURSOR', '400'],
    ['/api/v1/launches/%ZZ', 'INVALID_MINT', '400'],
    ['/api/v1/launches/%2F', 'INVALID_MINT', '400'],
    [`/api/v1/launches/%55${MINT.slice(1)}`, 'INVALID_MINT', '400'],
    [`/api/v1/launches/${'z'.repeat(16_384)}`, 'INVALID_MINT', '400'],
    ['/api/v1/launches/not-a-mint', 'INVALID_MINT', '400'],
    ['/api/v1/launches#fragment', 'ROUTE_NOT_FOUND', '404'],
  ];

  for (const [url, code, status] of invalid) {
    const before = repository.calls.length;
    const response = await invoke(router, 'GET', url);
    assert.equal(String(response.status), status, url);
    assert.equal((parseBody(response) as { error: { code: string } }).error.code, code, url);
    assert.equal(repository.calls.length, before, url);
  }
});

void test('rejects unsupported methods and entity-bearing reads while preserving safe method semantics', async () => {
  const { router } = makeRouter();
  const method = await invoke(router, 'POST', '/api/v1/launches');
  const body = await invoke(router, 'GET', '/api/v1/launches', { 'content-length': '1' });
  const transfer = await invoke(router, 'GET', '/api/v1/launches', { 'transfer-encoding': 'chunked' });
  const optionsBody = await invoke(router, 'OPTIONS', '/api/v1/launches', { 'content-length': '1' });
  const unknown = await invoke(router, 'GET', '/api/v1/nope');

  for (const response of [method, body, transfer, optionsBody]) {
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'GET, HEAD, OPTIONS');
    assert.equal((parseBody(response) as { error: { code: string } }).error.code, 'METHOD_NOT_ALLOWED');
  }
  assert.equal(unknown.status, 404);
  assert.equal((parseBody(unknown) as { error: { code: string } }).error.code, 'ROUTE_NOT_FOUND');
});

void test('redacts unexpected errors, logs structured safe context, and turns an invalid clock into INTERNAL_ERROR', async () => {
  const repository = makeRepository();
  const databaseError = new Error('postgres://alice:secret@example.test/db');
  Object.assign(repository, { getHealth: async () => { throw databaseError; } });
  const { router, logged } = makeRouter(repository);
  const failureResponse = await invoke(router, 'GET', '/api/v1/health');
  assert.equal(failureResponse.status, 500);
  assert.deepEqual(parseBody(failureResponse), {
    apiVersion: 'v1', error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred', correlationId: 'corr_test' },
  });
  assert.equal(failureResponse.body.includes('secret'), false);
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0], { context: { route: 'health', method: 'GET', correlationId: 'corr_test' }, error: databaseError });

  Object.assign(repository, { getHealth: async () => { throw new ApiError({ code: 'DEPENDENCY_UNAVAILABLE', httpStatus: 503 }); } });
  const dependencyFailure = await invoke(router, 'GET', '/api/v1/health');
  assert.equal(dependencyFailure.status, 503);
  assert.deepEqual(parseBody(dependencyFailure), {
    apiVersion: 'v1', error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'A required service is temporarily unavailable' },
  });
  assert.equal(logged.length, 1);

  Object.assign(repository, { getHealth: async () => { throw new ApiError({ code: 'INVALID_CURSOR', httpStatus: 400 }); } });
  const unexpectedApiError = await invoke(router, 'GET', '/api/v1/health');
  assert.equal(unexpectedApiError.status, 500);
  assert.equal((parseBody(unexpectedApiError) as { error: { code: string } }).error.code, 'INTERNAL_ERROR');
  assert.equal(logged.length, 2);

  const clock = makeRouter(makeRepository(), () => Number.POSITIVE_INFINITY);
  const invalidNow = await invoke(clock.router, 'GET', '/api/v1/health');
  assert.equal(invalidNow.status, 500);
  assert.equal((parseBody(invalidNow) as { error: { code: string } }).error.code, 'INTERNAL_ERROR');
});

void test('maps a returned unavailable PostgreSQL health projection to a 503 dependency envelope', async () => {
  const repository = makeRepository();
  const original = repository.getHealth;
  Object.assign(repository, {
    getHealth: async () => ({
      ...(await original()), status: 'DEGRADED' as const, postgresql: { status: 'UNAVAILABLE' as const },
    }),
  });
  const { router } = makeRouter(repository);
  const get = await invoke(router, 'GET', '/api/v1/health');
  const head = await invoke(router, 'HEAD', '/api/v1/health');
  assert.equal(get.status, 503);
  assert.deepEqual(parseBody(get), {
    apiVersion: 'v1', error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'A required service is temporarily unavailable' },
  });
  assert.equal(head.status, 503);
  assert.equal(head.body, '');
  assert.deepEqual(head.headers, get.headers);
});

void test('rejects invalid pagination configuration at construction', () => {
  const repository = makeRepository();
  const base = { projections: repository, now: () => NOW, correlationId: () => 'c', logError: () => undefined };
  assert.throws(() => createApiRouter({ ...base, defaultLimit: 0, maximumLimit: 1 }), TypeError);
  assert.throws(() => createApiRouter({ ...base, defaultLimit: 2, maximumLimit: 1 }), TypeError);
  assert.throws(() => createApiRouter({ ...base, defaultLimit: 1, maximumLimit: 1.5 }), TypeError);
  assert.throws(() => createApiRouter({ ...base, defaultLimit: 1, maximumLimit: MAX_API_PAGE_LIMIT + 1 }), TypeError);
  assert.doesNotThrow(() => createApiRouter({
    ...base, defaultLimit: MAX_API_PAGE_LIMIT, maximumLimit: MAX_API_PAGE_LIMIT,
  }));
});
