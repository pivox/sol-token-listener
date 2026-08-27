import 'dotenv/config';
import { isIP } from 'node:net';
import { MAX_API_PAGE_LIMIT } from '../ports/api-projection-repository.js';

const DEFAULT_WSOL_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_RAYDIUM_CPMM_PROGRAM_ID = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const MAX_RECONCILE_SECONDS = 2_147_483;

export type ExecutionMode = 'observe' | 'paper';
export type QualificationRuleSetStatus = 'UNVALIDATED_RULE_SET';
export type PaperStrategyId = 'validated-external-buys' | 'creation-entry-v1';
export type PaperMinimumConfirmation = 'confirmed' | 'finalized';
export type ListenerCatchUpPolicy = 'live-edge' | 'strict';

export interface AppConfig {
  readonly cluster: string;
  readonly httpRpcUrl: string;
  readonly httpRpcFallbackUrls: readonly string[];
  readonly wsRpcUrl: string;
  readonly wsRpcFallbackUrls: readonly string[];
  readonly commitment: 'processed' | 'confirmed' | 'finalized';
  readonly finality: 'confirmed' | 'finalized';
  readonly databaseUrl: string;
  readonly autoMigrate: boolean;
  readonly executionMode: ExecutionMode;
  readonly paperQuoteMintAllowlist: readonly string[];
  readonly paperStrategyEnabled: boolean;
  readonly creationStrategyEnabled: boolean;
  readonly paperStrategyId: PaperStrategyId;
  readonly paperStrategyVersion: 1;
  readonly paperEntryQuoteAmountRaw: bigint | null;
  readonly paperExternalBuyTarget: number;
  readonly paperMinimumConfirmation: PaperMinimumConfirmation;
  readonly paperEntryWindowSeconds: number;
  readonly paperQuoteMaxAgeMs: number;
  readonly paperQuoteMaxSlotLag: number;
  readonly paperSlippageBps: bigint | null;
  readonly paperDecisionWorkerPollMs: number;
  readonly paperDecisionWorkerLeaseSeconds: number;
  readonly paperDecisionRetryMaxAttempts: number;
  readonly paperDecisionRetryBaseDelayMs: number;
  readonly creationEntryMaxAgeMs: number;
  readonly creationEntryMaxSlotLag: number;
  readonly externalMinimumBuyAmountRaw: bigint | null;
  readonly creationTakeProfitMultiplierBps: bigint;
  readonly creationManualKillSwitch: boolean;
  readonly qualificationProfilePath: string | null;
  readonly qualificationRuleSetStatus: QualificationRuleSetStatus;
  readonly qualificationMinimumScore: number | null;
  readonly dataRetentionHours: number;
  readonly listenerEnabled: boolean;
  readonly listenerWorkerLeaseSeconds: number;
  readonly listenerCatchUpPolicy: ListenerCatchUpPolicy;
  readonly listenerCatchUpMaxPages: number;
  readonly listenerCatchUpPageSize: number;
  readonly listenerFinalityMissingPolls: number;
  readonly listenerShutdownTimeoutMs: number;
  readonly socialHttpTimeoutMs: number;
  readonly socialHttpMaxBytes: number;
  readonly socialHttpMaxRedirects: number;
  readonly socialHttpConcurrency: number;
  readonly socialWorkerPollMs: number;
  readonly socialWorkerLeaseSeconds: number;
  readonly socialRetryMaxAttempts: number;
  readonly socialRetryBaseDelayMs: number;
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
  readonly apiEnabled: boolean;
  readonly apiHost: string;
  readonly apiPort: number;
  readonly apiPageLimitDefault: number;
  readonly apiPageLimitMaximum: number;
  readonly apiHolderPositionLimit: number;
  readonly apiHolderSnapshotLimit: number;
  readonly apiWalletClusterLimit: number;
  readonly apiWalletClusterMemberLimit: number;
  readonly apiWalletClusterTotalMemberLimit: number;
  readonly apiSseHeartbeatMs: number;
  readonly apiSsePollMs: number;
  readonly logLevel: string;
}

export interface TransactionInboxRetryPolicyConfig {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
}

interface PaperStrategyConfig {
  readonly paperStrategyEnabled: boolean;
  readonly creationStrategyEnabled: boolean;
  readonly paperStrategyId: PaperStrategyId;
  readonly paperStrategyVersion: 1;
  readonly paperEntryQuoteAmountRaw: bigint | null;
  readonly paperExternalBuyTarget: number;
  readonly paperMinimumConfirmation: PaperMinimumConfirmation;
  readonly paperEntryWindowSeconds: number;
  readonly paperQuoteMaxAgeMs: number;
  readonly paperQuoteMaxSlotLag: number;
  readonly paperSlippageBps: bigint | null;
  readonly paperDecisionWorkerPollMs: number;
  readonly paperDecisionWorkerLeaseSeconds: number;
  readonly paperDecisionRetryMaxAttempts: number;
  readonly paperDecisionRetryBaseDelayMs: number;
  readonly creationEntryMaxAgeMs: number;
  readonly creationEntryMaxSlotLag: number;
  readonly externalMinimumBuyAmountRaw: bigint | null;
  readonly creationTakeProfitMultiplierBps: bigint;
  readonly creationManualKillSwitch: boolean;
}

export function parseTransactionInboxRetryPolicy(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): TransactionInboxRetryPolicyConfig {
  return Object.freeze({
    maxAttempts: parseInteger(
      environment.RPC_RETRY_MAX_ATTEMPTS, 5, 'RPC_RETRY_MAX_ATTEMPTS', 1, 100,
    ),
    baseDelayMs: parseInteger(
      environment.RPC_RETRY_BASE_DELAY_MS, 500, 'RPC_RETRY_BASE_DELAY_MS', 1, 60_000,
    ),
  });
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
  const apiPageLimitMaximum = parseInteger(
    environment.API_PAGE_LIMIT_MAX, 200, 'API_PAGE_LIMIT_MAX', 1, MAX_API_PAGE_LIMIT,
  );
  const apiPageLimitDefault = parseInteger(
    environment.API_PAGE_LIMIT_DEFAULT, 50, 'API_PAGE_LIMIT_DEFAULT', 1, apiPageLimitMaximum,
  );
  const transactionInboxRetryPolicy = parseTransactionInboxRetryPolicy(environment);
  const qualificationProfilePath = parseQualificationProfilePath(environment.QUALIFICATION_PROFILE_PATH);
  const riskMaxRoundTripLossBps = parseInteger(
    environment.RISK_MAX_ROUNDTRIP_LOSS_BPS,
    3_000,
    'RISK_MAX_ROUNDTRIP_LOSS_BPS',
    0,
    10_000,
  );
  const paperStrategyConfig = parsePaperStrategyConfig(
    environment,
    executionMode,
    qualificationProfilePath,
  );
  const httpRpcUrl = requiredUrl(environment.SOLANA_HTTP_RPC_URL, 'SOLANA_HTTP_RPC_URL', ['http:', 'https:']);
  const httpRpcFallbackUrls = parseHttpRpcFallbackUrls(
    environment.SOLANA_HTTP_RPC_FALLBACK_URLS,
    httpRpcUrl,
  );
  const wsRpcUrl = requiredUrl(environment.SOLANA_WS_RPC_URL, 'SOLANA_WS_RPC_URL', ['ws:', 'wss:']);
  const wsRpcFallbackUrls = parseWsRpcFallbackUrls(
    environment.SOLANA_WS_RPC_FALLBACK_URLS,
    wsRpcUrl,
  );
  assertPairedRpcEndpoints(httpRpcUrl, httpRpcFallbackUrls, wsRpcUrl, wsRpcFallbackUrls);

  return {
    cluster: optional(environment.SOLANA_CLUSTER, 'mainnet-beta'),
    httpRpcUrl,
    httpRpcFallbackUrls,
    wsRpcUrl,
    wsRpcFallbackUrls,
    commitment: parseEnum(environment.SOLANA_COMMITMENT, 'confirmed', ['processed', 'confirmed', 'finalized']),
    finality: parseEnum(environment.SOLANA_FINALITY_COMMITMENT, 'finalized', ['confirmed', 'finalized']),
    databaseUrl: optional(environment.DATABASE_URL, 'postgresql://solanabot:solanabot@127.0.0.1:5432/solanabot'),
    autoMigrate: parseBoolean(environment.POSTGRES_AUTO_MIGRATE, false, 'POSTGRES_AUTO_MIGRATE'),
    executionMode,
    paperQuoteMintAllowlist,
    ...paperStrategyConfig,
    qualificationProfilePath,
    qualificationRuleSetStatus: parseQualificationRuleSetStatus(environment.QUALIFICATION_RULE_SET_STATUS),
    qualificationMinimumScore: parseOptionalInteger(
      environment.QUALIFICATION_MIN_SCORE,
      null,
      'QUALIFICATION_MIN_SCORE',
      0,
      100,
    ),
    dataRetentionHours: parseInteger(environment.DATA_RETENTION_HOURS, 4, 'DATA_RETENTION_HOURS', 1, 168),
    listenerEnabled: parseBoolean(environment.LISTENER_ENABLED, true, 'LISTENER_ENABLED'),
    listenerWorkerLeaseSeconds: parseInteger(
      environment.LISTENER_WORKER_LEASE_SECONDS, 120, 'LISTENER_WORKER_LEASE_SECONDS', 30, 900,
    ),
    listenerCatchUpPolicy: parseClosedLiteral(
      environment.LISTENER_CATCH_UP_POLICY,
      'live-edge',
      'LISTENER_CATCH_UP_POLICY',
      ['live-edge', 'strict'],
    ),
    listenerCatchUpMaxPages: parseInteger(
      environment.LISTENER_CATCH_UP_MAX_PAGES, 20, 'LISTENER_CATCH_UP_MAX_PAGES', 1, 100,
    ),
    listenerCatchUpPageSize: parseInteger(
      environment.LISTENER_CATCH_UP_PAGE_SIZE, 100, 'LISTENER_CATCH_UP_PAGE_SIZE', 1, 1_000,
    ),
    listenerFinalityMissingPolls: parseInteger(
      environment.LISTENER_FINALITY_MISSING_POLLS, 3, 'LISTENER_FINALITY_MISSING_POLLS', 2, 20,
    ),
    listenerShutdownTimeoutMs: parseInteger(
      environment.LISTENER_SHUTDOWN_TIMEOUT_MS, 30_000, 'LISTENER_SHUTDOWN_TIMEOUT_MS', 1_000, 120_000,
    ),
    socialHttpTimeoutMs: parseCanonicalBoundedInteger(
      environment.SOCIAL_HTTP_TIMEOUT_MS, 5_000, 'SOCIAL_HTTP_TIMEOUT_MS', 100, 30_000,
    ),
    socialHttpMaxBytes: parseCanonicalBoundedInteger(
      environment.SOCIAL_HTTP_MAX_BYTES, 262_144, 'SOCIAL_HTTP_MAX_BYTES', 1_024, 1_048_576,
    ),
    socialHttpMaxRedirects: parseCanonicalBoundedInteger(
      environment.SOCIAL_HTTP_MAX_REDIRECTS, 3, 'SOCIAL_HTTP_MAX_REDIRECTS', 0, 10,
    ),
    socialHttpConcurrency: parseCanonicalBoundedInteger(
      environment.SOCIAL_HTTP_CONCURRENCY, 2, 'SOCIAL_HTTP_CONCURRENCY', 1, 8,
    ),
    socialWorkerPollMs: parseCanonicalBoundedInteger(
      environment.SOCIAL_WORKER_POLL_MS, 1_000, 'SOCIAL_WORKER_POLL_MS', 100, 60_000,
    ),
    socialWorkerLeaseSeconds: parseCanonicalBoundedInteger(
      environment.SOCIAL_WORKER_LEASE_SECONDS, 30, 'SOCIAL_WORKER_LEASE_SECONDS', 5, 300,
    ),
    socialRetryMaxAttempts: parseCanonicalBoundedInteger(
      environment.SOCIAL_RETRY_MAX_ATTEMPTS, 3, 'SOCIAL_RETRY_MAX_ATTEMPTS', 1, 10,
    ),
    socialRetryBaseDelayMs: parseCanonicalBoundedInteger(
      environment.SOCIAL_RETRY_BASE_DELAY_MS, 1_000, 'SOCIAL_RETRY_BASE_DELAY_MS', 100, 60_000,
    ),
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
    reconcileSeconds: parseInteger(
      environment.RECONCILE_SECONDS,
      15,
      'RECONCILE_SECONDS',
      1,
      MAX_RECONCILE_SECONDS,
    ),
    rpcRetryMaxAttempts: transactionInboxRetryPolicy.maxAttempts,
    rpcRetryBaseDelayMs: transactionInboxRetryPolicy.baseDelayMs,
    minWsolLiquidityLamports: parseSolToLamports(environment.MIN_WSOL_LIQUIDITY, '0.25', 'MIN_WSOL_LIQUIDITY'),
    riskMinScore: parseInteger(environment.RISK_MIN_SCORE, 80, 'RISK_MIN_SCORE', 0, 100),
    riskAllowUnknownReviews: parseBoolean(environment.RISK_ALLOW_UNKNOWN_REVIEWS, false, 'RISK_ALLOW_UNKNOWN_REVIEWS'),
    riskAllowUnknownMinScore: parseInteger(environment.RISK_ALLOW_UNKNOWN_MIN_SCORE, 95, 'RISK_ALLOW_UNKNOWN_MIN_SCORE', 0, 100),
    riskMaxTransferFeeBps: parseInteger(environment.RISK_MAX_TRANSFER_FEE_BPS, 1_500, 'RISK_MAX_TRANSFER_FEE_BPS', 0, 10_000),
    riskMaxBuyPriceImpactBps: parseOptionalInteger(environment.RISK_MAX_BUY_PRICE_IMPACT_BPS, null, 'RISK_MAX_BUY_PRICE_IMPACT_BPS', 0, 10_000),
    riskMaxSellPriceImpactBps: parseOptionalInteger(environment.RISK_MAX_SELL_PRICE_IMPACT_BPS, null, 'RISK_MAX_SELL_PRICE_IMPACT_BPS', 0, 10_000),
    riskMaxRoundTripLossBps,
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
    apiEnabled: parseBoolean(environment.API_ENABLED, true, 'API_ENABLED'),
    apiHost: parseApiHost(environment.API_HOST),
    apiPort: parseInteger(environment.API_PORT, 3_000, 'API_PORT', 1, 65_535),
    apiPageLimitDefault,
    apiPageLimitMaximum,
    apiHolderPositionLimit: parseInteger(
      environment.API_HOLDER_POSITION_LIMIT, 100, 'API_HOLDER_POSITION_LIMIT', 1, 500,
    ),
    apiHolderSnapshotLimit: parseInteger(
      environment.API_HOLDER_SNAPSHOT_LIMIT, 100, 'API_HOLDER_SNAPSHOT_LIMIT', 1, 500,
    ),
    apiWalletClusterLimit: parseInteger(
      environment.API_WALLET_CLUSTER_LIMIT, 50, 'API_WALLET_CLUSTER_LIMIT', 1, 100,
    ),
    apiWalletClusterMemberLimit: parseInteger(
      environment.API_WALLET_CLUSTER_MEMBER_LIMIT,
      50,
      'API_WALLET_CLUSTER_MEMBER_LIMIT',
      1,
      100,
    ),
    apiWalletClusterTotalMemberLimit: parseInteger(
      environment.API_WALLET_CLUSTER_TOTAL_MEMBER_LIMIT,
      500,
      'API_WALLET_CLUSTER_TOTAL_MEMBER_LIMIT',
      1,
      1_000,
    ),
    apiSseHeartbeatMs: parseInteger(
      environment.API_SSE_HEARTBEAT_MS, 15_000, 'API_SSE_HEARTBEAT_MS', 1_000, 60_000,
    ),
    apiSsePollMs: parseInteger(environment.API_SSE_POLL_MS, 1_000, 'API_SSE_POLL_MS', 100, 10_000),
    logLevel: optional(environment.LOG_LEVEL, 'info'),
  };
}

function parsePaperStrategyConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  executionMode: ExecutionMode,
  qualificationProfilePath: string | null,
): PaperStrategyConfig {
  const legacyPaperStrategyEnabled = parseBoolean(
    environment.PAPER_STRATEGY_ENABLED,
    false,
    'PAPER_STRATEGY_ENABLED',
  );
  const creationStrategyEnabled = parseBoolean(
    environment.CREATION_STRATEGY_ENABLED,
    false,
    'CREATION_STRATEGY_ENABLED',
  );
  if (legacyPaperStrategyEnabled && creationStrategyEnabled) {
    throw new Error('Paper strategy flags cannot be enabled simultaneously.');
  }
  const legacyPaperStrategyId = parseClosedLiteral(
    environment.PAPER_STRATEGY_ID,
    'validated-external-buys',
    'PAPER_STRATEGY_ID',
    ['validated-external-buys'],
  );
  const paperStrategyId: PaperStrategyId = creationStrategyEnabled
    ? 'creation-entry-v1'
    : legacyPaperStrategyId;
  const paperStrategyEnabled = legacyPaperStrategyEnabled || creationStrategyEnabled;
  const paperStrategyVersion = parseClosedIntegerLiteral(
    environment.PAPER_STRATEGY_VERSION,
    1,
    'PAPER_STRATEGY_VERSION',
  );
  const paperExternalBuyTarget = creationStrategyEnabled
    ? parseCanonicalBoundedInteger(
      environment.EXTERNAL_UNIQUE_BUYERS_TARGET,
      10,
      'EXTERNAL_UNIQUE_BUYERS_TARGET',
      1,
      1_000,
    )
    : parseCanonicalBoundedInteger(
      environment.PAPER_EXTERNAL_BUY_TARGET, 10, 'PAPER_EXTERNAL_BUY_TARGET', 1, 1_000,
    );
  const paperMinimumConfirmation = parseClosedLiteral(
    environment.PAPER_MINIMUM_CONFIRMATION,
    'confirmed',
    'PAPER_MINIMUM_CONFIRMATION',
    ['confirmed', 'finalized'],
  );
  const paperEntryWindowSeconds = parseCanonicalBoundedInteger(
    environment.PAPER_ENTRY_WINDOW_SECONDS, 45, 'PAPER_ENTRY_WINDOW_SECONDS', 1, 3_600,
  );
  const paperQuoteMaxAgeMs = parseCanonicalBoundedInteger(
    environment.PAPER_QUOTE_MAX_AGE_MS, 5_000, 'PAPER_QUOTE_MAX_AGE_MS', 100, 60_000,
  );
  const paperQuoteMaxSlotLag = parseCanonicalBoundedInteger(
    environment.PAPER_QUOTE_MAX_SLOT_LAG, 32, 'PAPER_QUOTE_MAX_SLOT_LAG', 0, 10_000,
  );
  const paperDecisionWorkerPollMs = parseCanonicalBoundedInteger(
    environment.PAPER_DECISION_WORKER_POLL_MS, 1_000, 'PAPER_DECISION_WORKER_POLL_MS', 100, 60_000,
  );
  const paperDecisionWorkerLeaseSeconds = parseCanonicalBoundedInteger(
    environment.PAPER_DECISION_WORKER_LEASE_SECONDS, 30, 'PAPER_DECISION_WORKER_LEASE_SECONDS', 5, 900,
  );
  const paperDecisionRetryMaxAttempts = parseCanonicalBoundedInteger(
    environment.PAPER_DECISION_RETRY_MAX_ATTEMPTS, 5, 'PAPER_DECISION_RETRY_MAX_ATTEMPTS', 1, 100,
  );
  const paperDecisionRetryBaseDelayMs = parseCanonicalBoundedInteger(
    environment.PAPER_DECISION_RETRY_BASE_DELAY_MS, 500, 'PAPER_DECISION_RETRY_BASE_DELAY_MS', 100, 60_000,
  );
  const creationEntryMaxAgeMs = parseCanonicalBoundedInteger(
    environment.CREATION_ENTRY_MAX_AGE_MS,
    45_000,
    'CREATION_ENTRY_MAX_AGE_MS',
    100,
    3_600_000,
  );
  const creationEntryMaxSlotLag = parseCanonicalBoundedInteger(
    environment.CREATION_ENTRY_MAX_SLOT_LAG,
    32,
    'CREATION_ENTRY_MAX_SLOT_LAG',
    0,
    10_000,
  );
  const configuredMinimumBuyAmountRaw = parseCanonicalBigInt(
    environment.EXTERNAL_MIN_BUY_AMOUNT_RAW,
    'EXTERNAL_MIN_BUY_AMOUNT_RAW',
  );
  const creationTakeProfitMultiplierBps = BigInt(parseCanonicalBoundedInteger(
    environment.CREATION_TAKE_PROFIT_MULTIPLIER_BPS,
    20_000,
    'CREATION_TAKE_PROFIT_MULTIPLIER_BPS',
    10_000,
    1_000_000,
  ));
  const creationManualKillSwitch = parseBoolean(
    environment.CREATION_MANUAL_KILL_SWITCH,
    false,
    'CREATION_MANUAL_KILL_SWITCH',
  );

  if (!paperStrategyEnabled) {
    return {
      paperStrategyEnabled,
      creationStrategyEnabled,
      paperStrategyId,
      paperStrategyVersion,
      paperEntryQuoteAmountRaw: null,
      paperExternalBuyTarget,
      paperMinimumConfirmation,
      paperEntryWindowSeconds,
      paperQuoteMaxAgeMs,
      paperQuoteMaxSlotLag,
      paperSlippageBps: null,
      paperDecisionWorkerPollMs,
      paperDecisionWorkerLeaseSeconds,
      paperDecisionRetryMaxAttempts,
      paperDecisionRetryBaseDelayMs,
      creationEntryMaxAgeMs,
      creationEntryMaxSlotLag,
      externalMinimumBuyAmountRaw: null,
      creationTakeProfitMultiplierBps,
      creationManualKillSwitch,
    };
  }

  if (executionMode !== 'paper') {
    const flag = creationStrategyEnabled ? 'CREATION_STRATEGY_ENABLED' : 'PAPER_STRATEGY_ENABLED';
    throw new Error(`${flag} requires EXECUTION_MODE=paper.`);
  }
  if (qualificationProfilePath === null) {
    throw new Error('PAPER_STRATEGY_ENABLED requires an explicit QUALIFICATION_PROFILE_PATH.');
  }
  if (!hasValue(environment.RISK_MAX_ROUNDTRIP_LOSS_BPS)) {
    throw new Error('PAPER_STRATEGY_ENABLED requires an explicit RISK_MAX_ROUNDTRIP_LOSS_BPS.');
  }

  const paperEntryQuoteAmountRaw = parseCanonicalBigInt(
    environment.PAPER_ENTRY_QUOTE_AMOUNT_RAW,
    'PAPER_ENTRY_QUOTE_AMOUNT_RAW',
  );
  if (paperEntryQuoteAmountRaw === null || paperEntryQuoteAmountRaw === 0n) {
    throw new Error('PAPER_ENTRY_QUOTE_AMOUNT_RAW must be explicitly configured above zero.');
  }
  const slippage = parseCanonicalBoundedInteger(
    environment.PAPER_SLIPPAGE_BPS,
    -1,
    'PAPER_SLIPPAGE_BPS',
    0,
    10_000,
  );
  if (slippage < 0) {
    throw new Error('PAPER_SLIPPAGE_BPS must be explicitly configured.');
  }
  if (
    creationStrategyEnabled
    && (configuredMinimumBuyAmountRaw === null || configuredMinimumBuyAmountRaw === 0n)
  ) {
    throw new Error('EXTERNAL_MIN_BUY_AMOUNT_RAW must be explicitly configured above zero.');
  }

  return {
    paperStrategyEnabled,
    creationStrategyEnabled,
    paperStrategyId,
    paperStrategyVersion,
    paperEntryQuoteAmountRaw,
    paperExternalBuyTarget,
    paperMinimumConfirmation,
    paperEntryWindowSeconds,
    paperQuoteMaxAgeMs,
    paperQuoteMaxSlotLag,
    paperSlippageBps: BigInt(slippage),
    paperDecisionWorkerPollMs,
    paperDecisionWorkerLeaseSeconds,
    paperDecisionRetryMaxAttempts,
    paperDecisionRetryBaseDelayMs,
    creationEntryMaxAgeMs,
    creationEntryMaxSlotLag,
    externalMinimumBuyAmountRaw: creationStrategyEnabled ? configuredMinimumBuyAmountRaw : null,
    creationTakeProfitMultiplierBps,
    creationManualKillSwitch,
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

function parseClosedLiteral<const T extends string>(
  raw: string | undefined,
  fallback: T,
  name: string,
  values: readonly T[],
): T {
  if (raw === undefined || raw === '') return fallback;
  if (!values.includes(raw as T)) throw new Error(`${name} has an unsupported value.`);
  return raw as T;
}

function parseClosedIntegerLiteral<const T extends number>(
  raw: string | undefined,
  value: T,
  name: string,
): T {
  if (raw === undefined || raw === '') return value;
  if (raw !== String(value)) throw new Error(`${name} must be ${String(value)}.`);
  return value;
}

function parseQualificationProfilePath(raw: string | undefined): string | null {
  if (raw === undefined || raw.length === 0) return null;
  if (
    raw !== raw.trim()
    || Buffer.byteLength(raw, 'utf8') > 4_096
    || raw.includes('\0')
  ) throw new Error('QUALIFICATION_PROFILE_PATH must be a non-empty safe local path of at most 4096 bytes.');
  return raw;
}

function parseQualificationRuleSetStatus(raw: string | undefined): QualificationRuleSetStatus {
  if (raw === undefined || raw.length === 0) return 'UNVALIDATED_RULE_SET';
  if (raw !== 'UNVALIDATED_RULE_SET') {
    throw new Error('QUALIFICATION_RULE_SET_STATUS must be UNVALIDATED_RULE_SET.');
  }
  return raw;
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

function parseCanonicalBigInt(raw: string | undefined, name: string): bigint | null {
  if (raw === undefined || raw === '') return null;
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) {
    throw new Error(`${name} must be a canonical non-negative integer.`);
  }
  const value = BigInt(raw);
  if (value > 18_446_744_073_709_551_615n) {
    throw new Error(`${name} is outside its allowed range.`);
  }
  return value;
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

export function parseCanonicalBoundedInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) {
    throw new Error(`${name} must be a canonical decimal integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside its allowed range.`);
  }
  return value;
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

function parseApiHost(raw: string | undefined): string {
  if (raw === undefined) return '127.0.0.1';
  if (
    raw.length === 0
    || raw !== raw.trim()
    || /[\s\u007F]/u.test(raw)
    || hasControlCharacter(raw)
    || raw.includes('://')
    || raw.includes('/')
    || raw.includes('\\')
    || (!isSafeHostname(raw) && isIP(raw) === 0)
  ) {
    throw new Error('API_HOST must be a safe hostname or IP address.');
  }
  return raw;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint <= 31) return true;
  }
  return false;
}

function isSafeHostname(value: string): boolean {
  if (value.length > 253 || value.endsWith('.')) return false;
  return value.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label));
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

function parseHttpRpcFallbackUrls(raw: string | undefined, primaryUrl: string): readonly string[] {
  if (!hasValue(raw)) return Object.freeze([]);

  const entries = raw.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    throw new Error('SOLANA_HTTP_RPC_FALLBACK_URLS must not contain empty endpoints.');
  }
  if (entries.length > 3) {
    throw new Error('SOLANA_HTTP_RPC_FALLBACK_URLS supports at most 3 fallback endpoints.');
  }

  const primary = new URL(primaryUrl);
  if (primary.href.includes('#')) {
    throw new Error('HTTP RPC endpoint URLs must not contain fragments when fallbacks are configured.');
  }
  const primaryProtocol = primary.protocol;
  const canonicalUrls: string[] = [];
  for (const entry of entries) {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error('SOLANA_HTTP_RPC_FALLBACK_URLS must contain valid absolute HTTP(S) URLs.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('SOLANA_HTTP_RPC_FALLBACK_URLS must contain valid absolute HTTP(S) URLs.');
    }
    if (parsed.href.includes('#')) {
      throw new Error('HTTP RPC endpoint URLs must not contain fragments when fallbacks are configured.');
    }
    if (parsed.protocol !== primaryProtocol) {
      throw new Error('SOLANA_HTTP_RPC_FALLBACK_URLS must use the same scheme as SOLANA_HTTP_RPC_URL.');
    }
    const canonicalUrl = parsed.toString();
    if (canonicalUrl === primaryUrl || canonicalUrls.includes(canonicalUrl)) {
      throw new Error('SOLANA_HTTP_RPC_FALLBACK_URLS must not contain duplicate endpoints.');
    }
    canonicalUrls.push(canonicalUrl);
  }
  return Object.freeze(canonicalUrls);
}

function parseWsRpcFallbackUrls(raw: string | undefined, primaryUrl: string): readonly string[] {
  if (!hasValue(raw)) return Object.freeze([]);

  const entries = raw.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    throw new Error('SOLANA_WS_RPC_FALLBACK_URLS must not contain empty endpoints.');
  }
  if (entries.length > 3) {
    throw new Error('SOLANA_WS_RPC_FALLBACK_URLS supports at most 3 fallback endpoints.');
  }

  const primary = new URL(primaryUrl);
  if (primary.href.includes('#')) {
    throw new Error('WebSocket RPC endpoint URLs must not contain fragments when fallbacks are configured.');
  }
  const primaryProtocol = primary.protocol;
  const canonicalUrls: string[] = [];
  for (const entry of entries) {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error('SOLANA_WS_RPC_FALLBACK_URLS must contain valid absolute WS(S) URLs.');
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new Error('SOLANA_WS_RPC_FALLBACK_URLS must contain valid absolute WS(S) URLs.');
    }
    if (parsed.href.includes('#')) {
      throw new Error('WebSocket RPC endpoint URLs must not contain fragments when fallbacks are configured.');
    }
    if (parsed.protocol !== primaryProtocol) {
      throw new Error('SOLANA_WS_RPC_FALLBACK_URLS must use the same scheme as SOLANA_WS_RPC_URL.');
    }
    const canonicalUrl = parsed.toString();
    if (canonicalUrl === primaryUrl || canonicalUrls.includes(canonicalUrl)) {
      throw new Error('SOLANA_WS_RPC_FALLBACK_URLS must not contain duplicate endpoints.');
    }
    canonicalUrls.push(canonicalUrl);
  }
  return Object.freeze(canonicalUrls);
}

function assertPairedRpcEndpoints(
  httpPrimaryUrl: string,
  httpFallbackUrls: readonly string[],
  wsPrimaryUrl: string,
  wsFallbackUrls: readonly string[],
): void {
  if (wsFallbackUrls.length === 0) return;
  if (httpFallbackUrls.length !== wsFallbackUrls.length) {
    throw new Error('RPC fallback endpoint lists must be configured together with matching cardinality.');
  }
  const httpUrls = [httpPrimaryUrl, ...httpFallbackUrls];
  const wsUrls = [wsPrimaryUrl, ...wsFallbackUrls];
  if (httpFallbackUrls.length > 0 && (hasUrlFragment(httpPrimaryUrl) || hasUrlFragment(wsPrimaryUrl))) {
    throw new Error('RPC endpoint URLs must not contain fragments when fallbacks are configured.');
  }
  for (let index = 0; index < httpUrls.length; index += 1) {
    const httpUrl = httpUrls[index];
    const wsUrl = wsUrls[index];
    if (httpUrl === undefined || wsUrl === undefined || !pairedRpcProtocols(httpUrl, wsUrl)) {
      throw new Error('RPC endpoint protocols must pair https with wss or http with ws.');
    }
  }
}

function hasUrlFragment(value: string): boolean {
  return new URL(value).href.includes('#');
}

function pairedRpcProtocols(httpUrl: string, wsUrl: string): boolean {
  const httpProtocol = new URL(httpUrl).protocol;
  const wsProtocol = new URL(wsUrl).protocol;
  return (httpProtocol === 'https:' && wsProtocol === 'wss:')
    || (httpProtocol === 'http:' && wsProtocol === 'ws:');
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
