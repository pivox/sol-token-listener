import assert from 'node:assert/strict';
import test from 'node:test';
import { CreationEntryV1Strategy } from '../src/application/creation-entry-v1.strategy.js';
import type { DomainEvent } from '../src/domain/events.js';
import type { BondingCurveTradeObservedEventV1 } from '../src/domain/launchpad-events.js';
import type { MarketTrade } from '../src/domain/market.js';
import type {
  ClosePaperPositionCommand,
  OpenPaperPositionCommand,
  PaperExecutionQuote,
  PaperPosition,
} from '../src/domain/paper-trading.js';
import { createTradingCandidate } from '../src/domain/trading-candidate.js';

void test('counts one wallet once across repeated Pump.fun and PumpSwap buys', async () => {
  const strategy = new CreationEntryV1Strategy(
    new FakeLedger(), new FakeRouter(),
    { retentionMs: 14_400_000, externalMinimumBuyAmountRaw: 1_000n },
  );
  const candidate = eligibleCandidate();
  const pending = strategy.prepare(candidate, {
    externalBuyTarget: 10, minimumConfirmation: 'confirmed', nowMs: 1_000,
  });
  assert.ok(pending);
  const holding = { ...pending, state: 'WAITING_EXTERNAL_BUYS' as const, positionId: POSITION.id };
  const repeated = Array.from({ length: 10 }, (_, index) => (
    launchBuy(`launch-${index}`, index + 2, 'wallet-a', 2_000n)
  ));
  const result = await strategy.reconcile({
    candidate, session: holding, position: POSITION, creator: 'creator',
    launchTrades: repeated, marketTrades: [marketBuy('market-a', 20, 'wallet-a', 2_000n)],
    nowMs: 3_000,
  });

  assert.equal(result.session.externalBuyCount, 1);
  assert.deepEqual(result.session.countedBuyerWallets, ['wallet-a']);
  assert.deepEqual(result.session.countedTradeIds, ['launch-0']);
  assert.equal(result.countedExternalBuys.length, 1);
  assert.equal(result.countedExternalBuys[0]?.quoteAmountRaw, 2_000n);
  assert.equal(result.requestedAction, 'NONE');
});

void test('counts ten distinct eligible wallets and rejects below-minimum or invalid buys', async () => {
  const strategy = new CreationEntryV1Strategy(
    new FakeLedger(), new FakeRouter(),
    { retentionMs: 14_400_000, externalMinimumBuyAmountRaw: 1_000n },
  );
  const candidate = eligibleCandidate();
  const pending = strategy.prepare(candidate, {
    externalBuyTarget: 10, minimumConfirmation: 'confirmed', nowMs: 1_000,
  });
  assert.ok(pending);
  const valid = Array.from({ length: 10 }, (_, index) => (
    launchBuy(`valid-${index}`, index + 2, `wallet-${index}`, 1_000n)
  ));
  const below = launchBuy('below', 30, 'wallet-below', 999n);
  const creator = launchBuy('creator', 31, 'creator', 2_000n);
  const unknown = launchBuy('unknown', 32, null, 2_000n);
  const orphaned = { ...launchBuy('orphaned', 33, 'wallet-orphaned', 2_000n), confirmationStatus: 'orphaned' as const };
  const wrongQuote = {
    ...marketBuy('wrong-quote', 34, 'wallet-wrong', 2_000n),
    quoteAsset: { mint: 'USDC', decimals: 6, tokenProgram: 'SPL_TOKEN' as const },
  };
  const result = await strategy.reconcile({
    candidate,
    session: { ...pending, state: 'WAITING_EXTERNAL_BUYS', positionId: POSITION.id },
    position: POSITION,
    creator: 'creator',
    launchTrades: [...valid, below, creator, unknown, orphaned],
    marketTrades: [wrongQuote],
    nowMs: 4_000,
  });

  assert.equal(result.session.externalBuyCount, 10);
  assert.equal(new Set(result.session.countedBuyerWallets).size, 10);
  assert.equal(result.session.state, 'EXIT_PENDING_QUOTE');
  assert.equal(result.session.reasonCode, 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED');
  assert.equal(result.session.pendingExitReason, 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED');
});

class FakeLedger {
  public readonly openCalls: OpenPaperPositionCommand[] = [];
  public readonly closeCalls: ClosePaperPositionCommand[] = [];
  public async open(command: OpenPaperPositionCommand): Promise<PaperPosition> {
    this.openCalls.push(command);
    return POSITION;
  }
  public async reconcileOpen(): Promise<PaperPosition> { return POSITION; }
  public async close(command: ClosePaperPositionCommand): Promise<PaperPosition> {
    this.closeCalls.push(command);
    return POSITION;
  }
  public async retract(): Promise<PaperPosition> { return POSITION; }
}

class FakeRouter {
  public async quote(): Promise<PaperExecutionQuote> {
    return quote('sell', 'MINT', 'SOL', 900n, 1_000n);
  }
}

const POSITION: PaperPosition = Object.freeze({
  id: 'paper_position', mint: 'MINT',
  quoteAsset: Object.freeze({ mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' }),
  strategy: Object.freeze({ id: 'creation-entry-v1', version: 1 }),
  status: 'PAPER_HOLDING', baseFilledRaw: 900n, remainingBaseRaw: 900n,
  quoteCostRaw: 1_000n, quoteProceedsRaw: null, grossPnlQuoteRaw: null,
  netPnlQuoteRaw: null, roundTripLossBps: 2_000n, entryTradeId: 'entry',
  exitTradeId: null, openCommandHash: 'open', closeCommandHash: null,
  triggerEventId: 'evt_qualification', openedAtMs: 1_000, closedAtMs: null,
  purgeAfterMs: null, payloadVersion: 1,
});

function eligibleCandidate() {
  return createTradingCandidate({
    mint: 'MINT', strategy: Object.freeze({ id: 'creation-entry-v1', version: 1 }),
    qualificationReportId: `qreport_${'a'.repeat(64)}`,
    qualificationProfile: Object.freeze({
      id: 'pumpfun-v1-initial', version: 1, fingerprint: 'b'.repeat(64),
    }),
    evidenceFingerprint: 'c'.repeat(64), asOfEvent: candidateEvent(), state: 'ELIGIBLE',
    quoteAsset: Object.freeze({ mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' }),
    buyQuote: quote('buy', 'SOL', 'MINT', 1_000n, 900n),
    reverseSellQuote: quote('reverse', 'MINT', 'SOL', 900n, 800n),
    eligibleUntilMs: 46_000, reasonCodes: ['QUALIFIED_ENTRY'], createdAtMs: 1_000,
    purgeAfterMs: 14_401_000,
  });
}

function candidateEvent(): DomainEvent {
  return Object.freeze({
    id: 'evt_qualification', type: 'QualificationUpdated', mint: 'MINT', source: 'paper',
    program: 'pump', signature: 'signature',
    cursor: Object.freeze({
      slot: 10n, transactionIndex: 0, instructionIndex: 1, innerInstructionIndex: null,
    }),
    confirmationStatus: 'confirmed', blockchainTimeMs: 900, observedAtMs: 1_000,
    payloadVersion: 1, payload: Object.freeze({}),
  });
}

function launchBuy(
  id: string,
  instructionIndex: number,
  trader: string | null,
  quoteAmountRaw: bigint,
): BondingCurveTradeObservedEventV1 {
  const cursor = Object.freeze({
    slot: 10n, transactionIndex: 0, instructionIndex, innerInstructionIndex: null,
  });
  return Object.freeze({
    id: `evt_${id}`, type: 'BondingCurveTradeObserved', mint: 'MINT', source: 'pumpfun',
    program: 'pump', signature: `sig-${id}`, cursor, confirmationStatus: 'confirmed',
    blockchainTimeMs: 1_000, observedAtMs: 1_000 + instructionIndex, payloadVersion: 1,
    payload: Object.freeze({ trade: Object.freeze({
      id, launchMint: 'MINT', kind: 'BUY', trader, baseAmountRaw: 1n, quoteAmountRaw,
      quoteAsset: Object.freeze({ mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' }),
      cursor,
    }) }),
  });
}

function marketBuy(
  id: string,
  instructionIndex: number,
  trader: string,
  quoteAmountRaw: bigint,
): MarketTrade {
  return Object.freeze({
    id, pool: 'pool', mint: 'MINT',
    quoteAsset: Object.freeze({ mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' }),
    kind: 'BUY', trader, baseAmountRaw: 1n, quoteAmountRaw, source: 'pumpswap',
    program: 'pump-amm', signature: `sig-${id}`,
    cursor: Object.freeze({
      slot: 10n, transactionIndex: 0, instructionIndex, innerInstructionIndex: null,
    }),
    confirmationStatus: 'confirmed', blockchainTimeMs: 1_000, observedAtMs: 2_000,
  });
}

function quote(
  id: string,
  inputMint: string,
  outputMint: string,
  amountInRaw: bigint,
  amountOutRaw: bigint,
): PaperExecutionQuote {
  return Object.freeze({
    id, inputMint, outputMint, amountInRaw, amountOutRaw,
    minimumAmountOutRaw: amountOutRaw, feesRaw: 1n, slippageBps: 100n,
    priceImpactBps: 10n, observedAtMs: 1_000, observedSlot: 10n,
  });
}
