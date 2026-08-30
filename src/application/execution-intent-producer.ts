import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import {
  createExecutionIntentDraft,
  type ExecutionIntentDraftV1,
  type ExecutionIntentReasonCode,
} from '../domain/execution-intent.js';
import {
  CREATION_EXIT_REASONS,
  type PaperStrategySession,
} from '../domain/paper-strategy.js';
import type { PaperExecutionQuote, PaperPosition } from '../domain/paper-trading.js';
import type { TradingCandidateV1 } from '../domain/trading-candidate.js';
import {
  createDeterministicDerivedEventId,
  type DomainEvent,
} from '../domain/events.js';
import { canonicalStringifyJson } from '../utils/json.js';

export interface ExecutionIntentQualificationIdentity {
  readonly reportId: string;
  readonly eventId: string;
  readonly profileFingerprint: string;
  readonly evidenceFingerprint: string;
}

export interface DeriveExecutionIntentInput {
  readonly requestedAction: 'NONE' | 'OPEN' | 'CLOSE';
  readonly session: PaperStrategySession | null;
  readonly currentSessionId: string | null;
  readonly candidate: TradingCandidateV1;
  readonly position: PaperPosition | null;
  readonly quote: PaperExecutionQuote | null;
  readonly quoteMintAllowlist: readonly string[];
  readonly wsolMint: string;
  readonly maximumQuoteAgeMs: number;
  readonly qualification: ExecutionIntentQualificationIdentity;
  readonly sessionEvent: DomainEvent;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
  readonly maximumIntentTtlMs: number;
}

export class ExecutionIntentProducerError extends Error {
  public constructor(public readonly code: Extract<
  ExecutionIntentReasonCode,
  'DECISION_STALE' | 'QUALIFICATION_STALE' | 'QUOTE_STALE' | 'QUOTE_MINT_NOT_ALLOWED'
  >) {
    super('Execution intent derivation rejected.');
    this.name = 'ExecutionIntentProducerError';
  }
}

const INPUT_KEYS = Object.freeze([
  'requestedAction',
  'session',
  'currentSessionId',
  'candidate',
  'position',
  'quote',
  'quoteMintAllowlist',
  'wsolMint',
  'maximumQuoteAgeMs',
  'qualification',
  'sessionEvent',
  'requestedAtMs',
  'expiresAtMs',
  'maximumIntentTtlMs',
] as const);

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const QUOTE_KEYS = Object.freeze([
  'id', 'inputMint', 'outputMint', 'amountInRaw', 'amountOutRaw',
  'minimumAmountOutRaw', 'feesRaw', 'slippageBps', 'priceImpactBps',
  'observedAtMs', 'observedSlot',
] as const);

export function deriveExecutionIntent(
  input: DeriveExecutionIntentInput,
): ExecutionIntentDraftV1 | null {
  const record = frozenDataRecord(input, INPUT_KEYS, 'DECISION_STALE');
  const requestedAction = actionFrom(record.requestedAction);
  const requestedAtMs = timestampFrom(record.requestedAtMs, 'DECISION_STALE');
  const expiresAtMs = timestampFrom(record.expiresAtMs, 'DECISION_STALE');
  const maximumIntentTtlMs = boundedIntegerFrom(
    record.maximumIntentTtlMs, 1, Number.MAX_SAFE_INTEGER, 'DECISION_STALE',
  );
  if (
    expiresAtMs <= requestedAtMs
    || expiresAtMs - requestedAtMs > maximumIntentTtlMs
  ) staleDecision();

  const allowlist = allowlistFrom(record.quoteMintAllowlist);
  const wsolMint = textFrom(record.wsolMint, 'QUOTE_MINT_NOT_ALLOWED');
  if (wsolMint !== WRAPPED_SOL_MINT || allowlist[0] !== wsolMint) quoteMintNotAllowed();
  const maximumQuoteAgeMs = boundedIntegerFrom(
    record.maximumQuoteAgeMs, 0, Number.MAX_SAFE_INTEGER, 'QUOTE_STALE',
  );

  const qualification = qualificationFrom(record.qualification);
  const candidate = modelFrom(record.candidate, 'DECISION_STALE') as TradingCandidateV1;

  if (requestedAction === 'NONE') {
    if (record.session !== null) modelFrom(record.session, 'DECISION_STALE');
    if (record.position !== null) modelFrom(record.position, 'DECISION_STALE');
    if (record.quote !== null) modelFrom(record.quote, 'QUOTE_STALE');
    modelFrom(record.sessionEvent, 'DECISION_STALE');
    if (record.currentSessionId !== null) {
      textFrom(record.currentSessionId, 'DECISION_STALE');
    }
    return null;
  }

  const session = modelFrom(record.session, 'DECISION_STALE') as PaperStrategySession;
  const position = modelFrom(record.position, 'DECISION_STALE') as PaperPosition;
  const quote = modelFrom(record.quote, 'QUOTE_STALE') as PaperExecutionQuote;
  const currentSessionId = textFrom(record.currentSessionId, 'DECISION_STALE');
  const sessionEvent = modelFrom(record.sessionEvent, 'DECISION_STALE') as DomainEvent;

  const sessionId = textProperty(session, 'id', 'DECISION_STALE');
  const candidateId = textProperty(candidate, 'id', 'DECISION_STALE');
  const positionId = textProperty(position, 'id', 'DECISION_STALE');
  const mint = textProperty(candidate, 'mint', 'DECISION_STALE');
  const strategy = modelProperty(candidate, 'strategy', 'DECISION_STALE');
  const quoteAsset = modelProperty(candidate, 'quoteAsset', 'QUOTE_MINT_NOT_ALLOWED');

  if (
    sessionId !== currentSessionId
    || textProperty(session, 'candidateId', 'DECISION_STALE') !== candidateId
    || textProperty(session, 'mint', 'DECISION_STALE') !== mint
    || textProperty(session, 'positionId', 'DECISION_STALE') !== positionId
    || textProperty(position, 'mint', 'DECISION_STALE') !== mint
    || nullableTextProperty(position, 'strategySessionId', 'DECISION_STALE') !== sessionId
    || nullableTextProperty(position, 'candidateId', 'DECISION_STALE') !== candidateId
  ) staleDecision();

  const strategyId = textProperty(strategy, 'id', 'DECISION_STALE');
  const strategyVersion = positiveIntegerProperty(strategy, 'version', 'DECISION_STALE');
  if (strategyId !== 'creation-entry-v1' || strategyVersion !== 1) staleDecision();
  assertStrategy(session, strategyId, strategyVersion);
  assertStrategy(position, strategyId, strategyVersion);
  if (
    ownValue(candidate, 'payloadVersion', 'DECISION_STALE') !== 1
    || ownValue(session, 'payloadVersion', 'DECISION_STALE') !== 2
    || ownValue(position, 'payloadVersion', 'DECISION_STALE') !== 1
    || textProperty(session, 'actorKind', 'DECISION_STALE') !== 'PAPER_SIMULATION'
  ) staleDecision();

  const candidateReportId = textProperty(candidate, 'qualificationReportId', 'QUALIFICATION_STALE');
  if (
    qualification.reportId !== candidateReportId
    || textProperty(session, 'qualificationReportId', 'QUALIFICATION_STALE') !== candidateReportId
    || nullableTextProperty(position, 'qualificationReportId', 'QUALIFICATION_STALE') !== candidateReportId
  ) qualificationStale();
  if (
    !/^qreport_[a-f0-9]{64}$/u.test(candidateReportId)
    || !/^evt_[a-f0-9]{64}$/u.test(qualification.eventId)
    || textProperty(position, 'triggerEventId', 'DECISION_STALE') !== qualification.eventId
    || !/^paper_trade_[a-f0-9]{64}$/u.test(
      textProperty(position, 'entryTradeId', 'DECISION_STALE'),
    )
  ) staleDecision();
  const profile = modelProperty(candidate, 'qualificationProfile', 'QUALIFICATION_STALE');
  const asOf = modelProperty(candidate, 'asOf', 'QUALIFICATION_STALE');
  const profileId = textProperty(profile, 'id', 'QUALIFICATION_STALE');
  const profileVersion = positiveIntegerProperty(profile, 'version', 'QUALIFICATION_STALE');
  const confirmationStatus = textProperty(asOf, 'confirmationStatus', 'QUALIFICATION_STALE');
  const minimumConfirmation = textProperty(session, 'minimumConfirmation', 'DECISION_STALE');
  if (
    qualification.profileFingerprint
      !== fingerprintProperty(profile, 'fingerprint', 'QUALIFICATION_STALE')
    || qualification.evidenceFingerprint
      !== fingerprintProperty(candidate, 'evidenceFingerprint', 'QUALIFICATION_STALE')
    || qualification.eventId !== textProperty(asOf, 'eventId', 'QUALIFICATION_STALE')
    || !confirmationReached(confirmationStatus, minimumConfirmation)
  ) qualificationStale();
  assertCanonicalSessionEvent(sessionEvent, session, mint, minimumConfirmation);
  if (
    requestedAtMs !== timestampProperty(sessionEvent, 'observedAtMs', 'DECISION_STALE')
    || requestedAtMs !== timestampProperty(session, 'updatedAtMs', 'DECISION_STALE')
  ) staleDecision();

  assertCanonicalIds({
    candidateId,
    sessionId,
    positionId,
    mint,
    strategyId,
    strategyVersion,
    profileId,
    profileVersion,
    profileFingerprint: qualification.profileFingerprint,
    evidenceFingerprint: qualification.evidenceFingerprint,
    qualificationEventId: qualification.eventId,
    confirmationStatus,
  });

  const quoteMint = textProperty(quoteAsset, 'mint', 'QUOTE_MINT_NOT_ALLOWED');
  if (quoteMint !== wsolMint || !allowlist.includes(quoteMint)) quoteMintNotAllowed();
  const quoteDecimals = boundedIntegerProperty(quoteAsset, 'decimals', 0, 255, 'QUOTE_MINT_NOT_ALLOWED');
  const quoteTokenProgram = textProperty(quoteAsset, 'tokenProgram', 'QUOTE_MINT_NOT_ALLOWED');
  if (quoteTokenProgram !== 'SPL_TOKEN') quoteMintNotAllowed();
  assertSameQuoteAsset(session, quoteMint, quoteDecimals, quoteTokenProgram);
  assertSameQuoteAsset(position, quoteMint, quoteDecimals, quoteTokenProgram);
  assertCandidateQuotePair(candidate, mint, quoteMint);

  assertQuote(quote, requestedAtMs, maximumQuoteAgeMs);
  const amountInRaw = positiveBigintProperty(quote, 'amountInRaw', 'QUOTE_STALE');
  const minimumAmountOutRaw = positiveBigintProperty(quote, 'minimumAmountOutRaw', 'QUOTE_STALE');
  const logicalCommandId = requestedAction === 'OPEN'
    ? textProperty(session, 'openCommandId', 'DECISION_STALE')
    : textProperty(session, 'closeCommandId', 'DECISION_STALE');

  if (requestedAction === 'OPEN') {
    // Route or asset identity failures are allowlist failures; snapshot/freshness drift is QUOTE_STALE.
    if (
      textProperty(quote, 'inputMint', 'QUOTE_MINT_NOT_ALLOWED') !== quoteMint
      || textProperty(quote, 'outputMint', 'QUOTE_MINT_NOT_ALLOWED') !== mint
    ) quoteMintNotAllowed();
    assertOpenLineage(
      session, candidate, position, quote, qualification.eventId,
      sessionId, candidateId, strategyId, strategyVersion,
    );
    if (
      textProperty(candidate, 'state', 'DECISION_STALE') !== 'ELIGIBLE'
      || nullableTimestampProperty(candidate, 'eligibleUntilMs', 'DECISION_STALE') < expiresAtMs
      || textProperty(session, 'state', 'DECISION_STALE') !== 'WAITING_EXTERNAL_BUYS'
      || textProperty(position, 'status', 'DECISION_STALE') !== 'PAPER_HOLDING'
      || positiveBigintProperty(position, 'baseFilledRaw', 'DECISION_STALE')
        !== minimumAmountOutRaw
    ) staleDecision();
  } else {
    if (
      textProperty(quote, 'inputMint', 'QUOTE_MINT_NOT_ALLOWED') !== mint
      || textProperty(quote, 'outputMint', 'QUOTE_MINT_NOT_ALLOWED') !== quoteMint
    ) quoteMintNotAllowed();
    assertCloseLineage(
      session, candidate, position, quote,
      positionId, strategyId, strategyVersion,
    );
    if (
      textProperty(session, 'state', 'DECISION_STALE') !== 'PAPER_CLOSED'
      || textProperty(position, 'status', 'DECISION_STALE') !== 'PAPER_CLOSED'
      || nonNegativeBigintProperty(position, 'remainingBaseRaw', 'DECISION_STALE') !== 0n
      || positiveBigintProperty(position, 'baseFilledRaw', 'DECISION_STALE') !== amountInRaw
    ) staleDecision();
  }

  try {
    return createExecutionIntentDraft({
      strategyId,
      strategyVersion,
      positionId,
      logicalCommandId,
      mint,
      side: requestedAction === 'OPEN' ? 'BUY' : 'SELL',
      venuePolicy: requestedAction === 'OPEN' ? 'PUMP_FUN_ONLY' : 'CANONICAL_EXIT',
      quoteMint,
      quoteTokenProgram,
      quoteDecimals,
      quoteAmountRaw: requestedAction === 'OPEN' ? amountInRaw : null,
      baseAmountRaw: requestedAction === 'CLOSE' ? amountInRaw : null,
      minimumAmountOutRaw,
      decisionEventId: sessionEvent.id,
      decisionFingerprint: createExecutionDecisionFingerprint(sessionEvent),
      requestedAtMs,
      expiresAtMs,
    });
  } catch {
    staleDecision();
  }
}

export function createExecutionDecisionFingerprint(event: DomainEvent): string {
  return sha256(canonicalStringifyJson(event));
}

function assertCanonicalSessionEvent(
  event: DomainEvent,
  session: PaperStrategySession,
  mint: string,
  minimumConfirmation: string,
): void {
  const record = frozenDataRecord(event, [
    'id', 'type', 'mint', 'source', 'program', 'signature', 'cursor',
    'confirmationStatus', 'blockchainTimeMs', 'observedAtMs', 'payloadVersion', 'payload',
  ], 'DECISION_STALE');
  const cursorRecord = frozenDataRecord(record.cursor, [
    'slot', 'transactionIndex', 'instructionIndex', 'innerInstructionIndex',
  ], 'DECISION_STALE');
  const cursor = Object.freeze({
    slot: nonNegativeBigintFrom(cursorRecord.slot, 'DECISION_STALE'),
    transactionIndex: boundedIntegerFrom(
      cursorRecord.transactionIndex, 0, 2_147_483_647, 'DECISION_STALE',
    ),
    instructionIndex: boundedIntegerFrom(
      cursorRecord.instructionIndex, 0, 2_147_483_647, 'DECISION_STALE',
    ),
    innerInstructionIndex: cursorRecord.innerInstructionIndex === null
      ? null
      : boundedIntegerFrom(
        cursorRecord.innerInstructionIndex, 0, 2_147_483_647, 'DECISION_STALE',
      ),
  });
  const payload = frozenDataRecord(record.payload, ['session'], 'DECISION_STALE');
  const program = textFrom(record.program, 'DECISION_STALE');
  const signature = textFrom(record.signature, 'DECISION_STALE');
  const confirmationStatus = textFrom(record.confirmationStatus, 'DECISION_STALE');
  const observedAtMs = timestampFrom(record.observedAtMs, 'DECISION_STALE');
  if (record.blockchainTimeMs !== null) {
    timestampFrom(record.blockchainTimeMs, 'DECISION_STALE');
  }
  if (
    record.type !== 'PaperStrategySessionUpdated'
    || record.source !== 'paper-decision'
    || record.mint !== mint
    || record.payloadVersion !== 1
    || payload.session !== session
    || observedAtMs !== timestampProperty(session, 'updatedAtMs', 'DECISION_STALE')
    || !confirmationReached(confirmationStatus, minimumConfirmation)
  ) staleDecision();
  let canonicalSession: string;
  try {
    canonicalSession = canonicalStringifyJson(session);
  } catch {
    staleDecision();
  }
  const expectedId = createDeterministicDerivedEventId({
    type: 'PaperStrategySessionUpdated',
    mint,
    source: 'paper-decision',
    program,
    signature,
    cursor,
    qualifier: `${textProperty(session, 'id', 'DECISION_STALE')}:${sha256(canonicalSession)}`,
  });
  if (record.id !== expectedId) staleDecision();
}

function assertQuote(
  quote: PaperExecutionQuote,
  requestedAtMs: number,
  maximumQuoteAgeMs: number,
): void {
  assertQuoteShape(quote);
  const observedAtMs = timestampProperty(quote, 'observedAtMs', 'QUOTE_STALE');
  if (
    observedAtMs > requestedAtMs
    || requestedAtMs - observedAtMs > maximumQuoteAgeMs
  ) quoteStale();
}

function assertQuoteShape(quote: object): void {
  textProperty(quote, 'id', 'QUOTE_STALE');
  textProperty(quote, 'inputMint', 'QUOTE_MINT_NOT_ALLOWED');
  textProperty(quote, 'outputMint', 'QUOTE_MINT_NOT_ALLOWED');
  positiveBigintProperty(quote, 'amountInRaw', 'QUOTE_STALE');
  positiveBigintProperty(quote, 'amountOutRaw', 'QUOTE_STALE');
  const minimum = positiveBigintProperty(quote, 'minimumAmountOutRaw', 'QUOTE_STALE');
  if (minimum > positiveBigintProperty(quote, 'amountOutRaw', 'QUOTE_STALE')) quoteStale();
  nonNegativeBigintProperty(quote, 'feesRaw', 'QUOTE_STALE');
  boundedBigintProperty(quote, 'slippageBps', 0n, 10_000n, 'QUOTE_STALE');
  boundedBigintProperty(quote, 'priceImpactBps', 0n, 10_000n, 'QUOTE_STALE');
  nonNegativeBigintProperty(quote, 'observedSlot', 'QUOTE_STALE');
  timestampProperty(quote, 'observedAtMs', 'QUOTE_STALE');
}

function assertCandidateQuotePair(
  candidate: TradingCandidateV1,
  mint: string,
  quoteMint: string,
): void {
  const buy = modelProperty(candidate, 'buyQuote', 'QUOTE_STALE');
  const reverse = modelProperty(candidate, 'reverseSellQuote', 'QUOTE_STALE');
  assertQuoteShape(buy);
  assertQuoteShape(reverse);
  if (
    textProperty(buy, 'inputMint', 'QUOTE_MINT_NOT_ALLOWED') !== quoteMint
    || textProperty(buy, 'outputMint', 'QUOTE_MINT_NOT_ALLOWED') !== mint
    || textProperty(reverse, 'inputMint', 'QUOTE_MINT_NOT_ALLOWED') !== mint
    || textProperty(reverse, 'outputMint', 'QUOTE_MINT_NOT_ALLOWED') !== quoteMint
  ) quoteMintNotAllowed();
  if (
    positiveBigintProperty(reverse, 'amountInRaw', 'QUOTE_STALE')
      !== positiveBigintProperty(buy, 'minimumAmountOutRaw', 'QUOTE_STALE')
  ) quoteStale();
}

function assertOpenLineage(
  session: PaperStrategySession,
  candidate: TradingCandidateV1,
  position: PaperPosition,
  quote: PaperExecutionQuote,
  qualificationEventId: string,
  sessionId: string,
  candidateId: string,
  strategyId: string,
  strategyVersion: number,
): void {
  const canonicalBuyQuote = modelProperty(candidate, 'buyQuote', 'QUOTE_STALE');
  const sessionQuote = modelProperty(session, 'lastQuote', 'QUOTE_STALE');
  if (!sameQuote(quote, canonicalBuyQuote) || !sameQuote(quote, sessionQuote)) quoteStale();
  if (
    textProperty(position, 'triggerEventId', 'DECISION_STALE') !== qualificationEventId
    || textProperty(session, 'reasonCode', 'DECISION_STALE') !== 'QUALIFIED_ENTRY'
    || textProperty(session, 'openCommandId', 'DECISION_STALE')
      !== strategyCommandId('paper_open', [
        sessionId, candidateId, strategyId, String(strategyVersion),
      ])
    || nullableTextProperty(session, 'closeCommandId', 'DECISION_STALE') !== null
    || nullableTextProperty(session, 'pendingExitReason', 'DECISION_STALE') !== null
    // Strategy command IDs and execution snapshot hashes are deliberately distinct identities.
    || !/^paper_open_command_[a-f0-9]{64}$/u.test(
      textProperty(position, 'openCommandHash', 'DECISION_STALE'),
    )
    || nullableTextProperty(position, 'closeCommandHash', 'DECISION_STALE') !== null
    || nullableTextProperty(position, 'closeEventId', 'DECISION_STALE') !== null
    || nullableTextProperty(position, 'exitTradeId', 'DECISION_STALE') !== null
    || nonNegativeBigintProperty(position, 'quoteCostRaw', 'DECISION_STALE')
      !== positiveBigintProperty(quote, 'amountInRaw', 'QUOTE_STALE')
    || nonNegativeBigintProperty(position, 'remainingBaseRaw', 'DECISION_STALE')
      !== positiveBigintProperty(quote, 'minimumAmountOutRaw', 'QUOTE_STALE')
    || nullableBigintProperty(position, 'quoteProceedsRaw', 'DECISION_STALE') !== null
  ) staleDecision();
}

function assertCloseLineage(
  session: PaperStrategySession,
  candidate: TradingCandidateV1,
  position: PaperPosition,
  quote: PaperExecutionQuote,
  positionId: string,
  strategyId: string,
  strategyVersion: number,
): void {
  const sessionQuote = modelProperty(session, 'lastQuote', 'QUOTE_STALE');
  if (!sameQuote(quote, sessionQuote)) quoteStale();
  const canonicalBuyQuote = modelProperty(candidate, 'buyQuote', 'QUOTE_STALE');
  const pendingExitReason = textProperty(session, 'pendingExitReason', 'DECISION_STALE');
  const reasonCode = textProperty(session, 'reasonCode', 'DECISION_STALE');
  const pendingExitTriggerAtMs = nullableTimestampOrNullProperty(
    session, 'pendingExitTriggerAtMs', 'DECISION_STALE',
  );
  if (
    !(CREATION_EXIT_REASONS as readonly string[]).includes(pendingExitReason)
    || reasonCode !== pendingExitReason
    || (pendingExitReason === 'MANUAL_KILL_SWITCH') !== (pendingExitTriggerAtMs !== null)
    || (pendingExitReason !== 'MANUAL_KILL_SWITCH' && pendingExitTriggerAtMs !== null)
    ||
    textProperty(session, 'closeCommandId', 'DECISION_STALE')
      !== strategyCommandId('paper_sell', [
        positionId, strategyId, String(strategyVersion), pendingExitReason,
      ])
    || !/^paper_open_command_[a-f0-9]{64}$/u.test(
      textProperty(position, 'openCommandHash', 'DECISION_STALE'),
    )
    || !/^paper_close_command_[a-f0-9]{64}$/u.test(
      textProperty(position, 'closeCommandHash', 'DECISION_STALE'),
    )
    || !/^evt_[a-f0-9]{64}$/u.test(
      textProperty(position, 'closeEventId', 'DECISION_STALE'),
    )
    || !/^paper_trade_[a-f0-9]{64}$/u.test(
      textProperty(position, 'exitTradeId', 'DECISION_STALE'),
    )
    || nonNegativeBigintProperty(position, 'quoteCostRaw', 'DECISION_STALE')
      !== positiveBigintProperty(canonicalBuyQuote, 'amountInRaw', 'QUOTE_STALE')
    || positiveBigintProperty(position, 'baseFilledRaw', 'DECISION_STALE')
      !== positiveBigintProperty(canonicalBuyQuote, 'minimumAmountOutRaw', 'QUOTE_STALE')
    || nullableBigintProperty(position, 'quoteProceedsRaw', 'DECISION_STALE')
      !== positiveBigintProperty(quote, 'minimumAmountOutRaw', 'QUOTE_STALE')
  ) staleDecision();
}

function sameQuote(left: object, right: object): boolean {
  const leftRecord = frozenDataRecord(left, QUOTE_KEYS, 'QUOTE_STALE');
  const rightRecord = frozenDataRecord(right, QUOTE_KEYS, 'QUOTE_STALE');
  return QUOTE_KEYS.every((key) => Object.is(leftRecord[key], rightRecord[key]));
}

function assertCanonicalIds(input: Readonly<{
  candidateId: string;
  sessionId: string;
  positionId: string;
  mint: string;
  strategyId: string;
  strategyVersion: number;
  profileId: string;
  profileVersion: number;
  profileFingerprint: string;
  evidenceFingerprint: string;
  qualificationEventId: string;
  confirmationStatus: string;
}>): void {
  const candidateId = `candidate_${sha256(JSON.stringify([
    input.mint,
    input.strategyId,
    String(input.strategyVersion),
    input.profileId,
    String(input.profileVersion),
    input.profileFingerprint,
    input.evidenceFingerprint,
    input.qualificationEventId,
    input.confirmationStatus,
  ]))}`;
  const sessionId = `paper_session_${sha256(JSON.stringify([
    candidateId, input.strategyId, String(input.strategyVersion),
  ]))}`;
  const positionId = executionSnapshotId('paper_position', [
    input.mint, input.strategyId, input.strategyVersion, input.qualificationEventId,
  ]);
  if (
    input.candidateId !== candidateId
    || input.sessionId !== sessionId
    || input.positionId !== positionId
  ) staleDecision();
}

function strategyCommandId(namespace: 'paper_open' | 'paper_sell', parts: readonly string[]): string {
  return `${namespace}_${sha256(JSON.stringify(parts))}`;
}

function executionSnapshotId(namespace: string, parts: readonly (string | number)[]): string {
  return `${namespace}_${sha256(`${namespace}\u001f${JSON.stringify(parts)}`)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function confirmationReached(actual: string, minimum: string): boolean {
  if (minimum !== 'confirmed' && minimum !== 'finalized') staleDecision();
  return actual === 'finalized' || (minimum === 'confirmed' && actual === 'confirmed');
}

function assertStrategy(value: object, id: string, version: number): void {
  const strategy = modelProperty(value, 'strategy', 'DECISION_STALE');
  if (
    textProperty(strategy, 'id', 'DECISION_STALE') !== id
    || positiveIntegerProperty(strategy, 'version', 'DECISION_STALE') !== version
  ) staleDecision();
}

function assertSameQuoteAsset(
  value: object,
  mint: string,
  decimals: number,
  tokenProgram: string,
): void {
  const asset = modelProperty(value, 'quoteAsset', 'QUOTE_MINT_NOT_ALLOWED');
  if (
    textProperty(asset, 'mint', 'QUOTE_MINT_NOT_ALLOWED') !== mint
    || boundedIntegerProperty(asset, 'decimals', 0, 255, 'QUOTE_MINT_NOT_ALLOWED') !== decimals
    || textProperty(asset, 'tokenProgram', 'QUOTE_MINT_NOT_ALLOWED') !== tokenProgram
  ) quoteMintNotAllowed();
}

function qualificationFrom(value: unknown): ExecutionIntentQualificationIdentity {
  const record = frozenDataRecord(value, [
    'reportId', 'eventId', 'profileFingerprint', 'evidenceFingerprint',
  ], 'QUALIFICATION_STALE');
  return Object.freeze({
    reportId: textFrom(record.reportId, 'QUALIFICATION_STALE'),
    eventId: textFrom(record.eventId, 'QUALIFICATION_STALE'),
    profileFingerprint: fingerprintFrom(record.profileFingerprint, 'QUALIFICATION_STALE'),
    evidenceFingerprint: fingerprintFrom(record.evidenceFingerprint, 'QUALIFICATION_STALE'),
  });
}

function allowlistFrom(value: unknown): readonly string[] {
  if (isProxy(value) || !Array.isArray(value) || !Object.isFrozen(value)) quoteMintNotAllowed();
  if (value.length !== 1) quoteMintNotAllowed();
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) quoteMintNotAllowed();
    result.push(textFrom(descriptor.value, 'QUOTE_MINT_NOT_ALLOWED'));
  }
  if (new Set(result).size !== result.length) quoteMintNotAllowed();
  return Object.freeze(result);
}

function frozenDataRecord(
  value: unknown,
  keys: readonly string[],
  code: ExecutionIntentProducerError['code'],
): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== 'object'
      || value === null
      || Array.isArray(value)
      || isProxy(value)
      || !Object.isFrozen(value)
    ) throw new ExecutionIntentProducerError(code);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length) throw new ExecutionIntentProducerError(code);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new ExecutionIntentProducerError(code);
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch (error: unknown) {
    if (error instanceof ExecutionIntentProducerError) throw error;
    throw new ExecutionIntentProducerError(code);
  }
}

function modelFrom(
  value: unknown,
  code: ExecutionIntentProducerError['code'],
): object {
  if (typeof value !== 'object' || value === null || isProxy(value) || !Object.isFrozen(value)) {
    throw new ExecutionIntentProducerError(code);
  }
  return value;
}

function ownValue(
  value: object,
  key: string,
  code: ExecutionIntentProducerError['code'],
): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new ExecutionIntentProducerError(code);
    }
    return descriptor.value;
  } catch (error: unknown) {
    if (error instanceof ExecutionIntentProducerError) throw error;
    throw new ExecutionIntentProducerError(code);
  }
}

function modelProperty(
  value: object,
  key: string,
  code: ExecutionIntentProducerError['code'],
): object {
  return modelFrom(ownValue(value, key, code), code);
}

function textProperty(value: object, key: string, code: ExecutionIntentProducerError['code']): string {
  return textFrom(ownValue(value, key, code), code);
}

function nullableTextProperty(
  value: object,
  key: string,
  code: ExecutionIntentProducerError['code'],
): string | null {
  const property = ownValue(value, key, code);
  return property === null || property === undefined ? null : textFrom(property, code);
}

function textFrom(value: unknown, code: ExecutionIntentProducerError['code']): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > 4_096
  ) throw new ExecutionIntentProducerError(code);
  return value;
}

function fingerprintProperty(
  value: object,
  key: string,
  code: ExecutionIntentProducerError['code'],
): string {
  return fingerprintFrom(ownValue(value, key, code), code);
}

function fingerprintFrom(value: unknown, code: ExecutionIntentProducerError['code']): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ExecutionIntentProducerError(code);
  }
  return value;
}

function actionFrom(value: unknown): DeriveExecutionIntentInput['requestedAction'] {
  if (value !== 'NONE' && value !== 'OPEN' && value !== 'CLOSE') staleDecision();
  return value;
}

function timestampProperty(
  value: object,
  key: string,
  code: ExecutionIntentProducerError['code'],
): number {
  return timestampFrom(ownValue(value, key, code), code);
}

function nullableTimestampProperty(
  value: object,
  key: string,
  code: ExecutionIntentProducerError['code'],
): number {
  const property = ownValue(value, key, code);
  if (property === null) throw new ExecutionIntentProducerError(code);
  return timestampFrom(property, code);
}

function nullableTimestampOrNullProperty(
  value: object,
  key: string,
  code: ExecutionIntentProducerError['code'],
): number | null {
  const property = ownValue(value, key, code);
  return property === null ? null : timestampFrom(property, code);
}

function timestampFrom(value: unknown, code: ExecutionIntentProducerError['code']): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw new ExecutionIntentProducerError(code);
  }
  return value as number;
}

function boundedIntegerFrom(
  value: unknown,
  minimum: number,
  maximum: number,
  code: ExecutionIntentProducerError['code'],
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
    || Object.is(value, -0)
  ) throw new ExecutionIntentProducerError(code);
  return value as number;
}

function nonNegativeBigintFrom(
  value: unknown,
  code: ExecutionIntentProducerError['code'],
): bigint {
  return boundedBigintValue(value, 0n, 18_446_744_073_709_551_615n, code);
}

function positiveIntegerProperty(
  value: object,
  key: string,
  code: ExecutionIntentProducerError['code'],
): number {
  return boundedIntegerProperty(value, key, 1, 2_147_483_647, code);
}

function boundedIntegerProperty(
  value: object,
  key: string,
  minimum: number,
  maximum: number,
  code: ExecutionIntentProducerError['code'],
): number {
  const property = ownValue(value, key, code);
  if (
    !Number.isSafeInteger(property)
    || (property as number) < minimum
    || (property as number) > maximum
    || Object.is(property, -0)
  ) throw new ExecutionIntentProducerError(code);
  return property as number;
}

function positiveBigintProperty(
  value: object,
  key: string,
  code: ExecutionIntentProducerError['code'],
): bigint {
  return boundedBigintProperty(value, key, 1n, 18_446_744_073_709_551_615n, code);
}

function nonNegativeBigintProperty(
  value: object,
  key: string,
  code: ExecutionIntentProducerError['code'],
): bigint {
  return boundedBigintProperty(value, key, 0n, 18_446_744_073_709_551_615n, code);
}

function nullableBigintProperty(
  value: object,
  key: string,
  code: ExecutionIntentProducerError['code'],
): bigint | null {
  const property = ownValue(value, key, code);
  return property === null
    ? null
    : boundedBigintValue(property, 0n, 18_446_744_073_709_551_615n, code);
}

function boundedBigintProperty(
  value: object,
  key: string,
  minimum: bigint,
  maximum: bigint,
  code: ExecutionIntentProducerError['code'],
): bigint {
  const property = ownValue(value, key, code);
  return boundedBigintValue(property, minimum, maximum, code);
}

function boundedBigintValue(
  property: unknown,
  minimum: bigint,
  maximum: bigint,
  code: ExecutionIntentProducerError['code'],
): bigint {
  if (typeof property !== 'bigint' || property < minimum || property > maximum) {
    throw new ExecutionIntentProducerError(code);
  }
  return property;
}

function staleDecision(): never {
  throw new ExecutionIntentProducerError('DECISION_STALE');
}

function qualificationStale(): never {
  throw new ExecutionIntentProducerError('QUALIFICATION_STALE');
}

function quoteStale(): never {
  throw new ExecutionIntentProducerError('QUOTE_STALE');
}

function quoteMintNotAllowed(): never {
  throw new ExecutionIntentProducerError('QUOTE_MINT_NOT_ALLOWED');
}
