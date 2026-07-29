import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WALLET_GRAPH_CONCENTRATION_SCALE_BPS,
  WALLET_GRAPH_METHODOLOGY,
  WALLET_GRAPH_PAYLOAD_VERSION,
  assertValidWalletGraphAnalysis,
  assertValidWalletGraphInput,
} from '../src/domain/wallet-graph.js';
import {
  graphInput,
} from './helpers/wallet-graph-fixture.js';

void test('publishes stable graph constants and accepts a frozen canonical input', () => {
  assert.equal(WALLET_GRAPH_PAYLOAD_VERSION, 1);
  assert.equal(WALLET_GRAPH_CONCENTRATION_SCALE_BPS, 10_000n);
  assert.equal(WALLET_GRAPH_METHODOLOGY, 'OBSERVED_PUMPFUN_TRANSACTIONS');
  assert.doesNotThrow(() => { assertValidWalletGraphInput(graphInput()); });
});

void test('rejects mutable input and duplicate positions, buys or evidence', () => {
  const canonical = graphInput();
  const firstPosition = canonical.positions[0];
  const firstBuy = canonical.buys[0];
  const firstEvidence = canonical.evidence[0];
  assert.ok(firstPosition);
  assert.ok(firstBuy);
  assert.ok(firstEvidence);
  assert.throws(
    () => { assertValidWalletGraphInput({ ...canonical }); },
    /frozen/u,
  );
  assert.throws(
    () => { assertValidWalletGraphInput(Object.freeze({
      ...canonical,
      positions: Object.freeze([
        firstPosition,
        firstPosition,
      ]),
    })); },
    /position|unique/u,
  );
  assert.throws(
    () => { assertValidWalletGraphInput(Object.freeze({
      ...canonical,
      buys: Object.freeze([firstBuy, firstBuy]),
    })); },
    /buy|unique/u,
  );
  assert.throws(
    () => { assertValidWalletGraphInput(Object.freeze({
      ...canonical,
      evidence: Object.freeze([
        firstEvidence,
        firstEvidence,
      ]),
    })); },
    /evidence|unique/u,
  );
});

void test('rejects mutable analysis and basis points above the scale', () => {
  const invalid = Object.freeze({
    relationships: Object.freeze([]),
    clusters: Object.freeze([Object.freeze({
      id: 'cluster',
      mint: 'mint',
      members: Object.freeze([]),
      participantWalletCount: 2,
      auxiliaryWalletCount: 0,
      positiveHolderCount: 2,
      observedPositiveBaseRaw: 1n,
      concentrationBps: 10_001n,
      containsCreator: false,
      sharedFunderCount: 0,
      strongRelationshipCount: 1,
      strongEvidenceCount: 1,
      quoteAssets: Object.freeze([]),
    })]),
    coverage: Object.freeze({
      knownBuyCount: 0,
      knownBuyerCount: 0,
      strongEvidenceBuyCount: 0,
      strongEvidenceBuyerCount: 0,
      mediumOnlyBuyCount: 0,
      mediumOnlyBuyerCount: 0,
      noEvidenceBuyCount: 0,
      noEvidenceBuyerCount: 0,
      unavailableBuyCount: 0,
      unavailableBuyerCount: 0,
      notProcessedBuyCount: 0,
      notProcessedBuyerCount: 0,
      analyzedTransactionCount: 0,
      evidenceCount: 0,
    }),
  });
  assert.throws(
    () => { assertValidWalletGraphAnalysis(invalid); },
    /basis|concentration|10000/u,
  );
});
