CREATE INDEX IF NOT EXISTS token_launches_paper_mvp_coverage_idx
  ON token_launches (detected_at, mint);

CREATE INDEX IF NOT EXISTS trading_candidates_paper_mvp_coverage_idx
  ON trading_candidates (strategy_id, strategy_version, created_at, mint);
