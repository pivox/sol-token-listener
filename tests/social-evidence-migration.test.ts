import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

void test('creates replayable public social storage without raw content', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.includes('012_public_social_evidence.sql'), true);
    for (const table of [
      'social_enrichment_jobs',
      'social_evidence_collections',
      'social_http_observations',
      'social_links',
      'social_verification_evidence',
    ]) assert.equal(await relationExists(pool, table), true, table);

    const columns = await pool.query<{ readonly table_name: string; readonly column_name: string }>(`
      SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name LIKE 'social_%'
      ORDER BY table_name,column_name`);
    assert.equal(columns.rows.some(({ column_name: name }) =>
      /(?:^|_)(?:body|html|headers?|cookies?|ip_address|dns_answers?)(?:_|$)/iu.test(name)), false);

    const metadataColumns = await pool.query<{ readonly column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='token_metadata_snapshots'`);
    assert.equal(metadataColumns.rows.some((row) => row.column_name === 'source_launch_event_id'), true);
    assert.equal(metadataColumns.rows.some((row) => row.column_name === 'failure_retryable'), true);

    assert.deepEqual(await migrateDatabase({ pool }), []);
  });
});

void test('enforces four-hour terminal retention and checked social enums', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await migrateDatabase({ pool });
    const constraints = await pool.query<{ readonly definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE connamespace=current_schema()::regnamespace
        AND conrelid IN (
          'social_enrichment_jobs'::regclass,
          'social_evidence_collections'::regclass,
          'social_links'::regclass,
          'social_http_observations'::regclass,
          'social_verification_evidence'::regclass
        )`);
    const sql = constraints.rows.map((row) => row.definition).join('\n');
    assert.match(sql, /PENDING.*PROCESSING.*RETRYABLE_FAILED.*COMPLETED.*CANCELLED/su);
    assert.match(sql, /COMPLETE.*PARTIAL.*FAILED/su);
    assert.match(sql, /URL_SYNTAX_VALID.*VERIFICATION_UNKNOWN/su);
    assert.match(sql, /04:00:00|4 hours/iu);
  });
});

async function relationExists(pool: InstanceType<typeof pg.Pool>, name: string): Promise<boolean> {
  const result = await pool.query<{ readonly exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [name],
  );
  return result.rows[0]?.exists === true;
}

async function withSchema(run: (pool: InstanceType<typeof pg.Pool>) => Promise<void>): Promise<void> {
  assert.ok(databaseUrl);
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `social_migration_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
