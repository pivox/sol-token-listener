import assert from 'node:assert/strict';
import test from 'node:test';
import type { PaperExecutionQuote } from '../src/domain/paper-trading.js';
import type { CreatorProfile, HolderDistribution } from '../src/domain/participant-analytics.js';
import type { PaperDecisionSnapshot } from '../src/ports/paper-decision-repository.js';
import { QualificationRebuildService } from '../src/application/qualification-rebuild.service.js';
import {
  createDefaultQualificationRuleSet,
  QualificationEngine,
} from '../src/qualification/qualification-engine.js';

void test('keeps unavailable evidence UNKNOWN instead of manufacturing negative facts', () => {
  const service = new QualificationRebuildService(engine());
  const rebuilt = service.rebuild({ snapshot: snapshot(), buyQuote: undefined, reverseSellQuote: undefined });

  assert.match(rebuilt.reportId, /^qreport_[a-f0-9]{64}$/u);
  assert.equal(rebuilt.event.type, 'QualificationUpdated');
  assert.equal(rebuilt.event.id, rebuilt.reportEventId);
  assert.equal(rebuilt.report.evidence.every((item) => item.status === 'UNKNOWN'), true);
  assert.equal(condition(rebuilt, 'BUY_SIMULATION_FAILED').status, 'UNKNOWN');
  assert.equal(condition(rebuilt, 'SELL_QUOTE_UNAVAILABLE').status, 'UNKNOWN');
  assert.deepEqual(condition(rebuilt, 'HOLDER_CONCENTRATION_EXCEEDED').observed, {
    top1HolderBps: null, top5HoldersBps: null, top10HoldersBps: null,
  });
});

void test('maps explicit creator, holder and quote evidence and computes integer round trip loss', () => {
  const service = new QualificationRebuildService(engine());
  const rebuilt = service.rebuild({
    snapshot: snapshot({
      metadata: {
        mint: 'MINT', uri: 'https://metadata.example/token.json', fetchedAtMs: 900,
        payloadVersion: 1, resolution: {
          status: 'RESOLVED', metadata: {
            name: 'Token', symbol: 'TOK', description: 'Description',
            imageUrl: 'https://cdn.example/image.png', videoUrl: null,
            websiteUrl: null, twitterUrl: null, telegramUrl: null,
          },
        },
      },
      creatorProfile: creatorProfile(false),
      holderSnapshot: holderDistribution(),
    }),
    buyQuote: quote('buy', 'SOL', 'MINT', 1_000n, 900n, 900n),
    reverseSellQuote: quote('sell', 'MINT', 'SOL', 900n, 820n, 800n),
  });

  assert.equal(evidence(rebuilt, 'imageValid').status, 'SATISFIED');
  assert.equal(rebuilt.evaluation.signals.descriptionAvailable, true);
  assert.equal(evidence(rebuilt, 'creatorHasNotSold').status, 'SATISFIED');
  assert.equal(evidence(rebuilt, 'externalBuyersObserved').status, 'SATISFIED');
  assert.deepEqual(condition(rebuilt, 'ROUND_TRIP_LOSS_EXCEEDED').observed, {
    roundTripLossBps: 2_000n,
  });
});

void test('keeps an enforced creator sell separate from the score', () => {
  const service = new QualificationRebuildService(engine());
  const rebuilt = service.rebuild({
    snapshot: snapshot({ creatorProfile: creatorProfile(true) }),
    buyQuote: null,
    reverseSellQuote: null,
  });

  assert.equal(condition(rebuilt, 'CREATOR_EARLY_SELL').status, 'TRIGGERED');
  assert.deepEqual(rebuilt.report.blockers.map((item) => item.code), ['CREATOR_EARLY_SELL', 'BUY_SIMULATION_FAILED', 'SELL_QUOTE_UNAVAILABLE']);
  assert.equal(rebuilt.report.verdict, 'REJECTED');
});

function engine(): QualificationEngine {
  return new QualificationEngine(createDefaultQualificationRuleSet(60));
}

function snapshot(overrides: Partial<PaperDecisionSnapshot> = {}): PaperDecisionSnapshot {
  const asOfEvent = {
    id: 'evt_source', type: 'TokenLaunchDetected' as const, mint: 'MINT', source: 'pumpfun',
    program: 'pump', signature: 'signature',
    cursor: { slot: 10n, transactionIndex: 0, instructionIndex: 1, innerInstructionIndex: null },
    confirmationStatus: 'confirmed' as const, blockchainTimeMs: 800, observedAtMs: 1_000,
    payloadVersion: 1, payload: {},
  };
  return Object.freeze({
    mint: 'MINT', asOfEvent,
    launch: Object.freeze({
      mint: 'MINT', creator: 'creator', tokenProgram: 'SPL_TOKEN' as const,
      quoteAssets: Object.freeze([Object.freeze({ mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' as const })]),
      launchpad: 'pumpfun', createdAt: Object.freeze({ ...asOfEvent.cursor }), parameters: Object.freeze({}),
    }),
    metadata: null, social: null, creatorProfile: null, holderSnapshot: null,
    walletGraph: null, activeLaunchTrades: Object.freeze([]), activeMarketTrades: Object.freeze([]),
    currentCandidate: null, currentDecision: null, currentSession: null, activePosition: null,
    ...overrides,
  });
}

function creatorProfile(hasSold: boolean): CreatorProfile {
  return Object.freeze({
    mint: 'MINT', creator: 'creator', payloadVersion: 1, inputFingerprint: 'a'.repeat(64),
    buyCount: 0, sellCount: hasSold ? 1 : 0, totalBoughtBaseRaw: 0n,
    totalSoldBaseRaw: hasSold ? 1n : 0n, observedNetBaseRaw: hasSold ? -1n : 0n,
    hasSold, firstSell: null, initialBuys: Object.freeze([]), quoteFlows: Object.freeze([]),
    uniqueExternalBuyers: 2, unknownTraderTradeCount: 0,
  });
}

function holderDistribution(): HolderDistribution {
  return Object.freeze({
    mint: 'MINT', creator: 'creator', payloadVersion: 1, inputFingerprint: 'b'.repeat(64),
    positions: Object.freeze([]), totalPositiveNetBaseRaw: 1_000n, top1Bps: 1_000n,
    top5Bps: 2_000n, top10Bps: 3_000n, creatorBps: 0n, uniqueKnownBuyers: 2,
    uniqueExternalBuyers: 2, positivePositionCount: 2, unknownTraderTradeCount: 0,
  });
}

function quote(
  id: string,
  inputMint: string,
  outputMint: string,
  amountInRaw: bigint,
  amountOutRaw: bigint,
  minimumAmountOutRaw: bigint,
): PaperExecutionQuote {
  return Object.freeze({
    id,inputMint,outputMint,amountInRaw,amountOutRaw,minimumAmountOutRaw,
    feesRaw:1n,slippageBps:100n,priceImpactBps:10n,observedAtMs:1_000,observedSlot:10n,
  });
}

function evidence(
  rebuilt: ReturnType<QualificationRebuildService['rebuild']>,
  signal: string,
) {
  const item = rebuilt.report.evidence.find((candidate) => candidate.signal === signal);
  assert.ok(item);
  return item;
}

function condition(
  rebuilt: ReturnType<QualificationRebuildService['rebuild']>,
  code: string,
) {
  const item = rebuilt.report.conditions.find((candidate) => candidate.code === code);
  assert.ok(item);
  return item;
}
