import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { LIVE_EXECUTION_MIGRATION_CATALOG } from '../src/execution-migrations/live-catalog.js';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '043_execution_intent_causal_lineage.sql';
const migrationHeadName = '046_listener_strict_catch_up_runs.sql';

void test('migration 043 adds nullable lineage identity and non-blocking foreign keys', async () => {
  const sql = await readFile(new URL(`../migrations/${migrationName}`, import.meta.url), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS candidate_id TEXT/u);
  assert.match(sql, /FOREIGN KEY \(candidate_id\)[\s\S]*REFERENCES trading_candidates\(candidate_id\)[\s\S]*NOT VALID/u);
  assert.match(sql, /FOREIGN KEY \(decision_event_id\)[\s\S]*REFERENCES domain_events\(event_id\)[\s\S]*NOT VALID/u);
  assert.match(sql, /UPDATE execution_intents AS intent[\s\S]*SET candidate_id=candidate\.candidate_id/u);
  assert.match(sql, /candidate\.superseded_at IS NULL/u);
  assert.match(sql, /report\.superseded_at IS NULL/u);
  assert.match(sql, /HAVING COUNT\(\*\)=1/u);
  assert.doesNotMatch(sql, /VALIDATE CONSTRAINT/u);
  assert.equal(LIVE_EXECUTION_MIGRATION_CATALOG.at(-1)?.name, migrationHeadName);
  assert.ok(LIVE_EXECUTION_MIGRATION_CATALOG.some((entry) => entry.name === migrationName));
});

void test('retention preserves a candidate while an execution intent still references it', async () => {
  const source = await readFile(new URL('../src/storage/database.ts', import.meta.url), 'utf8');
  assert.match(source, /DELETE FROM trading_candidates candidate[\s\S]*NOT EXISTS \(\s*SELECT 1 FROM execution_intents intent\s*WHERE intent\.candidate_id = candidate\.candidate_id\s*\)/u);
});

void test('migration 043 is replayable and enforces both new foreign keys on real PostgreSQL', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: execution intent lineage migration skipped');
    return;
  }
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `execution_lineage_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path="${schema}"` });
  try {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), migrationHeadName);
    const sql = await readFile(new URL(`../migrations/${migrationName}`, import.meta.url), 'utf8');
    await pool.query(sql);
    const columns = await pool.query(`SELECT is_nullable FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='execution_intents'
        AND column_name='candidate_id'`);
    assert.deepEqual(columns.rows, [{ is_nullable: 'YES' }]);
    const constraints = await pool.query(`SELECT conname,convalidated
      FROM pg_constraint WHERE conrelid='execution_intents'::regclass
        AND conname IN (
          'execution_intents_candidate_id_fkey','execution_intents_decision_event_id_fkey'
        ) ORDER BY conname`);
    assert.deepEqual(constraints.rows, [
      { conname: 'execution_intents_candidate_id_fkey', convalidated: false },
      { conname: 'execution_intents_decision_event_id_fkey', convalidated: false },
    ]);
    await assert.rejects(insertIntent(pool, 'missing-event', null), /foreign key/u);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

void test('migration 043 rejects drifted foreign-key columns and options on real PostgreSQL', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: execution intent lineage migration drift skipped');
    return;
  }
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `execution_lineage_drift_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path="${schema}"` });
  try {
    await migrateDatabase({ pool });
    const sql = await readFile(new URL(`../migrations/${migrationName}`, import.meta.url), 'utf8');

    await pool.query(`ALTER TABLE execution_intents
      DROP CONSTRAINT execution_intents_candidate_id_fkey,
      ADD CONSTRAINT execution_intents_candidate_id_fkey
        FOREIGN KEY (mint) REFERENCES trading_candidates(candidate_id)
        ON DELETE RESTRICT NOT VALID`);
    await assert.rejects(pool.query(sql), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === '55000');

    await pool.query(`ALTER TABLE execution_intents
      DROP CONSTRAINT execution_intents_candidate_id_fkey,
      ADD CONSTRAINT execution_intents_candidate_id_fkey
        FOREIGN KEY (candidate_id) REFERENCES trading_candidates(candidate_id)
        ON DELETE RESTRICT NOT VALID,
      DROP CONSTRAINT execution_intents_decision_event_id_fkey,
      ADD CONSTRAINT execution_intents_decision_event_id_fkey
        FOREIGN KEY (decision_event_id) REFERENCES domain_events(event_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID`);
    await assert.rejects(pool.query(sql), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === '55000');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

function insertIntent(
  pool: InstanceType<typeof pg.Pool>,
  decisionEventId: string,
  candidateId: string | null,
): Promise<unknown> {
  return pool.query(`INSERT INTO execution_intents (
    id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,
    candidate_id,logical_command_id,mint,side,venue_policy,quote_mint,
    quote_token_program,quote_decimals,quote_amount_raw,base_amount_raw,
    minimum_amount_out_raw,decision_event_id,decision_fingerprint,requested_at,
    expires_at,status
  ) VALUES (
    $1,1,$2,'creation-entry-v1',1,'position',$3,$2,
    '11111111111111111111111111111111','BUY','PUMP_FUN_ONLY',
    'So11111111111111111111111111111111111111112','SPL_TOKEN',9,1,NULL,1,
    $4,$5,date_trunc('milliseconds',statement_timestamp()),
    date_trunc('milliseconds',statement_timestamp())+INTERVAL '1 minute','PENDING'
  )`, [
    `execution_intent_${'a'.repeat(64)}`,
    `paper_open_${'b'.repeat(64)}`,
    candidateId,
    decisionEventId,
    'c'.repeat(64),
  ]);
}
