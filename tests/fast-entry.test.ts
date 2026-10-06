import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEntryDecisionId,
  decideFastEntryQuotes,
  precheckFastEntry,
} from '../src/domain/fast-entry.js';
import type { PaperExecutionQuote } from '../src/domain/paper-trading.js';

const SOL = 'So11111111111111111111111111111111111111112';
const MINT = 'MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const envelope = { envelopeId: 'env-1', perBuyQuoteAmountRaw: 100n };
const launch = { mint: MINT, quoteMint: SOL, creatorSoldInCreate: false };

void test('precheck accepte un lancement SOL sans vente createur avec enveloppe', () => {
  assert.equal(precheckFastEntry(launch, envelope), null);
});

void test('precheck rejette chaque branche', () => {
  assert.equal(
    precheckFastEntry({ ...launch, quoteMint: 'USDC' }, envelope),
    'UNSUPPORTED_QUOTE_MINT',
  );
  assert.equal(
    precheckFastEntry({ ...launch, creatorSoldInCreate: true }, envelope),
    'CREATOR_ALREADY_SOLD',
  );
  assert.equal(precheckFastEntry(launch, null), 'NO_ENVELOPE_CAPACITY');
});

void test('precheck respecte la precedence', () => {
  assert.equal(
    precheckFastEntry({ ...launch, quoteMint: 'USDC', creatorSoldInCreate: true }, null),
    'UNSUPPORTED_QUOTE_MINT',
  );
  assert.equal(
    precheckFastEntry({ ...launch, creatorSoldInCreate: true }, null),
    'CREATOR_ALREADY_SOLD',
  );
});

void test('decision BUY quand la perte est dans la limite', () => {
  const buy = quote(SOL, MINT, 100n, 95n, 90n);
  const sell = quote(MINT, SOL, 90n, 91n, 89n);
  assert.deepEqual(decideFastEntryQuotes(buy, sell, 1_100n), { decision: 'BUY', lossBps: 1_100n });
});

void test('decision REJECTED quand la perte depasse la limite', () => {
  const buy = quote(SOL, MINT, 100n, 95n, 90n);
  const sell = quote(MINT, SOL, 90n, 91n, 89n);
  assert.deepEqual(decideFastEntryQuotes(buy, sell, 1_099n), {
    decision: 'REJECTED',
    reason: 'ROUND_TRIP_LOSS_EXCEEDED',
    lossBps: 1_100n,
  });
});

void test('un montant inverse incoherent donne QUOTE_UNAVAILABLE', () => {
  const buy = quote(SOL, MINT, 100n, 95n, 90n);
  const sell = quote(MINT, SOL, 89n, 91n, 89n);
  assert.deepEqual(decideFastEntryQuotes(buy, sell, 10_000n), {
    decision: 'REJECTED',
    reason: 'QUOTE_UNAVAILABLE',
    lossBps: null,
  });
});

void test('createEntryDecisionId est stable, bien forme et distinct par mint', () => {
  const id = createEntryDecisionId(MINT);
  assert.equal(id, createEntryDecisionId(MINT));
  assert.match(id, /^entry_decision_[0-9a-f]{64}$/u);
  assert.notEqual(id, createEntryDecisionId(`${MINT}x`));
  assert.throws(() => createEntryDecisionId(''), TypeError);
  assert.throws(() => createEntryDecisionId(1 as unknown as string), TypeError);
});

function quote(
  inputMint: string,
  outputMint: string,
  amountInRaw: bigint,
  amountOutRaw: bigint,
  minimumAmountOutRaw: bigint,
): PaperExecutionQuote {
  return {
    id: `${inputMint}-${outputMint}`,
    inputMint,
    outputMint,
    amountInRaw,
    amountOutRaw,
    minimumAmountOutRaw,
    feesRaw: 0n,
    slippageBps: 100n,
    priceImpactBps: 0n,
    observedAtMs: 1_700_000_000_000,
    observedSlot: 1n,
  };
}
