import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationsDirectory = new URL('../migrations/', import.meta.url);
const migrationName = '045_execution_wallet_snapshot_refresh.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);
const priorMigrationName = '044_transaction_inbox_launch_priority.sql';
const riskMigrationName = '034_execution_risk_reconciliation.sql';
type SnapshotState = Readonly<{
  readonly snapshot_id: string;
  readonly state_revision: string;
  readonly superseded_at: string | null;
  readonly purge_after: string | null;
}>;

void test('migration 045 replaces historical wallet revision uniqueness with one current snapshot', async () => {
  const sql = withoutSqlComments(await readFile(migrationUrl, 'utf8'));

  assert.match(sql, /HAVING COUNT\(\*\) > 1/u);
  assert.match(sql, /RAISE EXCEPTION 'execution wallet snapshot migration requires at most one current snapshot per generation'/u);
  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE superseded_at IS NULL\)[\s\S]*AS current_count/u);
  assert.match(sql, /MAX\(state_revision\) OVER \(PARTITION BY generation_id\) AS maximum_state_revision/u);
  assert.match(sql, /MAX\(observed_at\) OVER \(PARTITION BY generation_id\) AS maximum_observed_at/u);
  assert.match(sql, /requires exactly one current snapshot matching historical frontier per generation/u);
  assert.match(sql, /ALTER TABLE execution_wallet_snapshots\s+DROP CONSTRAINT IF EXISTS execution_wallet_snapshots_generation_revision_unique/u);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS execution_wallet_snapshots_current_generation_unique\s+ON execution_wallet_snapshots \(generation_id\)\s+WHERE superseded_at IS NULL/u);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS execution_wallet_snapshots_generation_refresh_order_idx\s+ON execution_wallet_snapshots \(generation_id,state_revision DESC,observed_at DESC,snapshot_id DESC\)/u);
});

void test('migration 045 applies on an empty schema and replays through the migrator and directly', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;

  await withTemporarySchema(databaseUrl, 'execution_wallet_snapshot_refresh_empty', async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), '047_transaction_inbox_tracked_trade_priority.sql');
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await pool.query(await readFile(migrationUrl, 'utf8'));
    await assertSnapshotIndexes(pool);
  });
});

void test('migration 045 upgrades 044 so a superseded same-revision snapshot can be refreshed', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;

  await withTemporarySchema(databaseUrl, 'execution_wallet_snapshot_refresh_upgrade', async (pool) => {
    await applyMigrationsThrough(pool, priorMigrationName);
    const generationId = await insertGeneration(pool, 'a');
    await insertSnapshot(pool, generationId, 'a', 0, null);

    assert.deepEqual(await migrateDatabase({ pool }), [
      migrationName, '046_listener_strict_catch_up_runs.sql',
      '047_transaction_inbox_tracked_trade_priority.sql',
    ]);
    await assertSnapshotIndexes(pool);

    await pool.query(`UPDATE execution_wallet_snapshots
      SET superseded_at='2026-01-01T00:00:01.000Z',
          purge_after='2026-01-01T04:00:01.000Z'
      WHERE snapshot_id=$1`, [snapshotId('a')]);
    await insertSnapshot(pool, generationId, 'b', 0, null);
    await assert.rejects(
      () => insertSnapshot(pool, generationId, 'c', 1, null),
      (error: unknown) => isPostgresError(error, '23505'),
    );
    assert.deepEqual((await pool.query(`SELECT snapshot_id,state_revision::TEXT AS state_revision,
      superseded_at IS NULL AS current FROM execution_wallet_snapshots ORDER BY snapshot_id`)).rows, [
      { snapshot_id: snapshotId('a'), state_revision: '0', current: false },
      { snapshot_id: snapshotId('b'), state_revision: '0', current: true },
    ]);
  });
});

void test('migration 045 refuses legacy multi-current drift without mutating the snapshots', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  const sql = await readFile(migrationUrl, 'utf8');

  await withTemporarySchema(databaseUrl, 'execution_wallet_snapshot_refresh_drift', async (pool) => {
    await applyMigrationsThrough(pool, riskMigrationName);
    const generationId = await insertGeneration(pool, 'd');
    await insertSnapshot(pool, generationId, 'd', 0, null);
    await insertSnapshot(pool, generationId, 'e', 1, null);
    const before = await currentSnapshots(pool);

    await assert.rejects(
      () => pool.query(sql),
      /at most one current snapshot per generation/u,
    );
    assert.deepEqual(await currentSnapshots(pool), before);
    assert.equal(await hasConstraint(pool, 'execution_wallet_snapshots_generation_revision_unique'), true);
  });
});

void test('migration 045 refuses legacy zero-current drift without mutating the snapshots', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;

  await withTemporarySchema(databaseUrl, 'execution_wallet_snapshot_refresh_zero_current', async (pool) => {
    await applyMigrationsThrough(pool, priorMigrationName);
    const generationId = await insertGeneration(pool, 'b');
    await insertSnapshot(pool, generationId, 'b', 0, '2026-01-01T00:00:01.000Z');
    const before = await currentSnapshots(pool);

    await assert.rejects(
      () => migrateDatabase({ pool }),
      /exactly one current snapshot matching historical frontier/u,
    );
    assert.deepEqual(await currentSnapshots(pool), before);
    assert.equal(await hasConstraint(pool, 'execution_wallet_snapshots_generation_revision_unique'), true);
  });
});

void test('migration 045 refuses a legacy current snapshot behind its historical frontier', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;

  await withTemporarySchema(databaseUrl, 'execution_wallet_snapshot_refresh_stale_current', async (pool) => {
    await applyMigrationsThrough(pool, priorMigrationName);
    const generationId = await insertGeneration(pool, 'c');
    await insertSnapshot(pool, generationId, 'c', 0, null);
    await insertSnapshot(pool, generationId, 'd', 1, '2026-01-01T00:00:01.000Z');
    const before = await currentSnapshots(pool);

    await assert.rejects(
      () => migrateDatabase({ pool }),
      /exactly one current snapshot matching historical frontier/u,
    );
    assert.deepEqual(await currentSnapshots(pool), before);
    assert.equal(await hasConstraint(pool, 'execution_wallet_snapshots_generation_revision_unique'), true);
  });
});

void test('migration 045 refuses a legacy current snapshot behind the historical observed frontier', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;

  await withTemporarySchema(databaseUrl, 'execution_wallet_snapshot_refresh_observed_drift', async (pool) => {
    await applyMigrationsThrough(pool, priorMigrationName);
    const generationId = await insertGeneration(pool, 'e');
    await insertSnapshot(pool, generationId, 'e', 0, '2026-01-02T00:00:01.000Z',
      '2026-01-02T00:00:00.000Z');
    await insertSnapshot(pool, generationId, 'f', 1, null);
    const before = await currentSnapshots(pool);

    await assert.rejects(
      () => migrateDatabase({ pool }),
      /exactly one current snapshot matching historical frontier/u,
    );
    assert.deepEqual(await currentSnapshots(pool), before);
    assert.equal(await hasConstraint(pool, 'execution_wallet_snapshots_generation_revision_unique'), true);
  });
});

void test('migration 045 refuses incompatible named target indexes before dropping historical uniqueness', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;

  for (const [label, indexSql] of [
    ['current', `CREATE INDEX execution_wallet_snapshots_current_generation_unique
      ON execution_wallet_snapshots (generation_id)`],
    ['order', `CREATE INDEX execution_wallet_snapshots_generation_refresh_order_idx
      ON execution_wallet_snapshots (generation_id,observed_at DESC)`],
  ] as const) {
    await withTemporarySchema(databaseUrl, `execution_wallet_snapshot_refresh_${label}_collision`, async (pool) => {
      await applyMigrationsThrough(pool, priorMigrationName);
      const suffix = label === 'current' ? 'f' : 'e';
      const generationId = await insertGeneration(pool, suffix);
      await insertSnapshot(pool, generationId, suffix, 0, null);
      await pool.query(indexSql);
      const before = await currentSnapshots(pool);

      await assert.rejects(
        () => migrateDatabase({ pool }),
        /execution wallet snapshot target index definition is incompatible/u,
      );
      assert.deepEqual(await currentSnapshots(pool), before);
      assert.equal(await hasConstraint(pool, 'execution_wallet_snapshots_generation_revision_unique'), true);
    });
  }
});

async function assertSnapshotIndexes(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  assert.equal(await hasConstraint(pool, 'execution_wallet_snapshots_generation_revision_unique'), false);
  const schemaName = await currentSchemaName(pool);
  const indexes = await pool.query<{ readonly indexname: string; readonly indexdef: string }>(`
    SELECT indexname,indexdef FROM pg_indexes
    WHERE schemaname=CURRENT_SCHEMA() AND tablename='execution_wallet_snapshots'
      AND indexname IN (
        'execution_wallet_snapshots_current_generation_unique',
        'execution_wallet_snapshots_generation_refresh_order_idx'
      ) ORDER BY indexname`);
  assert.deepEqual(indexes.rows, [
    {
      indexname: 'execution_wallet_snapshots_current_generation_unique',
      indexdef: `CREATE UNIQUE INDEX execution_wallet_snapshots_current_generation_unique ON ${schemaName}.execution_wallet_snapshots USING btree (generation_id) WHERE (superseded_at IS NULL)`,
    },
    {
      indexname: 'execution_wallet_snapshots_generation_refresh_order_idx',
      indexdef: `CREATE INDEX execution_wallet_snapshots_generation_refresh_order_idx ON ${schemaName}.execution_wallet_snapshots USING btree (generation_id, state_revision DESC, observed_at DESC, snapshot_id DESC)`,
    },
  ]);
}

async function currentSchemaName(pool: InstanceType<typeof pg.Pool>): Promise<string> {
  const result = await pool.query<{ readonly schema: string }>('SELECT current_schema() AS schema');
  return result.rows[0]?.schema ?? '';
}

async function hasConstraint(pool: InstanceType<typeof pg.Pool>, name: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM pg_constraint
    WHERE conrelid='execution_wallet_snapshots'::REGCLASS AND conname=$1`, [name]);
  return result.rowCount === 1;
}

async function currentSnapshots(pool: InstanceType<typeof pg.Pool>): Promise<readonly SnapshotState[]> {
  return (await pool.query<SnapshotState>(`SELECT snapshot_id,state_revision::TEXT AS state_revision,
    superseded_at::TEXT AS superseded_at,purge_after::TEXT AS purge_after
    FROM execution_wallet_snapshots ORDER BY snapshot_id`)).rows;
}

async function applyMigrationsThrough(pool: InstanceType<typeof pg.Pool>, endName: string): Promise<void> {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name) && name <= endName)
    .sort((left, right) => left.localeCompare(right));
  assert.equal(names.at(-1), endName);
  for (const name of names) {
    await pool.query(await readFile(new URL(name, migrationsDirectory), 'utf8'));
    await pool.query('INSERT INTO migration_history(version) VALUES ($1)', [name]);
  }
}

async function insertGeneration(pool: InstanceType<typeof pg.Pool>, suffix: string): Promise<string> {
  const generationId = `execution_wallet_generation_${suffix.repeat(64)}`;
  await pool.query(`INSERT INTO execution_wallet_generations (
    generation_id,wallet_public_key,cluster,genesis_hash,generation
  ) VALUES ($1,'11111111111111111111111111111111','mainnet-beta',$2,1)`, [
    generationId, '2'.repeat(32),
  ]);
  return generationId;
}

async function insertSnapshot(
  pool: InstanceType<typeof pg.Pool>, generationId: string, suffix: string,
  revision: number, supersededAt: string | null, observedAt = '2026-01-01T00:00:00.000Z',
): Promise<void> {
  await pool.query(`INSERT INTO execution_wallet_snapshots (
    snapshot_id,snapshot_fingerprint,generation_id,provider_id,state_revision,slot,observed_at,
    commitment,wallet_lamports,token_balance_count,open_positions,realized_net_pnl_raw,
    superseded_at,purge_after
  ) VALUES ($1,$2,$3,'provider',$4,$5,$7::TIMESTAMPTZ,
    'finalized',1,0,0,0,$6,
    CASE WHEN $6::TIMESTAMPTZ IS NULL THEN NULL ELSE $6::TIMESTAMPTZ + INTERVAL '4 hours' END)`, [
    snapshotId(suffix), suffix.repeat(64), generationId, revision, revision, supersededAt, observedAt,
  ]);
}

function snapshotId(suffix: string): string {
  return `execution_wallet_snapshot_${suffix.repeat(64)}`;
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === code;
}

function testDatabaseUrl(context: Readonly<{ skip(message?: string): void }>): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') return databaseUrl;
  context.skip('TEST_DATABASE_URL absent: execution wallet snapshot refresh migration test skipped');
  return null;
}

async function withTemporarySchema(
  databaseUrl: string,
  prefix: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    created = true;
    await pool.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await callback(pool);
  } finally {
    try {
      await pool.end();
    } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}

function withoutSqlComments(sql: string): string {
  return sql.replace(/--[^\r\n]*/gu, ' ').replace(/\/\*[\s\S]*?\*\//gu, ' ');
}
