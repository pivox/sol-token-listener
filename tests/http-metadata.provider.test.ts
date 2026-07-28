import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpMetadataProvider } from '../src/metadata/http-metadata.provider.js';

const publicResolver = async (): Promise<readonly string[]> => ['93.184.216.34'];

void test('récupère et normalise un JSON public borné', async () => {
  const provider = new HttpMetadataProvider(async () => new Response(JSON.stringify({
    name: ' Éclair ', symbol: 'ecl', image: 'https://cdn.test/image.png',
  }), { status: 200 }), { timeoutMs: 100, maxBytes: 1_024, maxRedirects: 1 }, publicResolver);

  const result = await provider.resolve('https://example.com/meta.json');
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
  }, publicResolver);
  assertFailure(await invalid.resolve('ftp://example.com'), 'UNSUPPORTED_URI_SCHEME');
  assertFailure(await invalid.resolve('https://example.com'), 'HTTP_STATUS_INVALID');

  const json = new HttpMetadataProvider(async () => new Response('{', { status: 200 }), {
    timeoutMs: 100, maxBytes: 1_024, maxRedirects: 1,
  }, publicResolver);
  assertFailure(await json.resolve('https://example.com'), 'JSON_INVALID');
});

void test('refuse un contenu qui dépasse la limite', async () => {
  const provider = new HttpMetadataProvider(async () => new Response('{"name":"long"}', { status: 200 }), {
    timeoutMs: 100, maxBytes: 5, maxRedirects: 1,
  }, publicResolver);
  assertFailure(await provider.resolve('https://example.com'), 'CONTENT_TOO_LARGE');
});

void test('refuse les hôtes non publics avant toute requête', async () => {
  let requests = 0;
  const provider = new HttpMetadataProvider(async () => {
    requests += 1;
    return new Response('{}', { status: 200 });
  }, { timeoutMs: 100, maxBytes: 1_024, maxRedirects: 1 }, async () => ['127.0.0.1']);

  assertFailure(await provider.resolve('https://metadata.example'), 'URI_INVALID');
  assert.equal(requests, 0);
});

void test('refuse une IPv4 locale mappée dans IPv6', async () => {
  const provider = new HttpMetadataProvider(async () => new Response('{}', { status: 200 }), {
    timeoutMs: 100, maxBytes: 1_024, maxRedirects: 1,
  }, async () => ['::ffff:127.0.0.1']);

  assertFailure(await provider.resolve('https://metadata.example'), 'URI_INVALID');
});

void test('valide les bornes du récupérateur HTTP', () => {
  assert.throws(() => new HttpMetadataProvider(fetch, {
    timeoutMs: 0, maxBytes: 1_024, maxRedirects: 1,
  }, publicResolver), /timeoutMs/);
});

function assertFailure(
  result: Awaited<ReturnType<HttpMetadataProvider['resolve']>>,
  reason: string,
): void {
  assert.equal(result.status, 'FAILED');
  if (result.status === 'FAILED') assert.equal(result.reason, reason);
}
