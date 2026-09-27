-- Additive query support for the bounded worker-tracking authority. This
-- migration neither activates the authority nor changes inbox rows.
DO $migration_056_install$
DECLARE
  named_object_count INTEGER;
BEGIN
  PERFORM set_config('TimeZone','UTC',true);
  PERFORM set_config('DateStyle','ISO, YMD',true);

  LOCK TABLE trading_candidates,execution_intents,execution_live_positions
    IN SHARE MODE;

  SELECT COUNT(*) INTO named_object_count
  FROM pg_class relation
  WHERE relation.relnamespace=current_schema()::REGNAMESPACE
    AND relation.relname IN (
      'trading_candidates_worker_tracking_expiry_idx',
      'execution_intents_worker_tracking_mint_idx',
      'execution_live_positions_worker_tracking_mint_idx',
      'listener_worker_tracking_live_mints'
    );

  IF named_object_count=0 THEN
    CREATE INDEX trading_candidates_worker_tracking_expiry_idx
      ON trading_candidates (eligible_until, mint)
      WHERE superseded_at IS NULL AND state='ELIGIBLE'
        AND confirmation_status<>'orphaned';

    CREATE INDEX execution_intents_worker_tracking_mint_idx
      ON execution_intents (mint)
      WHERE terminal_at IS NULL;

    CREATE INDEX execution_live_positions_worker_tracking_mint_idx
      ON execution_live_positions (mint)
      WHERE state IN ('OPEN','EXIT_PENDING','UNKNOWN');

    CREATE VIEW listener_worker_tracking_live_mints
      WITH (security_barrier=true) AS
      SELECT mint FROM execution_live_positions
      WHERE state IN ('OPEN','EXIT_PENDING','UNKNOWN');
    REVOKE ALL PRIVILEGES ON TABLE listener_worker_tracking_live_mints FROM PUBLIC;
  ELSIF named_object_count<>4 THEN
    RAISE EXCEPTION 'bounded worker tracking objects are partial'
      USING ERRCODE='23514';
  END IF;
END;
$migration_056_install$;

DO $migration_056_validate$
DECLARE
  candidate_index OID;
  intent_index OID;
  live_index OID;
  live_view OID;
BEGIN
  SELECT relation.oid INTO candidate_index
  FROM pg_class relation
  WHERE relation.relnamespace=current_schema()::REGNAMESPACE
    AND relation.relname='trading_candidates_worker_tracking_expiry_idx';
  IF candidate_index IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_index index_info
    JOIN pg_class index_relation ON index_relation.oid=index_info.indexrelid
    JOIN pg_class table_relation ON table_relation.oid=index_info.indrelid
    JOIN pg_am access_method ON access_method.oid=index_relation.relam
    WHERE index_info.indexrelid=candidate_index
      AND index_info.indrelid='trading_candidates'::REGCLASS
      AND index_relation.relkind='i' AND index_relation.relpersistence='p'
      AND index_relation.relowner=table_relation.relowner
      AND index_relation.reloptions IS NULL AND index_relation.reltablespace=0
      AND access_method.amname='btree'
      AND index_info.indisvalid AND index_info.indisready AND index_info.indislive
      AND NOT index_info.indisunique AND NOT index_info.indisprimary
      AND NOT index_info.indisexclusion AND index_info.indimmediate
      AND index_info.indnkeyatts=2 AND index_info.indnatts=2
      AND index_info.indexprs IS NULL
      AND pg_get_indexdef(index_info.indexrelid,1,TRUE)='eligible_until'
      AND pg_get_indexdef(index_info.indexrelid,2,TRUE)='mint'
      AND pg_get_expr(index_info.indpred,index_info.indrelid)=
        '((superseded_at IS NULL) AND (state = ''ELIGIBLE''::text) AND '
        || '(confirmation_status <> ''orphaned''::text))'
  ) THEN
    RAISE EXCEPTION 'trading candidate worker tracking index is incompatible'
      USING ERRCODE='23514';
  END IF;

  SELECT relation.oid INTO intent_index
  FROM pg_class relation
  WHERE relation.relnamespace=current_schema()::REGNAMESPACE
    AND relation.relname='execution_intents_worker_tracking_mint_idx';
  IF intent_index IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_index index_info
    JOIN pg_class index_relation ON index_relation.oid=index_info.indexrelid
    JOIN pg_class table_relation ON table_relation.oid=index_info.indrelid
    JOIN pg_am access_method ON access_method.oid=index_relation.relam
    WHERE index_info.indexrelid=intent_index
      AND index_info.indrelid='execution_intents'::REGCLASS
      AND index_relation.relkind='i' AND index_relation.relpersistence='p'
      AND index_relation.relowner=table_relation.relowner
      AND index_relation.reloptions IS NULL AND index_relation.reltablespace=0
      AND access_method.amname='btree'
      AND index_info.indisvalid AND index_info.indisready AND index_info.indislive
      AND NOT index_info.indisunique AND NOT index_info.indisprimary
      AND NOT index_info.indisexclusion AND index_info.indimmediate
      AND index_info.indnkeyatts=1 AND index_info.indnatts=1
      AND index_info.indexprs IS NULL
      AND pg_get_indexdef(index_info.indexrelid,1,TRUE)='mint'
      AND pg_get_expr(index_info.indpred,index_info.indrelid)=
        '(terminal_at IS NULL)'
  ) THEN
    RAISE EXCEPTION 'execution intent worker tracking index is incompatible'
      USING ERRCODE='23514';
  END IF;

  SELECT relation.oid INTO live_index
  FROM pg_class relation
  WHERE relation.relnamespace=current_schema()::REGNAMESPACE
    AND relation.relname='execution_live_positions_worker_tracking_mint_idx';
  IF live_index IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_index index_info
    JOIN pg_class index_relation ON index_relation.oid=index_info.indexrelid
    JOIN pg_class table_relation ON table_relation.oid=index_info.indrelid
    JOIN pg_am access_method ON access_method.oid=index_relation.relam
    WHERE index_info.indexrelid=live_index
      AND index_info.indrelid='execution_live_positions'::REGCLASS
      AND index_relation.relkind='i' AND index_relation.relpersistence='p'
      AND index_relation.relowner=table_relation.relowner
      AND index_relation.reloptions IS NULL AND index_relation.reltablespace=0
      AND access_method.amname='btree'
      AND index_info.indisvalid AND index_info.indisready AND index_info.indislive
      AND NOT index_info.indisunique AND NOT index_info.indisprimary
      AND NOT index_info.indisexclusion AND index_info.indimmediate
      AND index_info.indnkeyatts=1 AND index_info.indnatts=1
      AND index_info.indexprs IS NULL
      AND pg_get_indexdef(index_info.indexrelid,1,TRUE)='mint'
      AND pg_get_expr(index_info.indpred,index_info.indrelid)=
        '(state = ANY (ARRAY[''OPEN''::text, ''EXIT_PENDING''::text, '
        || '''UNKNOWN''::text]))'
  ) THEN
    RAISE EXCEPTION 'live position worker tracking index is incompatible'
      USING ERRCODE='23514';
  END IF;

  SELECT relation.oid INTO live_view
  FROM pg_class relation
  WHERE relation.relnamespace=current_schema()::REGNAMESPACE
    AND relation.relname='listener_worker_tracking_live_mints';
  IF live_view IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_class view_relation
    JOIN pg_class live_relation
      ON live_relation.oid='execution_live_positions'::REGCLASS
    WHERE view_relation.oid=live_view
      AND view_relation.relkind='v' AND view_relation.relpersistence='p'
      AND view_relation.relowner=live_relation.relowner
      AND view_relation.reloptions=ARRAY['security_barrier=true']::TEXT[]
      AND pg_get_viewdef(view_relation.oid,TRUE)=
        E' SELECT mint\n'
        || E'   FROM execution_live_positions\n'
        || E'  WHERE state = ANY '
        || E'(ARRAY[''OPEN''::text, ''EXIT_PENDING''::text, ''UNKNOWN''::text]);'
      AND NOT EXISTS (
        SELECT 1 FROM pg_attribute attribute
        WHERE attribute.attrelid=view_relation.oid AND attribute.attnum>0
          AND NOT attribute.attisdropped
          AND (attribute.attnum<>1 OR attribute.attname<>'mint'
            OR attribute.atttypid<>'text'::REGTYPE OR attribute.atttypmod<>-1)
      )
      AND (SELECT COUNT(*) FROM pg_attribute attribute
        WHERE attribute.attrelid=view_relation.oid AND attribute.attnum>0
          AND NOT attribute.attisdropped)=1
      AND NOT EXISTS (
        SELECT 1 FROM aclexplode(COALESCE(
          view_relation.relacl,acldefault('r',view_relation.relowner))) privilege
        WHERE privilege.grantee=0
      )
  ) THEN
    RAISE EXCEPTION 'listener live mint view is incompatible'
      USING ERRCODE='23514';
  END IF;
END;
$migration_056_validate$;
