import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseConfig } from '../src/config/env.js';
import { FinalityReconciler } from '../src/application/finality-reconciler.js';
import { PromotedProviderSelector } from '../src/application/promoted-provider-selector.js';
import type {
  FinalityCandidate,
  FinalityPollObservation,
  FinalityRevision,
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
  type RecurringFinalityOptions,
  type ListenerRuntimeScheduler,
} from '../src/application/production-listener-factory.js';

const TEST_GENESIS_HASH = '11111111111111111111111111111111';

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
    /new SolanaRpcClient\(config,\s*\{\s*onHttpFailoverEvent: logRpcHttpFailoverEvent,\s*\}\)/u,
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
  assert.match(factory, /providers\.ids\.map\(\(providerId\)[\s\S]*?createProviderPinnedFinalityPass\(providers, providerId\)/u);
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
  assert.match(source, /new ObservedTransactionPipeline\([\s\S]*?paperRepository,\s*qualification,\s*\)/u);
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
      async counts() {
        return {
          pending: 0, processing: 0, processed: 0, failed: 0,
          retryableFailed: 0, exhaustedFailed: 0,
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
      async counts() {
        return {
          pending: 2, processing: 1, processed: 4, failed: 3,
          retryableFailed: 2, exhaustedFailed: 1,
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
      async counts() {
        countReads += 1;
        return countReads === 1
          ? {
            pending: 4, processing: 1, processed: 0, failed: 0,
            retryableFailed: 0, exhaustedFailed: 0,
          }
          : {
            pending: 2, processing: 0, processed: 3, failed: 2,
            retryableFailed: 1, exhaustedFailed: 1,
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
      async counts() {
        countReads += 1;
        if (countReads === 2) throw new Error('private final count failure');
        return {
          pending: 1, processing: 1, processed: 0, failed: 0,
          retryableFailed: 0, exhaustedFailed: 0,
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
  assert.match(source, /runStrictScan:/u);
  assert.match(source, /openSession:\s*openWsProgramSession/u);
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
