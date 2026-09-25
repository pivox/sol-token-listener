import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TransactionInboxWorkerPool,
  TransactionInboxWorkerPoolError,
  type TransactionInboxWorkerPoolMember,
} from '../src/application/transaction-inbox-worker-pool.js';
import type { TransactionInboxWorkerState } from '../src/application/transaction-inbox-worker.js';

function member(): TransactionInboxWorkerPoolMember {
  return {
    state: 'STOPPED',
    async start() {},
    async close() {},
  };
}

void test('accepts one to four members and rejects zero or five', () => {
  for (const count of [1, 2, 3, 4]) {
    assert.doesNotThrow(() => new TransactionInboxWorkerPool(Array.from({ length: count }, member)));
  }
  for (const count of [0, 5]) {
    assert.throws(() => new TransactionInboxWorkerPool(Array.from({ length: count }, member)), TypeError);
  }
});

void test('starts every member once across repeated and concurrent starts', async () => {
  const starts = [0, 0, 0];
  const members = starts.map((_, index): TransactionInboxWorkerPoolMember => ({
    state: 'STOPPED',
    async start() { starts[index] = (starts[index] ?? 0) + 1; },
    async close() {},
  }));
  const pool = new TransactionInboxWorkerPool(members);

  assert.equal(pool.state, 'STOPPED');
  await Promise.all([pool.start(), pool.start()]);
  await pool.start();

  assert.deepEqual(starts, [1, 1, 1]);
});

void test('aggregates running, degraded and unexpectedly stopped member states', async () => {
  const members = Array.from({ length: 2 }, () => ({
    state: 'STOPPED' as TransactionInboxWorkerState,
    async start() { this.state = 'RUNNING'; },
    async close() { this.state = 'STOPPED'; },
  }));
  const pool = new TransactionInboxWorkerPool(members);
  const [first, second] = members;
  assert.ok(first);
  assert.ok(second);

  await pool.start();
  assert.equal(pool.state, 'RUNNING');
  second.state = 'DEGRADED';
  assert.equal(pool.state, 'DEGRADED');
  second.state = 'RUNNING';
  first.state = 'STOPPED';
  assert.equal(pool.state, 'DEGRADED');
  first.state = 'RUNNING';
  assert.equal(pool.state, 'RUNNING');
});

void test('requests every close before waiting for the slowest member', async () => {
  const closeCalls: number[] = [];
  const releases: (() => void)[] = [];
  const members = Array.from({ length: 3 }, (_, index) => ({
    state: 'STOPPED' as TransactionInboxWorkerState,
    async start() { this.state = 'RUNNING'; },
    async close() {
      closeCalls.push(index);
      this.state = 'STOPPING';
      await new Promise<void>((resolve) => { releases[index] = resolve; });
      this.state = 'STOPPED';
    },
  }));
  const pool = new TransactionInboxWorkerPool(members);
  await pool.start();

  const closing = pool.close();
  await Promise.resolve();
  assert.deepEqual(closeCalls, [0, 1, 2]);
  assert.equal(pool.state, 'STOPPING');
  const [releaseFirst, releaseSecond, releaseThird] = releases;
  assert.ok(releaseFirst);
  assert.ok(releaseSecond);
  assert.ok(releaseThird);
  let settled = false;
  void closing.then(() => { settled = true; });
  releaseFirst();
  releaseSecond();
  await Promise.resolve();
  assert.equal(settled, false);
  releaseThird();
  await closing;
  assert.equal(pool.state, 'STOPPED');
});

void test('reports a typed redacted close failure only after every member settles', async () => {
  const calls: string[] = [];
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const pool = new TransactionInboxWorkerPool([
    {
      state: 'RUNNING',
      async start() {},
      close() { calls.push('failed'); throw new Error('https://secret.example/?token=credential'); },
    },
    {
      state: 'RUNNING',
      async start() {},
      async close() { calls.push('slow'); await slow; calls.push('drained'); },
    },
    {
      state: 'RUNNING',
      async start() {},
      async close() { calls.push('fast'); },
    },
  ]);
  await pool.start();

  const closing = pool.close();
  let settled = false;
  const result = assert.rejects(closing, (error: unknown) => {
    assert.ok(error instanceof TransactionInboxWorkerPoolError);
    assert.equal(error.stage, 'close');
    assert.equal(error.message, 'Transaction inbox worker pool operation failed.');
    assert.equal('cause' in error, false);
    assert.equal(JSON.stringify(error).includes('secret.example'), false);
    return true;
  }).then(() => { settled = true; });
  await Promise.resolve();
  assert.deepEqual(calls, ['failed', 'slow', 'fast']);
  assert.equal(pool.state, 'STOPPING');
  assert.equal(settled, false);
  releaseSlow();
  await result;
  assert.deepEqual(calls, ['failed', 'slow', 'fast', 'drained']);
  assert.equal(pool.state, 'DEGRADED');
});

void test('remains degraded when a member closes with an unresolved resource', async () => {
  const worker = {
    state: 'STOPPED' as TransactionInboxWorkerState,
    async start() { this.state = 'RUNNING'; },
    async close() { this.state = 'DEGRADED'; },
  };
  const pool = new TransactionInboxWorkerPool([worker]);
  await pool.start();

  await pool.close();

  assert.equal(pool.state, 'DEGRADED');
});

void test('redacts a member start failure after requesting every start', async () => {
  const calls: number[] = [];
  const pool = new TransactionInboxWorkerPool(Array.from({ length: 2 }, (_, index) => ({
    state: 'STOPPED' as TransactionInboxWorkerState,
    start() {
      calls.push(index);
      if (index === 0) throw new Error('https://secret.example/?token=credential');
      return Promise.resolve();
    },
    async close() {},
  })));

  await assert.rejects(pool.start(), (error: unknown) => {
    assert.ok(error instanceof TransactionInboxWorkerPoolError);
    assert.equal(error.stage, 'start');
    assert.equal(error.message, 'Transaction inbox worker pool operation failed.');
    assert.equal('cause' in error, false);
    return true;
  });
  assert.deepEqual(calls, [0, 1]);
  assert.equal(pool.state, 'DEGRADED');
});

void test('close is idempotent and a closed pool cannot restart', async () => {
  let starts = 0;
  let closes = 0;
  const worker = {
    state: 'STOPPED' as TransactionInboxWorkerState,
    async start() { starts += 1; this.state = 'RUNNING'; },
    async close() { closes += 1; this.state = 'STOPPED'; },
  };
  const pool = new TransactionInboxWorkerPool([worker]);
  await pool.start();

  const closing = pool.close();
  assert.strictEqual(pool.close(), closing);
  await closing;
  assert.strictEqual(pool.close(), closing);
  await pool.start();

  assert.equal(starts, 1);
  assert.equal(closes, 1);
  assert.equal(pool.state, 'STOPPED');
});
