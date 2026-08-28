CREATE TABLE IF NOT EXISTS chain_transaction_finality_replay_receipts (
  signature TEXT PRIMARY KEY,
  observed_slot NUMERIC(78,0) NOT NULL CHECK (observed_slot >= 0),
  confirmation_status TEXT NOT NULL CHECK (confirmation_status = 'finalized'),
  finality_evidence_version BIGINT NOT NULL CHECK (finality_evidence_version >= 0),
  immutable_fingerprint TEXT NOT NULL CHECK (
    immutable_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  replay_completed_at TIMESTAMPTZ NOT NULL
);

INSERT INTO chain_transaction_finality_replay_receipts (
  signature,observed_slot,confirmation_status,finality_evidence_version,
  immutable_fingerprint,replay_completed_at
)
SELECT inbox.signature,inbox.observed_slot,inbox.target_confirmation_status,
  inbox.finality_evidence_version,inbox.immutable_fingerprint,inbox.processed_at
FROM chain_transaction_inbox inbox
WHERE inbox.processing_status='PROCESSED'
  AND inbox.target_confirmation_status='finalized'
  AND inbox.normalized_transaction IS NOT NULL
  AND inbox.immutable_fingerprint IS NOT NULL
  AND inbox.processed_at IS NOT NULL
ON CONFLICT (signature) DO NOTHING;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM chain_transaction_inbox inbox
    WHERE inbox.processing_status='PROCESSED'
      AND inbox.target_confirmation_status='finalized'
      AND inbox.normalized_transaction IS NOT NULL
      AND inbox.immutable_fingerprint IS NOT NULL
      AND inbox.processed_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM chain_transaction_finality_replay_receipts receipt
        WHERE receipt.signature=inbox.signature
          AND receipt.observed_slot=inbox.observed_slot
          AND receipt.confirmation_status=inbox.target_confirmation_status
          AND receipt.finality_evidence_version=inbox.finality_evidence_version
          AND receipt.immutable_fingerprint=inbox.immutable_fingerprint
          AND receipt.replay_completed_at=inbox.processed_at
      )
  ) THEN
    RAISE EXCEPTION 'finalized replay receipt conflicts with processed inbox';
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS raw_chain_events_paper_finality_cursor_idx
  ON raw_chain_events (
    mint,
    slot,
    transaction_index,
    instruction_index,
    (COALESCE(inner_instruction_index, -1)),
    event_id
  )
  INCLUDE (signature, confirmation_status)
  WHERE confirmation_status <> 'orphaned';
