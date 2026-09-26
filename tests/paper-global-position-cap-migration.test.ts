import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '055_creation_entry_single_active_session.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);

void test('055 fail-closes before enforcing one active creation-entry session globally', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /strategy_id = 'creation-entry-v1'/u);
  assert.match(sql, /HAVING COUNT\(\*\) > 1/u);
  assert.match(sql, /RAISE EXCEPTION/u);
  assert.match(sql, /CREATE UNIQUE INDEX/u);
  assert.match(sql, /paper_strategy_sessions_creation_entry_active_singleton_idx/u);
  assert.match(sql, /\(\(1\)\)/u);
  assert.doesNotMatch(sql, /\b(?:DELETE|UPDATE)\b/iu);
});

void test('055 is replay-safe and installs the active creation-entry singleton index', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  const schema = `paper_singleton_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), migrationName);
    assert.deepEqual(await migrateDatabase({ pool }), []);
    const index = await pool.query<{ readonly definition: string }>(`SELECT indexdef AS definition
      FROM pg_indexes WHERE schemaname=current_schema()
        AND indexname='paper_strategy_sessions_creation_entry_active_singleton_idx'`);
    assert.equal(index.rowCount, 1);
    assert.match(index.rows[0]?.definition ?? '', /UNIQUE INDEX/u);
    assert.match(index.rows[0]?.definition ?? '', /\(1\)/u);
    assert.match(index.rows[0]?.definition ?? '', /strategy_id = 'creation-entry-v1'/u);
    assert.match(index.rows[0]?.definition ?? '', /BUY_PENDING/u);
    assert.match(index.rows[0]?.definition ?? '', /SELL_PENDING/u);
    assert.match(index.rows[0]?.definition ?? '', /MANUAL_REVIEW/u);
    await pool.query(await readFile(migrationUrl, 'utf8'));
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

void test('055 refuses a homonymous non-unique index instead of marking the migration applied', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  const schema = `paper_singleton_collision_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrateDatabase({ pool });
    await pool.query('DROP INDEX paper_strategy_sessions_creation_entry_active_singleton_idx');
    await pool.query('DELETE FROM migration_history WHERE version=$1', [migrationName]);
    await pool.query(`CREATE INDEX paper_strategy_sessions_creation_entry_active_singleton_idx
      ON paper_strategy_sessions (strategy_id)`);

    await assert.rejects(
      () => migrateDatabase({ pool }),
      /creation-entry active singleton index definition is incompatible/u,
    );
    const history = await pool.query('SELECT version FROM migration_history WHERE version=$1', [migrationName]);
    assert.equal(history.rowCount, 0);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
