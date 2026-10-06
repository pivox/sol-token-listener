import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotPosition, summarizePosition, type PositionEvidence, type Observation } from '../src/telemetry/position.js';

const entry: PositionEvidence = { runId: 'run', positionId: 'buy', mint: 'mint', buySignature: 'buy', wallet: 'own', quoteMint: 'SOL', entryAtMs: 1000, entrySlot: '100', amountInRaw: '1000', buyNetworkFeeRaw: '10', economicCostRaw: '1010', tokenAmountRaw: '100', sellNetworkFeeEstimateRaw: '5', solUsdt: '100', exit: null };
const observation = (atMs: number, out: string, trades: any[] = []): Observation => ({ id: `obs-${atMs}`, atMs, kind: 'market', creator: 'creator', coverage: 'OBSERVED', trades, clusters: [], relationships: [], graphAvailable: true, graphCoverage: null, quote: { status: 'AVAILABLE', venue: 'PUMP_FUN_BONDING_CURVE', observedAtMs: atMs, observedSlot: '102', stateReceivedAtMs: atMs - 100, stateSlot: '102', quoteCalculatedAtMs: atMs, validity: 'VALID', freshnessMs: 100, freshnessLimitMs: 10000, invalidReason: null, feeTreatment: 'SEPARATE', netPnlEstimateRaw: null, amountInRaw: '100', amountOutRaw: out, minimumAmountOutRaw: out, feesRaw: '1', slippageBps: '0', priceImpactBps: '1', metadataUnavailable: [] } });
const trade = (id: string, wallet: string, side: 'BUY' | 'SELL', raw: string, slot = '101'): any => ({ id, signature: id, wallet, side, quoteAmountRaw: raw, quoteMint: 'SOL', slot, observedAtMs: 2000, confirmation: 'finalized' });

void test('winner/loser and observed extrema change only on observed quote points', () => {
  const rows = [observation(5000, '1100'), observation(9000, '950'), observation(15000, '1200')];
  const a = snapshotPosition(entry, rows, 10000);
  assert.equal(a.netExecutablePnlRaw, '-66');
  assert.equal(a.observedMfeRaw, '84');
  assert.equal(a.observedMaeRaw, '-66');
  assert.equal(a.timeToMfeMs, 4000);
  const b = snapshotPosition(entry, rows, 20000);
  assert.equal(b.observedMfeRaw, '184');
  assert.equal(b.observedMaeRaw, '-66');
  assert.equal(b.timeToMfeMs, 14000);
  assert.equal(b.grossPnlRaw, '200');
});
void test('exact bigint volumes, repeated buyers, creator and separate related wallets', () => {
  const rows = [observation(5000, '1100', [trade('1','a','BUY','9007199254740993000'), trade('2','a','BUY','7'), trade('3','b','BUY','3'), trade('4','creator','SELL','8')])];
  required(rows[0]).clusters = [{ id: 'c', wallets: ['a','b'], sharedFunder: true }];
  required(rows[0]).relationships = [{ left: 'a', right: 'b', confidence: 'STRONG' }];
  const a = snapshotPosition(entry, rows, 6000);
  assert.equal(a.activity?.buyCount, 3);
  assert.equal(a.activity?.uniqueBuyers, 2);
  assert.equal(a.activity?.netQuoteFlowRaw, '9007199254740993002');
  assert.equal(a.activity?.buySellRatioBps, '30000');
  assert.equal(a.activity?.averageBuyPerBuyerRaw, '4503599627370496505');
  assert.equal(a.clusters?.buyersInClusters, 2);
  assert.equal(a.clusters?.largestBuyerCluster, 2);
  assert.equal(a.clusters?.sharedFunderCluster, true);
  assert.equal(a.creator?.creatorSellCount, 1);
  assert.equal(a.creator?.creatorNetFlowRaw, '-8');
  assert.equal(a.creator?.timeToFirstCreatorSellMs, 1000);
});
void test('momentum deltas, no SELL sentinel, unavailable is never zero', () => {
  const a = observation(5000, '1100', [trade('1','a','BUY','10')]);
  const b = observation(9000, '1200', [...a.trades, trade('2','b','BUY','20')]);
  const first = snapshotPosition(entry, [a], 6000);
  const next = snapshotPosition(entry, [a,b], 10000, first);
  assert.equal(first.activity?.buySellRatioBps, 'NO_SELL');
  assert.equal(next.momentum?.netFlowDeltaRaw, '20');
  assert.equal(next.momentum?.uniqueBuyersDelta, 1);
  const missing = snapshotPosition(entry, [], 6000);
  assert.equal(missing.activity, null);
  assert.equal(missing.netExecutablePnlRaw, null);
  assert.equal(missing.quote.status, 'UNAVAILABLE');
});
void test('future knowledge, unfinalized, own trades, same-slot ambiguity and orphan revisions excluded', () => {
  const t = trade('1','a','BUY','10');
  const a = observation(5000, '1100', [t, { ...trade('2','b','BUY','20'), confirmation: 'confirmed' }, trade('3','own','BUY','30'), trade('4','c','BUY','40','100')]);
  const b = observation(21001, '2000', [{ ...t, confirmation: 'orphaned' }]);
  assert.equal(snapshotPosition(entry, [a,b], 20000).activity?.buyVolumeQuoteRaw, '10');
  assert.equal(snapshotPosition(entry, [a,b], 22000).activity?.buyVolumeQuoteRaw, '0');
  assert.equal(snapshotPosition(entry, [a,b], 20000).quote.status, 'UNAVAILABLE');
});
void test('deduplicated observations and trades, closed targets unavailable, terminal summary', () => {
  const t = trade('1','a','BUY','10');
  const o = observation(5000, '1100', [t,t]);
  const closed = { ...entry, exit: { atMs: 9000, signature: 'sell', reason: 'net_profit_target', realizedNetPnlRaw: '70' } };
  assert.equal(snapshotPosition(entry, [o,o], 6000).activity?.buyCount, 1);
  assert.equal(snapshotPosition(closed, [o], 10000).quote.status, 'UNAVAILABLE');
  const summary = summarizePosition(closed, [o]);
  assert.equal(summary.realizedNetPnlRaw, '70');
  assert.equal(summary.observedMfeRaw, '84');
  assert.equal(summary.durationMs, 8000);
});

function required<T>(value: T | undefined | null): T { assert.ok(value != null); return value; }
