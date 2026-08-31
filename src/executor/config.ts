import { isProxy } from 'node:util/types';
import { PublicKey } from '@solana/web3.js';

interface ExecutorCommonConfig {
  readonly databaseUrl: string;
  readonly pollMs: number;
  readonly leaseMs: number;
  readonly databaseStatementTimeoutMs: number;
  readonly shutdownGraceMs: number;
}

export interface DryRunExecutorConfig extends ExecutorCommonConfig {
  readonly mode: 'dry-run';
}

export interface SimulationOnlyExecutorConfig extends ExecutorCommonConfig {
  readonly mode: 'simulation-only';
  readonly executorPublicKey: string;
  readonly providerId: string;
  readonly httpRpcUrl: string;
  readonly expectedGenesisHash: string;
  readonly quoteMaxAgeMs: number;
  readonly slippageBps: bigint;
  readonly snapshotMaxSlotLag: number;
  readonly maxComputeUnits: bigint;
  readonly maxFeeLamports: bigint;
  readonly maxFeePayerLamportDebit: bigint;
  readonly maxPriorityFeeLamports: 0n;
  readonly rpcTimeoutMs: number;
  readonly maxRpcCallsPerAttempt: number;
  readonly quoteMintAllowlist: readonly [string];
}

export type ExecutorConfig = DryRunExecutorConfig | SimulationOnlyExecutorConfig;

export class ExecutorConfigError extends Error {
  public readonly code = 'INVALID_EXECUTOR_CONFIG' as const;

  public constructor() {
    super('Invalid executor configuration.');
    this.name = 'ExecutorConfigError';
  }
}

const SECRET_KEYS = Object.freeze([
  'EXECUTOR_PRIVATE_KEY',
  'EXECUTOR_SECRET_KEY',
  'EXECUTOR_KEYPAIR',
  'EXECUTOR_KEYPAIR_PATH',
  'SOLANA_PRIVATE_KEY',
  'SOLANA_PRIVATE_KEY_BASE58',
  'SOLANA_SECRET_KEY',
  'SOLANA_KEYPAIR',
  'SOLANA_KEYPAIR_PATH',
  'WALLET_PRIVATE_KEY',
  'WALLET_KEYPAIR',
  'WALLET_KEYPAIR_PATH',
  'ANCHOR_WALLET',
] as const);
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const QUOTE_MINT_ALLOWLIST = Object.freeze<[string]>([WSOL_MINT]);
const RPC_LEASE_SAFETY_MARGIN_MS = 1_000;

export function parseExecutorConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ExecutorConfig {
  try {
    if (!isPlainEnvironment(environment)) throw invalid();
    for (const key of SECRET_KEYS) {
      const value = environmentValue(environment, key);
      if (value !== undefined && value.length > 0) throw invalid();
    }
    const mode = environmentValue(environment, 'EXECUTOR_MODE') ?? 'dry-run';
    const liveTradingEnabled = environmentValue(environment, 'LIVE_TRADING_ENABLED');
    const databaseUrl = environmentValue(environment, 'DATABASE_URL');
    if ((mode !== 'dry-run' && mode !== 'simulation-only')
      || (liveTradingEnabled !== undefined && liveTradingEnabled !== 'false')) {
      throw invalid();
    }
    if (databaseUrl === undefined || databaseUrl.trim().length === 0) throw invalid();

    const pollMs = duration(environment, 'EXECUTOR_POLL_MS', 1_000, 100, 60_000);
    const leaseMs = duration(environment, 'EXECUTOR_LEASE_MS', 30_000, 3_000, 300_000);
    const databaseStatementTimeoutMs = duration(
      environment, 'EXECUTOR_DB_STATEMENT_TIMEOUT_MS', 3_000, 100, 10_000,
    );
    const shutdownGraceMs = duration(
      environment, 'EXECUTOR_SHUTDOWN_GRACE_MS', 10_000, 1_000, 60_000,
    );
    if (pollMs >= leaseMs
      || databaseStatementTimeoutMs * 3 > leaseMs
      || databaseStatementTimeoutMs + 1_000 > shutdownGraceMs) throw invalid();

    const common = {
      databaseUrl, pollMs, leaseMs, databaseStatementTimeoutMs, shutdownGraceMs,
    } as const;
    if (mode === 'dry-run') return Object.freeze({ mode: 'dry-run', ...common });

    const executorPublicKey = publicKey(environmentValue(environment, 'EXECUTOR_PUBLIC_KEY'));
    const providerId = positionalProviderId(
      environmentValue(environment, 'EXECUTOR_RPC_PROVIDER_ID') ?? 'primary',
    );
    const httpRpcUrl = httpUrl(environmentValue(environment, 'SOLANA_HTTP_RPC_URL'));
    const expectedGenesisHash = publicKey(
      environmentValue(environment, 'SOLANA_EXPECTED_GENESIS_HASH'),
    );
    const quoteMaxAgeMs = integer(
      environment, 'EXECUTOR_QUOTE_MAX_AGE_MS', '3000', 1, 60_000,
    );
    const slippageBps = bigint(
      environment, 'EXECUTOR_SLIPPAGE_BPS', '500', 0n, 10_000n,
    );
    const snapshotMaxSlotLag = integer(
      environment, 'EXECUTOR_SNAPSHOT_MAX_SLOT_LAG', '8', 0, 128,
    );
    const maxComputeUnits = bigint(
      environment, 'EXECUTOR_MAX_COMPUTE_UNITS', '300000', 1n, 1_400_000n,
    );
    const maxFeeLamports = bigint(
      environment, 'EXECUTOR_MAX_FEE_LAMPORTS', '100000', 0n, 10_000_000n,
    );
    const maxFeePayerLamportDebit = bigint(
      environment, 'EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT', '2500000', 0n, 10_000_000_000n,
    );
    void bigint(
      environment, 'EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS', '0', 0n, 0n,
    );
    const maxPriorityFeeLamports = 0n;
    const rpcTimeoutMs = integer(
      environment, 'EXECUTOR_RPC_TIMEOUT_MS', '5000', 1, 60_000,
    );
    if (rpcTimeoutMs * 3 + databaseStatementTimeoutMs + RPC_LEASE_SAFETY_MARGIN_MS
      > leaseMs) throw invalid();
    const maxRpcCallsPerAttempt = integer(
      environment, 'EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT', '8', 6, 16,
    );
    const allowlist = environmentValue(environment, 'LIVE_QUOTE_MINT_ALLOWLIST') ?? WSOL_MINT;
    if (allowlist !== WSOL_MINT) throw invalid();
    return Object.freeze({
      mode: 'simulation-only', ...common, executorPublicKey, providerId, httpRpcUrl,
      expectedGenesisHash, quoteMaxAgeMs, slippageBps, snapshotMaxSlotLag,
      maxComputeUnits, maxFeeLamports, maxFeePayerLamportDebit,
      maxPriorityFeeLamports, rpcTimeoutMs, maxRpcCallsPerAttempt,
      quoteMintAllowlist: QUOTE_MINT_ALLOWLIST,
    });
  } catch {
    throw invalid();
  }
}

function integer(
  environment: Record<string, string | undefined>,
  key: string,
  defaultValue: string,
  minimum: number,
  maximum: number,
): number {
  const encoded = canonicalDecimal(environmentValue(environment, key) ?? defaultValue);
  const parsed = Number(encoded);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw invalid();
  return parsed;
}

function bigint(
  environment: Record<string, string | undefined>,
  key: string,
  defaultValue: string,
  minimum: bigint,
  maximum: bigint,
): bigint {
  const parsed = BigInt(canonicalDecimal(environmentValue(environment, key) ?? defaultValue));
  if (parsed < minimum || parsed > maximum) throw invalid();
  return parsed;
}

function canonicalDecimal(value: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw invalid();
  return value;
}

function boundedText(value: string | undefined, maximumBytes: number): string {
  if (value === undefined || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximumBytes) throw invalid();
  return value;
}

function publicKey(value: string | undefined): string {
  const encoded = boundedText(value, 64);
  const decoded = new PublicKey(encoded);
  if (decoded.toBase58() !== encoded) throw invalid();
  return encoded;
}

function positionalProviderId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) throw invalid();
  return value;
}

function httpUrl(value: string | undefined): string {
  const encoded = boundedText(value, 4_096);
  const parsed = new URL(encoded);
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || encoded.trim() !== encoded || parsed.hash.length > 0) throw invalid();
  return encoded;
}

function duration(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  key: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = environmentValue(environment, key);
  if (value === undefined) return defaultValue;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw invalid();
  return parsed;
}

function isPlainEnvironment(value: unknown): value is Record<string, string | undefined> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isProxy(value);
}

function environmentValue(
  environment: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(environment, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) throw invalid();
  if (descriptor.value !== undefined && typeof descriptor.value !== 'string') throw invalid();
  return descriptor.value as string | undefined;
}

function invalid(): ExecutorConfigError {
  return new ExecutorConfigError();
}
