import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '046_listener_strict_catch_up_runs.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);

void test('migration 046 defines the durable strict catch-up run contract without diagnostics', async () => {
  const sql = withoutSqlComments(await readFile(migrationUrl, 'utf8'));

  assert.match(sql, /CREATE TABLE IF NOT EXISTS listener_strict_catch_up_runs/u);
  assert.match(sql, /run_id TEXT PRIMARY KEY/u);
  assert.match(sql, /checkpoint_key TEXT NOT NULL/u);
  assert.match(sql, /previous_slot NUMERIC\(78,0\) NOT NULL/u);
  assert.match(sql, /previous_updated_at TIMESTAMPTZ NOT NULL/u);
  assert.match(sql, /observed_head_slot NUMERIC\(78,0\) NOT NULL/u);
  assert.match(sql, /pages_scanned BIGINT NOT NULL/u);
  assert.match(sql, /listener_strict_catch_up_runs_id_check/u);
  assert.match(sql, /listener_strict_catch_up_runs_lifecycle_check/u);
  assert.match(sql, /\^\[\[:space:\]\]/u);
  assert.match(sql, /listener_strict_catch_up_runs_active_key_unique/u);
  assert.match(sql, /listener_strict_catch_up_runs_provider_key_idx/u);
  assert.match(sql, /listener_strict_catch_up_runs_terminal_purge_idx/u);
  assert.doesNotMatch(sql, /rpc[_ ]?url|api[_ ]?key|private[_ ]?key|raw[_ ]?log|payload/iu);
});

void test('migration 046 migrates an empty database and safely replays directly', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;

  await withTemporarySchema(databaseUrl, 'strict_catch_up_runs_empty', async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), migrationName);
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await pool.query(await readFile(migrationUrl, 'utf8'));
    await assertRunIndexes(pool);
  });
});

void test('migration 046 accepts valid active and terminal runs and rejects invalid durable state', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;

  await withTemporarySchema(databaseUrl, 'strict_catch_up_runs_constraints', async (pool) => {
    await migrateDatabase({ pool });
    await insertRun(pool, 'active');
    await insertRun(pool, 'completed', {
      checkpointKey: 'market',
      state: 'COMPLETED',
      terminalReason: null,
      completedAt: '2026-01-01T00:00:01.000Z',
      purgeAfter: '2026-01-01T04:00:01.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    });
    assert.deepEqual((await pool.query(`SELECT to_char(previous_updated_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS previous_updated_at
      FROM listener_strict_catch_up_runs WHERE checkpoint_key='launchpad'`)).rows, [
      { previous_updated_at: '2026-01-01T00:00:00.000Z' },
    ]);
    for (const values of [
      { runId: 'wrong' },
      { observedHeadSlot: '-1' },
      { lastAcceptedSlot: '12' },
      { state: 'FAILED', terminalReason: null, completedAt: '2026-01-01T00:00:01.000Z', purgeAfter: '2026-01-01T04:00:01.000Z', updatedAt: '2026-01-01T00:00:01.000Z' },
    ] as const) {
      await assert.rejects(() => insertRun(pool, randomUUID(), values), isCheckViolation);
    }
    for (const values of [
      { previousSignature: '\tprevious' },
      { observedHeadSignature: '\thead' },
      { beforeSignature: '\tbefore' },
      { beforeSignature: 'previous' },
      { beforeSignature: 'head' },
    ] as const) await assert.rejects(() => insertRun(pool, randomUUID(), values), isCheckViolation);
    await insertRun(pool, 'active_initial', {
      checkpointKey: 'market', observedHeadSlot: '11', lastAcceptedSlot: '11',
      beforeSignature: 'head',
    });
    await insertRun(pool, 'terminal_initial', {
      checkpointKey: 'market', state: 'COMPLETED', revision: '1', observedHeadSlot: '11',
      lastAcceptedSlot: '11', beforeSignature: 'head', terminalReason: null,
      completedAt: '2026-01-01T00:00:01.000Z', purgeAfter: '2026-01-01T04:00:01.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    });
  });
});

void test('migration 046 allows only one active run per checkpoint key and retains terminal rows exactly four hours', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;

  await withTemporarySchema(databaseUrl, 'strict_catch_up_runs_lifecycle', async (pool) => {
    await migrateDatabase({ pool });
    await insertRun(pool, 'active_a');
    await assert.rejects(() => insertRun(pool, 'active_b'), isUniqueViolation);
    const activeContenders = await Promise.allSettled([
      insertRun(pool, 'active_c', { checkpointKey: 'market' }),
      insertRun(pool, 'active_d', { checkpointKey: 'market' }),
    ]);
    assert.equal(activeContenders.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(activeContenders.filter((result) => result.status === 'rejected').length, 1);
    await insertRun(pool, 'failed', {
      checkpointKey: 'market', state: 'FAILED', terminalReason: 'CATCH_UP_WINDOW_EXCEEDED',
      completedAt: '2026-01-01T00:00:01.000Z', purgeAfter: '2026-01-01T04:00:01.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    });
    await assert.rejects(() => insertRun(pool, 'bad_retention', {
      checkpointKey: 'market', state: 'SUPERSEDED', terminalReason: 'CHECKPOINT_SUPERSEDED',
      completedAt: '2026-01-01T00:00:01.000Z', purgeAfter: '2026-01-01T04:00:00.999Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    }), isCheckViolation);
  });
});

void test('migration 046 rejects incompatible pre-existing table and named index collisions', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  const sql = await readFile(migrationUrl, 'utf8');

  await withTemporarySchema(databaseUrl, 'strict_catch_up_runs_table_collision', async (pool) => {
    await pool.query('CREATE TABLE listener_strict_catch_up_runs (run_id TEXT PRIMARY KEY)');
    await assert.rejects(() => pool.query(sql), /strict catch-up run table definition is incompatible/u);
  });
  await withTemporarySchema(databaseUrl, 'strict_catch_up_runs_index_collision', async (pool) => {
    await migrateDatabase({ pool });
    await pool.query('DROP INDEX listener_strict_catch_up_runs_active_key_unique');
    await pool.query(`CREATE INDEX listener_strict_catch_up_runs_active_key_unique
      ON listener_strict_catch_up_runs (checkpoint_key)`);
    await assert.rejects(() => pool.query(sql), /strict catch-up run target index definition is incompatible/u);
  });
});

void test('migration 046 rejects altered named checks, unvalidated checks, and a missing primary key on replay', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  const sql = await readFile(migrationUrl, 'utf8');

  for (const [label, mutation] of [
    ['changed_check', `ALTER TABLE listener_strict_catch_up_runs
      DROP CONSTRAINT listener_strict_catch_up_runs_key_check,
      ADD CONSTRAINT listener_strict_catch_up_runs_key_check CHECK (TRUE)`],
    ['unvalidated_check', `ALTER TABLE listener_strict_catch_up_runs
      DROP CONSTRAINT listener_strict_catch_up_runs_key_check,
      ADD CONSTRAINT listener_strict_catch_up_runs_key_check
      CHECK (checkpoint_key IN ('launchpad', 'market')) NOT VALID`],
    ['missing_primary_key', 'ALTER TABLE listener_strict_catch_up_runs DROP CONSTRAINT listener_strict_catch_up_runs_pkey'],
  ] as const) {
    await withTemporarySchema(databaseUrl, `strict_catch_up_runs_${label}`, async (pool) => {
      await migrateDatabase({ pool });
      await pool.query(mutation);
      await assert.rejects(() => pool.query(sql), /strict catch-up run (table|constraint) definition is incompatible/u);
    });
  }
});

type RunValues = Readonly<Partial<{
  runId: string;
  checkpointKey: 'launchpad' | 'market';
  previousSlot: string;
  previousUpdatedAt: string;
  previousSignature: string;
  providerId: string;
  observedHeadSlot: string;
  observedHeadSignature: string;
  beforeSignature: string;
  lastAcceptedSlot: string;
  pagesScanned: string;
  signaturesEnqueued: string;
  revision: string;
  state: 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'SUPERSEDED';
  terminalReason: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  purgeAfter: string | null;
}>>;

async function insertRun(pool: InstanceType<typeof pg.Pool>, suffix: string, values: RunValues = {}): Promise<void> {
  const runSuffix = createHash('sha256').update(suffix).digest('hex');
  const runId = values.runId ?? `strict_catchup_run_${runSuffix}`;
  await pool.query(`INSERT INTO listener_strict_catch_up_runs (
    run_id,checkpoint_key,previous_slot,previous_signature,provider_id,observed_head_slot,
    observed_head_signature,before_signature,last_accepted_slot,pages_scanned,
    signatures_enqueued,revision,state,terminal_reason,previous_updated_at,started_at,updated_at,completed_at,purge_after
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, [
    runId, values.checkpointKey ?? 'launchpad', values.previousSlot ?? '10',
    values.previousSignature ?? 'previous', values.providerId ?? 'primary', values.observedHeadSlot ?? '11',
    values.observedHeadSignature ?? 'head', values.beforeSignature ?? 'before', values.lastAcceptedSlot ?? '10',
    values.pagesScanned ?? '1', values.signaturesEnqueued ?? '1', values.revision ?? '0',
    values.state ?? 'ACTIVE', values.terminalReason ?? null,
    values.previousUpdatedAt ?? '2026-01-01T00:00:00.000Z', values.startedAt ?? '2026-01-01T00:00:00.000Z',
    values.updatedAt ?? '2026-01-01T00:00:00.000Z', values.completedAt ?? null, values.purgeAfter ?? null,
  ]);
}

async function assertRunIndexes(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  const result = await pool.query<{ readonly indexname: string }>(`SELECT indexname FROM pg_indexes
    WHERE schemaname=CURRENT_SCHEMA() AND tablename='listener_strict_catch_up_runs'
      AND indexname IN ('listener_strict_catch_up_runs_active_key_unique',
        'listener_strict_catch_up_runs_provider_key_idx',
        'listener_strict_catch_up_runs_terminal_purge_idx') ORDER BY indexname`);
  assert.deepEqual(result.rows.map((row) => row.indexname), [
    'listener_strict_catch_up_runs_active_key_unique',
    'listener_strict_catch_up_runs_provider_key_idx',
    'listener_strict_catch_up_runs_terminal_purge_idx',
  ]);
}

function isCheckViolation(error: unknown): boolean {
  return isPostgresError(error, '23514');
}

function isUniqueViolation(error: unknown): boolean {
  return isPostgresError(error, '23505');
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function testDatabaseUrl(context: Readonly<{ skip(message?: string): void }>): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') return databaseUrl;
  context.skip('TEST_DATABASE_URL absent: strict catch-up run migration test skipped');
  return null;
}

async function withTemporarySchema(
  databaseUrl: string, prefix: string, callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${quoteIdentifier(schema)}` });
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
  return `"${value.replaceAll('"', '""')}"`;
}

function withoutSqlComments(sql: string): string {
  return sql.replaceAll(/^\s*--.*$/gmu, '');
}
