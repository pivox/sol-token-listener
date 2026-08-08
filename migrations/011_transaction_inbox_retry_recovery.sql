ALTER TABLE chain_transaction_inbox
  ADD COLUMN IF NOT EXISTS retry_max_attempts INTEGER NOT NULL DEFAULT 5;
ALTER TABLE chain_transaction_inbox
  ADD COLUMN IF NOT EXISTS retry_base_delay_ms INTEGER NOT NULL DEFAULT 500;
ALTER TABLE chain_transaction_inbox
  ADD COLUMN IF NOT EXISTS attempts_in_cycle INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chain_transaction_inbox
  ADD COLUMN IF NOT EXISTS retry_exhausted_at TIMESTAMPTZ;
ALTER TABLE chain_transaction_inbox
  ADD COLUMN IF NOT EXISTS manual_recovery_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chain_transaction_inbox
  ADD COLUMN IF NOT EXISTS last_manual_recovery_at TIMESTAMPTZ;

ALTER TABLE listener_heartbeats
  ADD COLUMN IF NOT EXISTS exhausted_transactions INTEGER NOT NULL DEFAULT 0;

-- Legacy retry/terminal checks reject the transitional backfill states. The
-- whole migration is transactional; install the widened checks below after
-- every legacy row has been converted.
ALTER TABLE chain_transaction_inbox
  DROP CONSTRAINT IF EXISTS chain_transaction_inbox_retry_check;
ALTER TABLE chain_transaction_inbox
  DROP CONSTRAINT IF EXISTS chain_transaction_inbox_terminal_check;

UPDATE chain_transaction_inbox
SET attempts_in_cycle = CASE
      WHEN processing_status IN ('PROCESSING', 'FAILED') THEN LEAST(attempts, retry_max_attempts)
      ELSE 0
    END
WHERE attempts_in_cycle = 0 AND attempts > 0;

UPDATE chain_transaction_inbox
SET next_attempt_at = NULL,
    retry_exhausted_at = statement_timestamp(),
    terminal_at = statement_timestamp(),
    purge_after = statement_timestamp() + INTERVAL '4 hours',
    updated_at = statement_timestamp()
WHERE processing_status = 'FAILED'
  AND error_retryable = TRUE
  AND attempts_in_cycle >= retry_max_attempts
  AND retry_exhausted_at IS NULL;

UPDATE chain_transaction_inbox
SET terminal_at = statement_timestamp(),
    purge_after = statement_timestamp() + INTERVAL '4 hours',
    updated_at = statement_timestamp()
WHERE processing_status = 'FAILED'
  AND error_retryable = FALSE
  AND terminal_at IS NULL;

ALTER TABLE chain_transaction_inbox
  DROP CONSTRAINT IF EXISTS chain_transaction_inbox_error_check;
ALTER TABLE chain_transaction_inbox
  ADD CONSTRAINT chain_transaction_inbox_error_check CHECK (
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
        'CATCH_UP_WINDOW_EXCEEDED',
        'WORKER_LEASE_EXPIRED'
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
  );

ALTER TABLE chain_transaction_inbox
  DROP CONSTRAINT IF EXISTS chain_transaction_inbox_retry_check;
ALTER TABLE chain_transaction_inbox
  ADD CONSTRAINT chain_transaction_inbox_retry_check CHECK (
    (
      processing_status = 'FAILED'
      AND error_retryable = TRUE
      AND retry_exhausted_at IS NULL
      AND next_attempt_at IS NOT NULL
      AND terminal_at IS NULL
      AND purge_after IS NULL
    ) OR (
      processing_status = 'FAILED'
      AND error_retryable = TRUE
      AND retry_exhausted_at IS NOT NULL
      AND next_attempt_at IS NULL
      AND terminal_at IS NOT NULL
      AND purge_after IS NOT NULL
    ) OR (
      processing_status = 'FAILED'
      AND error_retryable = FALSE
      AND retry_exhausted_at IS NULL
      AND next_attempt_at IS NULL
      AND terminal_at IS NOT NULL
      AND purge_after IS NOT NULL
    ) OR (
      processing_status <> 'FAILED'
      AND retry_exhausted_at IS NULL
      AND next_attempt_at IS NULL
    )
  );

ALTER TABLE chain_transaction_inbox
  DROP CONSTRAINT IF EXISTS chain_transaction_inbox_terminal_check;
ALTER TABLE chain_transaction_inbox
  ADD CONSTRAINT chain_transaction_inbox_terminal_check CHECK (
    (terminal_at IS NULL AND purge_after IS NULL)
    OR (
      terminal_at IS NOT NULL
      AND purge_after IS NOT NULL
      AND purge_after = terminal_at + INTERVAL '4 hours'
      AND (
        (
          processing_status = 'PROCESSED'
          AND target_confirmation_status IN ('finalized', 'orphaned')
          AND processed_at IS NOT NULL
        )
        OR processing_status = 'FAILED'
      )
    )
  );

ALTER TABLE chain_transaction_inbox
  DROP CONSTRAINT IF EXISTS chain_transaction_inbox_retry_policy_check;
ALTER TABLE chain_transaction_inbox
  ADD CONSTRAINT chain_transaction_inbox_retry_policy_check CHECK (
    retry_max_attempts BETWEEN 1 AND 100
    AND retry_base_delay_ms BETWEEN 1 AND 60000
    AND attempts_in_cycle BETWEEN 0 AND retry_max_attempts
    AND attempts_in_cycle <= attempts
    AND (processing_status <> 'PENDING' OR attempts_in_cycle < retry_max_attempts)
  );

ALTER TABLE chain_transaction_inbox
  DROP CONSTRAINT IF EXISTS chain_transaction_inbox_manual_recovery_check;
ALTER TABLE chain_transaction_inbox
  ADD CONSTRAINT chain_transaction_inbox_manual_recovery_check CHECK (
    manual_recovery_count >= 0
    AND (
      (manual_recovery_count = 0 AND last_manual_recovery_at IS NULL)
      OR (manual_recovery_count > 0 AND last_manual_recovery_at IS NOT NULL)
    )
  );

ALTER TABLE listener_heartbeats
  DROP CONSTRAINT IF EXISTS listener_heartbeats_exhausted_transactions_check;
ALTER TABLE listener_heartbeats
  ADD CONSTRAINT listener_heartbeats_exhausted_transactions_check CHECK (
    exhausted_transactions >= 0
  );

CREATE TABLE IF NOT EXISTS transaction_inbox_recoveries (
  signature TEXT NOT NULL REFERENCES chain_transaction_inbox(signature) ON DELETE CASCADE,
  exhausted_at TIMESTAMPTZ NOT NULL,
  recovered_at TIMESTAMPTZ NOT NULL,
  lifetime_attempts INTEGER NOT NULL CHECK (lifetime_attempts > 0),
  cycle_attempts INTEGER NOT NULL CHECK (cycle_attempts > 0),
  retry_max_attempts INTEGER NOT NULL CHECK (retry_max_attempts BETWEEN 1 AND 100),
  retry_base_delay_ms INTEGER NOT NULL CHECK (retry_base_delay_ms BETWEEN 1 AND 60000),
  recovery_source TEXT NOT NULL CHECK (recovery_source = 'LOCAL_CLI'),
  PRIMARY KEY (signature, exhausted_at),
  CHECK (recovered_at >= exhausted_at)
);

DROP INDEX IF EXISTS chain_transaction_inbox_claim_order_idx;
CREATE INDEX chain_transaction_inbox_claim_order_idx
  ON chain_transaction_inbox (observed_slot, signature)
  WHERE processing_status = 'PENDING'
     OR processing_status = 'PROCESSING'
     OR (
       processing_status = 'FAILED'
       AND error_retryable = TRUE
       AND retry_exhausted_at IS NULL
     );

DROP INDEX IF EXISTS chain_transaction_inbox_retry_idx;
CREATE INDEX chain_transaction_inbox_retry_idx
  ON chain_transaction_inbox (next_attempt_at, observed_slot, signature)
  WHERE processing_status = 'FAILED'
    AND error_retryable = TRUE
    AND retry_exhausted_at IS NULL;

CREATE INDEX IF NOT EXISTS chain_transaction_inbox_exhausted_idx
  ON chain_transaction_inbox (retry_exhausted_at, observed_slot, signature)
  WHERE processing_status = 'FAILED' AND retry_exhausted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS transaction_inbox_recoveries_recovered_idx
  ON transaction_inbox_recoveries (recovered_at, signature);
