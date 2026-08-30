import { isProxy } from 'node:util/types';
import {
  createExecutionIntentDraft,
  type ExecutionIntentDraftV1,
  type ExecutionIntentReasonCode,
} from '../domain/execution-intent.js';
import type { PaperStrategySession } from '../domain/paper-strategy.js';
import type { PaperExecutionQuote, PaperPosition } from '../domain/paper-trading.js';
import type { TradingCandidateV1 } from '../domain/trading-candidate.js';

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
  readonly qualification: ExecutionIntentQualificationIdentity;
  readonly decisionEventId: string;
  readonly decisionFingerprint: string;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
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
  'qualification',
  'decisionEventId',
  'decisionFingerprint',
  'requestedAtMs',
  'expiresAtMs',
] as const);

export function deriveExecutionIntent(
  input: DeriveExecutionIntentInput,
): ExecutionIntentDraftV1 | null {
  const record = frozenDataRecord(input, INPUT_KEYS, 'DECISION_STALE');
  const requestedAction = actionFrom(record.requestedAction);
  const requestedAtMs = timestampFrom(record.requestedAtMs, 'DECISION_STALE');
  const expiresAtMs = timestampFrom(record.expiresAtMs, 'DECISION_STALE');
  if (expiresAtMs <= requestedAtMs) staleDecision();

  const allowlist = allowlistFrom(record.quoteMintAllowlist);
  const wsolMint = textFrom(record.wsolMint, 'QUOTE_MINT_NOT_ALLOWED');
  if (allowlist.length !== 1 || allowlist[0] !== wsolMint) quoteMintNotAllowed();

  const qualification = qualificationFrom(record.qualification);
  const decisionEventId = textFrom(record.decisionEventId, 'DECISION_STALE');
  const decisionFingerprint = fingerprintFrom(record.decisionFingerprint, 'DECISION_STALE');
  const candidate = modelFrom(record.candidate, 'DECISION_STALE') as TradingCandidateV1;

  if (requestedAction === 'NONE') {
    if (record.session !== null) modelFrom(record.session, 'DECISION_STALE');
    if (record.position !== null) modelFrom(record.position, 'DECISION_STALE');
    if (record.quote !== null) modelFrom(record.quote, 'QUOTE_STALE');
    if (record.currentSessionId !== null) {
      textFrom(record.currentSessionId, 'DECISION_STALE');
    }
    return null;
  }

  const session = modelFrom(record.session, 'DECISION_STALE') as PaperStrategySession;
  const position = modelFrom(record.position, 'DECISION_STALE') as PaperPosition;
  const quote = modelFrom(record.quote, 'QUOTE_STALE') as PaperExecutionQuote;
  const currentSessionId = textFrom(record.currentSessionId, 'DECISION_STALE');

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
  assertStrategy(session, strategyId, strategyVersion);
  assertStrategy(position, strategyId, strategyVersion);

  const candidateReportId = textProperty(candidate, 'qualificationReportId', 'QUALIFICATION_STALE');
  if (
    qualification.reportId !== candidateReportId
    || textProperty(session, 'qualificationReportId', 'QUALIFICATION_STALE') !== candidateReportId
    || nullableTextProperty(position, 'qualificationReportId', 'QUALIFICATION_STALE') !== candidateReportId
  ) qualificationStale();
  const profile = modelProperty(candidate, 'qualificationProfile', 'QUALIFICATION_STALE');
  const asOf = modelProperty(candidate, 'asOf', 'QUALIFICATION_STALE');
  if (
    qualification.profileFingerprint
      !== fingerprintProperty(profile, 'fingerprint', 'QUALIFICATION_STALE')
    || qualification.evidenceFingerprint
      !== fingerprintProperty(candidate, 'evidenceFingerprint', 'QUALIFICATION_STALE')
    || qualification.eventId !== textProperty(asOf, 'eventId', 'QUALIFICATION_STALE')
    || textProperty(asOf, 'confirmationStatus', 'QUALIFICATION_STALE') === 'orphaned'
  ) qualificationStale();

  const quoteMint = textProperty(quoteAsset, 'mint', 'QUOTE_MINT_NOT_ALLOWED');
  if (quoteMint !== wsolMint || !allowlist.includes(quoteMint)) quoteMintNotAllowed();
  const quoteDecimals = boundedIntegerProperty(quoteAsset, 'decimals', 0, 255, 'QUOTE_MINT_NOT_ALLOWED');
  const quoteTokenProgram = textProperty(quoteAsset, 'tokenProgram', 'QUOTE_MINT_NOT_ALLOWED');
  if (quoteTokenProgram !== 'SPL_TOKEN') quoteMintNotAllowed();
  assertSameQuoteAsset(session, quoteMint, quoteDecimals, quoteTokenProgram);
  assertSameQuoteAsset(position, quoteMint, quoteDecimals, quoteTokenProgram);

  assertQuote(quote, requestedAtMs);
  const amountInRaw = positiveBigintProperty(quote, 'amountInRaw', 'QUOTE_STALE');
  const minimumAmountOutRaw = positiveBigintProperty(quote, 'minimumAmountOutRaw', 'QUOTE_STALE');
  const logicalCommandId = requestedAction === 'OPEN'
    ? textProperty(session, 'openCommandId', 'DECISION_STALE')
    : textProperty(session, 'closeCommandId', 'DECISION_STALE');

  if (requestedAction === 'OPEN') {
    if (
      textProperty(candidate, 'state', 'DECISION_STALE') !== 'ELIGIBLE'
      || nullableTimestampProperty(candidate, 'eligibleUntilMs', 'DECISION_STALE') < expiresAtMs
      || textProperty(session, 'state', 'DECISION_STALE') !== 'WAITING_EXTERNAL_BUYS'
      || textProperty(position, 'status', 'DECISION_STALE') !== 'PAPER_HOLDING'
      || positiveBigintProperty(position, 'baseFilledRaw', 'DECISION_STALE')
        !== minimumAmountOutRaw
    ) staleDecision();
    if (
      textProperty(quote, 'inputMint', 'QUOTE_STALE') !== quoteMint
      || textProperty(quote, 'outputMint', 'QUOTE_STALE') !== mint
    ) quoteStale();
  } else {
    if (
      textProperty(session, 'state', 'DECISION_STALE') !== 'PAPER_CLOSED'
      || textProperty(position, 'status', 'DECISION_STALE') !== 'PAPER_CLOSED'
      || nonNegativeBigintProperty(position, 'remainingBaseRaw', 'DECISION_STALE') !== 0n
      || positiveBigintProperty(position, 'baseFilledRaw', 'DECISION_STALE') !== amountInRaw
    ) staleDecision();
    if (
      textProperty(quote, 'inputMint', 'QUOTE_STALE') !== mint
      || textProperty(quote, 'outputMint', 'QUOTE_STALE') !== quoteMint
    ) quoteStale();
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
      decisionEventId,
      decisionFingerprint,
      requestedAtMs,
      expiresAtMs,
    });
  } catch {
    staleDecision();
  }
}

function assertQuote(quote: PaperExecutionQuote, requestedAtMs: number): void {
  positiveBigintProperty(quote, 'amountInRaw', 'QUOTE_STALE');
  positiveBigintProperty(quote, 'amountOutRaw', 'QUOTE_STALE');
  const minimum = positiveBigintProperty(quote, 'minimumAmountOutRaw', 'QUOTE_STALE');
  if (minimum > positiveBigintProperty(quote, 'amountOutRaw', 'QUOTE_STALE')) quoteStale();
  nonNegativeBigintProperty(quote, 'feesRaw', 'QUOTE_STALE');
  boundedBigintProperty(quote, 'slippageBps', 0n, 10_000n, 'QUOTE_STALE');
  boundedBigintProperty(quote, 'priceImpactBps', 0n, 10_000n, 'QUOTE_STALE');
  nonNegativeBigintProperty(quote, 'observedSlot', 'QUOTE_STALE');
  if (timestampProperty(quote, 'observedAtMs', 'QUOTE_STALE') > requestedAtMs) quoteStale();
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
  if (!Array.isArray(value) || !Object.isFrozen(value) || isProxy(value)) quoteMintNotAllowed();
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

function timestampFrom(value: unknown, code: ExecutionIntentProducerError['code']): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw new ExecutionIntentProducerError(code);
  }
  return value as number;
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

function boundedBigintProperty(
  value: object,
  key: string,
  minimum: bigint,
  maximum: bigint,
  code: ExecutionIntentProducerError['code'],
): bigint {
  const property = ownValue(value, key, code);
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
