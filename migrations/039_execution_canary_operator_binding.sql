-- H2c is deliberately an upgrade boundary: a V1 armament that is still able
-- to authorize a signature must be reconciled before the V2 binding exists.
DO $precheck$
BEGIN
  IF EXISTS (
    SELECT 1 FROM execution_activation_armaments
    WHERE payload_version=1 AND state IN ('ARMED','LOCKED')
  ) THEN
    RAISE EXCEPTION 'cannot upgrade active V1 execution armament'
      USING ERRCODE='55000';
  END IF;
END
$precheck$;

ALTER TABLE execution_activation_armaments
  ADD COLUMN IF NOT EXISTS armament_request_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS canary_evidence_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS target_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS target_intent_state_revision BIGINT,
  ADD COLUMN IF NOT EXISTS target_strategy_id TEXT,
  ADD COLUMN IF NOT EXISTS target_strategy_version INTEGER,
  ADD COLUMN IF NOT EXISTS target_decision_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS target_mint TEXT,
  ADD COLUMN IF NOT EXISTS target_quote_mint TEXT,
  ADD COLUMN IF NOT EXISTS target_quote_amount_raw NUMERIC,
  ADD COLUMN IF NOT EXISTS target_admission_report_id TEXT,
  ADD COLUMN IF NOT EXISTS target_reservation_id TEXT,
  ADD COLUMN IF NOT EXISTS target_policy_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS target_wallet_snapshot_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS target_provider_snapshot_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS runtime_quote_max_age_ms INTEGER,
  ADD COLUMN IF NOT EXISTS runtime_slippage_bps INTEGER,
  ADD COLUMN IF NOT EXISTS runtime_snapshot_max_slot_lag BIGINT,
  ADD COLUMN IF NOT EXISTS runtime_max_compute_units INTEGER,
  ADD COLUMN IF NOT EXISTS runtime_max_fee_lamports NUMERIC,
  ADD COLUMN IF NOT EXISTS runtime_max_fee_payer_lamport_debit NUMERIC,
  ADD COLUMN IF NOT EXISTS runtime_max_rpc_calls_per_attempt INTEGER,
  ADD COLUMN IF NOT EXISTS runtime_lease_ms INTEGER,
  ADD COLUMN IF NOT EXISTS locked_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS locked_attempt_number INTEGER,
  ADD COLUMN IF NOT EXISTS locked_reservation_id TEXT,
  ADD COLUMN IF NOT EXISTS locked_lease_token UUID,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

ALTER TABLE execution_activation_armaments
  DROP CONSTRAINT IF EXISTS execution_activation_armaments_target_intent_fkey;
ALTER TABLE execution_activation_armaments
  ADD CONSTRAINT execution_activation_armaments_target_intent_fkey
  FOREIGN KEY (target_intent_id) REFERENCES execution_intents(id) ON DELETE RESTRICT;
ALTER TABLE execution_activation_armaments
  DROP CONSTRAINT IF EXISTS execution_activation_armaments_target_admission_fkey;
ALTER TABLE execution_activation_armaments
  ADD CONSTRAINT execution_activation_armaments_target_admission_fkey
  FOREIGN KEY (target_admission_report_id)
  REFERENCES execution_risk_admission_reports(report_id) ON DELETE RESTRICT;
ALTER TABLE execution_activation_armaments
  DROP CONSTRAINT IF EXISTS execution_activation_armaments_target_reservation_fkey;
ALTER TABLE execution_activation_armaments
  ADD CONSTRAINT execution_activation_armaments_target_reservation_fkey
  FOREIGN KEY (target_reservation_id)
  REFERENCES execution_exposure_reservations(reservation_id) ON DELETE RESTRICT;
ALTER TABLE execution_activation_armaments
  DROP CONSTRAINT IF EXISTS execution_activation_armaments_locked_attempt_fkey;
ALTER TABLE execution_activation_armaments
  ADD CONSTRAINT execution_activation_armaments_locked_attempt_fkey
  FOREIGN KEY (locked_intent_id, locked_attempt_number)
  REFERENCES execution_attempts(intent_id, attempt_number) ON DELETE RESTRICT;
ALTER TABLE execution_activation_armaments
  DROP CONSTRAINT IF EXISTS execution_activation_armaments_locked_reservation_fkey;
ALTER TABLE execution_activation_armaments
  ADD CONSTRAINT execution_activation_armaments_locked_reservation_fkey
  FOREIGN KEY (locked_reservation_id)
  REFERENCES execution_exposure_reservations(reservation_id) ON DELETE RESTRICT;

ALTER TABLE execution_activation_armaments
  DROP CONSTRAINT IF EXISTS execution_activation_armaments_identity_check;
ALTER TABLE execution_activation_armaments
  ADD CONSTRAINT execution_activation_armaments_identity_check CHECK (
    armament_id ~ '^execution_activation_armament_[0-9a-f]{64}$'
    AND armament_fingerprint ~ '^[0-9a-f]{64}$'
    AND qualification_fingerprint ~ '^[0-9a-f]{64}$'
    AND state IN ('ARMED', 'LOCKED', 'CONSUMED', 'REVOKED', 'EXPIRED')
    AND state_revision >= 0
    AND build_hash ~ '^[0-9a-f]{64}$'
    AND configuration_fingerprint ~ '^[0-9a-f]{64}$'
    AND strategy_fingerprint ~ '^[0-9a-f]{64}$'
    AND wallet_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND cluster='mainnet-beta'
    AND genesis_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,64}$'
    AND octet_length(provider_id) BETWEEN 1 AND 64
    AND octet_length(operator_id) BETWEEN 1 AND 64
    AND octet_length(operator_reason) BETWEEN 1 AND 256
    AND ((payload_version=1 AND state IN ('CONSUMED','REVOKED','EXPIRED')
      AND phase IN ('CANARY','MICRO_LIVE','PILOT')
      AND maximum_buys BETWEEN 1 AND 10
      AND maximum_open_positions BETWEEN 1 AND 2
      AND maximum_holding_ms BETWEEN 30000 AND 900000
      AND ROW(armament_request_fingerprint,canary_evidence_fingerprint,target_intent_id,
        target_intent_state_revision,target_strategy_id,target_strategy_version,
        target_decision_fingerprint,target_mint,target_quote_mint,target_quote_amount_raw,
        target_admission_report_id,target_reservation_id,target_policy_fingerprint,
        target_wallet_snapshot_fingerprint,target_provider_snapshot_fingerprint,
        runtime_quote_max_age_ms,runtime_slippage_bps,runtime_snapshot_max_slot_lag,
        runtime_max_compute_units,runtime_max_fee_lamports,runtime_max_fee_payer_lamport_debit,
        runtime_max_rpc_calls_per_attempt,runtime_lease_ms,locked_intent_id,
        locked_attempt_number,locked_reservation_id,locked_lease_token,locked_at) IS NULL)
      OR (payload_version=2 AND phase='CANARY'
        AND maximum_buys=1 AND maximum_exposure_bps=500 AND maximum_open_positions=1
        AND maximum_holding_ms BETWEEN 30000 AND 900000
        AND armament_request_fingerprint ~ '^[0-9a-f]{64}$'
        AND canary_evidence_fingerprint ~ '^[0-9a-f]{64}$'
        AND target_intent_id ~ '^execution_intent_[0-9a-f]{64}$'
        AND target_intent_state_revision >= 0
        AND octet_length(target_strategy_id) BETWEEN 1 AND 128
        AND target_strategy_version > 0
        AND target_decision_fingerprint ~ '^[0-9a-f]{64}$'
        AND target_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        AND target_quote_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        AND target_quote_amount_raw <> 'NaN'::NUMERIC AND target_quote_amount_raw > 0
        AND target_quote_amount_raw=trunc(target_quote_amount_raw)
        AND scale(target_quote_amount_raw)=0 AND target_quote_amount_raw < 18446744073709551616
        AND target_admission_report_id ~ '^execution_risk_admission_[0-9a-f]{64}$'
        AND target_reservation_id ~ '^execution_exposure_reservation_[0-9a-f]{64}$'
        AND target_policy_fingerprint ~ '^[0-9a-f]{64}$'
        AND target_wallet_snapshot_fingerprint ~ '^[0-9a-f]{64}$'
        AND target_provider_snapshot_fingerprint ~ '^[0-9a-f]{64}$'
        AND runtime_quote_max_age_ms BETWEEN 1 AND 60000
        AND runtime_slippage_bps BETWEEN 0 AND 10000
        AND runtime_snapshot_max_slot_lag BETWEEN 0 AND 128
        AND runtime_max_compute_units BETWEEN 1 AND 1400000
        AND runtime_max_fee_lamports <> 'NaN'::NUMERIC AND runtime_max_fee_lamports >= 0
        AND runtime_max_fee_lamports=trunc(runtime_max_fee_lamports)
        AND scale(runtime_max_fee_lamports)=0 AND runtime_max_fee_lamports <=10000000
        AND runtime_max_fee_payer_lamport_debit <> 'NaN'::NUMERIC
        AND runtime_max_fee_payer_lamport_debit >= 0
        AND runtime_max_fee_payer_lamport_debit=trunc(runtime_max_fee_payer_lamport_debit)
        AND scale(runtime_max_fee_payer_lamport_debit)=0
        AND runtime_max_fee_payer_lamport_debit <=10000000000
        AND runtime_max_rpc_calls_per_attempt BETWEEN 12 AND 16
        AND runtime_lease_ms BETWEEN 3000 AND 120000))
  );
ALTER TABLE execution_activation_armaments
  DROP CONSTRAINT IF EXISTS execution_activation_armaments_state_check;
ALTER TABLE execution_activation_armaments
  ADD CONSTRAINT execution_activation_armaments_state_check CHECK (
    (payload_version=1 AND state IN ('CONSUMED','REVOKED','EXPIRED')
      AND locked_intent_id IS NULL AND locked_attempt_number IS NULL
      AND locked_reservation_id IS NULL AND locked_lease_token IS NULL AND locked_at IS NULL
      AND terminal_at IS NOT NULL AND purge_after=terminal_at + INTERVAL '4 hours')
    OR (payload_version=2 AND state='ARMED' AND state_revision=0 AND consumed_buys=0 AND locked_intent_id IS NULL
      AND locked_attempt_number IS NULL AND locked_reservation_id IS NULL
      AND locked_lease_token IS NULL AND locked_at IS NULL
      AND terminal_at IS NULL AND purge_after IS NULL)
    OR (payload_version=2 AND state='LOCKED' AND state_revision=1 AND consumed_buys=1
      AND locked_intent_id=target_intent_id AND locked_attempt_number=1
      AND locked_reservation_id=target_reservation_id AND locked_lease_token IS NOT NULL
      AND locked_at IS NOT NULL AND terminal_at IS NULL AND purge_after IS NULL)
    OR (payload_version=2 AND state IN ('CONSUMED','REVOKED','EXPIRED')
      AND ((state='CONSUMED' AND state_revision=2)
        OR (state IN ('REVOKED','EXPIRED') AND state_revision IN (1,2)))
      AND terminal_at IS NOT NULL AND purge_after=terminal_at + INTERVAL '4 hours'
      AND ((locked_intent_id IS NULL AND locked_attempt_number IS NULL
          AND locked_reservation_id IS NULL AND locked_lease_token IS NULL AND locked_at IS NULL)
        OR (locked_intent_id=target_intent_id AND locked_attempt_number=1
          AND locked_reservation_id=target_reservation_id AND locked_lease_token IS NOT NULL
          AND locked_at IS NOT NULL)))
  );

ALTER TABLE execution_operator_authorizations
  DROP CONSTRAINT IF EXISTS execution_operator_authorizations_identity_check;
ALTER TABLE execution_operator_authorizations
  ADD CONSTRAINT execution_operator_authorizations_identity_check CHECK (
    authorization_id ~ '^execution_operator_authorization_[0-9a-f]{64}$'
    AND authorization_fingerprint ~ '^[0-9a-f]{64}$'
    AND context_fingerprint ~ '^[0-9a-f]{64}$'
    AND nonce_hash ~ '^[0-9a-f]{64}$'
    AND octet_length(operator_id) BETWEEN 1 AND 64
    -- Historical V1 ARM rows are retained for audit even if they simply expired
    -- unused. The insert trigger below is the forward-only prohibition.
    AND ((payload_version=1 AND ((action='RESUME' AND phase IS NULL)
      OR (action='ARM' AND phase IN ('CANARY','MICRO_LIVE','PILOT'))))
      OR (payload_version=2 AND action='ARM' AND phase='CANARY'))
  );

ALTER TABLE execution_operator_authorizations
  DROP CONSTRAINT IF EXISTS execution_operator_authorizations_temporal_check;
ALTER TABLE execution_operator_authorizations
  ADD CONSTRAINT execution_operator_authorizations_temporal_check CHECK (
    isfinite(issued_at) AND isfinite(expires_at) AND isfinite(purge_after)
    AND date_trunc('milliseconds', issued_at)=issued_at
    AND date_trunc('milliseconds', expires_at)=expires_at
    AND date_trunc('milliseconds', purge_after)=purge_after
    AND expires_at>issued_at
    AND ((payload_version=1 AND expires_at<=issued_at+INTERVAL '5 minutes')
      OR (payload_version=2 AND expires_at<=issued_at+INTERVAL '60 seconds'))
    AND (consumed_at IS NULL OR (isfinite(consumed_at)
      AND date_trunc('milliseconds', consumed_at)=consumed_at
      AND consumed_at>=issued_at AND consumed_at<=expires_at))
    AND purge_after=COALESCE(consumed_at,expires_at)+INTERVAL '4 hours'
  );

CREATE OR REPLACE FUNCTION guard_execution_operator_authorization_insert_v2()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.payload_version<>2 AND NEW.action='ARM' THEN
    RAISE EXCEPTION 'new V1 ARM authorization is forbidden' USING ERRCODE='55000';
  END IF;
  IF NEW.payload_version=2 AND (NEW.action<>'ARM' OR NEW.phase<>'CANARY') THEN
    RAISE EXCEPTION 'only V2 CANARY ARM authorization is permitted' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS execution_operator_authorizations_v2_insert
  ON execution_operator_authorizations;
CREATE TRIGGER execution_operator_authorizations_v2_insert
  BEFORE INSERT ON execution_operator_authorizations
  FOR EACH ROW EXECUTE FUNCTION guard_execution_operator_authorization_insert_v2();

CREATE TABLE IF NOT EXISTS execution_pre_signature_locks (
  lock_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  lock_fingerprint TEXT NOT NULL UNIQUE,
  intent_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  intent_state_revision BIGINT NOT NULL,
  armament_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  wallet_public_key TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  lease_token UUID NOT NULL,
  message_hash TEXT NOT NULL,
  unsigned_message_bytes BYTEA NOT NULL,
  unsigned_transaction_hash TEXT NOT NULL,
  unsigned_transaction_bytes BYTEA NOT NULL,
  build_hash TEXT NOT NULL,
  configuration_fingerprint TEXT NOT NULL,
  strategy_fingerprint TEXT NOT NULL,
  decision_fingerprint TEXT NOT NULL,
  policy_fingerprint TEXT NOT NULL,
  wallet_snapshot_fingerprint TEXT NOT NULL,
  provider_snapshot_fingerprint TEXT NOT NULL,
  quote_fingerprint TEXT NOT NULL,
  blockhash TEXT NOT NULL,
  last_valid_block_height BIGINT NOT NULL,
  state TEXT NOT NULL,
  state_revision BIGINT NOT NULL DEFAULT 0,
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp()),
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  UNIQUE (intent_id,attempt_number),
  UNIQUE (armament_id),
  CONSTRAINT execution_pre_signature_locks_intent_fkey FOREIGN KEY (intent_id)
    REFERENCES execution_intents(id) ON DELETE RESTRICT,
  CONSTRAINT execution_pre_signature_locks_attempt_fkey FOREIGN KEY (intent_id,attempt_number)
    REFERENCES execution_attempts(intent_id,attempt_number) ON DELETE RESTRICT,
  CONSTRAINT execution_pre_signature_locks_armament_fkey FOREIGN KEY (armament_id)
    REFERENCES execution_activation_armaments(armament_id) ON DELETE RESTRICT,
  CONSTRAINT execution_pre_signature_locks_reservation_fkey FOREIGN KEY (reservation_id)
    REFERENCES execution_exposure_reservations(reservation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_pre_signature_locks_generation_fkey FOREIGN KEY (generation_id)
    REFERENCES execution_wallet_generations(generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_pre_signature_locks_identity_check CHECK (
    payload_version=1 AND lock_id ~ '^execution_pre_signature_lock_[0-9a-f]{64}$'
    AND lock_fingerprint ~ '^[0-9a-f]{64}$'
    AND intent_id ~ '^execution_intent_[0-9a-f]{64}$' AND attempt_number=1
    AND intent_state_revision >= 1 AND armament_id ~ '^execution_activation_armament_[0-9a-f]{64}$'
    AND reservation_id ~ '^execution_exposure_reservation_[0-9a-f]{64}$'
    AND generation_id ~ '^execution_wallet_generation_[0-9a-f]{64}$'
    AND wallet_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND octet_length(provider_id) BETWEEN 1 AND 64
    AND message_hash ~ '^[0-9a-f]{64}$'
    AND octet_length(unsigned_message_bytes) BETWEEN 1 AND 1232
    AND unsigned_transaction_hash ~ '^[0-9a-f]{64}$'
    AND octet_length(unsigned_transaction_bytes) BETWEEN 1 AND 1232
    AND build_hash ~ '^[0-9a-f]{64}$' AND configuration_fingerprint ~ '^[0-9a-f]{64}$'
    AND strategy_fingerprint ~ '^[0-9a-f]{64}$' AND decision_fingerprint ~ '^[0-9a-f]{64}$'
    AND policy_fingerprint ~ '^[0-9a-f]{64}$' AND wallet_snapshot_fingerprint ~ '^[0-9a-f]{64}$'
    AND provider_snapshot_fingerprint ~ '^[0-9a-f]{64}$' AND quote_fingerprint ~ '^[0-9a-f]{64}$'
    AND blockhash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND last_valid_block_height >= 0
  ),
  CONSTRAINT execution_pre_signature_locks_state_check CHECK (
    state IN ('AUTHORIZED','SIGNED_PERSISTED','REVOKED')
    AND ((state='AUTHORIZED' AND state_revision=0 AND terminal_at IS NULL AND purge_after IS NULL)
      OR (state IN ('SIGNED_PERSISTED','REVOKED') AND state_revision=1 AND terminal_at IS NOT NULL
        AND purge_after=terminal_at + INTERVAL '4 hours'))
  ),
  CONSTRAINT execution_pre_signature_locks_temporal_check CHECK (
    isfinite(authorized_at) AND date_trunc('milliseconds',authorized_at)=authorized_at
    AND (terminal_at IS NULL OR (isfinite(terminal_at) AND terminal_at >= authorized_at
      AND date_trunc('milliseconds',terminal_at)=terminal_at))
  )
);
CREATE INDEX IF NOT EXISTS execution_pre_signature_locks_recovery_idx
  ON execution_pre_signature_locks(authorized_at,lock_id) WHERE state='AUTHORIZED';
CREATE INDEX IF NOT EXISTS execution_pre_signature_locks_purge_idx
  ON execution_pre_signature_locks(purge_after,lock_id)
  WHERE state IN ('SIGNED_PERSISTED','REVOKED');

CREATE OR REPLACE FUNCTION guard_execution_pre_signature_lock_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF ROW(NEW.lock_id,NEW.payload_version,NEW.lock_fingerprint,NEW.intent_id,NEW.attempt_number,
    NEW.intent_state_revision,NEW.armament_id,NEW.reservation_id,NEW.generation_id,
    NEW.wallet_public_key,NEW.provider_id,NEW.lease_token,NEW.message_hash,
    NEW.unsigned_message_bytes,NEW.unsigned_transaction_hash,NEW.unsigned_transaction_bytes,
    NEW.build_hash,NEW.configuration_fingerprint,NEW.strategy_fingerprint,
    NEW.decision_fingerprint,NEW.policy_fingerprint,NEW.wallet_snapshot_fingerprint,
    NEW.provider_snapshot_fingerprint,NEW.quote_fingerprint,NEW.blockhash,NEW.last_valid_block_height,
    NEW.authorized_at) IS DISTINCT FROM ROW(OLD.lock_id,OLD.payload_version,OLD.lock_fingerprint,
    OLD.intent_id,OLD.attempt_number,OLD.intent_state_revision,OLD.armament_id,OLD.reservation_id,
    OLD.generation_id,OLD.wallet_public_key,OLD.provider_id,OLD.lease_token,OLD.message_hash,
    OLD.unsigned_message_bytes,OLD.unsigned_transaction_hash,OLD.unsigned_transaction_bytes,
    OLD.build_hash,OLD.configuration_fingerprint,OLD.strategy_fingerprint,OLD.decision_fingerprint,
    OLD.policy_fingerprint,OLD.wallet_snapshot_fingerprint,OLD.provider_snapshot_fingerprint,
    OLD.quote_fingerprint,OLD.blockhash,OLD.last_valid_block_height,OLD.authorized_at)
    OR NEW.state_revision<>OLD.state_revision+1
    OR NOT ((OLD.state='AUTHORIZED' AND NEW.state IN ('SIGNED_PERSISTED','REVOKED')))
  THEN
    RAISE EXCEPTION 'pre-signature lock transition is immutable and closed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS execution_pre_signature_locks_immutable
  ON execution_pre_signature_locks;
CREATE TRIGGER execution_pre_signature_locks_immutable
  BEFORE UPDATE ON execution_pre_signature_locks
  FOR EACH ROW EXECUTE FUNCTION guard_execution_pre_signature_lock_update();

CREATE OR REPLACE FUNCTION guard_execution_pre_signature_lock_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.state='AUTHORIZED' OR OLD.purge_after IS NULL OR OLD.purge_after>statement_timestamp() THEN
    RAISE EXCEPTION 'pre-signature lock deletion requires terminal retention expiry' USING ERRCODE='55000';
  END IF;
  IF OLD.state='SIGNED_PERSISTED' AND EXISTS (
    SELECT 1 FROM execution_signed_transactions artifact
    WHERE artifact.intent_id=OLD.intent_id AND artifact.attempt_number=OLD.attempt_number
      AND artifact.armament_id=OLD.armament_id AND artifact.reservation_id=OLD.reservation_id
  ) THEN
    RAISE EXCEPTION 'pre-signature lock deletion requires artifact cohort purge' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END
$function$;
DROP TRIGGER IF EXISTS execution_pre_signature_locks_guarded_delete
  ON execution_pre_signature_locks;
CREATE TRIGGER execution_pre_signature_locks_guarded_delete
  BEFORE DELETE ON execution_pre_signature_locks
  FOR EACH ROW EXECUTE FUNCTION guard_execution_pre_signature_lock_delete();

ALTER TABLE execution_control_events
  ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'OPERATOR',
  ADD COLUMN IF NOT EXISTS actor_id TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS intent_id TEXT,
  ADD COLUMN IF NOT EXISTS attempt_number INTEGER,
  ADD COLUMN IF NOT EXISTS lock_id TEXT,
  ADD COLUMN IF NOT EXISTS artifact_id TEXT;
ALTER TABLE execution_control_events DISABLE TRIGGER execution_control_events_immutable;
UPDATE execution_control_events SET actor_id=operator_id
  WHERE actor_type='OPERATOR' AND actor_id IS NULL;
ALTER TABLE execution_control_events ENABLE TRIGGER execution_control_events_immutable;
ALTER TABLE execution_control_events
  DROP CONSTRAINT IF EXISTS execution_control_events_intent_fkey;
ALTER TABLE execution_control_events
  ADD CONSTRAINT execution_control_events_intent_fkey FOREIGN KEY (intent_id)
  REFERENCES execution_intents(id) ON DELETE RESTRICT;
ALTER TABLE execution_control_events
  DROP CONSTRAINT IF EXISTS execution_control_events_attempt_fkey;
ALTER TABLE execution_control_events
  ADD CONSTRAINT execution_control_events_attempt_fkey FOREIGN KEY (intent_id,attempt_number)
  REFERENCES execution_attempts(intent_id,attempt_number) ON DELETE RESTRICT;
ALTER TABLE execution_control_events
  DROP CONSTRAINT IF EXISTS execution_control_events_lock_fkey;
ALTER TABLE execution_control_events
  ADD CONSTRAINT execution_control_events_lock_fkey FOREIGN KEY (lock_id)
  REFERENCES execution_pre_signature_locks(lock_id) ON DELETE RESTRICT;
ALTER TABLE execution_control_events
  DROP CONSTRAINT IF EXISTS execution_control_events_artifact_fkey;
ALTER TABLE execution_control_events
  ADD CONSTRAINT execution_control_events_artifact_fkey FOREIGN KEY (artifact_id)
  REFERENCES execution_signed_transactions(artifact_id) ON DELETE RESTRICT;
ALTER TABLE execution_control_events DROP CONSTRAINT IF EXISTS execution_control_events_identity_check;
ALTER TABLE execution_control_events ADD CONSTRAINT execution_control_events_identity_check CHECK (
  payload_version=1 AND event_id ~ '^execution_control_event_[0-9a-f]{64}$'
  AND event_fingerprint ~ '^[0-9a-f]{64}$'
  AND actor_type IN ('OPERATOR','SYSTEM')
  AND (previous_state IS NULL OR previous_state IN ('RUNNING','ENTRY_STOP','HARD_STOP'))
  AND next_state IN ('RUNNING','ENTRY_STOP','HARD_STOP')
  AND ((actor_type='OPERATOR' AND actor_id IS NOT NULL AND actor_id=operator_id
    AND reason_code IN ('OPERATOR_ENTRY_STOP','OPERATOR_HARD_STOP','OPERATOR_RESUME')
    AND ((reason_code='OPERATOR_RESUME' AND qualification_id IS NOT NULL
      AND authorization_id IS NOT NULL AND next_state='RUNNING')
      OR (reason_code<>'OPERATOR_RESUME' AND qualification_id IS NULL
        AND authorization_id IS NULL AND next_state<>'RUNNING')))
    OR (actor_type='SYSTEM' AND actor_id IS NULL AND operator_id='SYSTEM'
      AND source IS NOT NULL AND octet_length(source) BETWEEN 1 AND 128
      AND reason_code IN ('SYSTEM_PRE_SIGNATURE_LOCK_STRANDED',
        'SYSTEM_SUBMISSION_AMBIGUOUS','SYSTEM_RECONCILIATION_UNKNOWN')
      AND authorization_id IS NULL AND qualification_id IS NULL
      AND ((previous_state='RUNNING' AND next_state='ENTRY_STOP')
        OR (previous_state='ENTRY_STOP' AND next_state='ENTRY_STOP'))))
);

CREATE OR REPLACE FUNCTION guard_execution_control_state_write()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE prior_state TEXT; transition_valid BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.generation_id, 51005));
  IF TG_OP='INSERT' THEN
    IF NEW.state='ENTRY_STOP' AND NEW.state_revision=0 AND NEW.last_event_id IS NULL THEN RETURN NEW; END IF;
    prior_state:=NULL;
  ELSE
    prior_state:=OLD.state;
    IF NEW.generation_id IS DISTINCT FROM OLD.generation_id OR NEW.payload_version IS DISTINCT FROM OLD.payload_version
      OR NEW.state_revision<>OLD.state_revision+1 OR NEW.last_event_id IS NULL THEN
      RAISE EXCEPTION 'guarded control transition required' USING ERRCODE='55000';
    END IF;
  END IF;
  SELECT EXISTS(SELECT 1 FROM execution_control_events event WHERE event.event_id=NEW.last_event_id
    AND event.generation_id=NEW.generation_id AND event.previous_state IS NOT DISTINCT FROM prior_state
    AND event.next_state=NEW.state AND event.occurred_at=NEW.updated_at
    AND ((event.actor_type='OPERATOR' AND ((NEW.state='ENTRY_STOP' AND event.reason_code='OPERATOR_ENTRY_STOP')
      OR (NEW.state='HARD_STOP' AND event.reason_code='OPERATOR_HARD_STOP')
      OR (NEW.state='RUNNING' AND event.reason_code='OPERATOR_RESUME')))
      OR (event.actor_type='SYSTEM' AND NEW.state='ENTRY_STOP'
        AND event.reason_code IN ('SYSTEM_PRE_SIGNATURE_LOCK_STRANDED','SYSTEM_SUBMISSION_AMBIGUOUS','SYSTEM_RECONCILIATION_UNKNOWN')))
    AND (prior_state IS DISTINCT FROM 'HARD_STOP' OR NEW.state<>'ENTRY_STOP')) INTO transition_valid;
  IF NOT transition_valid THEN RAISE EXCEPTION 'guarded control transition required' USING ERRCODE='55000'; END IF;
  IF NEW.state='RUNNING' THEN
    SELECT EXISTS(SELECT 1 FROM execution_control_events event JOIN execution_safety_qualifications qualification
      ON qualification.qualification_id=event.qualification_id JOIN execution_operator_authorizations operator_auth
      ON operator_auth.authorization_id=event.authorization_id JOIN execution_wallet_risk_state risk
      ON risk.generation_id=NEW.generation_id WHERE event.event_id=NEW.last_event_id
      AND event.actor_type='OPERATOR' AND qualification.generation_id=NEW.generation_id
      AND qualification.qualified_at<=statement_timestamp() AND qualification.expires_at>statement_timestamp()
      AND operator_auth.generation_id=NEW.generation_id AND operator_auth.action='RESUME'
      AND operator_auth.phase IS NULL AND operator_auth.context_fingerprint=qualification.qualification_fingerprint
      AND operator_auth.operator_id=event.operator_id AND operator_auth.consumed_at IS NOT NULL
      AND operator_auth.consumed_at BETWEEN operator_auth.issued_at AND operator_auth.expires_at
      AND operator_auth.expires_at>=statement_timestamp() AND risk.unknown_block=FALSE
      AND NOT EXISTS(SELECT 1 FROM execution_exposure_reservations reservation
        WHERE reservation.generation_id=NEW.generation_id AND reservation.state='UNKNOWN_HELD')) INTO transition_valid;
    IF NOT transition_valid THEN RAISE EXCEPTION 'guarded control transition required' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION guard_execution_activation_armament_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.payload_version=1 THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'historical V1 armament is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.payload_version IS DISTINCT FROM OLD.payload_version
    OR NEW.armament_id IS DISTINCT FROM OLD.armament_id OR NEW.armament_fingerprint IS DISTINCT FROM OLD.armament_fingerprint
    OR NEW.qualification_id IS DISTINCT FROM OLD.qualification_id OR NEW.qualification_fingerprint IS DISTINCT FROM OLD.qualification_fingerprint
    OR NEW.generation_id IS DISTINCT FROM OLD.generation_id OR NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
    OR NEW.phase IS DISTINCT FROM OLD.phase OR NEW.build_hash IS DISTINCT FROM OLD.build_hash
    OR NEW.configuration_fingerprint IS DISTINCT FROM OLD.configuration_fingerprint OR NEW.strategy_fingerprint IS DISTINCT FROM OLD.strategy_fingerprint
    OR NEW.wallet_public_key IS DISTINCT FROM OLD.wallet_public_key OR NEW.cluster IS DISTINCT FROM OLD.cluster
    OR NEW.genesis_hash IS DISTINCT FROM OLD.genesis_hash OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.maximum_buys IS DISTINCT FROM OLD.maximum_buys OR NEW.maximum_capital_lamports IS DISTINCT FROM OLD.maximum_capital_lamports
    OR NEW.maximum_exposure_bps IS DISTINCT FROM OLD.maximum_exposure_bps OR NEW.maximum_open_positions IS DISTINCT FROM OLD.maximum_open_positions
    OR NEW.maximum_holding_ms IS DISTINCT FROM OLD.maximum_holding_ms OR NEW.operator_id IS DISTINCT FROM OLD.operator_id
    OR NEW.operator_reason IS DISTINCT FROM OLD.operator_reason OR NEW.armed_at IS DISTINCT FROM OLD.armed_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR ROW(NEW.armament_request_fingerprint,NEW.canary_evidence_fingerprint,NEW.target_intent_id,NEW.target_intent_state_revision,
      NEW.target_strategy_id,NEW.target_strategy_version,NEW.target_decision_fingerprint,NEW.target_mint,NEW.target_quote_mint,
      NEW.target_quote_amount_raw,NEW.target_admission_report_id,NEW.target_reservation_id,NEW.target_policy_fingerprint,
      NEW.target_wallet_snapshot_fingerprint,NEW.target_provider_snapshot_fingerprint,NEW.runtime_quote_max_age_ms,
      NEW.runtime_slippage_bps,NEW.runtime_snapshot_max_slot_lag,NEW.runtime_max_compute_units,NEW.runtime_max_fee_lamports,
      NEW.runtime_max_fee_payer_lamport_debit,NEW.runtime_max_rpc_calls_per_attempt,NEW.runtime_lease_ms)
      IS DISTINCT FROM ROW(OLD.armament_request_fingerprint,OLD.canary_evidence_fingerprint,OLD.target_intent_id,OLD.target_intent_state_revision,
      OLD.target_strategy_id,OLD.target_strategy_version,OLD.target_decision_fingerprint,OLD.target_mint,OLD.target_quote_mint,
      OLD.target_quote_amount_raw,OLD.target_admission_report_id,OLD.target_reservation_id,OLD.target_policy_fingerprint,
      OLD.target_wallet_snapshot_fingerprint,OLD.target_provider_snapshot_fingerprint,OLD.runtime_quote_max_age_ms,
      OLD.runtime_slippage_bps,OLD.runtime_snapshot_max_slot_lag,OLD.runtime_max_compute_units,OLD.runtime_max_fee_lamports,
      OLD.runtime_max_fee_payer_lamport_debit,OLD.runtime_max_rpc_calls_per_attempt,OLD.runtime_lease_ms)
  THEN RAISE EXCEPTION 'execution activation armament identity is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.state_revision<>OLD.state_revision+1 THEN
    RAISE EXCEPTION 'armament state revision must advance exactly once' USING ERRCODE='55000';
  END IF;
  IF OLD.state='ARMED' AND NEW.state='LOCKED' THEN
    IF OLD.consumed_buys<>0 OR NEW.consumed_buys<>1
      OR NEW.locked_intent_id IS DISTINCT FROM NEW.target_intent_id
      OR NEW.locked_attempt_number<>1
      OR NEW.locked_reservation_id IS DISTINCT FROM NEW.target_reservation_id
      OR NEW.locked_lease_token IS NULL OR NEW.locked_at IS NULL
    THEN RAISE EXCEPTION 'armament lock transition requires exact lock binding' USING ERRCODE='55000'; END IF;
  ELSIF OLD.state='ARMED' AND NEW.state IN ('REVOKED','EXPIRED') THEN
    IF NEW.consumed_buys<>0
      OR ROW(NEW.locked_intent_id,NEW.locked_attempt_number,NEW.locked_reservation_id,
        NEW.locked_lease_token,NEW.locked_at) IS NOT NULL
    THEN RAISE EXCEPTION 'unlocked armament terminal transition is invalid' USING ERRCODE='55000'; END IF;
  ELSIF OLD.state='LOCKED' AND NEW.state IN ('CONSUMED','REVOKED') THEN
    IF OLD.consumed_buys<>1 OR NEW.consumed_buys<>1
      OR ROW(NEW.locked_intent_id,NEW.locked_attempt_number,NEW.locked_reservation_id,
        NEW.locked_lease_token,NEW.locked_at)
        IS DISTINCT FROM ROW(OLD.locked_intent_id,OLD.locked_attempt_number,OLD.locked_reservation_id,
          OLD.locked_lease_token,OLD.locked_at)
    THEN RAISE EXCEPTION 'locked armament binding is immutable' USING ERRCODE='55000'; END IF;
  ELSE
    RAISE EXCEPTION 'armament state transition is not permitted' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION guard_execution_activation_armament_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE armament_valid BOOLEAN;
BEGIN
  IF NEW.payload_version<>2 OR NEW.state<>'ARMED' THEN
    RAISE EXCEPTION 'only V2 CANARY armament insert is permitted' USING ERRCODE='55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.generation_id, 51005));
  SELECT EXISTS(SELECT 1 FROM execution_safety_qualifications qualification
    JOIN execution_operator_authorizations operator_auth ON operator_auth.authorization_id=NEW.authorization_id
    JOIN execution_control_state control ON control.generation_id=NEW.generation_id
    JOIN execution_wallet_risk_state risk ON risk.generation_id=NEW.generation_id
    JOIN execution_intents intent ON intent.id=NEW.target_intent_id
    JOIN execution_risk_admission_reports report ON report.report_id=NEW.target_admission_report_id
    JOIN execution_exposure_reservations reservation ON reservation.reservation_id=NEW.target_reservation_id
    JOIN execution_wallet_snapshots wallet_snapshot
      ON wallet_snapshot.snapshot_fingerprint=NEW.target_wallet_snapshot_fingerprint
    JOIN execution_provider_usage_snapshots provider_snapshot
      ON provider_snapshot.snapshot_fingerprint=NEW.target_provider_snapshot_fingerprint
    JOIN execution_safety_gate_evidence provider_gate
      ON provider_gate.qualification_id=qualification.qualification_id
        AND provider_gate.gate_index=7 AND provider_gate.gate_id='PROVIDER_EXIT_CAPACITY_VERIFIED'
    JOIN execution_safety_gate_evidence wallet_gate
      ON wallet_gate.qualification_id=qualification.qualification_id
        AND wallet_gate.gate_index=9 AND wallet_gate.gate_id='WALLET_CHAIN_LIMITS_VERIFIED'
    WHERE qualification.qualification_id=NEW.qualification_id AND qualification.qualification_fingerprint=NEW.qualification_fingerprint
      AND qualification.generation_id=NEW.generation_id AND qualification.phase='CANARY'
      AND qualification.build_hash=NEW.build_hash AND qualification.configuration_fingerprint=NEW.configuration_fingerprint
      AND qualification.strategy_fingerprint=NEW.strategy_fingerprint AND qualification.wallet_public_key=NEW.wallet_public_key
      AND qualification.cluster=NEW.cluster AND qualification.genesis_hash=NEW.genesis_hash AND qualification.provider_id=NEW.provider_id
      AND qualification.qualified_at<=statement_timestamp()
      AND qualification.expires_at>=statement_timestamp()+NEW.runtime_lease_ms*INTERVAL '2 milliseconds'
      AND NEW.expires_at<=qualification.expires_at
      AND operator_auth.payload_version=2 AND operator_auth.action='ARM' AND operator_auth.phase='CANARY'
      AND operator_auth.context_fingerprint=NEW.armament_request_fingerprint AND operator_auth.operator_id=NEW.operator_id
      AND operator_auth.consumed_at IS NOT NULL AND operator_auth.consumed_at BETWEEN operator_auth.issued_at AND operator_auth.expires_at
      AND operator_auth.expires_at>=statement_timestamp() AND control.state='RUNNING' AND risk.unknown_block=FALSE
      AND intent.side='BUY' AND intent.status='PENDING' AND intent.lease_token IS NULL AND intent.state_revision=NEW.target_intent_state_revision
      AND intent.strategy_id=NEW.target_strategy_id AND intent.strategy_version=NEW.target_strategy_version
      AND intent.decision_fingerprint=NEW.target_decision_fingerprint AND intent.mint=NEW.target_mint
      AND intent.quote_mint='So11111111111111111111111111111111111111112'
      AND NEW.target_quote_mint='So11111111111111111111111111111111111111112'
      AND intent.quote_mint=NEW.target_quote_mint AND intent.quote_amount_raw=NEW.target_quote_amount_raw
      AND intent.expires_at>=statement_timestamp()+NEW.runtime_lease_ms*INTERVAL '2 milliseconds'
      AND NEW.expires_at<=intent.expires_at
      AND wallet_snapshot.generation_id=NEW.generation_id AND wallet_snapshot.provider_id=NEW.provider_id
      AND wallet_snapshot.superseded_at IS NULL AND wallet_snapshot.observed_at<=statement_timestamp()
      AND wallet_gate.evidence_id=wallet_snapshot.snapshot_id
      AND wallet_gate.evidence_fingerprint=wallet_snapshot.snapshot_fingerprint
      AND wallet_gate.observed_at<=statement_timestamp()
      AND wallet_gate.expires_at>=statement_timestamp()+NEW.runtime_lease_ms*INTERVAL '2 milliseconds'
      AND provider_snapshot.provider_id=NEW.provider_id AND provider_snapshot.superseded_at IS NULL
      AND provider_snapshot.measured_at<=statement_timestamp()
      AND provider_snapshot.expires_at>=statement_timestamp()+NEW.runtime_lease_ms*INTERVAL '2 milliseconds'
      AND provider_gate.evidence_id=provider_snapshot.snapshot_id
      AND provider_gate.evidence_fingerprint=provider_snapshot.snapshot_fingerprint
      AND provider_gate.observed_at<=statement_timestamp()
      AND provider_gate.expires_at>=statement_timestamp()+NEW.runtime_lease_ms*INTERVAL '2 milliseconds'
      AND report.intent_id=intent.id AND report.generation_id=NEW.generation_id
      AND report.decision='ADMITTED' AND report.quota_state='NORMAL'
      AND report.quote_amount_raw=NEW.target_quote_amount_raw
      AND report.policy_fingerprint=NEW.target_policy_fingerprint AND report.wallet_snapshot_fingerprint=NEW.target_wallet_snapshot_fingerprint
      AND report.provider_snapshot_fingerprint=NEW.target_provider_snapshot_fingerprint
      AND reservation.intent_id=intent.id AND reservation.admission_report_id=report.report_id AND reservation.generation_id=NEW.generation_id
      AND reservation.state='RESERVED' AND reservation.side='BUY' AND reservation.mint=NEW.target_mint
      AND reservation.quote_mint=NEW.target_quote_mint AND reservation.maximum_amount_raw=NEW.target_quote_amount_raw
      AND reservation.policy_fingerprint=NEW.target_policy_fingerprint
      AND reservation.wallet_snapshot_fingerprint=NEW.target_wallet_snapshot_fingerprint
      AND reservation.provider_snapshot_fingerprint=NEW.target_provider_snapshot_fingerprint
      AND NEW.target_quote_amount_raw<=NEW.maximum_capital_lamports AND NEW.state_revision=0 AND NEW.consumed_buys=0
      AND NEW.armed_at<=statement_timestamp()
      AND NEW.expires_at>=statement_timestamp()+NEW.runtime_lease_ms*INTERVAL '2 milliseconds') INTO armament_valid;
  IF NOT armament_valid THEN RAISE EXCEPTION 'guarded V2 armament insert required' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS execution_activation_armaments_guarded_insert
  ON execution_activation_armaments;
CREATE TRIGGER execution_activation_armaments_guarded_insert
  BEFORE INSERT ON execution_activation_armaments
  FOR EACH ROW EXECUTE FUNCTION guard_execution_activation_armament_insert();
