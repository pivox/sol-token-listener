import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBondingCurveTradeObservedEvent,
  createTokenLaunchDetectedEvent,
} from '../src/domain/launchpad-events.js';
import type {
  LaunchpadTrade,
  ObservedChainTransaction,
  QuoteAsset,
  TokenLaunch,
} from '../src/domain/types.js';

const PROGRAM = 'Pump111111111111111111111111111111111111111';
const SOL: QuoteAsset = {
  mint: 'So11111111111111111111111111111111111111112',
  decimals: 9,
  tokenProgram: 'SPL_TOKEN',
};
const USDC: QuoteAsset = {
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
  tokenProgram: 'SPL_TOKEN',
};
const transaction: ObservedChainTransaction = {
  signature: '5NfSignature',
  confirmationStatus: 'processed',
  blockTimeMs: 1_753_700_000_000,
  observedAtMs: 1_753_700_000_500,
  cursor: { slot: 123n, transactionIndex: 9 },
  raw: null,
};
const launch: TokenLaunch = {
  mint: 'Mint111111111111111111111111111111111111111',
  creator: 'Creator111111111111111111111111111111111111',
  tokenProgram: 'SPL_TOKEN',
  quoteAssets: [SOL, USDC],
  launchpad: 'pumpfun',
  createdAt: {
    ...transaction.cursor,
    instructionIndex: 2,
    innerInstructionIndex: null,
  },
  parameters: { cashback: false, mayhem: false },
};
const trade: LaunchpadTrade = {
  id: 'adapter-trade-id',
  launchMint: launch.mint,
  kind: 'BUY',
  trader: 'Buyer11111111111111111111111111111111111111',
  baseAmountRaw: 1_000_000n,
  quoteAmountRaw: 250_000_000n,
  quoteAsset: SOL,
  cursor: {
    ...transaction.cursor,
    instructionIndex: 3,
    innerInstructionIndex: 0,
  },
};

void test('construit des événements V1 typés sans perdre le multi-quote', () => {
  const launchEvent = createTokenLaunchDetectedEvent({
    source: 'pumpfun',
    program: PROGRAM,
    transaction,
    launch,
  });
  const tradeEvent = createBondingCurveTradeObservedEvent({
    source: 'pumpfun',
    program: PROGRAM,
    transaction,
    trade,
  });

  assert.equal(launchEvent.type, 'TokenLaunchDetected');
  assert.equal(launchEvent.payloadVersion, 1);
  assert.deepEqual(launchEvent.payload.launch.quoteAssets, [SOL, USDC]);
  assert.equal(tradeEvent.type, 'BondingCurveTradeObserved');
  assert.equal(tradeEvent.payloadVersion, 1);
  assert.equal(tradeEvent.payload.trade.quoteAmountRaw, 250_000_000n);
});

void test('conserve le même ID lors d’une montée de confirmation', () => {
  const processed = createTokenLaunchDetectedEvent({
    source: 'pumpfun',
    program: PROGRAM,
    transaction,
    launch,
  });
  const finalized = createTokenLaunchDetectedEvent({
    source: 'pumpfun',
    program: PROGRAM,
    transaction: { ...transaction, confirmationStatus: 'finalized' },
    launch,
  });

  assert.equal(processed.id, finalized.id);
  assert.equal(finalized.confirmationStatus, 'finalized');
});
