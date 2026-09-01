import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationUrl = new URL('../migrations/036_execution_live_canary.sql', import.meta.url);
const databaseUrl = process.env.TEST_DATABASE_URL;

void test('migration 036 defines the closed live execution tables and atomic preflight gate', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const table of [
    'execution_signed_transactions',
    'execution_submission_events',
    'execution_live_positions',
    'execution_exit_authorizations',
    'execution_submission_preflight_evidence',
    'execution_pre_submission_revocations',
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'u'));

  assert.match(sql, /signed_transaction_bytes BYTEA NOT NULL/u);
  assert.match(sql, /octet_length\(signed_transaction_bytes\) BETWEEN 1 AND 1232/u);
  assert.match(sql, /signed_transaction_hash ~ '\^\[0-9a-f\]\{64\}\$'/u);
  assert.match(sql, /confirmed_slot BIGINT/u);
  assert.match(sql, /reservation_id TEXT/u);
  assert.match(sql, /quote_observed_at TIMESTAMPTZ NOT NULL/u);
  assert.match(sql, /quote_expires_at TIMESTAMPTZ NOT NULL/u);
  assert.match(sql, /blockhash_validated_at TIMESTAMPTZ NOT NULL/u);
  assert.match(sql, /execution submission preflight evidence required/u);
  assert.match(sql, /execution_submission_preflight_evidence_immutable/u);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS execution_signed_simulation_evidence/u);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS execution_live_unsigned_simulation_evidence/u);
  assert.match(sql, /execution_signed_simulation_evidence_immutable/u);
  assert.match(sql, /execution_live_unsigned_simulation_evidence_immutable/u);
  assert.match(sql, /unsigned_simulation_evidence_id/u);
  assert.match(sql, /REFERENCES execution_live_unsigned_simulation_evidence\(evidence_id\)/u);
  assert.match(sql, /execution_pre_submission_revocations_immutable/u);
  assert.match(sql, /revoked_at TIMESTAMPTZ/u);
  assert.match(sql, /PRE_SUBMISSION_REVOKED_NO_SEND/u);
  assert.match(sql, /\(confirmed_at IS NULL\) = \(confirmed_slot IS NULL\)/u);
  assert.match(sql, /PRIMARY KEY \(intent_id, attempt_number\)/u);
  assert.match(sql, /FOREIGN KEY \(intent_id, attempt_number\)[\s\S]*REFERENCES execution_attempts/u);
  assert.match(sql, /state IN \('PERSISTED','SIGNED_SIMULATED','SUBMISSION_STARTED',[\s\S]*'REVOKED_NO_SEND'\)/u);
  assert.match(sql, /state IN \('OPEN','EXIT_PENDING','CLOSED','UNKNOWN'\)/u);
  assert.match(sql, /state IN \('ACTIVE','LOCKED','CONSUMED','REVOKED'\)/u);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(NEW\.generation_id, 51005\)\)/u);
  assert.match(sql, /guard_execution_signed_transaction_insert/u);
  assert.match(sql, /NEW\.state <> 'PERSISTED' OR NEW\.state_revision <> 0/u);
  assert.match(sql, /guard_execution_live_position_insert/u);
  assert.match(sql, /guard_execution_exit_authorization_insert/u);
  assert.match(sql, /reject_execution_live_immutable_update/u);
  assert.match(sql, /execution_live_state_transition_allowed/u);
  assert.match(sql, /execution_signed_transactions_event_required/u);
  assert.match(sql, /IF artifact_revision IS NULL THEN\s+RETURN NULL;/u);
  assert.doesNotMatch(sql, /NUMERIC\s*\(/iu);
  assert.doesNotMatch(sql, /\b(?:REAL|DOUBLE\s+PRECISION|JSONB?)\b/iu);
});

void test('migration 036 applies to an empty PostgreSQL schema and replays cleanly', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL absent: live migration integration skipped');
    return;
  }
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `execution_live_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  context.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  });

  await migrateDatabase({ pool });
  await migrateDatabase({ pool });
  const tables = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema=current_schema()
      AND table_name LIKE 'execution_%'
    ORDER BY table_name`);
  const names = tables.rows.map((row) => row.table_name);
  for (const name of [
    'execution_signed_transactions',
    'execution_submission_events',
    'execution_live_positions',
    'execution_exit_authorizations',
    'execution_submission_preflight_evidence',
    'execution_pre_submission_revocations',
    'execution_signed_simulation_evidence',
    'execution_live_unsigned_simulation_evidence',
  ]) assert.equal(names.includes(name), true, `${name} missing`);

  const byteColumn = await pool.query<{ data_type: string }>(`
    SELECT data_type FROM information_schema.columns
    WHERE table_schema=current_schema()
      AND table_name='execution_signed_transactions'
      AND column_name='signed_transaction_bytes'`);
  assert.equal(byteColumn.rows[0]?.data_type, 'bytea');

  const stateGraphs = Object.freeze({
    SIGNED_TRANSACTION: Object.freeze({
      states: Object.freeze([
        'PERSISTED', 'SIGNED_SIMULATED', 'SUBMISSION_STARTED', 'ACCEPTED',
        'AMBIGUOUS', 'CONFIRMED', 'RECONCILED', 'REVOKED_NO_SEND',
      ]),
      edges: new Set([
        'PERSISTED->SIGNED_SIMULATED', 'PERSISTED->REVOKED_NO_SEND',
        'SIGNED_SIMULATED->SUBMISSION_STARTED', 'SIGNED_SIMULATED->REVOKED_NO_SEND',
        'SUBMISSION_STARTED->ACCEPTED', 'SUBMISSION_STARTED->AMBIGUOUS',
        'ACCEPTED->CONFIRMED', 'ACCEPTED->AMBIGUOUS',
        'AMBIGUOUS->CONFIRMED', 'AMBIGUOUS->RECONCILED',
        'CONFIRMED->AMBIGUOUS', 'CONFIRMED->RECONCILED',
      ]),
    }),
    LIVE_POSITION: Object.freeze({
      states: Object.freeze(['OPEN', 'EXIT_PENDING', 'CLOSED', 'UNKNOWN']),
      edges: new Set([
        'OPEN->EXIT_PENDING', 'OPEN->UNKNOWN',
        'EXIT_PENDING->CLOSED', 'EXIT_PENDING->UNKNOWN',
        'UNKNOWN->EXIT_PENDING', 'UNKNOWN->CLOSED',
      ]),
    }),
    EXIT_AUTHORIZATION: Object.freeze({
      states: Object.freeze(['ACTIVE', 'LOCKED', 'CONSUMED', 'REVOKED']),
      edges: new Set([
        'ACTIVE->LOCKED', 'ACTIVE->REVOKED',
        'LOCKED->ACTIVE', 'LOCKED->CONSUMED', 'LOCKED->REVOKED',
      ]),
    }),
  });
  for (const [entity, graph] of Object.entries(stateGraphs)) {
    for (const previous of graph.states) {
      for (const next of graph.states) {
        const allowed = await pool.query<{ allowed: boolean }>(
          'SELECT execution_live_state_transition_allowed($1,$2,$3) AS allowed',
          [entity, previous, next],
        );
        assert.equal(
          allowed.rows[0]?.allowed,
          graph.edges.has(`${previous}->${next}`),
          `${entity} ${previous}->${next}`,
        );
      }
    }
  }
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
