import {
  QUALIFICATION_SIGNAL_KEYS,
  assertValidQualificationFacts,
  type EffectiveQualificationProfile,
  type QualificationBlocker,
  type QualificationCalibrationFacts,
  type QualificationDimension,
  type QualificationEvaluationInput,
  type QualificationEvidence,
  type QualificationEvidenceStatus,
  type QualificationReport,
  type QualificationRule,
  type QualificationScore,
  type QualificationScores,
} from '../domain/qualification.js';
import { QUALIFICATION_REASON_CODES, type QualificationReasonCode } from '../domain/qualification-reasons.js';
import { assertValidTimestampMs } from '../domain/timestamp.js';
import { isProxy } from 'node:util/types';
import type { AppConfig } from '../config/env.js';
import {
  assertValidEffectiveQualificationProfile,
  loadQualificationProfile,
} from './qualification-profile.js';
import { evaluateQualificationConditions } from './qualification-policy-evaluator.js';

export const defaultQualificationRuleSet = createDefaultQualificationRuleSet(60);

export function createDefaultQualificationRuleSet(minimumTotalScore: number): EffectiveQualificationProfile {
  return loadQualificationProfile({ profilePath: null, minimumScoreOverride: minimumTotalScore });
}

export function createQualificationEngine(
  config: Pick<AppConfig, 'qualificationProfilePath' | 'qualificationMinimumScore'>,
): QualificationEngine {
  return new QualificationEngine(loadQualificationProfile({
    profilePath: config.qualificationProfilePath,
    minimumScoreOverride: config.qualificationMinimumScore,
  }));
}

export class QualificationConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'QualificationConfigurationError';
  }
}

export type QualificationProfileSummary = Readonly<{
  id: string;
  version: number;
  status: 'UNVALIDATED_RULE_SET';
  fingerprint: string;
  minimumTotalScore: number;
}>;

export class QualificationEngine {
  private readonly profile: EffectiveQualificationProfile;
  private readonly summary: QualificationProfileSummary;

  public constructor(profile: EffectiveQualificationProfile) {
    assertValidEffectiveQualificationProfile(profile);
    this.profile = snapshotProfile(profile);
    this.summary = freeze({
      id: this.profile.id,
      version: this.profile.version,
      status: this.profile.status,
      fingerprint: this.profile.fingerprint,
      minimumTotalScore: this.profile.minimumTotalScore,
    });
  }

  public get minimumTotalScore(): number {
    return this.profile.minimumTotalScore;
  }

  public get profileSummary(): QualificationProfileSummary {
    return this.summary;
  }

  public evaluate(input: QualificationEvaluationInput): QualificationReport {
    const snapshot = snapshotEvaluationInput(input);
    assertValidTimestampMs('evaluatedAtMs', snapshot.evaluatedAtMs);
    const evidence = this.profile.rules.map((ruleDefinition) => evidenceFor(ruleDefinition, snapshot.signals));
    const scores = calculateScores(evidence, this.profile.dimensionMaximums);
    const evaluatedConditions = evaluateQualificationConditions(
      this.profile,
      snapshot.calibrationFacts ?? noCalibrationFacts(),
      snapshot.blockers,
    );
    const blockers = createBlockers(evaluatedConditions.blockers);
    const missingRequiredEvidence = evidence.some((item) => item.required && item.status !== 'SATISFIED');
    const verdict = blockers.length > 0
      ? 'REJECTED'
      : (missingRequiredEvidence || scores.total.score < this.profile.minimumTotalScore)
        ? 'WATCHLISTED'
        : 'QUALIFIED';
    return freeze({
      ruleSet: freeze({
        id: this.profile.id,
        version: this.profile.version,
        status: this.profile.status,
        fingerprint: this.profile.fingerprint,
        minimumTotalScore: this.profile.minimumTotalScore,
      }),
      scores,
      evidence: freeze(evidence),
      conditions: evaluatedConditions.conditions,
      blockers: freeze(blockers),
      verdict,
      evaluatedAtMs: snapshot.evaluatedAtMs,
    });
  }
}

function snapshotProfile(profile: EffectiveQualificationProfile): EffectiveQualificationProfile {
  return freeze({
    schemaVersion: profile.schemaVersion,
    fingerprint: profile.fingerprint,
    id: profile.id,
    version: profile.version,
    status: profile.status,
    minimumTotalScore: profile.minimumTotalScore,
    dimensionMaximums: freeze({ ...profile.dimensionMaximums }),
    rules: freeze(profile.rules.map((item) => freeze({ ...item }))),
    conditionPolicies: freeze(profile.conditionPolicies.map((item) => freeze({ ...item }))),
  });
}

function evidenceFor(
  ruleDefinition: QualificationRule,
  signals: Readonly<Partial<Record<QualificationRule['signal'], boolean>>>,
): QualificationEvidence {
  const value = signals[ruleDefinition.signal];
  const status: QualificationEvidenceStatus = value === true
    ? 'SATISFIED'
    : value === false
      ? 'NOT_SATISFIED'
      : 'UNKNOWN';
  return freeze({
    signal: ruleDefinition.signal,
    dimension: ruleDefinition.dimension,
    status,
    required: ruleDefinition.required,
    weight: ruleDefinition.weight,
    message: ruleDefinition.message,
  });
}

function calculateScores(
  evidence: readonly QualificationEvidence[],
  maximums: Readonly<Record<QualificationDimension, number>>,
): QualificationScores {
  const scores: Record<QualificationDimension, number> = {
    preparation: 0, socialAuthenticity: 0, onchainHealth: 0,
  };
  for (const item of evidence) {
    if (item.status === 'SATISFIED') scores[item.dimension] += item.weight;
  }
  const preparation = score(scores.preparation, maximums.preparation);
  const socialAuthenticity = score(scores.socialAuthenticity, maximums.socialAuthenticity);
  const onchainHealth = score(scores.onchainHealth, maximums.onchainHealth);
  return freeze({
    preparation,
    socialAuthenticity,
    onchainHealth,
    total: score(preparation.score + socialAuthenticity.score + onchainHealth.score, 100),
  });
}

function score(value: number, maximum: number): QualificationScore {
  return freeze({ score: value, maximum });
}

function createBlockers(codes: readonly QualificationReasonCode[]): readonly QualificationBlocker[] {
  const uniqueCodes = [...new Set(codes)];
  for (const code of uniqueCodes) {
    if (!QUALIFICATION_REASON_CODES.includes(code)) {
      throw new QualificationConfigurationError(`Reason code de qualification inconnu: ${code}.`);
    }
  }
  return uniqueCodes.map((code) => freeze({ code, message: `Condition éliminatoire active: ${code}.` }));
}

function noCalibrationFacts(): QualificationCalibrationFacts {
  return EMPTY_CALIBRATION_FACTS;
}

const EMPTY_CALIBRATION_FACTS: QualificationCalibrationFacts = freeze({
  top1HolderBps: null,
  top5HoldersBps: null,
  top10HoldersBps: null,
  maximumRelatedClusterBps: null,
  maximumSharedFunderCount: null,
  buySimulationSucceeded: null,
  sellQuoteAvailable: null,
  roundTripLossBps: null,
  upstreamConditions: freeze([]),
});

type QualificationInputSnapshot = Readonly<{
  evaluatedAtMs: number;
  signals: Readonly<Partial<Record<QualificationRule['signal'], boolean>>>;
  blockers: readonly QualificationReasonCode[];
  calibrationFacts: QualificationCalibrationFacts | null;
}>;

const INPUT_FIELDS = ['evaluatedAtMs', 'signals', 'blockers', 'calibrationFacts'] as const;
const SIGNAL_KEY_SET: ReadonlySet<string> = new Set(QUALIFICATION_SIGNAL_KEYS);
const REASON_CODE_SET: ReadonlySet<string> = new Set(QUALIFICATION_REASON_CODES);

function snapshotEvaluationInput(input: QualificationEvaluationInput): QualificationInputSnapshot {
  const fields = exactDataObject(input, INPUT_FIELDS, 'Qualification evaluation input');
  const evaluatedAtMs = fields.evaluatedAtMs;
  if (typeof evaluatedAtMs !== 'number') throw new TypeError('Qualification evaluatedAtMs must be a number.');
  const signals = snapshotSignals(fields.signals);
  const blockers = snapshotBlockers(fields.blockers);
  const calibrationFacts = snapshotCalibrationFacts(fields.calibrationFacts);
  return freeze({ evaluatedAtMs, signals, blockers, calibrationFacts });
}

function snapshotSignals(value: unknown): Readonly<Partial<Record<QualificationRule['signal'], boolean>>> {
  const fields = dataObjectFields(value, 'Qualification signals');
  const result = Object.create(null) as Partial<Record<QualificationRule['signal'], boolean>>;
  for (const [key, signal] of Object.entries(fields)) {
    if (!SIGNAL_KEY_SET.has(key) || typeof signal !== 'boolean') {
      throw new TypeError('Qualification signals must contain known boolean values.');
    }
    result[key as QualificationRule['signal']] = signal;
  }
  return freeze(result);
}

function snapshotBlockers(value: unknown): readonly QualificationReasonCode[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('Qualification blockers must be a standard array.');
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError('Qualification blockers must not contain symbols.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor) || typeof lengthDescriptor.value !== 'number' || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > QUALIFICATION_REASON_CODES.length) {
    throw new TypeError('Qualification blockers must be bounded.');
  }
  const length = lengthDescriptor.value;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== length + 1) throw new TypeError('Qualification blockers must be dense.');
  const blockers: QualificationReasonCode[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'string' || !REASON_CODE_SET.has(descriptor.value)) {
      throw new TypeError('Qualification blocker is invalid.');
    }
    blockers.push(descriptor.value as QualificationReasonCode);
  }
  return freeze(blockers);
}

function snapshotCalibrationFacts(value: unknown): QualificationCalibrationFacts | null {
  if (value === null) return null;
  assertValidQualificationFacts(value as QualificationCalibrationFacts);
  return value as QualificationCalibrationFacts;
}

function exactDataObject(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
  const entries = dataObjectFields(value, name);
  const keys = Object.keys(entries);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(entries, field))) {
    throw new TypeError(`${name} must contain exactly the required fields.`);
  }
  return entries;
}

function dataObjectFields(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${name} must be a plain object.`);
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError(`${name} must not contain symbols.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(value);
  const fields = Object.create(null) as Record<string, unknown>;
  for (const key of names) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${name} must contain enumerable data fields.`);
    }
    fields[key] = descriptor.value;
  }
  return fields;
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) Object.freeze(value);
  return value;
}
