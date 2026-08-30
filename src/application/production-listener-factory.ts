import type { AppConfig, ListenerCatchUpPolicy } from '../config/env.js';
import {
  requireSolanaGenesisHash,
  SolanaGenesisHashError,
} from '../domain/solana-genesis-hash.js';
import { isRpcProviderId, type RpcProviderId } from '../domain/rpc-provider.js';
import type {
  CatchUpGap,
  ListenerRuntimeState,
  RuntimeHeartbeat,
} from '../domain/transaction-ingestion.js';
import {
  PumpFunLaunchpadAdapter,
  type PumpFunBondingCurveStateReader,
} from '../launchpads/pumpfun/pumpfun-launchpad.adapter.js';
import { PumpSwapFeeStateReader } from '../markets/pumpswap/pumpswap-fee-state.js';
import { PumpSwapMarketAdapter } from '../markets/pumpswap/pumpswap-market.adapter.js';
import { PumpSwapQuoteProvider } from '../markets/pumpswap/pumpswap-quote.provider.js';
import { PumpSwapReserveReader } from '../markets/pumpswap/pumpswap-reserve-reader.js';
import { CanonicalPaperQuoteRouter } from '../paper/paper-quote-router.js';
import { PaperTradingEngine } from '../paper/paper-trading-engine.js';
import { PumpFunPaperQuoteProvider } from '../paper/pumpfun-paper-quote.provider.js';
import { BoundedPublicHttpClient } from '../metadata/bounded-public-http.client.js';
import { HttpMetadataProvider } from '../metadata/http-metadata.provider.js';
import { RpcPumpSwapPoolValidator } from '../markets/pumpswap/pool-validator.js';
import type { ListenerRuntime } from '../ports/listener-runtime.js';
import type { TransactionInboxRepository } from '../ports/transaction-inbox-repository.js';
import { SolanaMarketRpcReader } from '../solana/rpc/market-rpc-reader.js';
import { createProviderPinnedCatchUpSource } from '../solana/rpc/provider-pinned-catch-up-source.js';
import { createProviderPinnedFinalityPass } from '../solana/rpc/provider-pinned-finality-source.js';
import { createRpcProviderCatalog } from '../solana/rpc/rpc-provider-catalog.js';
import { SolanaRpcClient } from '../solana/rpc/rpc-client.js';
import { openWsProgramSession } from '../solana/rpc/ws-program-session.js';
import type { RpcHttpFailoverEvent } from '../solana/rpc/http-failover-transport.js';
import { SolanaTransactionLocator } from '../solana/rpc/transaction-locator.js';
import { SolanaWalletFundingEvidenceExtractor } from '../solana/wallet-funding-evidence-extractor.js';
import { getDatabasePool } from '../storage/database.js';
import { PostgresLaunchpadEventRepository } from '../storage/launchpad-event.repository.js';
import { PostgresMarketObservationRepository } from '../storage/market-observation.repository.js';
import { PostgresParticipantAnalyticsRepository } from '../storage/participant-analytics.repository.js';
import { PostgresPaperDecisionRepository } from '../storage/paper-decision.repository.js';
import { PostgresPaperTradingRepository } from '../storage/paper-trading.repository.js';
import { PostgresPaperVenueReader } from '../storage/paper-venue.reader.js';
import { PostgresQualificationProjectionRepository } from '../storage/qualification-projection.repository.js';
import { PostgresSocialEvidenceRepository } from '../storage/social-evidence.repository.js';
import { PostgresTransactionInboxRepository } from '../storage/transaction-inbox.repository.js';
import { PostgresWebSocketHealthRepository } from '../storage/websocket-health.repository.js';
import { PostgresWalletEvidenceRepository } from '../storage/wallet-evidence.repository.js';
import { PostgresWalletGraphRepository } from '../storage/wallet-graph.repository.js';
import { FinalityReconciler } from './finality-reconciler.js';
import { LaunchParticipantAnalyticsService } from './launch-participant-analytics.service.js';
import { LaunchpadObservationService } from './launchpad-observation.service.js';
import { MarketObservationService } from './market-observation.service.js';
import { ObservedTransactionPipeline } from './observed-transaction-pipeline.js';
import { PumpSwapObservationPipeline } from './pumpswap-observation-pipeline.js';
import { SolanaListenerRuntime } from './listener-runtime.js';
import {
  PromotedProviderSelector,
  type PromotedProviderSelection,
} from './promoted-provider-selector.js';
import { StrictCatchUpCoordinator } from './strict-catch-up-coordinator.js';
import { StrictCatchUpScanner } from './strict-catch-up-scanner.js';
import { TransactionInboxWorker } from './transaction-inbox-worker.js';
import { WebSocketFailoverSupervisor } from './websocket-failover-supervisor.js';
import { PersistentWebSocketHealthReporter } from './websocket-health-reporter.js';
import { WalletEvidenceObservationService } from './wallet-evidence-observation.service.js';
import { WalletGraphRebuildService } from './wallet-graph-rebuild.service.js';
import { PublicSocialVerificationProvider } from '../social/public-social-verification.provider.js';
import { SocialEnrichmentWorker } from './social-enrichment-worker.js';
import {
  PaperDecisionWorker,
  createPaperDecisionStrategyRegistry,
} from './paper-decision-worker.js';
import { QualificationProjectionService } from './qualification-projection.service.js';
import { QualificationRebuildService } from './qualification-rebuild.service.js';
import { SocialQualificationRefreshService } from './social-qualification-refresh.service.js';
import { TradingCandidateService } from './trading-candidate.service.js';
import { ValidatedExternalBuysStrategy } from './validated-external-buys.strategy.js';
import { CreationEntryV1Strategy } from './creation-entry-v1.strategy.js';
import { QualificationEngine } from '../qualification/qualification-engine.js';
import { loadQualificationProfile } from '../qualification/qualification-profile.js';
import { logger } from '../utils/logger.js';

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

function logRpcHttpFailoverEvent(event: RpcHttpFailoverEvent): void {
  logger.warn(event, 'Événement de basculement HTTP RPC observé.');
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
  const databasePool = pool ?? getDatabasePool();
  const rpc = new SolanaRpcClient(config, {
    onHttpFailoverEvent: logRpcHttpFailoverEvent,
  });
  const inbox = new PostgresTransactionInboxRepository(databasePool, Object.freeze({
    maxAttempts: config.rpcRetryMaxAttempts,
    baseDelayMs: config.rpcRetryBaseDelayMs,
  }));
  const locator = new SolanaTransactionLocator(rpc);
  const websocketHealth = new PostgresWebSocketHealthRepository(databasePool);
  const websocketReporter = new PersistentWebSocketHealthReporter(
    inbox,
    websocketHealth,
    {
      touchIntervalMs: 5_000,
      shutdownTimeoutMs: config.listenerShutdownTimeoutMs,
    },
  );
  const strictCoordinators = new Map<RpcProviderId, StrictCatchUpCoordinator>(
    providers.ids.map((providerId) => {
      const scanner = new StrictCatchUpScanner(
        createProviderPinnedCatchUpSource(
          providers,
          providerId,
          'confirmed',
          expectedGenesisHash,
        ),
        inbox,
        {
          pageSize: config.listenerCatchUpPageSize,
          maxPages: config.listenerCatchUpMaxPages,
        },
      );
      return [providerId, new StrictCatchUpCoordinator(scanner)] as const;
    }),
  );
  const promoted = new PromotedProviderSelector(
    providers.ids.map((providerId) => createProviderPinnedFinalityPass(providers, providerId)),
  );
  const supervisor = new WebSocketFailoverSupervisor(
    {
      providers,
      health: websocketHealth,
      reporter: websocketReporter,
      promoted,
      openSession: openWsProgramSession,
      runStrictScan: (providerId, signal): ReturnType<StrictCatchUpCoordinator['run']> => {
        const coordinator = strictCoordinators.get(providerId);
        if (coordinator === undefined) {
          return Promise.reject(new TypeError('Strict catch-up coordinator is unavailable.'));
        }
        return coordinator.run(signal);
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
    },
  );

  const launchpadRepository = new PostgresLaunchpadEventRepository(
    databasePool,
    config.dataRetentionHours,
    Date.now,
    {
      maxAttempts: config.socialRetryMaxAttempts,
      baseDelayMs: config.socialRetryBaseDelayMs,
    },
  );
  const publicHttp = new BoundedPublicHttpClient(undefined, undefined, {
    timeoutMs: config.socialHttpTimeoutMs,
    maxBytes: config.socialHttpMaxBytes,
    maxRedirects: config.socialHttpMaxRedirects,
    maxConcurrency: config.socialHttpConcurrency,
    maxPerHostConcurrency: 1,
  });
  const pump = new PumpFunLaunchpadAdapter(createUnavailableBondingCurveReader());
  const launchpad = new LaunchpadObservationService(pump, launchpadRepository);
  const funding = new WalletEvidenceObservationService(
    new SolanaWalletFundingEvidenceExtractor(),
    new PostgresWalletEvidenceRepository(databasePool),
  );
  const participants = new LaunchParticipantAnalyticsService(
    new PostgresParticipantAnalyticsRepository(databasePool),
  );
  const graph = new WalletGraphRebuildService(
    new PostgresWalletGraphRepository(databasePool),
  );

  const marketRpc = new SolanaMarketRpcReader(rpc.http, config.commitment);
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
  }, qualificationProfile);
  const qualificationEngine = new QualificationEngine(qualificationProfile);
  const qualificationRebuilder = new QualificationRebuildService(qualificationEngine);
  const qualification = new QualificationProjectionService(
    new PostgresQualificationProjectionRepository(databasePool, qualificationRebuilder),
    qualificationRebuilder,
    config.paperQuoteMintAllowlist,
  );
  const socialWorker = new SocialEnrichmentWorker(
    new PostgresSocialEvidenceRepository(databasePool),
    new HttpMetadataProvider(publicHttp),
    new PublicSocialVerificationProvider(publicHttp),
    new SocialQualificationRefreshService(qualification,paperRepository),
    {
      pollIntervalMs: config.socialWorkerPollMs,
      leaseMs: config.socialWorkerLeaseSeconds * 1_000,
      renewalIntervalMs: Math.floor(config.socialWorkerLeaseSeconds * 1_000 / 3),
      shutdownTimeoutMs: config.listenerShutdownTimeoutMs,
    },
  );
  const quoteRouter = new CanonicalPaperQuoteRouter(
    new PostgresPaperVenueReader(() => rpc.getSlot(), databasePool),
    new PumpFunPaperQuoteProvider(marketRpc),
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
    qualificationRebuilder,
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
  const pipeline = new ObservedTransactionPipeline(
    launchpadRepository,
    launchpad,
    funding,
    participants,
    graph,
    marketPipeline,
    Date.now,
    paperRepository,
    qualification,
  );

  const worker = new TransactionInboxWorker(inbox, locator, pipeline, {
    leaseSeconds: config.listenerWorkerLeaseSeconds,
    renewalIntervalMs: Math.max(1_000, Math.floor(config.listenerWorkerLeaseSeconds * 1_000 / 3)),
    idlePollMs: 1_000,
  });
  const workerComponent = lifecycleComponent(worker);
  const socialWorkerComponent = lifecycleComponent(socialWorker);
  const paperWorkerComponent = lifecycleComponent(paperWorker);
  const heartbeat = new PersistentListenerHeartbeat(
    inbox,
    rpc,
    () => supervisor.state(),
    () => supervisor.state(),
    () => worker.state,
    () => reconciler.state(),
    { intervalMs: 5_000, shutdownTimeoutMs: config.listenerShutdownTimeoutMs },
  );

  return new SolanaListenerRuntime({
    supervisor,
    worker: workerComponent,
    paperWorker: paperWorkerComponent,
    socialWorker: socialWorkerComponent,
    reconciler,
    heartbeat,
  }, { shutdownTimeoutMs: config.listenerShutdownTimeoutMs });
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

export type InitialFinalityFailureMode = 'FAIL_START' | 'DEGRADED_RETRY';

export interface RecurringFinalityOptions extends RecurringListenerOptions {
  readonly initialFailureMode?: InitialFinalityFailureMode;
  readonly currentSelection?: () => PromotedProviderSelection;
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

export class RecurringFinalityReconciler {
  private currentState: ListenerRuntimeState = 'STOPPED';
  private readonly intervalMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly scheduler: ListenerRuntimeScheduler;
  private readonly initialFailureMode: InitialFinalityFailureMode;
  private readonly currentSelection: (() => PromotedProviderSelection) | null;
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
      this.schedule();
    } catch (error) {
      if (this.inFlight === operation) this.inFlight = null;
      if (this.hasClosed()) {
        if (this.initialFailureMode === 'FAIL_START') throw error;
        return;
      }
      this.currentState = 'DEGRADED';
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
          this.schedule();
        },
        () => {
          if (this.inFlight === operation) this.inFlight = null;
          if (this.closed) return;
          this.currentReadySelection = null;
          this.currentState = 'DEGRADED';
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
    if (selection.providerId === null) throw new Error('Current finality provider is unavailable.');
    await this.reconciler.runOnce();
    if (!sameProviderSelection(this.readCurrentSelection(), selection)) {
      throw new Error('Current finality provider changed.');
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
    throw new Error('Current finality provider is unavailable.');
  }
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

  public constructor(
    private readonly inbox: Pick<TransactionInboxRepository, 'counts' | 'writeHeartbeat'>,
    private readonly rpc: Pick<SolanaRpcClient, 'getSlot' | 'getFinalizedSlot'>,
    private readonly subscriberState: () => ListenerRuntimeState,
    private readonly scannerState: () => ListenerRuntimeState,
    private readonly workerState: () => ListenerRuntimeState,
    private readonly reconcilerState: () => ListenerRuntimeState,
    options: RecurringListenerOptions,
  ) {
    validateRecurringOptions(options);
    this.intervalMs = options.intervalMs;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs;
    this.scheduler = options.scheduler ?? listenerScheduler;
  }

  public async start(): Promise<void> {
    if (this.closed) return;
    this.currentState = 'RUNNING';
    this.startedAtMs = Date.now();
    await this.write('RUNNING');
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
    if (runtimeState === 'RUNNING') {
      const [counts, slots] = await Promise.all([
        this.inbox.counts(),
        Promise.all([this.rpc.getSlot(), this.rpc.getFinalizedSlot()]),
      ]);
      this.lastHttpSlot = slots[0];
      this.lastFinalizedSlot = slots[1];
      this.backlogCount = safeInboxBacklog(
        counts.pending,
        counts.processing,
        counts.retryableFailed,
      );
      this.leasedCount = counts.processing;
      this.exhaustedCount = counts.exhaustedFailed;
    } else {
      const counts = await this.inbox.counts();
      this.backlogCount = safeInboxBacklog(
        counts.pending,
        counts.processing,
        counts.retryableFailed,
      );
      this.leasedCount = counts.processing;
      this.exhaustedCount = counts.exhaustedFailed;
    }
    const value: RuntimeHeartbeat = Object.freeze({
      runtimeState,
      subscriberState: runtimeState === 'STOPPED' ? 'STOPPED' : this.subscriberState(),
      scannerState: runtimeState === 'STOPPED' ? 'STOPPED' : this.scannerState(),
      workerState: runtimeState === 'STOPPED' ? 'STOPPED' : this.workerState(),
      reconcilerState: runtimeState === 'STOPPED' ? 'STOPPED' : this.reconcilerState(),
      startedAtMs: this.startedAtMs,
      updatedAtMs: Date.now(),
      lastHttpSlot: this.lastHttpSlot,
      lastWebsocketSlot: null,
      lastFinalizedSlot: this.lastFinalizedSlot,
      lastSignature: null,
      backlogCount: this.backlogCount,
      leasedCount: this.leasedCount,
      exhaustedCount: this.exhaustedCount,
    });
    await this.inbox.writeHeartbeat(value);
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

function lifecycleComponent(component: {
  start(): Promise<void>;
  close(): Promise<void>;
  readonly state: ListenerRuntimeState;
}): { start(): Promise<void>; close(): Promise<void>; state(): ListenerRuntimeState } {
  return {
    start: () => component.start(),
    close: () => component.close(),
    state: () => component.state,
  };
}
