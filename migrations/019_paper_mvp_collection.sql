ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS entry_decision_job_id TEXT;

ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS quote_observed_at TIMESTAMPTZ;

ALTER TABLE paper_positions
  DROP CONSTRAINT IF EXISTS paper_positions_mvp_source_times_check;
ALTER TABLE paper_positions
  ADD CONSTRAINT paper_positions_mvp_source_times_check CHECK (
    (entry_decision_job_id IS NULL OR entry_decision_at IS NOT NULL)
    AND (entry_decision_job_id IS NULL
      OR OCTET_LENGTH(entry_decision_job_id) BETWEEN 1 AND 256)
    AND (entry_decision_at IS NULL OR entry_decision_at <= opened_at)
    AND (exit_trigger_at IS NULL OR closed_at IS NULL OR exit_trigger_at <= closed_at)
  );

CREATE INDEX IF NOT EXISTS paper_positions_mvp_collect_idx
  ON paper_positions (strategy_id,strategy_version,opened_at,closed_at,position_id)
  WHERE status IN ('PAPER_CLOSED','PAPER_RETRACTED');

ALTER TABLE paper_mvp_position_samples
  DROP CONSTRAINT IF EXISTS paper_mvp_position_samples_unknown_reason_check;
ALTER TABLE paper_mvp_position_samples
  ADD CONSTRAINT paper_mvp_position_samples_unknown_reason_check CHECK (
    unknown_reason IS NULL OR unknown_reason IN (
      'MISSING_CREATION_DETECTED_AT','MISSING_ENTRY_DECISION_AT','MISSING_ENTRY_QUOTE_AT',
      'MISSING_PAPER_BUY_AT','MISSING_EXIT_TRIGGER_AT','MISSING_EXIT_QUOTE_AT',
      'MISSING_PAPER_SELL_AT','INVALID_TIMESTAMP_ORDER','MISSING_BUY_TRADE',
      'MISSING_SELL_TRADE','UNSUPPORTED_EXIT_REASON','SOURCE_CONTRADICTION',
      'POSITION_RETRACTED'
    )
  );

-- Exact source timestamps cannot be reconstructed for historical rows. They
-- intentionally remain NULL and will be classified UNKNOWN by the collector.
