import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrations = new URL('../migrations/', import.meta.url);
const previousMigrationName = '058_transaction_inbox_funding_attribution.sql';
const migrationName = '059_transaction_inbox_qualification_attribution.sql';
const migrationUrl = new URL(migrationName, migrations);
const diagnosticCodes = [
  'QUALIFICATION_CONNECT_FAILED',
  'QUALIFICATION_POSTGRES_SERIALIZATION',
  'QUALIFICATION_POSTGRES_DEADLOCK',
  'QUALIFICATION_DATA_INVALID',
  'QUALIFICATION_LAUNCH_MISSING',
  'QUALIFICATION_REBUILD_UNKNOWN',
  'QUALIFICATION_PERSISTENCE_UNKNOWN',
  'QUALIFICATION_CLEANUP_FAILED',
] as const;

void test('059 is forward-only, preserves 058 and pins its exact checksum', async () => {
  const names = await readdir(migrations);
  assert.ok(names.includes(migrationName));
  const previous = await readFile(new URL(previousMigrationName, migrations), 'utf8');
  assert.equal(
    createHash('sha256').update(previous).digest('hex'),
    '3444226ddb94be10c91711d1ec867be12bd96971b9ff8fbd29db883be45ea63f',
  );
  const sql = await readFile(migrationUrl, 'utf8');
  for (const code of diagnosticCodes) assert.ok(sql.includes(code), code);
  assert.match(sql, /terminal_attributions_taxonomy_check/u);
  assert.match(sql, /ERRCODE='23514'/u);
  assert.doesNotMatch(sql, /\b(?:DROP TABLE|TRUNCATE|DELETE|UPDATE|INSERT)\b/iu);

  const catalog = await readFile(
    new URL('../src/execution-migrations/live-catalog.ts', import.meta.url),
    'utf8',
  );
  const checksum = createHash('sha256').update(sql).digest('hex');
  assert.ok(catalog.includes(`${migrationName} ${checksum}`));
});

void test('059 installs, upgrades exact 058, replays and preserves journal state', async (context) => {
  await withSchema(context, async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), migrationName);
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await insertParent(pool, 'empty-install');
    await insertQualificationDiagnostics(pool, 'empty-install');
  });

  await withSchema(context, async (pool) => {
    await applyThrough(pool, previousMigrationName);
    await insertParent(pool, 'upgrade');
    await pool.query(`INSERT INTO transaction_inbox_terminal_attributions (
      signature,source,occurrence_number,processing_outcome,worker_cycle_attempt,
      worker_recovery_count,retryable,retry_exhausted,stage,origin,diagnostic_code,
      slot,transaction_index,confirmation_status,completeness,captured_at,purge_after
    ) VALUES ('upgrade','WORKER',1,'FAILED',1,0,TRUE,FALSE,'qualification',NULL,
      'WALLET_GRAPH_DATA_INVALID',1,0,'confirmed','COMPLETE',
      '2026-09-27T10:00:00.000Z','2026-09-27T14:00:00.000Z')`);
    await pool.query(`INSERT INTO transaction_inbox_terminal_attributions (
      signature,source,occurrence_number,processing_outcome,worker_cycle_attempt,
      worker_recovery_count,retryable,retry_exhausted,stage,origin,diagnostic_code,
      slot,transaction_index,confirmation_status,completeness,captured_at,purge_after
    ) SELECT 'upgrade','WORKER',10+ordinality,'FAILED',1,0,TRUE,FALSE,NULL,NULL,code,
      1,0,'confirmed','COMPLETE','2026-09-27T10:00:00.000Z'::TIMESTAMPTZ,
      '2026-09-27T14:00:00.000Z'::TIMESTAMPTZ FROM unnest(ARRAY[
        'FUNDING_OBSERVATION_VALIDATE','FUNDING_OBSERVATION_EXTRACT',
        'FUNDING_OBSERVATION_RECORD','PUMPSWAP_PERSISTENCE_UNKNOWN'
      ]) WITH ORDINALITY AS legacy(code,ordinality)`);
    const before = await preservedState(pool);

    assert.deepEqual(await migrateDatabase({ pool }), [migrationName]);
    assert.deepEqual(await preservedState(pool), before);
    await pool.query(await readFile(migrationUrl, 'utf8'));
    assert.deepEqual(await preservedState(pool), before);
    await insertQualificationDiagnostics(pool, 'upgrade');
  });
});

void test('059 rejects absent, duplicate, drifted and adjacent vocabularies', async (context) => {
  await withSchema(context, async (pool) => {
    await applyThrough(pool, previousMigrationName);
    const sql = await readFile(migrationUrl, 'utf8');
    const drifts = [
      'ALTER TABLE transaction_inbox_terminal_attributions DROP CONSTRAINT terminal_attributions_taxonomy_check',
      `DO $duplicate$ DECLARE definition TEXT; BEGIN
        SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
        WHERE conrelid='transaction_inbox_terminal_attributions'::REGCLASS
          AND conname='terminal_attributions_taxonomy_check';
        EXECUTE 'ALTER TABLE transaction_inbox_terminal_attributions ADD CONSTRAINT terminal_attributions_taxonomy_duplicate ' || definition;
      END $duplicate$`,
      `ALTER TABLE transaction_inbox_terminal_attributions
        DROP CONSTRAINT terminal_attributions_taxonomy_check,
        ADD CONSTRAINT terminal_attributions_taxonomy_check CHECK (TRUE)`,
      `ALTER TABLE transaction_inbox_terminal_attributions
        DROP CONSTRAINT terminal_attributions_taxonomy_check,
        ADD CONSTRAINT terminal_attributions_taxonomy_check
        CHECK (diagnostic_code<>'QUALIFICATION_CONNECT_FAIL')`,
      `ALTER TABLE transaction_inbox_terminal_attributions
        DROP CONSTRAINT terminal_attributions_taxonomy_check,
        ADD CONSTRAINT terminal_attributions_taxonomy_check
        CHECK (diagnostic_code<>'QUALIFICATION_RETRY')`,
    ];
    for (const upgraded of [false, true]) {
      if (upgraded) await pool.query(sql);
      for (const drift of drifts) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(drift);
          await assert.rejects(client.query(sql), { code: '23514' }, drift);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      }
    }
  });
});

void test('059 rejects adjacent codes, wrong stages, null bypasses and incompatible provenance', async (context) => {
  await withSchema(context, async (pool) => {
    await migrateDatabase({ pool });
    await insertParent(pool, 'restricted');
    await insertQualificationDiagnostics(pool, 'restricted');
    for (const code of diagnosticCodes) {
      for (const assignment of [
        "stage='wallet_graph'", 'stage=NULL', "source='CATCH_UP'",
        `source='CATCH_UP',processing_outcome='QUARANTINED',occurrence_number=1,
          worker_cycle_attempt=NULL,worker_recovery_count=NULL,retryable=NULL,
          retry_exhausted=NULL,stage=NULL,catch_up_cause_kind='LOCATOR',
          catch_up_reason_code='PUMP_SCHEMA_UNSUPPORTED'`,
        "processing_outcome='QUARANTINED'", "catch_up_cause_kind='LOCATOR'",
        "catch_up_reason_code='PUMP_SCHEMA_UNSUPPORTED'", "wire_surface='INSTRUCTION'",
        "diagnostic_code='QUALIFICATION_RETRY'", "diagnostic_code='QUALIFICATION_CONNECT_FAIL'",
      ]) {
        await assert.rejects(pool.query(`UPDATE transaction_inbox_terminal_attributions
          SET ${assignment} WHERE diagnostic_code=$1`, [code]), { code: '23514' }, assignment);
      }
    }
  });
});

async function insertParent(pool: pg.Pool, signature: string): Promise<void> {
  await pool.query(`INSERT INTO chain_transaction_inbox
    (signature,observed_slot,discovery_sources,program_ids,target_confirmation_status,observed_at)
    VALUES ($1,1,ARRAY['WEBSOCKET'],ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
      'confirmed','2026-09-27T10:00:00.000Z')`, [signature]);
}

async function insertQualificationDiagnostics(pool: pg.Pool, signature: string): Promise<void> {
  for (const [index, diagnosticCode] of diagnosticCodes.entries()) {
    await pool.query(`INSERT INTO transaction_inbox_terminal_attributions (
      signature,source,occurrence_number,processing_outcome,worker_cycle_attempt,
      worker_recovery_count,retryable,retry_exhausted,stage,origin,diagnostic_code,
      slot,transaction_index,confirmation_status,completeness,captured_at,purge_after
    ) VALUES ($1,'WORKER',$2,'FAILED',$2,0,TRUE,$3,'qualification',NULL,$4,
      1,0,'confirmed','COMPLETE','2026-09-27T10:00:00.000Z',
      '2026-09-27T14:00:00.000Z')`, [
      signature,
      index + 2,
      index === diagnosticCodes.length - 1,
      diagnosticCode,
    ]);
  }
  assert.deepEqual((await pool.query<{ diagnostic_code: string }>(`SELECT diagnostic_code FROM
    transaction_inbox_terminal_attributions WHERE signature=$1
    AND diagnostic_code LIKE 'QUALIFICATION_%' ORDER BY diagnostic_code`,
  [signature])).rows.map(({ diagnostic_code }) => diagnostic_code), [...diagnosticCodes].sort());
}

async function preservedState(pool: pg.Pool): Promise<readonly unknown[]> {
  const queries = [
    `SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='transaction_inbox_terminal_attributions'
      ORDER BY ordinal_position`,
    `SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema()
      AND tablename='transaction_inbox_terminal_attributions' ORDER BY indexname`,
    `SELECT grantee,privilege_type FROM information_schema.role_table_grants
      WHERE table_schema=current_schema() AND table_name='transaction_inbox_terminal_attributions'
      ORDER BY grantee,privilege_type`,
    `SELECT *
      FROM transaction_inbox_terminal_attributions ORDER BY signature,source,occurrence_number`,
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='transaction_inbox_terminal_attributions'::REGCLASS
      AND conname='terminal_attributions_retention_check'`,
  ];
  return Promise.all(queries.map(async (query) =>
    (await pool.query<Record<string, unknown>>(query)).rows));
}

async function applyThrough(pool: pg.Pool, head: string): Promise<void> {
  const names = (await readdir(migrations))
    .filter((name) => /^\d+_.*\.sql$/u.test(name) && name <= head)
    .sort();
  for (const name of names) {
    await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    await pool.query('INSERT INTO migration_history(version) VALUES ($1)', [name]);
  }
}

async function withSchema(
  context: TestContext,
  run: (pool: pg.Pool) => Promise<void>,
): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) { context.skip('TEST_DATABASE_URL absent'); return; }
  const schema = `qualification_attribution_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 4,
  });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}
