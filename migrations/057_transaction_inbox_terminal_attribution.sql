-- Observational journal: immutable occurrences, independently retained for four hours.
-- Replay compares canonical temporary definitions instead of repairing drift.
DO $migration_057$
DECLARE
  table_definition TEXT := $definition$(
    signature TEXT NOT NULL,
    source TEXT NOT NULL,
    occurrence_number INTEGER NOT NULL,
    processing_outcome TEXT NOT NULL,
    worker_cycle_attempt INTEGER,
    worker_recovery_count INTEGER,
    retryable BOOLEAN,
    retry_exhausted BOOLEAN,
    stage TEXT,
    origin TEXT,
    diagnostic_code TEXT NOT NULL,
    catch_up_cause_kind TEXT,
    catch_up_reason_code TEXT,
    slot NUMERIC(78,0) NOT NULL,
    transaction_index BIGINT,
    confirmation_status TEXT NOT NULL,
    instruction_index BIGINT,
    inner_instruction_index BIGINT,
    wire_surface TEXT,
    wire_location TEXT,
    wire_discriminator TEXT,
    wire_idl_name TEXT,
    wire_total_bytes INTEGER,
    wire_payload_bytes INTEGER,
    wire_suffix_bytes INTEGER,
    completeness TEXT NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    purge_after TIMESTAMPTZ NOT NULL,
    CONSTRAINT terminal_attributions_pkey PRIMARY KEY(signature,source,occurrence_number),
    CONSTRAINT terminal_attributions_source_check CHECK (
      (source='WORKER' AND processing_outcome='FAILED' AND occurrence_number>0
        AND worker_cycle_attempt IS NOT NULL AND worker_cycle_attempt BETWEEN 1 AND 100
        AND worker_cycle_attempt<=occurrence_number
        AND worker_recovery_count IS NOT NULL AND worker_recovery_count>=0
        AND retryable IS NOT NULL AND retry_exhausted IS NOT NULL
        AND (NOT retry_exhausted OR retryable) AND catch_up_reason_code IS NULL
        AND catch_up_cause_kind IS NULL)
      OR (source='CATCH_UP' AND processing_outcome='QUARANTINED' AND occurrence_number=1
        AND worker_cycle_attempt IS NULL AND worker_recovery_count IS NULL
        AND retryable IS NULL AND retry_exhausted IS NULL AND stage IS NULL
        AND catch_up_reason_code IS NOT NULL
        AND catch_up_reason_code IN ('PUMP_SCHEMA_UNSUPPORTED','PROVIDER_SIGNATURE_MISSING')
        AND (catch_up_cause_kind IS NOT NULL OR (completeness='UNAVAILABLE'
          AND diagnostic_code='UNAVAILABLE' AND origin IS NULL AND transaction_index IS NULL
          AND instruction_index IS NULL AND inner_instruction_index IS NULL)))
    ),
    CONSTRAINT terminal_attributions_taxonomy_check CHECK (
      (stage IS NULL OR stage IN ('create_observation','load_tracked_mints','launchpad_observation',
        'sync_tracked_mint','reload_active_events','funding_observation','participant_analytics',
        'wallet_graph','pumpswap_observation','qualification','paper_decision_enqueue','unclassified'))
      AND (origin IS NULL OR origin IN (
        'PUMP_TRANSACTION_INDEX_REQUIRED','PUMP_SCHEMA_UNSUPPORTED','PUMP_BORSH_TRUNCATED',
        'PUMP_BORSH_INVALID','PUMP_ACCOUNT_MISSING','PUMP_STACK_HEIGHT_REQUIRED','PUMP_STACK_HEIGHT_INVALID',
        'PUMP_EVENT_MISSING','PUMP_EVENT_DUPLICATE','PUMP_EVENT_ORPHANED','PUMP_EVENT_AMBIGUOUS',
        'PUMP_EVENT_MISMATCH','PUMP_QUOTE_ASSET_UNRESOLVED','PUMP_QUOTE_ASSET_CONFLICT','PUMP_TOKEN_PROGRAM_UNSUPPORTED',
        'PUMPSWAP_ACCOUNT_MISSING','PUMPSWAP_BORSH_INVALID','PUMPSWAP_BORSH_TRUNCATED',
        'PUMPSWAP_EVENT_AMBIGUOUS','PUMPSWAP_EVENT_DUPLICATE','PUMPSWAP_EVENT_MISMATCH',
        'PUMPSWAP_EVENT_MISSING','PUMPSWAP_EVENT_ORPHANED','PUMPSWAP_SCHEMA_UNSUPPORTED',
        'PUMPSWAP_STACK_HEIGHT_REQUIRED','PUMPSWAP_TOKEN_PROGRAM_UNSUPPORTED','UNKNOWN'))
      AND diagnostic_code IN ('PUMP_BORSH_INVALID','WALLET_GRAPH_POSTGRES_SERIALIZATION',
        'WALLET_GRAPH_POSTGRES_DEADLOCK','WALLET_GRAPH_LAUNCH_MISSING','WALLET_GRAPH_DATA_INVALID',
        'WALLET_GRAPH_ANALYSIS_INVALID','WALLET_GRAPH_PERSISTENCE_UNKNOWN','PUMPSWAP_MUTABLE_RPC_UNAVAILABLE',
        'PUMPSWAP_RPC_CONTEXT_INVALID','PUMPSWAP_MUTABLE_ACCOUNT_DECODING','PUMPSWAP_MARKET_POOL_MISMATCH',
        'PUMPSWAP_MARKET_POOL_NON_CANONICAL','PUMPSWAP_UNSUPPORTED_TOKEN_EXTENSION',
        'PUMPSWAP_PERSISTENCE_UNKNOWN','UNAVAILABLE')
      AND (catch_up_cause_kind IS NULL OR catch_up_cause_kind IN
        ('PUMP_DECODER','LOCATOR','NORMALIZATION','PUMP_MINT_LIMIT','PUMP_MULTI_MINT'))
      AND completeness IN ('COMPLETE','UNAVAILABLE')
      AND (completeness<>'COMPLETE' OR diagnostic_code<>'UNAVAILABLE' OR origin IS NOT NULL
        OR catch_up_cause_kind IS NOT NULL)
    ),
    CONSTRAINT terminal_attributions_locator_check CHECK (
      slot>=0 AND slot<=9007199254740991
      AND (transaction_index IS NULL OR transaction_index BETWEEN 0 AND 9007199254740991)
      AND (instruction_index IS NULL OR instruction_index BETWEEN 0 AND 9007199254740991)
      AND (inner_instruction_index IS NULL OR (instruction_index IS NOT NULL
        AND inner_instruction_index BETWEEN 0 AND 9007199254740991))
      AND confirmation_status IN ('processed','confirmed','finalized','orphaned')
    ),
    CONSTRAINT terminal_attributions_wire_check CHECK (
      (diagnostic_code<>'PUMP_BORSH_INVALID' AND wire_surface IS NULL AND wire_location IS NULL
        AND wire_discriminator IS NULL AND wire_idl_name IS NULL AND wire_total_bytes IS NULL
        AND wire_payload_bytes IS NULL AND wire_suffix_bytes IS NULL)
      OR (diagnostic_code='PUMP_BORSH_INVALID' AND completeness='COMPLETE'
        AND (origin IS NULL OR origin='PUMP_BORSH_INVALID')
        AND transaction_index IS NOT NULL AND instruction_index IS NOT NULL
        AND (source='WORKER' OR (catch_up_cause_kind IS NOT NULL AND catch_up_cause_kind='PUMP_DECODER'))
        AND wire_surface IS NOT NULL AND wire_surface IN ('INSTRUCTION','CPI_EVENT')
        AND wire_location IS NOT NULL AND wire_location IN ('OUTER','INNER')
        AND wire_discriminator IS NOT NULL AND wire_discriminator ~ '^[0-9a-f]{16}$'
        AND wire_idl_name IS NOT NULL AND wire_idl_name IN ('buy','buy_exact_quote_in_v2',
          'buy_exact_sol_in','buy_v2','create','create_v2','migrate','migrate_v2','sell','sell_v2',
          'CreateEvent','TradeEvent','UNKNOWN_DISCRIMINATOR')
        AND wire_total_bytes IS NOT NULL AND wire_total_bytes BETWEEN 8 AND 1232
        AND wire_payload_bytes IS NOT NULL AND wire_payload_bytes>=0
        AND wire_payload_bytes=wire_total_bytes-CASE WHEN wire_surface='INSTRUCTION' THEN 8 ELSE 16 END
        AND (wire_suffix_bytes IS NULL OR wire_suffix_bytes BETWEEN 0 AND wire_payload_bytes)
        AND ((wire_location='OUTER' AND inner_instruction_index IS NULL)
          OR (wire_location='INNER' AND inner_instruction_index IS NOT NULL)))
    ),
    CONSTRAINT terminal_attributions_retention_check CHECK (
      isfinite(captured_at) AND isfinite(purge_after)
      AND purge_after=captured_at+INTERVAL '4 hours'
    )
  )$definition$;
  parent_definition TEXT := $definition$(
    terminal_attribution_incomplete_count INTEGER NOT NULL DEFAULT 0,
    terminal_attribution_incomplete_at TIMESTAMPTZ,
    CONSTRAINT chain_transaction_inbox_terminal_attribution_check CHECK (
      (terminal_attribution_incomplete_count=0 AND terminal_attribution_incomplete_at IS NULL)
      OR (terminal_attribution_incomplete_count>0 AND terminal_attribution_incomplete_at IS NOT NULL
        AND isfinite(terminal_attribution_incomplete_at))
    )
  )$definition$;
  named_count INTEGER;
  actual_table OID;
  expected_table OID;
  parent_table OID := 'chain_transaction_inbox'::REGCLASS;
  expected_parent OID;
  actual_index OID;
  expected_index OID;
BEGIN
  PERFORM set_config('TimeZone','UTC',true);
  PERFORM set_config('DateStyle','ISO, YMD',true);
  LOCK TABLE chain_transaction_inbox IN SHARE ROW EXCLUSIVE MODE;
  SELECT
    (SELECT COUNT(*) FROM pg_class WHERE relnamespace=current_schema()::REGNAMESPACE
      AND relname IN ('transaction_inbox_terminal_attributions','terminal_attributions_pkey',
        'transaction_inbox_terminal_attributions_purge_idx'))
    + (SELECT COUNT(*) FROM pg_attribute WHERE attrelid=parent_table AND NOT attisdropped
      AND attname IN ('terminal_attribution_incomplete_count','terminal_attribution_incomplete_at'))
    + (SELECT COUNT(*) FROM pg_constraint WHERE conrelid=parent_table
      AND conname='chain_transaction_inbox_terminal_attribution_check')
    INTO named_count;
  IF named_count NOT IN (0,6) THEN
    RAISE EXCEPTION 'terminal attribution objects are partial' USING ERRCODE='23514';
  END IF;

  EXECUTE 'CREATE TEMP TABLE migration_057_expected ' || table_definition || ' ON COMMIT DROP';
  EXECUTE 'CREATE TEMP TABLE migration_057_parent ' || parent_definition || ' ON COMMIT DROP';
  CREATE INDEX migration_057_expected_purge_idx ON migration_057_expected
    (purge_after,signature,source,occurrence_number);
  IF named_count=0 THEN
    ALTER TABLE chain_transaction_inbox
      ADD COLUMN terminal_attribution_incomplete_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN terminal_attribution_incomplete_at TIMESTAMPTZ,
      ADD CONSTRAINT chain_transaction_inbox_terminal_attribution_check CHECK (
        (terminal_attribution_incomplete_count=0 AND terminal_attribution_incomplete_at IS NULL)
        OR (terminal_attribution_incomplete_count>0 AND terminal_attribution_incomplete_at IS NOT NULL
          AND isfinite(terminal_attribution_incomplete_at))
      );
    EXECUTE 'CREATE TABLE transaction_inbox_terminal_attributions ' || table_definition;
    ALTER TABLE transaction_inbox_terminal_attributions
      ADD CONSTRAINT terminal_attributions_signature_fkey FOREIGN KEY(signature)
      REFERENCES chain_transaction_inbox(signature) ON DELETE CASCADE;
    CREATE INDEX transaction_inbox_terminal_attributions_purge_idx
      ON transaction_inbox_terminal_attributions(purge_after,signature,source,occurrence_number);
    REVOKE ALL PRIVILEGES ON TABLE transaction_inbox_terminal_attributions FROM PUBLIC;
  END IF;
  actual_table := 'transaction_inbox_terminal_attributions'::REGCLASS;
  expected_table := 'pg_temp.migration_057_expected'::REGCLASS;
  expected_parent := 'pg_temp.migration_057_parent'::REGCLASS;
  IF NOT EXISTS (SELECT 1 FROM pg_class relation WHERE oid=actual_table
    AND relkind='r' AND relpersistence='p' AND NOT relrowsecurity AND NOT relforcerowsecurity
    AND reloptions IS NULL AND reltablespace=0
    AND relowner=(SELECT relowner FROM pg_class WHERE oid=parent_table))
    OR EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=actual_table OR inhparent=actual_table)
    OR EXISTS (SELECT 1 FROM pg_class relation,
      LATERAL aclexplode(COALESCE(relation.relacl,acldefault('r',relation.relowner))) privilege
      WHERE relation.oid=actual_table AND privilege.grantee=0)
    OR EXISTS (SELECT 1 FROM pg_attribute attribute,LATERAL aclexplode(attribute.attacl) privilege
      WHERE attribute.attrelid=actual_table AND privilege.grantee=0)
  THEN
    RAISE EXCEPTION 'terminal attribution table is incompatible' USING ERRCODE='23514';
  END IF;
  -- Compare both directions, including defaults and typmods; no repaired constraints.
  IF EXISTS (
    WITH actual AS (
      SELECT attname,atttypid,atttypmod,attnotnull,attcollation,attidentity,attgenerated,
        pg_get_expr(def.adbin,def.adrelid) AS default_value
      FROM pg_attribute attribute LEFT JOIN pg_attrdef def
        ON def.adrelid=attribute.attrelid AND def.adnum=attribute.attnum
      WHERE attribute.attrelid IN (actual_table,parent_table) AND attribute.attnum>0 AND NOT attribute.attisdropped
        AND (attribute.attrelid=actual_table OR attname IN
          ('terminal_attribution_incomplete_count','terminal_attribution_incomplete_at'))
    ), expected AS (
      SELECT attname,atttypid,atttypmod,attnotnull,attcollation,attidentity,attgenerated,
        pg_get_expr(def.adbin,def.adrelid) AS default_value
      FROM pg_attribute attribute LEFT JOIN pg_attrdef def
        ON def.adrelid=attribute.attrelid AND def.adnum=attribute.attnum
      WHERE attribute.attrelid IN (expected_table,expected_parent) AND attribute.attnum>0 AND NOT attribute.attisdropped
    ) SELECT 1 FROM ((TABLE actual EXCEPT ALL TABLE expected)
      UNION ALL (TABLE expected EXCEPT ALL TABLE actual)) difference
  ) THEN
    RAISE EXCEPTION 'terminal attribution columns are incompatible' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    WITH actual AS (
      SELECT conname,contype,condeferrable,condeferred,convalidated,connoinherit,
        pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE (conrelid=actual_table AND contype<>'f') OR (conrelid=parent_table
        AND conname='chain_transaction_inbox_terminal_attribution_check')
    ), expected AS (
      SELECT conname,contype,condeferrable,condeferred,convalidated,connoinherit,
        pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid IN (expected_table,expected_parent)
    ) SELECT 1 FROM ((TABLE actual EXCEPT ALL TABLE expected)
      UNION ALL (TABLE expected EXCEPT ALL TABLE actual)) difference
  ) THEN
    RAISE EXCEPTION 'terminal attribution constraints are incompatible' USING ERRCODE='23514';
  END IF;
  IF (SELECT COUNT(*) FROM pg_constraint WHERE conrelid=actual_table AND contype='f')<>1
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=actual_table
      AND conname='terminal_attributions_signature_fkey' AND contype='f'
      AND confrelid=parent_table AND convalidated AND NOT condeferrable AND NOT condeferred
      AND confdeltype='c' AND confupdtype='a' AND confmatchtype='s'
      AND conkey=ARRAY[1]::SMALLINT[] AND confkey=ARRAY[1]::SMALLINT[]
      AND pg_get_constraintdef(oid)='FOREIGN KEY (signature) REFERENCES chain_transaction_inbox(signature) ON DELETE CASCADE')
  THEN
    RAISE EXCEPTION 'terminal attribution foreign key is incompatible' USING ERRCODE='23514';
  END IF;
  FOR actual_index,expected_index IN
    SELECT 'transaction_inbox_terminal_attributions_purge_idx'::REGCLASS::OID,
      'pg_temp.migration_057_expected_purge_idx'::REGCLASS::OID
    UNION ALL SELECT format('%I.terminal_attributions_pkey',current_schema())::REGCLASS::OID,
      (SELECT conindid FROM pg_constraint WHERE conrelid=expected_table AND contype='p')
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index actual JOIN pg_class relation ON relation.oid=actual.indexrelid,
        pg_index expected
      WHERE actual.indexrelid=actual_index AND expected.indexrelid=expected_index
        AND actual.indrelid=actual_table AND relation.relkind='i' AND relation.relpersistence='p'
        AND relation.relowner=(SELECT relowner FROM pg_class WHERE oid=actual_table)
        AND relation.reloptions IS NULL AND relation.reltablespace=0
        AND relation.relam=(SELECT oid FROM pg_am WHERE amname='btree')
        AND actual.indisvalid AND actual.indisready AND actual.indislive AND actual.indimmediate
        AND actual.indisunique=expected.indisunique AND actual.indisprimary=expected.indisprimary
        AND NOT actual.indisexclusion AND NOT actual.indnullsnotdistinct
        AND actual.indnkeyatts=expected.indnkeyatts AND actual.indnatts=expected.indnatts
        AND actual.indclass=expected.indclass AND actual.indcollation=expected.indcollation
        AND actual.indoption=expected.indoption
        AND actual.indexprs IS NULL AND actual.indpred IS NULL
        AND ARRAY(SELECT pg_get_indexdef(actual_index,n,TRUE) FROM generate_series(1,actual.indnatts) n)
          =ARRAY(SELECT pg_get_indexdef(expected_index,n,TRUE) FROM generate_series(1,expected.indnatts) n)
    ) THEN
      RAISE EXCEPTION 'terminal attribution index is incompatible' USING ERRCODE='23514';
    END IF;
  END LOOP;
  DROP TABLE pg_temp.migration_057_expected;
  DROP TABLE pg_temp.migration_057_parent;
END;
$migration_057$;
