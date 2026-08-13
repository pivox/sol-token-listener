import assert from 'node:assert/strict';
import test from 'node:test';
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
import type { DomainEvent } from '../src/domain/events.js';
import { ValidatedExternalBuysStrategy } from '../src/application/validated-external-buys.strategy.js';
import { PaperQuoteError } from '../src/ports/paper-quote-router.js';

void test('stages an entry, opens once and closes only on the target external BUY', async () => {
  const ledger = new FakeLedger();
  const router = new FakeRouter();
  const strategy = new ValidatedExternalBuysStrategy(ledger, router, { retentionMs: 14_400_000 });
  const candidate = eligibleCandidate();
  const pending = strategy.prepare(candidate, {
    externalBuyTarget:10,minimumConfirmation:'confirmed',nowMs:1_000,
  });
  assert.ok(pending);
  assert.equal(pending.state, 'BUY_PENDING');

  const opened = await strategy.open({
    candidate,session:pending,qualification:report(),qualificationEvent:candidateEvent(),
    maximumRoundTripLossBps:3_000n,
  });
  assert.equal(opened.session.state, 'WAITING_EXTERNAL_BUYS');
  assert.equal(opened.session.positionId, POSITION.id);
  assert.equal(ledger.openCalls.length, 1);
  assert.equal(ledger.openCalls[0]?.strategySessionId, pending.id);
  assert.equal(ledger.openCalls[0]?.qualificationReportId, candidate.qualificationReportId);
  assert.deepEqual(
    (ledger.openCalls[0] as OpenPaperPositionCommand & {
      readonly expectedCurrentQualification?:unknown;
    }|undefined)?.expectedCurrentQualification,
    Object.freeze({
      mint:candidate.mint,reportId:candidate.qualificationReportId,
      qualificationEventId:candidateEvent().id,
    }),
  );

  const first = await strategy.reconcile({
    candidate,session:opened.session,position:POSITION,creator:'creator',
    launchTrades:Array.from({ length:9 }, (_, index) => (
      launchBuy(`trade-${index + 1}`, index + 2, 'wallet-a')
    )),marketTrades:[],nowMs:2_000,
  });
  assert.equal(first.session.externalBuyCount, 9);
  assert.equal(first.session.state, 'WAITING_EXTERNAL_BUYS');
  assert.equal(first.requestedAction, 'NONE');
  assert.equal(ledger.closeCalls.length, 0);

  const second = await strategy.reconcile({
    candidate,session:first.session,position:POSITION,creator:'creator',
    launchTrades:Array.from({ length:10 }, (_, index) => (
      launchBuy(`trade-${index + 1}`, index + 2, 'wallet-a')
    )),
    marketTrades:[],nowMs:3_000,
  });
  assert.equal(second.session.externalBuyCount, 10);
  assert.equal(second.session.state, 'PAPER_CLOSED');
  assert.equal(second.requestedAction, 'CLOSE');
  assert.equal(second.countedExternalBuys.length, 1);
  assert.equal(ledger.closeCalls.length, 1);
  assert.equal(router.requests.length, 1);
  assert.equal(router.requests[0]?.side, 'SELL');
});

void test('ignores sells, creator, unknown, pre-entry, wrong quote, orphaned and duplicate trades', async () => {
  const strategy = new ValidatedExternalBuysStrategy(new FakeLedger(), new FakeRouter(), { retentionMs:14_400_000 });
  const candidate = eligibleCandidate();
  const pending = strategy.prepare(candidate, { externalBuyTarget:2,minimumConfirmation:'confirmed',nowMs:1_000 });
  assert.ok(pending);
  const holding = { ...pending,state:'WAITING_EXTERNAL_BUYS' as const,positionId:POSITION.id };
  const valid = launchBuy('valid', 2, 'wallet');
  const result = await strategy.reconcile({
    candidate,session:holding,position:POSITION,creator:'creator',nowMs:2_000,
    launchTrades:[
      { ...launchBuy('sell', 3, 'wallet'),payload:{ trade:{ ...launchBuy('sell', 3, 'wallet').payload.trade,kind:'SELL' as const } } },
      launchBuy('creator', 4, 'creator'),launchBuy('unknown', 5, null),
      launchBuy('before', 0, 'wallet'),
      { ...launchBuy('orphan', 6, 'wallet'),confirmationStatus:'orphaned' as const },
      valid,valid,
    ],
    marketTrades:[marketBuy('wrong-quote', 7, 'USDC')],
  });
  assert.equal(result.session.externalBuyCount, 1);
  assert.deepEqual(result.session.countedTradeIds, ['valid']);
});

void test('keeps an explicit exit-pending state when the sell quote is unavailable', async () => {
  const router = new FakeRouter();
  router.error = new PaperQuoteError('QUOTE_STATE_UNAVAILABLE', 'rpc unavailable');
  const strategy = new ValidatedExternalBuysStrategy(new FakeLedger(), router, { retentionMs:14_400_000 });
  const candidate = eligibleCandidate();
  const pending = strategy.prepare(candidate, { externalBuyTarget:1,minimumConfirmation:'confirmed',nowMs:1_000 });
  assert.ok(pending);
  const result = await strategy.reconcile({
    candidate,session:{ ...pending,state:'WAITING_EXTERNAL_BUYS',positionId:POSITION.id },creator:'creator',
    position:POSITION,launchTrades:[launchBuy('target',2,'wallet')],marketTrades:[],nowMs:2_000,
  });
  assert.equal(result.session.state, 'EXIT_PENDING_QUOTE');
  assert.equal(result.session.reasonCode, 'EXIT_QUOTE_UNAVAILABLE');
  assert.equal(result.session.lastError?.retryable, true);
  assert.equal(result.requestedAction, 'NONE');
});

void test('recovers a committed close without quoting or closing again', async () => {
  const ledger = new FakeLedger();
  const router = new FakeRouter();
  const strategy = new ValidatedExternalBuysStrategy(
    ledger, router, { retentionMs:14_400_000 },
  );
  const candidate = eligibleCandidate();
  const pending = strategy.prepare(candidate, {
    externalBuyTarget:1,minimumConfirmation:'confirmed',nowMs:1_000,
  });
  assert.ok(pending);
  const position = Object.freeze({
    ...POSITION,status:'PAPER_CLOSED' as const,remainingBaseRaw:0n,
    quoteProceedsRaw:1_100n,grossPnlQuoteRaw:100n,netPnlQuoteRaw:100n,
    exitTradeId:'exit',closeCommandHash:'close',closedAtMs:2_000,purgeAfterMs:14_402_000,
  });

  const result = await strategy.reconcile({
    candidate,session:Object.freeze({
      ...pending,state:'WAITING_EXTERNAL_BUYS' as const,positionId:POSITION.id,
    }),position,creator:'creator',launchTrades:[launchBuy('target',2,'wallet')],
    marketTrades:[],nowMs:3_000,
  });

  assert.equal(result.session.state, 'PAPER_CLOSED');
  assert.equal(result.requestedAction, 'NONE');
  assert.equal(router.requests.length, 0);
  assert.equal(ledger.closeCalls.length, 0);
});

void test('reconciles an orphaned entry into a retracted session without another fill', async () => {
  const ledger = new FakeLedger();
  ledger.reconcileOpenResult = Object.freeze({
    ...POSITION,status:'PAPER_RETRACTED' as const,closedAtMs:2_000,purgeAfterMs:14_402_000,
  });
  const strategy = new ValidatedExternalBuysStrategy(
    ledger, new FakeRouter(), { retentionMs:14_400_000 },
  );
  const candidate = eligibleCandidate();
  const pending = strategy.prepare(candidate, {
    externalBuyTarget:10,minimumConfirmation:'confirmed',nowMs:1_000,
  });
  assert.ok(pending);
  const holding = Object.freeze({
    ...pending,state:'WAITING_EXTERNAL_BUYS' as const,positionId:POSITION.id,
  });

  const result = await strategy.reconcileSource({
    candidate,session:holding,qualification:report(),
    qualificationEvent:Object.freeze({
      ...candidateEvent(),confirmationStatus:'orphaned' as const,
    }),
    maximumRoundTripLossBps:3_000n,
  });

  assert.equal(ledger.openCalls.length, 0);
  assert.equal(ledger.reconcileOpenCalls.length, 1);
  assert.equal(result.position?.status, 'PAPER_RETRACTED');
  assert.equal(result.session.state, 'PAPER_RETRACTED');
  assert.equal(result.session.reasonCode, 'SOURCE_ORPHANED');
  assert.equal(result.requestedAction, 'NONE');
});

void test('rebuilds counted buys after a later trade is orphaned', async () => {
  const ledger = new FakeLedger();
  const strategy = new ValidatedExternalBuysStrategy(
    ledger,new FakeRouter(),{ retentionMs:14_400_000 },
  );
  const candidate = eligibleCandidate();
  const pending = strategy.prepare(candidate, {
    externalBuyTarget:2,minimumConfirmation:'confirmed',nowMs:1_000,
  });
  assert.ok(pending);
  const stale = Object.freeze({
    ...pending,state:'WAITING_EXTERNAL_BUYS' as const,positionId:POSITION.id,
    externalBuyCount:2,countedTradeIds:Object.freeze(['active','orphaned']),
    lastCountedCursor:Object.freeze({
      slot:10n,transactionIndex:0,instructionIndex:3,innerInstructionIndex:null,
    }),updatedAtMs:2_000,purgeAfterMs:14_402_000,
  });
  const orphanedEvent = Object.freeze({
    ...candidateEvent(),type:'BondingCurveTradeObserved' as const,
    cursor:Object.freeze({
      slot:10n,transactionIndex:0,instructionIndex:3,innerInstructionIndex:null,
    }),confirmationStatus:'orphaned' as const,observedAtMs:2_000,
  });

  const result = await strategy.reconcileEvidence({
    candidate,session:stale,position:POSITION,creator:'creator',
    launchTrades:[launchBuy('active',2,'wallet')],marketTrades:[],
    orphanedEvent,nowMs:2_000,
  });

  assert.equal(result.session.state,'WAITING_EXTERNAL_BUYS');
  assert.equal(result.session.externalBuyCount,1);
  assert.deepEqual(result.session.countedTradeIds,['active']);
  assert.equal(ledger.retractCalls.length,0);
});

void test('retracts a committed close when active buys fall below the target', async () => {
  const ledger = new FakeLedger();
  const strategy = new ValidatedExternalBuysStrategy(
    ledger,new FakeRouter(),{ retentionMs:14_400_000 },
  );
  const candidate = eligibleCandidate();
  const pending = strategy.prepare(candidate, {
    externalBuyTarget:1,minimumConfirmation:'confirmed',nowMs:1_000,
  });
  assert.ok(pending);
  const closedPosition = Object.freeze({
    ...POSITION,status:'PAPER_CLOSED' as const,remainingBaseRaw:0n,
    quoteProceedsRaw:1_100n,grossPnlQuoteRaw:100n,netPnlQuoteRaw:100n,
    exitTradeId:'exit',closeCommandHash:'close',closedAtMs:2_000,purgeAfterMs:14_402_000,
  });
  const closedSession = Object.freeze({
    ...pending,state:'PAPER_CLOSED' as const,reasonCode:'EXTERNAL_BUY_TARGET_REACHED' as const,
    positionId:POSITION.id,externalBuyCount:1,countedTradeIds:Object.freeze(['orphaned']),
    lastCountedCursor:Object.freeze({
      slot:10n,transactionIndex:0,instructionIndex:2,innerInstructionIndex:null,
    }),updatedAtMs:2_000,purgeAfterMs:14_402_000,
  });
  const orphanedEvent = Object.freeze({
    ...candidateEvent(),type:'BondingCurveTradeObserved' as const,
    cursor:Object.freeze({
      slot:10n,transactionIndex:0,instructionIndex:2,innerInstructionIndex:null,
    }),confirmationStatus:'orphaned' as const,observedAtMs:2_000,
  });

  const result = await strategy.reconcileEvidence({
    candidate,session:closedSession,position:closedPosition,creator:'creator',
    launchTrades:[],marketTrades:[],orphanedEvent,nowMs:2_000,
  });

  assert.equal(result.session.state,'PAPER_RETRACTED');
  assert.equal(result.position?.status,'PAPER_RETRACTED');
  assert.equal(ledger.retractCalls.length,1);
  assert.equal(ledger.closeCalls.length,0);
});

class FakeLedger {
  public readonly openCalls: OpenPaperPositionCommand[] = [];
  public readonly reconcileOpenCalls: OpenPaperPositionCommand[] = [];
  public readonly closeCalls: ClosePaperPositionCommand[] = [];
  public readonly retractCalls: { readonly positionId:string; readonly trigger:DomainEvent }[] = [];
  public openResult: PaperPosition = POSITION;
  public reconcileOpenResult: PaperPosition = POSITION;
  public async open(command: OpenPaperPositionCommand): Promise<PaperPosition> {
    this.openCalls.push(command);
    return this.openResult;
  }
  public async reconcileOpen(command: OpenPaperPositionCommand): Promise<PaperPosition> {
    this.reconcileOpenCalls.push(command);
    return this.reconcileOpenResult;
  }
  public async close(command: ClosePaperPositionCommand): Promise<PaperPosition> {
    this.closeCalls.push(command);
    return Object.freeze({
      ...POSITION,status:'PAPER_CLOSED',remainingBaseRaw:0n,quoteProceedsRaw:1_100n,
      grossPnlQuoteRaw:100n,netPnlQuoteRaw:100n,exitTradeId:'exit',closeCommandHash:'close',
      closedAtMs:3_000,purgeAfterMs:14_403_000,
    });
  }
  public async retract(positionId: string, trigger: DomainEvent): Promise<PaperPosition> {
    this.retractCalls.push({ positionId,trigger });
    return Object.freeze({
      ...POSITION,status:'PAPER_RETRACTED' as const,closedAtMs:2_000,purgeAfterMs:14_402_000,
    });
  }
}

class FakeRouter {
  public readonly requests: { readonly side:string }[] = [];
  public error: Error | null = null;
  public async quote(request: { readonly side:'BUY'|'SELL' }): Promise<PaperExecutionQuote> {
    this.requests.push(request);
    if (this.error !== null) throw this.error;
    return quote('exit','MINT','SOL',900n,1_100n,1_100n);
  }
}

const POSITION: PaperPosition = Object.freeze({
  id:'paper_position',mint:'MINT',quoteAsset:Object.freeze({ mint:'SOL',decimals:9,tokenProgram:'SPL_TOKEN' }),
  strategy:Object.freeze({ id:'validated-external-buys',version:1 }),status:'PAPER_HOLDING',
  baseFilledRaw:900n,remainingBaseRaw:900n,quoteCostRaw:1_000n,quoteProceedsRaw:null,
  grossPnlQuoteRaw:null,netPnlQuoteRaw:null,roundTripLossBps:2_000n,entryTradeId:'entry',
  exitTradeId:null,openCommandHash:'open',closeCommandHash:null,triggerEventId:'evt_qualification',
  openedAtMs:1_000,closedAtMs:null,purgeAfterMs:null,payloadVersion:1,
});

function eligibleCandidate() {
  return createTradingCandidate({
    mint:'MINT',strategy:Object.freeze({ id:'validated-external-buys',version:1 }),
    qualificationReportId:`qreport_${'a'.repeat(64)}`,qualificationProfile:Object.freeze({
      id:'pumpfun-v1-initial',version:1,fingerprint:'b'.repeat(64),
    }),evidenceFingerprint:'c'.repeat(64),asOfEvent:candidateEvent(),state:'ELIGIBLE',
    quoteAsset:Object.freeze({ mint:'SOL',decimals:9,tokenProgram:'SPL_TOKEN' }),
    buyQuote:quote('buy','SOL','MINT',1_000n,900n,900n),
    reverseSellQuote:quote('reverse','MINT','SOL',900n,800n,800n),eligibleUntilMs:46_000,
    reasonCodes:['QUALIFIED_ENTRY'],createdAtMs:1_000,purgeAfterMs:14_401_000,
  });
}

function candidateEvent(): DomainEvent {
  return Object.freeze({
    id:'evt_qualification',type:'QualificationUpdated',mint:'MINT',source:'paper-decision',
    program:'pump',signature:'signature',cursor:Object.freeze({
      slot:10n,transactionIndex:0,instructionIndex:1,innerInstructionIndex:null,
    }),confirmationStatus:'confirmed',blockchainTimeMs:900,observedAtMs:1_000,
    payloadVersion:1,payload:Object.freeze({}),
  });
}

function launchBuy(
  id:string,instructionIndex:number,trader:string|null,
): BondingCurveTradeObservedEventV1 {
  const cursor = Object.freeze({ slot:10n,transactionIndex:0,instructionIndex,innerInstructionIndex:null });
  return Object.freeze({
    id:`evt_${id}`,type:'BondingCurveTradeObserved',mint:'MINT',source:'pumpfun',program:'pump',
    signature:`sig-${id}`,cursor,confirmationStatus:'confirmed',blockchainTimeMs:1_000,
    observedAtMs:1_000+instructionIndex,payloadVersion:1,payload:Object.freeze({ trade:Object.freeze({
      id,launchMint:'MINT',kind:'BUY',trader,baseAmountRaw:1n,quoteAmountRaw:1n,
      quoteAsset:Object.freeze({ mint:'SOL',decimals:9,tokenProgram:'SPL_TOKEN' }),cursor,
    }) }),
  });
}

function marketBuy(id:string,instructionIndex:number,quoteMint:string): MarketTrade {
  return Object.freeze({
    id,pool:'pool',mint:'MINT',quoteAsset:Object.freeze({ mint:quoteMint,decimals:9,tokenProgram:'SPL_TOKEN' }),
    kind:'BUY',trader:'wallet',baseAmountRaw:1n,quoteAmountRaw:1n,source:'pumpswap',
    program:'pump-amm',signature:`sig-${id}`,cursor:Object.freeze({
      slot:10n,transactionIndex:0,instructionIndex,innerInstructionIndex:null,
    }),confirmationStatus:'confirmed',blockchainTimeMs:1_000,observedAtMs:2_000,
  });
}

function report(): QualificationReport {
  const score=Object.freeze({ score:100,maximum:100 });
  return Object.freeze({
    ruleSet:Object.freeze({ id:'pumpfun-v1-initial',version:1,status:'UNVALIDATED_RULE_SET',minimumTotalScore:60,fingerprint:'b'.repeat(64) }),
    scores:Object.freeze({ preparation:score,socialAuthenticity:score,onchainHealth:score,total:score }),
    evidence:Object.freeze([]),conditions:Object.freeze([]),blockers:Object.freeze([]),verdict:'QUALIFIED',evaluatedAtMs:1_000,
  });
}

function quote(
  id:string,inputMint:string,outputMint:string,amountInRaw:bigint,
  amountOutRaw:bigint,minimumAmountOutRaw:bigint,
): PaperExecutionQuote {
  return Object.freeze({
    id,inputMint,outputMint,amountInRaw,amountOutRaw,minimumAmountOutRaw,feesRaw:1n,
    slippageBps:100n,priceImpactBps:10n,observedAtMs:1_000,observedSlot:10n,
  });
}
