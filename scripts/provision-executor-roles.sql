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
END
$roles$;

GRANT USAGE ON SCHEMA public
TO sol_token_executor_operations,sol_token_operator_reader;

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
