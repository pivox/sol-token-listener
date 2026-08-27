-- Coverage is recomputed at every authoritative collection. Historical terminal
-- runs predate this evidence, so their additive zero backfill is explicit and
-- must not be interpreted as an observed count.
ALTER TABLE paper_mvp_runs
  ADD COLUMN IF NOT EXISTS opened_positions INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS open_positions INTEGER NOT NULL DEFAULT 0;

ALTER TABLE paper_mvp_runs
  DROP CONSTRAINT IF EXISTS paper_mvp_runs_position_coverage_check;
ALTER TABLE paper_mvp_runs
  ADD CONSTRAINT paper_mvp_runs_position_coverage_check CHECK (
    opened_positions BETWEEN 0 AND 1000000
    AND open_positions BETWEEN 0 AND opened_positions
  );

CREATE INDEX IF NOT EXISTS paper_positions_mvp_open_coverage_idx
  ON paper_positions (strategy_id, strategy_version, opened_at, status, position_id);
