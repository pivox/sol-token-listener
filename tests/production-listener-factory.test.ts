import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseConfig } from '../src/config/env.js';
import type { RuntimeRpcHttpEvidenceV1 } from '../src/domain/rpc-http-evidence.js';
import { RPC_PROVIDER_IDS } from '../src/domain/rpc-provider.js';
import { createFirstProcessingCanaryEvidence, type RuntimeFirstProcessingCanaryEvidenceV1 } from '../src/domain/first-processing-canary.js';
import { createRpcHttpEvidenceRecorder } from '../src/solana/rpc/rpc-http-evidence.js';
import {
  ALL_INGESTION_PROGRAMS,
  LAUNCHPAD_ONLY_INGESTION_PROGRAMS,
  listenerIngestionPrograms,
} from '../src/application/listener-ingestion-programs.js';
import { FinalityReconciler } from '../src/application/finality-reconciler.js';
import { PromotedProviderSelector } from '../src/application/promoted-provider-selector.js';
import type {
  FinalityCandidate,
  FinalityPollObservation,
  FinalityRevision,
  RuntimeHeartbeat,
  RuntimeCatchUpAdmissionMetricsV1,
  InboxCounts,
} from '../src/domain/transaction-ingestion.js';
import type { TokenLaunch } from '../src/domain/types.js';
import type {
  FinalityProviderPass,
  FinalityProviderPassSource,
} from '../src/ports/finality-provider-pass.js';
import { createCatchUpGap } from '../src/domain/transaction-ingestion.js';
import type { getDatabasePool } from '../src/storage/database.js';
import {
  BondingCurveReadUnavailableError,
  ListenerControllerCloseError,
  MAX_LISTENER_TIMER_DELAY_MS,
  PersistentListenerHeartbeat,
  RecurringFinalityReconciler,
  createProductionListenerRuntime,
  catchUpGapLogContext,
  createUnavailableBondingCurveReader,
  createProductionBlockHydration,
  lifecycleComponent,
  type RecurringFinalityOptions,
  type ListenerRuntimeScheduler,
} from '../src/application/production-listener-factory.js';
import { CachedSolanaBlockTransactionLocator } from '../src/solana/rpc/block-transaction-cache.js';
import { SolanaTransactionLocator } from '../src/solana/rpc/transaction-locator.js';
import { ProviderAffineCatchUpHydration } from '../src/application/provider-affine-catch-up-hydration.js';
import { TransactionInboxWorker } from '../src/application/transaction-inbox-worker.js';
import type { ListenerRuntimeDependencies } from '../src/application/listener-runtime.js';

const TEST_GENESIS_HASH = '11111111111111111111111111111111';

void test('heartbeat begins one durable first processing cohort and snapshots fresh evidence for RUNNING and STOPPED writes', async () => {
  const writes: RuntimeHeartbeat[] = [];
  const scheduler = new ManualScheduler();
  const source = firstProcessingCanaryEvidence();
  const callbackEvidence: { sampledAtMs: number }[] = [];
  let begins = 0;
  let aggregateCalls = 0;
  const heartbeat = new PersistentListenerHeartbeat({
    counts: heartbeatCounts,
    async beginFirstProcessingCanary() { begins += 1; return 1_000; },
    async firstProcessingCanary(cohortStartedAtMs) {
      assert.equal(cohortStartedAtMs, 1_000);
      aggregateCalls += 1;
      const evidence = { ...source, sampledAtMs: 946_000 + aggregateCalls } as RuntimeFirstProcessingCanaryEvidenceV1;
      callbackEvidence.push(evidence as unknown as { sampledAtMs: number });
      return evidence;
    },
    async writeHeartbeat(value) { writes.push(value); },
  }, { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
  () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', {
    intervalMs: 5, shutdownTimeoutMs: 100, scheduler,
  });

  await heartbeat.start();
  scheduler.fireScheduled();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  await heartbeat.stop();

  assert.equal(begins, 1);
  assert.equal(aggregateCalls, 3);
  assert.deepEqual(writes.map(({ runtimeState }) => runtimeState), ['RUNNING', 'RUNNING', 'STOPPED']);
  assert.ok(writes.every((write) => write.firstProcessingCanary?.cohortStartedAtMs === 1_000));
  assert.ok(writes.every((write) => Object.isFrozen(write.firstProcessingCanary)));
  assert.notEqual(writes[0]?.firstProcessingCanary, writes[1]?.firstProcessingCanary);
  assert.notEqual(writes[1]?.firstProcessingCanary, writes[2]?.firstProcessingCanary);
  const firstCallbackEvidence = callbackEvidence[0];
  assert.ok(firstCallbackEvidence);
  firstCallbackEvidence.sampledAtMs = 999_999;
  assert.equal(writes[0]?.firstProcessingCanary?.sampledAtMs, 946_001);
});

function firstProcessingCanaryEvidence() {
  return createFirstProcessingCanaryEvidence({
    version: 1, thresholdMs: 45_000, cohortCapacity: 50_000,
    cohortStartedAtMs: 1_000, cohortEndsAtMs: 901_000, sampledAtMs: 946_000,
    overflowed: false, eligibleCount: 0, completedCount: 0, underThresholdCount: 0,
    atOrAboveThresholdCount: 0, pendingCount: 0, rightCensoredCount: 0, tailCensoredCount: 0,
    terminalCount: 0, unavailableCount: 0, invalidDurationCount: 0, p95Ms: null,
    verdict: 'INCONCLUSIVE',
  });
}

function heartbeatCanaryMethods() {
  return Object.freeze({
    async beginFirstProcessingCanary() { return 1_000; },
    async firstProcessingCanary() { return firstProcessingCanaryEvidence(); },
  });
}

void test('heartbeat fails closed for canary initialization or aggregation and initializes safely on stop before start', async () => {
  for (const failure of ['begin', 'aggregate'] as const) {
    let writes = 0;
    const heartbeat = new PersistentListenerHeartbeat({
      counts: heartbeatCounts,
      async beginFirstProcessingCanary() {
        if (failure === 'begin') throw new Error('private canary initialization failure');
        return 1_000;
      },
      async firstProcessingCanary() {
        if (failure === 'aggregate') throw new Error('private canary aggregation failure');
        return firstProcessingCanaryEvidence();
      },
      async writeHeartbeat() { writes += 1; },
    }, { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
    () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', {
      intervalMs: 5, shutdownTimeoutMs: 100, scheduler: new ManualScheduler(),
    });
    await assert.rejects(heartbeat.start());
    assert.equal(writes, 0);
  }

  let begins = 0;
  let aggregates = 0;
  let rpcReads = 0;
  const writes: RuntimeHeartbeat[] = [];
  const heartbeat = new PersistentListenerHeartbeat({
    counts: heartbeatCounts,
    async beginFirstProcessingCanary() { begins += 1; return 1_000; },
    async firstProcessingCanary() { aggregates += 1; return firstProcessingCanaryEvidence(); },
    async writeHeartbeat(value) { writes.push(value); },
  }, {
    async getSlot() { rpcReads += 1; return 10n; },
    async getFinalizedSlot() { rpcReads += 1; return 9n; },
  }, () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', {
    intervalMs: 5, shutdownTimeoutMs: 100, scheduler: new ManualScheduler(),
  });
  await heartbeat.stop();
  assert.equal(begins, 1);
  assert.equal(aggregates, 1);
  assert.equal(rpcReads, 0);
  assert.equal(writes[0]?.runtimeState, 'STOPPED');
  assert.ok((writes[0]?.startedAtMs ?? 0) > 0);
});

void test('heartbeat stop fences the initial RUNNING write before its final STOPPED write', async () => {
  const pendingSlot = deferred<bigint>();
  const writes: string[] = [];
  let slotRead = false;
  const heartbeat = new PersistentListenerHeartbeat({
    ...heartbeatCanaryMethods(),
    counts: heartbeatCounts,
    async writeHeartbeat(value) { writes.push(value.runtimeState); },
  }, {
    async getSlot() { slotRead = true; return pendingSlot.promise; },
    async getFinalizedSlot() { return 9n; },
  }, () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', {
    intervalMs: 5, shutdownTimeoutMs: 100, scheduler: new ManualScheduler(),
  });
  const starting = heartbeat.start();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(slotRead, true);
  const stopping = heartbeat.stop();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.deepEqual(writes, []);
  pendingSlot.resolve(10n);
  await Promise.all([starting, stopping]);
  assert.deepEqual(writes, ['RUNNING', 'STOPPED']);
});

void test('production shares exactly one RPC HTTP recorder across every transport factory and heartbeat', async () => {
  const source = await readFile(new URL('../src/application/production-listener-factory.ts', import.meta.url), 'utf8');
  assert.equal(count(source, /createRpcHttpEvidenceRecorder\(\)/gu), 1);
  assert.match(source, /new SolanaRpcClient\(config,\s*\{\s*recorder,/u);
  assert.match(source, /createProviderPinnedFinalityPass\(providers, providerId, undefined, recorder\)/u);
  assert.match(source, /createProviderPinnedBlockRpc\(providers, providerId, config\.commitment, undefined,\s*\{\s*requestTimeoutMs:\s*config\.listenerShutdownTimeoutMs,?\s*\}, recorder\)/u);
  assert.match(source, /createProviderPinnedCatchUpSource\(\s*providers,\s*providerId,\s*'confirmed',\s*expectedGenesisHash,\s*undefined,\s*recorder,/u);
  assert.match(source, /rpcHttpEvidenceMetrics:\s*\(\).*?=> recorder\.snapshot\(configuredRpcHttpProviderIds\)/u);
  for (const name of ['createProviderPinnedFinalityPass', 'createProviderPinnedBlockRpc', 'createProviderPinnedCatchUpSource']) {
    assert.equal(count(source, new RegExp(`${name}\\(`, 'gu')), 1);
  }
  assert.ok(source.indexOf('const recorder =') < source.indexOf('const rpc = new SolanaRpcClient'));
  for (const enabled of [false, true]) {
    const runtime = createProductionListenerRuntime(config({
      LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED: String(enabled),
      LISTENER_BLOCK_HYDRATION_ENABLED: String(enabled),
      LISTENER_INGESTION_SCOPE: 'launchpad-only',
      LISTENER_CATCH_UP_POLICY: 'live-edge',
      SOLANA_HTTP_RPC_FALLBACK_URLS: 'http://127.0.0.1:8898',
      SOLANA_WS_RPC_FALLBACK_URLS: 'ws://127.0.0.1:8897',
    }), inertPool as unknown as ReturnType<typeof getDatabasePool>);
    const dependencies = (runtime as unknown as { dependencies: ListenerRuntimeDependencies }).dependencies;
    const metrics = (dependencies.heartbeat as unknown as { rpcHttpEvidenceMetrics: () => RuntimeRpcHttpEvidenceV1 }).rpcHttpEvidenceMetrics;
    assert.deepEqual(metrics(), createRpcHttpEvidenceRecorder().snapshot(['primary', 'fallback-1']));
    await dependencies.worker.close();
  }
});

void test('RPC HTTP evidence includes an HTTP-only fallback absent from the WebSocket catalog', async () => {
  const runtime = createProductionListenerRuntime(config({
    LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED: 'false',
    LISTENER_BLOCK_HYDRATION_ENABLED: 'false',
    LISTENER_INGESTION_SCOPE: 'launchpad-only',
    LISTENER_CATCH_UP_POLICY: 'live-edge',
    SOLANA_HTTP_RPC_FALLBACK_URLS: 'http://127.0.0.1:8898',
  }), inertPool as unknown as ReturnType<typeof getDatabasePool>);
  const dependencies = (runtime as unknown as { dependencies: ListenerRuntimeDependencies }).dependencies;
  const metrics = (dependencies.heartbeat as unknown as {
    rpcHttpEvidenceMetrics: () => RuntimeRpcHttpEvidenceV1;
  }).rpcHttpEvidenceMetrics;

  assert.deepEqual(metrics(), createRpcHttpEvidenceRecorder().snapshot(['primary', 'fallback-1']));
  await dependencies.worker.close();
});

void test('heartbeat detaches and freezes fresh RPC HTTP evidence for every RUNNING and STOPPED write', async () => {
  const owned = { version: 1 as const, overflowed: false,
    providers: RPC_PROVIDER_IDS.map((providerId) => ({ providerId, configured: providerId === 'primary', attempts: 0, http429Responses: 0 })),
  };
  const writes: RuntimeHeartbeat[] = [];
  const primary = owned.providers[0];
  assert.ok(primary);
  let callbacks = 0;
  const scheduler = new ManualScheduler();
  const heartbeat = new PersistentListenerHeartbeat({
    ...heartbeatCanaryMethods(),
    counts: heartbeatCounts,
    async writeHeartbeat(value) { writes.push(value); },
  }, { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
  () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', {
    intervalMs: 5, shutdownTimeoutMs: 100, scheduler,
    rpcHttpEvidenceMetrics: () => {
      callbacks += 1;
      primary.attempts = callbacks;
      return owned as unknown as RuntimeRpcHttpEvidenceV1;
    },
  });
  await heartbeat.start();
  scheduler.fireScheduled();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  await heartbeat.stop();
  assert.equal(callbacks, 3);
  assert.deepEqual(writes.map(({ runtimeState }) => runtimeState), ['RUNNING', 'RUNNING', 'STOPPED']);
  for (const [index, write] of writes.entries()) {
    const evidence = write.rpcHttpEvidence;
    assert.ok(evidence);
    assert.deepEqual(Object.keys(evidence), ['version', 'overflowed', 'providers']);
    assert.deepEqual(evidence.providers.map(({ providerId }) => providerId), RPC_PROVIDER_IDS);
    assert.notEqual(evidence, owned);
    assert.notEqual(evidence.providers, owned.providers);
    assert.ok(Object.isFrozen(evidence));
    assert.ok(Object.isFrozen(evidence.providers));
    for (const [providerIndex, provider] of evidence.providers.entries()) {
      assert.deepEqual(Object.keys(provider), ['providerId', 'configured', 'attempts', 'http429Responses']);
      assert.ok(Object.isFrozen(provider));
      assert.notEqual(provider, owned.providers[providerIndex]);
    }
    assert.equal(evidence.providers[0].attempts, index + 1);
  }
  primary.attempts = 100;
  assert.equal(writes[0]?.rpcHttpEvidence?.providers[0].attempts, 1);
});

void test('heartbeat RPC HTTP evidence omission remains absent from both writes', async () => {
  const writes: RuntimeHeartbeat[] = [];
  const heartbeat = new PersistentListenerHeartbeat({ counts: heartbeatCounts,
    ...heartbeatCanaryMethods(),
    async writeHeartbeat(value) { writes.push(value); },
  }, { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
  () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', {
    intervalMs: 5, shutdownTimeoutMs: 100, scheduler: new ManualScheduler(),
  });
  await heartbeat.start();
  await heartbeat.stop();
  assert.equal(writes.length, 2);
  assert.ok(writes.every((write) => !Object.hasOwn(write, 'rpcHttpEvidence')));
});

void test('heartbeat fails closed and redacts malformed or throwing RPC HTTP callbacks at RUNNING and STOPPED', async () => {
  const valid = createRpcHttpEvidenceRecorder().snapshot(['primary']);
  for (const invalid of [undefined, null, { ...valid, secret: 'private-secret' }, new Proxy(valid, {})]) {
    for (const failsOnStop of [false, true]) {
      let writes = 0;
      let invalidNow = !failsOnStop;
      const heartbeat = new PersistentListenerHeartbeat({ counts: heartbeatCounts,
        ...heartbeatCanaryMethods(),
        async writeHeartbeat() { writes += 1; },
      }, { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
      () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', {
        intervalMs: 5, shutdownTimeoutMs: 100, scheduler: new ManualScheduler(),
        rpcHttpEvidenceMetrics: () => (invalidNow ? invalid : valid) as unknown as RuntimeRpcHttpEvidenceV1,
      });
      if (failsOnStop) { await heartbeat.start(); invalidNow = true; }
      await assert.rejects(failsOnStop ? heartbeat.stop() : heartbeat.start(), (error: unknown) => {
        assert.ok(error instanceof (failsOnStop ? ListenerControllerCloseError : TypeError));
        assert.doesNotMatch(String(error), /private-secret/u);
        return true;
      });
      assert.equal(writes, failsOnStop ? 1 : 0);
    }
  }
  const heartbeat = new PersistentListenerHeartbeat({ counts: heartbeatCounts,
    ...heartbeatCanaryMethods(),
    async writeHeartbeat() { assert.fail('Invalid evidence must not be written.'); },
  }, { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
  () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', {
    intervalMs: 5, shutdownTimeoutMs: 100, scheduler: new ManualScheduler(),
    rpcHttpEvidenceMetrics: () => { throw new Error('private-secret'); },
  });
  await assert.rejects(heartbeat.start(), (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.doesNotMatch(String(error), /private-secret/u);
    return true;
  });
});

function admissionCounts(backlog = 0) {
  return Object.freeze({
    actionableBacklogBySource: Object.freeze({ websocketOnly: backlog, catchUpOnly: 0, websocketAndCatchUp: 0 }),
    actionableBacklogByPriority: Object.freeze({ normal: backlog, launchCandidate: 0, trackedTrade: 0 }),
    deferredCount: 0, ignoredCount: 0, quarantinedCount: 0,
  });
}

void test('catch-up admission flag off creates no provider-affine locators and retains market ingestion', async (context) => {
  const classifiers = context.mock.method(ProviderAffineCatchUpHydration.prototype, 'classifierLocator');
  const workers = context.mock.method(ProviderAffineCatchUpHydration.prototype, 'workerLocator');
  const starts = context.mock.method(TransactionInboxWorker.prototype, 'start', async () => undefined);
  for (const blockHydrationEnabled of ['false', 'true']) {
    const runtime = createProductionListenerRuntime(config({
      LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED: 'false',
      LISTENER_BLOCK_HYDRATION_ENABLED: blockHydrationEnabled,
      LISTENER_INGESTION_SCOPE: 'launchpad-and-market',
    }), inertPool as unknown as ReturnType<typeof getDatabasePool>);
    const dependencies = (runtime as unknown as { dependencies: ListenerRuntimeDependencies }).dependencies;
    assert.equal((dependencies.heartbeat as unknown as { catchUpAdmissionMetrics: unknown }).catchUpAdmissionMetrics, null);
    await dependencies.worker.start();
    const worker = starts.mock.calls.at(-1)?.this as unknown as { locator: unknown; canClaim: unknown };
    assert.ok(worker.locator instanceof (blockHydrationEnabled === 'true'
      ? CachedSolanaBlockTransactionLocator : SolanaTransactionLocator));
    assert.equal(worker.canClaim, null);
    assert.equal(runtime.pipelineState().pumpswap, 'STOPPED');
    await dependencies.worker.close();
  }
  assert.equal(classifiers.mock.callCount(), 0);
  assert.equal(workers.mock.callCount(), 0);
});

void test('catch-up admission uses one provider-affine coordinator for each catalog provider and gates worker claims', async (context) => {
  const classifiers = context.mock.method(ProviderAffineCatchUpHydration.prototype, 'classifierLocator');
  const workers = context.mock.method(ProviderAffineCatchUpHydration.prototype, 'workerLocator');
  const starts = context.mock.method(TransactionInboxWorker.prototype, 'start', async () => undefined);
  const runtime = createProductionListenerRuntime(config({
    LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED: 'true',
    LISTENER_BLOCK_HYDRATION_ENABLED: 'true',
    LISTENER_INGESTION_SCOPE: 'launchpad-only',
    LISTENER_CATCH_UP_POLICY: 'live-edge',
    SOLANA_HTTP_RPC_FALLBACK_URLS: 'http://127.0.0.1:8898',
    SOLANA_WS_RPC_FALLBACK_URLS: 'ws://127.0.0.1:8897',
  }), inertPool as unknown as ReturnType<typeof getDatabasePool>);
  assert.deepEqual(classifiers.mock.calls.map(({ arguments: args }) => args[0]), ['primary', 'fallback-1']);
  assert.equal(workers.mock.callCount(), 1);
  const hydration = workers.mock.calls[0]?.this;
  assert.ok(hydration instanceof ProviderAffineCatchUpHydration);
  assert.ok(classifiers.mock.calls.every((call) => call.this === hydration));
  const dependencies = (runtime as unknown as { dependencies: ListenerRuntimeDependencies }).dependencies;
  const metrics = (dependencies.heartbeat as unknown as {
    catchUpAdmissionMetrics: (counts: InboxCounts) => RuntimeCatchUpAdmissionMetricsV1;
  }).catchUpAdmissionMetrics;
  assert.deepEqual(metrics(await heartbeatCounts()), {
    version: 1, enabled: true, providerId: null, scanActive: false, workerClaimReady: false,
    ...admissionCounts(1),
  });
  await dependencies.worker.start();
  const worker = starts.mock.calls[0]?.this as unknown as {
    locator: unknown; canClaim: () => boolean; runOnce: () => Promise<unknown>;
  };
  assert.equal(worker.locator, workers.mock.calls[0]?.result);
  assert.equal(worker.canClaim(), false);
  assert.deepEqual(await worker.runOnce(), { kind: 'idle' });
  assert.equal(runtime.pipelineState().pumpswap, 'IDLE');
  await dependencies.worker.close();
  assert.equal(hydration.canWorkerClaim(), false);
});

void test('catch-up admission wires identical provider admitters into both scanner paths and pins scan permits', async () => {
  const source = await readFile(new URL('../src/application/production-listener-factory.ts', import.meta.url), 'utf8');
  assert.match(source, /config\.listenerPumpFunCatchUpPageAdmissionEnabled/u);
  assert.match(source, /config\.listenerPumpFunCatchUpCoverageFastPathEnabled/u);
  assert.match(source, /coverageRepository:[^\n]*\? inbox : null/u);
  assert.equal(count(source, /new ProviderAffineCatchUpHydration\(/gu), 1);
  assert.equal(count(source, /new PumpFunCatchUpBlockClassifier\(/gu), 1);
  assert.equal(count(source, /new PumpFunStrictCatchUpPageAdmitter\(/gu), 1);
  assert.match(source, /providers\.ids\.map\([\s\S]*?createProviderPinnedBlockRpc\(providers, providerId,/u);
  assert.match(source, /requestTimeoutMs:\s*config\.listenerShutdownTimeoutMs/u);
  assert.equal(count(source, /pageAdmitters\.get\(providerId\)/gu), 2);
  assert.match(source, /hydration\.runStrictScan\(providerId,\s*\(scanSignal\) => coordinator\.run\(scanSignal\), signal\)/u);
  assert.match(source, /hydration\.runStrictScan\(providerId,\s*\(scanSignal\) => baselineScanner\.scan\(scanSignal\), signal\)/u);
});

void test('catch-up admission starts worker close then immediately aborts hydration before worker settlement', async (context) => {
  const gate = deferred<undefined>();
  const order: string[] = [];
  context.mock.method(TransactionInboxWorker.prototype, 'close', async () => {
    order.push('worker-start');
    await gate.promise;
    order.push('worker-settled');
    throw new Error('worker cleanup failed');
  });
  context.mock.method(ProviderAffineCatchUpHydration.prototype, 'close', () => { order.push('hydration'); });
  const runtime = createProductionListenerRuntime(config({
    LISTENER_PUMPFUN_CATCH_UP_PAGE_ADMISSION_ENABLED: 'true',
    LISTENER_BLOCK_HYDRATION_ENABLED: 'true',
    LISTENER_INGESTION_SCOPE: 'launchpad-only',
    LISTENER_CATCH_UP_POLICY: 'live-edge',
  }), inertPool as unknown as ReturnType<typeof getDatabasePool>);
  const dependencies = (runtime as unknown as { dependencies: ListenerRuntimeDependencies }).dependencies;
  const closing = dependencies.worker.close();
  assert.deepEqual(order, ['worker-start', 'hydration']);
  gate.resolve(undefined);
  await assert.rejects(closing, /worker cleanup failed/u);
  assert.deepEqual(order, ['worker-start', 'hydration', 'worker-settled']);
});

void test('production block hydration keeps the exact legacy locator unless explicitly enabled', () => {
  const rpc = Object.freeze({
    httpTransportEpoch: 0,
    async getTransaction() { return null; },
    async getBlockSignatures() { return []; },
    async getBlockTransactions() { return null; },
  });
  const disabled = createProductionBlockHydration(parseConfig({
    SOLANA_HTTP_RPC_URL: 'http://127.0.0.1:8899',
    SOLANA_WS_RPC_URL: 'ws://127.0.0.1:8900',
    SOLANA_EXPECTED_GENESIS_HASH: TEST_GENESIS_HASH,
  }), rpc);
  assert.ok(disabled.locator instanceof SolanaTransactionLocator);
  assert.deepEqual(disabled.metrics(), {
    version: 1, enabled: false, callerConcurrency: 1,
    locates: 0, hits: 0, misses: 0, inFlightJoins: 0, fetches: 0,
    forcedRefreshes: 0, evictions: 0, oversizeBypasses: 0, fetchFailures: 0,
    epochInvalidations: 0, retainedEntries: 0, retainedBytes: 0,
    inFlightFetches: 0, queuedFetches: 0,
    queueDelayMs: { last: null, maximum: null },
  });

  const enabled = createProductionBlockHydration(parseConfig({
    SOLANA_HTTP_RPC_URL: 'http://127.0.0.1:8899',
    SOLANA_WS_RPC_URL: 'ws://127.0.0.1:8900',
    SOLANA_EXPECTED_GENESIS_HASH: TEST_GENESIS_HASH,
    LISTENER_BLOCK_HYDRATION_ENABLED: 'true',
  }), rpc);
  assert.ok(enabled.locator instanceof CachedSolanaBlockTransactionLocator);
  assert.equal(enabled.metrics().enabled, true);
  assert.equal(enabled.metrics().callerConcurrency, 1);
  disabled.close();
  enabled.close();
});

void test('worker shutdown closes block hydration before awaiting a stuck worker', async () => {
  const workerClose = deferred<undefined>();
  let cacheClosed = false;
  const component = lifecycleComponent({
    async start() { return undefined; },
    async close() { await workerClose.promise; },
    state: 'RUNNING' as const,
  }, () => { cacheClosed = true; });

  const closing = component.close();
  assert.equal(cacheClosed, true);
  workerClose.resolve(undefined);
  await closing;
});

void test('selects one frozen canonical ingestion program list and rejects unknown scopes', () => {
  assert.equal(listenerIngestionPrograms('launchpad-only'), LAUNCHPAD_ONLY_INGESTION_PROGRAMS);
  assert.equal(listenerIngestionPrograms('launchpad-and-market'), ALL_INGESTION_PROGRAMS);
  assert.ok(Object.isFrozen(LAUNCHPAD_ONLY_INGESTION_PROGRAMS));
  assert.ok(Object.isFrozen(ALL_INGESTION_PROGRAMS));
  assert.throws(
    () => listenerIngestionPrograms('unknown'),
    /ingestion scope is invalid/u,
  );
});

void test('builds a redacted structured live-edge gap warning', () => {
  const gap = createCatchUpGap(
    Object.freeze({ key: 'launchpad', slot: 40n, signature: 'secret-old', updatedAtMs: 1_000 }),
    Object.freeze({ key: 'launchpad', slot: 50n, signature: 'secret-new', updatedAtMs: 2_000 }),
    2_000,
  );

  const context = catchUpGapLogContext(gap, 'live-edge');

  assert.deepEqual(context, {
    event: 'listener.catch_up_gap_recorded',
    program: 'launchpad',
    previousSlot: '40',
    baselineSlot: '50',
    policy: 'live-edge',
  });
  assert.ok(Object.isFrozen(context));
  assert.doesNotMatch(JSON.stringify(context), /secret-old|secret-new/u);
});

void test('composes the passive production listener without opening resources', () => {
  const runtime = createProductionListenerRuntime(
    parseConfig({
      SOLANA_HTTP_RPC_URL: 'http://127.0.0.1:8899',
      SOLANA_WS_RPC_URL: 'ws://127.0.0.1:8900',
      SOLANA_EXPECTED_GENESIS_HASH: TEST_GENESIS_HASH,
    }),
    inertPool as unknown as ReturnType<typeof getDatabasePool>,
  );

  assert.equal(runtime.state(), 'STOPPED');
  assert.deepEqual(runtime.pipelineState(), {
    httpAvailable: true,
    pumpfun: 'STOPPED',
    pumpswap: 'STOPPED',
    qualification: 'STOPPED',
    paperDecision: 'STOPPED',
    social: 'STOPPED',
  });
});

void test('composes launchpad-only ingestion with PumpSwap explicitly idle', () => {
  const runtime = createProductionListenerRuntime(
    parseConfig({
      SOLANA_HTTP_RPC_URL: 'http://127.0.0.1:8899',
      SOLANA_WS_RPC_URL: 'ws://127.0.0.1:8900',
      SOLANA_EXPECTED_GENESIS_HASH: TEST_GENESIS_HASH,
      LISTENER_INGESTION_SCOPE: 'launchpad-only',
    }),
    inertPool as unknown as ReturnType<typeof getDatabasePool>,
  );

  assert.deepEqual(runtime.pipelineState(), {
    httpAvailable: true,
    pumpfun: 'STOPPED',
    pumpswap: 'IDLE',
    qualification: 'STOPPED',
    paperDecision: 'STOPPED',
    social: 'STOPPED',
  });
});

void test('keeps fixed social retention compatible with a different foundation retention', () => {
  const runtime = createProductionListenerRuntime(
    parseConfig({
      SOLANA_HTTP_RPC_URL: 'http://127.0.0.1:8899',
      SOLANA_WS_RPC_URL: 'ws://127.0.0.1:8900',
      SOLANA_EXPECTED_GENESIS_HASH: TEST_GENESIS_HASH,
      DATA_RETENTION_HOURS: '24',
    }),
    inertPool as unknown as ReturnType<typeof getDatabasePool>,
  );

  assert.equal(runtime.state(), 'STOPPED');
});

void test('generic Pump bonding-curve reads fail with a stable redacted error', async () => {
  const reader = createUnavailableBondingCurveReader();

  await assert.rejects(reader.read({} as TokenLaunch), (error: unknown) => {
    assert.ok(error instanceof BondingCurveReadUnavailableError);
    assert.equal(error.name, 'BondingCurveReadUnavailableError');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
});

void test('production factory has no transaction execution or Raydium builder path', async () => {
  const source = await readFile(
    new URL('../src/application/production-listener-factory.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /(?:sendRawTransaction|sendTransaction|transaction-builder|execution\/wallet|\.\.\/execution\/|raydium)/iu);
});

void test('production wires the redacted HTTP RPC failover event sink', async () => {
  const source = await readFile(
    new URL('../src/application/production-listener-factory.ts', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /new SolanaRpcClient\(config,\s*\{\s*recorder,\s*onHttpFailoverEvent: logRpcHttpFailoverEvent,\s*\}\)/u,
  );
  const sink = /function logRpcHttpFailoverEvent\([\s\S]*?\n\}/u.exec(source)?.[0];
  assert.ok(sink);
  assert.match(sink, /logger\.warn\(event, 'Événement de basculement HTTP RPC observé\.'\)/u);
  assert.doesNotMatch(sink, /(?:httpRpcUrl|wsRpcUrl|fallbackUrls|endpointUrl|host|provider|key|cause|error)/iu);
});

void test('production binds finality to immutable passes selected by the promoted provider', async () => {
  const factory = await readFile(
    new URL('../src/application/production-listener-factory.ts', import.meta.url),
    'utf8',
  );
  const pinnedAdapter = await readFile(
    new URL('../src/solana/rpc/provider-pinned-finality-source.ts', import.meta.url),
    'utf8',
  );

  assert.match(factory, /import\s*\{[^}]*\bcreateRpcProviderCatalog\b[^}]*\}\s*from\s*['"]\.\.\/solana\/rpc\/rpc-provider-catalog\.js['"]/u);
  assert.match(factory, /import\s*\{[^}]*\bcreateProviderPinnedFinalityPass\b[^}]*\}\s*from\s*['"]\.\.\/solana\/rpc\/provider-pinned-finality-source\.js['"]/u);
  assert.match(factory, /const providers = createRpcProviderCatalog\(config\);/u);
  assert.match(factory, /providers\.ids\.map\(\(providerId\)[\s\S]*?createProviderPinnedFinalityPass\(providers, providerId, undefined, recorder\)/u);
  assert.match(factory, /new PromotedProviderSelector\(/u);
  assert.match(factory, /new FinalityReconciler\(promoted, inbox,/u);
  assert.match(factory, /initialFailureMode:\s*'DEGRADED_RETRY'/u);
  assert.match(
    factory,
    /currentSelection:\s*\(\): PromotedProviderSelection => promoted\.selection\(\)/u,
  );
  assert.match(
    factory,
    /isReady:\s*\(\): boolean => \{\s*const selection = promoted\.selection\(\);[\s\S]*?reconciler\.isReadyFor\(selection\)/u,
  );
  assert.doesNotMatch(factory, /reconciler\.readyProviderId\(\) === providerId/u);
  assert.doesNotMatch(factory, /new FinalityReconciler\(rpc, inbox,/u);
  assert.doesNotMatch(pinnedAdapter, /http-failover-transport/u);
});

void test('activates the acknowledged WebSocket supervisor and strict provider-pinned recovery', async () => {
  const source = await readFile(
    new URL('../src/application/production-listener-factory.ts', import.meta.url),
    'utf8',
  );

  assertProductionCatchUpWiring(source);
});

void test('rejects a missing genesis before catalog or PostgreSQL construction', () => {
  const accesses: string[] = [];
  const base = parseConfig({
    SOLANA_HTTP_RPC_URL: 'http://127.0.0.1:8899',
    SOLANA_WS_RPC_URL: 'ws://127.0.0.1:8900',
    LISTENER_ENABLED: 'false',
  });
  const hostile = new Proxy(base, {
    get(target, property, receiver) {
      accesses.push(String(property));
      if (property !== 'expectedGenesisHash') throw new Error('later construction was reached');
      return Reflect.get(target, property, receiver);
    },
  });

  assert.throws(
    () => createProductionListenerRuntime(hostile, inertPool as never),
    /SOLANA_EXPECTED_GENESIS_HASH/u,
  );
  assert.deepEqual(accesses, ['expectedGenesisHash']);
});

void test('production source orders the genesis guard before catalog and database acquisition', async () => {
  const source = await readFile(
    new URL('../src/application/production-listener-factory.ts', import.meta.url),
    'utf8',
  );
  const guard = source.indexOf('const expectedGenesisHash');
  const catalog = source.indexOf('createRpcProviderCatalog(config)');
  const database = source.indexOf('getDatabasePool()', guard);
  assert.ok(guard >= 0);
  assert.ok(catalog > guard);
  assert.ok(database > catalog);
});

void test('production composes one canonical qualification writer before paper decisions', async () => {
  const source = await readFile(
    new URL('../src/application/production-listener-factory.ts', import.meta.url),
    'utf8',
  );

  assert.equal(count(source, /new QualificationEngine\(/gu), 1);
  assert.equal(count(source, /loadQualificationProfile\(/gu), 1);
  assert.equal(count(source, /new QualificationRebuildService\(/gu), 1);
  assert.equal(count(source, /new PostgresQualificationProjectionRepository\(/gu), 1);
  assert.equal(count(source, /new QualificationProjectionService\(/gu), 1);
  assert.match(source, /new PostgresQualificationProjectionRepository\(databasePool,\s*qualificationRebuilder\)/u);
  assert.match(source, /new QualificationProjectionService\([\s\S]*?qualificationRebuilder,[\s\S]*?config\.paperQuoteMintAllowlist[\s\S]*?\)/u);
  assert.match(source,/new SocialQualificationRefreshService\(qualification,paperRepository\)/u);
  assert.match(source, /new PaperDecisionWorker\([\s\S]*?quoteRouter,\s*qualificationRebuilder,/u);
  assert.match(source, /new ObservedTransactionPipeline\([\s\S]*?paperRepository,\s*qualification,\s*inbox,\s*\)/u);
});

void test('production injects the worker inbox into the observed pipeline for tracked-mint synchronization', async () => {
  const source = await readFile(
    new URL('../src/application/production-listener-factory.ts', import.meta.url),
    'utf8',
  );

  assert.equal(count(source, /new PostgresTransactionInboxRepository\(/gu), 1);
  assert.match(
    source,
    /const pipeline = new ObservedTransactionPipeline\([\s\S]*?paperRepository,\s*qualification,\s*inbox,\s*\)/u,
  );
});

void test('production selects creation-entry-v1 without adding a second paper pipeline', async () => {
  const source = await readFile(
    new URL('../src/application/production-listener-factory.ts', import.meta.url),
    'utf8',
  );

  assert.equal(count(source, /new PaperDecisionWorker\(/gu), 1);
  assert.equal(count(source, /new CreationEntryV1Strategy\(/gu), 1);
  assert.equal(count(source, /new ValidatedExternalBuysStrategy\(/gu), 1);
  assert.match(source, /createPaperDecisionStrategyRegistry\(\{[\s\S]*?config\.creationStrategyEnabled/u);
  assert.match(source, /externalMinimumBuyAmountRaw/u);
  assert.match(source, /creationTakeProfitMultiplierBps/u);
  assert.match(source, /creationManualKillSwitch/u);
});

void test('public social runtime components have no signer or submission path', async () => {
  for (const path of [
    '../src/application/social-enrichment-worker.ts',
    '../src/application/social-qualification-refresh.service.ts',
    '../src/storage/social-evidence.repository.ts',
    '../src/social/public-social-verification.provider.ts',
  ]) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /(?:sendRawTransaction|sendTransaction|signTransaction|execution\/wallet|\.\.\/execution\/|privateKey|keypair)/iu,
      path,
    );
  }
});

void test('heartbeat stop fences an in-flight RUNNING write before durable STOPPED', async () => {
  const scheduler = new ManualScheduler();
  const periodic = deferred<undefined>();
  const writes: string[] = [];
  let runningWrites = 0;
  const heartbeat = new PersistentListenerHeartbeat(
    {
      ...heartbeatCanaryMethods(),
      async counts() {
        return {
          pending: 0, processing: 0, processed: 0, failed: 0,
          retryableFailed: 0, exhaustedFailed: 0,
          catchUpAdmission: admissionCounts(),
        };
      },
      async writeHeartbeat(value) {
        if (value.runtimeState === 'RUNNING' && ++runningWrites === 2) await periodic.promise;
        writes.push(value.runtimeState);
      },
    },
    { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
    () => 'RUNNING',
    () => 'RUNNING',
    () => 'RUNNING',
    () => 'RUNNING',
    { intervalMs: 5, shutdownTimeoutMs: 100, scheduler },
  );
  await heartbeat.start();
  scheduler.fireScheduled();
  await Promise.resolve();

  let stopped = false;
  const stopping = heartbeat.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.deepEqual(writes, ['RUNNING']);

  periodic.resolve(undefined);
  await stopping;
  assert.deepEqual(writes, ['RUNNING', 'RUNNING', 'STOPPED']);
  assert.equal(heartbeat.state(), 'STOPPED');
  scheduler.fireLastCallbackAgain();
  await Promise.resolve();
  assert.deepEqual(writes, ['RUNNING', 'RUNNING', 'STOPPED']);
});

void test('heartbeat exposes retryable failed work in backlog without leasing it', async () => {
  const writes: {
    readonly backlogCount: number;
    readonly leasedCount: number;
    readonly exhaustedCount: number;
  }[] = [];
  const heartbeat = new PersistentListenerHeartbeat(
    {
      ...heartbeatCanaryMethods(),
      async counts() {
        return {
          pending: 2, processing: 1, processed: 4, failed: 3,
          retryableFailed: 2, exhaustedFailed: 1,
          catchUpAdmission: admissionCounts(5),
        };
      },
      async writeHeartbeat(value) {
        writes.push(value);
      },
    },
    { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
    () => 'RUNNING',
    () => 'RUNNING',
    () => 'RUNNING',
    () => 'RUNNING',
    { intervalMs: 5, shutdownTimeoutMs: 100, scheduler: new ManualScheduler() },
  );

  await heartbeat.start();
  assert.equal(writes[0]?.backlogCount, 5);
  assert.equal(writes[0]?.leasedCount, 1);
  assert.equal(writes[0]?.exhaustedCount, 1);
  await heartbeat.stop();
});

void test('heartbeat publishes one bounded block hydration snapshot without identities', async () => {
  const writes: RuntimeHeartbeat[] = [];
  const metrics = Object.freeze({
    version: 1 as const, enabled: true, callerConcurrency: 1 as const,
    locates: 3, hits: 2, misses: 1, inFlightJoins: 0, fetches: 1,
    forcedRefreshes: 0, evictions: 0, oversizeBypasses: 0, fetchFailures: 0,
    epochInvalidations: 0, retainedEntries: 1, retainedBytes: 1024,
    inFlightFetches: 0, queuedFetches: 0,
    queueDelayMs: Object.freeze({ last: 0, maximum: 0 }),
  });
  const heartbeat = new PersistentListenerHeartbeat(
    {
      ...heartbeatCanaryMethods(),
      async counts() { return { pending: 0, processing: 0, processed: 0, failed: 0, retryableFailed: 0, exhaustedFailed: 0, catchUpAdmission: admissionCounts() }; },
      async writeHeartbeat(value) { writes.push(value); },
    },
    { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
    () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', () => 'RUNNING',
    { intervalMs: 5, shutdownTimeoutMs: 100, blockHydrationMetrics: () => metrics },
  );
  await heartbeat.start();
  await heartbeat.stop();
  assert.deepEqual(writes.map(({ blockHydration }) => blockHydration), [metrics, metrics]);
  assert.doesNotMatch(JSON.stringify(metrics), /signature|slot|https?:|wss?:/iu);
});

void test('heartbeat catch-up admission snapshots use the same count read and remain optional', async () => {
  for (const enabled of [false, true]) {
    const writes: RuntimeHeartbeat[] = [];
    let reads = 0;
    let callbacks = 0;
    const heartbeat = new PersistentListenerHeartbeat({
      ...heartbeatCanaryMethods(),
      async counts() {
        reads += 1;
        return Object.freeze({ pending: reads, processing: 0, processed: 0, failed: 0,
          retryableFailed: 0, exhaustedFailed: 0, catchUpAdmission: admissionCounts(reads) });
      },
      async writeHeartbeat(value) { writes.push(value); },
    }, { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
    () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', {
      intervalMs: 5, shutdownTimeoutMs: 100, scheduler: new ManualScheduler(),
      ...(enabled ? { catchUpAdmissionMetrics: (counts: InboxCounts) => {
        callbacks += 1;
        return Object.freeze({ version: 1 as const, enabled: true, providerId: 'primary' as const,
          scanActive: false, workerClaimReady: true, ...counts.catchUpAdmission });
      } } : {}),
    });
    await heartbeat.start();
    await heartbeat.stop();
    assert.equal(reads, 2);
    assert.equal(callbacks, enabled ? 2 : 0);
    for (const [index, write] of writes.entries()) {
      if (!enabled) { assert.equal(Object.hasOwn(write, 'catchUpAdmission'), false); continue; }
      assert.deepEqual(write.catchUpAdmission, { version: 1, enabled: true, providerId: 'primary',
        scanActive: false, workerClaimReady: true, ...admissionCounts(index + 1) });
      assert.ok(Object.isFrozen(write.catchUpAdmission));
      assert.ok(Object.isFrozen(write.catchUpAdmission?.actionableBacklogBySource));
      assert.ok(Object.isFrozen(write.catchUpAdmission?.actionableBacklogByPriority));
    }
  }
});

async function heartbeatCounts() {
  return Object.freeze({ pending: 1, processing: 0, processed: 0, failed: 0,
    retryableFailed: 0, exhaustedFailed: 0, catchUpAdmission: admissionCounts(1) });
}

void test('heartbeat catch-up admission rejects invalid state and sums before a redacted write', async () => {
  const valid = Object.freeze({ version: 1, enabled: true, providerId: 'primary',
    scanActive: false, workerClaimReady: true, ...admissionCounts(1) });
  for (const metrics of [
    undefined,
    null,
    Object.freeze({ ...valid, version: 2 }),
    Object.freeze({ ...valid, providerId: 'https://private-secret.invalid' }),
    Object.freeze({ ...valid, providerId: null }),
    Object.freeze({ ...valid, scanActive: true }),
    Object.freeze({ ...valid, workerClaimReady: 'private-secret' }),
    Object.freeze({ ...valid, enabled: false }),
    Object.freeze({ ...valid, enabled: 'private-secret' }),
    Object.freeze({ ...valid, scanActive: 'private-secret' }),
    Object.freeze({ ...valid, ...admissionCounts(2) }),
    Object.freeze({ ...valid, signature: 'private-secret' }),
    Object.freeze({ ...valid, actionableBacklogBySource: Object.freeze({ websocketOnly: 0, catchUpOnly: 0, websocketAndCatchUp: 0 }) }),
    Object.freeze({ ...valid, actionableBacklogByPriority: Object.freeze({ normal: 0, launchCandidate: 0, trackedTrade: 0 }) }),
    Object.freeze({ ...valid, deferredCount: -1 }),
    Object.freeze({ ...valid, ignoredCount: Number.MAX_SAFE_INTEGER + 1 }),
    Object.freeze({ ...valid, actionableBacklogBySource: { ...valid.actionableBacklogBySource } }),
  ]) {
    let writes = 0;
    const heartbeat = new PersistentListenerHeartbeat({
      ...heartbeatCanaryMethods(),
      counts: heartbeatCounts,
      async writeHeartbeat() { writes += 1; },
    }, { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
    () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', {
      intervalMs: 5, shutdownTimeoutMs: 100, scheduler: new ManualScheduler(),
      catchUpAdmissionMetrics: () => metrics as unknown as RuntimeCatchUpAdmissionMetricsV1,
    });
    await assert.rejects(heartbeat.start(), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.doesNotMatch(String(error), /private-secret|https?:/u);
      return true;
    });
    assert.equal(writes, 0);
  }
});

void test('heartbeat catch-up admission redacts throwing metric providers', async () => {
  const heartbeat = new PersistentListenerHeartbeat({
    ...heartbeatCanaryMethods(),
    counts: heartbeatCounts,
    async writeHeartbeat() { assert.fail('Invalid metrics must not be written.'); },
  }, { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
  () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', {
    intervalMs: 5, shutdownTimeoutMs: 100, scheduler: new ManualScheduler(),
    catchUpAdmissionMetrics: () => { throw new Error('private-secret'); },
  });
  await assert.rejects(heartbeat.start(), (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.doesNotMatch(String(error), /private-secret/u);
    return true;
  });
});

void test('heartbeat refreshes post-drain counts without another shutdown RPC read', async () => {
  const writes: {
    readonly runtimeState: string;
    readonly backlogCount: number;
    readonly leasedCount: number;
    readonly exhaustedCount: number;
  }[] = [];
  let countReads = 0;
  let slotReads = 0;
  let finalizedSlotReads = 0;
  const heartbeat = new PersistentListenerHeartbeat(
    {
      ...heartbeatCanaryMethods(),
      async counts() {
        countReads += 1;
        return countReads === 1
          ? {
            pending: 4, processing: 1, processed: 0, failed: 0,
            retryableFailed: 0, exhaustedFailed: 0,
            catchUpAdmission: admissionCounts(5),
          }
          : {
            pending: 2, processing: 0, processed: 3, failed: 2,
            retryableFailed: 1, exhaustedFailed: 1,
            catchUpAdmission: admissionCounts(3),
          };
      },
      async writeHeartbeat(value) { writes.push(value); },
    },
    {
      async getSlot() { slotReads += 1; return 10n; },
      async getFinalizedSlot() { finalizedSlotReads += 1; return 9n; },
    },
    () => 'RUNNING',
    () => 'RUNNING',
    () => 'RUNNING',
    () => 'RUNNING',
    { intervalMs: 5, shutdownTimeoutMs: 100, scheduler: new ManualScheduler() },
  );

  await heartbeat.start();
  await Promise.all([heartbeat.stop(), heartbeat.stop()]);

  assert.equal(countReads, 2);
  assert.equal(slotReads, 1);
  assert.equal(finalizedSlotReads, 1);
  assert.deepEqual(writes.map((value) => ({
    runtimeState: value.runtimeState,
    backlogCount: value.backlogCount,
    leasedCount: value.leasedCount,
    exhaustedCount: value.exhaustedCount,
  })), [
    { runtimeState: 'RUNNING', backlogCount: 5, leasedCount: 1, exhaustedCount: 0 },
    { runtimeState: 'STOPPED', backlogCount: 3, leasedCount: 0, exhaustedCount: 1 },
  ]);
});

void test('heartbeat refuses a stale STOPPED snapshot when the final count read fails', async () => {
  const writes: string[] = [];
  let countReads = 0;
  const heartbeat = new PersistentListenerHeartbeat(
    {
      ...heartbeatCanaryMethods(),
      async counts() {
        countReads += 1;
        if (countReads === 2) throw new Error('private final count failure');
        return {
          pending: 1, processing: 1, processed: 0, failed: 0,
          retryableFailed: 0, exhaustedFailed: 0,
          catchUpAdmission: admissionCounts(2),
        };
      },
      async writeHeartbeat(value) { writes.push(value.runtimeState); },
    },
    { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
    () => 'RUNNING',
    () => 'RUNNING',
    () => 'RUNNING',
    () => 'RUNNING',
    { intervalMs: 5, shutdownTimeoutMs: 100, scheduler: new ManualScheduler() },
  );
  await heartbeat.start();

  await assert.rejects(heartbeat.stop(), (error: unknown) => {
    assert.ok(error instanceof ListenerControllerCloseError);
    assert.equal(error.component, 'heartbeat');
    assert.equal(error.reason, 'dependency');
    assert.doesNotMatch(String(error), /private|count|failure/u);
    return true;
  });
  assert.deepEqual(writes, ['RUNNING']);
  assert.equal(heartbeat.state(), 'DEGRADED');
});

void test('finality close fences an in-flight pass and rejects stale timer activity', async () => {
  const scheduler = new ManualScheduler();
  const periodic = deferred<undefined>();
  let runs = 0;
  const reconciler = new RecurringFinalityReconciler(
    {
      async runOnce() {
        runs += 1;
        if (runs === 2) await periodic.promise;
      },
    },
    { intervalMs: 5, shutdownTimeoutMs: 100, scheduler },
  );
  await reconciler.start();
  scheduler.fireScheduled();
  await Promise.resolve();

  let closed = false;
  const closing = reconciler.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(runs, 2);

  periodic.resolve(undefined);
  await closing;
  assert.equal(reconciler.state(), 'STOPPED');
  scheduler.fireLastCallbackAgain();
  await Promise.resolve();
  assert.equal(runs, 2);
  assert.equal(reconciler.state(), 'STOPPED');
});

void test('finality close waits for the initial pass and fences its late success', async () => {
  const scheduler = new ManualScheduler();
  const initial = deferred<undefined>();
  const reconciler = new RecurringFinalityReconciler(
    { async runOnce() { await initial.promise; } },
    { intervalMs: 5, shutdownTimeoutMs: 100, scheduler },
  );

  const starting = reconciler.start();
  await Promise.resolve();
  let closeSettled = false;
  const closing = reconciler.close().then(() => { closeSettled = true; });
  await Promise.resolve();
  assert.equal(closeSettled, false);

  initial.resolve(undefined);
  await Promise.all([starting, closing]);
  assert.equal(reconciler.state(), 'STOPPED');
  assert.equal(reconciler.readyProviderId(), null);
  assert.throws(() => { scheduler.fireScheduled(); }, /No callback is scheduled/u);
  await Promise.resolve();
  assert.equal(reconciler.state(), 'STOPPED');
});

void test('finality close bounds a stuck initial pass and fences its eventual success', async () => {
  const scheduler = new ManualScheduler();
  const initial = deferred<undefined>();
  const reconciler = new RecurringFinalityReconciler(
    { async runOnce() { await initial.promise; } },
    { intervalMs: 5, shutdownTimeoutMs: 5, scheduler },
  );

  const starting = reconciler.start();
  await Promise.resolve();
  await assert.rejects(reconciler.close(), (error: unknown) => {
    assert.ok(error instanceof ListenerControllerCloseError);
    assert.equal(error.component, 'reconciler');
    assert.equal(error.reason, 'timeout');
    return true;
  });
  assert.equal(reconciler.state(), 'DEGRADED');

  initial.resolve(undefined);
  await starting;
  assert.equal(reconciler.state(), 'DEGRADED');
  assert.equal(reconciler.readyProviderId(), null);
  assert.throws(() => { scheduler.fireScheduled(); }, /No callback is scheduled/u);
});

void test('finality close preserves fail-start rejection without a post-close transition', async () => {
  const scheduler = new ManualScheduler();
  const initial = deferred<undefined>();
  const reconciler = new RecurringFinalityReconciler(
    {
      async runOnce() {
        await initial.promise;
        throw new Error('private initial finality failure');
      },
    },
    { intervalMs: 5, shutdownTimeoutMs: 100, scheduler },
  );

  const starting = reconciler.start();
  await Promise.resolve();
  const closing = reconciler.close();
  initial.resolve(undefined);
  await assert.rejects(starting, /private initial finality failure/u);
  await closing;

  assert.equal(reconciler.state(), 'STOPPED');
  assert.equal(reconciler.readyProviderId(), null);
  assert.throws(() => { scheduler.fireScheduled(); }, /No callback is scheduled/u);
});

void test('finality startup degrades without aborting and recovers on a fresh scheduled pass', async () => {
  const scheduler = new ManualScheduler();
  const candidate: FinalityCandidate = Object.freeze({
    signature: '1'.repeat(64), slot: 10n, confirmationStatus: 'processed',
    missingFinalityPolls: 0, lastMissingFinalityProviderId: null,
    finalityEvidenceVersion: 0n, processedAtMs: 1,
  });
  const revisions: FinalityRevision[] = [];
  const passes: Readonly<{ readonly number: number }>[] = [];
  const source: FinalityProviderPassSource = Object.freeze({
    openPass: () => {
      const snapshot = Object.freeze({ number: passes.length + 1 });
      passes.push(snapshot);
      return Object.freeze({
        providerId: 'primary' as const,
        async getHistoryStatuses() {
          if (snapshot.number === 1) throw new Error('provider unavailable');
          return [Object.freeze({ slot: 10n, confirmationStatus: 'finalized' })];
        },
        async getFinalizedSlot() { return 11n; },
        async getFinalizedBlockSignatures() { return []; },
      });
    },
  });
  const recurring = new RecurringFinalityReconciler(
    new FinalityReconciler(source, {
      async listForFinality() { return Object.freeze([candidate]); },
      async recordFinalityPoll() { throw new Error('unexpected poll'); },
      async enqueueRevision(value: FinalityRevision) { revisions.push(value); },
    }, { limit: 1, now: () => 1_000 }),
    {
      intervalMs: 5,
      shutdownTimeoutMs: 100,
      scheduler,
      initialFailureMode: 'DEGRADED_RETRY',
    },
  );

  await recurring.start();
  assert.equal(recurring.state(), 'DEGRADED');
  assert.equal(revisions.length, 0);
  assert.deepEqual(passes.map(({ number }) => number), [1]);

  const recoveredRescheduled = scheduler.waitForNextSchedule();
  scheduler.fireScheduled();
  await recoveredRescheduled;
  assert.equal(recurring.state(), 'RUNNING');
  assert.deepEqual(passes.map(({ number }) => number), [1, 2]);
  assert.equal(new Set(passes).size, 2);
  assert.deepEqual(revisions.map((revision) => revision.confirmationStatus), ['finalized']);
  await recurring.close();
  assert.equal(hasSchedulerWaiterState(scheduler), false);
});

void test('finality readiness is current only after an unchanged promoted-provider pass', async () => {
  const scheduler = new ManualScheduler();
  let provider: 'primary' | 'fallback-1' | null = null;
  let revision = 0n;
  let runs = 0;
  let gate: ReturnType<typeof deferred<undefined>> | null = null;
  let rejectNext = false;
  const recurring = new RecurringFinalityReconciler(
    {
      async runOnce() {
        runs += 1;
        if (gate !== null) await gate.promise;
        if (rejectNext) throw new Error('private finality failure');
      },
    },
    {
      intervalMs: 5,
      shutdownTimeoutMs: 100,
      scheduler,
      initialFailureMode: 'DEGRADED_RETRY',
      currentSelection: () => Object.freeze({ providerId: provider, revision }),
    },
  );

  await recurring.start();
  assert.equal(recurring.state(), 'DEGRADED');
  assert.equal(recurring.readyProviderId(), null);
  assert.equal(runs, 0);

  provider = 'primary';
  revision += 1n;
  let rescheduled = scheduler.waitForNextSchedule();
  scheduler.fireScheduled();
  await rescheduled;
  assert.equal(recurring.state(), 'RUNNING');
  assert.equal(recurring.readyProviderId(), 'primary');
  assert.equal(runs, 1);

  gate = deferred<undefined>();
  rescheduled = scheduler.waitForNextSchedule();
  scheduler.fireScheduled();
  await Promise.resolve();
  assert.equal(recurring.readyProviderId(), null);
  provider = 'fallback-1';
  revision += 1n;
  gate.resolve(undefined);
  await rescheduled;
  assert.equal(recurring.state(), 'DEGRADED');
  assert.equal(recurring.readyProviderId(), null);

  gate = null;
  rescheduled = scheduler.waitForNextSchedule();
  scheduler.fireScheduled();
  await rescheduled;
  assert.equal(recurring.state(), 'RUNNING');
  assert.equal(recurring.readyProviderId(), 'fallback-1');

  rejectNext = true;
  rescheduled = scheduler.waitForNextSchedule();
  scheduler.fireScheduled();
  await rescheduled;
  assert.equal(recurring.state(), 'DEGRADED');
  assert.equal(recurring.readyProviderId(), null);
  await recurring.close();
  assert.equal(recurring.readyProviderId(), null);
});

void test('finality readiness rejects clear and same-provider repromotion until a fresh pass', async () => {
  const scheduler = new ManualScheduler();
  const promoted = new PromotedProviderSelector([pass('primary')]);
  promoted.promote('primary');
  let runs = 0;
  const recurring = new RecurringFinalityReconciler(
    { async runOnce() { runs += 1; } },
    {
      intervalMs: 5,
      shutdownTimeoutMs: 100,
      scheduler,
      initialFailureMode: 'DEGRADED_RETRY',
      currentSelection: () => promoted.selection(),
    },
  );

  await recurring.start();
  assert.equal(recurring.readyProviderId(), 'primary');
  assert.equal(recurring.isReadyFor(promoted.selection()), true);

  promoted.clear('primary');
  promoted.promote('primary');
  assert.equal(recurring.readyProviderId(), null);
  assert.equal(recurring.isReadyFor(promoted.selection()), false);
  assert.equal(runs, 1);

  const rescheduled = scheduler.waitForNextSchedule();
  scheduler.fireScheduled();
  await rescheduled;
  assert.equal(recurring.readyProviderId(), 'primary');
  assert.equal(recurring.isReadyFor(promoted.selection()), true);
  assert.equal(runs, 2);
  await recurring.close();
});

void test('a deferred A to B to A promotion epoch degrades and retries before readiness', async () => {
  const scheduler = new ManualScheduler();
  const promoted = new PromotedProviderSelector([pass('primary'), pass('fallback-1')]);
  promoted.promote('primary');
  const gate = deferred<undefined>();
  let runs = 0;
  const recurring = new RecurringFinalityReconciler(
    {
      async runOnce() {
        runs += 1;
        if (runs === 1) await gate.promise;
      },
    },
    {
      intervalMs: 5,
      shutdownTimeoutMs: 100,
      scheduler,
      initialFailureMode: 'DEGRADED_RETRY',
      currentSelection: () => promoted.selection(),
    },
  );

  const starting = recurring.start();
  await Promise.resolve();
  promoted.promote('fallback-1');
  promoted.promote('primary');
  gate.resolve(undefined);
  await starting;

  assert.equal(recurring.state(), 'DEGRADED');
  assert.equal(recurring.readyProviderId(), null);
  assert.equal(recurring.isReadyFor(promoted.selection()), false);

  const rescheduled = scheduler.waitForNextSchedule();
  scheduler.fireScheduled();
  await rescheduled;
  assert.equal(recurring.state(), 'RUNNING');
  assert.equal(recurring.readyProviderId(), 'primary');
  assert.equal(recurring.isReadyFor(promoted.selection()), true);
  assert.equal(runs, 2);
  await recurring.close();
});

void test('finality startup fails closed by default without scheduling a retry', async () => {
  const cases: readonly RecurringFinalityOptions[] = [
    { intervalMs: 5, shutdownTimeoutMs: 100, scheduler: new ManualScheduler() },
    {
      intervalMs: 5,
      shutdownTimeoutMs: 100,
      scheduler: new ManualScheduler(),
      initialFailureMode: 'FAIL_START',
    },
  ];
  for (const options of cases) {
    const scheduler = options.scheduler as ManualScheduler;
    const recurring = new RecurringFinalityReconciler(
      { async runOnce() { throw new Error('private startup failure'); } },
      options,
    );

    await assert.rejects(recurring.start(), /private startup failure/u);
    assert.equal(recurring.state(), 'DEGRADED');
    assert.throws(() => { scheduler.fireScheduled(); }, /No callback is scheduled/u);
    await recurring.close();
  }
});

void test('finality recurrence degrades on an unavailable block then returns to RUNNING with a fresh proof', async () => {
  const scheduler = new ManualScheduler();
  const candidate: FinalityCandidate = Object.freeze({
    signature: '1'.repeat(64), slot: 10n, confirmationStatus: 'processed',
    missingFinalityPolls: 0, lastMissingFinalityProviderId: null,
    finalityEvidenceVersion: 0n, processedAtMs: 1,
  });
  let current = candidate;
  const revisions: FinalityRevision[] = [];
  const passSnapshots: Readonly<{ readonly pass: number }>[] = [];
  const blockProofs: Readonly<{
    readonly snapshot: Readonly<{ readonly pass: number }>;
    readonly slot: bigint;
  }>[] = [];
  const source: FinalityProviderPassSource = Object.freeze({
    openPass: () => {
      const snapshot = Object.freeze({ pass: passSnapshots.length + 1 });
      passSnapshots.push(snapshot);
      let historyRead = false;
      return Object.freeze({
        providerId: 'primary' as const,
        async getHistoryStatuses() {
          if (historyRead) throw new Error('stale pass reused');
          historyRead = true;
          return [null];
        },
        async getFinalizedSlot() { return 11n; },
        async getFinalizedBlockSignatures(slot: bigint) {
          blockProofs.push(Object.freeze({ snapshot, slot }));
          if (snapshot.pass === 2) throw new Error('block unavailable');
          if (snapshot.pass !== 3) throw new Error('unexpected finality pass');
          return [];
        },
      });
    },
  });
  const repository = {
    async listForFinality() { return Object.freeze([current]); },
    async recordFinalityPoll(value: FinalityPollObservation) {
      assert.equal(value.expectedMissingFinalityPolls, current.missingFinalityPolls);
      assert.equal(value.expectedLastMissingFinalityProviderId, current.lastMissingFinalityProviderId);
      assert.equal(value.expectedFinalityEvidenceVersion, current.finalityEvidenceVersion);
      current = Object.freeze({
        ...current,
        missingFinalityPolls: current.lastMissingFinalityProviderId === value.providerId
          ? current.missingFinalityPolls + 1
          : 1,
        lastMissingFinalityProviderId: value.providerId,
        finalityEvidenceVersion: current.finalityEvidenceVersion + 1n,
      });
      return current;
    },
    async enqueueRevision(value: FinalityRevision) { revisions.push(value); },
  };
  const recurring = new RecurringFinalityReconciler(
    new FinalityReconciler(source, repository, {
      limit: 1, missingPollThreshold: 2, now: () => 1_000,
    }),
    { intervalMs: 5, shutdownTimeoutMs: 100, scheduler },
  );

  await recurring.start();
  assert.equal(recurring.state(), 'RUNNING');
  assert.equal(passSnapshots.length, 1);

  const degradedRescheduled = scheduler.waitForNextSchedule();
  scheduler.fireScheduled();
  await degradedRescheduled;
  assert.equal(recurring.state(), 'DEGRADED');
  assert.equal(revisions.length, 0);
  assert.deepEqual(blockProofs.map(({ snapshot }) => snapshot.pass), [2]);

  const recoveredRescheduled = scheduler.waitForNextSchedule();
  scheduler.fireScheduled();
  await recoveredRescheduled;
  assert.equal(recurring.state(), 'RUNNING');
  assert.deepEqual(passSnapshots.map(({ pass }) => pass), [1, 2, 3]);
  assert.equal(new Set(passSnapshots).size, 3);
  assert.deepEqual(blockProofs.map(({ snapshot, slot }) => ({ pass: snapshot.pass, slot })), [
    { pass: 2, slot: 10n },
    { pass: 3, slot: 10n },
  ]);
  assert.deepEqual(revisions.map((revision) => revision.confirmationStatus), ['orphaned']);
  await recurring.close();
  assert.equal(hasSchedulerWaiterState(scheduler), false);
});

void test('manual scheduler bounds a missing reschedule without retaining a waiter', async () => {
  const scheduler = new ManualScheduler();
  let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
  let reason = '';
  void scheduler.waitForNextSchedule().then(
    () => { outcome = 'resolved'; },
    (error: unknown) => {
      outcome = 'rejected';
      reason = error instanceof Error ? error.message : '';
    },
  );

  for (let index = 0; index < 128; index += 1) await Promise.resolve();

  assert.equal(outcome, 'rejected');
  assert.equal(reason, 'Manual scheduler was not rescheduled.');
  assert.equal(hasSchedulerWaiterState(scheduler), false);
});

void test('accepts the exact Node timer bound and rejects overflow or fractions', () => {
  const scheduler = new ManualScheduler();
  assert.doesNotThrow(() => new RecurringFinalityReconciler(
    { async runOnce() { return undefined; } },
    { intervalMs: MAX_LISTENER_TIMER_DELAY_MS, shutdownTimeoutMs: 100, scheduler },
  ));
  assert.throws(() => new RecurringFinalityReconciler(
    { async runOnce() { return undefined; } },
    { intervalMs: MAX_LISTENER_TIMER_DELAY_MS + 1, shutdownTimeoutMs: 100, scheduler },
  ), TypeError);
  assert.throws(() => new RecurringFinalityReconciler(
    { async runOnce() { return undefined; } },
    { intervalMs: 1.5, shutdownTimeoutMs: 100, scheduler },
  ), TypeError);
  assert.throws(() => new RecurringFinalityReconciler(
    { async runOnce() { return undefined; } },
    {
      intervalMs: 5,
      shutdownTimeoutMs: 100,
      scheduler,
      initialFailureMode: 'INVALID' as 'FAIL_START',
    },
  ), TypeError);

  assert.equal(config({ RECONCILE_SECONDS: '2147483' }).reconcileSeconds, 2_147_483);
  assert.throws(() => config({ RECONCILE_SECONDS: '2147484' }), /RECONCILE_SECONDS/u);
});

const inertPool = Object.freeze({
  async query(): Promise<never> {
    throw new Error('The composition test must not query PostgreSQL.');
  },
  async connect(): Promise<never> {
    throw new Error('The composition test must not connect to PostgreSQL.');
  },
});

function config(overrides: Record<string, string> = {}): ReturnType<typeof parseConfig> {
  return parseConfig({
    SOLANA_HTTP_RPC_URL: 'http://127.0.0.1:8899',
    SOLANA_WS_RPC_URL: 'ws://127.0.0.1:8900',
    SOLANA_EXPECTED_GENESIS_HASH: TEST_GENESIS_HASH,
    ...overrides,
  });
}

function pass(providerId: 'primary' | 'fallback-1'): FinalityProviderPass {
  return Object.freeze({
    providerId,
    async getHistoryStatuses() { return Object.freeze([]); },
    async getFinalizedSlot() { return 0n; },
    async getFinalizedBlockSignatures() { return Object.freeze([]); },
  });
}

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function assertProductionCatchUpWiring(source: string): void {
  for (const symbol of [
    'openWsProgramSession',
    'StrictCatchUpScanner',
    'StrictCatchUpCoordinator',
    'createProviderPinnedCatchUpSource',
    'PersistentWebSocketHealthReporter',
    'PostgresWebSocketHealthRepository',
    'WebSocketFailoverSupervisor',
    'PromotedProviderSelector',
  ]) assert.match(source, new RegExp(`\\b${symbol}\\b`, 'u'), symbol);
  assert.doesNotMatch(
    source,
    /\b(?:CatchUpScanner|StartupScanner|SolanaCatchUpSource|SolanaProgramSubscriber)\b/u,
  );
  assert.match(source, /new WebSocketFailoverSupervisor\(/u);
  assert.match(source, /pinnedCatchUpSources/u);
  assert.match(source, /verifyProviderGenesis:/u);
  assert.match(source, /source\.verifyGenesis\(signal\)/u);
  assert.match(source, /prepareInitialFrontier:\s*async/u);
  assert.match(source, /config\.listenerCatchUpPolicy\s*!==\s*'live-edge'/u);
  assert.match(source, /await baselineScanner\.scan\(signal\)/u);
  assert.match(source, /runStrictScan:/u);
  assert.match(source, /readPinnedProviderId:/u);
  assert.match(source, /new StrictCatchUpCoordinator\(recoveryScanner, inbox, strictCheckpointKeys\)/u);
  assert.match(source, /strictCheckpointKeys\s*=\s*Object\.freeze\(ingestionPrograms\.map/u);
  assert.match(
    source,
    /openSession:\s*\([^)]*\)[^=]*=>\s*openWsProgramSession\([\s\S]*?\{ programs: ingestionPrograms \}/u,
  );
  assert.match(source, /const recoveryScanner\s*=\s*new StrictCatchUpScanner\([\s\S]*?policy:\s*'strict'[\s\S]*?programs:\s*ingestionPrograms/u);
  assert.match(source, /const baselineScanner\s*=\s*new StrictCatchUpScanner\([\s\S]*?policy:\s*'live-edge'[\s\S]*?programs:\s*ingestionPrograms/u);
}

function hasSchedulerWaiterState(scheduler: ManualScheduler): boolean {
  return Reflect.ownKeys(scheduler).some(
    (key) => typeof key === 'string' && /waiter/iu.test(key),
  );
}

const MAX_MANUAL_SCHEDULER_WAIT_MICROTASKS = 64;

class ManualScheduler implements ListenerRuntimeScheduler {
  private callback: (() => void) | null = null;
  private lastCallback: (() => void) | null = null;
  private scheduledCount = 0;

  public schedule(callback: () => void): object {
    this.callback = callback;
    this.lastCallback = callback;
    this.scheduledCount += 1;
    return Object.freeze({});
  }

  public cancel(): void {
    this.callback = null;
  }

  public fireScheduled(): void {
    const callback = this.callback;
    if (callback === null) throw new Error('No callback is scheduled.');
    this.callback = null;
    callback();
  }

  public fireLastCallbackAgain(): void {
    const callback = this.lastCallback;
    if (callback === null) throw new Error('No callback was scheduled.');
    callback();
  }

  public async waitForNextSchedule(): Promise<void> {
    const after = this.scheduledCount;
    for (let attempt = 0; attempt < MAX_MANUAL_SCHEDULER_WAIT_MICROTASKS; attempt += 1) {
      await Promise.resolve();
      if (this.scheduledCount > after) return;
    }
    throw new Error('Manual scheduler was not rescheduled.');
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error('Deferred is unavailable.');
      resolvePromise(value);
    },
  };
}
