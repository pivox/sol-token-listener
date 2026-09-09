-- Durable, resumable strict catch-up runs. Keep the record free of RPC diagnostics.
DO $$
DECLARE run_table_oid OID; run_table_kind "char"; target_index_oid OID; target_index_kind "char";
BEGIN
  SELECT relation.oid,relation.relkind INTO run_table_oid,run_table_kind FROM pg_class relation
  JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
  WHERE namespace.nspname=CURRENT_SCHEMA() AND relation.relname='listener_strict_catch_up_runs';
  IF run_table_oid IS NOT NULL THEN
    IF run_table_kind<>'r'
      OR (SELECT COUNT(*) FROM pg_attribute WHERE attrelid=run_table_oid AND attnum>0 AND NOT attisdropped)<>19
      OR EXISTS (
        SELECT 1 FROM (VALUES
          ('run_id','text',TRUE),('checkpoint_key','text',TRUE),('previous_slot','numeric(78,0)',TRUE),
          ('previous_signature','text',TRUE),('provider_id','text',TRUE),('observed_head_slot','numeric(78,0)',TRUE),
          ('observed_head_signature','text',TRUE),('before_signature','text',TRUE),('last_accepted_slot','numeric(78,0)',TRUE),
          ('pages_scanned','bigint',TRUE),('signatures_enqueued','bigint',TRUE),('revision','bigint',TRUE),
          ('state','text',TRUE),('terminal_reason','text',FALSE),('previous_updated_at','timestamp with time zone',TRUE),
          ('started_at','timestamp with time zone',TRUE),('updated_at','timestamp with time zone',TRUE),
          ('completed_at','timestamp with time zone',FALSE),('purge_after','timestamp with time zone',FALSE)
        ) AS expected(column_name,column_type,not_null)
        LEFT JOIN pg_attribute attribute ON attribute.attrelid=run_table_oid AND attribute.attname=expected.column_name
          AND attribute.attnum>0 AND NOT attribute.attisdropped
        WHERE attribute.attnum IS NULL OR format_type(attribute.atttypid,attribute.atttypmod)<>expected.column_type
          OR attribute.attnotnull<>expected.not_null
      )
      OR NOT EXISTS (
        SELECT 1 FROM pg_constraint primary_key WHERE primary_key.conrelid=run_table_oid
          AND primary_key.contype='p' AND primary_key.convalidated
          AND primary_key.conkey=ARRAY[(SELECT attnum FROM pg_attribute
            WHERE attrelid=run_table_oid AND attname='run_id' AND NOT attisdropped)]::SMALLINT[]
      ) THEN RAISE EXCEPTION 'strict catch-up run table definition is incompatible' USING ERRCODE='23514'; END IF;
  END IF;
  FOREACH target_index_oid IN ARRAY ARRAY[
    (SELECT relation.oid FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname=CURRENT_SCHEMA() AND relation.relname='listener_strict_catch_up_runs_active_key_unique'),
    (SELECT relation.oid FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname=CURRENT_SCHEMA() AND relation.relname='listener_strict_catch_up_runs_provider_key_idx'),
    (SELECT relation.oid FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname=CURRENT_SCHEMA() AND relation.relname='listener_strict_catch_up_runs_terminal_purge_idx')
  ] LOOP
    IF target_index_oid IS NOT NULL THEN
      SELECT relkind INTO target_index_kind FROM pg_class WHERE oid=target_index_oid;
      IF run_table_oid IS NULL OR target_index_kind<>'i' THEN
        RAISE EXCEPTION 'strict catch-up run target index definition is incompatible' USING ERRCODE='23514';
      END IF;
    END IF;
  END LOOP;
END;
$$;

CREATE TABLE IF NOT EXISTS listener_strict_catch_up_runs (
  run_id TEXT PRIMARY KEY,
  checkpoint_key TEXT NOT NULL,
  previous_slot NUMERIC(78,0) NOT NULL,
  previous_signature TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  observed_head_slot NUMERIC(78,0) NOT NULL,
  observed_head_signature TEXT NOT NULL,
  before_signature TEXT NOT NULL,
  last_accepted_slot NUMERIC(78,0) NOT NULL,
  pages_scanned BIGINT NOT NULL,
  signatures_enqueued BIGINT NOT NULL,
  revision BIGINT NOT NULL,
  state TEXT NOT NULL,
  terminal_reason TEXT,
  previous_updated_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  CONSTRAINT listener_strict_catch_up_runs_id_check CHECK (run_id ~ '^strict_catchup_run_[0-9a-f]{64}$'),
  CONSTRAINT listener_strict_catch_up_runs_key_check CHECK (checkpoint_key IN ('launchpad','market')),
  CONSTRAINT listener_strict_catch_up_runs_previous_signature_check CHECK (
    previous_signature !~ '^[[:space:]]' AND previous_signature !~ '[[:space:]]$'
    AND OCTET_LENGTH(previous_signature) BETWEEN 1 AND 128
  ),
  CONSTRAINT listener_strict_catch_up_runs_provider_check CHECK (provider_id IN ('primary','fallback-1','fallback-2','fallback-3')),
  CONSTRAINT listener_strict_catch_up_runs_head_signature_check CHECK (
    observed_head_signature !~ '^[[:space:]]' AND observed_head_signature !~ '[[:space:]]$'
    AND OCTET_LENGTH(observed_head_signature) BETWEEN 1 AND 128
  ),
  CONSTRAINT listener_strict_catch_up_runs_before_signature_check CHECK (
    before_signature !~ '^[[:space:]]' AND before_signature !~ '[[:space:]]$'
    AND OCTET_LENGTH(before_signature) BETWEEN 1 AND 128
  ),
  CONSTRAINT listener_strict_catch_up_runs_numeric_bounds_check CHECK (
    previous_slot BETWEEN 0 AND 999999999999999999999999999999999999999999999999999999999999999999999999999999
    AND observed_head_slot BETWEEN 0 AND 999999999999999999999999999999999999999999999999999999999999999999999999999999
    AND last_accepted_slot BETWEEN 0 AND 999999999999999999999999999999999999999999999999999999999999999999999999999999
    AND pages_scanned BETWEEN 1 AND 9223372036854775807
    AND signatures_enqueued BETWEEN 0 AND 9223372036854775807
    AND revision BETWEEN 0 AND 9223372036854775807
  ),
  CONSTRAINT listener_strict_catch_up_runs_cursor_order_check CHECK (
    observed_head_slot>=last_accepted_slot AND last_accepted_slot>=previous_slot
    AND before_signature<>previous_signature
    AND (before_signature<>observed_head_signature OR (
      pages_scanned=1 AND signatures_enqueued=1 AND last_accepted_slot=observed_head_slot
      AND ((state='ACTIVE' AND revision=0) OR (state<>'ACTIVE' AND revision=1))
    ))
  ),
  CONSTRAINT listener_strict_catch_up_runs_state_check CHECK (state IN ('ACTIVE','COMPLETED','FAILED','SUPERSEDED')),
  CONSTRAINT listener_strict_catch_up_runs_lifecycle_check CHECK (
    (state='ACTIVE' AND terminal_reason IS NULL AND completed_at IS NULL AND purge_after IS NULL)
    OR (state='COMPLETED' AND terminal_reason IS NULL AND completed_at IS NOT NULL AND completed_at=updated_at
      AND purge_after IS NOT NULL AND purge_after=completed_at+INTERVAL '4 hours')
    OR (state='FAILED' AND terminal_reason IS NOT NULL AND terminal_reason='CATCH_UP_WINDOW_EXCEEDED'
      AND completed_at IS NOT NULL AND completed_at=updated_at AND purge_after IS NOT NULL AND purge_after=completed_at+INTERVAL '4 hours')
    OR (state='SUPERSEDED' AND terminal_reason IS NOT NULL AND terminal_reason='CHECKPOINT_SUPERSEDED'
      AND completed_at IS NOT NULL AND completed_at=updated_at AND purge_after IS NOT NULL AND purge_after=completed_at+INTERVAL '4 hours')
  ),
  CONSTRAINT listener_strict_catch_up_runs_timestamps_check CHECK (
    isfinite(previous_updated_at) AND previous_updated_at>=TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
    AND previous_updated_at<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
    AND date_trunc('milliseconds',previous_updated_at)=previous_updated_at
    AND isfinite(started_at) AND started_at>=previous_updated_at
    AND started_at<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00' AND date_trunc('milliseconds',started_at)=started_at
    AND isfinite(updated_at) AND updated_at>=started_at
    AND updated_at<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00' AND date_trunc('milliseconds',updated_at)=updated_at
    AND (completed_at IS NULL OR (isfinite(completed_at) AND completed_at>=updated_at
      AND completed_at<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00' AND date_trunc('milliseconds',completed_at)=completed_at))
    AND (purge_after IS NULL OR (isfinite(purge_after)
      AND purge_after<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00' AND date_trunc('milliseconds',purge_after)=purge_after))
  )
);

-- Create an independent, same-session definition and compare every named CHECK and the primary key verbatim.
DO $$
DECLARE actual_constraints TEXT[]; expected_constraints TEXT[];
BEGIN
  CREATE TEMP TABLE listener_strict_catch_up_runs_expected (
    LIKE listener_strict_catch_up_runs INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY INCLUDING STORAGE
  ) ON COMMIT DROP;
  ALTER TABLE listener_strict_catch_up_runs_expected
    ADD CONSTRAINT listener_strict_catch_up_runs_pkey PRIMARY KEY (run_id),
    ADD CONSTRAINT listener_strict_catch_up_runs_id_check CHECK (run_id ~ '^strict_catchup_run_[0-9a-f]{64}$'),
    ADD CONSTRAINT listener_strict_catch_up_runs_key_check CHECK (checkpoint_key IN ('launchpad','market')),
    ADD CONSTRAINT listener_strict_catch_up_runs_previous_signature_check CHECK (previous_signature !~ '^[[:space:]]' AND previous_signature !~ '[[:space:]]$' AND OCTET_LENGTH(previous_signature) BETWEEN 1 AND 128),
    ADD CONSTRAINT listener_strict_catch_up_runs_provider_check CHECK (provider_id IN ('primary','fallback-1','fallback-2','fallback-3')),
    ADD CONSTRAINT listener_strict_catch_up_runs_head_signature_check CHECK (observed_head_signature !~ '^[[:space:]]' AND observed_head_signature !~ '[[:space:]]$' AND OCTET_LENGTH(observed_head_signature) BETWEEN 1 AND 128),
    ADD CONSTRAINT listener_strict_catch_up_runs_before_signature_check CHECK (before_signature !~ '^[[:space:]]' AND before_signature !~ '[[:space:]]$' AND OCTET_LENGTH(before_signature) BETWEEN 1 AND 128),
    ADD CONSTRAINT listener_strict_catch_up_runs_numeric_bounds_check CHECK (
      previous_slot BETWEEN 0 AND 999999999999999999999999999999999999999999999999999999999999999999999999999999
      AND observed_head_slot BETWEEN 0 AND 999999999999999999999999999999999999999999999999999999999999999999999999999999
      AND last_accepted_slot BETWEEN 0 AND 999999999999999999999999999999999999999999999999999999999999999999999999999999
      AND pages_scanned BETWEEN 1 AND 9223372036854775807 AND signatures_enqueued BETWEEN 0 AND 9223372036854775807
      AND revision BETWEEN 0 AND 9223372036854775807),
    ADD CONSTRAINT listener_strict_catch_up_runs_cursor_order_check CHECK (
      observed_head_slot>=last_accepted_slot AND last_accepted_slot>=previous_slot AND before_signature<>previous_signature
      AND (before_signature<>observed_head_signature OR (pages_scanned=1 AND signatures_enqueued=1
        AND last_accepted_slot=observed_head_slot AND ((state='ACTIVE' AND revision=0) OR (state<>'ACTIVE' AND revision=1))))),
    ADD CONSTRAINT listener_strict_catch_up_runs_state_check CHECK (state IN ('ACTIVE','COMPLETED','FAILED','SUPERSEDED')),
    ADD CONSTRAINT listener_strict_catch_up_runs_lifecycle_check CHECK (
      (state='ACTIVE' AND terminal_reason IS NULL AND completed_at IS NULL AND purge_after IS NULL)
      OR (state='COMPLETED' AND terminal_reason IS NULL AND completed_at IS NOT NULL AND completed_at=updated_at AND purge_after IS NOT NULL AND purge_after=completed_at+INTERVAL '4 hours')
      OR (state='FAILED' AND terminal_reason IS NOT NULL AND terminal_reason='CATCH_UP_WINDOW_EXCEEDED' AND completed_at IS NOT NULL AND completed_at=updated_at AND purge_after IS NOT NULL AND purge_after=completed_at+INTERVAL '4 hours')
      OR (state='SUPERSEDED' AND terminal_reason IS NOT NULL AND terminal_reason='CHECKPOINT_SUPERSEDED' AND completed_at IS NOT NULL AND completed_at=updated_at AND purge_after IS NOT NULL AND purge_after=completed_at+INTERVAL '4 hours')),
    ADD CONSTRAINT listener_strict_catch_up_runs_timestamps_check CHECK (
      isfinite(previous_updated_at) AND previous_updated_at>=TIMESTAMPTZ '1970-01-01 00:00:00.000+00'
      AND previous_updated_at<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00' AND date_trunc('milliseconds',previous_updated_at)=previous_updated_at
      AND isfinite(started_at) AND started_at>=previous_updated_at AND started_at<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00' AND date_trunc('milliseconds',started_at)=started_at
      AND isfinite(updated_at) AND updated_at>=started_at AND updated_at<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00' AND date_trunc('milliseconds',updated_at)=updated_at
      AND (completed_at IS NULL OR (isfinite(completed_at) AND completed_at>=updated_at AND completed_at<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00' AND date_trunc('milliseconds',completed_at)=completed_at))
      AND (purge_after IS NULL OR (isfinite(purge_after) AND purge_after<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00' AND date_trunc('milliseconds',purge_after)=purge_after)));
  SELECT ARRAY(SELECT conname||':'||convalidated||':'||REGEXP_REPLACE(pg_get_constraintdef(oid),'\s+',' ','g')
    FROM pg_constraint WHERE conrelid='listener_strict_catch_up_runs'::REGCLASS AND contype IN ('p','c') ORDER BY conname)
    INTO actual_constraints;
  SELECT ARRAY(SELECT conname||':'||convalidated||':'||REGEXP_REPLACE(pg_get_constraintdef(oid),'\s+',' ','g')
    FROM pg_constraint WHERE conrelid='pg_temp.listener_strict_catch_up_runs_expected'::REGCLASS AND contype IN ('p','c') ORDER BY conname)
    INTO expected_constraints;
  IF actual_constraints IS DISTINCT FROM expected_constraints THEN
    RAISE EXCEPTION 'strict catch-up run constraint definition is incompatible' USING ERRCODE='23514';
  END IF;
END;
$$;

DO $$
DECLARE run_table_oid OID:='listener_strict_catch_up_runs'::REGCLASS; target_index_oid OID;
BEGIN
  SELECT relation.oid INTO target_index_oid FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace WHERE namespace.nspname=CURRENT_SCHEMA() AND relation.relname='listener_strict_catch_up_runs_active_key_unique';
  IF target_index_oid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_index index_info JOIN pg_class index_class ON index_class.oid=index_info.indexrelid JOIN pg_am access_method ON access_method.oid=index_class.relam WHERE index_info.indexrelid=target_index_oid AND index_info.indrelid=run_table_oid AND index_info.indisvalid AND index_info.indisready AND index_info.indisunique AND NOT index_info.indisprimary AND access_method.amname='btree' AND index_info.indnkeyatts=1 AND index_info.indexprs IS NULL AND pg_get_indexdef(index_info.indexrelid,1,TRUE)='checkpoint_key' AND pg_get_expr(index_info.indpred,index_info.indrelid)='(state = ''ACTIVE''::text)') THEN RAISE EXCEPTION 'strict catch-up run target index definition is incompatible' USING ERRCODE='23514'; END IF;
  SELECT relation.oid INTO target_index_oid FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace WHERE namespace.nspname=CURRENT_SCHEMA() AND relation.relname='listener_strict_catch_up_runs_provider_key_idx';
  IF target_index_oid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_index index_info JOIN pg_class index_class ON index_class.oid=index_info.indexrelid JOIN pg_am access_method ON access_method.oid=index_class.relam WHERE index_info.indexrelid=target_index_oid AND index_info.indrelid=run_table_oid AND index_info.indisvalid AND index_info.indisready AND NOT index_info.indisunique AND NOT index_info.indisprimary AND access_method.amname='btree' AND index_info.indnkeyatts=2 AND index_info.indexprs IS NULL AND index_info.indpred IS NULL AND pg_get_indexdef(index_info.indexrelid,1,TRUE)='provider_id' AND pg_get_indexdef(index_info.indexrelid,2,TRUE)='checkpoint_key') THEN RAISE EXCEPTION 'strict catch-up run target index definition is incompatible' USING ERRCODE='23514'; END IF;
  SELECT relation.oid INTO target_index_oid FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace WHERE namespace.nspname=CURRENT_SCHEMA() AND relation.relname='listener_strict_catch_up_runs_terminal_purge_idx';
  IF target_index_oid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_index index_info JOIN pg_class index_class ON index_class.oid=index_info.indexrelid JOIN pg_am access_method ON access_method.oid=index_class.relam WHERE index_info.indexrelid=target_index_oid AND index_info.indrelid=run_table_oid AND index_info.indisvalid AND index_info.indisready AND NOT index_info.indisunique AND NOT index_info.indisprimary AND access_method.amname='btree' AND index_info.indnkeyatts=1 AND index_info.indexprs IS NULL AND pg_get_indexdef(index_info.indexrelid,1,TRUE)='purge_after' AND pg_get_expr(index_info.indpred,index_info.indrelid)='(state <> ''ACTIVE''::text)') THEN RAISE EXCEPTION 'strict catch-up run target index definition is incompatible' USING ERRCODE='23514'; END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS listener_strict_catch_up_runs_active_key_unique ON listener_strict_catch_up_runs (checkpoint_key) WHERE state='ACTIVE';
CREATE INDEX IF NOT EXISTS listener_strict_catch_up_runs_provider_key_idx ON listener_strict_catch_up_runs (provider_id,checkpoint_key);
CREATE INDEX IF NOT EXISTS listener_strict_catch_up_runs_terminal_purge_idx ON listener_strict_catch_up_runs (purge_after) WHERE state<>'ACTIVE';
