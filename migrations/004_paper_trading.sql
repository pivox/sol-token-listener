CREATE TABLE IF NOT EXISTS paper_positions (
  position_id TEXT PRIMARY KEY,
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  quote_mint TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL CHECK (quote_decimals BETWEEN 0 AND 255),
  quote_token_program TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version INTEGER NOT NULL CHECK (strategy_version > 0),
  status TEXT NOT NULL CHECK (status IN ('PAPER_HOLDING', 'PAPER_CLOSED')),
  base_filled_raw NUMERIC(78,0) NOT NULL,
  remaining_base_raw NUMERIC(78,0) NOT NULL,
  quote_cost_raw NUMERIC(78,0) NOT NULL,
  quote_proceeds_raw NUMERIC(78,0),
  gross_pnl_quote_raw NUMERIC(78,0),
  net_pnl_quote_raw NUMERIC(78,0),
  round_trip_loss_bps NUMERIC(78,0) NOT NULL,
  entry_trade_id TEXT NOT NULL,
  exit_trade_id TEXT,
  open_command_hash TEXT NOT NULL,
  close_command_hash TEXT,
  trigger_event_id TEXT NOT NULL,
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  payload JSONB NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  CHECK (
    (status = 'PAPER_HOLDING' AND closed_at IS NULL AND purge_after IS NULL)
    OR
    (status = 'PAPER_CLOSED' AND closed_at IS NOT NULL AND purge_after IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS paper_positions_active_strategy_idx
  ON paper_positions(mint, strategy_id, strategy_version)
  WHERE status = 'PAPER_HOLDING';
CREATE INDEX IF NOT EXISTS paper_positions_purge_idx
  ON paper_positions(purge_after) WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS paper_trades (
  trade_id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES paper_positions(position_id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quote_id TEXT NOT NULL,
  input_mint TEXT NOT NULL,
  output_mint TEXT NOT NULL,
  amount_in_raw NUMERIC(78,0) NOT NULL,
  amount_out_raw NUMERIC(78,0) NOT NULL,
  minimum_amount_out_raw NUMERIC(78,0) NOT NULL,
  fill_amount_out_raw NUMERIC(78,0) NOT NULL,
  fees_raw NUMERIC(78,0) NOT NULL,
  slippage_bps NUMERIC(78,0) NOT NULL,
  price_impact_bps NUMERIC(78,0) NOT NULL,
  reason TEXT NOT NULL,
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(position_id, side)
);
