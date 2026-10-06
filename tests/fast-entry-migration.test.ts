import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '064_fast_entry_decisions.sql';
const decidedAt = '2026-10-06T10:00:00.000Z';
const purgeAfter = '2026-10-13T10:00:00.000Z';
const FINGERPRINT = 'a'.repeat(64);

void test('064 defines the entry envelope and decision tables and the FastEntryDecided type', async () => {
  const sql = await readFile(new URL(`../migrations/${migrationName}`, import.meta.url), 'utf8');
  for (const fragment of [
    'execution_entry_envelopes', 'execution_entry_envelopes_one_active_idx', 'max_open_positions = 1',
    "INTERVAL '24 hours'", 'entry_decisions', 'mint TEXT NOT NULL UNIQUE', "entry_mode = 'fast'",
    'entry_decisions_purge_idx', 'api_event_stream_event_type_check', "'FastEntryDecided'",
  ]) assert.ok(sql.includes(fragment), `missing migration contract: ${fragment}`);
  assert.doesNotMatch(sql, /REFERENCES/u);
  assert.doesNotMatch(sql, /\b(?:DELETE FROM|TRUNCATE|DROP TABLE)\b/u);
});

void test('064 enforces the envelope invariants', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    await migrateDatabase({ pool });
    assert.equal((await pool.query('SELECT 1 FROM migration_history WHERE version = $1',
      [migrationName])).rowCount, 1);

    await insertEnvelope(pool, { envelope_id: 'env-1' });
    await assert.rejects(insertEnvelope(pool, { envelope_id: 'env-2' }), { code: '23505' });
    await insertEnvelope(pool, { envelope_id: 'env-3', state: 'EXHAUSTED' });
    await insertEnvelope(pool, { envelope_id: 'env-4', generation_id: 'other-generation' });
    await assert.rejects(insertEnvelope(pool, { envelope_id: 'env-5', generation_id: 'g5',
      max_open_positions: 2 }), { code: '23514' });
    await assert.rejects(insertEnvelope(pool, { envelope_id: 'env-6', generation_id: 'g6',
      valid_until: '2026-10-07T10:00:00.001Z' }), { code: '23514' });
    await assert.rejects(insertEnvelope(pool, { envelope_id: 'env-7', generation_id: 'g7',
      state: 'REVOKED' }), { code: '23514' });
    await insertEnvelope(pool, { envelope_id: 'env-8', generation_id: 'g8', state: 'REVOKED',
      revoked_at: decidedAt });
  });
});

void test('064 enforces the entry decision invariants', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    await migrateDatabase({ pool });
    await insertDecision(pool, { mint: 'MINT_A', decision_id: decisionId('1'), decision: 'REJECTED',
      reason_code: 'NO_ENVELOPE_CAPACITY' });
    await assert.rejects(insertDecision(pool, { mint: 'MINT_A', decision_id: decisionId('2'),
      decision: 'REJECTED', reason_code: 'QUOTE_UNAVAILABLE' }), { code: '23505' });
    await assert.rejects(insertDecision(pool, { mint: 'MINT_B', decision_id: decisionId('3'),
      decision: 'REJECTED', reason_code: null }), { code: '23514' });
    await assert.rejects(insertDecision(pool, { mint: 'MINT_C', decision_id: decisionId('4'),
      decision: 'BUY', reason_code: null, envelope_id: 'env', buy_quote: '{}', reverse_quote: '{}',
      round_trip_loss_bps: 10, intent_id: null }), { code: '23514' });
    await insertDecision(pool, { mint: 'MINT_D', decision_id: decisionId('5'), decision: 'BUY',
      reason_code: null, envelope_id: 'env', buy_quote: '{}', reverse_quote: '{}',
      round_trip_loss_bps: 10, intent_id: 'intent' });
    await assert.rejects(insertDecision(pool, { mint: 'MINT_E', decision_id: 'bad',
      decision: 'REJECTED', reason_code: 'QUOTE_UNAVAILABLE' }), { code: '23514' });
    await assert.rejects(insertDecision(pool, { mint: 'MINT_F', decision_id: decisionId('6'),
      decision: 'REJECTED', reason_code: 'QUOTE_UNAVAILABLE', purge_after: decidedAt }), { code: '23514' });
  });
});

void test('064 publishes FastEntryDecided domain events to the api event stream', async (context) => {
  await withTemporarySchema(context, async (pool) => {
    await migrateDatabase({ pool });
    await pool.query(`INSERT INTO domain_events (
      event_id,type,mint,source,program,signature,slot,transaction_index,instruction_index,
      confirmation_status,observed_at,payload_version,payload
    ) VALUES ('fast-entry-event','FastEntryDecided','MINT_A','listener','pump','sig',
      1,0,0,'confirmed',now(),1,'{}')`);
    assert.equal((await pool.query(`SELECT 1 FROM api_event_stream
      WHERE domain_event_id = 'fast-entry-event' AND event_type = 'FastEntryDecided'`)).rowCount, 1);
  });
});

function decisionId(char: string): string {
  return `entry_decision_${char.repeat(64)}`;
}

async function insertEnvelope(pool: pg.Pool, overrides: Readonly<Record<string, unknown>>): Promise<void> {
  const row: Readonly<Record<string, unknown>> = {
    envelope_id: 'env', generation_id: 'generation', operator_id: 'operator', payload_version: 1,
    fingerprint: FINGERPRINT, per_buy_quote_amount_raw: '1000', max_buys: 3, max_open_positions: 1,
    max_total_exposure_raw: '3000', max_realized_loss_raw: '500', valid_from: decidedAt,
    valid_until: '2026-10-07T10:00:00.000Z', state: 'ACTIVE', created_at: decidedAt,
    updated_at: decidedAt, ...overrides,
  };
  await insertRow(pool, 'execution_entry_envelopes', row);
}

async function insertDecision(pool: pg.Pool, overrides: Readonly<Record<string, unknown>>): Promise<void> {
  const row: Readonly<Record<string, unknown>> = {
    decision_id: decisionId('0'), mint: 'MINT', launch_event_id: 'launch-event', create_slot: 1,
    observed_at: decidedAt, decided_at: decidedAt, entry_mode: 'fast', decision: 'REJECTED',
    reason_code: 'QUOTE_UNAVAILABLE', purge_after: purgeAfter, ...overrides,
  };
  await insertRow(pool, 'entry_decisions', row);
}

async function insertRow(pool: pg.Pool, table: string, row: Readonly<Record<string, unknown>>): Promise<void> {
  const columns = Object.keys(row);
  await pool.query(`INSERT INTO ${table} (${columns.join(',')})
    VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(row));
}

async function withTemporarySchema(context: TestContext, run: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: fast entry migration PG tests skipped');
    return;
  }
  const schema = `fast_entry_${randomUUID().replaceAll('-', '')}`;
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
