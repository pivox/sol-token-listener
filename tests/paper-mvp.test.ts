import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPaperMvpPositionSample,
  createPaperMvpReport,
} from '../src/domain/paper-mvp.js';

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

  assert.equal(report.schemaVersion, 'paper-mvp.v1');
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
