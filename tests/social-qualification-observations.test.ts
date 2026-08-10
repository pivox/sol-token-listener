import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  SocialEvidenceCollectionV1,
  SocialEvidenceOutcome,
  SocialEvidenceType,
  SocialLinkKind,
  SocialVerificationEvidenceV1,
} from '../src/domain/social-evidence.js';
import { toSocialQualificationObservations } from '../src/social/social-qualification-observations.js';

const MINT = 'So11111111111111111111111111111111111111112';

void test('confirms social coherence only with bidirectional public evidence', () => {
  const result = toSocialQualificationObservations(collection([
    item('CROSS_LINK_CONFIRMED', 'CONFIRMED', 'WEBSITE', 'X'),
    item('CROSS_LINK_CONFIRMED', 'CONFIRMED', 'X', 'WEBSITE'),
  ]));
  assert.equal(result.signals.socialCrossLinkConfirmed, true);
  assert.equal(Object.isFrozen(result.signals), true);
});

void test('omits partial and unknown social signals instead of synthesizing false', () => {
  const result = toSocialQualificationObservations(collection([
    item('URL_REACHABLE', 'CONFIRMED', 'WEBSITE', null),
    item('URL_REACHABLE', 'UNKNOWN', 'X', null),
    item('CROSS_LINK_CONFIRMED', 'CONFIRMED', 'WEBSITE', 'X'),
    item('CROSS_LINK_CONFIRMED', 'UNKNOWN', 'X', 'WEBSITE'),
  ], 'PARTIAL'));
  assert.deepEqual(result.signals, {});
});

void test('maps conclusive negative observations to false', () => {
  const result = toSocialQualificationObservations(collection([
    item('URL_REACHABLE', 'CONFIRMED', 'WEBSITE', null),
    item('URL_REACHABLE', 'REJECTED', 'X', null),
    item('CROSS_LINK_CONFIRMED', 'CONFIRMED', 'WEBSITE', 'X'),
    item('CROSS_LINK_CONFIRMED', 'REJECTED', 'X', 'WEBSITE'),
  ]));
  assert.deepEqual(result.signals, {
    linksReachable: false,
    socialCrossLinkConfirmed: false,
  });
});

void test('maps exact mint confirmation only to a non-triggered mismatch condition', () => {
  const result = toSocialQualificationObservations(collection([
    item('MINT_PUBLISHED', 'CONFIRMED', 'WEBSITE', null),
    item('DOMAIN_MISMATCH', 'REJECTED', 'WEBSITE', null),
  ]));
  assert.equal(result.upstreamConditions.some((condition) =>
    condition.code === 'IMPERSONATION_SUSPECTED'), false);
  assert.deepEqual(result.upstreamConditions, Object.freeze([
    Object.freeze({ code: 'MINT_SOCIAL_MISMATCH', triggered: false }),
  ]));
});

void test('reports metadata failure but never infers mint mismatch or impersonation', () => {
  const result = toSocialQualificationObservations(collection([
    item('VERIFICATION_UNKNOWN', 'UNKNOWN', null, null),
  ], 'FAILED'));
  assert.deepEqual(result.signals, {});
  assert.deepEqual(result.upstreamConditions, Object.freeze([
    Object.freeze({ code: 'METADATA_FETCH_FAILED', triggered: true }),
  ]));
});

function collection(
  evidence: readonly SocialVerificationEvidenceV1[],
  status: SocialEvidenceCollectionV1['status'] = 'COMPLETE',
): SocialEvidenceCollectionV1 {
  return Object.freeze({
    id: `social_collection_${'a'.repeat(64)}`,
    inputFingerprint: 'b'.repeat(64),
    mint: MINT,
    sourceLaunchEventId: 'launch-event-1',
    metadataSnapshotId: `pumpfun_metadata_${'c'.repeat(64)}`,
    status,
    links: Object.freeze([]),
    observations: Object.freeze([]),
    evidence: Object.freeze(evidence),
    observedAtMs: 1,
    payloadVersion: 1,
  });
}

function item(
  type: SocialEvidenceType,
  outcome: SocialEvidenceOutcome,
  subjectKind: SocialLinkKind | null,
  relatedKind: SocialLinkKind | null,
): SocialVerificationEvidenceV1 {
  return Object.freeze({
    id: `social_evidence_${type.toLowerCase().padEnd(64, '0').slice(0, 64)}`,
    mint: MINT,
    linkId: subjectKind === null ? null : `social_link_${subjectKind.toLowerCase().padEnd(64, '0').slice(0, 64)}`,
    observationId: null,
    type,
    outcome,
    subjectKind,
    relatedKind,
    reasonCode: 'TEST_EVIDENCE',
    observedAtMs: 1,
  });
}
