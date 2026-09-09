-- Immutable wallet snapshots permit refreshes at an unchanged risk revision.
-- Refuse ambiguous legacy state before changing the historical uniqueness invariant.
DO $$
DECLARE
  current_index_oid OID;
  current_index_kind "char";
  refresh_order_index_oid OID;
  refresh_order_index_kind "char";
BEGIN
  SELECT index_class.oid,index_class.relkind
  INTO current_index_oid,current_index_kind
  FROM pg_class index_class
  JOIN pg_namespace index_namespace ON index_namespace.oid=index_class.relnamespace
  WHERE index_namespace.nspname=CURRENT_SCHEMA()
    AND index_class.relname='execution_wallet_snapshots_current_generation_unique';

  IF current_index_oid IS NOT NULL AND (
    current_index_kind <> 'i'
    OR NOT EXISTS (
      SELECT 1
      FROM pg_index index_info
      JOIN pg_class index_class ON index_class.oid=index_info.indexrelid
      JOIN pg_am access_method ON access_method.oid=index_class.relam
      WHERE index_info.indexrelid=current_index_oid
        AND index_info.indrelid='execution_wallet_snapshots'::REGCLASS
        AND index_info.indisvalid AND index_info.indisready AND index_info.indisunique
        AND NOT index_info.indisprimary
        AND access_method.amname='btree'
        AND index_info.indnkeyatts=1 AND index_info.indexprs IS NULL
        AND index_info.indoption::TEXT='0'
        AND pg_get_indexdef(index_info.indexrelid,1,TRUE)='generation_id'
        AND pg_get_expr(index_info.indpred,index_info.indrelid)='(superseded_at IS NULL)'
    )
  ) THEN
    RAISE EXCEPTION 'execution wallet snapshot target index definition is incompatible'
      USING ERRCODE = '23514';
  END IF;

  SELECT index_class.oid,index_class.relkind
  INTO refresh_order_index_oid,refresh_order_index_kind
  FROM pg_class index_class
  JOIN pg_namespace index_namespace ON index_namespace.oid=index_class.relnamespace
  WHERE index_namespace.nspname=CURRENT_SCHEMA()
    AND index_class.relname='execution_wallet_snapshots_generation_refresh_order_idx';

  IF refresh_order_index_oid IS NOT NULL AND (
    refresh_order_index_kind <> 'i'
    OR NOT EXISTS (
      SELECT 1
      FROM pg_index index_info
      JOIN pg_class index_class ON index_class.oid=index_info.indexrelid
      JOIN pg_am access_method ON access_method.oid=index_class.relam
      WHERE index_info.indexrelid=refresh_order_index_oid
        AND index_info.indrelid='execution_wallet_snapshots'::REGCLASS
        AND index_info.indisvalid AND index_info.indisready AND NOT index_info.indisunique
        AND NOT index_info.indisprimary
        AND access_method.amname='btree'
        AND index_info.indnkeyatts=4 AND index_info.indexprs IS NULL
        AND index_info.indpred IS NULL
        AND index_info.indoption::TEXT='0 3 3 3'
        AND pg_get_indexdef(index_info.indexrelid,1,TRUE)='generation_id'
        AND pg_get_indexdef(index_info.indexrelid,2,TRUE)='state_revision'
        AND pg_get_indexdef(index_info.indexrelid,3,TRUE)='observed_at'
        AND pg_get_indexdef(index_info.indexrelid,4,TRUE)='snapshot_id'
    )
  ) THEN
    RAISE EXCEPTION 'execution wallet snapshot target index definition is incompatible'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM execution_wallet_snapshots
    WHERE superseded_at IS NULL
    GROUP BY generation_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'execution wallet snapshot migration requires at most one current snapshot per generation'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH snapshots AS (
      SELECT generation_id,snapshot_id,state_revision,observed_at,superseded_at,
        COUNT(*) FILTER (WHERE superseded_at IS NULL) OVER (PARTITION BY generation_id)
          AS current_count,
        MAX(state_revision) OVER (PARTITION BY generation_id) AS maximum_state_revision,
        MAX(observed_at) OVER (PARTITION BY generation_id) AS maximum_observed_at,
        ROW_NUMBER() OVER (
          PARTITION BY generation_id
          ORDER BY state_revision DESC,observed_at DESC,snapshot_id DESC
        ) AS historical_frontier
      FROM execution_wallet_snapshots
    )
    SELECT 1
    FROM snapshots
    WHERE current_count<>1
      OR (superseded_at IS NULL AND (
        state_revision<>maximum_state_revision
        OR observed_at<>maximum_observed_at
        OR historical_frontier<>1
      ))
  ) THEN
    RAISE EXCEPTION 'execution wallet snapshot migration requires exactly one current snapshot matching historical frontier per generation'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE execution_wallet_snapshots
  DROP CONSTRAINT IF EXISTS execution_wallet_snapshots_generation_revision_unique;

CREATE UNIQUE INDEX IF NOT EXISTS execution_wallet_snapshots_current_generation_unique
  ON execution_wallet_snapshots (generation_id)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS execution_wallet_snapshots_generation_refresh_order_idx
  ON execution_wallet_snapshots (generation_id,state_revision DESC,observed_at DESC,snapshot_id DESC);
