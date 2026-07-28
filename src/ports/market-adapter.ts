import type {
  CanonicalMarketPool,
  MarketQuote,
  MarketQuoteRequest,
  MarketReserves,
  MarketTrade,
} from '../domain/market.js';
import type {
  ObservedChainTransaction,
} from '../domain/types.js';

export interface MarketAdapter<
  in TTransaction extends ObservedChainTransaction =
    ObservedChainTransaction,
> {
  readonly source: string;
  readonly programId: string;

  readonly detectPools: (
    transaction: TTransaction,
  ) => Promise<readonly CanonicalMarketPool[]>;
  readonly decodeTrades: (
    transaction: TTransaction,
    trackedPools: ReadonlyMap<string, CanonicalMarketPool>,
  ) => Promise<readonly MarketTrade[]>;
  readonly readReserves: (
    pool: CanonicalMarketPool,
  ) => Promise<MarketReserves>;
  readonly quote: (request: MarketQuoteRequest) => Promise<MarketQuote>;
}
