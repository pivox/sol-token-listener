import {
  createDeterministicChainEventId,
  type TypedDomainEvent,
} from './events.js';
import {
  assertValidWalletGraphProjection,
  type WalletGraphConfirmationCounts,
  type WalletGraphCoverage,
  type WalletGraphProjection,
} from './wallet-graph.js';

export interface WalletClusterDetectedPayloadV1 {
  readonly inputFingerprint: string;
  readonly methodology: 'OBSERVED_PUMPFUN_TRANSACTIONS';
  readonly coverage: WalletGraphCoverage;
  readonly strongRelationshipCount: number;
  readonly mediumRelationshipCount: number;
  readonly clusterCount: number;
  readonly maximumClusterBps: bigint;
  readonly creatorClusterCount: number;
  readonly confirmationCounts: WalletGraphConfirmationCounts;
}

export type WalletClusterDetectedEventV1 = TypedDomainEvent<
  'WalletClusterDetected',
  WalletClusterDetectedPayloadV1,
  1
>;

export function createWalletClusterDetectedEvent(
  projection: WalletGraphProjection,
): WalletClusterDetectedEventV1 {
  assertValidWalletGraphProjection(projection);
  const { launch, asOf } = projection;
  const type = 'WalletClusterDetected';
  return Object.freeze({
    id: createDeterministicChainEventId({
      type,
      mint: launch.mint,
      source: launch.source,
      program: launch.program,
      signature: asOf.signature,
      cursor: asOf.cursor,
    }),
    type,
    mint: launch.mint,
    source: launch.source,
    program: launch.program,
    signature: asOf.signature,
    cursor: asOf.cursor,
    confirmationStatus: projection.confirmationStatus,
    blockchainTimeMs: null,
    observedAtMs: asOf.observedAtMs,
    payloadVersion: 1,
    payload: Object.freeze({
      inputFingerprint: projection.inputFingerprint,
      methodology: projection.methodology,
      coverage: projection.coverage,
      strongRelationshipCount: projection.relationships.filter(
        (item) => item.confidence === 'STRONG',
      ).length,
      mediumRelationshipCount: projection.relationships.filter(
        (item) => item.confidence === 'MEDIUM',
      ).length,
      clusterCount: projection.clusters.length,
      maximumClusterBps: projection.clusters.reduce(
        (maximum, cluster) =>
          cluster.concentrationBps > maximum ? cluster.concentrationBps : maximum,
        0n,
      ),
      creatorClusterCount: projection.clusters.filter(
        (cluster) => cluster.containsCreator,
      ).length,
      confirmationCounts: projection.confirmationCounts,
    }),
  });
}
