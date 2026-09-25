import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationsUrl = new URL('../migrations/', import.meta.url);
const migrationName = '052_transaction_inbox_urgent_fairness.sql';
const migrationUrl = new URL(migrationName, migrationsUrl);
const actionable = `processing_status = 'PENDING' OR processing_status = 'PROCESSING'
  OR (processing_status = 'FAILED' AND error_retryable = TRUE AND retry_exhausted_at IS NULL)`;

void test('052 defines durable 3-to-1 urgent fairness without replacing the 32-to-1 fence', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const fragment of [
    'launch_claims_since_tracked SMALLINT NOT NULL DEFAULT 0',
    'launch_claims_since_tracked BETWEEN 0 AND 3',
    'chain_transaction_inbox_priority_claim_order_idx',
    'ingestion_priority, observed_slot, signature',
  ]) assert.ok(sql.includes(fragment), `missing migration contract: ${fragment}`);
  assert.doesNotMatch(sql, /DROP INDEX chain_transaction_inbox_claim_order_idx/u);
  assert.doesNotMatch(sql, /\b(?:DELETE FROM|TRUNCATE|CASCADE)\b/u);
});

void test('052 upgrades 051, preserves durable state and replays without replacing its index', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough051(pool);
    await pool.query(`UPDATE chain_transaction_inbox_claim_scheduler
      SET consecutive_urgent_claims=17`);
    const sql = await readFile(migrationUrl, 'utf8');
    await pool.query(sql);
    const beforeIndex = await pool.query(`SELECT
      'chain_transaction_inbox_priority_claim_order_idx'::REGCLASS::OID AS oid`);
    await pool.query(sql);
    assert.deepEqual((await pool.query(`SELECT scheduler_key,consecutive_urgent_claims,
      launch_claims_since_tracked FROM chain_transaction_inbox_claim_scheduler`)).rows, [{
      scheduler_key: 'global', consecutive_urgent_claims: 17, launch_claims_since_tracked: 0,
    }]);
    assert.deepEqual((await pool.query(`SELECT
      'chain_transaction_inbox_priority_claim_order_idx'::REGCLASS::OID AS oid`)).rows,
    beforeIndex.rows);
    await assertCatalog(pool);
  });
});

void test('052 is the replay-safe clean database head', async (context) => {
  await withDatabase(context, async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), '055_creation_entry_single_active_session.sql');
    assert.equal(applied.length, 55);
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await assertCatalog(pool);
  });
});

void test('052 rejects partial columns, weakened checks and incompatible indexes', async (context) => {
  const driftCases = [
    `ALTER TABLE chain_transaction_inbox_claim_scheduler
      ADD COLUMN launch_claims_since_tracked SMALLINT NOT NULL DEFAULT 0`,
    `ALTER TABLE chain_transaction_inbox_claim_scheduler
      ADD COLUMN launch_claims_since_tracked INTEGER NOT NULL DEFAULT 0`,
  ] as const;
  for (const drift of driftCases) {
    await withDatabase(context, async (pool) => {
      await applyThrough051(pool);
      await pool.query(drift);
      await assert.rejects(pool.query(await readFile(migrationUrl, 'utf8')), /incompatible|partial/iu);
    });
  }
  await withDatabase(context, async (pool) => {
    await applyThrough051(pool);
    const sql = await readFile(migrationUrl, 'utf8');
    await pool.query(sql);
    for (const drift of [
      `ALTER TABLE chain_transaction_inbox_claim_scheduler
       DROP CONSTRAINT chain_transaction_inbox_claim_scheduler_launch_fairness_check;
       ALTER TABLE chain_transaction_inbox_claim_scheduler
       ADD CONSTRAINT chain_transaction_inbox_claim_scheduler_launch_fairness_check CHECK (launch_claims_since_tracked>=0)`,
      `DROP INDEX chain_transaction_inbox_priority_claim_order_idx;
       CREATE INDEX chain_transaction_inbox_priority_claim_order_idx
       ON chain_transaction_inbox (signature)`,
    ]) {
      await pool.query('BEGIN');
      try {
        await pool.query(drift);
        await assert.rejects(pool.query(sql), /incompatible/iu);
      } finally {
        await pool.query('ROLLBACK');
      }
    }
  });
});

void test('052 priority index serves every static class claim without sorting', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough051(pool);
    await pool.query(await readFile(migrationUrl, 'utf8'));
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature,observed_slot,discovery_sources,program_ids,target_confirmation_status,
      processing_status,observed_at,ingestion_priority
    ) SELECT priority::TEXT || '-' || series, series, ARRAY['WEBSOCKET'],
      ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'confirmed','PENDING',NOW(),priority
      FROM unnest(ARRAY['NORMAL','LAUNCH_CANDIDATE','TRACKED_TRADE']::chain_transaction_inbox_priority[]) priority
      CROSS JOIN generate_series(1,2000) series`);
    await pool.query('ANALYZE chain_transaction_inbox');
    for (const priority of ['NORMAL', 'LAUNCH_CANDIDATE', 'TRACKED_TRADE']) {
      const explain = JSON.stringify((await pool.query(`EXPLAIN (FORMAT JSON)
        SELECT signature FROM chain_transaction_inbox
        WHERE ingestion_priority=$1::chain_transaction_inbox_priority AND (${actionable})
        ORDER BY observed_slot,signature LIMIT 1`, [priority])).rows);
      assert.match(explain, /chain_transaction_inbox_priority_claim_order_idx/u);
      assert.doesNotMatch(explain, /"Node Type":"(?:Incremental )?Sort"/u);
    }
  });
});

async function assertCatalog(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  assert.deepEqual((await pool.query(`SELECT attname,format_type(atttypid,atttypmod) AS type,
    attnotnull,pg_get_expr(adbin,adrelid) AS default_value FROM pg_attribute
    LEFT JOIN pg_attrdef ON adrelid=attrelid AND adnum=attnum
    WHERE attrelid='chain_transaction_inbox_claim_scheduler'::REGCLASS
      AND attname='launch_claims_since_tracked'`)).rows, [{
    attname: 'launch_claims_since_tracked', type: 'smallint', attnotnull: true, default_value: '0',
  }]);
  assert.deepEqual((await pool.query(`SELECT convalidated FROM pg_constraint
    WHERE conrelid='chain_transaction_inbox_claim_scheduler'::REGCLASS
      AND conname='chain_transaction_inbox_claim_scheduler_launch_fairness_check'`)).rows,
  [{ convalidated: true }]);
  for (const value of [0, 3]) {
    await pool.query(`UPDATE chain_transaction_inbox_claim_scheduler
      SET launch_claims_since_tracked=$1`, [value]);
  }
  for (const value of [-1, 4]) {
    await assert.rejects(pool.query(`UPDATE chain_transaction_inbox_claim_scheduler
      SET launch_claims_since_tracked=$1`, [value]), { code: '23514' });
  }
}

async function applyThrough051(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  for (const name of (await readdir(migrationsUrl)).filter((name) => /^0\d\d_/u.test(name)).sort()) {
    if (name === migrationName) break;
    await pool.query(await readFile(new URL(name, migrationsUrl), 'utf8'));
  }
}

async function withDatabase(
  context: { skip(message?: string): void },
  run: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: urgent fairness migration test skipped');
    return;
  }
  const schema = `urgent_fairness_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
