-- Inactive B3a receipt evidence. This migration records whether the strict
-- catch-up classification itself admitted work; it never enables a runtime path.
DO $migration_049_preflight$
DECLARE receipt_columns INTEGER;
DECLARE admission_priority_columns INTEGER;
BEGIN
  LOCK TABLE chain_transaction_inbox IN ACCESS EXCLUSIVE MODE;
  SELECT COUNT(*) INTO receipt_columns
  FROM pg_attribute
  WHERE attrelid='chain_transaction_inbox'::REGCLASS AND attnum>0 AND NOT attisdropped
    AND attname='catch_up_enqueued';
  IF receipt_columns NOT IN (0,1) THEN
    RAISE EXCEPTION 'catch-up admission receipt column definition is incompatible' USING ERRCODE='23514';
  END IF;
  SELECT COUNT(*) INTO admission_priority_columns
  FROM pg_attribute
  WHERE attrelid='chain_transaction_inbox'::REGCLASS AND attnum>0 AND NOT attisdropped
    AND attname='catch_up_admission_priority';
  IF admission_priority_columns NOT IN (0,1) THEN
    RAISE EXCEPTION 'catch-up admission receipt priority column definition is incompatible' USING ERRCODE='23514';
  END IF;
  IF (receipt_columns=0) <> (admission_priority_columns=0) THEN
    RAISE EXCEPTION 'catch-up admission receipt columns are partially installed' USING ERRCODE='23514';
  END IF;
  -- Migration 048 did not persist whether a deferred trade was actually
  -- admitted. Its current processing state is mutable evidence and cannot be
  -- converted into an immutable receipt truthfully.
  IF receipt_columns=0 AND EXISTS (
    SELECT 1 FROM chain_transaction_inbox
    WHERE catch_up_classification_version IS NOT NULL AND catch_up_disposition='DEFERRED'
  ) THEN
    RAISE EXCEPTION 'ambiguous historical DEFERRED admission' USING ERRCODE='23514';
  END IF;
  DROP TABLE IF EXISTS pg_temp.migration_049_preflight;
  CREATE TEMP TABLE pg_temp.migration_049_preflight (replay BOOLEAN NOT NULL) ON COMMIT DROP;
  INSERT INTO pg_temp.migration_049_preflight(replay) VALUES (receipt_columns=1);
  DROP TABLE IF EXISTS pg_temp.migration_049_constraints;
  CREATE TEMP TABLE pg_temp.migration_049_constraints ON COMMIT DROP AS
  SELECT relation.relname AS relation_name, constraint_row.conname AS constraint_name,
    constraint_row.convalidated AS validated, pg_get_constraintdef(constraint_row.oid) AS definition
  FROM pg_constraint constraint_row
  JOIN pg_class relation ON relation.oid=constraint_row.conrelid
  WHERE (relation.oid='chain_transaction_inbox'::REGCLASS
      AND constraint_row.conname IN ('chain_transaction_inbox_catch_up_classification_check',
        'chain_transaction_inbox_catch_up_terminal_check'))
    OR (relation.oid='listener_strict_catch_up_runs'::REGCLASS
      AND constraint_row.conname='listener_strict_catch_up_runs_cursor_order_check');
  IF receipt_columns=1 AND EXISTS (
    SELECT 1 FROM pg_attribute attribute
    LEFT JOIN pg_attrdef attribute_default ON attribute_default.adrelid=attribute.attrelid
      AND attribute_default.adnum=attribute.attnum
    WHERE attribute.attrelid='chain_transaction_inbox'::REGCLASS
      AND attribute.attname='catch_up_enqueued' AND attribute.attnum>0 AND NOT attribute.attisdropped
      AND (format_type(attribute.atttypid,attribute.atttypmod)<>'boolean' OR attribute.attnotnull
        OR attribute.attgenerated<>'' OR attribute.attidentity<>''
        OR pg_get_expr(attribute_default.adbin,attribute_default.adrelid) IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'catch-up admission receipt column definition is incompatible' USING ERRCODE='23514';
  END IF;
  IF admission_priority_columns=1 AND EXISTS (
    SELECT 1 FROM pg_attribute attribute
    LEFT JOIN pg_attrdef attribute_default ON attribute_default.adrelid=attribute.attrelid
      AND attribute_default.adnum=attribute.attnum
    WHERE attribute.attrelid='chain_transaction_inbox'::REGCLASS
      AND attribute.attname='catch_up_admission_priority'
      AND attribute.attnum>0 AND NOT attribute.attisdropped
      AND (attribute.atttypid<>'chain_transaction_inbox_priority'::REGTYPE OR attribute.attnotnull
        OR attribute.attgenerated<>'' OR attribute.attidentity<>''
        OR pg_get_expr(attribute_default.adbin,attribute_default.adrelid) IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'catch-up admission receipt priority column definition is incompatible' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='chain_transaction_inbox'::REGCLASS
      AND conname='chain_transaction_inbox_catch_up_classification_check' AND convalidated)
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='chain_transaction_inbox'::REGCLASS
      AND conname='chain_transaction_inbox_catch_up_terminal_check' AND convalidated) THEN
    RAISE EXCEPTION 'catch-up classification constraints are incompatible' USING ERRCODE='23514';
  END IF;
  IF receipt_columns=1 AND (SELECT COUNT(*) FROM pg_temp.migration_049_constraints
      WHERE validated)<>3 THEN
    RAISE EXCEPTION 'catch-up admission receipt constraints are incompatible' USING ERRCODE='23514';
  END IF;
END;
$migration_049_preflight$;

ALTER TABLE chain_transaction_inbox
  ADD COLUMN IF NOT EXISTS catch_up_enqueued BOOLEAN,
  ADD COLUMN IF NOT EXISTS catch_up_admission_priority chain_transaction_inbox_priority;

-- Preserve only admission facts that 048 represented unambiguously. Deferred
-- rows are rejected by the preflight above rather than inferred from mutable
-- processing state.
UPDATE chain_transaction_inbox
SET catch_up_enqueued = CASE
  WHEN catch_up_classification_version IS NULL THEN NULL
  WHEN catch_up_disposition='ACTIONABLE' AND 'WEBSOCKET'=ANY(discovery_sources) THEN FALSE
  WHEN catch_up_disposition='ACTIONABLE' THEN TRUE
  WHEN catch_up_disposition IN ('IGNORED','QUARANTINED') THEN FALSE
  ELSE FALSE
END
WHERE catch_up_enqueued IS NULL;

-- The priority is evidence of the original catch-up admission, not the mutable
-- inbox scheduling priority.  A later tracked-mint synchronization must not
-- change a replay receipt.
UPDATE chain_transaction_inbox
SET catch_up_admission_priority = CASE
  WHEN catch_up_enqueued=TRUE THEN ingestion_priority
  ELSE NULL
END
WHERE catch_up_admission_priority IS NULL;

ALTER TABLE chain_transaction_inbox
  DROP CONSTRAINT IF EXISTS chain_transaction_inbox_catch_up_classification_check,
  DROP CONSTRAINT IF EXISTS chain_transaction_inbox_catch_up_terminal_check;

ALTER TABLE chain_transaction_inbox
  ADD CONSTRAINT chain_transaction_inbox_catch_up_classification_check CHECK (
    (catch_up_classification_version IS NULL AND catch_up_disposition IS NULL
      AND catch_up_reason_code IS NULL AND catch_up_action_key IS NULL AND catch_up_mints IS NULL
      AND catch_up_evidence_fingerprint IS NULL AND catch_up_classified_at IS NULL
      AND catch_up_enqueued IS NULL AND catch_up_admission_priority IS NULL)
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
      AND catch_up_enqueued IS NOT NULL
      AND ((catch_up_enqueued=TRUE AND catch_up_admission_priority IS NOT NULL)
        OR (catch_up_enqueued=FALSE AND catch_up_admission_priority IS NULL))
      AND 'CATCH_UP'=ANY(discovery_sources)
      AND (
        (catch_up_disposition='ACTIONABLE' AND catch_up_reason_code='PUMP_ACTION_SUPPORTED'
          AND CARDINALITY(catch_up_mints)>=1
          AND (catch_up_enqueued=TRUE OR 'WEBSOCKET'=ANY(discovery_sources))
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
          AND catch_up_action_key='NONE' AND ingestion_hint='NONE' AND ingestion_hint_mint IS NULL
          AND catch_up_enqueued=FALSE)
        OR (catch_up_disposition='QUARANTINED'
          AND catch_up_reason_code IN ('PUMP_SCHEMA_UNSUPPORTED','PROVIDER_SIGNATURE_MISSING')
          AND catch_up_action_key='NONE' AND ingestion_hint='NONE' AND ingestion_hint_mint IS NULL
          AND catch_up_enqueued=FALSE)
      )),FALSE)
  ),
  ADD CONSTRAINT chain_transaction_inbox_catch_up_terminal_check CHECK (
    (processing_status NOT IN ('IGNORED','QUARANTINED')
      AND (catch_up_disposition IS NULL OR catch_up_disposition NOT IN ('IGNORED','QUARANTINED')))
    OR (processing_status=catch_up_disposition AND catch_up_disposition IN ('IGNORED','QUARANTINED')
      AND catch_up_enqueued=FALSE
      AND catch_up_admission_priority IS NULL
      AND ingestion_priority='NORMAL' AND ingestion_hint='NONE' AND ingestion_hint_mint IS NULL
      AND lease_token IS NULL AND lease_expires_at IS NULL AND attempts=0 AND attempts_in_cycle=0
      AND normalized_transaction IS NULL AND immutable_fingerprint IS NULL
      AND error_code IS NULL AND error_name IS NULL AND error_retryable IS NULL
      AND processed_at IS NULL AND next_attempt_at IS NULL AND retry_exhausted_at IS NULL
      AND missing_finality_polls=0 AND last_missing_finality_provider_id IS NULL
      AND finality_evidence_version=0 AND manual_recovery_count=0 AND last_manual_recovery_at IS NULL
      AND terminal_at=catch_up_classified_at AND purge_after=terminal_at+INTERVAL '4 hours')
    OR (catch_up_disposition IN ('IGNORED','QUARANTINED')
      AND catch_up_enqueued=FALSE AND catch_up_admission_priority IS NULL
      AND 'WEBSOCKET'=ANY(discovery_sources))
  );

-- An already-admitted, purged WebSocket finality receipt has no attachable
-- classification. It is still a complete one-row page and may advance its
-- cursor with both counters at zero.
ALTER TABLE listener_strict_catch_up_runs
  DROP CONSTRAINT IF EXISTS listener_strict_catch_up_runs_cursor_order_check;

ALTER TABLE listener_strict_catch_up_runs
  ADD CONSTRAINT listener_strict_catch_up_runs_cursor_order_check CHECK (
    observed_head_slot>=last_accepted_slot AND last_accepted_slot>=previous_slot
    AND before_signature<>previous_signature
    AND (before_signature<>observed_head_signature OR (
      pages_scanned=1 AND signatures_classified BETWEEN 0 AND 1
      AND signatures_enqueued<=signatures_classified
      AND last_accepted_slot=observed_head_slot
      AND ((state='ACTIVE' AND revision=0) OR (state<>'ACTIVE' AND revision=1))
    ))
  );

-- Replay must fail closed if a named receipt constraint was replaced or weakened.
DO $migration_049_verify$
DECLARE expected_definition TEXT; expected_constraint_name TEXT; expected_relation_name TEXT;
BEGIN
  FOR expected_relation_name, expected_constraint_name IN VALUES
    ('chain_transaction_inbox','chain_transaction_inbox_catch_up_classification_check'),
    ('chain_transaction_inbox','chain_transaction_inbox_catch_up_terminal_check'),
    ('listener_strict_catch_up_runs','listener_strict_catch_up_runs_cursor_order_check')
  LOOP
    SELECT pg_get_constraintdef(constraint_row.oid) INTO expected_definition
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid=expected_relation_name::REGCLASS
      AND constraint_row.conname=expected_constraint_name
      AND constraint_row.convalidated;
    IF expected_definition IS NULL THEN
      RAISE EXCEPTION '% definition is incompatible',expected_constraint_name USING ERRCODE='23514';
    END IF;
    IF (SELECT replay FROM pg_temp.migration_049_preflight) AND NOT EXISTS (
      SELECT 1 FROM pg_temp.migration_049_constraints
      WHERE relation_name=expected_relation_name AND constraint_name=expected_constraint_name
        AND validated AND definition=expected_definition
    ) THEN
      RAISE EXCEPTION '% preflight definition is incompatible',expected_constraint_name USING ERRCODE='23514';
    END IF;
  END LOOP;
END;
$migration_049_verify$;
