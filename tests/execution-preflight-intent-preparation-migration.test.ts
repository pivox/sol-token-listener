import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { LIVE_EXECUTION_MIGRATION_CATALOG } from '../src/execution-migrations/live-catalog.js';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '042_execution_preflight_intent_preparation.sql';
const migrationHeadName = '043_execution_intent_causal_lineage.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);

void test('migration 042 declares the bounded preparation-run authority', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.equal(LIVE_EXECUTION_MIGRATION_CATALOG.at(-1)?.name, migrationHeadName);
  assert.ok(LIVE_EXECUTION_MIGRATION_CATALOG.some((migration) => migration.name === migrationName));
  assert.match(sql, /CREATE TABLE IF NOT EXISTS execution_preflight_intent_preparation_runs/u);
  assert.match(sql, /UNIQUE\s*\(pair_id\)/u);
  assert.match(sql, /state IN \('WAITING', 'PREPARING', 'PREPARED', 'FAILED'\)/u);
  assert.match(sql, /watermark_at/u);
  assert.match(sql, /deadline_at/u);
  assert.match(sql, /lease_token UUID/u);
  assert.match(sql, /expires_at \+ INTERVAL '4 hours'|completed_at \+ INTERVAL '4 hours'/u);
  assert.match(sql, /ON DELETE RESTRICT/u);
  assert.doesNotMatch(sql, /SKIP LOCKED/u);
  assert.doesNotMatch(sql, /private_key|keypair|signed_transaction|rpc_url/iu);
});

void test('PostgreSQL 16 migration 042 creates, replays and constrains preparation runs', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: preflight preparation migration test skipped');
    return;
  }

  await withTemporarySchema(databaseUrl, 'execution_preflight_preparation', async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), migrationHeadName);
    assert.deepEqual(await migrateDatabase({ pool }), []);

    const inserted = await pool.query(`INSERT INTO execution_preflight_intent_preparation_runs (
      run_id,payload_version,run_fingerprint,deadline_at,
      lease_owner,lease_token,lease_expires_at
    ) VALUES ('run-1',1,repeat('a',64),
      date_trunc('milliseconds',statement_timestamp())+INTERVAL '45 seconds',
      'h2j-test','00000000-0000-4000-8000-000000000001',
      date_trunc('milliseconds',statement_timestamp())+INTERVAL '30 seconds')
    RETURNING state,
      watermark_at=created_at AS db_watermark,
      deadline_at>watermark_at+INTERVAL '5 seconds' AS handoff_margin`);
    assert.deepEqual(inserted.rows, [{
      state: 'WAITING', db_watermark: true, handoff_margin: true,
    }]);

    await assert.rejects(
      pool.query(`INSERT INTO execution_preflight_intent_preparation_runs (
        run_id,payload_version,run_fingerprint,deadline_at,
        lease_owner,lease_token,lease_expires_at
      ) VALUES ('run-concurrent',1,repeat('c',64),
        date_trunc('milliseconds',statement_timestamp())+INTERVAL '45 seconds',
        'h2j-test','00000000-0000-4000-8000-000000000002',
        date_trunc('milliseconds',statement_timestamp())+INTERVAL '30 seconds')`),
      /execution_preflight_intent_preparation_one_active_idx/u,
    );

    await assert.rejects(
      pool.query(`INSERT INTO execution_preflight_intent_preparation_runs (
        run_id,payload_version,run_fingerprint,state,deadline_at,lease_owner
      ) VALUES ('malformed',1,repeat('b',64),'WAITING',
        date_trunc('milliseconds',statement_timestamp())+INTERVAL '45 seconds','forged')`),
    );
    await assert.rejects(
      pool.query(`UPDATE execution_preflight_intent_preparation_runs
        SET watermark_at=watermark_at+INTERVAL '1 millisecond',state_revision=state_revision+1
        WHERE run_id='run-1'`),
      /immutable/u,
    );

    const failed = await pool.query(`UPDATE execution_preflight_intent_preparation_runs
      SET state='FAILED',state_revision=state_revision+1,
        failure_code='PREFLIGHT_PAIR_NOT_FOUND'
      WHERE run_id='run-1'
      RETURNING state,state_revision::TEXT AS state_revision,
        lease_owner,purge_after=completed_at+INTERVAL '4 hours' AS retention_exact`);
    assert.deepEqual(failed.rows, [{
      state: 'FAILED', state_revision: '1', lease_owner: null, retention_exact: true,
    }]);
    await assert.rejects(
      pool.query(`UPDATE execution_preflight_intent_preparation_runs
        SET state_revision=state_revision+1 WHERE run_id='run-1'`),
      /terminal state is immutable/u,
    );
    await assert.rejects(
      pool.query(`DELETE FROM execution_preflight_intent_preparation_runs WHERE run_id='run-1'`),
      /retention is not eligible/u,
    );

    await pool.query(`ALTER TABLE execution_preflight_intent_preparation_runs
      ALTER COLUMN payload_version DROP NOT NULL`);
    await assert.rejects(
      pool.query(await readFile(migrationUrl, 'utf8')),
      /execution_preflight_intent_preparation_runs has a malformed schema/u,
    );
  });
});

async function withTemporarySchema(
  databaseUrl: string,
  prefix: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  let schemaCreated = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    schemaCreated = true;
    await pool.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await callback(pool);
  } finally {
    try {
      await pool.end();
    } finally {
      try {
        if (schemaCreated) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}
