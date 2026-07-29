import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import {
  assertValidWalletGraphInput,
  assertValidWalletGraphProjection,
  WALLET_GRAPH_METHODOLOGY,
  WALLET_GRAPH_PAYLOAD_VERSION,
  type WalletGraphInput,
  type WalletGraphProjection,
} from '../domain/wallet-graph.js';
import type { WalletClusterDetectedEventV1 } from '../domain/wallet-graph-events.js';
import type {
  ActiveParticipantConfirmationStatus,
  ObservedWalletPosition,
  ParticipantAnalyticsLaunch,
  ParticipantAnalyticsTrade,
  ParticipantQuoteFlow,
} from '../domain/participant-analytics.js';
import {
  createWalletFundingAssessmentId,
  createWalletFundingEvidenceId,
  WALLET_FUNDING_PAYLOAD_VERSION,
  type WalletFundingAssessment,
  type WalletFundingBuy,
  type WalletFundingDiagnosticCode,
  type WalletFundingEvidence,
} from '../domain/wallet-funding.js';
import type {
  ChainCursor,
  QuoteAsset,
  TokenProgramKind,
} from '../domain/types.js';
import type {
  WalletGraphRepository,
  WalletGraphTransaction,
} from '../ports/wallet-graph-repository.js';
import {
  fromJsonValue,
  stringifyJson,
  toJsonValue,
} from '../utils/json.js';
import { getDatabasePool } from './database.js';

interface QueryResult {
  readonly rows: readonly QueryResultRow[];
  readonly rowCount: number | null;
}

interface GraphClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(): void;
}

export interface WalletGraphPool {
  connect(): Promise<GraphClient>;
}

interface LoadedBuy {
  readonly trade: ParticipantAnalyticsTrade;
  readonly fundingBuy: WalletFundingBuy;
}

const MEMBER_INSERT_BATCH_SIZE = 3_000;
const NO_PARTICIPANT_PROJECTION = 'NO_PARTICIPANT_PROJECTION';

export class WalletGraphDataError extends Error {
  public constructor(message = 'Stored wallet graph data is invalid.') {
    super(message);
    this.name = 'WalletGraphDataError';
  }
}

export class PostgresWalletGraphRepository implements WalletGraphRepository {
  public constructor(
    private readonly database: WalletGraphPool = getDatabasePool(),
  ) {}

  public async transact<TResult>(
    mint: string,
    operation: (transaction: WalletGraphTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    if (mint.length === 0) throw new TypeError('Wallet graph mint is required.');
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('wallet-graph:' || $1, 0))",
        [mint],
      );
      const result = await operation(new PostgresWalletGraphTransaction(client, mint));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

class PostgresWalletGraphTransaction implements WalletGraphTransaction {
  private loadedFingerprint: string | null = null;
  private participantInputFingerprint = NO_PARTICIPANT_PROJECTION;
  private participantAsOf: WalletGraphInput['participantAsOf'] = null;
  private participantConfirmationStatus:
    WalletGraphInput['participantConfirmationStatus'] = null;

  public constructor(
    private readonly client: GraphClient,
    private readonly lockedMint: string,
  ) {}

  public async loadCanonicalInput(mint: string): Promise<WalletGraphInput | null> {
    this.assertLockedMint(mint);
    const launchResult = await this.client.query(
      `SELECT event.event_id, launch.mint, launch.creator, event.source, event.program,
          event.signature, event.slot, event.transaction_index, event.instruction_index,
          event.inner_instruction_index, event.confirmation_status, event.observed_at
       FROM token_launches AS launch
       JOIN domain_events AS event
         ON event.mint = launch.mint
        AND event.type = 'TokenLaunchDetected'
        AND event.signature = launch.created_signature
        AND event.slot = launch.created_slot
        AND event.transaction_index = launch.created_transaction_index
        AND event.instruction_index = launch.created_instruction_index
        AND event.inner_instruction_index IS NOT DISTINCT FROM launch.created_inner_instruction_index
       WHERE launch.mint = $1
         AND event.confirmation_status <> 'orphaned'
       ORDER BY event.event_id
       LIMIT 1`,
      [mint],
    );
    const launchRow = launchResult.rows[0];
    if (launchRow === undefined) return null;
    const launch = launchFromRow(launchRow);

    const participantResult = await this.client.query(
      `SELECT profile.input_fingerprint, profile.confirmation_status,
          event.confirmation_status AS event_confirmation_status,
          event.event_id, event.signature, event.slot,
          event.transaction_index, event.instruction_index,
          event.inner_instruction_index, event.observed_at
       FROM creator_profiles AS profile
       JOIN domain_events AS event ON event.event_id = profile.profile_event_id
       WHERE profile.mint = $1
         AND event.confirmation_status <> 'orphaned'`,
      [mint],
    );
    const participantRow = participantResult.rows[0];
    if (participantRow === undefined) {
      this.participantInputFingerprint = NO_PARTICIPANT_PROJECTION;
      this.participantAsOf = null;
      this.participantConfirmationStatus = null;
    } else {
      this.participantInputFingerprint = text(participantRow.input_fingerprint);
      this.participantConfirmationStatus = activeConfirmation(
        participantRow.confirmation_status,
      );
      if (
        activeConfirmation(participantRow.event_confirmation_status)
        !== this.participantConfirmationStatus
      ) throw invalid();
      this.participantAsOf = Object.freeze({
        eventId: text(participantRow.event_id),
        signature: text(participantRow.signature),
        cursor: cursorFromRow(participantRow),
        observedAtMs: timestamp(participantRow.observed_at),
      });
    }

    const positionResult = await this.client.query(
      `SELECT wallet, is_creator, buy_count, sell_count, bought_base_raw,
          sold_base_raw, observed_net_base_raw, quote_flows,
          first_slot, first_transaction_index, first_instruction_index,
          first_inner_instruction_index, last_slot, last_transaction_index,
          last_instruction_index, last_inner_instruction_index
       FROM observed_wallet_positions
       WHERE mint = $1
       ORDER BY wallet`,
      [mint],
    );
    const positions = Object.freeze(positionResult.rows.map(positionFromRow));

    const buyResult = await this.client.query(
      `SELECT event.event_id, trade.trade_id, trade.mint, event.source, event.program,
          event.signature, event.slot, event.transaction_index, event.instruction_index,
          event.inner_instruction_index, event.confirmation_status,
          event.blockchain_time, event.observed_at, trade.trade_kind, trade.trader,
          trade.base_amount_raw, trade.quote_amount_raw, trade.quote_mint,
          trade.quote_decimals, trade.quote_token_program
       FROM launch_trades AS trade
       JOIN domain_events AS event
         ON event.mint = trade.mint
        AND event.type = 'BondingCurveTradeObserved'
        AND event.slot = trade.slot
        AND event.transaction_index = trade.transaction_index
        AND event.instruction_index = trade.instruction_index
        AND event.inner_instruction_index IS NOT DISTINCT FROM trade.inner_instruction_index
       WHERE trade.mint = $1
         AND trade.trade_kind = 'BUY'
         AND trade.trader IS NOT NULL
         AND trade.confirmation_status <> 'orphaned'
         AND event.confirmation_status <> 'orphaned'
       ORDER BY event.slot, event.transaction_index, event.instruction_index,
          COALESCE(event.inner_instruction_index, -1), trade.trade_id`,
      [mint],
    );
    const loadedBuys = buyResult.rows.map(loadedBuyFromRow);
    const buys = Object.freeze(loadedBuys.map((item) => item.trade));
    const fundingBuyByTrade = new Map(
      loadedBuys.map((item) => [item.trade.tradeId, item.fundingBuy]),
    );
    const tradeIds = loadedBuys.map((item) => item.trade.tradeId);

    const assessmentResult = await this.client.query(
      `SELECT assessment_id, trade_id, inspected_transfer_count,
          ignored_transfer_count, diagnostic_codes
       FROM wallet_funding_observations
       WHERE mint = $1
         AND confirmation_status <> 'orphaned'
         AND trade_id = ANY($2::text[])
       ORDER BY trade_id, assessment_id`,
      [mint, tradeIds],
    );
    const evidenceResult = await this.client.query(
      `SELECT evidence.evidence_id, evidence.evidence_type, evidence.confidence,
          evidence.buyer, evidence.funder, evidence.quote_mint,
          evidence.quote_decimals, evidence.quote_token_program,
          evidence.amount_raw, evidence.source, evidence.program,
          evidence.signature, evidence.transfer_slot,
          evidence.transfer_transaction_index, evidence.transfer_instruction_index,
          evidence.transfer_inner_instruction_index, evidence.buy_event_id,
          evidence.buy_trade_id, evidence.buy_slot,
          evidence.buy_transaction_index, evidence.buy_instruction_index,
          evidence.buy_inner_instruction_index, evidence.confirmation_status,
          evidence.blockchain_time, evidence.observed_at
       FROM wallet_funding_evidence AS evidence
       JOIN wallet_funding_observations AS observation
         ON observation.assessment_id = evidence.assessment_id
        AND observation.confirmation_status <> 'orphaned'
       WHERE evidence.mint = $1
         AND evidence.confirmation_status <> 'orphaned'
         AND evidence.buy_trade_id = ANY($2::text[])
       ORDER BY evidence.buy_trade_id, evidence.evidence_id`,
      [mint, tradeIds],
    );
    const evidence = Object.freeze(evidenceResult.rows.map((row) =>
      evidenceFromRow(row, fundingBuyByTrade)));
    const evidenceByTrade = groupEvidenceByTrade(evidence);
    const assessments = Object.freeze(assessmentResult.rows.map((row) =>
      assessmentFromRow(row, fundingBuyByTrade, evidenceByTrade)));

    const inputWithoutFingerprint = {
      launch,
      participantInputFingerprint: this.participantInputFingerprint,
      participantAsOf: this.participantAsOf,
      participantConfirmationStatus: this.participantConfirmationStatus,
      positions,
      buys,
      assessments,
      evidence,
    };
    const input: WalletGraphInput = Object.freeze({
      ...inputWithoutFingerprint,
      inputFingerprint: fingerprint(inputWithoutFingerprint),
    });
    assertValidWalletGraphInput(input);
    this.loadedFingerprint = input.inputFingerprint;
    return input;
  }

  public async replaceProjection(
    projection: WalletGraphProjection,
    event: WalletClusterDetectedEventV1,
  ): Promise<void> {
    this.assertLockedMint(projection.launch.mint);
    assertValidWalletGraphProjection(projection);
    if (
      this.loadedFingerprint === null
      || projection.inputFingerprint !== this.loadedFingerprint
    ) {
      throw new WalletGraphDataError(
        'Wallet graph projection does not match the locked canonical input.',
      );
    }
    await this.upsertDomainEvent(event);
    await this.client.query('DELETE FROM wallet_relationships WHERE mint = $1', [
      projection.launch.mint,
    ]);
    await this.client.query('DELETE FROM wallet_clusters WHERE mint = $1', [
      projection.launch.mint,
    ]);
    await this.insertRelationships(projection);
    await this.insertClusters(projection);
    await this.upsertProfile(projection, event);
    await this.insertSnapshot(projection, event);
  }

  private async upsertDomainEvent(event: WalletClusterDetectedEventV1): Promise<void> {
    await this.client.query(
      `INSERT INTO domain_events (
        event_id, type, mint, source, program, signature, slot,
        transaction_index, instruction_index, inner_instruction_index,
        confirmation_status, blockchain_time, observed_at, payload_version,
        payload, terminal_at, purge_after
      )
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12,$13,$14,
        launch.terminal_at, launch.purge_after
      FROM token_launches AS launch
      WHERE launch.mint = $3
      ON CONFLICT (event_id) DO UPDATE SET
        confirmation_status = EXCLUDED.confirmation_status,
        observed_at = EXCLUDED.observed_at,
        payload_version = EXCLUDED.payload_version,
        payload = EXCLUDED.payload,
        terminal_at = EXCLUDED.terminal_at,
        purge_after = EXCLUDED.purge_after
      WHERE domain_events.type = EXCLUDED.type
        AND domain_events.mint = EXCLUDED.mint
        AND domain_events.source = EXCLUDED.source
        AND domain_events.program = EXCLUDED.program
        AND domain_events.signature = EXCLUDED.signature
        AND domain_events.slot = EXCLUDED.slot
        AND domain_events.transaction_index = EXCLUDED.transaction_index
        AND domain_events.instruction_index = EXCLUDED.instruction_index
        AND domain_events.inner_instruction_index
          IS NOT DISTINCT FROM EXCLUDED.inner_instruction_index`,
      [
        event.id, event.type, event.mint, event.source, event.program,
        event.signature, event.cursor.slot.toString(),
        event.cursor.transactionIndex, event.cursor.instructionIndex,
        event.cursor.innerInstructionIndex, event.confirmationStatus,
        new Date(event.observedAtMs), event.payloadVersion, toJsonValue(event.payload),
      ],
    );
    const stored = await this.client.query(
      `SELECT type, mint, source, program, signature, slot,
          transaction_index, instruction_index, inner_instruction_index
       FROM domain_events
       WHERE event_id = $1`,
      [event.id],
    );
    const row = stored.rows[0];
    if (
      row?.type !== event.type
      || row.mint !== event.mint
      || row.source !== event.source
      || row.program !== event.program
      || row.signature !== event.signature
      || unsignedBigInt(row.slot) !== event.cursor.slot
      || index(row.transaction_index) !== event.cursor.transactionIndex
      || index(row.instruction_index) !== event.cursor.instructionIndex
      || nullableIndex(row.inner_instruction_index)
        !== event.cursor.innerInstructionIndex
    ) {
      throw new WalletGraphDataError('Wallet graph domain event identity conflicts.');
    }
  }

  private async insertRelationships(projection: WalletGraphProjection): Promise<void> {
    for (const relationship of projection.relationships) {
      await this.client.query(
        `INSERT INTO wallet_relationships (
          mint, relationship_id, left_wallet, right_wallet, relationship_type,
          confidence, evidence_count, quote_totals, input_fingerprint, purge_after
        )
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,launch.purge_after
        FROM token_launches AS launch WHERE launch.mint = $1`,
        [
          projection.launch.mint, relationship.id, relationship.leftWallet,
          relationship.rightWallet, relationship.type, relationship.confidence,
          relationship.evidenceCount, stringifyJson(relationship.quoteTotals),
          projection.inputFingerprint,
        ],
      );
    }
  }

  private async insertClusters(projection: WalletGraphProjection): Promise<void> {
    for (const cluster of projection.clusters) {
      await this.client.query(
        `INSERT INTO wallet_clusters (
          mint, cluster_id, input_fingerprint, participant_wallet_count,
          auxiliary_wallet_count, positive_holder_count,
          observed_positive_base_raw, concentration_bps, contains_creator,
          shared_funder_count, strong_relationship_count, strong_evidence_count,
          purge_after
        )
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,launch.purge_after
        FROM token_launches AS launch WHERE launch.mint = $1`,
        [
          projection.launch.mint, cluster.id, projection.inputFingerprint,
          cluster.participantWalletCount, cluster.auxiliaryWalletCount,
          cluster.positiveHolderCount, cluster.observedPositiveBaseRaw.toString(),
          cluster.concentrationBps.toString(), cluster.containsCreator,
          cluster.sharedFunderCount, cluster.strongRelationshipCount,
          cluster.strongEvidenceCount,
        ],
      );
    }
    const members = projection.clusters.flatMap((cluster) =>
      cluster.members.map((member) => ({ clusterId: cluster.id, member })));
    for (let start = 0; start < members.length; start += MEMBER_INSERT_BATCH_SIZE) {
      await this.insertMemberBatch(
        projection,
        members.slice(start, start + MEMBER_INSERT_BATCH_SIZE),
      );
    }
  }

  private async insertMemberBatch(
    projection: WalletGraphProjection,
    members: readonly {
      readonly clusterId: string;
      readonly member: WalletGraphProjection['clusters'][number]['members'][number];
    }[],
  ): Promise<void> {
    const values: unknown[] = [];
    const rows = members.map(({ clusterId, member }, rowIndex) => {
      const offset = rowIndex * 7;
      values.push(
        projection.launch.mint, clusterId, member.wallet, member.role,
        member.isCreator, member.observedNetBaseRaw.toString(),
        projection.inputFingerprint,
      );
      return `(${Array.from(
        { length: 7 },
        (_, indexValue) => `$${offset + indexValue + 1}`,
      ).join(',')})`;
    });
    await this.client.query(
      `WITH member_values (
        mint, cluster_id, wallet, member_role, is_creator,
        observed_net_base_raw, input_fingerprint
      ) AS (VALUES ${rows.join(',')})
      INSERT INTO wallet_cluster_members (
        mint, cluster_id, wallet, member_role, is_creator,
        observed_net_base_raw, input_fingerprint, purge_after
      )
      SELECT value.mint, value.cluster_id, value.wallet, value.member_role,
        value.is_creator::boolean, value.observed_net_base_raw::numeric,
        value.input_fingerprint, launch.purge_after
      FROM member_values AS value
      JOIN token_launches AS launch ON launch.mint = value.mint`,
      values,
    );
  }

  private async upsertProfile(
    projection: WalletGraphProjection,
    event: WalletClusterDetectedEventV1,
  ): Promise<void> {
    const aggregates = graphAggregates(projection);
    const { asOf } = projection;
    await this.client.query(
      `INSERT INTO wallet_graph_profiles (
        mint, input_fingerprint, participant_input_fingerprint, methodology,
        graph_event_id, as_of_event_id, as_of_signature, as_of_slot,
        as_of_transaction_index, as_of_instruction_index,
        as_of_inner_instruction_index, confirmation_status,
        confirmation_counts, coverage, strong_relationship_count,
        medium_relationship_count, cluster_count, maximum_cluster_bps,
        creator_cluster_count, observed_at, purge_after
      )
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
        $18,$19,$20,launch.purge_after
      FROM token_launches AS launch WHERE launch.mint = $1
      ON CONFLICT (mint) DO UPDATE SET
        input_fingerprint = EXCLUDED.input_fingerprint,
        participant_input_fingerprint = EXCLUDED.participant_input_fingerprint,
        methodology = EXCLUDED.methodology,
        graph_event_id = EXCLUDED.graph_event_id,
        as_of_event_id = EXCLUDED.as_of_event_id,
        as_of_signature = EXCLUDED.as_of_signature,
        as_of_slot = EXCLUDED.as_of_slot,
        as_of_transaction_index = EXCLUDED.as_of_transaction_index,
        as_of_instruction_index = EXCLUDED.as_of_instruction_index,
        as_of_inner_instruction_index = EXCLUDED.as_of_inner_instruction_index,
        confirmation_status = EXCLUDED.confirmation_status,
        confirmation_counts = EXCLUDED.confirmation_counts,
        coverage = EXCLUDED.coverage,
        strong_relationship_count = EXCLUDED.strong_relationship_count,
        medium_relationship_count = EXCLUDED.medium_relationship_count,
        cluster_count = EXCLUDED.cluster_count,
        maximum_cluster_bps = EXCLUDED.maximum_cluster_bps,
        creator_cluster_count = EXCLUDED.creator_cluster_count,
        observed_at = EXCLUDED.observed_at,
        purge_after = EXCLUDED.purge_after`,
      [
        projection.launch.mint, projection.inputFingerprint,
        this.participantInputFingerprint, projection.methodology, event.id,
        asOf.eventId, asOf.signature, asOf.cursor.slot.toString(),
        asOf.cursor.transactionIndex, asOf.cursor.instructionIndex,
        asOf.cursor.innerInstructionIndex, projection.confirmationStatus,
        toJsonValue(projection.confirmationCounts), toJsonValue(projection.coverage),
        aggregates.strongRelationshipCount, aggregates.mediumRelationshipCount,
        projection.clusters.length, aggregates.maximumClusterBps.toString(),
        aggregates.creatorClusterCount, new Date(asOf.observedAtMs),
      ],
    );
  }

  private async insertSnapshot(
    projection: WalletGraphProjection,
    event: WalletClusterDetectedEventV1,
  ): Promise<void> {
    const aggregates = graphAggregates(projection);
    const { asOf } = projection;
    await this.client.query(
      `INSERT INTO wallet_graph_snapshots (
        snapshot_id, mint, input_fingerprint, methodology, graph_event_id,
        coverage, strong_relationship_count, medium_relationship_count,
        cluster_count, maximum_cluster_bps, creator_cluster_count,
        confirmation_status, confirmation_counts, as_of_event_id,
        as_of_signature, as_of_slot, as_of_transaction_index,
        as_of_instruction_index, as_of_inner_instruction_index,
        observed_at, purge_after
      )
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
        $18,$19,$20,launch.purge_after
      FROM token_launches AS launch WHERE launch.mint = $2
      ON CONFLICT (mint, input_fingerprint) DO NOTHING`,
      [
        `wallet_graph_snapshot_${projection.inputFingerprint}`,
        projection.launch.mint, projection.inputFingerprint,
        projection.methodology, event.id, toJsonValue(projection.coverage),
        aggregates.strongRelationshipCount, aggregates.mediumRelationshipCount,
        projection.clusters.length, aggregates.maximumClusterBps.toString(),
        aggregates.creatorClusterCount, projection.confirmationStatus,
        toJsonValue(projection.confirmationCounts), asOf.eventId, asOf.signature,
        asOf.cursor.slot.toString(), asOf.cursor.transactionIndex,
        asOf.cursor.instructionIndex, asOf.cursor.innerInstructionIndex,
        new Date(asOf.observedAtMs),
      ],
    );
  }

  private assertLockedMint(mint: string): void {
    if (mint !== this.lockedMint) {
      throw new WalletGraphDataError(
        'Wallet graph transaction mint does not match its lock.',
      );
    }
  }
}

function launchFromRow(row: QueryResultRow): ParticipantAnalyticsLaunch {
  return Object.freeze({
    eventId: text(row.event_id),
    mint: text(row.mint),
    creator: text(row.creator),
    source: text(row.source),
    program: text(row.program),
    signature: text(row.signature),
    cursor: cursorFromRow(row),
    confirmationStatus: activeConfirmation(row.confirmation_status),
    observedAtMs: timestamp(row.observed_at),
  });
}

function loadedBuyFromRow(row: QueryResultRow): LoadedBuy {
  const quoteAsset = quoteAssetFromRow(row);
  const cursor = cursorFromRow(row);
  const confirmationStatus = activeConfirmation(row.confirmation_status);
  const trader = text(row.trader);
  const trade = Object.freeze({
    eventId: text(row.event_id),
    tradeId: text(row.trade_id),
    launchMint: text(row.mint),
    signature: text(row.signature),
    cursor,
    confirmationStatus,
    observedAtMs: timestamp(row.observed_at),
    kind: 'BUY' as const,
    trader,
    baseAmountRaw: unsignedBigInt(row.base_amount_raw),
    quoteAmountRaw: unsignedBigInt(row.quote_amount_raw),
    quoteAsset,
  });
  return {
    trade,
    fundingBuy: Object.freeze({
      eventId: trade.eventId,
      tradeId: trade.tradeId,
      mint: trade.launchMint,
      buyer: trader,
      source: text(row.source),
      program: text(row.program),
      quoteAsset,
      signature: trade.signature,
      cursor,
      confirmationStatus,
      blockchainTimeMs: nullableTimestamp(row.blockchain_time),
      observedAtMs: trade.observedAtMs,
    }),
  };
}

function positionFromRow(row: QueryResultRow): ObservedWalletPosition {
  return Object.freeze({
    wallet: text(row.wallet),
    isCreator: booleanValue(row.is_creator),
    buyCount: index(row.buy_count),
    sellCount: index(row.sell_count),
    boughtBaseRaw: unsignedBigInt(row.bought_base_raw),
    soldBaseRaw: unsignedBigInt(row.sold_base_raw),
    observedNetBaseRaw: signedBigInt(row.observed_net_base_raw),
    quoteFlows: quoteFlows(row.quote_flows),
    firstObservedCursor: prefixedCursorFromRow(row, 'first'),
    lastObservedCursor: prefixedCursorFromRow(row, 'last'),
  });
}

function assessmentFromRow(
  row: QueryResultRow,
  buyByTrade: ReadonlyMap<string, WalletFundingBuy>,
  evidenceByTrade: ReadonlyMap<string, readonly WalletFundingEvidence[]>,
): WalletFundingAssessment {
  const tradeId = text(row.trade_id);
  const buy = buyByTrade.get(tradeId);
  if (buy === undefined) throw invalid();
  const evidence = evidenceByTrade.get(tradeId) ?? [];
  const diagnosticCodes = diagnostics(row.diagnostic_codes);
  const hasUnavailable = diagnosticCodes.some(
    (code) => code !== 'SELF_TRANSFER_IGNORED',
  );
  const status = evidence.some((item) => item.confidence === 'STRONG')
    ? 'STRONG'
    : evidence.some((item) => item.confidence === 'MEDIUM')
      ? 'MEDIUM_ONLY'
      : hasUnavailable
        ? 'UNAVAILABLE'
        : 'NO_EVIDENCE';
  const assessment = Object.freeze({
    id: text(row.assessment_id),
    buy,
    status,
    inspectedTransferCount: index(row.inspected_transfer_count),
    acceptedEvidenceCount: evidence.length,
    ignoredTransferCount: index(row.ignored_transfer_count),
    diagnosticCodes,
    payloadVersion: WALLET_FUNDING_PAYLOAD_VERSION,
  });
  if (assessment.id !== createWalletFundingAssessmentId(buy)) throw invalid();
  return assessment;
}

function evidenceFromRow(
  row: QueryResultRow,
  buyByTrade: ReadonlyMap<string, WalletFundingBuy>,
): WalletFundingEvidence {
  const tradeId = text(row.buy_trade_id);
  const buy = buyByTrade.get(tradeId);
  if (buy === undefined) throw invalid();
  const common = {
    id: text(row.evidence_id),
    mint: buy.mint,
    buyer: text(row.buyer),
    funder: text(row.funder),
    quoteAsset: quoteAssetFromRow(row),
    source: text(row.source),
    program: text(row.program),
    signature: text(row.signature),
    buyEventId: text(row.buy_event_id),
    buyTradeId: tradeId,
    buyCursor: prefixedCursorFromRow(row, 'buy'),
    confirmationStatus: activeConfirmation(row.confirmation_status),
    blockchainTimeMs: nullableTimestamp(row.blockchain_time),
    observedAtMs: timestamp(row.observed_at),
    payloadVersion: WALLET_FUNDING_PAYLOAD_VERSION,
  };
  const type: unknown = row.evidence_type;
  let evidence: WalletFundingEvidence;
  if (type === 'DIRECT_QUOTE_TRANSFER') {
    evidence = Object.freeze({
      ...common,
      type,
      confidence: 'STRONG',
      amountRaw: positiveBigInt(row.amount_raw),
      transferCursor: prefixedCursorFromRow(row, 'transfer'),
    });
  } else if (type === 'FEE_PAYER_FOR_BUYER') {
    evidence = Object.freeze({
        ...common,
        type,
        confidence: 'MEDIUM',
        amountRaw: null,
        transferCursor: null,
    });
  } else {
    throw invalid();
  }
  if (evidence.id !== createWalletFundingEvidenceId(evidence)) throw invalid();
  return evidence;
}

function groupEvidenceByTrade(
  evidence: readonly WalletFundingEvidence[],
): ReadonlyMap<string, readonly WalletFundingEvidence[]> {
  const grouped = new Map<string, WalletFundingEvidence[]>();
  for (const item of evidence) {
    const current = grouped.get(item.buyTradeId) ?? [];
    current.push(item);
    grouped.set(item.buyTradeId, current);
  }
  return grouped;
}

function graphAggregates(projection: WalletGraphProjection): {
  readonly strongRelationshipCount: number;
  readonly mediumRelationshipCount: number;
  readonly maximumClusterBps: bigint;
  readonly creatorClusterCount: number;
} {
  return {
    strongRelationshipCount: projection.relationships.filter(
      (item) => item.confidence === 'STRONG',
    ).length,
    mediumRelationshipCount: projection.relationships.filter(
      (item) => item.confidence === 'MEDIUM',
    ).length,
    maximumClusterBps: projection.clusters.reduce(
      (maximum, cluster) =>
        cluster.concentrationBps > maximum ? cluster.concentrationBps : maximum,
      0n,
    ),
    creatorClusterCount: projection.clusters.filter(
      (cluster) => cluster.containsCreator,
    ).length,
  };
}

function fingerprint(
  input: Omit<WalletGraphInput, 'inputFingerprint'>,
): string {
  return createHash('sha256').update(JSON.stringify(toJsonValue({
    payloadVersion: WALLET_GRAPH_PAYLOAD_VERSION,
    methodology: WALLET_GRAPH_METHODOLOGY,
    launch: input.launch,
    participantInputFingerprint: input.participantInputFingerprint,
    positions: input.positions,
    buys: input.buys,
    assessments: input.assessments,
    evidence: input.evidence,
  }))).digest('hex');
}

function cursorFromRow(row: QueryResultRow): ChainCursor {
  return Object.freeze({
    slot: unsignedBigInt(row.slot),
    transactionIndex: index(row.transaction_index),
    instructionIndex: index(row.instruction_index),
    innerInstructionIndex: nullableIndex(row.inner_instruction_index),
  });
}

function prefixedCursorFromRow(
  row: QueryResultRow,
  prefix: 'first' | 'last' | 'buy' | 'transfer',
): ChainCursor {
  return Object.freeze({
    slot: unsignedBigInt(row[`${prefix}_slot`]),
    transactionIndex: index(row[`${prefix}_transaction_index`]),
    instructionIndex: index(row[`${prefix}_instruction_index`]),
    innerInstructionIndex: nullableIndex(row[`${prefix}_inner_instruction_index`]),
  });
}

function quoteAssetFromRow(row: QueryResultRow): QuoteAsset {
  return Object.freeze({
    mint: text(row.quote_mint),
    decimals: decimals(row.quote_decimals),
    tokenProgram: tokenProgram(row.quote_token_program),
  });
}

function quoteFlows(value: unknown): readonly ParticipantQuoteFlow[] {
  const decoded = fromJsonValue(value);
  if (!Array.isArray(decoded)) throw invalid();
  return Object.freeze(decoded.map((entry) => {
    if (!isRecord(entry)) throw invalid();
    return Object.freeze({
      quoteAsset: quoteAssetFromJson(entry.quoteAsset),
      boughtQuoteRaw: unsignedBigInt(entry.boughtQuoteRaw),
      soldQuoteRaw: unsignedBigInt(entry.soldQuoteRaw),
    });
  }));
}

function quoteAssetFromJson(value: unknown): QuoteAsset {
  if (!isRecord(value)) throw invalid();
  return Object.freeze({
    mint: text(value.mint),
    decimals: decimals(value.decimals),
    tokenProgram: tokenProgram(value.tokenProgram),
  });
}

function diagnostics(value: unknown): readonly WalletFundingDiagnosticCode[] {
  if (!Array.isArray(value)) throw invalid();
  const items: readonly unknown[] = value;
  const result = items.map((item): WalletFundingDiagnosticCode => {
    if (
      item !== 'OWNER_AMBIGUOUS'
      && item !== 'TOKEN_BALANCE_UNAVAILABLE'
      && item !== 'KNOWN_TRANSFER_INVALID'
      && item !== 'SELF_TRANSFER_IGNORED'
    ) throw invalid();
    return item;
  });
  return Object.freeze(result);
}

function activeConfirmation(value: unknown): ActiveParticipantConfirmationStatus {
  if (value !== 'processed' && value !== 'confirmed' && value !== 'finalized') {
    throw invalid();
  }
  return value;
}

function tokenProgram(value: unknown): TokenProgramKind {
  if (value !== 'SPL_TOKEN' && value !== 'TOKEN_2022') throw invalid();
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid();
  return value;
}

function unsignedBigInt(value: unknown): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) throw invalid();
  return BigInt(value);
}

function positiveBigInt(value: unknown): bigint {
  const result = unsignedBigInt(value);
  if (result === 0n) throw invalid();
  return result;
}

function signedBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)$/u.test(value)) throw invalid();
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

function nullableIndex(value: unknown): number | null {
  return value === null ? null : index(value);
}

function decimals(value: unknown): number {
  const valueAsIndex = index(value);
  if (valueAsIndex > 255) throw invalid();
  return valueAsIndex;
}

function timestamp(value: unknown): number {
  if (!(value instanceof Date)) throw invalid();
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw invalid();
  return milliseconds;
}

function nullableTimestamp(value: unknown): number | null {
  return value === null ? null : timestamp(value);
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): WalletGraphDataError {
  return new WalletGraphDataError();
}
