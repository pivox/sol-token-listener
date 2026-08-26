CREATE TABLE IF NOT EXISTS listener_catch_up_gaps (
  gap_id TEXT PRIMARY KEY,
  checkpoint_key TEXT NOT NULL,
  previous_slot NUMERIC(78,0) NOT NULL,
  previous_signature TEXT NOT NULL,
  baseline_slot NUMERIC(78,0) NOT NULL,
  baseline_signature TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  purge_after TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT listener_catch_up_gaps_id_check CHECK (
    gap_id ~ '^catchup_gap_[0-9a-f]{64}$'
  ),
  CONSTRAINT listener_catch_up_gaps_key_check CHECK (
    checkpoint_key IN ('launchpad', 'market')
  ),
  CONSTRAINT listener_catch_up_gaps_slots_check CHECK (
    previous_slot >= 0
    AND baseline_slot >= previous_slot
    AND (baseline_slot > previous_slot OR baseline_signature <> previous_signature)
  ),
  CONSTRAINT listener_catch_up_gaps_signatures_check CHECK (
    previous_signature = BTRIM(previous_signature)
    AND baseline_signature = BTRIM(baseline_signature)
    AND OCTET_LENGTH(previous_signature) BETWEEN 1 AND 128
    AND OCTET_LENGTH(baseline_signature) BETWEEN 1 AND 128
  ),
  CONSTRAINT listener_catch_up_gaps_retention_check CHECK (
    purge_after = observed_at + INTERVAL '4 hours'
  )
);

CREATE INDEX IF NOT EXISTS listener_catch_up_gaps_purge_idx
  ON listener_catch_up_gaps (purge_after);

CREATE INDEX IF NOT EXISTS listener_catch_up_gaps_program_observed_idx
  ON listener_catch_up_gaps (checkpoint_key, observed_at DESC, gap_id);
