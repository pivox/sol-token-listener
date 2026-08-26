ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS entry_decision_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS entry_decision_job_id TEXT,
  ADD COLUMN IF NOT EXISTS close_event_id TEXT REFERENCES domain_events(event_id),
  ADD COLUMN IF NOT EXISTS exit_trigger_at TIMESTAMPTZ;

ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS quote_observed_at TIMESTAMPTZ;

ALTER TABLE paper_positions
  DROP CONSTRAINT IF EXISTS paper_positions_mvp_source_times_check;
ALTER TABLE paper_positions
  ADD CONSTRAINT paper_positions_mvp_source_times_check CHECK (
    (entry_decision_at IS NULL) = (entry_decision_job_id IS NULL)
    AND (entry_decision_job_id IS NULL
      OR OCTET_LENGTH(entry_decision_job_id) BETWEEN 1 AND 256)
  );
CREATE UNIQUE INDEX IF NOT EXISTS paper_positions_close_event_idx
  ON paper_positions (close_event_id) WHERE close_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS paper_positions_mvp_collect_idx
  ON paper_positions (strategy_id,strategy_version,opened_at,closed_at,position_id)
  WHERE status IN ('PAPER_CLOSED','PAPER_RETRACTED');

-- Historical rows remain NULL: migration 018 cannot reconstruct these exact
-- application observation times without inventing evidence.
CREATE TABLE IF NOT EXISTS paper_mvp_runs (
  run_id TEXT PRIMARY KEY CHECK (OCTET_LENGTH(run_id) BETWEEN 1 AND 256),
  strategy_id TEXT NOT NULL CHECK (OCTET_LENGTH(strategy_id) BETWEEN 1 AND 256),
  strategy_version INTEGER NOT NULL CHECK (strategy_version > 0),
  quote_mint TEXT NOT NULL CHECK (OCTET_LENGTH(quote_mint) BETWEEN 1 AND 256),
  target_closed_positions INTEGER NOT NULL CHECK (target_closed_positions BETWEEN 1 AND 1000),
  initial_capital_raw NUMERIC(78,0) NOT NULL CHECK (initial_capital_raw > 0),
  network_fee_raw_per_transaction NUMERIC(78,0) NOT NULL CHECK (network_fee_raw_per_transaction >= 0),
  max_duration_ms INTEGER NOT NULL CHECK (max_duration_ms BETWEEN 60000 AND 14400000),
  provider_identity TEXT NOT NULL CHECK (OCTET_LENGTH(provider_identity) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK (state IN ('RUNNING','COMPLETED','FAILED')),
  creations_observed INTEGER NOT NULL DEFAULT 0 CHECK (creations_observed BETWEEN 0 AND 1000000),
  entries_rejected INTEGER NOT NULL DEFAULT 0 CHECK (entries_rejected BETWEEN 0 AND 1000000),
  unknown_terminal_positions INTEGER NOT NULL DEFAULT 0 CHECK (unknown_terminal_positions BETWEEN 0 AND 1000000),
  duplicate_logical_buys INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_logical_buys BETWEEN 0 AND 1000000),
  duplicate_logical_sells INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_logical_sells BETWEEN 0 AND 1000000),
  provider_status TEXT NOT NULL DEFAULT 'UNAVAILABLE' CHECK (provider_status IN ('AVAILABLE','UNAVAILABLE')),
  provider_credits_used_start NUMERIC(78,0),
  provider_credits_used_end NUMERIC(78,0),
  provider_rate_limited_count INTEGER NOT NULL DEFAULT 0 CHECK (provider_rate_limited_count BETWEEN 0 AND 1000000),
  started_at TIMESTAMPTZ NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('PASS','FAIL')),
  failure_code TEXT CHECK (failure_code IS NULL OR OCTET_LENGTH(failure_code) BETWEEN 1 AND 256),
  payload_version INTEGER NOT NULL CHECK (payload_version = 1),
  configuration_payload JSONB NOT NULL CHECK (jsonb_typeof(configuration_payload) = 'object'),
  report_payload JSONB CHECK (report_payload IS NULL OR jsonb_typeof(report_payload) = 'object'),
  CHECK (deadline_at = started_at + max_duration_ms * INTERVAL '1 millisecond'),
  CHECK (
    (provider_status = 'UNAVAILABLE'
      AND provider_credits_used_start IS NULL AND provider_credits_used_end IS NULL)
    OR (provider_status = 'AVAILABLE'
      AND provider_credits_used_start >= 0
      AND provider_credits_used_end >= provider_credits_used_start)
  ),
  CHECK (
    (state = 'RUNNING' AND terminal_at IS NULL AND purge_after IS NULL
      AND verdict IS NULL AND failure_code IS NULL AND report_payload IS NULL)
    OR (state = 'COMPLETED' AND terminal_at IS NOT NULL AND purge_after IS NOT NULL
      AND verdict IS NOT NULL AND failure_code IS NULL AND report_payload IS NOT NULL)
    OR (state = 'FAILED' AND terminal_at IS NOT NULL AND purge_after IS NOT NULL
      AND verdict IS NULL AND failure_code IS NOT NULL AND report_payload IS NULL)
  ),
  CHECK ((terminal_at IS NULL AND purge_after IS NULL)
    OR purge_after = terminal_at + INTERVAL '4 hours')
);

CREATE UNIQUE INDEX IF NOT EXISTS paper_mvp_runs_one_active_idx
  ON paper_mvp_runs ((TRUE)) WHERE state = 'RUNNING';
CREATE INDEX IF NOT EXISTS paper_mvp_runs_purge_idx
  ON paper_mvp_runs (purge_after, run_id) WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS paper_mvp_position_samples (
  run_id TEXT NOT NULL REFERENCES paper_mvp_runs(run_id) ON DELETE CASCADE,
  position_id TEXT NOT NULL CHECK (OCTET_LENGTH(position_id) BETWEEN 1 AND 512),
  sample_status TEXT NOT NULL CHECK (sample_status IN ('VALID','UNKNOWN')),
  unknown_reason TEXT CHECK (unknown_reason IS NULL OR unknown_reason IN (
    'MISSING_CREATION_DETECTED_AT','MISSING_ENTRY_DECISION_AT','MISSING_ENTRY_QUOTE_AT',
    'MISSING_PAPER_BUY_AT','MISSING_EXIT_TRIGGER_AT','MISSING_EXIT_QUOTE_AT',
    'MISSING_PAPER_SELL_AT','INVALID_TIMESTAMP_ORDER','MISSING_BUY_TRADE',
    'MISSING_SELL_TRADE','UNSUPPORTED_EXIT_REASON','SOURCE_CONTRADICTION',
    'POSITION_RETRACTED'
  )),
  mint TEXT CHECK (mint IS NULL OR OCTET_LENGTH(mint) BETWEEN 1 AND 512),
  quote_mint TEXT CHECK (quote_mint IS NULL OR OCTET_LENGTH(quote_mint) BETWEEN 1 AND 512),
  exit_reason TEXT CHECK (exit_reason IS NULL OR exit_reason IN (
    'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED','TAKE_PROFIT_2X_EXECUTABLE',
    'CREATOR_EARLY_SELL','MANUAL_KILL_SWITCH'
  )),
  creation_detected_at TIMESTAMPTZ,
  entry_decision_at TIMESTAMPTZ,
  entry_quote_at TIMESTAMPTZ,
  paper_buy_at TIMESTAMPTZ,
  exit_trigger_at TIMESTAMPTZ,
  exit_quote_at TIMESTAMPTZ,
  paper_sell_at TIMESTAMPTZ,
  buy_amount_in_raw NUMERIC(78,0),
  buy_amount_out_raw NUMERIC(78,0),
  buy_minimum_amount_out_raw NUMERIC(78,0),
  buy_fees_raw NUMERIC(78,0),
  buy_slippage_bps NUMERIC(78,0),
  buy_price_impact_bps NUMERIC(78,0),
  sell_amount_in_raw NUMERIC(78,0),
  sell_amount_out_raw NUMERIC(78,0),
  sell_minimum_amount_out_raw NUMERIC(78,0),
  sell_fees_raw NUMERIC(78,0),
  sell_slippage_bps NUMERIC(78,0),
  sell_price_impact_bps NUMERIC(78,0),
  network_fee_raw_per_transaction NUMERIC(78,0),
  gross_pnl_raw NUMERIC(78,0),
  model_net_pnl_raw NUMERIC(78,0),
  detection_to_entry_latency_ms INTEGER CHECK (detection_to_entry_latency_ms >= 0),
  exit_trigger_to_sell_latency_ms INTEGER CHECK (exit_trigger_to_sell_latency_ms >= 0),
  payload_version INTEGER NOT NULL CHECK (payload_version = 1),
  sample_payload JSONB NOT NULL CHECK (jsonb_typeof(sample_payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, position_id),
  CHECK (
    (sample_status = 'UNKNOWN' AND unknown_reason IS NOT NULL
      AND mint IS NULL AND quote_mint IS NULL AND exit_reason IS NULL
      AND creation_detected_at IS NULL AND entry_decision_at IS NULL
      AND entry_quote_at IS NULL AND paper_buy_at IS NULL
      AND exit_trigger_at IS NULL AND exit_quote_at IS NULL AND paper_sell_at IS NULL
      AND buy_amount_in_raw IS NULL AND buy_amount_out_raw IS NULL
      AND buy_minimum_amount_out_raw IS NULL AND buy_fees_raw IS NULL
      AND buy_slippage_bps IS NULL AND buy_price_impact_bps IS NULL
      AND sell_amount_in_raw IS NULL AND sell_amount_out_raw IS NULL
      AND sell_minimum_amount_out_raw IS NULL AND sell_fees_raw IS NULL
      AND sell_slippage_bps IS NULL AND sell_price_impact_bps IS NULL
      AND network_fee_raw_per_transaction IS NULL AND gross_pnl_raw IS NULL
      AND model_net_pnl_raw IS NULL AND detection_to_entry_latency_ms IS NULL
      AND exit_trigger_to_sell_latency_ms IS NULL
      AND sample_payload->>'schemaVersion' = 'paper-mvp-unknown-position.v1')
    OR
    (sample_status = 'VALID' AND unknown_reason IS NULL
      AND mint IS NOT NULL AND quote_mint IS NOT NULL AND exit_reason IS NOT NULL
      AND creation_detected_at IS NOT NULL AND entry_decision_at IS NOT NULL
      AND entry_quote_at IS NOT NULL AND paper_buy_at IS NOT NULL
      AND exit_trigger_at IS NOT NULL AND exit_quote_at IS NOT NULL AND paper_sell_at IS NOT NULL
      AND buy_amount_in_raw IS NOT NULL AND buy_amount_out_raw IS NOT NULL
      AND buy_minimum_amount_out_raw IS NOT NULL AND buy_fees_raw IS NOT NULL
      AND buy_slippage_bps IS NOT NULL AND buy_price_impact_bps IS NOT NULL
      AND sell_amount_in_raw IS NOT NULL AND sell_amount_out_raw IS NOT NULL
      AND sell_minimum_amount_out_raw IS NOT NULL AND sell_fees_raw IS NOT NULL
      AND sell_slippage_bps IS NOT NULL AND sell_price_impact_bps IS NOT NULL
      AND network_fee_raw_per_transaction IS NOT NULL AND gross_pnl_raw IS NOT NULL
      AND model_net_pnl_raw IS NOT NULL AND detection_to_entry_latency_ms IS NOT NULL
      AND exit_trigger_to_sell_latency_ms IS NOT NULL AND sample_payload IS NOT NULL
      AND sample_payload->>'schemaVersion' = 'paper-mvp-position-sample.v1'
      AND creation_detected_at <= entry_decision_at
      AND entry_decision_at <= entry_quote_at AND entry_quote_at <= paper_buy_at
      AND paper_buy_at <= exit_trigger_at AND exit_trigger_at <= exit_quote_at
      AND exit_quote_at <= paper_sell_at)
  )
);

CREATE INDEX IF NOT EXISTS paper_mvp_position_samples_sell_idx
  ON paper_mvp_position_samples (run_id, paper_sell_at, position_id);

CREATE OR REPLACE FUNCTION prevent_paper_mvp_sample_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'paper MVP samples are immutable';
END
$$;
DROP TRIGGER IF EXISTS paper_mvp_position_samples_immutable_trigger
  ON paper_mvp_position_samples;
CREATE TRIGGER paper_mvp_position_samples_immutable_trigger
  BEFORE UPDATE ON paper_mvp_position_samples
  FOR EACH ROW EXECUTE FUNCTION prevent_paper_mvp_sample_mutation();

CREATE OR REPLACE FUNCTION prevent_paper_mvp_run_immutable_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('COMPLETED','FAILED') THEN
    RAISE EXCEPTION 'paper MVP terminal run is immutable';
  END IF;
  IF ROW(
    NEW.strategy_id,NEW.strategy_version,NEW.quote_mint,NEW.target_closed_positions,
    NEW.initial_capital_raw,NEW.network_fee_raw_per_transaction,NEW.max_duration_ms,
    NEW.provider_identity,NEW.started_at,NEW.deadline_at,NEW.payload_version,
    NEW.configuration_payload
  ) IS DISTINCT FROM ROW(
    OLD.strategy_id,OLD.strategy_version,OLD.quote_mint,OLD.target_closed_positions,
    OLD.initial_capital_raw,OLD.network_fee_raw_per_transaction,OLD.max_duration_ms,
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
DROP TRIGGER IF EXISTS paper_mvp_runs_immutable_trigger ON paper_mvp_runs;
CREATE TRIGGER paper_mvp_runs_immutable_trigger
  BEFORE UPDATE ON paper_mvp_runs
  FOR EACH ROW EXECUTE FUNCTION prevent_paper_mvp_run_immutable_mutation();
