// Lot 4b Task 9: read-only fast-path report (funnel, latencies, exits, PnL, 429).
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import type pg from 'pg';
import type { PoolClient } from 'pg';
import {
  collectFastPathReport,
  formatFastPathReport,
  latencySummary,
  parseFastPathReportArguments,
  pnlBps,
  withReadOnlyTransaction,
  type FastPathReport,
} from '../src/cli/fast-path-report.js';
import {
  createOpenPositionFixture,
  exactBuyWalletPublicKey,
  generationId,
  quoteMint,
  requiredDatabaseUrl,
  withReplica,
  withTemporarySchema,
} from './helpers/live-sell-fixture.js';

type Pool = InstanceType<typeof pg.Pool>;

const NOW_MS = Date.parse('2026-10-07T12:00:00.000Z');
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

void test('fast-path report: options default to the last 24 h in table format', () => {
  assert.deepEqual(parseFastPathReportArguments([], NOW_MS), {
    sinceMs: NOW_MS - 24 * HOUR_MS, untilMs: NOW_MS, format: 'table',
  });
  assert.deepEqual(parseFastPathReportArguments([
    '--since=2026-10-07T10:00:00Z', '--until=2026-10-07T11:30:00.250+00:00', '--format=json',
  ], NOW_MS), {
    sinceMs: Date.parse('2026-10-07T10:00:00Z'),
    untilMs: Date.parse('2026-10-07T11:30:00.250Z'),
    format: 'json',
  });
  assert.deepEqual(parseFastPathReportArguments(['--until=2026-10-01T00:00:00Z'], NOW_MS), {
    sinceMs: Date.parse('2026-09-30T00:00:00Z'), untilMs: Date.parse('2026-10-01T00:00:00Z'),
    format: 'table',
  });
  // Exactly 7 days is accepted.
  assert.equal(parseFastPathReportArguments(['--since=2026-09-30T12:00:00Z'], NOW_MS).sinceMs,
    NOW_MS - 7 * 24 * HOUR_MS);
});

void test('fast-path report: invalid options are rejected', () => {
  for (const arguments_ of [
    ['--verbose'],
    ['--since'],
    ['--format=csv'],
    ['--since=2026-10-07T10:00:00Z', '--since=2026-10-07T11:00:00Z'],
    ['--since=2026-10-07'],
    ['--since=2026-10-07T10:00:00'],
    ['--since=yesterday'],
    ['--since=2026-13-40T10:00:00Z'],
    ['--since=2026-10-07T11:00:00Z', '--until=2026-10-07T10:00:00Z'],
    ['--since=2026-10-07T11:00:00Z', '--until=2026-10-07T11:00:00Z'],
    ['--since=2026-09-30T11:59:59Z'],
    ['--database-url=postgresql://x'],
  ]) {
    assert.throws(() => parseFastPathReportArguments(arguments_, NOW_MS), TypeError,
      arguments_.join(' '));
  }
});

void test('fast-path report: nearest-rank percentiles', () => {
  assert.deepEqual(latencySummary([]), { count: 0, p50: null, p90: null, max: null });
  assert.deepEqual(latencySummary([7]), { count: 1, p50: 7, p90: 7, max: 7 });
  assert.deepEqual(latencySummary([500, 100, 300, 200]), { count: 4, p50: 200, p90: 500, max: 500 });
  assert.deepEqual(latencySummary([10, 1, 9, 2, 8, 3, 7, 4, 6, 5]),
    { count: 10, p50: 5, p90: 9, max: 10 });
  assert.deepEqual(latencySummary([-20, 40]), { count: 2, p50: -20, p90: 40, max: 40 });
});

void test('fast-path report: pnlBps sign and rounding (half away from zero)', () => {
  assert.equal(pnlBps(2_000_000n, -1_000_000n), 20_000);
  assert.equal(pnlBps(-1_500n, -1_005_000n), -15); // -14.925
  assert.equal(pnlBps(1_500n, -1_005_000n), 15);
  assert.equal(pnlBps(1n, -20_000n), 1); // 0.5 -> 1
  assert.equal(pnlBps(-1n, -20_000n), -1); // -0.5 -> -1
  assert.equal(pnlBps(1n, -20_001n), 0); // 0.49997 -> 0
  assert.equal(pnlBps(0n, -1_000n), 0);
  assert.equal(pnlBps(-1_000n, 0n), null);
  assert.equal(pnlBps(-1_000n, 5n), null);
});

void test('fast-path report: table output of a fixed snapshot', () => {
  const report: FastPathReport = {
    schemaVersion: 'fast-path-report.v1',
    window: { sinceMs: NOW_MS - HOUR_MS, untilMs: NOW_MS },
    funnel: {
      createsObserved: 12, decisions: 5,
      rejectedByReason: { CREATOR_ALREADY_SOLD: 1, ROUND_TRIP_LOSS_EXCEEDED: 2 },
      buyIntents: 2, armed: 1, submitted: 1, confirmed: 1,
    },
    latenciesMs: {
      blockToObserved: { count: 3, p50: 800, p90: 1000, max: 1000 },
      observedToDecided: { count: 5, p50: 200, p90: 500, max: 500 },
      decidedToArmed: { count: 1, p50: 1500, p90: 1500, max: 1500 },
      armedToSubmitted: { count: 1, p50: 40, p90: 40, max: 40 },
      submittedToConfirmed: { count: 0, p50: null, p90: null, max: null },
    },
    positions: [{
      mint: 'MintA111111111111111111111111111111111111111', state: 'CLOSED',
      openedAtMs: NOW_MS - 30 * 60_000, closedAtMs: NOW_MS - 29 * 60_000, holdingMs: 60_000,
      exitReason: 'DEADLINE', reExits: 1, netLamports: '-1500', pnlBps: -15,
      failedSellFeesLamports: '0',
    }, {
      mint: 'MintB111111111111111111111111111111111111111', state: 'OPEN',
      openedAtMs: NOW_MS - 60_000, closedAtMs: null, holdingMs: null,
      exitReason: 'UNKNOWN', reExits: 0, netLamports: null, pnlBps: null,
      failedSellFeesLamports: '5000',
    }],
    rpc429: {
      listener: [{ providerId: 'primary', attempts: 120, http429Responses: 7, sinceMs: NOW_MS - 2 * HOUR_MS }],
      executor: { rateLimitEvents: 2, note: 'retention 4 h' },
    },
    retentionNote: 'armaments and signed artifacts are purged 4 h after terminal; run within 4 h of the run',
  };
  assert.equal(formatFastPathReport(report, 'table'), [
    'fast-path report v1  2026-10-07T11:00:00.000Z -> 2026-10-07T12:00:00.000Z',
    '',
    'Funnel',
    '  creates observed      12',
    '  decisions             5',
    '    rejected CREATOR_ALREADY_SOLD       1',
    '    rejected ROUND_TRIP_LOSS_EXCEEDED   2',
    '  buy intents           2',
    '  armed                 1',
    '  submitted             1',
    '  confirmed             1',
    '',
    'Latencies (ms)          count   p50       p90       max',
    '  blockToObserved       3       800       1000      1000',
    '  observedToDecided     5       200       500       500',
    '  decidedToArmed        1       1500      1500      1500',
    '  armedToSubmitted      1       40        40        40',
    '  submittedToConfirmed  0       -         -         -',
    '',
    'Positions (2)',
    '  mint                                          state         opened                    '
      + 'holdingMs exitReason        reExits  netLamports   pnlBps  failedSellFees',
    '  MintA111111111111111111111111111111111111111  CLOSED        2026-10-07T11:30:00.000Z  '
      + '60000     DEADLINE          1        -1500         -15     0',
    '  MintB111111111111111111111111111111111111111  OPEN          2026-10-07T11:59:00.000Z  '
      + '-         UNKNOWN           0        -             -       5000',
    '',
    'RPC 429',
    '  listener   primary  attempts=120  http429=7  since=2026-10-07T10:00:00.000Z',
    '  executor   rateLimitEvents=2  (retention 4 h)',
    '',
    'Note: armaments and signed artifacts are purged 4 h after terminal; run within 4 h of the run',
    '',
  ].join('\n'));
  assert.deepEqual(JSON.parse(formatFastPathReport(report, 'json')), report);
});

// ---------------------------------------------------------------------------------------------
// PostgreSQL: seeded dataset, exact report, read-only transaction
// ---------------------------------------------------------------------------------------------

void test('fast-path report: exact report over a seeded dataset, in a read-only transaction',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const seeded = await seed(pool);
      const client = await pool.connect();
      let report: FastPathReport;
      try {
        report = await withReadOnlyTransaction(client, async (database) => {
          const collected = await collectFastPathReport(database, seeded.window);
          await assert.rejects(
            database.query(`INSERT INTO execution_provider_rate_limit_events (
                event_id,provider_id,billing_period_id,endpoint_id,observed_at,purge_after
              ) VALUES ($1,'primary','p','send',now(),now() + INTERVAL '4 hours')`,
            [`execution_provider_rate_limit_${'f'.repeat(64)}`]),
            (error: unknown) => (error as { code?: string }).code === '25006',
          );
          return collected;
        });
        // The connection is usable again: the transaction was rolled back.
        assert.equal((await client.query('SELECT 1 AS one')).rows[0]?.one, 1);
      } finally {
        client.release();
      }

      assert.deepEqual(report, {
        schemaVersion: 'fast-path-report.v1',
        window: seeded.window,
        funnel: {
          createsObserved: 2,
          decisions: 4,
          rejectedByReason: { CREATOR_ALREADY_SOLD: 1, ROUND_TRIP_LOSS_EXCEEDED: 1 },
          buyIntents: 2,
          armed: 1,
          submitted: 1,
          confirmed: 1,
        },
        latenciesMs: {
          blockToObserved: { count: 3, p50: 800, p90: 1000, max: 1000 },
          observedToDecided: { count: 4, p50: 200, p90: 500, max: 500 },
          decidedToArmed: { count: 1, p50: 1500, p90: 1500, max: 1500 },
          armedToSubmitted: {
            count: 1, p50: seeded.armedToSubmittedMs, p90: seeded.armedToSubmittedMs,
            max: seeded.armedToSubmittedMs,
          },
          submittedToConfirmed: {
            count: 1, p50: seeded.submittedToConfirmedMs, p90: seeded.submittedToConfirmedMs,
            max: seeded.submittedToConfirmedMs,
          },
        },
        positions: [{
          mint: seeded.mints.deadline, state: 'CLOSED',
          openedAtMs: seeded.deadlineOpenedAtMs, closedAtMs: seeded.deadlineOpenedAtMs + 60_000,
          holdingMs: 60_000, exitReason: 'DEADLINE', reExits: 1,
          netLamports: '-1500', pnlBps: -15, failedSellFeesLamports: '0',
        }, {
          mint: seeded.mints.unknown, state: 'CLOSED',
          openedAtMs: seeded.unknownOpenedAtMs, closedAtMs: seeded.unknownOpenedAtMs + 45_000,
          holdingMs: 45_000, exitReason: 'UNKNOWN', reExits: 0,
          netLamports: '2000000', pnlBps: 20_000, failedSellFeesLamports: '0',
        }, {
          mint: seeded.mints.live, state: 'EXIT_PENDING',
          openedAtMs: seeded.liveOpenedAtMs, closedAtMs: null, holdingMs: null,
          exitReason: 'TAKE_PROFIT', reExits: 1, netLamports: null, pnlBps: null,
          failedSellFeesLamports: '5000',
        }],
        rpc429: {
          listener: [
            { providerId: 'primary', attempts: 120, http429Responses: 7, sinceMs: seeded.listenerStartedAtMs },
            { providerId: 'fallback-1', attempts: 30, http429Responses: 0, sinceMs: seeded.listenerStartedAtMs },
          ],
          executor: { rateLimitEvents: 2, note: 'retention 4 h' },
        },
        retentionNote: 'armaments and signed artifacts are purged 4 h after terminal; '
          + 'run within 4 h of the run',
      });

      const outputs = [formatFastPathReport(report, 'json'), formatFastPathReport(report, 'table')];
      for (const secret of [...seeded.secrets, databaseUrl, 'https://', 'postgresql://']) {
        for (const output of outputs) assert.equal(output.includes(secret), false, secret);
      }
    });
  });

// ---------------------------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------------------------

function base58(bytes: number): string {
  return bs58.encode(randomBytes(bytes));
}

function hex64(): string {
  return randomBytes(32).toString('hex');
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

async function seed(pool: Pool) {
  // A real position: exact BUY armed, submitted, confirmed and reconciled (CANARY fixture).
  const open = await createOpenPositionFixture(pool);
  const buyIntentId = open.buy.claim.intent.id;
  const positionId = open.positionId;
  const times = (await pool.query(
    `SELECT
       (EXTRACT(EPOCH FROM arm.armed_at) * 1000)::BIGINT::TEXT AS armed_at,
       (EXTRACT(EPOCH FROM signed.submitted_at) * 1000)::BIGINT::TEXT AS submitted_at,
       (EXTRACT(EPOCH FROM signed.confirmed_at) * 1000)::BIGINT::TEXT AS confirmed_at,
       (EXTRACT(EPOCH FROM position.opened_at) * 1000)::BIGINT::TEXT AS opened_at
     FROM execution_activation_armaments arm
     JOIN execution_signed_transactions signed ON signed.intent_id=arm.target_intent_id
     JOIN execution_live_positions position ON position.buy_intent_id=arm.target_intent_id
     WHERE arm.target_intent_id=$1`,
    [buyIntentId],
  )).rows[0] as Record<string, string> | undefined;
  assert.ok(times);
  const armedAtMs = Number(times.armed_at);
  const submittedAtMs = Number(times.submitted_at);
  const confirmedAtMs = Number(times.confirmed_at);
  const liveOpenedAtMs = Number(times.opened_at);
  const nowMs = Math.max(Date.now(), liveOpenedAtMs);
  const window = { sinceMs: nowMs - HOUR_MS, untilMs: nowMs + HOUR_MS };

  const mints = { live: base58(32), deadline: base58(32), unknown: base58(32), outside: base58(32) };
  const ledgerWallet = base58(32);
  const deadlinePositionId = `execution_live_position_${hex64()}`;
  const unknownPositionId = `execution_live_position_${hex64()}`;
  const outsidePositionId = `execution_live_position_${hex64()}`;
  const deadlineOpenedAtMs = nowMs - 30 * 60_000;
  const unknownOpenedAtMs = nowMs - 20 * 60_000;
  const listenerStartedAtMs = nowMs - 2 * HOUR_MS;
  const ledgerSignatures = Array.from({ length: 6 }, () => base58(64));
  const evidenceSignature = base58(64);
  const failedSellIntentId = `execution_intent_${hex64()}`;
  const retrySellIntentId = `execution_intent_${hex64()}`;

  await withReplica(pool, async (client: PoolClient) => {
    // The live position is EXIT_PENDING behind a TAKE_PROFIT re-exit; its first SELL landed
    // with an error and only cost the fee (NO_EFFECT, signature PRESENT).
    const sellAtMs = liveOpenedAtMs + 1_000;
    for (const [id, key, status, reason, requestedAtMs] of [
      [failedSellIntentId, `fast-exit:TAKE_PROFIT:${positionId}`, 'FAILED',
        'RECONCILIATION_PROVED_NO_EFFECT', sellAtMs],
      [retrySellIntentId, `fast-exit:TAKE_PROFIT:${positionId}:retry-1`, 'PENDING', null,
        sellAtMs + 40_000],
    ] as const) {
      await client.query(
        `INSERT INTO execution_intents (
           id,logical_order_key,strategy_id,strategy_version,position_id,logical_command_id,mint,
           side,venue_policy,quote_mint,quote_token_program,quote_decimals,base_amount_raw,
           minimum_amount_out_raw,decision_event_id,decision_fingerprint,requested_at,expires_at,
           status,last_reason_code,terminal_at,created_at,updated_at
         ) VALUES ($1,$2,'fast-entry-exit-v1',1,$3,$2,$4,'SELL','CANONICAL_EXIT',$5,'SPL_TOKEN',9,
           95,1,'decision:fast-path-report',$6,$7,$7::TIMESTAMPTZ + INTERVAL '1 minute',$8,$9,
           CASE WHEN $8='FAILED' THEN $7::TIMESTAMPTZ + INTERVAL '10 seconds' END,$7,$7)`,
        [id, key, positionId, mints.live, quoteMint, 'd'.repeat(64), iso(requestedAtMs), status,
          reason],
      );
    }
    await client.query(
      `UPDATE execution_live_positions SET mint=$2,state='EXIT_PENDING',exit_intent_id=$3
       WHERE position_id=$1`,
      [positionId, mints.live, retrySellIntentId],
    );
    for (const [result, reasonCode, fee, finalized] of [
      ['NO_EFFECT', 'RECONCILIATION_PROVED_NO_EFFECT', 5_000, true],
      ['MISMATCH', 'RESIDUAL_TOKEN_BALANCE', 7_000, false],
    ] as const) {
      await client.query(
        `INSERT INTO execution_reconciliation_evidence (
           evidence_id,evidence_fingerprint,intent_id,attempt_number,generation_id,provider_id,side,
           signature,blockhash,last_valid_block_height,message_hash,build_fingerprint,
           snapshot_fingerprint,maximum_fee_lamports,maximum_fee_payer_lamport_debit,
           signature_history,confirmation_status,finalized_block_height,observed_slot,fee_lamports,
           wallet_lamport_delta,base_delta_raw,quote_delta_raw,
           unexpected_residual_token_balance_raw,observed_at,finalized_at,result,reason_code,
           purge_after
         ) VALUES ($1,$2,$3,1,$4,'primary','SELL',$5,$6,1000,$7,$7,$7,10000,100000,'PRESENT',
           'FINALIZED',1001,130,$8,$8::NUMERIC * -1,0,0,0,$9,
           CASE WHEN $12 THEN $9::TIMESTAMPTZ END,$10,$11,
           CASE WHEN $12 THEN $9::TIMESTAMPTZ + INTERVAL '4 hours' END)`,
        [`execution_reconciliation_${hex64()}`, hex64(), failedSellIntentId, generationId,
          evidenceSignature, exactBuyWalletPublicKey, hex64(), fee, iso(sellAtMs + 5_000), result,
          reasonCode, finalized],
      );
    }

    // Durable ledger: a deadline exit re-issued once (tombstones), an exit whose intents and
    // tombstones are gone (UNKNOWN), and a position opened before the window.
    for (const [id, mint, openedAtMs, holdingMs, entryDelta, exitDelta, signatures] of [
      [deadlinePositionId, mints.deadline, deadlineOpenedAtMs, 60_000, -1_005_000, 1_003_500,
        ledgerSignatures.slice(0, 2)],
      [unknownPositionId, mints.unknown, unknownOpenedAtMs, 45_000, -1_000_000, 3_000_000,
        ledgerSignatures.slice(2, 4)],
      [outsidePositionId, mints.outside, nowMs - 2 * HOUR_MS, 30_000, -1_000_000, 900_000,
        ledgerSignatures.slice(4, 6)],
    ] as const) {
      await client.query(
        `INSERT INTO execution_live_position_ledger (
           position_id,wallet_public_key,mint,opened_at,closed_at,base_amount_raw,
           entry_wallet_lamport_delta,exit_wallet_lamport_delta,net_lamports,entry_signature,
           exit_signature
         ) VALUES ($1,$2,$3,$4,$5,95,$6,$7,$6::NUMERIC + $7::NUMERIC,$8,$9)`,
        [id, ledgerWallet, mint, iso(openedAtMs), iso(openedAtMs + holdingMs), entryDelta,
          exitDelta, signatures[0], signatures[1]],
      );
    }
    for (const [key, retiredAtMs] of [
      [`maximum-holding:${deadlinePositionId}`, deadlineOpenedAtMs + 4 * HOUR_MS],
      [`maximum-holding:${deadlinePositionId}:retry-1`, deadlineOpenedAtMs + 4 * HOUR_MS + 1_000],
      // Newer, mentions the position, but is not an exit key: never read.
      [`command:exit:${deadlinePositionId}`, deadlineOpenedAtMs + 5 * HOUR_MS],
      [`fast-exit:CREATOR_SOLD:${outsidePositionId}`, deadlineOpenedAtMs + 4 * HOUR_MS],
    ] as const) {
      await client.query(
        `INSERT INTO execution_intent_tombstones (intent_id,logical_order_key,decision_fingerprint,
           retired_at) VALUES ($1,$2,$3,$4)`,
        [`execution_intent_${hex64()}`, key, 'd'.repeat(64), iso(retiredAtMs)],
      );
    }
  });

  // Entry decisions: the fixture BUY (armed, submitted, confirmed), a BUY never armed, two
  // refusals in the window and one before it.
  const decisions: readonly (readonly [string, string | null, string | null, number | null,
    number, number])[] = [
    // decision, reason, intent, blockTime offset, observedAt, decided offset
    ['BUY', null, buyIntentId, -1_000, armedAtMs - 2_000, 500],
    ['BUY', null, `execution_intent_${hex64()}`, -500, nowMs - 15 * 60_000, 100],
    ['REJECTED', 'CREATOR_ALREADY_SOLD', null, null, nowMs - 10 * 60_000, 200],
    ['REJECTED', 'ROUND_TRIP_LOSS_EXCEEDED', null, -800, nowMs - 5 * 60_000, 300],
    ['REJECTED', 'ROUND_TRIP_LOSS_EXCEEDED', null, -800, nowMs - 2 * HOUR_MS, 300],
  ];
  for (const [decision, reason, intentId, blockOffset, observedAtMs, decidedOffset] of decisions) {
    const buy = decision === 'BUY';
    await pool.query(
      `INSERT INTO entry_decisions (
         decision_id,mint,launch_event_id,create_slot,create_block_time,observed_at,decided_at,
         entry_mode,decision,reason_code,round_trip_loss_bps,buy_quote,reverse_quote,intent_id,
         envelope_id,purge_after
       ) VALUES ($1,$2,$3,1,$4,$5,$6,'fast',$7,$8,$9,$10,$10,$11,$12,
         $6::TIMESTAMPTZ + INTERVAL '1 day')`,
      [`entry_decision_${hex64()}`, base58(32), `launch:${hex64()}`,
        blockOffset === null ? null : iso(observedAtMs + blockOffset), iso(observedAtMs),
        iso(observedAtMs + decidedOffset), decision, reason, buy ? 120 : null,
        buy ? '{}' : null, intentId, buy ? 'envelope-fast-path-report' : null],
    );
  }

  // Launches: two counted, one orphaned, one before the window, one of another type.
  for (const [type, status, createdAtMs] of [
    ['TokenLaunchDetected', 'finalized', nowMs - 40 * 60_000],
    ['TokenLaunchDetected', 'confirmed', nowMs - 39 * 60_000],
    ['TokenLaunchDetected', 'orphaned', nowMs - 38 * 60_000],
    ['TokenLaunchDetected', 'finalized', nowMs - 3 * HOUR_MS],
    ['BondingCurveTradeObserved', 'finalized', nowMs - 37 * 60_000],
  ] as const) {
    await pool.query(
      `INSERT INTO domain_events (
         event_id,type,mint,source,program,signature,slot,transaction_index,instruction_index,
         confirmation_status,observed_at,payload_version,payload,created_at
       ) VALUES ($1,$2,$3,'test','test',$4,1,0,0,$5,$6,1,'{}'::JSONB,$6)`,
      [`event:${hex64()}`, type, base58(32), base58(64), status, iso(createdAtMs)],
    );
  }

  // Executor 429s: two in the window, one before it.
  for (const observedAtMs of [nowMs - 50 * 60_000, nowMs - 10 * 60_000, nowMs - 2 * HOUR_MS]) {
    await pool.query(
      `INSERT INTO execution_provider_rate_limit_events (
         event_id,provider_id,billing_period_id,endpoint_id,observed_at,purge_after
       ) VALUES ($1,'primary','period','send',$2,$2::TIMESTAMPTZ + INTERVAL '4 hours')`,
      [`execution_provider_rate_limit_${hex64()}`, iso(observedAtMs)],
    );
  }

  // Listener heartbeats: the latest one carries the cumulative counters.
  const provider = (providerId: string, configured: boolean, attempts: number, http429: number) =>
    ({ providerId, configured, attempts, http429Responses: http429 });
  const heartbeatUrl = 'https://rpc.example.invalid/?api-key=fast-path-report-secret';
  for (const [serviceKey, updatedAtMs, startedAtMs, primaryAttempts] of [
    ['transaction-listener', nowMs - 60_000, listenerStartedAtMs, 120],
    ['stale-listener', nowMs - 3 * HOUR_MS, nowMs - 4 * HOUR_MS, 999],
  ] as const) {
    await pool.query(
      `INSERT INTO listener_heartbeats (service_key,payload,updated_at,started_at)
       VALUES ($1,$2,$3,$4)`,
      [serviceKey, JSON.stringify({
        rpcUrl: heartbeatUrl,
        rpcHttpEvidence: {
          version: 1, overflowed: false,
          providers: [provider('primary', true, primaryAttempts, 7),
            provider('fallback-1', true, 30, 0), provider('fallback-2', false, 0, 0),
            provider('fallback-3', false, 0, 0)],
        },
      }), iso(updatedAtMs), iso(startedAtMs)],
    );
  }

  return {
    window, mints, deadlineOpenedAtMs, unknownOpenedAtMs, liveOpenedAtMs, listenerStartedAtMs,
    armedToSubmittedMs: submittedAtMs - armedAtMs,
    submittedToConfirmedMs: confirmedAtMs - submittedAtMs,
    secrets: [
      open.buy.artifact.signature, exactBuyWalletPublicKey, ledgerWallet, evidenceSignature,
      ...ledgerSignatures, heartbeatUrl, 'fast-path-report-secret',
    ],
  };
}
