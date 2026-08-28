import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import bs58 from 'bs58';
import { canonicalSolanaGenesisHash } from '../src/domain/solana-genesis-hash.js';
import type { Commitment, PublicKey } from '@solana/web3.js';
import {
  ProviderPinnedCatchUpSourceError,
  createProviderPinnedCatchUpSource,
  type ProviderPinnedCatchUpSourceDependencies,
} from '../src/solana/rpc/provider-pinned-catch-up-source.js';
import type { RpcProviderCatalog } from '../src/solana/rpc/rpc-provider-catalog.js';
import type { CatchUpSource as LegacyCatchUpSource } from '../src/application/catch-up-scanner.js';
import type { CatchUpSource as CanonicalCatchUpSource } from '../src/ports/catch-up-source.js';
import { executionBoundaryViolations } from './helpers/execution-boundary.js';

const PROGRAM = '11111111111111111111111111111111';
const EXPECTED_GENESIS = genesis(7);
const execFileAsync = promisify(execFile);

void test('resolves once, creates one fixed RPC, validates genesis before signatures, and reuses it for pages', async () => {
  const events: string[] = [];
  const rpc = new FakeRpc(events, EXPECTED_GENESIS, [page('one'), page('two')]);
  let resolved = 0;
  let created = 0;
  const source = createProviderPinnedCatchUpSource(catalog(() => {
    resolved += 1;
    return pair('https://provider-secret.invalid/rpc', 'fallback-1');
  }), 'fallback-1', 'confirmed', EXPECTED_GENESIS, dependencies((url, commitment) => {
    created += 1;
    assert.equal(url, 'https://provider-secret.invalid/rpc');
    assert.equal(commitment, 'confirmed');
    return rpc;
  }));

  assert.equal(resolved, 1);
  assert.equal(created, 1);
  assert.deepEqual(Object.keys(source), ['providerId', 'list']);
  assert.equal(JSON.stringify(source), '{"providerId":"fallback-1"}');
  assert.doesNotMatch(JSON.stringify(source), /provider-secret|rpc/i);

  assert.deepEqual(await source.list(PROGRAM, undefined, 2), [signature('one')]);
  assert.deepEqual(await source.list(PROGRAM, 'one', 2), [signature('two')]);
  assert.deepEqual(events, ['genesis', 'signatures', 'signatures']);
  assert.deepEqual(rpc.calls, [
    [PROGRAM, undefined, 2, 'confirmed'],
    [PROGRAM, 'one', 2, 'confirmed'],
  ]);
});

void test('shares one in-flight genesis verification between concurrent first pages', async () => {
  let releaseGenesis: (() => void) | undefined;
  const genesisGate = new Promise<void>((resolve) => { releaseGenesis = resolve; });
  const rpc = new FakeRpc([], EXPECTED_GENESIS, [page('one'), page('two')], genesisGate);
  const source = createProviderPinnedCatchUpSource(
    catalog(), 'primary', 'confirmed', EXPECTED_GENESIS, dependencies(() => rpc),
  );
  const first = source.list(PROGRAM, undefined, 1);
  const second = source.list(PROGRAM, 'before', 1);
  await Promise.resolve();
  assert.equal(rpc.genesisCalls, 1);
  assert.equal(rpc.calls.length, 0);
  releaseGenesis?.();
  await Promise.all([first, second]);
  assert.equal(rpc.genesisCalls, 1);
  assert.equal(rpc.calls.length, 2);
});

void test('shares the neutral catch-up source contract with the legacy scanner export', () => {
  const pinned: CanonicalCatchUpSource = createProviderPinnedCatchUpSource(
    catalog(), 'primary', 'confirmed', EXPECTED_GENESIS, dependencies(() => new FakeRpc([], EXPECTED_GENESIS, [])),
  );
  const legacy: LegacyCatchUpSource = pinned;
  assert.equal(typeof legacy.list, 'function');
});

void test('uses the default Connection against only the selected URL with no internal 429 retry', async () => {
  const selectedUrl = 'https://selected-provider.invalid/rpc';
  const fallbackUrl = 'https://fallback-provider.invalid/rpc';
  const script = `
const expectedGenesis = ${JSON.stringify(EXPECTED_GENESIS)};
const selectedUrl = ${JSON.stringify(selectedUrl)};
const fallbackUrl = ${JSON.stringify(fallbackUrl)};
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const calls = [];
try {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const request = JSON.parse(String(init?.body));
      calls.push({ url, method: request.method, params: request.params });
      if (request.method === 'getGenesisHash') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: expectedGenesis }), { status: 200 });
      }
      return new Response('limited', { status: 429, statusText: 'Too Many Requests' });
    },
  });
  const { createProviderPinnedCatchUpSource } = await import('./src/solana/rpc/provider-pinned-catch-up-source.ts');
  const catalog = Object.freeze({
    ids: Object.freeze(['fallback-1']),
    resolve: (id) => Object.freeze({ id, httpUrl: selectedUrl, websocketUrl: fallbackUrl }),
  });
  const source = createProviderPinnedCatchUpSource(catalog, 'fallback-1', 'confirmed', expectedGenesis);
  try { await source.list('11111111111111111111111111111111', undefined, 1); } catch {}
  process.stdout.write(JSON.stringify(calls));
} finally {
  if (originalFetch === undefined) delete globalThis.fetch;
  else Object.defineProperty(globalThis, 'fetch', originalFetch);
}
`;
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', script,
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  const calls = JSON.parse(stdout) as readonly {
    readonly url: string;
    readonly method: string;
    readonly params: readonly unknown[];
  }[];

  assert.deepEqual(calls.map(({ url }) => url), [selectedUrl, selectedUrl]);
  assert.equal(calls.filter(({ url }) => url === fallbackUrl).length, 0);
  assert.deepEqual(calls.map(({ method }) => method), ['getGenesisHash', 'getSignaturesForAddress']);
  assert.deepEqual(calls[1]?.params, [PROGRAM, { commitment: 'confirmed', limit: 1 }]);
});

void test('rejects malformed, noncanonical, and non-32-byte expected genesis values before catalog or RPC use', () => {
  const values = [
    bs58.encode(Uint8Array.from({ length: 31 }, () => 1)),
    bs58.encode(Uint8Array.from({ length: 33 }, () => 1)),
    `${EXPECTED_GENESIS.slice(0, -1)}0`,
    'not base58 0',
  ];
  for (const value of values) {
    let resolved = 0;
    assert.throws(() => createProviderPinnedCatchUpSource(
      catalog(() => { resolved += 1; return pair(); }), 'primary', 'confirmed', value,
    ), (error: unknown) => invalid(error, 'CONFIG_INVALID', 'primary'));
    assert.equal(resolved, 0);
  }
});

void test('uses the shared canonical genesis validator for the configured expected hash', () => {
  assert.equal(canonicalSolanaGenesisHash(EXPECTED_GENESIS), true);
  assert.equal(canonicalSolanaGenesisHash(`${EXPECTED_GENESIS.slice(0, -1)}0`), false);
});

void test('rejects oversized and forbidden expected hashes before base58 decoding', () => {
  const originalDecode = bs58.decode;
  let decodeCalls = 0;
  Object.defineProperty(bs58, 'decode', {
    configurable: true,
    value: ((value: string) => {
      decodeCalls += 1;
      return originalDecode(value);
    }) satisfies typeof bs58.decode,
  });
  try {
    for (const value of ['1'.repeat(10_000), `${'1'.repeat(31)}0`]) {
      let resolved = 0;
      assert.throws(() => createProviderPinnedCatchUpSource(
        catalog(() => { resolved += 1; return pair(); }), 'primary', 'confirmed', value,
      ), (error: unknown) => invalid(error, 'CONFIG_INVALID', 'primary'));
      assert.equal(resolved, 0);
    }
    assert.equal(decodeCalls, 0);
  } finally {
    Object.defineProperty(bs58, 'decode', { configurable: true, value: originalDecode });
  }
});

void test('rejects oversized and forbidden RPC hashes before base58 decoding or signatures', async () => {
  const originalDecode = bs58.decode;
  let decodeCalls = 0;
  Object.defineProperty(bs58, 'decode', {
    configurable: true,
    value: ((value: string) => {
      decodeCalls += 1;
      return originalDecode(value);
    }) satisfies typeof bs58.decode,
  });
  try {
    for (const actualGenesis of ['1'.repeat(10_000), `${'1'.repeat(31)}0`]) {
      const rpc = new FakeRpc([], actualGenesis, [page('never')]);
      const source = createProviderPinnedCatchUpSource(
        catalog(), 'primary', 'confirmed', EXPECTED_GENESIS, dependencies(() => rpc),
      );
      decodeCalls = 0;
      await assert.rejects(source.list(PROGRAM, undefined, 1), (error: unknown) => (
        invalid(error, 'GENESIS_UNAVAILABLE', 'primary')
      ));
      assert.equal(decodeCalls, 0);
      assert.equal(rpc.calls.length, 0);
    }
  } finally {
    Object.defineProperty(bs58, 'decode', { configurable: true, value: originalDecode });
  }
});

void test('reports a malformed actual genesis response as a fixed redacted unavailable error without signatures', async () => {
  const secret = 'provider-secret.invalid';
  const rpc = new FakeRpc([], `1${EXPECTED_GENESIS}`, [page('never')]);
  const source = createProviderPinnedCatchUpSource(
    catalog(() => pair(`https://${secret}/rpc`, 'fallback-2')), 'fallback-2', 'confirmed', EXPECTED_GENESIS,
    dependencies(() => rpc),
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(source.list(PROGRAM, undefined, 1), (error: unknown) => {
      invalid(error, 'GENESIS_UNAVAILABLE', 'fallback-2');
      assert.doesNotMatch(JSON.stringify(error), /provider-secret|https|rpc/i);
      return true;
    });
  }
  assert.equal(rpc.genesisCalls, 2);
  assert.equal(rpc.calls.length, 0);
});

void test('reports a valid unequal genesis hash as a fixed mismatch error and retries validation later', async () => {
  const rpc = new FakeRpc([], genesis(8), [page('never')]);
  const source = createProviderPinnedCatchUpSource(
    catalog(), 'primary', 'confirmed', EXPECTED_GENESIS, dependencies(() => rpc),
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(source.list(PROGRAM, undefined, 1), (error: unknown) => {
      invalid(error, 'GENESIS_MISMATCH', 'primary');
      return true;
    });
  }
  assert.equal(rpc.genesisCalls, 2);
  assert.equal(rpc.calls.length, 0);
});

void test('redacts a throwing genesis request, shares only the attempt, and retries later', async () => {
  const secret = 'throwing-provider-secret.invalid';
  const rpc = new FakeRpc([], EXPECTED_GENESIS, [], undefined, new Error(`https://${secret}/boom`));
  const source = createProviderPinnedCatchUpSource(
    catalog(() => pair(`https://${secret}/rpc`)), 'primary', 'confirmed', EXPECTED_GENESIS,
    dependencies(() => rpc),
  );
  const failures = await Promise.allSettled([
    source.list(PROGRAM, undefined, 1), source.list(PROGRAM, 'cursor', 1),
  ]);
  for (const failure of failures) {
    assert.equal(failure.status, 'rejected');
    if (failure.status === 'rejected') {
      invalid(failure.reason, 'GENESIS_UNAVAILABLE', 'primary');
      assert.doesNotMatch(String(failure.reason), /throwing-provider-secret|https/i);
    }
  }
  assert.equal(rpc.genesisCalls, 1);
  assert.equal(rpc.calls.length, 0);

  await assert.rejects(source.list(PROGRAM, undefined, 1), (error: unknown) => (
    invalid(error, 'GENESIS_UNAVAILABLE', 'primary')
  ));
  assert.equal(rpc.genesisCalls, 2);
  assert.equal(rpc.calls.length, 0);
});

void test('retries a transient genesis failure and caches only the later successful validation', async () => {
  const events: string[] = [];
  const rpc = new FakeRpc(
    events,
    EXPECTED_GENESIS,
    [page('after-retry'), page('cached-success')],
    undefined,
    (attempt) => attempt === 1 ? new Error('transient-provider-secret') : undefined,
  );
  const source = createProviderPinnedCatchUpSource(
    catalog(), 'primary', 'confirmed', EXPECTED_GENESIS, dependencies(() => rpc),
  );

  await assert.rejects(source.list(PROGRAM, undefined, 1), (error: unknown) => (
    invalid(error, 'GENESIS_UNAVAILABLE', 'primary')
  ));
  assert.deepEqual(await source.list(PROGRAM, undefined, 1), [signature('after-retry')]);
  assert.deepEqual(await source.list(PROGRAM, 'after-retry', 1), [signature('cached-success')]);
  assert.equal(rpc.genesisCalls, 2);
  assert.deepEqual(events, ['genesis', 'genesis', 'signatures', 'signatures']);
});

void test('preserves fixed redacted page failures from the normalizing source', async () => {
  const rpc = new FakeRpc([], EXPECTED_GENESIS, [[{ signature: 'bad', slot: -1, confirmationStatus: 'confirmed', blockTime: null }]]);
  const source = createProviderPinnedCatchUpSource(
    catalog(), 'primary', 'confirmed', EXPECTED_GENESIS, dependencies(() => rpc),
  );
  await assert.rejects(source.list(PROGRAM, undefined, 1), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'CatchUpSourceError');
    assert.equal(error.message, 'Catch-up RPC source failed.');
    assert.equal(Object.isFrozen(error), true);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
});

void test('treats hostile catalog, pair, RPC, and dependency inputs as fixed configuration failures', () => {
  const secret = 'hostile-secret.invalid';
  const invalidInputs: readonly [RpcProviderCatalog, ProviderPinnedCatchUpSourceDependencies | undefined][] = [
    [catalog(() => { throw new Error(`https://${secret}/catalog`); }), undefined],
    [catalog(() => ({ id: 'primary', httpUrl: `ftp://${secret}`, websocketUrl: 'wss://unused' }) as never), undefined],
    [catalog(), { get createRpc() { throw new Error(secret); } } as never],
    [catalog(), { createRpc: () => ({ getGenesisHash: () => EXPECTED_GENESIS }) } as never],
  ];
  for (const [inputCatalog, inputDependencies] of invalidInputs) {
    assert.throws(() => createProviderPinnedCatchUpSource(
      inputCatalog, 'primary', 'confirmed', EXPECTED_GENESIS, inputDependencies,
    ), (error: unknown) => {
      invalid(error, 'CONFIG_INVALID', 'primary');
      assert.doesNotMatch(String(error), /hostile-secret|https/i);
      return true;
    });
  }
});

void test('does not import the HTTP failover transport or expose URL and RPC internals', async () => {
  const sourcePath = new URL('../src/solana/rpc/provider-pinned-catch-up-source.ts', import.meta.url);
  const content = await readFile(sourcePath, 'utf8');
  assert.doesNotMatch(content, /http-failover-transport/u);
  assert.doesNotMatch(content, /from ['"]\.\.\/\.\.\/application\//u);
  const source = createProviderPinnedCatchUpSource(
    catalog(() => pair('https://url-secret.invalid/rpc')), 'primary', 'confirmed', EXPECTED_GENESIS,
    dependencies(() => new FakeRpc([], EXPECTED_GENESIS, [])),
  );
  assert.deepEqual(Reflect.ownKeys(source), ['providerId', 'list']);
  assert.doesNotMatch(JSON.stringify(source), /url-secret|rpc/i);
});

void test('keeps the provider-pinned source outside signing, submission, and wallet boundaries', async () => {
  const sourceUrl = new URL('../src/solana/rpc/provider-pinned-catch-up-source.ts', import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  assert.deepEqual(executionBoundaryViolations(source, fileURLToPath(sourceUrl), repositoryRoot), []);
});

function dependencies(
  createRpc: (httpUrl: string, commitment: Commitment) => FakeRpc,
): ProviderPinnedCatchUpSourceDependencies {
  return Object.freeze({ createRpc });
}

function catalog(
  resolve: () => {
    id: 'primary' | 'fallback-1' | 'fallback-2' | 'fallback-3';
    httpUrl: string;
    websocketUrl: string;
  } = pair,
): RpcProviderCatalog {
  return Object.freeze({ ids: Object.freeze(['primary'] as const), resolve: () => resolve() });
}

function pair(
  httpUrl = 'https://provider.invalid/rpc',
  id: 'primary' | 'fallback-1' | 'fallback-2' | 'fallback-3' = 'primary',
) {
  return Object.freeze({ id, httpUrl, websocketUrl: 'wss://provider.invalid/rpc' });
}

function genesis(byte: number): string {
  return bs58.encode(Uint8Array.from({ length: 32 }, () => byte));
}

function signature(value: string) {
  return Object.freeze({ signature: value, slot: 1n, confirmationStatus: 'confirmed' as const, blockTimeMs: 1_000 });
}

function page(value: string) {
  return Object.freeze([{ signature: value, slot: 1, confirmationStatus: 'confirmed', blockTime: 1 }]);
}

class FakeRpc {
  public readonly calls: [string, string | undefined, number, Commitment][] = [];
  public genesisCalls = 0;
  private readonly pages: unknown[];

  public constructor(
    private readonly events: string[],
    private readonly actualGenesis: unknown,
    pages: unknown[],
    private readonly genesisGate?: Promise<void>,
    private readonly genesisFailure?: Error | ((attempt: number) => Error | undefined),
  ) {
    this.pages = [...pages];
  }

  public async getGenesisHash(): Promise<unknown> {
    this.genesisCalls += 1;
    this.events.push('genesis');
    await this.genesisGate;
    const failure = typeof this.genesisFailure === 'function'
      ? this.genesisFailure(this.genesisCalls)
      : this.genesisFailure;
    if (failure !== undefined) throw failure;
    return this.actualGenesis;
  }

  public async getSignaturesForAddress(
    address: PublicKey,
    options: { readonly before: string | undefined; readonly limit: number },
    commitment: Commitment,
  ): Promise<unknown> {
    this.events.push('signatures');
    this.calls.push([address.toBase58(), options.before, options.limit, commitment]);
    return this.pages.shift() ?? [];
  }
}

function invalid(error: unknown, reason: string, providerId: string | null = null): boolean {
  assert.ok(error instanceof ProviderPinnedCatchUpSourceError);
  assert.equal(error.reason, reason);
  assert.equal(error.providerId, providerId);
  assert.equal(error.message, 'Provider-pinned catch-up source failed.');
  assert.equal(Object.isFrozen(error), true);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.deepEqual(Object.keys(error), ['reason', 'providerId']);
  return true;
}
