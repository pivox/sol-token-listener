CREATE TABLE IF NOT EXISTS chain_transaction_inbox (
  signature TEXT PRIMARY KEY,
  observed_slot NUMERIC(78,0) NOT NULL,
  discovery_sources TEXT[] NOT NULL,
  target_confirmation_status TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  missing_finality_polls INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  normalized_transaction JSONB,
  immutable_fingerprint TEXT,
  error_code TEXT,
  error_name TEXT,
  error_retryable BOOLEAN,
  blockchain_time TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chain_transaction_inbox_signature_check CHECK (
    signature = BTRIM(signature)
    AND LENGTH(signature) BETWEEN 1 AND 128
  ),
  CONSTRAINT chain_transaction_inbox_observed_slot_check CHECK (observed_slot >= 0),
  CONSTRAINT chain_transaction_inbox_discovery_sources_check CHECK (
    discovery_sources IN (
      ARRAY['WEBSOCKET']::TEXT[],
      ARRAY['CATCH_UP']::TEXT[],
      ARRAY['WEBSOCKET', 'CATCH_UP']::TEXT[]
    )
  ),
  CONSTRAINT chain_transaction_inbox_target_confirmation_check CHECK (
    target_confirmation_status IN ('processed', 'confirmed', 'finalized', 'orphaned')
  ),
  CONSTRAINT chain_transaction_inbox_processing_status_check CHECK (
    processing_status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED')
  ),
  CONSTRAINT chain_transaction_inbox_attempts_check CHECK (attempts >= 0),
  CONSTRAINT chain_transaction_inbox_missing_finality_polls_check CHECK (
    missing_finality_polls >= 0
  ),
  CONSTRAINT chain_transaction_inbox_lease_check CHECK (
    (
      processing_status = 'PROCESSING'
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND LENGTH(lease_token) BETWEEN 1 AND 256
    ) OR (
      processing_status <> 'PROCESSING'
      AND lease_token IS NULL AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT chain_transaction_inbox_snapshot_check CHECK (
    (
      normalized_transaction IS NULL AND immutable_fingerprint IS NULL
    ) OR (
      normalized_transaction IS NOT NULL
      AND jsonb_typeof(normalized_transaction) = 'object'
      AND immutable_fingerprint IS NOT NULL
      AND immutable_fingerprint ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT chain_transaction_inbox_error_check CHECK (
    (
      processing_status = 'FAILED'
      AND error_code IS NOT NULL
      AND error_code IN (
        'RPC_TRANSIENT',
        'TRANSACTION_NOT_AVAILABLE',
        'BLOCK_NOT_AVAILABLE',
        'TRANSACTION_INDEX_NOT_FOUND',
        'NORMALIZATION_FAILED',
        'PIPELINE_STAGE_FAILED',
        'FINALITY_INCONSISTENT',
        'CATCH_UP_WINDOW_EXCEEDED'
      )
      AND error_name IS NOT NULL
      AND OCTET_LENGTH(error_name) BETWEEN 1 AND 16384
      AND error_retryable IS NOT NULL
    ) OR (
      processing_status <> 'FAILED'
      AND error_code IS NULL
      AND error_name IS NULL
      AND error_retryable IS NULL
    )
  ),
  CONSTRAINT chain_transaction_inbox_retry_check CHECK (
    (processing_status = 'FAILED' AND error_retryable = TRUE AND next_attempt_at IS NOT NULL)
    OR (NOT (processing_status = 'FAILED' AND error_retryable = TRUE) AND next_attempt_at IS NULL)
  ),
  CONSTRAINT chain_transaction_inbox_processed_check CHECK (
    processing_status <> 'PROCESSED'
    OR (processed_at IS NOT NULL AND normalized_transaction IS NOT NULL)
  ),
  CONSTRAINT chain_transaction_inbox_terminal_check CHECK (
    (
      terminal_at IS NULL AND purge_after IS NULL
    ) OR (
      processing_status = 'PROCESSED'
      AND target_confirmation_status IN ('finalized', 'orphaned')
      AND processed_at IS NOT NULL
      AND terminal_at IS NOT NULL
      AND purge_after IS NOT NULL
      AND purge_after = terminal_at + INTERVAL '4 hours'
    )
  ),
  CONSTRAINT chain_transaction_inbox_terminal_completion_check CHECK (
    processing_status <> 'PROCESSED'
    OR target_confirmation_status NOT IN ('finalized', 'orphaned')
    OR terminal_at IS NOT NULL
  ),
  CONSTRAINT chain_transaction_inbox_timestamps_check CHECK (
    updated_at >= created_at
    AND (processed_at IS NULL OR processed_at >= observed_at)
    AND (terminal_at IS NULL OR terminal_at >= processed_at)
  )
);

CREATE INDEX IF NOT EXISTS chain_transaction_inbox_claim_idx
  ON chain_transaction_inbox (
    processing_status, next_attempt_at, lease_expires_at, observed_slot, signature
  )
  WHERE processing_status IN ('PENDING', 'PROCESSING');
CREATE INDEX IF NOT EXISTS chain_transaction_inbox_claim_order_idx
  ON chain_transaction_inbox (observed_slot, signature)
  WHERE processing_status = 'PENDING'
     OR processing_status = 'PROCESSING'
     OR (processing_status = 'FAILED' AND error_retryable = TRUE);
CREATE INDEX IF NOT EXISTS chain_transaction_inbox_retry_idx
  ON chain_transaction_inbox (next_attempt_at, observed_slot, signature)
  WHERE processing_status = 'FAILED' AND error_retryable = TRUE;
CREATE INDEX IF NOT EXISTS chain_transaction_inbox_finality_idx
  ON chain_transaction_inbox (processed_at, observed_slot, signature)
  WHERE processing_status = 'PROCESSED'
    AND target_confirmation_status IN ('processed', 'confirmed');
CREATE INDEX IF NOT EXISTS chain_transaction_inbox_purge_idx
  ON chain_transaction_inbox (purge_after)
  WHERE purge_after IS NOT NULL;

ALTER TABLE listener_heartbeats
  ADD COLUMN IF NOT EXISTS runtime_state TEXT NOT NULL DEFAULT 'STOPPED';
ALTER TABLE listener_heartbeats
  ADD COLUMN IF NOT EXISTS subscriber_state TEXT NOT NULL DEFAULT 'STOPPED';
ALTER TABLE listener_heartbeats
  ADD COLUMN IF NOT EXISTS scanner_state TEXT NOT NULL DEFAULT 'STOPPED';
ALTER TABLE listener_heartbeats
  ADD COLUMN IF NOT EXISTS worker_state TEXT NOT NULL DEFAULT 'STOPPED';
ALTER TABLE listener_heartbeats
  ADD COLUMN IF NOT EXISTS reconciler_state TEXT NOT NULL DEFAULT 'STOPPED';
ALTER TABLE listener_heartbeats
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE listener_heartbeats
  ADD COLUMN IF NOT EXISTS leased_transactions INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_definition
    JOIN pg_class constrained_table
      ON constrained_table.oid = constraint_definition.conrelid
    JOIN pg_namespace constrained_schema
      ON constrained_schema.oid = constrained_table.relnamespace
    WHERE constraint_definition.conname = 'listener_heartbeats_runtime_state_check'
      AND constrained_table.relname = 'listener_heartbeats'
      AND constrained_schema.nspname = current_schema()
  ) THEN
    ALTER TABLE listener_heartbeats
      ADD CONSTRAINT listener_heartbeats_runtime_state_check CHECK (
        runtime_state IN ('STARTING', 'RUNNING', 'DEGRADED', 'STOPPING', 'STOPPED')
        AND subscriber_state IN ('STARTING', 'RUNNING', 'DEGRADED', 'STOPPING', 'STOPPED')
        AND scanner_state IN ('STARTING', 'RUNNING', 'DEGRADED', 'STOPPING', 'STOPPED')
        AND worker_state IN ('STARTING', 'RUNNING', 'DEGRADED', 'STOPPING', 'STOPPED')
        AND reconciler_state IN ('STARTING', 'RUNNING', 'DEGRADED', 'STOPPING', 'STOPPED')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_definition
    JOIN pg_class constrained_table
      ON constrained_table.oid = constraint_definition.conrelid
    JOIN pg_namespace constrained_schema
      ON constrained_schema.oid = constrained_table.relnamespace
    WHERE constraint_definition.conname = 'listener_heartbeats_runtime_counts_check'
      AND constrained_table.relname = 'listener_heartbeats'
      AND constrained_schema.nspname = current_schema()
  ) THEN
    ALTER TABLE listener_heartbeats
      ADD CONSTRAINT listener_heartbeats_runtime_counts_check CHECK (
        pending_transactions >= 0
        AND leased_transactions BETWEEN 0 AND pending_transactions
        AND (started_at IS NULL OR started_at <= updated_at)
      );
  END IF;
END;
$$;

-- A single Pump instruction can emit more than one distinct observation at
-- the same canonical cursor (notably token creation plus its initial buy).
-- Event IDs provide idempotence; the cursor remains an ordering index only.
DROP INDEX IF EXISTS raw_chain_events_cursor_idx;
CREATE INDEX raw_chain_events_cursor_idx
  ON raw_chain_events (
    source,
    program,
    signature,
    transaction_index,
    instruction_index,
    COALESCE(inner_instruction_index, -1)
  );
