CREATE TABLE IF NOT EXISTS paper_decision_jobs (
  job_id TEXT PRIMARY KEY CHECK (job_id ~ '^paper_job_[0-9a-f]{64}$'),
  mint TEXT NOT NULL REFERENCES token_launches(mint),
  source_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  source_raw_event_id TEXT NOT NULL REFERENCES raw_chain_events(event_id),
  source_confirmation_status TEXT NOT NULL CHECK (
    source_confirmation_status IN ('processed','confirmed','finalized','orphaned')
  ),
  input_fingerprint TEXT NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN (
    'PENDING','PROCESSING','RETRYABLE_FAILED','COMPLETED','CANCELLED'
  )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000000),
  attempts_in_cycle INTEGER NOT NULL DEFAULT 0 CHECK (
    attempts_in_cycle BETWEEN 0 AND 100 AND attempts_in_cycle <= attempts
  ),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  base_delay_ms INTEGER NOT NULL CHECK (base_delay_ms BETWEEN 1 AND 60000),
  lease_token TEXT CHECK (lease_token IS NULL OR OCTET_LENGTH(lease_token) BETWEEN 1 AND 256),
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  error_code TEXT CHECK (error_code IS NULL OR error_code IN (
    'RPC_TRANSIENT','QUOTE_UNAVAILABLE','LEASE_EXPIRED','DECISION_INVALID'
  )),
  retry_exhausted_at TIMESTAMPTZ,
  staged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  payload_version INTEGER NOT NULL CHECK (payload_version = 1),
  payload JSONB NOT NULL,
  UNIQUE (mint, source_event_id, input_fingerprint),
  CHECK (
    (status = 'PROCESSING' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'PROCESSING' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (status = 'RETRYABLE_FAILED' AND next_attempt_at IS NOT NULL AND error_code IS NOT NULL)
    OR (status <> 'RETRYABLE_FAILED' AND next_attempt_at IS NULL)
  ),
  CHECK (
    (status IN ('COMPLETED','CANCELLED') AND terminal_at IS NOT NULL AND purge_after IS NOT NULL)
    OR (status NOT IN ('COMPLETED','CANCELLED') AND terminal_at IS NULL AND purge_after IS NULL)
  ),
  CHECK ((terminal_at IS NULL AND purge_after IS NULL)
    OR purge_after = terminal_at + INTERVAL '4 hours')
);

CREATE INDEX IF NOT EXISTS paper_decision_jobs_claim_idx
  ON paper_decision_jobs(next_attempt_at, created_at, job_id)
  WHERE status IN ('PENDING','RETRYABLE_FAILED');
CREATE INDEX IF NOT EXISTS paper_decision_jobs_lease_idx
  ON paper_decision_jobs(lease_expires_at, job_id) WHERE status = 'PROCESSING';
CREATE INDEX IF NOT EXISTS paper_decision_jobs_purge_idx
  ON paper_decision_jobs(purge_after, job_id) WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS qualification_reports (
  report_id TEXT PRIMARY KEY CHECK (report_id ~ '^qreport_[0-9a-f]{64}$'),
  mint TEXT NOT NULL REFERENCES token_launches(mint),
  source_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  source_raw_event_id TEXT NOT NULL REFERENCES raw_chain_events(event_id),
  qualification_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  profile_id TEXT NOT NULL CHECK (OCTET_LENGTH(profile_id) BETWEEN 1 AND 256),
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  profile_fingerprint TEXT NOT NULL CHECK (profile_fingerprint ~ '^[0-9a-f]{64}$'),
  evidence_fingerprint TEXT NOT NULL CHECK (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  verdict TEXT NOT NULL CHECK (verdict IN ('QUALIFIED','WATCHLISTED','REJECTED')),
  preparation_score INTEGER NOT NULL CHECK (preparation_score >= 0),
  social_score INTEGER NOT NULL CHECK (social_score >= 0),
  onchain_score INTEGER NOT NULL CHECK (onchain_score >= 0),
  total_score INTEGER NOT NULL CHECK (total_score BETWEEN 0 AND 100),
  as_of_slot NUMERIC(78,0) NOT NULL CHECK (as_of_slot >= 0),
  as_of_transaction_index INTEGER NOT NULL CHECK (as_of_transaction_index >= 0),
  as_of_instruction_index INTEGER NOT NULL CHECK (as_of_instruction_index >= 0),
  as_of_inner_instruction_index INTEGER CHECK (as_of_inner_instruction_index >= 0),
  confirmation_status TEXT NOT NULL CHECK (
    confirmation_status IN ('processed','confirmed','finalized','orphaned')
  ),
  evaluated_at TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ NOT NULL,
  payload_version INTEGER NOT NULL CHECK (payload_version = 1),
  payload JSONB NOT NULL,
  UNIQUE (mint, profile_id, profile_version, evidence_fingerprint, source_event_id),
  CHECK (purge_after = evaluated_at + INTERVAL '4 hours'),
  CHECK (superseded_at IS NULL OR superseded_at >= evaluated_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS qualification_reports_current_idx
  ON qualification_reports(mint, profile_id, profile_version)
  WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS qualification_reports_purge_idx
  ON qualification_reports(purge_after, report_id);

CREATE TABLE IF NOT EXISTS trading_candidates (
  candidate_id TEXT PRIMARY KEY CHECK (candidate_id ~ '^candidate_[0-9a-f]{64}$'),
  mint TEXT NOT NULL REFERENCES token_launches(mint),
  report_id TEXT NOT NULL REFERENCES qualification_reports(report_id),
  source_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  candidate_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  strategy_id TEXT NOT NULL CHECK (OCTET_LENGTH(strategy_id) BETWEEN 1 AND 256),
  strategy_version INTEGER NOT NULL CHECK (strategy_version > 0),
  evidence_fingerprint TEXT NOT NULL CHECK (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('NOT_ELIGIBLE','ELIGIBLE','EXPIRED','REVOKED')),
  quote_mint TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL CHECK (quote_decimals BETWEEN 0 AND 255),
  quote_token_program TEXT NOT NULL CHECK (quote_token_program IN ('SPL_TOKEN','TOKEN_2022')),
  reason_codes JSONB NOT NULL CHECK (
    jsonb_typeof(reason_codes) = 'array'
    AND jsonb_array_length(reason_codes) <= 9
    AND reason_codes <@ '[
      "QUALIFICATION_NOT_ELIGIBLE","ENTRY_WINDOW_EXPIRED","EVIDENCE_REVOKED",
      "QUALIFIED_ENTRY","EXTERNAL_BUY_OBSERVED","EXTERNAL_BUY_TARGET_REACHED",
      "EXIT_QUOTE_UNAVAILABLE","SOURCE_ORPHANED","RECONCILIATION_REQUIRED"
    ]'::jsonb
  ),
  eligible_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ NOT NULL,
  payload_version INTEGER NOT NULL CHECK (payload_version = 1),
  payload JSONB NOT NULL,
  UNIQUE (mint, strategy_id, strategy_version, evidence_fingerprint, source_event_id),
  CHECK (purge_after = created_at + INTERVAL '4 hours'),
  CHECK ((state = 'ELIGIBLE' AND eligible_until IS NOT NULL) OR state <> 'ELIGIBLE'),
  CHECK (superseded_at IS NULL OR superseded_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS trading_candidates_current_idx
  ON trading_candidates(mint, strategy_id, strategy_version)
  WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS trading_candidates_purge_idx
  ON trading_candidates(purge_after, candidate_id);

CREATE TABLE IF NOT EXISTS paper_strategy_sessions (
  session_id TEXT PRIMARY KEY CHECK (session_id ~ '^paper_session_[0-9a-f]{64}$'),
  mint TEXT NOT NULL REFERENCES token_launches(mint),
  candidate_id TEXT NOT NULL REFERENCES trading_candidates(candidate_id),
  report_id TEXT NOT NULL REFERENCES qualification_reports(report_id),
  source_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  session_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  strategy_id TEXT NOT NULL CHECK (OCTET_LENGTH(strategy_id) BETWEEN 1 AND 256),
  strategy_version INTEGER NOT NULL CHECK (strategy_version > 0),
  actor_kind TEXT NOT NULL CHECK (actor_kind = 'PAPER_SIMULATION'),
  state TEXT NOT NULL CHECK (state IN (
    'BUY_PENDING','PAPER_HOLDING','WAITING_EXTERNAL_BUYS','EXIT_PENDING_QUOTE',
    'SELL_PENDING','PAPER_CLOSED','PAPER_RETRACTED','MANUAL_REVIEW'
  )),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'QUALIFICATION_NOT_ELIGIBLE','ENTRY_WINDOW_EXPIRED','EVIDENCE_REVOKED',
    'QUALIFIED_ENTRY','EXTERNAL_BUY_OBSERVED','EXTERNAL_BUY_TARGET_REACHED',
    'EXIT_QUOTE_UNAVAILABLE','SOURCE_ORPHANED','RECONCILIATION_REQUIRED'
  )),
  quote_mint TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL CHECK (quote_decimals BETWEEN 0 AND 255),
  quote_token_program TEXT NOT NULL CHECK (quote_token_program IN ('SPL_TOKEN','TOKEN_2022')),
  position_id TEXT,
  open_command_id TEXT NOT NULL CHECK (open_command_id ~ '^paper_open_[0-9a-f]{64}$'),
  close_command_id TEXT CHECK (close_command_id IS NULL OR close_command_id ~ '^paper_sell_[0-9a-f]{64}$'),
  entry_slot NUMERIC(78,0) NOT NULL CHECK (entry_slot >= 0),
  entry_transaction_index INTEGER NOT NULL CHECK (entry_transaction_index >= 0),
  entry_instruction_index INTEGER NOT NULL CHECK (entry_instruction_index >= 0),
  entry_inner_instruction_index INTEGER CHECK (entry_inner_instruction_index >= 0),
  external_buy_target INTEGER NOT NULL CHECK (external_buy_target BETWEEN 1 AND 1000),
  external_buy_count INTEGER NOT NULL CHECK (
    external_buy_count BETWEEN 0 AND 1000 AND external_buy_count <= external_buy_target
  ),
  minimum_confirmation TEXT NOT NULL CHECK (minimum_confirmation IN ('confirmed','finalized')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  payload_version INTEGER NOT NULL CHECK (payload_version = 1),
  payload JSONB NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (
    (state IN ('PAPER_CLOSED','PAPER_RETRACTED','MANUAL_REVIEW')
      AND terminal_at IS NOT NULL AND purge_after IS NOT NULL)
    OR (state NOT IN ('PAPER_CLOSED','PAPER_RETRACTED','MANUAL_REVIEW')
      AND terminal_at IS NULL AND purge_after IS NULL)
  ),
  CHECK ((terminal_at IS NULL AND purge_after IS NULL)
    OR purge_after = terminal_at + INTERVAL '4 hours')
);

CREATE UNIQUE INDEX IF NOT EXISTS paper_strategy_sessions_active_idx
  ON paper_strategy_sessions(mint, strategy_id, strategy_version)
  WHERE state IN ('BUY_PENDING','PAPER_HOLDING','WAITING_EXTERNAL_BUYS','EXIT_PENDING_QUOTE','SELL_PENDING');
CREATE INDEX IF NOT EXISTS paper_strategy_sessions_purge_idx
  ON paper_strategy_sessions(purge_after, session_id) WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS paper_external_buy_events (
  session_id TEXT NOT NULL REFERENCES paper_strategy_sessions(session_id),
  trade_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  mint TEXT NOT NULL REFERENCES token_launches(mint),
  quote_mint TEXT NOT NULL,
  trader TEXT,
  slot NUMERIC(78,0) NOT NULL CHECK (slot >= 0),
  transaction_index INTEGER NOT NULL CHECK (transaction_index >= 0),
  instruction_index INTEGER NOT NULL CHECK (instruction_index >= 0),
  inner_instruction_index INTEGER CHECK (inner_instruction_index >= 0),
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('confirmed','finalized')),
  observed_at TIMESTAMPTZ NOT NULL,
  purge_after TIMESTAMPTZ,
  payload_version INTEGER NOT NULL CHECK (payload_version = 1),
  payload JSONB NOT NULL,
  UNIQUE (session_id, trade_id),
  CHECK (purge_after IS NULL OR purge_after >= observed_at + INTERVAL '4 hours')
);

CREATE INDEX IF NOT EXISTS paper_external_buy_events_session_idx
  ON paper_external_buy_events(session_id, slot, transaction_index, instruction_index,
    COALESCE(inner_instruction_index, -1), trade_id);
CREATE INDEX IF NOT EXISTS paper_external_buy_events_purge_idx
  ON paper_external_buy_events(purge_after, session_id, trade_id) WHERE purge_after IS NOT NULL;

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS strategy_session_id TEXT;
ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS qualification_report_id TEXT;
ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS candidate_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS paper_positions_strategy_session_idx
  ON paper_positions(strategy_session_id) WHERE strategy_session_id IS NOT NULL;

DO $$
DECLARE
  target_schema TEXT := current_schema();
  target_table REGCLASS := to_regclass(format('%I.api_event_stream', current_schema()));
  existing_constraint TEXT;
BEGIN
  FOR existing_constraint IN
    SELECT constraint_definition.conname
    FROM pg_constraint AS constraint_definition
    WHERE constraint_definition.conrelid = target_table
      AND constraint_definition.contype = 'c'
      AND pg_get_constraintdef(constraint_definition.oid) LIKE '%event_type%'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.api_event_stream DROP CONSTRAINT %I',
      target_schema,
      existing_constraint
    );
  END LOOP;
END;
$$;

ALTER TABLE api_event_stream
  ADD CONSTRAINT api_event_stream_event_type_check CHECK (event_type IN (
    'TokenLaunchDetected',
    'TokenMetadataResolved',
    'TokenMetadataFailed',
    'SocialEvidenceCollected',
    'CreatorProfileUpdated',
    'HolderDistributionUpdated',
    'WalletClusterDetected',
    'BondingCurveTradeObserved',
    'BondingCurveStateUpdated',
    'BondingCurveCompleted',
    'QualificationUpdated',
    'TradingCandidateUpdated',
    'PaperStrategySessionUpdated',
    'PaperExternalBuyCounted',
    'PaperPositionOpened',
    'PaperPositionUpdated',
    'PaperPositionClosed',
    'MigrationObserved',
    'PumpSwapPoolActivated'
  ));

DO $$
DECLARE
  target_schema TEXT := current_schema();
  backfill_purge_after TIMESTAMPTZ := clock_timestamp() + INTERVAL '4 hours';
BEGIN
  PERFORM pg_advisory_xact_lock(1095782223, 1163281235);
  EXECUTE format(
    $sql$
      INSERT INTO %1$I.api_event_stream (
        stream_event_id, domain_event_id, revision, event_type, mint, confirmation_status,
        payload_version, event, purge_after
      )
      SELECT
        event_id || ':1:' || confirmation_status || ':' || payload_version::text
          || ':' || md5(public_event::text),
        event_id, 1, type, mint, confirmation_status, payload_version, public_event, $1
      FROM (
        SELECT domain_events.*,
          jsonb_build_object(
            'eventId', event_id, 'type', type, 'mint', mint, 'source', source,
            'program', program, 'signature', signature, 'slot', slot::text,
            'transactionIndex', transaction_index, 'instructionIndex', instruction_index,
            'innerInstructionIndex', inner_instruction_index,
            'confirmationStatus', confirmation_status,
            'blockchainTime', to_jsonb(to_char(
              blockchain_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )),
            'observedAt', to_jsonb(to_char(
              observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )),
            'payloadVersion', payload_version, 'payload', payload
          ) AS public_event
        FROM %1$I.domain_events
        WHERE type IN (
          'TradingCandidateUpdated','PaperStrategySessionUpdated','PaperExternalBuyCounted'
        )
          AND (purge_after IS NULL OR purge_after > clock_timestamp())
          AND NOT EXISTS (
            SELECT 1 FROM %1$I.api_event_stream existing
            WHERE existing.domain_event_id = domain_events.event_id
          )
      ) retained
      ORDER BY created_at, event_id
      ON CONFLICT (domain_event_id, revision) DO NOTHING
    $sql$,
    target_schema
  ) USING backfill_purge_after;

  EXECUTE format(
    'UPDATE %I.api_event_stream_state
     SET last_sequence = GREATEST(last_sequence,
       COALESCE((SELECT MAX(sequence) FROM %I.api_event_stream), 0))
     WHERE id = 1',
    target_schema,
    target_schema
  );
END;
$$;
