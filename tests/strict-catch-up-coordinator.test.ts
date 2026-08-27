import assert from 'node:assert/strict';
import test from 'node:test';
import type { StrictCatchUpScanResult } from '../src/application/strict-catch-up-scanner.js';
import {
  StrictCatchUpCoordinator,
  type StrictCatchUpScannerPort,
} from '../src/application/strict-catch-up-coordinator.js';

void test('coalesces concurrent runs into the exact same promise and scan', async () => {
  const pending = deferred<StrictCatchUpScanResult>();
  const scanner = new FakeScanner([pending.promise]);
  const coordinator = new StrictCatchUpCoordinator(scanner);

  const first = coordinator.run();
  const second = coordinator.run();

  assert.equal(first, second);
  assert.equal(scanner.calls, 1);

  pending.resolve(result('primary'));

  assert.equal(await first, await second);
});

void test('shares the original scan error between concurrent callers', async () => {
  const pending = deferred<StrictCatchUpScanResult>();
  const scanner = new FakeScanner([pending.promise]);
  const coordinator = new StrictCatchUpCoordinator(scanner);
  const error = new Error('unavailable');

  const first = coordinator.run();
  const second = coordinator.run();
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
  const coordinator = new StrictCatchUpCoordinator(scanner);

  const first = coordinator.run();
  assert.equal(await first, firstResult);

  const second = coordinator.run();
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
  const coordinator = new StrictCatchUpCoordinator(scanner);

  await assert.rejects(coordinator.run(), (value: unknown) => value === error);

  assert.equal(await coordinator.run(), successfulResult);
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
  const coordinator = new StrictCatchUpCoordinator(scanner);

  const first = coordinator.run();
  const second = coordinator.run();

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
  const coordinator = new StrictCatchUpCoordinator(scanner);

  let first: Promise<StrictCatchUpScanResult> | undefined;
  assert.doesNotThrow(() => { first = coordinator.run(); });
  assert.ok(first);
  const second = coordinator.run();

  assert.equal(first, second);
  assert.notEqual(first, hostileResult);
  assert.equal(first.then, Promise.prototype.then);
  await assert.rejects(first, (value: unknown) => value === error);
  await assert.rejects(second, (value: unknown) => value === error);

  assert.equal(await coordinator.run(), successfulResult);
  assert.equal(scanner.calls, 2);
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
  const coordinator = new StrictCatchUpCoordinator(scanner);

  await assert.rejects(coordinator.run(), (value: unknown) => value === error);
  assert.equal(await coordinator.run(), successfulResult);
  assert.equal(calls, 2);
});

class FakeScanner implements StrictCatchUpScannerPort {
  public calls = 0;

  public constructor(private readonly responses: Promise<StrictCatchUpScanResult>[]) {}

  public scan(): Promise<StrictCatchUpScanResult> {
    this.calls += 1;
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
