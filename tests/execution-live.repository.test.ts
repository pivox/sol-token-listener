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
import { createSignedTransactionArtifact } from '../src/domain/execution-live.js';
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
      (SELECT COUNT(*)::INTEGER FROM execution_signed_transactions) AS artifacts,
      (SELECT COUNT(*)::INTEGER FROM execution_submission_events) AS submission_events`, [
      fixture.armamentId, fixture.claim.intent.id,
    ]);
    assert.deepEqual(state.rows, [{
      armament_state: 'LOCKED', consumed_buys: 1,
      intent_status: 'SIGNED_NOT_SUBMITTED', artifacts: 1, submission_events: 1,
    }]);
    const authenticated = await repository.authenticatePersistedSignedTransaction({
      claim: fixture.claim, artifactId: fixture.artifact.artifactId,
    });
    assert.equal(authenticated.state, 'PERSISTED');
    assert.deepEqual(authenticated.artifact.signedTransactionBytes,
      fixture.artifact.signedTransactionBytes);
    const signedSimulation = await repository.recordSignedSimulation(
      fixture.claim,
      Object.freeze({
        payloadVersion: 1,
        artifactId: fixture.artifact.artifactId,
        signedTransactionHash: fixture.artifact.signedTransactionHash,
        simulationSlot: 126n,
        unitsConsumed: 26_000n,
        feePayerLamportDebit: 5_500n,
        baseDeltaRaw: 95n,
        quoteDeltaRaw: -1_000n,
        evidenceFingerprint: '9'.repeat(64),
        observedAtMs: fixture.artifact.signedAtMs + 1,
      }),
    );
    assert.equal(signedSimulation.state, 'SIGNED_SIMULATED');
    assert.equal(signedSimulation.stateRevision, 1n);
    const submissionStarted = await repository.beginSubmission({
      claim: fixture.claim,
      artifactId: fixture.artifact.artifactId,
      expectedRevision: signedSimulation.stateRevision,
      observedAtMs: Date.now(),
    });
    assert.equal(submissionStarted.state, 'SUBMISSION_STARTED');
    assert.equal(submissionStarted.stateRevision, 2n);
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

async function liveFixture(pool: InstanceType<typeof pg.Pool>) {
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
    maximumCapitalLamports: 500_000n, maximumExposureBps: 500n,
    maximumOpenPositions: 1, maximumHoldingMs: 300_000,
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
    providerId: 'primary', walletPublicKey, side: 'BUY', effectiveVenue: 'PUMP_FUN',
    messageHash: '4'.repeat(64), buildFingerprint: '5'.repeat(64),
    snapshotFingerprint: '6'.repeat(64), quoteFingerprint: '7'.repeat(64),
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

function isLiveRepositoryError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ExecutionLiveRepositoryError && error.code === code;
}
