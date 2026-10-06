import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { PostgresMarketPoolTrackingRepository } from '../src/storage/market-pool-tracking.repository.js';

const databaseUrl = process.env.LIVE_TEST_DATABASE_URL;
const HOUR = 3_600_000;

void test('market pool tracking repository: candidates, seeding, monotonic store, operator re-seed', async (context) => {
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('LIVE_TEST_DATABASE_URL must point to a disposable PostgreSQL database.');
    return;
  }
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//u, ''));
  assert.notEqual(databaseName, 'solanabot', 'pool tracking tests must never use the target database');
  const schema = `pool_tracking_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`
      CREATE TABLE domain_events (event_id TEXT PRIMARY KEY, signature TEXT NOT NULL,
        slot NUMERIC(78,0) NOT NULL, observed_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE market_pools (pool_address TEXT PRIMARY KEY, base_mint TEXT NOT NULL,
        activation_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
        pool_state TEXT NOT NULL, confirmation_status TEXT NOT NULL);
      CREATE TABLE paper_strategy_sessions (session_id TEXT PRIMARY KEY, mint TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE live_positions (position_id TEXT PRIMARY KEY, mint TEXT NOT NULL, status TEXT NOT NULL);
    `);
    await pool.query(await readFile(new URL('../migrations/023_market_pool_checkpoints.sql', import.meta.url), 'utf8'));

    const now = Date.UTC(2026, 9, 6, 12);
    const seedPool = async (name: string, ageHours: number, state = 'active', status = 'confirmed'): Promise<void> => {
      await pool.query('INSERT INTO domain_events VALUES ($1,$2,$3,$4)',
        [`evt-${name}`, `sig-${name}`, 500, new Date(now - ageHours * HOUR)]);
      await pool.query('INSERT INTO market_pools VALUES ($1,$2,$3,$4,$5)',
        [name, `mint-${name}`, `evt-${name}`, state, status]);
    };
    await seedPool('fresh', 1);
    await seedPool('stale', 10);
    await seedPool('paper', 20);
    await seedPool('live', 30);
    await seedPool('retracted', 1, 'retracted', 'orphaned');
    await pool.query("INSERT INTO paper_strategy_sessions VALUES ('s1','mint-paper','PAPER_HOLDING')");
    await pool.query("INSERT INTO paper_strategy_sessions VALUES ('s2','mint-stale','CLOSED')");
    await pool.query("INSERT INTO live_positions VALUES ('p1','mint-live','RECONCILIATION_REQUIRED')");

    const repository = new PostgresMarketPoolTrackingRepository(pool);
    const candidates = await repository.listCandidates(now - 6 * HOUR);
    assert.deepEqual(
      candidates.map((row) => [row.poolAddress, row.engaged]).sort(),
      [['fresh', false], ['live', true], ['paper', true]],
    );
    const fresh = candidates.find((row) => row.poolAddress === 'fresh');
    assert.equal(fresh?.activationSignature, 'sig-fresh');
    assert.equal(fresh?.activationSlot, 500n);
    assert.equal(fresh?.activatedAtMs, now - HOUR);

    assert.ok(fresh !== undefined);
    await repository.seedFromActivation(fresh, now);
    await repository.storeCheckpoint('fresh', { slot: 600n, signature: 'sig-600' }, now);
    await repository.seedFromActivation(fresh, now);
    assert.deepEqual(await repository.readCheckpoint('fresh'),
      { poolAddress: 'fresh', slot: 600n, signature: 'sig-600' }, 'seeding never overwrites');

    await assert.rejects(
      repository.storeCheckpoint('fresh', { slot: 599n, signature: 'sig-599' }, now),
      /monotonic/u,
    );

    await repository.reseedAtFrontier('fresh', { slot: 900n, signature: 'sig-900' }, now);
    const row = await pool.query<{ source: string; previous: { slot: string; signature: string; source: string } }>(
      "SELECT source, previous FROM market_pool_checkpoints WHERE pool_address='fresh'",
    );
    assert.equal(row.rows[0]?.source, 'operator-approved-pool-frontier-seed');
    assert.deepEqual(row.rows[0]?.previous, { slot: '600', signature: 'sig-600', source: 'rolling-catch-up' });
    assert.equal(await repository.readCheckpoint('stale'), null);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
