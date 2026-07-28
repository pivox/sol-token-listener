import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpMetadataProvider } from '../src/metadata/http-metadata.provider.js';

void test('récupère et normalise un JSON public borné', async () => {
  const provider = new HttpMetadataProvider(async () => new Response(JSON.stringify({
    name: ' Éclair ', symbol: 'ecl', image: 'https://cdn.test/image.png',
  }), { status: 200 }), { timeoutMs: 100, maxBytes: 1_024, maxRedirects: 1 });

  const result = await provider.resolve('https://example.test/meta.json');
  assert.deepEqual(result, {
    status: 'RESOLVED', metadata: {
      name: 'Éclair', symbol: 'ECL', description: null,
      imageUrl: 'https://cdn.test/image.png', videoUrl: null, websiteUrl: null,
      twitterUrl: null, telegramUrl: null,
    },
  });
});

void test('échoue de façon typée pour URI invalide, HTTP et JSON invalides', async () => {
  const invalid = new HttpMetadataProvider(async () => new Response('', { status: 500 }), {
    timeoutMs: 100, maxBytes: 1_024, maxRedirects: 1,
  });
  assertFailure(await invalid.resolve('ftp://example.test'), 'UNSUPPORTED_URI_SCHEME');
  assertFailure(await invalid.resolve('https://example.test'), 'HTTP_STATUS_INVALID');

  const json = new HttpMetadataProvider(async () => new Response('{', { status: 200 }), {
    timeoutMs: 100, maxBytes: 1_024, maxRedirects: 1,
  });
  assertFailure(await json.resolve('https://example.test'), 'JSON_INVALID');
});

void test('refuse un contenu qui dépasse la limite', async () => {
  const provider = new HttpMetadataProvider(async () => new Response('{"name":"long"}', { status: 200 }), {
    timeoutMs: 100, maxBytes: 5, maxRedirects: 1,
  });
  assertFailure(await provider.resolve('https://example.test'), 'CONTENT_TOO_LARGE');
});

function assertFailure(
  result: Awaited<ReturnType<HttpMetadataProvider['resolve']>>,
  reason: string,
): void {
  assert.equal(result.status, 'FAILED');
  if (result.status === 'FAILED') assert.equal(result.reason, reason);
}
