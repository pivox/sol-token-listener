import { createHash } from 'node:crypto';
import {
  createFailedSocialCollection,
  createSocialCollection,
  socialHttpObservationId,
  socialLinkId,
  socialMetadataSnapshotId,
  socialVerificationEvidenceId,
  type SocialCollectionStatus,
  type SocialEvidenceOutcome,
  type SocialEvidenceType,
  type SocialHttpObservationV1,
  type SocialLinkKind,
  type SocialLinkV1,
  type SocialVerificationEvidenceV1,
} from '../domain/social-evidence.js';
import type {
  PublicTokenMetadata,
  TokenMetadataSnapshot,
} from '../domain/pumpfun-observation.js';
import type { PublicHttpClient, PublicHttpResult } from '../ports/public-http-client.js';
import type { SocialVerificationProvider } from '../ports/social-verification-provider.js';
import { inspectPublicContent, type PublicContentFacts } from './public-content-evidence.js';
import {
  normalizeSocialUrl,
  sameRegistrableDomain,
  sanitizeMetadataForPersistence,
  type SocialUrlNormalization,
} from './social-url-normalizer.js';

const ACCEPTED_CONTENT_TYPES = Object.freeze(['text/html', 'text/plain'] as const);
const DECLARATIONS = Object.freeze([
  ['WEBSITE', 'websiteUrl'],
  ['X', 'twitterUrl'],
  ['TELEGRAM', 'telegramUrl'],
] as const);

interface NormalizedDeclaration {
  readonly kind: SocialLinkKind;
  readonly normalization: SocialUrlNormalization;
}

interface InspectedObservation {
  readonly observation: SocialHttpObservationV1;
  readonly facts: PublicContentFacts | null;
  readonly unavailable: boolean;
  readonly retryable: boolean;
}

export class PublicSocialVerificationProvider implements SocialVerificationProvider {
  public constructor(private readonly http: PublicHttpClient) {}

  public readonly collect: SocialVerificationProvider['collect'] = async (input) => {
    if (input.metadataSnapshot.mint !== input.mint) {
      throw new TypeError('Social provider metadata mint does not match its launch.');
    }
    if (input.metadataSnapshot.resolution.status === 'FAILED') {
      return Object.freeze({
        metadataSnapshot: input.metadataSnapshot,
        collection: createFailedSocialCollection(input),
        retryable: false,
      });
    }

    const rawMetadata = input.metadataSnapshot.resolution.metadata;
    const declarations = normalizeDeclarations(rawMetadata);
    const metadata = sanitizeMetadataForPersistence(rawMetadata, declarations.map((item) => ({
      kind: item.kind,
      syntaxStatus: item.normalization.status,
      canonicalUrl: item.normalization.status === 'VALID'
        ? item.normalization.canonicalUrl : null,
    })));
    const metadataSnapshot = safeMetadataSnapshot(input.metadataSnapshot, metadata);
    const metadataSnapshotId = socialMetadataSnapshotId({
      sourceLaunchEventId: input.sourceLaunchEventId,
      snapshot: metadataSnapshot,
    });
    const links = declarations.map((item) => createLink(
      input.mint,
      metadataSnapshotId,
      item,
      metadataSnapshot.fetchedAtMs,
    ));
    const evidence: SocialVerificationEvidenceV1[] = links.map((link) => evidenceItem({
      mint: input.mint,
      link,
      observation: null,
      type: link.syntaxStatus === 'VALID' ? 'URL_SYNTAX_VALID' : 'URL_SYNTAX_INVALID',
      outcome: link.syntaxStatus === 'VALID' ? 'CONFIRMED' : 'REJECTED',
      relatedKind: null,
      reasonCode: link.syntaxStatus === 'VALID' ? 'CANONICAL_URL_ACCEPTED' : link.invalidReason ?? 'URL_INVALID',
      observedAtMs: metadataSnapshot.fetchedAtMs,
    }));

    const fetches = new Map<string, Promise<PublicHttpResult>>();
    for (const link of links) {
      if (link.canonicalUrl !== null && !fetches.has(link.canonicalUrl)) {
        fetches.set(link.canonicalUrl, this.http.get(link.canonicalUrl, ACCEPTED_CONTENT_TYPES));
      }
    }

    const inspectedByLink = new Map<string, InspectedObservation>();
    for (const link of links) {
      if (link.canonicalUrl === null) continue;
      const pending = fetches.get(link.canonicalUrl);
      if (pending === undefined) throw new Error('Canonical social fetch is missing.');
      const inspected = inspectObservation(link, await pending, input.mint, metadataSnapshot.fetchedAtMs);
      inspectedByLink.set(link.id, inspected);
      evidence.push(...observationEvidence(input.mint, link, inspected, links, metadataSnapshot.fetchedAtMs));
    }

    const observations = Object.freeze([...inspectedByLink.values()].map((item) => item.observation));
    const retryable = [...inspectedByLink.values()].some((item) => item.retryable);
    if (retryable) {
      const unavailableMetadataSnapshot = safeMetadataSnapshot(
        metadataSnapshot,
        sanitizeMetadataForPersistence(metadata, Object.freeze([])),
      );
      const unavailableMetadataSnapshotId = socialMetadataSnapshotId({
        sourceLaunchEventId: input.sourceLaunchEventId,
        snapshot: unavailableMetadataSnapshot,
      });
      return Object.freeze({
        metadataSnapshot: unavailableMetadataSnapshot,
        collection: retryableFailureCollection(
          input.mint,
          input.sourceLaunchEventId,
          unavailableMetadataSnapshotId,
          unavailableMetadataSnapshot.fetchedAtMs,
        ),
        retryable: true,
      });
    }
    const collection = createSocialCollection(Object.freeze({
      mint: input.mint,
      sourceLaunchEventId: input.sourceLaunchEventId,
      metadataSnapshotId,
      status: collectionStatus(links, inspectedByLink),
      links: Object.freeze(links),
      observations,
      evidence: Object.freeze(evidence),
      observedAtMs: metadataSnapshot.fetchedAtMs,
    }));
    return Object.freeze({ metadataSnapshot, collection, retryable });
  };
}

function retryableFailureCollection(
  mint: string,
  sourceLaunchEventId: string,
  metadataSnapshotId: string,
  observedAtMs: number,
): ReturnType<typeof createSocialCollection> {
  const evidenceBase = Object.freeze({
    mint,
    linkId: null,
    observationId: null,
    type: 'VERIFICATION_UNKNOWN' as const,
    outcome: 'UNKNOWN' as const,
    subjectKind: null,
    relatedKind: null,
    reasonCode: 'TRANSIENT_PUBLIC_SOURCE_UNAVAILABLE',
    observedAtMs,
  });
  const evidence = Object.freeze({
    id: socialVerificationEvidenceId(evidenceBase),
    ...evidenceBase,
  });
  return createSocialCollection(Object.freeze({
    mint,
    sourceLaunchEventId,
    metadataSnapshotId,
    status: 'FAILED' as const,
    links: Object.freeze([]),
    observations: Object.freeze([]),
    evidence: Object.freeze([evidence]),
    observedAtMs,
  }));
}

function normalizeDeclarations(metadata: PublicTokenMetadata): readonly NormalizedDeclaration[] {
  const result: NormalizedDeclaration[] = [];
  for (const [kind, field] of DECLARATIONS) {
    const declared = metadata[field];
    if (declared === null) continue;
    result.push(Object.freeze({ kind, normalization: normalizeSocialUrl(kind, declared) }));
  }
  return Object.freeze(result);
}

function safeMetadataSnapshot(
  source: TokenMetadataSnapshot,
  metadata: PublicTokenMetadata,
): TokenMetadataSnapshot {
  return Object.freeze({
    mint: source.mint,
    uri: source.uri,
    resolution: Object.freeze({ status: 'RESOLVED' as const, metadata }),
    fetchedAtMs: source.fetchedAtMs,
    payloadVersion: source.payloadVersion,
  });
}

function createLink(
  mint: string,
  metadataSnapshotId: string,
  declaration: NormalizedDeclaration,
  observedAtMs: number,
): SocialLinkV1 {
  const normalized = declaration.normalization;
  const base = Object.freeze({
    mint,
    metadataSnapshotId,
    kind: declaration.kind,
    declaredValueSha256: normalized.declaredValueSha256,
    syntaxStatus: normalized.status,
    canonicalUrl: normalized.status === 'VALID' ? normalized.canonicalUrl : null,
    invalidReason: normalized.status === 'INVALID' ? normalized.reason : null,
    observedAtMs,
  });
  return Object.freeze({ id: socialLinkId(base), ...base });
}

function inspectObservation(
  link: SocialLinkV1,
  response: PublicHttpResult,
  mint: string,
  observedAtMs: number,
): InspectedObservation {
  if (response.status === 'FAILED') {
    const base = Object.freeze({
      linkId: link.id,
      outcome: 'FAILED' as const,
      finalCanonicalUrl: null,
      httpStatus: null,
      redirectCount: 0,
      contentSha256: null,
      failureReason: response.reason,
      observedAtMs,
    });
    return Object.freeze({
      observation: Object.freeze({ id: socialHttpObservationId(base), ...base }),
      facts: null,
      unavailable: true,
      retryable: response.retryable,
    });
  }
  const inspectableType = response.contentType === 'text/html' || response.contentType === 'text/plain';
  let facts: PublicContentFacts | null = null;
  if (inspectableType) {
    try {
      facts = inspectPublicContent({ contentType: response.contentType, body: response.body, mint });
    } catch {
      facts = null;
    }
  }
  const unavailable = facts === null || looksUnavailable(response.body);
  const base = Object.freeze({
    linkId: link.id,
    outcome: 'SUCCEEDED' as const,
    finalCanonicalUrl: response.finalUrl,
    httpStatus: response.httpStatus,
    redirectCount: response.redirectCount,
    contentSha256: facts?.contentSha256
      ?? createHash('sha256').update(response.body).digest('hex'),
    failureReason: null,
    observedAtMs,
  });
  return Object.freeze({
    observation: Object.freeze({ id: socialHttpObservationId(base), ...base }),
    facts,
    unavailable,
    retryable: false,
  });
}

function observationEvidence(
  mint: string,
  link: SocialLinkV1,
  inspected: InspectedObservation,
  links: readonly SocialLinkV1[],
  observedAtMs: number,
): readonly SocialVerificationEvidenceV1[] {
  const result: SocialVerificationEvidenceV1[] = [];
  const reachable = inspected.observation.outcome === 'SUCCEEDED';
  result.push(evidenceItem({
    mint, link, observation: inspected.observation, type: 'URL_REACHABLE',
    outcome: reachable ? 'CONFIRMED' : inspected.retryable ? 'UNKNOWN' : 'REJECTED',
    relatedKind: null,
    reasonCode: reachable ? 'HTTP_2XX' : inspected.observation.failureReason ?? 'HTTP_UNAVAILABLE',
    observedAtMs,
  }));

  if (inspected.unavailable) {
    result.push(evidenceItem({
      mint, link, observation: inspected.observation, type: 'CONTENT_UNAVAILABLE',
      outcome: 'UNKNOWN', relatedKind: null,
      reasonCode: inspected.observation.failureReason ?? 'CONTENT_UNAVAILABLE', observedAtMs,
    }));
  }
  result.push(evidenceItem({
    mint, link, observation: inspected.observation, type: 'MINT_PUBLISHED',
    outcome: inspected.unavailable ? 'UNKNOWN'
      : inspected.facts?.exactMintPublished === true ? 'CONFIRMED' : 'REJECTED',
    relatedKind: null,
    reasonCode: inspected.unavailable ? 'CONTENT_UNAVAILABLE'
      : inspected.facts?.exactMintPublished === true ? 'EXACT_MINT_FOUND' : 'EXACT_MINT_NOT_FOUND',
    observedAtMs,
  }));

  for (const target of links) {
    if (target.id === link.id || target.canonicalUrl === null) continue;
    const confirmed = inspected.facts?.canonicalLinks.includes(target.canonicalUrl) === true;
    result.push(evidenceItem({
      mint, link, observation: inspected.observation, type: 'CROSS_LINK_CONFIRMED',
      outcome: inspected.unavailable ? 'UNKNOWN' : confirmed ? 'CONFIRMED' : 'REJECTED',
      relatedKind: target.kind,
      reasonCode: inspected.unavailable ? 'CONTENT_UNAVAILABLE'
        : confirmed ? 'CANONICAL_LINK_FOUND' : 'CANONICAL_LINK_NOT_FOUND',
      observedAtMs,
    }));
  }

  if (link.kind === 'X' || link.kind === 'TELEGRAM') {
    result.push(evidenceItem({
      mint, link, observation: inspected.observation, type: 'ACCOUNT_TOO_RECENT',
      outcome: 'UNKNOWN', relatedKind: null,
      reasonCode: 'AUTHORITATIVE_SOURCE_UNAVAILABLE', observedAtMs,
    }));
  }
  if (
    link.kind === 'WEBSITE'
    && link.canonicalUrl !== null
    && inspected.observation.finalCanonicalUrl !== null
    && !sameRegistrableDomain(link.canonicalUrl, inspected.observation.finalCanonicalUrl)
  ) {
    result.push(evidenceItem({
      mint, link, observation: inspected.observation, type: 'DOMAIN_MISMATCH',
      outcome: 'REJECTED', relatedKind: null,
      reasonCode: 'CROSS_DOMAIN_REDIRECT', observedAtMs,
    }));
  }
  return Object.freeze(result);
}

function evidenceItem(input: Readonly<{
  mint: string;
  link: SocialLinkV1;
  observation: SocialHttpObservationV1 | null;
  type: SocialEvidenceType;
  outcome: SocialEvidenceOutcome;
  relatedKind: SocialLinkKind | null;
  reasonCode: string;
  observedAtMs: number;
}>): SocialVerificationEvidenceV1 {
  const base = Object.freeze({
    mint: input.mint,
    linkId: input.link.id,
    observationId: input.observation?.id ?? null,
    type: input.type,
    outcome: input.outcome,
    subjectKind: input.link.kind,
    relatedKind: input.relatedKind,
    reasonCode: input.reasonCode,
    observedAtMs: input.observedAtMs,
  });
  return Object.freeze({ id: socialVerificationEvidenceId(base), ...base });
}

function collectionStatus(
  links: readonly SocialLinkV1[],
  inspected: ReadonlyMap<string, InspectedObservation>,
): SocialCollectionStatus {
  for (const link of links) {
    if (link.syntaxStatus === 'VALID' && inspected.get(link.id)?.unavailable !== false) return 'PARTIAL';
  }
  return 'COMPLETE';
}

function looksUnavailable(body: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body).toLowerCase();
  } catch {
    return true;
  }
  return text.includes('enable javascript')
    || text.includes('public profile unavailable')
    || text.includes('log in to continue')
    || text.includes('robots denied');
}
