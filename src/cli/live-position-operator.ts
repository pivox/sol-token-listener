import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { Connection, PublicKey } from '@solana/web3.js';
import { PostgresLiveOrderJournal } from '../live/postgres-live-order-journal.js';
import { PostgresLivePositionRepository, type LivePositionMarketRoute } from '../live/postgres-live-position-repository.js';
import { LivePositionMarketResolver } from '../live/live-position-market-route.js';
import { fillFromOrder, parseStoredBalance } from '../live/live-decision-controller.js';
import { reconcileLiveTokenBalance } from '../live/live-token-reconciliation.js';
import { SolanaMarketRpcReader } from '../solana/rpc/market-rpc-reader.js';
import { PumpSwapLiveSellAdapter } from '../live/pumpswap-live-sell-adapter.js';
import { PumpSwapDirectPoolVenueReader } from '../live/pumpswap-direct-pool-resolver.js';
import type { MarketRpcReader } from '../ports/market-rpc-reader.js';

export type LivePositionOperatorCommand =
  | { readonly kind: 'status'; readonly positionId: string; readonly wallet: string }
  | { readonly kind: 'recheck'; readonly positionId: string; readonly wallet: string; readonly additionalChecks: number };

export interface LivePositionOperatorReadTransport {
  readonly transactions: Pick<Connection, 'getSignatureStatuses' | 'getTransaction'>;
  readonly marketAccounts: MarketRpcReader;
}
export interface LivePositionOperatorDependencies {
  /** Read-only injection used by isolated tests; there is no signer or send API here. */
  readonly createReadTransport?: (endpoint: string) => LivePositionOperatorReadTransport;
}

export function parseLivePositionOperatorArgs(args: readonly string[]): LivePositionOperatorCommand {
  const [command, ...rest] = args;
  if (command !== 'status' && command !== 'recheck') throw new Error('Usage: live:position:operator <status|recheck> --position <id> --wallet <pubkey> [--additional-checks <1..20>]');
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]; const value = rest[index + 1];
    if ((flag !== '--position' && flag !== '--wallet' && flag !== '--additional-checks') || value === undefined || values.has(flag)) {
      throw new Error('Operator arguments are malformed or duplicated.');
    }
    values.set(flag, value);
  }
  const positionId = values.get('--position'); const wallet = values.get('--wallet');
  if (positionId?.trim() !== positionId || !positionId || wallet?.trim() !== wallet || !wallet
    || new PublicKey(wallet).toBase58() !== wallet) throw new Error('A position id and canonical wallet public key are required.');
  if (command === 'status') {
    if (values.has('--additional-checks')) throw new Error('--additional-checks applies only to recheck.');
    return Object.freeze({ kind: 'status', positionId, wallet });
  }
  const budgetText = values.get('--additional-checks');
  const additionalChecks = budgetText === undefined ? NaN : Number(budgetText);
  if (!Number.isSafeInteger(additionalChecks) || additionalChecks < 1 || additionalChecks > 20) {
    throw new Error('recheck requires --additional-checks between 1 and 20.');
  }
  return Object.freeze({ kind: 'recheck', positionId, wallet, additionalChecks });
}

export async function runLivePositionOperatorCli(
  args: readonly string[] = process.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: LivePositionOperatorDependencies = {},
): Promise<void> {
  const command = parseLivePositionOperatorArgs(args);
  const databaseUrl = environment.LIVE_OPERATOR_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error('LIVE_OPERATOR_DATABASE_URL is required; dotenv is not loaded.');
  if (command.kind === 'recheck' && !environment.LIVE_OPERATOR_HTTP_RPC_URL) {
    throw new Error('LIVE_OPERATOR_HTTP_RPC_URL is required for bounded read-only pool verification.');
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const applied=await pool.query<{version:string}>("SELECT version FROM migration_history WHERE version = ANY($1::text[])",
      [['016_live_order_journal.sql','017_live_positions.sql','018_live_position_market_route.sql','019_live_position_market_route_recovery.sql','020_live_position_market_resolution.sql']]);
    const versions=new Set(applied.rows.map((row)=>row.version));
    if(versions.size!==5)throw new Error('Live operator requires migrations 016–020; it never migrates a database.');
    const positions = new PostgresLivePositionRepository(pool);
    const position = await positions.get(command.positionId);
    if (position?.wallet !== command.wallet) throw new Error('Position does not exist for the supplied wallet.');
    if (command.kind === 'status') {
      const route = await positions.getMarketRoute(position.positionId);
      process.stdout.write(`${JSON.stringify(formatStatus(position, route))}\n`);
      return;
    }
    if (position.status !== 'OPEN' || position.remainingRaw === null || position.remainingRaw <= 0n) {
      throw new Error('Operator recheck requires an open position with a known positive remainder.');
    }
    const journal = new PostgresLiveOrderJournal(pool);
    const lease = await journal.acquireWalletLock(command.wallet);
    try {
      const endpoint=required(environment.LIVE_OPERATOR_HTTP_RPC_URL);
      const connection=dependencies.createReadTransport?.(endpoint);
      const rpc=connection?.transactions??new Connection(endpoint,'confirmed');
      const marketAccounts=connection?.marketAccounts??new SolanaMarketRpcReader(rpc as Connection,'confirmed');
      for (const order of await journal.listUnresolved(command.wallet)) {
        if (order.signature === null) throw new Error(`Order ${order.orderId} has no signature and must be resolved from its durable intent before pool recheck.`);
        const statusResult = await rpc.getSignatureStatuses([order.signature], { searchTransactionHistory: true });
        const status = statusResult.value[0];
        if (status == null) throw new Error(`Order ${order.orderId} remains UNKNOWN; pool recheck was not rearmed.`);
        if (status.err !== null) {
          await journal.resolve(order.orderId, 'FAILED', { signature: order.signature, err: status.err, source: 'operator-read-only-status-check' });
          continue;
        }
        if (status.confirmationStatus !== 'confirmed' && status.confirmationStatus !== 'finalized') {
          throw new Error(`Order ${order.orderId} is only ${status.confirmationStatus ?? 'processed'}; pool recheck was not rearmed.`);
        }
        const transaction = await rpc.getTransaction(order.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (transaction?.meta === null || transaction === null) throw new Error(`Order ${order.orderId} has no usable transaction metadata; pool recheck was not rearmed.`);
        if (transaction.meta.err !== null) {
          await journal.resolve(order.orderId, 'FAILED', { signature: order.signature, slot: String(transaction.slot), err: transaction.meta.err });
          continue;
        }
        const mint = order.intent.mint;
        if (typeof mint !== 'string' || mint.length === 0) throw new Error(`Order ${order.orderId} has no persisted mint identity.`);
        const metadata = transaction.meta;
        const balance = reconcileLiveTokenBalance({ transaction: { meta: {
          err: metadata.err,
          ...(Array.isArray(metadata.preTokenBalances) ? { preTokenBalances: metadata.preTokenBalances } : {}),
          ...(Array.isArray(metadata.postTokenBalances) ? { postTokenBalances: metadata.postTokenBalances } : {}),
        } }, owner: order.wallet, mint });
        if (balance.status !== 'KNOWN') throw new Error(`Order ${order.orderId} has unresolved token quantities (${balance.reason}); pool recheck was not rearmed.`);
        const serializedBalance = { status: 'KNOWN', owner: balance.owner, mint: balance.mint,
          preAmountRaw: balance.preAmountRaw.toString(), postAmountRaw: balance.postAmountRaw.toString(), deltaRaw: balance.deltaRaw.toString() };
        await journal.resolve(order.orderId, 'CONFIRMED', { signature: order.signature, slot: String(transaction.slot), commitment: status.confirmationStatus, tokenBalance: serializedBalance });
        const fill = fillFromOrder(order, order.signature, balance);
        if (order.side === 'BUY') await positions.applyBuy(fill); else await positions.applySell(fill);
      }
      for (const order of await journal.listConfirmedNeedingFill(command.wallet)) {
        if (order.signature === null) throw new Error(`Confirmed order ${order.orderId} has no signature.`);
        const fill = fillFromOrder(order, order.signature, parseStoredBalance(order.transactionMetadata.tokenBalance));
        if (order.side === 'BUY') await positions.applyBuy(fill); else await positions.applySell(fill);
      }
      const reconciledPosition = await positions.get(command.positionId);
      if (reconciledPosition?.status !== 'OPEN' || reconciledPosition.remainingRaw === null || reconciledPosition.remainingRaw <= 0n) {
        throw new Error('Position quantities remain unresolved after order reconciliation; pool recheck was not rearmed.');
      }
      const resolver = new LivePositionMarketResolver(
        new PumpSwapDirectPoolVenueReader(marketAccounts,Date.now,'confirmed'),
        positions,command.additionalChecks);
      const current = await positions.getMarketRoute(position.positionId);
      if (current?.state !== 'RETRY_EXHAUSTED') throw new Error('Operator recheck requires a persisted RETRY_EXHAUSTED route.');
      const result = await resolver.resumeAfterOperatorReview(position, command.additionalChecks);
      if(result.state==='PUMPSWAP'){
        try{
          const verifier=new PumpSwapLiveSellAdapter(marketAccounts);
          await verifier.plan({pool:result.pool,user:new PublicKey(position.wallet),amountInRaw:position.remainingRaw,slippageBps:0n});
        }catch(error){
          const reason=error instanceof Error?error.message:'PumpSwap account validation failed.';
          const route=result.route;
          await positions.recordMarketRoute({...route,state:'RETRY_EXHAUSTED',poolAddress:null,
            attempts:route.retryBudget??command.additionalChecks,lastError:`pool account revalidation failed: ${reason}`,
            retryHistory:[...(route.retryHistory??[]),{state:'RETRY_EXHAUSTED',attempts:route.retryBudget??command.additionalChecks,
              error:`pool account revalidation failed: ${reason}`,at:new Date().toISOString()}]});
          throw new Error('Canonical pool was found but live account validation failed; incident persisted, no trade submitted.');
        }
      }
      process.stdout.write(`${JSON.stringify({ positionId: position.positionId, wallet: position.wallet,
        state: result.state, attempts: result.route.attempts, retryGeneration: result.route.retryGeneration,
        retryBudget: result.route.retryBudget, poolAddress: result.route.poolAddress, lastError: result.route.lastError,
        action: result.state === 'PUMPSWAP' ? 'resume normal live position management under explicit execution authorization'
          : result.state === 'RETRY_EXHAUSTED' ? 'inspect incident and submit a new explicit bounded recheck if appropriate'
            : 'wait for next bounded verification; no trade was submitted' })}\n`);
    } finally { await lease.release(); }
  } finally { await pool.end(); }
}

function formatStatus(position: { positionId: string; wallet: string; mint: string; status: string; remainingRaw: bigint | null }, route: LivePositionMarketRoute | null): Readonly<Record<string, unknown>> {
  return Object.freeze({ positionId: position.positionId, wallet: position.wallet, mint: position.mint,
    positionStatus: position.status, remainingRaw: position.remainingRaw?.toString() ?? null,
    route: route === null ? null : { state: route.state, poolAddress: route.poolAddress,
      attempts: route.attempts, retryGeneration: route.retryGeneration ?? 0,
      retryBudget: route.retryBudget ?? 5, lastError: route.lastError, retryHistory: route.retryHistory ?? [] },
    signingOrSending: false });
}
function required(value: string | undefined): string {
  if (value === undefined || value.length === 0) throw new Error('Operator RPC URL is missing.');
  return value;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runLivePositionOperatorCli().catch((error: unknown) => {
    process.stderr.write(`Live position operator refused: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 2;
  });
}
