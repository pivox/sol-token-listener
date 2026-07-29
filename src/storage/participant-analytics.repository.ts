import { createHash } from 'node:crypto';
import {
  assertValidParticipantAnalyticsInput,
  compareParticipantTrades,
  type ActiveParticipantConfirmationStatus,
  type ParticipantAnalyticsInput,
  type ParticipantAnalyticsLaunch,
  type ParticipantAnalyticsProjection,
  type ParticipantAnalyticsTrade,
} from '../domain/participant-analytics.js';
import type { ParticipantAnalyticsDerivedEventV1 } from '../domain/participant-analytics-events.js';
import type { ChainCursor, QuoteAsset, TokenProgramKind } from '../domain/types.js';
import type {
  ParticipantAnalyticsRepository,
  ParticipantAnalyticsTransaction,
} from '../ports/participant-analytics-repository.js';
import { toJsonValue } from '../utils/json.js';

interface QueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number | null;
}

interface ParticipantAnalyticsClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(): void;
}

export interface ParticipantAnalyticsPool {
  connect(): Promise<ParticipantAnalyticsClient>;
}

export class ParticipantAnalyticsDataError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ParticipantAnalyticsDataError';
  }
}

export class PostgresParticipantAnalyticsRepository
implements ParticipantAnalyticsRepository {
  public constructor(private readonly database: ParticipantAnalyticsPool) {}

  public async transact<TResult>(
    mint: string,
    operation: (
      transaction: ParticipantAnalyticsTransaction,
    ) => Promise<TResult>,
  ): Promise<TResult> {
    if (mint.length === 0) throw new TypeError('Participant analytics mint is required.');
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('participant-analytics:' || $1, 0))",
        [mint],
      );
      const result = await operation(new PostgresParticipantAnalyticsTransaction(client, mint));
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

class PostgresParticipantAnalyticsTransaction
implements ParticipantAnalyticsTransaction {
  public constructor(
    private readonly client: ParticipantAnalyticsClient,
    private readonly lockedMint: string,
  ) {}

  public async loadCanonicalInput(mint: string): Promise<ParticipantAnalyticsInput | null> {
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
    const tradeResult = await this.client.query(
      `SELECT event.event_id, trade.trade_id, trade.mint, event.signature,
          event.slot, event.transaction_index, event.instruction_index,
          event.inner_instruction_index, event.confirmation_status, event.observed_at,
          trade.trade_kind, trade.trader, trade.base_amount_raw, trade.quote_amount_raw,
          trade.quote_mint, trade.quote_decimals, trade.quote_token_program
       FROM launch_trades AS trade
       JOIN domain_events AS event
         ON event.mint = trade.mint
        AND event.type = 'BondingCurveTradeObserved'
        AND event.slot = trade.slot
        AND event.transaction_index = trade.transaction_index
        AND event.instruction_index = trade.instruction_index
        AND event.inner_instruction_index IS NOT DISTINCT FROM trade.inner_instruction_index
       WHERE trade.mint = $1
         AND trade.confirmation_status <> 'orphaned'
         AND event.confirmation_status <> 'orphaned'
       ORDER BY event.slot, event.transaction_index, event.instruction_index,
          COALESCE(event.inner_instruction_index, -1), trade.trade_id`,
      [mint],
    );
    const trades = Object.freeze(
      tradeResult.rows.map(tradeFromRow).sort(compareParticipantTrades),
    );
    const input: ParticipantAnalyticsInput = Object.freeze({
      launch,
      trades,
      inputFingerprint: fingerprint(launch, trades),
    });
    assertValidParticipantAnalyticsInput(input);
    return input;
  }

  public async replaceProjection(
    projection: ParticipantAnalyticsProjection,
    events: readonly ParticipantAnalyticsDerivedEventV1[],
  ): Promise<void> {
    this.assertLockedMint(projection.launch.mint);
    const profileEvent = events.find((event) => event.type === 'CreatorProfileUpdated');
    const holderEvent = events.find((event) => event.type === 'HolderDistributionUpdated');
    if (profileEvent === undefined || holderEvent === undefined || events.length !== 2) {
      throw new ParticipantAnalyticsDataError('Both participant analytics events are required.');
    }
    for (const event of events) await this.upsertDomainEvent(event);
    await this.upsertCreatorProfile(projection, profileEvent.id);
    await this.client.query(
      'DELETE FROM observed_wallet_positions WHERE mint = $1',
      [projection.launch.mint],
    );
    await this.insertPositions(projection);
    await this.insertHolderSnapshot(projection, holderEvent.id);
  }

  private async upsertDomainEvent(event: ParticipantAnalyticsDerivedEventV1): Promise<void> {
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
      WHERE (
        domain_events.confirmation_status,
        domain_events.observed_at,
        domain_events.payload_version,
        domain_events.payload,
        domain_events.terminal_at,
        domain_events.purge_after
      ) IS DISTINCT FROM (
        EXCLUDED.confirmation_status,
        EXCLUDED.observed_at,
        EXCLUDED.payload_version,
        EXCLUDED.payload,
        EXCLUDED.terminal_at,
        EXCLUDED.purge_after
      )`,
      [
        event.id, event.type, event.mint, event.source, event.program,
        event.signature, event.cursor.slot.toString(),
        event.cursor.transactionIndex, event.cursor.instructionIndex,
        event.cursor.innerInstructionIndex, event.confirmationStatus,
        new Date(event.observedAtMs), event.payloadVersion, toJsonValue(event.payload),
      ],
    );
  }

  private async upsertCreatorProfile(
    projection: ParticipantAnalyticsProjection,
    profileEventId: string,
  ): Promise<void> {
    const { profile, asOf } = projection;
    await this.client.query(
      `INSERT INTO creator_profiles (
        mint, creator, payload_version, input_fingerprint, profile_event_id,
        as_of_slot, as_of_transaction_index, as_of_instruction_index,
        as_of_inner_instruction_index, confirmation_status,
        total_bought_base_raw, total_sold_base_raw, observed_net_base_raw,
        has_sold, payload, observed_at, purge_after
      )
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
        launch.purge_after
      FROM token_launches AS launch
      WHERE launch.mint = $1
      ON CONFLICT (mint) DO UPDATE SET
        creator = EXCLUDED.creator,
        payload_version = EXCLUDED.payload_version,
        input_fingerprint = EXCLUDED.input_fingerprint,
        profile_event_id = EXCLUDED.profile_event_id,
        as_of_slot = EXCLUDED.as_of_slot,
        as_of_transaction_index = EXCLUDED.as_of_transaction_index,
        as_of_instruction_index = EXCLUDED.as_of_instruction_index,
        as_of_inner_instruction_index = EXCLUDED.as_of_inner_instruction_index,
        confirmation_status = EXCLUDED.confirmation_status,
        total_bought_base_raw = EXCLUDED.total_bought_base_raw,
        total_sold_base_raw = EXCLUDED.total_sold_base_raw,
        observed_net_base_raw = EXCLUDED.observed_net_base_raw,
        has_sold = EXCLUDED.has_sold,
        payload = EXCLUDED.payload,
        observed_at = EXCLUDED.observed_at,
        purge_after = EXCLUDED.purge_after`,
      [
        profile.mint, profile.creator, profile.payloadVersion,
        projection.inputFingerprint, profileEventId, asOf.cursor.slot.toString(),
        asOf.cursor.transactionIndex, asOf.cursor.instructionIndex,
        asOf.cursor.innerInstructionIndex, projection.confirmationStatus,
        profile.totalBoughtBaseRaw.toString(), profile.totalSoldBaseRaw.toString(),
        profile.observedNetBaseRaw.toString(), profile.hasSold,
        toJsonValue(profile), new Date(asOf.observedAtMs),
      ],
    );
  }

  private async insertPositions(
    projection: ParticipantAnalyticsProjection,
  ): Promise<void> {
    if (projection.distribution.positions.length === 0) return;
    const values: unknown[] = [];
    const rows = projection.distribution.positions.map((position, rowIndex) => {
      const offset = rowIndex * 18;
      values.push(
        projection.launch.mint, position.wallet, position.isCreator,
        projection.inputFingerprint, position.buyCount, position.sellCount,
        position.boughtBaseRaw.toString(), position.soldBaseRaw.toString(),
        position.observedNetBaseRaw.toString(),
        position.firstObservedCursor.slot.toString(),
        position.firstObservedCursor.transactionIndex,
        position.firstObservedCursor.instructionIndex,
        position.firstObservedCursor.innerInstructionIndex,
        position.lastObservedCursor.slot.toString(),
        position.lastObservedCursor.transactionIndex,
        position.lastObservedCursor.instructionIndex,
        position.lastObservedCursor.innerInstructionIndex,
        toJsonValue(position),
      );
      return `(${Array.from({ length: 18 }, (_, index) => `$${offset + index + 1}`).join(',')})`;
    });
    await this.client.query(
      `WITH position_values (
        mint, wallet, is_creator, input_fingerprint, buy_count, sell_count,
        bought_base_raw, sold_base_raw, observed_net_base_raw,
        first_slot, first_transaction_index, first_instruction_index,
        first_inner_instruction_index, last_slot, last_transaction_index,
        last_instruction_index, last_inner_instruction_index, payload
      ) AS (VALUES ${rows.join(',')})
      INSERT INTO observed_wallet_positions (
        mint, wallet, is_creator, input_fingerprint, buy_count, sell_count,
        bought_base_raw, sold_base_raw, observed_net_base_raw,
        first_slot, first_transaction_index, first_instruction_index,
        first_inner_instruction_index, last_slot, last_transaction_index,
        last_instruction_index, last_inner_instruction_index, quote_flows,
        payload, purge_after
      )
      SELECT value.mint, value.wallet, value.is_creator::boolean,
        value.input_fingerprint, value.buy_count::integer,
        value.sell_count::integer, value.bought_base_raw::numeric,
        value.sold_base_raw::numeric, value.observed_net_base_raw::numeric,
        value.first_slot::numeric, value.first_transaction_index::integer,
        value.first_instruction_index::integer,
        value.first_inner_instruction_index::integer,
        value.last_slot::numeric, value.last_transaction_index::integer,
        value.last_instruction_index::integer,
        value.last_inner_instruction_index::integer,
        (value.payload::jsonb)->'quoteFlows',
        value.payload::jsonb, launch.purge_after
      FROM position_values AS value
      JOIN token_launches AS launch ON launch.mint = value.mint`,
      values,
    );
  }

  private async insertHolderSnapshot(
    projection: ParticipantAnalyticsProjection,
    holderEventId: string,
  ): Promise<void> {
    const { distribution, asOf } = projection;
    await this.client.query(
      `INSERT INTO token_holders_snapshots (
        snapshot_id, mint, input_fingerprint, holder_event_id, payload_version,
        as_of_slot, as_of_transaction_index, as_of_instruction_index,
        as_of_inner_instruction_index, confirmation_status,
        total_positive_net_base_raw, top1_bps, top5_bps, top10_bps,
        creator_bps, unique_known_buyers, unique_external_buyers,
        positive_position_count, unknown_trader_trade_count, payload,
        observed_at, purge_after
      )
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
        $17,$18,$19,$20,$21,launch.purge_after
      FROM token_launches AS launch
      WHERE launch.mint = $2
      ON CONFLICT (mint, input_fingerprint) DO NOTHING`,
      [
        `holder_snapshot_${projection.inputFingerprint}`,
        projection.launch.mint, projection.inputFingerprint, holderEventId,
        distribution.payloadVersion, asOf.cursor.slot.toString(),
        asOf.cursor.transactionIndex, asOf.cursor.instructionIndex,
        asOf.cursor.innerInstructionIndex, projection.confirmationStatus,
        distribution.totalPositiveNetBaseRaw.toString(),
        distribution.top1Bps.toString(), distribution.top5Bps.toString(),
        distribution.top10Bps.toString(), distribution.creatorBps.toString(),
        distribution.uniqueKnownBuyers, distribution.uniqueExternalBuyers,
        distribution.positivePositionCount,
        distribution.unknownTraderTradeCount, toJsonValue(distribution),
        new Date(asOf.observedAtMs),
      ],
    );
  }

  private assertLockedMint(mint: string): void {
    if (mint !== this.lockedMint) {
      throw new ParticipantAnalyticsDataError('Analytics transaction mint does not match its lock.');
    }
  }
}

function launchFromRow(row: Record<string, unknown>): ParticipantAnalyticsLaunch {
  return Object.freeze({
    eventId: text(row.event_id),
    mint: text(row.mint),
    creator: text(row.creator),
    source: text(row.source),
    program: text(row.program),
    signature: text(row.signature),
    cursor: cursorFromRow(row),
    confirmationStatus: confirmation(row.confirmation_status),
    observedAtMs: timestamp(row.observed_at),
  });
}

function tradeFromRow(row: Record<string, unknown>): ParticipantAnalyticsTrade {
  return Object.freeze({
    eventId: text(row.event_id),
    tradeId: text(row.trade_id),
    launchMint: text(row.mint),
    signature: text(row.signature),
    cursor: cursorFromRow(row),
    confirmationStatus: confirmation(row.confirmation_status),
    observedAtMs: timestamp(row.observed_at),
    kind: tradeKind(row.trade_kind),
    trader: nullableText(row.trader),
    baseAmountRaw: unsignedBigInt(row.base_amount_raw),
    quoteAmountRaw: unsignedBigInt(row.quote_amount_raw),
    quoteAsset: quoteAssetFromRow(row),
  });
}

function cursorFromRow(row: Record<string, unknown>): ChainCursor {
  return Object.freeze({
    slot: unsignedBigInt(row.slot),
    transactionIndex: index(row.transaction_index),
    instructionIndex: index(row.instruction_index),
    innerInstructionIndex: nullableIndex(row.inner_instruction_index),
  });
}

function quoteAssetFromRow(row: Record<string, unknown>): QuoteAsset {
  return Object.freeze({
    mint: text(row.quote_mint),
    decimals: decimals(row.quote_decimals),
    tokenProgram: tokenProgram(row.quote_token_program),
  });
}

function fingerprint(
  launch: ParticipantAnalyticsLaunch,
  trades: readonly ParticipantAnalyticsTrade[],
): string {
  const fields: (string | number | bigint | null)[] = [
    launch.eventId, launch.mint, launch.creator, launch.source, launch.program,
    launch.signature, ...cursorFields(launch.cursor), launch.confirmationStatus,
    launch.observedAtMs,
  ];
  for (const trade of trades) fields.push(
    trade.eventId, trade.tradeId, trade.launchMint, trade.signature,
    ...cursorFields(trade.cursor), trade.confirmationStatus, trade.observedAtMs,
    trade.kind, trade.trader, trade.baseAmountRaw, trade.quoteAmountRaw,
    trade.quoteAsset.mint, trade.quoteAsset.decimals, trade.quoteAsset.tokenProgram,
  );
  const canonical = fields.map((field) => {
    const value = field === null ? '<null>' : String(field);
    return `${Buffer.byteLength(value, 'utf8')}:${value}`;
  }).join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

function cursorFields(cursor: ChainCursor): readonly (bigint | number | null)[] {
  return [
    cursor.slot,
    cursor.transactionIndex,
    cursor.instructionIndex,
    cursor.innerInstructionIndex,
  ];
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function unsignedBigInt(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) throw invalid();
  return BigInt(value);
}

function index(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0 || Object.is(value, -0)) {
    throw invalid();
  }
  return value;
}

function nullableIndex(value: unknown): number | null {
  return value === null ? null : index(value);
}

function decimals(value: unknown): number {
  const result = index(value);
  if (result > 255) throw invalid();
  return result;
}

function timestamp(value: unknown): number {
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime()) || value.getTime() < 0) {
    throw invalid();
  }
  return value.getTime();
}

function confirmation(value: unknown): ActiveParticipantConfirmationStatus {
  if (value !== 'processed' && value !== 'confirmed' && value !== 'finalized') throw invalid();
  return value;
}

function tradeKind(value: unknown): 'BUY' | 'SELL' {
  if (value !== 'BUY' && value !== 'SELL') throw invalid();
  return value;
}

function tokenProgram(value: unknown): TokenProgramKind {
  if (value !== 'SPL_TOKEN' && value !== 'TOKEN_2022') throw invalid();
  return value;
}

function invalid(): ParticipantAnalyticsDataError {
  return new ParticipantAnalyticsDataError('Stored participant analytics data is invalid.');
}
