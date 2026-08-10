import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { DOMAIN_EVENT_TYPES } from '../src/domain/events.js';
import { migrateDatabase } from '../src/storage/database.js';

const migrationUrl = new URL('../migrations/013_paper_e2e.sql', import.meta.url);

void test('defines the complete additive paper decision schema with closed enums', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const table of [
    'paper_decision_jobs', 'qualification_reports', 'trading_candidates',
    'paper_strategy_sessions', 'paper_external_buy_events',
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'u'));
  assert.match(sql, /PENDING.*PROCESSING.*RETRYABLE_FAILED.*COMPLETED.*CANCELLED/su);
  assert.match(sql, /NOT_ELIGIBLE.*ELIGIBLE.*EXPIRED.*REVOKED/su);
  assert.match(sql, /BUY_PENDING.*PAPER_HOLDING.*WAITING_EXTERNAL_BUYS.*EXIT_PENDING_QUOTE.*SELL_PENDING.*PAPER_CLOSED.*PAPER_RETRACTED.*MANUAL_REVIEW/su);
  assert.match(sql, /QUALIFICATION_NOT_ELIGIBLE.*RECONCILIATION_REQUIRED/su);
  assert.match(sql, /reason_codes <@/u);
  assert.match(sql, /paper_decision_jobs_claim_idx/u);
  assert.match(sql, /trading_candidates_current_idx/u);
  assert.match(sql, /paper_strategy_sessions_active_idx/u);
  assert.match(sql, /UNIQUE \(session_id, trade_id\)/u);
  assert.match(sql, /NUMERIC\(78,0\)/u);
  assert.match(sql, /payload_version INTEGER NOT NULL CHECK \(payload_version = 1\)/u);
  assert.match(sql, /INTERVAL '4 hours'/u);
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL)\b|private[_ ]?key|sendTransaction|simulateTransaction/iu);
});

void test('updates the public outbox enum and replayable backfill for every domain event type', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /DROP CONSTRAINT[\s\S]*event_type/iu);
  assert.deepEqual(
    sqlStringListAfter(sql, 'ADD CONSTRAINT api_event_stream_event_type_check CHECK (event_type IN ('),
    DOMAIN_EVENT_TYPES,
  );
  for (const type of [
    'TradingCandidateUpdated', 'PaperStrategySessionUpdated', 'PaperExternalBuyCounted',
  ]) assert.match(sql, new RegExp(`'${type}'`, 'u'));
  assert.match(sql, /pg_advisory_xact_lock/u);
  assert.match(sql, /ON CONFLICT \(domain_event_id, revision\) DO NOTHING/u);
  assert.match(sql, /NOT EXISTS \([\s\S]*existing\.domain_event_id = domain_events\.event_id/u);
});

void test('migrates an empty PostgreSQL schema and replays cleanly', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  const schema = `paper_e2e_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const applied = await migrateDatabase({ pool });
    assert.ok(applied.includes('013_paper_e2e.sql'));
    assert.deepEqual(await migrateDatabase({ pool }), []);
    const relations = await pool.query<{ readonly table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema=current_schema() AND table_name IN (
        'paper_decision_jobs','qualification_reports','trading_candidates',
        'paper_strategy_sessions','paper_external_buy_events'
      ) ORDER BY table_name`);
    assert.equal(relations.rowCount, 5);
    const constraints = await pool.query<{ readonly definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE connamespace=current_schema()::regnamespace
        AND conrelid IN ('paper_decision_jobs'::regclass,'trading_candidates'::regclass,
          'paper_strategy_sessions'::regclass)`);
    const definitions = constraints.rows.map((row) => row.definition).join('\n');
    assert.match(definitions, /RETRYABLE_FAILED/u);
    assert.match(definitions, /EXTERNAL_BUY_TARGET_REACHED/u);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

function sqlStringListAfter(sql: string, marker: string): string[] {
  const start = sql.indexOf(marker);
  assert.ok(start >= 0, `missing SQL marker: ${marker}`);
  const end = sql.indexOf(')', start + marker.length);
  assert.ok(end > start);
  return [...sql.slice(start + marker.length, end).matchAll(/'([^']+)'/gu)]
    .map((match) => match[1] ?? '');
}
