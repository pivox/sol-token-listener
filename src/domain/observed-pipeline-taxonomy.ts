/** Durable wire contract v1.0.0. Dependency-free closed vocabulary. */
export const OBSERVED_PIPELINE_STAGES = [
  'create_observation', 'load_tracked_mints', 'launchpad_observation',
  'sync_tracked_mint', 'reload_active_events', 'funding_observation',
  'participant_analytics', 'wallet_graph', 'pumpswap_observation',
  'qualification', 'paper_decision_enqueue',
] as const;

export type ObservedPipelineStage = (typeof OBSERVED_PIPELINE_STAGES)[number];

export const OBSERVED_PIPELINE_ORIGIN_CODES = [
  'PUMP_TRANSACTION_INDEX_REQUIRED', 'PUMP_SCHEMA_UNSUPPORTED',
  'PUMP_BORSH_TRUNCATED', 'PUMP_BORSH_INVALID', 'PUMP_ACCOUNT_MISSING',
  'PUMP_STACK_HEIGHT_REQUIRED', 'PUMP_STACK_HEIGHT_INVALID',
  'PUMP_EVENT_MISSING', 'PUMP_EVENT_DUPLICATE', 'PUMP_EVENT_ORPHANED',
  'PUMP_EVENT_AMBIGUOUS', 'PUMP_EVENT_MISMATCH', 'PUMP_QUOTE_ASSET_UNRESOLVED',
  'PUMP_QUOTE_ASSET_CONFLICT', 'PUMP_TOKEN_PROGRAM_UNSUPPORTED',
  'PUMPSWAP_ACCOUNT_MISSING', 'PUMPSWAP_BORSH_INVALID', 'PUMPSWAP_BORSH_TRUNCATED',
  'PUMPSWAP_EVENT_AMBIGUOUS', 'PUMPSWAP_EVENT_DUPLICATE', 'PUMPSWAP_EVENT_MISMATCH',
  'PUMPSWAP_EVENT_MISSING', 'PUMPSWAP_EVENT_ORPHANED', 'PUMPSWAP_SCHEMA_UNSUPPORTED',
  'PUMPSWAP_STACK_HEIGHT_REQUIRED', 'PUMPSWAP_TOKEN_PROGRAM_UNSUPPORTED',
  'UNKNOWN',
] as const;

export type ObservedPipelineOriginCode = (typeof OBSERVED_PIPELINE_ORIGIN_CODES)[number];
