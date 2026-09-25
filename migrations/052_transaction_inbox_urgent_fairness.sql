-- Durable nested fairness: retain the 32:1 urgent/normal fence and bound
-- launch/tracked-trade claims to 3:1 without increasing worker/RPC concurrency.
DO $migration_052$
DECLARE
  fairness_columns INTEGER;
  first_install BOOLEAN;
  actual_constraints TEXT[];
  expected_constraints TEXT[];
  actual_index OID;
  expected_index OID;
BEGIN
  PERFORM set_config('TimeZone','UTC',true);
  PERFORM set_config('DateStyle','ISO, YMD',true);
  LOCK TABLE chain_transaction_inbox, chain_transaction_inbox_claim_scheduler
    IN ACCESS EXCLUSIVE MODE;

  IF NOT EXISTS (SELECT 1 FROM pg_class relation
      WHERE relation.oid='chain_transaction_inbox_claim_scheduler'::REGCLASS
        AND relation.relkind='r' AND relation.relpersistence='p') THEN
    RAISE EXCEPTION 'transaction inbox claim scheduler relation is incompatible';
  END IF;
  SELECT COUNT(*) INTO fairness_columns FROM pg_attribute
  WHERE attrelid='chain_transaction_inbox_claim_scheduler'::REGCLASS
    AND attnum>0 AND NOT attisdropped AND attname='launch_claims_since_tracked';
  IF fairness_columns NOT IN (0,1) THEN
    RAISE EXCEPTION 'transaction inbox claim scheduler fairness column is partial';
  END IF;
  first_install := fairness_columns=0;
  IF (SELECT COUNT(*) FROM pg_attribute
      WHERE attrelid='chain_transaction_inbox_claim_scheduler'::REGCLASS
        AND attnum>0 AND NOT attisdropped) <> (CASE WHEN first_install THEN 4 ELSE 5 END) THEN
    RAISE EXCEPTION 'transaction inbox claim scheduler columns are incompatible';
  END IF;
  IF (SELECT COUNT(*) FROM chain_transaction_inbox_claim_scheduler)<>1
    OR NOT EXISTS (SELECT 1 FROM chain_transaction_inbox_claim_scheduler
      WHERE scheduler_key='global') THEN
    RAISE EXCEPTION 'transaction inbox claim scheduler singleton is incompatible';
  END IF;

  DROP TABLE IF EXISTS pg_temp.migration_052_scheduler_expected;
  CREATE TEMP TABLE pg_temp.migration_052_scheduler_expected (
    scheduler_key TEXT NOT NULL,
    consecutive_urgent_claims SMALLINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    launch_claims_since_tracked SMALLINT NOT NULL DEFAULT 0,
    CONSTRAINT chain_transaction_inbox_claim_scheduler_pkey PRIMARY KEY (scheduler_key),
    CONSTRAINT chain_transaction_inbox_claim_scheduler_key_check CHECK (scheduler_key='global'),
    CONSTRAINT chain_transaction_inbox_claim_scheduler_streak_check CHECK (
      consecutive_urgent_claims BETWEEN 0 AND 32
    ),
    CONSTRAINT chain_transaction_inbox_claim_scheduler_timestamps_check CHECK (
      updated_at>=created_at
    ),
    CONSTRAINT chain_transaction_inbox_claim_scheduler_launch_fairness_check CHECK (
      launch_claims_since_tracked BETWEEN 0 AND 3
    )
  ) ON COMMIT DROP;

  IF EXISTS (
    SELECT 1 FROM pg_attribute expected
    LEFT JOIN pg_attribute actual
      ON actual.attrelid='chain_transaction_inbox_claim_scheduler'::REGCLASS
      AND actual.attnum>0 AND NOT actual.attisdropped AND actual.attname=expected.attname
    LEFT JOIN pg_attrdef expected_default ON expected_default.adrelid=expected.attrelid
      AND expected_default.adnum=expected.attnum
    LEFT JOIN pg_attrdef actual_default ON actual_default.adrelid=actual.attrelid
      AND actual_default.adnum=actual.attnum
    WHERE expected.attrelid='pg_temp.migration_052_scheduler_expected'::REGCLASS
      AND expected.attnum>0 AND NOT expected.attisdropped
      AND (actual.attname IS NULL AND (NOT first_install OR expected.attname<>'launch_claims_since_tracked')
        OR actual.attname IS NOT NULL AND (
          actual.atttypid<>expected.atttypid OR actual.atttypmod<>expected.atttypmod
          OR actual.attnotnull<>expected.attnotnull
          OR actual.attidentity<>expected.attidentity OR actual.attgenerated<>expected.attgenerated
          OR actual.attcollation<>expected.attcollation
          OR pg_get_expr(actual_default.adbin,actual_default.adrelid)
            IS DISTINCT FROM pg_get_expr(expected_default.adbin,expected_default.adrelid)
        ))
  ) THEN
    RAISE EXCEPTION 'transaction inbox claim scheduler column definition is incompatible';
  END IF;

  SELECT ARRAY(SELECT conname||':'||convalidated||':'||pg_get_constraintdef(oid)
    FROM pg_constraint WHERE conrelid='chain_transaction_inbox_claim_scheduler'::REGCLASS
    ORDER BY conname) INTO actual_constraints;
  SELECT ARRAY(SELECT conname||':'||convalidated||':'||pg_get_constraintdef(oid)
    FROM pg_constraint WHERE conrelid='pg_temp.migration_052_scheduler_expected'::REGCLASS
      AND (NOT first_install
        OR conname<>'chain_transaction_inbox_claim_scheduler_launch_fairness_check')
    ORDER BY conname) INTO expected_constraints;
  IF actual_constraints IS DISTINCT FROM expected_constraints THEN
    RAISE EXCEPTION 'transaction inbox claim scheduler constraint definition is incompatible';
  END IF;

  IF first_install THEN
    IF to_regclass(format('%I.%I',current_schema(),
      'chain_transaction_inbox_priority_claim_order_idx')) IS NOT NULL THEN
      RAISE EXCEPTION 'transaction inbox priority claim index is incompatible';
    END IF;
    ALTER TABLE chain_transaction_inbox_claim_scheduler
      ADD COLUMN launch_claims_since_tracked SMALLINT NOT NULL DEFAULT 0;
    ALTER TABLE chain_transaction_inbox_claim_scheduler
      ADD CONSTRAINT chain_transaction_inbox_claim_scheduler_launch_fairness_check
      CHECK (launch_claims_since_tracked BETWEEN 0 AND 3);
  END IF;

  DROP TABLE IF EXISTS pg_temp.migration_052_inbox_expected;
  CREATE TEMP TABLE pg_temp.migration_052_inbox_expected (
    ingestion_priority chain_transaction_inbox_priority,
    observed_slot NUMERIC(78,0),
    signature TEXT,
    processing_status TEXT,
    error_retryable BOOLEAN,
    retry_exhausted_at TIMESTAMPTZ
  ) ON COMMIT DROP;
  CREATE INDEX migration_052_priority_claim_expected
    ON pg_temp.migration_052_inbox_expected (
      ingestion_priority, observed_slot, signature
    )
    WHERE processing_status='PENDING' OR processing_status='PROCESSING'
      OR (processing_status='FAILED' AND error_retryable=TRUE
        AND retry_exhausted_at IS NULL);

  IF first_install THEN
    CREATE INDEX chain_transaction_inbox_priority_claim_order_idx
      ON chain_transaction_inbox (ingestion_priority, observed_slot, signature)
      WHERE processing_status='PENDING' OR processing_status='PROCESSING'
        OR (processing_status='FAILED' AND error_retryable=TRUE
          AND retry_exhausted_at IS NULL);
  END IF;
  SELECT relation.oid INTO actual_index FROM pg_class relation
  JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
  WHERE namespace.nspname=current_schema()
    AND relation.relname='chain_transaction_inbox_priority_claim_order_idx';
  SELECT relation.oid INTO expected_index FROM pg_class relation
  WHERE relation.relnamespace=pg_my_temp_schema()
    AND relation.relname='migration_052_priority_claim_expected';
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
      AND pg_get_expr(actual.indpred,actual.indrelid)
        IS NOT DISTINCT FROM pg_get_expr(expected.indpred,expected.indrelid)
      AND ARRAY(SELECT pg_get_indexdef(actual.indexrelid,column_number,TRUE)
        FROM generate_series(1,actual.indnatts) column_number)
        = ARRAY(SELECT pg_get_indexdef(expected.indexrelid,column_number,TRUE)
          FROM generate_series(1,expected.indnatts) column_number)
  ) THEN
    RAISE EXCEPTION 'transaction inbox priority claim index definition is incompatible';
  END IF;

  SELECT ARRAY(SELECT conname||':'||convalidated||':'||pg_get_constraintdef(oid)
    FROM pg_constraint WHERE conrelid='chain_transaction_inbox_claim_scheduler'::REGCLASS
    ORDER BY conname) INTO actual_constraints;
  SELECT ARRAY(SELECT conname||':'||convalidated||':'||pg_get_constraintdef(oid)
    FROM pg_constraint WHERE conrelid='pg_temp.migration_052_scheduler_expected'::REGCLASS
    ORDER BY conname) INTO expected_constraints;
  IF actual_constraints IS DISTINCT FROM expected_constraints THEN
    RAISE EXCEPTION 'transaction inbox claim scheduler installed constraints are incompatible';
  END IF;
END;
$migration_052$;
