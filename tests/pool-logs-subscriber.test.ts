import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicKey } from '@solana/web3.js';
import type { TransactionNotification } from '../src/domain/transaction-ingestion.js';
import { PoolLogsSubscriber } from '../src/solana/rpc/pool-logs-subscriber.js';
import type { ProgramLogsCallback, ProgramLogsConnection } from '../src/solana/rpc/program-subscriber.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';

const POOL_A = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const POOL_B = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SIGNATURE = '5'.repeat(88);

class FakeConnection implements ProgramLogsConnection {
  public nextId = 1;
  public readonly callbacks = new Map<number, ProgramLogsCallback>();
  public readonly filters = new Map<number, string>();
  public readonly stateWatchers = new Map<number, (state: string) => void>();
  public readonly removed: number[] = [];
  public onLogsCalls = 0;
  public watchFailures = new Set<string>();
  public removeImpl: ((id: number) => Promise<void>) | null = null;
  onLogs(filter: PublicKey, callback: ProgramLogsCallback): unknown {
    this.onLogsCalls += 1;
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    this.filters.set(id, filter.toBase58());
    return id;
  }
  watchSubscriptionState(id: number, callback: (state: string) => void): () => void {
    const filter = this.filters.get(id);
    if (filter !== undefined && this.watchFailures.has(filter)) throw new Error('watch failed');
    this.stateWatchers.set(id, callback);
    return () => { this.stateWatchers.delete(id); };
  }
  async removeOnLogsListener(id: number): Promise<void> {
    this.removed.push(id);
    if (this.removeImpl !== null) await this.removeImpl(id);
  }
  createdIds(): number[] { return [...this.filters.keys()]; }
  idFor(pool: string): number {
    const entry = [...this.filters].reverse().find(([, filter]) => filter === pool);
    assert.ok(entry !== undefined);
    return entry[0];
  }
}

void test('sync subscribes new pools and unsubscribes pools that left', async () => {
  const connection = new FakeConnection();
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue() {} });
  await subscriber.sync([POOL_A, POOL_B]);
  assert.deepEqual([...connection.filters.values()].sort(), [POOL_A, POOL_B].sort());
  const idB = connection.idFor(POOL_B);
  await subscriber.sync([POOL_A]);
  assert.deepEqual(connection.removed, [idB]);
});

void test('a pool is healthy only after its subscription is acknowledged', async () => {
  const connection = new FakeConnection();
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue() {} });
  await subscriber.sync([POOL_A]);
  assert.equal(subscriber.isHealthy(POOL_A), false);
  connection.stateWatchers.get(connection.idFor(POOL_A))?.('subscribed');
  assert.equal(subscriber.isHealthy(POOL_A), true);
  connection.stateWatchers.get(connection.idFor(POOL_A))?.('pending');
  assert.equal(subscriber.isHealthy(POOL_A), false);
});

void test('a failed subscription is replaced at the next sync', async () => {
  const connection = new FakeConnection();
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue() { throw new Error('db down'); } });
  await subscriber.sync([POOL_A]);
  const first = connection.idFor(POOL_A);
  connection.stateWatchers.get(first)?.('subscribed');
  assert.equal(subscriber.isHealthy(POOL_A), true);
  connection.callbacks.get(first)?.({ signature: SIGNATURE, err: null, logs: [] }, { slot: 1 });
  await subscriber.drain();
  assert.equal(subscriber.isHealthy(POOL_A), false);
  await subscriber.sync([POOL_A]);
  assert.deepEqual(connection.removed, [first]);
  assert.equal(connection.onLogsCalls, 1, 'the replacement is deferred to the next sync');
  await subscriber.sync([POOL_A]);
  assert.notEqual(connection.idFor(POOL_A), first);
});

void test('notifications are enqueued as PumpSwap WebSocket discoveries', async () => {
  const connection = new FakeConnection();
  const enqueued: TransactionNotification[] = [];
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue(value) { enqueued.push(value); } }, () => 42);
  await subscriber.sync([POOL_A]);
  connection.callbacks.get(connection.idFor(POOL_A))?.({ signature: SIGNATURE, err: null, logs: [] }, { slot: 77 });
  await subscriber.drain();
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.slot, 77n);
  assert.equal(enqueued[0]?.source, 'WEBSOCKET');
  assert.deepEqual(enqueued[0]?.programIds, [PUMPSWAP_PROGRAM_ID]);
});

void test('close removes every subscription and stops accepting', async () => {
  const connection = new FakeConnection();
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue() {} });
  await subscriber.sync([POOL_A, POOL_B]);
  await subscriber.close();
  assert.equal(connection.removed.length, 2);
  await subscriber.sync([POOL_A]);
  assert.equal(connection.filters.size, 2, 'no new subscription after close');
});

void test('a lost subscription recovers on resubscribe and is not churned by sync', async () => {
  const connection = new FakeConnection();
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue() {} });
  await subscriber.sync([POOL_A]);
  const id = connection.idFor(POOL_A);
  const watch = connection.stateWatchers.get(id);
  watch?.('subscribed');
  watch?.('pending');
  assert.equal(subscriber.isHealthy(POOL_A), false);
  watch?.('subscribing');
  assert.equal(subscriber.isHealthy(POOL_A), false);
  watch?.('subscribed');
  assert.equal(subscriber.isHealthy(POOL_A), true);
  await subscriber.sync([POOL_A]);
  assert.deepEqual(connection.removed, []);
  assert.equal(connection.onLogsCalls, 1);
  watch?.('pending');
  await subscriber.sync([POOL_A]);
  assert.deepEqual(connection.removed, [], 'a merely lost listener is left for web3 to resubscribe');
  assert.equal(connection.onLogsCalls, 1);
});

void test('close during an in-flight sync waits for it and leaves nothing subscribed', async () => {
  const connection = new FakeConnection();
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue() {} });
  await subscriber.sync([POOL_A]);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  connection.removeImpl = async () => { await gate; };
  const syncing = subscriber.sync([POOL_B]);
  await new Promise((resolve) => setImmediate(resolve));
  const closing = subscriber.close();
  const callsAtClose = connection.onLogsCalls;
  connection.removeImpl = null;
  release();
  await Promise.all([syncing, closing]);
  assert.equal(connection.onLogsCalls, callsAtClose, 'no subscription after close');
  for (const id of connection.createdIds()) assert.ok(connection.removed.includes(id), `listener ${id} leaked`);
  await subscriber.sync([POOL_A, POOL_B]);
  assert.equal(connection.onLogsCalls, callsAtClose, 'sync after close is a no-op');
});

void test('an invalid pool address does not block other pools', async () => {
  const connection = new FakeConnection();
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue() {} });
  await subscriber.sync(['not-a-public-key!', POOL_A, POOL_B]);
  assert.deepEqual([...connection.filters.values()].sort(), [POOL_A, POOL_B].sort());
  assert.equal(subscriber.isHealthy('not-a-public-key!'), false);
});

void test('a watchSubscriptionState failure removes the created listener and other pools still subscribe', async () => {
  const connection = new FakeConnection();
  connection.watchFailures.add(POOL_A);
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue() {} });
  await subscriber.sync([POOL_A, POOL_B]);
  const idA = connection.idFor(POOL_A);
  assert.deepEqual(connection.removed, [idA]);
  assert.equal(subscriber.isHealthy(POOL_A), false);
  connection.stateWatchers.get(connection.idFor(POOL_B))?.('subscribed');
  assert.equal(subscriber.isHealthy(POOL_B), true);
  connection.watchFailures.clear();
  await subscriber.sync([POOL_A, POOL_B]);
  assert.notEqual(connection.idFor(POOL_A), idA, 'failed pool is retried at the next sync');
});

void test('removeOnLogsListener rejections do not stop sync or close', async () => {
  const connection = new FakeConnection();
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue() {} });
  await subscriber.sync([POOL_A, POOL_B]);
  const idA = connection.idFor(POOL_A);
  const idB = connection.idFor(POOL_B);
  connection.removeImpl = async (id) => { if (id === idA) throw new Error('rpc down'); };
  await subscriber.sync([]);
  assert.deepEqual(connection.removed.sort(), [idA, idB].sort());
  await subscriber.sync([POOL_A, POOL_B]);
  connection.removeImpl = async () => { throw new Error('rpc down'); };
  await subscriber.close();
  for (const id of connection.createdIds()) assert.ok(connection.removed.includes(id), `listener ${id} not removed`);
});

void test('a synchronous enqueue throw marks the listener failed without escaping', async () => {
  const connection = new FakeConnection();
  const subscriber = new PoolLogsSubscriber(connection, {
    enqueue() { throw new Error('sync throw'); },
  });
  await subscriber.sync([POOL_A]);
  const id = connection.idFor(POOL_A);
  connection.stateWatchers.get(id)?.('subscribed');
  assert.doesNotThrow(() => {
    connection.callbacks.get(id)?.({ signature: SIGNATURE, err: null, logs: [] }, { slot: 1 });
  });
  await subscriber.drain();
  assert.equal(subscriber.isHealthy(POOL_A), false);
});

void test('events for a pool no longer tracked are still enqueued', async () => {
  const connection = new FakeConnection();
  const enqueued: TransactionNotification[] = [];
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue(value) { enqueued.push(value); } });
  await subscriber.sync([POOL_A]);
  const callback = connection.callbacks.get(connection.idFor(POOL_A));
  await subscriber.sync([]);
  callback?.({ signature: SIGNATURE, err: null, logs: [] }, { slot: 5 });
  await subscriber.drain();
  assert.equal(enqueued.length, 1);
});

// Models web3.js 1.98.4 `_makeSubscription`: listeners with the same (method, args) share one
// subscription hash; a new listener joining a hash already 'subscribed' gets no state change.
class HashSharingConnection extends FakeConnection {
  public readonly hashState = new Map<string, string>();
  public readonly hashOf = new Map<number, string>();
  public readonly hashCallbacks = new Map<string, Set<number>>();
  public readonly hashWatchers = new Map<string, Set<(state: string) => void>>();
  public settleRemoval: ((hash: string) => void) | null = null;
  override onLogs(filter: PublicKey, callback: ProgramLogsCallback): unknown {
    const id = super.onLogs(filter, callback) as number;
    const hash = filter.toBase58();
    this.hashOf.set(id, hash);
    const ids = this.hashCallbacks.get(hash) ?? new Set<number>();
    ids.add(id);
    this.hashCallbacks.set(hash, ids);
    if (!this.hashState.has(hash)) this.hashState.set(hash, 'pending');
    return id;
  }
  override watchSubscriptionState(id: number, callback: (state: string) => void): () => void {
    const hash = this.hashOf.get(id) ?? '';
    const watchers = this.hashWatchers.get(hash) ?? new Set();
    watchers.add(callback);
    this.hashWatchers.set(hash, watchers);
    return () => { watchers.delete(callback); };
  }
  override async removeOnLogsListener(id: number): Promise<void> {
    this.removed.push(id);
    const hash = this.hashOf.get(id) ?? '';
    this.hashCallbacks.get(hash)?.delete(id);
    // The unsubscribe of the now-empty hash completes later (e.g. socket flagged down before close).
  }
  setState(hash: string, state: string): void {
    if (this.hashState.get(hash) === state) return;
    this.hashState.set(hash, state);
    for (const watcher of this.hashWatchers.get(hash) ?? []) watcher(state);
  }
  /** web3 tears down an empty hash once its unsubscribe completes. */
  settle(hash: string): void {
    if ((this.hashCallbacks.get(hash)?.size ?? 0) === 0) {
      this.setState(hash, 'unsubscribed');
      this.hashState.delete(hash);
    }
  }
}

void test('a replaced listener never joins the still-subscribed hash of the listener it replaces', async () => {
  const connection = new HashSharingConnection();
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue() { throw new Error('db down'); } });
  await subscriber.sync([POOL_A]);
  const first = connection.idFor(POOL_A);
  connection.setState(POOL_A, 'subscribed');
  connection.callbacks.get(first)?.({ signature: SIGNATURE, err: null, logs: [] }, { slot: 1 });
  await subscriber.drain();
  assert.equal(subscriber.isHealthy(POOL_A), false);
  await subscriber.sync([POOL_A]);
  assert.deepEqual(connection.removed, [first]);
  assert.equal(connection.hashState.get(POOL_A), 'subscribed', 'web3 has not torn the hash down yet');
  assert.equal(connection.onLogsCalls, 1, 'no listener joins the stale subscribed hash');
  connection.settle(POOL_A);
  await subscriber.sync([POOL_A]);
  assert.equal(connection.onLogsCalls, 2);
  connection.setState(POOL_A, 'subscribing');
  connection.setState(POOL_A, 'subscribed');
  assert.equal(subscriber.isHealthy(POOL_A), true, 'the fresh hash acknowledges the new listener');
});

class ManualTimer {
  public readonly timers: { callback: () => void; delayMs: number; cancelled: boolean }[] = [];
  schedule(callback: () => void, delayMs: number): unknown {
    const timer = { callback, delayMs, cancelled: false };
    this.timers.push(timer);
    return timer;
  }
  cancel(handle: unknown): void { (handle as { cancelled: boolean }).cancelled = true; }
}

void test('close bounds the drain of in-flight enqueues by drainTimeoutMs', async () => {
  const connection = new FakeConnection();
  const timer = new ManualTimer();
  const subscriber = new PoolLogsSubscriber(
    connection,
    { enqueue: () => new Promise<void>(() => undefined) },
    () => 1,
    { drainTimeoutMs: 1_234, timer },
  );
  await subscriber.sync([POOL_A]);
  connection.callbacks.get(connection.idFor(POOL_A))?.({ signature: SIGNATURE, err: null, logs: [] }, { slot: 1 });
  let closed = false;
  const closing = subscriber.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false, 'close waits for the drain');
  const pending = timer.timers.filter((entry) => !entry.cancelled);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.delayMs, 1_234);
  pending[0]?.callback();
  await closing;
  assert.equal(connection.removed.length, 1);
});

void test('a drain that completes in time cancels its timer', async () => {
  const connection = new FakeConnection();
  const timer = new ManualTimer();
  const subscriber = new PoolLogsSubscriber(connection, { async enqueue() {} }, () => 1, { timer });
  await subscriber.sync([POOL_A]);
  connection.callbacks.get(connection.idFor(POOL_A))?.({ signature: SIGNATURE, err: null, logs: [] }, { slot: 1 });
  await subscriber.close();
  assert.equal(timer.timers.length, 1);
  assert.equal(timer.timers[0]?.delayMs, 5_000, 'default drainTimeoutMs');
  assert.equal(timer.timers[0]?.cancelled, true);
});

void test('the subscriber rejects an invalid drainTimeoutMs', () => {
  for (const drainTimeoutMs of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => new PoolLogsSubscriber(new FakeConnection(), { async enqueue() {} }, () => 1, { drainTimeoutMs }),
      TypeError,
    );
  }
});
