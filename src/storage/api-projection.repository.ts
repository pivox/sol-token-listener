import {
  toApiDomainPayload,
  type ApiHealth,
  type ApiHolders,
  type ApiLaunchDetail,
  type ApiLaunchSummary,
  type ApiPage,
  type ApiPaperPosition,
  type ApiQualification,
  type ApiSocial,
  type ApiTimelineEntry,
} from '../api/contracts.js';
import {
  encodeLaunchCursor,
  encodePaperPositionCursor,
  type LaunchPagePosition,
  type PaperPositionPagePosition,
} from '../api/cursor.js';
import { DOMAIN_EVENT_TYPES } from '../domain/events.js';
import { LAUNCH_STATUSES } from '../domain/launch-status.js';
import { QUALIFICATION_REASON_CODES } from '../domain/qualification-reasons.js';
import { QUALIFICATION_SIGNAL_KEYS } from '../domain/qualification.js';
import type { ApiProjectionRepository, PageRequest } from '../ports/api-projection-repository.js';
import { getDatabasePool } from './database.js';

export interface Queryable {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

export interface ApiProjectionPipelineState {
  readonly httpAvailable: boolean;
  readonly pumpfun: ApiHealth['pipeline']['pumpfun'];
  readonly pumpswap: ApiHealth['pipeline']['pumpswap'];
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
  status: 'NOT_AVAILABLE', snapshots: Object.freeze([] as []), clusters: Object.freeze([] as []),
});

export class PostgresApiProjectionRepository implements ApiProjectionRepository {
  public constructor(
    private readonly database: Queryable = getDatabasePool(),
    private readonly clock: () => Date = () => new Date(),
    private readonly pipeline: ApiProjectionPipelineState = {
      httpAvailable: false,
      pumpfun: 'STOPPED',
      pumpswap: 'STOPPED',
    },
  ) {}

  public async listLaunches(
    request: PageRequest<LaunchPagePosition>,
  ): Promise<ApiPage<ApiLaunchSummary>> {
    const limit = pageLimit(request.limit);
    const values = request.after === null
      ? [limit + 1]
      : [dateFromMs(request.after.detectedAtMs), text(request.after.mint), limit + 1];
    const after = request.after === null ? '' : `
      AND (launch.detected_at < $1 OR (launch.detected_at = $1 AND launch.mint > $2))`;
    const limitParameter = request.after === null ? '$1' : '$3';
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
    const launches = await this.findLaunches(text(mint));
    const launch = launches[0];
    if (launch === undefined) return null;
    const projections = await this.loadLaunchProjections([text(mint)]);
    return assembleLaunchDetail(launch, projections);
  }

  public async listLaunchEvents(mint: string): Promise<readonly ApiTimelineEntry[]> {
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
      FROM timeline
      ORDER BY slot, transaction_index, instruction_index, inner_sort, id`,
      [text(mint)],
    );
    return freeze(result.rows.map(toTimelineEntry));
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
    return (await this.findLaunches(text(mint))).length === 0 ? null : NOT_AVAILABLE_HOLDERS;
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
          entry_trade.fees_raw AS entry_fees_raw
       FROM paper_positions AS position
       JOIN paper_trades AS entry_trade ON entry_trade.trade_id = position.entry_trade_id${after}
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
    const [database, checkpoints, heartbeats] = await Promise.all([
      this.database.query('SELECT 1 AS available'),
      this.database.query(
        `SELECT checkpoint_key, slot FROM processing_checkpoints
         WHERE checkpoint_key = ANY($1)`,
        [['launchpad', 'market']],
      ),
      this.database.query(
        `SELECT updated_at, last_http_slot, last_websocket_slot,
            last_finalized_slot, last_signature, pending_transactions, active_sessions
         FROM listener_heartbeats ORDER BY updated_at DESC LIMIT 1`,
      ),
    ]);
    const dbAvailable = database.rows.length > 0;
    const checkpoint = new Map(checkpoints.rows.map((row) => [text(row.checkpoint_key), decimal(row.slot)]));
    const row = heartbeats.rows[0];
    const heartbeat = row === undefined ? freeze({
      startedAt: observedAt.toISOString(), updatedAt: observedAt.toISOString(),
      lastHttpSlot: null, lastWebsocketSlot: null, lastFinalizedSlot: null, lastSignature: null,
      pendingTransactions: 0, activeSessions: 0,
    }) : freeze({
      startedAt: timestamp(row.updated_at).toISOString(), updatedAt: timestamp(row.updated_at).toISOString(),
      lastHttpSlot: nullableDecimal(row.last_http_slot), lastWebsocketSlot: nullableDecimal(row.last_websocket_slot),
      lastFinalizedSlot: nullableDecimal(row.last_finalized_slot), lastSignature: nullableText(row.last_signature),
      pendingTransactions: safeNumber(row.pending_transactions), activeSessions: safeNumber(row.active_sessions),
    });
    const lagSlots = heartbeat.lastHttpSlot === null || heartbeat.lastFinalizedSlot === null
      ? null : (BigInt(heartbeat.lastHttpSlot) - BigInt(heartbeat.lastFinalizedSlot)).toString();
    const degraded = !dbAvailable || !this.pipeline.httpAvailable
      || this.pipeline.pumpfun === 'DEGRADED' || this.pipeline.pumpfun === 'STOPPED'
      || this.pipeline.pumpswap === 'DEGRADED' || this.pipeline.pumpswap === 'STOPPED';
    return freeze({
      status: degraded ? 'DEGRADED' : 'OK', observedAt: observedAt.toISOString(),
      postgresql: freeze({ status: dbAvailable ? 'AVAILABLE' : 'UNAVAILABLE' }),
      http: freeze({ status: this.pipeline.httpAvailable ? 'AVAILABLE' : 'UNAVAILABLE' }),
      pipeline: freeze({ pumpfun: this.pipeline.pumpfun, pumpswap: this.pipeline.pumpswap }),
      checkpoints: freeze({ launchpad: checkpoint.get('launchpad') ?? null, market: checkpoint.get('market') ?? null }),
      heartbeat, lagSlots,
    });
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
    const [metadata, curves, markets] = await Promise.all([
      this.database.query(
        `SELECT DISTINCT ON (snapshot.mint) snapshot.mint, snapshot.metadata
         FROM token_metadata_snapshots AS snapshot
         WHERE snapshot.mint = ANY($1) AND snapshot.resolution_status = 'resolved'
         ORDER BY snapshot.mint, snapshot.fetched_at DESC, snapshot.snapshot_id DESC`, [mints],
      ),
      this.database.query(
        `SELECT DISTINCT ON (curve.mint) curve.mint, curve.quote_mint, curve.quote_decimals,
            curve.real_base_reserves_raw, curve.real_quote_reserves_raw, curve.virtual_quote_reserves_raw
         FROM bonding_curve_snapshots AS curve
         WHERE curve.mint = ANY($1) AND curve.confirmation_status <> 'orphaned'
         ORDER BY curve.mint, curve.slot DESC, curve.transaction_index DESC,
            curve.instruction_index DESC, COALESCE(curve.inner_instruction_index, -1) DESC,
            curve.snapshot_id DESC`, [mints],
      ),
      this.database.query(
        `SELECT DISTINCT ON (migration.mint) migration.mint, migration.quote_mint,
            migration.quote_decimals, pool.payload AS pool_payload,
            reserve.base_reserves_raw, reserve.effective_quote_reserves_raw
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
           migration.migration_id DESC`, [mints],
      ),
    ]);
    return {
      metadata: rowsByMint(metadata.rows), curves: rowsByMint(curves.rows), markets: rowsByMint(markets.rows),
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
  const quote = quoteAsset(row.quote_assets);
  const quoteMint = nullableText(curve?.quote_mint) ?? nullableText(market?.quote_mint) ?? quote.mint;
  const quoteDecimals = nullableSafeNumber(curve?.quote_decimals)
    ?? nullableSafeNumber(market?.quote_decimals) ?? quote.decimals;
  return freeze({
    mint, detectedAt: timestamp(row.detected_at).toISOString(), detectedSlot: decimal(row.created_slot),
    status: launchStatus(row.current_state), name: metadataText(metadata, 'name'), symbol: metadataText(metadata, 'symbol'),
    quoteMint, quoteDecimals,
    marketCapQuote: nullableDecimal(market?.effective_quote_reserves_raw)
      ?? nullableDecimal(curve?.virtual_quote_reserves_raw),
    liquidityQuote: nullableDecimal(market?.effective_quote_reserves_raw)
      ?? nullableDecimal(curve?.real_quote_reserves_raw),
  });
}

function assembleLaunchDetail(row: LaunchRow, projections: LaunchProjections): ApiLaunchDetail {
  const summary = assembleLaunchSummary(row, projections);
  const curve = projections.curves.get(summary.mint);
  const market = projections.markets.get(summary.mint);
  return freeze({
    ...summary, creator: text(row.creator), tokenProgram: text(row.token_program), launchpad: text(row.launchpad),
    initialTokenAmount: nullableDecimal(row.initial_token_amount), initialQuoteAmount: nullableDecimal(row.initial_quote_amount),
    reserveBase: nullableDecimal(market?.base_reserves_raw) ?? nullableDecimal(curve?.real_base_reserves_raw),
    reserveQuote: nullableDecimal(market?.effective_quote_reserves_raw) ?? nullableDecimal(curve?.real_quote_reserves_raw),
    feeBps: null, social: NOT_AVAILABLE_SOCIAL, holders: NOT_AVAILABLE_HOLDERS,
  });
}

function toTimelineEntry(row: Record<string, unknown>): ApiTimelineEntry {
  try {
    return freeze({
      id: text(row.id), type: validated(row.type, DOMAIN_EVENT_TYPES) as ApiTimelineEntry['type'], occurredAt: timestamp(row.occurred_at).toISOString(),
      slot: nullableDecimal(row.slot), confirmationStatus: validated(row.confirmation_status, CONFIRMATION_STATUSES) as ApiTimelineEntry['confirmationStatus'],
      payloadVersion: positiveSafeNumber(row.payload_version), payload: toApiDomainPayload(json(row.payload)),
    });
  } catch (error) {
    throw projectionError(error);
  }
}

function qualification(value: unknown): ApiQualification {
  const payload = json(value);
  if (!isRecord(payload)) throw invalid();
  const ruleSet = record(payload.ruleSet);
  const scores = record(payload.scores);
  const evaluatedAtMs = safeNumber(payload.evaluatedAtMs);
  return freeze({
    ruleSet: freeze({ id: text(ruleSet.id), version: positiveSafeNumber(ruleSet.version),
      status: qualificationRuleSetStatus(ruleSet.status), minimumTotalScore: safeNumber(ruleSet.minimumTotalScore) }),
    scores: freeze({ preparation: score(scores.preparation), socialAuthenticity: score(scores.socialAuthenticity),
      onchainHealth: score(scores.onchainHealth), total: score(scores.total) }),
    evidence: freeze(array(payload.evidence).map((item) => {
      const itemRecord = record(item);
      return freeze({ signal: validated(itemRecord.signal, QUALIFICATION_SIGNAL_KEYS) as ApiQualification['evidence'][number]['signal'],
        status: validated(itemRecord.status, QUALIFICATION_EVIDENCE_STATUSES) as ApiQualification['evidence'][number]['status'], message: text(itemRecord.message) });
    })),
    blockers: freeze(array(payload.blockers).map((item) => {
      const itemRecord = record(item);
      return freeze({ code: validated(itemRecord.code, QUALIFICATION_REASON_CODES) as ApiQualification['blockers'][number]['code'], message: text(itemRecord.message) });
    })),
    verdict: validated(payload.verdict, QUALIFICATION_VERDICTS) as ApiQualification['verdict'], evaluatedAt: dateFromMs(evaluatedAtMs).toISOString(),
  });
}

function score(value: unknown): ApiQualification['scores']['total'] {
  const item = record(value);
  return freeze({ score: safeNumber(item.score), maximum: safeNumber(item.maximum) });
}

function toPaperPosition(row: Record<string, unknown>): ApiPaperPosition {
  return freeze({
    id: text(row.position_id), mint: text(row.mint), status: validated(row.status, PAPER_POSITION_STATUSES) as ApiPaperPosition['status'],
    openedAt: timestamp(row.opened_at).toISOString(), closedAt: nullableTimestamp(row.closed_at), quoteMint: text(row.quote_mint),
    quantity: decimal(row.remaining_base_raw), entryQuoteAmount: decimal(row.quote_cost_raw),
    exitQuoteAmount: nullableDecimal(row.quote_proceeds_raw), realizedPnlQuote: nullableSignedDecimal(row.net_pnl_quote_raw),
    estimatedFeesQuote: decimal(row.entry_fees_raw),
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
  if (!Number.isSafeInteger(value) || value < 0) throw invalid();
  return validDate(new Date(value));
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

function safeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalid();
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

function pageLimit(value: number): number {
  return positiveSafeNumber(value);
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
