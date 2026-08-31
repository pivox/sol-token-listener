import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { migrateDatabase } from '../src/storage/database.js';

const migrationName = '032_execution_dry_run_assessments.sql';
const latestMigrationName = '033_execution_simulation_artifacts.sql';
const migrationUrl = new URL(`../migrations/${migrationName}`, import.meta.url);
const migrationsUrl = new URL('../migrations/', import.meta.url);
const hash = 'a'.repeat(64);
const assessmentId = `execution_dry_run_assessment_${'b'.repeat(64)}`;

void test('execution dry-run assessment migration defines an additive, inert contract', async () => {
  const sql = withoutSqlComments(await readFile(migrationUrl, 'utf8'));
  const definition = /CREATE TABLE IF NOT EXISTS execution_dry_run_assessments \(([\s\S]*?)\);/u
    .exec(sql)?.[1];
  assert.ok(definition !== undefined);
  for (const column of [
    'assessment_id TEXT PRIMARY KEY', 'payload_version SMALLINT NOT NULL DEFAULT 1',
    "specification_version TEXT NOT NULL DEFAULT '1.4.0'", 'evaluator_version INTEGER NOT NULL DEFAULT 1',
    'intent_id TEXT NOT NULL', 'strategy_id TEXT NOT NULL', 'strategy_version INTEGER NOT NULL',
    'decision_fingerprint TEXT NOT NULL', 'intent_state_revision BIGINT NOT NULL',
    'intent_status TEXT NOT NULL', 'input_fingerprint TEXT NOT NULL', 'result_fingerprint TEXT NOT NULL',
    "outcome TEXT NOT NULL DEFAULT 'FOUNDATION_VALIDATED'", "coverage TEXT NOT NULL DEFAULT 'INTENT_AND_LEASE_ONLY'",
    "quote_status TEXT NOT NULL DEFAULT 'NOT_RUN'", "build_status TEXT NOT NULL DEFAULT 'NOT_RUN'",
    "simulation_status TEXT NOT NULL DEFAULT 'NOT_RUN'", "signature_status TEXT NOT NULL DEFAULT 'NOT_RUN'",
    "submission_status TEXT NOT NULL DEFAULT 'NOT_RUN'",
  ]) assert.match(definition, new RegExp(column.replaceAll(' ', '\\s+'), 'u'));
  assert.match(definition, /recorded_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+date_trunc\('milliseconds',\s+statement_timestamp\(\)\)/u);
  assert.match(definition, /UNIQUE\s*\(intent_id,\s*evaluator_version\)/u);
  assert.match(definition, /FOREIGN KEY\s*\(\s*intent_id,\s*strategy_id,\s*strategy_version,\s*decision_fingerprint\s*\)\s*REFERENCES execution_intents\s*\(\s*id,\s*strategy_id,\s*strategy_version,\s*decision_fingerprint\s*\)\s*ON DELETE CASCADE/u);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS execution_intents_assessment_identity_idx\s+ON execution_intents \(id, strategy_id, strategy_version, decision_fingerprint\)/u);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS execution_dry_run_assessments_recorded_at_intent_id_idx\s+ON execution_dry_run_assessments \(recorded_at, intent_id\)/u);
  for (const check of [
    /assessment_id ~ '\^execution_dry_run_assessment_\[0-9a-f\]\{64\}\$'/u,
    /intent_id ~ '\^execution_intent_\[0-9a-f\]\{64\}\$'/u,
    /decision_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/u,
    /input_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/u,
    /result_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/u,
    /octet_length\(strategy_id\) BETWEEN 1 AND 256/u,
    /strategy_version BETWEEN 1 AND 2147483647/u,
    /evaluator_version = 1/u,
    /intent_state_revision >= 0/u,
    /intent_status IN \('PENDING', 'RETRY_READY'\)/u,
    /outcome = 'FOUNDATION_VALIDATED'/u,
    /coverage = 'INTENT_AND_LEASE_ONLY'/u,
    /quote_status = 'NOT_RUN'/u, /build_status = 'NOT_RUN'/u,
    /simulation_status = 'NOT_RUN'/u, /signature_status = 'NOT_RUN'/u,
    /submission_status = 'NOT_RUN'/u,
    /isfinite\(recorded_at\)/u,
    /recorded_at <= TIMESTAMPTZ '275760-09-13 00:00:00\.000\+00'/u,
    /date_trunc\('milliseconds', recorded_at\) = recorded_at/u,
  ]) assert.match(definition, check);
  assert.doesNotMatch(definition, /\b(?:json|payload(?!_version)|mint|amount|quote(?!_status)|wallet|signature(?!_status)|transaction|secret|arbitrary)\b/iu);
  assert.doesNotMatch(sql, /ALTER TABLE\s+(?:execution_intents|execution_attempts|execution_intent_transitions)/iu);
});

void test('catalogue query exposes delete action only for foreign keys', async () => {
  const source = await readFile(new URL(import.meta.url), 'utf8');
  assert.match(
    source,
    /CASE WHEN c\.contype = 'f' THEN c\.confdeltype END AS confdeltype/u,
  );
});

void test('execution dry-run migration applies, upgrades 031, and replays safely', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution dry-run migration test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_dry_run_apply', async (pool) => {
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), latestMigrationName);
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await pool.query(await readFile(migrationUrl, 'utf8'));

    const names = (await readdir(migrationsUrl)).filter((name) => /^0(?:0[1-9]|[12][0-9]|3[01])_[a-z0-9_-]+\.sql$/u.test(name)).sort();
    await withTemporarySchema(databaseUrl, 'execution_dry_run_upgrade', async (upgradePool) => {
      await upgradePool.query('CREATE TABLE migration_history (version TEXT PRIMARY KEY)');
      for (const name of names) {
        await upgradePool.query(await readFile(new URL(name, migrationsUrl), 'utf8'));
        await upgradePool.query('INSERT INTO migration_history(version) VALUES ($1)', [name]);
      }
      const parent = parentDraft('upgrade');
      await insertParent(upgradePool, parent);
      assert.deepEqual(await migrateDatabase({ pool: upgradePool }), [
        migrationName,
        latestMigrationName,
      ]);
      assert.equal((await upgradePool.query('SELECT id FROM execution_intents WHERE id = $1', [parent.id])).rowCount, 1);
    });
  });
});

void test('execution dry-run assessments round-trip with exact catalogue identity and cascade', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution dry-run catalogue test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_dry_run_catalogue', async (pool) => {
    await migrateDatabase({ pool });
    const parent = parentDraft('catalogue');
    await insertParent(pool, parent);
    await insertAssessment(pool, parent);
    const roundTrip = await pool.query<{ readonly assessment_id: string; readonly intent_id: string; readonly state_revision: string }>(
      'SELECT assessment_id, intent_id, intent_state_revision::TEXT AS state_revision FROM execution_dry_run_assessments',
    );
    assert.deepEqual(roundTrip.rows, [{ assessment_id: assessmentId, intent_id: parent.id, state_revision: '0' }]);
    const columns = await pool.query<{ readonly column_name: string; readonly data_type: string }>(`SELECT column_name, data_type
      FROM information_schema.columns WHERE table_schema = current_schema()
        AND table_name = 'execution_dry_run_assessments' ORDER BY ordinal_position`);
    assert.deepEqual(columns.rows.map((row) => [row.column_name, row.data_type]), [
      ['assessment_id', 'text'], ['payload_version', 'smallint'], ['specification_version', 'text'], ['evaluator_version', 'integer'],
      ['intent_id', 'text'], ['strategy_id', 'text'], ['strategy_version', 'integer'], ['decision_fingerprint', 'text'],
      ['intent_state_revision', 'bigint'], ['intent_status', 'text'], ['input_fingerprint', 'text'], ['result_fingerprint', 'text'],
      ['outcome', 'text'], ['coverage', 'text'], ['quote_status', 'text'], ['build_status', 'text'], ['simulation_status', 'text'],
      ['signature_status', 'text'], ['submission_status', 'text'], ['recorded_at', 'timestamp with time zone'],
    ]);
    const constraints = await pool.query<{ readonly contype: string; readonly conkey: string; readonly confkey: string | null; readonly confdeltype: string | null }>(`SELECT c.contype, c.conkey::TEXT, c.confkey::TEXT,
      CASE WHEN c.contype = 'f' THEN c.confdeltype END AS confdeltype
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'execution_dry_run_assessments'
        AND t.relnamespace = current_schema()::regnamespace AND c.contype IN ('p', 'u', 'f') ORDER BY c.contype`);
    assert.deepEqual(constraints.rows, [
      { contype: 'f', conkey: '{5,6,7,8}', confkey: '{1,4,5,18}', confdeltype: 'c' },
      { contype: 'p', conkey: '{1}', confkey: null, confdeltype: null },
      { contype: 'u', conkey: '{5,4}', confkey: null, confdeltype: null },
    ]);
    const index = await pool.query<{ readonly indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema()
      AND indexname = 'execution_dry_run_assessments_recorded_at_intent_id_idx'`);
    assert.match(index.rows[0]?.indexdef ?? '', /\(recorded_at, intent_id\)$/u);
    await pool.query('DELETE FROM execution_intents WHERE id = $1', [parent.id]);
    assert.equal((await pool.query('SELECT * FROM execution_dry_run_assessments')).rowCount, 0);
  });
});

void test('execution dry-run assessment rejects every invalid boundary and mismatched parent identity', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution dry-run invariant test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_dry_run_invariants', async (pool) => {
    await migrateDatabase({ pool });
    const parent = parentDraft('invariants');
    await insertParent(pool, parent);
    const invalid = [
      { payloadVersion: 2 }, { specificationVersion: '' }, { specificationVersion: '1.4.1' }, { evaluatorVersion: 0 }, { evaluatorVersion: 2 },
      { intentStatus: 'PROCESSING' }, { outcome: 'OTHER' }, { coverage: 'FULL' }, { quoteStatus: 'RUN' },
      { buildStatus: 'RUN' }, { simulationStatus: 'RUN' }, { signatureStatus: 'RUN' }, { submissionStatus: 'RUN' },
      { assessmentId: `execution_dry_run_assessment_${'A'.repeat(64)}` }, { intentId: `execution_intent_${'A'.repeat(64)}` },
      { inputFingerprint: 'A'.repeat(64) }, { resultFingerprint: 'short' }, { decisionFingerprint: 'A'.repeat(64) },
      { strategyId: '' }, { strategyId: 'é'.repeat(129) }, { strategyVersion: 0 }, { strategyVersion: 2_147_483_648 },
      { intentStateRevision: '-1' }, { recordedAt: 'infinity' }, { recordedAt: '1969-12-31T23:59:59.999Z' },
      { recordedAt: '1970-01-01T00:00:00.000001Z' }, { recordedAt: '275760-09-13T00:00:00.001Z' },
      { strategyId: 'different' }, { strategyVersion: 2 }, { decisionFingerprint: 'c'.repeat(64) },
    ] as const;
    for (const [index, overrides] of invalid.entries()) {
      await assert.rejects(insertAssessment(pool, parent, {
        assessmentId: `${assessmentId.slice(0, -2)}${index.toString().padStart(2, '0')}`,
        ...overrides,
      }));
    }
    const maximumParent = parentDraft('recorded-at-maximum');
    await insertParent(pool, maximumParent);
    await insertAssessment(pool, maximumParent, {
      assessmentId: `execution_dry_run_assessment_${'e'.repeat(64)}`,
      evaluatorVersion: 1,
      recordedAt: '275760-09-13T00:00:00.000Z',
    });
    await insertAssessment(pool, parent);
    await assert.rejects(insertAssessment(pool, parent, { evaluatorVersion: 1, assessmentId: `execution_dry_run_assessment_${'d'.repeat(64)}` }));
    const duplicateAssessmentParent = parentDraft('duplicate-assessment-id');
    await insertParent(pool, duplicateAssessmentParent);
    await assert.rejects(insertAssessment(pool, duplicateAssessmentParent));
  });
});

type Parent = ReturnType<typeof createExecutionIntentDraft>;
type Assessment = Readonly<{
  assessmentId: string; payloadVersion: number; specificationVersion: string; evaluatorVersion: number;
  intentId: string; strategyId: string; strategyVersion: number; decisionFingerprint: string;
  intentStateRevision: string; intentStatus: string; inputFingerprint: string; resultFingerprint: string;
  outcome: string; coverage: string; quoteStatus: string; buildStatus: string; simulationStatus: string;
  signatureStatus: string; submissionStatus: string; recordedAt: string;
}>;

function parentDraft(logicalCommandId: string): Parent {
  return createExecutionIntentDraft({
    strategyId: 'execution-dry-run', strategyVersion: 1, positionId: `position-${logicalCommandId}`,
    logicalCommandId, mint: '11111111111111111111111111111111', side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112', quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 1n, baseAmountRaw: null, minimumAmountOutRaw: 1n, decisionEventId: `event-${logicalCommandId}`,
    decisionFingerprint: hash, requestedAtMs: 0, expiresAtMs: 1_000,
  });
}

async function insertParent(pool: InstanceType<typeof pg.Pool>, parent: Parent): Promise<void> {
  await pool.query(`INSERT INTO execution_intents (
    id,payload_version,logical_order_key,strategy_id,strategy_version,position_id,logical_command_id,mint,side,venue_policy,
    quote_mint,quote_token_program,quote_decimals,quote_amount_raw,base_amount_raw,minimum_amount_out_raw,decision_event_id,
    decision_fingerprint,requested_at,expires_at,status,attempt_count,state_revision
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,$15,$16,$17,to_timestamp(0),to_timestamp(1),'PENDING',0,0)`, [
    parent.id, parent.payloadVersion, parent.logicalOrderKey, parent.strategyId, parent.strategyVersion, parent.positionId,
    parent.logicalCommandId, parent.mint, parent.side, parent.venuePolicy, parent.quoteMint, parent.quoteTokenProgram,
    parent.quoteDecimals, parent.quoteAmountRaw?.toString(), parent.minimumAmountOutRaw.toString(), parent.decisionEventId,
    parent.decisionFingerprint,
  ]);
}

async function insertAssessment(pool: InstanceType<typeof pg.Pool>, parent: Parent, overrides: Partial<Assessment> = {}): Promise<void> {
  const row: Assessment = {
    assessmentId, payloadVersion: 1, specificationVersion: '1.4.0', evaluatorVersion: 1, intentId: parent.id,
    strategyId: parent.strategyId, strategyVersion: parent.strategyVersion, decisionFingerprint: parent.decisionFingerprint,
    intentStateRevision: '0', intentStatus: 'PENDING', inputFingerprint: hash, resultFingerprint: 'b'.repeat(64),
    outcome: 'FOUNDATION_VALIDATED', coverage: 'INTENT_AND_LEASE_ONLY', quoteStatus: 'NOT_RUN', buildStatus: 'NOT_RUN',
    simulationStatus: 'NOT_RUN', signatureStatus: 'NOT_RUN', submissionStatus: 'NOT_RUN', recordedAt: '1970-01-01T00:00:00.000Z', ...overrides,
  };
  await pool.query(`INSERT INTO execution_dry_run_assessments (
    assessment_id,payload_version,specification_version,evaluator_version,intent_id,strategy_id,strategy_version,decision_fingerprint,
    intent_state_revision,intent_status,input_fingerprint,result_fingerprint,outcome,coverage,quote_status,build_status,simulation_status,
    signature_status,submission_status,recorded_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::TIMESTAMPTZ)`, [
    row.assessmentId,row.payloadVersion,row.specificationVersion,row.evaluatorVersion,row.intentId,row.strategyId,row.strategyVersion,
    row.decisionFingerprint,row.intentStateRevision,row.intentStatus,row.inputFingerprint,row.resultFingerprint,row.outcome,row.coverage,
    row.quoteStatus,row.buildStatus,row.simulationStatus,row.signatureStatus,row.submissionStatus,row.recordedAt,
  ]);
}

function testDatabaseUrl(context: Readonly<{ skip(message?: string): void }>, label: string): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') return databaseUrl;
  context.skip(`TEST_DATABASE_URL absent: ${label} skipped`);
  return null;
}

async function withTemporarySchema(databaseUrl: string, prefix: string, callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>): Promise<void> {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${quoteIdentifier(schema)}` });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`); created = true;
    await pool.query(`SET search_path TO ${quoteIdentifier(schema)}`); await callback(pool);
  } finally {
    try { await pool.end(); } finally {
      try { if (created) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`); } finally { await admin.end(); }
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
