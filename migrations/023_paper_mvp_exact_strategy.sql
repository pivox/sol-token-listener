ALTER TABLE paper_mvp_runs
  ADD COLUMN IF NOT EXISTS external_unique_buyers_target INTEGER,
  ADD COLUMN IF NOT EXISTS take_profit_multiplier_bps NUMERIC(78,0);

ALTER TABLE paper_mvp_runs
  DROP CONSTRAINT IF EXISTS paper_mvp_runs_payload_version_check,
  DROP CONSTRAINT IF EXISTS paper_mvp_runs_exact_strategy_configuration_check;

ALTER TABLE paper_mvp_runs
  ADD CONSTRAINT paper_mvp_runs_payload_version_check CHECK (payload_version IN (1,2)),
  ADD CONSTRAINT paper_mvp_runs_exact_strategy_configuration_check CHECK (
    (payload_version=1
      AND external_unique_buyers_target IS NULL
      AND take_profit_multiplier_bps IS NULL)
    OR
    (payload_version=2
      AND external_unique_buyers_target IS NOT NULL
      AND external_unique_buyers_target BETWEEN 1 AND 1000
      AND take_profit_multiplier_bps IS NOT NULL
      AND take_profit_multiplier_bps BETWEEN 10000 AND 1000000
      AND configuration_payload->>'schemaVersion'='paper-mvp-run-configuration.v2'
      AND configuration_payload->>'externalUniqueBuyersTarget'
        = external_unique_buyers_target::text
      AND configuration_payload->>'takeProfitMultiplierBps'
        = take_profit_multiplier_bps::text)
  );

-- Version 1 rows did not record the effective strategy thresholds. They remain
-- untouched and cannot be claimed by the version 2 repository, which fails
-- closed instead of inventing configuration evidence.
CREATE OR REPLACE FUNCTION prevent_paper_mvp_run_immutable_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('COMPLETED','FAILED') THEN
    RAISE EXCEPTION 'paper MVP terminal run is immutable';
  END IF;
  IF ROW(
    NEW.strategy_id,NEW.strategy_version,NEW.quote_mint,NEW.target_closed_positions,
    NEW.initial_capital_raw,NEW.network_fee_raw_per_transaction,NEW.max_duration_ms,
    NEW.external_unique_buyers_target,NEW.take_profit_multiplier_bps,
    NEW.provider_identity,NEW.started_at,NEW.deadline_at,NEW.payload_version,
    NEW.configuration_payload
  ) IS DISTINCT FROM ROW(
    OLD.strategy_id,OLD.strategy_version,OLD.quote_mint,OLD.target_closed_positions,
    OLD.initial_capital_raw,OLD.network_fee_raw_per_transaction,OLD.max_duration_ms,
    OLD.external_unique_buyers_target,OLD.take_profit_multiplier_bps,
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
