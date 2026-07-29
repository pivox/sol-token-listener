CREATE TABLE IF NOT EXISTS creator_profiles (
  mint TEXT PRIMARY KEY REFERENCES token_launches(mint) ON DELETE CASCADE,
  creator TEXT NOT NULL,
  payload_version INTEGER NOT NULL CHECK (payload_version = 1),
  input_fingerprint TEXT NOT NULL,
  profile_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  as_of_slot NUMERIC(78,0) NOT NULL,
  as_of_transaction_index INTEGER NOT NULL,
  as_of_instruction_index INTEGER NOT NULL,
  as_of_inner_instruction_index INTEGER,
  confirmation_status TEXT NOT NULL
    CHECK (confirmation_status IN ('processed', 'confirmed', 'finalized')),
  total_bought_base_raw NUMERIC(78,0) NOT NULL CHECK (total_bought_base_raw >= 0),
  total_sold_base_raw NUMERIC(78,0) NOT NULL CHECK (total_sold_base_raw >= 0),
  observed_net_base_raw NUMERIC(78,0) NOT NULL,
  has_sold BOOLEAN NOT NULL,
  payload JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  purge_after TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS creator_profiles_purge_idx
  ON creator_profiles(purge_after) WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS observed_wallet_positions (
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  wallet TEXT NOT NULL,
  is_creator BOOLEAN NOT NULL,
  input_fingerprint TEXT NOT NULL,
  buy_count INTEGER NOT NULL CHECK (buy_count >= 0),
  sell_count INTEGER NOT NULL CHECK (sell_count >= 0),
  bought_base_raw NUMERIC(78,0) NOT NULL CHECK (bought_base_raw >= 0),
  sold_base_raw NUMERIC(78,0) NOT NULL CHECK (sold_base_raw >= 0),
  observed_net_base_raw NUMERIC(78,0) NOT NULL,
  first_slot NUMERIC(78,0) NOT NULL,
  first_transaction_index INTEGER NOT NULL,
  first_instruction_index INTEGER NOT NULL,
  first_inner_instruction_index INTEGER,
  last_slot NUMERIC(78,0) NOT NULL,
  last_transaction_index INTEGER NOT NULL,
  last_instruction_index INTEGER NOT NULL,
  last_inner_instruction_index INTEGER,
  quote_flows JSONB NOT NULL,
  payload JSONB NOT NULL,
  purge_after TIMESTAMPTZ,
  PRIMARY KEY (mint, wallet)
);
CREATE INDEX IF NOT EXISTS observed_wallet_positions_rank_idx
  ON observed_wallet_positions(mint, observed_net_base_raw DESC, wallet ASC);
CREATE INDEX IF NOT EXISTS observed_wallet_positions_purge_idx
  ON observed_wallet_positions(purge_after) WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS token_holders_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  input_fingerprint TEXT NOT NULL,
  holder_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  payload_version INTEGER NOT NULL CHECK (payload_version = 1),
  as_of_slot NUMERIC(78,0) NOT NULL,
  as_of_transaction_index INTEGER NOT NULL,
  as_of_instruction_index INTEGER NOT NULL,
  as_of_inner_instruction_index INTEGER,
  confirmation_status TEXT NOT NULL
    CHECK (confirmation_status IN ('processed', 'confirmed', 'finalized')),
  total_positive_net_base_raw NUMERIC(78,0) NOT NULL
    CHECK (total_positive_net_base_raw >= 0),
  top1_bps NUMERIC(78,0) NOT NULL CHECK (top1_bps >= 0 AND top1_bps <= 10000),
  top5_bps NUMERIC(78,0) NOT NULL CHECK (top5_bps >= 0 AND top5_bps <= 10000),
  top10_bps NUMERIC(78,0) NOT NULL CHECK (top10_bps >= 0 AND top10_bps <= 10000),
  creator_bps NUMERIC(78,0) NOT NULL CHECK (creator_bps >= 0 AND creator_bps <= 10000),
  unique_known_buyers INTEGER NOT NULL CHECK (unique_known_buyers >= 0),
  unique_external_buyers INTEGER NOT NULL CHECK (unique_external_buyers >= 0),
  positive_position_count INTEGER NOT NULL CHECK (positive_position_count >= 0),
  unknown_trader_trade_count INTEGER NOT NULL CHECK (unknown_trader_trade_count >= 0),
  payload JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  purge_after TIMESTAMPTZ,
  UNIQUE (mint, input_fingerprint)
);
CREATE INDEX IF NOT EXISTS token_holders_snapshots_history_idx
  ON token_holders_snapshots(
    mint,
    as_of_slot DESC,
    as_of_transaction_index DESC,
    as_of_instruction_index DESC,
    COALESCE(as_of_inner_instruction_index, -1) DESC,
    snapshot_id DESC
  );
CREATE INDEX IF NOT EXISTS token_holders_snapshots_purge_idx
  ON token_holders_snapshots(purge_after) WHERE purge_after IS NOT NULL;

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
    'PaperPositionOpened',
    'PaperPositionUpdated',
    'PaperPositionClosed',
    'MigrationObserved',
    'PumpSwapPoolActivated'
  ));
