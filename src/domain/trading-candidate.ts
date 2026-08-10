import { createHash } from 'node:crypto';
import { assertValidChainCursor } from './cursor.js';
import type { DomainEvent } from './events.js';
import type { PaperExecutionQuote, PaperStrategyIdentity } from './paper-trading.js';
import {
  PAPER_DECISION_REASON_CODES,
  type PaperDecisionReasonCode,
} from './paper-strategy.js';
import { assertValidTimestampMs } from './timestamp.js';
import type { ChainConfirmationStatus, ChainCursor, QuoteAsset } from './types.js';

export const TRADING_CANDIDATE_STATES = Object.freeze([
  'NOT_ELIGIBLE',
  'ELIGIBLE',
  'EXPIRED',
  'REVOKED',
] as const);

export type TradingCandidateState = (typeof TRADING_CANDIDATE_STATES)[number];

export interface QualificationProfileIdentity {
  readonly id: string;
  readonly version: number;
  readonly fingerprint: string;
}

export interface TradingCandidateAsOf {
  readonly eventId: string;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly observedAtMs: number;
}

export interface TradingCandidateV1 {
  readonly id: string;
  readonly mint: string;
  readonly strategy: PaperStrategyIdentity;
  readonly qualificationReportId: string;
  readonly qualificationProfile: QualificationProfileIdentity;
  readonly evidenceFingerprint: string;
  readonly asOf: TradingCandidateAsOf;
  readonly state: TradingCandidateState;
  readonly quoteAsset: QuoteAsset;
  readonly buyQuote: PaperExecutionQuote | null;
  readonly reverseSellQuote: PaperExecutionQuote | null;
  readonly eligibleUntilMs: number | null;
  readonly reasonCodes: readonly PaperDecisionReasonCode[];
  readonly createdAtMs: number;
  readonly purgeAfterMs: number;
  readonly payloadVersion: 1;
}

export interface CreateTradingCandidateInput {
  readonly mint: string;
  readonly strategy: PaperStrategyIdentity;
  readonly qualificationReportId: string;
  readonly qualificationProfile: QualificationProfileIdentity;
  readonly evidenceFingerprint: string;
  readonly asOfEvent: DomainEvent;
  readonly state: TradingCandidateState;
  readonly quoteAsset: QuoteAsset;
  readonly buyQuote: PaperExecutionQuote | null;
  readonly reverseSellQuote: PaperExecutionQuote | null;
  readonly eligibleUntilMs: number | null;
  readonly reasonCodes: readonly PaperDecisionReasonCode[];
  readonly createdAtMs: number;
  readonly purgeAfterMs: number;
}

export function createTradingCandidate(input: CreateTradingCandidateInput): TradingCandidateV1 {
  validateInput(input);
  const strategy = Object.freeze({ ...input.strategy });
  const qualificationProfile = Object.freeze({ ...input.qualificationProfile });
  const cursor = Object.freeze({ ...input.asOfEvent.cursor });
  const asOf = Object.freeze({
    eventId: input.asOfEvent.id,
    cursor,
    confirmationStatus: input.asOfEvent.confirmationStatus,
    observedAtMs: input.asOfEvent.observedAtMs,
  });
  const quoteAsset = Object.freeze({ ...input.quoteAsset });
  const buyQuote = input.buyQuote === null ? null : snapshotQuote(input.buyQuote);
  const reverseSellQuote = input.reverseSellQuote === null
    ? null
    : snapshotQuote(input.reverseSellQuote);
  const reasonCodes = Object.freeze([...input.reasonCodes]);
  const identity = JSON.stringify([
    input.mint,
    strategy.id,
    strategy.version.toString(),
    qualificationProfile.id,
    qualificationProfile.version.toString(),
    qualificationProfile.fingerprint,
    input.evidenceFingerprint,
    input.asOfEvent.id,
  ]);
  return Object.freeze({
    id: `candidate_${createHash('sha256').update(identity).digest('hex')}`,
    mint: input.mint,
    strategy,
    qualificationReportId: input.qualificationReportId,
    qualificationProfile,
    evidenceFingerprint: input.evidenceFingerprint,
    asOf,
    state: input.state,
    quoteAsset,
    buyQuote,
    reverseSellQuote,
    eligibleUntilMs: input.eligibleUntilMs,
    reasonCodes,
    createdAtMs: input.createdAtMs,
    purgeAfterMs: input.purgeAfterMs,
    payloadVersion: 1,
  });
}

function validateInput(input: CreateTradingCandidateInput): void {
  text(input.mint, 'mint');
  text(input.strategy.id, 'strategy id');
  positiveInteger(input.strategy.version, 'strategy version');
  text(input.qualificationReportId, 'qualification report id');
  text(input.qualificationProfile.id, 'qualification profile id');
  positiveInteger(input.qualificationProfile.version, 'qualification profile version');
  fingerprint(input.qualificationProfile.fingerprint, 'qualification profile fingerprint');
  fingerprint(input.evidenceFingerprint, 'evidence fingerprint');
  text(input.asOfEvent.id, 'asOf event id');
  if (input.asOfEvent.mint !== input.mint) throw new TypeError('Candidate asOf event mint is inconsistent.');
  assertValidChainCursor(input.asOfEvent.cursor);
  assertValidTimestampMs('observedAtMs', input.asOfEvent.observedAtMs);
  if (!TRADING_CANDIDATE_STATES.includes(input.state)) throw new TypeError('Candidate state is invalid.');
  validateQuoteAsset(input.quoteAsset);
  const uniqueReasons = new Set<PaperDecisionReasonCode>();
  for (const reason of input.reasonCodes) {
    if (!PAPER_DECISION_REASON_CODES.includes(reason) || uniqueReasons.has(reason)) {
      throw new TypeError('Candidate reason codes are invalid.');
    }
    uniqueReasons.add(reason);
  }
  assertValidTimestampMs('observedAtMs', input.createdAtMs);
  assertValidTimestampMs('observedAtMs', input.purgeAfterMs);
  if (input.purgeAfterMs <= input.createdAtMs) throw new TypeError('Candidate purge date is invalid.');
  if (input.eligibleUntilMs !== null) {
    assertValidTimestampMs('observedAtMs', input.eligibleUntilMs);
    if (input.eligibleUntilMs <= input.createdAtMs) throw new TypeError('Candidate eligible window is invalid.');
  }
  if (input.state === 'ELIGIBLE') {
    if (input.buyQuote === null || input.reverseSellQuote === null || input.eligibleUntilMs === null) {
      throw new TypeError('Eligible candidate requires coherent quotes and an eligible window.');
    }
  }
  if (input.buyQuote !== null) validateQuote(input.buyQuote, input.quoteAsset.mint, input.mint);
  if (input.reverseSellQuote !== null) validateQuote(input.reverseSellQuote, input.mint, input.quoteAsset.mint);
  if (
    input.buyQuote !== null
    && input.reverseSellQuote !== null
    && input.reverseSellQuote.amountInRaw !== input.buyQuote.minimumAmountOutRaw
  ) throw new TypeError('Candidate reverse quote does not match the conservative BUY fill.');
}

function validateQuote(quote: PaperExecutionQuote, inputMint: string, outputMint: string): void {
  if (
    quote.id.length === 0
    || quote.inputMint !== inputMint
    || quote.outputMint !== outputMint
    || quote.amountInRaw <= 0n
    || quote.amountOutRaw <= 0n
    || quote.minimumAmountOutRaw <= 0n
    || quote.minimumAmountOutRaw > quote.amountOutRaw
    || quote.feesRaw < 0n
    || quote.slippageBps < 0n
    || quote.slippageBps > 10_000n
    || quote.priceImpactBps < 0n
    || quote.priceImpactBps > 10_000n
    || quote.observedSlot < 0n
  ) throw new TypeError('Candidate quote is incoherent.');
  assertValidTimestampMs('observedAtMs', quote.observedAtMs);
}

function snapshotQuote(quote: PaperExecutionQuote): PaperExecutionQuote {
  return Object.freeze({ ...quote });
}

function validateQuoteAsset(asset: QuoteAsset): void {
  text(asset.mint, 'quote mint');
  if (!Number.isSafeInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255) {
    throw new TypeError('Candidate quote asset decimals are invalid.');
  }
}

function text(value: string, field: string): void {
  if (value.length === 0 || value !== value.trim() || Buffer.byteLength(value, 'utf8') > 4_096) {
    throw new TypeError(`Candidate ${field} is invalid.`);
  }
}

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Candidate ${field} is invalid.`);
}

function fingerprint(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`Candidate ${field} is invalid.`);
}
