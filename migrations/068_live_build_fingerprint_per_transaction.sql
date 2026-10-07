-- Lot 5 blocker 5: a signed transaction's build_fingerprint hashes that one transaction's
-- instructions (fee payer, programs, every account including the mint and its bonding curve,
-- amounts), so it differs for every BUY. The pre-signature lock's build_hash is the static
-- EXECUTOR_BUILD_HASH (the gate-10 artifact's fingerprint) that binds the qualification, the
-- armament and the lock to the configured identity (039 keeps armament.build_hash=NEW.build_hash
-- on lock insert). 039 also required lock.build_hash=artifact.build_fingerprint, so with the
-- entry envelope (mint unknown in advance) every fast-entry BUY failed closed at persistence
-- after its armament had been LOCKED and its buys_armed consumed.
-- This redefines the two 039 trigger functions without that single clause; every other check is
-- kept verbatim and the triggers stay bound to the same function names. The per-transaction
-- fingerprint remains bound to the unsigned simulation (lock.unsigned_simulation_fingerprint)
-- and to the signed artifact of this attempt by the repository. Replayable.
CREATE OR REPLACE FUNCTION guard_execution_signed_transaction_pre_signature_lock_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE lock_valid BOOLEAN;
BEGIN
  IF NEW.side='SELL' THEN
    IF NEW.pre_signature_lock_id IS NOT NULL THEN
      RAISE EXCEPTION 'SELL signed transaction cannot consume a pre-signature lock'
        USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  SELECT EXISTS(SELECT 1 FROM execution_pre_signature_locks lock
    JOIN execution_activation_armaments armament ON armament.armament_id=lock.armament_id
    WHERE lock.lock_id=NEW.pre_signature_lock_id AND lock.state='AUTHORIZED'
      AND lock.state_revision=0 AND lock.intent_id=NEW.intent_id
      AND lock.attempt_number=NEW.attempt_number AND lock.armament_id=NEW.armament_id
      AND lock.reservation_id=NEW.reservation_id AND lock.generation_id=NEW.generation_id
      AND lock.wallet_public_key=NEW.wallet_public_key AND lock.provider_id=NEW.provider_id
      AND lock.message_hash=NEW.message_hash
      AND lock.market_snapshot_fingerprint=NEW.snapshot_fingerprint
      AND lock.quote_fingerprint=NEW.quote_fingerprint
      AND lock.quote_observed_at=NEW.quote_observed_at
      AND lock.quote_expires_at=NEW.quote_expires_at AND lock.blockhash=NEW.blockhash
      AND lock.last_valid_block_height=NEW.last_valid_block_height
      AND armament.payload_version=2 AND armament.state='LOCKED'
      AND armament.state_revision=1 AND armament.consumed_buys=1
      AND armament.generation_id=NEW.generation_id
      AND armament.locked_intent_id=NEW.intent_id
      AND armament.locked_attempt_number=NEW.attempt_number
      AND armament.locked_reservation_id=NEW.reservation_id
      AND armament.locked_lease_token=lock.lease_token) INTO lock_valid;
  IF NOT lock_valid THEN
    RAISE EXCEPTION 'BUY signed transaction requires exact authorized pre-signature lock'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION guard_execution_pre_signature_lock_signed_commit()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.state='SIGNED_PERSISTED' AND NOT EXISTS (
    SELECT 1 FROM execution_signed_transactions artifact
    WHERE artifact.pre_signature_lock_id=NEW.lock_id
      AND artifact.intent_id=NEW.intent_id AND artifact.attempt_number=NEW.attempt_number
      AND artifact.armament_id=NEW.armament_id AND artifact.reservation_id=NEW.reservation_id
      AND artifact.generation_id=NEW.generation_id AND artifact.side='BUY'
      AND artifact.wallet_public_key=NEW.wallet_public_key
      AND artifact.provider_id=NEW.provider_id AND artifact.message_hash=NEW.message_hash
      AND artifact.snapshot_fingerprint=NEW.market_snapshot_fingerprint
      AND artifact.quote_fingerprint=NEW.quote_fingerprint
      AND artifact.quote_observed_at=NEW.quote_observed_at
      AND artifact.quote_expires_at=NEW.quote_expires_at
      AND artifact.blockhash=NEW.blockhash
      AND artifact.last_valid_block_height=NEW.last_valid_block_height
  ) THEN
    RAISE EXCEPTION 'signed pre-signature lock requires exact persisted BUY artifact'
      USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END
$function$;
