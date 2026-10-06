import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicKey } from '@solana/web3.js';
import { CatchUpSourceError } from '../src/solana/rpc/catch-up-source.js';
import { PoolSignatureSource } from '../src/solana/rpc/pool-signature-source.js';

const POOL = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const SIG = '5'.repeat(88);

function row(slot: number, status = 'finalized'): unknown {
  return { signature: SIG.slice(0, 87) + String((slot % 9) + 1), slot, err: null, memo: null, blockTime: null, confirmationStatus: status };
}

void test('reads finalized signatures with before and until', async () => {
  const calls: unknown[] = [];
  const source = new PoolSignatureSource({
    async getSignaturesForAddress(address: PublicKey, options: unknown, commitment: string) {
      calls.push([address.toBase58(), options, commitment]);
      return [row(10)];
    },
  });
  const page = await source.list(POOL, { before: undefined, until: 'until-sig' }, 1_000);
  assert.equal(page.length, 1);
  assert.equal(page[0]?.slot, 10n);
  assert.deepEqual(calls, [[POOL, { before: undefined, until: 'until-sig', limit: 1_000 }, 'finalized']]);
});

void test('rejects a non-finalized row', async () => {
  const source = new PoolSignatureSource({ async getSignaturesForAddress() { return [row(10, 'confirmed')]; } });
  await assert.rejects(source.list(POOL, { before: undefined, until: 'x' }, 10), CatchUpSourceError);
});

void test('wraps RPC failures and invalid pool addresses', async () => {
  const failing = new PoolSignatureSource({ async getSignaturesForAddress() { throw new Error('429'); } });
  await assert.rejects(failing.list(POOL, { before: undefined, until: 'x' }, 10), CatchUpSourceError);
  await assert.rejects(failing.list('not-a-key', { before: undefined, until: 'x' }, 10), CatchUpSourceError);
});

void test('passes an undefined until through to the RPC', async () => {
  const calls: unknown[] = [];
  const source = new PoolSignatureSource({
    async getSignaturesForAddress(_address: PublicKey, options: unknown) {
      calls.push(options);
      return [];
    },
  });
  await source.list(POOL, { before: 'b', until: undefined }, 1);
  assert.deepEqual(calls, [{ before: 'b', until: undefined, limit: 1 }]);
});

void test('rejects invalid requests without calling the RPC', async () => {
  let rpcCalls = 0;
  const source = new PoolSignatureSource({
    async getSignaturesForAddress() {
      rpcCalls += 1;
      return [];
    },
  });
  const invalid: [{ before: string | undefined; until: string | undefined }, number][] = [
    [{ before: undefined, until: 'x' }, 0],
    [{ before: undefined, until: 'x' }, 1_001],
    [{ before: undefined, until: 'x' }, 1.5],
    [{ before: undefined, until: 'x' }, Number.NaN],
    [{ before: undefined, until: '' }, 10],
    [{ before: '', until: 'x' }, 10],
    [{ before: 'a'.repeat(129), until: 'x' }, 10],
    [{ before: undefined, until: 'a'.repeat(129) }, 10],
    [{ before: 'é'.repeat(65), until: 'x' }, 10],
  ];
  for (const [cursor, limit] of invalid) {
    await assert.rejects(source.list(POOL, cursor, limit), (error: unknown) =>
      error instanceof CatchUpSourceError && error.stage === 'request');
  }
  assert.equal(rpcCalls, 0);
});
