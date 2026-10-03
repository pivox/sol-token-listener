import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { OrdinaryRpcAttemptBudget } from '../../src/solana/rpc/ordinary-rpc-attempt-budget.js';
import { createRpcHttpEvidenceRecorder } from '../../src/solana/rpc/rpc-http-evidence.js';
import { createRpcHttpRoleEvidenceRecorder } from '../../src/solana/rpc/rpc-http-role-evidence.js';
import { createRpcProviderCatalog } from '../../src/solana/rpc/rpc-provider-catalog.js';
import { createProviderPinnedCatchUpSource } from '../../src/solana/rpc/provider-pinned-catch-up-source.js';
import { StrictCatchUpScanner } from '../../src/application/strict-catch-up-scanner.js';
import { ProviderAffineCatchUpHydration } from '../../src/application/provider-affine-catch-up-hydration.js';
import type { StrictCatchUpRepository } from '../../src/ports/strict-catch-up-repository.js';
import { PUMP_PROGRAM_ID } from '../../src/launchpads/pumpfun/constants.js';

/** Real pinned fetch/SDK/source/scanner/facade; only HTTP and SQL boundaries are replaced. */
export function ordinaryRpcAdmissionFixture(context: TestContext) {
  let now = 0;
  const timers = new Map<object, { at: number; callback: () => void }>();
  const budget = new OrdinaryRpcAttemptBudget({
    now: () => now,
    schedule(callback, delay) {
      const handle = {};
      timers.set(handle, { at: now + delay, callback });
      return handle;
    },
    cancel(handle) { timers.delete(handle as object); },
  });
  const recorder = createRpcHttpEvidenceRecorder();
  const roles = createRpcHttpRoleEvidenceRecorder({ now: () => now });
  const calls: string[] = [];
  context.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    assert.equal(typeof init?.body, 'string');
    const request = JSON.parse(init?.body as string) as { id: string | number; method: string };
    calls.push(request.method);
    assert.ok(['getGenesisHash', 'getSignaturesForAddress'].includes(request.method));
    const result = request.method === 'getGenesisHash' ? '11111111111111111111111111111111' : [];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 });
  });
  const catalog = createRpcProviderCatalog({
    httpRpcUrl: 'https://primary.invalid/rpc', wsRpcUrl: 'wss://primary.invalid/rpc',
    httpRpcFallbackUrls: ['https://fallback.invalid/rpc'], wsRpcFallbackUrls: ['wss://fallback.invalid/rpc'],
  });
  const sources = new Map(catalog.ids.map((id) => [id, createProviderPinnedCatchUpSource(
    catalog, id, 'confirmed', '11111111111111111111111111111111', undefined, recorder, roles, budget,
  )]));
  const source = sources.get('primary');
  assert.ok(source);
  const unexpectedSql = async (): Promise<never> => { throw new Error('Unexpected durable mutation.'); };
  const durableWrites: string[] = [];
  const repository: StrictCatchUpRepository = {
    readCheckpoint: async () => null, readActiveStrictCatchUpRun: async () => null,
    readStrictCatchUpRun: async () => null,
    enqueue: unexpectedSql, compareAndSwapCheckpoint: unexpectedSql,
    recordStrictCatchUpFailure: unexpectedSql,
    resolveStrictCatchUpFailures: async (key) => { durableWrites.push(`resolve:${key}`); },
    createStrictCatchUpRun: unexpectedSql, advanceStrictCatchUpRun: unexpectedSql,
    completeStrictCatchUpRun: unexpectedSql, failStrictCatchUpRun: unexpectedSql,
    supersedeStaleStrictCatchUpRun: unexpectedSql,
  };
  const scanner = new StrictCatchUpScanner(source, repository, {
    pageSize: 1, maxPages: 1, policy: 'strict', now: () => 1000,
    programs: [{ key: 'launchpad', family: 'pumpfun', id: PUMP_PROGRAM_ID }],
  });
  const hydration = new ProviderAffineCatchUpHydration(new Map([['primary', {
    getBlockTransactions: async () => { throw new Error('Unexpected block request.'); },
  }]]), { now: () => now, currentSelection: () => ({ providerId: 'primary', revision: 1n }) });
  const advance = (value: number): void => {
    now = value;
    for (const [handle, timer] of timers) {
      if (timer.at > now) continue;
      timers.delete(handle);
      timer.callback();
    }
  };
  const controllers: AbortController[] = [];
  return {
    budget, recorder, roles, calls, sources, source, scanner, advance, durableWrites,
    async saturate(): Promise<void> {
      advance(now + 1000);
      await Promise.all(Array.from({ length: 8 }, () => budget.run(() => Promise.resolve())));
      for (let index = 0; index < 64; index += 1) {
        const controller = new AbortController();
        controllers.push(controller);
        void budget.run(() => Promise.resolve(), controller.signal).catch(() => undefined);
      }
    },
    release(): void {
      controllers.splice(0).forEach((controller) => { controller.abort(); });
      advance(now + 1000);
    },
    scan: (signal: AbortSignal) => hydration.runStrictScan('primary', (scanSignal) => scanner.scan(scanSignal), signal),
    close(): void { budget.close(); hydration.close(); },
  };
}
