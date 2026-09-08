import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionIntentDraft,
  type ExecutionIntentDraftV1,
} from '../src/domain/execution-intent.js';
import {
  createExecutionPreflightIntentPairDraft,
  ExecutionPreflightIntentPairValidationError,
} from '../src/domain/execution-preflight-intent-pair.js';

const REQUESTED_AT_MS = 1_787_990_400_000;
const EXPIRES_AT_MS = 1_787_990_445_000;
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

void test('derives one frozen deterministic canary target and simulation sibling pair', () => {
  const target = targetDraft();
  const first = createExecutionPreflightIntentPairDraft(target);
  const second = createExecutionPreflightIntentPairDraft(target);

  assert.deepEqual(first, second);
  assert.equal(first.payloadVersion, 1);
  assert.equal(first.targetIntentId, target.id);
  assert.equal(first.decisionEventId, target.decisionEventId);
  assert.equal(first.decisionFingerprint, target.decisionFingerprint);
  assert.equal(first.expiresAtMs, target.expiresAtMs);
  assert.equal(
    first.simulationIntent.logicalCommandId,
    'execution_preflight_probe_c9c9d32390a50882f9837b420619b9d46002b16b8db535a4b9796b772f57d2de',
  );
  assert.equal(first.simulationIntent.logicalOrderKey, first.simulationIntent.logicalCommandId);
  assert.equal(
    first.simulationIntent.id,
    'execution_intent_41f7194bac3e068072963946d0e49197e87a10c25e33f8ab6d9c6ff92fe75d0c',
  );
  assert.equal(
    first.pairId,
    'execution_preflight_intent_pair_11e7a75d6ff9928fabbc28a711b9f329ae0305e6c27deb8bfe6ec3cfcf5f9e87',
  );
  assert.equal(
    first.pairFingerprint,
    '6ba224265eb167c992da08e7b95c1a0e3ea44a069b66cf3a2e0ecb5e87bb5c00',
  );
  assert.notEqual(first.simulationIntent.id, target.id);
  assert.notEqual(first.simulationIntent.logicalCommandId, target.logicalCommandId);
  assert.notEqual(first.simulationIntent.logicalOrderKey, target.logicalOrderKey);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.simulationIntent), true);

  for (const key of [
    'strategyId', 'strategyVersion', 'positionId', 'candidateId', 'mint', 'side', 'venuePolicy',
    'quoteMint', 'quoteTokenProgram', 'quoteDecimals', 'quoteAmountRaw',
    'baseAmountRaw', 'minimumAmountOutRaw', 'decisionEventId', 'decisionFingerprint',
    'requestedAtMs', 'expiresAtMs',
  ] as const) {
    assert.equal(first.simulationIntent[key], target[key], key);
  }
});

void test('accepts only BUY WSOL SPL Token 9-decimal Pump.fun targets', () => {
  const invalidTargets = [
    createExecutionIntentDraft({ ...targetInput(), strategyId: 'another-strategy' }),
    createExecutionIntentDraft({ ...targetInput(), strategyVersion: 2 }),
    createExecutionIntentDraft({ ...targetInput(), logicalCommandId: `paper_sell_${'1'.repeat(64)}` }),
    createExecutionIntentDraft({
      ...targetInput(),
      logicalCommandId: `execution_preflight_probe_${'1'.repeat(64)}`,
    }),
    createExecutionIntentDraft({
      ...targetInput(),
      side: 'SELL',
      venuePolicy: 'CANONICAL_EXIT',
      quoteAmountRaw: null,
      baseAmountRaw: 1n,
    }),
    createExecutionIntentDraft({ ...targetInput(), quoteMint: '11111111111111111111111111111111' }),
    createExecutionIntentDraft({ ...targetInput(), quoteTokenProgram: 'TOKEN_2022' }),
    createExecutionIntentDraft({ ...targetInput(), quoteDecimals: 8 }),
  ];

  for (const target of invalidTargets) assertValidationFailure(target);
});

void test('rejects mutable, proxied, accessor, extended, and out-of-bounds target drafts', () => {
  const target = targetDraft();
  let proxyTrapCalls = 0;
  const proxy = new Proxy(target, {
    getPrototypeOf: () => { proxyTrapCalls += 1; throw new Error('must not run'); },
    ownKeys: () => { proxyTrapCalls += 1; throw new Error('must not run'); },
    getOwnPropertyDescriptor: () => { proxyTrapCalls += 1; throw new Error('must not run'); },
  });
  const accessor = { ...target };
  let getterCalls = 0;
  Object.defineProperty(accessor, 'strategyId', {
    enumerable: true,
    get: () => { getterCalls += 1; return target.strategyId; },
  });
  Object.freeze(accessor);

  for (const hostile of [
    { ...target },
    proxy,
    accessor,
    Object.freeze({ ...target, extra: true }),
    replaceField(target, 'strategyVersion', 2_147_483_648),
    replaceField(target, 'quoteDecimals', 256),
    replaceField(target, 'requestedAtMs', Number.MAX_SAFE_INTEGER + 1),
  ]) assertValidationFailure(hostile);

  assert.equal(proxyTrapCalls, 0);
  assert.equal(getterCalls, 0);
});

function targetDraft(): ExecutionIntentDraftV1 {
  return createExecutionIntentDraft(targetInput());
}

function targetInput(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    strategyId: 'creation-entry-v1',
    strategyVersion: 1,
    positionId: 'paper-position-1',
    candidateId: `candidate_${'c'.repeat(64)}`,
    logicalCommandId: `paper_open_${'1'.repeat(64)}`,
    mint: '11111111111111111111111111111111',
    side: 'BUY',
    venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: WSOL_MINT,
    quoteTokenProgram: 'SPL_TOKEN',
    quoteDecimals: 9,
    quoteAmountRaw: 500_000n,
    baseAmountRaw: null,
    minimumAmountOutRaw: 1n,
    decisionEventId: 'event-1',
    decisionFingerprint: 'a'.repeat(64),
    requestedAtMs: REQUESTED_AT_MS,
    expiresAtMs: EXPIRES_AT_MS,
  });
}

function replaceField(
  target: ExecutionIntentDraftV1,
  key: keyof ExecutionIntentDraftV1,
  value: unknown,
): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...target, [key]: value });
}

function assertValidationFailure(target: unknown): void {
  assert.throws(
    () => createExecutionPreflightIntentPairDraft(target),
    (error: unknown) => error instanceof ExecutionPreflightIntentPairValidationError
      && error.name === 'ExecutionPreflightIntentPairValidationError'
      && error.message === 'Invalid execution preflight intent pair.',
  );
}
