import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WalletGraphAnalyzer,
} from '../src/analytics/wallet-graph-analyzer.js';
import {
  BUYER_A,
  BUYER_B,
  BUYER_C,
  CREATOR,
  OTHER_FUNDER,
  QUOTE_USDC,
  SHARED_FUNDER,
  assessment,
  buy,
  directEvidence,
  feeEvidence,
  graphInput,
  position,
} from './helpers/wallet-graph-fixture.js';

const analyzer = new WalletGraphAnalyzer();

void test('builds one deterministic shared-funder cluster with bigint concentration', () => {
  const result = analyzer.analyze(graphInput());

  assert.equal(result.relationships.length, 2);
  assert.equal(result.clusters.length, 1);
  const cluster = result.clusters[0];
  assert.ok(cluster);
  assert.equal(cluster.participantWalletCount, 2);
  assert.equal(cluster.auxiliaryWalletCount, 1);
  assert.equal(cluster.observedPositiveBaseRaw, 75n);
  assert.equal(cluster.concentrationBps, 7_500n);
  assert.equal(cluster.sharedFunderCount, 1);
  assert.deepEqual(cluster.quoteAssets, [
    {
      mint: 'So11111111111111111111111111111111111111112',
      decimals: 9,
      tokenProgram: 'SPL_TOKEN',
    },
  ]);
  assert.deepEqual(result.relationships.map((relationship) => [
    relationship.firstObservedCursor.instructionIndex,
    relationship.lastObservedCursor.instructionIndex,
  ]).sort((left, right) => (left[0] ?? 0) - (right[0] ?? 0)), [
    [1, 1],
    [2, 2],
  ]);
  assert.deepEqual(
    cluster.members.map((member) => member.wallet),
    [BUYER_A, BUYER_B, SHARED_FUNDER],
  );

  const shuffled = graphInput({
    positions: Object.freeze([...graphInput().positions].reverse()),
    buys: Object.freeze([...graphInput().buys].reverse()),
    assessments: Object.freeze([...graphInput().assessments].reverse()),
    evidence: Object.freeze([...graphInput().evidence].reverse()),
  });
  assert.deepEqual(analyzer.analyze(shuffled), result);
});

void test('keeps medium fee-payer relations outside components', () => {
  const tradeA = buy('medium-a', BUYER_A, 2);
  const tradeB = buy('medium-b', BUYER_B, 3);
  const evidenceA = feeEvidence(tradeA, SHARED_FUNDER);
  const evidenceB = feeEvidence(tradeB, SHARED_FUNDER);
  const result = analyzer.analyze(graphInput({
    buys: Object.freeze([tradeA, tradeB]),
    assessments: Object.freeze([
      assessment(tradeA, 'MEDIUM_ONLY', [evidenceA]),
      assessment(tradeB, 'MEDIUM_ONLY', [evidenceB]),
    ]),
    evidence: Object.freeze([evidenceA, evidenceB]),
  }));

  assert.equal(result.relationships.length, 2);
  assert.equal(result.relationships.every((item) =>
    item.confidence === 'MEDIUM'), true);
  assert.equal(result.relationships.every((item) =>
    item.quoteTotals.length === 0), true);
  assert.equal(result.clusters.length, 0);
});

void test('requires two participants, includes the creator and excludes negative concentration', () => {
  const creatorBuy = buy('creator-buy', CREATOR, 2);
  const buyerBuy = buy('buyer-buy', BUYER_A, 3);
  const creatorEvidence = directEvidence(
    creatorBuy,
    SHARED_FUNDER,
    10n,
  );
  const buyerEvidence = directEvidence(
    buyerBuy,
    SHARED_FUNDER,
    20n,
  );
  const result = analyzer.analyze(graphInput({
    positions: Object.freeze([
      position(CREATOR, 40n),
      position(BUYER_A, -10n),
      position(BUYER_C, 60n),
    ]),
    buys: Object.freeze([creatorBuy, buyerBuy]),
    assessments: Object.freeze([
      assessment(creatorBuy, 'STRONG', [creatorEvidence]),
      assessment(buyerBuy, 'STRONG', [buyerEvidence]),
    ]),
    evidence: Object.freeze([creatorEvidence, buyerEvidence]),
  }));

  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0]?.containsCreator, true);
  assert.equal(result.clusters[0]?.observedPositiveBaseRaw, 40n);
  assert.equal(result.clusters[0]?.concentrationBps, 4_000n);

  const oneParticipant = analyzer.analyze(graphInput({
    positions: Object.freeze([position(BUYER_A, 10n)]),
    buys: Object.freeze([buyerBuy]),
    assessments: Object.freeze([
      assessment(buyerBuy, 'STRONG', [buyerEvidence]),
    ]),
    evidence: Object.freeze([buyerEvidence]),
  }));
  assert.equal(oneParticipant.clusters.length, 0);
});

void test('groups direct amounts by quote asset without cross-asset sums', () => {
  const first = buy('multi-a', BUYER_A, 3);
  const second = buy('multi-b', BUYER_A, 5, {
    quoteAsset: QUOTE_USDC,
  });
  const solEvidence = directEvidence(first, OTHER_FUNDER, 10n);
  const usdcEvidence = directEvidence(second, OTHER_FUNDER, 20n);
  const result = analyzer.analyze(graphInput({
    buys: Object.freeze([first, second]),
    assessments: Object.freeze([
      assessment(first, 'STRONG', [solEvidence]),
      assessment(second, 'STRONG', [usdcEvidence]),
    ]),
    evidence: Object.freeze([solEvidence, usdcEvidence]),
  }));

  assert.equal(result.relationships.length, 1);
  assert.deepEqual(
    result.relationships[0]?.quoteTotals.map((total) => [
      total.quoteAsset.mint,
      total.amountRaw,
    ]),
    [
      ['So11111111111111111111111111111111111111112', 10n],
      ['usdc-mint', 20n],
    ],
  );
  assert.deepEqual(
    result.relationships[0]?.firstObservedCursor,
    solEvidence.transferCursor,
  );
  assert.deepEqual(
    result.relationships[0]?.lastObservedCursor,
    usdcEvidence.transferCursor,
  );
});

void test('reports mutually exclusive conservative coverage including not processed buys', () => {
  const strongBuy = buy('coverage-strong', BUYER_A, 2);
  const mediumBuy = buy('coverage-medium', BUYER_B, 3);
  const missingBuy = buy('coverage-missing', BUYER_C, 4);
  const unavailableBuy = buy('coverage-unavailable', 'buyer-d', 5);
  const noneBuy = buy('coverage-none', 'buyer-e', 6);
  const strong = directEvidence(strongBuy, SHARED_FUNDER, 10n);
  const medium = feeEvidence(mediumBuy, OTHER_FUNDER);
  const result = analyzer.analyze(graphInput({
    positions: Object.freeze([]),
    buys: Object.freeze([
      strongBuy, mediumBuy, missingBuy, unavailableBuy, noneBuy,
    ]),
    assessments: Object.freeze([
      assessment(strongBuy, 'STRONG', [strong]),
      assessment(mediumBuy, 'MEDIUM_ONLY', [medium]),
      assessment(
        unavailableBuy,
        'UNAVAILABLE',
        [],
        Object.freeze(['OWNER_AMBIGUOUS']),
      ),
      assessment(noneBuy, 'NO_EVIDENCE', []),
    ]),
    evidence: Object.freeze([strong, medium]),
  }));

  assert.deepEqual(result.coverage, {
    knownBuyCount: 5,
    knownBuyerCount: 5,
    strongEvidenceBuyCount: 1,
    strongEvidenceBuyerCount: 1,
    mediumOnlyBuyCount: 1,
    mediumOnlyBuyerCount: 1,
    noEvidenceBuyCount: 1,
    noEvidenceBuyerCount: 1,
    unavailableBuyCount: 1,
    unavailableBuyerCount: 1,
    notProcessedBuyCount: 1,
    notProcessedBuyerCount: 1,
    analyzedTransactionCount: 4,
    evidenceCount: 2,
  });
  assert.deepEqual(result.clusters, []);
});
