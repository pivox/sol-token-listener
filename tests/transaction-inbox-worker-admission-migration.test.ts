import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationsUrl = new URL('../migrations/', import.meta.url);
const migrationName = '053_transaction_inbox_worker_admission_foundation.sql';
const migrationUrl = new URL(migrationName, migrationsUrl);
const pumpProgram = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const observedAt = '2026-09-25T10:00:00.000Z';
const terminalAt = '2026-09-25T10:00:00.001Z';
const purgeAfter = '2026-09-25T14:00:00.001Z';

void test('053 defines the inactive monotone worker-admission foundation without destructive SQL', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const fragment of [
    'worker_admitted_at TIMESTAMPTZ',
    'chain_transaction_inbox_worker_admission_check',
    'transaction_inbox_worker_admission_guard',
    'chain_transaction_inbox_worker_admitted_claim_idx',
    'chain_transaction_inbox_worker_classification_pending_idx',
    'worker_admitted_at IS NOT NULL',
    'worker_admitted_at IS NULL',
  ]) assert.ok(sql.includes(fragment), `missing migration contract: ${fragment}`);
  assert.doesNotMatch(sql, /DROP INDEX chain_transaction_inbox_priority_claim_order_idx/u);
  assert.doesNotMatch(sql, /\b(?:DELETE FROM|TRUNCATE|CASCADE)\b/u);
});

void test('053 upgrades 052 with exact per-status backfill and replays with stable identities', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough052(pool);
    await insertLegacyRows(pool);
    const before = await pool.query(`SELECT signature,processing_status,observed_at
      FROM chain_transaction_inbox ORDER BY signature`);
    const sql = await readFile(migrationUrl, 'utf8');
    await pool.query(sql);

    const rows = await pool.query(`SELECT signature,processing_status,observed_at,worker_admitted_at
      FROM chain_transaction_inbox ORDER BY signature`);
    assert.equal(rows.rowCount, before.rowCount);
    for (const row of rows.rows) {
      if (['PENDING', 'PROCESSING', 'PROCESSED', 'FAILED'].includes(row.processing_status)) {
        assert.equal(row.worker_admitted_at.getTime(), row.observed_at.getTime(), row.signature);
      } else {
        assert.equal(row.worker_admitted_at, null, row.signature);
      }
    }
    const identities = await objectIdentities(pool);
    await pool.query(sql);
    assert.deepEqual(await objectIdentities(pool), identities);
    assert.deepEqual((await pool.query(`SELECT signature,processing_status,observed_at
      FROM chain_transaction_inbox ORDER BY signature`)).rows, before.rows);
    await assertCatalog(pool);
  });
});

void test('053 is the replay-safe clean database head', async (context) => {
  await withDatabase(context, async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), migrationName);
    assert.equal(applied.length, 53);
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await assertCatalog(pool);
  });
});

void test('053 rejects every null-admission worker-evidence contradiction', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough053(pool);
    await insertInbox(pool, { signature: 'null-pending' });
    const contradictions = [
      `processing_status='PROCESSING',lease_token='lease',
       lease_expires_at=clock_timestamp()+INTERVAL '1 minute'`,
      `attempts=1`,
      `attempts=1,attempts_in_cycle=1`,
      `normalized_transaction='{}'::JSONB,immutable_fingerprint=repeat('a',64)`,
      `processed_at=clock_timestamp()`,
      `processing_status='FAILED',attempts=1,attempts_in_cycle=1,
       error_code='RPC_TRANSIENT',error_name='RpcFailure',error_retryable=TRUE,
       next_attempt_at=clock_timestamp()+INTERVAL '1 minute'`,
      `missing_finality_polls=1,last_missing_finality_provider_id='primary'`,
      `finality_evidence_version=1`,
      `manual_recovery_count=1,last_manual_recovery_at=clock_timestamp()`,
    ];
    for (const mutation of contradictions) {
      await pool.query('BEGIN');
      try {
        await assert.rejects(
          pool.query(`UPDATE chain_transaction_inbox SET ${mutation} WHERE signature='null-pending'`),
          { code: '23514' },
          mutation,
        );
      } finally {
        await pool.query('ROLLBACK');
      }
    }
    await insertInbox(pool, { signature: 'finite-check' });
    await assert.rejects(pool.query(`UPDATE chain_transaction_inbox
      SET worker_admitted_at='infinity'::TIMESTAMPTZ WHERE signature='finite-check'`),
    { code: '23514' });
  });
});

void test('053 permits one admission transition and makes its timestamp immutable', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough053(pool);
    await insertInbox(pool, { signature: 'monotone' });
    await pool.query(`UPDATE chain_transaction_inbox SET worker_admitted_at=observed_at
      WHERE signature='monotone'`);
    const admitted = (await pool.query(`SELECT worker_admitted_at
      FROM chain_transaction_inbox WHERE signature='monotone'`)).rows[0]?.worker_admitted_at;
    assert.ok(admitted instanceof Date);
    await assert.rejects(pool.query(`UPDATE chain_transaction_inbox SET worker_admitted_at=NULL
      WHERE signature='monotone'`), { code: '23514' });
    await assert.rejects(pool.query(`UPDATE chain_transaction_inbox
      SET worker_admitted_at=worker_admitted_at+INTERVAL '1 millisecond'
      WHERE signature='monotone'`), { code: '23514' });
    await pool.query(`UPDATE chain_transaction_inbox SET updated_at=updated_at
      WHERE signature='monotone'`);
  });
});

void test('053 fails closed on column, check, function, trigger and index drift', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough053(pool);
    const sql = await readFile(migrationUrl, 'utf8');
    const driftCases = [
      `ALTER TABLE chain_transaction_inbox ALTER COLUMN worker_admitted_at SET DEFAULT clock_timestamp()`,
      `ALTER TABLE chain_transaction_inbox
       DROP CONSTRAINT chain_transaction_inbox_worker_admission_check,
       ADD CONSTRAINT chain_transaction_inbox_worker_admission_check CHECK (TRUE)`,
      `CREATE OR REPLACE FUNCTION transaction_inbox_worker_admission_guard()
       RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
      `ALTER TABLE chain_transaction_inbox
       DISABLE TRIGGER chain_transaction_inbox_worker_admission_guard`,
      `DROP INDEX chain_transaction_inbox_worker_admitted_claim_idx;
       CREATE INDEX chain_transaction_inbox_worker_admitted_claim_idx
       ON chain_transaction_inbox (signature)`,
      `DROP INDEX chain_transaction_inbox_worker_classification_pending_idx;
       CREATE INDEX chain_transaction_inbox_worker_classification_pending_idx
       ON chain_transaction_inbox (signature)`,
    ];
    for (const drift of driftCases) {
      await pool.query('BEGIN');
      try {
        await pool.query(drift);
        await assert.rejects(pool.query(sql), /incompatible/iu, drift);
      } finally {
        await pool.query('ROLLBACK');
      }
    }
  });
});

void test('053 preparatory indexes serve admitted claims and pending classification', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough053(pool);
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature,observed_slot,discovery_sources,program_ids,target_confirmation_status,
      processing_status,observed_at,ingestion_priority,worker_admitted_at
    ) SELECT 'admitted-'||series,series,ARRAY['WEBSOCKET'],ARRAY[$1],
      'confirmed','PENDING',clock_timestamp(),'NORMAL',clock_timestamp()
      FROM generate_series(1,2000) series`, [pumpProgram]);
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature,observed_slot,discovery_sources,program_ids,target_confirmation_status,
      processing_status,observed_at,ingestion_priority,worker_admitted_at
    ) SELECT 'classification-'||series,series+3000,ARRAY['WEBSOCKET'],ARRAY[$1],
      'confirmed','PENDING',clock_timestamp(),'NORMAL',NULL
      FROM generate_series(1,2000) series`, [pumpProgram]);
    await pool.query('ANALYZE chain_transaction_inbox');
    await pool.query('SET LOCAL enable_seqscan=off');
    const admittedExplain = JSON.stringify((await pool.query(`EXPLAIN (FORMAT JSON)
      SELECT signature FROM chain_transaction_inbox
      WHERE ingestion_priority='NORMAL' AND worker_admitted_at IS NOT NULL
        AND (processing_status='PENDING' OR processing_status='PROCESSING'
          OR (processing_status='FAILED' AND error_retryable=TRUE AND retry_exhausted_at IS NULL))
      ORDER BY observed_slot,signature LIMIT 1`)).rows);
    assert.match(admittedExplain, /chain_transaction_inbox_worker_admitted_claim_idx/u);
    assert.doesNotMatch(admittedExplain, /"Node Type":"(?:Incremental )?Sort"/u);
    const pendingExplain = JSON.stringify((await pool.query(`EXPLAIN (FORMAT JSON)
      SELECT signature FROM chain_transaction_inbox
      WHERE processing_status='PENDING' AND worker_admitted_at IS NULL
      ORDER BY observed_at,observed_slot,signature LIMIT 1`)).rows);
    assert.match(pendingExplain, /chain_transaction_inbox_worker_classification_pending_idx/u);
    assert.doesNotMatch(pendingExplain, /"Node Type":"(?:Incremental )?Sort"/u);
  });
});

async function assertCatalog(pool: pg.Pool): Promise<void> {
  assert.deepEqual((await pool.query(`SELECT attname,format_type(atttypid,atttypmod) AS type,
    attnotnull,pg_get_expr(adbin,adrelid) AS default_value
    FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid=attrelid AND adnum=attnum
    WHERE attrelid='chain_transaction_inbox'::REGCLASS AND attname='worker_admitted_at'`)).rows, [{
    attname: 'worker_admitted_at', type: 'timestamp with time zone', attnotnull: false,
    default_value: null,
  }]);
  assert.deepEqual((await pool.query(`SELECT convalidated FROM pg_constraint
    WHERE conrelid='chain_transaction_inbox'::REGCLASS
      AND conname='chain_transaction_inbox_worker_admission_check'`)).rows,
  [{ convalidated: true }]);
  assert.deepEqual((await pool.query(`SELECT trigger_row.tgenabled
    FROM pg_trigger trigger_row WHERE trigger_row.tgrelid='chain_transaction_inbox'::REGCLASS
      AND trigger_row.tgname='chain_transaction_inbox_worker_admission_guard'
      AND NOT trigger_row.tgisinternal`)).rows, [{ tgenabled: 'O' }]);
  assert.deepEqual((await pool.query(`SELECT indexname FROM pg_indexes
    WHERE schemaname=current_schema() AND indexname IN (
      'chain_transaction_inbox_worker_admitted_claim_idx',
      'chain_transaction_inbox_worker_classification_pending_idx') ORDER BY indexname`)).rows, [
    { indexname: 'chain_transaction_inbox_worker_admitted_claim_idx' },
    { indexname: 'chain_transaction_inbox_worker_classification_pending_idx' },
  ]);
}

async function objectIdentities(pool: pg.Pool): Promise<readonly unknown[]> {
  return (await pool.query<Readonly<{ kind: string; oid: number }>>(`SELECT 'column' AS kind,attnum::OID AS oid
      FROM pg_attribute WHERE attrelid='chain_transaction_inbox'::REGCLASS
        AND attname='worker_admitted_at' AND NOT attisdropped
    UNION ALL SELECT 'constraint',oid FROM pg_constraint
      WHERE conrelid='chain_transaction_inbox'::REGCLASS
        AND conname='chain_transaction_inbox_worker_admission_check'
    UNION ALL SELECT 'function',oid FROM pg_proc
      WHERE pronamespace=current_schema()::REGNAMESPACE
        AND proname='transaction_inbox_worker_admission_guard'
    UNION ALL SELECT 'trigger',oid FROM pg_trigger
      WHERE tgrelid='chain_transaction_inbox'::REGCLASS
        AND tgname='chain_transaction_inbox_worker_admission_guard'
    UNION ALL SELECT 'index',relation.oid FROM pg_class relation
      WHERE relation.relnamespace=current_schema()::REGNAMESPACE
        AND relation.relname IN ('chain_transaction_inbox_worker_admitted_claim_idx',
          'chain_transaction_inbox_worker_classification_pending_idx')
    ORDER BY kind,oid`)).rows;
}

async function insertLegacyRows(pool: pg.Pool): Promise<void> {
  await insertInbox(pool, { signature: 'a-pending' });
  await insertInbox(pool, { signature: 'b-processing', processing_status: 'PROCESSING',
    attempts: 1, attempts_in_cycle: 1, lease_token: 'lease',
    lease_expires_at: '2026-09-25T10:01:00.000Z' });
  await insertInbox(pool, { signature: 'c-processed', processing_status: 'PROCESSED',
    attempts: 1, attempts_in_cycle: 1, normalized_transaction: {},
    immutable_fingerprint: 'b'.repeat(64), processed_at: terminalAt });
  await insertInbox(pool, { signature: 'd-failed', processing_status: 'FAILED',
    attempts: 1, attempts_in_cycle: 1, error_code: 'RPC_TRANSIENT', error_name: 'RpcFailure',
    error_retryable: false, terminal_at: terminalAt, purge_after: purgeAfter });
  await insertInbox(pool, { signature: 'e-deferred', processing_status: 'DEFERRED',
    ingestion_hint: 'PUMPFUN_TRADE', ingestion_hint_mint: '11111111111111111111111111111111',
    terminal_at: terminalAt, purge_after: purgeAfter });
  for (const [signature, disposition, reason] of [
    ['f-ignored', 'IGNORED', 'NO_SUPPORTED_PUMP_ACTION'],
    ['g-quarantined', 'QUARANTINED', 'PUMP_SCHEMA_UNSUPPORTED'],
  ] as const) {
    await insertInbox(pool, {
      signature, discovery_sources: ['CATCH_UP'], processing_status: disposition,
      terminal_at: terminalAt, purge_after: purgeAfter,
      catch_up_classification_version: 1, catch_up_disposition: disposition,
      catch_up_reason_code: reason, catch_up_action_key: 'NONE', catch_up_mints: [],
      catch_up_evidence_fingerprint: 'c'.repeat(64), catch_up_classified_at: terminalAt,
      catch_up_enqueued: false, catch_up_admission_priority: null,
    });
  }
}

async function insertInbox(pool: pg.Pool, overrides: Readonly<Record<string, unknown>>): Promise<void> {
  const row: Readonly<Record<string, unknown>> = {
    signature: randomUUID(), observed_slot: 1, discovery_sources: ['WEBSOCKET'],
    program_ids: [pumpProgram], target_confirmation_status: 'confirmed',
    processing_status: 'PENDING', observed_at: observedAt, ...overrides,
  };
  const columns = Object.keys(row);
  await pool.query(`INSERT INTO chain_transaction_inbox (${columns.join(',')})
    VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(row));
}

async function applyThrough052(pool: pg.Pool): Promise<void> {
  for (const name of (await readdir(migrationsUrl))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name) && name < migrationName).sort()) {
    await pool.query(await readFile(new URL(name, migrationsUrl), 'utf8'));
  }
}

async function applyThrough053(pool: pg.Pool): Promise<void> {
  await applyThrough052(pool);
  await pool.query(await readFile(migrationUrl, 'utf8'));
}

async function withDatabase(context: TestContext, run: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: worker admission migration PostgreSQL 16 tests skipped');
    return;
  }
  const schema = `worker_admission_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({ connectionString: databaseUrl,
    options: `-c search_path=${schema}`, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const version = await pool.query(
      "SELECT current_setting('server_version_num')::INTEGER / 10000 AS major",
    );
    assert.equal(version.rows[0]?.major, 16);
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
