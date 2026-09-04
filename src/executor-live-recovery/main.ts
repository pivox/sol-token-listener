import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { createExecutorDatabase } from '../executor/database.js';
import { closeDatabase, getDatabasePool } from '../storage/database.js';
import { PostgresExecutionIntentRepository } from '../storage/execution-intent.repository.js';
import { PostgresExecutionLiveRepository } from '../storage/execution-live.repository.js';
import { parseLiveRecoveryConfig, type LiveRecoveryConfig } from './config.js';
import {
  createLiveRecoveryLanes,
  type LiveRecoveryLaneDependencies,
  type LiveRecoveryLanes,
} from './lanes.js';
import { createLiveRecoveryLogger, type LiveRecoveryLogger } from './logger.js';
import { SolanaFinalityRpcSession } from './rpc-gateway.js';
import {
  runLiveRecoveryRuntime,
  type LiveRecoveryRuntimeDependencies,
  type LiveRecoveryRuntimeOptions,
} from './runtime.js';
import {
  validateLiveRecoveryStartup,
  type LiveRecoveryStartupDatabase,
} from './startup-validator.js';

export interface LiveRecoveryBootstrapDatabase {
  readonly startup: LiveRecoveryStartupDatabase;
  readonly intents: LiveRecoveryLaneDependencies['intents'];
  readonly live: LiveRecoveryLaneDependencies['live'];
  readonly close: () => Promise<void>;
  readonly evict: () => void | Promise<void>;
}

export interface LiveRecoveryBootstrapDependencies {
  readonly parseConfig: (environment: unknown) => LiveRecoveryConfig;
  readonly openDatabase: (config: LiveRecoveryConfig) => Promise<LiveRecoveryBootstrapDatabase>;
  readonly validateStartup: (
    database: LiveRecoveryBootstrapDatabase,
    config: LiveRecoveryConfig,
  ) => Promise<unknown>;
  readonly verifyGenesis: (config: LiveRecoveryConfig, signal: AbortSignal) => Promise<unknown>;
  readonly createLaneFactory: (input: Readonly<{
    readonly config: LiveRecoveryConfig;
    readonly database: LiveRecoveryBootstrapDatabase;
  }>) => () => LiveRecoveryLanes;
  readonly runtime: (
    dependencies: LiveRecoveryRuntimeDependencies,
    options: LiveRecoveryRuntimeOptions,
  ) => Promise<void>;
  readonly logger: LiveRecoveryLogger;
  readonly forceExit: (code: 1) => void;
}

export async function startLiveRecovery(
  environment: unknown,
  dependencies: LiveRecoveryBootstrapDependencies,
): Promise<void> {
  const config = dependencies.parseConfig(environment);
  const database = await dependencies.openDatabase(config);
  let runtimeOwnsDatabase = false;
  try {
    await dependencies.validateStartup(database, config);
    await dependencies.verifyGenesis(config, new AbortController().signal);
    const createLanes = dependencies.createLaneFactory(Object.freeze({ config, database }));
    runtimeOwnsDatabase = true;
    await dependencies.runtime(Object.freeze({
      createLanes,
      logger: dependencies.logger,
      closeDatabase: database.close,
      evictDatabase: database.evict,
      forceExit: dependencies.forceExit,
    }), Object.freeze({
      pollMs: config.pollMs,
      shutdownGraceMs: config.shutdownGraceMs,
    }));
  } finally {
    if (!runtimeOwnsDatabase) await database.close();
  }
}

export async function main(): Promise<void> {
  const logger = createLiveRecoveryLogger();
  await startLiveRecovery(process.env, productionDependencies(logger));
}

export function reportLiveRecoveryEntrypointFailure(
  error: unknown,
  runtime: {
    exitCode?: string | number | undefined;
    stderr: Readonly<{ write(chunk: string): unknown }>;
  } = process,
): void {
  runtime.exitCode = 1;
  runtime.stderr.write(`${JSON.stringify(Object.freeze({
    service: 'sol-token-executor-live-recovery',
    event: 'executor_live_recovery.start_failed',
    errorName: safeErrorProperty(error, 'name', SAFE_FATAL_NAMES, 'UnknownError'),
    errorCode: safeErrorProperty(
      error, 'code', SAFE_FATAL_CODES, 'LIVE_RECOVERY_START_FAILED',
    ),
  }))}\n`);
}

function productionDependencies(logger: LiveRecoveryLogger): LiveRecoveryBootstrapDependencies {
  const dependencies: LiveRecoveryBootstrapDependencies = {
    parseConfig: parseLiveRecoveryConfig,
    openDatabase: (config: LiveRecoveryConfig) => {
      const pool = getDatabasePool(config.databaseUrl, {
        connectionTimeoutMillis: config.databaseStatementTimeoutMs,
        query_timeout: config.databaseStatementTimeoutMs,
        statement_timeout: config.databaseStatementTimeoutMs,
        lock_timeout: config.databaseStatementTimeoutMs,
        idle_in_transaction_session_timeout: config.databaseStatementTimeoutMs,
      });
      pool.on('error', () => {
        logger.error(Object.freeze({
          event: 'executor_live_recovery.database_idle_client_error',
          executionMode: 'live-recovery',
          errorCode: 'DATABASE_IDLE_CLIENT_ERROR',
        }));
      });
      const tracked = createExecutorDatabase(pool);
      const startup: LiveRecoveryStartupDatabase = Object.freeze({
        query: async (text: string, values?: readonly unknown[]) => {
          const result = await pool.query(text, values === undefined ? [] : [...values]);
          return Object.freeze({ rows: result.rows, rowCount: result.rowCount });
        },
      });
      return Promise.resolve(Object.freeze({
        startup,
        intents: new PostgresExecutionIntentRepository(tracked.pool),
        live: new PostgresExecutionLiveRepository(tracked.pool),
        close: closeDatabase,
        evict: tracked.evictActive,
      }));
    },
    validateStartup: (
      database: LiveRecoveryBootstrapDatabase,
      config: LiveRecoveryConfig,
    ) => validateLiveRecoveryStartup(database.startup, config),
    verifyGenesis: async (config: LiveRecoveryConfig, signal: AbortSignal) => {
      await rpcSession(config).verifyGenesis(signal);
    },
    createLaneFactory: ({ config, database }: Readonly<{
      readonly config: LiveRecoveryConfig;
      readonly database: LiveRecoveryBootstrapDatabase;
    }>) => () => createLiveRecoveryLanes({
      config,
      intents: database.intents,
      live: database.live,
      gateway: rpcSession(config),
    }),
    runtime: runLiveRecoveryRuntime,
    logger,
    forceExit: (code: 1) => { process.exit(code); },
  };
  return Object.freeze(dependencies);
}

function rpcSession(config: LiveRecoveryConfig): SolanaFinalityRpcSession {
  return new SolanaFinalityRpcSession(Object.freeze({
    providerId: config.providerId,
    httpRpcUrl: config.httpRpcUrl,
    expectedGenesisHash: config.expectedGenesisHash,
    timeoutMs: config.rpcTimeoutMs,
    maxCalls: config.maxRpcCallsPerPass,
  }));
}

const SAFE_FATAL_NAMES = new Set([
  'LiveRecoveryConfigError', 'LiveRecoveryStartupError', 'LiveRecoveryRpcError',
  'LiveRecoveryLaneError', 'ExecutorDatabaseError', 'ExecutionIntentRepositoryError',
  'ExecutionLiveRepositoryError', 'Error', 'TypeError', 'RangeError', 'AggregateError',
]);
const SAFE_FATAL_CODES = new Set([
  'INVALID_LIVE_RECOVERY_CONFIG', 'MIGRATION_CATALOG_INVALID', 'DATABASE_ROLE_INVALID',
  'MIGRATION_HISTORY_INVALID', 'GENERATION_BINDING_INVALID', 'OPEN_WORK_BINDING_INVALID',
  'DATABASE_READ_FAILED', 'INVALID_INPUT', 'OPERATION_ABORTED', 'RPC_RATE_LIMITED',
  'RPC_TIMEOUT', 'RPC_UNAVAILABLE', 'RPC_RESPONSE_TOO_LARGE', 'RPC_RESPONSE_INVALID',
  'GENESIS_MISMATCH', 'CALL_BUDGET_EXCEEDED', 'SESSION_FAILED',
  'EXECUTOR_DATABASE_BUSY', 'DATABASE_FAILURE',
]);

function safeErrorProperty(
  error: unknown,
  key: 'name' | 'code',
  allowed: ReadonlySet<string>,
  fallback: string,
): string {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return fallback;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (descriptor === undefined || !('value' in descriptor)
      || typeof descriptor.value !== 'string' || !allowed.has(descriptor.value)) return fallback;
    return descriptor.value;
  } catch {
    return fallback;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => { reportLiveRecoveryEntrypointFailure(error); });
}
