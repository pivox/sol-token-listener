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
import type { QualificationReport } from '../src/domain/qualification.js';
import { createTradingCandidate } from '../src/domain/trading-candidate.js';
import { PaperQuoteError, type PaperQuoteRequest } from '../src/ports/paper-quote-router.js';

void test('opens one creation position and moves the V2 session to monitoring', async () => {
  const ledger = new FakeLedger();
  const strategy = new CreationEntryV1Strategy(
    ledger, new FakeRouter(),
    { retentionMs: 14_400_000, externalMinimumBuyAmountRaw: 1_000n },
  );
  const candidate = eligibleCandidate();
  const session = strategy.prepare(candidate, {
    externalBuyTarget: 10, minimumConfirmation: 'confirmed', nowMs: 1_000,
  });
  assert.ok(session);

  const result = await strategy.open({
    candidate,
    session,
    qualification: Object.freeze({}) as QualificationReport,
    qualificationEvent: candidateEvent(),
    maximumRoundTripLossBps: 3_000n,
    entryDecisionAtMs: 500,
    entryDecisionJobId: 'paper-job-open',
  });

  assert.equal(result.requestedAction, 'OPEN');
  assert.equal(result.session.payloadVersion, 2);
  assert.equal(result.session.externalMinimumBuyAmountRaw, 1_000n);
  assert.equal(result.session.state, 'WAITING_EXTERNAL_BUYS');
  assert.equal(result.session.positionId, POSITION.id);
  assert.equal(ledger.openCalls.length, 1);
  assert.equal(ledger.openCalls[0]?.entryDecisionAtMs, 500);
  assert.equal(ledger.openCalls[0]?.entryDecisionJobId, 'paper-job-open');
});

void test('keeps the persisted minimum buy threshold when runtime configuration changes', async () => {
  const strictStrategy = new CreationEntryV1Strategy(
    new FakeLedger(), new FakeRouter(),
    { retentionMs: 14_400_000, externalMinimumBuyAmountRaw: 1_000n },
  );
  const permissiveStrategy = new CreationEntryV1Strategy(
    new FakeLedger(), new FakeRouter(),
    { retentionMs: 14_400_000, externalMinimumBuyAmountRaw: 1n },
  );
  const candidate = eligibleCandidate();
  const session = strictStrategy.prepare(candidate, {
    externalBuyTarget: 10, minimumConfirmation: 'confirmed', nowMs: 1_000,
  });
  assert.ok(session);

  const result = await permissiveStrategy.reconcile({
    candidate,
    session: { ...session, state: 'WAITING_EXTERNAL_BUYS', positionId: POSITION.id },
    position: POSITION,
    creator: 'creator',
    launchTrades: [launchBuy('below-persisted-threshold', 2, 'wallet-a', 999n)],
    marketTrades: [],
    nowMs: 3_000,
  });

  assert.equal(result.session.externalMinimumBuyAmountRaw, 1_000n);
  assert.equal(result.session.externalBuyCount, 0);
  assert.deepEqual(result.session.countedBuyerWallets, []);
});

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
  assert.equal(result.session.state, 'PAPER_CLOSED');
  assert.equal(result.session.reasonCode, 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED');
  assert.equal(result.session.pendingExitReason, 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED');
  assert.equal(result.requestedAction, 'CLOSE');
});

void test('closes the full position when the executable minimum proceeds reach 2x', async () => {
  const ledger = new FakeLedger();
  const router = new FakeRouter(quote('sell-2x', 'MINT', 'SOL', 900n, 2_100n, 2_000n));
  const strategy = new CreationEntryV1Strategy(ledger, router, {
    retentionMs: 14_400_000,
    externalMinimumBuyAmountRaw: 1_000n,
    takeProfitMultiplierBps: 20_000n,
  });
  const candidate = eligibleCandidate();
  const session = strategy.prepare(candidate, {
    externalBuyTarget: 10, minimumConfirmation: 'confirmed', nowMs: 1_000,
  });
  assert.ok(session);

  const result = await strategy.reconcile({
    candidate,
    session: { ...session, state: 'WAITING_EXTERNAL_BUYS', positionId: POSITION.id },
    position: POSITION,
    creator: 'creator',
    launchTrades: [],
    marketTrades: [],
    nowMs: 4_000,
  });

  assert.equal(result.requestedAction, 'CLOSE');
  assert.equal(result.session.reasonCode, 'TAKE_PROFIT_2X_EXECUTABLE');
  assert.equal(result.session.state, 'PAPER_CLOSED');
  assert.equal(ledger.closeCalls.length, 1);
  assert.equal(ledger.closeCalls[0]?.sellQuote.amountInRaw, POSITION.remainingBaseRaw);
  assert.equal(ledger.closeCalls[0]?.reason, 'TAKE_PROFIT_2X_EXECUTABLE');
  assert.equal(ledger.closeCalls[0]?.exitTriggerAtMs, 4_000);
  assert.equal(router.requests[0]?.side, 'SELL');
});

void test('does not close on a theoretical 2x when minimum executable proceeds are below 2x', async () => {
  const ledger = new FakeLedger();
  const strategy = new CreationEntryV1Strategy(
    ledger,
    new FakeRouter(quote('sell-theoretical', 'MINT', 'SOL', 900n, 2_500n, 1_900n)),
    { retentionMs: 14_400_000, externalMinimumBuyAmountRaw: 1_000n },
  );
  const candidate = eligibleCandidate();
  const session = strategy.prepare(candidate, {
    externalBuyTarget: 10, minimumConfirmation: 'confirmed', nowMs: 1_000,
  });
  assert.ok(session);

  const result = await strategy.reconcile({
    candidate, session: { ...session, state: 'WAITING_EXTERNAL_BUYS', positionId: POSITION.id },
    position: POSITION, creator: 'creator', launchTrades: [], marketTrades: [], nowMs: 4_000,
  });

  assert.equal(result.requestedAction, 'NONE');
  assert.equal(result.session.state, 'WAITING_EXTERNAL_BUYS');
  assert.equal(ledger.closeCalls.length, 0);
});

void test('prioritizes creator sell over take profit and buyer target', async () => {
  const ledger = new FakeLedger();
  const strategy = new CreationEntryV1Strategy(
    ledger,
    new FakeRouter(quote('sell', 'MINT', 'SOL', 900n, 2_100n, 2_000n)),
    { retentionMs: 14_400_000, externalMinimumBuyAmountRaw: 1_000n },
  );
  const candidate = eligibleCandidate();
  const session = strategy.prepare(candidate, {
    externalBuyTarget: 1, minimumConfirmation: 'confirmed', nowMs: 1_000,
  });
  assert.ok(session);

  const result = await strategy.reconcile({
    candidate, session: { ...session, state: 'WAITING_EXTERNAL_BUYS', positionId: POSITION.id },
    position: POSITION, creator: 'creator',
    launchTrades: [launchBuy('external', 2, 'wallet-a', 2_000n), launchSell('creator-sell', 3, 'creator')],
    marketTrades: [], nowMs: 4_000,
  });

  assert.equal(result.session.reasonCode, 'CREATOR_EARLY_SELL');
  assert.equal(ledger.closeCalls[0]?.reason, 'CREATOR_EARLY_SELL');
  assert.equal(ledger.closeCalls[0]?.exitTriggerAtMs, 1_003);
});

void test('prioritizes the manual kill switch over every market trigger', async () => {
  const ledger = new FakeLedger();
  const strategy = new CreationEntryV1Strategy(
    ledger,
    new FakeRouter(quote('sell', 'MINT', 'SOL', 900n, 2_100n, 2_000n)),
    {
      retentionMs: 14_400_000,
      externalMinimumBuyAmountRaw: 1_000n,
      manualKillSwitch: true,
    },
  );
  const candidate = eligibleCandidate();
  const session = strategy.prepare(candidate, {
    externalBuyTarget: 1, minimumConfirmation: 'confirmed', nowMs: 1_000,
  });
  assert.ok(session);

  const result = await strategy.reconcile({
    candidate, session: { ...session, state: 'WAITING_EXTERNAL_BUYS', positionId: POSITION.id },
    position: POSITION, creator: 'creator',
    launchTrades: [launchBuy('external', 2, 'wallet-a', 2_000n), launchSell('creator-sell', 3, 'creator')],
    marketTrades: [], nowMs: 4_000,
  });

  assert.equal(result.session.reasonCode, 'MANUAL_KILL_SWITCH');
  assert.equal(ledger.closeCalls[0]?.reason, 'MANUAL_KILL_SWITCH');
  assert.equal(ledger.closeCalls[0]?.exitTriggerAtMs, 4_000);
  assert.equal(result.session.pendingExitTriggerAtMs, 4_000);
});

void test('preserves the first manual kill detection time across a quote retry', async () => {
  const ledger = new FakeLedger();
  const candidate = eligibleCandidate();
  const failed = new CreationEntryV1Strategy(
    ledger,new FakeRouter(new PaperQuoteError('QUOTE_STATE_UNAVAILABLE','unavailable')),
    { retentionMs:14_400_000,externalMinimumBuyAmountRaw:1_000n,manualKillSwitch:true },
  );
  const prepared = failed.prepare(candidate, {
    externalBuyTarget:10,minimumConfirmation:'confirmed',nowMs:1_000,
  });
  assert.ok(prepared);
  const pending = await failed.reconcile({
    candidate,session:{ ...prepared,state:'WAITING_EXTERNAL_BUYS',positionId:POSITION.id },
    position:POSITION,creator:'creator',launchTrades:[],marketTrades:[],nowMs:4_000,
  });
  assert.equal(pending.session.pendingExitTriggerAtMs, 4_000);

  const recovered = new CreationEntryV1Strategy(
    ledger,new FakeRouter(quote('manual-retry','MINT','SOL',900n,1_100n)),
    { retentionMs:14_400_000,externalMinimumBuyAmountRaw:1_000n,manualKillSwitch:true },
  );
  await recovered.reconcile({
    candidate,session:pending.session,position:POSITION,creator:'creator',
    launchTrades:[],marketTrades:[],nowMs:5_000,
  });
  assert.equal(ledger.closeCalls[0]?.exitTriggerAtMs, 4_000);
});

void test('does not invent a manual trigger time for a legacy pending session', async () => {
  const ledger = new FakeLedger();
  const candidate = eligibleCandidate();
  const strategy = new CreationEntryV1Strategy(
    ledger,new FakeRouter(quote('legacy-manual','MINT','SOL',900n,1_100n)),
    { retentionMs:14_400_000,externalMinimumBuyAmountRaw:1_000n,manualKillSwitch:true },
  );
  const prepared = strategy.prepare(candidate, {
    externalBuyTarget:10,minimumConfirmation:'confirmed',nowMs:1_000,
  });
  assert.ok(prepared);
  const { pendingExitTriggerAtMs:_missing,...legacy } = prepared;
  void _missing;

  const result = await strategy.reconcile({
    candidate,session:{ ...legacy,state:'EXIT_PENDING_QUOTE',positionId:POSITION.id,
      pendingExitReason:'MANUAL_KILL_SWITCH' },position:POSITION,creator:'creator',
    launchTrades:[],marketTrades:[],nowMs:5_000,
  });

  assert.equal(ledger.closeCalls[0]?.exitTriggerAtMs,undefined);
  assert.equal(result.session.pendingExitTriggerAtMs,null);
});

void test('replays an orphaned open with provenance persisted on the position', async () => {
  const ledger = new FakeLedger();
  const strategy = new CreationEntryV1Strategy(
    ledger,new FakeRouter(),
    { retentionMs:14_400_000,externalMinimumBuyAmountRaw:1_000n },
  );
  const candidate = eligibleCandidate();
  const session = strategy.prepare(candidate, {
    externalBuyTarget:10,minimumConfirmation:'confirmed',nowMs:1_000,
  });
  assert.ok(session);
  const orphaned = Object.freeze({ ...candidateEvent(),confirmationStatus:'orphaned' as const });

  await strategy.reconcileSource({
    candidate,session:{ ...session,state:'WAITING_EXTERNAL_BUYS',positionId:POSITION.id },
    qualification:Object.freeze({}) as QualificationReport,qualificationEvent:orphaned,
    maximumRoundTripLossBps:3_000n,entryDecisionAtMs:500,
    entryDecisionJobId:'persisted-paper-job',
  });

  assert.equal(ledger.reconcileOpenCalls[0]?.entryDecisionAtMs, 500);
  assert.equal(ledger.reconcileOpenCalls[0]?.entryDecisionJobId, 'persisted-paper-job');
});

void test('keeps a mandatory exit pending when the full sell quote is unavailable', async () => {
  const ledger = new FakeLedger();
  const router = new FakeRouter(new PaperQuoteError('QUOTE_STATE_UNAVAILABLE', 'state unavailable'));
  const strategy = new CreationEntryV1Strategy(
    ledger, router,
    { retentionMs: 14_400_000, externalMinimumBuyAmountRaw: 1_000n },
  );
  const candidate = eligibleCandidate();
  const session = strategy.prepare(candidate, {
    externalBuyTarget: 1, minimumConfirmation: 'confirmed', nowMs: 1_000,
  });
  assert.ok(session);

  const result = await strategy.reconcile({
    candidate, session: { ...session, state: 'WAITING_EXTERNAL_BUYS', positionId: POSITION.id },
    position: POSITION, creator: 'creator', launchTrades: [launchBuy('external', 2, 'wallet-a', 2_000n)],
    marketTrades: [], nowMs: 4_000,
  });

  assert.equal(result.requestedAction, 'NONE');
  assert.equal(result.session.state, 'EXIT_PENDING_QUOTE');
  assert.equal(result.session.reasonCode, 'SELL_QUOTE_UNAVAILABLE_OR_STALE');
  assert.equal(result.session.pendingExitReason, 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED');
  assert.equal(ledger.closeCalls.length, 0);
});

void test('preserves the exact target-buy observation across a quote retry', async () => {
  const ledger = new FakeLedger();
  const candidate = eligibleCandidate();
  const failed = new CreationEntryV1Strategy(
    ledger,
    new FakeRouter(new PaperQuoteError('QUOTE_STATE_UNAVAILABLE', 'state unavailable')),
    { retentionMs: 14_400_000, externalMinimumBuyAmountRaw: 1_000n },
  );
  const prepared = failed.prepare(candidate, {
    externalBuyTarget: 1, minimumConfirmation: 'confirmed', nowMs: 1_000,
  });
  assert.ok(prepared);
  const sourceBuy = launchBuy('target-source', 2, 'wallet-a', 2_000n);
  const pending = await failed.reconcile({
    candidate, session:{ ...prepared,state:'WAITING_EXTERNAL_BUYS',positionId:POSITION.id },
    position:POSITION,creator:'creator',launchTrades:[sourceBuy],marketTrades:[],nowMs:4_000,
    contextEvent:candidateEvent(),
  });
  assert.equal(pending.session.state, 'EXIT_PENDING_QUOTE');

  const recovered = new CreationEntryV1Strategy(
    ledger, new FakeRouter(quote('sell-retry', 'MINT', 'SOL', 900n, 1_100n)),
    { retentionMs: 14_400_000, externalMinimumBuyAmountRaw: 1_000n },
  );
  await recovered.reconcile({
    candidate,session:pending.session,position:POSITION,creator:'creator',
    launchTrades:[sourceBuy],marketTrades:[],nowMs:5_000,contextEvent:candidateEvent(),
  });

  assert.equal(ledger.closeCalls[0]?.reason, 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED');
  assert.equal(ledger.closeCalls[0]?.exitTriggerAtMs, sourceBuy.observedAtMs);
  assert.equal(ledger.closeCalls[0]?.trigger.id, sourceBuy.id);
});

void test('keeps a retrospective exit quote pending until a post-trigger retry', async () => {
  const ledger = new FakeLedger();
  const candidate = eligibleCandidate();
  const sourceBuy = launchBuy('causal-target', 2, 'wallet-a', 2_000n);
  const strategy = new CreationEntryV1Strategy(
    ledger,
    new FakeRouter({ ...quote('retrospective', 'MINT', 'SOL', 900n, 1_100n), observedAtMs: 1_001 }),
    { retentionMs: 14_400_000, externalMinimumBuyAmountRaw: 1_000n },
  );
  const prepared = strategy.prepare(candidate, {
    externalBuyTarget: 1, minimumConfirmation: 'confirmed', nowMs: 1_000,
  });
  assert.ok(prepared);

  const pending = await strategy.reconcile({
    candidate, session:{ ...prepared,state:'WAITING_EXTERNAL_BUYS',positionId:POSITION.id },
    position:POSITION,creator:'creator',launchTrades:[sourceBuy],marketTrades:[],nowMs:4_000,
  });

  assert.equal(pending.requestedAction, 'NONE');
  assert.equal(pending.session.state, 'EXIT_PENDING_QUOTE');
  assert.equal(pending.session.reasonCode, 'SELL_QUOTE_UNAVAILABLE_OR_STALE');
  assert.equal(pending.session.pendingExitReason, 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED');
  assert.equal(pending.session.lastError?.code, 'QUOTE_STALE');
  assert.equal(pending.session.lastError?.retryable, true);
  assert.equal(ledger.closeCalls.length, 0);

  const recovered = new CreationEntryV1Strategy(
    ledger, new FakeRouter(quote('post-trigger', 'MINT', 'SOL', 900n, 1_100n)),
    { retentionMs: 14_400_000, externalMinimumBuyAmountRaw: 1_000n },
  );
  const closed = await recovered.reconcile({
    candidate,session:pending.session,position:POSITION,creator:'creator',
    launchTrades:[sourceBuy],marketTrades:[],nowMs:5_000,
  });
  assert.equal(closed.requestedAction, 'CLOSE');
  assert.equal(ledger.closeCalls.length, 1);
  assert.equal(ledger.closeCalls[0]?.sellQuote.observedAtMs, 4_000);
  assert.equal(ledger.closeCalls[0]?.exitTriggerAtMs, sourceBuy.observedAtMs);
});

void test('uses the exact Nth new wallet trade when prior-wallet duplicates are interleaved', async () => {
  const ledger = new FakeLedger();
  const candidate = eligibleCandidate();
  const strategy = new CreationEntryV1Strategy(
    ledger, new FakeRouter(),
    { retentionMs: 14_400_000, externalMinimumBuyAmountRaw: 1_000n },
  );
  const prepared = strategy.prepare(candidate, {
    externalBuyTarget: 3, minimumConfirmation: 'confirmed', nowMs: 1_000,
  });
  assert.ok(prepared);
  const first = await strategy.reconcile({
    candidate, session:{ ...prepared,state:'WAITING_EXTERNAL_BUYS',positionId:POSITION.id },
    position:POSITION,creator:'creator',
    launchTrades:[
      launchBuy('wallet-a-first', 2, 'wallet-a', 2_000n),
      launchBuy('wallet-b-first', 3, 'wallet-b', 2_000n),
    ],marketTrades:[],nowMs:3_000,
  });
  const target = launchBuy('wallet-c-target', 6, 'wallet-c', 2_000n);
  const closed = await strategy.reconcile({
    candidate,session:first.session,position:POSITION,creator:'creator',
    launchTrades:[
      launchBuy('wallet-b-duplicate-1', 4, 'wallet-b', 2_000n),
      launchBuy('wallet-b-duplicate-2', 5, 'wallet-b', 2_000n),
      target,
    ],marketTrades:[],nowMs:4_000,
  });

  assert.equal(closed.requestedAction, 'CLOSE');
  assert.equal(ledger.closeCalls[0]?.exitTriggerAtMs, target.observedAtMs);
  assert.equal(ledger.closeCalls[0]?.trigger.id, target.id);
});

void test('recovers a committed creation close without quoting or closing twice', async () => {
  const ledger = new FakeLedger();
  const router = new FakeRouter(new Error('must not quote'));
  const strategy = new CreationEntryV1Strategy(
    ledger, router,
    { retentionMs: 14_400_000, externalMinimumBuyAmountRaw: 1_000n },
  );
  const candidate = eligibleCandidate();
  const session = strategy.prepare(candidate, {
    externalBuyTarget: 1, minimumConfirmation: 'confirmed', nowMs: 1_000,
  });
  assert.ok(session);
  const committed = Object.freeze({
    ...POSITION,
    status: 'PAPER_CLOSED' as const,
    remainingBaseRaw: 0n,
    quoteProceedsRaw: 1_000n,
    grossPnlQuoteRaw: 0n,
    netPnlQuoteRaw: 0n,
    exitTradeId: 'exit',
    closeCommandHash: 'close',
    closedAtMs: 4_000,
    purgeAfterMs: 14_404_000,
  });

  const result = await strategy.reconcile({
    candidate,
    session: { ...session, state: 'WAITING_EXTERNAL_BUYS', positionId: POSITION.id },
    position: committed,
    creator: 'creator',
    launchTrades: [launchBuy('external', 2, 'wallet-a', 2_000n)],
    marketTrades: [],
    nowMs: 5_000,
  });

  assert.equal(result.requestedAction, 'NONE');
  assert.equal(result.session.state, 'PAPER_CLOSED');
  assert.equal(result.session.reasonCode, 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED');
  assert.equal(router.requests.length, 0);
  assert.equal(ledger.closeCalls.length, 0);
});

class FakeLedger {
  public readonly openCalls: OpenPaperPositionCommand[] = [];
  public readonly reconcileOpenCalls: OpenPaperPositionCommand[] = [];
  public readonly closeCalls: ClosePaperPositionCommand[] = [];
  public async open(command: OpenPaperPositionCommand): Promise<PaperPosition> {
    this.openCalls.push(command);
    return POSITION;
  }
  public async reconcileOpen(command: OpenPaperPositionCommand): Promise<PaperPosition> {
    this.reconcileOpenCalls.push(command);
    return Object.freeze({
      ...POSITION,status:'PAPER_RETRACTED',closedAtMs:2_000,purgeAfterMs:14_402_000,
    });
  }
  public async close(command: ClosePaperPositionCommand): Promise<PaperPosition> {
    this.closeCalls.push(command);
    return Object.freeze({
      ...POSITION,
      status: 'PAPER_CLOSED',
      remainingBaseRaw: 0n,
      quoteProceedsRaw: command.sellQuote.minimumAmountOutRaw,
      grossPnlQuoteRaw: command.sellQuote.minimumAmountOutRaw - POSITION.quoteCostRaw,
      netPnlQuoteRaw: command.sellQuote.minimumAmountOutRaw - POSITION.quoteCostRaw,
      exitTradeId: 'exit',
      closeCommandHash: 'close',
      closedAtMs: 4_000,
      purgeAfterMs: 14_404_000,
    });
  }
  public async reconcileClose(): Promise<PaperPosition> { return POSITION; }
  public async retract(): Promise<PaperPosition> { return POSITION; }
}

class FakeRouter {
  public readonly requests: PaperQuoteRequest[] = [];
  public constructor(
    private readonly response: PaperExecutionQuote | Error = quote('sell', 'MINT', 'SOL', 900n, 1_000n),
  ) {}
  public async quote(request: PaperQuoteRequest): Promise<PaperExecutionQuote> {
    this.requests.push(request);
    if (this.response instanceof Error) throw this.response;
    return this.response;
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

function launchSell(
  id: string,
  instructionIndex: number,
  trader: string,
): BondingCurveTradeObservedEventV1 {
  const buy = launchBuy(id, instructionIndex, trader, 2_000n);
  return Object.freeze({
    ...buy,
    payload: Object.freeze({
      trade: Object.freeze({ ...buy.payload.trade, kind: 'SELL' as const }),
    }),
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
  minimumAmountOutRaw = amountOutRaw,
): PaperExecutionQuote {
  return Object.freeze({
    id, inputMint, outputMint, amountInRaw, amountOutRaw,
    minimumAmountOutRaw, feesRaw: 1n, slippageBps: 100n,
    priceImpactBps: 10n, observedAtMs: 4_000, observedSlot: 10n,
  });
}
