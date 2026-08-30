import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createExecutorDatabase } from '../src/executor/database.js';
import type { ExecutorLogContext, ExecutorLogger } from '../src/executor/logger.js';
import {
  runExecutorRuntime,
  type ExecutorRuntimeScheduler,
} from '../src/executor/runtime.js';

void test('runs immediately, waits one poll interval and never overlaps passes', async () => {
  const first = deferred<'IDLE'>();
  const second = deferred<'IDLE'>();
  const scheduler = manualScheduler();
  const signals = new EventEmitter();
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const runtime = runExecutorRuntime({
    runOnce: async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try { return await (calls === 1 ? first.promise : second.promise); }
      finally { active -= 1; }
    },
    logger: logger(), closeDatabase: async () => undefined,
    evictDatabase: () => undefined, forceExit: () => undefined,
  }, { pollMs: 1_000, shutdownGraceMs: 10_000, scheduler, signalSource: signals });

  await nextTurn();
  assert.equal(calls, 1);
  assert.equal(scheduler.count(), 0);
  first.resolve('IDLE');
  await nextTurn();
  assert.deepEqual(scheduler.delays(), [1_000]);
  scheduler.fire(1_000);
  await nextTurn();
  assert.equal(calls, 2);
  assert.equal(maximumActive, 1);

  signals.emit('SIGTERM');
  second.resolve('IDLE');
  await runtime;
  assert.equal(calls, 2);
  assert.equal(scheduler.count(), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

void test('logs only a stable pass error code and resumes after the poll backoff', async () => {
  const scheduler = manualScheduler();
  const signals = new EventEmitter();
  const logs: ExecutorLogContext[] = [];
  let calls = 0;
  const runtime = runExecutorRuntime({
    runOnce: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('postgresql://secret.invalid'), {
        code: 'DATABASE_FAILURE',
      });
      return 'IDLE';
    },
    logger: logger(logs), closeDatabase: async () => undefined,
    evictDatabase: () => undefined, forceExit: () => undefined,
  }, { pollMs: 750, shutdownGraceMs: 5_000, scheduler, signalSource: signals });

  await nextTurn();
  assert.equal(calls, 1);
  assert.deepEqual(logs, [{ event: 'executor.pass_failed', errorCode: 'DATABASE_FAILURE' }]);
  assert.doesNotMatch(JSON.stringify(logs), /secret|postgresql/iu);
  scheduler.fire(750);
  await nextTurn();
  assert.equal(calls, 2);
  signals.emit('SIGINT');
  await runtime;
});

void test('maps an attacker-controlled uppercase error code to one fixed runtime code', async () => {
  const scheduler = manualScheduler();
  const signals = new EventEmitter();
  const logs: ExecutorLogContext[] = [];
  const runtime = runExecutorRuntime({
    runOnce: async () => {
      throw Object.assign(new Error('private message'), { code: 'DATABASE_PASSWORD_SECRET' });
    },
    logger: logger(logs), closeDatabase: async () => undefined,
    evictDatabase: () => undefined, forceExit: () => undefined,
  }, { pollMs: 750, shutdownGraceMs: 5_000, scheduler, signalSource: signals });

  await nextTurn();
  assert.deepEqual(logs, [{
    event: 'executor.pass_failed', errorCode: 'EXECUTOR_PASS_FAILED',
  }]);
  assert.doesNotMatch(JSON.stringify(logs), /PASSWORD|SECRET/u);
  signals.emit('SIGTERM');
  await runtime;
});

void test('a signal removes both handlers, forbids another claim and waits for the in-flight pass before close', async () => {
  const gate = deferred<'RECORDED'>();
  const scheduler = manualScheduler();
  const signals = new EventEmitter();
  const calls: string[] = [];
  let runtimeSignal: AbortSignal | null = null;
  const runtime = runExecutorRuntime({
    runOnce: async (signal) => {
      runtimeSignal = signal;
      calls.push('claim');
      return gate.promise;
    },
    logger: logger(),
    closeDatabase: async () => { calls.push('close'); },
    evictDatabase: () => { calls.push('evict'); },
    forceExit: () => { calls.push('force'); },
  }, { pollMs: 1_000, shutdownGraceMs: 10_000, scheduler, signalSource: signals });

  await nextTurn();
  signals.emit('SIGTERM');
  assert.equal(abortState(runtimeSignal), true);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  await nextTurn();
  assert.deepEqual(calls, ['claim']);
  gate.resolve('RECORDED');
  await runtime;
  assert.deepEqual(calls, ['claim', 'close']);
  assert.equal(scheduler.count(), 0);
});

void test('aborts the worker signal before a deferred claim resolves and then closes cleanly', async () => {
  const gate = deferred<'IDLE'>();
  const scheduler = manualScheduler();
  const signals = new EventEmitter();
  const calls: string[] = [];
  let runtimeSignal: AbortSignal | null = null;
  const runtime = runExecutorRuntime({
    runOnce: (signal) => {
      runtimeSignal = signal;
      calls.push('claim');
      return gate.promise;
    },
    logger: logger(),
    closeDatabase: async () => { calls.push('close'); },
    evictDatabase: () => { calls.push('evict'); },
    forceExit: () => { calls.push('force'); },
  }, { pollMs: 1_000, shutdownGraceMs: 10_000, scheduler, signalSource: signals });

  await nextTurn();
  assert.equal(abortState(runtimeSignal), false);
  signals.emit('SIGINT');
  assert.equal(abortState(runtimeSignal), true);
  assert.deepEqual(calls, ['claim']);
  gate.resolve('IDLE');

  await runtime;
  assert.deepEqual(calls, ['claim', 'close']);
});

void test('the shutdown deadline evicts before logging and forcing exit one', async () => {
  const scheduler = manualScheduler();
  const signals = new EventEmitter();
  const calls: string[] = [];
  const logs: ExecutorLogContext[] = [];
  const runtime = runExecutorRuntime({
    runOnce: async () => new Promise<'IDLE'>(() => undefined),
    logger: logger(logs),
    closeDatabase: async () => { calls.push('close'); },
    evictDatabase: () => { calls.push('evict'); },
    forceExit: (code) => { calls.push(`force:${code}`); },
  }, { pollMs: 1_000, shutdownGraceMs: 2_500, scheduler, signalSource: signals });

  await nextTurn();
  signals.emit('SIGTERM');
  assert.deepEqual(scheduler.delays(), [2_500]);
  scheduler.fire(2_500);
  await runtime;
  assert.deepEqual(calls, ['evict', 'force:1']);
  assert.deepEqual(logs, [{ event: 'executor.shutdown_forced', errorCode: 'SHUTDOWN_DEADLINE' }]);
  assert.equal(scheduler.count(), 0);
});

void test('aggregates a primary in-flight failure before close failure without logging either message', async () => {
  const gate = deferred<'IDLE'>();
  const scheduler = manualScheduler();
  const signals = new EventEmitter();
  const logs: ExecutorLogContext[] = [];
  const primary = new Error('primary credential message');
  const cleanup = new Error('cleanup credential message');
  const runtime = runExecutorRuntime({
    runOnce: () => gate.promise,
    logger: logger(logs),
    closeDatabase: async () => { throw cleanup; },
    evictDatabase: () => undefined,
    forceExit: () => undefined,
  }, { pollMs: 1_000, shutdownGraceMs: 10_000, scheduler, signalSource: signals });

  await nextTurn();
  signals.emit('SIGINT');
  gate.reject(primary);
  await assert.rejects(runtime, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, cleanup]);
    assert.equal(error.message, 'Executor shutdown failed.');
    return true;
  });
  assert.deepEqual(logs, [{ event: 'executor.pass_failed', errorCode: 'EXECUTOR_PASS_FAILED' }]);
  assert.doesNotMatch(JSON.stringify(logs), /primary|cleanup|credential/iu);
  assert.equal(scheduler.count(), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

void test('database wrapper owns at most one client and makes release and eviction idempotent', async () => {
  const releases: boolean[] = [];
  let connects = 0;
  const client = {
    query: async () => ({ rows: [], rowCount: 0 }),
    release: (evict?: boolean) => { releases.push(evict === true); },
  };
  const database = createExecutorDatabase({
    connect: async () => { connects += 1; return client; },
  });

  const first = await database.pool.connect();
  await assert.rejects(database.pool.connect(), (error: unknown) => {
    assert.deepEqual(error, Object.assign(error as object, {}));
    assert.equal((error as { code?: unknown }).code, 'EXECUTOR_DATABASE_BUSY');
    assert.equal((error as Error).message, 'Executor database operation failed.');
    return true;
  });
  assert.equal(connects, 1);
  first.release();
  first.release(true);
  assert.deepEqual(releases, [false]);

  await database.pool.connect();
  database.evictActive();
  database.evictActive();
  assert.deepEqual(releases, [false, true]);
  assert.equal(database.hasActiveClient(), false);
});

function logger(events: ExecutorLogContext[] = []): ExecutorLogger {
  const write = (context: ExecutorLogContext): void => { events.push(context); };
  return Object.freeze({ info: write, warn: write, error: write });
}

function manualScheduler(): ExecutorRuntimeScheduler & Readonly<{
  count(): number;
  delays(): readonly number[];
  fire(delayMs: number): void;
}> {
  let nextId = 1;
  const tasks = new Map<number, Readonly<{ callback: () => void; delayMs: number }>>();
  return {
    setTimeout: (callback, delayMs) => {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { callback, delayMs });
      return id;
    },
    clearTimeout: (handle) => { tasks.delete(handle as number); },
    count: () => tasks.size,
    delays: () => [...tasks.values()].map(({ delayMs }) => delayMs),
    fire: (delayMs) => {
      const entry = [...tasks].find(([, task]) => task.delayMs === delayMs);
      assert.ok(entry !== undefined, `missing timer ${delayMs}`);
      tasks.delete(entry[0]);
      entry[1].callback();
    },
  };
}

function deferred<Value>(): Readonly<{
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
}> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

function abortState(signal: AbortSignal | null): boolean | null {
  return signal?.aborted ?? null;
}
