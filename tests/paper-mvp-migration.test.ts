import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { migrateDatabase } from '../src/storage/database.js';

const migrationUrl = new URL('../migrations/018_paper_mvp_validation.sql', import.meta.url);
const collectionMigrationUrl = new URL('../migrations/019_paper_mvp_collection.sql', import.meta.url);
const derivedPnlMigrationUrl = new URL('../migrations/020_paper_mvp_derived_pnl.sql', import.meta.url);
const runnerHardeningMigrationUrl = new URL('../migrations/021_paper_mvp_runner_hardening.sql', import.meta.url);
const coverageIndexesMigrationUrl = new URL('../migrations/022_paper_mvp_coverage_indexes.sql', import.meta.url);
const exactStrategyMigrationUrl = new URL('../migrations/023_paper_mvp_exact_strategy.sql', import.meta.url);
const positionCoverageMigrationUrl = new URL('../migrations/024_paper_mvp_position_coverage.sql', import.meta.url);
const effectiveConfigurationMigrationUrl = new URL('../migrations/025_paper_mvp_effective_configuration.sql', import.meta.url);

void test('defines replayable paper MVP runs and immutable samples', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS paper_mvp_runs/u);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS paper_mvp_position_samples/u);
  assert.match(sql, /initial_capital_raw NUMERIC\(78,0\) NOT NULL/u);
  assert.match(sql, /network_fee_raw_per_transaction NUMERIC\(78,0\) NOT NULL/u);
  assert.match(sql, /buy_amount_in_raw NUMERIC\(78,0\)/u);
  assert.match(sql, /model_net_pnl_raw NUMERIC\(78,0\)/u);
  assert.match(sql, /configuration_payload JSONB NOT NULL/u);
  assert.match(sql, /sample_payload JSONB NOT NULL/u);
  assert.match(sql, /report_payload JSONB/u);
  assert.match(sql, /payload_version INTEGER NOT NULL CHECK \(payload_version = 1\)/u);
  assert.match(sql, /state IN \('RUNNING','COMPLETED','FAILED'\)/u);
  assert.match(sql, /purge_after = terminal_at \+ INTERVAL '4 hours'/u);
  assert.match(sql, /paper_mvp_runs_one_active_idx/u);
  assert.match(sql, /WHERE state = 'RUNNING'/u);
  assert.match(sql, /REFERENCES paper_mvp_runs\(run_id\) ON DELETE CASCADE/u);
  assert.match(sql, /sample_status IN \('VALID','UNKNOWN'\)/u);
  assert.match(sql, /sample_status = 'UNKNOWN' AND unknown_reason IS NOT NULL/u);
  assert.match(sql, /paper-mvp-unknown-position\.v1/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS entry_decision_at TIMESTAMPTZ/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS close_event_id TEXT REFERENCES domain_events\(event_id\)/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS exit_trigger_at TIMESTAMPTZ/u);
  assert.doesNotMatch(sql, /entry_decision_job_id|quote_observed_at|paper_positions_mvp_collect_idx|POSITION_RETRACTED/u);
  assert.match(sql, /prevent_paper_mvp_sample_mutation/u);
  assert.match(sql, /prevent_paper_mvp_run_immutable_mutation/u);
  assert.doesNotMatch(sql, /\b(?:FLOAT|REAL|DOUBLE PRECISION)\b/iu);
  assert.doesNotMatch(sql, /DROP TABLE|private[_ ]?key|keypair|send[_ ]?transaction/iu);
});

void test('defines the collection upgrade without rewriting migration 018', async () => {
  const sql = await readFile(collectionMigrationUrl, 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS entry_decision_job_id TEXT/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS quote_observed_at TIMESTAMPTZ/u);
  assert.match(sql, /paper_positions_mvp_collect_idx/u);
  assert.match(sql, /POSITION_RETRACTED/u);
  assert.match(sql, /entry_decision_at IS NULL OR entry_decision_at <= opened_at/u);
  assert.match(sql, /exit_trigger_at IS NULL OR closed_at IS NULL OR exit_trigger_at <= closed_at/u);
});

void test('widens only the derived model PnL for two 78-digit network fees', async () => {
  const sql = await readFile(derivedPnlMigrationUrl, 'utf8');
  assert.match(sql, /ALTER COLUMN model_net_pnl_raw TYPE NUMERIC\(79,0\)/u);
  assert.doesNotMatch(sql, /ALTER COLUMN (?!model_net_pnl_raw)/u);
});

void test('adds durable runner ownership and completion reason without rewriting reports', async () => {
  const sql = await readFile(runnerHardeningMigrationUrl, 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS runner_owner_id TEXT/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS completion_reason TEXT/u);
  assert.match(sql, /'TARGET_REACHED','TIMEOUT','SIGINT','SIGTERM','LEGACY'/u);
  assert.match(sql, /jsonb_set\(report_payload, '\{completionReason\}', '"LEGACY"'::jsonb, true\)/u);
  assert.match(sql, /state='RUNNING'.*runner_owner_id IS NOT NULL.*completion_reason IS NULL/su);
  assert.match(sql, /state='COMPLETED'.*runner_owner_id IS NULL.*completion_reason IS NOT NULL/su);
  assert.match(sql, /\(report_payload->>'completionReason'=completion_reason\) IS TRUE/u);
  assert.match(sql, /state='FAILED'.*runner_owner_id IS NULL.*completion_reason IS NULL/su);
});

void test('adds replayable covering indexes for bounded paper MVP coverage scans', async () => {
  const sql = await readFile(coverageIndexesMigrationUrl, 'utf8');
  assert.match(sql, /CREATE INDEX IF NOT EXISTS token_launches_paper_mvp_coverage_idx[\s\S]*\(detected_at, mint\)/u);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS trading_candidates_paper_mvp_coverage_idx[\s\S]*\(strategy_id, strategy_version, created_at, mint\)/u);
  assert.doesNotMatch(sql, /DROP\s|DELETE\s|UPDATE\s|private[_ ]?key|keypair/iu);
});

void test('versions the exact paper MVP strategy configuration and leaves v1 rows fail-closed', async () => {
  const sql = await readFile(exactStrategyMigrationUrl, 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS external_unique_buyers_target INTEGER/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS take_profit_multiplier_bps NUMERIC\(78,0\)/u);
  assert.match(sql, /payload_version IN \(1,2\)/u);
  assert.match(sql, /payload_version=1[\s\S]*external_unique_buyers_target IS NULL/u);
  assert.match(sql, /payload_version=2[\s\S]*external_unique_buyers_target IS NOT NULL/u);
  assert.doesNotMatch(sql, /UPDATE paper_mvp_runs[\s\S]*external_unique_buyers_target/iu);
});

void test('adds replayable bounded opened and open position coverage', async () => {
  const sql = await readFile(positionCoverageMigrationUrl, 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS opened_positions INTEGER NOT NULL DEFAULT 0/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS open_positions INTEGER NOT NULL DEFAULT 0/u);
  assert.match(sql, /open_positions BETWEEN 0 AND opened_positions/u);
  assert.match(sql, /paper_positions_mvp_open_coverage_idx/u);
  assert.doesNotMatch(sql, /report_payload|jsonb_set/iu);
});

void test('fences every effective paper strategy input without rewriting v1 or v2 rows', async () => {
  const sql = await readFile(effectiveConfigurationMigrationUrl, 'utf8');
  for (const column of [
    'entry_quote_amount_raw','slippage_bps','minimum_confirmation','entry_window_ms',
    'quote_max_age_ms','quote_max_slot_lag','creation_entry_max_age_ms',
    'creation_entry_max_slot_lag','external_minimum_buy_amount_raw','manual_kill_switch',
    'maximum_round_trip_loss_bps','decision_poll_interval_ms','decision_lease_ms',
    'decision_retry_max_attempts','decision_retry_base_delay_ms',
    'qualification_profile_fingerprint',
  ]) assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, 'u'));
  assert.match(sql, /payload_version IN \(1,2,3\)/u);
  assert.match(sql, /paper-mvp-run-configuration\.v3/u);
  assert.match(sql, /payload_version=1[\s\S]*entry_quote_amount_raw IS NULL/u);
  assert.match(sql, /payload_version=2[\s\S]*entry_quote_amount_raw IS NULL/u);
  assert.match(sql, /payload_version=3[\s\S]*entry_quote_amount_raw > 0/u);
  assert.match(sql, /qualification_profile_fingerprint ~ '\^\[a-f0-9\]\{64\}\$'/u);
  assert.doesNotMatch(sql, /UPDATE paper_mvp_runs/u);
});

void test('migration 024 preserves an immutable historical paper-mvp.v1 payload', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL v1 report preservation test skipped');
    return;
  }
  const schema = `paper_mvp_report_v1_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const directory = new URL('../migrations/', import.meta.url);
    const throughExactStrategy = (await readdir(directory))
      .filter((name) => /^(?:00[1-9]|01[0-9]|02[0-3])_[a-z0-9_-]+\.sql$/u.test(name))
      .sort((left, right) => left.localeCompare(right));
    for (const name of throughExactStrategy) {
      await pool.query(await readFile(new URL(name,directory),'utf8'));
    }
    const historicalReport = Object.freeze({
      schemaVersion:'paper-mvp.v1',runId:'historical-v1',completionReason:'LEGACY',
      technicalStatus:'COMPLETED',verdict:'PASS',failedGateCodes:Object.freeze([]),
    });
    await pool.query(`INSERT INTO paper_mvp_runs (
      run_id,strategy_id,strategy_version,quote_mint,target_closed_positions,
      initial_capital_raw,network_fee_raw_per_transaction,max_duration_ms,
      provider_identity,state,started_at,deadline_at,updated_at,terminal_at,
      purge_after,verdict,payload_version,configuration_payload,report_payload,
      runner_owner_id,completion_reason
    ) VALUES ('historical-v1','creation-entry-v1',1,'SOL',1,1000,5,60000,
      'probe','COMPLETED',$1,$2,$2,$2,$3,'PASS',1,'{}',$4,NULL,'LEGACY')`, [
      new Date(1_000),new Date(61_000),new Date(14_461_000),JSON.stringify(historicalReport),
    ]);

    const sql = await readFile(positionCoverageMigrationUrl,'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const row = (await pool.query(`SELECT report_payload,opened_positions,open_positions
      FROM paper_mvp_runs WHERE run_id='historical-v1'`)).rows[0];
    assert.deepEqual(row?.report_payload,historicalReport);
    assert.equal(row?.opened_positions,0);
    assert.equal(row?.open_positions,0);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

void test('applies migrations 001-033 on an empty schema and replays cleanly', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL paper MVP migration test skipped');
    return;
  }
  const schema = `paper_mvp_migration_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const applied = await migrateDatabase({ pool });
    assert.equal(applied.at(-1), '033_execution_simulation_artifacts.sql');
    assert.deepEqual(await migrateDatabase({ pool }), []);
    await pool.query('SET enable_seqscan=off');
    const launchPlan = await pool.query<Readonly<{ 'QUERY PLAN': string }>>(`EXPLAIN (COSTS OFF)
      SELECT mint FROM token_launches
      WHERE detected_at BETWEEN NOW() - INTERVAL '1 hour' AND NOW()
      ORDER BY detected_at,mint LIMIT 1000001`);
    const candidatePlan = await pool.query<Readonly<{ 'QUERY PLAN': string }>>(`EXPLAIN (COSTS OFF)
      SELECT DISTINCT mint FROM trading_candidates
      WHERE strategy_id='creation-entry-v1' AND strategy_version=1
        AND created_at BETWEEN NOW() - INTERVAL '1 hour' AND NOW()
      ORDER BY mint LIMIT 1000001`);
    assert.match(launchPlan.rows.map((row) => row['QUERY PLAN']).join('\n'),
      /token_launches_paper_mvp_coverage_idx/u);
    assert.match(candidatePlan.rows.map((row) => row['QUERY PLAN']).join('\n'),
      /trading_candidates_paper_mvp_coverage_idx/u);
    const sql = await readFile(collectionMigrationUrl, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const exactStrategySql = await readFile(exactStrategyMigrationUrl, 'utf8');
    await pool.query(exactStrategySql);
    await pool.query(exactStrategySql);
    const effectiveConfigurationSql = await readFile(effectiveConfigurationMigrationUrl, 'utf8');
    await pool.query(effectiveConfigurationSql);
    await pool.query(effectiveConfigurationSql);
    const tables = await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema=current_schema()
        AND table_name IN ('paper_mvp_runs','paper_mvp_position_samples')
      ORDER BY table_name`);
    assert.deepEqual(tables.rows, [
      { table_name: 'paper_mvp_position_samples' },
      { table_name: 'paper_mvp_runs' },
    ]);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

void test('upgrades a database that already applied immutable migration 018', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL paper MVP upgrade test skipped');
    return;
  }
  const schema = `paper_mvp_upgrade_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const directory = new URL('../migrations/', import.meta.url);
    const legacy = (await readdir(directory))
      .filter((name) => /^0(?:0[1-9]|1[0-8])_[a-z0-9_-]+\.sql$/u.test(name))
      .sort((left, right) => left.localeCompare(right));
    for (const name of legacy) await pool.query(await readFile(new URL(name, directory), 'utf8'));
    assert.equal((await pool.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='paper_trades'
        AND column_name='quote_observed_at'`)).rowCount, 0);
    await pool.query(`INSERT INTO token_launches (
      mint,launchpad,program_id,creator,token_program,quote_assets,current_state,
      created_signature,created_slot,created_transaction_index,created_instruction_index,
      created_inner_instruction_index,detected_at,updated_at
    ) VALUES ('MINT','pumpfun','pump','creator','SPL_TOKEN','[]','ACTIVE',
      'signature',1,0,0,NULL,$1,$1)`, [new Date(1_100)]);
    await pool.query(`INSERT INTO paper_positions (
      position_id,mint,quote_mint,quote_decimals,quote_token_program,strategy_id,
      strategy_version,status,base_filled_raw,remaining_base_raw,quote_cost_raw,
      round_trip_loss_bps,entry_trade_id,open_command_hash,trigger_event_id,
      payload_version,payload,opened_at,entry_decision_at
    ) VALUES ('historical','MINT','SOL',9,'SPL_TOKEN','creation-entry-v1',1,
      'PAPER_HOLDING',1,1,1,0,'historical-buy','historical-open','historical-source',
      1,'{}',$1,$2)`, [new Date(1_400),new Date(1_200)]);

    const upgrade = await readFile(collectionMigrationUrl, 'utf8');
    await pool.query(upgrade);
    assert.equal((await pool.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='paper_trades'
        AND column_name='quote_observed_at'`)).rowCount, 1);
    assert.deepEqual((await pool.query(`SELECT entry_decision_job_id
      FROM paper_positions WHERE position_id='historical'`)).rows, [
      { entry_decision_job_id:null },
    ]);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

void test('backfills legacy run owners and completion reasons without changing report evaluation', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL paper MVP hardening upgrade test skipped');
    return;
  }
  const schema = `paper_mvp_hardening_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const directory = new URL('../migrations/', import.meta.url);
    const legacy = (await readdir(directory))
      .filter((name) => /^(?:00[1-9]|01[0-9]|020)_[a-z0-9_-]+\.sql$/u.test(name))
      .sort((left, right) => left.localeCompare(right));
    for (const name of legacy) await pool.query(await readFile(new URL(name, directory), 'utf8'));
    const historicalReport = Object.freeze({
      schemaVersion: 'paper-mvp.v1', technicalStatus: 'COMPLETED', verdict: 'PASS',
      failedGateCodes: Object.freeze([]), preserved: Object.freeze({ exact: true }),
    });
    const insert = `INSERT INTO paper_mvp_runs (
      run_id,strategy_id,strategy_version,quote_mint,target_closed_positions,
      initial_capital_raw,network_fee_raw_per_transaction,max_duration_ms,
      provider_identity,state,started_at,deadline_at,updated_at,terminal_at,
      purge_after,verdict,failure_code,payload_version,configuration_payload,report_payload
    ) VALUES ($1,'creation-entry-v1',1,'SOL',1,1000,5,60000,'probe',$2,
      $3::timestamptz,$3::timestamptz + INTERVAL '60 seconds',$4::timestamptz,
      $5::timestamptz,$6::timestamptz,$7,$8,1,'{}'::jsonb,$9::jsonb)`;
    await pool.query(insert, ['legacy-running','RUNNING','2026-08-27T00:00:00Z',
      '2026-08-27T00:00:01Z',null,null,null,null,null]);
    await pool.query(insert, ['legacy-completed','COMPLETED','2026-08-27T00:00:00Z',
      '2026-08-27T00:01:00Z','2026-08-27T00:01:00Z','2026-08-27T04:01:00Z',
      'PASS',null,JSON.stringify(historicalReport)]);
    await pool.query(insert, ['legacy-failed','FAILED','2026-08-27T00:00:00Z',
      '2026-08-27T00:01:00Z','2026-08-27T00:01:00Z','2026-08-27T04:01:00Z',
      null,'RUN_FAILED',null]);

    const hardening = await readFile(runnerHardeningMigrationUrl, 'utf8');
    await pool.query(hardening);
    await pool.query(hardening);
    const rows = (await pool.query(`SELECT run_id,state,runner_owner_id,completion_reason,
      report_payload FROM paper_mvp_runs ORDER BY run_id`)).rows;
    const completed = rows.find((row) => row.run_id === 'legacy-completed');
    const failed = rows.find((row) => row.run_id === 'legacy-failed');
    const running = rows.find((row) => row.run_id === 'legacy-running');
    assert.match(String(running?.runner_owner_id), /^legacy:[a-f0-9]{32}$/u);
    assert.equal(running?.completion_reason, null);
    assert.equal(completed?.runner_owner_id, null);
    assert.equal(completed?.completion_reason, 'LEGACY');
    assert.deepEqual(completed?.report_payload, {
      ...historicalReport, completionReason: 'LEGACY',
    });
    assert.equal(failed?.runner_owner_id, null);
    assert.equal(failed?.completion_reason, null);
    for (const [runId, reportPayload] of [
      ['invalid-completed-missing-reason', '{}'],
      ['invalid-completed-null-reason', '{"completionReason":null}'],
    ] as const) {
      await assert.rejects(pool.query(`INSERT INTO paper_mvp_runs (
        run_id,strategy_id,strategy_version,quote_mint,target_closed_positions,
        initial_capital_raw,network_fee_raw_per_transaction,max_duration_ms,
        provider_identity,state,started_at,deadline_at,updated_at,terminal_at,
        purge_after,verdict,failure_code,payload_version,configuration_payload,
        report_payload,runner_owner_id,completion_reason
      ) VALUES ($1,'creation-entry-v1',1,'SOL',1,1000,5,60000,'probe','COMPLETED',
        '2026-08-27T00:00:00Z','2026-08-27T00:01:00Z','2026-08-27T00:01:00Z',
        '2026-08-27T00:01:00Z','2026-08-27T04:01:00Z','FAIL',NULL,1,'{}'::jsonb,
        $2::jsonb,NULL,'TIMEOUT')`, [runId, reportPayload]), /runner_lifecycle|check constraint/iu);
    }
    await assert.rejects(
      pool.query("UPDATE paper_mvp_runs SET runner_owner_id=NULL WHERE run_id='legacy-running'"),
      /runner_lifecycle|check constraint/iu,
    );
    await assert.rejects(
      pool.query("UPDATE paper_mvp_runs SET completion_reason='TIMEOUT' WHERE run_id='legacy-completed'"),
      /terminal.*immutable/iu,
    );
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z_][a-z0-9_]*$/u);
  return `"${identifier}"`;
}
