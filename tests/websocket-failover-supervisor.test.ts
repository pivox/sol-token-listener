import assert from 'node:assert/strict';
import test from 'node:test';
import { PromotedProviderSelector } from '../src/application/promoted-provider-selector.js';
import { PersistentWebSocketHealthReporter } from '../src/application/websocket-health-reporter.js';
import {
  WEBSOCKET_FRONTIER_INTERVAL_MS,
  WEBSOCKET_BACKOFF_BASE_MS,
  WEBSOCKET_BACKOFF_CAP_MS,
  equalJitterDelay,
  WebSocketFailoverSupervisor,
  WebSocketFailoverSupervisorError,
  type WebSocketFailoverScheduler,
  type WebSocketFailoverSupervisorDependencies,
  type WebSocketFailoverSupervisorOptions,
} from '../src/application/websocket-failover-supervisor.js';
import {
  StrictCatchUpAbortedError,
  StrictCatchUpScannerError,
  StrictCatchUpWindowExceededError,
  type StrictCatchUpScanResult,
} from '../src/application/strict-catch-up-scanner.js';
import {
  createWebSocketHealthSnapshot,
  type WebSocketHealthSnapshot,
} from '../src/domain/websocket-health.js';
import type { RpcProviderId } from '../src/domain/rpc-provider.js';
import type { TransactionNotification } from '../src/domain/transaction-ingestion.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import type { FinalityProviderPass } from '../src/ports/finality-provider-pass.js';
import type {
  WebSocketHealthRepository,
  WebSocketHealthTransition,
} from '../src/ports/websocket-health-repository.js';
import type { RpcProviderCatalog, RpcProviderPair } from '../src/solana/rpc/rpc-provider-catalog.js';
import {
  WS_PROGRAM_SESSION_CLEANUP_TIMEOUT_MS,
  WsProgramSessionError,
} from '../src/solana/rpc/ws-program-session.js';
import type {
  openWsProgramSession,
  WsProgramNotification,
  WsProgramSession,
  WsProgramSessionCompletion,
} from '../src/solana/rpc/ws-program-session.js';

void test('equal-jitter backoff uses exact capped zero-based delays and rejects hostile inputs', () => {
  assert.equal(equalJitterDelay(0, 0), 500);
  assert.equal(equalJitterDelay(0, 0.999), 999);
  assert.equal(equalJitterDelay(1, 0), 1_000);
  assert.equal(equalJitterDelay(20, 0), 30_000);
  assert.equal(equalJitterDelay(20, 0.999), 59_970);

  for (const [count, random] of [
    [-1, 0],
    [0.5, 0],
    [Number.MAX_SAFE_INTEGER + 1, 0],
    [0, -0.1],
    [0, 1],
    [0, Number.NaN],
    [0, Number.POSITIVE_INFINITY],
  ] as const) {
    assert.throws(
      () => equalJitterDelay(count, random),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.equal(error.message, 'WebSocket recovery backoff input is invalid.');
        assert.equal(Object.hasOwn(error, 'cause'), false);
        return true;
      },
    );
  }
});

void test('finite rotation resumes after fallback-1 and schedules one zero-based backoff', async () => {
  const providerIds = Object.freeze([
    'primary', 'fallback-1', 'fallback-2', 'fallback-3',
  ] as const);
  const fallbackOne = controlledSession('fallback-1');
  const fixture = supervisorFixture({
    providerIds,
    random: () => 0.5,
    sessionFactories: [
      () => Promise.reject(new WsProgramSessionError('SETUP_TIMEOUT')),
      () => Promise.resolve(fallbackOne.session),
      () => Promise.reject(new WsProgramSessionError('PROTOCOL_INVALID')),
      () => Promise.reject(new WsProgramSessionError('SOCKET_ERROR')),
      () => Promise.reject(new WsProgramSessionError('REMOTE_CLOSE')),
      () => Promise.reject(new WsProgramSessionError('NOTIFICATION_FAILED')),
    ],
  });
  fixture.strictResults.push(Promise.resolve(scanResult('fallback-1')));

  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();
  assert.equal(fixture.supervisor.activeProviderId(), 'fallback-1');

  fallbackOne.completion.resolve(Object.freeze({ reason: 'REMOTE_CLOSE' }));
  await flushLifecycle();
  assert.equal(fixture.supervisor.state(), 'DEGRADED');
  assert.equal(fixture.dependencies.promoted.activeProviderId(), null);
  fixture.scheduler.fireNext(0);
  await flushLifecycle();

  assert.deepEqual(
    fixture.calls
      .filter((call) => call.startsWith('session.open:'))
      .map((call) => call.slice('session.open:'.length)),
    ['primary', 'fallback-1', 'fallback-2', 'fallback-3', 'primary', 'fallback-1'],
  );
  assert.deepEqual(fixture.strictCalls.map(({ providerId }) => providerId), ['fallback-1']);
  assert.deepEqual(fixture.scheduler.pendingDelays(), [750]);
  assert.equal(fixture.reporter.transitions.filter(({ phase }) => phase === 'DEGRADED').length, 2);
  for (const transition of fixture.reporter.transitions.filter(
    ({ phase }) => phase === 'CONNECTING',
  )) {
    assert.equal(transition.candidateSessionGeneration, transition.expectedRevision + 1n);
  }
});

void test('rotation gives every acknowledged provider one strict scan and cleans each candidate', async () => {
  const providerIds = Object.freeze([
    'primary', 'fallback-1', 'fallback-2', 'fallback-3',
  ] as const);
  const sessions = providerIds.map((providerId) => controlledSession(providerId));
  const fixture = supervisorFixture({
    providerIds,
    random: () => 0,
    sessionFactories: sessions.map(({ session }) => () => Promise.resolve(session)),
  });
  fixture.strictResults.push(
    rejected(new StrictCatchUpScannerError('source', 'primary', 'launchpad', 'request')),
    rejected(new StrictCatchUpScannerError(
      'checkpoint-cas', 'fallback-1', 'market', null,
    )),
    rejected(new StrictCatchUpScannerError('source', 'fallback-2', 'market', 'response')),
    rejected(new StrictCatchUpScannerError(
      'checkpoint-read', 'fallback-3', 'launchpad', null,
    )),
  );

  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();

  assert.deepEqual(
    fixture.calls.filter((call) => call.startsWith('session.open:')),
    providerIds.map((id) => `session.open:${id}`),
  );
  assert.deepEqual(fixture.strictCalls.map(({ providerId }) => providerId), providerIds);
  assert.equal(sessions.every((session) => session.closeCalls() === 1), true);
  assert.equal(sessions.every((session) => session.closeSignals[0]?.aborted === false), true);
  assert.deepEqual(fixture.scheduler.pendingDelays(), [500]);
  assert.equal(fixture.supervisor.state(), 'DEGRADED');
});

void test('same-frontier exhaustion becomes durable unrecoverable without any timer', async () => {
  const providerIds = Object.freeze(['primary', 'fallback-1'] as const);
  const sessions = providerIds.map((providerId) => controlledSession(providerId));
  const frontier = strictFrontier('same');
  const fixture = supervisorFixture({
    providerIds,
    sessionFactories: sessions.map(({ session }) => () => Promise.resolve(session)),
  });
  fixture.strictResults.push(
    rejected(new StrictCatchUpWindowExceededError('primary', 'launchpad', frontier)),
    rejected(new StrictCatchUpWindowExceededError('fallback-1', 'market', frontier)),
  );

  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();

  const final = fixture.reporter.transitions.at(-1);
  assert.equal(final?.phase, 'UNRECOVERABLE');
  assert.equal(final?.candidateProviderId, null);
  assert.equal(final?.candidateSessionGeneration, null);
  assert.equal(final?.recoveryStatus, 'FAILED');
  assert.equal(final?.recoveryReasonCode, 'CATCH_UP_WINDOW_EXCEEDED');
  assert.equal(sessions.every((session) => session.closeCalls() === 1), true);
  assert.deepEqual(fixture.scheduler.pendingDelays(), []);
  assert.equal(fixture.supervisor.state(), 'DEGRADED');
  assert.equal(fixture.supervisor.activeProviderId(), null);
  assert.equal(fixture.dependencies.promoted.activeProviderId(), null);
});

void test('mixed or different frontier exhaustion remains degraded with one backoff', async () => {
  const variants = [
    [
      new StrictCatchUpWindowExceededError('primary', 'launchpad', strictFrontier('mixed')),
      new StrictCatchUpScannerError('source', 'fallback-1', 'market', 'request'),
    ],
    [
      new StrictCatchUpWindowExceededError('primary', 'launchpad', strictFrontier('left')),
      new StrictCatchUpWindowExceededError('fallback-1', 'market', strictFrontier('right')),
    ],
  ] as const;

  for (const failures of variants) {
    const providerIds = Object.freeze(['primary', 'fallback-1'] as const);
    const sessions = providerIds.map((providerId) => controlledSession(providerId));
    const fixture = supervisorFixture({
      providerIds,
      random: () => 0,
      sessionFactories: sessions.map(({ session }) => () => Promise.resolve(session)),
    });
    fixture.strictResults.push(...failures.map((failure) => rejected(failure)));

    await fixture.supervisor.start();
    fixture.scheduler.fireNext(0);
    await flushLifecycle();

    assert.equal(
      fixture.reporter.transitions.some(({ phase }) => phase === 'UNRECOVERABLE'),
      false,
    );
    assert.equal(fixture.reporter.transitions.at(-1)?.phase, 'DEGRADED');
    assert.deepEqual(fixture.scheduler.pendingDelays(), [500]);
    assert.equal(sessions.every((session) => session.closeCalls() === 1), true);
  }
});

void test('window errors thrown by openSession are transient and never prove unrecoverable', async () => {
  const providerIds = Object.freeze(['primary', 'fallback-1'] as const);
  const frontier = strictFrontier('hostile-open');
  const fixture = supervisorFixture({
    providerIds,
    random: () => 0,
    sessionFactories: providerIds.map((providerId) => () => rejected(
      new StrictCatchUpWindowExceededError(providerId, 'launchpad', frontier),
    )),
  });

  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();

  assert.deepEqual(
    fixture.calls.filter((call) => call.startsWith('session.open:')),
    ['session.open:primary', 'session.open:fallback-1'],
  );
  assert.equal(fixture.strictCalls.length, 0);
  assert.equal(
    fixture.reporter.transitions.some(({ phase }) => phase === 'UNRECOVERABLE'),
    false,
  );
  assert.equal(fixture.reporter.transitions.at(-1)?.phase, 'DEGRADED');
  assert.deepEqual(fixture.scheduler.pendingDelays(), [500]);
});

void test('window errors thrown by provider resolution are transient and never prove unrecoverable', async () => {
  const providerIds = Object.freeze(['primary', 'fallback-1'] as const);
  const frontier = strictFrontier('hostile-resolve');
  const fixture = supervisorFixture({
    providerIds,
    random: () => 0,
    resolveFailures: providerIds.map((providerId) => (
      new StrictCatchUpWindowExceededError(providerId, 'market', frontier)
    )),
  });

  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();

  assert.deepEqual(
    fixture.calls.filter((call) => call.startsWith('catalog.resolve:')),
    ['catalog.resolve:primary', 'catalog.resolve:fallback-1'],
  );
  assert.equal(fixture.calls.some((call) => call.startsWith('session.open:')), false);
  assert.equal(fixture.strictCalls.length, 0);
  assert.equal(
    fixture.reporter.transitions.some(({ phase }) => phase === 'UNRECOVERABLE'),
    false,
  );
  assert.equal(fixture.reporter.transitions.at(-1)?.phase, 'DEGRADED');
  assert.deepEqual(fixture.scheduler.pendingDelays(), [500]);
});

void test('non-shutdown strict aborts remain transient, rotate, and schedule one backoff', async () => {
  const providerIds = Object.freeze(['primary', 'fallback-1'] as const);
  const primary = controlledSession('primary');
  const fallback = controlledSession('fallback-1');
  const primaryScan = deferred<StrictCatchUpScanResult>();
  const fixture = supervisorFixture({
    providerIds,
    random: () => 0,
    sessionFactories: [
      () => Promise.resolve(primary.session),
      () => Promise.resolve(fallback.session),
    ],
  });
  fixture.strictResults.push(
    primaryScan.promise,
    rejected(new StrictCatchUpAbortedError()),
  );

  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();
  assert.equal(fixture.strictCalls.length, 1);

  primary.completion.resolve(Object.freeze({ reason: 'REMOTE_CLOSE' }));
  primaryScan.reject(new StrictCatchUpAbortedError());
  await flushLifecycle();

  assert.deepEqual(
    fixture.calls.filter((call) => call.startsWith('session.open:')),
    ['session.open:primary', 'session.open:fallback-1'],
  );
  assert.deepEqual(
    fixture.strictCalls.map(({ providerId }) => providerId),
    ['primary', 'fallback-1'],
  );
  assert.equal(primary.closeCalls(), 1);
  assert.equal(fallback.closeCalls(), 1);
  assert.equal(
    fixture.reporter.transitions.some(({ phase }) => phase === 'UNRECOVERABLE'),
    false,
  );
  assert.equal(fixture.reporter.transitions.at(-1)?.phase, 'DEGRADED');
  assert.equal(fixture.reporter.transitions.at(-1)?.recoveryReasonCode, 'SESSION_FAILURE');
  assert.deepEqual(fixture.scheduler.pendingDelays(), [500]);
});

void test('periodic frontier rearms only after successful settlement and never from notifications', async () => {
  const incumbent = controlledSession('primary');
  const periodic = deferred<StrictCatchUpScanResult>();
  const fixture = supervisorFixture({
    sessionFactories: [() => Promise.resolve(incumbent.session)],
  });
  fixture.strictResults.push(
    Promise.resolve(scanResult('primary')),
    periodic.promise,
  );
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();
  assert.deepEqual(fixture.scheduler.pendingDelays(), [WEBSOCKET_FRONTIER_INTERVAL_MS]);

  const observe = fixture.openedAttempts[0]?.observe;
  assert.ok(observe !== undefined);
  await observe(Object.freeze({
    endpointId: 'primary',
    program: 'pumpfun',
    signature: '1'.repeat(64),
    slot: 50n,
  }));
  assert.deepEqual(fixture.scheduler.pendingDelays(), [WEBSOCKET_FRONTIER_INTERVAL_MS]);

  fixture.scheduler.fireNext(WEBSOCKET_FRONTIER_INTERVAL_MS);
  await flushLifecycle();
  assert.deepEqual(fixture.strictCalls.map(({ providerId }) => providerId), [
    'primary', 'primary',
  ]);
  assert.deepEqual(fixture.scheduler.pendingDelays(), []);

  periodic.resolve(scanResult('primary'));
  await flushLifecycle();
  assert.deepEqual(fixture.scheduler.pendingDelays(), [WEBSOCKET_FRONTIER_INTERVAL_MS]);
  assert.equal(fixture.supervisor.state(), 'RUNNING');
});

void test('periodic frontier failure degrades once and coalesces one recovery loop', async () => {
  const incumbent = controlledSession('primary');
  const fixture = supervisorFixture({
    sessionFactories: [() => Promise.resolve(incumbent.session)],
  });
  fixture.strictResults.push(
    Promise.resolve(scanResult('primary')),
    rejected(new StrictCatchUpScannerError('source', 'primary', 'market', 'request')),
  );
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();

  fixture.scheduler.fireNext(WEBSOCKET_FRONTIER_INTERVAL_MS);
  await flushLifecycle();

  assert.equal(fixture.reporter.transitions.filter(({ phase }) => phase === 'DEGRADED').length, 1);
  assert.equal(fixture.dependencies.promoted.activeProviderId(), null);
  assert.equal(incumbent.closeCalls(), 0);
  assert.deepEqual(fixture.scheduler.pendingDelays(), [0]);
  assert.equal(fixture.supervisor.state(), 'DEGRADED');
});

void test('stale incumbent completion cannot degrade a replacement promoted after overlap', async () => {
  const events: string[] = [];
  const incumbent = controlledSession(
    'primary',
    Promise.resolve(),
    () => { events.push('incumbent.close'); },
  );
  const candidate = controlledSession('primary');
  const candidateScan = deferred<StrictCatchUpScanResult>();
  const fixture = supervisorFixture({
    sessionFactories: [
      () => Promise.resolve(incumbent.session),
      () => Promise.resolve(candidate.session),
    ],
  });
  fixture.strictResults.push(
    Promise.resolve(scanResult('primary')),
    rejected(new StrictCatchUpScannerError('source', 'primary', 'market', 'request')),
    candidateScan.promise,
  );
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();
  fixture.scheduler.fireNext(WEBSOCKET_FRONTIER_INTERVAL_MS);
  await flushLifecycle();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();

  assert.equal(fixture.strictCalls.length, 3);
  assert.equal(incumbent.closeCalls(), 0);
  const incumbentObserve = fixture.openedAttempts[0]?.observe;
  assert.ok(incumbentObserve !== undefined);
  await incumbentObserve(Object.freeze({
    endpointId: 'primary',
    program: 'pumpswap',
    signature: '1'.repeat(64),
    slot: 51n,
  }));
  assert.equal(fixture.reporter.observations.at(-1)?.sessionGeneration, 1n);

  const runningCallsBefore = fixture.calls.filter(
    (call) => call === 'health.transition:RUNNING',
  ).length;
  candidateScan.resolve(scanResult('primary'));
  await flushLifecycle();

  assert.equal(
    fixture.calls.filter((call) => call === 'health.transition:RUNNING').length,
    runningCallsBefore + 1,
  );
  assert.equal(fixture.calls.filter((call) => call === 'selector.promote:primary').length, 2);
  assert.equal(incumbent.closeCalls(), 1);
  assert.deepEqual(events, ['incumbent.close']);
  assert.equal(fixture.supervisor.state(), 'RUNNING');

  const transitionCount = fixture.reporter.transitions.length;
  incumbent.completion.resolve(Object.freeze({ reason: 'REMOTE_CLOSE' }));
  await flushLifecycle();
  assert.equal(fixture.reporter.transitions.length, transitionCount);
  assert.equal(fixture.supervisor.state(), 'RUNNING');
  assert.equal(fixture.dependencies.promoted.activeProviderId(), 'primary');
});

void test('queued completion degrades before the previous incumbent close settles', async () => {
  const previousClose = deferred<undefined>();
  const incumbent = controlledSession('primary', previousClose.promise);
  const candidate = controlledSession('primary');
  const fixture = supervisorFixture({
    sessionFactories: [
      () => Promise.resolve(incumbent.session),
      () => Promise.resolve(candidate.session),
    ],
  });
  fixture.strictResults.push(
    Promise.resolve(scanResult('primary')),
    rejected(new StrictCatchUpScannerError('source', 'primary', 'market', 'request')),
    Promise.resolve(scanResult('primary')),
  );
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();
  fixture.scheduler.fireNext(WEBSOCKET_FRONTIER_INTERVAL_MS);
  await flushLifecycle();

  const running = deferred<WebSocketHealthSnapshot>();
  fixture.reporter.transitionOverrides.set('RUNNING', running.promise);
  fixture.scheduler.fireNext(0);
  await flushLifecycle();
  assert.equal(fixture.reporter.transitions.at(-1)?.phase, 'RUNNING');
  const beforeRunning = fixture.reporter.snapshots.at(-1);
  assert.ok(beforeRunning !== undefined);

  candidate.completion.resolve(Object.freeze({ reason: 'REMOTE_CLOSE' }));
  await flushLifecycle();
  const runningInput = fixture.reporter.transitions.at(-1);
  assert.ok(runningInput !== undefined);
  running.resolve(snapshotFromTransition(runningInput, beforeRunning));
  await flushLifecycle();

  assert.equal(fixture.reporter.transitions.at(-1)?.phase, 'DEGRADED');
  assert.equal(fixture.reporter.transitions.at(-1)?.recoveryReasonCode, 'SESSION_FAILURE');
  assert.equal(fixture.dependencies.promoted.activeProviderId(), null);
  assert.equal(fixture.supervisor.state(), 'DEGRADED');
  assert.equal(incumbent.closeCalls(), 1);
  assert.equal(previousClose.settled(), false);

  previousClose.resolve(undefined);
  await flushLifecycle();
  assert.equal(incumbent.closeCalls(), 1);
  assert.deepEqual(fixture.scheduler.pendingDelays(), [0]);
});

void test('queued degradation failure still closes the previous incumbent during concurrent close', async () => {
  const previousClose = deferred<undefined>();
  const incumbent = controlledSession('primary', previousClose.promise);
  const candidate = controlledSession('primary');
  const stopFailure = 'Expected reporter-owned overlap cleanup timeout.';
  const fixture = supervisorFixture({
    reporterStopFailure: new Error(stopFailure),
    sessionFactories: [
      () => Promise.resolve(incumbent.session),
      () => Promise.resolve(candidate.session),
    ],
  });
  fixture.strictResults.push(
    Promise.resolve(scanResult('primary')),
    rejected(new StrictCatchUpScannerError('source', 'primary', 'market', 'request')),
    Promise.resolve(scanResult('primary')),
  );
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();
  fixture.scheduler.fireNext(WEBSOCKET_FRONTIER_INTERVAL_MS);
  await flushLifecycle();

  const running = deferred<WebSocketHealthSnapshot>();
  fixture.reporter.transitionOverrides.set('RUNNING', running.promise);
  fixture.reporter.transitionOverrides.set(
    'DEGRADED',
    rejected(new Error('Expected queued degradation failure.')),
  );
  fixture.scheduler.fireNext(0);
  await flushLifecycle();
  const beforeRunning = fixture.reporter.snapshots.at(-1);
  assert.ok(beforeRunning !== undefined);
  assert.equal(fixture.reporter.transitions.at(-1)?.phase, 'RUNNING');

  candidate.completion.resolve(Object.freeze({ reason: 'REMOTE_CLOSE' }));
  await flushLifecycle();
  const runningInput = fixture.reporter.transitions.at(-1);
  assert.ok(runningInput !== undefined);
  running.resolve(snapshotFromTransition(runningInput, beforeRunning));
  await flushLifecycle();

  assert.equal(fixture.reporter.transitions.at(-1)?.phase, 'DEGRADED');
  assert.equal(fixture.dependencies.promoted.activeProviderId(), null);
  assert.equal(candidate.closeCalls(), 1);
  assert.equal(incumbent.closeCalls(), 1);
  assert.equal(previousClose.settled(), false);

  await assertStage(fixture.supervisor.close(), 'cleanup', stopFailure);
  assert.equal(fixture.reporter.stopCalls, 1);
  assert.equal(candidate.closeCalls(), 1);
  assert.equal(incumbent.closeCalls(), 1);

  previousClose.resolve(undefined);
  await flushLifecycle();
  assert.equal(candidate.closeCalls(), 1);
  assert.equal(incumbent.closeCalls(), 1);
});

void test('shutdown during strict recovery aborts, closes once, and waits for the scan', async () => {
  const candidate = controlledSession('primary');
  const strict = deferred<StrictCatchUpScanResult>();
  const fixture = supervisorFixture({
    sessionFactories: [() => Promise.resolve(candidate.session)],
  });
  fixture.strictResults.push(strict.promise);
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();
  assert.equal(fixture.strictCalls.length, 1);

  const firstClose = fixture.supervisor.close();
  assert.equal(fixture.supervisor.close(), firstClose);
  let settled = false;
  void firstClose.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await flushLifecycle();

  assert.equal(fixture.strictCalls[0]?.signal.aborted, true);
  assert.equal(candidate.closeCalls(), 1);
  assert.equal(fixture.reporter.stopCalls, 1);
  assert.equal(settled, false);

  strict.reject(new StrictCatchUpAbortedError());
  await firstClose;
  assert.equal(candidate.closeCalls(), 1);
  assert.equal(fixture.supervisor.state(), 'STOPPED');
  assert.deepEqual(fixture.scheduler.pendingDelays(), []);
});

void test('shutdown during backoff cancels the sole timer and fences its stale callback', async () => {
  const fixture = supervisorFixture({
    random: () => 0,
    sessionFactories: [
      () => Promise.reject(new WsProgramSessionError('SETUP_TIMEOUT')),
    ],
  });
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();
  assert.deepEqual(fixture.scheduler.pendingDelays(), [500]);

  await fixture.supervisor.close();
  assert.deepEqual(fixture.scheduler.pendingDelays(), []);
  assert.equal(fixture.reporter.stopCalls, 1);
  const callsAfterClose = fixture.calls.length;

  fixture.scheduler.invokeFirst(500);
  await flushLifecycle();
  assert.equal(fixture.calls.length, callsAfterClose);
  assert.equal(fixture.supervisor.state(), 'STOPPED');
});

void test('shutdown during periodic frontier aborts and waits without a late transition', async () => {
  const incumbent = controlledSession('primary');
  const periodic = deferred<StrictCatchUpScanResult>();
  const fixture = supervisorFixture({
    sessionFactories: [() => Promise.resolve(incumbent.session)],
  });
  fixture.strictResults.push(Promise.resolve(scanResult('primary')), periodic.promise);
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();
  fixture.scheduler.fireNext(WEBSOCKET_FRONTIER_INTERVAL_MS);
  await flushLifecycle();
  const transitionCount = fixture.reporter.transitions.length;

  const closing = fixture.supervisor.close();
  let settled = false;
  void closing.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await flushLifecycle();
  assert.equal(fixture.strictCalls.at(-1)?.signal.aborted, true);
  assert.equal(incumbent.closeCalls(), 1);
  assert.equal(settled, false);

  periodic.resolve(scanResult('primary'));
  await closing;
  assert.equal(fixture.reporter.transitions.length, transitionCount);
  assert.equal(fixture.supervisor.state(), 'STOPPED');
  assert.deepEqual(fixture.scheduler.pendingDelays(), []);
});

void test('shutdown drains incumbent and candidate overlap exactly once', async () => {
  const observerDrain = deferred<undefined>();
  const incumbent = controlledSession('primary', observerDrain.promise);
  const candidate = controlledSession('primary');
  const candidateScan = deferred<StrictCatchUpScanResult>();
  const fixture = supervisorFixture({
    sessionFactories: [
      () => Promise.resolve(incumbent.session),
      () => Promise.resolve(candidate.session),
    ],
  });
  fixture.strictResults.push(
    Promise.resolve(scanResult('primary')),
    rejected(new StrictCatchUpScannerError('source', 'primary', 'market', 'request')),
    candidateScan.promise,
  );
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();
  fixture.scheduler.fireNext(WEBSOCKET_FRONTIER_INTERVAL_MS);
  await flushLifecycle();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();

  const transitionCount = fixture.reporter.transitions.length;
  const closing = fixture.supervisor.close();
  let settled = false;
  void closing.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await flushLifecycle();
  assert.equal(candidateScan.settled(), false);
  assert.equal(fixture.strictCalls.at(-1)?.signal.aborted, true);
  assert.equal(incumbent.closeCalls(), 1);
  assert.equal(candidate.closeCalls(), 1);
  assert.equal(settled, false);

  candidateScan.reject(new StrictCatchUpAbortedError());
  await flushLifecycle();
  assert.equal(settled, false);
  observerDrain.resolve(undefined);
  await closing;

  assert.equal(incumbent.closeCalls(), 1);
  assert.equal(candidate.closeCalls(), 1);
  assert.equal(fixture.reporter.transitions.length, transitionCount);
  assert.equal(fixture.reporter.stopCalls, 1);
  assert.equal(fixture.supervisor.state(), 'STOPPED');
});

void test('reporter owns one bounded shutdown cleanup when strict HTTP ignores abort', async () => {
  const incumbent = controlledSession('primary');
  const candidate = controlledSession('primary');
  const ignoredAbortScan = deferred<StrictCatchUpScanResult>();
  const fixture = supervisorFixture({
    reporterStopFailure: new Error('Expected reporter-owned cleanup timeout.'),
    sessionFactories: [
      () => Promise.resolve(incumbent.session),
      () => Promise.resolve(candidate.session),
    ],
  });
  fixture.strictResults.push(
    Promise.resolve(scanResult('primary')),
    rejected(new StrictCatchUpScannerError('source', 'primary', 'market', 'request')),
    ignoredAbortScan.promise,
  );
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();
  fixture.scheduler.fireNext(WEBSOCKET_FRONTIER_INTERVAL_MS);
  await flushLifecycle();
  fixture.reporter.transitionOverrides.set(
    'DEGRADED',
    rejected(new Error('Expected active degradation failure.')),
  );
  fixture.scheduler.fireNext(0);
  await flushLifecycle();
  assert.equal(fixture.strictCalls.length, 3);

  incumbent.completion.resolve(Object.freeze({ reason: 'REMOTE_CLOSE' }));
  await flushLifecycle();

  assert.equal(fixture.reporter.stopCalls, 1);
  assert.equal(fixture.reporter.stopCleanupCalls, 1);
  assert.equal(candidate.closeCalls(), 1);

  const closing = fixture.supervisor.close();
  let closeSettled = false;
  void closing.then(
    () => { closeSettled = true; },
    () => { closeSettled = true; },
  );
  await flushLifecycle();

  assert.equal(fixture.strictCalls.at(-1)?.signal.aborted, true);
  assert.equal(closeSettled, true);
  await assertStage(closing, 'cleanup', 'Expected reporter-owned cleanup timeout.');
  assert.equal(fixture.reporter.stopCalls, 1);
  assert.equal(fixture.reporter.stopCleanupCalls, 1);
  assert.equal(candidate.closeCalls(), 1);
  assert.equal(fixture.supervisor.state(), 'DEGRADED');

  ignoredAbortScan.reject(new StrictCatchUpAbortedError());
  await flushLifecycle();
});

void test('shutdown cleanup timeout aborts the close signal and never reports stopped', async () => {
  const incumbent = controlledSession(
    'primary',
    (signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(new WsProgramSessionError('CLEANUP_FAILED'));
      }, { once: true });
    }),
  );
  const fixture = supervisorFixture({
    sessionFactories: [() => Promise.resolve(incumbent.session)],
  });
  fixture.strictResults.push(Promise.resolve(scanResult('primary')));
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushLifecycle();

  const firstClose = fixture.supervisor.close();
  assert.equal(fixture.supervisor.close(), firstClose);
  await flushLifecycle();
  assert.deepEqual(fixture.scheduler.pendingDelays(), [WS_PROGRAM_SESSION_CLEANUP_TIMEOUT_MS]);
  assert.equal(incumbent.closeSignals[0]?.aborted, false);

  fixture.scheduler.fireNext(WS_PROGRAM_SESSION_CLEANUP_TIMEOUT_MS);
  await assertStage(firstClose, 'cleanup', 'never-leaked');
  assert.equal(incumbent.closeSignals[0]?.aborted, true);
  assert.equal(incumbent.closeCalls(), 1);
  assert.equal(fixture.reporter.stopCalls, 1);
  assert.equal(fixture.supervisor.state(), 'DEGRADED');
  assert.notEqual(fixture.supervisor.state(), 'STOPPED');
  assert.deepEqual(fixture.scheduler.pendingDelays(), []);
});

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
});

void test('promoted incumbent keeps forwarding valid websocket notifications', async () => {
  const fixture = supervisorFixture();
  fixture.strictResults.push(Promise.resolve(scanResult('primary')));
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushMicrotasks();
  fixture.resolveOpenSession();
  await flushMicrotasks();

  assert.equal(fixture.supervisor.state(), 'RUNNING');
  const observe = fixture.observe;
  assert.ok(observe !== null);
  await observe(Object.freeze({
    endpointId: 'primary',
    program: 'pumpswap',
    signature: '1'.repeat(64),
    slot: 43n,
  }));

  assert.deepEqual(fixture.reporter.observations.at(-1), {
    notification: {
      signature: '1'.repeat(64),
      slot: 43n,
      source: 'WEBSOCKET',
      programIds: [PUMPSWAP_PROGRAM_ID],
      confirmationStatus: 'confirmed',
      observedAtMs: 1_000,
    },
    ownerGeneration: 1n,
    sessionGeneration: 1n,
  });
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

  assert.equal(fixture.openSignal?.aborted, true);
  assert.equal(fixture.strictCalls.length, 0);
  assert.equal(fixture.calls.includes('health.transition:RUNNING'), false);
  assert.equal(fixture.calls.includes('selector.promote:primary'), false);
  assert.equal(fixture.supervisor.activeProviderId(), null);
});

void test('completion after the running fence is serialized through durable degradation', async () => {
  const fixture = supervisorFixture();
  const running = deferred<WebSocketHealthSnapshot>();
  fixture.reporter.transitionOverrides.set('RUNNING', running.promise);
  fixture.strictResults.push(Promise.resolve(scanResult('primary')));
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushMicrotasks();
  fixture.resolveOpenSession();
  await flushMicrotasks();

  assert.equal(fixture.reporter.transitions.at(-1)?.phase, 'RUNNING');
  assert.equal(fixture.dependencies.promoted.activeProviderId(), null);
  fixture.completionDeferred.resolve(Object.freeze({ reason: 'REMOTE_CLOSE' }));
  await flushMicrotasks();
  assert.equal(fixture.openSignal?.aborted, false);

  const runningInput = fixture.reporter.transitions.at(-1);
  assert.ok(runningInput !== undefined);
  running.resolve(snapshotFromTransition(runningInput));
  await flushMicrotasks();

  assert.deepEqual(fixture.reporter.transitions.map(({ phase }) => phase), [
    'WAITING_FOR_ACKS',
    'ACKNOWLEDGED',
    'RECOVERING',
    'RUNNING',
    'DEGRADED',
  ]);
  assert.deepEqual(fixture.reporter.transitions.at(-1), {
    ownerGeneration: 1n,
    expectedRevision: 5n,
    phase: 'DEGRADED',
    providerId: 'primary',
    activeSessionGeneration: 1n,
    candidateProviderId: null,
    candidateSessionGeneration: null,
    acknowledged: true,
    disconnectReasonCode: 'REMOTE_CLOSE',
    recoveryStatus: 'REQUIRED',
    recoveryReasonCode: 'SESSION_FAILURE',
  });
  assert.ok(
    fixture.calls.indexOf('selector.promote:primary')
      < fixture.calls.indexOf('health.transition:DEGRADED'),
  );
  assert.ok(
    fixture.calls.indexOf('health.transition:DEGRADED')
      < fixture.calls.indexOf('selector.clear:primary'),
  );
  assert.equal(fixture.dependencies.promoted.activeProviderId(), null);
  assert.equal(fixture.supervisor.activeProviderId(), null);
  assert.equal(fixture.supervisor.state(), 'DEGRADED');
  assert.equal(fixture.reporter.snapshots.at(-1)?.disconnect?.reasonCode, 'REMOTE_CLOSE');
  assert.equal(fixture.scheduler.pendingDelays().includes(WEBSOCKET_FRONTIER_INTERVAL_MS), false);
});

void test('queued degradation persistence failure clears and stops the promoted incumbent', async () => {
  const hostile = 'wss://secret.invalid/degraded-transition';
  const fixture = supervisorFixture({
    transitionFailure: 'DEGRADED',
    transitionError: new Error(hostile),
  });
  const running = deferred<WebSocketHealthSnapshot>();
  fixture.reporter.transitionOverrides.set('RUNNING', running.promise);
  fixture.strictResults.push(Promise.resolve(scanResult('primary')));
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushMicrotasks();
  fixture.resolveOpenSession();
  await flushMicrotasks();

  fixture.completionDeferred.resolve(Object.freeze({ reason: 'REMOTE_CLOSE' }));
  await flushMicrotasks();
  const runningInput = fixture.reporter.transitions.at(-1);
  assert.equal(runningInput?.phase, 'RUNNING');
  assert.ok(runningInput !== undefined);
  running.resolve(snapshotFromTransition(runningInput));
  await flushMicrotasks();

  assert.equal(fixture.calls.includes('health.transition:DEGRADED'), true);
  assert.equal(fixture.calls.includes('selector.clear:primary'), true);
  assert.equal(fixture.dependencies.promoted.activeProviderId(), null);
  assert.equal(fixture.supervisor.activeProviderId(), null);
  assert.equal(fixture.openSignal?.aborted, true);
  assert.equal(fixture.supervisor.state(), 'DEGRADED');
  assert.equal(fixture.scheduler.pendingDelays().includes(WEBSOCKET_FRONTIER_INTERVAL_MS), false);
  assert.equal(fixture.reporter.stopCalls, 1);

  const observe = fixture.observe;
  assert.ok(observe !== null);
  await observe(Object.freeze({
    endpointId: 'primary',
    program: 'pumpfun',
    signature: '4'.repeat(64),
    slot: 44n,
  }));
  assert.equal(fixture.reporter.observations.length, 0);
});

void test('degradation rejects a durable snapshot with the wrong disconnect reason', async () => {
  const fixture = supervisorFixture({ wrongDisconnectResult: 'DEGRADED' });
  const running = deferred<WebSocketHealthSnapshot>();
  fixture.reporter.transitionOverrides.set('RUNNING', running.promise);
  fixture.strictResults.push(Promise.resolve(scanResult('primary')));
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushMicrotasks();
  fixture.resolveOpenSession();
  await flushMicrotasks();

  fixture.completionDeferred.resolve(Object.freeze({ reason: 'REMOTE_CLOSE' }));
  await flushMicrotasks();
  const runningInput = fixture.reporter.transitions.at(-1);
  assert.equal(runningInput?.phase, 'RUNNING');
  assert.ok(runningInput !== undefined);
  running.resolve(snapshotFromTransition(runningInput));
  await flushMicrotasks();

  assert.equal(fixture.reporter.transitions.at(-1)?.disconnectReasonCode, 'REMOTE_CLOSE');
  assert.equal(fixture.reporter.snapshots.at(-1)?.disconnect?.reasonCode, 'SOCKET_ERROR');
  assert.equal(fixture.reporter.stopCalls, 1);
  assert.equal(fixture.dependencies.promoted.activeProviderId(), null);
  assert.equal(fixture.supervisor.activeProviderId(), null);
  assert.equal(fixture.supervisor.state(), 'DEGRADED');
});

void test('hostile completion payloads become immutable protocol-invalid degradation', async () => {
  const hostile = 'wss://secret.invalid/completion?reason=secret';
  let proxyTraps = 0;
  let getterCalls = 0;
  const proxy = new Proxy(Object.freeze({ reason: 'REMOTE_CLOSE' }), {
    get(_target, key) {
      if (key === 'then') return undefined;
      proxyTraps += 1;
      throw new Error(hostile);
    },
    getPrototypeOf() { proxyTraps += 1; throw new Error(hostile); },
    ownKeys() { proxyTraps += 1; throw new Error(hostile); },
    getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error(hostile); },
  });
  const accessor = {};
  Object.defineProperty(accessor, 'reason', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error(hostile); },
  });
  Object.freeze(accessor);
  const mutable = { reason: 'REMOTE_CLOSE' };
  const variants: Readonly<{ value: unknown; mutate?: () => void }>[] = [
    { value: proxy },
    { value: accessor },
    { value: mutable, mutate: () => { mutable.reason = 'SOCKET_ERROR'; } },
  ];

  for (const variant of variants) {
    const fixture = supervisorFixture();
    const running = deferred<WebSocketHealthSnapshot>();
    fixture.reporter.transitionOverrides.set('RUNNING', running.promise);
    fixture.strictResults.push(Promise.resolve(scanResult('primary')));
    await fixture.supervisor.start();
    fixture.scheduler.fireNext(0);
    await flushMicrotasks();
    fixture.resolveOpenSession();
    await flushMicrotasks();

    fixture.completionDeferred.resolve(variant.value as WsProgramSessionCompletion);
    variant.mutate?.();
    await flushMicrotasks();
    const runningInput = fixture.reporter.transitions.at(-1);
    assert.equal(runningInput?.phase, 'RUNNING');
    assert.ok(runningInput !== undefined);
    running.resolve(snapshotFromTransition(runningInput));
    await flushMicrotasks();

    const degraded = fixture.reporter.transitions.at(-1);
    assert.equal(degraded?.phase, 'DEGRADED');
    assert.equal(degraded.disconnectReasonCode, 'PROTOCOL_INVALID');
    assert.equal(fixture.reporter.snapshots.at(-1)?.disconnect?.reasonCode, 'PROTOCOL_INVALID');
    assert.equal(fixture.dependencies.promoted.activeProviderId(), null);
    assert.equal(fixture.supervisor.activeProviderId(), null);
  }
  assert.equal(proxyTraps, 0);
  assert.equal(getterCalls, 0);
});

void test('running transition rejection invalidates a queued completion without publication', async () => {
  const fixture = supervisorFixture();
  const running = deferred<WebSocketHealthSnapshot>();
  fixture.reporter.transitionOverrides.set('RUNNING', running.promise);
  fixture.strictResults.push(Promise.resolve(scanResult('primary')));
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushMicrotasks();
  fixture.resolveOpenSession();
  await flushMicrotasks();

  assert.equal(fixture.reporter.transitions.at(-1)?.phase, 'RUNNING');
  fixture.completionDeferred.resolve(Object.freeze({ reason: 'REMOTE_CLOSE' }));
  await flushMicrotasks();
  assert.equal(fixture.openSignal?.aborted, false);
  running.reject(new Error('wss://secret.invalid/running-transition'));
  await flushMicrotasks();

  assert.equal(fixture.openSignal?.aborted, true);
  assert.equal(fixture.calls.includes('selector.promote:primary'), false);
  assert.equal(fixture.calls.includes('scheduler.periodic:30000'), false);
  assert.equal(fixture.dependencies.promoted.activeProviderId(), null);
  assert.equal(fixture.supervisor.activeProviderId(), null);
  assert.equal(fixture.supervisor.state(), 'DEGRADED');
});

void test('hostile websocket program is rejected redacted before clock or observation', async () => {
  const hostile = 'wss://secret.invalid/ws?program=signature-secret';
  let nowCalls = 0;
  const fixture = supervisorFixture({
    now: () => {
      nowCalls += 1;
      return 1_000;
    },
  });
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushMicrotasks();

  const observe = fixture.observe;
  assert.ok(observe !== null);
  await assert.rejects(
    observe(Object.freeze({
      endpointId: 'primary',
      program: hostile,
      signature: '2'.repeat(64),
      slot: 42n,
    }) as unknown as WsProgramNotification),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'WebSocket failover supervisor configuration is invalid.');
      assert.equal(Object.hasOwn(error, 'cause'), false);
      assert.equal(String(error).includes(hostile), false);
      return true;
    },
  );
  assert.equal(nowCalls, 1);
  assert.equal(fixture.reporter.observations.length, 0);
});

void test('hostile notification payloads are rejected without traps, clock, or observation', async () => {
  const hostile = 'wss://secret.invalid/notification?signature=secret';
  let nowCalls = 0;
  let proxyTraps = 0;
  let getterCalls = 0;
  const fixture = supervisorFixture({
    now: () => {
      nowCalls += 1;
      return 1_000;
    },
  });
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushMicrotasks();
  const observe = fixture.observe;
  assert.ok(observe !== null);

  const proxy = new Proxy(Object.freeze({
    endpointId: 'primary',
    program: 'pumpfun',
    signature: '5'.repeat(64),
    slot: 45n,
  }), {
    get() { proxyTraps += 1; throw new Error(hostile); },
    getPrototypeOf() { proxyTraps += 1; throw new Error(hostile); },
    ownKeys() { proxyTraps += 1; throw new Error(hostile); },
    getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error(hostile); },
  });
  const accessor = {
    endpointId: 'primary',
    signature: '5'.repeat(64),
    slot: 45n,
  };
  Object.defineProperty(accessor, 'program', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error(hostile); },
  });
  const invalidSignature = Object.freeze({
    endpointId: 'primary',
    program: 'pumpfun',
    signature: hostile,
    slot: 45n,
  });
  const invalidSlot = Object.freeze({
    endpointId: 'primary',
    program: 'pumpfun',
    signature: '5'.repeat(64),
    slot: 45,
  });

  for (const value of [proxy, accessor, invalidSignature, invalidSlot]) {
    await assertConfigurationRejection(
      Promise.resolve().then(() => observe(value as unknown as WsProgramNotification)),
      hostile,
    );
  }
  assert.equal(proxyTraps, 0);
  assert.equal(getterCalls, 0);
  assert.equal(nowCalls, 1);
  assert.equal(fixture.reporter.observations.length, 0);
});

void test('hostile opened sessions are rejected before record or strict scan', async () => {
  const hostile = 'wss://secret.invalid/session?token=secret';
  let proxyTraps = 0;
  let getterCalls = 0;
  const completion = new Promise<WsProgramSessionCompletion>(() => undefined);
  const close = async (): Promise<void> => undefined;
  const valid = Object.freeze({ endpointId: 'primary', completion, close });
  const proxy = new Proxy(valid, {
    get(_target, key) {
      if (key === 'then') return undefined;
      proxyTraps += 1;
      throw new Error(hostile);
    },
    getPrototypeOf() { proxyTraps += 1; throw new Error(hostile); },
    ownKeys() { proxyTraps += 1; throw new Error(hostile); },
    getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error(hostile); },
  });
  const accessor = { completion, close };
  Object.defineProperty(accessor, 'endpointId', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error(hostile); },
  });
  Object.freeze(accessor);
  const variants = [
    proxy,
    accessor,
    { endpointId: 'primary', completion, close },
    Object.freeze({ endpointId: 'fallback-1', completion, close }),
    Object.freeze({ endpointId: 'primary', completion: hostile, close }),
  ];

  for (const value of variants) {
    const fixture = supervisorFixture({
      sessionResult: Promise.resolve(value as unknown as WsProgramSession),
    });
    await fixture.supervisor.start();
    fixture.scheduler.fireNext(0);
    await flushMicrotasks();

    assert.equal(fixture.openSignal?.aborted, true);
    assert.equal(fixture.strictCalls.length, 0);
    assert.equal(fixture.calls.includes('health.transition:ACKNOWLEDGED'), false);
    assert.equal(fixture.calls.includes('selector.promote:primary'), false);
    assert.equal(fixture.supervisor.activeProviderId(), null);
    assert.equal(fixture.supervisor.state(), 'DEGRADED');
  }
  assert.equal(proxyTraps, 0);
  assert.equal(getterCalls, 0);
});

void test('opened session rejects own completion then without invoking it or retaining candidate', async () => {
  const hostile = 'wss://secret.invalid/completion-then?token=secret';
  let getterCalls = 0;
  let dataThenCalls = 0;
  const accessorCompletion = new Promise<WsProgramSessionCompletion>(() => undefined);
  void Object.defineProperty(accessorCompletion, 'then', {
    configurable: true,
    get() {
      getterCalls += 1;
      throw new Error(hostile);
    },
  });
  const dataCompletion = new Promise<WsProgramSessionCompletion>(() => undefined);
  void Object.defineProperty(dataCompletion, 'then', {
    configurable: true,
    value: () => {
      dataThenCalls += 1;
      throw new Error(hostile);
    },
  });

  for (const completion of [accessorCompletion, dataCompletion]) {
    const session: WsProgramSession = Object.freeze({
      endpointId: 'primary',
      completion,
      async close(): Promise<void> {},
    });
    const fixture = supervisorFixture({ sessionResult: Promise.resolve(session) });
    await fixture.supervisor.start();
    fixture.scheduler.fireNext(0);
    await flushMicrotasks();

    assert.equal(fixture.openSignal?.aborted, true);
    assert.equal(fixture.calls.includes('health.transition:ACKNOWLEDGED'), false);
    assert.equal(fixture.strictCalls.length, 0);
    assert.equal(fixture.calls.includes('selector.promote:primary'), false);
    assert.equal(fixture.supervisor.activeProviderId(), null);
    assert.equal(fixture.supervisor.state(), 'DEGRADED');
    const observe = fixture.observe;
    assert.ok(observe !== null);
    await observe(Object.freeze({
      endpointId: 'primary',
      program: 'pumpfun',
      signature: '1'.repeat(64),
      slot: 46n,
    }));
    assert.equal(fixture.reporter.observations.length, 0);
  }
  assert.equal(getterCalls, 0);
  assert.equal(dataThenCalls, 0);
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

void test('close waits for deferred owner acquisition and fences every later startup effect', async () => {
  const owner = deferred<WebSocketHealthSnapshot>();
  const fixture = supervisorFixture({ ownerResult: owner.promise });
  const starting = fixture.supervisor.start();
  const closing = fixture.supervisor.close();
  let closeSettled = false;
  void closing.then(() => { closeSettled = true; });
  await flushMicrotasks();
  const settledBeforeOwner = closeSettled;

  owner.resolve(snapshot('CONNECTING', 1n));
  await assertStage(starting, 'cleanup', 'never-leaked');
  await closing;

  assert.equal(settledBeforeOwner, false);
  assert.deepEqual(fixture.calls, ['health.beginOwner:primary']);
  assert.equal(fixture.reporter.stopCalls, 0);
  assert.equal(fixture.scheduler.pendingDelays().length, 0);
  assert.equal(fixture.scheduler.cancelledHandles.length, 0);
  assert.equal(fixture.supervisor.state(), 'STOPPED');
  assert.equal(fixture.supervisor.activeProviderId(), null);
  assertNoSolanaCall(fixture);
});

void test('close waits for deferred initial transition and stops touch without recovery effects', async () => {
  const waiting = deferred<WebSocketHealthSnapshot>();
  const fixture = supervisorFixture();
  fixture.reporter.transitionOverrides.set('WAITING_FOR_ACKS', waiting.promise);
  const starting = fixture.supervisor.start();
  await flushMicrotasks();
  const waitingInput = fixture.reporter.transitions.at(-1);
  assert.equal(waitingInput?.phase, 'WAITING_FOR_ACKS');

  const closing = fixture.supervisor.close();
  let closeSettled = false;
  void closing.then(() => { closeSettled = true; });
  await flushMicrotasks();
  const settledBeforeTransition = closeSettled;
  assert.ok(waitingInput !== undefined);
  waiting.resolve(snapshotFromTransition(waitingInput));
  await assertStage(starting, 'cleanup', 'never-leaked');
  await closing;

  assert.equal(settledBeforeTransition, false);
  assert.deepEqual(fixture.calls, [
    'health.beginOwner:primary',
    'reporter.startTouch:1',
    'health.transition:WAITING_FOR_ACKS',
    'reporter.stop',
  ]);
  assert.equal(fixture.reporter.stopCalls, 1);
  assert.equal(fixture.scheduler.pendingDelays().length, 0);
  assert.equal(fixture.supervisor.state(), 'STOPPED');
  assert.equal(fixture.supervisor.activeProviderId(), null);
  assertNoSolanaCall(fixture);
});

void test('reentrant close cancels a just-produced recovery handle before publication', async () => {
  const fixture = supervisorFixture();
  const closeOperations: Promise<void>[] = [];
  fixture.scheduler.onSchedule = (_handle, delayMs) => {
    if (delayMs === 0) closeOperations.push(fixture.supervisor.close());
  };

  const starting = fixture.supervisor.start();
  await assertStage(starting, 'cleanup', 'never-leaked');
  assert.equal(closeOperations.length, 1);
  await Promise.all(closeOperations);

  assert.equal(fixture.scheduler.cancelledHandles.length, 1);
  assert.equal(fixture.scheduler.pendingDelays().length, 0);
  fixture.scheduler.invokeFirst(0);
  await flushMicrotasks();
  assert.equal(fixture.supervisor.state(), 'STOPPED');
  assert.equal(fixture.supervisor.activeProviderId(), null);
  assert.equal(fixture.reporter.stopCalls, 1);
  assertNoSolanaCall(fixture);
});

void test('reentrant close cancels a just-produced periodic handle before publication', async () => {
  const fixture = supervisorFixture();
  const closeOperations: Promise<void>[] = [];
  fixture.scheduler.onSchedule = (_handle, delayMs) => {
    if (delayMs === WEBSOCKET_FRONTIER_INTERVAL_MS) {
      closeOperations.push(fixture.supervisor.close());
    }
  };
  fixture.strictResults.push(Promise.resolve(scanResult('primary')));
  await fixture.supervisor.start();
  fixture.scheduler.fireNext(0);
  await flushMicrotasks();
  fixture.resolveOpenSession();
  await flushMicrotasks();

  assert.equal(closeOperations.length, 1);
  await Promise.all(closeOperations);
  assert.equal(fixture.calls.includes('selector.promote:primary'), true);
  assert.equal(fixture.calls.includes('selector.clear:primary'), true);
  assert.equal(fixture.scheduler.cancelledHandles.length, 1);
  assert.equal(fixture.scheduler.pendingDelays().length, 0);
  assert.equal(fixture.supervisor.state(), 'STOPPED');
  assert.equal(fixture.supervisor.activeProviderId(), null);
  assert.equal(fixture.dependencies.promoted.activeProviderId(), null);

  const callsBeforeLateCallback = fixture.calls.length;
  fixture.scheduler.invokeFirst(WEBSOCKET_FRONTIER_INTERVAL_MS);
  await flushMicrotasks();
  assert.equal(fixture.calls.length, callsBeforeLateCallback);
  assert.equal(fixture.supervisor.state(), 'STOPPED');
  assert.equal(fixture.supervisor.activeProviderId(), null);
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
  assert.equal(scheduled.reporter.stopCalls, 1);
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

  const openingClose = opening.supervisor.close();
  let openingCloseSettled = false;
  void openingClose.then(
    () => { openingCloseSettled = true; },
    () => { openingCloseSettled = true; },
  );
  await flushMicrotasks();
  assert.equal(opening.openSignal?.aborted, true);
  assert.equal(openingCloseSettled, false);
  opening.resolveOpenSession();
  await openingClose;
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
  readonly now?: () => number;
  readonly random?: () => number;
  readonly providerIds?: readonly RpcProviderId[];
  readonly ownerFailure?: Error;
  readonly ownerResult?: Promise<WebSocketHealthSnapshot>;
  readonly ownerSnapshot?: WebSocketHealthSnapshot;
  readonly transitionFailure?: WebSocketHealthTransition['phase'];
  readonly transitionError?: Error;
  readonly mutableTransitionResult?: WebSocketHealthTransition['phase'];
  readonly wrongDisconnectResult?: WebSocketHealthTransition['phase'];
  readonly sessionResult?: Promise<WsProgramSession>;
  readonly sessionResults?: Promise<WsProgramSession>[];
  readonly sessionFactories?: (() => Promise<WsProgramSession>)[];
  readonly resolveFailures?: Error[];
  readonly reporterStopFailure?: Error;
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
  readonly observe: ((notification: WsProgramNotification) => Promise<void>) | null;
  readonly openedEndpoint: Readonly<{ id: RpcProviderId; url: string }> | null;
  readonly openSignal: AbortSignal | null;
  readonly openedAttempts: readonly OpenedAttempt[];
}

interface OpenedAttempt {
  readonly endpoint: Readonly<{ id: RpcProviderId; url: string }>;
  readonly observe: (notification: WsProgramNotification) => Promise<void>;
  readonly signal: AbortSignal;
}

interface StrictCall {
  readonly providerId: RpcProviderId;
  readonly signal: AbortSignal;
}

function supervisorFixture(settings: FixtureOptions = {}): SupervisorFixture {
  const calls: string[] = [];
  const providerIds = settings.providerIds
    ?? Object.freeze(['primary'] as const);
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
    settings.wrongDisconnectResult,
    settings.reporterStopFailure,
  );
  const selector = new RecordingSelector(calls, providerIds);
  const strictResults: Promise<StrictCatchUpScanResult>[] = [];
  const strictCalls: StrictCall[] = [];
  const openSessionDeferred = deferred<WsProgramSession>();
  const completionDeferred = deferred<WsProgramSessionCompletion>();
  const completion = completionDeferred.promise;
  const session: WsProgramSession = Object.freeze({
    endpointId: 'primary',
    completion,
    async close(): Promise<void> { calls.push('session.close:primary'); },
  });
  let observe: ((notification: WsProgramNotification) => Promise<void>) | null = null;
  let openedEndpoint: Readonly<{ id: RpcProviderId; url: string }> | null = null;
  let openSignal: AbortSignal | null = null;
  const openedAttempts: OpenedAttempt[] = [];
  const openSession: typeof openWsProgramSession = (endpoint, nextObserve, signal) => {
    calls.push(`session.open:${endpoint.id}`);
    openedEndpoint = endpoint;
    observe = nextObserve;
    openSignal = signal;
    openedAttempts.push(Object.freeze({ endpoint, observe: nextObserve, signal }));
    const factory = settings.sessionFactories?.shift();
    return factory?.()
      ?? settings.sessionResults?.shift()
      ?? settings.sessionResult
      ?? openSessionDeferred.promise;
  };
  const providers = new RecordingCatalog(calls, providerIds, settings.resolveFailures);
  const dependencies: WebSocketFailoverSupervisorDependencies = Object.freeze({
    providers,
    health: Object.freeze({
      beginOwner(input: Readonly<{ candidateProviderId: RpcProviderId }>) {
        calls.push(`health.beginOwner:${input.candidateProviderId}`);
        if (settings.ownerFailure !== undefined) return Promise.reject(settings.ownerFailure);
        if (settings.ownerResult !== undefined) return settings.ownerResult;
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
    now: settings.now ?? (() => 1_000),
    random: settings.random ?? (() => 0.5),
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
    get observe() { return observe; },
    get openedEndpoint() { return openedEndpoint; },
    get openSignal() { return openSignal; },
    openedAttempts,
  };
}

class RecordingCatalog implements RpcProviderCatalog {
  public readonly ids: readonly RpcProviderId[];

  public constructor(
    private readonly calls: string[],
    ids: readonly RpcProviderId[],
    private readonly resolveFailures: Error[] = [],
  ) {
    this.ids = ids;
  }

  public resolve(id: RpcProviderId): RpcProviderPair {
    this.calls.push(`catalog.resolve:${id}`);
    const failure = this.resolveFailures.shift();
    if (failure !== undefined) throw failure;
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
  public readonly snapshots: WebSocketHealthSnapshot[] = [];
  public readonly transitionOverrides = new Map<
    WebSocketHealthTransition['phase'],
    Promise<WebSocketHealthSnapshot>
  >();
  public stopCalls = 0;
  public stopCleanupCalls = 0;
  #latestSnapshot = snapshot('CONNECTING', 1n);

  public constructor(
    private readonly calls: string[],
    private readonly transitionFailure?: WebSocketHealthTransition['phase'],
    private readonly transitionError: Error = new Error('Expected transition failure.'),
    private readonly mutableTransitionResult?: WebSocketHealthTransition['phase'],
    private readonly wrongDisconnectResult?: WebSocketHealthTransition['phase'],
    private readonly stopFailure?: Error,
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
    const override = this.transitionOverrides.get(input.phase);
    if (override !== undefined) {
      return override.then((next) => {
        this.#latestSnapshot = next;
        this.snapshots.push(next);
        return next;
      });
    }
    const next = snapshotFromTransition(
      input,
      this.#latestSnapshot,
      input.phase === this.wrongDisconnectResult ? 'SOCKET_ERROR' : undefined,
    );
    this.#latestSnapshot = next;
    this.snapshots.push(next);
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
    this.stopCleanupCalls += 1;
    const operation = cleanup();
    if (this.stopFailure !== undefined) {
      void operation.catch(() => undefined);
      throw this.stopFailure;
    }
    await operation;
  }
}

interface RecordedObservation {
  readonly notification: TransactionNotification;
  readonly ownerGeneration: bigint;
  readonly sessionGeneration: bigint;
}

class RecordingSelector extends PromotedProviderSelector {
  public constructor(
    private readonly calls: string[],
    ids: readonly RpcProviderId[] = Object.freeze(['primary'] as const),
  ) {
    super(ids.map(providerPass));
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
  public onSchedule: ((handle: unknown, delayMs: number) => void) | null = null;

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
    this.onSchedule?.(handle, delayMs);
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

  public invokeFirst(delayMs: number): void {
    const task = this.tasks.find((value) => value.delayMs === delayMs);
    if (task === undefined) throw new Error('No matching scheduler task.');
    task.callback();
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

function snapshotFromTransition(
  input: WebSocketHealthTransition,
  previous?: WebSocketHealthSnapshot,
  disconnectReasonOverride?: NonNullable<WebSocketHealthTransition['disconnectReasonCode']>,
): WebSocketHealthSnapshot {
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
    disconnect: input.disconnectReasonCode === null
      ? previous?.disconnect ?? null
      : {
          occurredAtMs: 1_000,
          reasonCode: disconnectReasonOverride ?? input.disconnectReasonCode,
        },
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

interface ControlledSession {
  readonly session: WsProgramSession;
  readonly completion: Deferred<WsProgramSessionCompletion>;
  readonly closeSignals: AbortSignal[];
  readonly closeCalls: () => number;
}

function controlledSession(
  providerId: RpcProviderId,
  closeResult: Promise<void> | ((signal: AbortSignal) => Promise<void>) = Promise.resolve(),
  onClose: () => void = () => undefined,
): ControlledSession {
  const completion = deferred<WsProgramSessionCompletion>();
  const closeSignals: AbortSignal[] = [];
  let closes = 0;
  const session: WsProgramSession = Object.freeze({
    endpointId: providerId,
    completion: completion.promise,
    close(signal: AbortSignal): Promise<void> {
      closes += 1;
      closeSignals.push(signal);
      onClose();
      return typeof closeResult === 'function' ? closeResult(signal) : closeResult;
    },
  });
  return Object.freeze({
    session,
    completion,
    closeSignals,
    closeCalls(): number { return closes; },
  });
}

function strictFrontier(seed: string) {
  return Object.freeze({
    launchpad: Object.freeze({
      key: 'launchpad' as const,
      signature: `${seed}-launchpad`,
      slot: 10n,
      updatedAtMs: 100,
    }),
    market: Object.freeze({
      key: 'market' as const,
      signature: `${seed}-market`,
      slot: 11n,
      updatedAtMs: 100,
    }),
  });
}

function rejected<TValue = never>(error: Error): Promise<TValue> {
  const operation = Promise.reject<TValue>(error);
  void operation.catch(() => undefined);
  return operation;
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

async function assertConfigurationRejection(
  operation: Promise<unknown>,
  hostile: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, 'WebSocket failover supervisor configuration is invalid.');
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
  readonly reject: (reason: Error) => void;
  readonly settled: () => boolean;
}

function deferred<TValue>(): Deferred<TValue> {
  let complete = false;
  let resolvePromise: ((value: TValue) => void) | undefined;
  let rejectPromise: ((reason: Error) => void) | undefined;
  const promise = new Promise<TValue>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return Object.freeze({
    promise,
    resolve(value: TValue): void {
      complete = true;
      resolvePromise?.(value);
    },
    reject(reason: Error): void {
      complete = true;
      rejectPromise?.(reason);
    },
    settled(): boolean { return complete; },
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function flushLifecycle(): Promise<void> {
  for (let index = 0; index < 80; index += 1) await Promise.resolve();
}
