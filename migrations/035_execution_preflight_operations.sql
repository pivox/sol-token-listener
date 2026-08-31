CREATE TABLE IF NOT EXISTS execution_safety_qualifications (
  qualification_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  evaluator_version SMALLINT NOT NULL,
  qualification_fingerprint TEXT NOT NULL UNIQUE,
  phase TEXT NOT NULL,
  build_hash TEXT NOT NULL,
  configuration_fingerprint TEXT NOT NULL,
  strategy_fingerprint TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  wallet_public_key TEXT NOT NULL,
  cluster TEXT NOT NULL,
  genesis_hash TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  qualified_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  purge_after TIMESTAMPTZ NOT NULL,
  CONSTRAINT execution_safety_qualifications_generation_fkey
    FOREIGN KEY (generation_id)
    REFERENCES execution_wallet_generations (generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_safety_qualifications_identity_check CHECK (
    payload_version = 1 AND evaluator_version = 1
    AND qualification_id ~ '^execution_safety_qualification_[0-9a-f]{64}$'
    AND qualification_fingerprint ~ '^[0-9a-f]{64}$'
    AND phase IN ('CANARY', 'MICRO_LIVE', 'PILOT')
    AND build_hash ~ '^[0-9a-f]{64}$'
    AND configuration_fingerprint ~ '^[0-9a-f]{64}$'
    AND strategy_fingerprint ~ '^[0-9a-f]{64}$'
    AND wallet_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND cluster = 'mainnet-beta'
    AND genesis_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,64}$'
    AND octet_length(provider_id) BETWEEN 1 AND 64
  ),
  CONSTRAINT execution_safety_qualifications_temporal_check CHECK (
    isfinite(qualified_at) AND isfinite(expires_at) AND isfinite(purge_after)
    AND date_trunc('milliseconds', qualified_at) = qualified_at
    AND date_trunc('milliseconds', expires_at) = expires_at
    AND date_trunc('milliseconds', purge_after) = purge_after
    AND expires_at = qualified_at + INTERVAL '5 minutes'
    AND purge_after = expires_at + INTERVAL '4 hours'
  )
);

CREATE INDEX IF NOT EXISTS execution_safety_qualifications_generation_expiry_idx
  ON execution_safety_qualifications (generation_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS execution_safety_gate_evidence (
  qualification_id TEXT NOT NULL,
  gate_index SMALLINT NOT NULL,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  gate_id TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (qualification_id, gate_index),
  CONSTRAINT execution_safety_gate_evidence_gate_unique
    UNIQUE (qualification_id, gate_id),
  CONSTRAINT execution_safety_gate_evidence_qualification_fkey
    FOREIGN KEY (qualification_id)
    REFERENCES execution_safety_qualifications (qualification_id) ON DELETE CASCADE,
  CONSTRAINT execution_safety_gate_evidence_identity_check CHECK (
    payload_version = 1 AND status = 'PASSED'
    AND octet_length(evidence_id) BETWEEN 1 AND 256
    AND evidence_fingerprint ~ '^[0-9a-f]{64}$'
    AND (
      (gate_index=0 AND gate_id='QUALITY_GATES_PASSED' AND evidence_type='CI_RUN')
      OR (gate_index=1 AND gate_id='MIGRATIONS_VERIFIED' AND evidence_type='MIGRATION_TEST')
      OR (gate_index=2 AND gate_id='ARCHITECTURE_BOUNDARIES_VERIFIED'
        AND evidence_type='ARCHITECTURE_TEST')
      OR (gate_index=3 AND gate_id='DRY_RUN_RECOVERY_VERIFIED'
        AND evidence_type='DRY_RUN_TEST')
      OR (gate_index=4 AND gate_id='SIMULATION_MATRIX_VERIFIED'
        AND evidence_type='SIMULATION_ARTIFACT')
      OR (gate_index=5 AND gate_id='FAULT_MATRIX_VERIFIED' AND evidence_type='FAULT_TEST')
      OR (gate_index=6 AND gate_id='RECONCILIATION_CLEAN'
        AND evidence_type='RECONCILIATION_STATE')
      OR (gate_index=7 AND gate_id='PROVIDER_EXIT_CAPACITY_VERIFIED'
        AND evidence_type='PROVIDER_SNAPSHOT')
      OR (gate_index=8 AND gate_id='STOP_CONTROLS_VERIFIED'
        AND evidence_type='STOP_CONTROL_TEST')
      OR (gate_index=9 AND gate_id='WALLET_CHAIN_LIMITS_VERIFIED'
        AND evidence_type='WALLET_SNAPSHOT')
      OR (gate_index=10 AND gate_id='MAINNET_PREFLIGHT_SIMULATED'
        AND evidence_type='MAINNET_SIMULATION_ARTIFACT')
    )
  ),
  CONSTRAINT execution_safety_gate_evidence_temporal_check CHECK (
    isfinite(observed_at) AND isfinite(expires_at)
    AND date_trunc('milliseconds', observed_at) = observed_at
    AND date_trunc('milliseconds', expires_at) = expires_at
    AND expires_at >= observed_at
  )
);

CREATE TABLE IF NOT EXISTS execution_control_state (
  generation_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'ENTRY_STOP',
  state_revision BIGINT NOT NULL DEFAULT 0,
  last_event_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp()),
  CONSTRAINT execution_control_state_generation_fkey
    FOREIGN KEY (generation_id)
    REFERENCES execution_wallet_generations (generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_control_state_identity_check CHECK (
    payload_version = 1
    AND state IN ('RUNNING', 'ENTRY_STOP', 'HARD_STOP')
    AND state_revision >= 0
    AND (last_event_id IS NULL
      OR last_event_id ~ '^execution_control_event_[0-9a-f]{64}$')
  ),
  CONSTRAINT execution_control_state_temporal_check CHECK (
    isfinite(updated_at) AND date_trunc('milliseconds', updated_at) = updated_at
  )
);

CREATE TABLE IF NOT EXISTS execution_operator_authorizations (
  authorization_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  authorization_fingerprint TEXT NOT NULL UNIQUE,
  generation_id TEXT NOT NULL,
  action TEXT NOT NULL,
  phase TEXT,
  context_fingerprint TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ NOT NULL,
  CONSTRAINT execution_operator_authorizations_generation_fkey
    FOREIGN KEY (generation_id)
    REFERENCES execution_wallet_generations (generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_operator_authorizations_identity_check CHECK (
    payload_version = 1
    AND authorization_id ~ '^execution_operator_authorization_[0-9a-f]{64}$'
    AND authorization_fingerprint ~ '^[0-9a-f]{64}$'
    AND action IN ('ARM', 'RESUME')
    AND ((action='ARM' AND phase IN ('CANARY', 'MICRO_LIVE', 'PILOT'))
      OR (action='RESUME' AND phase IS NULL))
    AND context_fingerprint ~ '^[0-9a-f]{64}$'
    AND nonce_hash ~ '^[0-9a-f]{64}$'
    AND octet_length(operator_id) BETWEEN 1 AND 64
  ),
  CONSTRAINT execution_operator_authorizations_temporal_check CHECK (
    isfinite(issued_at) AND isfinite(expires_at) AND isfinite(purge_after)
    AND date_trunc('milliseconds', issued_at) = issued_at
    AND date_trunc('milliseconds', expires_at) = expires_at
    AND date_trunc('milliseconds', purge_after) = purge_after
    AND expires_at > issued_at AND expires_at <= issued_at + INTERVAL '5 minutes'
    AND (consumed_at IS NULL OR (
      isfinite(consumed_at) AND date_trunc('milliseconds', consumed_at) = consumed_at
      AND consumed_at >= issued_at AND consumed_at <= expires_at
    ))
    AND purge_after = COALESCE(consumed_at, expires_at) + INTERVAL '4 hours'
  )
);

CREATE TABLE IF NOT EXISTS execution_control_events (
  event_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  event_fingerprint TEXT NOT NULL UNIQUE,
  generation_id TEXT NOT NULL,
  previous_state TEXT,
  next_state TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  qualification_id TEXT,
  authorization_id TEXT,
  operator_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT execution_control_events_generation_fkey
    FOREIGN KEY (generation_id)
    REFERENCES execution_wallet_generations (generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_control_events_qualification_fkey
    FOREIGN KEY (qualification_id)
    REFERENCES execution_safety_qualifications (qualification_id) ON DELETE RESTRICT,
  CONSTRAINT execution_control_events_authorization_fkey
    FOREIGN KEY (authorization_id)
    REFERENCES execution_operator_authorizations (authorization_id) ON DELETE RESTRICT,
  CONSTRAINT execution_control_events_identity_check CHECK (
    payload_version = 1
    AND event_id ~ '^execution_control_event_[0-9a-f]{64}$'
    AND event_fingerprint ~ '^[0-9a-f]{64}$'
    AND (previous_state IS NULL OR previous_state IN ('RUNNING', 'ENTRY_STOP', 'HARD_STOP'))
    AND next_state IN ('RUNNING', 'ENTRY_STOP', 'HARD_STOP')
    AND reason_code IN ('OPERATOR_ENTRY_STOP', 'OPERATOR_HARD_STOP', 'OPERATOR_RESUME')
    AND octet_length(operator_id) BETWEEN 1 AND 64
    AND ((reason_code='OPERATOR_RESUME' AND qualification_id IS NOT NULL
      AND authorization_id IS NOT NULL AND next_state='RUNNING')
      OR (reason_code<>'OPERATOR_RESUME' AND qualification_id IS NULL
        AND authorization_id IS NULL AND next_state<>'RUNNING'))
  ),
  CONSTRAINT execution_control_events_temporal_check CHECK (
    isfinite(occurred_at) AND date_trunc('milliseconds', occurred_at) = occurred_at
  )
);

CREATE INDEX IF NOT EXISTS execution_control_events_generation_occurred_idx
  ON execution_control_events (generation_id, occurred_at DESC, event_id DESC);

CREATE TABLE IF NOT EXISTS execution_activation_armaments (
  armament_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  armament_fingerprint TEXT NOT NULL UNIQUE,
  qualification_id TEXT NOT NULL,
  qualification_fingerprint TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  authorization_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  state_revision BIGINT NOT NULL DEFAULT 0,
  phase TEXT NOT NULL,
  build_hash TEXT NOT NULL,
  configuration_fingerprint TEXT NOT NULL,
  strategy_fingerprint TEXT NOT NULL,
  wallet_public_key TEXT NOT NULL,
  cluster TEXT NOT NULL,
  genesis_hash TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  maximum_buys SMALLINT NOT NULL,
  consumed_buys SMALLINT NOT NULL DEFAULT 0,
  maximum_capital_lamports NUMERIC NOT NULL,
  maximum_exposure_bps NUMERIC NOT NULL,
  maximum_open_positions SMALLINT NOT NULL,
  maximum_holding_ms INTEGER NOT NULL,
  operator_id TEXT NOT NULL,
  operator_reason TEXT NOT NULL,
  armed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  purge_after TIMESTAMPTZ,
  CONSTRAINT execution_activation_armaments_qualification_fkey
    FOREIGN KEY (qualification_id)
    REFERENCES execution_safety_qualifications (qualification_id) ON DELETE RESTRICT,
  CONSTRAINT execution_activation_armaments_generation_fkey
    FOREIGN KEY (generation_id)
    REFERENCES execution_wallet_generations (generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_activation_armaments_authorization_fkey
    FOREIGN KEY (authorization_id)
    REFERENCES execution_operator_authorizations (authorization_id) ON DELETE RESTRICT,
  CONSTRAINT execution_activation_armaments_identity_check CHECK (
    payload_version = 1
    AND armament_id ~ '^execution_activation_armament_[0-9a-f]{64}$'
    AND armament_fingerprint ~ '^[0-9a-f]{64}$'
    AND qualification_fingerprint ~ '^[0-9a-f]{64}$'
    AND state IN ('ARMED', 'LOCKED', 'CONSUMED', 'REVOKED', 'EXPIRED')
    AND state_revision >= 0
    AND phase IN ('CANARY', 'MICRO_LIVE', 'PILOT')
    AND build_hash ~ '^[0-9a-f]{64}$'
    AND configuration_fingerprint ~ '^[0-9a-f]{64}$'
    AND strategy_fingerprint ~ '^[0-9a-f]{64}$'
    AND wallet_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND cluster='mainnet-beta'
    AND genesis_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,64}$'
    AND octet_length(provider_id) BETWEEN 1 AND 64
    AND octet_length(operator_id) BETWEEN 1 AND 64
    AND octet_length(operator_reason) BETWEEN 1 AND 256
    AND maximum_buys BETWEEN 1 AND 10
    AND consumed_buys BETWEEN 0 AND maximum_buys
    AND maximum_open_positions BETWEEN 1 AND 2
    AND maximum_holding_ms BETWEEN 30000 AND 900000
    AND ((phase='CANARY' AND maximum_buys=1 AND maximum_exposure_bps=500
      AND maximum_open_positions=1)
      OR (phase='MICRO_LIVE' AND maximum_buys=3 AND maximum_exposure_bps=500
        AND maximum_open_positions=1)
      OR (phase='PILOT' AND maximum_exposure_bps BETWEEN 1 AND 2000
        AND maximum_open_positions=2))
  ),
  CONSTRAINT execution_activation_armaments_amounts_check CHECK (
    maximum_capital_lamports <> 'NaN'::NUMERIC
    AND maximum_capital_lamports > 0
    AND maximum_capital_lamports = trunc(maximum_capital_lamports)
    AND scale(maximum_capital_lamports)=0
    AND maximum_capital_lamports < 18446744073709551616
    AND maximum_exposure_bps <> 'NaN'::NUMERIC
    AND maximum_exposure_bps = trunc(maximum_exposure_bps)
    AND scale(maximum_exposure_bps)=0
  ),
  CONSTRAINT execution_activation_armaments_state_check CHECK (
    (state IN ('ARMED','LOCKED') AND terminal_at IS NULL AND purge_after IS NULL)
    OR (state IN ('CONSUMED','REVOKED','EXPIRED') AND terminal_at IS NOT NULL
      AND purge_after = terminal_at + INTERVAL '4 hours')
  ),
  CONSTRAINT execution_activation_armaments_temporal_check CHECK (
    isfinite(armed_at) AND isfinite(expires_at)
    AND date_trunc('milliseconds', armed_at)=armed_at
    AND date_trunc('milliseconds', expires_at)=expires_at
    AND expires_at > armed_at AND expires_at <= armed_at + INTERVAL '15 minutes'
    AND (terminal_at IS NULL OR (
      isfinite(terminal_at) AND date_trunc('milliseconds', terminal_at)=terminal_at
      AND terminal_at >= armed_at
    ))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS execution_activation_armaments_generation_active_unique
  ON execution_activation_armaments (generation_id)
  WHERE state IN ('ARMED', 'LOCKED');

CREATE INDEX IF NOT EXISTS execution_activation_armaments_generation_armed_idx
  ON execution_activation_armaments (generation_id, armed_at DESC);

CREATE TABLE IF NOT EXISTS execution_activation_events (
  event_id TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  event_fingerprint TEXT NOT NULL UNIQUE,
  armament_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  previous_state TEXT,
  next_state TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT execution_activation_events_armament_fkey
    FOREIGN KEY (armament_id)
    REFERENCES execution_activation_armaments (armament_id) ON DELETE RESTRICT,
  CONSTRAINT execution_activation_events_generation_fkey
    FOREIGN KEY (generation_id)
    REFERENCES execution_wallet_generations (generation_id) ON DELETE RESTRICT,
  CONSTRAINT execution_activation_events_identity_check CHECK (
    payload_version=1
    AND event_id ~ '^execution_activation_event_[0-9a-f]{64}$'
    AND event_fingerprint ~ '^[0-9a-f]{64}$'
    AND (previous_state IS NULL
      OR previous_state IN ('ARMED','LOCKED','CONSUMED','REVOKED','EXPIRED'))
    AND next_state IN ('ARMED','LOCKED','CONSUMED','REVOKED','EXPIRED')
    AND reason_code IN ('OPERATOR_ARMED','ARMAMENT_LOCKED','ARMAMENT_CONSUMED',
      'ARMAMENT_REVOKED','ARMAMENT_EXPIRED')
  ),
  CONSTRAINT execution_activation_events_temporal_check CHECK (
    isfinite(occurred_at) AND date_trunc('milliseconds', occurred_at)=occurred_at
  )
);

CREATE INDEX IF NOT EXISTS execution_activation_events_armament_occurred_idx
  ON execution_activation_events (armament_id, occurred_at, event_id);

CREATE OR REPLACE FUNCTION reject_execution_operations_immutable_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'execution operations payload is immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS execution_safety_qualifications_immutable
  ON execution_safety_qualifications;
CREATE TRIGGER execution_safety_qualifications_immutable
  BEFORE UPDATE ON execution_safety_qualifications
  FOR EACH ROW EXECUTE FUNCTION reject_execution_operations_immutable_update();

DROP TRIGGER IF EXISTS execution_safety_gate_evidence_immutable
  ON execution_safety_gate_evidence;
CREATE TRIGGER execution_safety_gate_evidence_immutable
  BEFORE UPDATE ON execution_safety_gate_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_execution_operations_immutable_update();

DROP TRIGGER IF EXISTS execution_control_events_immutable
  ON execution_control_events;
CREATE TRIGGER execution_control_events_immutable
  BEFORE UPDATE ON execution_control_events
  FOR EACH ROW EXECUTE FUNCTION reject_execution_operations_immutable_update();

DROP TRIGGER IF EXISTS execution_activation_events_immutable
  ON execution_activation_events;
CREATE TRIGGER execution_activation_events_immutable
  BEFORE UPDATE ON execution_activation_events
  FOR EACH ROW EXECUTE FUNCTION reject_execution_operations_immutable_update();

CREATE OR REPLACE FUNCTION guard_execution_operator_authorization_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
    OR NEW.payload_version IS DISTINCT FROM OLD.payload_version
    OR NEW.authorization_fingerprint IS DISTINCT FROM OLD.authorization_fingerprint
    OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
    OR NEW.action IS DISTINCT FROM OLD.action
    OR NEW.phase IS DISTINCT FROM OLD.phase
    OR NEW.context_fingerprint IS DISTINCT FROM OLD.context_fingerprint
    OR NEW.nonce_hash IS DISTINCT FROM OLD.nonce_hash
    OR NEW.operator_id IS DISTINCT FROM OLD.operator_id
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR OLD.consumed_at IS NOT NULL
    OR NEW.consumed_at IS NULL
  THEN
    RAISE EXCEPTION 'execution operator authorization identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_operator_authorizations_identity_immutable
  ON execution_operator_authorizations;
CREATE TRIGGER execution_operator_authorizations_identity_immutable
  BEFORE UPDATE ON execution_operator_authorizations
  FOR EACH ROW EXECUTE FUNCTION guard_execution_operator_authorization_update();

CREATE OR REPLACE FUNCTION guard_execution_activation_armament_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.armament_id IS DISTINCT FROM OLD.armament_id
    OR NEW.payload_version IS DISTINCT FROM OLD.payload_version
    OR NEW.armament_fingerprint IS DISTINCT FROM OLD.armament_fingerprint
    OR NEW.qualification_id IS DISTINCT FROM OLD.qualification_id
    OR NEW.qualification_fingerprint IS DISTINCT FROM OLD.qualification_fingerprint
    OR NEW.generation_id IS DISTINCT FROM OLD.generation_id
    OR NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
    OR NEW.phase IS DISTINCT FROM OLD.phase
    OR NEW.build_hash IS DISTINCT FROM OLD.build_hash
    OR NEW.configuration_fingerprint IS DISTINCT FROM OLD.configuration_fingerprint
    OR NEW.strategy_fingerprint IS DISTINCT FROM OLD.strategy_fingerprint
    OR NEW.wallet_public_key IS DISTINCT FROM OLD.wallet_public_key
    OR NEW.cluster IS DISTINCT FROM OLD.cluster
    OR NEW.genesis_hash IS DISTINCT FROM OLD.genesis_hash
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.maximum_buys IS DISTINCT FROM OLD.maximum_buys
    OR NEW.maximum_capital_lamports IS DISTINCT FROM OLD.maximum_capital_lamports
    OR NEW.maximum_exposure_bps IS DISTINCT FROM OLD.maximum_exposure_bps
    OR NEW.maximum_open_positions IS DISTINCT FROM OLD.maximum_open_positions
    OR NEW.maximum_holding_ms IS DISTINCT FROM OLD.maximum_holding_ms
    OR NEW.operator_id IS DISTINCT FROM OLD.operator_id
    OR NEW.operator_reason IS DISTINCT FROM OLD.operator_reason
    OR NEW.armed_at IS DISTINCT FROM OLD.armed_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION 'execution activation armament identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_activation_armaments_identity_immutable
  ON execution_activation_armaments;
CREATE TRIGGER execution_activation_armaments_identity_immutable
  BEFORE UPDATE ON execution_activation_armaments
  FOR EACH ROW EXECUTE FUNCTION guard_execution_activation_armament_update();
