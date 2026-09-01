CREATE INDEX IF NOT EXISTS execution_intents_live_claim_idx
  ON execution_intents (side, requested_at, id)
  WHERE status IN ('PENDING', 'RETRY_READY', 'PROCESSING');
