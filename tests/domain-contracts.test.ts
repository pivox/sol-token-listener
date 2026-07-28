import assert from 'node:assert/strict';
import test from 'node:test';
import { compareCursors } from '../src/domain/cursor.js';
import { createDeterministicChainEventId } from '../src/domain/events.js';
import { isTerminalLaunchStatus, LAUNCH_STATUSES } from '../src/domain/launch-status.js';
import { QUALIFICATION_REASON_CODES } from '../src/domain/qualification-reasons.js';
import type { ChainCursor, QuoteAsset, TokenLaunch } from '../src/domain/types.js';

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

void test('un lancement expose ses actifs de cotation sans supposer SOL', () => {
  const launch: TokenLaunch = {
    mint: 'Mint111111111111111111111111111111111111111',
    creator: 'Creator111111111111111111111111111111111111',
    tokenProgram: 'SPL_TOKEN',
    quoteAssets: [SOL, USDC],
    launchpad: 'launchpad-adapter',
    createdAt: {
      slot: 10n,
      transactionIndex: 2,
      instructionIndex: 4,
      innerInstructionIndex: null,
    },
    parameters: {},
  };

  assert.deepEqual(launch.quoteAssets.map((asset) => asset.mint), [SOL.mint, USDC.mint]);
});

void test('les curseurs Solana sont ordonnés jusqu’à l’instruction interne', () => {
  const outer: ChainCursor = {
    slot: 42n,
    transactionIndex: 7,
    instructionIndex: 3,
    innerInstructionIndex: null,
  };
  const firstInner: ChainCursor = { ...outer, innerInstructionIndex: 0 };
  const nextTransaction: ChainCursor = { ...outer, transactionIndex: 8, instructionIndex: 0 };

  assert.equal(compareCursors(outer, firstInner), -1);
  assert.equal(compareCursors(firstInner, outer), 1);
  assert.equal(compareCursors(firstInner, nextTransaction), -1);
  assert.equal(compareCursors(outer, { ...outer }), 0);
});

void test('l’identifiant métier est déterministe et inclut l’index interne', () => {
  const base = {
    type: 'TokenLaunchDetected',
    mint: 'Mint111111111111111111111111111111111111111',
    source: 'solana',
    program: 'Pump111111111111111111111111111111111111111',
    signature: '5NfSignature',
    cursor: {
      slot: 123n,
      transactionIndex: 9,
      instructionIndex: 2,
      innerInstructionIndex: 0,
    },
  } as const;

  const first = createDeterministicChainEventId(base);
  const same = createDeterministicChainEventId(base);
  const nextInner = createDeterministicChainEventId({
    ...base,
    cursor: { ...base.cursor, innerInstructionIndex: 1 },
  });
  const otherMint = createDeterministicChainEventId({
    ...base,
    mint: 'Mint222222222222222222222222222222222222222',
  });

  assert.equal(first, same);
  assert.match(first, /^evt_[a-f0-9]{64}$/u);
  assert.notEqual(first, nextInner);
  assert.notEqual(first, otherMint);
});

void test('les états métier et reason codes V1 sont stables et explicites', () => {
  assert.ok(LAUNCH_STATUSES.includes('BONDING_CURVE_COMPLETE'));
  assert.ok(LAUNCH_STATUSES.includes('PUMPSWAP_ACTIVE'));
  assert.equal(isTerminalLaunchStatus('PAPER_CLOSED'), true);
  assert.equal(isTerminalLaunchStatus('PAPER_HOLDING'), false);
  assert.ok(QUALIFICATION_REASON_CODES.includes('CREATOR_EARLY_SELL'));
  assert.ok(QUALIFICATION_REASON_CODES.includes('UNSUPPORTED_QUOTE_MINT'));
});
