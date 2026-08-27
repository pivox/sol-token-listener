import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import bs58 from 'bs58';
import {
  ProviderPinnedFinalityError,
  createProviderPinnedFinalityPass,
  type ProviderPinnedFinalityDependencies,
} from '../src/solana/rpc/provider-pinned-finality-source.js';
import type { RpcProviderCatalog } from '../src/solana/rpc/rpc-provider-catalog.js';
import type { FinalityProviderPass } from '../src/ports/finality-provider-pass.js';

const SIGNATURE = bs58.encode(Uint8Array.from({ length: 64 }, () => 7));

void test('resolves once, creates one direct RPC, and keeps all finality reads on it', async () => {
  const rpc = new FakeRpc();
  let resolved = 0;
  let created = 0;
  const pass: FinalityProviderPass = createProviderPinnedFinalityPass(
    catalog(() => {
      resolved += 1;
      return pair('https://provider-secret.invalid/rpc', 'fallback-1');
    }),
    'fallback-1',
    dependencies((url) => {
      created += 1;
      assert.equal(url, 'https://provider-secret.invalid/rpc');
      return rpc;
    }),
  );

  assert.equal(resolved, 1);
  assert.equal(created, 1);
  assert.deepEqual(Reflect.ownKeys(pass), ['providerId', 'getHistoryStatuses', 'getFinalizedSlot', 'getFinalizedBlockSignatures']);
  assert.equal(Object.isFrozen(pass), true);
  assert.equal(JSON.stringify(pass), '{"providerId":"fallback-1"}');

  assert.deepEqual(await pass.getHistoryStatuses(Object.freeze([SIGNATURE])), [
    { slot: 42n, confirmationStatus: 'finalized' },
  ]);
  assert.equal(await pass.getFinalizedSlot(), 99n);
  assert.deepEqual(await pass.getFinalizedBlockSignatures(88n), [SIGNATURE]);
  assert.deepEqual(rpc.calls, [
    ['history', [SIGNATURE], { searchTransactionHistory: true }],
    ['slot', 'finalized'],
    ['block', 88, 'finalized'],
  ]);
});

void test('accepts 256 canonical history signatures and rejects empty, oversized, mutable, sparse, accessor, and noncanonical inputs', async () => {
  const rpc = new FakeRpc();
  const pass = createProviderPinnedFinalityPass(catalog(), 'primary', dependencies(() => rpc));
  const accepted = Object.freeze(Array.from({ length: 256 }, () => SIGNATURE));
  rpc.historyResponse = { value: Array.from({ length: 256 }, () => ({ slot: 42, confirmationStatus: 'finalized' })) };
  const values = await pass.getHistoryStatuses(accepted) as readonly unknown[];
  assert.equal(values.length, 256);
  assert.equal(rpc.calls.length, 1);

  const sparse = new Array<string>(1);
  const accessor: string[] = [];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { throw new Error('accessor-secret'); } });
  accessor.length = 1;
  const hostile = new Proxy(Object.freeze([SIGNATURE]), {
    getPrototypeOf() { throw new Error('proxy-secret'); },
  });
  for (const value of [
    Object.freeze([]),
    Object.freeze(Array.from({ length: 257 }, () => SIGNATURE)),
    [SIGNATURE],
    sparse,
    accessor,
    hostile,
    Object.freeze(['not-a-signature']),
  ]) {
    await assert.rejects(pass.getHistoryStatuses(value), (error: unknown) => invalid(error, 'CONFIG_INVALID'));
  }
});

void test('validates and freezes detached history, root, and block evidence', async () => {
  const rpc = new FakeRpc();
  const statuses = [{ slot: 3, confirmationStatus: 'confirmed' as const }];
  const signatures = [SIGNATURE];
  rpc.historyResponse = { value: statuses };
  rpc.blockResponse = { signatures };
  const pass = createProviderPinnedFinalityPass(catalog(), 'primary', dependencies(() => rpc));

  const history = await pass.getHistoryStatuses(Object.freeze([SIGNATURE]));
  const block = await pass.getFinalizedBlockSignatures(2n);
  const firstStatus = statuses[0];
  assert.ok(firstStatus !== undefined);
  firstStatus.slot = 9;
  signatures[0] = bs58.encode(Uint8Array.from({ length: 64 }, () => 8));
  assert.deepEqual(history, [{ slot: 3n, confirmationStatus: 'confirmed' }]);
  assert.deepEqual(block, [SIGNATURE]);
  assert.equal(Object.isFrozen(history), true);
  assert.equal(Object.isFrozen(history[0]), true);
  assert.equal(Object.isFrozen(block), true);
  assert.throws(() => { (history as unknown as unknown[]).push(null); });
  assert.throws(() => { (block as string[])[0] = SIGNATURE; });
  assert.equal(await pass.getFinalizedSlot(), 99n);
});

void test('rejects negative-zero history slots as fixed unavailable evidence', async () => {
  const rpc = new FakeRpc();
  rpc.historyResponse = {
    value: [{ slot: -0, confirmationStatus: 'finalized', remote: 'history-slot-secret' }],
  };
  const pass = createProviderPinnedFinalityPass(catalog(), 'primary', dependencies(() => rpc));

  await assert.rejects(pass.getHistoryStatuses(Object.freeze([SIGNATURE])), (error: unknown) => {
    invalid(error, 'HISTORY_UNAVAILABLE');
    assert.equal(Object.hasOwn(error as object, 'cause'), false);
    assert.doesNotMatch(JSON.stringify(error), /history-slot-secret/u);
    return true;
  });
});

void test('rejects a negative-zero finalized root as fixed unavailable evidence', async () => {
  const rpc = new FakeRpc();
  rpc.slotResponse = -0;
  const pass = createProviderPinnedFinalityPass(catalog(), 'primary', dependencies(() => rpc));

  await assert.rejects(pass.getFinalizedSlot(), (error: unknown) => {
    invalid(error, 'ROOT_UNAVAILABLE');
    assert.equal(Object.hasOwn(error as object, 'cause'), false);
    return true;
  });
});

void test('rejects invalid bigint block slots before RPC use', async () => {
  const rpc = new FakeRpc();
  const pass = createProviderPinnedFinalityPass(catalog(), 'primary', dependencies(() => rpc));
  for (const slot of [-1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
    await assert.rejects(pass.getFinalizedBlockSignatures(slot), (error: unknown) => invalid(error, 'CONFIG_INVALID'));
  }
  assert.equal(rpc.calls.length, 0);
});

void test('accepts an empty block and rejects oversized, sparse, duplicate, noncanonical, and non-64-byte block signatures', async () => {
  const rpc = new FakeRpc();
  const pass = createProviderPinnedFinalityPass(catalog(), 'primary', dependencies(() => rpc));
  rpc.blockResponse = { signatures: [] };
  assert.deepEqual(await pass.getFinalizedBlockSignatures(1n), []);
  const maximum = Array.from({ length: 10_000 }, (_, index) => signatureAt(index));
  rpc.blockResponse = { signatures: maximum };
  assert.deepEqual(await pass.getFinalizedBlockSignatures(1n), maximum);
  const oversized = [...maximum, signatureAt(10_000)];
  const sparse = new Array<string>(1);
  for (const signatures of [
    oversized,
    sparse,
    [SIGNATURE, SIGNATURE],
    ['0'.repeat(64)],
    [bs58.encode(Uint8Array.from({ length: 63 }, () => 1))],
  ]) {
    rpc.blockResponse = { signatures };
    await assert.rejects(pass.getFinalizedBlockSignatures(1n), (error: unknown) => invalid(error, 'BLOCK_UNAVAILABLE'));
  }
});

void test('maps rejected, null, malformed, and hostile remote values to fixed redacted operation errors', async () => {
  const secret = 'provider-secret.invalid';
  const rpc = new FakeRpc();
  const pass = createProviderPinnedFinalityPass(
    catalog(() => pair(`https://${secret}/rpc`)), 'primary', dependencies(() => rpc),
  );
  const scenarios: readonly [keyof FakeRpc, unknown, () => Promise<unknown>, string][] = [
    ['historyResponse', new Error(`https://${secret}/history`), () => pass.getHistoryStatuses(Object.freeze([SIGNATURE])), 'HISTORY_UNAVAILABLE'],
    ['slotResponse', -1, () => pass.getFinalizedSlot(), 'ROOT_UNAVAILABLE'],
    ['blockResponse', null, () => pass.getFinalizedBlockSignatures(1n), 'BLOCK_UNAVAILABLE'],
    ['historyResponse', { get value() { throw new Error(secret); } }, () => pass.getHistoryStatuses(Object.freeze([SIGNATURE])), 'HISTORY_UNAVAILABLE'],
  ];
  for (const [key, value, operation, reason] of scenarios) {
    (rpc as unknown as Record<string, unknown>)[key] = value;
    await assert.rejects(operation(), (error: unknown) => {
      invalid(error, reason);
      assert.doesNotMatch(String(error), /provider-secret|https|history/i);
      assert.equal(Object.hasOwn(error as object, 'cause'), false);
      return true;
    });
  }
});

void test('does not import failover or execution boundaries and does not expose URL or RPC internals', async () => {
  const sourcePath = new URL('../src/solana/rpc/provider-pinned-finality-source.ts', import.meta.url);
  const source = await readFile(sourcePath, 'utf8');
  assert.doesNotMatch(source, /http-failover-transport|createRpcHttpFailoverFetch/u);
  assert.doesNotMatch(source, /(?:submission|wallet|signer)/iu);
  const pass = createProviderPinnedFinalityPass(catalog(() => pair('https://url-secret.invalid/rpc')), 'primary', dependencies(() => new FakeRpc()));
  assert.doesNotMatch(JSON.stringify(pass), /url-secret|rpc/i);
});

function dependencies(createRpc: (httpUrl: string) => unknown): ProviderPinnedFinalityDependencies {
  return Object.freeze({ createRpc });
}

function catalog(resolve: () => { id: 'primary' | 'fallback-1'; httpUrl: string; websocketUrl: string } = pair): RpcProviderCatalog {
  return Object.freeze({ ids: Object.freeze(['primary'] as const), resolve: () => resolve() });
}

function pair(httpUrl = 'https://provider.invalid/rpc', id: 'primary' | 'fallback-1' = 'primary') {
  return Object.freeze({ id, httpUrl, websocketUrl: 'wss://provider.invalid/rpc' });
}

function signatureAt(index: number): string {
  const bytes = new Uint8Array(64);
  bytes[0] = Math.floor(index / 256);
  bytes[1] = index % 256;
  return bs58.encode(bytes);
}

class FakeRpc {
  public readonly calls: unknown[] = [];
  public historyResponse: unknown = { value: [{ slot: 42, confirmationStatus: 'finalized' }] };
  public slotResponse: unknown = 99;
  public blockResponse: unknown = { signatures: [SIGNATURE] };

  public async getSignatureStatuses(signatures: readonly string[], options: unknown): Promise<unknown> {
    this.calls.push(['history', [...signatures], options]);
    if (this.historyResponse instanceof Error) throw this.historyResponse;
    return this.historyResponse;
  }

  public async getSlot(commitment: unknown): Promise<unknown> {
    this.calls.push(['slot', commitment]);
    if (this.slotResponse instanceof Error) throw this.slotResponse;
    return this.slotResponse;
  }

  public async getBlockSignatures(slot: number, commitment: unknown): Promise<unknown> {
    this.calls.push(['block', slot, commitment]);
    if (this.blockResponse instanceof Error) throw this.blockResponse;
    return this.blockResponse;
  }
}

function invalid(error: unknown, reason: string): boolean {
  assert.ok(error instanceof ProviderPinnedFinalityError);
  assert.equal(error.reason, reason);
  assert.equal(error.message, 'Provider-pinned finality pass failed.');
  assert.equal(Object.isFrozen(error), true);
  assert.deepEqual(Object.keys(error), ['reason', 'providerId']);
  return true;
}
