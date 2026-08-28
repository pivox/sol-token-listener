import assert from 'node:assert/strict';
import test from 'node:test';
import { PromotedProviderSelector } from '../src/application/promoted-provider-selector.js';
import { PersistentWebSocketHealthReporter } from '../src/application/websocket-health-reporter.js';
import {
  WEBSOCKET_FRONTIER_INTERVAL_MS,
  WEBSOCKET_BACKOFF_BASE_MS,
  WEBSOCKET_BACKOFF_CAP_MS,
  WebSocketFailoverSupervisor,
  WebSocketFailoverSupervisorError,
  type WebSocketFailoverScheduler,
  type WebSocketFailoverSupervisorDependencies,
  type WebSocketFailoverSupervisorOptions,
} from '../src/application/websocket-failover-supervisor.js';
import type { StrictCatchUpScanResult } from '../src/application/strict-catch-up-scanner.js';
import {
  createWebSocketHealthSnapshot,
  type WebSocketHealthSnapshot,
} from '../src/domain/websocket-health.js';
import type { RpcProviderId } from '../src/domain/rpc-provider.js';
import type { TransactionNotification } from '../src/domain/transaction-ingestion.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import type { FinalityProviderPass } from '../src/ports/finality-provider-pass.js';
import type {
  WebSocketHealthRepository,
  WebSocketHealthTransition,
} from '../src/ports/websocket-health-repository.js';
import type { RpcProviderCatalog, RpcProviderPair } from '../src/solana/rpc/rpc-provider-catalog.js';
import type {
  openWsProgramSession,
  WsProgramNotification,
  WsProgramSession,
  WsProgramSessionCompletion,
} from '../src/solana/rpc/ws-program-session.js';

void test('owner acquisition starts touch, persists waiting, and schedules recovery before sockets', async () => {
  const fixture = supervisorFixture();

  const firstStart = fixture.supervisor.start();
  assert.equal(fixture.supervisor.start(), firstStart);
  await firstStart;

  assert.deepEqual(fixture.calls, [
    'health.beginOwner:primary',
    'reporter.startTouch:1',
    'health.transition:WAITING_FOR_ACKS',
    'scheduler.recovery:0',
  ]);
  assert.equal(fixture.supervisor.state(), 'STARTING');
  assert.equal(fixture.supervisor.activeProviderId(), null);
  assert.equal(fixture.calls.some((call) => call.startsWith('session.open')), false);
  assert.deepEqual(fixture.reporter.transitions[0], waitingTransition(1n));
});

void test('dual ACK forwards a partial notification and promotion follows strict durable recovery', async () => {
  const fixture = supervisorFixture();
  const strictScan = deferred<StrictCatchUpScanResult>();
  fixture.strictResults.push(strictScan.promise);
  await fixture.supervisor.start();

  fixture.scheduler.fireNext(0);
  await flushMicrotasks();
  assert.deepEqual(fixture.calls.slice(-2), [
    'catalog.resolve:primary',
    'session.open:primary',
  ]);
  assert.equal(fixture.openedEndpoint?.id, 'primary');
  assert.equal(fixture.openedEndpoint?.url, 'wss://rpc.example/ws');
  assert.equal(fixture.openSignal?.aborted, false);

  await fixture.observe?.(Object.freeze({
    endpointId: 'primary',
    program: 'pumpfun',
    signature: '1'.repeat(64),
    slot: 41n,
  }));
  assert.equal(fixture.openSessionDeferred.settled(), false);
  const observed = fixture.reporter.observations[0];
  assert.deepEqual(observed, {
    notification: {
      signature: '1'.repeat(64),
      slot: 41n,
      source: 'WEBSOCKET',
      programIds: [PUMP_PROGRAM_ID],
      confirmationStatus: 'confirmed',
      observedAtMs: 1_000,
    },
    ownerGeneration: 1n,
    sessionGeneration: 1n,
  });
  assert.equal(Object.isFrozen(observed?.notification), true);
  assert.equal(Object.isFrozen(observed?.notification.programIds), true);
  assert.equal(fixture.reporter.transitions.length, 1);
  assert.equal(fixture.strictCalls.length, 0);

  fixture.resolveOpenSession();
  await flushMicrotasks();
  assert.equal(fixture.completionThenCalls, 1);
  assert.ok(
    fixture.calls.indexOf('session.completion.attach')
      < fixture.calls.indexOf('health.transition:ACKNOWLEDGED'),
  );
  assert.deepEqual(fixture.reporter.transitions.map(({ phase }) => phase), [
    'WAITING_FOR_ACKS',
    'ACKNOWLEDGED',
    'RECOVERING',
  ]);
  assert.equal(fixture.reporter.transitions[1]?.recoveryStatus, 'REQUIRED');
  assert.equal(fixture.reporter.transitions[2]?.recoveryStatus, 'IN_PROGRESS');
  assert.equal(fixture.strictCalls.length, 1);
  assert.equal(fixture.strictCalls[0]?.providerId, 'primary');
  assert.equal(fixture.strictCalls[0]?.signal, fixture.openSignal);
  assert.equal(fixture.supervisor.activeProviderId(), null);

  strictScan.resolve(scanResult('primary'));
  await flushMicrotasks();

  assert.deepEqual(fixture.reporter.transitions.map(({ phase }) => phase), [
    'WAITING_FOR_ACKS',
    'ACKNOWLEDGED',
    'RECOVERING',
    'RUNNING',
  ]);
  assert.equal(fixture.reporter.transitions[3]?.recoveryStatus, 'RECOVERED');
  assert.deepEqual(
    fixture.reporter.transitions.map(({ ownerGeneration }) => ownerGeneration),
    [1n, 1n, 1n, 1n],
  );
  assert.deepEqual(
    fixture.reporter.transitions.map(({ expectedRevision }) => expectedRevision),
    [1n, 2n, 3n, 4n],
  );
  assert.ok(
    fixture.calls.indexOf('health.transition:RUNNING')
      < fixture.calls.indexOf('selector.promote:primary'),
  );
  assert.deepEqual(fixture.calls.slice(-2), [
    'selector.promote:primary',
    'scheduler.periodic:30000',
  ]);
  assert.equal(fixture.scheduler.pendingDelays().includes(WEBSOCKET_FRONTIER_INTERVAL_MS), true);
  assert.equal(fixture.supervisor.state(), 'RUNNING');
  assert.equal(fixture.supervisor.activeProviderId(), 'primary');
  assert.equal(fixture.completionThenCalls, 1);
});

void test('promotion is abandoned when candidate completion wins before recovery', async () => {
  const fixture = supervisorFixture();
  fixture.strictResults.push(Promise.resolve(scanResult('primary')));
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushMicrotasks();

  fixture.completionDeferred.resolve(Object.freeze({ reason: 'REMOTE_CLOSE' }));
  fixture.resolveOpenSession();
  await flushMicrotasks();

  assert.equal(fixture.completionThenCalls, 1);
  assert.ok(
    fixture.calls.indexOf('session.completion.attach')
      < fixture.calls.indexOf('health.transition:ACKNOWLEDGED'),
  );
  assert.equal(fixture.openSignal?.aborted, true);
  assert.equal(fixture.strictCalls.length, 0);
  assert.equal(fixture.calls.includes('health.transition:RUNNING'), false);
  assert.equal(fixture.calls.includes('selector.promote:primary'), false);
  assert.equal(fixture.supervisor.activeProviderId(), null);
});

void test('owner failure is redacted before touch, scheduling, socket, or strict HTTP', async () => {
  const hostile = 'wss://secret.invalid/ws?token=owner-secret';
  const fixture = supervisorFixture({ ownerFailure: new Error(hostile) });

  await assertStage(fixture.supervisor.start(), 'owner', hostile);

  assert.deepEqual(fixture.calls, ['health.beginOwner:primary']);
  assertNoSolanaCall(fixture);
  assert.equal(fixture.reporter.stopCalls, 0);
});

void test('owner rejects a valid snapshot that does not authorize the primary candidate', async () => {
  const fixture = supervisorFixture({ ownerSnapshot: connectingSnapshot('fallback-1') });

  await assertStage(fixture.supervisor.start(), 'owner', 'never-leaked');

  assert.deepEqual(fixture.calls, ['health.beginOwner:primary']);
  assert.equal(fixture.reporter.stopCalls, 0);
  assertNoSolanaCall(fixture);
});

void test('initial waiting transition failure stops touch before scheduling or Solana', async () => {
  const hostile = 'https://secret.invalid/rpc?token=transition-secret';
  const fixture = supervisorFixture({
    transitionFailure: 'WAITING_FOR_ACKS',
    transitionError: new Error(hostile),
  });

  await assertStage(fixture.supervisor.start(), 'transition', hostile);

  assert.deepEqual(fixture.calls, [
    'health.beginOwner:primary',
    'reporter.startTouch:1',
    'health.transition:WAITING_FOR_ACKS',
    'reporter.stop',
  ]);
  assertNoSolanaCall(fixture);
  assert.equal(fixture.reporter.stopCalls, 1);
  assert.equal(fixture.scheduler.pendingDelays().length, 0);
});

void test('initial waiting transition rejects a mutable returned snapshot and stops touch', async () => {
  const fixture = supervisorFixture({ mutableTransitionResult: 'WAITING_FOR_ACKS' });

  await assertStage(fixture.supervisor.start(), 'transition', 'never-leaked');

  assert.deepEqual(fixture.calls, [
    'health.beginOwner:primary',
    'reporter.startTouch:1',
    'health.transition:WAITING_FOR_ACKS',
    'reporter.stop',
  ]);
  assert.equal(fixture.reporter.stopCalls, 1);
  assert.equal(fixture.scheduler.pendingDelays().length, 0);
  assertNoSolanaCall(fixture);
});

void test('initial scheduling failure stops touch without cancelling a phantom handle or using Solana', async () => {
  const hostile = 'https://secret.invalid/rpc?token=schedule-secret';
  const fixture = supervisorFixture({
    scheduleFailureDelay: 0,
    scheduleError: new Error(hostile),
  });

  await assertStage(fixture.supervisor.start(), 'schedule', hostile);

  assert.deepEqual(fixture.calls, [
    'health.beginOwner:primary',
    'reporter.startTouch:1',
    'health.transition:WAITING_FOR_ACKS',
    'scheduler.recovery:0',
    'reporter.stop',
  ]);
  assertNoSolanaCall(fixture);
  assert.equal(fixture.reporter.stopCalls, 1);
  assert.deepEqual(fixture.scheduler.cancelledHandles, []);
  assert.equal(fixture.scheduler.pendingDelays().length, 0);
});

void test('constructor rejects hostile options, dependencies, catalog IDs, clock, and random redacted', () => {
  const hostile = 'wss://secret.invalid/ws?hash=signature-secret';
  const fixture = supervisorFixture();
  const validDependencies = fixture.dependencies;
  const validOptions = fixture.options;
  let proxyTraps = 0;
  const hostileProxy = new Proxy({}, {
    get() { proxyTraps += 1; throw new Error(hostile); },
    ownKeys() { proxyTraps += 1; throw new Error(hostile); },
  });
  let callableProxyTraps = 0;
  const hostileCallable = new Proxy(() => 1_000, {
    apply() { callableProxyTraps += 1; throw new Error(hostile); },
  });
  let accessorCalls = 0;
  const accessorOptions = { random: validOptions.random, scheduler: validOptions.scheduler };
  Object.defineProperty(accessorOptions, 'now', {
    enumerable: true,
    get() { accessorCalls += 1; return () => 1_000; },
  });
  const invalidCatalog = Object.freeze({
    ids: Object.freeze(['primary', hostile]) as readonly RpcProviderId[],
    resolve: validDependencies.providers.resolve.bind(validDependencies.providers),
  });

  for (const options of [
    hostileProxy,
    accessorOptions,
    { ...validOptions, extra: hostile },
    { ...validOptions, now: () => -1 },
    { ...validOptions, now: () => Number.MAX_SAFE_INTEGER + 1 },
    { ...validOptions, now: () => { throw new Error(hostile); } },
    { ...validOptions, now: hostileCallable },
    { ...validOptions, random: () => -0.1 },
    { ...validOptions, random: () => 1 },
    { ...validOptions, random: () => Number.NaN },
    { ...validOptions, scheduler: hostileProxy },
    { ...validOptions, scheduler: { schedule() {}, cancel() {}, extra: hostile } },
  ]) {
    assertInvalidConstructor(validDependencies, options, hostile);
  }
  for (const dependencies of [
    hostileProxy,
    { ...validDependencies, extra: hostile },
    { ...validDependencies, providers: invalidCatalog },
    { ...validDependencies, openSession: hostile },
    { ...validDependencies, openSession: hostileCallable },
    { ...validDependencies, runStrictScan: hostile },
  ]) {
    assertInvalidConstructor(dependencies, validOptions, hostile);
  }
  assert.equal(proxyTraps, 0);
  assert.equal(callableProxyTraps, 0);
  assert.equal(accessorCalls, 0);
  assert.doesNotThrow(() => new WebSocketFailoverSupervisor(validDependencies, validOptions));
});

void test('scheduler callables preserve their validated receiver and ignore later replacement', async () => {
  const fixture = supervisorFixture();
  const scheduleReceivers: object[] = [];
  const cancelReceivers: object[] = [];
  const scheduler: WebSocketFailoverScheduler = {
    schedule(this: object, _callback: () => void, _delayMs: number): object {
      scheduleReceivers.push(this);
      return Object.freeze({});
    },
    cancel(this: object): void { cancelReceivers.push(this); },
  };
  const supervisor = new WebSocketFailoverSupervisor(fixture.dependencies, {
    now: () => 1_000,
    random: () => 0.5,
    scheduler,
  });
  scheduler.schedule = () => { throw new Error('secret replacement schedule'); };
  scheduler.cancel = () => { throw new Error('secret replacement cancel'); };

  await supervisor.start();
  await supervisor.close();

  assert.deepEqual(scheduleReceivers, [scheduler]);
  assert.deepEqual(cancelReceivers, [scheduler]);
});

void test('exports the fixed supervisor timing bounds', () => {
  assert.equal(WEBSOCKET_FRONTIER_INTERVAL_MS, 30_000);
  assert.equal(WEBSOCKET_BACKOFF_BASE_MS, 1_000);
  assert.equal(WEBSOCKET_BACKOFF_CAP_MS, 60_000);
});

void test('close is idempotent, cancels handles, aborts setup, and prevents late promotion', async () => {
  const scheduled = supervisorFixture();
  await scheduled.supervisor.start();
  const firstClose = scheduled.supervisor.close();
  assert.equal(scheduled.supervisor.close(), firstClose);
  await firstClose;
  assert.equal(scheduled.scheduler.pendingDelays().length, 0);
  assert.equal(scheduled.scheduler.cancelledHandles.length, 1);
  assert.equal(scheduled.reporter.stopCalls, 0);
  assert.equal(scheduled.supervisor.state(), 'STOPPED');

  const closedBeforeStart = supervisorFixture();
  await closedBeforeStart.supervisor.close();
  await assertStage(closedBeforeStart.supervisor.start(), 'cleanup', 'never-leaked');
  assert.equal(closedBeforeStart.calls.includes('health.beginOwner:primary'), false);

  const opening = supervisorFixture();
  opening.strictResults.push(Promise.resolve(scanResult('primary')));
  await opening.supervisor.start();
  opening.scheduler.fireNext(0);
  await flushMicrotasks();
  assert.equal(opening.openSignal?.aborted, false);

  await opening.supervisor.close();
  assert.equal(opening.openSignal?.aborted, true);
  opening.resolveOpenSession();
  await flushMicrotasks();
  assert.equal(opening.calls.includes('selector.promote:primary'), false);
  assert.equal(opening.calls.includes('scheduler.periodic:30000'), false);
  assert.equal(opening.supervisor.activeProviderId(), null);
  assert.equal(opening.supervisor.state(), 'STOPPED');

  const promoted = supervisorFixture();
  promoted.strictResults.push(Promise.resolve(scanResult('primary')));
  await promoted.supervisor.start();
  promoted.scheduler.fireNext(0);
  await flushMicrotasks();
  promoted.resolveOpenSession();
  await flushMicrotasks();
  assert.equal(promoted.supervisor.activeProviderId(), 'primary');

  await promoted.supervisor.close();
  assert.equal(promoted.scheduler.pendingDelays().length, 0);
  assert.equal(promoted.supervisor.activeProviderId(), null);
  assert.equal(promoted.dependencies.promoted.activeProviderId(), null);
  assert.equal(promoted.calls.includes('selector.clear:primary'), true);
});

interface FixtureOptions {
  readonly ownerFailure?: Error;
  readonly ownerSnapshot?: WebSocketHealthSnapshot;
  readonly transitionFailure?: WebSocketHealthTransition['phase'];
  readonly transitionError?: Error;
  readonly mutableTransitionResult?: WebSocketHealthTransition['phase'];
  readonly scheduleFailureDelay?: number;
  readonly scheduleError?: Error;
}

interface SupervisorFixture {
  readonly calls: string[];
  readonly scheduler: ManualScheduler;
  readonly reporter: RecordingReporter;
  readonly supervisor: WebSocketFailoverSupervisor;
  readonly dependencies: WebSocketFailoverSupervisorDependencies;
  readonly options: WebSocketFailoverSupervisorOptions;
  readonly strictResults: Promise<StrictCatchUpScanResult>[];
  readonly strictCalls: StrictCall[];
  readonly openSessionDeferred: Deferred<WsProgramSession>;
  readonly completionDeferred: Deferred<WsProgramSessionCompletion>;
  readonly resolveOpenSession: () => void;
  readonly completionThenCalls: number;
  readonly observe: ((notification: WsProgramNotification) => Promise<void>) | null;
  readonly openedEndpoint: Readonly<{ id: RpcProviderId; url: string }> | null;
  readonly openSignal: AbortSignal | null;
}

interface StrictCall {
  readonly providerId: RpcProviderId;
  readonly signal: AbortSignal;
}

function supervisorFixture(settings: FixtureOptions = {}): SupervisorFixture {
  const calls: string[] = [];
  const scheduler = new ManualScheduler(
    calls,
    settings.scheduleFailureDelay,
    settings.scheduleError,
  );
  const reporter = new RecordingReporter(
    calls,
    settings.transitionFailure,
    settings.transitionError,
    settings.mutableTransitionResult,
  );
  const selector = new RecordingSelector(calls);
  const strictResults: Promise<StrictCatchUpScanResult>[] = [];
  const strictCalls: StrictCall[] = [];
  const openSessionDeferred = deferred<WsProgramSession>();
  const completionDeferred = deferred<WsProgramSessionCompletion>();
  let completionThenCalls = 0;
  const completion = completionDeferred.promise;
  const originalThen = completion.then.bind(completion);
  void Object.defineProperty(completion, 'then', {
    value: (...parameters: Parameters<typeof originalThen>): ReturnType<typeof originalThen> => {
      completionThenCalls += 1;
      calls.push('session.completion.attach');
      return originalThen(...parameters);
    },
  });
  const session: WsProgramSession = Object.freeze({
    endpointId: 'primary',
    completion,
    async close(): Promise<void> { calls.push('session.close:primary'); },
  });
  let observe: ((notification: WsProgramNotification) => Promise<void>) | null = null;
  let openedEndpoint: Readonly<{ id: RpcProviderId; url: string }> | null = null;
  let openSignal: AbortSignal | null = null;
  const openSession: typeof openWsProgramSession = (endpoint, nextObserve, signal) => {
    calls.push(`session.open:${endpoint.id}`);
    openedEndpoint = endpoint;
    observe = nextObserve;
    openSignal = signal;
    return openSessionDeferred.promise;
  };
  const providers = new RecordingCatalog(calls);
  const dependencies: WebSocketFailoverSupervisorDependencies = Object.freeze({
    providers,
    health: Object.freeze({
      beginOwner(input: Readonly<{ candidateProviderId: RpcProviderId }>) {
        calls.push(`health.beginOwner:${input.candidateProviderId}`);
        if (settings.ownerFailure !== undefined) return Promise.reject(settings.ownerFailure);
        return Promise.resolve(settings.ownerSnapshot ?? snapshot('CONNECTING', 1n));
      },
    }),
    reporter,
    promoted: selector,
    openSession,
    runStrictScan(providerId: RpcProviderId, signal: AbortSignal): Promise<StrictCatchUpScanResult> {
      calls.push(`strict.scan:${providerId}`);
      strictCalls.push(Object.freeze({ providerId, signal }));
      return strictResults.shift() ?? Promise.reject(new Error('Unexpected strict scan.'));
    },
  });
  const options: WebSocketFailoverSupervisorOptions = Object.freeze({
    now: () => 1_000,
    random: () => 0.5,
    scheduler: Object.freeze({
      schedule(callback: () => void, delayMs: number): unknown {
        return scheduler.schedule(callback, delayMs);
      },
      cancel(handle: unknown): void { scheduler.cancel(handle); },
    }),
  });
  const supervisor = new WebSocketFailoverSupervisor(dependencies, options);

  return {
    calls,
    scheduler,
    reporter,
    supervisor,
    dependencies,
    options,
    strictResults,
    strictCalls,
    openSessionDeferred,
    completionDeferred,
    resolveOpenSession() { openSessionDeferred.resolve(session); },
    get completionThenCalls() { return completionThenCalls; },
    get observe() { return observe; },
    get openedEndpoint() { return openedEndpoint; },
    get openSignal() { return openSignal; },
  };
}

class RecordingCatalog implements RpcProviderCatalog {
  public readonly ids = Object.freeze(['primary'] as const);

  public constructor(private readonly calls: string[]) {}

  public resolve(id: RpcProviderId): RpcProviderPair {
    this.calls.push(`catalog.resolve:${id}`);
    return Object.freeze({
      id,
      httpUrl: 'https://rpc.example/http',
      websocketUrl: 'wss://rpc.example/ws',
    });
  }
}

class RecordingReporter extends PersistentWebSocketHealthReporter {
  public readonly transitions: WebSocketHealthTransition[] = [];
  public readonly observations: RecordedObservation[] = [];
  public stopCalls = 0;

  public constructor(
    private readonly calls: string[],
    private readonly transitionFailure?: WebSocketHealthTransition['phase'],
    private readonly transitionError: Error = new Error('Expected transition failure.'),
    private readonly mutableTransitionResult?: WebSocketHealthTransition['phase'],
  ) {
    super(
      { async enqueue() {} },
      new InertHealthRepository(),
      {
        touchIntervalMs: 5,
        shutdownTimeoutMs: 20,
        scheduler: Object.freeze({ schedule: () => Object.freeze({}), cancel: () => undefined }),
      },
    );
  }

  public override startTouch(value: WebSocketHealthSnapshot): void {
    this.calls.push(`reporter.startTouch:${value.ownerGeneration}`);
  }

  public override transition(input: WebSocketHealthTransition): Promise<WebSocketHealthSnapshot> {
    this.calls.push(`health.transition:${input.phase}`);
    this.transitions.push(input);
    if (input.phase === this.transitionFailure) return Promise.reject(this.transitionError);
    const next = snapshotFromTransition(input);
    return Promise.resolve(input.phase === this.mutableTransitionResult ? { ...next } : next);
  }

  public override observe(
    notification: TransactionNotification,
    ownerGeneration: bigint,
    sessionGeneration: bigint,
  ): Promise<void> {
    this.observations.push(Object.freeze({ notification, ownerGeneration, sessionGeneration }));
    return Promise.resolve();
  }

  public override async stop(cleanup: () => Promise<void>): Promise<void> {
    this.stopCalls += 1;
    this.calls.push('reporter.stop');
    await cleanup();
  }
}

interface RecordedObservation {
  readonly notification: TransactionNotification;
  readonly ownerGeneration: bigint;
  readonly sessionGeneration: bigint;
}

class RecordingSelector extends PromotedProviderSelector {
  public constructor(private readonly calls: string[]) {
    super([providerPass('primary')]);
  }

  public override promote(providerId: RpcProviderId): void {
    this.calls.push(`selector.promote:${providerId}`);
    super.promote(providerId);
  }

  public override clear(providerId: RpcProviderId): void {
    this.calls.push(`selector.clear:${providerId}`);
    super.clear(providerId);
  }
}

class ManualScheduler {
  private readonly tasks: ManualTask[] = [];
  private nextId = 0;
  public readonly cancelledHandles: unknown[] = [];

  public constructor(
    private readonly calls: string[],
    private readonly failureDelay?: number,
    private readonly failure: Error = new Error('Expected scheduler failure.'),
  ) {}

  public schedule(callback: () => void, delayMs: number): unknown {
    this.calls.push(`scheduler.${delayMs === 0 ? 'recovery' : 'periodic'}:${delayMs}`);
    if (delayMs === this.failureDelay) throw this.failure;
    const handle = Object.freeze({ id: ++this.nextId });
    this.tasks.push({ callback, delayMs, handle, cancelled: false, fired: false });
    return handle;
  }

  public cancel(handle: unknown): void {
    this.cancelledHandles.push(handle);
    const task = this.tasks.find((value) => value.handle === handle);
    if (task !== undefined) task.cancelled = true;
  }

  public fireNext(delayMs: number): void {
    const task = this.tasks.find(
      (value) => value.delayMs === delayMs && !value.cancelled && !value.fired,
    );
    if (task === undefined) throw new Error('No matching scheduler task.');
    task.fired = true;
    task.callback();
  }

  public pendingDelays(): number[] {
    return this.tasks
      .filter((value) => !value.cancelled && !value.fired)
      .map(({ delayMs }) => delayMs);
  }
}

interface ManualTask {
  readonly callback: () => void;
  readonly delayMs: number;
  readonly handle: object;
  cancelled: boolean;
  fired: boolean;
}

class InertHealthRepository implements WebSocketHealthRepository {
  public read(): Promise<WebSocketHealthSnapshot> { return Promise.resolve(snapshot('STOPPED', 0n)); }
  public beginOwner(): Promise<WebSocketHealthSnapshot> {
    return Promise.resolve(snapshot('CONNECTING', 1n));
  }
  public transition(): Promise<WebSocketHealthSnapshot> {
    return Promise.reject(new Error('Inert transition.'));
  }
  public touch(): Promise<void> { return Promise.resolve(); }
  public recordObservation(): Promise<'RECORDED'> { return Promise.resolve('RECORDED'); }
}

function snapshot(
  phase: 'STOPPED' | 'CONNECTING',
  revision: bigint,
): WebSocketHealthSnapshot {
  const inactive = phase === 'STOPPED';
  return createWebSocketHealthSnapshot({
    payloadVersion: 1,
    supervision: inactive ? 'INACTIVE' : 'ACTIVE',
    ownerGeneration: inactive ? 0n : 1n,
    revision,
    activeSessionGeneration: null,
    candidateSessionGeneration: inactive ? null : 1n,
    providerId: null,
    candidateProviderId: inactive ? null : 'primary',
    phase,
    acknowledgedAtMs: null,
    lastObservation: null,
    disconnect: null,
    recovery: inactive
      ? { status: 'NOT_REQUIRED', startedAtMs: null, completedAtMs: null, reasonCode: null }
      : { status: 'REQUIRED', startedAtMs: null, completedAtMs: null, reasonCode: 'STARTUP' },
    heartbeatAtMs: inactive ? null : 1_000,
    updatedAtMs: 1_000,
    evidencePurgeAfterMs: null,
  });
}

function connectingSnapshot(providerId: RpcProviderId): WebSocketHealthSnapshot {
  return createWebSocketHealthSnapshot({
    payloadVersion: 1,
    supervision: 'ACTIVE',
    ownerGeneration: 1n,
    revision: 1n,
    activeSessionGeneration: null,
    candidateSessionGeneration: 1n,
    providerId: null,
    candidateProviderId: providerId,
    phase: 'CONNECTING',
    acknowledgedAtMs: null,
    lastObservation: null,
    disconnect: null,
    recovery: {
      status: 'REQUIRED',
      startedAtMs: null,
      completedAtMs: null,
      reasonCode: 'STARTUP',
    },
    heartbeatAtMs: 1_000,
    updatedAtMs: 1_000,
    evidencePurgeAfterMs: null,
  });
}

function snapshotFromTransition(input: WebSocketHealthTransition): WebSocketHealthSnapshot {
  const startedAtMs = input.recoveryStatus === 'REQUIRED'
    || input.recoveryStatus === 'NOT_REQUIRED' ? null : 1_000;
  const completedAtMs = input.recoveryStatus === 'RECOVERED'
    || input.recoveryStatus === 'FAILED' ? 1_000 : null;
  return createWebSocketHealthSnapshot({
    payloadVersion: 1,
    supervision: 'ACTIVE',
    ownerGeneration: input.ownerGeneration,
    revision: input.expectedRevision + 1n,
    activeSessionGeneration: input.activeSessionGeneration,
    candidateSessionGeneration: input.candidateSessionGeneration,
    providerId: input.providerId,
    candidateProviderId: input.candidateProviderId,
    phase: input.phase,
    acknowledgedAtMs: input.acknowledged ? 1_000 : null,
    lastObservation: null,
    disconnect: null,
    recovery: {
      status: input.recoveryStatus,
      startedAtMs,
      completedAtMs,
      reasonCode: input.recoveryReasonCode,
    },
    heartbeatAtMs: 1_000,
    updatedAtMs: 1_000,
    evidencePurgeAfterMs: null,
  });
}

function waitingTransition(expectedRevision: bigint): WebSocketHealthTransition {
  return {
    ownerGeneration: 1n,
    expectedRevision,
    phase: 'WAITING_FOR_ACKS',
    providerId: null,
    activeSessionGeneration: null,
    candidateProviderId: 'primary',
    candidateSessionGeneration: 1n,
    acknowledged: false,
    disconnectReasonCode: null,
    recoveryStatus: 'REQUIRED',
    recoveryReasonCode: 'STARTUP',
  };
}

function providerPass(providerId: RpcProviderId): FinalityProviderPass {
  return Object.freeze({
    providerId,
    async getHistoryStatuses() { return Object.freeze([]); },
    async getFinalizedSlot() { return 0n; },
    async getFinalizedBlockSignatures() { return Object.freeze([]); },
  });
}

function scanResult(providerId: RpcProviderId): StrictCatchUpScanResult {
  return Object.freeze({
    providerId,
    discoveredCount: 0,
    enqueuedCount: 0,
    checkpointCasCount: 0,
    pageCount: 2,
    boundaries: Object.freeze({ launchpad: null, market: null }),
  });
}

async function assertStage(
  operation: Promise<unknown>,
  stage: WebSocketFailoverSupervisorError['stage'],
  hostile: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof WebSocketFailoverSupervisorError);
    assert.equal(error.name, 'WebSocketFailoverSupervisorError');
    assert.equal(error.message, 'WebSocket failover supervisor operation failed.');
    assert.equal(error.stage, stage);
    assert.equal(Object.isFrozen(error), true);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(String(error).includes(hostile), false);
    return true;
  });
}

function assertNoSolanaCall(fixture: SupervisorFixture): void {
  assert.equal(fixture.calls.some((call) => call.startsWith('session.open')), false);
  assert.equal(fixture.calls.some((call) => call.startsWith('strict.scan')), false);
  assert.equal(fixture.calls.some((call) => call.startsWith('catalog.resolve')), false);
}

function assertInvalidConstructor(
  dependencies: unknown,
  options: unknown,
  hostile: string,
): void {
  assert.throws(
    () => new WebSocketFailoverSupervisor(
      dependencies as WebSocketFailoverSupervisorDependencies,
      options as WebSocketFailoverSupervisorOptions,
    ),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'WebSocket failover supervisor configuration is invalid.');
      assert.equal(Object.hasOwn(error, 'cause'), false);
      assert.equal(String(error).includes(hostile), false);
      assert.doesNotMatch(String(error), /secret|invalid\/ws|signature/u);
      return true;
    },
  );
}

interface Deferred<TValue> {
  readonly promise: Promise<TValue>;
  readonly resolve: (value: TValue) => void;
  readonly settled: () => boolean;
}

function deferred<TValue>(): Deferred<TValue> {
  let complete = false;
  let resolvePromise: ((value: TValue) => void) | undefined;
  const promise = new Promise<TValue>((resolve) => { resolvePromise = resolve; });
  return Object.freeze({
    promise,
    resolve(value: TValue): void {
      complete = true;
      resolvePromise?.(value);
    },
    settled(): boolean { return complete; },
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
