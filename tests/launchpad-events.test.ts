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
  const launchPayloadVersion: 1 = launchEvent.payloadVersion;
  assert.equal(launchPayloadVersion, 1);
  assert.deepEqual(launchEvent.payload.launch.quoteAssets, [SOL, USDC]);
  assert.equal(tradeEvent.type, 'BondingCurveTradeObserved');
  assert.equal(tradeEvent.payloadVersion, 1);
  const tradePayloadVersion: 1 = tradeEvent.payloadVersion;
  assert.equal(tradePayloadVersion, 1);
  assert.equal(tradeEvent.payload.trade.quoteAmountRaw, 250_000_000n);
});

void test('conserve le même ID lors d’une montée de confirmation et d’un nouveau relevé temporel', () => {
  const processed = createTokenLaunchDetectedEvent({
    source: 'pumpfun',
    program: PROGRAM,
    transaction,
    launch,
  });
  const finalized = createTokenLaunchDetectedEvent({
    source: 'pumpfun',
    program: PROGRAM,
    transaction: {
      ...transaction,
      confirmationStatus: 'finalized',
      blockTimeMs: 1_753_700_060_000,
      observedAtMs: transaction.observedAtMs + 60_000,
    },
    launch,
  });

  assert.equal(processed.id, finalized.id);
  assert.equal(finalized.confirmationStatus, 'finalized');
});

void test('snapshotte les entrées mutables pour conserver l’événement et son identité', () => {
  const mutableQuoteAsset = { ...SOL };
  const mutableLaunchCursor = {
    ...transaction.cursor,
    instructionIndex: 2,
    innerInstructionIndex: null,
  };
  const mutableParameters = { metadata: { verified: true } };
  const mutableLaunch = {
    mint: launch.mint,
    creator: launch.creator,
    tokenProgram: launch.tokenProgram,
    quoteAssets: [mutableQuoteAsset],
    launchpad: launch.launchpad,
    createdAt: mutableLaunchCursor,
    parameters: mutableParameters,
  };
  const mutableTradeCursor = {
    ...transaction.cursor,
    instructionIndex: 3,
    innerInstructionIndex: 0,
  };
  const mutableTrade = {
    ...trade,
    quoteAsset: mutableQuoteAsset,
    cursor: mutableTradeCursor,
  };
  const launchEvent = createTokenLaunchDetectedEvent({
    source: 'pumpfun',
    program: PROGRAM,
    transaction,
    launch: mutableLaunch,
  });
  const tradeEvent = createBondingCurveTradeObservedEvent({
    source: 'pumpfun',
    program: PROGRAM,
    transaction,
    trade: mutableTrade,
  });
  const launchId = launchEvent.id;
  const tradeId = tradeEvent.id;

  mutableLaunchCursor.instructionIndex = 99;
  mutableQuoteAsset.mint = 'ChangedQuoteMint';
  mutableParameters.metadata.verified = false;
  mutableTradeCursor.innerInstructionIndex = 8;

  assert.equal(launchEvent.id, launchId);
  assert.equal(launchEvent.cursor.instructionIndex, 2);
  assert.equal(launchEvent.payload.launch.createdAt.instructionIndex, 2);
  const snapshottedLaunchQuote = launchEvent.payload.launch.quoteAssets[0];
  assert.ok(snapshottedLaunchQuote);
  assert.equal(snapshottedLaunchQuote.mint, SOL.mint);
  assert.deepEqual(launchEvent.payload.launch.parameters, { metadata: { verified: true } });
  assert.equal(tradeEvent.id, tradeId);
  assert.equal(tradeEvent.cursor.innerInstructionIndex, 0);
  assert.equal(tradeEvent.payload.trade.cursor.innerInstructionIndex, 0);
  assert.equal(tradeEvent.payload.trade.quoteAsset.mint, SOL.mint);
});
