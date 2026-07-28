import type {
  PaperPosition,
  PaperPositionClosedEventV1,
  PaperPositionOpenedEventV1,
  PaperStrategyIdentity,
  PaperTrade,
} from '../domain/paper-trading.js';
import type {
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
    await this.insertEvent(event);
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
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO domain_events (
        event_id, raw_event_id, type, mint, source, program, signature, slot,
        transaction_index, instruction_index, inner_instruction_index,
        confirmation_status, blockchain_time, observed_at, payload_version, payload
      ) VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (event_id) DO NOTHING`,
      [
        event.id, event.type, event.mint, event.source, event.program,
        event.signature, event.cursor.slot.toString(), event.cursor.transactionIndex,
        event.cursor.instructionIndex, event.cursor.innerInstructionIndex,
        event.confirmationStatus, date(event.blockchainTimeMs),
        new Date(event.observedAtMs), event.payloadVersion, toJsonValue(event.payload),
      ],
    );
  }
}

function decodePosition(row: unknown): PaperPosition | null {
  if (row === undefined) return null;
  if (typeof row !== 'object' || row === null || !('payload' in row)) {
    throw new TypeError('Projection paper position invalide.');
  }
  const value = fromJsonValue(row.payload);
  if (
    typeof value !== 'object'
    || value === null
    || !('id' in value)
    || typeof value.id !== 'string'
    || !('status' in value)
    || (value.status !== 'PAPER_HOLDING' && value.status !== 'PAPER_CLOSED')
  ) {
    throw new TypeError('Payload paper position invalide.');
  }
  return value as unknown as PaperPosition;
}

function decimal(value: bigint | null): string | null {
  return value?.toString() ?? null;
}

function date(value: number | null): Date | null {
  return value === null ? null : new Date(value);
}
