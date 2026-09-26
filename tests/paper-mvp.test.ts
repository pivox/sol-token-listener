import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPaperMvpPositionSample,
  createPaperMvpReport,
  createPaperMvpOneShotReport,
  type PaperMvpReportV1,
} from '../src/domain/paper-mvp.js';
import { paperMvpCycleEvidence } from './fixtures/paper-mvp-cycle-evidence.js';

void test('creates an exact causal sample and applies both network fees', () => {
  const value = createPaperMvpPositionSample(sampleInput());

  assert.equal(value.modelNetPnlRaw, 190n);
  assert.equal(value.detectionToEntryLatencyMs, 30);
  assert.equal(value.exitTriggerToSellLatencyMs, 20);
  assert.equal(Object.isFrozen(value), true);
});

void test('rejects retrospective or future entry and exit quotes', () => {
  for (const override of [
    { entryDecisionAtMs: 121, entryQuoteAtMs: 120 },
    { entryQuoteAtMs: 131, paperBuyAtMs: 130 },
    { exitTriggerAtMs: 201, exitQuoteAtMs: 200 },
    { exitQuoteAtMs: 221, paperSellAtMs: 220 },
  ]) assert.throws(() => createPaperMvpPositionSample(sampleInput(override)), /time|causal/iu);
});

void test('builds a deterministic PASS report with integer rates and provider usage', () => {
  const samples = Array.from({ length: 50 }, (_, index) => createPaperMvpPositionSample(sampleInput({
    positionId: `position-${index}`,
    mint: `mint-${index}`,
    paperSellAtMs: 220 + index,
  })));
  const report = createPaperMvpReport({
    runId: 'paper_mvp_run_1',
    completionReason: 'TARGET_REACHED',
    startedAtMs: 100,
    completedAtMs: 1_000,
    targetClosedPositions: 50,
    initialCapitalRaw: 10_000n,
    quoteMint: 'SOL',
    creationsObserved: 60,
    entriesRejected: 10,
    samples,
    unknownTerminalPositions: 0,
    duplicateLogicalBuys: 0,
    duplicateLogicalSells: 0,
    providerUsage: {
      status: 'AVAILABLE', creditsUsedStart: 100n, creditsUsedEnd: 200n, rateLimitedCount: 0,
    },
  });

  assert.equal(report.schemaVersion, 'paper-mvp.v2');
  assert.equal(report.completionReason, 'TARGET_REACHED');
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.closedPositions, 50);
  assert.equal(report.netPnlRaw, '9500');
  assert.equal(report.meanNetPnlRaw, '190');
  assert.equal(report.winRateBps, 10_000);
  assert.equal(report.maximumDrawdownBps, 0);
  assert.equal(report.creditsPerClosedPositionRaw, '2');
  assert.deepEqual(report.exitCounts, { '10_UNIQUE_BUYERS': 50, '2X': 0, SAFETY: 0 });
});

void test('keeps the historical paper-mvp.v1 type free of v2-only metrics', () => {
  const historical: PaperMvpReportV1 = Object.freeze({
    schemaVersion:'paper-mvp.v1',runId:'legacy-run',completionReason:'LEGACY',
    startedAt:'2026-08-27T00:00:00.000Z',completedAt:'2026-08-27T00:01:00.000Z',
    technicalStatus:'COMPLETED',verdict:'PASS',targetClosedPositions:1,closedPositions:1,
    creationsObserved:1,entriesRejected:0,
    exitCounts:Object.freeze({ '10_UNIQUE_BUYERS':1,'2X':0,SAFETY:0 }),
    grossPnlRaw:'1',netPnlRaw:'1',meanNetPnlRaw:'1',winRateBps:10_000,
    maximumDrawdownBps:0,detectionToEntryLatencyMeanMs:1,detectionToEntryLatencyP95Ms:1,
    venueFeesRaw:'0',networkFeesRaw:'0',unknownTerminalPositions:0,
    duplicateLogicalBuys:0,duplicateLogicalSells:0,creditsUsedStartRaw:'0',
    creditsUsedEndRaw:'1',creditsPerClosedPositionRaw:'1',rateLimitedCount:0,
    failedGateCodes:Object.freeze([]),
  });

  assert.equal('openedPositions' in historical,false);
  assert.equal('averageBuySlippageBps' in historical,false);
});

void test('reports a completed one-shot cycle for configurable N independently of profitability', () => {
  const report = createPaperMvpOneShotReport({
    runId: 'paper_mvp_run_one_shot', completionReason: 'TARGET_REACHED',
    startedAtMs: 100, completedAtMs: 1_000, targetClosedPositions: 1,
    initialCapitalRaw: 10_000n, quoteMint: 'SOL', creationsObserved: 1,
    entriesRejected: 0, openedPositions: 1, openPositions: 0,
    samples: [createPaperMvpPositionSample(sampleInput({
      sellAmountOutRaw: 800n, sellMinimumAmountOutRaw: 780n,
    }))],
    unknownTerminalPositions: 0, duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
    providerUsage: {
      status: 'AVAILABLE', creditsUsedStart: 10n, creditsUsedEnd: 11n, rateLimitedCount: 0,
    },
    maxDurationMs: 60_000,
    externalUniqueBuyersTarget: 3,
    qualificationProfileFingerprint: 'a'.repeat(64),
    causalEvidence: paperMvpCycleEvidence(),
  });

  assert.equal(report.schemaVersion, 'paper-mvp.v3');
  assert.equal(report.historicalCampaignReport.schemaVersion, 'paper-mvp.v2');
  assert.equal(report.historicalCampaignReport.verdict, 'FAIL');
  assert.equal(report.oneShotCycle.functionalStatus, 'COMPLETED');
  assert.deepEqual(report.oneShotCycle.failedGateCodes, []);
  assert.equal(report.oneShotCycle.profitability.status, 'LOSS');
  assert.equal(report.oneShotCycle.profitability.netPnlRaw, '-230');
  assert.equal(report.oneShotCycle.externalUniqueBuyers.target, 3);
  assert.equal(report.oneShotCycle.externalUniqueBuyers.thresholdReached, true);
  assert.equal(report.oneShotCycle.logicalBuyCount, 1);
  assert.equal(report.oneShotCycle.logicalSellCount, 1);
  assert.equal(report.oneShotCycle.finalState, 'PAPER_CLOSED');
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.oneShotCycle.cycle?.mint, 'mint-1');
  assert.equal(report.oneShotCycle.cycle?.entryCostRaw, '1000');
  assert.equal(report.oneShotCycle.cycle?.quotedExitAmountRaw, '800');
  assert.equal(report.oneShotCycle.cycle?.exitProceedsRaw, '780');
  assert.equal(report.oneShotCycle.cycle?.venueFeesRaw, '10');
  assert.equal(report.oneShotCycle.cycle?.networkFeesRaw, '10');
  assert.deepEqual(report.boundedRun, {
    targetClosedPositions: 1,
    maximumActivePositions: 1,
    maxDurationMs: 60_000,
    externalUniqueBuyersTarget: 3,
  });
  assert.equal('exitCounts' in report, false);
  assert.deepEqual(report.exitOutcomes, {
    externalUniqueBuyersTargetReached: 1,
    takeProfitReached: 0,
    safetyExit: 0,
  });
});

void test('fails a one-shot cycle whose launch predates the inclusive run boundary', () => {
  const input = {
    runId: 'paper_mvp_run_boundary', completionReason: 'TARGET_REACHED' as const,
    startedAtMs: 100, completedAtMs: 1_000, targetClosedPositions: 1,
    initialCapitalRaw: 10_000n, quoteMint: 'SOL', creationsObserved: 1,
    entriesRejected: 0, openedPositions: 1, openPositions: 0,
    unknownTerminalPositions: 0, duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
    providerUsage: {
      status: 'AVAILABLE' as const, creditsUsedStart: 10n, creditsUsedEnd: 11n,
      rateLimitedCount: 0,
    },
    maxDurationMs: 60_000,
    externalUniqueBuyersTarget: 3,
    qualificationProfileFingerprint: 'a'.repeat(64),
    causalEvidence: paperMvpCycleEvidence(),
  };
  const atBoundary = createPaperMvpOneShotReport({
    ...input,
    samples: [createPaperMvpPositionSample(sampleInput({ creationDetectedAtMs: 100 }))],
  });
  const beforeBoundary = createPaperMvpOneShotReport({
    ...input,
    samples: [createPaperMvpPositionSample(sampleInput({ creationDetectedAtMs: 99 }))],
  });

  assert.equal(atBoundary.oneShotCycle.functionalStatus, 'COMPLETED');
  assert.deepEqual(atBoundary.oneShotCycle.failedGateCodes, []);
  assert.equal(beforeBoundary.oneShotCycle.functionalStatus, 'INCOMPLETE');
  assert.deepEqual(beforeBoundary.oneShotCycle.failedGateCodes, ['CREATION_PRECEDES_RUN']);
  assert.equal(beforeBoundary.technicalStatus, 'DEGRADED');
  assert.equal(beforeBoundary.verdict, 'FAIL');
  assert.equal(beforeBoundary.historicalCampaignReport.verdict, 'PASS');
});

void test('does not infer counted buyers from the sell reason without exact causal evidence', () => {
  const evidence = paperMvpCycleEvidence();
  const input = {
    runId: 'causal-run', completionReason: 'TARGET_REACHED' as const,
    startedAtMs: 100, completedAtMs: 1_000, targetClosedPositions: 1,
    initialCapitalRaw: 10_000n, quoteMint: 'SOL', creationsObserved: 1,
    entriesRejected: 0, openedPositions: 1, openPositions: 0,
    samples: [createPaperMvpPositionSample(sampleInput())],
    unknownTerminalPositions: 0, duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
    providerUsage: { status: 'AVAILABLE' as const, creditsUsedStart: 1n,
      creditsUsedEnd: 2n, rateLimitedCount: 0 },
    maxDurationMs: 60_000, externalUniqueBuyersTarget: 3,
    qualificationProfileFingerprint: 'a'.repeat(64),
  };
  for (const causalEvidence of [
    null,
    { ...evidence, positionId: 'other-position' },
    { ...evidence, qualification: { ...evidence.qualification, verdict: 'REJECTED' } },
    { ...evidence, qualification: { ...evidence.qualification, blockers: ['STALE_DATA'] } },
    { ...evidence, qualification: { ...evidence.qualification, profileFingerprint: 'b'.repeat(64) } },
    { ...evidence, buy: { ...evidence.buy, quoteId: 'other-quote' } },
    { ...evidence, sell: { ...evidence.sell, tradeId: evidence.buy.tradeId } },
    { ...evidence, externalUniqueBuyers: { ...evidence.externalUniqueBuyers,
      progression: evidence.externalUniqueBuyers.progression.slice(0, 2) } },
    { ...evidence, externalUniqueBuyers: { ...evidence.externalUniqueBuyers,
      progression: evidence.externalUniqueBuyers.progression.map((item) => ({ ...item, wallet: 'same' })) } },
    { ...evidence, externalUniqueBuyers: { ...evidence.externalUniqueBuyers,
      progression: evidence.externalUniqueBuyers.progression.map((item) => ({ ...item,
        cursor: { ...item.cursor, slot: '10' } })) } },
    { ...evidence, externalUniqueBuyers: { ...evidence.externalUniqueBuyers,
      progression: evidence.externalUniqueBuyers.progression.map((item) => ({ ...item,
        confirmationStatus: 'orphaned' })) } },
  ]) {
    const report = createPaperMvpOneShotReport({ ...input, causalEvidence });
    assert.equal(report.oneShotCycle.functionalStatus, 'INCOMPLETE');
    assert.equal(report.oneShotCycle.externalUniqueBuyers.thresholdReached, false);
    assert.equal(report.verdict, 'FAIL');
    assert.equal(report.historicalCampaignReport.verdict, 'PASS');
  }
});

void test('marks a multi-position campaign as incomplete without changing its historical report', () => {
  const samples = [1, 2].map((value) => createPaperMvpPositionSample(sampleInput({
    positionId: `position-${value}`,
    paperSellAtMs: 220 + value,
  })));
  const report = createPaperMvpOneShotReport({
    runId: 'paper_mvp_run_campaign', completionReason: 'TARGET_REACHED',
    startedAtMs: 100, completedAtMs: 1_000, targetClosedPositions: 2,
    initialCapitalRaw: 10_000n, quoteMint: 'SOL', creationsObserved: 2,
    entriesRejected: 0, openedPositions: 2, openPositions: 0, samples,
    unknownTerminalPositions: 0, duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
    providerUsage: {
      status: 'AVAILABLE', creditsUsedStart: 10n, creditsUsedEnd: 12n, rateLimitedCount: 0,
    },
    maxDurationMs: 120_000,
    externalUniqueBuyersTarget: 7,
    qualificationProfileFingerprint: 'b'.repeat(64),
  });

  assert.equal(report.historicalCampaignReport.verdict, 'PASS');
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.technicalStatus, 'DEGRADED');
  assert.equal(report.oneShotCycle.functionalStatus, 'INCOMPLETE');
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.technicalStatus, 'DEGRADED');
  assert.deepEqual(report.oneShotCycle.failedGateCodes, [
    'TARGET_CLOSED_POSITIONS_NOT_ONE',
    'LOGICAL_BUY_COUNT_NOT_ONE',
    'LOGICAL_SELL_COUNT_NOT_ONE',
  ]);
  assert.equal(report.oneShotCycle.cycle, null);
  assert.equal(report.oneShotCycle.profitability.status, 'NOT_AVAILABLE');
});

void test('keeps a safety exit explicit and incomplete when N buyers was not reached', () => {
  const report = createPaperMvpOneShotReport({
    runId: 'paper_mvp_run_safety_exit', completionReason: 'TARGET_REACHED',
    startedAtMs: 100, completedAtMs: 1_000, targetClosedPositions: 1,
    initialCapitalRaw: 10_000n, quoteMint: 'SOL', creationsObserved: 1,
    entriesRejected: 0, openedPositions: 1, openPositions: 0,
    samples: [createPaperMvpPositionSample(sampleInput({
      exitReason: 'CREATOR_EARLY_SELL',
    }))],
    unknownTerminalPositions: 0, duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
    providerUsage: {
      status: 'AVAILABLE', creditsUsedStart: 10n, creditsUsedEnd: 11n, rateLimitedCount: 0,
    },
    maxDurationMs: 60_000,
    externalUniqueBuyersTarget: 3,
    qualificationProfileFingerprint: 'c'.repeat(64),
  });

  assert.equal(report.oneShotCycle.functionalStatus, 'INCOMPLETE');
  assert.deepEqual(report.oneShotCycle.failedGateCodes, [
    'CAUSAL_EVIDENCE_MISSING_OR_INCONSISTENT',
    'EXTERNAL_UNIQUE_BUYERS_TARGET_NOT_REACHED',
  ]);
  assert.equal(report.oneShotCycle.externalUniqueBuyers.thresholdReached, false);
  assert.equal(report.oneShotCycle.cycle?.exitReason, 'CREATOR_EARLY_SELL');
});

void test('reports opened and open positions with floored closed-sample execution means', () => {
  const first = createPaperMvpPositionSample(sampleInput({
    positionId: 'metrics-1', buySlippageBps: 101n, sellSlippageBps: 102n,
    buyPriceImpactBps: 103n, sellPriceImpactBps: 104n,
  }));
  const second = createPaperMvpPositionSample(sampleInput({
    positionId: 'metrics-2', paperSellAtMs: 221, buySlippageBps: 102n, sellSlippageBps: 103n,
    buyPriceImpactBps: 104n, sellPriceImpactBps: 105n,
  }));
  const report = createPaperMvpReport({
    runId: 'paper_mvp_run_metrics', completionReason: 'TARGET_REACHED',
    startedAtMs: 100, completedAtMs: 1_000, targetClosedPositions: 2,
    initialCapitalRaw: 10_000n, quoteMint: 'SOL', creationsObserved: 2,
    entriesRejected: 0, samples: [first, second], openedPositions: 3, openPositions: 1,
    unknownTerminalPositions: 0, duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
    providerUsage: { status: 'AVAILABLE', creditsUsedStart: 0n, creditsUsedEnd: 2n, rateLimitedCount: 0 },
  });

  assert.equal(report.openedPositions, 3);
  assert.equal(report.openPositions, 1);
  assert.equal(report.averageBuySlippageBps, 101);
  assert.equal(report.averageSellSlippageBps, 102);
  assert.equal(report.averageBuyPriceImpactBps, 103);
  assert.equal(report.averageSellPriceImpactBps, 104);
});

void test('reports zero execution means when no closed samples exist', () => {
  const report = createPaperMvpReport({
    runId: 'paper_mvp_run_empty_metrics', completionReason: 'TIMEOUT',
    startedAtMs: 100, completedAtMs: 1_000, targetClosedPositions: 1,
    initialCapitalRaw: 10_000n, quoteMint: 'SOL', creationsObserved: 0,
    entriesRejected: 0, samples: [], openedPositions: 0, openPositions: 0,
    unknownTerminalPositions: 0, duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
    providerUsage: { status: 'UNAVAILABLE', creditsUsedStart: null, creditsUsedEnd: null, rateLimitedCount: 0 },
  });

  assert.deepEqual([
    report.averageBuySlippageBps, report.averageSellSlippageBps,
    report.averageBuyPriceImpactBps, report.averageSellPriceImpactBps,
  ], [0, 0, 0, 0]);
});

void test('maps creator and manual exits directly to the SAFETY report category', () => {
  const samples = ['CREATOR_EARLY_SELL', 'MANUAL_KILL_SWITCH'].map((exitReason, index) => (
    createPaperMvpPositionSample(sampleInput({
      positionId: `safety-${index}`,
      exitReason: exitReason as 'CREATOR_EARLY_SELL' | 'MANUAL_KILL_SWITCH',
      paperSellAtMs: 220 + index,
    }))
  ));
  const report = createPaperMvpReport({
    runId: 'paper_mvp_run_safety', completionReason: 'TARGET_REACHED',
    startedAtMs: 100, completedAtMs: 1_000, targetClosedPositions: 2,
    initialCapitalRaw: 10_000n, quoteMint: 'SOL', creationsObserved: 2,
    entriesRejected: 0, samples, unknownTerminalPositions: 0,
    duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
    providerUsage: {
      status: 'AVAILABLE', creditsUsedStart: 100n, creditsUsedEnd: 102n, rateLimitedCount: 0,
    },
  });

  assert.deepEqual(report.exitCounts, { '10_UNIQUE_BUYERS': 0, '2X': 0, SAFETY: 2 });
});

void test('fails closed on drawdown, unknowns, duplicates, quote mismatch or provider gaps', () => {
  const loss = createPaperMvpPositionSample(sampleInput({
    sellAmountOutRaw: 990n,
    sellMinimumAmountOutRaw: 980n,
  }));
  const failing = createPaperMvpReport({
    runId: 'paper_mvp_run_2', completionReason: 'TARGET_REACHED',
    startedAtMs: 100, completedAtMs: 1_000,
    targetClosedPositions: 1, initialCapitalRaw: 100n, quoteMint: 'SOL',
    creationsObserved: 1, entriesRejected: 0,
    samples: [loss],
    unknownTerminalPositions: 1, duplicateLogicalBuys: 1, duplicateLogicalSells: 1,
    providerUsage: {
      status: 'UNAVAILABLE', creditsUsedStart: null, creditsUsedEnd: null, rateLimitedCount: 1,
    },
  });

  assert.equal(failing.verdict, 'FAIL');
  assert.equal(failing.technicalStatus, 'DEGRADED');
  assert.equal(failing.maximumDrawdownBps, 3_000);
  assert.deepEqual(failing.failedGateCodes, [
    'NET_PNL_NOT_POSITIVE', 'MAX_DRAWDOWN_EXCEEDED', 'UNKNOWN_TERMINAL_POSITIONS',
    'DUPLICATE_LOGICAL_BUYS', 'DUPLICATE_LOGICAL_SELLS', 'PROVIDER_USAGE_UNAVAILABLE',
    'PROVIDER_RATE_LIMITED',
  ]);
});

void test('forces non-target completion to a durable degraded FAIL report', () => {
  const samples = [createPaperMvpPositionSample(sampleInput())];
  for (const reason of ['TIMEOUT', 'SIGINT', 'SIGTERM'] as const) {
    const report = createPaperMvpReport({
      runId: `paper_mvp_run_${reason}`,
      completionReason: reason,
      startedAtMs: 100,
      completedAtMs: 1_000,
      targetClosedPositions: 1,
      initialCapitalRaw: 10_000n,
      quoteMint: 'SOL',
      creationsObserved: 1,
      entriesRejected: 0,
      samples,
      unknownTerminalPositions: 0,
      duplicateLogicalBuys: 0,
      duplicateLogicalSells: 0,
      providerUsage: {
        status: 'AVAILABLE', creditsUsedStart: 100n, creditsUsedEnd: 101n,
        rateLimitedCount: 0,
      },
    });

    assert.equal(report.completionReason, reason);
    assert.equal(report.technicalStatus, 'DEGRADED');
    assert.equal(report.verdict, 'FAIL');
    assert.deepEqual(report.failedGateCodes, [
      reason === 'TIMEOUT' ? 'RUN_TIMED_OUT' : 'RUN_INTERRUPTED',
    ]);
  }
});

void test('keeps legacy report evaluation unchanged while exposing its compatibility reason', () => {
  const report = createPaperMvpReport({
    runId: 'paper_mvp_run_legacy',
    completionReason: 'LEGACY',
    startedAtMs: 100,
    completedAtMs: 1_000,
    targetClosedPositions: 1,
    initialCapitalRaw: 10_000n,
    quoteMint: 'SOL',
    creationsObserved: 1,
    entriesRejected: 0,
    samples: [createPaperMvpPositionSample(sampleInput())],
    unknownTerminalPositions: 0,
    duplicateLogicalBuys: 0,
    duplicateLogicalSells: 0,
    providerUsage: {
      status: 'AVAILABLE', creditsUsedStart: 100n, creditsUsedEnd: 101n,
      rateLimitedCount: 0,
    },
  });

  assert.equal(report.completionReason, 'LEGACY');
  assert.equal(report.technicalStatus, 'COMPLETED');
  assert.equal(report.verdict, 'PASS');
  assert.deepEqual(report.failedGateCodes, []);
});

function sampleInput(overrides: Record<string, unknown> = {}) {
  return {
    positionId: 'position-1', mint: 'mint-1', quoteMint: 'SOL',
    exitReason: 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED' as const,
    creationDetectedAtMs: 100, entryDecisionAtMs: 110, entryQuoteAtMs: 120,
    paperBuyAtMs: 130, exitTriggerAtMs: 200, exitQuoteAtMs: 210, paperSellAtMs: 220,
    buyAmountInRaw: 1_000n, buyAmountOutRaw: 900n, buyMinimumAmountOutRaw: 890n,
    buyFeesRaw: 5n, buySlippageBps: 100n, buyPriceImpactBps: 200n,
    sellAmountInRaw: 890n, sellAmountOutRaw: 1_220n, sellMinimumAmountOutRaw: 1_200n,
    sellFeesRaw: 5n, sellSlippageBps: 100n, sellPriceImpactBps: 200n,
    networkFeeRawPerTransaction: 5n,
    ...overrides,
  };
}
