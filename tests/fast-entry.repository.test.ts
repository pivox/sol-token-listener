import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Keypair } from '@solana/web3.js';
import pg from 'pg';
import {
  createEntryDecisionId,
  FAST_ENTRY_PROBE_QUOTE_AMOUNT_RAW,
  FAST_ENTRY_PROBE_STRATEGY_ID,
  FAST_ENTRY_STRATEGY_ID,
} from '../src/domain/fast-entry.js';
import type { PaperExecutionQuote } from '../src/domain/paper-trading.js';
import { migrateDatabase } from '../src/storage/database.js';
import {
  PostgresFastEntryRepository,
  type FastEntryLaunchContext,
} from '../src/storage/fast-entry.repository.js';

const SOL = 'So11111111111111111111111111111111111111112';
const PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const CREATE_SIGNATURE = 'create-signature';
const OBSERVED_AT_MS = Date.parse('2026-10-06T10:00:00.000Z');
const BLOCK_TIME_MS = Date.parse('2026-10-06T09:59:59.000Z');

void test('readLaunchForSignature returns the context only for the create signature', async (context) => {
  await withRepository(context, async (pool, repository) => {
    const { mint, creator } = await seedLaunch(pool);
    const launch = await repository.readLaunchForSignature(mint, CREATE_SIGNATURE);
    assert.ok(launch !== null);
    assert.equal(launch.mint, mint);
    assert.equal(launch.quoteMint, SOL);
    assert.equal(launch.quoteDecimals, 9);
    assert.equal(launch.quoteTokenProgram, 'SPL_TOKEN');
    assert.equal(launch.creator, creator);
    assert.equal(launch.createSlot, 100n);
    assert.equal(launch.createBlockTimeMs, BLOCK_TIME_MS);
    assert.equal(launch.creatorSoldInCreate, false);
    assert.equal(launch.launchEvent.id, `launch-${mint}`);
    assert.equal(launch.launchEvent.type, 'TokenLaunchDetected');
    assert.equal(launch.launchEvent.signature, CREATE_SIGNATURE);
    assert.deepEqual(launch.launchEvent.cursor, {
      slot: 100n, transactionIndex: 2, instructionIndex: 3, innerInstructionIndex: null,
    });
    assert.equal(launch.launchEvent.observedAtMs, OBSERVED_AT_MS);

    assert.equal(await repository.readLaunchForSignature(mint, 'another-signature'), null);
    assert.equal(await repository.recordRejection({
      launch, decidedAtMs: OBSERVED_AT_MS + 10, reason: 'NO_ENVELOPE_CAPACITY',
      roundTripLossBps: null, buyQuote: null, reverseQuote: null, envelopeId: null,
    }), 'RECORDED');
    assert.equal(await repository.readLaunchForSignature(mint, CREATE_SIGNATURE), null);
  });
});

void test('creatorSoldInCreate sees a creator SELL in the create transaction only', async (context) => {
  await withRepository(context, async (pool, repository) => {
    const buyOnly = await seedLaunch(pool);
    await seedTrade(pool, buyOnly.mint, CREATE_SIGNATURE, 'BUY', buyOnly.creator, 4);
    assert.equal((await repository.readLaunchForSignature(buyOnly.mint, CREATE_SIGNATURE))
      ?.creatorSoldInCreate, false);

    const otherSignature = await seedLaunch(pool);
    await seedTrade(pool, otherSignature.mint, 'later-signature', 'SELL', otherSignature.creator, 4);
    assert.equal((await repository.readLaunchForSignature(otherSignature.mint, CREATE_SIGNATURE))
      ?.creatorSoldInCreate, false);

    const sold = await seedLaunch(pool);
    await seedTrade(pool, sold.mint, CREATE_SIGNATURE, 'BUY', sold.creator, 4);
    await seedTrade(pool, sold.mint, CREATE_SIGNATURE, 'SELL', sold.creator, 5);
    assert.equal((await repository.readLaunchForSignature(sold.mint, CREATE_SIGNATURE))
      ?.creatorSoldInCreate, true);
  });
});

void test('readActiveEnvelope ignores revoked, expired, future and exhausted envelopes', async (context) => {
  await withRepository(context, async (pool, repository) => {
    const now = OBSERVED_AT_MS;
    await seedEnvelope(pool, { envelopeId: 'revoked', generationId: 'g1', state: 'REVOKED', now });
    await seedEnvelope(pool, { envelopeId: 'expired', generationId: 'g2', now,
      validFromMs: now - 7_200_000, validUntilMs: now - 1 });
    await seedEnvelope(pool, { envelopeId: 'future', generationId: 'g3', now,
      validFromMs: now + 1, validUntilMs: now + 3_600_000 });
    await seedEnvelope(pool, { envelopeId: 'exhausted', generationId: 'g4', now,
      maxBuys: 2, buysArmed: 2 });
    assert.equal(await repository.readActiveEnvelope(now), null);

    await seedEnvelope(pool, { envelopeId: 'usable', generationId: 'g5', now,
      perBuy: 25_000_000n, maxBuys: 3, buysArmed: 2 });
    assert.deepEqual(await repository.readActiveEnvelope(now), {
      envelopeId: 'usable', perBuyQuoteAmountRaw: 25_000_000n,
    });
  });
});

void test('recordRejection is idempotent per mint', async (context) => {
  await withRepository(context, async (pool, repository) => {
    const { mint } = await seedLaunch(pool);
    const launch = required(await repository.readLaunchForSignature(mint, CREATE_SIGNATURE));
    const buy = quote(SOL, mint, 100_000_000n, 1_000_000n);
    const sell = quote(mint, SOL, 1_000_000n, 50_000_000n);
    const input = {
      launch, decidedAtMs: OBSERVED_AT_MS + 20, reason: 'ROUND_TRIP_LOSS_EXCEEDED' as const,
      roundTripLossBps: 5_000n, buyQuote: buy, reverseQuote: sell, envelopeId: 'env',
    };
    assert.equal(await repository.recordRejection(input), 'RECORDED');
    assert.equal(await repository.recordRejection(input), 'ALREADY_DECIDED');
    const rows = await pool.query(`SELECT decision_id,decision,reason_code,round_trip_loss_bps,
      buy_quote,intent_id,envelope_id,entry_mode,launch_event_id,create_slot::TEXT AS create_slot,
      (EXTRACT(EPOCH FROM purge_after - decided_at) * 1000)::BIGINT::TEXT AS retention_ms
      FROM entry_decisions WHERE mint=$1`, [mint]);
    assert.equal(rows.rowCount, 1);
    const row = rows.rows[0] as Record<string, unknown>;
    assert.equal(row.decision_id, createEntryDecisionId(mint));
    assert.equal(row.decision, 'REJECTED');
    assert.equal(row.reason_code, 'ROUND_TRIP_LOSS_EXCEEDED');
    assert.equal(row.round_trip_loss_bps, 5_000);
    assert.equal(row.intent_id, null);
    assert.equal(row.envelope_id, 'env');
    assert.equal(row.entry_mode, 'fast');
    assert.equal(row.launch_event_id, `launch-${mint}`);
    assert.equal(row.create_slot, '100');
    assert.equal(row.retention_ms, String(7 * 24 * 60 * 60 * 1000));
    assert.equal((row.buy_quote as Record<string, unknown>).amountInRaw, '100000000');
  });
});

void test('recordBuy writes the decision, the event and a PENDING intent atomically', async (context) => {
  await withRepository(context, async (pool, repository) => {
    const { mint } = await seedLaunch(pool);
    const launch = required(await repository.readLaunchForSignature(mint, CREATE_SIGNATURE));
    const buy = quote(SOL, mint, 100_000_000n, 1_000_000n);
    const sell = quote(mint, SOL, 1_000_000n, 95_000_000n);
    const decidedAtMs = OBSERVED_AT_MS + 50;
    const input = {
      launch, decidedAtMs, envelope: { envelopeId: 'env', perBuyQuoteAmountRaw: 100_000_000n },
      buyQuote: buy, reverseQuote: sell, roundTripLossBps: 500n,
    };
    const result = await repository.recordBuy(input);
    assert.equal(result.kind, 'RECORDED');
    if (result.kind !== 'RECORDED') return;

    const decision = (await pool.query(`SELECT decision,reason_code,intent_id,envelope_id,
      round_trip_loss_bps,reverse_quote FROM entry_decisions WHERE mint=$1`, [mint])).rows[0] as Record<string, unknown>;
    assert.equal(decision.decision, 'BUY');
    assert.equal(decision.reason_code, null);
    assert.equal(decision.intent_id, result.intentId);
    assert.equal(decision.envelope_id, 'env');
    assert.equal(decision.round_trip_loss_bps, 500);
    assert.equal((decision.reverse_quote as Record<string, unknown>).minimumAmountOutRaw, '95000000');

    const intent = (await pool.query(`SELECT strategy_id,strategy_version,status,side,venue_policy,
      quote_mint,quote_amount_raw::TEXT AS quote_amount_raw,base_amount_raw,
      minimum_amount_out_raw::TEXT AS minimum_amount_out_raw,decision_event_id,candidate_id,
      logical_command_id,position_id,
      (EXTRACT(EPOCH FROM expires_at - requested_at) * 1000)::BIGINT::TEXT AS ttl_ms
      FROM execution_intents WHERE id=$1`, [result.intentId])).rows[0] as Record<string, unknown>;
    assert.equal(intent.strategy_id, FAST_ENTRY_STRATEGY_ID);
    assert.equal(intent.strategy_version, 1);
    assert.equal(intent.status, 'PENDING');
    assert.equal(intent.side, 'BUY');
    assert.equal(intent.venue_policy, 'PUMP_FUN_ONLY');
    assert.equal(intent.quote_mint, SOL);
    assert.equal(intent.quote_amount_raw, '100000000');
    assert.equal(intent.base_amount_raw, null);
    assert.equal(intent.minimum_amount_out_raw, '1000000');
    assert.equal(intent.candidate_id, null);
    assert.equal(intent.ttl_ms, '120000');
    const decisionId = createEntryDecisionId(mint);
    assert.equal(intent.logical_command_id, decisionId);
    assert.equal(intent.position_id, `fast_position_${decisionId.slice('entry_decision_'.length)}`);

    const event = (await pool.query(`SELECT type,mint,signature,raw_event_id,payload,
      confirmation_status FROM domain_events WHERE event_id=$1`, [intent.decision_event_id]))
      .rows[0] as Record<string, unknown>;
    assert.equal(event.type, 'FastEntryDecided');
    assert.equal(event.mint, mint);
    assert.equal(event.signature, CREATE_SIGNATURE);
    assert.equal(event.raw_event_id, null);
    assert.equal(event.confirmation_status, 'confirmed');
    const payload = event.payload as Record<string, unknown>;
    assert.equal(payload.decisionId, decisionId);
    assert.equal(payload.envelopeId, 'env');
    assert.equal(payload.roundTripLossBps, '500');
    assert.equal(((await pool.query(`SELECT 1 FROM api_event_stream WHERE domain_event_id=$1`,
      [intent.decision_event_id])).rowCount), 1);

    const before = await counts(pool);
    assert.deepEqual(await repository.recordBuy(input), { kind: 'ALREADY_DECIDED' });
    assert.deepEqual(await counts(pool), before);
  });
});

void test('recordBuy after a rejection returns ALREADY_DECIDED and writes nothing', async (context) => {
  await withRepository(context, async (pool, repository) => {
    const { mint } = await seedLaunch(pool);
    const launch = required(await repository.readLaunchForSignature(mint, CREATE_SIGNATURE));
    await repository.recordRejection({
      launch, decidedAtMs: OBSERVED_AT_MS + 1, reason: 'NO_ENVELOPE_CAPACITY',
      roundTripLossBps: null, buyQuote: null, reverseQuote: null, envelopeId: null,
    });
    const before = await counts(pool);
    assert.deepEqual(await repository.recordBuy({
      launch, decidedAtMs: OBSERVED_AT_MS + 2,
      envelope: { envelopeId: 'env', perBuyQuoteAmountRaw: 100_000_000n },
      buyQuote: quote(SOL, mint, 100_000_000n, 1_000_000n),
      reverseQuote: quote(mint, SOL, 1_000_000n, 95_000_000n), roundTripLossBps: 500n,
    }), { kind: 'ALREADY_DECIDED' });
    assert.deepEqual(await counts(pool), before);
  });
});

void test('recordProbe writes the event and a PENDING probe intent, never a BUY decision', async (context) => {
  await withRepository(context, async (pool, repository) => {
    const { mint } = await seedLaunch(pool);
    const launch = required(await repository.readLaunchForSignature(mint, CREATE_SIGNATURE));
    await repository.recordRejection({
      launch, decidedAtMs: OBSERVED_AT_MS + 1, reason: 'NO_ENVELOPE_CAPACITY',
      roundTripLossBps: null, buyQuote: null, reverseQuote: null, envelopeId: null,
    });
    const decidedAtMs = OBSERVED_AT_MS + 60;
    const result = await repository.recordProbe({
      launch, decidedAtMs, intervalMs: 600_000,
      buyQuote: quote(SOL, mint, FAST_ENTRY_PROBE_QUOTE_AMOUNT_RAW, 1_000n),
    });
    assert.equal(result.kind, 'RECORDED');
    if (result.kind !== 'RECORDED') return;
    const intent = (await pool.query(`SELECT strategy_id,strategy_version,status,side,live_reserved,
      quote_amount_raw::TEXT AS quote_amount_raw,minimum_amount_out_raw::TEXT AS minimum_amount_out_raw,
      decision_event_id,candidate_id,logical_command_id,position_id,
      (EXTRACT(EPOCH FROM expires_at - requested_at) * 1000)::BIGINT::TEXT AS ttl_ms
      FROM execution_intents WHERE id=$1`, [result.intentId])).rows[0] as Record<string, unknown>;
    assert.equal(intent.strategy_id, FAST_ENTRY_PROBE_STRATEGY_ID);
    assert.equal(intent.strategy_version, 1);
    assert.equal(intent.status, 'PENDING');
    assert.equal(intent.side, 'BUY');
    assert.equal(intent.live_reserved, false);
    assert.equal(intent.quote_amount_raw, FAST_ENTRY_PROBE_QUOTE_AMOUNT_RAW.toString());
    assert.equal(intent.minimum_amount_out_raw, '1000');
    assert.equal(intent.candidate_id, null);
    assert.equal(intent.ttl_ms, '120000');
    const suffix = createEntryDecisionId(mint).slice('entry_decision_'.length);
    assert.equal(intent.logical_command_id, `entry_probe_${suffix}`);
    assert.equal(intent.position_id, `fast_probe_position_${suffix}`);
    const event = (await pool.query(`SELECT type,payload FROM domain_events WHERE event_id=$1`,
      [intent.decision_event_id])).rows[0] as Record<string, unknown>;
    assert.equal(event.type, 'FastEntryDecided');
    assert.equal((event.payload as Record<string, unknown>).probe, true);
    assert.equal((event.payload as Record<string, unknown>).envelopeId, null);
    const decision = (await pool.query(`SELECT decision,reason_code,intent_id FROM entry_decisions
      WHERE mint=$1`, [mint])).rows[0] as Record<string, unknown>;
    assert.deepEqual({ ...decision }, { decision: 'REJECTED', reason_code: 'NO_ENVELOPE_CAPACITY', intent_id: null });
  });
});

void test('recordProbe skips inside the interval', async (context) => {
  await withRepository(context, async (pool, repository) => {
    const probe = async (decidedAtMs: number) => {
      const { mint } = await seedLaunch(pool);
      const launch = required(await repository.readLaunchForSignature(mint, CREATE_SIGNATURE));
      return (await repository.recordProbe({
        launch, decidedAtMs, intervalMs: 600_000,
        buyQuote: quote(SOL, mint, FAST_ENTRY_PROBE_QUOTE_AMOUNT_RAW, 1_000n),
      })).kind;
    };
    const probes = async () => (await pool.query(`SELECT COUNT(*)::INTEGER AS n FROM execution_intents
      WHERE strategy_id=$1`, [FAST_ENTRY_PROBE_STRATEGY_ID])).rows[0]?.n as number;
    assert.equal(await probe(OBSERVED_AT_MS), 'RECORDED');
    assert.equal(await probe(OBSERVED_AT_MS + 599_999), 'SKIPPED');
    assert.equal(await probes(), 1);
    assert.equal(await probe(OBSERVED_AT_MS + 600_000), 'RECORDED');

    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS n FROM domain_events
      WHERE type='FastEntryDecided'`)).rows[0]?.n, 2);
  });
});

void test('recordProbe skips while any envelope is ACTIVE, lot 3 (v1) included', async (context) => {
  await withRepository(context, async (pool, repository) => {
    await seedEnvelope(pool, { envelopeId: 'active-v1', generationId: 'g1', now: OBSERVED_AT_MS,
      validFromMs: OBSERVED_AT_MS + 5_000_000, validUntilMs: OBSERVED_AT_MS + 6_000_000 });
    const { mint } = await seedLaunch(pool);
    const launch = required(await repository.readLaunchForSignature(mint, CREATE_SIGNATURE));
    assert.equal((await repository.recordProbe({
      launch, decidedAtMs: OBSERVED_AT_MS, intervalMs: 600_000,
      buyQuote: quote(SOL, mint, FAST_ENTRY_PROBE_QUOTE_AMOUNT_RAW, 1_000n),
    })).kind, 'SKIPPED');
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS n FROM execution_intents`)).rows[0]?.n, 0);
  });
});

async function counts(pool: pg.Pool): Promise<Record<string, unknown>> {
  return (await pool.query(`SELECT
    (SELECT COUNT(*) FROM entry_decisions)::INTEGER AS decisions,
    (SELECT COUNT(*) FROM domain_events)::INTEGER AS events,
    (SELECT COUNT(*) FROM api_event_stream)::INTEGER AS stream,
    (SELECT COUNT(*) FROM execution_intents)::INTEGER AS intents`)).rows[0] as Record<string, unknown>;
}

function required(value: FastEntryLaunchContext | null): FastEntryLaunchContext {
  assert.ok(value !== null);
  return value;
}

function quote(
  inputMint: string,
  outputMint: string,
  amountInRaw: bigint,
  minimumAmountOutRaw: bigint,
): PaperExecutionQuote {
  return Object.freeze({
    id: `quote-${randomUUID()}`,
    inputMint,
    outputMint,
    amountInRaw,
    amountOutRaw: minimumAmountOutRaw + 1n,
    minimumAmountOutRaw,
    feesRaw: 10n,
    slippageBps: 1_000n,
    priceImpactBps: 5n,
    observedAtMs: OBSERVED_AT_MS,
    observedSlot: 100n,
  });
}

async function seedLaunch(pool: pg.Pool): Promise<{ mint: string; creator: string }> {
  const mint = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  const at = new Date(OBSERVED_AT_MS);
  const quoteAssets = JSON.stringify([{ mint: SOL, decimals: 9, tokenProgram: 'SPL_TOKEN' }]);
  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,quote_assets,current_state,
    created_signature,created_slot,created_transaction_index,created_instruction_index,
    created_inner_instruction_index,detected_at,updated_at
  ) VALUES ($1,'pumpfun',$2,$3,'SPL_TOKEN',$4,'DETECTED',$5,100,2,3,NULL,$6,$6)`,
  [mint, PROGRAM, creator, quoteAssets, CREATE_SIGNATURE, at]);
  await pool.query(`INSERT INTO domain_events (
    event_id,type,mint,source,program,signature,slot,transaction_index,instruction_index,
    inner_instruction_index,confirmation_status,blockchain_time,observed_at,payload_version,payload
  ) VALUES ($1,'TokenLaunchDetected',$2,'pumpfun',$3,$4,100,2,3,NULL,'confirmed',$5,$6,1,$7)`,
  [`launch-${mint}`, mint, PROGRAM, CREATE_SIGNATURE, new Date(BLOCK_TIME_MS), at,
    JSON.stringify({ launch: { mint, creator } })]);
  return { mint, creator };
}

async function seedTrade(
  pool: pg.Pool,
  mint: string,
  signature: string,
  kind: 'BUY' | 'SELL',
  trader: string,
  instructionIndex: number,
): Promise<void> {
  await pool.query(`INSERT INTO domain_events (
    event_id,type,mint,source,program,signature,slot,transaction_index,instruction_index,
    confirmation_status,observed_at,payload_version,payload
  ) VALUES ($1,'BondingCurveTradeObserved',$2,'pumpfun',$3,$4,100,2,$5,'confirmed',$6,1,$7)`,
  [`trade-${randomUUID()}`, mint, PROGRAM, signature, instructionIndex, new Date(OBSERVED_AT_MS),
    JSON.stringify({ trade: { launchMint: mint, kind, trader } })]);
}

async function seedEnvelope(pool: pg.Pool, input: Readonly<{
  envelopeId: string;
  generationId: string;
  now: number;
  state?: string;
  validFromMs?: number;
  validUntilMs?: number;
  perBuy?: bigint;
  maxBuys?: number;
  buysArmed?: number;
}>): Promise<void> {
  const state = input.state ?? 'ACTIVE';
  await pool.query(`INSERT INTO execution_entry_envelopes (
    envelope_id,generation_id,operator_id,payload_version,fingerprint,per_buy_quote_amount_raw,
    max_buys,max_open_positions,max_total_exposure_raw,max_realized_loss_raw,valid_from,valid_until,
    state,buys_armed,revoked_at,created_at,updated_at
  ) VALUES ($1,$2,'operator',1,$3,$4,$5,1,1000000000,500000000,$6,$7,$8,$9,$10,$11,$11)`, [
    input.envelopeId, input.generationId, 'a'.repeat(64), (input.perBuy ?? 10_000_000n).toString(),
    input.maxBuys ?? 5, new Date(input.validFromMs ?? input.now - 60_000),
    new Date(input.validUntilMs ?? input.now + 3_600_000), state, input.buysArmed ?? 0,
    state === 'REVOKED' ? new Date(input.now) : null, new Date(input.now - 60_000),
  ]);
}

async function withRepository(
  context: TestContext,
  run: (pool: pg.Pool, repository: PostgresFastEntryRepository) => Promise<void>,
): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: fast entry repository PG tests skipped');
    return;
  }
  const schema = `fast_entry_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await migrateDatabase({ pool });
    await run(pool, new PostgresFastEntryRepository(pool));
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}
