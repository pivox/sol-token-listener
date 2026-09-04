import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import bs58 from 'bs58';
import pg from 'pg';
import {
  createExecutionArmament,
  createOperatorAuthorization,
} from '../src/domain/execution-operations.js';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { createSignedTransactionArtifact } from '../src/domain/execution-live.js';
import { createProviderUsageSnapshot } from '../src/domain/execution-provider-quota.js';
import { evaluateExecutionReconciliation } from '../src/domain/execution-reconciliation.js';
import { createExecutionRiskPolicy } from '../src/domain/execution-risk-policy.js';
import {
  createMainnetSimulationEvidenceFingerprint,
  createSafetyQualification,
  EXECUTION_SAFETY_GATE_IDS,
} from '../src/domain/execution-safety-qualification.js';
import { createExecutionSimulationArtifactDraft } from '../src/domain/execution-simulation.js';
import {
  createExecutionLiveSignedSimulationEvidence,
  createExecutionLiveUnsignedSimulationEvidenceIdentity,
} from
  '../src/domain/execution-live-signed-simulation.js';
import type { ExecutionSimulationEvidenceV1 } from
  '../src/ports/execution-simulation-gateway.js';
import { ExecutionAdmissionService } from '../src/executor-risk/admission-service.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
import {
  ExecutionLiveRepositoryError,
  PostgresExecutionLiveRepository,
} from '../src/storage/execution-live.repository.js';
import { PostgresExecutionOperationsRepository } from '../src/storage/execution-operations.repository.js';
import { PostgresExecutionRiskRepository } from '../src/storage/execution-risk.repository.js';
import { PostgresExecutionSimulationRepository } from '../src/storage/execution-simulation.repository.js';

const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
const walletPublicKey = '11111111111111111111111111111111';
const quoteMint = 'So11111111111111111111111111111111111111112';
const fingerprint = '1'.repeat(64);

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
      await intents.create(createExecutionIntentDraft({
        strategyId: 'sell-activation-race-test', strategyVersion: 1,
        positionId: `position:${randomUUID()}`, logicalCommandId: `command:${randomUUID()}`,
        mint: walletPublicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint,
        quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9, quoteAmountRaw: 1n,
        baseAmountRaw: null, minimumAmountOutRaw: 1n,
        decisionEventId: `decision:${randomUUID()}`, decisionFingerprint: fingerprint,
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
          purpose: 'LIVE_EXECUTE', side: 'BUY',
        });
        const outcome = await Promise.race([
          buyClaim.then(() => 'CLAIM_SETTLED' as const),
          waitForDatabaseQuery(pool, '%execution-live-sell-presence:v1%')
            .then(() => 'CLAIM_BLOCKED' as const),
        ]);
        assert.equal(outcome, 'CLAIM_BLOCKED');

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
        await intents.create(createExecutionIntentDraft({
          strategyId: 'sell-persist-race-test', strategyVersion: 1,
          positionId: `position:${randomUUID()}`, logicalCommandId: `command:${randomUUID()}`,
          mint: walletPublicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint,
          quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9, quoteAmountRaw: 1n,
          baseAmountRaw: null, minimumAmountOutRaw: 1n,
          decisionEventId: `decision:${randomUUID()}`, decisionFingerprint: fingerprint,
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
            purpose: 'LIVE_EXECUTE', side: 'BUY',
          });
          const outcome = await Promise.race([
            buyClaim.then(() => 'CLAIM_SETTLED' as const),
            waitForDatabaseQuery(pool, '%execution-live-sell-presence:v1%')
              .then(() => 'CLAIM_BLOCKED' as const),
          ]);
          assert.equal(outcome, 'CLAIM_BLOCKED');

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
        intents.claim({ ownerId: 'retry-a', leaseMs: 60_000, purpose: 'EXECUTE' }),
        intents.claim({ ownerId: 'retry-b', leaseMs: 60_000, purpose: 'EXECUTE' }),
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

function sellEvidence(
  fixture: Awaited<ReturnType<typeof createAmbiguousSellFixture>>,
  outcome: 'MATCHED' | 'NO_EFFECT' | 'MISMATCH' | 'UNKNOWN',
  observedAtMs: number,
) {
  const common = {
    feeLamports: 0n, walletLamportDelta: 0n, baseDeltaRaw: 0n, quoteDeltaRaw: 0n,
    unexpectedResidualTokenBalanceRaw: 0n, observedAtMs, finalizedAtMs: null,
  };
  const observed = outcome === 'MATCHED' ? {
    signatureHistory: 'PRESENT' as const, confirmationStatus: 'FINALIZED' as const,
    finalizedBlockHeight: fixture.artifact.lastValidBlockHeight + 1n, observedSlot: 777n,
    transaction: Object.freeze({
      signature: fixture.artifact.signature, blockhash: fixture.artifact.blockhash,
      messageHash: fixture.artifact.messageHash,
      buildFingerprint: fixture.artifact.buildFingerprint,
      snapshotFingerprint: fixture.artifact.snapshotFingerprint,
    }),
    feeLamports: 5_000n, walletLamportDelta: 795n,
    baseDeltaRaw: -95n, quoteDeltaRaw: 800n,
    unexpectedResidualTokenBalanceRaw: 0n, observedAtMs, finalizedAtMs: observedAtMs + 1,
  } : outcome === 'NO_EFFECT' ? {
    ...common, signatureHistory: 'ABSENT' as const, confirmationStatus: 'NOT_FOUND' as const,
    finalizedBlockHeight: fixture.artifact.lastValidBlockHeight + 1n,
    observedSlot: null, transaction: null, finalizedAtMs: observedAtMs + 1,
  } : outcome === 'MISMATCH' ? {
    ...common, signatureHistory: 'UNKNOWN' as const, confirmationStatus: 'NOT_FOUND' as const,
    finalizedBlockHeight: fixture.artifact.lastValidBlockHeight,
    observedSlot: null, transaction: null, unexpectedResidualTokenBalanceRaw: 1n,
  } : {
    ...common, signatureHistory: 'UNKNOWN' as const, confirmationStatus: 'NOT_FOUND' as const,
    finalizedBlockHeight: fixture.artifact.lastValidBlockHeight,
    observedSlot: null, transaction: null,
  };
  return evaluateExecutionReconciliation({
    expected: Object.freeze({
      intentId: fixture.artifact.intentId, attemptNumber: fixture.artifact.attemptNumber,
      walletGeneration: 1, providerId: fixture.artifact.providerId, side: 'SELL' as const,
      signature: fixture.artifact.signature, blockhash: fixture.artifact.blockhash,
      lastValidBlockHeight: fixture.artifact.lastValidBlockHeight,
      messageHash: fixture.artifact.messageHash,
      buildFingerprint: fixture.artifact.buildFingerprint,
      snapshotFingerprint: fixture.artifact.snapshotFingerprint,
      maximumFeeLamports: fixture.unsignedSimulation.estimatedFeeLamports,
      maximumFeePayerLamportDebit: fixture.unsignedSimulation.simulatedFeePayerLamportDebit,
    }),
    observed: Object.freeze(observed),
  });
}

async function createAmbiguousSellFixture(pool: InstanceType<typeof pg.Pool>) {
  return createSellFixture(pool, 'AMBIGUOUS');
}

async function createSellFixture(
  pool: InstanceType<typeof pg.Pool>,
  submissionState: 'AMBIGUOUS' | 'ACCEPTED' | 'CONFIRMED',
  beforePersistSigned?: (
    live: PostgresExecutionLiveRepository,
    input: Parameters<PostgresExecutionLiveRepository['persistSigned']>[0],
  ) => Promise<void>,
) {
  await migrateDatabase({ pool });
  const buy = await createBuyFixture(pool);
  const live = new PostgresExecutionLiveRepository(pool);
  await live.persistSigned({
    payloadVersion: 1, claim: buy.claim, qualificationId: buy.qualificationId,
    reservationId: buy.reservationId, artifact: buy.artifact,
    unsignedSimulation: buy.unsignedSimulation,
  });
  const buySimulated = await live.recordSignedSimulation(buy.claim, signedSimulation(
    buy.artifact, buy.unsignedSimulation, 95n, -1_000n, buy.artifact.signedAtMs + 1,
  ));
  const buyStarted = await live.beginSubmission({
    claim: buy.claim, artifactId: buy.artifact.artifactId,
    expectedRevision: buySimulated.stateRevision, runtime: buy.runtime,
    blockhashValidity: blockhashValidity(buy.artifact, Date.now()),
  });
  const buyOutcomeAtMs = Date.now();
  await live.recordSubmissionOutcome(buy.claim, {
    payloadVersion: 1, artifactId: buy.artifact.artifactId,
    expectedRevision: buyStarted.stateRevision, outcome: 'ACCEPTED',
    returnedSignature: buy.artifact.signature, reasonCode: 'SUBMISSION_ACCEPTED',
    observedAtMs: buyOutcomeAtMs,
  });
  await live.recordConfirmation(buy.claim, {
    payloadVersion: 1, artifactId: buy.artifact.artifactId, expectedRevision: 3n,
    signature: buy.artifact.signature, observedSlot: 126n,
    observedAtMs: Date.now(),
  });
  const buyReconciliationClaim = await new PostgresExecutionIntentRepository(pool).claim({
    ownerId: 'sell-fixture-entry-reconciliation', leaseMs: 60_000, purpose: 'RECONCILE',
  });
  assert.ok(buyReconciliationClaim);
  const buyReconciliationAtMs = Date.now();
  const buyEvidence = evaluateExecutionReconciliation({
    expected: Object.freeze({
      intentId: buy.artifact.intentId, attemptNumber: 1, walletGeneration: 1,
      providerId: buy.artifact.providerId, side: 'BUY' as const,
      signature: buy.artifact.signature, blockhash: buy.artifact.blockhash,
      lastValidBlockHeight: buy.artifact.lastValidBlockHeight,
      messageHash: buy.artifact.messageHash, buildFingerprint: buy.artifact.buildFingerprint,
      snapshotFingerprint: buy.artifact.snapshotFingerprint,
      maximumFeeLamports: buy.unsignedSimulation.estimatedFeeLamports,
      maximumFeePayerLamportDebit: buy.unsignedSimulation.simulatedFeePayerLamportDebit,
    }),
    observed: Object.freeze({
      signatureHistory: 'PRESENT' as const, confirmationStatus: 'FINALIZED' as const,
      finalizedBlockHeight: 1_001n, observedSlot: 127n,
      transaction: Object.freeze({
        signature: buy.artifact.signature, blockhash: buy.artifact.blockhash,
        messageHash: buy.artifact.messageHash,
        buildFingerprint: buy.artifact.buildFingerprint,
        snapshotFingerprint: buy.artifact.snapshotFingerprint,
      }),
      feeLamports: 5_000n, walletLamportDelta: -5_000n,
      baseDeltaRaw: 95n, quoteDeltaRaw: -1_000n,
      unexpectedResidualTokenBalanceRaw: 0n, observedAtMs: buyReconciliationAtMs,
      finalizedAtMs: buyReconciliationAtMs,
    }),
  });
  const entry = await live.commitReconciliation(buyReconciliationClaim, buyEvidence);
  assert.ok(entry.position);
  assert.ok(entry.exitAuthorization);
  const exitDeadlineAtMs = await makePositionDue(pool, entry.position.positionId);
  const exit = await live.createDeadlineExitIntent({
    positionId: entry.position.positionId, observedAtMs: exitDeadlineAtMs,
  });
  assert.ok(exit.intent);
  const intents = new PostgresExecutionIntentRepository(pool);
  const exitClaim = await intents.claim({
    ownerId: 'sell-reconciliation-test', leaseMs: 60_000, purpose: 'EXECUTE',
  });
  assert.ok(exitClaim);
  assert.equal(exitClaim.intent.id, exit.intent.id);
  const processing = await intents.transition(exitClaim, {
    intentId: exitClaim.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
    leaseToken: exitClaim.leaseToken, reasonCode: 'EXECUTION_STARTED',
    humanMessage: 'Prepare the canary SELL.', activationPhase: 'CANARY',
    evidence: Object.freeze({
      payloadVersion: 1, attemptNumber: null, sourceEventId: null,
      observedAtMs: exitDeadlineAtMs,
    }),
  });
  const begun = await intents.beginAttempt(Object.freeze({ ...exitClaim, intent: processing }));
  const sellTimelineMs = Date.now();
  const artifact = createSignedTransactionArtifact({
    payloadVersion: 1, specificationVersion: 1, intentId: begun.claim.intent.id,
    attemptNumber: begun.attempt.attemptNumber, generationId, armamentId: null,
    reservationId: null, exitAuthorizationId: entry.exitAuthorization.authorizationId,
    providerId: 'primary',
    walletPublicKey, side: 'SELL', effectiveVenue: 'PUMP_FUN', messageHash: 'a'.repeat(64),
    buildFingerprint: 'b'.repeat(64), snapshotFingerprint: 'c'.repeat(64),
    quoteFingerprint: 'e'.repeat(64), quoteObservedAtMs: sellTimelineMs,
    quoteExpiresAtMs: sellTimelineMs + 60_000,
    blockhash: walletPublicKey,
    lastValidBlockHeight: 2_000n, signature: bs58.encode(new Uint8Array(64).fill(10)),
    signedTransactionBytes: Uint8Array.from([5, 6, 7, 8]), signedAtMs: sellTimelineMs + 1,
  });
  const unsignedSimulation = Object.freeze({
    outcome: 'SUCCESS' as const, snapshotFingerprint: artifact.snapshotFingerprint,
    buildFingerprint: artifact.buildFingerprint, messageHash: artifact.messageHash,
    blockhash: artifact.blockhash, lastValidBlockHeight: artifact.lastValidBlockHeight,
    blockhashContextSlot: 200n, feeContextSlot: 200n, estimatedFeeLamports: 5_000n,
    simulationSlot: 201n, simulatedFeePayerLamportDebit: 5_000n, unitsConsumed: 25_000n,
    simulatedBaseDeltaRaw: -95n, simulatedQuoteDeltaRaw: 800n,
    logsFingerprint: 'f'.repeat(64), logsLineCount: 1,
  });
  const persistInput = Object.freeze({
    payloadVersion: 1, claim: begun.claim, qualificationId: buy.qualificationId,
    reservationId: null, artifact, unsignedSimulation,
  });
  await beforePersistSigned?.(live, persistInput);
  await live.persistSigned(persistInput);
  const simulated = await live.recordSignedSimulation(
    begun.claim,
    signedSimulation(artifact, unsignedSimulation, -95n, 800n, artifact.signedAtMs + 1),
  );
  const started = await live.beginSubmission({
    claim: begun.claim, artifactId: artifact.artifactId,
    expectedRevision: simulated.stateRevision, runtime: buy.runtime,
    blockhashValidity: blockhashValidity(artifact, Date.now()),
  });
  const sellOutcomeAtMs = Date.now();
  await live.recordSubmissionOutcome(begun.claim, {
    payloadVersion: 1, artifactId: artifact.artifactId,
    expectedRevision: started.stateRevision,
    outcome: submissionState === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'ACCEPTED',
    returnedSignature: submissionState === 'AMBIGUOUS' ? null : artifact.signature,
    reasonCode: submissionState === 'AMBIGUOUS'
      ? 'SUBMISSION_AMBIGUOUS' : 'SUBMISSION_ACCEPTED',
    observedAtMs: sellOutcomeAtMs,
  });
  if (submissionState === 'CONFIRMED') {
    await live.recordConfirmation(begun.claim, {
      payloadVersion: 1, artifactId: artifact.artifactId,
      expectedRevision: started.stateRevision + 1n, signature: artifact.signature,
      observedSlot: 778n, observedAtMs: sellOutcomeAtMs + 1,
    });
    const reconciliationClaim = await new PostgresExecutionIntentRepository(pool).claim({
      ownerId: 'sell-fixture-confirmed-reconciliation', leaseMs: 60_000, purpose: 'RECONCILE',
    });
    assert.ok(reconciliationClaim);
    return Object.freeze({
      live, claim: reconciliationClaim, artifact, unsignedSimulation,
      buyClaim: buyReconciliationClaim, buyEvidence,
      observedAtMs: Date.now(),
    });
  }
  return Object.freeze({
    live, claim: begun.claim, artifact, unsignedSimulation,
    buyClaim: buyReconciliationClaim, buyEvidence,
    observedAtMs: Date.now(),
  });
}

async function makePositionDue(
  pool: InstanceType<typeof pg.Pool>,
  positionId: string,
): Promise<number> {
  await pool.query(`ALTER TABLE execution_live_positions
    DISABLE TRIGGER execution_live_positions_guarded_update`);
  const updated = await pool.query(`UPDATE execution_live_positions SET
    exit_deadline_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 second',
    opened_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 second'
      -(maximum_holding_ms*INTERVAL '1 millisecond')
    WHERE position_id=$1
    RETURNING trunc(EXTRACT(EPOCH FROM exit_deadline_at)*1000)::TEXT AS deadline_ms`, [
    positionId,
  ]);
  assert.equal(updated.rowCount, 1);
  const deadlineMs = updated.rows[0]?.deadline_ms;
  assert.equal(typeof deadlineMs, 'string');
  return Number(deadlineMs);
}

function blockhashValidity(
  artifact: ReturnType<typeof createSignedTransactionArtifact>,
  observedAtMs: number,
) {
  return Object.freeze({
    payloadVersion: 1 as const, providerId: artifact.providerId,
    blockhash: artifact.blockhash, valid: true as const,
    observedBlockHeight: artifact.lastValidBlockHeight - 1n,
    contextSlot: 203n, observedAtMs,
  });
}

function signedSimulation(
  artifact: ReturnType<typeof createSignedTransactionArtifact>,
  unsignedSimulation: ExecutionSimulationEvidenceV1,
  baseDeltaRaw: bigint,
  quoteDeltaRaw: bigint,
  observedAtMs: number,
) {
  return createExecutionLiveSignedSimulationEvidence({
    payloadVersion: 1 as const, artifactId: artifact.artifactId,
    unsignedSimulationEvidenceId: createExecutionLiveUnsignedSimulationEvidenceIdentity(
      artifact, unsignedSimulation,
    ).evidenceId,
    signedTransactionHash: artifact.signedTransactionHash, simulationSlot: 202n,
    providerId: artifact.providerId,
    unitsConsumed: 26_000n, feePayerLamportDebit: 5_000n,
    baseDeltaRaw, quoteDeltaRaw, logsFingerprint: '9'.repeat(64), logsLineCount: 1,
    observedAtMs,
  });
}

async function createBuyFixture(pool: InstanceType<typeof pg.Pool>) {
  const simulation = await seedSuccessfulSimulation(pool);
  const risk = new PostgresExecutionRiskRepository(pool);
  await risk.registerWalletGeneration({
    generationId, payloadVersion: 1, walletPublicKey, cluster: 'mainnet-beta',
    genesisHash: walletPublicKey, generation: 1,
  });
  const nowMs = Date.now();
  const operations = new PostgresExecutionOperationsRepository(pool);
  const qualification = safetyQualification(nowMs, simulation);
  await operations.persistQualification(qualification);
  await operations.setStop({
    payloadVersion: 1, commandId: `command:stop:${randomUUID()}`, generationId,
    operatorId: 'operator-primary', occurredAtMs: nowMs,
  }, 'ENTRY_STOP');
  const resume = createOperatorAuthorization({
    payloadVersion: 1, generationId, action: 'RESUME', phase: null,
    contextFingerprint: qualification.qualificationFingerprint,
    nonceHash: 'b'.repeat(64), operatorId: 'operator-primary',
    issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
  });
  await operations.recordAuthorization(resume);
  await operations.resume({
    payloadVersion: 1, commandId: `command:resume:${randomUUID()}`, generationId,
    qualificationId: qualification.qualificationId, authorization: resume,
    operatorId: 'operator-primary', occurredAtMs: nowMs + 1,
  });
  const armAuthorization = createOperatorAuthorization({
    payloadVersion: 1, generationId, action: 'ARM', phase: 'CANARY',
    contextFingerprint: qualification.qualificationFingerprint,
    nonceHash: 'c'.repeat(64), operatorId: 'operator-primary',
    issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
  });
  await operations.recordAuthorization(armAuthorization);
  const armament = createExecutionArmament({
    payloadVersion: 1, qualification, maximumBuys: 1,
    maximumCapitalLamports: 500_000n, maximumExposureBps: 500n,
    maximumOpenPositions: 1, maximumHoldingMs: 30_000,
    armedAtMs: nowMs + 2, expiresAtMs: nowMs + 120_000,
    operatorId: 'operator-primary', operatorReason: 'Mainnet canary manually approved.',
    authorizationId: armAuthorization.authorizationId,
    authorizationFingerprint: armAuthorization.authorizationFingerprint,
  });
  await operations.arm(armament);
  const walletSnapshot = await risk.appendWalletSnapshot(Object.freeze({
    snapshotId: `execution_wallet_snapshot_${'d'.repeat(64)}`,
    payloadVersion: 1 as const, snapshotFingerprint: 'd'.repeat(64), generationId,
    providerId: 'primary', stateRevision: 0n, slot: 123n, blockTimeMs: nowMs - 100,
    observedAtMs: nowMs - 50, commitment: 'finalized' as const,
    walletLamports: 1_000_000n, tokenBalanceCount: 0,
    openPositions: Object.freeze([]), realizedNetPnlRaw: 0n,
  }));
  const providerSnapshot = createProviderUsageSnapshot({
    providerId: 'primary', planId: 'public-v1', billingPeriodId: `period-${nowMs}`,
    billingPeriodStartedAtMs: nowMs - 1_000, billingPeriodEndsAtMs: nowMs + 300_000,
    limitUnits: 10_000n, usedUnits: 10n, measuredAtMs: nowMs - 100,
    expiresAtMs: nowMs + 60_000, provenance: 'AUTHORITATIVE_PROBE',
  });
  await risk.appendProviderUsage(providerSnapshot);
  const intents = new PostgresExecutionIntentRepository(pool);
  const created = await intents.create(createExecutionIntentDraft({
    strategyId: 'sell-reconciliation-test', strategyVersion: 1,
    positionId: `position:${randomUUID()}`, logicalCommandId: `command:${randomUUID()}`,
    mint: walletPublicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint,
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9, quoteAmountRaw: 1_000n,
    baseAmountRaw: null, minimumAmountOutRaw: 90n,
    decisionEventId: `decision:${randomUUID()}`, decisionFingerprint: fingerprint,
    requestedAtMs: nowMs, expiresAtMs: nowMs + 120_000,
  }));
  const policy = createExecutionRiskPolicy({
    quoteMintAllowlist: [quoteMint], initialCapitalLamports: 1_000_000n,
    maximumCapitalLamports: 1_000_000n, positionSizeBps: 1_000n,
    maximumOpenPositions: 1, maximumTotalExposureBps: 500n, drawdownPauseBps: 2_500n,
    feeReserveLamports: 100_000n, walletSnapshotMaxAgeMs: 60_000,
    providerUsageMaxAgeMs: 300_000, providerEntryCostUnits: 8n,
    providerExitCostUnitsPerPosition: 4n, providerConfirmationCostUnitsPerPosition: 2n,
    providerReconciliationCostUnitsPerPosition: 3n, providerSafetyMarginUnits: 5n,
    maximumConsecutiveTechnicalFailures: 2,
  });
  const admitted = await new ExecutionAdmissionService(risk).admit({
    payloadVersion: 1, intent: created.intent, policy, generationId,
    walletSnapshot, providerSnapshot, allEndpointsUnavailable: false, nowMs,
  });
  assert.equal(admitted.decision, 'ADMITTED');
  assert.ok(admitted.reservationId);
  const claimed = await intents.claim({
    ownerId: 'buy-reconciliation-test', leaseMs: 60_000, purpose: 'EXECUTE',
  });
  assert.ok(claimed);
  const processing = await intents.transition(claimed, {
    intentId: claimed.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
    leaseToken: claimed.leaseToken, reasonCode: 'EXECUTION_STARTED',
    humanMessage: 'Prepare the canary BUY.', activationPhase: 'CANARY',
    evidence: Object.freeze({
      payloadVersion: 1, attemptNumber: null, sourceEventId: null, observedAtMs: nowMs,
    }),
  });
  const begun = await intents.beginAttempt(Object.freeze({ ...claimed, intent: processing }));
  const artifact = createSignedTransactionArtifact({
    payloadVersion: 1, specificationVersion: 1, intentId: begun.claim.intent.id,
    attemptNumber: begun.attempt.attemptNumber, generationId,
    armamentId: armament.armamentId, reservationId: admitted.reservationId,
    exitAuthorizationId: null, providerId: 'primary',
    walletPublicKey, side: 'BUY', effectiveVenue: 'PUMP_FUN', messageHash: '4'.repeat(64),
    buildFingerprint: '5'.repeat(64), snapshotFingerprint: 'd'.repeat(64),
    quoteFingerprint: '7'.repeat(64), quoteObservedAtMs: nowMs,
    quoteExpiresAtMs: nowMs + 60_000, blockhash: walletPublicKey,
    lastValidBlockHeight: 1_000n, signature: bs58.encode(new Uint8Array(64).fill(8)),
    signedTransactionBytes: Uint8Array.from([1, 2, 3, 4]), signedAtMs: nowMs + 4,
  });
  const unsignedSimulation = Object.freeze({
    outcome: 'SUCCESS' as const, snapshotFingerprint: artifact.snapshotFingerprint,
    buildFingerprint: artifact.buildFingerprint, messageHash: artifact.messageHash,
    blockhash: artifact.blockhash, lastValidBlockHeight: artifact.lastValidBlockHeight,
    blockhashContextSlot: 124n, feeContextSlot: 124n, estimatedFeeLamports: 5_000n,
    simulationSlot: 125n, simulatedFeePayerLamportDebit: 5_000n, unitsConsumed: 25_000n,
    simulatedBaseDeltaRaw: 100n, simulatedQuoteDeltaRaw: -1_000n,
    logsFingerprint: '8'.repeat(64), logsLineCount: 1,
  });
  const runtime = Object.freeze({
    payloadVersion: 1 as const, phase: 'CANARY' as const, buildHash: fingerprint,
    configurationFingerprint: simulation.configurationFingerprint,
    strategyFingerprint: '3'.repeat(64), walletPublicKey,
    cluster: 'mainnet-beta' as const, expectedGenesisHash: walletPublicKey,
    observedGenesisHash: walletPublicKey, providerId: 'primary',
  });
  return {
    claim: begun.claim, artifact, unsignedSimulation, runtime,
    qualificationId: qualification.qualificationId, reservationId: admitted.reservationId,
  };
}

function safetyQualification(
  nowMs: number,
  simulation: Awaited<ReturnType<typeof seedSuccessfulSimulation>>,
) {
  const evidenceTypes = [
    'CI_RUN', 'MIGRATION_TEST', 'ARCHITECTURE_TEST', 'DRY_RUN_TEST',
    'SIMULATION_ARTIFACT', 'FAULT_TEST', 'RECONCILIATION_STATE',
    'PROVIDER_SNAPSHOT', 'STOP_CONTROL_TEST', 'WALLET_SNAPSHOT',
    'MAINNET_SIMULATION_ARTIFACT',
  ] as const;
  return createSafetyQualification({
    payloadVersion: 1, evaluatorVersion: 1, phase: 'CANARY', buildHash: fingerprint,
    configurationFingerprint: simulation.configurationFingerprint,
    strategyFingerprint: '3'.repeat(64), generationId, walletPublicKey,
    cluster: 'mainnet-beta', genesisHash: walletPublicKey, providerId: 'primary',
    qualifiedAtMs: nowMs, expiresAtMs: nowMs + 300_000,
    gates: EXECUTION_SAFETY_GATE_IDS.map((gateId, index) => ({
      payloadVersion: 1, gateId, status: 'PASSED', evidenceType: evidenceTypes[index],
      evidenceId: gateId === 'MAINNET_PREFLIGHT_SIMULATED'
        ? simulation.artifactId : `evidence:${index}`,
      evidenceFingerprint: gateId === 'MAINNET_PREFLIGHT_SIMULATED'
        ? createMainnetSimulationEvidenceFingerprint({
          artifactId: simulation.artifactId, resultFingerprint: simulation.resultFingerprint,
          buildHash: fingerprint, configurationFingerprint: simulation.configurationFingerprint,
          strategyFingerprint: '3'.repeat(64), walletPublicKey,
          genesisHash: walletPublicKey, providerId: 'primary',
        }) : index.toString(16).repeat(64),
      observedAtMs: gateId === 'MAINNET_PREFLIGHT_SIMULATED'
        ? simulation.recordedAtMs : nowMs - 1_000 + index,
      expiresAtMs: nowMs + 300_000,
    })),
  });
}

async function seedSuccessfulSimulation(pool: InstanceType<typeof pg.Pool>) {
  const nowMs = Date.now();
  const intents = new PostgresExecutionIntentRepository(pool);
  const created = await intents.create(createExecutionIntentDraft({
    strategyId: 'simulation-strategy', strategyVersion: 1,
    positionId: `position-${randomUUID()}`, logicalCommandId: `command-${randomUUID()}`,
    mint: walletPublicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint,
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9, quoteAmountRaw: 1_000n,
    baseAmountRaw: null, minimumAmountOutRaw: 850n,
    decisionEventId: `event-${randomUUID()}`, decisionFingerprint: fingerprint,
    requestedAtMs: nowMs, expiresAtMs: nowMs + 120_000,
  }));
  const claimed = await intents.claim({
    ownerId: 'preflight-sell-test', leaseMs: 30_000, purpose: 'EXECUTE',
  });
  assert.ok(claimed);
  const processing = await intents.transition(claimed, {
    intentId: created.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
    leaseToken: claimed.leaseToken, reasonCode: 'EXECUTION_STARTED',
    humanMessage: 'Execution simulation started.', activationPhase: 'NONE',
    evidence: Object.freeze({
      payloadVersion: 1, attemptNumber: null, sourceEventId: null, observedAtMs: nowMs,
    }),
  });
  const begun = await intents.beginAttempt(Object.freeze({ ...claimed, intent: processing }));
  const draft = createExecutionSimulationArtifactDraft({
    intentId: begun.claim.intent.id, attemptNumber: begun.attempt.attemptNumber,
    intentStateRevision: begun.claim.intent.stateRevision,
    strategyId: begun.claim.intent.strategyId, strategyVersion: begun.claim.intent.strategyVersion,
    decisionFingerprint: begun.claim.intent.decisionFingerprint,
    resultKind: 'SUCCESS', effectiveVenue: 'PUMP_FUN', providerId: 'primary',
    executorPublicKey: walletPublicKey, expectedGenesisHash: walletPublicKey,
    observedGenesisHash: walletPublicKey, configurationFingerprint: fingerprint,
    quoteFingerprint: fingerprint, snapshotFingerprint: fingerprint,
    buildFingerprint: fingerprint, messageHash: fingerprint, blockhash: walletPublicKey,
    lastValidBlockHeight: 1_000n, blockhashContextSlot: 900n, snapshotSlot: 899n,
    feeContextSlot: 900n, simulationSlot: 901n, amountInRaw: 1_000n,
    expectedAmountOutRaw: 900n, protectedAmountOutRaw: 850n, feesRaw: 10n,
    estimatedFeeLamports: 5_000n, simulatedFeePayerLamportDebit: 6_000n,
    unitsConsumed: 200_000n, simulatedBaseDeltaRaw: 900n,
    simulatedQuoteDeltaRaw: -1_000n, rpcCallsUsed: 5, rpcCallsLimit: 8,
    quoteStatus: 'SUCCEEDED', buildStatus: 'SUCCEEDED', simulationStatus: 'SUCCEEDED',
    failureStage: null, failureCode: null, terminalReasonCode: 'INTENT_SUCCEEDED',
    logsFingerprint: fingerprint, logsLineCount: 1,
  });
  return new PostgresExecutionSimulationRepository(pool)
    .complete(begun.claim, draft, new AbortController().signal);
}

function requiredDatabaseUrl(context: TestContext): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: SELL reconciliation integration skipped');
    return null;
  }
  return databaseUrl;
}

async function claimSellReconciliation(
  pool: InstanceType<typeof pg.Pool>,
  ownerId: string,
) {
  const claim = await new PostgresExecutionIntentRepository(pool).claim({
    ownerId,
    leaseMs: 60_000,
    purpose: 'RECONCILE',
  });
  assert.ok(claim);
  return claim;
}

async function waitForDatabaseQuery(
  pool: InstanceType<typeof pg.Pool>,
  pattern: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query(`SELECT 1 FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND state='active' AND wait_event IS NOT NULL
        AND query ILIKE $1 LIMIT 1`, [pattern]);
    if (result.rowCount === 1) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for blocked PostgreSQL query matching ${pattern}.`);
}

async function withTemporarySchema(
  databaseUrl: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `execution_live_sell_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl, max: 4,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    created = true;
    await pool.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await callback(pool);
  } finally {
    try { await pool.end(); } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      } finally { await admin.end(); }
    }
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}
