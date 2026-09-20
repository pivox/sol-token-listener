-- Durable first-success timing.  Pre-050 inbox rows cannot be classified
-- truthfully, so they are explicitly unavailable rather than backfilled.
DO $migration_050_preflight$
DECLARE evidence_columns INTEGER;
BEGIN
  LOCK TABLE chain_transaction_inbox IN ACCESS EXCLUSIVE MODE;
  SELECT COUNT(*) INTO evidence_columns FROM pg_attribute
  WHERE attrelid='chain_transaction_inbox'::REGCLASS AND attnum>0 AND NOT attisdropped
    AND attname IN ('first_detected_at','first_processed_at','first_processing_evidence_unavailable');
  IF evidence_columns NOT IN (0,3) THEN
    RAISE EXCEPTION 'first processing evidence columns are partially installed' USING ERRCODE='23514';
  END IF;
  IF evidence_columns=3 AND EXISTS (
    SELECT 1 FROM pg_attribute attribute
    LEFT JOIN pg_attrdef attribute_default ON attribute_default.adrelid=attribute.attrelid
      AND attribute_default.adnum=attribute.attnum
    WHERE attribute.attrelid='chain_transaction_inbox'::REGCLASS AND attribute.attnum>0
      AND NOT attribute.attisdropped AND (
        (attribute.attname='first_detected_at'
          AND (attribute.atttypid<>'timestamp with time zone'::REGTYPE OR attribute.attnotnull
            OR attribute.attgenerated<>'' OR attribute.attidentity<>''
            OR pg_get_expr(attribute_default.adbin,attribute_default.adrelid)
              IS DISTINCT FROM 'date_trunc(''milliseconds''::text, clock_timestamp())'))
        OR (attribute.attname='first_processed_at'
          AND (attribute.atttypid<>'timestamp with time zone'::REGTYPE OR attribute.attnotnull
            OR attribute.attgenerated<>'' OR attribute.attidentity<>''
            OR pg_get_expr(attribute_default.adbin,attribute_default.adrelid) IS NOT NULL))
        OR (attribute.attname='first_processing_evidence_unavailable'
          AND (attribute.atttypid<>'boolean'::REGTYPE OR NOT attribute.attnotnull
            OR attribute.attgenerated<>'' OR attribute.attidentity<>''
            OR pg_get_expr(attribute_default.adbin,attribute_default.adrelid) IS DISTINCT FROM 'false'))
      )
  ) THEN
    RAISE EXCEPTION 'first processing evidence column definition is incompatible' USING ERRCODE='23514';
  END IF;
  IF evidence_columns=3 AND (
    NOT EXISTS (SELECT 1 FROM pg_constraint constraint_row WHERE conrelid='chain_transaction_inbox'::REGCLASS
      AND conname='chain_transaction_inbox_first_processing_evidence_check' AND convalidated
      AND md5(pg_get_constraintdef(constraint_row.oid))='356124000df96715acd94b9508e098ae')
    OR NOT EXISTS (SELECT 1 FROM pg_class index_class
      WHERE index_class.relname='chain_transaction_inbox_first_processing_cohort_idx'
        AND index_class.relnamespace=current_schema()::REGNAMESPACE
        AND pg_get_indexdef(index_class.oid)=format(
          'CREATE INDEX %I ON %I.chain_transaction_inbox USING btree (first_detected_at, signature)',
          'chain_transaction_inbox_first_processing_cohort_idx',current_schema()))
    OR NOT EXISTS (SELECT 1 FROM pg_proc routine
      WHERE routine.proname='transaction_inbox_first_processing_guard'
        AND md5(routine.prosrc)='e6f6758351b3701892f22e3fe6fb8373')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger trigger_row
      WHERE trigger_row.tgrelid='chain_transaction_inbox'::REGCLASS
        AND trigger_row.tgname='chain_transaction_inbox_first_processing_guard'
        AND trigger_row.tgfoid IN (SELECT oid FROM pg_proc
          WHERE proname='transaction_inbox_first_processing_guard')
        AND trigger_row.tgtype=19)
  ) THEN
    RAISE EXCEPTION 'first processing evidence definition is incompatible' USING ERRCODE='23514';
  END IF;
  DROP TABLE IF EXISTS pg_temp.migration_050_preflight;
  CREATE TEMP TABLE pg_temp.migration_050_preflight(first_install BOOLEAN NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp.migration_050_preflight(first_install) VALUES (evidence_columns=0);
END;
$migration_050_preflight$;

ALTER TABLE chain_transaction_inbox
  ADD COLUMN IF NOT EXISTS first_detected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_processed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_processing_evidence_unavailable BOOLEAN NOT NULL DEFAULT FALSE;

-- This UPDATE is only reachable on the first installation: replay preflight
-- above requires the complete already-installed definition.
UPDATE chain_transaction_inbox
SET first_processing_evidence_unavailable=TRUE,
    first_detected_at=NULL,
    first_processed_at=NULL
FROM pg_temp.migration_050_preflight preflight
WHERE preflight.first_install
  AND (NOT first_processing_evidence_unavailable
   OR first_detected_at IS NOT NULL
   OR first_processed_at IS NOT NULL);

ALTER TABLE chain_transaction_inbox
  ALTER COLUMN first_detected_at SET DEFAULT date_trunc('milliseconds', clock_timestamp());

DO $migration_050_install_constraint$
BEGIN
  IF (SELECT first_install FROM pg_temp.migration_050_preflight) THEN
    ALTER TABLE chain_transaction_inbox
      ADD CONSTRAINT chain_transaction_inbox_first_processing_evidence_check CHECK (
        (first_detected_at IS NULL OR (
          isfinite(first_detected_at)
          AND first_detected_at<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
          AND date_trunc('milliseconds',first_detected_at)=first_detected_at
        ))
        AND (first_processed_at IS NULL OR (
          isfinite(first_processed_at)
          AND first_processed_at<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
          AND date_trunc('milliseconds',first_processed_at)=first_processed_at
        ))
        AND (NOT first_processing_evidence_unavailable OR first_processed_at IS NULL)
        AND (first_processed_at IS NULL OR first_detected_at IS NOT NULL)
      );
    CREATE INDEX chain_transaction_inbox_first_processing_cohort_idx
      ON chain_transaction_inbox (first_detected_at, signature);
  END IF;
END;
$migration_050_install_constraint$;

CREATE OR REPLACE FUNCTION transaction_inbox_first_processing_guard()
RETURNS trigger LANGUAGE plpgsql AS $transaction_inbox_first_processing_guard$
BEGIN
  -- first processing guard v1 immutable
  IF NEW.first_detected_at IS DISTINCT FROM OLD.first_detected_at THEN
    RAISE EXCEPTION 'chain_transaction_inbox.first_detected_at is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.first_processing_evidence_unavailable AND NOT NEW.first_processing_evidence_unavailable THEN
    RAISE EXCEPTION 'chain_transaction_inbox.first_processing_evidence_unavailable is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.first_processed_at IS NOT NULL
     AND NEW.first_processed_at IS DISTINCT FROM OLD.first_processed_at THEN
    RAISE EXCEPTION 'chain_transaction_inbox.first_processed_at is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.first_processed_at IS NULL AND NEW.first_processed_at IS NOT NULL
     AND NOT (OLD.first_processing_evidence_unavailable=FALSE
       AND NEW.first_processing_evidence_unavailable=FALSE
       AND OLD.processing_status='PROCESSING' AND NEW.processing_status='PROCESSED'
       AND OLD.lease_token IS NOT NULL AND NEW.lease_token IS NULL
       AND NEW.first_processed_at=NEW.processed_at) THEN
    RAISE EXCEPTION 'chain_transaction_inbox.first_processed_at is immutable' USING ERRCODE='23514';
  END IF;
  -- A rolling old binary does not supply the new column on its successful
  -- lease completion. Mark it unavailable; never infer a synthetic time.
  IF OLD.first_processed_at IS NULL AND NEW.first_processed_at IS NULL
     AND OLD.first_processing_evidence_unavailable=FALSE
     AND NEW.first_processing_evidence_unavailable=FALSE
     AND OLD.processing_status='PROCESSING' AND NEW.processing_status='PROCESSED'
     AND OLD.lease_token IS NOT NULL AND NEW.lease_token IS NULL THEN
    NEW.first_processing_evidence_unavailable := TRUE;
  END IF;
  RETURN NEW;
END;
$transaction_inbox_first_processing_guard$;

DO $migration_050_install_trigger$
BEGIN
  IF (SELECT first_install FROM pg_temp.migration_050_preflight) THEN
    CREATE TRIGGER chain_transaction_inbox_first_processing_guard
      BEFORE UPDATE ON chain_transaction_inbox
      FOR EACH ROW EXECUTE FUNCTION transaction_inbox_first_processing_guard();
  END IF;
END;
$migration_050_install_trigger$;

DO $migration_050_verify$
DECLARE first_detected_default TEXT;
BEGIN
  SELECT pg_get_expr(default_value.adbin,default_value.adrelid) INTO first_detected_default
  FROM pg_attribute attribute JOIN pg_attrdef default_value ON default_value.adrelid=attribute.attrelid
    AND default_value.adnum=attribute.attnum
  WHERE attribute.attrelid='chain_transaction_inbox'::REGCLASS AND attribute.attname='first_detected_at';
  IF first_detected_default IS DISTINCT FROM 'date_trunc(''milliseconds''::text, clock_timestamp())'
    OR NOT EXISTS (SELECT 1 FROM pg_constraint constraint_row
      WHERE constraint_row.conrelid='chain_transaction_inbox'::REGCLASS
        AND constraint_row.conname='chain_transaction_inbox_first_processing_evidence_check'
        AND constraint_row.convalidated
        AND md5(pg_get_constraintdef(constraint_row.oid))='356124000df96715acd94b9508e098ae')
    OR NOT EXISTS (SELECT 1 FROM pg_class index_class
      WHERE index_class.relname='chain_transaction_inbox_first_processing_cohort_idx'
        AND index_class.relnamespace=current_schema()::REGNAMESPACE
        AND pg_get_indexdef(index_class.oid)=format(
          'CREATE INDEX %I ON %I.chain_transaction_inbox USING btree (first_detected_at, signature)',
          'chain_transaction_inbox_first_processing_cohort_idx',current_schema()))
    OR NOT EXISTS (SELECT 1 FROM pg_proc routine
      WHERE routine.proname='transaction_inbox_first_processing_guard'
        AND md5(routine.prosrc)='e6f6758351b3701892f22e3fe6fb8373')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger trigger_row
      WHERE trigger_row.tgrelid='chain_transaction_inbox'::REGCLASS
        AND trigger_row.tgname='chain_transaction_inbox_first_processing_guard'
        AND trigger_row.tgfoid IN (SELECT oid FROM pg_proc
          WHERE proname='transaction_inbox_first_processing_guard')
        AND trigger_row.tgtype=19) THEN
    RAISE EXCEPTION 'first processing evidence definition is incompatible' USING ERRCODE='23514';
  END IF;
END;
$migration_050_verify$;
