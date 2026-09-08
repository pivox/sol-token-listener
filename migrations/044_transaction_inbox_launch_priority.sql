DO $$
BEGIN
  CREATE TYPE chain_transaction_inbox_priority AS ENUM ('NORMAL', 'LAUNCH_CANDIDATE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
DECLARE
  labels TEXT[];
BEGIN
  SELECT ARRAY_AGG(enum_value.enumlabel ORDER BY enum_value.enumsortorder)
  INTO labels
  FROM pg_enum enum_value
  JOIN pg_type enum_type ON enum_type.oid = enum_value.enumtypid
  JOIN pg_namespace namespace ON namespace.oid = enum_type.typnamespace
  WHERE namespace.nspname = CURRENT_SCHEMA()
    AND enum_type.typname = 'chain_transaction_inbox_priority';

  IF labels IS DISTINCT FROM ARRAY['NORMAL', 'LAUNCH_CANDIDATE']::TEXT[] THEN
    RAISE EXCEPTION 'chain_transaction_inbox_priority enum definition is incompatible';
  END IF;
END;
$$;

ALTER TABLE chain_transaction_inbox
  ADD COLUMN IF NOT EXISTS ingestion_priority chain_transaction_inbox_priority
    NOT NULL DEFAULT 'NORMAL';

DO $$
DECLARE
  priority_type TEXT;
BEGIN
  SELECT attribute.atttypid::REGTYPE::TEXT
  INTO priority_type
  FROM pg_attribute attribute
  WHERE attribute.attrelid = 'chain_transaction_inbox'::REGCLASS
    AND attribute.attname = 'ingestion_priority'
    AND NOT attribute.attisdropped;

  IF priority_type IS DISTINCT FROM 'chain_transaction_inbox_priority' THEN
    RAISE EXCEPTION 'chain_transaction_inbox.ingestion_priority type is incompatible';
  END IF;
END;
$$;

UPDATE chain_transaction_inbox
SET ingestion_priority = 'NORMAL'
WHERE ingestion_priority IS NULL;

ALTER TABLE chain_transaction_inbox
  ALTER COLUMN ingestion_priority SET DEFAULT 'NORMAL',
  ALTER COLUMN ingestion_priority SET NOT NULL;

CREATE TABLE IF NOT EXISTS chain_transaction_inbox_claim_scheduler (
  scheduler_key TEXT PRIMARY KEY,
  consecutive_launch_candidate_claims SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chain_transaction_inbox_claim_scheduler_key_check CHECK (
    scheduler_key = 'global'
  ),
  CONSTRAINT chain_transaction_inbox_claim_scheduler_streak_check CHECK (
    consecutive_launch_candidate_claims BETWEEN 0 AND 32
  ),
  CONSTRAINT chain_transaction_inbox_claim_scheduler_timestamps_check CHECK (
    updated_at >= created_at
  )
);

INSERT INTO chain_transaction_inbox_claim_scheduler (
  scheduler_key,
  consecutive_launch_candidate_claims
) VALUES ('global', 0)
ON CONFLICT (scheduler_key) DO NOTHING;

DROP INDEX IF EXISTS chain_transaction_inbox_claim_order_idx;
CREATE INDEX chain_transaction_inbox_claim_order_idx
  ON chain_transaction_inbox (ingestion_priority DESC, observed_slot, signature)
  WHERE processing_status = 'PENDING'
     OR processing_status = 'PROCESSING'
     OR (
       processing_status = 'FAILED'
       AND error_retryable = TRUE
       AND retry_exhausted_at IS NULL
     );
