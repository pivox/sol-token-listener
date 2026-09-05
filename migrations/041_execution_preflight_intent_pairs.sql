CREATE TABLE IF NOT EXISTS execution_preflight_intent_pairs (
  pair_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  pair_fingerprint TEXT NOT NULL UNIQUE,
  target_intent_id TEXT NOT NULL REFERENCES execution_intents(id) ON DELETE RESTRICT,
  simulation_intent_id TEXT NOT NULL REFERENCES execution_intents(id) ON DELETE RESTRICT,
  decision_event_id TEXT NOT NULL,
  decision_fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
    DEFAULT date_trunc('milliseconds', statement_timestamp()),
  expires_at TIMESTAMPTZ NOT NULL,
  purge_after TIMESTAMPTZ NOT NULL,
  CONSTRAINT execution_preflight_intent_pairs_payload_version_check
    CHECK (payload_version = 1),
  CONSTRAINT execution_preflight_intent_pairs_distinct_parents_check
    CHECK (target_intent_id <> simulation_intent_id),
  CONSTRAINT execution_preflight_intent_pairs_text_check CHECK (
    octet_length(pair_id) BETWEEN 1 AND 256
    AND octet_length(target_intent_id) BETWEEN 1 AND 256
    AND octet_length(simulation_intent_id) BETWEEN 1 AND 256
    AND octet_length(decision_event_id) BETWEEN 1 AND 256
  ),
  CONSTRAINT execution_preflight_intent_pairs_fingerprint_check CHECK (
    pair_fingerprint ~ '^[0-9a-f]{64}$'
    AND decision_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT execution_preflight_intent_pairs_temporal_check CHECK (
    isfinite(created_at)
    AND created_at >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
    AND created_at <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds', created_at) = created_at
    AND isfinite(expires_at)
    AND expires_at >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
    AND expires_at <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds', expires_at) = expires_at
    AND isfinite(purge_after)
    AND purge_after >= TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
    AND purge_after <= TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds', purge_after) = purge_after
  )
);

CREATE TABLE IF NOT EXISTS execution_preflight_intent_pair_memberships (
  pair_id TEXT NOT NULL REFERENCES execution_preflight_intent_pairs(pair_id)
    ON DELETE RESTRICT,
  intent_id TEXT NOT NULL REFERENCES execution_intents(id) ON DELETE RESTRICT,
  lane TEXT NOT NULL,
  PRIMARY KEY (pair_id, lane),
  UNIQUE (intent_id),
  UNIQUE (pair_id, intent_id),
  CONSTRAINT execution_preflight_intent_pair_memberships_lane_check
    CHECK (lane IN ('TARGET', 'SIMULATION'))
);

CREATE OR REPLACE FUNCTION guard_execution_preflight_intent_pair_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog
AS $function$
DECLARE
  parent_count INTEGER;
  target_parent RECORD;
  simulation_parent RECORD;
BEGIN
  NEW.purge_after := NEW.expires_at + INTERVAL '4 hours';

  EXECUTE pg_catalog.format(
    'SELECT count(*)::INTEGER FROM (SELECT id FROM %I.execution_intents '
      'WHERE id = ANY($1::TEXT[]) ORDER BY id FOR UPDATE) locked_parents',
    TG_TABLE_SCHEMA
  ) INTO parent_count USING ARRAY[NEW.target_intent_id, NEW.simulation_intent_id];

  IF parent_count <> 2 THEN
    RAISE EXCEPTION 'execution preflight intent pair requires two distinct parents'
      USING ERRCODE='23503';
  END IF;

  EXECUTE pg_catalog.format(
    'SELECT * FROM %I.execution_intents WHERE id=$1', TG_TABLE_SCHEMA
  ) INTO target_parent USING NEW.target_intent_id;
  EXECUTE pg_catalog.format(
    'SELECT * FROM %I.execution_intents WHERE id=$1', TG_TABLE_SCHEMA
  ) INTO simulation_parent USING NEW.simulation_intent_id;

  IF target_parent.status <> 'PENDING'
    OR target_parent.attempt_count <> 0
    OR target_parent.state_revision <> 0
    OR target_parent.lease_owner IS NOT NULL
    OR target_parent.lease_token IS NOT NULL
    OR target_parent.lease_expires_at IS NOT NULL
    OR target_parent.last_reason_code IS NOT NULL
    OR target_parent.terminal_at IS NOT NULL
    OR target_parent.reconciliation_completed_at IS NOT NULL
    OR target_parent.purge_after IS NOT NULL
    OR target_parent.live_reserved
    OR simulation_parent.status <> 'PENDING'
    OR simulation_parent.attempt_count <> 0
    OR simulation_parent.state_revision <> 0
    OR simulation_parent.lease_owner IS NOT NULL
    OR simulation_parent.lease_token IS NOT NULL
    OR simulation_parent.lease_expires_at IS NOT NULL
    OR simulation_parent.last_reason_code IS NOT NULL
    OR simulation_parent.terminal_at IS NOT NULL
    OR simulation_parent.reconciliation_completed_at IS NOT NULL
    OR simulation_parent.purge_after IS NOT NULL
    OR simulation_parent.live_reserved
  THEN
    RAISE EXCEPTION 'execution preflight intent pair parents must be pristine'
      USING ERRCODE='55000';
  END IF;

  IF target_parent.side <> 'BUY'
    OR target_parent.strategy_id <> 'creation-entry-v1'
    OR target_parent.strategy_version <> 1
    OR target_parent.logical_command_id !~ '^paper_open_[a-f0-9]{64}$'
    OR target_parent.logical_order_key IS DISTINCT FROM target_parent.logical_command_id
    OR target_parent.venue_policy <> 'PUMP_FUN_ONLY'
    OR target_parent.quote_mint <> 'So11111111111111111111111111111111111111112'
    OR target_parent.quote_token_program <> 'SPL_TOKEN'
    OR target_parent.quote_decimals <> 9
    OR simulation_parent.side <> 'BUY'
    OR simulation_parent.strategy_id <> 'creation-entry-v1'
    OR simulation_parent.strategy_version <> 1
    OR simulation_parent.logical_command_id !~ '^execution_preflight_probe_[a-f0-9]{64}$'
    OR simulation_parent.logical_order_key IS DISTINCT FROM simulation_parent.logical_command_id
    OR simulation_parent.venue_policy <> 'PUMP_FUN_ONLY'
    OR simulation_parent.quote_mint <> 'So11111111111111111111111111111111111111112'
    OR simulation_parent.quote_token_program <> 'SPL_TOKEN'
    OR simulation_parent.quote_decimals <> 9
  THEN
    RAISE EXCEPTION 'execution preflight intent pair requires canonical target and probe lanes'
      USING ERRCODE='55000';
  END IF;

  IF target_parent.strategy_id IS DISTINCT FROM simulation_parent.strategy_id
    OR target_parent.strategy_version IS DISTINCT FROM simulation_parent.strategy_version
    OR target_parent.position_id IS DISTINCT FROM simulation_parent.position_id
    OR target_parent.mint IS DISTINCT FROM simulation_parent.mint
    OR target_parent.side IS DISTINCT FROM simulation_parent.side
    OR target_parent.venue_policy IS DISTINCT FROM simulation_parent.venue_policy
    OR target_parent.quote_mint IS DISTINCT FROM simulation_parent.quote_mint
    OR target_parent.quote_token_program IS DISTINCT FROM simulation_parent.quote_token_program
    OR target_parent.quote_decimals IS DISTINCT FROM simulation_parent.quote_decimals
    OR target_parent.quote_amount_raw IS DISTINCT FROM simulation_parent.quote_amount_raw
    OR target_parent.base_amount_raw IS DISTINCT FROM simulation_parent.base_amount_raw
    OR target_parent.minimum_amount_out_raw IS DISTINCT FROM simulation_parent.minimum_amount_out_raw
    OR target_parent.decision_event_id IS DISTINCT FROM simulation_parent.decision_event_id
    OR target_parent.decision_fingerprint IS DISTINCT FROM simulation_parent.decision_fingerprint
    OR target_parent.requested_at IS DISTINCT FROM simulation_parent.requested_at
    OR target_parent.expires_at IS DISTINCT FROM simulation_parent.expires_at
    OR NEW.decision_event_id IS DISTINCT FROM target_parent.decision_event_id
    OR NEW.decision_fingerprint IS DISTINCT FROM target_parent.decision_fingerprint
    OR NEW.expires_at IS DISTINCT FROM target_parent.expires_at
  THEN
    RAISE EXCEPTION 'execution preflight intent pair economic or causal tuple differs'
      USING ERRCODE='55000';
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION
  guard_execution_preflight_intent_pair_insert() FROM PUBLIC;

CREATE OR REPLACE FUNCTION populate_execution_preflight_intent_pair_memberships()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog
AS $function$
BEGIN
  EXECUTE pg_catalog.format(
    'INSERT INTO %I.execution_preflight_intent_pair_memberships '
      '(pair_id,intent_id,lane) VALUES ($1,$2,''TARGET''),($1,$3,''SIMULATION'')',
    TG_TABLE_SCHEMA
  ) USING NEW.pair_id, NEW.target_intent_id, NEW.simulation_intent_id;
  RETURN NEW;
END
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION
  populate_execution_preflight_intent_pair_memberships() FROM PUBLIC;

CREATE OR REPLACE FUNCTION guard_execution_preflight_intent_pair_membership_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog
AS $function$
DECLARE
  expected_intent_id TEXT;
BEGIN
  EXECUTE pg_catalog.format(
    'SELECT CASE $2 WHEN ''TARGET'' THEN target_intent_id '
      'WHEN ''SIMULATION'' THEN simulation_intent_id END '
      'FROM %I.execution_preflight_intent_pairs WHERE pair_id=$1',
    TG_TABLE_SCHEMA
  ) INTO expected_intent_id USING NEW.pair_id, NEW.lane;

  IF expected_intent_id IS NULL OR expected_intent_id IS DISTINCT FROM NEW.intent_id THEN
    RAISE EXCEPTION 'execution preflight intent pair membership does not match its lane'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION
  guard_execution_preflight_intent_pair_membership_insert() FROM PUBLIC;

CREATE OR REPLACE FUNCTION reject_execution_preflight_intent_pair_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'execution preflight intent pairs are append-only'
    USING ERRCODE='55000';
END
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION
  reject_execution_preflight_intent_pair_update() FROM PUBLIC;

CREATE OR REPLACE FUNCTION guard_execution_preflight_intent_pair_membership_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog
AS $function$
DECLARE
  purgeable BOOLEAN;
BEGIN
  EXECUTE pg_catalog.format(
    'SELECT pair.purge_after <= statement_timestamp() '
      'AND target.status IN (''SUCCEEDED'',''FAILED'',''EXPIRED'',''CANCELLED'') '
      'AND simulation.status IN (''SUCCEEDED'',''FAILED'',''EXPIRED'',''CANCELLED'') '
      'AND target.reconciliation_completed_at IS NOT NULL '
      'AND simulation.reconciliation_completed_at IS NOT NULL '
      'AND target.purge_after IS NOT NULL AND target.purge_after <= statement_timestamp() '
      'AND simulation.purge_after IS NOT NULL '
      'AND simulation.purge_after <= statement_timestamp() '
      'AND target.lease_owner IS NULL AND target.lease_token IS NULL '
      'AND target.lease_expires_at IS NULL AND simulation.lease_owner IS NULL '
      'AND simulation.lease_token IS NULL AND simulation.lease_expires_at IS NULL '
      'FROM %I.execution_preflight_intent_pairs pair '
      'JOIN %I.execution_intents target ON target.id=pair.target_intent_id '
      'JOIN %I.execution_intents simulation ON simulation.id=pair.simulation_intent_id '
      'WHERE pair.pair_id=$1 FOR UPDATE OF target,simulation',
    TG_TABLE_SCHEMA, TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
  ) INTO purgeable USING OLD.pair_id;

  IF purgeable IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'execution preflight intent pair retention is not eligible'
      USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION
  guard_execution_preflight_intent_pair_membership_delete() FROM PUBLIC;

CREATE OR REPLACE FUNCTION guard_execution_preflight_intent_pair_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog
AS $function$
DECLARE
  purgeable BOOLEAN;
BEGIN
  EXECUTE pg_catalog.format(
    'SELECT pair.purge_after <= statement_timestamp() '
      'AND target.status IN (''SUCCEEDED'',''FAILED'',''EXPIRED'',''CANCELLED'') '
      'AND simulation.status IN (''SUCCEEDED'',''FAILED'',''EXPIRED'',''CANCELLED'') '
      'AND target.reconciliation_completed_at IS NOT NULL '
      'AND simulation.reconciliation_completed_at IS NOT NULL '
      'AND target.purge_after IS NOT NULL AND target.purge_after <= statement_timestamp() '
      'AND simulation.purge_after IS NOT NULL '
      'AND simulation.purge_after <= statement_timestamp() '
      'AND target.lease_owner IS NULL AND target.lease_token IS NULL '
      'AND target.lease_expires_at IS NULL AND simulation.lease_owner IS NULL '
      'AND simulation.lease_token IS NULL AND simulation.lease_expires_at IS NULL '
      'AND NOT EXISTS (SELECT 1 FROM %I.execution_preflight_intent_pair_memberships member '
        'WHERE member.pair_id=pair.pair_id) '
      'FROM %I.execution_preflight_intent_pairs pair '
      'JOIN %I.execution_intents target ON target.id=pair.target_intent_id '
      'JOIN %I.execution_intents simulation ON simulation.id=pair.simulation_intent_id '
      'WHERE pair.pair_id=$1 FOR UPDATE OF target,simulation',
    TG_TABLE_SCHEMA, TG_TABLE_SCHEMA, TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
  ) INTO purgeable USING OLD.pair_id;

  IF purgeable IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'execution preflight intent pair retention is not eligible or memberships remain'
      USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION
  guard_execution_preflight_intent_pair_delete() FROM PUBLIC;

CREATE OR REPLACE FUNCTION require_execution_preflight_intent_pair_membership_completeness()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog
AS $function$
DECLARE
  complete BOOLEAN;
BEGIN
  EXECUTE pg_catalog.format(
    'SELECT NOT EXISTS (SELECT 1 FROM %I.execution_preflight_intent_pairs '
      'WHERE pair_id=$1) OR (SELECT count(*)=2 '
      'FROM %I.execution_preflight_intent_pair_memberships WHERE pair_id=$1)',
    TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
  ) INTO complete USING OLD.pair_id;
  IF complete IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'execution preflight intent pair memberships must be deleted atomically'
      USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION
  require_execution_preflight_intent_pair_membership_completeness() FROM PUBLIC;

DROP TRIGGER IF EXISTS execution_preflight_intent_pairs_insert_guard
  ON execution_preflight_intent_pairs;
CREATE TRIGGER execution_preflight_intent_pairs_insert_guard
BEFORE INSERT ON execution_preflight_intent_pairs
FOR EACH ROW EXECUTE FUNCTION guard_execution_preflight_intent_pair_insert();

DROP TRIGGER IF EXISTS execution_preflight_intent_pairs_populate_memberships
  ON execution_preflight_intent_pairs;
CREATE TRIGGER execution_preflight_intent_pairs_populate_memberships
AFTER INSERT ON execution_preflight_intent_pairs
FOR EACH ROW EXECUTE FUNCTION populate_execution_preflight_intent_pair_memberships();

DROP TRIGGER IF EXISTS execution_preflight_intent_pair_memberships_insert_guard
  ON execution_preflight_intent_pair_memberships;
CREATE TRIGGER execution_preflight_intent_pair_memberships_insert_guard
BEFORE INSERT ON execution_preflight_intent_pair_memberships
FOR EACH ROW EXECUTE FUNCTION guard_execution_preflight_intent_pair_membership_insert();

DROP TRIGGER IF EXISTS execution_preflight_intent_pairs_immutable
  ON execution_preflight_intent_pairs;
CREATE TRIGGER execution_preflight_intent_pairs_immutable
BEFORE UPDATE ON execution_preflight_intent_pairs
FOR EACH ROW EXECUTE FUNCTION reject_execution_preflight_intent_pair_update();

DROP TRIGGER IF EXISTS execution_preflight_intent_pairs_retention_guard
  ON execution_preflight_intent_pairs;
CREATE TRIGGER execution_preflight_intent_pairs_retention_guard
BEFORE DELETE ON execution_preflight_intent_pairs
FOR EACH ROW EXECUTE FUNCTION guard_execution_preflight_intent_pair_delete();

DROP TRIGGER IF EXISTS execution_preflight_intent_pair_memberships_immutable
  ON execution_preflight_intent_pair_memberships;
CREATE TRIGGER execution_preflight_intent_pair_memberships_immutable
BEFORE UPDATE ON execution_preflight_intent_pair_memberships
FOR EACH ROW EXECUTE FUNCTION reject_execution_preflight_intent_pair_update();

DROP TRIGGER IF EXISTS execution_preflight_intent_pair_memberships_retention_guard
  ON execution_preflight_intent_pair_memberships;
CREATE TRIGGER execution_preflight_intent_pair_memberships_retention_guard
BEFORE DELETE ON execution_preflight_intent_pair_memberships
FOR EACH ROW EXECUTE FUNCTION guard_execution_preflight_intent_pair_membership_delete();

DROP TRIGGER IF EXISTS execution_preflight_intent_pair_memberships_complete
  ON execution_preflight_intent_pair_memberships;
CREATE CONSTRAINT TRIGGER execution_preflight_intent_pair_memberships_complete
AFTER DELETE ON execution_preflight_intent_pair_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  require_execution_preflight_intent_pair_membership_completeness();
