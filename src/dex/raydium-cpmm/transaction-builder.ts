import type { Connection } from '@solana/web3.js';
import type { BuiltTransaction, PoolInfo, QuoteResult } from '../../domain/types.js';
import type { RaydiumCpmmQuoteService } from './quote-service.js';

export class RaydiumCpmmTransactionBuilder {
  constructor(
    private readonly connection: Connection,
    private readonly quoteService: RaydiumCpmmQuoteService,
    private readonly slippageBps: number,
    private readonly computeUnitLimit: number | null,
    private readonly maxPriorityFeeLamports: bigint | null,
  ) {}

  build(pool: PoolInfo, quote: QuoteResult, wallet: string): Promise<BuiltTransaction> {
    void this.connection;
    void this.quoteService;
    void this.slippageBps;
    void this.computeUnitLimit;
    void this.maxPriorityFeeLamports;
    void pool;
    void quote;
    void wallet;
    return Promise.reject(new Error(
      'Raydium CPMM transaction construction is isolated and cannot be used by Pump.fun V1.',
    ));
  }
}
