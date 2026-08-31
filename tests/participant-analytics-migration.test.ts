import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationUrl = new URL('../migrations/007_participant_analytics.sql', import.meta.url);

void test('crée les projections participant analytics bigint et rejouables', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  for (const table of [
    'creator_profiles',
    'observed_wallet_positions',
    'token_holders_snapshots',
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'u'));
  assert.match(sql, /NUMERIC\(78,0\)/u);
  assert.match(sql, /ON DELETE CASCADE/u);
  assert.match(sql, /UNIQUE \(mint, input_fingerprint\)/u);
  assert.match(sql, /observed_net_base_raw NUMERIC\(78,0\) NOT NULL,/u);
  assert.match(sql, /top1_bps >= 0 AND top1_bps <= 10000/u);
  assert.match(sql, /top5_bps >= 0 AND top5_bps <= 10000/u);
  assert.match(sql, /top10_bps >= 0 AND top10_bps <= 10000/u);
  assert.match(sql, /creator_bps >= 0 AND creator_bps <= 10000/u);
  assert.match(sql, /HolderDistributionUpdated/u);
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL|DOUBLE PRECISION)\b/iu);
  assert.doesNotMatch(sql, /private[_ ]?key|keypair|send[_ ]?transaction/iu);
  assert.doesNotMatch(sql, /DROP TABLE/iu);
});

void test('applique toutes les migrations sur une base vide et accepte les événements SSE', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent : test PostgreSQL live ignoré');
    return;
  }
  const schema = `participant_analytics_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^[a-z_][a-z0-9_]*$/u);
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), '034_execution_risk_reconciliation.sql');
    assert.deepEqual(await migrateDatabase({ pool }), []);
    const sql = await readFile(migrationUrl, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    await pool.query(`INSERT INTO domain_events (
      event_id, type, mint, source, program, signature, slot,
      transaction_index, instruction_index, confirmation_status,
      observed_at, payload_version, payload
    ) VALUES (
      'holder-event', 'HolderDistributionUpdated', 'mint', 'pumpfun',
      'pump-program', 'signature', 1, 0, 0, 'processed', NOW(), 1, '{}'::jsonb
    )`);
    assert.equal((await pool.query(
      "SELECT 1 FROM api_event_stream WHERE domain_event_id = 'holder-event'",
    )).rowCount, 1);
    await assert.rejects(
      pool.query(`INSERT INTO api_event_stream (
        stream_event_id, domain_event_id, revision, event_type, mint,
        confirmation_status, payload_version, event, purge_after
      ) VALUES (
        'bad', 'bad', 1, 'UnsupportedType', 'mint', 'processed', 1,
        '{}'::jsonb, NOW() + INTERVAL '1 hour'
      )`),
      /api_event_stream_event_type_check/u,
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
