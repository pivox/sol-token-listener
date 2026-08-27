-- Two accepted NUMERIC(78,0) network fees can produce a signed 79-digit
-- per-position model PnL. Keep source amounts at the closed 78-digit boundary
-- while widening only that deterministic derived projection.
ALTER TABLE paper_mvp_position_samples
  ALTER COLUMN model_net_pnl_raw TYPE NUMERIC(79,0);
