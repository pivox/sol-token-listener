import assert from 'node:assert/strict';
import test from 'node:test';
import type { FetchFn } from '@solana/web3.js';
import { RPC_PROVIDER_IDS } from '../src/domain/rpc-provider.js';
import { assertValidRuntimeRpcHttpEvidence } from '../src/domain/rpc-http-evidence.js';
import {
  createObservedRpcFetch,
  createRpcHttpEvidenceRecorder,
} from '../src/solana/rpc/rpc-http-evidence.js';

void test('records fixed ordered configured provider evidence as detached frozen snapshots', () => {
  const recorder = createRpcHttpEvidenceRecorder();
  recorder.recordAttempt('primary');
  recorder.recordHttp429('primary');

  const first = recorder.snapshot(['primary']);
  const second = recorder.snapshot(['primary']);

  assert.equal(first.version, 1);
  assert.equal(first.overflowed, false);
  assert.deepEqual(first.providers.map(({ providerId }) => providerId), RPC_PROVIDER_IDS);
  assert.deepEqual(first.providers, [
    { providerId: 'primary', configured: true, attempts: 1, http429Responses: 1 },
    { providerId: 'fallback-1', configured: false, attempts: 0, http429Responses: 0 },
    { providerId: 'fallback-2', configured: false, attempts: 0, http429Responses: 0 },
    { providerId: 'fallback-3', configured: false, attempts: 0, http429Responses: 0 },
  ]);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.providers), true);
  assert.equal(first.providers.every(Object.isFrozen), true);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.providers, second.providers);
  assert.notStrictEqual(first.providers[0], second.providers[0]);
  assert.throws(() => {
    (first.providers as unknown as { 0: { attempts: number } })[0].attempts = 2;
  }, TypeError);
  assert.doesNotThrow(() => { assertValidRuntimeRpcHttpEvidence(first); });
});

void test('rejects invalid provider IDs for recording and configured snapshot membership', () => {
  const recorder = createRpcHttpEvidenceRecorder();

  assert.throws(() => { recorder.recordAttempt('other' as never); }, /invalid/i);
  assert.throws(() => { recorder.recordHttp429('other' as never); }, /invalid/i);
  assert.throws(() => { recorder.snapshot(['primary', 'primary']); }, /invalid/i);
  assert.throws(() => { recorder.snapshot(['other' as never]); }, /invalid/i);
});

void test('rejects nonzero counters for an unconfigured provider evidence entry', () => {
  const recorder = createRpcHttpEvidenceRecorder();
  const snapshot = recorder.snapshot(['primary']);
  const invalid = {
    ...snapshot,
    providers: snapshot.providers.map((provider) => provider.providerId === 'fallback-1'
      ? { ...provider, attempts: 1 }
      : { ...provider }),
  };

  assert.throws(() => { assertValidRuntimeRpcHttpEvidence(invalid); }, /invalid/i);
});

void test('preserves counter invariants and marks impossible 429 evidence unusable', () => {
  const recorder = createRpcHttpEvidenceRecorder();

  assert.doesNotThrow(() => { recorder.recordHttp429('primary'); });
  const impossible = recorder.snapshot(['primary']);
  assert.equal(impossible.overflowed, true);
  assert.deepEqual(impossible.providers[0], {
    providerId: 'primary', configured: true, attempts: 0, http429Responses: 0,
  });

  recorder.recordAttempt('primary');
  recorder.recordHttp429('primary');
  recorder.recordHttp429('primary');
  const later = recorder.snapshot(['primary']);
  assert.equal(later.overflowed, true);
  assert.equal(later.providers[0]?.attempts, 1);
  assert.equal(later.providers[0]?.http429Responses, 1);
});

void test('saturates counters at MAX_SAFE_INTEGER and retains overflow permanently', () => {
  const recorder = createRpcHttpEvidenceRecorder();
  // The public contract cannot practically perform 9 quadrillion operations in a unit test.
  const internal = recorder as unknown as {
    counters: Map<string, { attempts: number; http429Responses: number }>;
  };
  internal.counters.set('primary', {
    attempts: Number.MAX_SAFE_INTEGER - 1,
    http429Responses: Number.MAX_SAFE_INTEGER - 1,
  });

  recorder.recordAttempt('primary');
  recorder.recordHttp429('primary');
  const exactMaximum = recorder.snapshot(['primary']);
  assert.equal(exactMaximum.overflowed, false);
  assert.equal(exactMaximum.providers[0]?.attempts, Number.MAX_SAFE_INTEGER);
  assert.equal(exactMaximum.providers[0]?.http429Responses, Number.MAX_SAFE_INTEGER);

  recorder.recordAttempt('primary');
  recorder.recordHttp429('primary');
  const overflowed = recorder.snapshot(['primary']);
  assert.equal(overflowed.overflowed, true);
  assert.equal(overflowed.providers[0]?.attempts, Number.MAX_SAFE_INTEGER);
  assert.equal(overflowed.providers[0]?.http429Responses, Number.MAX_SAFE_INTEGER);

  const after = recorder.snapshot(['primary']);
  assert.equal(after.overflowed, true);
});

void test('returns a hostile resolved fetch response without changing the fetch outcome', async () => {
  const recorder = createRpcHttpEvidenceRecorder();
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, 'status', {
    configurable: true,
    get() { throw new Error('hostile-response-status'); },
  });
  const observed = createObservedRpcFetch('primary', recorder, async () => response);

  const actual = await observed('https://rpc.example.invalid');

  assert.strictEqual(actual, response);
  assert.deepEqual(recorder.snapshot(['primary']).providers[0], {
    providerId: 'primary', configured: true, attempts: 1, http429Responses: 0,
  });
});

void test('records an observed physical fetch once and retains a returned HTTP 429', async () => {
  const recorder = createRpcHttpEvidenceRecorder();
  let fetchCalls = 0;
  const fetch: FetchFn = async () => {
    fetchCalls += 1;
    return new Response('body-does-not-matter', { status: 429 });
  };
  const observed = createObservedRpcFetch('fallback-1', recorder, fetch);

  const response = await observed('https://rpc.example.invalid', {
    method: 'POST', body: 'sensitive body that must not be observed',
  });

  assert.equal(response.status, 429);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(recorder.snapshot(['fallback-1']).providers[1], {
    providerId: 'fallback-1', configured: true, attempts: 1, http429Responses: 1,
  });
});

void test('does not record or invoke fetch when the supplied signal is already aborted', async () => {
  const recorder = createRpcHttpEvidenceRecorder();
  const controller = new AbortController();
  controller.abort();
  let fetchCalls = 0;
  const observed = createObservedRpcFetch('primary', recorder, async () => {
    fetchCalls += 1;
    return new Response(null, { status: 200 });
  });

  await assert.rejects(observed('https://rpc.example.invalid', { signal: controller.signal }), {
    name: 'AbortError',
  });

  assert.equal(fetchCalls, 0);
  assert.deepEqual(recorder.snapshot(['primary']).providers[0], {
    providerId: 'primary', configured: true, attempts: 0, http429Responses: 0,
  });
});

void test('does not record or invoke fetch when a Request signal is already aborted', async () => {
  const recorder = createRpcHttpEvidenceRecorder();
  const controller = new AbortController();
  controller.abort();
  let fetchCalls = 0;
  const observed = createObservedRpcFetch('primary', recorder, async () => {
    fetchCalls += 1;
    return new Response(null, { status: 200 });
  });

  await assert.rejects(observed(new Request('https://rpc.example.invalid', {
    method: 'POST', signal: controller.signal,
  })), { name: 'AbortError' });

  assert.equal(fetchCalls, 0);
  assert.deepEqual(recorder.snapshot(['primary']).providers[0], {
    providerId: 'primary', configured: true, attempts: 0, http429Responses: 0,
  });
});

void test('uses init signal before the Request signal for abort admission', async () => {
  const recorder = createRpcHttpEvidenceRecorder();
  const requestController = new AbortController();
  requestController.abort();
  const initController = new AbortController();
  let fetchCalls = 0;
  const observed = createObservedRpcFetch('primary', recorder, async () => {
    fetchCalls += 1;
    return new Response(null, { status: 200 });
  });

  await observed(new Request('https://rpc.example.invalid', {
    method: 'POST', signal: requestController.signal,
  }), { signal: initController.signal });

  assert.equal(fetchCalls, 1);
  assert.equal(recorder.snapshot(['primary']).providers[0]?.attempts, 1);
});

void test('treats an explicit null init signal as disabling the Request signal', async () => {
  const recorder = createRpcHttpEvidenceRecorder();
  const requestController = new AbortController();
  requestController.abort();
  let fetchCalls = 0;
  const observed = createObservedRpcFetch('primary', recorder, async () => {
    fetchCalls += 1;
    return new Response(null, { status: 200 });
  });

  await observed(new Request('https://rpc.example.invalid', {
    method: 'POST', signal: requestController.signal,
  }), { signal: null });

  assert.equal(fetchCalls, 1);
  assert.deepEqual(recorder.snapshot(['primary']).providers[0], {
    providerId: 'primary', configured: true, attempts: 1, http429Responses: 0,
  });
});

void test('rejects extra, accessor, proxy and noncanonical top-level evidence safely', () => {
  const extra = mutableEvidence();
  Object.assign(extra, { apiKey: 'must-not-appear' });

  let getterReads = 0;
  const accessor = mutableEvidence();
  Object.defineProperty(accessor, 'overflowed', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      throw new Error('hostile-evidence-getter');
    },
  });

  let trapCalls = 0;
  const proxy = new Proxy(mutableEvidence(), {
    get() {
      trapCalls += 1;
      throw new Error('hostile-evidence-proxy');
    },
  });

  const wrongPrototype = Object.setPrototypeOf(mutableEvidence(), null);
  for (const value of [extra, accessor, proxy, wrongPrototype]) assertSafeInvalidEvidence(value);
  assert.equal(getterReads, 0);
  assert.equal(trapCalls, 0);
});

void test('rejects malformed provider evidence order, cardinality and counters', () => {
  const ordered = mutableEvidence();
  const reordered = mutableEvidence();
  const first = reordered.providers[0];
  const second = reordered.providers[1];
  if (first === undefined || second === undefined) throw new Error('Fixture is invalid.');
  reordered.providers[0] = second;
  reordered.providers[1] = first;

  const shortProviders = mutableEvidence();
  shortProviders.providers.pop();
  const nanCounter = mutableEvidence();
  const unsafeCounter = mutableEvidence();
  const nanProvider = nanCounter.providers[0];
  const unsafeProvider = unsafeCounter.providers[0];
  if (nanProvider === undefined || unsafeProvider === undefined) throw new Error('Fixture is invalid.');
  nanProvider.attempts = Number.NaN;
  unsafeProvider.http429Responses = Number.MAX_SAFE_INTEGER + 1;

  assert.doesNotThrow(() => { assertValidRuntimeRpcHttpEvidence(ordered); });
  for (const value of [reordered, shortProviders, nanCounter, unsafeCounter]) {
    assertSafeInvalidEvidence(value);
  }
});

function mutableEvidence(): {
  version: 1;
  overflowed: boolean;
  providers: { providerId: string; configured: boolean; attempts: number; http429Responses: number }[];
} {
  const snapshot = createRpcHttpEvidenceRecorder().snapshot(['primary']);
  return {
    version: snapshot.version,
    overflowed: snapshot.overflowed,
    providers: snapshot.providers.map((provider) => ({ ...provider })),
  };
}

function assertSafeInvalidEvidence(value: unknown): void {
  let caught: unknown;
  try {
    assertValidRuntimeRpcHttpEvidence(value);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof TypeError);
  assert.equal(caught.message, 'RPC HTTP evidence is invalid.');
  assert.equal(Object.hasOwn(caught, 'cause'), false);
}
