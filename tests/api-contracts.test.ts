import assert from 'node:assert/strict';
import test from 'node:test';
import {
  API_VERSION,
  MAX_API_JSON_DEPTH,
  MAX_API_JSON_NODES,
  type ApiAvailability,
  type ApiDomainPayload,
  type ApiFailure,
  type ApiHealth,
  type ApiJsonObject,
  type ApiLaunchSummary,
  type ApiQualification,
  type ApiSocial,
  type ApiHolders,
  type ApiDomainEvent,
  type ApiSseEvent,
  type ApiSuccess,
  toApiDomainPayload,
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
    observedAt: '2026-07-29T12:00:00.000Z', payloadVersion: 1, payload: toApiDomainPayload({}),
  };
  const domainEvent: ApiDomainEvent = event;
  const sseEvent: ApiSseEvent = domainEvent;

  assert.equal(success.apiVersion, 'v1');
  assert.equal(success.data.detectedAt, '2026-07-29T12:00:00.000Z');
  assert.equal(failure.apiVersion, 'v1');
  assert.equal(failure.error.correlationId, 'req_123');
  assert.equal(availability, 'NOT_AVAILABLE');
  assert.equal(social.links.length, 0);
  assert.equal(holders.snapshots.length, 0);
  assert.equal(qualification.verdict, 'WATCHLISTED');
  assert.equal(health.pipeline.pumpfun, 'RUNNING');
  assert.equal(sseEvent.eventId, 'evt_1');
});

void test('toApiJson rejects adversarial descriptors without invoking input getters or methods', () => {
  let getterCalled = false;
  const getterInput = {};
  Object.defineProperty(getterInput, 'value', {
    enumerable: true,
    get: () => { getterCalled = true; return 'unsafe'; },
  });
  const maliciousArray = [1];
  let mapCalled = false;
  Object.defineProperty(maliciousArray, 'map', { value: () => { mapCalled = true; return []; } });
  class ArraySubclass extends Array<unknown> {}

  assert.throws(() => toApiJson(getterInput), TypeError);
  assert.throws(() => toApiJson(maliciousArray), TypeError);
  assert.throws(() => toApiJson(new ArraySubclass()), TypeError);
  assert.throws(() => toApiJson(Object.assign([1], { custom: true })), TypeError);
  assert.throws(() => toApiJson(Object.assign([1], { [Symbol('custom')]: true })), TypeError);
  assert.throws(() => toApiJson(new Date()), TypeError);
  assert.equal(getterCalled, false);
  assert.equal(mapCalled, false);
});

void test('toApiJson enforces depth and node limits before runtime overflow', () => {
  let atLimit: unknown = null;
  for (let index = 0; index < MAX_API_JSON_DEPTH; index += 1) atLimit = [atLimit];
  assert.doesNotThrow(() => toApiJson(atLimit));
  assert.throws(() => toApiJson([atLimit]), RangeError);
  assert.doesNotThrow(() => toApiJson(new Array<unknown>(MAX_API_JSON_NODES - 1).fill(null)));
  assert.throws(() => toApiJson(new Array<unknown>(MAX_API_JSON_NODES).fill(null)), RangeError);
});

void test('domain payload factory rejects numeric financial values and brands frozen payloads', () => {
  const accepted = toApiDomainPayload({
    version: 1, decimals: 9, score: 15, index: 0, amountQuote: '42', feeQuote: '1', feesQuote: '2',
    slotNumber: '123', marketCapQuote: '99', nested: { amountRaw: 42n },
  });
  // @ts-expect-error API domain payloads are branded and cannot be supplied as plain objects.
  const forged: ApiDomainPayload = { version: 1 };

  assert.equal(Object.isFrozen(accepted), true);
  assert.deepEqual(accepted, {
    version: 1, decimals: 9, score: 15, index: 0, amountQuote: '42', feeQuote: '1', feesQuote: '2',
    slotNumber: '123', marketCapQuote: '99', nested: { amountRaw: '42' },
  });
  assert.throws(() => toApiDomainPayload({ amountQuote: 42 }), TypeError);
  assert.throws(() => toApiDomainPayload({ feeQuote: 42 }), TypeError);
  assert.throws(() => toApiDomainPayload({ feesQuote: 42 }), TypeError);
  assert.throws(() => toApiDomainPayload({ slotNumber: 42 }), TypeError);
  assert.throws(() => toApiDomainPayload({ marketCapQuote: 42 }), TypeError);
  void forged;
});
