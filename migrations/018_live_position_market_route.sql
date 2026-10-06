CREATE TABLE IF NOT EXISTS live_position_market_routes (
  position_id TEXT PRIMARY KEY REFERENCES live_positions(position_id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('BONDING_CURVE','WAITING_FOR_POOL','PUMPSWAP','RETRY_EXHAUSTED','UNKNOWN')),
  pool_address TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'PUMPSWAP' AND pool_address IS NOT NULL) OR state <> 'PUMPSWAP')
);
