import { createHash } from 'node:crypto';
import { getDomain } from 'tldts';
import type { SocialLinkKind, SocialLinkV1 } from '../domain/social-evidence.js';
import type { PublicTokenMetadata } from '../domain/pumpfun-observation.js';

export const SOCIAL_URL_INVALID_REASONS = Object.freeze([
  'VALUE_MISSING',
  'VALUE_NOT_TEXT',
  'URL_INVALID',
  'URL_TOO_LONG',
  'SCHEME_UNSUPPORTED',
  'CREDENTIALS_FORBIDDEN',
  'HOST_UNSUPPORTED',
  'PROFILE_PATH_UNSUPPORTED',
] as const);

export type SocialUrlInvalidReason = (typeof SOCIAL_URL_INVALID_REASONS)[number];

export type SocialUrlNormalization =
  | Readonly<{
      status: 'VALID';
      declaredValueSha256: string;
      canonicalUrl: string;
    }>
  | Readonly<{
      status: 'INVALID';
      declaredValueSha256: string;
      reason: SocialUrlInvalidReason;
    }>;

const MAX_URL_BYTES = 2_048;
const X_HOSTS: ReadonlySet<string> = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
const X_RESERVED: ReadonlySet<string> = new Set([
  'about', 'compose', 'explore', 'hashtag', 'home', 'i', 'intent', 'login',
  'messages', 'notifications', 'search', 'settings', 'share', 'tos',
]);
const TELEGRAM_HOSTS: ReadonlySet<string> = new Set([
  't.me', 'www.t.me', 'telegram.me', 'www.telegram.me',
]);
const TELEGRAM_RESERVED: ReadonlySet<string> = new Set([
  'addlist', 'addstickers', 'apps', 'c', 'contact', 'invoice', 'joinchat',
  'login', 'proxy', 'setlanguage', 'share', 'socks',
]);

export function normalizeSocialUrl(
  kind: SocialLinkKind,
  declaredUrl: unknown,
): SocialUrlNormalization {
  const declaredValueSha256 = hashDeclaredValue(declaredUrl);
  if (declaredUrl === null || declaredUrl === undefined || declaredUrl === '') {
    return invalid(declaredValueSha256, 'VALUE_MISSING');
  }
  if (typeof declaredUrl !== 'string') {
    return invalid(declaredValueSha256, 'VALUE_NOT_TEXT');
  }
  if (Buffer.byteLength(declaredUrl, 'utf8') > MAX_URL_BYTES) {
    return invalid(declaredValueSha256, 'URL_TOO_LONG');
  }

  let url: URL;
  try {
    url = new URL(declaredUrl);
  } catch {
    return invalid(declaredValueSha256, 'URL_INVALID');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return invalid(declaredValueSha256, 'SCHEME_UNSUPPORTED');
  }
  if (url.username !== '' || url.password !== '') {
    return invalid(declaredValueSha256, 'CREDENTIALS_FORBIDDEN');
  }
  if (url.hostname === '') return invalid(declaredValueSha256, 'HOST_UNSUPPORTED');

  switch (kind) {
    case 'WEBSITE': {
      url.hash = '';
      return valid(declaredValueSha256, url.toString());
    }
    case 'X':
      return normalizeX(url, declaredValueSha256);
    case 'TELEGRAM':
      return normalizeTelegram(url, declaredValueSha256);
  }
}

export function sameRegistrableDomain(left: string, right: string): boolean {
  let leftUrl: URL;
  let rightUrl: URL;
  try {
    leftUrl = new URL(left);
    rightUrl = new URL(right);
  } catch {
    return false;
  }
  const leftHost = leftUrl.hostname.toLowerCase();
  const rightHost = rightUrl.hostname.toLowerCase();
  const leftDomain = getDomain(leftHost, { allowPrivateDomains: false });
  const rightDomain = getDomain(rightHost, { allowPrivateDomains: false });
  if (leftDomain === null || rightDomain === null) return leftHost === rightHost;
  return leftDomain === rightDomain;
}

export function sanitizeMetadataForPersistence(
  metadata: PublicTokenMetadata,
  links: readonly Pick<SocialLinkV1, 'kind' | 'syntaxStatus' | 'canonicalUrl'>[],
): PublicTokenMetadata {
  return Object.freeze({
    name: metadata.name,
    symbol: metadata.symbol,
    description: metadata.description,
    imageUrl: metadata.imageUrl,
    videoUrl: metadata.videoUrl,
    websiteUrl: canonicalFor(links, 'WEBSITE'),
    twitterUrl: canonicalFor(links, 'X'),
    telegramUrl: canonicalFor(links, 'TELEGRAM'),
  });
}

function normalizeX(url: URL, declaredValueSha256: string): SocialUrlNormalization {
  const host = url.hostname.toLowerCase();
  if (!X_HOSTS.has(host)) return invalid(declaredValueSha256, 'HOST_UNSUPPORTED');
  const parts = pathParts(url);
  const handle = parts[0];
  if (
    parts.length !== 1
    || handle === undefined
    || !/^[A-Za-z0-9_]{1,15}$/u.test(handle)
    || X_RESERVED.has(handle.toLowerCase())
  ) return invalid(declaredValueSha256, 'PROFILE_PATH_UNSUPPORTED');
  return valid(declaredValueSha256, `https://x.com/${handle.toLowerCase()}`);
}

function normalizeTelegram(url: URL, declaredValueSha256: string): SocialUrlNormalization {
  const host = url.hostname.toLowerCase();
  let handle: string | undefined;
  if (TELEGRAM_HOSTS.has(host)) {
    const parts = pathParts(url);
    if (parts.length !== 1) return invalid(declaredValueSha256, 'PROFILE_PATH_UNSUPPORTED');
    [handle] = parts;
  } else if (host.endsWith('.t.me')) {
    const labels = host.split('.');
    if (labels.length !== 3 || url.pathname !== '/' || url.search !== '') {
      return invalid(declaredValueSha256, 'PROFILE_PATH_UNSUPPORTED');
    }
    [handle] = labels;
  } else {
    return invalid(declaredValueSha256, 'HOST_UNSUPPORTED');
  }
  if (
    handle === undefined
    || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/u.test(handle)
    || TELEGRAM_RESERVED.has(handle.toLowerCase())
    || handle.toLowerCase().endsWith('bot')
  ) return invalid(declaredValueSha256, 'PROFILE_PATH_UNSUPPORTED');
  return valid(declaredValueSha256, `https://t.me/${handle.toLowerCase()}`);
}

function pathParts(url: URL): readonly string[] {
  return url.pathname.split('/').filter((part) => part !== '').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return '';
    }
  });
}

function canonicalFor(
  links: readonly Pick<SocialLinkV1, 'kind' | 'syntaxStatus' | 'canonicalUrl'>[],
  kind: SocialLinkKind,
): string | null {
  const candidates = links.filter((link) => link.kind === kind);
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  return candidate?.syntaxStatus === 'VALID' ? candidate.canonicalUrl : null;
}

function hashDeclaredValue(value: unknown): string {
  const text = typeof value === 'string'
    ? value
    : value === null || value === undefined ? '[missing]' : `[non-text:${typeof value}]`;
  return createHash('sha256').update(text).digest('hex');
}

function valid(declaredValueSha256: string, canonicalUrl: string): SocialUrlNormalization {
  return Object.freeze({ status: 'VALID' as const, declaredValueSha256, canonicalUrl });
}

function invalid(
  declaredValueSha256: string,
  reason: SocialUrlInvalidReason,
): SocialUrlNormalization {
  return Object.freeze({ status: 'INVALID' as const, declaredValueSha256, reason });
}
