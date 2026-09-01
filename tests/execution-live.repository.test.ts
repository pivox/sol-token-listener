import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import pg from 'pg';
import {
  createExecutionArmament,
  createOperatorAuthorization,
} from '../src/domain/execution-operations.js';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { createProviderUsageSnapshot } from '../src/domain/execution-provider-quota.js';
import { createExecutionRiskPolicy } from '../src/domain/execution-risk-policy.js';
import {
  createMainnetSimulationEvidenceFingerprint,
  createSafetyQualification,
  EXECUTION_SAFETY_GATE_IDS,
} from '../src/domain/execution-safety-qualification.js';
import { createExecutionSimulationArtifactDraft } from '../src/domain/execution-simulation.js';
import { evaluateExecutionReconciliation } from '../src/domain/execution-reconciliation.js';
import { createSignedTransactionArtifact } from '../src/domain/execution-live.js';
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

function submissionPreflight(artifact: ReturnType<typeof createSignedTransactionArtifact>) {
  return Object.freeze({
    runtime: Object.freeze({
      payloadVersion: 1 as const, phase: 'CANARY' as const,
      buildHash: fingerprint, configurationFingerprint: fingerprint,
      strategyFingerprint: '3'.repeat(64), walletPublicKey,
      cluster: 'mainnet-beta' as const, expectedGenesisHash: walletPublicKey,
      observedGenesisHash: walletPublicKey, providerId: 'primary',
    }),
    blockhashValidity: Object.freeze({
      payloadVersion: 1 as const, providerId: artifact.providerId,
      blockhash: artifact.blockhash, valid: true as const,
      observedBlockHeight: artifact.lastValidBlockHeight - 1n,
      contextSlot: 127n, observedAtMs: Date.now(),
    }),
  });
}

function signedSimulationEvidence(
  artifact: ReturnType<typeof createSignedTransactionArtifact>,
  unsignedSimulation: ExecutionSimulationEvidenceV1,
  metrics: Readonly<{
    simulationSlot: bigint;
    unitsConsumed: bigint;
    feePayerLamportDebit: bigint;
    baseDeltaRaw: bigint;
    quoteDeltaRaw: bigint;
    observedAtMs: number;
  }>,
  providerId = artifact.providerId,
) {
  return createExecutionLiveSignedSimulationEvidence({
    payloadVersion: 1,
    artifactId: artifact.artifactId,
    unsignedSimulationEvidenceId: createExecutionLiveUnsignedSimulationEvidenceIdentity(
      artifact, unsignedSimulation,
    ).evidenceId,
    signedTransactionHash: artifact.signedTransactionHash,
    providerId,
    ...metrics,
    logsFingerprint: '9'.repeat(64),
    logsLineCount: 1,
  });
}

void test('concurrent BUY persistence locks one armament and replays exact bytes', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live repository integration skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, async (pool) => {
    const fixture = await liveFixture(pool);
    const repository = new PostgresExecutionLiveRepository(pool);
    const input = Object.freeze({
      payloadVersion: 1 as const,
      claim: fixture.claim,
      qualificationId: fixture.qualificationId,
      reservationId: fixture.reservationId,
      artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
    });

    const persisted = await Promise.all([
      repository.persistSigned(input),
      repository.persistSigned(input),
    ]);

    assert.deepEqual(persisted, [fixture.artifact, fixture.artifact]);
    const state = await pool.query(`SELECT
      (SELECT state FROM execution_activation_armaments WHERE armament_id=$1) AS armament_state,
      (SELECT consumed_buys FROM execution_activation_armaments WHERE armament_id=$1) AS consumed_buys,
      (SELECT status FROM execution_intents WHERE id=$2) AS intent_status,
      (SELECT reconciliation_signature FROM execution_attempts
        WHERE intent_id=$2 AND attempt_number=1) AS reconciliation_signature,
      (SELECT COUNT(*)::INTEGER FROM execution_signed_transactions) AS artifacts,
      (SELECT COUNT(*)::INTEGER FROM execution_submission_events) AS submission_events`, [
      fixture.armamentId, fixture.claim.intent.id,
    ]);
    assert.deepEqual(state.rows, [{
      armament_state: 'LOCKED', consumed_buys: 1,
      intent_status: 'SIGNED_NOT_SUBMITTED', artifacts: 1, submission_events: 1,
      reconciliation_signature: fixture.artifact.signature,
    }]);
    const authenticated = await repository.authenticatePersistedSignedTransaction({
      claim: fixture.claim, artifactId: fixture.artifact.artifactId,
    });
    assert.equal(authenticated.state, 'PERSISTED');
    assert.deepEqual(authenticated.artifact.signedTransactionBytes,
      fixture.artifact.signedTransactionBytes);
    const recovered = await repository.inspectSignedTransaction({ claim: fixture.claim });
    assert.equal(recovered?.state, 'PERSISTED');
    assert.ok(recovered !== null && 'artifact' in recovered);
    assert.equal(recovered.artifact.artifactId, fixture.artifact.artifactId);
    assert.deepEqual(recovered.unsignedSimulation, fixture.unsignedSimulation);
    const signedEvidenceMetrics = Object.freeze({
      simulationSlot: 126n, unitsConsumed: 26_000n,
      feePayerLamportDebit: 5_500n, baseDeltaRaw: 95n, quoteDeltaRaw: -1_000n,
      observedAtMs: fixture.artifact.signedAtMs + 1,
    });
    await assert.rejects(repository.recordSignedSimulation(
      fixture.claim,
      signedSimulationEvidence(
        fixture.artifact, fixture.unsignedSimulation, signedEvidenceMetrics, 'secondary',
      ),
    ), isLiveRepositoryError('CONFLICT'));
    const rejectedEvidence = await pool.query(`SELECT
      (SELECT state FROM execution_signed_transactions WHERE artifact_id=$1) AS state,
      (SELECT COUNT(*)::INTEGER FROM execution_signed_simulation_evidence
        WHERE artifact_id=$1) AS evidence_count`, [fixture.artifact.artifactId]);
    assert.deepEqual(rejectedEvidence.rows, [{ state: 'PERSISTED', evidence_count: 0 }]);
    const signedEvidence = signedSimulationEvidence(
      fixture.artifact, fixture.unsignedSimulation, signedEvidenceMetrics,
    );
    const signedSimulation = await repository.recordSignedSimulation(
      fixture.claim, signedEvidence,
    );
    assert.equal(signedSimulation.state, 'SIGNED_SIMULATED');
    assert.equal(signedSimulation.stateRevision, 1n);
    assert.deepEqual(
      await repository.recordSignedSimulation(fixture.claim, signedEvidence),
      signedSimulation,
    );
    const durableEvidence = await pool.query(`SELECT evidence_fingerprint,
      unsigned_simulation_evidence_id,provider_id,logs_fingerprint,logs_line_count,
      COUNT(*) OVER ()::INTEGER AS evidence_count
      FROM execution_signed_simulation_evidence WHERE artifact_id=$1`, [
      fixture.artifact.artifactId,
    ]);
    assert.deepEqual(durableEvidence.rows, [{
      evidence_fingerprint: signedEvidence.evidenceFingerprint,
      unsigned_simulation_evidence_id: signedEvidence.unsignedSimulationEvidenceId,
      provider_id: 'primary', logs_fingerprint: '9'.repeat(64), logs_line_count: 1,
      evidence_count: 1,
    }]);
    for (const table of [
      'execution_live_unsigned_simulation_evidence',
      'execution_signed_simulation_evidence',
    ]) {
      await assert.rejects(
        pool.query(`UPDATE ${table} SET evidence_fingerprint=$2 WHERE artifact_id=$1`, [
          fixture.artifact.artifactId, 'f'.repeat(64),
        ]),
        (error: unknown) => typeof error === 'object' && error !== null
          && 'code' in error && error.code === '55000',
      );
    }
    const submissionStarted = await repository.beginSubmission({
      claim: fixture.claim,
      artifactId: fixture.artifact.artifactId,
      expectedRevision: signedSimulation.stateRevision,
      ...submissionPreflight(fixture.artifact),
    });
    assert.equal(submissionStarted.state, 'SUBMISSION_STARTED');
    assert.equal(submissionStarted.stateRevision, 2n);
    const preflight = await pool.query(`SELECT artifact_id,reservation_id,phase,
      admission_risk_revision::TEXT AS admission_risk_revision,
      risk_revision::TEXT AS risk_revision,
      admission_drawdown_raw::TEXT AS admission_drawdown_raw,
      conservative_drawdown_raw::TEXT AS conservative_drawdown_raw,
      admission_provider_local_usage_units::TEXT AS admission_provider_local_usage_units,
      provider_local_usage_units::TEXT AS provider_local_usage_units,
      admission_provider_rate_limit_count::TEXT AS admission_provider_rate_limit_count,
      provider_rate_limit_count::TEXT AS provider_rate_limit_count,
      observed_block_height::TEXT AS observed_block_height
      FROM execution_submission_preflight_evidence WHERE artifact_id=$1`, [
      fixture.artifact.artifactId,
    ]);
    assert.deepEqual(preflight.rows, [{
      artifact_id: fixture.artifact.artifactId,
      reservation_id: fixture.reservationId,
      phase: 'CANARY',
      admission_risk_revision: '1', risk_revision: '1',
      admission_drawdown_raw: '0', conservative_drawdown_raw: '0',
      admission_provider_local_usage_units: '8', provider_local_usage_units: '8',
      admission_provider_rate_limit_count: '0', provider_rate_limit_count: '0',
      observed_block_height: '999',
    }]);
    await assert.rejects(pool.query(`UPDATE execution_submission_preflight_evidence
      SET authorized_at=authorized_at WHERE artifact_id=$1`, [fixture.artifact.artifactId]),
    (error: unknown) => databaseErrorCode(error) === '55000');
    await assert.rejects(pool.query(`UPDATE execution_risk_admission_reports
      SET risk_state_revision_baseline=risk_state_revision_baseline+1
      WHERE intent_id=$1`, [fixture.claim.intent.id]),
    (error: unknown) => databaseErrorCode(error) === '55000');
    await repository.recordSubmissionOutcome(fixture.claim, Object.freeze({
      payloadVersion: 1,
      artifactId: fixture.artifact.artifactId,
      expectedRevision: submissionStarted.stateRevision,
      outcome: 'ACCEPTED',
      returnedSignature: fixture.artifact.signature,
      reasonCode: 'SUBMISSION_ACCEPTED',
      observedAtMs: Date.now() + 1_000,
    }));
    const accepted = await pool.query(`SELECT
      (SELECT state FROM execution_signed_transactions WHERE artifact_id=$1) AS artifact_state,
      (SELECT state_revision::TEXT FROM execution_signed_transactions
        WHERE artifact_id=$1) AS artifact_revision,
      (SELECT status FROM execution_intents WHERE id=$2) AS intent_status,
      (SELECT COUNT(*)::INTEGER FROM execution_submission_events
        WHERE artifact_id=$1) AS submission_events`, [
      fixture.artifact.artifactId, fixture.claim.intent.id,
    ]);
    assert.deepEqual(accepted.rows, [{
      artifact_state: 'ACCEPTED', artifact_revision: '3',
      intent_status: 'SUBMITTED', submission_events: 4,
    }]);
    const entryConfirmation = Object.freeze({
      payloadVersion: 1,
      artifactId: fixture.artifact.artifactId,
      expectedRevision: 3n,
      signature: fixture.artifact.signature,
      observedSlot: 127n,
      observedAtMs: Date.now() + 2_000,
    } as const);
    await repository.recordConfirmation(fixture.claim, entryConfirmation);
    await repository.recordConfirmation(fixture.claim, entryConfirmation);
    const confirmed = await pool.query(`SELECT
      (SELECT state FROM execution_signed_transactions WHERE artifact_id=$1) AS artifact_state,
      (SELECT state_revision::TEXT FROM execution_signed_transactions
        WHERE artifact_id=$1) AS artifact_revision,
      (SELECT status FROM execution_intents WHERE id=$2) AS intent_status,
      (SELECT COUNT(*)::INTEGER FROM execution_submission_events
        WHERE artifact_id=$1) AS submission_events`, [
      fixture.artifact.artifactId, fixture.claim.intent.id,
    ]);
    assert.deepEqual(confirmed.rows, [{
      artifact_state: 'CONFIRMED', artifact_revision: '4',
      intent_status: 'CONFIRMED', submission_events: 5,
    }]);
    const reconciliation = evaluateExecutionReconciliation({
      expected: Object.freeze({
        intentId: fixture.claim.intent.id,
        attemptNumber: fixture.artifact.attemptNumber,
        walletGeneration: 1,
        providerId: fixture.artifact.providerId,
        side: 'BUY',
        signature: fixture.artifact.signature,
        blockhash: fixture.artifact.blockhash,
        lastValidBlockHeight: fixture.artifact.lastValidBlockHeight,
        messageHash: fixture.artifact.messageHash,
        buildFingerprint: fixture.artifact.buildFingerprint,
        snapshotFingerprint: fixture.artifact.snapshotFingerprint,
        maximumFeeLamports: fixture.unsignedSimulation.estimatedFeeLamports,
        maximumFeePayerLamportDebit:
          fixture.unsignedSimulation.simulatedFeePayerLamportDebit,
      }),
      observed: Object.freeze({
        signatureHistory: 'PRESENT',
        confirmationStatus: 'FINALIZED',
        finalizedBlockHeight: 1_001n,
        observedSlot: 128n,
        transaction: Object.freeze({
          signature: fixture.artifact.signature,
          blockhash: fixture.artifact.blockhash,
          messageHash: fixture.artifact.messageHash,
          buildFingerprint: fixture.artifact.buildFingerprint,
          snapshotFingerprint: fixture.artifact.snapshotFingerprint,
        }),
        feeLamports: 5_000n,
        walletLamportDelta: -5_000n,
        baseDeltaRaw: 95n,
        quoteDeltaRaw: -1_000n,
        unexpectedResidualTokenBalanceRaw: 0n,
        observedAtMs: Date.now() + 3_000,
        finalizedAtMs: Date.now() + 4_000,
      }),
    });
    const reconciled = await repository.commitReconciliation(
      fixture.claim,
      reconciliation,
    );
    assert.equal(reconciled.result, 'MATCHED');
    assert.equal(reconciled.position?.baseAmountRaw, 95n);
    assert.equal(reconciled.exitAuthorization?.maximumBaseAmountRaw, 95n);
    const replayedEntry = await repository.commitReconciliation(
      fixture.claim,
      reconciliation,
    );
    assert.equal(replayedEntry.position?.positionId, reconciled.position?.positionId);
    assert.equal(
      replayedEntry.exitAuthorization?.authorizationId,
      reconciled.exitAuthorization?.authorizationId,
    );
    assert.equal(replayedEntry.position?.state, 'OPEN');
    assert.equal(replayedEntry.position?.stateRevision, 0n);
    assert.equal(replayedEntry.exitAuthorization?.state, 'ACTIVE');
    assert.equal(replayedEntry.exitAuthorization?.stateRevision, 0n);
    const finalized = await pool.query(`SELECT
      (SELECT state FROM execution_signed_transactions WHERE artifact_id=$1) AS artifact_state,
      (SELECT status FROM execution_intents WHERE id=$2) AS intent_status,
      (SELECT state FROM execution_live_positions WHERE buy_intent_id=$2) AS position_state,
      (SELECT state FROM execution_exit_authorizations
        WHERE position_id=(SELECT position_id FROM execution_live_positions
          WHERE buy_intent_id=$2)) AS authorization_state`, [
      fixture.artifact.artifactId, fixture.claim.intent.id,
    ]);
    assert.deepEqual(finalized.rows, [{
      artifact_state: 'RECONCILED', intent_status: 'SUCCEEDED',
      position_state: 'OPEN', authorization_state: 'ACTIVE',
    }]);
    assert.ok(reconciled.position);
    const notDue = await repository.createDeadlineExitIntent({
      positionId: reconciled.position.positionId,
      observedAtMs: reconciled.position.exitDeadlineAtMs - 1,
    });
    assert.equal(notDue.kind, 'NOT_DUE');
    const dueAtMs = reconciled.position.exitDeadlineAtMs;
    const concurrentExits = await Promise.all([
      repository.createDeadlineExitIntent({
        positionId: reconciled.position.positionId,
        observedAtMs: dueAtMs,
      }),
      repository.createDeadlineExitIntent({
        positionId: reconciled.position.positionId,
        observedAtMs: dueAtMs,
      }),
    ]);
    const createdExit = concurrentExits.find((result) => result.kind === 'CREATED');
    const replayedExit = concurrentExits.find((result) => result.kind === 'REPLAYED');
    assert.ok(createdExit);
    assert.ok(replayedExit);
    assert.equal(createdExit.kind, 'CREATED');
    assert.equal(createdExit.intent?.side, 'SELL');
    assert.equal(createdExit.intent?.baseAmountRaw, reconciled.position.baseAmountRaw);
    assert.equal(replayedExit.kind, 'REPLAYED');
    assert.equal(replayedExit.intent?.id, createdExit.intent?.id);
    assert.ok(createdExit.intent);
    const laterReplay = await repository.createDeadlineExitIntent({
      positionId: reconciled.position.positionId,
      observedAtMs: dueAtMs + 30_000,
    });
    assert.equal(laterReplay.kind, 'REPLAYED');
    assert.deepEqual(laterReplay.intent, createdExit.intent);
    await pool.query(`UPDATE execution_intents SET quote_decimals=quote_decimals+1
      WHERE id=$1`, [createdExit.intent.id]);
    await assert.rejects(repository.createDeadlineExitIntent({
      positionId: reconciled.position.positionId,
      observedAtMs: dueAtMs + 31_000,
    }), isLiveRepositoryError('INVALID_DATA'));
    await pool.query(`UPDATE execution_intents SET quote_decimals=quote_decimals-1,
      expires_at=expires_at+INTERVAL '1 millisecond' WHERE id=$1`, [createdExit.intent.id]);
    await assert.rejects(repository.createDeadlineExitIntent({
      positionId: reconciled.position.positionId,
      observedAtMs: dueAtMs + 32_000,
    }), isLiveRepositoryError('INVALID_DATA'));
    await pool.query(`UPDATE execution_intents SET expires_at=expires_at-INTERVAL '1 millisecond'
      WHERE id=$1`, [createdExit.intent.id]);
    assert.ok(reconciled.exitAuthorization);
    const exitTimelineMs = Date.now();
    const exitClaimed = await new PostgresExecutionIntentRepository(pool).claim({
      ownerId: 'live-exit-test', leaseMs: 60_000, purpose: 'EXECUTE',
    });
    assert.ok(exitClaimed);
    assert.equal(exitClaimed.intent.id, createdExit.intent.id);
    const exitProcessing = await new PostgresExecutionIntentRepository(pool).transition(
      exitClaimed,
      {
        intentId: exitClaimed.intent.id,
        expectedStatus: 'PENDING',
        nextStatus: 'PROCESSING',
        leaseToken: exitClaimed.leaseToken,
        reasonCode: 'EXECUTION_STARTED',
        humanMessage: 'Deadline exit execution started.',
        activationPhase: 'CANARY',
        evidence: Object.freeze({
          payloadVersion: 1, attemptNumber: null,
          sourceEventId: null, observedAtMs: dueAtMs,
        }),
      },
    );
    const exitBegun = await new PostgresExecutionIntentRepository(pool).beginAttempt(
      Object.freeze({ ...exitClaimed, intent: exitProcessing }),
    );
    const exitArtifact = createSignedTransactionArtifact({
      payloadVersion: 1,
      specificationVersion: 1,
      intentId: exitBegun.claim.intent.id,
      attemptNumber: exitBegun.attempt.attemptNumber,
      generationId,
      armamentId: null,
      reservationId: null,
      exitAuthorizationId: reconciled.exitAuthorization.authorizationId,
      providerId: 'primary',
      walletPublicKey,
      side: 'SELL',
      effectiveVenue: 'PUMP_FUN',
      messageHash: 'a'.repeat(64),
      buildFingerprint: 'b'.repeat(64),
      snapshotFingerprint: 'c'.repeat(64),
      quoteFingerprint: 'e'.repeat(64),
      quoteObservedAtMs: exitTimelineMs,
      quoteExpiresAtMs: exitTimelineMs + 60_000,
      blockhash: walletPublicKey,
      lastValidBlockHeight: 2_000n,
      signature: bs58.encode(new Uint8Array(64).fill(10)),
      signedTransactionBytes: Uint8Array.from([5, 6, 7, 8]),
      signedAtMs: exitTimelineMs + 1,
    });
    const exitUnsignedSimulation = Object.freeze({
      outcome: 'SUCCESS' as const,
      snapshotFingerprint: exitArtifact.snapshotFingerprint,
      buildFingerprint: exitArtifact.buildFingerprint,
      messageHash: exitArtifact.messageHash,
      blockhash: exitArtifact.blockhash,
      lastValidBlockHeight: exitArtifact.lastValidBlockHeight,
      blockhashContextSlot: 200n,
      feeContextSlot: 200n,
      estimatedFeeLamports: 5_000n,
      simulationSlot: 201n,
      simulatedFeePayerLamportDebit: 5_000n,
      unitsConsumed: 25_000n,
      simulatedBaseDeltaRaw: -95n,
      simulatedQuoteDeltaRaw: 800n,
      logsFingerprint: 'f'.repeat(64),
      logsLineCount: 1,
    });
    await repository.persistSigned(Object.freeze({
      payloadVersion: 1,
      claim: exitBegun.claim,
      qualificationId: fixture.qualificationId,
      reservationId: null,
      artifact: exitArtifact,
      unsignedSimulation: exitUnsignedSimulation,
    }));
    const exitSimulated = await repository.recordSignedSimulation(
      exitBegun.claim,
      signedSimulationEvidence(exitArtifact, exitUnsignedSimulation, {
        simulationSlot: 202n,
        unitsConsumed: 26_000n,
        feePayerLamportDebit: 5_000n,
        baseDeltaRaw: -95n,
        quoteDeltaRaw: 800n,
        observedAtMs: exitArtifact.signedAtMs + 1,
      }),
    );
    const exitStarted = await repository.beginSubmission({
      claim: exitBegun.claim,
      artifactId: exitArtifact.artifactId,
      expectedRevision: exitSimulated.stateRevision,
      ...submissionPreflight(exitArtifact),
    });
    await repository.recordSubmissionOutcome(exitBegun.claim, Object.freeze({
      payloadVersion: 1,
      artifactId: exitArtifact.artifactId,
      expectedRevision: exitStarted.stateRevision,
      outcome: 'AMBIGUOUS',
      returnedSignature: null,
      reasonCode: 'SUBMISSION_AMBIGUOUS',
      observedAtMs: Date.now() + 1_000,
    }));
    const exitObservedAtMs = dueAtMs + 6;
    const exitEvidence = evaluateExecutionReconciliation({
      expected: Object.freeze({
        intentId: exitArtifact.intentId,
        attemptNumber: exitArtifact.attemptNumber,
        walletGeneration: 1,
        providerId: exitArtifact.providerId,
        side: 'SELL',
        signature: exitArtifact.signature,
        blockhash: exitArtifact.blockhash,
        lastValidBlockHeight: exitArtifact.lastValidBlockHeight,
        messageHash: exitArtifact.messageHash,
        buildFingerprint: exitArtifact.buildFingerprint,
        snapshotFingerprint: exitArtifact.snapshotFingerprint,
        maximumFeeLamports: exitUnsignedSimulation.estimatedFeeLamports,
        maximumFeePayerLamportDebit:
          exitUnsignedSimulation.simulatedFeePayerLamportDebit,
      }),
      observed: Object.freeze({
        signatureHistory: 'PRESENT', confirmationStatus: 'FINALIZED',
        finalizedBlockHeight: 2_001n, observedSlot: 204n,
        transaction: Object.freeze({
          signature: exitArtifact.signature,
          blockhash: exitArtifact.blockhash,
          messageHash: exitArtifact.messageHash,
          buildFingerprint: exitArtifact.buildFingerprint,
          snapshotFingerprint: exitArtifact.snapshotFingerprint,
        }),
        feeLamports: 5_000n,
        walletLamportDelta: 795n,
        baseDeltaRaw: -95n,
        quoteDeltaRaw: 800n,
        unexpectedResidualTokenBalanceRaw: 0n,
        observedAtMs: exitObservedAtMs,
        finalizedAtMs: exitObservedAtMs + 1,
      }),
    });
    const exitReconciled = await repository.commitReconciliation(
      exitBegun.claim,
      exitEvidence,
    );
    assert.equal(exitReconciled.result, 'MATCHED');
    const replayedExitReconciliation = await repository.commitReconciliation(
      exitBegun.claim,
      exitEvidence,
    );
    assert.equal(replayedExitReconciliation.result, 'MATCHED');
    const closed = await pool.query(`SELECT
      (SELECT state FROM execution_signed_transactions WHERE artifact_id=$1) AS artifact_state,
      (SELECT status FROM execution_intents WHERE id=$2) AS intent_status,
      (SELECT state FROM execution_live_positions WHERE position_id=$3) AS position_state,
      (SELECT state FROM execution_exit_authorizations WHERE authorization_id=$4)
        AS authorization_state,
      (SELECT state FROM execution_activation_armaments WHERE armament_id=$5)
        AS armament_state`, [
      exitArtifact.artifactId, exitArtifact.intentId, reconciled.position.positionId,
      reconciled.exitAuthorization.authorizationId, fixture.armamentId,
    ]);
    assert.deepEqual(closed.rows, [{
      artifact_state: 'RECONCILED', intent_status: 'SUCCEEDED',
      position_state: 'CLOSED', authorization_state: 'CONSUMED',
      armament_state: 'CONSUMED',
    }]);
    const lateEntryReplay = await repository.commitReconciliation(
      fixture.claim,
      reconciliation,
    );
    assert.equal(lateEntryReplay.position?.positionId, reconciled.position.positionId);
    assert.equal(
      lateEntryReplay.exitAuthorization?.authorizationId,
      reconciled.exitAuthorization.authorizationId,
    );
    assert.equal(lateEntryReplay.position?.state, 'CLOSED');
    assert.equal(lateEntryReplay.position?.stateRevision, 2n);
    assert.equal(lateEntryReplay.exitAuthorization?.state, 'CONSUMED');
    assert.equal(lateEntryReplay.exitAuthorization?.stateRevision, 2n);
    const inferredExitConfirmation = await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_submission_events WHERE artifact_id=$1
        AND previous_state='AMBIGUOUS' AND next_state='CONFIRMED'`, [exitArtifact.artifactId]);
    assert.equal(inferredExitConfirmation.rows[0]?.count, 1);
  });
});

void test('signed simulation commit-unknown replays one durable evidence row', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live commit-unknown test skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, async (pool) => {
    const fixture = await liveFixture(pool);
    const repository = new PostgresExecutionLiveRepository(pool);
    await repository.persistSigned(Object.freeze({
      payloadVersion: 1, claim: fixture.claim,
      qualificationId: fixture.qualificationId, reservationId: fixture.reservationId,
      artifact: fixture.artifact, unsignedSimulation: fixture.unsignedSimulation,
    }));
    const evidence = signedSimulationEvidence(
      fixture.artifact, fixture.unsignedSimulation, Object.freeze({
        simulationSlot: 126n, unitsConsumed: 26_000n,
        feePayerLamportDebit: 5_500n, baseDeltaRaw: 95n, quoteDeltaRaw: -1_000n,
        observedAtMs: fixture.artifact.signedAtMs + 1,
      }),
    );
    let failCommit = true;
    const uncertain = new PostgresExecutionLiveRepository({
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (text: string, values?: readonly unknown[]) => {
            const result = await client.query(text, values as unknown[] | undefined);
            if (text === 'COMMIT' && failCommit) {
              failCommit = false;
              throw new Error('simulated commit acknowledgement loss');
            }
            return { rows: result.rows as readonly Readonly<Record<string, unknown>>[],
              rowCount: result.rowCount };
          },
          release: (error?: boolean) => { client.release(error); },
        };
      },
    });
    await assert.rejects(
      uncertain.recordSignedSimulation(fixture.claim, evidence),
      isLiveRepositoryError('COMMIT_OUTCOME_UNKNOWN'),
    );
    const replay = await repository.recordSignedSimulation(fixture.claim, evidence);
    assert.equal(replay.state, 'SIGNED_SIMULATED');
    const count = await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_signed_simulation_evidence WHERE artifact_id=$1`, [
      fixture.artifact.artifactId,
    ]);
    assert.deepEqual(count.rows, [{ count: 1 }]);
  });
});

void test('fails closed when the durable control is stopped before persistence', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live repository stop test skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, async (pool) => {
    const fixture = await liveFixture(pool);
    await new PostgresExecutionOperationsRepository(pool).setStop({
      payloadVersion: 1, commandId: 'command:live-stop', generationId,
      operatorId: 'operator-primary', occurredAtMs: Date.now(),
    }, 'ENTRY_STOP');
    await assert.rejects(new PostgresExecutionLiveRepository(pool).persistSigned(Object.freeze({
      payloadVersion: 1, claim: fixture.claim,
      qualificationId: fixture.qualificationId,
      reservationId: fixture.reservationId, artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
    })), (error: unknown) => error instanceof ExecutionLiveRepositoryError
      && error.code === 'CONTROL_STOPPED');
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_signed_transactions`)).rows[0]?.count, 0);
  });
});

for (const scenario of ['RETIRED_GENERATION', 'RUNTIME_BINDING', 'CAPITAL_LIMIT', 'EXPOSURE_LIMIT',
  'DRAWDOWN_DRIFT', 'PROVIDER_USAGE_DRIFT', 'PROVIDER_RATE_LIMIT_DRIFT',
  'QUOTE_EXPIRED', 'BLOCKHASH_EXPIRED'] as const) {
  void test(`atomic submission gate rejects ${scenario} without durable authorization`,
    async (context) => {
      const databaseUrl = process.env.TEST_DATABASE_URL;
      if (databaseUrl === undefined || databaseUrl.trim() === '') {
        context.skip('TEST_DATABASE_URL absent: atomic live gate test skipped');
        return;
      }
      await withTemporarySchema(databaseUrl, async (pool) => {
        const fixture = await liveFixture(
          pool,
          scenario === 'QUOTE_EXPIRED' ? 15 : 60_000,
          scenario === 'CAPITAL_LIMIT' ? 500n : 500_000n,
        );
        const repository = new PostgresExecutionLiveRepository(pool);
        await repository.persistSigned(Object.freeze({
          payloadVersion: 1, claim: fixture.claim,
          qualificationId: fixture.qualificationId,
          reservationId: fixture.reservationId,
          artifact: fixture.artifact,
          unsignedSimulation: fixture.unsignedSimulation,
        }));
        const simulated = await repository.recordSignedSimulation(
          fixture.claim,
          signedSimulationEvidence(fixture.artifact, fixture.unsignedSimulation, {
            simulationSlot: 126n,
            unitsConsumed: 26_000n,
            feePayerLamportDebit: 5_500n,
            baseDeltaRaw: 95n,
            quoteDeltaRaw: -1_000n,
            observedAtMs: fixture.artifact.signedAtMs + 1,
          }),
        );
        if (scenario === 'RETIRED_GENERATION') {
          await pool.query(`UPDATE execution_wallet_generations SET
            retired_at=date_trunc('milliseconds',statement_timestamp())
            WHERE generation_id=$1`, [generationId]);
        }
        if (scenario === 'EXPOSURE_LIMIT') {
          await pool.query(`UPDATE execution_wallet_risk_state SET
            reserved_exposure_raw=60000,state_revision=state_revision+1
            WHERE generation_id=$1`, [generationId]);
        }
        if (scenario === 'DRAWDOWN_DRIFT') {
          await pool.query(`UPDATE execution_wallet_risk_state SET
            conservative_drawdown_raw=999999,
            state_revision=state_revision+1 WHERE generation_id=$1`, [generationId]);
        }
        if (scenario === 'PROVIDER_USAGE_DRIFT') {
          await new PostgresExecutionRiskRepository(pool).recordProviderOperation({
            operationId: `execution_provider_operation_${'e'.repeat(64)}`,
            payloadVersion: 1, snapshotId: fixture.providerSnapshot.snapshotId,
            providerId: fixture.providerSnapshot.providerId,
            billingPeriodId: fixture.providerSnapshot.billingPeriodId,
            category: 'TELEMETRY', logicalOperationId: 'post-admission-probe', units: 1n,
          });
        }
        if (scenario === 'PROVIDER_RATE_LIMIT_DRIFT') {
          await new PostgresExecutionRiskRepository(pool).recordRateLimit({
            eventId: `execution_provider_rate_limit_${'e'.repeat(64)}`,
            payloadVersion: 1, providerId: fixture.providerSnapshot.providerId,
            billingPeriodId: fixture.providerSnapshot.billingPeriodId,
            endpointId: 'primary', observedAtMs: Date.now(),
          });
        }
        if (scenario === 'QUOTE_EXPIRED') await pool.query('SELECT pg_sleep(0.030)');
        const baseline = submissionPreflight(fixture.artifact);
        const preflight = scenario === 'RUNTIME_BINDING'
          ? Object.freeze({ ...baseline, runtime: Object.freeze({
            ...baseline.runtime, buildHash: 'f'.repeat(64),
          }) })
          : scenario === 'BLOCKHASH_EXPIRED'
            ? Object.freeze({ ...baseline, blockhashValidity: Object.freeze({
              ...baseline.blockhashValidity,
              observedBlockHeight: fixture.artifact.lastValidBlockHeight + 1n,
            }) })
            : baseline;
        await assert.rejects(repository.beginSubmission({
          claim: fixture.claim,
          artifactId: fixture.artifact.artifactId,
          expectedRevision: simulated.stateRevision,
          ...preflight,
        }), isLiveRepositoryError('PREFLIGHT_EXPIRED'));
        const state = await pool.query(`SELECT
          (SELECT state FROM execution_signed_transactions WHERE artifact_id=$1)
            AS artifact_state,
          (SELECT COUNT(*)::INTEGER FROM execution_submission_preflight_evidence
            WHERE artifact_id=$1) AS preflight_count`, [fixture.artifact.artifactId]);
        assert.deepEqual(state.rows, [{ artifact_state: 'SIGNED_SIMULATED', preflight_count: 0 }]);
      });
    });
}

void test('finalized no-effect evidence closes an ambiguous artifact without opening a position', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live no-effect test skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, async (pool) => {
    const fixture = await liveFixture(pool);
    const repository = new PostgresExecutionLiveRepository(pool);
    await repository.persistSigned(Object.freeze({
      payloadVersion: 1, claim: fixture.claim,
      qualificationId: fixture.qualificationId,
      reservationId: fixture.reservationId,
      artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
    }));
    const simulated = await repository.recordSignedSimulation(fixture.claim,
      signedSimulationEvidence(fixture.artifact, fixture.unsignedSimulation, {
      simulationSlot: 126n,
      unitsConsumed: 26_000n,
      feePayerLamportDebit: 5_500n,
      baseDeltaRaw: 95n,
      quoteDeltaRaw: -1_000n,
      observedAtMs: fixture.artifact.signedAtMs + 1,
      }));
    const started = await repository.beginSubmission({
      claim: fixture.claim,
      artifactId: fixture.artifact.artifactId,
      expectedRevision: simulated.stateRevision,
      ...submissionPreflight(fixture.artifact),
    });
    await repository.recordSubmissionOutcome(fixture.claim, Object.freeze({
      payloadVersion: 1,
      artifactId: fixture.artifact.artifactId,
      expectedRevision: started.stateRevision,
      outcome: 'AMBIGUOUS',
      returnedSignature: null,
      reasonCode: 'SUBMISSION_AMBIGUOUS',
      observedAtMs: Date.now() + 1_000,
    }));
    const observedAtMs = Date.now() + 2_000;
    const evidence = evaluateExecutionReconciliation({
      expected: Object.freeze({
        intentId: fixture.claim.intent.id,
        attemptNumber: fixture.artifact.attemptNumber,
        walletGeneration: 1,
        providerId: fixture.artifact.providerId,
        side: 'BUY',
        signature: fixture.artifact.signature,
        blockhash: fixture.artifact.blockhash,
        lastValidBlockHeight: fixture.artifact.lastValidBlockHeight,
        messageHash: fixture.artifact.messageHash,
        buildFingerprint: fixture.artifact.buildFingerprint,
        snapshotFingerprint: fixture.artifact.snapshotFingerprint,
        maximumFeeLamports: fixture.unsignedSimulation.estimatedFeeLamports,
        maximumFeePayerLamportDebit:
          fixture.unsignedSimulation.simulatedFeePayerLamportDebit,
      }),
      observed: Object.freeze({
        signatureHistory: 'ABSENT', confirmationStatus: 'NOT_FOUND',
        finalizedBlockHeight: 1_001n, observedSlot: null, transaction: null,
        feeLamports: 0n, walletLamportDelta: 0n,
        baseDeltaRaw: 0n, quoteDeltaRaw: 0n,
        unexpectedResidualTokenBalanceRaw: 0n,
        observedAtMs, finalizedAtMs: observedAtMs + 1_000,
      }),
    });
    const result = await repository.commitReconciliation(fixture.claim, evidence);
    assert.equal(result.result, 'NO_EFFECT');
    assert.equal(result.position, null);
    const replayed = await repository.commitReconciliation(fixture.claim, evidence);
    assert.equal(replayed.result, 'NO_EFFECT');
    assert.equal(replayed.position, null);
    const state = await pool.query(`SELECT
      (SELECT state FROM execution_signed_transactions WHERE artifact_id=$1) AS artifact_state,
      (SELECT status FROM execution_intents WHERE id=$2) AS intent_status,
      (SELECT state FROM execution_exposure_reservations WHERE intent_id=$2) AS reservation_state,
      (SELECT COUNT(*)::INTEGER FROM execution_live_positions) AS positions`, [
      fixture.artifact.artifactId, fixture.claim.intent.id,
    ]);
    assert.deepEqual(state.rows, [{
      artifact_state: 'RECONCILED', intent_status: 'FAILED',
      reservation_state: 'RELEASED', positions: 0,
    }]);
  });
});

void test('finalized BUY evidence reconciles an ambiguous submission without confirmation RPC', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live ambiguous BUY test skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, async (pool) => {
    const fixture = await liveFixture(pool);
    const repository = new PostgresExecutionLiveRepository(pool);
    await repository.persistSigned(Object.freeze({
      payloadVersion: 1, claim: fixture.claim,
      qualificationId: fixture.qualificationId,
      reservationId: fixture.reservationId,
      artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
    }));
    const simulated = await repository.recordSignedSimulation(fixture.claim,
      signedSimulationEvidence(fixture.artifact, fixture.unsignedSimulation, {
      simulationSlot: 126n,
      unitsConsumed: 26_000n,
      feePayerLamportDebit: 5_500n,
      baseDeltaRaw: 95n,
      quoteDeltaRaw: -1_000n,
      observedAtMs: fixture.artifact.signedAtMs + 1,
      }));
    const started = await repository.beginSubmission({
      claim: fixture.claim,
      artifactId: fixture.artifact.artifactId,
      expectedRevision: simulated.stateRevision,
      ...submissionPreflight(fixture.artifact),
    });
    await repository.recordSubmissionOutcome(fixture.claim, Object.freeze({
      payloadVersion: 1,
      artifactId: fixture.artifact.artifactId,
      expectedRevision: started.stateRevision,
      outcome: 'AMBIGUOUS',
      returnedSignature: null,
      reasonCode: 'SUBMISSION_AMBIGUOUS',
      observedAtMs: Date.now() + 1_000,
    }));
    const observedAtMs = Date.now() + 2_000;
    const evidence = evaluateExecutionReconciliation({
      expected: Object.freeze({
        intentId: fixture.claim.intent.id,
        attemptNumber: fixture.artifact.attemptNumber,
        walletGeneration: 1,
        providerId: fixture.artifact.providerId,
        side: 'BUY',
        signature: fixture.artifact.signature,
        blockhash: fixture.artifact.blockhash,
        lastValidBlockHeight: fixture.artifact.lastValidBlockHeight,
        messageHash: fixture.artifact.messageHash,
        buildFingerprint: fixture.artifact.buildFingerprint,
        snapshotFingerprint: fixture.artifact.snapshotFingerprint,
        maximumFeeLamports: fixture.unsignedSimulation.estimatedFeeLamports,
        maximumFeePayerLamportDebit:
          fixture.unsignedSimulation.simulatedFeePayerLamportDebit,
      }),
      observed: Object.freeze({
        signatureHistory: 'PRESENT', confirmationStatus: 'FINALIZED',
        finalizedBlockHeight: 1_001n, observedSlot: 128n,
        transaction: Object.freeze({
          signature: fixture.artifact.signature,
          blockhash: fixture.artifact.blockhash,
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

    const result = await repository.commitReconciliation(fixture.claim, evidence);

    assert.equal(result.result, 'MATCHED');
    assert.equal(result.position?.baseAmountRaw, 95n);
    const state = await pool.query(`SELECT
      (SELECT state FROM execution_signed_transactions WHERE artifact_id=$1) AS artifact_state,
      (SELECT status FROM execution_intents WHERE id=$2) AS intent_status,
      (SELECT COUNT(*)::INTEGER FROM execution_submission_events
        WHERE artifact_id=$1 AND previous_state='AMBIGUOUS' AND next_state='CONFIRMED')
        AS inferred_confirmation_events`, [fixture.artifact.artifactId, fixture.claim.intent.id]);
    assert.deepEqual(state.rows, [{
      artifact_state: 'RECONCILED', intent_status: 'SUCCEEDED', inferred_confirmation_events: 1,
    }]);
  });
});

void test('rejects a lost lease and a superseded provider quota snapshot', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live repository stale gate test skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, async (pool) => {
    const fixture = await liveFixture(pool);
    const repository = new PostgresExecutionLiveRepository(pool);
    const input = Object.freeze({
      payloadVersion: 1 as const, claim: fixture.claim,
      qualificationId: fixture.qualificationId,
      reservationId: fixture.reservationId, artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
    });
    await pool.query(`UPDATE execution_intents SET
      lease_expires_at=date_trunc('milliseconds',statement_timestamp()) WHERE id=$1`, [
      fixture.claim.intent.id,
    ]);
    await assert.rejects(repository.persistSigned(input),
      isLiveRepositoryError('LEASE_LOST'));
  });
  await withTemporarySchema(databaseUrl, async (pool) => {
    const fixture = await liveFixture(pool);
    const prior = fixture.providerSnapshot;
    const newer = createProviderUsageSnapshot({
      providerId: prior.providerId, planId: prior.planId,
      billingPeriodId: prior.billingPeriodId,
      billingPeriodStartedAtMs: prior.billingPeriodStartedAtMs,
      billingPeriodEndsAtMs: prior.billingPeriodEndsAtMs,
      limitUnits: prior.limitUnits, usedUnits: prior.usedUnits + 1n,
      measuredAtMs: prior.measuredAtMs + 1,
      expiresAtMs: prior.expiresAtMs + 1, provenance: prior.provenance,
    });
    await new PostgresExecutionRiskRepository(pool).appendProviderUsage(newer);
    await assert.rejects(new PostgresExecutionLiveRepository(pool).persistSigned(Object.freeze({
      payloadVersion: 1, claim: fixture.claim,
      qualificationId: fixture.qualificationId,
      reservationId: fixture.reservationId, artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
    })), isLiveRepositoryError('PREFLIGHT_EXPIRED'));
  });
});

void test('rejects a signed artifact state update without its immutable journal event', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live journal enforcement test skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, async (pool) => {
    const fixture = await liveFixture(pool);
    const repository = new PostgresExecutionLiveRepository(pool);
    await repository.persistSigned(Object.freeze({
      payloadVersion: 1, claim: fixture.claim,
      qualificationId: fixture.qualificationId,
      reservationId: fixture.reservationId,
      artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
    }));
    const signedEvidence = signedSimulationEvidence(
      fixture.artifact, fixture.unsignedSimulation, Object.freeze({
        simulationSlot: 126n, unitsConsumed: 26_000n,
        feePayerLamportDebit: 5_500n, baseDeltaRaw: 95n, quoteDeltaRaw: -1_000n,
        observedAtMs: fixture.artifact.signedAtMs + 1,
      }),
    );
    await pool.query(`INSERT INTO execution_signed_simulation_evidence (
      evidence_id,payload_version,evidence_fingerprint,artifact_id,
      unsigned_simulation_evidence_id,signed_transaction_hash,provider_id,
      simulation_slot,units_consumed,fee_payer_lamport_debit,base_delta_raw,
      quote_delta_raw,logs_fingerprint,logs_line_count,observed_at
    ) VALUES ($1,1,$2,$3,$4,$5,$6,$7::BIGINT,$8::BIGINT,$9::NUMERIC,$10::NUMERIC,
      $11::NUMERIC,$12,$13::INTEGER,
      TIMESTAMPTZ 'epoch'+($14::BIGINT*INTERVAL '1 millisecond'))`, [
      `execution_signed_simulation_evidence_${signedEvidence.evidenceFingerprint}`,
      signedEvidence.evidenceFingerprint, signedEvidence.artifactId,
      signedEvidence.unsignedSimulationEvidenceId, signedEvidence.signedTransactionHash,
      signedEvidence.providerId, signedEvidence.simulationSlot.toString(),
      signedEvidence.unitsConsumed.toString(), signedEvidence.feePayerLamportDebit.toString(),
      signedEvidence.baseDeltaRaw.toString(), signedEvidence.quoteDeltaRaw.toString(),
      signedEvidence.logsFingerprint, signedEvidence.logsLineCount, signedEvidence.observedAtMs,
    ]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE execution_signed_transactions SET
        state='SIGNED_SIMULATED',state_revision=1,
        signed_simulated_at=TIMESTAMPTZ 'epoch'+($2::BIGINT*INTERVAL '1 millisecond')
        WHERE artifact_id=$1`, [
        fixture.artifact.artifactId, fixture.artifact.signedAtMs + 1,
      ]);
      await assert.rejects(
        client.query('COMMIT'),
        (error: unknown) => typeof error === 'object' && error !== null
          && 'code' in error && error.code === '55000',
      );
    } finally {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
    const state = await pool.query<{ state: string; state_revision: string }>(
      `SELECT state,state_revision::TEXT FROM execution_signed_transactions
       WHERE artifact_id=$1`,
      [fixture.artifact.artifactId],
    );
    assert.deepEqual(state.rows, [{ state: 'PERSISTED', state_revision: '0' }]);

    const capability = await pool.query<{ can_create_role: boolean }>(`
      SELECT rolsuper OR rolcreaterole AS can_create_role
      FROM pg_roles WHERE rolname=current_user`);
    if (capability.rows[0]?.can_create_role !== true) return;
    const role = `execution_live_test_${randomUUID().replaceAll('-', '')}`;
    const schema = (await pool.query<{ schema_name: string }>(
      'SELECT current_schema() AS schema_name',
    )).rows[0]?.schema_name;
    assert.ok(schema);
    await pool.query(`CREATE ROLE ${quoteIdentifier(role)} NOLOGIN NOSUPERUSER
      NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    try {
      await pool.query(`GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)}
        TO ${quoteIdentifier(role)}`);
      await pool.query(`GRANT SELECT ON TABLE execution_signed_transactions,
        execution_live_unsigned_simulation_evidence,
        execution_signed_simulation_evidence,execution_submission_events,
        execution_wallet_generations
        TO ${quoteIdentifier(role)}`);
      await pool.query(`GRANT UPDATE ON TABLE execution_signed_transactions
        TO ${quoteIdentifier(role)}`);
      const restricted = await pool.connect();
      try {
        await restricted.query(`SET ROLE ${quoteIdentifier(role)}`);
        await restricted.query('SELECT generation_id FROM execution_wallet_generations');
        await assert.rejects(
          restricted.query(`SELECT generation_id FROM execution_wallet_generations
            FOR UPDATE`),
          (error: unknown) => typeof error === 'object' && error !== null
            && 'code' in error && error.code === '42501',
        );
        await restricted.query('BEGIN');
        await restricted.query(`UPDATE execution_signed_transactions SET
          state='SIGNED_SIMULATED',state_revision=1,
          signed_simulated_at=TIMESTAMPTZ 'epoch'+($2::BIGINT*INTERVAL '1 millisecond')
          WHERE artifact_id=$1`, [
          fixture.artifact.artifactId, fixture.artifact.signedAtMs + 1,
        ]);
        await assert.rejects(
          restricted.query('COMMIT'),
          (error: unknown) => typeof error === 'object' && error !== null
            && 'code' in error && error.code === '55000',
        );
      } finally {
        try { await restricted.query('ROLLBACK'); } catch { /* already aborted */ }
        try { await restricted.query('RESET ROLE'); } finally { restricted.release(); }
      }
    } finally {
      await pool.query(`DROP OWNED BY ${quoteIdentifier(role)}`);
      await pool.query(`DROP ROLE ${quoteIdentifier(role)}`);
    }
  });
});

async function liveFixture(
  pool: InstanceType<typeof pg.Pool>,
  quoteLifetimeMs = 60_000,
  maximumCanaryCapitalLamports = 500_000n,
) {
  await migrateDatabase({ pool });
  const simulation = await seedSuccessfulSimulation(pool);
  const risk = new PostgresExecutionRiskRepository(pool);
  await risk.registerWalletGeneration({
    generationId, payloadVersion: 1, walletPublicKey,
    cluster: 'mainnet-beta', genesisHash: walletPublicKey, generation: 1,
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
    maximumCapitalLamports: maximumCanaryCapitalLamports, maximumExposureBps: 500n,
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
    providerId: 'primary', stateRevision: 0n, slot: 123n,
    blockTimeMs: nowMs - 100, observedAtMs: nowMs - 50,
    commitment: 'finalized' as const, walletLamports: 1_000_000n,
    tokenBalanceCount: 0, openPositions: Object.freeze([]), realizedNetPnlRaw: 0n,
  }));
  const providerSnapshot = createProviderUsageSnapshot({
    providerId: 'primary', planId: 'public-v1', billingPeriodId: `period-${nowMs}`,
    billingPeriodStartedAtMs: nowMs - 1_000,
    billingPeriodEndsAtMs: nowMs + 300_000,
    limitUnits: 10_000n, usedUnits: 10n, measuredAtMs: nowMs - 100,
    expiresAtMs: nowMs + 60_000, provenance: 'AUTHORITATIVE_PROBE',
  });
  await risk.appendProviderUsage(providerSnapshot);
  const intents = new PostgresExecutionIntentRepository(pool);
  const created = await intents.create(createExecutionIntentDraft({
    strategyId: 'live-canary-test', strategyVersion: 1,
    positionId: `position:${randomUUID()}`, logicalCommandId: `command:${randomUUID()}`,
    mint: walletPublicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint, quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 1_000n, baseAmountRaw: null, minimumAmountOutRaw: 90n,
    decisionEventId: `decision:${randomUUID()}`, decisionFingerprint: fingerprint,
    requestedAtMs: nowMs, expiresAtMs: nowMs + 120_000,
  }));
  const policy = createExecutionRiskPolicy({
    quoteMintAllowlist: [quoteMint], initialCapitalLamports: 1_000_000n,
    maximumCapitalLamports: 1_000_000n, positionSizeBps: 1_000n,
    maximumOpenPositions: 1, maximumTotalExposureBps: 500n,
    drawdownPauseBps: 2_500n, feeReserveLamports: 100_000n,
    walletSnapshotMaxAgeMs: 60_000, providerUsageMaxAgeMs: 300_000,
    providerEntryCostUnits: 8n, providerExitCostUnitsPerPosition: 4n,
    providerConfirmationCostUnitsPerPosition: 2n,
    providerReconciliationCostUnitsPerPosition: 3n,
    providerSafetyMarginUnits: 5n, maximumConsecutiveTechnicalFailures: 2,
  });
  const admitted = await new ExecutionAdmissionService(risk).admit(Object.freeze({
    payloadVersion: 1, intent: created.intent, policy, generationId,
    walletSnapshot, providerSnapshot, allEndpointsUnavailable: false, nowMs,
  }));
  assert.equal(admitted.decision, 'ADMITTED');
  assert.ok(admitted.reservationId);
  const claimed = await intents.claim({
    ownerId: 'live-executor-test', leaseMs: 60_000, purpose: 'EXECUTE',
  });
  assert.ok(claimed);
  assert.equal(claimed.intent.id, created.intent.id);
  const processingIntent = await intents.transition(claimed, {
    intentId: claimed.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
    leaseToken: claimed.leaseToken, reasonCode: 'EXECUTION_STARTED',
    humanMessage: 'Live canary preparation started.', activationPhase: 'CANARY',
    evidence: Object.freeze({
      payloadVersion: 1, attemptNumber: null, sourceEventId: null, observedAtMs: nowMs,
    }),
  });
  const begun = await intents.beginAttempt(Object.freeze({ ...claimed, intent: processingIntent }));
  const claim = begun.claim;
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const artifact = createSignedTransactionArtifact({
    payloadVersion: 1, specificationVersion: 1,
    intentId: claim.intent.id, attemptNumber: begun.attempt.attemptNumber,
    generationId, armamentId: armament.armamentId, exitAuthorizationId: null,
    reservationId: admitted.reservationId,
    providerId: 'primary', walletPublicKey, side: 'BUY', effectiveVenue: 'PUMP_FUN',
    messageHash: '4'.repeat(64), buildFingerprint: '5'.repeat(64),
    snapshotFingerprint: 'd'.repeat(64), quoteFingerprint: '7'.repeat(64),
    quoteObservedAtMs: nowMs,
    quoteExpiresAtMs: nowMs + quoteLifetimeMs,
    blockhash: walletPublicKey, lastValidBlockHeight: 1_000n,
    signature: bs58.encode(new Uint8Array(64).fill(8)),
    signedTransactionBytes: bytes, signedAtMs: nowMs + 4,
  });
  const unsignedSimulation = Object.freeze({
    outcome: 'SUCCESS' as const, snapshotFingerprint: artifact.snapshotFingerprint,
    buildFingerprint: artifact.buildFingerprint, messageHash: artifact.messageHash,
    blockhash: artifact.blockhash, lastValidBlockHeight: artifact.lastValidBlockHeight,
    blockhashContextSlot: 124n, feeContextSlot: 124n,
    estimatedFeeLamports: 5_000n, simulationSlot: 125n,
    simulatedFeePayerLamportDebit: 5_000n, unitsConsumed: 25_000n,
    simulatedBaseDeltaRaw: 100n, simulatedQuoteDeltaRaw: -1_000n,
    logsFingerprint: '8'.repeat(64), logsLineCount: 1,
  });
  return Object.freeze({
    claim, artifact, unsignedSimulation, providerSnapshot, armamentId: armament.armamentId,
    qualificationId: qualification.qualificationId,
    reservationId: admitted.reservationId,
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
          artifactId: simulation.artifactId,
          resultFingerprint: simulation.resultFingerprint,
          buildHash: fingerprint,
          configurationFingerprint: simulation.configurationFingerprint,
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
    ownerId: 'preflight-test-worker', leaseMs: 30_000, purpose: 'EXECUTE',
  });
  assert.ok(claimed);
  const processingIntent = await intents.transition(claimed, {
    intentId: created.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
    leaseToken: claimed.leaseToken, reasonCode: 'EXECUTION_STARTED',
    humanMessage: 'Execution simulation started.', activationPhase: 'NONE',
    evidence: Object.freeze({
      payloadVersion: 1, attemptNumber: null, sourceEventId: null, observedAtMs: nowMs,
    }),
  });
  const begun = await intents.beginAttempt(Object.freeze({ ...claimed, intent: processingIntent }));
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

async function withTemporarySchema(
  databaseUrl: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `execution_live_repository_${randomUUID().replaceAll('-', '')}`;
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

function databaseErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor !== undefined && 'value' in descriptor
    && typeof descriptor.value === 'string' ? descriptor.value : null;
}

function isLiveRepositoryError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ExecutionLiveRepositoryError && error.code === code;
}
