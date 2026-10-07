-- Lot 4a: entry envelope v2, ENVELOPE-scoped safety qualification and
-- envelope-bound armaments. CANARY rows keep their exact 035/039 semantics.

-- 1. Qualification scope. CANARY stays payload version 1 with exactly five
--    minutes; ENVELOPE is payload version 2, bound to one envelope, at most 24 hours.
ALTER TABLE execution_safety_qualifications
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'CANARY',
  ADD COLUMN IF NOT EXISTS envelope_id TEXT;

ALTER TABLE execution_safety_qualifications
  DROP CONSTRAINT IF EXISTS execution_safety_qualifications_envelope_fkey;
ALTER TABLE execution_safety_qualifications
  ADD CONSTRAINT execution_safety_qualifications_envelope_fkey
  FOREIGN KEY (envelope_id) REFERENCES execution_entry_envelopes (envelope_id) ON DELETE RESTRICT;

ALTER TABLE execution_safety_qualifications
  DROP CONSTRAINT IF EXISTS execution_safety_qualifications_identity_check;
ALTER TABLE execution_safety_qualifications
  ADD CONSTRAINT execution_safety_qualifications_identity_check CHECK (
    evaluator_version = 1
    AND ((payload_version = 1 AND scope = 'CANARY' AND envelope_id IS NULL)
      OR (payload_version = 2 AND scope = 'ENVELOPE' AND phase = 'CANARY'
        AND envelope_id IS NOT NULL AND envelope_id ~ '^execution_entry_envelope_[0-9a-f]{64}$'))
    AND qualification_id ~ '^execution_safety_qualification_[0-9a-f]{64}$'
    AND qualification_fingerprint ~ '^[0-9a-f]{64}$'
    AND phase IN ('CANARY', 'MICRO_LIVE', 'PILOT')
    AND build_hash ~ '^[0-9a-f]{64}$'
    AND configuration_fingerprint ~ '^[0-9a-f]{64}$'
    AND strategy_fingerprint ~ '^[0-9a-f]{64}$'
    AND wallet_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND cluster = 'mainnet-beta'
    AND genesis_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,64}$'
    AND octet_length(provider_id) BETWEEN 1 AND 64
  );

ALTER TABLE execution_safety_qualifications
  DROP CONSTRAINT IF EXISTS execution_safety_qualifications_temporal_check;
ALTER TABLE execution_safety_qualifications
  ADD CONSTRAINT execution_safety_qualifications_temporal_check CHECK (
    isfinite(qualified_at) AND isfinite(expires_at) AND isfinite(purge_after)
    AND date_trunc('milliseconds', qualified_at) = qualified_at
    AND date_trunc('milliseconds', expires_at) = expires_at
    AND date_trunc('milliseconds', purge_after) = purge_after
    AND ((scope = 'CANARY' AND expires_at = qualified_at + INTERVAL '5 minutes')
      OR (scope = 'ENVELOPE' AND expires_at > qualified_at
        AND expires_at <= qualified_at + INTERVAL '24 hours'))
    AND purge_after = expires_at + INTERVAL '4 hours'
  );

-- 2. Operator authorization action ENVELOPE (v1, no phase). The 039 insert
--    trigger is untouched: it still forbids every new v1 ARM.
ALTER TABLE execution_operator_authorizations
  DROP CONSTRAINT IF EXISTS execution_operator_authorizations_identity_check;
ALTER TABLE execution_operator_authorizations
  ADD CONSTRAINT execution_operator_authorizations_identity_check CHECK (
    authorization_id ~ '^execution_operator_authorization_[0-9a-f]{64}$'
    AND authorization_fingerprint ~ '^[0-9a-f]{64}$'
    AND context_fingerprint ~ '^[0-9a-f]{64}$'
    AND nonce_hash ~ '^[0-9a-f]{64}$'
    AND octet_length(operator_id) BETWEEN 1 AND 64
    AND ((payload_version=1 AND ((action='RESUME' AND phase IS NULL)
      OR (action='ARM' AND phase IN ('CANARY','MICRO_LIVE','PILOT'))
      OR (action='ENVELOPE' AND phase IS NULL)))
      OR (payload_version=2 AND action='ARM' AND phase='CANARY'))
  );

-- 3. Provider usage provenance: executor counters (never signed).
ALTER TABLE execution_provider_usage_snapshots
  DROP CONSTRAINT IF EXISTS execution_provider_usage_snapshots_identity_check;
ALTER TABLE execution_provider_usage_snapshots
  ADD CONSTRAINT execution_provider_usage_snapshots_identity_check CHECK (
    payload_version = 1
    AND snapshot_id ~ '^execution_provider_usage_[0-9a-f]{64}$'
    AND snapshot_fingerprint ~ '^[0-9a-f]{64}$'
    AND octet_length(provider_id) BETWEEN 1 AND 256
    AND octet_length(plan_id) BETWEEN 1 AND 128
    AND octet_length(billing_period_id) BETWEEN 1 AND 128
    AND provenance IN ('AUTHORITATIVE_PROBE', 'OPERATOR_REPORT', 'EXECUTOR_COUNTERS')
  );

-- 4. Entry envelope v2. authorization_id is plain TEXT without a foreign key:
--    operator authorizations are purged by retention.
ALTER TABLE execution_entry_envelopes
  ADD COLUMN IF NOT EXISTS authorization_id TEXT,
  ADD COLUMN IF NOT EXISTS risk_policy JSONB,
  ADD COLUMN IF NOT EXISTS policy_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS maximum_holding_ms INTEGER;

ALTER TABLE execution_entry_envelopes
  DROP CONSTRAINT IF EXISTS execution_entry_envelopes_v2_check;
ALTER TABLE execution_entry_envelopes
  ADD CONSTRAINT execution_entry_envelopes_v2_check CHECK (
    -- Lot 3 rows are payload version 1 and never armable: the armament trigger requires v2.
    payload_version = 1
    OR (payload_version = 2 AND envelope_id = 'execution_entry_envelope_' || fingerprint
      -- A NULL operand would make the CHECK pass: every v2 column is required explicitly.
      AND authorization_id IS NOT NULL AND risk_policy IS NOT NULL
      AND policy_fingerprint IS NOT NULL AND maximum_holding_ms IS NOT NULL
      AND date_trunc('milliseconds', valid_from) = valid_from
      AND date_trunc('milliseconds', valid_until) = valid_until
      AND authorization_id ~ '^execution_operator_authorization_[0-9a-f]{64}$'
      AND policy_fingerprint ~ '^[0-9a-f]{64}$' AND jsonb_typeof(risk_policy) = 'object'
      AND maximum_holding_ms BETWEEN 30000 AND 900000
      AND max_total_exposure_raw >= per_buy_quote_amount_raw
      AND buys_armed * per_buy_quote_amount_raw <= max_total_exposure_raw)
  );

CREATE OR REPLACE FUNCTION guard_execution_entry_envelope_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.payload_version<>2 THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.generation_id, 51005));
  IF NEW.state<>'ACTIVE' OR NEW.buys_armed<>0 OR NEW.realized_loss_raw<>0
    OR NEW.revoked_at IS NOT NULL
    OR NEW.valid_from>statement_timestamp() OR NEW.valid_until<=statement_timestamp()
    OR NOT EXISTS (SELECT 1 FROM execution_wallet_generations generation
      WHERE generation.generation_id=NEW.generation_id AND generation.retired_at IS NULL)
    OR NOT EXISTS (SELECT 1 FROM execution_operator_authorizations operator_auth
      WHERE operator_auth.authorization_id=NEW.authorization_id
        AND operator_auth.payload_version=1 AND operator_auth.action='ENVELOPE'
        AND operator_auth.phase IS NULL
        AND operator_auth.generation_id=NEW.generation_id
        AND operator_auth.context_fingerprint=NEW.fingerprint
        AND operator_auth.operator_id=NEW.operator_id
        AND operator_auth.consumed_at IS NOT NULL
        AND operator_auth.expires_at>=statement_timestamp())
  THEN
    RAISE EXCEPTION 'guarded V2 entry envelope insert required' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS execution_entry_envelopes_guarded_insert ON execution_entry_envelopes;
CREATE TRIGGER execution_entry_envelopes_guarded_insert
  BEFORE INSERT ON execution_entry_envelopes
  FOR EACH ROW EXECUTE FUNCTION guard_execution_entry_envelope_insert();

CREATE OR REPLACE FUNCTION guard_execution_entry_envelope_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.envelope_id IS DISTINCT FROM OLD.envelope_id
    OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
    OR NEW.operator_id IS DISTINCT FROM OLD.operator_id
    OR NEW.payload_version IS DISTINCT FROM OLD.payload_version
    OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
    OR NEW.per_buy_quote_amount_raw IS DISTINCT FROM OLD.per_buy_quote_amount_raw
    OR NEW.max_buys IS DISTINCT FROM OLD.max_buys
    OR NEW.max_open_positions IS DISTINCT FROM OLD.max_open_positions
    OR NEW.max_total_exposure_raw IS DISTINCT FROM OLD.max_total_exposure_raw
    OR NEW.max_realized_loss_raw IS DISTINCT FROM OLD.max_realized_loss_raw
    OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
    OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
    OR NEW.risk_policy IS DISTINCT FROM OLD.risk_policy
    OR NEW.policy_fingerprint IS DISTINCT FROM OLD.policy_fingerprint
    OR NEW.maximum_holding_ms IS DISTINCT FROM OLD.maximum_holding_ms
  THEN
    RAISE EXCEPTION 'entry envelope identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.buys_armed<OLD.buys_armed OR NEW.realized_loss_raw<OLD.realized_loss_raw
    OR NEW.updated_at<OLD.updated_at
    OR (OLD.state<>'ACTIVE' AND NEW.state IS DISTINCT FROM OLD.state)
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
  THEN
    RAISE EXCEPTION 'entry envelope counters and state are monotonic' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS execution_entry_envelopes_guarded_update ON execution_entry_envelopes;
CREATE TRIGGER execution_entry_envelopes_guarded_update
  BEFORE UPDATE ON execution_entry_envelopes
  FOR EACH ROW EXECUTE FUNCTION guard_execution_entry_envelope_update();

-- 5. Armament link to its envelope (the armament is the child; retention unaffected).
ALTER TABLE execution_activation_armaments ADD COLUMN IF NOT EXISTS envelope_id TEXT;
ALTER TABLE execution_activation_armaments
  DROP CONSTRAINT IF EXISTS execution_activation_armaments_envelope_fkey;
ALTER TABLE execution_activation_armaments
  ADD CONSTRAINT execution_activation_armaments_envelope_fkey
  FOREIGN KEY (envelope_id) REFERENCES execution_entry_envelopes (envelope_id) ON DELETE RESTRICT;

-- 6. Armament update guard: 039 body, plus envelope_id in the immutable identity.
CREATE OR REPLACE FUNCTION guard_execution_activation_armament_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.payload_version=1 THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'historical V1 armament is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(OLD.generation_id, 51005));
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
    OR NEW.envelope_id IS DISTINCT FROM OLD.envelope_id
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
    IF NOT EXISTS (SELECT 1 FROM execution_pre_signature_locks lock
      WHERE lock.armament_id=NEW.armament_id AND lock.state='AUTHORIZED' AND lock.state_revision=0
        AND lock.generation_id=NEW.generation_id AND lock.intent_id=NEW.target_intent_id
        AND lock.intent_state_revision=NEW.target_intent_state_revision+1
        AND lock.attempt_number=NEW.locked_attempt_number AND lock.reservation_id=NEW.target_reservation_id
        AND lock.lease_token=NEW.locked_lease_token AND lock.wallet_public_key=NEW.wallet_public_key
        AND lock.provider_id=NEW.provider_id AND lock.build_hash=NEW.build_hash
        AND lock.configuration_fingerprint=NEW.configuration_fingerprint
        AND lock.strategy_fingerprint=NEW.strategy_fingerprint
        AND lock.decision_fingerprint=NEW.target_decision_fingerprint
        AND lock.policy_fingerprint=NEW.target_policy_fingerprint
        AND lock.wallet_snapshot_fingerprint=NEW.target_wallet_snapshot_fingerprint
        AND lock.provider_snapshot_fingerprint=NEW.target_provider_snapshot_fingerprint)
    THEN RAISE EXCEPTION 'armament lock transition requires exact authorized pre-signature lock' USING ERRCODE='55000'; END IF;
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

-- 7. Armament insert guard: 039 body, with the wallet and provider gate
--    equalities moved into the CANARY branch, plus the ENVELOPE branch and the
--    envelope counter update in the same transaction.
CREATE OR REPLACE FUNCTION guard_execution_activation_armament_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE armament_valid BOOLEAN; envelope_rows INTEGER;
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
      AND wallet_gate.observed_at<=statement_timestamp()
      AND wallet_gate.expires_at>=statement_timestamp()+NEW.runtime_lease_ms*INTERVAL '2 milliseconds'
      AND provider_snapshot.provider_id=NEW.provider_id AND provider_snapshot.superseded_at IS NULL
      AND provider_snapshot.measured_at<=statement_timestamp()
      AND provider_snapshot.expires_at>=statement_timestamp()+NEW.runtime_lease_ms*INTERVAL '2 milliseconds'
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
      AND NEW.expires_at>=statement_timestamp()+NEW.runtime_lease_ms*INTERVAL '2 milliseconds'
      AND ((qualification.scope='CANARY' AND NEW.envelope_id IS NULL
          AND wallet_gate.evidence_id=wallet_snapshot.snapshot_id
          AND wallet_gate.evidence_fingerprint=wallet_snapshot.snapshot_fingerprint
          AND provider_gate.evidence_id=provider_snapshot.snapshot_id
          AND provider_gate.evidence_fingerprint=provider_snapshot.snapshot_fingerprint)
        OR (qualification.scope='ENVELOPE' AND NEW.envelope_id IS NOT NULL
          AND qualification.envelope_id=NEW.envelope_id
          AND NEW.target_strategy_id='fast-entry-v1'
          AND EXISTS (SELECT 1 FROM execution_entry_envelopes envelope
            WHERE envelope.envelope_id=NEW.envelope_id AND envelope.payload_version=2
              AND envelope.generation_id=NEW.generation_id AND envelope.state='ACTIVE'
              AND envelope.operator_id=NEW.operator_id
              AND envelope.valid_from<=statement_timestamp()
              AND envelope.valid_until>=statement_timestamp()
                +NEW.maximum_holding_ms*INTERVAL '1 millisecond'+INTERVAL '15 minutes'
              AND qualification.expires_at=envelope.valid_until
              AND intent.requested_at>=envelope.valid_from
              AND envelope.per_buy_quote_amount_raw=NEW.target_quote_amount_raw
              AND envelope.per_buy_quote_amount_raw=NEW.maximum_capital_lamports
              AND envelope.maximum_holding_ms=NEW.maximum_holding_ms
              AND envelope.policy_fingerprint=NEW.target_policy_fingerprint
              AND envelope.buys_armed<envelope.max_buys
              AND (envelope.buys_armed+1)*envelope.per_buy_quote_amount_raw<=envelope.max_total_exposure_raw
              AND envelope.realized_loss_raw<envelope.max_realized_loss_raw)))
  ) INTO armament_valid;
  IF NOT armament_valid THEN RAISE EXCEPTION 'guarded V2 armament insert required' USING ERRCODE='55000'; END IF;
  IF NEW.envelope_id IS NOT NULL THEN
    UPDATE execution_entry_envelopes SET buys_armed=buys_armed+1,
      state=CASE WHEN buys_armed+1>=max_buys
        OR (buys_armed+2)*per_buy_quote_amount_raw>max_total_exposure_raw THEN 'EXHAUSTED' ELSE state END,
      updated_at=GREATEST(updated_at,date_trunc('milliseconds',statement_timestamp()))
    WHERE envelope_id=NEW.envelope_id AND state='ACTIVE';
    GET DIAGNOSTICS envelope_rows = ROW_COUNT;
    IF envelope_rows<>1 THEN RAISE EXCEPTION 'envelope counter update required' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS execution_activation_armaments_guarded_insert
  ON execution_activation_armaments;
CREATE TRIGGER execution_activation_armaments_guarded_insert
  BEFORE INSERT ON execution_activation_armaments
  FOR EACH ROW EXECUTE FUNCTION guard_execution_activation_armament_insert();
