import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateExecutionReconciliation,
  ExecutionReconciliationValidationError,
} from '../src/domain/execution-reconciliation.js';

const INTENT_ID = `execution_intent_${'a'.repeat(64)}`;
const SIGNATURE = '3'.repeat(88);
const BLOCKHASH = '11111111111111111111111111111111';
const MESSAGE_HASH = 'b'.repeat(64);
const BUILD_FINGERPRINT = 'c'.repeat(64);
const SNAPSHOT_FINGERPRINT = 'd'.repeat(64);

void test('creates a deterministic frozen MATCHED proof from finalized exact evidence', () => {
  const evidence = evaluateExecutionReconciliation(reconciliationInput());
  const replay = evaluateExecutionReconciliation(reconciliationInput());

  assert.deepEqual(evidence, replay);
  assert.equal(evidence.result, 'MATCHED');
  assert.equal(evidence.reasonCode, 'INTENT_SUCCEEDED');
  assert.match(evidence.evidenceId, /^execution_reconciliation_[0-9a-f]{64}$/u);
  assert.match(evidence.evidenceFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(evidence.walletLamportDelta, -105n);
  assert.equal(evidence.baseDeltaRaw, 500n);
  assert.equal(evidence.quoteDeltaRaw, -100n);
  assert.equal(Object.isFrozen(evidence), true);
});

void test('proves NO_EFFECT only after blockhash expiry, historical absence and zero deltas', () => {
  const evidence = evaluateExecutionReconciliation(reconciliationInput({
    observed: observedInput({
      signatureHistory: 'ABSENT',
      confirmationStatus: 'NOT_FOUND',
      finalizedBlockHeight: 1_001n,
      observedSlot: null,
      transaction: null,
      feeLamports: 0n,
      walletLamportDelta: 0n,
      baseDeltaRaw: 0n,
      quoteDeltaRaw: 0n,
      finalizedAtMs: 2_000,
    }),
  }));

  assert.equal(evidence.result, 'NO_EFFECT');
  assert.equal(evidence.reasonCode, 'RECONCILIATION_PROVED_NO_EFFECT');
});

void test('keeps absence UNKNOWN before the exact last-valid-height boundary is exceeded', () => {
  for (const finalizedBlockHeight of [999n, 1_000n]) {
    const evidence = evaluateExecutionReconciliation(reconciliationInput({
      observed: observedInput({
        signatureHistory: 'ABSENT', confirmationStatus: 'NOT_FOUND',
        finalizedBlockHeight, observedSlot: null, transaction: null,
        feeLamports: 0n, walletLamportDelta: 0n, baseDeltaRaw: 0n,
        quoteDeltaRaw: 0n, finalizedAtMs: 2_000,
      }),
    }));
    assert.equal(evidence.result, 'UNKNOWN');
    assert.equal(evidence.reasonCode, 'RECONCILIATION_REQUIRED');
  }
});

void test('never turns current absence, reorg or unknown history into NO_EFFECT', () => {
  for (const overrides of [
    { signatureHistory: 'UNKNOWN', confirmationStatus: 'NOT_FOUND' },
    { signatureHistory: 'PRESENT', confirmationStatus: 'ORPHANED' },
    { signatureHistory: 'PRESENT', confirmationStatus: 'CONFIRMED' },
  ] as const) {
    const evidence = evaluateExecutionReconciliation(reconciliationInput({
      observed: observedInput({
        ...overrides,
        finalizedBlockHeight: 1_001n,
        observedSlot: overrides.confirmationStatus === 'CONFIRMED' ? 500n : null,
        transaction: null,
        feeLamports: 0n,
        walletLamportDelta: 0n,
        baseDeltaRaw: 0n,
        quoteDeltaRaw: 0n,
        finalizedAtMs: null,
      }),
    }));
    assert.equal(evidence.result, 'UNKNOWN');
  }
});

void test('classifies observed deltas without an exact transaction as a balance mismatch', () => {
  const evidence = evaluateExecutionReconciliation(reconciliationInput({
    observed: observedInput({
      signatureHistory: 'ABSENT', confirmationStatus: 'NOT_FOUND',
      finalizedBlockHeight: 1_001n, observedSlot: null, transaction: null,
      feeLamports: 0n, walletLamportDelta: -1n, baseDeltaRaw: 0n,
      quoteDeltaRaw: 0n, finalizedAtMs: 2_000,
    }),
  }));

  assert.equal(evidence.result, 'MISMATCH');
  assert.equal(evidence.reasonCode, 'BALANCE_MISMATCH');
});

void test('classifies transaction identity conflicts and residual balances explicitly', () => {
  const identity = evaluateExecutionReconciliation(reconciliationInput({
    observed: observedInput({
      transaction: transactionInput({ messageHash: 'e'.repeat(64) }),
    }),
  }));
  assert.equal(identity.result, 'MISMATCH');
  assert.equal(identity.reasonCode, 'DOUBLE_ORDER_SUSPECTED');

  const residual = evaluateExecutionReconciliation(reconciliationInput({
    observed: observedInput({ unexpectedResidualTokenBalanceRaw: 1n }),
  }));
  assert.equal(residual.result, 'MISMATCH');
  assert.equal(residual.reasonCode, 'RESIDUAL_TOKEN_BALANCE');
});

void test('requires conservative BUY and SELL delta directions and configured fee bounds', () => {
  for (const observed of [
    observedInput({ baseDeltaRaw: -1n }),
    observedInput({ quoteDeltaRaw: 1n }),
    observedInput({ feeLamports: 11n }),
    observedInput({ walletLamportDelta: -1_001n }),
  ]) {
    const evidence = evaluateExecutionReconciliation(reconciliationInput({ observed }));
    assert.equal(evidence.result, 'MISMATCH');
    assert.equal(evidence.reasonCode, 'BALANCE_MISMATCH');
  }

  const sell = evaluateExecutionReconciliation(reconciliationInput({
    expected: expectedInput({ side: 'SELL' }),
    observed: observedInput({
      walletLamportDelta: 95n, baseDeltaRaw: -500n, quoteDeltaRaw: 100n,
    }),
  }));
  assert.equal(sell.result, 'MATCHED');
});

void test('rejects malformed causal identities, numbers, extra fields, accessors and proxies', () => {
  assertInvalid(() => evaluateExecutionReconciliation(reconciliationInput({
    expected: expectedInput({ lastValidBlockHeight: 1_000 }),
  })));
  assertInvalid(() => evaluateExecutionReconciliation({ ...reconciliationInput(), extra: true }));
  assertInvalid(() => evaluateExecutionReconciliation(reconciliationInput({
    observed: observedInput({ finalizedAtMs: 1_899 }),
  })));

  let getterCalls = 0;
  const accessor = reconciliationInput() as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, 'expected', {
    enumerable: true,
    get: () => { getterCalls += 1; return expectedInput(); },
  });
  assertInvalid(() => evaluateExecutionReconciliation(accessor));
  assert.equal(getterCalls, 0);

  let traps = 0;
  const proxy = new Proxy(reconciliationInput(), {
    getOwnPropertyDescriptor: () => { traps += 1; throw new Error('reconciliation-secret'); },
    getPrototypeOf: () => { traps += 1; throw new Error('reconciliation-secret'); },
  });
  assertInvalid(() => evaluateExecutionReconciliation(proxy));
  assert.equal(traps, 0);
});

function reconciliationInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { expected: expectedInput(), observed: observedInput(), ...overrides };
}

function expectedInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    intentId: INTENT_ID,
    attemptNumber: 1,
    walletGeneration: 1,
    providerId: 'primary',
    side: 'BUY',
    signature: SIGNATURE,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 1_000n,
    messageHash: MESSAGE_HASH,
    buildFingerprint: BUILD_FINGERPRINT,
    snapshotFingerprint: SNAPSHOT_FINGERPRINT,
    maximumFeeLamports: 10n,
    maximumFeePayerLamportDebit: 1_000n,
    ...overrides,
  });
}

function observedInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    signatureHistory: 'PRESENT',
    confirmationStatus: 'FINALIZED',
    finalizedBlockHeight: 999n,
    observedSlot: 500n,
    transaction: transactionInput(),
    feeLamports: 5n,
    walletLamportDelta: -105n,
    baseDeltaRaw: 500n,
    quoteDeltaRaw: -100n,
    unexpectedResidualTokenBalanceRaw: 0n,
    observedAtMs: 1_900,
    finalizedAtMs: 2_000,
    ...overrides,
  });
}

function transactionInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    signature: SIGNATURE,
    blockhash: BLOCKHASH,
    messageHash: MESSAGE_HASH,
    buildFingerprint: BUILD_FINGERPRINT,
    snapshotFingerprint: SNAPSHOT_FINGERPRINT,
    ...overrides,
  });
}

function assertInvalid(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof ExecutionReconciliationValidationError);
    assert.equal(error.name, 'ExecutionReconciliationValidationError');
    assert.equal(error.message, 'Invalid execution reconciliation input.');
    return true;
  });
}
