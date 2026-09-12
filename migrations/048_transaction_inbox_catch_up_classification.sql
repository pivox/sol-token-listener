-- Inactive durable contract for block-aware catch-up classification. Runtime
-- activation belongs to later changes; this migration only records evidence.
DO $$
DECLARE
  classification_columns INTEGER;
  classified_counter_columns INTEGER;
BEGIN
  LOCK TABLE chain_transaction_inbox, listener_strict_catch_up_runs IN ACCESS EXCLUSIVE MODE;
  SELECT COUNT(*) INTO classification_columns
  FROM pg_attribute
  WHERE attrelid='chain_transaction_inbox'::REGCLASS AND attnum>0 AND NOT attisdropped
    AND attname IN ('catch_up_classification_version','catch_up_disposition','catch_up_reason_code',
      'catch_up_action_key','catch_up_mints','catch_up_evidence_fingerprint','catch_up_classified_at');
  IF classification_columns NOT IN (0,7) THEN
    RAISE EXCEPTION 'catch-up classification column definition is incompatible' USING ERRCODE='23514';
  END IF;
  IF classification_columns=7 AND EXISTS (
    SELECT 1 FROM (VALUES
      ('catch_up_classification_version','smallint',FALSE,NULL),
      ('catch_up_disposition','text',FALSE,NULL),
      ('catch_up_reason_code','text',FALSE,NULL),
      ('catch_up_action_key','text',FALSE,NULL),
      ('catch_up_mints','text[]',FALSE,NULL),
      ('catch_up_evidence_fingerprint','text',FALSE,NULL),
      ('catch_up_classified_at','timestamp with time zone',FALSE,NULL)
    ) expected(column_name,column_type,not_null,default_value)
    LEFT JOIN pg_attribute attribute ON attribute.attrelid='chain_transaction_inbox'::REGCLASS
      AND attribute.attname=expected.column_name AND attribute.attnum>0 AND NOT attribute.attisdropped
    LEFT JOIN pg_attrdef attribute_default ON attribute_default.adrelid=attribute.attrelid
      AND attribute_default.adnum=attribute.attnum
    WHERE attribute.attnum IS NULL OR format_type(attribute.atttypid,attribute.atttypmod)<>expected.column_type
      OR attribute.attnotnull<>expected.not_null OR attribute.attgenerated<>'' OR attribute.attidentity<>''
      OR pg_get_expr(attribute_default.adbin,attribute_default.adrelid) IS DISTINCT FROM expected.default_value
  ) THEN
    RAISE EXCEPTION 'catch-up classification column definition is incompatible' USING ERRCODE='23514';
  END IF;
  SELECT COUNT(*) INTO classified_counter_columns FROM pg_attribute
  WHERE attrelid='listener_strict_catch_up_runs'::REGCLASS AND attnum>0 AND NOT attisdropped
    AND attname='signatures_classified';
  IF classified_counter_columns NOT IN (0,1) THEN
    RAISE EXCEPTION 'strict catch-up classified counter definition is incompatible' USING ERRCODE='23514';
  END IF;
  IF classified_counter_columns=1 AND EXISTS (
    SELECT 1 FROM pg_attribute attribute
    LEFT JOIN pg_attrdef attribute_default ON attribute_default.adrelid=attribute.attrelid
      AND attribute_default.adnum=attribute.attnum
    WHERE attribute.attrelid='listener_strict_catch_up_runs'::REGCLASS
      AND attribute.attname='signatures_classified' AND attribute.attnum>0 AND NOT attribute.attisdropped
      AND (format_type(attribute.atttypid,attribute.atttypmod)<>'bigint' OR NOT attribute.attnotnull
        OR attribute.attgenerated<>'' OR attribute.attidentity<>''
        OR pg_get_expr(attribute_default.adbin,attribute_default.adrelid) IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'strict catch-up classified counter definition is incompatible' USING ERRCODE='23514';
  END IF;
  IF (classification_columns=0)<>(classified_counter_columns=0) THEN
    RAISE EXCEPTION 'catch-up classification schema is partially installed' USING ERRCODE='23514';
  END IF;

  DROP TABLE IF EXISTS pg_temp.migration_048_preflight;
  CREATE TEMP TABLE pg_temp.migration_048_preflight (
    replay BOOLEAN NOT NULL
  ) ON COMMIT DROP;
  INSERT INTO pg_temp.migration_048_preflight VALUES (classification_columns=7);

  DROP TABLE IF EXISTS pg_temp.migration_048_constraints;
  CREATE TEMP TABLE pg_temp.migration_048_constraints (
    relation_name TEXT NOT NULL,
    constraint_name TEXT NOT NULL,
    validated BOOLEAN NOT NULL,
    definition TEXT NOT NULL,
    PRIMARY KEY (relation_name,constraint_name)
  ) ON COMMIT DROP;
  INSERT INTO pg_temp.migration_048_constraints
    (relation_name,constraint_name,validated,definition)
  SELECT relation.relname,constraint_row.conname,constraint_row.convalidated,
    pg_get_constraintdef(constraint_row.oid)
  FROM pg_constraint constraint_row
  JOIN pg_class relation ON relation.oid=constraint_row.conrelid
  WHERE (relation.oid='chain_transaction_inbox'::REGCLASS
      AND constraint_row.conname IN ('chain_transaction_inbox_processing_status_check',
        'chain_transaction_inbox_terminal_check',
        'chain_transaction_inbox_catch_up_classification_check',
        'chain_transaction_inbox_catch_up_terminal_check'))
    OR (relation.oid='listener_strict_catch_up_runs'::REGCLASS
      AND constraint_row.conname IN ('listener_strict_catch_up_runs_numeric_bounds_check',
        'listener_strict_catch_up_runs_cursor_order_check'));
END;
$$;

CREATE OR REPLACE FUNCTION transaction_inbox_solana_public_key_valid(value TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $function$
DECLARE
  alphabet CONSTANT TEXT := '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  accumulator NUMERIC := 0;
  digit INTEGER;
  leading_zero_bytes INTEGER := 0;
  decoded_nonzero_bytes INTEGER := 0;
  position INTEGER;
BEGIN
  IF OCTET_LENGTH(value) NOT BETWEEN 32 AND 44
    OR value COLLATE "C" !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN
    RETURN FALSE;
  END IF;
  FOR position IN 1..LENGTH(value) LOOP
    digit := STRPOS(alphabet,SUBSTRING(value FROM position FOR 1))-1;
    IF digit<0 THEN RETURN FALSE; END IF;
    IF position=leading_zero_bytes+1 AND digit=0 THEN
      leading_zero_bytes := leading_zero_bytes+1;
    END IF;
    accumulator := accumulator*58+digit;
  END LOOP;
  WHILE accumulator>0 LOOP
    decoded_nonzero_bytes := decoded_nonzero_bytes+1;
    accumulator := TRUNC(accumulator/256);
  END LOOP;
  RETURN leading_zero_bytes+decoded_nonzero_bytes=32;
END;
$function$;

CREATE OR REPLACE FUNCTION transaction_inbox_catch_up_mints_valid(mints TEXT[])
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
AS $function$
  SELECT CARDINALITY(mints) BETWEEN 0 AND 16
    AND COALESCE(ARRAY_NDIMS(mints),1)=1
    AND ARRAY_POSITION(mints,NULL) IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM UNNEST(mints) AS item(mint)
      WHERE mint<>BTRIM(mint) OR NOT transaction_inbox_solana_public_key_valid(mint)
    )
    AND mints=ARRAY(
      SELECT DISTINCT mint COLLATE "C" FROM UNNEST(mints) AS item(mint)
      ORDER BY mint COLLATE "C"
    )
$function$;

ALTER TABLE chain_transaction_inbox
  ADD COLUMN IF NOT EXISTS catch_up_classification_version SMALLINT,
  ADD COLUMN IF NOT EXISTS catch_up_disposition TEXT,
  ADD COLUMN IF NOT EXISTS catch_up_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS catch_up_action_key TEXT,
  ADD COLUMN IF NOT EXISTS catch_up_mints TEXT[],
  ADD COLUMN IF NOT EXISTS catch_up_evidence_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS catch_up_classified_at TIMESTAMPTZ;

ALTER TABLE listener_strict_catch_up_runs
  ADD COLUMN IF NOT EXISTS signatures_classified BIGINT;
UPDATE listener_strict_catch_up_runs
SET signatures_classified=signatures_enqueued
WHERE signatures_classified IS NULL;
ALTER TABLE listener_strict_catch_up_runs
  ALTER COLUMN signatures_classified SET NOT NULL;

ALTER TABLE chain_transaction_inbox
  DROP CONSTRAINT IF EXISTS chain_transaction_inbox_processing_status_check,
  DROP CONSTRAINT IF EXISTS chain_transaction_inbox_terminal_check,
  DROP CONSTRAINT IF EXISTS chain_transaction_inbox_catch_up_classification_check,
  DROP CONSTRAINT IF EXISTS chain_transaction_inbox_catch_up_terminal_check;

ALTER TABLE chain_transaction_inbox
  ADD CONSTRAINT chain_transaction_inbox_processing_status_check CHECK (
    processing_status IN ('PENDING','PROCESSING','PROCESSED','FAILED','DEFERRED','IGNORED','QUARANTINED')
  ),
  ADD CONSTRAINT chain_transaction_inbox_terminal_check CHECK (
    (terminal_at IS NULL AND purge_after IS NULL)
    OR (terminal_at IS NOT NULL AND purge_after IS NOT NULL
      AND purge_after=terminal_at+INTERVAL '4 hours'
      AND ((processing_status='PROCESSED'
        AND target_confirmation_status IN ('finalized','orphaned') AND processed_at IS NOT NULL)
        OR processing_status IN ('FAILED','DEFERRED','IGNORED','QUARANTINED')))
  ),
  ADD CONSTRAINT chain_transaction_inbox_catch_up_classification_check CHECK (
    (catch_up_classification_version IS NULL AND catch_up_disposition IS NULL
      AND catch_up_reason_code IS NULL AND catch_up_action_key IS NULL AND catch_up_mints IS NULL
      AND catch_up_evidence_fingerprint IS NULL AND catch_up_classified_at IS NULL)
    OR COALESCE((catch_up_classification_version=1
      AND catch_up_disposition IN ('ACTIONABLE','DEFERRED','IGNORED','QUARANTINED')
      AND catch_up_reason_code IN ('PUMP_ACTION_SUPPORTED','PUMP_TRADE_UNTRACKED',
        'SOLANA_TRANSACTION_FAILED','NO_SUPPORTED_PUMP_ACTION',
        'PUMP_SCHEMA_UNSUPPORTED','PROVIDER_SIGNATURE_MISSING')
      AND catch_up_mints IS NOT NULL AND transaction_inbox_catch_up_mints_valid(catch_up_mints)
      AND catch_up_action_key IS NOT NULL AND OCTET_LENGTH(catch_up_action_key) BETWEEN 4 AND 58
      AND catch_up_evidence_fingerprint ~ '^[0-9a-f]{64}$'
      AND catch_up_classified_at IS NOT NULL AND isfinite(catch_up_classified_at)
      AND catch_up_classified_at>=observed_at
      AND catch_up_classified_at<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
      AND date_trunc('milliseconds',catch_up_classified_at)=catch_up_classified_at
      AND 'CATCH_UP'=ANY(discovery_sources)
      AND (
        (catch_up_disposition='ACTIONABLE' AND catch_up_reason_code='PUMP_ACTION_SUPPORTED'
          AND CARDINALITY(catch_up_mints)>=1
          AND ((catch_up_action_key='PUMPFUN_CREATE'
              AND ingestion_hint='PUMPFUN_CREATE' AND ingestion_hint_mint IS NULL)
            OR (LEFT(catch_up_action_key,14)='PUMPFUN_TRADE:'
              AND transaction_inbox_solana_public_key_valid(SUBSTRING(catch_up_action_key FROM 15))
              AND SUBSTRING(catch_up_action_key FROM 15)=ANY(catch_up_mints)
              AND ((ingestion_hint='PUMPFUN_TRADE'
                  AND ingestion_hint_mint=SUBSTRING(catch_up_action_key FROM 15))
                OR (ingestion_hint='NONE' AND ingestion_hint_mint IS NULL)))))
        OR (catch_up_disposition='DEFERRED' AND catch_up_reason_code='PUMP_TRADE_UNTRACKED'
          AND CARDINALITY(catch_up_mints)>=1 AND LEFT(catch_up_action_key,14)='PUMPFUN_TRADE:'
          AND transaction_inbox_solana_public_key_valid(SUBSTRING(catch_up_action_key FROM 15))
          AND SUBSTRING(catch_up_action_key FROM 15)=ANY(catch_up_mints)
          AND ((ingestion_hint='PUMPFUN_TRADE'
              AND ingestion_hint_mint=SUBSTRING(catch_up_action_key FROM 15))
            OR (ingestion_hint='NONE' AND ingestion_hint_mint IS NULL)))
        OR (catch_up_disposition='IGNORED'
          AND catch_up_reason_code IN ('SOLANA_TRANSACTION_FAILED','NO_SUPPORTED_PUMP_ACTION')
          AND catch_up_action_key='NONE' AND ingestion_hint='NONE' AND ingestion_hint_mint IS NULL)
        OR (catch_up_disposition='QUARANTINED'
          AND catch_up_reason_code IN ('PUMP_SCHEMA_UNSUPPORTED','PROVIDER_SIGNATURE_MISSING')
          AND catch_up_action_key='NONE' AND ingestion_hint='NONE' AND ingestion_hint_mint IS NULL)
      )),FALSE)
  ),
  ADD CONSTRAINT chain_transaction_inbox_catch_up_terminal_check CHECK (
    (processing_status NOT IN ('IGNORED','QUARANTINED')
      AND (catch_up_disposition IS NULL OR catch_up_disposition NOT IN ('IGNORED','QUARANTINED')))
    OR (processing_status=catch_up_disposition
      AND catch_up_disposition IN ('IGNORED','QUARANTINED')
      AND ingestion_priority='NORMAL' AND ingestion_hint='NONE' AND ingestion_hint_mint IS NULL
      AND lease_token IS NULL AND lease_expires_at IS NULL AND attempts=0 AND attempts_in_cycle=0
      AND normalized_transaction IS NULL AND immutable_fingerprint IS NULL
      AND error_code IS NULL AND error_name IS NULL AND error_retryable IS NULL
      AND processed_at IS NULL AND next_attempt_at IS NULL AND retry_exhausted_at IS NULL
      AND missing_finality_polls=0 AND last_missing_finality_provider_id IS NULL
      AND finality_evidence_version=0 AND manual_recovery_count=0 AND last_manual_recovery_at IS NULL
      AND terminal_at=catch_up_classified_at AND purge_after=terminal_at+INTERVAL '4 hours')
  );

ALTER TABLE listener_strict_catch_up_runs
  DROP CONSTRAINT IF EXISTS listener_strict_catch_up_runs_numeric_bounds_check,
  DROP CONSTRAINT IF EXISTS listener_strict_catch_up_runs_cursor_order_check;
ALTER TABLE listener_strict_catch_up_runs
  ADD CONSTRAINT listener_strict_catch_up_runs_numeric_bounds_check CHECK (
    previous_slot BETWEEN 0 AND 999999999999999999999999999999999999999999999999999999999999999999999999999999
    AND observed_head_slot BETWEEN 0 AND 999999999999999999999999999999999999999999999999999999999999999999999999999999
    AND last_accepted_slot BETWEEN 0 AND 999999999999999999999999999999999999999999999999999999999999999999999999999999
    AND pages_scanned BETWEEN 1 AND 9223372036854775807
    AND signatures_enqueued BETWEEN 0 AND 9223372036854775807
    AND signatures_classified>=signatures_enqueued
    AND signatures_classified<=9223372036854775807
    AND revision BETWEEN 0 AND 9223372036854775807
  ),
  ADD CONSTRAINT listener_strict_catch_up_runs_cursor_order_check CHECK (
    observed_head_slot>=last_accepted_slot AND last_accepted_slot>=previous_slot
    AND before_signature<>previous_signature
    AND (before_signature<>observed_head_signature OR (
      pages_scanned=1 AND signatures_classified=1 AND signatures_enqueued<=signatures_classified
      AND last_accepted_slot=observed_head_slot
      AND ((state='ACTIVE' AND revision=0) OR (state<>'ACTIVE' AND revision=1))
    ))
  );

-- Replay validation: compare affected named checks against independently parsed
-- definitions instead of accepting weakened constraints under the same names.
DO $$
DECLARE expected_definition TEXT; expected_constraint_name TEXT;
BEGIN
  DROP TABLE IF EXISTS pg_temp.inbox_048_expected;
  CREATE TEMP TABLE pg_temp.inbox_048_expected (
    processing_status TEXT, target_confirmation_status TEXT, processed_at TIMESTAMPTZ,
    terminal_at TIMESTAMPTZ, purge_after TIMESTAMPTZ, observed_at TIMESTAMPTZ,
    discovery_sources TEXT[], ingestion_priority chain_transaction_inbox_priority,
    ingestion_hint TEXT, ingestion_hint_mint TEXT, attempts INTEGER, attempts_in_cycle INTEGER,
    lease_token TEXT, lease_expires_at TIMESTAMPTZ, normalized_transaction JSONB,
    immutable_fingerprint TEXT, error_code TEXT, error_name TEXT, error_retryable BOOLEAN,
    next_attempt_at TIMESTAMPTZ, retry_exhausted_at TIMESTAMPTZ,
    missing_finality_polls INTEGER, last_missing_finality_provider_id TEXT,
    finality_evidence_version BIGINT, manual_recovery_count INTEGER,
    last_manual_recovery_at TIMESTAMPTZ, catch_up_classification_version SMALLINT,
    catch_up_disposition TEXT, catch_up_reason_code TEXT, catch_up_action_key TEXT, catch_up_mints TEXT[],
    catch_up_evidence_fingerprint TEXT, catch_up_classified_at TIMESTAMPTZ,
    CONSTRAINT chain_transaction_inbox_processing_status_check CHECK (
      processing_status IN ('PENDING','PROCESSING','PROCESSED','FAILED','DEFERRED','IGNORED','QUARANTINED')),
    CONSTRAINT chain_transaction_inbox_terminal_check CHECK (
      (terminal_at IS NULL AND purge_after IS NULL) OR (terminal_at IS NOT NULL AND purge_after IS NOT NULL
        AND purge_after=terminal_at+INTERVAL '4 hours' AND ((processing_status='PROCESSED'
          AND target_confirmation_status IN ('finalized','orphaned') AND processed_at IS NOT NULL)
          OR processing_status IN ('FAILED','DEFERRED','IGNORED','QUARANTINED')))),
    CONSTRAINT chain_transaction_inbox_catch_up_classification_check CHECK (
      (catch_up_classification_version IS NULL AND catch_up_disposition IS NULL
        AND catch_up_reason_code IS NULL AND catch_up_action_key IS NULL AND catch_up_mints IS NULL
        AND catch_up_evidence_fingerprint IS NULL AND catch_up_classified_at IS NULL)
      OR COALESCE((catch_up_classification_version=1
        AND catch_up_disposition IN ('ACTIONABLE','DEFERRED','IGNORED','QUARANTINED')
        AND catch_up_reason_code IN ('PUMP_ACTION_SUPPORTED','PUMP_TRADE_UNTRACKED','SOLANA_TRANSACTION_FAILED',
          'NO_SUPPORTED_PUMP_ACTION','PUMP_SCHEMA_UNSUPPORTED','PROVIDER_SIGNATURE_MISSING')
        AND catch_up_mints IS NOT NULL AND transaction_inbox_catch_up_mints_valid(catch_up_mints)
        AND catch_up_action_key IS NOT NULL AND OCTET_LENGTH(catch_up_action_key) BETWEEN 4 AND 58
        AND catch_up_evidence_fingerprint ~ '^[0-9a-f]{64}$' AND catch_up_classified_at IS NOT NULL
        AND isfinite(catch_up_classified_at) AND catch_up_classified_at>=observed_at
        AND catch_up_classified_at<=TIMESTAMPTZ '275760-09-13 00:00:00.000+00'
        AND date_trunc('milliseconds',catch_up_classified_at)=catch_up_classified_at
        AND 'CATCH_UP'=ANY(discovery_sources) AND (
          (catch_up_disposition='ACTIONABLE' AND catch_up_reason_code='PUMP_ACTION_SUPPORTED'
            AND CARDINALITY(catch_up_mints)>=1
            AND ((catch_up_action_key='PUMPFUN_CREATE'
                AND ingestion_hint='PUMPFUN_CREATE' AND ingestion_hint_mint IS NULL)
              OR (LEFT(catch_up_action_key,14)='PUMPFUN_TRADE:'
                AND transaction_inbox_solana_public_key_valid(SUBSTRING(catch_up_action_key FROM 15))
                AND SUBSTRING(catch_up_action_key FROM 15)=ANY(catch_up_mints)
                AND ((ingestion_hint='PUMPFUN_TRADE'
                    AND ingestion_hint_mint=SUBSTRING(catch_up_action_key FROM 15))
                  OR (ingestion_hint='NONE' AND ingestion_hint_mint IS NULL)))))
          OR (catch_up_disposition='DEFERRED' AND catch_up_reason_code='PUMP_TRADE_UNTRACKED'
            AND CARDINALITY(catch_up_mints)>=1 AND LEFT(catch_up_action_key,14)='PUMPFUN_TRADE:'
            AND transaction_inbox_solana_public_key_valid(SUBSTRING(catch_up_action_key FROM 15))
            AND SUBSTRING(catch_up_action_key FROM 15)=ANY(catch_up_mints)
            AND ((ingestion_hint='PUMPFUN_TRADE'
                AND ingestion_hint_mint=SUBSTRING(catch_up_action_key FROM 15))
              OR (ingestion_hint='NONE' AND ingestion_hint_mint IS NULL)))
          OR (catch_up_disposition='IGNORED' AND catch_up_reason_code IN ('SOLANA_TRANSACTION_FAILED','NO_SUPPORTED_PUMP_ACTION')
            AND catch_up_action_key='NONE' AND ingestion_hint='NONE' AND ingestion_hint_mint IS NULL)
          OR (catch_up_disposition='QUARANTINED' AND catch_up_reason_code IN ('PUMP_SCHEMA_UNSUPPORTED','PROVIDER_SIGNATURE_MISSING')
            AND catch_up_action_key='NONE' AND ingestion_hint='NONE' AND ingestion_hint_mint IS NULL))),FALSE)),
    CONSTRAINT chain_transaction_inbox_catch_up_terminal_check CHECK (
      (processing_status NOT IN ('IGNORED','QUARANTINED')
        AND (catch_up_disposition IS NULL OR catch_up_disposition NOT IN ('IGNORED','QUARANTINED')))
      OR (processing_status=catch_up_disposition AND catch_up_disposition IN ('IGNORED','QUARANTINED')
        AND ingestion_priority='NORMAL' AND ingestion_hint='NONE' AND ingestion_hint_mint IS NULL
        AND lease_token IS NULL AND lease_expires_at IS NULL AND attempts=0 AND attempts_in_cycle=0
        AND normalized_transaction IS NULL AND immutable_fingerprint IS NULL
        AND error_code IS NULL AND error_name IS NULL AND error_retryable IS NULL
        AND processed_at IS NULL AND next_attempt_at IS NULL AND retry_exhausted_at IS NULL
        AND missing_finality_polls=0 AND last_missing_finality_provider_id IS NULL
        AND finality_evidence_version=0 AND manual_recovery_count=0 AND last_manual_recovery_at IS NULL
        AND terminal_at=catch_up_classified_at AND purge_after=terminal_at+INTERVAL '4 hours'))
  ) ON COMMIT DROP;
  FOREACH expected_constraint_name IN ARRAY ARRAY[
    'chain_transaction_inbox_processing_status_check','chain_transaction_inbox_terminal_check',
    'chain_transaction_inbox_catch_up_classification_check','chain_transaction_inbox_catch_up_terminal_check'
  ] LOOP
    expected_definition := (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid='pg_temp.inbox_048_expected'::REGCLASS AND conname=expected_constraint_name);
    IF (SELECT replay FROM pg_temp.migration_048_preflight) AND NOT EXISTS (
      SELECT 1 FROM pg_temp.migration_048_constraints
      WHERE relation_name='chain_transaction_inbox'
        AND migration_048_constraints.constraint_name=expected_constraint_name
        AND validated AND definition=expected_definition
    ) THEN
      RAISE EXCEPTION '% preflight definition is incompatible',expected_constraint_name USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='chain_transaction_inbox'::REGCLASS
      AND conname=expected_constraint_name AND convalidated AND pg_get_constraintdef(oid)=expected_definition) THEN
      RAISE EXCEPTION '% definition is incompatible',expected_constraint_name USING ERRCODE='23514';
    END IF;
  END LOOP;

  DROP TABLE IF EXISTS pg_temp.strict_048_expected;
  CREATE TEMP TABLE pg_temp.strict_048_expected (
    previous_slot NUMERIC(78,0), observed_head_slot NUMERIC(78,0), last_accepted_slot NUMERIC(78,0),
    pages_scanned BIGINT, signatures_enqueued BIGINT, signatures_classified BIGINT, revision BIGINT,
    previous_signature TEXT, observed_head_signature TEXT, before_signature TEXT, state TEXT,
    CONSTRAINT listener_strict_catch_up_runs_numeric_bounds_check CHECK (
      previous_slot BETWEEN 0 AND 999999999999999999999999999999999999999999999999999999999999999999999999999999
      AND observed_head_slot BETWEEN 0 AND 999999999999999999999999999999999999999999999999999999999999999999999999999999
      AND last_accepted_slot BETWEEN 0 AND 999999999999999999999999999999999999999999999999999999999999999999999999999999
      AND pages_scanned BETWEEN 1 AND 9223372036854775807
      AND signatures_enqueued BETWEEN 0 AND 9223372036854775807
      AND signatures_classified>=signatures_enqueued
      AND signatures_classified<=9223372036854775807
      AND revision BETWEEN 0 AND 9223372036854775807),
    CONSTRAINT listener_strict_catch_up_runs_cursor_order_check CHECK (
      observed_head_slot>=last_accepted_slot AND last_accepted_slot>=previous_slot
      AND before_signature<>previous_signature AND (before_signature<>observed_head_signature OR (
        pages_scanned=1 AND signatures_classified=1 AND signatures_enqueued<=signatures_classified
        AND last_accepted_slot=observed_head_slot
        AND ((state='ACTIVE' AND revision=0) OR (state<>'ACTIVE' AND revision=1)))))
  ) ON COMMIT DROP;
  FOREACH expected_constraint_name IN ARRAY ARRAY[
    'listener_strict_catch_up_runs_numeric_bounds_check','listener_strict_catch_up_runs_cursor_order_check'
  ] LOOP
    expected_definition := (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid='pg_temp.strict_048_expected'::REGCLASS AND conname=expected_constraint_name);
    IF (SELECT replay FROM pg_temp.migration_048_preflight) AND NOT EXISTS (
      SELECT 1 FROM pg_temp.migration_048_constraints
      WHERE relation_name='listener_strict_catch_up_runs'
        AND migration_048_constraints.constraint_name=expected_constraint_name
        AND validated AND definition=expected_definition
    ) THEN
      RAISE EXCEPTION '% preflight definition is incompatible',expected_constraint_name USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='listener_strict_catch_up_runs'::REGCLASS
      AND conname=expected_constraint_name AND convalidated AND pg_get_constraintdef(oid)=expected_definition) THEN
      RAISE EXCEPTION '% definition is incompatible',expected_constraint_name USING ERRCODE='23514';
    END IF;
  END LOOP;
END;
$$;
