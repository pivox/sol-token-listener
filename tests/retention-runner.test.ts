import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  runRetention,
} from '../src/operations/retention-runner.js';
import {
  installRetentionSignalHandlers,
  runRetentionCli,
  waitForRetentionInterval,
} from '../scripts/purge-retained-data.js';

void test('purges immediately once, logs safe counters, then closes the database once', async () => {
  const events: unknown[] = [];
  let purges = 0;
  let closes = 0;

  await runRetention(options(), {
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
  const event = events[0] as { readonly event: string; readonly counters: Record<string, number> };
  assert.equal(event.event, 'retention.purged');
  assert.deepEqual(Object.entries(event.counters), [['rawChainEvents', 0], ['tokenLaunches', 3]]);
  assert.equal(Object.getPrototypeOf(event.counters), null);
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

void test('uses branded cancellation state when a genuine signal shadows aborted', async () => {
  for (const shadow of [
    { get: () => { throw new Error('shadowed aborted getter'); } },
    { value: false },
  ]) {
    const controller = new AbortController();
    Object.defineProperty(controller.signal, 'aborted', { configurable: true, ...shadow });
    let purges = 0;
    let closes = 0;
    await runRetention(options({ once: false, signal: controller.signal }), {
      purge: async () => {
        purges += 1;
        if (purges > 1) throw new Error('purged after abort');
        return { tokenLaunches: 1 };
      },
      closeDatabase: async () => { closes += 1; },
      wait: async () => { controller.abort(); },
      log: () => undefined,
    });
    assert.equal(purges, 1);
    assert.equal(closes, 1);
  }
});

void test('keeps repeated purges gated behind each completed wait without overlap', async () => {
  const controller = new AbortController();
  const waitGates: (() => void)[] = [];
  let purges = 0;
  let closes = 0;
  const running = runRetention(options({ once: false, signal: controller.signal }), {
    purge: async () => { purges += 1; return { tokenLaunches: purges }; },
    closeDatabase: async () => { closes += 1; },
    wait: async () => new Promise<void>((resolve) => { waitGates.push(resolve); }),
    log: () => undefined,
  });

  await nextTurn();
  assert.equal(purges, 1);
  assert.equal(waitGates.length, 1);
  waitGates[0]?.();
  await nextTurn();
  assert.equal(purges, 2);
  assert.equal(waitGates.length, 2);
  controller.abort();
  waitGates[1]?.();
  await running;
  assert.equal(purges, 2);
  assert.equal(closes, 1);
});

void test('preserves a purge failure when that purge concurrently aborts the signal', async () => {
  const controller = new AbortController();
  const primary = new Error('purge failed');
  let closes = 0;
  await assert.rejects(runRetention(options({ once: false, signal: controller.signal }), {
    purge: async () => { controller.abort(); throw primary; },
    closeDatabase: async () => { closes += 1; },
    wait: async () => undefined,
    log: () => undefined,
  }), primary);
  assert.equal(closes, 1);
});

void test('production wait bypasses shadow methods and cleans its timer and native listener', async () => {
  const controller = new AbortController();
  Object.defineProperties(controller.signal, {
    aborted: { configurable: true, get: () => { throw new Error('shadow getter'); } },
    addEventListener: { configurable: true, value: () => { throw new Error('shadow add'); } },
    removeEventListener: { configurable: true, value: () => { throw new Error('shadow remove'); } },
  });
  const handle = Object.freeze({ timer: 1 });
  const cleared: unknown[] = [];
  let duration: number | undefined;
  let callback: (() => void) | undefined;
  const waiting = waitForRetentionInterval(60_000, controller.signal, {
    setTimeout: (next, intervalMs) => { callback = next; duration = intervalMs; return handle; },
    clearTimeout: (timer) => { cleared.push(timer); },
  });
  assert.equal(duration, 60_000);
  assert.equal(typeof callback, 'function');
  controller.abort();
  await waiting;
  assert.deepEqual(cleared, [handle]);
  EventTarget.prototype.dispatchEvent.call(controller.signal, new Event('abort'));
  assert.deepEqual(cleared, [handle]);
});

void test('production signal handlers abort once and remove both process listeners', () => {
  const signals = new EventEmitter();
  const controller = new AbortController();
  const remove = installRetentionSignalHandlers(controller, signals);
  assert.equal(signals.listenerCount('SIGINT'), 1);
  assert.equal(signals.listenerCount('SIGTERM'), 1);
  signals.emit('SIGTERM');
  assert.equal(controller.signal.aborted, true);
  remove();
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
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

  await assert.rejects(runRetention(options(), {
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
  await assert.rejects(runRetention(options({ once: false, intervalMs: 59_999 }), {
    purge: async () => { accessed = true; return {}; },
    closeDatabase: async () => { accessed = true; },
    wait: async () => undefined,
    log: () => undefined,
  }), RangeError);
  assert.equal(accessed, false);
});

void test('aggregates a close failure after a purge failure, preserving primary order', async () => {
  const primary = new Error('purge failed');
  const cleanup = new Error('close failed');
  await assert.rejects(runRetention(options(), {
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

void test('rejects missing required runtime options before either resource dependency runs', async () => {
  for (const invalid of [
    { once: true, signal: new AbortController().signal },
    { once: true, intervalMs: 60_000 },
  ]) {
    let accessed = false;
    await assert.rejects(runRetention(invalid as never, {
      purge: async () => { accessed = true; return {}; },
      closeDatabase: async () => { accessed = true; },
      wait: async () => undefined,
      log: () => undefined,
    }), TypeError);
    assert.equal(accessed, false);
  }
});

void test('brand-checks a forged AbortSignal without invoking its attacker getter', async () => {
  let getterRead = false;
  const forged = Object.create(AbortSignal.prototype);
  Object.defineProperty(forged, 'aborted', {
    enumerable: true,
    get: () => {
      getterRead = true;
      return false;
    },
  });
  let accessed = false;
  await assert.rejects(runRetention(options({ signal: forged as AbortSignal }), {
    purge: async () => { accessed = true; return {}; },
    closeDatabase: async () => { accessed = true; },
    wait: async () => undefined,
    log: () => undefined,
  }), TypeError);
  assert.equal(getterRead, false);
  assert.equal(accessed, false);
});

void test('copies null-prototype and custom-prototype counter records without inherited fields', async () => {
  const nullPrototype = Object.create(null) as Record<string, number>;
  nullPrototype.tokenLaunches = 2;
  const customPrototype = Object.create({ inheritedSecret: 99 }) as Record<string, number>;
  customPrototype.rawChainEvents = 1;
  const seen: unknown[] = [];
  let runs = 0;
  await runRetention(options(), {
    purge: async () => (++runs === 1 ? nullPrototype : customPrototype),
    closeDatabase: async () => undefined,
    wait: async () => { throw new Error('one-shot must not wait'); },
    log: (entry) => { seen.push(entry.counters); },
  });
  assert.deepEqual(Object.entries(seen[0] as object), [['tokenLaunches', 2]]);

  await runRetention(options(), {
    purge: async () => customPrototype,
    closeDatabase: async () => undefined,
    wait: async () => undefined,
    log: (entry) => { seen.push(entry.counters); },
  });
  assert.deepEqual(Object.entries(seen[1] as object), [['rawChainEvents', 1]]);
});

void test('ignores hidden counter fields but rejects enumerable accessors and symbols without reading them', async () => {
  let getterRead = false;
  const hidden = Object.defineProperties({ tokenLaunches: 1 }, {
    hiddenSecret: { enumerable: false, value: 9 },
    [Symbol('hidden-secret')]: { enumerable: false, value: 10 },
  });
  let logged: unknown;
  await runRetention(options(), {
    purge: async () => hidden,
    closeDatabase: async () => undefined,
    wait: async () => undefined,
    log: (entry) => { logged = entry.counters; },
  });
  assert.deepEqual(Object.entries(logged as object), [['tokenLaunches', 1]]);

  const accessor = Object.defineProperty({}, 'tokenLaunches', {
    enumerable: true,
    get: () => { getterRead = true; return 1; },
  });
  await assert.rejects(runRetention(options(), dependenciesFor(accessor)), RangeError);
  assert.equal(getterRead, false);
  await assert.rejects(runRetention(options(), dependenciesFor({
    tokenLaunches: 1, [Symbol('secret')]: 1,
  })), RangeError);
});

void test('contains hostile proxy descriptor traps without exposing their secret', async () => {
  const secret = 'retention-proxy-secret';
  let trapCalls = 0;
  const hostile = new Proxy({}, {
    ownKeys: () => { trapCalls += 1; throw new Error(secret); },
  });
  await assert.rejects(runRetention(options(), dependenciesFor(hostile)), (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.doesNotMatch(error.message, new RegExp(secret, 'u'));
    return true;
  });
  assert.equal(trapCalls, 0);
});

void test('enforces counter key, value, and entry-count boundaries before logging', async () => {
  const key64 = `a${'b'.repeat(63)}`;
  const valid = Object.create(null) as Record<string, number>;
  valid[key64] = Number.MAX_SAFE_INTEGER;
  const counters: unknown[] = [];
  await runRetention(options(), {
    purge: async () => valid,
    closeDatabase: async () => undefined,
    wait: async () => undefined,
    log: (entry) => { counters.push(entry.counters); },
  });
  assert.deepEqual(Object.entries(counters[0] as object), [[key64, Number.MAX_SAFE_INTEGER]]);

  const productionAggregate = Object.fromEntries(
    Array.from({ length: 66 }, (_, index) => [`count${index}`, index]),
  );
  await runRetention(options(), {
    purge: async () => productionAggregate,
    closeDatabase: async () => undefined,
    wait: async () => undefined,
    log: (entry) => { counters.push(entry.counters); },
  });
  assert.equal(Object.keys(counters[1] as object).length, 66);

  const atLimit = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`count${index}`, index]));
  await runRetention(options(), {
    purge: async () => atLimit,
    closeDatabase: async () => undefined,
    wait: async () => undefined,
    log: (entry) => { counters.push(entry.counters); },
  });
  assert.equal(Object.keys(counters[2] as object).length, 128);

  const tooMany = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`count${index}`, index]));
  for (const invalid of [
    { [`a${'b'.repeat(64)}`]: 1 }, { tokenLaunches: -0 }, { tokenLaunches: Number.MAX_SAFE_INTEGER + 1 }, tooMany,
  ]) await assert.rejects(runRetention(options(), dependenciesFor(invalid)), RangeError);
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

function options(overrides: Partial<{
  readonly once: boolean;
  readonly intervalMs: number;
  readonly signal: AbortSignal;
}> = {}): { readonly once: boolean; readonly intervalMs: number; readonly signal: AbortSignal } {
  return {
    once: overrides.once ?? true,
    intervalMs: overrides.intervalMs ?? 60_000,
    signal: overrides.signal ?? new AbortController().signal,
  };
}

function dependenciesFor(result: unknown): {
  readonly purge: () => Promise<unknown>;
  readonly closeDatabase: () => Promise<void>;
  readonly wait: () => Promise<void>;
  readonly log: () => void;
} {
  return {
    purge: async () => result,
    closeDatabase: async () => undefined,
    wait: async () => undefined,
    log: () => undefined,
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}
