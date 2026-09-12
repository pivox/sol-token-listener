import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationsDirectory = new URL('../migrations/', import.meta.url);
const migrationName = '044_transaction_inbox_launch_priority.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);
const pumpProgramId = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

void test('migration 044 defines a closed durable priority and an ordered claim index', async () => {
  const sql = await readFile(migrationUrl, 'utf8').catch(() => '');
  const repository = await readFile(
    new URL('../src/storage/transaction-inbox.repository.ts', import.meta.url),
    'utf8',
  );

  assert.match(sql, /CREATE TYPE chain_transaction_inbox_priority AS ENUM \('NORMAL', 'LAUNCH_CANDIDATE'\)/u);
  assert.match(sql, /ingestion_priority chain_transaction_inbox_priority\s+NOT NULL DEFAULT 'NORMAL'/u);
  assert.match(repository, /ingestion_priority\s*=\s*GREATEST\(/u);
  assert.match(sql, /ingestion_priority DESC, observed_slot, signature/u);
  assert.match(sql, /chain_transaction_inbox_claim_scheduler/u);
});

void test('migration 044 upgrades 043, replays, and keeps its enum ordering on PostgreSQL 16', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: transaction priority migration test skipped');
    return;
  }
  const schema = `inbox_priority_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const version = await pool.query<{ readonly major: string }>(
      "SELECT current_setting('server_version_num')::INTEGER / 10000 AS major",
    );
    assert.equal(version.rows[0]?.major, 16);

    const priorNames = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name) && name < migrationName)
      .sort((left, right) => left.localeCompare(right));
    assert.equal(priorNames.at(-1), '043_execution_intent_causal_lineage.sql');
    for (const name of priorNames) {
      await pool.query(await readFile(new URL(name, migrationsDirectory), 'utf8'));
      await pool.query('INSERT INTO migration_history(version) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
    }
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, observed_at
    ) VALUES ('legacy-normal',1,ARRAY['CATCH_UP'],ARRAY[$1],'confirmed','PENDING',NOW())`, [pumpProgramId]);

    assert.deepEqual(await migrateDatabase({ pool }), [
      migrationName,
      '045_execution_wallet_snapshot_refresh.sql',
      '046_listener_strict_catch_up_runs.sql',
    ]);
    assert.deepEqual((await pool.query(`SELECT ingestion_priority::TEXT AS priority
      FROM chain_transaction_inbox WHERE signature='legacy-normal'`)).rows, [{ priority: 'NORMAL' }]);
    assert.deepEqual((await pool.query(`SELECT enumlabel
      FROM pg_enum enum_value
      JOIN pg_type enum_type ON enum_type.oid=enum_value.enumtypid
      JOIN pg_namespace namespace ON namespace.oid=enum_type.typnamespace
      WHERE namespace.nspname=CURRENT_SCHEMA()
        AND enum_type.typname='chain_transaction_inbox_priority'
      ORDER BY enum_value.enumsortorder`)).rows, [
      { enumlabel: 'NORMAL' }, { enumlabel: 'LAUNCH_CANDIDATE' },
    ]);
    assert.deepEqual((await pool.query(`SELECT scheduler_key,consecutive_launch_candidate_claims
      FROM chain_transaction_inbox_claim_scheduler`)).rows, [{
      scheduler_key: 'global', consecutive_launch_candidate_claims: 0,
    }]);

    const sql = await readFile(migrationUrl, 'utf8');
    await pool.query(sql);
    assert.deepEqual(await migrateDatabase({ pool }), []);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
