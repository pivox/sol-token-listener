CREATE TABLE IF NOT EXISTS execution_live_positions (
  position_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  buy_intent_id TEXT NOT NULL UNIQUE,
  generation_id TEXT NOT NULL,
  armament_id TEXT NOT NULL,
  wallet_public_key TEXT NOT NULL,
  mint TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  entry_venue TEXT NOT NULL,
  quote_cost_raw NUMERIC NOT NULL,
  base_amount_raw NUMERIC NOT NULL,
  remaining_base_raw NUMERIC NOT NULL,
  fee_lamports NUMERIC NOT NULL,
  maximum_holding_ms INTEGER NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  exit_deadline_at TIMESTAMPTZ NOT NULL,
  entry_reconciliation_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  state_revision BIGINT NOT NULL DEFAULT 0,
  exit_intent_id TEXT,
  exit_reconciliation_fingerprint TEXT,
  closed_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  CONSTRAINT execution_live_positions_buy_intent_fkey
    FOREIGN KEY (buy_intent_id) REFERENCES execution_intents(id) ON DELETE RESTRICT,
  CONSTRAINT execution_live_positions_generation_fkey
    FOREIGN KEY (generation_id) REFERENCES execution_wallet_generations(generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_live_positions_armament_fkey
    FOREIGN KEY (armament_id) REFERENCES execution_activation_armaments(armament_id) ON DELETE RESTRICT,
  CONSTRAINT execution_live_positions_exit_intent_fkey
    FOREIGN KEY (exit_intent_id) REFERENCES execution_intents(id) ON DELETE RESTRICT,
  CONSTRAINT execution_live_positions_identity_check CHECK (
    payload_version=1
    AND position_id ~ '^execution_live_position_[0-9a-f]{64}$'
    AND buy_intent_id ~ '^execution_intent_[0-9a-f]{64}$'
    AND generation_id ~ '^execution_wallet_generation_[0-9a-f]{64}$'
    AND armament_id ~ '^execution_activation_armament_[0-9a-f]{64}$'
    AND wallet_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND quote_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND entry_venue='PUMP_FUN'
    AND entry_reconciliation_fingerprint ~ '^[0-9a-f]{64}$'
    AND (exit_intent_id IS NULL OR exit_intent_id ~ '^execution_intent_[0-9a-f]{64}$')
    AND (exit_reconciliation_fingerprint IS NULL
      OR exit_reconciliation_fingerprint ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT execution_live_positions_amounts_check CHECK (
    quote_cost_raw <> 'NaN'::NUMERIC AND quote_cost_raw > 0
    AND quote_cost_raw=trunc(quote_cost_raw) AND scale(quote_cost_raw)=0
    AND quote_cost_raw < 18446744073709551616
    AND base_amount_raw <> 'NaN'::NUMERIC AND base_amount_raw > 0
    AND base_amount_raw=trunc(base_amount_raw) AND scale(base_amount_raw)=0
    AND base_amount_raw < 18446744073709551616
    AND remaining_base_raw <> 'NaN'::NUMERIC AND remaining_base_raw >= 0
    AND remaining_base_raw=trunc(remaining_base_raw) AND scale(remaining_base_raw)=0
    AND remaining_base_raw <= base_amount_raw
    AND fee_lamports <> 'NaN'::NUMERIC AND fee_lamports >= 0
    AND fee_lamports=trunc(fee_lamports) AND scale(fee_lamports)=0
    AND fee_lamports < 18446744073709551616
  ),
  CONSTRAINT execution_live_positions_state_check CHECK (
    state IN ('OPEN','EXIT_PENDING','CLOSED','UNKNOWN') AND state_revision >= 0
    AND ((state IN ('OPEN','EXIT_PENDING','UNKNOWN') AND closed_at IS NULL AND purge_after IS NULL)
      OR (state='CLOSED' AND remaining_base_raw=0 AND closed_at IS NOT NULL
        AND exit_intent_id IS NOT NULL AND exit_reconciliation_fingerprint IS NOT NULL
        AND purge_after=closed_at + INTERVAL '4 hours'))
  ),
  CONSTRAINT execution_live_positions_temporal_check CHECK (
    maximum_holding_ms BETWEEN 30000 AND 900000
    AND isfinite(opened_at) AND isfinite(exit_deadline_at)
    AND date_trunc('milliseconds',opened_at)=opened_at
    AND date_trunc('milliseconds',exit_deadline_at)=exit_deadline_at
    AND exit_deadline_at=opened_at + maximum_holding_ms * INTERVAL '1 millisecond'
    AND (closed_at IS NULL OR (isfinite(closed_at)
      AND date_trunc('milliseconds',closed_at)=closed_at AND closed_at >= opened_at))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS execution_live_positions_one_active_per_generation
  ON execution_live_positions(generation_id) WHERE state IN ('OPEN','EXIT_PENDING','UNKNOWN');
CREATE INDEX IF NOT EXISTS execution_live_positions_deadline_idx
  ON execution_live_positions(exit_deadline_at,position_id) WHERE state='OPEN';

CREATE TABLE IF NOT EXISTS execution_exit_authorizations (
  authorization_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  position_id TEXT NOT NULL UNIQUE,
  generation_id TEXT NOT NULL,
  wallet_public_key TEXT NOT NULL,
  mint TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  maximum_base_amount_raw NUMERIC NOT NULL,
  state TEXT NOT NULL,
  state_revision BIGINT NOT NULL DEFAULT 0,
  locked_intent_id TEXT,
  locked_attempt_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  CONSTRAINT execution_exit_authorizations_position_fkey
    FOREIGN KEY (position_id) REFERENCES execution_live_positions(position_id) ON DELETE RESTRICT,
  CONSTRAINT execution_exit_authorizations_generation_fkey
    FOREIGN KEY (generation_id) REFERENCES execution_wallet_generations(generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_exit_authorizations_locked_attempt_fkey
    FOREIGN KEY (locked_intent_id,locked_attempt_number)
    REFERENCES execution_attempts(intent_id,attempt_number) ON DELETE RESTRICT,
  CONSTRAINT execution_exit_authorizations_identity_check CHECK (
    payload_version=1
    AND authorization_id ~ '^execution_exit_authorization_[0-9a-f]{64}$'
    AND position_id ~ '^execution_live_position_[0-9a-f]{64}$'
    AND generation_id ~ '^execution_wallet_generation_[0-9a-f]{64}$'
    AND wallet_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND quote_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  ),
  CONSTRAINT execution_exit_authorizations_amount_check CHECK (
    maximum_base_amount_raw <> 'NaN'::NUMERIC AND maximum_base_amount_raw > 0
    AND maximum_base_amount_raw=trunc(maximum_base_amount_raw)
    AND scale(maximum_base_amount_raw)=0
    AND maximum_base_amount_raw < 18446744073709551616
  ),
  CONSTRAINT execution_exit_authorizations_state_check CHECK (
    state IN ('ACTIVE','LOCKED','CONSUMED','REVOKED') AND state_revision >= 0
    AND ((state='ACTIVE' AND locked_intent_id IS NULL AND locked_attempt_number IS NULL
      AND terminal_at IS NULL AND purge_after IS NULL)
      OR (state='LOCKED' AND locked_intent_id IS NOT NULL AND locked_attempt_number IS NOT NULL
        AND terminal_at IS NULL AND purge_after IS NULL)
      OR (state IN ('CONSUMED','REVOKED') AND terminal_at IS NOT NULL
        AND purge_after=terminal_at + INTERVAL '4 hours'))
  ),
  CONSTRAINT execution_exit_authorizations_temporal_check CHECK (
    isfinite(created_at) AND date_trunc('milliseconds',created_at)=created_at
    AND (terminal_at IS NULL OR (isfinite(terminal_at)
      AND date_trunc('milliseconds',terminal_at)=terminal_at AND terminal_at >= created_at))
  )
);

CREATE TABLE IF NOT EXISTS execution_signed_transactions (
  artifact_id TEXT NOT NULL UNIQUE,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  specification_version SMALLINT NOT NULL,
  intent_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  generation_id TEXT NOT NULL,
  armament_id TEXT,
  exit_authorization_id TEXT,
  provider_id TEXT NOT NULL,
  wallet_public_key TEXT NOT NULL,
  side TEXT NOT NULL,
  effective_venue TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  build_fingerprint TEXT NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  quote_fingerprint TEXT NOT NULL,
  blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  signature TEXT NOT NULL UNIQUE,
  signed_transaction_bytes BYTEA NOT NULL,
  signed_transaction_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  state_revision BIGINT NOT NULL DEFAULT 0,
  signed_at TIMESTAMPTZ NOT NULL,
  signed_simulated_at TIMESTAMPTZ,
  submission_started_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  reconciled_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  PRIMARY KEY (intent_id, attempt_number),
  CONSTRAINT execution_signed_transactions_attempt_fkey
    FOREIGN KEY (intent_id, attempt_number)
    REFERENCES execution_attempts(intent_id, attempt_number) ON DELETE RESTRICT,
  CONSTRAINT execution_signed_transactions_generation_fkey
    FOREIGN KEY (generation_id) REFERENCES execution_wallet_generations(generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_signed_transactions_armament_fkey
    FOREIGN KEY (armament_id) REFERENCES execution_activation_armaments(armament_id) ON DELETE RESTRICT,
  CONSTRAINT execution_signed_transactions_exit_authorization_fkey
    FOREIGN KEY (exit_authorization_id)
    REFERENCES execution_exit_authorizations(authorization_id) ON DELETE RESTRICT,
  CONSTRAINT execution_signed_transactions_identity_check CHECK (
    payload_version=1 AND specification_version=1
    AND artifact_id ~ '^execution_signed_transaction_[0-9a-f]{64}$'
    AND intent_id ~ '^execution_intent_[0-9a-f]{64}$'
    AND attempt_number > 0
    AND generation_id ~ '^execution_wallet_generation_[0-9a-f]{64}$'
    AND (armament_id IS NULL OR armament_id ~ '^execution_activation_armament_[0-9a-f]{64}$')
    AND (exit_authorization_id IS NULL
      OR exit_authorization_id ~ '^execution_exit_authorization_[0-9a-f]{64}$')
    AND octet_length(provider_id) BETWEEN 1 AND 64
    AND provider_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    AND wallet_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND side IN ('BUY','SELL') AND effective_venue IN ('PUMP_FUN','PUMP_SWAP')
    AND ((side='BUY' AND effective_venue='PUMP_FUN'
      AND armament_id IS NOT NULL AND exit_authorization_id IS NULL)
      OR (side='SELL' AND armament_id IS NULL AND exit_authorization_id IS NOT NULL))
  ),
  CONSTRAINT execution_signed_transactions_crypto_check CHECK (
    message_hash ~ '^[0-9a-f]{64}$'
    AND build_fingerprint ~ '^[0-9a-f]{64}$'
    AND snapshot_fingerprint ~ '^[0-9a-f]{64}$'
    AND quote_fingerprint ~ '^[0-9a-f]{64}$'
    AND blockhash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND last_valid_block_height >= 0
    AND signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,128}$'
    AND octet_length(signed_transaction_bytes) BETWEEN 1 AND 1232
    AND signed_transaction_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT execution_signed_transactions_state_check CHECK (
    state IN ('PERSISTED','SIGNED_SIMULATED','SUBMISSION_STARTED','ACCEPTED','AMBIGUOUS',
      'CONFIRMED','RECONCILED','REVOKED_NO_SEND') AND state_revision >= 0
    AND (state <> 'PERSISTED' OR (signed_simulated_at IS NULL AND submission_started_at IS NULL
      AND submitted_at IS NULL AND confirmed_at IS NULL AND reconciled_at IS NULL))
    AND (state NOT IN ('SIGNED_SIMULATED','SUBMISSION_STARTED','ACCEPTED','AMBIGUOUS','CONFIRMED','RECONCILED')
      OR signed_simulated_at IS NOT NULL)
    AND (state NOT IN ('SUBMISSION_STARTED','ACCEPTED','AMBIGUOUS','CONFIRMED','RECONCILED')
      OR submission_started_at IS NOT NULL)
    AND (state NOT IN ('ACCEPTED','CONFIRMED','RECONCILED') OR submitted_at IS NOT NULL)
    AND (state NOT IN ('CONFIRMED','RECONCILED') OR confirmed_at IS NOT NULL)
    AND (state <> 'RECONCILED' OR reconciled_at IS NOT NULL)
    AND ((state IN ('RECONCILED','REVOKED_NO_SEND')
      AND purge_after=COALESCE(reconciled_at,signed_simulated_at,signed_at) + INTERVAL '4 hours')
      OR (state NOT IN ('RECONCILED','REVOKED_NO_SEND') AND purge_after IS NULL))
  ),
  CONSTRAINT execution_signed_transactions_temporal_check CHECK (
    isfinite(signed_at) AND date_trunc('milliseconds',signed_at)=signed_at
    AND (signed_simulated_at IS NULL OR (isfinite(signed_simulated_at)
      AND date_trunc('milliseconds',signed_simulated_at)=signed_simulated_at
      AND signed_simulated_at >= signed_at))
    AND (submission_started_at IS NULL OR (isfinite(submission_started_at)
      AND date_trunc('milliseconds',submission_started_at)=submission_started_at
      AND submission_started_at >= signed_at))
    AND (submitted_at IS NULL OR (isfinite(submitted_at)
      AND date_trunc('milliseconds',submitted_at)=submitted_at
      AND submitted_at >= submission_started_at))
    AND (confirmed_at IS NULL OR (isfinite(confirmed_at)
      AND date_trunc('milliseconds',confirmed_at)=confirmed_at
      AND confirmed_at >= submitted_at))
    AND (reconciled_at IS NULL OR (isfinite(reconciled_at)
      AND date_trunc('milliseconds',reconciled_at)=reconciled_at
      AND reconciled_at >= COALESCE(confirmed_at,submission_started_at,signed_at)))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS execution_signed_transactions_one_active_intent
  ON execution_signed_transactions(intent_id)
  WHERE state NOT IN ('RECONCILED','REVOKED_NO_SEND');

CREATE TABLE IF NOT EXISTS execution_submission_events (
  event_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  event_fingerprint TEXT NOT NULL UNIQUE,
  artifact_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  previous_state TEXT,
  next_state TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT execution_submission_events_artifact_fkey
    FOREIGN KEY (artifact_id) REFERENCES execution_signed_transactions(artifact_id) ON DELETE RESTRICT,
  CONSTRAINT execution_submission_events_generation_fkey
    FOREIGN KEY (generation_id) REFERENCES execution_wallet_generations(generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_submission_events_identity_check CHECK (
    payload_version=1
    AND event_id ~ '^execution_submission_event_[0-9a-f]{64}$'
    AND event_fingerprint ~ '^[0-9a-f]{64}$'
    AND (previous_state IS NULL OR previous_state IN ('PERSISTED','SIGNED_SIMULATED',
      'SUBMISSION_STARTED','ACCEPTED','AMBIGUOUS','CONFIRMED','RECONCILED','REVOKED_NO_SEND'))
    AND next_state IN ('PERSISTED','SIGNED_SIMULATED','SUBMISSION_STARTED','ACCEPTED',
      'AMBIGUOUS','CONFIRMED','RECONCILED','REVOKED_NO_SEND')
    AND reason_code IN ('SIGNATURE_PERSISTED','SIGNED_SIMULATION_FAILED','SUBMISSION_STARTED',
      'SUBMISSION_ACCEPTED','SUBMISSION_AMBIGUOUS','SUBMISSION_SIGNATURE_MISMATCH',
      'CONFIRMATION_OBSERVED','RECONCILIATION_REQUIRED','INTENT_SUCCEEDED')
  ),
  CONSTRAINT execution_submission_events_temporal_check CHECK (
    isfinite(occurred_at) AND date_trunc('milliseconds',occurred_at)=occurred_at
  )
);

CREATE INDEX IF NOT EXISTS execution_submission_events_artifact_occurred_idx
  ON execution_submission_events(artifact_id,occurred_at,event_id);

CREATE OR REPLACE FUNCTION reject_execution_live_immutable_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'execution live payload is immutable' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS execution_submission_events_immutable ON execution_submission_events;
CREATE TRIGGER execution_submission_events_immutable
  BEFORE UPDATE ON execution_submission_events
  FOR EACH ROW EXECUTE FUNCTION reject_execution_live_immutable_update();

CREATE OR REPLACE FUNCTION guard_execution_signed_transaction_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  valid_binding BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.generation_id, 51005));
  SELECT EXISTS (
    SELECT 1
    FROM execution_attempts attempt
    JOIN execution_intents intent ON intent.id=attempt.intent_id
    JOIN execution_wallet_generations generation
      ON generation.generation_id=NEW.generation_id
    LEFT JOIN execution_activation_armaments armament
      ON armament.armament_id=NEW.armament_id
    LEFT JOIN execution_exit_authorizations exit_auth
      ON exit_auth.authorization_id=NEW.exit_authorization_id
    WHERE attempt.intent_id=NEW.intent_id
      AND attempt.attempt_number=NEW.attempt_number
      AND attempt.status='STARTED'
      AND intent.side=NEW.side
      AND intent.status IN ('PROCESSING','SIMULATED','SIGNED_NOT_SUBMITTED')
      AND generation.retired_at IS NULL
      AND generation.wallet_public_key=NEW.wallet_public_key
      AND ((NEW.side='BUY' AND armament.generation_id=NEW.generation_id
        AND armament.wallet_public_key=NEW.wallet_public_key AND armament.state='LOCKED')
        OR (NEW.side='SELL' AND exit_auth.generation_id=NEW.generation_id
          AND exit_auth.wallet_public_key=NEW.wallet_public_key AND exit_auth.state='LOCKED'
          AND exit_auth.locked_intent_id=NEW.intent_id
          AND exit_auth.locked_attempt_number=NEW.attempt_number))
  ) INTO valid_binding;
  IF NOT valid_binding THEN
    RAISE EXCEPTION 'guarded signed transaction insert required' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_signed_transactions_guarded_insert
  ON execution_signed_transactions;
CREATE TRIGGER execution_signed_transactions_guarded_insert
  BEFORE INSERT ON execution_signed_transactions
  FOR EACH ROW EXECUTE FUNCTION guard_execution_signed_transaction_insert();

CREATE OR REPLACE FUNCTION guard_execution_signed_transaction_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.artifact_id IS DISTINCT FROM OLD.artifact_id
    OR NEW.payload_version IS DISTINCT FROM OLD.payload_version
    OR NEW.specification_version IS DISTINCT FROM OLD.specification_version
    OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
    OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
    OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
    OR NEW.armament_id IS DISTINCT FROM OLD.armament_id
    OR NEW.exit_authorization_id IS DISTINCT FROM OLD.exit_authorization_id
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.wallet_public_key IS DISTINCT FROM OLD.wallet_public_key
    OR NEW.side IS DISTINCT FROM OLD.side
    OR NEW.effective_venue IS DISTINCT FROM OLD.effective_venue
    OR NEW.message_hash IS DISTINCT FROM OLD.message_hash
    OR NEW.build_fingerprint IS DISTINCT FROM OLD.build_fingerprint
    OR NEW.snapshot_fingerprint IS DISTINCT FROM OLD.snapshot_fingerprint
    OR NEW.quote_fingerprint IS DISTINCT FROM OLD.quote_fingerprint
    OR NEW.blockhash IS DISTINCT FROM OLD.blockhash
    OR NEW.last_valid_block_height IS DISTINCT FROM OLD.last_valid_block_height
    OR NEW.signature IS DISTINCT FROM OLD.signature
    OR NEW.signed_transaction_bytes IS DISTINCT FROM OLD.signed_transaction_bytes
    OR NEW.signed_transaction_hash IS DISTINCT FROM OLD.signed_transaction_hash
    OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
    OR NEW.state_revision <> OLD.state_revision + 1
  THEN
    RAISE EXCEPTION 'execution signed transaction identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_signed_transactions_guarded_update
  ON execution_signed_transactions;
CREATE TRIGGER execution_signed_transactions_guarded_update
  BEFORE UPDATE ON execution_signed_transactions
  FOR EACH ROW EXECUTE FUNCTION guard_execution_signed_transaction_update();

CREATE OR REPLACE FUNCTION guard_execution_live_position_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.position_id IS DISTINCT FROM OLD.position_id
    OR NEW.payload_version IS DISTINCT FROM OLD.payload_version
    OR NEW.buy_intent_id IS DISTINCT FROM OLD.buy_intent_id
    OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
    OR NEW.armament_id IS DISTINCT FROM OLD.armament_id
    OR NEW.wallet_public_key IS DISTINCT FROM OLD.wallet_public_key
    OR NEW.mint IS DISTINCT FROM OLD.mint
    OR NEW.quote_mint IS DISTINCT FROM OLD.quote_mint
    OR NEW.entry_venue IS DISTINCT FROM OLD.entry_venue
    OR NEW.quote_cost_raw IS DISTINCT FROM OLD.quote_cost_raw
    OR NEW.base_amount_raw IS DISTINCT FROM OLD.base_amount_raw
    OR NEW.fee_lamports IS DISTINCT FROM OLD.fee_lamports
    OR NEW.maximum_holding_ms IS DISTINCT FROM OLD.maximum_holding_ms
    OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
    OR NEW.exit_deadline_at IS DISTINCT FROM OLD.exit_deadline_at
    OR NEW.entry_reconciliation_fingerprint IS DISTINCT FROM OLD.entry_reconciliation_fingerprint
    OR NEW.state_revision <> OLD.state_revision + 1
  THEN
    RAISE EXCEPTION 'execution live position identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_live_positions_guarded_update ON execution_live_positions;
CREATE TRIGGER execution_live_positions_guarded_update
  BEFORE UPDATE ON execution_live_positions
  FOR EACH ROW EXECUTE FUNCTION guard_execution_live_position_update();

CREATE OR REPLACE FUNCTION guard_execution_exit_authorization_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
    OR NEW.payload_version IS DISTINCT FROM OLD.payload_version
    OR NEW.position_id IS DISTINCT FROM OLD.position_id
    OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
    OR NEW.wallet_public_key IS DISTINCT FROM OLD.wallet_public_key
    OR NEW.mint IS DISTINCT FROM OLD.mint
    OR NEW.quote_mint IS DISTINCT FROM OLD.quote_mint
    OR NEW.maximum_base_amount_raw IS DISTINCT FROM OLD.maximum_base_amount_raw
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.state_revision <> OLD.state_revision + 1
  THEN
    RAISE EXCEPTION 'execution exit authorization identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_exit_authorizations_guarded_update
  ON execution_exit_authorizations;
CREATE TRIGGER execution_exit_authorizations_guarded_update
  BEFORE UPDATE ON execution_exit_authorizations
  FOR EACH ROW EXECUTE FUNCTION guard_execution_exit_authorization_update();
