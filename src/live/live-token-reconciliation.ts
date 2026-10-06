/** Exact token balance reconciliation from a confirmed transaction's metadata. */
export type LiveTokenBalanceReconciliation =
  | Readonly<{
    status: 'KNOWN';
    mint: string;
    owner: string;
    preAmountRaw: bigint;
    postAmountRaw: bigint;
    deltaRaw: bigint;
  }>
  | Readonly<{ status: 'UNKNOWN'; reason: 'TRANSACTION_MISSING' | 'EXECUTION_FAILED' | 'METADATA_MISSING' | 'TOKEN_BALANCES_MISSING' | 'OWNER_OR_MINT_MISSING' }>;

interface TokenBalanceEntry {
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount?: Readonly<{ amount?: string }>;
}

interface ReconciliationTransaction {
  readonly meta: Readonly<{
    err: unknown;
    preTokenBalances?: readonly unknown[];
    postTokenBalances?: readonly unknown[];
  }> | null;
}

/**
 * Aggregates all token accounts owned by the wallet for one mint. Balance
 * entries are exact integer strings; UI amounts and decimals are never used.
 * A missing side is treated as zero only when both metadata arrays exist,
 * because then account creation/closure is represented by the other side.
 */
export function reconcileLiveTokenBalance(input: {
  readonly transaction: ReconciliationTransaction | null;
  readonly owner: string;
  readonly mint: string;
}): LiveTokenBalanceReconciliation {
  if (input.transaction === null) return Object.freeze({ status: 'UNKNOWN', reason: 'TRANSACTION_MISSING' });
  if (input.transaction.meta === null) return Object.freeze({ status: 'UNKNOWN', reason: 'METADATA_MISSING' });
  if (input.transaction.meta.err !== null) return Object.freeze({ status: 'UNKNOWN', reason: 'EXECUTION_FAILED' });
  const { preTokenBalances, postTokenBalances } = input.transaction.meta;
  if (preTokenBalances === undefined || postTokenBalances === undefined) {
    return Object.freeze({ status: 'UNKNOWN', reason: 'TOKEN_BALANCES_MISSING' });
  }
  if (input.owner.length === 0 || input.mint.length === 0) {
    return Object.freeze({ status: 'UNKNOWN', reason: 'OWNER_OR_MINT_MISSING' });
  }
  const pre = sumBalances(preTokenBalances, input.owner, input.mint);
  const post = sumBalances(postTokenBalances, input.owner, input.mint);
  if (pre === null || post === null) return Object.freeze({ status: 'UNKNOWN', reason: 'TOKEN_BALANCES_MISSING' });
  return Object.freeze({
    status: 'KNOWN', mint: input.mint, owner: input.owner,
    preAmountRaw: pre, postAmountRaw: post, deltaRaw: post - pre,
  });
}

function sumBalances(entries: readonly unknown[], owner: string, mint: string): bigint | null {
  let total = 0n;
  for (const candidate of entries) {
    if (typeof candidate !== 'object' || candidate === null) return null;
    const entry = candidate as TokenBalanceEntry;
    if (typeof entry.mint !== 'string' || typeof entry.owner !== 'string'
      || typeof entry.uiTokenAmount?.amount !== 'string'
      || !/^(0|[1-9]\d*)$/u.test(entry.uiTokenAmount.amount)) return null;
    if (entry.owner === owner && entry.mint === mint) total += BigInt(entry.uiTokenAmount.amount);
  }
  return total;
}
