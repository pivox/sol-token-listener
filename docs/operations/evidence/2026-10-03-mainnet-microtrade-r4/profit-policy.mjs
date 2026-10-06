function decimalFraction(value) {
  const match = String(value).match(/^(\d+)(?:\.(\d{1,9}))?$/);
  if (!match) throw new Error(`Invalid positive decimal: ${value}`);
  const decimals = match[2] ?? '';
  return { numerator: BigInt(match[1] + decimals), denominator: 10n ** BigInt(decimals.length) };
}

export function lamportsForUsdt(usdt, solUsdt) {
  const usd = decimalFraction(usdt);
  const price = decimalFraction(solUsdt);
  if (usd.numerator <= 0n || price.numerator <= 0n) throw new Error('Target and price must be positive');
  const numerator = usd.numerator * price.denominator * 1_000_000_000n;
  const denominator = usd.denominator * price.numerator;
  return (numerator + denominator - 1n) / denominator;
}

export function requiredSellQuoteLamports(buyCostLamports, sellNetworkFeeReserveLamports, targetProfitLamports) {
  const amounts = [buyCostLamports, sellNetworkFeeReserveLamports, targetProfitLamports].map(BigInt);
  if (amounts.some(x => x < 0n)) throw new Error('Amounts must be nonnegative');
  return amounts.reduce((a, b) => a + b, 0n);
}

export function expectedNetProfitLamports(sellQuoteLamports, buyCostLamports, sellNetworkFeeReserveLamports) {
  return BigInt(sellQuoteLamports) - BigInt(buyCostLamports) - BigInt(sellNetworkFeeReserveLamports);
}

export function meetsProfitTarget(sellQuoteLamports, buyCostLamports, sellNetworkFeeReserveLamports, targetProfitLamports) {
  return BigInt(sellQuoteLamports) >= requiredSellQuoteLamports(buyCostLamports, sellNetworkFeeReserveLamports, targetProfitLamports);
}
