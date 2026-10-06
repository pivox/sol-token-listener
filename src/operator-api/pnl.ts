export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface SpotReserves {
  readonly quoteReservesRaw: bigint;
  readonly baseReservesRaw: bigint;
}

/**
 * Indicative mid-price value of `remainingBaseRaw` tokens: no slippage, no fees. The value is
 * computed as one multiplication then one division because the per-raw-unit price is far below
 * one lamport and would round down to zero. Returns null without usable reserves.
 */
export function spotValueLamports(
  remainingBaseRaw: bigint,
  reserves: SpotReserves | null,
): bigint | null {
  if (reserves === null || reserves.baseReservesRaw <= 0n || reserves.quoteReservesRaw < 0n) {
    return null;
  }
  return (remainingBaseRaw * reserves.quoteReservesRaw) / reserves.baseReservesRaw;
}

export function unrealizedLamports(
  spotValue: bigint | null,
  costLamports: bigint,
): bigint | null {
  return spotValue === null ? null : spotValue - costLamports;
}
