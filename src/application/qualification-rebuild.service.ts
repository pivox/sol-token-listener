import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isProxy } from 'node:util/types';
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
import type {
  CanonicalQualificationProjection,
  QualificationEvidenceSnapshot,
} from '../ports/qualification-projection-repository.js';
import { canonicalStringifyJson } from '../utils/json.js';
import type { QualificationEngine } from '../qualification/qualification-engine.js';
import { toSocialQualificationObservations } from '../social/social-qualification-observations.js';

export interface QualificationRebuildInput {
  readonly snapshot: QualificationEvidenceSnapshot;
  readonly buyQuote: PaperExecutionQuote | null | undefined;
  readonly reverseSellQuote: PaperExecutionQuote | null | undefined;
  readonly upstreamConditions?: readonly QualificationUpstreamCondition[];
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
    return this.build({
      sourceEventId:input.snapshot.asOfEvent.id,
      mint:input.snapshot.mint,
      sourceEvent:input.snapshot.asOfEvent,
      evaluation,
    });
  }

  public reauthorize(projection: CanonicalQualificationProjection): RebuiltQualification {
    rejectProxy(projection, 'projection');
    rejectProxy(projection.report, 'report');
    rejectProxy(projection.qualificationEvent, 'qualification event');
    rejectProxy(projection.qualificationEvent.payload, 'qualification event payload');
    assertCanonicalValue(projection, 'projection');
    assertPersistedIdentifier(projection.sourceEventId, 'source event id');
    assertPersistedIdentifier(projection.sourceRawEventId, 'source raw event id');
    const evaluation = snapshotPersistedEvaluation(projection.evaluation);
    const rebuilt = this.build({
      sourceEventId:projection.sourceEventId,
      mint:projection.qualificationEvent.mint,
      sourceEvent:projection.qualificationEvent,
      evaluation,
      authorizationEventId:projection.qualificationEvent.id,
    });
    if (
      projection.reportId !== rebuilt.reportId
      || projection.evidenceFingerprint !== rebuilt.evidenceFingerprint
      || !isDeepStrictEqual(projection.evaluation, rebuilt.evaluation)
      || !isDeepStrictEqual(projection.report, rebuilt.report)
      || !isDeepStrictEqual(projection.qualificationEvent, rebuilt.event)
    ) throw new TypeError('Persisted qualification projection is not canonical.');
    return rebuilt;
  }

  private build(input: Readonly<{
    sourceEventId: string;
    mint: string;
    sourceEvent: DomainEvent;
    evaluation: QualificationEvaluationInput;
    authorizationEventId?: string;
  }>): RebuiltQualification {
    const evidenceFingerprint = fingerprintEvaluation(input.evaluation);
    const profile = this.engine.profileSummary;
    const reportId = `qreport_${hash(JSON.stringify([
      input.mint,profile.id,String(profile.version),profile.fingerprint,
      evidenceFingerprint,input.sourceEventId,input.sourceEvent.confirmationStatus,
    ]))}`;
    const eventId = createDeterministicDerivedEventId({
      type:'QualificationUpdated',mint:input.mint,source:'qualification',
      program:input.sourceEvent.program,signature:input.sourceEvent.signature,
      cursor:input.sourceEvent.cursor,qualifier:reportId,
    });
    const report = this.engine.evaluateAuthorized(
      { mint:input.mint,triggerEventId:input.authorizationEventId ?? eventId },
      input.evaluation,
    );
    const event: DomainEvent = Object.freeze({
      id:eventId,type:'QualificationUpdated',mint:input.mint,
      source:'qualification',program:input.sourceEvent.program,
      signature:input.sourceEvent.signature,cursor:input.sourceEvent.cursor,
      confirmationStatus:input.sourceEvent.confirmationStatus,
      blockchainTimeMs:input.sourceEvent.blockchainTimeMs,
      observedAtMs:input.evaluation.evaluatedAtMs,payloadVersion:1,
      payload:Object.freeze({ reportId,evidenceFingerprint,evaluation:input.evaluation,report }),
    });
    return Object.freeze({
      reportId,reportEventId:eventId,evidenceFingerprint,
      evaluation:input.evaluation,report,event,
    });
  }
}

function fingerprintEvaluation(evaluation: QualificationEvaluationInput): string {
  return hash(canonicalStringifyJson({
    signals:evaluation.signals,
    blockers:evaluation.blockers,
    calibrationFacts:evaluation.calibrationFacts,
  }));
}

function assertPersistedIdentifier(value: string, name: string): void {
  if (
    typeof value !== 'string'
    || value.trim() === ''
    || Buffer.byteLength(value, 'utf8') > 16_384
  ) throw new TypeError(`Persisted qualification ${name} is invalid.`);
}

function assertCanonicalValue(value: unknown, name: string): void {
  try {
    canonicalStringifyJson(value);
  } catch (cause: unknown) {
    throw new TypeError(`Persisted qualification ${name} is invalid.`, { cause });
  }
}

function snapshotPersistedEvaluation(
  evaluation: QualificationEvaluationInput,
): QualificationEvaluationInput {
  assertCanonicalValue(evaluation, 'evaluation');
  rejectProxy(evaluation, 'evaluation');
  rejectProxy(evaluation.signals, 'evaluation signals');
  rejectProxy(evaluation.blockers, 'evaluation blockers');
  const calibrationFacts = evaluation.calibrationFacts === null
    ? null
    : snapshotPersistedCalibrationFacts(evaluation.calibrationFacts);
  return Object.freeze({
    evaluatedAtMs:evaluation.evaluatedAtMs,
    signals:Object.freeze({ ...evaluation.signals }),
    blockers:Object.freeze([...evaluation.blockers]),
    calibrationFacts,
  });
}

function snapshotPersistedCalibrationFacts(
  facts: NonNullable<QualificationEvaluationInput['calibrationFacts']>,
): NonNullable<QualificationEvaluationInput['calibrationFacts']> {
  rejectProxy(facts, 'evaluation calibration facts');
  rejectProxy(facts.upstreamConditions, 'evaluation upstream conditions');
  const upstreamConditions = Object.freeze(facts.upstreamConditions.map((condition) => {
    rejectProxy(condition, 'evaluation upstream condition');
    return Object.freeze({ code:condition.code,triggered:condition.triggered });
  }));
  return Object.freeze({
    top1HolderBps:facts.top1HolderBps,
    top5HoldersBps:facts.top5HoldersBps,
    top10HoldersBps:facts.top10HoldersBps,
    maximumRelatedClusterBps:facts.maximumRelatedClusterBps,
    maximumSharedFunderCount:facts.maximumSharedFunderCount,
    buySimulationSucceeded:facts.buySimulationSucceeded,
    sellQuoteAvailable:facts.sellQuoteAvailable,
    roundTripLossBps:facts.roundTripLossBps,
    upstreamConditions,
  });
}

function rejectProxy(value: object, name: string): void {
  if (isProxy(value)) throw new TypeError(`Persisted qualification ${name} is invalid.`);
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
  for (const condition of input.upstreamConditions ?? []) mergeCondition(upstream, condition);
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
