import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { createDeterministicDerivedEventId, type DomainEvent } from '../src/domain/events.js';
import { createCreationEntrySession } from '../src/domain/paper-strategy.js';
import type { PaperPosition } from '../src/domain/paper-trading.js';
import { createTradingCandidate } from '../src/domain/trading-candidate.js';
import type { PaperDecisionResult } from '../src/ports/paper-decision-repository.js';
import { migrateDatabase } from '../src/storage/database.js';
import {
  emitExecutionIntentInTransaction,
  type ExecutionIntentEmissionConfig,
} from '../src/storage/paper-decision.repository.js';
import { canonicalStringifyJson, toJsonValue } from '../src/utils/json.js';

const MINT = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const REPORT_ID = `qreport_${'b'.repeat(64)}`;
const QUALIFICATION_EVENT_ID = `evt_${'1'.repeat(64)}`;
const PROFILE_FINGERPRINT = 'c'.repeat(64);
const EVIDENCE_FINGERPRINT = 'd'.repeat(64);
const EMISSION: ExecutionIntentEmissionConfig = Object.freeze({
  quoteMintAllowlist: Object.freeze([WSOL]),
  wsolMint: WSOL,
  maximumQuoteAgeMs: 5_000,
  preflightPairEmissionEnabled: false,
});
const PAIRED_EMISSION: ExecutionIntentEmissionConfig = Object.freeze({
  ...EMISSION,
  preflightPairEmissionEnabled: true,
});

void test('paired emission creates a target and simulation sibling only for finalized OPEN', async () => {
  const fixture = emissionFixture(Date.now(), 'finalized');
  const client = new RecordingEmissionClient(fixture.position);

  await emitExecutionIntentInTransaction(client, fixture.result, PAIRED_EMISSION);

  assert.equal(client.intentInserts.length, 2);
  assert.equal(client.pairInserts.length, 1);
  const [target, sibling] = client.intentInserts;
  assert.ok(target);
  assert.ok(sibling);
  assert.equal(target[9], 'BUY');
  assert.equal(sibling[9], 'BUY');
  assert.notEqual(target[0], sibling[0]);
  for (const index of [3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) {
    assert.equal(sibling[index], target[index], `economic field ${index}`);
  }
  const pair = client.pairInserts[0];
  assert.ok(pair);
  assert.equal(pair[3], target[0]);
  assert.equal(pair[4], sibling[0]);
});

void test('paired emission refuses non-finalized OPEN before writing an intent', async () => {
  const fixture = emissionFixture(Date.now(), 'confirmed');
  const client = new RecordingEmissionClient(fixture.position);

  await assert.rejects(
    emitExecutionIntentInTransaction(client, fixture.result, PAIRED_EMISSION),
    /finalized/u,
  );
  assert.equal(client.intentInserts.length, 0);
  assert.equal(client.pairInserts.length, 0);
});

void test('paired emission preserves one canonical SELL and never creates a pair for CLOSE', async () => {
  const fixture = closeEmissionFixture(Date.now(), 'finalized');
  const client = new RecordingEmissionClient(fixture.position);

  await emitExecutionIntentInTransaction(client, fixture.result, PAIRED_EMISSION);

  assert.equal(client.intentInserts.length, 1);
  assert.equal(client.intentInserts[0]?.[9], 'SELL');
  assert.equal(client.pairInserts.length, 0);
});

void test('paired emission never retro-forms a pair around a replayed legacy target', async () => {
  const fixture = emissionFixture(Date.now(), 'finalized');
  const client = new RecordingEmissionClient(fixture.position, true);

  await emitExecutionIntentInTransaction(client, fixture.result, PAIRED_EMISSION);

  assert.equal(client.intentInserts.length, 1);
  assert.equal(client.pairInserts.length, 0);
});

void test('paper decision and neutral intent share rollback, commit, and replay boundaries', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: execution intent emission integration skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, async (pool) => {
    const fixture = emissionFixture(Date.now());
    await seedPosition(pool, fixture.position);
    await seedIntentLineage(pool, fixture.result);

    const rolledBack = await pool.connect();
    try {
      await rolledBack.query('BEGIN');
      await emitExecutionIntentInTransaction(rolledBack, fixture.result, EMISSION);
      await rolledBack.query('ROLLBACK');
    } finally {
      rolledBack.release();
    }
    assert.equal(await intentCount(pool), 0);

    const committed = await pool.connect();
    try {
      await committed.query('BEGIN');
      await emitExecutionIntentInTransaction(committed, fixture.result, EMISSION);
      await committed.query('COMMIT');
    } finally {
      committed.release();
    }
    const replayed = await pool.connect();
    try {
      await replayed.query('BEGIN');
      await emitExecutionIntentInTransaction(replayed, fixture.result, EMISSION);
      await replayed.query('COMMIT');
    } finally {
      replayed.release();
    }

    const stored = await pool.query(`SELECT side,quote_mint,quote_amount_raw::TEXT,
      candidate_id,decision_event_id,status FROM execution_intents`);
    assert.deepEqual(stored.rows, [{
      side: 'BUY',
      quote_mint: WSOL,
      quote_amount_raw: '1000',
      candidate_id: fixture.result.candidate.id,
      decision_event_id: fixture.result.sessionEvent?.id,
      status: 'PENDING',
    }]);
    await pool.query('UPDATE execution_intents SET candidate_id=NULL');
    const migration = await readFile(
      new URL('../migrations/043_execution_intent_causal_lineage.sql', import.meta.url),
      'utf8',
    );
    await pool.query(migration);
    const backfilled = await pool.query('SELECT candidate_id FROM execution_intents');
    assert.deepEqual(backfilled.rows, [{ candidate_id: fixture.result.candidate.id }]);
  });
});

void test('orphaned paper session evidence cannot emit an execution intent', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: orphan emission integration skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, async (pool) => {
    const fixture = emissionFixture(Date.now());
    await seedPosition(pool, fixture.position);
    assert.ok(fixture.result.sessionEvent);
    const orphaned = Object.freeze({
      ...fixture.result,
      sessionEvent: Object.freeze({
        ...fixture.result.sessionEvent,
        confirmationStatus: 'orphaned' as const,
      }),
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(
        emitExecutionIntentInTransaction(client, orphaned, EMISSION),
        TypeError,
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    assert.equal(await intentCount(pool), 0);
  });
});

void test('real PostgreSQL emits a pair only while the finalized causal lineage is current', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: paired lineage integration skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, async (pool) => {
    const fixture = emissionFixture(Date.now(), 'finalized');
    await seedPosition(pool, fixture.position);
    await seedIntentLineage(pool, fixture.result);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await emitExecutionIntentInTransaction(client, fixture.result, PAIRED_EMISSION);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const persisted = await pool.query(`SELECT
      (SELECT COUNT(*)::INTEGER FROM execution_intents) AS intents,
      (SELECT COUNT(*)::INTEGER FROM execution_preflight_intent_pairs) AS pairs,
      (SELECT BOOL_AND(candidate_id=$1) FROM execution_intents) AS same_candidate`, [
      fixture.result.candidate.id,
    ]);
    assert.deepEqual(persisted.rows, [{ intents: 2, pairs: 1, same_candidate: true }]);
  });
});

function emissionFixture(
  nowMs: number,
  confirmationStatus: 'confirmed' | 'finalized' = 'confirmed',
): Readonly<{
  readonly result: PaperDecisionResult;
  readonly position: PaperPosition;
}> {
  const cursor = Object.freeze({
    slot: 10n,
    transactionIndex: 0,
    instructionIndex: 1,
    innerInstructionIndex: null,
  });
  const qualificationEvent: DomainEvent = Object.freeze({
    id: QUALIFICATION_EVENT_ID,
    type: 'QualificationUpdated',
    mint: MINT,
    source: 'qualification',
    program: 'pumpfun',
    signature: 'qualification-signature',
    cursor,
    confirmationStatus,
    blockchainTimeMs: nowMs - 2_000,
    observedAtMs: nowMs - 2_000,
    payloadVersion: 1,
    payload: Object.freeze({}),
  });
  const buyQuote = Object.freeze({
    id: 'buy-quote',
    inputMint: WSOL,
    outputMint: MINT,
    amountInRaw: 1_000n,
    amountOutRaw: 950n,
    minimumAmountOutRaw: 900n,
    feesRaw: 5n,
    slippageBps: 100n,
    priceImpactBps: 20n,
    observedAtMs: nowMs - 1_000,
    observedSlot: 10n,
  });
  const candidate = createTradingCandidate({
    mint: MINT,
    strategy: Object.freeze({ id: 'creation-entry-v1', version: 1 }),
    qualificationReportId: REPORT_ID,
    qualificationProfile: Object.freeze({
      id: 'pumpfun-v1-initial',
      version: 1,
      fingerprint: PROFILE_FINGERPRINT,
    }),
    evidenceFingerprint: EVIDENCE_FINGERPRINT,
    asOfEvent: qualificationEvent,
    state: 'ELIGIBLE',
    quoteAsset: Object.freeze({ mint: WSOL, decimals: 9, tokenProgram: 'SPL_TOKEN' }),
    buyQuote,
    reverseSellQuote: Object.freeze({
      id: 'sell-quote',
      inputMint: MINT,
      outputMint: WSOL,
      amountInRaw: 900n,
      amountOutRaw: 850n,
      minimumAmountOutRaw: 800n,
      feesRaw: 5n,
      slippageBps: 100n,
      priceImpactBps: 20n,
      observedAtMs: nowMs - 1_000,
      observedSlot: 10n,
    }),
    eligibleUntilMs: nowMs + 30_000,
    reasonCodes: Object.freeze(['QUALIFIED_ENTRY']),
    createdAtMs: nowMs - 2_000,
    purgeAfterMs: nowMs + 14_400_000,
  });
  const positionId = snapshotId('paper_position', [
    MINT,
    'creation-entry-v1',
    1,
    QUALIFICATION_EVENT_ID,
  ]);
  const session = createCreationEntrySession({
    candidate,
    state: 'WAITING_EXTERNAL_BUYS',
    reasonCode: 'QUALIFIED_ENTRY',
    positionId,
    entryCursor: cursor,
    externalBuyTarget: 3,
    externalBuyCount: 0,
    externalMinimumBuyAmountRaw: 1n,
    countedTradeIds: Object.freeze([]),
    countedBuyerWallets: Object.freeze([]),
    lastCountedCursor: null,
    minimumConfirmation: confirmationStatus,
    lastQuote: buyQuote,
    lastError: null,
    pendingExitReason: null,
    createdAtMs: nowMs - 2_000,
    updatedAtMs: nowMs,
    purgeAfterMs: nowMs + 14_400_000,
  });
  const position: PaperPosition = Object.freeze({
    id: positionId,
    mint: MINT,
    quoteAsset: candidate.quoteAsset,
    strategy: candidate.strategy,
    status: 'PAPER_HOLDING',
    baseFilledRaw: 900n,
    remainingBaseRaw: 900n,
    quoteCostRaw: 1_000n,
    quoteProceedsRaw: null,
    grossPnlQuoteRaw: null,
    netPnlQuoteRaw: null,
    roundTripLossBps: 1_000n,
    entryTradeId: `paper_trade_${'6'.repeat(64)}`,
    exitTradeId: null,
    openCommandHash: `paper_open_command_${'4'.repeat(64)}`,
    closeCommandHash: null,
    triggerEventId: QUALIFICATION_EVENT_ID,
    strategySessionId: session.id,
    qualificationReportId: REPORT_ID,
    candidateId: candidate.id,
    closeEventId: null,
    openedAtMs: nowMs,
    closedAtMs: null,
    purgeAfterMs: null,
    payloadVersion: 1,
  });
  const sessionEvent = sessionEventFor(session, confirmationStatus);
  const candidateEvent: DomainEvent = Object.freeze({
    ...qualificationEvent,
    id: `evt_${'2'.repeat(64)}`,
    type: 'TradingCandidateUpdated',
    source: 'paper-decision',
    payload: Object.freeze({ candidate }),
  });
  return Object.freeze({
    position,
    result: Object.freeze({
      report: Object.freeze({}) as PaperDecisionResult['report'],
      qualificationEvent,
      candidate,
      candidateEvent,
      session,
      sessionEvent,
      countedExternalBuys: Object.freeze([]),
      requestedAction: 'OPEN',
    }),
  });
}

function closeEmissionFixture(
  nowMs: number,
  confirmationStatus: 'confirmed' | 'finalized',
): ReturnType<typeof emissionFixture> {
  const open = emissionFixture(nowMs, confirmationStatus);
  const externalBuyTarget = 3;
  const session = createCreationEntrySession({
    candidate: open.result.candidate,
    state: 'PAPER_CLOSED',
    reasonCode: 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED',
    positionId: open.position.id,
    entryCursor: open.result.candidate.asOf.cursor,
    externalBuyTarget,
    externalBuyCount: externalBuyTarget,
    externalMinimumBuyAmountRaw: 1n,
    countedTradeIds: Object.freeze(['trade-1', 'trade-2', 'trade-3']),
    countedBuyerWallets: Object.freeze(['wallet-1', 'wallet-2', 'wallet-3']),
    lastCountedCursor: null,
    minimumConfirmation: confirmationStatus,
    lastQuote: open.result.candidate.reverseSellQuote,
    lastError: null,
    pendingExitReason: 'EXTERNAL_UNIQUE_BUYERS_TARGET_REACHED',
    pendingExitTriggerAtMs: null,
    createdAtMs: nowMs - 2_000,
    updatedAtMs: nowMs,
    purgeAfterMs: nowMs + 14_400_000,
  });
  const position: PaperPosition = Object.freeze({
    ...open.position,
    status: 'PAPER_CLOSED',
    remainingBaseRaw: 0n,
    quoteProceedsRaw: 800n,
    grossPnlQuoteRaw: -200n,
    netPnlQuoteRaw: -205n,
    exitTradeId: `paper_trade_${'7'.repeat(64)}`,
    closeCommandHash: `paper_close_command_${'5'.repeat(64)}`,
    strategySessionId: session.id,
    closeEventId: `evt_${'2'.repeat(64)}`,
    closedAtMs: nowMs,
    purgeAfterMs: nowMs + 14_400_000,
  });
  const sessionEvent = sessionEventFor(session, confirmationStatus, true);
  return Object.freeze({
    position,
    result: Object.freeze({
      ...open.result,
      session,
      sessionEvent,
      requestedAction: 'CLOSE' as const,
    }),
  });
}

function sessionEventFor(
  session: NonNullable<PaperDecisionResult['session']>,
  confirmationStatus: 'confirmed' | 'finalized',
  close = false,
): DomainEvent {
  const cursor = close
    ? Object.freeze({ ...session.entryCursor, slot: session.entryCursor.slot + 1n })
    : session.entryCursor;
  const signature = close ? 'close-signature' : 'open-signature';
  const qualifier = `${session.id}:${createHash('sha256')
    .update(canonicalStringifyJson(session))
    .digest('hex')}`;
  return Object.freeze({
    id: createDeterministicDerivedEventId({
      type: 'PaperStrategySessionUpdated',
      mint: session.mint,
      source: 'paper-decision',
      program: 'pumpfun',
      signature,
      cursor,
      qualifier,
    }),
    type: 'PaperStrategySessionUpdated',
    mint: session.mint,
    source: 'paper-decision',
    program: 'pumpfun',
    signature,
    cursor,
    confirmationStatus,
    blockchainTimeMs: session.updatedAtMs,
    observedAtMs: session.updatedAtMs,
    payloadVersion: 1,
    payload: Object.freeze({ session }),
  });
}

class RecordingEmissionClient {
  public readonly intentInserts: readonly unknown[][] = [];
  public readonly pairInserts: readonly unknown[][] = [];

  public constructor(
    private readonly position: PaperPosition,
    private readonly replayTarget = false,
  ) {}

  public release(): void {}

  public async query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly Readonly<Record<string, unknown>>[]; readonly rowCount: number }> {
    if (text.includes('pg_advisory_xact_lock')) {
      return { rows: [{}], rowCount: 1 };
    }
    if (text.includes('FROM paper_positions')) {
      return { rows: [{ payload: toJsonValue(this.position) }], rowCount: 1 };
    }
    if (text.includes('AS lineage_current')) {
      return { rows: [{ lineage_current: true }], rowCount: 1 };
    }
    if (text.includes('INSERT INTO execution_intents AS intent')) {
      (this.intentInserts as unknown[][]).push([...values]);
      if (this.replayTarget && this.intentInserts.length === 1) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [intentRowFromInsert(values)], rowCount: 1 };
    }
    if (text.includes('FROM execution_intent_tombstones')) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('FROM execution_intents AS intent')) {
      const target = this.intentInserts[0];
      if (target === undefined) throw new Error('Target insert was not recorded.');
      return { rows: [intentRowFromInsert(target)], rowCount: 1 };
    }
    if (text.includes('INSERT INTO execution_preflight_intent_pairs AS pair')) {
      (this.pairInserts as unknown[][]).push([...values]);
      return { rows: [pairRowFromInsert(values)], rowCount: 1 };
    }
    if (text.includes('FROM execution_preflight_intent_pairs AS pair')) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error('Unexpected emission query.');
  }
}

function intentRowFromInsert(values: readonly unknown[]): Readonly<Record<string, unknown>> {
  return {
    id: values[0], payload_version: values[1], logical_order_key: values[2],
    strategy_id: values[3], strategy_version: values[4], position_id: values[5],
    candidate_id: values[6], logical_command_id: values[7], mint: values[8],
    side: values[9], venue_policy: values[10], quote_mint: values[11],
    quote_token_program: values[12], quote_decimals: values[13],
    quote_amount_raw: values[14], base_amount_raw: values[15], minimum_amount_out_raw: values[16],
    decision_event_id: values[17], decision_fingerprint: values[18],
    requested_at_ms: values[19], expires_at_ms: values[20], status: 'PENDING',
    attempt_count: 0, state_revision: '0', last_reason_code: null, terminal_at_ms: null,
    reconciliation_completed_at_ms: null, purge_after_ms: null,
    created_at_ms: values[19], updated_at_ms: values[19], lease_owner: null,
    lease_token: null, lease_expires_at_ms: null,
  };
}

function pairRowFromInsert(values: readonly unknown[]): Readonly<Record<string, unknown>> {
  return {
    pair_id: values[0], payload_version: values[1], pair_fingerprint: values[2],
    target_intent_id: values[3], simulation_intent_id: values[4],
    decision_event_id: values[5], decision_fingerprint: values[6],
    expires_at_ms: String(values[7]),
  };
}

async function seedPosition(
  pool: InstanceType<typeof pg.Pool>,
  position: PaperPosition,
): Promise<void> {
  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,quote_assets,current_state,
    created_signature,created_slot,created_transaction_index,created_instruction_index,
    created_inner_instruction_index,detected_at,updated_at
  ) VALUES ($1,'pumpfun','pumpfun','creator','SPL_TOKEN','[]','OBSERVING',
    'signature',1,0,0,NULL,$2,$2)`, [MINT, new Date(position.openedAtMs - 2_000)]);
  await pool.query(`INSERT INTO paper_positions (
    position_id,mint,quote_mint,quote_decimals,quote_token_program,strategy_id,
    strategy_version,status,base_filled_raw,remaining_base_raw,quote_cost_raw,
    quote_proceeds_raw,gross_pnl_quote_raw,net_pnl_quote_raw,round_trip_loss_bps,
    entry_trade_id,exit_trade_id,open_command_hash,close_command_hash,trigger_event_id,
    payload_version,payload,opened_at,closed_at,purge_after,strategy_session_id,
    qualification_report_id,candidate_id
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::NUMERIC,$10::NUMERIC,$11::NUMERIC,
    NULL,NULL,NULL,$12::NUMERIC,$13,NULL,$14,NULL,$15,1,$16,$17,NULL,NULL,$18,$19,$20)`, [
    position.id,
    position.mint,
    position.quoteAsset.mint,
    position.quoteAsset.decimals,
    position.quoteAsset.tokenProgram,
    position.strategy.id,
    position.strategy.version,
    position.status,
    position.baseFilledRaw.toString(),
    position.remainingBaseRaw.toString(),
    position.quoteCostRaw.toString(),
    position.roundTripLossBps.toString(),
    position.entryTradeId,
    position.openCommandHash,
    position.triggerEventId,
    toJsonValue(position),
    new Date(position.openedAtMs),
    position.strategySessionId,
    position.qualificationReportId,
    position.candidateId,
  ]);
}

async function seedIntentLineage(
  pool: InstanceType<typeof pg.Pool>,
  result: PaperDecisionResult,
): Promise<void> {
  const sessionEvent = result.sessionEvent;
  if (sessionEvent === null) throw new TypeError('Session event is missing.');
  const rawEventId = 'raw_execution_intent_emission';
  const source = result.qualificationEvent;
  await pool.query(`INSERT INTO raw_chain_events (
    event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
    inner_instruction_index,confirmation_status,blockchain_time,observed_at,payload_version,
    payload,processing_status
  ) VALUES ($1,$2,$3,$4,$5,$6,0,1,NULL,'finalized',$7,$7,1,'{}','processed')`, [
    rawEventId, source.source, source.program, source.mint, source.signature,
    source.cursor.slot.toString(), new Date(source.observedAtMs),
  ]);
  for (const event of [source, result.candidateEvent, sessionEvent]) {
    await pool.query(`INSERT INTO domain_events (
      event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
      instruction_index,inner_instruction_index,confirmation_status,blockchain_time,
      observed_at,payload_version,payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'finalized',$12,$13,$14,$15)`, [
      event.id, rawEventId, event.type, event.mint, event.source, event.program,
      event.signature, event.cursor.slot.toString(), event.cursor.transactionIndex,
      event.cursor.instructionIndex, event.cursor.innerInstructionIndex,
      event.blockchainTimeMs === null ? null : new Date(event.blockchainTimeMs),
      new Date(event.observedAtMs), event.payloadVersion, toJsonValue(event.payload),
    ]);
  }
  const candidate = result.candidate;
  await pool.query(`INSERT INTO qualification_reports (
    report_id,mint,source_event_id,source_raw_event_id,qualification_event_id,
    profile_id,profile_version,profile_fingerprint,evidence_fingerprint,verdict,
    preparation_score,social_score,onchain_score,total_score,as_of_slot,
    as_of_transaction_index,as_of_instruction_index,as_of_inner_instruction_index,
    confirmation_status,evaluated_at,superseded_at,purge_after,payload_version,payload
  ) VALUES ($1,$2,$3,$4,$3,$5,$6,$7,$8,'QUALIFIED',15,25,60,100,$9,0,1,NULL,
    'finalized',$10,NULL,$11,1,'{}')`, [
    candidate.qualificationReportId, candidate.mint, source.id, rawEventId,
    candidate.qualificationProfile.id, candidate.qualificationProfile.version,
    candidate.qualificationProfile.fingerprint, candidate.evidenceFingerprint,
    candidate.asOf.cursor.slot.toString(), new Date(candidate.createdAtMs),
    new Date(candidate.createdAtMs + 14_400_000),
  ]);
  await pool.query(`INSERT INTO trading_candidates (
    candidate_id,mint,report_id,source_event_id,candidate_event_id,strategy_id,
    strategy_version,evidence_fingerprint,confirmation_status,state,quote_mint,
    quote_decimals,quote_token_program,reason_codes,eligible_until,created_at,
    superseded_at,purge_after,payload_version,payload
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'finalized','ELIGIBLE',$9,9,'SPL_TOKEN',
    '["QUALIFIED_ENTRY"]',$10,$11,NULL,$12,1,$13)`, [
    candidate.id, candidate.mint, candidate.qualificationReportId, source.id,
    result.candidateEvent.id, candidate.strategy.id, candidate.strategy.version,
    candidate.evidenceFingerprint, candidate.quoteAsset.mint,
    new Date(candidate.eligibleUntilMs ?? candidate.createdAtMs + 30_000),
    new Date(candidate.createdAtMs), new Date(candidate.createdAtMs + 14_400_000),
    toJsonValue(candidate),
  ]);
}

async function intentCount(pool: InstanceType<typeof pg.Pool>): Promise<number> {
  const result = await pool.query<{ count: number }>(
    'SELECT COUNT(*)::INTEGER AS count FROM execution_intents',
  );
  return result.rows[0]?.count ?? -1;
}

function snapshotId(namespace: string, parts: readonly (string | number)[]): string {
  return `${namespace}_${createHash('sha256')
    .update(`${namespace}\u001f${JSON.stringify(parts)}`)
    .digest('hex')}`;
}

async function withTemporarySchema(
  databaseUrl: string,
  run: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `execution_intent_emission_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path="${schema}"`,
  });
  try {
    await migrateDatabase({ pool });
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}
