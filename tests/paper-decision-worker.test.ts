import assert from 'node:assert/strict';
import test from 'node:test';
import { QualificationRebuildService } from '../src/application/qualification-rebuild.service.js';
import type { DomainEvent } from '../src/domain/events.js';
import { createPaperStrategySession } from '../src/domain/paper-strategy.js';
import {
  PaperTradingError,
  type PaperExecutionQuote,
  type PaperPosition,
} from '../src/domain/paper-trading.js';
import type { QualificationReport } from '../src/domain/qualification.js';
import { createTradingCandidate } from '../src/domain/trading-candidate.js';
import type { ChainCursor } from '../src/domain/types.js';
import type { CanonicalQualificationProjection } from '../src/ports/qualification-projection-repository.js';
import {
  createDefaultQualificationRuleSet,
  QualificationEngine,
} from '../src/qualification/qualification-engine.js';
import { fromJsonValue,toJsonValue } from '../src/utils/json.js';
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
  createPaperDecisionStrategyRegistry,
  type PaperDecisionWorkerScheduler,
} from '../src/application/paper-decision-worker.js';
import { CreationEntryV1Strategy } from '../src/application/creation-entry-v1.strategy.js';
import { ValidatedExternalBuysStrategy } from '../src/application/validated-external-buys.strategy.js';

void test('persists explainable observe decisions without requesting quotes or paper actions', async () => {
  const repository = new FakeRepository([claim()]);
  const quotes = new FakeQuotes();
  const paperActions: string[] = [];
  const services = fakeServices('NOT_ELIGIBLE', paperActions);
  const worker = new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,services.strategy,
    options({ executionMode:'observe',paperStrategyEnabled:false }),new ManualScheduler(),
  );

  assert.deepEqual(await worker.runOnce(), { kind:'completed',jobId:'paper-job' });
  assert.equal(quotes.calls, 0);
  assert.equal(services.candidates.calls.length, 1);
  assert.deepEqual(paperActions, []);
  assert.equal(repository.stages.length, 0);
  assert.equal(repository.completions.length, 1);
  assert.equal(repository.completions[0]?.result.session, null);
});

void test('retries before quotes when no canonical qualification is persisted', async () => {
  const repository = new FakeRepository([claim()]);
  repository.snapshotValue = snapshot({ currentQualification:null });
  const quotes = new FakeQuotes();
  const services = fakeServices('NOT_ELIGIBLE');
  const worker = new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.deepEqual(await worker.runOnce(), { kind:'failed',jobId:'paper-job' });
  assert.equal(repository.failures[0]?.failure.code, 'RPC_TRANSIENT');
  assert.equal(repository.failures[0]?.failure.retryable, true);
  assert.equal(quotes.calls, 0);
  assert.equal(services.candidates.calls.length, 0);
  assert.equal(repository.stages.length, 0);
  assert.equal(repository.completions.length, 0);
});

void test('completes an orphan-only launch without paper lineage as a no-op', async () => {
  const repository = new FakeRepository([claim()]);
  repository.snapshotValue = snapshot({
    canonicalLaunchActive:false,
    currentQualification:null,
    currentCandidate:null,
    currentDecision:null,
    currentSession:null,
    activePosition:null,
  });
  const quotes = new FakeQuotes();
  const services = fakeServices('NOT_ELIGIBLE');
  const worker = new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.deepEqual(await worker.runOnce(), { kind:'completed',jobId:'paper-job' });
  assert.equal(repository.noopCompletions,1);
  assert.equal(repository.failures.length,0);
  assert.equal(repository.completions.length,0);
  assert.equal(quotes.calls,0);
  assert.equal(services.candidates.calls.length,0);
});

void test('completes a superseded orphan job without reconciling unrelated paper lineage', async () => {
  const repository = new FakeRepository([claim()]);
  repository.snapshotValue = snapshot({
    canonicalLaunchActive:false,
    currentQualification:null,
    currentCandidate:null,
    currentDecision:null,
    currentSession:null,
    activePosition:null,
    hasPaperLineage:true,
  } as Partial<PaperDecisionSnapshot> & { readonly hasPaperLineage:boolean });
  const quotes = new FakeQuotes();
  const services = fakeServices('NOT_ELIGIBLE');
  const worker = new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.deepEqual(await worker.runOnce(), { kind:'completed',jobId:'paper-job' });
  assert.equal(repository.obsoleteCompletions,1);
  assert.equal(repository.noopCompletions,0);
  assert.equal(repository.failures.length,0);
  assert.equal(repository.completions.length,0);
  assert.equal(quotes.calls,0);
  assert.equal(services.candidates.calls.length,0);
});

void test('reauthorizes the persisted canonical qualification and preserves its candidate identity', async () => {
  const repository = new FakeRepository([claim()]);
  const persisted = canonicalQualification();
  repository.snapshotValue = snapshot({ currentQualification:persisted });
  const services = fakeServices('NOT_ELIGIBLE');
  const worker = new PaperDecisionWorker(
    repository,new FakeQuotes(),services.qualification,services.candidates,services.strategy,
    options({ executionMode:'observe',paperStrategyEnabled:false }),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind, 'completed');
  assert.deepEqual(services.qualification.calls, [persisted]);
  const input = services.candidates.calls[0];
  assert.ok(input);
  assert.equal(input.report, services.qualification.authorizedReport);
  assert.equal(input.reportId, persisted.reportId);
  assert.equal(input.qualificationEvent, persisted.qualificationEvent);
  assert.equal(input.evidenceFingerprint, persisted.evidenceFingerprint);
});

void test('reauthorizes a JSON-deserialized qualification before creating a candidate', async () => {
  const repository=new FakeRepository([claim()]);
  const qualification=new QualificationRebuildService(
    new QualificationEngine(createDefaultQualificationRuleSet(60)),
  );
  const persisted=fromJsonValue(toJsonValue(
    realCanonicalQualification(qualification),
  )) as CanonicalQualificationProjection;
  repository.snapshotValue=snapshot({ currentQualification:persisted });
  const services=fakeServices('NOT_ELIGIBLE');
  const worker=new PaperDecisionWorker(
    repository,new FakeQuotes(),qualification,services.candidates,services.strategy,
    options({ executionMode:'observe',paperStrategyEnabled:false }),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind,'completed');
  assert.equal(services.candidates.calls.length,1);
});

void test('rejects invalid qualification before paper quotes and candidate creation',async()=>{
  const operations:string[]=[];
  const repository=new FakeRepository([claim()],operations);
  const persisted=canonicalQualification();
  repository.snapshotValue=snapshot({ currentQualification:persisted });
  const services=fakeServices('ELIGIBLE');
  services.qualification.rejected=persisted;
  services.qualification.beforeReauthorize=()=>{operations.push('authorize');};
  services.candidates.beforeCreate=()=>{operations.push('candidate');};
  const quotes=new FakeQuotes(operations);
  const worker=new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind,'failed');
  assert.deepEqual(operations,['authorize','fail']);
  assert.equal(quotes.calls,0);
  assert.equal(services.candidates.calls.length,0);
  assert.equal(repository.stages.length,0);
  assert.equal(repository.completions.length,0);
  assert.deepEqual(repository.failures[0]?.failure,{
    code:'DECISION_INVALID',retryable:false,terminalResult:null,
  });
});

for(const mutation of canonicalTamperingCases()){
  void test(`rejects tampered persisted qualification ${mutation.name} before paper writes`,async()=>{
    const repository=new FakeRepository([claim()]);
    const qualification=new QualificationRebuildService(
      new QualificationEngine(createDefaultQualificationRuleSet(60)),
    );
    const persisted=fromJsonValue(toJsonValue(
      realCanonicalQualification(qualification),
    )) as CanonicalQualificationProjection;
    repository.snapshotValue=snapshot({ currentQualification:mutation.mutate(persisted) });
    const services=fakeServices('NOT_ELIGIBLE');
    const worker=new PaperDecisionWorker(
      repository,new FakeQuotes(),qualification,services.candidates,services.strategy,
      options({ executionMode:'observe',paperStrategyEnabled:false }),new ManualScheduler(),
    );

    assert.equal((await worker.runOnce()).kind,'failed');
    assert.equal(repository.failures[0]?.failure.code,'DECISION_INVALID');
    assert.equal(repository.failures[0]?.failure.retryable,false);
    assert.equal(services.candidates.calls.length,0);
    assert.equal(repository.stages.length,0);
    assert.equal(repository.completions.length,0);
  });
}

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

void test('retries only a typed stale qualification rejected at paper open',async()=>{
  const operations:string[]=[];
  const repository=new FakeRepository([claim()],operations);
  const services=fakeServices('ELIGIBLE',operations);
  services.strategy.openError=new PaperTradingError(
    'QUALIFICATION_NOT_CURRENT','stale qualification',
  );
  const worker=new PaperDecisionWorker(
    repository,new FakeQuotes(),services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind,'failed');
  assert.deepEqual(operations,['stage','open','fail']);
  assert.deepEqual(repository.failures[0]?.failure,{
    code:'RPC_TRANSIENT',retryable:true,terminalResult:null,
  });
});

void test('keeps non-stale paper open failures terminal',async()=>{
  const operations:string[]=[];
  const repository=new FakeRepository([claim()],operations);
  const services=fakeServices('ELIGIBLE',operations);
  services.strategy.openError=new PaperTradingError('POSITION_CONFLICT','conflict');
  const worker=new PaperDecisionWorker(
    repository,new FakeQuotes(),services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind,'failed');
  assert.equal(repository.failures[0]?.failure.code,'DECISION_INVALID');
  assert.equal(repository.failures[0]?.failure.retryable,false);
  assert.equal(repository.failures[0]?.failure.terminalResult,repository.stages[0]);
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
      qualification:canonicalQualification(),
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

void test('routes a persisted V1 session to legacy while creation is active', async () => {
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
      qualification:canonicalQualification(),
      candidateEvent:event('TradingCandidateUpdated','evt_candidate'),
    }),
  });
  const unreachableLedger = {
    async open(): Promise<never> { throw new Error('not called'); },
    async reconcileOpen(): Promise<never> { throw new Error('not called'); },
    async close(): Promise<never> { throw new Error('not called'); },
    async reconcileClose(): Promise<never> { throw new Error('not called'); },
    async retract(): Promise<never> { throw new Error('not called'); },
  };
  const quotes = new FakeQuotes();
  const services = fakeServices('ELIGIBLE');
  const worker = new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,
    createPaperDecisionStrategyRegistry({
      activeStrategyId:'creation-entry-v1',
      legacy:new ValidatedExternalBuysStrategy(unreachableLedger,quotes,{ retentionMs:14_400_000 }),
      creation:new CreationEntryV1Strategy(unreachableLedger,quotes,{
        retentionMs:14_400_000,externalMinimumBuyAmountRaw:1n,
      }),
    }),
    options(),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind,'completed');
  assert.equal(quotes.calls,0);
  assert.equal(repository.completions[0]?.result.session?.payloadVersion,1);
});

void test('reconciles the exact historical qualification without opening a new position', async () => {
  const operations:string[]=[];
  const repository=new FakeRepository([claim()],operations);
  const candidate=tradingCandidate('ELIGIBLE');
  const historical=canonicalQualification();
  const active=Object.freeze({
    ...canonicalQualification(),reportId:`qreport_${'f'.repeat(64)}`,
  });
  const session=createPaperStrategySession({
    candidate,state:'WAITING_EXTERNAL_BUYS',reasonCode:'QUALIFIED_ENTRY',positionId:'position',
    entryCursor:candidate.asOf.cursor,externalBuyTarget:10,externalBuyCount:0,
    countedTradeIds:[],lastCountedCursor:null,minimumConfirmation:'confirmed',
    lastQuote:candidate.buyQuote,lastError:null,createdAtMs:1_000,updatedAtMs:1_000,
    purgeAfterMs:14_401_000,
  });
  repository.snapshotValue=snapshot({
    currentQualification:active,currentCandidate:candidate,currentSession:session,
    activePosition:POSITION,currentDecision:Object.freeze({
      qualification:historical,candidateEvent:event('TradingCandidateUpdated','evt_candidate'),
    }),
  });
  const services=fakeServices('ELIGIBLE',operations);
  const quotes=new FakeQuotes();
  const worker=new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind,'completed');
  assert.equal(services.qualification.calls[0],historical);
  assert.equal(services.candidates.calls.length,0);
  assert.deepEqual(operations,['stage','complete']);
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
  assert.equal(services.strategy.recoverOpenInputs[0]?.entryDecisionAtMs, 500);
  assert.equal(services.strategy.recoverOpenInputs[0]?.entryDecisionJobId, 'paper-job');
  assert.equal(repository.completions[0]?.result.session?.state, 'WAITING_EXTERNAL_BUYS');
});

void test('defers a staged BUY_PENDING open when its qualification was superseded',async()=>{
  const operations:string[]=[];
  const repository=new FakeRepository([claim()],operations);
  const candidate=tradingCandidate('ELIGIBLE');
  const historical=canonicalQualification();
  const superseded=Object.freeze({
    ...canonicalQualification(),reportId:`qreport_${'f'.repeat(64)}`,
  });
  const session=createPaperStrategySession({
    candidate,state:'BUY_PENDING',reasonCode:'QUALIFIED_ENTRY',positionId:null,
    entryCursor:candidate.asOf.cursor,externalBuyTarget:10,externalBuyCount:0,
    countedTradeIds:[],lastCountedCursor:null,minimumConfirmation:'confirmed',
    lastQuote:candidate.buyQuote,lastError:null,createdAtMs:1_000,updatedAtMs:1_000,
    purgeAfterMs:14_401_000,
  });
  repository.snapshotValue=snapshot({
    currentQualification:superseded,currentCandidate:candidate,currentSession:session,
    activePosition:null,
    currentDecision:Object.freeze({
      qualification:historical,candidateEvent:event('TradingCandidateUpdated','evt_candidate'),
    }),
  });
  const services=fakeServices('ELIGIBLE',operations);
  const quotes=new FakeQuotes();
  const worker=new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind,'failed');
  assert.deepEqual(services.qualification.calls,[historical,superseded]);
  assert.equal(services.candidates.calls.length,0);
  assert.equal(quotes.calls,0);
  assert.deepEqual(operations,['fail']);
  assert.deepEqual(repository.failures[0]?.failure,{
    code:'RPC_TRANSIENT',retryable:true,terminalResult:null,
  });
  assert.equal(repository.stages.length,0);
  assert.equal(repository.completions.length,0);
});

void test('defers a staged BUY_PENDING open when current qualification is missing',async()=>{
  const operations:string[]=[];
  const repository=new FakeRepository([claim()],operations);
  const candidate=tradingCandidate('ELIGIBLE');
  const historical=canonicalQualification();
  const session=createPaperStrategySession({
    candidate,state:'BUY_PENDING',reasonCode:'QUALIFIED_ENTRY',positionId:null,
    entryCursor:candidate.asOf.cursor,externalBuyTarget:10,externalBuyCount:0,
    countedTradeIds:[],lastCountedCursor:null,minimumConfirmation:'confirmed',
    lastQuote:candidate.buyQuote,lastError:null,createdAtMs:1_000,updatedAtMs:1_000,
    purgeAfterMs:14_401_000,
  });
  repository.snapshotValue=snapshot({
    currentQualification:null,currentCandidate:candidate,currentSession:session,
    activePosition:null,currentDecision:Object.freeze({
      qualification:historical,candidateEvent:event('TradingCandidateUpdated','evt_candidate'),
    }),
  });
  const services=fakeServices('ELIGIBLE',operations);
  const quotes=new FakeQuotes();
  const worker=new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind,'failed');
  assert.deepEqual(services.qualification.calls,[historical]);
  assert.deepEqual(operations,['fail']);
  assert.deepEqual(repository.failures[0]?.failure,{
    code:'RPC_TRANSIENT',retryable:true,terminalResult:null,
  });
  assert.equal(services.candidates.calls.length,0);
  assert.equal(quotes.calls,0);
  assert.equal(repository.stages.length,0);
  assert.equal(repository.completions.length,0);
});

void test('defers a staged BUY_PENDING open when current qualification is invalid',async()=>{
  const operations:string[]=[];
  const repository=new FakeRepository([claim()],operations);
  const candidate=tradingCandidate('ELIGIBLE');
  const historical=canonicalQualification();
  const invalid=canonicalQualification();
  const session=createPaperStrategySession({
    candidate,state:'BUY_PENDING',reasonCode:'QUALIFIED_ENTRY',positionId:null,
    entryCursor:candidate.asOf.cursor,externalBuyTarget:10,externalBuyCount:0,
    countedTradeIds:[],lastCountedCursor:null,minimumConfirmation:'confirmed',
    lastQuote:candidate.buyQuote,lastError:null,createdAtMs:1_000,updatedAtMs:1_000,
    purgeAfterMs:14_401_000,
  });
  repository.snapshotValue=snapshot({
    currentQualification:invalid,currentCandidate:candidate,currentSession:session,
    activePosition:null,currentDecision:Object.freeze({
      qualification:historical,candidateEvent:event('TradingCandidateUpdated','evt_candidate'),
    }),
  });
  const services=fakeServices('ELIGIBLE',operations);
  services.qualification.rejected=invalid;
  const quotes=new FakeQuotes();
  const worker=new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind,'failed');
  assert.deepEqual(services.qualification.calls,[historical,invalid]);
  assert.deepEqual(operations,['fail']);
  assert.deepEqual(repository.failures[0]?.failure,{
    code:'RPC_TRANSIENT',retryable:true,terminalResult:null,
  });
  assert.equal(services.candidates.calls.length,0);
  assert.equal(quotes.calls,0);
  assert.equal(repository.stages.length,0);
  assert.equal(repository.completions.length,0);
});

void test('resumes a staged BUY_PENDING open when its qualification is still current',async()=>{
  const operations:string[]=[];
  const repository=new FakeRepository([claim()],operations);
  const candidate=tradingCandidate('ELIGIBLE');
  const current=canonicalQualification();
  const session=createPaperStrategySession({
    candidate,state:'BUY_PENDING',reasonCode:'QUALIFIED_ENTRY',positionId:null,
    entryCursor:candidate.asOf.cursor,externalBuyTarget:10,externalBuyCount:0,
    countedTradeIds:[],lastCountedCursor:null,minimumConfirmation:'confirmed',
    lastQuote:candidate.buyQuote,lastError:null,createdAtMs:1_000,updatedAtMs:1_000,
    purgeAfterMs:14_401_000,
  });
  repository.snapshotValue=snapshot({
    currentQualification:current,currentCandidate:candidate,currentSession:session,
    activePosition:null,currentDecision:Object.freeze({
      qualification:current,candidateEvent:event('TradingCandidateUpdated','evt_candidate'),
    }),
  });
  const services=fakeServices('ELIGIBLE',operations);
  const quotes=new FakeQuotes();
  const worker=new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind,'completed');
  assert.deepEqual(services.qualification.calls,[current,current]);
  assert.equal(services.candidates.calls.length,0);
  assert.equal(quotes.calls,0);
  assert.deepEqual(operations,['stage','open','complete']);
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

void test('retracts a later paper session when its launch becomes orphaned', async () => {
  const operations: string[] = [];
  const repository = new FakeRepository([claim()],operations);
  const candidate = tradingCandidate('ELIGIBLE',Object.freeze({
    slot:11n,transactionIndex:0,instructionIndex:2,innerInstructionIndex:null,
  }));
  const session = createPaperStrategySession({
    candidate,state:'WAITING_EXTERNAL_BUYS',reasonCode:'QUALIFIED_ENTRY',positionId:POSITION.id,
    entryCursor:candidate.asOf.cursor,externalBuyTarget:10,externalBuyCount:0,
    countedTradeIds:[],lastCountedCursor:null,minimumConfirmation:'confirmed',
    lastQuote:candidate.buyQuote,lastError:null,createdAtMs:2_000,updatedAtMs:2_000,
    purgeAfterMs:14_402_000,
  });
  const persistedPosition=Object.freeze({
    ...POSITION,entryDecisionAtMs:450,entryDecisionJobId:'persisted-paper-job',
  });
  repository.snapshotValue=snapshot({
    asOfEvent:event('TokenLaunchDetected','evt_source','orphaned'),
    canonicalLaunchActive:false,currentQualification:null,currentCandidate:candidate,
    currentSession:session,activePosition:persistedPosition,
    currentDecision:persistedDecision(candidate,'orphaned'),
  });
  const services=fakeServices('ELIGIBLE',operations);
  const worker=new PaperDecisionWorker(
    repository,new FakeQuotes(),services.qualification,services.candidates,services.strategy,
    options(),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind,'completed');
  assert.ok(operations.includes('reconcile-source'));
  assert.equal(operations.includes('reconcile-evidence'),false);
  assert.equal(services.strategy.reconcileSourceInputs[0]?.entryDecisionAtMs,450);
  assert.equal(services.strategy.reconcileSourceInputs[0]?.entryDecisionJobId,'persisted-paper-job');
  assert.equal(repository.completions[0]?.result.session?.state,'PAPER_RETRACTED');
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

void test('reconciles a finalized creation close without requesting another quote or trade', async () => {
  const repository = new FakeRepository([claim()]);
  const candidate = Object.freeze({
    ...tradingCandidate('ELIGIBLE'),
    strategy:Object.freeze({ id:'creation-entry-v1',version:1 }),
  });
  const quotes = new FakeQuotes();
  const reconciled: PaperPosition[] = [];
  const closedPosition = Object.freeze({
    ...POSITION,strategy:candidate.strategy,status:'PAPER_CLOSED' as const,
    remainingBaseRaw:0n,quoteProceedsRaw:1_100n,grossPnlQuoteRaw:100n,netPnlQuoteRaw:100n,
    exitTradeId:'exit',closeCommandHash:'close',closeEventId:'close-event',exitTriggerAtMs:1_500,
    closedAtMs:2_000,purgeAfterMs:14_402_000,
  });
  const ledger = {
    async open(): Promise<never> { throw new Error('not called'); },
    async reconcileOpen(): Promise<never> { throw new Error('not called'); },
    async close(): Promise<never> { throw new Error('not called'); },
    async retract(): Promise<never> { throw new Error('not called'); },
    async reconcileClose(_positionId:string,trigger:DomainEvent):Promise<PaperPosition>{
      if (trigger.id !== 'close-trigger') {
        throw new PaperTradingError('CLOSE_TRIGGER_MISMATCH','unrelated terminal event');
      }
      reconciled.push(closedPosition);return closedPosition;
    },
  };
  const creation = new CreationEntryV1Strategy(ledger,quotes,{
    retentionMs:14_400_000,externalMinimumBuyAmountRaw:1n,
  });
  const prepared = creation.prepare(candidate,{
    externalBuyTarget:10,minimumConfirmation:'confirmed',nowMs:1_000,
  });
  assert.ok(prepared);
  const session = Object.freeze({
    ...prepared,state:'PAPER_CLOSED' as const,reasonCode:'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED' as const,
    positionId:closedPosition.id,externalBuyCount:10,
    countedTradeIds:Object.freeze(Array.from({ length:10 },(_,index) => `trade-${index}`)),
    countedBuyerWallets:Object.freeze(Array.from({ length:10 },(_,index) => `wallet-${index}`)),
    lastQuote:quote('sell','MINT','SOL',900n,1_100n,1_100n),
    updatedAtMs:2_000,purgeAfterMs:14_402_000,
  });
  repository.snapshotValue=snapshot({
    asOfEvent:event('BondingCurveTradeObserved','close-trigger','finalized'),
    currentCandidate:candidate,currentSession:session,activePosition:closedPosition,
    currentDecision:persistedDecision(candidate),
  });
  const services = fakeServices('ELIGIBLE');
  const worker = new PaperDecisionWorker(
    repository,quotes,services.qualification,services.candidates,
    createPaperDecisionStrategyRegistry({
      activeStrategyId:'creation-entry-v1',
      legacy:new ValidatedExternalBuysStrategy(ledger,quotes,{ retentionMs:14_400_000 }),
      creation,
    }),options(),new ManualScheduler(),
  );

  assert.equal((await worker.runOnce()).kind,'completed');
  assert.equal(reconciled.length,1);
  assert.equal(quotes.calls,0);
  assert.equal(repository.completions[0]?.result.session,session);

  const unrelatedRepository = new FakeRepository([claim()]);
  unrelatedRepository.snapshotValue=snapshot({
    asOfEvent:event('BondingCurveTradeObserved','unrelated-trigger','finalized'),
    currentCandidate:candidate,currentSession:session,activePosition:closedPosition,
    currentDecision:persistedDecision(candidate),
  });
  const unrelatedWorker = new PaperDecisionWorker(
    unrelatedRepository,quotes,services.qualification,services.candidates,
    createPaperDecisionStrategyRegistry({
      activeStrategyId:'creation-entry-v1',
      legacy:new ValidatedExternalBuysStrategy(ledger,quotes,{ retentionMs:14_400_000 }),
      creation,
    }),options(),new ManualScheduler(),
  );
  assert.equal((await unrelatedWorker.runOnce()).kind,'completed');
  assert.equal(unrelatedRepository.failures.length,0);
  assert.equal(reconciled.length,1);
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

void test('wakes active creation sessions once before normal claims when kill switch is set', async () => {
  const repository = new FakeRepository([null, null]);
  const services = fakeServices('ELIGIBLE');
  const worker = new PaperDecisionWorker(
    repository, new FakeQuotes(), services.qualification, services.candidates, services.strategy,
    options({ manualKillSwitch: true }), new ManualScheduler(),
  );

  await worker.runOnce();
  await worker.runOnce();

  assert.equal(repository.activeSessionWakeups, 1);
  assert.equal(repository.claimCalls, 2);
});

class FakeRepository implements PaperDecisionRepository {
  public readonly stages: PaperDecisionResult[] = [];
  public readonly completions: { readonly result:PaperDecisionResult }[] = [];
  public readonly failures: { readonly failure:PaperDecisionFailure }[] = [];
  public renewResult = true;
  public noopCompletions = 0;
  public obsoleteCompletions = 0;
  public activeSessionWakeups = 0;
  public claimCalls = 0;
  public snapshotValue: PaperDecisionSnapshot = snapshot();
  public constructor(
    private readonly claims: (ClaimedPaperDecisionJob|null)[],
    private readonly operations: string[] = [],
  ) {}
  public async enqueue(_input: PaperDecisionJobInput): Promise<void> {}
  public async enqueueActiveSessions(): Promise<number> {
    this.activeSessionWakeups += 1;
    return 0;
  }
  public async claim(): Promise<ClaimedPaperDecisionJob|null> {
    this.claimCalls += 1;
    return this.claims.shift() ?? null;
  }
  public async renew(): Promise<boolean> { return this.renewResult; }
  public async loadSnapshot(): Promise<PaperDecisionSnapshot> { return this.snapshotValue; }
  public async stageDecision(_job:ClaimedPaperDecisionJob,result:PaperDecisionResult): Promise<void> {
    this.operations.push('stage'); this.stages.push(result);
  }
  public async complete(_job:ClaimedPaperDecisionJob,result:PaperDecisionResult): Promise<void> {
    this.operations.push('complete'); this.completions.push({ result });
  }
  public async completeNoop(): Promise<void> {
    this.operations.push('complete-noop'); this.noopCompletions += 1;
  }
  public async completeObsolete(): Promise<void> {
    this.operations.push('complete-obsolete'); this.obsoleteCompletions += 1;
  }
  public async fail(_job:ClaimedPaperDecisionJob,failure:PaperDecisionFailure): Promise<void> {
    this.operations.push('fail'); this.failures.push({ failure });
  }
  public async counts(): Promise<PaperDecisionQueueCounts> {
    return Object.freeze({ pending:0,processing:0,retryableFailed:0,exhausted:0 });
  }
}

class FakeQuotes {
  public calls = 0;
  public error: PaperQuoteError|null = null;
  public constructor(private readonly operations:string[]=[]){ }
  public async quote(request: { readonly side:'BUY'|'SELL'; readonly amountInRaw:bigint }): Promise<PaperExecutionQuote> {
    this.operations.push('quote');
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
    calls:[] as Parameters<ConstructorParameters<typeof PaperDecisionWorker>[3]['create']>[0][],
    gate:Promise.resolve(),
    beforeCreate:()=>undefined,
    async create(input: Parameters<ConstructorParameters<typeof PaperDecisionWorker>[3]['create']>[0]) {
      this.beforeCreate();
      this.calls.push(input); await this.gate; return candidateResult;
    },
  };
  const strategy = {
    openError:null as Error|null,
    recoverOpenInputs:[] as Readonly<{
      readonly entryDecisionAtMs?:number;
      readonly entryDecisionJobId?:string;
    }>[],
    reconcileSourceInputs:[] as Readonly<{
      readonly entryDecisionAtMs?:number;
      readonly entryDecisionJobId?:string;
    }>[],
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
      if(this.openError!==null)throw this.openError;
      return Object.freeze({
        session:Object.freeze({ ...input.session,state:'WAITING_EXTERNAL_BUYS' as const,positionId:'position' }),
        sessionEvent:event('PaperStrategySessionUpdated','evt_session_open'),
        countedExternalBuys:Object.freeze([]),requestedAction:'OPEN' as const,position:POSITION,
      });
    },
    async recoverOpen(input: {
      readonly session: ReturnType<typeof createPaperStrategySession>;
      readonly entryDecisionAtMs?:number;
      readonly entryDecisionJobId?:string;
    }) {
      operations.push('recover-open');
      this.recoverOpenInputs.push(input);
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
    async reconcileSource(input: {
      readonly session:ReturnType<typeof createPaperStrategySession>;
      readonly entryDecisionAtMs?:number;
      readonly entryDecisionJobId?:string;
    }) {
      operations.push('reconcile-source');
      this.reconcileSourceInputs.push(input);
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
  const qualification = {
    calls:[] as CanonicalQualificationProjection[],
    rejected:null as CanonicalQualificationProjection|null,
    beforeReauthorize:()=>undefined,
    authorizedReport:rebuilt.report,
    reauthorize(projection:CanonicalQualificationProjection) {
      this.beforeReauthorize();
      this.calls.push(projection);
      if(projection===this.rejected)throw new TypeError('invalid qualification');
      return Object.freeze({
        ...rebuilt,reportId:'qreport_authorized',reportEventId:'evt_authorized',
        evidenceFingerprint:'e'.repeat(64),event:event('QualificationUpdated','evt_authorized'),
      });
    },
  };
  return { qualification,candidates,strategy };
}

function options(overrides: Partial<ConstructorParameters<typeof PaperDecisionWorker>[5]> = {}) {
  return Object.freeze({
    executionMode:'paper' as const,paperStrategyEnabled:true,entryQuoteAmountRaw:1_000n,
    quoteMintAllowlist:Object.freeze(['SOL']),
    slippageBps:100n,externalBuyTarget:10,minimumConfirmation:'confirmed' as const,
    maximumRoundTripLossBps:3_000n,pollIntervalMs:100,leaseMs:10_000,
    renewalIntervalMs:1_000,shutdownTimeoutMs:100,manualKillSwitch:false,...overrides,
  });
}

function claim(): ClaimedPaperDecisionJob {
  return Object.freeze({
    jobId:'paper-job',mint:'MINT',sourceEventId:'evt_source',sourceRawEventId:'raw_source',
    sourceConfirmationStatus:'confirmed',inputFingerprint:'a'.repeat(64),attempts:1,
    maxAttempts:3,leaseToken:'lease',leaseExpiresAtMs:11_000,createdAtMs:500,
  });
}

function snapshot(overrides: Partial<PaperDecisionSnapshot> = {}): PaperDecisionSnapshot {
  const asOfEvent=event('TokenLaunchDetected','evt_source');
  return Object.freeze({
    mint:'MINT',asOfEvent,canonicalLaunchActive:true,hasPaperLineage:false,
    launchDetectedAtMs:1_000,launchConfirmationStatus:'confirmed',launch:Object.freeze({
      mint:'MINT',creator:'creator',tokenProgram:'SPL_TOKEN' as const,
      quoteAssets:Object.freeze([Object.freeze({ mint:'SOL',decimals:9,tokenProgram:'SPL_TOKEN' as const })]),
      launchpad:'pumpfun',createdAt:asOfEvent.cursor,parameters:Object.freeze({}),
    }),metadata:null,social:null,creatorProfile:null,holderSnapshot:null,walletGraph:null,
    activeLaunchTrades:Object.freeze([]),activeMarketTrades:Object.freeze([]),
    currentQualification:canonicalQualification(),currentCandidate:null,currentDecision:null,
    currentSession:null,activePosition:null,...overrides,
  });
}

function tradingCandidate(
  state:'ELIGIBLE'|'NOT_ELIGIBLE',
  cursor:ChainCursor=Object.freeze({
    slot:10n,transactionIndex:0,instructionIndex:1,innerInstructionIndex:null,
  }),
) {
  return createTradingCandidate({
    mint:'MINT',strategy:Object.freeze({ id:'validated-external-buys',version:1 }),
    qualificationReportId:`qreport_${'b'.repeat(64)}`,qualificationProfile:Object.freeze({
      id:'profile',version:1,fingerprint:'c'.repeat(64),
    }),evidenceFingerprint:'d'.repeat(64),asOfEvent:Object.freeze({
      ...event('QualificationUpdated','evt_qualification'),cursor,
    }),
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
  _candidate: ReturnType<typeof tradingCandidate>,
  confirmationStatus: 'confirmed' | 'orphaned' = 'confirmed',
) {
  return Object.freeze({
    qualification:canonicalQualification(confirmationStatus),
    candidateEvent:event('TradingCandidateUpdated','evt_candidate',confirmationStatus),
  });
}

function canonicalQualification(
  confirmationStatus: 'confirmed' | 'orphaned' = 'confirmed',
): CanonicalQualificationProjection {
  const qualificationEvent=event('QualificationUpdated','evt_qualification',confirmationStatus);
  const evaluation=Object.freeze({
    evaluatedAtMs:1_000,signals:Object.freeze({}),blockers:Object.freeze([]),
    calibrationFacts:null,
  });
  const qualificationReport=report();
  return Object.freeze({
    reportId:`qreport_${'b'.repeat(64)}`,sourceEventId:'evt_source',
    sourceRawEventId:'raw_source',evidenceFingerprint:'d'.repeat(64),
    evaluation,report:qualificationReport,
    qualificationEvent:Object.freeze({
      ...qualificationEvent,source:'qualification',payload:Object.freeze({
        reportId:`qreport_${'b'.repeat(64)}`,evidenceFingerprint:'d'.repeat(64),
        evaluation,report:qualificationReport,
      }),
    }),
  });
}

function realCanonicalQualification(
  service:QualificationRebuildService,
):CanonicalQualificationProjection{
  const paper=snapshot();
  const rebuilt=service.rebuild({
    snapshot:Object.freeze({
      mint:paper.mint,asOfEvent:paper.asOfEvent,launch:paper.launch,
      metadata:paper.metadata,social:paper.social,creatorProfile:paper.creatorProfile,
      holderSnapshot:null,walletGraph:paper.walletGraph,
    }),buyQuote:undefined,reverseSellQuote:undefined,
  });
  return Object.freeze({
    reportId:rebuilt.reportId,sourceEventId:paper.asOfEvent.id,
    sourceRawEventId:'raw_source',evidenceFingerprint:rebuilt.evidenceFingerprint,
    evaluation:rebuilt.evaluation,report:rebuilt.report,qualificationEvent:rebuilt.event,
  });
}

function canonicalTamperingCases():readonly Readonly<{
  name:string;
  mutate:(value:CanonicalQualificationProjection)=>CanonicalQualificationProjection;
}>[]{
  return [
    { name:'evaluation',mutate:(value)=>({
      ...value,evaluation:{ ...value.evaluation,evaluatedAtMs:value.evaluation.evaluatedAtMs+1 },
    }) },
    { name:'report',mutate:(value)=>({
      ...value,report:{ ...value.report,verdict:'REJECTED' },
    }) },
    { name:'profile',mutate:(value)=>({
      ...value,report:{
        ...value.report,ruleSet:{ ...value.report.ruleSet,fingerprint:'f'.repeat(64) },
      },
    }) },
    { name:'report id',mutate:(value)=>({ ...value,reportId:`qreport_${'f'.repeat(64)}` }) },
    { name:'event id',mutate:(value)=>({
      ...value,qualificationEvent:{ ...value.qualificationEvent,id:'evt_tampered' },
    }) },
    { name:'fingerprint',mutate:(value)=>({ ...value,evidenceFingerprint:'f'.repeat(64) }) },
  ];
}

function event(
  type:DomainEvent['type'],
  id:string,
  confirmationStatus: 'confirmed' | 'finalized' | 'orphaned' = 'confirmed',
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
