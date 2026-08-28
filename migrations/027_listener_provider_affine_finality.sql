ALTER TABLE chain_transaction_inbox
  ADD COLUMN IF NOT EXISTS last_missing_finality_provider_id TEXT,
  ADD COLUMN IF NOT EXISTS finality_evidence_version BIGINT NOT NULL DEFAULT 0;

UPDATE chain_transaction_inbox
SET missing_finality_polls = 0,
    last_missing_finality_provider_id = NULL
WHERE missing_finality_polls > 0
  AND last_missing_finality_provider_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chain_transaction_inbox_missing_finality_provider_check'
      AND conrelid = 'chain_transaction_inbox'::regclass
  ) THEN
    ALTER TABLE chain_transaction_inbox
      ADD CONSTRAINT chain_transaction_inbox_missing_finality_provider_check
      CHECK (
        (missing_finality_polls = 0
          AND last_missing_finality_provider_id IS NULL)
        OR
        (missing_finality_polls > 0
          AND last_missing_finality_provider_id IS NOT NULL
          AND last_missing_finality_provider_id IN (
            'primary', 'fallback-1', 'fallback-2', 'fallback-3'
          ))
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chain_transaction_inbox_finality_evidence_version_check'
      AND conrelid = 'chain_transaction_inbox'::regclass
  ) THEN
    ALTER TABLE chain_transaction_inbox
      ADD CONSTRAINT chain_transaction_inbox_finality_evidence_version_check
      CHECK (finality_evidence_version >= 0);
  END IF;
END;
$$;

DROP INDEX IF EXISTS chain_transaction_inbox_finality_idx;
CREATE INDEX chain_transaction_inbox_finality_idx
  ON chain_transaction_inbox (updated_at, observed_slot, signature)
  WHERE processing_status = 'PROCESSED'
    AND target_confirmation_status IN ('processed', 'confirmed');
