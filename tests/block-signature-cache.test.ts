import assert from 'node:assert/strict';
import test from 'node:test';
import { CachedBlockSignatureRpc } from '../src/solana/rpc/block-signature-cache.js';

type Status = 'CONFIRMED' | 'FINALIZED';

function fakeRpc(results: (slot: bigint, status: Status) => Promise<readonly string[] | null>) {
  const calls: string[] = [];
  return {
    calls,
    rpc: {
      getTransaction: async () => null,
      getBlockSignatures: async (slot: bigint, status: Status) => {
        calls.push(`${slot}:${status}`);
        return results(slot, status);
      },
    },
  };
}

void test('fetches each slot and commitment once across sequential lookups', async () => {
  const { calls, rpc } = fakeRpc(async (slot) => Object.freeze([`sig-${slot}`]));
  const cached = new CachedBlockSignatureRpc(rpc, { maxSlots: 8 });

  assert.deepEqual(await cached.getBlockSignatures(42n, 'CONFIRMED'), ['sig-42']);
  assert.deepEqual(await cached.getBlockSignatures(42n, 'CONFIRMED'), ['sig-42']);
  assert.deepEqual(await cached.getBlockSignatures(42n, 'FINALIZED'), ['sig-42']);

  assert.deepEqual(calls, ['42:CONFIRMED', '42:FINALIZED']);
});

void test('shares one in-flight request between concurrent lookups of the same slot', async () => {
  let release: (value: readonly string[]) => void = () => undefined;
  const { calls, rpc } = fakeRpc(() => new Promise((resolve) => { release = resolve; }));
  const cached = new CachedBlockSignatureRpc(rpc, { maxSlots: 8 });

  const first = cached.getBlockSignatures(7n, 'CONFIRMED');
  const second = cached.getBlockSignatures(7n, 'CONFIRMED');
  release(Object.freeze(['a']));

  assert.deepEqual(await first, ['a']);
  assert.deepEqual(await second, ['a']);
  assert.equal(calls.length, 1);
});

void test('does not cache unavailable blocks or failures', async () => {
  let attempt = 0;
  const { calls, rpc } = fakeRpc(async () => {
    attempt += 1;
    if (attempt === 1) return null;
    if (attempt === 2) throw new Error('429');
    return Object.freeze(['ok']);
  });
  const cached = new CachedBlockSignatureRpc(rpc, { maxSlots: 8 });

  assert.equal(await cached.getBlockSignatures(9n, 'CONFIRMED'), null);
  await assert.rejects(cached.getBlockSignatures(9n, 'CONFIRMED'), /429/u);
  assert.deepEqual(await cached.getBlockSignatures(9n, 'CONFIRMED'), ['ok']);
  assert.equal(calls.length, 3);
});

void test('evicts the least recently used slot beyond capacity', async () => {
  const { calls, rpc } = fakeRpc(async (slot) => Object.freeze([`sig-${slot}`]));
  const cached = new CachedBlockSignatureRpc(rpc, { maxSlots: 2 });

  await cached.getBlockSignatures(1n, 'CONFIRMED');
  await cached.getBlockSignatures(2n, 'CONFIRMED');
  await cached.getBlockSignatures(1n, 'CONFIRMED');
  await cached.getBlockSignatures(3n, 'CONFIRMED');
  await cached.getBlockSignatures(1n, 'CONFIRMED');
  await cached.getBlockSignatures(2n, 'CONFIRMED');

  assert.deepEqual(calls, ['1:CONFIRMED', '2:CONFIRMED', '3:CONFIRMED', '2:CONFIRMED']);
});

void test('reports hits and misses', async () => {
  const { rpc } = fakeRpc(async () => Object.freeze(['x']));
  const cached = new CachedBlockSignatureRpc(rpc, { maxSlots: 4 });

  await cached.getBlockSignatures(5n, 'CONFIRMED');
  await cached.getBlockSignatures(5n, 'CONFIRMED');
  await cached.getBlockSignatures(5n, 'CONFIRMED');

  assert.deepEqual(cached.metrics(), { hits: 2, misses: 1 });
});

void test('rejects an invalid capacity', () => {
  const { rpc } = fakeRpc(async () => null);
  assert.throws(() => new CachedBlockSignatureRpc(rpc, { maxSlots: 0 }), TypeError);
});
