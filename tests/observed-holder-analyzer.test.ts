import assert from 'node:assert/strict';
import test from 'node:test';
import { ObservedHolderAnalyzer } from '../src/analytics/observed-holder-analyzer.js';
import type {
  ParticipantAnalyticsInput,
  ParticipantAnalyticsTrade,
} from '../src/domain/participant-analytics.js';
import type { QuoteAsset } from '../src/domain/types.js';

const SOL = quote('sol', 9, 'SPL_TOKEN');
const USDC = quote('usdc', 6, 'TOKEN_2022');

void test('calcule top 1, top 5 et top 10 depuis les flux nets positifs', () => {
  const distribution = new ObservedHolderAnalyzer().analyze(makeInput([
    trade('a', 2, 'BUY', 'a', 400n, 4n, SOL),
    trade('b', 3, 'BUY', 'b', 300n, 3n, SOL),
    trade('c', 4, 'BUY', 'c', 200n, 2n, SOL),
    trade('creator', 5, 'BUY', 'creator', 100n, 1n, SOL),
  ]));

  assert.equal(distribution.totalPositiveNetBaseRaw, 1_000n);
  assert.equal(distribution.top1Bps, 4_000n);
  assert.equal(distribution.top5Bps, 10_000n);
  assert.equal(distribution.top10Bps, 10_000n);
  assert.equal(distribution.creatorBps, 1_000n);
  assert.deepEqual(distribution.positions.map((position) => position.wallet), [
    'a', 'b', 'c', 'creator',
  ]);
  assert.equal(distribution.uniqueKnownBuyers, 4);
  assert.equal(distribution.uniqueExternalBuyers, 3);
});

void test('conserve les positions nulles et négatives sans les inclure dans la concentration', () => {
  const distribution = new ObservedHolderAnalyzer().analyze(makeInput([
    trade('negative-sell', 5, 'SELL', 'negative', 50n, 5n, SOL),
    trade('zero-buy', 2, 'BUY', 'zero', 20n, 2n, SOL),
    trade('zero-sell', 3, 'SELL', 'zero', 20n, 2n, SOL),
    trade('unknown', 4, 'BUY', null, 100n, 10n, SOL),
  ]));

  assert.equal(distribution.totalPositiveNetBaseRaw, 0n);
  assert.equal(distribution.top1Bps, 0n);
  assert.equal(distribution.creatorBps, 0n);
  assert.equal(distribution.unknownTraderTradeCount, 1);
  assert.equal(distribution.positions.find((position) => position.wallet === 'negative')?.observedNetBaseRaw, -50n);
  assert.equal(distribution.positions.find((position) => position.wallet === 'zero')?.observedNetBaseRaw, 0n);
});

void test('sépare les quotes, départage les nets égaux et ordonne les curseurs internes', () => {
  const distribution = new ObservedHolderAnalyzer().analyze(makeInput([
    trade('z-sol', 5, 'BUY', 'z-wallet', 10n, 2n, SOL, 2),
    trade('a-usdc', 5, 'BUY', 'a-wallet', 10n, 3n, USDC, 1),
    trade('a-sol', 5, 'BUY', 'a-wallet', 5n, 1n, SOL, 0),
    trade('a-sell', 6, 'SELL', 'a-wallet', 5n, 1n, SOL),
  ]));

  assert.deepEqual(distribution.positions.map((position) => position.wallet), [
    'a-wallet', 'z-wallet',
  ]);
  const a = distribution.positions[0];
  assert.equal(a?.firstObservedCursor.innerInstructionIndex, 0);
  assert.equal(a?.lastObservedCursor.instructionIndex, 6);
  assert.deepEqual(a?.quoteFlows.map((flow) => flow.quoteAsset.mint), ['sol', 'usdc']);
  assert.equal(Object.isFrozen(distribution), true);
  assert.equal(Object.isFrozen(distribution.positions), true);
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
  innerInstructionIndex: number | null = null,
): ParticipantAnalyticsTrade {
  return Object.freeze({
    eventId: `${tradeId}-event`,
    tradeId,
    launchMint: 'mint',
    signature: `${tradeId}-signature`,
    cursor: Object.freeze({
      slot: 10n,
      transactionIndex: 0,
      instructionIndex,
      innerInstructionIndex,
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
