-- Durable, append-only ledger of closed live positions. execution_live_positions and the
-- reconciliation evidence are purged four hours after close; this table is written once by
-- the recovery runtime in the transaction that closes the position and is never purged.
-- position_id deliberately has no foreign key: the position row it describes is purged.
CREATE TABLE IF NOT EXISTS execution_live_position_ledger (
  position_id TEXT PRIMARY KEY,
  wallet_public_key TEXT NOT NULL,
  mint TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ NOT NULL,
  base_amount_raw NUMERIC NOT NULL,
  entry_wallet_lamport_delta NUMERIC NOT NULL,
  exit_wallet_lamport_delta NUMERIC NOT NULL,
  net_lamports NUMERIC NOT NULL,
  entry_signature TEXT NOT NULL,
  exit_signature TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp()),
  CONSTRAINT execution_live_position_ledger_identity_check CHECK (
    position_id ~ '^execution_live_position_[0-9a-f]{64}$'
    AND wallet_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND entry_signature ~ '^[1-9A-HJ-NP-Za-km-z]{32,128}$'
    AND exit_signature ~ '^[1-9A-HJ-NP-Za-km-z]{32,128}$'
  ),
  CONSTRAINT execution_live_position_ledger_amounts_check CHECK (
    base_amount_raw <> 'NaN'::NUMERIC AND base_amount_raw > 0
    AND base_amount_raw = trunc(base_amount_raw) AND scale(base_amount_raw) = 0
    AND entry_wallet_lamport_delta <> 'NaN'::NUMERIC
    AND entry_wallet_lamport_delta = trunc(entry_wallet_lamport_delta)
    AND scale(entry_wallet_lamport_delta) = 0
    AND exit_wallet_lamport_delta <> 'NaN'::NUMERIC
    AND exit_wallet_lamport_delta = trunc(exit_wallet_lamport_delta)
    AND scale(exit_wallet_lamport_delta) = 0
    AND net_lamports = entry_wallet_lamport_delta + exit_wallet_lamport_delta
  ),
  CONSTRAINT execution_live_position_ledger_temporal_check CHECK (
    isfinite(opened_at) AND isfinite(closed_at) AND closed_at >= opened_at
    AND date_trunc('milliseconds', closed_at) = closed_at
  )
);

CREATE INDEX IF NOT EXISTS execution_live_position_ledger_wallet_closed_idx
  ON execution_live_position_ledger (wallet_public_key, closed_at DESC, position_id DESC);

DROP TRIGGER IF EXISTS execution_live_position_ledger_immutable
  ON execution_live_position_ledger;
CREATE TRIGGER execution_live_position_ledger_immutable
  BEFORE UPDATE OR DELETE ON execution_live_position_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_execution_live_immutable_update();
