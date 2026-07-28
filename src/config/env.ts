import 'dotenv/config';

const DEFAULT_WSOL_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_RAYDIUM_CPMM_PROGRAM_ID = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';

export type ExecutionMode = 'observe' | 'paper';
export type QualificationRuleSetStatus = 'UNVALIDATED_RULE_SET';

export interface AppConfig {
  readonly cluster: string;
  readonly httpRpcUrl: string;
  readonly wsRpcUrl: string;
  readonly commitment: 'processed' | 'confirmed' | 'finalized';
  readonly finality: 'confirmed' | 'finalized';
  readonly databaseUrl: string;
  readonly autoMigrate: boolean;
  readonly executionMode: ExecutionMode;
  readonly paperQuoteMintAllowlist: readonly string[];
  readonly qualificationRuleSetStatus: QualificationRuleSetStatus;
  readonly dataRetentionHours: number;
  readonly raydiumCpmmProgramId: string;
  readonly wsolMint: string;
  readonly buyAmountLamports: bigint;
  readonly slippageBps: number;
  readonly maxPriorityFeeLamports: bigint | null;
  readonly computeUnitLimit: number | null;
  readonly targetBuysAfterEntry: number;
  readonly maxConcurrentPositions: number;
  readonly maxActivePoolMonitors: number;
  readonly poolMonitorTtlMinutes: number;
  readonly reconcileSeconds: number;
  readonly rpcRetryMaxAttempts: number;
  readonly rpcRetryBaseDelayMs: number;
  readonly minWsolLiquidityLamports: bigint;
  readonly riskMinScore: number;
  readonly riskAllowUnknownReviews: boolean;
  readonly riskAllowUnknownMinScore: number;
  readonly riskMaxTransferFeeBps: number;
  readonly riskMaxBuyPriceImpactBps: number | null;
  readonly riskMaxSellPriceImpactBps: number | null;
  readonly riskMaxRoundTripLossBps: number;
  readonly riskBuySimulationRequired: boolean;
  readonly riskReverseQuoteRequired: boolean;
  readonly riskMaxTop1HolderBps: number | null;
  readonly riskMaxTop5HoldersBps: number | null;
  readonly riskMaxTop10HoldersBps: number | null;
  readonly dashboardEnabled: boolean;
  readonly dashboardHost: string;
  readonly dashboardPort: number;
  readonly dashboardRefreshSeconds: number;
  readonly dashboardMaxRows: number;
  readonly dashboardActionsEnabled: false;
  readonly logLevel: string;
}

export function parseConfig(environment: NodeJS.ProcessEnv | Record<string, string | undefined>): AppConfig {
  rejectPrivateKeyConfiguration(environment);

  const executionMode = parseExecutionMode(environment.EXECUTION_MODE);
  const dashboardActionsEnabled = parseBoolean(environment.DASHBOARD_ACTIONS_ENABLED, false, 'DASHBOARD_ACTIONS_ENABLED');
  if (dashboardActionsEnabled) {
    throw new Error('Pump.fun V1 exposes a read-only dashboard; dashboard actions cannot be enabled.');
  }

  const wsolMint = optional(environment.WSOL_MINT, DEFAULT_WSOL_MINT);
  const paperQuoteMintAllowlist = parseMintAllowlist(environment.PAPER_QUOTE_MINT_ALLOWLIST, wsolMint);
  if (executionMode === 'paper' && !paperQuoteMintAllowlist.includes(wsolMint)) {
    throw new Error('Pump.fun V1 paper mode requires SOL/WSOL in PAPER_QUOTE_MINT_ALLOWLIST.');
  }

  return {
    cluster: optional(environment.SOLANA_CLUSTER, 'mainnet-beta'),
    httpRpcUrl: requiredUrl(environment.SOLANA_HTTP_RPC_URL, 'SOLANA_HTTP_RPC_URL', ['http:', 'https:']),
    wsRpcUrl: requiredUrl(environment.SOLANA_WS_RPC_URL, 'SOLANA_WS_RPC_URL', ['ws:', 'wss:']),
    commitment: parseEnum(environment.SOLANA_COMMITMENT, 'confirmed', ['processed', 'confirmed', 'finalized']),
    finality: parseEnum(environment.SOLANA_FINALITY_COMMITMENT, 'finalized', ['confirmed', 'finalized']),
    databaseUrl: optional(environment.DATABASE_URL, 'postgresql://solanabot:solanabot@127.0.0.1:5432/solanabot'),
    autoMigrate: parseBoolean(environment.POSTGRES_AUTO_MIGRATE, false, 'POSTGRES_AUTO_MIGRATE'),
    executionMode,
    paperQuoteMintAllowlist,
    qualificationRuleSetStatus: 'UNVALIDATED_RULE_SET',
    dataRetentionHours: parseInteger(environment.DATA_RETENTION_HOURS, 4, 'DATA_RETENTION_HOURS', 1, 168),
    raydiumCpmmProgramId: optional(environment.RAYDIUM_CPMM_PROGRAM_ID, DEFAULT_RAYDIUM_CPMM_PROGRAM_ID),
    wsolMint,
    buyAmountLamports: parseSolToLamports(environment.BUY_AMOUNT_SOL, '0.01', 'BUY_AMOUNT_SOL'),
    slippageBps: parseInteger(environment.SLIPPAGE_BPS, 1_500, 'SLIPPAGE_BPS', 0, 10_000),
    maxPriorityFeeLamports: parseOptionalBigInt(environment.MAX_PRIORITY_FEE_LAMPORTS, 'MAX_PRIORITY_FEE_LAMPORTS'),
    computeUnitLimit: parseOptionalInteger(environment.COMPUTE_UNIT_LIMIT, 400_000, 'COMPUTE_UNIT_LIMIT', 1),
    targetBuysAfterEntry: parseInteger(environment.TARGET_BUYS_AFTER_ENTRY, 10, 'TARGET_BUYS_AFTER_ENTRY', 1),
    maxConcurrentPositions: parseInteger(environment.MAX_CONCURRENT_POSITIONS, 1, 'MAX_CONCURRENT_POSITIONS', 1),
    maxActivePoolMonitors: parseInteger(environment.MAX_ACTIVE_POOL_MONITORS, 50, 'MAX_ACTIVE_POOL_MONITORS', 1),
    poolMonitorTtlMinutes: parseInteger(environment.POOL_MONITOR_TTL_MINUTES, 90, 'POOL_MONITOR_TTL_MINUTES', 1),
    reconcileSeconds: parseInteger(environment.RECONCILE_SECONDS, 15, 'RECONCILE_SECONDS', 1),
    rpcRetryMaxAttempts: parseInteger(environment.RPC_RETRY_MAX_ATTEMPTS, 5, 'RPC_RETRY_MAX_ATTEMPTS', 1),
    rpcRetryBaseDelayMs: parseInteger(environment.RPC_RETRY_BASE_DELAY_MS, 500, 'RPC_RETRY_BASE_DELAY_MS', 1),
    minWsolLiquidityLamports: parseSolToLamports(environment.MIN_WSOL_LIQUIDITY, '0.25', 'MIN_WSOL_LIQUIDITY'),
    riskMinScore: parseInteger(environment.RISK_MIN_SCORE, 80, 'RISK_MIN_SCORE', 0, 100),
    riskAllowUnknownReviews: parseBoolean(environment.RISK_ALLOW_UNKNOWN_REVIEWS, false, 'RISK_ALLOW_UNKNOWN_REVIEWS'),
    riskAllowUnknownMinScore: parseInteger(environment.RISK_ALLOW_UNKNOWN_MIN_SCORE, 95, 'RISK_ALLOW_UNKNOWN_MIN_SCORE', 0, 100),
    riskMaxTransferFeeBps: parseInteger(environment.RISK_MAX_TRANSFER_FEE_BPS, 1_500, 'RISK_MAX_TRANSFER_FEE_BPS', 0, 10_000),
    riskMaxBuyPriceImpactBps: parseOptionalInteger(environment.RISK_MAX_BUY_PRICE_IMPACT_BPS, null, 'RISK_MAX_BUY_PRICE_IMPACT_BPS', 0, 10_000),
    riskMaxSellPriceImpactBps: parseOptionalInteger(environment.RISK_MAX_SELL_PRICE_IMPACT_BPS, null, 'RISK_MAX_SELL_PRICE_IMPACT_BPS', 0, 10_000),
    riskMaxRoundTripLossBps: parseInteger(environment.RISK_MAX_ROUNDTRIP_LOSS_BPS, 3_000, 'RISK_MAX_ROUNDTRIP_LOSS_BPS', 0, 10_000),
    riskBuySimulationRequired: parseBoolean(environment.RISK_BUY_SIMULATION_REQUIRED, true, 'RISK_BUY_SIMULATION_REQUIRED'),
    riskReverseQuoteRequired: parseBoolean(environment.RISK_REVERSE_QUOTE_REQUIRED, true, 'RISK_REVERSE_QUOTE_REQUIRED'),
    riskMaxTop1HolderBps: parseOptionalInteger(environment.RISK_MAX_TOP1_HOLDER_BPS, null, 'RISK_MAX_TOP1_HOLDER_BPS', 0, 10_000),
    riskMaxTop5HoldersBps: parseOptionalInteger(environment.RISK_MAX_TOP5_HOLDERS_BPS, null, 'RISK_MAX_TOP5_HOLDERS_BPS', 0, 10_000),
    riskMaxTop10HoldersBps: parseOptionalInteger(environment.RISK_MAX_TOP10_HOLDERS_BPS, null, 'RISK_MAX_TOP10_HOLDERS_BPS', 0, 10_000),
    dashboardEnabled: parseBoolean(environment.DASHBOARD_ENABLED, true, 'DASHBOARD_ENABLED'),
    dashboardHost: optional(environment.DASHBOARD_HOST, '127.0.0.1'),
    dashboardPort: parseInteger(environment.DASHBOARD_PORT, 3_000, 'DASHBOARD_PORT', 1, 65_535),
    dashboardRefreshSeconds: parseInteger(environment.DASHBOARD_REFRESH_SECONDS, 5, 'DASHBOARD_REFRESH_SECONDS', 1),
    dashboardMaxRows: parseInteger(environment.DASHBOARD_MAX_ROWS, 250, 'DASHBOARD_MAX_ROWS', 1),
    dashboardActionsEnabled: false,
    logLevel: optional(environment.LOG_LEVEL, 'info'),
  };
}

export function loadConfig(): AppConfig {
  return parseConfig(process.env);
}

function parseExecutionMode(raw: string | undefined): ExecutionMode {
  const value = optional(raw, 'observe');
  if (value !== 'observe' && value !== 'paper') {
    throw new Error('EXECUTION_MODE must be observe or paper in Pump.fun V1.');
  }
  return value;
}

function rejectPrivateKeyConfiguration(environment: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
  if (hasValue(environment.SOLANA_KEYPAIR_PATH) || hasValue(environment.SOLANA_PRIVATE_KEY_BASE58)) {
    throw new Error('Pump.fun V1 rejects every private key configuration.');
  }
}

function parseMintAllowlist(raw: string | undefined, defaultMint: string): readonly string[] {
  const values = hasValue(raw) ? raw.split(',').map((value) => value.trim()).filter(Boolean) : [defaultMint];
  return [...new Set(values)];
}

function parseSolToLamports(raw: string | undefined, fallback: string, name: string): bigint {
  const value = optional(raw, fallback);
  const match = /^(\d+)(?:\.(\d{1,9}))?$/u.exec(value);
  if (!match) throw new Error(`${name} must be a non-negative decimal with at most 9 decimal places.`);
  const whole = BigInt(match[1] ?? '0');
  const fraction = (match[2] ?? '').padEnd(9, '0');
  return (whole * 1_000_000_000n) + BigInt(fraction || '0');
}

function parseOptionalBigInt(raw: string | undefined, name: string): bigint | null {
  if (!hasValue(raw)) return null;
  if (!/^\d+$/u.test(raw.trim())) throw new Error(`${name} must be a non-negative integer.`);
  return BigInt(raw.trim());
}

function parseInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  return parseOptionalInteger(raw, fallback, name, minimum, maximum) ?? fallback;
}

function parseOptionalInteger(
  raw: string | undefined,
  fallback: number | null,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  if (!hasValue(raw)) return fallback;
  if (!/^\d+$/u.test(raw.trim())) throw new Error(`${name} must be an integer.`);
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function parseBoolean(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (!hasValue(raw)) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function requiredUrl(raw: string | undefined, name: string, protocols: readonly string[]): string {
  if (!hasValue(raw)) throw new Error(`${name} is required.`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} must use ${protocols.join(' or ')}.`);
  }
  return parsed.toString();
}

function parseEnum<const T extends string>(
  raw: string | undefined,
  fallback: T,
  values: readonly T[],
): T {
  const value = optional(raw, fallback);
  if (!values.includes(value as T)) throw new Error(`Expected one of: ${values.join(', ')}.`);
  return value as T;
}

function optional(raw: string | undefined, fallback: string): string {
  return hasValue(raw) ? raw.trim() : fallback;
}

function hasValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
