import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createDeterministicDerivedEventId, type DomainEvent } from '../src/domain/events.js';
import {
  createCreationEntrySession,
  createPaperStrategySession,
} from '../src/domain/paper-strategy.js';
import type {
  OpenPaperPositionCommand,
  PaperExecutionQuote,
  PaperPosition,
} from '../src/domain/paper-trading.js';
import type { QualificationReport } from '../src/domain/qualification.js';
import { createTradingCandidate } from '../src/domain/trading-candidate.js';
import type { ChainCursor, TokenLaunch } from '../src/domain/types.js';
import type {
  PaperDecisionJobInput,
  PaperDecisionResult,
} from '../src/ports/paper-decision-repository.js';
import type { CanonicalQualificationProjection } from '../src/ports/qualification-projection-repository.js';
import { PaperTradingEngine } from '../src/paper/paper-trading-engine.js';
import {
  createDefaultQualificationRuleSet,
  QualificationEngine,
} from '../src/qualification/qualification-engine.js';
import type { NormalizedTransaction } from '../src/solana/rpc/types.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import {
  PaperDecisionRepositoryError,
  PostgresPaperDecisionRepository as ProductionPaperDecisionRepository,
  type PaperDecisionRepositoryOptions,
} from '../src/storage/paper-decision.repository.js';
import { PostgresPaperTradingRepository } from '../src/storage/paper-trading.repository.js';
import {
  PostgresTransactionInboxRepository,
  TransactionInboxConflictError,
} from '../src/storage/transaction-inbox.repository.js';
import { toJsonValue } from '../src/utils/json.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MINT = 'So11111111111111111111111111111111111111112';
const RAW_EVENT_ID = 'raw_paper_source';
const SOURCE_EVENT_ID = 'evt_paper_source';
const TRADE_RAW_EVENT_ID = 'raw_paper_trade';
const TRADE_EVENT_ID = 'evt_paper_trade';
const FINGERPRINT = 'a'.repeat(64);
const QUALIFICATION_EVALUATED_AT_MS = Date.now();
const EFFECTIVE_QUALIFICATION_PROFILE = Object.freeze({
  id: 'pumpfun-v1-initial', version: 1, fingerprint: 'c'.repeat(64),
});

class PostgresPaperDecisionRepository extends ProductionPaperDecisionRepository {
  public constructor(
    pool: InstanceType<typeof pg.Pool>,
    options: PaperDecisionRepositoryOptions = {},
    qualificationProfile = EFFECTIVE_QUALIFICATION_PROFILE,
  ) {
    super(pool, {clock:()=>1_000,...options}, qualificationProfile);
  }
}

function paperDecisionRepository(
  pool: InstanceType<typeof pg.Pool>,
  options: PaperDecisionRepositoryOptions = {},
): PostgresPaperDecisionRepository {
  return new PostgresPaperDecisionRepository(pool, options);
}

void test('claims one idempotent job concurrently, renews it, and reports queue counts', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    const repository = paperDecisionRepository(pool, { maxAttempts: 3, baseDelayMs: 100 });
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

void test('enqueues one deterministic wake-up for each active creation session', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    const repository = paperDecisionRepository(pool, { maxAttempts: 3, baseDelayMs: 100 });
    await repository.enqueue(jobInput());
    const initial = await repository.claim({ nowMs: 1_000, leaseMs: 10_000 });
    assert.ok(initial);
    const active = decisionWithSession(decisionResult(), 'WAITING_EXTERNAL_BUYS', 0, 1_001);
    await repository.stageDecision(initial, active);
    await pool.query(
      `UPDATE paper_strategy_sessions SET strategy_id='creation-entry-v1'
        WHERE session_id=$1`,
      [active.session?.id],
    );

    assert.equal(await repository.enqueueActiveSessions(2_000), 1);
    assert.equal(await repository.enqueueActiveSessions(2_001), 1);
    const jobs = await pool.query(
      `SELECT COUNT(*)::int AS count FROM paper_decision_jobs WHERE status='PENDING'`,
    );
    assert.equal(jobs.rows[0]?.count, 1);
  });
});

void test('persists V2 buyer evidence and replaces an orphaned wallet trade projection', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    await seedTrade(pool);
    const repository = paperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    const claim = await repository.claim({ nowMs: 1_000, leaseMs: 10_000 });
    assert.ok(claim);

    await repository.stageDecision(claim, creationDecisionWithEvidence('trade-old', 2_000));
    const persisted = await repository.loadSnapshot(claim);
    assert.ok(persisted.currentSession?.payloadVersion === 2);
    assert.equal(persisted.currentSession.externalMinimumBuyAmountRaw, 1_000n);
    await repository.stageDecision(claim, creationDecisionWithEvidence('trade-active', 2_001));

    const rows = await pool.query(`SELECT trade_id,trader,quote_amount_raw::text,
      payload_version,payload FROM paper_external_buy_events`);
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0]?.trade_id, 'trade-active');
    assert.equal(rows.rows[0]?.trader, 'external-wallet');
    assert.equal(rows.rows[0]?.quote_amount_raw, '2000');
    assert.equal(rows.rows[0]?.payload_version, 2);
    assert.equal((rows.rows[0]?.payload as { payloadVersion?: unknown }).payloadVersion, 2);
  });
});

void test('removes V2 buyer evidence orphaned without a replacement trade', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    await seedTrade(pool);
    const repository = paperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    const initial = await repository.claim({ nowMs: 1_000, leaseMs: 10_000 });
    assert.ok(initial);
    const counted = creationDecisionWithEvidence('trade-orphaned', 2_000);
    await repository.complete(initial, counted);

    await setRawConfirmation(pool,TRADE_RAW_EVENT_ID,'trade-signature','orphaned');
    await pool.query(
      `UPDATE domain_events SET confirmation_status='orphaned' WHERE event_id=$1`,
      [TRADE_EVENT_ID],
    );
    await repository.enqueue(jobInput({
      sourceEventId: TRADE_EVENT_ID,
      sourceRawEventId: TRADE_RAW_EVENT_ID,
      sourceConfirmationStatus: 'orphaned',
      inputFingerprint: 'b'.repeat(64),
    }));
    const orphaned = await repository.claim({ nowMs: 3_000, leaseMs: 10_000 });
    assert.ok(orphaned);
    const rebuilt = creationDecisionWithoutEvidence(counted, 3_000);
    await repository.stageDecision(orphaned, rebuilt);
    const stagedRows = await pool.query(
      'SELECT trade_id FROM paper_external_buy_events WHERE session_id=$1',
      [counted.session?.id],
    );
    assert.equal(stagedRows.rowCount, 1);
    await repository.complete(orphaned, rebuilt);

    const rows = await pool.query(
      'SELECT trade_id FROM paper_external_buy_events WHERE session_id=$1',
      [counted.session?.id],
    );
    assert.equal(rows.rowCount, 0);
  });
});

void test('retains V2 evidence when an entry source is orphaned', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    await seedTrade(pool);
    const repository = paperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    const initial = await repository.claim({ nowMs: 1_000, leaseMs: 10_000 });
    assert.ok(initial);
    const counted = creationDecisionWithEvidence('trade-retained', 2_000);
    await repository.complete(initial, counted);

    await repository.enqueue(jobInput({
      sourceConfirmationStatus: 'orphaned',
      inputFingerprint: 'd'.repeat(64),
    }));
    const orphaned = await repository.claim({ nowMs: 3_000, leaseMs: 10_000 });
    assert.ok(orphaned);
    await repository.complete(orphaned, creationSourceOrphanDecision(counted, 3_000));

    const rows = await pool.query(
      'SELECT trade_id FROM paper_external_buy_events WHERE session_id=$1',
      [counted.session?.id],
    );
    assert.deepEqual(rows.rows, [{ trade_id: 'trade-retained' }]);
  });
});

void test('does not let a stale orphan completion delete newer V2 evidence', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    await seedTrade(pool);
    const repository = paperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    const initial = await repository.claim({ nowMs: 1_000, leaseMs: 10_000 });
    assert.ok(initial);
    const counted = creationDecisionWithEvidence('trade-old', 2_000);
    await repository.complete(initial, counted);

    await setRawConfirmation(pool,TRADE_RAW_EVENT_ID,'trade-signature','orphaned');
    await pool.query(
      `UPDATE domain_events SET confirmation_status='orphaned' WHERE event_id=$1`,
      [TRADE_EVENT_ID],
    );
    await repository.enqueue(jobInput({
      sourceEventId: TRADE_EVENT_ID,
      sourceRawEventId: TRADE_RAW_EVENT_ID,
      sourceConfirmationStatus: 'orphaned',
      inputFingerprint: 'b'.repeat(64),
    }));
    const stale = await repository.claim({ nowMs: 3_000, leaseMs: 10_000 });
    assert.ok(stale);

    await repository.enqueue(jobInput({ inputFingerprint: 'c'.repeat(64) }));
    const newer = await repository.claim({ nowMs: 3_100, leaseMs: 10_000 });
    assert.ok(newer);
    await setRawConfirmation(pool,TRADE_RAW_EVENT_ID,'trade-signature','confirmed');
    await repository.complete(newer, creationDecisionWithEvidence('trade-new', 4_000));
    await repository.complete(stale, creationDecisionWithEvidence('trade-stale', 3_000));

    const rows = await pool.query(
      'SELECT trade_id FROM paper_external_buy_events WHERE session_id=$1',
      [counted.session?.id],
    );
    assert.deepEqual(rows.rows, [{ trade_id: 'trade-new' }]);
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
    assert.equal(snapshot.launchDetectedAtMs, 1_000);
    assert.equal(snapshot.launchConfirmationStatus, 'confirmed');
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

void test('loads current qualification only for the effective profile identity', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    const effective = canonicalProjection(decisionResult());
    const legacy = qualificationProjectionForProfile({
      id: 'pumpfun-v0-retired', version: 9, fingerprint: '9'.repeat(64),
    }, effective.report.evaluatedAtMs + 1_000, '9');
    await seedQualification(pool, legacy);
    const repository = new PostgresPaperDecisionRepository(
      pool,
      {},
      EFFECTIVE_QUALIFICATION_PROFILE,
    );
    await repository.enqueue(jobInput());
    const claimed = await repository.claim({ nowMs:1_000,leaseMs:1_000 });
    assert.ok(claimed);

    const snapshot = await repository.loadSnapshot(claimed);

    assert.equal(snapshot.currentQualification?.reportId, effective.reportId);
    assert.deepEqual(snapshot.currentQualification?.report.ruleSet, effective.report.ruleSet);
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
        await setRawConfirmation(pool,RAW_EVENT_ID,'signature','finalized');
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

    await setRawConfirmation(pool,RAW_EVENT_ID,'signature','orphaned');
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

void test('terminalizes an orphan-only launch no-op without exhausting the backlog', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    const repository = new PostgresPaperDecisionRepository(pool);
    await setRawConfirmation(pool,RAW_EVENT_ID,'signature','orphaned');
    await pool.query(
      `UPDATE domain_events SET confirmation_status='orphaned' WHERE raw_event_id=$1`,
      [RAW_EVENT_ID],
    );
    await repository.enqueueLatest(MINT,'signature','orphaned');
    const job = await repository.claim({ nowMs:2_000,leaseMs:1_000 });
    assert.ok(job);

    const snapshot = await repository.loadSnapshot(job);
    assert.equal(snapshot.canonicalLaunchActive,false);
    assert.equal(snapshot.currentQualification,null);
    assert.equal(snapshot.currentCandidate,null);
    assert.equal(snapshot.currentSession,null);
    assert.equal(snapshot.activePosition,null);
    await repository.completeNoop(job);

    assert.deepEqual(await repository.counts(), {
      pending:0,processing:0,retryableFailed:0,exhausted:0,
    });
    const stored=await pool.query(`SELECT status,error_code,retry_exhausted_at
      FROM paper_decision_jobs WHERE job_id=$1`,[job.jobId]);
    assert.deepEqual(stored.rows,[{
      status:'COMPLETED',error_code:null,retry_exhausted_at:null,
    }]);
    assert.equal((await pool.query('SELECT COUNT(*)::int count FROM trading_candidates')).rows[0].count,0);
  });
});

void test('terminalizes an obsolete orphan job without changing later paper lineage', async (context) => {
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
    const laterJob=await repository.claim({ nowMs:2_000,leaseMs:1_000 });
    assert.ok(laterJob);
    const later=decisionResultAt(11n,2_000,'8');
    await replaceCurrentQualification(pool,canonicalProjection(later));
    await repository.complete(laterJob,later);
    await pool.query(`UPDATE qualification_reports SET superseded_at=evaluated_at
      WHERE mint=$1 AND superseded_at IS NULL`,[MINT]);
    await setRawConfirmation(pool,RAW_EVENT_ID,'signature','orphaned');
    await pool.query(
      `UPDATE domain_events SET confirmation_status='orphaned' WHERE raw_event_id=$1`,
      [RAW_EVENT_ID],
    );
    await repository.enqueueLatest(MINT,'signature','orphaned');
    const obsolete=await repository.claim({ nowMs:3_000,leaseMs:1_000 });
    assert.ok(obsolete);

    const before=await paperDomainRows(pool);
    const snapshot=await repository.loadSnapshot(obsolete);
    assert.equal(snapshot.currentQualification,null);
    assert.equal(snapshot.currentCandidate,null);
    assert.equal(snapshot.currentDecision,null);
    assert.equal(snapshot.currentSession,null);
    assert.equal(snapshot.activePosition,null);
    assert.equal(snapshot.hasPaperLineage,true);
    await repository.completeObsolete(obsolete);

    assert.deepEqual(await paperDomainRows(pool),before);
    const stored=await pool.query(`SELECT status,error_code,retry_exhausted_at
      FROM paper_decision_jobs WHERE job_id=$1`,[obsolete.jobId]);
    assert.deepEqual(stored.rows,[{
      status:'COMPLETED',error_code:null,retry_exhausted_at:null,
    }]);
  });
});

void test('obsolete completion rejects exact lineage committed after its snapshot', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    const repository = new PostgresPaperDecisionRepository(pool);
    await setRawConfirmation(pool,RAW_EVENT_ID,'signature','orphaned');
    await pool.query(
      `UPDATE domain_events SET confirmation_status='orphaned' WHERE raw_event_id=$1`,
      [RAW_EVENT_ID],
    );
    await repository.enqueueLatest(MINT,'signature','orphaned');
    const obsolete=await repository.claim({ nowMs:2_000,leaseMs:10_000 });
    assert.ok(obsolete);
    const snapshot=await repository.loadSnapshot(obsolete);
    assert.equal(snapshot.currentCandidate,null);

    const exact=decisionResult();
    await pool.query(`INSERT INTO domain_events (
      event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
      instruction_index,inner_instruction_index,confirmation_status,blockchain_time,
      observed_at,payload_version,payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15)`,[
      exact.candidateEvent.id,RAW_EVENT_ID,exact.candidateEvent.type,MINT,
      exact.candidateEvent.source,exact.candidateEvent.program,exact.candidateEvent.signature,
      exact.candidateEvent.cursor.slot.toString(),exact.candidateEvent.cursor.transactionIndex,
      exact.candidateEvent.cursor.instructionIndex,exact.candidateEvent.cursor.innerInstructionIndex,
      'orphaned',new Date(exact.candidateEvent.blockchainTimeMs ?? 0),
      new Date(exact.candidateEvent.observedAtMs),toJsonValue(exact.candidateEvent.payload),
    ]);
    await pool.query(`INSERT INTO trading_candidates (
      candidate_id,mint,report_id,source_event_id,candidate_event_id,strategy_id,
      strategy_version,evidence_fingerprint,confirmation_status,state,quote_mint,
      quote_decimals,quote_token_program,reason_codes,eligible_until,created_at,
      superseded_at,purge_after,payload_version,payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NULL,$17,1,$18)`,[
      exact.candidate.id,MINT,exact.candidate.qualificationReportId,SOURCE_EVENT_ID,
      exact.candidateEvent.id,exact.candidate.strategy.id,exact.candidate.strategy.version,
      exact.candidate.evidenceFingerprint,exact.candidate.asOf.confirmationStatus,
      exact.candidate.state,exact.candidate.quoteAsset.mint,exact.candidate.quoteAsset.decimals,
      exact.candidate.quoteAsset.tokenProgram,JSON.stringify(toJsonValue(exact.candidate.reasonCodes)),
      new Date(exact.candidate.eligibleUntilMs ?? 0),new Date(exact.candidate.createdAtMs),
      new Date(exact.candidate.purgeAfterMs),toJsonValue(exact.candidate),
    ]);

    await assert.rejects(repository.completeObsolete(obsolete));
    const stored=await pool.query('SELECT status FROM paper_decision_jobs WHERE job_id=$1',[
      obsolete.jobId,
    ]);
    assert.deepEqual(stored.rows,[{ status:'PROCESSING' }]);
    const retained=await pool.query(
      'SELECT candidate_id FROM trading_candidates WHERE candidate_id=$1',[exact.candidate.id],
    );
    assert.deepEqual(retained.rows,[{ candidate_id:exact.candidate.id }]);
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
    await setRawConfirmation(pool,TRADE_RAW_EVENT_ID,'trade-signature','orphaned');
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

void test('reloads an active later session when its launch becomes orphaned', async (context) => {
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
    const entryJob=await repository.claim({ nowMs:2_000,leaseMs:1_000 });
    assert.ok(entryJob);
    const entry=decisionResult('confirmed',Object.freeze({
      slot:11n,transactionIndex:0,instructionIndex:2,innerInstructionIndex:null,
    }),2_000,'8');
    await replaceCurrentQualification(pool,canonicalProjection(entry));
    await repository.complete(entryJob,entry);
    await pool.query(`UPDATE qualification_reports SET superseded_at=evaluated_at
      WHERE mint=$1 AND superseded_at IS NULL`,[MINT]);
    await setRawConfirmation(pool,RAW_EVENT_ID,'signature','orphaned');
    await pool.query(
      `UPDATE domain_events SET confirmation_status='orphaned' WHERE raw_event_id=$1`,
      [RAW_EVENT_ID],
    );

    await repository.enqueueLatest(MINT,'signature','orphaned');
    const orphaned=await repository.claim({ nowMs:3_000,leaseMs:1_000 });
    assert.ok(orphaned);
    const snapshot=await repository.loadSnapshot(orphaned);

    assert.equal(snapshot.asOfEvent.type,'TokenLaunchDetected');
    assert.equal(snapshot.currentCandidate?.id,entry.candidate.id);
    assert.equal(snapshot.currentSession?.candidateId,entry.candidate.id);
    assert.equal(snapshot.activePosition,null);
    await assert.rejects(repository.completeObsolete(orphaned));
    const stored=await pool.query('SELECT status FROM paper_decision_jobs WHERE job_id=$1',[
      orphaned.jobId,
    ]);
    assert.deepEqual(stored.rows,[{ status:'PROCESSING' }]);
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
    let nowMs=1_000;
    const repository=new PostgresPaperDecisionRepository(pool,{
      maxAttempts:3,baseDelayMs:100,clock:()=>nowMs,
    });
    await repository.enqueue(jobInput());
    const entryJob=await repository.claim({ nowMs:1_000,leaseMs:1_000 });
    assert.ok(entryJob);
    await repository.complete(entryJob,decisionResult());
    await seedTrade(pool);
    nowMs=2_000;
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

void test('claim waits for every relevant inbox replay state and exact confirmation alignment',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    const repository=paperDecisionRepository(pool);
    await repository.enqueue(jobInput());

    for(const state of ['PENDING','PROCESSING','FAILED'] as const){
      await setInboxState(pool,'signature',state,'confirmed');
      assert.equal(await repository.claim({ nowMs:1_000,leaseMs:1_000 }),null,state);
    }
    await setInboxState(pool,'signature','PROCESSED','processed');
    assert.equal(await repository.claim({ nowMs:1_000,leaseMs:1_000 }),null,'misaligned');
    await pool.query(`DELETE FROM chain_transaction_inbox WHERE signature='signature'`);
    assert.equal(await repository.claim({ nowMs:1_000,leaseMs:1_000 }),null,'missing');

    await seedProcessedInbox(pool,'signature',10n,'confirmed');
    assert.ok(await repository.claim({ nowMs:1_000,leaseMs:1_000 }));
  });
});

void test('claim also waits for an earlier active raw signature of the same mint',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    await seedRaw(pool,Object.freeze({
      eventId:'raw-earlier',signature:'earlier-signature',slot:9n,
      transactionIndex:7,instructionIndex:3,confirmationStatus:'confirmed',
    }));
    const repository=paperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    assert.equal(await repository.claim({ nowMs:1_000,leaseMs:1_000 }),null);

    await seedProcessedInbox(pool,'earlier-signature',9n,'confirmed');
    assert.ok(await repository.claim({ nowMs:1_000,leaseMs:1_000 }));
  });
});

void test('rotates at most sixteen finality-blocked jobs before a later ready claim',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await migrateDatabase({pool});
    await seedFinalityPreflightBacklog(pool,1_000,[33]);
    const repository=paperDecisionRepository(pool);

    assert.equal(await repository.claim({nowMs:100_000,leaseMs:10_000}),null);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count
      FROM paper_decision_jobs WHERE finality_checked_at IS NOT NULL`)).rows[0]?.count,16);

    const firstRestart=paperDecisionRepository(pool);
    assert.equal(await firstRestart.claim({nowMs:100_000,leaseMs:10_000}),null);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count
      FROM paper_decision_jobs WHERE finality_checked_at IS NOT NULL`)).rows[0]?.count,32);

    const secondRestart=paperDecisionRepository(pool);
    const ready=await secondRestart.claim({nowMs:100_000,leaseMs:10_000});
    assert.equal(ready?.mint,'fair-mint-33');
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count
      FROM paper_decision_jobs WHERE finality_checked_at IS NOT NULL`)).rows[0]?.count,47);
  });
});

void test('concurrent claimers rotate distinct bounded finality preflight batches',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await migrateDatabase({pool});
    await seedFinalityPreflightBacklog(pool,1_000,[]);
    const left=paperDecisionRepository(pool);
    const right=paperDecisionRepository(pool);

    assert.deepEqual(await Promise.all([
      left.claim({nowMs:100_000,leaseMs:10_000}),
      right.claim({nowMs:100_000,leaseMs:10_000}),
    ]),[null,null]);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count
      FROM paper_decision_jobs WHERE finality_checked_at IS NOT NULL`)).rows[0]?.count,32);
  });
});

void test('leaves additional ready jobs at the finality preflight head',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await migrateDatabase({pool});
    await seedFinalityPreflightBacklog(pool,1_000,[1,2]);
    const repository=paperDecisionRepository(pool);

    assert.equal((await repository.claim({nowMs:100_000,leaseMs:10_000}))?.mint,'fair-mint-1');
    const secondBefore=await pool.query(`SELECT finality_checked_at,claim_scan_generation
      FROM paper_decision_jobs WHERE mint='fair-mint-2'`);
    assert.equal(secondBefore.rows[0]?.finality_checked_at,null);
    assert.equal((await repository.claim({nowMs:100_000,leaseMs:10_000}))?.mint,'fair-mint-2');
    assert.equal((await pool.query(`SELECT finality_checked_at,claim_scan_generation
      FROM paper_decision_jobs WHERE mint='fair-mint-2'`)).rows[0]?.finality_checked_at,null);
  });
});

void test('bounds expired maximum-attempt cleanup to the locked preflight batch',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await migrateDatabase({pool});
    await seedFinalityPreflightBacklog(pool,1_000,[]);
    await pool.query(`UPDATE paper_decision_jobs SET status='PROCESSING',attempts=1,
      attempts_in_cycle=1,max_attempts=1,lease_token='expired-max',
      lease_expires_at=to_timestamp(90),updated_at=to_timestamp(90)`);
    const repository=paperDecisionRepository(pool);

    assert.equal(await repository.claim({nowMs:100_000,leaseMs:10_000}),null);
    const counts=await pool.query(`SELECT status,COUNT(*)::int AS count
      FROM paper_decision_jobs GROUP BY status ORDER BY status`);
    assert.deepEqual(counts.rows,[
      {status:'CANCELLED',count:16},
      {status:'PROCESSING',count:984},
    ]);
    const cancelled=await pool.query(`SELECT DISTINCT
      EXTRACT(EPOCH FROM purge_after-terminal_at)::int AS retention_seconds
      FROM paper_decision_jobs WHERE status='CANCELLED'`);
    assert.deepEqual(cancelled.rows,[{retention_seconds:14_400}]);
  });
});

void test('honors retry and processing effective-time boundaries in preflight order',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await migrateDatabase({pool});
    await seedFinalityPreflightBacklog(pool,4,[1,2,3,4]);
    await pool.query(`UPDATE paper_decision_jobs SET status='RETRYABLE_FAILED',
      next_attempt_at=to_timestamp(101),error_code='RPC_TRANSIENT'
      WHERE mint='fair-mint-1'`);
    await pool.query(`UPDATE paper_decision_jobs SET status='PROCESSING',
      lease_token='active',lease_expires_at=to_timestamp(101)
      WHERE mint='fair-mint-2'`);
    await pool.query(`UPDATE paper_decision_jobs SET status='RETRYABLE_FAILED',
      next_attempt_at=to_timestamp(100),error_code='RPC_TRANSIENT'
      WHERE mint='fair-mint-3'`);
    await pool.query(`UPDATE paper_decision_jobs SET status='PROCESSING',
      lease_token='expired',lease_expires_at=to_timestamp(90)
      WHERE mint='fair-mint-4'`);
    const repository=paperDecisionRepository(pool);

    assert.equal((await repository.claim({nowMs:100_000,leaseMs:10_000}))?.mint,'fair-mint-4');
    assert.equal((await repository.claim({nowMs:100_000,leaseMs:10_000}))?.mint,'fair-mint-3');
    assert.equal(await repository.claim({nowMs:100_000,leaseMs:10_000}),null);
    const untouched=await pool.query(`SELECT mint,status FROM paper_decision_jobs
      WHERE mint IN ('fair-mint-1','fair-mint-2') ORDER BY mint`);
    assert.deepEqual(untouched.rows,[
      {mint:'fair-mint-1',status:'RETRYABLE_FAILED'},
      {mint:'fair-mint-2',status:'PROCESSING'},
    ]);
  });
});

void test('rolls back blocked rotation when claiming a ready preflight job fails',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await migrateDatabase({pool});
    await seedFinalityPreflightBacklog(pool,32,[16]);
    await pool.query(`CREATE FUNCTION reject_paper_claim() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.status='PROCESSING' AND OLD.status<>'PROCESSING' THEN
          RAISE EXCEPTION 'reject paper claim';
        END IF;
        RETURN NEW;
      END $$`);
    await pool.query(`CREATE TRIGGER reject_paper_claim
      BEFORE UPDATE ON paper_decision_jobs FOR EACH ROW EXECUTE FUNCTION reject_paper_claim()`);
    const repository=paperDecisionRepository(pool);

    await assert.rejects(
      repository.claim({nowMs:100_000,leaseMs:10_000}),
      PaperDecisionRepositoryError,
    );
    const rows=await pool.query(`SELECT
      COUNT(*) FILTER (WHERE finality_checked_at IS NOT NULL)::int AS checked,
      COUNT(*) FILTER (WHERE status='PENDING')::int AS pending
      FROM paper_decision_jobs`);
    assert.deepEqual(rows.rows,[{checked:0,pending:32}]);
  });
});

void test('a durable finalized receipt never masks a present pending inbox',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    await pool.query(`UPDATE raw_chain_events SET confirmation_status='finalized'
      WHERE event_id=$1`,[RAW_EVENT_ID]);
    await setInboxState(pool,'signature','PENDING','finalized');
    await pool.query(`INSERT INTO chain_transaction_finality_replay_receipts (
      signature,observed_slot,confirmation_status,finality_evidence_version,
      immutable_fingerprint,replay_completed_at
    ) VALUES ('signature',10,'finalized',1,$1,$2)`,[
      'f'.repeat(64),new Date(1_000),
    ]);
    const repository=paperDecisionRepository(pool);
    await repository.enqueue(jobInput());

    assert.equal(await repository.claim({nowMs:1_000,leaseMs:1_000}),null);
  });
});

void test('a revision after claim blocks snapshot and resumes after aligned replay',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    const repository=paperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    const job=await repository.claim({ nowMs:1_000,leaseMs:10_000 });
    assert.ok(job);

    await setInboxState(pool,'signature','PENDING','finalized');
    await assert.rejects(repository.loadSnapshot(job),PaperDecisionRepositoryError);
    assert.deepEqual(await paperOpenRows(pool),{
      positions:0,trades:0,opened_events:0,sessions:0,candidates:0,
    });

    await setInboxState(pool,'signature','PROCESSED','finalized');
    await pool.query(`UPDATE raw_chain_events SET confirmation_status='finalized'
      WHERE event_id=$1`,[RAW_EVENT_ID]);
    assert.equal((await repository.loadSnapshot(job)).mint,MINT);
  });
});

void test('a revision after claim blocks staging without candidate or session materialization',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    const repository=paperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    const job=await repository.claim({ nowMs:1_000,leaseMs:10_000 });
    assert.ok(job);
    await repository.loadSnapshot(job);

    await setInboxState(pool,'signature','PENDING','finalized');
    await assert.rejects(repository.stageDecision(job,decisionResult()),PaperDecisionRepositoryError);
    assert.deepEqual(await paperOpenRows(pool),{
      positions:0,trades:0,opened_events:0,sessions:0,candidates:0,
    });
  });
});

void test('the reusable paper replay barrier fails closed above 4096 relevant raw rows',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    await pool.query(`INSERT INTO raw_chain_events (
      event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
      confirmation_status,observed_at,payload_version,payload
    ) SELECT 'raw-bulk-'||value,'pumpfun','pump',$1,'bulk-signature-'||value,
      9,value,0,'confirmed',$2,1,'{}'::jsonb FROM generate_series(1,4096) value`,[
      MINT,new Date(900),
    ]);
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature,observed_slot,discovery_sources,program_ids,target_confirmation_status,
      processing_status,normalized_transaction,immutable_fingerprint,observed_at,processed_at
    ) SELECT 'bulk-signature-'||value,9,ARRAY['WEBSOCKET'],
      ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],'confirmed','PROCESSED',
      jsonb_build_object('signature','bulk-signature-'||value),$1,$2,$2
      FROM generate_series(1,4096) value`,['e'.repeat(64),new Date(900)]);
    const repository=paperDecisionRepository(pool);
    await repository.enqueue(jobInput());
    assert.equal(await repository.claim({ nowMs:1_000,leaseMs:10_000 }),null);
    assert.deepEqual(await paperOpenRows(pool),{
      positions:0,trades:0,opened_events:0,sessions:0,candidates:0,
    });
  });
});

void test('paper replay claim accepts exactly 4096 aligned relevant raw rows',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    await pool.query(`INSERT INTO raw_chain_events (
      event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
      confirmation_status,observed_at,payload_version,payload
    ) SELECT 'raw-boundary-'||value,'pumpfun','pump',$1,'boundary-signature-'||value,
      9,value,0,'confirmed',$2,1,'{}'::jsonb FROM generate_series(1,4095) value`,[
      MINT,new Date(900),
    ]);
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature,observed_slot,discovery_sources,program_ids,target_confirmation_status,
      processing_status,normalized_transaction,immutable_fingerprint,observed_at,processed_at
    ) SELECT 'boundary-signature-'||value,9,ARRAY['WEBSOCKET'],
      ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],'confirmed','PROCESSED',
      jsonb_build_object('signature','boundary-signature-'||value),$1,$2,$2
      FROM generate_series(1,4095) value`,['e'.repeat(64),new Date(900)]);
    const repository=paperDecisionRepository(pool);
    await repository.enqueue(jobInput());

    assert.ok(await repository.claim({ nowMs:1_000,leaseMs:10_000 }));
  });
});

void test('manual-kill wake remains claimable after aligned finalized inbox retention expires',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    const decisions=paperDecisionRepository(pool);
    await decisions.enqueue(jobInput());
    const initial=await decisions.claim({ nowMs:1_000,leaseMs:10_000 });
    assert.ok(initial);
    const active=decisionWithSession(decisionResult(),'WAITING_EXTERNAL_BUYS',0,1_001);
    await decisions.stageDecision(initial,active);
    await pool.query(`UPDATE paper_strategy_sessions SET strategy_id='creation-entry-v1'
      WHERE session_id=$1`,[active.session?.id]);

    await pool.query(`DELETE FROM chain_transaction_inbox WHERE signature='signature'`);
    const inbox=new PostgresTransactionInboxRepository(pool);
    await inbox.enqueue(Object.freeze({
      signature:'signature',slot:10n,source:'WEBSOCKET' as const,
      programIds:Object.freeze(['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']),
      confirmationStatus:'finalized' as const,observedAtMs:1_000,
    }));
    const replay=await inbox.claim(2_000,120);
    assert.ok(replay);
    await inbox.saveSnapshot('signature',replay.leaseToken,paperNormalizedTransaction());
    await pool.query(`UPDATE raw_chain_events SET confirmation_status='finalized'
      WHERE event_id=$1`,[RAW_EVENT_ID]);
    await pool.query(`UPDATE domain_events SET confirmation_status='finalized'
      WHERE event_id=$1`,[SOURCE_EVENT_ID]);
    await inbox.markProcessed('signature',replay.leaseToken,'finalized');
    await pool.query(`WITH retention AS MATERIALIZED (
      SELECT clock_timestamp() AS now
    ) UPDATE chain_transaction_inbox SET
      processed_at=retention.now-INTERVAL '5 hours',
      terminal_at=retention.now-INTERVAL '5 hours',
      purge_after=retention.now-INTERVAL '1 hour'
      FROM retention
      WHERE signature='signature'`);
    await pool.query(`UPDATE chain_transaction_finality_replay_receipts receipt SET
      replay_completed_at=inbox.processed_at
      FROM chain_transaction_inbox inbox
      WHERE receipt.signature=inbox.signature AND inbox.signature='signature'`);
    await pool.query(`DELETE FROM chain_transaction_finality_replay_receipts
      WHERE signature='signature'`);
    const protectedPurge=await purgeExpiredFoundationData(pool);
    assert.equal(protectedPurge.transactionInbox,0);
    await pool.query(`INSERT INTO chain_transaction_finality_replay_receipts (
      signature,observed_slot,confirmation_status,finality_evidence_version,
      immutable_fingerprint,replay_completed_at
    ) SELECT signature,observed_slot,target_confirmation_status,finality_evidence_version,
      immutable_fingerprint,processed_at FROM chain_transaction_inbox
      WHERE signature='signature'`);
    const purged=await purgeExpiredFoundationData(pool);
    assert.equal(purged.transactionInbox,1);
    assert.equal((await pool.query(`SELECT COUNT(*)
      FROM chain_transaction_finality_replay_receipts
      WHERE signature='signature'`)).rows[0]?.count,'1');

    assert.equal(await decisions.enqueueActiveSessions(3_000),1);
    const [manualKillClaim]=await Promise.all([
      decisions.claim({nowMs:3_000,leaseMs:10_000}),
      inbox.enqueue(Object.freeze({
        signature:'signature',slot:10n,source:'CATCH_UP' as const,
        programIds:Object.freeze(['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']),
        confirmationStatus:'finalized' as const,observedAtMs:3_000,
      })),
    ]);
    assert.ok(manualKillClaim);
    assert.equal((await pool.query(`SELECT COUNT(*) FROM chain_transaction_inbox
      WHERE signature='signature'`)).rows[0]?.count,'0');
  });
});

void test('orphan retraction survives terminal inbox retention and a paper-worker restart',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    await seedTrade(pool);
    const decisions=paperDecisionRepository(pool);
    await decisions.enqueue(jobInput());
    const initial=await decisions.claim({nowMs:1_000,leaseMs:10_000});
    assert.ok(initial);
    const active=creationDecisionWithEvidence('orphan-retained-trade',2_000);
    await decisions.complete(initial,active);

    await pool.query(`DELETE FROM chain_transaction_inbox WHERE signature='signature'`);
    const inbox=new PostgresTransactionInboxRepository(pool);
    await inbox.enqueue(Object.freeze({
      signature:'signature',slot:10n,source:'WEBSOCKET' as const,
      programIds:Object.freeze(['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']),
      confirmationStatus:'confirmed' as const,observedAtMs:2_100,
    }));
    const confirmed=await inbox.claim(2_101,120);
    assert.ok(confirmed);
    await inbox.saveSnapshot('signature',confirmed.leaseToken,paperNormalizedTransaction());
    await inbox.markProcessed('signature',confirmed.leaseToken,'confirmed');
    await pool.query(`UPDATE chain_transaction_inbox SET
      target_confirmation_status='orphaned',processing_status='PENDING',
      processed_at=NULL,terminal_at=NULL,purge_after=NULL,
      finality_evidence_version=finality_evidence_version+1
      WHERE signature='signature'`);
    await pool.query(`UPDATE raw_chain_events SET confirmation_status='orphaned'
      WHERE event_id=$1`,[RAW_EVENT_ID]);
    await pool.query(`UPDATE domain_events SET confirmation_status='orphaned'
      WHERE event_id=$1`,[SOURCE_EVENT_ID]);
    await pool.query(`UPDATE domain_events event SET confirmation_status='orphaned'
      FROM qualification_reports report
      WHERE event.event_id=report.qualification_event_id AND report.mint=$1`,[MINT]);
    await decisions.enqueue(jobInput({
      sourceConfirmationStatus:'orphaned',inputFingerprint:'7'.repeat(64),
    }));

    const orphanReplay=await inbox.claim(2_102,120);
    assert.ok(orphanReplay);
    await inbox.markProcessed('signature',orphanReplay.leaseToken,'orphaned');
    await pool.query(`WITH retention AS MATERIALIZED (
      SELECT clock_timestamp() AS now
    ) UPDATE chain_transaction_inbox SET
      processed_at=retention.now-INTERVAL '5 hours',
      terminal_at=retention.now-INTERVAL '5 hours',
      purge_after=retention.now-INTERVAL '1 hour'
      FROM retention
      WHERE signature='signature'`);
    await pool.query(`UPDATE chain_transaction_finality_replay_receipts receipt SET
      replay_completed_at=inbox.processed_at
      FROM chain_transaction_inbox inbox
      WHERE receipt.signature=inbox.signature AND inbox.signature='signature'`);

    await pool.query(`DELETE FROM chain_transaction_finality_replay_receipts
      WHERE signature='signature'`);
    assert.equal((await purgeExpiredFoundationData(pool)).transactionInbox,0);
    await pool.query(`INSERT INTO chain_transaction_finality_replay_receipts (
      signature,observed_slot,confirmation_status,finality_evidence_version,
      immutable_fingerprint,replay_completed_at
    ) SELECT signature,observed_slot,target_confirmation_status,finality_evidence_version,
      immutable_fingerprint,processed_at FROM chain_transaction_inbox
      WHERE signature='signature'`);
    assert.equal((await purgeExpiredFoundationData(pool)).transactionInbox,1);
    assert.equal((await pool.query(`SELECT confirmation_status
      FROM chain_transaction_finality_replay_receipts WHERE signature='signature'`))
      .rows[0]?.confirmation_status,'orphaned');
    await assert.rejects(inbox.enqueue(Object.freeze({
      signature:'signature',slot:10n,source:'CATCH_UP' as const,
      programIds:Object.freeze(['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']),
      confirmationStatus:'confirmed' as const,observedAtMs:3_000,
    })),TransactionInboxConflictError);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count
      FROM chain_transaction_inbox WHERE signature='signature'`)).rows[0]?.count,0);

    const restarted=paperDecisionRepository(pool);
    const orphanJob=await restarted.claim({nowMs:3_001,leaseMs:10_000});
    assert.ok(orphanJob);
    await restarted.complete(orphanJob,creationSourceOrphanDecision(active,3_001));
    assert.equal((await pool.query(`SELECT state FROM paper_strategy_sessions
      WHERE session_id=$1`,[active.session?.id])).rows[0]?.state,'PAPER_RETRACTED');
  });
});

void test('orphan receipt mismatch and present pending inbox both block claim',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    await pool.query(`UPDATE raw_chain_events SET confirmation_status='orphaned'
      WHERE event_id=$1`,[RAW_EVENT_ID]);
    await pool.query(`UPDATE domain_events SET confirmation_status='orphaned'
      WHERE event_id=$1`,[SOURCE_EVENT_ID]);
    await setInboxState(pool,'signature','PENDING','orphaned');
    await pool.query(`INSERT INTO chain_transaction_finality_replay_receipts (
      signature,observed_slot,confirmation_status,finality_evidence_version,
      immutable_fingerprint,replay_completed_at
    ) VALUES ('signature',10,'orphaned',1,$1,$2)`,['f'.repeat(64),new Date(1_000)]);
    const decisions=paperDecisionRepository(pool);
    await decisions.enqueue(jobInput({
      sourceConfirmationStatus:'orphaned',inputFingerprint:'6'.repeat(64),
    }));

    assert.equal(await decisions.claim({nowMs:1_000,leaseMs:1_000}),null);
    await pool.query(`DELETE FROM chain_transaction_inbox WHERE signature='signature'`);
    await pool.query(`UPDATE chain_transaction_finality_replay_receipts
      SET observed_slot=11 WHERE signature='signature'`);
    assert.equal(await decisions.claim({nowMs:1_001,leaseMs:1_000}),null);
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

void test('PaperTradingEngine.open writes no position or trade while source replay is pending',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    const fixture=paperEngineOpenFixture();
    await replaceCurrentQualification(pool,fixture.projection);
    await setInboxState(pool,'signature','PENDING','finalized');
    const engine=new PaperTradingEngine({
      executionMode:'paper',paperQuoteMintAllowlist:['SOL'],dataRetentionHours:4,
    },new PostgresPaperTradingRepository(pool),fixture.profile,fixture.authority,{
      now:()=>QUALIFICATION_EVALUATED_AT_MS+1_000,
    });

    await assert.rejects(engine.open(fixture.command),hasCode('QUALIFICATION_NOT_CURRENT'));
    assert.deepEqual(await paperOpenRows(pool),{
      positions:0,trades:0,opened_events:0,sessions:0,candidates:0,
    });
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

void test('the paper inbox SHARE lock serializes enqueueRevision until paper commit',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    await pool.query(`DELETE FROM chain_transaction_inbox WHERE signature='signature'`);
    const replayableInbox=new PostgresTransactionInboxRepository(pool);
    await replayableInbox.enqueue(Object.freeze({
      signature:'signature',slot:10n,source:'WEBSOCKET' as const,
      programIds:Object.freeze(['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']),
      confirmationStatus:'confirmed' as const,observedAtMs:QUALIFICATION_EVALUATED_AT_MS,
    }));
    const inboxClaim=await replayableInbox.claim(QUALIFICATION_EVALUATED_AT_MS+1,120);
    assert.ok(inboxClaim);
    await replayableInbox.saveSnapshot(
      'signature',inboxClaim.leaseToken,paperNormalizedTransaction(),
    );
    await replayableInbox.markProcessed('signature',inboxClaim.leaseToken,'confirmed');
    const projection=canonicalProjection(decisionResult());
    const ledger=new PostgresPaperTradingRepository(pool);
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
    const schema=(await pool.query<{readonly current_schema:string}>(
      'SELECT current_schema() AS current_schema',
    )).rows[0]?.current_schema;
    assert.ok(schema);
    const contenderPool=new pg.Pool({
      connectionString:databaseUrl,max:1,
      options:`-c search_path=${schema} -c lock_timeout=100ms`,
    });
    try{
      const contender=new PostgresTransactionInboxRepository(contenderPool);
      await assert.rejects(contender.enqueueRevision(Object.freeze({
        signature:'signature',confirmationStatus:'finalized' as const,
        observedAtMs:QUALIFICATION_EVALUATED_AT_MS+2_000,
      })));
      assert.equal((await pool.query<{readonly processing_status:string}>(
        `SELECT processing_status FROM chain_transaction_inbox
          WHERE signature='signature'`,
      )).rows[0]?.processing_status,'PROCESSED');
    }finally{
      await contenderPool.end();
      releaseResolve();
      await holding;
    }
    await new PostgresTransactionInboxRepository(pool).enqueueRevision(Object.freeze({
      signature:'signature',confirmationStatus:'finalized' as const,
      observedAtMs:QUALIFICATION_EVALUATED_AT_MS+3_000,
    }));
    assert.deepEqual((await pool.query<{
      readonly processing_status:string;readonly target_confirmation_status:string;
    }>(`SELECT processing_status,target_confirmation_status
      FROM chain_transaction_inbox WHERE signature='signature'`)).rows[0],{
      processing_status:'PENDING',target_confirmation_status:'finalized',
    });
  });
});

void test('rejects a current report whose exact raw-backed source is orphaned',async(context)=>{
  if(databaseUrl===undefined){context.skip('TEST_DATABASE_URL is not configured');return;}
  await withSchema(async(pool)=>{
    await seed(pool);
    await pool.query(
      `UPDATE raw_chain_events SET confirmation_status='orphaned' WHERE event_id=$1`,
      [RAW_EVENT_ID],
    );
    await pool.query(
      `UPDATE domain_events SET confirmation_status='orphaned' WHERE event_id=$1`,
      [SOURCE_EVENT_ID],
    );
    const ledger=new PostgresPaperTradingRepository(pool);
    const projection=canonicalProjection(decisionResult());
    const before=await paperOpenRows(pool);

    await assert.rejects(ledger.transact(async transaction=>{
      await transaction.requireCurrentQualification({
        mint:MINT,reportId:projection.reportId,
        qualificationEventId:projection.qualificationEvent.id,
      });
    }),hasCode('QUALIFICATION_NOT_CURRENT'));

    assert.deepEqual(await paperOpenRows(pool),before);
    assert.deepEqual(before,{ positions:0,trades:0,opened_events:0,sessions:0,candidates:0 });
  });
});

void test('serializes a concurrent source orphan behind the paper source locks',async(context)=>{
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
    const orphan=await pool.connect();
    try{
      await orphan.query('BEGIN');
      await orphan.query(`SET LOCAL lock_timeout='100ms'`);
      await assert.rejects(orphan.query(
        `UPDATE raw_chain_events SET confirmation_status='orphaned' WHERE event_id=$1`,
        [RAW_EVENT_ID],
      ),/lock timeout/u);
      await orphan.query('ROLLBACK');
      releaseResolve();
      await holding;
      await orphan.query('BEGIN');
      await orphan.query(
        `UPDATE raw_chain_events SET confirmation_status='orphaned' WHERE event_id=$1`,
        [RAW_EVENT_ID],
      );
      await orphan.query(
        `UPDATE domain_events SET confirmation_status='orphaned' WHERE event_id=$1`,
        [SOURCE_EVENT_ID],
      );
      await orphan.query('COMMIT');
    }finally{
      releaseResolve();
      await holding;
      await orphan.query('ROLLBACK').catch(()=>undefined);
      orphan.release();
    }
    await assert.rejects(ledger.transact(async transaction=>{
      await transaction.requireCurrentQualification({
        mint:MINT,reportId:projection.reportId,
        qualificationEventId:projection.qualificationEvent.id,
      });
    }),hasCode('QUALIFICATION_NOT_CURRENT'));
  });
});

void test('stages, survives lease expiry, replays and completes one immutable decision', async (context) => {
  if (databaseUrl === undefined) {
    context.skip('TEST_DATABASE_URL is not configured');
    return;
  }
  await withSchema(async (pool) => {
    await seed(pool);
    const repository = paperDecisionRepository(pool, { maxAttempts: 3, baseDelayMs: 100 });
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

    await setRawConfirmation(pool,RAW_EVENT_ID,'signature','finalized');
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

function creationDecisionWithEvidence(tradeId: string, updatedAtMs: number): PaperDecisionResult {
  const base = decisionResult();
  const candidate = createTradingCandidate({
    mint:base.candidate.mint,
    strategy:Object.freeze({ id:'creation-entry-v1',version:1 }),
    qualificationReportId:base.candidate.qualificationReportId,
    qualificationProfile:base.candidate.qualificationProfile,
    evidenceFingerprint:base.candidate.evidenceFingerprint,
    asOfEvent:base.qualificationEvent,
    state:'ELIGIBLE',quoteAsset:base.candidate.quoteAsset,
    buyQuote:base.candidate.buyQuote,reverseSellQuote:base.candidate.reverseSellQuote,
    eligibleUntilMs:base.candidate.eligibleUntilMs,
    reasonCodes:['QUALIFIED_ENTRY'],createdAtMs:base.candidate.createdAtMs,
    purgeAfterMs:base.candidate.purgeAfterMs,
  });
  const candidateEvent = derivedEvent(
    'TradingCandidateUpdated',candidate.id,{ candidate },'confirmed',
    candidate.asOf.cursor,candidate.createdAtMs,
  );
  const cursor = Object.freeze({
    slot:11n,transactionIndex:0,instructionIndex:2,innerInstructionIndex:null,
  });
  const session = createCreationEntrySession({
    candidate,state:'WAITING_EXTERNAL_BUYS',reasonCode:'EXTERNAL_UNIQUE_BUY_OBSERVED',
    positionId:'paper-position',entryCursor:candidate.asOf.cursor,externalBuyTarget:10,
    externalBuyCount:1,countedTradeIds:[tradeId],countedBuyerWallets:['external-wallet'],
    externalMinimumBuyAmountRaw:1_000n,
    lastCountedCursor:cursor,minimumConfirmation:'confirmed',lastQuote:candidate.buyQuote,
    lastError:null,pendingExitReason:null,createdAtMs:candidate.createdAtMs,updatedAtMs,
    purgeAfterMs:updatedAtMs+14_400_000,
  });
  const sessionEvent = derivedEvent(
    'PaperStrategySessionUpdated',`${session.id}:${tradeId}`,{ session },
    'confirmed',candidate.asOf.cursor,updatedAtMs,
  );
  return Object.freeze({
    ...base,candidate,candidateEvent,session,sessionEvent,
    countedExternalBuys:Object.freeze([Object.freeze({
      sessionId:session.id,tradeId,mint:MINT,quoteMint:'SOL',trader:'external-wallet',
      quoteAmountRaw:2_000n,cursor,confirmationStatus:'confirmed' as const,
      observedAtMs:updatedAtMs,payloadVersion:2 as const,
    })]),
    requestedAction:'NONE' as const,
  });
}

function creationDecisionWithoutEvidence(
  base: PaperDecisionResult,
  updatedAtMs: number,
): PaperDecisionResult {
  assert.ok(base.session?.payloadVersion === 2);
  const session = createCreationEntrySession({
    candidate: base.candidate,
    state: 'WAITING_EXTERNAL_BUYS',
    reasonCode: 'QUALIFIED_ENTRY',
    positionId: 'paper-position',
    entryCursor: base.candidate.asOf.cursor,
    externalBuyTarget: base.session.externalBuyTarget,
    externalBuyCount: 0,
    externalMinimumBuyAmountRaw: base.session.externalMinimumBuyAmountRaw,
    countedTradeIds: [],
    countedBuyerWallets: [],
    lastCountedCursor: null,
    minimumConfirmation: base.session.minimumConfirmation,
    lastQuote: base.candidate.buyQuote,
    lastError: null,
    pendingExitReason: null,
    createdAtMs: base.session.createdAtMs,
    updatedAtMs,
    purgeAfterMs: updatedAtMs + 14_400_000,
  });
  const sessionEvent = Object.freeze({
    ...derivedEvent(
      'PaperStrategySessionUpdated', `${session.id}:orphaned-evidence`, { session },
      'confirmed', base.candidate.asOf.cursor, updatedAtMs,
    ),
    confirmationStatus: 'orphaned' as const,
  });
  return Object.freeze({
    ...base,
    session,
    sessionEvent,
    countedExternalBuys: Object.freeze([]),
    requestedAction: 'NONE' as const,
  });
}

function creationSourceOrphanDecision(
  base: PaperDecisionResult,
  updatedAtMs: number,
): PaperDecisionResult {
  assert.ok(base.session?.payloadVersion === 2);
  const session = createCreationEntrySession({
    candidate: base.candidate,
    state: 'PAPER_RETRACTED',
    reasonCode: 'SOURCE_ORPHANED',
    positionId: base.session.positionId,
    entryCursor: base.session.entryCursor,
    externalBuyTarget: base.session.externalBuyTarget,
    externalBuyCount: base.session.externalBuyCount,
    externalMinimumBuyAmountRaw: base.session.externalMinimumBuyAmountRaw,
    countedTradeIds: base.session.countedTradeIds,
    countedBuyerWallets: base.session.countedBuyerWallets,
    lastCountedCursor: base.session.lastCountedCursor,
    minimumConfirmation: base.session.minimumConfirmation,
    lastQuote: base.session.lastQuote,
    lastError: null,
    pendingExitReason: null,
    createdAtMs: base.session.createdAtMs,
    updatedAtMs,
    purgeAfterMs: updatedAtMs + 14_400_000,
  });
  const sessionEvent = Object.freeze({
    ...derivedEvent(
      'PaperStrategySessionUpdated', `${session.id}:source-orphaned`, { session },
      'confirmed', base.candidate.asOf.cursor, updatedAtMs,
    ),
    confirmationStatus: 'orphaned' as const,
  });
  return Object.freeze({
    ...base,
    session,
    sessionEvent,
    countedExternalBuys: Object.freeze([]),
    requestedAction: 'NONE' as const,
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

function paperEngineOpenFixture(){
  const profile=createDefaultQualificationRuleSet(60);
  const authority=new QualificationEngine(profile);
  const reportId=`qreport_${'9'.repeat(64)}`;
  const qualificationEvent=derivedEvent(
    'QualificationUpdated',reportId,Object.freeze({ reportId }),
    'confirmed',Object.freeze({
      slot:10n,transactionIndex:0,instructionIndex:1,innerInstructionIndex:null,
    }),QUALIFICATION_EVALUATED_AT_MS,'qualification','signature',
  );
  const report=authority.evaluateAuthorized({
    mint:MINT,triggerEventId:qualificationEvent.id,
  },{
    evaluatedAtMs:QUALIFICATION_EVALUATED_AT_MS,
    signals:Object.freeze({
      imageValid:true,socialCrossLinkConfirmed:true,creatorHasNotSold:true,
    }),
    blockers:Object.freeze([]),
    calibrationFacts:Object.freeze({
      top1HolderBps:null,top5HoldersBps:null,top10HoldersBps:null,
      maximumRelatedClusterBps:null,maximumSharedFunderCount:null,
      buySimulationSucceeded:true,sellQuoteAvailable:true,roundTripLossBps:1_100n,
      upstreamConditions:Object.freeze([]),
    }),
  });
  const projection:CanonicalQualificationProjection=Object.freeze({
    reportId,sourceEventId:SOURCE_EVENT_ID,sourceRawEventId:RAW_EVENT_ID,
    evidenceFingerprint:'9'.repeat(64),
    evaluation:canonicalProjection(decisionResult()).evaluation,
    report,qualificationEvent,
  });
  const command:OpenPaperPositionCommand=Object.freeze({
    mint:MINT,quoteAsset:Object.freeze({
      mint:'SOL',decimals:9,tokenProgram:'SPL_TOKEN' as const,
    }),
    strategy:Object.freeze({ id:'recovery',version:1 }),
    trigger:qualificationEvent,qualification:report,
    strategySessionId:`paper_session_${'7'.repeat(64)}`,
    qualificationReportId:reportId,candidateId:`candidate_${'8'.repeat(64)}`,
    buyQuote:paperEngineQuote('paper-engine-buy','SOL',MINT,100n,95n,90n),
    reverseSellQuote:paperEngineQuote('paper-engine-sell',MINT,'SOL',90n,91n,89n),
    maximumRoundTripLossBps:10_000n,
    expectedCurrentQualification:Object.freeze({
      mint:MINT,reportId,qualificationEventId:qualificationEvent.id,
    }),
  });
  return Object.freeze({ profile,authority,projection,command });
}

function paperEngineQuote(
  id:string,inputMint:string,outputMint:string,
  amountInRaw:bigint,amountOutRaw:bigint,minimumAmountOutRaw:bigint,
):PaperExecutionQuote{
  return Object.freeze({
    id,inputMint,outputMint,amountInRaw,amountOutRaw,
    minimumAmountOutRaw,feesRaw:1n,slippageBps:100n,
    priceImpactBps:50n,observedAtMs:QUALIFICATION_EVALUATED_AT_MS,observedSlot:10n,
  });
}

function paperNormalizedTransaction():NormalizedTransaction{
  return Object.freeze({
    signature:'signature',slot:10n,transactionIndex:0,
    confirmationStatus:'PROCESSED' as const,version:'legacy' as const,
    blockTimeMs:900,accountKeys:Object.freeze(['account']),
    signerKeys:Object.freeze(['account']),instructions:Object.freeze([Object.freeze({
      programId:'program',accounts:Object.freeze(['account']),
      data:Uint8Array.from([0,1,255]),instructionIndex:0,
      innerInstructionIndex:null,parentInstructionIndex:null,stackHeight:null,
    })]),
    preTokenBalances:Object.freeze([]),postTokenBalances:Object.freeze([]),
    preBalancesLamports:Object.freeze([100n]),postBalancesLamports:Object.freeze([99n]),
    feeLamports:1n,computeUnits:123n,logs:Object.freeze(['ok']),error:null,
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

function qualificationProjectionForProfile(
  profile: Readonly<{ id: string; version: number; fingerprint: string }>,
  evaluatedAtMs: number,
  identity: string,
): CanonicalQualificationProjection {
  const base = canonicalProjection(decisionResult());
  const report = Object.freeze({
    ...base.report,
    ruleSet: Object.freeze({ ...base.report.ruleSet, ...profile }),
    evaluatedAtMs,
  });
  const reportId = `qreport_${identity.repeat(64)}`;
  const evaluation = Object.freeze({ ...base.evaluation, evaluatedAtMs });
  const evidenceFingerprint = identity.repeat(64);
  const qualificationEvent = derivedEvent(
    'QualificationUpdated',
    reportId,
    Object.freeze({ reportId, evidenceFingerprint, evaluation, report }),
    'confirmed',
    base.qualificationEvent.cursor,
    evaluatedAtMs,
    'qualification',
  );
  return Object.freeze({
    reportId,
    sourceEventId: SOURCE_EVENT_ID,
    sourceRawEventId: RAW_EVENT_ID,
    evidenceFingerprint,
    evaluation,
    report,
    qualificationEvent,
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
  await seedProcessedInbox(pool,'signature',10n,'confirmed');
  await pool.query(`INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
    instruction_index,confirmation_status,blockchain_time,observed_at,payload_version,payload
  ) VALUES ($1,$2,'TokenLaunchDetected',$3,'pumpfun','pump','signature',10,0,1,
    'confirmed',$4,$5,1,$6)`, [
    SOURCE_EVENT_ID,RAW_EVENT_ID,MINT,new Date(900),new Date(1_000),toJsonValue({ launch }),
  ]);
  await seedQualification(pool,canonicalProjection(decisionResult()));
}

async function seedFinalityPreflightBacklog(
  pool:InstanceType<typeof pg.Pool>,
  count:number,
  readyRanks:readonly number[],
):Promise<void>{
  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,current_state,created_signature,
    created_slot,created_transaction_index,created_instruction_index,detected_at,updated_at
  ) SELECT 'fair-mint-'||value,'pumpfun','pump','creator','SPL_TOKEN','DETECTED',
    'fair-signature-'||value,10,0,1,to_timestamp(1),to_timestamp(1)
    FROM generate_series(1,$1) value`,[count]);
  await pool.query(`INSERT INTO raw_chain_events (
    event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
    confirmation_status,observed_at,payload_version,payload
  ) SELECT 'fair-raw-'||value,'pumpfun','pump','fair-mint-'||value,
    'fair-signature-'||value,10,0,1,'confirmed',to_timestamp(1),1,'{}'::jsonb
    FROM generate_series(1,$1) value`,[count]);
  await pool.query(`INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
    instruction_index,confirmation_status,observed_at,payload_version,payload
  ) SELECT 'fair-event-'||value,'fair-raw-'||value,'TokenLaunchDetected',
    'fair-mint-'||value,'pumpfun','pump','fair-signature-'||value,10,0,1,
    'confirmed',to_timestamp(1),1,'{}'::jsonb FROM generate_series(1,$1) value`,[count]);
  await pool.query(`INSERT INTO chain_transaction_inbox (
    signature,observed_slot,discovery_sources,program_ids,target_confirmation_status,
    processing_status,observed_at
  ) SELECT 'fair-signature-'||value,10,ARRAY['WEBSOCKET'],
    ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],'confirmed','PENDING',
    to_timestamp(1) FROM generate_series(1,$1) value`,[count]);
  if(readyRanks.length>0){
    await pool.query(`UPDATE chain_transaction_inbox SET processing_status='PROCESSED',
      normalized_transaction=jsonb_build_object('signature',signature),
      immutable_fingerprint=$2,processed_at=to_timestamp(1)
      WHERE signature=ANY($1::text[])`,[
      readyRanks.map((rank)=>`fair-signature-${rank}`),'f'.repeat(64),
    ]);
  }
  await pool.query(`INSERT INTO paper_decision_jobs (
    job_id,mint,source_event_id,source_raw_event_id,source_confirmation_status,
    input_fingerprint,status,max_attempts,base_delay_ms,created_at,updated_at,
    payload_version,payload
  ) SELECT 'paper_job_'||md5(value::text)||md5('job-'||value),
    'fair-mint-'||value,'fair-event-'||value,'fair-raw-'||value,'confirmed',
    md5('left-'||value)||md5('right-'||value),'PENDING',5,500,
    to_timestamp(1)+value*INTERVAL '1 millisecond',
    to_timestamp(1)+value*INTERVAL '1 millisecond',1,'{}'::jsonb
    FROM generate_series(1,$1) value`,[count]);
}

async function seedTrade(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  await pool.query(`INSERT INTO raw_chain_events (
    event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
    confirmation_status,observed_at,payload_version,payload
  ) VALUES ($1,'pumpfun','pump',$2,'trade-signature',11,0,2,'confirmed',$3,1,'{}')`, [
    TRADE_RAW_EVENT_ID, MINT, new Date(2_000),
  ]);
  await seedProcessedInbox(pool,'trade-signature',11n,'confirmed');
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

async function seedProcessedInbox(
  pool:InstanceType<typeof pg.Pool>,
  signature:string,
  slot:bigint,
  confirmationStatus:'processed'|'confirmed'|'finalized'|'orphaned',
):Promise<void>{
  const terminal=confirmationStatus==='finalized'||confirmationStatus==='orphaned';
  await pool.query(`INSERT INTO chain_transaction_inbox (
    signature,observed_slot,discovery_sources,program_ids,target_confirmation_status,
    processing_status,normalized_transaction,immutable_fingerprint,observed_at,
    processed_at,terminal_at,purge_after
  ) VALUES ($1,$2,ARRAY['WEBSOCKET'],
    ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],$3,'PROCESSED',
    $4,$5,$6,$6,$7,$8)
  ON CONFLICT (signature) DO UPDATE SET
    target_confirmation_status=EXCLUDED.target_confirmation_status,
    processing_status='PROCESSED',processed_at=EXCLUDED.processed_at,
    terminal_at=EXCLUDED.terminal_at,purge_after=EXCLUDED.purge_after`,[
    signature,slot.toString(),confirmationStatus,toJsonValue({ signature }),
    'f'.repeat(64),new Date(1_000),terminal?new Date(1_000):null,
    terminal?new Date(1_000+14_400_000):null,
  ]);
}

async function setInboxState(
  pool:InstanceType<typeof pg.Pool>,
  signature:string,
  state:'PENDING'|'PROCESSING'|'PROCESSED'|'FAILED',
  confirmationStatus:'processed'|'confirmed'|'finalized'|'orphaned',
):Promise<void>{
  const processed=state==='PROCESSED';
  const terminal=processed&&(confirmationStatus==='finalized'||confirmationStatus==='orphaned');
  await pool.query(`UPDATE chain_transaction_inbox SET
    target_confirmation_status=$2,processing_status=$3,
    lease_token=CASE WHEN $3='PROCESSING' THEN 'paper-finality-test-lease' END,
    lease_expires_at=CASE WHEN $3='PROCESSING' THEN clock_timestamp()+INTERVAL '1 minute' END,
    next_attempt_at=CASE WHEN $3='FAILED' THEN clock_timestamp()+INTERVAL '1 minute' END,
    error_code=CASE WHEN $3='FAILED' THEN 'RPC_TRANSIENT' END,
    error_name=CASE WHEN $3='FAILED' THEN 'PaperFinalityTestFailure' END,
    error_retryable=CASE WHEN $3='FAILED' THEN TRUE END,
    processed_at=CASE WHEN $3='PROCESSED' THEN $4::timestamptz END,
    terminal_at=CASE WHEN $5 THEN $4::timestamptz END,
    purge_after=CASE WHEN $5 THEN $4::timestamptz+INTERVAL '4 hours' END
    WHERE signature=$1`,[
    signature,confirmationStatus,state,new Date(1_000),terminal,
  ]);
}

async function seedRaw(
  pool:InstanceType<typeof pg.Pool>,
  input:Readonly<{
    eventId:string;signature:string;slot:bigint;transactionIndex:number;
    instructionIndex:number;confirmationStatus:'processed'|'confirmed'|'finalized'|'orphaned';
  }>,
):Promise<void>{
  await pool.query(`INSERT INTO raw_chain_events (
    event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
    confirmation_status,observed_at,payload_version,payload
  ) VALUES ($1,'pumpfun','pump',$2,$3,$4,$5,$6,$7,$8,1,'{}')`,[
    input.eventId,MINT,input.signature,input.slot.toString(),input.transactionIndex,
    input.instructionIndex,input.confirmationStatus,new Date(900),
  ]);
}

async function setRawConfirmation(
  pool:InstanceType<typeof pg.Pool>,
  eventId:string,
  signature:string,
  confirmationStatus:'processed'|'confirmed'|'finalized'|'orphaned',
):Promise<void>{
  await setInboxState(pool,signature,'PROCESSED',confirmationStatus);
  await pool.query(`UPDATE raw_chain_events SET confirmation_status=$2
    WHERE event_id=$1`,[eventId,confirmationStatus]);
}
