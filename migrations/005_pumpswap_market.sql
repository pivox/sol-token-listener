CREATE TABLE IF NOT EXISTS migrations (
  migration_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  bonding_curve TEXT NOT NULL,
  announced_pool TEXT NOT NULL,
  instruction_kind TEXT NOT NULL CHECK (instruction_kind IN ('MIGRATE','MIGRATE_V2')),
  quote_mint TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL CHECK (quote_decimals BETWEEN 0 AND 255),
  base_token_program TEXT NOT NULL,
  quote_token_program TEXT NOT NULL,
  confirmation_status TEXT NOT NULL CHECK (
    confirmation_status IN ('processed','confirmed','finalized','orphaned')
  ),
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  payload JSONB NOT NULL,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS migrations_purge_idx ON migrations(purge_after)
  WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS market_pools (
  pool_address TEXT PRIMARY KEY,
  market TEXT NOT NULL,
  program_id TEXT NOT NULL,
  pool_index INTEGER NOT NULL CHECK (pool_index = 0),
  creator TEXT NOT NULL,
  base_mint TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL CHECK (quote_decimals BETWEEN 0 AND 255),
  base_token_program TEXT NOT NULL,
  quote_token_program TEXT NOT NULL,
  base_vault TEXT NOT NULL,
  quote_vault TEXT NOT NULL,
  lp_mint TEXT NOT NULL,
  migration_id TEXT NOT NULL REFERENCES migrations(migration_id) ON DELETE CASCADE,
  activation_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  pool_state TEXT NOT NULL CHECK (pool_state IN ('active','retracted')),
  confirmation_status TEXT NOT NULL CHECK (
    confirmation_status IN ('processed','confirmed','finalized','orphaned')
  ),
  observed_slot NUMERIC(78,0) NOT NULL,
  trigger_slot NUMERIC(78,0) NOT NULL,
  transaction_index INTEGER NOT NULL,
  instruction_index INTEGER NOT NULL,
  inner_instruction_index INTEGER,
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  payload JSONB NOT NULL,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS market_pools_canonical_active_idx
  ON market_pools(market, base_mint, quote_mint)
  WHERE pool_state = 'active' AND pool_index = 0;
CREATE INDEX IF NOT EXISTS market_pools_purge_idx ON market_pools(purge_after)
  WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS market_reserve_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  pool_address TEXT NOT NULL REFERENCES market_pools(pool_address) ON DELETE CASCADE,
  base_reserves_raw NUMERIC(78,0) NOT NULL,
  quote_vault_amount_raw NUMERIC(78,0) NOT NULL,
  virtual_quote_reserves_raw NUMERIC(78,0) NOT NULL,
  effective_quote_reserves_raw NUMERIC(78,0) NOT NULL,
  slot NUMERIC(78,0) NOT NULL,
  transaction_index INTEGER NOT NULL,
  instruction_index INTEGER NOT NULL,
  inner_instruction_index INTEGER,
  confirmation_status TEXT NOT NULL CHECK (
    confirmation_status IN ('processed','confirmed','finalized','orphaned')
  ),
  observed_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS market_reserve_snapshots_cursor_idx
  ON market_reserve_snapshots(
    pool_address, observed_slot, trigger_slot, transaction_index, instruction_index,
    COALESCE(inner_instruction_index, -1)
  );

CREATE TABLE IF NOT EXISTS market_trades (
  trade_id TEXT PRIMARY KEY,
  pool_address TEXT NOT NULL REFERENCES market_pools(pool_address) ON DELETE CASCADE,
  mint TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  trade_kind TEXT NOT NULL CHECK (trade_kind IN ('BUY','SELL')),
  trader TEXT,
  base_amount_raw NUMERIC(78,0) NOT NULL,
  quote_amount_raw NUMERIC(78,0) NOT NULL,
  signature TEXT NOT NULL,
  slot NUMERIC(78,0) NOT NULL,
  transaction_index INTEGER NOT NULL,
  instruction_index INTEGER NOT NULL,
  inner_instruction_index INTEGER,
  confirmation_status TEXT NOT NULL CHECK (
    confirmation_status IN ('processed','confirmed','finalized','orphaned')
  ),
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  payload JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS market_trades_cursor_idx
  ON market_trades(
    pool_address, signature, transaction_index, instruction_index,
    COALESCE(inner_instruction_index, -1)
  );
