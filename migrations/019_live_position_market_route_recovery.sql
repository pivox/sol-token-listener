ALTER TABLE live_position_market_routes
  ADD COLUMN IF NOT EXISTS retry_generation INTEGER NOT NULL DEFAULT 0 CHECK (retry_generation >= 0),
  ADD COLUMN IF NOT EXISTS retry_budget INTEGER NOT NULL DEFAULT 5 CHECK (retry_budget BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS retry_history JSONB NOT NULL DEFAULT '[]'::jsonb;
