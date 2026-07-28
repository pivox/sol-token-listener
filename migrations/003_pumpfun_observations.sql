CREATE TABLE IF NOT EXISTS token_metadata_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  uri TEXT NOT NULL,
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('resolved', 'failed')),
  failure_reason TEXT,
  failure_message TEXT,
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  payload_hash TEXT NOT NULL,
  metadata JSONB,
  fetched_at TIMESTAMPTZ NOT NULL,
  purge_after TIMESTAMPTZ,
  CHECK ((resolution_status = 'resolved' AND metadata IS NOT NULL AND failure_reason IS NULL)
    OR (resolution_status = 'failed' AND metadata IS NULL AND failure_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS token_metadata_snapshots_purge_idx
  ON token_metadata_snapshots(purge_after) WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS bonding_curve_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  quote_mint TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL CHECK (quote_decimals BETWEEN 0 AND 255),
  quote_token_program TEXT NOT NULL,
  real_base_reserves_raw NUMERIC(78,0) NOT NULL,
  real_quote_reserves_raw NUMERIC(78,0) NOT NULL,
  virtual_base_reserves_raw NUMERIC(78,0) NOT NULL,
  virtual_quote_reserves_raw NUMERIC(78,0) NOT NULL,
  progress_bps NUMERIC(78,0) NOT NULL,
  complete BOOLEAN NOT NULL,
  slot NUMERIC(78,0) NOT NULL,
  transaction_index INTEGER NOT NULL,
  instruction_index INTEGER NOT NULL,
  inner_instruction_index INTEGER,
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('processed', 'confirmed', 'finalized', 'orphaned')),
  purge_after TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS bonding_curve_snapshots_cursor_idx
  ON bonding_curve_snapshots(mint, slot, transaction_index, instruction_index, COALESCE(inner_instruction_index, -1));
CREATE INDEX IF NOT EXISTS bonding_curve_snapshots_purge_idx
  ON bonding_curve_snapshots(purge_after) WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS launch_trades (
  trade_id TEXT PRIMARY KEY,
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  trade_kind TEXT NOT NULL CHECK (trade_kind IN ('BUY', 'SELL')),
  trader TEXT,
  base_amount_raw NUMERIC(78,0) NOT NULL,
  quote_amount_raw NUMERIC(78,0) NOT NULL,
  quote_mint TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL CHECK (quote_decimals BETWEEN 0 AND 255),
  quote_token_program TEXT NOT NULL,
  slot NUMERIC(78,0) NOT NULL,
  transaction_index INTEGER NOT NULL,
  instruction_index INTEGER NOT NULL,
  inner_instruction_index INTEGER,
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('processed', 'confirmed', 'finalized', 'orphaned')),
  purge_after TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS launch_trades_mint_cursor_idx
  ON launch_trades(mint, slot, transaction_index, instruction_index);
CREATE UNIQUE INDEX IF NOT EXISTS launch_trades_cursor_idx
  ON launch_trades(mint, slot, transaction_index, instruction_index, COALESCE(inner_instruction_index, -1));
CREATE INDEX IF NOT EXISTS launch_trades_purge_idx
  ON launch_trades(purge_after) WHERE purge_after IS NOT NULL;
