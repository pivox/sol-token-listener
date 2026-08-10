import type { Commitment, Finality, PublicKey } from '@solana/web3.js';
import type { AppConfig } from '../config/env.js';
import type {
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
import { SolanaCatchUpSource } from '../solana/rpc/catch-up-source.js';
import { SolanaMarketRpcReader } from '../solana/rpc/market-rpc-reader.js';
import { SolanaProgramSubscriber } from '../solana/rpc/program-subscriber.js';
import { SolanaRpcClient } from '../solana/rpc/rpc-client.js';
import { SolanaTransactionLocator } from '../solana/rpc/transaction-locator.js';
import { SolanaWalletFundingEvidenceExtractor } from '../solana/wallet-funding-evidence-extractor.js';
import { getDatabasePool } from '../storage/database.js';
import { PostgresLaunchpadEventRepository } from '../storage/launchpad-event.repository.js';
import { PostgresMarketObservationRepository } from '../storage/market-observation.repository.js';
import { PostgresParticipantAnalyticsRepository } from '../storage/participant-analytics.repository.js';
import { PostgresPaperDecisionRepository } from '../storage/paper-decision.repository.js';
import { PostgresPaperTradingRepository } from '../storage/paper-trading.repository.js';
import { PostgresPaperVenueReader } from '../storage/paper-venue.reader.js';
import { PostgresSocialEvidenceRepository } from '../storage/social-evidence.repository.js';
import { PostgresTransactionInboxRepository } from '../storage/transaction-inbox.repository.js';
import { PostgresWalletEvidenceRepository } from '../storage/wallet-evidence.repository.js';
import { PostgresWalletGraphRepository } from '../storage/wallet-graph.repository.js';
import { CatchUpScanner } from './catch-up-scanner.js';
import { FinalityReconciler } from './finality-reconciler.js';
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
import { QualificationRebuildService } from './qualification-rebuild.service.js';
import { TradingCandidateService } from './trading-candidate.service.js';
import { ValidatedExternalBuysStrategy } from './validated-external-buys.strategy.js';
import { QualificationEngine } from '../qualification/qualification-engine.js';
import { loadQualificationProfile } from '../qualification/qualification-profile.js';

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

export function createProductionListenerRuntime(
  config: AppConfig,
  pool: ProductionPool = getDatabasePool(),
): ListenerRuntime {
  const rpc = new SolanaRpcClient(config);
  const inbox = new PostgresTransactionInboxRepository(pool, Object.freeze({
    maxAttempts: config.rpcRetryMaxAttempts,
    baseDelayMs: config.rpcRetryBaseDelayMs,
  }));
  const locator = new SolanaTransactionLocator(rpc);
  const catchUp = new CatchUpScanner(
    new SolanaCatchUpSource(catchUpRpc(rpc), config.commitment),
    inbox,
    {
      pageSize: config.listenerCatchUpPageSize,
      maxPages: config.listenerCatchUpMaxPages,
    },
  );
  const scanner = new StartupScanner(catchUp);
  const subscriber = new SolanaProgramSubscriber(rpc.http, inbox);

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
    maxPerHostConcurrency: 1,
  });
  const socialWorker = new SocialEnrichmentWorker(
    new PostgresSocialEvidenceRepository(pool),
    new HttpMetadataProvider(publicHttp),
    new PublicSocialVerificationProvider(publicHttp),
    {
      pollIntervalMs: config.socialWorkerPollMs,
      leaseMs: config.socialWorkerLeaseSeconds * 1_000,
      renewalIntervalMs: Math.floor(config.socialWorkerLeaseSeconds * 1_000 / 3),
      shutdownTimeoutMs: config.listenerShutdownTimeoutMs,
    },
  );
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
  const paperRepository = new PostgresPaperDecisionRepository(pool, {
    maxAttempts: config.paperDecisionRetryMaxAttempts,
    baseDelayMs: config.paperDecisionRetryBaseDelayMs,
    retentionHours: 4,
  });
  const qualificationProfile = loadQualificationProfile({
    profilePath: config.qualificationProfilePath,
    minimumScoreOverride: config.qualificationMinimumScore,
  });
  const qualificationEngine = new QualificationEngine(qualificationProfile);
  const quoteRouter = new CanonicalPaperQuoteRouter(
    new PostgresPaperVenueReader(() => rpc.getSlot(), pool),
    new PumpFunPaperQuoteProvider(marketRpc),
    market,
    {
      maxAgeMs: config.paperQuoteMaxAgeMs,
      maxSlotLag: BigInt(config.paperQuoteMaxSlotLag),
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
    new QualificationRebuildService(qualificationEngine),
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
    () => scanner.state(),
    () => worker.state,
    () => reconciler.state(),
    { intervalMs: 5_000, shutdownTimeoutMs: config.listenerShutdownTimeoutMs },
  );

  return new SolanaListenerRuntime({
    rpc,
    scanner,
    subscriber: subscriberComponent,
    worker: workerComponent,
    paperWorker: paperWorkerComponent,
    socialWorker: socialWorkerComponent,
    reconciler,
    heartbeat,
  }, { shutdownTimeoutMs: config.listenerShutdownTimeoutMs });
}

class StartupScanner {
  private currentState: ListenerRuntimeState = 'STOPPED';

  public constructor(private readonly scanner: CatchUpScanner) {}

  public async scan(): Promise<void> {
    this.currentState = 'STARTING';
    try {
      await this.scanner.scan();
      this.currentState = 'RUNNING';
    } catch (error) {
      this.currentState = 'DEGRADED';
      throw error;
    }
  }

  public close(): Promise<void> {
    this.currentState = 'STOPPED';
    return Promise.resolve();
  }

  public state(): ListenerRuntimeState {
    return this.currentState;
  }
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
      return rpc.http.getSignaturesForAddress(address, request, finality);
    },
  };
}
