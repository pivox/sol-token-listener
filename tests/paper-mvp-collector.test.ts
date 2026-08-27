import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import type { PaperMvpRepository, PaperMvpRunSnapshot } from '../src/ports/paper-mvp-repository.js';
import type { PaperMvpSource } from '../src/ports/paper-mvp-source.js';
import { PaperMvpCollector } from '../src/application/paper-mvp-collector.js';
import { PostgresPaperMvpSource } from '../src/storage/paper-mvp-source.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import { createProviderUsageSnapshot } from '../src/ports/provider-usage-probe.js';
import {
  PaperMvpConflictError,
  PostgresPaperMvpRepository,
} from '../src/storage/paper-mvp.repository.js';

const OWNER = 'paper-mvp-owner-test';

const runSnapshot: PaperMvpRunSnapshot = Object.freeze({
  run: Object.freeze({
    runId: 'run-1',
    runnerOwnerId: OWNER,
    completionReason: null,
    configuration: Object.freeze({
      strategyId: 'creation-entry-v1', strategyVersion: 1, quoteMint: 'SOL',
      targetClosedPositions: 50, initialCapitalRaw: 1_000_000n,
      networkFeeRawPerTransaction: 5_000n, maxDurationMs: 60_000,
      providerIdentity: 'provider:test',
    }),
    state: 'RUNNING',
    counters: Object.freeze({
      creationsObserved: 0, entriesRejected: 0, unknownTerminalPositions: 0,
      duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
    }),
    providerUsage: Object.freeze({
      status: 'UNAVAILABLE', creditsUsedStart: null, creditsUsedEnd: null,
      rateLimitedCount: 0,
    }),
    closedPositions: 0, startedAtMs: 1_000, deadlineAtMs: 61_000,
    updatedAtMs: 1_000, terminalAtMs: null, purgeAfterMs: null,
    verdict: null, failureCode: null,
  }),
  samples: Object.freeze([]), unknownPositions: Object.freeze([]),
});

void test('collects exact authoritative position facts and preserves bigint values', async () => {
  const recordedProgress: Parameters<PaperMvpRepository['recordProgress']>[0][] = [];
  const repository = fakeRepository(async (progress) => {
    recordedProgress.push(progress);
    return Object.freeze({
      ...runSnapshot.run,
      counters: Object.freeze({
        ...runSnapshot.run.counters,
        ...progress.counters,
      }),
      closedPositions: 1,
      updatedAtMs: 8_000,
    });
  });
  const source: PaperMvpSource = Object.freeze({
    collectBatch: async () => Object.freeze({
      positions: Object.freeze([validFacts()]),
      creationsObserved: 12,
      entriesRejected: 4,
      duplicateLogicalBuys: 2,
      duplicateLogicalSells: 3,
    }),
  });

  const result = await new PaperMvpCollector(repository, source, () => 8_000)
    .collect({ runId: 'run-1', runnerOwnerId: OWNER, limit: 100 });

  assert.deepEqual(result, {
    scanned: 1, inserted: 1, valid: 1, unknown: 0,
    duplicateLogicalBuys: 2, duplicateLogicalSells: 3,
  });
  const recorded = recordedProgress[0];
  assert.ok(recorded);
  assert.equal(recorded.samples.length, 1);
  assert.equal(recorded.unknownPositions.length, 0);
  assert.deepEqual(recorded.samples[0], {
    positionId: 'position-1', mint: 'MINT', quoteMint: 'SOL',
    exitReason: 'TAKE_PROFIT_2X_EXECUTABLE', exitCategory: '2X',
    creationDetectedAtMs: 1_100, entryDecisionAtMs: 1_200,
    entryQuoteAtMs: 1_300, paperBuyAtMs: 1_400,
    exitTriggerAtMs: 1_500, exitQuoteAtMs: 1_600, paperSellAtMs: 1_700,
    buyAmountInRaw: 9_007_199_254_740_993n,
    buyAmountOutRaw: 15_000n, buyMinimumAmountOutRaw: 14_000n,
    buyFeesRaw: 10n, buySlippageBps: 100n, buyPriceImpactBps: 20n,
    sellAmountInRaw: 14_000n, sellAmountOutRaw: 10_000_000_000_000_000n,
    sellMinimumAmountOutRaw: 9_500_000_000_000_000n,
    sellFeesRaw: 11n, sellSlippageBps: 101n, sellPriceImpactBps: 21n,
    networkFeeRawPerTransaction: 5_000n,
    grossPnlRaw: 992_800_745_259_007n,
    modelNetPnlRaw: 492_800_745_249_007n,
    detectionToEntryLatencyMs: 300, exitTriggerToSellLatencyMs: 200,
    payloadVersion: 1,
  });
  assert.deepEqual(recorded.counters, {
    creationsObserved: 12, entriesRejected: 4,
    duplicateLogicalBuys: 2, duplicateLogicalSells: 3,
  });
});

void test('persists the authoritative provider probe snapshot on every collection', async () => {
  const recordedProgress: Parameters<PaperMvpRepository['recordProgress']>[0][] = [];
  const repository = fakeRepository(async (progress) => {
    recordedProgress.push(progress);
    return Object.freeze({ ...runSnapshot.run, updatedAtMs: progress.observedAtMs });
  });
  const source: PaperMvpSource = Object.freeze({
    collectBatch: async () => Object.freeze({
      positions: Object.freeze([]), creationsObserved: 3, entriesRejected: 2,
      duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
    }),
  });
  const evidence = createProviderUsageSnapshot({
    status: 'AVAILABLE', creditsUsedStart: 100n, creditsUsedEnd: 125n,
    rateLimitedCount: 1,
  });

  await new PaperMvpCollector(repository, source, () => 8_000, Object.freeze({
    identity: 'provider:test:v1', snapshot: async () => evidence,
  })).collect({ runId: 'run-1', runnerOwnerId: OWNER, limit: 100 });

  assert.deepEqual(recordedProgress[0]?.providerUsage, evidence);
  assert.deepEqual(recordedProgress[0]?.counters, {
    creationsObserved: 3, entriesRejected: 2,
    duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
  });
});

void test('accumulates bounded duplicate counts across distinct collection polls', async () => {
  let snapshot = runSnapshot;
  let poll = 0;
  const repository: PaperMvpRepository = Object.freeze({
    startOrResume: async () => snapshot.run,
    load: async () => snapshot,
    recordProgress: async (progress: Parameters<PaperMvpRepository['recordProgress']>[0]) => {
      snapshot = Object.freeze({
        ...snapshot,
        run: Object.freeze({
          ...snapshot.run,
          counters: Object.freeze({
            ...snapshot.run.counters,
            ...progress.counters,
          }),
          closedPositions: snapshot.run.closedPositions + progress.samples.length,
          updatedAtMs: progress.observedAtMs,
        }),
      });
      return snapshot.run;
    },
    terminalize: async () => snapshot.run,
  });
  const source: PaperMvpSource = Object.freeze({
    collectBatch: async () => {
      poll += 1;
      return Object.freeze({
        positions: Object.freeze([
          Object.freeze({ ...validFacts(), positionId: `position-${poll}` }),
        ]),
        creationsObserved: 0,
        entriesRejected: 0,
        duplicateLogicalBuys: poll === 1 ? 2 : 3,
        duplicateLogicalSells: poll === 1 ? 1 : 4,
      });
    },
  });
  const collector = new PaperMvpCollector(repository, source, () => 8_000 + poll);

  assert.equal((await collector.collect({ runId:'run-1',runnerOwnerId:OWNER,limit:1 })).duplicateLogicalBuys, 2);
  assert.deepEqual(await collector.collect({ runId:'run-1',runnerOwnerId:OWNER,limit:1 }), {
    scanned:1,inserted:1,valid:1,unknown:0,
    duplicateLogicalBuys:5,duplicateLogicalSells:5,
  });
});

void test('retries an interleaved stale collection without losing distinct duplicate counts', async () => {
  const result = await interleavedCollections(false);

  assert.equal(result.first.inserted + result.second.inserted, 2);
  assert.equal(result.snapshot.run.closedPositions, 2);
  assert.equal(result.snapshot.run.counters.duplicateLogicalBuys, 11);
});

void test('retries an interleaved stale collection without charging the same position twice', async () => {
  const result = await interleavedCollections(true);

  assert.equal(result.first.inserted + result.second.inserted, 1);
  assert.equal(result.snapshot.run.closedPositions, 1);
  assert.equal(result.snapshot.run.counters.duplicateLogicalBuys, 6);
});

void test('classifies terminal source gaps and contradictions as durable unknown positions', async () => {
  const facts = validFacts();
  const positions = Object.freeze([
    Object.freeze({ ...facts, positionId: 'retracted', status: 'PAPER_RETRACTED' }),
    Object.freeze({ ...facts, positionId: 'missing-time', exitTriggerAtMs: null }),
    Object.freeze({ ...facts, positionId: 'causal', exitTriggerAtMs: 1_200,
      closeEventObservedAtMs: 1_200 }),
    Object.freeze({ ...facts, positionId: 'fill', buyFillAmountOutRaw: '13999' }),
    Object.freeze({ ...facts, positionId: 'reason', sellReason: 'UNSUPPORTED' }),
    Object.freeze({ ...facts, positionId: 'orphaned-close',
      closeEventConfirmationStatus: 'orphaned' }),
  ]);
  const recordedProgress: Parameters<PaperMvpRepository['recordProgress']>[0][] = [];
  const repository = fakeRepository(async (progress) => {
    recordedProgress.push(progress);
    return Object.freeze({
      ...runSnapshot.run,
      counters: Object.freeze({
        ...runSnapshot.run.counters,
        ...progress.counters,
        unknownTerminalPositions: progress.unknownPositions.length,
      }),
      updatedAtMs: progress.observedAtMs,
    });
  });
  const source: PaperMvpSource = Object.freeze({
    collectBatch: async () => Object.freeze({
      positions, creationsObserved: 0, entriesRejected: 0,
      duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
    }),
  });

  const result = await new PaperMvpCollector(repository, source, () => 8_000)
    .collect({ runId: 'run-1', runnerOwnerId: OWNER, limit: 6 });

  assert.deepEqual(result, {
    scanned: 6, inserted: 6, valid: 0, unknown: 6,
    duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
  });
  assert.deepEqual(recordedProgress[0]?.unknownPositions, [
    { positionId: 'retracted', reason: 'POSITION_RETRACTED' },
    { positionId: 'missing-time', reason: 'MISSING_EXIT_TRIGGER_AT' },
    { positionId: 'causal', reason: 'INVALID_TIMESTAMP_ORDER' },
    { positionId: 'fill', reason: 'SOURCE_CONTRADICTION' },
    { positionId: 'reason', reason: 'UNSUPPORTED_EXIT_REASON' },
    { positionId: 'orphaned-close', reason: 'POSITION_RETRACTED' },
  ]);
});

void test('defensively waits when a non-finalized close reaches the collector', async () => {
  const recordedProgress: Parameters<PaperMvpRepository['recordProgress']>[0][] = [];
  const repository = fakeRepository(async (progress) => {
    recordedProgress.push(progress);
    return runSnapshot.run;
  });
  const source: PaperMvpSource = Object.freeze({
    collectBatch: async () => Object.freeze({
      positions:Object.freeze([
        Object.freeze({ ...validFacts(),closeEventConfirmationStatus:'confirmed' }),
      ]),creationsObserved:0,entriesRejected:0,
      duplicateLogicalBuys:0,duplicateLogicalSells:0,
    }),
  });

  assert.deepEqual(await new PaperMvpCollector(repository,source,() => 8_000)
    .collect({ runId:'run-1',runnerOwnerId:OWNER,limit:1 }), {
    scanned:0,inserted:0,valid:0,unknown:0,
    duplicateLogicalBuys:0,duplicateLogicalSells:0,
  });
  assert.equal(recordedProgress[0]?.samples.length,0);
  assert.equal(recordedProgress[0]?.unknownPositions.length,0);
});

void test('uses one bounded set-wise PostgreSQL query with exact trade IDs and all-trade duplicates', async () => {
  const queries: Readonly<{ text: string; values?: readonly unknown[] }>[] = [];
  const source = new PostgresPaperMvpSource({
    query: async (text, values) => {
      queries.push(values === undefined ? { text } : { text, values });
      return { rows: [], rowCount: 0 };
    },
  });

  const result = await source.collectBatch({
    runId: 'run-1', startedAtMs: 1_000, strategyId: 'creation-entry-v1',
    strategyVersion: 1, deadlineAtMs: 61_000, limit: 100,
  });

  assert.deepEqual(result, {
    positions: [], creationsObserved: 0, entriesRejected: 0,
    duplicateLogicalBuys: 0, duplicateLogicalSells: 0,
  });
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]?.values, [
    'run-1', new Date(1_000), new Date(61_000), 'creation-entry-v1', 1, 100,
  ]);
  assert.match(queries[0]?.text ?? '', /NOT EXISTS[\s\S]*paper_mvp_position_samples/u);
  assert.match(queries[0]?.text ?? '', /entry_trade_id/u);
  assert.match(queries[0]?.text ?? '', /exit_trade_id/u);
  assert.match(queries[0]?.text ?? '', /GREATEST\(COUNT\(\*\) FILTER[\s\S]*- 1, 0\)/u);
  assert.match(queries[0]?.text ?? '', /opened_at <= \$3[\s\S]*closed_at <= \$3/u);
  assert.match(queries[0]?.text ?? '', /close_event\.confirmation_status[\s\S]*finalized[\s\S]*orphaned/u);
  assert.match(queries[0]?.text ?? '', /candidates AS MATERIALIZED[\s\S]*LIMIT \$6/u);
  assert.match(queries[0]?.text ?? '', /run_creations AS MATERIALIZED[\s\S]*detected_at BETWEEN \$2 AND \$3/u);
  assert.match(queries[0]?.text ?? '', /SELECT DISTINCT candidate\.mint[\s\S]*CREATION_ENTRY_REJECTED[\s\S]*CREATION_ENTRY_EXPIRED/u);
  assert.match(queries[0]?.text ?? '', /candidate\.created_at BETWEEN \$2 AND \$3/u);
  assert.doesNotMatch(queries[0]?.text ?? '', /FROM paper_trades trade JOIN eligible/u);
  await assert.rejects(source.collectBatch({
    runId: 'run-1', startedAtMs: 1_000, strategyId: 'creation-entry-v1',
    strategyVersion: 1, deadlineAtMs: 61_000, limit: 1_001,
  }), /limit/u);
  assert.equal(queries.length, 1);
});

void test('collects and replays exact PostgreSQL facts before source retention', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL collector test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    await seedPostgresFacts(pool);
    const repository = new PostgresPaperMvpRepository(pool);
    const run = await repository.startOrResume(runSnapshot.run.configuration, OWNER, 1_000);
    assert.equal((await pool.query('SELECT 1 FROM paper_positions')).rowCount, 2);
    assert.equal((await pool.query('SELECT 1 FROM paper_trades')).rowCount, 4);
    const collector = new PaperMvpCollector(
      repository, new PostgresPaperMvpSource(pool), () => 2_000,
    );

    assert.deepEqual(await collector.collect({ runId:run.runId,runnerOwnerId:OWNER,limit:1 }), {
      scanned:1,inserted:1,valid:0,unknown:1,
      duplicateLogicalBuys:0,duplicateLogicalSells:0,
    });
    assert.equal((await repository.load(run.runId))?.samples.length,0);
    await pool.query("UPDATE domain_events SET confirmation_status='finalized' WHERE event_id='close-event'");
    assert.deepEqual(await collector.collect({ runId:run.runId,runnerOwnerId:OWNER,limit:1 }), {
      scanned:1,inserted:1,valid:1,unknown:0,
      duplicateLogicalBuys:1,duplicateLogicalSells:1,
    });
    assert.deepEqual(await collector.collect({ runId:run.runId,runnerOwnerId:OWNER,limit:1 }), {
      scanned:0,inserted:0,valid:0,unknown:0,
      duplicateLogicalBuys:1,duplicateLogicalSells:1,
    });
    const stored = await repository.load(run.runId);
    assert.equal(stored?.samples[0]?.creationDetectedAtMs, 1_100);
    assert.equal(stored?.samples[0]?.entryDecisionAtMs, 1_200);
    assert.equal(stored?.samples[0]?.entryQuoteAtMs, 1_300);
    assert.equal(stored?.samples[0]?.paperBuyAtMs, 1_400);
    assert.equal(stored?.samples[0]?.exitTriggerAtMs, 1_500);
    assert.equal(stored?.samples[0]?.exitQuoteAtMs, 1_600);
    assert.equal(stored?.samples[0]?.paperSellAtMs, 1_700);
    assert.equal(stored?.samples[0]?.buyAmountInRaw, 9_007_199_254_740_993n);
    assert.deepEqual(stored?.unknownPositions, [
      { positionId:'position-retracted',reason:'POSITION_RETRACTED' },
    ]);
  });
});

void test('waits on a confirmed close and records only UNKNOWN after its orphan replay', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL close finality test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    await seedPostgresFacts(pool);
    await pool.query("DELETE FROM paper_positions WHERE position_id='position-retracted'");
    const repository = new PostgresPaperMvpRepository(pool);
    const run = await repository.startOrResume(runSnapshot.run.configuration, OWNER, 1_000);
    const collector = new PaperMvpCollector(
      repository,new PostgresPaperMvpSource(pool),() => 2_000,
    );

    assert.deepEqual(await collector.collect({ runId:run.runId,runnerOwnerId:OWNER,limit:10 }), {
      scanned:0,inserted:0,valid:0,unknown:0,
      duplicateLogicalBuys:0,duplicateLogicalSells:0,
    });
    await pool.query("UPDATE domain_events SET confirmation_status='orphaned' WHERE event_id='close-event'");
    await pool.query("UPDATE paper_positions SET status='PAPER_RETRACTED' WHERE position_id='position-1'");
    assert.deepEqual(await collector.collect({ runId:run.runId,runnerOwnerId:OWNER,limit:10 }), {
      scanned:1,inserted:1,valid:0,unknown:1,
      duplicateLogicalBuys:1,duplicateLogicalSells:1,
    });
    const stored = await repository.load(run.runId);
    assert.equal(stored?.samples.length,0);
    assert.deepEqual(stored?.unknownPositions,[
      { positionId:'position-1',reason:'POSITION_RETRACTED' },
    ]);
  });
});

void test('retains an expired entry decision job until the active run samples its position', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL decision job retention test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    await seedPostgresFacts(pool);
    const now = Date.now();
    const expiredAt = now - 1_000;
    const terminalAt = expiredAt - 14_400_000;
    await pool.query(`UPDATE paper_decision_jobs SET
      created_at=$2,updated_at=$3,terminal_at=$3,purge_after=$4
      WHERE job_id=$1`, [
      `paper_job_${'a'.repeat(64)}`,new Date(terminalAt - 1_000),
      new Date(terminalAt),new Date(expiredAt),
    ]);
    await pool.query(`UPDATE domain_events SET terminal_at=$2,purge_after=$3
      WHERE event_id=$1`, ['source-open',new Date(terminalAt),new Date(expiredAt)]);
    await pool.query(`UPDATE raw_chain_events SET terminal_at=$2,purge_after=$3
      WHERE event_id=$1`, ['raw-open',new Date(terminalAt),new Date(expiredAt)]);
    await pool.query(`UPDATE paper_positions SET opened_at=$2,closed_at=$3,purge_after=$4
      WHERE position_id=$1`, [
      'position-1',new Date(now - 50_000),new Date(now - 40_000),new Date(expiredAt),
    ]);
    const repository = new PostgresPaperMvpRepository(pool);
    const run = await repository.startOrResume(runSnapshot.run.configuration, OWNER, now - 61_000);

    const protectedPurge = await purgeExpiredFoundationData(pool);
    assert.equal(protectedPurge.paperDecisionJobs,0);
    assert.equal((await pool.query('SELECT 1 FROM paper_decision_jobs')).rowCount,1);
    assert.equal((await pool.query("SELECT 1 FROM domain_events WHERE event_id='source-open'")).rowCount,1);
    assert.equal((await pool.query("SELECT 1 FROM raw_chain_events WHERE event_id='raw-open'")).rowCount,1);

    await repository.recordProgress({
      runId:run.runId,runnerOwnerId:OWNER,
      expectedUpdatedAtMs:run.updatedAtMs,observedAtMs:now,counters:Object.freeze({
        creationsObserved:0,entriesRejected:0,duplicateLogicalBuys:0,duplicateLogicalSells:0,
      }),providerUsage:run.providerUsage,samples:Object.freeze([]),unknownPositions:Object.freeze([
        Object.freeze({ positionId:'position-1',reason:'SOURCE_CONTRADICTION' as const }),
      ]),
    });
    const releasedPurge = await purgeExpiredFoundationData(pool);
    assert.equal(releasedPurge.paperDecisionJobs,1);
    assert.equal((await pool.query('SELECT 1 FROM paper_decision_jobs')).rowCount,0);
    assert.equal((await pool.query("SELECT 1 FROM domain_events WHERE event_id='source-open'")).rowCount,0);
    assert.equal((await pool.query("SELECT 1 FROM raw_chain_events WHERE event_id='raw-open'")).rowCount,0);
  });
});

void test('fails an abandoned run deterministically and releases its retained sources', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL abandoned run test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    await seedPostgresFacts(pool);
    const now = Date.now();
    const expiredAt = now - 1_000;
    const jobTerminalAt = expiredAt - 14_400_000;
    const startedAt = now - 181_000;
    const expectedTerminalAt = startedAt + 60_000 + 120_000;
    await pool.query(`UPDATE paper_decision_jobs SET
      updated_at=$2,terminal_at=$2,purge_after=$3 WHERE job_id=$1`, [
      `paper_job_${'a'.repeat(64)}`,new Date(jobTerminalAt),new Date(expiredAt),
    ]);
    await pool.query(`UPDATE domain_events SET terminal_at=$1,purge_after=$1
      WHERE event_id='source-open'`, [new Date(expiredAt)]);
    await pool.query(`UPDATE raw_chain_events SET terminal_at=$1,purge_after=$1
      WHERE event_id='raw-open'`, [new Date(expiredAt)]);
    await pool.query(`UPDATE paper_positions SET opened_at=$1,closed_at=$2,purge_after=$3
      WHERE position_id='position-1'`, [
      new Date(startedAt + 1_000),new Date(startedAt + 2_000),new Date(expiredAt),
    ]);
    const repository = new PostgresPaperMvpRepository(pool);
    const abandoned = await repository.startOrResume(runSnapshot.run.configuration, OWNER, startedAt);

    await purgeExpiredFoundationData(pool);

    const failed = await repository.load(abandoned.runId);
    assert.equal(failed?.run.state,'FAILED');
    assert.equal(failed?.run.failureCode,'RUN_DEADLINE_ABANDONED');
    assert.equal(failed?.run.terminalAtMs,expectedTerminalAt);
    assert.equal(failed?.run.purgeAfterMs,expectedTerminalAt + 14_400_000);
    assert.equal((await pool.query('SELECT 1 FROM paper_decision_jobs')).rowCount,0);
    const replacement = await repository.startOrResume(runSnapshot.run.configuration, OWNER, now);
    assert.notEqual(replacement.runId,abandoned.runId);

    await repository.terminalize({
      runId:replacement.runId,runnerOwnerId:OWNER,terminalAtMs:now,
      state:'FAILED',completionReason:null,report:null,
      failureCode:'TEST_TERMINAL',
    });
    const ancientStartedAt = now - 14_400_000 - 181_000;
    const ancient = await repository.startOrResume(
      runSnapshot.run.configuration,OWNER,ancientStartedAt,
    );
    const finalPurge = await purgeExpiredFoundationData(pool);
    assert.equal(finalPurge.paperMvpRuns,1);
    assert.equal(await repository.load(ancient.runId),null);
  });
});

void test('excludes rejected candidates created after the immutable run deadline', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL rejection-window test skipped');
    return;
  }
  await withSchema(databaseUrl, async (pool) => {
    await seedPostgresFacts(pool);
    const reportId = `qreport_${'c'.repeat(64)}`;
    await pool.query(`INSERT INTO qualification_reports (
      report_id,mint,source_event_id,source_raw_event_id,qualification_event_id,
      profile_id,profile_version,profile_fingerprint,evidence_fingerprint,verdict,
      preparation_score,social_score,onchain_score,total_score,as_of_slot,
      as_of_transaction_index,as_of_instruction_index,confirmation_status,evaluated_at,
      purge_after,payload_version,payload
    ) VALUES ($1,'MINT','source-open','raw-open','source-open','profile',1,$2,$3,
      'REJECTED',0,0,0,0,1,0,0,'confirmed',$4,$5,1,'{}')`, [
      reportId, 'd'.repeat(64), 'e'.repeat(64), new Date(1_200), new Date(14_401_200),
    ]);
    await pool.query(`INSERT INTO trading_candidates (
      candidate_id,mint,report_id,source_event_id,candidate_event_id,strategy_id,
      strategy_version,evidence_fingerprint,confirmation_status,state,quote_mint,
      quote_decimals,quote_token_program,reason_codes,created_at,purge_after,
      payload_version,payload
    ) VALUES ($1,'MINT',$2,'source-open','source-open','creation-entry-v1',1,$3,
      'confirmed','NOT_ELIGIBLE','SOL',9,'SPL_TOKEN',$4,$5,$6,1,'{}')`, [
      `candidate_${'f'.repeat(64)}`, reportId, 'a'.repeat(64),
      JSON.stringify(['CREATION_ENTRY_REJECTED']), new Date(62_000), new Date(14_462_000),
    ]);

    const batch = await new PostgresPaperMvpSource(pool).collectBatch({
      runId: 'run-window', startedAtMs: 1_000, deadlineAtMs: 61_000,
      strategyId: 'creation-entry-v1', strategyVersion: 1, limit: 10,
    });
    assert.equal(batch.creationsObserved, 1);
    assert.equal(batch.entriesRejected, 0);
  });
});

function fakeRepository(
  recordProgress: PaperMvpRepository['recordProgress'],
): PaperMvpRepository {
  return Object.freeze({
    startOrResume: async () => runSnapshot.run,
    load: async () => runSnapshot,
    recordProgress,
    terminalize: async () => runSnapshot.run,
  });
}

async function interleavedCollections(samePosition: boolean): Promise<Readonly<{
  first: Awaited<ReturnType<PaperMvpCollector['collect']>>;
  second: Awaited<ReturnType<PaperMvpCollector['collect']>>;
  snapshot: PaperMvpRunSnapshot;
}>> {
  let snapshot = runSnapshot;
  const sampled = new Set<string>();
  let releaseFirst: (() => void) | undefined;
  const firstMayContinue = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstEntered: (() => void) | undefined;
  const firstSourceEntered = new Promise<void>((resolve) => { firstEntered = resolve; });
  let sourceCalls = 0;
  const repository: PaperMvpRepository = Object.freeze({
    startOrResume: async () => snapshot.run,
    load: async () => snapshot,
    recordProgress: async (progress: Parameters<PaperMvpRepository['recordProgress']>[0]) => {
      if (progress.expectedUpdatedAtMs !== snapshot.run.updatedAtMs) {
        throw new PaperMvpConflictError('PROGRESS_SNAPSHOT_STALE');
      }
      if (progress.observedAtMs <= snapshot.run.updatedAtMs) {
        throw new PaperMvpConflictError('PROGRESS_REGRESSION');
      }
      for (const sample of progress.samples) sampled.add(sample.positionId);
      snapshot = Object.freeze({
        ...snapshot,
        run: Object.freeze({
          ...snapshot.run,
          counters: Object.freeze({
            ...snapshot.run.counters,
            ...progress.counters,
          }),
          closedPositions: sampled.size,
          updatedAtMs: progress.observedAtMs,
        }),
      });
      return snapshot.run;
    },
    terminalize: async () => snapshot.run,
  });
  const source: PaperMvpSource = Object.freeze({
    collectBatch: async () => {
      sourceCalls += 1;
      if (sourceCalls === 1) {
        firstEntered?.();
        await firstMayContinue;
      }
      const positionId = sourceCalls === 2 && !samePosition ? 'position-2' : 'position-1';
      const alreadySampled = sampled.has(positionId);
      return Object.freeze({
        positions: alreadySampled ? Object.freeze([]) : Object.freeze([
          Object.freeze({ ...validFacts(), positionId }),
        ]),
        creationsObserved: 0,
        entriesRejected: 0,
        duplicateLogicalBuys: alreadySampled ? 0 : sourceCalls === 2 ? 6 : 5,
        duplicateLogicalSells: 0,
      });
    },
  });
  const firstCollector = new PaperMvpCollector(repository,source,() => 2_000);
  const secondCollector = new PaperMvpCollector(repository,source,() => 2_000);
  const firstPromise = firstCollector.collect({ runId:'run-1',runnerOwnerId:OWNER,limit:1 });
  await firstSourceEntered;
  const second = await secondCollector.collect({ runId:'run-1',runnerOwnerId:OWNER,limit:1 });
  releaseFirst?.();
  const first = await firstPromise;
  return Object.freeze({ first,second,snapshot });
}

function validFacts(): Awaited<ReturnType<PaperMvpSource['collectBatch']>>['positions'][number] {
  return Object.freeze({
    positionId: 'position-1', status: 'PAPER_CLOSED', mint: 'MINT', quoteMint: 'SOL',
    creationDetectedAtMs: 1_100, entryDecisionAtMs: 1_200,
    entryDecisionJobCount: 1, entryDecisionJobAtMs: 1_200,
    entryQuoteAtMs: 1_300, paperBuyAtMs: 1_400,
    exitTriggerAtMs: 1_500, closeEventId: 'close-event-1',
    closeEventType: 'PaperPositionClosed', closeEventSource: 'paper-trading',
    closeEventConfirmationStatus: 'finalized',closeEventObservedAtMs: 1_500,
    exitQuoteAtMs: 1_600, paperSellAtMs: 1_700,
    entryTradeId: 'buy-1', buyTradeId: 'buy-1', buySide: 'BUY',
    buyInputMint: 'SOL', buyOutputMint: 'MINT',
    buyAmountInRaw: '9007199254740993', buyAmountOutRaw: '15000',
    buyMinimumAmountOutRaw: '14000', buyFillAmountOutRaw: '14000',
    buyFeesRaw: '10', buySlippageBps: '100', buyPriceImpactBps: '20',
    exitTradeId: 'sell-1', sellTradeId: 'sell-1', sellSide: 'SELL',
    sellInputMint: 'MINT', sellOutputMint: 'SOL', sellReason: 'TAKE_PROFIT_2X_EXECUTABLE',
    sellAmountInRaw: '14000', sellAmountOutRaw: '10000000000000000',
    sellMinimumAmountOutRaw: '9500000000000000', sellFillAmountOutRaw: '9500000000000000',
    sellFeesRaw: '11', sellSlippageBps: '101', sellPriceImpactBps: '21',
  });
}

async function withSchema(
  databaseUrl: string,
  operation: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `paper_mvp_collector_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString:databaseUrl });
  const pool = new pg.Pool({ connectionString:databaseUrl,options:`-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool });
    await operation(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function seedPostgresFacts(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  const date = (ms:number):Date => new Date(ms);
  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,quote_assets,current_state,
    created_signature,created_slot,created_transaction_index,created_instruction_index,
    created_inner_instruction_index,detected_at,updated_at
  ) VALUES ('MINT','pumpfun','pump','creator','SPL_TOKEN','[]','ACTIVE',
    'signature',1,0,0,NULL,$1,$1)`, [date(1_100)]);
  await pool.query(`INSERT INTO raw_chain_events (
    event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
    confirmation_status,observed_at,payload_version,payload
  ) VALUES ('raw-open','pumpfun','pump','MINT','signature',1,0,0,
    'confirmed',$1,1,'{}')`, [date(1_100)]);
  await pool.query(`INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
    instruction_index,confirmation_status,observed_at,payload_version,payload
  ) VALUES ('source-open','raw-open','TokenLaunchDetected','MINT','pumpfun','pump',
    'signature',1,0,0,'confirmed',$1,1,'{}')`, [date(1_100)]);
  const jobId = `paper_job_${'a'.repeat(64)}`;
  await pool.query(`INSERT INTO paper_decision_jobs (
    job_id,mint,source_event_id,source_raw_event_id,source_confirmation_status,
    input_fingerprint,status,max_attempts,base_delay_ms,created_at,updated_at,
    terminal_at,purge_after,payload_version,payload
  ) VALUES ($1,'MINT','source-open','raw-open','confirmed',$2,'COMPLETED',3,100,
    $3,$4,$4,$5,1,$6)`, [jobId,'b'.repeat(64),date(1_200),date(1_400),
    date(1_400 + 14_400_000),JSON.stringify({ result:{ requestedAction:'OPEN',sessionId:'session' } })]);
  await pool.query(`INSERT INTO domain_events (
    event_id,type,mint,source,program,signature,slot,transaction_index,
    instruction_index,confirmation_status,observed_at,payload_version,payload,
    terminal_at,purge_after
  ) VALUES ('close-event','PaperPositionClosed','MINT','paper-trading','pump',
    'close-signature',2,0,0,'confirmed',$1,1,'{}',$2,$3)`, [
    date(1_500),date(1_700),date(1_700 + 14_400_000),
  ]);
  await pool.query(`INSERT INTO paper_positions (
    position_id,mint,quote_mint,quote_decimals,quote_token_program,strategy_id,
    strategy_version,status,base_filled_raw,remaining_base_raw,quote_cost_raw,
    quote_proceeds_raw,gross_pnl_quote_raw,net_pnl_quote_raw,round_trip_loss_bps,
    entry_trade_id,exit_trade_id,open_command_hash,close_command_hash,trigger_event_id,
    payload_version,payload,opened_at,closed_at,purge_after,strategy_session_id,
    entry_decision_at,entry_decision_job_id,close_event_id,exit_trigger_at
  ) VALUES ('position-1','MINT','SOL',9,'SPL_TOKEN','creation-entry-v1',1,
    'PAPER_CLOSED',14000,0,9007199254740993,9500000000000000,1,1,100,
    'buy-1','sell-1','open-hash','close-hash','source-open',1,'{}',$1,$2,$3,
    'session',$4,$5,'close-event',$6)`, [date(1_400),date(1_700),
    date(1_700 + 14_400_000),date(1_200),jobId,date(1_500)]);
  await pool.query('ALTER TABLE paper_trades DROP CONSTRAINT paper_trades_position_id_side_key');
  const tradeSql = `INSERT INTO paper_trades (
    trade_id,position_id,side,quote_id,input_mint,output_mint,amount_in_raw,
    amount_out_raw,minimum_amount_out_raw,fill_amount_out_raw,fees_raw,slippage_bps,
    price_impact_bps,reason,payload_version,payload,created_at,quote_observed_at
  ) VALUES ($1,'position-1',$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,1,'{}',$13,$14)`;
  await pool.query(tradeSql, ['buy-1','BUY','buy-quote','SOL','MINT','9007199254740993',
    '15000','14000','10','100','20','QUALIFIED_ENTRY',date(1_400),date(1_300)]);
  await pool.query(tradeSql, ['buy-duplicate','BUY','buy-quote-2','SOL','MINT','1',
    '1','1','0','0','0','QUALIFIED_ENTRY',date(1_401),date(1_301)]);
  await pool.query(tradeSql, ['sell-1','SELL','sell-quote','MINT','SOL','14000',
    '10000000000000000','9500000000000000','11','101','21',
    'TAKE_PROFIT_2X_EXECUTABLE',date(1_700),date(1_600)]);
  await pool.query(tradeSql, ['sell-duplicate','SELL','sell-quote-2','MINT','SOL','1',
    '1','1','0','0','0','TAKE_PROFIT_2X_EXECUTABLE',date(1_701),date(1_601)]);
  await pool.query(`INSERT INTO paper_positions (
    position_id,mint,quote_mint,quote_decimals,quote_token_program,strategy_id,
    strategy_version,status,base_filled_raw,remaining_base_raw,quote_cost_raw,
    round_trip_loss_bps,entry_trade_id,open_command_hash,trigger_event_id,payload_version,
    payload,opened_at,closed_at,purge_after
  ) VALUES ('position-retracted','MINT','SOL',9,'SPL_TOKEN','creation-entry-v1',1,
    'PAPER_RETRACTED',1,1,1,0,'missing-buy','open-hash-2','source-open',1,'{}',
    $1,$2,$3)`, [date(1_500),date(1_800),date(1_800 + 14_400_000)]);
}

function quoteIdentifier(identifier:string):string {
  assert.match(identifier,/^[a-z_][a-z0-9_]*$/u);
  return `"${identifier}"`;
}
