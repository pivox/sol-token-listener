import {
  toApiDomainPayload,
  type ApiHealth,
  type ApiBlockHydrationMetricsV1,
  type ApiBlockHydrationAdmissionMetricsV1,
  type ApiCatchUpAdmissionMetricsV1,
  type ApiDecoderQuarantineMetricsV1,
  type ApiFirstProcessingCanaryEvidenceV1,
  type ApiRpcHttpEvidenceV1,
  type ApiWorkerAdmissionMetricsV1,
  type ApiWorkerAdmissionClockV1,
  type ApiWebSocketHealth,
  type ApiLaunchDetail,
  type ApiLaunchSummary,
  type ApiPage,
  type ApiPaperPosition,
  type ApiPaperStrategyProgress,
  type ApiQualification,
  type ApiQualificationCondition,
  type ApiQualificationSummary,
  type ApiTimelineEntry,
  type ApiTradingCandidate,
} from '../api/contracts.js';
import { isProxy } from 'node:util/types';
import { snapshotRuntimeBlockHydrationAdmissionMetrics } from '../domain/block-hydration-admission.js';
import {
  assertTwoGroupHydrationEvidenceForState,
  snapshotRuntimeTwoGroupHydrationEvidenceV2,
} from '../domain/two-group-hydration-evidence.js';
import { snapshotScannerPhaseDiagnostics, type ScannerPhaseDiagnosticsV1 } from '../domain/scanner-phase-diagnostics.js';
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
import { createFirstProcessingCanaryEvidence } from '../domain/first-processing-canary.js';
import {
  createRuntimeRpcHttpRoleEvidence,
  type RuntimeRpcHttpRoleEvidenceV1,
} from '../domain/rpc-http-role-evidence.js';
import {
  createRuntimeBlockHydrationPhaseEvidence,
  type RuntimeBlockHydrationPhaseEvidenceV1,
} from '../domain/block-hydration-phase-evidence.js';
import { snapshotRuntimeWorkerAdmissionMetrics, snapshotRuntimeWorkerAdmissionClock } from '../domain/worker-admission-metrics.js';
import { LAUNCH_STATUSES } from '../domain/launch-status.js';
import { isRpcProviderId, RPC_PROVIDER_IDS } from '../domain/rpc-provider.js';
import {
  LISTENER_RUNTIME_STATES,
  snapshotRuntimeCatchUpAdmissionMetrics,
  type ListenerRuntimeState,
} from '../domain/transaction-ingestion.js';
import {
  WEBSOCKET_HEALTH_STALE_AFTER_MS,
  createWebSocketHealthSnapshot,
  publicWebSocketState,
  type WebSocketHealthSnapshot,
} from '../domain/websocket-health.js';
import { QUALIFICATION_REASON_CODES } from '../domain/qualification-reasons.js';
import {
  CREATION_EXIT_REASONS,
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
  canonicalStringifyJson,
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
  readonly qualification: ApiHealth['pipeline']['qualification'];
  readonly paperDecision: ApiHealth['pipeline']['paperDecision'];
}

const LISTENER_SERVICE_KEY = 'transaction-listener';

export type ApiProjectionPipelineStateProvider = () => ApiProjectionPipelineState;

export interface ApiQualificationProfileIdentity {
  readonly id: string;
  readonly version: number;
  readonly fingerprint: string;
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
  private readonly qualificationProfile: ApiQualificationProfileIdentity | null;

  public constructor(
    private readonly database: Queryable = getDatabasePool(),
    private readonly clock: () => Date = () => new Date(),
    pipeline: ApiProjectionPipelineState | ApiProjectionPipelineStateProvider = {
      httpAvailable: false,
      pumpfun: 'STOPPED',
      pumpswap: 'STOPPED',
      qualification: 'STOPPED',
      paperDecision: 'STOPPED',
    },
    qualificationProfile: ApiQualificationProfileIdentity | null = null,
  ) {
    this.pipeline = typeof pipeline === 'function'
      ? pipeline
      : (): ApiProjectionPipelineState => pipeline;
    this.qualificationProfile = qualificationProfile === null
      ? null
      : qualificationProfileIdentity(qualificationProfile);
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
    return assembleLaunchDetail(launch, projections);
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
      `SELECT * FROM (
        SELECT domain_event.event_id AS id, domain_event.type,
          COALESCE(domain_event.blockchain_time, domain_event.observed_at) AS occurred_at,
          domain_event.slot, domain_event.transaction_index, domain_event.instruction_index,
          domain_event.inner_instruction_index, domain_event.confirmation_status,
          domain_event.payload_version, domain_event.payload,
          COALESCE(domain_event.inner_instruction_index, -1) AS inner_sort
        FROM domain_events AS domain_event
        WHERE domain_event.mint = $1
      ) AS timeline${afterSql}
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
    const profileClause = this.qualificationProfile === null ? '' : `
         AND report.profile_id = $2 AND report.profile_version = $3
         AND report.profile_fingerprint = $4`;
    const values = this.qualificationProfile === null
      ? [text(mint)]
      : [text(mint), this.qualificationProfile.id, this.qualificationProfile.version,
        this.qualificationProfile.fingerprint];
    const result = await this.database.query(
      `SELECT report.report_id, report.evidence_fingerprint, report.profile_id,
         report.profile_version, report.profile_fingerprint, report.verdict,
         report.preparation_score, report.social_score, report.onchain_score,
         report.total_score, report.evaluated_at,
         report.payload_version AS report_payload_version,
         octet_length(report.payload::text) AS report_payload_size,
         CASE WHEN octet_length(report.payload::text) <= 1048576 THEN report.payload END AS report_payload,
         qualification_event.event_id AS qualification_event_id,
         qualification_event.payload_version AS event_payload_version,
         octet_length(qualification_event.payload::text) AS event_payload_size,
         CASE WHEN octet_length(qualification_event.payload::text) <= 1048576
           THEN qualification_event.payload END AS event_payload
       FROM qualification_reports AS report
       JOIN domain_events AS source
         ON source.event_id = report.source_event_id
        AND source.raw_event_id = report.source_raw_event_id
        AND source.mint = report.mint
        AND source.slot = report.as_of_slot
        AND source.transaction_index = report.as_of_transaction_index
        AND source.instruction_index = report.as_of_instruction_index
        AND source.inner_instruction_index IS NOT DISTINCT FROM report.as_of_inner_instruction_index
        AND source.type IN (
          'TokenLaunchDetected', 'BondingCurveTradeObserved',
          'BondingCurveStateUpdated', 'BondingCurveCompleted',
          'MigrationObserved', 'PumpSwapPoolActivated'
        )
       JOIN raw_chain_events AS raw
         ON raw.event_id = report.source_raw_event_id
        AND raw.source = source.source AND raw.program = source.program
        AND raw.mint = source.mint AND raw.signature = source.signature
        AND raw.slot = source.slot AND raw.transaction_index = source.transaction_index
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
        AND qualification_event.inner_instruction_index IS NOT DISTINCT FROM report.as_of_inner_instruction_index
        AND qualification_event.blockchain_time IS NOT DISTINCT FROM source.blockchain_time
        AND qualification_event.observed_at = report.evaluated_at
        AND qualification_event.payload_version = 1
       WHERE report.mint = $1
         AND report.superseded_at IS NULL
         AND report.purge_after > clock_timestamp()
         AND report.confirmation_status <> 'orphaned'
         AND source.confirmation_status <> 'orphaned'
         AND raw.confirmation_status <> 'orphaned'
         AND qualification_event.confirmation_status <> 'orphaned'
         AND report.confirmation_status = source.confirmation_status
         AND report.confirmation_status = raw.confirmation_status
         AND report.confirmation_status = qualification_event.confirmation_status${profileClause}
       ORDER BY report.evaluated_at DESC, report.report_id DESC
       LIMIT 1`,
      values,
    );
    const row = result.rows[0];
    return row === undefined ? null : canonicalQualificationRisk(row);
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
    const responseObservedAt = validDate(this.clock());
    let pipeline = DEGRADED_PIPELINE_STATE;
    try {
      pipeline = pipelineState(this.pipeline);
      const activeCheckpointKeys = pipeline.pumpswap === 'IDLE'
        ? ['launchpad']
        : ['launchpad', 'market'];
      const database = await this.database.query('SELECT 1 AS available');
      const checkpoints = await this.database.query(
        `SELECT checkpoint_key, slot FROM processing_checkpoints
         WHERE checkpoint_key = ANY($1::text[])`,
        [activeCheckpointKeys],
      );
      const healthSnapshot = await this.database.query(
        `SELECT
            heartbeat.service_key AS heartbeat_service_key,
            heartbeat.updated_at AS heartbeat_updated_at,
            heartbeat.payload AS heartbeat_payload,
            heartbeat.started_at, heartbeat.last_http_slot,
            heartbeat.last_websocket_slot, heartbeat.last_finalized_slot,
            heartbeat.pending_transactions, heartbeat.active_sessions,
            heartbeat.runtime_state, heartbeat.subscriber_state,
            heartbeat.scanner_state, heartbeat.worker_state,
            heartbeat.reconciler_state, heartbeat.leased_transactions,
            heartbeat.exhausted_transactions,
            websocket.service_key AS websocket_service_key,
            websocket.payload_version, websocket.supervision,
            websocket.owner_generation, websocket.revision,
            websocket.active_session_generation, websocket.candidate_session_generation,
            websocket.provider_id, websocket.candidate_provider_id, websocket.phase,
            websocket.acknowledged_at, websocket.last_observation_at,
            websocket.last_observation_slot, websocket.disconnect_occurred_at,
            websocket.disconnect_reason_code, websocket.recovery_status,
            websocket.recovery_started_at, websocket.recovery_completed_at,
            websocket.recovery_reason_code, websocket.heartbeat_at,
            websocket.updated_at, websocket.evidence_purge_after,
            EXISTS (
              SELECT 1 FROM listener_strict_catch_up_failures
              WHERE resolved_at IS NULL
                AND checkpoint_key = ANY($2::text[])
              LIMIT 1
            ) AS has_unresolved
         FROM (VALUES ($1::text)) AS health_anchor(service_key)
         LEFT JOIN listener_heartbeats AS heartbeat
           ON heartbeat.service_key = health_anchor.service_key
         LEFT JOIN listener_websocket_health AS websocket
           ON websocket.service_key = health_anchor.service_key`,
        [LISTENER_SERVICE_KEY, activeCheckpointKeys],
      );
      const healthSnapshotRow = healthSnapshot.rows[0];
      if (healthSnapshotRow === undefined) throw invalid();
      const heartbeatPresent = canonicalHealthRowPresent(healthSnapshotRow.heartbeat_service_key);
      const websocketPresent = canonicalHealthRowPresent(healthSnapshotRow.websocket_service_key);
      const websocket = !websocketPresent
        ? inactiveWebSocketHealth()
        : webSocketHealthFromRow(healthSnapshotRow);
      if (typeof healthSnapshotRow.has_unresolved !== 'boolean') {
        throw invalid();
      }
      const hasUnresolvedStrictFailure = healthSnapshotRow.has_unresolved;
      let paperDecisionJobs = emptyPaperDecisionJobs();
      let qualification = emptyQualificationHealth();
      let paperCountsAvailable = true;
      let qualificationCountsAvailable = true;
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
      const heartbeat = !heartbeatPresent
        ? emptyHeartbeat(websocket)
        : heartbeatFromRow(healthSnapshotRow, websocket);
      const lagSlots = heartbeat.lastHttpSlot === null || heartbeat.lastWebsocketSlot === null
        ? null : (BigInt(heartbeat.lastHttpSlot) - BigInt(heartbeat.lastWebsocketSlot)).toString();
      const freshnessObservedAt = validDate(this.clock());
      const heartbeatAge = heartbeat.updatedAt === null
        ? null : freshnessObservedAt.getTime() - Date.parse(heartbeat.updatedAt);
      const stale = heartbeatAge === null
        || heartbeatAge < 0
        || heartbeatAge > HEARTBEAT_STALE_AFTER_MS;
      const runtimeDegraded = heartbeat.runtimeState !== 'RUNNING'
        || heartbeat.subscriberState !== 'RUNNING'
        || heartbeat.scannerState !== 'RUNNING'
        || heartbeat.workerState !== 'RUNNING'
        || heartbeat.reconcilerState !== 'RUNNING';
      const websocketHeartbeatAge = websocket.heartbeatAt === null
        ? null : freshnessObservedAt.getTime() - Date.parse(websocket.heartbeatAt);
      const websocketStale = websocketHeartbeatAge === null
        || websocketHeartbeatAge < 0
        || websocketHeartbeatAge > WEBSOCKET_HEALTH_STALE_AFTER_MS;
      const websocketDegraded = websocket.supervision === 'ACTIVE' && (
        hasUnresolvedStrictFailure
        || websocketStale
        || websocket.phase !== 'RUNNING'
        || websocket.state !== 'ACKNOWLEDGED'
        || (websocket.recovery.status !== 'NOT_REQUIRED'
          && websocket.recovery.status !== 'RECOVERED')
      );
      const degraded = database.rows.length === 0 || stale || runtimeDegraded || websocketDegraded
      || !pipeline.httpAvailable
      || pipeline.pumpfun === 'DEGRADED' || pipeline.pumpfun === 'STOPPED'
      || pipeline.pumpswap === 'DEGRADED' || pipeline.pumpswap === 'STOPPED'
      || pipeline.qualification === 'DEGRADED' || pipeline.qualification === 'STOPPED'
      || pipeline.paperDecision === 'DEGRADED' || pipeline.paperDecision === 'STOPPED'
      || !paperCountsAvailable || !qualificationCountsAvailable;
      return healthResult(
        responseObservedAt, database.rows.length > 0, degraded, checkpoint, heartbeat,
        lagSlots, pipeline, qualification, paperDecisionJobs,
      );
    } catch {
      return healthResult(
        responseObservedAt,
        false,
        true,
        new Map(),
        emptyHeartbeat(),
        null,
        pipeline,
        emptyQualificationHealth(),
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
        this.qualificationProfile,
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
          session.minimum_confirmation, session.updated_at, session.payload_version,
          session.payload
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
): ApiLaunchDetail {
  const summary = assembleLaunchSummary(row, projections);
  const curve = projections.curves.get(summary.mint);
  const market = projections.markets.get(summary.mint);
  return freeze({
    ...summary, creator: text(row.creator), tokenProgram: text(row.token_program), launchpad: text(row.launchpad),
    initialTokenAmount: nullableDecimal(row.initial_token_amount), initialQuoteAmount: nullableDecimal(row.initial_quote_amount),
    reserveBase: nullableDecimal(market?.base_reserves_raw) ?? nullableDecimal(curve?.real_base_reserves_raw),
    reserveQuote: nullableDecimal(market?.quote_vault_amount_raw) ?? nullableDecimal(curve?.real_quote_reserves_raw),
    feeBps: null,
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
  const strategyId = text(row.strategy_id);
  const payloadVersion = positiveSafeNumber(row.payload_version);
  if (
    (strategyId === 'creation-entry-v1' && payloadVersion !== 2)
    || (strategyId !== 'creation-entry-v1' && payloadVersion !== 1)
  ) throw invalid();
  const pendingExitValue = payload.pendingExitReason;
  const pendingExitReason = pendingExitValue === undefined || pendingExitValue === null
    ? null
    : validated(
      pendingExitValue,
      CREATION_EXIT_REASONS,
    ) as ApiPaperStrategyProgress['pendingExitReason'];
  if (strategyId !== 'creation-entry-v1' && pendingExitReason !== null) throw invalid();
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
    pendingExitReason,
    strategyId,
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

const CANONICAL_QUALIFICATION_EVENT_FIELDS = [
  'reportId', 'evidenceFingerprint', 'evaluation', 'report',
] as const;
const QUALIFICATION_EVALUATION_FIELDS = [
  'evaluatedAtMs', 'signals', 'blockers', 'calibrationFacts',
] as const;
const MAX_QUALIFICATION_PAYLOAD_BYTES = 1_048_576;

function canonicalQualificationRisk(row: Record<string, unknown>): ApiQualification {
  try {
    const reportPayloadSize = positiveSafeNumber(row.report_payload_size);
    const eventPayloadSize = positiveSafeNumber(row.event_payload_size);
    if (
      reportPayloadSize > MAX_QUALIFICATION_PAYLOAD_BYTES
      || eventPayloadSize > MAX_QUALIFICATION_PAYLOAD_BYTES
      || positiveSafeNumber(row.report_payload_version) !== 1
      || positiveSafeNumber(row.event_payload_version) !== 1
    ) throw invalid();
    const reportPayload = json(row.report_payload);
    const eventPayload = exactDataRecord(
      json(row.event_payload),
      CANONICAL_QUALIFICATION_EVENT_FIELDS,
      'Canonical qualification event payload',
    );
    const reportId = qualificationReportId(eventPayload.reportId);
    const evidenceFingerprint = qualificationFingerprint(eventPayload.evidenceFingerprint);
    const evaluation = exactDataRecord(
      eventPayload.evaluation,
      QUALIFICATION_EVALUATION_FIELDS,
      'Canonical qualification evaluation',
    );
    const projected = qualification(eventPayload.report);
    canonicalStringifyJson(fromJsonValue(eventPayload));
    if (
      canonicalStringifyJson(fromJsonValue(eventPayload.report))
      !== canonicalStringifyJson(fromJsonValue(reportPayload))
    ) throw invalid();
    const evaluatedAt = timestamp(row.evaluated_at);
    if (
      reportId !== text(row.report_id)
      || evidenceFingerprint !== qualificationFingerprint(row.evidence_fingerprint)
      || text(row.qualification_event_id).length === 0
      || text(row.profile_id) !== projected.ruleSet.id
      || positiveSafeNumber(row.profile_version) !== projected.ruleSet.version
      || qualificationFingerprint(row.profile_fingerprint)
        !== (projected.ruleSet.fingerprint ?? qualificationFingerprint(row.profile_fingerprint))
      || row.verdict !== projected.verdict
      || safeNumber(row.preparation_score) !== projected.scores.preparation.score
      || safeNumber(row.social_score) !== projected.scores.socialAuthenticity.score
      || safeNumber(row.onchain_score) !== projected.scores.onchainHealth.score
      || safeNumber(row.total_score) !== projected.scores.total.score
      || evaluatedAt.toISOString() !== projected.evaluatedAt
      || safeNumber(evaluation.evaluatedAtMs) !== evaluatedAt.getTime()
    ) throw invalid();
    return projected;
  } catch (error) {
    throw projectionError(error);
  }
}

function qualificationReportId(value: unknown): string {
  if (typeof value !== 'string' || !/^qreport_[0-9a-f]{64}$/u.test(value)) throw invalid();
  return value;
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

function qualificationProfileIdentity(
  value: ApiQualificationProfileIdentity,
): ApiQualificationProfileIdentity {
  const fields = qualificationRecord(value);
  return freeze({
    id: text(ownDataProperty(fields, 'id')),
    version: positiveSafeNumber(ownDataProperty(fields, 'version')),
    fingerprint: qualificationFingerprint(ownDataProperty(fields, 'fingerprint')),
  });
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

function safeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalid();
  return value;
}

function nonNegativeSafeNumber(value: unknown): number {
  const result = safeNumber(value);
  if (result < 0 || Object.is(result, -0)) throw invalid();
  return result;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}

function restoredRecord(value: unknown): Record<string, unknown> {
  return record(fromJsonValue(json(value)));
}

function boundedBps(value: unknown): string {
  const result = decimal(value);
  if (BigInt(result) > 10_000n) throw invalid();
  return result;
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
});

function emptyHeartbeat(
  websocket: ApiWebSocketHealth = inactiveWebSocketHealth(),
): ApiHealth['heartbeat'] {
  return freeze({ runtimeState: null, subscriberState: null, scannerState: null,
    workerState: null, reconcilerState: null, backlogCount: null, leasedCount: null,
    exhaustedCount: null,
    startedAt: null, updatedAt: null, lastHttpSlot: null, lastWebsocketSlot: null,
    lastFinalizedSlot: null, lastSignature: null, pendingTransactions: null, activeSessions: null,
    websocket, blockHydration: null, blockHydrationPhaseEvidence: null,
    blockHydrationAdmission: null, catchUpAdmission: null, workerAdmission: null,
    workerAdmissionClock: null,
    rpcHttpEvidence: null,
    rpcHttpRoleEvidence: null,
    firstProcessingCanary: null, decoderQuarantine: null, scannerPhaseDiagnostics: null });
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

function heartbeatFromRow(
  row: Record<string, unknown>,
  websocket: ApiWebSocketHealth,
): ApiHealth['heartbeat'] {
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
  const updatedAt = timestamp(row.heartbeat_updated_at).toISOString();
  if (startedAt !== null && Date.parse(startedAt) > Date.parse(updatedAt)) throw invalid();
  const workerAdmission = workerAdmissionFromPayload(row.heartbeat_payload);
  const workerAdmissionClock = workerAdmissionClockFromPayload(row.heartbeat_payload, workerAdmission, Date.parse(updatedAt));
  const hydrationEvidence = hydrationEvidenceFromPayload(row.heartbeat_payload, runtimeState);
  return freeze({
    runtimeState, subscriberState, scannerState, workerState, reconcilerState,
    backlogCount, leasedCount, exhaustedCount, startedAt, updatedAt,
    lastHttpSlot: nullableDecimal(row.last_http_slot),
    lastWebsocketSlot: nullableDecimal(row.last_websocket_slot), lastFinalizedSlot: nullableDecimal(row.last_finalized_slot),
    lastSignature: null, pendingTransactions: backlogCount,
    activeSessions: nullableSafeNumber(row.active_sessions), websocket,
    ...hydrationEvidence,
    blockHydrationPhaseEvidence: blockHydrationPhaseEvidenceFromPayload(row.heartbeat_payload),
    catchUpAdmission: catchUpAdmissionFromPayload(row.heartbeat_payload, backlogCount),
    workerAdmission,
    workerAdmissionClock,
    rpcHttpEvidence: rpcHttpEvidenceFromPayload(row.heartbeat_payload),
    rpcHttpRoleEvidence: rpcHttpRoleEvidenceFromPayload(row.heartbeat_payload),
    firstProcessingCanary: firstProcessingCanaryFromPayload(row.heartbeat_payload),
    decoderQuarantine: decoderQuarantineFromPayload(row.heartbeat_payload),
    scannerPhaseDiagnostics: scannerPhaseDiagnosticsFromPayload(row.heartbeat_payload, Date.parse(updatedAt)),
  });
}

function hydrationEvidenceFromPayload(
  value: unknown,
  runtimeState: ApiHealth['heartbeat']['runtimeState'],
): Pick<ApiHealth['heartbeat'], 'blockHydration' | 'blockHydrationAdmission' | 'ordinaryRpcBudget' | 'blockResponseMemory'> {
  const legacy = (): Pick<ApiHealth['heartbeat'], 'blockHydration' | 'blockHydrationAdmission'> => ({
    blockHydration: blockHydrationFromPayload(value),
    blockHydrationAdmission: blockHydrationAdmissionFromPayload(value),
  });
  if (typeof value !== 'object' || value === null || isProxy(value) || !isRecord(value)) return legacy();
  const fields = ['blockHydration', 'blockHydrationAdmission', 'ordinaryRpcBudget', 'blockResponseMemory'] as const;
  const descriptors = Object.fromEntries(fields.map((field) => [field, Object.getOwnPropertyDescriptor(value, field)])) as Record<(typeof fields)[number], PropertyDescriptor | undefined>;
  const claimsVersionTwo = (descriptor: PropertyDescriptor | undefined): boolean => {
    if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'object'
      || descriptor.value === null || isProxy(descriptor.value)) return false;
    const version = Object.getOwnPropertyDescriptor(descriptor.value, 'version');
    return version !== undefined && 'value' in version && version.value === 2;
  };
  const v2 = descriptors.ordinaryRpcBudget !== undefined || descriptors.blockResponseMemory !== undefined
    || claimsVersionTwo(descriptors.blockHydration) || claimsVersionTwo(descriptors.blockHydrationAdmission);
  if (!v2) return legacy();
  try {
    const candidate = Object.fromEntries(fields.map((field) => {
      const descriptor = descriptors[field];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
      return [field, descriptor.value];
    }));
    const evidence = snapshotRuntimeTwoGroupHydrationEvidenceV2(candidate);
    const state = runtimeState === 'RUNNING' || runtimeState === 'STOPPED' ? runtimeState : 'OTHER';
    assertTwoGroupHydrationEvidenceForState(evidence, state);
    return evidence;
  } catch {
    return { blockHydration: null, blockHydrationAdmission: null,
      ordinaryRpcBudget: null, blockResponseMemory: null };
  }
}

function scannerPhaseDiagnosticsFromPayload(
  value: unknown,
  updatedAtMs: number,
): ScannerPhaseDiagnosticsV1 | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || isProxy(value) || !isRecord(value)) throw invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'scannerPhaseDiagnostics');
  if (descriptor === undefined) return null;
  if (!descriptor.enumerable || !('value' in descriptor)) throw invalid();
  try {
    const diagnostics = snapshotScannerPhaseDiagnostics(descriptor.value);
    if (diagnostics.sampledAtMs > updatedAtMs) throw invalid();
    return diagnostics;
  } catch {
    throw invalid();
  }
}

function blockHydrationAdmissionFromPayload(value: unknown): ApiBlockHydrationAdmissionMetricsV1 | null {
  try {
    if (typeof value !== 'object' || value === null || isProxy(value) || !isRecord(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'blockHydrationAdmission');
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return null;
    return snapshotRuntimeBlockHydrationAdmissionMetrics(descriptor.value);
  } catch {
    return null;
  }
}

function workerAdmissionFromPayload(value: unknown): ApiWorkerAdmissionMetricsV1 | null {
  if (value === null || value === undefined) return null;
  try {
    if (typeof value !== 'object' || isProxy(value) || !isRecord(value)) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, 'workerAdmission');
    if (descriptor === undefined) return null;
    if (!descriptor.enumerable || !('value' in descriptor)) throw invalid();
    const metrics = exactDataRecord(descriptor.value, [
      'version', 'enabled', 'trackingWindowSeconds', 'claimableBacklogCount',
      'classificationPendingCount', 'oldestClassificationPendingAgeMs',
      'freshMintCount', 'extendedMintCount', 'demotedCount',
    ], 'Worker admission metrics');
    return snapshotRuntimeWorkerAdmissionMetrics(freeze(metrics));
  } catch {
    throw invalid();
  }
}

function workerAdmissionClockFromPayload(
  value: unknown,
  workerAdmission: ApiWorkerAdmissionMetricsV1 | null,
  updatedAtMs: number,
): ApiWorkerAdmissionClockV1 | null {
  if (value === null || value === undefined) return null;
  try {
    if (typeof value !== 'object' || isProxy(value) || !isRecord(value)) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, 'workerAdmissionClock');
    if (descriptor === undefined) return null;
    if (!descriptor.enumerable || !('value' in descriptor)) throw invalid();
    const fields = exactDataRecord(descriptor.value, ['version', 'sampledAtMs'], 'Worker admission clock');
    const clock = snapshotRuntimeWorkerAdmissionClock(freeze(fields));
    if (workerAdmission === null || clock.sampledAtMs > updatedAtMs) throw invalid();
    return clock;
  } catch {
    throw invalid();
  }
}

function decoderQuarantineFromPayload(
  value: unknown,
): ApiDecoderQuarantineMetricsV1 | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || isProxy(value) || !isRecord(value)) throw invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'decoderQuarantine');
  if (descriptor === undefined) return null;
  if (!descriptor.enumerable || !('value' in descriptor)) throw invalid();
  const metrics = exactDataRecord(
    descriptor.value,
    ['version', 'unresolvedCount'],
    'Decoder quarantine metrics',
  );
  if (metrics.version !== 1) throw invalid();
  return freeze({
    version: 1,
    unresolvedCount: nonNegativeSafeNumber(metrics.unresolvedCount),
  });
}

function firstProcessingCanaryFromPayload(
  value: unknown,
): ApiFirstProcessingCanaryEvidenceV1 | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || isProxy(value) || !isRecord(value)) throw invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'firstProcessingCanary');
  if (descriptor === undefined) return null;
  if (!descriptor.enumerable || !('value' in descriptor)) throw invalid();
  try {
    return createFirstProcessingCanaryEvidence(descriptor.value);
  } catch {
    throw invalid();
  }
}

function rpcHttpEvidenceFromPayload(value: unknown): ApiRpcHttpEvidenceV1 | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || isProxy(value) || !isRecord(value)) throw invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'rpcHttpEvidence');
  if (descriptor === undefined) return null;
  if (!descriptor.enumerable || !('value' in descriptor)) throw invalid();
  const evidence = exactDataRecord(descriptor.value, ['version', 'overflowed', 'providers'], 'RPC HTTP evidence');
  if (evidence.version !== 1 || typeof evidence.overflowed !== 'boolean') throw invalid();
  const providers = exactDenseArray(evidence.providers, RPC_PROVIDER_IDS.length, 'RPC HTTP evidence providers');
  if (providers.length !== RPC_PROVIDER_IDS.length) throw invalid();
  return freeze({
    version: 1,
    overflowed: evidence.overflowed,
    providers: freeze(providers.map((provider, index) => {
      const fields = exactDataRecord(provider, ['providerId', 'configured', 'attempts', 'http429Responses'], 'RPC HTTP evidence provider');
      const attempts = nonNegativeSafeNumber(fields.attempts);
      const http429Responses = nonNegativeSafeNumber(fields.http429Responses);
      if (fields.providerId !== RPC_PROVIDER_IDS[index] || typeof fields.configured !== 'boolean'
        || http429Responses > attempts
        || (!fields.configured && (attempts !== 0 || http429Responses !== 0))) throw invalid();
      return freeze({
        providerId: fields.providerId,
        configured: fields.configured,
        attempts,
        http429Responses,
      });
    })) as ApiRpcHttpEvidenceV1['providers'],
  });
}

function rpcHttpRoleEvidenceFromPayload(value: unknown): RuntimeRpcHttpRoleEvidenceV1 | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || isProxy(value) || !isRecord(value)) throw invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'rpcHttpRoleEvidence');
  if (descriptor === undefined) return null;
  if (!descriptor.enumerable || !('value' in descriptor)) throw invalid();
  try {
    return createRuntimeRpcHttpRoleEvidence(descriptor.value);
  } catch {
    throw invalid();
  }
}

function blockHydrationPhaseEvidenceFromPayload(value: unknown): RuntimeBlockHydrationPhaseEvidenceV1 | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || isProxy(value) || !isRecord(value)) throw invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'blockHydrationPhaseEvidence');
  if (descriptor === undefined) return null;
  if (!descriptor.enumerable || !('value' in descriptor)) throw invalid();
  try {
    return createRuntimeBlockHydrationPhaseEvidence(descriptor.value);
  } catch {
    throw invalid();
  }
}

function catchUpAdmissionFromPayload(value: unknown, backlogCount: number): ApiCatchUpAdmissionMetricsV1 | null {
  if (value === null || value === undefined) return null;
  try {
    if (typeof value !== 'object' || isProxy(value) || !isRecord(value)) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, 'catchUpAdmission');
    if (descriptor === undefined) return null;
    if (!descriptor.enumerable || !('value' in descriptor)) throw invalid();
    const metrics = exactDataRecord(descriptor.value, [
      'version', 'enabled', 'providerId', 'scanActive', 'workerClaimReady',
      'actionableBacklogBySource', 'actionableBacklogByPriority',
      'deferredCount', 'ignoredCount', 'quarantinedCount',
    ], 'Catch-up admission metrics');
    const source = exactDataRecord(metrics.actionableBacklogBySource,
      ['websocketOnly', 'catchUpOnly', 'websocketAndCatchUp'], 'Catch-up admission source counts');
    const priority = exactDataRecord(metrics.actionableBacklogByPriority,
      ['normal', 'launchCandidate', 'trackedTrade'], 'Catch-up admission priority counts');
    // The domain snapshotter requires frozen data; reject non-scalars before it can inspect them.
    if (metrics.version !== 1 || typeof metrics.enabled !== 'boolean'
      || typeof metrics.scanActive !== 'boolean' || typeof metrics.workerClaimReady !== 'boolean'
      || (metrics.providerId !== null && !isRpcProviderId(metrics.providerId))) throw invalid();
    for (const count of [
      ...Object.values(source), ...Object.values(priority),
      metrics.deferredCount, metrics.ignoredCount, metrics.quarantinedCount,
    ]) nonNegativeSafeNumber(count);
    return snapshotRuntimeCatchUpAdmissionMetrics(freeze({
      ...metrics,
      actionableBacklogBySource: freeze(source),
      actionableBacklogByPriority: freeze(priority),
    }), backlogCount);
  } catch {
    throw invalid();
  }
}

const BLOCK_HYDRATION_FIELDS = [
  'version', 'enabled', 'callerConcurrency', 'locates', 'hits', 'misses',
  'inFlightJoins', 'fetches', 'forcedRefreshes', 'evictions', 'oversizeBypasses',
  'fetchFailures', 'epochInvalidations', 'retainedEntries', 'retainedBytes',
  'inFlightFetches', 'queuedFetches', 'queueDelayMs',
] as const;

function blockHydrationFromPayload(value: unknown): ApiBlockHydrationMetricsV1 | null {
  if (typeof value !== 'object' || value === null || isProxy(value) || !isRecord(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'blockHydration');
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return null;
  const candidate: unknown = descriptor.value as unknown;
  try {
    const metrics = exactDataRecord(candidate, BLOCK_HYDRATION_FIELDS, 'Block hydration metrics');
    if (metrics.version !== 1 || typeof metrics.enabled !== 'boolean'
      || metrics.callerConcurrency !== 1) throw invalid();
    const count = (field: string): number => nonNegativeSafeNumber(metrics[field]);
    const queue = exactDataRecord(metrics.queueDelayMs, ['last', 'maximum'], 'Block hydration queue delay');
    const last = nullableSafeNumber(queue.last);
    const maximum = nullableSafeNumber(queue.maximum);
    if ((last !== null && last < 0) || (maximum !== null && maximum < 0)
      || (last !== null && maximum !== null && last > maximum)) throw invalid();
    return freeze({
      version: 1, enabled: metrics.enabled, callerConcurrency: 1,
      locates: count('locates'), hits: count('hits'), misses: count('misses'),
      inFlightJoins: count('inFlightJoins'), fetches: count('fetches'),
      forcedRefreshes: count('forcedRefreshes'), evictions: count('evictions'),
      oversizeBypasses: count('oversizeBypasses'), fetchFailures: count('fetchFailures'),
      epochInvalidations: count('epochInvalidations'),
      retainedEntries: count('retainedEntries'), retainedBytes: count('retainedBytes'),
      inFlightFetches: count('inFlightFetches'), queuedFetches: count('queuedFetches'),
      queueDelayMs: freeze({ last, maximum }),
    });
  } catch {
    return null;
  }
}

function canonicalHealthRowPresent(value: unknown): boolean {
  if (value === null) return false;
  if (value !== LISTENER_SERVICE_KEY) throw invalid();
  return true;
}

function inactiveWebSocketHealth(): ApiWebSocketHealth {
  return freeze({
    version: 1,
    supervision: 'INACTIVE',
    state: 'STOPPED',
    phase: 'STOPPED',
    providerId: null,
    candidateProviderId: null,
    updatedAt: null,
    heartbeatAt: null,
    acknowledgedAt: null,
    lastObservation: null,
    disconnect: null,
    recovery: freeze({
      status: 'NOT_REQUIRED', startedAt: null, completedAt: null, reasonCode: null,
    }),
  });
}

function webSocketHealthFromRow(row: Record<string, unknown>): ApiWebSocketHealth {
  const snapshot = createWebSocketHealthSnapshot({
    payloadVersion: safeNumber(row.payload_version),
    supervision: row.supervision,
    ownerGeneration: databaseBigInt(row.owner_generation),
    revision: databaseBigInt(row.revision),
    activeSessionGeneration: nullableDatabaseBigInt(row.active_session_generation),
    candidateSessionGeneration: nullableDatabaseBigInt(row.candidate_session_generation),
    providerId: row.provider_id,
    candidateProviderId: row.candidate_provider_id,
    phase: row.phase,
    acknowledgedAtMs: nullableWebSocketTimestampMs(row.acknowledged_at),
    lastObservation: webSocketObservationFromRow(row),
    disconnect: webSocketDisconnectFromRow(row),
    recovery: {
      status: row.recovery_status,
      startedAtMs: nullableWebSocketTimestampMs(row.recovery_started_at),
      completedAtMs: nullableWebSocketTimestampMs(row.recovery_completed_at),
      reasonCode: row.recovery_reason_code,
    },
    heartbeatAtMs: nullableWebSocketTimestampMs(row.heartbeat_at),
    updatedAtMs: webSocketTimestampMs(row.updated_at),
    evidencePurgeAfterMs: nullableWebSocketTimestampMs(row.evidence_purge_after),
  });
  return projectWebSocketHealth(snapshot);
}

function webSocketObservationFromRow(
  row: Record<string, unknown>,
): Readonly<{ observedAtMs: number; slot: bigint }> | null {
  if (row.last_observation_at === null && row.last_observation_slot === null) return null;
  return {
    observedAtMs: webSocketTimestampMs(row.last_observation_at),
    slot: databaseNumericInteger(row.last_observation_slot),
  };
}

function webSocketDisconnectFromRow(
  row: Record<string, unknown>,
): Readonly<{ occurredAtMs: number; reasonCode: unknown }> | null {
  if (row.disconnect_occurred_at === null && row.disconnect_reason_code === null) return null;
  return {
    occurredAtMs: webSocketTimestampMs(row.disconnect_occurred_at),
    reasonCode: row.disconnect_reason_code,
  };
}

function projectWebSocketHealth(snapshot: WebSocketHealthSnapshot): ApiWebSocketHealth {
  return freeze({
    version: 1,
    supervision: snapshot.supervision,
    state: publicWebSocketState(snapshot.phase),
    phase: snapshot.phase,
    providerId: snapshot.providerId,
    candidateProviderId: snapshot.candidateProviderId,
    updatedAt: new Date(snapshot.updatedAtMs).toISOString(),
    heartbeatAt: nullableIsoFromMs(snapshot.heartbeatAtMs),
    acknowledgedAt: nullableIsoFromMs(snapshot.acknowledgedAtMs),
    lastObservation: snapshot.lastObservation === null ? null : freeze({
      observedAt: new Date(snapshot.lastObservation.observedAtMs).toISOString(),
      slot: snapshot.lastObservation.slot.toString(),
    }),
    disconnect: snapshot.disconnect === null ? null : freeze({
      occurredAt: new Date(snapshot.disconnect.occurredAtMs).toISOString(),
      reasonCode: snapshot.disconnect.reasonCode,
    }),
    recovery: freeze({
      status: snapshot.recovery.status,
      startedAt: nullableIsoFromMs(snapshot.recovery.startedAtMs),
      completedAt: nullableIsoFromMs(snapshot.recovery.completedAtMs),
      reasonCode: snapshot.recovery.reasonCode,
    }),
  });
}

function databaseBigInt(value: unknown): bigint {
  return BigInt(decimal(value));
}

function nullableDatabaseBigInt(value: unknown): bigint | null {
  return value === null ? null : databaseBigInt(value);
}

function databaseNumericInteger(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.0+)?$/u.test(value)) throw invalid();
  return BigInt(value.split('.')[0] ?? value);
}

function webSocketTimestampMs(value: unknown): number {
  return timestamp(value).getTime();
}

function nullableWebSocketTimestampMs(value: unknown): number | null {
  return value === null ? null : webSocketTimestampMs(value);
}

function nullableIsoFromMs(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function listenerRuntimeState(value: unknown): ListenerRuntimeState {
  if (!LISTENER_RUNTIME_STATES.includes(value as ListenerRuntimeState)) throw invalid();
  return value as ListenerRuntimeState;
}

function pipelineState(provider: ApiProjectionPipelineStateProvider): ApiProjectionPipelineState {
  const value: unknown = provider();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 5
    || !keys.includes('httpAvailable')
    || !keys.includes('pumpfun')
    || !keys.includes('pumpswap')
    || !keys.includes('qualification')
    || !keys.includes('paperDecision')) throw invalid();
  const httpAvailable = pipelineValue(value, 'httpAvailable');
  const pumpfun = pipelineValue(value, 'pumpfun');
  const pumpswap = pipelineValue(value, 'pumpswap');
  const qualification = pipelineValue(value, 'qualification');
  const paperDecision = pipelineValue(value, 'paperDecision');
  if (typeof httpAvailable !== 'boolean'
    || !isPipelineRuntimeState(pumpfun)
    || !isPipelineRuntimeState(pumpswap)
    || !isPipelineRuntimeState(qualification)
    || !isPipelineRuntimeState(paperDecision)) throw invalid();
  return freeze({ httpAvailable, pumpfun, pumpswap, qualification, paperDecision });
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
    }),
    qualification,
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
