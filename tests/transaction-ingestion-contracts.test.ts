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
import type { NormalizedTransaction } from '../src/solana/rpc/types.js';

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

void test('accepts a deeply frozen snapshot whose earlier finality can advance on the claim', () => {
  const snapshot = normalizedSnapshot({ confirmationStatus: 'CONFIRMED' });
  const claim: ClaimedTransaction = Object.freeze({
    signature: snapshot.signature,
    slot: snapshot.slot,
    confirmationStatus: 'finalized',
    attempts: 1,
    leaseToken: 'opaque-token',
    leaseExpiresAtMs: observedAtMs + 120_000,
    normalizedTransaction: snapshot,
  });

  assert.doesNotThrow(() => { assertValidClaimedTransaction(claim); });
});

void test('rejects empty and malformed normalized transaction snapshots', () => {
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(Object.freeze({}))); },
    /snapshot|signature/u,
  );
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(Object.freeze({
      ...normalizedSnapshot(),
      feeLamports: 1,
    }))); },
    /feeLamports|bigint/u,
  );
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(normalizedSnapshot({ transactionIndex: -1 }))); },
    /transactionIndex|cursor/u,
  );
});

void test('rejects snapshots whose durable identity differs from the claim', () => {
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(normalizedSnapshot({ signature: 'other' }))); },
    /signature|identity/u,
  );
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(normalizedSnapshot({ slot: 43n }))); },
    /slot|identity/u,
  );
});

void test('rejects snapshot finality regressions and terminal conflicts', () => {
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(
      normalizedSnapshot({ confirmationStatus: 'FINALIZED' }),
      { confirmationStatus: 'confirmed' },
    )); },
    /confirmation|finality/u,
  );
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(
      normalizedSnapshot({ confirmationStatus: 'FINALIZED' }),
      { confirmationStatus: 'orphaned' },
    )); },
    /confirmation|finality/u,
  );
});

void test('rejects mutable nested normalized transaction collections', () => {
  const canonical = normalizedSnapshot();
  const mutableAccountKeys = Object.freeze({
    ...canonical,
    accountKeys: [...canonical.accountKeys],
  });
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(mutableAccountKeys)); },
    /accountKeys|frozen/u,
  );

  const mutableInstructionAccounts = Object.freeze({
    ...canonical,
    instructions: Object.freeze([
      Object.freeze({
        ...canonical.instructions[0],
        accounts: ['account'],
      }),
    ]),
  });
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(mutableInstructionAccounts)); },
    /accounts|frozen/u,
  );
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

function claimWithSnapshot(
  normalizedTransaction: unknown,
  overrides: Readonly<Partial<ClaimedTransaction>> = {},
): ClaimedTransaction {
  return Object.freeze({
    signature: 'signature',
    slot: 42n,
    confirmationStatus: 'confirmed',
    attempts: 0,
    leaseToken: 'opaque-token',
    leaseExpiresAtMs: observedAtMs + 120_000,
    normalizedTransaction,
    ...overrides,
  }) as ClaimedTransaction;
}

function normalizedSnapshot(
  overrides: Readonly<Partial<NormalizedTransaction>> = {},
): Readonly<NormalizedTransaction> {
  const instruction = Object.freeze({
    programId: 'program',
    accounts: Object.freeze(['account']),
    data: Object.freeze(new Uint8Array()),
    instructionIndex: 0,
    innerInstructionIndex: null,
    parentInstructionIndex: null,
    stackHeight: 1,
  });
  const balance = Object.freeze({
    accountIndex: 0,
    account: 'account',
    mint: 'mint',
    owner: 'owner',
    tokenProgram: 'token-program',
    amountRaw: 1n,
    decimals: 9,
  });
  return Object.freeze({
    signature: 'signature',
    slot: 42n,
    transactionIndex: 0,
    confirmationStatus: 'CONFIRMED',
    version: 0,
    blockTimeMs: observedAtMs,
    accountKeys: Object.freeze(['account']),
    signerKeys: Object.freeze(['account']),
    instructions: Object.freeze([instruction]),
    preTokenBalances: Object.freeze([balance]),
    postTokenBalances: Object.freeze([balance]),
    preBalancesLamports: Object.freeze([1n]),
    postBalancesLamports: Object.freeze([1n]),
    feeLamports: 5_000n,
    computeUnits: 1_000n,
    logs: Object.freeze(['log']),
    error: null,
    ...overrides,
  });
}
