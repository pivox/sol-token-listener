import type {
  PaperPosition,
  PaperPositionClosedEventV1,
  PaperPositionOpenedEventV1,
  PaperStrategyIdentity,
  PaperTrade,
} from '../domain/paper-trading.js';
import { reconcileConfirmationStatus } from '../domain/confirmation-status.js';
import type { ChainConfirmationStatus } from '../domain/types.js';
import type {
  PaperConfirmationObservation,
  PaperTradingRepository,
  PaperTradingTransaction,
} from '../ports/paper-trading-repository.js';
import { fromJsonValue, toJsonValue } from '../utils/json.js';
import { getDatabasePool } from './database.js';

interface QueryResultLike {
  readonly rows: readonly unknown[];
}

interface QueryClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResultLike>;
  release(): void;
}

interface Connectable {
  connect(): Promise<QueryClient>;
}

export class PostgresPaperTradingRepository implements PaperTradingRepository {
  public constructor(private readonly pool: Connectable = getDatabasePool()) {}

  public async transact<T>(
    operation: (transaction: PaperTradingTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(new PostgresPaperTradingTransaction(client));
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

class PostgresPaperTradingTransaction implements PaperTradingTransaction {
  public constructor(private readonly client: QueryClient) {}

  public async findPosition(id: string): Promise<PaperPosition | null> {
    const result = await this.client.query(
      'SELECT payload FROM paper_positions WHERE position_id = $1 FOR UPDATE',
      [id],
    );
    return decodePosition(result.rows[0]);
  }

  public async findActivePosition(
    mint: string,
    strategy: PaperStrategyIdentity,
  ): Promise<PaperPosition | null> {
    const lockKey = `${mint}\u001f${strategy.id}\u001f${strategy.version}`;
    await this.client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [lockKey],
    );
    const result = await this.client.query(
      `SELECT payload FROM paper_positions
       WHERE mint = $1 AND strategy_id = $2 AND strategy_version = $3
         AND status = 'PAPER_HOLDING'
       FOR UPDATE`,
      [mint, strategy.id, strategy.version],
    );
    return decodePosition(result.rows[0]);
  }

  public async insertOpened(
    position: PaperPosition,
    trade: PaperTrade,
    event: PaperPositionOpenedEventV1,
  ): Promise<void> {
    await this.insertPosition(position);
    await this.insertTrade(trade);
    await this.insertEvent(event);
  }

  public async updateClosed(
    position: PaperPosition,
    trade: PaperTrade,
    event: PaperPositionClosedEventV1,
  ): Promise<void> {
    await this.client.query(
      `UPDATE paper_positions SET
        status = $2, remaining_base_raw = $3, quote_proceeds_raw = $4,
        gross_pnl_quote_raw = $5, net_pnl_quote_raw = $6, exit_trade_id = $7,
        close_command_hash = $8, payload = $9, closed_at = $10, purge_after = $11
       WHERE position_id = $1 AND status = 'PAPER_HOLDING'`,
      [
        position.id,
        position.status,
        position.remainingBaseRaw.toString(),
        decimal(position.quoteProceedsRaw),
        decimal(position.grossPnlQuoteRaw),
        decimal(position.netPnlQuoteRaw),
        position.exitTradeId,
        position.closeCommandHash,
        toJsonValue(position),
        date(position.closedAtMs),
        date(position.purgeAfterMs),
      ],
    );
    await this.insertTrade(trade);
    await this.markPositionEventsTerminal(position);
    await this.insertEvent(event, position.closedAtMs, position.purgeAfterMs);
  }

  public async reconcileEventConfirmation(
    eventId: string,
    trigger: PaperConfirmationObservation,
  ): Promise<void> {
    const result = await this.client.query(
      'SELECT confirmation_status FROM domain_events WHERE event_id = $1 FOR UPDATE',
      [eventId],
    );
    const current = decodeConfirmationStatus(result.rows[0]);
    const next = reconcileConfirmationStatus(current, trigger.confirmationStatus) === 'update'
      ? trigger.confirmationStatus
      : current;
    await this.client.query(
      `UPDATE domain_events SET
        confirmation_status = $2,
        blockchain_time = CASE
          WHEN $3::timestamptz IS NULL THEN blockchain_time
          WHEN blockchain_time IS NULL THEN $3
          ELSE LEAST(blockchain_time, $3)
        END,
        observed_at = LEAST(observed_at, $4)
       WHERE event_id = $1`,
      [
        eventId,
        next,
        date(trigger.blockchainTimeMs),
        new Date(trigger.observedAtMs),
      ],
    );
  }

  public async retractPosition(position: PaperPosition): Promise<void> {
    await this.client.query(
      `UPDATE paper_positions SET
        status = $2, payload = $3, closed_at = $4, purge_after = $5
       WHERE position_id = $1`,
      [
        position.id,
        position.status,
        toJsonValue(position),
        date(position.closedAtMs),
        date(position.purgeAfterMs),
      ],
    );
    await this.markPositionEventsTerminal(position);
  }

  private async insertPosition(position: PaperPosition): Promise<void> {
    await this.client.query(
      `INSERT INTO paper_positions (
        position_id, mint, quote_mint, quote_decimals, quote_token_program,
        strategy_id, strategy_version, status, base_filled_raw, remaining_base_raw,
        quote_cost_raw, quote_proceeds_raw, gross_pnl_quote_raw, net_pnl_quote_raw,
        round_trip_loss_bps, entry_trade_id, exit_trade_id, open_command_hash,
        close_command_hash, trigger_event_id, payload_version, payload, opened_at,
        closed_at, purge_after
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
        $20,$21,$22,$23,$24,$25
      )`,
      [
        position.id, position.mint, position.quoteAsset.mint,
        position.quoteAsset.decimals, position.quoteAsset.tokenProgram,
        position.strategy.id, position.strategy.version, position.status,
        position.baseFilledRaw.toString(), position.remainingBaseRaw.toString(),
        position.quoteCostRaw.toString(), decimal(position.quoteProceedsRaw),
        decimal(position.grossPnlQuoteRaw), decimal(position.netPnlQuoteRaw),
        position.roundTripLossBps.toString(), position.entryTradeId,
        position.exitTradeId, position.openCommandHash, position.closeCommandHash,
        position.triggerEventId, position.payloadVersion, toJsonValue(position),
        new Date(position.openedAtMs), date(position.closedAtMs),
        date(position.purgeAfterMs),
      ],
    );
  }

  private async insertTrade(trade: PaperTrade): Promise<void> {
    const quote = trade.quote;
    await this.client.query(
      `INSERT INTO paper_trades (
        trade_id, position_id, side, quote_id, input_mint, output_mint,
        amount_in_raw, amount_out_raw, minimum_amount_out_raw, fill_amount_out_raw,
        fees_raw, slippage_bps, price_impact_bps, reason, payload_version,
        payload, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        trade.id, trade.positionId, trade.side, quote.id, quote.inputMint,
        quote.outputMint, quote.amountInRaw.toString(), quote.amountOutRaw.toString(),
        quote.minimumAmountOutRaw.toString(), trade.fillAmountOutRaw.toString(),
        quote.feesRaw.toString(), quote.slippageBps.toString(),
        quote.priceImpactBps.toString(), trade.reason, trade.payloadVersion,
        toJsonValue(trade), new Date(trade.createdAtMs),
      ],
    );
  }

  private async insertEvent(
    event: PaperPositionOpenedEventV1 | PaperPositionClosedEventV1,
    terminalAtMs: number | null = null,
    purgeAfterMs: number | null = null,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO domain_events (
        event_id, raw_event_id, type, mint, source, program, signature, slot,
        transaction_index, instruction_index, inner_instruction_index,
        confirmation_status, blockchain_time, observed_at, payload_version, payload,
        terminal_at, purge_after
      ) VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (event_id) DO NOTHING`,
      [
        event.id, event.type, event.mint, event.source, event.program,
        event.signature, event.cursor.slot.toString(), event.cursor.transactionIndex,
        event.cursor.instructionIndex, event.cursor.innerInstructionIndex,
        event.confirmationStatus, date(event.blockchainTimeMs),
        new Date(event.observedAtMs), event.payloadVersion, toJsonValue(event.payload),
        date(terminalAtMs), date(purgeAfterMs),
      ],
    );
  }

  private async markPositionEventsTerminal(position: PaperPosition): Promise<void> {
    await this.client.query(
      `UPDATE domain_events
       SET terminal_at = $2, purge_after = $3
       WHERE source = 'paper-trading'
         AND payload #>> '{position,id}' = $1
         AND purge_after IS NULL`,
      [position.id, date(position.closedAtMs), date(position.purgeAfterMs)],
    );
  }
}

function decodePosition(row: unknown): PaperPosition | null {
  if (row === undefined) return null;
  if (typeof row !== 'object' || row === null || !('payload' in row)) {
    throw new TypeError('Projection paper position invalide.');
  }
  const value = fromJsonValue(row.payload);
  if (!isRecord(value)) {
    throw new TypeError('Payload paper position invalide.');
  }
  const quoteAsset = record(value.quoteAsset, 'quoteAsset');
  const strategy = record(value.strategy, 'strategy');
  const status = value.status;
  if (
    status !== 'PAPER_HOLDING'
    && status !== 'PAPER_CLOSED'
    && status !== 'PAPER_RETRACTED'
  ) {
    invalidPayload('status');
  }
  const position: PaperPosition = {
    id: text(value.id, 'id'),
    mint: text(value.mint, 'mint'),
    quoteAsset: Object.freeze({
      mint: text(quoteAsset.mint, 'quoteAsset.mint'),
      decimals: boundedInteger(quoteAsset.decimals, 'quoteAsset.decimals', 0, 255),
      tokenProgram: tokenProgram(quoteAsset.tokenProgram),
    }),
    strategy: Object.freeze({
      id: text(strategy.id, 'strategy.id'),
      version: boundedInteger(strategy.version, 'strategy.version', 1),
    }),
    status,
    baseFilledRaw: positiveBigint(value.baseFilledRaw, 'baseFilledRaw'),
    remainingBaseRaw: nonNegativeBigint(value.remainingBaseRaw, 'remainingBaseRaw'),
    quoteCostRaw: positiveBigint(value.quoteCostRaw, 'quoteCostRaw'),
    quoteProceedsRaw: nullableBigint(value.quoteProceedsRaw, 'quoteProceedsRaw'),
    grossPnlQuoteRaw: nullableBigint(value.grossPnlQuoteRaw, 'grossPnlQuoteRaw'),
    netPnlQuoteRaw: nullableBigint(value.netPnlQuoteRaw, 'netPnlQuoteRaw'),
    roundTripLossBps: boundedBigint(value.roundTripLossBps, 'roundTripLossBps', 0n, 10_000n),
    entryTradeId: text(value.entryTradeId, 'entryTradeId'),
    exitTradeId: nullableText(value.exitTradeId, 'exitTradeId'),
    openCommandHash: text(value.openCommandHash, 'openCommandHash'),
    closeCommandHash: nullableText(value.closeCommandHash, 'closeCommandHash'),
    triggerEventId: text(value.triggerEventId, 'triggerEventId'),
    openedAtMs: integer(value.openedAtMs, 'openedAtMs'),
    closedAtMs: nullableInteger(value.closedAtMs, 'closedAtMs'),
    purgeAfterMs: nullableInteger(value.purgeAfterMs, 'purgeAfterMs'),
    payloadVersion: value.payloadVersion === 1 ? 1 : invalidPayload('payloadVersion'),
  };
  validatePositionState(position);
  return Object.freeze(position);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) invalidPayload(field);
  return value;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') invalidPayload(field);
  return value;
}
function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field);
}
function integer(value: unknown, field: string): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || Object.is(value, -0)
  ) {
    invalidPayload(field);
  }
  return value;
}
function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const decoded = integer(value, field);
  if (decoded < minimum || decoded > maximum) invalidPayload(field);
  return decoded;
}
function nullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : integer(value, field);
}
function bigint(value: unknown, field: string): bigint {
  if (typeof value !== 'bigint') invalidPayload(field);
  return value;
}
function positiveBigint(value: unknown, field: string): bigint {
  const decoded = bigint(value, field);
  if (decoded <= 0n) invalidPayload(field);
  return decoded;
}
function nonNegativeBigint(value: unknown, field: string): bigint {
  const decoded = bigint(value, field);
  if (decoded < 0n) invalidPayload(field);
  return decoded;
}
function boundedBigint(
  value: unknown,
  field: string,
  minimum: bigint,
  maximum: bigint,
): bigint {
  const decoded = bigint(value, field);
  if (decoded < minimum || decoded > maximum) invalidPayload(field);
  return decoded;
}
function nullableBigint(value: unknown, field: string): bigint | null {
  return value === null ? null : bigint(value, field);
}
function tokenProgram(value: unknown): 'SPL_TOKEN' | 'TOKEN_2022' {
  if (value !== 'SPL_TOKEN' && value !== 'TOKEN_2022') invalidPayload('quoteAsset.tokenProgram');
  return value;
}
function decodeConfirmationStatus(row: unknown): ChainConfirmationStatus {
  if (!isRecord(row)) throw new TypeError('Événement paper introuvable.');
  const value = row.confirmation_status;
  if (
    value !== 'processed'
    && value !== 'confirmed'
    && value !== 'finalized'
    && value !== 'orphaned'
  ) {
    throw new TypeError('Statut de confirmation paper invalide.');
  }
  return value;
}
function validatePositionState(position: PaperPosition): void {
  if (position.remainingBaseRaw > position.baseFilledRaw) {
    invalidPayload('remainingBaseRaw');
  }
  if (position.status === 'PAPER_HOLDING') {
    if (
      position.remainingBaseRaw === 0n
      || position.quoteProceedsRaw !== null
      || position.grossPnlQuoteRaw !== null
      || position.netPnlQuoteRaw !== null
      || position.exitTradeId !== null
      || position.closeCommandHash !== null
      || position.closedAtMs !== null
      || position.purgeAfterMs !== null
    ) {
      invalidPayload('status');
    }
    return;
  }
  if (position.status === 'PAPER_CLOSED' && (
    position.remainingBaseRaw !== 0n
    || position.quoteProceedsRaw === null
    || position.quoteProceedsRaw < 0n
    || position.grossPnlQuoteRaw === null
    || position.netPnlQuoteRaw === null
    || position.exitTradeId === null
    || position.closeCommandHash === null
    || position.closedAtMs === null
    || position.purgeAfterMs === null
    || position.purgeAfterMs < position.closedAtMs
  )) {
    invalidPayload('status');
  }
  if (position.status === 'PAPER_RETRACTED') {
    if (
      position.closedAtMs === null
      || position.purgeAfterMs === null
      || position.purgeAfterMs < position.closedAtMs
    ) {
      invalidPayload('status');
    }
    const retractedBeforeSell = (
      position.remainingBaseRaw > 0n
      && position.quoteProceedsRaw === null
      && position.grossPnlQuoteRaw === null
      && position.netPnlQuoteRaw === null
      && position.exitTradeId === null
      && position.closeCommandHash === null
    );
    const retractedAfterSell = (
      position.remainingBaseRaw === 0n
      && position.quoteProceedsRaw !== null
      && position.quoteProceedsRaw >= 0n
      && position.grossPnlQuoteRaw !== null
      && position.netPnlQuoteRaw !== null
      && position.exitTradeId !== null
      && position.closeCommandHash !== null
    );
    if (!retractedBeforeSell && !retractedAfterSell) invalidPayload('status');
  }
}
function invalidPayload(field: string): never {
  throw new TypeError(`Payload paper position invalide: ${field}.`);
}

function decimal(value: bigint | null): string | null {
  return value?.toString() ?? null;
}

function date(value: number | null): Date | null {
  return value === null ? null : new Date(value);
}
