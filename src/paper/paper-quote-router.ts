import type { CanonicalMarketPool, MarketQuoteRequest } from '../domain/market.js';
import type { PaperExecutionQuote } from '../domain/paper-trading.js';
import type { PumpSwapMarketAdapter } from '../markets/pumpswap/pumpswap-market.adapter.js';
import {
  PaperQuoteError,
  type PaperQuoteRequest,
  type PaperQuoteRouter,
} from '../ports/paper-quote-router.js';
import { toPaperExecutionQuote } from './market-paper-quote.js';

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
}

export interface CanonicalPaperVenueReader {
  read(mint: string): Promise<CanonicalPaperVenueState>;
}

export interface CanonicalPaperQuoteRouterOptions {
  readonly maxAgeMs: number;
  readonly maxSlotLag: bigint;
  readonly clock?: () => number;
}

export class CanonicalPaperQuoteRouter implements PaperQuoteRouter {
  private readonly clock: () => number;

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
    validateQuote(quote, request, state.headSlot, this.clock(), this.options);
    return quote;
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
