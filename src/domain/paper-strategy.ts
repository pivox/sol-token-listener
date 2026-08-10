import { createHash } from 'node:crypto';
import { assertValidChainCursor, compareCursors } from './cursor.js';
import {
  PAPER_SIMULATION_ACTOR_KIND,
  type PaperExecutionQuote,
  type PaperStrategyIdentity,
} from './paper-trading.js';
import { assertValidTimestampMs } from './timestamp.js';
import type { ChainCursor, QuoteAsset } from './types.js';
import type { TradingCandidateV1 } from './trading-candidate.js';

export const PAPER_STRATEGY_SESSION_STATES = Object.freeze([
  'BUY_PENDING',
  'PAPER_HOLDING',
  'WAITING_EXTERNAL_BUYS',
  'EXIT_PENDING_QUOTE',
  'SELL_PENDING',
  'PAPER_CLOSED',
  'PAPER_RETRACTED',
  'MANUAL_REVIEW',
] as const);

export type PaperStrategySessionState = (typeof PAPER_STRATEGY_SESSION_STATES)[number];

export const PAPER_DECISION_REASON_CODES = Object.freeze([
  'QUALIFICATION_NOT_ELIGIBLE',
  'ENTRY_WINDOW_EXPIRED',
  'EVIDENCE_REVOKED',
  'QUALIFIED_ENTRY',
  'EXTERNAL_BUY_OBSERVED',
  'EXTERNAL_BUY_TARGET_REACHED',
  'EXIT_QUOTE_UNAVAILABLE',
  'SOURCE_ORPHANED',
  'RECONCILIATION_REQUIRED',
] as const);

export type PaperDecisionReasonCode = (typeof PAPER_DECISION_REASON_CODES)[number];
export type PaperMinimumConfirmation = 'confirmed' | 'finalized';

export interface PaperStrategyErrorEvidence {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface PaperStrategySessionV1 {
  readonly id: string;
  readonly mint: string;
  readonly quoteAsset: QuoteAsset;
  readonly strategy: PaperStrategyIdentity;
  readonly candidateId: string;
  readonly qualificationReportId: string;
  readonly actorKind: typeof PAPER_SIMULATION_ACTOR_KIND;
  readonly state: PaperStrategySessionState;
  readonly reasonCode: PaperDecisionReasonCode;
  readonly positionId: string | null;
  readonly openCommandId: string;
  readonly closeCommandId: string | null;
  readonly entryCursor: ChainCursor;
  readonly externalBuyTarget: number;
  readonly externalBuyCount: number;
  readonly countedTradeIds: readonly string[];
  readonly lastCountedCursor: ChainCursor | null;
  readonly minimumConfirmation: PaperMinimumConfirmation;
  readonly lastQuote: PaperExecutionQuote | null;
  readonly lastError: PaperStrategyErrorEvidence | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly purgeAfterMs: number;
  readonly payloadVersion: 1;
}

export interface CreatePaperStrategySessionInput {
  readonly candidate: TradingCandidateV1;
  readonly state: PaperStrategySessionState;
  readonly reasonCode: PaperDecisionReasonCode;
  readonly positionId: string | null;
  readonly entryCursor: ChainCursor;
  readonly externalBuyTarget: number;
  readonly externalBuyCount: number;
  readonly countedTradeIds: readonly string[];
  readonly lastCountedCursor: ChainCursor | null;
  readonly minimumConfirmation: PaperMinimumConfirmation;
  readonly lastQuote: PaperExecutionQuote | null;
  readonly lastError: PaperStrategyErrorEvidence | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly purgeAfterMs: number;
}

export interface PaperExternalBuyEvidence {
  readonly sessionId: string;
  readonly tradeId: string;
  readonly mint: string;
  readonly quoteMint: string;
  readonly trader: string | null;
  readonly cursor: ChainCursor;
  readonly confirmationStatus: PaperMinimumConfirmation;
  readonly observedAtMs: number;
  readonly payloadVersion: 1;
}

export type PaperExternalBuyEvidenceInput = Omit<
PaperExternalBuyEvidence,
'sessionId' | 'payloadVersion'
>;

export interface CountExternalBuyResult {
  readonly session: PaperStrategySessionV1;
  readonly evidence: PaperExternalBuyEvidence | null;
  readonly targetReached: boolean;
}

export function createPaperStrategySession(
  input: CreatePaperStrategySessionInput,
): PaperStrategySessionV1 {
  validateSessionInput(input);
  const strategy = Object.freeze({ ...input.candidate.strategy });
  const quoteAsset = Object.freeze({ ...input.candidate.quoteAsset });
  const entryCursor = Object.freeze({ ...input.entryCursor });
  const lastCountedCursor = input.lastCountedCursor === null
    ? null
    : Object.freeze({ ...input.lastCountedCursor });
  const countedTradeIds = Object.freeze([...input.countedTradeIds]);
  const lastQuote = input.lastQuote === null ? null : Object.freeze({ ...input.lastQuote });
  const lastError = input.lastError === null ? null : Object.freeze({ ...input.lastError });
  const id = createSessionId(input.candidate.id, strategy);
  const openCommandId = `paper_open_${hash([id, input.candidate.id, strategy.id, String(strategy.version)])}`;
  const closeCommandId = input.externalBuyCount === input.externalBuyTarget
    && input.positionId !== null
    ? createDeterministicPaperSellCommandId(input.positionId, strategy, input.externalBuyTarget)
    : null;
  return Object.freeze({
    id,
    mint: input.candidate.mint,
    quoteAsset,
    strategy,
    candidateId: input.candidate.id,
    qualificationReportId: input.candidate.qualificationReportId,
    actorKind: PAPER_SIMULATION_ACTOR_KIND,
    state: input.state,
    reasonCode: input.reasonCode,
    positionId: input.positionId,
    openCommandId,
    closeCommandId,
    entryCursor,
    externalBuyTarget: input.externalBuyTarget,
    externalBuyCount: input.externalBuyCount,
    countedTradeIds,
    lastCountedCursor,
    minimumConfirmation: input.minimumConfirmation,
    lastQuote,
    lastError,
    createdAtMs: input.createdAtMs,
    updatedAtMs: input.updatedAtMs,
    purgeAfterMs: input.purgeAfterMs,
    payloadVersion: 1,
  });
}

export function countExternalBuy(
  session: PaperStrategySessionV1,
  input: PaperExternalBuyEvidenceInput,
): CountExternalBuyResult {
  validateExternalBuy(session, input);
  if (session.countedTradeIds.includes(input.tradeId) || session.externalBuyCount === session.externalBuyTarget) {
    return Object.freeze({
      session,
      evidence: null,
      targetReached: session.externalBuyCount === session.externalBuyTarget,
    });
  }
  const evidence: PaperExternalBuyEvidence = Object.freeze({
    sessionId: session.id,
    tradeId: input.tradeId,
    mint: input.mint,
    quoteMint: input.quoteMint,
    trader: input.trader,
    cursor: Object.freeze({ ...input.cursor }),
    confirmationStatus: input.confirmationStatus,
    observedAtMs: input.observedAtMs,
    payloadVersion: 1,
  });
  const count = session.externalBuyCount + 1;
  const targetReached = count === session.externalBuyTarget;
  const updated: PaperStrategySessionV1 = Object.freeze({
    ...session,
    state: targetReached ? 'EXIT_PENDING_QUOTE' : 'WAITING_EXTERNAL_BUYS',
    reasonCode: targetReached ? 'EXTERNAL_BUY_TARGET_REACHED' : 'EXTERNAL_BUY_OBSERVED',
    externalBuyCount: count,
    countedTradeIds: Object.freeze([...session.countedTradeIds, input.tradeId]),
    lastCountedCursor: Object.freeze({ ...input.cursor }),
    closeCommandId: targetReached && session.positionId !== null
      ? createDeterministicPaperSellCommandId(
        session.positionId,
        session.strategy,
        session.externalBuyTarget,
      )
      : null,
    lastError: null,
    updatedAtMs: input.observedAtMs,
  });
  return Object.freeze({ session: updated, evidence, targetReached });
}

export function createDeterministicPaperSellCommandId(
  positionId: string,
  strategy: PaperStrategyIdentity,
  target: number,
): string {
  text(positionId, 'position id');
  text(strategy.id, 'strategy id');
  positiveInteger(strategy.version, 'strategy version');
  boundedTarget(target);
  return `paper_sell_${hash([positionId, strategy.id, String(strategy.version), String(target)])}`;
}

function validateSessionInput(input: CreatePaperStrategySessionInput): void {
  if (!/^candidate_[a-f0-9]{64}$/u.test(input.candidate.id)) throw new TypeError('Session candidate id is invalid.');
  if (!PAPER_STRATEGY_SESSION_STATES.includes(input.state)) throw new TypeError('Session state is invalid.');
  if (!PAPER_DECISION_REASON_CODES.includes(input.reasonCode)) throw new TypeError('Session reason code is invalid.');
  if (input.positionId !== null) text(input.positionId, 'position id');
  assertValidChainCursor(input.entryCursor);
  boundedTarget(input.externalBuyTarget);
  if (
    !Number.isSafeInteger(input.externalBuyCount)
    || input.externalBuyCount < 0
    || input.externalBuyCount > input.externalBuyTarget
    || input.countedTradeIds.length !== input.externalBuyCount
    || new Set(input.countedTradeIds).size !== input.countedTradeIds.length
  ) throw new TypeError('Session external buy count is invalid.');
  for (const tradeId of input.countedTradeIds) text(tradeId, 'counted trade id');
  if (input.lastCountedCursor !== null) {
    assertValidChainCursor(input.lastCountedCursor);
    if (compareCursors(input.lastCountedCursor, input.entryCursor) <= 0) {
      throw new TypeError('Session last counted cursor is invalid.');
    }
  }
  assertValidTimestampMs('observedAtMs', input.createdAtMs);
  assertValidTimestampMs('observedAtMs', input.updatedAtMs);
  assertValidTimestampMs('observedAtMs', input.purgeAfterMs);
  if (input.updatedAtMs < input.createdAtMs || input.purgeAfterMs <= input.updatedAtMs) {
    throw new TypeError('Session dates are invalid.');
  }
  if (input.lastError !== null) {
    text(input.lastError.code, 'error code');
    text(input.lastError.message, 'error message');
  }
}

function validateExternalBuy(
  session: PaperStrategySessionV1,
  input: PaperExternalBuyEvidenceInput,
): void {
  text(input.tradeId, 'external buy trade id');
  if (
    input.mint !== session.mint
    || input.quoteMint !== session.quoteAsset.mint
    || compareCursors(input.cursor, session.entryCursor) <= 0
    || !confirmationReached(input.confirmationStatus, session.minimumConfirmation)
    || (input.trader !== null && input.trader.length === 0)
  ) throw new TypeError('External buy evidence is inconsistent.');
  assertValidTimestampMs('observedAtMs', input.observedAtMs);
}

function confirmationReached(
  actual: PaperMinimumConfirmation,
  minimum: PaperMinimumConfirmation,
): boolean {
  return actual === 'finalized' || minimum === 'confirmed';
}

function createSessionId(candidateId: string, strategy: PaperStrategyIdentity): string {
  return `paper_session_${hash([candidateId, strategy.id, String(strategy.version)])}`;
}

function hash(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function boundedTarget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new TypeError('Session external buy target is invalid.');
  }
}

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Session ${field} is invalid.`);
}

function text(value: string, field: string): void {
  if (value.length === 0 || value !== value.trim() || Buffer.byteLength(value, 'utf8') > 4_096) {
    throw new TypeError(`Session ${field} is invalid.`);
  }
}
