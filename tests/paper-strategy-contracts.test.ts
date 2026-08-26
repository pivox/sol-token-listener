import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCreationEntrySession,
  countExternalBuy,
  createDeterministicPaperSellCommandId,
  createPaperStrategySession,
  PAPER_DECISION_REASON_CODES,
  PAPER_STRATEGY_SESSION_STATES,
} from '../src/domain/paper-strategy.js';
import { createTradingCandidate } from '../src/domain/trading-candidate.js';
import type { DomainEvent } from '../src/domain/events.js';
import type { PaperExecutionQuote } from '../src/domain/paper-trading.js';

void test('creates a deterministic, deeply frozen paper strategy session', () => {
  const first = createPaperStrategySession(sessionInput());
  const second = createPaperStrategySession(sessionInput());
  assert.match(first.id, /^paper_session_[a-f0-9]{64}$/u);
  assert.match(first.openCommandId, /^paper_open_[a-f0-9]{64}$/u);
  assert.equal(first.id, second.id);
  assert.equal(first.actorKind, 'PAPER_SIMULATION');
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.strategy), true);
  assert.equal(Object.isFrozen(first.quoteAsset), true);
  assert.equal(Object.isFrozen(first.entryCursor), true);
  assert.equal(Object.isFrozen(first.countedTradeIds), true);
  assert.deepEqual(PAPER_STRATEGY_SESSION_STATES, [
    'BUY_PENDING', 'PAPER_HOLDING', 'WAITING_EXTERNAL_BUYS', 'EXIT_PENDING_QUOTE',
    'SELL_PENDING', 'PAPER_CLOSED', 'PAPER_RETRACTED', 'MANUAL_REVIEW',
  ]);
  for (const reason of [
    'QUALIFICATION_NOT_ELIGIBLE', 'ENTRY_WINDOW_EXPIRED', 'EVIDENCE_REVOKED',
    'QUALIFIED_ENTRY', 'EXTERNAL_BUY_OBSERVED', 'EXTERNAL_BUY_TARGET_REACHED',
    'EXIT_QUOTE_UNAVAILABLE', 'SOURCE_ORPHANED', 'RECONCILIATION_REQUIRED',
  ]) assert.ok(PAPER_DECISION_REASON_CODES.includes(reason as never));
});

void test('counts confirmed post-entry external buys idempotently through the target', () => {
  let session = createPaperStrategySession({ ...sessionInput(), externalBuyTarget: 2 });
  const first = countExternalBuy(session, evidenceInput('trade-1', 3, 'confirmed'));
  assert.equal(first.evidence?.sessionId, session.id);
  assert.equal(first.evidence?.payloadVersion, 1);
  assert.equal(Object.isFrozen(first.evidence), true);
  assert.equal(first.session.externalBuyCount, 1);
  assert.equal(first.session.state, 'WAITING_EXTERNAL_BUYS');
  assert.equal(first.session.reasonCode, 'EXTERNAL_BUY_OBSERVED');
  session = first.session;

  const duplicate = countExternalBuy(session, evidenceInput('trade-1', 3, 'confirmed'));
  assert.equal(duplicate.session, session);
  assert.equal(duplicate.evidence, null);

  const second = countExternalBuy(session, evidenceInput('trade-2', 4, 'finalized'));
  assert.equal(second.session.externalBuyCount, 2);
  assert.equal(second.session.state, 'EXIT_PENDING_QUOTE');
  assert.equal(second.session.reasonCode, 'EXTERNAL_BUY_TARGET_REACHED');
  assert.equal(second.targetReached, true);
  assert.match(second.session.closeCommandId ?? '', /^paper_sell_[a-f0-9]{64}$/u);
  assert.equal(
    second.session.closeCommandId,
    createDeterministicPaperSellCommandId('paper_position', second.session.strategy, 2),
  );
});

void test('creates a deterministic V2 creation session with paired unique buyer evidence', () => {
  const candidate = eligibleCandidate('creation-entry-v1');
  const input = {
    ...sessionInput(candidate),
    reasonCode: 'EXTERNAL_UNIQUE_BUY_OBSERVED' as const,
    externalBuyCount: 1,
    countedTradeIds: ['trade-a'],
    countedBuyerWallets: ['wallet-a'],
    lastCountedCursor: {
      slot: 10n, transactionIndex: 1, instructionIndex: 3, innerInstructionIndex: null,
    },
    pendingExitReason: null,
    updatedAtMs: 2_003,
  };
  const first = createCreationEntrySession(input);
  const second = createCreationEntrySession(input);

  assert.equal(first.payloadVersion, 2);
  assert.equal(first.id, second.id);
  assert.deepEqual(first.strategy, { id: 'creation-entry-v1', version: 1 });
  assert.deepEqual(first.countedBuyerWallets, ['wallet-a']);
  assert.equal(Object.isFrozen(first.countedBuyerWallets), true);
  for (const reason of [
    'CREATION_ENTRY_EXPIRED', 'CREATION_ENTRY_REJECTED',
    'EXTERNAL_UNIQUE_BUY_OBSERVED', 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED',
    'TAKE_PROFIT_2X_EXECUTABLE', 'CREATOR_EARLY_SELL', 'MANUAL_KILL_SWITCH',
    'SELL_QUOTE_UNAVAILABLE_OR_STALE',
  ]) assert.ok(PAPER_DECISION_REASON_CODES.includes(reason as never));

  assert.throws(() => createCreationEntrySession({
    ...input,
    externalBuyCount: 2,
    countedTradeIds: ['trade-a', 'trade-b'],
    countedBuyerWallets: ['wallet-a', 'wallet-a'],
  }), /wallet|buyer|count/iu);
  assert.throws(() => createCreationEntrySession({
    ...input,
    countedBuyerWallets: [],
  }), /wallet|buyer|count/iu);
});

void test('enforces target, count, cursor, mint, quote and minimum confirmation', () => {
  for (const target of [0, 1_001]) {
    assert.throws(() => createPaperStrategySession({ ...sessionInput(), externalBuyTarget: target }), /target/iu);
  }
  assert.throws(() => createPaperStrategySession({
    ...sessionInput(), externalBuyTarget: 1, countedTradeIds: ['a', 'b'], externalBuyCount: 2,
  }), /count/iu);
  const session = createPaperStrategySession({
    ...sessionInput(), minimumConfirmation: 'finalized',
  });
  for (const evidence of [
    evidenceInput('before', 1, 'finalized'),
    { ...evidenceInput('mint', 3, 'finalized'), mint: 'OTHER' },
    { ...evidenceInput('quote', 3, 'finalized'), quoteMint: 'OTHER' },
    evidenceInput('confirmation', 3, 'confirmed'),
  ]) assert.throws(() => countExternalBuy(session, evidence), /external buy|evidence/iu);
});

function sessionInput(candidate = eligibleCandidate()) {
  return {
    candidate,
    state: 'WAITING_EXTERNAL_BUYS' as const,
    reasonCode: 'QUALIFIED_ENTRY' as const,
    positionId: 'paper_position',
    entryCursor: { slot: 10n, transactionIndex: 1, instructionIndex: 2, innerInstructionIndex: null },
    externalBuyTarget: 10,
    externalBuyCount: 0,
    countedTradeIds: [] as readonly string[],
    lastCountedCursor: null,
    minimumConfirmation: 'confirmed' as const,
    lastQuote: candidate.buyQuote,
    lastError: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    purgeAfterMs: 14_401_000,
  };
}

function eligibleCandidate(strategyId: 'validated-external-buys' | 'creation-entry-v1' = 'validated-external-buys') {
  return createTradingCandidate({
    mint: 'MINT',
    strategy: Object.freeze({ id: strategyId, version: 1 }),
    qualificationReportId: 'qreport_1',
    qualificationProfile: Object.freeze({
      id: 'pumpfun-v1-initial', version: 1, fingerprint: 'a'.repeat(64),
    }),
    evidenceFingerprint: 'c'.repeat(64),
    asOfEvent: candidateEvent(),
    state: 'ELIGIBLE',
    quoteAsset: Object.freeze({ mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' }),
    buyQuote: candidateQuote('buy', 'SOL', 'MINT', 1_000n, 900n),
    reverseSellQuote: candidateQuote('reverse', 'MINT', 'SOL', 900n, 800n),
    eligibleUntilMs: 46_000,
    reasonCodes: ['QUALIFIED_ENTRY'],
    createdAtMs: 1_000,
    purgeAfterMs: 14_401_000,
  });
}

function candidateEvent(): DomainEvent {
  return {
    id: 'evt_as_of', type: 'QualificationUpdated', mint: 'MINT', source: 'paper',
    program: 'pump', signature: 'signature',
    cursor: { slot: 10n, transactionIndex: 1, instructionIndex: 2, innerInstructionIndex: null },
    confirmationStatus: 'confirmed', blockchainTimeMs: 900, observedAtMs: 1_000,
    payloadVersion: 1, payload: {},
  };
}

function candidateQuote(
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

function evidenceInput(
  tradeId: string,
  instructionIndex: number,
  confirmationStatus: 'confirmed' | 'finalized',
) {
  return {
    tradeId, mint: 'MINT', quoteMint: 'SOL', trader: 'wallet',
    cursor: { slot: 10n, transactionIndex: 1, instructionIndex, innerInstructionIndex: null },
    confirmationStatus, observedAtMs: 2_000 + instructionIndex,
  } as const;
}
