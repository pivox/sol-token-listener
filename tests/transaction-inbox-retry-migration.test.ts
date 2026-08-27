import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationUrl = new URL('../migrations/011_transaction_inbox_retry_recovery.sql', import.meta.url);

void test('adds durable bounded retry cycles, exhaustion, recovery audit and health state', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  for (const fragment of [
    'retry_max_attempts INTEGER',
    'retry_base_delay_ms INTEGER',
    'attempts_in_cycle INTEGER',
    'retry_exhausted_at TIMESTAMPTZ',
    'manual_recovery_count INTEGER',
    'last_manual_recovery_at TIMESTAMPTZ',
    'exhausted_transactions INTEGER',
    'CREATE TABLE IF NOT EXISTS transaction_inbox_recoveries',
    'purge_after TIMESTAMPTZ',
    'PRIMARY KEY (signature, exhausted_at)',
    "CHECK (retry_max_attempts BETWEEN 1 AND 100)",
    "CHECK (retry_base_delay_ms BETWEEN 1 AND 60000)",
  ]) assert.ok(sql.includes(fragment), `missing migration fragment: ${fragment}`);
  assert.match(sql, /purge_after = terminal_at \+ INTERVAL '4 hours'/u);
  assert.match(sql, /purge_after = recovered_at \+ INTERVAL '4 hours'/u);
  assert.doesNotMatch(
    sql,
    /signature TEXT NOT NULL REFERENCES chain_transaction_inbox\(signature\) ON DELETE CASCADE/u,
  );
  assert.match(sql, /processing_status = 'FAILED'[\s\S]*retry_exhausted_at IS NOT NULL/u);
  const claimOrderIndex = /DROP INDEX IF EXISTS chain_transaction_inbox_claim_order_idx;[\s\S]*?CREATE INDEX chain_transaction_inbox_claim_order_idx[\s\S]*?;/u
    .exec(sql)?.[0] ?? '';
  assert.match(claimOrderIndex, /processing_status = 'PENDING'/u);
  assert.match(claimOrderIndex, /processing_status = 'PROCESSING'/u);
  assert.match(claimOrderIndex, /processing_status = 'FAILED'[\s\S]*error_retryable = TRUE[\s\S]*retry_exhausted_at IS NULL/u);
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL|DOUBLE PRECISION)\b/iu);
  assert.doesNotMatch(sql, /private[_ ]?key|keypair|send[_ ]?transaction/iu);
  assert.doesNotMatch(sql, /DROP TABLE/iu);
});

void test('applies all migrations, replays and backfills legacy retries', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL retry migration test skipped');
    return;
  }
  const schema = `retry_recovery_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), '023_paper_mvp_exact_strategy.sql');
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, observed_at
    ) VALUES (
      'policy-default', 1, ARRAY['WEBSOCKET'],
      ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'confirmed', 'PENDING', NOW()
    )`);
    await pool.query("INSERT INTO listener_heartbeats (service_key) VALUES ('migration-test')");
    const policy = (await pool.query(`SELECT retry_max_attempts, retry_base_delay_ms,
      attempts_in_cycle, manual_recovery_count, exhausted_transactions
      FROM chain_transaction_inbox CROSS JOIN listener_heartbeats
      WHERE signature = 'policy-default' LIMIT 1`)).rows[0];
    assert.deepEqual(policy, {
      retry_max_attempts: 5,
      retry_base_delay_ms: 500,
      attempts_in_cycle: 0,
      manual_recovery_count: 0,
      exhausted_transactions: 0,
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

void test('backfills legacy retryable and deterministic failures with exact retention', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL legacy retry backfill test skipped');
    return;
  }
  const schema = `retry_backfill_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const migrationsDirectory = new URL('../migrations/', import.meta.url);
    const legacyNames = (await readdir(migrationsDirectory))
      .filter((name) => /^00[1-9]_|^010_/u.test(name))
      .sort();
    assert.equal(legacyNames.at(-1), '010_transaction_inbox_timestamps.sql');
    for (const name of legacyNames) {
      await pool.query(await readFile(new URL(name, migrationsDirectory), 'utf8'));
    }
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, attempts, next_attempt_at, error_code, error_name,
      error_retryable, observed_at
    ) VALUES
      ('legacy-retry', 1, ARRAY['WEBSOCKET'],
       ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'confirmed',
       'FAILED', 5, NOW(), 'RPC_TRANSIENT', 'RpcError', TRUE, NOW()),
      ('legacy-fatal', 2, ARRAY['CATCH_UP'],
       ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'confirmed',
       'FAILED', 2, NULL, 'NORMALIZATION_FAILED', 'TypeError', FALSE, NOW())`);

    await pool.query(await readFile(migrationUrl, 'utf8'));
    const rows = (await pool.query(`SELECT signature, attempts_in_cycle,
      retry_exhausted_at, terminal_at, purge_after
      FROM chain_transaction_inbox ORDER BY signature`)).rows;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.ok(row.terminal_at instanceof Date);
      assert.ok(row.purge_after instanceof Date);
      assert.equal(row.purge_after.getTime() - row.terminal_at.getTime(), 4 * 60 * 60 * 1_000);
    }
    assert.equal(rows[0]?.signature, 'legacy-fatal');
    assert.equal(rows[0]?.attempts_in_cycle, 2);
    assert.equal(rows[0]?.retry_exhausted_at, null);
    assert.equal(rows[1]?.signature, 'legacy-retry');
    assert.equal(rows[1]?.attempts_in_cycle, 5);
    assert.ok(rows[1]?.retry_exhausted_at instanceof Date);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
