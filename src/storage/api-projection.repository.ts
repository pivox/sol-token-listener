import {
  MAX_API_CLUSTER_QUOTE_ASSETS,
  MAX_API_TOTAL_CLUSTER_QUOTE_ASSETS,
  toApiDomainPayload,
  type ApiHealth,
  type ApiHolders,
  type ApiHolderSnapshot,
  type ApiLaunchDetail,
  type ApiLaunchSummary,
  type ApiObservedWalletPosition,
  type ApiWalletCluster,
  type ApiWalletClusterMember,
  type ApiWalletGraphAvailable,
  type ApiWalletGraphCoverage,
  type ApiWalletGraphUnavailable,
  type ApiPage,
  type ApiParticipantQuoteFlow,
  type ApiPaperPosition,
  type ApiQualification,
  type ApiQualificationCondition,
  type ApiCreatorProfile,
  type ApiCreatorTradeEvidence,
  type ApiAnalyticsCursor,
  type ApiSocial,
  type ApiTimelineEntry,
} from '../api/contracts.js';
import { isProxy } from 'node:util/types';
import {
  MAX_TIMELINE_INDEX,
  MAX_TIMELINE_SLOT,
  encodeLaunchCursor,
  encodePaperPositionCursor,
  encodeTimelineCursor,
  type LaunchPagePosition,
  type PaperPositionPagePosition,
  type TimelinePagePosition,
} from '../api/cursor.js';
import { DOMAIN_EVENT_TYPES } from '../domain/events.js';
import { LAUNCH_STATUSES } from '../domain/launch-status.js';
import {
  LISTENER_RUNTIME_STATES,
  type ListenerRuntimeState,
} from '../domain/transaction-ingestion.js';
import { QUALIFICATION_REASON_CODES } from '../domain/qualification-reasons.js';
import {
  QUALIFICATION_CONDITION_MODES,
  QUALIFICATION_CONDITION_STATUSES,
  QUALIFICATION_SIGNAL_KEYS,
} from '../domain/qualification.js';
import { MAX_API_PAGE_LIMIT, type ApiProjectionRepository, type PageRequest } from '../ports/api-projection-repository.js';
import {
  BIGINT_JSON_MARKER,
  MAX_SERIALIZED_BIGINT_DIGITS,
  fromJsonValue,
} from '../utils/json.js';
import { getDatabasePool } from './database.js';

export interface Queryable {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  connect?(): Promise<QueryClient>;
}

interface QueryClient {
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  release(): void;
}

export interface ApiProjectionPipelineState {
  readonly httpAvailable: boolean;
  readonly pumpfun: ApiHealth['pipeline']['pumpfun'];
  readonly pumpswap: ApiHealth['pipeline']['pumpswap'];
}

export type ApiProjectionPipelineStateProvider = () => ApiProjectionPipelineState;

export interface ApiHolderProjectionLimits {
  readonly positions: number;
  readonly snapshots: number;
  readonly clusters: number;
  readonly clusterMembers: number;
  readonly totalClusterMembers: number;
}

export class ApiProjectionDataError extends Error {
  public constructor() {
    super('Stored API projection data is invalid.');
    this.name = 'ApiProjectionDataError';
  }
}

interface LaunchRow extends Record<string, unknown> {
  readonly mint: unknown;
  readonly detected_at: unknown;
  readonly created_slot: unknown;
  readonly current_state: unknown;
  readonly creator: unknown;
  readonly token_program: unknown;
  readonly launchpad: unknown;
  readonly quote_assets: unknown;
  readonly initial_token_amount: unknown;
  readonly initial_quote_amount: unknown;
}

interface LaunchProjections {
  readonly metadata: ReadonlyMap<string, Record<string, unknown>>;
  readonly curves: ReadonlyMap<string, Record<string, unknown>>;
  readonly markets: ReadonlyMap<string, Record<string, unknown>>;
}

const NOT_AVAILABLE_SOCIAL: ApiSocial = Object.freeze({
  status: 'NOT_AVAILABLE', links: Object.freeze([] as []), evidence: Object.freeze([] as []),
});
const NOT_AVAILABLE_HOLDERS: ApiHolders = Object.freeze({
  status: 'NOT_AVAILABLE',
  snapshots: Object.freeze([] as []),
  positions: Object.freeze([] as []),
  clusters: Object.freeze([] as []),
  clusterAnalysisStatus: 'NOT_AVAILABLE',
});

export class PostgresApiProjectionRepository implements ApiProjectionRepository {
  private readonly pipeline: ApiProjectionPipelineStateProvider;

  public constructor(
    private readonly database: Queryable = getDatabasePool(),
    private readonly clock: () => Date = () => new Date(),
    pipeline: ApiProjectionPipelineState | ApiProjectionPipelineStateProvider = {
      httpAvailable: false,
      pumpfun: 'STOPPED',
      pumpswap: 'STOPPED',
    },
    private readonly holderLimits: ApiHolderProjectionLimits = {
      positions: 100,
      snapshots: 100,
      clusters: 50,
      clusterMembers: 50,
      totalClusterMembers: 500,
    },
  ) {
    holderLimit(holderLimits.positions);
    holderLimit(holderLimits.snapshots);
    boundedLimit(holderLimits.clusters, 100);
    boundedLimit(holderLimits.clusterMembers, 100);
    boundedLimit(holderLimits.totalClusterMembers, 1_000);
    this.pipeline = typeof pipeline === 'function'
      ? pipeline
      : (): ApiProjectionPipelineState => pipeline;
  }

  public async listLaunches(
    request: PageRequest<LaunchPagePosition>,
  ): Promise<ApiPage<ApiLaunchSummary>> {
    const limit = pageLimit(request.limit);
    const position = request.after === null ? null : {
      detectedAtMs: validatedTimestampMs(request.after.detectedAtMs),
      mint: text(request.after.mint),
    };
    if (this.database.connect !== undefined) {
      return this.withSnapshot((repository) => repository.listLaunches({ limit, after: position }));
    }
    const values = position === null
      ? [limit + 1]
      : [dateFromMs(position.detectedAtMs), position.mint, limit + 1];
    const after = position === null ? '' : `
      AND (launch.detected_at < $1 OR (launch.detected_at = $1 AND launch.mint > $2))`;
    const limitParameter = position === null ? '$1' : '$3';
    const result = await this.database.query(`${launchSelect}
      WHERE NOT EXISTS (
        SELECT 1 FROM domain_events AS launch_event
        WHERE launch_event.mint = launch.mint
          AND launch_event.type = 'TokenLaunchDetected'
          AND launch_event.confirmation_status = 'orphaned'
      )${after}
      ORDER BY launch.detected_at DESC, launch.mint ASC
      LIMIT ${limitParameter}`, values);
    return this.toLaunchPage(result.rows as readonly LaunchRow[], limit);
  }

  public async getLaunch(mint: string): Promise<ApiLaunchDetail | null> {
    if (this.database.connect !== undefined) return this.withSnapshot((repository) => repository.getLaunch(mint));
    const launches = await this.findLaunches(text(mint));
    const launch = launches[0];
    if (launch === undefined) return null;
    const projections = await this.loadLaunchProjections([text(mint)]);
    const holders = await this.loadHolders(text(mint));
    return assembleLaunchDetail(launch, projections, holders);
  }

  public async listLaunchEvents(mint: string, request: PageRequest<TimelinePagePosition>): Promise<ApiPage<ApiTimelineEntry>> {
    const limit = pageLimit(request.limit);
    const after = request.after;
    const afterSql = after === null ? '' : ` WHERE (slot, transaction_index, instruction_index, inner_sort, id)
        > ($2::numeric, $3::integer, $4::integer, $5::integer, $6::text)`;
    const values = after === null ? [text(mint), limit + 1] : [text(mint), timelineSlot(after.slot),
      timelineIndex(after.transactionIndex), timelineIndex(after.instructionIndex),
      after.innerInstructionIndex === null ? -1 : timelineIndex(after.innerInstructionIndex),
      text(after.id), limit + 1];
    const limitParameter = after === null ? '$2' : '$7';
    const result = await this.database.query(
      `WITH timeline AS (
       SELECT domain_event.event_id AS id, domain_event.type,
          COALESCE(domain_event.blockchain_time, domain_event.observed_at) AS occurred_at,
          domain_event.slot, domain_event.transaction_index, domain_event.instruction_index,
          domain_event.inner_instruction_index, domain_event.confirmation_status,
          domain_event.payload_version, domain_event.payload,
          COALESCE(domain_event.inner_instruction_index, -1) AS inner_sort
       FROM domain_events AS domain_event
       WHERE domain_event.mint = $1
       UNION ALL
       SELECT transition.transition_id AS id, transition.trigger_event AS type,
          transition.occurred_at, domain_event.slot, domain_event.transaction_index,
          domain_event.instruction_index, domain_event.inner_instruction_index,
          domain_event.confirmation_status, 1 AS payload_version,
          jsonb_build_object(
            'previousStatus', transition.previous_state,
            'newStatus', transition.new_state,
            'reasonCode', transition.reason_code,
            'message', transition.human_message,
            'evidence', transition.evidence
          ) AS payload,
          COALESCE(domain_event.inner_instruction_index, -1) AS inner_sort
       FROM state_transitions AS transition
       JOIN domain_events AS domain_event ON domain_event.event_id = transition.event_id
       WHERE transition.mint = $1
      )
      SELECT id, type, occurred_at, slot, transaction_index, instruction_index,
        inner_instruction_index, confirmation_status, payload_version, payload
      FROM timeline${afterSql}
      ORDER BY slot, transaction_index, instruction_index, inner_sort, id
      LIMIT ${limitParameter}`,
      values,
    );
    const rows = result.rows.slice(0, limit);
    const items = freeze(rows.map(toTimelineEntry));
    const last = result.rows.length > limit ? rows.at(-1) : undefined;
    return freeze({ items, nextCursor: last === undefined ? null : encodeTimelineCursor({
      slot: timelineSlot(last.slot), transactionIndex: timelineIndex(last.transaction_index),
      instructionIndex: timelineIndex(last.instruction_index),
      innerInstructionIndex: last.inner_instruction_index === null ? null : timelineIndex(last.inner_instruction_index),
      id: text(last.id),
    }) });
  }

  public async getLaunchRisk(mint: string): Promise<ApiQualification | null> {
    const result = await this.database.query(
      `SELECT payload
       FROM domain_events
       WHERE mint = $1 AND type = 'QualificationUpdated'
         AND confirmation_status <> 'orphaned'
       ORDER BY slot DESC, transaction_index DESC, instruction_index DESC,
         COALESCE(inner_instruction_index, -1) DESC, event_id DESC
       LIMIT 1`,
      [text(mint)],
    );
    const row = result.rows[0];
    return row === undefined ? null : qualification(row.payload);
  }

  public async getLaunchSocial(mint: string): Promise<ApiSocial | null> {
    return (await this.findLaunches(text(mint))).length === 0 ? null : NOT_AVAILABLE_SOCIAL;
  }

  public async getLaunchHolders(mint: string): Promise<ApiHolders | null> {
    if (this.database.connect !== undefined) {
      return this.withSnapshot((repository) => repository.getLaunchHolders(mint));
    }
    const validatedMint = text(mint);
    return (await this.findLaunches(validatedMint)).length === 0
      ? null
      : this.loadHolders(validatedMint);
  }

  public async listPaperPositions(
    request: PageRequest<PaperPositionPagePosition>,
  ): Promise<ApiPage<ApiPaperPosition>> {
    const limit = pageLimit(request.limit);
    const values = request.after === null
      ? [limit + 1]
      : [dateFromMs(request.after.openedAtMs), text(request.after.id), limit + 1];
    const after = request.after === null ? '' : `
      WHERE (position.opened_at < $1 OR (position.opened_at = $1 AND position.position_id > $2))`;
    const limitParameter = request.after === null ? '$1' : '$3';
    const result = await this.database.query(
      `SELECT position.position_id, position.mint, position.status, position.opened_at,
          position.closed_at, position.quote_mint, position.remaining_base_raw,
          position.quote_cost_raw, position.quote_proceeds_raw, position.net_pnl_quote_raw,
          position.exit_trade_id,
          entry_trade.fees_raw AS entry_fees_raw, exit_trade.fees_raw AS exit_fees_raw
       FROM paper_positions AS position
       JOIN paper_trades AS entry_trade ON entry_trade.trade_id = position.entry_trade_id
       LEFT JOIN paper_trades AS exit_trade ON exit_trade.trade_id = position.exit_trade_id
       ${after}
       ORDER BY position.opened_at DESC, position.position_id ASC
       LIMIT ${limitParameter}`,
      values,
    );
    const more = result.rows.length > limit;
    const items = result.rows.slice(0, limit).map(toPaperPosition);
    const next = more ? items.at(-1) : undefined;
    return freeze({
      items: freeze(items),
      nextCursor: next === undefined ? null : encodePaperPositionCursor({
        openedAtMs: Date.parse(next.openedAt), id: next.id,
      }),
    });
  }

  public async getHealth(): Promise<ApiHealth> {
    const observedAt = validDate(this.clock());
    let pipeline = DEGRADED_PIPELINE_STATE;
    try {
      pipeline = pipelineState(this.pipeline);
      const database = await this.database.query('SELECT 1 AS available');
      const checkpoints = await this.database.query(
        `SELECT checkpoint_key, slot FROM processing_checkpoints
         WHERE checkpoint_key = ANY($1)`,
        [['launchpad', 'market']],
      );
      const heartbeats = await this.database.query(
        `SELECT updated_at, started_at, last_http_slot, last_websocket_slot,
            last_finalized_slot, last_signature, pending_transactions, active_sessions,
            runtime_state, subscriber_state, scanner_state, worker_state,
            reconciler_state, leased_transactions, exhausted_transactions
         FROM listener_heartbeats ORDER BY updated_at DESC LIMIT 1`,
      );
      const checkpoint = new Map(checkpoints.rows.map((item) => [text(item.checkpoint_key), decimal(item.slot)]));
      const row = heartbeats.rows[0];
      const heartbeat = row === undefined ? emptyHeartbeat() : heartbeatFromRow(row);
      const lagSlots = heartbeat.lastHttpSlot === null || heartbeat.lastWebsocketSlot === null
        ? null : (BigInt(heartbeat.lastHttpSlot) - BigInt(heartbeat.lastWebsocketSlot)).toString();
      const heartbeatAge = heartbeat.updatedAt === null
        ? null : observedAt.getTime() - Date.parse(heartbeat.updatedAt);
      const stale = heartbeatAge === null
        || heartbeatAge < 0
        || heartbeatAge > HEARTBEAT_STALE_AFTER_MS;
      const runtimeDegraded = heartbeat.runtimeState !== 'RUNNING'
        || heartbeat.subscriberState !== 'RUNNING'
        || heartbeat.scannerState !== 'RUNNING'
        || heartbeat.workerState !== 'RUNNING'
        || heartbeat.reconcilerState !== 'RUNNING';
      const degraded = database.rows.length === 0 || stale || runtimeDegraded || !pipeline.httpAvailable
      || pipeline.pumpfun === 'DEGRADED' || pipeline.pumpfun === 'STOPPED'
      || pipeline.pumpswap === 'DEGRADED' || pipeline.pumpswap === 'STOPPED';
      return healthResult(observedAt, database.rows.length > 0, degraded, checkpoint, heartbeat, lagSlots, pipeline);
    } catch {
      return healthResult(
        observedAt,
        false,
        true,
        new Map(),
        emptyHeartbeat(),
        null,
        pipeline,
      );
    }
  }

  private async toLaunchPage(rows: readonly LaunchRow[], limit: number): Promise<ApiPage<ApiLaunchSummary>> {
    const projections = await this.loadLaunchProjections(rows.map((row) => text(row.mint)));
    const more = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const next = more ? pageRows.at(-1) : undefined;
    return freeze({
      items: freeze(pageRows.map((row) => assembleLaunchSummary(row, projections))),
      nextCursor: next === undefined ? null : encodeLaunchCursor({
        detectedAtMs: timestamp(next.detected_at).getTime(), mint: text(next.mint),
      }),
    });
  }

  private async withSnapshot<T>(operation: (repository: PostgresApiProjectionRepository) => Promise<T>): Promise<T> {
    if (this.database.connect === undefined) return operation(this);
    const client = await this.database.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const executor: Queryable = { query: (textValue, values) => client.query(textValue, values) };
      const result = await operation(new PostgresApiProjectionRepository(
        executor,
        this.clock,
        this.pipeline,
        this.holderLimits,
      ));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async findLaunches(mint: string): Promise<readonly LaunchRow[]> {
    const result = await this.database.query(`${launchSelect}
      WHERE launch.mint = $1
        AND NOT EXISTS (
          SELECT 1 FROM domain_events AS launch_event
          WHERE launch_event.mint = launch.mint
            AND launch_event.type = 'TokenLaunchDetected'
            AND launch_event.confirmation_status = 'orphaned'
        )`, [mint]);
    return result.rows as readonly LaunchRow[];
  }

  private async loadLaunchProjections(mints: readonly string[]): Promise<LaunchProjections> {
    if (mints.length === 0) return { metadata: new Map(), curves: new Map(), markets: new Map() };
    const metadata = await this.database.query(
      `SELECT DISTINCT ON (snapshot.mint) snapshot.mint, snapshot.metadata
         FROM token_metadata_snapshots AS snapshot
         WHERE snapshot.mint = ANY($1) AND snapshot.resolution_status = 'resolved'
         ORDER BY snapshot.mint, snapshot.fetched_at DESC, snapshot.snapshot_id DESC`,
      [mints],
    );
    const curves = await this.database.query(
      `SELECT DISTINCT ON (curve.mint) curve.mint, curve.quote_mint, curve.quote_decimals,
            curve.real_base_reserves_raw, curve.real_quote_reserves_raw, curve.virtual_quote_reserves_raw
         FROM bonding_curve_snapshots AS curve
         WHERE curve.mint = ANY($1) AND curve.confirmation_status <> 'orphaned'
         ORDER BY curve.mint, curve.slot DESC, curve.transaction_index DESC,
            curve.instruction_index DESC, COALESCE(curve.inner_instruction_index, -1) DESC,
            curve.snapshot_id DESC`,
      [mints],
    );
    const markets = await this.database.query(
      `SELECT DISTINCT ON (migration.mint) migration.mint, migration.quote_mint,
            migration.quote_decimals, pool.payload AS pool_payload,
            reserve.base_reserves_raw, reserve.quote_vault_amount_raw
         FROM migrations AS migration
         JOIN domain_events AS migration_event ON migration_event.event_id = migration.event_id
         LEFT JOIN LATERAL (
           SELECT market_pool.* FROM market_pools AS market_pool
           WHERE market_pool.migration_id = migration.migration_id
             AND market_pool.confirmation_status <> 'orphaned'
           ORDER BY market_pool.slot DESC, market_pool.transaction_index DESC,
             market_pool.instruction_index DESC, COALESCE(market_pool.inner_instruction_index, -1) DESC,
             market_pool.pool_address DESC
           LIMIT 1
         ) AS pool ON true
         LEFT JOIN LATERAL (
           SELECT snapshot.* FROM market_reserve_snapshots AS snapshot
           WHERE snapshot.pool_address = pool.pool_address
             AND snapshot.confirmation_status <> 'orphaned'
           ORDER BY snapshot.observed_slot DESC, snapshot.trigger_slot DESC,
             snapshot.transaction_index DESC, snapshot.instruction_index DESC,
             COALESCE(snapshot.inner_instruction_index, -1) DESC, snapshot.snapshot_id DESC
           LIMIT 1
         ) AS reserve ON true
         WHERE migration.mint = ANY($1) AND migration.confirmation_status <> 'orphaned'
         ORDER BY migration.mint, migration_event.slot DESC, migration_event.transaction_index DESC,
           migration_event.instruction_index DESC,
           COALESCE(migration_event.inner_instruction_index, -1) DESC,
           migration.event_id DESC,
           migration.migration_id DESC`,
      [mints],
    );
    return {
      metadata: rowsByMint(metadata.rows), curves: rowsByMint(curves.rows), markets: rowsByMint(markets.rows),
    };
  }

  private async loadHolders(mint: string): Promise<ApiHolders> {
    const profileResult = await this.database.query(
      `SELECT payload
       FROM creator_profiles
       WHERE mint = $1`,
      [mint],
    );
    const profileRow = profileResult.rows[0];
    if (profileRow === undefined) return NOT_AVAILABLE_HOLDERS;
    try {
      const storedProfile = restoredRecord(profileRow.payload);
      const inputFingerprint = text(storedProfile.inputFingerprint);
      const creatorProfile = toCreatorProfileRecord(storedProfile);
      const currentSnapshotResult = await this.database.query(
        `SELECT snapshot_id, input_fingerprint, observed_at, confirmation_status,
          as_of_slot, as_of_transaction_index, as_of_instruction_index,
          as_of_inner_instruction_index, total_positive_net_base_raw,
          top1_bps, top5_bps, top10_bps, creator_bps, unique_known_buyers,
          unique_external_buyers, positive_position_count,
          unknown_trader_trade_count
         FROM token_holders_snapshots
         WHERE mint = $1 AND input_fingerprint = $2
         LIMIT 1`,
        [mint, inputFingerprint],
      );
      const snapshotResult = await this.database.query(
        `SELECT snapshot_id, input_fingerprint, observed_at, confirmation_status,
          as_of_slot, as_of_transaction_index, as_of_instruction_index,
          as_of_inner_instruction_index, total_positive_net_base_raw,
          top1_bps, top5_bps, top10_bps, creator_bps, unique_known_buyers,
          unique_external_buyers, positive_position_count,
          unknown_trader_trade_count
       FROM token_holders_snapshots
       WHERE mint = $1
       ORDER BY as_of_slot DESC, as_of_transaction_index DESC,
          as_of_instruction_index DESC,
          COALESCE(as_of_inner_instruction_index, -1) DESC,
          snapshot_id DESC
       LIMIT $2`,
        [mint, this.holderLimits.snapshots],
      );
      const positionResult = await this.database.query(
        `SELECT payload
         FROM observed_wallet_positions
         WHERE mint = $1
         ORDER BY observed_net_base_raw DESC, wallet ASC
         LIMIT $2`,
        [mint, this.holderLimits.positions],
      );
      const currentSnapshotRow = currentSnapshotResult.rows[0];
      if (currentSnapshotRow === undefined) throw invalid();
      const snapshots = freeze(snapshotResult.rows.map(toHolderSnapshot));
      const graph = await this.loadWalletGraph(mint);
      const holders: ApiHolders = {
        status: 'AVAILABLE',
        methodology: 'OBSERVED_BONDING_CURVE_TRADES',
        creatorProfile,
        latestSnapshot: toHolderSnapshot(currentSnapshotRow),
        snapshots,
        positions: freeze(positionResult.rows.map((row) => toObservedWalletPosition(row.payload))),
        ...graph,
      };
      return freeze(holders);
    } catch (error) {
      throw projectionError(error);
    }
  }

  private async loadWalletGraph(
    mint: string,
  ): Promise<ApiWalletGraphUnavailable | ApiWalletGraphAvailable> {
    const unavailable: ApiWalletGraphUnavailable = freeze({
      clusters: freeze([] as []),
      clusterAnalysisStatus: 'NOT_AVAILABLE',
    });
    const profileResult = await this.database.query(
      `SELECT input_fingerprint, methodology
       FROM wallet_graph_profiles
       WHERE mint = $1`,
      [mint],
    );
    const profile = profileResult.rows[0];
    if (profile === undefined) return unavailable;
    const inputFingerprint = text(profile.input_fingerprint);
    if (text(profile.methodology) !== 'OBSERVED_PUMPFUN_TRANSACTIONS') {
      throw invalid();
    }
    const snapshotResult = await this.database.query(
      `SELECT input_fingerprint, methodology, coverage, cluster_count
       FROM wallet_graph_snapshots
       WHERE mint = $1 AND input_fingerprint = $2
       LIMIT 1`,
      [mint, inputFingerprint],
    );
    const snapshot = snapshotResult.rows[0];
    if (
      snapshot === undefined
      || text(snapshot.input_fingerprint) !== inputFingerprint
      || text(snapshot.methodology) !== 'OBSERVED_PUMPFUN_TRANSACTIONS'
    ) throw invalid();
    const clusterCount = nonNegativeSafeNumber(snapshot.cluster_count);
    const clusterResult = await this.database.query(
      `SELECT cluster.cluster_id, cluster.participant_wallet_count,
          cluster.auxiliary_wallet_count, cluster.positive_holder_count,
          cluster.observed_positive_base_raw, cluster.concentration_bps,
          cluster.contains_creator, cluster.shared_funder_count,
          cluster.strong_relationship_count, cluster.strong_evidence_count,
          cluster.quote_assets,
          (
            SELECT COUNT(*)
            FROM wallet_cluster_members AS member
            WHERE member.mint = cluster.mint
              AND member.cluster_id = cluster.cluster_id
              AND member.input_fingerprint = cluster.input_fingerprint
          ) AS member_count
       FROM wallet_clusters AS cluster
       WHERE cluster.mint = $1
         AND cluster.input_fingerprint = $2
       ORDER BY cluster.concentration_bps DESC, cluster.cluster_id ASC
       LIMIT $3`,
      [mint, inputFingerprint, this.holderLimits.clusters + 1],
    );
    const expectedClusterRowCount = clusterCount > this.holderLimits.clusters
      ? this.holderLimits.clusters + 1
      : clusterCount;
    if (clusterResult.rows.length !== expectedClusterRowCount) throw invalid();
    const emittedRows = clusterResult.rows.slice(0, this.holderLimits.clusters);
    const clusterIds = emittedRows.map((row) => text(row.cluster_id));
    const memberResult = clusterIds.length === 0
      ? { rows: [] as readonly Record<string, unknown>[] }
      : await this.database.query(
        `WITH ranked_members AS (
          SELECT member.cluster_id, member.wallet, member.member_role,
            member.is_creator, member.observed_net_base_raw,
            ROW_NUMBER() OVER (
              PARTITION BY member.cluster_id
              ORDER BY GREATEST(member.observed_net_base_raw, 0) DESC,
                member.wallet ASC
            ) AS member_rank
          FROM wallet_cluster_members AS member
          WHERE member.mint = $1
            AND member.input_fingerprint = $2
            AND member.cluster_id = ANY($3::text[])
        )
        SELECT cluster_id, wallet, member_role, is_creator,
          observed_net_base_raw, member_rank
        FROM ranked_members
        WHERE member_rank <= $4
        ORDER BY array_position($3::text[], cluster_id), member_rank
        LIMIT $5`,
        [
          mint,
          inputFingerprint,
          clusterIds,
          this.holderLimits.clusterMembers,
          this.holderLimits.totalClusterMembers,
        ],
      );
    const membersByCluster = new Map<string, ApiWalletClusterMember[]>();
    for (const row of memberResult.rows) {
      const clusterId = text(row.cluster_id);
      if (!clusterIds.includes(clusterId)) throw invalid();
      const members = membersByCluster.get(clusterId) ?? [];
      members.push(toWalletClusterMember(row));
      membersByCluster.set(clusterId, members);
    }
    let remainingQuoteAssetBudget = MAX_API_TOTAL_CLUSTER_QUOTE_ASSETS;
    const clusters = freeze(emittedRows.map((row): ApiWalletCluster => {
      const clusterId = text(row.cluster_id);
      const members = freeze(membersByCluster.get(clusterId) ?? []);
      const memberCount = countDecimal(row.member_count);
      if (memberCount < members.length) throw invalid();
      const storedQuoteAssets = array(json(row.quote_assets));
      const quoteAssets = freeze(storedQuoteAssets
        .slice(0, Math.min(
          MAX_API_CLUSTER_QUOTE_ASSETS,
          remainingQuoteAssetBudget,
        ))
        .map(toQuoteAsset));
      remainingQuoteAssetBudget -= quoteAssets.length;
      return freeze({
        id: clusterId,
        quoteAssetCount: storedQuoteAssets.length,
        quoteAssetsTruncated: storedQuoteAssets.length > quoteAssets.length,
        quoteAssets,
        participantWalletCount: nonNegativeSafeNumber(row.participant_wallet_count),
        auxiliaryWalletCount: nonNegativeSafeNumber(row.auxiliary_wallet_count),
        positiveHolderCount: nonNegativeSafeNumber(row.positive_holder_count),
        observedPositiveBaseRaw: decimal(row.observed_positive_base_raw),
        concentrationBps: boundedBps(row.concentration_bps),
        containsCreator: boolean(row.contains_creator),
        sharedFunderCount: nonNegativeSafeNumber(row.shared_funder_count),
        strongRelationshipCount: nonNegativeSafeNumber(row.strong_relationship_count),
        strongEvidenceCount: nonNegativeSafeNumber(row.strong_evidence_count),
        memberCount,
        membersTruncated: memberCount > members.length,
        members,
      });
    }));
    const available: ApiWalletGraphAvailable = {
      clusterAnalysisStatus: 'AVAILABLE',
      clusterMethodology: 'OBSERVED_PUMPFUN_TRANSACTIONS',
      clusterCoverage: toWalletGraphCoverage(snapshot.coverage),
      clusterCount,
      clustersTruncated: clusterCount > clusters.length,
      clusters,
    };
    return freeze(available);
  }
}

const launchSelect = `SELECT launch.mint, launch.detected_at, launch.created_slot, launch.current_state,
  launch.creator, launch.token_program, launch.launchpad, launch.quote_assets,
  NULL::text AS initial_token_amount, NULL::text AS initial_quote_amount
  FROM token_launches AS launch`;

function assembleLaunchSummary(row: LaunchRow, projections: LaunchProjections): ApiLaunchSummary {
  const mint = text(row.mint);
  const curve = projections.curves.get(mint);
  const market = projections.markets.get(mint);
  const metadata = projections.metadata.get(mint);
  const quote = quoteAsset(row.quote_assets);
  const quoteMint = nullableText(curve?.quote_mint) ?? nullableText(market?.quote_mint) ?? quote.mint;
  const quoteDecimals = nullableSafeNumber(curve?.quote_decimals)
    ?? nullableSafeNumber(market?.quote_decimals) ?? quote.decimals;
  return freeze({
    mint, detectedAt: timestamp(row.detected_at).toISOString(), detectedSlot: decimal(row.created_slot),
    status: launchStatus(row.current_state), name: metadataText(metadata, 'name'), symbol: metadataText(metadata, 'symbol'),
    quoteMint, quoteDecimals,
    marketCapQuote: null,
    liquidityQuote: nullableDecimal(market?.quote_vault_amount_raw)
      ?? nullableDecimal(curve?.real_quote_reserves_raw),
  });
}

function assembleLaunchDetail(
  row: LaunchRow,
  projections: LaunchProjections,
  holders: ApiHolders = NOT_AVAILABLE_HOLDERS,
): ApiLaunchDetail {
  const summary = assembleLaunchSummary(row, projections);
  const curve = projections.curves.get(summary.mint);
  const market = projections.markets.get(summary.mint);
  return freeze({
    ...summary, creator: text(row.creator), tokenProgram: text(row.token_program), launchpad: text(row.launchpad),
    initialTokenAmount: nullableDecimal(row.initial_token_amount), initialQuoteAmount: nullableDecimal(row.initial_quote_amount),
    reserveBase: nullableDecimal(market?.base_reserves_raw) ?? nullableDecimal(curve?.real_base_reserves_raw),
    reserveQuote: nullableDecimal(market?.quote_vault_amount_raw) ?? nullableDecimal(curve?.real_quote_reserves_raw),
    feeBps: null, social: NOT_AVAILABLE_SOCIAL, holders,
  });
}

function toCreatorProfileRecord(profile: Record<string, unknown>): ApiCreatorProfile {
  if (safeNumber(profile.payloadVersion) !== 1) throw invalid();
  text(profile.inputFingerprint);
  return freeze({
    mint: text(profile.mint),
    creator: text(profile.creator),
    buyCount: nonNegativeSafeNumber(profile.buyCount),
    sellCount: nonNegativeSafeNumber(profile.sellCount),
    totalBoughtBaseRaw: rawBigInt(profile.totalBoughtBaseRaw, false),
    totalSoldBaseRaw: rawBigInt(profile.totalSoldBaseRaw, false),
    observedNetBaseRaw: rawBigInt(profile.observedNetBaseRaw, true),
    hasSold: boolean(profile.hasSold),
    firstSell: profile.firstSell === null ? null : toCreatorTradeEvidence(profile.firstSell),
    initialBuys: freeze(array(profile.initialBuys).map(toCreatorTradeEvidence)),
    quoteFlows: freeze(array(profile.quoteFlows).map(toParticipantQuoteFlow)),
    uniqueExternalBuyers: nonNegativeSafeNumber(profile.uniqueExternalBuyers),
    unknownTraderTradeCount: nonNegativeSafeNumber(profile.unknownTraderTradeCount),
  });
}

function toCreatorTradeEvidence(value: unknown): ApiCreatorTradeEvidence {
  const evidence = record(value);
  return freeze({
    eventId: text(evidence.eventId),
    tradeId: text(evidence.tradeId),
    signature: text(evidence.signature),
    cursor: toAnalyticsCursor(evidence.cursor),
    baseAmountRaw: rawBigInt(evidence.baseAmountRaw, false),
    quoteAmountRaw: rawBigInt(evidence.quoteAmountRaw, false),
    quoteAsset: toQuoteAsset(evidence.quoteAsset),
  });
}

function toParticipantQuoteFlow(value: unknown): ApiParticipantQuoteFlow {
  const flow = record(value);
  return freeze({
    quoteAsset: toQuoteAsset(flow.quoteAsset),
    boughtQuoteRaw: rawBigInt(flow.boughtQuoteRaw, false),
    soldQuoteRaw: rawBigInt(flow.soldQuoteRaw, false),
  });
}

function toQuoteAsset(value: unknown): ApiParticipantQuoteFlow['quoteAsset'] {
  const asset = record(value);
  const tokenProgram = text(asset.tokenProgram);
  if (tokenProgram !== 'SPL_TOKEN' && tokenProgram !== 'TOKEN_2022') throw invalid();
  const decimalsValue = nonNegativeSafeNumber(asset.decimals);
  if (decimalsValue > 255) throw invalid();
  return freeze({
    mint: text(asset.mint),
    decimals: decimalsValue,
    tokenProgram,
  });
}

function toAnalyticsCursor(value: unknown): ApiAnalyticsCursor {
  const cursor = record(value);
  return freeze({
    slot: rawBigInt(cursor.slot, false),
    transactionIndex: BigInt(nonNegativeSafeNumber(cursor.transactionIndex)).toString(),
    instructionIndex: BigInt(nonNegativeSafeNumber(cursor.instructionIndex)).toString(),
    innerInstructionIndex: cursor.innerInstructionIndex === null
      ? null
      : BigInt(nonNegativeSafeNumber(cursor.innerInstructionIndex)).toString(),
  });
}

function toHolderSnapshot(row: Record<string, unknown>): ApiHolderSnapshot {
  const top1Bps = boundedBps(row.top1_bps);
  const top5Bps = boundedBps(row.top5_bps);
  const top10Bps = boundedBps(row.top10_bps);
  const creatorBps = boundedBps(row.creator_bps);
  return freeze({
    id: text(row.snapshot_id),
    inputFingerprint: text(row.input_fingerprint),
    observedAt: timestamp(row.observed_at).toISOString(),
    confirmationStatus: activeConfirmation(row.confirmation_status),
    cursor: freeze({
      slot: decimal(row.as_of_slot),
      transactionIndex: BigInt(timelineIndex(row.as_of_transaction_index)).toString(),
      instructionIndex: BigInt(timelineIndex(row.as_of_instruction_index)).toString(),
      innerInstructionIndex: row.as_of_inner_instruction_index === null
        ? null
        : BigInt(timelineIndex(row.as_of_inner_instruction_index)).toString(),
    }),
    totalPositiveNetBaseRaw: decimal(row.total_positive_net_base_raw),
    top1Bps,
    top5Bps,
    top10Bps,
    creatorBps,
    uniqueKnownBuyers: nonNegativeSafeNumber(row.unique_known_buyers),
    uniqueExternalBuyers: nonNegativeSafeNumber(row.unique_external_buyers),
    positivePositionCount: nonNegativeSafeNumber(row.positive_position_count),
    unknownTraderTradeCount: nonNegativeSafeNumber(row.unknown_trader_trade_count),
  });
}

function toObservedWalletPosition(value: unknown): ApiObservedWalletPosition {
  const position = restoredRecord(value);
  return freeze({
    wallet: text(position.wallet),
    isCreator: boolean(position.isCreator),
    buyCount: nonNegativeSafeNumber(position.buyCount),
    sellCount: nonNegativeSafeNumber(position.sellCount),
    boughtBaseRaw: rawBigInt(position.boughtBaseRaw, false),
    soldBaseRaw: rawBigInt(position.soldBaseRaw, false),
    observedNetBaseRaw: rawBigInt(position.observedNetBaseRaw, true),
    quoteFlows: freeze(array(position.quoteFlows).map(toParticipantQuoteFlow)),
    firstObservedCursor: toAnalyticsCursor(position.firstObservedCursor),
    lastObservedCursor: toAnalyticsCursor(position.lastObservedCursor),
  });
}

function toWalletClusterMember(
  row: Record<string, unknown>,
): ApiWalletClusterMember {
  const role = text(row.member_role);
  if (role !== 'PARTICIPANT' && role !== 'AUXILIARY_FUNDER') throw invalid();
  return freeze({
    wallet: text(row.wallet),
    role,
    isCreator: boolean(row.is_creator),
    observedNetBaseRaw: signedDecimal(row.observed_net_base_raw),
  });
}

function toWalletGraphCoverage(value: unknown): ApiWalletGraphCoverage {
  const coverage = record(json(value));
  return freeze({
    knownBuyCount: nonNegativeSafeNumber(coverage.knownBuyCount),
    knownBuyerCount: nonNegativeSafeNumber(coverage.knownBuyerCount),
    strongEvidenceBuyCount: nonNegativeSafeNumber(coverage.strongEvidenceBuyCount),
    strongEvidenceBuyerCount: nonNegativeSafeNumber(
      coverage.strongEvidenceBuyerCount,
    ),
    mediumOnlyBuyCount: nonNegativeSafeNumber(coverage.mediumOnlyBuyCount),
    mediumOnlyBuyerCount: nonNegativeSafeNumber(coverage.mediumOnlyBuyerCount),
    noEvidenceBuyCount: nonNegativeSafeNumber(coverage.noEvidenceBuyCount),
    noEvidenceBuyerCount: nonNegativeSafeNumber(coverage.noEvidenceBuyerCount),
    unavailableBuyCount: nonNegativeSafeNumber(coverage.unavailableBuyCount),
    unavailableBuyerCount: nonNegativeSafeNumber(coverage.unavailableBuyerCount),
    notProcessedBuyCount: nonNegativeSafeNumber(coverage.notProcessedBuyCount),
    notProcessedBuyerCount: nonNegativeSafeNumber(
      coverage.notProcessedBuyerCount,
    ),
    analyzedTransactionCount: nonNegativeSafeNumber(
      coverage.analyzedTransactionCount,
    ),
    evidenceCount: nonNegativeSafeNumber(coverage.evidenceCount),
  });
}

function toTimelineEntry(row: Record<string, unknown>): ApiTimelineEntry {
  try {
    return freeze({
      id: text(row.id), type: validated(row.type, DOMAIN_EVENT_TYPES) as ApiTimelineEntry['type'], occurredAt: timestamp(row.occurred_at).toISOString(),
      slot: nullableDecimal(row.slot), confirmationStatus: validated(row.confirmation_status, CONFIRMATION_STATUSES) as ApiTimelineEntry['confirmationStatus'],
      payloadVersion: positiveSafeNumber(row.payload_version), payload: toApiDomainPayload(fromJsonValue(json(row.payload))),
    });
  } catch (error) {
    throw projectionError(error);
  }
}

function qualification(value: unknown): ApiQualification {
  try {
    const payload = qualificationRecord(json(value));
    const hasConditions = Object.hasOwn(payload, 'conditions');
    const payloadFields = exactDataRecord(payload, hasConditions
      ? QUALIFICATION_PAYLOAD_FIELDS_WITH_CALIBRATION
      : QUALIFICATION_PAYLOAD_FIELDS_LEGACY, 'Qualification payload');
    const ruleSet = exactDataRecord(payloadFields.ruleSet, hasConditions
      ? QUALIFICATION_RULE_SET_FIELDS_WITH_FINGERPRINT
      : QUALIFICATION_RULE_SET_FIELDS_LEGACY, 'Qualification rule set');
    const scores = exactDataRecord(payloadFields.scores, QUALIFICATION_SCORE_FIELDS, 'Qualification scores');
    return freeze({
      ruleSet: freeze({ id: text(ruleSet.id), version: positiveSafeNumber(ruleSet.version),
        status: qualificationRuleSetStatus(ruleSet.status), minimumTotalScore: safeNumber(ruleSet.minimumTotalScore),
        fingerprint: hasConditions ? qualificationFingerprint(ruleSet.fingerprint) : null }),
      scores: freeze({ preparation: score(scores.preparation), socialAuthenticity: score(scores.socialAuthenticity),
        onchainHealth: score(scores.onchainHealth), total: score(scores.total) }),
      evidence: qualificationEvidence(payloadFields.evidence),
      conditions: hasConditions ? qualificationConditions(payloadFields.conditions) : freeze([]),
      blockers: qualificationBlockers(payloadFields.blockers),
      verdict: validated(payloadFields.verdict, QUALIFICATION_VERDICTS) as ApiQualification['verdict'],
      evaluatedAt: dateFromMs(safeNumber(payloadFields.evaluatedAtMs)).toISOString(),
    });
  } catch (error) {
    throw projectionError(error);
  }
}

const MAX_QUALIFICATION_CONDITIONS = QUALIFICATION_REASON_CODES.length;
const MAX_QUALIFICATION_CONDITION_MESSAGE_LENGTH = 4_096;
const MAX_QUALIFICATION_CONDITION_MAP_KEYS = 3;
const QUALIFICATION_PAYLOAD_FIELDS_LEGACY = ['ruleSet', 'scores', 'evidence', 'blockers', 'verdict', 'evaluatedAtMs'] as const;
const QUALIFICATION_PAYLOAD_FIELDS_WITH_CALIBRATION = [...QUALIFICATION_PAYLOAD_FIELDS_LEGACY, 'conditions'] as const;
const QUALIFICATION_RULE_SET_FIELDS_LEGACY = ['id', 'version', 'status', 'minimumTotalScore'] as const;
const QUALIFICATION_RULE_SET_FIELDS_WITH_FINGERPRINT = [...QUALIFICATION_RULE_SET_FIELDS_LEGACY, 'fingerprint'] as const;
const QUALIFICATION_SCORE_FIELDS = ['preparation', 'socialAuthenticity', 'onchainHealth', 'total'] as const;
const QUALIFICATION_EVIDENCE_FIELDS = ['signal', 'status', 'message'] as const;
const QUALIFICATION_BLOCKER_FIELDS = ['code', 'message'] as const;
const QUALIFICATION_CONDITION_FIELDS = [
  'code', 'mode', 'status', 'observed', 'thresholds', 'message',
] as const;

function qualificationFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw invalid();
  return value;
}

function qualificationConditions(value: unknown): readonly ApiQualificationCondition[] {
  const source = exactDenseArray(value, MAX_QUALIFICATION_CONDITIONS, 'Qualification conditions');
  if (source.length !== QUALIFICATION_REASON_CODES.length) throw invalid();
  return freeze(source.map((item, index) => {
    const fields = exactDataRecord(item, QUALIFICATION_CONDITION_FIELDS, 'Qualification condition');
    const code = validated(fields.code, QUALIFICATION_REASON_CODES) as ApiQualificationCondition['code'];
    if (code !== QUALIFICATION_REASON_CODES[index]) throw invalid();
    const mode = validated(fields.mode, QUALIFICATION_CONDITION_MODES) as ApiQualificationCondition['mode'];
    const status = validated(fields.status, QUALIFICATION_CONDITION_STATUSES) as ApiQualificationCondition['status'];
    if ((mode === 'DISABLED') !== (status === 'DISABLED')) throw invalid();
    const observed = qualificationObserved(code, mode, fields.observed);
    const thresholds = qualificationThresholds(code, mode, fields.thresholds);
    const message = qualificationMessage(fields.message);
    return freeze({ code, mode, status, observed, thresholds, message });
  }));
}

function qualificationObserved(
  code: ApiQualificationCondition['code'],
  mode: ApiQualificationCondition['mode'],
  value: unknown,
): ApiQualificationCondition['observed'] {
  if (mode === 'DISABLED') return qualificationMap(value, [], []);
  switch (code) {
    case 'HOLDER_CONCENTRATION_EXCEEDED':
      return qualificationMap(value, ['top1HolderBps', 'top5HoldersBps', 'top10HoldersBps'], ['decimal', 'decimal', 'decimal']);
    case 'RELATED_WALLET_CLUSTER_EXCEEDED':
      return qualificationMap(value, ['maximumRelatedClusterBps'], ['decimal']);
    case 'SHARED_FUNDER_CLUSTER':
      return qualificationMap(value, ['maximumSharedFunderCount'], ['observedCount']);
    case 'BUY_SIMULATION_FAILED':
      return qualificationMap(value, ['buySimulationSucceeded'], ['boolean']);
    case 'SELL_QUOTE_UNAVAILABLE':
      return qualificationMap(value, ['sellQuoteAvailable'], ['boolean']);
    case 'ROUND_TRIP_LOSS_EXCEEDED':
      return qualificationMap(value, ['roundTripLossBps'], ['decimal']);
    default:
      return qualificationMap(value, [], []);
  }
}

function qualificationThresholds(
  code: ApiQualificationCondition['code'],
  mode: ApiQualificationCondition['mode'],
  value: unknown,
): ApiQualificationCondition['thresholds'] {
  if (mode === 'DISABLED') return qualificationMap(value, [], []) as ApiQualificationCondition['thresholds'];
  switch (code) {
    case 'HOLDER_CONCENTRATION_EXCEEDED':
      return qualificationMap(value, ['maximumTop1Bps', 'maximumTop5Bps', 'maximumTop10Bps'], ['decimal', 'decimal', 'decimal']) as ApiQualificationCondition['thresholds'];
    case 'RELATED_WALLET_CLUSTER_EXCEEDED':
      return qualificationMap(value, ['maximumClusterBps'], ['decimal']) as ApiQualificationCondition['thresholds'];
    case 'SHARED_FUNDER_CLUSTER':
      return qualificationMap(value, ['minimumSharedFunders'], ['thresholdCount']) as ApiQualificationCondition['thresholds'];
    case 'ROUND_TRIP_LOSS_EXCEEDED':
      return qualificationMap(value, ['maximumRoundTripLossBps'], ['decimal']) as ApiQualificationCondition['thresholds'];
    default:
      return qualificationMap(value, [], []) as ApiQualificationCondition['thresholds'];
  }
}

type QualificationMapValue = 'decimal' | 'observedCount' | 'thresholdCount' | 'boolean';

function qualificationMap(
  value: unknown,
  keys: readonly string[],
  valueTypes: readonly QualificationMapValue[],
): Readonly<Record<string, string | number | boolean | null>> {
  if (keys.length > MAX_QUALIFICATION_CONDITION_MAP_KEYS || keys.length !== valueTypes.length) throw invalid();
  const fields = exactDataRecord(value, keys, 'Qualification condition map');
  const result: Record<string, string | number | boolean | null> = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const valueType = valueTypes[index];
    if (key === undefined || valueType === undefined) throw invalid();
    result[key] = qualificationMapValue(fields[key], valueType);
  }
  return freeze(result);
}

function qualificationMapValue(value: unknown, type: QualificationMapValue): string | number | boolean | null {
  if (value === null) return null;
  if (type === 'decimal') return qualificationDecimal(value);
  if (type === 'observedCount') return nonNegativeSafeNumber(value);
  if (type === 'thresholdCount') {
    const count = positiveSafeNumber(value);
    if (count > 10_000) throw invalid();
    return count;
  }
  if (typeof value !== 'boolean') throw invalid();
  return value;
}

function qualificationDecimal(value: unknown): string {
  if (typeof value === 'bigint') return boundedBps(value.toString());
  if (typeof value === 'string') return boundedBps(value);
  return boundedBps(canonicalBigIntMarker(value));
}

function canonicalBigIntMarker(value: unknown): string {
  if (!isBigIntMarkerShape(value)) throw invalid();
  const encoded = ownDataProperty(value, BIGINT_JSON_MARKER);
  if (
    typeof encoded !== 'string'
    || !/^(?:0|-?[1-9]\d*)$/u.test(encoded)
    || encoded.replace(/^-/, '').length > MAX_SERIALIZED_BIGINT_DIGITS
  ) throw invalid();
  return encoded;
}

function isBigIntMarkerShape(value: unknown): value is Record<typeof BIGINT_JSON_MARKER, unknown> {
  if (typeof value !== 'object' || value === null || isProxy(value) || !isRecord(value)
    || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Object.getOwnPropertyNames(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, BIGINT_JSON_MARKER);
  return keys.length === 1 && keys[0] === BIGINT_JSON_MARKER && descriptor?.enumerable === true
    && 'value' in descriptor;
}

function qualificationMessage(value: unknown): string {
  const result = text(value);
  if (result.length > MAX_QUALIFICATION_CONDITION_MESSAGE_LENGTH) throw invalid();
  return result;
}

function qualificationEvidence(value: unknown): readonly ApiQualification['evidence'][number][] {
  return freeze(exactDenseArray(value, QUALIFICATION_SIGNAL_KEYS.length, 'Qualification evidence').map((item) => {
    const fields = exactDataRecord(item, QUALIFICATION_EVIDENCE_FIELDS, 'Qualification evidence item');
    return freeze({
      signal: validated(fields.signal, QUALIFICATION_SIGNAL_KEYS) as ApiQualification['evidence'][number]['signal'],
      status: validated(fields.status, QUALIFICATION_EVIDENCE_STATUSES) as ApiQualification['evidence'][number]['status'],
      message: text(fields.message),
    });
  }));
}

function qualificationBlockers(value: unknown): readonly ApiQualification['blockers'][number][] {
  return freeze(exactDenseArray(value, QUALIFICATION_REASON_CODES.length, 'Qualification blockers').map((item) => {
    const fields = exactDataRecord(item, QUALIFICATION_BLOCKER_FIELDS, 'Qualification blocker');
    return freeze({
      code: validated(fields.code, QUALIFICATION_REASON_CODES) as ApiQualification['blockers'][number]['code'],
      message: text(fields.message),
    });
  }));
}

function qualificationRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || isProxy(value) || !isRecord(value)) throw invalid();
  return value;
}

function exactDenseArray(value: unknown, maximum: number, name: string): readonly unknown[] {
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0 || value.length > maximum) throw invalid();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || !Object.hasOwn(value, 'length')) throw invalid();
  const entries: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
    entries.push(descriptor.value);
  }
  void name;
  return entries;
}

function exactDataRecord(value: unknown, expected: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || isProxy(value) || !isRecord(value)
    || Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) throw invalid();
  const result: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
    result[key] = descriptor.value;
  }
  void name;
  return result;
}

function ownDataProperty(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
  return descriptor.value;
}

function score(value: unknown): ApiQualification['scores']['total'] {
  const item = exactDataRecord(value, ['score', 'maximum'], 'Qualification score');
  return freeze({ score: safeNumber(item.score), maximum: safeNumber(item.maximum) });
}

function toPaperPosition(row: Record<string, unknown>): ApiPaperPosition {
  const status = validated(row.status, PAPER_POSITION_STATUSES) as ApiPaperPosition['status'];
  const exitTradeId = nullableText(row.exit_trade_id);
  const exitFees = nullableDecimal(row.exit_fees_raw);
  if (
    (status === 'PAPER_HOLDING' && (exitTradeId !== null || exitFees !== null))
    || (status === 'PAPER_CLOSED' && (exitTradeId === null || exitFees === null))
    || (status === 'PAPER_RETRACTED' && ((exitTradeId === null) !== (exitFees === null)))
  ) throw invalid();
  return freeze({
    id: text(row.position_id), mint: text(row.mint), status,
    openedAt: timestamp(row.opened_at).toISOString(), closedAt: nullableTimestamp(row.closed_at), quoteMint: text(row.quote_mint),
    quantity: decimal(row.remaining_base_raw), entryQuoteAmount: decimal(row.quote_cost_raw),
    exitQuoteAmount: nullableDecimal(row.quote_proceeds_raw), realizedPnlQuote: nullableSignedDecimal(row.net_pnl_quote_raw),
    estimatedFeesQuote: (BigInt(decimal(row.entry_fees_raw))
      + BigInt(exitFees ?? '0')).toString(),
  });
}

function rowsByMint(rows: readonly Record<string, unknown>[]): ReadonlyMap<string, Record<string, unknown>> {
  return new Map(rows.map((row) => [text(row.mint), row]));
}

function quoteAsset(value: unknown): { readonly mint: string | null; readonly decimals: number | null } {
  const assets = array(json(value));
  const first = assets[0];
  if (first === undefined) return { mint: null, decimals: null };
  const asset = record(first);
  return { mint: nullableText(asset.mint), decimals: nullableSafeNumber(asset.decimals) };
}

function metadataText(metadata: Record<string, unknown> | undefined, key: string): string | null {
  if (metadata?.metadata === null || metadata?.metadata === undefined) return null;
  const value = record(json(metadata.metadata))[key];
  return nullableText(value);
}

function launchStatus(value: unknown): ApiLaunchSummary['status'] {
  return validated(value, LAUNCH_STATUSES) as ApiLaunchSummary['status'];
}

const CONFIRMATION_STATUSES = ['processed', 'confirmed', 'finalized', 'orphaned'] as const;
const PAPER_POSITION_STATUSES = ['PAPER_HOLDING', 'PAPER_CLOSED', 'PAPER_RETRACTED'] as const;
const QUALIFICATION_EVIDENCE_STATUSES = ['SATISFIED', 'NOT_SATISFIED', 'UNKNOWN'] as const;
const QUALIFICATION_VERDICTS = ['QUALIFIED', 'WATCHLISTED', 'REJECTED'] as const;

function qualificationRuleSetStatus(value: unknown): 'UNVALIDATED_RULE_SET' {
  if (text(value) !== 'UNVALIDATED_RULE_SET') throw invalid();
  return 'UNVALIDATED_RULE_SET';
}

function validated(value: unknown, values: readonly string[]): string {
  const candidate = text(value);
  if (!values.includes(candidate)) throw invalid();
  return candidate;
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw invalid(); }
}

function timestamp(value: unknown): Date {
  if (value instanceof Date) return validDate(value);
  if (typeof value !== 'string') throw invalid();
  const parsed = validDate(new Date(value));
  if (parsed.toISOString() !== value) throw invalid();
  return parsed;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : timestamp(value).toISOString();
}

function validDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw invalid();
  return value;
}

function dateFromMs(value: number): Date {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw invalid();
  return validDate(new Date(value));
}

function validatedTimestampMs(value: number): number {
  dateFromMs(value);
  return value;
}

function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) throw invalid();
  return value;
}

function nullableDecimal(value: unknown): string | null {
  return value === null || value === undefined ? null : decimal(value);
}

function nullableSignedDecimal(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^(?:0|-?[1-9]\d*)$/u.test(value)) throw invalid();
  return value;
}

function signedDecimal(value: unknown): string {
  const result = nullableSignedDecimal(value);
  if (result === null) throw invalid();
  return result;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function safeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalid();
  return value;
}

function nonNegativeSafeNumber(value: unknown): number {
  const result = safeNumber(value);
  if (result < 0 || Object.is(result, -0)) throw invalid();
  return result;
}

function holderLimit(value: number): number {
  return boundedLimit(value, 500);
}

function boundedLimit(value: number, maximum: number): number {
  const result = positiveSafeNumber(value);
  if (result > maximum) throw invalid();
  return result;
}

function countDecimal(value: unknown): number {
  const result = BigInt(decimal(value));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
  return Number(result);
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}

function rawBigInt(value: unknown, signed: boolean): string {
  if (typeof value !== 'bigint' || (!signed && value < 0n)) throw invalid();
  return value.toString();
}

function restoredRecord(value: unknown): Record<string, unknown> {
  return record(fromJsonValue(json(value)));
}

function boundedBps(value: unknown): string {
  const result = decimal(value);
  if (BigInt(result) > 10_000n) throw invalid();
  return result;
}

function activeConfirmation(value: unknown): ApiHolderSnapshot['confirmationStatus'] {
  if (value !== 'processed' && value !== 'confirmed' && value !== 'finalized') throw invalid();
  return value;
}

function nullableSafeNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : safeNumber(value);
}

function positiveSafeNumber(value: unknown): number {
  const result = safeNumber(value);
  if (result <= 0) throw invalid();
  return result;
}

function timelineIndex(value: unknown): number {
  const result = safeNumber(value);
  if (result < 0 || result > MAX_TIMELINE_INDEX || Object.is(result, -0)) throw invalid();
  return result;
}

function timelineSlot(value: unknown): string {
  const result = decimal(value);
  if (result.length > MAX_TIMELINE_SLOT.length) throw invalid();
  return result;
}

function pageLimit(value: number): number {
  const limit = positiveSafeNumber(value);
  if (limit > MAX_API_PAGE_LIMIT) throw invalid();
  return limit;
}

export const HEARTBEAT_STALE_AFTER_MS = 30_000;
const DEGRADED_PIPELINE_STATE: ApiProjectionPipelineState = Object.freeze({
  httpAvailable: false,
  pumpfun: 'DEGRADED',
  pumpswap: 'DEGRADED',
});

function emptyHeartbeat(): ApiHealth['heartbeat'] {
  return freeze({ runtimeState: null, subscriberState: null, scannerState: null,
    workerState: null, reconcilerState: null, backlogCount: null, leasedCount: null,
    exhaustedCount: null,
    startedAt: null, updatedAt: null, lastHttpSlot: null, lastWebsocketSlot: null,
    lastFinalizedSlot: null, lastSignature: null, pendingTransactions: null, activeSessions: null });
}

function heartbeatFromRow(row: Record<string, unknown>): ApiHealth['heartbeat'] {
  const runtimeState = listenerRuntimeState(row.runtime_state);
  const subscriberState = listenerRuntimeState(row.subscriber_state);
  const scannerState = listenerRuntimeState(row.scanner_state);
  const workerState = listenerRuntimeState(row.worker_state);
  const reconcilerState = listenerRuntimeState(row.reconciler_state);
  const backlogCount = nonNegativeSafeNumber(row.pending_transactions);
  const leasedCount = nonNegativeSafeNumber(row.leased_transactions);
  const exhaustedCount = nonNegativeSafeNumber(row.exhausted_transactions);
  if (leasedCount > backlogCount) throw invalid();
  const startedAt = nullableTimestamp(row.started_at);
  const updatedAt = timestamp(row.updated_at).toISOString();
  if (startedAt !== null && Date.parse(startedAt) > Date.parse(updatedAt)) throw invalid();
  return freeze({
    runtimeState, subscriberState, scannerState, workerState, reconcilerState,
    backlogCount, leasedCount, exhaustedCount, startedAt, updatedAt,
    lastHttpSlot: nullableDecimal(row.last_http_slot),
    lastWebsocketSlot: nullableDecimal(row.last_websocket_slot), lastFinalizedSlot: nullableDecimal(row.last_finalized_slot),
    lastSignature: nullableText(row.last_signature), pendingTransactions: backlogCount,
    activeSessions: nullableSafeNumber(row.active_sessions),
  });
}

function listenerRuntimeState(value: unknown): ListenerRuntimeState {
  if (!LISTENER_RUNTIME_STATES.includes(value as ListenerRuntimeState)) throw invalid();
  return value as ListenerRuntimeState;
}

function pipelineState(provider: ApiProjectionPipelineStateProvider): ApiProjectionPipelineState {
  const value: unknown = provider();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3
    || !keys.includes('httpAvailable')
    || !keys.includes('pumpfun')
    || !keys.includes('pumpswap')) throw invalid();
  const httpAvailable = pipelineValue(value, 'httpAvailable');
  const pumpfun = pipelineValue(value, 'pumpfun');
  const pumpswap = pipelineValue(value, 'pumpswap');
  if (typeof httpAvailable !== 'boolean'
    || !isPipelineRuntimeState(pumpfun)
    || !isPipelineRuntimeState(pumpswap)) throw invalid();
  return freeze({ httpAvailable, pumpfun, pumpswap });
}

function pipelineValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor?.enumerable !== true) throw invalid();
  if (!('value' in descriptor)) throw invalid();
  return descriptor.value;
}

function isPipelineRuntimeState(
  value: unknown,
): value is ApiProjectionPipelineState['pumpfun'] {
  return value === 'IDLE'
    || value === 'RUNNING'
    || value === 'DEGRADED'
    || value === 'STOPPED';
}

function healthResult(
  observedAt: Date, databaseAvailable: boolean, degraded: boolean,
  checkpoints: ReadonlyMap<string, string>, heartbeat: ApiHealth['heartbeat'], lagSlots: string | null,
  pipeline: ApiProjectionPipelineState,
): ApiHealth {
  return freeze({ status: degraded ? 'DEGRADED' : 'OK', observedAt: observedAt.toISOString(),
    postgresql: freeze({ status: databaseAvailable ? 'AVAILABLE' : 'UNAVAILABLE' }),
    http: freeze({ status: pipeline.httpAvailable ? 'AVAILABLE' : 'UNAVAILABLE' }),
    pipeline: freeze({ pumpfun: pipeline.pumpfun, pumpswap: pipeline.pumpswap }),
    checkpoints: freeze({ launchpad: checkpoints.get('launchpad') ?? null, market: checkpoints.get('market') ?? null }),
    heartbeat, lagSlots });
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalid();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw invalid();
  return value;
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function invalid(): ApiProjectionDataError {
  return new ApiProjectionDataError();
}

function projectionError(error: unknown): ApiProjectionDataError {
  if (error instanceof ApiProjectionDataError) return error;
  const wrapped = new ApiProjectionDataError();
  Object.defineProperty(wrapped, 'cause', { value: error, enumerable: false });
  return wrapped;
}
