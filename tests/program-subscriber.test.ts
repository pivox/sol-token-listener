import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Connection, Context, Logs, PublicKey } from '@solana/web3.js';
import type { TransactionNotification } from '../src/domain/transaction-ingestion.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import {
  ProgramSubscriberError,
  SolanaProgramSubscriber,
  type ProgramLogsCallback,
  type ProgramLogsConnection,
} from '../src/solana/rpc/program-subscriber.js';

const signature = '1'.repeat(64);
const web3ConnectionSatisfiesPort: Connection extends ProgramLogsConnection ? true : false = true;

void test('subscribes exactly once to both official programs at processed commitment', async () => {
  assert.equal(web3ConnectionSatisfiesPort, true);
  const connection = new FakeConnection();
  const subscriber = makeSubscriber(connection, new FakeInbox());

  await Promise.all([subscriber.start(), subscriber.start()]);

  assert.deepEqual(connection.subscriptions.map(({ programId, commitment }) => [
    programId, commitment,
  ]), [
    [PUMP_PROGRAM_ID, 'processed'],
    [PUMPSWAP_PROGRAM_ID, 'processed'],
  ]);
  assert.equal(subscriber.state, 'RUNNING');
  assert.equal(subscriber.lastError, null);
});

void test('enqueues a shared signature twice with distinct frozen program provenance', async () => {
  const connection = new FakeConnection();
  const inbox = new FakeInbox();
  const subscriber = makeSubscriber(connection, inbox);
  await subscriber.start();

  connection.emit(PUMP_PROGRAM_ID, logs(signature), context(42));
  connection.emit(PUMPSWAP_PROGRAM_ID, logs(signature), context(42));
  await tick();

  assert.deepEqual(inbox.notifications, [
    notification(PUMP_PROGRAM_ID),
    notification(PUMPSWAP_PROGRAM_ID),
  ]);
  assert.ok(inbox.notifications.every((value) => Object.isFrozen(value)));
  assert.ok(inbox.notifications.every((value) => Object.isFrozen(value.programIds)));
});

void test('deliberately ignores failed log notifications', async () => {
  const connection = new FakeConnection();
  const inbox = new FakeInbox();
  const subscriber = makeSubscriber(connection, inbox);
  await subscriber.start();

  connection.emit(PUMP_PROGRAM_ID, logs(signature, { InstructionError: [0, 'bad'] }), context(42));
  await tick();

  assert.deepEqual(inbox.notifications, []);
  assert.equal(subscriber.state, 'RUNNING');
  assert.equal(subscriber.lastError, null);
});

void test('rejects malformed signatures, unsafe slots, getters, proxies, and stateful values safely', async () => {
  let getterReads = 0;
  const invalidCases: readonly [unknown, unknown][] = [
    [logs('not canonical'), context(42)],
    [logs(signature), context(-1)],
    [logs(signature), context(Number.MAX_SAFE_INTEGER + 1)],
    [Object.defineProperty({}, 'signature', { enumerable: true, get() {
      throw new Error('raw getter secret');
    } }), context(42)],
    [logs(signature), new Proxy({}, { getOwnPropertyDescriptor() {
      throw new Error('raw proxy secret');
    } })],
    [Object.defineProperty({ err: null }, 'signature', {
      enumerable: true,
      get() { getterReads += 1; return signature; },
    }), context(42)],
  ];

  for (const [value, ctx] of invalidCases) {
    const connection = new FakeConnection();
    const inbox = new FakeInbox();
    const subscriber = makeSubscriber(connection, inbox);
    await subscriber.start();
    connection.emit(PUMP_PROGRAM_ID, value, ctx);
    await tick();
    assert.deepEqual(inbox.notifications, []);
    assert.equal(subscriber.state, 'DEGRADED');
    assertStableError(subscriber.lastError, 'notification');
    await subscriber.close();
  }
  assert.equal(getterReads, 0);
});

void test('stops accepting callbacks before close removes listeners', async () => {
  const connection = new FakeConnection();
  const inbox = new FakeInbox();
  const subscriber = makeSubscriber(connection, inbox);
  await subscriber.start();
  await subscriber.close();

  connection.emit(PUMP_PROGRAM_ID, logs(signature), context(42));
  await tick();

  assert.deepEqual(inbox.notifications, []);
  assert.equal(subscriber.state, 'STOPPED');
});

void test('awaits in-flight enqueues during shutdown', async () => {
  const connection = new FakeConnection();
  const inbox = new FakeInbox();
  const pending = deferred();
  inbox.enqueueResult = pending.promise;
  const subscriber = makeSubscriber(connection, inbox);
  await subscriber.start();
  connection.emit(PUMP_PROGRAM_ID, logs(signature), context(42));

  let closed = false;
  const closing = subscriber.close().then(() => { closed = true; });
  await tick();
  assert.equal(closed, false);
  assert.deepEqual(connection.removed, [1, 2]);

  pending.resolve();
  await closing;
  assert.equal(closed, true);
});

void test('contains enqueue rejection and reports only a stable redacted error seam', async () => {
  const connection = new FakeConnection();
  const inbox = new FakeInbox();
  inbox.enqueueResult = Promise.reject(new Error('secret https://rpc.invalid/key'));
  const subscriber = makeSubscriber(connection, inbox);
  await subscriber.start();

  connection.emit(PUMP_PROGRAM_ID, logs(signature), context(42));
  await tick();

  assert.equal(subscriber.state, 'DEGRADED');
  assertStableError(subscriber.lastError, 'enqueue');
  await subscriber.close();
});

void test('close is concurrent-safe, idempotent, and removes each listener once', async () => {
  const connection = new FakeConnection();
  const subscriber = makeSubscriber(connection, new FakeInbox());
  await subscriber.start();

  await Promise.all([subscriber.close(), subscriber.close(), subscriber.close()]);
  await subscriber.close();

  assert.deepEqual(connection.removed, [1, 2]);
  assert.equal(subscriber.state, 'STOPPED');
});

void test('aggregates all removal failures without leaking raw errors', async () => {
  const connection = new FakeConnection();
  connection.removeFailures.add(1);
  connection.removeFailures.add(2);
  const subscriber = makeSubscriber(connection, new FakeInbox());
  await subscriber.start();

  await assert.rejects(subscriber.close(), (error) => {
    assert.ok(error instanceof ProgramSubscriberError);
    assert.equal(error.stage, 'unsubscribe');
    assert.equal(error.failureCount, 2);
    assert.equal(error.message, 'Program subscriber operation failed.');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
  assert.deepEqual(connection.removed, [1, 2]);
  assertStableError(subscriber.lastError, 'unsubscribe', 2);
  await assert.rejects(subscriber.close(), ProgramSubscriberError);
});

void test('cleans an installed listener after partial setup failure', async () => {
  const connection = new FakeConnection();
  connection.subscribeFailureAt = 2;
  const subscriber = makeSubscriber(connection, new FakeInbox());

  await assert.rejects(subscriber.start(), (error) => {
    assert.ok(error instanceof ProgramSubscriberError);
    assert.equal(error.stage, 'subscribe');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
  assert.deepEqual(connection.removed, [1]);
  assert.equal(subscriber.state, 'STOPPED');
});

void test('rejects invalid or duplicate listener IDs and cleans every valid partial registration', async () => {
  for (const ids of [[1, -1], [1, 1], [1, 1.5]]) {
    const connection = new FakeConnection(ids);
    const subscriber = makeSubscriber(connection, new FakeInbox());
    await assert.rejects(subscriber.start(), ProgramSubscriberError);
    assert.deepEqual(connection.removed, [1]);
  }
});

void test('serializes start and concurrent close deterministically', async () => {
  const connection = new FakeConnection();
  const subscriber = makeSubscriber(connection, new FakeInbox());

  const starting = subscriber.start();
  const closing = subscriber.close();
  await Promise.all([starting, closing]);

  assert.equal(connection.subscriptions.length, 2);
  assert.deepEqual(connection.removed, [1, 2]);
  assert.equal(subscriber.state, 'STOPPED');
  await assert.rejects(subscriber.start(), (error) => {
    assertStableError(error, 'lifecycle');
    return true;
  });
});

void test('contains invalid local clock values and never substitutes a chain timestamp', async () => {
  for (const now of [() => -1, () => 1.5, () => Number.MAX_SAFE_INTEGER + 1, () => {
    throw new Error('clock secret');
  }]) {
    const connection = new FakeConnection();
    const inbox = new FakeInbox();
    const subscriber = new SolanaProgramSubscriber(connection, inbox, { now });
    await subscriber.start();
    connection.emit(PUMP_PROGRAM_ID, logs(signature), context(9_999));
    await tick();
    assert.deepEqual(inbox.notifications, []);
    assertStableError(subscriber.lastError, 'notification');
    await subscriber.close();
  }
});

void test('subscriber source has no transaction fetch, decoder, signing, or submission dependency', async () => {
  const source = await readFile(new URL(
    '../src/solana/rpc/program-subscriber.ts', import.meta.url,
  ), 'utf8');
  assert.doesNotMatch(source, /transaction-fetcher|decoder|sign(?:er|ing)|sendTransaction|sendRawTransaction/u);
});

class FakeConnection implements ProgramLogsConnection {
  public readonly subscriptions: {
    readonly programId: string;
    readonly callback: ProgramLogsCallback;
    readonly commitment: string;
  }[] = [];
  public readonly removed: number[] = [];
  public readonly removeFailures = new Set<number>();
  public subscribeFailureAt: number | null = null;

  public constructor(private readonly ids: readonly unknown[] = [1, 2]) {}

  public onLogs(
    filter: PublicKey,
    callback: ProgramLogsCallback,
    commitment: 'processed',
  ): number {
    const call = this.subscriptions.length + 1;
    if (this.subscribeFailureAt === call) throw new Error('subscription secret');
    this.subscriptions.push({ programId: filter.toBase58(), callback, commitment });
    return this.ids[call - 1] as number;
  }

  public async removeOnLogsListener(id: number): Promise<void> {
    this.removed.push(id);
    if (this.removeFailures.has(id)) throw new Error(`removal secret ${id}`);
  }

  public emit(programId: string, value: unknown, ctx: unknown): void {
    const subscription = this.subscriptions.find((item) => item.programId === programId);
    assert.ok(subscription);
    subscription.callback(value as Logs, ctx as Context);
  }
}

class FakeInbox {
  public readonly notifications: TransactionNotification[] = [];
  public enqueueResult: Promise<void> = Promise.resolve();

  public async enqueue(value: TransactionNotification): Promise<void> {
    this.notifications.push(value);
    await this.enqueueResult;
  }
}

function makeSubscriber(connection: FakeConnection, inbox: FakeInbox): SolanaProgramSubscriber {
  return new SolanaProgramSubscriber(connection, inbox, { now: () => 1_720_000_000_000 });
}

function logs(value: string, err: unknown = null): unknown {
  return { signature: value, err, logs: ['untrusted'] };
}

function context(slot: number): unknown {
  return { slot };
}

function notification(programId: string): TransactionNotification {
  return Object.freeze({
    signature,
    slot: 42n,
    source: 'WEBSOCKET',
    programIds: Object.freeze([programId]),
    confirmationStatus: 'processed',
    observedAtMs: 1_720_000_000_000,
  });
}

function assertStableError(
  error: unknown,
  stage: ProgramSubscriberError['stage'],
  failureCount = 1,
): asserts error is ProgramSubscriberError {
  assert.ok(error instanceof ProgramSubscriberError);
  assert.equal(error.stage, stage);
  assert.equal(error.failureCount, failureCount);
  assert.equal(error.message, 'Program subscriber operation failed.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}
