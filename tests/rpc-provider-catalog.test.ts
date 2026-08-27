import assert from 'node:assert/strict';
import test from 'node:test';
import { createRpcProviderCatalog } from '../src/solana/rpc/rpc-provider-catalog.js';
import type { RpcProviderId as DomainRpcProviderId } from '../src/domain/rpc-provider.js';
import type { RpcProviderId as CatalogRpcProviderId } from '../src/solana/rpc/rpc-provider-catalog.js';

void test('re-exports the canonical neutral RPC provider identity', () => {
  const domainProvider: DomainRpcProviderId = 'fallback-2';
  const catalogProvider: CatalogRpcProviderId = domainProvider;
  assert.equal(catalogProvider, 'fallback-2');
});

void test('keeps only the primary pair when issue 56 HTTP-only fallbacks are configured', () => {
  const catalog = createRpcProviderCatalog({
    httpRpcUrl: 'https://primary.invalid/rpc#legacy-primary',
    httpRpcFallbackUrls: Object.freeze(['https://http-only.invalid/rpc']),
    wsRpcUrl: 'wss://primary.invalid/rpc#legacy-primary',
    wsRpcFallbackUrls: Object.freeze([]),
  });

  assert.deepEqual(catalog.ids, ['primary']);
  assert.deepEqual(catalog.resolve('primary'), {
    id: 'primary',
    httpUrl: 'https://primary.invalid/rpc#legacy-primary',
    websocketUrl: 'wss://primary.invalid/rpc#legacy-primary',
  });
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.ids), true);
  assert.equal(Object.isFrozen(catalog.resolve('primary')), true);
});

void test('creates frozen positional provider pairs without deriving public identities from URLs', () => {
  const catalog = createRpcProviderCatalog({
    httpRpcUrl: 'https://user:secret@primary.invalid/rpc',
    httpRpcFallbackUrls: Object.freeze([
      'https://one.invalid/rpc',
      'https://two.invalid/rpc',
    ]),
    wsRpcUrl: 'wss://user:secret@primary.invalid/rpc',
    wsRpcFallbackUrls: Object.freeze([
      'wss://one.invalid/rpc',
      'wss://two.invalid/rpc',
    ]),
  });

  assert.deepEqual(catalog.ids, ['primary', 'fallback-1', 'fallback-2']);
  assert.deepEqual(catalog.resolve('fallback-2'), {
    id: 'fallback-2',
    httpUrl: 'https://two.invalid/rpc',
    websocketUrl: 'wss://two.invalid/rpc',
  });
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(JSON.stringify(catalog), '{"ids":["primary","fallback-1","fallback-2"]}');
  assert.doesNotMatch(JSON.stringify(catalog), /secret|primary\.invalid|one\.invalid|two\.invalid/u);
});

void test('rejects malformed internal pair projections with one fixed redacted error', () => {
  const secret = 'super-secret-provider.invalid';
  for (const candidate of [
    {
      httpRpcUrl: `https://${secret}`,
      httpRpcFallbackUrls: Object.freeze([]),
      wsRpcUrl: `wss://${secret}`,
      wsRpcFallbackUrls: Object.freeze([`wss://${secret}`]),
    },
    {
      httpRpcUrl: `https://${secret}`,
      httpRpcFallbackUrls: Object.freeze(Array.from({ length: 4 }, () => `https://${secret}`)),
      wsRpcUrl: `wss://${secret}`,
      wsRpcFallbackUrls: Object.freeze(Array.from({ length: 4 }, () => `wss://${secret}`)),
    },
    {
      httpRpcUrl: `https://${secret}`,
      httpRpcFallbackUrls: Object.freeze([`https://${secret}/`]),
      wsRpcUrl: `wss://${secret}`,
      wsRpcFallbackUrls: Object.freeze([`wss://${secret}/`]),
    },
  ]) {
    assert.throws(
      () => createRpcProviderCatalog(candidate),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.equal(error.message, 'RPC provider catalog is invalid.');
        assert.doesNotMatch(String(error), /super-secret-provider/u);
        return true;
      },
    );
  }
});
