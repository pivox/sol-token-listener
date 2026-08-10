import { createHash } from 'node:crypto';
import { createDeterministicDerivedEventId, type DomainEvent } from '../domain/events.js';
import type { PaperExecutionQuote, PaperStrategyIdentity } from '../domain/paper-trading.js';
import type { QualificationReport } from '../domain/qualification.js';
import {
  createTradingCandidate,
  type TradingCandidateState,
  type TradingCandidateV1,
} from '../domain/trading-candidate.js';
import type { ChainConfirmationStatus, QuoteAsset } from '../domain/types.js';
import type { PaperDecisionSnapshot } from '../ports/paper-decision-repository.js';
import { canonicalStringifyJson } from '../utils/json.js';

export interface TradingCandidateServiceOptions {
  readonly strategy: PaperStrategyIdentity;
  readonly quoteMintAllowlist: readonly string[];
  readonly minimumConfirmation: 'confirmed' | 'finalized';
  readonly entryWindowMs: number;
  readonly maximumQuoteAgeMs: number;
  readonly maximumQuoteSlotLag: bigint;
  readonly retentionMs: number;
}

export interface TradingCandidateInput {
  readonly snapshot: PaperDecisionSnapshot;
  readonly report: QualificationReport;
  readonly reportId: string;
  readonly qualificationEvent: DomainEvent;
  readonly evidenceFingerprint: string;
  readonly quoteAsset: QuoteAsset;
  readonly buyQuote: PaperExecutionQuote | null;
  readonly reverseSellQuote: PaperExecutionQuote | null;
  readonly nowMs: number;
}

export interface TradingCandidateResult {
  readonly candidate: TradingCandidateV1;
  readonly event: DomainEvent;
}

export class TradingCandidateService {
  private readonly options: TradingCandidateServiceOptions;

  public constructor(options: TradingCandidateServiceOptions) {
    validateOptions(options);
    this.options = Object.freeze({
      ...options,
      strategy:Object.freeze({ ...options.strategy }),
      quoteMintAllowlist:Object.freeze([...options.quoteMintAllowlist]),
    });
  }

  public create(input: TradingCandidateInput): TradingCandidateResult {
    validateInput(input);
    const existing = input.snapshot.currentCandidate?.strategy.id === this.options.strategy.id
      && input.snapshot.currentCandidate.strategy.version === this.options.strategy.version
      ? input.snapshot.currentCandidate
      : null;
    const createdAtMs = existing?.createdAtMs ?? input.snapshot.asOfEvent.observedAtMs;
    const eligibleUntilMs = existing?.eligibleUntilMs
      ?? createdAtMs + this.options.entryWindowMs;
    const quotesCoherent = coherentQuotePair(input);
    const state = this.state(input, eligibleUntilMs, quotesCoherent);
    const reasonCodes = state === 'ELIGIBLE'
      ? ['QUALIFIED_ENTRY'] as const
      : state === 'EXPIRED'
        ? ['ENTRY_WINDOW_EXPIRED'] as const
        : state === 'REVOKED'
          ? ['SOURCE_ORPHANED'] as const
          : ['QUALIFICATION_NOT_ELIGIBLE'] as const;
    const candidate = createTradingCandidate({
      mint:input.snapshot.mint,strategy:this.options.strategy,
      qualificationReportId:input.reportId,
      qualificationProfile:Object.freeze({
        id:input.report.ruleSet.id,version:input.report.ruleSet.version,
        fingerprint:input.report.ruleSet.fingerprint,
      }),
      evidenceFingerprint:input.evidenceFingerprint,
      asOfEvent:input.qualificationEvent,state,quoteAsset:input.quoteAsset,
      buyQuote:quotesCoherent ? input.buyQuote : null,
      reverseSellQuote:quotesCoherent ? input.reverseSellQuote : null,
      eligibleUntilMs:state === 'ELIGIBLE' ? eligibleUntilMs : null,
      reasonCodes,createdAtMs,purgeAfterMs:createdAtMs + this.options.retentionMs,
    });
    const eventId = createDeterministicDerivedEventId({
      type:'TradingCandidateUpdated',mint:candidate.mint,source:'paper-decision',
      program:input.qualificationEvent.program,signature:input.qualificationEvent.signature,
      cursor:input.qualificationEvent.cursor,
      qualifier:`${candidate.id}:${hash(canonicalStringifyJson(candidate))}`,
    });
    const event: DomainEvent = Object.freeze({
      id:eventId,type:'TradingCandidateUpdated',mint:candidate.mint,source:'paper-decision',
      program:input.qualificationEvent.program,signature:input.qualificationEvent.signature,
      cursor:input.qualificationEvent.cursor,
      confirmationStatus:input.qualificationEvent.confirmationStatus,
      blockchainTimeMs:input.qualificationEvent.blockchainTimeMs,
      observedAtMs:createdAtMs,payloadVersion:1,payload:Object.freeze({ candidate }),
    });
    return Object.freeze({ candidate,event });
  }

  private state(
    input: TradingCandidateInput,
    eligibleUntilMs: number,
    quotesCoherent: boolean,
  ): TradingCandidateState {
    if (input.snapshot.asOfEvent.confirmationStatus === 'orphaned') return 'REVOKED';
    if (input.nowMs > eligibleUntilMs) return 'EXPIRED';
    if (
      input.report.verdict !== 'QUALIFIED'
      || input.report.blockers.length > 0
      || !confirmationReached(
        input.snapshot.asOfEvent.confirmationStatus,
        this.options.minimumConfirmation,
      )
      || !this.options.quoteMintAllowlist.includes(input.quoteAsset.mint)
      || !input.snapshot.launch.quoteAssets.some((asset) => sameQuoteAsset(asset, input.quoteAsset))
      || input.snapshot.activePosition !== null
      || input.buyQuote === null
      || input.reverseSellQuote === null
      || !quotesCoherent
      || !freshQuote(input.buyQuote, input.nowMs, this.options.maximumQuoteAgeMs)
      || !freshQuote(input.reverseSellQuote, input.nowMs, this.options.maximumQuoteAgeMs)
      || slotDistance(input.buyQuote.observedSlot, input.reverseSellQuote.observedSlot)
        > this.options.maximumQuoteSlotLag
    ) return 'NOT_ELIGIBLE';
    return 'ELIGIBLE';
  }
}

function coherentQuotePair(input: TradingCandidateInput): boolean {
  const { buyQuote,reverseSellQuote,quoteAsset,snapshot } = input;
  return buyQuote !== null
    && reverseSellQuote !== null
    && buyQuote.inputMint === quoteAsset.mint
    && buyQuote.outputMint === snapshot.mint
    && reverseSellQuote.inputMint === snapshot.mint
    && reverseSellQuote.outputMint === quoteAsset.mint
    && reverseSellQuote.amountInRaw === buyQuote.minimumAmountOutRaw;
}

function freshQuote(quote: PaperExecutionQuote, nowMs: number, maximumAgeMs: number): boolean {
  return quote.observedAtMs <= nowMs && nowMs - quote.observedAtMs <= maximumAgeMs;
}

function confirmationReached(
  actual: ChainConfirmationStatus,
  minimum: 'confirmed' | 'finalized',
): boolean {
  return actual === 'finalized' || (minimum === 'confirmed' && actual === 'confirmed');
}

function sameQuoteAsset(left: QuoteAsset, right: QuoteAsset): boolean {
  return left.mint === right.mint
    && left.decimals === right.decimals
    && left.tokenProgram === right.tokenProgram;
}

function slotDistance(left: bigint, right: bigint): bigint {
  return left > right ? left - right : right - left;
}

function validateOptions(options: TradingCandidateServiceOptions): void {
  if (
    options.strategy.id.length === 0
    || !Number.isSafeInteger(options.strategy.version)
    || options.strategy.version <= 0
    || options.quoteMintAllowlist.length === 0
    || new Set(options.quoteMintAllowlist).size !== options.quoteMintAllowlist.length
    || options.quoteMintAllowlist.some((mint) => mint.length === 0)
    || !Number.isSafeInteger(options.entryWindowMs)
    || options.entryWindowMs <= 0
    || !Number.isSafeInteger(options.maximumQuoteAgeMs)
    || options.maximumQuoteAgeMs < 0
    || options.maximumQuoteSlotLag < 0n
    || !Number.isSafeInteger(options.retentionMs)
    || options.retentionMs !== 14_400_000
  ) throw new TypeError('Trading candidate service options are invalid.');
}

function validateInput(input: TradingCandidateInput): void {
  if (
    input.snapshot.mint !== input.qualificationEvent.mint
    || input.snapshot.mint !== input.snapshot.launch.mint
    || !/^qreport_[a-f0-9]{64}$/u.test(input.reportId)
    || !/^[a-f0-9]{64}$/u.test(input.evidenceFingerprint)
    || !Number.isSafeInteger(input.nowMs)
    || input.nowMs < 0
  ) throw new TypeError('Trading candidate input is invalid.');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
