import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  MAX_DATE_MS,
  MAX_STRICT_CATCH_UP_SLOT,
  type StrictCatchUpFailure,
} from '../src/domain/strict-catch-up.js';
import type { RpcProviderId } from '../src/domain/rpc-provider.js';
import type {
  ProcessingCheckpoint,
  ProcessingCheckpointKey,
  TransactionNotification,
} from '../src/domain/transaction-ingestion.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import type { StrictCatchUpRepository } from '../src/ports/strict-catch-up-repository.js';
import {
  CatchUpSourceError,
  MAX_CATCH_UP_PAGE_SIZE,
  type CatchUpSignature,
} from '../src/solana/rpc/catch-up-source.js';
import {
  MAX_STRICT_CATCH_UP_PAGES,
  StrictCatchUpScanner,
  StrictCatchUpScannerError,
  StrictCatchUpWindowExceededError,
  type StrictCatchUpSource,
} from '../src/application/strict-catch-up-scanner.js';
import { executionBoundaryViolations } from './helpers/execution-boundary.js';

const programs = [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID] as const;
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const NEVER_ABORTED = new AbortController().signal;

void test('aborts before the scan without calling the clock, repository, or source', async () => {
  const events: string[] = [];
  let nowCalls = 0;
  const controller = new AbortController();
  controller.abort();
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch', 1)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 2)]],
  }, 'primary', events);
  const repository = new FakeRepository({}, events);

  await assert.rejects(new StrictCatchUpScanner(source, repository, {
    pageSize: 2,
    maxPages: 3,
    now: () => { nowCalls += 1; return 9_000; },
  }).scan(controller.signal), abortedScan);

  assert.equal(nowCalls, 0);
  assert.deepEqual(events, []);
});

void test('aborts after a provider page settles without enqueueing', async () => {
  const page = deferred<unknown>();
  const controller = new AbortController();
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 2)]],
  });
  source.nextList = page.promise;
  const repository = new FakeRepository();

  const scan = scanner(source, repository).scan(controller.signal);
  await waitFor(() => source.calls.length === 1);
  controller.abort();
  page.resolve([sig('launch', 1)]);

  await assert.rejects(scan, abortedScan);
  assert.deepEqual(source.calls, [[PUMP_PROGRAM_ID, undefined, 2]]);
  assertNoWrites(repository);
});

void test('aborts after an enqueue settles without starting another durable write', async () => {
  const enqueue = deferred<undefined>();
  const controller = new AbortController();
  const repository = new FakeRepository();
  repository.nextEnqueue = enqueue.promise;
  const scan = scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch', 1)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 2)]],
  }), repository).scan(controller.signal);
  await waitFor(() => repository.eventsSeen.includes('enqueue:launch'));

  controller.abort();
  enqueue.resolve(undefined);

  await assert.rejects(scan, abortedScan);
  assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['launch']);
  assert.deepEqual(repository.cas, []);
  assert.deepEqual(repository.resolutions, []);
});

void test('aborts after the first CAS settles without rolling it back or starting the second CAS', async () => {
  const firstCas = deferred<undefined>();
  const controller = new AbortController();
  const repository = new FakeRepository();
  repository.nextCas = firstCas.promise;
  const scan = scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch', 1)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 2)]],
  }), repository).scan(controller.signal);
  await waitFor(() => repository.eventsSeen.includes('cas:launchpad'));

  controller.abort();
  firstCas.resolve(undefined);

  await assert.rejects(scan, abortedScan);
  assert.deepEqual(repository.cas.map(([, next]) => next.key), ['launchpad']);
  assert.deepEqual(repository.resolutions, []);
});

void test('compares private exact window frontiers without enumerating or serializing signatures', () => {
  const frontier = Object.freeze({
    launchpad: checkpoint('launchpad', 'launch-secret', 10, 1),
    market: checkpoint('market', 'market-secret', 11, 1),
  });
  const first = new StrictCatchUpWindowExceededError('primary', 'launchpad', frontier);
  const equal = new StrictCatchUpWindowExceededError('fallback-1', 'market', frontier);
  const different = new StrictCatchUpWindowExceededError('fallback-2', 'market', Object.freeze({
    ...frontier,
    market: checkpoint('market', 'different-secret', 11, 1),
  }));

  assert.equal(first.sameFrontier(equal), true);
  assert.equal(first.sameFrontier(different), false);
  assert.deepEqual(Object.keys(first), [
    'code', 'stage', 'retryable', 'providerId', 'checkpointKey',
  ]);
  assert.doesNotMatch(JSON.stringify(first), /launch-secret|market-secret/u);
});

void test('captures now and both exact checkpoints before the first provider page', async () => {
  const events: string[] = [];
  let nowCalls = 0;
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch-head', 12), sig('launch-boundary', 10)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market-boundary', 20)]],
  }, 'fallback-2', events);
  const repository = new FakeRepository({
    launchpad: checkpoint('launchpad', 'launch-boundary', 10, 50),
    market: checkpoint('market', 'market-boundary', 20, 60),
  }, events);

  const result = await new StrictCatchUpScanner(source, repository, {
    pageSize: 2,
    maxPages: 3,
    now: () => { nowCalls += 1; events.push('now'); return 9_000; },
  }).scan(NEVER_ABORTED);

  assert.equal(nowCalls, 1);
  assert.deepEqual(events.slice(0, 4), [
    'now', 'read:launchpad', 'read:market', `source:${PUMP_PROGRAM_ID}:head`,
  ]);
  assert.equal(source.providerIdsSeen.every((value) => value === source.providerId), true);
  assert.deepEqual(result.boundaries, {
    launchpad: checkpoint('launchpad', 'launch-boundary', 10, 50),
    market: checkpoint('market', 'market-boundary', 20, 60),
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.boundaries));
  assert.ok(Object.isFrozen(result.boundaries.launchpad));
});

void test('walks more than one page with before and stops at an exact mid-page boundary', async () => {
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [
      [sig('l5', 15), sig('l4', 14)],
      [sig('l3', 13), sig('launch-boundary', 12)],
    ],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market-boundary', 8)]],
  });
  const repository = new FakeRepository({
    launchpad: checkpoint('launchpad', 'launch-boundary', 12),
    market: checkpoint('market', 'market-boundary', 8),
  });

  const result = await scanner(source, repository, { pageSize: 2 }).scan(NEVER_ABORTED);

  assert.deepEqual(source.calls, [
    [PUMP_PROGRAM_ID, undefined, 2],
    [PUMP_PROGRAM_ID, 'l4', 2],
    [PUMPSWAP_PROGRAM_ID, undefined, 2],
  ]);
  assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['l3', 'l4', 'l5']);
  assert.equal(result.pageCount, 3);
  assert.equal(result.discoveredCount, 3);
});

void test('finishes both program walks before any durable write', async () => {
  const events: string[] = [];
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch', 2)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 3)]],
  }, 'primary', events);
  const repository = new FakeRepository({}, events);

  await scanner(source, repository).scan(NEVER_ABORTED);

  const lastSource = Math.max(...events.map((value, index) => value.startsWith('source:') ? index : -1));
  const firstWrite = events.findIndex((value) => value.startsWith('enqueue:'));
  assert.ok(lastSource < firstWrite);
});

void test('cold start consumes exactly one bounded newest page and handles empty history unchanged', async () => {
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch-new', 4), sig('launch-old', 3)], [sig('must-not-read', 2)]],
    [PUMPSWAP_PROGRAM_ID]: [[]],
  });
  const repository = new FakeRepository();

  const result = await scanner(source, repository, { pageSize: 2, maxPages: 1 }).scan(NEVER_ABORTED);

  assert.deepEqual(source.calls, [
    [PUMP_PROGRAM_ID, undefined, 2], [PUMPSWAP_PROGRAM_ID, undefined, 2],
  ]);
  assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['launch-old', 'launch-new']);
  assert.deepEqual(repository.cas, [[
    null, checkpoint('launchpad', 'launch-new', 4, 9_000),
  ]]);
  assert.deepEqual(repository.resolutions, [['market', null]]);
  assert.deepEqual(result, {
    providerId: 'primary', discoveredCount: 2, enqueuedCount: 2,
    checkpointCasCount: 1, pageCount: 2,
    boundaries: Object.freeze({ launchpad: null, market: null }),
  });
});

void test('rejects ascending slots, duplicate signatures, and repeated pagination cursors', async () => {
  const cases: readonly (readonly (readonly CatchUpSignature[])[])[] = [
    [[sig('older', 2), sig('newer', 3)]],
    [[sig('same', 3), sig('same', 2)]],
    [[sig('b', 4), sig('a', 3)], [sig('c', 2), sig('a', 1)]],
  ];
  for (const pages of cases) {
    const repository = new FakeRepository({
      launchpad: checkpoint('launchpad', 'missing', 0),
      market: checkpoint('market', 'market-boundary', 1),
    });
    await assert.rejects(scanner(new FakeSource({
      [PUMP_PROGRAM_ID]: pages,
      [PUMPSWAP_PROGRAM_ID]: [[sig('market-boundary', 1)]],
    }), repository).scan(NEVER_ABORTED), (error) => sourceFailure(error, 'launchpad'));
    assertNoWrites(repository);
  }
});

void test('rejects non-canonical source signatures before every durable write', async () => {
  const signatures = [
    '',
    ' padded',
    'trailing ',
    ' ',
    'é'.repeat(65),
  ];
  for (const signature of signatures) {
    const repository = new FakeRepository();
    await assert.rejects(scanner(new FakeSource({
      [PUMP_PROGRAM_ID]: [[sig(signature, 2)]],
      [PUMPSWAP_PROGRAM_ID]: [[]],
    }), repository).scan(NEVER_ABORTED), (error) => sourceResponseFailure(error, 'launchpad'));
    assertNoWrites(repository);
  }
});

void test('rejects source block times outside the integer Date range before every durable write', async () => {
  const blockTimes = [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER, MAX_DATE_MS + 1];
  for (const blockTimeMs of blockTimes) {
    const repository = new FakeRepository();
    await assert.rejects(scanner(new FakeSource({
      [PUMP_PROGRAM_ID]: [[sig('hostile-time', 2, 'confirmed', blockTimeMs)]],
      [PUMPSWAP_PROGRAM_ID]: [[]],
    }), repository).scan(NEVER_ABORTED), (error) => sourceResponseFailure(error, 'launchpad'));
    assertNoWrites(repository);
  }
});

void test('merges identical signatures with legacy finality, immutability, program sorting, and order', async () => {
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [[
      sig('z', 4), sig('shared', 3, 'confirmed', null), sig('a', 2),
    ]],
    [PUMPSWAP_PROGRAM_ID]: [[
      sig('m', 4), sig('shared', 3, 'finalized', 2_000), sig('b', 2),
    ]],
  });
  const repository = new FakeRepository();

  await scanner(source, repository, { pageSize: 3 }).scan(NEVER_ABORTED);

  assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['a', 'b', 'shared', 'm', 'z']);
  const shared = repository.enqueued[2];
  assert.deepEqual(shared, {
    signature: 'shared', slot: 3n, source: 'CATCH_UP',
    programIds: [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID],
    confirmationStatus: 'finalized', observedAtMs: 9_000,
  });
  assert.ok(Object.isFrozen(shared?.programIds));

  for (const conflicting of [sig('shared', 8), sig('shared', 3, 'confirmed', 3_000)]) {
    await assert.rejects(scanner(new FakeSource({
      [PUMP_PROGRAM_ID]: [[sig('shared', 3, 'confirmed', 2_000)]],
      [PUMPSWAP_PROGRAM_ID]: [[conflicting]],
    }), new FakeRepository(), { pageSize: 2 }).scan(NEVER_ABORTED), (error) => sourceFailure(error, 'market'));
  }
});

void test('enqueues every discovery before exact sequential CAS operations', async () => {
  const events: string[] = [];
  const repository = new FakeRepository({}, events);
  const result = await scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch', 1)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 2)]],
  }, 'fallback-1', events), repository).scan(NEVER_ABORTED);

  assert.deepEqual(events.filter((value) => value.startsWith('enqueue:') || value.startsWith('cas:')), [
    'enqueue:launch', 'enqueue:market', 'cas:launchpad', 'cas:market',
  ]);
  assert.equal(result.checkpointCasCount, 2);
});

void test('maps enqueue failure to a fixed transient error and performs no CAS or resolution', async () => {
  const repository = new FakeRepository();
  repository.failEnqueueAt = 2;
  await assert.rejects(scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch', 1)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 2)]],
  }), repository).scan(NEVER_ABORTED), (error) => scannerFailure(error, 'enqueue', 'market'));
  assert.deepEqual(repository.cas, []);
  assert.deepEqual(repository.resolutions, []);
});

void test('records exact durable window evidence for a first-program failure and performs no other writes', async () => {
  const previous = checkpoint('launchpad', 'missing', 1, 111);
  const repository = new FakeRepository({ launchpad: previous });

  await assert.rejects(scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('head', 5)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 2)]],
  }, 'fallback-3'), repository, { pageSize: 2 }).scan(NEVER_ABORTED), (error) => {
    assert.ok(error instanceof StrictCatchUpWindowExceededError);
    assert.equal(error.providerId, 'fallback-3');
    assert.equal(error.checkpointKey, 'launchpad');
    assert.equal(error.stage, 'window');
    assert.equal(error.code, 'CATCH_UP_WINDOW_EXCEEDED');
    assert.equal(error.retryable, false);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.doesNotMatch(JSON.stringify(error), /missing|head/u);
    return true;
  });
  assert.equal(repository.failures.length, 1);
  assert.deepEqual(projectFailure(repository.failures[0]), {
    checkpointKey: 'launchpad', previous, providerId: 'fallback-3',
    observedHeadSlot: 5n, detectedAtMs: 9_000,
  });
  assertNoWrites(repository, true);
});

void test('records only second-program window evidence after a successful in-memory first walk', async () => {
  const previous = checkpoint('market', 'missing-market', 1, 222);
  const repository = new FakeRepository({ market: previous });

  await assert.rejects(scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch', 2)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market-head', 9)]],
  }), repository, { pageSize: 2 }).scan(NEVER_ABORTED), (error) =>
    error instanceof StrictCatchUpWindowExceededError && error.checkpointKey === 'market');

  assert.deepEqual(projectFailure(repository.failures[0]), {
    checkpointKey: 'market', previous, providerId: 'primary',
    observedHeadSlot: 9n, detectedAtMs: 9_000,
  });
  assertNoWrites(repository, true);
});

void test('maps a strict failure persistence rejection to failure-write without leaking the window error', async () => {
  const repository = new FakeRepository({ launchpad: checkpoint('launchpad', 'secret-boundary', 1) });
  repository.failFailureWrite = true;
  await assert.rejects(scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[]], [PUMPSWAP_PROGRAM_ID]: [[]],
  }), repository).scan(NEVER_ABORTED), (error) => scannerFailure(error, 'failure-write', 'launchpad'));
});

void test('resolves exact unchanged and empty boundaries when no CAS is required', async () => {
  const launchpad = checkpoint('launchpad', 'launch-boundary', 10, 100);
  const repository = new FakeRepository({ launchpad });
  const result = await scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch-boundary', 10)]],
    [PUMPSWAP_PROGRAM_ID]: [[]],
  }), repository).scan(NEVER_ABORTED);

  assert.deepEqual(repository.cas, []);
  assert.deepEqual(repository.resolutions, [
    ['launchpad', launchpad], ['market', null],
  ]);
  assert.equal(result.checkpointCasCount, 0);
});

void test('uses captured expected and newest next values for changed CAS', async () => {
  const previous = checkpoint('launchpad', 'launch-boundary', 10, 123);
  const repository = new FakeRepository({ launchpad: previous });
  await scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch-head', 12), sig('launch-boundary', 10)]],
    [PUMPSWAP_PROGRAM_ID]: [[]],
  }), repository).scan(NEVER_ABORTED);

  assert.deepEqual(repository.cas, [[
    previous, checkpoint('launchpad', 'launch-head', 12, 9_000),
  ]]);
  assert.deepEqual(repository.resolutions, [['market', null]]);
});

void test('surfaces a transient second CAS conflict after the first CAS and replays safely', async () => {
  const sourcePages = {
    [PUMP_PROGRAM_ID]: [[sig('launch', 1)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 2)]],
  };
  const repository = new FakeRepository();
  repository.failCasAt = 2;
  await assert.rejects(scanner(new FakeSource(sourcePages), repository).scan(NEVER_ABORTED), (error) =>
    scannerFailure(error, 'checkpoint-cas', 'market'));
  assert.deepEqual(repository.cas.map(([, next]) => next.key), ['launchpad']);
  assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['launch', 'market']);

  repository.failCasAt = null;
  await scanner(new FakeSource(sourcePages), repository).scan(NEVER_ABORTED);
  assert.deepEqual(repository.enqueued.map(({ signature }) => signature), [
    'launch', 'market', 'market',
  ]);
  assert.deepEqual(repository.cas.map(([, next]) => next.key), ['launchpad', 'market']);
});

void test('replays duplicate enqueues after an enqueue crash without advancing a checkpoint', async () => {
  const sourcePages = {
    [PUMP_PROGRAM_ID]: [[sig('launch', 1)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 2)]],
  };
  const repository = new FakeRepository();
  repository.failEnqueueAt = 2;
  await assert.rejects(scanner(new FakeSource(sourcePages), repository).scan(NEVER_ABORTED), StrictCatchUpScannerError);
  repository.failEnqueueAt = null;
  await scanner(new FakeSource(sourcePages), repository).scan(NEVER_ABORTED);
  assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['launch', 'launch', 'market']);
});

void test('maps exact-boundary failure resolution rejection to failure-resolve', async () => {
  const repository = new FakeRepository();
  repository.failResolveAt = 1;
  await assert.rejects(scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[]], [PUMPSWAP_PROGRAM_ID]: [[]],
  }), repository).scan(NEVER_ABORTED), (error) => scannerFailure(error, 'failure-resolve', 'launchpad'));
});

void test('redacts hostile checkpoint, source, repository, clock, and provider inputs', async () => {
  let proxyTraps = 0;
  const hostileCheckpoint = new Proxy(checkpoint('launchpad', 'do-not-leak', 1), {
    getPrototypeOf() { proxyTraps += 1; throw new Error('https://secret.invalid'); },
    ownKeys() { proxyTraps += 1; throw new Error('https://secret.invalid'); },
    getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('https://secret.invalid'); },
  });
  const repository = new FakeRepository({ launchpad: hostileCheckpoint });
  await assert.rejects(scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[]], [PUMPSWAP_PROGRAM_ID]: [[]],
  }), repository).scan(NEVER_ABORTED), (error) => scannerFailure(error, 'checkpoint-read', 'launchpad'));
  assert.equal(proxyTraps, 0);

  const hostileError = new Proxy(new Error('hidden'), {
    getPrototypeOf() { proxyTraps += 1; throw new Error('https://secret.invalid'); },
  });
  const source = new FakeSource({ [PUMP_PROGRAM_ID]: [[]], [PUMPSWAP_PROGRAM_ID]: [[]] });
  source.failure = hostileError;
  await assert.rejects(scanner(source, new FakeRepository()).scan(NEVER_ABORTED), (error) => {
    assert.equal(scannerFailure(error, 'source', 'launchpad'), true);
    assert.equal((error as StrictCatchUpScannerError).sourceStage, 'request');
    assert.doesNotMatch(String(error), /secret|invalid|hidden/u);
    return true;
  });

  assert.throws(() => new StrictCatchUpScanner(
    Object.freeze({ providerId: 'provider-secret' as RpcProviderId, async list() { return []; } }),
    new FakeRepository(), { pageSize: 1, maxPages: 1 },
  ), /source is invalid/u);
  await assert.rejects(scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[]], [PUMPSWAP_PROGRAM_ID]: [[]],
  }), new FakeRepository(), { now: () => { throw new Error('clock-secret'); } }).scan(NEVER_ABORTED));
});

void test('accepts exact bounds and rejects invalid options and checkpoint persistence bounds', async () => {
  const source = new FakeSource({ [PUMP_PROGRAM_ID]: [[]], [PUMPSWAP_PROGRAM_ID]: [[]] });
  assert.doesNotThrow(() => new StrictCatchUpScanner(source, new FakeRepository(), {
    pageSize: MAX_CATCH_UP_PAGE_SIZE, maxPages: MAX_STRICT_CATCH_UP_PAGES, now: () => MAX_DATE_MS,
  }));
  const invalidBounds = [[0, 1], [1_001, 1], [1, 0], [1, 101], [1.5, 1]] as const;
  for (const [pageSize, maxPages] of invalidBounds) {
    assert.throws(() => new StrictCatchUpScanner(source, new FakeRepository(), { pageSize, maxPages }), /bounds/u);
  }
  assert.throws(() => new StrictCatchUpScanner(source, new FakeRepository(), {
    pageSize: 1, maxPages: 1, policy: 'live-edge',
  } as never), /bounds/u);
  const accessorOptions = Object.defineProperty({ pageSize: 1, maxPages: 1 }, 'now', {
    enumerable: true,
    get: () => () => 1,
  });
  assert.throws(() => new StrictCatchUpScanner(source, new FakeRepository(), accessorOptions), /bounds/u);
  for (const value of [
    checkpoint('launchpad', ' padded', 1),
    Object.freeze({ ...checkpoint('launchpad', 'x', 1), slot: MAX_STRICT_CATCH_UP_SLOT + 1n }),
    Object.freeze({ ...checkpoint('launchpad', 'x', 1), updatedAtMs: MAX_DATE_MS + 1 }),
    Object.freeze({ ...checkpoint('launchpad', 'x', 1), extra: 'not-canonical' }),
    Object.freeze(Object.assign(Object.create({ inherited: true }), checkpoint('launchpad', 'x', 1))),
  ]) {
    await assert.rejects(scanner(source, new FakeRepository({ launchpad: value })).scan(NEVER_ABORTED),
      (error) => scannerFailure(error, 'checkpoint-read', 'launchpad'));
  }
});

void test('has no live-edge, checkpoint overwrite, gap, WebSocket, or execution dependencies', async () => {
  const path = fileURLToPath(new URL('../src/application/strict-catch-up-scanner.ts', import.meta.url));
  const sourceText = await readFile(path, 'utf8');
  assert.doesNotMatch(sourceText, /live-edge|storeCheckpoint|recordCatchUpGap|websocket|\bws\b/iu);
  assert.deepEqual(executionBoundaryViolations(sourceText, path, repositoryRoot), []);
});

function scanner(
  source: StrictCatchUpSource,
  repository: FakeRepository,
  overrides: {
    readonly pageSize?: number;
    readonly maxPages?: number;
    readonly now?: () => number;
  } = {},
): StrictCatchUpScanner {
  return new StrictCatchUpScanner(source, repository, {
    pageSize: overrides.pageSize ?? 2,
    maxPages: overrides.maxPages ?? 3,
    now: overrides.now ?? (() => 9_000),
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

function checkpoint(
  key: ProcessingCheckpointKey,
  signature: string,
  slot: number,
  updatedAtMs = 100,
): ProcessingCheckpoint {
  return Object.freeze({ key, signature, slot: BigInt(slot), updatedAtMs });
}

class FakeSource implements StrictCatchUpSource {
  readonly calls: [string, string | undefined, number][] = [];
  readonly providerIdsSeen: RpcProviderId[] = [];
  failure: Error | null = null;
  nextList: Promise<unknown> | null = null;
  private readonly positions = new Map<string, number>();

  constructor(
    private readonly pages: Readonly<Record<string, readonly (readonly CatchUpSignature[])[]>>,
    readonly providerId: RpcProviderId = 'primary',
    private readonly events: string[] = [],
  ) {}

  async list(programId: string, before: string | undefined, limit: number): Promise<unknown> {
    this.providerIdsSeen.push(this.providerId);
    this.calls.push([programId, before, limit]);
    this.events.push(`source:${programId}:${before ?? 'head'}`);
    if (this.failure !== null) throw this.failure;
    if (this.nextList !== null) {
      const next = this.nextList;
      this.nextList = null;
      return next;
    }
    const position = this.positions.get(programId) ?? 0;
    this.positions.set(programId, position + 1);
    return this.pages[programId]?.[position] ?? [];
  }
}

class FakeRepository implements StrictCatchUpRepository {
  readonly enqueued: TransactionNotification[] = [];
  readonly cas: [ProcessingCheckpoint | null, ProcessingCheckpoint][] = [];
  readonly failures: StrictCatchUpFailure[] = [];
  readonly resolutions: [ProcessingCheckpointKey, ProcessingCheckpoint | null][] = [];
  failEnqueueAt: number | null = null;
  failCasAt: number | null = null;
  failResolveAt: number | null = null;
  failFailureWrite = false;
  nextEnqueue: Promise<void> | null = null;
  nextCas: Promise<void> | null = null;
  private casAttempts = 0;
  private resolveAttempts = 0;

  constructor(
    private readonly checkpoints: Partial<Record<ProcessingCheckpointKey, ProcessingCheckpoint>> = {},
    private readonly events: string[] = [],
  ) {}

  get eventsSeen(): readonly string[] {
    return this.events;
  }

  async enqueue(value: TransactionNotification): Promise<void> {
    this.events.push(`enqueue:${value.signature}`);
    if (this.nextEnqueue !== null) {
      const next = this.nextEnqueue;
      this.nextEnqueue = null;
      await next;
    }
    if (this.failEnqueueAt === this.enqueued.length + 1) throw new Error('enqueue-secret');
    this.enqueued.push(value);
  }

  async readCheckpoint(key: ProcessingCheckpointKey): Promise<ProcessingCheckpoint | null> {
    this.events.push(`read:${key}`);
    return this.checkpoints[key] ?? null;
  }

  async compareAndSwapCheckpoint(
    expected: ProcessingCheckpoint | null,
    next: ProcessingCheckpoint,
  ): Promise<void> {
    this.casAttempts += 1;
    this.events.push(`cas:${next.key}`);
    if (this.nextCas !== null) {
      const pending = this.nextCas;
      this.nextCas = null;
      await pending;
    }
    if (this.failCasAt === this.casAttempts) throw new Error('checkpoint-conflict-secret');
    this.cas.push([expected, next]);
    this.checkpoints[next.key] = next;
  }

  async recordStrictCatchUpFailure(value: StrictCatchUpFailure): Promise<void> {
    this.events.push(`failure:${value.checkpointKey}`);
    if (this.failFailureWrite) throw new Error('failure-write-secret');
    this.failures.push(value);
  }

  async resolveStrictCatchUpFailures(
    key: ProcessingCheckpointKey,
    previous: ProcessingCheckpoint | null,
  ): Promise<void> {
    this.resolveAttempts += 1;
    this.events.push(`resolve:${key}`);
    if (this.failResolveAt === this.resolveAttempts) throw new Error('resolve-secret');
    this.resolutions.push([key, previous]);
  }
}

function scannerFailure(
  value: unknown,
  stage: StrictCatchUpScannerError['stage'],
  checkpointKey: ProcessingCheckpointKey,
): boolean {
  assert.ok(value instanceof StrictCatchUpScannerError);
  assert.equal(value.stage, stage);
  assert.equal(value.checkpointKey, checkpointKey);
  assert.equal(value.retryable, true);
  assert.equal(Object.hasOwn(value, 'cause'), false);
  assert.doesNotMatch(JSON.stringify(value), /secret|signature|url|http/iu);
  assert.ok(Object.isFrozen(value));
  return true;
}

function sourceFailure(value: unknown, key: ProcessingCheckpointKey): boolean {
  scannerFailure(value, 'source', key);
  assert.ok(value instanceof StrictCatchUpScannerError);
  assert.ok(value.sourceStage === 'response' || value.sourceStage === 'pagination');
  return true;
}

function sourceResponseFailure(value: unknown, key: ProcessingCheckpointKey): boolean {
  scannerFailure(value, 'source', key);
  assert.ok(value instanceof StrictCatchUpScannerError);
  assert.equal(value.sourceStage, 'response');
  return true;
}

function assertNoWrites(repository: FakeRepository, allowFailure = false): void {
  assert.deepEqual(repository.enqueued, []);
  assert.deepEqual(repository.cas, []);
  assert.deepEqual(repository.resolutions, []);
  if (!allowFailure) assert.deepEqual(repository.failures, []);
}

function projectFailure(value: StrictCatchUpFailure | undefined): object {
  assert.ok(value !== undefined);
  assert.ok(Object.isFrozen(value));
  return {
    checkpointKey: value.checkpointKey,
    previous: value.previous,
    providerId: value.providerId,
    observedHeadSlot: value.observedHeadSlot,
    detectedAtMs: value.detectedAtMs,
  };
}

function abortedScan(value: unknown): boolean {
  assert.ok(value instanceof Error);
  assert.equal(value.constructor.name, 'StrictCatchUpAbortedError');
  assert.equal(value.name, 'StrictCatchUpAbortedError');
  assert.equal(value.message, 'Strict catch-up scan was aborted.');
  assert.ok(Object.isFrozen(value));
  return true;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  assert.fail('Expected asynchronous boundary was not reached.');
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
  return Object.freeze({
    promise,
    resolve(value: T) { resolve?.(value); },
    reject(reason: unknown) { reject?.(reason); },
  });
}

void CatchUpSourceError;
assert.deepEqual(programs, [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID]);
