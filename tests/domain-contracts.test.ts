import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertValidChainCursor,
  assertValidTransactionCursor,
  compareCursors,
  InvalidChainCursorError,
} from '../src/domain/cursor.js';
import {
  DOMAIN_EVENT_TYPES,
  createDeterministicChainEventId,
  createDeterministicDerivedEventId,
} from '../src/domain/events.js';
import { isTerminalLaunchStatus, LAUNCH_STATUSES } from '../src/domain/launch-status.js';
import { QUALIFICATION_REASON_CODES } from '../src/domain/qualification-reasons.js';
import { PAPER_DECISION_REASON_CODES, PAPER_STRATEGY_SESSION_STATES } from '../src/domain/paper-strategy.js';
import { TRADING_CANDIDATE_STATES } from '../src/domain/trading-candidate.js';
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

void test('l’identité métier encode sans ambiguïté les champs contenant le séparateur historique', () => {
  const base = {
    type: 'TokenLaunchDetected',
    mint: 'Mint111111111111111111111111111111111111111',
    signature: '5NfSignature',
    cursor: {
      slot: 123n,
      transactionIndex: 9,
      instructionIndex: 2,
      innerInstructionIndex: null,
    },
  } as const;

  const separatorInSource = createDeterministicChainEventId({
    ...base,
    source: 'a\u001fb',
    program: 'c',
  });
  const separatorInProgram = createDeterministicChainEventId({
    ...base,
    source: 'a',
    program: 'b\u001fc',
  });

  assert.notEqual(separatorInSource, separatorInProgram);
});

void test('l’identité dérivée conserve l’enveloppe chaîne et ajoute un qualifiant', () => {
  const base = {
    type: 'SocialEvidenceCollected' as const,
    mint: SOL.mint,
    source: 'public_social',
    program: 'pump',
    signature: 'signature',
    cursor: Object.freeze({
      slot: 10n, transactionIndex: 1, instructionIndex: 2, innerInstructionIndex: null,
    }),
    qualifier: 'a'.repeat(64),
  };
  const first = createDeterministicDerivedEventId(base);
  assert.equal(createDeterministicDerivedEventId(base), first);
  assert.match(first, /^evt_[0-9a-f]{64}$/u);
  assert.notEqual(createDeterministicDerivedEventId({ ...base, qualifier: 'b'.repeat(64) }), first);
  assert.notEqual(createDeterministicDerivedEventId({
    ...base, cursor: Object.freeze({ ...base.cursor, instructionIndex: 3 }),
  }), first);
});

void test('valide les bornes canoniques des curseurs de transaction et de chaîne', () => {
  assert.doesNotThrow(() => {
    assertValidTransactionCursor({
      slot: 0n,
      transactionIndex: 0,
    });
  });
  assert.doesNotThrow(() => {
    assertValidChainCursor({
      slot: 0n,
      transactionIndex: Number.MAX_SAFE_INTEGER,
      instructionIndex: Number.MAX_SAFE_INTEGER,
      innerInstructionIndex: 0,
    });
  });
  assert.doesNotThrow(() => {
    assertValidChainCursor({
      slot: 1n,
      transactionIndex: 0,
      instructionIndex: 0,
      innerInstructionIndex: null,
    });
  });
});

void test('rejette chaque forme non canonique de curseur avec le champ et la valeur fautifs', () => {
  const invalidCursors: readonly {
    readonly field: InvalidChainCursorError['field'];
    readonly value: bigint | number;
    readonly cursor: ChainCursor;
  }[] = [
    {
      field: 'slot',
      value: -1n,
      cursor: {
        slot: -1n,
        transactionIndex: 0,
        instructionIndex: 0,
        innerInstructionIndex: null,
      },
    },
    {
      field: 'transactionIndex',
      value: -0,
      cursor: {
        slot: 0n,
        transactionIndex: -0,
        instructionIndex: 0,
        innerInstructionIndex: null,
      },
    },
    {
      field: 'instructionIndex',
      value: Number.NaN,
      cursor: {
        slot: 0n,
        transactionIndex: 0,
        instructionIndex: Number.NaN,
        innerInstructionIndex: null,
      },
    },
    {
      field: 'instructionIndex',
      value: 1.5,
      cursor: {
        slot: 0n,
        transactionIndex: 0,
        instructionIndex: 1.5,
        innerInstructionIndex: null,
      },
    },
    {
      field: 'instructionIndex',
      value: Number.POSITIVE_INFINITY,
      cursor: {
        slot: 0n,
        transactionIndex: 0,
        instructionIndex: Number.POSITIVE_INFINITY,
        innerInstructionIndex: null,
      },
    },
    {
      field: 'instructionIndex',
      value: Number.MAX_SAFE_INTEGER + 1,
      cursor: {
        slot: 0n,
        transactionIndex: 0,
        instructionIndex: Number.MAX_SAFE_INTEGER + 1,
        innerInstructionIndex: null,
      },
    },
    {
      field: 'innerInstructionIndex',
      value: -1,
      cursor: {
        slot: 0n,
        transactionIndex: 0,
        instructionIndex: 0,
        innerInstructionIndex: -1,
      },
    },
  ];

  for (const invalid of invalidCursors) {
    assert.throws(
      () => {
        assertValidChainCursor(invalid.cursor);
      },
      (error: unknown) =>
        error instanceof InvalidChainCursorError
        && error.field === invalid.field
        && Object.is(error.value, invalid.value),
    );
  }
});

void test('le hachage et la comparaison refusent directement les curseurs non canoniques', () => {
  const validCursor: ChainCursor = {
    slot: 1n,
    transactionIndex: 0,
    instructionIndex: 0,
    innerInstructionIndex: null,
  };
  const invalidCursor: ChainCursor = {
    ...validCursor,
    instructionIndex: -0,
  };

  assert.throws(
    () => createDeterministicChainEventId({
      type: 'TokenLaunchDetected',
      mint: 'Mint111111111111111111111111111111111111111',
      source: 'solana',
      program: 'Program111111111111111111111111111111111111',
      signature: '5NfSignature',
      cursor: invalidCursor,
    }),
    (error: unknown) =>
      error instanceof InvalidChainCursorError
      && error.field === 'instructionIndex'
      && Object.is(error.value, -0),
  );
  assert.throws(
    () => compareCursors(validCursor, invalidCursor),
    InvalidChainCursorError,
  );
});

void test('les états métier et reason codes V1 sont stables et explicites', () => {
  assert.ok(LAUNCH_STATUSES.includes('BONDING_CURVE_COMPLETE'));
  assert.ok(LAUNCH_STATUSES.includes('PUMPSWAP_ACTIVE'));
  assert.equal(isTerminalLaunchStatus('PAPER_CLOSED'), false);
  assert.equal(isTerminalLaunchStatus('PAPER_HOLDING'), false);
  assert.equal(isTerminalLaunchStatus('REJECTED'), true);
  assert.equal(isTerminalLaunchStatus('EXPIRED'), true);
  assert.ok(QUALIFICATION_REASON_CODES.includes('CREATOR_EARLY_SELL'));
  assert.ok(QUALIFICATION_REASON_CODES.includes('UNSUPPORTED_QUOTE_MINT'));
  assert.deepEqual(TRADING_CANDIDATE_STATES, ['NOT_ELIGIBLE', 'ELIGIBLE', 'EXPIRED', 'REVOKED']);
  assert.ok(PAPER_STRATEGY_SESSION_STATES.includes('WAITING_EXTERNAL_BUYS'));
  assert.ok(PAPER_DECISION_REASON_CODES.includes('EXTERNAL_BUY_TARGET_REACHED'));
  for (const eventType of [
    'TradingCandidateUpdated', 'PaperStrategySessionUpdated', 'PaperExternalBuyCounted',
  ] as const) assert.ok(DOMAIN_EVENT_TYPES.includes(eventType));
});
