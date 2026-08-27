CREATE TABLE IF NOT EXISTS listener_strict_catch_up_failures (
  failure_id TEXT PRIMARY KEY,
  checkpoint_key TEXT NOT NULL,
  previous_slot NUMERIC(78,0),
  previous_signature TEXT,
  provider_id TEXT NOT NULL,
  observed_head_slot NUMERIC(78,0),
  reason_code TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  CONSTRAINT listener_strict_catch_up_failures_id_check CHECK (
    failure_id ~ '^strict_catchup_failure_[0-9a-f]{64}$'
  ),
  CONSTRAINT listener_strict_catch_up_failures_key_check CHECK (
    checkpoint_key IN ('launchpad', 'market')
  ),
  CONSTRAINT listener_strict_catch_up_failures_previous_check CHECK (
    (previous_slot IS NULL) = (previous_signature IS NULL)
    AND (previous_slot IS NULL OR previous_slot >= 0)
    AND (
      previous_signature IS NULL
      OR (
        previous_signature = BTRIM(previous_signature)
        AND OCTET_LENGTH(previous_signature) BETWEEN 1 AND 128
      )
    )
  ),
  CONSTRAINT listener_strict_catch_up_failures_provider_check CHECK (
    provider_id IN ('primary', 'fallback-1', 'fallback-2', 'fallback-3')
  ),
  CONSTRAINT listener_strict_catch_up_failures_head_check CHECK (
    observed_head_slot IS NULL OR observed_head_slot >= 0
  ),
  CONSTRAINT listener_strict_catch_up_failures_reason_check CHECK (
    reason_code IN ('CATCH_UP_WINDOW_EXCEEDED')
  ),
  CONSTRAINT listener_strict_catch_up_failures_lifecycle_check CHECK (
    (resolved_at IS NULL AND purge_after IS NULL)
    OR (
      resolved_at IS NOT NULL
      AND purge_after = resolved_at + INTERVAL '4 hours'
    )
  )
);

CREATE INDEX IF NOT EXISTS listener_strict_catch_up_failures_unresolved_boundary_idx
  ON listener_strict_catch_up_failures (checkpoint_key, previous_slot, previous_signature)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS listener_strict_catch_up_failures_resolved_purge_idx
  ON listener_strict_catch_up_failures (purge_after)
  WHERE resolved_at IS NOT NULL;
