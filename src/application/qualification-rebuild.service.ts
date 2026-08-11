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
import {
  canonicalStringifyJson,
  MAX_CANONICAL_JSON_DEPTH,
  MAX_CANONICAL_JSON_NODES,
  MAX_CANONICAL_JSON_STRING_BYTES,
  MAX_CANONICAL_JSON_TEXT_BYTES,
} from '../utils/json.js';
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
    const persisted = snapshotPersistedProjection(projection);
    assertCanonicalValue(persisted, 'projection');
    assertPersistedIdentifier(persisted.sourceEventId, 'source event id');
    assertPersistedIdentifier(persisted.sourceRawEventId, 'source raw event id');
    const rebuilt = this.build({
      sourceEventId:persisted.sourceEventId,
      mint:persisted.qualificationEvent.mint,
      sourceEvent:persisted.qualificationEvent,
      evaluation:persisted.evaluation,
      authorizationEventId:persisted.qualificationEvent.id,
    });
    if (
      persisted.reportId !== rebuilt.reportId
      || persisted.evidenceFingerprint !== rebuilt.evidenceFingerprint
      || !isDeepStrictEqual(persisted.evaluation, rebuilt.evaluation)
      || !isDeepStrictEqual(persisted.report, rebuilt.report)
      || !isDeepStrictEqual(persisted.qualificationEvent, rebuilt.event)
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
    || value.trim() !== value
    || Buffer.byteLength(value, 'utf8') > MAX_CANONICAL_JSON_STRING_BYTES
  ) throw new TypeError(`Persisted qualification ${name} is invalid.`);
}

function assertCanonicalValue(value: unknown, name: string): void {
  try {
    canonicalStringifyJson(value);
  } catch (cause: unknown) {
    throw new TypeError(`Persisted qualification ${name} is invalid.`, { cause });
  }
}

const QUALIFICATION_PROJECTION_FIELDS = [
  'reportId',
  'sourceEventId',
  'sourceRawEventId',
  'evidenceFingerprint',
  'evaluation',
  'report',
  'qualificationEvent',
] as const;

interface PersistedSnapshotState {
  nodes: number;
  textBytes: number;
  readonly ancestors: WeakSet<object>;
}

function snapshotPersistedProjection(
  projection: CanonicalQualificationProjection,
): CanonicalQualificationProjection {
  const snapshot = snapshotPersistedValue(projection, 0, {
    nodes:0,
    textBytes:0,
    ancestors:new WeakSet(),
  });
  if (
    Array.isArray(snapshot)
    || QUALIFICATION_PROJECTION_FIELDS.some((field) => !Object.hasOwn(snapshot, field))
    || Object.keys(snapshot).length !== QUALIFICATION_PROJECTION_FIELDS.length
  ) throw invalidPersistedProjection();
  return snapshot;
}

function snapshotPersistedValue<T>(
  value: T,
  depth: number,
  state: PersistedSnapshotState,
): T {
  if (depth > MAX_CANONICAL_JSON_DEPTH || ++state.nodes > MAX_CANONICAL_JSON_NODES) {
    throw invalidPersistedProjection();
  }
  if (typeof value === 'string') {
    accountPersistedText(value, state);
    return value;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw invalidPersistedProjection();
    return value;
  }
  if (typeof value !== 'object' || isProxy(value)) throw invalidPersistedProjection();
  if (state.ancestors.has(value)) throw invalidPersistedProjection();
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) return snapshotPersistedArray(value, depth, state) as T;
    return snapshotPersistedObject(value, depth, state) as T;
  } finally {
    state.ancestors.delete(value);
  }
}

function snapshotPersistedArray(
  value: readonly unknown[],
  depth: number,
  state: PersistedSnapshotState,
): readonly unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw invalidPersistedProjection();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) throw invalidPersistedProjection();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined
    || !('value' in lengthDescriptor)
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || keys.length !== lengthDescriptor.value + 1
    || lengthDescriptor.value > MAX_CANONICAL_JSON_NODES - state.nodes
  ) throw invalidPersistedProjection();
  const result: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const key = String(index);
    accountPersistedText(key, state);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw invalidPersistedProjection();
    }
    result.push(snapshotPersistedValue(descriptor.value, depth + 1, state));
  }
  return Object.freeze(result);
}

function snapshotPersistedObject(
  value: object,
  depth: number,
  state: PersistedSnapshotState,
): Readonly<Record<string, unknown>> {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidPersistedProjection();
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key === 'symbol')
    || keys.length > MAX_CANONICAL_JSON_NODES - state.nodes
  ) throw invalidPersistedProjection();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = prototype === null
    ? Object.create(null) as Record<string, unknown>
    : {};
  for (const key of keys as string[]) {
    accountPersistedText(key, state);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw invalidPersistedProjection();
    }
    Object.defineProperty(result, key, {
      value:snapshotPersistedValue(descriptor.value, depth + 1, state),
      enumerable:true,
      configurable:true,
      writable:true,
    });
  }
  return Object.freeze(result);
}

function accountPersistedText(value: string, state: PersistedSnapshotState): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (
    bytes > MAX_CANONICAL_JSON_STRING_BYTES
    || state.textBytes + bytes > MAX_CANONICAL_JSON_TEXT_BYTES
  ) throw invalidPersistedProjection();
  state.textBytes += bytes;
}

function invalidPersistedProjection(): TypeError {
  return new TypeError('Persisted qualification projection contains unsafe data.');
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
