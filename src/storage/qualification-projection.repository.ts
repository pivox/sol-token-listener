import { createTokenLaunchDetectedEvent } from '../domain/launchpad-events.js';
import type { DomainEvent, DomainEventType } from '../domain/events.js';
import type {
  MetadataFailureReason,
  TokenMetadataSnapshot,
} from '../domain/pumpfun-observation.js';
import {
  assertValidCreatorProfile,
  assertValidHolderDistribution,
  type CreatorProfile,
  type HolderDistribution,
} from '../domain/participant-analytics.js';
import {
  createSocialCollection,
  socialMetadataSnapshotId,
  type SocialEvidenceCollectionV1,
  type SocialEvidenceOutcome,
  type SocialEvidenceType,
  type SocialHttpObservationV1,
  type SocialLinkV1,
  type SocialLinkKind,
  type SocialVerificationEvidenceV1,
} from '../domain/social-evidence.js';
import type {
  ChainConfirmationStatus,
  ChainCursor,
  QuoteAsset,
  TokenLaunch,
} from '../domain/types.js';
import {
  assertValidWalletGraphAnalysis,
  type WalletCluster,
  type WalletGraphAnalysis,
  type WalletGraphCoverage,
  type WalletRelationship,
} from '../domain/wallet-graph.js';
import type {
  CanonicalQualificationProjection,
  QualificationCanonicalSnapshot,
  QualificationProjectionRepository,
  QualificationProjectionTransaction,
} from '../ports/qualification-projection-repository.js';
import { canonicalStringifyJson, fromJsonValue, toJsonValue } from '../utils/json.js';

interface QueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number | null;
}

interface QualificationProjectionClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(): void;
}

export interface QualificationProjectionPool {
  connect(): Promise<QualificationProjectionClient>;
}

export interface QualificationProjectionAuthority {
  reauthorize(projection: CanonicalQualificationProjection): unknown;
}

export class QualificationProjectionDataError extends Error {
  public constructor(message = 'Stored qualification projection data is invalid.') {
    super(message);
    this.name = 'QualificationProjectionDataError';
  }
}

export class QualificationProjectionRepositoryError extends Error {
  public constructor() {
    super('Qualification projection transaction failed.');
    this.name = 'QualificationProjectionRepositoryError';
  }
}

export class PostgresQualificationProjectionRepository
implements QualificationProjectionRepository {
  public constructor(
    private readonly database: QualificationProjectionPool,
    private readonly authority: QualificationProjectionAuthority,
  ) {}

  public async transact<TResult>(
    mint: string,
    operation: (transaction: QualificationProjectionTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    if (
      mint.length === 0
      || mint.trim() !== mint
      || Buffer.byteLength(mint, 'utf8') > 16_384
    ) throw new TypeError('Qualification projection mint is required.');
    let client: QualificationProjectionClient;
    try {
      client = await this.database.connect();
    } catch {
      throw new QualificationProjectionRepositoryError();
    }
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('qualification-projection:' || $1, 0))",
        [mint],
      );
      const result = await operation(new PostgresQualificationProjectionTransaction(
        client,
        mint,
        this.authority,
      ));
      await client.query('COMMIT');
      return result;
    } catch (error: unknown) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original typed error remains authoritative.
      }
      if (error instanceof QualificationProjectionDataError) {
        throw error;
      }
      if (error instanceof TypeError || error instanceof RangeError) throw invalid();
      throw new QualificationProjectionRepositoryError();
    } finally {
      try { client.release(); } catch { /* connection is already unusable */ }
    }
  }
}

class PostgresQualificationProjectionTransaction
implements QualificationProjectionTransaction {
  public constructor(
    private readonly client: QualificationProjectionClient,
    private readonly lockedMint: string,
    private readonly authority: QualificationProjectionAuthority,
  ) {}

  public async loadCanonicalInput(mint: string): Promise<QualificationCanonicalSnapshot | null> {
    this.assertLockedMint(mint);
    const launchResult = await this.client.query(
      `SELECT /* qualification_launch */
          domain.event_id,domain.raw_event_id,domain.type,domain.mint,domain.source,
          domain.program,domain.signature,domain.slot::text AS slot,
          domain.transaction_index,domain.instruction_index,
          domain.inner_instruction_index,domain.confirmation_status,
          domain.blockchain_time,domain.observed_at,domain.payload_version,domain.payload,
          launch.creator,launch.token_program,launch.quote_assets,launch.launchpad,
          launch.program_id,
          launch.created_slot::text AS created_slot,
          launch.created_transaction_index,launch.created_instruction_index,
          launch.created_inner_instruction_index
       FROM token_launches AS launch
       JOIN domain_events AS domain
         ON domain.mint=launch.mint
        AND domain.type='TokenLaunchDetected'
        AND domain.signature=launch.created_signature
        AND domain.slot=launch.created_slot
        AND domain.transaction_index=launch.created_transaction_index
        AND domain.instruction_index=launch.created_instruction_index
        AND domain.inner_instruction_index
          IS NOT DISTINCT FROM launch.created_inner_instruction_index
       JOIN raw_chain_events AS raw ON raw.event_id=domain.raw_event_id
        AND raw.source=domain.source AND raw.program=domain.program
        AND raw.mint=domain.mint AND raw.signature=domain.signature
        AND raw.slot=domain.slot AND raw.transaction_index=domain.transaction_index
        AND raw.instruction_index=domain.instruction_index
        AND raw.inner_instruction_index IS NOT DISTINCT FROM domain.inner_instruction_index
       WHERE launch.mint=$1
         AND domain.raw_event_id IS NOT NULL
         AND domain.confirmation_status <> 'orphaned'
         AND raw.confirmation_status <> 'orphaned'
         AND domain.confirmation_status=raw.confirmation_status
       ORDER BY domain.event_id
       LIMIT 1`,
      [mint],
    );
    const launchRow = launchResult.rows[0];
    if (launchRow === undefined) return null;
    const launchEvent = domainEventFromRow(launchRow);
    const launch = launchFromRow(launchRow, launchEvent);

    const asOfResult = await this.client.query(
      `SELECT /* qualification_as_of */
          domain.event_id,domain.raw_event_id,domain.type,domain.mint,domain.source,
          domain.program,domain.signature,domain.slot::text AS slot,
          domain.transaction_index,domain.instruction_index,
          domain.inner_instruction_index,domain.confirmation_status,
          domain.blockchain_time,domain.observed_at,domain.payload_version,domain.payload
       FROM domain_events AS domain
       JOIN raw_chain_events AS raw ON raw.event_id=domain.raw_event_id
        AND raw.source=domain.source AND raw.program=domain.program
        AND raw.mint=domain.mint AND raw.signature=domain.signature
        AND raw.slot=domain.slot AND raw.transaction_index=domain.transaction_index
        AND raw.instruction_index=domain.instruction_index
        AND raw.inner_instruction_index IS NOT DISTINCT FROM domain.inner_instruction_index
       WHERE domain.mint=$1
         AND domain.raw_event_id IS NOT NULL
         AND domain.confirmation_status <> 'orphaned'
         AND raw.confirmation_status <> 'orphaned'
         AND domain.confirmation_status=raw.confirmation_status
         AND domain.type IN (
           'TokenLaunchDetected','BondingCurveTradeObserved','BondingCurveStateUpdated',
           'BondingCurveCompleted','MigrationObserved','PumpSwapPoolActivated'
         )
       ORDER BY domain.slot DESC,domain.transaction_index DESC,
         domain.instruction_index DESC,COALESCE(domain.inner_instruction_index,-1) DESC,
         domain.event_id DESC
       LIMIT 1`,
      [mint],
    );
    const asOfRow = asOfResult.rows[0];
    if (asOfRow === undefined) throw invalid();
    const asOfEvent = domainEventFromRow(asOfRow);
    const asOfRawEventId = text(asOfRow.raw_event_id);

    const socialResult = await this.client.query(
      `SELECT /* qualification_social */ collection.collection_id,
          collection.input_fingerprint,collection.mint,
          collection.source_launch_event_id,collection.source_raw_event_id,
          collection.metadata_snapshot_id,collection.collection_status,
          collection.observed_at,collection.payload_version
       FROM social_evidence_collections AS collection
       JOIN domain_events AS launch_event
         ON launch_event.event_id=collection.source_launch_event_id
        AND launch_event.event_id=$2
        AND launch_event.confirmation_status <> 'orphaned'
        AND launch_event.raw_event_id=collection.source_raw_event_id
       JOIN domain_events AS social_event
         ON social_event.mint=collection.mint
        AND social_event.type='SocialEvidenceCollected'
        AND social_event.payload->>'collectionId'=collection.collection_id
        AND social_event.payload->>'sourceLaunchEventId'=collection.source_launch_event_id
        AND social_event.raw_event_id=collection.source_raw_event_id
        AND social_event.confirmation_status=collection.confirmation_status
        AND social_event.confirmation_status <> 'orphaned'
       WHERE collection.mint=$1
         AND collection.confirmation_status=launch_event.confirmation_status
         AND collection.confirmation_status <> 'orphaned'
         AND collection.terminal_at IS NULL
       ORDER BY collection.observed_at DESC,collection.collection_id DESC
       LIMIT 1`,
      [mint, launchEvent.id],
    );
    const collectionRow = socialResult.rows[0];
    const social = collectionRow === undefined
      ? null
      : await this.loadSocial(
        collectionRow,
        mint,
        launchEvent.id,
        text(launchRow.raw_event_id),
      );
    const metadataResult = await this.client.query(
      collectionRow === undefined
        ? `SELECT /* qualification_metadata_launch */ snapshot_id,mint,uri,
             resolution_status,failure_reason,failure_message,failure_retryable,
             metadata,fetched_at,payload_version,source_launch_event_id
           FROM token_metadata_snapshots
           WHERE mint=$1 AND source_launch_event_id=$2
           ORDER BY fetched_at DESC,snapshot_id DESC LIMIT 1`
        : `SELECT /* qualification_metadata_collection */ snapshot_id,mint,uri,
             resolution_status,failure_reason,failure_message,failure_retryable,
             metadata,fetched_at,payload_version,source_launch_event_id
           FROM token_metadata_snapshots WHERE snapshot_id=$1 AND mint=$2
             AND source_launch_event_id=$3`,
      collectionRow === undefined
        ? [mint, launchEvent.id]
        : [text(collectionRow.metadata_snapshot_id), mint, launchEvent.id],
    );
    const metadataRow = metadataResult.rows[0];
    if (collectionRow !== undefined && metadataRow === undefined) throw invalid();
    const metadata = metadataRow === undefined
      ? null
      : metadataFromRow(metadataRow, launchEvent.id);
    const creatorResult = await this.client.query(
      `SELECT /* qualification_creator */ profile.mint,profile.creator,
          profile.payload_version,profile.input_fingerprint,profile.profile_event_id,
          profile.confirmation_status,profile.total_bought_base_raw::text,
          profile.total_sold_base_raw::text,profile.observed_net_base_raw::text,
          profile.has_sold,profile.payload,event.payload AS event_payload
       FROM creator_profiles AS profile
       JOIN domain_events AS event ON event.event_id=profile.profile_event_id
       JOIN raw_chain_events AS raw
         ON raw.source=event.source AND raw.program=event.program
        AND raw.mint=event.mint AND raw.signature=event.signature
        AND raw.slot=event.slot AND raw.transaction_index=event.transaction_index
        AND raw.instruction_index=event.instruction_index
        AND raw.inner_instruction_index IS NOT DISTINCT FROM event.inner_instruction_index
       WHERE profile.mint=$1 AND event.type='CreatorProfileUpdated'
         AND event.mint=profile.mint AND event.confirmation_status <> 'orphaned'
         AND event.confirmation_status=profile.confirmation_status
         AND raw.confirmation_status=event.confirmation_status
         AND raw.confirmation_status <> 'orphaned'
         AND event.payload->>'inputFingerprint'=profile.input_fingerprint`,
      [mint],
    );
    const creatorProfile = creatorResult.rows[0] === undefined
      ? null
      : creatorProfileFromRow(creatorResult.rows[0], mint);
    const holderResult = await this.client.query(
      `SELECT /* qualification_holders */ holder.snapshot_id,holder.mint,
          holder.input_fingerprint,holder.holder_event_id,holder.payload_version,
          holder.confirmation_status,holder.total_positive_net_base_raw::text,
          holder.top1_bps::text,holder.top5_bps::text,holder.top10_bps::text,
          holder.creator_bps::text,holder.unique_known_buyers,
          holder.unique_external_buyers,holder.positive_position_count,
          holder.unknown_trader_trade_count,holder.payload,event.payload AS event_payload
       FROM token_holders_snapshots AS holder
       JOIN domain_events AS event ON event.event_id=holder.holder_event_id
       JOIN raw_chain_events AS raw
         ON raw.source=event.source AND raw.program=event.program
        AND raw.mint=event.mint AND raw.signature=event.signature
        AND raw.slot=event.slot AND raw.transaction_index=event.transaction_index
        AND raw.instruction_index=event.instruction_index
        AND raw.inner_instruction_index IS NOT DISTINCT FROM event.inner_instruction_index
       WHERE holder.mint=$1 AND holder.input_fingerprint=$2
         AND event.type='HolderDistributionUpdated'
         AND event.mint=holder.mint AND event.confirmation_status <> 'orphaned'
         AND event.confirmation_status=holder.confirmation_status
         AND raw.confirmation_status=event.confirmation_status
         AND raw.confirmation_status <> 'orphaned'
         AND event.payload->>'inputFingerprint'=holder.input_fingerprint
       ORDER BY holder.as_of_slot DESC,holder.as_of_transaction_index DESC,
         holder.as_of_instruction_index DESC,
         COALESCE(holder.as_of_inner_instruction_index,-1) DESC,holder.snapshot_id DESC
       LIMIT 1`,
      [mint, creatorProfile?.inputFingerprint ?? null],
    );
    const holderSnapshot = holderResult.rows[0] === undefined
      ? null
      : holderDistributionFromRow(holderResult.rows[0], mint);
    if (
      (creatorProfile === null) !== (holderSnapshot === null)
      || (
        creatorProfile !== null
        && holderSnapshot !== null
        && creatorProfile.inputFingerprint !== holderSnapshot.inputFingerprint
      )
    ) throw invalid();
    const participantInputFingerprint = creatorProfile?.inputFingerprint
      ?? 'NO_PARTICIPANT_PROJECTION';
    const graphResult = await this.client.query(
      `SELECT /* qualification_graph */ graph.input_fingerprint,
          graph.participant_input_fingerprint,graph.methodology,
          graph.graph_event_id,graph.confirmation_status,graph.coverage,
          graph.confirmation_counts,
          graph.strong_relationship_count,graph.medium_relationship_count,
          graph.cluster_count,graph.maximum_cluster_bps::text,
          graph.creator_cluster_count
       FROM wallet_graph_profiles AS graph
       JOIN domain_events AS event ON event.event_id=graph.graph_event_id
       JOIN raw_chain_events AS raw
         ON raw.source=event.source AND raw.program=event.program
        AND raw.mint=event.mint AND raw.signature=event.signature
        AND raw.slot=event.slot AND raw.transaction_index=event.transaction_index
        AND raw.instruction_index=event.instruction_index
        AND raw.inner_instruction_index IS NOT DISTINCT FROM event.inner_instruction_index
       JOIN wallet_graph_snapshots AS snapshot
         ON snapshot.mint=graph.mint
        AND snapshot.input_fingerprint=graph.input_fingerprint
        AND snapshot.graph_event_id=graph.graph_event_id
        AND snapshot.methodology=graph.methodology
        AND snapshot.confirmation_status=graph.confirmation_status
        AND snapshot.coverage=graph.coverage
        AND snapshot.strong_relationship_count=graph.strong_relationship_count
        AND snapshot.medium_relationship_count=graph.medium_relationship_count
        AND snapshot.cluster_count=graph.cluster_count
        AND snapshot.maximum_cluster_bps=graph.maximum_cluster_bps
        AND snapshot.creator_cluster_count=graph.creator_cluster_count
        AND snapshot.confirmation_counts=graph.confirmation_counts
        AND snapshot.as_of_event_id=graph.as_of_event_id
        AND snapshot.as_of_signature=graph.as_of_signature
        AND snapshot.as_of_slot=graph.as_of_slot
        AND snapshot.as_of_transaction_index=graph.as_of_transaction_index
        AND snapshot.as_of_instruction_index=graph.as_of_instruction_index
        AND snapshot.as_of_inner_instruction_index
          IS NOT DISTINCT FROM graph.as_of_inner_instruction_index
        AND snapshot.observed_at=graph.observed_at
       WHERE graph.mint=$1 AND graph.participant_input_fingerprint=$2
         AND event.type='WalletClusterDetected'
         AND event.mint=graph.mint AND event.confirmation_status <> 'orphaned'
         AND event.confirmation_status=graph.confirmation_status
         AND raw.confirmation_status=event.confirmation_status
         AND raw.confirmation_status <> 'orphaned'
         AND event.signature=graph.as_of_signature
         AND event.slot=graph.as_of_slot
         AND event.transaction_index=graph.as_of_transaction_index
         AND event.instruction_index=graph.as_of_instruction_index
         AND event.inner_instruction_index
           IS NOT DISTINCT FROM graph.as_of_inner_instruction_index
         AND event.observed_at=graph.observed_at
         AND event.payload->>'inputFingerprint'=graph.input_fingerprint
         AND event.payload->>'methodology'=graph.methodology
         AND event.payload->'coverage'=graph.coverage
         AND event.payload->'confirmationCounts'=graph.confirmation_counts`,
      [mint, participantInputFingerprint],
    );
    const walletGraph = graphResult.rows[0] === undefined
      ? null
      : await this.loadWalletGraph(
        graphResult.rows[0],
        mint,
        participantInputFingerprint,
      );
    return Object.freeze({
      mint,
      asOfEvent,
      asOfRawEventId,
      launch,
      metadata,
      social,
      creatorProfile,
      holderSnapshot,
      walletGraph,
    });
  }

  private async loadSocial(
    collectionRow: Record<string, unknown>,
    mint: string,
    launchEventId: string,
    launchRawEventId: string,
  ): Promise<SocialEvidenceCollectionV1> {
    const collectionId = text(collectionRow.collection_id);
    const linkResult = await this.client.query(
      `SELECT /* qualification_social_links */ link_id,mint,metadata_snapshot_id,
          link_kind,declared_value_sha256,syntax_status,canonical_url,
          invalid_reason,observed_at
       FROM social_links WHERE collection_id=$1 ORDER BY link_kind,link_id`,
      [collectionId],
    );
    const observationResult = await this.client.query(
      `SELECT /* qualification_social_observations */ observation_id,link_id,outcome,
          final_canonical_url,http_status,redirect_count,content_sha256,
          failure_reason,observed_at
       FROM social_http_observations
       WHERE collection_id=$1 ORDER BY observation_id`,
      [collectionId],
    );
    const evidenceResult = await this.client.query(
      `SELECT /* qualification_social_verification */ evidence_id,mint,link_id,
          observation_id,evidence_type,outcome,subject_kind,related_kind,
          reason_code,observed_at
       FROM social_verification_evidence
       WHERE collection_id=$1 ORDER BY evidence_type,evidence_id`,
      [collectionId],
    );
    const collection = createSocialCollection(Object.freeze({
      mint: text(collectionRow.mint),
      sourceLaunchEventId: text(collectionRow.source_launch_event_id),
      metadataSnapshotId: text(collectionRow.metadata_snapshot_id),
      status: socialStatus(collectionRow.collection_status),
      links: Object.freeze(linkResult.rows.map(socialLinkFromRow)),
      observations: Object.freeze(observationResult.rows.map(socialObservationFromRow)),
      evidence: Object.freeze(evidenceResult.rows.map(socialEvidenceFromRow)),
      observedAtMs: timestamp(collectionRow.observed_at),
    }));
    if (
      collection.id !== collectionId
      || collection.inputFingerprint !== text(collectionRow.input_fingerprint)
      || collection.payloadVersion !== positiveIndex(collectionRow.payload_version)
      || collection.mint !== mint
      || collection.sourceLaunchEventId !== launchEventId
      || text(collectionRow.source_raw_event_id) !== launchRawEventId
    ) throw invalid();
    return collection;
  }

  private async loadWalletGraph(
    graphRow: Record<string, unknown>,
    mint: string,
    participantInputFingerprint: string,
  ): Promise<WalletGraphAnalysis> {
    const inputFingerprint = hash(graphRow.input_fingerprint);
    if (text(graphRow.participant_input_fingerprint) !== participantInputFingerprint) {
      throw invalid();
    }
    const relationshipResult = await this.client.query(
      `SELECT /* qualification_graph_relationships */ relationship_id,mint,
          left_wallet,right_wallet,relationship_type,confidence,evidence_count,
          quote_totals,first_observed_cursor,last_observed_cursor,input_fingerprint
       FROM wallet_relationships
       WHERE mint=$1 AND input_fingerprint=$2 ORDER BY relationship_id`,
      [mint, inputFingerprint],
    );
    const clusterResult = await this.client.query(
      `SELECT /* qualification_graph_clusters */ cluster_id,mint,input_fingerprint,
          participant_wallet_count,auxiliary_wallet_count,positive_holder_count,
          observed_positive_base_raw::text,concentration_bps::text,contains_creator,
          shared_funder_count,strong_relationship_count,strong_evidence_count,quote_assets
       FROM wallet_clusters
       WHERE mint=$1 AND input_fingerprint=$2 ORDER BY cluster_id`,
      [mint, inputFingerprint],
    );
    const memberResult = await this.client.query(
      `SELECT /* qualification_graph_members */ cluster_id,wallet,member_role,
          is_creator,observed_net_base_raw::text,input_fingerprint
       FROM wallet_cluster_members
       WHERE mint=$1 AND input_fingerprint=$2 ORDER BY cluster_id,wallet`,
      [mint, inputFingerprint],
    );
    const members = membersByCluster(memberResult.rows, inputFingerprint);
    const relationships = Object.freeze(relationshipResult.rows.map((row) => (
      relationshipFromRow(row, mint, inputFingerprint)
    )));
    const clusters = Object.freeze(clusterResult.rows.map((row) => (
      clusterFromRow(row, mint, inputFingerprint, members.get(text(row.cluster_id)) ?? [])
    )));
    if ([...members.keys()].some((clusterId) =>
      !clusters.some((cluster) => cluster.id === clusterId))) throw invalid();
    const coverage = coverageFromJson(graphRow.coverage);
    confirmationCountsFromJson(graphRow.confirmation_counts);
    const graph = Object.freeze({ relationships, clusters, coverage });
    assertValidWalletGraphAnalysis(graph);
    const strongCount = relationships.filter((item) => item.confidence === 'STRONG').length;
    const mediumCount = relationships.filter((item) => item.confidence === 'MEDIUM').length;
    const maximumClusterBps = clusters.reduce(
      (maximum, cluster) => cluster.concentrationBps > maximum
        ? cluster.concentrationBps
        : maximum,
      0n,
    );
    if (
      graphRow.methodology !== 'OBSERVED_PUMPFUN_TRANSACTIONS'
      || confirmation(graphRow.confirmation_status) === 'orphaned'
      || index(graphRow.strong_relationship_count) !== strongCount
      || index(graphRow.medium_relationship_count) !== mediumCount
      || index(graphRow.cluster_count) !== clusters.length
      || unsignedBigInt(graphRow.maximum_cluster_bps) !== maximumClusterBps
      || index(graphRow.creator_cluster_count)
        !== clusters.filter((cluster) => cluster.containsCreator).length
    ) throw invalid();
    return graph;
  }

  public async replaceProjection(
    projection: CanonicalQualificationProjection,
  ): Promise<'UPDATED' | 'UNCHANGED'> {
    this.assertLockedMint(projection.qualificationEvent.mint);
    this.authority.reauthorize(projection);
    const event = projection.qualificationEvent;
    if (
      event.type !== 'QualificationUpdated'
      || event.source !== 'qualification'
      || event.confirmationStatus === 'orphaned'
      || event.payloadVersion !== 1
    ) throw invalid();
    const sourceResult = await this.client.query(
      `SELECT /* qualification_source_mapping */ source.event_id,source.raw_event_id,
          source.type,source.mint,source.program,source.signature,source.slot::text AS slot,
          source.transaction_index,source.instruction_index,
          source.inner_instruction_index,source.confirmation_status,
          source.blockchain_time,source.observed_at,source.payload_version,source.payload
       FROM domain_events AS source
       JOIN raw_chain_events AS raw ON source.raw_event_id=raw.event_id
        AND raw.source=source.source AND raw.program=source.program
        AND raw.mint=source.mint AND raw.signature=source.signature
        AND raw.slot=source.slot AND raw.transaction_index=source.transaction_index
        AND raw.instruction_index=source.instruction_index
        AND raw.inner_instruction_index IS NOT DISTINCT FROM source.inner_instruction_index
       WHERE source.event_id=$1 AND source.raw_event_id=$2 AND source.mint=$3
         AND source.confirmation_status <> 'orphaned'
         AND raw.confirmation_status <> 'orphaned'
         AND source.confirmation_status=raw.confirmation_status
         AND source.type IN (
           'TokenLaunchDetected','BondingCurveTradeObserved','BondingCurveStateUpdated',
           'BondingCurveCompleted','MigrationObserved','PumpSwapPoolActivated'
         )
       FOR SHARE OF source,raw`,
      [projection.sourceEventId, projection.sourceRawEventId, this.lockedMint],
    );
    const sourceRow = sourceResult.rows[0];
    if (sourceRow === undefined) throw invalid();
    assertSourceMapping(sourceRow, projection);

    const profile = projection.report.ruleSet;
    const currentResult = await this.client.query(
      `SELECT /* qualification_current_report */ report_id
       FROM qualification_reports
       WHERE mint=$1 AND profile_id=$2 AND profile_version=$3
         AND superseded_at IS NULL
       FOR UPDATE`,
      [event.mint, profile.id, profile.version],
    );
    const currentRow = currentResult.rows[0];
    if (currentRow !== undefined && text(currentRow.report_id) === projection.reportId) {
      await this.assertStoredProjection(projection);
      return 'UNCHANGED';
    }
    await this.client.query(
      `UPDATE qualification_reports
       SET superseded_at=GREATEST(evaluated_at,$4)
       WHERE mint=$1 AND profile_id=$2 AND profile_version=$3
         AND superseded_at IS NULL`,
      [
        event.mint,
        profile.id,
        profile.version,
        retentionDate(projection.evaluation.evaluatedAtMs, 0),
      ],
    );
    const historicalResult = await this.client.query(
      `SELECT /* qualification_historical_report */ report_id
       FROM qualification_reports WHERE report_id=$1 FOR UPDATE`,
      [projection.reportId],
    );
    if (historicalResult.rows[0] !== undefined) {
      await this.assertStoredProjection(projection);
      const reactivated = await this.client.query(
        `UPDATE qualification_reports SET superseded_at=NULL
         WHERE report_id=$1 AND mint=$2 AND superseded_at IS NOT NULL`,
        [projection.reportId, event.mint],
      );
      if (reactivated.rowCount !== 1) throw invalid();
      return 'UPDATED';
    }
    const insertedEvent = await this.client.query(
      `INSERT INTO domain_events (
        event_id,raw_event_id,type,mint,source,program,signature,slot,
        transaction_index,instruction_index,inner_instruction_index,
        confirmation_status,blockchain_time,observed_at,payload_version,payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        event.id, projection.sourceRawEventId, event.type, event.mint, event.source,
        event.program, event.signature, event.cursor.slot.toString(),
        event.cursor.transactionIndex, event.cursor.instructionIndex,
        event.cursor.innerInstructionIndex, event.confirmationStatus,
        date(event.blockchainTimeMs), new Date(event.observedAtMs),
        event.payloadVersion, toJsonValue(event.payload),
      ],
    );
    if (insertedEvent.rowCount !== 1) throw invalid();
    const evaluatedAt = retentionDate(projection.report.evaluatedAtMs, 0);
    const purgeAfter = retentionDate(projection.report.evaluatedAtMs, 14_400_000);
    const insertedReport = await this.client.query(
      `INSERT INTO qualification_reports (
        report_id,mint,source_event_id,source_raw_event_id,qualification_event_id,
        profile_id,profile_version,profile_fingerprint,evidence_fingerprint,verdict,
        preparation_score,social_score,onchain_score,total_score,as_of_slot,
        as_of_transaction_index,as_of_instruction_index,as_of_inner_instruction_index,
        confirmation_status,evaluated_at,superseded_at,purge_after,payload_version,payload
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
        $19,$20,NULL,$21,1,$22)`,
      [
        projection.reportId, event.mint, projection.sourceEventId,
        projection.sourceRawEventId, event.id, profile.id, profile.version,
        profile.fingerprint, projection.evidenceFingerprint, projection.report.verdict,
        projection.report.scores.preparation.score,
        projection.report.scores.socialAuthenticity.score,
        projection.report.scores.onchainHealth.score,
        projection.report.scores.total.score, event.cursor.slot.toString(),
        event.cursor.transactionIndex, event.cursor.instructionIndex,
        event.cursor.innerInstructionIndex, event.confirmationStatus,
        evaluatedAt, purgeAfter, toJsonValue(projection.report),
      ],
    );
    if (insertedReport.rowCount !== 1) throw invalid();
    return 'UPDATED';
  }

  public async dissolveCurrent(mint: string): Promise<void> {
    this.assertLockedMint(mint);
    await this.client.query(
      `UPDATE qualification_reports /* qualification_dissolve */
       SET superseded_at=GREATEST(evaluated_at,LEAST(clock_timestamp(),purge_after))
       WHERE mint=$1 AND superseded_at IS NULL`,
      [mint],
    );
  }

  private async assertStoredProjection(
    projection: CanonicalQualificationProjection,
  ): Promise<void> {
    const stored = await this.client.query(
      `SELECT /* qualification_stored_report */ report.*,
          event.type AS event_type,event.mint AS event_mint,
          event.raw_event_id AS event_raw_event_id,event.source AS event_source,
          event.program AS event_program,event.signature AS event_signature,
          event.slot::text AS event_slot,
          event.transaction_index AS event_transaction_index,
          event.instruction_index AS event_instruction_index,
          event.inner_instruction_index AS event_inner_instruction_index,
          event.confirmation_status AS event_confirmation_status,
          event.blockchain_time AS event_blockchain_time,
          event.observed_at AS event_observed_at,
          event.payload_version AS event_payload_version,event.payload AS event_payload
       FROM qualification_reports AS report
       JOIN domain_events AS event ON event.event_id=report.qualification_event_id
       WHERE report.report_id=$1`,
      [projection.reportId],
    );
    const row = stored.rows[0];
    if (row === undefined) throw invalid();
    assertStoredProjectionRow(row, projection);
  }

  private assertLockedMint(mint: string): void {
    if (mint !== this.lockedMint) {
      throw new QualificationProjectionDataError(
        'Qualification projection mint does not match its lock.',
      );
    }
  }
}

function launchFromRow(row: Record<string, unknown>, event: DomainEvent): TokenLaunch {
  if (event.type !== 'TokenLaunchDetected') throw invalid();
  const payload = record(event.payload);
  if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'launch')) throw invalid();
  const rebuilt = createTokenLaunchDetectedEvent({
    source: event.source,
    program: event.program,
    transaction: Object.freeze({
      signature: event.signature,
      confirmationStatus: event.confirmationStatus,
      blockTimeMs: event.blockchainTimeMs,
      observedAtMs: event.observedAtMs,
      cursor: Object.freeze({
        slot: event.cursor.slot,
        transactionIndex: event.cursor.transactionIndex,
      }),
      raw: null,
    }),
    launch: payload.launch as TokenLaunch,
  }).payload.launch;
  if (
    rebuilt.mint !== text(row.mint)
    || rebuilt.creator !== text(row.creator)
    || event.program !== text(row.program_id)
    || rebuilt.tokenProgram !== tokenProgram(row.token_program)
    || rebuilt.launchpad !== text(row.launchpad)
    || rebuilt.createdAt.slot !== unsignedBigInt(row.created_slot)
    || rebuilt.createdAt.transactionIndex !== index(row.created_transaction_index)
    || rebuilt.createdAt.instructionIndex !== index(row.created_instruction_index)
    || rebuilt.createdAt.innerInstructionIndex !== nullableIndex(row.created_inner_instruction_index)
    || canonicalStringifyJson(rebuilt.quoteAssets)
      !== canonicalStringifyJson(decodeJson(row.quote_assets))
  ) throw invalid();
  return rebuilt;
}

function metadataFromRow(
  row: Record<string, unknown>,
  launchEventId: string,
): TokenMetadataSnapshot {
  const status = row.resolution_status;
  let resolution: TokenMetadataSnapshot['resolution'];
  if (status === 'resolved') {
    if (
      row.failure_reason !== null
      || row.failure_message !== null
      || row.failure_retryable !== null
    ) throw invalid();
    resolution = Object.freeze({
      status: 'RESOLVED',
      metadata: exactPublicMetadata(decodeJson(row.metadata)),
    });
  } else if (status === 'failed') {
    if (row.metadata !== null || typeof row.failure_retryable !== 'boolean') throw invalid();
    resolution = Object.freeze({
      status: 'FAILED',
      reason: metadataFailureReason(row.failure_reason),
      message: text(row.failure_message),
      retryable: row.failure_retryable,
    });
  } else {
    throw invalid();
  }
  const snapshot = Object.freeze({
    mint: text(row.mint),
    uri: text(row.uri),
    resolution,
    fetchedAtMs: timestamp(row.fetched_at),
    payloadVersion: positiveIndex(row.payload_version),
  });
  if (
    text(row.source_launch_event_id) !== launchEventId
    || text(row.snapshot_id) !== socialMetadataSnapshotId({
      sourceLaunchEventId: launchEventId,
      snapshot,
    })
  ) throw invalid();
  return snapshot;
}

function exactPublicMetadata(value: unknown): Extract<
  TokenMetadataSnapshot['resolution'], { readonly status: 'RESOLVED' }
>['metadata'] {
  const fields = record(value);
  const names = [
    'name', 'symbol', 'description', 'imageUrl', 'videoUrl', 'websiteUrl',
    'twitterUrl', 'telegramUrl',
  ] as const;
  if (
    Object.keys(fields).length !== names.length
    || names.some((name) => !Object.hasOwn(fields, name))
  ) throw invalid();
  return Object.freeze({
    name: nullableText(fields.name),
    symbol: nullableText(fields.symbol),
    description: nullableText(fields.description),
    imageUrl: nullableText(fields.imageUrl),
    videoUrl: nullableText(fields.videoUrl),
    websiteUrl: nullableText(fields.websiteUrl),
    twitterUrl: nullableText(fields.twitterUrl),
    telegramUrl: nullableText(fields.telegramUrl),
  });
}

function socialLinkFromRow(row: Record<string, unknown>): SocialLinkV1 {
  return Object.freeze({
    id: text(row.link_id), mint: text(row.mint),
    metadataSnapshotId: text(row.metadata_snapshot_id),
    kind: socialLinkKind(row.link_kind),
    declaredValueSha256: hash(row.declared_value_sha256),
    syntaxStatus: socialSyntax(row.syntax_status),
    canonicalUrl: nullableText(row.canonical_url),
    invalidReason: nullableText(row.invalid_reason),
    observedAtMs: timestamp(row.observed_at),
  });
}

function socialObservationFromRow(row: Record<string, unknown>): SocialHttpObservationV1 {
  return Object.freeze({
    id: text(row.observation_id), linkId: text(row.link_id),
    outcome: socialHttpOutcome(row.outcome),
    finalCanonicalUrl: nullableText(row.final_canonical_url),
    httpStatus: nullableIndex(row.http_status),
    redirectCount: index(row.redirect_count),
    contentSha256: nullableHash(row.content_sha256),
    failureReason: nullableText(row.failure_reason),
    observedAtMs: timestamp(row.observed_at),
  });
}

function socialEvidenceFromRow(row: Record<string, unknown>): SocialVerificationEvidenceV1 {
  return Object.freeze({
    id: text(row.evidence_id), mint: text(row.mint),
    linkId: nullableText(row.link_id), observationId: nullableText(row.observation_id),
    type: socialEvidenceType(row.evidence_type), outcome: socialOutcome(row.outcome),
    subjectKind: nullableSocialLinkKind(row.subject_kind),
    relatedKind: nullableSocialLinkKind(row.related_kind),
    reasonCode: text(row.reason_code), observedAtMs: timestamp(row.observed_at),
  });
}

const CREATOR_PROFILE_FIELDS = [
  'mint', 'creator', 'payloadVersion', 'inputFingerprint', 'buyCount', 'sellCount',
  'totalBoughtBaseRaw', 'totalSoldBaseRaw', 'observedNetBaseRaw', 'hasSold',
  'firstSell', 'initialBuys', 'quoteFlows', 'uniqueExternalBuyers',
  'unknownTraderTradeCount',
] as const;

function creatorProfileFromRow(
  row: Record<string, unknown>,
  mint: string,
): CreatorProfile {
  const decoded = record(decodeJson(row.payload));
  exactKeys(decoded, CREATOR_PROFILE_FIELDS);
  const profile = decoded as unknown as CreatorProfile;
  assertValidCreatorProfile(profile);
  assertCreatorProfileDetails(profile);
  assertParticipantEventPayload(
    row.event_payload,
    profile.inputFingerprint,
    'profile',
    profile,
  );
  if (
    profile.mint !== mint
    || profile.mint !== text(row.mint)
    || profile.creator !== text(row.creator)
    || profile.payloadVersion !== positiveIndex(row.payload_version)
    || profile.inputFingerprint !== hash(row.input_fingerprint)
    || profile.totalBoughtBaseRaw !== unsignedBigInt(row.total_bought_base_raw)
    || profile.totalSoldBaseRaw !== unsignedBigInt(row.total_sold_base_raw)
    || profile.observedNetBaseRaw !== signedBigInt(row.observed_net_base_raw)
    || profile.hasSold !== booleanValue(row.has_sold)
    || text(row.profile_event_id).length === 0
    || confirmation(row.confirmation_status) === 'orphaned'
  ) throw invalid();
  return profile;
}

const HOLDER_FIELDS = [
  'mint', 'creator', 'payloadVersion', 'inputFingerprint', 'positions',
  'totalPositiveNetBaseRaw', 'top1Bps', 'top5Bps', 'top10Bps', 'creatorBps',
  'uniqueKnownBuyers', 'uniqueExternalBuyers', 'positivePositionCount',
  'unknownTraderTradeCount',
] as const;

function holderDistributionFromRow(
  row: Record<string, unknown>,
  mint: string,
): HolderDistribution {
  const decoded = record(decodeJson(row.payload));
  exactKeys(decoded, HOLDER_FIELDS);
  const distribution = decoded as unknown as HolderDistribution;
  assertValidHolderDistribution(distribution);
  assertHolderDistributionDetails(distribution);
  assertParticipantEventPayload(
    row.event_payload,
    distribution.inputFingerprint,
    'distribution',
    holderDistributionSummary(distribution),
  );
  if (
    distribution.mint !== mint
    || distribution.mint !== text(row.mint)
    || distribution.payloadVersion !== positiveIndex(row.payload_version)
    || distribution.inputFingerprint !== hash(row.input_fingerprint)
    || distribution.totalPositiveNetBaseRaw
      !== unsignedBigInt(row.total_positive_net_base_raw)
    || distribution.top1Bps !== unsignedBigInt(row.top1_bps)
    || distribution.top5Bps !== unsignedBigInt(row.top5_bps)
    || distribution.top10Bps !== unsignedBigInt(row.top10_bps)
    || distribution.creatorBps !== unsignedBigInt(row.creator_bps)
    || distribution.uniqueKnownBuyers !== index(row.unique_known_buyers)
    || distribution.uniqueExternalBuyers !== index(row.unique_external_buyers)
    || distribution.positivePositionCount !== index(row.positive_position_count)
    || distribution.unknownTraderTradeCount !== index(row.unknown_trader_trade_count)
    || text(row.holder_event_id).length === 0
    || confirmation(row.confirmation_status) === 'orphaned'
  ) throw invalid();
  return distribution;
}

function assertParticipantEventPayload(
  value: unknown,
  inputFingerprint: string,
  bodyField: 'profile' | 'distribution',
  body: unknown,
): void {
  const payload = record(decodeJson(value));
  exactKeys(payload, ['inputFingerprint', 'confirmationCounts', bodyField]);
  if (hash(payload.inputFingerprint) !== inputFingerprint) throw invalid();
  confirmationCountsFromJson(payload.confirmationCounts);
  if (
    canonicalStringifyJson(payload[bodyField])
    !== canonicalStringifyJson(body)
  ) throw invalid();
}

function holderDistributionSummary(
  distribution: HolderDistribution,
): Readonly<Record<string, unknown>> {
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

function assertCreatorProfileDetails(profile: CreatorProfile): void {
  if (profile.firstSell !== null) assertCreatorTradeEvidence(profile.firstSell);
  assertDataArray(profile.initialBuys);
  for (const item of profile.initialBuys) assertCreatorTradeEvidence(item);
  assertQuoteFlows(profile.quoteFlows);
}

function assertCreatorTradeEvidence(value: unknown): void {
  const fields = record(value);
  exactKeys(fields, [
    'eventId', 'tradeId', 'signature', 'cursor', 'baseAmountRaw',
    'quoteAmountRaw', 'quoteAsset',
  ]);
  text(fields.eventId);
  text(fields.tradeId);
  text(fields.signature);
  cursorFromDecodedJson(fields.cursor);
  unsignedBigIntValue(fields.baseAmountRaw);
  unsignedBigIntValue(fields.quoteAmountRaw);
  quoteAssetFromJson(fields.quoteAsset);
}

function assertHolderDistributionDetails(distribution: HolderDistribution): void {
  assertDataArray(distribution.positions);
  const wallets = new Set<string>();
  for (const position of distribution.positions) {
    const fields = record(position);
    exactKeys(fields, [
      'wallet', 'isCreator', 'buyCount', 'sellCount', 'boughtBaseRaw',
      'soldBaseRaw', 'observedNetBaseRaw', 'quoteFlows',
      'firstObservedCursor', 'lastObservedCursor',
    ]);
    const wallet = text(fields.wallet);
    if (wallets.has(wallet)) throw invalid();
    wallets.add(wallet);
    booleanValue(fields.isCreator);
    index(fields.buyCount);
    index(fields.sellCount);
    unsignedBigIntValue(fields.boughtBaseRaw);
    unsignedBigIntValue(fields.soldBaseRaw);
    signedBigInt(fields.observedNetBaseRaw);
    assertQuoteFlows(fields.quoteFlows);
    cursorFromDecodedJson(fields.firstObservedCursor);
    cursorFromDecodedJson(fields.lastObservedCursor);
  }
}

function assertQuoteFlows(value: unknown): void {
  const items = assertDataArray(value);
  for (const item of items) {
    const fields = record(item);
    exactKeys(fields, ['quoteAsset', 'boughtQuoteRaw', 'soldQuoteRaw']);
    quoteAssetFromJson(fields.quoteAsset);
    unsignedBigIntValue(fields.boughtQuoteRaw);
    unsignedBigIntValue(fields.soldQuoteRaw);
  }
}

function assertDataArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || !Object.isFrozen(value)) throw invalid();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1) throw invalid();
  return value;
}

function relationshipFromRow(
  row: Record<string, unknown>,
  mint: string,
  inputFingerprint: string,
): WalletRelationship {
  if (text(row.mint) !== mint || hash(row.input_fingerprint) !== inputFingerprint) throw invalid();
  const quoteTotalsValue = decodeJson(row.quote_totals);
  if (!Array.isArray(quoteTotalsValue)) throw invalid();
  return Object.freeze({
    id: text(row.relationship_id),
    mint,
    leftWallet: text(row.left_wallet),
    rightWallet: text(row.right_wallet),
    type: relationshipType(row.relationship_type),
    confidence: relationshipConfidence(row.confidence),
    evidenceCount: positiveIndex(row.evidence_count),
    quoteTotals: Object.freeze(quoteTotalsValue.map((item) => {
      const fields = record(item);
      exactKeys(fields, ['quoteAsset', 'amountRaw']);
      return Object.freeze({
        quoteAsset: quoteAssetFromJson(fields.quoteAsset),
        amountRaw: unsignedBigIntValue(fields.amountRaw),
      });
    })),
    firstObservedCursor: cursorFromJson(row.first_observed_cursor),
    lastObservedCursor: cursorFromJson(row.last_observed_cursor),
  });
}

function clusterFromRow(
  row: Record<string, unknown>,
  mint: string,
  inputFingerprint: string,
  members: readonly WalletCluster['members'][number][],
): WalletCluster {
  if (text(row.mint) !== mint || hash(row.input_fingerprint) !== inputFingerprint) throw invalid();
  const quoteAssetsValue = decodeJson(row.quote_assets);
  if (!Array.isArray(quoteAssetsValue)) throw invalid();
  const participantCount = members.filter((item) => item.role === 'PARTICIPANT').length;
  const auxiliaryCount = members.filter((item) => item.role === 'AUXILIARY_FUNDER').length;
  if (
    participantCount !== index(row.participant_wallet_count)
    || auxiliaryCount !== index(row.auxiliary_wallet_count)
  ) throw invalid();
  return Object.freeze({
    id: text(row.cluster_id),
    mint,
    members: Object.freeze(members),
    participantWalletCount: participantCount,
    auxiliaryWalletCount: auxiliaryCount,
    positiveHolderCount: index(row.positive_holder_count),
    observedPositiveBaseRaw: unsignedBigInt(row.observed_positive_base_raw),
    concentrationBps: unsignedBigInt(row.concentration_bps),
    containsCreator: booleanValue(row.contains_creator),
    sharedFunderCount: index(row.shared_funder_count),
    strongRelationshipCount: index(row.strong_relationship_count),
    strongEvidenceCount: index(row.strong_evidence_count),
    quoteAssets: Object.freeze(quoteAssetsValue.map(quoteAssetFromJson)),
  });
}

function membersByCluster(
  rows: readonly Record<string, unknown>[],
  inputFingerprint: string,
): ReadonlyMap<string, readonly WalletCluster['members'][number][]> {
  const result = new Map<string, WalletCluster['members'][number][]>();
  for (const row of rows) {
    if (hash(row.input_fingerprint) !== inputFingerprint) throw invalid();
    const clusterId = text(row.cluster_id);
    const members = result.get(clusterId) ?? [];
    members.push(Object.freeze({
      wallet: text(row.wallet),
      role: memberRole(row.member_role),
      isCreator: booleanValue(row.is_creator),
      observedNetBaseRaw: signedBigInt(row.observed_net_base_raw),
    }));
    result.set(clusterId, members);
  }
  return result;
}

const COVERAGE_FIELDS = [
  'knownBuyCount', 'knownBuyerCount', 'strongEvidenceBuyCount',
  'strongEvidenceBuyerCount', 'mediumOnlyBuyCount', 'mediumOnlyBuyerCount',
  'noEvidenceBuyCount', 'noEvidenceBuyerCount', 'unavailableBuyCount',
  'unavailableBuyerCount', 'notProcessedBuyCount', 'notProcessedBuyerCount',
  'analyzedTransactionCount', 'evidenceCount',
] as const;

function coverageFromJson(value: unknown): WalletGraphCoverage {
  const decoded = record(decodeJson(value));
  exactKeys(decoded, COVERAGE_FIELDS);
  const result: Record<string, number> = {};
  for (const field of COVERAGE_FIELDS) result[field] = index(decoded[field]);
  return Object.freeze(result) as unknown as WalletGraphCoverage;
}

function confirmationCountsFromJson(value: unknown): void {
  const decoded = record(decodeJson(value));
  exactKeys(decoded, ['processed', 'confirmed', 'finalized']);
  index(decoded.processed);
  index(decoded.confirmed);
  index(decoded.finalized);
}

function quoteAssetFromJson(value: unknown): QuoteAsset {
  const fields = record(value);
  exactKeys(fields, ['mint', 'decimals', 'tokenProgram']);
  return Object.freeze({
    mint: text(fields.mint),
    decimals: decimals(fields.decimals),
    tokenProgram: tokenProgram(fields.tokenProgram),
  });
}

function cursorFromJson(value: unknown): ChainCursor {
  return cursorFromDecodedJson(decodeJson(value));
}

function cursorFromDecodedJson(value: unknown): ChainCursor {
  const fields = record(value);
  exactKeys(fields, ['slot', 'transactionIndex', 'instructionIndex', 'innerInstructionIndex']);
  return Object.freeze({
    slot: unsignedBigIntValue(fields.slot),
    transactionIndex: index(fields.transactionIndex),
    instructionIndex: index(fields.instructionIndex),
    innerInstructionIndex: nullableIndex(fields.innerInstructionIndex),
  });
}

function assertSourceMapping(
  row: Record<string, unknown>,
  projection: CanonicalQualificationProjection,
): void {
  const event = projection.qualificationEvent;
  domainEventType(row.type);
  positiveIndex(row.payload_version);
  record(decodeJson(row.payload));
  if (
    text(row.event_id) !== projection.sourceEventId
    || text(row.raw_event_id) !== projection.sourceRawEventId
    || text(row.mint) !== event.mint
    || text(row.program) !== event.program
    || text(row.signature) !== event.signature
    || unsignedBigInt(row.slot) !== event.cursor.slot
    || index(row.transaction_index) !== event.cursor.transactionIndex
    || index(row.instruction_index) !== event.cursor.instructionIndex
    || nullableIndex(row.inner_instruction_index) !== event.cursor.innerInstructionIndex
    || confirmation(row.confirmation_status) !== event.confirmationStatus
    || nullableTimestamp(row.blockchain_time) !== event.blockchainTimeMs
    || timestamp(row.observed_at) !== event.observedAtMs
  ) throw invalid();
}

function assertStoredProjectionRow(
  row: Record<string, unknown>,
  projection: CanonicalQualificationProjection,
): void {
  const event = projection.qualificationEvent;
  const report = projection.report;
  const profile = report.ruleSet;
  const evaluatedAt = timestamp(row.evaluated_at);
  if (
    text(row.report_id) !== projection.reportId
    || text(row.mint) !== event.mint
    || text(row.source_event_id) !== projection.sourceEventId
    || text(row.source_raw_event_id) !== projection.sourceRawEventId
    || text(row.qualification_event_id) !== event.id
    || text(row.profile_id) !== profile.id
    || positiveIndex(row.profile_version) !== profile.version
    || hash(row.profile_fingerprint) !== profile.fingerprint
    || hash(row.evidence_fingerprint) !== projection.evidenceFingerprint
    || row.verdict !== report.verdict
    || index(row.preparation_score) !== report.scores.preparation.score
    || index(row.social_score) !== report.scores.socialAuthenticity.score
    || index(row.onchain_score) !== report.scores.onchainHealth.score
    || index(row.total_score) !== report.scores.total.score
    || unsignedBigInt(row.as_of_slot) !== event.cursor.slot
    || index(row.as_of_transaction_index) !== event.cursor.transactionIndex
    || index(row.as_of_instruction_index) !== event.cursor.instructionIndex
    || nullableIndex(row.as_of_inner_instruction_index) !== event.cursor.innerInstructionIndex
    || confirmation(row.confirmation_status) !== event.confirmationStatus
    || evaluatedAt !== report.evaluatedAtMs
    || timestamp(row.purge_after) !== evaluatedAt + 14_400_000
    || positiveIndex(row.payload_version) !== 1
    || canonicalStringifyJson(decodeJson(row.payload)) !== canonicalStringifyJson(report)
    || row.event_type !== event.type
    || text(row.event_mint) !== event.mint
    || text(row.event_raw_event_id) !== projection.sourceRawEventId
    || text(row.event_source) !== event.source
    || text(row.event_program) !== event.program
    || text(row.event_signature) !== event.signature
    || unsignedBigInt(row.event_slot) !== event.cursor.slot
    || index(row.event_transaction_index) !== event.cursor.transactionIndex
    || index(row.event_instruction_index) !== event.cursor.instructionIndex
    || nullableIndex(row.event_inner_instruction_index) !== event.cursor.innerInstructionIndex
    || confirmation(row.event_confirmation_status) !== event.confirmationStatus
    || nullableTimestamp(row.event_blockchain_time) !== event.blockchainTimeMs
    || timestamp(row.event_observed_at) !== event.observedAtMs
    || positiveIndex(row.event_payload_version) !== event.payloadVersion
    || canonicalStringifyJson(decodeJson(row.event_payload))
      !== canonicalStringifyJson(event.payload)
  ) throw invalid();
}

function domainEventFromRow(row: Record<string, unknown>): DomainEvent {
  const event = Object.freeze({
    id: text(row.event_id),
    type: domainEventType(row.type),
    mint: text(row.mint),
    source: text(row.source),
    program: text(row.program),
    signature: text(row.signature),
    cursor: cursorFromRow(row),
    confirmationStatus: confirmation(row.confirmation_status),
    blockchainTimeMs: nullableTimestamp(row.blockchain_time),
    observedAtMs: timestamp(row.observed_at),
    payloadVersion: positiveIndex(row.payload_version),
    payload: record(decodeJson(row.payload)),
  });
  return event;
}

function decodeJson(value: unknown): unknown {
  let decoded: unknown;
  try {
    decoded = fromJsonValue(value);
    canonicalStringifyJson(decoded);
    return deepFreeze(decoded);
  } catch {
    throw invalid();
  }
}

function deepFreeze(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Array.isArray(value) ? value : Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw invalid();
  }
}

function cursorFromRow(row: Record<string, unknown>): ChainCursor {
  return Object.freeze({
    slot: unsignedBigInt(row.slot),
    transactionIndex: index(row.transaction_index),
    instructionIndex: index(row.instruction_index),
    innerInstructionIndex: nullableIndex(row.inner_instruction_index),
  });
}

function text(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > 16_384
  ) throw invalid();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function hash(value: unknown): string {
  const result = text(value);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw invalid();
  return result;
}

function nullableHash(value: unknown): string | null {
  return value === null ? null : hash(value);
}

function unsignedBigInt(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) throw invalid();
  if (value.length > 78) throw invalid();
  return BigInt(value);
}

function unsignedBigIntValue(value: unknown): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  return unsignedBigInt(value);
}

function signedBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (
    typeof value !== 'string'
    || !/^-?(?:0|[1-9]\d*)$/u.test(value)
    || value === '-0'
    || value.replace('-', '').length > 78
  ) throw invalid();
  return BigInt(value);
}

function index(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || Object.is(value, -0)
  ) throw invalid();
  return value;
}

function positiveIndex(value: unknown): number {
  const result = index(value);
  if (result === 0) throw invalid();
  return result;
}

function nullableIndex(value: unknown): number | null {
  return value === null ? null : index(value);
}

function decimals(value: unknown): number {
  const result = index(value);
  if (result > 255) throw invalid();
  return result;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}

function timestamp(value: unknown): number {
  if (!(value instanceof Date)) throw invalid();
  const result = value.getTime();
  if (!Number.isSafeInteger(result) || result < 0) throw invalid();
  return result;
}

function nullableTimestamp(value: unknown): number | null {
  return value === null ? null : timestamp(value);
}

function date(value: number | null): Date | null {
  return value === null ? null : new Date(value);
}

function retentionDate(value: number, offsetMs: number): Date {
  const timestampMs = value + offsetMs;
  if (!Number.isSafeInteger(timestampMs)) throw invalid();
  const result = new Date(timestampMs);
  if (!Number.isSafeInteger(result.getTime()) || result.getTime() < 0) throw invalid();
  return result;
}

function confirmation(value: unknown): ChainConfirmationStatus {
  if (
    value !== 'processed'
    && value !== 'confirmed'
    && value !== 'finalized'
    && value !== 'orphaned'
  ) throw invalid();
  return value;
}

function tokenProgram(value: unknown): TokenLaunch['tokenProgram'] {
  if (value !== 'SPL_TOKEN' && value !== 'TOKEN_2022') throw invalid();
  return value;
}

function domainEventType(value: unknown): DomainEventType {
  if (
    value !== 'TokenLaunchDetected'
    && value !== 'BondingCurveTradeObserved'
    && value !== 'BondingCurveStateUpdated'
    && value !== 'BondingCurveCompleted'
    && value !== 'MigrationObserved'
    && value !== 'PumpSwapPoolActivated'
  ) throw invalid();
  return value;
}

function metadataFailureReason(value: unknown): MetadataFailureReason {
  if (
    value !== 'URI_INVALID'
    && value !== 'UNSUPPORTED_URI_SCHEME'
    && value !== 'FETCH_FAILED'
    && value !== 'HTTP_STATUS_INVALID'
    && value !== 'REDIRECT_LIMIT_EXCEEDED'
    && value !== 'CONTENT_TOO_LARGE'
    && value !== 'JSON_INVALID'
    && value !== 'JSON_SHAPE_INVALID'
  ) throw invalid();
  return value;
}

function socialStatus(value: unknown): SocialEvidenceCollectionV1['status'] {
  if (value !== 'COMPLETE' && value !== 'PARTIAL' && value !== 'FAILED') throw invalid();
  return value;
}

function socialLinkKind(value: unknown): SocialLinkKind {
  if (value !== 'WEBSITE' && value !== 'X' && value !== 'TELEGRAM') throw invalid();
  return value;
}

function nullableSocialLinkKind(value: unknown): SocialLinkKind | null {
  return value === null ? null : socialLinkKind(value);
}

function socialSyntax(value: unknown): 'VALID' | 'INVALID' {
  if (value !== 'VALID' && value !== 'INVALID') throw invalid();
  return value;
}

function socialHttpOutcome(value: unknown): 'SUCCEEDED' | 'FAILED' {
  if (value !== 'SUCCEEDED' && value !== 'FAILED') throw invalid();
  return value;
}

function socialEvidenceType(value: unknown): SocialEvidenceType {
  if (
    value !== 'URL_SYNTAX_VALID'
    && value !== 'URL_SYNTAX_INVALID'
    && value !== 'URL_REACHABLE'
    && value !== 'CROSS_LINK_CONFIRMED'
    && value !== 'MINT_PUBLISHED'
    && value !== 'ACCOUNT_TOO_RECENT'
    && value !== 'DOMAIN_MISMATCH'
    && value !== 'CONTENT_UNAVAILABLE'
    && value !== 'VERIFICATION_UNKNOWN'
  ) throw invalid();
  return value;
}

function socialOutcome(value: unknown): SocialEvidenceOutcome {
  if (value !== 'CONFIRMED' && value !== 'REJECTED' && value !== 'UNKNOWN') throw invalid();
  return value;
}

function relationshipType(value: unknown): WalletRelationship['type'] {
  if (value !== 'DIRECT_QUOTE_TRANSFER' && value !== 'FEE_PAYER_FOR_BUYER') throw invalid();
  return value;
}

function relationshipConfidence(value: unknown): WalletRelationship['confidence'] {
  if (value !== 'STRONG' && value !== 'MEDIUM') throw invalid();
  return value;
}

function memberRole(value: unknown): WalletCluster['members'][number]['role'] {
  if (value !== 'PARTICIPANT' && value !== 'AUXILIARY_FUNDER') throw invalid();
  return value;
}

function invalid(): QualificationProjectionDataError {
  return new QualificationProjectionDataError();
}
