// Lot 4b Task 7: early exit fail-closed checklist. Each test is named after the property it
// proves. The SELL path is H2b's real repository steps (claim, preparation binding, signed
// persistence, signed simulation, submission, reconciliation) with fixed RPC results.
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import {
  ExecutionLiveRepositoryError,
  PostgresExecutionLiveRepository,
} from '../src/storage/execution-live.repository.js';
import { PostgresExecutionOperationsRepository } from
  '../src/storage/execution-operations.repository.js';
import { PostgresExecutionSimulationRepository } from
  '../src/storage/execution-simulation.repository.js';
import {
  earlyExitPolicy, earlyExitPublicKey, everyRuleTrades, insertLaunchEvent, insertTradeEvents,
  type SeedTrade,
} from './helpers/fast-exit-events.js';
import { linkEnvelope } from './helpers/live-envelope-link.js';
import {
  ageIntent,
  beginSellAttempt,
  createExitPendingFixture,
  createOpenPositionFixture,
  createSellFixture,
  driveSellFixture,
  generationId,
  makePositionDue,
  providerFailureDraft,
  requiredDatabaseUrl,
  sellEvidence,
  type SellExitKind,
  withTemporarySchema,
} from './helpers/live-sell-fixture.js';

type Pool = InstanceType<typeof pg.Pool>;
type OpenPosition = Awaited<ReturnType<typeof createOpenPositionFixture>>;

// ---------------------------------------------------------------------------------------------
// 1. H2b accepts an early exit SELL exactly as a deadline SELL.
// ---------------------------------------------------------------------------------------------

void test('H2b claims, binds, signs, submits and reconciles an early exit SELL exactly like a '
  + 'deadline SELL, envelope loss included', async (context) => {
  const databaseUrl = requiredDatabaseUrl(context);
  if (databaseUrl === null) return;
  const outcomes = new Map<SellExitKind, unknown>();
  for (const exitKind of ['DEADLINE', 'EARLY_REVOKED'] as const) {
    await withTemporarySchema(databaseUrl, async (pool) => {
      // driveSellFixture asserts the LIVE_EXECUTE SELL claim picks this intent and that the
      // SELL preparation binding accepts it (EXIT_PENDING, position.exit_intent_id = intent).
      const fixture = await createSellFixture(pool, 'ACCEPTED', undefined, exitKind);
      if (exitKind === 'DEADLINE') {
        await linkEnvelope(pool, generationId, {
          state: 'REVOKED', priorLossRaw: '0', maxLossRaw: '1000000',
        });
      }
      const intent = await exitIntentRow(pool, fixture.claim.intent.id);
      const positionId = intent.position_id;
      assert.deepEqual({ strategy: intent.strategy_id, key: intent.logical_command_id },
        exitKind === 'DEADLINE'
          ? { strategy: 'maximum-holding-exit', key: `maximum-holding:${positionId}` }
          : { strategy: 'fast-entry-exit-v1', key: `fast-exit:ENVELOPE_REVOKED:${positionId}` });
      const matched = sellEvidence(fixture, 'MATCHED', fixture.observedAtMs);
      assert.equal((await fixture.live.commitReconciliation(fixture.claim, matched)).result,
        'MATCHED');
      outcomes.set(exitKind, await sellOutcome(pool, positionId));
      // Closed: no scanner creates anything more for the position.
      const live = new PostgresExecutionLiveRepository(pool);
      assert.equal(await live.createNextEarlyExitIntent(earlyExitPolicy), null);
      assert.equal(await live.createNextDeadlineExitIntent(), null);
      assert.equal(await live.createNextReExitIntent(), null);
      assert.equal(await sellIntentCount(pool, positionId), 1);
    });
  }
  assert.deepEqual(outcomes.get('EARLY_REVOKED'), outcomes.get('DEADLINE'));
  assert.deepEqual(outcomes.get('DEADLINE'), {
    intent_status: 'SUCCEEDED', position_state: 'CLOSED', remaining_base_raw: '0',
    ledger: [{ base_amount_raw: '95', net_lamports: '-4205', exit_wallet_lamport_delta: '795' }],
    sell_evidence: ['MATCHED'], envelope: [{ state: 'REVOKED', realized_loss_raw: '4205' }],
  });
});

// ---------------------------------------------------------------------------------------------
// 2. One SELL per position, whatever the order of the exit paths.
// ---------------------------------------------------------------------------------------------

void test('no second SELL: a deadline after an early exit is refused and writes nothing',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createExitPendingFixture(pool, 'EARLY_REVOKED');
      const dueAtMs = await makePositionDue(pool, fixture.positionId);
      const before = await writeState(pool);
      assert.equal(await fixture.live.createNextDeadlineExitIntent(), null);
      await assert.rejects(fixture.live.createDeadlineExitIntent({
        positionId: fixture.positionId, observedAtMs: dueAtMs,
      }), (error: unknown) => error instanceof ExecutionLiveRepositoryError
        && error.code === 'CONFLICT');
      assert.equal(await fixture.live.createNextEarlyExitIntent(earlyExitPolicy), null);
      assert.equal(await fixture.live.createNextReExitIntent(), null);
      assert.deepEqual(await writeState(pool), before);
      assert.equal(await sellIntentCount(pool, fixture.positionId), 1);
    });
  });

void test('no second SELL: an early exit after a deadline SELL is refused and writes nothing',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createExitPendingFixture(pool, 'DEADLINE');
      await linkEnvelope(pool, generationId, {
        state: 'REVOKED', priorLossRaw: '0', maxLossRaw: '1000000',
      });
      // Not due any more: only the position state can stop the early exit.
      await moveDeadline(pool, fixture.positionId, '10 seconds');
      const before = await writeState(pool);
      assert.equal(await fixture.live.createNextEarlyExitIntent(earlyExitPolicy), null);
      assert.equal(await fixture.live.createNextReExitIntent(), null);
      assert.deepEqual(await writeState(pool), before);
      assert.equal(await sellIntentCount(pool, fixture.positionId), 1);
    });
  });

void test('no second SELL: concurrent early, deadline and re-exit scanners create one SELL',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const open = await envelopeOpenPosition(pool, 'REVOKED');
      const scanner = () => new PostgresExecutionLiveRepository(pool);
      const results = await Promise.all([
        scanner().createNextEarlyExitIntent(earlyExitPolicy),
        scanner().createNextEarlyExitIntent(earlyExitPolicy),
        scanner().createNextDeadlineExitIntent(),
        scanner().createNextReExitIntent(),
      ]);
      assert.equal(results.filter((result) => result !== null).length, 1);
      assert.equal(await sellIntentCount(pool, open.positionId), 1);
      // The deadline is now due: still exactly one SELL.
      await makePositionDue(pool, open.positionId);
      const due = await Promise.all([
        scanner().createNextEarlyExitIntent(earlyExitPolicy),
        scanner().createNextDeadlineExitIntent(),
        scanner().createNextReExitIntent(),
      ]);
      assert.deepEqual(due, [null, null, null]);
      assert.equal(await sellIntentCount(pool, open.positionId), 1);
    });
  });

// ---------------------------------------------------------------------------------------------
// 3. CANARY: the deadline is the only exit.
// ---------------------------------------------------------------------------------------------

void test('a CANARY position gets no early exit whatever its trades; the deadline still sells it',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    for (const control of [false, true]) {
      await withTemporarySchema(databaseUrl, async (pool) => {
        const open = await createOpenPositionFixture(pool);
        const facts = await positionFacts(pool, open);
        const creator = earlyExitPublicKey();
        await insertLaunchEvent(pool, facts.mint, creator);
        await insertTradeEvents(pool, facts.mint, everyRuleTrades(facts, creator));
        if (control) {
          // The same trades fire once the position is an envelope position.
          await linkEnvelope(pool, generationId, {
            state: 'ACTIVE', priorLossRaw: '0', maxLossRaw: '1000000',
          });
          const early = await open.live.createNextEarlyExitIntent(earlyExitPolicy);
          assert.equal(early?.reason, 'CREATOR_SOLD');
          return;
        }
        const before = await writeState(pool);
        assert.equal(await open.live.createNextEarlyExitIntent(earlyExitPolicy), null);
        assert.deepEqual(await writeState(pool), before);
        await makePositionDue(pool, open.positionId);
        assert.equal(await open.live.createNextEarlyExitIntent(earlyExitPolicy), null);
        const deadline = await open.live.createNextDeadlineExitIntent();
        assert.equal(deadline?.intent?.logicalCommandId, `maximum-holding:${open.positionId}`);
        assert.equal(await sellIntentCount(pool, open.positionId), 1);
      });
    }
  });

// ---------------------------------------------------------------------------------------------
// 4. Revocation is an exit (closes 4a limit 4).
// ---------------------------------------------------------------------------------------------

void test('revoking the envelope exits its OPEN position on the next pass, before the deadline',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const open = await envelopeOpenPosition(pool, 'ACTIVE');
      assert.equal(await open.live.createNextEarlyExitIntent(earlyExitPolicy), null);
      const revocation = await new PostgresExecutionOperationsRepository(pool).revokeEnvelope({
        generationId, envelopeId: open.envelopeId, operatorId: 'operator-primary',
        occurredAtMs: Date.now(),
      });
      assert.equal(revocation.state, 'REVOKED');
      const early = await open.live.createNextEarlyExitIntent(earlyExitPolicy);
      assert.equal(early?.reason, 'ENVELOPE_REVOKED');
      const row = (await pool.query(`SELECT position.state,position.exit_intent_id,
        intent.requested_at < position.exit_deadline_at AS before_deadline
        FROM execution_live_positions position
        JOIN execution_intents intent ON intent.id=position.exit_intent_id
        WHERE position.position_id=$1`, [open.positionId])).rows;
      assert.deepEqual(row, [{
        state: 'EXIT_PENDING', exit_intent_id: early?.intent.id, before_deadline: true,
      }]);
    });
  });

// ---------------------------------------------------------------------------------------------
// 5. The early exit writes no envelope and no armament.
// ---------------------------------------------------------------------------------------------

void test('an early exit writes no envelope and no armament row', async (context) => {
  const databaseUrl = requiredDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    const open = await envelopeOpenPosition(pool, 'REVOKED');
    const before = await envelopeAndArmamentRows(pool);
    assert.equal(before.envelopes.length, 1);
    assert.equal(before.armaments.length >= 1, true);
    const early = await open.live.createNextEarlyExitIntent(earlyExitPolicy);
    assert.equal(early?.reason, 'ENVELOPE_REVOKED');
    assert.deepEqual(await envelopeAndArmamentRows(pool), before);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Unreadable facts never block the deadline.
// ---------------------------------------------------------------------------------------------

void test('with every fact unreadable there is no early exit and the deadline still sells',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    const creatorSell = (creator: string): readonly SeedTrade[] => [
      { kind: 'SELL', trader: creator, baseAmountRaw: 1_000_000n, quoteAmountRaw: 100n },
    ];
    const malformedTrade: SeedTrade = {
      kind: 'BUY', trader: earlyExitPublicKey(), baseAmountRaw: 1n, quoteAmountRaw: 1n,
      transactionIndex: 99,
      mutate: (payload) => { payload.trade.baseAmountRaw = { $solTokenListenerBigInt: '01' }; },
    };
    const cases: readonly Readonly<{
      name: string;
      seed: (pool: Pool, mint: string, cost: Readonly<{ quoteCostRaw: bigint }>) => Promise<void>;
    }>[] = [
      { name: 'malformed launch payload', seed: async (pool, mint) => {
        const creator = earlyExitPublicKey();
        await insertMalformedLaunchEvent(pool, mint);
        await insertTradeEvents(pool, mint, creatorSell(creator));
      } },
      { name: 'ambiguous creator', seed: async (pool, mint) => {
        const creator = earlyExitPublicKey();
        await insertLaunchEvent(pool, mint, creator);
        await insertLaunchEvent(pool, mint, earlyExitPublicKey());
        await insertTradeEvents(pool, mint, creatorSell(creator));
      } },
      { name: 'malformed trades', seed: async (pool, mint, cost) => {
        const creator = earlyExitPublicKey();
        await insertLaunchEvent(pool, mint, creator);
        await insertTradeEvents(pool, mint, everyRuleTrades(cost, creator));
        await insertTradeEvents(pool, mint, [malformedTrade]);
      } },
      { name: 'every fact unreadable at once', seed: async (pool, mint, cost) => {
        const creator = earlyExitPublicKey();
        await insertMalformedLaunchEvent(pool, mint);
        await insertLaunchEvent(pool, mint, creator);
        await insertLaunchEvent(pool, mint, earlyExitPublicKey());
        await insertTradeEvents(pool, mint, everyRuleTrades(cost, creator));
        await insertTradeEvents(pool, mint, [malformedTrade]);
      } },
    ];
    for (const { name, seed } of cases) {
      await withTemporarySchema(databaseUrl, async (pool) => {
        const open = await envelopeOpenPosition(pool, 'ACTIVE');
        const facts = await positionFacts(pool, open);
        await seed(pool, facts.mint, facts);
        const before = await writeState(pool);
        assert.equal(await open.live.createNextEarlyExitIntent(earlyExitPolicy), null, name);
        assert.deepEqual(await writeState(pool), before, name);
        await makePositionDue(pool, open.positionId);
        const deadline = await open.live.createNextDeadlineExitIntent();
        assert.equal(deadline?.kind, 'CREATED', name);
        assert.equal(deadline?.intent?.logicalCommandId,
          `maximum-holding:${open.positionId}`, name);
        assert.equal(await sellIntentCount(pool, open.positionId), 1, name);
      });
    }
  });

// ---------------------------------------------------------------------------------------------
// 7. Re-exit of an early exit, end to end.
// ---------------------------------------------------------------------------------------------

void test('an early SELL failed before signature is re-exited and its :retry-1 closes the position '
  + 'through H2b with one ledger row', async (context) => {
  const databaseUrl = requiredDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    const exitPending = await createExitPendingFixture(pool, 'EARLY_REVOKED');
    const { positionId } = exitPending;
    const first = await beginSellAttempt(pool, exitPending);
    await new PostgresExecutionSimulationRepository(pool).complete(
      first.claim, providerFailureDraft(first.claim, first.attempt.attemptNumber),
      new AbortController().signal,
    );
    await ageIntent(pool, exitPending.exitIntent.id, 40_000);
    const reExit = await exitPending.live.createNextReExitIntent();
    assert.ok(reExit);
    assert.equal(reExit.previousIntentId, exitPending.exitIntent.id);
    assert.equal(reExit.intent.logicalCommandId,
      `fast-exit:ENVELOPE_REVOKED:${positionId}:retry-1`);
    assert.equal(reExit.intent.strategyId, 'fast-entry-exit-v1');

    // The binding follows the new exit_intent_id through H2b preparation.
    const sell = await driveSellFixture(pool, Object.freeze({
      ...exitPending, exitIntent: reExit.intent, exitDeadlineAtMs: reExit.intent.requestedAtMs,
    }), 'ACCEPTED');
    assert.equal(sell.claim.intent.id, reExit.intent.id);
    const matched = sellEvidence(sell, 'MATCHED', sell.observedAtMs);
    assert.equal((await sell.live.commitReconciliation(sell.claim, matched)).result, 'MATCHED');

    const intents = await pool.query(`SELECT logical_command_id,status FROM execution_intents
      WHERE side='SELL' AND position_id=$1 ORDER BY requested_at`, [positionId]);
    assert.deepEqual(intents.rows, [
      { logical_command_id: `fast-exit:ENVELOPE_REVOKED:${positionId}`, status: 'FAILED' },
      { logical_command_id: `fast-exit:ENVELOPE_REVOKED:${positionId}:retry-1`,
        status: 'SUCCEEDED' },
    ]);
    assert.deepEqual(await sellOutcome(pool, positionId), {
      intent_status: 'SUCCEEDED', position_state: 'CLOSED', remaining_base_raw: '0',
      ledger: [{ base_amount_raw: '95', net_lamports: '-4205', exit_wallet_lamport_delta: '795' }],
      sell_evidence: ['MATCHED'], envelope: [{ state: 'REVOKED', realized_loss_raw: '4205' }],
    });
    assert.equal(await exitPending.live.createNextReExitIntent(), null);
  });
});

// ---------------------------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------------------------

/** An OPEN position (deadline in the future) whose armament is bound to a new envelope. */
async function envelopeOpenPosition(
  pool: Pool,
  state: 'ACTIVE' | 'REVOKED',
): Promise<OpenPosition & Readonly<{ envelopeId: string }>> {
  const open = await createOpenPositionFixture(pool);
  const envelopeId = await linkEnvelope(pool, generationId, {
    state, priorLossRaw: '0', maxLossRaw: '1000000',
  });
  return Object.freeze({ ...open, envelopeId });
}

async function positionFacts(
  pool: Pool,
  open: OpenPosition,
): Promise<Readonly<{ mint: string; quoteCostRaw: bigint }>> {
  const row = (await pool.query<{ mint: string; quote_cost_raw: string }>(`SELECT mint,
    quote_cost_raw::TEXT AS quote_cost_raw FROM execution_live_positions
    WHERE position_id=$1`, [open.positionId])).rows[0];
  assert.ok(row !== undefined);
  return Object.freeze({ mint: row.mint, quoteCostRaw: BigInt(row.quote_cost_raw) });
}

async function insertMalformedLaunchEvent(pool: Pool, mint: string): Promise<void> {
  await pool.query(`INSERT INTO domain_events (
    event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
    instruction_index,inner_instruction_index,confirmation_status,observed_at,payload_version,payload
  ) VALUES ($1,NULL,'TokenLaunchDetected',$2,'test-fixture','test-fixture',$1,100,0,0,NULL,
    'finalized',statement_timestamp(),1,$3::JSONB)`, [
    `launch:${randomUUID()}`, mint, JSON.stringify({ launch: { mint, creator: 42 } }),
  ]);
}

async function exitIntentRow(pool: Pool, intentId: string) {
  const row = (await pool.query<{
    position_id: string; strategy_id: string; logical_command_id: string;
  }>(`SELECT position_id,strategy_id,logical_command_id FROM execution_intents
    WHERE id=$1 AND side='SELL'`, [intentId])).rows[0];
  assert.ok(row !== undefined);
  return row;
}

/** Everything a reconciled SELL settles, with no identifier that differs between runs. */
async function sellOutcome(pool: Pool, positionId: string): Promise<unknown> {
  const position = (await pool.query(`SELECT position.state AS position_state,
    position.remaining_base_raw::TEXT AS remaining_base_raw,intent.status AS intent_status
    FROM execution_live_positions position
    JOIN execution_intents intent ON intent.id=position.exit_intent_id
    WHERE position.position_id=$1`, [positionId])).rows[0] as Record<string, unknown>;
  const ledger = await pool.query(`SELECT base_amount_raw::TEXT AS base_amount_raw,
    net_lamports::TEXT AS net_lamports,
    exit_wallet_lamport_delta::TEXT AS exit_wallet_lamport_delta
    FROM execution_live_position_ledger WHERE position_id=$1`, [positionId]);
  const evidence = await pool.query<{ result: string }>(`SELECT evidence.result
    FROM execution_reconciliation_evidence evidence
    JOIN execution_intents intent ON intent.id=evidence.intent_id
    WHERE evidence.side='SELL' AND intent.position_id=$1 ORDER BY evidence.result`, [positionId]);
  const envelope = await pool.query(`SELECT state,realized_loss_raw::TEXT AS realized_loss_raw
    FROM execution_entry_envelopes`);
  return {
    ...position, ledger: ledger.rows,
    sell_evidence: evidence.rows.map((row) => row.result), envelope: envelope.rows,
  };
}

async function envelopeAndArmamentRows(pool: Pool) {
  const envelopes = await pool.query(`SELECT to_jsonb(envelope) AS row
    FROM execution_entry_envelopes envelope ORDER BY envelope_id`);
  const armaments = await pool.query(`SELECT to_jsonb(armament) AS row
    FROM execution_activation_armaments armament ORDER BY armament_id`);
  return { envelopes: envelopes.rows, armaments: armaments.rows };
}

/** Every row an exit scanner may write, to prove that a refused call writes nothing. */
async function writeState(pool: Pool): Promise<unknown> {
  const intents = await pool.query(`SELECT id,status,state_revision::TEXT AS revision
    FROM execution_intents ORDER BY id`);
  const positions = await pool.query(`SELECT position_id,state,exit_intent_id,
    state_revision::TEXT AS revision FROM execution_live_positions ORDER BY position_id`);
  const transitions = await pool.query(`SELECT COUNT(*)::INTEGER AS count
    FROM execution_intent_transitions`);
  return { intents: intents.rows, positions: positions.rows, transitions: transitions.rows };
}

async function sellIntentCount(pool: Pool, positionId: string): Promise<number> {
  const row = (await pool.query<{ count: number }>(`SELECT COUNT(*)::INTEGER AS count
    FROM execution_intents WHERE side='SELL' AND position_id=$1`, [positionId])).rows[0];
  return row?.count ?? -1;
}

/**
 * Test clock: moves the deadline to now + `interval` and the opening to deadline - holding
 * (the position guard is bypassed).
 */
async function moveDeadline(pool: Pool, positionId: string, interval: string): Promise<void> {
  await pool.query(`ALTER TABLE execution_live_positions
    DISABLE TRIGGER execution_live_positions_guarded_update`);
  try {
    const updated = await pool.query(`UPDATE execution_live_positions SET
      exit_deadline_at=date_trunc('milliseconds',statement_timestamp())+$2::INTERVAL,
      opened_at=date_trunc('milliseconds',statement_timestamp())+$2::INTERVAL
        -(maximum_holding_ms*INTERVAL '1 millisecond')
      WHERE position_id=$1`, [positionId, interval]);
    assert.equal(updated.rowCount, 1);
  } finally {
    await pool.query(`ALTER TABLE execution_live_positions
      ENABLE TRIGGER execution_live_positions_guarded_update`);
  }
}
