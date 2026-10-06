import assert from 'node:assert/strict';
import bs58 from 'bs58';
import test from 'node:test';
import type { Context, Logs, PublicKey } from '@solana/web3.js';
import type { ProcessingCheckpoint, TransactionNotification } from '../src/domain/transaction-ingestion.js';
import { CatchUpScanner, type CatchUpSource } from '../src/application/catch-up-scanner.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import type { TransactionInboxRepository } from '../src/ports/transaction-inbox-repository.js';
import type { CatchUpSignature } from '../src/solana/rpc/catch-up-source.js';
import { SolanaProgramSubscriber, type ProgramLogsCallback, type ProgramLogsConnection } from '../src/solana/rpc/program-subscriber.js';

const frontier = 2_101n;
const oldCheckpoint: ProcessingCheckpoint = Object.freeze({
  key: 'launchpad', slot: 0n, signature: signature(0), updatedAtMs: 1,
});

void test('bootstrap overlaps websocket and bounded catch-up across 2,000+ signatures without loss or double application', async () => {
  const store = new DurableInbox({ launchpad: oldCheckpoint });
  const connection = new FakeConnection();
  const subscriber = new SolanaProgramSubscriber(connection, store);
  await subscriber.start();

  const rows = catchupRows();
  let emitted = false;
  const source: CatchUpSource = {
    async list(programId, before, limit) {
      if (programId === PUMPSWAP_PROGRAM_ID) return [catchupSignature(Number(frontier))];
      if (!emitted) {
        emitted = true;
        connection.emit(PUMP_PROGRAM_ID, signature(2_000), 2_000);
        connection.emit(PUMP_PROGRAM_ID, signature(2_102), 2_102);
      }
      const offset = before === undefined ? 0 : rows.findIndex((row) => row.signature === before) + 1;
      return rows.slice(offset, offset + limit);
    },
  };
  const scanner = new CatchUpScanner(source, store, {
    pageSize: 1_000, maxPages: 20, now: () => 1_000,
  });
  const result = await scanner.scan(programFrontiers(frontier));
  await subscriber.close();

  assert.equal(result.discoveredCount, 2_102);
  assert.equal(store.rows.size, 2_102);
  assert.equal(store.rows.get(signature(2_000))?.sources.size, 2);
  assert.equal(store.rows.get(signature(2_102))?.notifications, 1);
  assert.deepEqual(store.checkpoints.get('launchpad'), {
    key: 'launchpad', slot: 2_101n, signature: signature(2_101), updatedAtMs: 1_000,
  });
  assert.ok((store.checkpoints.get('launchpad')?.slot ?? 0n) <= frontier);
});

void test('crash during catch-up leaves checkpoint unchanged and restart resumes idempotently', async () => {
  const store = new DurableInbox({ launchpad: oldCheckpoint });
  store.failOnceOn = signature(1_500);
  const source = paginatedSource(catchupRows());

  await assert.rejects(new CatchUpScanner(source, store, {
    pageSize: 1_000, maxPages: 20,
  }).scan(programFrontiers(frontier)));
  assert.deepEqual(store.checkpoints.get('launchpad'), oldCheckpoint);
  const partiallyDurableCount = store.rows.size;
  assert.ok(partiallyDurableCount > 0);

  const restarted = new DurableInbox(store.checkpoints, store.rows);
  const result = await new CatchUpScanner(source, restarted, {
    pageSize: 1_000, maxPages: 20,
  }).scan(programFrontiers(frontier));
  assert.equal(result.discoveredCount, 2_102);
  assert.equal(restarted.rows.size, 2_101);
  assert.equal(restarted.checkpoints.get('launchpad')?.slot, frontier);
});

void test('websocket loss during catch-up is visible and no longer reports subscriber RUNNING', async () => {
  const store = new DurableInbox({ launchpad: oldCheckpoint });
  const connection = new FakeConnection();
  const subscriber = new SolanaProgramSubscriber(connection, store);
  await subscriber.start();
  connection.disconnect(1);
  assert.equal(subscriber.state, 'DEGRADED');
  await subscriber.close();
});

void test('RPC error during catch-up does not advance durable checkpoints', async () => {
  const store = new DurableInbox({ launchpad: oldCheckpoint });
  const source: CatchUpSource = { async list() { throw new Error('RPC unavailable'); } };
  await assert.rejects(new CatchUpScanner(source, store, {
    pageSize: 1_000, maxPages: 20,
  }).scan(programFrontiers(frontier)));
  assert.deepEqual(store.checkpoints.get('launchpad'), oldCheckpoint);
  assert.equal(store.rows.size, 0);
});

function catchupRows(): readonly CatchUpSignature[] {
  return Object.freeze([
    catchupSignature(2_102),
    ...Array.from({ length: 2_101 }, (_, index) => catchupSignature(2_101 - index)),
    catchupSignature(0),
  ]);
}

function catchupSignature(slot: number): CatchUpSignature {
  return { signature: signature(slot), slot: BigInt(slot), confirmationStatus: 'confirmed', blockTimeMs: null };
}

function paginatedSource(rows: readonly CatchUpSignature[]): CatchUpSource {
  return {
    async list(programId, before, limit) {
      if (programId === PUMPSWAP_PROGRAM_ID) return [catchupSignature(Number(frontier))];
      const offset = before === undefined ? 0 : rows.findIndex((row) => row.signature === before) + 1;
      return rows.slice(offset, offset + limit);
    },
  };
}

function signature(value: number): string {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(value, 60);
  return bs58.encode(bytes);
}

function programFrontiers(slot: bigint) {
  return Object.freeze({
    launchpad: Object.freeze({
      program: 'launchpad' as const, signature: signature(Number(slot)), slot,
      confirmationStatus: 'finalized' as const,
    }),
    market: Object.freeze({
      program: 'market' as const, signature: signature(Number(slot)), slot,
      confirmationStatus: 'finalized' as const,
    }),
  });
}

class DurableInbox implements Pick<TransactionInboxRepository, 'enqueue' | 'readCheckpoint' | 'storeCheckpoint'> {
  public readonly rows: Map<string, { notifications: number; sources: Set<string> }>;
  public readonly checkpoints: Map<'launchpad' | 'market', ProcessingCheckpoint>;
  public failOnceOn: string | null = null;

  public constructor(
    checkpoints: Partial<Record<'launchpad' | 'market', ProcessingCheckpoint>> | Map<'launchpad' | 'market', ProcessingCheckpoint> = {},
    rows = new Map<string, { notifications: number; sources: Set<string> }>(),
  ) {
    this.checkpoints = checkpoints instanceof Map
      ? new Map(checkpoints)
      : new Map(Object.entries(checkpoints) as ['launchpad' | 'market', ProcessingCheckpoint][]);
    this.rows = new Map([...rows].map(([key, row]) => [key, { notifications: row.notifications, sources: new Set(row.sources) }]));
  }

  public async enqueue(notification: TransactionNotification): Promise<void> {
    if (this.failOnceOn === notification.signature) {
      this.failOnceOn = null;
      throw new Error('simulated crash before durable enqueue');
    }
    const prior = this.rows.get(notification.signature);
    if (prior === undefined) {
      this.rows.set(notification.signature, { notifications: 1, sources: new Set([notification.source]) });
    } else {
      prior.sources.add(notification.source);
    }
  }

  public async readCheckpoint(key: 'launchpad' | 'market'): Promise<ProcessingCheckpoint | null> {
    return this.checkpoints.get(key) ?? null;
  }

  public async storeCheckpoint(value: ProcessingCheckpoint): Promise<void> {
    this.checkpoints.set(value.key, value);
  }
}

class FakeConnection implements ProgramLogsConnection {
  private readonly listeners = new Map<number, { programId: string; callback: ProgramLogsCallback }>();
  private readonly stateCallbacks = new Map<number, (state: string) => void>();
  private nextId = 0;

  public onLogs(filter: PublicKey, callback: ProgramLogsCallback): number {
    const id = ++this.nextId;
    this.listeners.set(id, { programId: filter.toBase58(), callback });
    return id;
  }

  public watchSubscriptionState(id: number, callback: (state: string) => void): () => void {
    this.stateCallbacks.set(id, callback);
    setImmediate(() => { callback('subscribed'); });
    return () => { this.stateCallbacks.delete(id); };
  }

  public async removeOnLogsListener(id: number): Promise<void> {
    this.listeners.delete(id);
  }

  public emit(programId: string, txSignature: string, slot: number): void {
    for (const row of this.listeners.values()) {
      if (row.programId === programId) row.callback({ signature: txSignature, err: null, logs: [] } as Logs, { slot } as Context);
    }
  }

  public disconnect(id: number): void {
    this.stateCallbacks.get(id)?.('pending');
  }
}
