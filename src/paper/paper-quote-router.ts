import { createHash } from 'node:crypto';
import type { CanonicalMarketPool, MarketQuoteRequest } from '../domain/market.js';
import type { PaperExecutionQuote } from '../domain/paper-trading.js';
import type { PumpSwapMarketAdapter } from '../markets/pumpswap/pumpswap-market.adapter.js';
import {
  PaperQuoteError,
  type PaperQuoteRequest,
  type PaperQuoteRouter,
} from '../ports/paper-quote-router.js';
import { toPaperExecutionQuote } from './market-paper-quote.js';
import {
  buildRuntimeDecisionObservationRow,
  buildRuntimeQuoteObservationRow,
  type QuoteObservationRecorder,
} from '../telemetry/quote-recorder.js';

export interface CanonicalPaperVenueState {
  readonly mint: string;
  readonly bondingCurve: {
    readonly active: boolean;
    readonly complete: boolean;
  } | null;
  readonly migrationObserved: boolean;
  readonly pumpSwap: {
    readonly active: boolean;
    readonly pool: CanonicalMarketPool;
  } | null;
  readonly headSlot: bigint;
  readonly resolutionSource?: 'LOCAL_INDEX' | 'RPC_CANONICAL_PDA';
  readonly resolutionSlot?: bigint | null;
  readonly resolutionAtMs?: number | null;
  readonly pumpSwapCashback?: boolean | null;
  readonly resolutionError?: string | null;
}

export interface CanonicalPaperVenueReader {
  readonly resolutionSource?: 'LOCAL_INDEX' | 'RPC_CANONICAL_PDA';
  read(mint: string): Promise<CanonicalPaperVenueState>;
}

export interface CanonicalPaperQuoteRouterOptions {
  readonly maxAgeMs: number;
  readonly maxSlotLag: bigint;
  readonly clock?: () => number;
  readonly quoteRecorder?: QuoteObservationRecorder;
}

export class CanonicalPaperQuoteRouter implements PaperQuoteRouter {
  private readonly clock: () => number;
  private readonly pendingDecisionRows = new Map<string, Readonly<{
    context: NonNullable<PaperQuoteRequest['observationContext']>;
    quoteId: string;
    availableAtMs: number;
    quote: PaperExecutionQuote;
  }>>();

  public constructor(
    private readonly venues: CanonicalPaperVenueReader,
    private readonly pumpFun: PaperQuoteRouter,
    private readonly pumpSwap: Pick<PumpSwapMarketAdapter, 'quote'>,
    private readonly options: CanonicalPaperQuoteRouterOptions,
  ) {
    if (
      !Number.isSafeInteger(options.maxAgeMs)
      || options.maxAgeMs < 0
      || options.maxSlotLag < 0n
    ) {
      throw new PaperQuoteError(
        'QUOTE_STATE_INCONSISTENT',
        'Les bornes de fraîcheur des cotations sont invalides.',
      );
    }
    this.clock = options.clock ?? Date.now;
  }

  public async quote(request: PaperQuoteRequest): Promise<PaperExecutionQuote> {
    const state = await this.readVenue(request.mint);
    validateVenue(state, request);
    let quote: PaperExecutionQuote;
    if (state.bondingCurve?.active === true) {
      quote = await this.pumpFun.quote(request);
    } else if (state.bondingCurve?.complete === true && state.pumpSwap?.active === true) {
      quote = await this.quotePumpSwap(request, state.pumpSwap.pool);
    } else if (state.migrationObserved) {
      throw new PaperQuoteError(
        'VENUE_MIGRATION_PENDING',
        'La migration Pump.fun est observée mais le pool PumpSwap canonique n’est pas encore actif.',
      );
    } else {
      throw new PaperQuoteError(
        'QUOTE_STATE_UNAVAILABLE',
        'Aucune venue canonique active ne permet une cotation paper.',
      );
    }
    const availableAtMs = this.clock();
    validateQuote(quote, request, state.headSlot, availableAtMs, this.options);
    if (request.side === 'SELL' && request.observationContext !== undefined && this.options.quoteRecorder !== undefined) {
      try {
        const context = request.observationContext;
        const quoteCalculatedAtMs = quote.quoteCalculatedAtMs ?? quote.observedAtMs;
        const row = buildRuntimeQuoteObservationRow({
          id: `quote_observation_${createHash('sha256').update(JSON.stringify([
            context.sessionId, context.positionId, quote.id, context.signalAtMs,
          ])).digest('hex')}`,
          mint: request.mint,
          quoteMint: request.quoteAsset.mint,
          context,
          amountInRaw: quote.amountInRaw.toString(),
          amountOutRaw: quote.amountOutRaw.toString(),
          minimumAmountOutRaw: quote.minimumAmountOutRaw.toString(),
          feesRaw: quote.feesRaw.toString(),
          slippageBps: quote.slippageBps.toString(),
          priceImpactBps: quote.priceImpactBps.toString(),
          stateReceivedAtMs: quote.stateReceivedAtMs ?? null,
          stateSlot: quote.observedSlot.toString(),
          quoteCalculatedAtMs,
          availableAtMs,
          maxAgeMs: this.options.maxAgeMs,
        });
        this.options.quoteRecorder.record(row);
        this.pendingDecisionRows.set(decisionKey(context.positionId, quote.id), {
          context,
          quoteId: quote.id,
          availableAtMs,
          quote,
        });
      } catch {
        // Measurement must never change the quote returned to the strategy.
      }
    }
    return quote;
  }

  public recordDecision(input: {
    readonly sessionId: string;
    readonly positionId: string;
    readonly buyTradeId: string;
    readonly quoteId: string;
    readonly signalAtMs: number;
    readonly decisionAtMs: number;
  }): void {
    const recorder = this.options.quoteRecorder;
    if (!recorder?.health().enabled) return;
    const key = decisionKey(input.positionId, input.quoteId);
    const captured = this.pendingDecisionRows.get(key);
    if (captured === undefined) return;
    this.pendingDecisionRows.delete(key);
    if (captured.context.sessionId !== input.sessionId
      || captured.context.buyTradeId !== input.buyTradeId
      || captured.context.signalAtMs !== input.signalAtMs) return;
    const quote = captured.quote;
    const stateReceivedAtMs = quote.stateReceivedAtMs ?? null;
    const quoteCalculatedAtMs = quote.quoteCalculatedAtMs ?? quote.observedAtMs;
    const row = buildRuntimeDecisionObservationRow({
      id: `quote_decision_${createHash('sha256').update(JSON.stringify([
        input.sessionId, input.positionId, input.quoteId, input.decisionAtMs,
      ])).digest('hex')}`,
      sessionId: input.sessionId,
      positionId: input.positionId,
      buyTradeId: input.buyTradeId,
      quoteId: input.quoteId,
      signalAtMs: input.signalAtMs,
      availableAtMs: captured.availableAtMs,
      decisionAtMs: input.decisionAtMs,
      stateReceivedAtMs,
      stateSlot: quote.observedSlot.toString(),
      quoteCalculatedAtMs,
      maxAgeMs: this.options.maxAgeMs,
      validity: 'VALID',
    });
    recorder.record(row);
  }

  private async readVenue(mint: string): Promise<CanonicalPaperVenueState> {
    try {
      return await this.venues.read(mint);
    } catch (error) {
      if (error instanceof PaperQuoteError) throw error;
      throw new PaperQuoteError(
        'QUOTE_STATE_UNAVAILABLE',
        'La projection de venue canonique est temporairement indisponible.',
      );
    }
  }

  private async quotePumpSwap(
    request: PaperQuoteRequest,
    pool: CanonicalMarketPool,
  ): Promise<PaperExecutionQuote> {
    const marketRequest: MarketQuoteRequest = {
      pool,
      inputMint: request.side === 'BUY' ? request.quoteAsset.mint : request.mint,
      amountInRaw: request.amountInRaw,
      slippageBps: request.slippageBps,
    };
    try {
      return toPaperExecutionQuote(await this.pumpSwap.quote(marketRequest));
    } catch (error) {
      if (error instanceof PaperQuoteError) throw error;
      throw new PaperQuoteError(
        'QUOTE_STATE_UNAVAILABLE',
        'La cotation PumpSwap canonique est temporairement indisponible.',
      );
    }
  }
}

function decisionKey(positionId: string, quoteId: string): string {
  return `${positionId}\0${quoteId}`;
}

function validateVenue(state: CanonicalPaperVenueState, request: PaperQuoteRequest): void {
  if (state.mint !== request.mint || state.headSlot < 0n) inconsistent();
  const curveActive = state.bondingCurve?.active === true;
  const curveComplete = state.bondingCurve?.complete === true;
  const poolActive = state.pumpSwap?.active === true;
  if (
    (curveActive && curveComplete)
    || (curveActive && poolActive)
    || (poolActive && !curveComplete)
    || (state.pumpSwap !== null && state.pumpSwap.pool.baseMint !== request.mint)
    || (
      state.pumpSwap !== null
      && !sameQuoteAsset(state.pumpSwap.pool.quoteAsset, request.quoteAsset)
    )
  ) inconsistent();
}

function validateQuote(
  quote: PaperExecutionQuote,
  request: PaperQuoteRequest,
  headSlot: bigint,
  nowMs: number,
  options: CanonicalPaperQuoteRouterOptions,
): void {
  const expectedInput = request.side === 'BUY' ? request.quoteAsset.mint : request.mint;
  const expectedOutput = request.side === 'BUY' ? request.mint : request.quoteAsset.mint;
  if (
    quote.id.length === 0
    || quote.inputMint !== expectedInput
    || quote.outputMint !== expectedOutput
    || quote.amountInRaw !== request.amountInRaw
    || quote.amountOutRaw <= 0n
    || quote.minimumAmountOutRaw < 0n
    || quote.minimumAmountOutRaw > quote.amountOutRaw
    || quote.feesRaw < 0n
    || quote.slippageBps !== request.slippageBps
    || quote.priceImpactBps < 0n
    || quote.priceImpactBps > 10_000n
    || !Number.isSafeInteger(quote.observedAtMs)
    || quote.observedAtMs < 0
    || quote.observedSlot < 0n
  ) inconsistent();
  if (
    !Number.isSafeInteger(nowMs)
    || nowMs < quote.observedAtMs
    || nowMs - quote.observedAtMs > options.maxAgeMs
    || quote.observedSlot > headSlot
    || headSlot - quote.observedSlot > options.maxSlotLag
  ) {
    throw new PaperQuoteError('QUOTE_STALE', 'La cotation paper est périmée.');
  }
}

function sameQuoteAsset(
  left: CanonicalMarketPool['quoteAsset'],
  right: PaperQuoteRequest['quoteAsset'],
): boolean {
  return left.mint === right.mint
    && left.decimals === right.decimals
    && left.tokenProgram === right.tokenProgram;
}

function inconsistent(): never {
  throw new PaperQuoteError(
    'QUOTE_STATE_INCONSISTENT',
    'La projection de venue ou la cotation paper est incohérente.',
  );
}
