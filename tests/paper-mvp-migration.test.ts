import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationUrl = new URL('../migrations/018_paper_mvp_validation.sql', import.meta.url);
const collectionMigrationUrl = new URL('../migrations/019_paper_mvp_collection.sql', import.meta.url);
const derivedPnlMigrationUrl = new URL('../migrations/020_paper_mvp_derived_pnl.sql', import.meta.url);

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
  assert.match(sql, /ADD COLUMN IF NOT EXISTS close_event_id TEXT REFERENCES domain_events\(event_id\)/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS exit_trigger_at TIMESTAMPTZ/u);
  assert.doesNotMatch(sql, /entry_decision_job_id|quote_observed_at|paper_positions_mvp_collect_idx|POSITION_RETRACTED/u);
  assert.match(sql, /prevent_paper_mvp_sample_mutation/u);
  assert.match(sql, /prevent_paper_mvp_run_immutable_mutation/u);
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL|DOUBLE PRECISION)\b/iu);
  assert.doesNotMatch(sql, /DROP TABLE|private[_ ]?key|keypair|send[_ ]?transaction/iu);
});

void test('defines the collection upgrade without rewriting migration 018', async () => {
  const sql = await readFile(collectionMigrationUrl, 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS entry_decision_job_id TEXT/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS quote_observed_at TIMESTAMPTZ/u);
  assert.match(sql, /paper_positions_mvp_collect_idx/u);
  assert.match(sql, /POSITION_RETRACTED/u);
  assert.match(sql, /entry_decision_at IS NULL OR entry_decision_at <= opened_at/u);
  assert.match(sql, /exit_trigger_at IS NULL OR closed_at IS NULL OR exit_trigger_at <= closed_at/u);
});

void test('widens only the derived model PnL for two 78-digit network fees', async () => {
  const sql = await readFile(derivedPnlMigrationUrl, 'utf8');
  assert.match(sql, /ALTER COLUMN model_net_pnl_raw TYPE NUMERIC\(79,0\)/u);
  assert.doesNotMatch(sql, /ALTER COLUMN (?!model_net_pnl_raw)/u);
});

void test('applies migrations 001-020 on an empty schema and replays cleanly', async (context) => {
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
    assert.equal(applied.at(-1), '020_paper_mvp_derived_pnl.sql');
    assert.deepEqual(await migrateDatabase({ pool }), []);
    const sql = await readFile(collectionMigrationUrl, 'utf8');
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

void test('upgrades a database that already applied immutable migration 018', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL paper MVP upgrade test skipped');
    return;
  }
  const schema = `paper_mvp_upgrade_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const directory = new URL('../migrations/', import.meta.url);
    const legacy = (await readdir(directory))
      .filter((name) => /^0(?:0[1-9]|1[0-8])_[a-z0-9_-]+\.sql$/u.test(name))
      .sort((left, right) => left.localeCompare(right));
    for (const name of legacy) await pool.query(await readFile(new URL(name, directory), 'utf8'));
    assert.equal((await pool.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='paper_trades'
        AND column_name='quote_observed_at'`)).rowCount, 0);
    await pool.query(`INSERT INTO token_launches (
      mint,launchpad,program_id,creator,token_program,quote_assets,current_state,
      created_signature,created_slot,created_transaction_index,created_instruction_index,
      created_inner_instruction_index,detected_at,updated_at
    ) VALUES ('MINT','pumpfun','pump','creator','SPL_TOKEN','[]','ACTIVE',
      'signature',1,0,0,NULL,$1,$1)`, [new Date(1_100)]);
    await pool.query(`INSERT INTO paper_positions (
      position_id,mint,quote_mint,quote_decimals,quote_token_program,strategy_id,
      strategy_version,status,base_filled_raw,remaining_base_raw,quote_cost_raw,
      round_trip_loss_bps,entry_trade_id,open_command_hash,trigger_event_id,
      payload_version,payload,opened_at,entry_decision_at
    ) VALUES ('historical','MINT','SOL',9,'SPL_TOKEN','creation-entry-v1',1,
      'PAPER_HOLDING',1,1,1,0,'historical-buy','historical-open','historical-source',
      1,'{}',$1,$2)`, [new Date(1_400),new Date(1_200)]);

    const upgrade = await readFile(collectionMigrationUrl, 'utf8');
    await pool.query(upgrade);
    assert.equal((await pool.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='paper_trades'
        AND column_name='quote_observed_at'`)).rowCount, 1);
    assert.deepEqual((await pool.query(`SELECT entry_decision_job_id
      FROM paper_positions WHERE position_id='historical'`)).rows, [
      { entry_decision_job_id:null },
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
