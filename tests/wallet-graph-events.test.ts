import assert from 'node:assert/strict';
import test from 'node:test';
import { WalletGraphAnalyzer } from '../src/analytics/wallet-graph-analyzer.js';
import {
  createWalletClusterDetectedEvent,
} from '../src/domain/wallet-graph-events.js';
import {
  WALLET_GRAPH_METHODOLOGY,
  type WalletGraphProjection,
} from '../src/domain/wallet-graph.js';
import { graphInput } from './helpers/wallet-graph-fixture.js';

void test('publishes a bounded aggregate event with stable chain identity', () => {
  const projection = makeProjection();
  const event = createWalletClusterDetectedEvent(projection);
  const revised = createWalletClusterDetectedEvent(Object.freeze({
    ...projection,
    inputFingerprint: 'revised-fingerprint',
    confirmationStatus: 'processed',
  }));

  assert.equal(event.type, 'WalletClusterDetected');
  assert.equal(event.cursor, projection.asOf.cursor);
  assert.equal(event.payload.inputFingerprint, projection.inputFingerprint);
  assert.equal(event.payload.clusterCount, projection.clusters.length);
  assert.equal(event.payload.strongRelationshipCount, 2);
  assert.equal(event.payload.mediumRelationshipCount, 0);
  assert.equal(event.payload.maximumClusterBps, 7_500n);
  assert.equal(event.payload.creatorClusterCount, 0);
  assert.equal('clusters' in event.payload, false);
  assert.equal('members' in event.payload, false);
  assert.equal('relationships' in event.payload, false);
  assert.equal(event.id, revised.id);
  assert.equal(Object.isFrozen(event.payload), true);
});

void test('changes event identity only when the as-of chain location moves', () => {
  const projection = makeProjection();
  const moved = Object.freeze({
    ...projection,
    asOf: Object.freeze({
      ...projection.asOf,
      eventId: 'moved-event',
      signature: 'moved-signature',
      cursor: Object.freeze({
        ...projection.asOf.cursor,
        instructionIndex: projection.asOf.cursor.instructionIndex + 1,
      }),
    }),
  });
  assert.notEqual(
    createWalletClusterDetectedEvent(projection).id,
    createWalletClusterDetectedEvent(moved).id,
  );
});

function makeProjection(): WalletGraphProjection {
  const input = graphInput();
  const analysis = new WalletGraphAnalyzer().analyze(input);
  const latest = input.buys[1];
  assert.ok(latest);
  return Object.freeze({
    launch: input.launch,
    inputFingerprint: input.inputFingerprint,
    methodology: WALLET_GRAPH_METHODOLOGY,
    asOf: Object.freeze({
      eventId: latest.eventId,
      signature: latest.signature,
      cursor: latest.cursor,
      observedAtMs: latest.observedAtMs,
    }),
    confirmationStatus: 'confirmed',
    confirmationCounts: Object.freeze({
      processed: 0,
      confirmed: 5,
      finalized: 0,
    }),
    ...analysis,
  });
}
