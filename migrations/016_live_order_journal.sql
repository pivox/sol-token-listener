CREATE TABLE IF NOT EXISTS live_orders (
  order_id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  position_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  status TEXT NOT NULL CHECK (status IN ('PREPARED','SIGNED','SUBMITTED','CONFIRMED','FAILED','EXPIRED','UNKNOWN')),
  signature TEXT UNIQUE,
  signed_transaction BYTEA,
  intent JSONB NOT NULL,
  validity JSONB NOT NULL,
  transaction_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK ((status = 'PREPARED' AND signature IS NULL AND signed_transaction IS NULL)
    OR (status <> 'PREPARED' AND signature IS NOT NULL AND signed_transaction IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS live_orders_unresolved_wallet_idx
  ON live_orders(wallet, created_at, order_id)
  WHERE status IN ('PREPARED','SIGNED','SUBMITTED','UNKNOWN');

CREATE INDEX IF NOT EXISTS live_orders_position_idx
  ON live_orders(wallet, position_id, created_at, order_id);
