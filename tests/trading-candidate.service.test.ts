import assert from 'node:assert/strict';
import test from 'node:test';
import type { DomainEvent } from '../src/domain/events.js';
import type { PaperExecutionQuote } from '../src/domain/paper-trading.js';
import type { QualificationReport } from '../src/domain/qualification.js';
import type { PaperDecisionSnapshot } from '../src/ports/paper-decision-repository.js';
import { TradingCandidateService } from '../src/application/trading-candidate.service.js';

void test('creates the same eligible candidate on replay inside the window', () => {
  const service = candidateService();
  const input = candidateInput();
  const first = service.create(input);
  const second = service.create(input);

  assert.equal(first.candidate.state, 'ELIGIBLE');
  assert.deepEqual(first.candidate.reasonCodes, ['QUALIFIED_ENTRY']);
  assert.equal(first.candidate.id, second.candidate.id);
  assert.equal(first.event.id, second.event.id);
  assert.equal(first.candidate.eligibleUntilMs, 46_000);
});

void test('expires the opportunity, rejects unsupported quote mints and revokes orphaned input', () => {
  const service = candidateService();
  assert.deepEqual(service.create(candidateInput({ nowMs: 46_001 })).candidate.reasonCodes, ['ENTRY_WINDOW_EXPIRED']);
  assert.equal(service.create(candidateInput({ nowMs: 46_001 })).candidate.state, 'EXPIRED');
  assert.equal(service.create(candidateInput({
    quoteAsset: Object.freeze({ mint: 'USDC', decimals: 6, tokenProgram: 'SPL_TOKEN' }),
  })).candidate.state, 'NOT_ELIGIBLE');
  assert.deepEqual(service.create(candidateInput({
    qualificationEvent: event({
      id:'evt_qualification_orphaned',type:'QualificationUpdated',confirmationStatus:'orphaned',
    }),
  })).candidate.reasonCodes, ['SOURCE_ORPHANED']);
});

void test('requires a qualified report, minimum finality and two fresh coherent quotes', () => {
  const service = candidateService();
  assert.equal(service.create(candidateInput({ report: report('WATCHLISTED') })).candidate.state, 'NOT_ELIGIBLE');
  assert.equal(service.create(candidateInput({
    qualificationEvent:event({
      id:'evt_qualification_processed',type:'QualificationUpdated',confirmationStatus:'processed',
    }),
  })).candidate.state, 'NOT_ELIGIBLE');
  assert.equal(service.create(candidateInput({ reverseSellQuote: null })).candidate.state, 'NOT_ELIGIBLE');
  assert.equal(service.create(candidateInput({
    buyQuote: quote('buy', 'SOL', 'MINT', 1_000n, 900n, 900n, 1),
    nowMs: 6_000,
  })).candidate.state, 'NOT_ELIGIBLE');
});

void test('rejects a processed canonical qualification selected by an older confirmed job', () => {
  const result = candidateService().create(candidateInput({
    snapshot:snapshot({ asOfEvent:event({ confirmationStatus:'confirmed' }) }),
    qualificationEvent:event({
      id:'evt_qualification_processed',type:'QualificationUpdated',
      confirmationStatus:'processed',
    }),
  }));

  assert.equal(result.candidate.state,'NOT_ELIGIBLE');
  assert.equal(result.candidate.asOf.eventId,'evt_qualification_processed');
  assert.equal(result.candidate.asOf.confirmationStatus,'processed');
});

void test('accepts a confirmed canonical qualification selected by an older processed job', () => {
  const result = candidateService().create(candidateInput({
    snapshot:snapshot({ asOfEvent:event({ confirmationStatus:'processed' }) }),
    qualificationEvent:event({
      id:'evt_qualification_confirmed',type:'QualificationUpdated',
      confirmationStatus:'confirmed',
    }),
  }));

  assert.equal(result.candidate.state,'ELIGIBLE');
  assert.equal(result.candidate.asOf.eventId,'evt_qualification_confirmed');
  assert.equal(result.candidate.asOf.confirmationStatus,'confirmed');
});

function candidateService(): TradingCandidateService {
  return new TradingCandidateService({
    strategy: Object.freeze({ id: 'validated-external-buys', version: 1 }),
    quoteMintAllowlist: Object.freeze(['SOL']), minimumConfirmation: 'confirmed',
    entryWindowMs: 45_000, maximumQuoteAgeMs: 5_000, maximumQuoteSlotLag: 32n,
    retentionMs: 14_400_000,
  });
}

function candidateInput(overrides: Partial<Parameters<TradingCandidateService['create']>[0]> = {}) {
  return {
    snapshot: snapshot(), report: report('QUALIFIED'), reportId: `qreport_${'a'.repeat(64)}`,
    qualificationEvent: event({ id: 'evt_qualification', type: 'QualificationUpdated' }),
    evidenceFingerprint: 'b'.repeat(64),
    quoteAsset: Object.freeze({ mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' as const }),
    buyQuote: quote('buy', 'SOL', 'MINT', 1_000n, 900n, 900n, 1_000),
    reverseSellQuote: quote('sell', 'MINT', 'SOL', 900n, 820n, 800n, 1_000),
    nowMs: 1_000,
    ...overrides,
  };
}

function snapshot(overrides: Partial<PaperDecisionSnapshot> = {}): PaperDecisionSnapshot {
  const asOfEvent = event();
  return Object.freeze({
    mint:'MINT',asOfEvent,canonicalLaunchActive:true,hasPaperLineage:false,launch:Object.freeze({
      mint:'MINT',creator:'creator',tokenProgram:'SPL_TOKEN' as const,
      quoteAssets:Object.freeze([Object.freeze({ mint:'SOL',decimals:9,tokenProgram:'SPL_TOKEN' as const })]),
      launchpad:'pumpfun',createdAt:Object.freeze({ ...asOfEvent.cursor }),parameters:Object.freeze({}),
    }),metadata:null,social:null,creatorProfile:null,holderSnapshot:null,walletGraph:null,
    activeLaunchTrades:Object.freeze([]),activeMarketTrades:Object.freeze([]),
    currentQualification:null,currentCandidate:null,currentDecision:null,
    currentSession:null,activePosition:null,...overrides,
  });
}

function event(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return Object.freeze({
    id:'evt_source',type:'TokenLaunchDetected' as const,mint:'MINT',source:'pumpfun',program:'pump',
    signature:'signature',cursor:Object.freeze({ slot:10n,transactionIndex:0,instructionIndex:1,innerInstructionIndex:null }),
    confirmationStatus:'confirmed' as const,blockchainTimeMs:900,observedAtMs:1_000,
    payloadVersion:1,payload:Object.freeze({}),...overrides,
  });
}

function report(verdict: QualificationReport['verdict']): QualificationReport {
  const score = Object.freeze({ score: 100, maximum: 100 });
  return Object.freeze({
    ruleSet:Object.freeze({ id:'pumpfun-v1-initial',version:1,status:'UNVALIDATED_RULE_SET',minimumTotalScore:60,fingerprint:'c'.repeat(64) }),
    scores:Object.freeze({ preparation:score,socialAuthenticity:score,onchainHealth:score,total:score }),
    evidence:Object.freeze([]),conditions:Object.freeze([]),blockers:Object.freeze([]),verdict,evaluatedAtMs:1_000,
  });
}

function quote(
  id:string,inputMint:string,outputMint:string,amountInRaw:bigint,
  amountOutRaw:bigint,minimumAmountOutRaw:bigint,observedAtMs:number,
): PaperExecutionQuote {
  return Object.freeze({
    id,inputMint,outputMint,amountInRaw,amountOutRaw,minimumAmountOutRaw,feesRaw:1n,
    slippageBps:100n,priceImpactBps:10n,observedAtMs,observedSlot:10n,
  });
}
