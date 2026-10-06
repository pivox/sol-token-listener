import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationsUrl = new URL('../migrations/', import.meta.url);
const migrationName = '056_transaction_inbox_bounded_tracking.sql';
const migrationUrl = new URL(migrationName, migrationsUrl);

const indexDefinitions = Object.freeze({
  trading_candidates_worker_tracking_expiry_idx:
    `CREATE INDEX trading_candidates_worker_tracking_expiry_idx ON trading_candidates USING btree (eligible_until, mint) WHERE ((superseded_at IS NULL) AND (state = 'ELIGIBLE'::text) AND (confirmation_status <> 'orphaned'::text))`,
  execution_intents_worker_tracking_mint_idx:
    `CREATE INDEX execution_intents_worker_tracking_mint_idx ON execution_intents USING btree (mint) WHERE (terminal_at IS NULL)`,
  execution_live_positions_worker_tracking_mint_idx:
    `CREATE INDEX execution_live_positions_worker_tracking_mint_idx ON execution_live_positions USING btree (mint) WHERE (state = ANY (ARRAY['OPEN'::text, 'EXIT_PENDING'::text, 'UNKNOWN'::text]))`,
} as const);

void test('056 defines only the three bounded-tracking indexes and restricted live-mint view', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const migrationNames = (await readdir(migrationsUrl))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right));

  assert.equal(migrationNames.at(-1), '061_execution_live_position_ledger.sql');
  assert.equal((sql.match(/\bCREATE INDEX\b/gu) ?? []).length, 3);
  assert.equal((sql.match(/\bCREATE VIEW\b/gu) ?? []).length, 1);
  assert.equal((sql.match(/\bLOCK TABLE\b/gu) ?? []).length, 1);
  assert.match(sql, /LOCK TABLE trading_candidates,execution_intents,execution_live_positions\s+IN SHARE MODE/iu);
  for (const [indexName, definition] of Object.entries(indexDefinitions)) {
    assert.ok(sql.includes(indexName), indexName);
    for (const key of definition.match(/\((?:eligible_until, mint|mint)\)/gu) ?? []) {
      assert.ok(sql.includes(key), `${indexName}: ${key}`);
    }
  }
  assert.match(sql, /listener_worker_tracking_live_mints/gu);
  assert.match(sql, /security_barrier\s*=\s*true/iu);
  assert.match(sql, /REVOKE ALL (?:PRIVILEGES )?ON (?:TABLE )?listener_worker_tracking_live_mints FROM PUBLIC/iu);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/iu);
  assert.doesNotMatch(sql, /\bCREATE UNIQUE INDEX\b/iu);
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL|DOUBLE PRECISION)\b/iu);
  assert.doesNotMatch(sql, /private[_ ]?key|keypair|send[_ ]?transaction|submit[_ ]?transaction/iu);
  assert.doesNotMatch(sql, /transaction_inbox.*demot|demot.*transaction_inbox/iu);
});

void test('056 installs from empty, upgrades from 055 and replays without replacing objects',
  async (context) => {
    await withSchema(context, async (pool) => {
      const applied = await migrateDatabase({ pool });
      assert.equal(applied.length, 61);
      assert.equal(applied.at(-1), '061_execution_live_position_ledger.sql');
      assert.deepEqual(await migrateDatabase({ pool }), []);
      const identities = await objectIdentities(pool);
      const sql = await readFile(migrationUrl, 'utf8');
      await pool.query(sql);
      await pool.query(sql);
      assert.deepEqual(await objectIdentities(pool), identities);
      await assertExactCatalog(pool);
      await assertRestrictedView(pool);
    });

    await withSchema(context, async (pool) => {
      await applyThrough055(pool);
      const before = await pool.query(`SELECT COUNT(*)::TEXT AS count FROM migration_history`);
      await pool.query(await readFile(migrationUrl, 'utf8'));
      assert.deepEqual(before.rows, [{ count: '55' }]);
      await assertExactCatalog(pool);
    });
  });

void test('056 rejects incompatible named indexes and direct live-mint view drift', async (context) => {
  await withSchema(context, async (pool) => {
    await migrateDatabase({ pool });
    const sql = await readFile(migrationUrl, 'utf8');
    const drifts = [
      `DROP INDEX execution_intents_worker_tracking_mint_idx`,
      `DROP INDEX trading_candidates_worker_tracking_expiry_idx;
       CREATE INDEX trading_candidates_worker_tracking_expiry_idx
       ON execution_intents (mint)`,
      `DROP INDEX trading_candidates_worker_tracking_expiry_idx;
       CREATE INDEX trading_candidates_worker_tracking_expiry_idx
       ON trading_candidates (mint,eligible_until)
       WHERE superseded_at IS NULL AND state='ELIGIBLE'
         AND confirmation_status<>'orphaned'`,
      `DROP INDEX trading_candidates_worker_tracking_expiry_idx;
       CREATE INDEX trading_candidates_worker_tracking_expiry_idx
       ON trading_candidates (eligible_until,mint)
       WHERE superseded_at IS NULL AND state='ELIGIBLE'`,
      `DROP INDEX execution_intents_worker_tracking_mint_idx;
       CREATE UNIQUE INDEX execution_intents_worker_tracking_mint_idx
       ON execution_intents (mint) WHERE terminal_at IS NULL`,
      `DROP INDEX execution_live_positions_worker_tracking_mint_idx;
       CREATE INDEX execution_live_positions_worker_tracking_mint_idx
       ON execution_live_positions (mint) WHERE state='OPEN'`,
      `UPDATE pg_index SET indisvalid=FALSE
       WHERE indexrelid='execution_intents_worker_tracking_mint_idx'::REGCLASS`,
      `UPDATE pg_index SET indisready=FALSE
       WHERE indexrelid='execution_live_positions_worker_tracking_mint_idx'::REGCLASS`,
      `DROP VIEW listener_worker_tracking_live_mints;
       CREATE VIEW listener_worker_tracking_live_mints WITH (security_barrier=true) AS
       SELECT mint FROM execution_live_positions WHERE state='OPEN'`,
      `ALTER VIEW listener_worker_tracking_live_mints SET (security_barrier=false)`,
      `DROP VIEW listener_worker_tracking_live_mints;
       CREATE VIEW listener_worker_tracking_live_mints WITH (security_barrier=true) AS
       SELECT mint,state FROM execution_live_positions
       WHERE state IN ('OPEN','EXIT_PENDING','UNKNOWN')`,
    ];
    for (const drift of drifts) {
      await pool.query('BEGIN');
      try {
        await pool.query('SET LOCAL allow_system_table_mods=on');
        await pool.query(drift);
        await assert.rejects(pool.query(sql), (error: unknown) =>
          error instanceof Error && 'code' in error && error.code === '23514', drift);
      } finally {
        await pool.query('ROLLBACK');
      }
    }
  });
});

void test('056 indexes serve 100000-row candidate, intent and live membership plans',
  { timeout: 240_000 }, async (context) => {
    await withSchema(context, async (pool) => {
      await migrateDatabase({ pool });
      await pool.query('SET session_replication_role=replica');
      try {
        await pool.query(`INSERT INTO trading_candidates (
          candidate_id,mint,report_id,source_event_id,candidate_event_id,strategy_id,
          strategy_version,evidence_fingerprint,confirmation_status,state,quote_mint,
          quote_decimals,quote_token_program,reason_codes,eligible_until,created_at,
          purge_after,payload_version,payload
        ) SELECT 'candidate_'||lpad(to_hex(series),64,'0'),
          'mint-'||lpad(series::TEXT,10,'0'),'report-'||series,'source-'||series,
          'candidate-event-'||series,'tracking',1,md5(series::TEXT)||md5(series::TEXT),
          'confirmed','ELIGIBLE','So11111111111111111111111111111111111111112',9,
          'SPL_TOKEN','["QUALIFIED_ENTRY"]'::JSONB,
          TIMESTAMPTZ '2026-09-28 00:00:00+00' + series*INTERVAL '1 millisecond',
          TIMESTAMPTZ '2026-09-27 00:00:00+00',
          TIMESTAMPTZ '2026-09-27 04:00:00+00',1,'{}'::JSONB
          FROM generate_series(1,100000) series`);
        await pool.query(`INSERT INTO execution_intents (
          id,logical_order_key,strategy_id,strategy_version,position_id,
          logical_command_id,mint,side,venue_policy,quote_mint,quote_token_program,
          quote_decimals,quote_amount_raw,minimum_amount_out_raw,decision_event_id,
          decision_fingerprint,requested_at,expires_at,status
        ) SELECT 'intent-'||series,'logical-'||series,'tracking',1,'position-'||series,
          'command-'||series,'intent-mint-'||lpad(series::TEXT,10,'0'),'BUY',
          'PUMP_FUN_ONLY','So11111111111111111111111111111111111111112','SPL_TOKEN',
          9,1,1,'decision-'||series,md5(series::TEXT)||md5(series::TEXT),
          TIMESTAMPTZ '2026-09-27 00:00:00+00',
          TIMESTAMPTZ '2026-09-27 00:01:00+00','PENDING'
          FROM generate_series(1,100000) series`);
        await pool.query(`INSERT INTO execution_live_positions (
          position_id,buy_intent_id,generation_id,armament_id,wallet_public_key,mint,
          quote_mint,entry_venue,quote_cost_raw,base_amount_raw,remaining_base_raw,
          fee_lamports,maximum_holding_ms,opened_at,exit_deadline_at,
          entry_reconciliation_fingerprint,state
        ) SELECT 'execution_live_position_'||md5('p'||series)||md5('p'||series),
          'execution_intent_'||md5('i'||series)||md5('i'||series),
          'execution_wallet_generation_'||md5('g'||series)||md5('g'||series),
          'execution_activation_armament_'||md5('a'||series)||md5('a'||series),
          '11111111111111111111111111111111',
          '11111111111111111111111111111111','So11111111111111111111111111111111111111112',
          'PUMP_FUN',1,1,1,0,30000,TIMESTAMPTZ '2026-09-27 00:00:00+00',
          TIMESTAMPTZ '2026-09-27 00:00:30+00',md5(series::TEXT)||md5(series::TEXT),
          CASE series%3 WHEN 0 THEN 'OPEN' WHEN 1 THEN 'EXIT_PENDING' ELSE 'UNKNOWN' END
          FROM generate_series(1,100000) series`);
        await pool.query(`INSERT INTO execution_live_positions (
          position_id,buy_intent_id,generation_id,armament_id,wallet_public_key,mint,
          quote_mint,entry_venue,quote_cost_raw,base_amount_raw,remaining_base_raw,
          fee_lamports,maximum_holding_ms,opened_at,exit_deadline_at,
          entry_reconciliation_fingerprint,state,exit_intent_id,
          exit_reconciliation_fingerprint,closed_at,purge_after
        ) VALUES (
          'execution_live_position_'||repeat('c',64),
          'execution_intent_'||repeat('c',64),
          'execution_wallet_generation_'||repeat('c',64),
          'execution_activation_armament_'||repeat('c',64),
          '11111111111111111111111111111111','22222222222222222222222222222222',
          'So11111111111111111111111111111111111111112','PUMP_FUN',1,1,0,0,30000,
          TIMESTAMPTZ '2026-09-27 00:00:00+00',
          TIMESTAMPTZ '2026-09-27 00:00:30+00',repeat('c',64),'CLOSED',
          'execution_intent_'||repeat('d',64),repeat('d',64),
          TIMESTAMPTZ '2026-09-27 00:00:10+00',
          TIMESTAMPTZ '2026-09-27 04:00:10+00')`);
      } finally {
        await pool.query('SET session_replication_role=origin');
      }
      for (const table of ['trading_candidates', 'execution_intents', 'execution_live_positions']) {
        await pool.query(`ANALYZE ${table}`);
      }
      assert.deepEqual((await pool.query(`SELECT COUNT(*)::TEXT AS count,
        COUNT(*) FILTER (WHERE mint='22222222222222222222222222222222')::TEXT
          AS closed_count FROM listener_worker_tracking_live_mints`)).rows,
      [{ count: '100000', closed_count: '0' }]);
      await pool.query('SET enable_seqscan=off');
      await assertPlanUses(pool, `SELECT mint FROM trading_candidates
        WHERE superseded_at IS NULL AND state='ELIGIBLE'
          AND confirmation_status<>'orphaned'
          AND eligible_until>TIMESTAMPTZ '2026-09-28 00:01:39+00'
        ORDER BY eligible_until,mint LIMIT 1`,
      'trading_candidates_worker_tracking_expiry_idx');
      await assertPlanUses(pool, `SELECT 1 FROM execution_intents
        WHERE mint='intent-mint-0000050000' AND terminal_at IS NULL LIMIT 1`,
      'execution_intents_worker_tracking_mint_idx');
      await assertPlanUses(pool, `SELECT 1 FROM execution_live_positions
        WHERE mint='11111111111111111111111111111111'
          AND state IN ('OPEN','EXIT_PENDING','UNKNOWN') LIMIT 1`,
      'execution_live_positions_worker_tracking_mint_idx');
    });
  });

async function assertExactCatalog(pool: pg.Pool): Promise<void> {
  const rows = await pool.query<{ readonly indexname: keyof typeof indexDefinitions;
    readonly indexdef: string }>(`SELECT index_relation.relname AS indexname,
      regexp_replace(pg_get_indexdef(index_relation.oid),' ON [^ ]+\\.',' ON ') AS indexdef
      FROM pg_class index_relation
      WHERE index_relation.relnamespace=current_schema()::REGNAMESPACE
        AND index_relation.relname IN (
        'trading_candidates_worker_tracking_expiry_idx',
        'execution_intents_worker_tracking_mint_idx',
        'execution_live_positions_worker_tracking_mint_idx') ORDER BY index_relation.relname`);
  assert.equal(rows.rows.length, 3);
  for (const row of rows.rows) assert.equal(row.indexdef, indexDefinitions[row.indexname]);
}

async function assertRestrictedView(pool: pg.Pool): Promise<void> {
  assert.deepEqual((await pool.query(`SELECT attribute.attname,
      format_type(attribute.atttypid,attribute.atttypmod) AS type
    FROM pg_attribute attribute
    WHERE attribute.attrelid='listener_worker_tracking_live_mints'::REGCLASS
      AND attribute.attnum>0 AND NOT attribute.attisdropped
    ORDER BY attribute.attnum`)).rows, [{ attname: 'mint', type: 'text' }]);
  assert.deepEqual((await pool.query(`SELECT relation.relkind,relation.reloptions,
      relation.relowner=(SELECT relowner FROM pg_class
        WHERE oid='execution_live_positions'::REGCLASS) AS same_owner,
      pg_get_viewdef(relation.oid,TRUE) AS definition
    FROM pg_class relation WHERE relation.oid='listener_worker_tracking_live_mints'::REGCLASS`)).rows, [{
    relkind: 'v', reloptions: ['security_barrier=true'], same_owner: true,
    definition: ` SELECT mint\n   FROM execution_live_positions\n  WHERE state = ANY (ARRAY['OPEN'::text, 'EXIT_PENDING'::text, 'UNKNOWN'::text]);`,
  }]);
  assert.equal((await pool.query<{ readonly allowed: boolean }>(`SELECT has_table_privilege(
    'public','listener_worker_tracking_live_mints','SELECT') AS allowed`)).rows[0]?.allowed, false);
}

async function objectIdentities(pool: pg.Pool): Promise<readonly unknown[]> {
  return (await pool.query<Readonly<{ readonly relname: string; readonly oid: number }>>(
    `SELECT relation.relname,relation.oid FROM pg_class relation
    WHERE relation.relnamespace=current_schema()::REGNAMESPACE AND relation.relname IN (
      'trading_candidates_worker_tracking_expiry_idx',
      'execution_intents_worker_tracking_mint_idx',
      'execution_live_positions_worker_tracking_mint_idx',
      'listener_worker_tracking_live_mints') ORDER BY relation.relname`,
  )).rows;
}

async function assertPlanUses(pool: pg.Pool, query: string, indexName: string): Promise<void> {
  const result = await pool.query(`EXPLAIN (FORMAT JSON) ${query}`);
  assert.match(JSON.stringify(result.rows), new RegExp(indexName, 'u'));
}

async function applyThrough055(pool: pg.Pool): Promise<void> {
  for (const name of (await readdir(migrationsUrl))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/u.test(name) && name < migrationName)
    .sort((left, right) => left.localeCompare(right))) {
    await pool.query(await readFile(new URL(name, migrationsUrl), 'utf8'));
    await pool.query(`INSERT INTO migration_history(version) VALUES ($1)`, [name]);
  }
}

async function withSchema(context: TestContext, run: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: bounded tracking migration PostgreSQL 16 tests skipped');
    return;
  }
  const schema = `bounded_tracking_${randomUUID().replaceAll('-', '')}`;
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
