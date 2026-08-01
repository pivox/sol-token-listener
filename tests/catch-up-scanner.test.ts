import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CatchUpSourceError,
  SolanaCatchUpSource,
  type CatchUpSignature,
} from '../src/solana/rpc/catch-up-source.js';
import {
  CatchUpScanner,
  CatchUpScannerError,
  CatchUpWindowExceededError,
  type CatchUpSource,
} from '../src/application/catch-up-scanner.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import type {
  ProcessingCheckpoint,
  TransactionNotification,
} from '../src/domain/transaction-ingestion.js';
import type { TransactionInboxRepository } from '../src/ports/transaction-inbox-repository.js';

const programs = [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID] as const;

void test('merges a shared signature once and orders oldest to newest deterministically', async () => {
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('z', 4), sig('shared', 3), sig('a', 2)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('m', 4), sig('shared', 3), sig('b', 2)]],
  });
  const inbox = new FakeInbox();
  const result = await scanner(source, inbox, { pageSize: 4 }).scan();

  assert.deepEqual(inbox.enqueued.map((value) => value.signature), ['a', 'b', 'shared', 'm', 'z']);
  assert.deepEqual(inbox.enqueued.map((value) => value.source), Array(5).fill('CATCH_UP'));
  assert.deepEqual(inbox.enqueued.map((value) => value.programIds), [
    [PUMP_PROGRAM_ID], [PUMPSWAP_PROGRAM_ID], [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID],
    [PUMPSWAP_PROGRAM_ID], [PUMP_PROGRAM_ID],
  ]);
  assert.ok(inbox.enqueued.every((value) => Object.isFrozen(value.programIds)));
  assert.deepEqual(inbox.stored.map(({ key, signature }) => [key, signature]), [
    ['launchpad', 'z'], ['market', 'm'],
  ]);
  assert.deepEqual(result, {
    discoveredCount: 6,
    enqueuedCount: 5,
    checkpointWriteCount: 2,
    pageCount: 2,
  });
  assert.ok(Object.isFrozen(result));
});

void test('uses before pagination and stops at an exact checkpoint boundary mid-page', async () => {
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('newest', 12), sig('boundary', 10), sig('old', 9)]],
    [PUMPSWAP_PROGRAM_ID]: [[]],
  });
  const inbox = new FakeInbox({ launchpad: checkpoint('launchpad', 'boundary', 10) });
  await scanner(source, inbox, { pageSize: 3 }).scan();
  assert.deepEqual(inbox.enqueued.map(({ signature }) => signature), ['newest']);
  assert.deepEqual(source.calls, [
    [PUMP_PROGRAM_ID, undefined, 3], [PUMPSWAP_PROGRAM_ID, undefined, 3],
  ]);
  assert.deepEqual(inbox.stored.map(({ key, signature }) => [key, signature]), [
    ['launchpad', 'newest'],
  ]);
});

void test('treats empty and short pages as true exhaustion and never invents checkpoints', async () => {
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [[]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('only', 7)]],
  });
  const inbox = new FakeInbox();
  const result = await scanner(source, inbox, { pageSize: 2 }).scan();
  assert.deepEqual(inbox.stored.map(({ key, signature }) => [key, signature]), [['market', 'only']]);
  assert.equal(result.checkpointWriteCount, 1);
});

void test('throws on a full max-page window and performs no durable writes', async () => {
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('4', 4), sig('3', 3)], [sig('2', 2), sig('1', 1)]],
    [PUMPSWAP_PROGRAM_ID]: [[]],
  });
  const inbox = new FakeInbox();
  await assert.rejects(scanner(source, inbox, { pageSize: 2, maxPages: 2 }).scan(), (error) => {
    assert.ok(error instanceof CatchUpWindowExceededError);
    assert.equal(error.program, 'launchpad');
    assert.equal(error.stage, 'window');
    assert.equal(error.message, 'Catch-up scan window was exceeded.');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
  assert.deepEqual(inbox.enqueued, []);
  assert.deepEqual(inbox.stored, []);
});

void test('rejects pagination cursor cycles and repeated rows', async () => {
  const cycling = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('b', 4), sig('a', 3)], [sig('c', 3), sig('a', 3)]],
    [PUMPSWAP_PROGRAM_ID]: [[]],
  });
  await assert.rejects(scanner(cycling, new FakeInbox(), { pageSize: 2 }).scan(), (error) => {
    assert.ok(error instanceof CatchUpSourceError);
    assert.equal(error.stage, 'pagination');
    return true;
  });

  const repeated = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('b', 2), sig('a', 1)], [sig('b', 2), sig('a', 1)]],
    [PUMPSWAP_PROGRAM_ID]: [[]],
  });
  await assert.rejects(scanner(repeated, new FakeInbox(), { pageSize: 2 }).scan(), CatchUpSourceError);
});

void test('rejects pages that violate newest-to-oldest slot ordering', async () => {
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('older', 2), sig('newer', 3)]],
    [PUMPSWAP_PROGRAM_ID]: [[]],
  });
  await assert.rejects(scanner(source, new FakeInbox()).scan(), (error) => {
    assert.ok(error instanceof CatchUpSourceError);
    assert.equal(error.stage, 'response');
    assert.equal(error.program, 'launchpad');
    return true;
  });
});

void test('rejects duplicate contradictions within or across programs', async () => {
  for (const conflicting of [sig('same', 8), sig('same', 7, 'finalized'), sig('same', 7, 'confirmed', 2_000)]) {
    const source = new FakeSource({
      [PUMP_PROGRAM_ID]: [[sig('same', 7)]],
      [PUMPSWAP_PROGRAM_ID]: [[conflicting]],
    });
    await assert.rejects(scanner(source, new FakeInbox(), { pageSize: 2 }).scan(), (error) => {
      assert.ok(error instanceof CatchUpSourceError);
      assert.equal(error.stage, 'response');
      return true;
    });
  }
});

void test('enqueues everything before checkpoints and writes none if enqueue fails', async () => {
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('a', 1)]], [PUMPSWAP_PROGRAM_ID]: [[sig('b', 2)]],
  });
  const inbox = new FakeInbox();
  inbox.failEnqueueAt = 2;
  await assert.rejects(scanner(source, inbox).scan(), (error) => {
    assert.ok(error instanceof CatchUpScannerError);
    assert.equal(error.stage, 'enqueue');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
  assert.deepEqual(inbox.stored, []);
});

void test('keeps partial checkpoint failure recovery-safe after all notifications are durable', async () => {
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('a', 1)]], [PUMPSWAP_PROGRAM_ID]: [[sig('b', 2)]],
  });
  const inbox = new FakeInbox();
  inbox.failCheckpointAt = 2;
  await assert.rejects(scanner(source, inbox).scan(), (error) => {
    assert.ok(error instanceof CatchUpScannerError);
    assert.equal(error.stage, 'checkpoint-write');
    return true;
  });
  assert.deepEqual(inbox.enqueued.map(({ signature }) => signature), ['a', 'b']);
  assert.deepEqual(inbox.stored.map(({ key }) => key), ['launchpad']);
});

void test('maps RPC commitment/status/time explicitly and freezes captured rows', async () => {
  const calls: unknown[][] = [];
  const source = new SolanaCatchUpSource({
    async getSignaturesForAddress(...args: unknown[]) {
      calls.push(args);
      return [{ signature: 'safe', slot: 42, err: null, memo: null, blockTime: 3, confirmationStatus: 'finalized' }];
    },
  }, 'confirmed');
  const rows = await source.list(PUMP_PROGRAM_ID, undefined, 10);
  assert.deepEqual(calls[0]?.slice(1), [{ before: undefined, limit: 10 }, 'confirmed']);
  assert.deepEqual(rows, [sig('safe', 42, 'finalized', 3_000)]);
  assert.ok(Object.isFrozen(rows));
  assert.ok(Object.isFrozen(rows[0]));
});

void test('rejects malformed, accessor-backed, unsafe, and over-limit RPC responses with redacted errors', async () => {
  const hostileUrl = 'https://secret.invalid/?token=do-not-leak';
  const cases: unknown[] = [
    null,
    { 0: sig('x', 1), length: 1 },
    [rpcSig('x', Number.MAX_SAFE_INTEGER + 1)],
    [rpcSig('x', -1)],
    [rpcSig('x', 1, 'processed', Number.MAX_SAFE_INTEGER)],
    [rpcSig('x', 1, 'mystery')],
    [rpcSig('x', 1, 'processed')],
    [rpcSig('x', 1), rpcSig('y', 2)],
  ];
  const accessor: Record<string, unknown> = rpcSig('x', 1);
  Object.defineProperty(accessor, 'slot', { enumerable: true, get: () => { throw new Error(hostileUrl); } });
  cases.push([accessor]);

  for (const value of cases) {
    const source = new SolanaCatchUpSource({ async getSignaturesForAddress() { return value; } }, 'confirmed');
    await assert.rejects(source.list(PUMP_PROGRAM_ID, undefined, 1), (error) => {
      assert.ok(error instanceof CatchUpSourceError);
      assert.equal(error.stage, 'response');
      assert.doesNotMatch(String(error), /secret|token|do-not-leak|unsafe|mystery/u);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
  }
});

void test('captures stateful proxy descriptors once and bounds page limits', async () => {
  let lengthReads = 0;
  const response = new Proxy([rpcSig('x', 1)], {
    getOwnPropertyDescriptor(target, property) {
      if (property === 'length') lengthReads += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  const source = new SolanaCatchUpSource({ async getSignaturesForAddress() { return response; } }, 'processed');
  assert.deepEqual(await source.list(PUMP_PROGRAM_ID, undefined, 1), [sig('x', 1, 'confirmed')]);
  assert.equal(lengthReads, 1);
  for (const limit of [0, 1_001, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(source.list(PUMP_PROGRAM_ID, undefined, limit), CatchUpSourceError);
  }
});

void test('accepts exact scanner config bounds and rejects maximum plus one', () => {
  const source = new FakeSource({ [PUMP_PROGRAM_ID]: [[]], [PUMPSWAP_PROGRAM_ID]: [[]] });
  assert.doesNotThrow(() => new CatchUpScanner(source, new FakeInbox(), {
    pageSize: 1_000, maxPages: 100,
  }));
  assert.throws(() => new CatchUpScanner(source, new FakeInbox(), {
    pageSize: 1_001, maxPages: 100,
  }), /bounds/u);
  assert.throws(() => new CatchUpScanner(source, new FakeInbox(), {
    pageSize: 1_000, maxPages: 101,
  }), /bounds/u);
});

void test('redacts RPC request failures including hostile getters', async () => {
  const error = Object.defineProperty(new Error(), 'message', {
    get: () => { throw new Error('https://secret.invalid/key'); },
  });
  const source = new SolanaCatchUpSource({
    async getSignaturesForAddress() { throw error; },
  }, 'finalized');
  await assert.rejects(source.list(PUMP_PROGRAM_ID, undefined, 1), (caught) => {
    assert.ok(caught instanceof CatchUpSourceError);
    assert.equal(caught.stage, 'request');
    assert.equal(caught.message, 'Catch-up RPC source failed.');
    assert.equal(Object.hasOwn(caught, 'cause'), false);
    return true;
  });
});

void test('redacts a hostile proxy rejected by the source without inspecting traps', async () => {
  let traps = 0;
  const hostile = new Proxy(new Error('hidden'), {
    getPrototypeOf() {
      traps += 1;
      throw new Error('https://secret.invalid/token');
    },
  });
  const source: CatchUpSource = {
    async list() { throw hostile; },
  };
  await assert.rejects(scanner(source, new FakeInbox()).scan(), (error) => {
    assert.ok(error instanceof CatchUpSourceError);
    assert.equal(error.stage, 'request');
    assert.doesNotMatch(String(error), /secret|token/u);
    return true;
  });
  assert.equal(traps, 0);
});

void test('rejects hostile checkpoints without invoking accessors or leaking values', async () => {
  const reads: PropertyKey[] = [];
  const hostile = new Proxy(checkpoint('market', 'secret-signature', 1), {
    get(_target, property) {
      reads.push(property);
      if (property === 'then') return undefined;
      throw new Error('https://secret.invalid/checkpoint');
    },
  });
  const inbox = new FakeInbox({ launchpad: hostile });
  await assert.rejects(scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[]], [PUMPSWAP_PROGRAM_ID]: [[]],
  }), inbox).scan(), (error) => {
    assert.ok(error instanceof CatchUpScannerError);
    assert.equal(error.stage, 'checkpoint-read');
    assert.doesNotMatch(String(error), /secret|invalid|checkpoint/u);
    return true;
  });
  assert.deepEqual(reads, ['then']);
});

function scanner(
  source: CatchUpSource,
  inbox: FakeInbox,
  options: { readonly pageSize?: number; readonly maxPages?: number } = {},
): CatchUpScanner {
  return new CatchUpScanner(source, inbox, {
    pageSize: options.pageSize ?? 2,
    maxPages: options.maxPages ?? 3,
    now: () => 9_000,
  });
}

function sig(
  signature: string,
  slot: number,
  confirmationStatus: CatchUpSignature['confirmationStatus'] = 'confirmed',
  blockTimeMs: number | null = 1_000,
): CatchUpSignature {
  return Object.freeze({ signature, slot: BigInt(slot), confirmationStatus, blockTimeMs });
}

function rpcSig(signature: string, slot: number, confirmationStatus = 'confirmed', blockTime: number | null = 1) {
  return { signature, slot, err: null, memo: null, blockTime, confirmationStatus };
}

function checkpoint(key: 'launchpad' | 'market', signature: string, slot: number): ProcessingCheckpoint {
  return Object.freeze({ key, signature, slot: BigInt(slot), updatedAtMs: 100 });
}

class FakeSource implements CatchUpSource {
  readonly calls: [string, string | undefined, number][] = [];
  private readonly positions = new Map<string, number>();

  constructor(private readonly pages: Record<string, readonly (readonly CatchUpSignature[])[]>) {}

  async list(programId: string, before: string | undefined, limit: number): Promise<readonly CatchUpSignature[]> {
    this.calls.push([programId, before, limit]);
    const position = this.positions.get(programId) ?? 0;
    this.positions.set(programId, position + 1);
    return this.pages[programId]?.[position] ?? [];
  }
}

class FakeInbox implements Pick<TransactionInboxRepository, 'enqueue' | 'readCheckpoint' | 'storeCheckpoint'> {
  readonly enqueued: TransactionNotification[] = [];
  readonly stored: ProcessingCheckpoint[] = [];
  failEnqueueAt: number | null = null;
  failCheckpointAt: number | null = null;

  constructor(private readonly checkpoints: Partial<Record<'launchpad' | 'market', ProcessingCheckpoint>> = {}) {}

  async enqueue(value: TransactionNotification): Promise<void> {
    if (this.failEnqueueAt === this.enqueued.length + 1) throw new Error('secret enqueue');
    this.enqueued.push(value);
  }

  async readCheckpoint(key: 'launchpad' | 'market'): Promise<ProcessingCheckpoint | null> {
    return this.checkpoints[key] ?? null;
  }

  async storeCheckpoint(value: ProcessingCheckpoint): Promise<void> {
    if (this.failCheckpointAt === this.stored.length + 1) throw new Error('secret checkpoint');
    this.stored.push(value);
  }
}

assert.deepEqual(programs, [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID]);
