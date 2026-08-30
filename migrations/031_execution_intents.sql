CREATE TABLE IF NOT EXISTS execution_intents (
  id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  logical_order_key TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy_version INTEGER NOT NULL,
  position_id TEXT NOT NULL,
  logical_command_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  side TEXT NOT NULL,
  venue_policy TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  quote_token_program TEXT NOT NULL,
  quote_decimals SMALLINT NOT NULL,
  -- Keep NUMERIC unscaled: NUMERIC(p,0) would round fractional input before
  -- its CHECK constraints could reject it.
  quote_amount_raw NUMERIC,
  base_amount_raw NUMERIC,
  minimum_amount_out_raw NUMERIC NOT NULL,
  decision_event_id TEXT NOT NULL,
  decision_fingerprint TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  last_reason_code TEXT,
  terminal_at TIMESTAMPTZ,
  reconciliation_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  purge_after TIMESTAMPTZ,
  CONSTRAINT execution_intents_payload_version_check CHECK (payload_version = 1),
  CONSTRAINT execution_intents_logical_order_key_unique UNIQUE (logical_order_key),
  CONSTRAINT execution_intents_text_check CHECK (
    octet_length(id) BETWEEN 1 AND 256
    AND octet_length(logical_order_key) BETWEEN 1 AND 256
    AND octet_length(strategy_id) BETWEEN 1 AND 256
    AND octet_length(position_id) BETWEEN 1 AND 256
    AND octet_length(logical_command_id) BETWEEN 1 AND 256
    AND octet_length(mint) BETWEEN 1 AND 256
    AND octet_length(quote_mint) BETWEEN 1 AND 256
    AND octet_length(decision_event_id) BETWEEN 1 AND 256
    AND (lease_owner IS NULL OR octet_length(lease_owner) BETWEEN 1 AND 256)
  ),
  CONSTRAINT execution_intents_strategy_version_check CHECK (strategy_version > 0),
  CONSTRAINT execution_intents_side_check CHECK (side IN ('BUY', 'SELL')),
  CONSTRAINT execution_intents_venue_policy_check CHECK (
    venue_policy IN ('PUMP_FUN_ONLY', 'CANONICAL_EXIT')
  ),
  CONSTRAINT execution_intents_quote_token_program_check CHECK (
    quote_token_program IN ('SPL_TOKEN', 'TOKEN_2022')
  ),
  CONSTRAINT execution_intents_quote_decimals_check CHECK (quote_decimals BETWEEN 0 AND 255),
  CONSTRAINT execution_intents_side_venue_amount_check CHECK (
    (side = 'BUY'
      AND venue_policy = 'PUMP_FUN_ONLY'
      AND quote_amount_raw IS NOT NULL
      AND quote_amount_raw > 0
      AND base_amount_raw IS NULL)
    OR (side = 'SELL'
      AND venue_policy = 'CANONICAL_EXIT'
      AND base_amount_raw IS NOT NULL
      AND base_amount_raw > 0
      AND quote_amount_raw IS NULL)
  ),
  CONSTRAINT execution_intents_amounts_check CHECK (
    (quote_amount_raw IS NULL OR (
      quote_amount_raw <> 'NaN'::NUMERIC
      AND quote_amount_raw > 0
      AND quote_amount_raw = trunc(quote_amount_raw)
      AND scale(quote_amount_raw) = 0
      AND quote_amount_raw < 18446744073709551616
    ))
    AND (base_amount_raw IS NULL OR (
      base_amount_raw <> 'NaN'::NUMERIC
      AND base_amount_raw > 0
      AND base_amount_raw = trunc(base_amount_raw)
      AND scale(base_amount_raw) = 0
      AND base_amount_raw < 18446744073709551616
    ))
    AND minimum_amount_out_raw <> 'NaN'::NUMERIC
    AND minimum_amount_out_raw > 0
    AND minimum_amount_out_raw = trunc(minimum_amount_out_raw)
    AND scale(minimum_amount_out_raw) = 0
    AND minimum_amount_out_raw < 18446744073709551616
  ),
  CONSTRAINT execution_intents_fingerprint_check CHECK (
    decision_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT execution_intents_status_check CHECK (status IN (
    'PENDING', 'PROCESSING', 'SIMULATED', 'RETRY_READY', 'SIGNED_NOT_SUBMITTED',
    'SUBMITTED', 'CONFIRMED', 'RECONCILING', 'SUCCEEDED', 'FAILED', 'EXPIRED',
    'CANCELLED', 'UNKNOWN_REQUIRES_RECONCILIATION'
  )),
  CONSTRAINT execution_intents_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT execution_intents_reason_check CHECK (
    last_reason_code IS NULL OR last_reason_code IN (
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
      'BALANCE_MISMATCH', 'RESIDUAL_TOKEN_BALANCE', 'DOUBLE_ORDER_SUSPECTED'
    )
  ),
  CONSTRAINT execution_intents_temporal_check CHECK (
    isfinite(requested_at)
    AND requested_at >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
    AND requested_at <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds', requested_at) = requested_at
    AND isfinite(expires_at)
    AND expires_at >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
    AND expires_at <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds', expires_at) = expires_at
    AND isfinite(created_at)
    AND created_at >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
    AND created_at <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds', created_at) = created_at
    AND isfinite(updated_at)
    AND updated_at >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
    AND updated_at <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds', updated_at) = updated_at
    AND (terminal_at IS NULL OR (
      isfinite(terminal_at)
      AND terminal_at >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
      AND terminal_at <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
      AND date_trunc('milliseconds', terminal_at) = terminal_at
    ))
    AND (reconciliation_completed_at IS NULL OR (
      isfinite(reconciliation_completed_at)
      AND reconciliation_completed_at >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
      AND reconciliation_completed_at <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
      AND date_trunc('milliseconds', reconciliation_completed_at) = reconciliation_completed_at
    ))
    AND (purge_after IS NULL OR (
      isfinite(purge_after)
      AND purge_after >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
      AND purge_after <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
      AND date_trunc('milliseconds', purge_after) = purge_after
    ))
    AND (lease_expires_at IS NULL OR (
      isfinite(lease_expires_at)
      AND lease_expires_at >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
      AND lease_expires_at <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
      AND date_trunc('milliseconds', lease_expires_at) = lease_expires_at
    ))
    AND expires_at > requested_at
    AND updated_at >= created_at
    AND (terminal_at IS NULL OR terminal_at >= requested_at)
    AND (reconciliation_completed_at IS NULL OR reconciliation_completed_at >= terminal_at)
  ),
  CONSTRAINT execution_intents_lease_check CHECK (
    (lease_owner IS NULL) = (lease_token IS NULL)
    AND (lease_owner IS NULL) = (lease_expires_at IS NULL)
  ),
  CONSTRAINT execution_intents_terminal_check CHECK (
    (status IN ('SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED')
      AND terminal_at IS NOT NULL
      AND lease_owner IS NULL)
    OR (status NOT IN ('SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED')
      AND terminal_at IS NULL)
  ),
  CONSTRAINT execution_intents_reconciliation_retention_check CHECK (
    (reconciliation_completed_at IS NULL OR terminal_at IS NOT NULL)
    AND (purge_after IS NULL OR (
      terminal_at IS NOT NULL
      AND reconciliation_completed_at IS NOT NULL
      AND purge_after = reconciliation_completed_at + INTERVAL '4 hours'
    ))
  ),
  CONSTRAINT execution_intents_pending_check CHECK (
    status <> 'PENDING' OR (
      attempt_count = 0
      AND last_reason_code IS NULL
      AND terminal_at IS NULL
      AND reconciliation_completed_at IS NULL
      AND purge_after IS NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS execution_attempts (
  intent_id TEXT NOT NULL REFERENCES execution_intents(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  effective_venue TEXT,
  provider_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  completed_at TIMESTAMPTZ,
  reason_code TEXT,
  purge_after TIMESTAMPTZ,
  PRIMARY KEY (intent_id, attempt_number),
  CONSTRAINT execution_attempts_number_check CHECK (attempt_number > 0),
  CONSTRAINT execution_attempts_status_check CHECK (status IN ('STARTED', 'COMPLETED', 'ABANDONED')),
  CONSTRAINT execution_attempts_effective_venue_check CHECK (
    effective_venue IS NULL OR effective_venue IN ('PUMP_FUN', 'PUMP_SWAP')
  ),
  CONSTRAINT execution_attempts_provider_check CHECK (
    provider_id IS NULL OR octet_length(provider_id) BETWEEN 1 AND 256
  ),
  CONSTRAINT execution_attempts_reason_check CHECK (
    reason_code IS NULL OR reason_code IN (
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
      'BALANCE_MISMATCH', 'RESIDUAL_TOKEN_BALANCE', 'DOUBLE_ORDER_SUSPECTED'
    )
  ),
  CONSTRAINT execution_attempts_lifecycle_check CHECK (
    (status = 'STARTED' AND completed_at IS NULL)
    OR (status IN ('COMPLETED', 'ABANDONED') AND completed_at IS NOT NULL)
  ),
  CONSTRAINT execution_attempts_temporal_check CHECK (
    isfinite(started_at)
    AND started_at >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
    AND started_at <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds', started_at) = started_at
    AND (completed_at IS NULL OR (
      isfinite(completed_at)
      AND completed_at >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
      AND completed_at <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
      AND date_trunc('milliseconds', completed_at) = completed_at
    ))
    AND (purge_after IS NULL OR (
      isfinite(purge_after)
      AND purge_after >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
      AND purge_after <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
      AND date_trunc('milliseconds', purge_after) = purge_after
    ))
    AND (completed_at IS NULL OR completed_at >= started_at)
    AND (purge_after IS NULL OR (
      completed_at IS NOT NULL
      AND purge_after >= completed_at
    ))
  ),
  CONSTRAINT execution_attempts_retention_check CHECK (purge_after IS NULL)
);

CREATE TABLE IF NOT EXISTS execution_intent_transitions (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES execution_intents(id) ON DELETE CASCADE,
  previous_status TEXT NOT NULL,
  next_status TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  human_message TEXT NOT NULL,
  activation_phase TEXT NOT NULL,
  attempt_number INTEGER,
  evidence JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  CONSTRAINT execution_intent_transitions_previous_status_check CHECK (previous_status IN (
    'PENDING', 'PROCESSING', 'SIMULATED', 'RETRY_READY', 'SIGNED_NOT_SUBMITTED',
    'SUBMITTED', 'CONFIRMED', 'RECONCILING', 'SUCCEEDED', 'FAILED', 'EXPIRED',
    'CANCELLED', 'UNKNOWN_REQUIRES_RECONCILIATION'
  )),
  CONSTRAINT execution_intent_transitions_next_status_check CHECK (next_status IN (
    'PENDING', 'PROCESSING', 'SIMULATED', 'RETRY_READY', 'SIGNED_NOT_SUBMITTED',
    'SUBMITTED', 'CONFIRMED', 'RECONCILING', 'SUCCEEDED', 'FAILED', 'EXPIRED',
    'CANCELLED', 'UNKNOWN_REQUIRES_RECONCILIATION'
  )),
  CONSTRAINT execution_intent_transitions_reason_check CHECK (reason_code IN (
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
    'BALANCE_MISMATCH', 'RESIDUAL_TOKEN_BALANCE', 'DOUBLE_ORDER_SUSPECTED'
  )),
  CONSTRAINT execution_intent_transitions_human_message_check CHECK (
    octet_length(human_message) BETWEEN 1 AND 256
  ),
  CONSTRAINT execution_intent_transitions_activation_phase_check CHECK (
    activation_phase IN ('NONE', 'CANARY', 'MICRO_LIVE', 'PILOT')
  ),
  CONSTRAINT execution_intent_transitions_attempt_number_check CHECK (
    attempt_number IS NULL OR attempt_number > 0
  ),
  CONSTRAINT execution_intent_transitions_evidence_check CHECK (
    jsonb_typeof(evidence) = 'object'
    AND evidence ?& ARRAY['payloadVersion', 'attemptNumber', 'sourceEventId', 'observedAtMs']
    AND evidence - ARRAY['payloadVersion', 'attemptNumber', 'sourceEventId', 'observedAtMs'] = '{}'::JSONB
    AND jsonb_typeof(evidence -> 'payloadVersion') = 'number'
    AND evidence -> 'payloadVersion' = '1'::JSONB
    AND (
      evidence -> 'attemptNumber' = 'null'::JSONB
      OR (
        jsonb_typeof(evidence -> 'attemptNumber') = 'number'
        AND evidence ->> 'attemptNumber' ~ '^[1-9][0-9]{0,9}$'
        AND (
          char_length(evidence ->> 'attemptNumber') < 10
          OR evidence ->> 'attemptNumber' <= '2147483647'
        )
      )
    )
    AND (
      (attempt_number IS NULL AND evidence -> 'attemptNumber' = 'null'::JSONB)
      OR (
        attempt_number IS NOT NULL
        AND evidence -> 'attemptNumber' = to_jsonb(attempt_number)
      )
    )
    AND (
      evidence -> 'sourceEventId' = 'null'::JSONB
      OR (
        jsonb_typeof(evidence -> 'sourceEventId') = 'string'
        AND octet_length(evidence ->> 'sourceEventId') BETWEEN 1 AND 256
      )
    )
    AND jsonb_typeof(evidence -> 'observedAtMs') = 'number'
    AND evidence ->> 'observedAtMs' ~ '^(0|[1-9][0-9]{0,15})$'
    AND (
      char_length(evidence ->> 'observedAtMs') < 16
      OR evidence ->> 'observedAtMs' <= '8640000000000000'
    )
    AND octet_length(evidence::TEXT) <= 16384
  ),
  CONSTRAINT execution_intent_transitions_occurred_at_check CHECK (
    isfinite(occurred_at)
    AND occurred_at >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
    AND occurred_at <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds', occurred_at) = occurred_at
  )
);

CREATE INDEX IF NOT EXISTS execution_intents_claim_idx
  ON execution_intents (requested_at, id)
  WHERE status = 'PENDING';
