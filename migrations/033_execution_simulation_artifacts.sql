-- Keep the three existing reason vocabularies closed while extending them
-- append-only for terminal simulation-only outcomes.
ALTER TABLE execution_intents
  DROP CONSTRAINT IF EXISTS execution_intents_reason_check;
ALTER TABLE execution_intents
  ADD CONSTRAINT execution_intents_reason_check CHECK (
    last_reason_code IS NULL OR last_reason_code IN (
      'EXECUTION_STARTED', 'SIMULATION_SUCCEEDED', 'ATTEMPT_COMPLETED',
      'RETRY_AUTHORIZED', 'SIGNATURE_PERSISTED', 'SUBMISSION_ACCEPTED',
      'CONFIRMATION_OBSERVED', 'RECONCILIATION_STARTED', 'INTENT_SUCCEEDED',
      'INTENT_CANCELLED',
      'INTENT_EXPIRED', 'INTENT_DUPLICATE', 'INTENT_LEASE_LOST',
      'QUALIFICATION_STALE', 'DECISION_STALE', 'QUOTE_STALE',
      'QUOTE_MINT_NOT_ALLOWED', 'VENUE_UNAVAILABLE', 'BUY_SIMULATION_FAILED',
      'SELL_SIMULATION_FAILED', 'SELL_QUOTE_UNAVAILABLE',
      'MINIMUM_AMOUNT_OUT_VIOLATED', 'UNSUPPORTED_TOKEN_EXTENSION',
      'WALLET_MISMATCH', 'GENESIS_MISMATCH', 'CAPITAL_LIMIT_EXCEEDED',
      'EXPOSURE_LIMIT_EXCEEDED', 'DRAWDOWN_LIMIT_EXCEEDED',
      'PROVIDER_USAGE_UNKNOWN', 'PROVIDER_ENTRY_LIMIT_REACHED',
      'PROVIDER_EXIT_ONLY', 'KILL_SWITCH_ACTIVE', 'HARD_STOP_ACTIVE',
      'ARMING_REQUIRED', 'ARMING_EXPIRED', 'SIGNATURE_PERSIST_FAILED',
      'SUBMISSION_AMBIGUOUS', 'CONFIRMATION_TIMEOUT', 'RECONCILIATION_REQUIRED',
      'BALANCE_MISMATCH', 'RESIDUAL_TOKEN_BALANCE', 'DOUBLE_ORDER_SUSPECTED',
      'RECONCILIATION_PROVED_NO_EFFECT', 'EXECUTION_PROVIDER_FAILED',
      'EXECUTION_BUILD_FAILED', 'EXECUTION_EVIDENCE_INVALID'
    )
  );

ALTER TABLE execution_attempts
  DROP CONSTRAINT IF EXISTS execution_attempts_reason_check;
ALTER TABLE execution_attempts
  ADD CONSTRAINT execution_attempts_reason_check CHECK (
    reason_code IS NULL OR reason_code IN (
      'EXECUTION_STARTED', 'SIMULATION_SUCCEEDED', 'ATTEMPT_COMPLETED',
      'RETRY_AUTHORIZED', 'SIGNATURE_PERSISTED', 'SUBMISSION_ACCEPTED',
      'CONFIRMATION_OBSERVED', 'RECONCILIATION_STARTED', 'INTENT_SUCCEEDED',
      'INTENT_CANCELLED',
      'INTENT_EXPIRED', 'INTENT_DUPLICATE', 'INTENT_LEASE_LOST',
      'QUALIFICATION_STALE', 'DECISION_STALE', 'QUOTE_STALE',
      'QUOTE_MINT_NOT_ALLOWED', 'VENUE_UNAVAILABLE', 'BUY_SIMULATION_FAILED',
      'SELL_SIMULATION_FAILED', 'SELL_QUOTE_UNAVAILABLE',
      'MINIMUM_AMOUNT_OUT_VIOLATED', 'UNSUPPORTED_TOKEN_EXTENSION',
      'WALLET_MISMATCH', 'GENESIS_MISMATCH', 'CAPITAL_LIMIT_EXCEEDED',
      'EXPOSURE_LIMIT_EXCEEDED', 'DRAWDOWN_LIMIT_EXCEEDED',
      'PROVIDER_USAGE_UNKNOWN', 'PROVIDER_ENTRY_LIMIT_REACHED',
      'PROVIDER_EXIT_ONLY', 'KILL_SWITCH_ACTIVE', 'HARD_STOP_ACTIVE',
      'ARMING_REQUIRED', 'ARMING_EXPIRED', 'SIGNATURE_PERSIST_FAILED',
      'SUBMISSION_AMBIGUOUS', 'CONFIRMATION_TIMEOUT', 'RECONCILIATION_REQUIRED',
      'BALANCE_MISMATCH', 'RESIDUAL_TOKEN_BALANCE', 'DOUBLE_ORDER_SUSPECTED',
      'RECONCILIATION_PROVED_NO_EFFECT', 'EXECUTION_PROVIDER_FAILED',
      'EXECUTION_BUILD_FAILED', 'EXECUTION_EVIDENCE_INVALID'
    )
  );

ALTER TABLE execution_intent_transitions
  DROP CONSTRAINT IF EXISTS execution_intent_transitions_reason_check;
ALTER TABLE execution_intent_transitions
  ADD CONSTRAINT execution_intent_transitions_reason_check CHECK (reason_code IN (
    'EXECUTION_STARTED', 'SIMULATION_SUCCEEDED', 'ATTEMPT_COMPLETED',
    'RETRY_AUTHORIZED', 'SIGNATURE_PERSISTED', 'SUBMISSION_ACCEPTED',
    'CONFIRMATION_OBSERVED', 'RECONCILIATION_STARTED', 'INTENT_SUCCEEDED',
    'INTENT_CANCELLED',
    'INTENT_EXPIRED', 'INTENT_DUPLICATE', 'INTENT_LEASE_LOST',
    'QUALIFICATION_STALE', 'DECISION_STALE', 'QUOTE_STALE',
    'QUOTE_MINT_NOT_ALLOWED', 'VENUE_UNAVAILABLE', 'BUY_SIMULATION_FAILED',
    'SELL_SIMULATION_FAILED', 'SELL_QUOTE_UNAVAILABLE',
    'MINIMUM_AMOUNT_OUT_VIOLATED', 'UNSUPPORTED_TOKEN_EXTENSION',
    'WALLET_MISMATCH', 'GENESIS_MISMATCH', 'CAPITAL_LIMIT_EXCEEDED',
    'EXPOSURE_LIMIT_EXCEEDED', 'DRAWDOWN_LIMIT_EXCEEDED',
    'PROVIDER_USAGE_UNKNOWN', 'PROVIDER_ENTRY_LIMIT_REACHED',
    'PROVIDER_EXIT_ONLY', 'KILL_SWITCH_ACTIVE', 'HARD_STOP_ACTIVE',
    'ARMING_REQUIRED', 'ARMING_EXPIRED', 'SIGNATURE_PERSIST_FAILED',
    'SUBMISSION_AMBIGUOUS', 'CONFIRMATION_TIMEOUT', 'RECONCILIATION_REQUIRED',
    'BALANCE_MISMATCH', 'RESIDUAL_TOKEN_BALANCE', 'DOUBLE_ORDER_SUSPECTED',
    'RECONCILIATION_PROVED_NO_EFFECT', 'EXECUTION_PROVIDER_FAILED',
    'EXECUTION_BUILD_FAILED', 'EXECUTION_EVIDENCE_INVALID'
  ));

CREATE TABLE IF NOT EXISTS execution_simulation_artifacts (
  artifact_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  specification_version TEXT NOT NULL DEFAULT '1.5.0',
  evaluator_version INTEGER NOT NULL DEFAULT 1,
  intent_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  intent_state_revision BIGINT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version INTEGER NOT NULL,
  decision_fingerprint TEXT NOT NULL,
  result_kind TEXT NOT NULL,
  effective_venue TEXT,
  provider_id TEXT NOT NULL,
  executor_public_key TEXT NOT NULL,
  expected_genesis_hash TEXT NOT NULL,
  observed_genesis_hash TEXT,
  configuration_fingerprint TEXT NOT NULL,
  quote_fingerprint TEXT,
  snapshot_fingerprint TEXT,
  build_fingerprint TEXT,
  message_hash TEXT,
  blockhash TEXT,
  last_valid_block_height BIGINT,
  blockhash_context_slot BIGINT,
  snapshot_slot BIGINT,
  fee_context_slot BIGINT,
  simulation_slot BIGINT,
  -- NUMERIC(p,0) is deliberately forbidden: PostgreSQL rounds before CHECK.
  amount_in_raw NUMERIC,
  expected_amount_out_raw NUMERIC,
  protected_amount_out_raw NUMERIC,
  fees_raw NUMERIC,
  estimated_fee_lamports NUMERIC,
  simulated_fee_payer_lamport_debit NUMERIC,
  units_consumed BIGINT,
  simulated_base_delta_raw NUMERIC,
  simulated_quote_delta_raw NUMERIC,
  rpc_calls_used INTEGER NOT NULL,
  rpc_calls_limit INTEGER NOT NULL,
  quote_status TEXT NOT NULL,
  build_status TEXT NOT NULL,
  simulation_status TEXT NOT NULL,
  failure_stage TEXT,
  failure_code TEXT,
  terminal_reason_code TEXT NOT NULL,
  logs_fingerprint TEXT,
  logs_line_count INTEGER,
  result_fingerprint TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp()),
  CONSTRAINT execution_simulation_artifacts_attempt_unique
    UNIQUE (intent_id, attempt_number),
  CONSTRAINT execution_simulation_artifacts_attempt_fkey
    FOREIGN KEY (intent_id, attempt_number)
    REFERENCES execution_attempts (intent_id, attempt_number) ON DELETE CASCADE,
  CONSTRAINT execution_simulation_artifacts_intent_identity_fkey
    FOREIGN KEY (intent_id, strategy_id, strategy_version, decision_fingerprint)
    REFERENCES execution_intents (id, strategy_id, strategy_version, decision_fingerprint)
    ON DELETE CASCADE,
  CONSTRAINT execution_simulation_artifacts_versions_check CHECK (
    payload_version = 1 AND specification_version = '1.5.0' AND evaluator_version = 1
  ),
  CONSTRAINT execution_simulation_artifacts_identifiers_check CHECK (
    artifact_id ~ '^execution_simulation_artifact_[0-9a-f]{64}$'
    AND intent_id ~ '^execution_intent_[0-9a-f]{64}$'
    AND octet_length(strategy_id) BETWEEN 1 AND 256
    AND strategy_version BETWEEN 1 AND 2147483647
    AND octet_length(provider_id) BETWEEN 1 AND 256
    AND executor_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND expected_genesis_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND (observed_genesis_hash IS NULL
      OR observed_genesis_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
    AND (blockhash IS NULL OR blockhash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  ),
  CONSTRAINT execution_simulation_artifacts_fingerprints_check CHECK (
    decision_fingerprint ~ '^[0-9a-f]{64}$'
    AND configuration_fingerprint ~ '^[0-9a-f]{64}$'
    AND (quote_fingerprint IS NULL OR quote_fingerprint ~ '^[0-9a-f]{64}$')
    AND (snapshot_fingerprint IS NULL OR snapshot_fingerprint ~ '^[0-9a-f]{64}$')
    AND (build_fingerprint IS NULL OR build_fingerprint ~ '^[0-9a-f]{64}$')
    AND (message_hash IS NULL OR message_hash ~ '^[0-9a-f]{64}$')
    AND (logs_fingerprint IS NULL OR logs_fingerprint ~ '^[0-9a-f]{64}$')
    AND result_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT execution_simulation_artifacts_integer_identity_check CHECK (
    attempt_number BETWEEN 1 AND 2147483647
    AND intent_state_revision >= 0
    AND (last_valid_block_height IS NULL OR last_valid_block_height >= 0)
    AND (blockhash_context_slot IS NULL OR blockhash_context_slot >= 0)
    AND (snapshot_slot IS NULL OR snapshot_slot >= 0)
    AND (fee_context_slot IS NULL OR fee_context_slot >= 0)
    AND (simulation_slot IS NULL OR simulation_slot >= 0)
  ),
  CONSTRAINT execution_simulation_artifacts_amounts_check CHECK (
    (amount_in_raw IS NULL OR (
      amount_in_raw <> 'NaN'::NUMERIC AND amount_in_raw > 0
      AND amount_in_raw = trunc(amount_in_raw) AND scale(amount_in_raw) = 0
      AND amount_in_raw < 18446744073709551616
    ))
    AND (expected_amount_out_raw IS NULL OR (
      expected_amount_out_raw <> 'NaN'::NUMERIC AND expected_amount_out_raw > 0
      AND expected_amount_out_raw = trunc(expected_amount_out_raw)
      AND scale(expected_amount_out_raw) = 0
      AND expected_amount_out_raw < 18446744073709551616
    ))
    AND (protected_amount_out_raw IS NULL OR (
      protected_amount_out_raw <> 'NaN'::NUMERIC AND protected_amount_out_raw > 0
      AND protected_amount_out_raw = trunc(protected_amount_out_raw)
      AND scale(protected_amount_out_raw) = 0
      AND protected_amount_out_raw < 18446744073709551616
    ))
    AND (fees_raw IS NULL OR (
      fees_raw <> 'NaN'::NUMERIC AND fees_raw >= 0
      AND fees_raw = trunc(fees_raw) AND scale(fees_raw) = 0
      AND fees_raw < 18446744073709551616
    ))
    AND (estimated_fee_lamports IS NULL OR (
      estimated_fee_lamports <> 'NaN'::NUMERIC AND estimated_fee_lamports >= 0
      AND estimated_fee_lamports = trunc(estimated_fee_lamports)
      AND scale(estimated_fee_lamports) = 0
      AND estimated_fee_lamports < 18446744073709551616
    ))
    AND (simulated_fee_payer_lamport_debit IS NULL OR (
      simulated_fee_payer_lamport_debit <> 'NaN'::NUMERIC
      AND simulated_fee_payer_lamport_debit >= 0
      AND simulated_fee_payer_lamport_debit = trunc(simulated_fee_payer_lamport_debit)
      AND scale(simulated_fee_payer_lamport_debit) = 0
      AND simulated_fee_payer_lamport_debit < 18446744073709551616
    ))
    AND (simulated_base_delta_raw IS NULL OR (
      simulated_base_delta_raw <> 'NaN'::NUMERIC
      AND simulated_base_delta_raw = trunc(simulated_base_delta_raw)
      AND scale(simulated_base_delta_raw) = 0
      AND simulated_base_delta_raw BETWEEN -18446744073709551615 AND 18446744073709551615
    ))
    AND (simulated_quote_delta_raw IS NULL OR (
      simulated_quote_delta_raw <> 'NaN'::NUMERIC
      AND simulated_quote_delta_raw = trunc(simulated_quote_delta_raw)
      AND scale(simulated_quote_delta_raw) = 0
      AND simulated_quote_delta_raw BETWEEN -18446744073709551615 AND 18446744073709551615
    ))
    AND (protected_amount_out_raw IS NULL OR expected_amount_out_raw IS NULL
      OR protected_amount_out_raw <= expected_amount_out_raw)
  ),
  CONSTRAINT execution_simulation_artifacts_metrics_check CHECK (
    (units_consumed IS NULL OR units_consumed > 0)
    AND rpc_calls_used BETWEEN 0 AND 2147483647
    AND rpc_calls_limit BETWEEN 1 AND 2147483647
    AND rpc_calls_used <= rpc_calls_limit
    AND (logs_line_count IS NULL OR logs_line_count BETWEEN 1 AND 2147483647)
  ),
  CONSTRAINT execution_simulation_artifacts_enum_check CHECK (
    result_kind IN (
      'PROVIDER_FAILED', 'QUOTE_FAILED', 'BUILD_FAILED', 'BLOCKHASH_FAILED',
      'FEE_FAILED', 'SIMULATION_FAILED', 'SUCCESS'
    )
    AND (effective_venue IS NULL OR effective_venue IN ('PUMP_FUN', 'PUMP_SWAP'))
    AND quote_status IN ('NOT_RUN', 'SUCCEEDED', 'FAILED')
    AND build_status IN ('NOT_RUN', 'SUCCEEDED', 'FAILED')
    AND simulation_status IN ('NOT_RUN', 'SUCCEEDED', 'FAILED')
    AND (failure_stage IS NULL OR failure_stage IN (
      'PROVIDER', 'QUOTE', 'BUILD', 'BLOCKHASH', 'FEE', 'SIMULATION'
    ))
    AND (failure_code IS NULL OR failure_code IN (
      'QUOTE_REJECTED', 'BUILD_POLICY_REJECTED', 'RPC_RATE_LIMITED', 'RPC_TIMEOUT',
      'RPC_UNAVAILABLE', 'RPC_RESPONSE_INVALID', 'SIMULATION_EVIDENCE_INVALID',
      'SIMULATION_PROGRAM_ERROR', 'GENESIS_MISMATCH'
    ))
    AND terminal_reason_code IN (
      'QUOTE_STALE', 'QUOTE_MINT_NOT_ALLOWED', 'VENUE_UNAVAILABLE',
      'SELL_QUOTE_UNAVAILABLE', 'MINIMUM_AMOUNT_OUT_VIOLATED',
      'UNSUPPORTED_TOKEN_EXTENSION', 'BUY_SIMULATION_FAILED',
      'SELL_SIMULATION_FAILED', 'GENESIS_MISMATCH', 'EXECUTION_PROVIDER_FAILED',
      'EXECUTION_BUILD_FAILED', 'EXECUTION_EVIDENCE_INVALID', 'INTENT_SUCCEEDED'
    )
  ),
  CONSTRAINT execution_simulation_artifacts_causality_check CHECK (
    (snapshot_fingerprint IS NULL) = (snapshot_slot IS NULL)
    AND (logs_fingerprint IS NULL) = (logs_line_count IS NULL)
    AND (simulated_base_delta_raw IS NULL) = (simulated_quote_delta_raw IS NULL)
    AND (snapshot_slot IS NULL OR blockhash_context_slot IS NULL
      OR snapshot_slot <= blockhash_context_slot)
    AND (snapshot_slot IS NULL OR fee_context_slot IS NULL
      OR snapshot_slot <= fee_context_slot)
    AND (blockhash_context_slot IS NULL OR simulation_slot IS NULL
      OR blockhash_context_slot <= simulation_slot)
  ),
  CONSTRAINT execution_simulation_artifacts_failure_mapping_check CHECK (
    (failure_code IS NULL AND failure_stage IS NULL
      AND terminal_reason_code = 'INTENT_SUCCEEDED')
    OR (failure_code = 'GENESIS_MISMATCH' AND failure_stage = 'PROVIDER'
      AND observed_genesis_hash IS NOT NULL
      AND observed_genesis_hash <> expected_genesis_hash
      AND terminal_reason_code = 'GENESIS_MISMATCH')
    OR (failure_code IN ('RPC_RATE_LIMITED', 'RPC_TIMEOUT', 'RPC_UNAVAILABLE')
      AND terminal_reason_code = 'EXECUTION_PROVIDER_FAILED')
    OR (failure_code IN ('RPC_RESPONSE_INVALID', 'SIMULATION_EVIDENCE_INVALID')
      AND terminal_reason_code = 'EXECUTION_EVIDENCE_INVALID')
    OR (failure_code = 'BUILD_POLICY_REJECTED' AND failure_stage = 'BUILD'
      AND terminal_reason_code = 'EXECUTION_BUILD_FAILED')
    OR (failure_code = 'SIMULATION_PROGRAM_ERROR' AND failure_stage = 'SIMULATION'
      AND terminal_reason_code IN ('BUY_SIMULATION_FAILED', 'SELL_SIMULATION_FAILED'))
    OR (failure_code = 'QUOTE_REJECTED' AND failure_stage = 'QUOTE'
      AND terminal_reason_code IN (
        'QUOTE_STALE', 'QUOTE_MINT_NOT_ALLOWED', 'VENUE_UNAVAILABLE',
        'SELL_QUOTE_UNAVAILABLE', 'MINIMUM_AMOUNT_OUT_VIOLATED',
        'UNSUPPORTED_TOKEN_EXTENSION'
      ))
  ),
  CONSTRAINT execution_simulation_artifacts_result_shape_check CHECK (
    (result_kind = 'PROVIDER_FAILED'
      AND quote_status = 'FAILED' AND build_status = 'NOT_RUN'
      AND simulation_status = 'NOT_RUN' AND failure_stage = 'PROVIDER'
      AND effective_venue IS NULL
      AND quote_fingerprint IS NULL AND snapshot_fingerprint IS NULL
      AND snapshot_slot IS NULL AND amount_in_raw IS NULL
      AND expected_amount_out_raw IS NULL AND protected_amount_out_raw IS NULL
      AND fees_raw IS NULL AND build_fingerprint IS NULL
      AND message_hash IS NULL AND blockhash IS NULL
      AND last_valid_block_height IS NULL AND blockhash_context_slot IS NULL
      AND fee_context_slot IS NULL AND estimated_fee_lamports IS NULL
      AND simulation_slot IS NULL AND simulated_fee_payer_lamport_debit IS NULL
      AND units_consumed IS NULL AND simulated_base_delta_raw IS NULL
      AND simulated_quote_delta_raw IS NULL AND logs_fingerprint IS NULL
      AND logs_line_count IS NULL)
    OR (result_kind = 'QUOTE_FAILED'
      AND quote_status = 'FAILED' AND build_status = 'NOT_RUN'
      AND simulation_status = 'NOT_RUN' AND failure_stage = 'QUOTE'
      AND observed_genesis_hash IS NOT NULL
      AND quote_fingerprint IS NULL AND amount_in_raw IS NULL
      AND expected_amount_out_raw IS NULL AND protected_amount_out_raw IS NULL
      AND fees_raw IS NULL AND build_fingerprint IS NULL
      AND message_hash IS NULL AND blockhash IS NULL
      AND last_valid_block_height IS NULL AND blockhash_context_slot IS NULL
      AND fee_context_slot IS NULL AND estimated_fee_lamports IS NULL
      AND simulation_slot IS NULL AND simulated_fee_payer_lamport_debit IS NULL
      AND units_consumed IS NULL AND simulated_base_delta_raw IS NULL
      AND simulated_quote_delta_raw IS NULL AND logs_fingerprint IS NULL
      AND logs_line_count IS NULL)
    OR (result_kind = 'BUILD_FAILED'
      AND quote_status = 'SUCCEEDED' AND build_status = 'FAILED'
      AND simulation_status = 'NOT_RUN' AND failure_stage = 'BUILD'
      AND effective_venue IS NOT NULL AND observed_genesis_hash IS NOT NULL
      AND quote_fingerprint IS NOT NULL AND snapshot_fingerprint IS NOT NULL
      AND snapshot_slot IS NOT NULL AND amount_in_raw IS NOT NULL
      AND expected_amount_out_raw IS NOT NULL AND protected_amount_out_raw IS NOT NULL
      AND fees_raw IS NOT NULL AND build_fingerprint IS NULL
      AND message_hash IS NULL AND blockhash IS NULL
      AND last_valid_block_height IS NULL AND blockhash_context_slot IS NULL
      AND fee_context_slot IS NULL AND estimated_fee_lamports IS NULL
      AND simulation_slot IS NULL AND simulated_fee_payer_lamport_debit IS NULL
      AND units_consumed IS NULL AND simulated_base_delta_raw IS NULL
      AND simulated_quote_delta_raw IS NULL AND logs_fingerprint IS NULL
      AND logs_line_count IS NULL)
    OR (result_kind = 'BLOCKHASH_FAILED'
      AND quote_status = 'SUCCEEDED' AND build_status = 'SUCCEEDED'
      AND simulation_status = 'NOT_RUN' AND failure_stage = 'BLOCKHASH'
      AND effective_venue IS NOT NULL AND observed_genesis_hash IS NOT NULL
      AND quote_fingerprint IS NOT NULL AND snapshot_fingerprint IS NOT NULL
      AND snapshot_slot IS NOT NULL AND amount_in_raw IS NOT NULL
      AND expected_amount_out_raw IS NOT NULL AND protected_amount_out_raw IS NOT NULL
      AND fees_raw IS NOT NULL AND build_fingerprint IS NOT NULL
      AND message_hash IS NULL AND blockhash IS NULL
      AND last_valid_block_height IS NULL AND blockhash_context_slot IS NULL
      AND fee_context_slot IS NULL AND estimated_fee_lamports IS NULL
      AND simulation_slot IS NULL AND simulated_fee_payer_lamport_debit IS NULL
      AND units_consumed IS NULL AND simulated_base_delta_raw IS NULL
      AND simulated_quote_delta_raw IS NULL AND logs_fingerprint IS NULL
      AND logs_line_count IS NULL)
    OR (result_kind = 'FEE_FAILED'
      AND quote_status = 'SUCCEEDED' AND build_status = 'SUCCEEDED'
      AND simulation_status = 'NOT_RUN' AND failure_stage = 'FEE'
      AND effective_venue IS NOT NULL AND observed_genesis_hash IS NOT NULL
      AND quote_fingerprint IS NOT NULL AND snapshot_fingerprint IS NOT NULL
      AND snapshot_slot IS NOT NULL AND amount_in_raw IS NOT NULL
      AND expected_amount_out_raw IS NOT NULL AND protected_amount_out_raw IS NOT NULL
      AND fees_raw IS NOT NULL AND build_fingerprint IS NOT NULL
      AND message_hash IS NOT NULL AND blockhash IS NOT NULL
      AND last_valid_block_height IS NOT NULL AND blockhash_context_slot IS NOT NULL
      AND fee_context_slot IS NULL AND estimated_fee_lamports IS NULL
      AND simulation_slot IS NULL AND simulated_fee_payer_lamport_debit IS NULL
      AND units_consumed IS NULL AND simulated_base_delta_raw IS NULL
      AND simulated_quote_delta_raw IS NULL AND logs_fingerprint IS NULL
      AND logs_line_count IS NULL)
    OR (result_kind = 'SIMULATION_FAILED'
      AND quote_status = 'SUCCEEDED' AND build_status = 'SUCCEEDED'
      AND simulation_status = 'FAILED' AND failure_stage = 'SIMULATION'
      AND effective_venue IS NOT NULL AND observed_genesis_hash IS NOT NULL
      AND quote_fingerprint IS NOT NULL AND snapshot_fingerprint IS NOT NULL
      AND snapshot_slot IS NOT NULL AND amount_in_raw IS NOT NULL
      AND expected_amount_out_raw IS NOT NULL AND protected_amount_out_raw IS NOT NULL
      AND fees_raw IS NOT NULL AND build_fingerprint IS NOT NULL
      AND message_hash IS NOT NULL AND blockhash IS NOT NULL
      AND last_valid_block_height IS NOT NULL AND blockhash_context_slot IS NOT NULL
      AND fee_context_slot IS NOT NULL AND estimated_fee_lamports IS NOT NULL)
    OR (result_kind = 'SUCCESS'
      AND quote_status = 'SUCCEEDED' AND build_status = 'SUCCEEDED'
      AND simulation_status = 'SUCCEEDED' AND failure_stage IS NULL
      AND failure_code IS NULL AND terminal_reason_code = 'INTENT_SUCCEEDED'
      AND effective_venue IS NOT NULL AND observed_genesis_hash IS NOT NULL
      AND quote_fingerprint IS NOT NULL AND snapshot_fingerprint IS NOT NULL
      AND snapshot_slot IS NOT NULL AND amount_in_raw IS NOT NULL
      AND expected_amount_out_raw IS NOT NULL AND protected_amount_out_raw IS NOT NULL
      AND fees_raw IS NOT NULL AND build_fingerprint IS NOT NULL
      AND message_hash IS NOT NULL AND blockhash IS NOT NULL
      AND last_valid_block_height IS NOT NULL AND blockhash_context_slot IS NOT NULL
      AND fee_context_slot IS NOT NULL AND estimated_fee_lamports IS NOT NULL
      AND simulation_slot IS NOT NULL AND simulated_fee_payer_lamport_debit IS NOT NULL
      AND units_consumed IS NOT NULL AND simulated_base_delta_raw IS NOT NULL
      AND simulated_quote_delta_raw IS NOT NULL AND logs_fingerprint IS NOT NULL
      AND logs_line_count IS NOT NULL)
  ),
  CONSTRAINT execution_simulation_artifacts_recorded_at_check CHECK (
    isfinite(recorded_at)
    AND recorded_at >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
    AND recorded_at <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds', recorded_at) = recorded_at
  )
);

CREATE OR REPLACE FUNCTION reject_execution_simulation_artifact_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'execution_simulation_artifacts is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS execution_simulation_artifacts_reject_update
  ON execution_simulation_artifacts;
CREATE TRIGGER execution_simulation_artifacts_reject_update
  BEFORE UPDATE ON execution_simulation_artifacts
  FOR EACH ROW EXECUTE FUNCTION reject_execution_simulation_artifact_update();
