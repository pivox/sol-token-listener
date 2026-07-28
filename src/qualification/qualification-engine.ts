import {
  QUALIFICATION_DIMENSIONS,
  QUALIFICATION_SIGNAL_KEYS,
  type QualificationBlocker,
  type QualificationDimension,
  type QualificationEvaluationInput,
  type QualificationEvidence,
  type QualificationEvidenceStatus,
  type QualificationReport,
  type QualificationRule,
  type QualificationRuleSet,
  type QualificationScore,
  type QualificationScores,
} from '../domain/qualification.js';
import {
  QUALIFICATION_REASON_CODES,
  type QualificationReasonCode,
} from '../domain/qualification-reasons.js';
import { assertValidTimestampMs } from '../domain/timestamp.js';

const DIMENSION_MAXIMUMS: Readonly<Record<QualificationDimension, number>> = Object.freeze({
  preparation: 15,
  socialAuthenticity: 25,
  onchainHealth: 60,
});

export const defaultQualificationRuleSet = createDefaultQualificationRuleSet(60);

export function createDefaultQualificationRuleSet(minimumTotalScore: number): QualificationRuleSet {
  return freeze({
    id: 'pumpfun-v1-initial',
    version: 1,
    status: 'UNVALIDATED_RULE_SET',
    minimumTotalScore,
    rules: freeze([
    rule('imageValid', 'preparation', 15, true, 'Préparation visuelle du lancement valide.'),
    rule('socialCrossLinkConfirmed', 'socialAuthenticity', 25, true, 'Liens sociaux cohérents.'),
    rule('creatorHasNotSold', 'onchainHealth', 20, true, 'Aucune vente précoce du créateur.'),
    rule('reverseQuoteAvailable', 'onchainHealth', 20, false, 'Cotation inverse disponible.'),
    rule('externalBuyersObserved', 'onchainHealth', 20, false, 'Acheteurs externes observés.'),
    ]),
  });
}

export class QualificationConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'QualificationConfigurationError';
  }
}

export class QualificationEngine {
  public constructor(private readonly ruleSet: QualificationRuleSet) {
    validateRuleSet(ruleSet);
  }

  public evaluate(input: QualificationEvaluationInput): QualificationReport {
    assertValidTimestampMs('evaluatedAtMs', input.evaluatedAtMs);
    const evidence = this.ruleSet.rules.map((ruleDefinition) => evidenceFor(ruleDefinition, input));
    const scores = calculateScores(evidence);
    const blockers = createBlockers(input.blockers);
    const missingRequiredEvidence = evidence.some((item) => item.required && item.status !== 'SATISFIED');
    const verdict = blockers.length > 0
      ? 'REJECTED'
      : (missingRequiredEvidence || scores.total.score < this.ruleSet.minimumTotalScore)
        ? 'WATCHLISTED'
        : 'QUALIFIED';
    return freeze({
      ruleSet: freeze({
        id: this.ruleSet.id,
        version: this.ruleSet.version,
        status: this.ruleSet.status,
        minimumTotalScore: this.ruleSet.minimumTotalScore,
      }),
      scores,
      evidence: freeze(evidence),
      blockers: freeze(blockers),
      verdict,
      evaluatedAtMs: input.evaluatedAtMs,
    });
  }
}

function rule(
  signal: QualificationRule['signal'],
  dimension: QualificationDimension,
  weight: number,
  required: boolean,
  message: string,
): QualificationRule {
  return freeze({ signal, dimension, weight, required, message });
}

function validateRuleSet(ruleSet: QualificationRuleSet): void {
  if (!Number.isSafeInteger(ruleSet.version) || ruleSet.version <= 0) {
    throw new QualificationConfigurationError('ruleSet.version doit être un entier positif sûr.');
  }
  if (!Number.isSafeInteger(ruleSet.minimumTotalScore) || ruleSet.minimumTotalScore < 0 || ruleSet.minimumTotalScore > 100) {
    throw new QualificationConfigurationError('ruleSet.minimumTotalScore doit être entre 0 et 100.');
  }
  const seenSignals = new Set<string>();
  const dimensionWeights: Record<QualificationDimension, number> = {
    preparation: 0, socialAuthenticity: 0, onchainHealth: 0,
  };
  for (const item of ruleSet.rules) {
    if (!QUALIFICATION_SIGNAL_KEYS.includes(item.signal)) {
      throw new QualificationConfigurationError(`Signal de qualification inconnu: ${item.signal}.`);
    }
    if (!QUALIFICATION_DIMENSIONS.includes(item.dimension)) {
      throw new QualificationConfigurationError(`Dimension de qualification inconnue: ${item.dimension}.`);
    }
    if (seenSignals.has(item.signal)) {
      throw new QualificationConfigurationError(`Signal de qualification dupliqué: ${item.signal}.`);
    }
    if (!Number.isSafeInteger(item.weight) || item.weight < 0) {
      throw new QualificationConfigurationError(`Poids invalide pour ${item.signal}.`);
    }
    seenSignals.add(item.signal);
    dimensionWeights[item.dimension] += item.weight;
  }
  for (const dimension of QUALIFICATION_DIMENSIONS) {
    if (dimensionWeights[dimension] !== DIMENSION_MAXIMUMS[dimension]) {
      throw new QualificationConfigurationError(`Poids total invalide pour ${dimension}.`);
    }
  }
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

function calculateScores(evidence: readonly QualificationEvidence[]): QualificationScores {
  const scores: Record<QualificationDimension, number> = {
    preparation: 0, socialAuthenticity: 0, onchainHealth: 0,
  };
  for (const item of evidence) {
    if (item.status === 'SATISFIED') scores[item.dimension] += item.weight;
  }
  const preparation = score(scores.preparation, DIMENSION_MAXIMUMS.preparation);
  const socialAuthenticity = score(scores.socialAuthenticity, DIMENSION_MAXIMUMS.socialAuthenticity);
  const onchainHealth = score(scores.onchainHealth, DIMENSION_MAXIMUMS.onchainHealth);
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
  return uniqueCodes.map((code) => freeze({ code, message: blockerMessage(code) }));
}

function blockerMessage(code: QualificationReasonCode): string {
  return `Condition éliminatoire active: ${code}.`;
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) Object.freeze(value);
  return value;
}
