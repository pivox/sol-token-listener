import assert from 'node:assert/strict';
import test from 'node:test';
import type { TokenMetadataSnapshot } from '../src/domain/pumpfun-observation.js';
import type {
  SocialEvidenceCollectionV1,
  SocialEvidenceOutcome,
  SocialEvidenceType,
  SocialLinkKind,
} from '../src/domain/social-evidence.js';
import { PublicSocialVerificationProvider } from '../src/social/public-social-verification.provider.js';
import type { PublicHttpClient, PublicHttpResult } from '../src/ports/public-http-client.js';

const MINT = 'So11111111111111111111111111111111111111112';
const SOURCE_EVENT_ID = 'launch-event-1';
const NOW = 1_786_300_000_000;

void test('normalizes declarations, omits missing links and never fetches invalid links', async () => {
  const calls: string[] = [];
  const provider = new PublicSocialVerificationProvider(recordingClient(calls, new Map()));
  const result = await provider.collect(providerInput(metadata({
    websiteUrl: null,
    twitterUrl: 'https://x.com/home?raw-secret=yes',
    telegramUrl: null,
  })));

  assert.equal(result.collection.status, 'COMPLETE');
  assert.equal(result.collection.links.length, 1);
  assert.equal(result.collection.links[0]?.kind, 'X');
  assert.equal(result.collection.links[0]?.syntaxStatus, 'INVALID');
  assert.deepEqual(calls, []);
  assertEvidence(result.collection, 'URL_SYNTAX_INVALID', 'X', null, 'REJECTED');
  assert.equal(result.metadataSnapshot.resolution.status, 'RESOLVED');
  if (result.metadataSnapshot.resolution.status === 'RESOLVED') {
    assert.equal(result.metadataSnapshot.resolution.metadata.twitterUrl, null);
    assert.doesNotMatch(JSON.stringify(result.metadataSnapshot), /raw-secret/iu);
  }
});

void test('records directional cross-links without inventing the reverse direction', async () => {
  const pages = new Map<string, PublicHttpResult>([
    ['https://project.example/', html('<a href="https://x.com/project_1">X</a>')],
    ['https://x.com/project_1', html('<p>Public profile unavailable. Enable JavaScript.</p>')],
  ]);
  const result = await new PublicSocialVerificationProvider(recordingClient([], pages)).collect(
    providerInput(metadata({
      websiteUrl: 'https://project.example/',
      twitterUrl: 'https://twitter.com/Project_1',
    })),
  );

  assertEvidence(result.collection, 'CROSS_LINK_CONFIRMED', 'WEBSITE', 'X', 'CONFIRMED');
  assertEvidence(result.collection, 'CROSS_LINK_CONFIRMED', 'X', 'WEBSITE', 'UNKNOWN');
  assertEvidence(result.collection, 'ACCOUNT_TOO_RECENT', 'X', null, 'UNKNOWN');
  assert.equal(result.collection.status, 'PARTIAL');
});

void test('confirms exact mint, detects website domain redirects and fetches each canonical URL once', async () => {
  const calls: string[] = [];
  const pages = new Map<string, PublicHttpResult>([
    ['https://project.example/', Object.freeze({
      ...html(`<p>Mint ${MINT}</p>`),
      finalUrl: 'https://different.example.net/project',
      redirectCount: 1,
    })],
  ]);
  const result = await new PublicSocialVerificationProvider(recordingClient(calls, pages)).collect(
    providerInput(metadata({ websiteUrl: 'https://project.example/' })),
  );

  assertEvidence(result.collection, 'URL_REACHABLE', 'WEBSITE', null, 'CONFIRMED');
  assertEvidence(result.collection, 'MINT_PUBLISHED', 'WEBSITE', null, 'CONFIRMED');
  assertEvidence(result.collection, 'DOMAIN_MISMATCH', 'WEBSITE', null, 'REJECTED');
  assert.deepEqual(calls, ['https://project.example/']);
  assert.equal(result.collection.observations[0]?.contentSha256 === null, false);
  assert.equal(JSON.stringify(result.collection).includes(MINT), true);
  assert.equal(JSON.stringify(result.collection).includes('<p>'), false);
});

void test('keeps unavailable and transient content unknown with stable collection coverage', async () => {
  const cases = [
    [failure('HTTP_STATUS_INVALID', false), 'PARTIAL', 'REJECTED', false],
    [failure('HTTP_STATUS_INVALID', true), 'FAILED', 'UNKNOWN', true],
    [failure('TIMEOUT', true), 'FAILED', 'UNKNOWN', true],
  ] as const;
  for (const [reply, status, reachability, retryable] of cases) {
    const pages = new Map<string, PublicHttpResult>([['https://project.example/', reply]]);
    const result = await new PublicSocialVerificationProvider(recordingClient([], pages)).collect(
      providerInput(metadata({ websiteUrl: 'https://project.example/' })),
    );
    assert.equal(result.collection.status, status);
    assert.equal(result.retryable, retryable);
    if (retryable) {
      assertEvidence(result.collection, 'VERIFICATION_UNKNOWN', null, null, 'UNKNOWN');
      assert.equal(result.collection.links.length, 0);
      assert.equal(result.collection.observations.length, 0);
    } else {
      assertEvidence(result.collection, 'URL_REACHABLE', 'WEBSITE', null, reachability);
      assertEvidence(result.collection, 'CONTENT_UNAVAILABLE', 'WEBSITE', null, 'UNKNOWN');
      assertEvidence(result.collection, 'MINT_PUBLISHED', 'WEBSITE', null, 'UNKNOWN');
    }
  }
});

void test('returns explicit failed collection when metadata resolution failed', async () => {
  let calls = 0;
  const provider = new PublicSocialVerificationProvider({ get: async () => {
    calls += 1;
    return failure('NETWORK_FAILED', true);
  } });
  const snapshot: TokenMetadataSnapshot = Object.freeze({
    mint: MINT,
    uri: 'https://metadata.example/token.json',
    resolution: Object.freeze({
      status: 'FAILED' as const,
      reason: 'FETCH_FAILED' as const,
      message: 'Metadata unavailable.',
      retryable: true,
    }),
    fetchedAtMs: NOW,
    payloadVersion: 1,
  });
  const result = await provider.collect(providerInput(snapshot));
  assert.equal(result.collection.status, 'FAILED');
  assert.equal(result.collection.evidence[0]?.type, 'VERIFICATION_UNKNOWN');
  assert.equal(calls, 0);
});

void test('orders links and evidence deterministically regardless of declaration order', async () => {
  const pages = new Map<string, PublicHttpResult>([
    ['https://project.example/', html('project')],
    ['https://x.com/project_1', html('profile')],
    ['https://t.me/project_1', html('group')],
  ]);
  const provider = new PublicSocialVerificationProvider(recordingClient([], pages));
  const first = await provider.collect(providerInput(metadata({
    telegramUrl: 'https://t.me/Project_1', websiteUrl: 'https://project.example/',
    twitterUrl: 'https://x.com/Project_1',
  })));
  const replay = await provider.collect(providerInput(metadata({
    twitterUrl: 'https://x.com/Project_1', websiteUrl: 'https://project.example/',
    telegramUrl: 'https://t.me/Project_1',
  })));
  assert.deepEqual(replay, first);
  assert.deepEqual(first.collection.links.map((link) => link.kind), ['WEBSITE', 'X', 'TELEGRAM']);
});

function assertEvidence(
  collection: SocialEvidenceCollectionV1,
  type: SocialEvidenceType,
  subjectKind: SocialLinkKind | null,
  relatedKind: SocialLinkKind | null,
  outcome: SocialEvidenceOutcome,
): void {
  assert.ok(collection.evidence.some((item) => item.type === type
    && item.subjectKind === subjectKind
    && item.relatedKind === relatedKind
    && item.outcome === outcome), `${type}:${subjectKind}:${relatedKind ?? '-'}:${outcome}`);
}

function providerInput(metadataSnapshot: TokenMetadataSnapshot) {
  return Object.freeze({ mint: MINT, sourceLaunchEventId: SOURCE_EVENT_ID, metadataSnapshot });
}

function metadata(overrides: Readonly<{
  websiteUrl?: string | null;
  twitterUrl?: string | null;
  telegramUrl?: string | null;
}> = {}): TokenMetadataSnapshot {
  return Object.freeze({
    mint: MINT,
    uri: 'https://metadata.example/token.json',
    resolution: Object.freeze({
      status: 'RESOLVED' as const,
      metadata: Object.freeze({
        name: 'Project', symbol: 'P', description: 'Public project',
        imageUrl: null, videoUrl: null, websiteUrl: null, twitterUrl: null,
        telegramUrl: null, ...overrides,
      }),
    }),
    fetchedAtMs: NOW,
    payloadVersion: 1,
  });
}

function recordingClient(
  calls: string[],
  pages: ReadonlyMap<string, PublicHttpResult>,
): PublicHttpClient {
  return {
    get: async (url, accepted) => {
      calls.push(url);
      assert.deepEqual(accepted, ['text/html', 'text/plain']);
      return pages.get(url) ?? failure('HTTP_STATUS_INVALID', false);
    },
  };
}

function html(body: string): PublicHttpResult {
  return Object.freeze({
    status: 'SUCCEEDED' as const,
    finalUrl: 'https://placeholder.invalid/',
    httpStatus: 200,
    contentType: 'text/html',
    redirectCount: 0,
    body: new TextEncoder().encode(body),
  });
}

function failure(
  reason: Extract<PublicHttpResult, { status: 'FAILED' }>['reason'],
  retryable: boolean,
): PublicHttpResult {
  return Object.freeze({ status: 'FAILED' as const, reason, retryable });
}
