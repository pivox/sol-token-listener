import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseConfig } from '../src/config/env.js';
import type { TokenLaunch } from '../src/domain/types.js';
import type { getDatabasePool } from '../src/storage/database.js';
import {
  BondingCurveReadUnavailableError,
  ListenerControllerCloseError,
  MAX_LISTENER_TIMER_DELAY_MS,
  PersistentListenerHeartbeat,
  RecurringFinalityReconciler,
  createProductionListenerRuntime,
  createUnavailableBondingCurveReader,
  type ListenerRuntimeScheduler,
} from '../src/application/production-listener-factory.js';

void test('composes the passive production listener without opening resources', () => {
  const runtime = createProductionListenerRuntime(
    parseConfig({
      SOLANA_HTTP_RPC_URL: 'http://127.0.0.1:8899',
      SOLANA_WS_RPC_URL: 'ws://127.0.0.1:8900',
    }),
    inertPool as unknown as ReturnType<typeof getDatabasePool>,
  );

  assert.equal(runtime.state(), 'STOPPED');
  assert.deepEqual(runtime.pipelineState(), {
    httpAvailable: true,
    pumpfun: 'STOPPED',
    pumpswap: 'STOPPED',
    social: 'STOPPED',
  });
});

void test('keeps fixed social retention compatible with a different foundation retention', () => {
  const runtime = createProductionListenerRuntime(
    parseConfig({
      SOLANA_HTTP_RPC_URL: 'http://127.0.0.1:8899',
      SOLANA_WS_RPC_URL: 'ws://127.0.0.1:8900',
      DATA_RETENTION_HOURS: '24',
    }),
    inertPool as unknown as ReturnType<typeof getDatabasePool>,
  );

  assert.equal(runtime.state(), 'STOPPED');
});

void test('generic Pump bonding-curve reads fail with a stable redacted error', async () => {
  const reader = createUnavailableBondingCurveReader();

  await assert.rejects(reader.read({} as TokenLaunch), (error: unknown) => {
    assert.ok(error instanceof BondingCurveReadUnavailableError);
    assert.equal(error.name, 'BondingCurveReadUnavailableError');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
});

void test('production factory has no transaction execution or Raydium builder path', async () => {
  const source = await readFile(
    new URL('../src/application/production-listener-factory.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /(?:sendRawTransaction|sendTransaction|transaction-builder|execution\/wallet|\.\.\/execution\/|raydium)/iu);
});

void test('public social runtime components have no signer or submission path', async () => {
  for (const path of [
    '../src/application/social-enrichment-worker.ts',
    '../src/storage/social-evidence.repository.ts',
    '../src/social/public-social-verification.provider.ts',
  ]) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /(?:sendRawTransaction|sendTransaction|signTransaction|execution\/wallet|\.\.\/execution\/|privateKey|keypair)/iu,
      path,
    );
  }
});

void test('heartbeat stop fences an in-flight RUNNING write before durable STOPPED', async () => {
  const scheduler = new ManualScheduler();
  const periodic = deferred<undefined>();
  const writes: string[] = [];
  let runningWrites = 0;
  const heartbeat = new PersistentListenerHeartbeat(
    {
      async counts() {
        return {
          pending: 0, processing: 0, processed: 0, failed: 0,
          retryableFailed: 0, exhaustedFailed: 0,
        };
      },
      async writeHeartbeat(value) {
        if (value.runtimeState === 'RUNNING' && ++runningWrites === 2) await periodic.promise;
        writes.push(value.runtimeState);
      },
    },
    { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
    () => 'RUNNING',
    () => 'RUNNING',
    () => 'RUNNING',
    () => 'RUNNING',
    { intervalMs: 5, shutdownTimeoutMs: 100, scheduler },
  );
  await heartbeat.start();
  scheduler.fireScheduled();
  await Promise.resolve();

  let stopped = false;
  const stopping = heartbeat.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.deepEqual(writes, ['RUNNING']);

  periodic.resolve(undefined);
  await stopping;
  assert.deepEqual(writes, ['RUNNING', 'RUNNING', 'STOPPED']);
  assert.equal(heartbeat.state(), 'STOPPED');
  scheduler.fireLastCallbackAgain();
  await Promise.resolve();
  assert.deepEqual(writes, ['RUNNING', 'RUNNING', 'STOPPED']);
});

void test('heartbeat exposes retryable failed work in backlog without leasing it', async () => {
  const writes: {
    readonly backlogCount: number;
    readonly leasedCount: number;
    readonly exhaustedCount: number;
  }[] = [];
  const heartbeat = new PersistentListenerHeartbeat(
    {
      async counts() {
        return {
          pending: 2, processing: 1, processed: 4, failed: 3,
          retryableFailed: 2, exhaustedFailed: 1,
        };
      },
      async writeHeartbeat(value) {
        writes.push(value);
      },
    },
    { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
    () => 'RUNNING',
    () => 'RUNNING',
    () => 'RUNNING',
    () => 'RUNNING',
    { intervalMs: 5, shutdownTimeoutMs: 100, scheduler: new ManualScheduler() },
  );

  await heartbeat.start();
  assert.equal(writes[0]?.backlogCount, 5);
  assert.equal(writes[0]?.leasedCount, 1);
  assert.equal(writes[0]?.exhaustedCount, 1);
  await heartbeat.stop();
});

void test('heartbeat refreshes post-drain counts without another shutdown RPC read', async () => {
  const writes: {
    readonly runtimeState: string;
    readonly backlogCount: number;
    readonly leasedCount: number;
    readonly exhaustedCount: number;
  }[] = [];
  let countReads = 0;
  let slotReads = 0;
  let finalizedSlotReads = 0;
  const heartbeat = new PersistentListenerHeartbeat(
    {
      async counts() {
        countReads += 1;
        return countReads === 1
          ? {
            pending: 4, processing: 1, processed: 0, failed: 0,
            retryableFailed: 0, exhaustedFailed: 0,
          }
          : {
            pending: 2, processing: 0, processed: 3, failed: 2,
            retryableFailed: 1, exhaustedFailed: 1,
          };
      },
      async writeHeartbeat(value) { writes.push(value); },
    },
    {
      async getSlot() { slotReads += 1; return 10n; },
      async getFinalizedSlot() { finalizedSlotReads += 1; return 9n; },
    },
    () => 'RUNNING',
    () => 'RUNNING',
    () => 'RUNNING',
    () => 'RUNNING',
    { intervalMs: 5, shutdownTimeoutMs: 100, scheduler: new ManualScheduler() },
  );

  await heartbeat.start();
  await Promise.all([heartbeat.stop(), heartbeat.stop()]);

  assert.equal(countReads, 2);
  assert.equal(slotReads, 1);
  assert.equal(finalizedSlotReads, 1);
  assert.deepEqual(writes.map((value) => ({
    runtimeState: value.runtimeState,
    backlogCount: value.backlogCount,
    leasedCount: value.leasedCount,
    exhaustedCount: value.exhaustedCount,
  })), [
    { runtimeState: 'RUNNING', backlogCount: 5, leasedCount: 1, exhaustedCount: 0 },
    { runtimeState: 'STOPPED', backlogCount: 3, leasedCount: 0, exhaustedCount: 1 },
  ]);
});

void test('heartbeat refuses a stale STOPPED snapshot when the final count read fails', async () => {
  const writes: string[] = [];
  let countReads = 0;
  const heartbeat = new PersistentListenerHeartbeat(
    {
      async counts() {
        countReads += 1;
        if (countReads === 2) throw new Error('private final count failure');
        return {
          pending: 1, processing: 1, processed: 0, failed: 0,
          retryableFailed: 0, exhaustedFailed: 0,
        };
      },
      async writeHeartbeat(value) { writes.push(value.runtimeState); },
    },
    { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
    () => 'RUNNING',
    () => 'RUNNING',
    () => 'RUNNING',
    () => 'RUNNING',
    { intervalMs: 5, shutdownTimeoutMs: 100, scheduler: new ManualScheduler() },
  );
  await heartbeat.start();

  await assert.rejects(heartbeat.stop(), (error: unknown) => {
    assert.ok(error instanceof ListenerControllerCloseError);
    assert.equal(error.component, 'heartbeat');
    assert.equal(error.reason, 'dependency');
    assert.doesNotMatch(String(error), /private|count|failure/u);
    return true;
  });
  assert.deepEqual(writes, ['RUNNING']);
  assert.equal(heartbeat.state(), 'DEGRADED');
});

void test('finality close fences an in-flight pass and rejects stale timer activity', async () => {
  const scheduler = new ManualScheduler();
  const periodic = deferred<undefined>();
  let runs = 0;
  const reconciler = new RecurringFinalityReconciler(
    {
      async runOnce() {
        runs += 1;
        if (runs === 2) await periodic.promise;
      },
    },
    { intervalMs: 5, shutdownTimeoutMs: 100, scheduler },
  );
  await reconciler.start();
  scheduler.fireScheduled();
  await Promise.resolve();

  let closed = false;
  const closing = reconciler.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(runs, 2);

  periodic.resolve(undefined);
  await closing;
  assert.equal(reconciler.state(), 'STOPPED');
  scheduler.fireLastCallbackAgain();
  await Promise.resolve();
  assert.equal(runs, 2);
  assert.equal(reconciler.state(), 'STOPPED');
});

void test('accepts the exact Node timer bound and rejects overflow or fractions', () => {
  const scheduler = new ManualScheduler();
  assert.doesNotThrow(() => new RecurringFinalityReconciler(
    { async runOnce() { return undefined; } },
    { intervalMs: MAX_LISTENER_TIMER_DELAY_MS, shutdownTimeoutMs: 100, scheduler },
  ));
  assert.throws(() => new RecurringFinalityReconciler(
    { async runOnce() { return undefined; } },
    { intervalMs: MAX_LISTENER_TIMER_DELAY_MS + 1, shutdownTimeoutMs: 100, scheduler },
  ), TypeError);
  assert.throws(() => new RecurringFinalityReconciler(
    { async runOnce() { return undefined; } },
    { intervalMs: 1.5, shutdownTimeoutMs: 100, scheduler },
  ), TypeError);

  assert.equal(config({ RECONCILE_SECONDS: '2147483' }).reconcileSeconds, 2_147_483);
  assert.throws(() => config({ RECONCILE_SECONDS: '2147484' }), /RECONCILE_SECONDS/u);
});

const inertPool = Object.freeze({
  async query(): Promise<never> {
    throw new Error('The composition test must not query PostgreSQL.');
  },
  async connect(): Promise<never> {
    throw new Error('The composition test must not connect to PostgreSQL.');
  },
});

function config(overrides: Record<string, string> = {}): ReturnType<typeof parseConfig> {
  return parseConfig({
    SOLANA_HTTP_RPC_URL: 'http://127.0.0.1:8899',
    SOLANA_WS_RPC_URL: 'ws://127.0.0.1:8900',
    ...overrides,
  });
}

class ManualScheduler implements ListenerRuntimeScheduler {
  private callback: (() => void) | null = null;
  private lastCallback: (() => void) | null = null;

  public schedule(callback: () => void): object {
    this.callback = callback;
    this.lastCallback = callback;
    return Object.freeze({});
  }

  public cancel(): void {
    this.callback = null;
  }

  public fireScheduled(): void {
    const callback = this.callback;
    if (callback === null) throw new Error('No callback is scheduled.');
    this.callback = null;
    callback();
  }

  public fireLastCallbackAgain(): void {
    const callback = this.lastCallback;
    if (callback === null) throw new Error('No callback was scheduled.');
    callback();
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error('Deferred is unavailable.');
      resolvePromise(value);
    },
  };
}
