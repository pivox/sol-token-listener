ALTER TABLE paper_mvp_runs
  ADD COLUMN IF NOT EXISTS entry_quote_amount_raw NUMERIC(78,0),
  ADD COLUMN IF NOT EXISTS slippage_bps NUMERIC(78,0),
  ADD COLUMN IF NOT EXISTS minimum_confirmation TEXT,
  ADD COLUMN IF NOT EXISTS entry_window_ms INTEGER,
  ADD COLUMN IF NOT EXISTS quote_max_age_ms INTEGER,
  ADD COLUMN IF NOT EXISTS quote_max_slot_lag INTEGER,
  ADD COLUMN IF NOT EXISTS creation_entry_max_age_ms INTEGER,
  ADD COLUMN IF NOT EXISTS creation_entry_max_slot_lag INTEGER,
  ADD COLUMN IF NOT EXISTS external_minimum_buy_amount_raw NUMERIC(78,0),
  ADD COLUMN IF NOT EXISTS manual_kill_switch BOOLEAN,
  ADD COLUMN IF NOT EXISTS maximum_round_trip_loss_bps NUMERIC(78,0),
  ADD COLUMN IF NOT EXISTS decision_poll_interval_ms INTEGER,
  ADD COLUMN IF NOT EXISTS decision_lease_ms INTEGER,
  ADD COLUMN IF NOT EXISTS decision_retry_max_attempts INTEGER,
  ADD COLUMN IF NOT EXISTS decision_retry_base_delay_ms INTEGER,
  ADD COLUMN IF NOT EXISTS qualification_profile_fingerprint TEXT;

ALTER TABLE paper_mvp_runs
  DROP CONSTRAINT IF EXISTS paper_mvp_runs_payload_version_check,
  DROP CONSTRAINT IF EXISTS paper_mvp_runs_exact_strategy_configuration_check;

ALTER TABLE paper_mvp_runs
  ADD CONSTRAINT paper_mvp_runs_payload_version_check CHECK (payload_version IN (1,2,3)),
  ADD CONSTRAINT paper_mvp_runs_exact_strategy_configuration_check CHECK ((
    (payload_version=1
      AND external_unique_buyers_target IS NULL
      AND take_profit_multiplier_bps IS NULL
      AND entry_quote_amount_raw IS NULL
      AND slippage_bps IS NULL
      AND minimum_confirmation IS NULL
      AND entry_window_ms IS NULL
      AND quote_max_age_ms IS NULL
      AND quote_max_slot_lag IS NULL
      AND creation_entry_max_age_ms IS NULL
      AND creation_entry_max_slot_lag IS NULL
      AND external_minimum_buy_amount_raw IS NULL
      AND manual_kill_switch IS NULL
      AND maximum_round_trip_loss_bps IS NULL
      AND decision_poll_interval_ms IS NULL
      AND decision_lease_ms IS NULL
      AND decision_retry_max_attempts IS NULL
      AND decision_retry_base_delay_ms IS NULL
      AND qualification_profile_fingerprint IS NULL)
    OR
    (payload_version=2
      AND external_unique_buyers_target BETWEEN 1 AND 1000
      AND take_profit_multiplier_bps BETWEEN 10000 AND 1000000
      AND configuration_payload->>'schemaVersion'='paper-mvp-run-configuration.v2'
      AND configuration_payload->>'externalUniqueBuyersTarget'
        = external_unique_buyers_target::text
      AND configuration_payload->>'takeProfitMultiplierBps'
        = take_profit_multiplier_bps::text
      AND entry_quote_amount_raw IS NULL
      AND slippage_bps IS NULL
      AND minimum_confirmation IS NULL
      AND entry_window_ms IS NULL
      AND quote_max_age_ms IS NULL
      AND quote_max_slot_lag IS NULL
      AND creation_entry_max_age_ms IS NULL
      AND creation_entry_max_slot_lag IS NULL
      AND external_minimum_buy_amount_raw IS NULL
      AND manual_kill_switch IS NULL
      AND maximum_round_trip_loss_bps IS NULL
      AND decision_poll_interval_ms IS NULL
      AND decision_lease_ms IS NULL
      AND decision_retry_max_attempts IS NULL
      AND decision_retry_base_delay_ms IS NULL
      AND qualification_profile_fingerprint IS NULL)
    OR
    (payload_version=3
      AND entry_quote_amount_raw > 0
      AND slippage_bps BETWEEN 0 AND 10000
      AND minimum_confirmation IN ('confirmed','finalized')
      AND entry_window_ms BETWEEN 1000 AND 3600000
      AND quote_max_age_ms BETWEEN 100 AND 60000
      AND quote_max_slot_lag BETWEEN 0 AND 10000
      AND creation_entry_max_age_ms BETWEEN 100 AND 3600000
      AND creation_entry_max_slot_lag BETWEEN 0 AND 10000
      AND external_minimum_buy_amount_raw > 0
      AND external_unique_buyers_target BETWEEN 1 AND 1000
      AND take_profit_multiplier_bps BETWEEN 10000 AND 1000000
      AND manual_kill_switch IS NOT NULL
      AND maximum_round_trip_loss_bps BETWEEN 0 AND 10000
      AND decision_poll_interval_ms BETWEEN 100 AND 60000
      AND decision_lease_ms BETWEEN 5000 AND 900000
      AND decision_retry_max_attempts BETWEEN 1 AND 100
      AND decision_retry_base_delay_ms BETWEEN 100 AND 60000
      AND qualification_profile_fingerprint ~ '^[a-f0-9]{64}$'
      AND configuration_payload->>'schemaVersion'='paper-mvp-run-configuration.v3'
      AND configuration_payload->>'strategyId'=strategy_id
      AND configuration_payload->>'strategyVersion'=strategy_version::text
      AND configuration_payload->>'quoteMint'=quote_mint
      AND configuration_payload->>'targetClosedPositions'=target_closed_positions::text
      AND configuration_payload->>'initialCapitalRaw'=initial_capital_raw::text
      AND configuration_payload->>'networkFeeRawPerTransaction'
        = network_fee_raw_per_transaction::text
      AND configuration_payload->>'maxDurationMs'=max_duration_ms::text
      AND configuration_payload->>'entryQuoteAmountRaw'=entry_quote_amount_raw::text
      AND configuration_payload->>'slippageBps'=slippage_bps::text
      AND configuration_payload->>'minimumConfirmation'=minimum_confirmation
      AND configuration_payload->>'entryWindowMs'=entry_window_ms::text
      AND configuration_payload->>'quoteMaxAgeMs'=quote_max_age_ms::text
      AND configuration_payload->>'quoteMaxSlotLag'=quote_max_slot_lag::text
      AND configuration_payload->>'creationEntryMaxAgeMs'=creation_entry_max_age_ms::text
      AND configuration_payload->>'creationEntryMaxSlotLag'=creation_entry_max_slot_lag::text
      AND configuration_payload->>'externalMinimumBuyAmountRaw'
        = external_minimum_buy_amount_raw::text
      AND configuration_payload->>'externalUniqueBuyersTarget'
        = external_unique_buyers_target::text
      AND configuration_payload->>'takeProfitMultiplierBps'=take_profit_multiplier_bps::text
      AND configuration_payload->>'manualKillSwitch'=manual_kill_switch::text
      AND configuration_payload->>'maximumRoundTripLossBps'
        = maximum_round_trip_loss_bps::text
      AND configuration_payload->>'decisionPollIntervalMs'=decision_poll_interval_ms::text
      AND configuration_payload->>'decisionLeaseMs'=decision_lease_ms::text
      AND configuration_payload->>'decisionRetryMaxAttempts'
        = decision_retry_max_attempts::text
      AND configuration_payload->>'decisionRetryBaseDelayMs'
        = decision_retry_base_delay_ms::text
      AND configuration_payload->>'qualificationProfileFingerprint'
        = qualification_profile_fingerprint
      AND configuration_payload->>'providerIdentity'=provider_identity)
    ) IS TRUE
  );

-- Historical v1/v2 rows remain untouched. The v3 repository refuses to claim
-- active legacy runs instead of inventing missing strategy evidence.
CREATE OR REPLACE FUNCTION prevent_paper_mvp_run_immutable_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('COMPLETED','FAILED') THEN
    RAISE EXCEPTION 'paper MVP terminal run is immutable';
  END IF;
  IF ROW(
    NEW.strategy_id,NEW.strategy_version,NEW.quote_mint,NEW.target_closed_positions,
    NEW.initial_capital_raw,NEW.network_fee_raw_per_transaction,NEW.max_duration_ms,
    NEW.entry_quote_amount_raw,NEW.slippage_bps,NEW.minimum_confirmation,
    NEW.entry_window_ms,NEW.quote_max_age_ms,NEW.quote_max_slot_lag,
    NEW.creation_entry_max_age_ms,NEW.creation_entry_max_slot_lag,
    NEW.external_minimum_buy_amount_raw,NEW.external_unique_buyers_target,
    NEW.take_profit_multiplier_bps,NEW.manual_kill_switch,
    NEW.maximum_round_trip_loss_bps,NEW.decision_poll_interval_ms,
    NEW.decision_lease_ms,NEW.decision_retry_max_attempts,
    NEW.decision_retry_base_delay_ms,NEW.qualification_profile_fingerprint,
    NEW.provider_identity,NEW.started_at,NEW.deadline_at,NEW.payload_version,
    NEW.configuration_payload
  ) IS DISTINCT FROM ROW(
    OLD.strategy_id,OLD.strategy_version,OLD.quote_mint,OLD.target_closed_positions,
    OLD.initial_capital_raw,OLD.network_fee_raw_per_transaction,OLD.max_duration_ms,
    OLD.entry_quote_amount_raw,OLD.slippage_bps,OLD.minimum_confirmation,
    OLD.entry_window_ms,OLD.quote_max_age_ms,OLD.quote_max_slot_lag,
    OLD.creation_entry_max_age_ms,OLD.creation_entry_max_slot_lag,
    OLD.external_minimum_buy_amount_raw,OLD.external_unique_buyers_target,
    OLD.take_profit_multiplier_bps,OLD.manual_kill_switch,
    OLD.maximum_round_trip_loss_bps,OLD.decision_poll_interval_ms,
    OLD.decision_lease_ms,OLD.decision_retry_max_attempts,
    OLD.decision_retry_base_delay_ms,OLD.qualification_profile_fingerprint,
    OLD.provider_identity,OLD.started_at,OLD.deadline_at,OLD.payload_version,
    OLD.configuration_payload
  ) THEN
    RAISE EXCEPTION 'paper MVP run configuration is immutable';
  END IF;
  IF OLD.report_payload IS NOT NULL
    AND NEW.report_payload IS DISTINCT FROM OLD.report_payload THEN
    RAISE EXCEPTION 'paper MVP run report is immutable';
  END IF;
  RETURN NEW;
END
$$;
