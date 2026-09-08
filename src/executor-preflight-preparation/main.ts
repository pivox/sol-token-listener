import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { ExecutionPreflightPreparationV1 } from
  '../domain/execution-preflight-preparation.js';
import {
  createExecutionAttemptEvaluator,
} from '../executor-simulation/attempt-evaluator.js';
import {
  ProviderAffineSession,
  type ProviderAffineSessionConfig,
} from '../executor-simulation/provider-session.js';
import { createExecutorDatabase } from '../executor/database.js';
import { createDryRunWorker } from '../executor/dry-run-worker.js';
import { createSimulationOnlyWorker } from '../executor/simulation-worker.js';
import type { ExecutionDryRunRepository } from
  '../ports/execution-dry-run-repository.js';
import type {
  ExecutionIntentRepository,
  ExecutionPreflightSimulationMutationRepository,
} from '../ports/execution-intent-repository.js';
import type { ExecutionPreflightPreparationRepository } from
  '../ports/execution-preflight-preparation-repository.js';
import type { ExecutionSimulationRepository } from
  '../ports/execution-simulation-repository.js';
import type { ExecutionVenueRepository } from
  '../ports/execution-venue-repository.js';
import { closeDatabase, getDatabasePool } from '../storage/database.js';
import { PostgresExecutionDryRunRepository } from
  '../storage/execution-dry-run.repository.js';
import { PostgresExecutionIntentRepository } from
  '../storage/execution-intent.repository.js';
import { ExecutionPreflightPreparationPostgresRepository } from
  '../storage/execution-preflight-preparation.repository.js';
import { PostgresExecutionSimulationRepository } from
  '../storage/execution-simulation.repository.js';
import { PostgresExecutionVenueRepository } from
  '../storage/execution-venue.repository.js';
import {
  parseExecutionPreflightPreparationConfig,
  type ExecutionPreflightPreparationConfigV1,
} from './config.js';
import {
  createExactPreflightSimulationIntentAdapter,
  createExactPreflightTargetIntentAdapter,
} from './exact-intent-adapter.js';
import { createExecutionPreflightIntentPreparationManifestWriter } from './manifest.js';
import {
  createExecutionPreflightPreparationService,
  ExecutionPreflightPreparationServiceError,
  type ExecutionPreflightPreparationService,
  type ExecutionPreflightTargetWorkerFactoryInput,
} from './service.js';

type ExactIntentRepository = ExecutionIntentRepository
  & ExecutionPreflightSimulationMutationRepository;

export interface ExecutionPreflightPreparationBootstrapDatabase {
  readonly preparations: ExecutionPreflightPreparationRepository;
  readonly intents: ExactIntentRepository;
  readonly assessments: ExecutionDryRunRepository;
  readonly artifacts: ExecutionSimulationRepository;
  readonly venues: ExecutionVenueRepository;
  readonly evict: () => void;
  readonly close: () => Promise<void>;
}

export interface ExecutionPreflightPreparationBootstrapDependencies {
  readonly parseConfig: (environment: unknown) => ExecutionPreflightPreparationConfigV1;
  readonly openDatabase: (
    config: ExecutionPreflightPreparationConfigV1,
    onIdleError: () => void,
  ) => Promise<ExecutionPreflightPreparationBootstrapDatabase>;
  readonly createService: (input: Readonly<{
    readonly config: ExecutionPreflightPreparationConfigV1;
    readonly database: ExecutionPreflightPreparationBootstrapDatabase;
  }>) => ExecutionPreflightPreparationService;
}

export interface ExecutionPreflightPreparationCommandRuntime {
  readonly signalSource: Readonly<{
    once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  }>;
  readonly stdout: Readonly<{ write(chunk: string): unknown }>;
}

export async function startExecutionPreflightPreparation(
  environment: unknown,
  dependencies: ExecutionPreflightPreparationBootstrapDependencies,
  runtime: ExecutionPreflightPreparationCommandRuntime,
): Promise<void> {
  const config = dependencies.parseConfig(environment);
  const abortController = new AbortController();
  const stop = (): void => { abortController.abort(); };
  runtime.signalSource.once('SIGINT', stop);
  runtime.signalSource.once('SIGTERM', stop);
  let database: ExecutionPreflightPreparationBootstrapDatabase | undefined;
  try {
    database = await dependencies.openDatabase(config, () => { database?.evict(); });
    const service = dependencies.createService(Object.freeze({ config, database }));
    const preparation = await service.run(abortController.signal);
    runtime.stdout.write(`${redactedTerminalSummary(preparation)}\n`);
  } catch (error: unknown) {
    if (!abortController.signal.aborted) throw error;
  } finally {
    runtime.signalSource.removeListener('SIGINT', stop);
    runtime.signalSource.removeListener('SIGTERM', stop);
    await database?.close();
  }
}

export async function main(): Promise<void> {
  await startExecutionPreflightPreparation(
    process.env,
    productionDependencies(),
    Object.freeze({ signalSource: process, stdout: process.stdout }),
  );
}

export function reportExecutionPreflightPreparationEntrypointFailure(
  error: unknown,
  runtime: {
    exitCode?: string | number | undefined;
    stderr: Readonly<{ write(chunk: string): unknown }>;
  } = process,
): void {
  runtime.exitCode = 1;
  runtime.stderr.write(`${JSON.stringify(Object.freeze({
    service: 'sol-token-executor-preflight-preparation',
    event: 'executor_preflight_preparation.start_failed',
    errorName: safeErrorProperty(error, 'name', SAFE_FATAL_NAMES, 'UnknownError'),
    errorCode: safeErrorProperty(
      error,
      'code',
      SAFE_FATAL_CODES,
      'EXECUTION_PREFLIGHT_PREPARATION_START_FAILED',
    ),
  }))}\n`);
}

function productionDependencies(): ExecutionPreflightPreparationBootstrapDependencies {
  return Object.freeze({
    parseConfig: parseExecutionPreflightPreparationConfig,
    openDatabase: openProductionDatabase,
    createService: createProductionService,
  });
}

function openProductionDatabase(
  config: ExecutionPreflightPreparationConfigV1,
  onIdleError: () => void,
): Promise<ExecutionPreflightPreparationBootstrapDatabase> {
  const pool = getDatabasePool(config.executor.databaseUrl, {
    connectionTimeoutMillis: config.executor.databaseStatementTimeoutMs,
    query_timeout: config.executor.databaseStatementTimeoutMs,
    statement_timeout: config.executor.databaseStatementTimeoutMs,
    lock_timeout: config.executor.databaseStatementTimeoutMs,
    idle_in_transaction_session_timeout: config.executor.databaseStatementTimeoutMs,
  });
  pool.on('error', onIdleError);
  const database = createExecutorDatabase(pool);
  const intents = new PostgresExecutionIntentRepository(database.pool);
  return Promise.resolve(Object.freeze({
    preparations: new ExecutionPreflightPreparationPostgresRepository(database.pool),
    intents,
    assessments: new PostgresExecutionDryRunRepository(database.pool),
    artifacts: new PostgresExecutionSimulationRepository(database.pool),
    venues: new PostgresExecutionVenueRepository(database.pool),
    evict: database.evictActive,
    close: closeDatabase,
  }));
}

function createProductionService(input: Readonly<{
  readonly config: ExecutionPreflightPreparationConfigV1;
  readonly database: ExecutionPreflightPreparationBootstrapDatabase;
}>): ExecutionPreflightPreparationService {
  const { config, database } = input;
  const targetOwnerId = `executor-preflight-target-${randomUUID()}`;
  const simulationOwnerId = `executor-preflight-simulation-${randomUUID()}`;
  const evaluator = createExecutionAttemptEvaluator(Object.freeze({
    config: config.executor,
    venues: database.venues,
    sessionFactory: (sessionConfig: ProviderAffineSessionConfig) =>
      new ProviderAffineSession(sessionConfig),
  }));
  return createExecutionPreflightPreparationService(Object.freeze({
    config,
    preparations: database.preparations,
    createTargetWorker: (workerInput: ExecutionPreflightTargetWorkerFactoryInput) =>
      createDryRunWorker(Object.freeze({
      intents: createExactPreflightTargetIntentAdapter(Object.freeze({
        intents: database.intents,
        preparationClaim: workerInput.preparationClaim,
        pairId: workerInput.pair.pairId,
        intentId: workerInput.pair.targetIntentId,
        ownerId: targetOwnerId,
        leaseMs: config.executor.leaseMs,
      })),
      assessments: database.assessments,
      ownerId: targetOwnerId,
      leaseMs: config.executor.leaseMs,
      })),
    createSimulationWorker: (workerInput: ExecutionPreflightTargetWorkerFactoryInput) => {
      const intents = createExactPreflightSimulationIntentAdapter(Object.freeze({
        intents: database.intents,
        preparationClaim: workerInput.preparationClaim,
        renewPreparation: (claim: Parameters<ExecutionPreflightPreparationRepository['renew']>[0],
          leaseMs: number) => database.preparations.renew(claim, leaseMs),
        preparationLeaseMs: config.preparationLeaseMs,
        pairId: workerInput.pair.pairId,
        intentId: workerInput.pair.simulationIntentId,
        ownerId: simulationOwnerId,
        leaseMs: config.executor.leaseMs,
      }));
      const worker = createSimulationOnlyWorker(Object.freeze({
        intents,
        artifacts: database.artifacts,
        evaluator,
        ownerId: simulationOwnerId,
        leaseMs: config.executor.leaseMs,
        clock: () => intents.currentPreparationClaim().preparation.updatedAtMs,
      }));
      return Object.freeze({
        runOnce: worker.runOnce,
        currentPreparationClaim: intents.currentPreparationClaim,
      });
    },
    manifestWriter: createExecutionPreflightIntentPreparationManifestWriter(),
    delay: abortablePreparationDelay,
  }));
}

export function abortablePreparationDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(delayMs) || delayMs <= 0 || !(signal instanceof AbortSignal)) {
    return Promise.reject(new ExecutionPreflightPreparationServiceError());
  }
  if (signal.aborted) return Promise.reject(new ExecutionPreflightPreparationServiceError());
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ExecutionPreflightPreparationServiceError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function redactedTerminalSummary(preparation: ExecutionPreflightPreparationV1): string {
  if (preparation.state !== 'PREPARED' && preparation.state !== 'FAILED') {
    throw new ExecutionPreflightPreparationServiceError();
  }
  return JSON.stringify(Object.freeze({
    schemaVersion: 'execution-preflight-intent-preparation-result.v1',
    state: preparation.state,
    runId: preparation.runId,
    failureCode: preparation.failureCode,
    canaryStatus: 'CANARY_NOT_STARTED',
    paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED',
    liveCapabilityPresent: false,
  }));
}

const SAFE_FATAL_NAMES = new Set([
  'ExecutionPreflightPreparationConfigError',
  'ExecutionPreflightPreparationServiceError',
  'ExecutionPreflightPreparationRepositoryError',
  'ExecutionIntentRepositoryError',
  'ExecutionDryRunRepositoryError',
  'ExecutionSimulationRepositoryError',
  'ExecutionAttemptEvaluatorError',
  'ExecutionProviderSessionError',
  'ExecutorDatabaseError',
  'Error',
  'TypeError',
  'RangeError',
  'AggregateError',
]);
const SAFE_FATAL_CODES = new Set([
  'INVALID_EXECUTION_PREFLIGHT_PREPARATION_CONFIG',
  'EXECUTION_PREFLIGHT_PREPARATION_FAILED',
  'PREFLIGHT_PREPARATION_EXPORT_FAILED',
  'EXECUTOR_DATABASE_BUSY',
  'INVALID_INPUT',
  'INVALID_DATA',
  'DATABASE_FAILURE',
  'OPERATION_ABORTED',
  'PREPARATION_BUSY',
  'PREPARATION_LEASE_LOST',
  'PREFLIGHT_PAIR_CONFLICT',
  'PREFLIGHT_PAIR_LINEAGE_INVALID',
  'PREFLIGHT_ASSESSMENT_INVALID',
  'PREFLIGHT_SIMULATION_FAILED',
  'PREFLIGHT_PREPARATION_DEADLINE_EXCEEDED',
  'COMMIT_OUTCOME_UNKNOWN',
  'INTENT_FENCE_LOST',
  'ASSESSMENT_CONFLICT',
  'ARTIFACT_CONFLICT',
  'INTENT_DUPLICATE',
  'INTENT_LEASE_LOST',
  'ATTEMPT_EXHAUSTED',
  'ATTEMPT_CONFLICT',
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
  void main().catch((error: unknown) => {
    reportExecutionPreflightPreparationEntrypointFailure(error);
  });
}
