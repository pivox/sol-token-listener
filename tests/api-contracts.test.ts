import assert from 'node:assert/strict';
import test from 'node:test';
import {
  API_VERSION,
  type ApiFailure,
  type ApiLaunchSummary,
  type ApiSuccess,
  toApiJson,
} from '../src/api/contracts.js';
import { API_ERROR_CODES, ApiError } from '../src/api/errors.js';

void test('toApiJson converts bigint values recursively and freezes its result', () => {
  const result = toApiJson({
    balance: 42n,
    nested: [null, { slot: 99n, active: true, label: 'new' }],
    count: 2,
  });

  assert.deepEqual(result, {
    balance: '42',
    nested: [null, { slot: '99', active: true, label: 'new' }],
    count: 2,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.nested), true);
  assert.equal(Object.isFrozen(result.nested[1]), true);
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
    meta: { generatedAt: '2026-07-29T12:00:00.000Z', nextCursor: null },
    error: { code: 'INVALID_CURSOR', message: 'The cursor is invalid' },
  };

  assert.equal(success.apiVersion, 'v1');
  assert.equal(success.data.detectedAt, '2026-07-29T12:00:00.000Z');
  assert.equal(failure.apiVersion, 'v1');
});
