import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';

const migrationUrl = new URL('../migrations/009_transaction_ingestion.sql', import.meta.url);

void test('creates a replayable bigint-safe transaction inbox with strict lifecycle checks', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS chain_transaction_inbox/u);
  assert.match(sql, /signature TEXT PRIMARY KEY/u);
  assert.match(sql, /observed_slot NUMERIC\(78,0\) NOT NULL/u);
  assert.match(sql, /discovery_sources TEXT\[\] NOT NULL/u);
  assert.match(sql, /target_confirmation_status TEXT NOT NULL/u);
  assert.match(sql, /processing_status TEXT NOT NULL/u);
  assert.match(sql, /attempts INTEGER NOT NULL DEFAULT 0/u);
  assert.match(sql, /missing_finality_polls INTEGER NOT NULL DEFAULT 0/u);
  assert.match(sql, /lease_token TEXT/u);
  assert.match(sql, /lease_expires_at TIMESTAMPTZ/u);
  assert.match(sql, /next_attempt_at TIMESTAMPTZ/u);
  assert.match(sql, /normalized_transaction JSONB/u);
  assert.match(sql, /immutable_fingerprint TEXT/u);
  assert.match(sql, /error_code TEXT/u);
  assert.match(sql, /error_name TEXT/u);
  assert.match(sql, /error_message TEXT/u);
  assert.match(sql, /blockchain_time TIMESTAMPTZ/u);
  assert.match(sql, /observed_at TIMESTAMPTZ NOT NULL/u);
  assert.match(sql, /processed_at TIMESTAMPTZ/u);
  assert.match(sql, /terminal_at TIMESTAMPTZ/u);
  assert.match(sql, /purge_after TIMESTAMPTZ/u);

  assert.match(sql, /discovery_sources IN \([\s\S]*ARRAY\['WEBSOCKET'\]::TEXT\[\][\s\S]*ARRAY\['CATCH_UP'\]::TEXT\[\][\s\S]*ARRAY\['WEBSOCKET', 'CATCH_UP'\]::TEXT\[\]/u);
  assert.match(sql, /target_confirmation_status IN \('processed', 'confirmed', 'finalized', 'orphaned'\)/u);
  assert.match(sql, /processing_status IN \('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED'\)/u);
  assert.match(sql, /attempts >= 0/u);
  assert.match(sql, /missing_finality_polls >= 0/u);
  assert.match(sql, /lease_token IS NULL AND lease_expires_at IS NULL/u);
  assert.match(sql, /normalized_transaction IS NULL AND immutable_fingerprint IS NULL/u);
  assert.match(sql, /normalized_transaction IS NOT NULL[\s\S]*immutable_fingerprint IS NOT NULL[\s\S]*immutable_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/u);
  assert.match(sql, /terminal_at IS NOT NULL[\s\S]*purge_after IS NOT NULL[\s\S]*purge_after = terminal_at \+ INTERVAL '4 hours'/u);
  assert.match(sql, /terminal_at \+ INTERVAL '4 hours'/u);
  assert.match(sql, /target_confirmation_status IN \('finalized', 'orphaned'\)/u);
  assert.match(sql, /chain_transaction_inbox_claim_idx/u);
  assert.match(sql, /chain_transaction_inbox_finality_idx/u);
  assert.match(sql, /chain_transaction_inbox_purge_idx/u);
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL|DOUBLE PRECISION)\b/iu);
  assert.doesNotMatch(sql, /private[_ ]?key|keypair|send[_ ]?transaction/iu);
  assert.doesNotMatch(sql, /DROP TABLE/iu);
});

void test('extends legacy listener heartbeats without seeding checkpoints', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  for (const column of [
    'runtime_state',
    'subscriber_state',
    'scanner_state',
    'worker_state',
    'reconciler_state',
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} TEXT`, 'u'));
  }
  assert.match(sql, /ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS leased_transactions INTEGER NOT NULL DEFAULT 0/u);
  assert.match(sql, /STARTING.*RUNNING.*DEGRADED.*STOPPING.*STOPPED/su);
  assert.doesNotMatch(sql, /INSERT INTO processing_checkpoints/iu);
});

void test('defines the transaction inbox port at the canonical snapshot conversion boundary', async () => {
  const source = await readFile(
    new URL('../src/ports/transaction-inbox-repository.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /export interface TransactionInboxRepository/u);
  for (const method of [
    'enqueue',
    'claim',
    'renewLease',
    'saveSnapshot',
    'markProcessed',
    'markFailed',
    'listForFinality',
    'enqueueRevision',
    'readCheckpoint',
    'storeCheckpoint',
    'writeHeartbeat',
    'counts',
  ]) assert.match(source, new RegExp(`\\b${method}\\(`, 'u'));
  assert.match(source, /saveSnapshot\([\s\S]*tx: NormalizedTransaction[\s\S]*Promise<void>/u);
  assert.match(source, /createDurableTransactionSnapshot/u);
  assert.doesNotMatch(source, /purge/u);
});

void test('purges only terminal processed inbox rows and exposes their count', async () => {
  const source = await readFile(new URL('../src/storage/database.ts', import.meta.url), 'utf8');

  assert.match(source, /readonly transactionInbox: number;/u);
  assert.match(source, /DELETE FROM chain_transaction_inbox[\s\S]*processing_status = 'PROCESSED'[\s\S]*target_confirmation_status IN \('finalized', 'orphaned'\)[\s\S]*terminal_at IS NOT NULL[\s\S]*purge_after <= clock_timestamp\(\)/u);
  assert.match(source, /transactionInbox: transactionInbox\.rowCount \?\? 0,/u);
  const inboxDeletion = source.indexOf('DELETE FROM chain_transaction_inbox');
  const rawDeletion = source.indexOf('DELETE FROM raw_chain_events raw');
  assert.ok(inboxDeletion >= 0 && inboxDeletion < rawDeletion);

  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes('DELETE FROM chain_transaction_inbox')) return { rows: [], rowCount: 3 };
      if (text.includes('WITH deleted AS')) {
        return { rows: [{ deleted_count: '0' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client } as unknown as InstanceType<typeof pg.Pool>;

  const result = await purgeExpiredFoundationData(pool);
  assert.equal(result.transactionInbox, 3);
  assert.deepEqual(queries.slice(-1), ['COMMIT']);
});

void test('applies migrations 001-009 on an empty PostgreSQL schema and replays cleanly', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent : test PostgreSQL live ignoré');
    return;
  }
  const schema = `transaction_ingestion_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^[a-z_][a-z0-9_]*$/u);
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), '009_transaction_ingestion.sql');
    assert.deepEqual(await migrateDatabase({ pool }), []);
    const sql = await readFile(migrationUrl, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    assert.equal((await pool.query('SELECT COUNT(*) FROM processing_checkpoints')).rows[0]?.count, '0');
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
