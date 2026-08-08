import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationUrl = new URL('../migrations/010_transaction_inbox_timestamps.sql', import.meta.url);

void test('uses one stable statement timestamp for inbox creation and update defaults', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /ALTER COLUMN created_at SET DEFAULT statement_timestamp\(\)/u);
  assert.match(sql, /ALTER COLUMN updated_at SET DEFAULT statement_timestamp\(\)/u);
  assert.doesNotMatch(sql, /clock_timestamp/u);
});

void test('bulk inserts cannot violate inbox timestamp ordering', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent : test PostgreSQL live ignoré');
    return;
  }
  const schema = `inbox_timestamp_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^[a-z_][a-z0-9_]*$/u);
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), '010_transaction_inbox_timestamps.sql');
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, observed_at
    ) SELECT 'bulk-' || value, value, ARRAY['CATCH_UP'],
      ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'confirmed',
      'PENDING', statement_timestamp()
      FROM generate_series(1, 20000) value`);
    const invalid = await pool.query(
      'SELECT COUNT(*) FROM chain_transaction_inbox WHERE updated_at < created_at',
    );
    assert.equal(invalid.rows[0]?.count, '0');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
