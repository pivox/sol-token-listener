import { createHash } from 'node:crypto';
import { parse } from 'parse5';
import type { SocialLinkKind } from '../domain/social-evidence.js';
import { normalizeSocialUrl } from './social-url-normalizer.js';

export interface PublicContentFacts {
  readonly contentSha256: string;
  readonly exactMintPublished: boolean;
  readonly canonicalLinks: readonly string[];
}

interface HtmlAttribute {
  readonly name: string;
  readonly value: string;
}

interface HtmlNode {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly attrs?: readonly HtmlAttribute[];
  readonly childNodes?: readonly HtmlNode[];
}

const BASE58_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
const BASE58_CHARACTER = /^[1-9A-HJ-NP-Za-km-z]$/u;
const MAX_NODES = 10_000;
const MAX_LINKS = 64;
const MAX_TEXT_CODE_UNITS = 262_144;
const HIDDEN_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'template']);
const DESCRIPTION_META: ReadonlySet<string> = new Set([
  'description', 'og:description', 'twitter:description',
]);
const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;

export function inspectPublicContent(input: Readonly<{
  contentType: 'text/html' | 'text/plain';
  body: Uint8Array;
  mint: string;
}>): PublicContentFacts {
  const contentType: unknown = input.contentType;
  if (contentType !== 'text/html' && contentType !== 'text/plain') {
    throw new TypeError('Public content type is unsupported.');
  }
  if (!(input.body instanceof Uint8Array)) throw new TypeError('Public content body is invalid.');
  if (!BASE58_MINT.test(input.mint)) throw new TypeError('Public content mint is invalid.');

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(input.body);
  } catch {
    throw new TypeError('Public content UTF-8 is invalid.');
  }
  const contentSha256 = createHash('sha256').update(input.body).digest('hex');
  const extracted = input.contentType === 'text/html'
    ? extractHtml(decoded)
    : Object.freeze({ text: capText(decoded), urls: extractTextUrls(decoded) });
  const canonicalLinks = canonicalizeLinks(extracted.urls);
  return Object.freeze({
    contentSha256,
    exactMintPublished: containsExactMint(extracted.text, input.mint),
    canonicalLinks,
  });
}

function extractHtml(html: string): Readonly<{ text: string; urls: readonly string[] }> {
  const document = parse(html) as unknown as HtmlNode;
  const stack: HtmlNode[] = [document];
  const text: string[] = [];
  const urls: string[] = [];
  let textLength = 0;
  let visited = 0;
  while (stack.length > 0 && visited < MAX_NODES) {
    const node = stack.pop();
    if (node === undefined) break;
    visited += 1;
    const tagName = node.tagName?.toLowerCase();
    if (tagName !== undefined && HIDDEN_TAGS.has(tagName)) continue;

    if (node.nodeName === '#text' && typeof node.value === 'string') {
      textLength = appendText(text, node.value, textLength);
    } else if (tagName === 'a' || tagName === 'link') {
      appendUrl(urls, attribute(node, 'href'));
    } else if (tagName === 'meta') {
      const property = (attribute(node, 'property') ?? attribute(node, 'name'))?.toLowerCase();
      const content = attribute(node, 'content');
      if (property === 'og:url' || property === 'twitter:url') appendUrl(urls, content);
      if (property !== undefined && DESCRIPTION_META.has(property) && content !== null) {
        textLength = appendText(text, content, textLength);
      }
    }

    const children = node.childNodes ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }
  return Object.freeze({ text: text.join(' '), urls: Object.freeze(urls) });
}

function attribute(node: HtmlNode, name: string): string | null {
  const found = node.attrs?.find((item) => item.name.toLowerCase() === name);
  return found?.value ?? null;
}

function appendText(parts: string[], value: string, currentLength: number): number {
  if (currentLength >= MAX_TEXT_CODE_UNITS) return currentLength;
  const available = MAX_TEXT_CODE_UNITS - currentLength;
  const bounded = value.slice(0, available);
  parts.push(bounded);
  return currentLength + bounded.length;
}

function appendUrl(urls: string[], value: string | null): void {
  if (value !== null && urls.length < MAX_LINKS * 4) urls.push(value);
}

function extractTextUrls(text: string): readonly string[] {
  const result: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const value = match[0].replace(/[),.;\]}]+$/u, '');
    if (value !== '') result.push(value);
    if (result.length >= MAX_LINKS * 4) break;
  }
  return Object.freeze(result);
}

function canonicalizeLinks(values: readonly string[]): readonly string[] {
  const result = new Set<string>();
  for (const value of values) {
    const kind = classifyUrl(value);
    const normalized = normalizeSocialUrl(kind, value);
    if (normalized.status === 'VALID') result.add(normalized.canonicalUrl);
    if (result.size >= MAX_LINKS) break;
  }
  return Object.freeze([...result].sort(compareText));
}

function classifyUrl(value: string): SocialLinkKind {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host === 'x.com' || host === 'www.x.com' || host === 'twitter.com' || host === 'www.twitter.com') {
      return 'X';
    }
    if (host === 't.me' || host === 'www.t.me' || host === 'telegram.me'
      || host === 'www.telegram.me' || host.endsWith('.t.me')) return 'TELEGRAM';
  } catch {
    return 'WEBSITE';
  }
  return 'WEBSITE';
}

function capText(value: string): string {
  return value.slice(0, MAX_TEXT_CODE_UNITS);
}

function containsExactMint(text: string, mint: string): boolean {
  let index = text.indexOf(mint);
  while (index >= 0) {
    const before = index === 0 ? '' : text[index - 1] ?? '';
    const after = text[index + mint.length] ?? '';
    if (!BASE58_CHARACTER.test(before) && !BASE58_CHARACTER.test(after)) return true;
    index = text.indexOf(mint, index + 1);
  }
  return false;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
