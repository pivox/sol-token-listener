import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import bs58 from 'bs58';
import pg from 'pg';
import { PromotedProviderSelector } from '../src/application/promoted-provider-selector.js';
import {
  StrictCatchUpScanner,
  StrictCatchUpAbortedError,
  StrictCatchUpScannerError,
  StrictCatchUpWindowExceededError,
  type StrictCatchUpScanResult,
} from '../src/application/strict-catch-up-scanner.js';
import { WebSocketFailoverSupervisor, type WebSocketFailoverScheduler } from '../src/application/websocket-failover-supervisor.js';
import { PersistentWebSocketHealthReporter } from '../src/application/websocket-health-reporter.js';
import type { RpcProviderId } from '../src/domain/rpc-provider.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import type { CatchUpSource } from '../src/ports/catch-up-source.js';
import type { RpcProviderCatalog, RpcProviderPair } from '../src/solana/rpc/rpc-provider-catalog.js';
import {
  WsProgramSessionError,
  type WsProgramNotification,
  type WsProgramSession,
  type WsProgramSessionCompletion,
} from '../src/solana/rpc/ws-program-session.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresTransactionInboxRepository, TransactionInboxConflictError } from '../src/storage/transaction-inbox.repository.js';
import { PostgresWebSocketHealthRepository } from '../src/storage/websocket-health.repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const SHARED_SIGNATURE = '1'.repeat(64);
const MULTI_PAGE_SIGNATURE = bs58.encode(Buffer.alloc(64, 2));
const MULTI_PAGE_BOUNDARY_SIGNATURE = bs58.encode(Buffer.alloc(64, 3));

void test('merges one signature from incumbent and candidate WS plus strict HTTP before the old session closes', async (context) => {
  await withDatabase(context, async (pool) => {
    const inbox = new PostgresTransactionInboxRepository(pool);
    const health = new PostgresWebSocketHealthRepository(pool);
    const scheduler = new ManualScheduler();
    const reporterScheduler = new ManualScheduler();
    const reporter = new PersistentWebSocketHealthReporter(inbox, health, {
      touchIntervalMs: 60_000,
      shutdownTimeoutMs: 100,
      scheduler: Object.freeze({
        schedule: (callback: () => void, delayMs: number) => reporterScheduler.schedule(callback, delayMs),
        cancel: (handle: unknown) => { reporterScheduler.cancel(handle); },
      }),
    });
    const sessions = new SessionFactory();
    const strictScans: RpcProviderId[] = [];
    const candidateScan = deferred<StrictCatchUpScanResult>();
    const supervisor = new WebSocketFailoverSupervisor({
      providers: new TestCatalog(['primary', 'fallback-1']),
      health,
      reporter,
      promoted: new PromotedProviderSelector([
        finalityPass('primary'), finalityPass('fallback-1'),
      ]),
      openSession: sessions.open,
      runStrictScan: async (providerId, signal) => {
        strictScans.push(providerId);
        if (strictScans.length === 2) {
          throw new StrictCatchUpScannerError('source', providerId, 'launchpad', 'request');
        }
        if (strictScans.length === 3) return candidateScan.promise;
        return strictScanner(providerId, inbox).scan(signal);
      },
    }, {
      now: () => 10_000,
      random: () => 0,
      scheduler: Object.freeze({
        schedule: (callback: () => void, delayMs: number) => scheduler.schedule(callback, delayMs),
        cancel: (handle: unknown) => { scheduler.cancel(handle); },
      }),
    });

    await supervisor.start();
    scheduler.fire(0);
    await waitForProvider(supervisor, 'primary');
    await sessions.at(0).observe(wsNotification('pumpfun'));

    scheduler.fire(30_000);
    await settled();
    assert.equal((await health.read()).phase, 'DEGRADED');
    scheduler.fire(0);
    await waitForSessionCount(sessions, 2);
    assert.equal(sessions.at(0).closeCalls, 0);
    await sessions.at(0).observe(wsNotification('pumpswap'));
    await sessions.at(1).observe(wsNotification('pumpswap', 'fallback-1'));
    candidateScan.resolve(await strictScanner('fallback-1', inbox).scan(new AbortController().signal));
    await waitForProvider(supervisor, 'fallback-1');
    assert.equal(sessions.at(0).closeCalls, 1);

    const stored = await inboxRow(pool, SHARED_SIGNATURE);
    assert.equal(stored.observed_slot, '42');
    assert.deepEqual([...stored.discovery_sources].sort(), ['CATCH_UP', 'WEBSOCKET']);
    assert.deepEqual([...stored.program_ids].sort(), [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort());
    assert.deepEqual(strictScans, ['primary', 'primary', 'fallback-1']);
    const snapshot = await health.read();
    assert.equal(snapshot.supervision, 'ACTIVE');
    assert.equal(snapshot.phase, 'RUNNING');
    assert.equal(snapshot.providerId, 'fallback-1');
    assert.equal(snapshot.candidateProviderId, null);
    assert.equal(snapshot.recovery.status, 'RECOVERED');

    await assert.rejects(inbox.enqueue(Object.freeze({
      signature: SHARED_SIGNATURE, slot: 43n, source: 'WEBSOCKET',
      programIds: Object.freeze([PUMP_PROGRAM_ID]), confirmationStatus: 'confirmed', observedAtMs: 10_001,
    })), (error: unknown) => error instanceof TransactionInboxConflictError
      && error.conflict === 'identity');
    assert.equal((await inboxRow(pool, SHARED_SIGNATURE)).observed_slot, '42');
    await supervisor.close();
  });
});

void test('a stale RUNNING supervisor restart allocates a new generation and rescans exact persisted boundaries', async (context) => {
  await withDatabase(context, async (pool) => {
    const inbox = new PostgresTransactionInboxRepository(pool);
    const health = new PostgresWebSocketHealthRepository(pool);
    const firstScheduler = new ManualScheduler();
    const firstReporter = reporterFor(inbox, health);
    const firstSupervisor = supervisorFor({
      inbox, health, scheduler: firstScheduler, reporter: firstReporter,
      sessions: new SessionFactory(),
      strict: (providerId, signal) => strictScanner(providerId, inbox).scan(signal),
    });
    await firstSupervisor.start();
    firstScheduler.fire(0);
    await waitForProvider(firstSupervisor, 'primary');
    const running = await health.read();
    assert.equal(running.phase, 'RUNNING');
    const launchpadBefore = await inbox.readCheckpoint('launchpad');
    const marketBefore = await inbox.readCheckpoint('market');
    await pool.query(`UPDATE listener_websocket_health
      SET heartbeat_at = clock_timestamp() - INTERVAL '31 seconds'
      WHERE service_key = 'transaction-listener'`);

    const restartScheduler = new ManualScheduler();
    const restartedSupervisor = supervisorFor({
      inbox, health, scheduler: restartScheduler, reporter: reporterFor(inbox, health),
      sessions: new SessionFactory(),
      strict: (providerId, signal) => strictScanner(providerId, inbox).scan(signal),
    });
    await restartedSupervisor.start();
    const restarted = await health.read();
    assert.equal(restarted.ownerGeneration, running.ownerGeneration + 1n);
    assert.equal(restarted.phase, 'WAITING_FOR_ACKS');
    assert.equal(restarted.recovery.status, 'REQUIRED');
    assert.equal(restarted.recovery.reasonCode, 'UNEXPECTED_RESTART');
    assert.deepEqual(await inbox.readCheckpoint('launchpad'), launchpadBefore);
    assert.deepEqual(await inbox.readCheckpoint('market'), marketBefore);
    restartScheduler.fire(0);
    await waitForProvider(restartedSupervisor, 'primary');
    assert.deepEqual(await inbox.readCheckpoint('launchpad'), launchpadBefore);
    assert.deepEqual(await inbox.readCheckpoint('market'), marketBefore);
    await restartedSupervisor.close();
  });
});

void test('restarts every durable WebSocket boundary through a fresh supervisor without a live-edge rebaseline', async (context) => {
  const boundaries = [
    'CONNECTING', 'WAITING_FOR_ACKS', 'ACKNOWLEDGED', 'RECOVERING',
    'PARTIAL_ENQUEUE', 'AFTER_LAUNCHPAD_CAS', 'AFTER_BOTH_CAS', 'RUNNING_BEFORE_OLD_CLOSE',
  ] as const;
  for (const boundary of boundaries) {
    await withDatabase(context, async (pool) => {
      const inbox = new PostgresTransactionInboxRepository(pool);
      const health = new PostgresWebSocketHealthRepository(pool);
      const previous = await seedCrashBoundary(boundary, inbox, health);
      const launchpadBefore = await inbox.readCheckpoint('launchpad');
      const marketBefore = await inbox.readCheckpoint('market');
      await pool.query(`UPDATE listener_websocket_health
        SET heartbeat_at = clock_timestamp() - INTERVAL '31 seconds'
        WHERE service_key = 'transaction-listener'`);

      const scheduler = new ManualScheduler();
      const restartedSupervisor = supervisorFor({
        inbox, health, scheduler, reporter: reporterFor(inbox, health), sessions: new SessionFactory(),
        strict: (providerId, signal) => strictScanner(providerId, inbox).scan(signal),
      });
      await restartedSupervisor.start();
      const restarted = await health.read();
      assert.equal(restarted.ownerGeneration, previous.ownerGeneration + 1n, boundary);
      assert.equal(restarted.phase, 'WAITING_FOR_ACKS', boundary);
      assert.equal(restarted.recovery.status, 'REQUIRED', boundary);
      assert.equal(restarted.recovery.reasonCode, 'UNEXPECTED_RESTART', boundary);
      scheduler.fire(0);
      await waitForProvider(restartedSupervisor, 'primary');
      assert.deepEqual(
        await inbox.readCheckpoint('launchpad'),
        launchpadBefore ?? strictCheckpoint('launchpad'),
        boundary,
      );
      assert.deepEqual(
        await inbox.readCheckpoint('market'),
        marketBefore ?? strictCheckpoint('market'),
        boundary,
      );
      assert.equal(await inboxCount(pool, SHARED_SIGNATURE), 1, boundary);
      await restartedSupervisor.close();
    });
  }
});

void test('unanimous exact strict frontiers persist UNRECOVERABLE without moving PostgreSQL checkpoints', async (context) => {
  await withDatabase(context, async (pool) => {
    const inbox = new PostgresTransactionInboxRepository(pool);
    const health = new PostgresWebSocketHealthRepository(pool);
    const scheduler = new ManualScheduler();
    const reporterScheduler = new ManualScheduler();
    const reporter = new PersistentWebSocketHealthReporter(inbox, health, {
      touchIntervalMs: 60_000,
      shutdownTimeoutMs: 100,
      scheduler: Object.freeze({
        schedule: (callback: () => void, delayMs: number) => reporterScheduler.schedule(callback, delayMs),
        cancel: (handle: unknown) => { reporterScheduler.cancel(handle); },
      }),
    });
    const sessions = new SessionFactory();
    const frontier = Object.freeze({ launchpad: null, market: null });
    const supervisor = new WebSocketFailoverSupervisor({
      providers: new TestCatalog(['primary', 'fallback-1']), health, reporter,
      promoted: new PromotedProviderSelector([finalityPass('primary'), finalityPass('fallback-1')]),
      openSession: sessions.open,
      runStrictScan: async (providerId) => {
        throw new StrictCatchUpWindowExceededError(providerId, 'launchpad', frontier);
      },
    }, {
      now: () => 10_000, random: () => 0,
      scheduler: Object.freeze({
        schedule: (callback: () => void, delayMs: number) => scheduler.schedule(callback, delayMs),
        cancel: (handle: unknown) => { scheduler.cancel(handle); },
      }),
    });

    await supervisor.start();
    scheduler.fire(0);
    await waitForPhase(health, 'UNRECOVERABLE');
    const snapshot = await health.read();
    assert.equal(snapshot.recovery.status, 'FAILED');
    assert.equal(snapshot.recovery.reasonCode, 'CATCH_UP_WINDOW_EXCEEDED');
    assert.equal(await inbox.readCheckpoint('launchpad'), null);
    assert.equal(await inbox.readCheckpoint('market'), null);
    assert.equal(scheduler.pendingCount(), 0);
    await supervisor.close();
  });
});

void test('mixed strict failure evidence remains durably DEGRADED with one bounded backoff', async (context) => {
  await withDatabase(context, async (pool) => {
    const inbox = new PostgresTransactionInboxRepository(pool);
    const health = new PostgresWebSocketHealthRepository(pool);
    const scheduler = new ManualScheduler();
    const frontier = Object.freeze({ launchpad: null, market: null });
    let attempts = 0;
    const supervisor = supervisorFor({
      inbox, health, scheduler, reporter: reporterFor(inbox, health), sessions: new SessionFactory(),
      strict: async (providerId) => {
        attempts += 1;
        if (attempts === 1) throw new StrictCatchUpWindowExceededError(providerId, 'launchpad', frontier);
        throw new StrictCatchUpScannerError('source', providerId, 'market', 'request');
      },
    });

    await supervisor.start();
    scheduler.fire(0);
    await waitForPhase(health, 'DEGRADED');
    const snapshot = await health.read();
    assert.equal(snapshot.recovery.status, 'REQUIRED');
    assert.notEqual(snapshot.phase, 'UNRECOVERABLE');
    assert.equal(await inbox.readCheckpoint('launchpad'), null);
    assert.equal(await inbox.readCheckpoint('market'), null);
    assert.equal(scheduler.pendingDelays().filter((delay) => delay === 500).length, 1);
    await supervisor.close();
  });
});

void test('persists named transient provider faults as DEGRADED with one bounded recovery timer', async (context) => {
  const faults = [
    ['PARTIAL_ACK_TIMEOUT', 'session', 'SETUP_TIMEOUT'],
    ['SETUP_TIMEOUT', 'session', 'SETUP_TIMEOUT'],
    ['DISCONNECT', 'session', 'REMOTE_CLOSE'],
    ['PROTOCOL_INVALID', 'session', 'PROTOCOL_INVALID'],
    ['ENQUEUE_FAILURE', 'session', 'NOTIFICATION_FAILED'],
    ['HTTP_429', 'strict', 'source'], ['MALFORMED_PAGE', 'strict', 'source'],
    ['CAS_CONFLICT', 'strict', 'checkpoint-cas'],
    ['ABORT_BEFORE_AWAIT', 'strict', 'aborted'], ['ABORT_AFTER_PAGE', 'strict', 'aborted'],
    ['ABORT_AFTER_ENQUEUE', 'strict', 'aborted'], ['ABORT_AFTER_LAUNCHPAD_CAS', 'strict', 'aborted'],
    ['CLEANUP_FAILURE', 'session', 'CLEANUP_FAILED'],
  ] as const;
  for (const [name, family, code] of faults) {
    await withDatabase(context, async (pool) => {
      const inbox = new PostgresTransactionInboxRepository(pool);
      const health = new PostgresWebSocketHealthRepository(pool);
      const scheduler = new ManualScheduler();
      const supervisor = supervisorFor({
        inbox, health, scheduler, reporter: reporterFor(inbox, health),
        sessions: family === 'session' ? new RejectingSessionFactory(code) : new SessionFactory(),
        strict: async (providerId) => {
          if (family !== 'strict') return strictScanner(providerId, inbox).scan(new AbortController().signal);
          if (code === 'aborted') throw new StrictCatchUpAbortedError();
          throw new StrictCatchUpScannerError(code, providerId, 'launchpad', 'request');
        },
      });
      await supervisor.start();
      scheduler.fire(0);
      await waitForPhase(health, 'DEGRADED');
      assert.notEqual((await health.read()).phase, 'UNRECOVERABLE', name);
      assert.equal(await unresolvedStrictFailureCount(pool), 0, name);
      assert.equal(await inbox.readCheckpoint('launchpad'), null, name);
      assert.equal(await inbox.readCheckpoint('market'), null, name);
      assert.equal(scheduler.pendingDelays().filter((delay) => delay === 500).length, 1, name);
      await supervisor.close();
    });
  }
});

void test('recovers a real multi-page strict scan through PostgreSQL before durable promotion', async (context) => {
  await withDatabase(context, async (pool) => {
    const inbox = new PostgresTransactionInboxRepository(pool);
    const health = new PostgresWebSocketHealthRepository(pool);
    const scheduler = new ManualScheduler();
    await inbox.compareAndSwapCheckpoint(null, Object.freeze({
      key: 'launchpad', slot: 41n, signature: MULTI_PAGE_BOUNDARY_SIGNATURE, updatedAtMs: 9_000,
    }));
    await inbox.compareAndSwapCheckpoint(null, Object.freeze({
      key: 'market', slot: 41n, signature: MULTI_PAGE_BOUNDARY_SIGNATURE, updatedAtMs: 9_000,
    }));
    const supervisor = supervisorFor({
      inbox, health, scheduler, reporter: reporterFor(inbox, health), sessions: new SessionFactory(),
      strict: (providerId, signal) => multiPageStrictScanner(providerId, inbox).scan(signal),
    });
    await supervisor.start();
    scheduler.fire(0);
    await waitForProvider(supervisor, 'primary');
    assert.deepEqual(await inbox.readCheckpoint('launchpad'), Object.freeze({
      key: 'launchpad', slot: 43n, signature: MULTI_PAGE_SIGNATURE, updatedAtMs: 10_000,
    }));
    assert.deepEqual(await inbox.readCheckpoint('market'), Object.freeze({
      key: 'market', slot: 43n, signature: MULTI_PAGE_SIGNATURE, updatedAtMs: 10_000,
    }));
    assert.equal(await inboxCount(pool, SHARED_SIGNATURE), 1);
    assert.equal(await inboxCount(pool, MULTI_PAGE_SIGNATURE), 1);
    await supervisor.close();
  });
});

class TestCatalog implements RpcProviderCatalog {
  public readonly ids: readonly RpcProviderId[];
  public constructor(ids: readonly RpcProviderId[]) { this.ids = Object.freeze([...ids]); }
  public resolve(id: RpcProviderId): RpcProviderPair {
    return Object.freeze({ id, httpUrl: `https://${id}.invalid`, websocketUrl: `wss://${id}.invalid` });
  }
}

function reporterFor(
  inbox: PostgresTransactionInboxRepository,
  health: PostgresWebSocketHealthRepository,
): PersistentWebSocketHealthReporter {
  const scheduler = new ManualScheduler();
  return new PersistentWebSocketHealthReporter(inbox, health, {
    touchIntervalMs: 60_000,
    shutdownTimeoutMs: 100,
    scheduler: Object.freeze({
      schedule: (callback: () => void, delayMs: number) => scheduler.schedule(callback, delayMs),
      cancel: (handle: unknown) => { scheduler.cancel(handle); },
    }),
  });
}

function supervisorFor(value: Readonly<{
  inbox: PostgresTransactionInboxRepository;
  health: PostgresWebSocketHealthRepository;
  scheduler: ManualScheduler;
  reporter: PersistentWebSocketHealthReporter;
  sessions: SessionOpener;
  strict: (providerId: RpcProviderId, signal: AbortSignal) => Promise<StrictCatchUpScanResult>;
}>): WebSocketFailoverSupervisor {
  return new WebSocketFailoverSupervisor({
    providers: new TestCatalog(['primary', 'fallback-1']),
    health: value.health,
    reporter: value.reporter,
    promoted: new PromotedProviderSelector([finalityPass('primary'), finalityPass('fallback-1')]),
    openSession: value.sessions.open,
    runStrictScan: value.strict,
  }, {
    now: () => 10_000,
    random: () => 0,
    scheduler: Object.freeze({
      schedule: (callback: () => void, delayMs: number) => value.scheduler.schedule(callback, delayMs),
      cancel: (handle: unknown) => { value.scheduler.cancel(handle); },
    }),
  });
}

interface SessionOpener {
  readonly open: (
    endpoint: Readonly<{ id: RpcProviderId; url: string }>,
    observe: (notification: WsProgramNotification) => Promise<void>,
    signal: AbortSignal,
  ) => Promise<WsProgramSession>;
}

class ManualScheduler implements WebSocketFailoverScheduler {
  #tasks: { readonly delayMs: number; readonly callback: () => void; cancelled: boolean }[] = [];
  public schedule(callback: () => void, delayMs: number): unknown {
    const task = { callback, delayMs, cancelled: false };
    this.#tasks.push(task);
    return task;
  }
  public cancel(handle: unknown): void {
    if (typeof handle === 'object' && handle !== null && 'cancelled' in handle) {
      (handle as { cancelled: boolean }).cancelled = true;
    }
  }
  public fire(delayMs: number): void {
    const task = this.#tasks.find((value) => value.delayMs === delayMs && !value.cancelled);
    if (task === undefined) throw new Error(`Missing scheduled ${delayMs} task.`);
    task.cancelled = true;
    task.callback();
  }
  public pendingCount(): number { return this.#tasks.filter((value) => !value.cancelled).length; }
  public pendingDelays(): number[] {
    return this.#tasks.filter((value) => !value.cancelled).map((value) => value.delayMs);
  }
}

class SessionFactory {
  #sessions: ControlledSession[] = [];
  public readonly open = async (
    endpoint: Readonly<{ id: RpcProviderId; url: string }>,
    observe: (notification: WsProgramNotification) => Promise<void>,
    _signal: AbortSignal,
  ): Promise<WsProgramSession> => {
    const session = new ControlledSession(endpoint.id, observe);
    this.#sessions.push(session);
    return session.session;
  };
  public at(index: number): ControlledSession {
    const session = this.#sessions[index];
    if (session === undefined) throw new Error('Expected a WebSocket session.');
    return session;
  }
  public get count(): number { return this.#sessions.length; }
}

class RejectingSessionFactory implements SessionOpener {
  public constructor(private readonly reason: ConstructorParameters<typeof WsProgramSessionError>[0]) {}
  public readonly open = async (): Promise<WsProgramSession> => {
    throw new WsProgramSessionError(this.reason);
  };
}

class ControlledSession {
  #resolve!: (value: WsProgramSessionCompletion) => void;
  readonly #completion = new Promise<WsProgramSessionCompletion>((resolve) => { this.#resolve = resolve; });
  readonly session: WsProgramSession;
  public closeCalls = 0;
  public constructor(
    providerId: RpcProviderId,
    public readonly observe: (notification: WsProgramNotification) => Promise<void>,
  ) {
    this.session = Object.freeze({
      endpointId: providerId,
      completion: this.#completion,
      close: async (): Promise<void> => { this.closeCalls += 1; },
    });
  }
  public complete(reason: WsProgramSessionCompletion['reason']): void { this.#resolve(Object.freeze({ reason })); }
}

interface Deferred<TValue> {
  readonly promise: Promise<TValue>;
  readonly resolve: (value: TValue) => void;
}

function deferred<TValue>(): Deferred<TValue> {
  let resolve: (value: TValue) => void = () => { throw new Error('Deferred unavailable.'); };
  const promise = new Promise<TValue>((next) => { resolve = next; });
  return Object.freeze({ promise, resolve });
}

function strictScanner(providerId: RpcProviderId, inbox: PostgresTransactionInboxRepository): StrictCatchUpScanner {
  const source: CatchUpSource & { readonly providerId: RpcProviderId } = Object.freeze({
    providerId,
    async list(programId: string, before: string | undefined) {
      if (programId !== PUMP_PROGRAM_ID && programId !== PUMPSWAP_PROGRAM_ID) throw new Error('Unexpected program.');
      if (before !== undefined) return [];
      return [Object.freeze({ signature: SHARED_SIGNATURE, slot: 42n, confirmationStatus: 'confirmed' as const, blockTimeMs: null })];
    },
  });
  return new StrictCatchUpScanner(source, inbox, { pageSize: 10, maxPages: 2, now: () => 10_000 });
}

function multiPageStrictScanner(
  providerId: RpcProviderId,
  inbox: PostgresTransactionInboxRepository,
): StrictCatchUpScanner {
  const source: CatchUpSource & { readonly providerId: RpcProviderId } = Object.freeze({
    providerId,
    async list(programId: string, before: string | undefined) {
      if (programId !== PUMP_PROGRAM_ID && programId !== PUMPSWAP_PROGRAM_ID) throw new Error('Unexpected program.');
      if (before === undefined) return [Object.freeze({
        signature: MULTI_PAGE_SIGNATURE, slot: 43n, confirmationStatus: 'confirmed' as const, blockTimeMs: null,
      })];
      if (before === MULTI_PAGE_SIGNATURE) return [Object.freeze({
        signature: SHARED_SIGNATURE, slot: 42n, confirmationStatus: 'confirmed' as const, blockTimeMs: null,
      })];
      if (before === SHARED_SIGNATURE) return [Object.freeze({
        signature: MULTI_PAGE_BOUNDARY_SIGNATURE, slot: 41n,
        confirmationStatus: 'confirmed' as const, blockTimeMs: null,
      })];
      return [];
    },
  });
  return new StrictCatchUpScanner(source, inbox, { pageSize: 1, maxPages: 3, now: () => 10_000 });
}

function wsNotification(
  program: 'pumpfun' | 'pumpswap',
  endpointId: RpcProviderId = 'primary',
): WsProgramNotification {
  return Object.freeze({ endpointId, program, signature: SHARED_SIGNATURE, slot: 42n });
}

function finalityPass(providerId: RpcProviderId) {
  return Object.freeze({
    providerId,
    async getHistoryStatuses(): Promise<readonly unknown[]> { return Object.freeze([]); },
    async getFinalizedSlot(): Promise<bigint> { return 0n; },
    async getFinalizedBlockSignatures(): Promise<readonly unknown[]> { return Object.freeze([]); },
  });
}

async function seedCrashBoundary(
  boundary: 'CONNECTING' | 'WAITING_FOR_ACKS' | 'ACKNOWLEDGED' | 'RECOVERING'
    | 'PARTIAL_ENQUEUE' | 'AFTER_LAUNCHPAD_CAS' | 'AFTER_BOTH_CAS' | 'RUNNING_BEFORE_OLD_CLOSE',
  inbox: PostgresTransactionInboxRepository,
  health: PostgresWebSocketHealthRepository,
) {
  let snapshot = await health.beginOwner({ candidateProviderId: 'primary' });
  if (boundary === 'CONNECTING') return snapshot;
  snapshot = await health.transition(healthTransition(snapshot, 'WAITING_FOR_ACKS'));
  if (boundary === 'WAITING_FOR_ACKS') return snapshot;
  snapshot = await health.transition(healthTransition(snapshot, 'ACKNOWLEDGED'));
  if (boundary === 'ACKNOWLEDGED') return snapshot;
  snapshot = await health.transition(healthTransition(snapshot, 'RECOVERING'));
  if (boundary === 'RECOVERING') return snapshot;
  await inbox.enqueue(Object.freeze({
    signature: SHARED_SIGNATURE, slot: 42n, source: 'CATCH_UP',
    programIds: Object.freeze([PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID]),
    confirmationStatus: 'confirmed', observedAtMs: 10_000,
  }));
  if (boundary === 'PARTIAL_ENQUEUE') return snapshot;
  await inbox.compareAndSwapCheckpoint(null, strictCheckpoint('launchpad'));
  if (boundary === 'AFTER_LAUNCHPAD_CAS') return snapshot;
  await inbox.compareAndSwapCheckpoint(null, strictCheckpoint('market'));
  if (boundary === 'AFTER_BOTH_CAS') return snapshot;
  return health.transition(Object.freeze({
    ...healthTransition(snapshot, 'RUNNING'), providerId: 'primary',
    activeSessionGeneration: snapshot.candidateSessionGeneration,
    candidateProviderId: null, candidateSessionGeneration: null,
    acknowledged: true, recoveryStatus: 'RECOVERED', recoveryReasonCode: 'STARTUP',
  }));
}

function strictCheckpoint(key: 'launchpad' | 'market') {
  return Object.freeze({ key, slot: 42n, signature: SHARED_SIGNATURE, updatedAtMs: 10_000 });
}

function healthTransition(
  snapshot: Awaited<ReturnType<PostgresWebSocketHealthRepository['read']>>,
  phase: 'WAITING_FOR_ACKS' | 'ACKNOWLEDGED' | 'RECOVERING' | 'RUNNING',
) {
  return Object.freeze({
    ownerGeneration: snapshot.ownerGeneration, expectedRevision: snapshot.revision, phase,
    providerId: snapshot.providerId, activeSessionGeneration: snapshot.activeSessionGeneration,
    candidateProviderId: snapshot.candidateProviderId, candidateSessionGeneration: snapshot.candidateSessionGeneration,
    acknowledged: phase !== 'WAITING_FOR_ACKS', disconnectReasonCode: null,
    recoveryStatus: phase === 'RUNNING'
      ? 'RECOVERED' as const
      : phase === 'RECOVERING' ? 'IN_PROGRESS' as const : 'REQUIRED' as const,
    recoveryReasonCode: 'STARTUP' as const,
  });
}

async function settled(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

async function waitForProvider(
  supervisor: WebSocketFailoverSupervisor,
  expected: RpcProviderId,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (supervisor.activeProviderId() === expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(supervisor.activeProviderId(), expected);
}

async function waitForSessionCount(sessions: SessionFactory, expected: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (sessions.count >= expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(sessions.count, expected);
}

async function waitForPhase(
  health: PostgresWebSocketHealthRepository,
  expected: 'UNRECOVERABLE' | 'DEGRADED',
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await health.read()).phase === expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await health.read()).phase, expected);
}

async function inboxRow(pool: pg.Pool, signature: string): Promise<{ readonly observed_slot: string; readonly discovery_sources: string[]; readonly program_ids: string[] }> {
  const result = await pool.query<{ readonly observed_slot: string; readonly discovery_sources: string[]; readonly program_ids: string[] }>(
    'SELECT observed_slot::TEXT, discovery_sources, program_ids FROM chain_transaction_inbox WHERE signature = $1', [signature],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Expected inbox row.');
  return row;
}

async function inboxCount(pool: pg.Pool, signature: string): Promise<number> {
  const result = await pool.query<{ readonly count: string }>(
    'SELECT count(*)::TEXT AS count FROM chain_transaction_inbox WHERE signature = $1', [signature],
  );
  return Number(result.rows[0]?.count);
}

async function unresolvedStrictFailureCount(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ readonly count: string }>(
    'SELECT count(*)::TEXT AS count FROM listener_strict_catch_up_failures WHERE resolved_at IS NULL',
  );
  return Number(result.rows[0]?.count);
}

async function withDatabase(context: TestContext, action: (pool: pg.Pool) => Promise<void>): Promise<void> {
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: WebSocket supervisor integration skipped');
    return;
  }
  const schema = `websocket_supervisor_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool });
    await action(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}
