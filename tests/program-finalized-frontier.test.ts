import assert from 'node:assert/strict';
import bs58 from 'bs58';
import test from 'node:test';
import { captureFinalizedProgramFrontier } from '../src/application/program-finalized-frontier.js';

void test('captures the first finalized signature returned for the requested program', async () => {
  const first = signature(11);
  const later = signature(10);
  const frontier = await captureFinalizedProgramFrontier('launchpad', async () => [
    { signature: first, slot: 800, err: null, confirmationStatus: 'finalized' },
    { signature: later, slot: 799, err: null, confirmationStatus: 'finalized' },
  ]);

  assert.deepEqual(frontier, {
    program: 'launchpad',
    signature: first,
    slot: 800n,
    confirmationStatus: 'finalized',
  });
});

void test('refuses an empty finalized signature page rather than inventing a frontier', async () => {
  await assert.rejects(
    captureFinalizedProgramFrontier('market', async () => []),
    { code: 'EMPTY_FINALIZED_PAGE' },
  );
});

void test('does not convert an RPC failure or a malformed signature into a frontier', async () => {
  await assert.rejects(
    captureFinalizedProgramFrontier('launchpad', async () => { throw new Error('rpc offline'); }),
    { code: 'FINALIZED_FRONTIER_RPC_ERROR' },
  );
  await assert.rejects(
    captureFinalizedProgramFrontier('market', async () => [
      { signature: signature(1), slot: 1, err: null, confirmationStatus: 'confirmed' },
    ]),
    { code: 'INVALID_FINALIZED_FRONTIER' },
  );
});

function signature(value: number): string {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(value, 60);
  return bs58.encode(bytes);
}
