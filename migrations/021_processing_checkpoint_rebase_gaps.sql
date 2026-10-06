CREATE TABLE IF NOT EXISTS processing_checkpoint_rebase_gaps (
  rebase_id UUID PRIMARY KEY,
  checkpoint_key TEXT NOT NULL CHECK (checkpoint_key IN ('launchpad', 'market')),
  previous_source TEXT NOT NULL,
  previous_program TEXT NOT NULL,
  previous_slot NUMERIC(78,0) NOT NULL CHECK (previous_slot >= 0),
  previous_signature TEXT,
  previous_transaction_index INTEGER,
  previous_payload JSONB NOT NULL,
  previous_updated_at TIMESTAMPTZ NOT NULL,
  new_slot NUMERIC(78,0) NOT NULL CHECK (new_slot >= 0),
  new_signature TEXT NOT NULL,
  finalized_head_slot NUMERIC(78,0) NOT NULL CHECK (finalized_head_slot >= 0),
  genesis_hash TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason = 'invalid-future-checkpoint'),
  recorded_at TIMESTAMPTZ NOT NULL,
  CHECK (previous_slot > finalized_head_slot),
  CHECK (new_slot <= finalized_head_slot)
);

CREATE UNIQUE INDEX IF NOT EXISTS processing_checkpoint_rebase_old_state_idx
  ON processing_checkpoint_rebase_gaps (
    checkpoint_key, previous_slot, COALESCE(previous_signature, '')
  );

CREATE INDEX IF NOT EXISTS processing_checkpoint_rebase_history_idx
  ON processing_checkpoint_rebase_gaps (checkpoint_key, recorded_at DESC);
