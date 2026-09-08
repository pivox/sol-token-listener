CREATE TABLE IF NOT EXISTS execution_preflight_intent_preparation_runs (
  run_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  run_fingerprint TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'WAITING',
  state_revision BIGINT NOT NULL DEFAULT 0,
  watermark_at TIMESTAMPTZ NOT NULL
    DEFAULT date_trunc('milliseconds', statement_timestamp()),
  deadline_at TIMESTAMPTZ NOT NULL,
  pair_id TEXT REFERENCES execution_preflight_intent_pairs(pair_id)
    ON DELETE RESTRICT,
  lease_owner TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  assessment_id TEXT REFERENCES execution_dry_run_assessments(assessment_id)
    ON DELETE RESTRICT,
  assessment_fingerprint TEXT,
  artifact_id TEXT REFERENCES execution_simulation_artifacts(artifact_id)
    ON DELETE RESTRICT,
  artifact_fingerprint TEXT,
  manifest_fingerprint TEXT,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL
    DEFAULT date_trunc('milliseconds', statement_timestamp()),
  updated_at TIMESTAMPTZ NOT NULL
    DEFAULT date_trunc('milliseconds', statement_timestamp()),
  selected_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  CONSTRAINT execution_preflight_intent_preparation_runs_pair_id_key
    UNIQUE (pair_id),
  CONSTRAINT execution_preflight_intent_preparation_runs_payload_version_check
    CHECK (payload_version = 1),
  CONSTRAINT execution_preflight_intent_preparation_runs_state_check
    CHECK (state IN ('WAITING', 'PREPARING', 'PREPARED', 'FAILED')
      AND state_revision >= 0),
  CONSTRAINT execution_preflight_intent_preparation_runs_text_check CHECK (
    octet_length(run_id) BETWEEN 1 AND 256
    AND run_fingerprint ~ '^[0-9a-f]{64}$'
    AND (lease_owner IS NULL
      OR lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
    AND (failure_code IS NULL OR failure_code IN (
      'PREFLIGHT_PAIR_NOT_FOUND',
      'PREFLIGHT_PAIR_CONFLICT',
      'PREFLIGHT_PAIR_LINEAGE_INVALID',
      'PREFLIGHT_TARGET_NOT_PRISTINE',
      'PREFLIGHT_PROBE_NOT_PRISTINE',
      'PREFLIGHT_TARGET_FENCE_LOST',
      'PREFLIGHT_PREPARATION_LEASE_LOST',
      'PREFLIGHT_PREPARATION_DEADLINE_EXCEEDED',
      'PREFLIGHT_ASSESSMENT_INVALID',
      'PREFLIGHT_SIMULATION_FAILED',
      'PREFLIGHT_RECOVERY_CONFLICT',
      'PREFLIGHT_RPC_CAPACITY_UNVERIFIED',
      'PREFLIGHT_PREPARATION_EXPORT_FAILED'
    ))
  ),
  CONSTRAINT execution_preflight_intent_preparation_runs_fingerprint_check CHECK (
    (assessment_fingerprint IS NULL OR assessment_fingerprint ~ '^[0-9a-f]{64}$')
    AND (artifact_fingerprint IS NULL OR artifact_fingerprint ~ '^[0-9a-f]{64}$')
    AND (manifest_fingerprint IS NULL OR manifest_fingerprint ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT execution_preflight_intent_preparation_runs_temporal_check CHECK (
    isfinite(watermark_at)
    AND isfinite(deadline_at)
    AND isfinite(created_at)
    AND isfinite(updated_at)
    AND date_trunc('milliseconds', watermark_at) = watermark_at
    AND date_trunc('milliseconds', deadline_at) = deadline_at
    AND date_trunc('milliseconds', created_at) = created_at
    AND date_trunc('milliseconds', updated_at) = updated_at
    AND watermark_at = created_at
    AND updated_at >= created_at
    AND deadline_at > watermark_at + INTERVAL '5 seconds'
    AND deadline_at <= watermark_at + INTERVAL '5 minutes'
    AND (selected_at IS NULL OR (
      isfinite(selected_at)
      AND date_trunc('milliseconds', selected_at) = selected_at
      AND selected_at >= watermark_at
      AND selected_at < deadline_at
    ))
    AND (lease_expires_at IS NULL OR (
      isfinite(lease_expires_at)
      AND date_trunc('milliseconds', lease_expires_at) = lease_expires_at
      AND lease_expires_at > COALESCE(selected_at, watermark_at)
      AND lease_expires_at <= deadline_at - INTERVAL '5 seconds'
    ))
    AND (completed_at IS NULL OR (
      isfinite(completed_at)
      AND date_trunc('milliseconds', completed_at) = completed_at
      AND completed_at >= watermark_at
    ))
    AND (purge_after IS NULL OR (
      isfinite(purge_after)
      AND date_trunc('milliseconds', purge_after) = purge_after
      AND completed_at IS NOT NULL
      AND purge_after = completed_at + INTERVAL '4 hours'
    ))
  ),
  CONSTRAINT execution_preflight_intent_preparation_runs_shape_check CHECK (
    (state = 'WAITING'
      AND pair_id IS NULL
      AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND assessment_id IS NULL AND assessment_fingerprint IS NULL
      AND artifact_id IS NULL AND artifact_fingerprint IS NULL
      AND manifest_fingerprint IS NULL
      AND failure_code IS NULL AND selected_at IS NULL
      AND completed_at IS NULL AND purge_after IS NULL)
    OR (state = 'PREPARING'
      AND pair_id IS NOT NULL
      AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND failure_code IS NULL AND selected_at IS NOT NULL
      AND completed_at IS NULL AND purge_after IS NULL
      AND (assessment_id IS NULL) = (assessment_fingerprint IS NULL)
      AND (artifact_id IS NULL) = (artifact_fingerprint IS NULL)
      AND manifest_fingerprint IS NULL)
    OR (state = 'PREPARED'
      AND pair_id IS NOT NULL
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
      AND assessment_id IS NOT NULL AND assessment_fingerprint IS NOT NULL
      AND artifact_id IS NOT NULL AND artifact_fingerprint IS NOT NULL
      AND manifest_fingerprint IS NOT NULL
      AND failure_code IS NULL AND selected_at IS NOT NULL
      AND completed_at IS NOT NULL AND completed_at <= deadline_at - INTERVAL '5 seconds'
      AND purge_after IS NOT NULL)
    OR (state = 'FAILED'
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
      AND failure_code IS NOT NULL
      AND manifest_fingerprint IS NULL
      AND completed_at IS NOT NULL AND purge_after IS NOT NULL)
  )
);

DO $execution_preflight_intent_preparation_runs_shape$
DECLARE
  relation_oid OID;
  malformed_count INTEGER;
  primary_count INTEGER;
  unique_count INTEGER;
  foreign_count INTEGER;
  check_count INTEGER;
BEGIN
  SELECT relation.oid INTO relation_oid
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
  WHERE namespace.nspname=pg_catalog.current_schema()
    AND relation.relname='execution_preflight_intent_preparation_runs'
    AND relation.relkind='r';

  IF relation_oid IS NULL THEN
    RAISE EXCEPTION 'execution_preflight_intent_preparation_runs has a malformed schema'
      USING ERRCODE='55000';
  END IF;

  WITH expected(column_name,type_oid,not_null,has_default) AS (
    VALUES
      ('run_id','pg_catalog.text'::pg_catalog.regtype::OID,TRUE,FALSE),
      ('payload_version','pg_catalog.int2'::pg_catalog.regtype::OID,TRUE,TRUE),
      ('run_fingerprint','pg_catalog.text'::pg_catalog.regtype::OID,TRUE,FALSE),
      ('state','pg_catalog.text'::pg_catalog.regtype::OID,TRUE,TRUE),
      ('state_revision','pg_catalog.int8'::pg_catalog.regtype::OID,TRUE,TRUE),
      ('watermark_at','pg_catalog.timestamptz'::pg_catalog.regtype::OID,TRUE,TRUE),
      ('deadline_at','pg_catalog.timestamptz'::pg_catalog.regtype::OID,TRUE,FALSE),
      ('pair_id','pg_catalog.text'::pg_catalog.regtype::OID,FALSE,FALSE),
      ('lease_owner','pg_catalog.text'::pg_catalog.regtype::OID,FALSE,FALSE),
      ('lease_token','pg_catalog.uuid'::pg_catalog.regtype::OID,FALSE,FALSE),
      ('lease_expires_at','pg_catalog.timestamptz'::pg_catalog.regtype::OID,FALSE,FALSE),
      ('assessment_id','pg_catalog.text'::pg_catalog.regtype::OID,FALSE,FALSE),
      ('assessment_fingerprint','pg_catalog.text'::pg_catalog.regtype::OID,FALSE,FALSE),
      ('artifact_id','pg_catalog.text'::pg_catalog.regtype::OID,FALSE,FALSE),
      ('artifact_fingerprint','pg_catalog.text'::pg_catalog.regtype::OID,FALSE,FALSE),
      ('manifest_fingerprint','pg_catalog.text'::pg_catalog.regtype::OID,FALSE,FALSE),
      ('failure_code','pg_catalog.text'::pg_catalog.regtype::OID,FALSE,FALSE),
      ('created_at','pg_catalog.timestamptz'::pg_catalog.regtype::OID,TRUE,TRUE),
      ('updated_at','pg_catalog.timestamptz'::pg_catalog.regtype::OID,TRUE,TRUE),
      ('selected_at','pg_catalog.timestamptz'::pg_catalog.regtype::OID,FALSE,FALSE),
      ('completed_at','pg_catalog.timestamptz'::pg_catalog.regtype::OID,FALSE,FALSE),
      ('purge_after','pg_catalog.timestamptz'::pg_catalog.regtype::OID,FALSE,FALSE)
  )
  SELECT COUNT(*)::INTEGER INTO malformed_count
  FROM expected
  LEFT JOIN pg_catalog.pg_attribute attribute
    ON attribute.attrelid=relation_oid
      AND attribute.attname=expected.column_name
      AND attribute.attnum>0
      AND NOT attribute.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef default_value
    ON default_value.adrelid=attribute.attrelid
      AND default_value.adnum=attribute.attnum
  WHERE attribute.attname IS NULL
    OR attribute.atttypid<>expected.type_oid
    OR attribute.attnotnull IS DISTINCT FROM expected.not_null
    OR (default_value.oid IS NOT NULL) IS DISTINCT FROM expected.has_default;

  SELECT malformed_count + CASE WHEN COUNT(*)=22 THEN 0 ELSE 1 END
  INTO malformed_count
  FROM pg_catalog.pg_attribute attribute
  WHERE attribute.attrelid=relation_oid
    AND attribute.attnum>0
    AND NOT attribute.attisdropped;

  SELECT
    COUNT(*) FILTER (WHERE constraint_value.contype='p')::INTEGER,
    COUNT(*) FILTER (WHERE constraint_value.contype='u')::INTEGER,
    COUNT(*) FILTER (WHERE constraint_value.contype='f'
      AND constraint_value.confdeltype='r')::INTEGER,
    COUNT(*) FILTER (WHERE constraint_value.contype='c'
      AND constraint_value.convalidated)::INTEGER
  INTO primary_count,unique_count,foreign_count,check_count
  FROM pg_catalog.pg_constraint constraint_value
  WHERE constraint_value.conrelid=relation_oid;

  IF malformed_count<>0 OR primary_count<>1 OR unique_count<>2
    OR foreign_count<>3 OR check_count<>6 THEN
    RAISE EXCEPTION 'execution_preflight_intent_preparation_runs has a malformed schema'
      USING ERRCODE='55000';
  END IF;
END
$execution_preflight_intent_preparation_runs_shape$;

CREATE UNIQUE INDEX IF NOT EXISTS execution_preflight_intent_preparation_one_active_idx
ON execution_preflight_intent_preparation_runs ((TRUE))
WHERE state IN ('WAITING', 'PREPARING');

CREATE INDEX IF NOT EXISTS execution_preflight_intent_preparation_purge_idx
ON execution_preflight_intent_preparation_runs (purge_after, run_id)
WHERE purge_after IS NOT NULL;

CREATE INDEX IF NOT EXISTS execution_preflight_intent_pairs_preparation_selection_idx
ON execution_preflight_intent_pairs (created_at, pair_id);

CREATE OR REPLACE FUNCTION guard_execution_preflight_intent_preparation_run()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
DECLARE
  operation_at TIMESTAMPTZ := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.statement_timestamp()
  );
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := operation_at;
    NEW.watermark_at := operation_at;
    NEW.updated_at := operation_at;
    IF NEW.state <> 'WAITING' THEN
      RAISE EXCEPTION 'execution preflight preparation must start waiting'
        USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.run_id <> OLD.run_id
    OR NEW.payload_version <> OLD.payload_version
    OR NEW.run_fingerprint <> OLD.run_fingerprint
    OR NEW.watermark_at <> OLD.watermark_at
    OR NEW.deadline_at <> OLD.deadline_at
    OR NEW.created_at <> OLD.created_at
    OR (OLD.pair_id IS NOT NULL AND NEW.pair_id IS DISTINCT FROM OLD.pair_id)
    OR (OLD.assessment_id IS NOT NULL
      AND NEW.assessment_id IS DISTINCT FROM OLD.assessment_id)
    OR (OLD.assessment_fingerprint IS NOT NULL
      AND NEW.assessment_fingerprint IS DISTINCT FROM OLD.assessment_fingerprint)
    OR (OLD.artifact_id IS NOT NULL AND NEW.artifact_id IS DISTINCT FROM OLD.artifact_id)
    OR (OLD.artifact_fingerprint IS NOT NULL
      AND NEW.artifact_fingerprint IS DISTINCT FROM OLD.artifact_fingerprint)
    OR (OLD.manifest_fingerprint IS NOT NULL
      AND NEW.manifest_fingerprint IS DISTINCT FROM OLD.manifest_fingerprint) THEN
    RAISE EXCEPTION 'execution preflight preparation identity is immutable'
      USING ERRCODE='55000';
  END IF;

  IF NEW.state_revision <> OLD.state_revision + 1 THEN
    RAISE EXCEPTION 'execution preflight preparation revision conflict'
      USING ERRCODE='40001';
  END IF;
  NEW.updated_at := operation_at;

  IF OLD.state IN ('PREPARED', 'FAILED') THEN
    RAISE EXCEPTION 'execution preflight preparation terminal state is immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.state = 'WAITING' AND NEW.state NOT IN ('WAITING', 'PREPARING', 'FAILED') THEN
    RAISE EXCEPTION 'invalid execution preflight preparation transition'
      USING ERRCODE='55000';
  END IF;
  IF OLD.state = 'PREPARING' AND NEW.state NOT IN ('PREPARING', 'PREPARED', 'FAILED') THEN
    RAISE EXCEPTION 'invalid execution preflight preparation transition'
      USING ERRCODE='55000';
  END IF;

  IF OLD.state = 'WAITING' AND NEW.state = 'PREPARING' THEN
    NEW.selected_at := operation_at;
  ELSIF OLD.state = 'PREPARING' THEN
    NEW.selected_at := OLD.selected_at;
  END IF;

  IF NEW.state IN ('PREPARED', 'FAILED') THEN
    NEW.lease_owner := NULL;
    NEW.lease_token := NULL;
    NEW.lease_expires_at := NULL;
    NEW.completed_at := operation_at;
    NEW.purge_after := operation_at + INTERVAL '4 hours';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS execution_preflight_intent_preparation_run_guard
ON execution_preflight_intent_preparation_runs;
CREATE TRIGGER execution_preflight_intent_preparation_run_guard
BEFORE INSERT OR UPDATE ON execution_preflight_intent_preparation_runs
FOR EACH ROW EXECUTE FUNCTION guard_execution_preflight_intent_preparation_run();

REVOKE ALL ON FUNCTION guard_execution_preflight_intent_preparation_run() FROM PUBLIC;

CREATE OR REPLACE FUNCTION guard_execution_preflight_intent_preparation_run_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $function$
BEGIN
  IF OLD.state NOT IN ('PREPARED', 'FAILED')
    OR OLD.purge_after IS NULL
    OR OLD.purge_after > pg_catalog.statement_timestamp() THEN
    RAISE EXCEPTION 'execution preflight preparation retention is not eligible'
      USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END
$function$;

DROP TRIGGER IF EXISTS execution_preflight_intent_preparation_run_delete_guard
ON execution_preflight_intent_preparation_runs;
CREATE TRIGGER execution_preflight_intent_preparation_run_delete_guard
BEFORE DELETE ON execution_preflight_intent_preparation_runs
FOR EACH ROW EXECUTE FUNCTION guard_execution_preflight_intent_preparation_run_delete();

REVOKE ALL ON FUNCTION guard_execution_preflight_intent_preparation_run_delete() FROM PUBLIC;
