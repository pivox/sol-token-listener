import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { closeDatabase, getDatabasePool } from '../storage/database.js';
import { PostgresExecutionDryRunRepository } from '../storage/execution-dry-run.repository.js';
import { PostgresExecutionIntentRepository } from '../storage/execution-intent.repository.js';
import { parseExecutorConfig } from './config.js';
import { createExecutorDatabase } from './database.js';
import { createDryRunWorker } from './dry-run-worker.js';
import { createExecutorLogger } from './logger.js';
import { runExecutorRuntime } from './runtime.js';

const SAFE_FATAL_ERROR_NAMES = new Set([
  'ExecutorConfigError', 'ExecutorDatabaseError',
  'ExecutionIntentRepositoryError', 'ExecutionDryRunRepositoryError',
  'Error', 'TypeError', 'RangeError', 'AggregateError',
]);
const SAFE_FATAL_ERROR_CODES = new Set([
  'INVALID_EXECUTOR_CONFIG', 'EXECUTOR_DATABASE_BUSY',
  'INVALID_INPUT', 'INVALID_DATA', 'DATABASE_FAILURE',
  'COMMIT_OUTCOME_UNKNOWN', 'INTENT_FENCE_LOST', 'ASSESSMENT_CONFLICT',
  'INTENT_DUPLICATE', 'INTENT_LEASE_LOST', 'ATTEMPT_EXHAUSTED', 'ATTEMPT_CONFLICT',
]);

export async function main(): Promise<void> {
  const config = parseExecutorConfig(process.env);
  const logger = createExecutorLogger();
  const pool = getDatabasePool(config.databaseUrl, {
    connectionTimeoutMillis: config.databaseStatementTimeoutMs,
    query_timeout: config.databaseStatementTimeoutMs,
    statement_timeout: config.databaseStatementTimeoutMs,
    lock_timeout: config.databaseStatementTimeoutMs,
    idle_in_transaction_session_timeout: config.databaseStatementTimeoutMs,
  });
  pool.on('error', () => {
    logger.error(Object.freeze({
      event: 'executor.database_client_error',
      errorCode: 'DATABASE_IDLE_CLIENT_ERROR',
    }));
  });
  const database = createExecutorDatabase(pool);
  const worker = createDryRunWorker(Object.freeze({
    intents: new PostgresExecutionIntentRepository(database.pool),
    assessments: new PostgresExecutionDryRunRepository(database.pool),
    ownerId: `executor-dry-run-${randomUUID()}`,
    leaseMs: config.leaseMs,
  }));
  await runExecutorRuntime({
    runOnce: worker.runOnce,
    logger,
    closeDatabase,
    evictDatabase: database.evictActive,
    forceExit: (code) => { process.exit(code); },
  }, {
    pollMs: config.pollMs,
    shutdownGraceMs: config.shutdownGraceMs,
    signalSource: process,
  });
}

export function reportExecutorEntrypointFailure(
  error: unknown,
  runtime: Pick<NodeJS.Process, 'exitCode' | 'stderr'> = process,
): void {
  runtime.exitCode = 1;
  const context = Object.freeze({
    service: 'sol-token-executor',
    event: 'executor.start_failed',
    errorName: safeErrorName(error),
    errorCode: safeFatalCode(error),
  });
  runtime.stderr.write(`${JSON.stringify(context)}\n`);
}

function safeErrorName(error: unknown): string {
  const name = safeErrorProperty(error, 'name');
  return name !== null && SAFE_FATAL_ERROR_NAMES.has(name) ? name : 'UnknownError';
}

function safeFatalCode(error: unknown): string {
  const code = safeErrorProperty(error, 'code');
  return code !== null && SAFE_FATAL_ERROR_CODES.has(code) ? code : 'EXECUTOR_START_FAILED';
}

function safeErrorProperty(error: unknown, key: 'name' | 'code'): string | null {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (descriptor === undefined || !('value' in descriptor)
      || typeof descriptor.value !== 'string'
      || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(descriptor.value)) return null;
    return descriptor.value;
  } catch {
    return null;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => { reportExecutorEntrypointFailure(error); });
}
