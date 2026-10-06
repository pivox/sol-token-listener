CREATE TABLE IF NOT EXISTS execution_entry_envelopes (
  envelope_id TEXT PRIMARY KEY CHECK (LENGTH(envelope_id) BETWEEN 1 AND 128),
  generation_id TEXT NOT NULL CHECK (LENGTH(generation_id) BETWEEN 1 AND 128),
  operator_id TEXT NOT NULL CHECK (LENGTH(operator_id) BETWEEN 1 AND 128),
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  per_buy_quote_amount_raw NUMERIC(78,0) NOT NULL CHECK (per_buy_quote_amount_raw > 0),
  max_buys INTEGER NOT NULL CHECK (max_buys > 0),
  max_open_positions INTEGER NOT NULL CHECK (max_open_positions = 1),
  max_total_exposure_raw NUMERIC(78,0) NOT NULL CHECK (max_total_exposure_raw > 0),
  max_realized_loss_raw NUMERIC(78,0) NOT NULL CHECK (max_realized_loss_raw > 0),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','EXHAUSTED','REVOKED','EXPIRED')),
  buys_armed INTEGER NOT NULL DEFAULT 0 CHECK (buys_armed >= 0 AND buys_armed <= max_buys),
  realized_loss_raw NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (realized_loss_raw >= 0),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (valid_until > valid_from AND valid_until <= valid_from + INTERVAL '24 hours'),
  CHECK ((state = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS execution_entry_envelopes_one_active_idx
  ON execution_entry_envelopes (generation_id) WHERE state = 'ACTIVE';

CREATE TABLE IF NOT EXISTS entry_decisions (
  decision_id TEXT PRIMARY KEY CHECK (decision_id ~ '^entry_decision_[0-9a-f]{64}$'),
  mint TEXT NOT NULL UNIQUE,
  launch_event_id TEXT NOT NULL,
  create_slot NUMERIC(78,0) NOT NULL CHECK (create_slot >= 0),
  create_block_time TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  entry_mode TEXT NOT NULL CHECK (entry_mode = 'fast'),
  decision TEXT NOT NULL CHECK (decision IN ('BUY','REJECTED')),
  reason_code TEXT CHECK (reason_code IN ('UNSUPPORTED_QUOTE_MINT','UNSUPPORTED_TOKEN_EXTENSION',
    'CREATOR_ALREADY_SOLD','NO_ENVELOPE_CAPACITY','QUOTE_UNAVAILABLE','ROUND_TRIP_LOSS_EXCEEDED')),
  round_trip_loss_bps INTEGER CHECK (round_trip_loss_bps >= 0),
  buy_quote JSONB,
  reverse_quote JSONB,
  intent_id TEXT,
  envelope_id TEXT,
  purge_after TIMESTAMPTZ NOT NULL,
  CHECK ((decision = 'BUY') = (reason_code IS NULL)),
  CHECK ((decision = 'BUY') = (intent_id IS NOT NULL)),
  CHECK (decision <> 'BUY' OR (envelope_id IS NOT NULL AND buy_quote IS NOT NULL
    AND reverse_quote IS NOT NULL AND round_trip_loss_bps IS NOT NULL)),
  CHECK (purge_after > decided_at)
);
CREATE INDEX IF NOT EXISTS entry_decisions_purge_idx ON entry_decisions (purge_after);

DO $$
DECLARE
  target_schema TEXT := current_schema();
  target_table REGCLASS := to_regclass(format('%I.api_event_stream', current_schema()));
  existing_constraint TEXT;
BEGIN
  FOR existing_constraint IN
    SELECT constraint_definition.conname
    FROM pg_constraint AS constraint_definition
    WHERE constraint_definition.conrelid = target_table
      AND constraint_definition.contype = 'c'
      AND pg_get_constraintdef(constraint_definition.oid) LIKE '%event_type%'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.api_event_stream DROP CONSTRAINT %I',
      target_schema,
      existing_constraint
    );
  END LOOP;
END;
$$;

ALTER TABLE api_event_stream
  ADD CONSTRAINT api_event_stream_event_type_check CHECK (event_type IN (
    'TokenLaunchDetected',
    'TokenMetadataResolved',
    'TokenMetadataFailed',
    'SocialEvidenceCollected',
    'CreatorProfileUpdated',
    'HolderDistributionUpdated',
    'WalletClusterDetected',
    'BondingCurveTradeObserved',
    'BondingCurveStateUpdated',
    'BondingCurveCompleted',
    'QualificationUpdated',
    'TradingCandidateUpdated',
    'PaperStrategySessionUpdated',
    'PaperExternalBuyCounted',
    'PaperPositionOpened',
    'PaperPositionUpdated',
    'PaperPositionClosed',
    'MigrationObserved',
    'PumpSwapPoolActivated',
    'FastEntryDecided'
  ));
