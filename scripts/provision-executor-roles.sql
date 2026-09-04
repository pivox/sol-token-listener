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
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname='sol_token_executor_live_recovery'
  ) THEN
    CREATE ROLE sol_token_executor_live_recovery NOLOGIN NOSUPERUSER
      NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
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

ALTER ROLE sol_token_executor_live_recovery NOLOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- PostgreSQL 15+ supports per-parameter SET grants. Keep the recovery role
-- unable to disable ordinary and constraint triggers through replica mode,
-- while retaining PostgreSQL 14 compatibility for local migration tests.
DO $recovery_parameter_acl$
BEGIN
  IF current_setting('server_version_num')::INTEGER >= 150000 THEN
    EXECUTE 'REVOKE SET, ALTER SYSTEM ON PARAMETER session_replication_role FROM sol_token_executor_live_recovery';
  END IF;
END
$recovery_parameter_acl$;

-- Recovery must never inherit or SET ROLE into the signable role (or any
-- other parent). Deployment LOGIN membership is managed separately.
DO $recovery_parents$
DECLARE
  parent_role NAME;
BEGIN
  FOR parent_role IN
    SELECT parent.rolname
    FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid=membership.member
    JOIN pg_roles parent ON parent.oid=membership.roleid
    WHERE member.rolname='sol_token_executor_live_recovery'
  LOOP
    EXECUTE format(
      'REVOKE %I FROM sol_token_executor_live_recovery',
      parent_role
    );
  END LOOP;
END
$recovery_parents$;

REVOKE ALL PRIVILEGES ON SCHEMA public
FROM sol_token_executor_live_recovery;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
FROM sol_token_executor_live_recovery;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
FROM sol_token_executor_live_recovery;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
FROM sol_token_executor_live_recovery;

-- Table-level REVOKE does not remove grants made directly at column scope.
DO $recovery_columns$
DECLARE
  relation RECORD;
BEGIN
  FOR relation IN
    SELECT namespace.nspname,class.relname,
      string_agg(format('%I',attribute.attname),',' ORDER BY attribute.attnum) AS columns
    FROM pg_class class
    JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid=class.oid
      AND attribute.attnum>0 AND NOT attribute.attisdropped
    WHERE namespace.nspname='public' AND class.relkind IN ('r','p','v','m','f')
    GROUP BY namespace.nspname,class.relname
  LOOP
    EXECUTE format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
      'ON TABLE %2$I.%3$I FROM sol_token_executor_live_recovery',
      relation.columns, relation.nspname, relation.relname
    );
  END LOOP;
END
$recovery_columns$;

GRANT USAGE ON SCHEMA public TO sol_token_executor_live_recovery;

GRANT SELECT (version)
ON TABLE migration_history TO sol_token_executor_live_recovery;

GRANT SELECT (
  id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,
  logical_command_id,mint,side,venue_policy,quote_mint,quote_token_program,
  quote_decimals,quote_amount_raw,base_amount_raw,minimum_amount_out_raw,
  decision_event_id,decision_fingerprint,requested_at,expires_at,status,
  attempt_count,state_revision,lease_owner,lease_token,lease_expires_at,
  last_reason_code,terminal_at,reconciliation_completed_at,created_at,updated_at,
  purge_after
), INSERT (
  id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,
  logical_command_id,mint,side,venue_policy,quote_mint,quote_token_program,
  quote_decimals,quote_amount_raw,base_amount_raw,minimum_amount_out_raw,
  decision_event_id,decision_fingerprint,requested_at,expires_at,status
), UPDATE (
  status,state_revision,last_reason_code,lease_owner,lease_token,
  lease_expires_at,terminal_at,reconciliation_completed_at,purge_after,updated_at
)
ON TABLE execution_intents TO sol_token_executor_live_recovery;

GRANT SELECT (
  artifact_id,payload_version,specification_version,intent_id,attempt_number,
  generation_id,armament_id,reservation_id,exit_authorization_id,provider_id,
  wallet_public_key,side,effective_venue,message_hash,build_fingerprint,
  snapshot_fingerprint,quote_fingerprint,quote_observed_at,quote_expires_at,
  blockhash,last_valid_block_height,signature,signed_transaction_hash,state,
  state_revision,signed_at,signed_simulated_at,submission_started_at,submitted_at,
  confirmed_at,confirmed_slot,reconciled_at,revoked_at,purge_after
), UPDATE (
  state,state_revision,submitted_at,confirmed_at,confirmed_slot,reconciled_at,purge_after
)
ON TABLE execution_signed_transactions TO sol_token_executor_live_recovery;

GRANT SELECT (
  intent_id,attempt_number,status,effective_venue,provider_id,
  reconciliation_signature,reconciliation_blockhash,
  reconciliation_last_valid_block_height,reconciliation_message_hash,
  reconciliation_build_fingerprint,reconciliation_snapshot_fingerprint,
  reconciliation_maximum_fee_lamports,
  reconciliation_maximum_fee_payer_lamport_debit
), UPDATE (status,completed_at,reason_code)
ON TABLE execution_attempts TO sol_token_executor_live_recovery;

GRANT SELECT (
  generation_id,payload_version,wallet_public_key,generation,cluster,
  genesis_hash,retired_at
)
ON TABLE execution_wallet_generations TO sol_token_executor_live_recovery;

GRANT SELECT (
  position_id,buy_intent_id,generation_id,armament_id,wallet_public_key,mint,
  quote_mint,state,state_revision,exit_intent_id,remaining_base_raw,
  quote_cost_raw,exit_deadline_at,entry_reconciliation_fingerprint
), INSERT (
  position_id,payload_version,buy_intent_id,generation_id,armament_id,
  wallet_public_key,mint,quote_mint,entry_venue,quote_cost_raw,base_amount_raw,
  remaining_base_raw,fee_lamports,maximum_holding_ms,opened_at,exit_deadline_at,
  entry_reconciliation_fingerprint,state,state_revision
), UPDATE (
  state,state_revision,exit_intent_id,remaining_base_raw,
  exit_reconciliation_fingerprint,closed_at,purge_after
)
ON TABLE execution_live_positions TO sol_token_executor_live_recovery;

GRANT SELECT (armament_id,provider_id,state,state_revision,maximum_holding_ms),
  UPDATE (state,state_revision,terminal_at,purge_after)
ON TABLE execution_activation_armaments TO sol_token_executor_live_recovery;

GRANT SELECT (authorization_id,position_id,state,state_revision), INSERT (
  authorization_id,payload_version,position_id,generation_id,wallet_public_key,
  mint,quote_mint,maximum_base_amount_raw,state,state_revision,created_at
), UPDATE (
  state,state_revision,locked_intent_id,locked_attempt_number,terminal_at,purge_after
)
ON TABLE execution_exit_authorizations TO sol_token_executor_live_recovery;

GRANT SELECT (
  generation_id,state_revision,reserved_exposure_raw,open_positions,unknown_block
), UPDATE (
  state_revision,reserved_exposure_raw,open_positions,unknown_block,updated_at
)
ON TABLE execution_wallet_risk_state TO sol_token_executor_live_recovery;

GRANT SELECT (
  reservation_id,intent_id,generation_id,state,state_revision,
  maximum_amount_raw,wallet_snapshot_fingerprint
), UPDATE (state,state_revision,reconciled_at,purge_after)
ON TABLE execution_exposure_reservations TO sol_token_executor_live_recovery;

GRANT SELECT (
  evidence_id,payload_version,evidence_fingerprint,intent_id,attempt_number,
  reservation_id,generation_id,provider_id,side,signature,blockhash,
  last_valid_block_height,message_hash,build_fingerprint,snapshot_fingerprint,
  maximum_fee_lamports,maximum_fee_payer_lamport_debit,signature_history,
  confirmation_status,finalized_block_height,observed_slot,
  observed_transaction_fingerprint,fee_lamports,wallet_lamport_delta,
  base_delta_raw,quote_delta_raw,unexpected_residual_token_balance_raw,
  observed_at,finalized_at,result,reason_code,resolved_by_evidence_id,
  resolved_at,purge_after
), INSERT (
  evidence_id,payload_version,evidence_fingerprint,intent_id,attempt_number,
  reservation_id,generation_id,provider_id,side,signature,blockhash,
  last_valid_block_height,message_hash,build_fingerprint,snapshot_fingerprint,
  maximum_fee_lamports,maximum_fee_payer_lamport_debit,signature_history,
  confirmation_status,finalized_block_height,observed_slot,
  observed_transaction_fingerprint,fee_lamports,wallet_lamport_delta,
  base_delta_raw,quote_delta_raw,unexpected_residual_token_balance_raw,
  observed_at,finalized_at,result,reason_code,purge_after
), UPDATE (resolved_by_evidence_id,resolved_at,purge_after)
ON TABLE execution_reconciliation_evidence TO sol_token_executor_live_recovery;

GRANT INSERT (
  intent_id,previous_status,next_status,reason_code,human_message,
  activation_phase,attempt_number,evidence,occurred_at
)
ON TABLE execution_intent_transitions TO sol_token_executor_live_recovery;
GRANT USAGE ON SEQUENCE execution_intent_transitions_sequence_seq
TO sol_token_executor_live_recovery;

GRANT SELECT (
  artifact_id,generation_id,previous_state,next_state,reason_code
), INSERT (
  event_id,payload_version,event_fingerprint,artifact_id,generation_id,
  previous_state,next_state,reason_code,occurred_at
)
ON TABLE execution_submission_events TO sol_token_executor_live_recovery;

GRANT INSERT (
  event_id,payload_version,event_fingerprint,armament_id,generation_id,
  previous_state,next_state,reason_code,occurred_at
)
ON TABLE execution_activation_events TO sol_token_executor_live_recovery;

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
