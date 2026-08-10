import type { PaperExecutionQuote } from '../domain/paper-trading.js';
import type { QuoteAsset } from '../domain/types.js';

export interface PaperQuoteRequest {
  readonly mint: string;
  readonly quoteAsset: QuoteAsset;
  readonly side: 'BUY' | 'SELL';
  readonly amountInRaw: bigint;
  readonly slippageBps: bigint;
}

export interface PaperQuoteRouter {
  quote(request: PaperQuoteRequest): Promise<PaperExecutionQuote>;
}

export type PaperQuoteFailureCode =
  | 'QUOTE_STATE_UNAVAILABLE'
  | 'QUOTE_STATE_INCONSISTENT'
  | 'QUOTE_STALE'
  | 'VENUE_MIGRATION_PENDING'
  | 'UNSUPPORTED_QUOTE_MINT';

export class PaperQuoteError extends Error {
  public constructor(
    public readonly code: PaperQuoteFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'PaperQuoteError';
  }
}
