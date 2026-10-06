import test from 'node:test';
import assert from 'node:assert/strict';
import { lamportsForUsdt, requiredSellQuoteLamports, expectedNetProfitLamports, meetsProfitTarget } from './profit-policy.mjs';
test('converts 0.01 USDT at the entry SOL price with upward lamport rounding', () => assert.equal(lamportsForUsdt('0.01', '119.62'), 83599n));
test('last losing trade stays below the net target despite three external buys', () => {
  const buyCost = 8154010n;
  const sellQuote = 8133296n;
  assert.equal(expectedNetProfitLamports(sellQuote, buyCost, 50000n), -70714n);
  assert.equal(meetsProfitTarget(sellQuote, buyCost, 50000n, 83599n), false);
});
test('sets an on-chain minimum quote covering cost, sell fee reserve, and target', () => {
  const minimum = requiredSellQuoteLamports(8154010n, 50000n, 83599n);
  assert.equal(minimum, 8287609n);
  assert.equal(meetsProfitTarget(minimum, 8154010n, 50000n, 83599n), true);
  assert.equal(meetsProfitTarget(minimum - 1n, 8154010n, 50000n, 83599n), false);
});
test('rejects invalid negative or zero thresholds', () => { assert.throws(() => lamportsForUsdt('-0.01', '119.62')); assert.throws(() => lamportsForUsdt('0.01', '0')); });
