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

-- Remove stale direct authority from every user schema before rebuilding the
-- closed public-schema allowlist. System and per-session temporary schemas are
-- intentionally excluded.
DO $recovery_schema_acl$
DECLARE
  target_schema NAME;
BEGIN
  FOR target_schema IN
    SELECT namespace.nspname
    FROM pg_namespace namespace
    WHERE namespace.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON SCHEMA %I FROM sol_token_executor_live_recovery',
      target_schema
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM sol_token_executor_live_recovery',
      target_schema
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM sol_token_executor_live_recovery',
      target_schema
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM sol_token_executor_live_recovery',
      target_schema
    );
  END LOOP;
END
$recovery_schema_acl$;

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
    WHERE namespace.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
      AND class.relkind IN ('r','p','v','m','f')
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
  generation_id,armament_id,reservation_id,exit_authorization_id,pre_signature_lock_id,
  provider_id,
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

GRANT SELECT (generation_id,state,state_revision,last_event_id),
  UPDATE (state,state_revision,last_event_id,updated_at)
ON TABLE execution_control_state TO sol_token_executor_live_recovery;

GRANT SELECT (
  event_id,generation_id,previous_state,next_state,reason_code,actor_type,occurred_at
), INSERT (
  event_id,payload_version,event_fingerprint,generation_id,previous_state,next_state,
  reason_code,qualification_id,authorization_id,operator_id,actor_type,actor_id,
  source,intent_id,attempt_number,lock_id,artifact_id,occurred_at
)
ON TABLE execution_control_events TO sol_token_executor_live_recovery;

REVOKE ALL PRIVILEGES ON SCHEMA public
FROM sol_token_retention_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
FROM sol_token_retention_worker;

GRANT USAGE ON SCHEMA public
TO sol_token_executor_live,sol_token_executor_operations,sol_token_operator_reader,
  sol_token_retention_worker;

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

GRANT SELECT (
  artifact_id,state,purge_after,exit_authorization_id,pre_signature_lock_id,reservation_id
)
ON TABLE execution_signed_transactions TO sol_token_retention_worker;

GRANT SELECT (lock_id,state,purge_after,armament_id,reservation_id)
ON TABLE execution_pre_signature_locks TO sol_token_retention_worker;

GRANT SELECT (last_event_id)
ON TABLE execution_control_state TO sol_token_retention_worker;

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
  execution_pre_signature_locks,
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
  execution_pre_signature_locks,
  execution_live_unsigned_simulation_evidence,
  execution_live_rpc_budgets,
  execution_signed_simulation_evidence,
  execution_submission_preflight_evidence,
  execution_pre_submission_revocations,
  execution_submission_events,
  execution_live_positions,
  execution_exit_authorizations,
  execution_reconciliation_evidence
FROM PUBLIC,sol_token_listener_writer,sol_token_executor_worker,
  sol_token_executor_operations,sol_token_operator_reader,sol_token_public_api;

ALTER ROLE sol_token_executor_live NOLOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

DO $live_parameter_acl$
BEGIN
  IF current_setting('server_version_num')::INTEGER >= 150000 THEN
    EXECUTE 'REVOKE SET, ALTER SYSTEM ON PARAMETER session_replication_role FROM sol_token_executor_live';
  END IF;
END
$live_parameter_acl$;

-- A compromised signable worker must not inherit another capability group.
-- Deployment LOGIN membership in this group is managed separately.
DO $live_parents$
DECLARE
  parent_role NAME;
BEGIN
  FOR parent_role IN
    SELECT parent.rolname
    FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid=membership.member
    JOIN pg_roles parent ON parent.oid=membership.roleid
    WHERE member.rolname='sol_token_executor_live'
  LOOP
    EXECUTE format('REVOKE %I FROM sol_token_executor_live', parent_role);
  END LOOP;
END
$live_parents$;

-- Reset every direct capability, including stale objects in non-public user
-- schemas, before rebuilding the closed H2b allowlist.
DO $live_schema_acl$
DECLARE
  target_schema NAME;
BEGIN
  FOR target_schema IN
    SELECT namespace.nspname
    FROM pg_namespace namespace
    WHERE namespace.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON SCHEMA %I FROM sol_token_executor_live',
      target_schema
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM sol_token_executor_live',
      target_schema
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM sol_token_executor_live',
      target_schema
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM sol_token_executor_live',
      target_schema
    );
  END LOOP;
END
$live_schema_acl$;

DO $live_type_acl$
DECLARE
  target_type RECORD;
BEGIN
  FOR target_type IN
    SELECT namespace.nspname,type.typname
    FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid=type.typnamespace
    CROSS JOIN LATERAL aclexplode(type.typacl) acl
    WHERE acl.grantee=(
      SELECT oid FROM pg_roles WHERE rolname='sol_token_executor_live'
    )
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TYPE %I.%I FROM sol_token_executor_live',
      target_type.nspname,target_type.typname
    );
  END LOOP;
END
$live_type_acl$;

DO $live_database_acl$
DECLARE
  target_database NAME;
BEGIN
  FOR target_database IN SELECT datname FROM pg_database
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON DATABASE %I FROM sol_token_executor_live',
      target_database
    );
  END LOOP;
END
$live_database_acl$;

-- PostgreSQL grants TEMPORARY on every database to PUBLIC by default. The live
-- process pins an untrusted signing boundary, so remove only that capability on
-- the database being provisioned; CONNECT and other databases remain untouched.
DO $live_public_temp_acl$
DECLARE
  target_database NAME := current_database();
BEGIN
  EXECUTE format(
    'REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',
    target_database
  );
END
$live_public_temp_acl$;

DO $live_language_acl$
DECLARE
  target_language NAME;
BEGIN
  FOR target_language IN
    SELECT language.lanname
    FROM pg_language language
    CROSS JOIN LATERAL aclexplode(language.lanacl) acl
    WHERE language.lanpltrusted
      AND acl.grantee=(
        SELECT oid FROM pg_roles WHERE rolname='sol_token_executor_live'
      )
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON LANGUAGE %I FROM sol_token_executor_live',
      target_language
    );
  END LOOP;
END
$live_language_acl$;

-- Remove default privileges granted to the signable group by any object
-- creator. A default-ACL object owned by this NOLOGIN group is rejected by the
-- startup inventory as non-remediable ownership drift.
DO $live_default_acl$
DECLARE
  default_acl RECORD;
  object_kind TEXT;
  schema_clause TEXT;
BEGIN
  FOR default_acl IN
    SELECT DISTINCT grantor.rolname AS grantor_name,
      namespace.nspname AS schema_name,defaults.defaclobjtype
    FROM pg_default_acl defaults
    JOIN pg_roles grantor ON grantor.oid=defaults.defaclrole
    LEFT JOIN pg_namespace namespace ON namespace.oid=defaults.defaclnamespace
    CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
    WHERE acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='sol_token_executor_live')
  LOOP
    object_kind := CASE default_acl.defaclobjtype
      WHEN 'r' THEN 'TABLES'
      WHEN 'S' THEN 'SEQUENCES'
      WHEN 'f' THEN 'FUNCTIONS'
      WHEN 'T' THEN 'TYPES'
      WHEN 'n' THEN 'SCHEMAS'
      ELSE NULL
    END;
    IF object_kind IS NULL THEN
      RAISE EXCEPTION 'Unsupported default ACL object kind';
    END IF;
    schema_clause := CASE WHEN default_acl.schema_name IS NULL THEN ''
      ELSE format(' IN SCHEMA %I', default_acl.schema_name) END;
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE ALL PRIVILEGES ON %s FROM sol_token_executor_live',
      default_acl.grantor_name,schema_clause,object_kind
    );
  END LOOP;
END
$live_default_acl$;

DO $live_columns$
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
    WHERE namespace.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
      AND class.relkind IN ('r','p','v','m','f')
    GROUP BY namespace.nspname,class.relname
  LOOP
    EXECUTE format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
      'ON TABLE %2$I.%3$I FROM sol_token_executor_live',
      relation.columns, relation.nspname, relation.relname
    );
  END LOOP;
END
$live_columns$;

GRANT USAGE ON SCHEMA public TO sol_token_executor_live;

GRANT SELECT (version)
ON TABLE migration_history TO sol_token_executor_live;

GRANT SELECT (
  migration_id,mint,announced_pool,instruction_kind,quote_mint,quote_decimals,
  base_token_program,quote_token_program,confirmation_status
)
ON TABLE migrations TO sol_token_executor_live;

GRANT SELECT (
  pool_address,market,program_id,pool_index,creator,base_mint,quote_mint,
  quote_decimals,base_token_program,quote_token_program,base_vault,quote_vault,
  lp_mint,migration_id,pool_state,confirmation_status,slot,transaction_index,
  instruction_index,inner_instruction_index
)
ON TABLE market_pools TO sol_token_executor_live;

GRANT SELECT (
  id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,
  logical_command_id,mint,side,venue_policy,quote_mint,quote_token_program,
  quote_decimals,quote_amount_raw,base_amount_raw,minimum_amount_out_raw,
  decision_event_id,decision_fingerprint,requested_at,expires_at,status,
  attempt_count,state_revision,lease_owner,lease_token,lease_expires_at,
  last_reason_code,terminal_at,reconciliation_completed_at,created_at,updated_at,
  purge_after
), UPDATE (
  status,state_revision,attempt_count,last_reason_code,lease_owner,lease_token,
  lease_expires_at,terminal_at,reconciliation_completed_at,purge_after,updated_at
)
ON TABLE execution_intents TO sol_token_executor_live;

GRANT SELECT (intent_id), INSERT (
  intent_id,previous_status,next_status,reason_code,human_message,
  activation_phase,attempt_number,evidence,occurred_at
)
ON TABLE execution_intent_transitions TO sol_token_executor_live;

GRANT SELECT (
  intent_id,attempt_number,status,effective_venue,provider_id,started_at,
  completed_at,reason_code,reconciliation_signature,reconciliation_blockhash,
  reconciliation_last_valid_block_height,reconciliation_message_hash,
  reconciliation_build_fingerprint,reconciliation_snapshot_fingerprint,
  reconciliation_maximum_fee_lamports,reconciliation_maximum_fee_payer_lamport_debit,
  purge_after
), INSERT (
  intent_id,attempt_number,status,started_at
), UPDATE (
  status,effective_venue,provider_id,completed_at,reason_code,
  reconciliation_signature,reconciliation_blockhash,reconciliation_last_valid_block_height,
  reconciliation_message_hash,reconciliation_build_fingerprint,
  reconciliation_snapshot_fingerprint,reconciliation_maximum_fee_lamports,
  reconciliation_maximum_fee_payer_lamport_debit
)
ON TABLE execution_attempts TO sol_token_executor_live;

GRANT SELECT (generation_id,wallet_public_key,cluster,genesis_hash,retired_at)
ON TABLE execution_wallet_generations TO sol_token_executor_live;

GRANT SELECT (
  generation_id,state_revision,reconciled_capital_lamports,reserved_exposure_raw,
  open_positions,conservative_drawdown_raw,unknown_block
), UPDATE (
  state_revision,reserved_exposure_raw,open_positions,unknown_block,updated_at
)
ON TABLE execution_wallet_risk_state TO sol_token_executor_live;

GRANT SELECT (
  provider_id,billing_period_id,snapshot_fingerprint,measured_at,expires_at,superseded_at
)
ON TABLE execution_provider_usage_snapshots TO sol_token_executor_live;

GRANT SELECT (provider_id,billing_period_id,units,recorded_at)
ON TABLE execution_provider_usage_counters TO sol_token_executor_live;

GRANT SELECT (provider_id,billing_period_id)
ON TABLE execution_provider_rate_limit_events TO sol_token_executor_live;

GRANT SELECT (
  report_id,intent_id,generation_id,decision,quota_state,policy_fingerprint,
  wallet_snapshot_fingerprint,provider_snapshot_fingerprint,quote_amount_raw,
  risk_state_revision_baseline,conservative_drawdown_raw_baseline,
  provider_local_usage_units_baseline,provider_rate_limit_count_baseline
)
ON TABLE execution_risk_admission_reports TO sol_token_executor_live;

GRANT SELECT (
  reservation_id,intent_id,generation_id,side,mint,quote_mint,maximum_amount_raw,
  intent_fingerprint,policy_fingerprint,wallet_snapshot_fingerprint,
  provider_snapshot_fingerprint,admission_report_id,state,state_revision
), UPDATE (state,state_revision,reconciled_at,purge_after)
ON TABLE execution_exposure_reservations TO sol_token_executor_live;

GRANT SELECT (
  artifact_id,payload_version,specification_version,evaluator_version,intent_id,
  attempt_number,intent_state_revision,strategy_id,strategy_version,decision_fingerprint,
  result_kind,effective_venue,provider_id,executor_public_key,expected_genesis_hash,
  observed_genesis_hash,configuration_fingerprint,quote_fingerprint,snapshot_fingerprint,
  build_fingerprint,message_hash,blockhash,last_valid_block_height,blockhash_context_slot,
  snapshot_slot,fee_context_slot,simulation_slot,amount_in_raw,expected_amount_out_raw,
  protected_amount_out_raw,fees_raw,estimated_fee_lamports,
  simulated_fee_payer_lamport_debit,units_consumed,simulated_base_delta_raw,
  simulated_quote_delta_raw,rpc_calls_used,rpc_calls_limit,quote_status,build_status,
  simulation_status,failure_stage,failure_code,terminal_reason_code,logs_fingerprint,
  logs_line_count,result_fingerprint,recorded_at
), INSERT (
  artifact_id,payload_version,specification_version,evaluator_version,intent_id,
  attempt_number,intent_state_revision,strategy_id,strategy_version,decision_fingerprint,
  result_kind,effective_venue,provider_id,executor_public_key,expected_genesis_hash,
  observed_genesis_hash,configuration_fingerprint,quote_fingerprint,snapshot_fingerprint,
  build_fingerprint,message_hash,blockhash,last_valid_block_height,blockhash_context_slot,
  snapshot_slot,fee_context_slot,simulation_slot,amount_in_raw,expected_amount_out_raw,
  protected_amount_out_raw,fees_raw,estimated_fee_lamports,
  simulated_fee_payer_lamport_debit,units_consumed,simulated_base_delta_raw,
  simulated_quote_delta_raw,rpc_calls_used,rpc_calls_limit,quote_status,build_status,
  simulation_status,failure_stage,failure_code,terminal_reason_code,logs_fingerprint,
  logs_line_count,result_fingerprint,recorded_at
)
ON TABLE execution_simulation_artifacts TO sol_token_executor_live;

GRANT SELECT (
  qualification_id,qualification_fingerprint,generation_id,phase,build_hash,
  configuration_fingerprint,strategy_fingerprint,wallet_public_key,cluster,
  genesis_hash,provider_id,expires_at
)
ON TABLE execution_safety_qualifications TO sol_token_executor_live;

GRANT SELECT (generation_id,state,state_revision,last_event_id),
  UPDATE (state,state_revision,last_event_id,updated_at)
ON TABLE execution_control_state TO sol_token_executor_live;

GRANT SELECT (
  event_id,generation_id,previous_state,next_state,reason_code,actor_type,occurred_at
), INSERT (
  event_id,payload_version,event_fingerprint,generation_id,previous_state,next_state,
  reason_code,qualification_id,authorization_id,operator_id,actor_type,actor_id,
  source,intent_id,attempt_number,lock_id,artifact_id,occurred_at
)
ON TABLE execution_control_events TO sol_token_executor_live;

GRANT SELECT (
  armament_id,generation_id,qualification_id,qualification_fingerprint,phase,
  build_hash,configuration_fingerprint,strategy_fingerprint,wallet_public_key,
  cluster,genesis_hash,provider_id,state,state_revision,maximum_capital_lamports,
  maximum_exposure_bps,maximum_open_positions,maximum_buys,consumed_buys,expires_at,
  payload_version,armament_request_fingerprint,canary_evidence_fingerprint,
  target_intent_id,target_intent_state_revision,target_strategy_id,target_strategy_version,
  target_decision_fingerprint,target_mint,target_quote_mint,target_quote_amount_raw,
  target_admission_report_id,target_reservation_id,target_policy_fingerprint,
  target_wallet_snapshot_fingerprint,target_provider_snapshot_fingerprint,
  runtime_quote_max_age_ms,runtime_slippage_bps,runtime_snapshot_max_slot_lag,
  runtime_max_compute_units,runtime_max_fee_lamports,runtime_max_fee_payer_lamport_debit,
  runtime_max_rpc_calls_per_attempt,runtime_lease_ms,locked_intent_id,
  locked_attempt_number,locked_reservation_id,locked_lease_token,locked_at
), UPDATE (state,state_revision,consumed_buys,terminal_at,purge_after,
  locked_intent_id,locked_attempt_number,locked_reservation_id,locked_lease_token,locked_at)
ON TABLE execution_activation_armaments TO sol_token_executor_live;

GRANT INSERT (
  event_id,payload_version,event_fingerprint,armament_id,generation_id,
  previous_state,next_state,reason_code,occurred_at
)
ON TABLE execution_activation_events TO sol_token_executor_live;

GRANT SELECT (
  artifact_id,payload_version,specification_version,intent_id,attempt_number,
  generation_id,armament_id,reservation_id,pre_signature_lock_id,
  exit_authorization_id,provider_id,
  wallet_public_key,side,effective_venue,message_hash,build_fingerprint,
  snapshot_fingerprint,quote_fingerprint,quote_observed_at,quote_expires_at,
  blockhash,last_valid_block_height,signature,signed_transaction_bytes,
  signed_transaction_hash,state,state_revision,signed_at,signed_simulated_at,
  submission_started_at,submitted_at,confirmed_at,confirmed_slot,reconciled_at,
  revoked_at,purge_after
), INSERT (
  artifact_id,payload_version,specification_version,intent_id,attempt_number,
  generation_id,armament_id,reservation_id,pre_signature_lock_id,
  exit_authorization_id,provider_id,
  wallet_public_key,side,effective_venue,message_hash,build_fingerprint,
  snapshot_fingerprint,quote_fingerprint,quote_observed_at,quote_expires_at,
  blockhash,last_valid_block_height,signature,signed_transaction_bytes,
  signed_transaction_hash,state,state_revision,signed_at
), UPDATE (
  state,state_revision,signed_simulated_at,submission_started_at,submitted_at,
  revoked_at,purge_after
)
ON TABLE execution_signed_transactions TO sol_token_executor_live;

GRANT SELECT (
  lock_id,payload_version,lock_fingerprint,intent_id,attempt_number,
  intent_state_revision,armament_id,reservation_id,generation_id,wallet_public_key,
  provider_id,lease_token,message_hash,unsigned_message_bytes,unsigned_transaction_hash,
  unsigned_transaction_bytes,build_hash,configuration_fingerprint,strategy_fingerprint,
  decision_fingerprint,policy_fingerprint,wallet_snapshot_fingerprint,
  provider_snapshot_fingerprint,effective_venue,market_snapshot_slot,
  market_snapshot_fingerprint,quote_fingerprint,quote_observed_at,quote_expires_at,
  unsigned_simulation_fingerprint,blockhash,last_valid_block_height,state,state_revision,
  authorized_at,terminal_at,purge_after
), INSERT (
  lock_id,payload_version,lock_fingerprint,intent_id,attempt_number,
  intent_state_revision,armament_id,reservation_id,generation_id,wallet_public_key,
  provider_id,lease_token,message_hash,unsigned_message_bytes,unsigned_transaction_hash,
  unsigned_transaction_bytes,build_hash,configuration_fingerprint,strategy_fingerprint,
  decision_fingerprint,policy_fingerprint,wallet_snapshot_fingerprint,
  provider_snapshot_fingerprint,effective_venue,market_snapshot_slot,
  market_snapshot_fingerprint,quote_fingerprint,quote_observed_at,quote_expires_at,
  unsigned_simulation_fingerprint,blockhash,last_valid_block_height,state,state_revision,
  authorized_at
), UPDATE (state,state_revision,terminal_at,purge_after)
ON TABLE execution_pre_signature_locks TO sol_token_executor_live;

GRANT SELECT (
  evidence_id,payload_version,evidence_fingerprint,artifact_id,intent_id,
  attempt_number,provider_id,snapshot_fingerprint,build_fingerprint,message_hash,
  blockhash,last_valid_block_height,blockhash_context_slot,fee_context_slot,
  estimated_fee_lamports,simulation_slot,simulated_fee_payer_lamport_debit,
  units_consumed,simulated_base_delta_raw,simulated_quote_delta_raw,
  logs_fingerprint,logs_line_count,recorded_at
), INSERT (
  evidence_id,payload_version,evidence_fingerprint,artifact_id,intent_id,
  attempt_number,provider_id,snapshot_fingerprint,build_fingerprint,message_hash,
  blockhash,last_valid_block_height,blockhash_context_slot,fee_context_slot,
  estimated_fee_lamports,simulation_slot,simulated_fee_payer_lamport_debit,
  units_consumed,simulated_base_delta_raw,simulated_quote_delta_raw,
  logs_fingerprint,logs_line_count,recorded_at
)
ON TABLE execution_live_unsigned_simulation_evidence TO sol_token_executor_live;

GRANT SELECT (
  intent_id,attempt_number,artifact_id,provider_id,initial_calls_used,
  calls_reserved,calls_limit,created_at
), INSERT (
  intent_id,attempt_number,artifact_id,provider_id,initial_calls_used,
  calls_reserved,calls_limit,created_at
), UPDATE (calls_reserved)
ON TABLE execution_live_rpc_budgets TO sol_token_executor_live;

GRANT SELECT (
  payload_version,evidence_fingerprint,artifact_id,unsigned_simulation_evidence_id,
  signed_transaction_hash,provider_id,simulation_slot,units_consumed,
  fee_payer_lamport_debit,base_delta_raw,quote_delta_raw,logs_fingerprint,
  logs_line_count,observed_at
), INSERT (
  evidence_id,payload_version,evidence_fingerprint,artifact_id,
  unsigned_simulation_evidence_id,signed_transaction_hash,provider_id,simulation_slot,
  units_consumed,fee_payer_lamport_debit,base_delta_raw,quote_delta_raw,
  logs_fingerprint,logs_line_count,observed_at
)
ON TABLE execution_signed_simulation_evidence TO sol_token_executor_live;

GRANT INSERT (
  gate_id,payload_version,gate_fingerprint,artifact_id,intent_id,attempt_number,
  generation_id,armament_id,reservation_id,provider_id,phase,build_hash,
  configuration_fingerprint,strategy_fingerprint,wallet_public_key,cluster,genesis_hash,
  armament_revision,admission_risk_revision,risk_revision,admission_drawdown_raw,
  conservative_drawdown_raw,admission_provider_local_usage_units,
  provider_local_usage_units,admission_provider_rate_limit_count,
  provider_rate_limit_count,reservation_amount_raw,reconciled_capital_raw,
  reserved_exposure_raw,open_positions,maximum_capital_lamports,maximum_exposure_bps,
  maximum_open_positions,quote_fingerprint,quote_observed_at,quote_expires_at,blockhash,
  last_valid_block_height,observed_block_height,blockhash_validity_context_slot,
  blockhash_validated_at,authorized_at
)
ON TABLE execution_submission_preflight_evidence TO sol_token_executor_live;

GRANT SELECT (
  artifact_id,intent_id,expected_state,expected_revision,cause_reason_code,
  evidence_fingerprint,observed_at
), INSERT (
  revocation_id,payload_version,revocation_fingerprint,artifact_id,intent_id,
  attempt_number,generation_id,side,expected_state,expected_revision,cause_reason_code,
  evidence_fingerprint,observed_at,revoked_at,purge_after
)
ON TABLE execution_pre_submission_revocations TO sol_token_executor_live;

GRANT INSERT (
  event_id,payload_version,event_fingerprint,artifact_id,generation_id,
  previous_state,next_state,reason_code,occurred_at
)
ON TABLE execution_submission_events TO sol_token_executor_live;

GRANT SELECT (
  position_id,generation_id,armament_id,wallet_public_key,mint,quote_mint,
  state,state_revision,exit_intent_id,remaining_base_raw
), UPDATE (state,state_revision,exit_intent_id)
ON TABLE execution_live_positions TO sol_token_executor_live;

GRANT SELECT (
  authorization_id,position_id,generation_id,wallet_public_key,mint,quote_mint,
  maximum_base_amount_raw,state,state_revision,locked_intent_id,locked_attempt_number
), UPDATE (state,state_revision,locked_intent_id,locked_attempt_number)
ON TABLE execution_exit_authorizations TO sol_token_executor_live;

GRANT USAGE ON SEQUENCE execution_intent_transitions_sequence_seq
TO sol_token_executor_live;

ALTER ROLE sol_token_executor_operations NOLOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

DO $operations_parameter_acl$
BEGIN
  IF current_setting('server_version_num')::INTEGER >= 150000 THEN
    EXECUTE 'REVOKE SET, ALTER SYSTEM ON PARAMETER session_replication_role FROM sol_token_executor_operations';
  END IF;
END
$operations_parameter_acl$;

DO $operations_parents$
DECLARE
  parent_role NAME;
BEGIN
  FOR parent_role IN
    SELECT parent.rolname FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid=membership.member
    JOIN pg_roles parent ON parent.oid=membership.roleid
    WHERE member.rolname='sol_token_executor_operations'
  LOOP
    EXECUTE format('REVOKE %I FROM sol_token_executor_operations', parent_role);
  END LOOP;
END
$operations_parents$;

DO $operations_schema_acl$
DECLARE
  target_schema NAME;
BEGIN
  FOR target_schema IN
    SELECT namespace.nspname FROM pg_namespace namespace
    WHERE namespace.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON SCHEMA %I FROM sol_token_executor_operations',
      target_schema
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM sol_token_executor_operations',
      target_schema
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM sol_token_executor_operations',
      target_schema
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM sol_token_executor_operations',
      target_schema
    );
  END LOOP;
END
$operations_schema_acl$;

DO $operations_columns$
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
    WHERE namespace.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
      AND class.relkind IN ('r','p','v','m','f')
    GROUP BY namespace.nspname,class.relname
  LOOP
    EXECUTE format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
      'ON TABLE %2$I.%3$I FROM sol_token_executor_operations',
      relation.columns, relation.nspname, relation.relname
    );
  END LOOP;
END
$operations_columns$;

GRANT USAGE ON SCHEMA public TO sol_token_executor_operations;

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

GRANT SELECT (generation_id,wallet_public_key,cluster,genesis_hash,generation,retired_at)
ON TABLE execution_wallet_generations TO sol_token_executor_operations;

GRANT SELECT (
  id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,
  logical_command_id,mint,side,venue_policy,quote_mint,quote_token_program,
  quote_decimals,quote_amount_raw,base_amount_raw,minimum_amount_out_raw,
  decision_event_id,decision_fingerprint,requested_at,expires_at,status,attempt_count,
  state_revision,last_reason_code,terminal_at,reconciliation_completed_at,purge_after,
  created_at,updated_at,lease_owner,lease_token,lease_expires_at
)
ON TABLE execution_intents TO sol_token_executor_operations;

GRANT SELECT (
  generation_id,state_revision,reconciled_capital_lamports,reserved_exposure_raw,
  open_positions,conservative_drawdown_raw,consecutive_technical_failures,
  last_technical_failure_reason_code,unknown_block
), UPDATE (
  state_revision,reconciled_capital_lamports,reserved_exposure_raw,open_positions,
  conservative_drawdown_raw,unknown_block,updated_at
)
ON TABLE execution_wallet_risk_state TO sol_token_executor_operations;

GRANT SELECT (
  snapshot_id,payload_version,snapshot_fingerprint,generation_id,provider_id,
  state_revision,slot,block_time,observed_at,commitment,wallet_lamports,
  token_balance_count,open_positions,position_1_id,position_1_cost_basis_lamports,
  position_1_conservative_liquidation_lamports,position_1_reconciliation_status,
  position_2_id,position_2_cost_basis_lamports,
  position_2_conservative_liquidation_lamports,position_2_reconciliation_status,
  realized_net_pnl_raw,superseded_at,purge_after
), INSERT (
  snapshot_id,payload_version,snapshot_fingerprint,generation_id,provider_id,
  state_revision,slot,block_time,observed_at,commitment,wallet_lamports,
  token_balance_count,open_positions,position_1_id,position_1_cost_basis_lamports,
  position_1_conservative_liquidation_lamports,position_1_reconciliation_status,
  position_2_id,position_2_cost_basis_lamports,
  position_2_conservative_liquidation_lamports,position_2_reconciliation_status,
  realized_net_pnl_raw
), UPDATE (superseded_at,purge_after)
ON TABLE execution_wallet_snapshots TO sol_token_executor_operations;

GRANT SELECT (
  snapshot_id,payload_version,snapshot_fingerprint,provider_id,plan_id,billing_period_id,
  billing_period_started_at,billing_period_ends_at,limit_units,used_units,measured_at,
  expires_at,provenance,superseded_at,purge_after
), INSERT (
  snapshot_id,payload_version,snapshot_fingerprint,provider_id,plan_id,billing_period_id,
  billing_period_started_at,billing_period_ends_at,limit_units,used_units,measured_at,
  expires_at,provenance
), UPDATE (superseded_at,purge_after)
ON TABLE execution_provider_usage_snapshots TO sol_token_executor_operations;

GRANT SELECT (provider_id,billing_period_id,units,recorded_at), INSERT (
  operation_id,payload_version,snapshot_id,provider_id,billing_period_id,category,
  logical_operation_id,units,recorded_at
)
ON TABLE execution_provider_usage_counters TO sol_token_executor_operations;

GRANT SELECT (provider_id,billing_period_id,observed_at)
ON TABLE execution_provider_rate_limit_events TO sol_token_executor_operations;

GRANT SELECT (
  report_id,decision,reason_code,input_fingerprint,policy_fingerprint,
  wallet_snapshot_fingerprint,provider_snapshot_fingerprint,wallet_state_revision,
  intent_id,generation_id,report_fingerprint,quote_amount_raw
), INSERT (
  report_id,payload_version,report_fingerprint,intent_id,generation_id,policy_fingerprint,
  wallet_snapshot_fingerprint,provider_snapshot_fingerprint,decision,reason_code,
  quote_amount_raw,projected_capital_raw,projected_exposure_raw,projected_drawdown_raw,
  quota_state,wallet_state_revision,input_fingerprint,risk_state_revision_baseline,
  conservative_drawdown_raw_baseline,provider_local_usage_units_baseline,
  provider_rate_limit_count_baseline,recorded_at,terminal_at,purge_after
)
ON TABLE execution_risk_admission_reports TO sol_token_executor_operations;

GRANT SELECT (
  reservation_id,intent_id,generation_id,admission_report_id,position_id,side,mint,
  quote_mint,maximum_amount_raw,intent_fingerprint,policy_fingerprint,
  wallet_snapshot_fingerprint,provider_snapshot_fingerprint,state,state_revision
), INSERT (
  reservation_id,payload_version,intent_id,generation_id,admission_report_id,position_id,
  side,mint,quote_mint,maximum_amount_raw,intent_fingerprint,policy_fingerprint,
  wallet_snapshot_fingerprint,provider_snapshot_fingerprint,state,state_revision,created_at
), UPDATE (state,state_revision,reconciled_at,purge_after)
ON TABLE execution_exposure_reservations TO sol_token_executor_operations;

GRANT SELECT (
  artifact_id,result_fingerprint,result_kind,provider_id,executor_public_key,
  expected_genesis_hash,observed_genesis_hash,configuration_fingerprint,
  build_fingerprint,recorded_at
)
ON TABLE execution_simulation_artifacts TO sol_token_executor_operations;

GRANT SELECT (
  qualification_id,payload_version,evaluator_version,qualification_fingerprint,phase,
  build_hash,configuration_fingerprint,strategy_fingerprint,generation_id,wallet_public_key,
  cluster,genesis_hash,provider_id,qualified_at,expires_at,purge_after
), INSERT (
  qualification_id,payload_version,evaluator_version,qualification_fingerprint,phase,
  build_hash,configuration_fingerprint,strategy_fingerprint,generation_id,wallet_public_key,
  cluster,genesis_hash,provider_id,qualified_at,expires_at,purge_after
)
ON TABLE execution_safety_qualifications TO sol_token_executor_operations;

GRANT SELECT (
  qualification_id,gate_index,payload_version,gate_id,status,evidence_type,evidence_id,
  evidence_fingerprint,observed_at,expires_at
), INSERT (
  qualification_id,gate_index,payload_version,gate_id,status,evidence_type,evidence_id,
  evidence_fingerprint,observed_at,expires_at
)
ON TABLE execution_safety_gate_evidence TO sol_token_executor_operations;

GRANT SELECT (generation_id,state,state_revision,last_event_id),
  INSERT (generation_id), UPDATE (state,state_revision,last_event_id,updated_at)
ON TABLE execution_control_state TO sol_token_executor_operations;

GRANT SELECT (
  event_id,event_fingerprint,generation_id,previous_state,next_state,reason_code,
  actor_type,occurred_at
), INSERT (
  event_id,payload_version,event_fingerprint,generation_id,previous_state,next_state,
  reason_code,qualification_id,authorization_id,operator_id,actor_type,actor_id,occurred_at
)
ON TABLE execution_control_events TO sol_token_executor_operations;

GRANT SELECT (
  authorization_id,authorization_fingerprint,generation_id,action,phase,
  context_fingerprint,operator_id,issued_at,expires_at,consumed_at
), INSERT (
  authorization_id,payload_version,authorization_fingerprint,generation_id,action,phase,
  context_fingerprint,nonce_hash,operator_id,issued_at,expires_at,consumed_at,purge_after
), UPDATE (consumed_at,purge_after)
ON TABLE execution_operator_authorizations TO sol_token_executor_operations;

GRANT SELECT (
  armament_id,payload_version,armament_fingerprint,qualification_id,
  qualification_fingerprint,generation_id,authorization_id,state,state_revision,phase,
  build_hash,configuration_fingerprint,strategy_fingerprint,wallet_public_key,cluster,
  genesis_hash,provider_id,maximum_buys,consumed_buys,maximum_capital_lamports,
  maximum_exposure_bps,maximum_open_positions,maximum_holding_ms,operator_id,
  operator_reason,armed_at,expires_at,terminal_at,purge_after,
  armament_request_fingerprint,canary_evidence_fingerprint,target_intent_id,
  target_intent_state_revision,target_strategy_id,target_strategy_version,
  target_decision_fingerprint,target_mint,target_quote_mint,target_quote_amount_raw,
  target_admission_report_id,target_reservation_id,target_policy_fingerprint,
  target_wallet_snapshot_fingerprint,target_provider_snapshot_fingerprint,
  runtime_quote_max_age_ms,runtime_slippage_bps,runtime_snapshot_max_slot_lag,
  runtime_max_compute_units,runtime_max_fee_lamports,runtime_max_fee_payer_lamport_debit,
  runtime_max_rpc_calls_per_attempt,runtime_lease_ms,locked_intent_id,
  locked_attempt_number,locked_reservation_id,locked_lease_token,locked_at
), INSERT (
  armament_id,payload_version,armament_fingerprint,qualification_id,
  qualification_fingerprint,generation_id,authorization_id,state,state_revision,phase,
  build_hash,configuration_fingerprint,strategy_fingerprint,wallet_public_key,cluster,
  genesis_hash,provider_id,maximum_buys,consumed_buys,maximum_capital_lamports,
  maximum_exposure_bps,maximum_open_positions,maximum_holding_ms,operator_id,
  operator_reason,armed_at,expires_at,armament_request_fingerprint,
  canary_evidence_fingerprint,target_intent_id,target_intent_state_revision,
  target_strategy_id,target_strategy_version,target_decision_fingerprint,target_mint,
  target_quote_mint,target_quote_amount_raw,target_admission_report_id,target_reservation_id,
  target_policy_fingerprint,target_wallet_snapshot_fingerprint,
  target_provider_snapshot_fingerprint,runtime_quote_max_age_ms,runtime_slippage_bps,
  runtime_snapshot_max_slot_lag,runtime_max_compute_units,runtime_max_fee_lamports,
  runtime_max_fee_payer_lamport_debit,runtime_max_rpc_calls_per_attempt,runtime_lease_ms
), UPDATE (state,state_revision,terminal_at,purge_after)
ON TABLE execution_activation_armaments TO sol_token_executor_operations;

GRANT INSERT (
  event_id,payload_version,event_fingerprint,armament_id,generation_id,
  previous_state,next_state,reason_code,occurred_at
)
ON TABLE execution_activation_events TO sol_token_executor_operations;

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
