import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationUrl = new URL('../migrations/008_wallet_graph.sql', import.meta.url);

void test('creates replayable bigint wallet-funding evidence tables', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  for (const table of [
    'wallet_funding_observations',
    'wallet_funding_evidence',
    'wallet_relationships',
    'wallet_graph_profiles',
    'wallet_clusters',
    'wallet_cluster_members',
    'wallet_graph_snapshots',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'u'));
  }
  assert.match(sql, /NUMERIC\(78,0\)/u);
  assert.match(sql, /ON DELETE CASCADE/u);
  assert.match(sql, /purge_after TIMESTAMPTZ/u);
  assert.match(sql, /STRONG.*MEDIUM_ONLY.*NO_EVIDENCE.*UNAVAILABLE/su);
  assert.match(sql, /DIRECT_QUOTE_TRANSFER.*FEE_PAYER_FOR_BUYER/su);
  assert.match(sql, /processed.*confirmed.*finalized.*orphaned/su);
  assert.match(sql, /amount_raw IS NULL.*transfer_slot IS NULL/su);
  assert.match(sql, /UNIQUE \(mint, input_fingerprint\)/u);
  assert.match(sql, /wallet_clusters_current_rank_idx/u);
  assert.match(sql, /first_observed_cursor JSONB NOT NULL/u);
  assert.match(sql, /last_observed_cursor JSONB NOT NULL/u);
  assert.match(sql, /quote_assets JSONB NOT NULL/u);
  assert.match(sql, /wallet_cluster_members_current_rank_idx/u);
  assert.match(sql, /wallet_graph_profiles_purge_idx/u);
  assert.match(sql, /wallet_graph_snapshots_purge_idx/u);
  assert.match(
    sql,
    /FOREIGN KEY \(mint, cluster_id\)[\s\S]*ON DELETE CASCADE/u,
  );
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL|DOUBLE PRECISION)\b/iu);
  assert.doesNotMatch(sql, /private[_ ]?key|keypair|send[_ ]?transaction/iu);
  assert.doesNotMatch(sql, /DROP TABLE/iu);
});

void test('applies all migrations on an empty PostgreSQL schema and replays cleanly', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent : test PostgreSQL live ignoré');
    return;
  }
  const schema = `wallet_graph_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^[a-z_][a-z0-9_]*$/u);
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), '039_execution_canary_operator_binding.sql');
    assert.deepEqual(await migrateDatabase({ pool }), []);
    const sql = await readFile(migrationUrl, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) {
    throw new Error('Unsafe SQL identifier.');
  }
  return `"${identifier}"`;
}
