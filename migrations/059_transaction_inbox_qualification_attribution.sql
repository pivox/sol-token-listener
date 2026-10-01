-- Forward-only vocabulary extension for trusted qualification diagnostics.
-- Exact 058 and exact 059 definitions are the only accepted predecessor states.
DO $migration_059$
DECLARE
  actual_table REGCLASS;
  expected_058 REGCLASS;
  expected_059 REGCLASS;
  named_count INTEGER;
  equivalent_count INTEGER;
  matches_058 BOOLEAN;
  matches_059 BOOLEAN;
BEGIN
  actual_table := to_regclass(format('%I.transaction_inbox_terminal_attributions', current_schema()));
  IF actual_table IS NULL THEN
    RAISE EXCEPTION 'terminal attribution journal is absent' USING ERRCODE='23514';
  END IF;
  EXECUTE format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE', actual_table);

  CREATE TEMP TABLE migration_059_expected_058 (
    source TEXT,
    processing_outcome TEXT,
    stage TEXT,
    origin TEXT,
    diagnostic_code TEXT,
    catch_up_cause_kind TEXT,
    completeness TEXT,
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
      AND diagnostic_code IN ('PUMP_BORSH_INVALID','FUNDING_OBSERVATION_VALIDATE',
        'FUNDING_OBSERVATION_EXTRACT','FUNDING_OBSERVATION_RECORD',
        'WALLET_GRAPH_POSTGRES_SERIALIZATION','WALLET_GRAPH_POSTGRES_DEADLOCK',
        'WALLET_GRAPH_LAUNCH_MISSING','WALLET_GRAPH_DATA_INVALID','WALLET_GRAPH_ANALYSIS_INVALID',
        'WALLET_GRAPH_PERSISTENCE_UNKNOWN','PUMPSWAP_MUTABLE_RPC_UNAVAILABLE',
        'PUMPSWAP_RPC_CONTEXT_INVALID','PUMPSWAP_MUTABLE_ACCOUNT_DECODING','PUMPSWAP_MARKET_POOL_MISMATCH',
        'PUMPSWAP_MARKET_POOL_NON_CANONICAL','PUMPSWAP_UNSUPPORTED_TOKEN_EXTENSION',
        'PUMPSWAP_PERSISTENCE_UNKNOWN','UNAVAILABLE')
      AND (catch_up_cause_kind IS NULL OR catch_up_cause_kind IN
        ('PUMP_DECODER','LOCATOR','NORMALIZATION','PUMP_MINT_LIMIT','PUMP_MULTI_MINT'))
      AND completeness IN ('COMPLETE','UNAVAILABLE')
      AND (completeness<>'COMPLETE' OR diagnostic_code<>'UNAVAILABLE' OR origin IS NOT NULL
        OR catch_up_cause_kind IS NOT NULL)
    )
  ) ON COMMIT DROP;

  CREATE TEMP TABLE migration_059_expected_059 (
    source TEXT,
    processing_outcome TEXT,
    stage TEXT,
    origin TEXT,
    diagnostic_code TEXT,
    catch_up_cause_kind TEXT,
    completeness TEXT,
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
      AND diagnostic_code IN ('QUALIFICATION_CONNECT_FAILED',
        'QUALIFICATION_POSTGRES_SERIALIZATION',
        'QUALIFICATION_POSTGRES_DEADLOCK',
        'QUALIFICATION_DATA_INVALID',
        'QUALIFICATION_LAUNCH_MISSING',
        'QUALIFICATION_REBUILD_UNKNOWN',
        'QUALIFICATION_PERSISTENCE_UNKNOWN',
        'QUALIFICATION_CLEANUP_FAILED','PUMP_BORSH_INVALID','FUNDING_OBSERVATION_VALIDATE',
        'FUNDING_OBSERVATION_EXTRACT','FUNDING_OBSERVATION_RECORD',
        'WALLET_GRAPH_POSTGRES_SERIALIZATION','WALLET_GRAPH_POSTGRES_DEADLOCK',
        'WALLET_GRAPH_LAUNCH_MISSING','WALLET_GRAPH_DATA_INVALID','WALLET_GRAPH_ANALYSIS_INVALID',
        'WALLET_GRAPH_PERSISTENCE_UNKNOWN','PUMPSWAP_MUTABLE_RPC_UNAVAILABLE',
        'PUMPSWAP_RPC_CONTEXT_INVALID','PUMPSWAP_MUTABLE_ACCOUNT_DECODING','PUMPSWAP_MARKET_POOL_MISMATCH',
        'PUMPSWAP_MARKET_POOL_NON_CANONICAL','PUMPSWAP_UNSUPPORTED_TOKEN_EXTENSION',
        'PUMPSWAP_PERSISTENCE_UNKNOWN','UNAVAILABLE')

      AND (diagnostic_code NOT IN ('QUALIFICATION_CONNECT_FAILED',
        'QUALIFICATION_POSTGRES_SERIALIZATION',
        'QUALIFICATION_POSTGRES_DEADLOCK',
        'QUALIFICATION_DATA_INVALID',
        'QUALIFICATION_LAUNCH_MISSING',
        'QUALIFICATION_REBUILD_UNKNOWN',
        'QUALIFICATION_PERSISTENCE_UNKNOWN',
        'QUALIFICATION_CLEANUP_FAILED')
        OR (source IS NOT DISTINCT FROM 'WORKER'
          AND processing_outcome IS NOT DISTINCT FROM 'FAILED'
          AND stage IS NOT DISTINCT FROM 'qualification' AND catch_up_cause_kind IS NULL))
      AND (catch_up_cause_kind IS NULL OR catch_up_cause_kind IN
        ('PUMP_DECODER','LOCATOR','NORMALIZATION','PUMP_MINT_LIMIT','PUMP_MULTI_MINT'))
      AND completeness IN ('COMPLETE','UNAVAILABLE')
      AND (completeness<>'COMPLETE' OR diagnostic_code<>'UNAVAILABLE' OR origin IS NOT NULL
        OR catch_up_cause_kind IS NOT NULL)
    )
  ) ON COMMIT DROP;

  expected_058 := 'pg_temp.migration_059_expected_058'::REGCLASS;
  expected_059 := 'pg_temp.migration_059_expected_059'::REGCLASS;
  SELECT COUNT(*) INTO named_count FROM pg_constraint
    WHERE conrelid=actual_table AND conname='terminal_attributions_taxonomy_check';
  IF named_count<>1 THEN
    RAISE EXCEPTION 'terminal attribution taxonomy constraint is absent or duplicated'
      USING ERRCODE='23514';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint actual, pg_constraint expected
    WHERE actual.conrelid=actual_table
      AND actual.conname='terminal_attributions_taxonomy_check'
      AND expected.conrelid=expected_058
      AND expected.conname='terminal_attributions_taxonomy_check'
      AND actual.contype=expected.contype
      AND actual.condeferrable=expected.condeferrable
      AND actual.condeferred=expected.condeferred
      AND actual.convalidated=expected.convalidated
      AND actual.connoinherit=expected.connoinherit
      AND pg_get_constraintdef(actual.oid)=pg_get_constraintdef(expected.oid)
  ), EXISTS (
    SELECT 1 FROM pg_constraint actual, pg_constraint expected
    WHERE actual.conrelid=actual_table
      AND actual.conname='terminal_attributions_taxonomy_check'
      AND expected.conrelid=expected_059
      AND expected.conname='terminal_attributions_taxonomy_check'
      AND actual.contype=expected.contype
      AND actual.condeferrable=expected.condeferrable
      AND actual.condeferred=expected.condeferred
      AND actual.convalidated=expected.convalidated
      AND actual.connoinherit=expected.connoinherit
      AND pg_get_constraintdef(actual.oid)=pg_get_constraintdef(expected.oid)
  ) INTO matches_058,matches_059;
  IF NOT matches_058 AND NOT matches_059 THEN
    RAISE EXCEPTION 'terminal attribution taxonomy constraint is incompatible'
      USING ERRCODE='23514';
  END IF;

  SELECT COUNT(*) INTO equivalent_count
  FROM pg_constraint actual
  WHERE actual.conrelid=actual_table AND (
    pg_get_constraintdef(actual.oid)=(SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid=expected_058 AND conname='terminal_attributions_taxonomy_check')
    OR pg_get_constraintdef(actual.oid)=(SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid=expected_059 AND conname='terminal_attributions_taxonomy_check')
  );
  IF equivalent_count<>1 THEN
    RAISE EXCEPTION 'terminal attribution taxonomy constraint is duplicated'
      USING ERRCODE='23514';
  END IF;

  IF matches_058 THEN
    ALTER TABLE transaction_inbox_terminal_attributions
      DROP CONSTRAINT terminal_attributions_taxonomy_check,
      ADD CONSTRAINT terminal_attributions_taxonomy_check CHECK (
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
        AND diagnostic_code IN ('QUALIFICATION_CONNECT_FAILED',
        'QUALIFICATION_POSTGRES_SERIALIZATION',
        'QUALIFICATION_POSTGRES_DEADLOCK',
        'QUALIFICATION_DATA_INVALID',
        'QUALIFICATION_LAUNCH_MISSING',
        'QUALIFICATION_REBUILD_UNKNOWN',
        'QUALIFICATION_PERSISTENCE_UNKNOWN',
        'QUALIFICATION_CLEANUP_FAILED','PUMP_BORSH_INVALID','FUNDING_OBSERVATION_VALIDATE',
          'FUNDING_OBSERVATION_EXTRACT','FUNDING_OBSERVATION_RECORD',
          'WALLET_GRAPH_POSTGRES_SERIALIZATION','WALLET_GRAPH_POSTGRES_DEADLOCK',
          'WALLET_GRAPH_LAUNCH_MISSING','WALLET_GRAPH_DATA_INVALID','WALLET_GRAPH_ANALYSIS_INVALID',
          'WALLET_GRAPH_PERSISTENCE_UNKNOWN','PUMPSWAP_MUTABLE_RPC_UNAVAILABLE',
          'PUMPSWAP_RPC_CONTEXT_INVALID','PUMPSWAP_MUTABLE_ACCOUNT_DECODING','PUMPSWAP_MARKET_POOL_MISMATCH',
          'PUMPSWAP_MARKET_POOL_NON_CANONICAL','PUMPSWAP_UNSUPPORTED_TOKEN_EXTENSION',
          'PUMPSWAP_PERSISTENCE_UNKNOWN','UNAVAILABLE')

      AND (diagnostic_code NOT IN ('QUALIFICATION_CONNECT_FAILED',
        'QUALIFICATION_POSTGRES_SERIALIZATION',
        'QUALIFICATION_POSTGRES_DEADLOCK',
        'QUALIFICATION_DATA_INVALID',
        'QUALIFICATION_LAUNCH_MISSING',
        'QUALIFICATION_REBUILD_UNKNOWN',
        'QUALIFICATION_PERSISTENCE_UNKNOWN',
        'QUALIFICATION_CLEANUP_FAILED')
        OR (source IS NOT DISTINCT FROM 'WORKER'
          AND processing_outcome IS NOT DISTINCT FROM 'FAILED'
          AND stage IS NOT DISTINCT FROM 'qualification' AND catch_up_cause_kind IS NULL))
      AND (catch_up_cause_kind IS NULL OR catch_up_cause_kind IN
          ('PUMP_DECODER','LOCATOR','NORMALIZATION','PUMP_MINT_LIMIT','PUMP_MULTI_MINT'))
        AND completeness IN ('COMPLETE','UNAVAILABLE')
        AND (completeness<>'COMPLETE' OR diagnostic_code<>'UNAVAILABLE' OR origin IS NOT NULL
          OR catch_up_cause_kind IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint actual, pg_constraint expected
    WHERE actual.conrelid=actual_table
      AND actual.conname='terminal_attributions_taxonomy_check'
      AND expected.conrelid=expected_059
      AND expected.conname='terminal_attributions_taxonomy_check'
      AND actual.contype=expected.contype
      AND actual.condeferrable=expected.condeferrable
      AND actual.condeferred=expected.condeferred
      AND actual.convalidated=expected.convalidated
      AND actual.connoinherit=expected.connoinherit
      AND pg_get_constraintdef(actual.oid)=pg_get_constraintdef(expected.oid)
  ) THEN
    RAISE EXCEPTION 'terminal attribution taxonomy upgrade is incomplete'
      USING ERRCODE='23514';
  END IF;
END;
$migration_059$;
