import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { LIVE_EXECUTION_MIGRATION_CATALOG } from '../src/execution-migrations/live-catalog.js';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '061_execution_live_position_ledger.sql';
const wallet = '11111111111111111111111111111111';
const mint = 'So11111111111111111111111111111111111111112';

void test('061 defines an append-only ledger and the catalog pins it', async () => {
  const sql = await readFile(new URL(`../migrations/${migrationName}`, import.meta.url), 'utf8');
  for (const fragment of [
    'CREATE TABLE IF NOT EXISTS execution_live_position_ledger',
    'position_id TEXT PRIMARY KEY',
    'net_lamports = entry_wallet_lamport_delta + exit_wallet_lamport_delta',
    'BEFORE UPDATE OR DELETE ON execution_live_position_ledger',
    'reject_execution_live_immutable_update()',
  ]) assert.ok(sql.includes(fragment), `missing migration contract: ${fragment}`);
  assert.doesNotMatch(sql, /\bREFERENCES\b/u, 'the purged position must not be referenced');
  assert.doesNotMatch(sql, /\b(?:DELETE FROM|TRUNCATE|DROP TABLE)\b/u);
  assert.ok(LIVE_EXECUTION_MIGRATION_CATALOG.some((entry) => entry.name === migrationName));
});

void test('061 stores one immutable, arithmetically consistent row per closed position', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    await migrateDatabase({ pool });
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await insertLedger(pool, {});
    const stored = await pool.query(`SELECT net_lamports::TEXT AS net_lamports,
      recorded_at IS NOT NULL AS recorded FROM execution_live_position_ledger`);
    assert.deepEqual(stored.rows, [{ net_lamports: '-4205', recorded: true }]);

    await assert.rejects(insertLedger(pool, {}), { code: '23505' });
    for (const override of [
      { id: 'b', net: '-4204' },
      { id: 'c', closedAt: '2026-10-06T09:59:59.000Z' },
      { id: 'd', exitSignature: 'not-a-signature' },
      { id: 'e', base: '0' },
      { id: 'f', entry: '-5000.5', net: '-4205.5' },
    ]) {
      await assert.rejects(insertLedger(pool, override), { code: '23514' }, JSON.stringify(override));
    }
    await assert.rejects(pool.query('UPDATE execution_live_position_ledger SET net_lamports=0'),
      { code: '55000' });
    await assert.rejects(pool.query('DELETE FROM execution_live_position_ledger'), { code: '55000' });
    assert.equal((await pool.query('SELECT 1 FROM execution_live_position_ledger')).rowCount, 1);
  });
});

async function insertLedger(
  pool: InstanceType<typeof pg.Pool>,
  overrides: Partial<Record<'id' | 'closedAt' | 'exitSignature' | 'base' | 'entry' | 'net', string>>,
): Promise<unknown> {
  const values = {
    id: 'a', closedAt: '2026-10-06T10:05:00.000Z', exitSignature: '2'.repeat(64),
    base: '95', entry: '-5000', net: '-4205', ...overrides,
  };
  return pool.query(`INSERT INTO execution_live_position_ledger (
    position_id,wallet_public_key,mint,opened_at,closed_at,base_amount_raw,
    entry_wallet_lamport_delta,exit_wallet_lamport_delta,net_lamports,
    entry_signature,exit_signature
  ) VALUES ('execution_live_position_'||repeat($1,64),$2,$3,TIMESTAMPTZ '2026-10-06T10:00:00.000Z',
    $4::TIMESTAMPTZ,$5::NUMERIC,$6::NUMERIC,795,$7::NUMERIC,$8,$9)`, [
    values.id, wallet, mint, values.closedAt, values.base, values.entry, values.net,
    '1'.repeat(64), values.exitSignature,
  ]);
}

async function withTemporarySchema(
  context: TestContext,
  run: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live position ledger migration test skipped');
    return;
  }
  const schema = `live_position_ledger_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1,
  });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await run(pool);
  } finally {
    await pool.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
  }
}
