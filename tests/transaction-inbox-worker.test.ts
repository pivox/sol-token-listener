import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TransactionInboxWorker,
  TransactionInboxWorkerError,
  type TransactionInboxWorkerRepository,
  type TransactionInboxWorkerScheduler,
} from '../src/application/transaction-inbox-worker.js';
import {
  createDurableTransactionSnapshot,
  type ClaimedTransaction,
  type IngestionFailure,
} from '../src/domain/transaction-ingestion.js';
import {
  RpcTransientError,
  TransactionIndexNotFoundError,
  type TransactionLocationTarget,
} from '../src/solana/rpc/transaction-locator.js';
import type { NormalizedTransaction } from '../src/solana/rpc/types.js';

void test('claims one row and processes it in durable order with claim finality', async () => {
  const calls: string[] = [];
  const tx = normalized('sig', 7n, 'CONFIRMED');
  const repository = repositoryWith({
    async claim(now, seconds) {
      calls.push(`claim:${now}:${seconds}`);
      return claim('sig', 7n, 'confirmed');
    },
    async saveSnapshot(signature, token, value) {
      assert.equal(value, tx);
      calls.push(`save:${signature}:${token}`);
    },
    async renewLease(signature, token, until) {
      calls.push(`renew:${signature}:${token}:${until}`);
    },
    async markProcessed(signature, token, status) {
      calls.push(`processed:${signature}:${token}:${status}`);
    },
  });
  const worker = new TransactionInboxWorker(repository, {
    async locate(target) {
      assert.deepEqual(target, { signature: 'sig', slot: 7n, confirmationStatus: 'CONFIRMED' });
      calls.push('locate');
      return tx;
    },
  }, { async process(value) {
    assert.notEqual(value, tx);
    assert.equal(value.confirmationStatus, 'CONFIRMED');
    assert.ok(Object.isFrozen(value));
    calls.push('pipeline');
  } }, options());

  const result = await worker.runOnce();

  assert.deepEqual(calls, [
    'claim:1000:10', 'locate', 'save:sig:lease', 'renew:sig:lease:11000',
    'pipeline', 'processed:sig:lease:confirmed',
  ]);
  assert.deepEqual(result, { kind: 'processed', signature: 'sig' });
  assert.ok(Object.isFrozen(result));
  assert.equal(worker.state, 'STOPPED');
});

void test('promotes saved snapshots to one immutable finalized or orphaned pipeline view', async () => {
  for (const status of ['finalized', 'orphaned'] as const) {
    const calls: string[] = [];
    const tx = normalized(`saved-${status}`, 8n, 'CONFIRMED');
    const repository = repositoryWith({
      async claim() { return claim(tx.signature, 8n, status, createDurableTransactionSnapshot(tx)); },
      async renewLease() { calls.push('renew'); },
      async markProcessed(_signature, _token, markedStatus) { calls.push(`processed:${markedStatus}`); },
    });
    const worker = new TransactionInboxWorker(repository, {
      async locate() { calls.push('locate'); return tx; },
    }, { async process(restored) {
      calls.push('pipeline');
      assert.equal(restored.transactionIndex, 3);
      assert.equal(restored.confirmationStatus, status.toUpperCase());
      assert.ok(Object.isFrozen(restored));
      assert.ok(Object.isFrozen(restored.accountKeys));
      assert.ok(Object.isFrozen(restored.instructions));
      assert.ok(Object.isFrozen(restored.preTokenBalances));
    } }, options());

    assert.deepEqual(await worker.runOnce(), { kind: 'processed', signature: tx.signature });
    assert.deepEqual(calls, ['renew', 'pipeline', `processed:${status}`]);
  }
});

void test('promotes a lagging fresh locator response to claim finality before pipeline', async () => {
  const tx = normalized('fresh-promoted', 9n, 'PROCESSED');
  let pipelineStatus: string | null = null;
  let markedStatus: string | null = null;
  const worker = new TransactionInboxWorker(repositoryWith({
    async claim() { return claim('fresh-promoted', 9n, 'confirmed'); },
    async markProcessed(_signature, _token, status) { markedStatus = status; },
  }), { async locate() { return tx; } }, {
    async process(view) { pipelineStatus = view.confirmationStatus; assert.ok(Object.isFrozen(view)); },
  }, options());
  assert.deepEqual(await worker.runOnce(), { kind: 'processed', signature: 'fresh-promoted' });
  assert.equal(pipelineStatus, 'CONFIRMED');
  assert.equal(markedStatus, 'confirmed');
});

void test('preserves trusted locator failure classification and redacts arbitrary failures', async () => {
  const mutated = new RpcTransientError();
  Object.assign(mutated, { code: 'SECRET_CODE', retryable: false, name: 'SecretName' });
  for (const scenario of [
    { error: new RpcTransientError(), failure: failure('RPC_TRANSIENT', 'RpcTransientError', true) },
    { error: new TransactionIndexNotFoundError(), failure: failure('TRANSACTION_INDEX_NOT_FOUND', 'TransactionIndexNotFoundError', false) },
    { error: mutated, failure: failure('RPC_TRANSIENT', 'RpcTransientError', true) },
  ]) {
    let marked: IngestionFailure | null = null;
    const worker = new TransactionInboxWorker(repositoryWith({
      async claim() { return claim(); },
      async markFailed(_signature, _token, value) { marked = value; },
    }), { async locate() { throw scenario.error; } }, pipeline(), options());
    assert.deepEqual(await worker.runOnce(), { kind: 'failed', signature: 'sig', failure: scenario.failure });
    assert.deepEqual(marked, scenario.failure);
    assert.ok(Object.isFrozen(marked));
  }

  let traps = 0;
  const hostile = new Proxy(new Error('hidden'), { get() { traps += 1; throw new Error('secret'); }, getPrototypeOf() { traps += 1; throw new Error('secret'); } });
  let marked: IngestionFailure | null = null;
  const worker = new TransactionInboxWorker(repositoryWith({
    async claim() { return claim(); },
    async markFailed(_signature, _token, value) { marked = value; },
  }), { locate() { return Promise.reject(hostile); } }, pipeline(), options());
  assert.deepEqual(await worker.runOnce(), {
    kind: 'failed', signature: 'sig', failure: failure('RPC_TRANSIENT', 'TransactionLocatorError', true),
  });
  assert.deepEqual(marked, failure('RPC_TRANSIENT', 'TransactionLocatorError', true));
  assert.equal(traps, 0);
});

void test('classifies corrupt snapshots and pipeline failures without leaking thrown values', async () => {
  const corrupt = { ...createDurableTransactionSnapshot(normalized()), signature: 'other' };
  let corruptFailure: IngestionFailure | null = null;
  const corruptWorker = new TransactionInboxWorker(repositoryWith({
    async claim() { return claim('sig', 1n, 'processed', corrupt as never); },
    async markFailed(_signature, _token, value) { corruptFailure = value; },
  }), locator(), pipeline(), options());
  assert.deepEqual(await corruptWorker.runOnce(), {
    kind: 'failed', signature: 'sig',
    failure: failure('NORMALIZATION_FAILED', 'TransactionNormalizationError', false),
  });
  assert.deepEqual(corruptFailure, failure('NORMALIZATION_FAILED', 'TransactionNormalizationError', false));

  let traps = 0;
  const hostile = new Proxy(new Error('hidden'), { get() { traps += 1; throw new Error('secret'); }, getPrototypeOf() { traps += 1; throw new Error('secret'); } });
  let pipelineFailure: IngestionFailure | null = null;
  const pipelineWorker = new TransactionInboxWorker(repositoryWith({
    async claim() { return claim(); },
    async markFailed(_signature, _token, value) { pipelineFailure = value; },
  }), locator(), { process() { return Promise.reject(hostile); } }, options());
  assert.deepEqual(await pipelineWorker.runOnce(), {
    kind: 'failed', signature: 'sig', failure: failure('PIPELINE_STAGE_FAILED', 'ObservedPipelineError', true),
  });
  assert.deepEqual(pipelineFailure, failure('PIPELINE_STAGE_FAILED', 'ObservedPipelineError', true));
  assert.equal(traps, 0);
});

void test('renews during a long pipeline, uses monotonic expiry, and cleans the timer', async () => {
  const scheduler = new ManualScheduler();
  let now = 1_000;
  const renewals: number[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const worker = new TransactionInboxWorker(repositoryWith({
    async claim() { return claim(); },
    async renewLease(_signature, _token, until) { renewals.push(until); },
  }), locator(), { async process() { await blocked; } }, options({ scheduler, now: () => now }));

  const running = worker.runOnce();
  await scheduler.waitForScheduled();
  now = 1_500;
  await scheduler.fire();
  now = 1_200;
  await scheduler.fire();
  release();
  assert.deepEqual(await running, { kind: 'processed', signature: 'sig' });
  assert.deepEqual(renewals, [11_000, 11_500, 11_500]);
  assert.equal(scheduler.activeCount, 0);
});

void test('does not complete or fail with a lost lease token', async () => {
  const scheduler = new ManualScheduler();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let completed = 0;
  let failed = 0;
  let renewal = 0;
  const worker = new TransactionInboxWorker(repositoryWith({
    async claim() { return claim(); },
    async renewLease() { renewal += 1; if (renewal > 1) throw new Error('stale'); },
    async markProcessed() { completed += 1; },
    async markFailed() { failed += 1; },
  }), locator(), { async process() { await blocked; } }, options({ scheduler }));
  const running = worker.runOnce();
  await scheduler.waitForScheduled();
  await scheduler.fire();
  release();

  assert.deepEqual(await running, { kind: 'lease-lost', signature: 'sig' });
  assert.equal(completed, 0);
  assert.equal(failed, 0);
  assert.equal(scheduler.activeCount, 0);
  assert.equal(worker.state, 'DEGRADED');
  await worker.close();
  assert.equal(worker.state, 'STOPPED');
});

void test('stops before pipeline when the initial ownership guard loses its lease', async () => {
  let pipelines = 0;
  let completions = 0;
  const worker = new TransactionInboxWorker(repositoryWith({
    async claim() { return claim(); },
    async renewLease() { throw new Error('stale'); },
    async markProcessed() { completions += 1; },
  }), locator(), { async process() { pipelines += 1; } }, options());
  assert.deepEqual(await worker.runOnce(), { kind: 'lease-lost', signature: 'sig' });
  assert.equal(pipelines, 0);
  assert.equal(completions, 0);
  assert.equal(worker.state, 'DEGRADED');
});

void test('contains scheduler setup and cleanup failures as degraded lease loss', async () => {
  for (const scenario of [
    { scheduler: { schedule() { throw new Error('schedule secret'); }, cancel() {} }, closedState: 'STOPPED' },
    { scheduler: { schedule() { return {}; }, cancel() { throw new Error('cancel secret'); } }, closedState: 'DEGRADED' },
  ]) {
    let completed = 0;
    const worker = new TransactionInboxWorker(repositoryWith({
      async claim() { return claim(); }, async markProcessed() { completed += 1; },
    }), locator(), pipeline(), options({ scheduler: scenario.scheduler }));
    assert.deepEqual(await worker.runOnce(), { kind: 'lease-lost', signature: 'sig' });
    assert.equal(completed, 0);
    assert.equal(worker.state, 'DEGRADED');
    await worker.close();
    assert.equal(worker.state, scenario.closedState);
  }
});

void test('serializes overlapping runOnce calls and claims at most one row per call', async () => {
  let claims = 0;
  let active = 0;
  let maximum = 0;
  const worker = new TransactionInboxWorker(repositoryWith({
    async claim() { claims += 1; return claims <= 2 ? claim(`sig-${claims}`) : null; },
  }), { async locate(target) { return normalized(target.signature); } }, { async process() {
    active += 1; maximum = Math.max(maximum, active); await Promise.resolve(); active -= 1;
  } }, options());

  const results = await Promise.all([worker.runOnce(), worker.runOnce()]);
  assert.deepEqual(results.map((value) => value.kind), ['processed', 'processed']);
  assert.equal(claims, 2);
  assert.equal(maximum, 1);
});

void test('start idles without a busy loop and concurrent close cancels wait', async () => {
  const scheduler = new ManualScheduler();
  let claims = 0;
  const worker = new TransactionInboxWorker(repositoryWith({ async claim() { claims += 1; return null; } }), locator(), pipeline(), options({ scheduler }));
  await Promise.all([worker.start(), worker.start()]);
  await scheduler.waitForScheduled();
  assert.equal(worker.state, 'RUNNING');
  assert.equal(claims, 1);
  await Promise.all([worker.close(), worker.close(), worker.close()]);
  assert.equal(worker.state, 'STOPPED');
  assert.equal(scheduler.activeCount, 0);
  assert.deepEqual(await worker.runOnce(), { kind: 'closed' });
});

void test('close waits for in-flight pipeline and markProcessed failures degrade safely', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const worker = new TransactionInboxWorker(repositoryWith({ async claim() { return claim(); } }), locator(), { async process() { await blocked; } }, options());
  const running = worker.runOnce();
  await Promise.resolve();
  let closed = false;
  const closing = worker.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await Promise.all([running, closing]);
  assert.equal(worker.state, 'STOPPED');

  const broken = new TransactionInboxWorker(repositoryWith({
    async claim() { return claim(); },
    async markProcessed() { throw new Error('database secret'); },
  }), locator(), pipeline(), options());
  await assert.rejects(broken.runOnce(), (error: unknown) => {
    assert.ok(error instanceof TransactionInboxWorkerError);
    assert.equal(error.stage, 'mark-processed');
    assert.equal(error.message, 'Transaction inbox worker operation failed.');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.ok(Object.isFrozen(error));
    return true;
  });
  assert.equal(broken.state, 'DEGRADED');
});

void test('durable mutation failures are redacted, degraded, and never double-completed', async () => {
  for (const scenario of [
    { stage: 'save-snapshot' as const, repository: repositoryWith({
      async claim() { return claim(); }, async saveSnapshot() { throw new Error('save secret'); },
    }) },
    { stage: 'mark-failed' as const, repository: repositoryWith({
      async claim() { return claim(); }, async markFailed() { throw new Error('mark secret'); },
    }), locateError: new RpcTransientError() },
  ]) {
    let processed = 0;
    const repository = { ...scenario.repository, async markProcessed() { processed += 1; } };
    const worker = new TransactionInboxWorker(repository, {
      async locate(target) {
        if (scenario.locateError !== undefined) throw scenario.locateError;
        return normalized(target.signature, target.slot, target.confirmationStatus);
      },
    }, pipeline(), options());
    await assert.rejects(worker.runOnce(), (error: unknown) => {
      assert.ok(error instanceof TransactionInboxWorkerError);
      assert.equal(error.stage, scenario.stage);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
    assert.equal(processed, 0);
    assert.equal(worker.state, 'DEGRADED');
  }
});

void test('rejects unsafe timing bounds without consulting injected objects', () => {
  const hostile = new Proxy({}, { get() { throw new Error('secret'); } });
  for (const invalid of [
    { leaseSeconds: 0, renewalIntervalMs: 1, idlePollMs: 1 },
    { leaseSeconds: 1, renewalIntervalMs: 1_000, idlePollMs: 1 },
    { leaseSeconds: 10, renewalIntervalMs: 1, idlePollMs: 2_147_483_648 },
  ]) {
    assert.throws(() => new TransactionInboxWorker(hostile as never, hostile as never, hostile as never, invalid), TypeError);
  }
});

function options(overrides: Record<string, unknown> = {}) {
  return { leaseSeconds: 10, renewalIntervalMs: 1_000, idlePollMs: 250, now: () => 1_000, ...overrides };
}

function claim(
  signature = 'sig', slot = 1n, confirmationStatus: ClaimedTransaction['confirmationStatus'] = 'processed',
  snapshot: ClaimedTransaction['normalizedTransaction'] = null,
): ClaimedTransaction {
  return Object.freeze({ signature, slot, confirmationStatus, attempts: 1, leaseToken: 'lease', leaseExpiresAtMs: 11_000, normalizedTransaction: snapshot });
}

function normalized(signature = 'sig', slot = 1n, confirmationStatus: NormalizedTransaction['confirmationStatus'] = 'PROCESSED'): NormalizedTransaction {
  return { signature, slot, transactionIndex: 3, confirmationStatus, version: 'legacy', blockTimeMs: null,
    accountKeys: ['account'], signerKeys: ['account'], instructions: [], preTokenBalances: [], postTokenBalances: [],
    preBalancesLamports: [1n], postBalancesLamports: [1n], feeLamports: 0n, computeUnits: null, logs: [], error: null };
}

function failure(code: IngestionFailure['code'], errorName: string, retryable: boolean): IngestionFailure {
  return Object.freeze({ code, errorName, retryable });
}

function repositoryWith(overrides: Partial<TransactionInboxWorkerRepository>): TransactionInboxWorkerRepository {
  return {
    async claim() { return null; }, async renewLease() {}, async saveSnapshot() {}, async markProcessed() {}, async markFailed() {}, ...overrides,
  };
}

function locator() { return { async locate(target: TransactionLocationTarget) { return normalized(target.signature, target.slot, target.confirmationStatus); } }; }
function pipeline() { return { async process() {} }; }

class ManualScheduler implements TransactionInboxWorkerScheduler {
  private readonly callbacks = new Map<object, () => void>();
  private waiter: (() => void) | null = null;
  public get activeCount(): number { return this.callbacks.size; }
  public schedule(callback: () => void, _delayMs: number): object {
    const handle = {};
    this.callbacks.set(handle, callback);
    this.waiter?.();
    this.waiter = null;
    return handle;
  }
  public cancel(handle: unknown): void { this.callbacks.delete(handle as object); }
  public async waitForScheduled(): Promise<void> {
    if (this.callbacks.size > 0) return;
    await new Promise<void>((resolve) => { this.waiter = resolve; });
  }
  public async fire(): Promise<void> {
    const entry = this.callbacks.entries().next().value as [object, () => void] | undefined;
    assert.ok(entry);
    this.callbacks.delete(entry[0]);
    entry[1]();
    await Promise.resolve();
    await Promise.resolve();
  }
}
