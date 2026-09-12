/** Durable wire contract v1.0.0. Keep provider text and adapter objects outside this module. */
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

const stages = new Set<string>(OBSERVED_PIPELINE_STAGES);
const codes = new Set<string>(OBSERVED_PIPELINE_ORIGIN_CODES);
export type ObservedPipelineOriginCode = (typeof OBSERVED_PIPELINE_ORIGIN_CODES)[number];
const trustedOrigins = new WeakMap<object, Exclude<ObservedPipelineOriginCode, 'UNKNOWN'>>();

/** @internal Authority-bearing registration, used only by the internal decoder factories. */
export function registerInternalDecodingFailure(error: Error, code: unknown): void {
  if (typeof code === 'string' && code !== 'UNKNOWN' && codes.has(code)) {
    trustedOrigins.set(error, code as Exclude<ObservedPipelineOriginCode, 'UNKNOWN'>);
  }
}

/** Exact identity only: no prototype, property, cause-chain or proxy inspection. */
export function trustedObservedPipelineOrigin(value: unknown): Exclude<ObservedPipelineOriginCode, 'UNKNOWN'> | null {
  return typeof value === 'object' && value !== null ? trustedOrigins.get(value) ?? null : null;
}

/** @internal Wrapping can only preserve authority already present on the exact cause. */
export function inheritObservedPipelineOrigin(wrapper: Error, cause: unknown): void {
  const code = trustedObservedPipelineOrigin(cause);
  if (code !== null) trustedOrigins.set(wrapper, code);
}

export function assertValidObservedPipelineFailure(errorName: string, retryable: boolean): void {
  const [name, version, stage, code, extra] = errorName.split('.');
  if (name !== 'ObservedPipelineFailure' || version !== 'v1'
    || stage === undefined || code === undefined || extra !== undefined
    || !codes.has(code) || retryable !== (code === 'UNKNOWN')
    || (stage === 'unclassified' ? code !== 'UNKNOWN' : !stages.has(stage))) {
    throw new TypeError('Ingestion pipeline failure must match the v1 taxonomy.');
  }
}
