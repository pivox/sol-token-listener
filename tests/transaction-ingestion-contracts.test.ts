import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PublicKey,
  SystemProgram,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import {
  LISTENER_RUNTIME_STATES,
  TRANSACTION_INBOX_RECOVERY_RESULT_CODES,
  MAX_TRANSACTION_SNAPSHOT_ARRAY_LENGTH,
  MAX_TRANSACTION_SNAPSHOT_DEPTH,
  MAX_TRANSACTION_SNAPSHOT_INSTRUCTION_BYTES,
  MAX_TRANSACTION_SNAPSHOT_NODES,
  MAX_TRANSACTION_SNAPSHOT_TEXT_BYTES,
  MAX_TRANSACTION_SNAPSHOT_STRING_LENGTH,
  TRANSACTION_INBOX_STATUSES,
  assertValidClaimedTransaction,
  assertValidFinalityCandidate,
  assertValidFinalityPollObservation,
  assertValidIngestionFailure,
  assertValidInboxCounts,
  assertValidInboxRecoveryResult,
  assertValidProcessingCheckpoint,
  assertValidRuntimeHeartbeat,
  assertValidTransactionNotification,
  createDurableTransactionSnapshot,
  restoreNormalizedTransactionSnapshot,
  type ClaimedTransaction,
  type FinalityCandidate,
  type FinalityPollObservation,
  type IngestionFailure,
  type InboxRecoveryResult,
  type ProcessingCheckpoint,
  type RuntimeHeartbeat,
  type TransactionNotification,
} from '../src/domain/transaction-ingestion.js';
import type { NormalizedTransaction } from '../src/solana/rpc/types.js';
import { normalizeTransaction } from '../src/solana/rpc/transaction-fetcher.js';

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
  assert.deepEqual(TRANSACTION_INBOX_RECOVERY_RESULT_CODES, [
    'RECOVERY_SCHEDULED',
    'RECOVERY_ALREADY_SCHEDULED',
    'RECOVERY_NOT_ELIGIBLE',
    'RECOVERY_NOT_FOUND',
  ]);
  assert.ok(Object.isFrozen(TRANSACTION_INBOX_RECOVERY_RESULT_CODES));
});

void test('accepts canonical frozen ingestion contracts with bigint slots and integer milliseconds', () => {
  const notification: TransactionNotification = Object.freeze({
    signature: 'signature',
    slot: 42n,
    source: 'WEBSOCKET',
    programIds: Object.freeze([PUMP_PROGRAM_ID]),
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
  const finalityPoll: FinalityPollObservation = Object.freeze({
    signature: 'signature',
    confirmationStatus: null,
    expectedMissingFinalityPolls: 0,
    observedAtMs,
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
    exhaustedCount: 3,
  });
  const recovery: InboxRecoveryResult = Object.freeze({
    code: 'RECOVERY_SCHEDULED',
    signature: 'signature',
  });

  assert.doesNotThrow(() => { assertValidTransactionNotification(notification); });
  assert.doesNotThrow(() => { assertValidClaimedTransaction(claim); });
  assert.doesNotThrow(() => { assertValidIngestionFailure(failure); });
  assert.doesNotThrow(() => { assertValidProcessingCheckpoint(checkpoint); });
  assert.doesNotThrow(() => { assertValidFinalityCandidate(candidate); });
  assert.doesNotThrow(() => { assertValidFinalityPollObservation(finalityPoll); });
  assert.doesNotThrow(() => { assertValidRuntimeHeartbeat(heartbeat); });
  assert.doesNotThrow(() => { assertValidInboxRecoveryResult(recovery); });
  assert.equal(typeof notification.slot, 'bigint');
  assert.ok(Number.isSafeInteger(heartbeat.updatedAtMs));
});

void test('accepts a deeply frozen snapshot whose earlier finality can advance on the claim', () => {
  const snapshot = durableSnapshot({ confirmationStatus: 'CONFIRMED' });
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
      ...durableSnapshot(),
      feeLamports: 1,
    }))); },
    /feeLamports|bigint/u,
  );
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(durableSnapshot({ transactionIndex: -1 }))); },
    /transactionIndex|cursor/u,
  );
});

void test('rejects snapshots whose durable identity differs from the claim', () => {
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(durableSnapshot({ signature: 'other' }))); },
    /signature|identity/u,
  );
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(durableSnapshot({ slot: 43n }))); },
    /slot|identity/u,
  );
});

void test('rejects snapshot finality regressions and terminal conflicts', () => {
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(
      durableSnapshot({ confirmationStatus: 'FINALIZED' }),
      { confirmationStatus: 'confirmed' },
    )); },
    /confirmation|finality/u,
  );
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(
      durableSnapshot({ confirmationStatus: 'FINALIZED' }),
      { confirmationStatus: 'orphaned' },
    )); },
    /confirmation|finality/u,
  );
});

void test('rejects mutable nested normalized transaction collections', () => {
  const canonical = durableSnapshot();
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

void test('encodes non-empty instruction bytes immutably and restores independent decoder bytes', () => {
  const normalized = normalizedTransaction({ instructionData: new Uint8Array([1, 2, 3]) });
  const snapshot = createDurableTransactionSnapshot(normalized);

  assert.equal(snapshot.instructions[0]?.dataBase64, 'AQID');
  normalized.instructions[0]?.data.fill(9);
  assert.equal(snapshot.instructions[0]?.dataBase64, 'AQID');
  assert.equal(
    Reflect.set(snapshot.instructions[0] ?? {}, 'dataBase64', 'CQkJ'),
    false,
  );
  assert.equal(snapshot.instructions[0]?.dataBase64, 'AQID');

  const restored = restoreNormalizedTransactionSnapshot(snapshot);
  const restoredInstruction = restored.instructions[0];
  assert.ok(restoredInstruction);
  assert.deepEqual([...restoredInstruction.data], [1, 2, 3]);
  restoredInstruction.data.fill(7);
  assert.equal(snapshot.instructions[0]?.dataBase64, 'AQID');
});

void test('accepts actual normalized RPC output when token balance programId is absent', () => {
  const normalized = normalizeTransaction(
    rpcResponseWithoutTokenProgram(),
    'CONFIRMED',
    0,
  );
  assert.equal(normalized.preTokenBalances[0]?.tokenProgram, '');
  assert.equal(normalized.postTokenBalances[0]?.tokenProgram, '');

  const snapshot = createDurableTransactionSnapshot(normalized);
  assert.doesNotThrow(() => { assertValidClaimedTransaction(claimWithSnapshot(snapshot)); });
  assert.equal(snapshot.preTokenBalances[0]?.tokenProgram, '');
  assert.equal(snapshot.postTokenBalances[0]?.tokenProgram, '');
});

void test('rejects stateful top-level and nested accessors without invoking them', () => {
  const canonical = durableSnapshot();
  let signatureReads = 0;
  const hostileTopLevel = { ...canonical };
  Object.defineProperty(hostileTopLevel, 'signature', {
    enumerable: true,
    get: () => {
      signatureReads += 1;
      return signatureReads === 1 ? 'signature' : 'other';
    },
  });
  Object.freeze(hostileTopLevel);
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(hostileTopLevel)); },
    /accessor|data property|descriptor/u,
  );
  assert.equal(signatureReads, 0);

  let programReads = 0;
  const hostileInstruction = { ...canonical.instructions[0] };
  Object.defineProperty(hostileInstruction, 'programId', {
    enumerable: true,
    get: () => { programReads += 1; return 'program'; },
  });
  Object.freeze(hostileInstruction);
  const hostileNested = Object.freeze({
    ...canonical,
    instructions: Object.freeze([hostileInstruction]),
  });
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(hostileNested)); },
    /accessor|data property|descriptor/u,
  );
  assert.equal(programReads, 0);
});

void test('rejects sparse and accessor durable arrays without invoking inherited or own getters', () => {
  const canonical = durableSnapshot();
  const sparse = new Array<unknown>(1);
  Object.freeze(sparse);
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(Object.freeze({
      ...canonical,
      instructions: sparse,
    }))); },
    /sparse|array|descriptor/u,
  );

  let instructionReads = 0;
  const accessorArray: unknown[] = [];
  Object.defineProperty(accessorArray, '0', {
    enumerable: true,
    configurable: false,
    get: () => { instructionReads += 1; return canonical.instructions[0]; },
  });
  Object.defineProperty(accessorArray, 'length', { value: 1, writable: false });
  Object.freeze(accessorArray);
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(Object.freeze({
      ...canonical,
      instructions: accessorArray,
    }))); },
    /accessor|data property|descriptor/u,
  );
  assert.equal(instructionReads, 0);
});

void test('rejects hostile durable prototypes and hidden symbol properties', () => {
  const canonical = durableSnapshot();
  const hostilePrototype = Object.assign(Object.create({ polluted: true }), canonical) as object;
  Object.freeze(hostilePrototype);
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(hostilePrototype)); },
    /prototype|plain/u,
  );

  const symbol = Symbol('hidden');
  const hiddenSymbol = { ...canonical, [symbol]: true };
  Object.freeze(hiddenSymbol);
  assert.throws(
    () => { assertValidClaimedTransaction(claimWithSnapshot(hiddenSymbol)); },
    /symbol|property/u,
  );
});

void test('rejects malformed and non-canonical durable instruction base64 directly', () => {
  const canonical = durableSnapshot();
  for (const dataBase64 of ['***', 'AQI']) {
    const instruction = Object.freeze({
      ...canonical.instructions[0],
      dataBase64,
    });
    const snapshot = Object.freeze({
      ...canonical,
      instructions: Object.freeze([instruction]),
    });
    assert.throws(
      () => { assertValidClaimedTransaction(claimWithSnapshot(snapshot)); },
      /base64|canonical/u,
    );
  }
});

void test('accepts exact durable depth and rejects boundary plus one', () => {
  assert.doesNotThrow(() => createDurableTransactionSnapshot(normalizedTransaction({
    error: nestedError(MAX_TRANSACTION_SNAPSHOT_DEPTH - 1),
  })));
  assert.throws(
    () => createDurableTransactionSnapshot(normalizedTransaction({
      error: nestedError(MAX_TRANSACTION_SNAPSHOT_DEPTH),
    })),
    /maximum depth/u,
  );
});

void test('accepts exact durable node budget and rejects one additional entry', () => {
  assert.doesNotThrow(() => createDurableTransactionSnapshot(normalizedTransaction({
    error: nodeBudgetError(0),
  })));
  assert.throws(
    () => createDurableTransactionSnapshot(normalizedTransaction({
      error: nodeBudgetError(1),
    })),
    /maximum node/u,
  );
});

void test('accepts exact durable array and string limits and rejects boundary plus one', () => {
  assert.doesNotThrow(() => createDurableTransactionSnapshot(normalizedTransaction({
    error: Object.freeze(new Array<null>(MAX_TRANSACTION_SNAPSHOT_ARRAY_LENGTH).fill(null)),
  })));
  assert.throws(
    () => createDurableTransactionSnapshot(normalizedTransaction({
      error: Object.freeze(new Array<null>(MAX_TRANSACTION_SNAPSHOT_ARRAY_LENGTH + 1).fill(null)),
    })),
    /maximum array length/u,
  );
  assert.doesNotThrow(() => createDurableTransactionSnapshot(normalizedTransaction({
    error: 'x'.repeat(MAX_TRANSACTION_SNAPSHOT_STRING_LENGTH),
  })));
  assert.throws(
    () => createDurableTransactionSnapshot(normalizedTransaction({
      error: 'x'.repeat(MAX_TRANSACTION_SNAPSHOT_STRING_LENGTH + 1),
    })),
    /maximum string length/u,
  );
});

void test('bounds object keys by UTF-8 bytes before using them in validation paths', () => {
  const exactKey = 'é'.repeat(MAX_TRANSACTION_SNAPSHOT_STRING_LENGTH / 2);
  assert.equal(Buffer.byteLength(exactKey, 'utf8'), MAX_TRANSACTION_SNAPSHOT_STRING_LENGTH);
  assert.doesNotThrow(() => createDurableTransactionSnapshot(normalizedTransaction({
    error: Object.freeze({ [exactKey]: null }),
  })));
  assert.throws(
    () => createDurableTransactionSnapshot(normalizedTransaction({
      error: Object.freeze({ [`${exactKey}a`]: null }),
    })),
    /property key.*maximum string length/u,
  );
});

void test('accepts exact aggregate UTF-8 text bytes and rejects one additional byte', () => {
  const canonical = createDurableTransactionSnapshot(normalizedTransaction());
  const remaining = MAX_TRANSACTION_SNAPSHOT_TEXT_BYTES - durableTextBytes(canonical);
  assert.ok(remaining > MAX_TRANSACTION_SNAPSHOT_STRING_LENGTH);
  assert.doesNotThrow(() => createDurableTransactionSnapshot(normalizedTransaction({
    error: textPayload(remaining),
  })));
  assert.throws(
    () => createDurableTransactionSnapshot(normalizedTransaction({
      error: textPayload(remaining + 1),
    })),
    /maximum text bytes/u,
  );
});

void test('accepts exact decoded instruction byte limit and rejects boundary plus one', () => {
  const exact = createDurableTransactionSnapshot(normalizedTransaction({
    instructionData: new Uint8Array(MAX_TRANSACTION_SNAPSHOT_INSTRUCTION_BYTES),
  }));
  assert.equal(
    restoreNormalizedTransactionSnapshot(exact).instructions[0]?.data.byteLength,
    MAX_TRANSACTION_SNAPSHOT_INSTRUCTION_BYTES,
  );
  assert.throws(
    () => createDurableTransactionSnapshot(normalizedTransaction({
      instructionData: new Uint8Array(MAX_TRANSACTION_SNAPSHOT_INSTRUCTION_BYTES + 1),
    })),
    /maximum instruction bytes/u,
  );
});

void test('rejects very deep acyclic and cyclic error payloads with bounded TypeErrors', () => {
  const deep = nestedError(10_000);
  assert.throws(
    () => createDurableTransactionSnapshot(normalizedTransaction({ error: deep })),
    (error: unknown) => error instanceof TypeError && error.message.includes('maximum depth'),
  );
  const cycle: unknown[] = [];
  cycle.push(cycle);
  assert.throws(
    () => createDurableTransactionSnapshot(normalizedTransaction({ error: cycle })),
    (error: unknown) => error instanceof TypeError && error.message.includes('cycle'),
  );
});

void test('rejects negative zero anywhere in durable error data while keeping finite numbers', () => {
  assert.throws(
    () => createDurableTransactionSnapshot(normalizedTransaction({
      error: Object.freeze({ nested: Object.freeze({ value: -0 }) }),
    })),
    (error: unknown) => error instanceof TypeError
      && error.message === 'Normalized transaction error.nested.value must not be negative zero.',
  );
  const snapshot = createDurableTransactionSnapshot(normalizedTransaction({
    error: Object.freeze({ negative: -1.25, positiveZero: 0, positive: 1.25 }),
  }));
  assert.deepEqual(snapshot.error, { negative: -1.25, positiveZero: 0, positive: 1.25 });
  assert.equal(Object.is((snapshot.error as { readonly positiveZero: number }).positiveZero, -0), false);
});

void test('rejects mutable contracts, number slots and non-integer millisecond times', () => {
  const notification = Object.freeze({
    signature: 'signature',
    slot: 42n,
    source: 'CATCH_UP' as const,
    programIds: Object.freeze([PUMP_PROGRAM_ID]),
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
  const poll = Object.freeze({
    signature: 'signature', confirmationStatus: null, expectedMissingFinalityPolls: 0,
    observedAtMs,
  });
  for (const expectedMissingFinalityPolls of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => { assertValidFinalityPollObservation(Object.freeze({
        ...poll, expectedMissingFinalityPolls,
      })); },
      /expectedMissingFinalityPolls|safe integer/u,
    );
  }
  assert.throws(
    () => { assertValidFinalityPollObservation(Object.freeze({
      ...poll, confirmationStatus: 'finalized',
    })); },
    /confirmationStatus/u,
  );
  const counts = Object.freeze({
    pending: 0,
    processing: 0,
    processed: 0,
    failed: 2,
    retryableFailed: 1,
    exhaustedFailed: 1,
  });
  assert.doesNotThrow(() => { assertValidInboxCounts(counts); });
  assert.throws(
    () => { assertValidInboxCounts(Object.freeze({ ...counts, exhaustedFailed: 2 })); },
    /exhaustedFailed|failed/u,
  );
  assert.throws(
    () => { assertValidRuntimeHeartbeat(Object.freeze({
      runtimeState: 'RUNNING', subscriberState: 'RUNNING', scannerState: 'RUNNING',
      workerState: 'RUNNING', reconcilerState: 'RUNNING', startedAtMs: observedAtMs,
      updatedAtMs: observedAtMs, lastHttpSlot: null, lastWebsocketSlot: null,
      lastFinalizedSlot: null, lastSignature: null, backlogCount: 0, leasedCount: 0,
      exhaustedCount: -1,
    })); },
    /exhaustedCount/u,
  );
});

void test('rejects invalid discovery sources and ingestion error codes', () => {
  assert.throws(
    () => { assertValidTransactionNotification(Object.freeze({
      signature: 'signature',
      slot: 42n,
      source: 'POLLING',
      programIds: Object.freeze([PUMP_PROGRAM_ID]),
      confirmationStatus: 'confirmed',
      observedAtMs,
    })); },
    /source/u,
  );
  const notification = Object.freeze({
    signature: 'signature', slot: 42n, source: 'CATCH_UP' as const,
    confirmationStatus: 'confirmed' as const, observedAtMs,
  });
  for (const programIds of [
    [],
    [PUMP_PROGRAM_ID, SystemProgram.programId.toBase58()],
    [PUMP_PROGRAM_ID, PUMP_PROGRAM_ID],
    [` ${PUMP_PROGRAM_ID}`],
    ['0invalidBase58Address111111111111111111'],
    ['111'],
    [`1${SystemProgram.programId.toBase58()}`],
    ['x'.repeat(129)],
    validProgramIds(17),
  ]) {
    assert.throws(
      () => { assertValidTransactionNotification(Object.freeze({
        ...notification, programIds: Object.freeze(programIds),
      })); },
      /programIds/u,
    );
  }
  assert.throws(
    () => { assertValidIngestionFailure(Object.freeze({
      code: 'UNKNOWN',
      errorName: 'Error',
      retryable: false,
    })); },
    /code/u,
  );
  assert.doesNotThrow(() => { assertValidIngestionFailure(Object.freeze({
    code: 'WORKER_LEASE_EXPIRED',
    errorName: 'TransactionInboxLeaseExpired',
    retryable: true,
  })); });
  assert.throws(
    () => { assertValidInboxRecoveryResult(Object.freeze({
      code: 'RECOVERY_UNKNOWN', signature: 'signature',
    })); },
    /code/u,
  );
});

function validProgramIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    new PublicKey(Uint8Array.from({ length: 32 }, () => index + 1)).toBase58()).sort();
}

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

function durableSnapshot(
  overrides: Readonly<Partial<NormalizedTransaction>> = {},
): ReturnType<typeof createDurableTransactionSnapshot> {
  return createDurableTransactionSnapshot(normalizedTransaction(overrides));
}

function normalizedTransaction(
  overrides: Readonly<Partial<NormalizedTransaction>> & {
    readonly instructionData?: Uint8Array;
  } = {},
): NormalizedTransaction {
  const instruction = {
    programId: 'program',
    accounts: ['account'],
    data: overrides.instructionData ?? new Uint8Array([1]),
    instructionIndex: 0,
    innerInstructionIndex: null,
    parentInstructionIndex: null,
    stackHeight: 1,
  };
  const balance = {
    accountIndex: 0,
    account: 'account',
    mint: 'mint',
    owner: 'owner',
    tokenProgram: 'token-program',
    amountRaw: 1n,
    decimals: 9,
  };
  const { instructionData: _instructionData, ...transactionOverrides } = overrides;
  return {
    signature: 'signature',
    slot: 42n,
    transactionIndex: 0,
    confirmationStatus: 'CONFIRMED',
    version: 0,
    blockTimeMs: observedAtMs,
    accountKeys: ['account'],
    signerKeys: ['account'],
    instructions: [instruction],
    preTokenBalances: [balance],
    postTokenBalances: [balance],
    preBalancesLamports: [1n],
    postBalancesLamports: [1n],
    feeLamports: 5_000n,
    computeUnits: 1_000n,
    logs: ['log'],
    error: null,
    ...transactionOverrides,
  };
}

function rpcResponseWithoutTokenProgram(): VersionedTransactionResponse {
  const payer = new PublicKey('11111111111111111111111111111111');
  const program = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  const tokenAccount = new PublicKey('So11111111111111111111111111111111111111112');
  const accountKeys = [payer, program, tokenAccount];
  const tokenBalance = {
    accountIndex: 2,
    mint: tokenAccount.toBase58(),
    owner: payer.toBase58(),
    uiTokenAmount: {
      amount: '1',
      decimals: 9,
      uiAmount: 0.000000001,
      uiAmountString: '0.000000001',
    },
  };
  return {
    slot: 42,
    blockTime: 1_720_000_000,
    version: 'legacy',
    transaction: {
      signatures: ['signature'],
      message: {
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 1,
        },
        compiledInstructions: [{
          programIdIndex: 1,
          accountKeyIndexes: [2],
          data: new Uint8Array([1, 2, 3]),
        }],
        getAccountKeys: () => ({
          length: accountKeys.length,
          get: (index: number) => accountKeys[index],
        }),
      },
    },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [10_000, 0, 0],
      postBalances: [5_000, 0, 0],
      innerInstructions: [],
      preTokenBalances: [tokenBalance],
      postTokenBalances: [tokenBalance],
      loadedAddresses: { writable: [], readonly: [] },
      logMessages: ['log'],
      rewards: [],
    },
  } as unknown as VersionedTransactionResponse;
}

function nestedError(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = Object.freeze([value]);
  return value;
}

function nodeBudgetError(additionalEntries: number): unknown {
  const canonicalNodesOutsideError = 47;
  const containerNodes = 4;
  const entryCount = MAX_TRANSACTION_SNAPSHOT_NODES
    - canonicalNodesOutsideError
    - containerNodes
    + additionalEntries;
  const firstLength = MAX_TRANSACTION_SNAPSHOT_ARRAY_LENGTH;
  const secondLength = MAX_TRANSACTION_SNAPSHOT_ARRAY_LENGTH;
  const thirdLength = entryCount - firstLength - secondLength;
  return Object.freeze({
    first: Object.freeze(new Array<null>(firstLength).fill(null)),
    second: Object.freeze(new Array<null>(secondLength).fill(null)),
    third: Object.freeze(new Array<null>(thirdLength).fill(null)),
  });
}

function textPayload(bytes: number): readonly string[] {
  const values: string[] = [];
  let remaining = bytes;
  while (remaining > 0) {
    const length = Math.min(remaining, MAX_TRANSACTION_SNAPSHOT_STRING_LENGTH);
    values.push('x'.repeat(length));
    remaining -= length;
  }
  return Object.freeze(values);
}

function durableTextBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Array.isArray(value)) {
    const items = value as readonly unknown[];
    return items.reduce<number>((total, item) => total + durableTextBytes(item), 0);
  }
  if (typeof value !== 'object' || value === null) return 0;
  return Object.entries(value).reduce(
    (total, [key, item]) => total + Buffer.byteLength(key, 'utf8') + durableTextBytes(item),
    0,
  );
}
