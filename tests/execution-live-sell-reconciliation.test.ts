import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
import {
  ExecutionLiveRepositoryError,
  PostgresExecutionLiveRepository,
} from '../src/storage/execution-live.repository.js';
import { insertExecutionDecisionEvent } from './helpers/execution-decision-event.js';
import { roleSource, withProvisionedDatabase } from './helpers/entry-envelope-fixture.js';
import { insertEnvelope, linkEnvelope } from './helpers/live-envelope-link.js';
import {
  claimSellReconciliation,
  createAmbiguousSellFixture,
  createSellFixture,
  generationId,
  landedFailedSellEvidence,
  quoteMint,
  requiredDatabaseUrl,
  sellEvidence,
  waitForDatabaseQuery,
  walletPublicKey,
  fingerprint,
  withTemporarySchema,
} from './helpers/live-sell-fixture.js';

void test('SELL UNKNOWN persists evidence and freezes every exit capability', async (context) => {
  const databaseUrl = requiredDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    const fixture = await createAmbiguousSellFixture(pool);
    const evidence = sellEvidence(fixture, 'UNKNOWN', fixture.observedAtMs);

    const result = await fixture.live.commitReconciliation(fixture.claim, evidence);

    assert.equal(result.result, 'UNKNOWN');
    assert.deepEqual(await durableState(pool, fixture),
      expectedUnknownState(fixture.claim.intent.id, 1));
    const control = await pool.query<{
      state: string;
      actor_type: string;
      reason_code: string;
    }>(`SELECT control.state,event.actor_type,event.reason_code
      FROM execution_control_state control
      JOIN execution_control_events event ON event.event_id=control.last_event_id
      WHERE control.generation_id=$1`, [generationId]);
    assert.deepEqual(control.rows, [{
      state: 'ENTRY_STOP', actor_type: 'SYSTEM',
      reason_code: 'SYSTEM_RECONCILIATION_UNKNOWN',
    }]);
  });
});

void test('SELL UNKNOWN from ACCEPTED journals ambiguity then allows finalized NO_EFFECT',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createSellFixture(pool, 'ACCEPTED');
      const unknown = sellEvidence(fixture, 'UNKNOWN', fixture.observedAtMs);
      const noEffect = sellEvidence(fixture, 'NO_EFFECT', fixture.observedAtMs + 2_000);

      await fixture.live.commitReconciliation(fixture.claim, unknown);
      assert.equal((await fixture.live.commitReconciliation(fixture.claim, unknown)).result,
        'UNKNOWN');

      assert.deepEqual(await ambiguityTransitions(pool, fixture), {
        artifact_transition_count: 1, intent_transition_count: 1,
      });
      assert.deepEqual(await durableState(pool, fixture),
        expectedUnknownState(fixture.claim.intent.id, 1));
      const unknownEntryReplay = await fixture.live.commitReconciliation(
        fixture.buyClaim, fixture.buyEvidence,
      );
      assert.equal(unknownEntryReplay.position?.state, 'UNKNOWN');
      assert.equal(unknownEntryReplay.position?.stateRevision, 2n);
      assert.equal(unknownEntryReplay.exitAuthorization?.state, 'LOCKED');
      assert.equal(unknownEntryReplay.exitAuthorization?.stateRevision, 1n);
      const terminalClaim = await claimSellReconciliation(pool, 'sell-no-effect-after-accepted');
      assert.equal((await fixture.live.commitReconciliation(terminalClaim, noEffect)).result,
        'NO_EFFECT');
      const retryableEntryReplay = await fixture.live.commitReconciliation(
        fixture.buyClaim, fixture.buyEvidence,
      );
      assert.equal(retryableEntryReplay.position?.state, 'EXIT_PENDING');
      assert.equal(retryableEntryReplay.position?.stateRevision, 3n);
      assert.equal(retryableEntryReplay.exitAuthorization?.state, 'ACTIVE');
      assert.equal(retryableEntryReplay.exitAuthorization?.stateRevision, 2n);
    });
  });

void test('SELL UNKNOWN from CONFIRMED journals ambiguity then allows finalized MATCHED',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createSellFixture(pool, 'CONFIRMED');
      const unknown = sellEvidence(fixture, 'UNKNOWN', fixture.observedAtMs);
      const matched = sellEvidence(fixture, 'MATCHED', fixture.observedAtMs + 2_000);

      await fixture.live.commitReconciliation(fixture.claim, unknown);
      assert.equal((await fixture.live.commitReconciliation(fixture.claim, unknown)).result,
        'UNKNOWN');

      assert.deepEqual(await ambiguityTransitions(pool, fixture), {
        artifact_transition_count: 1, intent_transition_count: 1,
      });
      assert.deepEqual(await durableState(pool, fixture),
        expectedUnknownState(fixture.claim.intent.id, 1));
      const terminalClaim = await claimSellReconciliation(pool, 'sell-matched-after-confirmed');
      assert.equal((await fixture.live.commitReconciliation(terminalClaim, matched)).result,
        'MATCHED');
      assert.deepEqual(await terminalIntentTransitions(pool, fixture), [
        {
          previous_status: 'UNKNOWN_REQUIRES_RECONCILIATION', next_status: 'CONFIRMED',
          reason_code: 'CONFIRMATION_OBSERVED',
        },
        {
          previous_status: 'CONFIRMED', next_status: 'SUCCEEDED',
          reason_code: 'INTENT_SUCCEEDED',
        },
      ]);
      const closedEntryReplay = await fixture.live.commitReconciliation(
        fixture.buyClaim, fixture.buyEvidence,
      );
      assert.equal(closedEntryReplay.position?.state, 'CLOSED');
      assert.equal(closedEntryReplay.position?.stateRevision, 3n);
      assert.equal(closedEntryReplay.exitAuthorization?.state, 'CONSUMED');
      assert.equal(closedEntryReplay.exitAuthorization?.stateRevision, 2n);
    });
  });

void test('SELL MATCHED appends one immutable ledger row and a replay appends none',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createSellFixture(pool, 'ACCEPTED');
      const matched = sellEvidence(fixture, 'MATCHED', fixture.observedAtMs);
      assert.deepEqual((await pool.query('SELECT 1 FROM execution_live_position_ledger')).rows, []);

      await fixture.live.commitReconciliation(fixture.claim, matched);
      await fixture.live.commitReconciliation(fixture.claim, matched);

      const ledger = await pool.query(`SELECT
        ledger.base_amount_raw::TEXT AS base_amount_raw,
        ledger.entry_wallet_lamport_delta::TEXT AS entry_wallet_lamport_delta,
        ledger.exit_wallet_lamport_delta::TEXT AS exit_wallet_lamport_delta,
        ledger.net_lamports::TEXT AS net_lamports,
        ledger.entry_signature,ledger.exit_signature,
        ledger.wallet_public_key=position.wallet_public_key AS same_wallet,
        ledger.mint=position.mint AS same_mint,
        ledger.opened_at=position.opened_at AS same_opened_at,
        ledger.closed_at=position.closed_at AS same_closed_at
        FROM execution_live_position_ledger ledger
        JOIN execution_live_positions position ON position.position_id=ledger.position_id
        WHERE position.state='CLOSED'`);
      assert.deepEqual(ledger.rows, [{
        base_amount_raw: '95', entry_wallet_lamport_delta: '-5000',
        exit_wallet_lamport_delta: '795', net_lamports: '-4205',
        entry_signature: fixture.buyEvidence.signature,
        exit_signature: fixture.artifact.signature,
        same_wallet: true, same_mint: true, same_opened_at: true, same_closed_at: true,
      }]);
      await assert.rejects(pool.query('UPDATE execution_live_position_ledger SET net_lamports=0'),
        { code: '55000' });
      await assert.rejects(pool.query('DELETE FROM execution_live_position_ledger'),
        { code: '55000' });
    });
  });

for (const scenario of [
  {
    name: 'a net loss adds max(0,-net_lamports) and a replay adds nothing',
    state: 'ACTIVE', priorLossRaw: '1000', maxLossRaw: '1000000', exitDeltaLamports: 795n,
    expected: { state: 'ACTIVE', realized_loss_raw: '5205' },
  },
  {
    name: 'a net gain adds nothing',
    state: 'ACTIVE', priorLossRaw: '1000', maxLossRaw: '1000000', exitDeltaLamports: 6_000n,
    expected: { state: 'ACTIVE', realized_loss_raw: '1000' },
  },
  {
    name: 'reaching the maximum realized loss sets EXHAUSTED',
    state: 'ACTIVE', priorLossRaw: '0', maxLossRaw: '4205', exitDeltaLamports: 795n,
    expected: { state: 'EXHAUSTED', realized_loss_raw: '4205' },
  },
  {
    name: 'a REVOKED envelope accumulates the loss and stays REVOKED',
    state: 'REVOKED', priorLossRaw: '0', maxLossRaw: '4205', exitDeltaLamports: 795n,
    expected: { state: 'REVOKED', realized_loss_raw: '4205' },
  },
  {
    name: 'an EXPIRED envelope accumulates the loss and stays EXPIRED',
    state: 'EXPIRED', priorLossRaw: '10', maxLossRaw: '1000000', exitDeltaLamports: 795n,
    expected: { state: 'EXPIRED', realized_loss_raw: '4215' },
  },
] as const) {
  void test(`SELL MATCHED on an envelope armament: ${scenario.name}`, async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createSellFixture(pool, 'ACCEPTED');
      const envelopeId = await linkEnvelope(pool, generationId, scenario);
      const matched = sellEvidence(
        fixture, 'MATCHED', fixture.observedAtMs, scenario.exitDeltaLamports,
      );
      await fixture.live.commitReconciliation(fixture.claim, matched);
      await fixture.live.commitReconciliation(fixture.claim, matched);
      const envelope = await envelopeRow(pool, envelopeId);
      assert.deepEqual({ state: envelope.state, realized_loss_raw: envelope.realized_loss_raw },
        scenario.expected);
      assert.equal(envelope.updated_at_ms, String(matched.finalizedAtMs));
      const ledger = await pool.query(`SELECT net_lamports::TEXT AS net_lamports
        FROM execution_live_position_ledger`);
      const net = BigInt(String(ledger.rows[0]?.net_lamports));
      assert.equal(BigInt(envelope.realized_loss_raw) - BigInt(scenario.priorLossRaw),
        net < 0n ? -net : 0n);
    });
  });
}

void test('SELL MATCHED on a CANARY armament without an envelope updates no envelope',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createSellFixture(pool, 'ACCEPTED');
      // An unrelated envelope of the same generation must stay untouched.
      const envelopeId = await insertEnvelope(pool, generationId, {
        state: 'ACTIVE', priorLossRaw: '0', maxLossRaw: '1000000',
      });
      const before = await envelopeRow(pool, envelopeId);
      await fixture.live.commitReconciliation(
        fixture.claim, sellEvidence(fixture, 'MATCHED', fixture.observedAtMs),
      );
      assert.deepEqual(await envelopeRow(pool, envelopeId), before);
      assert.deepEqual((await pool.query(`SELECT state FROM execution_live_positions`)).rows,
        [{ state: 'CLOSED' }]);
    });
  });

void test('PostgreSQL 16 recovery role reconciles an envelope SELL and accumulates its loss',
  async (context) => {
    await withProvisionedDatabase(context, async (pool) => {
      const fixture = await createSellFixture(pool, 'ACCEPTED');
      const envelopeId = await linkEnvelope(pool, generationId, {
        state: 'ACTIVE', priorLossRaw: '0', maxLossRaw: '4205',
      });
      const recovery = new PostgresExecutionLiveRepository(
        roleSource(pool, 'sol_token_executor_live_recovery'),
      );
      const matched = sellEvidence(fixture, 'MATCHED', fixture.observedAtMs);
      const result = await recovery.commitReconciliation(fixture.claim, matched);
      assert.equal(result.result, 'MATCHED');
      await recovery.commitReconciliation(fixture.claim, matched);
      const envelope = await envelopeRow(pool, envelopeId);
      assert.deepEqual({ state: envelope.state, realized_loss_raw: envelope.realized_loss_raw },
        { state: 'EXHAUSTED', realized_loss_raw: '4205' });
    });
  });

// Production 2026-10-08: a WSOL BUY's quote_cost_raw includes the token ATA rent, so it exceeds
// the admitted reservation; the close must release the reservation, not the realized cost.
const RENT_INFLATED_ENTRY_DELTA = -1_200n;

void test('SELL MATCHED releases the BUY reservation when the realized cost exceeds it',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createSellFixture(
        pool, 'ACCEPTED', undefined, 'DEADLINE', RENT_INFLATED_ENTRY_DELTA,
      );
      const envelopeId = await linkEnvelope(pool, generationId, {
        state: 'ACTIVE', priorLossRaw: '0', maxLossRaw: '1000000',
      });
      assert.deepEqual(await exposureState(pool, fixture), {
        quote_cost_raw: '1200', buy_reserved_amount_raw: '1000', reserved_exposure_raw: '1000',
      });
      const matched = sellEvidence(fixture, 'MATCHED', fixture.observedAtMs);

      assert.equal((await fixture.live.commitReconciliation(fixture.claim, matched)).result,
        'MATCHED');
      assert.equal((await fixture.live.commitReconciliation(fixture.claim, matched)).result,
        'MATCHED');

      assert.deepEqual(await durableState(pool, fixture),
        expectedClosedState(fixture.claim.intent.id));
      assert.deepEqual(await exposureState(pool, fixture), {
        quote_cost_raw: '1200', buy_reserved_amount_raw: '1000', reserved_exposure_raw: '0',
      });
      const envelope = await envelopeRow(pool, envelopeId);
      assert.deepEqual({ state: envelope.state, realized_loss_raw: envelope.realized_loss_raw },
        { state: 'ACTIVE', realized_loss_raw: '4205' });
    });
  });

void test('PostgreSQL 16 recovery role reads the BUY reservation and closes a rent-inflated position',
  async (context) => {
    await withProvisionedDatabase(context, async (pool) => {
      const fixture = await createSellFixture(
        pool, 'ACCEPTED', undefined, 'DEADLINE', RENT_INFLATED_ENTRY_DELTA,
      );
      const envelopeId = await linkEnvelope(pool, generationId, {
        state: 'ACTIVE', priorLossRaw: '0', maxLossRaw: '1000000',
      });
      const recoverySource = roleSource(pool, 'sol_token_executor_live_recovery');
      const asRecovery = await recoverySource.connect();
      try {
        const readable = await asRecovery.query(`SELECT
          buy_reservation.maximum_amount_raw::TEXT AS buy_reserved_amount_raw
          FROM execution_live_positions position
          JOIN execution_exposure_reservations buy_reservation
            ON buy_reservation.intent_id=position.buy_intent_id
          WHERE position.exit_intent_id=$1`, [fixture.claim.intent.id]);
        assert.deepEqual(readable.rows, [{ buy_reserved_amount_raw: '1000' }]);
      } finally {
        asRecovery.release();
      }
      const recovery = new PostgresExecutionLiveRepository(recoverySource);
      const matched = sellEvidence(fixture, 'MATCHED', fixture.observedAtMs);

      assert.equal((await recovery.commitReconciliation(fixture.claim, matched)).result,
        'MATCHED');

      assert.deepEqual(await durableState(pool, fixture),
        expectedClosedState(fixture.claim.intent.id));
      const envelope = await envelopeRow(pool, envelopeId);
      assert.equal(envelope.realized_loss_raw, '4205');
    });
  });

void test('SELL MATCHED direct from ACCEPTED journals confirmation before success',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createSellFixture(pool, 'ACCEPTED');
      const matched = sellEvidence(fixture, 'MATCHED', fixture.observedAtMs);

      assert.equal((await fixture.live.commitReconciliation(fixture.claim, matched)).result,
        'MATCHED');
      assert.deepEqual(await terminalIntentTransitions(pool, fixture), [
        {
          previous_status: 'SUBMITTED', next_status: 'CONFIRMED',
          reason_code: 'CONFIRMATION_OBSERVED',
        },
        {
          previous_status: 'CONFIRMED', next_status: 'SUCCEEDED',
          reason_code: 'INTENT_SUCCEEDED',
        },
      ]);
    });
  });

void test('SELL UNKNOWN then NO_EFFECT restores a retryable exit without releasing exposure',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createAmbiguousSellFixture(pool);
      const unknown = sellEvidence(fixture, 'UNKNOWN', fixture.observedAtMs);
      const noEffect = sellEvidence(fixture, 'NO_EFFECT', fixture.observedAtMs + 2_000);
      await fixture.live.commitReconciliation(fixture.claim, unknown);
      const terminalClaim = await claimSellReconciliation(pool, 'sell-no-effect-after-unknown');

      const result = await fixture.live.commitReconciliation(terminalClaim, noEffect);

      assert.equal(result.result, 'NO_EFFECT');
      assert.deepEqual(await durableState(pool, fixture), {
        artifact_state: 'RECONCILED', intent_status: 'RETRY_READY', attempt_status: 'ABANDONED',
        attempt_reason: 'RECONCILIATION_PROVED_NO_EFFECT', position_state: 'EXIT_PENDING',
        remaining_base_raw: '95', authorization_state: 'ACTIVE', locked_intent_id: null,
        locked_attempt_number: null, armament_state: 'LOCKED', unknown_block: false,
        reserved_exposure_raw: '1000', open_positions: 1, evidence_count: 2,
        unresolved_evidence_count: 0, sell_artifact_count: 1,
      });
      const resolved = await pool.query(`SELECT result,resolved_by_evidence_id,purge_after
        FROM execution_reconciliation_evidence
        WHERE intent_id=$1 ORDER BY observed_at`, [fixture.claim.intent.id]);
      assert.equal(resolved.rows[0]?.result, 'UNKNOWN');
      assert.equal(resolved.rows[0]?.resolved_by_evidence_id, noEffect.evidenceId);
      assert.ok(resolved.rows[0]?.purge_after instanceof Date);
    });
  });

void test('SELL NO_EFFECT activation fences a concurrent live BUY claim before generation locks',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createAmbiguousSellFixture(pool);
      const unknown = sellEvidence(fixture, 'UNKNOWN', fixture.observedAtMs);
      const noEffect = sellEvidence(fixture, 'NO_EFFECT', fixture.observedAtMs + 2_000);
      await fixture.live.commitReconciliation(fixture.claim, unknown);
      const terminalClaim = await claimSellReconciliation(pool, 'sell-no-effect-race');

      const intents = new PostgresExecutionIntentRepository(pool);
      const nowMs = Date.now();
      const decisionEventId = `decision:${randomUUID()}`;
      await insertExecutionDecisionEvent(pool, decisionEventId, walletPublicKey);
      await intents.create(createExecutionIntentDraft({
        strategyId: 'sell-activation-race-test', strategyVersion: 1,
        positionId: `position:${randomUUID()}`, logicalCommandId: `command:${randomUUID()}`,
        mint: walletPublicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint,
        quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9, quoteAmountRaw: 1n,
        baseAmountRaw: null, minimumAmountOutRaw: 1n,
        decisionEventId, decisionFingerprint: fingerprint,
        requestedAtMs: nowMs, expiresAtMs: nowMs + 120_000,
      }));

      const blocker = await pool.connect();
      let blockerOpen = false;
      let reconciliation: Promise<unknown> | undefined;
      let buyClaim: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        blockerOpen = true;
        await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 51005))', [
          generationId,
        ]);
        reconciliation = fixture.live.commitReconciliation(terminalClaim, noEffect);
        await waitForDatabaseQuery(pool, '%hashtextextended($1, 51005)%');

        buyClaim = intents.claim({
          ownerId: 'live-buy-during-sell-activation', leaseMs: 60_000,
          purpose: 'LIVE_EXECUTE', side: 'BUY', generationId,
        });
        const outcome = await Promise.race([
          buyClaim.then(() => 'CLAIM_SETTLED' as const),
          waitForDatabaseQuery(pool, '%execution-live-sell-presence:v1%')
            .then(() => 'CLAIM_BLOCKED' as const),
        ]);
        assert.equal(outcome, 'CLAIM_SETTLED');
        assert.equal(await buyClaim, null);

        await blocker.query('COMMIT');
        blockerOpen = false;
        assert.equal((await reconciliation as { readonly result: string }).result, 'NO_EFFECT');
        assert.equal(await buyClaim, null);
      } finally {
        if (blockerOpen) await blocker.query('ROLLBACK');
        blocker.release();
        await Promise.allSettled(
          [reconciliation, buyClaim].filter((value) => value !== undefined),
        );
      }
    });
  });

void test('SELL signed persistence fences a live BUY when PROCESSING expired during its lease',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      let raceExercised = false;
      await createSellFixture(pool, 'AMBIGUOUS', async (live, input) => {
        const expired = await pool.query(`UPDATE execution_intents SET
          expires_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 millisecond'
          WHERE id=$1 AND status='PROCESSING'
          RETURNING expires_at < statement_timestamp() AS expired`, [input.artifact.intentId]);
        assert.deepEqual(expired.rows, [{ expired: true }]);

        const intents = new PostgresExecutionIntentRepository(pool);
        const nowMs = Date.now();
        const decisionEventId = `decision:${randomUUID()}`;
        await insertExecutionDecisionEvent(pool, decisionEventId, walletPublicKey);
        await intents.create(createExecutionIntentDraft({
          strategyId: 'sell-persist-race-test', strategyVersion: 1,
          positionId: `position:${randomUUID()}`, logicalCommandId: `command:${randomUUID()}`,
          mint: walletPublicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint,
          quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9, quoteAmountRaw: 1n,
          baseAmountRaw: null, minimumAmountOutRaw: 1n,
          decisionEventId, decisionFingerprint: fingerprint,
          requestedAtMs: nowMs, expiresAtMs: nowMs + 120_000,
        }));

        const blocker = await pool.connect();
        let blockerOpen = false;
        let persistence: Promise<unknown> | undefined;
        let buyClaim: Promise<unknown> | undefined;
        try {
          await blocker.query('BEGIN');
          blockerOpen = true;
          await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 51005))', [
            generationId,
          ]);
          persistence = live.persistSigned(input);
          await waitForDatabaseQuery(pool, '%hashtextextended($1, 51005)%');

          buyClaim = intents.claim({
            ownerId: 'live-buy-during-sell-persist', leaseMs: 60_000,
            purpose: 'LIVE_EXECUTE', side: 'BUY', generationId,
          });
          const outcome = await Promise.race([
            buyClaim.then(() => 'CLAIM_SETTLED' as const),
            waitForDatabaseQuery(pool, '%execution-live-sell-presence:v1%')
              .then(() => 'CLAIM_BLOCKED' as const),
          ]);
          assert.equal(outcome, 'CLAIM_SETTLED');
          assert.equal(await buyClaim, null);

          await blocker.query('COMMIT');
          blockerOpen = false;
          await persistence;
          assert.equal(await buyClaim, null);
          raceExercised = true;
        } finally {
          if (blockerOpen) await blocker.query('ROLLBACK');
          blocker.release();
          await Promise.allSettled(
            [persistence, buyClaim].filter((value) => value !== undefined),
          );
          await pool.query(`UPDATE execution_intents SET
            expires_at=date_trunc('milliseconds',statement_timestamp())+INTERVAL '60 seconds'
            WHERE id=$1`, [input.artifact.intentId]);
        }
      });
      assert.equal(raceExercised, true);
    });
  });

void test('SELL UNKNOWN then MATCHED closes the only position and consumes capabilities',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createAmbiguousSellFixture(pool);
      const unknown = sellEvidence(fixture, 'UNKNOWN', fixture.observedAtMs);
      const matched = sellEvidence(fixture, 'MATCHED', fixture.observedAtMs + 2_000);
      await fixture.live.commitReconciliation(fixture.claim, unknown);
      const terminalClaim = await claimSellReconciliation(pool, 'sell-matched-after-unknown');

      const result = await fixture.live.commitReconciliation(terminalClaim, matched);

      assert.equal(result.result, 'MATCHED');
      assert.deepEqual(await durableState(pool, fixture), {
        artifact_state: 'RECONCILED', intent_status: 'SUCCEEDED', attempt_status: 'COMPLETED',
        attempt_reason: 'ATTEMPT_COMPLETED', position_state: 'CLOSED', remaining_base_raw: '0',
        authorization_state: 'CONSUMED', locked_intent_id: fixture.claim.intent.id,
        locked_attempt_number: 1, armament_state: 'CONSUMED', unknown_block: false,
        reserved_exposure_raw: '0', open_positions: 0, evidence_count: 2,
        unresolved_evidence_count: 0, sell_artifact_count: 1,
      });
    });
  });

void test('SELL MISMATCH from CONFIRMED remains blocked pending manual resolution',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createSellFixture(pool, 'CONFIRMED');
      const mismatch = sellEvidence(fixture, 'MISMATCH', fixture.observedAtMs);
      const noEffect = sellEvidence(fixture, 'NO_EFFECT', fixture.observedAtMs + 2_000);

      const result = await fixture.live.commitReconciliation(fixture.claim, mismatch);

      assert.equal(result.result, 'MISMATCH');
      assert.deepEqual(await durableState(pool, fixture),
        expectedUnknownState(fixture.claim.intent.id, 1));
      assert.deepEqual(await ambiguityTransitions(pool, fixture), {
        artifact_transition_count: 1, intent_transition_count: 1,
      });
      await assert.rejects(
        fixture.live.commitReconciliation(fixture.claim, noEffect),
        (error: unknown) => error instanceof ExecutionLiveRepositoryError
          && error.code === 'CONFLICT',
      );
      assert.deepEqual(await durableState(pool, fixture),
        expectedUnknownState(fixture.claim.intent.id, 1));
    });
  });

void test('late exact SELL replays cannot create a second exit or a second concurrent claim',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createAmbiguousSellFixture(pool);
      const unknown = sellEvidence(fixture, 'UNKNOWN', fixture.observedAtMs);
      const noEffect = sellEvidence(fixture, 'NO_EFFECT', fixture.observedAtMs + 2_000);
      await fixture.live.commitReconciliation(fixture.claim, unknown);
      const terminalClaim = await claimSellReconciliation(pool, 'sell-late-replay');
      await fixture.live.commitReconciliation(terminalClaim, noEffect);
      const intents = new PostgresExecutionIntentRepository(pool);
      const claims = await Promise.all([
        intents.claim({
          ownerId: 'retry-a', leaseMs: 60_000, purpose: 'LIVE_EXECUTE', side: 'SELL',
        }),
        intents.claim({
          ownerId: 'retry-b', leaseMs: 60_000, purpose: 'LIVE_EXECUTE', side: 'SELL',
        }),
      ]);
      const retryClaim = claims.find((candidate) => candidate !== null);
      assert.ok(retryClaim);
      assert.equal(claims.filter((candidate) => candidate !== null).length, 1);
      const retryProcessing = await intents.transition(retryClaim, {
        intentId: retryClaim.intent.id, expectedStatus: 'RETRY_READY', nextStatus: 'PROCESSING',
        leaseToken: retryClaim.leaseToken, reasonCode: 'EXECUTION_STARTED',
        humanMessage: 'Retry the finalized no-effect SELL.', activationPhase: 'CANARY',
        evidence: Object.freeze({
          payloadVersion: 1, attemptNumber: 1, sourceEventId: null,
          observedAtMs: fixture.observedAtMs + 3_000,
        }),
      });
      await intents.beginAttempt(Object.freeze({ ...retryClaim, intent: retryProcessing }));

      assert.equal((await fixture.live.commitReconciliation(fixture.claim, noEffect)).result,
        'NO_EFFECT');
      assert.equal((await fixture.live.commitReconciliation(fixture.claim, unknown)).result,
        'UNKNOWN');
      const counts = await pool.query(`SELECT
        (SELECT attempt_count FROM execution_intents WHERE id=$1) AS attempt_count,
        (SELECT COUNT(*)::INTEGER FROM execution_attempts WHERE intent_id=$1) AS attempts,
        (SELECT COUNT(*)::INTEGER FROM execution_signed_transactions
          WHERE intent_id=$1) AS sell_artifacts,
        (SELECT COUNT(*)::INTEGER FROM execution_live_positions
          WHERE exit_intent_id=$1) AS bound_positions`, [fixture.claim.intent.id]);
      assert.deepEqual(counts.rows, [{
        attempt_count: 2, attempts: 2, sell_artifacts: 1, bound_positions: 1,
      }]);
    });
  });

for (const submissionState of ['CONFIRMED', 'ACCEPTED'] as const) {
  void test(`SELL landed with an error from ${submissionState} ends FAILED and re-enables the exit`,
    async (context) => {
      const databaseUrl = requiredDatabaseUrl(context);
      if (databaseUrl === null) return;
      await withTemporarySchema(databaseUrl, async (pool) => {
        const fixture = await createSellFixture(pool, submissionState);
        const controlBefore = await controlState(pool);
        const evidence = landedFailedSellEvidence(fixture, fixture.observedAtMs);
        assert.equal(evidence.result, 'NO_EFFECT');

        const result = await fixture.live.commitReconciliation(fixture.claim, evidence);

        assert.equal(result.result, 'NO_EFFECT');
        assert.deepEqual(await durableState(pool, fixture), expectedLandedFailedState(1));
        assert.deepEqual(await landedFailedJournal(pool, fixture), {
          artifact: [
            { previous_state: submissionState, next_state: 'AMBIGUOUS',
              reason_code: 'RECONCILIATION_REQUIRED' },
            { previous_state: 'AMBIGUOUS', next_state: 'RECONCILED',
              reason_code: 'RECONCILIATION_PROVED_NO_EFFECT' },
          ],
          intent: [
            { previous_status: submissionState === 'CONFIRMED' ? 'CONFIRMED' : 'SUBMITTED',
              next_status: 'UNKNOWN_REQUIRES_RECONCILIATION',
              reason_code: 'RECONCILIATION_REQUIRED' },
            { previous_status: 'UNKNOWN_REQUIRES_RECONCILIATION', next_status: 'FAILED',
              reason_code: 'RECONCILIATION_PROVED_NO_EFFECT' },
          ],
        });
        assert.deepEqual(await terminalIntentColumns(pool, fixture, evidence), {
          status: 'FAILED', last_reason_code: 'RECONCILIATION_PROVED_NO_EFFECT',
          lease_owner: null, terminal: true, completed: true, purge: true,
        });
        assert.deepEqual(await persistedEvidence(pool, fixture), [{
          result: 'NO_EFFECT', reason_code: 'RECONCILIATION_PROVED_NO_EFFECT',
          signature_history: 'PRESENT', confirmation_status: 'FINALIZED',
          has_transaction_fingerprint: true, fee_lamports: '5000',
          wallet_lamport_delta: '-5000', base_delta_raw: '0', quote_delta_raw: '0',
          unexpected_residual_token_balance_raw: '95',
        }]);
        assert.deepEqual(await controlState(pool), controlBefore);
        assert.equal((await fixture.live.commitReconciliation(fixture.claim, evidence)).result,
          'NO_EFFECT');
        assert.deepEqual(await durableState(pool, fixture), expectedLandedFailedState(1));
      });
    });
}

void test('SELL landed with an error after a prior UNKNOWN run resolves it and ends FAILED',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createSellFixture(pool, 'CONFIRMED');
      const unknown = sellEvidence(fixture, 'UNKNOWN', fixture.observedAtMs);
      await fixture.live.commitReconciliation(fixture.claim, unknown);
      assert.deepEqual(await durableState(pool, fixture),
        expectedUnknownState(fixture.claim.intent.id, 1));
      const terminalClaim = await claimSellReconciliation(pool, 'sell-landed-failed-after-unknown');
      const evidence = landedFailedSellEvidence(fixture, fixture.observedAtMs + 2_000);

      assert.equal((await fixture.live.commitReconciliation(terminalClaim, evidence)).result,
        'NO_EFFECT');

      assert.deepEqual(await durableState(pool, fixture), expectedLandedFailedState(2));
      const journal = await landedFailedJournal(pool, fixture);
      assert.equal(journal.artifact.length, 2);
      assert.deepEqual(journal.intent.map((row) => row.next_status),
        ['UNKNOWN_REQUIRES_RECONCILIATION', 'FAILED']);
      const resolved = await pool.query(`SELECT result,resolved_by_evidence_id
        FROM execution_reconciliation_evidence WHERE intent_id=$1 ORDER BY observed_at`, [
        fixture.claim.intent.id,
      ]);
      assert.deepEqual(resolved.rows, [
        { result: 'UNKNOWN', resolved_by_evidence_id: evidence.evidenceId },
        { result: 'NO_EFFECT', resolved_by_evidence_id: null },
      ]);
    });
  });

void test('SELL landed with an error is refused unless the whole position is still in the wallet',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createSellFixture(pool, 'CONFIRMED');
      const before = await durableState(pool, fixture);
      const short = landedFailedSellEvidence(fixture, fixture.observedAtMs, {
        unexpectedResidualTokenBalanceRaw: 94n,
      });
      assert.equal(short.result, 'NO_EFFECT');
      await assert.rejects(
        fixture.live.commitReconciliation(fixture.claim, short),
        (error: unknown) => error instanceof ExecutionLiveRepositoryError
          && error.code === 'CONFLICT',
      );
      assert.deepEqual(await durableState(pool, fixture), before);
      assert.equal(before.intent_status, 'CONFIRMED');
      const covered = landedFailedSellEvidence(fixture, fixture.observedAtMs, {
        unexpectedResidualTokenBalanceRaw: 96n,
      });
      assert.equal((await fixture.live.commitReconciliation(fixture.claim, covered)).result,
        'NO_EFFECT');
      assert.deepEqual(await durableState(pool, fixture), expectedLandedFailedState(1));
    });
  });

void test('SELL landed with an error and any other balance change keeps the MISMATCH block',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    for (const overrides of [
      { baseDeltaRaw: -1n },
      { baseDeltaRaw: 1n },
      { baseTokenAccountsUnchanged: false },
      { walletLamportDelta: -5_001n },
      { walletLamportDelta: -4_999n },
      { feeLamports: 5_001n, walletLamportDelta: -5_001n },
    ]) {
      await withTemporarySchema(databaseUrl, async (pool) => {
        const fixture = await createSellFixture(pool, 'CONFIRMED');
        const evidence = landedFailedSellEvidence(fixture, fixture.observedAtMs, overrides);
        assert.equal(evidence.result, 'MISMATCH');
        assert.equal((await fixture.live.commitReconciliation(fixture.claim, evidence)).result,
          'MISMATCH');
        assert.deepEqual(await durableState(pool, fixture),
          expectedUnknownState(fixture.claim.intent.id, 1));
      });
    }
  });

void test('SELL landed without an error stays MATCHED with the failure facts present',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createSellFixture(pool, 'CONFIRMED');
      const legacy = sellEvidence(fixture, 'MATCHED', fixture.observedAtMs);
      const explicit = landedFailedSellEvidence(fixture, fixture.observedAtMs, {
        transactionFailed: false, baseTokenAccountsUnchanged: false,
        feeLamports: 5_000n, walletLamportDelta: 795n, baseDeltaRaw: -95n, quoteDeltaRaw: 800n,
        unexpectedResidualTokenBalanceRaw: 0n,
      });
      assert.deepEqual(explicit, legacy);
      assert.equal((await fixture.live.commitReconciliation(fixture.claim, explicit)).result,
        'MATCHED');
      assert.deepEqual((await pool.query(`SELECT state FROM execution_live_positions`)).rows,
        [{ state: 'CLOSED' }]);
    });
  });

void test('PostgreSQL 16 recovery role ends a landed-with-error SELL FAILED',
  async (context) => {
    await withProvisionedDatabase(context, async (pool) => {
      const fixture = await createSellFixture(pool, 'CONFIRMED');
      const recovery = new PostgresExecutionLiveRepository(
        roleSource(pool, 'sol_token_executor_live_recovery'),
      );
      const evidence = landedFailedSellEvidence(fixture, fixture.observedAtMs);
      assert.equal((await recovery.commitReconciliation(fixture.claim, evidence)).result,
        'NO_EFFECT');
      assert.deepEqual(await durableState(pool, fixture), expectedLandedFailedState(1));
      assert.equal((await recovery.commitReconciliation(fixture.claim, evidence)).result,
        'NO_EFFECT');
    });
  });

function expectedLandedFailedState(evidenceCount: number) {
  return {
    artifact_state: 'RECONCILED', intent_status: 'FAILED', attempt_status: 'ABANDONED',
    attempt_reason: 'RECONCILIATION_PROVED_NO_EFFECT', position_state: 'EXIT_PENDING',
    remaining_base_raw: '95', authorization_state: 'ACTIVE', locked_intent_id: null,
    locked_attempt_number: null, armament_state: 'LOCKED', unknown_block: false,
    reserved_exposure_raw: '1000', open_positions: 1, evidence_count: evidenceCount,
    unresolved_evidence_count: 0, sell_artifact_count: 1,
  };
}


async function landedFailedJournal(
  pool: InstanceType<typeof pg.Pool>,
  fixture: Awaited<ReturnType<typeof createAmbiguousSellFixture>>,
) {
  const artifact = await pool.query<{
    previous_state: string; next_state: string; reason_code: string;
  }>(`SELECT previous_state,next_state,reason_code FROM execution_submission_events
    WHERE artifact_id=$1 AND next_state IN ('AMBIGUOUS','RECONCILED')
    ORDER BY occurred_at,event_id`, [fixture.artifact.artifactId]);
  const intent = await pool.query<{
    previous_status: string; next_status: string; reason_code: string;
  }>(`SELECT previous_status,next_status,reason_code FROM execution_intent_transitions
    WHERE intent_id=$1 AND next_status IN ('UNKNOWN_REQUIRES_RECONCILIATION','FAILED')
    ORDER BY sequence`, [fixture.claim.intent.id]);
  return { artifact: artifact.rows, intent: intent.rows };
}

async function terminalIntentColumns(
  pool: InstanceType<typeof pg.Pool>,
  fixture: Awaited<ReturnType<typeof createAmbiguousSellFixture>>,
  evidence: Readonly<{ finalizedAtMs: number | null }>,
) {
  assert.ok(evidence.finalizedAtMs !== null);
  const row = (await pool.query(`SELECT status,last_reason_code,lease_owner,
    terminal_at=TIMESTAMPTZ 'epoch'+($2::BIGINT*INTERVAL '1 millisecond') AS terminal,
    reconciliation_completed_at=terminal_at AS completed,
    purge_after=terminal_at+INTERVAL '4 hours' AS purge
    FROM execution_intents WHERE id=$1`, [fixture.claim.intent.id, evidence.finalizedAtMs]))
    .rows[0] as unknown;
  return row;
}

async function persistedEvidence(
  pool: InstanceType<typeof pg.Pool>,
  fixture: Awaited<ReturnType<typeof createAmbiguousSellFixture>>,
) {
  return (await pool.query<Record<string, unknown>>(`SELECT result,reason_code,signature_history,confirmation_status,
    observed_transaction_fingerprint IS NOT NULL AS has_transaction_fingerprint,
    fee_lamports::TEXT AS fee_lamports,wallet_lamport_delta::TEXT AS wallet_lamport_delta,
    base_delta_raw::TEXT AS base_delta_raw,quote_delta_raw::TEXT AS quote_delta_raw,
    unexpected_residual_token_balance_raw::TEXT AS unexpected_residual_token_balance_raw
    FROM execution_reconciliation_evidence WHERE intent_id=$1`, [fixture.claim.intent.id])).rows;
}

async function controlState(pool: InstanceType<typeof pg.Pool>) {
  return (await pool.query<Record<string, unknown>>(`SELECT state,state_revision::TEXT AS state_revision
    FROM execution_control_state WHERE generation_id=$1`, [generationId])).rows;
}

function expectedClosedState(intentId: string) {
  return {
    artifact_state: 'RECONCILED', intent_status: 'SUCCEEDED', attempt_status: 'COMPLETED',
    attempt_reason: 'ATTEMPT_COMPLETED', position_state: 'CLOSED', remaining_base_raw: '0',
    authorization_state: 'CONSUMED', locked_intent_id: intentId, locked_attempt_number: 1,
    armament_state: 'CONSUMED', unknown_block: false, reserved_exposure_raw: '0',
    open_positions: 0, evidence_count: 1, unresolved_evidence_count: 0, sell_artifact_count: 1,
  };
}

async function exposureState(
  pool: InstanceType<typeof pg.Pool>,
  fixture: Awaited<ReturnType<typeof createAmbiguousSellFixture>>,
) {
  const result = await pool.query<{
    quote_cost_raw: string; buy_reserved_amount_raw: string; reserved_exposure_raw: string;
  }>(`SELECT position.quote_cost_raw::TEXT AS quote_cost_raw,
    buy_reservation.maximum_amount_raw::TEXT AS buy_reserved_amount_raw,
    risk.reserved_exposure_raw::TEXT AS reserved_exposure_raw
    FROM execution_live_positions position
    JOIN execution_exposure_reservations buy_reservation
      ON buy_reservation.intent_id=position.buy_intent_id
    JOIN execution_wallet_risk_state risk ON risk.generation_id=position.generation_id
    WHERE position.exit_intent_id=$1`, [fixture.claim.intent.id]);
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

function expectedUnknownState(intentId: string, evidenceCount: number) {
  return {
    artifact_state: 'AMBIGUOUS', intent_status: 'UNKNOWN_REQUIRES_RECONCILIATION',
    attempt_status: 'STARTED', attempt_reason: null, position_state: 'UNKNOWN',
    remaining_base_raw: '95', authorization_state: 'LOCKED',
    locked_intent_id: intentId, locked_attempt_number: 1,
    armament_state: 'LOCKED', unknown_block: true, reserved_exposure_raw: '1000',
    open_positions: 1, evidence_count: evidenceCount, unresolved_evidence_count: evidenceCount,
    sell_artifact_count: 1,
  };
}

interface DurableSellState {
  readonly artifact_state: string;
  readonly intent_status: string;
  readonly attempt_status: string;
  readonly attempt_reason: string | null;
  readonly position_state: string;
  readonly remaining_base_raw: string;
  readonly authorization_state: string;
  readonly locked_intent_id: string | null;
  readonly locked_attempt_number: number | null;
  readonly armament_state: string;
  readonly unknown_block: boolean;
  readonly reserved_exposure_raw: string;
  readonly open_positions: number;
  readonly evidence_count: number;
  readonly unresolved_evidence_count: number;
  readonly sell_artifact_count: number;
}

async function durableState(
  pool: InstanceType<typeof pg.Pool>,
  fixture: Awaited<ReturnType<typeof createAmbiguousSellFixture>>,
): Promise<DurableSellState> {
  const result = await pool.query<DurableSellState>(`SELECT
    artifact.state AS artifact_state,intent.status AS intent_status,
    attempt.status AS attempt_status,attempt.reason_code AS attempt_reason,
    position.state AS position_state,position.remaining_base_raw::TEXT AS remaining_base_raw,
    exit_auth.state AS authorization_state,exit_auth.locked_intent_id,
    exit_auth.locked_attempt_number,armament.state AS armament_state,risk.unknown_block,
    risk.reserved_exposure_raw::TEXT AS reserved_exposure_raw,risk.open_positions,
    (SELECT COUNT(*)::INTEGER FROM execution_reconciliation_evidence evidence
      WHERE evidence.intent_id=intent.id) AS evidence_count,
    (SELECT COUNT(*)::INTEGER FROM execution_reconciliation_evidence evidence
      WHERE evidence.intent_id=intent.id AND evidence.resolved_by_evidence_id IS NULL
        AND evidence.result IN ('UNKNOWN','MISMATCH')) AS unresolved_evidence_count,
    (SELECT COUNT(*)::INTEGER FROM execution_signed_transactions candidate
      WHERE candidate.intent_id=intent.id) AS sell_artifact_count
    FROM execution_intents intent
    JOIN execution_attempts attempt ON attempt.intent_id=intent.id AND attempt.attempt_number=1
    JOIN execution_signed_transactions artifact ON artifact.intent_id=intent.id
      AND artifact.attempt_number=1
    JOIN execution_live_positions position ON position.exit_intent_id=intent.id
    JOIN execution_exit_authorizations exit_auth ON exit_auth.position_id=position.position_id
    JOIN execution_activation_armaments armament ON armament.armament_id=position.armament_id
    JOIN execution_wallet_risk_state risk ON risk.generation_id=position.generation_id
    WHERE intent.id=$1`, [fixture.claim.intent.id]);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

async function ambiguityTransitions(
  pool: InstanceType<typeof pg.Pool>,
  fixture: Awaited<ReturnType<typeof createAmbiguousSellFixture>>,
): Promise<{ artifact_transition_count: number; intent_transition_count: number }> {
  const result = await pool.query<{ artifact_transition_count: number;
    intent_transition_count: number }>(`SELECT
    (SELECT COUNT(*)::INTEGER FROM execution_submission_events
      WHERE artifact_id=$1 AND next_state='AMBIGUOUS'
        AND reason_code='RECONCILIATION_REQUIRED') AS artifact_transition_count,
    (SELECT COUNT(*)::INTEGER FROM execution_intent_transitions
      WHERE intent_id=$2 AND next_status='UNKNOWN_REQUIRES_RECONCILIATION'
        AND reason_code='RECONCILIATION_REQUIRED') AS intent_transition_count`, [
    fixture.artifact.artifactId, fixture.claim.intent.id,
  ]);
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

async function terminalIntentTransitions(
  pool: InstanceType<typeof pg.Pool>,
  fixture: Awaited<ReturnType<typeof createAmbiguousSellFixture>>,
): Promise<readonly Readonly<{
    previous_status: string; next_status: string; reason_code: string;
  }>[]> {
  const result = await pool.query<{
    previous_status: string; next_status: string; reason_code: string;
  }>(`SELECT previous_status,next_status,reason_code FROM (
      SELECT sequence,previous_status,next_status,reason_code
      FROM execution_intent_transitions
      WHERE intent_id=$1 AND next_status IN ('CONFIRMED','SUCCEEDED')
      ORDER BY sequence DESC LIMIT 2
    ) terminal ORDER BY sequence`, [fixture.claim.intent.id]);
  return result.rows;
}


async function envelopeRow(pool: InstanceType<typeof pg.Pool>, envelopeId: string) {
  const row = (await pool.query(`SELECT state,realized_loss_raw::TEXT AS realized_loss_raw,
    buys_armed,trunc(EXTRACT(EPOCH FROM updated_at)*1000)::TEXT AS updated_at_ms
    FROM execution_entry_envelopes WHERE envelope_id=$1`, [envelopeId])).rows[0];
  assert.ok(row !== undefined);
  return row as Readonly<{
    state: string; realized_loss_raw: string; buys_armed: number; updated_at_ms: string;
  }>;
}

