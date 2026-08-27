import type {
  PaperMvpSource,
  PaperMvpSourceBatch,
  PaperMvpSourcePosition,
} from '../ports/paper-mvp-source.js';
import { getDatabasePool } from './database.js';

type Row = Readonly<Record<string, unknown>>;
interface QueryResult { readonly rows: readonly Row[]; readonly rowCount: number | null }
export interface PaperMvpSourcePool {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
}

export class PostgresPaperMvpSource implements PaperMvpSource {
  public constructor(private readonly pool: PaperMvpSourcePool = getDatabasePool()) {}

  public async collectBatch(input: Readonly<{
    runId: string;
    startedAtMs: number;
    deadlineAtMs: number;
    observedAtMs?: number;
    strategyId: string;
    strategyVersion: number;
    limit: number;
    signal?: AbortSignal;
  }>): Promise<PaperMvpSourceBatch> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new RangeError('Paper MVP source limit must be between 1 and 1000.');
    }
    input.signal?.throwIfAborted();
    const result = await this.pool.query(COLLECT_SQL, [
      input.runId, new Date(input.startedAtMs), new Date(input.deadlineAtMs), new Date(input.observedAtMs ?? input.deadlineAtMs),
      input.strategyId, input.strategyVersion, input.limit,
    ]);
    input.signal?.throwIfAborted();
    const first = result.rows[0];
    const creationsObserved = first === undefined ? 0 : count(first.creations_observed);
    const entriesRejected = first === undefined ? 0 : count(first.entries_rejected);
    const duplicateLogicalBuys = first === undefined ? 0 : count(first.duplicate_logical_buys);
    const duplicateLogicalSells = first === undefined ? 0 : count(first.duplicate_logical_sells);
    const openedPositions = first === undefined ? 0 : count(first.opened_positions);
    const openPositions = first === undefined ? 0 : count(first.open_positions);
    return Object.freeze({
      positions: Object.freeze(result.rows
        .filter((row) => row.position_id !== null)
        .map(positionFromRow)),
      creationsObserved,
      entriesRejected,
      duplicateLogicalBuys,
      duplicateLogicalSells,
      openedPositions,
      openPositions,
    });
  }
}

const COLLECT_SQL = `WITH run_creations AS MATERIALIZED (
  SELECT launch.mint
  FROM token_launches launch
  WHERE launch.detected_at BETWEEN $2 AND $3
  ORDER BY launch.detected_at,launch.mint
  LIMIT 1000001
), rejected_entries AS MATERIALIZED (
  SELECT DISTINCT candidate.mint
  FROM trading_candidates candidate
  JOIN run_creations creation ON creation.mint=candidate.mint
  WHERE candidate.strategy_id=$5 AND candidate.strategy_version=$6
    AND candidate.created_at BETWEEN $2 AND $3
    AND candidate.reason_codes ?| ARRAY['CREATION_ENTRY_REJECTED','CREATION_ENTRY_EXPIRED']
  ORDER BY candidate.mint
  LIMIT 1000001
), coverage AS (
  SELECT (SELECT COUNT(*)::integer FROM run_creations) AS creations_observed,
    (SELECT COUNT(*)::integer FROM rejected_entries) AS entries_rejected,
    (SELECT COUNT(*)::integer FROM (
      SELECT 1 FROM paper_positions position
      WHERE position.strategy_id=$5 AND position.strategy_version=$6
        AND position.opened_at BETWEEN $2 AND $4::timestamptz
      LIMIT 1000001
    ) bounded) AS opened_positions,
    (SELECT COUNT(*)::integer FROM (
      SELECT 1 FROM paper_positions position
      WHERE position.strategy_id=$5 AND position.strategy_version=$6
        AND position.status='PAPER_HOLDING'
        AND position.opened_at BETWEEN $2 AND $4::timestamptz
      LIMIT 1000001
    ) bounded) AS open_positions
), candidates AS MATERIALIZED (
  SELECT position.*,close_event.type AS close_event_type,
    close_event.source AS close_event_source,
    close_event.confirmation_status AS close_event_confirmation_status,
    close_event.observed_at AS close_event_observed_at
  FROM paper_positions position
  LEFT JOIN domain_events close_event ON close_event.event_id=position.close_event_id
  WHERE position.strategy_id=$5 AND position.strategy_version=$6
    AND position.opened_at >= $2
    AND position.opened_at <= $3
    AND position.closed_at <= $3
    AND (
      position.status='PAPER_RETRACTED'
      OR (position.status='PAPER_CLOSED'
        AND close_event.confirmation_status IN ('finalized','orphaned'))
    )
    AND NOT EXISTS (
      SELECT 1 FROM paper_mvp_position_samples observation
      WHERE observation.run_id=$1 AND observation.position_id=position.position_id
    )
  ORDER BY position.closed_at,position.position_id
  LIMIT $7
), trade_counts AS (
  SELECT trade.position_id,
    GREATEST(COUNT(*) FILTER (WHERE trade.side='BUY') - 1, 0)::integer AS duplicate_buys,
    GREATEST(COUNT(*) FILTER (WHERE trade.side='SELL') - 1, 0)::integer AS duplicate_sells
  FROM paper_trades trade JOIN candidates ON candidates.position_id=trade.position_id
  GROUP BY trade.position_id
), duplicate_totals AS (
  SELECT COALESCE(SUM(duplicate_buys),0)::integer AS duplicate_logical_buys,
    COALESCE(SUM(duplicate_sells),0)::integer AS duplicate_logical_sells
  FROM trade_counts
), facts AS (
  SELECT candidates.*, launch.detected_at AS creation_detected_at,
    CASE WHEN entry_job.job_id IS NULL THEN 0 ELSE 1 END AS entry_decision_job_count,
    entry_job.created_at AS entry_decision_job_at,
    buy.trade_id AS buy_trade_id,buy.side AS buy_side,
    buy.input_mint AS buy_input_mint,buy.output_mint AS buy_output_mint,
    buy.amount_in_raw::text AS buy_amount_in_raw,
    buy.amount_out_raw::text AS buy_amount_out_raw,
    buy.minimum_amount_out_raw::text AS buy_minimum_amount_out_raw,
    buy.fill_amount_out_raw::text AS buy_fill_amount_out_raw,
    buy.fees_raw::text AS buy_fees_raw,buy.slippage_bps::text AS buy_slippage_bps,
    buy.price_impact_bps::text AS buy_price_impact_bps,
    buy.quote_observed_at AS entry_quote_at,buy.created_at AS paper_buy_at,
    sell.trade_id AS sell_trade_id,sell.side AS sell_side,
    sell.input_mint AS sell_input_mint,sell.output_mint AS sell_output_mint,
    sell.reason AS sell_reason,sell.amount_in_raw::text AS sell_amount_in_raw,
    sell.amount_out_raw::text AS sell_amount_out_raw,
    sell.minimum_amount_out_raw::text AS sell_minimum_amount_out_raw,
    sell.fill_amount_out_raw::text AS sell_fill_amount_out_raw,
    sell.fees_raw::text AS sell_fees_raw,sell.slippage_bps::text AS sell_slippage_bps,
    sell.price_impact_bps::text AS sell_price_impact_bps,
    sell.quote_observed_at AS exit_quote_at,sell.created_at AS paper_sell_at
  FROM candidates
  LEFT JOIN token_launches launch ON launch.mint=candidates.mint
  LEFT JOIN paper_decision_jobs entry_job
    ON entry_job.job_id=candidates.entry_decision_job_id
  LEFT JOIN paper_trades buy ON buy.trade_id=candidates.entry_trade_id
    AND buy.position_id=candidates.position_id
  LEFT JOIN paper_trades sell ON sell.trade_id=candidates.exit_trade_id
    AND sell.position_id=candidates.position_id
)
SELECT facts.*,duplicate_totals.*,coverage.*
FROM duplicate_totals CROSS JOIN coverage LEFT JOIN facts ON TRUE
ORDER BY facts.closed_at,facts.position_id`;

function positionFromRow(row: Row): PaperMvpSourcePosition {
  return Object.freeze({
    positionId: row.position_id,status:row.status,mint:row.mint,quoteMint:row.quote_mint,
    creationDetectedAtMs:dateMs(row.creation_detected_at),
    entryDecisionAtMs:dateMs(row.entry_decision_at),
    entryDecisionJobCount:row.entry_decision_job_count,
    entryDecisionJobAtMs:dateMs(row.entry_decision_job_at),
    entryQuoteAtMs:dateMs(row.entry_quote_at),paperBuyAtMs:dateMs(row.paper_buy_at),
    exitTriggerAtMs:dateMs(row.exit_trigger_at),closeEventId:row.close_event_id,
    closeEventType:row.close_event_type,closeEventSource:row.close_event_source,
    closeEventConfirmationStatus:row.close_event_confirmation_status,
    closeEventObservedAtMs:dateMs(row.close_event_observed_at),
    exitQuoteAtMs:dateMs(row.exit_quote_at),paperSellAtMs:dateMs(row.paper_sell_at),
    entryTradeId:row.entry_trade_id,buyTradeId:row.buy_trade_id,buySide:row.buy_side,
    buyInputMint:row.buy_input_mint,buyOutputMint:row.buy_output_mint,
    buyAmountInRaw:row.buy_amount_in_raw,buyAmountOutRaw:row.buy_amount_out_raw,
    buyMinimumAmountOutRaw:row.buy_minimum_amount_out_raw,
    buyFillAmountOutRaw:row.buy_fill_amount_out_raw,buyFeesRaw:row.buy_fees_raw,
    buySlippageBps:row.buy_slippage_bps,buyPriceImpactBps:row.buy_price_impact_bps,
    exitTradeId:row.exit_trade_id,sellTradeId:row.sell_trade_id,sellSide:row.sell_side,
    sellInputMint:row.sell_input_mint,sellOutputMint:row.sell_output_mint,
    sellReason:row.sell_reason,sellAmountInRaw:row.sell_amount_in_raw,
    sellAmountOutRaw:row.sell_amount_out_raw,
    sellMinimumAmountOutRaw:row.sell_minimum_amount_out_raw,
    sellFillAmountOutRaw:row.sell_fill_amount_out_raw,sellFeesRaw:row.sell_fees_raw,
    sellSlippageBps:row.sell_slippage_bps,sellPriceImpactBps:row.sell_price_impact_bps,
  });
}

function dateMs(value: unknown): unknown {
  return value instanceof Date && Number.isSafeInteger(value.getTime()) ? value.getTime() : value;
}
function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000_000) {
    throw new TypeError('Paper MVP duplicate count is invalid.');
  }
  return parsed;
}
