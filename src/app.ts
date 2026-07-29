import { pathToFileURL } from 'node:url';
import type { AppConfig } from './config/env.js';
import { loadConfig } from './config/env.js';
import { ApiServer, type ApiListeningAddress, type ApiServerOptions } from './interfaces/http/api-server.js';
import { createQualificationEngine } from './qualification/qualification-engine.js';
import { PostgresApiEventStreamRepository } from './storage/api-event-stream.repository.js';
import {
  PostgresApiProjectionRepository,
  type ApiHolderProjectionLimits,
  type ApiProjectionPipelineState,
} from './storage/api-projection.repository.js';
import type { ApiEventStreamRepository } from './ports/api-event-stream-repository.js';
import type { ApiProjectionRepository } from './ports/api-projection-repository.js';
import { closeDatabase, getDatabasePool, migrateDatabase } from './storage/database.js';
import { logger } from './utils/logger.js';

type ApplicationPool = unknown;

export const PRODUCTION_API_PIPELINE_STATE: ApiProjectionPipelineState = Object.freeze({
  httpAvailable: true,
  pumpfun: 'STOPPED',
  pumpswap: 'IDLE',
});

export interface ApplicationServer {
  listen(): Promise<ApiListeningAddress>;
  close(): Promise<void>;
}

export interface ApplicationDependencies {
  readonly loadConfig: () => AppConfig;
  readonly createQualificationEngine: (config: AppConfig) => Readonly<{ minimumTotalScore: number }>;
  readonly getDatabasePool: (databaseUrl: string) => ApplicationPool;
  readonly migrateDatabase: (pool: ApplicationPool) => Promise<readonly string[]>;
  readonly createProjectionRepository: (
    pool: ApplicationPool,
    pipeline: ApiProjectionPipelineState,
    holderLimits: ApiHolderProjectionLimits,
  ) => ApiProjectionRepository;
  readonly createEventStreamRepository: (pool: ApplicationPool) => ApiEventStreamRepository;
  readonly createApiServer: (options: ApiServerOptions) => ApplicationServer;
  readonly closeDatabase: () => Promise<void>;
  readonly waitForShutdownSignal: () => Promise<NodeJS.Signals>;
  readonly logInfo: (context: object, message: string) => void;
}

export async function runApplication(overrides: Partial<ApplicationDependencies> = {}): Promise<void> {
  const dependencies: ApplicationDependencies = { ...productionDependencies, ...overrides };
  let server: ApplicationServer | null = null;
  let primaryError: Readonly<{ value: unknown }> | null = null;
  try {
    const config = dependencies.loadConfig();
    const qualificationEngine = dependencies.createQualificationEngine(config);
    logFoundation(dependencies.logInfo, config, qualificationEngine.minimumTotalScore);
    if (config.apiEnabled || config.autoMigrate) {
      const pool = dependencies.getDatabasePool(config.databaseUrl);
      if (config.autoMigrate) {
        const appliedMigrations = await dependencies.migrateDatabase(pool);
        dependencies.logInfo({ event: 'database.migrations_applied', count: appliedMigrations.length }, 'Migrations PostgreSQL appliquées.');
      }
      if (config.apiEnabled) {
        const projections = dependencies.createProjectionRepository(pool, PRODUCTION_API_PIPELINE_STATE, {
          positions: config.apiHolderPositionLimit,
          snapshots: config.apiHolderSnapshotLimit,
          clusters: config.apiWalletClusterLimit,
          clusterMembers: config.apiWalletClusterMemberLimit,
          totalClusterMembers: config.apiWalletClusterTotalMemberLimit,
        });
        const stream = dependencies.createEventStreamRepository(pool);
        server = dependencies.createApiServer({
          host: config.apiHost,
          port: config.apiPort,
          projections,
          stream,
          defaultLimit: config.apiPageLimitDefault,
          maximumLimit: config.apiPageLimitMaximum,
          ssePollMs: config.apiSsePollMs,
          sseHeartbeatMs: config.apiSseHeartbeatMs,
          logError: (context) => { dependencies.logInfo(context, 'La requête API a échoué.'); },
        });
        const address = await server.listen();
        dependencies.logInfo({
          event: 'api.started', host: address.host, port: address.port,
          apiEnabled: config.apiEnabled, executionMode: config.executionMode,
          transactionSubmissionEnabled: false,
        }, 'API publique d’observation disponible.');
        await dependencies.waitForShutdownSignal();
        const startedServer = server;
        server = null;
        await startedServer.close();
      }
    }
  } catch (error) {
    primaryError = { value: error };
  }
  const cleanupErrors: unknown[] = [];
  if (server !== null) {
    try { await server.close(); } catch (error) { cleanupErrors.push(error); }
  }
  try { await dependencies.closeDatabase(); } catch (error) { cleanupErrors.push(error); }
  if (primaryError !== null) {
    if (cleanupErrors.length === 0) throw primaryError.value;
    throw new AggregateError([primaryError.value, ...cleanupErrors], 'Application shutdown failed.');
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Application shutdown failed.');
}

export function waitForShutdownSignal(signalSource: Pick<NodeJS.Process, 'once' | 'off'> = process): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const complete = (signal: NodeJS.Signals): void => {
      signalSource.off('SIGINT', onSigint);
      signalSource.off('SIGTERM', onSigterm);
      resolve(signal);
    };
    const onSigint = (): void => { complete('SIGINT'); };
    const onSigterm = (): void => { complete('SIGTERM'); };
    signalSource.once('SIGINT', onSigint);
    signalSource.once('SIGTERM', onSigterm);
  });
}

export async function main(): Promise<void> {
  await runApplication();
}

const productionDependencies: ApplicationDependencies = {
  loadConfig,
  createQualificationEngine,
  getDatabasePool,
  migrateDatabase: async (pool) => migrateDatabase({ pool: pool as ReturnType<typeof getDatabasePool> }),
  createProjectionRepository: (pool, pipeline, holderLimits) => new PostgresApiProjectionRepository(
    pool as ConstructorParameters<typeof PostgresApiProjectionRepository>[0],
    () => new Date(),
    pipeline,
    holderLimits,
  ),
  createEventStreamRepository: (pool) => new PostgresApiEventStreamRepository(
    pool as ConstructorParameters<typeof PostgresApiEventStreamRepository>[0],
  ),
  createApiServer: (options) => new ApiServer(options),
  closeDatabase,
  waitForShutdownSignal,
  logInfo: (context, message) => { logger.info(context, message); },
};

function logFoundation(
  logInfo: ApplicationDependencies['logInfo'], config: AppConfig, minimumTotalScore: number,
): void {
  logInfo({
    event: 'listener.foundation_ready',
    executionMode: config.executionMode,
    cluster: config.cluster,
    paperQuoteMintAllowlist: config.paperQuoteMintAllowlist,
    qualificationRuleSetStatus: config.qualificationRuleSetStatus,
    qualificationMinimumScore: minimumTotalScore,
    pumpFunListenerActive: false,
    pumpSwapPipelineAvailable: true,
    transactionSubmissionEnabled: false,
  }, 'Pipeline PumpSwap disponible mais non abonné; listener réseau inactif.');
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => {
    reportEntrypointFailure(error);
  });
}

export function reportEntrypointFailure(
  error: unknown,
  runtime: Pick<NodeJS.Process, 'exitCode'> = process,
  logFatal: (context: object, message: string) => void = (context, message) => { logger.fatal(context, message); },
): void {
  runtime.exitCode = 1;
  logFatal({ event: 'listener.start_failed', errorName: safeErrorName(error) }, 'Initialisation du socle impossible.');
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_.-]{1,128}$/u.test(error.name) ? error.name : 'UnknownError';
}
