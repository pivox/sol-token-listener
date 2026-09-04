CREATE TABLE IF NOT EXISTS execution_live_rpc_budgets (
  intent_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  artifact_id TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  initial_calls_used INTEGER NOT NULL,
  calls_reserved INTEGER NOT NULL,
  calls_limit INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
    DEFAULT date_trunc('milliseconds', statement_timestamp()),
  PRIMARY KEY (intent_id, attempt_number),
  CONSTRAINT execution_live_rpc_budgets_attempt_fkey
    FOREIGN KEY (intent_id, attempt_number)
    REFERENCES execution_attempts (intent_id, attempt_number) ON DELETE CASCADE,
  CONSTRAINT execution_live_rpc_budgets_artifact_fkey
    FOREIGN KEY (artifact_id)
    REFERENCES execution_signed_transactions (artifact_id) ON DELETE CASCADE,
  CONSTRAINT execution_live_rpc_budgets_identity_check CHECK (
    intent_id ~ '^execution_intent_[0-9a-f]{64}$'
    AND attempt_number > 0
    AND artifact_id ~ '^execution_signed_transaction_[0-9a-f]{64}$'
    AND octet_length(provider_id) BETWEEN 1 AND 64
    AND provider_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
  ),
  CONSTRAINT execution_live_rpc_budgets_calls_check CHECK (
    initial_calls_used BETWEEN 0 AND calls_reserved
    AND calls_reserved BETWEEN 0 AND calls_limit
    AND calls_limit BETWEEN 12 AND 16
  ),
  CONSTRAINT execution_live_rpc_budgets_temporal_check CHECK (
    isfinite(created_at)
    AND created_at >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
    AND created_at <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds', created_at) = created_at
  )
);
