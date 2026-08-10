import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createDeterministicDerivedEventId, type DomainEvent } from '../src/domain/events.js';
import { createPaperStrategySession } from '../src/domain/paper-strategy.js';
import type { QualificationReport } from '../src/domain/qualification.js';
import { createTradingCandidate } from '../src/domain/trading-candidate.js';
import type { TokenLaunch } from '../src/domain/types.js';
import type {
  PaperDecisionJobInput,
  PaperDecisionResult,
} from '../src/ports/paper-decision-repository.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresPaperDecisionRepository } from '../src/storage/paper-decision.repository.js';
import { toJsonValue } from '../src/utils/json.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MINT = 'So11111111111111111111111111111111111111112';
const RAW_EVENT_ID = 'raw_paper_source';
const SOURCE_EVENT_ID = 'evt_paper_source';
const FINGERPRINT = 'a'.repeat(64);

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

function jobInput(): PaperDecisionJobInput {
  return Object.freeze({
    mint: MINT,
    sourceEventId: SOURCE_EVENT_ID,
    sourceRawEventId: RAW_EVENT_ID,
    sourceConfirmationStatus: 'confirmed',
    inputFingerprint: FINGERPRINT,
  });
}

function decisionResult(): PaperDecisionResult {
  const report = qualificationReport();
  const qualificationEvent = derivedEvent('QualificationUpdated', 'qualification', { report });
  const candidate = createTradingCandidate({
    mint: MINT,
    strategy: Object.freeze({ id: 'validated-external-buys', version: 1 }),
    qualificationReportId: `qreport_${'b'.repeat(64)}`,
    qualificationProfile: Object.freeze({
      id: 'pumpfun-v1-initial', version: 1, fingerprint: 'c'.repeat(64),
    }),
    evidenceFingerprint: 'd'.repeat(64),
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
    eligibleUntilMs: 46_000,
    reasonCodes: ['QUALIFIED_ENTRY'],
    createdAtMs: 1_000,
    purgeAfterMs: 14_401_000,
  });
  const candidateEvent = derivedEvent('TradingCandidateUpdated', candidate.id, { candidate });
  const session = createPaperStrategySession({
    candidate, state: 'BUY_PENDING', reasonCode: 'QUALIFIED_ENTRY', positionId: null,
    entryCursor: candidate.asOf.cursor, externalBuyTarget: 10, externalBuyCount: 0,
    countedTradeIds: [], lastCountedCursor: null, minimumConfirmation: 'confirmed',
    lastQuote: candidate.buyQuote, lastError: null, createdAtMs: 1_000,
    updatedAtMs: 1_000, purgeAfterMs: 14_401_000,
  });
  const sessionEvent = derivedEvent('PaperStrategySessionUpdated', session.id, { session });
  return Object.freeze({
    report, qualificationEvent, candidate, candidateEvent, session, sessionEvent,
    countedExternalBuys: Object.freeze([]), requestedAction: 'OPEN',
  });
}

function qualificationReport(): QualificationReport {
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
    verdict: 'QUALIFIED', evaluatedAtMs: 1_000,
  });
}

function derivedEvent(
  type: DomainEvent['type'],
  qualifier: string,
  payload: Readonly<Record<string, unknown>>,
): DomainEvent {
  const identity = {
    type, mint: MINT, source: 'paper-decision', program: 'pump', signature: 'signature',
    cursor: Object.freeze({ slot: 10n, transactionIndex: 0, instructionIndex: 1, innerInstructionIndex: null }),
    qualifier,
  } as const;
  return Object.freeze({
    id: createDeterministicDerivedEventId(identity), type, mint: MINT,
    source: identity.source, program: identity.program, signature: identity.signature,
    cursor: identity.cursor, confirmationStatus: 'confirmed', blockchainTimeMs: 900,
    observedAtMs: 1_000, payloadVersion: 1, payload: Object.freeze(payload),
  });
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
    instruction_index,confirmation_status,observed_at,payload_version,payload
  ) VALUES ($1,$2,'TokenLaunchDetected',$3,'pumpfun','pump','signature',10,0,1,
    'confirmed',$4,1,$5)`, [
    SOURCE_EVENT_ID, RAW_EVENT_ID, MINT, new Date(1_000), toJsonValue({ launch }),
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
