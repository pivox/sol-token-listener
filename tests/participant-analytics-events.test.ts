import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMAIN_EVENT_TYPES } from '../src/domain/events.js';
import {
  createCreatorProfileUpdatedEvent,
  createHolderDistributionUpdatedEvent,
} from '../src/domain/participant-analytics-events.js';
import type { ParticipantAnalyticsProjection } from '../src/domain/participant-analytics.js';

void test('publie les deux événements dérivés avec des identités stables distinctes', () => {
  const projection = makeProjection();
  const profileEvent = createCreatorProfileUpdatedEvent(projection);
  const repeatedProfileEvent = createCreatorProfileUpdatedEvent({
    ...projection,
    profile: Object.freeze({
      ...projection.profile,
      unknownTraderTradeCount: 1,
    }),
  });
  const holderEvent = createHolderDistributionUpdatedEvent(projection);

  assert.equal(DOMAIN_EVENT_TYPES.filter((type) => type === 'HolderDistributionUpdated').length, 1);
  assert.equal(profileEvent.type, 'CreatorProfileUpdated');
  assert.equal(holderEvent.type, 'HolderDistributionUpdated');
  assert.equal(profileEvent.id, repeatedProfileEvent.id);
  assert.notEqual(profileEvent.id, holderEvent.id);
  assert.equal(profileEvent.cursor, projection.asOf.cursor);
  assert.equal(profileEvent.confirmationStatus, projection.confirmationStatus);
  assert.equal(profileEvent.payload.inputFingerprint, projection.inputFingerprint);
  assert.equal(profileEvent.payload.confirmationCounts.confirmed, 2);
  assert.equal(Object.isFrozen(profileEvent.payload), true);
});

void test('change l’identité lorsque le curseur as-of change', () => {
  const projection = makeProjection();
  const moved: ParticipantAnalyticsProjection = Object.freeze({
    ...projection,
    asOf: Object.freeze({
      ...projection.asOf,
      eventId: 'trade-event-2',
      signature: 'trade-signature-2',
      cursor: Object.freeze({
        ...projection.asOf.cursor,
        instructionIndex: 3,
      }),
    }),
  });

  assert.notEqual(
    createCreatorProfileUpdatedEvent(projection).id,
    createCreatorProfileUpdatedEvent(moved).id,
  );
});

function makeProjection(): ParticipantAnalyticsProjection {
  const cursor = Object.freeze({
    slot: 10n,
    transactionIndex: 0,
    instructionIndex: 2,
    innerInstructionIndex: null,
  });
  const launch = Object.freeze({
    eventId: 'launch-event',
    mint: 'mint',
    creator: 'creator',
    source: 'pumpfun',
    program: 'pump-program',
    signature: 'create-signature',
    cursor: Object.freeze({ ...cursor, instructionIndex: 1 }),
    confirmationStatus: 'confirmed' as const,
    observedAtMs: 1_720_000_000_000,
  });
  const profile = Object.freeze({
    mint: 'mint',
    creator: 'creator',
    payloadVersion: 1 as const,
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
  const distribution = Object.freeze({
    mint: 'mint',
    creator: 'creator',
    payloadVersion: 1 as const,
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
  return Object.freeze({
    launch,
    inputFingerprint: 'fingerprint',
    asOf: Object.freeze({
      eventId: 'trade-event',
      signature: 'trade-signature',
      cursor,
      observedAtMs: 1_720_000_000_001,
    }),
    confirmationStatus: 'confirmed',
    confirmationCounts: Object.freeze({
      processed: 0,
      confirmed: 2,
      finalized: 0,
    }),
    profile,
    distribution,
  });
}
