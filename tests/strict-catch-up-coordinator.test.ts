import assert from 'node:assert/strict';
import test from 'node:test';
import { createStrictCatchUpRun, terminalizeStrictCatchUpRun } from '../src/domain/strict-catch-up-run.js';
import type { StrictCatchUpScanResult } from '../src/application/strict-catch-up-scanner.js';
import {
  StrictCatchUpCoordinator,
  type StrictCatchUpScannerPort,
} from '../src/application/strict-catch-up-coordinator.js';

const NEVER_ABORTED = new AbortController().signal;

void test('reads configured durable affinity without caching and without starting a scan', async () => {
  const calls: string[] = [];
  let pinned = false;
  const coordinator = new StrictCatchUpCoordinator(new FakeScanner([]), {
    async readActiveStrictCatchUpRun(key) {
      calls.push(key);
      return pinned ? activeRun(key, 'fallback-1') : null;
    },
  }, ['launchpad']);
  assert.deepEqual(calls, []);
  assert.equal(await coordinator.readPinnedProviderId(), null);
  pinned = true;
  assert.equal(await coordinator.readPinnedProviderId(), 'fallback-1');
  assert.deepEqual(calls, ['launchpad', 'launchpad']);
});

void test('accepts matching active providers but rejects divergent, malformed, and failed affinity reads safely', async () => {
  const matching = new StrictCatchUpCoordinator(new FakeScanner([]), {
    async readActiveStrictCatchUpRun(key) { return activeRun(key, 'fallback-1'); },
  }, ['launchpad', 'market']);
  assert.equal(await matching.readPinnedProviderId(), 'fallback-1');
  for (const read of [
    async (key: 'launchpad' | 'market') => activeRun(key, key === 'launchpad' ? 'primary' : 'fallback-1'),
    async () => ({ secret: 'https://signature-secret.invalid' }),
    async () => terminalizeStrictCatchUpRun(activeRun('launchpad', 'primary'), {
      state: 'FAILED', terminalReason: 'CATCH_UP_WINDOW_EXCEEDED', completedAtMs: 2_000,
    }),
    async () => { throw new Error('https://signature-secret.invalid'); },
  ]) {
    const coordinator = new StrictCatchUpCoordinator(new FakeScanner([]), {
      readActiveStrictCatchUpRun: read as never,
    }, ['launchpad', 'market']);
    await assert.rejects(coordinator.readPinnedProviderId(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'StrictCatchUpAffinityReadError');
      assert.equal(Reflect.get(error, 'retryable'), true);
      assert.ok(Object.isFrozen(error));
      assert.doesNotMatch(JSON.stringify(error), /secret|signature|https/u);
      return true;
    });
  }
});

function activeRun(key: 'launchpad' | 'market', providerId: 'primary' | 'fallback-1') {
  return createStrictCatchUpRun({
    checkpointKey: key, previous: { key, slot: 10n, signature: 'boundary', updatedAtMs: 100 },
    providerId, observedHead: { slot: 14n, signature: 'head' }, beforeSignature: 'cursor',
    lastAcceptedSlot: 13n, pagesScanned: 1n, signaturesEnqueued: 2n,
    revision: 0n, startedAtMs: 1_000, updatedAtMs: 1_000,
  });
}

void test('affinity rejects accessor methods and hostile promises without invoking their getters', async () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'readActiveStrictCatchUpRun', {
    get() { getterCalls += 1; throw new Error('secret'); },
  });
  const hostilePromise = Object.defineProperty(Promise.resolve(null), 'then', {
    get() { getterCalls += 1; throw new Error('secret'); },
  });
  for (const repository of [accessor, { readActiveStrictCatchUpRun: () => hostilePromise }]) {
    const coordinator = new StrictCatchUpCoordinator(new FakeScanner([]), repository as never, ['launchpad']);
    await assert.rejects(coordinator.readPinnedProviderId(), { name: 'StrictCatchUpAffinityReadError' });
  }
  assert.equal(getterCalls, 0);
});

void test('coalesces concurrent runs into the exact same promise and scan', async () => {
  const pending = deferred<StrictCatchUpScanResult>();
  const scanner = new FakeScanner([pending.promise]);
  const coordinator = new StrictCatchUpCoordinator(scanner, { async readActiveStrictCatchUpRun() { return null; } }, ['launchpad']);
  const firstController = new AbortController();
  const secondController = new AbortController();

  const first = coordinator.run(firstController.signal);
  const second = coordinator.run(secondController.signal);

  assert.equal(first, second);
  assert.equal(scanner.calls, 1);
  assert.deepEqual(scanner.signals, [firstController.signal]);

  pending.resolve(result('primary'));

  assert.equal(await first, await second);
});

void test('shares the original scan error between concurrent callers', async () => {
  const pending = deferred<StrictCatchUpScanResult>();
  const scanner = new FakeScanner([pending.promise]);
  const coordinator = new StrictCatchUpCoordinator(scanner, { async readActiveStrictCatchUpRun() { return null; } }, ['launchpad']);
  const error = new Error('unavailable');

  const first = coordinator.run(NEVER_ABORTED);
  const second = coordinator.run(NEVER_ABORTED);
  pending.reject(error);

  await assert.rejects(first, (value: unknown) => value === error);
  await assert.rejects(second, (value: unknown) => value === error);
  assert.equal(scanner.calls, 1);
});

void test('starts a new scan after a successful run settles', async () => {
  const firstResult = result('primary');
  const secondResult = result('fallback-1');
  const scanner = new FakeScanner([
    Promise.resolve(firstResult),
    Promise.resolve(secondResult),
  ]);
  const coordinator = new StrictCatchUpCoordinator(scanner, { async readActiveStrictCatchUpRun() { return null; } }, ['launchpad']);

  const first = coordinator.run(NEVER_ABORTED);
  assert.equal(await first, firstResult);

  const second = coordinator.run(NEVER_ABORTED);
  assert.notEqual(second, first);
  assert.equal(await second, secondResult);
  assert.equal(scanner.calls, 2);
});

void test('starts a new scan after a failed run settles', async () => {
  const error = new Error('unavailable');
  const successfulResult = result('fallback-1');
  const scanner = new FakeScanner([
    Promise.reject(error),
    Promise.resolve(successfulResult),
  ]);
  const coordinator = new StrictCatchUpCoordinator(scanner, { async readActiveStrictCatchUpRun() { return null; } }, ['launchpad']);

  await assert.rejects(coordinator.run(NEVER_ABORTED), (value: unknown) => value === error);

  assert.equal(await coordinator.run(NEVER_ABORTED), successfulResult);
  assert.equal(scanner.calls, 2);
});

void test('normalizes a scanner thenable without duplicating its scan', async () => {
  const value = result('primary');
  const scanner: StrictCatchUpScannerPort = {
    scan() {
      return {
        then(resolve: (next: StrictCatchUpScanResult) => void) {
          resolve(value);
        },
      } as unknown as Promise<StrictCatchUpScanResult>;
    },
  };
  const coordinator = new StrictCatchUpCoordinator(scanner, { async readActiveStrictCatchUpRun() { return null; } }, ['launchpad']);

  const first = coordinator.run(NEVER_ABORTED);
  const second = coordinator.run(NEVER_ABORTED);

  assert.equal(first, second);
  assert.equal(await first, value);
});

void test('rejects and resets after a native scan promise has a hostile then getter', async () => {
  const error = new Error('unavailable');
  const hostileResult = Promise.resolve(result('primary'));
  void Object.defineProperty(hostileResult, 'then', {
    get() { throw error; },
  });
  const successfulResult = result('fallback-1');
  const scanner = new FakeScanner([
    hostileResult,
    Promise.resolve(successfulResult),
  ]);
  const coordinator = new StrictCatchUpCoordinator(scanner, { async readActiveStrictCatchUpRun() { return null; } }, ['launchpad']);

  let first: Promise<StrictCatchUpScanResult> | undefined;
  assert.doesNotThrow(() => { first = coordinator.run(NEVER_ABORTED); });
  assert.ok(first);
  const second = coordinator.run(NEVER_ABORTED);

  assert.equal(first, second);
  assert.notEqual(first, hostileResult);
  assert.equal(first.then, Promise.prototype.then);
  await assert.rejects(first, (value: unknown) => value === error);
  await assert.rejects(second, (value: unknown) => value === error);

  assert.equal(await coordinator.run(NEVER_ABORTED), successfulResult);
  assert.equal(scanner.calls, 2);
});

void test('coalesces a synchronous reentrant run before the scanner returns', async () => {
  const scanResult = result('primary');
  let calls = 0;
  let nested: Promise<StrictCatchUpScanResult> | undefined;
  let coordinator: StrictCatchUpCoordinator | null = null;
  const scanner: StrictCatchUpScannerPort = {
    scan() {
      calls += 1;
      if (calls === 1) {
        if (coordinator === null) throw new Error('Coordinator is unavailable.');
        nested = coordinator.run(NEVER_ABORTED);
      }
      return Promise.resolve(scanResult);
    },
  };
  coordinator = new StrictCatchUpCoordinator(scanner, { async readActiveStrictCatchUpRun() { return null; } }, ['launchpad']);

  const first = coordinator.run(NEVER_ABORTED);

  assert.equal(nested, first);
  assert.equal(calls, 1);
  assert.equal(await first, scanResult);

  const next = coordinator.run(NEVER_ABORTED);
  assert.notEqual(next, first);
  assert.equal(calls, 2);
});

void test('converts a synchronous scanner throw into its original rejected error', async () => {
  const error = new Error('unavailable');
  const successfulResult = result('fallback-1');
  let calls = 0;
  const scanner: StrictCatchUpScannerPort = {
    scan() {
      calls += 1;
      if (calls === 1) throw error;
      return Promise.resolve(successfulResult);
    },
  };
  const coordinator = new StrictCatchUpCoordinator(scanner, { async readActiveStrictCatchUpRun() { return null; } }, ['launchpad']);

  await assert.rejects(coordinator.run(NEVER_ABORTED), (value: unknown) => value === error);
  assert.equal(await coordinator.run(NEVER_ABORTED), successfulResult);
  assert.equal(calls, 2);
});

class FakeScanner implements StrictCatchUpScannerPort {
  public calls = 0;
  public readonly signals: AbortSignal[] = [];

  public constructor(private readonly responses: Promise<StrictCatchUpScanResult>[]) {}

  public scan(signal: AbortSignal): Promise<StrictCatchUpScanResult> {
    this.calls += 1;
    this.signals.push(signal);
    const next = this.responses.shift();
    if (next === undefined) throw new Error('Unexpected scan.');
    return next;
  }
}

function result(providerId: StrictCatchUpScanResult['providerId']): StrictCatchUpScanResult {
  return Object.freeze({
    providerId,
    discoveredCount: 1,
    enqueuedCount: 1,
    checkpointCasCount: 1,
    pageCount: 2,
    boundaries: Object.freeze({ launchpad: null, market: null }),
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {
    promise,
    resolve(value) { resolve?.(value); },
    reject(reason) { reject?.(reason); },
  };
}
