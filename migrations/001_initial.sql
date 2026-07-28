CREATE TABLE IF NOT EXISTS migration_history (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS discovered_pools (
  pool_address TEXT PRIMARY KEY,
  dex TEXT NOT NULL CHECK (dex = 'RAYDIUM_CPMM'),
  program_id TEXT NOT NULL,
  token_mint TEXT NOT NULL,
  wsol_mint TEXT NOT NULL,
  token_vault TEXT NOT NULL,
  wsol_vault TEXT NOT NULL,
  lp_mint TEXT NOT NULL,
  token_program TEXT NOT NULL,
  wsol_token_program TEXT NOT NULL,
  creator TEXT,
  open_time_unix NUMERIC(78,0),
  created_slot NUMERIC(78,0) NOT NULL,
  created_signature TEXT NOT NULL,
  created_instruction_index INTEGER NOT NULL,
  confirmation_status TEXT NOT NULL DEFAULT 'CONFIRMED'
    CHECK (confirmation_status IN ('CONFIRMED', 'FINALIZED', 'ORPHANED')),
  payload JSONB NOT NULL,
  discovered_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(created_signature, created_instruction_index)
);
CREATE INDEX IF NOT EXISTS discovered_pools_token_mint_idx ON discovered_pools(token_mint);
CREATE INDEX IF NOT EXISTS discovered_pools_created_slot_idx ON discovered_pools(created_slot);

CREATE TABLE IF NOT EXISTS token_sessions (
  session_id TEXT PRIMARY KEY,
  pool_address TEXT NOT NULL REFERENCES discovered_pools(pool_address),
  token_mint TEXT NOT NULL,
  status TEXT NOT NULL,
  subsequent_buy_count INTEGER NOT NULL DEFAULT 0,
  target_buy_count INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS token_sessions_status_idx ON token_sessions(status);
CREATE INDEX IF NOT EXISTS token_sessions_pool_idx ON token_sessions(pool_address);

CREATE TABLE IF NOT EXISTS swap_events (
  event_id TEXT PRIMARY KEY,
  pool_address TEXT NOT NULL REFERENCES discovered_pools(pool_address),
  signature TEXT NOT NULL,
  slot NUMERIC(78,0) NOT NULL,
  transaction_index INTEGER NOT NULL,
  instruction_index INTEGER NOT NULL,
  inner_instruction_index INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('BUY', 'SELL', 'OTHER')),
  amount_wsol_raw NUMERIC(78,0) NOT NULL,
  amount_token_raw NUMERIC(78,0) NOT NULL,
  confirmation_status TEXT NOT NULL
    CHECK (confirmation_status IN ('CONFIRMED', 'FINALIZED', 'ORPHANED')),
  processing_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (processing_status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED')),
  processing_error TEXT,
  payload JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(pool_address, signature, instruction_index, inner_instruction_index)
);
CREATE INDEX IF NOT EXISTS swap_events_slot_idx ON swap_events(slot, transaction_index, instruction_index);
CREATE INDEX IF NOT EXISTS swap_events_signature_idx ON swap_events(signature);
CREATE INDEX IF NOT EXISTS swap_events_processing_idx ON swap_events(processing_status, updated_at);

CREATE TABLE IF NOT EXISTS trades (
  trade_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES token_sessions(session_id),
  pool_address TEXT NOT NULL REFERENCES discovered_pools(pool_address),
  token_mint TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'live')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SIMULATED', 'CONFIRMED', 'FAILED')),
  amount_in_raw NUMERIC(78,0) NOT NULL,
  amount_out_raw NUMERIC(78,0) NOT NULL,
  quoted_out_raw NUMERIC(78,0) NOT NULL,
  signature TEXT,
  slot NUMERIC(78,0),
  fee_lamports NUMERIC(78,0),
  rent_delta_lamports NUMERIC(78,0),
  priority_fee_lamports NUMERIC(78,0),
  compute_units NUMERIC(78,0),
  error TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(session_id, side)
);
CREATE UNIQUE INDEX IF NOT EXISTS trades_signature_idx ON trades(signature) WHERE signature IS NOT NULL;

CREATE TABLE IF NOT EXISTS token_risk_reports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES token_sessions(session_id),
  token_mint TEXT NOT NULL,
  pool_address TEXT NOT NULL REFERENCES discovered_pools(pool_address),
  slot NUMERIC(78,0) NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  verdict TEXT NOT NULL CHECK (verdict IN ('ALLOW', 'REVIEW', 'BLOCK')),
  checks JSONB NOT NULL,
  evidence JSONB NOT NULL,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS token_risk_reports_session_idx ON token_risk_reports(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS listener_checkpoints (
  listener_key TEXT PRIMARY KEY,
  slot NUMERIC(78,0) NOT NULL,
  signature TEXT,
  transaction_index INTEGER,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ignored_assets (
  token_mint TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS risk_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  settings JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS listener_heartbeats (
  service_key TEXT PRIMARY KEY,
  last_http_slot NUMERIC(78,0),
  last_websocket_slot NUMERIC(78,0),
  last_finalized_slot NUMERIC(78,0),
  last_signature TEXT,
  pending_transactions INTEGER NOT NULL DEFAULT 0,
  retry_count BIGINT NOT NULL DEFAULT 0,
  active_sessions INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
