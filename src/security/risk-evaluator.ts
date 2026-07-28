import type { RiskCheck, RiskVerdict } from './token-risk.types.js';

export interface RiskEvaluationPolicy {
  readonly minScore: number;
  readonly allowUnknownReviews: boolean;
  readonly allowUnknownMinScore: number;
}

export interface RiskEvaluation {
  readonly score: number;
  readonly verdict: RiskVerdict;
  readonly reasons: readonly string[];
}

export function evaluateRisk(
  checks: readonly RiskCheck[],
  policy: RiskEvaluationPolicy,
): RiskEvaluation {
  const criticalFailures = checks.filter((check) => check.critical && check.status === 'FAIL');
  const unknownChecks = checks.filter((check) => check.status === 'UNKNOWN');
  const penalty = checks.reduce((total, check) => total + Math.max(0, Math.trunc(check.penalty)), 0);
  const score = Math.max(0, 100 - penalty);
  const reasons: string[] = [];

  if (criticalFailures.length > 0) {
    reasons.push(...criticalFailures.map((check) => check.code));
    return { score, verdict: 'BLOCK', reasons };
  }
  if (score < policy.minScore) {
    reasons.push('SCORE_BELOW_MINIMUM');
    return { score, verdict: 'BLOCK', reasons };
  }
  if (unknownChecks.length > 0 && (!policy.allowUnknownReviews || score < policy.allowUnknownMinScore)) {
    reasons.push(...unknownChecks.map((check) => check.code));
    return { score, verdict: 'REVIEW', reasons };
  }
  return { score, verdict: 'ALLOW', reasons };
}
