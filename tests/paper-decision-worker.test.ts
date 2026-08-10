import assert from 'node:assert/strict';
import test from 'node:test';
import type { DomainEvent } from '../src/domain/events.js';
import { createPaperStrategySession } from '../src/domain/paper-strategy.js';
import type { PaperExecutionQuote, PaperPosition } from '../src/domain/paper-trading.js';
import type { QualificationReport } from '../src/domain/qualification.js';
import { createTradingCandidate } from '../src/domain/trading-candidate.js';
import type {
  ClaimedPaperDecisionJob,
  PaperDecisionFailure,
  PaperDecisionJobInput,
  PaperDecisionQueueCounts,
  PaperDecisionRepository,
  PaperDecisionResult,
  PaperDecisionSnapshot,
} from '../src/ports/paper-decision-repository.js';
import { PaperQuoteError } from '../src/ports/paper-quote-router.js';
import {
  PaperDecisionWorker,
  type PaperDecisionWorkerScheduler,
} from '../src/application/paper-decision-worker.js';

void test('persists explainable observe decisions without requesting quotes or paper actions', async () => {
  const repository = new FakeRepository([claim()]);
  const quotes = new FakeQuotes();
  const services = fakeServices('NOT_ELIGIBLE');
  const worker = new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,services.strategy,
    options({ executionMode:'observe',paperStrategyEnabled:false }),new ManualScheduler(),
  );

  assert.deepEqual(await worker.runOnce(), { kind:'completed',jobId:'paper-job' });
  assert.equal(quotes.calls, 0);
  assert.equal(repository.stages.length, 0);
  assert.equal(repository.completions.length, 1);
  assert.equal(repository.completions[0]?.result.session, null);
});

void test('quotes both directions, stages BUY_PENDING before the ledger and completes the opened session', async () => {
  const operations: string[] = [];
  const repository = new FakeRepository([claim()], operations);
  const quotes = new FakeQuotes();
  const services = fakeServices('ELIGIBLE', operations);
  const worker = new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.deepEqual(await worker.runOnce(), { kind:'completed',jobId:'paper-job' });
  assert.equal(quotes.calls, 2);
  assert.deepEqual(operations, ['stage','open','complete']);
  assert.equal(repository.completions[0]?.result.session?.state, 'WAITING_EXTERNAL_BUYS');
});

void test('turns a typed transient quote error into a bounded repository retry', async () => {
  const repository = new FakeRepository([claim()]);
  const quotes = new FakeQuotes();
  quotes.error = new PaperQuoteError('QUOTE_STATE_UNAVAILABLE', 'unavailable');
  const services = fakeServices('NOT_ELIGIBLE');
  const worker = new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.deepEqual(await worker.runOnce(), { kind:'failed',jobId:'paper-job' });
  assert.equal(repository.failures[0]?.failure.code, 'QUOTE_UNAVAILABLE');
  assert.equal(repository.failures[0]?.failure.retryable, true);
  assert.ok(repository.failures[0]?.failure.terminalResult);
});

void test('reuses the persisted decision for an active session without entry quote RPCs', async () => {
  const repository = new FakeRepository([claim()]);
  const candidate = tradingCandidate('ELIGIBLE');
  const session = createPaperStrategySession({
    candidate,state:'WAITING_EXTERNAL_BUYS',reasonCode:'QUALIFIED_ENTRY',positionId:'position',
    entryCursor:candidate.asOf.cursor,externalBuyTarget:10,externalBuyCount:0,
    countedTradeIds:[],lastCountedCursor:null,minimumConfirmation:'confirmed',
    lastQuote:candidate.buyQuote,lastError:null,createdAtMs:1_000,updatedAtMs:1_000,
    purgeAfterMs:14_401_000,
  });
  repository.snapshotValue=snapshot({
    currentCandidate:candidate,currentSession:session,activePosition:POSITION,
    currentDecision:Object.freeze({
      reportId:candidate.qualificationReportId,evidenceFingerprint:candidate.evidenceFingerprint,
      report:report(),qualificationEvent:event('QualificationUpdated','evt_qualification'),
      candidateEvent:event('TradingCandidateUpdated','evt_candidate'),
    }),
  });
  const quotes = new FakeQuotes();
  const services = fakeServices('ELIGIBLE');
  const worker = new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind, 'completed');
  assert.equal(quotes.calls, 0);
  assert.equal(repository.stages.length, 1);
});

void test('recovers a staged BUY_PENDING session after its paper position opened', async () => {
  const operations: string[] = [];
  const repository = new FakeRepository([claim()], operations);
  const candidate = tradingCandidate('ELIGIBLE');
  const session = createPaperStrategySession({
    candidate,state:'BUY_PENDING',reasonCode:'QUALIFIED_ENTRY',positionId:null,
    entryCursor:candidate.asOf.cursor,externalBuyTarget:10,externalBuyCount:0,
    countedTradeIds:[],lastCountedCursor:null,minimumConfirmation:'confirmed',
    lastQuote:candidate.buyQuote,lastError:null,createdAtMs:1_000,updatedAtMs:1_000,
    purgeAfterMs:14_401_000,
  });
  repository.snapshotValue=snapshot({
    currentCandidate:candidate,currentSession:session,activePosition:POSITION,
    currentDecision:persistedDecision(candidate),
  });
  const services = fakeServices('NOT_ELIGIBLE', operations);
  const quotes = new FakeQuotes();
  const worker = new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind, 'completed');
  assert.equal(quotes.calls, 0);
  assert.deepEqual(operations, ['stage','recover-open','complete']);
  assert.equal(repository.completions[0]?.result.session?.state, 'WAITING_EXTERNAL_BUYS');
});

void test('retracts a paper session when its source revision becomes orphaned', async () => {
  const operations: string[] = [];
  const repository = new FakeRepository([claim()], operations);
  const candidate = tradingCandidate('ELIGIBLE');
  const session = createPaperStrategySession({
    candidate,state:'WAITING_EXTERNAL_BUYS',reasonCode:'QUALIFIED_ENTRY',positionId:POSITION.id,
    entryCursor:candidate.asOf.cursor,externalBuyTarget:10,externalBuyCount:0,
    countedTradeIds:[],lastCountedCursor:null,minimumConfirmation:'confirmed',
    lastQuote:candidate.buyQuote,lastError:null,createdAtMs:1_000,updatedAtMs:1_000,
    purgeAfterMs:14_401_000,
  });
  repository.snapshotValue=snapshot({
    asOfEvent:event('TokenLaunchDetected','evt_source','orphaned'),
    currentCandidate:candidate,currentSession:session,activePosition:POSITION,
    currentDecision:persistedDecision(candidate, 'orphaned'),
  });
  const services = fakeServices('ELIGIBLE', operations);
  const worker = new PaperDecisionWorker(
    repository,new FakeQuotes(),services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind, 'completed');
  assert.ok(operations.includes('reconcile-source'));
  assert.equal(repository.completions[0]?.result.session?.state, 'PAPER_RETRACTED');
});

void test('recounts session evidence when a later trade becomes orphaned', async () => {
  const operations: string[] = [];
  const repository = new FakeRepository([claim()], operations);
  const candidate = tradingCandidate('ELIGIBLE');
  const session = createPaperStrategySession({
    candidate,state:'WAITING_EXTERNAL_BUYS',reasonCode:'EXTERNAL_BUY_OBSERVED',
    positionId:POSITION.id,entryCursor:candidate.asOf.cursor,externalBuyTarget:10,
    externalBuyCount:1,countedTradeIds:['orphaned-trade'],lastCountedCursor:Object.freeze({
      slot:11n,transactionIndex:0,instructionIndex:2,innerInstructionIndex:null,
    }),minimumConfirmation:'confirmed',lastQuote:candidate.buyQuote,lastError:null,
    createdAtMs:1_000,updatedAtMs:2_000,purgeAfterMs:14_402_000,
  });
  repository.snapshotValue=snapshot({
    asOfEvent:Object.freeze({
      ...event('BondingCurveTradeObserved','evt_trade','orphaned'),
      cursor:Object.freeze({
        slot:11n,transactionIndex:0,instructionIndex:2,innerInstructionIndex:null,
      }),
    }),currentCandidate:candidate,currentSession:session,activePosition:POSITION,
    currentDecision:persistedDecision(candidate,'orphaned'),
  });
  const services = fakeServices('ELIGIBLE', operations);
  const worker = new PaperDecisionWorker(
    repository,new FakeQuotes(),services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind,'completed');
  assert.ok(operations.includes('reconcile-evidence'));
  assert.equal(operations.includes('reconcile-source'),false);
});

void test('retracts a closed paper session when its entry source becomes orphaned', async () => {
  const operations: string[] = [];
  const repository = new FakeRepository([claim()], operations);
  const candidate = tradingCandidate('ELIGIBLE');
  const session = createPaperStrategySession({
    candidate,state:'PAPER_CLOSED',reasonCode:'EXTERNAL_BUY_TARGET_REACHED',positionId:POSITION.id,
    entryCursor:candidate.asOf.cursor,externalBuyTarget:10,externalBuyCount:10,
    countedTradeIds:Array.from({ length:10 }, (_, index) => `trade-${index}`),
    lastCountedCursor:Object.freeze({
      slot:11n,transactionIndex:0,instructionIndex:1,innerInstructionIndex:null,
    }),minimumConfirmation:'confirmed',lastQuote:candidate.buyQuote,lastError:null,
    createdAtMs:1_000,updatedAtMs:2_000,purgeAfterMs:14_402_000,
  });
  repository.snapshotValue=snapshot({
    asOfEvent:event('TokenLaunchDetected','evt_source','orphaned'),
    currentCandidate:candidate,currentSession:session,
    activePosition:Object.freeze({
      ...POSITION,status:'PAPER_CLOSED' as const,remainingBaseRaw:0n,
      quoteProceedsRaw:1_100n,grossPnlQuoteRaw:100n,netPnlQuoteRaw:100n,
      exitTradeId:'exit',closeCommandHash:'close',closedAtMs:2_000,purgeAfterMs:14_402_000,
    }),currentDecision:persistedDecision(candidate,'orphaned'),
  });
  const services = fakeServices('ELIGIBLE', operations);
  const worker = new PaperDecisionWorker(
    repository,new FakeQuotes(),services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind, 'completed');
  assert.ok(operations.includes('reconcile-source'));
  assert.equal(repository.completions[0]?.result.session?.state, 'PAPER_RETRACTED');
});

void test('suppresses all commit work after renewal reports a lost lease', async () => {
  const scheduler = new ManualScheduler();
  const repository = new FakeRepository([claim()]);
  repository.renewResult = false;
  const services = fakeServices('NOT_ELIGIBLE');
  const gate = deferred<undefined>();
  services.candidates.gate = gate.promise;
  const worker = new PaperDecisionWorker(
    repository,new FakeQuotes(),services.qualification,services.candidates,services.strategy,
    options(),scheduler,
  );
  const running = worker.runOnce();
  await scheduler.waitForScheduled();
  await scheduler.fireNext();
  gate.resolve(undefined);

  assert.deepEqual(await running, { kind:'lease-lost',jobId:'paper-job' });
  assert.equal(repository.completions.length, 0);
  assert.equal(repository.failures.length, 0);
});

void test('starts idempotently, polls without a busy loop and closes all timers', async () => {
  const scheduler = new ManualScheduler();
  const repository = new FakeRepository([null]);
  const services = fakeServices('NOT_ELIGIBLE');
  const worker = new PaperDecisionWorker(
    repository,new FakeQuotes(),services.qualification,services.candidates,services.strategy,
    options(),scheduler,
  );
  await worker.start();
  await worker.start();
  assert.equal(worker.state, 'RUNNING');
  assert.equal(scheduler.activeCount, 1);
  await scheduler.fireNext();
  await scheduler.waitForScheduled();
  assert.equal(scheduler.activeCount, 1);
  await worker.close();
  assert.equal(worker.state, 'STOPPED');
  assert.equal(scheduler.activeCount, 0);
});

class FakeRepository implements PaperDecisionRepository {
  public readonly stages: PaperDecisionResult[] = [];
  public readonly completions: { readonly result:PaperDecisionResult }[] = [];
  public readonly failures: { readonly failure:PaperDecisionFailure }[] = [];
  public renewResult = true;
  public snapshotValue: PaperDecisionSnapshot = snapshot();
  public constructor(
    private readonly claims: (ClaimedPaperDecisionJob|null)[],
    private readonly operations: string[] = [],
  ) {}
  public async enqueue(_input: PaperDecisionJobInput): Promise<void> {}
  public async claim(): Promise<ClaimedPaperDecisionJob|null> { return this.claims.shift() ?? null; }
  public async renew(): Promise<boolean> { return this.renewResult; }
  public async loadSnapshot(): Promise<PaperDecisionSnapshot> { return this.snapshotValue; }
  public async stageDecision(_job:ClaimedPaperDecisionJob,result:PaperDecisionResult): Promise<void> {
    this.operations.push('stage'); this.stages.push(result);
  }
  public async complete(_job:ClaimedPaperDecisionJob,result:PaperDecisionResult): Promise<void> {
    this.operations.push('complete'); this.completions.push({ result });
  }
  public async fail(_job:ClaimedPaperDecisionJob,failure:PaperDecisionFailure): Promise<void> {
    this.failures.push({ failure });
  }
  public async counts(): Promise<PaperDecisionQueueCounts> {
    return Object.freeze({ pending:0,processing:0,retryableFailed:0,exhausted:0 });
  }
}

class FakeQuotes {
  public calls = 0;
  public error: PaperQuoteError|null = null;
  public async quote(request: { readonly side:'BUY'|'SELL'; readonly amountInRaw:bigint }): Promise<PaperExecutionQuote> {
    this.calls += 1;
    if (this.error !== null) throw this.error;
    return request.side === 'BUY'
      ? quote('buy','SOL','MINT',request.amountInRaw,900n,900n)
      : quote('reverse','MINT','SOL',request.amountInRaw,800n,800n);
  }
}

function fakeServices(state:'ELIGIBLE'|'NOT_ELIGIBLE', operations: string[] = []) {
  const candidate = tradingCandidate(state);
  const qualificationEvent = event('QualificationUpdated','evt_qualification');
  const rebuilt = Object.freeze({
    reportId:candidate.qualificationReportId,reportEventId:qualificationEvent.id,
    evidenceFingerprint:candidate.evidenceFingerprint,evaluation:Object.freeze({
      evaluatedAtMs:1_000,signals:Object.freeze({}),blockers:Object.freeze([]),calibrationFacts:null,
    }),report:report(),event:qualificationEvent,
  });
  const candidateResult = Object.freeze({
    candidate,event:event('TradingCandidateUpdated','evt_candidate'),
  });
  const candidates = {
    gate:Promise.resolve(),
    async create() { await this.gate; return candidateResult; },
  };
  const strategy = {
    prepare() {
      return state === 'ELIGIBLE' ? createPaperStrategySession({
        candidate,state:'BUY_PENDING',reasonCode:'QUALIFIED_ENTRY',positionId:null,
        entryCursor:candidate.asOf.cursor,externalBuyTarget:10,externalBuyCount:0,
        countedTradeIds:[],lastCountedCursor:null,minimumConfirmation:'confirmed',
        lastQuote:candidate.buyQuote,lastError:null,createdAtMs:1_000,updatedAtMs:1_000,
        purgeAfterMs:14_401_000,
      }) : null;
    },
    async open(input: { readonly session: ReturnType<typeof createPaperStrategySession> }) {
      operations.push('open');
      return Object.freeze({
        session:Object.freeze({ ...input.session,state:'WAITING_EXTERNAL_BUYS' as const,positionId:'position' }),
        sessionEvent:event('PaperStrategySessionUpdated','evt_session_open'),
        countedExternalBuys:Object.freeze([]),requestedAction:'OPEN' as const,position:POSITION,
      });
    },
    async recoverOpen(input: { readonly session: ReturnType<typeof createPaperStrategySession> }) {
      operations.push('recover-open');
      return Object.freeze({
        session:Object.freeze({ ...input.session,state:'WAITING_EXTERNAL_BUYS' as const,positionId:'position' }),
        sessionEvent:event('PaperStrategySessionUpdated','evt_session_open_recovered'),
        countedExternalBuys:Object.freeze([]),requestedAction:'NONE' as const,position:POSITION,
      });
    },
    async reconcile(input: { readonly session:ReturnType<typeof createPaperStrategySession> }) {
      return Object.freeze({
        session:input.session,sessionEvent:event('PaperStrategySessionUpdated','evt_session'),
        countedExternalBuys:Object.freeze([]),requestedAction:'NONE' as const,position:POSITION,
      });
    },
    async reconcileSource(input: { readonly session:ReturnType<typeof createPaperStrategySession> }) {
      operations.push('reconcile-source');
      const session=Object.freeze({
        ...input.session,state:'PAPER_RETRACTED' as const,reasonCode:'SOURCE_ORPHANED' as const,
        updatedAtMs:2_000,purgeAfterMs:14_402_000,
      });
      return Object.freeze({
        session,sessionEvent:event('PaperStrategySessionUpdated','evt_session_retracted','orphaned'),
        countedExternalBuys:Object.freeze([]),requestedAction:'NONE' as const,
        position:Object.freeze({
          ...POSITION,status:'PAPER_RETRACTED' as const,closedAtMs:2_000,purgeAfterMs:14_402_000,
        }),
      });
    },
    async reconcileEvidence(input: { readonly session:ReturnType<typeof createPaperStrategySession> }) {
      operations.push('reconcile-evidence');
      return Object.freeze({
        session:Object.freeze({
          ...input.session,externalBuyCount:0,countedTradeIds:Object.freeze([]),
          lastCountedCursor:null,updatedAtMs:2_000,
        }),sessionEvent:event('PaperStrategySessionUpdated','evt_session_recounted','orphaned'),
        countedExternalBuys:Object.freeze([]),requestedAction:'NONE' as const,position:POSITION,
      });
    },
  };
  return { qualification:{ rebuild:() => rebuilt },candidates,strategy };
}

function options(overrides: Partial<ConstructorParameters<typeof PaperDecisionWorker>[5]> = {}) {
  return Object.freeze({
    executionMode:'paper' as const,paperStrategyEnabled:true,entryQuoteAmountRaw:1_000n,
    quoteMintAllowlist:Object.freeze(['SOL']),
    slippageBps:100n,externalBuyTarget:10,minimumConfirmation:'confirmed' as const,
    maximumRoundTripLossBps:3_000n,pollIntervalMs:100,leaseMs:10_000,
    renewalIntervalMs:1_000,shutdownTimeoutMs:100,...overrides,
  });
}

function claim(): ClaimedPaperDecisionJob {
  return Object.freeze({
    jobId:'paper-job',mint:'MINT',sourceEventId:'evt_source',sourceRawEventId:'raw_source',
    sourceConfirmationStatus:'confirmed',inputFingerprint:'a'.repeat(64),attempts:1,
    maxAttempts:3,leaseToken:'lease',leaseExpiresAtMs:11_000,
  });
}

function snapshot(overrides: Partial<PaperDecisionSnapshot> = {}): PaperDecisionSnapshot {
  const asOfEvent=event('TokenLaunchDetected','evt_source');
  return Object.freeze({
    mint:'MINT',asOfEvent,launch:Object.freeze({
      mint:'MINT',creator:'creator',tokenProgram:'SPL_TOKEN' as const,
      quoteAssets:Object.freeze([Object.freeze({ mint:'SOL',decimals:9,tokenProgram:'SPL_TOKEN' as const })]),
      launchpad:'pumpfun',createdAt:asOfEvent.cursor,parameters:Object.freeze({}),
    }),metadata:null,social:null,creatorProfile:null,holderSnapshot:null,walletGraph:null,
    activeLaunchTrades:Object.freeze([]),activeMarketTrades:Object.freeze([]),
    currentCandidate:null,currentDecision:null,currentSession:null,activePosition:null,...overrides,
  });
}

function tradingCandidate(state:'ELIGIBLE'|'NOT_ELIGIBLE') {
  return createTradingCandidate({
    mint:'MINT',strategy:Object.freeze({ id:'validated-external-buys',version:1 }),
    qualificationReportId:`qreport_${'b'.repeat(64)}`,qualificationProfile:Object.freeze({
      id:'profile',version:1,fingerprint:'c'.repeat(64),
    }),evidenceFingerprint:'d'.repeat(64),asOfEvent:event('QualificationUpdated','evt_qualification'),
    state,quoteAsset:Object.freeze({ mint:'SOL',decimals:9,tokenProgram:'SPL_TOKEN' }),
    buyQuote:state === 'ELIGIBLE' ? quote('buy','SOL','MINT',1_000n,900n,900n) : null,
    reverseSellQuote:state === 'ELIGIBLE' ? quote('reverse','MINT','SOL',900n,800n,800n) : null,
    eligibleUntilMs:state === 'ELIGIBLE' ? 46_000 : null,
    reasonCodes:state === 'ELIGIBLE' ? ['QUALIFIED_ENTRY'] : ['QUALIFICATION_NOT_ELIGIBLE'],
    createdAtMs:1_000,purgeAfterMs:14_401_000,
  });
}

function report(): QualificationReport {
  const score=Object.freeze({ score:100,maximum:100 });
  return Object.freeze({
    ruleSet:Object.freeze({ id:'profile',version:1,status:'UNVALIDATED_RULE_SET',minimumTotalScore:60,fingerprint:'c'.repeat(64) }),
    scores:Object.freeze({ preparation:score,socialAuthenticity:score,onchainHealth:score,total:score }),
    evidence:Object.freeze([]),conditions:Object.freeze([]),blockers:Object.freeze([]),
    verdict:'QUALIFIED',evaluatedAtMs:1_000,
  });
}

function persistedDecision(
  candidate: ReturnType<typeof tradingCandidate>,
  confirmationStatus: 'confirmed' | 'orphaned' = 'confirmed',
) {
  return Object.freeze({
    reportId:candidate.qualificationReportId,evidenceFingerprint:candidate.evidenceFingerprint,
    report:report(),qualificationEvent:event('QualificationUpdated','evt_qualification',confirmationStatus),
    candidateEvent:event('TradingCandidateUpdated','evt_candidate',confirmationStatus),
  });
}

function event(
  type:DomainEvent['type'],
  id:string,
  confirmationStatus: 'confirmed' | 'orphaned' = 'confirmed',
): DomainEvent {
  return Object.freeze({
    id,type,mint:'MINT',source:'pumpfun',program:'pump',signature:'signature',
    cursor:Object.freeze({ slot:10n,transactionIndex:0,instructionIndex:1,innerInstructionIndex:null }),
    confirmationStatus,blockchainTimeMs:900,observedAtMs:1_000,
    payloadVersion:1,payload:Object.freeze({}),
  });
}

function quote(id:string,inputMint:string,outputMint:string,amountInRaw:bigint,amountOutRaw:bigint,minimumAmountOutRaw:bigint): PaperExecutionQuote {
  return Object.freeze({ id,inputMint,outputMint,amountInRaw,amountOutRaw,minimumAmountOutRaw,
    feesRaw:1n,slippageBps:100n,priceImpactBps:10n,observedAtMs:1_000,observedSlot:10n });
}

const POSITION: PaperPosition = Object.freeze({
  id:'position',mint:'MINT',quoteAsset:Object.freeze({ mint:'SOL',decimals:9,tokenProgram:'SPL_TOKEN' }),
  strategy:Object.freeze({ id:'validated-external-buys',version:1 }),status:'PAPER_HOLDING',
  baseFilledRaw:900n,remainingBaseRaw:900n,quoteCostRaw:1_000n,quoteProceedsRaw:null,
  grossPnlQuoteRaw:null,netPnlQuoteRaw:null,roundTripLossBps:2_000n,entryTradeId:'entry',exitTradeId:null,
  openCommandHash:'open',closeCommandHash:null,triggerEventId:'evt_qualification',openedAtMs:1_000,
  closedAtMs:null,purgeAfterMs:null,payloadVersion:1,
});

class ManualScheduler implements PaperDecisionWorkerScheduler {
  readonly #callbacks = new Map<object,()=>void>();
  #waiter:(()=>void)|null=null;
  public get activeCount():number { return this.#callbacks.size; }
  public now(): number { return 1_000; }
  public schedule(callback:()=>void,_delayMs:number):object {
    const handle={};this.#callbacks.set(handle,callback);this.#waiter?.();this.#waiter=null;return handle;
  }
  public cancel(handle:unknown):void { this.#callbacks.delete(handle as object); }
  public async waitForScheduled():Promise<void> {
    if (this.#callbacks.size>0)return;
    await new Promise<void>((resolve)=>{this.#waiter=resolve;});
  }
  public async fireNext():Promise<void> {
    const entry=this.#callbacks.entries().next().value as [object,()=>void]|undefined;
    assert.ok(entry);this.#callbacks.delete(entry[0]);entry[1]();
    await new Promise<void>((resolve)=>setImmediate(resolve));
  }
}

function deferred<T>() {
  let resolve!: (value:T)=>void;
  const promise=new Promise<T>((done)=>{resolve=done;});
  return { promise,resolve };
}
