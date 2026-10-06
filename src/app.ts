import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import type { AppConfig } from './config/env.js';
import { createProductionListenerRuntime } from './application/production-listener-factory.js';
import { loadConfig } from './config/env.js';
import { ApiServer, type ApiListeningAddress, type ApiServerOptions } from './interfaces/http/api-server.js';
import {
  createQualificationEngine,
  type QualificationProfileSummary,
} from './qualification/qualification-engine.js';
import { PostgresApiEventStreamRepository } from './storage/api-event-stream.repository.js';
import {
  PostgresApiProjectionRepository,
  type ApiHolderProjectionLimits,
  type ApiProjectionPipelineState,
  type ApiProjectionPipelineStateProvider,
} from './storage/api-projection.repository.js';
import type { ListenerRuntime } from './ports/listener-runtime.js';
import type { ApiEventStreamRepository } from './ports/api-event-stream-repository.js';
import type { ApiProjectionRepository } from './ports/api-projection-repository.js';
import { closeDatabase, getDatabasePool, migrateDatabase } from './storage/database.js';
import { logger } from './utils/logger.js';

type ApplicationPool = unknown;

export interface ApplicationServer {
  listen(): Promise<ApiListeningAddress>;
  close(): Promise<void>;
}

export interface ApplicationDependencies {
  readonly loadConfig: () => AppConfig;
  readonly createQualificationEngine: (config: AppConfig) => Readonly<{
    minimumTotalScore: number;
    profileSummary: QualificationProfileSummary;
  }>;
  readonly getDatabasePool: (databaseUrl: string) => ApplicationPool;
  readonly migrateDatabase: (pool: ApplicationPool) => Promise<readonly string[]>;
  readonly createListener: (
    pool: ApplicationPool,
    config: AppConfig,
    startupOptions?: Readonly<{ allowRecordedLiveEdgeCutover: boolean; expectedGenesisHash?: string }>,
  ) => ListenerRuntime;
  readonly createProjectionRepository: (
    pool: ApplicationPool,
    pipeline: ApiProjectionPipelineStateProvider,
    holderLimits: ApiHolderProjectionLimits,
    qualificationProfile: QualificationProfileSummary,
  ) => ApiProjectionRepository;
  readonly createEventStreamRepository: (pool: ApplicationPool) => ApiEventStreamRepository;
  readonly createApiServer: (options: ApiServerOptions) => ApplicationServer;
  readonly closeDatabase: () => Promise<void>;
  readonly waitForShutdownSignal: () => Promise<NodeJS.Signals>;
  readonly logInfo: (context: object, message: string) => void;
  readonly allowRecordedLiveEdgeCutover?: boolean;
  readonly expectedGenesisHash?: string;
}

export async function runApplication(overrides: Partial<ApplicationDependencies> = {}): Promise<void> {
  const dependencies: ApplicationDependencies = { ...productionDependencies, ...overrides };
  let server: ApplicationServer | null = null;
  let listener: ListenerRuntime | null = null;
  let databaseOpened = false;
  let primaryError: Readonly<{ value: unknown }> | null = null;
  try {
    const config = dependencies.loadConfig();
    const qualificationEngine = dependencies.createQualificationEngine(config);
    logFoundation(dependencies.logInfo, config, qualificationEngine.profileSummary);
    if (!config.listenerEnabled) {
      dependencies.logInfo({ event: 'listener.disabled' }, 'Listener réseau explicitement désactivé.');
    }
    if (config.listenerEnabled || config.apiEnabled || config.autoMigrate) {
      const pool = dependencies.getDatabasePool(config.databaseUrl);
      databaseOpened = true;
      if (config.autoMigrate) {
        const appliedMigrations = await dependencies.migrateDatabase(pool);
        dependencies.logInfo({ event: 'database.migrations_applied', count: appliedMigrations.length }, 'Migrations PostgreSQL appliquées.');
      }
      if (config.listenerEnabled) {
        listener = dependencies.createListener(pool, config, {
          allowRecordedLiveEdgeCutover: dependencies.allowRecordedLiveEdgeCutover ?? false,
          ...(dependencies.expectedGenesisHash === undefined ? {} : {
            expectedGenesisHash: dependencies.expectedGenesisHash,
          }),
        });
        await listener.start();
      }
      if (config.apiEnabled) {
        const pipeline = listener === null
          ? disabledPipelineState
          : (): ApiProjectionPipelineState => listener?.pipelineState() ?? disabledPipelineState();
        const projections = dependencies.createProjectionRepository(pool, pipeline, {
          positions: config.apiHolderPositionLimit,
          snapshots: config.apiHolderSnapshotLimit,
          clusters: config.apiWalletClusterLimit,
          clusterMembers: config.apiWalletClusterMemberLimit,
          totalClusterMembers: config.apiWalletClusterTotalMemberLimit,
        }, qualificationEngine.profileSummary);
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
      }
      if (config.listenerEnabled || config.apiEnabled) await dependencies.waitForShutdownSignal();
    }
  } catch (error) {
    primaryError = { value: error };
  }
  const cleanupErrors: unknown[] = [];
  if (listener !== null) {
    try { await listener.close(); } catch (error) { cleanupErrors.push(error); }
  }
  if (server !== null) {
    try { await server.close(); } catch (error) { cleanupErrors.push(error); }
  }
  if (databaseOpened) {
    try { await dependencies.closeDatabase(); } catch (error) { cleanupErrors.push(error); }
  }
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
  loadEntrypointEnvironment();
  const options = parseListenerStartupOptions(process.argv.slice(2));
  await runApplication({
    allowRecordedLiveEdgeCutover: options.allowRecordedLiveEdgeCutover,
    ...(process.env.LIVE_EXPECTED_GENESIS_HASH === undefined ? {} : {
      expectedGenesisHash: process.env.LIVE_EXPECTED_GENESIS_HASH,
    }),
  });
}

export interface ListenerStartupOptions {
  readonly allowRecordedLiveEdgeCutover: boolean;
}

export function parseListenerStartupOptions(args: readonly string[]): ListenerStartupOptions {
  if (args.length === 0) return Object.freeze({ allowRecordedLiveEdgeCutover: false });
  if (args.length === 1 && args[0] === '--allow-recorded-live-edge-cutover') {
    return Object.freeze({ allowRecordedLiveEdgeCutover: true });
  }
  throw new TypeError('Unsupported listener startup option.');
}

/** Uses the traditional cwd .env by default; an explicit dotenv path is honored for isolated launches. */
export function loadEntrypointEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): void {
  const configuredPath = environment.DOTENV_CONFIG_PATH;
  if (configuredPath?.trim().length === 0) {
    throw new Error('DOTENV_CONFIG_PATH must not be empty.');
  }
  loadDotenv({
    path: configuredPath ?? resolve(workingDirectory, '.env'),
    processEnv: environment,
    ...(configuredPath === undefined ? {} : { quiet: true }),
  });
}

const productionDependencies: ApplicationDependencies = {
  loadConfig,
  createQualificationEngine,
  getDatabasePool,
  migrateDatabase: async (pool) => migrateDatabase({ pool: pool as ReturnType<typeof getDatabasePool> }),
  createListener: (pool, config, startupOptions) => createProductionListenerRuntime(
    config,
    pool as ReturnType<typeof getDatabasePool>,
    undefined,
    startupOptions,
  ),
  createProjectionRepository: (pool, pipeline, holderLimits, qualificationProfile) => new PostgresApiProjectionRepository(
    pool as ConstructorParameters<typeof PostgresApiProjectionRepository>[0],
    () => new Date(),
    pipeline,
    holderLimits,
    qualificationProfile,
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
  logInfo: ApplicationDependencies['logInfo'], config: AppConfig, profile: QualificationProfileSummary,
): void {
  logInfo({
    event: 'listener.foundation_ready',
    executionMode: config.executionMode,
    cluster: config.cluster,
    paperQuoteMintAllowlist: config.paperQuoteMintAllowlist,
    qualificationProfileId: profile.id,
    qualificationProfileVersion: profile.version,
    qualificationRuleSetStatus: profile.status,
    qualificationProfileFingerprint: profile.fingerprint,
    qualificationMinimumScore: profile.minimumTotalScore,
    pumpFunListenerActive: config.listenerEnabled,
    pumpSwapPipelineAvailable: true,
    transactionSubmissionEnabled: false,
  }, 'Socle d’observation Pump prêt selon la configuration du listener.');
}

function disabledPipelineState(): ApiProjectionPipelineState {
  return Object.freeze({
    httpAvailable: true,
    pumpfun: 'STOPPED',
    pumpswap: 'STOPPED',
    qualification: 'STOPPED',
    paperDecision: 'STOPPED',
    social: 'STOPPED',
  });
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
  logFatal({
    event: 'listener.start_failed',
    diagnostics: failureDiagnostics(error),
  }, 'Initialisation du socle impossible.');
}

interface SafeCauseDiagnostic {
  readonly errorName: string;
  readonly code?: string;
  readonly message?: string;
  readonly catchUpWindow?: SafeCatchUpWindowDiagnostic;
}

interface SafeCatchUpWindowDiagnostic {
  readonly program: 'launchpad' | 'market';
  readonly checkpointSlot: string | null;
  readonly checkpointSignature: string | null;
  readonly frontierSlot: string | null;
  readonly frontierSignature: string | null;
  readonly pageSize: number;
  readonly maxPages: number;
  readonly pageCount: number;
  readonly signaturesRead: number;
  readonly newestSlot: string | null;
  readonly oldestSlot: string | null;
  readonly checkpointSignatureFound: boolean;
  readonly exhaustion: 'page-budget-exhausted' | 'source-history-exhausted';
}

interface SafeFailureDiagnostic {
  readonly phase: string;
  readonly stage: string;
  readonly errorName: string;
  readonly code?: string;
  readonly message?: string;
  readonly causes: readonly SafeCauseDiagnostic[];
}

function failureDiagnostics(error: unknown, depth = 0): readonly SafeFailureDiagnostic[] {
  if (depth >= 5) {
    return Object.freeze([Object.freeze({
      phase: 'startup', stage: 'application-startup', errorName: 'UnknownError', causes: Object.freeze([]),
    })]);
  }
  const diagnostics = readOwnData(error, 'diagnostics');
  if (Array.isArray(diagnostics)) {
    return Object.freeze(diagnostics.map((item) => {
      const cause = readOwnData(item, 'cause');
      const direct: SafeCauseDiagnostic = Object.freeze({
        errorName: safeName(readOwnData(item, 'errorName')),
      });
      const causes = cause === undefined ? [] : safeCauseChain(cause);
      return Object.freeze({
        phase: safeLabel(readOwnData(item, 'phase'), 'startup'),
        stage: safeLabel(readOwnData(item, 'stage'), 'application-startup'),
        errorName: direct.errorName,
        causes: Object.freeze(causes),
      });
    }));
  }

  const aggregateErrors = readOwnData(error, 'errors');
  if (Array.isArray(aggregateErrors)) {
    const preserveStartupStages = safeErrorName(error) === 'CatchUpCutoverFailureError';
    const expanded = aggregateErrors.flatMap((item, index) => {
      const nested = failureDiagnostics(item, depth + 1);
      return nested.map((diagnostic) => index === 0 || preserveStartupStages
        ? diagnostic
        : Object.freeze({
          ...diagnostic,
          phase: 'application-cleanup',
          stage: diagnostic.stage === 'application-startup' ? 'application-cleanup' : diagnostic.stage,
        }));
    });
    return Object.freeze(expanded);
  }

  const [primary, ...causes] = safeCauseChain(error);
  return Object.freeze([Object.freeze({
    phase: 'startup',
    stage: 'application-startup',
    ...(primary ?? { errorName: 'UnknownError' }),
    causes: Object.freeze(causes),
  })]);
}

function safeCauseChain(error: unknown, depth = 0, seen = new Set<unknown>()): SafeCauseDiagnostic[] {
  if (depth >= 5 || seen.has(error)) return [];
  seen.add(error);
  const result = [safeError(error)];
  const nestedErrors = readOwnData(error, 'errors');
  if (Array.isArray(nestedErrors)) {
    for (const nested of nestedErrors) {
      if (result.length >= 12) break;
      result.push(...safeCauseChain(nested, depth + 1, seen));
    }
  }
  const cause = readOwnData(error, 'cause');
  if (cause !== undefined && result.length < 12) {
    result.push(...safeCauseChain(cause, depth + 1, seen));
  }
  return result;
}

function safeError(error: unknown): SafeCauseDiagnostic {
  const errorName = safeErrorName(error);
  const code = safeCode(readOwnData(error, 'code'));
  const message = safeMessage(readOwnData(error, 'message'));
  const catchUpWindow = safeCatchUpWindow(readOwnData(error, 'diagnostic'));
  return Object.freeze({
    errorName,
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
    ...(catchUpWindow === undefined ? {} : { catchUpWindow }),
  });
}

function safeCatchUpWindow(value: unknown): SafeCatchUpWindowDiagnostic | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const program = readOwnData(value, 'program');
  const checkpointSlot = safeSlot(readOwnData(value, 'checkpointSlot'));
  const checkpointSignature = readOwnData(value, 'checkpointSignature');
  const frontierSlot = safeSlot(readOwnData(value, 'frontierSlot'));
  const frontierSignature = readOwnData(value, 'frontierSignature');
  const safeCheckpointSignature = safeTruncatedSignature(checkpointSignature);
  const safeFrontierSignature = safeTruncatedSignature(frontierSignature);
  const pageSize = readOwnData(value, 'pageSize');
  const maxPages = readOwnData(value, 'maxPages');
  const pageCount = readOwnData(value, 'pageCount');
  const signaturesRead = readOwnData(value, 'signaturesRead');
  const newestSlot = safeSlot(readOwnData(value, 'newestSlot'));
  const oldestSlot = safeSlot(readOwnData(value, 'oldestSlot'));
  const checkpointSignatureFound = readOwnData(value, 'checkpointSignatureFound');
  const exhaustion = readOwnData(value, 'exhaustion');
  if ((program !== 'launchpad' && program !== 'market')
    || checkpointSlot === undefined || newestSlot === undefined || oldestSlot === undefined
    || frontierSlot === undefined
    || safeCheckpointSignature === undefined
    || safeFrontierSignature === undefined
    || !Number.isSafeInteger(pageSize) || (pageSize as number) < 1 || (pageSize as number) > 1_000
    || !Number.isSafeInteger(maxPages) || (maxPages as number) < 1 || (maxPages as number) > 100
    || !Number.isSafeInteger(pageCount) || (pageCount as number) < 1 || (pageCount as number) > 100
    || !Number.isSafeInteger(signaturesRead) || (signaturesRead as number) < 0 || (signaturesRead as number) > 100_000
    || typeof checkpointSignatureFound !== 'boolean'
    || (exhaustion !== 'page-budget-exhausted' && exhaustion !== 'source-history-exhausted')) return undefined;
  return Object.freeze({
    program,
    checkpointSlot,
    checkpointSignature: safeCheckpointSignature,
    frontierSlot,
    frontierSignature: safeFrontierSignature,
    pageSize: pageSize as number,
    maxPages: maxPages as number,
    pageCount: pageCount as number,
    signaturesRead: signaturesRead as number,
    newestSlot,
    oldestSlot,
    checkpointSignatureFound,
    exhaustion,
  });
}

function safeTruncatedSignature(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 8 || value.length > 88) return undefined;
  if (value.length <= 24 && /^[1-9A-HJ-NP-Za-km-z]+(?:…[1-9A-HJ-NP-Za-km-z]+)?$/u.test(value)) {
    return value;
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/u.test(value)) return undefined;
  return value.length <= 24 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function safeSlot(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,77})$/u.test(value) ? value : undefined;
}

function safeErrorName(error: unknown): string {
  const ownName = readOwnData(error, 'name');
  if (typeof ownName === 'string') return safeName(ownName);
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return 'UnknownError';
  try {
    const prototype = Object.getPrototypeOf(error) as object | null;
    const prototypeName = prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, 'name');
    return prototypeName !== undefined && 'value' in prototypeName ? safeName(prototypeName.value) : 'UnknownError';
  } catch {
    return 'UnknownError';
  }
}

function readOwnData(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeName(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value)
    ? value
    : 'UnknownError';
}

function safeLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value)
    ? value
    : fallback;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_.-]{1,63}$/u.test(value) ? value : undefined;
}

function safeMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = value
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/giu, (url) => {
      void url;
      return '[REDACTED_URL]';
    })
    .replace(/\b(?:postgres(?:ql)?|mysql):\/\/[^\s"'<>]+/giu, '[REDACTED_DSN]')
    .replace(/["']?\b(password|passwd|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|private[_-]?key|credential|api[_-]?key|authorization)\b["']?\s*[:=]\s*["']?[^\s,"';}]+["']?/giu, '$1=[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[REDACTED_TOKEN]');
  return sanitized.slice(0, 400);
}
