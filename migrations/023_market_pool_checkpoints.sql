CREATE TABLE IF NOT EXISTS market_pool_checkpoints (
  pool_address TEXT PRIMARY KEY REFERENCES market_pools(pool_address) ON DELETE CASCADE,
  slot NUMERIC(78,0) NOT NULL CHECK (slot >= 0),
  signature TEXT NOT NULL CHECK (length(signature) BETWEEN 1 AND 128),
  source TEXT NOT NULL CHECK (
    source IN ('pool-activation', 'rolling-catch-up', 'operator-approved-pool-frontier-seed')
  ),
  previous JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL
);
