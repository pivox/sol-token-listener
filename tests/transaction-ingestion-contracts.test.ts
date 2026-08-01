import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LISTENER_RUNTIME_STATES,
  TRANSACTION_INBOX_STATUSES,
  assertValidClaimedTransaction,
  assertValidFinalityCandidate,
  assertValidIngestionFailure,
  assertValidProcessingCheckpoint,
  assertValidRuntimeHeartbeat,
  assertValidTransactionNotification,
  type ClaimedTransaction,
  type FinalityCandidate,
  type IngestionFailure,
  type ProcessingCheckpoint,
  type RuntimeHeartbeat,
  type TransactionNotification,
} from '../src/domain/transaction-ingestion.js';

const observedAtMs = 1_720_000_000_000;

void test('publishes exact frozen ingestion status constants', () => {
  assert.deepEqual(TRANSACTION_INBOX_STATUSES, [
    'PENDING', 'PROCESSING', 'PROCESSED', 'FAILED',
  ]);
  assert.deepEqual(LISTENER_RUNTIME_STATES, [
    'STARTING', 'RUNNING', 'DEGRADED', 'STOPPING', 'STOPPED',
  ]);
  assert.ok(Object.isFrozen(TRANSACTION_INBOX_STATUSES));
  assert.ok(Object.isFrozen(LISTENER_RUNTIME_STATES));
});

void test('accepts canonical frozen ingestion contracts with bigint slots and integer milliseconds', () => {
  const notification: TransactionNotification = Object.freeze({
    signature: 'signature',
    slot: 42n,
    source: 'WEBSOCKET',
    confirmationStatus: 'confirmed',
    observedAtMs,
  });
  const claim: ClaimedTransaction = Object.freeze({
    signature: notification.signature,
    slot: notification.slot,
    confirmationStatus: notification.confirmationStatus,
    attempts: 0,
    leaseToken: 'opaque-token',
    leaseExpiresAtMs: observedAtMs + 120_000,
    normalizedTransaction: null,
  });
  const failure: IngestionFailure = Object.freeze({
    code: 'RPC_TRANSIENT',
    errorName: 'RpcUnavailableError',
    retryable: true,
  });
  const checkpoint: ProcessingCheckpoint = Object.freeze({
    key: 'launchpad',
    slot: 42n,
    signature: 'signature',
    updatedAtMs: observedAtMs,
  });
  const candidate: FinalityCandidate = Object.freeze({
    signature: 'signature',
    slot: 42n,
    confirmationStatus: 'confirmed',
    missingFinalityPolls: 0,
    processedAtMs: observedAtMs,
  });
  const heartbeat: RuntimeHeartbeat = Object.freeze({
    runtimeState: 'RUNNING',
    subscriberState: 'RUNNING',
    scannerState: 'RUNNING',
    workerState: 'RUNNING',
    reconcilerState: 'RUNNING',
    startedAtMs: observedAtMs,
    updatedAtMs: observedAtMs + 1_000,
    lastHttpSlot: 45n,
    lastWebsocketSlot: 44n,
    lastFinalizedSlot: 43n,
    lastSignature: 'signature',
    backlogCount: 2,
    leasedCount: 1,
  });

  assert.doesNotThrow(() => { assertValidTransactionNotification(notification); });
  assert.doesNotThrow(() => { assertValidClaimedTransaction(claim); });
  assert.doesNotThrow(() => { assertValidIngestionFailure(failure); });
  assert.doesNotThrow(() => { assertValidProcessingCheckpoint(checkpoint); });
  assert.doesNotThrow(() => { assertValidFinalityCandidate(candidate); });
  assert.doesNotThrow(() => { assertValidRuntimeHeartbeat(heartbeat); });
  assert.equal(typeof notification.slot, 'bigint');
  assert.ok(Number.isSafeInteger(heartbeat.updatedAtMs));
});

void test('rejects mutable contracts, number slots and non-integer millisecond times', () => {
  const notification = Object.freeze({
    signature: 'signature',
    slot: 42n,
    source: 'CATCH_UP' as const,
    confirmationStatus: 'finalized' as const,
    observedAtMs,
  });
  assert.throws(
    () => { assertValidTransactionNotification({ ...notification }); },
    /frozen/u,
  );
  assert.throws(
    () => { assertValidTransactionNotification(Object.freeze({ ...notification, slot: 42 })); },
    /slot|bigint/u,
  );
  assert.throws(
    () => { assertValidTransactionNotification(Object.freeze({ ...notification, observedAtMs: 1.5 })); },
    /observedAtMs|milliseconds/u,
  );
});

void test('rejects negative, fractional and unsafe ingestion counts', () => {
  const candidate = Object.freeze({
    signature: 'signature',
    slot: 42n,
    confirmationStatus: 'confirmed' as const,
    missingFinalityPolls: 0,
    processedAtMs: observedAtMs,
  });
  for (const missingFinalityPolls of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => { assertValidFinalityCandidate(Object.freeze({ ...candidate, missingFinalityPolls })); },
      /missingFinalityPolls|safe integer/u,
    );
  }
});

void test('rejects invalid discovery sources and ingestion error codes', () => {
  assert.throws(
    () => { assertValidTransactionNotification(Object.freeze({
      signature: 'signature',
      slot: 42n,
      source: 'POLLING',
      confirmationStatus: 'confirmed',
      observedAtMs,
    })); },
    /source/u,
  );
  assert.throws(
    () => { assertValidIngestionFailure(Object.freeze({
      code: 'UNKNOWN',
      errorName: 'Error',
      retryable: false,
    })); },
    /code/u,
  );
});
