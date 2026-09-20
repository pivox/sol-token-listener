import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { PostgresTransactionInboxRepository } from '../src/storage/transaction-inbox.repository.js';

const migrationsUrl = new URL('../migrations/', import.meta.url);
const migrationUrl = new URL('../migrations/050_transaction_inbox_first_processing.sql', import.meta.url);

void test('migration 050 defines durable database-clock first-processing evidence', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const fragment of [
    'first_detected_at TIMESTAMPTZ',
    'first_processed_at TIMESTAMPTZ',
    'first_processing_evidence_unavailable BOOLEAN NOT NULL DEFAULT FALSE',
    "date_trunc('milliseconds', clock_timestamp())",
    'chain_transaction_inbox_first_processing_cohort_idx',
    'chain_transaction_inbox_first_processing_guard',
  ]) assert.ok(sql.includes(fragment), `missing migration fragment: ${fragment}`);
});

void test('migration 050 classifies all legacy inbox rows unavailable without inventing evidence', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL first-processing migration test skipped');
    return;
  }
  const schema = `first_processing_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const legacyNames = (await readdir(migrationsUrl))
      .filter((name) => /^0(?:0[1-9]|[1-4][0-9])_/u.test(name)).sort();
    assert.equal(legacyNames.at(-1), '049_transaction_inbox_catch_up_admission_receipt.sql');
    for (const name of legacyNames) await pool.query(await readFile(new URL(name, migrationsUrl), 'utf8'));
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, observed_at, processed_at, normalized_transaction, immutable_fingerprint
    ) VALUES
      ('legacy-processed', 1, ARRAY['WEBSOCKET'], ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
       'confirmed', 'PROCESSED', NOW(), NOW(), '{}'::JSONB, repeat('a',64)),
      ('legacy-reopened', 2, ARRAY['CATCH_UP'], ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
       'confirmed', 'PENDING', NOW(), NULL, NULL, NULL)`);
    await pool.query(await readFile(migrationUrl, 'utf8'));
    await pool.query(await readFile(migrationUrl, 'utf8'));
    const legacy = await pool.query(`SELECT signature, first_detected_at, first_processed_at,
      first_processing_evidence_unavailable FROM chain_transaction_inbox ORDER BY signature`);
    assert.deepEqual(legacy.rows, [
      { signature: 'legacy-processed', first_detected_at: null, first_processed_at: null,
        first_processing_evidence_unavailable: true },
      { signature: 'legacy-reopened', first_detected_at: null, first_processed_at: null,
        first_processing_evidence_unavailable: true },
    ]);
    const repository = new PostgresTransactionInboxRepository(pool);
    for (const signature of ['legacy-processed', 'legacy-reopened']) {
      await repository.enqueue(Object.freeze({
        signature, slot: signature === 'legacy-processed' ? 1n : 2n,
        source: 'WEBSOCKET' as const,
        programIds: Object.freeze(['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']),
        confirmationStatus: 'confirmed' as const, observedAtMs: 1_000,
        ingestionHint: null, ingestionHintMint: null,
      }));
    }
    assert.deepEqual((await pool.query(`SELECT signature, first_detected_at, first_processed_at,
      first_processing_evidence_unavailable FROM chain_transaction_inbox
      WHERE signature IN ('legacy-processed','legacy-reopened') ORDER BY signature`)).rows, legacy.rows);
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, observed_at
    ) VALUES ('fresh', 3, ARRAY['WEBSOCKET'], ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
      'confirmed', 'PENDING', NOW())`);
    const fresh = (await pool.query(`SELECT first_detected_at, first_processed_at,
      first_processing_evidence_unavailable,
      date_trunc('milliseconds', first_detected_at)=first_detected_at AS millisecond,
      isfinite(first_detected_at) AS finite FROM chain_transaction_inbox WHERE signature='fresh'`)).rows[0];
    assert.equal(fresh?.first_processed_at, null);
    assert.equal(fresh?.first_processing_evidence_unavailable, false);
    assert.equal(fresh?.millisecond, true);
    assert.equal(fresh?.finite, true);
    await assert.rejects(pool.query(`UPDATE chain_transaction_inbox
      SET first_detected_at=clock_timestamp() WHERE signature='fresh'`), { code: '23514' });
    await assert.rejects(pool.query(`UPDATE chain_transaction_inbox
      SET first_processed_at=clock_timestamp() WHERE signature='fresh'`), { code: '23514' });
    await pool.query(`UPDATE chain_transaction_inbox SET processing_status='PROCESSING',
      lease_token='fresh-lease', lease_expires_at=clock_timestamp()+INTERVAL '1 minute',
      normalized_transaction='{}'::JSONB, immutable_fingerprint=repeat('b',64)
      WHERE signature='fresh'`);
    await pool.query(`WITH completed AS MATERIALIZED (
      SELECT date_trunc('milliseconds', clock_timestamp()) AS at
    ) UPDATE chain_transaction_inbox SET processing_status='PROCESSED', lease_token=NULL,
      lease_expires_at=NULL, processed_at=completed.at, first_processed_at=completed.at
      FROM completed WHERE signature='fresh'`);
    const completed = (await pool.query(`SELECT first_detected_at, first_processed_at, processed_at,
      first_processing_evidence_unavailable FROM chain_transaction_inbox WHERE signature='fresh'`)).rows[0];
    assert.equal(completed?.first_processed_at.getTime(), completed?.processed_at.getTime());
    assert.equal(completed?.first_processing_evidence_unavailable, false);
    await assert.rejects(pool.query(`UPDATE chain_transaction_inbox SET first_processed_at=NULL
      WHERE signature='fresh'`), { code: '23514' });

    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, observed_at, normalized_transaction, immutable_fingerprint,
      lease_token, lease_expires_at
    ) VALUES ('old-binary', 4, ARRAY['WEBSOCKET'], ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
      'confirmed', 'PROCESSING', NOW(), '{}'::JSONB, repeat('c',64), 'old-lease',
      clock_timestamp()+INTERVAL '1 minute')`);
    await pool.query(`UPDATE chain_transaction_inbox SET processing_status='PROCESSED',
      lease_token=NULL, lease_expires_at=NULL, processed_at=date_trunc('milliseconds',clock_timestamp())
      WHERE signature='old-binary'`);
    const oldBinary = (await pool.query(`SELECT first_processed_at,first_processing_evidence_unavailable
      FROM chain_transaction_inbox WHERE signature='old-binary'`)).rows[0];
    assert.equal(oldBinary?.first_processed_at, null);
    assert.equal(oldBinary?.first_processing_evidence_unavailable, true);
    await assert.rejects(pool.query(`UPDATE chain_transaction_inbox
      SET first_processing_evidence_unavailable=FALSE WHERE signature='old-binary'`), { code: '23514' });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

void test('migration 050 fails closed when its immutable evidence trigger is disabled', async (context) => {
  await withMigration050Database(context, async (pool) => {
    await pool.query('ALTER TABLE chain_transaction_inbox DISABLE TRIGGER chain_transaction_inbox_first_processing_guard');
    await assert.rejects(pool.query(await readFile(migrationUrl, 'utf8')), { code: '23514' });
  });
});

void test('migration 050 fails closed when its trigger has UPDATE OF or WHEN restrictions', async (context) => {
  await withMigration050Database(context, async (pool) => {
    await pool.query('DROP TRIGGER chain_transaction_inbox_first_processing_guard ON chain_transaction_inbox');
    await pool.query(`CREATE TRIGGER chain_transaction_inbox_first_processing_guard
      BEFORE UPDATE OF processed_at ON chain_transaction_inbox
      FOR EACH ROW WHEN (NEW.first_processed_at IS NULL)
      EXECUTE FUNCTION transaction_inbox_first_processing_guard()`);
    await assert.rejects(pool.query(await readFile(migrationUrl, 'utf8')), { code: '23514' });
  });
});

void test('migration 050 fails closed on an incompatible installed evidence column', async (context) => {
  await withMigration050Database(context, async (pool) => {
    await pool.query('ALTER TABLE chain_transaction_inbox ALTER COLUMN first_processed_at SET DEFAULT clock_timestamp()');
    await assert.rejects(pool.query(await readFile(migrationUrl, 'utf8')), { code: '23514' });
  });
});

async function withMigration050Database(
  context: { skip(message?: string): void },
  run: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL first-processing migration test skipped');
    return;
  }
  const schema = `first_processing_guard_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    for (const name of (await readdir(migrationsUrl)).sort()) {
      await pool.query(await readFile(new URL(name, migrationsUrl), 'utf8'));
    }
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
