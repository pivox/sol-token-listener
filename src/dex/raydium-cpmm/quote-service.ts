import type { Connection } from '@solana/web3.js';
import type { PoolInfo, QuoteResult } from '../../domain/types.js';

export class RaydiumCpmmQuoteService {
  constructor(
    private readonly connection: Connection,
    private readonly slippageBps: number,
  ) {}

  quote(pool: PoolInfo, inputMint: string, amountInRaw: bigint): Promise<QuoteResult> {
    void this.connection;
    void this.slippageBps;
    void pool;
    void inputMint;
    void amountInRaw;
    return Promise.reject(new Error(
      'Raydium CPMM quoting is isolated in PR A and is not composed into the Pump.fun V1 flow.',
    ));
  }
}
