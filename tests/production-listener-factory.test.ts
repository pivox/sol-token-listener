import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseConfig } from '../src/config/env.js';
import { FinalityReconciler } from '../src/application/finality-reconciler.js';
import type {
  FinalityCandidate,
  FinalityPollObservation,
  FinalityRevision,
} from '../src/domain/transaction-ingestion.js';
import type { TokenLaunch } from '../src/domain/types.js';
import type { FinalityProviderPassSource } from '../src/ports/finality-provider-pass.js';
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
  assert.match(source, /policy: config\.listenerCatchUpPolicy/u);
  assert.match(source, /listener\.catch_up_gap_recorded/u);
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

void test('production pins finality to one primary provider pass without coupling it to HTTP failover', async () => {
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
  assert.match(factory, /const primaryFinality = createProviderPinnedFinalityPass\(providers, 'primary'\);/u);
  assert.match(factory, /const finalitySource: FinalityProviderPassSource = Object\.freeze\(\{\s*openPass: \(\) => primaryFinality,\s*\}\);/u);
  assert.match(factory, /new FinalityReconciler\(finalitySource, inbox,/u);
  assert.match(
    factory,
    /initialFailureMode:\s*config\.executionMode === 'observe'\s*\? 'DEGRADED_RETRY'\s*:\s*'FAIL_START'/u,
  );
  assert.doesNotMatch(factory, /new FinalityReconciler\(rpc, inbox,/u);
  assert.doesNotMatch(pinnedAdapter, /http-failover-transport/u);
});

void test('keeps the acknowledged WebSocket session foundation inactive until issue 63', async () => {
  const source = await readFile(
    new URL('../src/application/production-listener-factory.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /ws-program-session/u);
  assertProductionCatchUpWiring(source);
});

void test('production catch-up wiring guard rejects strict paths, symbols, and barrel references', () => {
  assert.doesNotThrow(() => { assertProductionCatchUpWiring([
    "import { CatchUpScanner } from './catch-up-scanner.js';",
    "import { SolanaProgramSubscriber } from '../solana/rpc/program-subscriber.js';",
    'const scanner = new CatchUpScanner();',
    'const subscriber = new SolanaProgramSubscriber();',
  ].join('\n')); });

  for (const source of [
    "import scanner from './strict-catch-up-scanner.js';",
    "import coordinator from './strict-catch-up-coordinator.js';",
    "import pinnedSource from '../solana/rpc/provider-pinned-catch-up-source.js';",
    "import { createProviderPinnedCatchUpSource } from '../solana/rpc/provider-pinned-catch-up-source.js';",
    "import { StrictCatchUpScanner } from './strict-catch-up-scanner.js';",
    "import { StrictCatchUpCoordinator } from './strict-catch-up-coordinator.js';",
    "import { ProviderPinnedCatchUpSource } from '../solana/rpc/provider-pinned-catch-up-source.js';",
    "import { StrictCatchUpScanner } from './application.js';",
    "import { createProviderPinnedCatchUpSource } from './application.js';",
    'const scanner = new StrictCatchUpScanner();',
    'const coordinator = new StrictCatchUpCoordinator();',
    'const source = ProviderPinnedCatchUpSource;',
    'const source = createProviderPinnedCatchUpSource();',
  ]) {
    assert.throws(() => { assertProductionCatchUpWiring(source); }, /strict catch-up/i);
  }
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
  assert.match(source, /new PostgresQualificationProjectionRepository\(pool,\s*qualificationRebuilder\)/u);
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
    ...overrides,
  });
}

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function assertProductionCatchUpWiring(source: string): void {
  assert.doesNotMatch(
    source,
    /\b(?:StrictCatchUpScanner|StrictCatchUpCoordinator|ProviderPinnedCatchUpSource|createProviderPinnedCatchUpSource)\b/u,
    'Strict catch-up symbols must remain inactive until issue 63.',
  );
  assert.doesNotMatch(
    source,
    /(?:strict-catch-up-scanner|strict-catch-up-coordinator|provider-pinned-catch-up-source)/u,
    'Strict catch-up module paths must remain inactive until issue 63.',
  );
  assert.match(
    source,
    /import\s*\{[^}]*\bCatchUpScanner\b[^}]*\}\s*from\s*['"]\.\/catch-up-scanner\.js['"]/u,
  );
  assert.match(source, /\bnew\s+CatchUpScanner\s*\(/u);
  assert.match(
    source,
    /import\s*\{[^}]*\bSolanaProgramSubscriber\b[^}]*\}\s*from\s*['"]\.\.\/solana\/rpc\/program-subscriber\.js['"]/u,
  );
  assert.match(source, /\bnew\s+SolanaProgramSubscriber\s*\(/u);
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
