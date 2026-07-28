import { PublicKey } from '@solana/web3.js';
import { poolPda } from '@pump-fun/pump-swap-sdk';
import { MarketError } from '../../domain/market-errors.js';
import type { CanonicalMarketPool } from '../../domain/market.js';
import type {
  ChainConfirmationStatus,
  ChainCursor,
  QuoteAsset,
  TokenProgramKind,
} from '../../domain/types.js';
import type { ReadonlyAccountSnapshot } from '../../ports/market-rpc-reader.js';
import type { DecodedPumpSwapPoolAccount } from './types.js';

export interface PumpSwapPoolValidationInput {
  readonly account: ReadonlyAccountSnapshot;
  readonly decoded: DecodedPumpSwapPoolAccount;
  readonly quoteAsset: QuoteAsset;
  readonly baseTokenProgram: TokenProgramKind;
  readonly activatedAt: ChainCursor;
  readonly confirmationStatus: ChainConfirmationStatus;
}

export function validateCanonicalPumpSwapPool(
  input: PumpSwapPoolValidationInput,
): CanonicalMarketPool {
  const { decoded } = input;
  if (decoded.index !== 0) {
    throw new MarketError(
      'MARKET_POOL_NON_CANONICAL',
      `Pool PumpSwap non canonique: index ${decoded.index}.`,
    );
  }
  if (decoded.quoteMint !== input.quoteAsset.mint) mismatch('quote mint');
  const expected = poolPda(
    0,
    new PublicKey(decoded.creator),
    new PublicKey(decoded.baseMint),
    new PublicKey(decoded.quoteMint),
  ).toBase58();
  if (expected !== input.account.address) {
    throw new MarketError(
      'MARKET_POOL_NON_CANONICAL',
      'Adresse PDA du pool PumpSwap non canonique.',
    );
  }
  return Object.freeze({
    address: input.account.address,
    market: 'pumpswap',
    programId: input.account.owner,
    baseMint: decoded.baseMint,
    quoteAsset: Object.freeze({ ...input.quoteAsset }),
    index: decoded.index,
    creator: decoded.creator,
    baseVault: decoded.baseVault,
    quoteVault: decoded.quoteVault,
    lpMint: decoded.lpMint,
    baseTokenProgram: input.baseTokenProgram,
    activatedAt: Object.freeze({ ...input.activatedAt }),
    confirmationStatus: input.confirmationStatus,
  });
}

function mismatch(field: string): never {
  throw new MarketError(
    'MARKET_POOL_MISMATCH',
    `Preuve de pool PumpSwap contradictoire: ${field}.`,
  );
}
