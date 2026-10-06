import { PublicKey, type Commitment, type Finality } from '@solana/web3.js';
import type { AppConfig } from '../config/env.js';
import type {
  ListenerRuntimeState,
  ProcessingCheckpoint,
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
import type { PaperDecisionResult, PaperDecisionSnapshot } from '../ports/paper-decision-repository.js';
import type { TransactionInboxRepository } from '../ports/transaction-inbox-repository.js';
import { CatchUpSourceError, SolanaCatchUpSource } from '../solana/rpc/catch-up-source.js';
import { PUMP_PROGRAM_ID } from '../launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../markets/pumpswap/constants.js';
import { SolanaMarketRpcReader } from '../solana/rpc/market-rpc-reader.js';
import { PoolLogsSubscriber } from '../solana/rpc/pool-logs-subscriber.js';
import { PoolSignatureSource, type PoolSignaturesRpc } from '../solana/rpc/pool-signature-source.js';
import {
  SolanaProgramSubscriber,
  type ProgramSubscriberMetrics,
} from '../solana/rpc/program-subscriber.js';
import { Web3ProgramLogsConnection } from '../solana/rpc/websocket-subscription-state.adapter.js';
import { SolanaRpcClient } from '../solana/rpc/rpc-client.js';
import type { CatchUpRpcMetrics } from '../solana/rpc/catch-up-rpc-telemetry.js';
import { SolanaTransactionLocator } from '../solana/rpc/transaction-locator.js';
import { CachedBlockSignatureRpc } from '../solana/rpc/block-signature-cache.js';
import { SolanaWalletFundingEvidenceExtractor } from '../solana/wallet-funding-evidence-extractor.js';
import { getDatabasePool } from '../storage/database.js';
import { PostgresCheckpointRebaseRepository } from '../storage/checkpoint-rebase.repository.js';
import { PostgresLaunchpadEventRepository } from '../storage/launchpad-event.repository.js';
import { PostgresMarketObservationRepository } from '../storage/market-observation.repository.js';
import { PostgresMarketPoolTrackingRepository } from '../storage/market-pool-tracking.repository.js';
import { PostgresParticipantAnalyticsRepository } from '../storage/participant-analytics.repository.js';
import { PostgresPaperDecisionRepository } from '../storage/paper-decision.repository.js';
import { PostgresPaperTradingRepository } from '../storage/paper-trading.repository.js';
import { PostgresPaperVenueReader } from '../storage/paper-venue.reader.js';
import { PostgresQualificationProjectionRepository } from '../storage/qualification-projection.repository.js';
import { PostgresSocialEvidenceRepository } from '../storage/social-evidence.repository.js';
import { PostgresTransactionInboxRepository } from '../storage/transaction-inbox.repository.js';
import { PostgresWalletEvidenceRepository } from '../storage/wallet-evidence.repository.js';
import { PostgresWalletGraphRepository } from '../storage/wallet-graph.repository.js';
import { CatchUpScanner, CatchUpScannerError, CatchUpWindowExceededError } from './catch-up-scanner.js';
import type { ProgramFinalizedFrontiers } from './catch-up-scanner.js';
import { captureFinalizedProgramFrontier, type FinalizedProgramFrontier } from './program-finalized-frontier.js';
import {
  applyRecordedLiveEdgeCutover,
  type RecordedLiveEdgeCutoverRpc,
  type RecordedLiveEdgeCutoverRequest,
} from './recorded-live-edge-cutover.js';
import { FinalityReconciler } from './finality-reconciler.js';
import { ListenerCoverage } from './listener-coverage.js';
import { MarketPoolTracker } from './market-pool-tracker.js';
import { PoolCatchUpScanner } from './pool-catch-up-scanner.js';
import { LaunchParticipantAnalyticsService } from './launch-participant-analytics.service.js';
import { LaunchpadObservationService } from './launchpad-observation.service.js';
import { MarketObservationService } from './market-observation.service.js';
import { ObservedTransactionPipeline } from './observed-transaction-pipeline.js';
import { PumpSwapObservationPipeline } from './pumpswap-observation-pipeline.js';
import { SolanaListenerRuntime } from './listener-runtime.js';
import { TransactionInboxWorker } from './transaction-inbox-worker.js';
import { WalletEvidenceObservationService } from './wallet-evidence-observation.service.js';
import { WalletGraphRebuildService } from './wallet-graph-rebuild.service.js';
import { PublicSocialVerificationProvider } from '../social/public-social-verification.provider.js';
import { SocialEnrichmentWorker } from './social-enrichment-worker.js';
import { PaperDecisionWorker } from './paper-decision-worker.js';
import { QualificationProjectionService } from './qualification-projection.service.js';
import { QualificationRebuildService } from './qualification-rebuild.service.js';
import { SocialQualificationRefreshService } from './social-qualification-refresh.service.js';
import { TradingCandidateService } from './trading-candidate.service.js';
import { ValidatedExternalBuysStrategy } from './validated-external-buys.strategy.js';
import { QualificationEngine } from '../qualification/qualification-engine.js';
import { loadQualificationProfile } from '../qualification/qualification-profile.js';
import { QuoteObservationRecorder } from '../telemetry/quote-recorder.js';
import { createQuoteObservationFileSink } from '../telemetry/quote-observation-file.js';
import { logger } from '../utils/logger.js';

type ProductionPool = ReturnType<typeof getDatabasePool>;
export const MAX_LISTENER_TIMER_DELAY_MS = 2_147_483_647;

export interface ProductionListenerStartupOptions {
  readonly allowRecordedLiveEdgeCutover?: boolean;
  readonly expectedGenesisHash?: string;
}

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

export function createProductionListenerRuntime(
  config: AppConfig,
  pool: ProductionPool = getDatabasePool(),
  liveDecisionConsumer?: (result: PaperDecisionResult, snapshot: PaperDecisionSnapshot) => Promise<void>,
  startupOptions: ProductionListenerStartupOptions = {},
): ListenerRuntime {
  const rpc = new SolanaRpcClient(config);
  const inbox = new PostgresTransactionInboxRepository(pool, Object.freeze({
    maxAttempts: config.rpcRetryMaxAttempts,
    baseDelayMs: config.rpcRetryBaseDelayMs,
  }));
  // A mainnet signature list is ~150 KB; 64 slots covers ~25 s of claims within ~10 MB.
  const blockSignatures = new CachedBlockSignatureRpc(rpc, { maxSlots: 64 });
  const locator = new SolanaTransactionLocator(blockSignatures);
  const catchUp = new CatchUpScanner(
    new SolanaCatchUpSource(catchUpRpc(rpc), config.commitment),
    inbox,
    {
      pageSize: config.listenerCatchUpPageSize,
      maxPages: config.listenerCatchUpMaxPages,
      programs: ['launchpad'],
    },
  );
  // Market (PumpSwap) ingestion is per tracked pool (MarketPoolTracker below), not program-wide.
  const subscriber = new SolanaProgramSubscriber(
    new Web3ProgramLogsConnection(rpc.http),
    inbox,
    { programIds: [PUMP_PROGRAM_ID] },
  );
  const checkpointRepository = new PostgresCheckpointRebaseRepository(pool);
  const scanner = new StartupScanner(
    catchUp,
    async (program) => captureFinalizedProgramFrontier(program, () => rpc.catchUpHttp.getSignaturesForAddress(
      new PublicKey(program === 'launchpad' ? PUMP_PROGRAM_ID : PUMPSWAP_PROGRAM_ID),
      { limit: 1 },
      'finalized',
    )),
    startupOptions.allowRecordedLiveEdgeCutover === true
      ? async (error: CatchUpWindowExceededError, frontier: FinalizedProgramFrontier): Promise<void> => {
        if (config.cluster !== 'mainnet-beta') {
          throw new Error('Recorded live-edge cutover requires mainnet-beta.');
        }
        const expectedGenesisHash = startupOptions.expectedGenesisHash;
        if (expectedGenesisHash === undefined || expectedGenesisHash.length === 0) {
          throw new Error('Recorded live-edge cutover requires LIVE_EXPECTED_GENESIS_HASH.');
        }
        await subscriber.drainDurableEnqueues();
        const state = await checkpointRepository.inspect(error.program);
        const previous = state.checkpoint;
        if (previous === null) throw new Error('Recorded live-edge cutover requires an existing checkpoint.');
        const request: RecordedLiveEdgeCutoverRequest = Object.freeze({
          program: error.program,
          previous,
          frontier,
          scan: error.diagnostic,
          limits: { pageSize: config.listenerCatchUpPageSize, maxPages: config.listenerCatchUpMaxPages },
          expectedGenesisHash,
          recordedAtMs: Date.now(),
        });
        const cutoverRpc: RecordedLiveEdgeCutoverRpc = Object.freeze({
          getGenesisHash: () => rpc.http.getGenesisHash(),
        });
        const evidenceId = await applyRecordedLiveEdgeCutover(
          request,
          checkpointRepository,
          cutoverRpc,
        );
        await subscriber.drainDurableEnqueues();
        if (subscriber.state !== 'RUNNING') {
          throw new Error('WebSocket subscriptions degraded during recorded live-edge cutover.');
        }
        const updated = await checkpointRepository.inspect(error.program);
        logger.warn({
          event: 'listener.live_edge_cutover_applied',
          program: error.program,
          evidenceId,
          previousSlot: previous.slot.toString(),
          newCheckpointSlot: updated.checkpoint?.slot.toString() ?? null,
          frontierSlot: frontier.slot.toString(),
          frontierSignature: `${frontier.signature.slice(0, 8)}…${frontier.signature.slice(-8)}`,
          pageSize: error.diagnostic.pageSize,
          maxPages: error.diagnostic.maxPages,
          pageCount: error.diagnostic.pageCount,
          signaturesRead: error.diagnostic.signaturesRead,
        }, 'Discontinuité operator-approved-live-edge-cutover enregistrée.');
      }
      : undefined,
    {
      programs: ['launchpad'],
      intervalsMs: Object.freeze({
        launchpad: config.listenerRollingCatchUpLaunchpadIntervalMs,
      }),
      readCheckpoint: (program: 'launchpad' | 'market'): Promise<ProcessingCheckpoint | null> => inbox.readCheckpoint(program),
      isSubscriberRunning: (): boolean => subscriber.state === 'RUNNING',
      getRpcMetrics: (program: 'launchpad' | 'market'): CatchUpRpcMetrics => rpc.catchUpTelemetry.snapshot(program),
      onStatus: (status: RollingCatchUpStatus): void => {
        logger.info({ event: 'listener.rolling_catch_up_status', ...status }, 'État du catch-up durable.');
      },
      onSweep: (sweep): void => {
        logger.info({ event: 'listener.rolling_catch_up_sweep', ...sweep }, 'Sweep finalized rolling terminé.');
      },
    },
  );
  const poolTracking = new PostgresMarketPoolTrackingRepository(pool);
  const marketTracker = new MarketPoolTracker(
    {
      repository: poolTracking,
      scanner: new PoolCatchUpScanner(
        new PoolSignatureSource(poolSignaturesRpc(rpc)),
        inbox,
        poolTracking,
        { pageSize: config.listenerCatchUpPageSize, maxPages: config.listenerCatchUpMaxPages },
      ),
      subscriber: new PoolLogsSubscriber(new Web3ProgramLogsConnection(rpc.http), inbox),
    },
    {
      intervalMs: config.listenerRollingCatchUpMarketIntervalMs,
      windowMs: config.marketTrackingWindowHours * 3_600_000,
      maxPools: config.marketTrackedPoolsMax,
      onSweep: (report): void => {
        logger.info({ event: 'listener.market_pool_sweep', ...report }, 'Sweep pool market terminé.');
      },
      onCycle: (report): void => {
        if (report.droppedByCap.length > 0) {
          logger.warn({ event: 'listener.market_pool_cap_reached', ...report }, 'Plafond de pools market atteint.');
        } else {
          logger.info({ event: 'listener.market_pool_cycle', ...report }, 'Cycle pools market terminé.');
        }
      },
    },
  );
  const coverage = new ListenerCoverage(scanner, marketTracker);
  const guardedLiveDecisionConsumer = guardLiveDecisionConsumer(
    liveDecisionConsumer,
    (_result, snapshot) => coverage.isMintCovered(snapshot.mint) && subscriber.state === 'RUNNING',
    (): void => {
      logger.warn({
        event: 'listener.live_candidate_blocked_by_coverage',
        scannerState: coverage.state(),
        marketCoverageState: marketTracker.coverageState(),
        subscriberState: subscriber.state,
      }, 'Nouveau signal BUY live ignoré pendant une couverture dégradée.');
    },
  );

  const launchpadRepository = new PostgresLaunchpadEventRepository(
    pool,
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
    rateLimitBaseDelayMs: config.socialHttpRateLimitBaseDelayMs,
    rateLimitMaxDelayMs: config.socialHttpRateLimitMaxDelayMs,
    maxPerHostConcurrency: 1,
  });
  const pump = new PumpFunLaunchpadAdapter(createUnavailableBondingCurveReader());
  const launchpad = new LaunchpadObservationService(pump, launchpadRepository);
  const funding = new WalletEvidenceObservationService(
    new SolanaWalletFundingEvidenceExtractor(),
    new PostgresWalletEvidenceRepository(pool),
  );
  const participants = new LaunchParticipantAnalyticsService(
    new PostgresParticipantAnalyticsRepository(pool),
  );
  const graph = new WalletGraphRebuildService(new PostgresWalletGraphRepository(pool));

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
    new PostgresMarketObservationRepository(pool, config.dataRetentionHours),
  );
  const marketPipeline = new PumpSwapObservationPipeline(pump, market, marketService);
  const qualificationProfile = loadQualificationProfile({
    profilePath: config.qualificationProfilePath,
    minimumScoreOverride: config.qualificationMinimumScore,
  });
  const paperRepository = new PostgresPaperDecisionRepository(pool, {
    maxAttempts: config.paperDecisionRetryMaxAttempts,
    baseDelayMs: config.paperDecisionRetryBaseDelayMs,
    retentionHours: 4,
  }, qualificationProfile);
  const qualificationEngine = new QualificationEngine(qualificationProfile);
  const qualificationRebuilder = new QualificationRebuildService(qualificationEngine);
  const qualification = new QualificationProjectionService(
    new PostgresQualificationProjectionRepository(pool, qualificationRebuilder),
    qualificationRebuilder,
    config.paperQuoteMintAllowlist,
  );
  const quoteRecorder = new QuoteObservationRecorder({
    enabled: config.quoteObservationEnabled,
    append: createQuoteObservationFileSink(config.quoteObservationPath),
    onDiagnostic: (event, health): void => {
      logger.warn({ event, ...health }, 'Quote observation recorder degraded.');
    },
  });
  const socialWorker = new SocialEnrichmentWorker(
    new PostgresSocialEvidenceRepository(pool),
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
    new PostgresPaperVenueReader(() => rpc.getSlot(), pool),
    new PumpFunPaperQuoteProvider(marketRpc),
    market,
    {
      maxAgeMs: config.paperQuoteMaxAgeMs,
      maxSlotLag: BigInt(config.paperQuoteMaxSlotLag),
      quoteRecorder,
    },
  );
  const paperTrading = new PaperTradingEngine(
    config,
    new PostgresPaperTradingRepository(pool),
    qualificationProfile,
    qualificationEngine,
  );
  const paperStrategy = new ValidatedExternalBuysStrategy(
    paperTrading,
    quoteRouter,
    { retentionMs: 14_400_000 },
  );
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
    }),
    paperStrategy,
    {
      executionMode: guardedLiveDecisionConsumer === undefined ? config.executionMode : 'observe',
      paperStrategyEnabled: guardedLiveDecisionConsumer === undefined ? config.paperStrategyEnabled : false,
      liveCandidateFeedEnabled: guardedLiveDecisionConsumer !== undefined,
      ...(guardedLiveDecisionConsumer === undefined ? {} : { onDecisionResult: guardedLiveDecisionConsumer }),
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
  const reconciler = new RecurringFinalityReconciler(
    new FinalityReconciler(rpc, inbox, {
      limit: 100,
      missingPollThreshold: config.listenerFinalityMissingPolls,
    }),
    {
      intervalMs: config.reconcileSeconds * 1_000,
      shutdownTimeoutMs: config.listenerShutdownTimeoutMs,
    },
  );
  const subscriberComponent = lifecycleComponent(subscriber);
  const workerComponent = lifecycleComponent(worker);
  const socialWorkerComponent = lifecycleComponent(socialWorker);
  const paperWorkerComponent = lifecycleComponent(paperWorker);
  const heartbeat = new PersistentListenerHeartbeat(
    inbox,
    rpc,
    () => subscriber.state,
    () => coverage.state(),
    () => worker.state,
    () => reconciler.state(),
    {
      intervalMs: 5_000,
      shutdownTimeoutMs: config.listenerShutdownTimeoutMs,
      subscriberMetrics: (): ProgramSubscriberMetrics => subscriber.metrics(),
      onWritten: (value): void => {
        logger.info({
          runtimeState: value.runtimeState,
          backlogCount: value.backlogCount,
          leasedCount: value.leasedCount,
          exhaustedCount: value.exhaustedCount,
          httpRpcByMethod: rpc.httpTelemetry.snapshot(),
          blockSignatureCache: blockSignatures.metrics(),
          marketCoverageState: marketTracker.coverageState(),
        }, 'Pression RPC du listener.');
      },
    },
  );

  return new SolanaListenerRuntime({
    rpc,
    scanner: coverage,
    subscriber: subscriberComponent,
    worker: workerComponent,
    paperWorker: paperWorkerComponent,
    socialWorker: socialWorkerComponent,
    reconciler,
    heartbeat,
  }, { shutdownTimeoutMs: config.listenerShutdownTimeoutMs });
}

export type ListenerCoverageState = 'BOOTSTRAPPING' | 'WARMING_UP' | 'HEALTHY' | 'DEGRADED' | 'STOPPED';
export type ListenerBootstrapMode = 'STRICT_CATCH_UP' | 'RECORDED_LIVE_EDGE_CUTOVER';

type RollingProgram = 'launchpad' | 'market';

export interface ListenerBootstrapProgramResult {
  readonly program: RollingProgram;
  readonly bootstrapMode: ListenerBootstrapMode;
  readonly durableFrontier: Readonly<{ signature: string; slot: string }>;
}

export interface ListenerBootstrapResult {
  readonly programs: Readonly<{
    launchpad: ListenerBootstrapProgramResult;
    market?: ListenerBootstrapProgramResult;
  }>;
}

const ROLLING_PROGRAMS: readonly RollingProgram[] = Object.freeze(['launchpad', 'market']);

export class StartupScanner {
  private currentState: ListenerRuntimeState = 'STOPPED';
  private coverage: ListenerCoverageState = 'STOPPED';
  private readonly cutoversAttempted = new Set<RollingProgram>();
  private readonly rollingOptions: StartupScannerOptions;
  private readonly scheduler: ListenerRuntimeScheduler;
  private readonly programStatus: Record<RollingProgram, MutableRollingProgramStatus> = {
    launchpad: initialRollingProgramStatus(),
    market: initialRollingProgramStatus(),
  };
  private readonly timers = new Map<RollingProgram, unknown>();
  private readonly inFlight = new Map<RollingProgram, Promise<void>>();
  private readonly lastSweepStartedAtMs = new Map<RollingProgram, number>();
  private closed = false;
  private bootstrapComplete = false;
  private bootstrapResult: ListenerBootstrapResult | null = null;
  private bootstrapPromise: Promise<ListenerBootstrapResult> | null = null;
  private readonly programs: readonly RollingProgram[];

  public constructor(
    private readonly scanner: CatchUpScanner,
    private readonly readFinalizedFrontier: (program: RollingProgram) => Promise<FinalizedProgramFrontier>,
    private readonly applyCutover?: (
      error: CatchUpWindowExceededError,
      frontier: FinalizedProgramFrontier,
    ) => Promise<void>,
    options: StartupScannerOptions = {},
  ) {
    const scannerPrograms = canonicalRollingPrograms(scanner.enabledPrograms());
    if (scannerPrograms === null) throw new TypeError('Rolling catch-up program list is invalid.');
    if (options.programs !== undefined) {
      const requested = canonicalRollingPrograms(options.programs);
      if (requested === null) throw new TypeError('Rolling catch-up program list is invalid.');
      if (requested.join(',') !== scannerPrograms.join(',')) {
        throw new TypeError('Startup and catch-up scanner program lists differ.');
      }
    }
    this.programs = scannerPrograms;
    if (options.intervalMs !== undefined
      && (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 5_000 || options.intervalMs > 120_000)) {
      throw new TypeError('Rolling catch-up interval must be between 5000 and 120000 milliseconds.');
    }
    if (options.intervalsMs !== undefined && this.programs.some((program) => {
      const interval = options.intervalsMs?.[program];
      return interval === undefined || !Number.isSafeInteger(interval) || interval < 5_000 || interval > 120_000;
    })) {
      throw new TypeError('Per-program rolling catch-up intervals must be between 5000 and 120000 milliseconds.');
    }
    this.rollingOptions = options;
    this.scheduler = options.scheduler ?? listenerScheduler;
  }

  public scan(): Promise<ListenerBootstrapResult> {
    if (this.closed) return Promise.reject(new Error('Rolling catch-up scanner is closed.'));
    if (this.bootstrapResult !== null) return Promise.resolve(this.bootstrapResult);
    if (this.bootstrapPromise !== null) return this.bootstrapPromise;
    this.currentState = 'STARTING';
    this.coverage = 'BOOTSTRAPPING';
    this.publishStatus();
    const operation = this.performBootstrap();
    this.bootstrapPromise = operation;
    void operation.then(
      (result) => {
        if (this.bootstrapPromise === operation) this.bootstrapPromise = null;
        this.bootstrapResult = result;
      },
      () => { if (this.bootstrapPromise === operation) this.bootstrapPromise = null; },
    );
    return operation;
  }

  public async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) this.scheduler.cancel(timer);
    this.timers.clear();
    const bootstrap = this.bootstrapPromise;
    if (bootstrap !== null) await bootstrap.catch(() => undefined);
    await Promise.all([...this.inFlight.values()]);
    this.coverage = 'STOPPED';
    this.currentState = 'STOPPED';
    this.publishStatus();
  }

  public state(): ListenerRuntimeState {
    this.refreshCoverageState();
    return this.currentState;
  }

  public isCoverageHealthy(): boolean {
    this.refreshCoverageState();
    return this.coverage === 'HEALTHY';
  }

  public metrics(): RollingCatchUpStatus {
    this.refreshCoverageState();
    return snapshotRollingCatchUpStatus(
      this.currentState,
      this.coverage,
      Object.values(this.programStatus).some((status) => status.sweepActive),
      this.programStatus,
    );
  }

  private async performBootstrap(): Promise<ListenerBootstrapResult> {
    try {
      if (!this.subscriberRunning()) {
        throw Object.assign(new Error('Bootstrap requires active WebSocket subscriptions.'), {
          code: 'WEBSOCKET_NOT_RUNNING',
        });
      }
      const frontiers: Partial<Record<RollingProgram, FinalizedProgramFrontier>> = {};
      for (const program of this.programs) {
        const frontier = await this.readFinalizedFrontier(program);
        frontiers[program] = frontier;
        this.programStatus[program].lastAttemptedFrontierSlot = frontier.slot.toString();
      }
      if (!this.subscriberRunning()) {
        throw Object.assign(new Error('WebSocket subscriptions degraded during bootstrap frontier capture.'), {
          code: 'WEBSOCKET_NOT_RUNNING',
        });
      }
      const result = await this.scanWithOptionalCutover(Object.freeze(frontiers));
      if (!this.subscriberRunning()) {
        throw Object.assign(new Error('WebSocket subscriptions degraded during bootstrap catch-up.'), {
          code: 'WEBSOCKET_NOT_RUNNING',
        });
      }
      const durableFrontiers = new Map(this.programs.map((program) => [
        program, requireDurableFrontier(result, program),
      ] as const));
      for (const [program, frontier] of durableFrontiers) {
        const status = this.programStatus[program];
        status.checkpointSlot = frontier.slot;
        status.checkpointSignature = frontier.signature;
        status.lastDurableFrontierSlot = frontier.slot;
        status.bootstrapMode = result.bootstrapModes[program] ?? null;
      }
      this.bootstrapComplete = true;
      this.coverage = 'WARMING_UP';
      this.currentState = 'STARTING';
      this.publishStatus();

      // These are the first post-bootstrap sweeps. Start one per program now,
      // without waiting for the configured periodic interval.
      await Promise.all(this.programs.map((program) => this.startRollingSweep(program)));
      this.refreshCoverageState();
      this.publishStatus();
      return Object.freeze({
        programs: Object.freeze(Object.fromEntries([...durableFrontiers].map(([program, durableFrontier]) => [
          program,
          Object.freeze({
            program,
            bootstrapMode: result.bootstrapModes[program] ?? 'STRICT_CATCH_UP',
            durableFrontier,
          }),
        ]))) as ListenerBootstrapResult['programs'],
      });
    } catch (error) {
      this.coverage = 'DEGRADED';
      this.currentState = 'DEGRADED';
      const failedProgram = errorProgram(error);
      const failedPrograms = failedProgram === null || !this.programs.includes(failedProgram)
        ? this.programs : [failedProgram];
      for (const program of failedPrograms) {
        const status = this.programStatus[program];
        status.sweepsFailed += 1;
        status.lastErrorCode = errorCode(error);
        status.lastErrorName = errorName(error);
        status.lastErrorStage = errorStage(error);
      }
      if (error instanceof CatchUpWindowExceededError && this.programs.includes(error.program)) {
        this.programStatus[error.program].lastSweepPageCount = error.diagnostic.pageCount;
        this.programStatus[error.program].lastSweepSignatureCount = error.diagnostic.signaturesRead;
      }
      await this.refreshCheckpointSlots();
      this.publishStatus();
      throw error;
    }
  }

  private async scanWithOptionalCutover(frontiers: ProgramFinalizedFrontiers): Promise<{
    readonly programs: Awaited<ReturnType<CatchUpScanner['scan']>>['programs'];
    readonly bootstrapModes: Readonly<Partial<Record<RollingProgram, ListenerBootstrapMode>>>;
  }> {
    const terminalCutovers = new Map<RollingProgram, FinalizedProgramFrontier>();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const scan = await this.scanner.scan(frontiers, [...terminalCutovers.values()]);
        const bootstrapModes = Object.freeze(Object.fromEntries(this.programs.map((program) => [
          program,
          terminalCutovers.has(program) ? 'RECORDED_LIVE_EDGE_CUTOVER' : 'STRICT_CATCH_UP',
        ])) as Partial<Record<RollingProgram, ListenerBootstrapMode>>);
        return Object.freeze({ programs: scan.programs, bootstrapModes });
      } catch (error) {
        if (!(error instanceof CatchUpWindowExceededError)
          || this.applyCutover === undefined
          || this.cutoversAttempted.has(error.program)
          || terminalCutovers.has(error.program)
          || attempt === 2) {
          throw error;
        }
        const frontier = frontiers[error.program];
        if (frontier === undefined) throw error;
        this.cutoversAttempted.add(error.program);
        try {
          await this.applyCutover(error, frontier);
        } catch (cutoverError) {
          const failure = new AggregateError(
            [error, cutoverError],
            'Catch-up window exceeded and the recorded live-edge cutover failed.',
          );
          failure.name = 'CatchUpCutoverFailureError';
          throw failure;
        }
        // A committed cutover is terminal bootstrap evidence for this program.
        // CatchUpScanner verifies that the durable checkpoint is exactly F and
        // skips all historical source reads for it on the next bounded pass.
        terminalCutovers.set(error.program, frontier);
      }
    }
    throw new Error('Bounded catch-up bootstrap did not complete.');
  }

  private async startRollingSweep(program: RollingProgram): Promise<void> {
    if (this.closed || this.inFlight.has(program)) return;
    const operation = this.performRollingSweep(program);
    this.inFlight.set(program, operation);
    await operation;
    if (this.inFlight.get(program) === operation) this.inFlight.delete(program);
    this.scheduleNext(program);
  }

  private async performRollingSweep(program: RollingProgram): Promise<void> {
    const status = this.programStatus[program];
    const startedAtMs = this.readNow();
    const checkpointSlotBefore = status.checkpointSlot;
    const checkpointSignatureBefore = status.checkpointSignature;
    const rpcMetricsBefore = this.readRpcMetrics(program);
    let frontier: FinalizedProgramFrontier | null = null;
    let scanResult: Awaited<ReturnType<CatchUpScanner['scanProgram']>> | null = null;
    let scanFailureDiagnostic: Readonly<{
      readonly pageCount: number;
      readonly signaturesRead: number;
      readonly newestSlot: string | null;
      readonly oldestSlot: string | null;
    }> | null = null;
    let signaturesEnqueuedOnFailure: number | null = null;
    let sweepSucceeded = false;
    status.sweepActive = true;
    this.lastSweepStartedAtMs.set(program, startedAtMs);
    this.publishStatus();
    try {
      if (!this.subscriberRunning()) {
        throw Object.assign(new Error('Rolling catch-up requires active WebSocket subscriptions.'), {
          code: 'WEBSOCKET_NOT_RUNNING', program,
        });
      }
      frontier = await this.readFinalizedFrontier(program);
      status.lastAttemptedFrontierSlot = frontier.slot.toString();
      this.publishStatus();
      scanResult = await this.scanner.scanProgram(program, frontier);
      if (!this.subscriberRunning()) {
        throw Object.assign(new Error('WebSocket subscriptions degraded during rolling catch-up.'), {
          code: 'WEBSOCKET_NOT_RUNNING', program,
        });
      }
      status.checkpointSlot = scanResult.checkpointSlot;
      status.checkpointSignature = scanResult.checkpointSignature;
      status.lastDurableFrontierSlot = scanResult.checkpointSlot;
      status.lastSuccessfulAtMs = this.readNow();
      status.lastSweepPageCount = scanResult.pageCount;
      status.lastSweepSignatureCount = scanResult.signaturesRead;
      status.sweepsSucceeded += 1;
      status.lastErrorCode = null;
      status.lastErrorName = null;
      status.lastErrorStage = null;
      sweepSucceeded = true;
    } catch (error) {
      status.sweepsFailed += 1;
      status.lastErrorCode = errorCode(error);
      status.lastErrorName = errorName(error);
      status.lastErrorStage = errorStage(error);
      if (error instanceof CatchUpWindowExceededError) {
        status.lastSweepPageCount = error.diagnostic.pageCount;
        status.lastSweepSignatureCount = error.diagnostic.signaturesRead;
        scanFailureDiagnostic = error.diagnostic;
        signaturesEnqueuedOnFailure = 0;
      } else if (error instanceof CatchUpSourceError) {
        scanFailureDiagnostic = error.scanDiagnostic;
        signaturesEnqueuedOnFailure = 0;
      } else if (error instanceof CatchUpScannerError) {
        scanFailureDiagnostic = error.scanProgress;
        signaturesEnqueuedOnFailure = error.signaturesEnqueued;
      }
    } finally {
      status.sweepActive = false;
      await this.refreshCheckpointSlots();
      const completedAtMs = this.readNow();
      const rpcMetricsAfter = this.readRpcMetrics(program);
      const metricDelta = rpcMetricsBefore === null || rpcMetricsAfter === null
        ? null : differenceMetrics(rpcMetricsBefore, rpcMetricsAfter);
      const newestSlot = scanResult?.newestSlot ?? scanFailureDiagnostic?.newestSlot ?? null;
      const oldestSlot = scanResult?.oldestSlot ?? scanFailureDiagnostic?.oldestSlot ?? null;
      const sweep: RollingCatchUpSweep = Object.freeze({
        program,
        outcome: sweepSucceeded ? 'SUCCEEDED' : 'FAILED',
        startedAtMs,
        completedAtMs,
        durationMs: Math.max(0, completedAtMs - startedAtMs),
        checkpointSlotBefore,
        checkpointSignatureBefore,
        frontierSlot: frontier?.slot.toString() ?? null,
        frontierSignature: frontier?.signature ?? null,
        checkpointSlotAfter: status.checkpointSlot,
        checkpointSignatureAfter: status.checkpointSignature,
        pageCount: scanResult?.pageCount ?? scanFailureDiagnostic?.pageCount ?? null,
        signaturesRead: scanResult?.signaturesRead ?? scanFailureDiagnostic?.signaturesRead ?? null,
        signaturesEnqueued: scanResult?.signaturesEnqueued ?? signaturesEnqueuedOnFailure,
        requestCount: metricDelta?.requestCount ?? null,
        http429Count: metricDelta?.http429Count ?? null,
        retryCount: metricDelta?.retryCount ?? null,
        retryBackoffTotalMs: metricDelta?.retryBackoffTotalMs ?? null,
        otherRpcErrors: metricDelta?.otherRpcErrors ?? null,
        oldestSlot,
        newestSlot,
        estimatedHeadDistanceSlots: estimatedHeadDistance(frontier?.slot.toString() ?? null, checkpointSlotBefore),
        errorCode: status.lastErrorCode,
      });
      status.lastSweep = sweep;
      try { this.rollingOptions.onSweep?.(sweep); } catch {
        // Sweep telemetry must never change checkpoint or listener behavior.
      }
      this.refreshCoverageState();
      this.publishStatus();
    }
  }

  private scheduleNext(program: RollingProgram): void {
    const intervalMs = this.rollingOptions.intervalsMs?.[program] ?? this.rollingOptions.intervalMs;
    if (this.closed || intervalMs === undefined || this.timers.has(program)) return;
    const elapsedMs = Math.max(0, this.readNow() - (this.lastSweepStartedAtMs.get(program) ?? this.readNow()));
    const delayMs = Math.max(0, intervalMs - elapsedMs);
    const timer = this.scheduler.schedule(() => {
      this.timers.delete(program);
      if (this.closed || this.inFlight.has(program)) return;
      void this.startRollingSweep(program);
    }, delayMs);
    this.timers.set(program, timer);
  }

  private subscriberRunning(): boolean {
    return this.rollingOptions.isSubscriberRunning?.() ?? true;
  }

  private refreshCoverageState(): void {
    if (this.closed) {
      this.coverage = 'STOPPED';
      this.currentState = 'STOPPED';
      return;
    }
    if (!this.bootstrapComplete && this.coverage !== 'BOOTSTRAPPING') {
      return;
    }
    if (!this.subscriberRunning()) {
      this.coverage = 'DEGRADED';
    } else if (!this.bootstrapComplete) {
      this.coverage = 'BOOTSTRAPPING';
    } else if (this.programs.every((program) => {
      const status = this.programStatus[program];
      return status.sweepsSucceeded > 0 && status.lastErrorCode === null;
    })) {
      this.coverage = 'HEALTHY';
    } else if (this.programs.some((program) => this.programStatus[program].sweepsFailed > 0)) {
      this.coverage = 'DEGRADED';
    } else {
      this.coverage = 'WARMING_UP';
    }
    this.currentState = this.coverage === 'HEALTHY'
      ? 'RUNNING'
      : this.coverage === 'DEGRADED' ? 'DEGRADED' : 'STARTING';
  }

  private async refreshCheckpointSlots(): Promise<void> {
    const readCheckpoint = this.rollingOptions.readCheckpoint;
    if (readCheckpoint === undefined) return;
    await Promise.all(this.programs.map(async (program) => {
      try {
        const checkpoint = await readCheckpoint(program);
        this.programStatus[program].checkpointSlot = checkpoint?.slot.toString() ?? null;
        this.programStatus[program].checkpointSignature = checkpoint?.signature ?? null;
      } catch {
        // Keep the last known durable checkpoint without hiding the scan error.
      }
    }));
  }

  private readNow(): number {
    const value = (this.rollingOptions.now ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Rolling catch-up clock is invalid.');
    return value;
  }

  private readRpcMetrics(program: RollingProgram): CatchUpRpcMetrics | null {
    try { return this.rollingOptions.getRpcMetrics?.(program) ?? null; } catch {
      return null;
    }
  }

  private publishStatus(): void {
    try { this.rollingOptions.onStatus?.(this.metrics()); } catch {
      // Telemetry must never affect the catch-up or listener lifecycle.
    }
  }
}

export interface RollingProgramStatus {
  readonly bootstrapMode: ListenerBootstrapMode | null;
  readonly checkpointSlot: string | null;
  readonly checkpointSignature: string | null;
  readonly lastAttemptedFrontierSlot: string | null;
  readonly lastDurableFrontierSlot: string | null;
  readonly lastSuccessfulAtMs: number | null;
  readonly lastSweepPageCount: number;
  readonly lastSweepSignatureCount: number;
  readonly sweepsSucceeded: number;
  readonly sweepsFailed: number;
  readonly sweepActive: boolean;
  readonly lastErrorCode: string | null;
  readonly lastErrorName: string | null;
  readonly lastErrorStage: string | null;
  readonly lastSweep: RollingCatchUpSweep | null;
}

export interface RollingCatchUpSweep {
  readonly program: RollingProgram;
  readonly outcome: 'SUCCEEDED' | 'FAILED';
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly durationMs: number;
  readonly checkpointSlotBefore: string | null;
  readonly checkpointSignatureBefore: string | null;
  readonly frontierSlot: string | null;
  readonly frontierSignature: string | null;
  readonly checkpointSlotAfter: string | null;
  readonly checkpointSignatureAfter: string | null;
  readonly pageCount: number | null;
  readonly signaturesRead: number | null;
  readonly signaturesEnqueued: number | null;
  readonly requestCount: number | null;
  readonly http429Count: number | null;
  readonly retryCount: number | null;
  readonly retryBackoffTotalMs: number | null;
  readonly otherRpcErrors: number | null;
  readonly oldestSlot: string | null;
  readonly newestSlot: string | null;
  readonly estimatedHeadDistanceSlots: string | null;
  readonly errorCode: string | null;
}

export interface RollingCatchUpStatus {
  readonly state: ListenerRuntimeState;
  readonly coverageState: ListenerCoverageState;
  readonly sweepActive: boolean;
  readonly programs: Readonly<Record<'launchpad' | 'market', RollingProgramStatus>>;
}

interface MutableRollingProgramStatus {
  bootstrapMode: ListenerBootstrapMode | null;
  checkpointSlot: string | null;
  checkpointSignature: string | null;
  lastAttemptedFrontierSlot: string | null;
  lastDurableFrontierSlot: string | null;
  lastSuccessfulAtMs: number | null;
  lastSweepPageCount: number;
  lastSweepSignatureCount: number;
  sweepsSucceeded: number;
  sweepsFailed: number;
  sweepActive: boolean;
  lastErrorCode: string | null;
  lastErrorName: string | null;
  lastErrorStage: string | null;
  lastSweep: RollingCatchUpSweep | null;
}

export interface StartupScannerOptions {
  readonly intervalMs?: number;
  /** Programs this scanner bootstraps and sweeps. Defaults to both. */
  readonly programs?: readonly RollingProgram[];
  /** Per-program cadence; only the enabled programs need an entry. */
  readonly intervalsMs?: Readonly<Partial<Record<RollingProgram, number>>>;
  readonly scheduler?: ListenerRuntimeScheduler;
  readonly now?: () => number;
  readonly readCheckpoint?: (program: 'launchpad' | 'market') => Promise<ProcessingCheckpoint | null>;
  readonly isSubscriberRunning?: () => boolean;
  readonly getRpcMetrics?: (program: RollingProgram) => CatchUpRpcMetrics;
  readonly onStatus?: (status: RollingCatchUpStatus) => void;
  readonly onSweep?: (sweep: RollingCatchUpSweep) => void;
}

function initialRollingProgramStatus(): MutableRollingProgramStatus {
  return {
    bootstrapMode: null,
    checkpointSlot: null,
    checkpointSignature: null,
    lastAttemptedFrontierSlot: null,
    lastDurableFrontierSlot: null,
    lastSuccessfulAtMs: null,
    lastSweepPageCount: 0,
    lastSweepSignatureCount: 0,
    sweepsSucceeded: 0,
    sweepsFailed: 0,
    sweepActive: false,
    lastErrorCode: null,
    lastErrorName: null,
    lastErrorStage: null,
    lastSweep: null,
  };
}

function snapshotRollingCatchUpStatus(
  state: ListenerRuntimeState,
  coverageState: ListenerCoverageState,
  sweepActive: boolean,
  values: Record<'launchpad' | 'market', MutableRollingProgramStatus>,
): RollingCatchUpStatus {
  const copy = (value: MutableRollingProgramStatus): RollingProgramStatus => Object.freeze({ ...value });
  return Object.freeze({
    state,
    coverageState,
    sweepActive,
    programs: Object.freeze({ launchpad: copy(values.launchpad), market: copy(values.market) }),
  });
}

/**
 * Validates a rolling program list (non-empty, unique, known, includes the
 * launchpad) and returns it in canonical launchpad-then-market order.
 */
function canonicalRollingPrograms(value: unknown): readonly RollingProgram[] | null {
  if (!Array.isArray(value)) return null;
  const entries: readonly unknown[] = value;
  if (entries.length === 0
    || new Set(entries).size !== entries.length
    || entries.some((key) => key !== 'launchpad' && key !== 'market')
    || !entries.includes('launchpad')) {
    return null;
  }
  return Object.freeze(ROLLING_PROGRAMS.filter((program) => entries.includes(program)));
}

function errorProgram(error: unknown): 'launchpad' | 'market' | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as { readonly program?: unknown }).program;
  return value === 'launchpad' || value === 'market' ? value : null;
}

function requireDurableFrontier(
  result: Readonly<{
    readonly programs: Readonly<Partial<Record<RollingProgram, Readonly<{
      readonly durableFrontier: Readonly<{ signature: string; slot: string }> | null;
    }>>>>;
  }>,
  program: RollingProgram,
): Readonly<{ signature: string; slot: string }> {
  const frontier = result.programs[program]?.durableFrontier ?? null;
  if (frontier === null) {
    throw Object.assign(new Error('Bootstrap completed without a durable program frontier.'), {
      code: 'DURABLE_FRONTIER_MISSING', program,
    });
  }
  return frontier;
}

function errorCode(error: unknown): string | null {
  if (error instanceof CatchUpSourceError) return `CATCH_UP_RPC_${error.stage.toUpperCase()}`;
  if (error instanceof CatchUpScannerError) return `CATCH_UP_SCANNER_${error.stage.toUpperCase()}`;
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_.-]{1,63}$/u.test(code) ? code : null;
}

function errorName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const name = (error as { readonly name?: unknown }).name;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(name) ? name : null;
}

function errorStage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const stage = (error as { readonly stage?: unknown }).stage;
  return typeof stage === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(stage) ? stage : null;
}

function differenceMetrics(before: CatchUpRpcMetrics, after: CatchUpRpcMetrics): CatchUpRpcMetrics {
  const delta = (current: number, previous: number): number => Math.max(0, current - previous);
  return Object.freeze({
    requestCount: delta(after.requestCount, before.requestCount),
    http429Count: delta(after.http429Count, before.http429Count),
    retryCount: delta(after.retryCount, before.retryCount),
    retryBackoffTotalMs: delta(after.retryBackoffTotalMs, before.retryBackoffTotalMs),
    otherRpcErrors: delta(after.otherRpcErrors, before.otherRpcErrors),
  });
}

function estimatedHeadDistance(newestSlot: string | null, checkpointSlot: string | null): string | null {
  if (newestSlot === null || checkpointSlot === null) return null;
  try {
    const distance = BigInt(newestSlot) - BigInt(checkpointSlot);
    return distance < 0n ? null : distance.toString();
  } catch {
    return null;
  }
}

export function guardLiveDecisionConsumer<TArgs extends readonly unknown[]>(
  consumer: ((...args: TArgs) => Promise<void>) | undefined,
  isCoverageHealthy: (...args: TArgs) => boolean,
  onBlocked: () => void,
): ((...args: TArgs) => Promise<void>) | undefined {
  if (consumer === undefined) return undefined;
  return async (...args: TArgs): Promise<void> => {
    if (!isCoverageHealthy(...args)) {
      onBlocked();
      return;
    }
    await consumer(...args);
  };
}

export interface ListenerRuntimeScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface RecurringListenerOptions {
  readonly intervalMs: number;
  readonly shutdownTimeoutMs: number;
  readonly scheduler?: ListenerRuntimeScheduler;
  readonly subscriberMetrics?: () => ProgramSubscriberMetrics;
  readonly onWritten?: (heartbeat: RuntimeHeartbeat) => void;
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
  private timer: unknown = null;
  private inFlight: Promise<unknown> | null = null;
  private closePromise: Promise<void> | null = null;
  private closed = false;

  public constructor(
    private readonly reconciler: { readonly runOnce: () => Promise<unknown> },
    options: RecurringListenerOptions,
  ) {
    validateRecurringOptions(options);
    this.intervalMs = options.intervalMs;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs;
    this.scheduler = options.scheduler ?? listenerScheduler;
  }

  public async start(): Promise<void> {
    if (this.closed) return;
    this.currentState = 'STARTING';
    try {
      await this.reconciler.runOnce();
      this.currentState = 'RUNNING';
      this.schedule();
    } catch (error) {
      this.currentState = 'DEGRADED';
      throw error;
    }
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

  private schedule(): void {
    if (this.closed) return;
    this.timer = this.scheduler.schedule(() => {
      this.timer = null;
      if (this.closed) return;
      const operation = this.reconciler.runOnce();
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

  private async performClose(): Promise<void> {
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
  private readonly subscriberMetrics: (() => ProgramSubscriberMetrics) | undefined;
  private readonly onWritten: ((heartbeat: RuntimeHeartbeat) => void) | undefined;
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
    this.subscriberMetrics = options.subscriberMetrics;
    this.onWritten = options.onWritten;
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
    const metrics = this.subscriberMetrics?.();
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
      ...(metrics === undefined ? {} : {
        websocketEventsReceived: metrics.eventsReceived,
        websocketEnqueuesCompleted: metrics.enqueuesCompleted,
      }),
    });
    await this.inbox.writeHeartbeat(value);
    this.onWritten?.(value);
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

// Pool reads go through rpc.http so its per-method telemetry counts them; undefined cursors are
// omitted because web3.js options are exact-optional.
function poolSignaturesRpc(rpc: SolanaRpcClient): PoolSignaturesRpc {
  return {
    getSignaturesForAddress(address, options, commitment): Promise<unknown> {
      return rpc.http.getSignaturesForAddress(address, {
        limit: options.limit,
        ...(options.before === undefined ? {} : { before: options.before }),
        ...(options.until === undefined ? {} : { until: options.until }),
      }, commitment);
    },
  };
}

function catchUpRpc(rpc: SolanaRpcClient): {
  getSignaturesForAddress(
    address: PublicKey,
    options: { readonly before: string | undefined; readonly limit: number },
    commitment: Commitment,
  ): Promise<unknown>;
} {
  return {
    getSignaturesForAddress(address, options, commitment): Promise<unknown> {
      const request = options.before === undefined
        ? { limit: options.limit }
        : { before: options.before, limit: options.limit };
      const finality: Finality = commitment === 'finalized' ? 'finalized' : 'confirmed';
      return rpc.catchUpHttp.getSignaturesForAddress(address, request, finality);
    },
  };
}
