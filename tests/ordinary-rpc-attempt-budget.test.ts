import assert from 'node:assert/strict';
import test from 'node:test';
import { OrdinaryRpcAttemptBudget, OrdinaryRpcBudgetError } from '../src/solana/rpc/ordinary-rpc-attempt-budget.js';
import { ordinaryRpcAdmissionFixture } from './helpers/ordinary-rpc-admission-fixture.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { createObservedRpcFetch, createRpcHttpEvidenceRecorder } from '../src/solana/rpc/rpc-http-evidence.js';
import { createRpcHttpRoleEvidenceRecorder } from '../src/solana/rpc/rpc-http-role-evidence.js';
import { createSolanaConnectionConfig } from '../src/solana/rpc/rpc-client.js';
import { parseConfig } from '../src/config/env.js';
import { createRpcProviderCatalog } from '../src/solana/rpc/rpc-provider-catalog.js';
import { createProviderPinnedCatchUpSource } from '../src/solana/rpc/provider-pinned-catch-up-source.js';
import { createProviderPinnedFinalityPass } from '../src/solana/rpc/provider-pinned-finality-source.js';
import { createProviderPinnedBlockRpc } from '../src/solana/rpc/provider-pinned-block-rpc.js';
import { readFile } from 'node:fs/promises';
import { createRpcHttpFailoverFetch, type RpcHttpFailoverEvent } from '../src/solana/rpc/http-failover-transport.js';

function clock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    schedule(callback: () => void, delay: number): number {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    cancel(handle: unknown): void { timers.delete(handle as number); },
    advance(value: number): void {
      now = value;
      for (const [id, timer] of timers) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    timers,
  };
}

void test('admits at most eight physical attempts in a rolling second, preserving FIFO', async () => {
  const time = clock();
  const budget = new OrdinaryRpcAttemptBudget(time);
  const starts: { id: number; at: number }[] = [];
  const run = (id: number) => budget.run(() => {
    starts.push({ id, at: time.now() });
    return Promise.resolve(id);
  });
  await Promise.all(Array.from({ length: 4 }, (_, i) => run(i)));
  time.advance(500);
  const results = Array.from({ length: 12 }, (_, i) => run(i + 4));
  assert.equal(starts.length, 8);
  time.advance(999);
  assert.equal(starts.length, 8);
  time.advance(1000);
  assert.equal(starts.length, 12);
  time.advance(1499);
  assert.equal(starts.length, 12);
  time.advance(1500);
  assert.deepEqual(await Promise.all(results), Array.from({ length: 12 }, (_, i) => i + 4));
  assert.deepEqual(starts.map(({ id }) => id), Array.from({ length: 16 }, (_, i) => i));
  for (const start of starts) {
    assert.ok(starts.filter(({ at }) => at > start.at - 1000 && at <= start.at).length <= 8);
  }
  assert.equal(time.timers.size, 0);
});

void test('bounds waiters, removes aborted requests without spending tokens, and closes idempotently', async () => {
  const time = clock();
  const budget = new OrdinaryRpcAttemptBudget(time);
  await Promise.all(Array.from({ length: 8 }, () => budget.run(() => Promise.resolve())));
  let attempts = 0;
  const controller = new AbortController();
  const canceled = budget.run(() => { attempts += 1; return Promise.resolve(); }, controller.signal);
  const canceledCheck = assert.rejects(canceled, { name: 'AbortError' });
  const queued = Array.from({ length: 63 }, () => budget.run(() => {
    attempts += 1;
    return Promise.resolve();
  }));
  const checks = queued.map((result) => assert.rejects(result, { code: 'RPC_ORDINARY_BUDGET_CLOSED' }));
  await assert.rejects(budget.run(() => Promise.resolve()), { code: 'RPC_ORDINARY_BUDGET_FULL' });
  controller.abort();
  await canceledCheck;
  const replacement = budget.run(() => Promise.resolve());
  const replacementCheck = assert.rejects(replacement, { code: 'RPC_ORDINARY_BUDGET_CLOSED' });
  budget.close();
  budget.close();
  await Promise.all([...checks, replacementCheck]);
  await assert.rejects(budget.run(() => Promise.resolve()), { code: 'RPC_ORDINARY_BUDGET_CLOSED' });
  time.advance(1000);
  assert.equal(attempts, 0);
  assert.equal(time.timers.size, 0);
});

void test('pre-aborted and queued cancellation consume no attempt; failed physical fetches do consume one', async () => {
  const time = clock();
  const budget = new OrdinaryRpcAttemptBudget(time);
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;
  const fetch = () => { attempts += 1; return Promise.resolve(); };
  await assert.rejects(budget.run(fetch, controller.signal), { name: 'AbortError' });
  await assert.rejects(budget.run(() => { throw new Error('network'); }), /network/u);
  await Promise.all(Array.from({ length: 7 }, () => budget.run(fetch)));
  const waitingController = new AbortController();
  const canceledCheck = assert.rejects(budget.run(fetch, waitingController.signal), { name: 'AbortError' });
  waitingController.abort();
  await canceledCheck;
  const next = budget.run(fetch);
  time.advance(1000);
  await next;
  await Promise.all(Array.from({ length: 7 }, () => budget.run(fetch)));
  assert.equal(attempts, 15);
  budget.close();
});

const connectionConfig = {
  httpRpcUrl: 'https://primary.invalid/rpc', httpRpcFallbackUrls: [] as string[],
  wsRpcUrl: 'wss://primary.invalid/rpc', commitment: 'confirmed' as const,
};

void test('ordinary attempt budget is OFF by default and requires an explicit canonical boolean', () => {
  const base = { LISTENER_ENABLED: 'false', SOLANA_HTTP_RPC_URL: connectionConfig.httpRpcUrl,
    SOLANA_WS_RPC_URL: connectionConfig.wsRpcUrl };
  assert.equal(parseConfig(base).listenerOrdinaryRpcBudgetEnabled, false);
  assert.equal(parseConfig({ ...base, LISTENER_ORDINARY_RPC_BUDGET_ENABLED: 'true' }).listenerOrdinaryRpcBudgetEnabled, true);
  for (const value of ['', '1', 'TRUE', ' true ']) {
    assert.throws(() => parseConfig({ ...base, LISTENER_ORDINARY_RPC_BUDGET_ENABLED: value }));
  }
});

void test('every shared-client retry charges the same budget and records evidence only after admission', async () => {
  const time = clock();
  const budget = new OrdinaryRpcAttemptBudget(time);
  const recorder = createRpcHttpEvidenceRecorder();
  const roles = createRpcHttpRoleEvidenceRecorder({ now: time.now });
  let calls = 0;
  const config = createSolanaConnectionConfig({ ...connectionConfig,
    httpRpcFallbackUrls: ['https://fallback.invalid/rpc'],
  }, {
    attemptBudget: budget, recorder, roleRecorder: roles,
    fetch: async () => { calls += 1; return new Response(null, { status: calls === 1 ? 503 : 200 }); },
  });
  assert.ok(config.fetch);
  await Promise.all(Array.from({ length: 7 }, () => budget.run(() => Promise.resolve())));
  const request = config.fetch(connectionConfig.httpRpcUrl);
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(calls, 1);
  assert.equal(recorder.snapshot(['primary', 'fallback-1']).providers[1]?.attempts, 0);
  assert.equal(roles.snapshot().entries[7]?.attempts, 0);
  time.advance(1000);
  assert.equal((await request).status, 200);
  assert.equal(calls, 2);
  assert.equal(recorder.snapshot(['primary', 'fallback-1']).providers[1]?.attempts, 1);
  budget.close();
});

void test('a mono-endpoint deadline includes queue time without an evidence attempt or physical fetch', async () => {
  const budget = new OrdinaryRpcAttemptBudget();
  const recorder = createRpcHttpEvidenceRecorder();
  const roles = createRpcHttpRoleEvidenceRecorder();
  await Promise.all(Array.from({ length: 8 }, () => budget.run(() => Promise.resolve())));
  let calls = 0;
  const config = createSolanaConnectionConfig(connectionConfig, {
    attemptBudget: budget, recorder, roleRecorder: roles, requestTimeoutMs: 5,
    fetch: async () => { calls += 1; return new Response(null, { status: 200 }); },
  });
  assert.ok(config.fetch);
  try {
    await assert.rejects(config.fetch(connectionConfig.httpRpcUrl), { name: 'TimeoutError' });
    assert.equal(calls, 0);
    assert.equal(recorder.snapshot(['primary']).providers[0]?.attempts, 0);
    assert.equal(roles.snapshot().entries[3]?.attempts, 0);
  } finally { budget.close(); }
});

void test('observed roles share FIFO admission; cancellation preserves capacity and excludes queue latency', async () => {
  const time = clock();
  const budget = new OrdinaryRpcAttemptBudget(time);
  const recorder = createRpcHttpEvidenceRecorder();
  const roles = createRpcHttpRoleEvidenceRecorder({ now: time.now });
  await Promise.all(Array.from({ length: 8 }, () => budget.run(() => Promise.resolve())));
  const starts: string[] = [];
  const requests = (['SOURCE', 'FINALITY', 'BLOCK_HYDRATION', 'SHARED_CLIENT'] as const).map((role) => (
    createObservedRpcFetch('primary', recorder, async () => {
      starts.push(role);
      return new Response(null, { status: 200 });
    }, roles, role, budget)('https://primary.invalid/rpc')
  ));
  assert.deepEqual(starts, []);
  assert.equal(recorder.snapshot(['primary']).providers[0]?.attempts, 0);
  time.advance(1000);
  await Promise.all(requests);
  assert.deepEqual(starts, ['SOURCE', 'FINALITY', 'BLOCK_HYDRATION', 'SHARED_CLIENT']);
  assert.ok(roles.snapshot().entries.slice(0, 4).every((entry) => entry.attempts === 1 && entry.maxHeaderLatencyMs === 0));
  budget.close();
});

void test('pinned source, finality and block reads share admission with primary and never switch providers', async (context) => {
  const time = clock();
  const budget = new OrdinaryRpcAttemptBudget(time);
  const recorder = createRpcHttpEvidenceRecorder();
  const roles = createRpcHttpRoleEvidenceRecorder({ now: time.now });
  const catalog = createRpcProviderCatalog({ ...connectionConfig,
    httpRpcFallbackUrls: ['https://fallback.invalid/rpc'], wsRpcFallbackUrls: ['wss://fallback.invalid/rpc'],
  });
  const calls: string[] = [];
  context.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    calls.push(String(input));
    assert.equal(typeof init?.body, 'string');
    const request = JSON.parse(init?.body as string) as { id: string | number; method: string };
    const result = request.method === 'getGenesisHash' ? '11111111111111111111111111111111'
      : request.method === 'getSlot' ? 1
        : { blockhash: '11111111111111111111111111111111', previousBlockhash: '11111111111111111111111111111111',
          parentSlot: 0, blockTime: null, blockHeight: null, transactions: [] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 });
  });
  const source = createProviderPinnedCatchUpSource(catalog, 'fallback-1', 'confirmed',
    '11111111111111111111111111111111', undefined, recorder, roles, budget);
  const finality = createProviderPinnedFinalityPass(catalog, 'fallback-1', undefined, recorder, roles, budget);
  const block = createProviderPinnedBlockRpc(catalog, 'fallback-1', 'confirmed', undefined,
    { requestTimeoutMs: 30_000 }, recorder, roles, budget);
  const primary = createSolanaConnectionConfig(connectionConfig, { attemptBudget: budget, recorder, roleRecorder: roles });
  assert.ok(primary.fetch);
  await Promise.all(Array.from({ length: 8 }, () => budget.run(() => Promise.resolve())));
  const requests = [source.verifyGenesis(), finality.getFinalizedSlot(), block.getBlockTransactions(1n, 'FINALIZED'),
    primary.fetch(connectionConfig.httpRpcUrl, { body: JSON.stringify({ id: 1, method: 'getSlot' }) })];
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.deepEqual(calls, []);
  assert.ok(recorder.snapshot(['primary', 'fallback-1']).providers.every((entry) => entry.attempts === 0));
  time.advance(1000);
  await Promise.all(requests);
  assert.equal(calls.length, 4);
  assert.equal(calls.filter((url) => url === 'https://fallback.invalid/rpc').length, 3);
  assert.equal(recorder.snapshot(['primary', 'fallback-1']).providers[0]?.attempts, 1);
  assert.equal(recorder.snapshot(['primary', 'fallback-1']).providers[1]?.attempts, 3);
  budget.close();
});

void test('production creates one opt-in budget, injects every role, and closes it before runtime cleanup', async () => {
  const source = await readFile(new URL('../src/application/production-listener-factory.ts', import.meta.url), 'utf8');
  assert.match(source, /config\.listenerOrdinaryRpcBudgetEnabled\s*\? new OrdinaryRpcAttemptBudget\(\) : undefined/u);
  assert.equal(source.match(/new OrdinaryRpcAttemptBudget\(/gu)?.length, 1);
  assert.match(source, /createProviderPinnedFinalityPass\([^;]+attemptBudget/u);
  assert.match(source, /createProviderPinnedBlockRpc\([^;]+attemptBudget/u);
  assert.match(source, /createProviderPinnedCatchUpSource\([^;]+attemptBudget/u);
  assert.match(source, /attemptBudget[\s\S]+close\(\): Promise<void>\s*\{\s*attemptBudget\.close\(\);\s*return runtime\.close\(\)/u);
});

void test('failover queue timeout and closed admission never degrade providers or record attempts', async () => {
  for (const closed of [false, true]) {
    const budget = new OrdinaryRpcAttemptBudget();
    const recorder = createRpcHttpEvidenceRecorder();
    const roles = createRpcHttpRoleEvidenceRecorder();
    const events: RpcHttpFailoverEvent[] = [];
    let calls = 0;
    await Promise.all(Array.from({ length: 8 }, () => budget.run(() => Promise.resolve())));
    if (closed) budget.close();
    const config = createSolanaConnectionConfig({ ...connectionConfig,
      httpRpcFallbackUrls: ['https://fallback.invalid/rpc'],
    }, {
      attemptBudget: budget, recorder, roleRecorder: roles, requestTimeoutMs: 5,
      onHttpFailoverEvent: (event) => { events.push(event); },
      fetch: async () => { calls += 1; return new Response(null, { status: 200 }); },
    });
    assert.ok(config.fetch);
    try {
      await assert.rejects(config.fetch(connectionConfig.httpRpcUrl), closed
        ? { code: 'RPC_ORDINARY_BUDGET_CLOSED' } : { name: 'TimeoutError' });
      assert.equal(calls, 0);
      assert.deepEqual(events, []);
      assert.ok(recorder.snapshot(['primary', 'fallback-1']).providers.every((entry) => entry.attempts === 0));
      assert.ok(roles.snapshot().entries.every((entry) => entry.attempts === 0 && entry.inFlight === 0));
    } finally { budget.close(); }
  }
});

void test('each pinned role includes queued admission in its deadline without recording a physical attempt', async (context) => {
  const budget = new OrdinaryRpcAttemptBudget();
  const recorder = createRpcHttpEvidenceRecorder();
  const roles = createRpcHttpRoleEvidenceRecorder();
  const catalog = createRpcProviderCatalog({ ...connectionConfig, wsRpcFallbackUrls: [] });
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    throw new Error('No request should reach fetch.');
  });
  const source = createProviderPinnedCatchUpSource(catalog, 'primary', 'confirmed',
    '11111111111111111111111111111111', undefined, recorder, roles, budget, 5);
  const finality = createProviderPinnedFinalityPass(catalog, 'primary', undefined, recorder, roles, budget, 5);
  const block = createProviderPinnedBlockRpc(catalog, 'primary', 'confirmed', undefined,
    { requestTimeoutMs: 5 }, recorder, roles, budget);
  await Promise.all(Array.from({ length: 8 }, () => budget.run(() => Promise.resolve())));
  try {
    await Promise.all([
      assert.rejects(source.verifyGenesis(), { reason: 'GENESIS_UNAVAILABLE' }),
      assert.rejects(finality.getFinalizedSlot(), { reason: 'ROOT_UNAVAILABLE' }),
      assert.rejects(block.getBlockTransactions(1n, 'CONFIRMED'), { reason: 'BLOCK_UNAVAILABLE' }),
    ]);
    assert.equal(calls, 0);
    assert.equal(recorder.snapshot(['primary']).providers[0]?.attempts, 0);
    assert.ok(roles.snapshot().entries.every((entry) => entry.attempts === 0 && entry.inFlight === 0));
  } finally { budget.close(); }
});

void test('ordinary queue normalizes primitive abort reasons for the SDK without admitting them', async () => {
  const budget = new OrdinaryRpcAttemptBudget(clock());
  const controller = new AbortController();
  let calls = 0;
  await Promise.all(Array.from({ length: 8 }, () => budget.run(() => Promise.resolve())));
  const check = assert.rejects(budget.run(() => { calls += 1; return Promise.resolve(); }, controller.signal),
    { name: 'AbortError' });
  controller.abort('primitive');
  await check;
  assert.equal(calls, 0);
  budget.close();
});

void test('failover rejects an invalid injected budget before any request', () => {
  assert.throws(() => createRpcHttpFailoverFetch({
    endpoints: [{ id: 'primary', url: connectionConfig.httpRpcUrl },
      { id: 'fallback-1', url: 'https://fallback.invalid/rpc' }],
    attemptBudget: {} as OrdinaryRpcAttemptBudget,
  }), /attempt budget is invalid/u);
});

void test('normalizes primitive physical fetch rejection into an Error for the SDK', async () => {
  const budget = new OrdinaryRpcAttemptBudget(clock());
  // Deliberately hostile dependency: web3.js cannot complete primitive failures.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  await assert.rejects(budget.run(() => { throw 'primitive rejection'; }), Error);
  await assert.rejects(budget.run(() => new Promise<never>((_resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Deliberately hostile physical dependency.
    reject('primitive rejection');
  })), Error);
  budget.close();
});

void test('local queue-full errors survive real genesis, SDK page, scanner and hydration routing without HTTP evidence', async (context) => {
  const fixture = ordinaryRpcAdmissionFixture(context);
  const local = (error: unknown): boolean => {
    assert.ok(error instanceof OrdinaryRpcBudgetError);
    assert.equal(error.code, 'RPC_ORDINARY_BUDGET_FULL');
    return true;
  };
  try {
    await fixture.saturate();
    await assert.rejects(fixture.source.verifyGenesis(), local);
    assert.deepEqual(fixture.calls, []);
    assert.ok(fixture.recorder.snapshot(['primary', 'fallback-1']).providers.every((value) => value.attempts === 0));
    fixture.release();
    await fixture.source.verifyGenesis();
    await fixture.saturate();
    await assert.rejects(fixture.source.list(PUMP_PROGRAM_ID, undefined, 1), local);
    await assert.rejects(fixture.scanner.scan(new AbortController().signal), local);
    await assert.rejects(fixture.scan(new AbortController().signal), local);
    assert.deepEqual(fixture.calls, ['getGenesisHash']);
    assert.equal(fixture.recorder.snapshot(['primary', 'fallback-1']).providers[0]?.attempts, 1);
    assert.equal(fixture.roles.snapshot().entries[0]?.attempts, 1);
    assert.deepEqual(fixture.durableWrites, []);
  } finally { fixture.close(); }
});
