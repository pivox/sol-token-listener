import type {
  BuiltTransaction,
  PoolInfo,
  PoolRuntimeState,
  QuoteResult,
} from '../domain/types.js';

export interface TradeVenue {
  quoteBuy(pool: PoolInfo, amountInLamports: bigint): Promise<QuoteResult>;
  quoteSell(pool: PoolInfo, amountInTokenRaw: bigint): Promise<QuoteResult>;
  buildBuy(pool: PoolInfo, quote: QuoteResult, wallet: string): Promise<BuiltTransaction>;
  buildSell(pool: PoolInfo, quote: QuoteResult, wallet: string): Promise<BuiltTransaction>;
  readTokenBalance(tokenMint: string, tokenProgram: string, wallet: string): Promise<bigint>;
  readPoolRuntimeState(pool: PoolInfo): Promise<PoolRuntimeState>;
}
