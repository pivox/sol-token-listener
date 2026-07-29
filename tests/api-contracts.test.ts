import assert from 'node:assert/strict';
import test from 'node:test';
import {
  API_VERSION,
  type ApiAvailability,
  type ApiFailure,
  type ApiHealth,
  type ApiJsonObject,
  type ApiLaunchSummary,
  type ApiPayloadValue,
  type ApiQualification,
  type ApiSocial,
  type ApiHolders,
  type ApiSseEvent,
  type ApiSuccess,
  toApiJson,
} from '../src/api/contracts.js';
import { API_ERROR_CODES, ApiError } from '../src/api/errors.js';

void test('toApiJson converts bigint values recursively and freezes its result', () => {
  const result = toApiJson({
    balance: 42n,
    nested: [null, { slot: 99n, active: true, label: 'new' }],
    count: 2,
  }) as ApiJsonObject;
  const nested = result.nested as readonly unknown[];
  const nestedObject = nested[1] as ApiJsonObject;

  assert.deepEqual(result, {
    balance: '42',
    nested: [null, { slot: '99', active: true, label: 'new' }],
    count: 2,
  });
  assert.deepEqual([...nested], [null, nested[1]]);
  assert.equal(nestedObject.slot, '99');
  assert.equal(nestedObject.active, true);
  assert.equal(nestedObject.label, 'new');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(nested), true);
  assert.equal(Object.isFrozen(nestedObject), true);
});

void test('toApiJson rejects unsupported values and invalid numbers', () => {
  const values: readonly unknown[] = [
    undefined,
    () => undefined,
    Symbol('unsupported'),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ];

  for (const value of values) {
    assert.throws(() => toApiJson(value), TypeError);
  }
});

void test('toApiJson rejects cyclic structures', () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;

  assert.throws(() => toApiJson(cyclic), TypeError);
});

void test('toApiJson preserves negative zero and rejects sparse arrays', () => {
  assert.equal(Object.is(toApiJson(-0), -0), true);
  assert.throws(() => toApiJson(new Array<unknown>(1)), TypeError);

  Object.defineProperty(Array.prototype, '0', { value: 'inherited', configurable: true });
  try {
    assert.throws(() => toApiJson(new Array<unknown>(1)), TypeError);
  } finally {
    Reflect.deleteProperty(Array.prototype, '0');
  }
});

void test('toApiJson keeps __proto__ as a frozen own property without prototype pollution', () => {
  const source = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
  const result = toApiJson(source) as ApiJsonObject;

  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal((result.__proto__ as ApiJsonObject).polluted, true);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.equal(Object.isFrozen(result), true);
});

void test('exports the V1 API version and stable public error codes', () => {
  assert.equal(API_VERSION, 'v1');
  assert.deepEqual(API_ERROR_CODES, [
    'ROUTE_NOT_FOUND',
    'METHOD_NOT_ALLOWED',
    'INVALID_MINT',
    'INVALID_LIMIT',
    'INVALID_CURSOR',
    'LAUNCH_NOT_FOUND',
    'EVENT_CURSOR_EXPIRED',
    'DEPENDENCY_UNAVAILABLE',
    'INTERNAL_ERROR',
  ]);

  const cause = new Error('database credentials must not leak');
  const error = new ApiError({
    code: 'DEPENDENCY_UNAVAILABLE',
    httpStatus: 503,
    correlationId: 'req_123',
    cause,
  });

  assert.equal(error.name, 'ApiError');
  assert.equal(error.code, 'DEPENDENCY_UNAVAILABLE');
  assert.equal(error.httpStatus, 503);
  assert.equal(error.message, 'A required service is temporarily unavailable');
  assert.equal(error.correlationId, 'req_123');
  assert.equal(error.cause, cause);
});

void test('exposes V1 envelopes at the root and ISO dates in public projections', () => {
  const launch: ApiLaunchSummary = {
    mint: 'Mint111',
    detectedAt: '2026-07-29T12:00:00.000Z',
    detectedSlot: '123',
    status: 'DETECTED',
    name: null,
    symbol: null,
    quoteMint: null,
    quoteDecimals: null,
    marketCapQuote: null,
    liquidityQuote: null,
  };
  const success: ApiSuccess<ApiLaunchSummary> = {
    apiVersion: API_VERSION,
    data: launch,
    meta: { generatedAt: '2026-07-29T12:00:00.000Z', nextCursor: null },
  };
  const failure: ApiFailure = {
    apiVersion: API_VERSION,
    error: { code: 'INVALID_CURSOR', message: 'The cursor is invalid', correlationId: 'req_123' },
  };
  const availability: ApiAvailability = 'NOT_AVAILABLE';
  const social: ApiSocial = { status: 'NOT_AVAILABLE', links: [], evidence: [] };
  const holders: ApiHolders = { status: 'NOT_AVAILABLE', snapshots: [], clusters: [] };
  const qualification: ApiQualification = {
    ruleSet: {
      id: 'rules-v1', version: 1, status: 'UNVALIDATED_RULE_SET', minimumTotalScore: 60,
    },
    scores: {
      preparation: { score: 20, maximum: 30 }, socialAuthenticity: { score: 20, maximum: 30 },
      onchainHealth: { score: 20, maximum: 40 }, total: { score: 60, maximum: 100 },
    },
    evidence: [{ signal: 'imageValid', status: 'UNKNOWN', message: 'Not fetched' }],
    blockers: [{ code: 'STALE_DATA', message: 'Data is stale' }],
    verdict: 'WATCHLISTED', evaluatedAt: '2026-07-29T12:00:00.000Z',
  };
  const health: ApiHealth = {
    status: 'OK', observedAt: '2026-07-29T12:00:00.000Z',
    postgresql: { status: 'AVAILABLE' }, http: { status: 'AVAILABLE' },
    pipeline: { pumpfun: 'RUNNING', pumpswap: 'IDLE' },
    checkpoints: { launchpad: '1', market: null },
    heartbeat: {
      startedAt: '2026-07-29T12:00:00.000Z', updatedAt: '2026-07-29T12:00:00.000Z',
      lastHttpSlot: '1', lastWebsocketSlot: '1', lastFinalizedSlot: '1', lastSignature: null,
      pendingTransactions: 0, activeSessions: 0,
    },
    lagSlots: '0',
  };
  const event: ApiSseEvent = {
    eventId: 'evt_1', type: 'TokenLaunchDetected', mint: 'Mint111', source: 'solana',
    program: 'Pump111', signature: 'sig_1',
    cursor: { slot: '1', transactionIndex: '0', instructionIndex: '0', innerInstructionIndex: null },
    confirmationStatus: 'confirmed', blockchainTime: null,
    observedAt: '2026-07-29T12:00:00.000Z', payloadVersion: 1, payload: null,
  };

  assert.equal(success.apiVersion, 'v1');
  assert.equal(success.data.detectedAt, '2026-07-29T12:00:00.000Z');
  assert.equal(failure.apiVersion, 'v1');
  assert.equal(failure.error.correlationId, 'req_123');
  assert.equal(availability, 'NOT_AVAILABLE');
  assert.equal(social.links.length, 0);
  assert.equal(holders.snapshots.length, 0);
  assert.equal(qualification.verdict, 'WATCHLISTED');
  assert.equal(health.pipeline.pumpfun, 'RUNNING');
  assert.equal(event.eventId, 'evt_1');
});

void test('public event payloads prohibit numeric amounts and fees', () => {
  const accepted: ApiPayloadValue = { amountRaw: '42', feeBps: '42' };
  // @ts-expect-error Public payloads must not expose numeric amounts.
  void ({ amountRaw: 42 } satisfies ApiPayloadValue);
  // @ts-expect-error Public payloads must not expose numeric fees.
  void ({ feeBps: 42 } satisfies ApiPayloadValue);

  assert.equal(accepted.amountRaw, '42');
});
