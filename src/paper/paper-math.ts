import type {
  PaperExecutionQuote,
  PaperRoundTrip,
} from '../domain/paper-trading.js';
import { PaperTradingError } from '../domain/paper-trading.js';
import { assertValidTimestampMs } from '../domain/timestamp.js';

const MAX_BPS = 10_000n;

export function validatePaperQuote(quote: PaperExecutionQuote): void {
  if (quote.id.trim() === '') invalid('id');
  if (quote.inputMint.trim() === '') invalid('inputMint');
  if (quote.outputMint.trim() === '') invalid('outputMint');
  if (quote.inputMint === quote.outputMint) invalid('outputMint');
  if (quote.amountInRaw <= 0n) invalid('amountInRaw');
  if (quote.amountOutRaw <= 0n) invalid('amountOutRaw');
  if (quote.minimumAmountOutRaw <= 0n || quote.minimumAmountOutRaw > quote.amountOutRaw) {
    invalid('minimumAmountOutRaw');
  }
  if (quote.feesRaw < 0n) invalid('feesRaw');
  validateBps('slippageBps', quote.slippageBps);
  validateBps('priceImpactBps', quote.priceImpactBps);
  assertValidTimestampMs('observedAtMs', quote.observedAtMs);
  if (quote.observedSlot < 0n) invalid('observedSlot');
}

export function calculateRoundTrip(
  buy: PaperExecutionQuote,
  reverseSell: PaperExecutionQuote,
): PaperRoundTrip {
  validatePaperQuote(buy);
  validatePaperQuote(reverseSell);
  if (reverseSell.inputMint !== buy.outputMint) invalid('inputMint');
  if (reverseSell.outputMint !== buy.inputMint) invalid('outputMint');
  if (reverseSell.amountInRaw !== buy.minimumAmountOutRaw) invalid('amountInRaw');
  const lossRaw = buy.amountInRaw > reverseSell.minimumAmountOutRaw
    ? buy.amountInRaw - reverseSell.minimumAmountOutRaw
    : 0n;
  return Object.freeze({
    quoteCostRaw: buy.amountInRaw,
    baseFilledRaw: buy.minimumAmountOutRaw,
    returnRaw: reverseSell.minimumAmountOutRaw,
    lossRaw,
    lossBps: calculateLossBps(buy.amountInRaw, reverseSell.minimumAmountOutRaw),
  });
}

export function calculateLossBps(costRaw: bigint, returnRaw: bigint): bigint {
  if (costRaw <= 0n) invalid('quoteCostRaw');
  if (returnRaw < 0n) invalid('returnRaw');
  const lossRaw = costRaw > returnRaw ? costRaw - returnRaw : 0n;
  return lossRaw === 0n
    ? 0n
    : ((lossRaw * MAX_BPS) + costRaw - 1n) / costRaw;
}

function validateBps(field: string, value: bigint): void {
  if (value < 0n || value > MAX_BPS) invalid(field);
}

function invalid(field: string): never {
  throw new PaperTradingError('QUOTE_INVALID', `Champ de quote invalide: ${field}.`);
}
