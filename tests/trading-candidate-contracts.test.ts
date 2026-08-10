import assert from 'node:assert/strict';
import test from 'node:test';
import type { DomainEvent } from '../src/domain/events.js';
import type { PaperExecutionQuote } from '../src/domain/paper-trading.js';
import {
  createTradingCandidate,
  TRADING_CANDIDATE_STATES,
} from '../src/domain/trading-candidate.js';

void test('creates a deterministic, deeply frozen eligible trading candidate', () => {
  const input = candidateInput();
  const first = createTradingCandidate(input);
  const second = createTradingCandidate(candidateInput());

  assert.match(first.id, /^candidate_[a-f0-9]{64}$/u);
  assert.equal(first.id, second.id);
  assert.deepEqual(TRADING_CANDIDATE_STATES, ['NOT_ELIGIBLE', 'ELIGIBLE', 'EXPIRED', 'REVOKED']);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.strategy), true);
  assert.equal(Object.isFrozen(first.qualificationProfile), true);
  assert.equal(Object.isFrozen(first.asOf), true);
  assert.equal(Object.isFrozen(first.asOf.cursor), true);
  assert.equal(Object.isFrozen(first.quoteAsset), true);
  assert.equal(Object.isFrozen(first.buyQuote), true);
  assert.equal(Object.isFrozen(first.reverseSellQuote), true);
  assert.equal(Object.isFrozen(first.reasonCodes), true);

  (input.asOfEvent.cursor as { instructionIndex: number }).instructionIndex = 99;
  assert.equal(first.asOf.cursor.instructionIndex, 2);
});

void test('candidate identity changes only with its specified evidence identity inputs', () => {
  const base = candidateInput();
  const id = createTradingCandidate(base).id;
  assert.notEqual(createTradingCandidate({ ...candidateInput(), evidenceFingerprint: 'b'.repeat(64) }).id, id);
  assert.notEqual(createTradingCandidate({
    ...candidateInput(),
    strategy: Object.freeze({ id: 'validated-external-buys', version: 2 }),
  }).id, id);
  assert.notEqual(createTradingCandidate({
    ...candidateInput(),
    qualificationProfile: Object.freeze({ ...base.qualificationProfile, version: 2 }),
  }).id, id);
  assert.notEqual(createTradingCandidate({
    ...candidateInput(),
    asOfEvent: event({ id: 'evt_other' }),
  }).id, id);
  assert.notEqual(createTradingCandidate({
    ...candidateInput(),
    asOfEvent: event({ confirmationStatus: 'finalized' }),
  }).id, id);
});

void test('rejects non-canonical cursors, incoherent quotes, windows, states and reason codes', () => {
  assert.throws(() => createTradingCandidate({
    ...candidateInput(),
    asOfEvent: event({ cursor: { ...event().cursor, instructionIndex: -1 } }),
  }));
  assert.throws(() => createTradingCandidate({
    ...candidateInput(),
    reverseSellQuote: quote('reverse', 'OTHER', 'SOL', 900n, 800n),
  }), /quote/iu);
  assert.throws(() => createTradingCandidate({
    ...candidateInput(), eligibleUntilMs: 999,
  }), /window|eligible/iu);
  assert.throws(() => createTradingCandidate({
    ...candidateInput(), state: 'ELIGIBLE', buyQuote: null,
  }), /quote/iu);
  assert.throws(() => createTradingCandidate({
    ...candidateInput(), reasonCodes: ['NOT_A_REASON' as 'QUALIFIED_ENTRY'],
  }), /reason/iu);
});

export function candidateInput() {
  return {
    mint: 'MINT',
    strategy: Object.freeze({ id: 'validated-external-buys', version: 1 }),
    qualificationReportId: 'qreport_1',
    qualificationProfile: Object.freeze({
      id: 'pumpfun-v1-initial', version: 1, fingerprint: 'a'.repeat(64),
    }),
    evidenceFingerprint: 'c'.repeat(64),
    asOfEvent: event(),
    state: 'ELIGIBLE' as const,
    quoteAsset: Object.freeze({ mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' as const }),
    buyQuote: quote('buy', 'SOL', 'MINT', 1_000n, 900n),
    reverseSellQuote: quote('reverse', 'MINT', 'SOL', 900n, 800n),
    eligibleUntilMs: 46_000,
    reasonCodes: ['QUALIFIED_ENTRY'] as const,
    createdAtMs: 1_000,
    purgeAfterMs: 14_401_000,
  };
}

function event(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: 'evt_as_of', type: 'QualificationUpdated', mint: 'MINT', source: 'paper',
    program: 'pump', signature: 'signature',
    cursor: { slot: 10n, transactionIndex: 1, instructionIndex: 2, innerInstructionIndex: null },
    confirmationStatus: 'confirmed', blockchainTimeMs: 900, observedAtMs: 1_000,
    payloadVersion: 1, payload: {}, ...overrides,
  };
}

function quote(
  id: string,
  inputMint: string,
  outputMint: string,
  amountInRaw: bigint,
  amountOutRaw: bigint,
): PaperExecutionQuote {
  return {
    id, inputMint, outputMint, amountInRaw, amountOutRaw,
    minimumAmountOutRaw: amountOutRaw, feesRaw: 1n, slippageBps: 0n,
    priceImpactBps: 1n, observedAtMs: 900, observedSlot: 10n,
  };
}
