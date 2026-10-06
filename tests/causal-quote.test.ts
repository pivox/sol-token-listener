import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotPosition, type PositionEvidence, type Observation } from '../src/telemetry/position.js';
import { buildQuoteObservationRow, captureQuoteEvidence, QuoteObservationRecorder } from '../src/telemetry/quote-recorder.js';

const entry: PositionEvidence = { runId: 'r', positionId: 'p', mint: 'm', buySignature: 'b', wallet: 'w', quoteMint: 'SOL', entryAtMs: 1000, entrySlot: '10', amountInRaw: '100', buyNetworkFeeRaw: '1', economicCostRaw: '100', tokenAmountRaw: '10', costAvailableAtMs: 1500, sellNetworkFeeEstimateRaw: '5', solUsdt: null, exit: null };
const observation = (quote: any, atMs: number): Observation => ({ id: 'o', atMs, kind: 'quote', creator: null, coverage: 'UNAVAILABLE', trades: [], clusters: [], relationships: [], graphAvailable: false, graphCoverage: null, quote });

void test('state or quote received after decision is unavailable at that historical decision time', () => {
  const futureState = captureQuoteEvidence({ position: entry, stateReceivedAtMs: 5000, stateSlot: '11', quoteCalculatedAtMs: 5100, observedAtMs: 5200, amountOutRaw: '200', minimumAmountOutRaw: '190', feesRaw: null, feeTreatment: 'UNKNOWN', maxAgeMs: 10000 });
  const snapshot = snapshotPosition(entry, [observation(futureState, 5200)], 4000);
  assert.equal(snapshot.quote.status, 'UNAVAILABLE');
  assert.equal(snapshot.netExecutablePnlRaw, null);
  assert.equal(snapshot.quote.status === 'UNAVAILABLE' ? snapshot.quote.reason : '', 'FUTURE_OBSERVATION');
});

void test('quote evidence includes state timing, slot, fees, net estimate and freshness', () => {
  const quote = captureQuoteEvidence({ position: entry, stateReceivedAtMs: 3000, stateSlot: '11', quoteCalculatedAtMs: 3100, observedAtMs: 3150, amountOutRaw: '200', minimumAmountOutRaw: '190', feesRaw: '3', feeTreatment: 'SEPARATE', maxAgeMs: 10000 });
  assert.equal(quote.status, 'AVAILABLE');
  if (quote.status !== 'AVAILABLE') return;
  assert.equal(quote.stateReceivedAtMs, 3000);
  assert.equal(quote.stateSlot, '11');
  assert.equal(quote.quoteCalculatedAtMs, 3100);
  assert.equal(quote.freshnessMs, 150);
  assert.equal(quote.netPnlEstimateRaw, '82'); // 190 min-out - 100 cost - 5 network estimate - 3 separate fees.
  assert.equal(quote.feeTreatment, 'SEPARATE');
  const row = buildQuoteObservationRow('quote-id', entry, quote);
  assert.equal(row.positionId, 'p');
  assert.equal(row.mint, 'm');
  assert.equal(row.tokenAmountRaw, '10');
});

void test('unknown fee treatment keeps net PnL unknown; included fees are not subtracted twice', () => {
  const unknown = captureQuoteEvidence({ position: entry, stateReceivedAtMs: 3000, stateSlot: '11', quoteCalculatedAtMs: 3100, observedAtMs: 3150, amountOutRaw: '200', minimumAmountOutRaw: '190', feesRaw: '3', feeTreatment: 'UNKNOWN', maxAgeMs: 10000 });
  assert.equal(unknown.netPnlEstimateRaw, null);
  assert.deepEqual(unknown.metadataUnavailable, ['FEE_TREATMENT_UNKNOWN']);
  const included = captureQuoteEvidence({ position: entry, stateReceivedAtMs: 3000, stateSlot: '11', quoteCalculatedAtMs: 3100, observedAtMs: 3150, amountOutRaw: '200', minimumAmountOutRaw: '190', feesRaw: '3', feeTreatment: 'INCLUDED_IN_MIN_OUT', maxAgeMs: 10000 });
  assert.equal(included.netPnlEstimateRaw, '85');
});

void test('quote recorder is disabled by default and write failures are counted without throwing into caller', async () => {
  let writes = 0;
  const disabled = new QuoteObservationRecorder({ append: async () => { writes++; } });
  disabled.record({ id: 'one', schema: 'quote_observation.v1' });
  await disabled.flush();
  assert.equal(writes, 0);
  const enabled = new QuoteObservationRecorder({ enabled: true, append: async () => { writes++; throw new Error('disk'); } });
  enabled.record({ id: 'two', schema: 'quote_observation.v1' });
  await enabled.flush();
  assert.equal(writes, 1);
  assert.equal(enabled.health().writeErrors, 1);
  assert.equal(enabled.health().pending, 0);
});
