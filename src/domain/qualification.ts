import type { QualificationReasonCode } from './qualification-reasons.js';

export const QUALIFICATION_DIMENSIONS = [
  'preparation',
  'socialAuthenticity',
  'onchainHealth',
] as const;

export type QualificationDimension = (typeof QUALIFICATION_DIMENSIONS)[number];
export type QualificationVerdict = 'QUALIFIED' | 'WATCHLISTED' | 'REJECTED';
export type QualificationEvidenceStatus = 'SATISFIED' | 'NOT_SATISFIED' | 'UNKNOWN';

export const QUALIFICATION_SIGNAL_KEYS = [
  'imageValid',
  'descriptionAvailable',
  'linksReachable',
  'socialCrossLinkConfirmed',
  'creatorHasNotSold',
  'reverseQuoteAvailable',
  'externalBuyersObserved',
] as const;

export type QualificationSignalKey = (typeof QUALIFICATION_SIGNAL_KEYS)[number];

export interface QualificationRule {
  readonly signal: QualificationSignalKey;
  readonly dimension: QualificationDimension;
  readonly weight: number;
  readonly required: boolean;
  readonly message: string;
}

export interface QualificationRuleSet {
  readonly id: string;
  readonly version: number;
  readonly status: 'UNVALIDATED_RULE_SET';
  readonly minimumTotalScore: number;
  readonly rules: readonly QualificationRule[];
}

export interface QualificationEvaluationInput {
  readonly evaluatedAtMs: number;
  readonly signals: Readonly<Partial<Record<QualificationSignalKey, boolean>>>;
  readonly blockers: readonly QualificationReasonCode[];
}

export interface QualificationEvidence {
  readonly signal: QualificationSignalKey;
  readonly dimension: QualificationDimension;
  readonly status: QualificationEvidenceStatus;
  readonly required: boolean;
  readonly weight: number;
  readonly message: string;
}

export interface QualificationScore {
  readonly score: number;
  readonly maximum: number;
}

export interface QualificationScores {
  readonly preparation: QualificationScore;
  readonly socialAuthenticity: QualificationScore;
  readonly onchainHealth: QualificationScore;
  readonly total: QualificationScore;
}

export interface QualificationBlocker {
  readonly code: QualificationReasonCode;
  readonly message: string;
}

export interface QualificationReport {
  readonly ruleSet: Pick<QualificationRuleSet, 'id' | 'version' | 'status' | 'minimumTotalScore'>;
  readonly scores: QualificationScores;
  readonly evidence: readonly QualificationEvidence[];
  readonly blockers: readonly QualificationBlocker[];
  readonly verdict: QualificationVerdict;
  readonly evaluatedAtMs: number;
}
