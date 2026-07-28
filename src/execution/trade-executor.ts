import type { AppConfig } from '../config/env.js';
import type {
  EntryExecution,
  ExitExecution,
  QuoteResult,
  TokenSession,
  TradeRecord,
  TransactionSimulation,
} from '../domain/types.js';
import type { TradeVenue } from '../dex/trade-venue.js';
import type { TradeRepository } from '../storage/repositories.js';
import type { TransactionSimulator } from './transaction-simulator.js';
import type { TransactionQueue } from './transaction-queue.js';
import type { WalletSigner } from './wallet.js';

export class TradeExecutor {
  constructor(
    private readonly venue: TradeVenue,
    private readonly wallet: WalletSigner,
    private readonly config: Pick<AppConfig, 'executionMode' | 'buyAmountLamports'>,
    private readonly simulator: TransactionSimulator,
    _transactionConfirmer: unknown,
    _transactionFetcher: unknown,
    private readonly queue: TransactionQueue,
    private readonly trades: TradeRepository,
  ) {}

  buy(session: TokenSession): Promise<EntryExecution> {
    return this.queue.enqueue(`${session.id}:BUY`, async () => {
      this.requirePaperMode();
      const quote = await this.venue.quoteBuy(session.pool, this.config.buyAmountLamports);
      const built = await this.venue.buildBuy(session.pool, quote, this.wallet.address);
      const simulation = normalizeSimulation(await this.simulator.simulate(built, false));
      if (!simulation.ok) {
        await this.persistFailure(session, 'BUY', quote, simulation.error ?? 'Simulation échouée.');
        throw new Error(`Simulation d’achat échouée: ${simulation.error ?? 'erreur inconnue'}`);
      }
      const execution: EntryExecution = {
        mode: 'paper',
        amountInLamports: quote.amountInRaw,
        amountOutTokenRaw: quote.amountOutRaw - quote.transferFeeRaw,
        quotedOutTokenRaw: quote.amountOutRaw,
        cursor: {
          slot: quote.observedSlot,
          transactionIndex: -1,
          instructionIndex: -1,
          innerInstructionIndex: null,
        },
        confirmedAtMs: Date.now(),
        computeUnits: simulation.unitsConsumed ?? undefined,
        simulation,
      };
      await this.persistEntry(session, execution, quote);
      return execution;
    });
  }

  sell(session: TokenSession): Promise<ExitExecution> {
    return this.queue.enqueue(`${session.id}:SELL`, async () => {
      this.requirePaperMode();
      const amountInTokenRaw = session.entry?.amountOutTokenRaw ?? 0n;
      if (amountInTokenRaw <= 0n) throw new Error('Quantité token nulle: vente impossible.');

      const quote = await this.venue.quoteSell(session.pool, amountInTokenRaw);
      const built = await this.venue.buildSell(session.pool, quote, this.wallet.address);
      const simulation = normalizeSimulation(await this.simulator.simulate(built, false));
      if (!simulation.ok) {
        await this.persistFailure(session, 'SELL', quote, simulation.error ?? 'Simulation échouée.');
        throw new Error(`Simulation de vente échouée: ${simulation.error ?? 'erreur inconnue'}`);
      }
      const execution: ExitExecution = {
        mode: 'paper',
        amountInTokenRaw,
        amountOutLamports: quote.amountOutRaw - quote.transferFeeRaw,
        quotedOutLamports: quote.amountOutRaw,
        confirmedAtMs: Date.now(),
        computeUnits: simulation.unitsConsumed ?? undefined,
        simulation,
      };
      await this.persistExit(session, execution, quote);
      return execution;
    });
  }

  private requirePaperMode(): void {
    if (this.config.executionMode !== 'paper') {
      throw new Error('Paper execution is disabled while EXECUTION_MODE=observe.');
    }
  }

  private async persistEntry(session: TokenSession, execution: EntryExecution, quote: QuoteResult): Promise<void> {
    await this.trades.save(makeTrade(
      session,
      'BUY',
      'SIMULATED',
      execution.amountInLamports,
      execution.amountOutTokenRaw,
      execution.quotedOutTokenRaw,
      { quote, simulation: execution.simulation },
    ));
  }

  private async persistExit(session: TokenSession, execution: ExitExecution, quote: QuoteResult): Promise<void> {
    await this.trades.save(makeTrade(
      session,
      'SELL',
      'SIMULATED',
      execution.amountInTokenRaw,
      execution.amountOutLamports,
      execution.quotedOutLamports,
      { quote, simulation: execution.simulation },
    ));
  }

  private async persistFailure(
    session: TokenSession,
    side: 'BUY' | 'SELL',
    quote: QuoteResult,
    error: string,
  ): Promise<void> {
    await this.trades.save(makeTrade(
      session,
      side,
      'FAILED',
      quote.amountInRaw,
      0n,
      quote.amountOutRaw,
      { quote },
      error,
    ));
  }
}

function makeTrade(
  session: TokenSession,
  side: 'BUY' | 'SELL',
  status: TradeRecord['status'],
  amountInRaw: bigint,
  amountOutRaw: bigint,
  quotedOutRaw: bigint,
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
    mode: 'paper',
    status,
    amountInRaw,
    amountOutRaw,
    quotedOutRaw,
    error,
    payload,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function normalizeSimulation(value: Partial<TransactionSimulation> & { ok: boolean }): TransactionSimulation {
  return {
    ok: value.ok,
    error: value.error ?? null,
    logs: value.logs ?? [],
    unitsConsumed: value.unitsConsumed ?? null,
    replacementBlockhash: value.replacementBlockhash ?? null,
  };
}
