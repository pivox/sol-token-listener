import { config } from './config/env.js';
import { DashboardActionService } from './dashboard/dashboard-action.service.js';
import { Dashboard } from './dashboard/dashboard.js';
import { PoolDiscoveryListener } from './discovery/pool-discovery.listener.js';
import { RaydiumCpmmAdapter } from './dex/raydium-cpmm/raydium-cpmm.adapter.js';
import { SolanaTransactionSimulator } from './execution/transaction-simulator.js';
import { TransactionConfirmer } from './execution/transaction-confirmer.js';
import { TransactionQueue } from './execution/transaction-queue.js';
import { TradeExecutor } from './execution/trade-executor.js';
import { loadWallet } from './execution/wallet.js';
import { Heartbeat } from './heartbeat/heartbeat.js';
import { PoolSwapRouter } from './listeners/pool-swap.router.js';
import { ProgramTransactionListener } from './listeners/program-transaction.listener.js';
import { TokenRiskService } from './security/token-risk.service.js';
import { ProgramFinalityReconciler } from './solana/rpc/finality-reconciler.js';
import { SolanaRpcClient } from './solana/rpc/rpc-client.js';
import { ProgramTransactionSubscription } from './solana/rpc/subscriptions.js';
import { TransactionFetcher } from './solana/rpc/transaction-fetcher.js';
import { closeDatabase, migrateDatabase } from './storage/database.js';
import { IgnoredAssetRepository } from './storage/ignored-asset.repository.js';
import {
  CheckpointRepository,
  PoolRepository,
  RiskReportRepository,
  SessionRepository,
  SwapEventRepository,
  TradeRepository,
} from './storage/repositories.js';
import { SessionEngine } from './strategy/session-engine.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  logger.info({ executionMode: config.executionMode, cluster: config.cluster }, 'Démarrage de solana-token-listener.');
  if (config.autoMigrate) await migrateDatabase();
  const rpc = new SolanaRpcClient(config);
  const health = await rpc.checkHealth();
  logger.info({ version: health.version, httpSlot: health.httpSlot.toString(), finalizedSlot: health.finalizedSlot.toString() }, 'RPC Solana vérifié.');

  const wallet = await loadWallet({
    keypairPath: config.keypairPath,
    privateKeyBase58: config.privateKeyBase58,
    live: config.executionMode === 'live',
  });
  logger.info({ wallet: wallet.address, source: wallet.source, executionMode: config.executionMode }, 'Wallet d’exécution chargé sans exposer le secret.');

  const poolRepository = new PoolRepository();
  const sessionRepository = new SessionRepository();
  const swapRepository = new SwapEventRepository();
  const tradeRepository = new TradeRepository();
  const riskRepository = new RiskReportRepository();
  const checkpoints = new CheckpointRepository();
  const ignored = new IgnoredAssetRepository();
  const fetcher = new TransactionFetcher(rpc);
  const adapter = new RaydiumCpmmAdapter(rpc, config);
  const simulator = new SolanaTransactionSimulator(rpc.http);
  const confirmer = new TransactionConfirmer(rpc.http);
  const queue = new TransactionQueue();
  const executor = new TradeExecutor(
    adapter,
    wallet,
    config,
    simulator,
    confirmer,
    fetcher,
    queue,
    tradeRepository,
  );
  const risk = new TokenRiskService(rpc.http, adapter, simulator, riskRepository, config);
  const engine = new SessionEngine(
    adapter,
    risk,
    executor,
    wallet,
    sessionRepository,
    swapRepository,
    tradeRepository,
    riskRepository,
    config,
    logger,
  );
  await engine.restore();

  const discovery = new PoolDiscoveryListener(adapter, poolRepository, ignored, engine, config, logger);
  const swaps = new PoolSwapRouter(adapter, engine);
  const listener = new ProgramTransactionListener(discovery, swaps, logger);
  const heartbeat = new Heartbeat(() => engine.activeCount());
  heartbeat.http(health.httpSlot);
  heartbeat.finalized(health.finalizedSlot);
  heartbeat.start();

  const subscription = new ProgramTransactionSubscription(
    rpc,
    fetcher,
    config.raydiumCpmmProgramId,
    (transaction) => listener.process(transaction),
    logger,
    (slot, signature, pending) => heartbeat.websocket(slot, signature, pending),
  );

  const reconciler = new ProgramFinalityReconciler(
    rpc,
    fetcher,
    checkpoints,
    'raydium-cpmm-program',
    config.raydiumCpmmProgramId,
    {
      onFinalizedTransaction: (transaction) => listener.process(transaction),
      onFinalizedSignature: async (signature) => {
        await Promise.all([
          poolRepository.markFinalizedBySignature(signature),
          swapRepository.markFinalizedBySignature(signature),
        ]);
      },
      onOrphanedSignature: async (signature) => {
        const pools = await poolRepository.markOrphanedBySignature(signature);
        await swapRepository.markOrphanedBySignature(signature);
        for (const pool of pools) await engine.markPoolOrphaned(pool, `Signature de création ${signature} orpheline.`);
        await engine.markSignatureOrphaned(signature);
      },
    },
    logger,
    config.reconcileSeconds * 1000,
  );

  const actionService = new DashboardActionService(engine, config.dashboardActionsEnabled);
  const dashboard = new Dashboard(config, poolRepository, sessionRepository, tradeRepository, riskRepository, heartbeat, actionService, logger);
  if (config.dashboardEnabled) dashboard.start();

  subscription.start();
  await reconciler.bootstrapToLatestIfEmpty();
  reconciler.start();

  const metricTimer = setInterval(() => {
    void Promise.all([rpc.getSlot(rpc.commitment), rpc.getSlot(rpc.finality)]).then(([httpSlot, finalizedSlot]) => {
      heartbeat.http(httpSlot);
      heartbeat.finalized(finalizedSlot);
    }).catch((error) => logger.warn({ err: error }, 'Métriques RPC momentanément indisponibles.'));
  }, 5_000);
  metricTimer.unref();

  const finalityTimer = setInterval(() => {
    void Promise.all([
      poolRepository.listConfirmedSignatures(),
      swapRepository.listConfirmedSignatures(),
    ]).then(([poolSignatures, swapSignatures]) => reconciler.reconcileConfirmationStatuses(
      [...new Set([...poolSignatures, ...swapSignatures])].slice(0, 256),
    )).catch((error) => logger.warn({ err: error }, 'Contrôle de finalité des événements confirmés échoué.'));
  }, 60_000);
  finalityTimer.unref();

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Arrêt ordonné demandé.');
    clearInterval(metricTimer);
    clearInterval(finalityTimer);
    reconciler.stop();
    await subscription.stop();
    engine.stop();
    heartbeat.stop();
    if (config.dashboardEnabled) await dashboard.stop();
    await closeDatabase();
  };
  process.once('SIGINT', () => { void shutdown('SIGINT').then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM').then(() => process.exit(0)); });
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Démarrage impossible.');
  void closeDatabase().finally(() => { process.exitCode = 1; });
});
