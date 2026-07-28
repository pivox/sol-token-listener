import { VersionedTransaction } from '@solana/web3.js';
import type { AppConfig } from '../config/env.js';
import type {
  EntryExecution,
  ExitExecution,
  QuoteResult,
  TokenSession,
  TradeRecord,
} from '../domain/types.js';
import type { TradeVenue } from '../dex/trade-venue.js';
import type { TradeRepository } from '../storage/repositories.js';
import { TransactionFetcher } from '../solana/rpc/transaction-fetcher.js';
import type { NormalizedTransaction } from '../solana/rpc/types.js';
import { SolanaTransactionSimulator } from './transaction-simulator.js';
import { TransactionConfirmer } from './transaction-confirmer.js';
import { TransactionQueue } from './transaction-queue.js';
import type { WalletSigner } from './wallet.js';

export class TradeExecutor {
  constructor(
    private readonly venue: TradeVenue,
    private readonly wallet: WalletSigner,
    private readonly config: Pick<AppConfig, 'executionMode' | 'buyAmountLamports'>,
    private readonly simulator: SolanaTransactionSimulator,
    private readonly confirmer: TransactionConfirmer,
    private readonly fetcher: TransactionFetcher,
    private readonly queue: TransactionQueue,
    private readonly trades: TradeRepository,
  ) {}

  buy(session: TokenSession): Promise<EntryExecution> {
    return this.queue.enqueue(`${session.id}:BUY`, async () => {
      const quote = await this.venue.quoteBuy(session.pool, this.config.buyAmountLamports);
      const built = await this.venue.buildBuy(session.pool, quote, this.wallet.address);
      const simulation = await this.simulator.simulate(built, false);
      if (!simulation.ok) {
        await this.persistFailure(session, 'BUY', quote, simulation.error ?? 'Simulation échouée.');
        throw new Error(`Simulation d’achat échouée: ${simulation.error ?? 'erreur inconnue'}`);
      }
      if (this.config.executionMode === 'dry-run') {
        const execution: EntryExecution = {
          mode: 'dry-run',
          amountInLamports: quote.amountInRaw,
          amountOutTokenRaw: quote.amountOutRaw - quote.transferFeeRaw,
          quotedOutTokenRaw: quote.amountOutRaw,
          cursor: { slot: quote.observedSlot, transactionIndex: -1, instructionIndex: -1, innerInstructionIndex: null },
          confirmedAtMs: Date.now(),
          computeUnits: simulation.unitsConsumed ?? undefined,
          simulation,
        };
        await this.persistEntry(session, execution, quote, 'SIMULATED');
        return execution;
      }
      await this.wallet.sign(built.transaction);
      const signedSimulation = await this.simulator.simulate(built, true);
      if (!signedSimulation.ok) {
        await this.persistFailure(session, 'BUY', quote, signedSimulation.error ?? 'Simulation signée échouée.');
        throw new Error(`Simulation signée d’achat échouée: ${signedSimulation.error ?? 'erreur inconnue'}`);
      }
      const sent = await this.confirmer.signSendAndConfirm(built, this.wallet);
      const transaction = await this.requireConfirmedTransaction(sent.signature);
      const actual = tokenOwnerDelta(transaction, session.pool.tokenMint, this.wallet.address);
      const execution: EntryExecution = {
        mode: 'live',
        amountInLamports: quote.amountInRaw,
        amountOutTokenRaw: actual > 0n ? actual : quote.amountOutRaw - quote.transferFeeRaw,
        quotedOutTokenRaw: quote.amountOutRaw,
        signature: sent.signature,
        feeLamports: transaction.feeLamports,
        rentDeltaLamports: calculateEntryRentDelta(transaction, this.wallet.address, quote.amountInRaw),
        priorityFeeLamports: priorityFee(transaction),
        computeUnits: transaction.computeUnits ?? undefined,
        cursor: { slot: transaction.slot, transactionIndex: transaction.transactionIndex, instructionIndex: -1, innerInstructionIndex: null },
        confirmedAtMs: sent.confirmedAtMs,
        simulation: signedSimulation,
      };
      await this.persistEntry(session, execution, quote, 'CONFIRMED');
      return execution;
    });
  }

  sell(session: TokenSession): Promise<ExitExecution> {
    return this.queue.enqueue(`${session.id}:SELL`, async () => {
      const balance = await this.venue.readTokenBalance(session.pool.tokenMint, session.pool.tokenProgram, this.wallet.address);
      if (balance <= 0n) throw new Error('Solde token nul: vente impossible.');
      const quote = await this.venue.quoteSell(session.pool, balance);
      const built = await this.venue.buildSell(session.pool, quote, this.wallet.address);
      const simulation = await this.simulator.simulate(built, false);
      if (!simulation.ok) {
        await this.persistFailure(session, 'SELL', quote, simulation.error ?? 'Simulation échouée.');
        throw new Error(`Simulation de vente échouée: ${simulation.error ?? 'erreur inconnue'}`);
      }
      if (this.config.executionMode === 'dry-run') {
        const execution: ExitExecution = {
          mode: 'dry-run',
          amountInTokenRaw: balance,
          amountOutLamports: quote.amountOutRaw - quote.transferFeeRaw,
          quotedOutLamports: quote.amountOutRaw,
          confirmedAtMs: Date.now(),
          computeUnits: simulation.unitsConsumed ?? undefined,
          simulation,
        };
        await this.persistExit(session, execution, quote, 'SIMULATED');
        return execution;
      }
      await this.wallet.sign(built.transaction);
      const signedSimulation = await this.simulator.simulate(built, true);
      if (!signedSimulation.ok) {
        await this.persistFailure(session, 'SELL', quote, signedSimulation.error ?? 'Simulation signée échouée.');
        throw new Error(`Simulation signée de vente échouée: ${signedSimulation.error ?? 'erreur inconnue'}`);
      }
      const sent = await this.confirmer.signSendAndConfirm(built, this.wallet);
      const transaction = await this.requireConfirmedTransaction(sent.signature);
      const wsolDelta = tokenOwnerDelta(transaction, session.pool.wsolMint, this.wallet.address);
      const execution: ExitExecution = {
        mode: 'live',
        amountInTokenRaw: balance,
        amountOutLamports: wsolDelta > 0n ? wsolDelta : quote.amountOutRaw - quote.transferFeeRaw,
        quotedOutLamports: quote.amountOutRaw,
        signature: sent.signature,
        feeLamports: transaction.feeLamports,
        rentDeltaLamports: calculateExitRentDelta(transaction, this.wallet.address, quote.amountOutRaw),
        priorityFeeLamports: priorityFee(transaction),
        computeUnits: transaction.computeUnits ?? undefined,
        confirmedAtMs: sent.confirmedAtMs,
        simulation: signedSimulation,
      };
      await this.persistExit(session, execution, quote, 'CONFIRMED');
      return execution;
    });
  }

  private async requireConfirmedTransaction(signature: string): Promise<NormalizedTransaction> {
    const transaction = await this.fetcher.fetch(signature, 'CONFIRMED');
    if (!transaction || transaction.error !== null) throw new Error(`Transaction envoyée mais détails confirmés indisponibles: ${signature}.`);
    return transaction;
  }

  private async persistEntry(
    session: TokenSession,
    execution: EntryExecution,
    quote: QuoteResult,
    status: TradeRecord['status'],
  ): Promise<void> {
    await this.trades.save(makeTrade(session, 'BUY', status, execution.amountInLamports, execution.amountOutTokenRaw,
      execution.quotedOutTokenRaw, execution.signature, execution.cursor.slot, execution.feeLamports,
      execution.rentDeltaLamports, execution.priorityFeeLamports, execution.computeUnits, { quote, simulation: execution.simulation }));
  }

  private async persistExit(
    session: TokenSession,
    execution: ExitExecution,
    quote: QuoteResult,
    status: TradeRecord['status'],
  ): Promise<void> {
    await this.trades.save(makeTrade(session, 'SELL', status, execution.amountInTokenRaw, execution.amountOutLamports,
      execution.quotedOutLamports, execution.signature, undefined, execution.feeLamports,
      execution.rentDeltaLamports, execution.priorityFeeLamports, execution.computeUnits, { quote, simulation: execution.simulation }));
  }

  private async persistFailure(session: TokenSession, side: 'BUY' | 'SELL', quote: QuoteResult, error: string): Promise<void> {
    await this.trades.save(makeTrade(session, side, 'FAILED', quote.amountInRaw, 0n, quote.amountOutRaw,
      undefined, undefined, undefined, undefined, undefined, undefined, { quote }, error));
  }
}

function makeTrade(
  session: TokenSession,
  side: 'BUY' | 'SELL',
  status: TradeRecord['status'],
  amountInRaw: bigint,
  amountOutRaw: bigint,
  quotedOutRaw: bigint,
  signature: string | undefined,
  slot: bigint | undefined,
  feeLamports: bigint | undefined,
  rentDeltaLamports: bigint | undefined,
  priorityFeeLamports: bigint | undefined,
  computeUnits: bigint | undefined,
  payload: Record<string, unknown>,
  error?: string,
): TradeRecord {
  const now = Date.now();
  return {
    id: `${session.id}:${side}`,
    idempotencyKey: `${session.id}:${side}`,
    sessionId: session.id,
    pool: session.pool.pool,
    tokenMint: session.pool.tokenMint,
    side,
    mode: status === 'SIMULATED' ? 'dry-run' : 'live',
    status,
    amountInRaw,
    amountOutRaw,
    quotedOutRaw,
    signature,
    slot,
    feeLamports,
    rentDeltaLamports,
    priorityFeeLamports,
    computeUnits,
    error,
    payload,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function tokenOwnerDelta(transaction: NormalizedTransaction, mint: string, owner: string): bigint {
  const sum = (phase: 'pre' | 'post'): bigint => (phase === 'pre' ? transaction.preTokenBalances : transaction.postTokenBalances)
    .filter((balance) => balance.mint === mint && balance.owner === owner)
    .reduce((total, balance) => total + balance.amountRaw, 0n);
  return sum('post') - sum('pre');
}

function signerLamportDelta(transaction: NormalizedTransaction, wallet: string): bigint {
  const index = transaction.accountKeys.indexOf(wallet);
  if (index < 0) return 0n;
  return (transaction.postBalancesLamports[index] ?? 0n) - (transaction.preBalancesLamports[index] ?? 0n);
}

function calculateEntryRentDelta(transaction: NormalizedTransaction, wallet: string, amountIn: bigint): bigint {
  const spent = -signerLamportDelta(transaction, wallet);
  const rent = spent - amountIn - transaction.feeLamports;
  return rent > 0n ? rent : 0n;
}

function calculateExitRentDelta(transaction: NormalizedTransaction, wallet: string, expectedOut: bigint): bigint {
  const gained = signerLamportDelta(transaction, wallet) + transaction.feeLamports;
  const delta = gained - expectedOut;
  return delta;
}

function priorityFee(transaction: NormalizedTransaction): bigint {
  const signatures = transaction.signerKeys.length;
  const base = BigInt(signatures * 5000);
  return transaction.feeLamports > base ? transaction.feeLamports - base : 0n;
}
