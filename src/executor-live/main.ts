import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { ExecutionTransactionSigner } from '../ports/execution-transaction-signer.js';
import type { SimulationOnlyExecutorConfig } from '../executor/config.js';
import { createLiveExecutionAttemptEvaluator } from '../executor-simulation/attempt-evaluator.js';
import { ProviderAffineSession } from '../executor-simulation/provider-session.js';
import { openLiveExecutorDatabase, type LiveExecutorBootstrapDatabase } from './database.js';
export type { LiveExecutorBootstrapDatabase } from './database.js';
import { parseLiveExecutorConfig, type LiveExecutorConfig } from './config.js';
import { loadLiveTransactionSigner } from './keypair-loader.js';
import { createLiveSignableLanes } from './lanes.js';
import type { LiveSignableLaneDependencies } from './lanes.js';
import { createLiveExecutorLogger, type LiveExecutorLogger } from './logger.js';
import {
  createLiveRpcCallBudgetExhaustedError,
  SolanaLiveRpcSession,
  type LiveRpcGenesisEvidenceV1,
} from './rpc-gateway.js';
import {
  runLiveExecutorRuntime,
  type LiveExecutorLanes,
  type LiveExecutorRuntimeDependencies,
  type LiveExecutorRuntimeOptions,
} from './runtime.js';
import { SignedSimulationGateway } from './signed-simulation-gateway.js';
import { LiveSubmissionGateway } from './submission-gateway.js';
import {
  LiveTransactionCandidateAuthority,
  LiveTransactionPreparer,
} from './transaction-preparer.js';
import { createFreshLiveExecution } from './fresh-execution.js';
import {
  executeLivePreparedTransaction,
  resumeLivePersistedTransaction,
  type LiveExecutionWorkerDependencies,
} from './execution-worker.js';
import type { ExecutionLiveRuntimeBindingV1 } from '../ports/execution-live-repository.js';
import type { SignedTransactionArtifactV1 } from '../domain/execution-live.js';
import { LIVE_EXECUTOR_SAFE_ERROR_CODE_SET } from './error-codes.js';
import { ExecutionLiveRepositoryError } from '../storage/execution-live.repository.js';

export interface LiveExecutorBootstrapDependencies {
  readonly parseConfig: (environment: unknown) => LiveExecutorConfig;
  readonly openDatabase: (config: LiveExecutorConfig) => Promise<LiveExecutorBootstrapDatabase>;
  readonly verifyGenesis: (
    config: LiveExecutorConfig,
    signal: AbortSignal,
  ) => Promise<LiveRpcGenesisEvidenceV1>;
  readonly loadSigner: (config: LiveExecutorConfig) => Promise<ExecutionTransactionSigner>;
  readonly createLanes: (input: Readonly<{
    readonly config: LiveExecutorConfig;
    readonly database: LiveExecutorBootstrapDatabase;
    readonly signer: ExecutionTransactionSigner;
    readonly runtime: ExecutionLiveRuntimeBindingV1;
  }>) => LiveExecutorLanes;
  readonly runtime: (
    dependencies: LiveExecutorRuntimeDependencies,
    options: LiveExecutorRuntimeOptions,
  ) => Promise<void>;
  readonly logger: LiveExecutorLogger;
  readonly forceExit: (code: 1) => void;
}

export interface LiveExecutorSessionFactory {
  readonly createUnsigned: (config: ConstructorParameters<typeof ProviderAffineSession>[0]) => ProviderAffineSession;
  readonly createTail: (
    config: ConstructorParameters<typeof SolanaLiveRpcSession>[0],
    fetchImplementation: typeof fetch,
  ) => SolanaLiveRpcSession;
}

const productionSessionFactory: LiveExecutorSessionFactory = Object.freeze({
  createUnsigned: (config: ConstructorParameters<typeof ProviderAffineSession>[0]) =>
    new ProviderAffineSession(config),
  createTail: (
    config: ConstructorParameters<typeof SolanaLiveRpcSession>[0],
    fetchImplementation: typeof fetch,
  ) => new SolanaLiveRpcSession(config, fetchImplementation),
});

export async function startLiveExecutor(
  environment: unknown,
  dependencies: LiveExecutorBootstrapDependencies,
): Promise<void> {
  const config = dependencies.parseConfig(environment);
  const database = await dependencies.openDatabase(config);
  let signer: ExecutionTransactionSigner | null = null;
  let runtimeOwnsResources = false;
  try {
    await database.validateStartup(config);
    const genesis = await dependencies.verifyGenesis(config, new AbortController().signal);
    signer = await dependencies.loadSigner(config);
    if (signer.publicKey !== config.executorPublicKey) {
      throw new TypeError('Live transaction signer does not match executor public key.');
    }
    const runtime = runtimeBinding(config, signer, genesis);
    const lanes = dependencies.createLanes(Object.freeze({ config, database, signer, runtime }));
    const running = dependencies.runtime(Object.freeze({
      lanes,
      logger: dependencies.logger,
      closeSigner: () => signer?.close() ?? Promise.resolve(),
      closeDatabase: database.close,
      evictDatabase: database.evict,
      forceExit: dependencies.forceExit,
    }), Object.freeze({
      pollMs: config.pollMs,
      shutdownGraceMs: config.shutdownGraceMs,
    }));
    runtimeOwnsResources = true;
    await running;
  } finally {
    if (!runtimeOwnsResources) {
      try { await signer?.close(); } finally { await database.close(); }
    }
  }
}

export async function main(): Promise<void> {
  const logger = createLiveExecutorLogger();
  await startLiveExecutor(process.env, productionDependencies(logger));
}

export function createProductionLiveExecutorLanes(input: Readonly<{
  readonly config: LiveExecutorConfig;
  readonly database: LiveExecutorBootstrapDatabase;
  readonly signer: ExecutionTransactionSigner;
  readonly runtime: ExecutionLiveRuntimeBindingV1;
}>, sessions: LiveExecutorSessionFactory = productionSessionFactory): LiveExecutorLanes {
  const ownerId = `executor-live-${randomUUID()}`;
  const dependencies: LiveSignableLaneDependencies = {
    ownerId,
    leaseMs: input.config.leaseMs,
    phase: input.config.phase,
    intents: input.database.intents,
    executeFresh: async (context, signal, renew) => {
      const authority = new LiveTransactionCandidateAuthority();
      const evaluator = createLiveExecutionAttemptEvaluator(Object.freeze({
        config: simulationConfig(input.config, input.config.maxRpcCallsPerAttempt - 6),
        venues: input.database.venues,
        sessionFactory: sessions.createUnsigned,
      }), (simulationGateway) => new LiveTransactionPreparer(
        simulationGateway, input.signer, authority, 1_232,
      ));
      const worker = createLiveExecutionWorkerForWork(input.config, input.database, sessions);
      const fresh = createFreshLiveExecution(Object.freeze({
        generationId: input.config.generationId,
        runtime: input.runtime,
        live: input.database.live,
        failures: input.database.simulations,
        evaluator,
        candidateAuthority: authority,
        executePrepared: (
          prepared: Parameters<typeof executeLivePreparedTransaction>[1],
          activeSignal: AbortSignal,
        ) => executeLivePreparedTransaction(
          worker, prepared, activeSignal,
        ),
      }));
      return (await fresh.execute(context, signal, renew)).claim;
    },
    recoverPersisted: async (claim, signal) => {
      // The worker inspects durable state before a tail session is opened.
      return (await resumeLivePersistedTransaction(
        createLiveExecutionWorkerForWork(input.config, input.database, sessions),
        Object.freeze({ payloadVersion: 1, claim, runtime: input.runtime }), signal,
      )).claim;
    },
  };
  return createLiveSignableLanes(Object.freeze(dependencies));
}

function productionDependencies(logger: LiveExecutorLogger): LiveExecutorBootstrapDependencies {
  const dependencies: LiveExecutorBootstrapDependencies = {
    parseConfig: parseLiveExecutorConfig,
    openDatabase: (config) => Promise.resolve(openLiveExecutorDatabase(Object.freeze({
      databaseUrl: config.databaseUrl,
      statementTimeoutMs: config.databaseStatementTimeoutMs,
      onIdleError: () => {
        logger.error(Object.freeze({
          event: 'executor_live.database_idle_client_error', errorCode: 'DATABASE_IDLE_CLIENT_ERROR',
        }));
      },
    }))),
    verifyGenesis: (config, signal) => startupSession(config).verifyGenesis(signal),
    loadSigner: loadLiveTransactionSigner,
    createLanes: createProductionLiveExecutorLanes,
    runtime: runLiveExecutorRuntime,
    logger,
    forceExit: (code) => { process.exit(code); },
  };
  return Object.freeze(dependencies);
}

function startupSession(config: LiveExecutorConfig): SolanaLiveRpcSession {
  return new SolanaLiveRpcSession(Object.freeze({
    providerId: config.providerId,
    httpRpcUrl: config.httpRpcUrl,
    expectedGenesisHash: config.expectedGenesisHash,
    timeoutMs: config.rpcTimeoutMs,
    maxCalls: 1,
  }));
}

export function createLiveExecutionWorkerForWork(
  config: LiveExecutorConfig,
  database: LiveExecutorBootstrapDatabase,
  sessions: Pick<LiveExecutorSessionFactory, 'createTail'> = productionSessionFactory,
  networkFetch: typeof fetch = fetch,
): LiveExecutionWorkerDependencies {
  let tail: SolanaLiveRpcSession | null = null;
  let genesisVerification: Promise<LiveRpcGenesisEvidenceV1> | null = null;
  let rpcAuthority: Readonly<{
    readonly claim: Parameters<LiveExecutorBootstrapDatabase['live']['reserveRpcCall']>[0]['claim'];
    readonly artifactId: string;
  }> | null = null;
  const budgetedFetch: typeof fetch = async (resource, init) => {
    const authority = rpcAuthority;
    if (authority === null) throw new TypeError('Live RPC budget authority is missing.');
    try {
      await database.live.reserveRpcCall(Object.freeze({
        payloadVersion: 1,
        claim: authority.claim,
        artifactId: authority.artifactId,
      }));
    } catch (error) {
      if (error instanceof ExecutionLiveRepositoryError
        && error.code === 'RPC_CALL_BUDGET_EXHAUSTED') {
        throw createLiveRpcCallBudgetExhaustedError();
      }
      throw error;
    }
    return networkFetch(resource, init);
  };
  const session = async (signal: AbortSignal): Promise<SolanaLiveRpcSession> => {
    tail ??= sessions.createTail(Object.freeze({
      providerId: config.providerId,
      httpRpcUrl: config.httpRpcUrl,
      expectedGenesisHash: config.expectedGenesisHash,
      timeoutMs: config.rpcTimeoutMs,
      maxCalls: 6,
    }), budgetedFetch);
    genesisVerification ??= tail.verifyGenesis(signal);
    await genesisVerification;
    return tail;
  };
  const dependencies: LiveExecutionWorkerDependencies = {
    repository: database.live,
    activateRpcBudget: (claim, artifactId) => {
      if (rpcAuthority !== null
        && (rpcAuthority.claim.intent.id !== claim.intent.id
          || rpcAuthority.claim.leaseToken !== claim.leaseToken
          || rpcAuthority.artifactId !== artifactId)) {
        throw new TypeError('Live RPC budget authority changed within one work item.');
      }
      rpcAuthority = Object.freeze({ claim, artifactId });
    },
    signedSimulation: Object.freeze({
      simulate: async (input, signal) => new SignedSimulationGateway(await session(signal), Object.freeze({
        maxComputeUnits: config.maxComputeUnits,
        maxFeePayerLamportDebit: config.maxFeePayerLamportDebit,
      })).simulate(input, signal),
    }),
    submission: Object.freeze({
      submitPersisted: async (persisted, signal) => new LiveSubmissionGateway(
        await session(signal),
      ).submitPersisted(persisted, signal),
    }),
    renewBeforeSubmission: (claim) => database.intents.renew(claim, config.leaseMs),
    readBlockhashValidity: async (
      artifact: SignedTransactionArtifactV1,
      minimumContextSlot: bigint,
      signal: AbortSignal,
    ) => {
      const evidence = await (await session(signal)).blockhashValidity(
        artifact.blockhash,
        minimumContextSlot,
        signal,
      );
      return Object.freeze({ ...evidence, observedAtMs: Date.now() });
    },
  };
  return Object.freeze(dependencies);
}

function simulationConfig(
  config: LiveExecutorConfig,
  maxRpcCallsPerAttempt: number,
): SimulationOnlyExecutorConfig {
  return Object.freeze({
    mode: 'simulation-only', databaseUrl: config.databaseUrl, pollMs: config.pollMs,
    leaseMs: config.leaseMs, databaseStatementTimeoutMs: config.databaseStatementTimeoutMs,
    shutdownGraceMs: config.shutdownGraceMs, executorPublicKey: config.executorPublicKey,
    providerId: config.providerId, httpRpcUrl: config.httpRpcUrl,
    expectedGenesisHash: config.expectedGenesisHash, quoteMaxAgeMs: config.quoteMaxAgeMs,
    slippageBps: config.slippageBps, snapshotMaxSlotLag: config.snapshotMaxSlotLag,
    maxComputeUnits: config.maxComputeUnits, maxFeeLamports: config.maxFeeLamports,
    maxFeePayerLamportDebit: config.maxFeePayerLamportDebit,
    maxPriorityFeeLamports: config.maxPriorityFeeLamports, rpcTimeoutMs: config.rpcTimeoutMs,
    maxRpcCallsPerAttempt, quoteMintAllowlist: config.quoteMintAllowlist,
  });
}

function runtimeBinding(
  config: LiveExecutorConfig,
  signer: ExecutionTransactionSigner,
  genesis: LiveRpcGenesisEvidenceV1,
): ExecutionLiveRuntimeBindingV1 {
  if (genesis.providerId !== config.providerId
    || genesis.expectedGenesisHash !== config.expectedGenesisHash
    || genesis.observedGenesisHash !== config.expectedGenesisHash) {
    throw new TypeError('Live genesis evidence does not match executor configuration.');
  }
  return Object.freeze({
    payloadVersion: 1,
    phase: config.phase,
    buildHash: config.buildHash,
    configurationFingerprint: config.configurationFingerprint,
    strategyFingerprint: config.strategyFingerprint,
    walletPublicKey: signer.publicKey,
    cluster: 'mainnet-beta',
    expectedGenesisHash: genesis.expectedGenesisHash,
    observedGenesisHash: genesis.observedGenesisHash,
    providerId: genesis.providerId,
  });
}

const SAFE_FATAL_NAMES = new Set([
  'LiveExecutorConfigError', 'LiveExecutorDatabaseError', 'LiveRpcError', 'LiveKeypairError',
  'LiveExecutorStartupError', 'LiveExecutorStartupValidationConsumedError',
  'Error', 'TypeError', 'RangeError', 'AggregateError',
]);

export function reportLiveExecutorEntrypointFailure(
  error: unknown,
  runtime: { exitCode?: string | number | undefined; stderr: Readonly<{ write(chunk: string): unknown }> } = process,
): void {
  runtime.exitCode = 1;
  runtime.stderr.write(`${JSON.stringify(Object.freeze({
    service: 'sol-token-executor-live',
    event: 'executor_live.start_failed',
    errorName: safeErrorProperty(error, 'name', SAFE_FATAL_NAMES, 'UnknownError'),
    errorCode: safeErrorProperty(
      error, 'code', LIVE_EXECUTOR_SAFE_ERROR_CODE_SET, 'LIVE_EXECUTOR_START_FAILED',
    ),
  }))}\n`);
}

function safeErrorProperty(error: unknown, key: 'name' | 'code', allowed: ReadonlySet<string>, fallback: string): string {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return fallback;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
      && allowed.has(descriptor.value) ? descriptor.value : fallback;
  } catch { return fallback; }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => { reportLiveExecutorEntrypointFailure(error); });
}
