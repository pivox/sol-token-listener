import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebSocketHealthSnapshot,
  type WebSocketHealthPhase,
  type WebSocketHealthSnapshot,
} from '../src/domain/websocket-health.js';
import type { TransactionNotification } from '../src/domain/transaction-ingestion.js';
import type {
  WebSocketHealthRepository,
  WebSocketHealthTransition,
} from '../src/ports/websocket-health-repository.js';
import {
  PersistentWebSocketHealthReporter,
  WebSocketHealthReporterError,
  type WebSocketHealthReporterScheduler,
} from '../src/application/websocket-health-reporter.js';

void test('websocket health reporter persists transitions immediately and degrades on failure', async () => {
  const repository = new FakeHealthRepository();
  const reporter = reporterFixture(repository).reporter;
  const connecting = snapshot('CONNECTING', 1n);
  reporter.startTouch(connecting);
  const waiting = snapshot('WAITING_FOR_ACKS', 2n);
  repository.transitionResults.push(Promise.resolve(waiting));

  const operation = reporter.transition(transitionFrom(connecting, {
    phase: 'WAITING_FOR_ACKS',
  }));
  assert.equal(repository.transitions.length, 1);
  assert.equal(reporter.state(), 'CONNECTING');
  assert.equal(await operation, waiting);
  assert.equal(reporter.state(), 'WAITING_FOR_ACKS');

  const dependency = new Error('secret rpc transition');
  repository.transitionResults.push(Promise.reject(dependency));
  await assertReporterCode(
    reporter.transition(transitionFrom(waiting, { phase: 'ACKNOWLEDGED', acknowledged: true })),
    'TRANSITION_FAILED',
  );
  assert.equal(reporter.state(), 'DEGRADED');
});

void test('websocket health reporter rejects a mutable repository snapshot and remains degraded', async () => {
  const repository = new FakeHealthRepository();
  const reporter = reporterFixture(repository).reporter;
  const connecting = snapshot('CONNECTING', 1n);
  reporter.startTouch(connecting);
  repository.transitionResults.push(Promise.resolve({
    ...snapshot('WAITING_FOR_ACKS', 2n),
  }));

  await assertReporterCode(
    reporter.transition(transitionFrom(connecting, { phase: 'WAITING_FOR_ACKS' })),
    'TRANSITION_FAILED',
  );
  assert.equal(reporter.state(), 'DEGRADED');
});

void test('websocket health reporter serializes and coalesces periodic touches', async () => {
  const repository = new FakeHealthRepository();
  const firstTouch = deferred<undefined>();
  repository.touchResults.push(firstTouch.promise, Promise.resolve());
  const { reporter, scheduler } = reporterFixture(repository);

  reporter.startTouch(snapshot('RUNNING', 2n));
  assert.deepEqual(scheduler.pendingDelays(), [5]);
  scheduler.fireNext(5);
  await flushMicrotasks();
  assert.deepEqual(repository.touches, [1n]);
  assert.deepEqual(scheduler.pendingDelays(), [5]);

  scheduler.fireNext(5);
  await flushMicrotasks();
  assert.deepEqual(repository.touches, [1n]);
  assert.deepEqual(scheduler.pendingDelays(), [5]);

  firstTouch.resolve(undefined);
  await flushMicrotasks();
  assert.deepEqual(repository.touches, [1n, 1n]);
  await flushMicrotasks();
  assert.deepEqual(scheduler.pendingDelays(), [5]);
});

void test('websocket health reporter fences an in-flight touch, stops once, and ignores stale timers', async () => {
  const repository = new FakeHealthRepository();
  const touch = deferred<undefined>();
  const cleanup = deferred<undefined>();
  repository.touchResults.push(touch.promise);
  repository.transitionResults.push(
    Promise.resolve(snapshot('STOPPING', 3n, true)),
    Promise.resolve(snapshot('STOPPED', 4n, true)),
  );
  const { reporter, scheduler } = reporterFixture(repository);
  reporter.startTouch(snapshot('RUNNING', 2n, true));
  const consumedTouchCallback = scheduler.latestCallback();
  scheduler.fireNext(5);
  const pendingTouchCallback = scheduler.latestCallback();
  await flushMicrotasks();

  let cleanupCalls = 0;
  const stopping = reporter.stop(async () => {
    cleanupCalls += 1;
    await cleanup.promise;
  });
  assert.equal(reporter.stop(async () => undefined), stopping);
  assert.equal(repository.transitions[0]?.phase, 'STOPPING');
  assert.equal(scheduler.pendingDelays().includes(5), false);
  await flushMicrotasks();
  assert.equal(cleanupCalls, 0);
  assert.equal(repository.transitions.some((value) => value.phase === 'STOPPED'), false);

  touch.resolve(undefined);
  await flushMicrotasks();
  assert.equal(cleanupCalls, 1);
  assert.equal(repository.transitions.some((value) => value.phase === 'STOPPED'), false);

  cleanup.resolve(undefined);
  await stopping;
  assert.deepEqual(repository.transitions.map((value) => value.phase), ['STOPPING', 'STOPPED']);
  assert.deepEqual(repository.transitions.map((value) => value.disconnectReasonCode), [null, null]);
  assert.equal(reporter.state(), 'STOPPED');
  const touchCount = repository.touches.length;
  consumedTouchCallback();
  pendingTouchCallback();
  await flushMicrotasks();
  assert.equal(repository.touches.length, touchCount);
});

void test('websocket health reporter bounds stuck cleanup and persists cleanup failure as degraded', async () => {
  const repository = new FakeHealthRepository();
  repository.transitionResults.push(
    Promise.resolve(snapshot('STOPPING', 3n)),
    Promise.resolve(snapshot('DEGRADED', 4n, true)),
  );
  const { reporter, scheduler } = reporterFixture(repository);
  reporter.startTouch(snapshot('RUNNING', 2n));

  let cleanupCalls = 0;
  const stopping = reporter.stop(() => {
    cleanupCalls += 1;
    return new Promise<void>(() => undefined);
  });
  await flushMicrotasks();
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(scheduler.pendingDelays(), [20]);

  scheduler.fireNext(20);
  await assertReporterCode(stopping, 'SHUTDOWN_TIMEOUT');
  assert.equal(reporter.state(), 'DEGRADED');
  assert.deepEqual(repository.transitions.map((value) => value.phase), ['STOPPING', 'DEGRADED']);
  const degraded = repository.transitions[1];
  assert.equal(degraded?.disconnectReasonCode, 'CLEANUP_FAILED');
  assert.equal(degraded?.recoveryStatus, 'FAILED');
  assert.equal(degraded?.recoveryReasonCode, 'SESSION_FAILURE');
  assert.equal(reporter.stop(async () => undefined), stopping);
});

void test('websocket health reporter bounds a stuck touch before invoking cleanup', async () => {
  const repository = new FakeHealthRepository();
  repository.touchResults.push(new Promise<undefined>(() => undefined));
  repository.transitionResults.push(Promise.resolve(snapshot('STOPPING', 3n)));
  const { reporter, scheduler } = reporterFixture(repository);
  reporter.startTouch(snapshot('RUNNING', 2n));
  scheduler.fireNext(5);
  await flushMicrotasks();

  let cleanupCalls = 0;
  const stopping = reporter.stop(async () => { cleanupCalls += 1; });
  await flushMicrotasks();
  assert.equal(cleanupCalls, 0);
  assert.deepEqual(scheduler.pendingDelays(), [20]);
  scheduler.fireNext(20);

  await assertReporterCode(stopping, 'SHUTDOWN_TIMEOUT');
  assert.equal(cleanupCalls, 0);
  assert.equal(reporter.state(), 'DEGRADED');
  assert.deepEqual(repository.transitions.map((value) => value.phase), ['STOPPING']);
});

void test('websocket health reporter keeps rejected cleanup degraded and redacted', async () => {
  const repository = new FakeHealthRepository();
  repository.transitionResults.push(
    Promise.resolve(snapshot('STOPPING', 3n)),
    Promise.resolve(snapshot('DEGRADED', 4n, true)),
  );
  const { reporter } = reporterFixture(repository);
  reporter.startTouch(snapshot('RUNNING', 2n));

  await assertReporterCode(
    reporter.stop(() => Promise.reject(new Error('secret remote cleanup'))),
    'CLEANUP_FAILED',
  );
  assert.equal(reporter.state(), 'DEGRADED');
  assert.equal(repository.transitions.at(-1)?.phase, 'DEGRADED');
});

void test('websocket health reporter enqueues before recording a partial-ACK observation', async () => {
  const repository = new FakeHealthRepository();
  const order: string[] = [];
  const durable = deferred<undefined>();
  const inbox = {
    async enqueue(value: TransactionNotification): Promise<void> {
      assert.equal(value, notification);
      order.push('enqueue:start');
      await durable.promise;
      order.push('enqueue:done');
    },
  };
  repository.recordObservationResult = async (input) => {
    order.push('health:start');
    assert.deepEqual(input, { ownerGeneration: 7n, sessionGeneration: 9n, slot: 42n });
    assert.equal(Object.hasOwn(input, 'signature'), false);
    return 'STALE_SESSION';
  };
  const reporter = new PersistentWebSocketHealthReporter(inbox, repository, reporterOptions());

  const observed = reporter.observe(notification, 7n, 9n);
  assert.deepEqual(order, ['enqueue:start']);
  assert.equal(repository.observations.length, 0);
  durable.resolve(undefined);
  await observed;
  assert.deepEqual(order, ['enqueue:start', 'enqueue:done', 'health:start']);
  assert.equal(repository.observations.length, 1);
});

void test('websocket health reporter never advances health after enqueue rejection', async () => {
  const repository = new FakeHealthRepository();
  const reporter = new PersistentWebSocketHealthReporter({
    async enqueue() { throw new Error('secret database enqueue'); },
  }, repository, reporterOptions());

  await assertReporterCode(reporter.observe(notification, 1n, 1n), 'ENQUEUE_FAILED');
  assert.equal(repository.observations.length, 0);
  assert.equal(reporter.state(), 'DEGRADED');
});

void test('websocket health reporter rejects a health failure only after durable enqueue', async () => {
  const repository = new FakeHealthRepository();
  let durable = false;
  const inbox = {
    async enqueue(): Promise<void> { durable = true; },
  };
  repository.recordObservationResult = async () => {
    assert.equal(durable, true);
    throw new Error('secret health dependency');
  };
  const reporter = new PersistentWebSocketHealthReporter(inbox, repository, reporterOptions());

  await assertReporterCode(reporter.observe(notification, 1n, 1n), 'OBSERVATION_FAILED');
  assert.equal(durable, true);
  assert.equal(repository.observations.length, 1);
  assert.equal(reporter.state(), 'DEGRADED');
});

void test('websocket health reporter rejects a non-canonical observation result', async () => {
  const repository = new FakeHealthRepository();
  repository.recordObservationResult = async () => 'INVALID' as never;
  const reporter = new PersistentWebSocketHealthReporter(
    { async enqueue() {} },
    repository,
    reporterOptions(),
  );

  await assertReporterCode(reporter.observe(notification, 1n, 1n), 'OBSERVATION_FAILED');
  assert.equal(reporter.state(), 'DEGRADED');
});

void test('websocket health reporter captures the notification slot before durable enqueue waits', async () => {
  const repository = new FakeHealthRepository();
  const mutableNotification = { ...notification };
  const reporter = new PersistentWebSocketHealthReporter({
    async enqueue() { mutableNotification.slot = 99n; },
  }, repository, reporterOptions());

  await reporter.observe(mutableNotification, 1n, 1n);
  assert.equal(repository.observations[0]?.slot, 42n);
});

void test('websocket health reporter enforces fixed timing and scheduler bounds', () => {
  const repository = new FakeHealthRepository();
  assert.doesNotThrow(() => new PersistentWebSocketHealthReporter(
    { async enqueue() {} },
    repository,
    {
      touchIntervalMs: 2_147_483_647,
      shutdownTimeoutMs: 120_000,
      scheduler: new ManualScheduler(),
    },
  ));
  for (const options of [
    { touchIntervalMs: 0, shutdownTimeoutMs: 20 },
    { touchIntervalMs: 2_147_483_648, shutdownTimeoutMs: 20 },
    { touchIntervalMs: 1.5, shutdownTimeoutMs: 20 },
    { touchIntervalMs: 5, shutdownTimeoutMs: 0 },
    { touchIntervalMs: 5, shutdownTimeoutMs: 120_001 },
    { touchIntervalMs: 5, shutdownTimeoutMs: 1.5 },
  ]) {
    assert.throws(
      () => new PersistentWebSocketHealthReporter(
        { async enqueue() {} },
        repository,
        options,
      ),
      (error: unknown) => error instanceof WebSocketHealthReporterError
        && error.code === 'STATE_CONFLICT',
    );
  }
});

const notification: TransactionNotification = Object.freeze({
  signature: 'secret-signature-never-forwarded',
  slot: 42n,
  source: 'WEBSOCKET',
  programIds: Object.freeze(['11111111111111111111111111111111']),
  confirmationStatus: 'processed',
  observedAtMs: 1_000,
});

class FakeHealthRepository implements WebSocketHealthRepository {
  public readonly transitions: WebSocketHealthTransition[] = [];
  public readonly touches: bigint[] = [];
  public readonly observations: Parameters<WebSocketHealthRepository['recordObservation']>[0][] = [];
  public readonly transitionResults: Promise<WebSocketHealthSnapshot>[] = [];
  public readonly touchResults: Promise<void>[] = [];
  public recordObservationResult: WebSocketHealthRepository['recordObservation'] =
    async () => 'RECORDED';

  public async read(): Promise<WebSocketHealthSnapshot> {
    return snapshot('STOPPED', 0n);
  }

  public async beginOwner(): Promise<WebSocketHealthSnapshot> {
    return snapshot('CONNECTING', 1n);
  }

  public transition(input: WebSocketHealthTransition): Promise<WebSocketHealthSnapshot> {
    this.transitions.push(input);
    return this.transitionResults.shift()
      ?? Promise.reject(new Error('Unexpected transition.'));
  }

  public touch(ownerGeneration: bigint): Promise<void> {
    this.touches.push(ownerGeneration);
    return this.touchResults.shift() ?? Promise.resolve();
  }

  public recordObservation(
    input: Parameters<WebSocketHealthRepository['recordObservation']>[0],
  ): Promise<'RECORDED' | 'STALE_SESSION'> {
    this.observations.push(input);
    return this.recordObservationResult(input);
  }
}

function reporterFixture(repository: FakeHealthRepository): {
  readonly reporter: PersistentWebSocketHealthReporter;
  readonly scheduler: ManualScheduler;
} {
  const scheduler = new ManualScheduler();
  return {
    reporter: new PersistentWebSocketHealthReporter(
      { async enqueue() {} },
      repository,
      reporterOptions(scheduler),
    ),
    scheduler,
  };
}

function reporterOptions(scheduler: ManualScheduler = new ManualScheduler()): {
  readonly touchIntervalMs: number;
  readonly shutdownTimeoutMs: number;
  readonly scheduler: WebSocketHealthReporterScheduler;
} {
  return Object.freeze({ touchIntervalMs: 5, shutdownTimeoutMs: 20, scheduler });
}

function snapshot(
  phase: WebSocketHealthPhase,
  revision: bigint,
  cleanupFailed = false,
): WebSocketHealthSnapshot {
  const stopped = phase === 'STOPPED';
  const candidate = phase === 'CONNECTING' || phase === 'WAITING_FOR_ACKS'
    || phase === 'ACKNOWLEDGED' || phase === 'RECOVERING';
  const acknowledged = phase === 'ACKNOWLEDGED' || phase === 'RECOVERING'
    || phase === 'RUNNING' || phase === 'STOPPING' || phase === 'DEGRADED';
  const active = !stopped && !candidate;
  return createWebSocketHealthSnapshot({
    payloadVersion: 1,
    supervision: 'ACTIVE',
    ownerGeneration: 1n,
    revision,
    activeSessionGeneration: active ? 1n : null,
    candidateSessionGeneration: candidate ? 1n : null,
    providerId: active ? 'primary' : null,
    candidateProviderId: candidate ? 'primary' : null,
    phase,
    acknowledgedAtMs: acknowledged ? 900 : null,
    lastObservation: null,
    disconnect: cleanupFailed ? { occurredAtMs: 1_000, reasonCode: 'CLEANUP_FAILED' } : null,
    recovery: cleanupFailed
      ? { status: 'FAILED', startedAtMs: 950, completedAtMs: 1_000, reasonCode: 'SESSION_FAILURE' }
      : { status: 'NOT_REQUIRED', startedAtMs: null, completedAtMs: null, reasonCode: null },
    heartbeatAtMs: stopped ? 1_000 : 900,
    updatedAtMs: 1_000,
    evidencePurgeAfterMs: null,
  });
}

function transitionFrom(
  value: WebSocketHealthSnapshot,
  overrides: Partial<WebSocketHealthTransition> = {},
): WebSocketHealthTransition {
  return {
    ownerGeneration: value.ownerGeneration,
    expectedRevision: value.revision,
    phase: value.phase,
    providerId: value.providerId,
    activeSessionGeneration: value.activeSessionGeneration,
    candidateProviderId: value.candidateProviderId,
    candidateSessionGeneration: value.candidateSessionGeneration,
    acknowledged: value.acknowledgedAtMs !== null,
    disconnectReasonCode: value.disconnect?.reasonCode ?? null,
    recoveryStatus: value.recovery.status,
    recoveryReasonCode: value.recovery.reasonCode,
    ...overrides,
  };
}

class ManualScheduler implements WebSocketHealthReporterScheduler {
  private readonly tasks: ManualTask[] = [];
  private lastCallback: (() => void) | null = null;
  private nextId = 0;

  public schedule(callback: () => void, delayMs: number): object {
    const handle = Object.freeze({ id: ++this.nextId });
    this.tasks.push({ handle, callback, delayMs, cancelled: false, fired: false });
    this.lastCallback = callback;
    return handle;
  }

  public cancel(handle: unknown): void {
    const task = this.tasks.find((candidate) => candidate.handle === handle);
    if (task !== undefined) task.cancelled = true;
  }

  public pendingDelays(): number[] {
    return this.tasks
      .filter((task) => !task.cancelled && !task.fired)
      .map((task) => task.delayMs);
  }

  public fireNext(delayMs: number): void {
    const task = this.tasks.find(
      (candidate) => !candidate.cancelled && !candidate.fired && candidate.delayMs === delayMs,
    );
    if (task === undefined) throw new Error('No matching scheduled callback.');
    task.fired = true;
    this.lastCallback = task.callback;
    task.callback();
  }

  public latestCallback(): () => void {
    if (this.lastCallback === null) throw new Error('No callback has been scheduled.');
    return this.lastCallback;
  }
}

interface ManualTask {
  readonly handle: object;
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
  fired: boolean;
}

interface Deferred<TValue> {
  readonly promise: Promise<TValue>;
  readonly resolve: (value: TValue) => void;
}

function deferred<TValue>(): Deferred<TValue> {
  let resolve: ((value: TValue) => void) | undefined;
  const promise = new Promise<TValue>((received) => { resolve = received; });
  return {
    promise,
    resolve(value: TValue) {
      if (resolve === undefined) throw new Error('Deferred resolver unavailable.');
      resolve(value);
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function assertReporterCode(
  operation: Promise<unknown>,
  code: WebSocketHealthReporterError['code'],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof WebSocketHealthReporterError);
    assert.equal(error.code, code);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.doesNotMatch(String(error), /secret|rpc|database|signature|remote/iu);
    return true;
  });
}
