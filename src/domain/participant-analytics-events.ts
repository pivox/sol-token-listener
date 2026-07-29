import {
  createDeterministicChainEventId,
  type TypedDomainEvent,
} from './events.js';
import type {
  ActiveParticipantConfirmationStatus,
  CreatorProfile,
  HolderDistribution,
  ParticipantAnalyticsProjection,
  ParticipantConfirmationCounts,
} from './participant-analytics.js';
import type { ChainCursor } from './types.js';

export interface CreatorProfileUpdatedPayloadV1 {
  readonly inputFingerprint: string;
  readonly confirmationCounts: ParticipantConfirmationCounts;
  readonly profile: CreatorProfile;
}

export interface HolderDistributionUpdatedPayloadV1 {
  readonly inputFingerprint: string;
  readonly confirmationCounts: ParticipantConfirmationCounts;
  readonly distribution: HolderDistributionSummary;
}

export type HolderDistributionSummary = Omit<HolderDistribution, 'positions'>;

export type CreatorProfileUpdatedEventV1 = TypedDomainEvent<
  'CreatorProfileUpdated',
  CreatorProfileUpdatedPayloadV1,
  1
>;

export type HolderDistributionUpdatedEventV1 = TypedDomainEvent<
  'HolderDistributionUpdated',
  HolderDistributionUpdatedPayloadV1,
  1
>;

export type ParticipantAnalyticsDerivedEventV1 =
  | CreatorProfileUpdatedEventV1
  | HolderDistributionUpdatedEventV1;

interface ParticipantAnalyticsEventEnvelope {
  readonly id: string;
  readonly mint: string;
  readonly source: string;
  readonly program: string;
  readonly signature: string;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: ActiveParticipantConfirmationStatus;
  readonly blockchainTimeMs: null;
  readonly observedAtMs: number;
}

export function createCreatorProfileUpdatedEvent(
  projection: ParticipantAnalyticsProjection,
): CreatorProfileUpdatedEventV1 {
  const type = 'CreatorProfileUpdated';
  return Object.freeze({
    ...eventEnvelope(projection, type),
    type,
    payloadVersion: 1,
    payload: Object.freeze({
      inputFingerprint: projection.inputFingerprint,
      confirmationCounts: projection.confirmationCounts,
      profile: projection.profile,
    }),
  });
}

export function createHolderDistributionUpdatedEvent(
  projection: ParticipantAnalyticsProjection,
): HolderDistributionUpdatedEventV1 {
  const type = 'HolderDistributionUpdated';
  return Object.freeze({
    ...eventEnvelope(projection, type),
    type,
    payloadVersion: 1,
    payload: Object.freeze({
      inputFingerprint: projection.inputFingerprint,
      confirmationCounts: projection.confirmationCounts,
      distribution: holderDistributionSummary(projection.distribution),
    }),
  });
}

function holderDistributionSummary(
  distribution: HolderDistribution,
): HolderDistributionSummary {
  return Object.freeze({
    mint: distribution.mint,
    creator: distribution.creator,
    payloadVersion: distribution.payloadVersion,
    inputFingerprint: distribution.inputFingerprint,
    totalPositiveNetBaseRaw: distribution.totalPositiveNetBaseRaw,
    top1Bps: distribution.top1Bps,
    top5Bps: distribution.top5Bps,
    top10Bps: distribution.top10Bps,
    creatorBps: distribution.creatorBps,
    uniqueKnownBuyers: distribution.uniqueKnownBuyers,
    uniqueExternalBuyers: distribution.uniqueExternalBuyers,
    positivePositionCount: distribution.positivePositionCount,
    unknownTraderTradeCount: distribution.unknownTraderTradeCount,
  });
}

function eventEnvelope(
  projection: ParticipantAnalyticsProjection,
  type: 'CreatorProfileUpdated' | 'HolderDistributionUpdated',
): ParticipantAnalyticsEventEnvelope {
  const { launch, asOf } = projection;
  return {
    id: createDeterministicChainEventId({
      type,
      mint: launch.mint,
      source: launch.source,
      program: launch.program,
      signature: asOf.signature,
      cursor: asOf.cursor,
    }),
    mint: launch.mint,
    source: launch.source,
    program: launch.program,
    signature: asOf.signature,
    cursor: asOf.cursor,
    confirmationStatus: projection.confirmationStatus,
    blockchainTimeMs: null,
    observedAtMs: asOf.observedAtMs,
  };
}
