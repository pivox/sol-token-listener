import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideFastExit,
  exitReasonOfLogicalKey,
  FAST_EXIT_REASONS,
  FAST_EXIT_STRATEGY_ID,
  fastExitLogicalCommandId,
  reExitLogicalCommandId,
  type FastExitFacts,
  type FastExitPolicy,
  type FastExitTrade,
} from '../src/domain/fast-exit.js';

const WALLET = 'So11111111111111111111111111111111111111112';
const CREATOR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const BUYER_A = '11111111111111111111111111111111';
const BUYER_B = 'SysvarRent111111111111111111111111111111111';
const POSITION_ID = `execution_live_position_${'ab'.repeat(32)}`;

function policy(overrides: Partial<FastExitPolicy> = {}): FastExitPolicy {
  return Object.freeze({
    takeProfitBps: 20_000n, externalBuyersTarget: 2, externalMinimumBuyRaw: 1_000_000n, ...overrides,
  });
}

let sequence = 0;
function trade(overrides: Partial<FastExitTrade> = {}): FastExitTrade {
  sequence += 1;
  return Object.freeze({
    eventId: `event-${sequence}`, kind: 'BUY', trader: BUYER_A, baseAmountRaw: 1_000n,
    quoteAmountRaw: 1_000_000n, slot: 100n, transactionIndex: 0, instructionIndex: 0,
    innerInstructionIndex: null, ...overrides,
  });
}

function facts(overrides: Partial<Record<keyof FastExitFacts, unknown>> = {}): FastExitFacts {
  return Object.freeze({
    envelopeState: 'ACTIVE', creator: CREATOR, walletPublicKey: WALLET,
    remainingBaseRaw: 1_000n, quoteCostRaw: 10_000_000n, trades: Object.freeze([]),
    ...overrides,
  }) as FastExitFacts;
}

function trades(...values: FastExitTrade[]): readonly FastExitTrade[] {
  return Object.freeze(values);
}

test('constants', () => {
  assert.equal(FAST_EXIT_STRATEGY_ID, 'fast-entry-exit-v1');
  assert.deepEqual(FAST_EXIT_REASONS, ['ENVELOPE_REVOKED', 'CREATOR_SOLD', 'TAKE_PROFIT', 'EXTERNAL_BUYERS']);
  assert.ok(Object.isFrozen(FAST_EXIT_REASONS));
});

test('no condition true returns null', () => {
  assert.equal(decideFastExit(facts(), policy()), null);
  for (const state of ['ACTIVE', 'EXHAUSTED', 'EXPIRED']) {
    assert.equal(decideFastExit(facts({ envelopeState: state }), policy()), null);
  }
});

test('a revoked envelope exits', () => {
  assert.equal(decideFastExit(facts({ envelopeState: 'REVOKED' }), policy()), 'ENVELOPE_REVOKED');
});

test('a creator sell exits', () => {
  const sell = trade({ kind: 'SELL', trader: CREATOR, quoteAmountRaw: 1n, baseAmountRaw: 1_000_000n });
  assert.equal(decideFastExit(facts({ trades: trades(sell) }), policy()), 'CREATOR_SOLD');
  const otherSell = trade({ kind: 'SELL', trader: BUYER_A, quoteAmountRaw: 1n, baseAmountRaw: 1_000_000n });
  assert.equal(decideFastExit(facts({ trades: trades(otherSell) }), policy()), null);
});

test('rules are evaluated in order', () => {
  const sell = trade({ kind: 'SELL', trader: CREATOR, quoteAmountRaw: 1n, baseAmountRaw: 1n });
  const pump = trade({ trader: BUYER_A, baseAmountRaw: 1n, quoteAmountRaw: 1_000_000n, slot: 200n });
  const buyerB = trade({ trader: BUYER_B, slot: 150n });
  const all = trades(sell, pump, buyerB);
  assert.equal(decideFastExit(facts({ envelopeState: 'REVOKED', trades: all }), policy()), 'ENVELOPE_REVOKED');
  assert.equal(decideFastExit(facts({ trades: all }), policy()), 'CREATOR_SOLD');
  assert.equal(decideFastExit(facts({ trades: trades(pump, buyerB) }), policy()), 'TAKE_PROFIT');
  const flat = trades(trade({ trader: BUYER_A, slot: 150n }), trade({ trader: BUYER_B, slot: 160n }));
  assert.equal(decideFastExit(facts({ trades: flat }), policy()), 'EXTERNAL_BUYERS');
});

test('unreadable trades leave only the revoke rule', () => {
  assert.equal(decideFastExit(facts({ trades: null }), policy()), null);
  assert.equal(decideFastExit(facts({ trades: null, envelopeState: 'REVOKED' }), policy()), 'ENVELOPE_REVOKED');
});

test('an unknown creator disables CREATOR_SOLD but buyers still count', () => {
  const sell = trade({ kind: 'SELL', trader: CREATOR, quoteAmountRaw: 1n, baseAmountRaw: 1_000_000n, slot: 300n });
  assert.equal(decideFastExit(facts({ creator: null, trades: trades(sell) }), policy()), null);
  const buys = trades(
    trade({ trader: CREATOR, slot: 101n }),
    trade({ trader: BUYER_A, slot: 102n }),
    sell,
  );
  assert.equal(decideFastExit(facts({ creator: null, trades: buys }), policy()), 'EXTERNAL_BUYERS');
  assert.equal(decideFastExit(facts({ trades: buys }), policy()), 'CREATOR_SOLD');
});

test('own wallet trades are ignored for take-profit and buyers', () => {
  const ownPump = trade({ trader: WALLET, baseAmountRaw: 1n, quoteAmountRaw: 1_000_000n, slot: 500n });
  const flat = trade({ trader: BUYER_A, slot: 100n });
  assert.equal(decideFastExit(facts({ trades: trades(ownPump, flat) }), policy()), null);
  const ownBuys = trades(trade({ trader: WALLET, slot: 101n }), trade({ trader: BUYER_A, slot: 102n }));
  assert.equal(decideFastExit(facts({ trades: ownBuys }), policy()), null);
});

test('creator buys are not counted', () => {
  const buys = trades(trade({ trader: CREATOR, slot: 101n }), trade({ trader: BUYER_A, slot: 102n }));
  assert.equal(decideFastExit(facts({ trades: buys }), policy()), null);
});

test('a wallet that buys twice counts once', () => {
  const buys = trades(trade({ trader: BUYER_A, slot: 101n }), trade({ trader: BUYER_A, slot: 102n }));
  assert.equal(decideFastExit(facts({ trades: buys }), policy()), null);
  const three = trades(...buys, trade({ trader: BUYER_B, slot: 103n }));
  assert.equal(decideFastExit(facts({ trades: three }), policy()), 'EXTERNAL_BUYERS');
});

test('a buy below the minimum is not counted, at the minimum it is', () => {
  const below = trades(
    trade({ trader: BUYER_A, slot: 101n }),
    trade({ trader: BUYER_B, slot: 102n, quoteAmountRaw: 999_999n }),
  );
  assert.equal(decideFastExit(facts({ trades: below }), policy()), null);
  const sells = trades(
    trade({ trader: BUYER_A, slot: 101n }),
    trade({ kind: 'SELL', trader: BUYER_B, slot: 102n }),
  );
  assert.equal(decideFastExit(facts({ trades: sells }), policy()), null);
  const nullTrader = trades(trade({ trader: BUYER_A, slot: 101n }), trade({ trader: null, slot: 102n }));
  assert.equal(decideFastExit(facts({ trades: nullTrader }), policy()), null);
  assert.equal(decideFastExit(facts({ trades: below }), policy({ externalBuyersTarget: 1 })), 'EXTERNAL_BUYERS');
});

test('take-profit boundary: equal fires, one lamport less does not', () => {
  // remaining 1 000, cost 10 000 000, TP 2x => needs last price >= 20 000 per base unit.
  const exact = trade({ trader: BUYER_A, baseAmountRaw: 3n, quoteAmountRaw: 60_000n });
  assert.equal(decideFastExit(facts({ trades: trades(exact) }), policy({ externalBuyersTarget: 5 })), 'TAKE_PROFIT');
  const below = trade({ trader: BUYER_A, baseAmountRaw: 3n, quoteAmountRaw: 59_999n });
  assert.equal(decideFastExit(facts({ trades: trades(below) }), policy({ externalBuyersTarget: 5 })), null);
});

test('last trade is chosen by cursor, not array order', () => {
  const high = { trader: BUYER_A, baseAmountRaw: 1n, quoteAmountRaw: 1_000_000n };
  const low = { trader: BUYER_B, baseAmountRaw: 1_000n, quoteAmountRaw: 1_000n };
  const p = policy({ externalBuyersTarget: 5 });
  const cases: Array<[Partial<FastExitTrade>, Partial<FastExitTrade>]> = [
    [{ slot: 101n }, { slot: 100n }],
    [{ transactionIndex: 2 }, { transactionIndex: 1 }],
    [{ instructionIndex: 2 }, { instructionIndex: 1 }],
    [{ innerInstructionIndex: 0 }, { innerInstructionIndex: null }],
    [{ innerInstructionIndex: 3 }, { innerInstructionIndex: 2 }],
    [{ eventId: 'event-b' }, { eventId: 'event-a' }],
  ];
  for (const [later, earlier] of cases) {
    const laterHigh = trade({ ...high, ...later });
    const earlierLow = trade({ ...low, ...earlier });
    assert.equal(decideFastExit(facts({ trades: trades(laterHigh, earlierLow) }), p), 'TAKE_PROFIT');
    assert.equal(decideFastExit(facts({ trades: trades(earlierLow, laterHigh) }), p), 'TAKE_PROFIT');
    const laterLow = trade({ ...low, ...later });
    const earlierHigh = trade({ ...high, ...earlier });
    assert.equal(decideFastExit(facts({ trades: trades(earlierHigh, laterLow) }), p), null);
    assert.equal(decideFastExit(facts({ trades: trades(laterLow, earlierHigh) }), p), null);
  }
});

test('a last trade with zero base is skipped', () => {
  const p = policy({ externalBuyersTarget: 5 });
  const pump = trade({ trader: BUYER_A, baseAmountRaw: 1n, quoteAmountRaw: 1_000_000n, slot: 100n });
  const zero = trade({ trader: BUYER_B, baseAmountRaw: 0n, quoteAmountRaw: 0n, slot: 200n });
  assert.equal(decideFastExit(facts({ trades: trades(pump, zero) }), p), 'TAKE_PROFIT');
  const lowLater = trade({ trader: BUYER_B, baseAmountRaw: 1_000n, quoteAmountRaw: 1n, slot: 300n });
  assert.equal(decideFastExit(facts({ trades: trades(pump, zero, lowLater) }), p), null);
});

test('zero quote cost never takes profit', () => {
  const pump = trade({ trader: BUYER_A, baseAmountRaw: 1n, quoteAmountRaw: 1_000_000n });
  assert.equal(decideFastExit(facts({ quoteCostRaw: 0n, trades: trades(pump) }),
    policy({ externalBuyersTarget: 5 })), null);
});

test('malformed input throws TypeError', () => {
  const bad: Array<() => unknown> = [
    () => decideFastExit({ ...facts() }, policy()),
    () => decideFastExit(facts({ extra: 1 } as never), policy()),
    () => decideFastExit(facts({ envelopeState: 'UNKNOWN' }), policy()),
    () => decideFastExit(facts({ walletPublicKey: null }), policy()),
    () => decideFastExit(facts({ remainingBaseRaw: -1n }), policy()),
    () => decideFastExit(facts({ quoteCostRaw: 1 }), policy()),
    () => decideFastExit(facts(), { ...policy() }),
    () => decideFastExit(facts({ envelopeState: 'REVOKED' }), policy({ takeProfitBps: 1n })),
    () => decideFastExit(facts({ envelopeState: 'REVOKED', extra: 1 } as never), policy()),
    () => decideFastExit(facts({ quoteCostRaw: -1n }), policy()),
    () => decideFastExit(facts({ walletPublicKey: 'not-a-key' }), policy()),
    () => decideFastExit(facts(), policy({ takeProfitBps: 10_000n })),
    () => decideFastExit(facts(), policy({ takeProfitBps: 100_001n })),
    () => decideFastExit(facts(), policy({ externalBuyersTarget: 0 })),
    () => decideFastExit(facts(), policy({ externalBuyersTarget: 1_001 })),
    () => decideFastExit(facts(), policy({ externalMinimumBuyRaw: 0n })),
  ];
  for (const call of bad) assert.throws(call, TypeError);
  assert.equal(decideFastExit(facts(), policy({ takeProfitBps: 10_001n, externalBuyersTarget: 1_000 })), null);
  assert.equal(decideFastExit(facts(), policy({ takeProfitBps: 100_000n, externalBuyersTarget: 1 })), null);
});

test('logical command ids round-trip', () => {
  for (const reason of FAST_EXIT_REASONS) {
    const id = fastExitLogicalCommandId(reason, POSITION_ID);
    assert.equal(id, `fast-exit:${reason}:${POSITION_ID}`);
    assert.equal(exitReasonOfLogicalKey(id), reason);
  }
  assert.throws(() => fastExitLogicalCommandId('DEADLINE' as never, POSITION_ID), TypeError);
  assert.throws(() => fastExitLogicalCommandId('TAKE_PROFIT', 'position'), TypeError);
});

test('exit reason of a logical key', () => {
  assert.equal(exitReasonOfLogicalKey(`maximum-holding:${POSITION_ID}`), 'DEADLINE');
  assert.equal(exitReasonOfLogicalKey(`maximum-holding:${POSITION_ID}:retry-1`), 'DEADLINE');
  assert.equal(exitReasonOfLogicalKey(`fast-exit:TAKE_PROFIT:${POSITION_ID}:retry-2`), 'TAKE_PROFIT');
  for (const key of [
    `entry:${POSITION_ID}`, `fast-exit:DEADLINE:${POSITION_ID}`, `fast-exit:OTHER:${POSITION_ID}`,
    `maximum-holding:${POSITION_ID}:retry-4`, `maximum-holding:${POSITION_ID}:retry-0`,
    `maximum-holding:${POSITION_ID}:retry-1:retry-2`, 'maximum-holding:', '',
  ]) assert.equal(exitReasonOfLogicalKey(key), null, key);
  assert.equal(exitReasonOfLogicalKey(1 as never), null);
});

test('re-exit logical command id', () => {
  const root = fastExitLogicalCommandId('TAKE_PROFIT', POSITION_ID);
  assert.equal(reExitLogicalCommandId(root), `${root}:retry-1`);
  assert.equal(reExitLogicalCommandId(`${root}:retry-1`), `${root}:retry-2`);
  assert.equal(reExitLogicalCommandId(`${root}:retry-2`), `${root}:retry-3`);
  assert.equal(reExitLogicalCommandId(`${root}:retry-3`), null);
  const deadline = `maximum-holding:${POSITION_ID}`;
  assert.equal(reExitLogicalCommandId(deadline), `${deadline}:retry-1`);
  assert.equal(exitReasonOfLogicalKey(reExitLogicalCommandId(`${root}:retry-1`) ?? ''), 'TAKE_PROFIT');
  assert.equal(reExitLogicalCommandId('unknown:key'), null);
  assert.equal(reExitLogicalCommandId(`${root}:retry-4`), null);
});

const MALFORMED_TRADE_LISTS: ReadonlyArray<unknown> = [
  [trade()],
  Object.freeze([{ ...trade() }]),
  Object.freeze([trade(), trade({ kind: 'SWAP' as never })]),
  Object.freeze([trade(), trade({ baseAmountRaw: -1n })]),
  Object.freeze([trade(), trade({ slot: -1n })]),
  Object.freeze([trade(), trade({ transactionIndex: 1.5 })]),
  Object.freeze([trade(), trade({ innerInstructionIndex: -1 })]),
  Object.freeze([trade(), trade({ eventId: '' })]),
  Object.freeze([trade(), trade({ trader: 'not-a-key' })]),
  'not-a-list',
];

test('a revoked envelope exits regardless of trade data', () => {
  for (const list of MALFORMED_TRADE_LISTS) {
    assert.equal(decideFastExit(facts({ envelopeState: 'REVOKED', trades: list }), policy()), 'ENVELOPE_REVOKED');
  }
  assert.equal(decideFastExit(facts({ envelopeState: 'REVOKED', trades: Object.freeze([]) }), policy()),
    'ENVELOPE_REVOKED');
  assert.equal(decideFastExit(facts({ envelopeState: 'REVOKED', creator: 'not-a-key' }), policy()),
    'ENVELOPE_REVOKED');
});

test('a malformed trade drops the whole list without throwing', () => {
  const pump = trade({ trader: BUYER_A, baseAmountRaw: 1n, quoteAmountRaw: 1_000_000n, slot: 300n });
  const creatorSell = trade({ kind: 'SELL', trader: CREATOR, slot: 301n });
  const buyerB = trade({ trader: BUYER_B, slot: 302n });
  assert.equal(decideFastExit(facts({ trades: trades(pump, creatorSell, buyerB) }), policy()), 'CREATOR_SOLD');
  for (const list of MALFORMED_TRADE_LISTS) {
    assert.equal(decideFastExit(facts({ trades: list }), policy()), null);
  }
  const withBad = Object.freeze([pump, creatorSell, buyerB, trade({ slot: -1n })]);
  assert.equal(decideFastExit(facts({ trades: withBad }), policy()), null);
});

test('a malformed creator becomes unknown: no CREATOR_SOLD, buyers still counted', () => {
  const sell = trade({ kind: 'SELL', trader: CREATOR, quoteAmountRaw: 1n, baseAmountRaw: 1_000_000n, slot: 300n });
  assert.equal(decideFastExit(facts({ creator: 'not-a-key', trades: trades(sell) }), policy()), null);
  const buys = trades(trade({ trader: BUYER_A, slot: 101n }), trade({ trader: BUYER_B, slot: 102n }), sell);
  assert.equal(decideFastExit(facts({ creator: 'not-a-key', trades: buys }), policy()), 'EXTERNAL_BUYERS');
});

test('zero remaining base never takes profit', () => {
  const pump = trade({ trader: BUYER_A, baseAmountRaw: 1n, quoteAmountRaw: 1_000_000n });
  assert.equal(decideFastExit(facts({ remainingBaseRaw: 0n, trades: trades(pump) }),
    policy({ externalBuyersTarget: 5 })), null);
});

test('a SELL can be the last trade for take-profit', () => {
  const p = policy({ externalBuyersTarget: 5 });
  const lowBuy = trade({ trader: BUYER_A, baseAmountRaw: 1_000n, quoteAmountRaw: 1_000n, slot: 100n });
  const highSell = trade({ kind: 'SELL', trader: BUYER_B, baseAmountRaw: 1n, quoteAmountRaw: 1_000_000n, slot: 200n });
  assert.equal(decideFastExit(facts({ trades: trades(lowBuy, highSell) }), p), 'TAKE_PROFIT');
  const highBuy = trade({ trader: BUYER_A, baseAmountRaw: 1n, quoteAmountRaw: 1_000_000n, slot: 100n });
  const lowSell = trade({ kind: 'SELL', trader: BUYER_B, baseAmountRaw: 1_000n, quoteAmountRaw: 1_000n, slot: 200n });
  assert.equal(decideFastExit(facts({ trades: trades(highBuy, lowSell) }), p), null);
});
