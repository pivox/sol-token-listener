import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { PromotedProviderSelector } from '../src/application/promoted-provider-selector.js';
import { StrictCatchUpScanner, StrictCatchUpWindowExceededError } from '../src/application/strict-catch-up-scanner.js';
import { WebSocketFailoverSupervisor, type WebSocketFailoverScheduler } from '../src/application/websocket-failover-supervisor.js';
import { PersistentWebSocketHealthReporter } from '../src/application/websocket-health-reporter.js';
import type { RpcProviderId } from '../src/domain/rpc-provider.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import type { CatchUpSource } from '../src/ports/catch-up-source.js';
import type { RpcProviderCatalog, RpcProviderPair } from '../src/solana/rpc/rpc-provider-catalog.js';
import type { WsProgramNotification, WsProgramSession, WsProgramSessionCompletion } from '../src/solana/rpc/ws-program-session.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresTransactionInboxRepository, TransactionInboxConflictError } from '../src/storage/transaction-inbox.repository.js';
import { PostgresWebSocketHealthRepository } from '../src/storage/websocket-health.repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const SHARED_SIGNATURE = '1'.repeat(64);

void test('merges one signature from incumbent WS, replacement WS and strict HTTP without changing its immutable slot', async (context) => {
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

    sessions.at(0).complete('REMOTE_CLOSE');
    await settled();
    assert.equal((await health.read()).phase, 'DEGRADED');
    scheduler.fire(0);
    await waitForProvider(supervisor, 'fallback-1');
    await sessions.at(1).observe(wsNotification('pumpswap', 'fallback-1'));

    const stored = await inboxRow(pool, SHARED_SIGNATURE);
    assert.equal(stored.observed_slot, '42');
    assert.deepEqual([...stored.discovery_sources].sort(), ['CATCH_UP', 'WEBSOCKET']);
    assert.deepEqual([...stored.program_ids].sort(), [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort());
    assert.deepEqual(strictScans, ['primary', 'fallback-1']);
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

void test('a stale owner restart allocates a new generation and rescans exact persisted boundaries', async (context) => {
  await withDatabase(context, async (pool) => {
    const inbox = new PostgresTransactionInboxRepository(pool);
    const health = new PostgresWebSocketHealthRepository(pool);
    const first = await health.beginOwner({ candidateProviderId: 'primary' });
    const waiting = await health.transition(transition(first, 'WAITING_FOR_ACKS'));
    const acknowledged = await health.transition(transition(waiting, 'ACKNOWLEDGED'));
    const recovering = await health.transition(transition(acknowledged, 'RECOVERING'));
    await inbox.compareAndSwapCheckpoint(null, checkpoint('launchpad', 20n));
    await inbox.compareAndSwapCheckpoint(null, checkpoint('market', 21n));
    const running = await health.transition({
      ...transition(recovering, 'RUNNING'), providerId: 'primary',
      activeSessionGeneration: recovering.candidateSessionGeneration,
      candidateProviderId: null, candidateSessionGeneration: null,
      acknowledged: true, recoveryStatus: 'RECOVERED', recoveryReasonCode: 'STARTUP',
    });
    await pool.query(`UPDATE listener_websocket_health
      SET heartbeat_at = clock_timestamp() - INTERVAL '31 seconds'
      WHERE service_key = 'transaction-listener'`);

    const restarted = await health.beginOwner({ candidateProviderId: 'fallback-1' });
    assert.equal(restarted.ownerGeneration, running.ownerGeneration + 1n);
    assert.equal(restarted.phase, 'CONNECTING');
    assert.equal(restarted.recovery.status, 'REQUIRED');
    assert.equal(restarted.recovery.reasonCode, 'UNEXPECTED_RESTART');
    assert.deepEqual(await inbox.readCheckpoint('launchpad'), checkpoint('launchpad', 20n));
    assert.deepEqual(await inbox.readCheckpoint('market'), checkpoint('market', 21n));
  });
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

class TestCatalog implements RpcProviderCatalog {
  public readonly ids: readonly RpcProviderId[];
  public constructor(ids: readonly RpcProviderId[]) { this.ids = Object.freeze([...ids]); }
  public resolve(id: RpcProviderId): RpcProviderPair {
    return Object.freeze({ id, httpUrl: `https://${id}.invalid`, websocketUrl: `wss://${id}.invalid` });
  }
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
}

class ControlledSession {
  #resolve!: (value: WsProgramSessionCompletion) => void;
  readonly #completion = new Promise<WsProgramSessionCompletion>((resolve) => { this.#resolve = resolve; });
  readonly session: WsProgramSession;
  public constructor(
    providerId: RpcProviderId,
    public readonly observe: (notification: WsProgramNotification) => Promise<void>,
  ) {
    this.session = Object.freeze({
      endpointId: providerId,
      completion: this.#completion,
      async close(): Promise<void> { return undefined; },
    });
  }
  public complete(reason: WsProgramSessionCompletion['reason']): void { this.#resolve(Object.freeze({ reason })); }
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

function wsNotification(
  program: 'pumpfun' | 'pumpswap',
  endpointId: RpcProviderId = 'primary',
): WsProgramNotification {
  return Object.freeze({ endpointId, program, signature: SHARED_SIGNATURE, slot: 42n });
}

function checkpoint(key: 'launchpad' | 'market', slot: bigint) {
  return Object.freeze({ key, slot, signature: `${key}-${slot.toString()}`, updatedAtMs: 10_000 });
}

function finalityPass(providerId: RpcProviderId) {
  return Object.freeze({
    providerId,
    async getHistoryStatuses(): Promise<readonly unknown[]> { return Object.freeze([]); },
    async getFinalizedSlot(): Promise<bigint> { return 0n; },
    async getFinalizedBlockSignatures(): Promise<readonly unknown[]> { return Object.freeze([]); },
  });
}

function transition(
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

async function waitForPhase(
  health: PostgresWebSocketHealthRepository,
  expected: 'UNRECOVERABLE',
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
