import assert from 'node:assert/strict';
import test from 'node:test';
import type { PaperExecutionQuote } from '../src/domain/paper-trading.js';
import {
  calculateRoundTrip,
  validatePaperQuote,
} from '../src/paper/paper-math.js';

void test('calcule une perte aller-retour bigint avec arrondi plafond', () => {
  const buy = quote('SOL', 'MINT', 100n, 95n, 90n);
  const sell = quote('MINT', 'SOL', 90n, 91n, 89n);

  assert.deepEqual(calculateRoundTrip(buy, sell), {
    quoteCostRaw: 100n,
    baseFilledRaw: 90n,
    returnRaw: 89n,
    lossRaw: 11n,
    lossBps: 1_100n,
  });
});

void test('rejette un minimum de sortie supérieur au montant coté', () => {
  assert.throws(
    () => {
      validatePaperQuote(quote('SOL', 'MINT', 100n, 90n, 91n));
    },
    /minimumAmountOutRaw/u,
  );
});

void test('rejette une quote inverse qui ne consomme pas le fill conservateur', () => {
  const buy = quote('SOL', 'MINT', 100n, 95n, 90n);
  const sell = quote('MINT', 'SOL', 89n, 91n, 89n);

  assert.throws(() => calculateRoundTrip(buy, sell), /amountInRaw/u);
});

function quote(
  inputMint: string,
  outputMint: string,
  amountInRaw: bigint,
  amountOutRaw: bigint,
  minimumAmountOutRaw: bigint,
): PaperExecutionQuote {
  return {
    id: `${inputMint}:${outputMint}:${amountInRaw}`,
    inputMint,
    outputMint,
    amountInRaw,
    amountOutRaw,
    minimumAmountOutRaw,
    feesRaw: 1n,
    slippageBps: 100n,
    priceImpactBps: 50n,
    observedAtMs: 1,
    observedSlot: 1n,
  };
}
