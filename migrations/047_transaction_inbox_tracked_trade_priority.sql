-- Replace the enum rather than extending it: PostgreSQL 16 cannot consume a
-- newly added label until commit. This file, including immediate replay, works
-- inside one transaction. Only the known 044 and 047 definitions are accepted.
DO $$
DECLARE
  labels TEXT[];
  upgrading BOOLEAN;
  streak_column TEXT;
  actual_constraints TEXT[];
  expected_constraints TEXT[];
  actual_index OID;
  expected_index OID;
  index_name TEXT;
  constraint_row RECORD;
BEGIN
  LOCK TABLE chain_transaction_inbox, chain_transaction_inbox_claim_scheduler IN ACCESS EXCLUSIVE MODE;
  SELECT ARRAY_AGG(enumlabel ORDER BY enumsortorder) INTO labels
  FROM pg_enum WHERE enumtypid = (
    SELECT type.oid FROM pg_type type JOIN pg_namespace namespace ON namespace.oid=type.typnamespace
    WHERE namespace.nspname=CURRENT_SCHEMA() AND type.typname='chain_transaction_inbox_priority'
  );
  IF labels IS DISTINCT FROM ARRAY['NORMAL','LAUNCH_CANDIDATE']::TEXT[]
    AND labels IS DISTINCT FROM ARRAY['NORMAL','LAUNCH_CANDIDATE','TRACKED_TRADE']::TEXT[] THEN
    RAISE EXCEPTION 'chain_transaction_inbox_priority enum definition is incompatible';
  END IF;
  upgrading := CARDINALITY(labels)=2;
  IF EXISTS (SELECT 1 FROM pg_type type JOIN pg_namespace namespace ON namespace.oid=type.typnamespace
    WHERE namespace.nspname=CURRENT_SCHEMA() AND type.typname='chain_transaction_inbox_priority_047') THEN
    RAISE EXCEPTION 'chain_transaction_inbox_priority replacement type is incompatible';
  END IF;
  streak_column := CASE WHEN upgrading THEN 'consecutive_launch_candidate_claims' ELSE 'consecutive_urgent_claims' END;

  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('ingestion_priority','chain_transaction_inbox_priority',TRUE,'''NORMAL''::chain_transaction_inbox_priority'),
      ('ingestion_hint','text',TRUE,'''NONE''::text'),
      ('ingestion_hint_mint','text',FALSE,NULL)
    ) expected(column_name,column_type,not_null,default_value)
    LEFT JOIN pg_attribute attribute ON attribute.attrelid='chain_transaction_inbox'::REGCLASS
      AND attribute.attname=expected.column_name AND NOT attribute.attisdropped
    LEFT JOIN pg_attrdef attribute_default ON attribute_default.adrelid=attribute.attrelid AND attribute_default.adnum=attribute.attnum
    WHERE (attribute.attnum IS NULL AND (NOT upgrading OR expected.column_name='ingestion_priority'))
      OR (attribute.attnum IS NOT NULL AND (
        format_type(attribute.atttypid,attribute.atttypmod)<>expected.column_type
        OR attribute.attnotnull<>expected.not_null OR attribute.attgenerated<>'' OR attribute.attidentity<>''
        OR pg_get_expr(attribute_default.adbin,attribute_default.adrelid) IS DISTINCT FROM expected.default_value
      ))
  ) THEN RAISE EXCEPTION 'chain_transaction_inbox ingestion column definition is incompatible'; END IF;

  IF (SELECT COUNT(*) FROM pg_attribute WHERE attrelid='chain_transaction_inbox_claim_scheduler'::REGCLASS
      AND attnum>0 AND NOT attisdropped)<>4 OR EXISTS (
    SELECT 1 FROM (VALUES
      ('scheduler_key','text',TRUE,NULL), (streak_column,'smallint',TRUE,'0'),
      ('created_at','timestamp with time zone',TRUE,'clock_timestamp()'),
      ('updated_at','timestamp with time zone',TRUE,'clock_timestamp()')
    ) expected(column_name,column_type,not_null,default_value)
    LEFT JOIN pg_attribute attribute ON attribute.attrelid='chain_transaction_inbox_claim_scheduler'::REGCLASS
      AND attribute.attname=expected.column_name AND NOT attribute.attisdropped
    LEFT JOIN pg_attrdef attribute_default ON attribute_default.adrelid=attribute.attrelid AND attribute_default.adnum=attribute.attnum
    WHERE attribute.attnum IS NULL OR format_type(attribute.atttypid,attribute.atttypmod)<>expected.column_type
      OR attribute.attnotnull<>expected.not_null OR attribute.attgenerated<>'' OR attribute.attidentity<>''
      OR pg_get_expr(attribute_default.adbin,attribute_default.adrelid) IS DISTINCT FROM expected.default_value
  ) THEN RAISE EXCEPTION 'chain_transaction_inbox_claim_scheduler column definition is incompatible'; END IF;

  -- Independently parse the expected checks on this server. Catalog comparison
  -- rejects weakened/missing/unvalidated checks instead of silently repairing drift.
  CREATE TEMP TABLE pg_temp.inbox_047_expected (
    processing_status TEXT, target_confirmation_status TEXT, attempts INTEGER,
    lease_token TEXT, lease_expires_at TIMESTAMPTZ, normalized_transaction JSONB,
    immutable_fingerprint TEXT, error_code TEXT, error_name TEXT, error_retryable BOOLEAN,
    next_attempt_at TIMESTAMPTZ, retry_exhausted_at TIMESTAMPTZ, processed_at TIMESTAMPTZ,
    terminal_at TIMESTAMPTZ, purge_after TIMESTAMPTZ, created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ, observed_at TIMESTAMPTZ, observed_slot NUMERIC(78,0), signature TEXT,
    retry_max_attempts INTEGER, retry_base_delay_ms INTEGER, attempts_in_cycle INTEGER,
    manual_recovery_count INTEGER, last_manual_recovery_at TIMESTAMPTZ,
    missing_finality_polls INTEGER, last_missing_finality_provider_id TEXT, finality_evidence_version BIGINT,
    ingestion_priority chain_transaction_inbox_priority, ingestion_hint TEXT, ingestion_hint_mint TEXT,
    CONSTRAINT chain_transaction_inbox_processing_status_check CHECK (
      processing_status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED')
    ),
    CONSTRAINT chain_transaction_inbox_terminal_check CHECK (
      (terminal_at IS NULL AND purge_after IS NULL)
      OR (terminal_at IS NOT NULL AND purge_after IS NOT NULL
        AND purge_after = terminal_at + INTERVAL '4 hours'
        AND ((processing_status = 'PROCESSED'
          AND target_confirmation_status IN ('finalized', 'orphaned') AND processed_at IS NOT NULL)
          OR processing_status = 'FAILED'))
    ),
    CONSTRAINT chain_transaction_inbox_attempts_check CHECK (attempts >= 0),
    CONSTRAINT chain_transaction_inbox_missing_finality_polls_check CHECK (missing_finality_polls >= 0),
    CONSTRAINT chain_transaction_inbox_lease_check CHECK (
      (processing_status = 'PROCESSING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
        AND LENGTH(lease_token) BETWEEN 1 AND 256)
      OR (processing_status <> 'PROCESSING' AND lease_token IS NULL AND lease_expires_at IS NULL)
    ),
    CONSTRAINT chain_transaction_inbox_snapshot_check CHECK (
      (normalized_transaction IS NULL AND immutable_fingerprint IS NULL)
      OR (normalized_transaction IS NOT NULL AND jsonb_typeof(normalized_transaction) = 'object'
        AND immutable_fingerprint IS NOT NULL AND immutable_fingerprint ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT chain_transaction_inbox_error_check CHECK (
      (processing_status = 'FAILED' AND error_code IS NOT NULL
        AND error_code IN ('RPC_TRANSIENT', 'TRANSACTION_NOT_AVAILABLE', 'BLOCK_NOT_AVAILABLE',
          'TRANSACTION_INDEX_NOT_FOUND', 'NORMALIZATION_FAILED', 'PIPELINE_STAGE_FAILED',
          'FINALITY_INCONSISTENT', 'CATCH_UP_WINDOW_EXCEEDED', 'WORKER_LEASE_EXPIRED')
        AND error_name IS NOT NULL AND OCTET_LENGTH(error_name) BETWEEN 1 AND 16384 AND error_retryable IS NOT NULL)
      OR (processing_status <> 'FAILED' AND error_code IS NULL AND error_name IS NULL AND error_retryable IS NULL)
    ),
    CONSTRAINT chain_transaction_inbox_retry_check CHECK (
      (processing_status = 'FAILED' AND error_retryable = TRUE AND retry_exhausted_at IS NULL
        AND next_attempt_at IS NOT NULL AND terminal_at IS NULL AND purge_after IS NULL)
      OR (processing_status = 'FAILED' AND error_retryable = TRUE AND retry_exhausted_at IS NOT NULL
        AND next_attempt_at IS NULL AND terminal_at IS NOT NULL AND purge_after IS NOT NULL)
      OR (processing_status = 'FAILED' AND error_retryable = FALSE AND retry_exhausted_at IS NULL
        AND next_attempt_at IS NULL AND terminal_at IS NOT NULL AND purge_after IS NOT NULL)
      OR (processing_status <> 'FAILED' AND retry_exhausted_at IS NULL AND next_attempt_at IS NULL)
    ),
    CONSTRAINT chain_transaction_inbox_processed_check CHECK (
      processing_status <> 'PROCESSED' OR (processed_at IS NOT NULL AND normalized_transaction IS NOT NULL)
    ),
    CONSTRAINT chain_transaction_inbox_terminal_completion_check CHECK (
      processing_status <> 'PROCESSED' OR target_confirmation_status NOT IN ('finalized', 'orphaned') OR terminal_at IS NOT NULL
    ),
    CONSTRAINT chain_transaction_inbox_timestamps_check CHECK (
      updated_at >= created_at AND (processed_at IS NULL OR processed_at >= observed_at)
      AND (terminal_at IS NULL OR terminal_at >= processed_at)
    ),
    CONSTRAINT chain_transaction_inbox_retry_policy_check CHECK (
      retry_max_attempts BETWEEN 1 AND 100 AND retry_base_delay_ms BETWEEN 1 AND 60000
      AND attempts_in_cycle BETWEEN 0 AND retry_max_attempts AND attempts_in_cycle <= attempts
      AND (processing_status <> 'PENDING' OR attempts_in_cycle < retry_max_attempts)
    ),
    CONSTRAINT chain_transaction_inbox_manual_recovery_check CHECK (
      manual_recovery_count >= 0 AND ((manual_recovery_count = 0 AND last_manual_recovery_at IS NULL)
        OR (manual_recovery_count > 0 AND last_manual_recovery_at IS NOT NULL))
    ),
    CONSTRAINT chain_transaction_inbox_missing_finality_provider_check CHECK (
      (missing_finality_polls = 0 AND last_missing_finality_provider_id IS NULL)
      OR (missing_finality_polls > 0 AND last_missing_finality_provider_id IS NOT NULL
        AND last_missing_finality_provider_id IN ('primary', 'fallback-1', 'fallback-2', 'fallback-3'))
    ),
    CONSTRAINT chain_transaction_inbox_finality_evidence_version_check CHECK (finality_evidence_version >= 0)
  ) ON COMMIT DROP;

  CREATE TEMP TABLE pg_temp.inbox_047_scheduler_expected (
    scheduler_key TEXT, consecutive_launch_candidate_claims SMALLINT,
    created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
    CONSTRAINT chain_transaction_inbox_claim_scheduler_pkey PRIMARY KEY (scheduler_key),
    CONSTRAINT chain_transaction_inbox_claim_scheduler_key_check CHECK (scheduler_key = 'global'),
    CONSTRAINT chain_transaction_inbox_claim_scheduler_streak_check CHECK (consecutive_launch_candidate_claims BETWEEN 0 AND 32),
    CONSTRAINT chain_transaction_inbox_claim_scheduler_timestamps_check CHECK (updated_at >= created_at)
  ) ON COMMIT DROP;
  IF NOT upgrading THEN
    ALTER TABLE pg_temp.inbox_047_scheduler_expected RENAME COLUMN consecutive_launch_candidate_claims TO consecutive_urgent_claims;
  END IF;
  SELECT ARRAY(SELECT conname||':'||convalidated||':'||pg_get_constraintdef(oid)
    FROM pg_constraint WHERE conrelid='chain_transaction_inbox_claim_scheduler'::REGCLASS ORDER BY conname)
    INTO actual_constraints;
  SELECT ARRAY(SELECT conname||':'||convalidated||':'||pg_get_constraintdef(oid)
    FROM pg_constraint WHERE conrelid='pg_temp.inbox_047_scheduler_expected'::REGCLASS ORDER BY conname)
    INTO expected_constraints;
  IF actual_constraints IS DISTINCT FROM expected_constraints THEN
    RAISE EXCEPTION 'chain_transaction_inbox_claim_scheduler constraint definition is incompatible';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM chain_transaction_inbox_claim_scheduler WHERE scheduler_key='global') THEN
    RAISE EXCEPTION 'chain_transaction_inbox_claim_scheduler singleton is incompatible';
  END IF;

  -- The old actionable predicate stays identical. All non-NORMAL priorities
  -- share one FIFO bucket; enum order alone would let trades overtake launches.
  IF upgrading THEN
    CREATE INDEX inbox_047_claim_expected ON pg_temp.inbox_047_expected (ingestion_priority DESC, observed_slot, signature)
      WHERE processing_status = 'PENDING' OR processing_status = 'PROCESSING'
        OR (processing_status = 'FAILED' AND error_retryable = TRUE AND retry_exhausted_at IS NULL);
  ELSE
    CREATE INDEX inbox_047_claim_expected ON pg_temp.inbox_047_expected ((ingestion_priority <> 'NORMAL') DESC, observed_slot, signature)
      WHERE processing_status = 'PENDING' OR processing_status = 'PROCESSING'
        OR (processing_status = 'FAILED' AND error_retryable = TRUE AND retry_exhausted_at IS NULL);
  END IF;
  CREATE INDEX inbox_047_purge_expected ON pg_temp.inbox_047_expected (purge_after) WHERE purge_after IS NOT NULL;
  -- Each projected trade resynchronizes one mint. Keep both activation and
  -- deactivation selective even with a large retained, unrelated inbox.
  CREATE INDEX inbox_047_tracked_mint_expected ON pg_temp.inbox_047_expected (ingestion_hint_mint)
    WHERE ingestion_hint='PUMPFUN_TRADE' AND processing_status IN ('DEFERRED','PENDING');
  FOREACH index_name IN ARRAY ARRAY['chain_transaction_inbox_claim_order_idx','chain_transaction_inbox_purge_idx',
    'chain_transaction_inbox_tracked_mint_idx'] LOOP
    SELECT relation.oid INTO actual_index FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname=CURRENT_SCHEMA() AND relation.relname=index_name;
    -- Only a first upgrade may lack the new index. Never repair replay drift
    -- or accept an incompatible preexisting object under IF NOT EXISTS.
    IF upgrading AND index_name='chain_transaction_inbox_tracked_mint_idx' AND actual_index IS NULL THEN
      CONTINUE;
    END IF;
    expected_index := CASE index_name
      WHEN 'chain_transaction_inbox_claim_order_idx' THEN 'pg_temp.inbox_047_claim_expected'::REGCLASS
      WHEN 'chain_transaction_inbox_purge_idx' THEN 'pg_temp.inbox_047_purge_expected'::REGCLASS
      ELSE 'pg_temp.inbox_047_tracked_mint_expected'::REGCLASS END;
    IF actual_index IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_index actual JOIN pg_class relation ON relation.oid=actual.indexrelid
      JOIN pg_index expected ON expected.indexrelid=expected_index
      JOIN pg_class expected_relation ON expected_relation.oid=expected.indexrelid
      WHERE actual.indexrelid=actual_index AND actual.indrelid='chain_transaction_inbox'::REGCLASS
        AND actual.indisvalid AND actual.indisready AND NOT actual.indisunique AND NOT actual.indisprimary
        AND relation.relam=expected_relation.relam AND actual.indnkeyatts=expected.indnkeyatts
        AND actual.indnatts=expected.indnatts AND actual.indoption=expected.indoption
        AND actual.indclass=expected.indclass AND actual.indcollation=expected.indcollation
        AND pg_get_expr(actual.indpred,actual.indrelid) IS NOT DISTINCT FROM pg_get_expr(expected.indpred,expected.indrelid)
        AND ARRAY(SELECT pg_get_indexdef(actual.indexrelid,column_number,TRUE) FROM generate_series(1,actual.indnatts) column_number)
          = ARRAY(SELECT pg_get_indexdef(expected.indexrelid,column_number,TRUE) FROM generate_series(1,expected.indnatts) column_number)
    ) THEN RAISE EXCEPTION '% index definition is incompatible', index_name; END IF;
  END LOOP;

  -- Validate historical constraints before widening just the two affected ones.
  -- The negative branches of lease/error/retry/processed already cover DEFERRED.
  IF upgrading THEN
    FOR constraint_row IN SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='pg_temp.inbox_047_expected'::REGCLASS
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='chain_transaction_inbox'::REGCLASS
        AND conname=constraint_row.conname AND convalidated AND pg_get_constraintdef(oid)=constraint_row.definition) THEN
        RAISE EXCEPTION '% constraint definition is incompatible', constraint_row.conname;
      END IF;
    END LOOP;
  END IF;
  ALTER TABLE pg_temp.inbox_047_expected
    DROP CONSTRAINT chain_transaction_inbox_processing_status_check,
    DROP CONSTRAINT chain_transaction_inbox_terminal_check,
    ADD CONSTRAINT chain_transaction_inbox_processing_status_check CHECK (
      processing_status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEFERRED')
    ),
    ADD CONSTRAINT chain_transaction_inbox_terminal_check CHECK (
      (terminal_at IS NULL AND purge_after IS NULL)
      OR (terminal_at IS NOT NULL AND purge_after IS NOT NULL
        AND purge_after = terminal_at + INTERVAL '4 hours'
        AND ((processing_status = 'PROCESSED'
          AND target_confirmation_status IN ('finalized', 'orphaned') AND processed_at IS NOT NULL)
          OR processing_status IN ('FAILED', 'DEFERRED')))
    ),
    ADD CONSTRAINT chain_transaction_inbox_ingestion_hint_check CHECK (
      (ingestion_hint IN ('NONE', 'PUMPFUN_CREATE') AND ingestion_hint_mint IS NULL)
      OR (ingestion_hint = 'PUMPFUN_TRADE' AND ingestion_hint_mint IS NOT NULL
        AND ingestion_hint_mint = BTRIM(ingestion_hint_mint)
        AND OCTET_LENGTH(ingestion_hint_mint) BETWEEN 32 AND 44
        AND ingestion_hint_mint COLLATE "C" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
    ),
    ADD CONSTRAINT chain_transaction_inbox_deferred_check CHECK (
      processing_status <> 'DEFERRED' OR (
        ingestion_hint = 'PUMPFUN_TRADE' AND ingestion_hint_mint IS NOT NULL AND ingestion_priority = 'NORMAL'
        AND lease_token IS NULL AND lease_expires_at IS NULL AND attempts = 0 AND attempts_in_cycle = 0
        AND normalized_transaction IS NULL AND immutable_fingerprint IS NULL
        AND error_code IS NULL AND error_name IS NULL AND error_retryable IS NULL AND processed_at IS NULL
        AND next_attempt_at IS NULL AND retry_exhausted_at IS NULL
        AND missing_finality_polls = 0 AND last_missing_finality_provider_id IS NULL AND finality_evidence_version = 0
        AND manual_recovery_count = 0 AND last_manual_recovery_at IS NULL
        AND terminal_at IS NOT NULL AND purge_after IS NOT NULL
        AND isfinite(terminal_at) AND isfinite(purge_after) AND terminal_at >= observed_at
        AND purge_after = terminal_at + INTERVAL '4 hours'
      )
    );
  FOR constraint_row IN SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='pg_temp.inbox_047_expected'::REGCLASS
  LOOP
    IF (NOT upgrading OR constraint_row.conname IN ('chain_transaction_inbox_ingestion_hint_check','chain_transaction_inbox_deferred_check'))
      AND (NOT upgrading OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='chain_transaction_inbox'::REGCLASS AND conname=constraint_row.conname))
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='chain_transaction_inbox'::REGCLASS
        AND conname=constraint_row.conname AND convalidated AND pg_get_constraintdef(oid)=constraint_row.definition) THEN
      RAISE EXCEPTION '% constraint definition is incompatible', constraint_row.conname;
    END IF;
  END LOOP;

  IF upgrading THEN
    ALTER TABLE chain_transaction_inbox
      ADD COLUMN IF NOT EXISTS ingestion_hint TEXT NOT NULL DEFAULT 'NONE',
      ADD COLUMN IF NOT EXISTS ingestion_hint_mint TEXT;
    UPDATE chain_transaction_inbox SET ingestion_hint='PUMPFUN_CREATE'
      WHERE ingestion_priority='LAUNCH_CANDIDATE' AND ingestion_hint='NONE' AND ingestion_hint_mint IS NULL;
    ALTER TABLE chain_transaction_inbox
      DROP CONSTRAINT chain_transaction_inbox_processing_status_check,
      DROP CONSTRAINT chain_transaction_inbox_terminal_check;
    FOR constraint_row IN SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='pg_temp.inbox_047_expected'::REGCLASS
        AND conname IN ('chain_transaction_inbox_processing_status_check','chain_transaction_inbox_terminal_check',
          'chain_transaction_inbox_ingestion_hint_check','chain_transaction_inbox_deferred_check')
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='chain_transaction_inbox'::REGCLASS AND conname=constraint_row.conname) THEN
        EXECUTE format('ALTER TABLE chain_transaction_inbox ADD CONSTRAINT %I %s', constraint_row.conname, constraint_row.definition);
      END IF;
    END LOOP;
    -- Remove the temporary dependency before replacing the enum. A restrictive
    -- DROP TYPE intentionally refuses unknown dependencies instead of losing them.
    DROP TABLE pg_temp.inbox_047_expected;
    CREATE TYPE chain_transaction_inbox_priority_047 AS ENUM ('NORMAL', 'LAUNCH_CANDIDATE', 'TRACKED_TRADE');
    ALTER TABLE chain_transaction_inbox
      DROP CONSTRAINT chain_transaction_inbox_deferred_check,
      ALTER COLUMN ingestion_priority DROP DEFAULT;
    ALTER TABLE chain_transaction_inbox ALTER COLUMN ingestion_priority TYPE chain_transaction_inbox_priority_047
      USING ingestion_priority::TEXT::chain_transaction_inbox_priority_047;
    DROP TYPE chain_transaction_inbox_priority;
    ALTER TYPE chain_transaction_inbox_priority_047 RENAME TO chain_transaction_inbox_priority;
    ALTER TABLE chain_transaction_inbox ALTER COLUMN ingestion_priority SET DEFAULT 'NORMAL';
    -- Restore exactly the parsed deferred definition against the replacement enum.
    -- The definition uses only NORMAL, so there is no uncommitted-label hazard.
    ALTER TABLE chain_transaction_inbox ADD CONSTRAINT chain_transaction_inbox_deferred_check CHECK (
      processing_status <> 'DEFERRED' OR (
        ingestion_hint = 'PUMPFUN_TRADE' AND ingestion_hint_mint IS NOT NULL AND ingestion_priority = 'NORMAL'
        AND lease_token IS NULL AND lease_expires_at IS NULL AND attempts = 0 AND attempts_in_cycle = 0
        AND normalized_transaction IS NULL AND immutable_fingerprint IS NULL
        AND error_code IS NULL AND error_name IS NULL AND error_retryable IS NULL AND processed_at IS NULL
        AND next_attempt_at IS NULL AND retry_exhausted_at IS NULL
        AND missing_finality_polls = 0 AND last_missing_finality_provider_id IS NULL AND finality_evidence_version = 0
        AND manual_recovery_count = 0 AND last_manual_recovery_at IS NULL
        AND terminal_at IS NOT NULL AND purge_after IS NOT NULL
        AND isfinite(terminal_at) AND isfinite(purge_after) AND terminal_at >= observed_at
        AND purge_after = terminal_at + INTERVAL '4 hours'
      )
    );
    ALTER TABLE chain_transaction_inbox_claim_scheduler RENAME COLUMN consecutive_launch_candidate_claims TO consecutive_urgent_claims;
    DROP INDEX chain_transaction_inbox_claim_order_idx;
    CREATE INDEX chain_transaction_inbox_claim_order_idx
      ON chain_transaction_inbox ((ingestion_priority <> 'NORMAL') DESC, observed_slot, signature)
      WHERE processing_status = 'PENDING' OR processing_status = 'PROCESSING'
        OR (processing_status = 'FAILED' AND error_retryable = TRUE AND retry_exhausted_at IS NULL);
    CREATE INDEX IF NOT EXISTS chain_transaction_inbox_tracked_mint_idx
      ON chain_transaction_inbox (ingestion_hint_mint)
      WHERE ingestion_hint='PUMPFUN_TRADE' AND processing_status IN ('DEFERRED','PENDING');
  ELSE
    DROP TABLE pg_temp.inbox_047_expected;
  END IF;
  DROP TABLE pg_temp.inbox_047_scheduler_expected;
  -- The existing purge_after IS NOT NULL index already includes DEFERRED rows.
END;
$$;
