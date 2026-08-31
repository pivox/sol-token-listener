import {
  AccountLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import type {
  CanonicalMarketPool,
  MarketReserves,
} from '../../domain/market.js';
import type {
  MarketRpcReader,
  ReadonlyAccountSnapshot,
} from '../../ports/market-rpc-reader.js';
import { decodePumpSwapPoolAccount } from './pool-account-decoder.js';
import {
  computeEffectiveQuoteReservesRaw,
  InvalidEffectiveQuoteReservesError,
} from './reserve-math.js';

export class InvalidPumpSwapReserveError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidPumpSwapReserveError';
  }
}

export class InvalidEffectiveQuoteReserveError
extends InvalidPumpSwapReserveError {
  public constructor(public readonly amountRaw: bigint) {
    super(`Réserve quote effective invalide: ${amountRaw.toString()}.`);
    this.name = 'InvalidEffectiveQuoteReserveError';
  }
}

export class PumpSwapReserveReader {
  public constructor(
    private readonly rpc: MarketRpcReader,
    private readonly now: () => number = Date.now,
  ) {}

  public async read(pool: CanonicalMarketPool): Promise<MarketReserves> {
    const accounts = await this.rpc.readAccountsAtSameSlot([
      pool.address,
      pool.baseVault,
      pool.quoteVault,
    ]);
    const poolAccount = required(accounts[0], pool.address);
    const baseVault = required(accounts[1], pool.baseVault);
    const quoteVault = required(accounts[2], pool.quoteVault);
    if (
      poolAccount.slot !== baseVault.slot
      || poolAccount.slot !== quoteVault.slot
    ) {
      throw new InvalidPumpSwapReserveError(
        'Les réserves PumpSwap ne partagent pas le même slot RPC.',
      );
    }
    const decodedPool = decodePumpSwapPoolAccount(poolAccount);
    if (
      decodedPool.baseVault !== pool.baseVault
      || decodedPool.quoteVault !== pool.quoteVault
      || decodedPool.baseMint !== pool.baseMint
      || decodedPool.quoteMint !== pool.quoteAsset.mint
    ) {
      throw new InvalidPumpSwapReserveError(
        'Le compte pool contredit le pool canonique.',
      );
    }
    const base = decodeVault(
      baseVault,
      pool.baseMint,
      tokenProgram(pool.baseTokenProgram),
    );
    const quote = decodeVault(
      quoteVault,
      pool.quoteAsset.mint,
      tokenProgram(pool.quoteAsset.tokenProgram),
    );
    let effectiveQuoteReservesRaw: bigint;
    try {
      effectiveQuoteReservesRaw = computeEffectiveQuoteReservesRaw(
        quote.amountRaw,
        decodedPool.virtualQuoteReservesRaw,
      );
    } catch (error) {
      if (error instanceof InvalidEffectiveQuoteReservesError) {
        throw new InvalidEffectiveQuoteReserveError(error.amountRaw);
      }
      throw error;
    }
    const observedAtMs = this.now();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw new InvalidPumpSwapReserveError('Horodatage d’observation invalide.');
    }
    return Object.freeze({
      pool: pool.address,
      baseReservesRaw: base.amountRaw,
      quoteVaultAmountRaw: quote.amountRaw,
      virtualQuoteReservesRaw: decodedPool.virtualQuoteReservesRaw,
      effectiveQuoteReservesRaw,
      observedSlot: poolAccount.slot,
      observedAtMs,
    });
  }
}

function required(
  account: ReadonlyAccountSnapshot | null | undefined,
  address: string,
): ReadonlyAccountSnapshot {
  if (account?.address !== address) {
    throw new InvalidPumpSwapReserveError(`Compte requis absent: ${address}.`);
  }
  return account;
}

function decodeVault(
  account: ReadonlyAccountSnapshot,
  expectedMint: string,
  expectedProgram: PublicKey,
): { readonly amountRaw: bigint } {
  if (account.owner !== expectedProgram.toBase58()) {
    throw new InvalidPumpSwapReserveError(
      `Programme token du vault ${account.address} incohérent.`,
    );
  }
  if (account.data.length < AccountLayout.span) {
    throw new InvalidPumpSwapReserveError(`Vault ${account.address} tronqué.`);
  }
  const decoded = AccountLayout.decode(account.data);
  const mint = new PublicKey(decoded.mint).toBase58();
  if (mint !== expectedMint) {
    throw new InvalidPumpSwapReserveError(
      `Mint du vault ${account.address} incohérent.`,
    );
  }
  return Object.freeze({ amountRaw: decoded.amount });
}

function tokenProgram(kind: CanonicalMarketPool['baseTokenProgram']): PublicKey {
  return kind === 'TOKEN_2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}
