import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';

const migrationsDirectory = new URL('../migrations/', import.meta.url);
const migrationName = '051_transaction_inbox_decoder_quarantine_recovery.sql';
const migrationUrl = new URL(migrationName, migrationsDirectory);
const pumpProgram = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const quarantinedAt = '2026-09-20T10:00:00.123Z';
const recoveredAt = '2026-09-20T10:01:00.456Z';
const purgeAfter = '2026-09-20T14:01:00.456Z';

void test('051 declares a bounded standalone decoder recovery receipt', async () => {
  const sql = await migrationSql();
  for (const fragment of [
    'CREATE TABLE transaction_inbox_decoder_recoveries',
    'quarantine_kind TEXT NOT NULL',
    'worker_reason_code TEXT NOT NULL',
    'snapshot_fingerprint TEXT NOT NULL',
    'quarantined_at TIMESTAMPTZ NOT NULL',
    'recovered_at TIMESTAMPTZ NOT NULL',
    'recovery_source TEXT NOT NULL',
    'purge_after TIMESTAMPTZ NOT NULL',
    'PRIMARY KEY (signature, quarantined_at)',
    'transaction_inbox_decoder_recoveries_purge_idx',
    'decoder_quarantine_eligible_at TIMESTAMPTZ',
    'decoder_recovery_used BOOLEAN NOT NULL DEFAULT FALSE',
    'chain_transaction_inbox_decoder_quarantine_eligibility_check',
    'chain_transaction_inbox_decoder_quarantine_drift_trigger',
  ]) assert.ok(sql.includes(fragment), `missing migration fragment: ${fragment}`);
  assert.match(sql, /quarantine_kind='WORKER_SNAPSHOT'/u);
  assert.match(sql, /worker_reason_code IN \('PUMP_SCHEMA_UNSUPPORTED','PUMP_BORSH_TRUNCATED'\)/u);
  assert.match(sql, /snapshot_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/u);
  assert.match(sql, /purge_after=recovered_at\+INTERVAL '4 hours'/u);
  assert.doesNotMatch(sql, /REFERENCES\s+chain_transaction_inbox/iu);
  assert.doesNotMatch(sql, /ALTER TABLE\s+listener_strict_catch_up_runs/iu);
  assert.doesNotMatch(sql, /reltablespace/u,
    'temporary canonical indexes must not constrain permanent physical placement');
});

void test('051 installs over 001-050, replays, and enforces the exact receipt schema', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough050(pool);
    const sql = await migrationSql();
    await pool.query(sql);
    const firstSnapshot = await receiptSchemaSnapshot(pool);
    await pool.query(sql);
    assert.deepEqual(await receiptSchemaSnapshot(pool), firstSnapshot);

    assert.deepEqual((await pool.query(`SELECT column_name,data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='transaction_inbox_decoder_recoveries'
      ORDER BY ordinal_position`)).rows, [
      { column_name: 'signature', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'quarantine_kind', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'worker_reason_code', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'snapshot_fingerprint', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'quarantined_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: null },
      { column_name: 'recovered_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: null },
      { column_name: 'recovery_source', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'purge_after', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: null },
    ]);
    const constraints = await pool.query<{ constraint_name: string; constraint_type: string }>(
      `SELECT conname AS constraint_name,contype AS constraint_type FROM pg_constraint
       WHERE conrelid='transaction_inbox_decoder_recoveries'::REGCLASS ORDER BY conname`,
    );
    assert.deepEqual(constraints.rows, [
      { constraint_name: 'transaction_inbox_decoder_recoveries_evidence_check', constraint_type: 'c' },
      { constraint_name: 'transaction_inbox_decoder_recoveries_pkey', constraint_type: 'p' },
      { constraint_name: 'transaction_inbox_decoder_recoveries_retention_check', constraint_type: 'c' },
    ]);
    assert.equal((await pool.query(`SELECT COUNT(*) AS count FROM pg_constraint
      WHERE conrelid='transaction_inbox_decoder_recoveries'::REGCLASS AND contype='f'`)).rows[0]?.count, '0');

    for (const [index, reason] of ['PUMP_SCHEMA_UNSUPPORTED', 'PUMP_BORSH_TRUNCATED'].entries()) {
      await insertReceipt(pool, { signature: `valid-${index}`, worker_reason_code: reason });
    }
    const retained = await pool.query(`SELECT signature,
      isfinite(quarantined_at) AND date_trunc('milliseconds',quarantined_at)=quarantined_at AS quarantine_time_valid,
      isfinite(recovered_at) AND date_trunc('milliseconds',recovered_at)=recovered_at AS recovery_time_valid,
      isfinite(purge_after) AND date_trunc('milliseconds',purge_after)=purge_after AS purge_time_valid,
      recovered_at>=quarantined_at AS ordered,
      purge_after=recovered_at+INTERVAL '4 hours' AS retained
      FROM transaction_inbox_decoder_recoveries ORDER BY signature`);
    assert.deepEqual(retained.rows, [
      { signature: 'valid-0', quarantine_time_valid: true, recovery_time_valid: true,
        purge_time_valid: true, ordered: true, retained: true },
      { signature: 'valid-1', quarantine_time_valid: true, recovery_time_valid: true,
        purge_time_valid: true, ordered: true, retained: true },
    ]);
  });
});

void test('051 rejects invalid or unbounded decoder recovery evidence', async (context) => {
  await withInstalledMigration(context, async (pool) => {
    const invalid: readonly Readonly<Record<string, unknown>>[] = [
      { signature: '' },
      { signature: 'x'.repeat(129) },
      { quarantine_kind: 'CATCH_UP_CLASSIFICATION' },
      { worker_reason_code: 'PUMP_BORSH_INVALID' },
      { worker_reason_code: 'x'.repeat(65) },
      { snapshot_fingerprint: 'A'.repeat(64) },
      { snapshot_fingerprint: 'a'.repeat(63) },
      { quarantined_at: 'infinity' },
      { quarantined_at: '2026-09-20T10:00:00.123456Z' },
      { recovered_at: '2026-09-20T09:59:59.999Z' },
      { recovered_at: 'infinity' },
      { recovered_at: '2026-09-20T10:01:00.456789Z' },
      { recovery_source: 'REMOTE_API' },
      { purge_after: '2026-09-20T14:01:00.455Z' },
      { purge_after: 'infinity' },
    ];
    for (const patch of invalid) {
      await assert.rejects(insertReceipt(pool, { signature: randomUUID(), ...patch }),
        (error: unknown) => error instanceof pg.DatabaseError
          && ['23514', '23502'].includes(error.code ?? ''), JSON.stringify(patch));
    }
  });
});

void test('051 rejects partial, weakened, and index-incompatible installations transactionally', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough050(pool);
    await pool.query('CREATE TABLE transaction_inbox_decoder_recoveries (signature TEXT NOT NULL)');
    await assert.rejects(pool.query(await migrationSql()), { code: '23514' });
    assert.deepEqual((await pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='transaction_inbox_decoder_recoveries'
      ORDER BY ordinal_position`)).rows, [{ column_name: 'signature' }]);
  });

  for (const mutation of [
    `ALTER TABLE transaction_inbox_decoder_recoveries
       DROP CONSTRAINT transaction_inbox_decoder_recoveries_evidence_check,
       ADD CONSTRAINT transaction_inbox_decoder_recoveries_evidence_check CHECK (TRUE)`,
    `ALTER TABLE transaction_inbox_decoder_recoveries
       ALTER COLUMN signature SET DEFAULT 'unexpected'`,
    `DROP INDEX transaction_inbox_decoder_recoveries_purge_idx;
     CREATE INDEX transaction_inbox_decoder_recoveries_purge_idx
       ON transaction_inbox_decoder_recoveries (recovered_at, signature)`,
  ]) {
    await withInstalledMigration(context, async (pool) => {
      await pool.query(mutation);
      await assert.rejects(pool.query(await migrationSql()), { code: '23514' });
    });
  }
});

void test('051 rejects reordered columns and primary-key index drift', async (context) => {
  await withInstalledMigration(context, async (pool) => {
    await pool.query(`DO $reorder$
      DECLARE primary_definition TEXT; evidence_definition TEXT; retention_definition TEXT;
      BEGIN
        SELECT pg_get_constraintdef(oid) INTO primary_definition FROM pg_constraint
          WHERE conrelid='transaction_inbox_decoder_recoveries'::REGCLASS
            AND conname='transaction_inbox_decoder_recoveries_pkey';
        SELECT pg_get_constraintdef(oid) INTO evidence_definition FROM pg_constraint
          WHERE conrelid='transaction_inbox_decoder_recoveries'::REGCLASS
            AND conname='transaction_inbox_decoder_recoveries_evidence_check';
        SELECT pg_get_constraintdef(oid) INTO retention_definition FROM pg_constraint
          WHERE conrelid='transaction_inbox_decoder_recoveries'::REGCLASS
            AND conname='transaction_inbox_decoder_recoveries_retention_check';
        ALTER TABLE transaction_inbox_decoder_recoveries RENAME TO decoder_recoveries_source;
        CREATE TABLE transaction_inbox_decoder_recoveries AS SELECT
          quarantine_kind,signature,worker_reason_code,snapshot_fingerprint,
          quarantined_at,recovered_at,recovery_source,purge_after
          FROM decoder_recoveries_source WITH NO DATA;
        DROP TABLE decoder_recoveries_source;
        ALTER TABLE transaction_inbox_decoder_recoveries
          ALTER COLUMN signature SET NOT NULL,
          ALTER COLUMN quarantine_kind SET NOT NULL,
          ALTER COLUMN worker_reason_code SET NOT NULL,
          ALTER COLUMN snapshot_fingerprint SET NOT NULL,
          ALTER COLUMN quarantined_at SET NOT NULL,
          ALTER COLUMN recovered_at SET NOT NULL,
          ALTER COLUMN recovery_source SET NOT NULL,
          ALTER COLUMN purge_after SET NOT NULL;
        EXECUTE 'ALTER TABLE transaction_inbox_decoder_recoveries ADD CONSTRAINT '
          ||'transaction_inbox_decoder_recoveries_pkey '||primary_definition;
        EXECUTE 'ALTER TABLE transaction_inbox_decoder_recoveries ADD CONSTRAINT '
          ||'transaction_inbox_decoder_recoveries_evidence_check '||evidence_definition;
        EXECUTE 'ALTER TABLE transaction_inbox_decoder_recoveries ADD CONSTRAINT '
          ||'transaction_inbox_decoder_recoveries_retention_check '||retention_definition;
        CREATE INDEX transaction_inbox_decoder_recoveries_purge_idx
          ON transaction_inbox_decoder_recoveries (purge_after,signature);
      END;
    $reorder$`);
    await assert.rejects(pool.query(await migrationSql()), { code: '23514' });
  });

  await withInstalledMigration(context, async (pool) => {
    await pool.query(`ALTER INDEX transaction_inbox_decoder_recoveries_pkey
      SET (fillfactor=70)`);
    await assert.rejects(pool.query(await migrationSql()), { code: '23514' });
  });
});

void test('051 rejects weakened eligibility constraints, functions, and triggers', async (context) => {
  for (const mutation of [
    `ALTER TABLE chain_transaction_inbox
       DROP CONSTRAINT chain_transaction_inbox_decoder_quarantine_eligibility_check,
       ADD CONSTRAINT chain_transaction_inbox_decoder_quarantine_eligibility_check CHECK (TRUE)`,
    `CREATE OR REPLACE FUNCTION transaction_inbox_decoder_quarantine_drift_guard()
       RETURNS trigger LANGUAGE plpgsql AS $drift$ BEGIN RETURN NEW; END; $drift$`,
    `ALTER TABLE chain_transaction_inbox
       DISABLE TRIGGER chain_transaction_inbox_decoder_quarantine_drift_trigger`,
  ]) {
    await withInstalledMigration(context, async (pool) => {
      await pool.query(mutation);
      await assert.rejects(pool.query(await migrationSql()), { code: '23514' });
    });
  }
});

void test('051 leaves pristine catch-up quarantine state and 049 constraints unchanged', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough050(pool);
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature,observed_slot,discovery_sources,program_ids,target_confirmation_status,
      processing_status,observed_at,ingestion_hint,catch_up_classification_version,
      catch_up_disposition,catch_up_reason_code,catch_up_action_key,catch_up_mints,
      catch_up_evidence_fingerprint,catch_up_classified_at,catch_up_enqueued,
      terminal_at,purge_after
    ) VALUES ('catch-up-quarantine',1,ARRAY['CATCH_UP'],ARRAY[$1],'confirmed',
      'QUARANTINED',$2,'NONE',1,'QUARANTINED','PUMP_SCHEMA_UNSUPPORTED','NONE',ARRAY[]::TEXT[],
      repeat('c',64),$2,FALSE,$2,$2::TIMESTAMPTZ+INTERVAL '4 hours')`, [pumpProgram, quarantinedAt]);
    const before = (await pool.query(`SELECT * FROM chain_transaction_inbox
      WHERE signature='catch-up-quarantine'`)).rows[0];
    const constraintBefore = await catchUpConstraintSnapshot(pool);
    const columnsBefore = await inboxColumnSnapshot(pool);

    const sql = await migrationSql();
    await pool.query(sql);
    await pool.query(sql);

    const after = (await pool.query(`SELECT * FROM chain_transaction_inbox
      WHERE signature='catch-up-quarantine'`)).rows[0];
    const {
      decoder_quarantine_eligible_at: eligibility,
      decoder_recovery_used: recovered,
      ...unchanged
    } = after;
    assert.equal(eligibility, null);
    assert.equal(recovered, false);
    assert.deepEqual(unchanged, before);
    assert.deepEqual(await catchUpConstraintSnapshot(pool), constraintBefore);
    const columnsAfter = await inboxColumnSnapshot(pool);
    assert.deepEqual(columnsAfter.slice(0, -2), columnsBefore);
    assert.deepEqual(columnsAfter.slice(-2), [
      {
        column_name: 'decoder_quarantine_eligible_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'decoder_recovery_used',
        data_type: 'boolean',
        is_nullable: 'NO',
        column_default: 'false',
      },
    ]);
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM transaction_inbox_decoder_recoveries')).rows[0]?.count, '0');
    assert.equal(before?.normalized_transaction, null);
    assert.equal(before?.immutable_fingerprint, null);
    assert.equal(before?.catch_up_evidence_fingerprint, 'c'.repeat(64));
  });
});

async function migrationSql(): Promise<string> {
  const sql = await readFile(migrationUrl, 'utf8').catch(() => '');
  assert.notEqual(sql, '', 'migration 051 must exist');
  return sql;
}

async function applyThrough050(pool: pg.Pool): Promise<void> {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name) && name < migrationName).sort();
  assert.equal(names.length, 50);
  assert.equal(names.at(-1), '050_transaction_inbox_first_processing.sql');
  for (const name of names) await pool.query(await readFile(new URL(name, migrationsDirectory), 'utf8'));
}

async function withInstalledMigration(
  context: TestContext,
  run: (pool: pg.Pool) => Promise<void>,
): Promise<void> {
  await withDatabase(context, async (pool) => {
    await applyThrough050(pool);
    await pool.query(await migrationSql());
    await run(pool);
  });
}

async function insertReceipt(
  pool: pg.Pool,
  overrides: Readonly<Record<string, unknown>>,
): Promise<void> {
  const row: Readonly<Record<string, unknown>> = {
    signature: 'signature', quarantine_kind: 'WORKER_SNAPSHOT',
    worker_reason_code: 'PUMP_SCHEMA_UNSUPPORTED', snapshot_fingerprint: 'a'.repeat(64),
    quarantined_at: quarantinedAt, recovered_at: recoveredAt,
    recovery_source: 'LOCAL_CLI', purge_after: purgeAfter, ...overrides,
  };
  const columns = Object.keys(row);
  await pool.query(`INSERT INTO transaction_inbox_decoder_recoveries (${columns.join(',')})
    VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(row));
}

async function receiptSchemaSnapshot(pool: pg.Pool): Promise<readonly unknown[]> {
  return (await pool.query<Readonly<Record<string, unknown>>>(`SELECT 'column' AS kind,column_name AS name,
      data_type||':'||is_nullable||':'||COALESCE(column_default,'') AS definition
    FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='transaction_inbox_decoder_recoveries'
    UNION ALL
    SELECT 'constraint',conname,pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid='transaction_inbox_decoder_recoveries'::REGCLASS
    UNION ALL
    SELECT 'index',indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema()
      AND tablename='transaction_inbox_decoder_recoveries'
    ORDER BY kind,name`)).rows;
}

async function catchUpConstraintSnapshot(pool: pg.Pool): Promise<readonly unknown[]> {
  return (await pool.query<Readonly<Record<string, unknown>>>(`SELECT relation.relname AS relation_name,constraint_row.conname,
      pg_get_constraintdef(constraint_row.oid) AS definition
    FROM pg_constraint constraint_row JOIN pg_class relation ON relation.oid=constraint_row.conrelid
    WHERE (relation.oid='chain_transaction_inbox'::REGCLASS AND constraint_row.conname IN (
      'chain_transaction_inbox_catch_up_classification_check',
      'chain_transaction_inbox_catch_up_terminal_check'))
      OR (relation.oid='listener_strict_catch_up_runs'::REGCLASS
        AND constraint_row.conname='listener_strict_catch_up_runs_cursor_order_check')
    ORDER BY relation_name,conname`)).rows;
}

async function inboxColumnSnapshot(pool: pg.Pool): Promise<readonly unknown[]> {
  return (await pool.query<Readonly<Record<string, unknown>>>(`SELECT column_name,data_type,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='chain_transaction_inbox' ORDER BY ordinal_position`)).rows;
}

async function withDatabase(
  context: TestContext,
  run: (pool: pg.Pool) => Promise<void>,
): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: decoder quarantine migration PG16 tests skipped');
    return;
  }
  const schema = `decoder_quarantine_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl,
    options: `-c search_path=${schema}`, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const version = await pool.query("SELECT current_setting('server_version_num')::INTEGER / 10000 AS major");
    assert.equal(version.rows[0]?.major, 16);
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}
