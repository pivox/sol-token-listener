import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
      decision_event_id,status FROM execution_intents`);
    assert.deepEqual(stored.rows, [{
      side: 'BUY',
      quote_mint: WSOL,
      quote_amount_raw: '1000',
      decision_event_id: fixture.result.sessionEvent?.id,
      status: 'PENDING',
    }]);
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

function emissionFixture(nowMs: number): Readonly<{
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
    confirmationStatus: 'confirmed',
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
    minimumConfirmation: 'confirmed',
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
  const sessionEvent = sessionEventFor(session);
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

function sessionEventFor(
  session: NonNullable<PaperDecisionResult['session']>,
): DomainEvent {
  const qualifier = `${session.id}:${createHash('sha256')
    .update(canonicalStringifyJson(session))
    .digest('hex')}`;
  return Object.freeze({
    id: createDeterministicDerivedEventId({
      type: 'PaperStrategySessionUpdated',
      mint: session.mint,
      source: 'paper-decision',
      program: 'pumpfun',
      signature: 'open-signature',
      cursor: session.entryCursor,
      qualifier,
    }),
    type: 'PaperStrategySessionUpdated',
    mint: session.mint,
    source: 'paper-decision',
    program: 'pumpfun',
    signature: 'open-signature',
    cursor: session.entryCursor,
    confirmationStatus: 'confirmed',
    blockchainTimeMs: session.updatedAtMs,
    observedAtMs: session.updatedAtMs,
    payloadVersion: 1,
    payload: Object.freeze({ session }),
  });
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
