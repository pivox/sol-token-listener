import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationUrl = new URL('../migrations/006_api_event_stream.sql', import.meta.url);

void test('la migration crée une outbox append-only publique, indexée et sans FK parent', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS api_event_stream/u);
  assert.match(sql, /sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY/u);
  assert.match(sql, /stream_event_id TEXT UNIQUE NOT NULL/u);
  assert.match(sql, /domain_event_id TEXT NOT NULL/u);
  assert.match(sql, /revision BIGINT NOT NULL CHECK \(revision > 0\)/u);
  assert.match(sql, /UNIQUE\(domain_event_id, revision\)/u);
  assert.doesNotMatch(sql, /domain_event_id TEXT[^,]*REFERENCES/iu);
  assert.match(sql, /confirmation_status TEXT NOT NULL[\s\S]*'processed'[\s\S]*'confirmed'[\s\S]*'finalized'[\s\S]*'orphaned'/u);
  assert.match(sql, /payload_version INTEGER NOT NULL CHECK \(payload_version > 0\)/u);
  assert.match(sql, /event JSONB NOT NULL/u);
  assert.match(sql, /emitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/u);
  assert.match(sql, /purge_after TIMESTAMPTZ NOT NULL/u);
  const backfill = sql.lastIndexOf('INSERT INTO api_event_stream');
  assert.ok(sql.indexOf('CREATE INDEX IF NOT EXISTS api_event_stream_mint_sequence_idx') > backfill);
  assert.ok(sql.indexOf('CREATE INDEX IF NOT EXISTS api_event_stream_purge_after_idx') > backfill);
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL)\b/iu);
});

void test('la migration enfile les révisions publiques avec trigger rejouable et backfill idempotent', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /CREATE OR REPLACE FUNCTION enqueue_api_domain_event_revision\(\)/u);
  assert.match(sql, /SECURITY INVOKER/u);
  assert.match(sql, /AFTER INSERT OR UPDATE ON domain_events/u);
  assert.match(sql, /DROP TRIGGER IF EXISTS enqueue_api_domain_event_revision_trigger ON domain_events/u);
  assert.match(sql, /CREATE TRIGGER enqueue_api_domain_event_revision_trigger/u);
  for (const key of [
    'eventId', 'type', 'mint', 'source', 'program', 'signature', 'slot',
    'transactionIndex', 'instructionIndex', 'innerInstructionIndex',
    'confirmationStatus', 'blockchainTime', 'observedAt', 'payloadVersion', 'payload',
  ]) assert.match(sql, new RegExp(`'${key}'`, 'u'));
  assert.match(sql, /md5\(public_event::text\)/u);
  assert.match(sql, /format\(\s*\$sql\$[\s\S]*%I\.api_event_stream/u);
  assert.match(sql, /TG_TABLE_SCHEMA/u);
  assert.match(sql, /COALESCE\(MAX\(revision\), 0\) \+ 1/u);
  assert.match(sql, /event_id \|\| ':' \|\| revision::text \|\| ':'/u);
  assert.match(sql, /ON CONFLICT \(domain_event_id, revision\) DO NOTHING/u);
  assert.match(sql, /NOT EXISTS \([\s\S]*existing\.domain_event_id = domain_events\.event_id/u);
  assert.match(sql, /%1\$I\.api_event_stream existing/u);
  assert.match(sql, /NOW\(\) \+ INTERVAL '4 hours'/u);
  assert.match(sql, /WHERE \(?purge_after IS NULL OR purge_after > NOW\(\)\)?/u);
  assert.match(sql, /ORDER BY created_at, event_id/u);
  assert.match(sql, /to_char\(\s*NEW\.blockchain_time AT TIME ZONE 'UTC'/u);
  assert.match(sql, /to_char\(\s*NEW\.observed_at AT TIME ZONE 'UTC'/u);
  assert.match(sql, /to_char\(\s*blockchain_time AT TIME ZONE 'UTC'/u);
  assert.match(sql, /to_char\(\s*observed_at AT TIME ZONE 'UTC'/u);
});

void test('la purge supprime l’outbox avant les événements de domaine et expose son compteur', async () => {
  const source = await readFile(new URL('../src/storage/database.ts', import.meta.url), 'utf8');

  const outboxDeletion = source.indexOf("DELETE FROM api_event_stream WHERE purge_after <= NOW()");
  const domainDeletion = source.indexOf("DELETE FROM domain_events WHERE purge_after <= NOW()");
  assert.ok(outboxDeletion >= 0);
  assert.ok(domainDeletion > outboxDeletion);
  assert.match(source, /readonly apiEventStream: number;/u);
  assert.match(source, /apiEventStream: apiEventStream\.rowCount \?\? 0,/u);
});

void test('la migration fonctionne en base réelle si TEST_DATABASE_URL est configurée', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent : test PostgreSQL live ignoré');
    return;
  }

  const schema = `api_event_stream_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^[a-z_][a-z0-9_]*$/u);
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    } finally {
      client.release();
    }
    await migrateDatabase({ pool });
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await pool.query("SET TIME ZONE 'Europe/Paris'");

    await pool.query(`
        INSERT INTO token_launches (
          mint, launchpad, program_id, creator, token_program, current_state,
          created_signature, created_slot, created_transaction_index, created_instruction_index,
          detected_at, updated_at
        ) VALUES ('mint-live', 'pumpfun', 'program-live', 'creator-live', 'token-program',
          'detected', 'launch-signature', 1, 0, 0, NOW(), NOW())
    `);
    await pool.query(`
        INSERT INTO raw_chain_events (
          event_id, source, program, mint, signature, slot, transaction_index, instruction_index,
          confirmation_status, observed_at, payload_version, payload
        ) VALUES ('raw-live', 'listener', 'program-live', 'mint-live', 'signature-live', 42, 1, 2,
          'processed', '2025-01-02T03:04:05.000Z', 1, '{"amountRaw":"9007199254740993"}'::jsonb)
    `);
    await pool.query(`
        INSERT INTO domain_events (
          event_id, raw_event_id, type, mint, source, program, signature, slot,
          transaction_index, instruction_index, inner_instruction_index, confirmation_status,
          blockchain_time, observed_at, payload_version, payload
        ) VALUES ('domain-live', 'raw-live', 'launch_detected', 'mint-live', 'listener', 'program-live',
          'signature-live', 42, 1, 2, NULL, 'processed', '2025-01-02T03:04:04.000Z',
          '2025-01-02T03:04:05.000Z', 1, '{"amountRaw":"9007199254740993"}'::jsonb)
    `);
    await pool.query(`INSERT INTO domain_events (
        event_id, type, mint, source, program, signature, slot, transaction_index, instruction_index,
        confirmation_status, observed_at, payload_version, payload, terminal_at, purge_after
      ) VALUES ('backfill-live', 'launch_detected', 'mint-live', 'listener', 'program-live', 'backfill-signature',
        43, 1, 2, 'processed', NOW(), 1, '{}'::jsonb, NOW(), NOW() + INTERVAL '1 hour')`);
    await pool.query('DELETE FROM api_event_stream WHERE domain_event_id = $1', ['backfill-live']);

    await pool.query("UPDATE domain_events SET confirmation_status = 'processed' WHERE event_id = 'domain-live'");
    await pool.query("UPDATE domain_events SET confirmation_status = 'confirmed' WHERE event_id = 'domain-live'");
    await pool.query("UPDATE domain_events SET confirmation_status = 'finalized' WHERE event_id = 'domain-live'");
    await pool.query("UPDATE domain_events SET confirmation_status = 'orphaned' WHERE event_id = 'domain-live'");
    const revisions = await pool.query<{ readonly revision: string; readonly confirmation_status: string }>(
      'SELECT revision, confirmation_status FROM api_event_stream WHERE domain_event_id = $1 ORDER BY sequence', ['domain-live'],
    );
    assert.deepEqual(revisions.rows.map((row) => row.revision), ['1', '2', '3', '4']);
    assert.deepEqual(revisions.rows.map((row) => row.confirmation_status), ['processed', 'confirmed', 'finalized', 'orphaned']);
    const publicEvent = await pool.query<{ readonly observed_at: string }>(
      "SELECT event->>'observedAt' AS observed_at FROM api_event_stream WHERE domain_event_id = 'domain-live' ORDER BY sequence LIMIT 1",
    );
    assert.equal(publicEvent.rows[0]?.observed_at, '2025-01-02T03:04:05.000Z');
    await pool.query("UPDATE domain_events SET terminal_at = NOW() WHERE event_id = 'domain-live'");
    assert.equal((await pool.query('SELECT 1 FROM api_event_stream WHERE domain_event_id = $1', ['domain-live'])).rowCount, 4);

    const migrationSql = await readFile(migrationUrl, 'utf8');
    await pool.query("SET TIME ZONE 'America/New_York'");
    await pool.query(migrationSql);
    await pool.query(migrationSql);
    assert.equal((await pool.query('SELECT 1 FROM api_event_stream WHERE domain_event_id = $1', ['backfill-live'])).rowCount, 1);
    assert.equal((await pool.query('SELECT 1 FROM api_event_stream WHERE domain_event_id = $1', ['domain-live'])).rowCount, 4);

    await pool.query(`INSERT INTO domain_events (
      event_id, type, mint, source, program, signature, slot, transaction_index, instruction_index,
      confirmation_status, observed_at, payload_version, payload
    ) VALUES ('revision-live', 'launch_detected', 'mint-live', 'listener', 'program-live', 'revision-signature',
      44, 1, 2, 'processed', NOW(), 1, '{"state":"A"}'::jsonb)`);
    await pool.query("UPDATE domain_events SET payload = '{\"state\":\"B\"}'::jsonb WHERE event_id = 'revision-live'");
    await pool.query("UPDATE domain_events SET payload = '{\"state\":\"A\"}'::jsonb WHERE event_id = 'revision-live'");
    const payloadRevisions = await pool.query<{
      readonly revision: string;
      readonly state: string;
    }>("SELECT revision, event->'payload'->>'state' AS state FROM api_event_stream WHERE domain_event_id = 'revision-live' ORDER BY revision");
    assert.deepEqual(payloadRevisions.rows, [
      { revision: '1', state: 'A' },
      { revision: '2', state: 'B' },
      { revision: '3', state: 'A' },
    ]);

    await pool.query(`INSERT INTO domain_events (
      event_id, type, mint, source, program, signature, slot, transaction_index, instruction_index,
      confirmation_status, observed_at, payload_version, payload
    ) VALUES ('partial-replay-live', 'launch_detected', 'mint-live', 'listener', 'program-live', 'partial-signature',
      46, 1, 2, 'processed', NOW(), 1, '{"state":"A"}'::jsonb)`);
    await pool.query("UPDATE domain_events SET payload = '{\"state\":\"B\"}'::jsonb WHERE event_id = 'partial-replay-live'");
    await pool.query('DELETE FROM api_event_stream WHERE domain_event_id = $1 AND revision = 1', ['partial-replay-live']);
    await pool.query(migrationSql);
    const retainedRevision = await pool.query<{ readonly revision: string; readonly state: string }>(
      "SELECT revision, event->'payload'->>'state' AS state FROM api_event_stream WHERE domain_event_id = 'partial-replay-live' ORDER BY revision",
    );
    assert.deepEqual(retainedRevision.rows, [{ revision: '2', state: 'B' }]);

    await pool.query(`CREATE TEMP TABLE api_event_stream (
      LIKE ${quoteIdentifier(schema)}.api_event_stream INCLUDING ALL
    )`);
    await pool.query(`INSERT INTO domain_events (
      event_id, type, mint, source, program, signature, slot, transaction_index, instruction_index,
      confirmation_status, observed_at, payload_version, payload
    ) VALUES ('schema-target-live', 'launch_detected', 'mint-live', 'listener', 'program-live', 'schema-target-signature',
      45, 1, 2, 'processed', NOW(), 1, '{}'::jsonb)`);
    const persistentCount = await pool.query<{ readonly count: string }>(
      `SELECT count(*) AS count FROM ${quoteIdentifier(schema)}.api_event_stream WHERE domain_event_id = 'schema-target-live'`,
    );
    const temporaryCount = await pool.query<{ readonly count: string }>(
      "SELECT count(*) AS count FROM api_event_stream WHERE domain_event_id = 'schema-target-live'",
    );
    assert.equal(persistentCount.rows[0]?.count, '1');
    assert.equal(temporaryCount.rows[0]?.count, '0');
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
