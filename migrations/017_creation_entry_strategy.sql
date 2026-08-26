ALTER TABLE trading_candidates
  DROP CONSTRAINT IF EXISTS trading_candidates_reason_codes_check;
ALTER TABLE trading_candidates
  ADD CONSTRAINT trading_candidates_reason_codes_check CHECK (
    jsonb_typeof(reason_codes) = 'array'
    AND jsonb_array_length(reason_codes) <= 17
    AND reason_codes <@ '[
      "QUALIFICATION_NOT_ELIGIBLE","ENTRY_WINDOW_EXPIRED","EVIDENCE_REVOKED",
      "QUALIFIED_ENTRY","EXTERNAL_BUY_OBSERVED","EXTERNAL_BUY_TARGET_REACHED",
      "EXIT_QUOTE_UNAVAILABLE","SOURCE_ORPHANED","RECONCILIATION_REQUIRED",
      "CREATION_ENTRY_EXPIRED","CREATION_ENTRY_REJECTED",
      "EXTERNAL_UNIQUE_BUY_OBSERVED","EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED",
      "TAKE_PROFIT_2X_EXECUTABLE","CREATOR_EARLY_SELL","MANUAL_KILL_SWITCH",
      "SELL_QUOTE_UNAVAILABLE_OR_STALE"
    ]'::jsonb
  );

ALTER TABLE paper_strategy_sessions
  DROP CONSTRAINT IF EXISTS paper_strategy_sessions_reason_code_check;
ALTER TABLE paper_strategy_sessions
  ADD CONSTRAINT paper_strategy_sessions_reason_code_check CHECK (reason_code IN (
    'QUALIFICATION_NOT_ELIGIBLE','ENTRY_WINDOW_EXPIRED','EVIDENCE_REVOKED',
    'QUALIFIED_ENTRY','EXTERNAL_BUY_OBSERVED','EXTERNAL_BUY_TARGET_REACHED',
    'EXIT_QUOTE_UNAVAILABLE','SOURCE_ORPHANED','RECONCILIATION_REQUIRED',
    'CREATION_ENTRY_EXPIRED','CREATION_ENTRY_REJECTED',
    'EXTERNAL_UNIQUE_BUY_OBSERVED','EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED',
    'TAKE_PROFIT_2X_EXECUTABLE','CREATOR_EARLY_SELL','MANUAL_KILL_SWITCH',
    'SELL_QUOTE_UNAVAILABLE_OR_STALE'
  ));

ALTER TABLE paper_strategy_sessions
  DROP CONSTRAINT IF EXISTS paper_strategy_sessions_payload_version_check;
ALTER TABLE paper_strategy_sessions
  ADD CONSTRAINT paper_strategy_sessions_payload_version_check CHECK (
    payload_version IN (1, 2)
  );

ALTER TABLE paper_external_buy_events
  ADD COLUMN IF NOT EXISTS strategy_id TEXT;
ALTER TABLE paper_external_buy_events
  ADD COLUMN IF NOT EXISTS quote_amount_raw NUMERIC(78,0);

UPDATE paper_external_buy_events evidence
SET strategy_id = session.strategy_id
FROM paper_strategy_sessions session
WHERE session.session_id = evidence.session_id
  AND evidence.strategy_id IS NULL;

ALTER TABLE paper_external_buy_events
  ALTER COLUMN strategy_id SET NOT NULL;

ALTER TABLE paper_external_buy_events
  DROP CONSTRAINT IF EXISTS paper_external_buy_events_strategy_id_check;
ALTER TABLE paper_external_buy_events
  ADD CONSTRAINT paper_external_buy_events_strategy_id_check CHECK (
    strategy_id = BTRIM(strategy_id)
    AND OCTET_LENGTH(strategy_id) BETWEEN 1 AND 256
  );

ALTER TABLE paper_external_buy_events
  DROP CONSTRAINT IF EXISTS paper_external_buy_events_quote_amount_raw_check;
ALTER TABLE paper_external_buy_events
  ADD CONSTRAINT paper_external_buy_events_quote_amount_raw_check CHECK (
    quote_amount_raw IS NULL OR quote_amount_raw >= 0
  );

ALTER TABLE paper_external_buy_events
  DROP CONSTRAINT IF EXISTS paper_external_buy_events_creation_amount_check;
ALTER TABLE paper_external_buy_events
  ADD CONSTRAINT paper_external_buy_events_creation_amount_check CHECK (
    strategy_id <> 'creation-entry-v1'
    OR (quote_amount_raw IS NOT NULL AND quote_amount_raw > 0)
  );

ALTER TABLE paper_external_buy_events
  DROP CONSTRAINT IF EXISTS paper_external_buy_events_payload_version_check;
ALTER TABLE paper_external_buy_events
  ADD CONSTRAINT paper_external_buy_events_payload_version_check CHECK (
    payload_version IN (1, 2)
  );

CREATE UNIQUE INDEX IF NOT EXISTS paper_external_buy_events_creation_wallet_idx
  ON paper_external_buy_events(session_id, trader)
  WHERE strategy_id = 'creation-entry-v1' AND trader IS NOT NULL;
