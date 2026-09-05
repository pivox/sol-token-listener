import type { LiveExecutorConfig } from './config.js';
import {
  LIVE_EXECUTION_MIGRATION_CATALOG,
  validateLiveExecutionMigrationFiles,
} from '../execution-migrations/live-catalog.js';

export type LiveExecutorStartupErrorCode =
  | 'MIGRATION_CATALOG_INVALID'
  | 'DATABASE_ROLE_INVALID'
  | 'DATABASE_AUTHORITY_INVALID'
  | 'GENERATION_BINDING_INVALID'
  | 'OPEN_WORK_BINDING_INVALID';

export class LiveExecutorStartupError extends Error {
  public constructor(public readonly code: LiveExecutorStartupErrorCode) {
    super('Live executor startup validation failed.');
    this.name = 'LiveExecutorStartupError';
  }
}

export interface LiveExecutorStartupDatabase {
  readonly query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<Readonly<{
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    readonly rowCount: number | null;
  }>>;
}

export interface LiveExecutorStartupEvidenceV1 {
  readonly payloadVersion: 1;
  readonly role: 'sol_token_executor_live';
  readonly migrationHead: '039_execution_canary_operator_binding.sql';
  readonly generationId: string;
  readonly providerId: string;
  readonly phase: LiveExecutorConfig['phase'];
}

export interface LiveExecutorTableAuthorityV1 {
  readonly name: string;
  readonly select: readonly string[];
  readonly insert: readonly string[];
  readonly update: readonly string[];
}

export interface LiveExecutorSequenceAuthorityV1 {
  readonly name: string;
  readonly privileges: readonly ['USAGE'];
}

export interface LiveExecutorFunctionAuthorityV1 {
  readonly identity: string;
  readonly privileges: readonly ['EXECUTE'];
}

export interface LiveExecutorDatabaseAuthorityV1 {
  readonly payloadVersion: 1;
  readonly role: 'sol_token_executor_live';
  readonly schema: 'public';
  readonly tables: readonly LiveExecutorTableAuthorityV1[];
  readonly sequences: readonly LiveExecutorSequenceAuthorityV1[];
  readonly functions: readonly LiveExecutorFunctionAuthorityV1[];
}

function names<const Value extends readonly string[]>(...values: Value): Readonly<Value> {
  return Object.freeze(values);
}

function table(
  name: string,
  select: readonly string[],
  insert: readonly string[] = names(),
  update: readonly string[] = names(),
): LiveExecutorTableAuthorityV1 {
  return Object.freeze({ name, select, insert, update });
}

/** Exact v1 database authority required by the signable live runtime graph. */
export const LIVE_EXECUTOR_DATABASE_AUTHORITY_V1: LiveExecutorDatabaseAuthorityV1 =
  Object.freeze({
    payloadVersion: 1,
    role: 'sol_token_executor_live',
    schema: 'public',
    tables: Object.freeze([
      table('migration_history', names('version')),
      table('migrations', names(
        'migration_id', 'mint', 'announced_pool', 'instruction_kind', 'quote_mint',
        'quote_decimals', 'base_token_program', 'quote_token_program', 'confirmation_status',
      )),
      table('market_pools', names(
        'pool_address', 'market', 'program_id', 'pool_index', 'creator', 'base_mint',
        'quote_mint', 'quote_decimals', 'base_token_program', 'quote_token_program',
        'base_vault', 'quote_vault', 'lp_mint', 'migration_id', 'pool_state',
        'confirmation_status', 'slot', 'transaction_index', 'instruction_index',
        'inner_instruction_index',
      )),
      table('execution_intents', names(
        'id', 'payload_version', 'logical_order_key', 'strategy_id', 'strategy_version',
        'position_id', 'logical_command_id', 'mint', 'side', 'venue_policy', 'quote_mint',
        'quote_token_program', 'quote_decimals', 'quote_amount_raw', 'base_amount_raw',
        'minimum_amount_out_raw', 'decision_event_id', 'decision_fingerprint',
        'requested_at', 'expires_at', 'status', 'attempt_count', 'state_revision',
        'lease_owner', 'lease_token', 'lease_expires_at', 'last_reason_code', 'terminal_at',
        'reconciliation_completed_at', 'created_at', 'updated_at', 'purge_after',
      ), names(), names(
        'status', 'state_revision', 'attempt_count', 'last_reason_code', 'lease_owner',
        'lease_token', 'lease_expires_at', 'terminal_at', 'reconciliation_completed_at',
        'purge_after', 'updated_at',
      )),
      table('execution_intent_transitions', names('intent_id'), names(
        'intent_id', 'previous_status', 'next_status', 'reason_code', 'human_message',
        'activation_phase', 'attempt_number', 'evidence', 'occurred_at',
      )),
      table('execution_attempts', names(
        'intent_id', 'attempt_number', 'status', 'effective_venue', 'provider_id',
        'started_at', 'completed_at', 'reason_code', 'reconciliation_signature',
        'reconciliation_blockhash', 'reconciliation_last_valid_block_height',
        'reconciliation_message_hash', 'reconciliation_build_fingerprint',
        'reconciliation_snapshot_fingerprint', 'reconciliation_maximum_fee_lamports',
        'reconciliation_maximum_fee_payer_lamport_debit', 'purge_after',
      ), names('intent_id', 'attempt_number', 'status', 'started_at'), names(
        'status', 'effective_venue', 'provider_id', 'completed_at', 'reason_code',
        'reconciliation_signature', 'reconciliation_blockhash',
        'reconciliation_last_valid_block_height', 'reconciliation_message_hash',
        'reconciliation_build_fingerprint', 'reconciliation_snapshot_fingerprint',
        'reconciliation_maximum_fee_lamports',
        'reconciliation_maximum_fee_payer_lamport_debit',
      )),
      table('execution_wallet_generations', names(
        'generation_id', 'wallet_public_key', 'cluster', 'genesis_hash', 'retired_at',
      )),
      table('execution_wallet_risk_state', names(
        'generation_id', 'state_revision', 'reconciled_capital_lamports',
        'reserved_exposure_raw', 'open_positions', 'conservative_drawdown_raw', 'unknown_block',
      ), names(), names(
        'state_revision', 'reserved_exposure_raw', 'open_positions', 'unknown_block', 'updated_at',
      )),
      table('execution_provider_usage_snapshots', names(
        'provider_id', 'billing_period_id', 'snapshot_fingerprint', 'measured_at',
        'expires_at', 'superseded_at',
      )),
      table('execution_provider_usage_counters', names(
        'provider_id', 'billing_period_id', 'units', 'recorded_at',
      )),
      table('execution_provider_rate_limit_events', names(
        'provider_id', 'billing_period_id',
      )),
      table('execution_risk_admission_reports', names(
        'report_id', 'intent_id', 'generation_id', 'decision', 'quota_state',
        'policy_fingerprint', 'wallet_snapshot_fingerprint', 'provider_snapshot_fingerprint',
        'quote_amount_raw', 'risk_state_revision_baseline',
        'conservative_drawdown_raw_baseline', 'provider_local_usage_units_baseline',
        'provider_rate_limit_count_baseline',
      )),
      table('execution_exposure_reservations', names(
        'reservation_id', 'intent_id', 'generation_id', 'side', 'mint', 'quote_mint',
        'maximum_amount_raw', 'intent_fingerprint', 'policy_fingerprint',
        'wallet_snapshot_fingerprint', 'provider_snapshot_fingerprint',
        'admission_report_id', 'state', 'state_revision',
      ), names(), names(
        'state', 'state_revision', 'reconciled_at', 'purge_after',
      )),
      table('execution_simulation_artifacts', names(
        'artifact_id', 'payload_version', 'specification_version', 'evaluator_version',
        'intent_id', 'attempt_number', 'intent_state_revision', 'strategy_id',
        'strategy_version', 'decision_fingerprint', 'result_kind', 'effective_venue',
        'provider_id', 'executor_public_key', 'expected_genesis_hash',
        'observed_genesis_hash', 'configuration_fingerprint', 'quote_fingerprint',
        'snapshot_fingerprint', 'build_fingerprint', 'message_hash', 'blockhash',
        'last_valid_block_height', 'blockhash_context_slot', 'snapshot_slot',
        'fee_context_slot', 'simulation_slot', 'amount_in_raw', 'expected_amount_out_raw',
        'protected_amount_out_raw', 'fees_raw', 'estimated_fee_lamports',
        'simulated_fee_payer_lamport_debit', 'units_consumed', 'simulated_base_delta_raw',
        'simulated_quote_delta_raw', 'rpc_calls_used', 'rpc_calls_limit', 'quote_status',
        'build_status', 'simulation_status', 'failure_stage', 'failure_code',
        'terminal_reason_code', 'logs_fingerprint', 'logs_line_count', 'result_fingerprint',
        'recorded_at',
      ), names(
        'artifact_id', 'payload_version', 'specification_version', 'evaluator_version',
        'intent_id', 'attempt_number', 'intent_state_revision', 'strategy_id',
        'strategy_version', 'decision_fingerprint', 'result_kind', 'effective_venue',
        'provider_id', 'executor_public_key', 'expected_genesis_hash',
        'observed_genesis_hash', 'configuration_fingerprint', 'quote_fingerprint',
        'snapshot_fingerprint', 'build_fingerprint', 'message_hash', 'blockhash',
        'last_valid_block_height', 'blockhash_context_slot', 'snapshot_slot',
        'fee_context_slot', 'simulation_slot', 'amount_in_raw', 'expected_amount_out_raw',
        'protected_amount_out_raw', 'fees_raw', 'estimated_fee_lamports',
        'simulated_fee_payer_lamport_debit', 'units_consumed', 'simulated_base_delta_raw',
        'simulated_quote_delta_raw', 'rpc_calls_used', 'rpc_calls_limit', 'quote_status',
        'build_status', 'simulation_status', 'failure_stage', 'failure_code',
        'terminal_reason_code', 'logs_fingerprint', 'logs_line_count', 'result_fingerprint',
        'recorded_at',
      )),
      table('execution_safety_qualifications', names(
        'qualification_id', 'qualification_fingerprint', 'generation_id', 'phase',
        'build_hash', 'configuration_fingerprint', 'strategy_fingerprint',
        'wallet_public_key', 'cluster', 'genesis_hash', 'provider_id', 'expires_at',
      )),
      table('execution_control_state', names(
        'generation_id', 'state', 'state_revision', 'last_event_id',
      ), names(), names('state', 'state_revision', 'last_event_id', 'updated_at')),
      table('execution_control_events', names(
        'event_id', 'generation_id', 'previous_state', 'next_state', 'reason_code',
        'actor_type', 'occurred_at',
      ), names(
        'event_id', 'payload_version', 'event_fingerprint', 'generation_id',
        'previous_state', 'next_state', 'reason_code', 'qualification_id',
        'authorization_id', 'operator_id', 'actor_type', 'actor_id', 'source',
        'intent_id', 'attempt_number', 'lock_id', 'artifact_id', 'occurred_at',
      )),
      table('execution_activation_armaments', names(
        'armament_id', 'generation_id', 'qualification_id', 'qualification_fingerprint',
        'phase', 'build_hash', 'configuration_fingerprint', 'strategy_fingerprint',
        'wallet_public_key', 'cluster', 'genesis_hash', 'provider_id', 'state',
        'state_revision', 'maximum_capital_lamports', 'maximum_exposure_bps',
        'maximum_open_positions', 'maximum_buys', 'consumed_buys', 'expires_at',
        'payload_version', 'armament_request_fingerprint', 'canary_evidence_fingerprint',
        'target_intent_id', 'target_intent_state_revision', 'target_strategy_id',
        'target_strategy_version', 'target_decision_fingerprint', 'target_mint',
        'target_quote_mint', 'target_quote_amount_raw', 'target_admission_report_id',
        'target_reservation_id', 'target_policy_fingerprint',
        'target_wallet_snapshot_fingerprint', 'target_provider_snapshot_fingerprint',
        'runtime_quote_max_age_ms', 'runtime_slippage_bps',
        'runtime_snapshot_max_slot_lag', 'runtime_max_compute_units',
        'runtime_max_fee_lamports', 'runtime_max_fee_payer_lamport_debit',
        'runtime_max_rpc_calls_per_attempt', 'runtime_lease_ms', 'locked_intent_id',
        'locked_attempt_number', 'locked_reservation_id', 'locked_lease_token', 'locked_at',
      ), names(), names(
        'state', 'state_revision', 'consumed_buys', 'terminal_at', 'purge_after',
        'locked_intent_id', 'locked_attempt_number', 'locked_reservation_id',
        'locked_lease_token', 'locked_at',
      )),
      table('execution_activation_events', names(), names(
        'event_id', 'payload_version', 'event_fingerprint', 'armament_id', 'generation_id',
        'previous_state', 'next_state', 'reason_code', 'occurred_at',
      )),
      table('execution_signed_transactions', names(
        'artifact_id', 'payload_version', 'specification_version', 'intent_id',
        'attempt_number', 'generation_id', 'armament_id', 'reservation_id',
        'pre_signature_lock_id',
        'exit_authorization_id', 'provider_id', 'wallet_public_key', 'side',
        'effective_venue', 'message_hash', 'build_fingerprint', 'snapshot_fingerprint',
        'quote_fingerprint', 'quote_observed_at', 'quote_expires_at', 'blockhash',
        'last_valid_block_height', 'signature', 'signed_transaction_bytes',
        'signed_transaction_hash', 'state', 'state_revision', 'signed_at',
        'signed_simulated_at', 'submission_started_at', 'submitted_at', 'confirmed_at',
        'confirmed_slot', 'reconciled_at', 'revoked_at', 'purge_after',
      ), names(
        'artifact_id', 'payload_version', 'specification_version', 'intent_id',
        'attempt_number', 'generation_id', 'armament_id', 'reservation_id',
        'pre_signature_lock_id',
        'exit_authorization_id', 'provider_id', 'wallet_public_key', 'side',
        'effective_venue', 'message_hash', 'build_fingerprint', 'snapshot_fingerprint',
        'quote_fingerprint', 'quote_observed_at', 'quote_expires_at', 'blockhash',
        'last_valid_block_height', 'signature', 'signed_transaction_bytes',
        'signed_transaction_hash', 'state', 'state_revision', 'signed_at',
      ), names(
        'state', 'state_revision', 'signed_simulated_at', 'submission_started_at',
        'submitted_at', 'revoked_at', 'purge_after',
      )),
      table('execution_pre_signature_locks', names(
        'lock_id', 'payload_version', 'lock_fingerprint', 'intent_id', 'attempt_number',
        'intent_state_revision',
        'armament_id', 'reservation_id', 'generation_id', 'wallet_public_key',
        'provider_id', 'lease_token', 'message_hash', 'unsigned_message_bytes',
        'unsigned_transaction_hash', 'unsigned_transaction_bytes', 'build_hash',
        'configuration_fingerprint', 'strategy_fingerprint', 'decision_fingerprint',
        'policy_fingerprint', 'wallet_snapshot_fingerprint',
        'provider_snapshot_fingerprint', 'effective_venue', 'market_snapshot_slot',
        'market_snapshot_fingerprint', 'quote_fingerprint', 'quote_observed_at',
        'quote_expires_at', 'unsigned_simulation_fingerprint', 'blockhash',
        'last_valid_block_height', 'state', 'state_revision', 'authorized_at',
        'terminal_at', 'purge_after',
      ), names(
        'lock_id', 'payload_version', 'lock_fingerprint', 'intent_id', 'attempt_number',
        'intent_state_revision', 'armament_id', 'reservation_id', 'generation_id',
        'wallet_public_key', 'provider_id', 'lease_token', 'message_hash',
        'unsigned_message_bytes', 'unsigned_transaction_hash',
        'unsigned_transaction_bytes', 'build_hash', 'configuration_fingerprint',
        'strategy_fingerprint', 'decision_fingerprint', 'policy_fingerprint',
        'wallet_snapshot_fingerprint', 'provider_snapshot_fingerprint',
        'effective_venue', 'market_snapshot_slot', 'market_snapshot_fingerprint',
        'quote_fingerprint', 'quote_observed_at', 'quote_expires_at',
        'unsigned_simulation_fingerprint', 'blockhash', 'last_valid_block_height',
        'state', 'state_revision', 'authorized_at',
      ), names('state', 'state_revision', 'terminal_at', 'purge_after')),
      table('execution_live_unsigned_simulation_evidence', names(
        'evidence_id', 'payload_version', 'evidence_fingerprint', 'artifact_id', 'intent_id',
        'attempt_number', 'provider_id', 'snapshot_fingerprint', 'build_fingerprint',
        'message_hash', 'blockhash', 'last_valid_block_height', 'blockhash_context_slot',
        'fee_context_slot', 'estimated_fee_lamports', 'simulation_slot',
        'simulated_fee_payer_lamport_debit', 'units_consumed', 'simulated_base_delta_raw',
        'simulated_quote_delta_raw', 'logs_fingerprint', 'logs_line_count', 'recorded_at',
      ), names(
        'evidence_id', 'payload_version', 'evidence_fingerprint', 'artifact_id', 'intent_id',
        'attempt_number', 'provider_id', 'snapshot_fingerprint', 'build_fingerprint',
        'message_hash', 'blockhash', 'last_valid_block_height', 'blockhash_context_slot',
        'fee_context_slot', 'estimated_fee_lamports', 'simulation_slot',
        'simulated_fee_payer_lamport_debit', 'units_consumed', 'simulated_base_delta_raw',
        'simulated_quote_delta_raw', 'logs_fingerprint', 'logs_line_count', 'recorded_at',
      )),
      table('execution_live_rpc_budgets', names(
        'intent_id', 'attempt_number', 'artifact_id', 'provider_id',
        'initial_calls_used', 'calls_reserved', 'calls_limit', 'created_at',
      ), names(
        'intent_id', 'attempt_number', 'artifact_id', 'provider_id',
        'initial_calls_used', 'calls_reserved', 'calls_limit', 'created_at',
      ), names('calls_reserved')),
      table('execution_signed_simulation_evidence', names(
        'payload_version', 'evidence_fingerprint', 'artifact_id',
        'unsigned_simulation_evidence_id', 'signed_transaction_hash', 'provider_id',
        'simulation_slot', 'units_consumed', 'fee_payer_lamport_debit', 'base_delta_raw',
        'quote_delta_raw', 'logs_fingerprint', 'logs_line_count', 'observed_at',
      ), names(
        'evidence_id', 'payload_version', 'evidence_fingerprint', 'artifact_id',
        'unsigned_simulation_evidence_id', 'signed_transaction_hash', 'provider_id',
        'simulation_slot', 'units_consumed', 'fee_payer_lamport_debit', 'base_delta_raw',
        'quote_delta_raw', 'logs_fingerprint', 'logs_line_count', 'observed_at',
      )),
      table('execution_submission_preflight_evidence', names(), names(
        'gate_id', 'payload_version', 'gate_fingerprint', 'artifact_id', 'intent_id',
        'attempt_number', 'generation_id', 'armament_id', 'reservation_id', 'provider_id',
        'phase', 'build_hash', 'configuration_fingerprint', 'strategy_fingerprint',
        'wallet_public_key', 'cluster', 'genesis_hash', 'armament_revision',
        'admission_risk_revision', 'risk_revision', 'admission_drawdown_raw',
        'conservative_drawdown_raw', 'admission_provider_local_usage_units',
        'provider_local_usage_units', 'admission_provider_rate_limit_count',
        'provider_rate_limit_count', 'reservation_amount_raw', 'reconciled_capital_raw',
        'reserved_exposure_raw', 'open_positions', 'maximum_capital_lamports',
        'maximum_exposure_bps', 'maximum_open_positions', 'quote_fingerprint',
        'quote_observed_at', 'quote_expires_at', 'blockhash', 'last_valid_block_height',
        'observed_block_height', 'blockhash_validity_context_slot', 'blockhash_validated_at',
        'authorized_at',
      )),
      table('execution_pre_submission_revocations', names(
        'artifact_id', 'intent_id', 'expected_state', 'expected_revision',
        'cause_reason_code', 'evidence_fingerprint', 'observed_at',
      ), names(
        'revocation_id', 'payload_version', 'revocation_fingerprint', 'artifact_id',
        'intent_id', 'attempt_number', 'generation_id', 'side', 'expected_state',
        'expected_revision', 'cause_reason_code', 'evidence_fingerprint', 'observed_at',
        'revoked_at', 'purge_after',
      )),
      table('execution_submission_events', names(), names(
        'event_id', 'payload_version', 'event_fingerprint', 'artifact_id', 'generation_id',
        'previous_state', 'next_state', 'reason_code', 'occurred_at',
      )),
      table('execution_live_positions', names(
        'position_id', 'generation_id', 'armament_id', 'wallet_public_key', 'mint',
        'quote_mint', 'state', 'state_revision', 'exit_intent_id', 'remaining_base_raw',
      ), names(), names(
        'state', 'state_revision', 'exit_intent_id',
      )),
      table('execution_exit_authorizations', names(
        'authorization_id', 'position_id', 'generation_id', 'wallet_public_key', 'mint',
        'quote_mint', 'maximum_base_amount_raw', 'state', 'state_revision',
        'locked_intent_id', 'locked_attempt_number',
      ), names(), names(
        'state', 'state_revision', 'locked_intent_id', 'locked_attempt_number',
      )),
    ]),
    sequences: Object.freeze([Object.freeze({
      name: 'execution_intent_transitions_sequence_seq',
      privileges: names('USAGE'),
    })]),
    functions: Object.freeze([]),
  });

export const LIVE_EXECUTOR_MIGRATION_CATALOG = LIVE_EXECUTION_MIGRATION_CATALOG;

export const LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL = `
  /* live_executor_effective_authority */
  WITH target AS (
    SELECT oid FROM pg_roles WHERE rolname=current_user
  ), user_namespaces AS (
    SELECT oid,nspname,nspowner,nspacl FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast')
      AND nspname NOT LIKE 'pg_temp_%'
      AND nspname NOT LIKE 'pg_toast_temp_%'
  ), schema_authority AS (
    SELECT 'SCHEMA'::TEXT AS kind,namespace.nspname::TEXT AS object_name,
      NULL::TEXT AS subobject_name,acl.privilege_type::TEXT AS privilege,
      acl.is_grantable,(CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE 'ROLE' END)::TEXT AS source,
      FALSE AS security_definer
    FROM user_namespaces namespace
    CROSS JOIN LATERAL aclexplode(
      COALESCE(namespace.nspacl,acldefault('n',namespace.nspowner))
    ) acl
    WHERE acl.grantee=(SELECT oid FROM target)
      OR (acl.grantee=0 AND acl.privilege_type='CREATE')
  ), relation_authority AS (
    SELECT (CASE WHEN relation.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END)::TEXT AS kind,
      (namespace.nspname || '.' || relation.relname)::TEXT AS object_name,
      NULL::TEXT AS subobject_name,acl.privilege_type::TEXT AS privilege,
      acl.is_grantable,(CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE 'ROLE' END)::TEXT AS source,
      FALSE AS security_definer
    FROM pg_class relation JOIN user_namespaces namespace ON namespace.oid=relation.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl,
      CASE WHEN relation.relkind='S' THEN acldefault('S',relation.relowner)
        ELSE acldefault('r',relation.relowner) END)) acl
    WHERE relation.relkind IN ('r','p','v','m','f','S')
      AND acl.grantee IN (0,(SELECT oid FROM target))
  ), column_authority AS (
    SELECT 'COLUMN'::TEXT AS kind,
      (namespace.nspname || '.' || relation.relname)::TEXT AS object_name,
      attribute.attname::TEXT AS subobject_name,acl.privilege_type::TEXT AS privilege,
      acl.is_grantable,(CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE 'ROLE' END)::TEXT AS source,
      FALSE AS security_definer
    FROM pg_class relation JOIN user_namespaces namespace ON namespace.oid=relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
      AND attribute.attnum>0 AND NOT attribute.attisdropped
    CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
    WHERE relation.relkind IN ('r','p','v','m','f')
      AND acl.grantee IN (0,(SELECT oid FROM target))
  ), function_authority AS (
    SELECT 'FUNCTION'::TEXT AS kind,
      (namespace.nspname || '.' || pg_get_function_identity_arguments(routine.oid)
        || ':' || routine.proname)::TEXT AS object_name,
      NULL::TEXT AS subobject_name,acl.privilege_type::TEXT AS privilege,
      acl.is_grantable,(CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE 'ROLE' END)::TEXT AS source,
      routine.prosecdef AS security_definer
    FROM pg_proc routine JOIN user_namespaces namespace ON namespace.oid=routine.pronamespace
    CROSS JOIN LATERAL aclexplode(
      COALESCE(routine.proacl,acldefault('f',routine.proowner))
    ) acl
    WHERE acl.grantee=(SELECT oid FROM target)
      OR (acl.grantee=0 AND routine.prosecdef)
  ), database_authority AS (
    SELECT 'DATABASE'::TEXT AS kind,database.datname::TEXT AS object_name,
      NULL::TEXT AS subobject_name,acl.privilege_type::TEXT AS privilege,
      acl.is_grantable,(CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE 'ROLE' END)::TEXT AS source,
      FALSE AS security_definer
    FROM pg_database database CROSS JOIN LATERAL aclexplode(
      COALESCE(database.datacl,acldefault('d',database.datdba))
    ) acl
    WHERE acl.grantee=(SELECT oid FROM target)
      OR (acl.grantee=0 AND database.datname=current_database()
        AND acl.privilege_type='TEMPORARY')
  ), type_authority AS (
    SELECT 'TYPE'::TEXT AS kind,
      (namespace.nspname || '.' || type.typname)::TEXT AS object_name,
      NULL::TEXT AS subobject_name,acl.privilege_type::TEXT AS privilege,
      acl.is_grantable,'ROLE'::TEXT AS source,FALSE AS security_definer
    FROM pg_type type JOIN user_namespaces namespace ON namespace.oid=type.typnamespace
    CROSS JOIN LATERAL aclexplode(type.typacl) acl
    WHERE acl.grantee=(SELECT oid FROM target)
  ), language_authority AS (
    SELECT 'LANGUAGE'::TEXT AS kind,language.lanname::TEXT AS object_name,
      NULL::TEXT AS subobject_name,acl.privilege_type::TEXT AS privilege,
      acl.is_grantable,'ROLE'::TEXT AS source,FALSE AS security_definer
    FROM pg_language language CROSS JOIN LATERAL aclexplode(language.lanacl) acl
    WHERE acl.grantee=(SELECT oid FROM target)
  ), default_acl_authority AS (
    SELECT 'DEFAULT_ACL'::TEXT AS kind,
      (grantor.rolname || ':' || COALESCE(namespace.nspname,'*') || ':'
        || defaults.defaclobjtype::TEXT)::TEXT AS object_name,
      NULL::TEXT AS subobject_name,acl.privilege_type::TEXT AS privilege,
      acl.is_grantable,(CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE 'ROLE' END)::TEXT AS source,
      FALSE AS security_definer
    FROM pg_default_acl defaults
    JOIN pg_roles grantor ON grantor.oid=defaults.defaclrole
    LEFT JOIN pg_namespace namespace ON namespace.oid=defaults.defaclnamespace
    CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
    WHERE acl.grantee IN (0,(SELECT oid FROM target))
  ), ownership AS (
    SELECT 'OWNER'::TEXT AS kind,namespace.nspname::TEXT AS object_name,
      NULL::TEXT AS subobject_name,'OWNER'::TEXT AS privilege,TRUE AS is_grantable,
      'ROLE'::TEXT AS source,FALSE AS security_definer
    FROM user_namespaces namespace WHERE namespace.nspowner=(SELECT oid FROM target)
    UNION ALL
    SELECT 'OWNER',(namespace.nspname || '.' || relation.relname),NULL,'OWNER',TRUE,'ROLE',FALSE
    FROM pg_class relation JOIN user_namespaces namespace ON namespace.oid=relation.relnamespace
    WHERE relation.relowner=(SELECT oid FROM target)
    UNION ALL
    SELECT 'OWNER',(namespace.nspname || '.' || routine.proname),NULL,'OWNER',TRUE,'ROLE',
      routine.prosecdef
    FROM pg_proc routine JOIN user_namespaces namespace ON namespace.oid=routine.pronamespace
    WHERE routine.proowner=(SELECT oid FROM target)
    UNION ALL
    SELECT 'OWNER',database.datname,NULL,'OWNER',TRUE,'ROLE',FALSE
    FROM pg_database database WHERE database.datdba=(SELECT oid FROM target)
    UNION ALL
    SELECT 'OWNER',(namespace.nspname || '.' || type.typname),NULL,'OWNER',TRUE,'ROLE',FALSE
    FROM pg_type type JOIN user_namespaces namespace ON namespace.oid=type.typnamespace
    WHERE type.typowner=(SELECT oid FROM target)
    UNION ALL
    SELECT 'OWNER',language.lanname,NULL,'OWNER',TRUE,'ROLE',FALSE
    FROM pg_language language WHERE language.lanowner=(SELECT oid FROM target)
    UNION ALL
    SELECT 'OWNER',(grantor.rolname || ':' || COALESCE(namespace.nspname,'*') || ':'
      || defaults.defaclobjtype::TEXT),NULL,'OWNER',TRUE,'ROLE',FALSE
    FROM pg_default_acl defaults
    JOIN pg_roles grantor ON grantor.oid=defaults.defaclrole
    LEFT JOIN pg_namespace namespace ON namespace.oid=defaults.defaclnamespace
    WHERE defaults.defaclrole=(SELECT oid FROM target)
  )
  SELECT kind,object_name,subobject_name,privilege,is_grantable,source,security_definer
  FROM schema_authority
  UNION ALL SELECT * FROM relation_authority
  UNION ALL SELECT * FROM column_authority
  UNION ALL SELECT * FROM function_authority
  UNION ALL SELECT * FROM database_authority
  UNION ALL SELECT * FROM type_authority
  UNION ALL SELECT * FROM language_authority
  UNION ALL SELECT * FROM default_acl_authority
  UNION ALL SELECT * FROM ownership
  ORDER BY kind,object_name,subobject_name NULLS FIRST,privilege,source`;

export async function validateLiveExecutorMigrationFiles(
  migrationsDirectory?: string,
): Promise<void> {
  try {
    await validateLiveExecutionMigrationFiles(migrationsDirectory);
  } catch {
    throw failure('MIGRATION_CATALOG_INVALID');
  }
}

export async function validateLiveExecutorStartup(
  database: LiveExecutorStartupDatabase,
  config: LiveExecutorConfig,
  options: Readonly<{ readonly validateFiles?: boolean }> = {},
): Promise<LiveExecutorStartupEvidenceV1> {
  if (options.validateFiles !== false) await validateLiveExecutorMigrationFiles();

  const role = oneRow(await queryAt(database, ROLE_SQL, undefined, 'DATABASE_ROLE_INVALID'),
    'DATABASE_ROLE_INVALID');
  if (!validRole(role)) throw failure('DATABASE_ROLE_INVALID');

  const authority = await queryAt(
    database, LIVE_EXECUTOR_EFFECTIVE_AUTHORITY_SQL, undefined, 'DATABASE_AUTHORITY_INVALID',
  );
  let actualAuthority: string[];
  try {
    actualAuthority = authority.rows.map(authorityKey).sort();
  } catch {
    throw failure('DATABASE_AUTHORITY_INVALID');
  }
  if (authority.rowCount !== authority.rows.length
    || !sameStrings(actualAuthority, expectedAuthorityKeys())) {
    throw failure('DATABASE_AUTHORITY_INVALID');
  }

  const migrations = await queryAt(database,
    'SELECT version FROM migration_history ORDER BY version',
    undefined, 'MIGRATION_CATALOG_INVALID');
  let versions: string[];
  try { versions = migrations.rows.map((row) => exactTextRow(row, 'version')); } catch {
    throw failure('MIGRATION_CATALOG_INVALID');
  }
  if (migrations.rowCount !== migrations.rows.length
    || !sameStrings(versions, LIVE_EXECUTOR_MIGRATION_CATALOG.map((entry) => entry.name))) {
    throw failure('MIGRATION_CATALOG_INVALID');
  }

  const generation = oneRow(await queryAt(database, GENERATION_SQL, [config.generationId],
    'GENERATION_BINDING_INVALID'), 'GENERATION_BINDING_INVALID');
  if (!exactKeys(generation, [
    'cluster', 'generation_id', 'genesis_hash', 'retired_at', 'wallet_public_key',
  ])
    || generation.generation_id !== config.generationId
    || generation.wallet_public_key !== config.executorPublicKey
    || generation.cluster !== config.cluster
    || generation.genesis_hash !== config.expectedGenesisHash
    || generation.retired_at !== null) throw failure('GENERATION_BINDING_INVALID');

  const bindingValues = [
    config.generationId, config.phase, config.buildHash,
    config.configurationFingerprint, config.strategyFingerprint,
    config.executorPublicKey, config.cluster, config.expectedGenesisHash, config.providerId,
  ];
  const bindings = oneRow(await queryAt(database, BINDINGS_SQL, bindingValues,
    'GENERATION_BINDING_INVALID'), 'GENERATION_BINDING_INVALID');
  if (!exactKeys(bindings, ['divergent_binding_count'])
    || bindings.divergent_binding_count !== '0') throw failure('GENERATION_BINDING_INVALID');

  const work = oneRow(await queryAt(database, OPEN_WORK_SQL, [
    config.generationId, config.executorPublicKey, config.providerId,
    config.maxRpcCallsPerAttempt,
  ], 'OPEN_WORK_BINDING_INVALID'), 'OPEN_WORK_BINDING_INVALID');
  if (!exactKeys(work, ['divergent_work_count'])
    || work.divergent_work_count !== '0') throw failure('OPEN_WORK_BINDING_INVALID');

  return Object.freeze({
    payloadVersion: 1,
    role: 'sol_token_executor_live',
    migrationHead: '039_execution_canary_operator_binding.sql',
    generationId: config.generationId,
    providerId: config.providerId,
    phase: config.phase,
  });
}

const ROLE_SQL = `SELECT
  current_setting('server_version_num')::INTEGER AS server_version_number,
  current_user AS current_role,session_user AS session_role,
  current_setting('search_path') AS search_path,
  current_setting('session_replication_role') AS session_replication_role,
  target.rolsuper AS role_super,target.rolcanlogin AS role_login,
  target.rolinherit AS role_inherit,target.rolcreatedb AS role_createdb,
  target.rolcreaterole AS role_createrole,target.rolbypassrls AS role_bypass_rls,
  target.rolreplication AS role_replication,
  login.rolsuper AS session_super,login.rolcanlogin AS session_login,
  login.rolinherit AS session_inherit,login.rolcreatedb AS session_createdb,
  login.rolcreaterole AS session_createrole,login.rolbypassrls AS session_bypass_rls,
  login.rolreplication AS session_replication,
  (SELECT COUNT(*)::TEXT FROM pg_auth_members direct WHERE direct.member=login.oid)
    AS membership_count,
  membership.admin_option AS membership_admin,
  membership.inherit_option AS membership_inherit,membership.set_option AS membership_set,
  pg_has_role(session_user,'sol_token_executor_live','MEMBER') AS live_membership,
  (SELECT COUNT(*)::TEXT FROM pg_auth_members parent WHERE parent.member=target.oid)
    AS role_parent_count,
  (SELECT COUNT(*)::TEXT FROM (
    SELECT 1 FROM pg_database object CROSS JOIN LATERAL aclexplode(object.datacl) acl
      WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_database object WHERE object.datdba=login.oid
    UNION ALL SELECT 1 FROM pg_namespace object CROSS JOIN LATERAL aclexplode(object.nspacl) acl
      WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_namespace object WHERE object.nspowner=login.oid
    UNION ALL SELECT 1 FROM pg_class object CROSS JOIN LATERAL aclexplode(object.relacl) acl
      WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_class object WHERE object.relowner=login.oid
    UNION ALL SELECT 1 FROM pg_attribute object CROSS JOIN LATERAL aclexplode(object.attacl) acl
      WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_proc object CROSS JOIN LATERAL aclexplode(object.proacl) acl
      WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_proc object WHERE object.proowner=login.oid
    UNION ALL SELECT 1 FROM pg_type object CROSS JOIN LATERAL aclexplode(object.typacl) acl
      WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_type object WHERE object.typowner=login.oid
    UNION ALL SELECT 1 FROM pg_language object
      CROSS JOIN LATERAL aclexplode(object.lanacl) acl WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_language object WHERE object.lanowner=login.oid
    UNION ALL SELECT 1 FROM pg_default_acl object
      CROSS JOIN LATERAL aclexplode(object.defaclacl) acl WHERE acl.grantee=login.oid
    UNION ALL SELECT 1 FROM pg_default_acl object WHERE object.defaclrole=login.oid
    UNION ALL SELECT 1 FROM pg_parameter_acl object
      CROSS JOIN LATERAL aclexplode(object.paracl) acl WHERE acl.grantee=login.oid
  ) direct_authority) AS session_direct_authority_count,
  has_parameter_privilege(current_user,'session_replication_role','SET')
    AS role_can_set_replication,
  has_parameter_privilege(session_user,'session_replication_role','SET')
    AS session_can_set_replication
  FROM pg_roles target CROSS JOIN pg_roles login
  JOIN pg_auth_members membership ON membership.member=login.oid
    AND membership.roleid=target.oid
  WHERE target.rolname=current_user AND login.rolname=session_user`;

const GENERATION_SQL = `SELECT generation_id,wallet_public_key,cluster,genesis_hash,retired_at
  FROM execution_wallet_generations WHERE generation_id=$1`;

const BINDINGS_SQL = `SELECT COUNT(*)::TEXT AS divergent_binding_count
  FROM execution_activation_armaments armament
  LEFT JOIN execution_safety_qualifications qualification
    ON qualification.qualification_id=armament.qualification_id
  WHERE (armament.state IN ('ARMED','LOCKED')
      OR EXISTS (SELECT 1 FROM execution_signed_transactions transaction
        WHERE transaction.armament_id=armament.armament_id
          AND transaction.state IN ('PERSISTED','SIGNED_SIMULATED','SUBMISSION_STARTED',
            'ACCEPTED','AMBIGUOUS','CONFIRMED'))
      OR EXISTS (SELECT 1 FROM execution_live_positions position
        WHERE position.armament_id=armament.armament_id
          AND position.state IN ('OPEN','EXIT_PENDING','UNKNOWN')))
    AND (armament.generation_id<>$1 OR armament.phase<>$2 OR armament.build_hash<>$3
      OR armament.configuration_fingerprint<>$4 OR armament.strategy_fingerprint<>$5
      OR armament.wallet_public_key<>$6 OR armament.cluster<>$7
      OR armament.genesis_hash<>$8 OR armament.provider_id<>$9
      OR qualification.qualification_id IS NULL
      OR qualification.qualification_fingerprint<>armament.qualification_fingerprint
      OR qualification.generation_id<>$1 OR qualification.phase<>$2
      OR qualification.build_hash<>$3 OR qualification.configuration_fingerprint<>$4
      OR qualification.strategy_fingerprint<>$5 OR qualification.wallet_public_key<>$6
      OR qualification.cluster<>$7 OR qualification.genesis_hash<>$8
      OR qualification.provider_id<>$9)`;

const OPEN_WORK_SQL = `SELECT (
    (SELECT COUNT(*) FROM execution_signed_transactions transaction
      WHERE transaction.state IN ('PERSISTED','SIGNED_SIMULATED','SUBMISSION_STARTED',
        'ACCEPTED','AMBIGUOUS','CONFIRMED')
        AND (transaction.generation_id<>$1 OR transaction.wallet_public_key<>$2
          OR transaction.provider_id<>$3))
    + (SELECT COUNT(*) FROM execution_signed_transactions transaction
      LEFT JOIN execution_live_rpc_budgets budget
        ON budget.artifact_id=transaction.artifact_id
      WHERE transaction.state IN ('PERSISTED','SIGNED_SIMULATED','SUBMISSION_STARTED')
        AND (budget.artifact_id IS NULL OR budget.intent_id<>transaction.intent_id
          OR budget.attempt_number<>transaction.attempt_number
          OR budget.provider_id<>transaction.provider_id OR budget.calls_limit<>$4))
    + (SELECT COUNT(*) FROM execution_live_positions position
      JOIN execution_activation_armaments armament ON armament.armament_id=position.armament_id
      WHERE position.state IN ('OPEN','EXIT_PENDING','UNKNOWN')
        AND (position.generation_id<>$1 OR position.wallet_public_key<>$2
          OR armament.provider_id<>$3))
    + (SELECT COUNT(*) FROM execution_exit_authorizations exit_auth
      WHERE exit_auth.state IN ('ACTIVE','LOCKED')
        AND (exit_auth.generation_id<>$1 OR exit_auth.wallet_public_key<>$2))
  )::TEXT AS divergent_work_count`;

function validRole(role: Readonly<Record<string, unknown>>): boolean {
  return exactKeys(role, [
    'current_role', 'live_membership', 'membership_admin', 'membership_count',
    'membership_inherit', 'membership_set', 'role_bypass_rls', 'role_can_set_replication',
    'role_createdb', 'role_createrole', 'role_inherit', 'role_login', 'role_parent_count',
    'role_replication', 'role_super', 'search_path', 'server_version_number',
    'session_bypass_rls', 'session_can_set_replication', 'session_createdb',
    'session_createrole', 'session_direct_authority_count', 'session_inherit',
    'session_login', 'session_replication', 'session_replication_role', 'session_role',
    'session_super',
  ])
    && typeof role.server_version_number === 'number'
    && role.server_version_number >= 160_000 && role.server_version_number < 170_000
    && role.current_role === 'sol_token_executor_live'
    && typeof role.session_role === 'string' && role.session_role !== role.current_role
    && role.search_path === 'pg_catalog, public'
    && role.session_replication_role === 'origin'
    && role.role_super === false && role.role_login === false && role.role_inherit === false
    && role.role_createdb === false && role.role_createrole === false
    && role.role_bypass_rls === false && role.role_replication === false
    && role.session_super === false && role.session_login === true
    && role.session_inherit === false && role.session_createdb === false
    && role.session_createrole === false && role.session_bypass_rls === false
    && role.session_replication === false
    && role.membership_count === '1' && role.live_membership === true
    && role.membership_admin === false && role.membership_inherit === false
    && role.membership_set === true && role.role_parent_count === '0'
    && role.session_direct_authority_count === '0'
    && role.role_can_set_replication === false
    && role.session_can_set_replication === false;
}

function expectedAuthorityKeys(): string[] {
  const authority = LIVE_EXECUTOR_DATABASE_AUTHORITY_V1;
  const expected = [authorityKeyFrom('SCHEMA', authority.schema, null, 'USAGE', false,
    'ROLE', false)];
  for (const item of authority.tables) {
    for (const [privilege, columns] of [
      ['SELECT', item.select], ['INSERT', item.insert], ['UPDATE', item.update],
    ] as const) for (const column of columns) expected.push(authorityKeyFrom(
      'COLUMN', `${authority.schema}.${item.name}`, column, privilege, false, 'ROLE', false,
    ));
  }
  for (const item of authority.sequences) {
    for (const privilege of item.privileges) expected.push(authorityKeyFrom(
      'SEQUENCE', `${authority.schema}.${item.name}`, null, privilege, false, 'ROLE', false,
    ));
  }
  for (const item of authority.functions) {
    for (const privilege of item.privileges) expected.push(authorityKeyFrom(
      'FUNCTION', item.identity, null, privilege, false, 'ROLE', false,
    ));
  }
  return expected.sort();
}

function authorityKey(row: Readonly<Record<string, unknown>>): string {
  if (!exactKeys(row, [
    'is_grantable', 'kind', 'object_name', 'privilege', 'security_definer',
    'source', 'subobject_name',
  ])
    || typeof row.kind !== 'string' || typeof row.object_name !== 'string'
    || (row.subobject_name !== null && typeof row.subobject_name !== 'string')
    || typeof row.privilege !== 'string' || typeof row.is_grantable !== 'boolean'
    || typeof row.source !== 'string' || typeof row.security_definer !== 'boolean') throw new Error();
  return authorityKeyFrom(row.kind, row.object_name, row.subobject_name, row.privilege,
    row.is_grantable, row.source, row.security_definer);
}

function authorityKeyFrom(
  kind: string,
  objectName: string,
  subobjectName: string | null,
  privilege: string,
  isGrantable: boolean,
  source: string,
  securityDefiner: boolean,
): string {
  return [kind, objectName, subobjectName ?? '', privilege,
    isGrantable ? 'GRANTABLE' : 'NOT_GRANTABLE', source,
    securityDefiner ? 'SECURITY_DEFINER' : 'INVOKER'].join('\u0000');
}

async function queryAt(
  database: LiveExecutorStartupDatabase,
  text: string,
  values: readonly unknown[] | undefined,
  code: LiveExecutorStartupErrorCode,
): ReturnType<LiveExecutorStartupDatabase['query']> {
  try { return await database.query(text, values); } catch {
    throw failure(code);
  }
}

function oneRow(
  result: Readonly<{
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    readonly rowCount: number | null;
  }>,
  code: LiveExecutorStartupErrorCode,
): Readonly<Record<string, unknown>> {
  if (result.rowCount !== 1 || result.rows.length !== 1 || result.rows[0] === undefined) {
    throw failure(code);
  }
  return result.rows[0];
}

function exactTextRow(row: Readonly<Record<string, unknown>>, key: string): string {
  if (!exactKeys(row, [key]) || typeof row[key] !== 'string') throw new Error();
  return row[key];
}

function exactKeys(row: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  return sameStrings(Object.keys(row).sort(), [...expected].sort());
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function failure(code: LiveExecutorStartupErrorCode): LiveExecutorStartupError {
  return new LiveExecutorStartupError(code);
}
