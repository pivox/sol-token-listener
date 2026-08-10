import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  normalizeSocialUrl,
  sameRegistrableDomain,
  sanitizeMetadataForPersistence,
  SOCIAL_URL_INVALID_REASONS,
} from '../src/social/social-url-normalizer.js';
import type { SocialLinkV1 } from '../src/domain/social-evidence.js';
import type { PublicTokenMetadata } from '../src/domain/pumpfun-observation.js';

const accepted = [
  ['X', 'https://twitter.com/Project_1', 'https://x.com/project_1'],
  ['TELEGRAM', 'https://Project_1.t.me/', 'https://t.me/project_1'],
  ['TELEGRAM', 'https://telegram.me/Project_1', 'https://t.me/project_1'],
  ['WEBSITE', 'https://Example.COM:443/project#team', 'https://example.com/project'],
  ['WEBSITE', 'http://Example.COM:80/', 'http://example.com/'],
] as const;

for (const [kind, input, canonicalUrl] of accepted) {
  void test(`canonicalizes ${kind} ${input}`, () => {
    assert.deepEqual(normalizeSocialUrl(kind, input), {
      status: 'VALID', declaredValueSha256: sha256(input), canonicalUrl,
    });
  });
}

void test('rejects unsupported profile, invite, service, credentials and hostile values', () => {
  const rejected = [
    ['X', 'https://x.com/home', 'PROFILE_PATH_UNSUPPORTED'],
    ['X', 'https://x.com/project/status/1', 'PROFILE_PATH_UNSUPPORTED'],
    ['X', 'https://example.com/project', 'HOST_UNSUPPORTED'],
    ['TELEGRAM', 'https://t.me/+invite', 'PROFILE_PATH_UNSUPPORTED'],
    ['TELEGRAM', 'https://t.me/c/123/4', 'PROFILE_PATH_UNSUPPORTED'],
    ['TELEGRAM', 'https://t.me/ProjectBot', 'PROFILE_PATH_UNSUPPORTED'],
    ['TELEGRAM', 'https://t.me/12345678', 'PROFILE_PATH_UNSUPPORTED'],
    ['WEBSITE', 'https://user:password@example.com', 'CREDENTIALS_FORBIDDEN'],
    ['WEBSITE', 'ftp://example.com', 'SCHEME_UNSUPPORTED'],
    ['WEBSITE', 'not a url', 'URL_INVALID'],
  ] as const;
  for (const [kind, input, reason] of rejected) {
    assert.deepEqual(normalizeSocialUrl(kind, input), {
      status: 'INVALID', declaredValueSha256: sha256(input), reason,
    });
  }

  assert.equal(normalizeSocialUrl('WEBSITE', null).status, 'INVALID');
  assert.equal(normalizeSocialUrl('WEBSITE', Object.defineProperty({}, 'toString', {
    get: () => { throw new Error('must not execute'); },
  })).status, 'INVALID');
  assert.equal(normalizeSocialUrl('WEBSITE', `https://example.com/${'x'.repeat(2_048)}`).status, 'INVALID');
});

void test('publishes stable invalid reasons and handles domains without suffix tricks', () => {
  assert.deepEqual(SOCIAL_URL_INVALID_REASONS, [
    'VALUE_MISSING', 'VALUE_NOT_TEXT', 'URL_INVALID', 'URL_TOO_LONG',
    'SCHEME_UNSUPPORTED', 'CREDENTIALS_FORBIDDEN', 'HOST_UNSUPPORTED',
    'PROFILE_PATH_UNSUPPORTED',
  ]);
  assert.equal(Object.isFrozen(SOCIAL_URL_INVALID_REASONS), true);
  assert.equal(sameRegistrableDomain('https://www.example.com/a', 'https://social.example.com/b'), true);
  assert.equal(sameRegistrableDomain('https://example.com', 'https://evil-example.com'), false);
  assert.equal(sameRegistrableDomain('http://localhost/a', 'https://localhost/b'), true);
  assert.equal(sameRegistrableDomain('http://a.localhost', 'http://b.localhost'), false);
});

void test('persists only canonical valid social URLs and removes raw invalid values', () => {
  const rawSecret = 'https://x.com/home?private=raw-secret';
  const metadata: PublicTokenMetadata = Object.freeze({
    name: 'Project', symbol: 'P', description: 'Description',
    imageUrl: null, videoUrl: null, websiteUrl: 'https://EXAMPLE.com/#x',
    twitterUrl: rawSecret, telegramUrl: 'https://telegram.me/Project_1',
  });
  const links = Object.freeze([
    socialLink('WEBSITE', 'VALID', 'https://example.com/'),
    socialLink('X', 'INVALID', null),
    socialLink('TELEGRAM', 'VALID', 'https://t.me/project_1'),
  ]);
  const sanitized = sanitizeMetadataForPersistence(metadata, links);
  assert.deepEqual(sanitized, {
    ...metadata,
    websiteUrl: 'https://example.com/',
    twitterUrl: null,
    telegramUrl: 'https://t.me/project_1',
  });
  assert.doesNotMatch(JSON.stringify(sanitized), /raw-secret/iu);
  assert.equal(Object.isFrozen(sanitized), true);
});

function socialLink(
  kind: SocialLinkV1['kind'],
  syntaxStatus: SocialLinkV1['syntaxStatus'],
  canonicalUrl: string | null,
): SocialLinkV1 {
  return Object.freeze({
    id: `social_link_${'a'.repeat(64)}`,
    mint: '11111111111111111111111111111111',
    metadataSnapshotId: `pumpfun_metadata_${'b'.repeat(64)}`,
    kind,
    declaredValueSha256: 'c'.repeat(64),
    syntaxStatus,
    canonicalUrl,
    invalidReason: syntaxStatus === 'VALID' ? null : 'PROFILE_PATH_UNSUPPORTED',
    observedAtMs: 1,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
