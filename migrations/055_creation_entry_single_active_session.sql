-- MANUAL_REVIEW is unresolved exposure, not a safe release of the global slot.
-- Refuse a named object that would cause IF NOT EXISTS to silently skip the guard.
DO $$
DECLARE
  singleton_index_oid OID;
  singleton_index_kind "char";
BEGIN
  SELECT index_class.oid,index_class.relkind
  INTO singleton_index_oid,singleton_index_kind
  FROM pg_class index_class
  JOIN pg_namespace index_namespace ON index_namespace.oid=index_class.relnamespace
  WHERE index_namespace.nspname=CURRENT_SCHEMA()
    AND index_class.relname='paper_strategy_sessions_creation_entry_active_singleton_idx';

  IF singleton_index_oid IS NOT NULL AND (
    singleton_index_kind <> 'i'
    OR NOT EXISTS (
      SELECT 1
      FROM pg_index index_info
      JOIN pg_class index_class ON index_class.oid=index_info.indexrelid
      JOIN pg_am access_method ON access_method.oid=index_class.relam
      WHERE index_info.indexrelid=singleton_index_oid
        AND index_info.indrelid='paper_strategy_sessions'::REGCLASS
        AND index_info.indisvalid AND index_info.indisready AND index_info.indislive
        AND index_info.indisunique AND index_info.indimmediate
        AND NOT index_info.indisprimary AND NOT index_info.indisexclusion
        AND access_method.amname='btree'
        AND index_info.indnkeyatts=1 AND index_info.indnatts=1
        AND index_info.indexprs IS NOT NULL
        AND index_info.indoption::TEXT='0'
        AND pg_get_indexdef(index_info.indexrelid,1,TRUE)='(1)'
        AND pg_get_expr(index_info.indpred,index_info.indrelid)=(
          '((strategy_id = ''creation-entry-v1''::text) AND '
          || '(state = ANY (ARRAY['
          || '''BUY_PENDING''::text, ''PAPER_HOLDING''::text, '
          || '''WAITING_EXTERNAL_BUYS''::text, ''EXIT_PENDING_QUOTE''::text, '
          || '''SELL_PENDING''::text, ''MANUAL_REVIEW''::text])))'
        )
    )
  ) THEN
    RAISE EXCEPTION 'creation-entry active singleton index definition is incompatible'
      USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM paper_strategy_sessions
    WHERE strategy_id = 'creation-entry-v1'
      AND state IN (
        'BUY_PENDING','PAPER_HOLDING','WAITING_EXTERNAL_BUYS',
        'EXIT_PENDING_QUOTE','SELL_PENDING','MANUAL_REVIEW'
      )
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'multiple active creation-entry-v1 paper sessions exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS
  paper_strategy_sessions_creation_entry_active_singleton_idx
  ON paper_strategy_sessions ((1))
  WHERE strategy_id = 'creation-entry-v1'
    AND state IN (
      'BUY_PENDING','PAPER_HOLDING','WAITING_EXTERNAL_BUYS',
      'EXIT_PENDING_QUOTE','SELL_PENDING','MANUAL_REVIEW'
    );
