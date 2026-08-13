import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createDeterministicDerivedEventId, type DomainEvent } from '../src/domain/events.js';
import { createPaperStrategySession } from '../src/domain/paper-strategy.js';
import type { PaperPosition } from '../src/domain/paper-trading.js';
import type { QualificationReport } from '../src/domain/qualification.js';
import { createTradingCandidate } from '../src/domain/trading-candidate.js';
import type { ChainCursor, TokenLaunch } from '../src/domain/types.js';
import type {
  PaperDecisionJobInput,
  PaperDecisionResult,
} from '../src/ports/paper-decision-repository.js';
import type { CanonicalQualificationProjection } from '../src/ports/qualification-projection-repository.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import { PostgresPaperDecisionRepository } from '../src/storage/paper-decision.repository.js';
import { PostgresPaperTradingRepository } from '../src/storage/paper-trading.repository.js';
import { toJsonValue } from '../src/utils/json.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MINT = 'So11111111111111111111111111111111111111112';
const RAW_EVENT_ID = 'raw_paper_source';
const SOURCE_EVENT_ID = 'evt_paper_source';
const TRADE_RAW_EVENT_ID = 'raw_paper_trade';
const TRADE_EVENT_ID = 'evt_paper_trade';
const FINGERPRINT = 'a'.repeat(64);
const QUALIFICATION_EVALUATED_AT_MS = Date.now();

void test('claims one idempotent job concurrently, renews it, and reports queue counts', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    const repository = new PostgresPaperDecisionRepository(pool, { maxAttempts: 3, baseDelayMs: 100 });
    await repository.enqueue(jobInput());
    await repository.enqueue(jobInput());
    const [left, right] = await Promise.all([
      repository.claim({ nowMs: 1_000, leaseMs: 1_000 }),
      repository.claim({ nowMs: 1_000, leaseMs: 1_000 }),
    ]);
    const claims = [left, right].filter((claim) => claim !== null);
    assert.equal(claims.length, 1);
    const claim = claims[0];
    assert.ok(claim);
    assert.match(claim.jobId, /^paper_job_[a-f0-9]{64}$/u);
    assert.equal(claim.attempts, 1);
    assert.equal(claim.maxAttempts, 3);
    assert.equal(await repository.renew(claim, 1_500, 1_000), true);
    assert.equal(await repository.renew(claim, 2_501, 1_000), false);
    assert.deepEqual(await repository.counts(), {
      pending: 0, processing: 1, retryableFailed: 0, exhausted: 0,
    });
  });
});

void test('loads the immutable launch when a later trade triggers the decision', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    await seedTrade(pool);
    const repository = new PostgresPaperDecisionRepository(pool);
    await repository.enqueueLatest(MINT, 'trade-signature', 'confirmed');

    const claim = await repository.claim({ nowMs: 2_000, leaseMs: 1_000 });
    assert.ok(claim);
    const snapshot = await repository.loadSnapshot(claim);

    assert.equal(snapshot.asOfEvent.id, TRADE_EVENT_ID);
    assert.equal(snapshot.launch.mint, MINT);
    assert.equal(snapshot.launch.creator, 'creator');
  });
});

void test('loads the current canonical qualification without a paper candidate', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    const persisted = canonicalProjection(decisionResult());
    const repository = new PostgresPaperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    const claimed = await repository.claim({ nowMs:1_000,leaseMs:1_000 });
    assert.ok(claimed);

    const snapshot = await repository.loadSnapshot(claimed);

    assert.deepEqual(snapshot.currentQualification,persisted);
    assert.equal(snapshot.currentCandidate,null);
    assert.equal(snapshot.currentDecision,null);
  });
});

void test('never writes qualification reports or QualificationUpdated events', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    const result=decisionResult();
    await pool.query(`CREATE FUNCTION reject_paper_qualification_write() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'paper qualification write'; END $$`);
    await pool.query(`CREATE TRIGGER reject_paper_report_write
      BEFORE INSERT OR UPDATE ON qualification_reports
      FOR EACH ROW EXECUTE FUNCTION reject_paper_qualification_write()`);
    await pool.query(`CREATE FUNCTION reject_paper_qualification_event() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.type='QualificationUpdated' THEN RAISE EXCEPTION 'paper qualification event'; END IF;
        RETURN NEW;
      END $$`);
    await pool.query(`CREATE TRIGGER reject_paper_qualification_event_write
      BEFORE INSERT ON domain_events FOR EACH ROW
      EXECUTE FUNCTION reject_paper_qualification_event()`);
    const repository=new PostgresPaperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    const claimed=await repository.claim({ nowMs:1_000,leaseMs:1_000 });
    assert.ok(claimed);

    await repository.complete(claimed,result);

    const counts=await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM qualification_reports) AS reports,
      (SELECT COUNT(*)::int FROM domain_events WHERE type='QualificationUpdated') AS events`);
    assert.deepEqual(counts.rows[0],{ reports:1,events:1 });
  });
});

void test('rejects a new candidate whose exact active qualification is missing before paper writes', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    const result=decisionResult();
    const foreignReportId=`qreport_${'9'.repeat(64)}`;
    const invalid=Object.freeze({
      ...result,candidate:Object.freeze({
        ...result.candidate,qualificationReportId:foreignReportId,
      }),
    });
    const repository=new PostgresPaperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    const claimed=await repository.claim({ nowMs:1_000,leaseMs:1_000 });
    assert.ok(claimed);

    await assert.rejects(repository.complete(claimed,invalid));

    const counts=await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM trading_candidates) AS candidates,
      (SELECT COUNT(*)::int FROM domain_events WHERE type='TradingCandidateUpdated') AS events`);
    assert.deepEqual(counts.rows[0],{ candidates:0,events:0 });
  });
});

for(const invalidState of ['superseded','orphaned','payload'] as const){
  void test(`rejects a new candidate backed by invalid ${invalidState} qualification data before paper writes`,async(context)=>{
    if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
    await withSchema(async(pool)=>{
      const result=decisionResult();
      await seed(pool);
      if(invalidState==='superseded'){
        const replacement=decisionResult('finalized',result.qualificationEvent.cursor,2_000,'e');
        await pool.query(
          `UPDATE raw_chain_events SET confirmation_status='finalized' WHERE event_id=$1`,
          [RAW_EVENT_ID],
        );
        await pool.query(
          `UPDATE domain_events SET confirmation_status='finalized' WHERE event_id=$1`,
          [SOURCE_EVENT_ID],
        );
        await replaceCurrentQualification(pool,canonicalProjection(replacement));
      }else if(invalidState==='orphaned'){
        await pool.query(
          `UPDATE domain_events SET confirmation_status='orphaned' WHERE event_id=$1`,
          [result.qualificationEvent.id],
        );
      }else{
        await pool.query(`UPDATE domain_events
          SET payload=jsonb_set(payload,'{reportId}',to_jsonb($2::text))
          WHERE event_id=$1`,[result.qualificationEvent.id,`qreport_${'0'.repeat(64)}`]);
      }
      const repository=new PostgresPaperDecisionRepository(pool);
      await repository.enqueue(jobInput());
      const claimed=await repository.claim({ nowMs:1_000,leaseMs:1_000 });
      assert.ok(claimed);

      await assert.rejects(repository.complete(claimed,result));

      const counts=await pool.query(`SELECT
        (SELECT COUNT(*)::int FROM trading_candidates) AS candidates,
        (SELECT COUNT(*)::int FROM domain_events WHERE type='TradingCandidateUpdated') AS events`);
      assert.deepEqual(counts.rows[0],{ candidates:0,events:0 });
    });
  });
}

void test('allows an existing candidate to reconcile its exact superseded qualification',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    await seedTrade(pool);
    const repository=new PostgresPaperDecisionRepository(pool);
    const entry=decisionResult();
    await repository.enqueue(jobInput());
    const first=await repository.claim({ nowMs:1_000,leaseMs:1_000 });
    assert.ok(first);
    await repository.complete(first,entry);
    const replacement=decisionResultAt(11n,2_000,'8');
    await replaceCurrentQualification(pool,canonicalProjection(replacement));
    await repository.enqueue(jobInput({
      sourceEventId:TRADE_EVENT_ID,sourceRawEventId:TRADE_RAW_EVENT_ID,
      inputFingerprint:'8'.repeat(64),
    }));
    const replay=await repository.claim({ nowMs:2_000,leaseMs:1_000 });
    assert.ok(replay);

    await repository.complete(replay,decisionWithSession(
      entry,'WAITING_EXTERNAL_BUYS',1,2_000,
    ));

    const candidates=await pool.query('SELECT candidate_id FROM trading_candidates');
    const positions=await pool.query('SELECT position_id FROM paper_positions');
    assert.equal(candidates.rowCount,1);
    assert.equal(positions.rowCount,0);
  });
});

void test('links a new candidate event to the exact qualification raw source',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    await seedTrade(pool);
    const repository=new PostgresPaperDecisionRepository(pool);
    await repository.enqueue(jobInput({
      sourceEventId:TRADE_EVENT_ID,sourceRawEventId:TRADE_RAW_EVENT_ID,
      inputFingerprint:'8'.repeat(64),
    }));
    const claimed=await repository.claim({ nowMs:2_000,leaseMs:1_000 });
    assert.ok(claimed);
    const result=Object.freeze({
      ...decisionResult(),session:null,sessionEvent:null,requestedAction:'NONE' as const,
    });

    await repository.complete(claimed,result);

    const persisted=await pool.query<{readonly raw_event_id:string}>(
      'SELECT raw_event_id FROM domain_events WHERE event_id=$1',[result.candidateEvent.id],
    );
    assert.deepEqual(persisted.rows,[{ raw_event_id:RAW_EVENT_ID }]);
  });
});

void test('keeps a claimed job usable after its lease is renewed', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    const repository = new PostgresPaperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    const claim = await repository.claim({ nowMs: 1_000, leaseMs: 1_000 });
    assert.ok(claim);

    assert.equal(await repository.renew(claim, 1_500, 1_000), true);
    const snapshot = await repository.loadSnapshot(claim);
    assert.equal(snapshot.launch.mint, MINT);
  });
});

void test('claims an orphaned source revision and reloads its paper lineage', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    const repository = new PostgresPaperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    const confirmed = await repository.claim({ nowMs: 1_000, leaseMs: 1_000 });
    assert.ok(confirmed);
    const decision = decisionResult();
    await repository.complete(confirmed, decision);

    await pool.query(
      `UPDATE raw_chain_events SET confirmation_status='orphaned' WHERE event_id=$1`,
      [RAW_EVENT_ID],
    );
    await pool.query(
      `UPDATE domain_events SET confirmation_status='orphaned' WHERE raw_event_id=$1`,
      [RAW_EVENT_ID],
    );
    await repository.enqueueLatest(MINT, 'signature', 'orphaned');
    const orphaned = await repository.claim({ nowMs: 2_000, leaseMs: 1_000 });
    assert.ok(orphaned);
    assert.equal(orphaned.sourceConfirmationStatus, 'orphaned');

    const snapshot = await repository.loadSnapshot(orphaned);
    assert.equal(snapshot.asOfEvent.confirmationStatus, 'orphaned');
    assert.ok(snapshot.currentCandidate);
    assert.ok(snapshot.currentSession);
    assert.ok(snapshot.currentDecision);

    const replay=Object.freeze({
      ...decision,
      report:snapshot.currentDecision.qualification.report,
      qualificationEvent:snapshot.currentDecision.qualification.qualificationEvent,
      candidateEvent:snapshot.currentDecision.candidateEvent,
      sessionEvent:decision.sessionEvent===null?null:Object.freeze({
        ...decision.sessionEvent,confirmationStatus:'orphaned' as const,
      }),
    });
    await repository.complete(orphaned,replay);
    const completed = await pool.query<{ readonly status: string }>(
      'SELECT status FROM paper_decision_jobs WHERE job_id=$1',
      [orphaned.jobId],
    );
    assert.deepEqual(completed.rows, [{ status:'COMPLETED' }]);
  });
});

void test('reloads the entry candidate when a later trade becomes orphaned', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    const repository = new PostgresPaperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    const entryJob = await repository.claim({ nowMs:1_000,leaseMs:1_000 });
    assert.ok(entryJob);
    const entry = decisionResult();
    await repository.complete(entryJob,entry);
    await seedTrade(pool);
    await pool.query(
      `UPDATE raw_chain_events SET confirmation_status='orphaned' WHERE event_id=$1`,
      [TRADE_RAW_EVENT_ID],
    );
    await pool.query(
      `UPDATE domain_events SET confirmation_status='orphaned' WHERE raw_event_id=$1`,
      [TRADE_RAW_EVENT_ID],
    );

    await repository.enqueueLatest(MINT,'trade-signature','orphaned');
    const orphaned = await repository.claim({ nowMs:2_000,leaseMs:1_000 });
    assert.ok(orphaned);
    const snapshot = await repository.loadSnapshot(orphaned);

    assert.equal(snapshot.asOfEvent.id,TRADE_EVENT_ID);
    assert.equal(snapshot.currentCandidate?.id,entry.candidate.id);
    assert.equal(snapshot.currentSession?.candidateId,entry.candidate.id);
    assert.equal(
      snapshot.currentDecision?.qualification.reportId,
      entry.candidate.qualificationReportId,
    );
  });
});

void test('retries with a bounded lease and cancels only after exhaustion', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    let nowMs = 1_000;
    const repository = new PostgresPaperDecisionRepository(pool, {
      maxAttempts: 2,
      baseDelayMs: 100,
      clock: () => nowMs,
    });
    await repository.enqueue(jobInput());
    const first = await repository.claim({ nowMs: 1_000, leaseMs: 500 });
    assert.ok(first);
    await repository.fail(first, {
      code: 'RPC_TRANSIENT', retryable: true, terminalResult: null,
    });
    assert.equal(await repository.claim({ nowMs: 1_099, leaseMs: 500 }), null);
    nowMs = 1_100;
    const second = await repository.claim({ nowMs: 1_100, leaseMs: 500 });
    assert.ok(second);
    await repository.fail(second, {
      code: 'RPC_TRANSIENT', retryable: true, terminalResult: null,
    });
    assert.deepEqual(await repository.counts(), {
      pending: 0, processing: 0, retryableFailed: 0, exhausted: 1,
    });
  });
});

void test('retry-only reconciliation failure preserves every paper domain row',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    const repository=new PostgresPaperDecisionRepository(pool,{
      maxAttempts:3,baseDelayMs:100,clock:()=>2_000,
    });
    await repository.enqueue(jobInput());
    const entryJob=await repository.claim({ nowMs:1_000,leaseMs:1_000 });
    assert.ok(entryJob);
    await repository.complete(entryJob,decisionResult());
    await seedTrade(pool);
    await repository.enqueue(jobInput({
      sourceEventId:TRADE_EVENT_ID,sourceRawEventId:TRADE_RAW_EVENT_ID,
      inputFingerprint:'8'.repeat(64),
    }));
    const retryJob=await repository.claim({ nowMs:2_000,leaseMs:1_000 });
    assert.ok(retryJob);
    const before=await paperDomainRows(pool);

    await repository.fail(retryJob,{
      code:'RPC_TRANSIENT',retryable:true,terminalResult:null,
    });

    assert.deepEqual(await paperDomainRows(pool),before);
    const persisted=await pool.query<{
      readonly status:string;readonly error_code:string;readonly next_attempt_at:Date|null;
    }>(`SELECT status,error_code,next_attempt_at FROM paper_decision_jobs
      WHERE job_id=$1`,[retryJob.jobId]);
    assert.equal(persisted.rows[0]?.status,'RETRYABLE_FAILED');
    assert.equal(persisted.rows[0]?.error_code,'RPC_TRANSIENT');
    assert.equal(persisted.rows[0]?.next_attempt_at?.getTime(),2_100);
    assert.deepEqual(await repository.counts(),{
      pending:0,processing:0,retryableFailed:1,exhausted:0,
    });
  });
});

void test('rejects a staged paper open superseded before the atomic ledger guard',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    const decisions=new PostgresPaperDecisionRepository(pool);
    await decisions.enqueue(jobInput());
    const job=await decisions.claim({ nowMs:1_000,leaseMs:10_000 });
    assert.ok(job);
    const staged=decisionResult();
    await decisions.stageDecision(job,staged);
    await seedTrade(pool);
    await replaceCurrentQualification(pool,canonicalProjection(
      decisionResultAt(11n,2_000,'8'),
    ));
    const before=await paperOpenRows(pool);
    const ledger=new PostgresPaperTradingRepository(pool);

    await assert.rejects(ledger.transact(async transaction=>{
      await transaction.requireCurrentQualification({
        mint:MINT,reportId:staged.candidate.qualificationReportId,
        qualificationEventId:staged.qualificationEvent.id,
      });
    }),hasCode('QUALIFICATION_NOT_CURRENT'));

    assert.deepEqual(await paperOpenRows(pool),before);
    assert.deepEqual(before,{ positions:0,trades:0,opened_events:0,sessions:1,candidates:1 });
  });
});

void test('holds the qualification advisory lock from validation through paper commit',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    const ledger=new PostgresPaperTradingRepository(pool);
    const projection=canonicalProjection(decisionResult());
    let guardedResolve!:()=>void;
    const guarded=new Promise<void>((resolve)=>{guardedResolve=resolve;});
    let releaseResolve!:()=>void;
    const releaseGuard=new Promise<void>((resolve)=>{releaseResolve=resolve;});
    const holding=ledger.transact(async transaction=>{
      await transaction.requireCurrentQualification({
        mint:MINT,reportId:projection.reportId,
        qualificationEventId:projection.qualificationEvent.id,
      });
      guardedResolve();
      await releaseGuard;
    });
    await guarded;
    const contender=await pool.connect();
    try{
      const blocked=await contender.query<{readonly acquired:boolean}>(
        `SELECT pg_try_advisory_lock(
          hashtextextended('qualification-projection:' || $1,0)
        ) AS acquired`,[MINT],
      );
      assert.equal(blocked.rows[0]?.acquired,false);
      releaseResolve();
      await holding;
      const acquired=await contender.query<{readonly acquired:boolean}>(
        `SELECT pg_try_advisory_lock(
          hashtextextended('qualification-projection:' || $1,0)
        ) AS acquired`,[MINT],
      );
      assert.equal(acquired.rows[0]?.acquired,true);
      await contender.query(
        `SELECT pg_advisory_unlock(
          hashtextextended('qualification-projection:' || $1,0)
        )`,[MINT],
      );
    }finally{
      releaseResolve();
      await holding;
      contender.release();
    }
  });
});

void test('stages, survives lease expiry, replays and completes one immutable decision', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    const repository = new PostgresPaperDecisionRepository(pool, { maxAttempts: 3, baseDelayMs: 100 });
    await repository.enqueue(jobInput());
    const first = await repository.claim({ nowMs: 1_000, leaseMs: 100 });
    assert.ok(first);
    const result = decisionResult();
    await repository.stageDecision(first, result);

    const replay = await repository.claim({ nowMs: 1_101, leaseMs: 1_000 });
    assert.ok(replay);
    assert.equal(replay.jobId, first.jobId);
    const snapshot = await repository.loadSnapshot(replay);
    assert.equal(snapshot.launch.mint, MINT);
    assert.equal(snapshot.asOfEvent.id, SOURCE_EVENT_ID);
    assert.equal(snapshot.currentCandidate?.id, result.candidate.id);
    assert.equal(
      snapshot.currentDecision?.qualification.reportId,
      result.candidate.qualificationReportId,
    );
    assert.equal(
      snapshot.currentDecision?.qualification.qualificationEvent.id,
      result.qualificationEvent.id,
    );
    assert.equal(snapshot.currentDecision?.candidateEvent.id, result.candidateEvent.id);
    assert.equal(snapshot.currentSession?.id, result.session?.id);

    await repository.complete(replay, result);
    await repository.complete(replay, result);
    const counts = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM qualification_reports) reports,
      (SELECT COUNT(*)::int FROM trading_candidates) candidates,
      (SELECT COUNT(*)::int FROM paper_strategy_sessions) sessions`);
    assert.deepEqual(counts.rows[0], { reports: 1, candidates: 1, sessions: 1 });
    assert.deepEqual(await repository.counts(), {
      pending: 0, processing: 0, retryableFailed: 0, exhausted: 0,
    });
  });
});

void test('persists a finalized candidate revision after a confirmed decision', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    const repository = new PostgresPaperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    const confirmedClaim = await repository.claim({ nowMs: 1_000, leaseMs: 1_000 });
    assert.ok(confirmedClaim);
    const confirmed = decisionResult('confirmed');
    await repository.complete(confirmedClaim, Object.freeze({
      ...confirmed, session: null, sessionEvent: null, requestedAction: 'NONE' as const,
    }));

    await pool.query(
      `UPDATE raw_chain_events SET confirmation_status='finalized' WHERE event_id=$1`,
      [RAW_EVENT_ID],
    );
    await pool.query(
      `UPDATE domain_events SET confirmation_status='finalized' WHERE event_id=$1`,
      [SOURCE_EVENT_ID],
    );
    await repository.enqueue(jobInput({
      sourceConfirmationStatus: 'finalized', inputFingerprint: 'f'.repeat(64),
    }));
    const finalizedClaim = await repository.claim({ nowMs: 2_000, leaseMs: 1_000 });
    assert.ok(finalizedClaim);
    const finalized = decisionResult('finalized');
    await replaceCurrentQualification(pool,canonicalProjection(finalized));
    await repository.complete(finalizedClaim, finalized);

    const revisions = await pool.query<{
      readonly candidate_id: string;
      readonly confirmation_status: 'confirmed' | 'finalized';
      readonly superseded_at: Date | null;
    }>(`SELECT candidate_id,confirmation_status,superseded_at
      FROM trading_candidates ORDER BY confirmation_status`);
    assert.equal(revisions.rowCount, 2);
    assert.notEqual(finalized.candidate.id, confirmed.candidate.id);
    assert.deepEqual(revisions.rows.map((row) => row.confirmation_status), ['confirmed', 'finalized']);
    assert.equal(revisions.rows.filter((row) => row.superseded_at === null).length, 1);
  });
});

void test('loads the closed position linked to a staged paper session', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    await seedTrade(pool);
    const repository = new PostgresPaperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    const entry = await repository.claim({ nowMs: 1_000, leaseMs: 1_000 });
    assert.ok(entry);
    const decision = decisionResult();
    await repository.complete(entry, decision);
    assert.ok(decision.session);
    await insertPosition(pool, closedPosition(decision));

    await repository.enqueue(jobInput({
      sourceEventId:TRADE_EVENT_ID,sourceRawEventId:TRADE_RAW_EVENT_ID,
      inputFingerprint:'9'.repeat(64),
    }));
    const replay = await repository.claim({ nowMs: 2_000, leaseMs: 1_000 });
    assert.ok(replay);
    const snapshot = await repository.loadSnapshot(replay);
    assert.equal(snapshot.activePosition?.status, 'PAPER_CLOSED');
    assert.equal(snapshot.activePosition?.strategySessionId, decision.session.id);
  });
});

void test('does not let a delayed older job supersede a newer decision', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    await seedTrade(pool);
    const repository = new PostgresPaperDecisionRepository(pool);
    await repository.enqueue(jobInput({
      sourceEventId:TRADE_EVENT_ID,sourceRawEventId:TRADE_RAW_EVENT_ID,
      inputFingerprint:'8'.repeat(64),
    }));
    const newerJob = await repository.claim({ nowMs: 2_000, leaseMs: 1_000 });
    assert.ok(newerJob);
    const newer = decisionResultAt(11n, 2_000, '8');
    await replaceCurrentQualification(pool,canonicalProjection(newer));
    await repository.complete(newerJob, newer);

    await repository.enqueue(jobInput({ inputFingerprint:'7'.repeat(64) }));
    const olderJob = await repository.claim({ nowMs: 3_000, leaseMs: 1_000 });
    assert.ok(olderJob);
    await assert.rejects(
      repository.complete(olderJob,decisionResultAt(10n,1_000,'7')),
    );

    const current = await pool.query<{ readonly candidate_id: string }>(
      'SELECT candidate_id FROM trading_candidates WHERE superseded_at IS NULL',
    );
    assert.deepEqual(current.rows, [{ candidate_id:newer.candidate.id }]);
  });
});

void test('does not let a delayed session update regress a closed session', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    await seedTrade(pool);
    const repository = new PostgresPaperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    const entryJob = await repository.claim({ nowMs:1_000,leaseMs:10_000 });
    assert.ok(entryJob);
    const entry = decisionResult();
    await repository.complete(entryJob,entry);

    await repository.enqueue(jobInput({
      sourceEventId:TRADE_EVENT_ID,sourceRawEventId:TRADE_RAW_EVENT_ID,
      inputFingerprint:'6'.repeat(64),
    }));
    const older = await repository.claim({ nowMs:2_000,leaseMs:10_000 });
    assert.ok(older);
    await repository.enqueue(jobInput({
      sourceEventId:TRADE_EVENT_ID,sourceRawEventId:TRADE_RAW_EVENT_ID,
      inputFingerprint:'5'.repeat(64),
    }));
    const newer = await repository.claim({ nowMs:2_100,leaseMs:10_000 });
    assert.ok(newer);

    await repository.complete(newer,decisionWithSession(entry,'PAPER_CLOSED',10,3_000));
    await repository.complete(older,decisionWithSession(entry,'WAITING_EXTERNAL_BUYS',9,2_000));

    const current = await pool.query<{
      readonly state:string;
      readonly external_buy_count:number;
    }>('SELECT state,external_buy_count FROM paper_strategy_sessions');
    assert.deepEqual(current.rows, [{ state:'PAPER_CLOSED',external_buy_count:10 }]);
  });
});

void test('purges counted external buys before their terminal paper session', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    await seedTrade(pool);
    const repository = new PostgresPaperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    const claim = await repository.claim({ nowMs: 1_000, leaseMs: 1_000 });
    assert.ok(claim);

    await repository.complete(claim, terminalDecisionResult());
    const before = await pool.query(
      'SELECT purge_after FROM paper_external_buy_events WHERE session_id=$1',
      [terminalDecisionResult().session?.id],
    );
    assert.ok(before.rows[0]?.purge_after instanceof Date);

    const purged = await purgeExpiredFoundationData(pool);
    assert.equal(purged.paperExternalBuys, 1);
    assert.equal(purged.paperSessions, 1);
  });
});

function jobInput(overrides: Partial<PaperDecisionJobInput> = {}): PaperDecisionJobInput {
  return Object.freeze({
    mint: MINT,
    sourceEventId: SOURCE_EVENT_ID,
    sourceRawEventId: RAW_EVENT_ID,
    sourceConfirmationStatus: 'confirmed',
    inputFingerprint: FINGERPRINT,
    ...overrides,
  });
}

async function paperDomainRows(pool:pg.Pool):Promise<unknown>{
  const result=await pool.query(`SELECT
    (SELECT COALESCE(jsonb_agg(to_jsonb(event_row) ORDER BY event_id),'[]'::jsonb)
      FROM domain_events event_row) events,
    (SELECT COALESCE(jsonb_agg(to_jsonb(candidate_row) ORDER BY candidate_id),'[]'::jsonb)
      FROM trading_candidates candidate_row) candidates,
    (SELECT COALESCE(jsonb_agg(to_jsonb(session_row) ORDER BY session_id),'[]'::jsonb)
      FROM paper_strategy_sessions session_row) sessions,
    (SELECT COALESCE(jsonb_agg(to_jsonb(position_row) ORDER BY position_id),'[]'::jsonb)
      FROM paper_positions position_row) positions,
    (SELECT COALESCE(jsonb_agg(to_jsonb(trade_row) ORDER BY trade_id),'[]'::jsonb)
      FROM paper_trades trade_row) trades,
    (SELECT COALESCE(jsonb_agg(to_jsonb(buy_row) ORDER BY session_id,trade_id),'[]'::jsonb)
      FROM paper_external_buy_events buy_row) external_buys`);
  return result.rows[0];
}

async function paperOpenRows(pool:pg.Pool):Promise<unknown>{
  const result=await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM paper_positions) positions,
    (SELECT COUNT(*)::int FROM paper_trades) trades,
    (SELECT COUNT(*)::int FROM domain_events WHERE type='PaperPositionOpened') opened_events,
    (SELECT COUNT(*)::int FROM paper_strategy_sessions) sessions,
    (SELECT COUNT(*)::int FROM trading_candidates) candidates`);
  return result.rows[0];
}

function hasCode(code:string):(error:unknown)=>boolean{
  return (error)=>(
    typeof error==='object'&&error!==null&&'code' in error&&error.code===code
  );
}

function decisionResult(
  confirmationStatus: 'confirmed' | 'finalized' = 'confirmed',
  cursor: ChainCursor = Object.freeze({
    slot:10n,transactionIndex:0,instructionIndex:1,innerInstructionIndex:null,
  }),
  evaluatedAtMs = 1_000,
  reportIdentity = confirmationStatus === 'confirmed' ? 'b' : 'e',
): PaperDecisionResult {
  const report = qualificationReport(QUALIFICATION_EVALUATED_AT_MS + evaluatedAtMs);
  const qualificationReportId = `qreport_${reportIdentity.repeat(64)}`;
  const evaluation = Object.freeze({
    evaluatedAtMs:report.evaluatedAtMs,signals:Object.freeze({}),
    blockers:Object.freeze([]),calibrationFacts:null,
  });
  const evidenceFingerprint='d'.repeat(64);
  const qualificationEvent = derivedEvent(
    'QualificationUpdated', qualificationReportId, Object.freeze({
      reportId:qualificationReportId,evidenceFingerprint,evaluation,report,
    }),confirmationStatus,cursor,report.evaluatedAtMs,'qualification',
    cursor.slot===11n?'trade-signature':'signature',
  );
  const candidate = createTradingCandidate({
    mint: MINT,
    strategy: Object.freeze({ id: 'validated-external-buys', version: 1 }),
    qualificationReportId,
    qualificationProfile: Object.freeze({
      id: 'pumpfun-v1-initial', version: 1, fingerprint: 'c'.repeat(64),
    }),
    evidenceFingerprint,
    asOfEvent: qualificationEvent,
    state: 'ELIGIBLE',
    quoteAsset: Object.freeze({ mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' }),
    buyQuote: Object.freeze({
      id: 'buy', inputMint: 'SOL', outputMint: MINT, amountInRaw: 1_000n,
      amountOutRaw: 900n, minimumAmountOutRaw: 900n, feesRaw: 1n,
      slippageBps: 0n, priceImpactBps: 1n, observedAtMs: 1_000, observedSlot: 10n,
    }),
    reverseSellQuote: Object.freeze({
      id: 'sell', inputMint: MINT, outputMint: 'SOL', amountInRaw: 900n,
      amountOutRaw: 800n, minimumAmountOutRaw: 800n, feesRaw: 1n,
      slippageBps: 0n, priceImpactBps: 1n, observedAtMs: 1_000, observedSlot: 10n,
    }),
    eligibleUntilMs: evaluatedAtMs + 45_000,
    reasonCodes: ['QUALIFIED_ENTRY'],
    createdAtMs: evaluatedAtMs,
    purgeAfterMs: evaluatedAtMs + 14_400_000,
  });
  const candidateEvent = derivedEvent(
    'TradingCandidateUpdated', candidate.id, { candidate }, confirmationStatus,
    cursor, evaluatedAtMs,
  );
  const session = createPaperStrategySession({
    candidate, state: 'BUY_PENDING', reasonCode: 'QUALIFIED_ENTRY', positionId: null,
    entryCursor: candidate.asOf.cursor, externalBuyTarget: 10, externalBuyCount: 0,
    countedTradeIds: [], lastCountedCursor: null, minimumConfirmation: 'confirmed',
    lastQuote: candidate.buyQuote, lastError: null, createdAtMs: evaluatedAtMs,
    updatedAtMs: evaluatedAtMs, purgeAfterMs: evaluatedAtMs + 14_400_000,
  });
  const sessionEvent = derivedEvent(
    'PaperStrategySessionUpdated', session.id, { session }, confirmationStatus,
    cursor, evaluatedAtMs,
  );
  return Object.freeze({
    report, qualificationEvent, candidate, candidateEvent, session, sessionEvent,
    countedExternalBuys: Object.freeze([]), requestedAction: 'OPEN',
  });
}

function decisionResultAt(slot: bigint, evaluatedAtMs: number, reportIdentity: string): PaperDecisionResult {
  const cursor = Object.freeze({
    slot,transactionIndex:0,instructionIndex:slot === 10n ? 1 : 2,innerInstructionIndex:null,
  });
  const result = decisionResult('confirmed', cursor, evaluatedAtMs, reportIdentity);
  return Object.freeze({
    ...result,session:null,sessionEvent:null,requestedAction:'NONE' as const,
  });
}

function decisionWithSession(
  base: PaperDecisionResult,
  state: 'WAITING_EXTERNAL_BUYS' | 'PAPER_CLOSED',
  externalBuyCount: number,
  updatedAtMs: number,
): PaperDecisionResult {
  const session = createPaperStrategySession({
    candidate:base.candidate,state,reasonCode:state === 'PAPER_CLOSED'
      ? 'EXTERNAL_BUY_TARGET_REACHED'
      : 'EXTERNAL_BUY_OBSERVED',positionId:'paper-position',
    entryCursor:base.candidate.asOf.cursor,externalBuyTarget:10,externalBuyCount,
    countedTradeIds:Array.from({ length:externalBuyCount }, (_, index) => `trade-${index}`),
    lastCountedCursor:Object.freeze({
      slot:11n,transactionIndex:0,instructionIndex:2,innerInstructionIndex:null,
    }),minimumConfirmation:'confirmed',lastQuote:base.candidate.buyQuote,lastError:null,
    createdAtMs:1_000,updatedAtMs,purgeAfterMs:updatedAtMs+14_400_000,
  });
  const sessionEvent = derivedEvent(
    'PaperStrategySessionUpdated',`${session.id}:${state}:${externalBuyCount}`,
    { session },'confirmed',base.candidate.asOf.cursor,updatedAtMs,
  );
  return Object.freeze({
    ...base,session,sessionEvent,countedExternalBuys:Object.freeze([]),
    requestedAction:'NONE' as const,
  });
}

function terminalDecisionResult(): PaperDecisionResult {
  const base = decisionResult();
  assert.ok(base.session);
  const cursor = Object.freeze({
    slot: 11n, transactionIndex: 0, instructionIndex: 2, innerInstructionIndex: null,
  });
  const session = Object.freeze({
    ...base.session,
    state: 'PAPER_CLOSED' as const,
    reasonCode: 'EXTERNAL_BUY_TARGET_REACHED' as const,
    externalBuyTarget: 1,
    externalBuyCount: 1,
    countedTradeIds: Object.freeze(['external-buy-1']),
    lastCountedCursor: cursor,
    updatedAtMs: 2_000,
    purgeAfterMs: 14_402_000,
  });
  return Object.freeze({
    ...base,
    session,
    sessionEvent: derivedEvent('PaperStrategySessionUpdated', session.id, { session }),
    countedExternalBuys: Object.freeze([Object.freeze({
      sessionId: session.id,
      tradeId: 'external-buy-1',
      mint: MINT,
      quoteMint: 'SOL',
      trader: 'external-wallet',
      cursor,
      confirmationStatus: 'confirmed' as const,
      observedAtMs: 2_000,
      payloadVersion: 1 as const,
    })]),
    requestedAction: 'CLOSE' as const,
  });
}

function qualificationReport(evaluatedAtMs = 1_000): QualificationReport {
  const score = Object.freeze({ score: 0, maximum: 0 });
  return Object.freeze({
    ruleSet: Object.freeze({
      id: 'pumpfun-v1-initial', version: 1, status: 'UNVALIDATED_RULE_SET',
      minimumTotalScore: 0, fingerprint: 'c'.repeat(64),
    }),
    scores: Object.freeze({
      preparation: score, socialAuthenticity: score, onchainHealth: score,
      total: Object.freeze({ score: 0, maximum: 100 }),
    }),
    evidence: Object.freeze([]), conditions: Object.freeze([]), blockers: Object.freeze([]),
    verdict: 'QUALIFIED', evaluatedAtMs,
  });
}

function derivedEvent(
  type: DomainEvent['type'],
  qualifier: string,
  payload: Readonly<Record<string, unknown>>,
  confirmationStatus: 'confirmed' | 'finalized' = 'confirmed',
  cursor: ChainCursor = Object.freeze({
    slot:10n,transactionIndex:0,instructionIndex:1,innerInstructionIndex:null,
  }),
  observedAtMs = 1_000,
  source = 'paper-decision',
  signature = 'signature',
): DomainEvent {
  const identity = {
    type,mint:MINT,source,program:'pump',signature,
    cursor,
    qualifier,
  } as const;
  return Object.freeze({
    id: createDeterministicDerivedEventId(identity), type, mint: MINT,
    source: identity.source, program: identity.program, signature: identity.signature,
    cursor: identity.cursor, confirmationStatus, blockchainTimeMs: 900,
    observedAtMs, payloadVersion: 1, payload: Object.freeze(payload),
  });
}

function canonicalProjection(result:PaperDecisionResult):CanonicalQualificationProjection {
  const payload=result.qualificationEvent.payload as Readonly<Record<string,unknown>>;
  return Object.freeze({
    reportId:result.candidate.qualificationReportId,
    sourceEventId:result.qualificationEvent.cursor.slot===11n?TRADE_EVENT_ID:SOURCE_EVENT_ID,
    sourceRawEventId:result.qualificationEvent.cursor.slot===11n?TRADE_RAW_EVENT_ID:RAW_EVENT_ID,
    evidenceFingerprint:result.candidate.evidenceFingerprint,
    evaluation:payload.evaluation as CanonicalQualificationProjection['evaluation'],
    report:result.report,
    qualificationEvent:result.qualificationEvent,
  });
}

async function seedQualification(
  pool:InstanceType<typeof pg.Pool>,
  projection:CanonicalQualificationProjection,
):Promise<void> {
  const event=projection.qualificationEvent;
  const report=projection.report;
  await pool.query(`INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
    instruction_index,inner_instruction_index,confirmation_status,blockchain_time,
    observed_at,payload_version,payload,terminal_at,purge_after
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$14,$16)`,[
    event.id,projection.sourceRawEventId,event.type,event.mint,event.source,event.program,
    event.signature,event.cursor.slot.toString(),event.cursor.transactionIndex,
    event.cursor.instructionIndex,event.cursor.innerInstructionIndex,event.confirmationStatus,
    event.blockchainTimeMs===null?null:new Date(event.blockchainTimeMs),
    new Date(event.observedAtMs),toJsonValue(event.payload),
    new Date(report.evaluatedAtMs+14_400_000),
  ]);
  await pool.query(`INSERT INTO qualification_reports (
    report_id,mint,source_event_id,source_raw_event_id,qualification_event_id,
    profile_id,profile_version,profile_fingerprint,evidence_fingerprint,verdict,
    preparation_score,social_score,onchain_score,total_score,as_of_slot,
    as_of_transaction_index,as_of_instruction_index,as_of_inner_instruction_index,
    confirmation_status,evaluated_at,superseded_at,purge_after,payload_version,payload
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
    $19,$20,NULL,$21,1,$22)`,[
    projection.reportId,event.mint,projection.sourceEventId,projection.sourceRawEventId,
    event.id,report.ruleSet.id,report.ruleSet.version,report.ruleSet.fingerprint,
    projection.evidenceFingerprint,report.verdict,report.scores.preparation.score,
    report.scores.socialAuthenticity.score,report.scores.onchainHealth.score,
    report.scores.total.score,event.cursor.slot.toString(),event.cursor.transactionIndex,
    event.cursor.instructionIndex,event.cursor.innerInstructionIndex,event.confirmationStatus,
    new Date(report.evaluatedAtMs),new Date(report.evaluatedAtMs+14_400_000),
    toJsonValue(report),
  ]);
}

async function replaceCurrentQualification(
  pool:InstanceType<typeof pg.Pool>,
  projection:CanonicalQualificationProjection,
):Promise<void>{
  await pool.query(`UPDATE qualification_reports
    SET superseded_at=GREATEST(evaluated_at,$1)
    WHERE mint=$2 AND superseded_at IS NULL`,[
    new Date(projection.report.evaluatedAtMs),projection.qualificationEvent.mint,
  ]);
  await seedQualification(pool,projection);
}

function closedPosition(result: PaperDecisionResult): PaperPosition & {
  readonly strategySessionId: string;
  readonly qualificationReportId: string;
  readonly candidateId: string;
} {
  assert.ok(result.session);
  return Object.freeze({
    id:'closed-position',mint:MINT,quoteAsset:result.candidate.quoteAsset,
    strategy:result.candidate.strategy,status:'PAPER_CLOSED',baseFilledRaw:900n,
    remainingBaseRaw:0n,quoteCostRaw:1_000n,quoteProceedsRaw:1_100n,
    grossPnlQuoteRaw:100n,netPnlQuoteRaw:100n,roundTripLossBps:2_000n,
    entryTradeId:'entry-trade',exitTradeId:'exit-trade',openCommandHash:'open-hash',
    closeCommandHash:'close-hash',triggerEventId:result.qualificationEvent.id,
    strategySessionId:result.session.id,qualificationReportId:result.candidate.qualificationReportId,
    candidateId:result.candidate.id,openedAtMs:1_000,closedAtMs:2_000,
    purgeAfterMs:14_402_000,payloadVersion:1,
  });
}

async function insertPosition(
  pool: InstanceType<typeof pg.Pool>,
  position: ReturnType<typeof closedPosition>,
): Promise<void> {
  await pool.query(`INSERT INTO paper_positions (
    position_id,mint,quote_mint,quote_decimals,quote_token_program,strategy_id,
    strategy_version,status,base_filled_raw,remaining_base_raw,quote_cost_raw,
    quote_proceeds_raw,gross_pnl_quote_raw,net_pnl_quote_raw,round_trip_loss_bps,
    entry_trade_id,exit_trade_id,open_command_hash,close_command_hash,trigger_event_id,
    payload_version,payload,opened_at,closed_at,purge_after,strategy_session_id,
    qualification_report_id,candidate_id
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
    $19,$20,1,$21,$22,$23,$24,$25,$26,$27)`, [
    position.id,position.mint,position.quoteAsset.mint,position.quoteAsset.decimals,
    position.quoteAsset.tokenProgram,position.strategy.id,position.strategy.version,
    position.status,position.baseFilledRaw.toString(),position.remainingBaseRaw.toString(),
    position.quoteCostRaw.toString(),position.quoteProceedsRaw?.toString(),
    position.grossPnlQuoteRaw?.toString(),position.netPnlQuoteRaw?.toString(),
    position.roundTripLossBps.toString(),position.entryTradeId,position.exitTradeId,
    position.openCommandHash,position.closeCommandHash,position.triggerEventId,
    toJsonValue(position),new Date(position.openedAtMs),new Date(position.closedAtMs ?? 0),
    new Date(position.purgeAfterMs ?? 0),position.strategySessionId,
    position.qualificationReportId,position.candidateId,
  ]);
}

async function seed(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  await migrateDatabase({ pool });
  const launch: TokenLaunch = Object.freeze({
    mint: MINT, creator: 'creator', tokenProgram: 'SPL_TOKEN',
    quoteAssets: Object.freeze([Object.freeze({ mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' })]),
    launchpad: 'pumpfun',
    createdAt: Object.freeze({ slot: 10n, transactionIndex: 0, instructionIndex: 1, innerInstructionIndex: null }),
    parameters: Object.freeze({}),
  });
  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,current_state,created_signature,
    created_slot,created_transaction_index,created_instruction_index,detected_at,updated_at
  ) VALUES ($1,'pumpfun','pump','creator','SPL_TOKEN','DETECTED','signature',10,0,1,$2,$2)`, [
    MINT, new Date(1_000),
  ]);
  await pool.query(`INSERT INTO raw_chain_events (
    event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
    confirmation_status,observed_at,payload_version,payload
  ) VALUES ($1,'pumpfun','pump',$2,'signature',10,0,1,'confirmed',$3,1,'{}')`, [
    RAW_EVENT_ID, MINT, new Date(1_000),
  ]);
  await pool.query(`INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
    instruction_index,confirmation_status,blockchain_time,observed_at,payload_version,payload
  ) VALUES ($1,$2,'TokenLaunchDetected',$3,'pumpfun','pump','signature',10,0,1,
    'confirmed',$4,$5,1,$6)`, [
    SOURCE_EVENT_ID,RAW_EVENT_ID,MINT,new Date(900),new Date(1_000),toJsonValue({ launch }),
  ]);
  await seedQualification(pool,canonicalProjection(decisionResult()));
}

async function seedTrade(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  await pool.query(`INSERT INTO raw_chain_events (
    event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
    confirmation_status,observed_at,payload_version,payload
  ) VALUES ($1,'pumpfun','pump',$2,'trade-signature',11,0,2,'confirmed',$3,1,'{}')`, [
    TRADE_RAW_EVENT_ID, MINT, new Date(2_000),
  ]);
  await pool.query(`INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
    instruction_index,confirmation_status,blockchain_time,observed_at,payload_version,payload
  ) VALUES ($1,$2,'BondingCurveTradeObserved',$3,'pumpfun','pump','trade-signature',11,0,2,
    'confirmed',$4,$5,1,$6)`, [
    TRADE_EVENT_ID,TRADE_RAW_EVENT_ID,MINT,new Date(900),new Date(2_000),
    toJsonValue({ trade:{} }),
  ]);
}

async function withSchema(run: (pool: InstanceType<typeof pg.Pool>) => Promise<void>): Promise<void> {
  assert.ok(databaseUrl);
  const schema = `paper_repository_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
