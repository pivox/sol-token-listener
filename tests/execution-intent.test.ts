import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertExecutionIntent,
  assertExecutionIntentTransition,
  createExecutionIntentDraft,
  createExecutionIntentId,
  EXECUTION_INTENT_REASON_CODES,
  EXECUTION_INTENT_STATUSES,
  type ExecutionIntentDraftV1,
  type ExecutionIntentV1,
} from '../src/domain/execution-intent.js';

const REQUESTED_AT_MS = 1_787_990_400_000;
const EXPIRES_AT_MS = 1_787_990_445_000;

void test('creates one frozen deterministic BUY intent using bigint amounts', () => {
  const first = createExecutionIntentDraft(validInput());
  const second = createExecutionIntentDraft(validInput());

  assert.equal(first.id, createExecutionIntentId(first));
  assert.equal(first.id, second.id);
  assert.equal(first.logicalOrderKey, 'paper_open_abc');
  assert.equal(first.payloadVersion, 1);
  assert.equal(first.quoteAmountRaw, 500_000n);
  assert.equal(first.baseAmountRaw, null);
  assert.equal(Object.isFrozen(first), true);
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
  ]);
  assert.ok(Object.isFrozen(EXECUTION_INTENT_STATUSES));
  assert.ok(Object.isFrozen(EXECUTION_INTENT_REASON_CODES));
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

void test('asserts only immutable exact repository records', () => {
  const draft = createExecutionIntentDraft(validInput());
  const record = Object.freeze({
    ...draft,
    status: 'PENDING' as const,
    attemptCount: 0,
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

  assert.throws(() => { assertExecutionIntent(getter); });
  assert.throws(() => { assertExecutionIntent(proxy); });
  assert.equal(getterCalls, 0);
  assert.equal(proxyTraps, 0);
});

void test('refuses forbidden execution-intent status transitions', () => {
  assert.doesNotThrow(() => { assertExecutionIntentTransition('PENDING', 'PROCESSING'); });
  assert.throws(() => { assertExecutionIntentTransition('PENDING', 'SUCCEEDED'); });
  assert.throws(() => { assertExecutionIntentTransition('SUCCEEDED', 'PROCESSING'); });
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

function validRecord(): ExecutionIntentV1 {
  const draft: ExecutionIntentDraftV1 = createExecutionIntentDraft(validInput());
  return Object.freeze({
    ...draft,
    status: 'PENDING',
    attemptCount: 0,
    lastReasonCode: null,
    terminalAtMs: null,
    reconciliationCompletedAtMs: null,
    purgeAfterMs: null,
    createdAtMs: REQUESTED_AT_MS,
    updatedAtMs: REQUESTED_AT_MS,
  });
}
