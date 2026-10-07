-- Lot 5a: the fast-entry probe intent (gate-10 bootstrap) is never live reserved.
-- Every arming path (CANARY v2/v3, envelope) promotes its target to live_reserved,
-- and every live claim (H2b BUY, recovery) requires it: this CHECK closes them all,
-- and unlike a trigger it also holds with session_replication_role=replica.
ALTER TABLE execution_intents
  DROP CONSTRAINT IF EXISTS execution_intents_probe_unarmable_check;
ALTER TABLE execution_intents
  ADD CONSTRAINT execution_intents_probe_unarmable_check
  CHECK (strategy_id <> 'fast-entry-probe-v1' OR live_reserved = FALSE);
