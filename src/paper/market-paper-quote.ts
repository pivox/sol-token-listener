import type { MarketQuote } from '../domain/market.js';
import type { PaperExecutionQuote } from '../domain/paper-trading.js';

export function toPaperExecutionQuote(
  quote: MarketQuote,
): PaperExecutionQuote {
  return Object.freeze({
    id: quote.id,
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    amountInRaw: quote.amountInRaw,
    amountOutRaw: quote.amountOutRaw,
    minimumAmountOutRaw: quote.minimumAmountOutRaw,
    feesRaw: quote.feesRaw,
    slippageBps: quote.slippageBps,
    priceImpactBps: quote.priceImpactBps,
    observedAtMs: quote.observedAtMs,
    observedSlot: quote.observedSlot,
  });
}
