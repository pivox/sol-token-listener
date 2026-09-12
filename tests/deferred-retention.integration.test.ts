import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createTokenLaunchDetectedEvent } from '../src/domain/launchpad-events.js';
import { createInitialDetectedTransition } from '../src/domain/state-transitions.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import { PostgresLaunchpadEventRepository } from '../src/storage/launchpad-event.repository.js';
import { PostgresTransactionInboxRepository } from '../src/storage/transaction-inbox.repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const mint = 'So11111111111111111111111111111111111111112';
type Pool = InstanceType<typeof pg.Pool>;

void test('retains expired deferred trades across creation commit and a restarted mint synchronization', async (context) => {
  await withDatabase(context, async (pool) => {
    await seedExpiredTrade(pool);
    await new PostgresLaunchpadEventRepository(pool).record(creation());
    assert.equal((await purgeExpiredFoundationData(pool)).transactionInbox, 0);
    assert.equal((await trade(pool)).processing_status, 'DEFERRED');
    // The first process can crash after record() commits and before syncTrackedMint().
    await new PostgresTransactionInboxRepository(pool).syncTrackedMint(mint);
    assert.deepEqual(await trade(pool), {
      processing_status: 'PENDING', ingestion_priority: 'TRACKED_TRADE',
      terminal_at: null, purge_after: null,
    });
  });
});

void test('creation projection holding the retention fence wins against an overlapping purge', async (context) => {
  await withDatabase(context, async (pool) => {
    await seedExpiredTrade(pool);
    const projected = gate();
    const projectionPool = instrument(pool, async (query, stage) => {
      if (stage === 'after' && query.includes('INSERT INTO token_launches')) await projected.pause();
    });
    const retentionPool = instrument(pool);
    const recording = new PostgresLaunchpadEventRepository(projectionPool.pool).record(creation());
    let purging: ReturnType<typeof purgeExpiredFoundationData> | undefined;
    let purgeSettled = false;
    try {
      await projected.reached;
      purging = purgeExpiredFoundationData(retentionPool.pool);
      void purging.then(() => { purgeSettled = true; }, () => { purgeSettled = true; });
      assert.equal(await waitsFor(pool, retentionPool, projectionPool, () => purgeSettled), true,
        'purge must wait for the in-flight creation transaction, not delete its deferred trades');
      assert.equal(retentionPool.queries.length, 2, 'purge waits before taking any data-row locks');
      projected.resume();
      await recording;
      assert.equal((await purging).transactionInbox, 0);
      assertFenceFirst(projectionPool.queries, 'shared');
      assertFenceFirst(retentionPool.queries, 'exclusive');
      await new PostgresTransactionInboxRepository(pool).syncTrackedMint(mint);
      assert.equal((await trade(pool)).processing_status, 'PENDING');
    } finally {
      projected.resume();
      await Promise.allSettled([recording, ...(purging === undefined ? [] : [purging])]);
    }
  });
});

void test('purge holding the retention fence expires an inactive trade before later creation can project', async (context) => {
  await withDatabase(context, async (pool) => {
    await seedExpiredTrade(pool);
    const deleting = gate();
    const retentionPool = instrument(pool, async (query, stage) => {
      if (stage === 'before' && query.includes('DELETE FROM chain_transaction_inbox')) await deleting.pause();
    });
    const projectionPool = instrument(pool);
    const purging = purgeExpiredFoundationData(retentionPool.pool);
    let recording: ReturnType<PostgresLaunchpadEventRepository['record']> | undefined;
    let recordSettled = false;
    try {
      await deleting.reached;
      recording = new PostgresLaunchpadEventRepository(projectionPool.pool).record(creation());
      void recording.then(() => { recordSettled = true; }, () => { recordSettled = true; });
      assert.equal(await waitsFor(pool, projectionPool, retentionPool, () => recordSettled), true,
        'creation must wait before projecting when purge already owns the retention fence');
      assert.equal(projectionPool.queries.length, 2, 'creation waits before signature or data-row locks');
      assert.equal((await pool.query('SELECT mint FROM token_launches')).rowCount, 0);
      deleting.resume();
      assert.equal((await purging).transactionInbox, 1);
      await recording;
      await new PostgresTransactionInboxRepository(pool).syncTrackedMint(mint);
      assert.equal((await pool.query('SELECT signature FROM chain_transaction_inbox')).rowCount, 0);
    } finally {
      deleting.resume();
      await Promise.allSettled([purging, ...(recording === undefined ? [] : [recording])]);
    }
  });
});

void test('mint synchronization holding the retention fence completes before overlapping purge', async (context) => {
  await withDatabase(context, async (pool) => {
    await seedExpiredTrade(pool);
    await new PostgresLaunchpadEventRepository(pool).record(creation());
    const synchronizing = gate();
    const syncPool = instrument(pool, async (query, stage) => {
      if (stage === 'before' && query.includes('UPDATE chain_transaction_inbox inbox SET')) await synchronizing.pause();
    });
    const retentionPool = instrument(pool);
    const syncing = new PostgresTransactionInboxRepository(syncPool.pool).syncTrackedMint(mint);
    let purging: ReturnType<typeof purgeExpiredFoundationData> | undefined;
    let purgeSettled = false;
    try {
      await synchronizing.reached;
      purging = purgeExpiredFoundationData(retentionPool.pool);
      void purging.then(() => { purgeSettled = true; }, () => { purgeSettled = true; });
      assert.equal(await waitsFor(pool, retentionPool, syncPool, () => purgeSettled), true);
      synchronizing.resume();
      await syncing;
      assert.equal((await purging).transactionInbox, 0);
      assert.equal((await trade(pool)).ingestion_priority, 'TRACKED_TRADE');
      assertFenceFirst(syncPool.queries, 'shared');
    } finally {
      synchronizing.resume();
      await Promise.allSettled([syncing, ...(purging === undefined ? [] : [purging])]);
    }
  });
});

void test('trade enqueue takes the retention fence before its signature, mint and row locks', async (context) => {
  await withDatabase(context, async (pool) => {
    await seedExpiredTrade(pool);
    const enqueuing = gate();
    const enqueuePool = instrument(pool, async (query, stage) => {
      if (stage === 'before' && query.includes('SELECT observed_slot, ingestion_priority')) await enqueuing.pause();
    });
    const retentionPool = instrument(pool);
    const enqueue = new PostgresTransactionInboxRepository(enqueuePool.pool).enqueue(notification());
    let purging: ReturnType<typeof purgeExpiredFoundationData> | undefined;
    let purgeSettled = false;
    try {
      await enqueuing.reached;
      purging = purgeExpiredFoundationData(retentionPool.pool);
      void purging.then(() => { purgeSettled = true; }, () => { purgeSettled = true; });
      assert.equal(await waitsFor(pool, retentionPool, enqueuePool, () => purgeSettled), true);
      assertFenceFirst(enqueuePool.queries, 'shared');
      enqueuing.resume();
      await enqueue;
      assert.equal((await purging).transactionInbox, 1);
    } finally {
      enqueuing.resume();
      await Promise.allSettled([enqueue, ...(purging === undefined ? [] : [purging])]);
    }
  });
});

void test('a terminal launch does not extend the exact four-hour deferred retention', async (context) => {
  await withDatabase(context, async (pool) => {
    await seedExpiredTrade(pool);
    const before = await trade(pool);
    assert.equal((before.purge_after as Date).getTime() - (before.terminal_at as Date).getTime(), 14_400_000);
    const repository = new PostgresLaunchpadEventRepository(pool);
    const batch = creation();
    await repository.record(batch);
    await repository.record({
      ...batch, confirmationStatus: 'orphaned', stateTransitionAction: 'retract', transitions: [],
      events: batch.events.map((event) => ({ ...event, confirmationStatus: 'orphaned' as const })),
    });
    assert.equal((await purgeExpiredFoundationData(pool)).transactionInbox, 1);
    assert.equal((await purgeExpiredFoundationData(pool)).transactionInbox, 0);
  });
});

void test('a failed deferred purge rolls back its deletion and releases the fence for creation and restart', async (context) => {
  await withDatabase(context, async (pool) => {
    await seedExpiredTrade(pool);
    const interrupted = instrument(pool, async (query, stage) => {
      if (stage === 'after' && query.includes('DELETE FROM chain_transaction_inbox')) {
        throw new Error('forced deferred purge rollback');
      }
    });
    await assert.rejects(purgeExpiredFoundationData(interrupted.pool), /forced deferred purge rollback/u);
    assert.equal((await trade(pool)).processing_status, 'DEFERRED');
    await new PostgresLaunchpadEventRepository(pool).record(creation());
    assert.equal((await purgeExpiredFoundationData(pool)).transactionInbox, 0);
    await new PostgresTransactionInboxRepository(pool).syncTrackedMint(mint);
    assert.equal((await trade(pool)).ingestion_priority, 'TRACKED_TRADE');
  });
});

function notification() {
  return Object.freeze({
    signature: 'expired-trade', slot: 1n, source: 'WEBSOCKET' as const,
    ingestionHint: 'PUMPFUN_TRADE' as const, ingestionHintMint: mint,
    programIds: Object.freeze([PUMP_PROGRAM_ID]), confirmationStatus: 'processed' as const, observedAtMs: 1_000,
  });
}

async function seedExpiredTrade(pool: Pool): Promise<void> {
  await new PostgresTransactionInboxRepository(pool).enqueue(notification());
  await pool.query(`UPDATE chain_transaction_inbox
    SET terminal_at=TIMESTAMPTZ '2020-01-01T00:00:00Z',
      purge_after=TIMESTAMPTZ '2020-01-01T04:00:00Z'
    WHERE signature='expired-trade'`);
}

async function trade(pool: Pool) {
  const result = await pool.query(`SELECT processing_status,ingestion_priority,terminal_at,purge_after
    FROM chain_transaction_inbox WHERE signature='expired-trade'`);
  assert.equal(result.rowCount, 1, 'deferred signature must remain durable');
  return result.rows[0] as Record<string, unknown>;
}

function creation() {
  const transaction = {
    signature: 'creation', confirmationStatus: 'confirmed' as const,
    blockTimeMs: 1_000, observedAtMs: 2_000,
    cursor: { slot: 1n, transactionIndex: 0 }, raw: null,
  };
  const event = createTokenLaunchDetectedEvent({
    source: 'pumpfun', program: PUMP_PROGRAM_ID, transaction,
    launch: {
      mint, creator: mint, tokenProgram: 'SPL_TOKEN', launchpad: 'pumpfun', parameters: {},
      quoteAssets: [{ mint, decimals: 9, tokenProgram: 'SPL_TOKEN' }],
      createdAt: { ...transaction.cursor, instructionIndex: 0, innerInstructionIndex: null },
    },
  });
  return {
    source: 'pumpfun', program: PUMP_PROGRAM_ID, signature: transaction.signature,
    confirmationStatus: transaction.confirmationStatus, stateTransitionAction: 'apply' as const,
    events: [event], transitions: [createInitialDetectedTransition(event)],
  };
}

function gate() {
  let reached!: () => void;
  let resume!: () => void;
  const arrived = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { resume = resolve; });
  return { reached: arrived, resume, pause: async () => { reached(); await released; } };
}

function instrument(pool: Pool, hook: (query: string, stage: 'before' | 'after') => Promise<void> = async () => {}) {
  const state = { pid: 0, queries: [] as string[], pool: undefined as unknown as Pool };
  state.pool = {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      state.pid = result.rows[0]?.pid ?? 0;
      return {
        query: async (query: string, values?: unknown[]) => {
          state.queries.push(query);
          await hook(query, 'before');
          const result = await client.query(query, values);
          await hook(query, 'after');
          return result;
        },
        release: () => { client.release(); },
      };
    },
  } as Pool;
  return state;
}

function assertFenceFirst(queries: readonly string[], mode: 'shared' | 'exclusive'): void {
  assert.match(queries[0] ?? '', /^BEGIN\b/u);
  assert.equal(queries[1], `SELECT pg_advisory_xact_lock${mode === 'shared' ? '_shared' : ''}(hashtextextended('foundation-retention-fence:v1', 0))`);
}

async function waitsFor(pool: Pool, waiter: { pid: number }, holder: { pid: number }, settled: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (!settled() && Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(
      'SELECT $2::integer = ANY(pg_blocking_pids($1)) AS blocked', [waiter.pid, holder.pid],
    );
    if (result.rows[0]?.blocked === true) return true;
  }
  return false;
}

async function withDatabase(context: { skip(message?: string): void }, run: (pool: Pool) => Promise<void>): Promise<void> {
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  const schema = `deferred_retention_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrateDatabase({ pool });
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}
