import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '035_execution_preflight_operations.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);
const tableNames = Object.freeze([
  'execution_safety_qualifications',
  'execution_safety_gate_evidence',
  'execution_control_state',
  'execution_control_events',
  'execution_operator_authorizations',
  'execution_activation_armaments',
  'execution_activation_events',
] as const);

void test('migration 035 defines the seven closed preflight and operations tables', async () => {
  const sql = withoutSqlComments(await readFile(migrationUrl, 'utf8'));
  for (const table of tableNames) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`, 'u'));
  }
  assert.match(sql, /execution_activation_armaments_generation_active_unique/u);
  assert.match(sql, /WHERE state IN \('ARMED', 'LOCKED'\)/u);
  assert.match(sql, /FOREIGN KEY \(qualification_id\)\s*REFERENCES execution_safety_qualifications/u);
  assert.match(sql, /FOREIGN KEY \(generation_id\)\s*REFERENCES execution_wallet_generations/u);
  assert.match(sql, /maximum_capital_lamports < 18446744073709551616/u);
  assert.doesNotMatch(sql, /NUMERIC\s*\(/iu);
  assert.doesNotMatch(sql, /\b(?:REAL|DOUBLE\s+PRECISION|JSONB?)\b/iu);
  for (const forbidden of [
    'private_key', 'secret_key', 'seed_phrase', 'rpc_url', 'rpc_headers',
    'transaction_bytes', 'signed_bytes', 'raw_nonce',
  ]) assert.doesNotMatch(sql, new RegExp(`\\b${forbidden}\\b`, 'iu'));
});

void test('migration 035 applies on an empty schema and replays cleanly', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), migrationName);
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await pool.query(await readFile(migrationUrl, 'utf8'));
    const tables = await pool.query<{ readonly table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema=current_schema() AND table_name = ANY($1::TEXT[])
      ORDER BY table_name`, [tableNames]);
    assert.deepEqual(tables.rows.map((row) => row.table_name), [...tableNames].sort());
  });
});

function testDatabaseUrl(context: Readonly<{ skip(message?: string): void }>): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') return databaseUrl;
  context.skip('TEST_DATABASE_URL absent: execution operations migration test skipped');
  return null;
}

async function withTemporarySchema(
  databaseUrl: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `execution_operations_${randomUUID().replaceAll('-', '')}`;
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
