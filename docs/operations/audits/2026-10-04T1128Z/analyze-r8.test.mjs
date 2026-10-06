import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLines, reconcileTrade, buildReport } from './analyze-r8.mjs';

test('wallet delta excludes refundable token account rent from position cost once', () => {
  const result = reconcileTrade({ buyBefore: 10000000n, buyAfter: 0n, rent: 1500000n, sellBefore: 0n, sellAfter: 8500000n, buyFee: 45000n, sellFee: 45000n, quote: 8545000n });
  assert.equal(result.buyCostExRent, 8500000n);
  assert.equal(result.sellWalletDelta, 8500000n);
  assert.equal(result.pnlWithRentRecoverable, 0n);
  assert.equal(result.totalNetworkFees, 90000n);
});

test('confirmed transaction fees are disclosed once and sale quote gap remains visible', () => {
  const result = reconcileTrade({ buyBefore: 10000000n, buyAfter: 0n, rent: 0n, sellBefore: 0n, sellAfter: 8545000n, buyFee: 45000n, sellFee: 45000n, quote: 8000000n });
  assert.equal(result.sellProceedsInferred, 8590000n);
  assert.equal(result.quoteGapInferred, 590000n);
  assert.equal(result.pnlWithRentRecoverable, -1455000n);
});

test('malformed or non-JSON log lines are ignored as non-events, not zero-valued rows', () => {
  assert.deepEqual(parseJsonLines('{"event":"confirmed"}\nnot-json\n'), [{ event: 'confirmed' }]);
});

test('r8 wallet change reconciles to trade PnL only after adding six recoverable rents', () => {
  const report = buildReport();
  assert.equal(report.trades.length, 6);
  assert.equal(report.summary.observedMints, 135);
  assert.equal(report.summary.uniqueMintsAcrossWaves, 135);
  assert.equal(report.summary.walletCashDeltaLamports, '-17922159');
  assert.equal(report.summary.emptyTokenAccountRentLamports, '9083040');
  assert.equal(report.summary.economicPnlLamports, '-8839119');
  assert.equal(report.summary.differenceReconciliationLamports, '0');
});
