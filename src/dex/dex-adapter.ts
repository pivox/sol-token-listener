import type { PoolInfo, SwapEvent } from '../domain/types.js';
import type { NormalizedTransaction } from '../solana/rpc/types.js';
import type { TradeVenue } from './trade-venue.js';

export interface DexAdapter extends TradeVenue {
  readonly dex: 'RAYDIUM_CPMM';
  readonly programId: string;
  discoverPools(transaction: NormalizedTransaction): Promise<readonly PoolInfo[]>;
  decodeSwaps(transaction: NormalizedTransaction, activePools: readonly PoolInfo[]): Promise<readonly SwapEvent[]>;
}
