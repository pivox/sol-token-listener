import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  createExecutionArmamentRequestV2,
  createOperatorAuthorization,
  createOperatorAuthorizationV2,
} from '../src/domain/execution-operations.js';
import { createExecutionCanaryEvidence } from '../src/domain/execution-canary.js';
import { createProviderUsageSnapshot } from '../src/domain/execution-provider-quota.js';
import { createExecutionRiskPolicy } from '../src/domain/execution-risk-policy.js';
import {
  createSafetyQualification,
  createMainnetSimulationEvidenceFingerprint,
  EXECUTION_SAFETY_GATE_IDS,
} from '../src/domain/execution-safety-qualification.js';
import { createExecutionWalletSnapshot } from '../src/domain/execution-wallet-snapshot.js';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { createExecutionSimulationArtifactDraft } from '../src/domain/execution-simulation.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
import {
  ExecutionOperationsRepositoryError,
  PostgresExecutionOperationsRepository,
} from '../src/storage/execution-operations.repository.js';
import { PostgresExecutionRiskRepository } from '../src/storage/execution-risk.repository.js';
import { PostgresExecutionSimulationRepository } from '../src/storage/execution-simulation.repository.js';

const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
const publicKey = '11111111111111111111111111111111';
const hash = '1'.repeat(64);

void test('reads the exact unleased BUY intent used as a canary target', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const intents = new PostgresExecutionIntentRepository(pool);
    const nowMs = Date.now();
    const created = await intents.create(createExecutionIntentDraft({
      strategyId: 'canary-target', strategyVersion: 1,
      positionId: 'position:canary-target', logicalCommandId: 'command:canary-target',
      mint: publicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
      quoteMint: 'So11111111111111111111111111111111111111112',
      quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
      quoteAmountRaw: 90_000n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
      decisionEventId: 'decision:canary-target', decisionFingerprint: 'd'.repeat(64),
      requestedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 60_000,
    }));
    const target = await new PostgresExecutionOperationsRepository(pool)
      .readTargetIntent(created.intent.id);
    assert.deepEqual(target, {
      intentId: created.intent.id,
      side: 'BUY', status: 'PENDING', leaseOwner: null, leaseExpiresAtMs: null,
      stateRevision: 0n, strategyId: 'canary-target', strategyVersion: 1,
      decisionFingerprint: 'd'.repeat(64), mint: publicKey,
      quoteMint: 'So11111111111111111111111111111111111111112',
      quoteAmountRaw: 90_000n, expiresAtMs: created.intent.expiresAtMs,
    });
  });
});

void test('arms one V2 canary atomically with admission and an exact replay', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const risk = new PostgresExecutionRiskRepository(pool);
    const intents = new PostgresExecutionIntentRepository(pool);
    await risk.registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    const snapshotNowMs = Date.now();
    const walletSnapshot = await risk.appendWalletSnapshot(createExecutionWalletSnapshot({
      generationId, providerId: 'primary', stateRevision: 0n, slot: 10n,
      blockTimeMs: snapshotNowMs - 100, observedAtMs: snapshotNowMs - 50, commitment: 'finalized',
      walletLamports: 1_000_000n, tokenBalanceCount: 0, openPositions: [], realizedNetPnlRaw: 0n,
    }));
    const providerSnapshot = createProviderUsageSnapshot({
      providerId: 'primary', planId: 'canary-v1', billingPeriodId: 'period-1',
      billingPeriodStartedAtMs: snapshotNowMs - 60_000, billingPeriodEndsAtMs: snapshotNowMs + 600_000,
      limitUnits: 1_000n, usedUnits: 1n, measuredAtMs: snapshotNowMs - 50,
      expiresAtMs: snapshotNowMs + 300_000, provenance: 'OPERATOR_REPORT',
    });
    await risk.appendProviderUsage(providerSnapshot);
    const simulation = await seedSuccessfulSimulation(pool);
    const nowMs = Date.now();
    const template = safetyQualification(nowMs, simulation);
    const qualification = qualificationWithCanarySnapshots(template, walletSnapshot, providerSnapshot);
    const repository = new PostgresExecutionOperationsRepository(pool);
    await repository.persistQualification(qualification);
    const resumeAuthorization = createOperatorAuthorization({
      payloadVersion: 1, generationId, action: 'RESUME', phase: null,
      contextFingerprint: qualification.qualificationFingerprint, nonceHash: '9'.repeat(64),
      operatorId: 'operator-primary', issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
    });
    await repository.recordAuthorization(resumeAuthorization);
    await repository.resume({
      payloadVersion: 1, commandId: 'command:canary-resume', generationId,
      qualificationId: qualification.qualificationId, authorization: resumeAuthorization,
      operatorId: 'operator-primary', occurredAtMs: nowMs,
    });
    const target = await intents.create(createExecutionIntentDraft({
      strategyId: 'canary-target', strategyVersion: 1,
      positionId: 'position:canary-target', logicalCommandId: 'command:canary-target',
      mint: publicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
      quoteMint: 'So11111111111111111111111111111111111111112',
      quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
      quoteAmountRaw: 40_000n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
      decisionEventId: 'decision:canary-target', decisionFingerprint: 'd'.repeat(64),
      requestedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 120_000,
    }));
    const policy = canaryPolicy();
    const evidence = createExecutionCanaryEvidence({
      payloadVersion: 1, qualification, targetIntentId: target.intent.id, policy,
      walletSnapshot, providerSnapshot, allEndpointsUnavailable: false,
      capturedAtMs: nowMs, expiresAtMs: nowMs + 120_000,
    });
    const request = createExecutionArmamentRequestV2({
      payloadVersion: 2, qualification, targetIntentId: target.intent.id, policy,
      walletSnapshot, providerSnapshot, allEndpointsUnavailable: false,
      capturedAtMs: nowMs, expiresAtMs: nowMs + 120_000,
      target: {
        intentId: target.intent.id, stateRevision: target.intent.stateRevision,
        strategyId: target.intent.strategyId, strategyVersion: target.intent.strategyVersion,
        decisionFingerprint: target.intent.decisionFingerprint, mint: target.intent.mint,
        quoteMint: target.intent.quoteMint, quoteAmountRaw: target.intent.quoteAmountRaw,
      },
      maximumBuys: 1, maximumCapitalLamports: 40_000n, maximumExposureBps: 500n,
      maximumOpenPositions: 1, maximumHoldingMs: 30_000, runtimeQuoteMaxAgeMs: 60_000,
      runtimeSlippageBps: 100n, runtimeSnapshotMaxSlotLag: 8,
      runtimeMaxComputeUnits: 200_000n, runtimeMaxFeeLamports: 5_000n,
      runtimeMaxFeePayerLamportDebit: 100_000n, runtimeMaxRpcCallsPerAttempt: 12,
      runtimeLeaseMs: 3_000, armedAtMs: nowMs, armamentExpiresAtMs: nowMs + 120_000,
      operatorId: 'operator-primary', operatorReason: 'Mainnet canary manually approved.',
    });
    assert.equal(request.evidenceFingerprint, evidence.evidenceFingerprint);
    const authorization = createOperatorAuthorizationV2({
      payloadVersion: 2, generationId, action: 'ARM', phase: 'CANARY',
      contextFingerprint: request.armamentRequestFingerprint, nonceHash: 'e'.repeat(64),
      operatorId: 'operator-primary', issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
    });
    const input = Object.freeze({ request, authorization });
    const first = await repository.armCanary(input);
    assert.deepEqual(await repository.armCanary(input), first);
    assert.equal(first.state, 'ARMED');
    const counts = await pool.query(`SELECT
      (SELECT COUNT(*) FROM execution_risk_admission_reports)::INTEGER AS reports,
      (SELECT COUNT(*) FROM execution_exposure_reservations)::INTEGER AS reservations,
      (SELECT COUNT(*) FROM execution_provider_usage_counters)::INTEGER AS counters,
      (SELECT COUNT(*) FROM execution_activation_armaments WHERE payload_version=2)::INTEGER AS armaments`);
    assert.deepEqual(counts.rows, [{ reports: 1, reservations: 1, counters: 1, armaments: 1 }]);
    await repository.setStop({
      payloadVersion: 1, commandId: 'command:revoke-v2-canary', generationId,
      operatorId: 'operator-primary', occurredAtMs: Date.now(),
    }, 'ENTRY_STOP');
    const released = await pool.query(`SELECT armament.state,reservation.state AS reservation_state,
      risk.reserved_exposure_raw::TEXT AS reserved_exposure_raw,risk.open_positions
      FROM execution_activation_armaments AS armament
      JOIN execution_exposure_reservations AS reservation
        ON reservation.reservation_id=armament.target_reservation_id
      JOIN execution_wallet_risk_state AS risk ON risk.generation_id=armament.generation_id
      WHERE armament.armament_id=$1`, [first.armamentId]);
    assert.deepEqual(released.rows, [{
      state: 'REVOKED', reservation_state: 'RELEASED', reserved_exposure_raw: '0', open_positions: 0,
    }]);
  });
});

void test('serializes concurrent divergent V2 canary requests to one admitted armament', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const fixture = await prepareCanaryArmament(pool);
    const alternateRequest = createCanaryRequest({
      qualification: fixture.qualification, target: fixture.target,
      walletSnapshot: fixture.walletSnapshot, providerSnapshot: fixture.providerSnapshot,
      nowMs: fixture.nowMs, operatorReason: 'A distinct signed operator rationale.',
    });
    const alternateAuthorization = createOperatorAuthorizationV2({
      payloadVersion: 2, generationId, action: 'ARM', phase: 'CANARY',
      contextFingerprint: alternateRequest.armamentRequestFingerprint, nonceHash: 'f'.repeat(64),
      operatorId: 'operator-primary', issuedAtMs: fixture.nowMs, expiresAtMs: fixture.nowMs + 60_000,
    });
    const results = await Promise.allSettled([
      fixture.repository.armCanary(Object.freeze({
        request: fixture.request, authorization: fixture.authorization,
      })),
      fixture.repository.armCanary(Object.freeze({
        request: alternateRequest, authorization: alternateAuthorization,
      })),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const counts = await pool.query(`SELECT
      (SELECT COUNT(*) FROM execution_risk_admission_reports)::INTEGER AS reports,
      (SELECT COUNT(*) FROM execution_exposure_reservations)::INTEGER AS reservations,
      (SELECT COUNT(*) FROM execution_provider_usage_counters)::INTEGER AS counters,
      (SELECT COUNT(*) FROM execution_operator_authorizations WHERE payload_version=2)::INTEGER AS authorizations,
      (SELECT COUNT(*) FROM execution_activation_armaments WHERE payload_version=2)::INTEGER AS armaments`);
    assert.deepEqual(counts.rows, [{
      reports: 1, reservations: 1, counters: 1, authorizations: 1, armaments: 1,
    }]);
  });
});

void test('rolls every arm side effect back when admission rejects unknown wallet risk', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const fixture = await prepareCanaryArmament(pool);
    await pool.query(`UPDATE execution_wallet_risk_state SET unknown_block=TRUE
      WHERE generation_id=$1`, [generationId]);
    await assert.rejects(fixture.repository.armCanary(Object.freeze({
      request: fixture.request, authorization: fixture.authorization,
    })), isRepositoryError('CONFLICT'));
    const counts = await pool.query(`SELECT
      (SELECT COUNT(*) FROM execution_wallet_snapshots)::INTEGER AS wallet_snapshots,
      (SELECT COUNT(*) FROM execution_provider_usage_snapshots)::INTEGER AS provider_snapshots,
      (SELECT COUNT(*) FROM execution_risk_admission_reports)::INTEGER AS reports,
      (SELECT COUNT(*) FROM execution_exposure_reservations)::INTEGER AS reservations,
      (SELECT COUNT(*) FROM execution_provider_usage_counters)::INTEGER AS counters,
      (SELECT COUNT(*) FROM execution_operator_authorizations WHERE payload_version=2)::INTEGER AS authorizations,
      (SELECT COUNT(*) FROM execution_activation_armaments WHERE payload_version=2)::INTEGER AS armaments,
      (SELECT reserved_exposure_raw::TEXT FROM execution_wallet_risk_state WHERE generation_id=$1)
        AS reserved_exposure_raw`, [generationId]);
    assert.deepEqual(counts.rows, [{
      wallet_snapshots: 0, provider_snapshots: 0, reports: 0, reservations: 0,
      counters: 0, authorizations: 0, armaments: 0, reserved_exposure_raw: '0',
    }]);
  });
});

void test('rejects a divergent or leased canary target before side effects', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const fixture = await prepareCanaryArmament(pool);
    const divergentRequest = createCanaryRequest({
      qualification: fixture.qualification, target: fixture.target,
      walletSnapshot: fixture.walletSnapshot, providerSnapshot: fixture.providerSnapshot,
      nowMs: fixture.nowMs, decisionFingerprint: 'c'.repeat(64),
    });
    const divergentAuthorization = createOperatorAuthorizationV2({
      payloadVersion: 2, generationId, action: 'ARM', phase: 'CANARY',
      contextFingerprint: divergentRequest.armamentRequestFingerprint, nonceHash: 'b'.repeat(64),
      operatorId: 'operator-primary', issuedAtMs: fixture.nowMs, expiresAtMs: fixture.nowMs + 60_000,
    });
    await assert.rejects(fixture.repository.armCanary(Object.freeze({
      request: divergentRequest, authorization: divergentAuthorization,
    })), isRepositoryError('CONFLICT'));
    const claim = await fixture.intents.claim({
      ownerId: 'canary-lease-holder', leaseMs: 30_000, purpose: 'EXECUTE',
    });
    assert.notEqual(claim, null);
    await assert.rejects(fixture.repository.armCanary(Object.freeze({
      request: fixture.request, authorization: fixture.authorization,
    })), isRepositoryError('CONFLICT'));
    await assertNoCanaryArmSideEffects(pool);
  });
});

void test('refuses canary evidence whose wallet and provider snapshots were superseded', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const fixture = await prepareCanaryArmament(pool);
    await fixture.risk.appendWalletSnapshot(fixture.walletSnapshot);
    await fixture.risk.appendProviderUsage(fixture.providerSnapshot);
    await fixture.risk.appendWalletSnapshot(createExecutionWalletSnapshot({
      generationId: fixture.walletSnapshot.generationId,
      providerId: fixture.walletSnapshot.providerId,
      stateRevision: fixture.walletSnapshot.stateRevision + 1n,
      slot: fixture.walletSnapshot.slot + 1n,
      blockTimeMs: fixture.walletSnapshot.blockTimeMs,
      observedAtMs: fixture.walletSnapshot.observedAtMs + 1,
      commitment: fixture.walletSnapshot.commitment,
      walletLamports: fixture.walletSnapshot.walletLamports,
      tokenBalanceCount: fixture.walletSnapshot.tokenBalanceCount,
      openPositions: fixture.walletSnapshot.openPositions,
      realizedNetPnlRaw: fixture.walletSnapshot.realizedNetPnlRaw,
    }));
    await fixture.risk.appendProviderUsage(createProviderUsageSnapshot({
      providerId: fixture.providerSnapshot.providerId, planId: fixture.providerSnapshot.planId,
      billingPeriodId: fixture.providerSnapshot.billingPeriodId,
      billingPeriodStartedAtMs: fixture.providerSnapshot.billingPeriodStartedAtMs,
      billingPeriodEndsAtMs: fixture.providerSnapshot.billingPeriodEndsAtMs,
      limitUnits: fixture.providerSnapshot.limitUnits,
      usedUnits: fixture.providerSnapshot.usedUnits + 1n,
      measuredAtMs: fixture.providerSnapshot.measuredAtMs + 1,
      expiresAtMs: fixture.providerSnapshot.expiresAtMs,
      provenance: fixture.providerSnapshot.provenance,
    }));
    await assert.rejects(fixture.repository.armCanary(Object.freeze({
      request: fixture.request, authorization: fixture.authorization,
    })), isRepositoryError('CONFLICT'));
    await assertNoCanaryArmSideEffects(pool);
    assert.deepEqual((await pool.query(`SELECT
      (SELECT COUNT(*) FROM execution_wallet_snapshots)::INTEGER AS wallet_snapshots,
      (SELECT COUNT(*) FROM execution_provider_usage_snapshots)::INTEGER AS provider_snapshots`)).rows, [{
      wallet_snapshots: 2, provider_snapshots: 2,
    }]);
  });
});

void test('expires and releases a stale exact V2 replay before rejecting it', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const fixture = await prepareCanaryArmament(pool);
    const expiresAtMs = fixture.nowMs + 7_000;
    const request = createCanaryRequest({
      qualification: fixture.qualification, target: fixture.target,
      walletSnapshot: fixture.walletSnapshot, providerSnapshot: fixture.providerSnapshot,
      nowMs: fixture.nowMs, armamentExpiresAtMs: expiresAtMs,
    });
    const authorization = createOperatorAuthorizationV2({
      payloadVersion: 2, generationId, action: 'ARM', phase: 'CANARY',
      contextFingerprint: request.armamentRequestFingerprint, nonceHash: 'c'.repeat(64),
      operatorId: 'operator-primary', issuedAtMs: fixture.nowMs, expiresAtMs: fixture.nowMs + 60_000,
    });
    const armament = await fixture.repository.armCanary(Object.freeze({ request, authorization }));
    await new Promise((resolve) => setTimeout(resolve, 7_100));
    await assert.rejects(fixture.repository.armCanary(Object.freeze({ request, authorization })),
      isRepositoryError('CONFLICT'));
    const released = await pool.query(`SELECT armament.state,reservation.state AS reservation_state,
      risk.reserved_exposure_raw::TEXT AS reserved_exposure_raw,risk.open_positions
      FROM execution_activation_armaments AS armament
      JOIN execution_exposure_reservations AS reservation
        ON reservation.reservation_id=armament.target_reservation_id
      JOIN execution_wallet_risk_state AS risk ON risk.generation_id=armament.generation_id
      WHERE armament.armament_id=$1`, [armament.armamentId]);
    assert.deepEqual(released.rows, [{
      state: 'EXPIRED', reservation_state: 'RELEASED', reserved_exposure_raw: '0', open_positions: 0,
    }]);
  });
});

void test('does not terminalize a V2 LOCKED armament from an operations stop', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const fixture = await prepareCanaryArmament(pool);
    const armament = await fixture.repository.armCanary(Object.freeze({
      request: fixture.request, authorization: fixture.authorization,
    }));
    const claimed = await fixture.intents.claim({
      ownerId: 'canary-lock-holder', leaseMs: 30_000, purpose: 'EXECUTE',
    });
    if (claimed === null) assert.fail('Expected the canary target to be claimed.');
    const processingIntent = await fixture.intents.transition(claimed, {
      intentId: claimed.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
      leaseToken: claimed.leaseToken, reasonCode: 'EXECUTION_STARTED',
      humanMessage: 'Canary lock test started.', activationPhase: 'CANARY',
      evidence: Object.freeze({
        payloadVersion: 1, attemptNumber: null, sourceEventId: null, observedAtMs: fixture.nowMs,
      }),
    });
    const processing = Object.freeze({ ...claimed, intent: processingIntent });
    await fixture.intents.beginAttempt(processing);
    await pool.query('SET session_replication_role = replica');
    try {
      await pool.query(`UPDATE execution_activation_armaments SET
        state='LOCKED',state_revision=1,consumed_buys=1,locked_intent_id=target_intent_id,
        locked_attempt_number=1,locked_reservation_id=target_reservation_id,
        locked_lease_token=$2::UUID,locked_at=date_trunc('milliseconds',statement_timestamp())
        WHERE armament_id=$1`, [armament.armamentId, processing.leaseToken]);
    } finally {
      await pool.query('SET session_replication_role = origin');
    }
    await fixture.repository.setStop({
      payloadVersion: 1, commandId: 'command:stop-locked-v2-canary', generationId,
      operatorId: 'operator-primary', occurredAtMs: Date.now(),
    }, 'ENTRY_STOP');
    const preserved = await pool.query(`SELECT armament.state,reservation.state AS reservation_state,
      risk.reserved_exposure_raw::TEXT AS reserved_exposure_raw,risk.open_positions
      FROM execution_activation_armaments AS armament
      JOIN execution_exposure_reservations AS reservation
        ON reservation.reservation_id=armament.target_reservation_id
      JOIN execution_wallet_risk_state AS risk ON risk.generation_id=armament.generation_id
      WHERE armament.armament_id=$1`, [armament.armamentId]);
    assert.deepEqual(preserved.rows, [{
      state: 'LOCKED', reservation_state: 'RESERVED', reserved_exposure_raw: '40000', open_positions: 1,
    }]);
  });
});

void test('qualification, resume and inert armament replay durably without live capability', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const simulation = await seedSuccessfulSimulation(pool);
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId,
      payloadVersion: 1,
      walletPublicKey: publicKey,
      cluster: 'mainnet-beta',
      genesisHash: publicKey,
      generation: 1,
    });
    const repository = new PostgresExecutionOperationsRepository(pool);
    const nowMs = Date.now();
    const qualification = safetyQualification(nowMs, simulation);
    assert.deepEqual(await repository.persistQualification(qualification), qualification);
    assert.deepEqual(await repository.persistQualification(qualification), qualification);

    const stopped = await repository.setStop({
      payloadVersion: 1,
      commandId: 'command:initial-entry-stop',
      generationId,
      operatorId: 'operator-primary',
      occurredAtMs: nowMs + 1,
    }, 'ENTRY_STOP');
    assert.equal(stopped.controlState, 'ENTRY_STOP');
    assert.equal(stopped.controlRevision, 1n);

    const futureAuthorization = createOperatorAuthorization({
      payloadVersion: 1, generationId, action: 'RESUME', phase: null,
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: '9'.repeat(64), operatorId: 'operator-primary',
      issuedAtMs: nowMs + 30_000, expiresAtMs: nowMs + 60_000,
    });
    await assert.rejects(repository.recordAuthorization(futureAuthorization),
      isRepositoryError('CONFLICT'));

    const resumeAuthorization = createOperatorAuthorization({
      payloadVersion: 1,
      generationId,
      action: 'RESUME',
      phase: null,
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: 'b'.repeat(64),
      operatorId: 'operator-primary',
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + 60_000,
    });
    assert.equal(await repository.recordAuthorization(resumeAuthorization), 'RECORDED');
    assert.equal(await repository.recordAuthorization(resumeAuthorization), 'REPLAYED');
    const running = await repository.resume({
      payloadVersion: 1,
      commandId: 'command:resume',
      generationId,
      qualificationId: qualification.qualificationId,
      authorization: resumeAuthorization,
      operatorId: 'operator-primary',
      occurredAtMs: nowMs + 2,
    });
    assert.equal(running.controlState, 'RUNNING');

    const armAuthorization = createOperatorAuthorization({
      payloadVersion: 1,
      generationId,
      action: 'ARM',
      phase: 'CANARY',
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: 'c'.repeat(64),
      operatorId: 'operator-primary',
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + 60_000,
    });
    await assert.rejects(repository.recordAuthorization(armAuthorization),
      isRepositoryError('CONFLICT'));
    const status = await repository.readStatus(generationId);
    assert.equal(status.controlState, 'RUNNING');
    assert.equal(status.activeArmamentId, null);
    assert.equal(status.activeArmamentPhase, null);
    assert.equal(status.latestQualificationId, qualification.qualificationId);
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_activation_events`)).rows[0]?.count, 0);
    for (const query of [
      `UPDATE execution_safety_qualifications SET build_hash='${'f'.repeat(64)}'`,
      `UPDATE execution_safety_gate_evidence SET evidence_id='rewritten'`,
      `UPDATE execution_operator_authorizations SET operator_id='rewritten'`,
      `UPDATE execution_control_events SET operator_id='rewritten'`,
    ]) await assert.rejects(pool.query(query), /immutable/u);
  });
});

void test('armament fails closed while stopped and a hard stop cannot be downgraded', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const simulation = await seedSuccessfulSimulation(pool);
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    const repository = new PostgresExecutionOperationsRepository(pool);
    const nowMs = Date.now();
    const qualification = safetyQualification(nowMs, simulation);
    await repository.persistQualification(qualification);
    const authorization = createOperatorAuthorization({
      payloadVersion: 1, generationId, action: 'ARM', phase: 'CANARY',
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: 'd'.repeat(64), operatorId: 'operator-primary',
      issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
    });
    await assert.rejects(repository.recordAuthorization(authorization),
      isRepositoryError('CONFLICT'));
    await repository.setStop({
      payloadVersion: 1, commandId: 'command:hard-stop', generationId,
      operatorId: 'operator-primary', occurredAtMs: nowMs + 2,
    }, 'HARD_STOP');
    await assert.rejects(repository.setStop({
      payloadVersion: 1, commandId: 'command:downgrade', generationId,
      operatorId: 'operator-primary', occurredAtMs: nowMs + 3,
    }, 'ENTRY_STOP'), isRepositoryError('CONFLICT'));
  });
});

void test('preflight rejects absent or mismatched #51-D Mainnet simulation evidence', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const simulation = await seedSuccessfulSimulation(pool);
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    const repository = new PostgresExecutionOperationsRepository(pool);
    const nowMs = Date.now();
    const valid = safetyQualification(nowMs, simulation);
    const gates = valid.gates.map((gate) => gate.gateId === 'MAINNET_PREFLIGHT_SIMULATED'
      ? { ...gate, evidenceFingerprint: 'f'.repeat(64) }
      : gate);
    const mismatched = createSafetyQualification({
      payloadVersion: 1, evaluatorVersion: 1, phase: valid.phase,
      buildHash: valid.buildHash,
      configurationFingerprint: valid.configurationFingerprint,
      strategyFingerprint: valid.strategyFingerprint, generationId: valid.generationId,
      walletPublicKey: valid.walletPublicKey, cluster: valid.cluster,
      genesisHash: valid.genesisHash, providerId: valid.providerId,
      qualifiedAtMs: valid.qualifiedAtMs, expiresAtMs: valid.expiresAtMs, gates,
    });
    await assert.rejects(repository.persistQualification(mismatched),
      isRepositoryError('CONFLICT'));
    await assert.rejects(
      repository.persistQualification(safetyQualification(nowMs, simulation, '2'.repeat(64))),
      isRepositoryError('CONFLICT'),
    );
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_safety_qualifications`)).rows[0]?.count, 0);
  });
});

void test('identical concurrent preflights replay after the generation lock', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const simulation = await seedSuccessfulSimulation(pool);
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    const repository = new PostgresExecutionOperationsRepository(pool);
    const qualification = safetyQualification(Date.now(), simulation);
    const results = await Promise.all([
      repository.persistQualification(qualification),
      repository.persistQualification(qualification),
    ]);
    assert.deepEqual(results, [qualification, qualification]);
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_safety_qualifications`)).rows[0]?.count, 1);
  });
});

void test('identical concurrent operator authorizations replay exactly once', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    const repository = new PostgresExecutionOperationsRepository(pool);
    const nowMs = Date.now();
    const authorization = createOperatorAuthorization({
      payloadVersion: 1, generationId, action: 'RESUME', phase: null,
      contextFingerprint: hash, nonceHash: 'e'.repeat(64),
      operatorId: 'operator-primary', issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
    });
    assert.deepEqual((await Promise.all([
      repository.recordAuthorization(authorization),
      repository.recordAuthorization(authorization),
    ])).sort(), ['RECORDED', 'REPLAYED']);
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_operator_authorizations`)).rows[0]?.count, 1);
  });
});

void test('database rejects a direct transition to RUNNING without guarded evidence', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    await pool.query(`INSERT INTO execution_control_state (generation_id)
      VALUES ($1)`, [generationId]);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 51005))',
        [generationId],
      );
      const mutation = pool.query(`UPDATE execution_control_state SET
        state='RUNNING',state_revision=1,updated_at=date_trunc('milliseconds',statement_timestamp())
        WHERE generation_id=$1`, [generationId]);
      let settled = false;
      void mutation.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(settled, false, 'guard must wait for the shared generation lock');
      await blocker.query('ROLLBACK');
      await assert.rejects(mutation, /guarded control transition/u);
    } finally {
      try { await blocker.query('ROLLBACK'); } catch { /* already released */ }
      blocker.release();
    }
  });
});

void test('V1 ARM authorization remains forbidden while risk is unknown', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const simulation = await seedSuccessfulSimulation(pool);
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    const repository = new PostgresExecutionOperationsRepository(pool);
    const qualification = safetyQualification(Date.now(), simulation);
    await repository.persistQualification(qualification);
    const resumeAuthorization = createOperatorAuthorization({
      payloadVersion: 1, generationId, action: 'RESUME', phase: null,
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: '4'.repeat(64), operatorId: 'operator-primary',
      issuedAtMs: qualification.qualifiedAtMs,
      expiresAtMs: qualification.qualifiedAtMs + 60_000,
    });
    await repository.recordAuthorization(resumeAuthorization);
    await repository.resume({
      payloadVersion: 1, commandId: 'command:risk-resume', generationId,
      qualificationId: qualification.qualificationId,
      authorization: resumeAuthorization, operatorId: 'operator-primary',
      occurredAtMs: qualification.qualifiedAtMs + 1,
    });
    await pool.query(`UPDATE execution_wallet_risk_state
      SET unknown_block=TRUE WHERE generation_id=$1`, [generationId]);
    const legacyAuthorization = createOperatorAuthorization({
      payloadVersion: 1, generationId, action: 'ARM', phase: 'CANARY',
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: '8'.repeat(64), operatorId: 'operator-primary',
      issuedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
    });
    await assert.rejects(repository.recordAuthorization(legacyAuthorization),
      isRepositoryError('CONFLICT'));
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_operator_authorizations
      WHERE action='ARM'`)).rows[0]?.count, 0);
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_activation_armaments`)).rows[0]?.count, 0);
  });
});

void test('latest migration refuses the obsolete V1 arm path after a resume', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const simulation = await seedSuccessfulSimulation(pool);
    await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
      generationId, payloadVersion: 1, walletPublicKey: publicKey,
      cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
    });
    const repository = new PostgresExecutionOperationsRepository(pool);
    const nowMs = Date.now();
    const qualification = safetyQualification(nowMs, simulation);
    await repository.persistQualification(qualification);
    const resumeAuthorization = createOperatorAuthorization({
      payloadVersion: 1, generationId, action: 'RESUME', phase: null,
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: '7'.repeat(64), operatorId: 'operator-primary',
      issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
    });
    await repository.recordAuthorization(resumeAuthorization);
    await repository.resume({
      payloadVersion: 1, commandId: 'command:expiry-resume', generationId,
      qualificationId: qualification.qualificationId,
      authorization: resumeAuthorization, operatorId: 'operator-primary',
      occurredAtMs: nowMs + 1,
    });
    const legacyAuthorization = createOperatorAuthorization({
      payloadVersion: 1, generationId, action: 'ARM', phase: 'CANARY',
      contextFingerprint: qualification.qualificationFingerprint,
      nonceHash: '6'.repeat(64), operatorId: 'operator-primary',
      issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
    });
    await assert.rejects(repository.recordAuthorization(legacyAuthorization),
      isRepositoryError('CONFLICT'));
    assert.equal((await repository.readStatus(generationId)).activeArmamentId, null);
  });
});

function safetyQualification(
  nowMs: number,
  simulation: Awaited<ReturnType<typeof seedSuccessfulSimulation>>,
  buildHash = hash,
) {
  const evidenceTypes = [
    'CI_RUN', 'MIGRATION_TEST', 'ARCHITECTURE_TEST', 'DRY_RUN_TEST',
    'SIMULATION_ARTIFACT', 'FAULT_TEST', 'RECONCILIATION_STATE',
    'PROVIDER_SNAPSHOT', 'STOP_CONTROL_TEST', 'WALLET_SNAPSHOT',
    'MAINNET_SIMULATION_ARTIFACT',
  ] as const;
  return createSafetyQualification({
    payloadVersion: 1, evaluatorVersion: 1, phase: 'CANARY',
    buildHash, configurationFingerprint: simulation.configurationFingerprint,
    strategyFingerprint: '3'.repeat(64), generationId, walletPublicKey: publicKey,
    cluster: 'mainnet-beta', genesisHash: publicKey, providerId: 'primary',
    qualifiedAtMs: nowMs, expiresAtMs: nowMs + 300_000,
    gates: EXECUTION_SAFETY_GATE_IDS.map((gateId, index) => ({
      payloadVersion: 1, gateId, status: 'PASSED', evidenceType: evidenceTypes[index],
      evidenceId: gateId === 'MAINNET_PREFLIGHT_SIMULATED'
        ? simulation.artifactId : `evidence:${index}`,
      evidenceFingerprint: gateId === 'MAINNET_PREFLIGHT_SIMULATED'
        ? createMainnetSimulationEvidenceFingerprint({
          artifactId: simulation.artifactId,
          resultFingerprint: simulation.resultFingerprint,
          buildHash,
          configurationFingerprint: simulation.configurationFingerprint,
          strategyFingerprint: '3'.repeat(64),
          walletPublicKey: publicKey,
          genesisHash: publicKey,
          providerId: 'primary',
        })
        : index.toString(16).repeat(64),
      observedAtMs: gateId === 'MAINNET_PREFLIGHT_SIMULATED'
        ? simulation.recordedAtMs : nowMs - 1_000 + index,
      expiresAtMs: nowMs + 300_000,
    })),
  });
}

function qualificationWithCanarySnapshots(
  template: ReturnType<typeof safetyQualification>,
  walletSnapshot: ReturnType<typeof createExecutionWalletSnapshot>,
  providerSnapshot: ReturnType<typeof createProviderUsageSnapshot>,
) {
  return createSafetyQualification({
    payloadVersion: template.payloadVersion,
    evaluatorVersion: template.evaluatorVersion,
    phase: template.phase,
    buildHash: template.buildHash,
    configurationFingerprint: template.configurationFingerprint,
    strategyFingerprint: template.strategyFingerprint,
    generationId: template.generationId,
    walletPublicKey: template.walletPublicKey,
    cluster: template.cluster,
    genesisHash: template.genesisHash,
    providerId: template.providerId,
    qualifiedAtMs: template.qualifiedAtMs,
    expiresAtMs: template.expiresAtMs,
    gates: template.gates.map((gate) => gate.gateId === 'WALLET_CHAIN_LIMITS_VERIFIED'
      ? {
        ...gate, evidenceId: walletSnapshot.snapshotId,
        evidenceFingerprint: walletSnapshot.snapshotFingerprint,
      }
      : gate.gateId === 'PROVIDER_EXIT_CAPACITY_VERIFIED'
        ? {
          ...gate, evidenceId: providerSnapshot.snapshotId,
          evidenceFingerprint: providerSnapshot.snapshotFingerprint,
        }
        : gate),
  });
}

function canaryPolicy() {
  return createExecutionRiskPolicy({
    quoteMintAllowlist: ['So11111111111111111111111111111111111111112'],
    initialCapitalLamports: 1_000_000n,
    maximumCapitalLamports: 1_000_000n,
    positionSizeBps: 1_000n,
    maximumOpenPositions: 1,
    maximumTotalExposureBps: 500n,
    drawdownPauseBps: 2_500n,
    feeReserveLamports: 100_000n,
    walletSnapshotMaxAgeMs: 60_000,
    providerUsageMaxAgeMs: 300_000,
    providerEntryCostUnits: 8n,
    providerExitCostUnitsPerPosition: 4n,
    providerConfirmationCostUnitsPerPosition: 2n,
    providerReconciliationCostUnitsPerPosition: 3n,
    providerSafetyMarginUnits: 5n,
    maximumConsecutiveTechnicalFailures: 2,
  });
}

async function seedSuccessfulSimulation(pool: InstanceType<typeof pg.Pool>) {
  const nowMs = Date.now();
  const intents = new PostgresExecutionIntentRepository(pool);
  const created = await intents.create(createExecutionIntentDraft({
    strategyId: 'simulation-strategy', strategyVersion: 1,
    positionId: `position-${randomUUID()}`, logicalCommandId: `command-${randomUUID()}`,
    mint: publicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 1_000n, baseAmountRaw: null, minimumAmountOutRaw: 850n,
    decisionEventId: `event-${randomUUID()}`, decisionFingerprint: hash,
    requestedAtMs: nowMs, expiresAtMs: nowMs + 120_000,
  }));
  const claimed = await intents.claim({
    ownerId: 'preflight-test-worker', leaseMs: 30_000, purpose: 'EXECUTE',
  });
  if (claimed === null) assert.fail('Expected one claimed simulation intent.');
  const processingIntent = await intents.transition(claimed, {
    intentId: created.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
    leaseToken: claimed.leaseToken, reasonCode: 'EXECUTION_STARTED',
    humanMessage: 'Execution simulation started.', activationPhase: 'NONE',
    evidence: Object.freeze({
      payloadVersion: 1, attemptNumber: null, sourceEventId: null, observedAtMs: nowMs,
    }),
  });
  const processing = Object.freeze({ ...claimed, intent: processingIntent });
  const begun = await intents.beginAttempt(processing);
  const artifact = createExecutionSimulationArtifactDraft({
    intentId: begun.claim.intent.id, attemptNumber: begun.attempt.attemptNumber,
    intentStateRevision: begun.claim.intent.stateRevision,
    strategyId: begun.claim.intent.strategyId,
    strategyVersion: begun.claim.intent.strategyVersion,
    decisionFingerprint: begun.claim.intent.decisionFingerprint,
    resultKind: 'SUCCESS', effectiveVenue: 'PUMP_FUN', providerId: 'primary',
    executorPublicKey: publicKey, expectedGenesisHash: publicKey,
    observedGenesisHash: publicKey, configurationFingerprint: hash,
    quoteFingerprint: hash, snapshotFingerprint: hash, buildFingerprint: hash,
    messageHash: hash, blockhash: publicKey, lastValidBlockHeight: 1_000n,
    blockhashContextSlot: 900n, snapshotSlot: 899n, feeContextSlot: 900n,
    simulationSlot: 901n, amountInRaw: 1_000n, expectedAmountOutRaw: 900n,
    protectedAmountOutRaw: 850n, feesRaw: 10n, estimatedFeeLamports: 5_000n,
    simulatedFeePayerLamportDebit: 6_000n, unitsConsumed: 200_000n,
    simulatedBaseDeltaRaw: 900n, simulatedQuoteDeltaRaw: -1_000n,
    rpcCallsUsed: 5, rpcCallsLimit: 8, quoteStatus: 'SUCCEEDED',
    buildStatus: 'SUCCEEDED', simulationStatus: 'SUCCEEDED', failureStage: null,
    failureCode: null, terminalReasonCode: 'INTENT_SUCCEEDED',
    logsFingerprint: hash, logsLineCount: 1,
  });
  return new PostgresExecutionSimulationRepository(pool)
    .complete(begun.claim, artifact, new AbortController().signal);
}

async function prepareCanaryArmament(pool: InstanceType<typeof pg.Pool>) {
  const risk = new PostgresExecutionRiskRepository(pool);
  const intents = new PostgresExecutionIntentRepository(pool);
  await risk.registerWalletGeneration({
    generationId, payloadVersion: 1, walletPublicKey: publicKey,
    cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
  });
  const snapshotNowMs = Date.now();
  const walletSnapshot = createExecutionWalletSnapshot({
    generationId, providerId: 'primary', stateRevision: 0n, slot: 10n,
    blockTimeMs: snapshotNowMs - 100, observedAtMs: snapshotNowMs - 50, commitment: 'finalized',
    walletLamports: 1_000_000n, tokenBalanceCount: 0, openPositions: [], realizedNetPnlRaw: 0n,
  });
  const providerSnapshot = createProviderUsageSnapshot({
    providerId: 'primary', planId: 'canary-v1', billingPeriodId: 'period-1',
    billingPeriodStartedAtMs: snapshotNowMs - 60_000, billingPeriodEndsAtMs: snapshotNowMs + 600_000,
    limitUnits: 1_000n, usedUnits: 1n, measuredAtMs: snapshotNowMs - 50,
    expiresAtMs: snapshotNowMs + 300_000, provenance: 'OPERATOR_REPORT',
  });
  const simulation = await seedSuccessfulSimulation(pool);
  const nowMs = Date.now();
  const qualification = qualificationWithCanarySnapshots(
    safetyQualification(nowMs, simulation), walletSnapshot, providerSnapshot,
  );
  const repository = new PostgresExecutionOperationsRepository(pool);
  await repository.persistQualification(qualification);
  const resumeAuthorization = createOperatorAuthorization({
    payloadVersion: 1, generationId, action: 'RESUME', phase: null,
    contextFingerprint: qualification.qualificationFingerprint, nonceHash: '9'.repeat(64),
    operatorId: 'operator-primary', issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
  });
  await repository.recordAuthorization(resumeAuthorization);
  await repository.resume({
    payloadVersion: 1, commandId: 'command:prepared-canary-resume', generationId,
    qualificationId: qualification.qualificationId, authorization: resumeAuthorization,
    operatorId: 'operator-primary', occurredAtMs: nowMs,
  });
  const target = await intents.create(createExecutionIntentDraft({
    strategyId: 'canary-target', strategyVersion: 1,
    positionId: 'position:canary-target', logicalCommandId: 'command:canary-target',
    mint: publicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 40_000n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: 'decision:canary-target', decisionFingerprint: 'd'.repeat(64),
    requestedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 120_000,
  }));
  const request = createCanaryRequest({
    qualification, target: target.intent, walletSnapshot, providerSnapshot, nowMs,
  });
  const authorization = createOperatorAuthorizationV2({
    payloadVersion: 2, generationId, action: 'ARM', phase: 'CANARY',
    contextFingerprint: request.armamentRequestFingerprint, nonceHash: 'e'.repeat(64),
    operatorId: 'operator-primary', issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
  });
  return { risk, intents, repository, qualification, target: target.intent, walletSnapshot,
    providerSnapshot, request, authorization, nowMs };
}

function createCanaryRequest(input: Readonly<{
  qualification: ReturnType<typeof safetyQualification>;
  target: Readonly<{
    id: string; stateRevision: bigint; strategyId: string; strategyVersion: number;
    decisionFingerprint: string; mint: string; quoteMint: string; quoteAmountRaw: bigint | null;
  }>;
  walletSnapshot: ReturnType<typeof createExecutionWalletSnapshot>;
  providerSnapshot: ReturnType<typeof createProviderUsageSnapshot>;
  nowMs: number;
  operatorReason?: string;
  decisionFingerprint?: string;
  armamentExpiresAtMs?: number;
}>): ReturnType<typeof createExecutionArmamentRequestV2> {
  if (input.target.quoteAmountRaw === null) throw new Error('Canary target must have quote input.');
  return createExecutionArmamentRequestV2({
    payloadVersion: 2, qualification: input.qualification, targetIntentId: input.target.id,
    policy: canaryPolicy(), walletSnapshot: input.walletSnapshot, providerSnapshot: input.providerSnapshot,
    allEndpointsUnavailable: false, capturedAtMs: input.nowMs, expiresAtMs: input.nowMs + 120_000,
    target: {
      intentId: input.target.id, stateRevision: input.target.stateRevision,
      strategyId: input.target.strategyId, strategyVersion: input.target.strategyVersion,
      decisionFingerprint: input.decisionFingerprint ?? input.target.decisionFingerprint,
      mint: input.target.mint, quoteMint: input.target.quoteMint,
      quoteAmountRaw: input.target.quoteAmountRaw,
    },
    maximumBuys: 1, maximumCapitalLamports: 40_000n, maximumExposureBps: 500n,
    maximumOpenPositions: 1, maximumHoldingMs: 30_000, runtimeQuoteMaxAgeMs: 60_000,
    runtimeSlippageBps: 100n, runtimeSnapshotMaxSlotLag: 8,
    runtimeMaxComputeUnits: 200_000n, runtimeMaxFeeLamports: 5_000n,
    runtimeMaxFeePayerLamportDebit: 100_000n, runtimeMaxRpcCallsPerAttempt: 12,
    runtimeLeaseMs: 3_000, armedAtMs: input.nowMs,
    armamentExpiresAtMs: input.armamentExpiresAtMs ?? input.nowMs + 120_000,
    operatorId: 'operator-primary',
    operatorReason: input.operatorReason ?? 'Mainnet canary manually approved.',
  });
}

async function assertNoCanaryArmSideEffects(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  const counts = await pool.query(`SELECT
    (SELECT COUNT(*) FROM execution_risk_admission_reports)::INTEGER AS reports,
    (SELECT COUNT(*) FROM execution_exposure_reservations)::INTEGER AS reservations,
    (SELECT COUNT(*) FROM execution_provider_usage_counters)::INTEGER AS counters,
    (SELECT COUNT(*) FROM execution_operator_authorizations WHERE payload_version=2)::INTEGER AS authorizations,
    (SELECT COUNT(*) FROM execution_activation_armaments WHERE payload_version=2)::INTEGER AS armaments`);
  assert.deepEqual(counts.rows, [{
    reports: 0, reservations: 0, counters: 0, authorizations: 0, armaments: 0,
  }]);
}

function isRepositoryError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ExecutionOperationsRepositoryError && error.code === code;
}

function testDatabaseUrl(context: Readonly<{ skip(message?: string): void }>): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') return databaseUrl;
  context.skip('TEST_DATABASE_URL absent: execution operations repository test skipped');
  return null;
}

async function withTemporarySchema(
  databaseUrl: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `execution_operations_repository_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl, max: 2,
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
