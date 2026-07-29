CREATE TABLE IF NOT EXISTS wallet_funding_observations (
  assessment_id TEXT PRIMARY KEY,
  immutable_fingerprint TEXT NOT NULL,
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  trade_event_id TEXT NOT NULL,
  trade_id TEXT NOT NULL,
  buyer TEXT NOT NULL,
  source TEXT NOT NULL,
  program TEXT NOT NULL,
  signature TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL CHECK (quote_decimals BETWEEN 0 AND 255),
  quote_token_program TEXT NOT NULL
    CHECK (quote_token_program IN ('SPL_TOKEN', 'TOKEN_2022')),
  slot NUMERIC(78,0) NOT NULL CHECK (slot >= 0),
  transaction_index INTEGER NOT NULL CHECK (transaction_index >= 0),
  instruction_index INTEGER NOT NULL CHECK (instruction_index >= 0),
  inner_instruction_index INTEGER CHECK (inner_instruction_index >= 0),
  confirmation_status TEXT NOT NULL
    CHECK (confirmation_status IN (
      'processed', 'confirmed', 'finalized', 'orphaned'
    )),
  assessment_status TEXT NOT NULL
    CHECK (assessment_status IN (
      'STRONG', 'MEDIUM_ONLY', 'NO_EVIDENCE', 'UNAVAILABLE'
    )),
  inspected_transfer_count INTEGER NOT NULL
    CHECK (inspected_transfer_count >= 0),
  accepted_evidence_count INTEGER NOT NULL
    CHECK (accepted_evidence_count >= 0),
  ignored_transfer_count INTEGER NOT NULL
    CHECK (
      ignored_transfer_count >= 0
      AND ignored_transfer_count <= inspected_transfer_count
    ),
  diagnostic_codes JSONB NOT NULL,
  payload_version INTEGER NOT NULL CHECK (payload_version = 1),
  payload JSONB NOT NULL,
  blockchain_time TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL,
  purge_after TIMESTAMPTZ,
  UNIQUE (mint, trade_event_id),
  UNIQUE (mint, trade_id)
);
CREATE INDEX IF NOT EXISTS wallet_funding_observations_cursor_idx
  ON wallet_funding_observations (
    mint,
    slot,
    transaction_index,
    instruction_index,
    COALESCE(inner_instruction_index, -1),
    assessment_id
  );
CREATE INDEX IF NOT EXISTS wallet_funding_observations_purge_idx
  ON wallet_funding_observations(purge_after)
  WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS wallet_funding_evidence (
  evidence_id TEXT PRIMARY KEY,
  immutable_fingerprint TEXT NOT NULL,
  assessment_id TEXT NOT NULL
    REFERENCES wallet_funding_observations(assessment_id) ON DELETE CASCADE,
  mint TEXT NOT NULL REFERENCES token_launches(mint) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL
    CHECK (evidence_type IN (
      'DIRECT_QUOTE_TRANSFER', 'FEE_PAYER_FOR_BUYER'
    )),
  confidence TEXT NOT NULL CHECK (confidence IN ('STRONG', 'MEDIUM')),
  buyer TEXT NOT NULL,
  funder TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  quote_decimals INTEGER NOT NULL CHECK (quote_decimals BETWEEN 0 AND 255),
  quote_token_program TEXT NOT NULL
    CHECK (quote_token_program IN ('SPL_TOKEN', 'TOKEN_2022')),
  amount_raw NUMERIC(78,0),
  source TEXT NOT NULL,
  program TEXT NOT NULL,
  signature TEXT NOT NULL,
  transfer_slot NUMERIC(78,0),
  transfer_transaction_index INTEGER,
  transfer_instruction_index INTEGER,
  transfer_inner_instruction_index INTEGER,
  buy_event_id TEXT NOT NULL,
  buy_trade_id TEXT NOT NULL,
  buy_slot NUMERIC(78,0) NOT NULL CHECK (buy_slot >= 0),
  buy_transaction_index INTEGER NOT NULL CHECK (buy_transaction_index >= 0),
  buy_instruction_index INTEGER NOT NULL CHECK (buy_instruction_index >= 0),
  buy_inner_instruction_index INTEGER
    CHECK (buy_inner_instruction_index >= 0),
  confirmation_status TEXT NOT NULL
    CHECK (confirmation_status IN (
      'processed', 'confirmed', 'finalized', 'orphaned'
    )),
  payload_version INTEGER NOT NULL CHECK (payload_version = 1),
  payload JSONB NOT NULL,
  blockchain_time TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL,
  purge_after TIMESTAMPTZ,
  CHECK (buyer <> funder),
  CHECK (
    (
      evidence_type = 'DIRECT_QUOTE_TRANSFER'
      AND confidence = 'STRONG'
      AND amount_raw IS NOT NULL
      AND amount_raw > 0
      AND transfer_slot IS NOT NULL
      AND transfer_transaction_index IS NOT NULL
      AND transfer_instruction_index IS NOT NULL
    )
    OR
    (
      evidence_type = 'FEE_PAYER_FOR_BUYER'
      AND confidence = 'MEDIUM'
      AND amount_raw IS NULL
      AND transfer_slot IS NULL
      AND transfer_transaction_index IS NULL
      AND transfer_instruction_index IS NULL
      AND transfer_inner_instruction_index IS NULL
    )
  )
);
CREATE INDEX IF NOT EXISTS wallet_funding_evidence_trade_idx
  ON wallet_funding_evidence(mint, buy_trade_id, evidence_id);
CREATE INDEX IF NOT EXISTS wallet_funding_evidence_buy_cursor_idx
  ON wallet_funding_evidence (
    mint,
    buy_slot,
    buy_transaction_index,
    buy_instruction_index,
    COALESCE(buy_inner_instruction_index, -1),
    evidence_id
  );
CREATE INDEX IF NOT EXISTS wallet_funding_evidence_purge_idx
  ON wallet_funding_evidence(purge_after)
  WHERE purge_after IS NOT NULL;
