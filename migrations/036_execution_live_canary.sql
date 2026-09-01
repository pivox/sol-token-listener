ALTER TABLE execution_reconciliation_evidence
  ALTER COLUMN reservation_id DROP NOT NULL;
ALTER TABLE execution_reconciliation_evidence
  DROP CONSTRAINT IF EXISTS execution_reconciliation_evidence_live_side_check;
ALTER TABLE execution_reconciliation_evidence
  ADD CONSTRAINT execution_reconciliation_evidence_live_side_check CHECK (
    (side='BUY' AND reservation_id IS NOT NULL)
    OR (side='SELL' AND reservation_id IS NULL)
  );

-- The final BUY submission fence must compare the mutable wallet/provider state
-- with the exact state that was admitted. Existing rows remain readable after an
-- upgrade but intentionally have no usable baseline and therefore fail closed at
-- the final fence.
ALTER TABLE execution_risk_admission_reports
  ADD COLUMN IF NOT EXISTS risk_state_revision_baseline BIGINT;
ALTER TABLE execution_risk_admission_reports
  ADD COLUMN IF NOT EXISTS conservative_drawdown_raw_baseline NUMERIC;
ALTER TABLE execution_risk_admission_reports
  ADD COLUMN IF NOT EXISTS provider_local_usage_units_baseline NUMERIC;
ALTER TABLE execution_risk_admission_reports
  ADD COLUMN IF NOT EXISTS provider_rate_limit_count_baseline BIGINT;
ALTER TABLE execution_risk_admission_reports
  DROP CONSTRAINT IF EXISTS execution_risk_admission_reports_live_baseline_check;
ALTER TABLE execution_risk_admission_reports
  ADD CONSTRAINT execution_risk_admission_reports_live_baseline_check CHECK (
    (risk_state_revision_baseline IS NULL
      AND conservative_drawdown_raw_baseline IS NULL
      AND provider_local_usage_units_baseline IS NULL
      AND provider_rate_limit_count_baseline IS NULL)
    OR (risk_state_revision_baseline=wallet_state_revision
      AND conservative_drawdown_raw_baseline=projected_drawdown_raw
      AND provider_local_usage_units_baseline <> 'NaN'::NUMERIC
      AND provider_local_usage_units_baseline >= 0
      AND provider_local_usage_units_baseline=trunc(provider_local_usage_units_baseline)
      AND scale(provider_local_usage_units_baseline)=0
      AND provider_local_usage_units_baseline < 18446744073709551616
      AND provider_rate_limit_count_baseline >= 0)
  );

CREATE OR REPLACE FUNCTION reject_execution_admission_baseline_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(
    NEW.risk_state_revision_baseline,
    NEW.conservative_drawdown_raw_baseline,
    NEW.provider_local_usage_units_baseline,
    NEW.provider_rate_limit_count_baseline
  ) IS DISTINCT FROM ROW(
    OLD.risk_state_revision_baseline,
    OLD.conservative_drawdown_raw_baseline,
    OLD.provider_local_usage_units_baseline,
    OLD.provider_rate_limit_count_baseline
  ) THEN
    RAISE EXCEPTION 'execution admission baselines are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS execution_risk_admission_baselines_immutable
  ON execution_risk_admission_reports;
CREATE TRIGGER execution_risk_admission_baselines_immutable
  BEFORE UPDATE ON execution_risk_admission_reports
  FOR EACH ROW EXECUTE FUNCTION reject_execution_admission_baseline_update();

-- A signed transaction can still be proved unsent before the submission fence. Keep this
-- terminal reason closed and shared by the intent, attempt and transition ledgers.
ALTER TABLE execution_intents DROP CONSTRAINT IF EXISTS execution_intents_reason_check;
ALTER TABLE execution_intents ADD CONSTRAINT execution_intents_reason_check CHECK (
  last_reason_code IS NULL OR last_reason_code IN (
    'EXECUTION_STARTED','SIMULATION_SUCCEEDED','ATTEMPT_COMPLETED','RETRY_AUTHORIZED',
    'SIGNATURE_PERSISTED','SUBMISSION_ACCEPTED','CONFIRMATION_OBSERVED',
    'RECONCILIATION_STARTED','INTENT_SUCCEEDED','INTENT_CANCELLED','INTENT_EXPIRED',
    'INTENT_DUPLICATE','INTENT_LEASE_LOST','QUALIFICATION_STALE','DECISION_STALE',
    'QUOTE_STALE','QUOTE_MINT_NOT_ALLOWED','VENUE_UNAVAILABLE','BUY_SIMULATION_FAILED',
    'SELL_SIMULATION_FAILED','SELL_QUOTE_UNAVAILABLE','MINIMUM_AMOUNT_OUT_VIOLATED',
    'UNSUPPORTED_TOKEN_EXTENSION','WALLET_MISMATCH','GENESIS_MISMATCH',
    'CAPITAL_LIMIT_EXCEEDED','EXPOSURE_LIMIT_EXCEEDED','DRAWDOWN_LIMIT_EXCEEDED',
    'PROVIDER_USAGE_UNKNOWN','PROVIDER_ENTRY_LIMIT_REACHED','PROVIDER_EXIT_ONLY',
    'KILL_SWITCH_ACTIVE','HARD_STOP_ACTIVE','ARMING_REQUIRED','ARMING_EXPIRED',
    'SIGNATURE_PERSIST_FAILED','SUBMISSION_AMBIGUOUS','CONFIRMATION_TIMEOUT',
    'RECONCILIATION_REQUIRED','BALANCE_MISMATCH','RESIDUAL_TOKEN_BALANCE',
    'DOUBLE_ORDER_SUSPECTED','RECONCILIATION_PROVED_NO_EFFECT',
    'EXECUTION_PROVIDER_FAILED','EXECUTION_BUILD_FAILED','EXECUTION_EVIDENCE_INVALID',
    'PRE_SUBMISSION_REVOKED_NO_SEND'
  )
);
ALTER TABLE execution_attempts DROP CONSTRAINT IF EXISTS execution_attempts_reason_check;
ALTER TABLE execution_attempts ADD CONSTRAINT execution_attempts_reason_check CHECK (
  reason_code IS NULL OR reason_code IN (
    'EXECUTION_STARTED','SIMULATION_SUCCEEDED','ATTEMPT_COMPLETED','RETRY_AUTHORIZED',
    'SIGNATURE_PERSISTED','SUBMISSION_ACCEPTED','CONFIRMATION_OBSERVED',
    'RECONCILIATION_STARTED','INTENT_SUCCEEDED','INTENT_CANCELLED','INTENT_EXPIRED',
    'INTENT_DUPLICATE','INTENT_LEASE_LOST','QUALIFICATION_STALE','DECISION_STALE',
    'QUOTE_STALE','QUOTE_MINT_NOT_ALLOWED','VENUE_UNAVAILABLE','BUY_SIMULATION_FAILED',
    'SELL_SIMULATION_FAILED','SELL_QUOTE_UNAVAILABLE','MINIMUM_AMOUNT_OUT_VIOLATED',
    'UNSUPPORTED_TOKEN_EXTENSION','WALLET_MISMATCH','GENESIS_MISMATCH',
    'CAPITAL_LIMIT_EXCEEDED','EXPOSURE_LIMIT_EXCEEDED','DRAWDOWN_LIMIT_EXCEEDED',
    'PROVIDER_USAGE_UNKNOWN','PROVIDER_ENTRY_LIMIT_REACHED','PROVIDER_EXIT_ONLY',
    'KILL_SWITCH_ACTIVE','HARD_STOP_ACTIVE','ARMING_REQUIRED','ARMING_EXPIRED',
    'SIGNATURE_PERSIST_FAILED','SUBMISSION_AMBIGUOUS','CONFIRMATION_TIMEOUT',
    'RECONCILIATION_REQUIRED','BALANCE_MISMATCH','RESIDUAL_TOKEN_BALANCE',
    'DOUBLE_ORDER_SUSPECTED','RECONCILIATION_PROVED_NO_EFFECT',
    'EXECUTION_PROVIDER_FAILED','EXECUTION_BUILD_FAILED','EXECUTION_EVIDENCE_INVALID',
    'PRE_SUBMISSION_REVOKED_NO_SEND'
  )
);
ALTER TABLE execution_intent_transitions
  DROP CONSTRAINT IF EXISTS execution_intent_transitions_reason_check;
ALTER TABLE execution_intent_transitions
  ADD CONSTRAINT execution_intent_transitions_reason_check CHECK (reason_code IN (
    'EXECUTION_STARTED','SIMULATION_SUCCEEDED','ATTEMPT_COMPLETED','RETRY_AUTHORIZED',
    'SIGNATURE_PERSISTED','SUBMISSION_ACCEPTED','CONFIRMATION_OBSERVED',
    'RECONCILIATION_STARTED','INTENT_SUCCEEDED','INTENT_CANCELLED','INTENT_EXPIRED',
    'INTENT_DUPLICATE','INTENT_LEASE_LOST','QUALIFICATION_STALE','DECISION_STALE',
    'QUOTE_STALE','QUOTE_MINT_NOT_ALLOWED','VENUE_UNAVAILABLE','BUY_SIMULATION_FAILED',
    'SELL_SIMULATION_FAILED','SELL_QUOTE_UNAVAILABLE','MINIMUM_AMOUNT_OUT_VIOLATED',
    'UNSUPPORTED_TOKEN_EXTENSION','WALLET_MISMATCH','GENESIS_MISMATCH',
    'CAPITAL_LIMIT_EXCEEDED','EXPOSURE_LIMIT_EXCEEDED','DRAWDOWN_LIMIT_EXCEEDED',
    'PROVIDER_USAGE_UNKNOWN','PROVIDER_ENTRY_LIMIT_REACHED','PROVIDER_EXIT_ONLY',
    'KILL_SWITCH_ACTIVE','HARD_STOP_ACTIVE','ARMING_REQUIRED','ARMING_EXPIRED',
    'SIGNATURE_PERSIST_FAILED','SUBMISSION_AMBIGUOUS','CONFIRMATION_TIMEOUT',
    'RECONCILIATION_REQUIRED','BALANCE_MISMATCH','RESIDUAL_TOKEN_BALANCE',
    'DOUBLE_ORDER_SUSPECTED','RECONCILIATION_PROVED_NO_EFFECT',
    'EXECUTION_PROVIDER_FAILED','EXECUTION_BUILD_FAILED','EXECUTION_EVIDENCE_INVALID',
    'PRE_SUBMISSION_REVOKED_NO_SEND'
  ));
ALTER TABLE execution_intents DROP CONSTRAINT IF EXISTS execution_intents_status_reason_check;
ALTER TABLE execution_intents ADD CONSTRAINT execution_intents_status_reason_check CHECK (
  (status='PENDING' AND last_reason_code IS NULL)
  OR (status='PROCESSING' AND last_reason_code='EXECUTION_STARTED')
  OR (status='SIMULATED' AND last_reason_code='SIMULATION_SUCCEEDED')
  OR (status='RETRY_READY' AND last_reason_code IN (
    'RECONCILIATION_PROVED_NO_EFFECT','PRE_SUBMISSION_REVOKED_NO_SEND'))
  OR (status='SIGNED_NOT_SUBMITTED' AND last_reason_code='SIGNATURE_PERSISTED')
  OR (status='SUBMITTED' AND last_reason_code='SUBMISSION_ACCEPTED')
  OR (status='CONFIRMED' AND last_reason_code='CONFIRMATION_OBSERVED')
  OR (status='RECONCILING' AND last_reason_code='RECONCILIATION_STARTED')
  OR (status='SUCCEEDED' AND last_reason_code='INTENT_SUCCEEDED')
  OR (status='EXPIRED' AND last_reason_code='INTENT_EXPIRED')
  OR (status='CANCELLED' AND last_reason_code='INTENT_CANCELLED')
  OR (status='UNKNOWN_REQUIRES_RECONCILIATION'
    AND last_reason_code='RECONCILIATION_REQUIRED')
  OR (status='FAILED' AND last_reason_code IS NOT NULL AND last_reason_code NOT IN (
    'EXECUTION_STARTED','SIMULATION_SUCCEEDED','ATTEMPT_COMPLETED','RETRY_AUTHORIZED',
    'SIGNATURE_PERSISTED','SUBMISSION_ACCEPTED','CONFIRMATION_OBSERVED',
    'RECONCILIATION_STARTED','INTENT_SUCCEEDED','INTENT_CANCELLED'))
);
ALTER TABLE execution_intent_transitions
  DROP CONSTRAINT IF EXISTS execution_intent_transitions_status_reason_check;
ALTER TABLE execution_intent_transitions
  ADD CONSTRAINT execution_intent_transitions_status_reason_check CHECK (
    (next_status='PROCESSING' AND reason_code='EXECUTION_STARTED')
    OR (next_status='SIMULATED' AND reason_code='SIMULATION_SUCCEEDED')
    OR (next_status='RETRY_READY' AND reason_code IN (
      'RECONCILIATION_PROVED_NO_EFFECT','PRE_SUBMISSION_REVOKED_NO_SEND'))
    OR (next_status='SIGNED_NOT_SUBMITTED' AND reason_code='SIGNATURE_PERSISTED')
    OR (next_status='SUBMITTED' AND reason_code='SUBMISSION_ACCEPTED')
    OR (next_status='CONFIRMED' AND reason_code='CONFIRMATION_OBSERVED')
    OR (next_status='RECONCILING' AND reason_code='RECONCILIATION_STARTED')
    OR (next_status='SUCCEEDED' AND reason_code='INTENT_SUCCEEDED')
    OR (next_status='EXPIRED' AND reason_code='INTENT_EXPIRED')
    OR (next_status='CANCELLED' AND reason_code='INTENT_CANCELLED')
    OR (next_status='UNKNOWN_REQUIRES_RECONCILIATION'
      AND reason_code='RECONCILIATION_REQUIRED')
    OR (next_status='FAILED' AND reason_code NOT IN (
      'EXECUTION_STARTED','SIMULATION_SUCCEEDED','ATTEMPT_COMPLETED','RETRY_AUTHORIZED',
      'SIGNATURE_PERSISTED','SUBMISSION_ACCEPTED','CONFIRMATION_OBSERVED',
      'RECONCILIATION_STARTED','INTENT_SUCCEEDED','INTENT_CANCELLED'))
  );

CREATE OR REPLACE FUNCTION guard_execution_reconciliation_evidence_resolution()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  resolver execution_reconciliation_evidence%ROWTYPE;
BEGIN
  IF OLD.result <> 'UNKNOWN' OR OLD.resolved_by_evidence_id IS NOT NULL
    OR OLD.resolved_at IS NOT NULL OR OLD.purge_after IS NOT NULL
    OR NEW.resolved_by_evidence_id IS NULL OR NEW.resolved_at IS NULL
    OR NEW.purge_after IS NULL
  THEN
    RAISE EXCEPTION 'invalid reconciliation evidence resolution source'
      USING ERRCODE='55000';
  END IF;
  SELECT * INTO resolver FROM execution_reconciliation_evidence
    WHERE evidence_id=NEW.resolved_by_evidence_id;
  IF NOT FOUND OR resolver.result NOT IN ('MATCHED','NO_EFFECT')
    OR resolver.intent_id <> OLD.intent_id
    OR resolver.attempt_number <> OLD.attempt_number
    OR resolver.generation_id <> OLD.generation_id
    OR resolver.side <> OLD.side
    OR resolver.finalized_at IS NULL
    OR resolver.observed_at <= OLD.observed_at
    OR NEW.resolved_at IS DISTINCT FROM resolver.finalized_at
    OR NEW.purge_after IS DISTINCT FROM NEW.resolved_at + INTERVAL '4 hours'
  THEN
    RAISE EXCEPTION 'invalid reconciliation evidence resolver'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_reconciliation_evidence_resolution_guard
  ON execution_reconciliation_evidence;
CREATE TRIGGER execution_reconciliation_evidence_resolution_guard
  BEFORE UPDATE OF resolved_by_evidence_id,resolved_at,purge_after
  ON execution_reconciliation_evidence
  FOR EACH ROW EXECUTE FUNCTION guard_execution_reconciliation_evidence_resolution();

CREATE TABLE IF NOT EXISTS execution_live_positions (
  position_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  buy_intent_id TEXT NOT NULL UNIQUE,
  generation_id TEXT NOT NULL,
  armament_id TEXT NOT NULL,
  wallet_public_key TEXT NOT NULL,
  mint TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  entry_venue TEXT NOT NULL,
  quote_cost_raw NUMERIC NOT NULL,
  base_amount_raw NUMERIC NOT NULL,
  remaining_base_raw NUMERIC NOT NULL,
  fee_lamports NUMERIC NOT NULL,
  maximum_holding_ms INTEGER NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  exit_deadline_at TIMESTAMPTZ NOT NULL,
  entry_reconciliation_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  state_revision BIGINT NOT NULL DEFAULT 0,
  exit_intent_id TEXT,
  exit_reconciliation_fingerprint TEXT,
  closed_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  CONSTRAINT execution_live_positions_buy_intent_fkey
    FOREIGN KEY (buy_intent_id) REFERENCES execution_intents(id) ON DELETE RESTRICT,
  CONSTRAINT execution_live_positions_generation_fkey
    FOREIGN KEY (generation_id) REFERENCES execution_wallet_generations(generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_live_positions_armament_fkey
    FOREIGN KEY (armament_id) REFERENCES execution_activation_armaments(armament_id) ON DELETE RESTRICT,
  CONSTRAINT execution_live_positions_exit_intent_fkey
    FOREIGN KEY (exit_intent_id) REFERENCES execution_intents(id) ON DELETE RESTRICT,
  CONSTRAINT execution_live_positions_identity_check CHECK (
    payload_version=1
    AND position_id ~ '^execution_live_position_[0-9a-f]{64}$'
    AND buy_intent_id ~ '^execution_intent_[0-9a-f]{64}$'
    AND generation_id ~ '^execution_wallet_generation_[0-9a-f]{64}$'
    AND armament_id ~ '^execution_activation_armament_[0-9a-f]{64}$'
    AND wallet_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND quote_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND entry_venue='PUMP_FUN'
    AND entry_reconciliation_fingerprint ~ '^[0-9a-f]{64}$'
    AND (exit_intent_id IS NULL OR exit_intent_id ~ '^execution_intent_[0-9a-f]{64}$')
    AND (exit_reconciliation_fingerprint IS NULL
      OR exit_reconciliation_fingerprint ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT execution_live_positions_amounts_check CHECK (
    quote_cost_raw <> 'NaN'::NUMERIC AND quote_cost_raw > 0
    AND quote_cost_raw=trunc(quote_cost_raw) AND scale(quote_cost_raw)=0
    AND quote_cost_raw < 18446744073709551616
    AND base_amount_raw <> 'NaN'::NUMERIC AND base_amount_raw > 0
    AND base_amount_raw=trunc(base_amount_raw) AND scale(base_amount_raw)=0
    AND base_amount_raw < 18446744073709551616
    AND remaining_base_raw <> 'NaN'::NUMERIC AND remaining_base_raw >= 0
    AND remaining_base_raw=trunc(remaining_base_raw) AND scale(remaining_base_raw)=0
    AND remaining_base_raw <= base_amount_raw
    AND fee_lamports <> 'NaN'::NUMERIC AND fee_lamports >= 0
    AND fee_lamports=trunc(fee_lamports) AND scale(fee_lamports)=0
    AND fee_lamports < 18446744073709551616
  ),
  CONSTRAINT execution_live_positions_state_check CHECK (
    state IN ('OPEN','EXIT_PENDING','CLOSED','UNKNOWN') AND state_revision >= 0
    AND ((state IN ('OPEN','EXIT_PENDING','UNKNOWN') AND closed_at IS NULL AND purge_after IS NULL)
      OR (state='CLOSED' AND remaining_base_raw=0 AND closed_at IS NOT NULL
        AND exit_intent_id IS NOT NULL AND exit_reconciliation_fingerprint IS NOT NULL
        AND purge_after=closed_at + INTERVAL '4 hours'))
  ),
  CONSTRAINT execution_live_positions_temporal_check CHECK (
    maximum_holding_ms BETWEEN 30000 AND 900000
    AND isfinite(opened_at) AND isfinite(exit_deadline_at)
    AND date_trunc('milliseconds',opened_at)=opened_at
    AND date_trunc('milliseconds',exit_deadline_at)=exit_deadline_at
    AND exit_deadline_at=opened_at + maximum_holding_ms * INTERVAL '1 millisecond'
    AND (closed_at IS NULL OR (isfinite(closed_at)
      AND date_trunc('milliseconds',closed_at)=closed_at AND closed_at >= opened_at))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS execution_live_positions_one_active_per_generation
  ON execution_live_positions(generation_id) WHERE state IN ('OPEN','EXIT_PENDING','UNKNOWN');
CREATE INDEX IF NOT EXISTS execution_live_positions_deadline_idx
  ON execution_live_positions(exit_deadline_at,position_id) WHERE state='OPEN';

CREATE TABLE IF NOT EXISTS execution_exit_authorizations (
  authorization_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  position_id TEXT NOT NULL UNIQUE,
  generation_id TEXT NOT NULL,
  wallet_public_key TEXT NOT NULL,
  mint TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  maximum_base_amount_raw NUMERIC NOT NULL,
  state TEXT NOT NULL,
  state_revision BIGINT NOT NULL DEFAULT 0,
  locked_intent_id TEXT,
  locked_attempt_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  CONSTRAINT execution_exit_authorizations_position_fkey
    FOREIGN KEY (position_id) REFERENCES execution_live_positions(position_id) ON DELETE RESTRICT,
  CONSTRAINT execution_exit_authorizations_generation_fkey
    FOREIGN KEY (generation_id) REFERENCES execution_wallet_generations(generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_exit_authorizations_locked_attempt_fkey
    FOREIGN KEY (locked_intent_id,locked_attempt_number)
    REFERENCES execution_attempts(intent_id,attempt_number) ON DELETE RESTRICT,
  CONSTRAINT execution_exit_authorizations_identity_check CHECK (
    payload_version=1
    AND authorization_id ~ '^execution_exit_authorization_[0-9a-f]{64}$'
    AND position_id ~ '^execution_live_position_[0-9a-f]{64}$'
    AND generation_id ~ '^execution_wallet_generation_[0-9a-f]{64}$'
    AND wallet_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND quote_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  ),
  CONSTRAINT execution_exit_authorizations_amount_check CHECK (
    maximum_base_amount_raw <> 'NaN'::NUMERIC AND maximum_base_amount_raw > 0
    AND maximum_base_amount_raw=trunc(maximum_base_amount_raw)
    AND scale(maximum_base_amount_raw)=0
    AND maximum_base_amount_raw < 18446744073709551616
  ),
  CONSTRAINT execution_exit_authorizations_state_check CHECK (
    state IN ('ACTIVE','LOCKED','CONSUMED','REVOKED') AND state_revision >= 0
    AND ((state='ACTIVE' AND locked_intent_id IS NULL AND locked_attempt_number IS NULL
      AND terminal_at IS NULL AND purge_after IS NULL)
      OR (state='LOCKED' AND locked_intent_id IS NOT NULL AND locked_attempt_number IS NOT NULL
        AND terminal_at IS NULL AND purge_after IS NULL)
      OR (state IN ('CONSUMED','REVOKED') AND terminal_at IS NOT NULL
        AND purge_after=terminal_at + INTERVAL '4 hours'))
  ),
  CONSTRAINT execution_exit_authorizations_temporal_check CHECK (
    isfinite(created_at) AND date_trunc('milliseconds',created_at)=created_at
    AND (terminal_at IS NULL OR (isfinite(terminal_at)
      AND date_trunc('milliseconds',terminal_at)=terminal_at AND terminal_at >= created_at))
  )
);

CREATE TABLE IF NOT EXISTS execution_signed_transactions (
  artifact_id TEXT NOT NULL UNIQUE,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  specification_version SMALLINT NOT NULL,
  intent_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  generation_id TEXT NOT NULL,
  armament_id TEXT,
  reservation_id TEXT,
  exit_authorization_id TEXT,
  provider_id TEXT NOT NULL,
  wallet_public_key TEXT NOT NULL,
  side TEXT NOT NULL,
  effective_venue TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  build_fingerprint TEXT NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  quote_fingerprint TEXT NOT NULL,
  quote_observed_at TIMESTAMPTZ NOT NULL,
  quote_expires_at TIMESTAMPTZ NOT NULL,
  blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  signature TEXT NOT NULL UNIQUE,
  signed_transaction_bytes BYTEA NOT NULL,
  signed_transaction_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  state_revision BIGINT NOT NULL DEFAULT 0,
  signed_at TIMESTAMPTZ NOT NULL,
  signed_simulated_at TIMESTAMPTZ,
  submission_started_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  confirmed_slot BIGINT,
  reconciled_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  PRIMARY KEY (intent_id, attempt_number),
  CONSTRAINT execution_signed_transactions_attempt_fkey
    FOREIGN KEY (intent_id, attempt_number)
    REFERENCES execution_attempts(intent_id, attempt_number) ON DELETE RESTRICT,
  CONSTRAINT execution_signed_transactions_generation_fkey
    FOREIGN KEY (generation_id) REFERENCES execution_wallet_generations(generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_signed_transactions_armament_fkey
    FOREIGN KEY (armament_id) REFERENCES execution_activation_armaments(armament_id) ON DELETE RESTRICT,
  CONSTRAINT execution_signed_transactions_reservation_fkey
    FOREIGN KEY (reservation_id) REFERENCES execution_exposure_reservations(reservation_id)
      ON DELETE RESTRICT,
  CONSTRAINT execution_signed_transactions_exit_authorization_fkey
    FOREIGN KEY (exit_authorization_id)
    REFERENCES execution_exit_authorizations(authorization_id) ON DELETE RESTRICT,
  CONSTRAINT execution_signed_transactions_identity_check CHECK (
    payload_version=1 AND specification_version=1
    AND artifact_id ~ '^execution_signed_transaction_[0-9a-f]{64}$'
    AND intent_id ~ '^execution_intent_[0-9a-f]{64}$'
    AND attempt_number > 0
    AND generation_id ~ '^execution_wallet_generation_[0-9a-f]{64}$'
    AND (armament_id IS NULL OR armament_id ~ '^execution_activation_armament_[0-9a-f]{64}$')
    AND (reservation_id IS NULL
      OR reservation_id ~ '^execution_exposure_reservation_[0-9a-f]{64}$')
    AND (exit_authorization_id IS NULL
      OR exit_authorization_id ~ '^execution_exit_authorization_[0-9a-f]{64}$')
    AND octet_length(provider_id) BETWEEN 1 AND 64
    AND provider_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    AND wallet_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND side IN ('BUY','SELL') AND effective_venue IN ('PUMP_FUN','PUMP_SWAP')
    AND ((side='BUY' AND effective_venue='PUMP_FUN'
      AND armament_id IS NOT NULL AND reservation_id IS NOT NULL
      AND exit_authorization_id IS NULL)
      OR (side='SELL' AND armament_id IS NULL AND reservation_id IS NULL
        AND exit_authorization_id IS NOT NULL))
  ),
  CONSTRAINT execution_signed_transactions_crypto_check CHECK (
    message_hash ~ '^[0-9a-f]{64}$'
    AND build_fingerprint ~ '^[0-9a-f]{64}$'
    AND snapshot_fingerprint ~ '^[0-9a-f]{64}$'
    AND quote_fingerprint ~ '^[0-9a-f]{64}$'
    AND blockhash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND last_valid_block_height >= 0
    AND signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,128}$'
    AND octet_length(signed_transaction_bytes) BETWEEN 1 AND 1232
    AND signed_transaction_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT execution_signed_transactions_state_check CHECK (
    state IN ('PERSISTED','SIGNED_SIMULATED','SUBMISSION_STARTED','ACCEPTED','AMBIGUOUS',
      'CONFIRMED','RECONCILED','REVOKED_NO_SEND') AND state_revision >= 0
    AND (state <> 'PERSISTED' OR (signed_simulated_at IS NULL AND submission_started_at IS NULL
      AND submitted_at IS NULL AND confirmed_at IS NULL AND reconciled_at IS NULL))
    AND (state NOT IN ('SIGNED_SIMULATED','SUBMISSION_STARTED','ACCEPTED','AMBIGUOUS','CONFIRMED','RECONCILED')
      OR signed_simulated_at IS NOT NULL)
    AND (state NOT IN ('SUBMISSION_STARTED','ACCEPTED','AMBIGUOUS','CONFIRMED','RECONCILED')
      OR submission_started_at IS NOT NULL)
    AND (state NOT IN ('ACCEPTED','CONFIRMED') OR submitted_at IS NOT NULL)
    AND (state <> 'CONFIRMED' OR confirmed_at IS NOT NULL)
    AND ((confirmed_at IS NULL) = (confirmed_slot IS NULL))
    AND (confirmed_slot IS NULL OR confirmed_slot >= 0)
    AND (state <> 'RECONCILED' OR reconciled_at IS NOT NULL)
    AND (state <> 'REVOKED_NO_SEND' OR revoked_at IS NOT NULL)
    AND (state='REVOKED_NO_SEND' OR revoked_at IS NULL)
    AND ((state IN ('RECONCILED','REVOKED_NO_SEND')
      AND purge_after=COALESCE(reconciled_at,revoked_at) + INTERVAL '4 hours')
      OR (state NOT IN ('RECONCILED','REVOKED_NO_SEND') AND purge_after IS NULL))
  ),
  CONSTRAINT execution_signed_transactions_temporal_check CHECK (
    isfinite(quote_observed_at) AND isfinite(quote_expires_at)
    AND isfinite(signed_at)
    AND date_trunc('milliseconds',quote_observed_at)=quote_observed_at
    AND date_trunc('milliseconds',quote_expires_at)=quote_expires_at
    AND date_trunc('milliseconds',signed_at)=signed_at
    AND quote_observed_at <= signed_at AND signed_at < quote_expires_at
    AND (signed_simulated_at IS NULL OR (isfinite(signed_simulated_at)
      AND date_trunc('milliseconds',signed_simulated_at)=signed_simulated_at
      AND signed_simulated_at >= signed_at))
    AND (submission_started_at IS NULL OR (isfinite(submission_started_at)
      AND date_trunc('milliseconds',submission_started_at)=submission_started_at
      AND submission_started_at >= signed_at))
    AND (submitted_at IS NULL OR (isfinite(submitted_at)
      AND date_trunc('milliseconds',submitted_at)=submitted_at
      AND submitted_at >= submission_started_at))
    AND (confirmed_at IS NULL OR (isfinite(confirmed_at)
      AND date_trunc('milliseconds',confirmed_at)=confirmed_at
      AND confirmed_at >= submitted_at))
    AND (reconciled_at IS NULL OR (isfinite(reconciled_at)
      AND date_trunc('milliseconds',reconciled_at)=reconciled_at
      AND reconciled_at >= COALESCE(confirmed_at,submission_started_at,signed_at)))
    AND (revoked_at IS NULL OR (isfinite(revoked_at)
      AND date_trunc('milliseconds',revoked_at)=revoked_at AND revoked_at >= signed_at))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS execution_signed_transactions_one_active_intent
  ON execution_signed_transactions(intent_id)
  WHERE state NOT IN ('RECONCILED','REVOKED_NO_SEND');

CREATE TABLE IF NOT EXISTS execution_live_unsigned_simulation_evidence (
  evidence_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  evidence_fingerprint TEXT NOT NULL UNIQUE,
  artifact_id TEXT NOT NULL UNIQUE,
  intent_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  build_fingerprint TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  blockhash_context_slot BIGINT NOT NULL,
  fee_context_slot BIGINT NOT NULL,
  estimated_fee_lamports NUMERIC NOT NULL,
  simulation_slot BIGINT NOT NULL,
  simulated_fee_payer_lamport_debit NUMERIC NOT NULL,
  units_consumed BIGINT NOT NULL,
  simulated_base_delta_raw NUMERIC NOT NULL,
  simulated_quote_delta_raw NUMERIC NOT NULL,
  logs_fingerprint TEXT NOT NULL,
  logs_line_count INTEGER NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT execution_live_unsigned_simulation_artifact_fkey
    FOREIGN KEY (artifact_id) REFERENCES execution_signed_transactions(artifact_id)
      ON DELETE RESTRICT,
  CONSTRAINT execution_live_unsigned_simulation_attempt_fkey
    FOREIGN KEY (intent_id,attempt_number)
      REFERENCES execution_attempts(intent_id,attempt_number) ON DELETE RESTRICT,
  CONSTRAINT execution_live_unsigned_simulation_identity_check CHECK (
    payload_version=1
    AND evidence_id ~ '^execution_live_unsigned_simulation_evidence_[0-9a-f]{64}$'
    AND evidence_fingerprint ~ '^[0-9a-f]{64}$'
    AND artifact_id ~ '^execution_signed_transaction_[0-9a-f]{64}$'
    AND intent_id ~ '^execution_intent_[0-9a-f]{64}$' AND attempt_number > 0
    AND octet_length(provider_id) BETWEEN 1 AND 64
    AND provider_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    AND snapshot_fingerprint ~ '^[0-9a-f]{64}$'
    AND build_fingerprint ~ '^[0-9a-f]{64}$' AND message_hash ~ '^[0-9a-f]{64}$'
    AND blockhash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND last_valid_block_height >= 0 AND blockhash_context_slot >= 0
    AND fee_context_slot >= 0 AND simulation_slot >= blockhash_context_slot
    AND estimated_fee_lamports <> 'NaN'::NUMERIC AND estimated_fee_lamports >= 0
    AND estimated_fee_lamports=trunc(estimated_fee_lamports)
    AND scale(estimated_fee_lamports)=0
    AND estimated_fee_lamports < 18446744073709551616
    AND simulated_fee_payer_lamport_debit <> 'NaN'::NUMERIC
    AND simulated_fee_payer_lamport_debit >= 0
    AND simulated_fee_payer_lamport_debit=trunc(simulated_fee_payer_lamport_debit)
    AND scale(simulated_fee_payer_lamport_debit)=0
    AND simulated_fee_payer_lamport_debit < 18446744073709551616
    AND units_consumed > 0
    AND simulated_base_delta_raw <> 'NaN'::NUMERIC
    AND simulated_base_delta_raw=trunc(simulated_base_delta_raw)
    AND scale(simulated_base_delta_raw)=0
    AND simulated_base_delta_raw BETWEEN -9223372036854775808 AND 9223372036854775807
    AND simulated_quote_delta_raw <> 'NaN'::NUMERIC
    AND simulated_quote_delta_raw=trunc(simulated_quote_delta_raw)
    AND scale(simulated_quote_delta_raw)=0
    AND simulated_quote_delta_raw BETWEEN -9223372036854775808 AND 9223372036854775807
    AND logs_fingerprint ~ '^[0-9a-f]{64}$' AND logs_line_count BETWEEN 0 AND 256
  ),
  CONSTRAINT execution_live_unsigned_simulation_temporal_check CHECK (
    isfinite(recorded_at) AND date_trunc('milliseconds',recorded_at)=recorded_at
  )
);

CREATE TABLE IF NOT EXISTS execution_signed_simulation_evidence (
  evidence_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  evidence_fingerprint TEXT NOT NULL UNIQUE,
  artifact_id TEXT NOT NULL UNIQUE,
  unsigned_simulation_evidence_id TEXT NOT NULL UNIQUE,
  signed_transaction_hash TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  simulation_slot BIGINT NOT NULL,
  units_consumed BIGINT NOT NULL,
  fee_payer_lamport_debit NUMERIC NOT NULL,
  base_delta_raw NUMERIC NOT NULL,
  quote_delta_raw NUMERIC NOT NULL,
  logs_fingerprint TEXT NOT NULL,
  logs_line_count INTEGER NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT execution_signed_simulation_evidence_artifact_fkey
    FOREIGN KEY (artifact_id) REFERENCES execution_signed_transactions(artifact_id)
      ON DELETE RESTRICT,
  CONSTRAINT execution_signed_simulation_evidence_unsigned_fkey
    FOREIGN KEY (unsigned_simulation_evidence_id)
      REFERENCES execution_live_unsigned_simulation_evidence(evidence_id) ON DELETE RESTRICT,
  CONSTRAINT execution_signed_simulation_evidence_identity_check CHECK (
    payload_version=1
    AND evidence_id ~ '^execution_signed_simulation_evidence_[0-9a-f]{64}$'
    AND evidence_fingerprint ~ '^[0-9a-f]{64}$'
    AND artifact_id ~ '^execution_signed_transaction_[0-9a-f]{64}$'
    AND unsigned_simulation_evidence_id
      ~ '^execution_live_unsigned_simulation_evidence_[0-9a-f]{64}$'
    AND signed_transaction_hash ~ '^[0-9a-f]{64}$'
    AND octet_length(provider_id) BETWEEN 1 AND 64
    AND provider_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    AND simulation_slot >= 0 AND units_consumed > 0
    AND fee_payer_lamport_debit <> 'NaN'::NUMERIC
    AND fee_payer_lamport_debit >= 0
    AND fee_payer_lamport_debit=trunc(fee_payer_lamport_debit)
    AND scale(fee_payer_lamport_debit)=0
    AND fee_payer_lamport_debit < 18446744073709551616
    AND base_delta_raw <> 'NaN'::NUMERIC
    AND base_delta_raw=trunc(base_delta_raw) AND scale(base_delta_raw)=0
    AND base_delta_raw BETWEEN -9223372036854775808 AND 9223372036854775807
    AND quote_delta_raw <> 'NaN'::NUMERIC
    AND quote_delta_raw=trunc(quote_delta_raw) AND scale(quote_delta_raw)=0
    AND quote_delta_raw BETWEEN -9223372036854775808 AND 9223372036854775807
    AND logs_fingerprint ~ '^[0-9a-f]{64}$'
    AND logs_line_count BETWEEN 0 AND 256
  ),
  CONSTRAINT execution_signed_simulation_evidence_temporal_check CHECK (
    isfinite(observed_at) AND date_trunc('milliseconds',observed_at)=observed_at
  )
);

CREATE TABLE IF NOT EXISTS execution_pre_submission_revocations (
  revocation_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  revocation_fingerprint TEXT NOT NULL UNIQUE,
  artifact_id TEXT NOT NULL UNIQUE,
  intent_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  generation_id TEXT NOT NULL,
  side TEXT NOT NULL,
  expected_state TEXT NOT NULL,
  expected_revision BIGINT NOT NULL,
  cause_reason_code TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL,
  purge_after TIMESTAMPTZ NOT NULL,
  CONSTRAINT execution_pre_submission_revocations_artifact_fkey
    FOREIGN KEY (artifact_id) REFERENCES execution_signed_transactions(artifact_id)
      ON DELETE CASCADE,
  CONSTRAINT execution_pre_submission_revocations_attempt_fkey
    FOREIGN KEY (intent_id,attempt_number)
      REFERENCES execution_attempts(intent_id,attempt_number) ON DELETE RESTRICT,
  CONSTRAINT execution_pre_submission_revocations_generation_fkey
    FOREIGN KEY (generation_id) REFERENCES execution_wallet_generations(generation_id)
      ON DELETE RESTRICT,
  CONSTRAINT execution_pre_submission_revocations_identity_check CHECK (
    payload_version=1
    AND revocation_id ~ '^execution_pre_submission_revocation_[0-9a-f]{64}$'
    AND revocation_fingerprint ~ '^[0-9a-f]{64}$'
    AND artifact_id ~ '^execution_signed_transaction_[0-9a-f]{64}$'
    AND intent_id ~ '^execution_intent_[0-9a-f]{64}$'
    AND attempt_number > 0
    AND generation_id ~ '^execution_wallet_generation_[0-9a-f]{64}$'
    AND side IN ('BUY','SELL')
    AND expected_state IN ('PERSISTED','SIGNED_SIMULATED')
    AND ((expected_state='PERSISTED' AND expected_revision=0)
      OR (expected_state='SIGNED_SIMULATED' AND expected_revision=1))
    AND cause_reason_code IN ('SIGNED_SIMULATION_FAILED','PRE_SUBMISSION_GATES_FAILED')
    AND evidence_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT execution_pre_submission_revocations_temporal_check CHECK (
    isfinite(observed_at) AND date_trunc('milliseconds',observed_at)=observed_at
    AND isfinite(revoked_at) AND date_trunc('milliseconds',revoked_at)=revoked_at
    AND observed_at <= revoked_at
    AND purge_after=revoked_at + INTERVAL '4 hours'
  )
);

CREATE TABLE IF NOT EXISTS execution_submission_preflight_evidence (
  gate_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  gate_fingerprint TEXT NOT NULL UNIQUE,
  artifact_id TEXT NOT NULL UNIQUE,
  intent_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  generation_id TEXT NOT NULL,
  armament_id TEXT,
  reservation_id TEXT,
  provider_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  build_hash TEXT NOT NULL,
  configuration_fingerprint TEXT NOT NULL,
  strategy_fingerprint TEXT NOT NULL,
  wallet_public_key TEXT NOT NULL,
  cluster TEXT NOT NULL,
  genesis_hash TEXT NOT NULL,
  armament_revision BIGINT,
  admission_risk_revision BIGINT,
  risk_revision BIGINT,
  admission_drawdown_raw NUMERIC,
  conservative_drawdown_raw NUMERIC,
  admission_provider_local_usage_units NUMERIC,
  provider_local_usage_units NUMERIC,
  admission_provider_rate_limit_count BIGINT,
  provider_rate_limit_count BIGINT,
  reservation_amount_raw NUMERIC,
  reconciled_capital_raw NUMERIC,
  reserved_exposure_raw NUMERIC,
  open_positions INTEGER,
  maximum_capital_lamports NUMERIC,
  maximum_exposure_bps NUMERIC,
  maximum_open_positions INTEGER,
  quote_fingerprint TEXT NOT NULL,
  quote_observed_at TIMESTAMPTZ NOT NULL,
  quote_expires_at TIMESTAMPTZ NOT NULL,
  blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  observed_block_height BIGINT NOT NULL,
  blockhash_validity_context_slot BIGINT NOT NULL,
  blockhash_validated_at TIMESTAMPTZ NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT execution_submission_preflight_artifact_fkey
    FOREIGN KEY (artifact_id) REFERENCES execution_signed_transactions(artifact_id)
      ON DELETE CASCADE,
  CONSTRAINT execution_submission_preflight_attempt_fkey
    FOREIGN KEY (intent_id,attempt_number)
      REFERENCES execution_attempts(intent_id,attempt_number) ON DELETE RESTRICT,
  CONSTRAINT execution_submission_preflight_generation_fkey
    FOREIGN KEY (generation_id) REFERENCES execution_wallet_generations(generation_id)
      ON DELETE RESTRICT,
  CONSTRAINT execution_submission_preflight_armament_fkey
    FOREIGN KEY (armament_id) REFERENCES execution_activation_armaments(armament_id)
      ON DELETE RESTRICT,
  CONSTRAINT execution_submission_preflight_reservation_fkey
    FOREIGN KEY (reservation_id) REFERENCES execution_exposure_reservations(reservation_id)
      ON DELETE RESTRICT,
  CONSTRAINT execution_submission_preflight_identity_check CHECK (
    payload_version=1
    AND gate_id ~ '^execution_submission_preflight_[0-9a-f]{64}$'
    AND gate_fingerprint ~ '^[0-9a-f]{64}$'
    AND artifact_id ~ '^execution_signed_transaction_[0-9a-f]{64}$'
    AND intent_id ~ '^execution_intent_[0-9a-f]{64}$'
    AND attempt_number > 0
    AND generation_id ~ '^execution_wallet_generation_[0-9a-f]{64}$'
    AND (armament_id IS NULL
      OR armament_id ~ '^execution_activation_armament_[0-9a-f]{64}$')
    AND (reservation_id IS NULL
      OR reservation_id ~ '^execution_exposure_reservation_[0-9a-f]{64}$')
    AND octet_length(provider_id) BETWEEN 1 AND 64
    AND phase IN ('CANARY','MICRO_LIVE','PILOT')
    AND build_hash ~ '^[0-9a-f]{64}$'
    AND configuration_fingerprint ~ '^[0-9a-f]{64}$'
    AND strategy_fingerprint ~ '^[0-9a-f]{64}$'
    AND wallet_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND cluster='mainnet-beta'
    AND genesis_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,64}$'
    AND quote_fingerprint ~ '^[0-9a-f]{64}$'
    AND blockhash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND last_valid_block_height >= 0 AND observed_block_height >= 0
    AND blockhash_validity_context_slot >= 0
    AND observed_block_height <= last_valid_block_height
  ),
  CONSTRAINT execution_submission_preflight_side_shape_check CHECK (
    (armament_id IS NULL AND reservation_id IS NULL
      AND armament_revision IS NULL AND admission_risk_revision IS NULL
      AND risk_revision IS NULL
      AND admission_drawdown_raw IS NULL AND conservative_drawdown_raw IS NULL
      AND admission_provider_local_usage_units IS NULL
      AND provider_local_usage_units IS NULL
      AND admission_provider_rate_limit_count IS NULL
      AND provider_rate_limit_count IS NULL
      AND reservation_amount_raw IS NULL AND reconciled_capital_raw IS NULL
      AND reserved_exposure_raw IS NULL AND open_positions IS NULL
      AND maximum_capital_lamports IS NULL AND maximum_exposure_bps IS NULL
      AND maximum_open_positions IS NULL)
    OR (armament_id IS NOT NULL AND reservation_id IS NOT NULL
      AND armament_revision >= 0 AND admission_risk_revision >= 0 AND risk_revision >= 0
      AND risk_revision=admission_risk_revision
      AND admission_drawdown_raw <> 'NaN'::NUMERIC AND admission_drawdown_raw >= 0
      AND admission_drawdown_raw=trunc(admission_drawdown_raw)
      AND admission_drawdown_raw < 18446744073709551616
      AND conservative_drawdown_raw <> 'NaN'::NUMERIC AND conservative_drawdown_raw >= 0
      AND conservative_drawdown_raw=trunc(conservative_drawdown_raw)
      AND conservative_drawdown_raw < 18446744073709551616
      AND conservative_drawdown_raw <= admission_drawdown_raw
      AND admission_provider_local_usage_units <> 'NaN'::NUMERIC
      AND admission_provider_local_usage_units >= 0
      AND admission_provider_local_usage_units=trunc(admission_provider_local_usage_units)
      AND admission_provider_local_usage_units < 18446744073709551616
      AND provider_local_usage_units <> 'NaN'::NUMERIC
      AND provider_local_usage_units >= 0
      AND provider_local_usage_units=trunc(provider_local_usage_units)
      AND provider_local_usage_units < 18446744073709551616
      AND provider_local_usage_units=admission_provider_local_usage_units
      AND admission_provider_rate_limit_count >= 0
      AND provider_rate_limit_count >= 0
      AND provider_rate_limit_count=admission_provider_rate_limit_count
      AND reservation_amount_raw > 0 AND reservation_amount_raw=trunc(reservation_amount_raw)
      AND reconciled_capital_raw >= 0 AND reconciled_capital_raw=trunc(reconciled_capital_raw)
      AND reserved_exposure_raw >= 0 AND reserved_exposure_raw=trunc(reserved_exposure_raw)
      AND open_positions >= 0 AND maximum_capital_lamports > 0
      AND maximum_capital_lamports=trunc(maximum_capital_lamports)
      AND maximum_exposure_bps > 0 AND maximum_exposure_bps=trunc(maximum_exposure_bps)
      AND maximum_open_positions > 0)
  ),
  CONSTRAINT execution_submission_preflight_temporal_check CHECK (
    isfinite(quote_observed_at) AND isfinite(quote_expires_at)
    AND isfinite(blockhash_validated_at) AND isfinite(authorized_at)
    AND date_trunc('milliseconds',quote_observed_at)=quote_observed_at
    AND date_trunc('milliseconds',quote_expires_at)=quote_expires_at
    AND date_trunc('milliseconds',blockhash_validated_at)=blockhash_validated_at
    AND date_trunc('milliseconds',authorized_at)=authorized_at
    AND quote_observed_at < quote_expires_at AND authorized_at < quote_expires_at
    AND blockhash_validated_at <= authorized_at
    AND blockhash_validated_at > authorized_at - INTERVAL '5 seconds'
  )
);

CREATE TABLE IF NOT EXISTS execution_submission_events (
  event_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  event_fingerprint TEXT NOT NULL UNIQUE,
  artifact_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  previous_state TEXT,
  next_state TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT execution_submission_events_artifact_fkey
    FOREIGN KEY (artifact_id) REFERENCES execution_signed_transactions(artifact_id) ON DELETE RESTRICT,
  CONSTRAINT execution_submission_events_generation_fkey
    FOREIGN KEY (generation_id) REFERENCES execution_wallet_generations(generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_submission_events_identity_check CHECK (
    payload_version=1
    AND event_id ~ '^execution_submission_event_[0-9a-f]{64}$'
    AND event_fingerprint ~ '^[0-9a-f]{64}$'
    AND (previous_state IS NULL OR previous_state IN ('PERSISTED','SIGNED_SIMULATED',
      'SUBMISSION_STARTED','ACCEPTED','AMBIGUOUS','CONFIRMED','RECONCILED','REVOKED_NO_SEND'))
    AND next_state IN ('PERSISTED','SIGNED_SIMULATED','SUBMISSION_STARTED','ACCEPTED',
      'AMBIGUOUS','CONFIRMED','RECONCILED','REVOKED_NO_SEND')
    AND reason_code IN ('SIGNATURE_PERSISTED','SIGNED_SIMULATION_SUCCEEDED',
      'PRE_SUBMISSION_REVOKED_NO_SEND','SUBMISSION_STARTED',
      'SUBMISSION_ACCEPTED','SUBMISSION_AMBIGUOUS','SUBMISSION_SIGNATURE_MISMATCH',
      'CONFIRMATION_OBSERVED','RECONCILIATION_REQUIRED',
      'RECONCILIATION_PROVED_NO_EFFECT','INTENT_SUCCEEDED')
  ),
  CONSTRAINT execution_submission_events_temporal_check CHECK (
    isfinite(occurred_at) AND date_trunc('milliseconds',occurred_at)=occurred_at
  )
);

CREATE INDEX IF NOT EXISTS execution_submission_events_artifact_occurred_idx
  ON execution_submission_events(artifact_id,occurred_at,event_id);

CREATE OR REPLACE FUNCTION reject_execution_live_immutable_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'execution live payload is immutable' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS execution_submission_events_immutable ON execution_submission_events;
CREATE TRIGGER execution_submission_events_immutable
  BEFORE UPDATE ON execution_submission_events
  FOR EACH ROW EXECUTE FUNCTION reject_execution_live_immutable_update();

DROP TRIGGER IF EXISTS execution_signed_simulation_evidence_immutable
  ON execution_signed_simulation_evidence;
CREATE TRIGGER execution_signed_simulation_evidence_immutable
  BEFORE UPDATE ON execution_signed_simulation_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_execution_live_immutable_update();

DROP TRIGGER IF EXISTS execution_live_unsigned_simulation_evidence_immutable
  ON execution_live_unsigned_simulation_evidence;
CREATE TRIGGER execution_live_unsigned_simulation_evidence_immutable
  BEFORE UPDATE ON execution_live_unsigned_simulation_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_execution_live_immutable_update();

DROP TRIGGER IF EXISTS execution_submission_preflight_evidence_immutable
  ON execution_submission_preflight_evidence;
CREATE TRIGGER execution_submission_preflight_evidence_immutable
  BEFORE UPDATE ON execution_submission_preflight_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_execution_live_immutable_update();

DROP TRIGGER IF EXISTS execution_pre_submission_revocations_immutable
  ON execution_pre_submission_revocations;
CREATE TRIGGER execution_pre_submission_revocations_immutable
  BEFORE UPDATE ON execution_pre_submission_revocations
  FOR EACH ROW EXECUTE FUNCTION reject_execution_live_immutable_update();

CREATE OR REPLACE FUNCTION execution_live_state_transition_allowed(
  entity_type TEXT,
  previous_state TEXT,
  next_state TEXT
)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE entity_type
    WHEN 'SIGNED_TRANSACTION' THEN (previous_state,next_state) IN (
      ('PERSISTED','SIGNED_SIMULATED'),
      ('PERSISTED','REVOKED_NO_SEND'),
      ('SIGNED_SIMULATED','SUBMISSION_STARTED'),
      ('SIGNED_SIMULATED','REVOKED_NO_SEND'),
      ('SUBMISSION_STARTED','ACCEPTED'),
      ('SUBMISSION_STARTED','AMBIGUOUS'),
      ('ACCEPTED','CONFIRMED'),
      ('ACCEPTED','AMBIGUOUS'),
      ('AMBIGUOUS','CONFIRMED'),
      ('AMBIGUOUS','RECONCILED'),
      ('CONFIRMED','AMBIGUOUS'),
      ('CONFIRMED','RECONCILED')
    )
    WHEN 'LIVE_POSITION' THEN (previous_state,next_state) IN (
      ('OPEN','EXIT_PENDING'),
      ('OPEN','UNKNOWN'),
      ('EXIT_PENDING','CLOSED'),
      ('EXIT_PENDING','UNKNOWN'),
      ('UNKNOWN','EXIT_PENDING'),
      ('UNKNOWN','CLOSED')
    )
    WHEN 'EXIT_AUTHORIZATION' THEN (previous_state,next_state) IN (
      ('ACTIVE','LOCKED'),
      ('ACTIVE','REVOKED'),
      ('LOCKED','ACTIVE'),
      ('LOCKED','CONSUMED'),
      ('LOCKED','REVOKED')
    )
    ELSE FALSE
  END;
$$;

CREATE OR REPLACE FUNCTION guard_execution_signed_transaction_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  valid_binding BOOLEAN;
BEGIN
  IF NEW.state <> 'PERSISTED' OR NEW.state_revision <> 0 THEN
    RAISE EXCEPTION 'execution signed transaction initial state is invalid'
      USING ERRCODE='55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.generation_id, 51005));
  SELECT EXISTS (
    SELECT 1
    FROM execution_attempts attempt
    JOIN execution_intents intent ON intent.id=attempt.intent_id
    JOIN execution_wallet_generations generation
      ON generation.generation_id=NEW.generation_id
    LEFT JOIN execution_activation_armaments armament
      ON armament.armament_id=NEW.armament_id
    LEFT JOIN execution_exposure_reservations reservation
      ON reservation.reservation_id=NEW.reservation_id
    LEFT JOIN execution_exit_authorizations exit_auth
      ON exit_auth.authorization_id=NEW.exit_authorization_id
    WHERE attempt.intent_id=NEW.intent_id
      AND attempt.attempt_number=NEW.attempt_number
      AND attempt.status='STARTED'
      AND intent.side=NEW.side
      AND intent.status IN ('PROCESSING','SIMULATED','SIGNED_NOT_SUBMITTED')
      AND generation.retired_at IS NULL
      AND generation.wallet_public_key=NEW.wallet_public_key
      AND ((NEW.side='BUY' AND armament.generation_id=NEW.generation_id
        AND armament.wallet_public_key=NEW.wallet_public_key AND armament.state='LOCKED'
        AND reservation.intent_id=NEW.intent_id
        AND reservation.generation_id=NEW.generation_id
        AND reservation.state='RESERVED')
        OR (NEW.side='SELL' AND exit_auth.generation_id=NEW.generation_id
          AND exit_auth.wallet_public_key=NEW.wallet_public_key AND exit_auth.state='LOCKED'
          AND exit_auth.locked_intent_id=NEW.intent_id
          AND exit_auth.locked_attempt_number=NEW.attempt_number))
  ) INTO valid_binding;
  IF NOT valid_binding THEN
    RAISE EXCEPTION 'guarded signed transaction insert required' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_signed_transactions_guarded_insert
  ON execution_signed_transactions;
CREATE TRIGGER execution_signed_transactions_guarded_insert
  BEFORE INSERT ON execution_signed_transactions
  FOR EACH ROW EXECUTE FUNCTION guard_execution_signed_transaction_insert();

CREATE OR REPLACE FUNCTION guard_execution_signed_transaction_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  preflight_present BOOLEAN;
  signed_simulation_present BOOLEAN;
BEGIN
  IF NEW.artifact_id IS DISTINCT FROM OLD.artifact_id
    OR NEW.payload_version IS DISTINCT FROM OLD.payload_version
    OR NEW.specification_version IS DISTINCT FROM OLD.specification_version
    OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
    OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
    OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
    OR NEW.armament_id IS DISTINCT FROM OLD.armament_id
    OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
    OR NEW.exit_authorization_id IS DISTINCT FROM OLD.exit_authorization_id
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.wallet_public_key IS DISTINCT FROM OLD.wallet_public_key
    OR NEW.side IS DISTINCT FROM OLD.side
    OR NEW.effective_venue IS DISTINCT FROM OLD.effective_venue
    OR NEW.message_hash IS DISTINCT FROM OLD.message_hash
    OR NEW.build_fingerprint IS DISTINCT FROM OLD.build_fingerprint
    OR NEW.snapshot_fingerprint IS DISTINCT FROM OLD.snapshot_fingerprint
    OR NEW.quote_fingerprint IS DISTINCT FROM OLD.quote_fingerprint
    OR NEW.quote_observed_at IS DISTINCT FROM OLD.quote_observed_at
    OR NEW.quote_expires_at IS DISTINCT FROM OLD.quote_expires_at
    OR NEW.blockhash IS DISTINCT FROM OLD.blockhash
    OR NEW.last_valid_block_height IS DISTINCT FROM OLD.last_valid_block_height
    OR NEW.signature IS DISTINCT FROM OLD.signature
    OR NEW.signed_transaction_bytes IS DISTINCT FROM OLD.signed_transaction_bytes
    OR NEW.signed_transaction_hash IS DISTINCT FROM OLD.signed_transaction_hash
    OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
    OR NEW.state_revision <> OLD.state_revision + 1
  THEN
    RAISE EXCEPTION 'execution signed transaction identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NOT execution_live_state_transition_allowed(
    'SIGNED_TRANSACTION',OLD.state,NEW.state
  ) THEN
    RAISE EXCEPTION 'illegal execution signed transaction state transition'
      USING ERRCODE='55000';
  END IF;
  IF NEW.state='SIGNED_SIMULATED' THEN
    SELECT EXISTS (
      SELECT 1 FROM execution_signed_simulation_evidence evidence
      JOIN execution_live_unsigned_simulation_evidence unsigned_evidence
        ON unsigned_evidence.evidence_id=evidence.unsigned_simulation_evidence_id
      WHERE evidence.artifact_id=NEW.artifact_id
        AND evidence.signed_transaction_hash=NEW.signed_transaction_hash
        AND evidence.provider_id=NEW.provider_id
        AND evidence.observed_at=NEW.signed_simulated_at
        AND unsigned_evidence.artifact_id=NEW.artifact_id
        AND unsigned_evidence.intent_id=NEW.intent_id
        AND unsigned_evidence.attempt_number=NEW.attempt_number
        AND unsigned_evidence.provider_id=NEW.provider_id
        AND unsigned_evidence.snapshot_fingerprint=NEW.snapshot_fingerprint
        AND unsigned_evidence.build_fingerprint=NEW.build_fingerprint
        AND unsigned_evidence.message_hash=NEW.message_hash
        AND unsigned_evidence.blockhash=NEW.blockhash
        AND unsigned_evidence.last_valid_block_height=NEW.last_valid_block_height
        AND evidence.simulation_slot >= unsigned_evidence.simulation_slot
        AND evidence.units_consumed >= unsigned_evidence.units_consumed
        AND evidence.fee_payer_lamport_debit
          >= unsigned_evidence.simulated_fee_payer_lamport_debit
        AND ((NEW.side='BUY' AND unsigned_evidence.simulated_base_delta_raw > 0
          AND unsigned_evidence.simulated_quote_delta_raw < 0
          AND evidence.base_delta_raw > 0
          AND evidence.base_delta_raw <= unsigned_evidence.simulated_base_delta_raw
          AND evidence.quote_delta_raw < 0
          AND evidence.quote_delta_raw <= unsigned_evidence.simulated_quote_delta_raw)
          OR (NEW.side='SELL' AND unsigned_evidence.simulated_base_delta_raw < 0
            AND unsigned_evidence.simulated_quote_delta_raw > 0
            AND evidence.base_delta_raw < 0
            AND evidence.base_delta_raw >= unsigned_evidence.simulated_base_delta_raw
            AND evidence.quote_delta_raw > 0
            AND evidence.quote_delta_raw <= unsigned_evidence.simulated_quote_delta_raw))
    ) INTO signed_simulation_present;
    IF NOT signed_simulation_present THEN
      RAISE EXCEPTION 'execution signed simulation evidence required'
        USING ERRCODE='55000';
    END IF;
  END IF;
  IF NEW.state='SUBMISSION_STARTED' THEN
    SELECT EXISTS (
      SELECT 1 FROM execution_submission_preflight_evidence evidence
      WHERE evidence.artifact_id=NEW.artifact_id
        AND evidence.intent_id=NEW.intent_id
        AND evidence.attempt_number=NEW.attempt_number
        AND evidence.generation_id=NEW.generation_id
        AND evidence.armament_id IS NOT DISTINCT FROM NEW.armament_id
        AND evidence.reservation_id IS NOT DISTINCT FROM NEW.reservation_id
        AND evidence.provider_id=NEW.provider_id
        AND evidence.wallet_public_key=NEW.wallet_public_key
        AND evidence.quote_fingerprint=NEW.quote_fingerprint
        AND evidence.quote_observed_at=NEW.quote_observed_at
        AND evidence.quote_expires_at=NEW.quote_expires_at
        AND evidence.blockhash=NEW.blockhash
        AND evidence.last_valid_block_height=NEW.last_valid_block_height
        AND evidence.authorized_at=NEW.submission_started_at
    ) INTO preflight_present;
    IF NOT preflight_present THEN
      RAISE EXCEPTION 'execution submission preflight evidence required'
        USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_signed_transactions_guarded_update
  ON execution_signed_transactions;
CREATE TRIGGER execution_signed_transactions_guarded_update
  BEFORE UPDATE ON execution_signed_transactions
  FOR EACH ROW EXECUTE FUNCTION guard_execution_signed_transaction_update();

CREATE OR REPLACE FUNCTION guard_execution_live_position_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'OPEN' OR NEW.state_revision <> 0
    OR NEW.remaining_base_raw IS DISTINCT FROM NEW.base_amount_raw
    OR NEW.exit_intent_id IS NOT NULL
    OR NEW.exit_reconciliation_fingerprint IS NOT NULL
  THEN
    RAISE EXCEPTION 'execution live position initial state is invalid' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_live_positions_guarded_insert ON execution_live_positions;
CREATE TRIGGER execution_live_positions_guarded_insert
  BEFORE INSERT ON execution_live_positions
  FOR EACH ROW EXECUTE FUNCTION guard_execution_live_position_insert();

CREATE OR REPLACE FUNCTION guard_execution_live_position_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.position_id IS DISTINCT FROM OLD.position_id
    OR NEW.payload_version IS DISTINCT FROM OLD.payload_version
    OR NEW.buy_intent_id IS DISTINCT FROM OLD.buy_intent_id
    OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
    OR NEW.armament_id IS DISTINCT FROM OLD.armament_id
    OR NEW.wallet_public_key IS DISTINCT FROM OLD.wallet_public_key
    OR NEW.mint IS DISTINCT FROM OLD.mint
    OR NEW.quote_mint IS DISTINCT FROM OLD.quote_mint
    OR NEW.entry_venue IS DISTINCT FROM OLD.entry_venue
    OR NEW.quote_cost_raw IS DISTINCT FROM OLD.quote_cost_raw
    OR NEW.base_amount_raw IS DISTINCT FROM OLD.base_amount_raw
    OR NEW.fee_lamports IS DISTINCT FROM OLD.fee_lamports
    OR NEW.maximum_holding_ms IS DISTINCT FROM OLD.maximum_holding_ms
    OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
    OR NEW.exit_deadline_at IS DISTINCT FROM OLD.exit_deadline_at
    OR NEW.entry_reconciliation_fingerprint IS DISTINCT FROM OLD.entry_reconciliation_fingerprint
    OR NEW.state_revision <> OLD.state_revision + 1
  THEN
    RAISE EXCEPTION 'execution live position identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NOT execution_live_state_transition_allowed('LIVE_POSITION',OLD.state,NEW.state) THEN
    RAISE EXCEPTION 'illegal execution live position state transition' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_live_positions_guarded_update ON execution_live_positions;
CREATE TRIGGER execution_live_positions_guarded_update
  BEFORE UPDATE ON execution_live_positions
  FOR EACH ROW EXECUTE FUNCTION guard_execution_live_position_update();

CREATE OR REPLACE FUNCTION guard_execution_exit_authorization_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'ACTIVE' OR NEW.state_revision <> 0 THEN
    RAISE EXCEPTION 'execution exit authorization initial state is invalid'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_exit_authorizations_guarded_insert
  ON execution_exit_authorizations;
CREATE TRIGGER execution_exit_authorizations_guarded_insert
  BEFORE INSERT ON execution_exit_authorizations
  FOR EACH ROW EXECUTE FUNCTION guard_execution_exit_authorization_insert();

CREATE OR REPLACE FUNCTION guard_execution_exit_authorization_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
    OR NEW.payload_version IS DISTINCT FROM OLD.payload_version
    OR NEW.position_id IS DISTINCT FROM OLD.position_id
    OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
    OR NEW.wallet_public_key IS DISTINCT FROM OLD.wallet_public_key
    OR NEW.mint IS DISTINCT FROM OLD.mint
    OR NEW.quote_mint IS DISTINCT FROM OLD.quote_mint
    OR NEW.maximum_base_amount_raw IS DISTINCT FROM OLD.maximum_base_amount_raw
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.state_revision <> OLD.state_revision + 1
  THEN
    RAISE EXCEPTION 'execution exit authorization identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NOT execution_live_state_transition_allowed(
    'EXIT_AUTHORIZATION',OLD.state,NEW.state
  ) THEN
    RAISE EXCEPTION 'illegal execution exit authorization state transition'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_exit_authorizations_guarded_update
  ON execution_exit_authorizations;
CREATE TRIGGER execution_exit_authorizations_guarded_update
  BEFORE UPDATE ON execution_exit_authorizations
  FOR EACH ROW EXECUTE FUNCTION guard_execution_exit_authorization_update();

CREATE OR REPLACE FUNCTION execution_submission_event_matches_transition(
  event_previous_state TEXT,
  event_next_state TEXT,
  event_reason_code TEXT
)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN event_previous_state IS NULL THEN
      event_next_state='PERSISTED' AND event_reason_code='SIGNATURE_PERSISTED'
    WHEN NOT execution_live_state_transition_allowed(
      'SIGNED_TRANSACTION',event_previous_state,event_next_state
    ) THEN FALSE
    WHEN (event_previous_state,event_next_state) IN (
      ('PERSISTED','REVOKED_NO_SEND'),('SIGNED_SIMULATED','REVOKED_NO_SEND')
    ) THEN event_reason_code='PRE_SUBMISSION_REVOKED_NO_SEND'
    WHEN (event_previous_state,event_next_state)=('PERSISTED','SIGNED_SIMULATED') THEN
      event_reason_code='SIGNED_SIMULATION_SUCCEEDED'
    WHEN (event_previous_state,event_next_state)=('SIGNED_SIMULATED','SUBMISSION_STARTED') THEN
      event_reason_code='SUBMISSION_STARTED'
    WHEN (event_previous_state,event_next_state)=('SUBMISSION_STARTED','ACCEPTED') THEN
      event_reason_code='SUBMISSION_ACCEPTED'
    WHEN (event_previous_state,event_next_state)=('SUBMISSION_STARTED','AMBIGUOUS') THEN
      event_reason_code IN ('SUBMISSION_AMBIGUOUS','SUBMISSION_SIGNATURE_MISMATCH')
    WHEN event_next_state='CONFIRMED' THEN event_reason_code='CONFIRMATION_OBSERVED'
    WHEN event_next_state='AMBIGUOUS' THEN event_reason_code='RECONCILIATION_REQUIRED'
    WHEN (event_previous_state,event_next_state)=('AMBIGUOUS','RECONCILED') THEN
      event_reason_code='RECONCILIATION_PROVED_NO_EFFECT'
    WHEN (event_previous_state,event_next_state)=('CONFIRMED','RECONCILED') THEN
      event_reason_code='INTENT_SUCCEEDED'
    ELSE FALSE
  END;
$$;

ALTER TABLE execution_submission_events
  DROP CONSTRAINT IF EXISTS execution_submission_events_transition_check;
ALTER TABLE execution_submission_events
  ADD CONSTRAINT execution_submission_events_transition_check CHECK (
    execution_submission_event_matches_transition(previous_state,next_state,reason_code)
  );

CREATE OR REPLACE FUNCTION require_execution_signed_transaction_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  event_count BIGINT;
  matching_count BIGINT;
BEGIN
  SELECT COUNT(*),COUNT(*) FILTER (
    WHERE event.generation_id=NEW.generation_id
      AND event.previous_state IS NOT DISTINCT FROM
        CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.state END
      AND event.next_state=NEW.state
      AND execution_submission_event_matches_transition(
        event.previous_state,event.next_state,event.reason_code
      )
  ) INTO event_count,matching_count
  FROM execution_submission_events event
  WHERE event.artifact_id=NEW.artifact_id;
  IF event_count < NEW.state_revision + 1 OR matching_count < 1 THEN
    RAISE EXCEPTION 'execution signed transaction state event required' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION require_execution_submission_event_ledger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  artifact_revision BIGINT;
  event_count BIGINT;
BEGIN
  SELECT transaction.state_revision INTO artifact_revision
  FROM execution_signed_transactions transaction
  WHERE transaction.artifact_id=COALESCE(NEW.artifact_id,OLD.artifact_id);
  SELECT COUNT(*) INTO event_count
  FROM execution_submission_events event
  WHERE event.artifact_id=COALESCE(NEW.artifact_id,OLD.artifact_id);
  IF artifact_revision IS NULL THEN
    RETURN NULL;
  END IF;
  IF event_count <> artifact_revision + 1 THEN
    RAISE EXCEPTION 'execution submission event ledger is incomplete' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS execution_signed_transactions_event_required
  ON execution_signed_transactions;
CREATE CONSTRAINT TRIGGER execution_signed_transactions_event_required
  AFTER INSERT OR UPDATE ON execution_signed_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_execution_signed_transaction_event();

DROP TRIGGER IF EXISTS execution_submission_events_ledger_guard
  ON execution_submission_events;
CREATE CONSTRAINT TRIGGER execution_submission_events_ledger_guard
  AFTER INSERT OR DELETE ON execution_submission_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_execution_submission_event_ledger();
