import type {
  QualificationSignalKey,
  QualificationUpstreamCondition,
} from '../domain/qualification.js';
import type {
  SocialEvidenceCollectionV1,
  SocialLinkKind,
  SocialVerificationEvidenceV1,
} from '../domain/social-evidence.js';

type SocialSignal = Extract<
  QualificationSignalKey,
  'linksReachable' | 'socialCrossLinkConfirmed'
>;

export interface SocialQualificationObservations {
  readonly signals: Readonly<Partial<Record<SocialSignal, boolean>>>;
  readonly upstreamConditions: readonly QualificationUpstreamCondition[];
}

export function toSocialQualificationObservations(
  collection: SocialEvidenceCollectionV1,
): SocialQualificationObservations {
  const signals: Partial<Record<SocialSignal, boolean>> = {};
  const reachability = collection.evidence.filter((item) => item.type === 'URL_REACHABLE');
  const reachable = conclusiveAggregate(reachability);
  if (reachable !== null) signals.linksReachable = reachable;

  const crossLinked = crossLinkAggregate(
    collection.evidence.filter((item) => item.type === 'CROSS_LINK_CONFIRMED'),
  );
  if (crossLinked !== null) signals.socialCrossLinkConfirmed = crossLinked;

  const upstreamConditions: QualificationUpstreamCondition[] = [];
  if (collection.evidence.some((item) =>
    item.type === 'MINT_PUBLISHED' && item.outcome === 'CONFIRMED')) {
    upstreamConditions.push(Object.freeze({
      code: 'MINT_SOCIAL_MISMATCH' as const,
      triggered: false,
    }));
  }
  if (collection.status === 'FAILED') {
    upstreamConditions.push(Object.freeze({
      code: 'METADATA_FETCH_FAILED' as const,
      triggered: true,
    }));
  }
  return Object.freeze({
    signals: Object.freeze(signals),
    upstreamConditions: Object.freeze(upstreamConditions),
  });
}

function conclusiveAggregate(evidence: readonly SocialVerificationEvidenceV1[]): boolean | null {
  if (evidence.length === 0) return null;
  if (evidence.some((item) => item.outcome === 'REJECTED')) return false;
  if (evidence.every((item) => item.outcome === 'CONFIRMED')) return true;
  return null;
}

function crossLinkAggregate(evidence: readonly SocialVerificationEvidenceV1[]): boolean | null {
  const directions = new Map<string, SocialVerificationEvidenceV1>();
  for (const item of evidence) {
    if (item.subjectKind === null || item.relatedKind === null) continue;
    directions.set(directionKey(item.subjectKind, item.relatedKind), item);
  }
  for (const item of directions.values()) {
    if (item.subjectKind === null || item.relatedKind === null) continue;
    const reverse = directions.get(directionKey(item.relatedKind, item.subjectKind));
    if (item.outcome === 'CONFIRMED' && reverse?.outcome === 'CONFIRMED') return true;
  }
  if (directions.size === 0 || [...directions.values()].some((item) => item.outcome === 'UNKNOWN')) {
    return null;
  }
  return [...directions.values()].some((item) => item.outcome === 'REJECTED') ? false : null;
}

function directionKey(subject: SocialLinkKind, related: SocialLinkKind): string {
  return `${subject}:${related}`;
}
