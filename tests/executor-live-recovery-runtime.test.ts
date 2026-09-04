import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type {
  LiveRecoveryLogContext,
  LiveRecoveryLogger,
} from '../src/executor-live-recovery/logger.js';
import { createLiveRecoveryLogger } from '../src/executor-live-recovery/logger.js';
import {
  runLiveRecoveryPass,
  runLiveRecoveryRuntime,
  type LiveRecoveryRuntimeScheduler,
} from '../src/executor-live-recovery/runtime.js';

void test('a pass preserves priority while deferred finality cannot starve deadline work', async () => {
  const calls: string[] = [];
  const result = await runLiveRecoveryPass({
    reconciliation: async () => {
      calls.push('reconciliation');
      return Object.freeze({ result: 'DEFERRED' as const, errorCode: 'RPC_TIMEOUT' });
    },
    confirmation: async () => { calls.push('confirmation'); return 'IDLE'; },
    deadline: async () => { calls.push('deadline'); return 'WORKED'; },
  }, new AbortController().signal);

  assert.deepEqual(calls, ['reconciliation', 'confirmation', 'deadline']);
  assert.deepEqual(result, {
    payloadVersion: 1,
    workedLane: 'DEADLINE',
    deferredLanes: [{ lane: 'RECONCILIATION', errorCode: 'RPC_TIMEOUT' }],
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.deferredLanes), true);
  assert.equal(Object.isFrozen(result.deferredLanes[0]), true);
});

void test('worked reconciliation stops the pass before lower-priority lanes', async () => {
  const calls: string[] = [];
  const result = await runLiveRecoveryPass({
    reconciliation: async () => { calls.push('reconciliation'); return 'WORKED'; },
    confirmation: async () => { calls.push('confirmation'); return 'WORKED'; },
    deadline: async () => { calls.push('deadline'); return 'WORKED'; },
  }, new AbortController().signal);
  assert.deepEqual(calls, ['reconciliation']);
  assert.deepEqual(result, {
    payloadVersion: 1,
    workedLane: 'RECONCILIATION',
    deferredLanes: [],
  });
});

void test('runtime logs bounded outcomes, waits one poll and closes after SIGTERM', async () => {
  const scheduler = manualScheduler();
  const signals = new EventEmitter();
  const events: LiveRecoveryLogContext[] = [];
  const calls: string[] = [];
  const runtime = runLiveRecoveryRuntime({
    createLanes: () => ({
      reconciliation: async () => Object.freeze({
        result: 'DEFERRED' as const, errorCode: 'RPC_RATE_LIMITED',
      }),
      confirmation: async () => 'IDLE',
      deadline: async () => 'WORKED',
    }),
    logger: logger(events),
    closeDatabase: async () => { calls.push('close'); },
    evictDatabase: () => { calls.push('evict'); },
    forceExit: (code) => { calls.push(`force:${code}`); },
  }, { pollMs: 1_000, shutdownGraceMs: 5_000, scheduler, signalSource: signals });

  await nextTurn();
  assert.deepEqual(events.slice(0, 3), [
    { event: 'executor_live_recovery.started', executionMode: 'live-recovery' },
    {
      event: 'executor_live_recovery.lane_completed', executionMode: 'live-recovery',
      lane: 'RECONCILIATION', result: 'DEFERRED', errorCode: 'RPC_RATE_LIMITED',
    },
    {
      event: 'executor_live_recovery.lane_completed', executionMode: 'live-recovery',
      lane: 'DEADLINE', result: 'WORKED',
    },
  ]);
  assert.deepEqual(scheduler.delays(), [1_000]);
  signals.emit('SIGTERM');
  await runtime;
  assert.deepEqual(calls, ['close']);
  assert.deepEqual(events.slice(-2), [
    { event: 'executor_live_recovery.stopping', executionMode: 'live-recovery' },
    { event: 'executor_live_recovery.stopped', executionMode: 'live-recovery' },
  ]);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

void test('runtime rejects hostile lane deferred results and logs a closed pass failure', async () => {
  const scheduler = manualScheduler();
  const signals = new EventEmitter();
  const events: LiveRecoveryLogContext[] = [];
  const runtime = runLiveRecoveryRuntime({
    createLanes: () => ({
      reconciliation: async () => ({ result: 'DEFERRED', errorCode: 'RPC_TIMEOUT', secret: 'credential' }) as never,
      confirmation: async () => 'IDLE',
      deadline: async () => 'IDLE',
    }),
    logger: logger(events), closeDatabase: async () => undefined,
    evictDatabase: () => undefined, forceExit: () => undefined,
  }, { pollMs: 100, shutdownGraceMs: 5_000, scheduler, signalSource: signals });

  await nextTurn();
  assert.deepEqual(events.at(-1), {
    event: 'executor_live_recovery.lane_failed', executionMode: 'live-recovery',
    lane: 'RECONCILIATION', errorCode: 'LIVE_RECOVERY_PASS_FAILED',
  });
  assert.equal(JSON.stringify(events).includes('credential'), false);
  signals.emit('SIGTERM');
  await runtime;
});

void test('shutdown deadline evicts the active database connection before exit one', async () => {
  const scheduler = manualScheduler();
  const signals = new EventEmitter();
  const events: LiveRecoveryLogContext[] = [];
  const calls: string[] = [];
  const runtime = runLiveRecoveryRuntime({
    createLanes: () => ({
      reconciliation: async () => new Promise<'IDLE'>(() => undefined),
      confirmation: async () => 'IDLE',
      deadline: async () => 'IDLE',
    }),
    logger: logger(events),
    closeDatabase: async () => { calls.push('close'); },
    evictDatabase: () => { calls.push('evict'); },
    forceExit: (code) => { calls.push(`force:${code}`); },
  }, { pollMs: 1_000, shutdownGraceMs: 2_500, scheduler, signalSource: signals });

  await nextTurn();
  signals.emit('SIGINT');
  scheduler.fire(2_500);
  await runtime;
  assert.deepEqual(calls, ['evict', 'force:1']);
  assert.deepEqual(events.slice(-2), [
    { event: 'executor_live_recovery.stopping', executionMode: 'live-recovery' },
    {
      event: 'executor_live_recovery.shutdown_forced', executionMode: 'live-recovery',
      errorCode: 'SHUTDOWN_DEADLINE',
    },
  ]);
});

void test('lane factory failures are redacted and retried only after the poll interval', async () => {
  const scheduler = manualScheduler();
  const signals = new EventEmitter();
  const events: LiveRecoveryLogContext[] = [];
  let passes = 0;
  const runtime = runLiveRecoveryRuntime({
    createLanes: () => {
      passes += 1;
      if (passes === 1) throw new Error('https://credential@rpc.private.test');
      return {
        reconciliation: async () => 'IDLE',
        confirmation: async () => 'IDLE',
        deadline: async () => 'IDLE',
      };
    },
    logger: logger(events), closeDatabase: async () => undefined,
    evictDatabase: () => undefined, forceExit: () => undefined,
  }, { pollMs: 750, shutdownGraceMs: 5_000, scheduler, signalSource: signals });

  await nextTurn();
  assert.equal(passes, 1);
  assert.deepEqual(events.at(-1), {
    event: 'executor_live_recovery.lane_failed', executionMode: 'live-recovery',
    errorCode: 'LIVE_RECOVERY_PASS_FAILED',
  });
  scheduler.fire(750);
  await nextTurn();
  assert.equal(passes, 2);
  signals.emit('SIGTERM');
  await runtime;
  assert.equal(JSON.stringify(events).includes('credential'), false);
});

void test('logger emits only the closed recovery context and drops hostile payloads', () => {
  const lines: string[] = [];
  const recoveryLogger = createLiveRecoveryLogger({
    write: (chunk: string) => { lines.push(chunk); },
  });
  recoveryLogger.error({
    event: 'executor_live_recovery.lane_failed',
    executionMode: 'live-recovery',
    lane: 'CONFIRMATION',
    errorCode: 'RPC_RATE_LIMITED',
    url: 'https://credential@rpc.private.test',
    signature: 'private-signature',
    mint: 'private-mint',
    amount: 123n,
    error: new Error('private-error'),
  } as LiveRecoveryLogContext);

  assert.equal(lines.length, 1);
  const raw = lines[0] ?? '';
  const line = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(line.service, 'sol-token-executor-live-recovery');
  assert.deepEqual(Object.fromEntries(Object.entries(line).filter(([keyName]) => [
    'event', 'executionMode', 'lane', 'result', 'errorCode',
  ].includes(keyName))), {
    event: 'executor_live_recovery.lane_failed',
    executionMode: 'live-recovery', lane: 'CONFIRMATION', errorCode: 'RPC_RATE_LIMITED',
  });
  for (const forbidden of ['credential', 'private', 'signature', 'mint', 'amount']) {
    assert.equal(raw.includes(forbidden), false);
  }
});

function logger(events: LiveRecoveryLogContext[]): LiveRecoveryLogger {
  const write = (context: LiveRecoveryLogContext): void => { events.push(context); };
  return Object.freeze({ info: write, warn: write, error: write });
}

function manualScheduler(): LiveRecoveryRuntimeScheduler & Readonly<{
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
    delays: () => [...tasks.values()].map(({ delayMs }) => delayMs),
    fire: (delayMs) => {
      const entry = [...tasks].find(([, task]) => task.delayMs === delayMs);
      assert.ok(entry !== undefined, `missing timer ${delayMs}`);
      tasks.delete(entry[0]);
      entry[1].callback();
    },
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}
