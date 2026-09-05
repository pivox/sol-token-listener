import { isAbsolute, normalize } from 'node:path';
import { isProxy } from 'node:util/types';
import { PublicKey } from '@solana/web3.js';

export interface LiveExecutorConfig {
  readonly mode: 'live';
  readonly liveTradingEnabled: true;
  readonly cluster: 'mainnet-beta';
  readonly databaseUrl: string;
  readonly pollMs: number;
  readonly leaseMs: number;
  readonly databaseStatementTimeoutMs: number;
  readonly shutdownGraceMs: number;
  readonly generationId: string;
  readonly executorPublicKey: string;
  readonly keypairPath: string;
  readonly providerId: string;
  readonly httpRpcUrl: string;
  readonly expectedGenesisHash: string;
  readonly buildHash: string;
  readonly configurationFingerprint: string;
  readonly strategyFingerprint: string;
  readonly phase: 'CANARY' | 'MICRO_LIVE' | 'PILOT';
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

export class LiveExecutorConfigError extends Error {
  public readonly code = 'INVALID_LIVE_EXECUTOR_CONFIG' as const;

  public constructor() {
    super('Invalid live executor configuration.');
    this.name = 'LiveExecutorConfigError';
  }
}

const WSOL = 'So11111111111111111111111111111111111111112';
const SECRET_KEYS = Object.freeze([
  'EXECUTOR_PRIVATE_KEY', 'EXECUTOR_SECRET_KEY', 'EXECUTOR_KEYPAIR',
  'SOLANA_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY_BASE58', 'SOLANA_SECRET_KEY',
  'SOLANA_KEYPAIR', 'SOLANA_KEYPAIR_PATH', 'WALLET_PRIVATE_KEY',
  'WALLET_KEYPAIR', 'WALLET_KEYPAIR_PATH', 'ANCHOR_WALLET',
] as const);

export function parseLiveExecutorConfig(value: unknown): LiveExecutorConfig {
  try {
    const environment = environmentFrom(value);
    for (const key of SECRET_KEYS) {
      if (Object.getOwnPropertyDescriptor(environment, key) !== undefined) reject();
    }
    if (environmentValue(environment, 'EXECUTOR_MODE') !== 'live'
      || environmentValue(environment, 'LIVE_TRADING_ENABLED') !== 'true'
      || environmentValue(environment, 'SOLANA_CLUSTER') !== 'mainnet-beta') reject();
    const pollMs = integer(environment, 'EXECUTOR_POLL_MS', 100, 60_000);
    const leaseMs = integer(environment, 'EXECUTOR_LEASE_MS', 3_000, 300_000);
    const databaseStatementTimeoutMs = integer(
      environment, 'EXECUTOR_DB_STATEMENT_TIMEOUT_MS', 100, 10_000,
    );
    const shutdownGraceMs = integer(
      environment, 'EXECUTOR_SHUTDOWN_GRACE_MS', 1_000, 60_000,
    );
    const rpcTimeoutMs = integer(environment, 'EXECUTOR_RPC_TIMEOUT_MS', 1, 60_000);
    if (pollMs >= leaseMs || databaseStatementTimeoutMs * 3 > leaseMs
      || databaseStatementTimeoutMs + 1_000 > shutdownGraceMs
      || rpcTimeoutMs * 4 + databaseStatementTimeoutMs * 6 + 1_000 > leaseMs) reject();
    void decimalBigint(environment, 'EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS', 0n, 0n);
    const allowlist = text(environment, 'LIVE_QUOTE_MINT_ALLOWLIST', 64);
    if (allowlist !== WSOL) reject();
    const activationPhase = phase(environmentValue(environment, 'EXECUTOR_ACTIVATION_PHASE'));
    if (activationPhase === 'CANARY' && leaseMs > 120_000) reject();
    return Object.freeze({
      mode: 'live',
      liveTradingEnabled: true,
      cluster: 'mainnet-beta',
      databaseUrl: text(environment, 'DATABASE_URL', 4_096),
      pollMs,
      leaseMs,
      databaseStatementTimeoutMs,
      shutdownGraceMs,
      generationId: pattern(
        environment, 'EXECUTOR_WALLET_GENERATION_ID',
        /^execution_wallet_generation_[0-9a-f]{64}$/u, 96,
      ),
      executorPublicKey: publicKey(environment, 'EXECUTOR_PUBLIC_KEY'),
      keypairPath: absolutePath(environment, 'EXECUTOR_KEYPAIR_PATH'),
      providerId: pattern(
        environment, 'EXECUTOR_RPC_PROVIDER_ID',
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u, 64,
      ),
      httpRpcUrl: httpUrl(environment, 'SOLANA_HTTP_RPC_URL'),
      expectedGenesisHash: publicKey(environment, 'SOLANA_EXPECTED_GENESIS_HASH'),
      buildHash: fingerprint(environment, 'EXECUTOR_BUILD_HASH'),
      configurationFingerprint: fingerprint(
        environment, 'EXECUTOR_CONFIGURATION_FINGERPRINT',
      ),
      strategyFingerprint: fingerprint(environment, 'EXECUTOR_STRATEGY_FINGERPRINT'),
      phase: activationPhase,
      quoteMaxAgeMs: integer(environment, 'EXECUTOR_QUOTE_MAX_AGE_MS', 1, 60_000),
      slippageBps: decimalBigint(environment, 'EXECUTOR_SLIPPAGE_BPS', 0n, 10_000n),
      snapshotMaxSlotLag: integer(
        environment, 'EXECUTOR_SNAPSHOT_MAX_SLOT_LAG', 0, 128,
      ),
      maxComputeUnits: decimalBigint(
        environment, 'EXECUTOR_MAX_COMPUTE_UNITS', 1n, 1_400_000n,
      ),
      maxFeeLamports: decimalBigint(
        environment, 'EXECUTOR_MAX_FEE_LAMPORTS', 0n, 10_000_000n,
      ),
      maxFeePayerLamportDebit: decimalBigint(
        environment, 'EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT', 0n, 10_000_000_000n,
      ),
      maxPriorityFeeLamports: 0n,
      rpcTimeoutMs,
      maxRpcCallsPerAttempt: integer(
        environment, 'EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT', 12, 16,
      ),
      quoteMintAllowlist: Object.freeze([WSOL] as const),
    });
  } catch {
    throw new LiveExecutorConfigError();
  }
}

function environmentFrom(value: unknown): Readonly<Record<string, string | undefined>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) reject();
  return value as Record<string, string | undefined>;
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(environment, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)
    || (descriptor.value !== undefined && typeof descriptor.value !== 'string')) reject();
  return descriptor.value as string | undefined;
}

function text(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
  maximumBytes: number,
): string {
  const value = environmentValue(environment, key);
  if (value === undefined || value.length === 0 || value.trim() !== value
    || Buffer.byteLength(value, 'utf8') > maximumBytes) reject();
  return value;
}

function pattern(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
  expression: RegExp,
  maximumBytes: number,
): string {
  const value = text(environment, key, maximumBytes);
  if (!expression.test(value)) reject();
  return value;
}

function fingerprint(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  return pattern(environment, key, /^[0-9a-f]{64}$/u, 64);
}

function publicKey(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = text(environment, key, 64);
  if (new PublicKey(value).toBase58() !== value) reject();
  return value;
}

function absolutePath(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = text(environment, key, 4_096);
  if (!isAbsolute(value) || normalize(value) !== value || value.includes('\0')) reject();
  return value;
}

function httpUrl(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = text(environment, key, 4_096);
  const parsed = new URL(value);
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.hash.length > 0) reject();
  return value;
}

function phase(value: string | undefined): LiveExecutorConfig['phase'] {
  if (value !== 'CANARY' && value !== 'MICRO_LIVE' && value !== 'PILOT') reject();
  return value;
}

function canonicalDecimal(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = environmentValue(environment, key);
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) reject();
  return value;
}

function integer(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = Number(canonicalDecimal(environment, key));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) reject();
  return value;
}

function decimalBigint(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
  minimum: bigint,
  maximum: bigint,
): bigint {
  const value = BigInt(canonicalDecimal(environment, key));
  if (value < minimum || value > maximum) reject();
  return value;
}

function reject(): never { throw new Error(); }
