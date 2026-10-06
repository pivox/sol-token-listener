ALTER TABLE live_position_market_routes
  ADD COLUMN IF NOT EXISTS resolution_source TEXT CHECK (resolution_source IN ('LOCAL_INDEX','RPC_CANONICAL_PDA')),
  ADD COLUMN IF NOT EXISTS resolution_slot NUMERIC(20,0) CHECK (resolution_slot IS NULL OR resolution_slot >= 0),
  ADD COLUMN IF NOT EXISTS resolution_at_ms BIGINT CHECK (resolution_at_ms IS NULL OR resolution_at_ms >= 0),
  ADD COLUMN IF NOT EXISTS resolution_evidence JSONB;
