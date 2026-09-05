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

-- Child writes lock the parent row. This closes the race between a worker
-- insert/update and the false -> true live promotion without copying state to
-- any child table.
CREATE OR REPLACE FUNCTION execution_worker_child_parent_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog, public
AS $function$
DECLARE
  worker_role_oid OID;
  session_is_superuser BOOLEAN;
  worker_session BOOLEAN;
BEGIN
  SELECT role.oid INTO worker_role_oid
  FROM pg_catalog.pg_roles role
  WHERE role.rolname='sol_token_executor_worker';

  SELECT role.rolsuper INTO session_is_superuser
  FROM pg_catalog.pg_roles role
  WHERE role.rolname=session_user;

  worker_session := NOT COALESCE(session_is_superuser,FALSE)
    AND worker_role_oid IS NOT NULL
    AND pg_catalog.pg_has_role(session_user,worker_role_oid,'MEMBER');

  IF worker_session THEN
    PERFORM intent.id
    FROM public.execution_intents intent
    WHERE intent.id=NEW.intent_id AND NOT intent.live_reserved
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'worker child write violates the live_reserved partition'
        USING ERRCODE='42501';
    END IF;
  ELSE
    -- Let the existing foreign key report a missing parent. Authorized
    -- administrative and live writers otherwise serialize on the same row.
    PERFORM intent.id
    FROM public.execution_intents intent
    WHERE intent.id=NEW.intent_id
    FOR UPDATE;
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
CREATE POLICY execution_intents_worker_partition ON execution_intents
AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  NOT COALESCE((
    SELECT NOT session_role.rolsuper
      AND pg_catalog.pg_has_role(session_role.oid,role.oid,'MEMBER')
    FROM pg_catalog.pg_roles role
    JOIN pg_catalog.pg_roles session_role ON session_role.rolname=session_user
    WHERE role.rolname='sol_token_executor_worker'
  ),FALSE)
  OR NOT live_reserved
)
WITH CHECK (
  NOT COALESCE((
    SELECT NOT session_role.rolsuper
      AND pg_catalog.pg_has_role(session_role.oid,role.oid,'MEMBER')
    FROM pg_catalog.pg_roles role
    JOIN pg_catalog.pg_roles session_role ON session_role.rolname=session_user
    WHERE role.rolname='sol_token_executor_worker'
  ),FALSE)
  OR NOT live_reserved
);

DROP POLICY IF EXISTS execution_dry_run_assessments_normal_access
  ON execution_dry_run_assessments;
CREATE POLICY execution_dry_run_assessments_normal_access
ON execution_dry_run_assessments
AS PERMISSIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS execution_dry_run_assessments_worker_partition
  ON execution_dry_run_assessments;
CREATE POLICY execution_dry_run_assessments_worker_partition
ON execution_dry_run_assessments
AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  NOT COALESCE((
    SELECT NOT session_role.rolsuper
      AND pg_catalog.pg_has_role(session_role.oid,role.oid,'MEMBER')
    FROM pg_catalog.pg_roles role
    JOIN pg_catalog.pg_roles session_role ON session_role.rolname=session_user
    WHERE role.rolname='sol_token_executor_worker'
  ),FALSE)
  OR EXISTS (
    SELECT 1 FROM public.execution_intents parent
    WHERE parent.id=execution_dry_run_assessments.intent_id
  )
)
WITH CHECK (
  NOT COALESCE((
    SELECT NOT session_role.rolsuper
      AND pg_catalog.pg_has_role(session_role.oid,role.oid,'MEMBER')
    FROM pg_catalog.pg_roles role
    JOIN pg_catalog.pg_roles session_role ON session_role.rolname=session_user
    WHERE role.rolname='sol_token_executor_worker'
  ),FALSE)
  OR EXISTS (
    SELECT 1 FROM public.execution_intents parent
    WHERE parent.id=execution_dry_run_assessments.intent_id
  )
);

DROP POLICY IF EXISTS execution_attempts_normal_access ON execution_attempts;
CREATE POLICY execution_attempts_normal_access ON execution_attempts
AS PERMISSIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS execution_attempts_worker_partition ON execution_attempts;
CREATE POLICY execution_attempts_worker_partition ON execution_attempts
AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  NOT COALESCE((
    SELECT NOT session_role.rolsuper
      AND pg_catalog.pg_has_role(session_role.oid,role.oid,'MEMBER')
    FROM pg_catalog.pg_roles role
    JOIN pg_catalog.pg_roles session_role ON session_role.rolname=session_user
    WHERE role.rolname='sol_token_executor_worker'
  ),FALSE)
  OR EXISTS (
    SELECT 1 FROM public.execution_intents parent
    WHERE parent.id=execution_attempts.intent_id
  )
)
WITH CHECK (
  NOT COALESCE((
    SELECT NOT session_role.rolsuper
      AND pg_catalog.pg_has_role(session_role.oid,role.oid,'MEMBER')
    FROM pg_catalog.pg_roles role
    JOIN pg_catalog.pg_roles session_role ON session_role.rolname=session_user
    WHERE role.rolname='sol_token_executor_worker'
  ),FALSE)
  OR EXISTS (
    SELECT 1 FROM public.execution_intents parent
    WHERE parent.id=execution_attempts.intent_id
  )
);

DROP POLICY IF EXISTS execution_intent_transitions_normal_access
  ON execution_intent_transitions;
CREATE POLICY execution_intent_transitions_normal_access
ON execution_intent_transitions
AS PERMISSIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS execution_intent_transitions_worker_partition
  ON execution_intent_transitions;
CREATE POLICY execution_intent_transitions_worker_partition
ON execution_intent_transitions
AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  NOT COALESCE((
    SELECT NOT session_role.rolsuper
      AND pg_catalog.pg_has_role(session_role.oid,role.oid,'MEMBER')
    FROM pg_catalog.pg_roles role
    JOIN pg_catalog.pg_roles session_role ON session_role.rolname=session_user
    WHERE role.rolname='sol_token_executor_worker'
  ),FALSE)
  OR EXISTS (
    SELECT 1 FROM public.execution_intents parent
    WHERE parent.id=execution_intent_transitions.intent_id
  )
)
WITH CHECK (
  NOT COALESCE((
    SELECT NOT session_role.rolsuper
      AND pg_catalog.pg_has_role(session_role.oid,role.oid,'MEMBER')
    FROM pg_catalog.pg_roles role
    JOIN pg_catalog.pg_roles session_role ON session_role.rolname=session_user
    WHERE role.rolname='sol_token_executor_worker'
  ),FALSE)
  OR EXISTS (
    SELECT 1 FROM public.execution_intents parent
    WHERE parent.id=execution_intent_transitions.intent_id
  )
);

DROP POLICY IF EXISTS execution_simulation_artifacts_normal_access
  ON execution_simulation_artifacts;
CREATE POLICY execution_simulation_artifacts_normal_access
ON execution_simulation_artifacts
AS PERMISSIVE FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS execution_simulation_artifacts_worker_partition
  ON execution_simulation_artifacts;
CREATE POLICY execution_simulation_artifacts_worker_partition
ON execution_simulation_artifacts
AS RESTRICTIVE FOR ALL TO PUBLIC
USING (
  NOT COALESCE((
    SELECT NOT session_role.rolsuper
      AND pg_catalog.pg_has_role(session_role.oid,role.oid,'MEMBER')
    FROM pg_catalog.pg_roles role
    JOIN pg_catalog.pg_roles session_role ON session_role.rolname=session_user
    WHERE role.rolname='sol_token_executor_worker'
  ),FALSE)
  OR EXISTS (
    SELECT 1 FROM public.execution_intents parent
    WHERE parent.id=execution_simulation_artifacts.intent_id
  )
)
WITH CHECK (
  NOT COALESCE((
    SELECT NOT session_role.rolsuper
      AND pg_catalog.pg_has_role(session_role.oid,role.oid,'MEMBER')
    FROM pg_catalog.pg_roles role
    JOIN pg_catalog.pg_roles session_role ON session_role.rolname=session_user
    WHERE role.rolname='sol_token_executor_worker'
  ),FALSE)
  OR EXISTS (
    SELECT 1 FROM public.execution_intents parent
    WHERE parent.id=execution_simulation_artifacts.intent_id
  )
);
