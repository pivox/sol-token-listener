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

type ProductionPool = ReturnType<typeof getDatabasePool>;

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
  const inbox = new PostgresTransactionInboxRepository(pool);
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
  const pipeline = new ObservedTransactionPipeline(
    launchpadRepository,
    launchpad,
    funding,
    participants,
    graph,
    marketPipeline,
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
    config.reconcileSeconds * 1_000,
  );
  const subscriberComponent = lifecycleComponent(subscriber);
  const workerComponent = lifecycleComponent(worker);
  const heartbeat = new PersistentListenerHeartbeat(
    inbox,
    rpc,
    () => subscriber.state,
    () => scanner.state(),
    () => worker.state,
    () => reconciler.state(),
  );

  return new SolanaListenerRuntime({
    rpc,
    scanner,
    subscriber: subscriberComponent,
    worker: workerComponent,
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

class RecurringFinalityReconciler {
  private currentState: ListenerRuntimeState = 'STOPPED';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  public constructor(
    private readonly reconciler: FinalityReconciler,
    private readonly intervalMs: number,
  ) {}

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
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.currentState = 'STOPPED';
    return Promise.resolve();
  }

  public state(): ListenerRuntimeState {
    return this.currentState;
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reconciler.runOnce().then(
        () => {
          this.currentState = 'RUNNING';
          this.schedule();
        },
        () => {
          this.currentState = 'DEGRADED';
          this.schedule();
        },
      );
    }, this.intervalMs);
    this.timer.unref();
  }
}

class PersistentListenerHeartbeat {
  private currentState: ListenerRuntimeState = 'STOPPED';
  private startedAtMs = 0;
  private lastHttpSlot: bigint | null = null;
  private lastFinalizedSlot: bigint | null = null;
  private backlogCount = 0;
  private leasedCount = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    private readonly inbox: Pick<TransactionInboxRepository, 'counts' | 'writeHeartbeat'>,
    private readonly rpc: Pick<SolanaRpcClient, 'getSlot' | 'getFinalizedSlot'>,
    private readonly subscriberState: () => ListenerRuntimeState,
    private readonly scannerState: () => ListenerRuntimeState,
    private readonly workerState: () => ListenerRuntimeState,
    private readonly reconcilerState: () => ListenerRuntimeState,
  ) {}

  public async start(): Promise<void> {
    this.currentState = 'RUNNING';
    this.startedAtMs = Date.now();
    await this.write('RUNNING');
    this.schedule();
  }

  public async stop(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.write('STOPPED');
    this.currentState = 'STOPPED';
  }

  public state(): ListenerRuntimeState {
    return this.currentState;
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.write('RUNNING').then(
        () => {
          this.currentState = 'RUNNING';
          this.schedule();
        },
        () => {
          this.currentState = 'DEGRADED';
          this.schedule();
        },
      );
    }, 5_000);
    this.timer.unref();
  }

  private async write(runtimeState: 'RUNNING' | 'STOPPED'): Promise<void> {
    if (runtimeState === 'RUNNING') {
      const [counts, slots] = await Promise.all([
        this.inbox.counts(),
        Promise.all([this.rpc.getSlot(), this.rpc.getFinalizedSlot()]),
      ]);
      this.lastHttpSlot = slots[0];
      this.lastFinalizedSlot = slots[1];
      this.backlogCount = counts.pending + counts.processing;
      this.leasedCount = counts.processing;
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
    });
    await this.inbox.writeHeartbeat(value);
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
