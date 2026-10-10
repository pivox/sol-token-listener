import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FetchFn } from '@solana/web3.js';
import { HeliusAccountRotation } from '../src/solana/rpc/helius-account-rotation.js';
import { createProviderPinnedBlockRpc } from '../src/solana/rpc/provider-pinned-block-rpc.js';
import { createProviderPinnedCatchUpSource } from '../src/solana/rpc/provider-pinned-catch-up-source.js';
import { createProviderPinnedFinalityPass } from '../src/solana/rpc/provider-pinned-finality-source.js';
import { SolanaRpcClient } from '../src/solana/rpc/rpc-client.js';
import { createRpcHttpEvidenceRecorder } from '../src/solana/rpc/rpc-http-evidence.js';
import { catalogFetch, createRpcProviderCatalog } from '../src/solana/rpc/rpc-provider-catalog.js';

const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const CONFIG = Object.freeze({
  httpRpcUrl: 'https://rpc.invalid/?api-key=key-one',
  httpRpcFallbackUrls: Object.freeze([]),
  wsRpcUrl: 'wss://rpc.invalid/?api-key=key-one',
  wsRpcFallbackUrls: Object.freeze([]),
});
const GET_SLOT = '{"jsonrpc":"2.0","id":1,"method":"getSlot"}';

/** A Helius stand-in: key-one is exhausted, key-two answers getGenesisHash, getSlot and null otherwise. */
function setup() {
  const keys: string[] = [];
  const fetch: FetchFn = (input, init) => {
    const key = new URL(input instanceof Request ? input.url : input.toString()).searchParams.get('api-key') ?? '';
    keys.push(key);
    if (key === 'key-one') return Promise.resolve(new Response('max usage reached', { status: 429 }));
    const request = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { readonly id: unknown; readonly method: string };
    const result = request.method === 'getGenesisHash' ? GENESIS : request.method === 'getSlot' ? 42 : null;
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 }));
  };
  const rotation = new HeliusAccountRotation({
    accounts: [{ name: '01-one', apiKey: 'key-one' }, { name: '02-two', apiKey: 'key-two' }],
    httpUrl: CONFIG.httpRpcUrl,
    websocketUrl: CONFIG.wsRpcUrl,
    cooldownMs: 60_000,
    log: () => undefined,
    fetch,
  });
  return { rotation, keys, catalog: createRpcProviderCatalog(CONFIG, rotation) };
}

void test('the catalog carries the rotation fetch and resolves the WebSocket URL with the current key', async () => {
  const { rotation, catalog } = setup();
  assert.equal(catalogFetch(catalog), rotation.fetch);
  assert.equal(catalog.resolve('primary').websocketUrl, 'wss://rpc.invalid/?api-key=key-one');
  await rotation.fetch(CONFIG.httpRpcUrl, { method: 'POST', body: GET_SLOT });
  assert.equal(catalog.resolve('primary').websocketUrl, 'wss://rpc.invalid/?api-key=key-two');
  assert.equal(catalog.resolve('primary').httpUrl, CONFIG.httpRpcUrl);
  assert.ok(Object.isFrozen(catalog.resolve('primary')));
});

void test('a catalog without rotation has no fetch and keeps its URLs', () => {
  const catalog = createRpcProviderCatalog(CONFIG);
  assert.equal(catalogFetch(catalog), undefined);
  assert.equal(catalog.resolve('primary').websocketUrl, CONFIG.wsRpcUrl);
});

void test('catalogFetch refuses a fetch that is not an own data function', () => {
  const resolve = (): unknown => Object.freeze({ id: 'primary', httpUrl: CONFIG.httpRpcUrl, websocketUrl: CONFIG.wsRpcUrl });
  assert.throws(() => catalogFetch({ ids: ['primary'], resolve, fetch: 'x' } as never), TypeError);
  const withGetter = Object.defineProperty({ ids: ['primary'], resolve }, 'fetch', {
    get: () => globalThis.fetch, enumerable: true,
  });
  assert.throws(() => catalogFetch(withGetter as never), TypeError);
});

void test('the pinned catch-up source sends through the catalog fetch, with or without a recorder', async () => {
  for (const recorder of [undefined, createRpcHttpEvidenceRecorder()]) {
    const { catalog, keys } = setup();
    const source = createProviderPinnedCatchUpSource(catalog, 'primary', 'confirmed', GENESIS, undefined, recorder);
    await source.verifyGenesis(new AbortController().signal);
    assert.deepEqual(keys, ['key-one', 'key-two']);
  }
});

void test('the pinned finality pass sends through the catalog fetch, with or without a recorder', async () => {
  for (const recorder of [undefined, createRpcHttpEvidenceRecorder()]) {
    const { catalog, keys } = setup();
    const pass = createProviderPinnedFinalityPass(catalog, 'primary', undefined, recorder);
    await pass.getFinalizedSlot();
    assert.deepEqual(keys, ['key-one', 'key-two']);
  }
});

void test('the pinned block RPC sends through the catalog fetch, with or without a recorder', async () => {
  for (const recorder of [undefined, createRpcHttpEvidenceRecorder()]) {
    const { catalog, keys } = setup();
    const blocks = createProviderPinnedBlockRpc(catalog, 'primary', 'confirmed', undefined, { requestTimeoutMs: 5_000 }, recorder);
    assert.equal(await blocks.getBlockTransactions(12n, 'CONFIRMED'), null);
    assert.deepEqual(keys, ['key-one', 'key-two']);
  }
});

// The production factory always passes a recorder; without any observer the client ignores an injected fetch.
void test('the shared client sends through the rotation fetch', async () => {
  const { rotation, keys } = setup();
  const client = new SolanaRpcClient(
    { ...CONFIG, commitment: 'confirmed', finality: 'finalized' },
    { fetch: rotation.fetch, recorder: createRpcHttpEvidenceRecorder() },
  );
  assert.equal(await client.getSlot(), 42n);
  assert.deepEqual(keys, ['key-one', 'key-two']);
});

void test('the shared client rotates primary requests and leaves a fallback untouched', async () => {
  const { rotation, keys } = setup();
  const fallback = 'https://fallback.invalid/?api-key=fallback-key';
  const client = new SolanaRpcClient(
    { ...CONFIG, httpRpcFallbackUrls: Object.freeze([fallback]), commitment: 'confirmed', finality: 'finalized' },
    { fetch: rotation.fetch, recorder: createRpcHttpEvidenceRecorder() },
  );
  assert.equal(await client.getSlot(), 42n);
  assert.deepEqual(keys, ['key-one', 'key-two']);
  assert.ok(!keys.includes('fallback-key'));
});
