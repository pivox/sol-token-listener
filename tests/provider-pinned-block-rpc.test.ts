import assert from 'node:assert/strict';
import test from 'node:test';
import type { Commitment } from '@solana/web3.js';
import {
  ProviderPinnedBlockRpcError,
  createProviderPinnedBlockRpc,
  type ProviderPinnedBlockRpcDependencies,
} from '../src/solana/rpc/provider-pinned-block-rpc.js';
import type { RpcProviderCatalog } from '../src/solana/rpc/rpc-provider-catalog.js';

void test('pins complete-block reads to the selected provider HTTP URL and maps commitments exactly', async () => {
  const calls: unknown[][] = [];
  let created = 0;
  const source = createProviderPinnedBlockRpc(
    catalog(() => pair('fallback-1', 'https://provider-secret.invalid/rpc')),
    'fallback-1',
    'processed',
    dependencies((httpUrl, commitment) => {
      created += 1;
      assert.equal(httpUrl, 'https://provider-secret.invalid/rpc');
      assert.equal(commitment, 'processed');
      return Object.freeze({
        getBlock(...args: unknown[]): unknown {
          calls.push(args);
          return Object.freeze({ transactions: Object.freeze([]) });
        },
      });
    }),
  );

  assert.equal(source.providerId, 'fallback-1');
  assert.equal(Object.isFrozen(source), true);
  assert.deepEqual(Reflect.ownKeys(source), ['providerId', 'getBlockTransactions']);
  assert.equal(JSON.stringify(source), '{"providerId":"fallback-1"}');
  assert.deepEqual(await source.getBlockTransactions(12n, 'CONFIRMED'), { transactions: [] });
  assert.deepEqual(await source.getBlockTransactions(13n, 'FINALIZED'), { transactions: [] });
  assert.deepEqual(await source.getBlockTransactions(14n, 'PROCESSED'), { transactions: [] });
  assert.equal(created, 1);
  assert.deepEqual(calls, [
    [12, { commitment: 'confirmed', transactionDetails: 'full', maxSupportedTransactionVersion: 1, rewards: false }],
    [13, { commitment: 'finalized', transactionDetails: 'full', maxSupportedTransactionVersion: 1, rewards: false }],
    [14, { commitment: 'confirmed', transactionDetails: 'full', maxSupportedTransactionVersion: 1, rewards: false }],
  ]);
});

void test('consumes a rejected async factory result without an unhandled rejection or secret leak', async () => {
  const secret = 'https://factory-secret.invalid/token';
  const unhandled: unknown[] = [];
  const observe = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', observe);
  try {
    assert.throws(() => createProviderPinnedBlockRpc(catalog(), 'primary', 'confirmed', dependencies(() => (
      Promise.reject(new Error(secret))
    ))), (error: unknown) => invalid(error, 'CONFIG_INVALID', secret));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', observe);
  }
});

void test('consumes a native rejected promise without reading a hostile then accessor', async () => {
  const secret = 'https://native-promise-secret.invalid/token';
  const rejected = new Promise<never>((_resolve, reject) => { reject(new Error(secret)); });
  void rejected;
  let thenReads = 0;
  void Object.defineProperty(rejected, 'then', {
    get() { thenReads += 1; throw new Error(secret); },
  });
  const unhandled: unknown[] = [];
  const observe = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', observe);
  try {
    assert.throws(() => createProviderPinnedBlockRpc(catalog(), 'primary', 'confirmed', dependencies(() => rejected)),
      (error: unknown) => invalid(error, 'CONFIG_INVALID', secret));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(thenReads, 0);
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', observe);
  }
});

void test('does not invoke arbitrary thenables while rejecting them', async () => {
  const secret = 'https://thenable-secret.invalid/token';
  let calls = 0;
  assert.throws(() => createProviderPinnedBlockRpc(catalog(), 'primary', 'confirmed', dependencies(() => Object.freeze({
    then(): never { calls += 1; throw new Error(secret); },
  }))), (error: unknown) => invalid(error, 'CONFIG_INVALID', secret));
  assert.equal(calls, 0);
});

void test('sinks fulfilled native promise values without reading hostile then accessors', async () => {
  const secret = 'https://fulfilled-value-secret.invalid/token';
  let thenReads = 0;
  const hostileValue = {};
  const fulfilled = Promise.resolve(hostileValue);
  void Object.defineProperty(hostileValue, 'then', {
    get() { thenReads += 1; throw new Error(secret); },
  });
  const unhandled: unknown[] = [];
  const observe = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', observe);
  try {
    assert.throws(() => createProviderPinnedBlockRpc(catalog(), 'primary', 'confirmed', dependencies(() => fulfilled)),
      (error: unknown) => invalid(error, 'CONFIG_INVALID', secret));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(thenReads, 0);
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', observe);
  }
});

void test('rejects native promises with hostile own constructor accessors without reading them', () => {
  const secret = 'https://constructor-secret.invalid/token';
  const fulfilled = Promise.resolve(null);
  let constructorReads = 0;
  void Object.defineProperty(fulfilled, 'constructor', {
    get() { constructorReads += 1; throw new Error(secret); },
  });

  assert.throws(() => createProviderPinnedBlockRpc(catalog(), 'primary', 'confirmed', dependencies(() => fulfilled)),
    (error: unknown) => invalid(error, 'CONFIG_INVALID', secret));
  assert.equal(constructorReads, 0);
});

void test('never resolves or retains a fallback URL', () => {
  let resolves = 0;
  const selected = 'https://selected.invalid/rpc';
  const fallback = 'https://fallback-secret.invalid/rpc';
  const source = createProviderPinnedBlockRpc(catalog((id) => {
    resolves += 1;
    assert.equal(id, 'primary');
    return Object.freeze({ id, httpUrl: selected, websocketUrl: fallback });
  }), 'primary', 'confirmed', dependencies((url) => {
    assert.equal(url, selected);
    return Object.freeze({ async getBlock() { return null; } });
  }));

  assert.equal(resolves, 1);
  assert.doesNotMatch(JSON.stringify(source), /fallback|secret|selected|rpc/i);
});

void test('rejects invalid bigint slots before RPC use with a fixed redacted error', async () => {
  let calls = 0;
  const source = createProviderPinnedBlockRpc(catalog(), 'primary', 'confirmed', dependencies(() => Object.freeze({
    async getBlock() { calls += 1; return null; },
  })));

  for (const slot of [-1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n, 1 as unknown as bigint]) {
    await assert.rejects(source.getBlockTransactions(slot, 'CONFIRMED'), (error: unknown) => invalid(error, 'CONFIG_INVALID'));
  }
  assert.equal(calls, 0);
});

void test('fails closed and redacts hostile catalog, provider, and dependency shapes', () => {
  const secret = 'https://credential-secret.invalid/rpc';
  const hostileCatalog = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secret); } }) as RpcProviderCatalog;
  const hostileDependencies = new Proxy({}, { ownKeys() { throw new Error(secret); } });
  const invalidDependencies = Object.freeze({ createConnection: 'not-a-function' });
  const invalidPairCatalog = catalog(() => Object.freeze({ id: 'fallback-1', httpUrl: secret, websocketUrl: 'wss://ws.invalid' }));

  for (const create of [
    () => createProviderPinnedBlockRpc(hostileCatalog, 'primary', 'confirmed'),
    () => createProviderPinnedBlockRpc(catalog(), 'unknown' as never, 'confirmed'),
    () => createProviderPinnedBlockRpc(invalidPairCatalog, 'primary', 'confirmed'),
    () => createProviderPinnedBlockRpc(catalog(), 'primary', 'confirmed', hostileDependencies),
    () => createProviderPinnedBlockRpc(catalog(), 'primary', 'confirmed', invalidDependencies as never),
    () => createProviderPinnedBlockRpc(catalog(), 'primary', 'invalid' as never),
  ]) {
    assert.throws(create, (error: unknown) => invalid(error, 'CONFIG_INVALID', secret));
  }
});

void test('captures descriptor methods and maps hostile RPC failures to a fixed redacted error', async () => {
  let callGetterReads = 0;
  const getBlock = function getBlock(this: unknown, slot: number, options: unknown): unknown {
    assert.equal(this, rpc);
    assert.equal(slot, 7);
    assert.deepEqual(options, { commitment: 'confirmed', transactionDetails: 'full', maxSupportedTransactionVersion: 1, rewards: false });
    throw new Error('https://rpc-secret.invalid/token');
  };
  Object.defineProperty(getBlock, 'call', { get() { callGetterReads += 1; throw new Error('call-secret'); } });
  const rpc = Object.freeze({ getBlock });
  const source = createProviderPinnedBlockRpc(catalog(), 'primary', 'confirmed', dependencies(() => rpc));

  await assert.rejects(source.getBlockTransactions(7n, 'CONFIRMED'), (error: unknown) => invalid(error, 'BLOCK_UNAVAILABLE', 'secret'));
  assert.equal(callGetterReads, 0);
});

function catalog(resolve: (id: 'primary' | 'fallback-1') => unknown = (id) => pair(id, 'https://provider.invalid/rpc')): RpcProviderCatalog {
  return Object.freeze({
    ids: Object.freeze(['primary', 'fallback-1'] as const),
    resolve(id: 'primary' | 'fallback-1') { return resolve(id) as never; },
  });
}

function pair(id: 'primary' | 'fallback-1', httpUrl: string): object {
  return Object.freeze({ id, httpUrl, websocketUrl: 'wss://provider.invalid/rpc' });
}

function dependencies(createConnection: (httpUrl: string, commitment: Commitment) => unknown): ProviderPinnedBlockRpcDependencies {
  return Object.freeze({ createConnection });
}

function invalid(error: unknown, reason: 'CONFIG_INVALID' | 'BLOCK_UNAVAILABLE', forbidden = ''): boolean {
  assert.ok(error instanceof ProviderPinnedBlockRpcError);
  assert.equal(error.reason, reason);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.doesNotMatch(error.message, /credential|secret|https?:/i);
  if (forbidden !== '') assert.doesNotMatch(JSON.stringify(error), new RegExp(forbidden, 'u'));
  return true;
}
