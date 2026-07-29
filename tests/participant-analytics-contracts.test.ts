import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertValidCreatorProfile,
  assertValidHolderDistribution,
  assertValidParticipantAnalyticsInput,
  HOLDER_CONCENTRATION_SCALE_BPS,
  PARTICIPANT_ANALYTICS_CONFIRMATION_ORDER,
  PARTICIPANT_ANALYTICS_PAYLOAD_VERSION,
  type CreatorProfile,
  type HolderDistribution,
  type ParticipantAnalyticsInput,
} from '../src/domain/participant-analytics.js';

const cursor = Object.freeze({
  slot: 10n,
  transactionIndex: 0,
  instructionIndex: 1,
  innerInstructionIndex: null,
});
const quoteAsset = Object.freeze({
  mint: 'quote',
  decimals: 9,
  tokenProgram: 'SPL_TOKEN' as const,
});
const launch = Object.freeze({
  eventId: 'launch-event',
  mint: 'mint',
  creator: 'creator',
  source: 'pumpfun',
  program: 'pump-program',
  signature: 'create-signature',
  cursor,
  confirmationStatus: 'confirmed' as const,
  observedAtMs: 1_720_000_000_000,
});
const trade = Object.freeze({
  eventId: 'trade-event',
  tradeId: 'trade',
  launchMint: 'mint',
  signature: 'trade-signature',
  cursor: Object.freeze({ ...cursor, instructionIndex: 2 }),
  confirmationStatus: 'confirmed' as const,
  observedAtMs: 1_720_000_000_001,
  kind: 'BUY' as const,
  trader: 'buyer',
  baseAmountRaw: 10n,
  quoteAmountRaw: 2n,
  quoteAsset,
});
const input: ParticipantAnalyticsInput = Object.freeze({
  launch,
  trades: Object.freeze([trade]),
  inputFingerprint: 'fingerprint',
});

void test('publie les constantes stables de participant analytics', () => {
  assert.equal(PARTICIPANT_ANALYTICS_PAYLOAD_VERSION, 1);
  assert.equal(HOLDER_CONCENTRATION_SCALE_BPS, 10_000n);
  assert.deepEqual(PARTICIPANT_ANALYTICS_CONFIRMATION_ORDER, [
    'processed',
    'confirmed',
    'finalized',
  ]);
});

void test('valide une entrée canonique immuable', () => {
  assert.doesNotThrow(() => assertValidParticipantAnalyticsInput(input));
});

void test('refuse les montants, mints, curseurs et objets mutables incohérents', () => {
  assert.throws(() => assertValidParticipantAnalyticsInput({
    ...input,
    trades: Object.freeze([{ ...trade, baseAmountRaw: -1n }]),
  }));
  assert.throws(() => assertValidParticipantAnalyticsInput({
    ...input,
    trades: Object.freeze([{ ...trade, launchMint: 'other' }]),
  }));
  assert.throws(() => assertValidParticipantAnalyticsInput({
    ...input,
    trades: Object.freeze([trade, { ...trade }]),
  }));
  assert.throws(() => assertValidParticipantAnalyticsInput({
    ...input,
    launch: { ...launch, cursor: { ...cursor } },
  }));
  assert.throws(() => assertValidParticipantAnalyticsInput({
    ...input,
    trades: Object.freeze([{
      ...trade,
      quoteAsset: Object.freeze({ ...quoteAsset, decimals: 256 }),
    }]),
  }));
});

void test('valide les projections et refuse les basis points hors échelle', () => {
  const profile: CreatorProfile = Object.freeze({
    mint: 'mint',
    creator: 'creator',
    payloadVersion: 1,
    inputFingerprint: 'fingerprint',
    buyCount: 0,
    sellCount: 0,
    totalBoughtBaseRaw: 0n,
    totalSoldBaseRaw: 0n,
    observedNetBaseRaw: 0n,
    hasSold: false,
    firstSell: null,
    initialBuys: Object.freeze([]),
    quoteFlows: Object.freeze([]),
    uniqueExternalBuyers: 0,
    unknownTraderTradeCount: 0,
  });
  const distribution: HolderDistribution = Object.freeze({
    mint: 'mint',
    creator: 'creator',
    payloadVersion: 1,
    inputFingerprint: 'fingerprint',
    positions: Object.freeze([]),
    totalPositiveNetBaseRaw: 0n,
    top1Bps: 0n,
    top5Bps: 0n,
    top10Bps: 0n,
    creatorBps: 0n,
    uniqueKnownBuyers: 0,
    uniqueExternalBuyers: 0,
    positivePositionCount: 0,
    unknownTraderTradeCount: 0,
  });

  assert.doesNotThrow(() => assertValidCreatorProfile(profile));
  assert.doesNotThrow(() => assertValidHolderDistribution(distribution));
  assert.throws(() => assertValidHolderDistribution({
    ...distribution,
    top1Bps: 10_001n,
  }));
});
