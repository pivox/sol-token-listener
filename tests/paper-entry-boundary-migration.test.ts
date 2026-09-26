import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '054_paper_entry_boundary.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);

void test('054 defines a durable immutable paper BUY slot watermark', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /entry_boundary_slot NUMERIC\(78,0\)/u);
  assert.match(sql, /entry_boundary_quote_id TEXT/u);
  assert.match(sql, /entry_boundary_observed_at TIMESTAMPTZ/u);
  assert.match(sql, /PAPER_BUY_QUOTE_SLOT/u);
  assert.match(sql, /paper_strategy_sessions_entry_boundary_check/u);
  assert.match(sql, /paper_strategy_session_entry_boundary_monotone/u);
  assert.match(sql, /OLD\.entry_boundary_slot IS NOT NULL/u);
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL|DOUBLE PRECISION)\b/iu);
});

void test('054 is replay-safe on an empty PostgreSQL schema', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  const schema = `paper_entry_boundary_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const applied = await migrateDatabase({ pool });
    assert.ok(applied.includes(migrationName));
    assert.equal(applied.at(-1), '055_creation_entry_single_active_session.sql');
    assert.deepEqual(await migrateDatabase({ pool }), []);
    const columns = await pool.query(`SELECT column_name,is_nullable FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='paper_strategy_sessions'
        AND column_name IN (
          'entry_boundary_slot','entry_boundary_quote_id','entry_boundary_observed_at'
        ) ORDER BY column_name`);
    assert.deepEqual(columns.rows, [
      { column_name: 'entry_boundary_observed_at', is_nullable: 'YES' },
      { column_name: 'entry_boundary_quote_id', is_nullable: 'YES' },
      { column_name: 'entry_boundary_slot', is_nullable: 'YES' },
    ]);
    const identities = await boundaryGuardIdentities(pool);
    await pool.query(await readFile(migrationUrl, 'utf8'));
    assert.deepEqual(await boundaryGuardIdentities(pool), identities);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

interface BoundaryGuardIdentity {
  readonly constraint_oid: string;
  readonly function_oid: string;
  readonly trigger_oid: string;
}

async function boundaryGuardIdentities(
  pool: pg.Pool,
): Promise<readonly BoundaryGuardIdentity[]> {
  const result = await pool.query<BoundaryGuardIdentity>(`SELECT
    (SELECT oid::text FROM pg_constraint WHERE conrelid='paper_strategy_sessions'::regclass
      AND conname='paper_strategy_sessions_entry_boundary_check') constraint_oid,
    (SELECT oid::text FROM pg_proc WHERE pronamespace=current_schema()::regnamespace
      AND proname='paper_strategy_session_entry_boundary_monotone') function_oid,
    (SELECT oid::text FROM pg_trigger WHERE tgrelid='paper_strategy_sessions'::regclass
      AND tgname='paper_strategy_session_entry_boundary_monotone') trigger_oid`);
  return result.rows;
}
