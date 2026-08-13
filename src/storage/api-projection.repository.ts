import {
  MAX_API_CLUSTER_QUOTE_ASSETS,
  MAX_API_SOCIAL_EVIDENCE,
  MAX_API_SOCIAL_LINKS,
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
  type ApiPaperStrategyProgress,
  type ApiQualification,
  type ApiQualificationCondition,
  type ApiQualificationSummary,
  type ApiCreatorProfile,
  type ApiCreatorTradeEvidence,
  type ApiAnalyticsCursor,
  type ApiSocial,
  type ApiSocialEvidence,
  type ApiSocialLink,
  type ApiTimelineEntry,
  type ApiTradingCandidate,
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
import {
  SOCIAL_COLLECTION_STATUSES,
  SOCIAL_EVIDENCE_OUTCOMES,
  SOCIAL_EVIDENCE_TYPES,
  SOCIAL_LINK_KINDS,
} from '../domain/social-evidence.js';
import { LAUNCH_STATUSES } from '../domain/launch-status.js';
import {
  LISTENER_RUNTIME_STATES,
  type ListenerRuntimeState,
} from '../domain/transaction-ingestion.js';
import { QUALIFICATION_REASON_CODES } from '../domain/qualification-reasons.js';
import {
  PAPER_DECISION_REASON_CODES,
  PAPER_STRATEGY_SESSION_STATES,
} from '../domain/paper-strategy.js';
import { TRADING_CANDIDATE_STATES } from '../domain/trading-candidate.js';
import {
  QUALIFICATION_CONDITION_MODES,
  QUALIFICATION_CONDITION_STATUSES,
  QUALIFICATION_DIMENSIONS,
  QUALIFICATION_SIGNAL_KEYS,
} from '../domain/qualification.js';
import { MAX_API_PAGE_LIMIT, type ApiProjectionRepository, type PageRequest } from '../ports/api-projection-repository.js';
import {
  BIGINT_JSON_MARKER,
  MAX_SERIALIZED_BIGINT_DIGITS,
  fromJsonValue,
} from '../utils/json.js';
import { getDatabasePool } from './database.js';
import { SOCIAL_URL_INVALID_REASONS } from '../social/social-url-normalizer.js';

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
  readonly qualification: ApiHealth['pipeline']['qualification'];
  readonly paperDecision: ApiHealth['pipeline']['paperDecision'];
  readonly social: ApiHealth['pipeline']['social'];
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
  readonly radar: ReadonlyMap<string, LaunchRadarProjection>;
}

interface PaperDecisionProjection {
  readonly candidate: ApiTradingCandidate | null;
  readonly paperStrategy: ApiPaperStrategyProgress | null;
}

interface LaunchRadarProjection extends PaperDecisionProjection {
  readonly qualificationSummary: ApiQualificationSummary | null;
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
const NOT_AVAILABLE_PAPER: PaperDecisionProjection = Object.freeze({
  candidate: null,
  paperStrategy: null,
});
const NOT_AVAILABLE_RADAR: LaunchRadarProjection = Object.freeze({
  qualificationSummary: null,
  ...NOT_AVAILABLE_PAPER,
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
      qualification: 'STOPPED',
      paperDecision: 'STOPPED',
      social: 'STOPPED',
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
    const social = await this.loadSocial(text(mint));
    return assembleLaunchDetail(launch, projections, holders, social);
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
    if (this.database.connect !== undefined) {
      return this.withSnapshot((repository) => repository.getLaunchSocial(mint));
    }
    const validatedMint = text(mint);
    return (await this.findLaunches(validatedMint)).length === 0
      ? null
      : this.loadSocial(validatedMint);
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
          position.exit_trade_id, position.strategy_id, position.strategy_version,
          position.strategy_session_id, position.qualification_report_id,
          position.candidate_id, session.external_buy_count, session.external_buy_target,
          candidate.reason_codes,
          CASE WHEN trigger.event_id IS NULL THEN 'UNKNOWN'
            WHEN EXISTS (
              SELECT 1 FROM market_pools AS entry_pool
              WHERE entry_pool.base_mint = position.mint
                AND entry_pool.pool_state = 'active'
                AND entry_pool.confirmation_status <> 'orphaned'
                AND (entry_pool.slot, entry_pool.transaction_index,
                  entry_pool.instruction_index,
                  COALESCE(entry_pool.inner_instruction_index, -1))
                  <= (trigger.slot, trigger.transaction_index,
                    trigger.instruction_index,
                    COALESCE(trigger.inner_instruction_index, -1))
            ) THEN 'PUMPSWAP' ELSE 'PUMP_FUN_BONDING_CURVE' END AS entry_venue,
          entry_trade.fees_raw AS entry_fees_raw, exit_trade.fees_raw AS exit_fees_raw
       FROM paper_positions AS position
       JOIN paper_trades AS entry_trade ON entry_trade.trade_id = position.entry_trade_id
       LEFT JOIN paper_trades AS exit_trade ON exit_trade.trade_id = position.exit_trade_id
       LEFT JOIN paper_strategy_sessions AS session
         ON session.session_id = position.strategy_session_id
       LEFT JOIN trading_candidates AS candidate
         ON candidate.candidate_id = position.candidate_id
       LEFT JOIN domain_events AS trigger ON trigger.event_id = position.trigger_event_id
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
      let socialJobs = emptySocialJobs();
      let paperDecisionJobs = emptyPaperDecisionJobs();
      let qualification = emptyQualificationHealth();
      let socialCountsAvailable = true;
      let paperCountsAvailable = true;
      let qualificationCountsAvailable = true;
      try {
        const socialCounts = await this.database.query(
          `SELECT
            COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_count,
            COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS leased_count,
            COUNT(*) FILTER (WHERE status = 'RETRYABLE_FAILED')::int AS retryable_failed_count,
            COUNT(*) FILTER (WHERE retry_exhausted_at IS NOT NULL)::int AS exhausted_count
           FROM social_enrichment_jobs`,
        );
        const socialRow = socialCounts.rows[0];
        if (socialRow !== undefined) socialJobs = socialJobsFromRow(socialRow);
      } catch {
        socialCountsAvailable = false;
        pipeline = freeze({ ...pipeline, social: 'DEGRADED' });
      }
      try {
        const paperCounts = await this.database.query(
          `SELECT
            COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_count,
            COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS leased_count,
            COUNT(*) FILTER (WHERE status = 'RETRYABLE_FAILED')::int AS retryable_failed_count,
            COUNT(*) FILTER (WHERE retry_exhausted_at IS NOT NULL)::int AS exhausted_count,
            MAX(terminal_at) FILTER (WHERE status = 'COMPLETED') AS last_success_at,
            (SELECT latest.error_code FROM paper_decision_jobs AS latest
              WHERE latest.error_code IS NOT NULL
              ORDER BY latest.updated_at DESC,latest.job_id DESC LIMIT 1) AS last_error_code
           FROM paper_decision_jobs`,
        );
        const paperRow = paperCounts.rows[0];
        if (paperRow !== undefined) paperDecisionJobs = paperDecisionJobsFromRow(paperRow);
      } catch {
        paperCountsAvailable = false;
        pipeline = freeze({ ...pipeline, paperDecision: 'DEGRADED' });
      }
      try {
        const qualificationCounts = await this.database.query(
          `SELECT COUNT(*)::int AS current_count, MAX(report.evaluated_at) AS last_success_at
           FROM qualification_reports AS report
           JOIN domain_events AS source
             ON source.event_id = report.source_event_id
            AND source.raw_event_id = report.source_raw_event_id
            AND source.mint = report.mint
            AND source.slot = report.as_of_slot
            AND source.transaction_index = report.as_of_transaction_index
            AND source.instruction_index = report.as_of_instruction_index
            AND source.inner_instruction_index
              IS NOT DISTINCT FROM report.as_of_inner_instruction_index
            AND source.type IN (
              'TokenLaunchDetected', 'BondingCurveTradeObserved',
              'BondingCurveStateUpdated', 'BondingCurveCompleted',
              'MigrationObserved', 'PumpSwapPoolActivated'
            )
           JOIN raw_chain_events AS raw
             ON raw.event_id = report.source_raw_event_id
            AND raw.source = source.source
            AND raw.program = source.program
            AND raw.mint = source.mint
            AND raw.signature = source.signature
            AND raw.slot = source.slot
            AND raw.transaction_index = source.transaction_index
            AND raw.instruction_index = source.instruction_index
            AND raw.inner_instruction_index IS NOT DISTINCT FROM source.inner_instruction_index
           JOIN domain_events AS qualification_event
             ON qualification_event.event_id = report.qualification_event_id
            AND qualification_event.raw_event_id = report.source_raw_event_id
            AND qualification_event.mint = report.mint
            AND qualification_event.type = 'QualificationUpdated'
            AND qualification_event.source = 'qualification'
            AND qualification_event.program = source.program
            AND qualification_event.signature = source.signature
            AND qualification_event.slot = report.as_of_slot
            AND qualification_event.transaction_index = report.as_of_transaction_index
            AND qualification_event.instruction_index = report.as_of_instruction_index
            AND qualification_event.inner_instruction_index
              IS NOT DISTINCT FROM report.as_of_inner_instruction_index
            AND qualification_event.blockchain_time
              IS NOT DISTINCT FROM source.blockchain_time
            AND qualification_event.observed_at = report.evaluated_at
            AND qualification_event.payload_version = 1
           WHERE report.superseded_at IS NULL
             AND report.purge_after > clock_timestamp()
             AND report.confirmation_status <> 'orphaned'
             AND qualification_event.confirmation_status <> 'orphaned'
             AND source.confirmation_status <> 'orphaned'
             AND raw.confirmation_status <> 'orphaned'
             AND report.confirmation_status = source.confirmation_status
             AND report.confirmation_status = raw.confirmation_status
             AND report.confirmation_status = qualification_event.confirmation_status`,
        );
        const qualificationRow = qualificationCounts.rows[0];
        if (qualificationRow !== undefined) qualification = qualificationHealthFromRow(qualificationRow);
      } catch {
        qualificationCountsAvailable = false;
        pipeline = freeze({ ...pipeline, qualification: 'DEGRADED' });
      }
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
      || pipeline.pumpswap === 'DEGRADED' || pipeline.pumpswap === 'STOPPED'
      || pipeline.qualification === 'DEGRADED' || pipeline.qualification === 'STOPPED'
      || pipeline.paperDecision === 'DEGRADED' || pipeline.paperDecision === 'STOPPED'
      || pipeline.social === 'DEGRADED' || pipeline.social === 'STOPPED'
      || !socialCountsAvailable || !paperCountsAvailable || !qualificationCountsAvailable;
      return healthResult(
        observedAt, database.rows.length > 0, degraded, checkpoint, heartbeat,
        lagSlots, pipeline, qualification, socialJobs, paperDecisionJobs,
      );
    } catch {
      return healthResult(
        observedAt,
        false,
        true,
        new Map(),
        emptyHeartbeat(),
        null,
        pipeline,
        emptyQualificationHealth(),
        emptySocialJobs(),
        emptyPaperDecisionJobs(),
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
    if (mints.length === 0) {
      return { metadata: new Map(), curves: new Map(), markets: new Map(), radar: new Map() };
    }
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
    const qualifications = await this.database.query(
      `SELECT DISTINCT ON (report.mint) report.mint, report.payload
         FROM qualification_reports AS report
         JOIN domain_events AS qualification_event
           ON qualification_event.event_id = report.qualification_event_id
         WHERE report.mint = ANY($1)
           AND report.confirmation_status <> 'orphaned'
           AND report.superseded_at IS NULL
           AND report.purge_after > clock_timestamp()
           AND qualification_event.confirmation_status <> 'orphaned'
         ORDER BY report.mint, report.evaluated_at DESC, report.report_id DESC`,
      [mints],
    );
    const candidates = await this.database.query(
      `SELECT DISTINCT ON (candidate.mint) candidate.mint, candidate.candidate_id,
          candidate.state, candidate.strategy_id, candidate.strategy_version,
          candidate.report_id, candidate.quote_mint, candidate.quote_decimals,
          candidate.reason_codes, candidate.eligible_until, candidate.created_at
         FROM trading_candidates AS candidate
         WHERE candidate.mint = ANY($1)
           AND candidate.confirmation_status <> 'orphaned'
           AND candidate.superseded_at IS NULL
           AND candidate.purge_after > clock_timestamp()
         ORDER BY candidate.mint, candidate.created_at DESC, candidate.candidate_id DESC`,
      [mints],
    );
    const sessions = await this.database.query(
      `SELECT DISTINCT ON (session.mint) session.mint, session.session_id,
          session.state, session.reason_code, session.strategy_id,
          session.strategy_version, session.position_id, session.quote_mint,
          session.external_buy_target, session.external_buy_count,
          session.minimum_confirmation, session.updated_at, session.payload
         FROM paper_strategy_sessions AS session
         WHERE session.mint = ANY($1)
           AND (session.purge_after IS NULL OR session.purge_after > clock_timestamp())
         ORDER BY session.mint, session.updated_at DESC, session.session_id DESC`,
      [mints],
    );
    const radar = new Map<string, LaunchRadarProjection>();
    for (const mint of mints) radar.set(mint, NOT_AVAILABLE_RADAR);
    for (const row of qualifications.rows) {
      const mint = text(row.mint);
      const current = radar.get(mint) ?? NOT_AVAILABLE_RADAR;
      radar.set(mint, freeze({
        ...current,
        qualificationSummary: toQualificationSummary(row.payload),
      }));
    }
    for (const row of candidates.rows) {
      const mint = text(row.mint);
      const current = radar.get(mint) ?? NOT_AVAILABLE_RADAR;
      radar.set(mint, freeze({ ...current, candidate: toTradingCandidate(row) }));
    }
    for (const row of sessions.rows) {
      const mint = text(row.mint);
      const current = radar.get(mint) ?? NOT_AVAILABLE_RADAR;
      radar.set(mint, freeze({ ...current, paperStrategy: toPaperStrategy(row) }));
    }
    return {
      metadata: rowsByMint(metadata.rows),
      curves: rowsByMint(curves.rows),
      markets: rowsByMint(markets.rows),
      radar,
    };
  }

  private async loadSocial(mint: string): Promise<ApiSocial> {
    const collectionResult = await this.database.query(
      `SELECT collection.collection_id, collection.metadata_snapshot_id,
          collection.collection_status, collection.observed_at,
          (SELECT COUNT(*) FROM social_links AS counted_link
            WHERE counted_link.collection_id = collection.collection_id) AS declared_link_count,
          (SELECT COUNT(*) FROM social_http_observations AS counted_observation
            WHERE counted_observation.collection_id = collection.collection_id) AS inspected_link_count,
          (SELECT COUNT(*) FROM social_verification_evidence AS counted_evidence
            WHERE counted_evidence.collection_id = collection.collection_id) AS evidence_count,
          (SELECT COUNT(*) FROM social_verification_evidence AS confirmed_evidence
            WHERE confirmed_evidence.collection_id = collection.collection_id
              AND confirmed_evidence.outcome = 'CONFIRMED') AS confirmed_evidence_count,
          (SELECT COUNT(*) FROM social_verification_evidence AS rejected_evidence
            WHERE rejected_evidence.collection_id = collection.collection_id
              AND rejected_evidence.outcome = 'REJECTED') AS rejected_evidence_count,
          (SELECT COUNT(*) FROM social_verification_evidence AS unknown_evidence
            WHERE unknown_evidence.collection_id = collection.collection_id
              AND unknown_evidence.outcome = 'UNKNOWN') AS unknown_evidence_count
       FROM social_evidence_collections AS collection
       JOIN domain_events AS social_event
         ON social_event.type = 'SocialEvidenceCollected'
        AND social_event.mint = collection.mint
        AND social_event.payload ->> 'collectionId' = collection.collection_id
       JOIN domain_events AS launch_event
         ON launch_event.event_id = collection.source_launch_event_id
        AND launch_event.type = 'TokenLaunchDetected'
       WHERE collection.mint = $1
         AND collection.confirmation_status <> 'orphaned'
         AND social_event.confirmation_status <> 'orphaned'
         AND launch_event.confirmation_status <> 'orphaned'
         AND collection.terminal_at IS NULL
         AND social_event.terminal_at IS NULL
       ORDER BY social_event.slot DESC, social_event.transaction_index DESC,
         social_event.instruction_index DESC,
         COALESCE(social_event.inner_instruction_index, -1) DESC,
         collection.collection_id DESC
       LIMIT 1`,
      [mint],
    );
    const collection = collectionResult.rows[0];
    if (collection === undefined) return NOT_AVAILABLE_SOCIAL;
    try {
      const collectionId = text(collection.collection_id);
      const linkCount = countDecimal(collection.declared_link_count);
      const inspectedLinkCount = countDecimal(collection.inspected_link_count);
      const evidenceCount = countDecimal(collection.evidence_count);
      const confirmedEvidenceCount = countDecimal(collection.confirmed_evidence_count);
      const rejectedEvidenceCount = countDecimal(collection.rejected_evidence_count);
      const unknownEvidenceCount = countDecimal(collection.unknown_evidence_count);
      if (
        inspectedLinkCount > linkCount
        || confirmedEvidenceCount + rejectedEvidenceCount + unknownEvidenceCount !== evidenceCount
      ) throw invalid();
      const linksResult = await this.database.query(
        `SELECT link.link_id, link.link_kind, link.declared_value_sha256,
            link.syntax_status, link.canonical_url, link.invalid_reason, link.observed_at
         FROM social_links AS link
         WHERE link.collection_id = $1
         ORDER BY CASE link.link_kind
           WHEN 'WEBSITE' THEN 0 WHEN 'X' THEN 1 WHEN 'TELEGRAM' THEN 2 ELSE 3 END,
           link.link_id
         LIMIT $2`,
        [collectionId, MAX_API_SOCIAL_LINKS],
      );
      const evidenceResult = await this.database.query(
        `SELECT evidence.evidence_id, evidence.evidence_type, evidence.outcome,
            evidence.subject_kind, evidence.related_kind,
            subject_link.canonical_url AS subject_url,
            observation.final_canonical_url AS final_url,
            observation.http_status,
            COALESCE(observation.redirect_count, 0) AS redirect_count,
            observation.content_sha256, evidence.reason_code, evidence.observed_at
         FROM social_verification_evidence AS evidence
         LEFT JOIN social_links AS subject_link
           ON subject_link.link_id = evidence.link_id
          AND subject_link.collection_id = evidence.collection_id
         LEFT JOIN social_http_observations AS observation
           ON observation.observation_id = evidence.observation_id
          AND observation.collection_id = evidence.collection_id
         WHERE evidence.collection_id = $1
         ORDER BY CASE evidence.evidence_type
           WHEN 'URL_SYNTAX_VALID' THEN 0 WHEN 'URL_SYNTAX_INVALID' THEN 1
           WHEN 'URL_REACHABLE' THEN 2 WHEN 'CROSS_LINK_CONFIRMED' THEN 3
           WHEN 'MINT_PUBLISHED' THEN 4 WHEN 'ACCOUNT_TOO_RECENT' THEN 5
           WHEN 'DOMAIN_MISMATCH' THEN 6 WHEN 'CONTENT_UNAVAILABLE' THEN 7
           WHEN 'VERIFICATION_UNKNOWN' THEN 8 ELSE 9 END,
           evidence.evidence_id
         LIMIT $2`,
        [collectionId, MAX_API_SOCIAL_EVIDENCE],
      );
      if (
        linksResult.rows.length !== Math.min(linkCount, MAX_API_SOCIAL_LINKS)
        || evidenceResult.rows.length !== Math.min(evidenceCount, MAX_API_SOCIAL_EVIDENCE)
      ) throw invalid();
      const links = freeze(linksResult.rows.map(toSocialLink));
      const evidence = freeze(evidenceResult.rows.map(toSocialEvidence));
      return freeze({
        status: 'AVAILABLE' as const,
        collectionStatus: validated(
          collection.collection_status,
          SOCIAL_COLLECTION_STATUSES,
        ) as (typeof SOCIAL_COLLECTION_STATUSES)[number],
        collectionId,
        metadataSnapshotId: text(collection.metadata_snapshot_id),
        observedAt: timestamp(collection.observed_at).toISOString(),
        linkCount,
        linksTruncated: linkCount > links.length,
        links,
        evidenceCount,
        evidenceTruncated: evidenceCount > evidence.length,
        evidence,
        coverage: freeze({
          declaredLinkCount: linkCount,
          inspectedLinkCount,
          confirmedEvidenceCount,
          rejectedEvidenceCount,
          unknownEvidenceCount,
        }),
      });
    } catch (error) {
      throw projectionError(error);
    }
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
  const radar = projections.radar.get(mint) ?? NOT_AVAILABLE_RADAR;
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
    qualificationSummary: radar.qualificationSummary,
    candidate: radar.candidate,
    paperStrategy: radar.paperStrategy,
  });
}

function assembleLaunchDetail(
  row: LaunchRow,
  projections: LaunchProjections,
  holders: ApiHolders = NOT_AVAILABLE_HOLDERS,
  social: ApiSocial = NOT_AVAILABLE_SOCIAL,
): ApiLaunchDetail {
  const summary = assembleLaunchSummary(row, projections);
  const curve = projections.curves.get(summary.mint);
  const market = projections.markets.get(summary.mint);
  return freeze({
    ...summary, creator: text(row.creator), tokenProgram: text(row.token_program), launchpad: text(row.launchpad),
    initialTokenAmount: nullableDecimal(row.initial_token_amount), initialQuoteAmount: nullableDecimal(row.initial_quote_amount),
    reserveBase: nullableDecimal(market?.base_reserves_raw) ?? nullableDecimal(curve?.real_base_reserves_raw),
    reserveQuote: nullableDecimal(market?.quote_vault_amount_raw) ?? nullableDecimal(curve?.real_quote_reserves_raw),
    feeBps: null, social, holders,
  });
}

function toQualificationSummary(value: unknown): ApiQualificationSummary {
  const report = qualification(value);
  return freeze({
    verdict: report.verdict,
    scores: report.scores,
    blockerCodes: freeze(report.blockers.map((blocker) => blocker.code)),
    evaluatedAt: report.evaluatedAt,
  });
}

function toTradingCandidate(row: Record<string, unknown>): ApiTradingCandidate {
  const state = validated(row.state, TRADING_CANDIDATE_STATES) as ApiTradingCandidate['state'];
  const eligibleUntil = nullableTimestamp(row.eligible_until);
  if ((state === 'ELIGIBLE') !== (eligibleUntil !== null)) throw invalid();
  return freeze({
    id: text(row.candidate_id),
    state,
    strategyId: text(row.strategy_id),
    strategyVersion: positiveSafeNumber(row.strategy_version),
    qualificationReportId: text(row.report_id),
    quoteMint: text(row.quote_mint),
    quoteDecimals: tokenDecimals(row.quote_decimals),
    reasonCodes: paperReasonCodes(row.reason_codes),
    eligibleUntil,
    createdAt: timestamp(row.created_at).toISOString(),
  });
}

function toPaperStrategy(row: Record<string, unknown>): ApiPaperStrategyProgress {
  const payload = restoredRecord(row.payload);
  const lastErrorValue = payload.lastError;
  const lastError = lastErrorValue === null ? null : record(lastErrorValue);
  const lastErrorCode = lastError === null ? null : text(lastError.code);
  if (lastErrorCode !== null && !/^[A-Z][A-Z0-9_]{0,127}$/u.test(lastErrorCode)) throw invalid();
  const externalBuyTarget = positiveSafeNumber(row.external_buy_target);
  const externalBuyCount = nonNegativeSafeNumber(row.external_buy_count);
  if (externalBuyCount > externalBuyTarget) throw invalid();
  return freeze({
    id: text(row.session_id),
    state: validated(
      row.state,
      PAPER_STRATEGY_SESSION_STATES,
    ) as ApiPaperStrategyProgress['state'],
    reasonCode: validated(
      row.reason_code,
      PAPER_DECISION_REASON_CODES,
    ) as ApiPaperStrategyProgress['reasonCode'],
    strategyId: text(row.strategy_id),
    strategyVersion: positiveSafeNumber(row.strategy_version),
    positionId: nullableText(row.position_id),
    quoteMint: text(row.quote_mint),
    externalBuyTarget,
    externalBuyCount,
    minimumConfirmation: validated(
      row.minimum_confirmation,
      ['confirmed', 'finalized'],
    ) as ApiPaperStrategyProgress['minimumConfirmation'],
    updatedAt: timestamp(row.updated_at).toISOString(),
    lastErrorCode,
    lastErrorRetryable: lastError === null ? null : boolean(lastError.retryable),
  });
}

function toSocialLink(row: Record<string, unknown>): ApiSocialLink {
  const syntaxStatus = validated(row.syntax_status, ['VALID', 'INVALID'] as const) as ApiSocialLink['syntaxStatus'];
  const canonicalUrl = nullableText(row.canonical_url);
  const invalidReason = nullableText(row.invalid_reason);
  if (
    (syntaxStatus === 'VALID' && (canonicalUrl === null || invalidReason !== null))
    || (syntaxStatus === 'INVALID' && (canonicalUrl !== null || invalidReason === null))
    || (invalidReason !== null && !SOCIAL_URL_INVALID_REASONS.includes(
      invalidReason as (typeof SOCIAL_URL_INVALID_REASONS)[number],
    ))
  ) throw invalid();
  return freeze({
    id: text(row.link_id),
    kind: validated(row.link_kind, SOCIAL_LINK_KINDS) as ApiSocialLink['kind'],
    declaredValueSha256: sha256(row.declared_value_sha256),
    syntaxStatus,
    canonicalUrl,
    invalidReason,
    observedAt: timestamp(row.observed_at).toISOString(),
  });
}

function toSocialEvidence(row: Record<string, unknown>): ApiSocialEvidence {
  const httpStatus = nullableSafeNumber(row.http_status);
  if (httpStatus !== null && (httpStatus < 100 || httpStatus > 599)) throw invalid();
  const redirectCount = nonNegativeSafeNumber(row.redirect_count);
  if (redirectCount > 10) throw invalid();
  const reasonCode = text(row.reason_code);
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(reasonCode)) throw invalid();
  return freeze({
    id: text(row.evidence_id),
    type: validated(row.evidence_type, SOCIAL_EVIDENCE_TYPES) as ApiSocialEvidence['type'],
    outcome: validated(row.outcome, SOCIAL_EVIDENCE_OUTCOMES) as ApiSocialEvidence['outcome'],
    subjectKind: nullableValidated(row.subject_kind, SOCIAL_LINK_KINDS) as ApiSocialEvidence['subjectKind'],
    relatedKind: nullableValidated(row.related_kind, SOCIAL_LINK_KINDS) as ApiSocialEvidence['relatedKind'],
    subjectUrl: nullableText(row.subject_url),
    finalUrl: nullableText(row.final_url),
    httpStatus,
    redirectCount,
    contentSha256: nullableSha256(row.content_sha256),
    reasonCode,
    observedAt: timestamp(row.observed_at).toISOString(),
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
const QUALIFICATION_EVIDENCE_FIELDS = ['signal', 'dimension', 'status', 'required', 'weight', 'message'] as const;
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
    validated(fields.dimension, QUALIFICATION_DIMENSIONS);
    boolean(fields.required);
    if (nonNegativeSafeNumber(fields.weight) > 100) throw invalid();
    return freeze({
      signal: validated(fields.signal, QUALIFICATION_SIGNAL_KEYS) as ApiQualification['evidence'][number]['signal'],
      status: validated(fields.status, QUALIFICATION_EVIDENCE_STATUSES) as ApiQualification['evidence'][number]['status'],
      message: qualificationMessage(fields.message),
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
  const externalBuyCount = nullableSafeNumber(row.external_buy_count);
  const externalBuyTarget = nullableSafeNumber(row.external_buy_target);
  const strategySessionId = nullableText(row.strategy_session_id);
  const qualificationReportId = nullableText(row.qualification_report_id);
  const candidateId = nullableText(row.candidate_id);
  const lineagePresence = [strategySessionId, qualificationReportId, candidateId]
    .filter((value) => value !== null).length;
  if ((externalBuyCount === null) !== (externalBuyTarget === null)
    || (externalBuyCount !== null && externalBuyTarget !== null
      && (externalBuyCount > externalBuyTarget || externalBuyTarget <= 0))
    || (lineagePresence !== 0 && lineagePresence !== 3)
    || ((lineagePresence === 0) !== (externalBuyCount === null))) throw invalid();
  return freeze({
    id: text(row.position_id), mint: text(row.mint), status,
    openedAt: timestamp(row.opened_at).toISOString(), closedAt: nullableTimestamp(row.closed_at), quoteMint: text(row.quote_mint),
    quantity: decimal(row.remaining_base_raw), entryQuoteAmount: decimal(row.quote_cost_raw),
    exitQuoteAmount: nullableDecimal(row.quote_proceeds_raw), realizedPnlQuote: nullableSignedDecimal(row.net_pnl_quote_raw),
    estimatedFeesQuote: (BigInt(decimal(row.entry_fees_raw))
      + BigInt(exitFees ?? '0')).toString(),
    strategyId: text(row.strategy_id),
    strategyVersion: positiveSafeNumber(row.strategy_version),
    strategySessionId,
    qualificationReportId,
    candidateId,
    externalBuyCount,
    externalBuyTarget,
    entryVenue: validated(
      row.entry_venue,
      ['PUMP_FUN_BONDING_CURVE', 'PUMPSWAP', 'UNKNOWN'],
    ) as ApiPaperPosition['entryVenue'],
    reasonCodes: row.reason_codes === null || row.reason_codes === undefined
      ? freeze([] as const) : paperReasonCodes(row.reason_codes),
  });
}

function paperReasonCodes(value: unknown): readonly ApiPaperPosition['reasonCodes'][number][] {
  const values = array(json(value));
  if (values.length > PAPER_DECISION_REASON_CODES.length) throw invalid();
  const reasons = values.map((item) => validated(item, PAPER_DECISION_REASON_CODES));
  if (new Set(reasons).size !== reasons.length) throw invalid();
  return freeze(reasons as ApiPaperPosition['reasonCodes'][number][]);
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

function nullableValidated(value: unknown, values: readonly string[]): string | null {
  return value === null || value === undefined ? null : validated(value, values);
}

function sha256(value: unknown): string {
  const candidate = text(value);
  if (!/^[0-9a-f]{64}$/u.test(candidate)) throw invalid();
  return candidate;
}

function nullableSha256(value: unknown): string | null {
  return value === null || value === undefined ? null : sha256(value);
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
  qualification: 'DEGRADED',
  paperDecision: 'DEGRADED',
  social: 'DEGRADED',
});

function emptyHeartbeat(): ApiHealth['heartbeat'] {
  return freeze({ runtimeState: null, subscriberState: null, scannerState: null,
    workerState: null, reconcilerState: null, backlogCount: null, leasedCount: null,
    exhaustedCount: null,
    startedAt: null, updatedAt: null, lastHttpSlot: null, lastWebsocketSlot: null,
    lastFinalizedSlot: null, lastSignature: null, pendingTransactions: null, activeSessions: null });
}

function emptySocialJobs(): ApiHealth['socialJobs'] {
  return freeze({
    pendingCount: 0,
    leasedCount: 0,
    retryableFailedCount: 0,
    exhaustedCount: 0,
  });
}

function emptyQualificationHealth(): ApiHealth['qualification'] {
  return freeze({ currentCount: 0, lastSuccessAt: null });
}

function emptyPaperDecisionJobs(): ApiHealth['paperDecisionJobs'] {
  return freeze({
    pendingCount: 0,
    leasedCount: 0,
    retryableFailedCount: 0,
    exhaustedCount: 0,
    lastSuccessAt: null,
    lastErrorCode: null,
  });
}

function socialJobsFromRow(row: Record<string, unknown>): ApiHealth['socialJobs'] {
  return freeze({
    pendingCount: nonNegativeSafeNumber(row.pending_count),
    leasedCount: nonNegativeSafeNumber(row.leased_count),
    retryableFailedCount: nonNegativeSafeNumber(row.retryable_failed_count),
    exhaustedCount: nonNegativeSafeNumber(row.exhausted_count),
  });
}

function qualificationHealthFromRow(
  row: Record<string, unknown>,
): ApiHealth['qualification'] {
  return freeze({
    currentCount: nonNegativeSafeNumber(row.current_count),
    lastSuccessAt: nullableTimestamp(row.last_success_at),
  });
}

function paperDecisionJobsFromRow(
  row: Record<string, unknown>,
): ApiHealth['paperDecisionJobs'] {
  return freeze({
    pendingCount: nonNegativeSafeNumber(row.pending_count),
    leasedCount: nonNegativeSafeNumber(row.leased_count),
    retryableFailedCount: nonNegativeSafeNumber(row.retryable_failed_count),
    exhaustedCount: nonNegativeSafeNumber(row.exhausted_count),
    lastSuccessAt: nullableTimestamp(row.last_success_at),
    lastErrorCode: nullableValidated(
      row.last_error_code,
      ['RPC_TRANSIENT', 'QUOTE_UNAVAILABLE', 'LEASE_EXPIRED', 'DECISION_INVALID'],
    ) as ApiHealth['paperDecisionJobs']['lastErrorCode'],
  });
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
  if (keys.length !== 6
    || !keys.includes('httpAvailable')
    || !keys.includes('pumpfun')
    || !keys.includes('pumpswap')
    || !keys.includes('qualification')
    || !keys.includes('paperDecision')
    || !keys.includes('social')) throw invalid();
  const httpAvailable = pipelineValue(value, 'httpAvailable');
  const pumpfun = pipelineValue(value, 'pumpfun');
  const pumpswap = pipelineValue(value, 'pumpswap');
  const qualification = pipelineValue(value, 'qualification');
  const paperDecision = pipelineValue(value, 'paperDecision');
  const social = pipelineValue(value, 'social');
  if (typeof httpAvailable !== 'boolean'
    || !isPipelineRuntimeState(pumpfun)
    || !isPipelineRuntimeState(pumpswap)
    || !isPipelineRuntimeState(qualification)
    || !isPipelineRuntimeState(paperDecision)
    || !isPipelineRuntimeState(social)) throw invalid();
  return freeze({ httpAvailable, pumpfun, pumpswap, qualification, paperDecision, social });
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
  qualification: ApiHealth['qualification'],
  socialJobs: ApiHealth['socialJobs'],
  paperDecisionJobs: ApiHealth['paperDecisionJobs'],
): ApiHealth {
  return freeze({ status: degraded ? 'DEGRADED' : 'OK', observedAt: observedAt.toISOString(),
    postgresql: freeze({ status: databaseAvailable ? 'AVAILABLE' : 'UNAVAILABLE' }),
    http: freeze({ status: pipeline.httpAvailable ? 'AVAILABLE' : 'UNAVAILABLE' }),
    pipeline: freeze({
      pumpfun: pipeline.pumpfun,
      pumpswap: pipeline.pumpswap,
      qualification: pipeline.qualification,
      paperDecision: pipeline.paperDecision,
      social: pipeline.social,
    }),
    qualification, socialJobs,
    paperDecisionJobs,
    checkpoints: freeze({ launchpad: checkpoints.get('launchpad') ?? null, market: checkpoints.get('market') ?? null }),
    heartbeat, lagSlots });
}

function tokenDecimals(value: unknown): number {
  const result = safeNumber(value);
  if (result < 0 || result > 255) throw invalid();
  return result;
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
