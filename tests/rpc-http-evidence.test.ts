import assert from 'node:assert/strict';
import test from 'node:test';
import type { FetchFn } from '@solana/web3.js';
import { RPC_PROVIDER_IDS } from '../src/domain/rpc-provider.js';
import { assertValidRuntimeRpcHttpEvidence } from '../src/domain/rpc-http-evidence.js';
import { createRpcHttpRoleEvidenceRecorder } from '../src/solana/rpc/rpc-http-role-evidence.js';
import {
  createObservedRpcFetch,
  createRpcHttpEvidenceRecorder,
} from '../src/solana/rpc/rpc-http-evidence.js';

void test('role recorder times headers, tracks pending attempts, and releases failures exactly once', () => {
  let now = 100;
  const recorder = createRpcHttpRoleEvidenceRecorder({ now: () => now });
  const first = recorder.begin('primary', 'SOURCE');
  const second = recorder.begin('primary', 'SOURCE');
  const pending = recorder.snapshot().entries[0];
  assert.equal(pending?.attempts, 2);
  assert.equal(pending?.inFlight, 2);
  assert.equal(pending?.maxInFlight, 2);
  now = 150;
  first(429);
  first(429);
  second(null);
  const finished = recorder.snapshot();
  assert.deepEqual(finished.entries[0], {
    providerId: 'primary', role: 'SOURCE', attempts: 2, responses: 1,
    http429Responses: 1, failures: 1, inFlight: 0, maxInFlight: 2,
    headerLatencyBuckets: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], maxHeaderLatencyMs: 50,
  });
  assert.equal(finished.entries[3]?.attempts, 0);
  assert.equal(Object.isFrozen(finished.entries[0]?.headerLatencyBuckets), true);
});

void test('role recorder marks invalid and saturated durations as overflow without raw values', () => {
  let now = 0;
  const recorder = createRpcHttpRoleEvidenceRecorder({ now: () => now });
  const invalid = recorder.begin('primary', 'SOURCE');
  now = Number.NaN;
  invalid(200);
  const afterInvalid = recorder.snapshot();
  assert.equal(afterInvalid.overflowed, true);
  assert.equal(afterInvalid.entries[0]?.responses, 1);
  assert.equal(afterInvalid.entries[0]?.inFlight, 0);
  assert.equal(Number.isSafeInteger(afterInvalid.entries[0]?.maxHeaderLatencyMs), true);
  now = 0;
  const huge = recorder.begin('primary', 'SOURCE');
  now = Number.MAX_SAFE_INTEGER + 1;
  huge(200);
  const afterHuge = recorder.snapshot();
  assert.equal(afterHuge.overflowed, true);
  assert.equal(afterHuge.entries[0]?.maxHeaderLatencyMs, 0);
});

void test('role recorder assigns all ten fixed latency bucket boundaries', () => {
  let now = 0;
  const recorder = createRpcHttpRoleEvidenceRecorder({ now: () => now });
  for (const duration of [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 30001]) {
    const finish = recorder.begin('primary', 'SOURCE');
    now += duration;
    finish(200);
  }
  const cell = recorder.snapshot().entries[0];
  assert.deepEqual(cell?.headerLatencyBuckets, Array<number>(10).fill(1));
  assert.equal(cell?.maxHeaderLatencyMs, 30001);
});

void test('observed fetch releases an aborted rejection and ignores throwing role hooks', async () => {
  const roles = createRpcHttpRoleEvidenceRecorder({ now: () => 0 });
  const controller = new AbortController();
  const abortError = new DOMException('cancelled', 'AbortError');
  const observed = createObservedRpcFetch('primary', undefined, async (_input, init) => (
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(abortError); }, { once: true });
    })
  ), roles, 'SOURCE');
  const pending = observed('https://rpc.example.invalid', { signal: controller.signal });
  assert.equal(roles.snapshot().entries[0]?.inFlight, 1);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error === abortError);
  assert.equal(roles.snapshot().entries[0]?.failures, 1);
  assert.equal(roles.snapshot().entries[0]?.inFlight, 0);

  const response = new Response(null, { status: 200 });
  const hostileRoles = { begin: () => { throw new Error('instrumentation'); }, snapshot: () => roles.snapshot() };
  const safe = createObservedRpcFetch('primary', undefined, async () => response, hostileRoles, 'SOURCE');
  assert.strictEqual(await safe('https://rpc.example.invalid'), response);
});

void test('observed fetch attributes a pending and completed physical attempt to its explicit role', async () => {
  let now = 0;
  const roles = createRpcHttpRoleEvidenceRecorder({ now: () => now });
  const legacy = createRpcHttpEvidenceRecorder();
  let resolve!: (response: Response) => void;
  const observed = createObservedRpcFetch('primary', legacy, () => new Promise<Response>((done) => {
    resolve = done;
  }), roles, 'FINALITY');
  const pending = observed('https://rpc.example.invalid');
  assert.equal(roles.snapshot().entries[1]?.inFlight, 1);
  now = 101;
  resolve(new Response(null, { status: 429 }));
  assert.equal((await pending).status, 429);
  assert.equal(roles.snapshot().entries[1]?.headerLatencyBuckets[2], 1);
  assert.equal(roles.snapshot().entries[1]?.inFlight, 0);
  assert.deepEqual(legacy.snapshot(['primary']).providers[0], {
    providerId: 'primary', configured: true, attempts: 1, http429Responses: 1,
  });
});

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
