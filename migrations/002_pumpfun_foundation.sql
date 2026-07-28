CREATE TABLE IF NOT EXISTS token_launches (
  mint TEXT PRIMARY KEY,
  launchpad TEXT NOT NULL,
  program_id TEXT NOT NULL,
  creator TEXT NOT NULL,
  token_program TEXT NOT NULL,
  quote_assets JSONB NOT NULL DEFAULT '[]'::jsonb,
  current_state TEXT NOT NULL,
  created_signature TEXT NOT NULL,
  created_slot NUMERIC(78,0) NOT NULL,
  created_transaction_index INTEGER NOT NULL,
  created_instruction_index INTEGER NOT NULL,
  created_inner_instruction_index INTEGER,
  detected_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  CHECK (purge_after IS NULL OR terminal_at IS NOT NULL),
  CHECK (purge_after IS NULL OR purge_after >= terminal_at)
);
CREATE INDEX IF NOT EXISTS token_launches_state_idx
  ON token_launches(current_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS token_launches_purge_idx
  ON token_launches(purge_after)
  WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS raw_chain_events (
  event_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  program TEXT NOT NULL,
  mint TEXT,
  signature TEXT NOT NULL,
  slot NUMERIC(78,0) NOT NULL,
  transaction_index INTEGER NOT NULL,
  instruction_index INTEGER NOT NULL,
  inner_instruction_index INTEGER,
  confirmation_status TEXT NOT NULL
    CHECK (confirmation_status IN ('processed', 'confirmed', 'finalized', 'orphaned')),
  blockchain_time TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL,
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  payload JSONB NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'processed', 'failed')),
  processing_lease_until TIMESTAMPTZ,
  processing_error TEXT,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (purge_after IS NULL OR terminal_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS raw_chain_events_cursor_idx
  ON raw_chain_events (
    source,
    program,
    signature,
    transaction_index,
    instruction_index,
    COALESCE(inner_instruction_index, -1)
  );
CREATE INDEX IF NOT EXISTS raw_chain_events_processing_idx
  ON raw_chain_events(processing_status, processing_lease_until, observed_at);
CREATE INDEX IF NOT EXISTS raw_chain_events_mint_idx
  ON raw_chain_events(mint, slot, transaction_index, instruction_index);
CREATE INDEX IF NOT EXISTS raw_chain_events_purge_idx
  ON raw_chain_events(purge_after)
  WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS domain_events (
  event_id TEXT PRIMARY KEY,
  raw_event_id TEXT REFERENCES raw_chain_events(event_id),
  type TEXT NOT NULL,
  mint TEXT NOT NULL,
  source TEXT NOT NULL,
  program TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot NUMERIC(78,0) NOT NULL,
  transaction_index INTEGER NOT NULL,
  instruction_index INTEGER NOT NULL,
  inner_instruction_index INTEGER,
  confirmation_status TEXT NOT NULL
    CHECK (confirmation_status IN ('processed', 'confirmed', 'finalized', 'orphaned')),
  blockchain_time TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL,
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  payload JSONB NOT NULL,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (purge_after IS NULL OR terminal_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS domain_events_mint_cursor_idx
  ON domain_events(mint, slot, transaction_index, instruction_index);
CREATE INDEX IF NOT EXISTS domain_events_resume_idx
  ON domain_events(created_at, event_id);
CREATE INDEX IF NOT EXISTS domain_events_purge_idx
  ON domain_events(purge_after)
  WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS state_transitions (
  transition_id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  event_id TEXT REFERENCES domain_events(event_id),
  occurred_at TIMESTAMPTZ NOT NULL,
  trigger_event TEXT NOT NULL,
  previous_state TEXT,
  new_state TEXT NOT NULL,
  reason_code TEXT,
  human_message TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (purge_after IS NULL OR terminal_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS state_transitions_mint_idx
  ON state_transitions(mint, occurred_at, transition_id);
CREATE INDEX IF NOT EXISTS state_transitions_purge_idx
  ON state_transitions(purge_after)
  WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS processing_checkpoints (
  checkpoint_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  program TEXT NOT NULL,
  slot NUMERIC(78,0) NOT NULL,
  signature TEXT,
  transaction_index INTEGER,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(source, program)
);

-- The legacy Raydium tables are retained. New writes are paper-only at the
-- application boundary; historical dry-run/live labels remain readable.
ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_mode_check;
ALTER TABLE trades
  ADD CONSTRAINT trades_mode_check
  CHECK (mode IN ('dry-run', 'live', 'paper')) NOT VALID;
