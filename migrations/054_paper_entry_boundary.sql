-- Durable paper BUY watermark. A quote has a slot but no instruction cursor,
-- therefore the complete quote slot is treated as pre-entry.
DO $migration_054_preflight$
DECLARE boundary_columns INTEGER;
BEGIN
  PERFORM set_config('TimeZone','UTC',true);
  LOCK TABLE paper_strategy_sessions IN ACCESS EXCLUSIVE MODE;
  SELECT COUNT(*) INTO boundary_columns FROM pg_attribute
  WHERE attrelid='paper_strategy_sessions'::REGCLASS AND attnum>0 AND NOT attisdropped
    AND attname IN (
      'entry_boundary_slot','entry_boundary_quote_id','entry_boundary_observed_at'
    );
  IF boundary_columns NOT IN (0,3) THEN
    RAISE EXCEPTION 'paper entry boundary columns are partial' USING ERRCODE='23514';
  END IF;
  DROP TABLE IF EXISTS pg_temp.migration_054_state;
  CREATE TEMP TABLE pg_temp.migration_054_state(first_install BOOLEAN NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp.migration_054_state(first_install) VALUES (boundary_columns=0);
END;
$migration_054_preflight$;

ALTER TABLE paper_strategy_sessions
  ADD COLUMN IF NOT EXISTS entry_boundary_slot NUMERIC(78,0),
  ADD COLUMN IF NOT EXISTS entry_boundary_quote_id TEXT,
  ADD COLUMN IF NOT EXISTS entry_boundary_observed_at TIMESTAMPTZ;

-- Recover the exact durable BUY quote for sessions created by an older binary.
-- Invalid/missing historical quote payloads remain NULL and therefore fail closed
-- if the strategy attempts to count post-entry activity.
WITH buy_boundary AS (
  SELECT session.session_id,trade.quote_id,trade.quote_observed_at,
    (trade.payload #>> '{quote,observedSlot,$solTokenListenerBigInt}')::NUMERIC(78,0) slot
  FROM paper_strategy_sessions session
  JOIN paper_trades trade ON trade.position_id=session.position_id AND trade.side='BUY'
  WHERE session.strategy_id='creation-entry-v1'
    AND session.entry_boundary_slot IS NULL
    AND trade.quote_observed_at IS NOT NULL
    AND trade.payload #>> '{quote,observedSlot,$solTokenListenerBigInt}' ~ '^(0|[1-9][0-9]{0,77})$'
)
UPDATE paper_strategy_sessions session SET
  entry_boundary_slot=boundary.slot,
  entry_boundary_quote_id=boundary.quote_id,
  entry_boundary_observed_at=boundary.quote_observed_at,
  payload=jsonb_set(session.payload,'{entryBoundary}',jsonb_build_object(
    'kind','PAPER_BUY_QUOTE_SLOT',
    'slot',jsonb_build_object('$solTokenListenerBigInt',boundary.slot::TEXT),
    'quoteId',boundary.quote_id,
    'observedAtMs',(EXTRACT(EPOCH FROM boundary.quote_observed_at)*1000)::BIGINT
  ),true)
FROM buy_boundary boundary
WHERE session.session_id=boundary.session_id;

DO $migration_054_install_constraint$
BEGIN
  IF (SELECT first_install FROM pg_temp.migration_054_state) THEN
    ALTER TABLE paper_strategy_sessions
      ADD CONSTRAINT paper_strategy_sessions_entry_boundary_check CHECK (
        (
          entry_boundary_slot IS NULL
          AND entry_boundary_quote_id IS NULL
          AND entry_boundary_observed_at IS NULL
        ) OR (
          strategy_id='creation-entry-v1'
          AND entry_boundary_slot IS NOT NULL AND entry_boundary_slot >= 0
          AND entry_boundary_quote_id IS NOT NULL
          AND entry_boundary_quote_id=BTRIM(entry_boundary_quote_id)
          AND OCTET_LENGTH(entry_boundary_quote_id) BETWEEN 1 AND 4096
          AND entry_boundary_observed_at IS NOT NULL
          AND isfinite(entry_boundary_observed_at)
          AND payload #>> '{entryBoundary,kind}'='PAPER_BUY_QUOTE_SLOT'
          AND payload #>> '{entryBoundary,slot,$solTokenListenerBigInt}'
            = entry_boundary_slot::TEXT
          AND payload #>> '{entryBoundary,quoteId}'=entry_boundary_quote_id
        )
      );
  END IF;
END;
$migration_054_install_constraint$;

CREATE OR REPLACE FUNCTION paper_strategy_session_entry_boundary_monotone()
RETURNS trigger LANGUAGE plpgsql AS $paper_strategy_session_entry_boundary_monotone$
BEGIN
  IF OLD.entry_boundary_slot IS NOT NULL AND (
    NEW.entry_boundary_slot IS DISTINCT FROM OLD.entry_boundary_slot
    OR NEW.entry_boundary_quote_id IS DISTINCT FROM OLD.entry_boundary_quote_id
    OR NEW.entry_boundary_observed_at IS DISTINCT FROM OLD.entry_boundary_observed_at
  ) THEN
    RAISE EXCEPTION 'paper strategy entry boundary is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$paper_strategy_session_entry_boundary_monotone$;

DO $migration_054_install_trigger$
BEGIN
  IF (SELECT first_install FROM pg_temp.migration_054_state) THEN
    CREATE TRIGGER paper_strategy_session_entry_boundary_monotone
      BEFORE UPDATE OF entry_boundary_slot,entry_boundary_quote_id,entry_boundary_observed_at
      ON paper_strategy_sessions FOR EACH ROW
      EXECUTE FUNCTION paper_strategy_session_entry_boundary_monotone();
  END IF;
END;
$migration_054_install_trigger$;

DO $migration_054_validate$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute attribute
    WHERE attribute.attrelid='paper_strategy_sessions'::REGCLASS
      AND attribute.attname='entry_boundary_slot' AND attribute.attnum>0
      AND NOT attribute.attisdropped
      AND format_type(attribute.atttypid,attribute.atttypmod)='numeric(78,0)'
      AND NOT attribute.attnotnull
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_attribute attribute
    WHERE attribute.attrelid='paper_strategy_sessions'::REGCLASS
      AND attribute.attname='entry_boundary_quote_id' AND attribute.attnum>0
      AND NOT attribute.attisdropped AND attribute.atttypid='text'::REGTYPE
      AND NOT attribute.attnotnull
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_attribute attribute
    WHERE attribute.attrelid='paper_strategy_sessions'::REGCLASS
      AND attribute.attname='entry_boundary_observed_at' AND attribute.attnum>0
      AND NOT attribute.attisdropped
      AND attribute.atttypid='timestamp with time zone'::REGTYPE
      AND NOT attribute.attnotnull
  ) THEN
    RAISE EXCEPTION 'paper entry boundary columns are incompatible' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='paper_strategy_sessions'::REGCLASS
      AND conname='paper_strategy_sessions_entry_boundary_check'
      AND contype='c' AND convalidated
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger trigger_row
    JOIN pg_proc procedure ON procedure.oid=trigger_row.tgfoid
    WHERE trigger_row.tgrelid='paper_strategy_sessions'::REGCLASS
      AND trigger_row.tgname='paper_strategy_session_entry_boundary_monotone'
      AND NOT trigger_row.tgisinternal AND trigger_row.tgenabled='O'
      AND procedure.proname='paper_strategy_session_entry_boundary_monotone'
  ) THEN
    RAISE EXCEPTION 'paper entry boundary guards are incompatible' USING ERRCODE='23514';
  END IF;
END;
$migration_054_validate$;
