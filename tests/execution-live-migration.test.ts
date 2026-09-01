import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationUrl = new URL('../migrations/036_execution_live_canary.sql', import.meta.url);
const databaseUrl = process.env.TEST_DATABASE_URL;

void test('migration 036 defines the four closed live execution tables', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const table of [
    'execution_signed_transactions',
    'execution_submission_events',
    'execution_live_positions',
    'execution_exit_authorizations',
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'u'));

  assert.match(sql, /signed_transaction_bytes BYTEA NOT NULL/u);
  assert.match(sql, /octet_length\(signed_transaction_bytes\) BETWEEN 1 AND 1232/u);
  assert.match(sql, /signed_transaction_hash ~ '\^\[0-9a-f\]\{64\}\$'/u);
  assert.match(sql, /confirmed_slot BIGINT/u);
  assert.match(sql, /\(confirmed_at IS NULL\) = \(confirmed_slot IS NULL\)/u);
  assert.match(sql, /PRIMARY KEY \(intent_id, attempt_number\)/u);
  assert.match(sql, /FOREIGN KEY \(intent_id, attempt_number\)[\s\S]*REFERENCES execution_attempts/u);
  assert.match(sql, /state IN \('PERSISTED','SIGNED_SIMULATED','SUBMISSION_STARTED',[\s\S]*'REVOKED_NO_SEND'\)/u);
  assert.match(sql, /state IN \('OPEN','EXIT_PENDING','CLOSED','UNKNOWN'\)/u);
  assert.match(sql, /state IN \('ACTIVE','LOCKED','CONSUMED','REVOKED'\)/u);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(NEW\.generation_id, 51005\)\)/u);
  assert.match(sql, /guard_execution_signed_transaction_insert/u);
  assert.match(sql, /reject_execution_live_immutable_update/u);
  assert.doesNotMatch(sql, /NUMERIC\s*\(/iu);
  assert.doesNotMatch(sql, /\b(?:REAL|DOUBLE\s+PRECISION|JSONB?)\b/iu);
});

void test('migration 036 applies to an empty PostgreSQL schema and replays cleanly', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL absent: live migration integration skipped');
    return;
  }
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `execution_live_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  context.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  });

  await migrateDatabase({ pool });
  await migrateDatabase({ pool });
  const tables = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema=current_schema()
      AND table_name LIKE 'execution_%'
    ORDER BY table_name`);
  const names = tables.rows.map((row) => row.table_name);
  for (const name of [
    'execution_signed_transactions',
    'execution_submission_events',
    'execution_live_positions',
    'execution_exit_authorizations',
  ]) assert.equal(names.includes(name), true, `${name} missing`);

  const byteColumn = await pool.query<{ data_type: string }>(`
    SELECT data_type FROM information_schema.columns
    WHERE table_schema=current_schema()
      AND table_name='execution_signed_transactions'
      AND column_name='signed_transaction_bytes'`);
  assert.equal(byteColumn.rows[0]?.data_type, 'bytea');
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
