import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { purgeExpiredFoundationData } from '../src/storage/database.js';

const migrationsDirectory = new URL('../migrations/', import.meta.url);
const migrationName = '048_transaction_inbox_catch_up_classification.sql';
const migrationUrl = new URL(migrationName, migrationsDirectory);
const pumpProgram = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const mintA = '11111111111111111111111111111111';
const mintB = 'So11111111111111111111111111111111111111112';
const observedAt = '2026-09-12T10:00:00.000Z';
const terminalAt = '2026-09-12T10:01:00.000Z';
const purgeAfter = '2026-09-12T14:01:00.000Z';
const classifiedAt = '2026-09-12T10:00:00.001Z';
const classifiedPurgeAfter = '2026-09-12T14:00:00.001Z';

void test('048 declares the minimal versioned classification ledger and strict classified counter', async () => {
  const sql = await migrationSql();
  for (const column of [
    'catch_up_classification_version', 'catch_up_disposition', 'catch_up_reason_code',
    'catch_up_action_key', 'catch_up_mints', 'catch_up_evidence_fingerprint', 'catch_up_classified_at',
    'signatures_classified',
  ]) assert.match(sql, new RegExp(`\\b${column}\\b`, 'u'));
  assert.match(sql, /signatures_classified\s*>=\s*signatures_enqueued/u);
  assert.match(sql, /purge_after\s*=\s*terminal_at\s*\+\s*INTERVAL '4 hours'/u);
  assert.match(sql, /transaction_inbox_solana_public_key_valid/u);
  assert.doesNotMatch(sql, /CREATE\s+EXTENSION/iu);
  assert.doesNotMatch(sql, /CREATE TABLE[^;]*catch_up_classification/iu);
});

void test('048 upgrades 047 without rewriting inbox evidence and replays exactly', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough047(pool);
    await insertInbox(pool, { signature: 'legacy-row' });
    await insertStrictRun(pool, 'strict_catchup_run_' + 'a'.repeat(64), 5);
    const before = (await pool.query("SELECT * FROM chain_transaction_inbox WHERE signature='legacy-row'")).rows[0];
    const sql = await migrationSql();
    await pool.query(sql);
    const upgraded = (await pool.query("SELECT * FROM chain_transaction_inbox WHERE signature='legacy-row'")).rows[0];
    for (const key of Object.keys(before)) assert.deepEqual(upgraded?.[key], before?.[key]);
    assert.deepEqual(classificationColumns(upgraded), {
      catch_up_classification_version: null, catch_up_disposition: null,
      catch_up_reason_code: null, catch_up_action_key: null, catch_up_mints: null,
      catch_up_evidence_fingerprint: null, catch_up_classified_at: null,
    });
    assert.equal((await pool.query(`SELECT signatures_enqueued,signatures_classified
      FROM listener_strict_catch_up_runs`)).rows[0]?.signatures_classified, '5');
    const snapshot = await schemaSnapshot(pool);
    await pool.query(sql);
    assert.deepEqual(await schemaSnapshot(pool), snapshot);
  });
});

void test('048 applies above 047 and remains directly replayable', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough047(pool);
    const sql = await migrationSql();
    await pool.query(sql);
    await pool.query(sql);
    assert.equal((await pool.query(`SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='chain_transaction_inbox'
        AND column_name LIKE 'catch_up_%'`)).rows[0]?.count, '7');
  });
});

void test('048 rejects weakened inbox and strict-run constraints on direct replay', async (context) => {
  const cases = [
    ['inbox', `ALTER TABLE chain_transaction_inbox
      DROP CONSTRAINT chain_transaction_inbox_catch_up_classification_check,
      ADD CONSTRAINT chain_transaction_inbox_catch_up_classification_check CHECK (TRUE)`],
    ['strict', `ALTER TABLE listener_strict_catch_up_runs
      DROP CONSTRAINT listener_strict_catch_up_runs_numeric_bounds_check,
      ADD CONSTRAINT listener_strict_catch_up_runs_numeric_bounds_check CHECK (TRUE)`],
  ] as const;
  for (const [label, mutation] of cases) {
    await withDatabase(context, async (pool) => {
      await applyThrough047(pool);
      await pool.query(await migrationSql());
      await pool.query(mutation);
      await assert.rejects(pool.query(await migrationSql()),
        (error: unknown) => error instanceof pg.DatabaseError
          && error.code === '23514'
          && error.message.includes('definition is incompatible'), label);
    });
  }
});

void test('048 replay rejects rows admitted through a weakened public-key helper', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough047(pool);
    await pool.query(await migrationSql());
    await pool.query(`CREATE OR REPLACE FUNCTION transaction_inbox_solana_public_key_valid(value TEXT)
      RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT TRUE $$`);
    await insertInbox(pool, classified({
      signature: 'invalid-mint-admitted-by-weakened-helper',
      catch_up_mints: ['z'.repeat(44)],
      ingestion_hint: 'PUMPFUN_CREATE',
      processing_status: 'PENDING',
    }));

    await assert.rejects(pool.query(await migrationSql()),
      (error: unknown) => error instanceof pg.DatabaseError
        && error.code === '23514'
        && error.message.includes('stored catch-up helper-dependent evidence is invalid'));
  });
});

void test('048 enforces all-or-none evidence, stable reasons, canonical multi-mints and terminal states', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough047(pool);
    await pool.query(await migrationSql());
    const canonical = [mintA, mintB].sort();
    await insertInbox(pool, classified({ signature: 'actionable', catch_up_mints: canonical,
      ingestion_hint: 'PUMPFUN_CREATE', processing_status: 'PENDING' }));
    await insertInbox(pool, classified({ signature: 'deferred', catch_up_disposition: 'DEFERRED',
      catch_up_reason_code: 'PUMP_TRADE_UNTRACKED', catch_up_mints: canonical,
      catch_up_action_key: `PUMPFUN_TRADE:${canonical[0]}`,
      ingestion_hint: 'PUMPFUN_TRADE', ingestion_hint_mint: canonical[0], processing_status: 'DEFERRED',
      terminal_at: terminalAt, purge_after: purgeAfter }));
    await insertInbox(pool, classified({ signature: 'ignored', catch_up_disposition: 'IGNORED',
      catch_up_reason_code: 'NO_SUPPORTED_PUMP_ACTION', catch_up_mints: [],
      catch_up_action_key: 'NONE',
      processing_status: 'IGNORED', terminal_at: classifiedAt, purge_after: classifiedPurgeAfter }));
    await insertInbox(pool, classified({ signature: 'quarantined', catch_up_disposition: 'QUARANTINED',
      catch_up_reason_code: 'PUMP_SCHEMA_UNSUPPORTED', catch_up_mints: [],
      catch_up_action_key: 'NONE',
      processing_status: 'QUARANTINED', terminal_at: classifiedAt, purge_after: classifiedPurgeAfter }));
    assert.deepEqual((await pool.query(`SELECT signature,processing_status,catch_up_mints
      FROM chain_transaction_inbox ORDER BY signature`)).rows, [
      { signature: 'actionable', processing_status: 'PENDING', catch_up_mints: canonical },
      { signature: 'deferred', processing_status: 'DEFERRED', catch_up_mints: canonical },
      { signature: 'ignored', processing_status: 'IGNORED', catch_up_mints: [] },
      { signature: 'quarantined', processing_status: 'QUARANTINED', catch_up_mints: [] },
    ]);

    const invalid = [
      { catch_up_disposition: null },
      { discovery_sources: ['WEBSOCKET'] },
      { catch_up_classification_version: 2 },
      { catch_up_disposition: 'UNKNOWN' },
      { catch_up_reason_code: 'UNKNOWN' },
      { catch_up_action_key: 'NONE' },
      { catch_up_action_key: `PUMPFUN_TRADE:${mintA}` },
      { catch_up_action_key: `PUMPFUNXTRADE:${mintA}`,
        ingestion_hint: 'PUMPFUN_TRADE', ingestion_hint_mint: mintA },
      { catch_up_mints: [mintB, mintA] },
      { catch_up_mints: [mintA, mintA] },
      { catch_up_mints: ['invalid'] },
      { catch_up_mints: ['z'.repeat(44)] },
      { catch_up_mints: ['2'.repeat(32)] },
      { catch_up_evidence_fingerprint: 'A'.repeat(64) },
      { catch_up_classified_at: '2026-09-12T09:59:59.999Z' },
      { catch_up_disposition: 'IGNORED', catch_up_reason_code: 'PUMP_SCHEMA_UNSUPPORTED',
        catch_up_mints: [], processing_status: 'IGNORED', ingestion_hint: 'NONE' },
      { catch_up_disposition: 'QUARANTINED', catch_up_reason_code: 'PUMP_SCHEMA_UNSUPPORTED',
        catch_up_mints: [], processing_status: 'PENDING', ingestion_hint: 'NONE' },
    ];
    for (const patch of invalid) {
      await assert.rejects(insertInbox(pool, classified({ signature: randomUUID(),
        catch_up_mints: canonical, ingestion_hint: 'PUMPFUN_CREATE', processing_status: 'PENDING', ...patch })),
      (error: unknown) => error instanceof pg.DatabaseError && ['23514', '23502'].includes(error.code ?? ''),
      JSON.stringify(patch));
    }
  });
});

void test('048 requires classified signatures to cover every enqueued strict signature', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough047(pool);
    await pool.query(await migrationSql());
    await insertStrictRun(pool, 'strict_catchup_run_' + 'b'.repeat(64), 3, 3);
    await pool.query(`UPDATE listener_strict_catch_up_runs SET signatures_classified=4
      WHERE run_id=$1`, ['strict_catchup_run_' + 'b'.repeat(64)]);
    await assert.rejects(pool.query(`UPDATE listener_strict_catch_up_runs SET signatures_classified=2
      WHERE run_id=$1`, ['strict_catchup_run_' + 'b'.repeat(64)]), {
      code: '23514', constraint: 'listener_strict_catch_up_runs_numeric_bounds_check',
    });

    const liveEdgeRunId = 'strict_catchup_run_' + 'c'.repeat(64);
    await pool.query(`INSERT INTO listener_strict_catch_up_runs (
      run_id,checkpoint_key,previous_slot,previous_signature,provider_id,
      observed_head_slot,observed_head_signature,before_signature,last_accepted_slot,
      pages_scanned,signatures_enqueued,signatures_classified,revision,state,
      previous_updated_at,started_at,updated_at
    ) VALUES ($1,'market',1,'previous','primary',3,'frontier','frontier',3,
      1,0,1,0,'ACTIVE',$2,$2,$2)`, [liveEdgeRunId, observedAt]);
    assert.deepEqual((await pool.query(`SELECT signatures_enqueued,signatures_classified
      FROM listener_strict_catch_up_runs WHERE run_id=$1`, [liveEdgeRunId])).rows[0], {
      signatures_enqueued: '0', signatures_classified: '1',
    });
    await assert.rejects(pool.query(`UPDATE listener_strict_catch_up_runs
      SET signatures_classified=0 WHERE run_id=$1`, [liveEdgeRunId]), {
      code: '23514', constraint: 'listener_strict_catch_up_runs_cursor_order_check',
    });
  });
});

void test('ignored and quarantined classifications purge after exactly four hours', async (context) => {
  await withDatabase(context, async (pool) => {
    await applyThrough047(pool);
    await pool.query(await migrationSql());
    const oldTerminal = new Date(Date.now() - 14_400_001).toISOString();
    const oldPurge = new Date(new Date(oldTerminal).getTime() + 14_400_000).toISOString();
    for (const [signature, disposition, reason] of [
      ['purge-ignore', 'IGNORED', 'NO_SUPPORTED_PUMP_ACTION'],
      ['purge-quarantine', 'QUARANTINED', 'PUMP_SCHEMA_UNSUPPORTED'],
    ] as const) {
      await insertInbox(pool, classified({ signature, catch_up_disposition: disposition,
        catch_up_reason_code: reason, catch_up_mints: [], processing_status: disposition,
        catch_up_action_key: 'NONE',
        observed_at: oldTerminal, terminal_at: oldTerminal, purge_after: oldPurge,
        catch_up_classified_at: oldTerminal }));
    }
    const purged = await purgeExpiredFoundationData(pool);
    assert.equal(purged.transactionInbox, 2);
    assert.equal((await pool.query("SELECT COUNT(*) FROM chain_transaction_inbox WHERE signature LIKE 'purge-%'")).rows[0]?.count, '0');
  });
});

function classified(overrides: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return {
    discovery_sources: ['CATCH_UP'], ingestion_hint: 'NONE', ingestion_hint_mint: null,
    catch_up_classification_version: 1, catch_up_disposition: 'ACTIONABLE',
    catch_up_reason_code: 'PUMP_ACTION_SUPPORTED', catch_up_action_key: 'PUMPFUN_CREATE',
    catch_up_mints: [mintA],
    catch_up_evidence_fingerprint: 'a'.repeat(64), catch_up_classified_at: '2026-09-12T10:00:00.001Z',
    ...overrides,
  };
}

function classificationColumns(row: Record<string, unknown> | undefined): Record<string, unknown> {
  assert.ok(row);
  return Object.fromEntries(['catch_up_classification_version', 'catch_up_disposition',
    'catch_up_reason_code', 'catch_up_action_key', 'catch_up_mints',
    'catch_up_evidence_fingerprint', 'catch_up_classified_at']
    .map((key) => [key, row[key]]));
}

async function migrationSql(): Promise<string> {
  const sql = await readFile(migrationUrl, 'utf8').catch(() => '');
  assert.notEqual(sql, '', 'migration 048 must exist');
  return sql;
}

async function applyThrough047(pool: pg.Pool): Promise<void> {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name) && name < migrationName).sort();
  assert.equal(names.at(-1), '047_transaction_inbox_tracked_trade_priority.sql');
  await pool.query(`CREATE TABLE migration_history (
    version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  for (const name of names) {
    await pool.query(await readFile(new URL(name, migrationsDirectory), 'utf8'));
    await pool.query('INSERT INTO migration_history(version) VALUES ($1)', [name]);
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

async function insertStrictRun(pool: pg.Pool, runId: string, enqueued: number, classified?: number): Promise<void> {
  const columns = classified === undefined ? '' : ',signatures_classified';
  const values = classified === undefined ? '' : ',$4';
  await pool.query(`INSERT INTO listener_strict_catch_up_runs (
    run_id,checkpoint_key,previous_slot,previous_signature,provider_id,
    observed_head_slot,observed_head_signature,before_signature,last_accepted_slot,
    pages_scanned,signatures_enqueued,revision,state,previous_updated_at,started_at,updated_at${columns}
  ) VALUES ($1,'launchpad',1,'previous','primary',3,'head','before',2,1,$2,0,'ACTIVE',$3,$3,$3${values})`,
  classified === undefined ? [runId, enqueued, observedAt] : [runId, enqueued, observedAt, classified]);
}

async function schemaSnapshot(pool: pg.Pool): Promise<readonly unknown[]> {
  return (await pool.query<Readonly<Record<string, unknown>>>(`SELECT table_name,column_name,data_type,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name IN ('chain_transaction_inbox','listener_strict_catch_up_runs')
    ORDER BY table_name,ordinal_position`)).rows;
}

async function withDatabase(context: TestContext, run: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: catch-up classification migration PG16 tests skipped');
    return;
  }
  const schema = `inbox_classification_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1 });
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
