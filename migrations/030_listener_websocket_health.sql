CREATE TABLE IF NOT EXISTS listener_websocket_health (
  service_key TEXT PRIMARY KEY,
  payload_version SMALLINT NOT NULL DEFAULT 1,
  supervision TEXT NOT NULL,
  owner_generation BIGINT NOT NULL,
  revision BIGINT NOT NULL,
  active_session_generation BIGINT,
  candidate_session_generation BIGINT,
  provider_id TEXT,
  candidate_provider_id TEXT,
  phase TEXT NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  last_observation_at TIMESTAMPTZ,
  -- PostgreSQL coerces NUMERIC(78,0) before CHECK evaluation and would silently
  -- round 1.5 to 2. Keep NUMERIC unscaled so the integer invariant can reject
  -- fractional input while the range check preserves the intended 78 digits.
  last_observation_slot NUMERIC,
  disconnect_occurred_at TIMESTAMPTZ,
  disconnect_reason_code TEXT,
  recovery_status TEXT NOT NULL,
  recovery_started_at TIMESTAMPTZ,
  recovery_completed_at TIMESTAMPTZ,
  recovery_reason_code TEXT,
  heartbeat_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  evidence_purge_after TIMESTAMPTZ,
  CONSTRAINT listener_websocket_health_payload_version_check CHECK (
    payload_version = 1
  ),
  CONSTRAINT listener_websocket_health_supervision_check CHECK (
    supervision IN ('INACTIVE', 'ACTIVE')
  ),
  CONSTRAINT listener_websocket_health_owner_generation_check CHECK (
    owner_generation >= 0
    AND (
      (supervision = 'INACTIVE' AND owner_generation = 0)
      OR (supervision = 'ACTIVE' AND owner_generation > 0)
    )
  ),
  CONSTRAINT listener_websocket_health_revision_check CHECK (
    revision >= 0
  ),
  CONSTRAINT listener_websocket_health_session_generation_check CHECK (
    (active_session_generation IS NULL OR active_session_generation > 0)
    AND (candidate_session_generation IS NULL OR candidate_session_generation > 0)
  ),
  CONSTRAINT listener_websocket_health_provider_check CHECK (
    (provider_id IS NULL OR provider_id IN ('primary', 'fallback-1', 'fallback-2', 'fallback-3'))
    AND (
      candidate_provider_id IS NULL
      OR candidate_provider_id IN ('primary', 'fallback-1', 'fallback-2', 'fallback-3')
    )
  ),
  CONSTRAINT listener_websocket_health_session_pair_check CHECK (
    (provider_id IS NULL) = (active_session_generation IS NULL)
    AND (candidate_provider_id IS NULL) = (candidate_session_generation IS NULL)
  ),
  CONSTRAINT listener_websocket_health_distinct_sessions_check CHECK (
    active_session_generation IS NULL
    OR candidate_session_generation IS NULL
    OR active_session_generation <> candidate_session_generation
  ),
  CONSTRAINT listener_websocket_health_phase_check CHECK (
    phase IN (
      'STOPPED', 'CONNECTING', 'WAITING_FOR_ACKS', 'ACKNOWLEDGED',
      'RECOVERING', 'RUNNING', 'DEGRADED', 'UNRECOVERABLE', 'STOPPING'
    )
  ),
  CONSTRAINT listener_websocket_health_acknowledged_at_check CHECK (
    acknowledged_at IS NULL OR isfinite(acknowledged_at)
  ),
  CONSTRAINT listener_websocket_health_observation_check CHECK (
    (last_observation_at IS NULL) = (last_observation_slot IS NULL)
    AND (last_observation_at IS NULL OR isfinite(last_observation_at))
    AND (
      last_observation_slot IS NULL
      OR (
        last_observation_slot <> 'NaN'::NUMERIC
        AND last_observation_slot >= 0
        AND scale(last_observation_slot) = 0
        AND last_observation_slot < 1e78::NUMERIC
      )
    )
  ),
  CONSTRAINT listener_websocket_health_disconnect_check CHECK (
    (disconnect_occurred_at IS NULL) = (disconnect_reason_code IS NULL)
    AND (disconnect_occurred_at IS NULL OR isfinite(disconnect_occurred_at))
    AND (
      disconnect_reason_code IS NULL
      OR disconnect_reason_code IN (
        'SETUP_TIMEOUT', 'ABORTED', 'SOCKET_ERROR', 'REMOTE_CLOSE',
        'PROTOCOL_INVALID', 'NOTIFICATION_FAILED', 'CLEANUP_FAILED',
        'UNEXPECTED_RESTART'
      )
    )
  ),
  CONSTRAINT listener_websocket_health_recovery_status_check CHECK (
    recovery_status IN ('NOT_REQUIRED', 'REQUIRED', 'IN_PROGRESS', 'RECOVERED', 'FAILED')
  ),
  CONSTRAINT listener_websocket_health_recovery_reason_check CHECK (
    recovery_reason_code IS NULL
    OR recovery_reason_code IN (
      'STARTUP', 'UNEXPECTED_RESTART', 'SESSION_FAILURE', 'RPC_UNAVAILABLE',
      'CHECKPOINT_CONFLICT', 'CATCH_UP_WINDOW_EXCEEDED'
    )
  ),
  CONSTRAINT listener_websocket_health_recovery_timestamp_check CHECK (
    (recovery_started_at IS NULL OR isfinite(recovery_started_at))
    AND (recovery_completed_at IS NULL OR isfinite(recovery_completed_at))
    AND (
      recovery_completed_at IS NULL
      OR (
        recovery_started_at IS NOT NULL
        AND recovery_completed_at >= recovery_started_at
      )
    )
  ),
  CONSTRAINT listener_websocket_health_recovery_lifecycle_check CHECK (
    (
      recovery_status = 'NOT_REQUIRED'
      AND recovery_started_at IS NULL
      AND recovery_completed_at IS NULL
      AND recovery_reason_code IS NULL
    )
    OR (
      recovery_status = 'REQUIRED'
      AND recovery_started_at IS NULL
      AND recovery_completed_at IS NULL
      AND recovery_reason_code IS NOT NULL
    )
    OR (
      recovery_status = 'IN_PROGRESS'
      AND recovery_started_at IS NOT NULL
      AND recovery_completed_at IS NULL
      AND recovery_reason_code IS NOT NULL
    )
    OR (
      recovery_status IN ('RECOVERED', 'FAILED')
      AND recovery_started_at IS NOT NULL
      AND recovery_completed_at IS NOT NULL
      AND recovery_reason_code IS NOT NULL
    )
  ),
  CONSTRAINT listener_websocket_health_heartbeat_at_check CHECK (
    heartbeat_at IS NULL OR isfinite(heartbeat_at)
  ),
  CONSTRAINT listener_websocket_health_updated_at_check CHECK (
    isfinite(updated_at)
  ),
  CONSTRAINT listener_websocket_health_evidence_purge_after_check CHECK (
    evidence_purge_after IS NULL OR isfinite(evidence_purge_after)
  ),
  CONSTRAINT listener_websocket_health_inactive_check CHECK (
    supervision <> 'INACTIVE'
    OR (
      phase = 'STOPPED'
      AND revision = 0
      AND provider_id IS NULL
      AND active_session_generation IS NULL
      AND candidate_provider_id IS NULL
      AND candidate_session_generation IS NULL
      AND acknowledged_at IS NULL
      AND last_observation_at IS NULL
      AND last_observation_slot IS NULL
      AND disconnect_occurred_at IS NULL
      AND disconnect_reason_code IS NULL
      AND recovery_status = 'NOT_REQUIRED'
      AND heartbeat_at IS NULL
      AND evidence_purge_after IS NULL
    )
  ),
  CONSTRAINT listener_websocket_health_phase_session_check CHECK (
    (
      phase = 'STOPPED'
      AND provider_id IS NULL
      AND active_session_generation IS NULL
      AND candidate_provider_id IS NULL
      AND candidate_session_generation IS NULL
      AND acknowledged_at IS NULL
    )
    OR (
      phase IN ('CONNECTING', 'WAITING_FOR_ACKS')
      AND candidate_provider_id IS NOT NULL
      AND candidate_session_generation IS NOT NULL
      AND acknowledged_at IS NULL
    )
    OR (
      phase IN ('ACKNOWLEDGED', 'RECOVERING')
      AND candidate_provider_id IS NOT NULL
      AND candidate_session_generation IS NOT NULL
      AND acknowledged_at IS NOT NULL
    )
    OR (
      phase = 'RUNNING'
      AND provider_id IS NOT NULL
      AND active_session_generation IS NOT NULL
      AND candidate_provider_id IS NULL
      AND candidate_session_generation IS NULL
      AND acknowledged_at IS NOT NULL
    )
    OR (
      phase IN ('DEGRADED', 'UNRECOVERABLE', 'STOPPING')
      AND supervision = 'ACTIVE'
      AND (
        acknowledged_at IS NULL
        OR active_session_generation IS NOT NULL
        OR candidate_session_generation IS NOT NULL
      )
    )
  )
);

INSERT INTO listener_websocket_health (
  service_key, payload_version, supervision, owner_generation, revision,
  phase, recovery_status, updated_at
) VALUES (
  'transaction-listener', 1, 'INACTIVE', 0, 0,
  'STOPPED', 'NOT_REQUIRED', clock_timestamp()
) ON CONFLICT (service_key) DO NOTHING;
