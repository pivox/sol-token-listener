import type {
  CanonicalMarketPool,
  MarketQuote,
  MarketReserves,
} from '../domain/market.js';

export interface PumpSwapQuoteRequest {
  readonly pool: CanonicalMarketPool;
  readonly reserves: MarketReserves;
  readonly inputMint: string;
  readonly amountInRaw: bigint;
  readonly slippageBps: bigint;
}

export interface PumpSwapQuotePort {
  quote(request: PumpSwapQuoteRequest): Promise<MarketQuote>;
}
