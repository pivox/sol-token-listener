import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertValidNullableTimestampMs,
  assertValidTimestampMs,
  InvalidTimestampError,
} from '../src/domain/timestamp.js';

const INVALID_TIMESTAMPS = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  0.5,
  Number.MAX_SAFE_INTEGER + 1,
  -1,
  -0,
] as const;

void test('rejects every non-canonical required millisecond timestamp', () => {
  for (const value of INVALID_TIMESTAMPS) {
    assert.throws(
      () => {
        assertValidTimestampMs('occurredAtMs', value);
      },
      (error: unknown) => error instanceof InvalidTimestampError
        && error.field === 'occurredAtMs'
        && Object.is(error.value, value),
    );
  }
});

void test('nullable blockchain timestamps accept only null or canonical milliseconds', () => {
  assert.doesNotThrow(() => {
    assertValidNullableTimestampMs('blockchainTimeMs', null);
  });
  for (const value of INVALID_TIMESTAMPS) {
    assert.throws(
      () => {
        assertValidNullableTimestampMs('blockchainTimeMs', value);
      },
      (error: unknown) => error instanceof InvalidTimestampError
        && error.field === 'blockchainTimeMs'
        && Object.is(error.value, value),
    );
  }
});

void test('accepts zero as a canonical timestamp without normalizing it', () => {
  assert.doesNotThrow(() => {
    assertValidTimestampMs('observedAtMs', 0);
    assertValidNullableTimestampMs('blockchainTimeMs', 0);
  });
  assert.equal(Object.is(0, -0), false);
});
