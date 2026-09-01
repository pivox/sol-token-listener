import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '037_execution_live_orchestration.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);

void test('migration 037 defines only the partial live execution lane index', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const migrationNames = (await readdir(new URL('../migrations/', import.meta.url)))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right));

  assert.equal(migrationNames.at(-1), migrationName);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS execution_intents_live_claim_idx/u);
  assert.match(sql, /ON execution_intents \(side, requested_at, id\)/u);
  assert.match(sql, /WHERE status IN \('PENDING', 'RETRY_READY', 'PROCESSING'\)/u);
  assert.doesNotMatch(sql, /\b(?:ALTER|INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/iu);
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL|DOUBLE PRECISION)\b/iu);
  assert.doesNotMatch(sql, /private[_ ]?key|keypair|send[_ ]?transaction/iu);
});

void test('migration 037 applies to an empty PostgreSQL schema and replays cleanly', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live orchestration migration test skipped');
    return;
  }
  const schema = `execution_live_orchestration_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), migrationName);
    assert.deepEqual(await migrateDatabase({ pool }), []);

    const sql = await readFile(migrationUrl, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const indexes = await pool.query<{ readonly indexdef: string }>(`SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'execution_intents'
        AND indexname = 'execution_intents_live_claim_idx'`);
    assert.equal(indexes.rows.length, 1);
    assert.match(
      indexes.rows[0]?.indexdef ?? '',
      /\(side, requested_at, id\) WHERE \(status = ANY \(ARRAY\['PENDING'::text, 'RETRY_READY'::text, 'PROCESSING'::text\]\)\)$/u,
    );
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) throw new Error('Unsafe SQL identifier.');
  return `"${identifier}"`;
}
