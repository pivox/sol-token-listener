ALTER TABLE processing_checkpoint_rebase_gaps
  ADD COLUMN evidence JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE processing_checkpoint_rebase_gaps
  DROP CONSTRAINT processing_checkpoint_rebase_gaps_reason_check,
  DROP CONSTRAINT processing_checkpoint_rebase_gaps_check;

ALTER TABLE processing_checkpoint_rebase_gaps
  ADD CONSTRAINT processing_checkpoint_rebase_gaps_reason_check
    CHECK (reason IN ('invalid-future-checkpoint', 'operator-approved-live-edge-cutover')),
  ADD CONSTRAINT processing_checkpoint_rebase_gaps_validity_check
    CHECK (
      (reason = 'invalid-future-checkpoint'
        AND previous_slot > finalized_head_slot
        AND new_slot <= finalized_head_slot)
      OR
      (reason = 'operator-approved-live-edge-cutover'
        AND previous_slot < new_slot
        AND new_slot <= finalized_head_slot)
    );

COMMENT ON COLUMN processing_checkpoint_rebase_gaps.evidence IS
  'Versioned scan frontier, bounds, and window-exhaustion evidence for operator-approved cutovers.';
