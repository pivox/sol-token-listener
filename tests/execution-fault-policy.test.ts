import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyExecutionFault,
  ExecutionFaultPolicyValidationError,
} from '../src/domain/execution-fault-policy.js';

void test('allows only bounded pre-signature retry below the two-failure gate', () => {
  assert.equal(classifyExecutionFault(faultInput()), 'RETRY_PRE_SIGNATURE');
  assert.equal(classifyExecutionFault(faultInput({ consecutiveTechnicalFailures: 1 })), 'RETRY_PRE_SIGNATURE');
  assert.equal(classifyExecutionFault(faultInput({ consecutiveTechnicalFailures: 2 })), 'DO_NOT_RETRY');
});

void test('never retries a deterministic validation or policy failure', () => {
  for (const stage of ['VALIDATION', 'POLICY'] as const) {
    assert.equal(classifyExecutionFault(faultInput({
      stage, classification: 'DETERMINISTIC',
    })), 'DO_NOT_RETRY');
  }
});

void test('routes BUY ambiguity after signature exclusively to reconciliation', () => {
  assert.equal(classifyExecutionFault(faultInput({
    stage: 'SUBMISSION',
    side: 'BUY',
    timing: 'AFTER_SIGNATURE',
    classification: 'AMBIGUOUS',
    exactSignedBytesAvailable: true,
  })), 'RECONCILE_ONLY');
});

void test('permits only an exact-byte SELL retry after signature', () => {
  assert.equal(classifyExecutionFault(faultInput({
    stage: 'SUBMISSION', side: 'SELL', timing: 'AFTER_SIGNATURE',
    classification: 'TRANSIENT', exactSignedBytesAvailable: true,
  })), 'RETRY_EXACT_BYTES');
  assert.equal(classifyExecutionFault(faultInput({
    stage: 'SUBMISSION', side: 'SELL', timing: 'AFTER_SIGNATURE',
    classification: 'TRANSIENT', exactSignedBytesAvailable: false,
  })), 'RECONCILE_ONLY');
});

void test('keeps confirmation, reorg and unresolved reconciliation on reconciliation-only', () => {
  for (const stage of ['CONFIRMATION', 'RECONCILIATION'] as const) {
    assert.equal(classifyExecutionFault(faultInput({
      stage, timing: 'AFTER_SIGNATURE', classification: 'AMBIGUOUS',
      exactSignedBytesAvailable: true,
    })), 'RECONCILE_ONLY');
  }
});

void test('allows no-effect SELL recovery but never auto-retries a BUY', () => {
  assert.equal(classifyExecutionFault(faultInput({
    stage: 'RECONCILIATION', side: 'SELL', timing: 'AFTER_SIGNATURE',
    classification: 'PROVED_NO_EFFECT', exactSignedBytesAvailable: false,
  })), 'RETRY_PRE_SIGNATURE');
  assert.equal(classifyExecutionFault(faultInput({
    stage: 'RECONCILIATION', side: 'BUY', timing: 'AFTER_SIGNATURE',
    classification: 'PROVED_NO_EFFECT', exactSignedBytesAvailable: false,
  })), 'DO_NOT_RETRY');
});

void test('rejects impossible timing, stage, byte and hostile combinations', () => {
  for (const invalid of [
    { timing: 'PRE_SIGNATURE', exactSignedBytesAvailable: true },
    { timing: 'PRE_SIGNATURE', classification: 'AMBIGUOUS' },
    { timing: 'PRE_SIGNATURE', classification: 'PROVED_NO_EFFECT' },
    { stage: 'BUILD', timing: 'AFTER_SIGNATURE' },
    { stage: 'UNKNOWN' },
    { consecutiveTechnicalFailures: -1 },
  ]) assertInvalid(() => classifyExecutionFault(faultInput(invalid)));

  let traps = 0;
  const proxy = new Proxy(faultInput(), {
    getOwnPropertyDescriptor: () => { traps += 1; throw new Error('fault-secret'); },
    getPrototypeOf: () => { traps += 1; throw new Error('fault-secret'); },
  });
  assertInvalid(() => classifyExecutionFault(proxy));
  assert.equal(traps, 0);
});

function faultInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    stage: 'PROVIDER',
    side: 'BUY',
    timing: 'PRE_SIGNATURE',
    classification: 'TRANSIENT',
    consecutiveTechnicalFailures: 0,
    exactSignedBytesAvailable: false,
    ...overrides,
  };
}

function assertInvalid(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof ExecutionFaultPolicyValidationError);
    assert.equal(error.name, 'ExecutionFaultPolicyValidationError');
    assert.equal(error.message, 'Invalid execution fault policy input.');
    return true;
  });
}
