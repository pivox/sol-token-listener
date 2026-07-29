import assert from 'node:assert/strict';
import test from 'node:test';
import type { MarketQuote } from '../src/domain/market.js';
import { toPaperExecutionQuote } from '../src/paper/market-paper-quote.js';
import { validatePaperQuote } from '../src/paper/paper-math.js';

void test('market paper quote preserves every bigint without recalculation', () => {
  const quote: MarketQuote = {
    id: 'quote',
    pool: 'pool',
    inputMint: 'quote',
    outputMint: 'base',
    amountInRaw: 1_000n,
    amountOutRaw: 500n,
    minimumAmountOutRaw: 490n,
    feesRaw: 10n,
    slippageBps: 200n,
    priceImpactBps: 50n,
    observedAtMs: 2_000,
    observedSlot: 10n,
  };
  const paper = toPaperExecutionQuote(quote);
  assert.doesNotThrow(() => {
    validatePaperQuote(paper);
  });
  assert.equal(paper.amountInRaw, quote.amountInRaw);
  assert.equal(paper.amountOutRaw, quote.amountOutRaw);
  assert.equal(paper.minimumAmountOutRaw, quote.minimumAmountOutRaw);
  assert.equal(paper.feesRaw, quote.feesRaw);
  assert.ok(Object.isFrozen(paper));
});
