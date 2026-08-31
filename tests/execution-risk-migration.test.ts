import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '034_execution_risk_reconciliation.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);
const tableNames = Object.freeze([
  'execution_wallet_generations',
  'execution_wallet_risk_state',
  'execution_wallet_snapshots',
  'execution_provider_usage_snapshots',
  'execution_provider_usage_counters',
  'execution_provider_rate_limit_events',
  'execution_risk_admission_reports',
  'execution_exposure_reservations',
  'execution_reconciliation_evidence',
  'execution_fault_ledger',
  'execution_risk_tombstones',
] as const);

void test('migration 034 defines the eleven closed durable risk tables', async () => {
  const sql = withoutSqlComments(await readFile(migrationUrl, 'utf8'));
  for (const table of tableNames) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`, 'u'));
  }
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS execution_/gu) ?? []).length, 11);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS execution_wallet_generations_active_unique/u);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS execution_exposure_reservations_position_side_active_unique/u);
  assert.match(sql, /FOREIGN KEY \(intent_id\)\s*REFERENCES execution_intents \(id\) ON DELETE RESTRICT/u);
  assert.match(sql, /FOREIGN KEY \(intent_id, attempt_number\)\s*REFERENCES execution_attempts \(intent_id, attempt_number\) ON DELETE RESTRICT/u);
  assert.match(sql, /purge_after = reconciled_at \+ INTERVAL '4 hours'/u);
  assert.match(sql, /purge_after = terminal_at \+ INTERVAL '4 hours'/u);
  assert.match(sql, /commitment = 'finalized'/u);
  assert.match(sql, /result IN \('MATCHED', 'NO_EFFECT', 'MISMATCH', 'UNKNOWN'\)/u);
  assert.match(sql, /state IN \('RESERVED', 'CONSUMED', 'RELEASED', 'UNKNOWN_HELD'\)/u);
  assert.match(sql, /quota_state IN \('NORMAL', 'ENTRY_BLOCKED', 'EXIT_ONLY', 'UNKNOWN'\)/u);
  assert.match(sql, /retry_decision IN \('DO_NOT_RETRY', 'RETRY_PRE_SIGNATURE', 'RECONCILE_ONLY', 'RETRY_EXACT_BYTES'\)/u);
  assert.match(sql, /scale\(reconciled_capital_lamports\) = 0/u);
  assert.match(sql, /scale\(wallet_lamport_delta\) = 0/u);
  assert.doesNotMatch(sql, /NUMERIC\s*\(/iu);
  assert.doesNotMatch(sql, /\b(?:REAL|DOUBLE\s+PRECISION|JSONB?)\b/iu);
  for (const forbidden of [
    'private_key', 'secret_key', 'seed_phrase', 'rpc_url', 'rpc_headers',
    'transaction_bytes', 'signed_bytes', 'raw_payload',
  ]) assert.doesNotMatch(sql, new RegExp(`\\b${forbidden}\\b`, 'iu'));
});

void test('migration 034 applies on an empty schema and replays cleanly', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution risk migration apply test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_risk_apply', async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), migrationName);
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await pool.query(await readFile(migrationUrl, 'utf8'));
    const tables = await pool.query<{ readonly table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema=current_schema() AND table_name LIKE 'execution_%'
      ORDER BY table_name`);
    for (const table of tableNames) {
      assert.equal(tables.rows.some((row) => row.table_name === table), true);
    }
  });
});

void test('migration 034 rejects rounded money and competing active wallet generations', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution risk invariant test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_risk_invariants', async (pool) => {
    await migrateDatabase({ pool });
    const firstId = `execution_wallet_generation_${'a'.repeat(64)}`;
    const secondId = `execution_wallet_generation_${'b'.repeat(64)}`;
    const key = '11111111111111111111111111111111';
    const hash = '2'.repeat(32);
    await pool.query(`INSERT INTO execution_wallet_generations (
      generation_id,wallet_public_key,cluster,genesis_hash,generation
    ) VALUES ($1,$2,'mainnet-beta',$3,1)`, [firstId, key, hash]);
    await assert.rejects(pool.query(`INSERT INTO execution_wallet_generations (
      generation_id,wallet_public_key,cluster,genesis_hash,generation
    ) VALUES ($1,$2,'mainnet-beta',$3,2)`, [secondId, key, hash]));
    await assert.rejects(pool.query(`INSERT INTO execution_wallet_risk_state (
      generation_id,reconciled_capital_lamports,reserved_exposure_raw,
      conservative_drawdown_raw
    ) VALUES ($1,'1.5',0,0)`, [firstId]));
  });
});

void test('migration 034 catalog contains no floating or JSON financial storage', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution risk catalog test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_risk_catalog', async (pool) => {
    await migrateDatabase({ pool });
    const columns = await pool.query<{
      readonly table_name: string;
      readonly column_name: string;
      readonly data_type: string;
    }>(`SELECT table_name,column_name,data_type FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name = ANY($1::TEXT[])
      ORDER BY table_name,column_name`, [tableNames]);
    assert.equal(columns.rows.length > 0, true);
    for (const column of columns.rows) {
      assert.equal(['real', 'double precision', 'json', 'jsonb'].includes(column.data_type), false);
      assert.equal(/(?:secret|private|url|header|bytes|payload_(?:body|json|raw))/iu
        .test(column.column_name), false);
    }
  });
});

function testDatabaseUrl(
  context: Readonly<{ skip(message?: string): void }>,
  label: string,
): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') return databaseUrl;
  context.skip(`TEST_DATABASE_URL absent: ${label} skipped`);
  return null;
}

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
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    created = true;
    await pool.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await callback(pool);
  } finally {
    try {
      await pool.end();
    } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
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

function withoutSqlComments(sql: string): string {
  return sql.replace(/--[^\r\n]*/gu, ' ').replace(/\/\*[\s\S]*?\*\//gu, ' ');
}
