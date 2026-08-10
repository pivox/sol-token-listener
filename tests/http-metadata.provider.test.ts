import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpMetadataProvider } from '../src/metadata/http-metadata.provider.js';
import type { MetadataFailureReason } from '../src/domain/pumpfun-observation.js';
import type { PublicHttpClient, PublicHttpResult } from '../src/ports/public-http-client.js';

void test('préserve la normalisation publique existante sur le transport partagé', async () => {
  const provider = new HttpMetadataProvider(client(success(JSON.stringify({
    name: ' Éclair ', symbol: 'ecl', image: 'https://cdn.test/image.png',
  }))));

  assert.deepEqual(await provider.resolve('https://example.com/meta.json'), {
    status: 'RESOLVED', metadata: {
      name: 'Éclair', symbol: 'ECL', description: null,
      imageUrl: 'https://cdn.test/image.png', videoUrl: null, websiteUrl: null,
      twitterUrl: null, telegramUrl: null,
    },
  });
});

void test('classe les échecs de transport sans fuite et conserve leur retryabilité', async () => {
  const cases = [
    ['URL_INVALID', 'URI_INVALID', false],
    ['SCHEME_UNSUPPORTED', 'UNSUPPORTED_URI_SCHEME', false],
    ['UNSAFE_DESTINATION', 'URI_INVALID', false],
    ['DNS_FAILED', 'FETCH_FAILED', true],
    ['TIMEOUT', 'FETCH_FAILED', true],
    ['NETWORK_FAILED', 'FETCH_FAILED', true],
    ['REDIRECT_INVALID', 'REDIRECT_LIMIT_EXCEEDED', false],
    ['REDIRECT_LIMIT_EXCEEDED', 'REDIRECT_LIMIT_EXCEEDED', false],
    ['HTTP_STATUS_INVALID', 'HTTP_STATUS_INVALID', true],
    ['CONTENT_TYPE_UNSUPPORTED', 'FETCH_FAILED', false],
    ['CONTENT_TOO_LARGE', 'CONTENT_TOO_LARGE', false],
    ['UTF8_INVALID', 'JSON_INVALID', false],
  ] as const;
  for (const [transportReason, metadataReason, retryable] of cases) {
    const provider = new HttpMetadataProvider(client(Object.freeze({
      status: 'FAILED' as const,
      reason: transportReason,
      retryable,
    })));
    assertFailure(await provider.resolve('https://secret.example/path'), metadataReason, retryable);
  }
});

void test('rejette le JSON invalide et la forme invalide sans les rendre retryables', async () => {
  const invalidJson = new HttpMetadataProvider(client(success('{')));
  assertFailure(await invalidJson.resolve('https://example.test'), 'JSON_INVALID', false);

  const invalidShape = new HttpMetadataProvider(client(success('[]')));
  assertFailure(await invalidShape.resolve('https://example.test'), 'JSON_SHAPE_INVALID', false);
});

void test('demande uniquement les types JSON au transport', async () => {
  const calls: (readonly [string, readonly string[]])[] = [];
  const http: PublicHttpClient = {
    get: async (url, accepted) => {
      calls.push([url, accepted]);
      return success('{}');
    },
  };
  await new HttpMetadataProvider(http).resolve('https://example.test/meta');
  assert.deepEqual(calls, [[
    'https://example.test/meta',
    ['application/json', 'text/json'],
  ]]);
});

function client(result: PublicHttpResult): PublicHttpClient {
  return { get: async () => result };
}

function success(body: string): PublicHttpResult {
  return Object.freeze({
    status: 'SUCCEEDED' as const,
    finalUrl: 'https://example.test/meta',
    httpStatus: 200,
    contentType: 'application/json',
    redirectCount: 0,
    body: new TextEncoder().encode(body),
  });
}

function assertFailure(
  result: Awaited<ReturnType<HttpMetadataProvider['resolve']>>,
  reason: MetadataFailureReason,
  retryable: boolean,
): void {
  assert.equal(result.status, 'FAILED');
  if (result.status !== 'FAILED') return;
  assert.equal(result.reason, reason);
  assert.equal(result.retryable, retryable);
  assert.doesNotMatch(result.message, /secret|example|path|93\.184/iu);
}
