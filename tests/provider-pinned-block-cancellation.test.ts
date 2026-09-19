import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import test from 'node:test';
import { ProviderAffineCatchUpHydration } from '../src/application/provider-affine-catch-up-hydration.js';
import { createProviderPinnedBlockRpc, ProviderPinnedBlockRpcError } from '../src/solana/rpc/provider-pinned-block-rpc.js';
import { createRpcProviderCatalog } from '../src/solana/rpc/rpc-provider-catalog.js';
import { CachedSolanaBlockTransactionLocator } from '../src/solana/rpc/block-transaction-cache.js';

async function silentProvider(bodyStarted: boolean) {
  const sockets = new Set<Socket>();
  const responses: ServerResponse[] = [];
  let receive!: () => void;
  const received = new Promise<void>((resolve) => { receive = resolve; });
  let release!: () => void;
  const transportClosed = new Promise<void>((resolve) => { release = resolve; });
  const server = createServer((_request, response) => {
    responses.push(response);
    response.once('close', release);
    if (bodyStarted) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"jsonrpc":"2.0",');
    }
    receive();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url, received, responses, transportClosed,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
}

void test('pinned block deadline options reject accessors without reading secret values', () => {
  let reads = 0;
  const options = { get requestTimeoutMs(): number { reads += 1; throw new Error('secret option'); } };
  const providers = createRpcProviderCatalog({ httpRpcUrl: 'http://localhost:8899', wsRpcUrl: 'ws://localhost:8899',
    httpRpcFallbackUrls: [], wsRpcFallbackUrls: [] });
  assert.throws(() => createProviderPinnedBlockRpc(providers, 'primary', 'confirmed', undefined, options),
    (error: unknown) => error instanceof ProviderPinnedBlockRpcError && error.reason === 'CONFIG_INVALID');
  assert.equal(reads, 0);
});

void test('standalone block cache close forwards cancellation to active pinned HTTP', async () => {
  const provider = await silentProvider(true);
  const rpc = source(provider.url, 10_000);
  const cache = new CachedSolanaBlockTransactionLocator({
    httpTransportEpoch: 0,
    getBlockTransactions: (slot, status, signal) => rpc.getBlockTransactions(slot, status, signal),
  });
  const operation = cache.locate({ signature: 'one', slot: 42n, confirmationStatus: 'CONFIRMED' })
    .then(() => 'RESOLVED', () => 'REJECTED');
  try {
    await provider.received;
    cache.close();
    assert.equal(await within(operation), 'REJECTED');
    assert.equal(cache.metrics.inFlightFetches, 0);
    assert.notEqual(await within(provider.transportClosed), 'STILL_PENDING');
  } finally { cache.close(); await provider.close(); await operation; }
});

function source(url: string, requestTimeoutMs: number) {
  const providers = createRpcProviderCatalog({
    httpRpcUrl: url, wsRpcUrl: url.replace('http:', 'ws:'),
    httpRpcFallbackUrls: [], wsRpcFallbackUrls: [],
  });
  return createProviderPinnedBlockRpc(providers, 'primary', 'confirmed', undefined, { requestTimeoutMs });
}

async function within<T>(operation: Promise<T>): Promise<T | 'STILL_PENDING'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<'STILL_PENDING'>((resolve) => {
      timer = setTimeout(() => { resolve('STILL_PENDING'); }, 750);
    })]);
  } finally { clearTimeout(timer); }
}

for (const bodyStarted of [false, true]) {
  void test(`pinned block deadline cancels real HTTP including bodyStarted=${bodyStarted}`, async () => {
    const provider = await silentProvider(bodyStarted);
    const rpc = source(provider.url, 100);
    const request = rpc.getBlockTransactions(42n, 'CONFIRMED').then(() => null, (error: unknown) => error);
    try {
      const error = await within(request);
      assert.ok(error instanceof ProviderPinnedBlockRpcError, 'request must reject before the test guard');
      assert.equal(error.reason, 'BLOCK_UNAVAILABLE');
      assert.equal(error.message.includes(provider.url), false);
      assert.notEqual(await within(provider.transportClosed), 'STILL_PENDING');
      assert.ok(provider.responses.every((response) => response.destroyed));
    } finally { await provider.close(); await request; }
  });
}

void test('pinned HTTP cancellation redacts primitive abort reasons accepted by AbortController', async () => {
  const provider = await silentProvider(false);
  const rpc = source(provider.url, 10_000);
  const controller = new AbortController();
  const operation = rpc.getBlockTransactions(42n, 'CONFIRMED', controller.signal)
    .then(() => null, (error: unknown) => error);
  try {
    await provider.received;
    controller.abort('secret primitive reason');
    const error = await within(operation);
    assert.ok(error instanceof ProviderPinnedBlockRpcError);
    assert.equal(error.reason, 'BLOCK_UNAVAILABLE');
    assert.equal(error.message.includes('secret'), false);
  } finally { await provider.close(); }
});

for (const action of ['scan-abort', 'close'] as const) {
  void test(`provider-affine ${action} reaches active HTTP and releases its fetch`, async () => {
    const provider = await silentProvider(true);
    const hydration = new ProviderAffineCatchUpHydration(new Map([['primary', source(provider.url, 10_000)]]), {
      currentSelection: () => ({ providerId: 'primary', revision: 1n }),
    });
    const controller = new AbortController();
    const operation = hydration.runStrictScan('primary', async (signal) => {
      await hydration.classifierLocator('primary').locate({ signature: 'one', slot: 42n, confirmationStatus: 'CONFIRMED' }, signal);
      throw new Error('silent server cannot return a block');
    }, controller.signal).then(() => 'RESOLVED', () => 'REJECTED');
    try {
      await provider.received;
      if (action === 'scan-abort') controller.abort(new Error('secret abort reason'));
      else hydration.close();
      assert.equal(await within(operation), 'REJECTED');
      assert.equal(hydration.metrics().inFlightFetches, 0);
      assert.equal(hydration.state().scanActive, false);
      assert.equal(hydration.canWorkerClaim(), action === 'scan-abort');
      assert.equal(hydration.metrics().retainedEntries, 0);
    } finally { hydration.close(); await provider.close(); await operation; }
  });
}
