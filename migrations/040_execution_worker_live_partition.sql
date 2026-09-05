DO $live_reserved_shape$
DECLARE
  column_type OID;
  column_not_null BOOLEAN;
  column_default TEXT;
BEGIN
  SELECT attribute.atttypid,attribute.attnotnull,
    pg_catalog.pg_get_expr(default_value.adbin,default_value.adrelid)
  INTO column_type,column_not_null,column_default
  FROM pg_catalog.pg_attribute attribute
  LEFT JOIN pg_catalog.pg_attrdef default_value
    ON default_value.adrelid=attribute.attrelid
      AND default_value.adnum=attribute.attnum
  WHERE attribute.attrelid='execution_intents'::pg_catalog.regclass
    AND attribute.attname='live_reserved'
    AND attribute.attnum>0
    AND NOT attribute.attisdropped;

  IF FOUND AND (
    column_type<>'pg_catalog.bool'::pg_catalog.regtype
    OR NOT column_not_null
    OR column_default IS DISTINCT FROM 'false'
  ) THEN
    RAISE EXCEPTION 'execution_intents.live_reserved has a malformed schema; expected BOOLEAN NOT NULL DEFAULT FALSE'
      USING ERRCODE='55000';
  END IF;
END
$live_reserved_shape$;

ALTER TABLE execution_intents
  ADD COLUMN IF NOT EXISTS live_reserved BOOLEAN NOT NULL DEFAULT FALSE;

-- Preserve every historical route that can already bind an intent to live
-- execution. The parent marker remains the sole source of truth.
WITH live_intent_roots(intent_id) AS (
  SELECT target_intent_id FROM execution_activation_armaments
    WHERE target_intent_id IS NOT NULL
  UNION
  SELECT locked_intent_id FROM execution_activation_armaments
    WHERE locked_intent_id IS NOT NULL
  UNION
  SELECT intent_id FROM execution_pre_signature_locks
  UNION
  SELECT intent_id FROM execution_signed_transactions
  UNION
  SELECT buy_intent_id FROM execution_live_positions
  UNION
  SELECT exit_intent_id FROM execution_live_positions
    WHERE exit_intent_id IS NOT NULL
  UNION
  SELECT locked_intent_id FROM execution_exit_authorizations
    WHERE locked_intent_id IS NOT NULL
)
UPDATE execution_intents intent
SET live_reserved=TRUE
FROM live_intent_roots root
WHERE intent.id=root.intent_id AND NOT intent.live_reserved;

CREATE OR REPLACE FUNCTION execution_intents_live_reserved_monotone_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path=pg_catalog, public
AS $function$
BEGIN
  IF OLD.live_reserved AND NOT NEW.live_reserved THEN
    RAISE EXCEPTION 'execution intent live_reserved is monotone'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION
  execution_intents_live_reserved_monotone_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS execution_intents_live_reserved_monotone
  ON execution_intents;
CREATE TRIGGER execution_intents_live_reserved_monotone
BEFORE UPDATE OF live_reserved ON execution_intents
FOR EACH ROW EXECUTE FUNCTION execution_intents_live_reserved_monotone_guard();

-- Child writes lock the parent row visible to the invoker. Worker RLS hides a
-- live parent, while owners and administrative roles keep their normal view.
-- This closes the race between a worker child write and false -> true live
-- promotion without copying state to any child table or inferring session
-- identity in a SECURITY DEFINER function.
CREATE OR REPLACE FUNCTION execution_worker_child_parent_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog, public
AS $function$
DECLARE
  parent_id TEXT;
BEGIN
  EXECUTE pg_catalog.format(
    'SELECT intent.id FROM %I.execution_intents intent WHERE intent.id=$1 FOR UPDATE',
    TG_TABLE_SCHEMA
  )
  INTO parent_id
  USING NEW.intent_id;

  IF parent_id IS NULL THEN
    RAISE EXCEPTION 'worker child write violates the live_reserved partition'
      USING ERRCODE='42501';
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION
  execution_worker_child_parent_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS execution_dry_run_assessments_parent_guard
  ON execution_dry_run_assessments;
CREATE TRIGGER execution_dry_run_assessments_parent_guard
BEFORE INSERT OR UPDATE ON execution_dry_run_assessments
FOR EACH ROW EXECUTE FUNCTION execution_worker_child_parent_guard();

DROP TRIGGER IF EXISTS execution_attempts_parent_guard ON execution_attempts;
CREATE TRIGGER execution_attempts_parent_guard
BEFORE INSERT OR UPDATE ON execution_attempts
FOR EACH ROW EXECUTE FUNCTION execution_worker_child_parent_guard();

DROP TRIGGER IF EXISTS execution_intent_transitions_parent_guard
  ON execution_intent_transitions;
CREATE TRIGGER execution_intent_transitions_parent_guard
BEFORE INSERT OR UPDATE ON execution_intent_transitions
FOR EACH ROW EXECUTE FUNCTION execution_worker_child_parent_guard();

DROP TRIGGER IF EXISTS execution_simulation_artifacts_parent_guard
  ON execution_simulation_artifacts;
CREATE TRIGGER execution_simulation_artifacts_parent_guard
BEFORE INSERT OR UPDATE ON execution_simulation_artifacts
FOR EACH ROW EXECUTE FUNCTION execution_worker_child_parent_guard();

ALTER TABLE execution_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_dry_run_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_intent_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_simulation_artifacts ENABLE ROW LEVEL SECURITY;

-- PostgreSQL requires at least one permissive policy. This policy grants no
-- SQL privilege; it preserves the existing ACL behavior for ordinary roles.
DROP POLICY IF EXISTS execution_intents_normal_access ON execution_intents;
CREATE POLICY execution_intents_normal_access ON execution_intents
AS PERMISSIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS execution_intents_worker_partition ON execution_intents;

DROP POLICY IF EXISTS execution_dry_run_assessments_normal_access
  ON execution_dry_run_assessments;
CREATE POLICY execution_dry_run_assessments_normal_access
ON execution_dry_run_assessments
AS PERMISSIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS execution_dry_run_assessments_worker_partition
  ON execution_dry_run_assessments;

DROP POLICY IF EXISTS execution_attempts_normal_access ON execution_attempts;
CREATE POLICY execution_attempts_normal_access ON execution_attempts
AS PERMISSIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS execution_attempts_worker_partition ON execution_attempts;

DROP POLICY IF EXISTS execution_intent_transitions_normal_access
  ON execution_intent_transitions;
CREATE POLICY execution_intent_transitions_normal_access
ON execution_intent_transitions
AS PERMISSIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS execution_intent_transitions_worker_partition
  ON execution_intent_transitions;

DROP POLICY IF EXISTS execution_simulation_artifacts_normal_access
  ON execution_simulation_artifacts;
CREATE POLICY execution_simulation_artifacts_normal_access
ON execution_simulation_artifacts
AS PERMISSIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS execution_simulation_artifacts_worker_partition
  ON execution_simulation_artifacts;

-- Policy role arrays store role OIDs. Install the restrictive policies only
-- when the deployment role already exists; otherwise role provisioning below
-- installs the same policies immediately after creating the role.
DO $worker_partition_policies$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname='sol_token_executor_worker'
  ) THEN
    EXECUTE 'CREATE POLICY execution_intents_worker_partition ON execution_intents '
      'AS RESTRICTIVE FOR ALL TO sol_token_executor_worker '
      'USING (NOT live_reserved) WITH CHECK (NOT live_reserved)';
    EXECUTE 'CREATE POLICY execution_dry_run_assessments_worker_partition '
      'ON execution_dry_run_assessments AS RESTRICTIVE FOR ALL '
      'TO sol_token_executor_worker USING (EXISTS (SELECT 1 '
      'FROM execution_intents parent '
      'WHERE parent.id=execution_dry_run_assessments.intent_id)) '
      'WITH CHECK (EXISTS (SELECT 1 FROM execution_intents parent '
      'WHERE parent.id=execution_dry_run_assessments.intent_id))';
    EXECUTE 'CREATE POLICY execution_attempts_worker_partition '
      'ON execution_attempts AS RESTRICTIVE FOR ALL '
      'TO sol_token_executor_worker USING (EXISTS (SELECT 1 '
      'FROM execution_intents parent '
      'WHERE parent.id=execution_attempts.intent_id)) '
      'WITH CHECK (EXISTS (SELECT 1 FROM execution_intents parent '
      'WHERE parent.id=execution_attempts.intent_id))';
    EXECUTE 'CREATE POLICY execution_intent_transitions_worker_partition '
      'ON execution_intent_transitions AS RESTRICTIVE FOR ALL '
      'TO sol_token_executor_worker USING (EXISTS (SELECT 1 '
      'FROM execution_intents parent '
      'WHERE parent.id=execution_intent_transitions.intent_id)) '
      'WITH CHECK (EXISTS (SELECT 1 FROM execution_intents parent '
      'WHERE parent.id=execution_intent_transitions.intent_id))';
    EXECUTE 'CREATE POLICY execution_simulation_artifacts_worker_partition '
      'ON execution_simulation_artifacts AS RESTRICTIVE FOR ALL '
      'TO sol_token_executor_worker USING (EXISTS (SELECT 1 '
      'FROM execution_intents parent '
      'WHERE parent.id=execution_simulation_artifacts.intent_id)) '
      'WITH CHECK (EXISTS (SELECT 1 FROM execution_intents parent '
      'WHERE parent.id=execution_simulation_artifacts.intent_id))';
  ELSE
    -- Keep a restrictive, behavior-neutral placeholder so the migration is
    -- replayable before deployment roles exist. Provisioning replaces these
    -- policies with policies bound directly to the worker role OID.
    CREATE POLICY execution_intents_worker_partition ON execution_intents
      AS RESTRICTIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE);
    CREATE POLICY execution_dry_run_assessments_worker_partition
      ON execution_dry_run_assessments
      AS RESTRICTIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE);
    CREATE POLICY execution_attempts_worker_partition ON execution_attempts
      AS RESTRICTIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE);
    CREATE POLICY execution_intent_transitions_worker_partition
      ON execution_intent_transitions
      AS RESTRICTIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE);
    CREATE POLICY execution_simulation_artifacts_worker_partition
      ON execution_simulation_artifacts
      AS RESTRICTIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE);
  END IF;
END
$worker_partition_policies$;
