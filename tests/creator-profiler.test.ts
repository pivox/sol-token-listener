import assert from 'node:assert/strict';
import test from 'node:test';
import { CreatorProfiler } from '../src/analytics/creator-profiler.js';
import type {
  ParticipantAnalyticsInput,
  ParticipantAnalyticsTrade,
} from '../src/domain/participant-analytics.js';
import type { QuoteAsset } from '../src/domain/types.js';

const SOL = quote('sol', 9, 'SPL_TOKEN');
const USDC = quote('usdc', 6, 'TOKEN_2022');

void test('profile les achats initiaux, la première vente et les flux multi-quote du créateur', () => {
  const input = makeInput([
    trade('initial-sol', 2, 'BUY', 'creator', 30n, 3n, SOL, 'create-signature'),
    trade('initial-usdc', 3, 'BUY', 'creator', 20n, 4n, USDC, 'create-signature'),
    trade('creator-buy', 4, 'BUY', 'creator', 40n, 5n, SOL),
    trade('buyer-a', 5, 'BUY', 'buyer-a', 10n, 1n, SOL),
    trade('buyer-b', 6, 'BUY', 'buyer-b', 10n, 1n, SOL),
    trade('unknown', 7, 'BUY', null, 1n, 1n, SOL),
    trade('creator-sell', 8, 'SELL', 'creator', 20n, 2n, SOL),
  ]);

  const profile = new CreatorProfiler().profile(input);

  assert.equal(profile.buyCount, 3);
  assert.equal(profile.sellCount, 1);
  assert.equal(profile.totalBoughtBaseRaw, 90n);
  assert.equal(profile.totalSoldBaseRaw, 20n);
  assert.equal(profile.observedNetBaseRaw, 70n);
  assert.equal(profile.hasSold, true);
  assert.equal(profile.initialBuys.length, 2);
  assert.equal(profile.uniqueExternalBuyers, 2);
  assert.equal(profile.unknownTraderTradeCount, 1);
  assert.equal(profile.firstSell?.signature, 'creator-sell-signature');
  assert.deepEqual(profile.quoteFlows.map((flow) => ({
    mint: flow.quoteAsset.mint,
    bought: flow.boughtQuoteRaw,
    sold: flow.soldQuoteRaw,
  })), [
    { mint: 'sol', bought: 8n, sold: 2n },
    { mint: 'usdc', bought: 4n, sold: 0n },
  ]);
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.quoteFlows), true);
});

void test('ne classe pas un achat externe de la transaction de création comme achat initial', () => {
  const profile = new CreatorProfiler().profile(makeInput([
    trade('external-initial', 2, 'BUY', 'buyer', 10n, 1n, SOL, 'create-signature'),
  ]));

  assert.deepEqual(profile.initialBuys, []);
  assert.equal(profile.buyCount, 0);
});

void test('choisit la première vente par curseur canonique et conserve un net négatif', () => {
  const later = trade('later-sell', 9, 'SELL', 'creator', 30n, 3n, SOL);
  const earlier = trade('earlier-sell', 4, 'SELL', 'creator', 20n, 2n, SOL);
  const input = makeInput([later, earlier]);
  const originalOrder = [...input.trades];

  const profile = new CreatorProfiler().profile(input);

  assert.equal(profile.firstSell?.tradeId, 'earlier-sell');
  assert.equal(profile.observedNetBaseRaw, -50n);
  assert.deepEqual(input.trades, originalOrder);
});

function makeInput(trades: readonly ParticipantAnalyticsTrade[]): ParticipantAnalyticsInput {
  return Object.freeze({
    launch: Object.freeze({
      eventId: 'launch-event',
      mint: 'mint',
      creator: 'creator',
      source: 'pumpfun',
      program: 'pump-program',
      signature: 'create-signature',
      cursor: Object.freeze({
        slot: 10n,
        transactionIndex: 0,
        instructionIndex: 1,
        innerInstructionIndex: null,
      }),
      confirmationStatus: 'confirmed' as const,
      observedAtMs: 1_720_000_000_000,
    }),
    trades: Object.freeze([...trades]),
    inputFingerprint: 'fingerprint',
  });
}

function trade(
  tradeId: string,
  instructionIndex: number,
  kind: 'BUY' | 'SELL',
  trader: string | null,
  baseAmountRaw: bigint,
  quoteAmountRaw: bigint,
  quoteAsset: QuoteAsset,
  signature = `${tradeId}-signature`,
): ParticipantAnalyticsTrade {
  return Object.freeze({
    eventId: `${tradeId}-event`,
    tradeId,
    launchMint: 'mint',
    signature,
    cursor: Object.freeze({
      slot: 10n,
      transactionIndex: 0,
      instructionIndex,
      innerInstructionIndex: null,
    }),
    confirmationStatus: 'confirmed',
    observedAtMs: 1_720_000_000_000 + instructionIndex,
    kind,
    trader,
    baseAmountRaw,
    quoteAmountRaw,
    quoteAsset,
  });
}

function quote(
  mint: string,
  decimals: number,
  tokenProgram: QuoteAsset['tokenProgram'],
): QuoteAsset {
  return Object.freeze({ mint, decimals, tokenProgram });
}
