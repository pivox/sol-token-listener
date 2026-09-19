import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';

const migrationsDirectory = new URL('../migrations/', import.meta.url);
const migrationName = '049_transaction_inbox_catch_up_admission_receipt.sql';
const migrationUrl = new URL(migrationName, migrationsDirectory);
const pumpProgram = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const mint = 'So11111111111111111111111111111111111111112';
const observedAt = '2026-09-19T10:00:00.000Z';

void test('049 declares immutable catch-up admission evidence', async () => {
  const sql = await migrationSql();
  assert.match(sql, /ADD COLUMN IF NOT EXISTS catch_up_enqueued BOOLEAN/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS catch_up_admission_priority\s+chain_transaction_inbox_priority/u);
  assert.match(sql, /catch_up_enqueued IS NULL/u);
  assert.match(sql, /catch_up_admission_priority IS NULL/u);
  assert.match(sql, /ambiguous historical DEFERRED admission/u);
  assert.match(sql, /catch_up_disposition='ACTIONABLE'\s+THEN TRUE/u);
  assert.match(sql, /catch_up_disposition IN \('IGNORED','QUARANTINED'\)\s+THEN FALSE/u);
  assert.match(sql, /chain_transaction_inbox_catch_up_classification_check/u);
  assert.doesNotMatch(sql, /CREATE\s+EXTENSION/iu);
});

void test('049 upgrades 048, backfills exact historical admission and replays cleanly', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough048(pool);
    await insertClassified(pool, { signature: 'actionable', catch_up_disposition: 'ACTIONABLE',
      catch_up_reason_code: 'PUMP_ACTION_SUPPORTED', processing_status: 'PENDING' });
    await insertClassified(pool, { signature: 'actionable-websocket',
      discovery_sources: ['WEBSOCKET', 'CATCH_UP'], catch_up_disposition: 'ACTIONABLE',
      catch_up_reason_code: 'PUMP_ACTION_SUPPORTED', processing_status: 'PENDING' });
    await insertClassified(pool, { signature: 'ignored', catch_up_disposition: 'IGNORED',
      catch_up_reason_code: 'NO_SUPPORTED_PUMP_ACTION', catch_up_action_key: 'NONE', catch_up_mints: [],
      ingestion_hint: 'NONE', ingestion_hint_mint: null,
      processing_status: 'IGNORED', terminal_at: observedAt, purge_after: '2026-09-19T14:00:00.000Z' });

    const sql = await migrationSql();
    await pool.query(sql);
    assert.deepEqual((await pool.query(`SELECT signature,catch_up_enqueued,catch_up_admission_priority
      FROM chain_transaction_inbox ORDER BY signature`)).rows, [
      { signature: 'actionable', catch_up_enqueued: true, catch_up_admission_priority: 'NORMAL' },
      { signature: 'actionable-websocket', catch_up_enqueued: false, catch_up_admission_priority: null },
      { signature: 'ignored', catch_up_enqueued: false, catch_up_admission_priority: null },
    ]);
    await pool.query(sql);
  });
});

void test('049 rejects ambiguous 048 deferred evidence before adding receipt columns', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough048(pool);
    await insertClassified(pool, {
      signature: 'deferred-ambiguous', catch_up_disposition: 'DEFERRED',
      catch_up_reason_code: 'PUMP_TRADE_UNTRACKED', catch_up_action_key: `PUMPFUN_TRADE:${mint}`,
      ingestion_hint: 'PUMPFUN_TRADE', ingestion_hint_mint: mint, processing_status: 'PENDING',
    });

    await assert.rejects(pool.query(await migrationSql()), { code: '23514' });
    assert.equal((await pool.query(`SELECT COUNT(*) AS count FROM pg_attribute
      WHERE attrelid='chain_transaction_inbox'::REGCLASS AND attnum>0 AND NOT attisdropped
        AND attname IN ('catch_up_enqueued','catch_up_admission_priority')`)).rows[0]?.count, '0');
  });
});

void test('049 rejects incomplete or incoherent admission evidence', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough048(pool);
    await pool.query(await migrationSql());
    await assert.rejects(insertClassified(pool, {
      signature: randomUUID(), catch_up_enqueued: null,
    }), { code: '23514' });
    await assert.rejects(insertClassified(pool, {
      signature: randomUUID(), catch_up_disposition: 'IGNORED',
      catch_up_reason_code: 'NO_SUPPORTED_PUMP_ACTION', catch_up_action_key: 'NONE', catch_up_mints: [],
      processing_status: 'IGNORED', terminal_at: observedAt, purge_after: '2026-09-19T14:00:00.000Z',
      catch_up_enqueued: true,
    }), { code: '23514' });
    await assert.rejects(insertClassified(pool, {
      signature: randomUUID(), catch_up_enqueued: false,
    }), { code: '23514' });
    await assert.rejects(insertClassified(pool, {
      signature: randomUUID(), catch_up_enqueued: false,
      catch_up_admission_priority: 'LAUNCH_CANDIDATE',
    }), { code: '23514' });
    await insertClassified(pool, {
      signature: randomUUID(), discovery_sources: ['WEBSOCKET', 'CATCH_UP'],
      catch_up_enqueued: false,
    });
  });
});

void test('049 admits a one-row already-admitted page with zero counters', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough048(pool);
    await pool.query(await migrationSql());
    await pool.query(`INSERT INTO listener_strict_catch_up_runs (
      run_id,checkpoint_key,previous_slot,previous_signature,provider_id,
      observed_head_slot,observed_head_signature,before_signature,last_accepted_slot,
      pages_scanned,signatures_enqueued,signatures_classified,revision,state,
      previous_updated_at,started_at,updated_at
    ) VALUES ($1,'launchpad',1,'previous','primary',3,'head','head',3,
      1,0,0,0,'ACTIVE',$2,$2,$2)`, [
      `strict_catchup_run_${'a'.repeat(64)}`, observedAt,
    ]);
    assert.deepEqual((await pool.query(`SELECT signatures_enqueued,signatures_classified
      FROM listener_strict_catch_up_runs`)).rows, [{
      signatures_enqueued: '0', signatures_classified: '0',
    }]);
  });
});

void test('049 rejects a partially installed admission receipt schema', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough048(pool);
    await pool.query('ALTER TABLE chain_transaction_inbox ADD COLUMN catch_up_enqueued BOOLEAN');
    await assert.rejects(pool.query(await migrationSql()), {
      code: '23514', message: 'catch-up admission receipt columns are partially installed',
    });
  });
});

void test('049 rejects weakened replay constraints under their canonical names', async (context) => {
  const weakened: readonly Readonly<{ readonly relation: string; readonly name: string;
    readonly definition: string }>[] = [
    {
      relation: 'chain_transaction_inbox',
      name: 'chain_transaction_inbox_catch_up_classification_check',
      definition: 'catch_up_enqueued IS NULL OR catch_up_admission_priority IS NULL OR TRUE',
    },
    {
      relation: 'chain_transaction_inbox',
      name: 'chain_transaction_inbox_catch_up_terminal_check',
      definition: 'catch_up_enqueued IS NULL OR catch_up_admission_priority IS NULL OR TRUE',
    },
    {
      relation: 'listener_strict_catch_up_runs',
      name: 'listener_strict_catch_up_runs_cursor_order_check',
      definition: '(signatures_classified >= 0 AND signatures_classified <= 1) OR TRUE',
    },
  ];
  for (const item of weakened) {
    await withDatabase(context, async (pool) => {
      const sql = await migrationSql();
      await applyThrough048(pool);
      await pool.query(sql);
      await pool.query(`ALTER TABLE ${item.relation} DROP CONSTRAINT ${item.name}`);
      await pool.query(`ALTER TABLE ${item.relation} ADD CONSTRAINT ${item.name} CHECK (${item.definition})`);
      await assert.rejects(pool.query(sql), { code: '23514' });
    });
  }
});

async function migrationSql(): Promise<string> {
  const sql = await readFile(migrationUrl, 'utf8').catch(() => '');
  assert.notEqual(sql, '', 'migration 049 must exist');
  return sql;
}

async function applyThrough048(pool: pg.Pool): Promise<void> {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name) && name < migrationName).sort();
  assert.equal(names.at(-1), '048_transaction_inbox_catch_up_classification.sql');
  await pool.query('CREATE TABLE migration_history (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  for (const name of names) {
    await pool.query(await readFile(new URL(name, migrationsDirectory), 'utf8'));
    await pool.query('INSERT INTO migration_history(version) VALUES ($1)', [name]);
  }
}

async function insertClassified(pool: pg.Pool, overrides: Readonly<Record<string, unknown>>): Promise<void> {
  const row: Readonly<Record<string, unknown>> = {
    signature: randomUUID(), observed_slot: 1, discovery_sources: ['CATCH_UP'], program_ids: [pumpProgram],
    target_confirmation_status: 'confirmed', processing_status: 'PENDING', observed_at: observedAt,
    ingestion_hint: 'PUMPFUN_CREATE', ingestion_hint_mint: null,
    catch_up_classification_version: 1, catch_up_disposition: 'ACTIONABLE',
    catch_up_reason_code: 'PUMP_ACTION_SUPPORTED', catch_up_action_key: 'PUMPFUN_CREATE',
    catch_up_mints: [mint], catch_up_evidence_fingerprint: 'a'.repeat(64),
    catch_up_classified_at: observedAt, ...overrides,
  };
  const columns = Object.keys(row);
  await pool.query(`INSERT INTO chain_transaction_inbox (${columns.join(',')})
    VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(row));
}

async function withDatabase(context: TestContext, run: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: catch-up admission migration PG16 tests skipped');
    return;
  }
  const schema = `inbox_admission_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    assert.equal((await pool.query("SELECT current_setting('server_version_num')::INTEGER / 10000 AS major")).rows[0]?.major, 16);
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}
