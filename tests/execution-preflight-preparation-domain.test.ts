import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionPreflightPreparationIdentity,
  ExecutionPreflightPreparationValidationError,
} from '../src/domain/execution-preflight-preparation.js';

void test('derives a stable redacted preparation identity from internal UUID entropy', () => {
  const first = createExecutionPreflightPreparationIdentity(
    '00000000-0000-4000-8000-000000000001',
  );
  const replay = createExecutionPreflightPreparationIdentity(
    '00000000-0000-4000-8000-000000000001',
  );

  assert.deepEqual(first, replay);
  assert.equal(first.payloadVersion, 1);
  assert.match(first.runId, /^execution_preflight_preparation_[0-9a-f]{64}$/u);
  assert.match(first.runFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(JSON.stringify(first).includes('00000000-0000-4000-8000-000000000001'), false);
});

void test('rejects caller-shaped or non-v4 preparation entropy', () => {
  for (const value of [
    '',
    '00000000-0000-1000-8000-000000000001',
    '00000000-0000-4000-7000-000000000001',
    Object.freeze({ runId: 'chosen-by-caller' }),
  ]) {
    assert.throws(
      () => createExecutionPreflightPreparationIdentity(value),
      ExecutionPreflightPreparationValidationError,
    );
  }
});
