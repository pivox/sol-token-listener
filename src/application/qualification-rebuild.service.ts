import { createHash } from 'node:crypto';
import { createDeterministicDerivedEventId, type DomainEvent } from '../domain/events.js';
import type { PaperExecutionQuote } from '../domain/paper-trading.js';
import type {
  QualificationCalibrationFacts,
  QualificationEvaluationInput,
  QualificationReport,
  QualificationSignalKey,
  QualificationUpstreamCondition,
} from '../domain/qualification.js';
import type { QualificationReasonCode } from '../domain/qualification-reasons.js';
import type { PaperDecisionSnapshot } from '../ports/paper-decision-repository.js';
import { canonicalStringifyJson } from '../utils/json.js';
import type { QualificationEngine } from '../qualification/qualification-engine.js';
import { toSocialQualificationObservations } from '../social/social-qualification-observations.js';

export interface QualificationRebuildInput {
  readonly snapshot: PaperDecisionSnapshot;
  readonly buyQuote: PaperExecutionQuote | null | undefined;
  readonly reverseSellQuote: PaperExecutionQuote | null | undefined;
}

export interface RebuiltQualification {
  readonly reportId: string;
  readonly reportEventId: string;
  readonly evidenceFingerprint: string;
  readonly evaluation: QualificationEvaluationInput;
  readonly report: QualificationReport;
  readonly event: DomainEvent;
}

export class QualificationRebuildService {
  public constructor(private readonly engine: QualificationEngine) {}

  public rebuild(input: QualificationRebuildInput): RebuiltQualification {
    assertInput(input);
    const evaluation = evaluationFrom(input);
    const evidenceFingerprint = hash(canonicalStringifyJson({
      signals:evaluation.signals,
      blockers:evaluation.blockers,
      calibrationFacts:evaluation.calibrationFacts,
    }));
    const profile = this.engine.profileSummary;
    const reportId = `qreport_${hash(JSON.stringify([
      input.snapshot.mint,profile.id,String(profile.version),profile.fingerprint,
      evidenceFingerprint,input.snapshot.asOfEvent.id,
    ]))}`;
    const eventId = createDeterministicDerivedEventId({
      type:'QualificationUpdated',mint:input.snapshot.mint,source:'paper-decision',
      program:input.snapshot.asOfEvent.program,signature:input.snapshot.asOfEvent.signature,
      cursor:input.snapshot.asOfEvent.cursor,qualifier:reportId,
    });
    const report = this.engine.evaluateAuthorized(
      { mint:input.snapshot.mint,triggerEventId:eventId },
      evaluation,
    );
    const event: DomainEvent = Object.freeze({
      id:eventId,type:'QualificationUpdated',mint:input.snapshot.mint,
      source:'paper-decision',program:input.snapshot.asOfEvent.program,
      signature:input.snapshot.asOfEvent.signature,cursor:input.snapshot.asOfEvent.cursor,
      confirmationStatus:input.snapshot.asOfEvent.confirmationStatus,
      blockchainTimeMs:input.snapshot.asOfEvent.blockchainTimeMs,
      observedAtMs:evaluation.evaluatedAtMs,payloadVersion:1,
      payload:Object.freeze({ reportId,evidenceFingerprint,report }),
    });
    return Object.freeze({ reportId,reportEventId:eventId,evidenceFingerprint,evaluation,report,event });
  }
}

function evaluationFrom(input: QualificationRebuildInput): QualificationEvaluationInput {
  const { snapshot } = input;
  const signals: Partial<Record<QualificationSignalKey, boolean>> = {};
  const upstream = new Map<QualificationReasonCode, boolean>();

  if (snapshot.metadata !== null) {
    if (snapshot.metadata.resolution.status === 'RESOLVED') {
      const metadata = snapshot.metadata.resolution.metadata;
      signals.imageValid = validPublicUrl(metadata.imageUrl);
      signals.descriptionAvailable = metadata.description !== null;
      upstream.set('METADATA_FETCH_FAILED', false);
    } else {
      upstream.set('METADATA_FETCH_FAILED', true);
    }
  }
  if (snapshot.social !== null) {
    const social = toSocialQualificationObservations(snapshot.social);
    Object.assign(signals, social.signals);
    for (const condition of social.upstreamConditions) mergeCondition(upstream, condition);
  }
  if (snapshot.creatorProfile !== null) {
    signals.creatorHasNotSold = !snapshot.creatorProfile.hasSold;
    upstream.set('CREATOR_EARLY_SELL', snapshot.creatorProfile.hasSold);
  }
  if (snapshot.holderSnapshot !== null) {
    signals.externalBuyersObserved = snapshot.holderSnapshot.uniqueExternalBuyers > 0;
  }
  if (input.reverseSellQuote !== undefined) {
    signals.reverseQuoteAvailable = input.reverseSellQuote !== null;
  }

  const facts: QualificationCalibrationFacts = Object.freeze({
    top1HolderBps:snapshot.holderSnapshot?.top1Bps ?? null,
    top5HoldersBps:snapshot.holderSnapshot?.top5Bps ?? null,
    top10HoldersBps:snapshot.holderSnapshot?.top10Bps ?? null,
    maximumRelatedClusterBps:maximumBigInt(
      snapshot.walletGraph?.clusters.map((cluster) => cluster.concentrationBps),
    ),
    maximumSharedFunderCount:maximumNumber(
      snapshot.walletGraph?.clusters.map((cluster) => cluster.sharedFunderCount),
    ),
    buySimulationSucceeded:quoteAvailability(input.buyQuote),
    sellQuoteAvailable:quoteAvailability(input.reverseSellQuote),
    roundTripLossBps:roundTripLoss(input.buyQuote, input.reverseSellQuote),
    upstreamConditions:Object.freeze([...upstream.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code,triggered]) => Object.freeze({ code,triggered }))),
  });
  return Object.freeze({
    evaluatedAtMs:snapshot.asOfEvent.observedAtMs,
    signals:Object.freeze(signals),blockers:Object.freeze([]),calibrationFacts:facts,
  });
}

function roundTripLoss(
  buy: PaperExecutionQuote | null | undefined,
  reverse: PaperExecutionQuote | null | undefined,
): bigint | null {
  if (buy === null || buy === undefined || reverse === null || reverse === undefined) return null;
  if (
    buy.amountInRaw <= 0n
    || buy.minimumAmountOutRaw <= 0n
    || reverse.amountInRaw !== buy.minimumAmountOutRaw
    || reverse.minimumAmountOutRaw < 0n
  ) throw new TypeError('Paper round-trip quotes are incoherent.');
  const loss = buy.amountInRaw > reverse.minimumAmountOutRaw
    ? buy.amountInRaw - reverse.minimumAmountOutRaw
    : 0n;
  return loss * 10_000n / buy.amountInRaw;
}

function quoteAvailability(value: PaperExecutionQuote | null | undefined): boolean | null {
  return value === undefined ? null : value !== null;
}

function maximumBigInt(values: readonly bigint[] | undefined): bigint | null {
  if (values === undefined) return null;
  return values.reduce((maximum, value) => value > maximum ? value : maximum, 0n);
}

function maximumNumber(values: readonly number[] | undefined): number | null {
  if (values === undefined) return null;
  return values.reduce((maximum, value) => Math.max(maximum, value), 0);
}

function validPublicUrl(value: string | null): boolean {
  if (value === null) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'ipfs:';
  } catch {
    return false;
  }
}

function mergeCondition(
  target: Map<QualificationReasonCode, boolean>,
  condition: QualificationUpstreamCondition,
): void {
  target.set(condition.code, condition.triggered || target.get(condition.code) === true);
}

function assertInput(input: QualificationRebuildInput): void {
  if (input.snapshot.mint !== input.snapshot.launch.mint) {
    throw new TypeError('Qualification snapshot mint is inconsistent.');
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
