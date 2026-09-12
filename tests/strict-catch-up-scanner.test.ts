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
import {
  createStrictCatchUpRun,
  terminalizeStrictCatchUpRun,
  type StrictCatchUpRun,
} from '../src/domain/strict-catch-up-run.js';
import { reconcileConfirmationStatus } from '../src/domain/confirmation-status.js';
import type {
  ProcessingCheckpoint,
  ProcessingCheckpointKey,
  TransactionNotification,
} from '../src/domain/transaction-ingestion.js';
import { TRANSACTION_INGESTION_ERROR_CODES } from '../src/domain/transaction-ingestion.js';
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
  type StrictCatchUpBoundaries,
  type StrictCatchUpSource,
} from '../src/application/strict-catch-up-scanner.js';
import { executionBoundaryViolations } from './helpers/execution-boundary.js';

const programs = [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID] as const;
const repositoryRootUrl = new URL(import.meta.url.endsWith('.js') ? '../../' : '../', import.meta.url);
const repositoryRoot = fileURLToPath(repositoryRootUrl);
const NEVER_ABORTED = new AbortController().signal;
const LAUNCHPAD_ONLY = Object.freeze([
  Object.freeze({ key: 'launchpad', family: 'pumpfun', id: PUMP_PROGRAM_ID } as const),
]);

void test('persists a full page before budget pause and resumes its frozen head to exact completion', async () => {
  const previous = checkpoint('launchpad', 'boundary', 10);
  const events: string[] = [];
  const repository = new FakeRepository({ launchpad: previous }, events);
  const options = { programs: LAUNCHPAD_ONLY, maxPages: 1 };
  await assert.rejects(scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('head', 14), sig('cursor', 13)]],
  }, 'primary', events), repository, options).scan(NEVER_ABORTED), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'StrictCatchUpPausedError');
    assert.equal(Reflect.get(error, 'code'), 'CATCH_UP_PAGE_BUDGET_EXHAUSTED');
    assert.equal(Reflect.get(error, 'stage'), 'page-budget');
    assert.equal(Reflect.get(error, 'retryable'), true);
    assert.equal(Reflect.get(error, 'pagesScanned'), 1n);
    assert.equal(Reflect.get(error, 'signaturesEnqueued'), 2n);
    assert.equal(Reflect.get(error, 'runId'), repository.runs[0]?.runId);
    assert.ok(Object.isFrozen(error));
    assert.doesNotMatch(String(error), /boundary|cursor|https/u);
    assert.ok(!(error instanceof StrictCatchUpWindowExceededError));
    assert.equal((TRANSACTION_INGESTION_ERROR_CODES as readonly string[]).includes(Reflect.get(error, 'code') as string), false);
    return true;
  });
  assert.deepEqual(events, ['read:launchpad', 'run-read:launchpad', 'run-history:launchpad',
    `source:${PUMP_PROGRAM_ID}:head`, 'enqueue:head', 'enqueue:cursor', 'run-create:launchpad']);
  assert.equal(repository.runs[0]?.state, 'ACTIVE');
  assert.deepEqual(repository.cas, []);
  assert.deepEqual(repository.failures, []);
  assert.deepEqual(await repository.readCheckpoint('launchpad'), previous);

  const resumed = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('same-slot', 13), sig('boundary', 10)]],
  });
  await assert.rejects(scanner(resumed, repository, { ...options, now: () => 10_000 }).scan(NEVER_ABORTED), refreshRequired);
  assert.deepEqual(resumed.calls, [[PUMP_PROGRAM_ID, 'cursor', 2]]);
  assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['head', 'cursor', 'same-slot']);
  assert.equal(repository.enqueued[2]?.observedAtMs, 10_000);
  assert.equal(repository.runs[0]?.state, 'COMPLETED');
  assert.equal(repository.runs[0]?.pagesScanned, 2n);
  assert.equal(repository.runs[0]?.signaturesEnqueued, 3n);
  assert.deepEqual(await repository.readCheckpoint('launchpad'), checkpoint('launchpad', 'head', 14, 10_000));
  // A new process must bridge the persisted old head to its newly opened WebSocket.
  const fresh = new FakeSource({ [PUMP_PROGRAM_ID]: [[sig('new-head', 16), sig('head', 14)]] });
  const result = await scanner(fresh, repository, { ...options, now: () => 11_000 }).scan(NEVER_ABORTED);
  assert.deepEqual(fresh.calls, [[PUMP_PROGRAM_ID, undefined, 2]]);
  assert.equal(result.pageCount, 1);
  assert.equal(result.enqueuedCount, 1);
  assert.equal((await repository.readCheckpoint('launchpad'))?.signature, 'new-head');
});

void test('processes active market before retained failed or stale launchpad, then requires a fresh scan', async () => {
  for (const launchState of ['FAILED', 'STALE', 'STALE_NULL'] as const) {
    const repository = new FakeRepository({
      ...(launchState === 'STALE_NULL' ? {} : {
        launchpad: checkpoint('launchpad', launchState === 'STALE' ? 'replacement' : 'boundary', 10),
      }),
      market: checkpoint('market', 'boundary', 10),
    });
    repository.runs.push(launchState === 'FAILED'
      ? terminalizeStrictCatchUpRun(activeRun(), {
        state: 'FAILED', terminalReason: 'CATCH_UP_WINDOW_EXCEEDED', completedAtMs: 2_000,
      }) : activeRun());
    repository.runs.push(activeRun('market'));
    const source = new FakeSource({ [PUMPSWAP_PROGRAM_ID]: [[sig('boundary', 10)]] });
    await assert.rejects(scanner(source, repository, { maxPages: 1 }).scan(NEVER_ABORTED), refreshRequired);
    assert.deepEqual(source.calls, [[PUMPSWAP_PROGRAM_ID, 'cursor', 2]]);
    assert.equal(repository.runs[1]?.state, 'COMPLETED');
    assert.equal(repository.runs[0]?.state, launchState === 'FAILED' ? 'FAILED' : 'SUPERSEDED');
    assert.equal(repository.eventsSeen.includes('run-history:launchpad'), false);
    assert.ok(repository.eventsSeen.indexOf('run-complete:market') > repository.eventsSeen.indexOf('run-read:market'));
    if (launchState !== 'FAILED') {
      assert.ok(repository.eventsSeen.indexOf('run-supersede:launchpad') > repository.eventsSeen.indexOf('run-complete:market'));
    } else {
      const nextSource = new FakeSource({});
      await assert.rejects(scanner(nextSource, repository).scan(NEVER_ABORTED), StrictCatchUpWindowExceededError);
      assert.deepEqual(nextSource.calls, []);
    }
  }
});

void test('completes all matching active keys before refresh, without scanning any fresh page', async () => {
  const repository = new FakeRepository({ launchpad: checkpoint('launchpad', 'boundary', 10),
    market: checkpoint('market', 'boundary', 10) });
  repository.runs.push(activeRun(), activeRun('market'));
  const source = new FakeSource({ [PUMP_PROGRAM_ID]: [[sig('boundary', 10)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('boundary', 10)]] });
  await assert.rejects(scanner(source, repository, { maxPages: 1 }).scan(NEVER_ABORTED), refreshRequired);
  assert.deepEqual(repository.runs.map(({ state }) => state), ['COMPLETED', 'COMPLETED']);
  assert.deepEqual(source.calls, programs.map((id) => [id, 'cursor', 2]));
});

void test('a paused active market never reads failed launchpad history or a fresh source page', async () => {
  const repository = new FakeRepository({ launchpad: checkpoint('launchpad', 'boundary', 10),
    market: checkpoint('market', 'boundary', 10) });
  repository.runs.push(terminalizeStrictCatchUpRun(activeRun(), {
    state: 'FAILED', terminalReason: 'CATCH_UP_WINDOW_EXCEEDED', completedAtMs: 2_000,
  }), activeRun('market'));
  const source = new FakeSource({ [PUMPSWAP_PROGRAM_ID]: [[sig('next', 12), sig('tail', 11)]] });
  await assert.rejects(scanner(source, repository, { maxPages: 1 }).scan(NEVER_ABORTED), { name: 'StrictCatchUpPausedError' });
  assert.equal(repository.runs[1]?.beforeSignature, 'tail');
  assert.equal(repository.eventsSeen.includes('run-history:launchpad'), false);
  assert.deepEqual(source.calls, [[PUMPSWAP_PROGRAM_ID, 'cursor', 2]]);
});

function refreshRequired(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'StrictCatchUpRefreshRequiredError');
  assert.equal(Reflect.get(error, 'code'), 'CATCH_UP_REFRESH_REQUIRED');
  assert.equal(Reflect.get(error, 'retryable'), true);
  assert.equal(Reflect.get(error, 'stage'), 'head-refresh');
  assert.ok(Object.isFrozen(error));
  assert.doesNotMatch(JSON.stringify(error), /signature|boundary|cursor|https/u);
  assert.equal((TRANSACTION_INGESTION_ERROR_CODES as readonly string[]).includes(Reflect.get(error, 'code') as string), false);
  return true;
}

void test('replays page enqueues idempotently when run progress persistence crashes', async () => {
  const repository = new FakeRepository({ launchpad: checkpoint('launchpad', 'boundary', 10) });
  repository.runs.push(activeRun());
  repository.failRunOperation = 'progress';
  const pages = { [PUMP_PROGRAM_ID]: [[sig('next', 12), sig('tail', 11)]] };
  await assert.rejects(scanner(new FakeSource(pages), repository, {
    programs: LAUNCHPAD_ONLY, maxPages: 1,
  }).scan(NEVER_ABORTED), (error: unknown) => {
    assert.ok(error instanceof StrictCatchUpScannerError);
    assert.equal(error.stage, 'run-progress');
    return true;
  });
  assert.equal(repository.runs[0]?.beforeSignature, 'cursor');
  repository.failRunOperation = null;
  await assert.rejects(scanner(new FakeSource(pages), repository, {
    programs: LAUNCHPAD_ONLY, maxPages: 1,
  }).scan(NEVER_ABORTED), { name: 'StrictCatchUpPausedError' });
  assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['next', 'tail', 'next', 'tail']);
  assert.equal(repository.inbox.size, 2);
  assert.equal(repository.runs[0]?.beforeSignature, 'tail');
  assert.equal(repository.runs[0]?.pagesScanned, 2n);
  assert.equal(repository.runs[0]?.signaturesEnqueued, 4n);
});

void test('rejects a different provider before source access or durable writes', async () => {
  const repository = new FakeRepository({ launchpad: checkpoint('launchpad', 'boundary', 10) });
  repository.runs.push(activeRun());
  const source = new FakeSource({}, 'fallback-1');
  await assert.rejects(scanner(source, repository, { programs: LAUNCHPAD_ONLY }).scan(NEVER_ABORTED), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'StrictCatchUpProviderAffinityError');
    assert.equal(Reflect.get(error, 'pinnedProviderId'), 'primary');
    assert.equal(Reflect.get(error, 'currentProviderId'), 'fallback-1');
    assert.equal(Reflect.get(error, 'checkpointKey'), 'launchpad');
    assert.equal(Reflect.get(error, 'retryable'), true);
    assert.ok(Object.isFrozen(error));
    assert.doesNotMatch(JSON.stringify(error), /cursor|boundary|https/u);
    return true;
  });
  assert.deepEqual(source.calls, []);
  assert.deepEqual(repository.eventsSeen, ['read:launchpad', 'run-read:launchpad']);
});

void test('supersedes a stale boundary before starting at the current head', async () => {
  const repository = new FakeRepository({ launchpad: checkpoint('launchpad', 'new-boundary', 12) });
  repository.runs.push(activeRun());
  const source = new FakeSource({ [PUMP_PROGRAM_ID]: [[sig('fresh', 15), sig('new-boundary', 12)]] }, 'fallback-1');
  await scanner(source, repository, { programs: LAUNCHPAD_ONLY }).scan(NEVER_ABORTED);
  assert.equal(repository.runs[0]?.state, 'SUPERSEDED');
  assert.deepEqual(source.calls, [[PUMP_PROGRAM_ID, undefined, 2]]);
  assert.deepEqual(repository.eventsSeen.slice(0, 3), ['read:launchpad', 'run-read:launchpad', 'run-supersede:launchpad']);
  assert.deepEqual(await repository.readCheckpoint('launchpad'), checkpoint('launchpad', 'fresh', 15, 9_000));
});

void test('rejects resumed newer slots, repeated cursors, duplicate signatures, and malformed rows', async () => {
  for (const page of [
    [sig('newer', 14)],
    [sig('cursor', 13)],
    [sig('duplicate', 12), sig('duplicate', 12)],
    [sig(' padded', 12)],
    [sig('boundary', 12)],
  ]) {
    const repository = new FakeRepository({ launchpad: checkpoint('launchpad', 'boundary', 10) });
    repository.runs.push(activeRun());
    await assert.rejects(scanner(new FakeSource({ [PUMP_PROGRAM_ID]: [page] }), repository, {
      programs: LAUNCHPAD_ONLY,
    }).scan(NEVER_ABORTED), (error: unknown) => sourceFailure(error, 'launchpad'));
    assertNoWrites(repository);
    assert.equal(repository.runs[0]?.revision, 0n);
  }
});

void test('records failure before terminalizing a short or empty resumed history', async () => {
  for (const page of [[], [sig('last', 11)]]) {
    const repository = new FakeRepository({ launchpad: checkpoint('launchpad', 'boundary', 10) });
    repository.runs.push(activeRun());
    await assert.rejects(scanner(new FakeSource({ [PUMP_PROGRAM_ID]: [page] }), repository, {
      programs: LAUNCHPAD_ONLY,
    }).scan(NEVER_ABORTED), StrictCatchUpWindowExceededError);
    assert.equal(repository.runs[0]?.state, 'FAILED');
    assert.equal(repository.failures.length, 1);
    assert.equal(repository.failures[0]?.observedHeadSlot, 14n);
    assert.deepEqual(repository.eventsSeen.slice(-2), ['failure:launchpad', 'run-fail:launchpad']);
    assert.equal(repository.runs[0]?.beforeSignature, page.length === 0 ? 'cursor' : 'last');
    assert.deepEqual(repository.cas, []);
  }
});

void test('rethrows a persisted exact failed run without rereading history or rewriting evidence', async () => {
  const repository = new FakeRepository({ launchpad: checkpoint('launchpad', 'boundary', 10) });
  const pages = { [PUMP_PROGRAM_ID]: [[sig('last', 11)]] };
  await assert.rejects(scanner(new FakeSource(pages), repository, {
    programs: LAUNCHPAD_ONLY,
  }).scan(NEVER_ABORTED), StrictCatchUpWindowExceededError);
  assert.equal(repository.runs[0]?.state, 'FAILED');
  const previousEvents = repository.eventsSeen.length;
  const source = new FakeSource(pages);
  await assert.rejects(scanner(source, repository, {
    programs: LAUNCHPAD_ONLY,
  }).scan(NEVER_ABORTED), StrictCatchUpWindowExceededError);
  assert.deepEqual(source.calls, []);
  assert.deepEqual(repository.eventsSeen.slice(previousEvents), [
    'read:launchpad', 'run-read:launchpad', 'run-history:launchpad',
  ]);
  assert.equal(repository.failures.length, 1);
  assert.equal(repository.enqueued.length, 1);
  assert.equal(repository.runs.length, 1);
});

void test('empty history without a run keeps recording terminal evidence on each pass', async () => {
  const repository = new FakeRepository({ launchpad: checkpoint('launchpad', 'boundary', 10) });
  for (let pass = 0; pass < 2; pass += 1) {
    const source = new FakeSource({ [PUMP_PROGRAM_ID]: [[]] });
    await assert.rejects(scanner(source, repository, { programs: LAUNCHPAD_ONLY }).scan(NEVER_ABORTED), StrictCatchUpWindowExceededError);
    assert.equal(source.calls.length, 1);
  }
  assert.deepEqual(repository.runs, []);
  assert.equal(repository.failures.length, 2);
});

void test('rejects inconsistent historical terminal states for a still-current exact checkpoint', async () => {
  for (const state of ['COMPLETED', 'SUPERSEDED'] as const) {
    const repository = new FakeRepository({ launchpad: checkpoint('launchpad', 'boundary', 10) });
    repository.runs.push(terminalizeStrictCatchUpRun(activeRun(), {
      state, terminalReason: state === 'COMPLETED' ? null : 'CHECKPOINT_SUPERSEDED', completedAtMs: 2_000,
    }));
    const source = new FakeSource({ [PUMP_PROGRAM_ID]: [[sig('next', 12)]] });
    await assert.rejects(scanner(source, repository, { programs: LAUNCHPAD_ONLY }).scan(NEVER_ABORTED),
      (error: unknown) => scannerFailure(error, 'run-read', 'launchpad'));
    assert.deepEqual(source.calls, []);
    assertNoWrites(repository);
  }
});

void test('crossing below the checkpoint slot persists only eligible rows and proves missing history', async () => {
  for (const existing of [false, true]) {
    const repository = new FakeRepository({ launchpad: checkpoint('launchpad', 'boundary', 10) });
    if (existing) repository.runs.push(activeRun());
    await assert.rejects(scanner(new FakeSource({
      [PUMP_PROGRAM_ID]: [[sig('same-slot-distinct', 10), sig('too-old', 9)]],
    }), repository, { programs: LAUNCHPAD_ONLY, maxPages: 1 }).scan(NEVER_ABORTED), StrictCatchUpWindowExceededError);
    assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['same-slot-distinct']);
    assert.equal(repository.runs[0]?.beforeSignature, 'same-slot-distinct');
    assert.equal(repository.runs[0]?.state, 'FAILED');
  }
});

function activeRun(key: ProcessingCheckpointKey = 'launchpad'): StrictCatchUpRun {
  return createStrictCatchUpRun({
    checkpointKey: key, previous: checkpoint(key, 'boundary', 10), providerId: 'primary',
    observedHead: { signature: 'head', slot: 14n }, beforeSignature: 'cursor', lastAcceptedSlot: 13n,
    pagesScanned: 1n, signaturesEnqueued: 2n, revision: 0n, startedAtMs: 1_000, updatedAtMs: 1_000,
  });
}

void test('cancellation at durable run boundaries starts no subsequent operation', async () => {
  for (const operation of ['read', 'history', 'create', 'progress', 'complete', 'fail', 'supersede']) {
    const controller = new AbortController();
    const pending = deferred<undefined>();
    const repository = new FakeRepository({
      launchpad: checkpoint('launchpad', operation === 'supersede' ? 'replacement' : 'boundary', 10),
    });
    if (operation !== 'create' && operation !== 'history') repository.runs.push(activeRun());
    repository.nextRunOperation = { operation, promise: pending.promise };
    const page = operation === 'complete' ? [sig('boundary', 10)]
      : operation === 'fail' ? [] : [sig('next', 12), sig('tail', 11)];
    const source = new FakeSource({ [PUMP_PROGRAM_ID]: [page] });
    const scan = scanner(source, repository, { programs: LAUNCHPAD_ONLY }).scan(controller.signal);
    await waitFor(() => repository.eventsSeen.includes(`run-${operation}:launchpad`));
    const beforeAbort = [...repository.eventsSeen];
    const readsBeforeAbort = source.calls.length;
    controller.abort();
    pending.resolve(undefined);
    await assert.rejects(scan, abortedScan);
    assert.deepEqual(repository.eventsSeen, beforeAbort);
    assert.equal(source.calls.length, readsBeforeAbort);
  }
});

void test('aborting during a resumed page enqueue retains the prior durable cursor', async () => {
  const controller = new AbortController();
  const pending = deferred<undefined>();
  const repository = new FakeRepository({ launchpad: checkpoint('launchpad', 'boundary', 10) });
  repository.runs.push(activeRun());
  repository.nextEnqueue = pending.promise;
  const scan = scanner(new FakeSource({ [PUMP_PROGRAM_ID]: [[sig('next', 12), sig('tail', 11)]] }), repository, {
    programs: LAUNCHPAD_ONLY,
  }).scan(controller.signal);
  await waitFor(() => repository.eventsSeen.includes('enqueue:next'));
  controller.abort();
  pending.resolve(undefined);
  await assert.rejects(scan, abortedScan);
  assert.equal(repository.runs[0]?.beforeSignature, 'cursor');
  assert.equal(repository.enqueued.length, 1);
  assert.equal(repository.inbox.size, 1);
});

void test('retries final completion from its persisted final-page tail without replaying enqueues', async () => {
  const repository = new FakeRepository({ launchpad: checkpoint('launchpad', 'boundary', 10) });
  repository.runs.push(activeRun());
  repository.failRunOperation = 'complete';
  await assert.rejects(scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('last', 11), sig('boundary', 10)]],
  }), repository, { programs: LAUNCHPAD_ONLY }).scan(NEVER_ABORTED), (error: unknown) =>
    scannerFailure(error, 'run-complete', 'launchpad'));
  assert.equal(repository.runs[0]?.beforeSignature, 'last');
  assert.equal(repository.runs[0]?.pagesScanned, 2n);
  assert.equal(repository.runs[0]?.signaturesEnqueued, 3n);
  assert.equal(repository.runs[0]?.state, 'ACTIVE');
  assert.deepEqual(await repository.readCheckpoint('launchpad'), checkpoint('launchpad', 'boundary', 10));
  repository.failRunOperation = null;
  const source = new FakeSource({ [PUMP_PROGRAM_ID]: [[sig('boundary', 10)]] });
  await assert.rejects(scanner(source, repository, { programs: LAUNCHPAD_ONLY }).scan(NEVER_ABORTED), refreshRequired);
  assert.deepEqual(source.calls, [[PUMP_PROGRAM_ID, 'last', 2]]);
  assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['last']);
  assert.equal(repository.runs[0]?.state, 'COMPLETED');
});

void test('redacts failures at every run operation and preserves failure evidence before fail rejection', async () => {
  for (const operation of ['read', 'create', 'progress', 'complete', 'fail', 'supersede'] as const) {
    const repository = new FakeRepository({
      launchpad: checkpoint('launchpad', operation === 'supersede' ? 'replacement' : 'boundary', 10),
    });
    if (operation !== 'create') repository.runs.push(activeRun());
    repository.failRunOperation = operation;
    const page = operation === 'complete' ? [sig('boundary', 10)]
      : operation === 'fail' ? [] : [sig('next', 12), sig('tail', 11)];
    await assert.rejects(scanner(new FakeSource({ [PUMP_PROGRAM_ID]: [page] }), repository, {
      programs: LAUNCHPAD_ONLY,
    }).scan(NEVER_ABORTED), (error: unknown) => scannerFailure(error, `run-${operation}`, 'launchpad'));
    if (operation === 'create') assert.deepEqual(repository.runs, []);
    else assert.equal(repository.runs[0]?.state, 'ACTIVE');
    if (operation === 'fail') assert.equal(repository.failures.length, 1);
  }
});

void test('aborting failure persistence retains the active run and already persisted short page', async () => {
  const controller = new AbortController();
  const pending = deferred<undefined>();
  const repository = new FakeRepository({ launchpad: checkpoint('launchpad', 'boundary', 10) });
  repository.runs.push(activeRun());
  repository.nextFailureWrite = pending.promise;
  const scan = scanner(new FakeSource({ [PUMP_PROGRAM_ID]: [[sig('last', 11)]] }), repository, {
    programs: LAUNCHPAD_ONLY,
  }).scan(controller.signal);
  await waitFor(() => repository.eventsSeen.includes('failure:launchpad'));
  controller.abort();
  pending.resolve(undefined);
  await assert.rejects(scan, abortedScan);
  assert.equal(repository.runs[0]?.beforeSignature, 'last');
  assert.equal(repository.runs[0]?.state, 'ACTIVE');
  assert.equal(repository.failures.length, 1);
  assert.ok(!repository.eventsSeen.includes('run-fail:launchpad'));
});

void test('does not read a resumed source when the current pass clock precedes durable progress', async () => {
  const repository = new FakeRepository({ launchpad: checkpoint('launchpad', 'boundary', 10) });
  repository.runs.push(activeRun());
  const source = new FakeSource({});
  await assert.rejects(scanner(source, repository, {
    programs: LAUNCHPAD_ONLY, now: () => 999,
  }).scan(NEVER_ABORTED), (error: unknown) => scannerFailure(error, 'run-read', 'launchpad'));
  assert.deepEqual(source.calls, []);
  assertNoWrites(repository);
});

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

void test('scans only the configured launchpad program without touching market state', async () => {
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch', 12)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 13)]],
  });
  const repository = new FakeRepository({
    market: checkpoint('market', 'existing-market', 10),
  });

  const result = await scanner(source, repository, {
    programs: Object.freeze([Object.freeze({
      key: 'launchpad',
      family: 'pumpfun',
      id: PUMP_PROGRAM_ID,
    })]),
  }).scan(NEVER_ABORTED);

  assert.deepEqual(repository.eventsSeen, [
    'read:launchpad',
    'run-read:launchpad',
    'enqueue:launch',
    'cas:launchpad',
  ]);
  assert.deepEqual(source.calls, [[PUMP_PROGRAM_ID, undefined, 2]]);
  assert.deepEqual(result.boundaries, { launchpad: null, market: null });
  assert.equal(result.discoveredCount, 1);
  assert.equal(result.enqueuedCount, 1);
});

void test('rejects accessor-backed ingestion programs without invoking them', () => {
  let getterCalls = 0;
  const programs = Object.defineProperty([], '0', {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return { key: 'launchpad', family: 'pumpfun', id: PUMP_PROGRAM_ID };
    },
  });
  Object.defineProperty(programs, 'length', { value: 1 });

  assert.throws(() => scanner(new FakeSource({}), new FakeRepository(), {
    programs,
  }), /programs are invalid/u);
  assert.equal(getterCalls, 0);

  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  assert.throws(() => scanner(new FakeSource({}), new FakeRepository(), {
    programs: revoked.proxy,
  }), (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, 'Strict catch-up scanner programs are invalid.');
    return true;
  });
});

void test('aborts after the launchpad checkpoint settles without reading the market checkpoint', async () => {
  const checkpointRead = deferred<undefined>();
  const controller = new AbortController();
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch', 1)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 2)]],
  });
  const repository = new FakeRepository();
  repository.nextReads.set('launchpad', checkpointRead.promise);

  const scan = scanner(source, repository).scan(controller.signal);
  await waitFor(() => repository.eventsSeen.includes('read:launchpad'));
  controller.abort();
  checkpointRead.resolve(undefined);

  await assert.rejects(scan, abortedScan);
  assert.deepEqual(repository.eventsSeen, ['read:launchpad']);
  assert.deepEqual(source.calls, []);
  assertNoWrites(repository);
});

void test('aborts after the market checkpoint settles without reading a provider page', async () => {
  const checkpointRead = deferred<undefined>();
  const controller = new AbortController();
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch', 1)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 2)]],
  });
  const repository = new FakeRepository();
  repository.nextReads.set('market', checkpointRead.promise);

  const scan = scanner(source, repository).scan(controller.signal);
  await waitFor(() => repository.eventsSeen.includes('read:market'));
  controller.abort();
  checkpointRead.resolve(undefined);

  await assert.rejects(scan, abortedScan);
  assert.deepEqual(repository.eventsSeen, ['read:launchpad', 'read:market']);
  assert.deepEqual(source.calls, []);
  assertNoWrites(repository);
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

void test('makes abort dominate a provider page rejection after the signal is aborted', async () => {
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
  page.reject(new Error('source-secret'));

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

void test('aborts after a strict failure write settles without starting another durable write', async () => {
  const failureWrite = deferred<undefined>();
  const controller = new AbortController();
  const repository = new FakeRepository({
    launchpad: checkpoint('launchpad', 'missing', 1),
  });
  repository.nextFailureWrite = failureWrite.promise;
  const scan = scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 2)]],
  }), repository).scan(controller.signal);
  await waitFor(() => repository.eventsSeen.includes('failure:launchpad'));

  controller.abort();
  failureWrite.resolve(undefined);

  await assert.rejects(scan, abortedScan);
  assert.equal(repository.failures.length, 1);
  assert.deepEqual(repository.enqueued, []);
  assert.deepEqual(repository.cas, []);
  assert.deepEqual(repository.resolutions, []);
});

void test('aborts after failure resolution settles without starting the next durable write', async () => {
  const failureResolve = deferred<undefined>();
  const controller = new AbortController();
  const repository = new FakeRepository();
  repository.nextFailureResolve = failureResolve.promise;
  const scan = scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[]],
    [PUMPSWAP_PROGRAM_ID]: [[]],
  }), repository).scan(controller.signal);
  await waitFor(() => repository.eventsSeen.includes('resolve:launchpad'));

  controller.abort();
  failureResolve.resolve(undefined);

  await assert.rejects(scan, abortedScan);
  assert.deepEqual(repository.resolutions, [['launchpad', null]]);
  assert.deepEqual(repository.enqueued, []);
  assert.deepEqual(repository.cas, []);
  assert.deepEqual(repository.failures, []);
});

void test('compares private exact window frontiers without enumerating or serializing signatures', () => {
  const frontier = Object.freeze({
    launchpad: checkpoint('launchpad', 'launch-secret', 10, 1),
    market: checkpoint('market', 'market-secret', 11, 1),
  });
  const first = new StrictCatchUpWindowExceededError('primary', 'market', frontier);
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
  assert.equal('toJSON' in first, false);
});

void test('compares only the failing program frontier while ignoring unrelated checkpoint progress', () => {
  const frontier = Object.freeze({
    launchpad: checkpoint('launchpad', 'launch-secret', 10, 1),
    market: checkpoint('market', 'market-secret', 11, 1),
  });
  const failure = new StrictCatchUpWindowExceededError('primary', 'market', frontier);
  const unrelatedProgress = new StrictCatchUpWindowExceededError('fallback-1', 'market', Object.freeze({
    launchpad: checkpoint('launchpad', 'new-launch-secret', 15, 2),
    market: checkpoint('market', 'market-secret', 11, 2),
  }));
  assert.equal(failure.sameFrontier(unrelatedProgress), true);
  assert.equal(unrelatedProgress.sameFrontier(failure), true);
  assert.equal(failure.sameFrontier(new StrictCatchUpWindowExceededError('primary', 'launchpad', frontier)), false);
  for (const changedMarket of [
    checkpoint('market', 'other-secret', 11, 1),
    checkpoint('market', 'market-secret', 12, 1),
  ]) {
    assert.equal(failure.sameFrontier(new StrictCatchUpWindowExceededError('primary', 'market', Object.freeze({
      ...frontier, market: changedMarket,
    }))), false);
  }
  assert.deepEqual(Object.keys(unrelatedProgress), ['code', 'stage', 'retryable', 'providerId', 'checkpointKey']);
  assert.doesNotMatch(JSON.stringify(unrelatedProgress), /secret/u);
  assert.equal('toJSON' in unrelatedProgress, false);
});

void test('compares null frontiers exactly and still requires the same failing program key', () => {
  const empty = Object.freeze({ launchpad: null, market: null });
  for (const key of ['launchpad', 'market'] as const) {
    const otherKey = key === 'launchpad' ? 'market' : 'launchpad';
    const failure = new StrictCatchUpWindowExceededError('primary', key, empty);
    assert.equal(failure.sameFrontier(new StrictCatchUpWindowExceededError('fallback-1', key, Object.freeze({
      ...empty, [otherKey]: checkpoint(otherKey, 'unrelated-secret', 1),
    }))), true);
    assert.equal(failure.sameFrontier(new StrictCatchUpWindowExceededError('primary', otherKey, empty)), false);
    const nonnull = new StrictCatchUpWindowExceededError('primary', key, Object.freeze({
      ...empty, [key]: checkpoint(key, 'boundary-secret', 1),
    }));
    assert.equal(failure.sameFrontier(nonnull), false);
    assert.equal(nonnull.sameFrontier(failure), false);
  }
});

void test('rejects a proxy window frontier without invoking any hostile trap', () => {
  let trapCalls = 0;
  const frontier = new Proxy({ launchpad: null, market: null }, {
    get() { trapCalls += 1; throw new Error('proxy-frontier-secret'); },
    getPrototypeOf() { trapCalls += 1; throw new Error('proxy-frontier-secret'); },
    ownKeys() { trapCalls += 1; throw new Error('proxy-frontier-secret'); },
    getOwnPropertyDescriptor() { trapCalls += 1; throw new Error('proxy-frontier-secret'); },
  });

  assert.throws(
    () => new StrictCatchUpWindowExceededError('primary', 'launchpad', frontier),
    invalidFrontier,
  );
  assert.equal(trapCalls, 0);
});

void test('rejects accessor-backed window frontiers without invoking or retaining their getters', () => {
  let getterCalls = 0;
  const frontier = {};
  Object.defineProperties(frontier, {
    launchpad: {
      enumerable: true,
      get() {
        getterCalls += 1;
        Object.defineProperty(frontier, 'market', { value: 'mutated-secret' });
        throw new Error('accessor-frontier-secret');
      },
    },
    market: {
      configurable: true,
      enumerable: true,
      get() { getterCalls += 1; throw new Error('accessor-frontier-secret'); },
    },
  });

  assert.throws(
    () => new StrictCatchUpWindowExceededError(
      'primary',
      'launchpad',
      frontier as StrictCatchUpBoundaries,
    ),
    invalidFrontier,
  );
  assert.equal(getterCalls, 0);
});

void test('rejects non-canonical window frontier containers with a fixed redacted error', () => {
  const nonEnumerable = Object.defineProperties({}, {
    launchpad: { enumerable: true, value: null },
    market: { enumerable: false, value: null },
  });
  for (const frontier of [
    null,
    [],
    Object.freeze({ launchpad: null }),
    Object.freeze({ launchpad: null, market: null, extra: 'container-frontier-secret' }),
    nonEnumerable,
  ]) {
    assert.throws(
      () => new StrictCatchUpWindowExceededError(
        'primary',
        'launchpad',
        frontier as StrictCatchUpBoundaries,
      ),
      invalidFrontier,
    );
  }
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
  assert.deepEqual(events.slice(0, 7), [
    'now', 'read:launchpad', 'read:market', 'run-read:launchpad', 'run-read:market', 'run-history:launchpad', `source:${PUMP_PROGRAM_ID}:head`,
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
  assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['l5', 'l4', 'l3']);
  assert.equal(result.pageCount, 3);
  assert.equal(result.discoveredCount, 3);
});

void test('durably finishes each program before reading the next program', async () => {
  const events: string[] = [];
  const source = new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch', 2)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 3)]],
  }, 'primary', events);
  const repository = new FakeRepository({}, events);

  await scanner(source, repository).scan(NEVER_ABORTED);

  const lastSource = Math.max(...events.map((value, index) => value.startsWith('source:') ? index : -1));
  const firstWrite = events.findIndex((value) => value.startsWith('enqueue:'));
  assert.ok(firstWrite < lastSource);
  assert.ok(events.indexOf('cas:launchpad') < lastSource);
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
  assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['launch-new', 'launch-old']);
  assert.deepEqual(repository.runs, []);
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
    if (pages.length === 1) assertNoWrites(repository);
    else {
      assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['b', 'a']);
      assert.equal(repository.runs[0]?.beforeSignature, 'a');
      assert.deepEqual(repository.cas, []);
      assert.deepEqual(repository.failures, []);
    }
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

void test('enqueues current program and finality per page while inbox merges identical signatures', async () => {
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

  assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['z', 'shared', 'a', 'm', 'shared', 'b']);
  assert.equal(repository.inbox.size, 5);
  assert.deepEqual(repository.enqueued[1]?.programIds, [PUMP_PROGRAM_ID]);
  assert.equal(repository.enqueued[1]?.confirmationStatus, 'confirmed');
  assert.deepEqual(repository.enqueued[4]?.programIds, [PUMPSWAP_PROGRAM_ID]);
  assert.equal(repository.enqueued[4]?.confirmationStatus, 'finalized');
  const shared = repository.inbox.get('shared');
  assert.deepEqual(shared, {
    signature: 'shared', slot: 3n, source: 'CATCH_UP',
    ingestionHint: null,
    ingestionHintMint: null,
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

void test('enqueues each program discovery before its exact sequential CAS operation', async () => {
  const events: string[] = [];
  const repository = new FakeRepository({}, events);
  const result = await scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch', 1)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 2)]],
  }, 'fallback-1', events), repository).scan(NEVER_ABORTED);

  assert.deepEqual(events.filter((value) => value.startsWith('enqueue:') || value.startsWith('cas:')), [
    'enqueue:launch', 'cas:launchpad', 'enqueue:market', 'cas:market',
  ]);
  assert.equal(result.checkpointCasCount, 2);
});

void test('maps enqueue failure to a fixed transient error without advancing the failing program', async () => {
  const repository = new FakeRepository();
  repository.failEnqueueAt = 2;
  await assert.rejects(scanner(new FakeSource({
    [PUMP_PROGRAM_ID]: [[sig('launch', 1)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 2)]],
  }), repository).scan(NEVER_ABORTED), (error) => scannerFailure(error, 'enqueue', 'market'));
  assert.deepEqual(repository.cas.map(([, next]) => next.key), ['launchpad']);
  assert.deepEqual(repository.resolutions, []);
});

void test('persists eligible first-program progress before exact durable window evidence', async () => {
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
  assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['head']);
  assert.equal(repository.runs[0]?.state, 'FAILED');
  assert.deepEqual(repository.cas, []);
});

void test('records second-program window evidence without reverting the completed first program', async () => {
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
  assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['launch', 'market-head']);
  assert.equal(repository.runs[0]?.state, 'FAILED');
  assert.deepEqual(repository.cas.map(([, next]) => next.key), ['launchpad']);
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

void test('retries an enqueue crash without replaying an already completed program', async () => {
  const sourcePages = {
    [PUMP_PROGRAM_ID]: [[sig('launch', 1)]],
    [PUMPSWAP_PROGRAM_ID]: [[sig('market', 2)]],
  };
  const repository = new FakeRepository();
  repository.failEnqueueAt = 2;
  await assert.rejects(scanner(new FakeSource(sourcePages), repository).scan(NEVER_ABORTED), StrictCatchUpScannerError);
  repository.failEnqueueAt = null;
  await scanner(new FakeSource(sourcePages), repository).scan(NEVER_ABORTED);
  assert.deepEqual(repository.enqueued.map(({ signature }) => signature), ['launch', 'market']);
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
  const path = fileURLToPath(new URL('src/application/strict-catch-up-scanner.ts', repositoryRootUrl));
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
    readonly programs?: readonly Readonly<{
      readonly key: ProcessingCheckpointKey;
      readonly family: 'pumpfun' | 'pumpswap';
      readonly id: string;
    }>[];
  } = {},
): StrictCatchUpScanner {
  return new StrictCatchUpScanner(source, repository, {
    pageSize: overrides.pageSize ?? 2,
    maxPages: overrides.maxPages ?? 3,
    now: overrides.now ?? (() => 9_000),
    ...(overrides.programs === undefined ? {} : { programs: overrides.programs }),
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
  readonly runs: StrictCatchUpRun[] = [];
  readonly inbox = new Map<string, TransactionNotification>();
  failRunOperation: string | null = null;
  nextRunOperation: { readonly operation: string; readonly promise: Promise<void> } | null = null;
  readonly enqueued: TransactionNotification[] = [];
  readonly cas: [ProcessingCheckpoint | null, ProcessingCheckpoint][] = [];
  readonly failures: StrictCatchUpFailure[] = [];
  readonly resolutions: [ProcessingCheckpointKey, ProcessingCheckpoint | null][] = [];
  failEnqueueAt: number | null = null;
  failCasAt: number | null = null;
  failResolveAt: number | null = null;
  failFailureWrite = false;
  readonly nextReads = new Map<ProcessingCheckpointKey, Promise<void>>();
  nextEnqueue: Promise<void> | null = null;
  nextCas: Promise<void> | null = null;
  nextFailureWrite: Promise<void> | null = null;
  nextFailureResolve: Promise<void> | null = null;
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
    const previous = this.inbox.get(value.signature);
    this.inbox.set(value.signature, previous === undefined ? value : Object.freeze({
      ...previous,
      programIds: Object.freeze([...new Set([...previous.programIds, ...value.programIds])].sort()),
      confirmationStatus: reconcileConfirmationStatus(previous.confirmationStatus, value.confirmationStatus) === 'update'
        ? value.confirmationStatus : previous.confirmationStatus,
    }));
  }

  async readCheckpoint(key: ProcessingCheckpointKey): Promise<ProcessingCheckpoint | null> {
    this.events.push(`read:${key}`);
    const pending = this.nextReads.get(key);
    this.nextReads.delete(key);
    if (pending !== undefined) await pending;
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
    if (this.nextFailureWrite !== null) {
      const pending = this.nextFailureWrite;
      this.nextFailureWrite = null;
      await pending;
    }
    if (this.failFailureWrite) throw new Error('failure-write-secret');
    this.failures.push(value);
  }

  async resolveStrictCatchUpFailures(
    key: ProcessingCheckpointKey,
    previous: ProcessingCheckpoint | null,
  ): Promise<void> {
    this.resolveAttempts += 1;
    this.events.push(`resolve:${key}`);
    if (this.nextFailureResolve !== null) {
      const pending = this.nextFailureResolve;
      this.nextFailureResolve = null;
      await pending;
    }
    if (this.failResolveAt === this.resolveAttempts) throw new Error('resolve-secret');
    this.resolutions.push([key, previous]);
  }

  async readActiveStrictCatchUpRun(key: ProcessingCheckpointKey): Promise<StrictCatchUpRun | null> {
    await this.runOperation('read', key);
    return this.runs.find((run) => run.checkpointKey === key && run.state === 'ACTIVE') ?? null;
  }
  async readStrictCatchUpRun(key: ProcessingCheckpointKey, previous: ProcessingCheckpoint, providerId: RpcProviderId): Promise<StrictCatchUpRun | null> {
    await this.runOperation('history', key);
    return this.runs.find((run) => run.checkpointKey === key && run.previous.slot === previous.slot
      && run.previous.signature === previous.signature && run.providerId === providerId) ?? null;
  }
  async createStrictCatchUpRun(value: StrictCatchUpRun): Promise<StrictCatchUpRun> {
    await this.runOperation('create', value.checkpointKey);
    const existing = this.runs.find((run) => run.runId === value.runId);
    if (existing !== undefined) {
      assert.deepEqual(existing, value);
      return existing;
    }
    assert.equal(this.runs.some((run) => run.checkpointKey === value.checkpointKey && run.state === 'ACTIVE'), false);
    this.runs.push(value);
    return value;
  }
  async advanceStrictCatchUpRun(expected: StrictCatchUpRun, next: StrictCatchUpRun): Promise<void> {
    await this.runOperation('progress', expected.checkpointKey);
    this.replaceRun(expected, next);
  }
  async completeStrictCatchUpRun(value: { readonly run: StrictCatchUpRun; readonly nextCheckpoint: ProcessingCheckpoint }): Promise<void> {
    await this.runOperation('complete', value.run.checkpointKey);
    const completed = terminalizeStrictCatchUpRun(value.run, {
      state: 'COMPLETED', terminalReason: null, completedAtMs: value.nextCheckpoint.updatedAtMs,
    });
    this.replaceRun(value.run, completed);
    this.checkpoints[value.run.checkpointKey] = value.nextCheckpoint;
    this.resolutions.push([value.run.checkpointKey, value.run.previous]);
  }
  async failStrictCatchUpRun(expected: StrictCatchUpRun, failed: StrictCatchUpRun): Promise<void> {
    await this.runOperation('fail', expected.checkpointKey);
    this.replaceRun(expected, failed);
  }
  async supersedeStaleStrictCatchUpRun(expected: StrictCatchUpRun, atMs: number): Promise<void> {
    await this.runOperation('supersede', expected.checkpointKey);
    this.replaceRun(expected, terminalizeStrictCatchUpRun(expected, {
      state: 'SUPERSEDED', terminalReason: 'CHECKPOINT_SUPERSEDED', completedAtMs: atMs,
    }));
  }
  private replaceRun(expected: StrictCatchUpRun, next: StrictCatchUpRun): void {
    const index = this.runs.findIndex((run) => run.runId === expected.runId && run.state === 'ACTIVE');
    assert.deepEqual(this.runs[index], expected);
    this.runs[index] = next;
  }
  private async runOperation(operation: string, key: ProcessingCheckpointKey): Promise<void> {
    this.events.push(`run-${operation}:${key}`);
    if (this.nextRunOperation?.operation === operation) {
      const pending = this.nextRunOperation.promise;
      this.nextRunOperation = null;
      await pending;
    }
    if (this.failRunOperation === operation) throw new Error('run-operation-secret');
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

function invalidFrontier(value: unknown): boolean {
  assert.ok(value instanceof TypeError);
  assert.equal(value.message, 'Strict catch-up frontier is invalid.');
  assert.equal(Object.hasOwn(value, 'cause'), false);
  assert.doesNotMatch(String(value), /secret/u);
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
