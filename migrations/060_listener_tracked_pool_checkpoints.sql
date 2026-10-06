CREATE TABLE IF NOT EXISTS listener_tracked_pool_checkpoints (
  pool_address TEXT PRIMARY KEY REFERENCES market_pools(pool_address) ON DELETE CASCADE,
  slot NUMERIC(78,0) NOT NULL CHECK (slot >= 0),
  signature TEXT NOT NULL CHECK (LENGTH(signature) BETWEEN 1 AND 128),
  updated_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE chain_transaction_inbox
  DROP CONSTRAINT chain_transaction_inbox_ingestion_hint_check,
  ADD CONSTRAINT chain_transaction_inbox_ingestion_hint_check CHECK (
    (ingestion_hint IN ('NONE', 'PUMPFUN_CREATE') AND ingestion_hint_mint IS NULL)
    OR (ingestion_hint IN ('PUMPFUN_TRADE', 'PUMPSWAP_POOL_TRADE') AND ingestion_hint_mint IS NOT NULL
      AND ingestion_hint_mint = BTRIM(ingestion_hint_mint)
      AND OCTET_LENGTH(ingestion_hint_mint) BETWEEN 32 AND 44
      AND ingestion_hint_mint COLLATE "C" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  );
