import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationUrl = new URL('../migrations/018_paper_mvp_validation.sql', import.meta.url);

void test('defines replayable paper MVP runs and immutable samples', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS paper_mvp_runs/u);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS paper_mvp_position_samples/u);
  assert.match(sql, /initial_capital_raw NUMERIC\(78,0\) NOT NULL/u);
  assert.match(sql, /network_fee_raw_per_transaction NUMERIC\(78,0\) NOT NULL/u);
  assert.match(sql, /buy_amount_in_raw NUMERIC\(78,0\)/u);
  assert.match(sql, /model_net_pnl_raw NUMERIC\(78,0\)/u);
  assert.match(sql, /configuration_payload JSONB NOT NULL/u);
  assert.match(sql, /sample_payload JSONB NOT NULL/u);
  assert.match(sql, /report_payload JSONB/u);
  assert.match(sql, /payload_version INTEGER NOT NULL CHECK \(payload_version = 1\)/u);
  assert.match(sql, /state IN \('RUNNING','COMPLETED','FAILED'\)/u);
  assert.match(sql, /purge_after = terminal_at \+ INTERVAL '4 hours'/u);
  assert.match(sql, /paper_mvp_runs_one_active_idx/u);
  assert.match(sql, /WHERE state = 'RUNNING'/u);
  assert.match(sql, /REFERENCES paper_mvp_runs\(run_id\) ON DELETE CASCADE/u);
  assert.match(sql, /sample_status IN \('VALID','UNKNOWN'\)/u);
  assert.match(sql, /sample_status = 'UNKNOWN' AND unknown_reason IS NOT NULL/u);
  assert.match(sql, /paper-mvp-unknown-position\.v1/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS entry_decision_at TIMESTAMPTZ/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS entry_decision_job_id TEXT/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS quote_observed_at TIMESTAMPTZ/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS close_event_id TEXT REFERENCES domain_events\(event_id\)/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS exit_trigger_at TIMESTAMPTZ/u);
  assert.match(sql, /paper_positions_mvp_collect_idx/u);
  assert.match(sql, /POSITION_RETRACTED/u);
  assert.match(sql, /prevent_paper_mvp_sample_mutation/u);
  assert.match(sql, /prevent_paper_mvp_run_immutable_mutation/u);
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL|DOUBLE PRECISION)\b/iu);
  assert.doesNotMatch(sql, /DROP TABLE|private[_ ]?key|keypair|send[_ ]?transaction/iu);
});

void test('applies migrations 001-018 on an empty schema and replays cleanly', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL paper MVP migration test skipped');
    return;
  }
  const schema = `paper_mvp_migration_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), '018_paper_mvp_validation.sql');
    assert.deepEqual(await migrateDatabase({ pool }), []);
    const sql = await readFile(migrationUrl, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const tables = await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema=current_schema()
        AND table_name IN ('paper_mvp_runs','paper_mvp_position_samples')
      ORDER BY table_name`);
    assert.deepEqual(tables.rows, [
      { table_name: 'paper_mvp_position_samples' },
      { table_name: 'paper_mvp_runs' },
    ]);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z_][a-z0-9_]*$/u);
  return `"${identifier}"`;
}
