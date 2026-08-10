import {
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
    assertValidTimestampMs('evaluatedAtMs', input.evaluatedAtMs);
    const evidence = this.profile.rules.map((ruleDefinition) => evidenceFor(ruleDefinition, input));
    const scores = calculateScores(evidence, this.profile.dimensionMaximums);
    const evaluatedConditions = evaluateQualificationConditions(
      this.profile,
      input.calibrationFacts ?? noCalibrationFacts(),
      legacyBlockers(input.blockers),
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
      evaluatedAtMs: input.evaluatedAtMs,
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

function evidenceFor(ruleDefinition: QualificationRule, input: QualificationEvaluationInput): QualificationEvidence {
  const value = input.signals[ruleDefinition.signal];
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

function legacyBlockers(codes: readonly QualificationReasonCode[]): readonly QualificationReasonCode[] {
  return freeze([...codes]);
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

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) Object.freeze(value);
  return value;
}
