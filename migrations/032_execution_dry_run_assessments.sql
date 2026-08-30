CREATE UNIQUE INDEX IF NOT EXISTS execution_intents_assessment_identity_idx
  ON execution_intents (id, strategy_id, strategy_version, decision_fingerprint);

CREATE TABLE IF NOT EXISTS execution_dry_run_assessments (
  assessment_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  specification_version TEXT NOT NULL DEFAULT '1.4.0',
  evaluator_version INTEGER NOT NULL DEFAULT 1,
  intent_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version INTEGER NOT NULL,
  decision_fingerprint TEXT NOT NULL,
  intent_state_revision BIGINT NOT NULL,
  intent_status TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  result_fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'FOUNDATION_VALIDATED',
  coverage TEXT NOT NULL DEFAULT 'INTENT_AND_LEASE_ONLY',
  quote_status TEXT NOT NULL DEFAULT 'NOT_RUN',
  build_status TEXT NOT NULL DEFAULT 'NOT_RUN',
  simulation_status TEXT NOT NULL DEFAULT 'NOT_RUN',
  signature_status TEXT NOT NULL DEFAULT 'NOT_RUN',
  submission_status TEXT NOT NULL DEFAULT 'NOT_RUN',
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp()),
  CONSTRAINT execution_dry_run_assessments_payload_version_check CHECK (payload_version = 1),
  CONSTRAINT execution_dry_run_assessments_specification_version_check CHECK (
    specification_version = '1.4.0'
  ),
  CONSTRAINT execution_dry_run_assessments_evaluator_version_check CHECK (
    evaluator_version = 1
  ),
  CONSTRAINT execution_dry_run_assessments_identifier_check CHECK (
    assessment_id ~ '^execution_dry_run_assessment_[0-9a-f]{64}$'
    AND intent_id ~ '^execution_intent_[0-9a-f]{64}$'
    AND decision_fingerprint ~ '^[0-9a-f]{64}$'
    AND input_fingerprint ~ '^[0-9a-f]{64}$'
    AND result_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT execution_dry_run_assessments_strategy_check CHECK (
    octet_length(strategy_id) BETWEEN 1 AND 256
    AND strategy_version BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT execution_dry_run_assessments_state_revision_check CHECK (
    intent_state_revision >= 0
  ),
  CONSTRAINT execution_dry_run_assessments_intent_status_check CHECK (
    intent_status IN ('PENDING', 'RETRY_READY')
  ),
  CONSTRAINT execution_dry_run_assessments_outcome_check CHECK (
    outcome = 'FOUNDATION_VALIDATED'
  ),
  CONSTRAINT execution_dry_run_assessments_coverage_check CHECK (
    coverage = 'INTENT_AND_LEASE_ONLY'
  ),
  CONSTRAINT execution_dry_run_assessments_execution_check CHECK (
    quote_status = 'NOT_RUN'
    AND build_status = 'NOT_RUN'
    AND simulation_status = 'NOT_RUN'
    AND signature_status = 'NOT_RUN'
    AND submission_status = 'NOT_RUN'
  ),
  CONSTRAINT execution_dry_run_assessments_recorded_at_check CHECK (
    isfinite(recorded_at)
    AND recorded_at >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
    AND recorded_at <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds', recorded_at) = recorded_at
  ),
  CONSTRAINT execution_dry_run_assessments_intent_evaluator_unique UNIQUE (intent_id, evaluator_version),
  CONSTRAINT execution_dry_run_assessments_intent_identity_fkey FOREIGN KEY (
    intent_id, strategy_id, strategy_version, decision_fingerprint
  ) REFERENCES execution_intents (id, strategy_id, strategy_version, decision_fingerprint) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS execution_dry_run_assessments_recorded_at_intent_id_idx
  ON execution_dry_run_assessments (recorded_at, intent_id);
