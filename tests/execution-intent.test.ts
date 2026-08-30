import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertExecutionAttemptStatusReason,
  assertExecutionIntent,
  assertExecutionIntentTransition,
  assertExecutionIntentTransitionReason,
  createExecutionIntentDraft,
  createExecutionIntentId,
  EXECUTION_INTENT_MAXIMUM_TTL_MS,
  EXECUTION_INTENT_REASON_CODES,
  EXECUTION_INTENT_STATUSES,
  ExecutionIntentValidationError,
  type ExecutionIntentDraftV1,
  type ExecutionIntentStatus,
  type ExecutionIntentV1,
} from '../src/domain/execution-intent.js';

const REQUESTED_AT_MS = 1_787_990_400_000;
const EXPIRES_AT_MS = 1_787_990_445_000;
const DATE_MAX_MS = 8_640_000_000_000_000;
const INT32_MAX = 2_147_483_647;
const INT64_MAX = 9_223_372_036_854_775_807n;
const U64_MAX = 18_446_744_073_709_551_615n;

void test('bounds every execution intent lifetime to the four-hour retention horizon', () => {
  assert.equal(EXECUTION_INTENT_MAXIMUM_TTL_MS, 14_400_000);
  assert.doesNotThrow(() => createExecutionIntentDraft(validInput({
    expiresAtMs: REQUESTED_AT_MS + EXECUTION_INTENT_MAXIMUM_TTL_MS,
  })));
  assertValidationFailure(() => createExecutionIntentDraft(validInput({
    expiresAtMs: REQUESTED_AT_MS + EXECUTION_INTENT_MAXIMUM_TTL_MS + 1,
  })));
});

void test('creates one frozen deterministic BUY intent using bigint amounts', () => {
  const first = createExecutionIntentDraft(validInput());
  const second = createExecutionIntentDraft(validInput());

  assert.equal(first.id, createExecutionIntentId(first));
  assert.equal(first.id, second.id);
  assert.equal(first.id, 'execution_intent_a8328e3681bbe158a8b06cd586cb02bbb187ef88d121bdefce05818b743e7b44');
  assert.equal(first.logicalOrderKey, 'paper_open_abc');
  assert.equal(first.payloadVersion, 1);
  assert.equal(first.quoteAmountRaw, 500_000n);
  assert.equal(first.baseAmountRaw, null);
  assert.equal(Object.isFrozen(first), true);
});

void test('uses length-prefixed identity fields that cannot collide through concatenation', () => {
  const first = createExecutionIntentId({
    strategyId: 'a', strategyVersion: 12, positionId: 'c', side: 'BUY', logicalCommandId: 'd',
  });
  const second = createExecutionIntentId({
    strategyId: 'a1', strategyVersion: 2, positionId: 'c', side: 'BUY', logicalCommandId: 'd',
  });

  assert.notEqual(first, second);
});

void test('publishes the exact immutable V1 status and reason vocabularies', () => {
  assert.deepEqual(EXECUTION_INTENT_STATUSES, [
    'PENDING', 'PROCESSING', 'SIMULATED', 'RETRY_READY', 'SIGNED_NOT_SUBMITTED',
    'SUBMITTED', 'CONFIRMED', 'RECONCILING', 'SUCCEEDED', 'FAILED',
    'EXPIRED', 'CANCELLED', 'UNKNOWN_REQUIRES_RECONCILIATION',
  ]);
  assert.deepEqual(EXECUTION_INTENT_REASON_CODES, [
    'INTENT_EXPIRED', 'INTENT_DUPLICATE', 'INTENT_LEASE_LOST',
    'QUALIFICATION_STALE', 'DECISION_STALE', 'QUOTE_STALE',
    'QUOTE_MINT_NOT_ALLOWED', 'VENUE_UNAVAILABLE', 'BUY_SIMULATION_FAILED',
    'SELL_SIMULATION_FAILED', 'SELL_QUOTE_UNAVAILABLE',
    'MINIMUM_AMOUNT_OUT_VIOLATED', 'UNSUPPORTED_TOKEN_EXTENSION',
    'WALLET_MISMATCH', 'GENESIS_MISMATCH', 'CAPITAL_LIMIT_EXCEEDED',
    'EXPOSURE_LIMIT_EXCEEDED', 'DRAWDOWN_LIMIT_EXCEEDED',
    'PROVIDER_USAGE_UNKNOWN', 'PROVIDER_ENTRY_LIMIT_REACHED',
    'PROVIDER_EXIT_ONLY', 'KILL_SWITCH_ACTIVE', 'HARD_STOP_ACTIVE',
    'ARMING_REQUIRED', 'ARMING_EXPIRED', 'SIGNATURE_PERSIST_FAILED',
    'SUBMISSION_AMBIGUOUS', 'CONFIRMATION_TIMEOUT',
    'RECONCILIATION_REQUIRED', 'BALANCE_MISMATCH', 'RESIDUAL_TOKEN_BALANCE',
    'DOUBLE_ORDER_SUSPECTED',
    'EXECUTION_STARTED', 'SIMULATION_SUCCEEDED', 'ATTEMPT_COMPLETED',
    'RETRY_AUTHORIZED', 'SIGNATURE_PERSISTED', 'SUBMISSION_ACCEPTED',
    'CONFIRMATION_OBSERVED', 'RECONCILIATION_STARTED', 'INTENT_SUCCEEDED',
    'INTENT_CANCELLED', 'RECONCILIATION_PROVED_NO_EFFECT',
  ]);
  assert.ok(Object.isFrozen(EXECUTION_INTENT_STATUSES));
  assert.ok(Object.isFrozen(EXECUTION_INTENT_REASON_CODES));
});

void test('requires explicit no-effect proof before releasing an unknown reconciliation state', () => {
  assert.doesNotThrow(() => {
    assertExecutionIntentTransitionReason(
      'UNKNOWN_REQUIRES_RECONCILIATION',
      'FAILED',
      'RECONCILIATION_PROVED_NO_EFFECT',
    );
  });
  assert.doesNotThrow(() => {
    assertExecutionIntentTransitionReason(
      'UNKNOWN_REQUIRES_RECONCILIATION',
      'RETRY_READY',
      'RECONCILIATION_PROVED_NO_EFFECT',
    );
  });
  assertValidationFailure(() => {
    assertExecutionIntentTransitionReason(
      'UNKNOWN_REQUIRES_RECONCILIATION', 'RETRY_READY', 'RETRY_AUTHORIZED',
    );
  });
  for (const unsafeReason of [
    'SUBMISSION_AMBIGUOUS',
    'CONFIRMATION_TIMEOUT',
    'RECONCILIATION_REQUIRED',
    'QUOTE_STALE',
  ]) {
    assertValidationFailure(() => {
      assertExecutionIntentTransitionReason(
        'UNKNOWN_REQUIRES_RECONCILIATION', 'FAILED', unsafeReason,
      );
    });
  }
  for (const previous of ['PROCESSING', 'SIMULATED']) {
    assertValidationFailure(() => {
      assertExecutionIntentTransitionReason(
        previous, 'FAILED', 'RECONCILIATION_PROVED_NO_EFFECT',
      );
    });
    assert.doesNotThrow(() => {
      assertExecutionIntentTransitionReason(previous, 'FAILED', 'QUOTE_STALE');
    });
  }
  assert.doesNotThrow(() => {
    assertExecutionIntentTransitionReason('PENDING', 'PROCESSING', 'EXECUTION_STARTED');
  });
  assertValidationFailure(() => {
    assertExecutionIntentTransitionReason('PENDING', 'PROCESSING', 'QUOTE_STALE');
  });
  assertValidationFailure(() => {
    assertExecutionIntentTransitionReason('PENDING', 'FAILED', 'QUOTE_STALE');
  });
});

void test('rejects contradictory durable status and reason pairs', () => {
  const exactReasons = {
    PROCESSING: 'EXECUTION_STARTED',
    SIMULATED: 'SIMULATION_SUCCEEDED',
    SIGNED_NOT_SUBMITTED: 'SIGNATURE_PERSISTED',
    SUBMITTED: 'SUBMISSION_ACCEPTED',
    CONFIRMED: 'CONFIRMATION_OBSERVED',
    RECONCILING: 'RECONCILIATION_STARTED',
  } as const;
  for (const [status, reason] of Object.entries(exactReasons)) {
    assert.doesNotThrow(() => { assertExecutionIntent(validRecord({ status, lastReasonCode: reason })); });
    assertValidationFailure(() => { assertExecutionIntent(validRecord({
      status, lastReasonCode: 'INTENT_DUPLICATE',
    })); });
  }
  assert.doesNotThrow(() => { assertExecutionIntent(validRecord({
    status: 'UNKNOWN_REQUIRES_RECONCILIATION', lastReasonCode: 'RECONCILIATION_REQUIRED',
  })); });
  assert.doesNotThrow(() => { assertExecutionIntent(validRecord({
    status: 'RETRY_READY', lastReasonCode: 'RECONCILIATION_PROVED_NO_EFFECT',
  })); });
  assertValidationFailure(() => { assertExecutionIntent(validRecord({
    status: 'RETRY_READY', lastReasonCode: 'RETRY_AUTHORIZED',
  })); });
  assertValidationFailure(() => { assertExecutionIntent(validRecord({
    status: 'UNKNOWN_REQUIRES_RECONCILIATION', lastReasonCode: 'INTENT_DUPLICATE',
  })); });
  assert.doesNotThrow(() => { assertExecutionIntent(validRecord({
    status: 'FAILED', lastReasonCode: 'BUY_SIMULATION_FAILED',
    terminalAtMs: REQUESTED_AT_MS, reconciliationCompletedAtMs: REQUESTED_AT_MS,
    purgeAfterMs: REQUESTED_AT_MS + 14_400_000,
  })); });
  assertValidationFailure(() => { assertExecutionIntent(validRecord({
    status: 'FAILED', lastReasonCode: 'SIMULATION_SUCCEEDED',
    terminalAtMs: REQUESTED_AT_MS, reconciliationCompletedAtMs: REQUESTED_AT_MS,
    purgeAfterMs: REQUESTED_AT_MS + 14_400_000,
  })); });
});

void test('requires honest attempt completion and abandonment reasons', () => {
  assert.doesNotThrow(() => { assertExecutionAttemptStatusReason('STARTED', null); });
  assert.doesNotThrow(() => {
    assertExecutionAttemptStatusReason('COMPLETED', 'ATTEMPT_COMPLETED');
  });
  assert.doesNotThrow(() => { assertExecutionAttemptStatusReason('ABANDONED', 'QUOTE_STALE'); });
  for (const pair of [
    ['STARTED', 'QUOTE_STALE'],
    ['COMPLETED', 'QUOTE_STALE'],
    ['ABANDONED', 'ATTEMPT_COMPLETED'],
    ['ABANDONED', 'INTENT_SUCCEEDED'],
  ] as const) {
    assertValidationFailure(() => { assertExecutionAttemptStatusReason(pair[0], pair[1]); });
  }
});

void test('refuses invalid immutable draft amounts, dates, and canonical values', () => {
  const invalidInputs: readonly Record<string, unknown>[] = [
    { quoteAmountRaw: 500_000 },
    { quoteAmountRaw: 0n },
    { quoteAmountRaw: null },
    { side: 'SELL', quoteAmountRaw: null, baseAmountRaw: null },
    { side: 'SELL', quoteAmountRaw: 1n, baseAmountRaw: 1n },
    { mint: 'not-a-canonical-solana-mint' },
    { quoteMint: 'not-a-canonical-solana-mint' },
    { decisionFingerprint: 'A'.repeat(64) },
    { requestedAtMs: 1.5 },
    { expiresAtMs: REQUESTED_AT_MS },
    { extra: true },
  ];

  for (const overrides of invalidInputs) {
    assert.throws(() => { createExecutionIntentDraft({ ...validInput(), ...overrides }); });
  }
});

void test('accepts SELL only with a positive base bigint amount', () => {
  const sell = createExecutionIntentDraft({
    ...validInput(), side: 'SELL', quoteAmountRaw: null, baseAmountRaw: 500_000n,
    venuePolicy: 'CANONICAL_EXIT', logicalCommandId: 'paper_close_abc',
  });

  assert.equal(sell.side, 'SELL');
  assert.equal(sell.baseAmountRaw, 500_000n);
  assert.equal(sell.quoteAmountRaw, null);
});

void test('accepts PostgreSQL integer and Date bounds but rejects one past each bound', () => {
  const maxDraft = createExecutionIntentDraft(validInput({
    strategyVersion: INT32_MAX,
    requestedAtMs: DATE_MAX_MS - 1,
    expiresAtMs: DATE_MAX_MS,
  }));
  const maxRecord = validRecord({
    ...maxDraft,
    status: 'PROCESSING',
    lastReasonCode: 'EXECUTION_STARTED',
    attemptCount: INT32_MAX,
    stateRevision: INT64_MAX,
    createdAtMs: DATE_MAX_MS,
    updatedAtMs: DATE_MAX_MS,
  });

  assert.equal(maxDraft.strategyVersion, INT32_MAX);
  assert.equal(maxDraft.expiresAtMs, DATE_MAX_MS);
  assert.equal(maxRecord.attemptCount, INT32_MAX);
  assert.equal(maxRecord.stateRevision, INT64_MAX);
  assert.doesNotThrow(() => { assertExecutionIntent(maxRecord); });
  assertValidationFailure(() => createExecutionIntentDraft(validInput({ strategyVersion: INT32_MAX + 1 })));
  assertValidationFailure(() => createExecutionIntentDraft(validInput({
    requestedAtMs: DATE_MAX_MS,
    expiresAtMs: DATE_MAX_MS + 1,
  })));
  assertValidationFailure(() => {
    assertExecutionIntent(validRecord({ status: 'PROCESSING', attemptCount: INT32_MAX + 1 }));
  });
  for (const stateRevision of [-1n, INT64_MAX + 1n, 0]) {
    assertValidationFailure(() => { assertExecutionIntent(validRecord({ stateRevision })); });
  }
  const terminalRecord = validRecord({
    status: 'SUCCEEDED',
    lastReasonCode: 'INTENT_SUCCEEDED',
    attemptCount: 1,
    terminalAtMs: DATE_MAX_MS - 14_400_000,
    reconciliationCompletedAtMs: DATE_MAX_MS - 14_400_000,
    purgeAfterMs: DATE_MAX_MS,
    createdAtMs: DATE_MAX_MS,
    updatedAtMs: DATE_MAX_MS,
  });
  for (const field of [
    'terminalAtMs', 'reconciliationCompletedAtMs', 'purgeAfterMs', 'createdAtMs', 'updatedAtMs',
  ] as const) {
    assertValidationFailure(() => {
      assertExecutionIntent(Object.freeze({ ...terminalRecord, [field]: DATE_MAX_MS + 1 }));
    });
  }
});

void test('accepts exact U64 raw amounts but rejects overflow', () => {
  const maximum = createExecutionIntentDraft(validInput({ quoteAmountRaw: U64_MAX }));

  assert.equal(maximum.quoteAmountRaw, U64_MAX);
  assertValidationFailure(() => createExecutionIntentDraft(validInput({ quoteAmountRaw: U64_MAX + 1n })));
  assertValidationFailure(() => createExecutionIntentDraft(validInput({ minimumAmountOutRaw: U64_MAX + 1n })));
});

void test('accepts canonical leading-zero public keys and rejects malformed Base58 keys', () => {
  const canonicalLeadingZero = `${'1'.repeat(31)}2`;
  const valid = createExecutionIntentDraft(validInput({
    mint: canonicalLeadingZero,
    quoteMint: canonicalLeadingZero,
  }));

  assert.equal(valid.mint, canonicalLeadingZero);
  for (const mint of [
    '1'.repeat(31),
    '1'.repeat(33),
    `${'1'.repeat(31)}0`,
  ]) assertValidationFailure(() => createExecutionIntentDraft(validInput({ mint })));
});

void test('asserts only immutable exact repository records', () => {
  const draft = createExecutionIntentDraft(validInput());
  const record = Object.freeze({
    ...draft,
    status: 'PENDING' as const,
    attemptCount: 0,
    stateRevision: 0n,
    lastReasonCode: null,
    terminalAtMs: null,
    reconciliationCompletedAtMs: null,
    purgeAfterMs: null,
    createdAtMs: REQUESTED_AT_MS,
    updatedAtMs: REQUESTED_AT_MS,
  });

  assert.doesNotThrow(() => { assertExecutionIntent(record); });
  assert.throws(() => { assertExecutionIntent({ ...record }); });
  assert.throws(() => { assertExecutionIntent(Object.freeze({ ...record, extra: true })); });
});

void test('does not invoke getters or proxy traps while validating execution intent records', () => {
  const record = validRecord();
  let getterCalls = 0;
  const getter = { ...record };
  Object.defineProperty(getter, 'status', {
    enumerable: true,
    get: () => { getterCalls += 1; return 'PENDING'; },
  });
  Object.freeze(getter);
  let proxyTraps = 0;
  const proxy = new Proxy(record, {
    getPrototypeOf: () => { proxyTraps += 1; throw new Error('must not run'); },
    ownKeys: () => { proxyTraps += 1; throw new Error('must not run'); },
    getOwnPropertyDescriptor: () => { proxyTraps += 1; throw new Error('must not run'); },
  });

  assertValidationFailure(() => { assertExecutionIntent(getter); });
  assertValidationFailure(() => { assertExecutionIntent(proxy); });
  assert.equal(getterCalls, 0);
  assert.equal(proxyTraps, 0);
});

void test('exposes only redacted validation errors for hostile public inputs', () => {
  const getter = validInput();
  Object.defineProperty(getter, 'strategyId', {
    enumerable: true,
    get: () => { throw new Error('must not run'); },
  });
  const proxy = new Proxy(validRecord(), {
    getPrototypeOf: () => { throw new Error('must not run'); },
    ownKeys: () => { throw new Error('must not run'); },
    getOwnPropertyDescriptor: () => { throw new Error('must not run'); },
  });

  assertValidationFailure(() => createExecutionIntentDraft(getter));
  assertValidationFailure(() => createExecutionIntentId(getter));
  assertValidationFailure(() => { assertExecutionIntent(proxy); });
  assertValidationFailure(() => { assertExecutionIntentTransition(proxy, 'PENDING'); });
});

void test('implements the complete specified execution-intent transition adjacency', () => {
  const expected: Readonly<Record<ExecutionIntentStatus, readonly ExecutionIntentStatus[]>> = {
    PENDING: ['PROCESSING', 'EXPIRED', 'CANCELLED'],
    PROCESSING: ['SIMULATED', 'FAILED', 'EXPIRED', 'CANCELLED'],
    SIMULATED: ['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'SIGNED_NOT_SUBMITTED'],
    RETRY_READY: ['PROCESSING', 'EXPIRED', 'CANCELLED'],
    SIGNED_NOT_SUBMITTED: ['SUBMITTED', 'UNKNOWN_REQUIRES_RECONCILIATION'],
    SUBMITTED: ['CONFIRMED', 'UNKNOWN_REQUIRES_RECONCILIATION'],
    CONFIRMED: ['RECONCILING', 'UNKNOWN_REQUIRES_RECONCILIATION', 'SUCCEEDED'],
    RECONCILING: ['UNKNOWN_REQUIRES_RECONCILIATION', 'SUCCEEDED'],
    SUCCEEDED: [],
    FAILED: [],
    EXPIRED: [],
    CANCELLED: [],
    UNKNOWN_REQUIRES_RECONCILIATION: ['CONFIRMED', 'FAILED', 'RETRY_READY'],
  };

  for (const previous of EXECUTION_INTENT_STATUSES) {
    for (const next of EXECUTION_INTENT_STATUSES) {
      if (expected[previous].includes(next)) {
        assert.doesNotThrow(() => { assertExecutionIntentTransition(previous, next); });
      } else {
        assertValidationFailure(() => { assertExecutionIntentTransition(previous, next); });
      }
    }
  }
});

function validInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    strategyId: 'creation-entry-v1',
    strategyVersion: 1,
    positionId: 'paper-position-1',
    logicalCommandId: 'paper_open_abc',
    mint: '11111111111111111111111111111111',
    side: 'BUY',
    venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9,
    quoteAmountRaw: 500_000n,
    baseAmountRaw: null,
    minimumAmountOutRaw: 1n,
    decisionEventId: 'event-1',
    decisionFingerprint: 'a'.repeat(64),
    requestedAtMs: REQUESTED_AT_MS,
    expiresAtMs: EXPIRES_AT_MS,
    ...overrides,
  };
}

function validRecord(overrides: Readonly<Record<string, unknown>> = {}): ExecutionIntentV1 {
  const draft: ExecutionIntentDraftV1 = createExecutionIntentDraft(validInput());
  return Object.freeze({
    ...draft,
    status: 'PENDING',
    attemptCount: 0,
    stateRevision: 0n,
    lastReasonCode: null,
    terminalAtMs: null,
    reconciliationCompletedAtMs: null,
    purgeAfterMs: null,
    createdAtMs: REQUESTED_AT_MS,
    updatedAtMs: REQUESTED_AT_MS,
    ...overrides,
  });
}

function assertValidationFailure(action: () => void): void {
  assert.throws(action, (error: unknown) => (
    error instanceof ExecutionIntentValidationError
    && error.message === 'Invalid execution intent.'
    && error.name === 'ExecutionIntentValidationError'
  ));
}
