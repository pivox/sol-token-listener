import { pathToFileURL } from 'node:url';
import { Connection, type AccountInfo } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { loadConfig } from '../config/env.js';
import { createProductionListenerRuntime } from '../application/production-listener-factory.js';
import { startLiveApplication, type LiveApplicationComponents } from '../application/live-application.js';
import { QualificationEngine } from '../qualification/qualification-engine.js';
import { loadQualificationProfile } from '../qualification/qualification-profile.js';
import { PaperTradingEngine } from '../paper/paper-trading-engine.js';
import { PostgresPaperTradingRepository } from '../storage/paper-trading.repository.js';
import { SolanaMarketRpcReader } from '../solana/rpc/market-rpc-reader.js';
import { PostgresLiveOrderJournal } from '../live/postgres-live-order-journal.js';
import { PostgresLivePositionRepository } from '../live/postgres-live-position-repository.js';
import { loadLiveKeypairFile, type KeypairLiveSigner } from '../live/keypair-live-signer.js';
import { LiveTransactionExecutor } from '../live/live-transaction-executor.js';
import { SolanaLiveTransactionRpc } from '../live/solana-live-transaction-rpc.js';
import { parseLivePolicy } from '../live/live-policy.js';
import { runNetworkPreflight } from '../live/network-preflight.js';
import { LiveDecisionController } from '../live/live-decision-controller.js';
import { PumpFunPaperQuoteProvider } from '../paper/pumpfun-paper-quote.provider.js';
import { getDatabasePool, closeDatabase } from '../storage/database.js';
import { ValidatedExternalBuysStrategy } from '../application/validated-external-buys.strategy.js';
import { LivePositionMarketResolver } from '../live/live-position-market-route.js';
import { PumpSwapDirectPoolVenueReader } from '../live/pumpswap-direct-pool-resolver.js';
import { PumpSwapLiveSellAdapter } from '../live/pumpswap-live-sell-adapter.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { formatLiveStartupDiagnostics } from '../live/live-startup-diagnostics.js';

export interface LiveRunArguments { readonly stopEntries: boolean }

/** Exact public CLI arguments: no args or --stop-entries. */
export function parseLiveRunArgs(args: readonly string[]): LiveRunArguments {
  if (args.length === 0) return Object.freeze({ stopEntries: false });
  if (args.length === 1 && args[0] === '--stop-entries') return Object.freeze({ stopEntries: true });
  throw new Error(`Unsupported live:run argument: ${args[0] ?? ''}`);
}

/** Only the exercised SPL/Token-2022 base with native-SOL/wSOL quote can enter live composition. */
export function assertLiveVenueReady(quoteMints: readonly string[] = [NATIVE_MINT.toBase58()]): void {
  if (quoteMints.length === 0 || quoteMints.some((mint) => mint !== NATIVE_MINT.toBase58())) {
    throw new Error('The initial live profile supports only SPL Token or Token-2022 base tokens paired with native SOL/wSOL through PumpSwap.');
  }
}

export async function runLiveCli(
  args: readonly string[] = process.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const options = parseLiveRunArgs(args);
  const policy = parseLivePolicy(environment);
  if (environment.DATABASE_URL === undefined || environment.DATABASE_URL.trim().length === 0) {
    throw new Error('DATABASE_URL must be explicitly provided for live; development defaults are not allowed.');
  }
  const config = loadConfig(environment);
  if (config.cluster !== 'mainnet-beta' || !config.listenerEnabled || config.autoMigrate) {
    throw new Error('Live requires mainnet-beta, an enabled listener, and production auto-migration disabled.');
  }
  assertLiveVenueReady(config.paperQuoteMintAllowlist);
  const preflight = await runNetworkPreflight(config.httpRpcUrl, policy.expectedGenesisHash);
  if (preflight.status !== 'PASS') throw new Error('Live RPC preflight was blocked.');
  const application = await startLiveApplication(async () => buildProductionComponents(config, policy, options));
  const sessionTimer = setTimeout(() => { application.stopEntries(); }, policy.maxSessionSeconds * 1_000);
  try { await waitForShutdown(); }
  finally { clearTimeout(sessionTimer); await application.close(); }
}

async function buildProductionComponents(
  config: ReturnType<typeof loadConfig>,
  policy: ReturnType<typeof parseLivePolicy>,
  options: LiveRunArguments,
): Promise<LiveApplicationComponents> {
  const pool = getDatabasePool(config.databaseUrl);
  try {
    const schema = await pool.query<{ version: string }>(
      "SELECT version FROM migration_history WHERE version = ANY($1::text[])",
      [['016_live_order_journal.sql', '017_live_positions.sql', '018_live_position_market_route.sql', '019_live_position_market_route_recovery.sql','020_live_position_market_resolution.sql']],
    );
    const versions = new Set(schema.rows.map((row) => row.version));
    if (!versions.has('016_live_order_journal.sql') || !versions.has('017_live_positions.sql')
      || !versions.has('018_live_position_market_route.sql') || !versions.has('019_live_position_market_route_recovery.sql')
      || !versions.has('020_live_position_market_resolution.sql')) {
      throw new Error('Live journal and position migrations must already be applied; live:run never migrates a database.');
    }
    const signer: KeypairLiveSigner = await loadLiveKeypairFile(policy.keypairFile, policy.expectedWallet);
    const connection = new Connection(config.httpRpcUrl, config.commitment);
    const rpc = new SolanaLiveTransactionRpc(connection, config.finality);
    const journal = new PostgresLiveOrderJournal(pool);
    const positions = new PostgresLivePositionRepository(pool);
    const executor = new LiveTransactionExecutor(rpc, journal, signer, {
      commitment: config.finality, confirmationPolls: 5, delayMs: 1_000,
      maxPriorityFeeLamports: policy.maxPriorityFeeLamports,
      exitReserveLamports: policy.exitReserveLamports,
      maximumBalanceAgeMs: config.paperQuoteMaxAgeMs,
    });
    const marketRpc = new SolanaMarketRpcReader(connection, config.commitment);
    const liveQuotes = new PumpFunPaperQuoteProvider(marketRpc);
    const marketResolver = new LivePositionMarketResolver(
      new PumpSwapDirectPoolVenueReader(marketRpc,Date.now,config.finality==='finalized'?'finalized':'confirmed'),positions,5);
    const pumpSwapSales = new PumpSwapLiveSellAdapter(marketRpc);
    const qualificationProfile = loadQualificationProfile({
      profilePath: config.qualificationProfilePath,
      minimumScoreOverride: config.qualificationMinimumScore,
    });
    const strategy = new ValidatedExternalBuysStrategy(
      new PaperTradingEngine(config, new PostgresPaperTradingRepository(pool), qualificationProfile,
        new QualificationEngine(qualificationProfile)),
      liveQuotes,
      { retentionMs: 14_400_000 },
    );
    const controller = new LiveDecisionController({
      policy, externalBuyTarget: config.paperExternalBuyTarget,
      minimumConfirmation: config.paperMinimumConfirmation, maximumQuoteAgeMs: config.paperQuoteMaxAgeMs,
      executor, journal, positions, quotes: liveQuotes, strategy, now: Date.now,
      marketResolver, pumpSwapSales,
      readAssociatedTokenAccount: async (mint, owner, tokenProgram): Promise<AccountInfo<Buffer> | null> => {
        const address = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
        return connection.getAccountInfo(address, config.commitment);
      },
      onAdmissionRejected: (decision):void => { process.stderr.write(`${JSON.stringify({type:'LIVE_BUY_REJECTED',...decision})}\n`); },
    });
    if (options.stopEntries) controller.stopEntries();
    const listener = createProductionListenerRuntime(config, pool, (result, snapshot) => controller.consume(result, snapshot));
    return {
      controller, listener,
      acquireWalletLock: () => journal.acquireWalletLock(policy.expectedWallet),
      closePool: closeDatabase,
    };
  } catch (error) {
    await closeDatabase();
    throw error;
  }
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    let stopping = false;
    const finish = (): void => {
      if (stopping) return;
      stopping = true;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve();
    };
    const onSignal = (): void => { finish(); };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runLiveCli().catch((error: unknown) => {
    process.stderr.write(`Live startup refused: ${JSON.stringify(formatLiveStartupDiagnostics(error))}\n`);
    process.exitCode = 2;
  });
}
