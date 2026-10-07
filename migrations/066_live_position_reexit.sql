-- Lot 4b re-exit: a position stuck EXIT_PENDING behind a dead SELL intent (FAILED or EXPIRED,
-- no send possible) may have its exit_intent_id replaced by a new PENDING SELL intent, at most
-- three times per position. guard_execution_live_position_update is the 036 body verbatim,
-- except that the transition check gains one EXIT_PENDING -> EXIT_PENDING branch. Every other
-- transition still goes through execution_live_state_transition_allowed, which is unchanged,
-- and may no longer change exit_intent_id except on the first exit (OPEN -> EXIT_PENDING).
-- Each condition is written with IS NULL / IS DISTINCT FROM / EXISTS so that a NULL rejects.

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
  IF OLD.state='EXIT_PENDING' AND NEW.state='EXIT_PENDING' THEN
    -- Lot 4b re-exit: replace a dead exit intent, nothing else.
    IF OLD.exit_intent_id IS NULL OR NEW.exit_intent_id IS NULL
      OR NOT (OLD.remaining_base_raw > 0)
      OR NEW.exit_intent_id IS NOT DISTINCT FROM OLD.exit_intent_id
      OR NEW.remaining_base_raw IS DISTINCT FROM OLD.remaining_base_raw
      OR OLD.exit_reconciliation_fingerprint IS NOT NULL
      OR NEW.exit_reconciliation_fingerprint IS NOT NULL
      OR NEW.closed_at IS NOT NULL OR NEW.purge_after IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM execution_intents old_exit
        WHERE old_exit.id=OLD.exit_intent_id AND old_exit.status IN ('FAILED','EXPIRED')
          AND old_exit.side='SELL' AND old_exit.position_id=OLD.position_id
          AND old_exit.terminal_at IS NOT NULL AND old_exit.reconciliation_completed_at IS NOT NULL
          AND old_exit.terminal_at <= statement_timestamp() - INTERVAL '30 seconds')
      OR NOT EXISTS (SELECT 1 FROM execution_intents new_exit
        WHERE new_exit.id=NEW.exit_intent_id AND new_exit.side='SELL'
          AND new_exit.position_id=NEW.position_id AND new_exit.status='PENDING'
          AND new_exit.live_reserved=TRUE
          AND new_exit.base_amount_raw=NEW.remaining_base_raw
          AND new_exit.minimum_amount_out_raw=1)
      OR NOT EXISTS (SELECT 1 FROM execution_intents old_exit
        JOIN execution_intents new_exit ON new_exit.id=NEW.exit_intent_id
        WHERE old_exit.id=OLD.exit_intent_id
          AND new_exit.strategy_id=old_exit.strategy_id
          AND new_exit.strategy_version=old_exit.strategy_version
          AND new_exit.mint=old_exit.mint AND new_exit.quote_mint=old_exit.quote_mint
          AND new_exit.venue_policy=old_exit.venue_policy
          AND old_exit.logical_command_id ~ ('^(?:maximum-holding|fast-exit:[A-Z_]+):'
            || 'execution_live_position_[0-9a-f]{64}(?::retry-[12])?$')
          AND right(regexp_replace(old_exit.logical_command_id, ':retry-[12]$', ''),
            length(OLD.position_id) + 1)=':' || OLD.position_id
          AND new_exit.logical_command_id=
            regexp_replace(old_exit.logical_command_id, ':retry-[12]$', '')
            || ':retry-' || (COALESCE(substring(old_exit.logical_command_id
              FROM ':retry-([12])$')::INTEGER, 0) + 1)::TEXT)
      OR EXISTS (SELECT 1 FROM execution_signed_transactions artifact
        WHERE artifact.intent_id=OLD.exit_intent_id
          AND artifact.state NOT IN ('RECONCILED','REVOKED_NO_SEND'))
      OR EXISTS (SELECT 1 FROM execution_reconciliation_evidence evidence
        WHERE evidence.intent_id=OLD.exit_intent_id
          AND (evidence.result='MATCHED' OR (evidence.result IN ('UNKNOWN','MISMATCH')
            AND evidence.resolved_by_evidence_id IS NULL)))
      OR NOT EXISTS (SELECT 1 FROM execution_exit_authorizations exit_auth
        WHERE exit_auth.position_id=NEW.position_id AND exit_auth.state='ACTIVE')
      OR NOT EXISTS (SELECT 1 FROM execution_wallet_risk_state risk
        WHERE risk.generation_id=NEW.generation_id AND risk.unknown_block=FALSE)
    THEN
      RAISE EXCEPTION 'execution live position re-exit is not permitted' USING ERRCODE='55000';
    END IF;
  ELSIF NOT execution_live_state_transition_allowed('LIVE_POSITION',OLD.state,NEW.state) THEN
    RAISE EXCEPTION 'illegal execution live position state transition' USING ERRCODE='55000';
  ELSIF NEW.exit_intent_id IS DISTINCT FROM OLD.exit_intent_id
    AND NOT (OLD.state='OPEN' AND OLD.exit_intent_id IS NULL AND NEW.state='EXIT_PENDING') THEN
    -- Outside the re-exit branch, exit_intent_id is only ever set by the first exit.
    RAISE EXCEPTION 'execution live position exit intent is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_live_positions_guarded_update ON execution_live_positions;
CREATE TRIGGER execution_live_positions_guarded_update
  BEFORE UPDATE ON execution_live_positions
  FOR EACH ROW EXECUTE FUNCTION guard_execution_live_position_update();
