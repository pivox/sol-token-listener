import { createHash } from 'node:crypto';
import { calculateRoundTrip } from '../paper/paper-math.js';
import type { PaperExecutionQuote } from './paper-trading.js';
import { PaperTradingError } from './paper-trading.js';

export const FAST_ENTRY_STRATEGY_ID = 'fast-entry-v1';
export const FAST_ENTRY_SLIPPAGE_BPS = 1_000n;
export const FAST_ENTRY_INTENT_TTL_MS = 120_000;
export const FAST_ENTRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** A create first observed longer ago than this is never decided (retries, replays, catch-up). */
export const FAST_ENTRY_MAX_CREATE_AGE_MS = 15_000;

const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

export type FastEntryRejection =
  | 'UNSUPPORTED_QUOTE_MINT'
  | 'UNSUPPORTED_TOKEN_EXTENSION'
  | 'CREATOR_ALREADY_SOLD'
  | 'NO_ENVELOPE_CAPACITY'
  | 'QUOTE_UNAVAILABLE'
  | 'ROUND_TRIP_LOSS_EXCEEDED';

export interface FastEntryLaunchFacts {
  readonly mint: string;
  readonly quoteMint: string;
  readonly creatorSoldInCreate: boolean;
}

export interface FastEntryEnvelope {
  readonly envelopeId: string;
  readonly perBuyQuoteAmountRaw: bigint;
}

export type FastEntryQuoteDecision =
  | { readonly decision: 'BUY'; readonly lossBps: bigint }
  | {
    readonly decision: 'REJECTED';
    readonly reason: 'ROUND_TRIP_LOSS_EXCEEDED' | 'QUOTE_UNAVAILABLE';
    readonly lossBps: bigint | null;
  };

/** Checks that need no RPC, in spec order; null means "go quote". */
export function precheckFastEntry(
  launch: FastEntryLaunchFacts,
  envelope: FastEntryEnvelope | null,
): FastEntryRejection | null {
  if (launch.quoteMint !== NATIVE_SOL_MINT) return 'UNSUPPORTED_QUOTE_MINT';
  if (launch.creatorSoldInCreate) return 'CREATOR_ALREADY_SOLD';
  if (envelope === null) return 'NO_ENVELOPE_CAPACITY';
  return null;
}

export function decideFastEntryQuotes(
  buy: PaperExecutionQuote,
  reverseSell: PaperExecutionQuote,
  maximumRoundTripLossBps: bigint,
): FastEntryQuoteDecision {
  let lossBps: bigint;
  try {
    lossBps = calculateRoundTrip(buy, reverseSell).lossBps;
  } catch (error) {
    if (error instanceof PaperTradingError) {
      return Object.freeze({ decision: 'REJECTED', reason: 'QUOTE_UNAVAILABLE', lossBps: null });
    }
    throw error;
  }
  if (lossBps > maximumRoundTripLossBps) {
    return Object.freeze({ decision: 'REJECTED', reason: 'ROUND_TRIP_LOSS_EXCEEDED', lossBps });
  }
  return Object.freeze({ decision: 'BUY', lossBps });
}

export function createEntryDecisionId(mint: string): string {
  if (typeof mint !== 'string' || mint === '') {
    throw new TypeError('mint must be a non-empty string.');
  }
  const digest = createHash('sha256')
    .update(lengthPrefixedUtf8(['entry-decision-v1', mint]))
    .digest('hex');
  return `entry_decision_${digest}`;
}

function lengthPrefixedUtf8(values: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}
