export function isEligibleForCanary(row, activity) {
  if (!row.creationFinalized || row.quoteMint !== '11111111111111111111111111111111' || row.mayhem || row.complete || row.mintOwner !== 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') return false;
  if ((activity?.uniqueBuyers ?? 0) < 3) return false;
  try {
    const quote = BigInt(row.realQuoteLamports);
    const tokens = BigInt(row.realTokenRaw);
    return quote >= 2_000_000_000n && quote < 20_000_000_000n && tokens > 300_000_000_000_000n;
  } catch { return false; }
}
