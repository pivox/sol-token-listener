CREATE TABLE IF NOT EXISTS live_positions (
  position_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  token_program TEXT NOT NULL,
  entry_slot NUMERIC(78,0) NOT NULL CHECK (entry_slot >= 0),
  entry_transaction_index INTEGER NOT NULL CHECK (entry_transaction_index >= 0),
  entry_instruction_index INTEGER NOT NULL CHECK (entry_instruction_index >= 0),
  entry_inner_instruction_index INTEGER CHECK (entry_inner_instruction_index >= 0),
  external_buy_target INTEGER NOT NULL CHECK (external_buy_target BETWEEN 1 AND 1000),
  counted_external_buy_ids JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(counted_external_buy_ids)='array'),
  status TEXT NOT NULL CHECK (status IN ('OPEN','RECONCILIATION_REQUIRED','CLOSED')),
  wallet_token_pre_raw NUMERIC(78,0),
  acquired_raw NUMERIC(78,0),
  remaining_raw NUMERIC(78,0),
  buy_signature TEXT NOT NULL,
  sell_signature TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (status = 'RECONCILIATION_REQUIRED') OR
    (wallet_token_pre_raw IS NOT NULL AND acquired_raw IS NOT NULL AND remaining_raw IS NOT NULL)
  ),
  CHECK (acquired_raw IS NULL OR acquired_raw > 0),
  CHECK (remaining_raw IS NULL OR remaining_raw >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS live_positions_open_wallet_idx
  ON live_positions(wallet) WHERE status IN ('OPEN','RECONCILIATION_REQUIRED');
CREATE INDEX IF NOT EXISTS live_positions_session_idx ON live_positions(session_id, candidate_id);

CREATE TABLE IF NOT EXISTS live_position_fills (
  signature TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES live_orders(order_id),
  position_id TEXT NOT NULL REFERENCES live_positions(position_id),
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  wallet_token_pre_raw NUMERIC(78,0),
  wallet_token_post_raw NUMERIC(78,0),
  delta_raw NUMERIC(78,0),
  applied BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((wallet_token_pre_raw IS NULL AND wallet_token_post_raw IS NULL AND delta_raw IS NULL)
    OR (wallet_token_pre_raw IS NOT NULL AND wallet_token_post_raw IS NOT NULL AND delta_raw IS NOT NULL))
);
