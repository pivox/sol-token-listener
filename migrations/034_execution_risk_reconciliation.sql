-- Executor #51-E durable risk, provider quota and reconciliation foundation.
-- No signing material, provider endpoint, transaction bytes or financial JSON
-- is stored here. Financial NUMERIC columns are deliberately unscaled because
-- PostgreSQL rounds NUMERIC(p,0) before CHECK constraints are evaluated.

CREATE TABLE IF NOT EXISTS execution_wallet_generations (
  generation_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  wallet_public_key TEXT NOT NULL,
  cluster TEXT NOT NULL,
  genesis_hash TEXT NOT NULL,
  generation INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp()),
  retired_at TIMESTAMPTZ,
  CONSTRAINT execution_wallet_generations_identity_unique
    UNIQUE (wallet_public_key, cluster, generation),
  CONSTRAINT execution_wallet_generations_payload_check CHECK (payload_version = 1),
  CONSTRAINT execution_wallet_generations_identifiers_check CHECK (
    generation_id ~ '^execution_wallet_generation_[0-9a-f]{64}$'
    AND wallet_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND genesis_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND cluster IN ('mainnet-beta', 'devnet', 'testnet')
    AND generation BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT execution_wallet_generations_temporal_check CHECK (
    isfinite(created_at)
    AND created_at BETWEEN TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
      AND TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds', created_at) = created_at
    AND (retired_at IS NULL OR (
      isfinite(retired_at) AND retired_at >= created_at
      AND retired_at <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
      AND date_trunc('milliseconds', retired_at) = retired_at
    ))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS execution_wallet_generations_active_unique
  ON execution_wallet_generations (cluster) WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS execution_wallet_risk_state (
  generation_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  state_revision BIGINT NOT NULL DEFAULT 0,
  reconciled_capital_lamports NUMERIC NOT NULL,
  reserved_exposure_raw NUMERIC NOT NULL,
  open_positions INTEGER NOT NULL DEFAULT 0,
  conservative_drawdown_raw NUMERIC NOT NULL,
  consecutive_technical_failures SMALLINT NOT NULL DEFAULT 0,
  unknown_block BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp()),
  CONSTRAINT execution_wallet_risk_state_generation_fkey
    FOREIGN KEY (generation_id)
    REFERENCES execution_wallet_generations (generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_wallet_risk_state_payload_check CHECK (payload_version = 1),
  CONSTRAINT execution_wallet_risk_state_revision_check CHECK (state_revision >= 0),
  CONSTRAINT execution_wallet_risk_state_counts_check CHECK (
    open_positions BETWEEN 0 AND 2147483647
    AND consecutive_technical_failures BETWEEN 0 AND 32767
  ),
  CONSTRAINT execution_wallet_risk_state_amounts_check CHECK (
    reconciled_capital_lamports <> 'NaN'::NUMERIC
    AND reconciled_capital_lamports >= 0
    AND reconciled_capital_lamports = trunc(reconciled_capital_lamports)
    AND scale(reconciled_capital_lamports) = 0
    AND reconciled_capital_lamports < 18446744073709551616
    AND reserved_exposure_raw <> 'NaN'::NUMERIC
    AND reserved_exposure_raw >= 0
    AND reserved_exposure_raw = trunc(reserved_exposure_raw)
    AND scale(reserved_exposure_raw) = 0
    AND reserved_exposure_raw < 18446744073709551616
    AND conservative_drawdown_raw <> 'NaN'::NUMERIC
    AND conservative_drawdown_raw >= 0
    AND conservative_drawdown_raw = trunc(conservative_drawdown_raw)
    AND scale(conservative_drawdown_raw) = 0
    AND conservative_drawdown_raw < 18446744073709551616
  ),
  CONSTRAINT execution_wallet_risk_state_temporal_check CHECK (
    isfinite(updated_at)
    AND updated_at BETWEEN TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
      AND TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds', updated_at) = updated_at
  )
);

CREATE TABLE IF NOT EXISTS execution_wallet_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  snapshot_fingerprint TEXT NOT NULL UNIQUE,
  generation_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  state_revision BIGINT NOT NULL,
  slot BIGINT NOT NULL,
  block_time TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL,
  commitment TEXT NOT NULL,
  wallet_lamports NUMERIC NOT NULL,
  token_balance_count INTEGER NOT NULL,
  open_positions INTEGER NOT NULL,
  realized_net_pnl_raw NUMERIC NOT NULL,
  superseded_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  CONSTRAINT execution_wallet_snapshots_generation_revision_unique
    UNIQUE (generation_id, state_revision),
  CONSTRAINT execution_wallet_snapshots_generation_fkey
    FOREIGN KEY (generation_id)
    REFERENCES execution_wallet_generations (generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_wallet_snapshots_identity_check CHECK (
    payload_version = 1
    AND snapshot_id ~ '^execution_wallet_snapshot_[0-9a-f]{64}$'
    AND snapshot_fingerprint ~ '^[0-9a-f]{64}$'
    AND octet_length(provider_id) BETWEEN 1 AND 256
    AND state_revision >= 0 AND slot >= 0
    AND commitment = 'finalized'
    AND token_balance_count BETWEEN 0 AND 2147483647
    AND open_positions BETWEEN 0 AND 2147483647
  ),
  CONSTRAINT execution_wallet_snapshots_amounts_check CHECK (
    wallet_lamports <> 'NaN'::NUMERIC
    AND wallet_lamports >= 0 AND wallet_lamports = trunc(wallet_lamports)
    AND scale(wallet_lamports) = 0
    AND wallet_lamports < 18446744073709551616
    AND realized_net_pnl_raw <> 'NaN'::NUMERIC
    AND realized_net_pnl_raw = trunc(realized_net_pnl_raw)
    AND scale(realized_net_pnl_raw) = 0
    AND realized_net_pnl_raw BETWEEN
      -170141183460469231731687303715884105728
      AND 170141183460469231731687303715884105727
  ),
  CONSTRAINT execution_wallet_snapshots_temporal_check CHECK (
    isfinite(observed_at)
    AND observed_at BETWEEN TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
      AND TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds', observed_at) = observed_at
    AND (block_time IS NULL OR (
      isfinite(block_time) AND date_trunc('milliseconds', block_time) = block_time
      AND block_time BETWEEN TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
        AND TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    ))
    AND (superseded_at IS NULL OR (
      isfinite(superseded_at) AND superseded_at >= observed_at
      AND date_trunc('milliseconds', superseded_at) = superseded_at
    ))
    AND (purge_after IS NULL OR purge_after = superseded_at + INTERVAL '4 hours')
  ),
  CONSTRAINT execution_wallet_snapshots_retention_check CHECK (
    (superseded_at IS NULL AND purge_after IS NULL)
    OR (superseded_at IS NOT NULL AND purge_after IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS execution_wallet_snapshots_generation_observed_idx
  ON execution_wallet_snapshots (generation_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS execution_provider_usage_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  snapshot_fingerprint TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  billing_period_id TEXT NOT NULL,
  billing_period_started_at TIMESTAMPTZ NOT NULL,
  billing_period_ends_at TIMESTAMPTZ NOT NULL,
  limit_units NUMERIC NOT NULL,
  used_units NUMERIC NOT NULL,
  measured_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  provenance TEXT NOT NULL,
  quota_state TEXT NOT NULL,
  superseded_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  CONSTRAINT execution_provider_usage_snapshots_period_measure_unique
    UNIQUE (provider_id, billing_period_id, measured_at),
  CONSTRAINT execution_provider_usage_snapshots_identity_check CHECK (
    payload_version = 1
    AND snapshot_id ~ '^execution_provider_usage_[0-9a-f]{64}$'
    AND snapshot_fingerprint ~ '^[0-9a-f]{64}$'
    AND octet_length(provider_id) BETWEEN 1 AND 256
    AND octet_length(plan_id) BETWEEN 1 AND 128
    AND octet_length(billing_period_id) BETWEEN 1 AND 128
    AND provenance IN ('AUTHORITATIVE_PROBE', 'OPERATOR_REPORT')
    AND quota_state IN ('NORMAL', 'ENTRY_BLOCKED', 'EXIT_ONLY', 'UNKNOWN')
  ),
  CONSTRAINT execution_provider_usage_snapshots_units_check CHECK (
    limit_units <> 'NaN'::NUMERIC AND limit_units > 0
    AND limit_units = trunc(limit_units) AND scale(limit_units) = 0
    AND limit_units < 18446744073709551616
    AND used_units <> 'NaN'::NUMERIC AND used_units >= 0
    AND used_units = trunc(used_units) AND scale(used_units) = 0
    AND used_units < 18446744073709551616
    AND used_units <= limit_units
  ),
  CONSTRAINT execution_provider_usage_snapshots_temporal_check CHECK (
    isfinite(billing_period_started_at) AND isfinite(billing_period_ends_at)
    AND isfinite(measured_at) AND isfinite(expires_at)
    AND date_trunc('milliseconds', billing_period_started_at) = billing_period_started_at
    AND date_trunc('milliseconds', billing_period_ends_at) = billing_period_ends_at
    AND date_trunc('milliseconds', measured_at) = measured_at
    AND date_trunc('milliseconds', expires_at) = expires_at
    AND billing_period_ends_at > billing_period_started_at
    AND measured_at >= billing_period_started_at
    AND measured_at < billing_period_ends_at
    AND expires_at >= measured_at AND expires_at <= billing_period_ends_at
    AND (superseded_at IS NULL OR (
      isfinite(superseded_at) AND superseded_at >= measured_at
      AND date_trunc('milliseconds', superseded_at) = superseded_at
    ))
    AND (purge_after IS NULL OR purge_after = superseded_at + INTERVAL '4 hours')
  ),
  CONSTRAINT execution_provider_usage_snapshots_retention_check CHECK (
    (superseded_at IS NULL AND purge_after IS NULL)
    OR (superseded_at IS NOT NULL AND purge_after IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS execution_provider_usage_snapshots_period_idx
  ON execution_provider_usage_snapshots
    (provider_id, billing_period_started_at DESC, measured_at DESC);

CREATE TABLE IF NOT EXISTS execution_provider_usage_counters (
  operation_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  snapshot_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  billing_period_id TEXT NOT NULL,
  category TEXT NOT NULL,
  logical_operation_id TEXT NOT NULL,
  units NUMERIC NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp()),
  CONSTRAINT execution_provider_usage_counters_replay_unique
    UNIQUE (provider_id, billing_period_id, category, logical_operation_id),
  CONSTRAINT execution_provider_usage_counters_snapshot_fkey
    FOREIGN KEY (snapshot_id)
    REFERENCES execution_provider_usage_snapshots (snapshot_id) ON DELETE RESTRICT,
  CONSTRAINT execution_provider_usage_counters_identity_check CHECK (
    payload_version = 1
    AND operation_id ~ '^execution_provider_operation_[0-9a-f]{64}$'
    AND octet_length(provider_id) BETWEEN 1 AND 256
    AND octet_length(billing_period_id) BETWEEN 1 AND 128
    AND octet_length(logical_operation_id) BETWEEN 1 AND 256
    AND category IN ('ENTRY', 'EXIT', 'CONFIRMATION', 'RECONCILIATION', 'TELEMETRY')
  ),
  CONSTRAINT execution_provider_usage_counters_units_check CHECK (
    units <> 'NaN'::NUMERIC AND units > 0
    AND units = trunc(units) AND scale(units) = 0
    AND units < 18446744073709551616
  ),
  CONSTRAINT execution_provider_usage_counters_temporal_check CHECK (
    isfinite(recorded_at)
    AND date_trunc('milliseconds', recorded_at) = recorded_at
  )
);

CREATE INDEX IF NOT EXISTS execution_provider_usage_counters_period_idx
  ON execution_provider_usage_counters (provider_id, billing_period_id, recorded_at);

CREATE TABLE IF NOT EXISTS execution_provider_rate_limit_events (
  event_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  provider_id TEXT NOT NULL,
  billing_period_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  purge_after TIMESTAMPTZ NOT NULL,
  CONSTRAINT execution_provider_rate_limit_events_identity_check CHECK (
    payload_version = 1
    AND event_id ~ '^execution_provider_rate_limit_[0-9a-f]{64}$'
    AND octet_length(provider_id) BETWEEN 1 AND 256
    AND octet_length(billing_period_id) BETWEEN 1 AND 128
    AND octet_length(endpoint_id) BETWEEN 1 AND 128
    AND endpoint_id !~ '://'
  ),
  CONSTRAINT execution_provider_rate_limit_events_temporal_check CHECK (
    isfinite(observed_at) AND date_trunc('milliseconds', observed_at) = observed_at
    AND purge_after = observed_at + INTERVAL '4 hours'
  )
);

CREATE INDEX IF NOT EXISTS execution_provider_rate_limit_events_recent_idx
  ON execution_provider_rate_limit_events (provider_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS execution_risk_admission_reports (
  report_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  report_fingerprint TEXT NOT NULL UNIQUE,
  intent_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  policy_fingerprint TEXT NOT NULL,
  wallet_snapshot_fingerprint TEXT NOT NULL,
  provider_snapshot_fingerprint TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_code TEXT,
  quote_amount_raw NUMERIC NOT NULL,
  projected_capital_raw NUMERIC NOT NULL,
  projected_exposure_raw NUMERIC NOT NULL,
  projected_drawdown_raw NUMERIC NOT NULL,
  quota_state TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp()),
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  CONSTRAINT execution_risk_admission_reports_intent_unique UNIQUE (intent_id),
  CONSTRAINT execution_risk_admission_reports_intent_fkey
    FOREIGN KEY (intent_id)
    REFERENCES execution_intents (id) ON DELETE RESTRICT,
  CONSTRAINT execution_risk_admission_reports_generation_fkey
    FOREIGN KEY (generation_id)
    REFERENCES execution_wallet_generations (generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_risk_admission_reports_identity_check CHECK (
    payload_version = 1
    AND report_id ~ '^execution_risk_admission_[0-9a-f]{64}$'
    AND report_fingerprint ~ '^[0-9a-f]{64}$'
    AND policy_fingerprint ~ '^[0-9a-f]{64}$'
    AND wallet_snapshot_fingerprint ~ '^[0-9a-f]{64}$'
    AND provider_snapshot_fingerprint ~ '^[0-9a-f]{64}$'
    AND decision IN ('ADMITTED', 'REJECTED')
    AND quota_state IN ('NORMAL', 'ENTRY_BLOCKED', 'EXIT_ONLY', 'UNKNOWN')
    AND (reason_code IS NULL OR reason_code IN (
      'WALLET_MISMATCH', 'GENESIS_MISMATCH', 'CAPITAL_LIMIT_EXCEEDED',
      'EXPOSURE_LIMIT_EXCEEDED', 'DRAWDOWN_LIMIT_EXCEEDED',
      'PROVIDER_USAGE_UNKNOWN', 'PROVIDER_ENTRY_LIMIT_REACHED',
      'PROVIDER_EXIT_ONLY', 'RECONCILIATION_REQUIRED'
    ))
  ),
  CONSTRAINT execution_risk_admission_reports_amounts_check CHECK (
    quote_amount_raw <> 'NaN'::NUMERIC AND quote_amount_raw > 0
    AND quote_amount_raw = trunc(quote_amount_raw) AND scale(quote_amount_raw) = 0
    AND quote_amount_raw < 18446744073709551616
    AND projected_capital_raw <> 'NaN'::NUMERIC AND projected_capital_raw >= 0
    AND projected_capital_raw = trunc(projected_capital_raw)
    AND scale(projected_capital_raw) = 0
    AND projected_capital_raw < 18446744073709551616
    AND projected_exposure_raw <> 'NaN'::NUMERIC AND projected_exposure_raw >= 0
    AND projected_exposure_raw = trunc(projected_exposure_raw)
    AND scale(projected_exposure_raw) = 0
    AND projected_exposure_raw < 18446744073709551616
    AND projected_drawdown_raw <> 'NaN'::NUMERIC AND projected_drawdown_raw >= 0
    AND projected_drawdown_raw = trunc(projected_drawdown_raw)
    AND scale(projected_drawdown_raw) = 0
    AND projected_drawdown_raw < 18446744073709551616
  ),
  CONSTRAINT execution_risk_admission_reports_shape_check CHECK (
    (decision = 'ADMITTED' AND reason_code IS NULL AND terminal_at IS NULL AND purge_after IS NULL)
    OR (decision = 'REJECTED' AND reason_code IS NOT NULL AND terminal_at IS NOT NULL
      AND purge_after = terminal_at + INTERVAL '4 hours')
  ),
  CONSTRAINT execution_risk_admission_reports_temporal_check CHECK (
    isfinite(recorded_at) AND date_trunc('milliseconds', recorded_at) = recorded_at
    AND (terminal_at IS NULL OR (
      isfinite(terminal_at) AND terminal_at >= recorded_at
      AND date_trunc('milliseconds', terminal_at) = terminal_at
    ))
  )
);

CREATE INDEX IF NOT EXISTS execution_risk_admission_reports_generation_idx
  ON execution_risk_admission_reports (generation_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS execution_exposure_reservations (
  reservation_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  intent_id TEXT NOT NULL UNIQUE,
  generation_id TEXT NOT NULL,
  admission_report_id TEXT NOT NULL UNIQUE,
  position_id TEXT NOT NULL,
  side TEXT NOT NULL,
  mint TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  maximum_amount_raw NUMERIC NOT NULL,
  intent_fingerprint TEXT NOT NULL,
  policy_fingerprint TEXT NOT NULL,
  wallet_snapshot_fingerprint TEXT NOT NULL,
  provider_snapshot_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  state_revision BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp()),
  reconciled_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  CONSTRAINT execution_exposure_reservations_intent_fkey
    FOREIGN KEY (intent_id)
    REFERENCES execution_intents (id) ON DELETE RESTRICT,
  CONSTRAINT execution_exposure_reservations_generation_fkey
    FOREIGN KEY (generation_id)
    REFERENCES execution_wallet_generations (generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_exposure_reservations_report_fkey
    FOREIGN KEY (admission_report_id)
    REFERENCES execution_risk_admission_reports (report_id) ON DELETE RESTRICT,
  CONSTRAINT execution_exposure_reservations_identity_check CHECK (
    payload_version = 1
    AND reservation_id ~ '^execution_exposure_reservation_[0-9a-f]{64}$'
    AND octet_length(position_id) BETWEEN 1 AND 256
    AND mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND quote_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND side IN ('BUY', 'SELL')
    AND intent_fingerprint ~ '^[0-9a-f]{64}$'
    AND policy_fingerprint ~ '^[0-9a-f]{64}$'
    AND wallet_snapshot_fingerprint ~ '^[0-9a-f]{64}$'
    AND provider_snapshot_fingerprint ~ '^[0-9a-f]{64}$'
    AND state IN ('RESERVED', 'CONSUMED', 'RELEASED', 'UNKNOWN_HELD')
    AND state_revision >= 0
  ),
  CONSTRAINT execution_exposure_reservations_amount_check CHECK (
    maximum_amount_raw <> 'NaN'::NUMERIC AND maximum_amount_raw > 0
    AND maximum_amount_raw = trunc(maximum_amount_raw)
    AND scale(maximum_amount_raw) = 0
    AND maximum_amount_raw < 18446744073709551616
  ),
  CONSTRAINT execution_exposure_reservations_state_check CHECK (
    (state IN ('RESERVED', 'UNKNOWN_HELD') AND reconciled_at IS NULL AND purge_after IS NULL)
    OR (state IN ('CONSUMED', 'RELEASED') AND reconciled_at IS NOT NULL
      AND purge_after = reconciled_at + INTERVAL '4 hours')
  ),
  CONSTRAINT execution_exposure_reservations_temporal_check CHECK (
    isfinite(created_at) AND date_trunc('milliseconds', created_at) = created_at
    AND (reconciled_at IS NULL OR (
      isfinite(reconciled_at) AND reconciled_at >= created_at
      AND date_trunc('milliseconds', reconciled_at) = reconciled_at
    ))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS execution_exposure_reservations_position_side_active_unique
  ON execution_exposure_reservations (generation_id, position_id, side)
  WHERE state IN ('RESERVED', 'UNKNOWN_HELD');

CREATE TABLE IF NOT EXISTS execution_reconciliation_evidence (
  evidence_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  evidence_fingerprint TEXT NOT NULL UNIQUE,
  intent_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  reservation_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  side TEXT NOT NULL,
  signature TEXT NOT NULL,
  blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  message_hash TEXT NOT NULL,
  build_fingerprint TEXT NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  signature_history TEXT NOT NULL,
  confirmation_status TEXT NOT NULL,
  finalized_block_height BIGINT NOT NULL,
  observed_slot BIGINT,
  observed_transaction_fingerprint TEXT,
  fee_lamports NUMERIC NOT NULL,
  wallet_lamport_delta NUMERIC NOT NULL,
  base_delta_raw NUMERIC NOT NULL,
  quote_delta_raw NUMERIC NOT NULL,
  unexpected_residual_token_balance_raw NUMERIC NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  finalized_at TIMESTAMPTZ,
  result TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  purge_after TIMESTAMPTZ,
  CONSTRAINT execution_reconciliation_evidence_attempt_unique
    UNIQUE (intent_id, attempt_number, evidence_fingerprint),
  CONSTRAINT execution_reconciliation_evidence_attempt_fkey
    FOREIGN KEY (intent_id, attempt_number)
    REFERENCES execution_attempts (intent_id, attempt_number) ON DELETE RESTRICT,
  CONSTRAINT execution_reconciliation_evidence_reservation_fkey
    FOREIGN KEY (reservation_id)
    REFERENCES execution_exposure_reservations (reservation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_reconciliation_evidence_generation_fkey
    FOREIGN KEY (generation_id)
    REFERENCES execution_wallet_generations (generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_reconciliation_evidence_identity_check CHECK (
    payload_version = 1
    AND evidence_id ~ '^execution_reconciliation_[0-9a-f]{64}$'
    AND evidence_fingerprint ~ '^[0-9a-f]{64}$'
    AND attempt_number BETWEEN 1 AND 2147483647
    AND octet_length(provider_id) BETWEEN 1 AND 256
    AND side IN ('BUY', 'SELL')
    AND signature ~ '^[1-9A-HJ-NP-Za-km-z]{32,128}$'
    AND blockhash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND last_valid_block_height >= 0 AND finalized_block_height >= 0
    AND message_hash ~ '^[0-9a-f]{64}$'
    AND build_fingerprint ~ '^[0-9a-f]{64}$'
    AND snapshot_fingerprint ~ '^[0-9a-f]{64}$'
    AND (observed_transaction_fingerprint IS NULL
      OR observed_transaction_fingerprint ~ '^[0-9a-f]{64}$')
    AND signature_history IN ('PRESENT', 'ABSENT', 'UNKNOWN')
    AND confirmation_status IN ('FINALIZED', 'CONFIRMED', 'ORPHANED', 'NOT_FOUND')
    AND result IN ('MATCHED', 'NO_EFFECT', 'MISMATCH', 'UNKNOWN')
    AND reason_code IN (
      'INTENT_SUCCEEDED', 'RECONCILIATION_PROVED_NO_EFFECT',
      'RECONCILIATION_REQUIRED', 'BALANCE_MISMATCH',
      'RESIDUAL_TOKEN_BALANCE', 'DOUBLE_ORDER_SUSPECTED'
    )
    AND (observed_slot IS NULL OR observed_slot >= 0)
  ),
  CONSTRAINT execution_reconciliation_evidence_amounts_check CHECK (
    fee_lamports <> 'NaN'::NUMERIC AND fee_lamports >= 0
    AND fee_lamports = trunc(fee_lamports) AND scale(fee_lamports) = 0
    AND fee_lamports < 18446744073709551616
    AND wallet_lamport_delta <> 'NaN'::NUMERIC
    AND wallet_lamport_delta = trunc(wallet_lamport_delta)
    AND scale(wallet_lamport_delta) = 0
    AND wallet_lamport_delta BETWEEN
      -170141183460469231731687303715884105728
      AND 170141183460469231731687303715884105727
    AND base_delta_raw <> 'NaN'::NUMERIC
    AND base_delta_raw = trunc(base_delta_raw) AND scale(base_delta_raw) = 0
    AND base_delta_raw BETWEEN
      -170141183460469231731687303715884105728
      AND 170141183460469231731687303715884105727
    AND quote_delta_raw <> 'NaN'::NUMERIC
    AND quote_delta_raw = trunc(quote_delta_raw) AND scale(quote_delta_raw) = 0
    AND quote_delta_raw BETWEEN
      -170141183460469231731687303715884105728
      AND 170141183460469231731687303715884105727
    AND unexpected_residual_token_balance_raw <> 'NaN'::NUMERIC
    AND unexpected_residual_token_balance_raw >= 0
    AND unexpected_residual_token_balance_raw = trunc(unexpected_residual_token_balance_raw)
    AND scale(unexpected_residual_token_balance_raw) = 0
    AND unexpected_residual_token_balance_raw < 18446744073709551616
  ),
  CONSTRAINT execution_reconciliation_evidence_result_check CHECK (
    (result = 'MATCHED' AND reason_code = 'INTENT_SUCCEEDED' AND finalized_at IS NOT NULL)
    OR (result = 'NO_EFFECT' AND reason_code = 'RECONCILIATION_PROVED_NO_EFFECT'
      AND finalized_at IS NOT NULL)
    OR (result = 'MISMATCH' AND reason_code IN (
      'BALANCE_MISMATCH', 'RESIDUAL_TOKEN_BALANCE', 'DOUBLE_ORDER_SUSPECTED'))
    OR (result = 'UNKNOWN' AND reason_code = 'RECONCILIATION_REQUIRED')
  ),
  CONSTRAINT execution_reconciliation_evidence_retention_check CHECK (
    (result IN ('UNKNOWN', 'MISMATCH') AND purge_after IS NULL)
    OR (result IN ('MATCHED', 'NO_EFFECT') AND finalized_at IS NOT NULL
      AND purge_after = finalized_at + INTERVAL '4 hours')
  ),
  CONSTRAINT execution_reconciliation_evidence_temporal_check CHECK (
    isfinite(observed_at) AND date_trunc('milliseconds', observed_at) = observed_at
    AND (finalized_at IS NULL OR (
      isfinite(finalized_at) AND finalized_at >= observed_at
      AND date_trunc('milliseconds', finalized_at) = finalized_at
    ))
  )
);

CREATE INDEX IF NOT EXISTS execution_reconciliation_evidence_unresolved_idx
  ON execution_reconciliation_evidence (generation_id, observed_at)
  WHERE result IN ('UNKNOWN', 'MISMATCH');

CREATE TABLE IF NOT EXISTS execution_fault_ledger (
  fault_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  generation_id TEXT NOT NULL,
  intent_id TEXT,
  activation_phase TEXT NOT NULL,
  stage TEXT NOT NULL,
  classification TEXT NOT NULL,
  retry_decision TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  consecutive_failure_count SMALLINT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  reset_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  CONSTRAINT execution_fault_ledger_generation_fkey
    FOREIGN KEY (generation_id)
    REFERENCES execution_wallet_generations (generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_fault_ledger_intent_fkey
    FOREIGN KEY (intent_id)
    REFERENCES execution_intents (id) ON DELETE RESTRICT,
  CONSTRAINT execution_fault_ledger_identity_check CHECK (
    payload_version = 1
    AND fault_id ~ '^execution_fault_[0-9a-f]{64}$'
    AND activation_phase IN ('NONE', 'CANARY', 'MICRO_LIVE', 'PILOT')
    AND stage IN ('BUILD', 'SIMULATION', 'PROVIDER', 'SIGNATURE', 'SUBMISSION',
      'CONFIRMATION', 'RECONCILIATION', 'POLICY', 'VALIDATION')
    AND classification IN ('TRANSIENT', 'DETERMINISTIC', 'AMBIGUOUS', 'RESOLVED', 'CRITICAL')
    AND retry_decision IN ('DO_NOT_RETRY', 'RETRY_PRE_SIGNATURE', 'RECONCILE_ONLY', 'RETRY_EXACT_BYTES')
    AND reason_code IN (
      'BUY_SIMULATION_FAILED', 'SELL_SIMULATION_FAILED',
      'EXECUTION_PROVIDER_FAILED', 'EXECUTION_BUILD_FAILED',
      'EXECUTION_EVIDENCE_INVALID', 'SIGNATURE_PERSIST_FAILED',
      'SUBMISSION_AMBIGUOUS', 'CONFIRMATION_TIMEOUT',
      'RECONCILIATION_REQUIRED', 'RECONCILIATION_PROVED_NO_EFFECT',
      'BALANCE_MISMATCH', 'RESIDUAL_TOKEN_BALANCE',
      'DOUBLE_ORDER_SUSPECTED', 'INTENT_SUCCEEDED'
    )
    AND consecutive_failure_count BETWEEN 0 AND 32767
  ),
  CONSTRAINT execution_fault_ledger_temporal_check CHECK (
    isfinite(observed_at) AND date_trunc('milliseconds', observed_at) = observed_at
    AND (reset_at IS NULL OR (
      isfinite(reset_at) AND reset_at >= observed_at
      AND date_trunc('milliseconds', reset_at) = reset_at
    ))
    AND (purge_after IS NULL OR purge_after = reset_at + INTERVAL '4 hours')
  ),
  CONSTRAINT execution_fault_ledger_retention_check CHECK (
    (reset_at IS NULL AND purge_after IS NULL)
    OR (reset_at IS NOT NULL AND purge_after IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS execution_fault_ledger_generation_observed_idx
  ON execution_fault_ledger (generation_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS execution_risk_tombstones (
  tombstone_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp()),
  CONSTRAINT execution_risk_tombstones_source_unique UNIQUE (source_kind, source_id),
  CONSTRAINT execution_risk_tombstones_identity_check CHECK (
    payload_version = 1
    AND tombstone_id ~ '^execution_risk_tombstone_[0-9a-f]{64}$'
    AND source_kind IN ('ADMISSION_REPORT', 'EXPOSURE_RESERVATION')
    AND octet_length(source_id) BETWEEN 1 AND 256
    AND source_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT execution_risk_tombstones_temporal_check CHECK (
    isfinite(recorded_at)
    AND recorded_at BETWEEN TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
      AND TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds', recorded_at) = recorded_at
  )
);
