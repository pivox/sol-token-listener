-- Inactive durable worker-admission foundation. Claim behavior remains owned by
-- migration 052 until the separately gated admission/classification delivery.
DO $migration_053_preflight$
DECLARE admission_columns INTEGER;
BEGIN
  PERFORM set_config('TimeZone','UTC',true);
  PERFORM set_config('DateStyle','ISO, YMD',true);
  LOCK TABLE chain_transaction_inbox IN ACCESS EXCLUSIVE MODE;

  SELECT COUNT(*) INTO admission_columns FROM pg_attribute
  WHERE attrelid='chain_transaction_inbox'::REGCLASS AND attnum>0 AND NOT attisdropped
    AND attname='worker_admitted_at';
  IF admission_columns NOT IN (0,1) THEN
    RAISE EXCEPTION 'transaction inbox worker admission column is partial' USING ERRCODE='23514';
  END IF;

  DROP TABLE IF EXISTS pg_temp.migration_053_state;
  CREATE TEMP TABLE pg_temp.migration_053_state (
    first_install BOOLEAN NOT NULL
  ) ON COMMIT DROP;
  INSERT INTO pg_temp.migration_053_state(first_install) VALUES (admission_columns=0);
END;
$migration_053_preflight$;

DROP TABLE IF EXISTS pg_temp.migration_053_expected;
CREATE TEMP TABLE pg_temp.migration_053_expected (
  worker_admitted_at TIMESTAMPTZ,
  processing_status TEXT,
  attempts INTEGER,
  attempts_in_cycle INTEGER,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  normalized_transaction JSONB,
  immutable_fingerprint TEXT,
  error_code TEXT,
  error_name TEXT,
  error_retryable BOOLEAN,
  processed_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  retry_exhausted_at TIMESTAMPTZ,
  missing_finality_polls INTEGER,
  last_missing_finality_provider_id TEXT,
  finality_evidence_version BIGINT,
  manual_recovery_count INTEGER,
  last_manual_recovery_at TIMESTAMPTZ,
  first_processed_at TIMESTAMPTZ,
  decoder_quarantine_eligible_at TIMESTAMPTZ,
  decoder_recovery_used BOOLEAN,
  ingestion_priority chain_transaction_inbox_priority,
  observed_at TIMESTAMPTZ,
  observed_slot NUMERIC(78,0),
  signature TEXT,
  CONSTRAINT chain_transaction_inbox_worker_admission_check CHECK (
    (worker_admitted_at IS NOT NULL AND isfinite(worker_admitted_at))
    OR (worker_admitted_at IS NULL
      AND processing_status NOT IN ('PROCESSING','PROCESSED','FAILED')
      AND attempts=0 AND attempts_in_cycle=0
      AND lease_token IS NULL AND lease_expires_at IS NULL
      AND normalized_transaction IS NULL AND immutable_fingerprint IS NULL
      AND error_code IS NULL AND error_name IS NULL AND error_retryable IS NULL
      AND processed_at IS NULL AND next_attempt_at IS NULL AND retry_exhausted_at IS NULL
      AND missing_finality_polls=0 AND last_missing_finality_provider_id IS NULL
      AND finality_evidence_version=0
      AND manual_recovery_count=0 AND last_manual_recovery_at IS NULL
      AND first_processed_at IS NULL
      AND decoder_quarantine_eligible_at IS NULL AND decoder_recovery_used=FALSE)
  )
) ON COMMIT DROP;

CREATE INDEX migration_053_admitted_claim_expected
  ON pg_temp.migration_053_expected (ingestion_priority,observed_slot,signature)
  WHERE worker_admitted_at IS NOT NULL AND (
    processing_status='PENDING' OR processing_status='PROCESSING'
    OR (processing_status='FAILED' AND error_retryable=TRUE AND retry_exhausted_at IS NULL)
  );
CREATE INDEX migration_053_classification_pending_expected
  ON pg_temp.migration_053_expected (observed_at,observed_slot,signature)
  WHERE processing_status='PENDING' AND worker_admitted_at IS NULL;

CREATE OR REPLACE FUNCTION pg_temp.migration_053_guard_expected()
RETURNS trigger LANGUAGE plpgsql AS $transaction_inbox_worker_admission_guard$
BEGIN
  IF OLD.worker_admitted_at IS NOT NULL
     AND NEW.worker_admitted_at IS DISTINCT FROM OLD.worker_admitted_at THEN
    RAISE EXCEPTION 'chain_transaction_inbox.worker_admitted_at is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$transaction_inbox_worker_admission_guard$;

CREATE OR REPLACE FUNCTION pg_temp.migration_053_validate_installed()
RETURNS VOID LANGUAGE plpgsql AS $migration_053_validate_installed$
DECLARE
  actual_constraint TEXT;
  expected_constraint TEXT;
  actual_function OID;
  expected_function OID;
  actual_index OID;
  expected_index OID;
  actual_index_name TEXT;
  expected_index_name TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute attribute
    LEFT JOIN pg_attrdef attribute_default ON attribute_default.adrelid=attribute.attrelid
      AND attribute_default.adnum=attribute.attnum
    WHERE attribute.attrelid='chain_transaction_inbox'::REGCLASS
      AND attribute.attname='worker_admitted_at' AND attribute.attnum>0
      AND NOT attribute.attisdropped
      AND attribute.atttypid='timestamp with time zone'::REGTYPE
      AND attribute.atttypmod=-1 AND NOT attribute.attnotnull
      AND attribute.attgenerated='' AND attribute.attidentity=''
      AND pg_get_expr(attribute_default.adbin,attribute_default.adrelid) IS NULL
  ) THEN
    RAISE EXCEPTION 'transaction inbox worker admission column is incompatible'
      USING ERRCODE='23514';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO actual_constraint FROM pg_constraint
  WHERE conrelid='chain_transaction_inbox'::REGCLASS
    AND conname='chain_transaction_inbox_worker_admission_check' AND contype='c' AND convalidated;
  SELECT pg_get_constraintdef(oid) INTO expected_constraint FROM pg_constraint
  WHERE conrelid='pg_temp.migration_053_expected'::REGCLASS
    AND conname='chain_transaction_inbox_worker_admission_check' AND contype='c' AND convalidated;
  IF actual_constraint IS DISTINCT FROM expected_constraint THEN
    RAISE EXCEPTION 'transaction inbox worker admission constraint is incompatible'
      USING ERRCODE='23514';
  END IF;

  SELECT oid INTO actual_function FROM pg_proc
  WHERE pronamespace=current_schema()::REGNAMESPACE
    AND proname='transaction_inbox_worker_admission_guard' AND pronargs=0;
  SELECT oid INTO expected_function FROM pg_proc
  WHERE pronamespace=pg_my_temp_schema()
    AND proname='migration_053_guard_expected' AND pronargs=0;
  IF actual_function IS NULL OR expected_function IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_proc actual JOIN pg_proc expected ON expected.oid=expected_function
    WHERE actual.oid=actual_function
      AND actual.prorettype=expected.prorettype AND actual.prokind=expected.prokind
      AND actual.provolatile=expected.provolatile AND actual.prosecdef=expected.prosecdef
      AND actual.proleakproof=expected.proleakproof AND actual.proparallel=expected.proparallel
      AND actual.proconfig IS NOT DISTINCT FROM expected.proconfig
      AND actual.prosrc=expected.prosrc
  ) THEN
    RAISE EXCEPTION 'transaction inbox worker admission function is incompatible'
      USING ERRCODE='23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid='chain_transaction_inbox'::REGCLASS
      AND trigger_row.tgname='chain_transaction_inbox_worker_admission_guard'
      AND NOT trigger_row.tgisinternal AND trigger_row.tgfoid=actual_function
      AND trigger_row.tgtype=19 AND trigger_row.tgenabled='O'
      AND trigger_row.tgattr=''::INT2VECTOR AND trigger_row.tgqual IS NULL
  ) THEN
    RAISE EXCEPTION 'transaction inbox worker admission trigger is incompatible'
      USING ERRCODE='23514';
  END IF;

  FOR actual_index_name, expected_index_name IN VALUES
    ('chain_transaction_inbox_worker_admitted_claim_idx','migration_053_admitted_claim_expected'),
    ('chain_transaction_inbox_worker_classification_pending_idx','migration_053_classification_pending_expected')
  LOOP
    SELECT relation.oid INTO actual_index FROM pg_class relation
    WHERE relation.relnamespace=current_schema()::REGNAMESPACE
      AND relation.relname=actual_index_name;
    SELECT relation.oid INTO expected_index FROM pg_class relation
    WHERE relation.relnamespace=pg_my_temp_schema() AND relation.relname=expected_index_name;
    IF actual_index IS NULL OR expected_index IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_index actual
      JOIN pg_class actual_relation ON actual_relation.oid=actual.indexrelid
      JOIN pg_index expected ON expected.indexrelid=expected_index
      JOIN pg_class expected_relation ON expected_relation.oid=expected.indexrelid
      WHERE actual.indexrelid=actual_index
        AND actual.indrelid='chain_transaction_inbox'::REGCLASS
        AND actual.indisvalid AND actual.indisready
        AND NOT actual.indisunique AND NOT actual.indisprimary
        AND actual_relation.relam=expected_relation.relam
        AND actual_relation.reloptions IS NOT DISTINCT FROM expected_relation.reloptions
        AND actual.indnkeyatts=expected.indnkeyatts AND actual.indnatts=expected.indnatts
        AND actual.indoption=expected.indoption AND actual.indclass=expected.indclass
        AND actual.indcollation=expected.indcollation
        AND pg_get_expr(actual.indexprs,actual.indrelid)
          IS NOT DISTINCT FROM pg_get_expr(expected.indexprs,expected.indrelid)
        AND pg_get_expr(actual.indpred,actual.indrelid)
          IS NOT DISTINCT FROM pg_get_expr(expected.indpred,expected.indrelid)
        AND ARRAY(SELECT pg_get_indexdef(actual.indexrelid,column_number,TRUE)
          FROM generate_series(1,actual.indnatts) column_number)
          = ARRAY(SELECT pg_get_indexdef(expected.indexrelid,column_number,TRUE)
            FROM generate_series(1,expected.indnatts) column_number)
    ) THEN
      RAISE EXCEPTION '% index definition is incompatible',actual_index_name
        USING ERRCODE='23514';
    END IF;
  END LOOP;
END;
$migration_053_validate_installed$;

DO $migration_053_validate_or_reserve$
BEGIN
  IF (SELECT first_install FROM pg_temp.migration_053_state) THEN
    IF EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid='chain_transaction_inbox'::REGCLASS
          AND conname='chain_transaction_inbox_worker_admission_check')
      OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace=current_schema()::REGNAMESPACE
        AND proname='transaction_inbox_worker_admission_guard')
      OR EXISTS (SELECT 1 FROM pg_trigger
        WHERE tgrelid='chain_transaction_inbox'::REGCLASS
          AND tgname='chain_transaction_inbox_worker_admission_guard')
      OR to_regclass(format('%I.%I',current_schema(),
        'chain_transaction_inbox_worker_admitted_claim_idx')) IS NOT NULL
      OR to_regclass(format('%I.%I',current_schema(),
        'chain_transaction_inbox_worker_classification_pending_idx')) IS NOT NULL THEN
      RAISE EXCEPTION 'transaction inbox worker admission objects are incompatible'
        USING ERRCODE='23514';
    END IF;
  ELSE
    PERFORM pg_temp.migration_053_validate_installed();
  END IF;
END;
$migration_053_validate_or_reserve$;

ALTER TABLE chain_transaction_inbox
  ADD COLUMN IF NOT EXISTS worker_admitted_at TIMESTAMPTZ;

UPDATE chain_transaction_inbox
SET worker_admitted_at=observed_at
FROM pg_temp.migration_053_state state
WHERE state.first_install AND worker_admitted_at IS NULL
  AND processing_status IN ('PENDING','PROCESSING','PROCESSED','FAILED');

DO $migration_053_install$
BEGIN
  IF (SELECT first_install FROM pg_temp.migration_053_state) THEN
    ALTER TABLE chain_transaction_inbox
      ADD CONSTRAINT chain_transaction_inbox_worker_admission_check CHECK (
        (worker_admitted_at IS NOT NULL AND isfinite(worker_admitted_at))
        OR (worker_admitted_at IS NULL
          AND processing_status NOT IN ('PROCESSING','PROCESSED','FAILED')
          AND attempts=0 AND attempts_in_cycle=0
          AND lease_token IS NULL AND lease_expires_at IS NULL
          AND normalized_transaction IS NULL AND immutable_fingerprint IS NULL
          AND error_code IS NULL AND error_name IS NULL AND error_retryable IS NULL
          AND processed_at IS NULL AND next_attempt_at IS NULL AND retry_exhausted_at IS NULL
          AND missing_finality_polls=0 AND last_missing_finality_provider_id IS NULL
          AND finality_evidence_version=0
          AND manual_recovery_count=0 AND last_manual_recovery_at IS NULL
          AND first_processed_at IS NULL
          AND decoder_quarantine_eligible_at IS NULL AND decoder_recovery_used=FALSE)
      );
    CREATE INDEX chain_transaction_inbox_worker_admitted_claim_idx
      ON chain_transaction_inbox (ingestion_priority,observed_slot,signature)
      WHERE worker_admitted_at IS NOT NULL AND (
        processing_status='PENDING' OR processing_status='PROCESSING'
        OR (processing_status='FAILED' AND error_retryable=TRUE AND retry_exhausted_at IS NULL)
      );
    CREATE INDEX chain_transaction_inbox_worker_classification_pending_idx
      ON chain_transaction_inbox (observed_at,observed_slot,signature)
      WHERE processing_status='PENDING' AND worker_admitted_at IS NULL;
  END IF;
END;
$migration_053_install$;

CREATE OR REPLACE FUNCTION transaction_inbox_worker_admission_guard()
RETURNS trigger LANGUAGE plpgsql AS $transaction_inbox_worker_admission_guard$
BEGIN
  IF OLD.worker_admitted_at IS NOT NULL
     AND NEW.worker_admitted_at IS DISTINCT FROM OLD.worker_admitted_at THEN
    RAISE EXCEPTION 'chain_transaction_inbox.worker_admitted_at is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$transaction_inbox_worker_admission_guard$;

DO $migration_053_install_trigger$
BEGIN
  IF (SELECT first_install FROM pg_temp.migration_053_state) THEN
    CREATE TRIGGER chain_transaction_inbox_worker_admission_guard
      BEFORE UPDATE ON chain_transaction_inbox
      FOR EACH ROW EXECUTE FUNCTION transaction_inbox_worker_admission_guard();
  END IF;
END;
$migration_053_install_trigger$;

SELECT pg_temp.migration_053_validate_installed();
