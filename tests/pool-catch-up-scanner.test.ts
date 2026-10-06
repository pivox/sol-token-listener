import assert from 'node:assert/strict';
import test from 'node:test';
import type { TransactionNotification } from '../src/domain/transaction-ingestion.js';
import {
  PoolCatchUpScanner,
  PoolCatchUpWindowExceededError,
  PoolCheckpointMissingError,
  PoolCheckpointNotFoundError,
} from '../src/application/pool-catch-up-scanner.js';
import { CatchUpSourceError, type CatchUpSignature } from '../src/solana/rpc/catch-up-source.js';
import type { PoolSignatureCursor } from '../src/solana/rpc/pool-signature-source.js';
import type { PoolCheckpoint } from '../src/storage/market-pool-tracking.repository.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';

function sig(slot: number, signature = `sig-${slot}`): CatchUpSignature {
  return Object.freeze({ signature, slot: BigInt(slot), confirmationStatus: 'finalized', blockTimeMs: null });
}

type ListCall = [string, PoolSignatureCursor, number];

function harness(
  pages: readonly (readonly CatchUpSignature[])[],
  checkpoint: unknown,
  probe: readonly CatchUpSignature[] = [sig(5)],
) {
  const listCalls: ListCall[] = [];
  const probeCalls: ListCall[] = [];
  const enqueued: TransactionNotification[] = [];
  const stored: unknown[] = [];
  let pageIndex = 0;
  const scanner = new PoolCatchUpScanner(
    {
      async list(pool, cursor, limit) {
        if (limit === 1 && cursor.until === undefined) {
          probeCalls.push([pool, cursor, limit]);
          return probe;
        }
        listCalls.push([pool, cursor, limit]);
        return pages[pageIndex++] ?? [];
      },
    },
    { async enqueue(notification) { enqueued.push(notification); } },
    {
      async readCheckpoint() { return checkpoint as PoolCheckpoint | null; },
      async storeCheckpoint(pool, next) { stored.push([pool, next]); },
    },
    { pageSize: 2, maxPages: 3, now: () => 1_000 },
  );
  return { scanner, listCalls, probeCalls, enqueued, stored };
}

const CHECKPOINT: PoolCheckpoint = Object.freeze({ poolAddress: 'pool', slot: 5n, signature: 'sig-5' });

function isStage(stage: string) {
  return (error: unknown) => error instanceof CatchUpSourceError && error.stage === stage;
}

void test('an idle pool costs one page and one probe and keeps its checkpoint', async () => {
  const { scanner, listCalls, probeCalls, enqueued, stored } = harness([[]], CHECKPOINT);
  const result = await scanner.scanPool('pool');
  assert.deepEqual(listCalls, [['pool', { before: undefined, until: 'sig-5' }, 2]]);
  assert.deepEqual(probeCalls, [['pool', { before: undefined, until: undefined }, 1]]);
  assert.equal(enqueued.length, 0);
  assert.equal(stored.length, 0);
  assert.equal(result.checkpointSlotAfter, '5');
  assert.equal(result.pageCount, 1);
  assert.equal(result.probeCount, 1);
});

void test('pages to until, confirms the boundary, enqueues every signature, then advances', async () => {
  const { scanner, listCalls, probeCalls, enqueued, stored } = harness([[sig(9), sig(8)], [sig(7)]], CHECKPOINT);
  const result = await scanner.scanPool('pool');
  assert.deepEqual(listCalls.map((call) => call[1].before), [undefined, 'sig-8']);
  assert.deepEqual(probeCalls, [['pool', { before: 'sig-7', until: undefined }, 1]]);
  assert.deepEqual(enqueued.map((row) => row.signature), ['sig-9', 'sig-8', 'sig-7']);
  assert.deepEqual(enqueued[0]?.programIds, [PUMPSWAP_PROGRAM_ID]);
  assert.equal(enqueued[0]?.source, 'CATCH_UP');
  assert.deepEqual(stored, [['pool', { slot: 9n, signature: 'sig-9' }]]);
  assert.equal(result.signaturesRead, 3);
  assert.equal(result.pageCount, 2);
  assert.equal(result.probeCount, 1);
  assert.equal(result.checkpointSlotAfter, '9');
});

for (const [label, probe] of [
  ['an empty probe', []],
  ['a different signature', [sig(5, 'other')]],
  ['the right signature at another slot', [sig(4, 'sig-5')]],
] as const) {
  void test(`an unconfirmed boundary (${label}) fails without enqueue or checkpoint move`, async () => {
    const { scanner, enqueued, stored } = harness([[sig(9), sig(8)], [sig(7)]], CHECKPOINT, probe);
    await assert.rejects(scanner.scanPool('pool'), (error: unknown) =>
      error instanceof PoolCheckpointNotFoundError
      && error.code === 'POOL_CHECKPOINT_NOT_FOUND'
      && error.poolAddress === 'pool'
      && error.pageCount === 2
      && error.signaturesRead === 3);
    assert.equal(enqueued.length, 0);
    assert.equal(stored.length, 0);
  });
}

void test('an idle pool whose checkpoint is not yet visible fails retryably', async () => {
  const { scanner, enqueued, stored } = harness([[]], CHECKPOINT, [sig(9)]);
  await assert.rejects(scanner.scanPool('pool'), PoolCheckpointNotFoundError);
  assert.equal(enqueued.length, 0);
  assert.equal(stored.length, 0);
});

void test('exactly pageSize x maxPages rows with a confirmed boundary succeed', async () => {
  const { scanner, probeCalls, enqueued, stored } = harness(
    [[sig(20), sig(19)], [sig(18), sig(17)], [sig(16), sig(15)]],
    CHECKPOINT,
  );
  const result = await scanner.scanPool('pool');
  assert.deepEqual(probeCalls, [['pool', { before: 'sig-15', until: undefined }, 1]]);
  assert.equal(enqueued.length, 6);
  assert.deepEqual(stored, [['pool', { slot: 20n, signature: 'sig-20' }]]);
  assert.equal(result.pageCount, 3);
  assert.equal(result.probeCount, 1);
});

void test('exceeding the page budget fails without enqueue or checkpoint move', async () => {
  const { scanner, enqueued, stored } = harness(
    [[sig(20), sig(19)], [sig(18), sig(17)], [sig(16), sig(15)]],
    CHECKPOINT,
    [sig(14)],
  );
  await assert.rejects(scanner.scanPool('pool'), (error: unknown) =>
    error instanceof PoolCatchUpWindowExceededError && error.code === 'CATCH_UP_WINDOW_EXCEEDED');
  assert.equal(enqueued.length, 0);
  assert.equal(stored.length, 0);
});

void test('a pool without checkpoint is refused', async () => {
  const { scanner } = harness([], null);
  await assert.rejects(scanner.scanPool('pool'), PoolCheckpointMissingError);
});

for (const [label, checkpoint] of [
  ['a non-object', 'sig-5'],
  ['another pool', { poolAddress: 'other', slot: 5n, signature: 'sig-5' }],
  ['a number slot', { poolAddress: 'pool', slot: 5, signature: 'sig-5' }],
  ['a negative slot', { poolAddress: 'pool', slot: -1n, signature: 'sig-5' }],
  ['an empty signature', { poolAddress: 'pool', slot: 5n, signature: '' }],
  ['a missing signature', { poolAddress: 'pool', slot: 5n }],
] as const) {
  void test(`an invalid checkpoint (${label}) is a TypeError`, async () => {
    const { scanner, listCalls, probeCalls } = harness([[]], checkpoint);
    await assert.rejects(scanner.scanPool('pool'), (error: unknown) =>
      error instanceof TypeError && error.message === 'Pool checkpoint is invalid.');
    assert.equal(listCalls.length + probeCalls.length, 0);
  });
}

for (const [label, pages] of [
  ['older than the checkpoint', [[sig(4)]]],
  ['equal to the checkpoint signature', [[sig(9), sig(5)]]],
] as const) {
  void test(`a row ${label} means until was ignored and is rejected`, async () => {
    const { scanner, enqueued, stored } = harness(pages, CHECKPOINT);
    await assert.rejects(scanner.scanPool('pool'), isStage('response'));
    assert.equal(enqueued.length, 0);
    assert.equal(stored.length, 0);
  });
}

void test('non-monotonic slots across pages are a response error', async () => {
  const { scanner, enqueued, stored } = harness([[sig(9), sig(8)], [sig(10)]], CHECKPOINT);
  await assert.rejects(scanner.scanPool('pool'), isStage('response'));
  assert.equal(enqueued.length, 0);
  assert.equal(stored.length, 0);
});

void test('non-monotonic slots within a page are a response error', async () => {
  const { scanner } = harness([[sig(8), sig(9)]], CHECKPOINT);
  await assert.rejects(scanner.scanPool('pool'), isStage('response'));
});

void test('a signature repeated across pages is a pagination error', async () => {
  const { scanner, enqueued, stored } = harness([[sig(9), sig(8)], [sig(8), sig(7)]], CHECKPOINT);
  await assert.rejects(scanner.scanPool('pool'), isStage('pagination'));
  assert.equal(enqueued.length, 0);
  assert.equal(stored.length, 0);
});

void test('a reused cursor is a pagination error', async () => {
  const { scanner } = harness(
    [[sig(9, 'a'), sig(8, 'b')], [sig(8, 'c'), sig(8, 'b2')], [sig(8, 'd'), sig(8, 'b')]],
    CHECKPOINT,
  );
  await assert.rejects(scanner.scanPool('pool'), isStage('pagination'));
});
