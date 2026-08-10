import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inspectPublicContent } from '../src/social/public-content-evidence.js';

const MINT = 'So11111111111111111111111111111111111111112';
const OTHER_MINT = '11111111111111111111111111111111';
const encoder = new TextEncoder();

void test('extracts visible exact mint and canonical public links from tolerant HTML', () => {
  const body = encoder.encode(`<html><head>
    <meta property="og:description" content="Mint ${MINT}">
    <meta property="og:url" content="https://EXAMPLE.com/project#top">
    </head><body><a href="https://twitter.com/Project_1">X</a>
    <script>${OTHER_MINT} https://evil.example/</script>
    <style>.x{content:'${OTHER_MINT}'}</style><template>${OTHER_MINT}</template>
    <p>broken <b>tag</body></html>`);
  const facts = inspectPublicContent({ contentType: 'text/html', body, mint: MINT });
  assert.equal(facts.exactMintPublished, true);
  assert.deepEqual(facts.canonicalLinks, [
    'https://example.com/project',
    'https://x.com/project_1',
  ]);
  assert.equal(facts.contentSha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(Object.isFrozen(facts), true);
  assert.equal(Object.isFrozen(facts.canonicalLinks), true);
});

void test('requires exact Base58 boundaries for a published mint', () => {
  for (const text of [`x${MINT}`, `${MINT}y`, `A${MINT}9`]) {
    assert.equal(inspectPublicContent({
      contentType: 'text/plain', body: encoder.encode(text), mint: MINT,
    }).exactMintPublished, false);
  }
  assert.equal(inspectPublicContent({
    contentType: 'text/plain', body: encoder.encode(`mint: ${MINT}.`), mint: MINT,
  }).exactMintPublished, true);
});

void test('extracts and deduplicates canonical links from plain text deterministically', () => {
  const facts = inspectPublicContent({
    contentType: 'text/plain',
    body: encoder.encode('See https://twitter.com/Project_1 and https://x.com/project_1.'),
    mint: MINT,
  });
  assert.deepEqual(facts.canonicalLinks, ['https://x.com/project_1']);
  assert.equal(facts.exactMintPublished, false);
});

void test('ignores hidden-only mint and non-public link schemes', () => {
  const facts = inspectPublicContent({
    contentType: 'text/html',
    body: encoder.encode(`<script>${MINT}</script><a href="javascript:alert(1)">x</a>`),
    mint: MINT,
  });
  assert.equal(facts.exactMintPublished, false);
  assert.deepEqual(facts.canonicalLinks, []);
});

void test('caps links, nodes and derived text without exposing an excerpt', () => {
  const links = new Array(100).fill(0).map((_, index) =>
    `<a href="https://site${index}.example/path">${'x'.repeat(5_000)}</a>`).join('');
  const facts = inspectPublicContent({
    contentType: 'text/html',
    body: encoder.encode(`<body>${links}${'<div>x</div>'.repeat(11_000)}</body>`),
    mint: MINT,
  });
  assert.equal(facts.canonicalLinks.length, 64);
  assert.deepEqual(Object.keys(facts), ['contentSha256', 'exactMintPublished', 'canonicalLinks']);
});

void test('rejects invalid content inputs without coercion', () => {
  assert.throws(() => inspectPublicContent({
    contentType: 'application/json' as 'text/plain', body: encoder.encode('{}'), mint: MINT,
  }), /content|type/iu);
  assert.throws(() => inspectPublicContent({
    contentType: 'text/plain', body: new Uint8Array([0xc3, 0x28]), mint: MINT,
  }), /utf|content/iu);
});
