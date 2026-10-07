import { isProxy } from 'node:util/types';
import type { AppConfig, ListenerCatchUpPolicy } from '../config/env.js';
import { createPumpFunWorkerAdmissionPolicy } from '../domain/worker-admission.js';
import {
  createRuntimeBlockHydrationPhaseEvidence,
  type RuntimeBlockHydrationPhaseEvidenceV1,
} from '../domain/block-hydration-phase-evidence.js';
import {
  snapshotRuntimeBlockHydrationAdmissionMetrics,
  type RuntimeBlockHydrationAdmissionMetricsV1,
} from '../domain/block-hydration-admission.js';
import {
  requireSolanaGenesisHash,
  SolanaGenesisHashError,
} from '../domain/solana-genesis-hash.js';
import { isRpcProviderId, RPC_PROVIDER_IDS, type RpcProviderId } from '../domain/rpc-provider.js';
import {
  ScannerPhaseDiagnosticsCollector,
  snapshotScannerPhaseDiagnostics,
  type ScannerPhaseDiagnosticsV1,
} from '../domain/scanner-phase-diagnostics.js';
import {
  createRuntimeRpcHttpEvidence,
  type RuntimeRpcHttpEvidenceV1,
} from '../domain/rpc-http-evidence.js';
import {
  createRuntimeRpcHttpRoleEvidence,
  type RuntimeRpcHttpRoleEvidenceV1,
} from '../domain/rpc-http-role-evidence.js';
import type {
  FinalityReconcilerDiagnosticReason,
  FinalityReconcilerDiagnosticV1,
} from '../domain/finality-reconciler-diagnostic.js';
import {
  createFirstProcessingCanaryEvidence,
  type RuntimeFirstProcessingCanaryEvidenceV1,
} from '../domain/first-processing-canary.js';
import {
  snapshotRuntimeWorkerAdmissionMetrics,
  snapshotRuntimeWorkerAdmissionClock,
  type RuntimeWorkerAdmissionMetricsV1,
  type RuntimeWorkerAdmissionClockV1,
} from '../domain/worker-admission-metrics.js';
import {
  assertValidInboxCounts,
  assertValidRuntimeHeartbeat,
  snapshotRuntimeCatchUpAdmissionMetrics,
  snapshotRuntimeDecoderQuarantineMetrics,
  type CatchUpGap,
  type InboxCounts,
  type ListenerRuntimeState,
  type RuntimeHeartbeat,
  type RuntimeBlockHydrationMetricsV1,
  type RuntimeCatchUpAdmissionMetricsV1,
} from '../domain/transaction-ingestion.js';
import {
  PumpFunLaunchpadAdapter,
  type PumpFunBondingCurveStateReader,
} from '../launchpads/pumpfun/pumpfun-launchpad.adapter.js';
import { PumpSwapFeeStateReader } from '../markets/pumpswap/pumpswap-fee-state.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import { PUMP_PROGRAM_ID } from '../launchpads/pumpfun/constants.js';
import { PumpSwapMarketAdapter } from '../markets/pumpswap/pumpswap-market.adapter.js';
import { PumpSwapQuoteProvider } from '../markets/pumpswap/pumpswap-quote.provider.js';
import { PumpSwapReserveReader } from '../markets/pumpswap/pumpswap-reserve-reader.js';
import { CanonicalPaperQuoteRouter } from '../paper/paper-quote-router.js';
import { PaperTradingEngine } from '../paper/paper-trading-engine.js';
import { PumpFunPaperQuoteProvider } from '../paper/pumpfun-paper-quote.provider.js';
import { RpcPumpSwapPoolValidator } from '../markets/pumpswap/pool-validator.js';
import type { ListenerRuntime } from '../ports/listener-runtime.js';
import type { MarketRpcReader } from '../ports/market-rpc-reader.js';
import type { TransactionInboxRepository } from '../ports/transaction-inbox-repository.js';
import { SolanaMarketRpcReader } from '../solana/rpc/market-rpc-reader.js';
import { createProviderPinnedCatchUpSource } from '../solana/rpc/provider-pinned-catch-up-source.js';
import {
  createProviderPinnedBlockRpc,
  type ProviderPinnedBlockRpc,
} from '../solana/rpc/provider-pinned-block-rpc.js';
import { createProviderPinnedFinalityPass } from '../solana/rpc/provider-pinned-finality-source.js';
import { createRpcProviderCatalog } from '../solana/rpc/rpc-provider-catalog.js';
import { SolanaRpcClient } from '../solana/rpc/rpc-client.js';
import { createRpcHttpEvidenceRecorder } from '../solana/rpc/rpc-http-evidence.js';
import { createRpcHttpRoleEvidenceRecorder } from '../solana/rpc/rpc-http-role-evidence.js';
import { OrdinaryRpcAttemptBudget } from '../solana/rpc/ordinary-rpc-attempt-budget.js';
import { openWsProgramSession } from '../solana/rpc/ws-program-session.js';
import type { RpcHttpFailoverEvent } from '../solana/rpc/http-failover-transport.js';
import { SolanaTransactionLocator } from '../solana/rpc/transaction-locator.js';
import type {
  TransactionLocationTarget,
  TransactionLocatorRpc,
} from '../solana/rpc/transaction-locator.js';
import {
  CachedSolanaBlockTransactionLocator,
  type EpochTransactionBlockRpc,
} from '../solana/rpc/block-transaction-cache.js';
import { getDatabasePool } from '../storage/database.js';
import { PostgresFastEntryRepository } from '../storage/fast-entry.repository.js';
import { PostgresLaunchpadEventRepository } from '../storage/launchpad-event.repository.js';
import { PostgresMarketObservationRepository } from '../storage/market-observation.repository.js';
import { PostgresPaperDecisionRepository } from '../storage/paper-decision.repository.js';
import { PostgresPaperTradingRepository } from '../storage/paper-trading.repository.js';
import { PostgresPaperVenueReader } from '../storage/paper-venue.reader.js';
import { PostgresQualificationProjectionRepository } from '../storage/qualification-projection.repository.js';
import { PostgresTrackedPoolRepository } from '../storage/tracked-pool.repository.js';
import { PostgresTrackedCurveRepository } from '../storage/tracked-curve.repository.js';
import { PostgresTransactionInboxRepository } from '../storage/transaction-inbox.repository.js';
import { PostgresWebSocketHealthRepository } from '../storage/websocket-health.repository.js';
import {
  FinalityReconciler,
  FinalityReconcilerError,
} from './finality-reconciler.js';
import {
  createFinalityDiagnosticTrackerState,
  recordFinalityDiagnosticFailure,
  recordFinalityDiagnosticRecovery,
  type FinalityDiagnosticTrackerState,
} from './finality-reconciler-diagnostic-tracker.js';
import { createFinalityReconcilerDiagnosticSink } from './finality-reconciler-diagnostic-logger.js';
import { listenerIngestionPrograms } from './listener-ingestion-programs.js';
import { LaunchpadObservationService } from './launchpad-observation.service.js';
import { MarketObservationService } from './market-observation.service.js';
import { DefaultFastEntryService } from './fast-entry.service.js';
import { ObservedTransactionPipeline } from './observed-transaction-pipeline.js';
import { PumpSwapObservationPipeline } from './pumpswap-observation-pipeline.js';
import { SolanaListenerRuntime } from './listener-runtime.js';
import {
  PromotedProviderSelector,
  type PromotedProviderSelection,
} from './promoted-provider-selector.js';
import { StrictCatchUpCoordinator } from './strict-catch-up-coordinator.js';
import { StrictCatchUpScanner } from './strict-catch-up-scanner.js';
import { ProviderAffineCatchUpHydration } from './provider-affine-catch-up-hydration.js';
import { PumpFunCatchUpBlockClassifier } from './pumpfun-catch-up-block-classifier.js';
import { PumpFunStrictCatchUpPageAdmitter } from './pumpfun-strict-catch-up-page-admitter.js';
import {
  TransactionInboxWorker,
  type TransactionInboxWorkerLocator,
} from './transaction-inbox-worker.js';
import { TrackedPoolPoller, type TrackedPoolPollerOptions } from './tracked-pool-poller.js';
import { TransactionInboxWorkerPool } from './transaction-inbox-worker-pool.js';
import { ListenerRpcWorkGate, gateBlockTransactionRpc } from './listener-rpc-work-gate.js';
import { WebSocketFailoverSupervisor } from './websocket-failover-supervisor.js';
import { PersistentWebSocketHealthReporter } from './websocket-health-reporter.js';
import {
  PaperDecisionWorker,
  createPaperDecisionStrategyRegistry,
} from './paper-decision-worker.js';
import { QualificationProjectionService } from './qualification-projection.service.js';
import { QualificationRebuildService } from './qualification-rebuild.service.js';
import { TradingCandidateService } from './trading-candidate.service.js';
import { ValidatedExternalBuysStrategy } from './validated-external-buys.strategy.js';
import { CreationEntryV1Strategy } from './creation-entry-v1.strategy.js';
import { QualificationEngine } from '../qualification/qualification-engine.js';
import { loadQualificationProfile } from '../qualification/qualification-profile.js';
import { logger } from '../utils/logger.js';
import {
  WorkerPhaseDiagnosticRecorder,
  type WorkerPhaseDiagnosticSnapshot,
} from './worker-phase-diagnostic.js';

type ProductionPool = ReturnType<typeof getDatabasePool>;
export const MAX_LISTENER_TIMER_DELAY_MS = 2_147_483_647;

export class BondingCurveReadUnavailableError extends Error {
  public constructor() {
    super('Generic Pump bonding-curve reads are unavailable in the passive listener.');
    this.name = 'BondingCurveReadUnavailableError';
    Object.freeze(this);
  }
}

export function createUnavailableBondingCurveReader(): PumpFunBondingCurveStateReader {
  return Object.freeze({
    read() {
      return Promise.reject(new BondingCurveReadUnavailableError());
    },
  });
}

type BlockHydrationConfig = Pick<AppConfig,
  | 'listenerBlockHydrationEnabled'
  | 'listenerBlockHydrationMaxEntries'
  | 'listenerBlockHydrationMaxBytes'
  | 'listenerBlockHydrationMaxEntryBytes'
  | 'listenerBlockHydrationConfirmedTtlMs'
  | 'listenerBlockHydrationFinalizedTtlMs'
  | 'listenerBlockHydrationFetchIntervalMs'>;

export interface ProductionBlockHydration {
  readonly locator: TransactionInboxWorkerLocator;
  readonly metrics: () => RuntimeBlockHydrationMetricsV1;
  readonly phaseEvidence: () => RuntimeBlockHydrationPhaseEvidenceV1 | null;
  readonly close: () => void;
}

const DISABLED_BLOCK_HYDRATION_METRICS: RuntimeBlockHydrationMetricsV1 = Object.freeze({
  version: 1, enabled: false, callerConcurrency: 1,
  locates: 0, hits: 0, misses: 0, inFlightJoins: 0, fetches: 0,
  forcedRefreshes: 0, evictions: 0, oversizeBypasses: 0, fetchFailures: 0,
  epochInvalidations: 0, retainedEntries: 0, retainedBytes: 0,
  inFlightFetches: 0, queuedFetches: 0,
  queueDelayMs: Object.freeze({ last: null, maximum: null }),
});

export function createProductionBlockHydration(
  config: BlockHydrationConfig,
  rpc: TransactionLocatorRpc & EpochTransactionBlockRpc,
): ProductionBlockHydration {
  if (!config.listenerBlockHydrationEnabled) {
    return Object.freeze({
      locator: new SolanaTransactionLocator(rpc),
      metrics: (): RuntimeBlockHydrationMetricsV1 => DISABLED_BLOCK_HYDRATION_METRICS,
      phaseEvidence: (): null => null,
      close: (): void => undefined,
    });
  }
  const locator = new CachedSolanaBlockTransactionLocator(rpc, {
    maxEntries: config.listenerBlockHydrationMaxEntries,
    maxBytes: config.listenerBlockHydrationMaxBytes,
    maxEntryBytes: config.listenerBlockHydrationMaxEntryBytes,
    confirmedTtlMs: config.listenerBlockHydrationConfirmedTtlMs,
    finalizedTtlMs: config.listenerBlockHydrationFinalizedTtlMs,
    fetchIntervalMs: config.listenerBlockHydrationFetchIntervalMs,
  });
  return Object.freeze({
    locator,
    metrics: (): RuntimeBlockHydrationMetricsV1 => Object.freeze({
      enabled: true,
      callerConcurrency: 1,
      ...locator.metrics,
    }),
    phaseEvidence: (): RuntimeBlockHydrationPhaseEvidenceV1 | null => locator.phaseEvidence,
    close: (): void => { locator.close(); },
  });
}

function logRpcHttpFailoverEvent(event: RpcHttpFailoverEvent): void {
  logger.warn(event, 'Événement de basculement HTTP RPC observé.');
}

type PassiveMentionSupervisor = Pick<WebSocketFailoverSupervisor,
  'start' | 'close' | 'state' | 'activeProviderId' | 'filteredNotificationMetrics'>;
type PassiveMentionShutdownDiagnostic = ReturnType<WebSocketFailoverSupervisor['filteredNotificationMetrics']>
  & Readonly<{ event: 'websocket_passive_mentions_shutdown' }>;

/** Shutdown-only evidence, not a live metric stream; no extra timers or resources. */
export function passiveMentionDiagnosticSupervisor(
  supervisor: PassiveMentionSupervisor,
  diagnostic: (event: PassiveMentionShutdownDiagnostic) => void,
): Pick<PassiveMentionSupervisor, 'start' | 'close' | 'state' | 'activeProviderId'> {
  let closing: Promise<void> | null = null;
  return Object.freeze({
    start: (): Promise<void> => supervisor.start(),
    state: (): ReturnType<PassiveMentionSupervisor['state']> => supervisor.state(),
    activeProviderId: (): ReturnType<PassiveMentionSupervisor['activeProviderId']> => supervisor.activeProviderId(),
    close(): Promise<void> {
      if (closing !== null) return closing;
      const result = new Promise<void>((resolve) => { resolve(supervisor.close()); });
      closing = result.finally(() => {
        try {
          diagnostic(Object.freeze({
            ...supervisor.filteredNotificationMetrics(),
            event: 'websocket_passive_mentions_shutdown',
          }));
        } catch {
          // Diagnostic delivery must never replace the supervisor close outcome.
        }
      });
      return closing;
    },
  });
}

export function createProductionListenerRuntime(
  config: AppConfig,
  pool?: ProductionPool,
): ListenerRuntime {
  const expectedGenesisHash = requireSolanaGenesisHash(
    config.expectedGenesisHash ?? undefined,
    true,
  );
  if (expectedGenesisHash === null) throw new SolanaGenesisHashError();
  const providers = createRpcProviderCatalog(config);
  const configuredRpcHttpProviderIds = Object.freeze(
    RPC_PROVIDER_IDS.slice(0, config.httpRpcFallbackUrls.length + 1),
  );
  const ingestionPrograms = listenerIngestionPrograms(config.listenerIngestionScope);
  const createsOnly = config.listenerIngestionScope === 'creates-only';
  const databasePool = pool ?? getDatabasePool();
  const recorder = createRpcHttpEvidenceRecorder();
  const roleRecorder = createRpcHttpRoleEvidenceRecorder();
  const attemptBudget = config.listenerOrdinaryRpcBudgetEnabled ? new OrdinaryRpcAttemptBudget() : undefined;
  const rpcWorkGate = config.listenerWorkerCount > 1 ? new ListenerRpcWorkGate() : null;
  const rpcRequestTimeoutMs = rpcWorkGate === null
    ? config.listenerShutdownTimeoutMs
    : Math.max(1, Math.floor(config.listenerShutdownTimeoutMs / 2));
  const rpc = new SolanaRpcClient(config, {
    recorder,
    roleRecorder,
    ...(attemptBudget === undefined ? {} : { attemptBudget }),
    onHttpFailoverEvent: logRpcHttpFailoverEvent,
    ...(rpcWorkGate === null && attemptBudget === undefined ? {} : {
      requestTimeoutMs: rpcRequestTimeoutMs,
    }),
  });
  const gatedBlockRpc = rpcWorkGate === null ? null : gateBlockTransactionRpc(rpcWorkGate, rpc);
  const workerBlockRpc: TransactionLocatorRpc & EpochTransactionBlockRpc = gatedBlockRpc === null
    ? rpc
    : Object.freeze({
      get httpTransportEpoch(): number { return rpc.httpTransportEpoch; },
      getTransaction(
        signature: string,
        status: TransactionLocationTarget['confirmationStatus'],
      ) { return rpc.getTransaction(signature, status); },
      getBlockSignatures(
        slot: bigint,
        status: TransactionLocationTarget['confirmationStatus'],
      ) { return rpc.getBlockSignatures(slot, status); },
      getBlockTransactions(
        slot: bigint,
        status: TransactionLocationTarget['confirmationStatus'],
        signal?: AbortSignal,
      ) { return gatedBlockRpc.getBlockTransactions(slot, status, signal); },
    });
  const workerAdmissionPolicy = createPumpFunWorkerAdmissionPolicy({
    enabled: config.listenerPumpFunBoundedWorkerAdmissionEnabled,
    trackingWindowSeconds: config.listenerPumpFunTrackingWindowSeconds,
  });
  const inbox = new PostgresTransactionInboxRepository(databasePool, Object.freeze({
    maxAttempts: config.rpcRetryMaxAttempts,
    baseDelayMs: config.rpcRetryBaseDelayMs,
  }), workerAdmissionPolicy);
  const promoted = new PromotedProviderSelector(
    providers.ids.map((providerId) => createProviderPinnedFinalityPass(
      providers, providerId, undefined, recorder, roleRecorder, attemptBudget, rpcRequestTimeoutMs,
    )),
  );
  const hydration = config.listenerPumpFunCatchUpPageAdmissionEnabled
    ? new ProviderAffineCatchUpHydration(new Map(providers.ids.map((providerId) => [
      providerId, ((): ProviderPinnedBlockRpc => {
        const pinned = createProviderPinnedBlockRpc(providers, providerId, config.commitment, undefined, {
          requestTimeoutMs: rpcRequestTimeoutMs,
        }, recorder, roleRecorder, attemptBudget);
        if (rpcWorkGate === null) return pinned;
        const gated = gateBlockTransactionRpc(rpcWorkGate, pinned);
        return Object.freeze({
          providerId: pinned.providerId,
          getBlockTransactions: (
            slot: bigint,
            status: TransactionLocationTarget['confirmationStatus'],
            signal?: AbortSignal,
          ) => gated.getBlockTransactions(slot, status, signal),
        });
      })(),
    ])), {
      maxEntries: config.listenerBlockHydrationMaxEntries,
      maxBytes: config.listenerBlockHydrationMaxBytes,
      maxEntryBytes: config.listenerBlockHydrationMaxEntryBytes,
      confirmedTtlMs: config.listenerBlockHydrationConfirmedTtlMs,
      finalizedTtlMs: config.listenerBlockHydrationFinalizedTtlMs,
      fetchIntervalMs: config.listenerBlockHydrationFetchIntervalMs,
      currentSelection: (): PromotedProviderSelection => promoted.selection(),
    }) : null;
  const blockHydration: ProductionBlockHydration = hydration === null
    ? createProductionBlockHydration(config, workerBlockRpc)
    : Object.freeze({
      locator: hydration.workerLocator(),
      metrics: (): RuntimeBlockHydrationMetricsV1 => hydration.metrics(),
      phaseEvidence: (): RuntimeBlockHydrationPhaseEvidenceV1 | null => hydration.phaseEvidence(),
      close: (): void => { hydration.close(); },
    });
  const scannerPhaseDiagnostics = new ScannerPhaseDiagnosticsCollector();
  const pageAdmitters = new Map(hydration === null ? [] : providers.ids.map((providerId) => [
    providerId,
    new PumpFunStrictCatchUpPageAdmitter(new PumpFunCatchUpBlockClassifier(
      hydration.classifierLocator(providerId), inbox, Date.now, Object.freeze({
        coverageFastPathEnabled: config.listenerPumpFunCatchUpCoverageFastPathEnabled,
        coverageRepository: config.listenerPumpFunCatchUpCoverageFastPathEnabled ? inbox : null,
        slotPersistencePipelineEnabled: workerAdmissionPolicy.enabled,
        diagnosticProviderId: providerId,
        diagnosticObserver: scannerPhaseDiagnostics,
      }),
    )),
  ] as const));
  const websocketHealth = new PostgresWebSocketHealthRepository(databasePool);
  const websocketReporter = new PersistentWebSocketHealthReporter(
    inbox,
    websocketHealth,
    {
      touchIntervalMs: 5_000,
      shutdownTimeoutMs: config.listenerShutdownTimeoutMs,
    },
  );
  const pinnedCatchUpSources = new Map(
    providers.ids.map((providerId) => {
      const source = createProviderPinnedCatchUpSource(
        providers,
        providerId,
        'confirmed',
        expectedGenesisHash,
        undefined,
        recorder,
        roleRecorder,
        attemptBudget,
        rpcRequestTimeoutMs,
      );
      return [providerId, source] as const;
    }),
  );
  const strictCheckpointKeys = Object.freeze(ingestionPrograms.map(({ key }) => key));
  const strictCoordinators = new Map<RpcProviderId, StrictCatchUpCoordinator>(
    providers.ids.map((providerId) => {
      const source = pinnedCatchUpSources.get(providerId);
      if (source === undefined) {
        throw new TypeError('Provider-pinned catch-up source is unavailable.');
      }
      const recoveryScanner = new StrictCatchUpScanner(
        source,
        inbox,
        {
          pageSize: config.listenerCatchUpPageSize,
          maxPages: config.listenerCatchUpMaxPages,
          policy: 'strict',
          programs: ingestionPrograms,
          diagnosticObserver: scannerPhaseDiagnostics,
        },
        pageAdmitters.get(providerId),
      );
      return [
        providerId,
        new StrictCatchUpCoordinator(recoveryScanner, inbox, strictCheckpointKeys),
      ] as const;
    }),
  );
  const strictAffinity = strictCoordinators.get('primary');
  if (strictAffinity === undefined) throw new TypeError('Strict catch-up coordinator is unavailable.');
  const supervisor = new WebSocketFailoverSupervisor(
    {
      providers,
      health: websocketHealth,
      reporter: websocketReporter,
      promoted,
      // creates-only never runs strict catch-up, so a run left by another scope must not pin it.
      readPinnedProviderId: (signal): Promise<RpcProviderId | null> => (createsOnly
        ? Promise.resolve(null)
        : strictAffinity.readPinnedProviderId(signal)),
      verifyProviderGenesis: (providerId, signal): Promise<void> => {
        const source = pinnedCatchUpSources.get(providerId);
        if (source === undefined) {
          return Promise.reject(new TypeError('Provider-pinned catch-up source is unavailable.'));
        }
        return source.verifyGenesis(signal);
      },
      prepareInitialFrontier: async (providerId, signal): Promise<void> => {
        if (createsOnly || config.listenerCatchUpPolicy !== 'live-edge') return;
        const source = pinnedCatchUpSources.get(providerId);
        if (source === undefined) {
          throw new TypeError('Provider-pinned catch-up source is unavailable.');
        }
        const baselineScanner = new StrictCatchUpScanner(source, inbox, {
          pageSize: config.listenerCatchUpPageSize,
          maxPages: config.listenerCatchUpMaxPages,
          policy: 'live-edge',
          programs: ingestionPrograms,
          diagnosticObserver: scannerPhaseDiagnostics,
        }, pageAdmitters.get(providerId));
        if (hydration === null) await baselineScanner.scan(signal);
        else await hydration.runStrictScan(providerId, (scanSignal) => baselineScanner.scan(scanSignal), signal);
      },
      openSession: (endpoint, observe, signal): ReturnType<typeof openWsProgramSession> => openWsProgramSession(
        endpoint,
        observe,
        signal,
        {
          programs: ingestionPrograms,
          workerAdmissionEnabled: workerAdmissionPolicy.enabled,
          createsOnly,
        },
      ),
      runStrictScan: (providerId, signal): ReturnType<StrictCatchUpCoordinator['run']> => {
        // A missed create is a lost opportunity, not a gap to repair.
        if (createsOnly) {
          return Promise.resolve(Object.freeze({
            providerId, discoveredCount: 0, enqueuedCount: 0, checkpointCasCount: 0, pageCount: 0,
            boundaries: Object.freeze({ launchpad: null, market: null }),
          }));
        }
        const coordinator = strictCoordinators.get(providerId);
        if (coordinator === undefined) {
          return Promise.reject(new TypeError('Strict catch-up coordinator is unavailable.'));
        }
        return hydration === null ? coordinator.run(signal)
          : hydration.runStrictScan(providerId, (scanSignal) => coordinator.run(scanSignal), signal);
      },
    },
    {
      now: Date.now,
      random: Math.random,
      scheduler: listenerScheduler,
    },
  );
  const reconciler = new RecurringFinalityReconciler(
    new FinalityReconciler(promoted, inbox, {
      limit: 100,
      missingPollThreshold: config.listenerFinalityMissingPolls,
    }),
    {
      intervalMs: config.reconcileSeconds * 1_000,
      shutdownTimeoutMs: config.listenerShutdownTimeoutMs,
      initialFailureMode: 'DEGRADED_RETRY',
      currentSelection: (): PromotedProviderSelection => promoted.selection(),
      diagnosticSink: createFinalityReconcilerDiagnosticSink(logger),
    },
  );

  const launchpadRepository = new PostgresLaunchpadEventRepository(
    databasePool,
    config.dataRetentionHours,
    Date.now,
    workerAdmissionPolicy,
  );
  const pump = new PumpFunLaunchpadAdapter(createUnavailableBondingCurveReader());
  const launchpad = new LaunchpadObservationService(pump, launchpadRepository);

  const directMarketRpc = new SolanaMarketRpcReader(rpc.http, config.commitment);
  const marketRpc: MarketRpcReader = rpcWorkGate === null
    ? directMarketRpc
    : Object.freeze({
      readAccountsAtSameSlot: (addresses: readonly string[]) => rpcWorkGate.run(
        () => directMarketRpc.readAccountsAtSameSlot(addresses),
      ),
    });
  const feeState = new PumpSwapFeeStateReader(marketRpc);
  const market = new PumpSwapMarketAdapter(
    undefined,
    new RpcPumpSwapPoolValidator(marketRpc),
    new PumpSwapReserveReader(marketRpc),
    new PumpSwapQuoteProvider((marketPool) => feeState.read(marketPool)),
    () => undefined,
  );
  const marketService = new MarketObservationService(
    new PostgresMarketObservationRepository(databasePool, config.dataRetentionHours),
  );
  const marketPipeline = new PumpSwapObservationPipeline(pump, market, marketService);
  const qualificationProfile = loadQualificationProfile({
    profilePath: config.qualificationProfilePath,
    minimumScoreOverride: config.qualificationMinimumScore,
  });
  const paperRepository = new PostgresPaperDecisionRepository(databasePool, {
    maxAttempts: config.paperDecisionRetryMaxAttempts,
    baseDelayMs: config.paperDecisionRetryBaseDelayMs,
    retentionHours: 4,
    executionIntentEmission: config.executionIntentEmissionEnabled ? Object.freeze({
      quoteMintAllowlist: config.paperQuoteMintAllowlist,
      wsolMint: config.wsolMint,
      maximumQuoteAgeMs: config.paperQuoteMaxAgeMs,
      preflightPairEmissionEnabled: config.executionPreflightPairEmissionEnabled,
    }) : null,
  }, qualificationProfile);
  const qualificationEngine = new QualificationEngine(qualificationProfile);
  const qualificationRebuilder = new QualificationRebuildService(qualificationEngine);
  const qualification = new QualificationProjectionService(
    new PostgresQualificationProjectionRepository(databasePool, qualificationRebuilder),
    qualificationRebuilder,
    config.paperQuoteMintAllowlist,
  );
  const pumpFunQuotes = new PumpFunPaperQuoteProvider(marketRpc);
  const quoteRouter = new CanonicalPaperQuoteRouter(
    new PostgresPaperVenueReader(() => rpc.getSlot(), databasePool),
    pumpFunQuotes,
    market,
    {
      maxAgeMs: config.paperQuoteMaxAgeMs,
      maxSlotLag: BigInt(config.paperQuoteMaxSlotLag),
    },
  );
  const paperTrading = new PaperTradingEngine(
    config,
    new PostgresPaperTradingRepository(databasePool),
    qualificationProfile,
    qualificationEngine,
  );
  const legacyPaperStrategy = new ValidatedExternalBuysStrategy(
    paperTrading,
    quoteRouter,
    { retentionMs: 14_400_000 },
  );
  const creationPaperStrategy = new CreationEntryV1Strategy(paperTrading, quoteRouter, {
    retentionMs: 14_400_000,
    externalMinimumBuyAmountRaw: config.externalMinimumBuyAmountRaw ?? 1n,
    takeProfitMultiplierBps: config.creationTakeProfitMultiplierBps,
    manualKillSwitch: config.creationManualKillSwitch,
  });
  const paperStrategy = createPaperDecisionStrategyRegistry({
    activeStrategyId: config.creationStrategyEnabled
      ? 'creation-entry-v1'
      : 'validated-external-buys',
    legacy: legacyPaperStrategy,
    creation: creationPaperStrategy,
  });
  const paperWorker = new PaperDecisionWorker(
    paperRepository,
    quoteRouter,
    qualification,
    new TradingCandidateService({
      strategy: { id: config.paperStrategyId, version: config.paperStrategyVersion },
      quoteMintAllowlist: config.paperQuoteMintAllowlist,
      minimumConfirmation: config.paperMinimumConfirmation,
      entryWindowMs: config.paperEntryWindowSeconds * 1_000,
      maximumQuoteAgeMs: config.paperQuoteMaxAgeMs,
      maximumQuoteSlotLag: BigInt(config.paperQuoteMaxSlotLag),
      retentionMs: 14_400_000,
      creationEntryMaxAgeMs: config.creationEntryMaxAgeMs,
      creationEntryMaxSlotLag: BigInt(config.creationEntryMaxSlotLag),
    }),
    paperStrategy,
    {
      executionMode: config.executionMode,
      paperStrategyEnabled: config.paperStrategyEnabled,
      quoteMintAllowlist: config.paperQuoteMintAllowlist,
      entryQuoteAmountRaw: config.paperEntryQuoteAmountRaw ?? 1n,
      slippageBps: config.paperSlippageBps ?? 0n,
      externalBuyTarget: config.paperExternalBuyTarget,
      minimumConfirmation: config.paperMinimumConfirmation,
      maximumRoundTripLossBps: BigInt(config.riskMaxRoundTripLossBps),
      pollIntervalMs: config.paperDecisionWorkerPollMs,
      leaseMs: config.paperDecisionWorkerLeaseSeconds * 1_000,
      renewalIntervalMs: Math.max(
        1_000,
        Math.floor(config.paperDecisionWorkerLeaseSeconds * 1_000 / 3),
      ),
      shutdownTimeoutMs: config.listenerShutdownTimeoutMs,
      manualKillSwitch: config.creationManualKillSwitch,
      isReady: (): boolean => {
        const selection = promoted.selection();
        return supervisor.state() === 'RUNNING'
          && selection.providerId !== null
          && reconciler.state() === 'RUNNING'
          && reconciler.isReadyFor(selection);
      },
    },
  );
  const fastEntry = config.entryMode === 'fast'
    ? new DefaultFastEntryService({
      repository: new PostgresFastEntryRepository(databasePool),
      quotes: pumpFunQuotes,
      maximumRoundTripLossBps: BigInt(config.riskMaxRoundTripLossBps),
      ...(config.fastEntryProbeEnabled ? { probe: { intervalMs: config.fastEntryProbeIntervalMs } } : {}),
      onDecision: (event): void => {
        logger.info({ event: 'listener.fast_entry_decision', ...event }, 'Décision d\'entrée rapide.');
      },
      onProbe: (event): void => {
        logger.info({ event: 'listener.fast_entry_probe', ...event }, 'Sonde d\'entrée rapide (gate 10).');
      },
      onError: (event): void => {
        logger.warn({ event: 'listener.fast_entry_error', ...event }, 'Entrée rapide en erreur.');
      },
    })
    : null;
  const pipeline = new ObservedTransactionPipeline(
    launchpadRepository,
    launchpad,
    marketPipeline,
    paperRepository,
    qualification,
    inbox,
    fastEntry,
  );

  const workerPhaseRecorder = new WorkerPhaseDiagnosticRecorder();
  const worker = new TransactionInboxWorkerPool(Array.from(
    { length: config.listenerWorkerCount },
    () => new TransactionInboxWorker(inbox, blockHydration.locator, pipeline, {
      phaseObserver: workerPhaseRecorder,
      leaseSeconds: config.listenerWorkerLeaseSeconds,
      renewalIntervalMs: Math.max(1_000, Math.floor(config.listenerWorkerLeaseSeconds * 1_000 / 3)),
      idlePollMs: 1_000,
      ...(hydration === null ? {} : { claimAdmission: hydration.workerAdmission() }),
    }),
  ), config.listenerWorkerCount === 1 ? {} : {
    beforeStart: async (): Promise<void> => {
      if (await inbox.hasNonTerminalProgramWork(PUMPSWAP_PROGRAM_ID)) {
        throw new Error('Multi-worker listener requires no non-terminal PumpSwap work.');
      }
    },
  });
  const workerComponent = lifecycleComponent(
    worker,
    blockHydration.close,
    (): void => { rpcWorkGate?.close(); },
  );
  const paperWorkerComponent = lifecycleComponent(paperWorker);
  const heartbeat = new PersistentListenerHeartbeat(
    inbox,
    rpc,
    () => supervisor.state(),
    () => supervisor.state(),
    () => worker.state,
    () => reconciler.state(),
    {
      intervalMs: 5_000,
      shutdownTimeoutMs: config.listenerShutdownTimeoutMs,
      blockHydrationMetrics: blockHydration.metrics,
      blockHydrationPhaseEvidenceMetrics: blockHydration.phaseEvidence,
      rpcHttpEvidenceMetrics: (): RuntimeRpcHttpEvidenceV1 => recorder.snapshot(configuredRpcHttpProviderIds),
      rpcHttpRoleEvidenceMetrics: (): RuntimeRpcHttpRoleEvidenceV1 => roleRecorder.snapshot(),
      scannerPhaseDiagnosticsMetrics: (sampledAtMs): ScannerPhaseDiagnosticsV1 =>
        scannerPhaseDiagnostics.snapshot(sampledAtMs),
      inboxSnapshot: (): ReturnType<PostgresTransactionInboxRepository['heartbeatSnapshot']> =>
        inbox.heartbeatSnapshot(),
      ...(hydration === null ? {} : {
        blockHydrationAdmissionMetrics: (): RuntimeBlockHydrationAdmissionMetricsV1 => hydration.admissionMetrics(),
        catchUpAdmissionMetrics: (counts: InboxCounts): RuntimeCatchUpAdmissionMetricsV1 => Object.freeze({
          version: 1,
          enabled: true,
          ...hydration.state(),
          ...counts.catchUpAdmission,
        }),
      }),
    },
  );

  const runtime = new SolanaListenerRuntime({
    supervisor: passiveMentionDiagnosticSupervisor(supervisor, (event): void => {
      logger.info(event, 'Bilan des mentions Pump passives à la fermeture WebSocket.');
    }),
    worker: workerPhaseDiagnosticComponent(workerComponent, workerPhaseRecorder, (event): void => {
      logger.info(event, 'Bilan des phases worker à la fermeture du listener.');
    }),
    paperWorker: paperWorkerComponent,
    reconciler,
    heartbeat,
  }, {
    shutdownTimeoutMs: config.listenerShutdownTimeoutMs,
    marketIngestionEnabled: config.listenerIngestionScope === 'launchpad-and-market',
  });
  const pollerRpc: TrackedPoolPollerOptions['rpc'] = {
    getSignaturesForAddress: (address, { before, ...options }, commitment): Promise<unknown> => rpc.http.getSignaturesForAddress(
      address,
      before === undefined ? options : { ...options, before },
      commitment,
    ),
  };
  const pollerTiming = {
    intervalMs: config.listenerTrackedPoolPollIntervalMs,
    trackingWindowSeconds: config.listenerPumpFunTrackingWindowSeconds,
    shutdownTimeoutMs: config.listenerShutdownTimeoutMs,
    scheduler: listenerScheduler,
  };
  const pollers: TrackedPoolPoller[] = [];
  if (config.listenerTrackedPoolPollEnabled) {
    pollers.push(new TrackedPoolPoller({
      repository: new PostgresTrackedPoolRepository(databasePool),
      inbox,
      rpc: pollerRpc,
      ...pollerTiming,
      onCycle: (report): void => {
        logger.info({ event: 'listener.tracked_pool_poll_cycle', ...report }, 'Cycle de sondage des pools suivis terminé.');
      },
      onPool: (report): void => {
        logger.warn({ event: 'listener.tracked_pool_poll_pool', ...report }, 'Pool suivi hors succès.');
      },
    }));
  }
  if (createsOnly) {
    pollers.push(new TrackedPoolPoller({
      repository: new PostgresTrackedCurveRepository(databasePool),
      ingestionHint: 'PUMPFUN_CURVE_TRADE',
      programId: PUMP_PROGRAM_ID,
      inbox,
      rpc: pollerRpc,
      ...pollerTiming,
      onCycle: (report): void => {
        logger.info({ event: 'listener.tracked_curve_poll_cycle', ...report }, 'Cycle de sondage des bonding curves suivies terminé.');
      },
      onPool: (report): void => {
        logger.warn({ event: 'listener.tracked_curve_poll_curve', ...report }, 'Bonding curve suivie hors succès.');
      },
    }));
  }
  if (pollers.length === 0 && attemptBudget === undefined) return runtime;
  return Object.freeze({
    async start(): Promise<void> {
      try { await runtime.start(); } catch (error) { attemptBudget?.close(); throw error; }
      // The first poll cycle can wait on RPC for seconds and app.ts only opens the API
      // after start() resolves; start() never rejects (a failed cycle leaves it DEGRADED).
      for (const poller of pollers) void poller.start();
    },
    async close(): Promise<void> {
      try { await Promise.all(pollers.map((poller) => poller.close())); } finally { attemptBudget?.close(); await runtime.close(); }
    },
    state: () => runtime.state(),
    pipelineState: () => runtime.pipelineState(),
  });
}

export function catchUpGapLogContext(
  gap: CatchUpGap,
  policy: ListenerCatchUpPolicy,
): Readonly<{
  event: 'listener.catch_up_gap_recorded';
  program: CatchUpGap['key'];
  previousSlot: string;
  baselineSlot: string;
  policy: ListenerCatchUpPolicy;
}> {
  return Object.freeze({
    event: 'listener.catch_up_gap_recorded',
    program: gap.key,
    previousSlot: gap.previousSlot.toString(),
    baselineSlot: gap.baselineSlot.toString(),
    policy,
  });
}

export interface ListenerRuntimeScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface RecurringListenerOptions {
  readonly intervalMs: number;
  readonly shutdownTimeoutMs: number;
  readonly scheduler?: ListenerRuntimeScheduler;
}

export interface ListenerHeartbeatOptions extends RecurringListenerOptions {
  readonly inboxSnapshot?: () => Promise<Readonly<{
    counts: InboxCounts;
    workerAdmission: RuntimeWorkerAdmissionMetricsV1;
    workerAdmissionClock?: RuntimeWorkerAdmissionClockV1;
  }>>;
  readonly blockHydrationMetrics?: () => RuntimeBlockHydrationMetricsV1;
  readonly blockHydrationPhaseEvidenceMetrics?: () => RuntimeBlockHydrationPhaseEvidenceV1 | null;
  readonly blockHydrationAdmissionMetrics?: () => RuntimeBlockHydrationAdmissionMetricsV1;
  readonly catchUpAdmissionMetrics?: (counts: InboxCounts) => RuntimeCatchUpAdmissionMetricsV1;
  readonly rpcHttpEvidenceMetrics?: () => RuntimeRpcHttpEvidenceV1;
  readonly rpcHttpRoleEvidenceMetrics?: () => RuntimeRpcHttpRoleEvidenceV1;
  readonly workerAdmissionMetrics?: () => Promise<RuntimeWorkerAdmissionMetricsV1>;
  readonly scannerPhaseDiagnosticsMetrics?: (sampledAtMs: number) => ScannerPhaseDiagnosticsV1;
}

export type InitialFinalityFailureMode = 'FAIL_START' | 'DEGRADED_RETRY';

export interface RecurringFinalityOptions extends RecurringListenerOptions {
  readonly initialFailureMode?: InitialFinalityFailureMode;
  readonly currentSelection?: () => PromotedProviderSelection;
  readonly diagnosticSink?: (diagnostic: FinalityReconcilerDiagnosticV1) => void;
  readonly diagnosticNow?: () => number;
}

export class ListenerControllerCloseError extends Error {
  public constructor(
    public readonly component: 'heartbeat' | 'reconciler',
    public readonly reason: 'dependency' | 'timeout',
  ) {
    super('Passive listener controller cleanup failed.');
    this.name = 'ListenerControllerCloseError';
    Object.freeze(this);
  }
}

const listenerScheduler: ListenerRuntimeScheduler = Object.freeze({
  schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  cancel(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

type ProviderSelectionDiagnosticReason = Extract<
  FinalityReconcilerDiagnosticReason,
  'PROVIDER_UNAVAILABLE' | 'PROVIDER_CHANGED'
>;

class FinalityProviderSelectionError extends Error {
  public constructor(
    public readonly reasonCode: ProviderSelectionDiagnosticReason,
    message: string,
  ) {
    super(message);
    this.name = 'FinalityProviderSelectionError';
    Object.freeze(this);
  }
}

export class RecurringFinalityReconciler {
  private currentState: ListenerRuntimeState = 'STOPPED';
  private readonly intervalMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly scheduler: ListenerRuntimeScheduler;
  private readonly initialFailureMode: InitialFinalityFailureMode;
  private readonly currentSelection: (() => PromotedProviderSelection) | null;
  private readonly diagnosticSink: ((diagnostic: FinalityReconcilerDiagnosticV1) => void) | null;
  private readonly diagnosticNow: () => number;
  private diagnosticState: FinalityDiagnosticTrackerState = createFinalityDiagnosticTrackerState();
  private currentReadySelection: PromotedProviderSelection | null = null;
  private timer: unknown = null;
  private inFlight: Promise<unknown> | null = null;
  private closePromise: Promise<void> | null = null;
  private closed = false;

  public constructor(
    private readonly reconciler: { readonly runOnce: () => Promise<unknown> },
    options: RecurringFinalityOptions,
  ) {
    validateRecurringOptions(options);
    const configuredInitialFailureMode: unknown = options.initialFailureMode;
    const initialFailureMode = configuredInitialFailureMode ?? 'FAIL_START';
    if (initialFailureMode !== 'FAIL_START' && initialFailureMode !== 'DEGRADED_RETRY') {
      throw new TypeError('Initial finality failure mode is invalid.');
    }
    this.intervalMs = options.intervalMs;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs;
    this.scheduler = options.scheduler ?? listenerScheduler;
    this.initialFailureMode = initialFailureMode;
    if (options.currentSelection !== undefined
      && typeof options.currentSelection !== 'function') {
      throw new TypeError('Current finality provider selector is invalid.');
    }
    this.currentSelection = options.currentSelection ?? null;
    const configuredDiagnosticSink: unknown = options.diagnosticSink;
    if (configuredDiagnosticSink !== undefined
      && typeof configuredDiagnosticSink !== 'function') {
      throw new TypeError('Finality diagnostic sink is invalid.');
    }
    this.diagnosticSink = configuredDiagnosticSink === undefined
      ? null
      : configuredDiagnosticSink as (diagnostic: FinalityReconcilerDiagnosticV1) => void;
    const configuredDiagnosticNow: unknown = options.diagnosticNow;
    if (configuredDiagnosticNow !== undefined
      && typeof configuredDiagnosticNow !== 'function') {
      throw new TypeError('Finality diagnostic clock is invalid.');
    }
    this.diagnosticNow = configuredDiagnosticNow === undefined
      ? Date.now
      : configuredDiagnosticNow as () => number;
  }

  public async start(): Promise<void> {
    if (this.closed) return;
    this.currentState = 'STARTING';
    this.currentReadySelection = null;
    const operation = this.runCurrentPass();
    this.inFlight = operation;
    try {
      await operation;
      if (this.inFlight === operation) this.inFlight = null;
      if (this.hasClosed()) return;
      this.currentState = 'RUNNING';
      this.recordDiagnosticRecovery();
      this.schedule();
    } catch (error) {
      if (this.inFlight === operation) this.inFlight = null;
      if (this.hasClosed()) {
        if (this.initialFailureMode === 'FAIL_START') throw error;
        return;
      }
      this.currentState = 'DEGRADED';
      this.recordDiagnosticFailure(error);
      if (this.initialFailureMode === 'FAIL_START') throw error;
      this.schedule();
    }
  }

  private hasClosed(): boolean {
    return this.closed;
  }

  public close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    if (this.timer !== null) this.scheduler.cancel(this.timer);
    this.timer = null;
    const operation = this.performClose();
    this.closePromise = operation;
    return operation;
  }

  public state(): ListenerRuntimeState {
    return this.currentState;
  }

  public readyProviderId(): RpcProviderId | null {
    return this.currentReadySelectionIfCurrent()?.providerId ?? null;
  }

  public isReadyFor(selection: PromotedProviderSelection): boolean {
    const expected = snapshotProviderSelection(selection);
    const ready = this.currentReadySelectionIfCurrent();
    return this.currentState === 'RUNNING'
      && ready !== null
      && sameProviderSelection(ready, expected);
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = this.scheduler.schedule(() => {
      this.timer = null;
      if (this.closed) return;
      this.currentReadySelection = null;
      const operation = this.runCurrentPass();
      this.inFlight = operation;
      void operation.then(
        () => {
          if (this.inFlight === operation) this.inFlight = null;
          if (this.closed) return;
          this.currentState = 'RUNNING';
          this.recordDiagnosticRecovery();
          this.schedule();
        },
        (error: unknown) => {
          if (this.inFlight === operation) this.inFlight = null;
          if (this.closed) return;
          this.currentReadySelection = null;
          this.currentState = 'DEGRADED';
          this.recordDiagnosticFailure(error);
          this.schedule();
        },
      );
    }, this.intervalMs);
  }

  private async performClose(): Promise<void> {
    this.currentReadySelection = null;
    const running = this.inFlight;
    if (running !== null) {
      const result = await settleController(running, this.shutdownTimeoutMs);
      if (result === 'timeout') {
        this.currentState = 'DEGRADED';
        throw new ListenerControllerCloseError('reconciler', 'timeout');
      }
    }
    this.currentState = 'STOPPED';
  }

  private async runCurrentPass(): Promise<void> {
    this.currentReadySelection = null;
    if (this.currentSelection === null) {
      await this.reconciler.runOnce();
      return;
    }
    const selection = this.readCurrentSelection();
    if (selection.providerId === null) {
      throw new FinalityProviderSelectionError(
        'PROVIDER_UNAVAILABLE',
        'Current finality provider is unavailable.',
      );
    }
    await this.reconciler.runOnce();
    if (!sameProviderSelection(this.readCurrentSelection(), selection)) {
      throw new FinalityProviderSelectionError(
        'PROVIDER_CHANGED',
        'Current finality provider changed.',
      );
    }
    if (!this.closed) this.currentReadySelection = selection;
  }

  private currentReadySelectionIfCurrent(): PromotedProviderSelection | null {
    const ready = this.currentReadySelection;
    if (ready === null || this.currentSelection === null) return null;
    try {
      if (sameProviderSelection(ready, this.readCurrentSelection())) return ready;
    } catch {
      // Invalid or unavailable current selections revoke readiness below.
    }
    this.currentReadySelection = null;
    return null;
  }

  private readCurrentSelection(): PromotedProviderSelection {
    try {
      const selection: unknown = Reflect.apply(
        this.currentSelection as () => unknown,
        undefined,
        [],
      );
      return snapshotProviderSelection(selection);
    } catch {
      // Converted to one fixed provider-unavailable result below.
    }
    throw new FinalityProviderSelectionError(
      'PROVIDER_UNAVAILABLE',
      'Current finality provider is unavailable.',
    );
  }

  private recordDiagnosticFailure(error: unknown): void {
    try {
      const reduction = recordFinalityDiagnosticFailure(
        this.diagnosticState,
        classifyFinalityReconcilerFailure(error),
        this.readDiagnosticNow(),
      );
      this.diagnosticState = reduction.state;
      this.offerDiagnostic(reduction.diagnostic);
    } catch {
      // Diagnostics cannot affect finality state, retry cadence or readiness.
    }
  }

  private recordDiagnosticRecovery(): void {
    if (this.diagnosticState.degradedAtMs === null) return;
    try {
      const reduction = recordFinalityDiagnosticRecovery(
        this.diagnosticState,
        this.readDiagnosticNow(),
      );
      this.diagnosticState = reduction.state;
      this.offerDiagnostic(reduction.diagnostic);
    } catch {
      // Diagnostics cannot affect finality state, retry cadence or readiness.
    }
  }

  private readDiagnosticNow(): number {
    try {
      const sampled: unknown = Reflect.apply(this.diagnosticNow, undefined, []);
      if (isDiagnosticTime(sampled)) return sampled;
    } catch {
      // Fall through to the trusted process clock below.
    }
    try {
      const fallback = Date.now();
      if (isDiagnosticTime(fallback)) return fallback;
    } catch {
      // A process-clock failure remains confined to diagnostics.
    }
    return this.diagnosticState.lastObservedAtMs ?? 0;
  }

  private offerDiagnostic(diagnostic: FinalityReconcilerDiagnosticV1 | null): void {
    if (diagnostic === null || this.diagnosticSink === null) return;
    try {
      Reflect.apply(this.diagnosticSink, undefined, [diagnostic]);
    } catch {
      // The passive reconciler never delegates control to its diagnostic sink.
    }
  }
}

function classifyFinalityReconcilerFailure(
  error: unknown,
): FinalityReconcilerDiagnosticReason {
  try {
    if (error instanceof FinalityProviderSelectionError) return error.reasonCode;
    if (!(error instanceof FinalityReconcilerError)) return 'UNKNOWN';
    switch (error.stage) {
      case 'list': return 'FINALITY_LIST';
      case 'pass': return 'FINALITY_PASS';
      case 'history': return 'FINALITY_HISTORY';
      case 'root': return 'FINALITY_ROOT';
      case 'poll': return 'FINALITY_POLL';
      case 'block': return 'FINALITY_BLOCK';
      case 'revision': return 'FINALITY_REVISION';
      case 'clock': return 'FINALITY_CLOCK';
      case 'finality-contradiction': return 'FINALITY_CONTRADICTION';
      default: return 'UNKNOWN';
    }
  } catch {
    return 'UNKNOWN';
  }
}

function isDiagnosticTime(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0);
}

function snapshotProviderSelection(value: unknown): PromotedProviderSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Current finality provider selection is invalid.');
  }
  const providerDescriptor = Object.getOwnPropertyDescriptor(value, 'providerId');
  const revisionDescriptor = Object.getOwnPropertyDescriptor(value, 'revision');
  const providerId: unknown = providerDescriptor !== undefined && 'value' in providerDescriptor
    ? providerDescriptor.value
    : undefined;
  const revision: unknown = revisionDescriptor !== undefined && 'value' in revisionDescriptor
    ? revisionDescriptor.value
    : undefined;
  if ((providerId !== null && !isRpcProviderId(providerId))
    || typeof revision !== 'bigint' || revision < 0n) {
    throw new TypeError('Current finality provider selection is invalid.');
  }
  return Object.freeze({ providerId, revision });
}

function sameProviderSelection(
  left: PromotedProviderSelection,
  right: PromotedProviderSelection,
): boolean {
  return left.providerId === right.providerId && left.revision === right.revision;
}

export class PersistentListenerHeartbeat {
  private currentState: ListenerRuntimeState = 'STOPPED';
  private startedAtMs = 0;
  private firstProcessingCanaryCohort: Promise<number> | null = null;
  private lastHttpSlot: bigint | null = null;
  private lastFinalizedSlot: bigint | null = null;
  private backlogCount = 0;
  private leasedCount = 0;
  private exhaustedCount = 0;
  private readonly intervalMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly scheduler: ListenerRuntimeScheduler;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private closed = false;
  private readonly blockHydrationMetrics: (() => RuntimeBlockHydrationMetricsV1) | null;
  private readonly blockHydrationPhaseEvidenceMetrics: (() => RuntimeBlockHydrationPhaseEvidenceV1 | null) | null;
  private readonly blockHydrationAdmissionMetrics: (() => RuntimeBlockHydrationAdmissionMetricsV1) | null;
  private readonly catchUpAdmissionMetrics: ((counts: InboxCounts) => RuntimeCatchUpAdmissionMetricsV1) | null;
  private readonly rpcHttpEvidenceMetrics: (() => RuntimeRpcHttpEvidenceV1) | null;
  private readonly rpcHttpRoleEvidenceMetrics: (() => RuntimeRpcHttpRoleEvidenceV1) | null;
  private readonly workerAdmissionMetrics: (() => Promise<RuntimeWorkerAdmissionMetricsV1>) | null;
  private readonly scannerPhaseDiagnosticsMetrics: ((sampledAtMs: number) => ScannerPhaseDiagnosticsV1) | null;
  private readonly inboxSnapshot: ListenerHeartbeatOptions['inboxSnapshot'];

  public constructor(
    private readonly inbox: Pick<TransactionInboxRepository,
      'counts' | 'writeHeartbeat' | 'beginFirstProcessingCanary' | 'firstProcessingCanary'>,
    private readonly rpc: Pick<SolanaRpcClient, 'getSlot' | 'getFinalizedSlot'>,
    private readonly subscriberState: () => ListenerRuntimeState,
    private readonly scannerState: () => ListenerRuntimeState,
    private readonly workerState: () => ListenerRuntimeState,
    private readonly reconcilerState: () => ListenerRuntimeState,
    options: ListenerHeartbeatOptions,
  ) {
    validateRecurringOptions(options);
    this.intervalMs = options.intervalMs;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs;
    this.scheduler = options.scheduler ?? listenerScheduler;
    if (options.blockHydrationMetrics !== undefined
      && typeof options.blockHydrationMetrics !== 'function') {
      throw new TypeError('Block hydration metrics provider is invalid.');
    }
    this.blockHydrationMetrics = options.blockHydrationMetrics ?? null;
    if (options.blockHydrationPhaseEvidenceMetrics !== undefined
      && typeof options.blockHydrationPhaseEvidenceMetrics !== 'function') {
      throw new TypeError('Block hydration phase evidence metrics provider is invalid.');
    }
    this.blockHydrationPhaseEvidenceMetrics = options.blockHydrationPhaseEvidenceMetrics ?? null;
    if (options.blockHydrationAdmissionMetrics !== undefined
      && typeof options.blockHydrationAdmissionMetrics !== 'function') {
      throw new TypeError('Block hydration admission metrics provider is invalid.');
    }
    this.blockHydrationAdmissionMetrics = options.blockHydrationAdmissionMetrics ?? null;
    if (options.catchUpAdmissionMetrics !== undefined
      && typeof options.catchUpAdmissionMetrics !== 'function') {
      throw new TypeError('Catch-up admission metrics provider is invalid.');
    }
    this.catchUpAdmissionMetrics = options.catchUpAdmissionMetrics ?? null;
    if (options.rpcHttpEvidenceMetrics !== undefined
      && typeof options.rpcHttpEvidenceMetrics !== 'function') {
      throw new TypeError('RPC HTTP evidence metrics provider is invalid.');
    }
    this.rpcHttpEvidenceMetrics = options.rpcHttpEvidenceMetrics ?? null;
    if (options.rpcHttpRoleEvidenceMetrics !== undefined
      && typeof options.rpcHttpRoleEvidenceMetrics !== 'function') {
      throw new TypeError('RPC HTTP role evidence metrics provider is invalid.');
    }
    this.rpcHttpRoleEvidenceMetrics = options.rpcHttpRoleEvidenceMetrics ?? null;
    if (options.workerAdmissionMetrics !== undefined
      && typeof options.workerAdmissionMetrics !== 'function') {
      throw new TypeError('Worker admission metrics provider is invalid.');
    }
    this.workerAdmissionMetrics = options.workerAdmissionMetrics ?? null;
    if (options.scannerPhaseDiagnosticsMetrics !== undefined
      && typeof options.scannerPhaseDiagnosticsMetrics !== 'function') {
      throw new TypeError('Scanner phase diagnostics provider is invalid.');
    }
    this.scannerPhaseDiagnosticsMetrics = options.scannerPhaseDiagnosticsMetrics ?? null;
    if (options.inboxSnapshot !== undefined && (typeof options.inboxSnapshot !== 'function'
      || options.workerAdmissionMetrics !== undefined)) {
      throw new TypeError('Inbox snapshot provider is invalid.');
    }
    this.inboxSnapshot = options.inboxSnapshot;
  }

  public async start(): Promise<void> {
    if (this.hasClosed()) return;
    this.currentState = 'RUNNING';
    await this.firstProcessingCanaryCohortStartedAtMs();
    if (this.hasClosed()) return;
    const initialWrite = this.write('RUNNING');
    this.inFlight = initialWrite;
    try {
      await initialWrite;
    } finally {
      if (this.inFlight === initialWrite) this.inFlight = null;
    }
    if (this.closed) return;
    this.schedule();
  }

  public stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;
    this.closed = true;
    if (this.timer !== null) this.scheduler.cancel(this.timer);
    this.timer = null;
    const operation = this.performStop();
    this.stopPromise = operation;
    return operation;
  }

  public state(): ListenerRuntimeState {
    return this.currentState;
  }

  private hasClosed(): boolean {
    return this.closed;
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = this.scheduler.schedule(() => {
      this.timer = null;
      if (this.closed) return;
      const operation = this.write('RUNNING');
      this.inFlight = operation;
      void operation.then(
        () => {
          if (this.inFlight === operation) this.inFlight = null;
          if (this.closed) return;
          this.currentState = 'RUNNING';
          this.schedule();
        },
        () => {
          if (this.inFlight === operation) this.inFlight = null;
          if (this.closed) return;
          this.currentState = 'DEGRADED';
          this.schedule();
        },
      );
    }, this.intervalMs);
  }

  private async performStop(): Promise<void> {
    let dependencyFailed = false;
    const running = this.inFlight;
    if (running !== null) {
      const result = await settleController(running, this.shutdownTimeoutMs);
      if (result === 'timeout') {
        this.currentState = 'DEGRADED';
        throw new ListenerControllerCloseError('heartbeat', 'timeout');
      }
      dependencyFailed = result === 'failed';
    }
    const stoppedResult = await settleController(
      this.write('STOPPED'),
      this.shutdownTimeoutMs,
    );
    if (stoppedResult !== 'complete') {
      this.currentState = 'DEGRADED';
      throw new ListenerControllerCloseError(
        'heartbeat',
        stoppedResult === 'timeout' ? 'timeout' : 'dependency',
      );
    }
    this.currentState = dependencyFailed ? 'DEGRADED' : 'STOPPED';
    if (dependencyFailed) {
      throw new ListenerControllerCloseError('heartbeat', 'dependency');
    }
  }

  private async write(runtimeState: 'RUNNING' | 'STOPPED'): Promise<void> {
    const cohortStartedAtMs = await this.firstProcessingCanaryCohortStartedAtMs();
    let inboxSnapshot: Awaited<ReturnType<NonNullable<ListenerHeartbeatOptions['inboxSnapshot']>>> | undefined;
    if (this.inboxSnapshot !== undefined) {
      try {
        const snapshot = await this.inboxSnapshot();
        if (isProxy(snapshot)) throw new TypeError();
        const clockDescriptor = Object.getOwnPropertyDescriptor(snapshot, 'workerAdmissionClock');
        if (clockDescriptor !== undefined && (!clockDescriptor.enumerable || !('value' in clockDescriptor))) {
          throw new TypeError();
        }
        const workerAdmissionClock = clockDescriptor === undefined ? undefined
          : snapshotRuntimeWorkerAdmissionClock(clockDescriptor.value);
        assertValidInboxCounts(snapshot.counts);
        const workerAdmission = snapshotRuntimeWorkerAdmissionMetrics(snapshot.workerAdmission);
        const backlog = safeInboxBacklog(snapshot.counts.pending, snapshot.counts.processing,
          snapshot.counts.retryableFailed);
        if (workerAdmission.classificationPendingCount > backlog
          || workerAdmission.claimableBacklogCount > backlog - workerAdmission.classificationPendingCount) {
          throw new TypeError();
        }
        inboxSnapshot = Object.freeze({ counts: snapshot.counts, workerAdmission,
          ...(workerAdmissionClock === undefined ? {} : { workerAdmissionClock }) });
      } catch {
        throw new TypeError('Inbox snapshot is invalid or unavailable.');
      }
    }
    let counts: InboxCounts;
    let firstProcessingCanary: RuntimeFirstProcessingCanaryEvidenceV1;
    if (runtimeState === 'RUNNING') {
      const [currentCounts, evidence, slots] = await Promise.all([
        inboxSnapshot === undefined ? this.inbox.counts() : Promise.resolve(inboxSnapshot.counts),
        this.inbox.firstProcessingCanary(cohortStartedAtMs),
        Promise.all([this.rpc.getSlot(), this.rpc.getFinalizedSlot()]),
      ]);
      counts = currentCounts;
      firstProcessingCanary = createFirstProcessingCanaryEvidence(evidence);
      this.lastHttpSlot = slots[0];
      this.lastFinalizedSlot = slots[1];
    } else {
      const [currentCounts, evidence] = await Promise.all([
        inboxSnapshot === undefined ? this.inbox.counts() : Promise.resolve(inboxSnapshot.counts),
        this.inbox.firstProcessingCanary(cohortStartedAtMs),
      ]);
      counts = currentCounts;
      firstProcessingCanary = createFirstProcessingCanaryEvidence(evidence);
    }
    this.backlogCount = safeInboxBacklog(counts.pending, counts.processing, counts.retryableFailed);
    this.leasedCount = counts.processing;
    this.exhaustedCount = counts.exhaustedFailed;
    let catchUpAdmission: RuntimeCatchUpAdmissionMetricsV1 | undefined;
    if (this.catchUpAdmissionMetrics !== null) {
      try {
        assertValidInboxCounts(counts);
        catchUpAdmission = snapshotRuntimeCatchUpAdmissionMetrics(
          this.catchUpAdmissionMetrics(counts), this.backlogCount,
        );
      } catch {
        throw new TypeError('Catch-up admission metrics are invalid.');
      }
    }
    const blockHydration = this.blockHydrationMetrics?.();
    let blockHydrationPhaseEvidence: RuntimeBlockHydrationPhaseEvidenceV1 | undefined;
    if (this.blockHydrationPhaseEvidenceMetrics !== null) {
      try {
        const evidence = this.blockHydrationPhaseEvidenceMetrics();
        if (evidence !== null) blockHydrationPhaseEvidence = createRuntimeBlockHydrationPhaseEvidence(evidence);
      } catch {
        throw new TypeError('Block hydration phase evidence metrics are invalid.');
      }
    }
    let blockHydrationAdmission: RuntimeBlockHydrationAdmissionMetricsV1 | undefined;
    if (this.blockHydrationAdmissionMetrics !== null) {
      try {
        blockHydrationAdmission = snapshotRuntimeBlockHydrationAdmissionMetrics(
          this.blockHydrationAdmissionMetrics(),
        );
      } catch {
        throw new TypeError('Block hydration admission metrics are invalid.');
      }
    }
    let rpcHttpEvidence: RuntimeRpcHttpEvidenceV1 | undefined;
    if (this.rpcHttpEvidenceMetrics !== null) {
      try {
        rpcHttpEvidence = createRuntimeRpcHttpEvidence(this.rpcHttpEvidenceMetrics());
      } catch {
        throw new TypeError('RPC HTTP evidence metrics are invalid.');
      }
    }
    let rpcHttpRoleEvidence: RuntimeRpcHttpRoleEvidenceV1 | undefined;
    if (this.rpcHttpRoleEvidenceMetrics !== null) {
      try {
        rpcHttpRoleEvidence = createRuntimeRpcHttpRoleEvidence(this.rpcHttpRoleEvidenceMetrics());
      } catch {
        throw new TypeError('RPC HTTP role evidence metrics are invalid.');
      }
    }
    let workerAdmission: RuntimeWorkerAdmissionMetricsV1 | undefined = inboxSnapshot === undefined
      ? undefined : snapshotRuntimeWorkerAdmissionMetrics(inboxSnapshot.workerAdmission);
    if (this.workerAdmissionMetrics !== null) {
      try {
        workerAdmission = snapshotRuntimeWorkerAdmissionMetrics(
          await this.workerAdmissionMetrics(),
        );
      } catch {
        throw new TypeError('Worker admission metrics are invalid.');
      }
    }
    const workerAdmissionClock = inboxSnapshot?.workerAdmissionClock;
    const updatedAtMs = Date.now();
    let scannerPhaseDiagnostics: ScannerPhaseDiagnosticsV1 | undefined;
    if (this.scannerPhaseDiagnosticsMetrics !== null) {
      try {
        scannerPhaseDiagnostics = snapshotScannerPhaseDiagnostics(
          this.scannerPhaseDiagnosticsMetrics(updatedAtMs),
        );
        if (scannerPhaseDiagnostics.sampledAtMs !== updatedAtMs) throw new TypeError();
      } catch {
        const fallback = new ScannerPhaseDiagnosticsCollector();
        fallback.markUnavailable();
        scannerPhaseDiagnostics = fallback.snapshot(updatedAtMs);
      }
    }
    const value: RuntimeHeartbeat = Object.freeze({
      runtimeState,
      subscriberState: runtimeState === 'STOPPED' ? 'STOPPED' : this.subscriberState(),
      scannerState: runtimeState === 'STOPPED' ? 'STOPPED' : this.scannerState(),
      workerState: runtimeState === 'STOPPED' ? 'STOPPED' : this.workerState(),
      reconcilerState: runtimeState === 'STOPPED' ? 'STOPPED' : this.reconcilerState(),
      startedAtMs: this.startedAtMs,
      updatedAtMs,
      lastHttpSlot: this.lastHttpSlot,
      lastWebsocketSlot: null,
      lastFinalizedSlot: this.lastFinalizedSlot,
      lastSignature: null,
      backlogCount: this.backlogCount,
      leasedCount: this.leasedCount,
      exhaustedCount: this.exhaustedCount,
      firstProcessingCanary,
      decoderQuarantine: snapshotRuntimeDecoderQuarantineMetrics(Object.freeze({
        version: 1,
        unresolvedCount: counts.decoderQuarantinedCount,
      })),
      ...(blockHydration === undefined ? {} : { blockHydration }),
      ...(blockHydrationPhaseEvidence === undefined ? {} : { blockHydrationPhaseEvidence }),
      ...(blockHydrationAdmission === undefined ? {} : { blockHydrationAdmission }),
      ...(catchUpAdmission === undefined ? {} : { catchUpAdmission }),
      ...(rpcHttpEvidence === undefined ? {} : { rpcHttpEvidence }),
      ...(rpcHttpRoleEvidence === undefined ? {} : { rpcHttpRoleEvidence }),
      ...(workerAdmission === undefined ? {} : { workerAdmission }),
      ...(workerAdmissionClock === undefined ? {} : { workerAdmissionClock }),
      ...(scannerPhaseDiagnostics === undefined ? {} : { scannerPhaseDiagnostics }),
    });
    if (value.updatedAtMs < value.startedAtMs) {
      throw new TypeError('Runtime heartbeat updatedAtMs precedes startedAtMs.');
    }
    if (workerAdmissionClock !== undefined
      && (workerAdmission === undefined || workerAdmissionClock.sampledAtMs > value.updatedAtMs)) {
      throw new TypeError('Inbox snapshot is invalid or unavailable.');
    }
    if (this.catchUpAdmissionMetrics !== null) {
      try { assertValidRuntimeHeartbeat(value); } catch {
        throw new TypeError('Catch-up admission metrics are invalid.');
      }
    }
    await this.inbox.writeHeartbeat(value);
  }

  private firstProcessingCanaryCohortStartedAtMs(): Promise<number> {
    return this.firstProcessingCanaryCohort ??= this.inbox.beginFirstProcessingCanary().then((value) => {
      if (!Number.isSafeInteger(value) || value <= 0 || !Number.isFinite(new Date(value).getTime())) {
        throw new TypeError('First processing canary cohort start is invalid.');
      }
      this.startedAtMs = value;
      return value;
    });
  }
}

function safeInboxBacklog(...counts: readonly number[]): number {
  let total = 0;
  for (const count of counts) {
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(total + count)) {
      throw new TypeError('Transaction inbox backlog count is invalid.');
    }
    total += count;
  }
  return total;
}

async function settleController(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<'complete' | 'failed' | 'timeout'> {
  const timeoutHandle: { value?: ReturnType<typeof setTimeout> } = {};
  const timeout = new Promise<'timeout'>((resolve) => {
    timeoutHandle.value = setTimeout(() => { resolve('timeout'); }, timeoutMs);
  });
  const settled: Promise<'complete' | 'failed'> = operation.then(
    () => 'complete',
    () => 'failed',
  );
  const result = await Promise.race([settled, timeout]);
  if (timeoutHandle.value !== undefined) clearTimeout(timeoutHandle.value);
  return result;
}

function validateRecurringOptions(options: RecurringListenerOptions): void {
  if (!Number.isSafeInteger(options.intervalMs)
    || options.intervalMs <= 0
    || options.intervalMs > MAX_LISTENER_TIMER_DELAY_MS
    || !Number.isSafeInteger(options.shutdownTimeoutMs)
    || options.shutdownTimeoutMs <= 0
    || options.shutdownTimeoutMs > 120_000
    || (options.scheduler !== undefined
      && (typeof options.scheduler.schedule !== 'function'
        || typeof options.scheduler.cancel !== 'function'))) {
    throw new TypeError('Passive listener controller timing options are invalid.');
  }
}

type WorkerPhaseShutdownDiagnostic = WorkerPhaseDiagnosticSnapshot & Readonly<{
  event: 'listener_worker_phase_diagnostic_shutdown';
  closeStatus: 'COMPLETED' | 'INCOMPLETE';
}>;

/** One process-local summary; diagnostic failure cannot alter worker cleanup. */
export function workerPhaseDiagnosticComponent(
  component: ReturnType<typeof lifecycleComponent>,
  recorder: Pick<WorkerPhaseDiagnosticRecorder, 'snapshot'>,
  diagnostic: (event: WorkerPhaseShutdownDiagnostic) => void,
): ReturnType<typeof lifecycleComponent> & { onCloseTimeout(): void } {
  let closing: Promise<void> | null = null;
  let published = false;
  const publish = (completed: boolean): void => {
    if (published) return;
    published = true;
    try {
      const snapshot = recorder.snapshot();
      const drained = completed && component.state() === 'STOPPED'
        && snapshot.totalAttempt.active === 0
        && Object.values(snapshot.phases).every((phase) => phase.active === 0);
      diagnostic(Object.freeze({
        ...snapshot,
        event: 'listener_worker_phase_diagnostic_shutdown',
        closeStatus: drained ? 'COMPLETED' : 'INCOMPLETE',
      }));
    } catch {
      // Never replace the original close outcome with optional evidence errors.
    }
  };
  return Object.freeze({
    start: (): Promise<void> => component.start(),
    state: (): ListenerRuntimeState => component.state(),
    onCloseTimeout: (): void => { publish(false); },
    close(): Promise<void> {
      if (closing !== null) return closing;
      let completed = false;
      const result = new Promise<void>((resolve) => { resolve(component.close()); });
      closing = result.then(() => { completed = true; }).finally(() => {
        publish(completed);
      });
      return closing;
    },
  });
}

export function lifecycleComponent(component: {
  start(): Promise<void>;
  close(): Promise<void>;
  readonly state: ListenerRuntimeState;
}, afterClose: () => void = () => undefined, beforeClose: () => void = () => undefined): {
  start(): Promise<void>; close(): Promise<void>; state(): ListenerRuntimeState;
} {
  return {
    start: () => component.start(),
    close: async (): Promise<void> => {
      beforeClose();
      try { await component.close(); } finally { afterClose(); }
    },
    state: () => component.state,
  };
}
