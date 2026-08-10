import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOCIAL_COLLECTION_STATUSES,
  SOCIAL_EVIDENCE_OUTCOMES,
  SOCIAL_EVIDENCE_TYPES,
  SOCIAL_LINK_KINDS,
  createFailedSocialCollection,
  createSocialCollection,
  socialCollectionId,
  socialHttpObservationId,
  socialLinkId,
  socialMetadataSnapshotId,
  socialVerificationEvidenceId,
  type SocialEvidenceCollectionInputV1,
  type SocialHttpObservationV1,
  type SocialLinkV1,
  type SocialVerificationEvidenceV1,
} from '../src/domain/social-evidence.js';
import type { TokenMetadataSnapshot } from '../src/domain/pumpfun-observation.js';

const MINT = 'So11111111111111111111111111111111111111112';
const SOURCE_EVENT_ID = 'event-launch';
const OBSERVED_AT_MS = 1_786_363_200_000;
const WEBSITE = 'https://project.example/';
const WEBSITE_HASH = 'a'.repeat(64);
const CONTENT_HASH = 'b'.repeat(64);

void test('publishes stable social enums', () => {
  assert.deepEqual(SOCIAL_LINK_KINDS, ['WEBSITE', 'X', 'TELEGRAM']);
  assert.deepEqual(SOCIAL_COLLECTION_STATUSES, ['COMPLETE', 'PARTIAL', 'FAILED']);
  assert.deepEqual(SOCIAL_EVIDENCE_OUTCOMES, ['CONFIRMED', 'REJECTED', 'UNKNOWN']);
  assert.deepEqual(SOCIAL_EVIDENCE_TYPES, [
    'URL_SYNTAX_VALID',
    'URL_SYNTAX_INVALID',
    'URL_REACHABLE',
    'CROSS_LINK_CONFIRMED',
    'MINT_PUBLISHED',
    'ACCOUNT_TOO_RECENT',
    'DOMAIN_MISMATCH',
    'CONTENT_UNAVAILABLE',
    'VERIFICATION_UNKNOWN',
  ]);
  assert.equal(Object.isFrozen(SOCIAL_LINK_KINDS), true);
  assert.equal(Object.isFrozen(SOCIAL_EVIDENCE_TYPES), true);
});

void test('creates a deterministic deeply frozen canonical collection', () => {
  const firstInput = validCollectionInput();
  const replayInput = validCollectionInput();
  const first = createSocialCollection(firstInput);
  const replay = createSocialCollection(replayInput);

  assert.deepEqual(replay, first);
  assert.equal(first.id, socialCollectionId(firstInput));
  assert.match(first.id, /^social_collection_[0-9a-f]{64}$/u);
  assert.match(first.inputFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(first.payloadVersion, 1);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.links), true);
  assert.equal(Object.isFrozen(first.links[0]), true);
  assert.equal(Object.isFrozen(first.observations), true);
  assert.equal(Object.isFrozen(first.evidence), true);
});

void test('changes deterministic identities only when immutable evidence changes', () => {
  const original = validCollectionInput();
  const changed = collectionInput({
    ...original,
    evidence: Object.freeze([
      evidence({ outcome: 'REJECTED', reasonCode: 'URL_NOT_REACHABLE' }),
    ]),
  });
  const originalEvidence = original.evidence[0];
  const changedEvidence = changed.evidence[0];
  assert.ok(originalEvidence);
  assert.ok(changedEvidence);

  assert.notEqual(socialCollectionId(original), socialCollectionId(changed));
  assert.notEqual(
    socialVerificationEvidenceId(originalEvidence),
    socialVerificationEvidenceId(changedEvidence),
  );
});

void test('uses source and normalized metadata but excludes fetch time from metadata identity', () => {
  const first = resolvedMetadataSnapshot();
  const later = resolvedMetadataSnapshot({ fetchedAtMs: first.fetchedAtMs + 10_000 });
  const changed = resolvedMetadataSnapshot({
    resolution: Object.freeze({
      status: 'RESOLVED' as const,
      metadata: Object.freeze({
        ...resolvedMetadata(),
        description: 'changed',
      }),
    }),
  });

  assert.equal(
    socialMetadataSnapshotId({ sourceLaunchEventId: SOURCE_EVENT_ID, snapshot: first }),
    socialMetadataSnapshotId({ sourceLaunchEventId: SOURCE_EVENT_ID, snapshot: later }),
  );
  assert.notEqual(
    socialMetadataSnapshotId({ sourceLaunchEventId: SOURCE_EVENT_ID, snapshot: first }),
    socialMetadataSnapshotId({ sourceLaunchEventId: SOURCE_EVENT_ID, snapshot: changed }),
  );
  assert.notEqual(
    socialMetadataSnapshotId({ sourceLaunchEventId: SOURCE_EVENT_ID, snapshot: first }),
    socialMetadataSnapshotId({ sourceLaunchEventId: 'event-other', snapshot: first }),
  );
});

void test('builds an explicit failed collection without links or HTTP observations', () => {
  const metadataSnapshot = failedMetadataSnapshot();
  const collection = createFailedSocialCollection({
    mint: MINT,
    sourceLaunchEventId: SOURCE_EVENT_ID,
    metadataSnapshot,
  });

  assert.equal(collection.status, 'FAILED');
  assert.equal(collection.metadataSnapshotId, socialMetadataSnapshotId({
    sourceLaunchEventId: SOURCE_EVENT_ID,
    snapshot: metadataSnapshot,
  }));
  assert.deepEqual(collection.links, []);
  assert.deepEqual(collection.observations, []);
  assert.equal(collection.evidence.length, 1);
  assert.equal(collection.evidence[0]?.type, 'VERIFICATION_UNKNOWN');
  assert.equal(collection.evidence[0]?.outcome, 'UNKNOWN');
  assert.equal(collection.evidence[0]?.reasonCode, 'METADATA_UNAVAILABLE');
});

void test('rejects mutable, accessor, duplicate, foreign and inconsistent inputs', () => {
  const canonical = validCollectionInput();
  assert.throws(() => createSocialCollection({ ...canonical }), /frozen|plain|input/iu);

  const withAccessor = Object.freeze(Object.defineProperty({}, 'mint', {
    enumerable: true,
    get: () => { throw new Error('getter must not run'); },
  }));
  assert.throws(
    () => createSocialCollection(withAccessor as SocialEvidenceCollectionInputV1),
    /data|field|input/iu,
  );

  const canonicalLink = canonical.links[0];
  assert.ok(canonicalLink);
  assert.throws(() => createSocialCollection(collectionInput({
    ...canonical,
    links: Object.freeze([canonicalLink, canonicalLink]),
  })), /duplicate|unique/iu);

  assert.throws(() => createSocialCollection(collectionInput({
    ...canonical,
    evidence: Object.freeze([evidence({ mint: 'foreign-mint' })]),
  })), /mint|foreign|context/iu);

  const foreignObservation = observation({
    outcome: 'FAILED',
    finalCanonicalUrl: null,
    httpStatus: null,
    contentSha256: null,
    failureReason: 'TIMEOUT',
  });
  assert.throws(() => createSocialCollection(collectionInput({
    ...canonical,
    evidence: Object.freeze([evidence({ observationId: foreignObservation.id })]),
  })), /observation|foreign|reference/iu);
});

void test('rejects non-canonical IDs, hashes, timestamps, counts and oversized text', () => {
  const canonical = validCollectionInput();
  assert.throws(() => createSocialCollection(collectionInput({
    ...canonical,
    links: Object.freeze([link({ id: 'wrong' })]),
  })), /id|identity/iu);
  assert.throws(() => createSocialCollection(collectionInput({
    ...canonical,
    observations: Object.freeze([observation({ redirectCount: -1 })]),
  })), /redirect|count/iu);
  assert.throws(() => createSocialCollection(collectionInput({
    ...canonical,
    evidence: Object.freeze([evidence({ observedAtMs: -1 })]),
  })), /timestamp|observed/iu);
  assert.throws(() => createSocialCollection(collectionInput({
    ...canonical,
    evidence: Object.freeze([evidence({ reasonCode: 'x'.repeat(2_049) })]),
  })), /reason|text|bound|byte/iu);
  assert.throws(() => createSocialCollection(collectionInput({
    ...canonical,
    links: Object.freeze(Array.from({ length: 65 }, (_value, index) => link({
      id: `social_link_${String(index).padStart(64, '0')}`,
      kind: index % 3 === 0 ? 'WEBSITE' : index % 3 === 1 ? 'X' : 'TELEGRAM',
    }))),
  })), /link|array|bound|count/iu);
});

function validCollectionInput(): SocialEvidenceCollectionInputV1 {
  return collectionInput({
    mint: MINT,
    sourceLaunchEventId: SOURCE_EVENT_ID,
    metadataSnapshotId: metadataSnapshotId(),
    status: 'COMPLETE',
    links: Object.freeze([link()]),
    observations: Object.freeze([observation()]),
    evidence: Object.freeze([evidence()]),
    observedAtMs: OBSERVED_AT_MS,
  });
}

function collectionInput(
  value: SocialEvidenceCollectionInputV1,
): SocialEvidenceCollectionInputV1 {
  return Object.freeze(value);
}

function link(overrides: Partial<SocialLinkV1> = {}): SocialLinkV1 {
  const metadataSnapshotId = metadataSnapshotIdValue(overrides.metadataSnapshotId);
  const base = Object.freeze({
    id: '',
    mint: MINT,
    metadataSnapshotId,
    kind: 'WEBSITE' as const,
    declaredValueSha256: WEBSITE_HASH,
    syntaxStatus: 'VALID' as const,
    canonicalUrl: WEBSITE,
    invalidReason: null,
    observedAtMs: OBSERVED_AT_MS,
    ...overrides,
  });
  return Object.freeze({
    ...base,
    id: overrides.id ?? socialLinkId(base),
  });
}

function observation(
  overrides: Partial<SocialHttpObservationV1> = {},
): SocialHttpObservationV1 {
  const targetLink = link();
  const base = Object.freeze({
    id: '',
    linkId: targetLink.id,
    outcome: 'SUCCEEDED' as const,
    finalCanonicalUrl: WEBSITE,
    httpStatus: 200,
    redirectCount: 0,
    contentSha256: CONTENT_HASH,
    failureReason: null,
    observedAtMs: OBSERVED_AT_MS,
    ...overrides,
  });
  return Object.freeze({
    ...base,
    id: overrides.id ?? socialHttpObservationId(base),
  });
}

function evidence(
  overrides: Partial<SocialVerificationEvidenceV1> = {},
): SocialVerificationEvidenceV1 {
  const targetLink = link();
  const targetObservation = observation();
  const base = Object.freeze({
    id: '',
    mint: MINT,
    linkId: targetLink.id,
    observationId: targetObservation.id,
    type: 'URL_REACHABLE' as const,
    outcome: 'CONFIRMED' as const,
    subjectKind: 'WEBSITE' as const,
    relatedKind: null,
    reasonCode: 'HTTP_2XX',
    observedAtMs: OBSERVED_AT_MS,
    ...overrides,
  });
  return Object.freeze({
    ...base,
    id: overrides.id ?? socialVerificationEvidenceId(base),
  });
}

function metadataSnapshotId(): string {
  return socialMetadataSnapshotId({
    sourceLaunchEventId: SOURCE_EVENT_ID,
    snapshot: resolvedMetadataSnapshot(),
  });
}

function metadataSnapshotIdValue(value: string | undefined): string {
  return value ?? metadataSnapshotId();
}

function resolvedMetadataSnapshot(
  overrides: Partial<TokenMetadataSnapshot> = {},
): TokenMetadataSnapshot {
  return Object.freeze({
    mint: MINT,
    uri: 'https://metadata.example/token.json',
    resolution: Object.freeze({
      status: 'RESOLVED' as const,
      metadata: resolvedMetadata(),
    }),
    fetchedAtMs: OBSERVED_AT_MS,
    payloadVersion: 1,
    ...overrides,
  });
}

function failedMetadataSnapshot(): TokenMetadataSnapshot {
  return Object.freeze({
    mint: MINT,
    uri: 'https://metadata.example/token.json',
    resolution: Object.freeze({
      status: 'FAILED' as const,
      reason: 'FETCH_FAILED' as const,
      message: 'Public metadata unavailable.',
      retryable: false,
    }),
    fetchedAtMs: OBSERVED_AT_MS,
    payloadVersion: 1,
  });
}

function resolvedMetadata() {
  return Object.freeze({
    name: 'Project',
    symbol: 'PROJECT',
    description: 'Public project',
    imageUrl: 'https://cdn.example/image.png',
    videoUrl: null,
    websiteUrl: WEBSITE,
    twitterUrl: null,
    telegramUrl: null,
  });
}
