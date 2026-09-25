import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import type { PoolClient } from 'pg';

const ACTIVE_STATES = [
  'BUY_PENDING',
  'PAPER_HOLDING',
  'WAITING_EXTERNAL_BUYS',
  'EXIT_PENDING_QUOTE',
  'SELL_PENDING',
  'MANUAL_REVIEW',
] as const;

const FOUNDATION_MIGRATIONS = [
  '001_initial.sql',
  '002_pumpfun_foundation.sql',
  '003_pumpfun_observations.sql',
  '004_paper_trading.sql',
  '005_pumpswap_market.sql',
  '006_api_event_stream.sql',
  '007_participant_analytics.sql',
  '008_wallet_graph.sql',
  '009_transaction_ingestion.sql',
  '010_transaction_inbox_timestamps.sql',
  '011_transaction_inbox_retry_recovery.sql',
  '012_public_social_evidence.sql',
  '013_paper_e2e.sql',
  '014_social_persistence_retry.sql',
  '015_paper_active_session_per_mint.sql',
  '016_listener_catch_up_gaps.sql',
  '017_creation_entry_strategy.sql',
] as const;
const TARGET_MIGRATION = '055_creation_entry_single_active_session.sql';

void test('055 admits one concurrent creation entry globally and releases admission after terminalization', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  const schema = `paper_singleton_race_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 4,
  });
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrateFoundationAndTarget(pool);
    const firstLineage = await seedLineage(pool, 1);
    const secondLineage = await seedLineage(pool, 2);
    const firstPid = await backendPid(first);
    const secondPid = await backendPid(second);

    await first.query('BEGIN');
    await second.query('BEGIN');
    await second.query("SET LOCAL lock_timeout='5s'");
    await insertActiveSession(first, firstLineage);
    const competingInsert = insertActiveSession(second, secondLineage).then(
      () => Object.freeze({ kind:'inserted' as const, error:null }),
      (error: unknown) => Object.freeze({ kind:'failed' as const, error }),
    );

    assert.equal(await waitsFor(firstPid, secondPid, pool), true);
    await first.query('COMMIT');
    const rejected = await competingInsert;
    assert.equal(rejected.kind, 'failed');
    assert.equal(postgresErrorCode(rejected.error), '23505');
    assert.equal(
      postgresConstraint(rejected.error),
      'paper_strategy_sessions_creation_entry_active_singleton_idx',
    );
    await second.query('ROLLBACK');

    await pool.query(`UPDATE paper_strategy_sessions
      SET state='MANUAL_REVIEW',reason_code='RECONCILIATION_REQUIRED',
        updated_at=to_timestamp(2),terminal_at=to_timestamp(2),
        purge_after=to_timestamp(2) + INTERVAL '4 hours'
      WHERE session_id=$1`, [firstLineage.sessionId]);

    await assert.rejects(
      () => insertActiveSession(second, secondLineage),
      (error: unknown) => postgresErrorCode(error) === '23505'
        && postgresConstraint(error) === 'paper_strategy_sessions_creation_entry_active_singleton_idx',
    );

    await pool.query(`UPDATE paper_strategy_sessions
      SET state='PAPER_RETRACTED',updated_at=to_timestamp(3),terminal_at=to_timestamp(3),
        purge_after=to_timestamp(3) + INTERVAL '4 hours'
      WHERE session_id=$1`, [firstLineage.sessionId]);

    await second.query('BEGIN');
    await insertActiveSession(second, secondLineage);
    await second.query('COMMIT');
    const active = await pool.query<{ readonly session_id: string }>(`
      SELECT session_id FROM paper_strategy_sessions
      WHERE strategy_id='creation-entry-v1' AND state=ANY($1::text[])
      ORDER BY session_id`, [ACTIVE_STATES]);
    assert.deepEqual(active.rows, [{ session_id:secondLineage.sessionId }]);
  } finally {
    await first.query('ROLLBACK').catch(() => undefined);
    await second.query('ROLLBACK').catch(() => undefined);
    first.release();
    second.release();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

async function migrateFoundationAndTarget(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  for (const migration of [...FOUNDATION_MIGRATIONS, TARGET_MIGRATION]) {
    const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
    await pool.query(sql);
  }
}

interface SessionLineage {
  readonly mint: string;
  readonly reportId: string;
  readonly candidateId: string;
  readonly sourceEventId: string;
  readonly sessionEventId: string;
  readonly sessionId: string;
  readonly openCommandId: string;
}

async function seedLineage(
  pool: InstanceType<typeof pg.Pool>,
  sequence: 1 | 2,
): Promise<SessionLineage> {
  const digit = String(sequence);
  const mint = `MINT-${digit}`;
  const rawEventId = `raw-${digit}`;
  const sourceEventId = `launch-${digit}`;
  const qualificationEventId = `qualification-${digit}`;
  const candidateEventId = `candidate-event-${digit}`;
  const sessionEventId = `session-event-${digit}`;
  const reportId = `qreport_${digit.repeat(64)}`;
  const candidateId = `candidate_${digit.repeat(64)}`;
  const sessionId = `paper_session_${digit.repeat(64)}`;
  const openCommandId = `paper_open_${digit.repeat(64)}`;
  const signature = `signature-${digit}`;
  const slot = String(10 + sequence);

  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,current_state,created_signature,
    created_slot,created_transaction_index,created_instruction_index,detected_at,updated_at
  ) VALUES ($1,'pumpfun','pump','creator','SPL_TOKEN','DETECTED',$2,$3,0,1,
    to_timestamp(1),to_timestamp(1))`, [mint,signature,slot]);
  await pool.query(`INSERT INTO raw_chain_events (
    event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
    confirmation_status,observed_at,payload_version,payload
  ) VALUES ($1,'pumpfun','pump',$2,$3,$4,0,1,'confirmed',to_timestamp(1),1,'{}')`, [
    rawEventId,mint,signature,slot,
  ]);
  for (const [eventId,type,source] of [
    [sourceEventId,'TokenLaunchDetected','pumpfun'],
    [qualificationEventId,'QualificationUpdated','qualification'],
    [candidateEventId,'TradingCandidateUpdated','paper-decision'],
    [sessionEventId,'PaperStrategySessionUpdated','paper-decision'],
  ] as const) {
    await pool.query(`INSERT INTO domain_events (
      event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
      instruction_index,confirmation_status,observed_at,payload_version,payload
    ) VALUES ($1,$2,$3,$4,$5,'pump',$6,$7,0,1,'confirmed',to_timestamp(1),1,'{}')`, [
      eventId,rawEventId,type,mint,source,signature,slot,
    ]);
  }
  await pool.query(`INSERT INTO qualification_reports (
    report_id,mint,source_event_id,source_raw_event_id,qualification_event_id,
    profile_id,profile_version,profile_fingerprint,evidence_fingerprint,verdict,
    preparation_score,social_score,onchain_score,total_score,as_of_slot,
    as_of_transaction_index,as_of_instruction_index,confirmation_status,evaluated_at,
    purge_after,payload_version,payload
  ) VALUES ($1,$2,$3,$4,$5,'pumpfun-mvp-technical-v1',1,$6,$7,'QUALIFIED',
    0,0,40,40,$8,0,1,'confirmed',to_timestamp(1),to_timestamp(1)+INTERVAL '4 hours',1,'{}')`, [
    reportId,mint,sourceEventId,rawEventId,qualificationEventId,
    digit.repeat(64),digit.repeat(64),slot,
  ]);
  await pool.query(`INSERT INTO trading_candidates (
    candidate_id,mint,report_id,source_event_id,candidate_event_id,strategy_id,
    strategy_version,evidence_fingerprint,confirmation_status,state,quote_mint,
    quote_decimals,quote_token_program,reason_codes,eligible_until,created_at,
    purge_after,payload_version,payload
  ) VALUES ($1,$2,$3,$4,$5,'creation-entry-v1',1,$6,'confirmed','ELIGIBLE','SOL',
    9,'SPL_TOKEN','["QUALIFIED_ENTRY"]',to_timestamp(46),to_timestamp(1),
    to_timestamp(1)+INTERVAL '4 hours',1,'{}')`, [
    candidateId,mint,reportId,sourceEventId,candidateEventId,digit.repeat(64),
  ]);
  return Object.freeze({
    mint,reportId,candidateId,sourceEventId,sessionEventId,sessionId,openCommandId,
  });
}

async function insertActiveSession(
  client: PoolClient,
  lineage: SessionLineage,
): Promise<void> {
  await client.query(`INSERT INTO paper_strategy_sessions (
    session_id,mint,candidate_id,report_id,source_event_id,session_event_id,
    strategy_id,strategy_version,actor_kind,state,reason_code,quote_mint,quote_decimals,
    quote_token_program,position_id,open_command_id,entry_slot,entry_transaction_index,
    entry_instruction_index,external_buy_target,external_buy_count,minimum_confirmation,
    created_at,updated_at,payload_version,payload
  ) VALUES ($1,$2,$3,$4,$5,$6,'creation-entry-v1',1,'PAPER_SIMULATION',
    'BUY_PENDING','QUALIFIED_ENTRY','SOL',9,'SPL_TOKEN',NULL,$7,10,0,1,10,0,
    'confirmed',to_timestamp(1),to_timestamp(1),2,'{}')`, [
    lineage.sessionId,lineage.mint,lineage.candidateId,lineage.reportId,
    lineage.sourceEventId,lineage.sessionEventId,lineage.openCommandId,
  ]);
}

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ readonly pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error('PostgreSQL backend pid is unavailable.');
  return pid;
}

async function waitsFor(
  blockerPid: number,
  waiterPid: number,
  pool: InstanceType<typeof pg.Pool>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ readonly blocked: boolean }>(
      'SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked',
      [blockerPid,waiterPid],
    );
    if (result.rows[0]?.blocked === true) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function postgresErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' ? error.code : null;
}

function postgresConstraint(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'constraint' in error
    && typeof error.constraint === 'string' ? error.constraint : null;
}
