import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationUrl = new URL('../migrations/017_creation_entry_strategy.sql', import.meta.url);
const databaseUrl = process.env.TEST_DATABASE_URL;

void test('defines additive V2 creation sessions and unique buyer evidence', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /paper_strategy_sessions_payload_version_check/u);
  assert.match(sql, /payload_version IN \(1, 2\)/u);
  assert.match(sql, /EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED/u);
  assert.match(sql, /TAKE_PROFIT_2X_EXECUTABLE/u);
  assert.match(sql, /CREATOR_EARLY_SELL/u);
  assert.match(sql, /MANUAL_KILL_SWITCH/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS strategy_id TEXT/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS quote_amount_raw NUMERIC\(78,0\)/u);
  assert.match(sql, /UPDATE paper_external_buy_events evidence[\s\S]*paper_strategy_sessions session/u);
  assert.match(sql, /paper_external_buy_events_creation_wallet_idx/u);
  assert.match(sql, /WHERE strategy_id = 'creation-entry-v1' AND trader IS NOT NULL/u);
  assert.doesNotMatch(sql, /DELETE FROM|DROP TABLE|\b(?:FLOAT|REAL|DOUBLE PRECISION)\b/iu);
});

void test('applies migrations 001-031 on an empty schema and replays cleanly', async (context) => {
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  const schema = `creation_entry_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^[a-z_][a-z0-9_]*$/u);
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), '031_execution_intents.sql');
    assert.deepEqual(await migrateDatabase({ pool }), []);
    const versions = await pool.query(
      `SELECT payload_version FROM paper_strategy_sessions
       WHERE FALSE UNION ALL SELECT 2`,
    );
    assert.deepEqual(versions.rows, [{ payload_version: 2 }]);
    const columns = await pool.query(`SELECT column_name,is_nullable FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='paper_external_buy_events'
        AND column_name IN ('strategy_id','quote_amount_raw') ORDER BY column_name`);
    assert.deepEqual(columns.rows, [
      { column_name: 'quote_amount_raw', is_nullable: 'YES' },
      { column_name: 'strategy_id', is_nullable: 'NO' },
    ]);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
