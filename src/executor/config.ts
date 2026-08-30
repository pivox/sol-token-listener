import { isProxy } from 'node:util/types';

export interface ExecutorConfig {
  readonly mode: 'dry-run';
  readonly databaseUrl: string;
  readonly pollMs: number;
  readonly leaseMs: number;
  readonly databaseStatementTimeoutMs: number;
  readonly shutdownGraceMs: number;
}

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
  'SOLANA_SECRET_KEY',
  'SOLANA_KEYPAIR',
  'SOLANA_KEYPAIR_PATH',
  'WALLET_PRIVATE_KEY',
  'WALLET_KEYPAIR',
  'WALLET_KEYPAIR_PATH',
  'ANCHOR_WALLET',
] as const);

export function parseExecutorConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): ExecutorConfig {
  try {
    if (!isPlainEnvironment(environment)) throw invalid();
    for (const key of SECRET_KEYS) {
      if (environmentValue(environment, key) !== undefined) throw invalid();
    }
    const mode = environmentValue(environment, 'EXECUTOR_MODE') ?? 'dry-run';
    const liveTradingEnabled = environmentValue(environment, 'LIVE_TRADING_ENABLED');
    const databaseUrl = environmentValue(environment, 'DATABASE_URL');
    if (mode !== 'dry-run' || (liveTradingEnabled !== undefined && liveTradingEnabled !== 'false')) {
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

    return Object.freeze({
      mode: 'dry-run', databaseUrl, pollMs, leaseMs,
      databaseStatementTimeoutMs, shutdownGraceMs,
    });
  } catch {
    throw invalid();
  }
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
