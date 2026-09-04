-- Run as a PostgreSQL administrator after migrations. These are NOLOGIN group
-- roles; attach deployment-specific LOGIN roles separately. No password is
-- created or accepted by this script.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sol_token_listener_writer') THEN
    CREATE ROLE sol_token_listener_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sol_token_executor_worker') THEN
    CREATE ROLE sol_token_executor_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sol_token_executor_live') THEN
    CREATE ROLE sol_token_executor_live NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sol_token_executor_operations') THEN
    CREATE ROLE sol_token_executor_operations NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sol_token_operator_reader') THEN
    CREATE ROLE sol_token_operator_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sol_token_public_api') THEN
    CREATE ROLE sol_token_public_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sol_token_retention_worker') THEN
    CREATE ROLE sol_token_retention_worker NOLOGIN NOSUPERUSER
      NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$roles$;

REVOKE ALL PRIVILEGES ON SCHEMA public
FROM sol_token_retention_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
FROM sol_token_retention_worker;

GRANT USAGE ON SCHEMA public
TO sol_token_executor_live,sol_token_executor_operations,sol_token_operator_reader,
  sol_token_retention_worker;

GRANT SELECT ON TABLE migration_history
TO sol_token_executor_live;

-- The scheduled retention process is a separate trust boundary. Reset every
-- table capability on rerun, then grant only what purgeExpiredFoundationData
-- executes. In particular it never receives table-wide SELECT on signed bytes.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
FROM sol_token_retention_worker;

GRANT SELECT ON TABLE
  api_event_stream,
  api_event_stream_state,
  bonding_curve_snapshots,
  chain_transaction_finality_replay_receipts,
  chain_transaction_inbox,
  creator_profiles,
  domain_events,
  execution_activation_armaments,
  execution_activation_events,
  execution_attempts,
  execution_control_events,
  execution_dry_run_assessments,
  execution_exit_authorizations,
  execution_exposure_reservations,
  execution_fault_ledger,
  execution_intent_tombstones,
  execution_intent_transitions,
  execution_intents,
  execution_live_positions,
  execution_live_unsigned_simulation_evidence,
  execution_operator_authorizations,
  execution_provider_rate_limit_events,
  execution_provider_usage_counters,
  execution_provider_usage_snapshots,
  execution_reconciliation_evidence,
  execution_risk_admission_reports,
  execution_risk_tombstones,
  execution_safety_qualifications,
  execution_signed_simulation_evidence,
  execution_simulation_artifacts,
  execution_submission_events,
  execution_wallet_snapshots,
  launch_trades,
  listener_catch_up_gaps,
  listener_strict_catch_up_failures,
  listener_websocket_health,
  market_pools,
  market_reserve_snapshots,
  market_trades,
  migrations,
  observed_wallet_positions,
  paper_decision_jobs,
  paper_external_buy_events,
  paper_mvp_position_samples,
  paper_mvp_runs,
  paper_positions,
  paper_strategy_sessions,
  paper_trades,
  qualification_reports,
  raw_chain_events,
  social_enrichment_jobs,
  social_evidence_collections,
  social_http_observations,
  social_links,
  social_verification_evidence,
  state_transitions,
  token_holders_snapshots,
  token_launches,
  token_metadata_snapshots,
  trading_candidates,
  transaction_inbox_recoveries,
  wallet_cluster_members,
  wallet_clusters,
  wallet_funding_evidence,
  wallet_funding_observations,
  wallet_graph_profiles,
  wallet_graph_snapshots,
  wallet_relationships
TO sol_token_retention_worker;

GRANT SELECT (artifact_id,state,purge_after,exit_authorization_id)
ON TABLE execution_signed_transactions TO sol_token_retention_worker;

GRANT DELETE ON TABLE
  api_event_stream,
  bonding_curve_snapshots,
  chain_transaction_finality_replay_receipts,
  chain_transaction_inbox,
  creator_profiles,
  domain_events,
  execution_activation_armaments,
  execution_activation_events,
  execution_attempts,
  execution_control_events,
  execution_dry_run_assessments,
  execution_exit_authorizations,
  execution_exposure_reservations,
  execution_fault_ledger,
  execution_intent_transitions,
  execution_intents,
  execution_live_positions,
  execution_live_unsigned_simulation_evidence,
  execution_operator_authorizations,
  execution_provider_rate_limit_events,
  execution_provider_usage_counters,
  execution_provider_usage_snapshots,
  execution_reconciliation_evidence,
  execution_risk_admission_reports,
  execution_safety_qualifications,
  execution_signed_simulation_evidence,
  execution_signed_transactions,
  execution_simulation_artifacts,
  execution_submission_events,
  execution_wallet_snapshots,
  launch_trades,
  listener_catch_up_gaps,
  listener_strict_catch_up_failures,
  market_pools,
  market_reserve_snapshots,
  market_trades,
  migrations,
  observed_wallet_positions,
  paper_decision_jobs,
  paper_external_buy_events,
  paper_mvp_position_samples,
  paper_mvp_runs,
  paper_positions,
  paper_strategy_sessions,
  paper_trades,
  qualification_reports,
  raw_chain_events,
  social_enrichment_jobs,
  social_evidence_collections,
  social_http_observations,
  social_links,
  social_verification_evidence,
  state_transitions,
  token_holders_snapshots,
  token_launches,
  token_metadata_snapshots,
  trading_candidates,
  transaction_inbox_recoveries,
  wallet_cluster_members,
  wallet_clusters,
  wallet_funding_evidence,
  wallet_funding_observations,
  wallet_graph_profiles,
  wallet_graph_snapshots,
  wallet_relationships
TO sol_token_retention_worker;

GRANT INSERT ON TABLE
  execution_risk_tombstones,
  execution_intent_tombstones
TO sol_token_retention_worker;

GRANT UPDATE (state,terminal_at,purge_after,updated_at,verdict,failure_code,
  report_payload,runner_owner_id,completion_reason)
ON TABLE paper_mvp_runs TO sol_token_retention_worker;
GRANT UPDATE (disconnect_occurred_at,disconnect_reason_code,recovery_status,
  recovery_started_at,recovery_completed_at,recovery_reason_code,acknowledged_at,
  last_observation_at,last_observation_slot,evidence_purge_after)
ON TABLE listener_websocket_health TO sol_token_retention_worker;
GRANT UPDATE (terminal_at,purge_after,updated_at)
ON TABLE chain_transaction_inbox TO sol_token_retention_worker;
GRANT UPDATE (expired_through_sequence)
ON TABLE api_event_stream_state TO sol_token_retention_worker;

REVOKE ALL ON TABLE
  execution_signed_transactions,
  execution_live_unsigned_simulation_evidence,
  execution_signed_simulation_evidence,
  execution_submission_preflight_evidence,
  execution_pre_submission_revocations,
  execution_submission_events,
  execution_live_positions,
  execution_exit_authorizations,
  execution_reconciliation_evidence
FROM PUBLIC,sol_token_listener_writer,sol_token_executor_worker,
  sol_token_executor_operations,sol_token_operator_reader,sol_token_public_api;

-- Remove legacy table-wide mutation capabilities before granting the exact
-- columns required by the live executor. This keeps reruns least-privilege.
REVOKE UPDATE ON TABLE
  execution_signed_transactions,
  execution_live_unsigned_simulation_evidence,
  execution_signed_simulation_evidence,
  execution_live_positions,
  execution_exit_authorizations,
  execution_intents,
  execution_attempts,
  execution_wallet_generations,
  execution_wallet_risk_state,
  execution_wallet_snapshots,
  execution_provider_usage_snapshots,
  execution_provider_usage_counters,
  execution_exposure_reservations,
  execution_activation_armaments,
  execution_reconciliation_evidence
FROM sol_token_executor_live;

GRANT SELECT ON TABLE
  execution_intents,
  execution_intent_transitions,
  execution_attempts,
  execution_wallet_generations,
  execution_wallet_risk_state,
  execution_wallet_snapshots,
  execution_provider_usage_snapshots,
  execution_provider_usage_counters,
  execution_provider_rate_limit_events,
  execution_risk_admission_reports,
  execution_exposure_reservations,
  execution_reconciliation_evidence,
  execution_fault_ledger,
  execution_simulation_artifacts,
  execution_safety_qualifications,
  execution_safety_gate_evidence,
  execution_control_state,
  execution_activation_armaments,
  execution_activation_events,
  execution_signed_transactions,
  execution_live_unsigned_simulation_evidence,
  execution_signed_simulation_evidence,
  execution_submission_preflight_evidence,
  execution_pre_submission_revocations,
  execution_submission_events,
  execution_live_positions,
  execution_exit_authorizations
TO sol_token_executor_live;

GRANT INSERT ON TABLE
  execution_signed_transactions,
  execution_live_positions,
  execution_exit_authorizations
TO sol_token_executor_live;

GRANT UPDATE (state,state_revision,signed_simulated_at,submission_started_at,
  submitted_at,confirmed_at,confirmed_slot,reconciled_at,revoked_at,purge_after)
ON TABLE execution_signed_transactions TO sol_token_executor_live;
GRANT UPDATE (state,state_revision,exit_intent_id,remaining_base_raw,
  exit_reconciliation_fingerprint,closed_at,purge_after)
ON TABLE execution_live_positions TO sol_token_executor_live;
GRANT UPDATE (state,state_revision,locked_intent_id,locked_attempt_number,
  terminal_at,purge_after)
ON TABLE execution_exit_authorizations TO sol_token_executor_live;

GRANT SELECT,INSERT ON TABLE
  execution_submission_events,
  execution_live_unsigned_simulation_evidence,
  execution_signed_simulation_evidence,
  execution_submission_preflight_evidence,
  execution_pre_submission_revocations
TO sol_token_executor_live;

GRANT INSERT ON TABLE
  execution_intents,
  execution_attempts,
  execution_wallet_risk_state,
  execution_provider_usage_counters,
  execution_exposure_reservations,
  execution_activation_armaments
TO sol_token_executor_live;

GRANT UPDATE (status,state_revision,attempt_count,last_reason_code,lease_owner,
  lease_token,lease_expires_at,terminal_at,reconciliation_completed_at,purge_after,updated_at)
ON TABLE execution_intents TO sol_token_executor_live;
GRANT UPDATE (status,effective_venue,provider_id,completed_at,reason_code,
  reconciliation_signature,reconciliation_blockhash,reconciliation_last_valid_block_height,
  reconciliation_message_hash,reconciliation_build_fingerprint,
  reconciliation_snapshot_fingerprint,reconciliation_maximum_fee_lamports,
  reconciliation_maximum_fee_payer_lamport_debit)
ON TABLE execution_attempts TO sol_token_executor_live;
GRANT UPDATE (state_revision,reconciled_capital_lamports,reserved_exposure_raw,
  open_positions,conservative_drawdown_raw,consecutive_technical_failures,
  last_technical_failure_reason_code,unknown_block,updated_at)
ON TABLE execution_wallet_risk_state TO sol_token_executor_live;
GRANT UPDATE (state,state_revision,reconciled_at,purge_after)
ON TABLE execution_exposure_reservations TO sol_token_executor_live;
GRANT UPDATE (state,state_revision,consumed_buys,terminal_at,purge_after)
ON TABLE execution_activation_armaments TO sol_token_executor_live;

GRANT INSERT ON TABLE
  execution_intent_transitions,
  execution_risk_admission_reports,
  execution_reconciliation_evidence,
  execution_fault_ledger,
  execution_activation_events
TO sol_token_executor_live;

GRANT UPDATE (resolved_by_evidence_id,resolved_at,purge_after)
ON TABLE execution_reconciliation_evidence
TO sol_token_executor_live;

REVOKE ALL ON TABLE
  execution_safety_qualifications,
  execution_safety_gate_evidence,
  execution_control_state,
  execution_control_events,
  execution_operator_authorizations,
  execution_activation_armaments,
  execution_activation_events
FROM PUBLIC,sol_token_listener_writer,sol_token_executor_worker,
  sol_token_executor_operations,sol_token_operator_reader,sol_token_public_api;

GRANT SELECT ON TABLE
  execution_wallet_generations,
  execution_wallet_risk_state,
  execution_wallet_snapshots,
  execution_provider_usage_snapshots,
  execution_provider_usage_counters,
  execution_provider_rate_limit_events,
  execution_exposure_reservations,
  execution_reconciliation_evidence,
  execution_fault_ledger,
  execution_simulation_artifacts,
  execution_safety_qualifications,
  execution_safety_gate_evidence,
  execution_control_state,
  execution_control_events,
  execution_operator_authorizations,
  execution_activation_armaments,
  execution_activation_events
TO sol_token_executor_operations;

GRANT INSERT ON TABLE
  execution_safety_qualifications,
  execution_safety_gate_evidence
TO sol_token_executor_operations;

GRANT INSERT,UPDATE ON TABLE
  execution_control_state
TO sol_token_executor_operations;

GRANT INSERT ON TABLE
  execution_control_events
TO sol_token_executor_operations;

GRANT INSERT,UPDATE ON TABLE
  execution_operator_authorizations,
  execution_activation_armaments
TO sol_token_executor_operations;

GRANT INSERT ON TABLE
  execution_activation_events
TO sol_token_executor_operations;

GRANT SELECT ON TABLE
  execution_wallet_generations,
  execution_wallet_risk_state,
  execution_provider_usage_snapshots,
  execution_exposure_reservations,
  execution_reconciliation_evidence,
  execution_safety_qualifications,
  execution_safety_gate_evidence,
  execution_control_state,
  execution_control_events,
  execution_activation_armaments,
  execution_activation_events
TO sol_token_operator_reader;

REVOKE ALL ON TABLE
  execution_safety_qualifications,
  execution_safety_gate_evidence,
  execution_control_state,
  execution_control_events,
  execution_operator_authorizations,
  execution_activation_armaments,
  execution_activation_events
FROM sol_token_public_api,sol_token_listener_writer,sol_token_executor_worker;
