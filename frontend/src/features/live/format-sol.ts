import { formatBasisPoints, formatRawAmount } from '../../data/decimal.js';

/** Lamports as SOL through bigint only; `signed` adds an explicit plus for profits. */
export function formatSol(lamports: string, signed = false): string {
  const amount = formatRawAmount(lamports, 9);
  const prefixed = signed && !amount.startsWith('-') && BigInt(lamports) !== 0n ? `+${amount}` : amount;
  return `${prefixed} SOL`;
}

/** Unrealized PnL over cost in basis points, truncated toward zero, e.g. `19.40%`. */
export function formatPnlPercent(unrealizedLamports: string, costLamports: string): string {
  const basisPoints = (BigInt(unrealizedLamports) * 10_000n) / BigInt(costLamports);
  const formatted = formatBasisPoints(basisPoints.toString());
  return basisPoints > 0n ? `+${formatted}` : formatted;
}
