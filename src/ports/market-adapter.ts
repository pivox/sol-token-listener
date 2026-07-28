import type {
  MarketPool,
  MarketQuote,
  MarketReserves,
  MarketTrade,
  ObservedChainTransaction,
} from '../domain/types.js';

export interface MarketAdapter {
  readonly source: string;
  readonly programId: string;

  detectPools(transaction: ObservedChainTransaction): Promise<readonly MarketPool[]>;
  decodeTrades(
    transaction: ObservedChainTransaction,
    trackedPools: ReadonlyMap<string, MarketPool>,
  ): Promise<readonly MarketTrade[]>;
  readReserves(pool: MarketPool): Promise<MarketReserves>;
  quote(pool: MarketPool, inputMint: string, amountInRaw: bigint): Promise<MarketQuote>;
}
