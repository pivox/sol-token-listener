import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { ProviderAffineCatchUpHydration, ProviderAffineCatchUpHydrationError } from '../src/application/provider-affine-catch-up-hydration.js';
import type { PromotedProviderSelection } from '../src/application/promoted-provider-selector.js';
import {
  StrictCatchUpAbortedError, StrictCatchUpPausedError, StrictCatchUpRefreshRequiredError, StrictCatchUpScannerError,
  StrictCatchUpWindowExceededError, type StrictCatchUpScanResult,
} from '../src/application/strict-catch-up-scanner.js';
import type { RpcProviderId } from '../src/domain/rpc-provider.js';
import { CachedSolanaBlockTransactionLocator, type BlockTransactionCacheOptions } from '../src/solana/rpc/block-transaction-cache.js';
import { trustedTransactionLocatorFailure, type TransactionBlockRpc, type TransactionLocationTarget } from '../src/solana/rpc/transaction-locator.js';

const KEY = new PublicKey('11111111111111111111111111111111');
const RESULT: StrictCatchUpScanResult = Object.freeze({
  providerId: 'fallback-1', discoveredCount: 0, enqueuedCount: 0,
  checkpointCasCount: 0, pageCount: 0, boundaries: Object.freeze({ launchpad: null, market: null }),
});
function target(signature = 'one', slot = 42n): TransactionLocationTarget {
  return { signature, slot, confirmationStatus: 'CONFIRMED' };
}
function block(slot = 42n, fee = 5000) {
  return {
    blockhash: KEY.toBase58(), previousBlockhash: KEY.toBase58(), parentSlot: Number(slot - 1n),
    blockTime: null,
    transactions: ['one', 'two'].map((signature) => ({
      version: 'legacy',
      transaction: {
        signatures: [signature], message: {
          header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
          accountKeys: [KEY],
          compiledInstructions: [{ programIdIndex: 0, accountKeyIndexes: [0], data: new Uint8Array([1]) }],
        },
      },
      meta: { fee, err: null, preBalances: [10000], postBalances: [5000],
        loadedAddresses: { writable: [], readonly: [] } },
    })),
  };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
function harness(options: BlockTransactionCacheOptions = {}) {
  let now = 0;
  let selection: PromotedProviderSelection = { providerId: 'primary', revision: 1n };
  let fetch: (slot: bigint, providerId: RpcProviderId) => Promise<unknown> = async (slot) => block(slot);
  let active = 0;
  let maximumActive = 0;
  const calls: { providerId: RpcProviderId; slot: bigint; time: number }[] = [];
  const providers = new Map<RpcProviderId, TransactionBlockRpc>(
    (['primary', 'fallback-1'] as const).map((providerId) => [providerId, {
      async getBlockTransactions(slot) {
        calls.push({ providerId, slot, time: now });
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try { return await fetch(slot, providerId); } finally { active -= 1; }
      },
    }]),
  );
  const hydration = new ProviderAffineCatchUpHydration(providers, {
    now: () => now, sleep: async (ms) => { now += ms; }, ...options,
    currentSelection: () => selection,
  });
  return {
    hydration, calls, providers,
    maximumActive: () => maximumActive,
    select(providerId: RpcProviderId | null) { selection = { providerId, revision: selection.revision + 1n }; },
    setFetch(value: typeof fetch) { fetch = value; },
  };
}

void test('worker uses one frozen locator and one cache for same-slot transactions', async () => {
  const h = harness();
  const locator = h.hydration.workerLocator();
  assert.equal(Object.isFrozen(locator), true);
  assert.equal(h.hydration.workerLocator(), locator);
  const [one, two] = await Promise.all([locator.locate(target()), locator.locate(target('two'))]);
  assert.equal(one.transactionIndex, 0);
  assert.equal(two.transactionIndex, 1);
  assert.deepEqual(h.calls, [{ providerId: 'primary', slot: 42n, time: 0 }]);
  assert.equal(h.hydration.metrics().fetches, 1);
  assert.equal(h.hydration.metrics().retainedEntries, 1);
  assert.equal(Object.isFrozen(h.hydration.metrics()), true);
  assert.equal(Object.isFrozen(h.hydration.state()), true);
  h.hydration.close();
});

void test('classifier views share the cache inside their pinned scan, independently of promotion', async () => {
  const h = harness();
  const classifier = h.hydration.classifierLocator('fallback-1');
  assert.equal(Object.isFrozen(classifier), true);
  assert.equal(h.hydration.classifierLocator('fallback-1'), classifier);
  const result = await h.hydration.runStrictScan('fallback-1', async (signal) => {
    assert.equal(signal.aborted, false);
    const [one, two] = await Promise.all([
      classifier.locate(target(), signal), classifier.locate(target('two'), signal),
    ]);
    assert.equal(one.transactionIndex, 0);
    assert.equal(two.transactionIndex, 1);
    return RESULT;
  }, new AbortController().signal);
  assert.equal(result, RESULT);
  assert.equal(h.hydration.metrics().inFlightJoins, 1);
  assert.deepEqual(h.calls.map(({ providerId }) => providerId), ['fallback-1']);
  h.hydration.close();
});

void test('provider routes share global fetch pacing and one active SDK fetch', async () => {
  const h = harness({ fetchIntervalMs: 250 });
  const pending = deferred<unknown>();
  h.setFetch(async (slot) => slot === 42n ? pending.promise : block(slot));
  const worker = h.hydration.workerLocator();
  const first = worker.locate(target());
  await flush();
  const second = worker.locate(target('one', 43n));
  await flush();
  assert.equal(h.calls.length, 1);
  pending.resolve(block());
  await Promise.all([first, second]);
  h.select('fallback-1');
  await worker.locate(target('one', 44n));
  assert.deepEqual(h.calls.map(({ time }) => time), [0, 250, 500]);
  assert.equal(h.maximumActive(), 1);
  assert.equal(h.hydration.metrics().fetches, 3);
  assert.equal(h.hydration.metrics().retainedEntries, 1);
  h.hydration.close();
});

function retryable(error: unknown): boolean {
  assert.equal(Object.isFrozen(error), true);
  assert.deepEqual(trustedTransactionLocatorFailure(error), {
    code: 'RPC_TRANSIENT', errorName: 'RpcTransientError', retryable: true,
  });
  return true;
}

void test('queued scan excludes later workers for its entire callback including persistence', async () => {
  const h = harness();
  const firstBlock = deferred<unknown>();
  const persistence = deferred<undefined>();
  const order: string[] = [];
  h.setFetch(async (slot) => slot === 42n ? firstBlock.promise : block(slot));
  const first = h.hydration.workerLocator().locate(target());
  await flush();
  const scan = h.hydration.runStrictScan('fallback-1', async (signal) => {
    order.push('scan');
    assert.deepEqual(h.hydration.state(), { providerId: 'fallback-1', scanActive: true, workerClaimReady: false });
    await h.hydration.classifierLocator('fallback-1').locate(target('one', 43n), signal);
    await persistence.promise;
    order.push('persisted');
    return RESULT;
  }, new AbortController().signal);
  assert.equal(h.hydration.canWorkerClaim(), false);
  const later = h.hydration.workerLocator().locate(target('one', 44n)).then(() => { order.push('worker'); });
  await flush();
  assert.deepEqual(order, []);
  assert.equal(h.calls.length, 1);
  firstBlock.resolve(block());
  await first;
  await flush();
  assert.deepEqual(order, ['scan']);
  assert.equal(h.calls.length, 2);
  persistence.resolve(undefined);
  await Promise.all([scan, later]);
  assert.deepEqual(order, ['scan', 'persisted', 'worker']);
  assert.equal(h.maximumActive(), 1);
  assert.equal(h.hydration.canWorkerClaim(), true);
  h.hydration.close();
});

void test('classifier is retryable outside its matching scan permit', async () => {
  const h = harness();
  const classifier = h.hydration.classifierLocator('fallback-1');
  await assert.rejects(classifier.locate(target()), retryable);
  await h.hydration.runStrictScan('primary', async () => {
    await assert.rejects(classifier.locate(target()), retryable);
    return RESULT;
  }, new AbortController().signal);
  await assert.rejects(classifier.locate(target()), retryable);
  assert.equal(h.calls.length, 0);
  h.hydration.close();
});

for (const transition of [['fallback-1'], [null, 'primary']] as const) {
  void test(`worker rejects stale promotion ${JSON.stringify(transition)} without retaining old results`, async () => {
    const h = harness();
    const pending = deferred<unknown>();
    h.setFetch(async () => pending.promise);
    const old = h.hydration.workerLocator().locate(target());
    const rejected = assert.rejects(old, retryable);
    await flush();
    for (const providerId of transition) h.select(providerId);
    pending.resolve(block());
    await rejected;
    assert.equal(h.hydration.metrics().retainedEntries, 0);
    h.setFetch(async (slot) => block(slot));
    await h.hydration.workerLocator().locate(target());
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1]?.providerId, transition[transition.length - 1]);
    assert.ok(h.hydration.metrics().epochInvalidations >= 1);
    h.hydration.close();
  });
}

void test('worker snapshot is rechecked after waiting behind a scan, before any RPC', async () => {
  const h = harness();
  const release = deferred<undefined>();
  const scan = h.hydration.runStrictScan('primary', async () => { await release.promise; return RESULT; }, new AbortController().signal);
  await flush();
  const waiting = assert.rejects(h.hydration.workerLocator().locate(target()), retryable);
  h.select('fallback-1');
  release.resolve(undefined);
  await Promise.all([scan, waiting]);
  assert.equal(h.calls.length, 0);
  h.hydration.close();
});

void test('aborted scans before admission and while queued never invoke the callback', async () => {
  const h = harness();
  const abort = new AbortController();
  abort.abort(new Error('https://secret.invalid/token'));
  let invoked = 0;
  const callback = async () => { invoked += 1; return RESULT; };
  await assert.rejects(h.hydration.runStrictScan('primary', callback, abort.signal));
  const release = deferred<undefined>();
  const active = h.hydration.runStrictScan('primary', async () => { await release.promise; return RESULT; }, new AbortController().signal);
  await flush();
  const queuedAbort = new AbortController();
  const queued = assert.rejects(h.hydration.runStrictScan('fallback-1', callback, queuedAbort.signal));
  queuedAbort.abort();
  await queued;
  release.resolve(undefined);
  await active;
  assert.equal(invoked, 0);
  assert.equal(h.calls.length, 0);
  h.hydration.close();
});

void test('aborted hydration before and after cache pacing starts no cancelled RPC', async () => {
  const sleeping = deferred<undefined>();
  let now = 0;
  const h = harness({ now: () => now, sleep: async (ms) => { await sleeping.promise; now += ms; } });
  await h.hydration.workerLocator().locate(target());
  const abort = new AbortController();
  const scan = assert.rejects(h.hydration.runStrictScan('fallback-1', async (signal) => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(h.hydration.classifierLocator('fallback-1').locate(target(), alreadyAborted.signal), retryable);
    await h.hydration.classifierLocator('fallback-1').locate(target('one', 43n), signal);
    return RESULT;
  }, abort.signal));
  await flush();
  abort.abort();
  sleeping.resolve(undefined);
  await scan;
  assert.equal(h.calls.length, 1);
  h.hydration.close();
});

void test('close rejects waiters, aborts the scan, and clears exactly one owned cache once', async (t) => {
  const clear = t.mock.method(CachedSolanaBlockTransactionLocator.prototype, 'clear');
  const close = t.mock.method(CachedSolanaBlockTransactionLocator.prototype, 'close');
  const h = harness();
  const release = deferred<undefined>();
  let activeSignal: AbortSignal | undefined;
  const scan = assert.rejects(h.hydration.runStrictScan('primary', async (signal) => {
    activeSignal = signal;
    await release.promise;
    return RESULT;
  }, new AbortController().signal));
  await flush();
  const worker = assert.rejects(h.hydration.workerLocator().locate(target()), retryable);
  const queuedScan = assert.rejects(h.hydration.runStrictScan('fallback-1', async () => RESULT, new AbortController().signal));
  const clearsBefore = clear.mock.callCount();
  h.hydration.close();
  h.hydration.close();
  assert.equal(clear.mock.callCount(), clearsBefore + 1);
  assert.equal(close.mock.callCount(), 1);
  assert.equal(activeSignal?.aborted, true);
  assert.equal(h.hydration.canWorkerClaim(), false);
  await Promise.all([worker, queuedScan]);
  release.resolve(undefined);
  await scan;
  await assert.rejects(h.hydration.workerLocator().locate(target()), retryable);
  await assert.rejects(h.hydration.classifierLocator('primary').locate(target()), retryable);
  assert.equal(h.hydration.metrics().retainedEntries, 0);
  assert.equal(clear.mock.callCount(), clearsBefore + 1);
});

void test('hostile provider maps and selection callbacks expose only frozen fixed failures', async () => {
  const secret = 'https://private.invalid/?api-key=secret';
  const hostile = new Proxy(new Map<RpcProviderId, TransactionBlockRpc>(), {
    get() { throw new Error(secret); },
  });
  const safeFailure = (error: unknown): boolean => {
    assert.equal(Object.isFrozen(error), true);
    assert.doesNotMatch(String(error), /private|secret/);
    assert.doesNotMatch(JSON.stringify(error), /private|secret/);
    return true;
  };
  assert.throws(() => new ProviderAffineCatchUpHydration(hostile, {
    currentSelection: () => ({ providerId: 'primary', revision: 0n }),
  }), safeFailure);
  const providers = harness().providers;
  for (const currentSelection of [
    (): PromotedProviderSelection => { throw new Error(secret); },
    (): PromotedProviderSelection => new Proxy({ providerId: 'primary', revision: 0n }, { get() { throw new Error(secret); } }),
    (): PromotedProviderSelection => ({ get providerId(): RpcProviderId { throw new Error(secret); }, revision: 0n }),
    (): PromotedProviderSelection => ({ providerId: 'primary', revision: -1n }),
  ]) {
    const hydration = new ProviderAffineCatchUpHydration(providers, { currentSelection });
    assert.equal(hydration.canWorkerClaim(), false);
    assert.deepEqual(hydration.state(), { providerId: null, scanActive: false, workerClaimReady: false });
    await assert.rejects(hydration.workerLocator().locate(target()), retryable);
    hydration.close();
  }
});

void test('unknown scan errors are redacted, known frozen scanner errors preserve recovery semantics', async () => {
  const h = harness();
  const secret = 'https://private.invalid/?api-key=secret';
  await assert.rejects(h.hydration.runStrictScan('primary', async () => { throw new Error(secret); }, new AbortController().signal), (error: unknown) => {
    assert.equal(Object.isFrozen(error), true);
    assert.doesNotMatch(String(error), /private|secret/);
    assert.doesNotMatch(JSON.stringify(error), /private|secret/);
    return true;
  });
  const known = new StrictCatchUpRefreshRequiredError('primary');
  await assert.rejects(h.hydration.runStrictScan('primary', async () => { throw known; }, new AbortController().signal),
    (error: unknown) => error instanceof StrictCatchUpRefreshRequiredError && error.providerId === known.providerId);
  h.hydration.close();
});

void test('enforces the global minimum fetch interval and snapshots the provider map', async () => {
  const h = harness({ fetchIntervalMs: 1 });
  h.providers.clear();
  await h.hydration.workerLocator().locate(target());
  await h.hydration.workerLocator().locate(target('one', 43n));
  assert.deepEqual(h.calls.map(({ time }) => time), [0, 250]);
  h.hydration.close();
});

void test('a provider change overrides terminal location failures from the old provider', async () => {
  const h = harness();
  const pending = deferred<unknown>();
  h.setFetch(async () => pending.promise);
  const rejected = assert.rejects(h.hydration.workerLocator().locate(target('missing')), retryable);
  await flush();
  h.select('fallback-1');
  pending.resolve(block());
  await rejected;
  assert.equal(h.hydration.metrics().retainedEntries, 0);
  h.hydration.close();
});

void test('cancellation overrides a terminal classifier failure after an SDK await', async () => {
  const h = harness();
  const pending = deferred<unknown>();
  const abort = new AbortController();
  h.setFetch(async () => pending.promise);
  const scan = h.hydration.runStrictScan('primary', async () => {
    await assert.rejects(h.hydration.classifierLocator('primary').locate(target('missing'), abort.signal), retryable);
    return RESULT;
  }, new AbortController().signal);
  await flush();
  abort.abort();
  pending.resolve(block());
  await scan;
  h.hydration.close();
});

void test('shutdown while draining detached classifier work cannot return a successful scan', async () => {
  const h = harness();
  const pending = deferred<unknown>();
  h.setFetch(async () => pending.promise);
  let hydration: Promise<void> | undefined;
  const scan = assert.rejects(h.hydration.runStrictScan('primary', async () => {
    hydration = assert.rejects(h.hydration.classifierLocator('primary').locate(target()), retryable);
    return RESULT;
  }, new AbortController().signal));
  await flush();
  h.hydration.close();
  pending.resolve(block());
  await Promise.all([scan, hydration]);
});

void test('forged scanner error accessors and mutable error data are never exposed', async () => {
  const h = harness();
  let reads = 0;
  const getter = Object.create(StrictCatchUpRefreshRequiredError.prototype) as StrictCatchUpRefreshRequiredError;
  Object.defineProperty(getter, 'providerId', { get() { reads += 1; throw new Error('secret-provider'); } });
  Object.freeze(getter);
  const fields = Object.freeze(Object.assign(Object.create(StrictCatchUpRefreshRequiredError.prototype) as Error, {
    providerId: 'primary', name: 'secret-name', message: 'secret-message', payload: 'secret-payload',
  }));
  for (const forged of [getter, fields]) {
    await assert.rejects(h.hydration.runStrictScan('primary', async () => { throw forged as Error; }, new AbortController().signal), (error: unknown) => {
      assert.equal(Object.isFrozen(error), true);
      assert.doesNotMatch(String(error), /secret/u);
      assert.doesNotMatch(JSON.stringify(error), /secret/u);
      return true;
    });
  }
  assert.equal(reads, 0);
  h.hydration.close();
});

void test('preserves safe paused, window and checkpoint-conflict errors used by recovery', async () => {
  const h = harness();
  const errors = [
    new StrictCatchUpPausedError('primary', 'launchpad', `strict_catchup_run_${'a'.repeat(64)}`, 1n, 0n),
    new StrictCatchUpWindowExceededError('primary', 'launchpad', { launchpad: null, market: null }),
    new StrictCatchUpScannerError('checkpoint-cas', 'primary', 'launchpad'),
  ];
  for (const expected of errors) {
    await assert.rejects(h.hydration.runStrictScan('primary', async () => { throw expected; }, new AbortController().signal),
      (error: unknown) => error instanceof Error && Object.getPrototypeOf(error) === Object.getPrototypeOf(expected));
  }
  h.hydration.close();
});

void test('null promotion disables claims until promotion, while scans remain provider-pinned', async () => {
  const h = harness();
  h.select(null);
  assert.equal(h.hydration.canWorkerClaim(), false);
  await assert.rejects(h.hydration.workerLocator().locate(target()), retryable);
  await h.hydration.runStrictScan('primary', async () => {
    await h.hydration.classifierLocator('primary').locate(target());
    h.select('fallback-1');
    await h.hydration.classifierLocator('primary').locate(target('two'));
    return RESULT;
  }, new AbortController().signal);
  assert.equal(h.hydration.canWorkerClaim(), true);
  await h.hydration.workerLocator().locate(target());
  assert.deepEqual(h.calls.map(({ providerId }) => providerId), ['primary', 'fallback-1']);
  h.hydration.close();
});

void test('new scan generations cannot reuse a previous scan cache even on the same provider', async () => {
  const h = harness();
  for (let index = 0; index < 2; index += 1) {
    await h.hydration.runStrictScan('primary', async () => {
      await h.hydration.classifierLocator('primary').locate(target());
      return RESULT;
    }, new AbortController().signal);
  }
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls.map(({ time }) => time), [0, 250]);
  h.hydration.close();
});

void test('bounded permit queue rejects overload and shutdown drains all admitted waiters', async () => {
  const h = harness();
  const release = deferred<undefined>();
  const scan = assert.rejects(h.hydration.runStrictScan('primary', async () => {
    await release.promise;
    return RESULT;
  }, new AbortController().signal));
  await flush();
  const queued = Array.from({ length: 1024 }, () => assert.rejects(h.hydration.workerLocator().locate(target()), retryable));
  await assert.rejects(h.hydration.workerLocator().locate(target()), retryable);
  h.hydration.close();
  release.resolve(undefined);
  await Promise.all([scan, ...queued]);
  assert.equal(h.calls.length, 0);
});

void test('known scanner categories never propagate attacker-supplied stack values or getters', async () => {
  const h = harness();
  let reads = 0;
  for (const accessor of [false, true]) {
    const error = new Error('Strict catch-up requires a fresh recovery cycle.');
    Object.setPrototypeOf(error, StrictCatchUpRefreshRequiredError.prototype);
    Object.assign(error, { providerId: 'primary', name: 'StrictCatchUpRefreshRequiredError',
      code: 'CATCH_UP_REFRESH_REQUIRED', retryable: true, stage: 'head-refresh' });
    Object.defineProperty(error, 'stack', accessor
      ? { get() { reads += 1; return 'https://private.invalid/?api-key=secret'; }, enumerable: false }
      : { value: 'https://private.invalid/?api-key=secret', enumerable: true });
    Object.freeze(error);
    await assert.rejects(h.hydration.runStrictScan('primary', async () => { throw error; }, new AbortController().signal), (failure: unknown) => {
      assert.ok(failure instanceof Error);
      assert.doesNotMatch(failure.stack ?? '', /private|secret/u);
      assert.doesNotMatch(JSON.stringify(failure), /private|secret/u);
      return true;
    });
  }
  assert.equal(reads, 0);
  h.hydration.close();
});

void test('an aborted in-flight scan drops retained block evidence before releasing its permit', async () => {
  const h = harness();
  const pending = deferred<unknown>();
  const abort = new AbortController();
  h.setFetch(async () => pending.promise);
  const scan = assert.rejects(h.hydration.runStrictScan('primary', async (signal) => {
    await h.hydration.classifierLocator('primary').locate(target(), signal);
    return RESULT;
  }, abort.signal));
  await flush();
  abort.abort();
  pending.resolve(block());
  await scan;
  assert.equal(h.hydration.metrics().retainedEntries, 0);
  assert.equal(h.hydration.metrics().retainedBytes, 0);
  assert.equal(h.hydration.canWorkerClaim(), true);
  h.hydration.close();
});

void test('window error provenance survives safe wrapping without carrying a modified native stack', async () => {
  const h = harness();
  const original = new StrictCatchUpWindowExceededError('primary', 'launchpad', { launchpad: null, market: null });
  await assert.rejects(h.hydration.runStrictScan('primary', async () => { throw original; }, new AbortController().signal),
    (error: unknown) => error instanceof StrictCatchUpWindowExceededError && error !== original && error.sameFrontier(error));
  const descriptor = Object.getOwnPropertyDescriptor(original, 'stack');
  if (descriptor?.set !== undefined) {
    Reflect.apply(descriptor.set, original, ['https://private.invalid/?api-key=secret']);
    await assert.rejects(h.hydration.runStrictScan('primary', async () => { throw original; }, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof StrictCatchUpWindowExceededError, true);
      assert.doesNotMatch(error.stack ?? '', /private|secret/u);
      return true;
    });
  }
  h.hydration.close();
});

void test('window errors cannot hide a secret in an otherwise canonical stack frame', async () => {
  const h = harness();
  const original = new StrictCatchUpWindowExceededError('primary', 'launchpad', { launchpad: null, market: null });
  const descriptor = Object.getOwnPropertyDescriptor(original, 'stack');
  if (descriptor?.set !== undefined) {
    Reflect.apply(descriptor.set, original, [
      'StrictCatchUpWindowExceededError: Strict catch-up scan window was exceeded.\n    at sk-proj-abc123SensitiveToken',
    ]);
    await assert.rejects(h.hydration.runStrictScan('primary', async () => { throw original; }, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.stack ?? '', /SensitiveToken/u);
      return true;
    });
  }
  h.hydration.close();
});

void test('safe window wrappers compare only private-provenance peers with matching frontiers', async () => {
  const h = harness();
  const wrap = async (original: StrictCatchUpWindowExceededError): Promise<StrictCatchUpWindowExceededError> => {
    try {
      await h.hydration.runStrictScan('primary', async () => { throw original; }, new AbortController().signal);
    } catch (error) {
      assert.ok(error instanceof StrictCatchUpWindowExceededError);
      assert.equal(Object.getPrototypeOf(error), StrictCatchUpWindowExceededError.prototype);
      assert.equal(Object.isFrozen(error), true);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return error;
    }
    throw new Error('Expected a window failure.');
  };
  const empty = { launchpad: null, market: null };
  const original = new StrictCatchUpWindowExceededError('primary', 'launchpad', empty);
  const first = await wrap(original);
  const same = await wrap(new StrictCatchUpWindowExceededError('fallback-1', 'launchpad', empty));
  const different = await wrap(new StrictCatchUpWindowExceededError('primary', 'launchpad', {
    launchpad: { key: 'launchpad', slot: 42n, signature: 'one', updatedAtMs: 0 }, market: null,
  }));
  assert.equal(first.sameFrontier(first), true);
  assert.equal(first.sameFrontier(same), true);
  assert.equal(same.sameFrontier(first), true);
  assert.equal(first.sameFrontier(different), false);
  assert.equal(first.sameFrontier(original), false);
  assert.equal(first.sameFrontier(new Proxy(original, { get() { throw new Error('secret'); } })), false);
  assert.doesNotMatch(JSON.stringify(first), /stack|cause|secret/u);
  h.hydration.close();
});

for (const cancellation of ['abort', 'close'] as const) {
  void test(`${cancellation} preserves a freshly reconstructed scanner abort for supervisor recovery`, async () => {
    const h = harness();
    const abort = new AbortController();
    const original = new StrictCatchUpAbortedError();
    await assert.rejects(h.hydration.runStrictScan('primary', async (signal) => {
      if (cancellation === 'abort') abort.abort(new Error('secret-abort-reason'));
      else h.hydration.close();
      assert.equal(signal.aborted, true);
      throw original;
    }, abort.signal), (error: unknown) => {
      assert.ok(error instanceof StrictCatchUpAbortedError);
      assert.notEqual(error, original);
      assert.equal(Object.isFrozen(error), true);
      assert.doesNotMatch(error.stack ?? '', /secret-abort-reason/u);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
    h.hydration.close();
  });

  void test(`${cancellation} suppresses stale non-abort scanner recovery categories`, async () => {
    for (const original of [
      new StrictCatchUpPausedError('primary', 'launchpad', `strict_catchup_run_${'a'.repeat(64)}`, 1n, 0n),
      new StrictCatchUpWindowExceededError('primary', 'launchpad', { launchpad: null, market: null }),
      new StrictCatchUpRefreshRequiredError('primary'),
      new StrictCatchUpScannerError('checkpoint-cas', 'primary', 'launchpad'),
    ]) {
      const h = harness();
      const abort = new AbortController();
      await assert.rejects(h.hydration.runStrictScan('primary', async () => {
        if (cancellation === 'abort') abort.abort();
        else h.hydration.close();
        throw original;
      }, abort.signal), ProviderAffineCatchUpHydrationError);
      h.hydration.close();
    }
  });
}
