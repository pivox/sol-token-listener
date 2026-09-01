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
import { createExecutionLiveSignedSimulationEvidence } from
  '../src/domain/execution-live-signed-simulation.js';
import { createExecutionLiveUnsignedSimulationEvidenceIdentity } from
  '../src/domain/execution-live-signed-simulation.js';
import { ExecutionAdmissionService } from '../src/executor-risk/admission-service.js';
import { executeLivePreparedTransaction } from '../src/executor-live/execution-worker.js';
import type {
  ExecutionPreSubmissionRevocationInputV1,
} from '../src/ports/execution-live-repository.js';
import type { ExecutionSimulationEvidenceV1 } from
  '../src/ports/execution-simulation-gateway.js';
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

type RevocableSignedState = 'PERSISTED' | 'SIGNED_SIMULATED';
for (const initialState of ['PERSISTED', 'SIGNED_SIMULATED'] as const) {
  void test(`BUY ${initialState} is atomically revoked without send and releases every capability`,
    async (context) => {
      const databaseUrl = requiredDatabaseUrl(context);
      if (databaseUrl === null) return;
      await withTemporarySchema(databaseUrl, async (pool) => {
        const fixture = await createPersistedBuyFixture(pool, initialState);
        const beforeRevocation = await fixture.live.inspectSignedTransaction({
          claim: fixture.claim, artifactId: fixture.artifact.artifactId,
        });
        assert.ok(beforeRevocation);
        assert.equal(beforeRevocation.state, initialState);
        assert.equal('artifact' in beforeRevocation, true);
        const result = await fixture.live.revokeBeforeSubmission(
          revocationCommand(fixture, initialState, '6'.repeat(64)),
        );

        assert.deepEqual(result, {
          payloadVersion: 1, kind: 'REVOKED', artifactState: 'REVOKED_NO_SEND',
        });
        const inspected = await fixture.live.inspectSignedTransaction({
          claim: fixture.claim, artifactId: fixture.artifact.artifactId,
        });
        assert.ok(inspected);
        assert.equal(inspected.state, 'REVOKED_NO_SEND');
        assert.equal('artifact' in inspected, false);
        assert.deepEqual(await durableBuyState(pool, fixture), {
          artifact_state: 'REVOKED_NO_SEND',
          artifact_revision: initialState === 'PERSISTED' ? '1' : '2',
          intent_status: 'FAILED', intent_reason: 'PRE_SUBMISSION_REVOKED_NO_SEND',
          attempt_status: 'ABANDONED', attempt_reason: 'PRE_SUBMISSION_REVOKED_NO_SEND',
          reservation_state: 'RELEASED', armament_state: 'REVOKED',
          reserved_exposure_raw: '0', open_positions: 0,
          position_count: 0, exit_authorization_count: 0,
          event_previous_state: initialState, event_next_state: 'REVOKED_NO_SEND',
          event_reason_code: 'PRE_SUBMISSION_REVOKED_NO_SEND', purge_scheduled: true,
        });
      });
    });
}

void test('worker restart durably routes SUBMISSION_STARTED to ambiguity without RPC send',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createBuyAtSubmissionState(pool, 'SUBMISSION_STARTED');
      let simulationCalls = 0;
      let submissionCalls = 0;

      const result = await executeLivePreparedTransaction(Object.freeze({
        repository: fixture.live,
        signedSimulation: Object.freeze({
          simulate: () => {
            simulationCalls += 1;
            return Promise.reject(new Error('signed simulation must not restart'));
          },
        }),
        submission: Object.freeze({
          submitPersisted: () => {
            submissionCalls += 1;
            return Promise.reject(new Error('submission must not restart'));
          },
        }),
        clock: () => Date.now(),
      }), Object.freeze({
        persist: Object.freeze({
          payloadVersion: 1,
          claim: fixture.claim,
          qualificationId: fixture.qualificationId,
          reservationId: fixture.reservationId,
          artifact: fixture.artifact,
          unsignedSimulation: fixture.unsignedSimulation,
        }),
        signedSimulation: Object.freeze({
          payloadVersion: 1,
          snapshotSlot: 123n,
          accountAddresses: Object.freeze([
            walletPublicKey, walletPublicKey, walletPublicKey,
          ] as const),
          amountInRaw: 1_000n,
          protectedAmountOutRaw: 90n,
          unsignedSimulation: fixture.unsignedSimulation,
        }),
        runtime: fixture.runtime,
        blockhashValidity: blockhashValidity(fixture.artifact, Date.now()),
      }), new AbortController().signal);

      assert.equal(result.kind, 'AMBIGUOUS');
      assert.equal(simulationCalls, 0);
      assert.equal(submissionCalls, 0);
      const durable = await pool.query<{
        artifact_state: string;
        intent_status: string;
        unknown_block: boolean;
        unknown_reservation_state: string;
      }>(`SELECT artifact.state AS artifact_state,intent.status AS intent_status,
          risk.unknown_block,reservation.state AS unknown_reservation_state
        FROM execution_signed_transactions artifact
        JOIN execution_intents intent ON intent.id=artifact.intent_id
        JOIN execution_wallet_risk_state risk ON risk.generation_id=artifact.generation_id
        JOIN execution_exposure_reservations reservation
          ON reservation.reservation_id=artifact.reservation_id
        WHERE artifact.artifact_id=$1`, [fixture.artifact.artifactId]);
      assert.deepEqual(durable.rows, [{
        artifact_state: 'AMBIGUOUS',
        intent_status: 'UNKNOWN_REQUIRES_RECONCILIATION',
        unknown_block: true,
        unknown_reservation_state: 'UNKNOWN_HELD',
      }]);
      const inspected = await fixture.live.inspectSignedTransaction({
        claim: fixture.claim, artifactId: fixture.artifact.artifactId,
      });
      assert.ok(inspected);
      assert.equal(inspected.state, 'AMBIGUOUS');
      assert.equal('artifact' in inspected, false);
    });
  });

void test('SELL revocation makes the intent retryable and unlocks the same exit authorization',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createPersistedSellFixture(pool);

      const result = await fixture.live.revokeBeforeSubmission(
        revocationCommand(fixture, 'PERSISTED', '7'.repeat(64)),
      );

      assert.equal(result.kind, 'REVOKED');
      assert.deepEqual(await durableSellState(pool, fixture), {
        artifact_state: 'REVOKED_NO_SEND', intent_status: 'RETRY_READY',
        intent_reason: 'PRE_SUBMISSION_REVOKED_NO_SEND', attempt_status: 'ABANDONED',
        attempt_reason: 'PRE_SUBMISSION_REVOKED_NO_SEND', position_state: 'EXIT_PENDING',
        exit_intent_id: fixture.claim.intent.id, authorization_state: 'ACTIVE',
        locked_intent_id: null, locked_attempt_number: null, armament_state: 'LOCKED',
        reservation_state: 'CONSUMED', reserved_exposure_raw: '1000', open_positions: 1,
      });
    });
  });

void test('SELL final gate rejects a runtime binding with undeclared fields', async (context) => {
  const databaseUrl = requiredDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    const fixture = await createPersistedSellFixture(pool);
    await fixture.live.recordSignedSimulation(fixture.claim, signedSimulation(
      fixture.artifact, fixture.unsignedSimulation,
      -95n, 800n, fixture.artifact.signedAtMs + 1,
    ));

    await assert.rejects(fixture.live.beginSubmission({
      claim: fixture.claim,
      artifactId: fixture.artifact.artifactId,
      expectedRevision: 1n,
      runtime: Object.freeze({ ...fixture.runtime, undeclaredCapability: 'submit' }),
      blockhashValidity: blockhashValidity(fixture.artifact, Date.now()),
    }), isLiveRepositoryError('INVALID_INPUT'));
    const inspected = await fixture.live.inspectSignedTransaction({
      claim: fixture.claim, artifactId: fixture.artifact.artifactId,
    });
    assert.ok(inspected);
    assert.equal(inspected.state, 'SIGNED_SIMULATED');
  });
});

void test('exact revocation replay is idempotent and a conflicting cause is rejected',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createPersistedBuyFixture(pool, 'PERSISTED');
      const repository = fixture.live;
      const command = revocationCommand(fixture, 'PERSISTED', '8'.repeat(64));

      assert.equal((await repository.revokeBeforeSubmission(command)).kind, 'REVOKED');
      assert.equal((await repository.revokeBeforeSubmission(command)).kind, 'REPLAYED');
      await assert.rejects(repository.revokeBeforeSubmission({
        ...command, causeReasonCode: 'PRE_SUBMISSION_GATES_FAILED',
      }), isLiveRepositoryError('CONFLICT'));

      const events = await pool.query<{ count: number }>(`SELECT COUNT(*)::INTEGER AS count
        FROM execution_submission_events WHERE artifact_id=$1
          AND next_state='REVOKED_NO_SEND'`, [fixture.artifact.artifactId]);
      assert.equal(events.rows[0]?.count, 1);
    });
  });

void test('concurrent identical revocations serialize to one mutation and one replay',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createPersistedBuyFixture(pool, 'SIGNED_SIMULATED');
      const repository = fixture.live;
      const command = revocationCommand(fixture, 'SIGNED_SIMULATED', '9'.repeat(64));

      const results = await Promise.all([
        repository.revokeBeforeSubmission(command),
        repository.revokeBeforeSubmission(command),
      ]);

      assert.deepEqual(results.map(({ kind }) => kind).sort(), ['REPLAYED', 'REVOKED']);
      const state = await pool.query<{ artifact_state: string; event_count: number }>(`SELECT
        artifact.state AS artifact_state,
        (SELECT COUNT(*)::INTEGER FROM execution_submission_events event
          WHERE event.artifact_id=artifact.artifact_id
            AND event.next_state='REVOKED_NO_SEND') AS event_count
        FROM execution_signed_transactions artifact WHERE artifact.artifact_id=$1`, [
        fixture.artifact.artifactId,
      ]);
      assert.deepEqual(state.rows, [{ artifact_state: 'REVOKED_NO_SEND', event_count: 1 }]);
    });
  });

for (const nonRevocableState of ['SUBMISSION_STARTED', 'ACCEPTED', 'AMBIGUOUS'] as const) {
  void test(`revocation refuses ${nonRevocableState} and leaves durable state unchanged`,
    async (context) => {
      const databaseUrl = requiredDatabaseUrl(context);
      if (databaseUrl === null) return;
      await withTemporarySchema(databaseUrl, async (pool) => {
        const fixture = await createBuyAtSubmissionState(pool, nonRevocableState);
        const before = await compactBuySnapshot(pool, fixture.artifact.artifactId);

        await assert.rejects(
          fixture.live.revokeBeforeSubmission({
            payloadVersion: 1, claim: fixture.claim, artifactId: fixture.artifact.artifactId,
            expectedState: 'SIGNED_SIMULATED', expectedRevision: 1n,
            causeReasonCode: 'PRE_SUBMISSION_GATES_FAILED',
            evidenceFingerprint: 'a'.repeat(64), observedAtMs: fixture.artifact.signedAtMs + 10,
          }),
          isLiveRepositoryError('CONFLICT'),
        );

        assert.deepEqual(await compactBuySnapshot(pool, fixture.artifact.artifactId), before);
      });
    });
}

void test('a stale expected state rolls back without partially releasing BUY resources',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await createPersistedBuyFixture(pool, 'PERSISTED');
      const before = await compactBuySnapshot(pool, fixture.artifact.artifactId);

      await assert.rejects(
        fixture.live.revokeBeforeSubmission({
          ...revocationCommand(fixture, 'PERSISTED', 'b'.repeat(64)),
          expectedState: 'SIGNED_SIMULATED', expectedRevision: 1n,
        }),
        isLiveRepositoryError('CONFLICT'),
      );

      assert.deepEqual(await compactBuySnapshot(pool, fixture.artifact.artifactId), before);
    });
  });

function revocationCommand(
  fixture: Pick<Awaited<ReturnType<typeof createBuyFixture>>, 'claim' | 'artifact'>,
  expectedState: RevocableSignedState,
  evidenceFingerprint: string,
): ExecutionPreSubmissionRevocationInputV1 {
  return Object.freeze({
    payloadVersion: 1, claim: fixture.claim, artifactId: fixture.artifact.artifactId,
    expectedState, expectedRevision: expectedState === 'PERSISTED' ? 0n : 1n,
    causeReasonCode: 'SIGNED_SIMULATION_FAILED', evidenceFingerprint,
    observedAtMs: fixture.artifact.signedAtMs + 10,
  });
}

async function createPersistedBuyFixture(
  pool: InstanceType<typeof pg.Pool>,
  state: RevocableSignedState,
) {
  await migrateDatabase({ pool });
  const fixture = await createBuyFixture(pool);
  const live = new PostgresExecutionLiveRepository(pool);
  await live.persistSigned({
    payloadVersion: 1, claim: fixture.claim, qualificationId: fixture.qualificationId,
    reservationId: fixture.reservationId, artifact: fixture.artifact,
    unsignedSimulation: fixture.unsignedSimulation,
  });
  if (state === 'SIGNED_SIMULATED') {
    await live.recordSignedSimulation(fixture.claim, signedSimulation(
      fixture.artifact, fixture.unsignedSimulation,
      95n, -1_000n, fixture.artifact.signedAtMs + 1,
    ));
  }
  return Object.freeze({ ...fixture, live });
}

async function createBuyAtSubmissionState(
  pool: InstanceType<typeof pg.Pool>,
  state: 'SUBMISSION_STARTED' | 'ACCEPTED' | 'AMBIGUOUS',
) {
  const fixture = await createPersistedBuyFixture(pool, 'SIGNED_SIMULATED');
  const started = await fixture.live.beginSubmission({
    claim: fixture.claim, artifactId: fixture.artifact.artifactId, expectedRevision: 1n,
    runtime: fixture.runtime,
    blockhashValidity: blockhashValidity(fixture.artifact, Date.now()),
  });
  if (state !== 'SUBMISSION_STARTED') {
    const outcomeObservedAtMs = Date.now() + 1_000;
    await fixture.live.recordSubmissionOutcome(fixture.claim, {
      payloadVersion: 1, artifactId: fixture.artifact.artifactId,
      expectedRevision: started.stateRevision,
      outcome: state === 'ACCEPTED' ? 'ACCEPTED' : 'AMBIGUOUS',
      returnedSignature: state === 'ACCEPTED' ? fixture.artifact.signature : null,
      reasonCode: state === 'ACCEPTED' ? 'SUBMISSION_ACCEPTED' : 'SUBMISSION_AMBIGUOUS',
      observedAtMs: outcomeObservedAtMs,
    });
  }
  return fixture;
}

async function createPersistedSellFixture(pool: InstanceType<typeof pg.Pool>) {
  await migrateDatabase({ pool });
  const buy = await createBuyFixture(pool);
  const live = new PostgresExecutionLiveRepository(pool);
  await live.persistSigned({
    payloadVersion: 1, claim: buy.claim, qualificationId: buy.qualificationId,
    reservationId: buy.reservationId, artifact: buy.artifact,
    unsignedSimulation: buy.unsignedSimulation,
  });
  await live.recordSignedSimulation(buy.claim, signedSimulation(
    buy.artifact, buy.unsignedSimulation,
    95n, -1_000n, buy.artifact.signedAtMs + 1,
  ));
  const started = await live.beginSubmission({
    claim: buy.claim, artifactId: buy.artifact.artifactId, expectedRevision: 1n,
    runtime: buy.runtime,
    blockhashValidity: blockhashValidity(buy.artifact, Date.now()),
  });
  const submittedAtMs = Date.now() + 1_000;
  await live.recordSubmissionOutcome(buy.claim, {
    payloadVersion: 1, artifactId: buy.artifact.artifactId,
    expectedRevision: started.stateRevision, outcome: 'ACCEPTED',
    returnedSignature: buy.artifact.signature, reasonCode: 'SUBMISSION_ACCEPTED',
    observedAtMs: submittedAtMs,
  });
  const confirmedAtMs = submittedAtMs + 1_000;
  await live.recordConfirmation(buy.claim, {
    payloadVersion: 1, artifactId: buy.artifact.artifactId, expectedRevision: 3n,
    signature: buy.artifact.signature, observedSlot: 126n,
    observedAtMs: confirmedAtMs,
  });
  const entry = await live.commitReconciliation(
    buy.claim,
    buyReconciliation(buy, confirmedAtMs + 1_000),
  );
  assert.ok(entry.position);
  assert.ok(entry.exitAuthorization);
  const exitDeadlineAtMs = await makePositionDue(pool, entry.position.positionId);
  const exit = await live.createDeadlineExitIntent({
    positionId: entry.position.positionId, observedAtMs: exitDeadlineAtMs,
  });
  assert.ok(exit.intent);
  const intents = new PostgresExecutionIntentRepository(pool);
  const claimed = await intents.claim({
    ownerId: 'revocation-sell-test', leaseMs: 60_000, purpose: 'EXECUTE',
  });
  assert.ok(claimed);
  assert.equal(claimed.intent.id, exit.intent.id);
  const processing = await intents.transition(claimed, {
    intentId: claimed.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
    leaseToken: claimed.leaseToken, reasonCode: 'EXECUTION_STARTED',
    humanMessage: 'Prepare a revocable canary SELL.', activationPhase: 'CANARY',
    evidence: Object.freeze({
      payloadVersion: 1, attemptNumber: null, sourceEventId: null,
      observedAtMs: exitDeadlineAtMs,
    }),
  });
  const begun = await intents.beginAttempt(Object.freeze({ ...claimed, intent: processing }));
  const nowMs = Date.now();
  const artifact = createSignedTransactionArtifact({
    payloadVersion: 1, specificationVersion: 1, intentId: begun.claim.intent.id,
    attemptNumber: begun.attempt.attemptNumber, generationId, armamentId: null,
    reservationId: null, exitAuthorizationId: entry.exitAuthorization.authorizationId,
    providerId: 'primary', walletPublicKey, side: 'SELL', effectiveVenue: 'PUMP_FUN',
    messageHash: 'a'.repeat(64), buildFingerprint: 'b'.repeat(64),
    snapshotFingerprint: 'c'.repeat(64), quoteFingerprint: 'e'.repeat(64),
    quoteObservedAtMs: nowMs, quoteExpiresAtMs: nowMs + 60_000,
    blockhash: walletPublicKey, lastValidBlockHeight: 2_000n,
    signature: bs58.encode(new Uint8Array(64).fill(10)),
    signedTransactionBytes: Uint8Array.from([5, 6, 7, 8]), signedAtMs: nowMs + 1,
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
  await live.persistSigned({
    payloadVersion: 1, claim: begun.claim, qualificationId: buy.qualificationId,
    reservationId: null, artifact, unsignedSimulation,
  });
  return Object.freeze({
    live, claim: begun.claim, artifact, positionId: entry.position.positionId,
    authorizationId: entry.exitAuthorization.authorizationId, runtime: buy.runtime,
    unsignedSimulation,
  });
}

function buyReconciliation(
  fixture: Awaited<ReturnType<typeof createBuyFixture>>,
  observedAtMs: number,
) {
  return evaluateExecutionReconciliation({
    expected: Object.freeze({
      intentId: fixture.artifact.intentId, attemptNumber: 1, walletGeneration: 1,
      providerId: fixture.artifact.providerId, side: 'BUY' as const,
      signature: fixture.artifact.signature, blockhash: fixture.artifact.blockhash,
      lastValidBlockHeight: fixture.artifact.lastValidBlockHeight,
      messageHash: fixture.artifact.messageHash,
      buildFingerprint: fixture.artifact.buildFingerprint,
      snapshotFingerprint: fixture.artifact.snapshotFingerprint,
      maximumFeeLamports: fixture.unsignedSimulation.estimatedFeeLamports,
      maximumFeePayerLamportDebit: fixture.unsignedSimulation.simulatedFeePayerLamportDebit,
    }),
    observed: Object.freeze({
      signatureHistory: 'PRESENT' as const, confirmationStatus: 'FINALIZED' as const,
      finalizedBlockHeight: 1_001n, observedSlot: 127n,
      transaction: Object.freeze({
        signature: fixture.artifact.signature, blockhash: fixture.artifact.blockhash,
        messageHash: fixture.artifact.messageHash,
        buildFingerprint: fixture.artifact.buildFingerprint,
        snapshotFingerprint: fixture.artifact.snapshotFingerprint,
      }),
      feeLamports: 5_000n, walletLamportDelta: -5_000n,
      baseDeltaRaw: 95n, quoteDeltaRaw: -1_000n,
      unexpectedResidualTokenBalanceRaw: 0n,
      observedAtMs, finalizedAtMs: observedAtMs + 1_000,
    }),
  });
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

async function durableBuyState(
  pool: InstanceType<typeof pg.Pool>,
  fixture: Awaited<ReturnType<typeof createPersistedBuyFixture>>,
) {
  const result = await pool.query<DurableBuyState>(`SELECT
    artifact.state AS artifact_state,artifact.state_revision::TEXT AS artifact_revision,
    intent.status AS intent_status,intent.last_reason_code AS intent_reason,
    attempt.status AS attempt_status,attempt.reason_code AS attempt_reason,
    reservation.state AS reservation_state,armament.state AS armament_state,
    risk.reserved_exposure_raw::TEXT AS reserved_exposure_raw,risk.open_positions,
    (SELECT COUNT(*)::INTEGER FROM execution_live_positions position
      WHERE position.buy_intent_id=intent.id) AS position_count,
    (SELECT COUNT(*)::INTEGER FROM execution_exit_authorizations exit_auth
      JOIN execution_live_positions position ON position.position_id=exit_auth.position_id
      WHERE position.buy_intent_id=intent.id) AS exit_authorization_count,
    event.previous_state AS event_previous_state,event.next_state AS event_next_state,
    event.reason_code AS event_reason_code,(artifact.purge_after IS NOT NULL) AS purge_scheduled
    FROM execution_signed_transactions artifact
    JOIN execution_intents intent ON intent.id=artifact.intent_id
    JOIN execution_attempts attempt ON attempt.intent_id=artifact.intent_id
      AND attempt.attempt_number=artifact.attempt_number
    JOIN execution_exposure_reservations reservation
      ON reservation.reservation_id=artifact.reservation_id
    JOIN execution_activation_armaments armament ON armament.armament_id=artifact.armament_id
    JOIN execution_wallet_risk_state risk ON risk.generation_id=artifact.generation_id
    JOIN execution_submission_events event ON event.artifact_id=artifact.artifact_id
      AND event.next_state='REVOKED_NO_SEND'
    WHERE artifact.artifact_id=$1`, [fixture.artifact.artifactId]);
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

interface DurableBuyState {
  readonly artifact_state: string;
  readonly artifact_revision: string;
  readonly intent_status: string;
  readonly intent_reason: string | null;
  readonly attempt_status: string;
  readonly attempt_reason: string | null;
  readonly reservation_state: string;
  readonly armament_state: string;
  readonly reserved_exposure_raw: string;
  readonly open_positions: number;
  readonly position_count: number;
  readonly exit_authorization_count: number;
  readonly event_previous_state: string | null;
  readonly event_next_state: string;
  readonly event_reason_code: string;
  readonly purge_scheduled: boolean;
}

async function durableSellState(
  pool: InstanceType<typeof pg.Pool>,
  fixture: Awaited<ReturnType<typeof createPersistedSellFixture>>,
) {
  const result = await pool.query<DurableSellState>(`SELECT
    artifact.state AS artifact_state,intent.status AS intent_status,
    intent.last_reason_code AS intent_reason,attempt.status AS attempt_status,
    attempt.reason_code AS attempt_reason,position.state AS position_state,
    position.exit_intent_id,exit_auth.state AS authorization_state,
    exit_auth.locked_intent_id,exit_auth.locked_attempt_number,
    armament.state AS armament_state,reservation.state AS reservation_state,
    risk.reserved_exposure_raw::TEXT AS reserved_exposure_raw,risk.open_positions
    FROM execution_signed_transactions artifact
    JOIN execution_intents intent ON intent.id=artifact.intent_id
    JOIN execution_attempts attempt ON attempt.intent_id=artifact.intent_id
      AND attempt.attempt_number=artifact.attempt_number
    JOIN execution_exit_authorizations exit_auth
      ON exit_auth.authorization_id=artifact.exit_authorization_id
    JOIN execution_live_positions position ON position.position_id=exit_auth.position_id
    JOIN execution_activation_armaments armament ON armament.armament_id=position.armament_id
    JOIN execution_exposure_reservations reservation
      ON reservation.intent_id=position.buy_intent_id
    JOIN execution_wallet_risk_state risk ON risk.generation_id=artifact.generation_id
    WHERE artifact.artifact_id=$1`, [fixture.artifact.artifactId]);
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

interface DurableSellState {
  readonly artifact_state: string;
  readonly intent_status: string;
  readonly intent_reason: string | null;
  readonly attempt_status: string;
  readonly attempt_reason: string | null;
  readonly position_state: string;
  readonly exit_intent_id: string;
  readonly authorization_state: string;
  readonly locked_intent_id: string | null;
  readonly locked_attempt_number: number | null;
  readonly armament_state: string;
  readonly reservation_state: string;
  readonly reserved_exposure_raw: string;
  readonly open_positions: number;
}

async function compactBuySnapshot(
  pool: InstanceType<typeof pg.Pool>,
  artifactId: string,
) {
  const result = await pool.query<CompactBuySnapshot>(`SELECT
    artifact.state AS artifact_state,artifact.state_revision::TEXT AS artifact_revision,
    intent.status AS intent_status,intent.state_revision::TEXT AS intent_revision,
    attempt.status AS attempt_status,reservation.state AS reservation_state,
    armament.state AS armament_state,
    risk.reserved_exposure_raw::TEXT AS reserved_exposure_raw,
    risk.state_revision::TEXT AS risk_revision,
    (SELECT COUNT(*)::INTEGER FROM execution_submission_events event
      WHERE event.artifact_id=artifact.artifact_id) AS event_count
    FROM execution_signed_transactions artifact
    JOIN execution_intents intent ON intent.id=artifact.intent_id
    JOIN execution_attempts attempt ON attempt.intent_id=artifact.intent_id
      AND attempt.attempt_number=artifact.attempt_number
    JOIN execution_exposure_reservations reservation
      ON reservation.reservation_id=artifact.reservation_id
    JOIN execution_activation_armaments armament ON armament.armament_id=artifact.armament_id
    JOIN execution_wallet_risk_state risk ON risk.generation_id=artifact.generation_id
    WHERE artifact.artifact_id=$1`, [artifactId]);
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

interface CompactBuySnapshot {
  readonly artifact_state: string;
  readonly artifact_revision: string;
  readonly intent_status: string;
  readonly intent_revision: string;
  readonly attempt_status: string;
  readonly reservation_state: string;
  readonly armament_state: string;
  readonly reserved_exposure_raw: string;
  readonly risk_revision: string;
  readonly event_count: number;
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
    strategyId: 'revocation-contract-test', strategyVersion: 1,
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
    ownerId: 'revocation-buy-test', leaseMs: 60_000, purpose: 'EXECUTE',
  });
  assert.ok(claimed);
  assert.equal(claimed.intent.id, created.intent.id);
  const processing = await intents.transition(claimed, {
    intentId: claimed.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
    leaseToken: claimed.leaseToken, reasonCode: 'EXECUTION_STARTED',
    humanMessage: 'Prepare a revocable canary BUY.', activationPhase: 'CANARY',
    evidence: Object.freeze({
      payloadVersion: 1, attemptNumber: null, sourceEventId: null, observedAtMs: nowMs,
    }),
  });
  const begun = await intents.beginAttempt(Object.freeze({ ...claimed, intent: processing }));
  const artifact = createSignedTransactionArtifact({
    payloadVersion: 1, specificationVersion: 1, intentId: begun.claim.intent.id,
    attemptNumber: begun.attempt.attemptNumber, generationId,
    armamentId: armament.armamentId, reservationId: admitted.reservationId,
    exitAuthorizationId: null, providerId: 'primary', walletPublicKey,
    side: 'BUY', effectiveVenue: 'PUMP_FUN', messageHash: '4'.repeat(64),
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
  return Object.freeze({
    claim: begun.claim, artifact, unsignedSimulation, runtime,
    qualificationId: qualification.qualificationId, reservationId: admitted.reservationId,
  });
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
    ownerId: 'revocation-preflight-test', leaseMs: 30_000, purpose: 'EXECUTE',
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
    context.skip('TEST_DATABASE_URL absent: pre-submission revocation integration skipped');
    return null;
  }
  return databaseUrl;
}

async function withTemporarySchema(
  databaseUrl: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `execution_live_revocation_${randomUUID().replaceAll('-', '')}`;
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

function isLiveRepositoryError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ExecutionLiveRepositoryError && error.code === code;
}
