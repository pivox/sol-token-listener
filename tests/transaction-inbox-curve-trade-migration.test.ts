import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '063_listener_tracked_curve_checkpoints.sql';
const mint = 'So11111111111111111111111111111111111111112';
const program = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const observedAt = '2026-10-06T10:00:00.000Z';

void test('063 defines the curve checkpoint table and the widened hint check', async () => {
  const sql = await readFile(new URL(`../migrations/${migrationName}`, import.meta.url), 'utf8');
  for (const fragment of [
    'listener_tracked_curve_checkpoints', 'REFERENCES token_launches(mint) ON DELETE CASCADE',
    "'PUMPFUN_CURVE_TRADE'", 'chain_transaction_inbox_ingestion_hint_check',
  ]) assert.ok(sql.includes(fragment), `missing migration contract: ${fragment}`);
  assert.match(sql, /OCTET_LENGTH\(ingestion_hint_mint\) BETWEEN 32 AND 44/u);
  assert.match(sql, /\^\[1-9A-HJ-NP-Za-km-z\]\{32,44\}\$/u);
  assert.doesNotMatch(sql, /\b(?:DELETE FROM|TRUNCATE|DROP TABLE)\b/u);
});

void test('063 accepts curve trade hints with a canonical mint and keeps checkpoints bounded', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    await migrateDatabase({ pool });
    assert.equal((await pool.query('SELECT 1 FROM migration_history WHERE version = $1',
      [migrationName])).rowCount, 1);
    await seedLaunch(pool);

    await pool.query(`INSERT INTO listener_tracked_curve_checkpoints (bonding_curve, mint, slot, signature, updated_at)
      VALUES ($1, 'MINT', 10, 'sig', $2)`, ['C'.repeat(32), observedAt]);
    await assert.rejects(pool.query(`UPDATE listener_tracked_curve_checkpoints SET slot = -1`),
      { code: '23514' });
    await assert.rejects(pool.query(`UPDATE listener_tracked_curve_checkpoints SET signature = ''`),
      { code: '23514' });

    await insertInbox(pool, { signature: 'curve-poll', ingestion_hint: 'PUMPFUN_CURVE_TRADE',
      ingestion_hint_mint: mint });
    await assert.rejects(insertInbox(pool, { signature: 'curve-null', ingestion_hint: 'PUMPFUN_CURVE_TRADE',
      ingestion_hint_mint: null }), { code: '23514', constraint: 'chain_transaction_inbox_ingestion_hint_check' });
    await assert.rejects(insertInbox(pool, { signature: 'curve-bad', ingestion_hint: 'PUMPFUN_CURVE_TRADE',
      ingestion_hint_mint: ' bad ' }), { code: '23514', constraint: 'chain_transaction_inbox_ingestion_hint_check' });

    await pool.query(`DELETE FROM token_launches WHERE mint = 'MINT'`);
    assert.equal((await pool.query('SELECT 1 FROM listener_tracked_curve_checkpoints')).rowCount, 0);
  });
});

async function seedLaunch(pool: pg.Pool): Promise<void> {
  const at = new Date(observedAt);
  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,quote_assets,current_state,
    created_signature,created_slot,created_transaction_index,created_instruction_index,
    created_inner_instruction_index,detected_at,updated_at
  ) VALUES ('MINT','pumpfun','pump','creator','SPL_TOKEN','[]','ACTIVE','signature',1,0,0,NULL,$1,$1)`, [at]);
}

async function insertInbox(pool: pg.Pool, overrides: Readonly<Record<string, unknown>>): Promise<void> {
  const row: Readonly<Record<string, unknown>> = {
    signature: randomUUID(), observed_slot: 1, discovery_sources: ['WEBSOCKET'], program_ids: [program],
    target_confirmation_status: 'confirmed', processing_status: 'PENDING', observed_at: observedAt, ...overrides,
  };
  const columns = Object.keys(row);
  await pool.query(`INSERT INTO chain_transaction_inbox (${columns.join(',')})
    VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(row));
}

async function withTemporarySchema(context: TestContext, run: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: curve trade migration PG tests skipped');
    return;
  }
  const schema = `inbox_curve_trade_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}
