import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_RETENTION_PURGE_INTERVAL_MS,
  runRetention,
} from '../src/operations/retention-runner.js';
import { runRetentionCli } from '../scripts/purge-retained-data.js';

void test('purges immediately once, logs safe counters, then closes the database once', async () => {
  const events: unknown[] = [];
  let purges = 0;
  let closes = 0;

  await runRetention({ once: true }, {
    purge: async () => {
      purges += 1;
      return { tokenLaunches: 3, rawChainEvents: 0 };
    },
    closeDatabase: async () => { closes += 1; },
    wait: async () => { throw new Error('wait must not be called for --once'); },
    log: (event) => { events.push(event); },
  });

  assert.equal(purges, 1);
  assert.equal(closes, 1);
  assert.deepEqual(events, [{
    event: 'retention.purged',
    counters: { rawChainEvents: 0, tokenLaunches: 3 },
  }]);
  const event = events[0] as { readonly counters: object };
  assert.ok(Object.isFrozen(event.counters));
});

void test('runs sequentially and stops cleanly when the real abort signal interrupts a wait', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  await runRetention({ once: false, signal: controller.signal, intervalMs: 60_000 }, {
    purge: async () => {
      calls.push('purge');
      return { tokenLaunches: 1 };
    },
    closeDatabase: async () => { calls.push('close'); },
    wait: async (intervalMs, signal) => {
      calls.push(`wait:${intervalMs}`);
      assert.equal(signal, controller.signal);
      controller.abort();
    },
    log: () => { calls.push('log'); },
  });

  assert.deepEqual(calls, ['purge', 'log', 'wait:60000', 'close']);
});

void test('rejects unsafe aggregate data without invoking a getter or logging raw values', async () => {
  let getterRead = false;
  let closes = 0;
  const result = Object.defineProperty({}, 'tokenLaunches', {
    enumerable: true,
    get: () => {
      getterRead = true;
      return 1;
    },
  });

  await assert.rejects(runRetention({ once: true }, {
    purge: async () => result,
    closeDatabase: async () => { closes += 1; },
    wait: async () => undefined,
    log: () => { throw new Error('must not log unsafe aggregate'); },
  }), RangeError);
  assert.equal(getterRead, false);
  assert.equal(closes, 1);
});

void test('rejects out-of-bound intervals before purge or database close', async () => {
  let accessed = false;
  await assert.rejects(runRetention({ once: false, intervalMs: 59_999 }, {
    purge: async () => { accessed = true; return {}; },
    closeDatabase: async () => { accessed = true; },
    wait: async () => undefined,
    log: () => undefined,
  }), RangeError);
  assert.equal(accessed, false);
  assert.equal(DEFAULT_RETENTION_PURGE_INTERVAL_MS, 900_000);
});

void test('aggregates a close failure after a purge failure, preserving primary order', async () => {
  const primary = new Error('purge failed');
  const cleanup = new Error('close failed');
  await assert.rejects(runRetention({ once: true }, {
    purge: async () => { throw primary; },
    closeDatabase: async () => { throw cleanup; },
    wait: async () => undefined,
    log: () => undefined,
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, cleanup]);
    return true;
  });
});

void test('rejects invalid retention CLI arguments and environment before constructing database work', async () => {
  let constructed = 0;
  const writes: string[] = [];
  const dependencies = () => {
    constructed += 1;
    return {
      purge: async () => ({}),
      closeDatabase: async () => undefined,
      wait: async () => undefined,
      log: () => undefined,
    };
  };

  assert.equal(await runRetentionCli({
    argv: ['--unexpected'], environment: {}, createDependencies: dependencies,
    write: (line) => { writes.push(line); }, signal: new AbortController().signal,
  }), 2);
  assert.deepEqual(writes, ['{"event":"retention.command","code":"RETENTION_ARGUMENTS_INVALID"}\n']);
  assert.equal(constructed, 0);

  writes.length = 0;
  assert.equal(await runRetentionCli({
    argv: [], environment: { RETENTION_PURGE_INTERVAL_MS: '59999' }, createDependencies: dependencies,
    write: (line) => { writes.push(line); }, signal: new AbortController().signal,
  }), 2);
  assert.deepEqual(writes, ['{"event":"retention.command","code":"RETENTION_INTERVAL_INVALID"}\n']);
  assert.equal(constructed, 0);
});
