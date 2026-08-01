import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createTokenLaunchDetectedEvent, createBondingCurveTradeObservedEvent } from '../src/domain/launchpad-events.js';
import { createInitialDetectedTransition } from '../src/domain/state-transitions.js';
import { ConfirmationStatusConflictError } from '../src/domain/confirmation-status.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresLaunchpadEventRepository } from '../src/storage/launchpad-event.repository.js';
import { toJsonValue } from '../src/utils/json.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

void test('atomically persists creation and initial buy and restores active events', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `launchpad_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  context.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await migrateDatabase({ pool });
  const repository = new PostgresLaunchpadEventRepository(pool);
  const batch = fixture('confirmed');
  const result = await repository.record(batch);
  assert.deepEqual(result.events.map((item) => item.outcome), ['created', 'created']);
  const counts = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM raw_chain_events) raw,
    (SELECT COUNT(*)::int FROM domain_events) domain,
    (SELECT COUNT(*)::int FROM token_launches) launches,
    (SELECT COUNT(*)::int FROM launch_trades) trades,
    (SELECT COUNT(*)::int FROM state_transitions) transitions`);
  assert.deepEqual(counts.rows[0], { raw: 2, domain: 2, launches: 1, trades: 1, transitions: 1 });
  const tracked = await repository.listTrackedMints();
  assert.deepEqual([...tracked], ['mint-a']);
  assert.throws(() => (tracked as Set<string>).add('mutated'), TypeError);
  const restored = await repository.listActiveEventsBySignature('signature-a');
  assert.deepEqual(restored, batch.events);
  assert.equal(restored[1]?.type, 'BondingCurveTradeObserved');
  assert.equal(typeof (restored[1]?.type === 'BondingCurveTradeObserved' ? restored[1].payload.trade.baseAmountRaw : null), 'bigint');
  assert.equal(Object.isFrozen(restored), true);
});

void test('preserves multiple outer and inner events in one transaction and accepts different signatures concurrently', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool);
    const batch = fixture('confirmed');
    const firstTrade = batch.events[1];
    assert.ok(firstTrade?.type === 'BondingCurveTradeObserved');
    const transaction = { signature: batch.signature, confirmationStatus: batch.confirmationStatus, blockTimeMs: 1_000, observedAtMs: 2_000, cursor: { slot: firstTrade.cursor.slot, transactionIndex: firstTrade.cursor.transactionIndex }, raw: null };
    const secondTrade = createBondingCurveTradeObservedEvent({ source: batch.source, program: batch.program, transaction, trade: { ...firstTrade.payload.trade, id: 'trade-b', cursor: { ...firstTrade.cursor, instructionIndex: 2, innerInstructionIndex: null } } });
    await repository.record({ ...batch, events: [...batch.events, secondTrade] });
    assert.equal((await pool.query('SELECT COUNT(*)::int count FROM launch_trades')).rows[0].count, 2);
    const active = await repository.listActiveEventsBySignature(batch.signature);
    assert.deepEqual(active.map(event => [event.cursor.instructionIndex, event.cursor.innerInstructionIndex]), [[2, null], [2, null], [2, 1]]);
    assert.equal((active[0]?.id ?? '') < (active[1]?.id ?? ''), true);

    await Promise.all([repository.record(fixture('confirmed', 'signature-b', 'mint-b')), repository.record(fixture('confirmed', 'signature-c', 'mint-c'))]);
    assert.deepEqual([...await repository.listTrackedMints()], ['mint-a', 'mint-b', 'mint-c']);
  });
});

void test('validates deterministic fingerprints before acquiring a database client', async () => {
  let connections = 0;
  const repository = new PostgresLaunchpadEventRepository({ connect: () => { connections += 1; throw new Error('must not connect'); } });
  const batch = fixture('confirmed');
  const trade = batch.events[1];
  assert.ok(trade?.type === 'BondingCurveTradeObserved');
  const launch = batch.events[0];
  assert.ok(launch);
  await assert.rejects(repository.record({ ...batch, events: [launch, { ...trade, id: 'tampered' }] }), (error: unknown) => {
    assert.equal((error as Error).name, 'LaunchpadEventConflictError');
    return true;
  });
  assert.equal(connections, 0);
});

void test('replays exactly, promotes finality, retracts confirmed observations, and filters readers', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool, 4, () => 10_000);
    assert.deepEqual((await repository.record(fixture('processed'))).events.map(x => x.outcome), ['created','created']);
    assert.deepEqual((await repository.record(fixture('processed'))).events.map(x => x.outcome), ['duplicate','duplicate']);
    assert.deepEqual((await repository.record(fixture('confirmed', 'signature-a', 'mint-a', 3_000))).events.map(x => x.outcome), ['confirmation_updated','confirmation_updated']);
    assert.equal((await pool.query("SELECT COUNT(*)::int count FROM domain_events")).rows[0].count, 2);
    assert.deepEqual((await repository.record(fixture('orphaned'))).events.map(x => x.outcome), ['confirmation_updated','confirmation_updated']);
    assert.deepEqual(await repository.listActiveEventsBySignature('signature-a'), []);
    assert.deepEqual([...await repository.listTrackedMints()], []);
    const rows = await pool.query("SELECT confirmation_status, terminal_at IS NOT NULL terminal FROM raw_chain_events ORDER BY event_id");
    assert.equal(rows.rows.every(row => row.confirmation_status === 'orphaned' && row.terminal === true), true);
  });
});

void test('first orphan persists raw proof without active projections', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool);
    await repository.record(fixture('orphaned'));
    const counts = await pool.query(`SELECT (SELECT COUNT(*)::int FROM raw_chain_events) raw,
      (SELECT COUNT(*)::int FROM domain_events) domain,(SELECT COUNT(*)::int FROM token_launches) launches`);
    assert.deepEqual(counts.rows[0], { raw: 2, domain: 0, launches: 0 });
  });
});

void test('rejects finalized orphaning and immutable payload contradictions', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool);
    await repository.record(fixture('finalized'));
    await assert.rejects(repository.record(fixture('orphaned')), ConfirmationStatusConflictError);
    const changed = fixture('finalized');
    const trade = changed.events[1];
    assert.ok(trade?.type === 'BondingCurveTradeObserved');
    const launch = changed.events[0];
    assert.ok(launch);
    const contradictory = { ...changed, events: [launch, { ...trade, payload: { trade: { ...trade.payload.trade, quoteAmountRaw: 2n } } }] };
    await assert.rejects(repository.record(contradictory), (error: unknown) => {
      assert.equal((error as Error).name, 'LaunchpadEventConflictError');
      assert.equal((error as Error).message, 'Launchpad event immutable state conflicts.');
      return true;
    });
  });
});

void test('serializes concurrent same-signature replays without duplicating rows', async (context) => {
  await withDatabase(context, async (pool) => {
    const first = new PostgresLaunchpadEventRepository(pool);
    const second = new PostgresLaunchpadEventRepository(pool);
    const outcomes = await Promise.all([first.record(fixture('confirmed')), second.record(fixture('confirmed'))]);
    assert.deepEqual(outcomes.flatMap(x => x.events.map(y => y.outcome)).sort(), ['created','created','duplicate','duplicate']);
    assert.equal((await pool.query('SELECT COUNT(*)::int count FROM domain_events')).rows[0].count, 2);
  });
});

void test('reader sorts full cursors, restores bigints, and rejects corrupt rows safely', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresLaunchpadEventRepository(pool);
    const batch = fixture('confirmed');
    await repository.record({ ...batch, events: [...batch.events].reverse() });
    const events = await repository.listActiveEventsBySignature('signature-a');
    assert.deepEqual(events.map(event => event.type), ['TokenLaunchDetected','BondingCurveTradeObserved']);
    await pool.query("UPDATE domain_events SET payload='{\"trade\":{\"baseAmountRaw\":{\"$solTokenListenerBigInt\":\"not-a-bigint\"}}}'::jsonb WHERE type='BondingCurveTradeObserved'");
    await assert.rejects(repository.listActiveEventsBySignature('signature-a'), (error: unknown) => {
      assert.equal((error as Error).name, 'LaunchpadEventRepositoryError');
      assert.equal((error as Error).message, 'Launchpad event repository operation failed.');
      assert.equal(Object.hasOwn(error as object, 'cause'), false);
      return true;
    });
    const trade = batch.events[1];
    assert.ok(trade?.type === 'BondingCurveTradeObserved');
    await pool.query("UPDATE domain_events SET payload=$1 WHERE type='BondingCurveTradeObserved'", [toJsonValue(trade.payload)]);
    await pool.query("UPDATE raw_chain_events SET payload='{}'::jsonb WHERE mint='mint-a'");
    await assert.rejects(
      repository.listActiveEventsBySignature('signature-a'),
      (error: unknown) => (error as Error).name === 'LaunchpadEventRepositoryError',
    );
  });
});

void test('rolls back statement failures, releases clients, and redacts database secrets', async () => {
  let released = false;
  const secret = 'postgres://user:password@secret-host/private';
  const client = { query(text: string) { if (text.includes('INSERT INTO raw_chain_events')) throw new Error(secret); return Promise.resolve({ rows: [], rowCount: 1 }); }, release() { released = true; } };
  const repository = new PostgresLaunchpadEventRepository({ connect: () => Promise.resolve(client) });
  await assert.rejects(repository.record(fixture('confirmed')), (error: unknown) => {
    assert.equal((error as Error).message.includes(secret), false);
    assert.equal(Object.hasOwn(error as object, 'cause'), false);
    return true;
  });
  assert.equal(released, true);
});

async function withDatabase(context: { skip(message?: string): void }, run: (pool: InstanceType<typeof pg.Pool>) => Promise<void>) {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `launchpad_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try { await admin.query(`CREATE SCHEMA ${schema}`); await migrateDatabase({ pool }); await run(pool); }
  finally { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
}

function fixture(status: 'processed' | 'confirmed' | 'finalized' | 'orphaned', signature = 'signature-a', mint = 'mint-a', observedAtMs = 2_000) {
  const transaction = { signature, confirmationStatus: status, blockTimeMs: 1_000, observedAtMs, cursor: { slot: 9_007_199_254_740_993n, transactionIndex: 4 }, raw: null };
  const quoteAsset = { mint: 'quote', decimals: 9, tokenProgram: 'SPL_TOKEN' as const };
  const launch = createTokenLaunchDetectedEvent({ source: 'pumpfun', program: 'pump', transaction, launch: { mint, creator: 'creator', tokenProgram: 'SPL_TOKEN', quoteAssets: [quoteAsset], launchpad: 'pumpfun', createdAt: { ...transaction.cursor, instructionIndex: 2, innerInstructionIndex: null }, parameters: { initialSupply: 1_000_000_000_000_000_000n } } });
  const trade = createBondingCurveTradeObservedEvent({ source: 'pumpfun', program: 'pump', transaction, trade: { id: `trade-${mint}`, launchMint: mint, kind: 'BUY', trader: 'buyer', baseAmountRaw: 9007199254740993n, quoteAmountRaw: 1000000000n, quoteAsset, cursor: { ...transaction.cursor, instructionIndex: 2, innerInstructionIndex: 1 } } });
  return status === 'orphaned' ? { source: 'pumpfun', program: 'pump', signature: transaction.signature, confirmationStatus: status, events: [launch, trade], stateTransitionAction: 'retract' as const, transitions: [] as const } : { source: 'pumpfun', program: 'pump', signature: transaction.signature, confirmationStatus: status, events: [launch, trade], stateTransitionAction: 'apply' as const, transitions: [createInitialDetectedTransition(launch)] };
}
