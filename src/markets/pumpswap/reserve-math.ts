export class InvalidEffectiveQuoteReservesError extends Error {
  public constructor(public readonly amountRaw: bigint) {
    super(`Réserve quote effective invalide: ${amountRaw.toString()}.`);
    this.name = 'InvalidEffectiveQuoteReservesError';
  }
}

export function computeEffectiveQuoteReservesRaw(
  quoteVaultAmountRaw: bigint,
  virtualQuoteReservesRaw: bigint,
): bigint {
  if (quoteVaultAmountRaw < 0n) {
    throw new InvalidEffectiveQuoteReservesError(quoteVaultAmountRaw);
  }
  const effectiveQuoteReservesRaw = quoteVaultAmountRaw + virtualQuoteReservesRaw;
  if (effectiveQuoteReservesRaw <= 0n) {
    throw new InvalidEffectiveQuoteReservesError(effectiveQuoteReservesRaw);
  }
  return effectiveQuoteReservesRaw;
}
