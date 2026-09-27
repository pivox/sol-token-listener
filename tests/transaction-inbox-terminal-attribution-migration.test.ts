import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';

const migrations = new URL('../migrations/', import.meta.url);
const migrationName = '057_transaction_inbox_terminal_attribution.sql';
const migrationUrl = new URL(migrationName, migrations);

void test('057 defines a restricted journal and retained parent incompleteness', async () => {
  const names = await readdir(migrations);
  assert.ok(names.includes(migrationName), 'terminal attribution migration must exist');
  const sql = await readFile(migrationUrl, 'utf8');
  for (const fragment of ['transaction_inbox_terminal_attributions',
    'terminal_attribution_incomplete_count', 'terminal_attribution_incomplete_at',
    'ON DELETE CASCADE', "INTERVAL '4 hours'", 'FROM PUBLIC']) {
    assert.ok(sql.includes(fragment), fragment);
  }
  assert.doesNotMatch(sql, /\b(?:JSONB?|FLOAT|REAL|DOUBLE PRECISION)\b/iu);
});

void test('057 empty install, 056 upgrade and immediate replay preserve identities', async (context) => {
  await withSchema(context, async (pool) => {
    await applyThrough(pool, migrationName);
    const before = await identities(pool);
    const sql = await readFile(migrationUrl, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    assert.deepEqual(await identities(pool), before);
    assert.equal((await pool.query(`SELECT has_table_privilege(
      'public','transaction_inbox_terminal_attributions','SELECT') AS allowed`)).rows[0]?.allowed, false);
    const columns = await pool.query(`SELECT column_name,data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='chain_transaction_inbox' AND column_name LIKE 'terminal_attribution_%'
      ORDER BY column_name`);
    assert.deepEqual(columns.rows, [
      { column_name: 'terminal_attribution_incomplete_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { column_name: 'terminal_attribution_incomplete_count', data_type: 'integer', is_nullable: 'NO', column_default: '0' },
    ]);
  });
  await withSchema(context, async (pool) => {
    const names = (await readdir(migrations)).filter((name) => /^\d+_.*\.sql$/u.test(name) && name < migrationName).sort();
    for (const name of names) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
      await pool.query('INSERT INTO migration_history(version) VALUES ($1)', [name]);
    }
    await pool.query(`INSERT INTO chain_transaction_inbox
      (signature,observed_slot,discovery_sources,program_ids,target_confirmation_status,observed_at)
      VALUES ('legacy',1,ARRAY['WEBSOCKET'],ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],'processed',clock_timestamp())`);
    await pool.query(await readFile(migrationUrl, 'utf8'));
    await pool.query('INSERT INTO migration_history(version) VALUES ($1)', [migrationName]);
    assert.deepEqual((await pool.query(`SELECT terminal_attribution_incomplete_count,
      terminal_attribution_incomplete_at FROM chain_transaction_inbox`)).rows,
    [{ terminal_attribution_incomplete_count: 0, terminal_attribution_incomplete_at: null }]);
    assert.equal((await pool.query('SELECT COUNT(*)::INTEGER AS count FROM transaction_inbox_terminal_attributions')).rows[0]?.count, 0);
  });
});

void test('057 rejects named object, column, constraint, index and privilege drift', async (context) => {
  await withSchema(context, async (pool) => {
    await applyThrough(pool, migrationName);
    const sql = await readFile(migrationUrl, 'utf8');
    const drifts = [
      'DROP INDEX transaction_inbox_terminal_attributions_purge_idx',
      'ALTER TABLE chain_transaction_inbox DROP COLUMN terminal_attribution_incomplete_at CASCADE',
      'ALTER TABLE chain_transaction_inbox ALTER COLUMN terminal_attribution_incomplete_count SET DEFAULT 1',
      'ALTER TABLE chain_transaction_inbox ALTER COLUMN terminal_attribution_incomplete_count DROP NOT NULL',
      'ALTER TABLE transaction_inbox_terminal_attributions ADD COLUMN raw_payload TEXT',
      'ALTER TABLE transaction_inbox_terminal_attributions ALTER COLUMN captured_at TYPE TIMESTAMPTZ(0)',
      'ALTER TABLE transaction_inbox_terminal_attributions ALTER COLUMN diagnostic_code DROP NOT NULL',
      'ALTER TABLE transaction_inbox_terminal_attributions DROP CONSTRAINT terminal_attributions_retention_check',
      `ALTER TABLE transaction_inbox_terminal_attributions DROP CONSTRAINT terminal_attributions_wire_check;
       ALTER TABLE transaction_inbox_terminal_attributions ADD CONSTRAINT terminal_attributions_wire_check CHECK (TRUE)`,
      `ALTER TABLE transaction_inbox_terminal_attributions DROP CONSTRAINT terminal_attributions_source_check;
       ALTER TABLE transaction_inbox_terminal_attributions ADD CONSTRAINT terminal_attributions_source_check CHECK (source IS NOT NULL)`,
      `ALTER TABLE transaction_inbox_terminal_attributions DROP CONSTRAINT terminal_attributions_signature_fkey;
       ALTER TABLE transaction_inbox_terminal_attributions ADD CONSTRAINT terminal_attributions_signature_fkey
       FOREIGN KEY(signature) REFERENCES chain_transaction_inbox(signature) ON DELETE RESTRICT`,
      `DROP INDEX transaction_inbox_terminal_attributions_purge_idx;
       CREATE INDEX transaction_inbox_terminal_attributions_purge_idx
       ON transaction_inbox_terminal_attributions(signature,purge_after)`,
      `UPDATE pg_index SET indisvalid=FALSE WHERE indexrelid='transaction_inbox_terminal_attributions_purge_idx'::REGCLASS`,
      'GRANT SELECT ON transaction_inbox_terminal_attributions TO PUBLIC',
      'GRANT SELECT(signature) ON transaction_inbox_terminal_attributions TO PUBLIC',
      'ALTER TABLE transaction_inbox_terminal_attributions ENABLE ROW LEVEL SECURITY',
    ];
    for (const drift of drifts) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL allow_system_table_mods=on');
        await client.query(drift);
        await assert.rejects(client.query(sql), { code: '23514' }, drift);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
  });
});

async function applyThrough(pool: pg.Pool, head: string): Promise<void> {
  const names = (await readdir(migrations))
    .filter((name) => /^\d+_.*\.sql$/u.test(name) && name <= head)
    .sort();
  for (const name of names) {
    await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    await pool.query('INSERT INTO migration_history(version) VALUES ($1)', [name]);
  }
}

async function identities(pool: pg.Pool): Promise<readonly unknown[]> {
  return (await pool.query<Record<string, unknown>>(`SELECT relname,oid FROM pg_class WHERE relnamespace=current_schema()::REGNAMESPACE
    AND relname IN ('transaction_inbox_terminal_attributions','terminal_attributions_pkey',
      'transaction_inbox_terminal_attributions_purge_idx') ORDER BY relname`)).rows;
}

async function withSchema(context: TestContext, run: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) { context.skip('TEST_DATABASE_URL absent'); return; }
  const schema = `terminal_attribution_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}
