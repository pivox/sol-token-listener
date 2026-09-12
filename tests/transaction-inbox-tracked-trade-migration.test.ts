import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationsDirectory = new URL('../migrations/', import.meta.url);
const migrationName = '047_transaction_inbox_tracked_trade_priority.sql';
const migrationUrl = new URL(migrationName, migrationsDirectory);
const mint = 'So11111111111111111111111111111111111111112';
const program = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const observedAt = '2026-09-12T10:00:00.000Z';
const terminalAt = '2026-09-12T10:01:00.000Z';
const purgeAfter = '2026-09-12T14:01:00.000Z';

void test('047 defines additive durable trade hints, deferred retention and urgent FIFO', async () => {
  const sql = await migrationSql();
  for (const fragment of [
    'TRACKED_TRADE', 'ingestion_hint', 'ingestion_hint_mint', 'PUMPFUN_CREATE',
    'PUMPFUN_TRADE', 'DEFERRED', 'consecutive_urgent_claims',
    'chain_transaction_inbox_claim_order_idx',
  ]) assert.ok(sql.includes(fragment), `missing migration contract: ${fragment}`);
  assert.match(sql, /OCTET_LENGTH\(ingestion_hint_mint\) BETWEEN 32 AND 44/u);
  assert.match(sql, /\^\[1-9A-HJ-NP-Za-km-z\]\{32,44\}\$/u);
  assert.match(sql, /purge_after = terminal_at \+ INTERVAL '4 hours'/u);
  assert.match(sql, /\(ingestion_priority <> 'NORMAL'\) DESC, observed_slot, signature/u);
  assert.doesNotMatch(sql, /\b(?:DELETE FROM|TRUNCATE|CASCADE|ADD VALUE)\b/u);
});

void test('PG16 rejects using an added enum label in the same transaction', async (context) => {
  await withDatabase(context, async (pool) => {
    await pool.query("CREATE TYPE enum_transaction_probe AS ENUM ('NORMAL', 'LAUNCH_CANDIDATE')");
    await pool.query('BEGIN');
    try {
      await pool.query("ALTER TYPE enum_transaction_probe ADD VALUE 'TRACKED_TRADE'");
      // https://www.postgresql.org/docs/16/sql-altertype.html: commit is required
      // for an added value. 047 must also work when immediately used before commit.
      await assert.rejects(pool.query("SELECT 'TRACKED_TRADE'::enum_transaction_probe"), { code: '55P04' });
    } finally {
      await pool.query('ROLLBACK');
    }
  });
});

void test('047 upgrades 001..046 without losing rows, backfills hints and replays transactionally', async (context) => {
  await withDatabase(context, async (pool) => {
    const sql = await migrationSql();
    await applyThrough046(pool);
    await insertInbox(pool, { signature: 'legacy-normal' });
    await insertInbox(pool, { signature: 'legacy-launch', ingestion_priority: 'LAUNCH_CANDIDATE' });
    await pool.query('UPDATE chain_transaction_inbox_claim_scheduler SET consecutive_launch_candidate_claims=17');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await insertInbox(pool, { signature: 'new-tracked', ingestion_priority: 'TRACKED_TRADE',
        ingestion_hint: 'PUMPFUN_TRADE', ingestion_hint_mint: mint });
      await pool.query(sql);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
    assert.deepEqual((await pool.query(`SELECT signature, ingestion_priority::TEXT AS priority,
      ingestion_hint, ingestion_hint_mint FROM chain_transaction_inbox ORDER BY signature`)).rows, [
      { signature: 'legacy-launch', priority: 'LAUNCH_CANDIDATE', ingestion_hint: 'PUMPFUN_CREATE', ingestion_hint_mint: null },
      { signature: 'legacy-normal', priority: 'NORMAL', ingestion_hint: 'NONE', ingestion_hint_mint: null },
      { signature: 'new-tracked', priority: 'TRACKED_TRADE', ingestion_hint: 'PUMPFUN_TRADE', ingestion_hint_mint: mint },
    ]);
    assert.deepEqual((await pool.query(`SELECT scheduler_key, consecutive_urgent_claims
      FROM chain_transaction_inbox_claim_scheduler`)).rows, [{ scheduler_key: 'global', consecutive_urgent_claims: 17 }]);
    await assertCatalog(pool);
    await pool.query(sql);
    await assertCatalog(pool);
  });
});

void test('047 is the clean-database head and the migration runner remains idempotent', async (context) => {
  await withDatabase(context, async (pool) => {
    await migrationSql();
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), migrationName);
    assert.equal(applied.length, 47);
    assert.deepEqual(await migrateDatabase({ pool }), []);
    assert.deepEqual((await pool.query(`SELECT scheduler_key, consecutive_urgent_claims
      FROM chain_transaction_inbox_claim_scheduler`)).rows, [{ scheduler_key: 'global', consecutive_urgent_claims: 0 }]);
    await assertCatalog(pool);
  });
});

void test('047 backfills compatible preexisting hint columns without overwriting classified data', async (context) => {
  await withDatabase(context, async (pool) => {
    const sql = await migrationSql();
    await applyThrough046(pool);
    await pool.query(`ALTER TABLE chain_transaction_inbox
      ADD COLUMN ingestion_hint TEXT NOT NULL DEFAULT 'NONE', ADD COLUMN ingestion_hint_mint TEXT`);
    await insertInbox(pool, { signature: 'legacy-launch', ingestion_priority: 'LAUNCH_CANDIDATE' });
    await insertInbox(pool, { signature: 'classified-trade', ingestion_hint: 'PUMPFUN_TRADE', ingestion_hint_mint: mint });
    await pool.query(sql);
    assert.deepEqual((await pool.query(`SELECT signature, ingestion_hint, ingestion_hint_mint
      FROM chain_transaction_inbox ORDER BY signature`)).rows, [
      { signature: 'classified-trade', ingestion_hint: 'PUMPFUN_TRADE', ingestion_hint_mint: mint },
      { signature: 'legacy-launch', ingestion_hint: 'PUMPFUN_CREATE', ingestion_hint_mint: null },
    ]);
  });
});

void test('047 permits every existing lifecycle and strictly rejects hint/deferred/legacy violations', async (context) => {
  await withDatabase(context, async (pool) => {
    const sql = await migrationSql();
    await applyThrough046(pool);
    await pool.query(sql);
    const snapshot = { normalized_transaction: {}, immutable_fingerprint: 'a'.repeat(64) };
    const deferred = { processing_status: 'DEFERRED', ingestion_hint: 'PUMPFUN_TRADE',
      ingestion_hint_mint: mint, terminal_at: terminalAt, purge_after: purgeAfter };
    const retrying = { processing_status: 'FAILED', error_code: 'RPC_TRANSIENT', error_name: 'RpcError',
      error_retryable: true, next_attempt_at: terminalAt, attempts: 1, attempts_in_cycle: 1 };
    const valid = [
      {}, { ingestion_priority: 'LAUNCH_CANDIDATE', ingestion_hint: 'PUMPFUN_CREATE' },
      { ingestion_priority: 'TRACKED_TRADE', ingestion_hint: 'PUMPFUN_TRADE', ingestion_hint_mint: mint },
      { processing_status: 'PROCESSING', lease_token: 'lease', lease_expires_at: terminalAt, attempts: 1, attempts_in_cycle: 1 },
      { processing_status: 'PROCESSED', processed_at: terminalAt, ...snapshot },
      { processing_status: 'PROCESSED', processed_at: terminalAt, target_confirmation_status: 'finalized',
        terminal_at: terminalAt, purge_after: purgeAfter, ...snapshot },
      retrying,
      { ...retrying, next_attempt_at: null, retry_exhausted_at: terminalAt,
        terminal_at: terminalAt, purge_after: purgeAfter },
      { ...retrying, error_retryable: false, next_attempt_at: null, terminal_at: terminalAt, purge_after: purgeAfter },
      ...['processed', 'confirmed', 'finalized', 'orphaned'].map((status) => ({ ...deferred, target_confirmation_status: status })),
      ...[32, 44].map((length) => ({ ...deferred, ingestion_hint_mint: '1'.repeat(length) })),
    ];
    for (const row of valid) await insertInbox(pool, row);
    // Replaying must not reclassify or reopen deferred rows.
    const beforeReplay = (await pool.query('SELECT * FROM chain_transaction_inbox ORDER BY signature')).rows;
    await pool.query(sql);
    assert.deepEqual((await pool.query('SELECT * FROM chain_transaction_inbox ORDER BY signature')).rows, beforeReplay);

    const invalidHints: readonly Record<string, unknown>[] = [
      { ingestion_hint: null }, { ingestion_hint: 'UNKNOWN' }, { ingestion_hint: ' NONE' },
      { ingestion_hint_mint: mint }, { ingestion_hint: 'PUMPFUN_CREATE', ingestion_hint_mint: mint },
      { ingestion_hint: 'PUMPFUN_TRADE' },
      ...['', '1'.repeat(31), '1'.repeat(45), ` ${mint}`, `${mint} `, `${mint}\n`, `\t${mint}`,
        '0'.repeat(32), 'O'.repeat(32), 'I'.repeat(32), 'l'.repeat(32), 'é'.repeat(32), '１'.repeat(32)]
        .map((value) => ({ ingestion_hint: 'PUMPFUN_TRADE', ingestion_hint_mint: value })),
    ];
    const invalidDeferred: readonly Record<string, unknown>[] = [
      { ingestion_hint: 'NONE', ingestion_hint_mint: null }, { ingestion_hint: 'PUMPFUN_CREATE', ingestion_hint_mint: null },
      { ingestion_priority: 'TRACKED_TRADE' }, { ingestion_priority: 'LAUNCH_CANDIDATE' },
      { lease_token: 'lease' }, { lease_expires_at: terminalAt }, { attempts: 1 }, { attempts: 1, attempts_in_cycle: 1 },
      { ...snapshot }, { normalized_transaction: {} }, { immutable_fingerprint: 'a'.repeat(64) },
      { error_code: 'RPC_TRANSIENT' }, { error_name: 'Error' }, { error_retryable: false },
      { processed_at: terminalAt }, { next_attempt_at: terminalAt }, { retry_exhausted_at: terminalAt },
      { missing_finality_polls: 1, last_missing_finality_provider_id: 'primary' }, { finality_evidence_version: 1 },
      { manual_recovery_count: 1, last_manual_recovery_at: terminalAt },
      { terminal_at: null }, { purge_after: null }, { terminal_at: null, purge_after: null },
      { purge_after: '2026-09-12T14:00:00.000Z' },
      { terminal_at: '2026-09-12T09:59:00.000Z', purge_after: '2026-09-12T13:59:00.000Z' },
      { terminal_at: 'infinity', purge_after: 'infinity' },
      { updated_at: '2000-01-01T00:00:00.000Z' },
    ];
    const invalidLegacy: readonly Record<string, unknown>[] = [
      { processing_status: 'UNKNOWN' }, { processing_status: 'PROCESSING' },
      { lease_token: 'lease', lease_expires_at: terminalAt }, { error_code: 'RPC_TRANSIENT' },
      { error_name: 'Error' }, { error_retryable: false }, { next_attempt_at: terminalAt },
      { retry_exhausted_at: terminalAt }, { normalized_transaction: {} },
      { processing_status: 'PROCESSED' },
      { processing_status: 'PROCESSED', processed_at: terminalAt },
      { processing_status: 'PROCESSED', processed_at: terminalAt, ...snapshot, target_confirmation_status: 'finalized' },
      { processing_status: 'PROCESSED', processed_at: '2000-01-01T00:00:00.000Z', ...snapshot },
      { ...retrying, next_attempt_at: null }, { ...retrying, error_code: 'UNKNOWN' },
      { ...retrying, error_name: '' }, { ...retrying, error_retryable: false, next_attempt_at: null },
      { ...retrying, terminal_at: terminalAt, purge_after: purgeAfter },
      { terminal_at: terminalAt, purge_after: purgeAfter },
      { attempts: -1 }, { attempts_in_cycle: 1 }, { retry_max_attempts: 0 }, { retry_base_delay_ms: 0 },
    ];
    for (const row of [...invalidHints, ...invalidDeferred.map((patch) => ({ ...deferred, ...patch })), ...invalidLegacy]) {
      await assert.rejects(insertInbox(pool, row), (error: unknown) =>
        error instanceof pg.DatabaseError && ['23514', '23502'].includes(error.code ?? ''), JSON.stringify(row));
    }
    // Keep these cases valid under all unrelated checks: generic rejection
    // alone could otherwise conceal a missing hint or deferred invariant.
    const hintConstraintCases = [
      { ingestion_hint: 'UNKNOWN' }, { ingestion_hint_mint: mint },
      { ingestion_hint: 'PUMPFUN_CREATE', ingestion_hint_mint: mint },
      { ingestion_hint: 'PUMPFUN_TRADE' },
      { ingestion_hint: 'PUMPFUN_TRADE', ingestion_hint_mint: '0'.repeat(32) },
    ];
    for (const row of hintConstraintCases) {
      await assert.rejects(insertInbox(pool, row), {
        code: '23514', constraint: 'chain_transaction_inbox_ingestion_hint_check',
      }, JSON.stringify(row));
    }
    const deferredConstraintCases = [
      { ingestion_hint: 'NONE', ingestion_hint_mint: null },
      { ingestion_priority: 'TRACKED_TRADE' }, { attempts: 1 }, snapshot,
      { terminal_at: null, purge_after: null },
      { terminal_at: '2026-09-12T09:59:00.000Z', purge_after: '2026-09-12T13:59:00.000Z' },
    ];
    for (const patch of deferredConstraintCases) {
      await assert.rejects(insertInbox(pool, { ...deferred, ...patch }), {
        code: '23514', constraint: 'chain_transaction_inbox_deferred_check',
      }, JSON.stringify(patch));
    }
    for (const count of [0, 32]) {
      await pool.query('UPDATE chain_transaction_inbox_claim_scheduler SET consecutive_urgent_claims=$1', [count]);
      assert.equal((await pool.query('SELECT consecutive_urgent_claims FROM chain_transaction_inbox_claim_scheduler')).rows[0]?.consecutive_urgent_claims, count);
    }
    for (const count of [-1, 33]) {
      await assert.rejects(pool.query('UPDATE chain_transaction_inbox_claim_scheduler SET consecutive_urgent_claims=$1', [count]), { code: '23514' });
    }
    await assert.rejects(pool.query("INSERT INTO chain_transaction_inbox_claim_scheduler(scheduler_key) VALUES ('other')"), { code: '23514' });
    await assert.rejects(pool.query('UPDATE chain_transaction_inbox_claim_scheduler SET consecutive_urgent_claims=NULL'), { code: '23502' });
  });
});

void test('047 urgent FIFO index is usable without sorting on PG16 and excludes deferred rows', async (context) => {
  await withDatabase(context, async (pool) => {
    const sql = await migrationSql();
    await applyThrough046(pool);
    await pool.query(sql);
    await insertInbox(pool, { signature: 'normal', observed_slot: 0 });
    await insertInbox(pool, { signature: 'launch', observed_slot: 1, ingestion_priority: 'LAUNCH_CANDIDATE' });
    await insertInbox(pool, { signature: 'trade', observed_slot: 2, ingestion_priority: 'TRACKED_TRADE' });
    await insertInbox(pool, { signature: 'deferred', observed_slot: 0, processing_status: 'DEFERRED',
      ingestion_hint: 'PUMPFUN_TRADE', ingestion_hint_mint: mint, terminal_at: terminalAt, purge_after: purgeAfter });
    const query = `SELECT signature FROM chain_transaction_inbox
      WHERE processing_status='PENDING' OR processing_status='PROCESSING'
        OR (processing_status='FAILED' AND error_retryable=TRUE AND retry_exhausted_at IS NULL)
      ORDER BY (ingestion_priority <> 'NORMAL') DESC, observed_slot, signature LIMIT 10`;
    assert.deepEqual((await pool.query(query)).rows, [{ signature: 'launch' }, { signature: 'trade' }, { signature: 'normal' }]);
    // Representative cardinality and real statistics: a tiny four-row fixture
    // can legitimately favor a bitmap scan plus sort despite an ordered index.
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, observed_at
    ) SELECT 'bulk-' || value, value + 100, ARRAY['WEBSOCKET'], ARRAY[$1], 'confirmed', 'PENDING', $2
      FROM generate_series(1, 2000) value`, [program, observedAt]);
    await pool.query('ANALYZE chain_transaction_inbox');
    const explain = JSON.stringify((await pool.query(`EXPLAIN (FORMAT JSON) ${query}`)).rows);
    assert.match(explain, /chain_transaction_inbox_claim_order_idx/u);
    assert.doesNotMatch(explain, /"Node Type":"(?:Incremental )?Sort"/u);
    const purgeExplain = JSON.stringify((await pool.query(`EXPLAIN (FORMAT JSON)
      SELECT signature FROM chain_transaction_inbox WHERE purge_after <= NOW() ORDER BY purge_after LIMIT 10`)).rows);
    assert.match(purgeExplain, /chain_transaction_inbox_purge_idx/u);
    assert.deepEqual((await pool.query('SELECT signature FROM chain_transaction_inbox WHERE purge_after IS NOT NULL')).rows,
      [{ signature: 'deferred' }]);
  });
});

void test('047 rejects incompatible preexisting objects before changing durable state', async (context) => {
  await withDatabase(context, async (pool) => {
    const sql = await migrationSql();
    await applyThrough046(pool);
    const driftCases = [
      "ALTER TYPE chain_transaction_inbox_priority RENAME VALUE 'NORMAL' TO 'BROKEN'",
      "CREATE TYPE chain_transaction_inbox_priority_047 AS ENUM ('BROKEN')",
      'ALTER TABLE chain_transaction_inbox ALTER COLUMN ingestion_priority DROP NOT NULL',
      "ALTER TABLE chain_transaction_inbox ALTER COLUMN ingestion_priority SET DEFAULT 'LAUNCH_CANDIDATE'",
      'ALTER TABLE chain_transaction_inbox ADD COLUMN ingestion_hint INTEGER',
      "ALTER TABLE chain_transaction_inbox ADD COLUMN ingestion_hint TEXT NOT NULL DEFAULT 'UNKNOWN'",
      'ALTER TABLE chain_transaction_inbox ADD COLUMN ingestion_hint_mint VARCHAR(44)',
      'ALTER TABLE chain_transaction_inbox_claim_scheduler ADD COLUMN consecutive_urgent_claims SMALLINT NOT NULL DEFAULT 0',
      'ALTER TABLE chain_transaction_inbox_claim_scheduler ALTER COLUMN consecutive_launch_candidate_claims TYPE INTEGER',
      'ALTER TABLE chain_transaction_inbox_claim_scheduler ALTER COLUMN consecutive_launch_candidate_claims SET DEFAULT 1',
      `ALTER TABLE chain_transaction_inbox_claim_scheduler DROP CONSTRAINT chain_transaction_inbox_claim_scheduler_streak_check;
       ALTER TABLE chain_transaction_inbox_claim_scheduler ADD CONSTRAINT chain_transaction_inbox_claim_scheduler_streak_check CHECK (consecutive_launch_candidate_claims>=0)`,
      'ALTER TABLE chain_transaction_inbox_claim_scheduler DROP CONSTRAINT chain_transaction_inbox_claim_scheduler_key_check',
      'ALTER TABLE chain_transaction_inbox_claim_scheduler DROP CONSTRAINT chain_transaction_inbox_claim_scheduler_pkey',
      "DELETE FROM chain_transaction_inbox_claim_scheduler WHERE scheduler_key='global'",
      'ALTER TABLE chain_transaction_inbox_claim_scheduler ALTER COLUMN updated_at TYPE TIMESTAMP',
      `ALTER TABLE chain_transaction_inbox DROP CONSTRAINT chain_transaction_inbox_processing_status_check;
       ALTER TABLE chain_transaction_inbox ADD CONSTRAINT chain_transaction_inbox_processing_status_check CHECK (TRUE)`,
      `DROP INDEX chain_transaction_inbox_claim_order_idx;
       CREATE INDEX chain_transaction_inbox_claim_order_idx ON chain_transaction_inbox (signature)`,
      `DROP INDEX chain_transaction_inbox_purge_idx;
       CREATE INDEX chain_transaction_inbox_purge_idx ON chain_transaction_inbox (signature)`,
    ];
    for (const drift of driftCases) {
      await pool.query('BEGIN');
      try {
        await pool.query(drift);
        await assert.rejects(pool.query(sql), /incompatible/u, drift);
      } finally {
        await pool.query('ROLLBACK');
      }
    }
    await pool.query(sql);
    const replayDrift = [
      'ALTER TABLE chain_transaction_inbox ALTER COLUMN ingestion_hint DROP NOT NULL',
      'ALTER TABLE chain_transaction_inbox DROP CONSTRAINT chain_transaction_inbox_ingestion_hint_check',
      `ALTER TABLE chain_transaction_inbox DROP CONSTRAINT chain_transaction_inbox_deferred_check;
       ALTER TABLE chain_transaction_inbox ADD CONSTRAINT chain_transaction_inbox_deferred_check CHECK (TRUE)`,
      'ALTER TABLE chain_transaction_inbox_claim_scheduler ALTER COLUMN consecutive_urgent_claims SET DEFAULT 2',
    ];
    for (const drift of replayDrift) {
      await pool.query('BEGIN');
      try {
        await pool.query(drift);
        await assert.rejects(pool.query(sql), /incompatible/u, drift);
      } finally {
        await pool.query('ROLLBACK');
      }
    }
  });
});

async function migrationSql(): Promise<string> {
  const sql = await readFile(migrationUrl, 'utf8').catch(() => '');
  assert.notEqual(sql, '', 'migration 047 must exist');
  return sql;
}

async function withDatabase(context: TestContext, run: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: tracked trade migration PG16 tests skipped');
    return;
  }
  const schema = `inbox_tracked_${randomUUID().replaceAll('-', '')}`;
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

async function applyThrough046(pool: pg.Pool): Promise<void> {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name) && name < migrationName).sort();
  assert.equal(names.at(-1), '046_listener_strict_catch_up_runs.sql');
  for (const name of names) {
    await pool.query(await readFile(new URL(name, migrationsDirectory), 'utf8'));
    await pool.query('INSERT INTO migration_history(version) VALUES ($1)', [name]);
  }
}

async function insertInbox(pool: pg.Pool, overrides: Readonly<Record<string, unknown>>): Promise<void> {
  const row: Readonly<Record<string, unknown>> = {
    signature: randomUUID(), observed_slot: 1, discovery_sources: ['WEBSOCKET'], program_ids: [program],
    target_confirmation_status: 'confirmed', processing_status: 'PENDING', observed_at: observedAt, ...overrides,
  };
  const columns = Object.keys(row);
  await pool.query(`INSERT INTO chain_transaction_inbox (${columns.join(',')})
    VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(row));
}

async function assertCatalog(pool: pg.Pool): Promise<void> {
  assert.deepEqual((await pool.query(`SELECT enumlabel FROM pg_enum
    WHERE enumtypid='chain_transaction_inbox_priority'::REGTYPE ORDER BY enumsortorder`)).rows,
  ['NORMAL', 'LAUNCH_CANDIDATE', 'TRACKED_TRADE'].map((enumlabel) => ({ enumlabel })));
  assert.equal((await pool.query(`SELECT GREATEST('NORMAL'::chain_transaction_inbox_priority,
    'LAUNCH_CANDIDATE'::chain_transaction_inbox_priority,'TRACKED_TRADE'::chain_transaction_inbox_priority)::TEXT AS priority`)).rows[0]?.priority,
  'TRACKED_TRADE');
  assert.deepEqual((await pool.query(`SELECT attname, format_type(atttypid,atttypmod) AS type, attnotnull,
    pg_get_expr(adbin,adrelid) AS default_value
    FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid=attrelid AND adnum=attnum
    WHERE attrelid='chain_transaction_inbox'::REGCLASS AND attname IN ('ingestion_priority','ingestion_hint','ingestion_hint_mint')
    ORDER BY attname`)).rows, [
    { attname: 'ingestion_hint', type: 'text', attnotnull: true, default_value: "'NONE'::text" },
    { attname: 'ingestion_hint_mint', type: 'text', attnotnull: false, default_value: null },
    { attname: 'ingestion_priority', type: 'chain_transaction_inbox_priority', attnotnull: true,
      default_value: "'NORMAL'::chain_transaction_inbox_priority" },
  ]);
  assert.deepEqual((await pool.query(`SELECT attname FROM pg_attribute
    WHERE attrelid='chain_transaction_inbox_claim_scheduler'::REGCLASS AND attnum>0 AND NOT attisdropped ORDER BY attnum`)).rows,
  ['scheduler_key', 'consecutive_urgent_claims', 'created_at', 'updated_at'].map((attname) => ({ attname })));
  assert.deepEqual((await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid='chain_transaction_inbox'::REGCLASS
    AND conname IN ('chain_transaction_inbox_ingestion_hint_check','chain_transaction_inbox_deferred_check')
    AND convalidated ORDER BY conname`)).rows, [
    { conname: 'chain_transaction_inbox_deferred_check' }, { conname: 'chain_transaction_inbox_ingestion_hint_check' },
  ]);
  assert.deepEqual((await pool.query(`SELECT typname FROM pg_type WHERE typnamespace=(SELECT oid FROM pg_namespace WHERE nspname=CURRENT_SCHEMA())
    AND typname LIKE 'chain_transaction_inbox_priority%' ORDER BY typname`)).rows, [{ typname: 'chain_transaction_inbox_priority' }]);
}
