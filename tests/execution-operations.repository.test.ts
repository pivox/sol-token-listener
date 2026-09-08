import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  createExecutionArmamentRequestV2,
  createExecutionArmamentRequestV3,
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
import {
  createExecutionIntentDraft,
  type ExecutionIntentDraftV1,
} from '../src/domain/execution-intent.js';
import { createExecutionPreflightIntentPairDraft } from '../src/domain/execution-preflight-intent-pair.js';
import { createExecutionSimulationArtifactDraft } from '../src/domain/execution-simulation.js';
import { migrateDatabase } from '../src/storage/database.js';
import {
  PostgresExecutionIntentRepository,
  createExecutionIntentInTransaction,
} from '../src/storage/execution-intent.repository.js';
import { createExecutionPreflightIntentPairInTransaction } from '../src/storage/execution-preflight-intent-pair.repository.js';
import {
  ExecutionOperationsRepositoryError,
  PostgresExecutionOperationsRepository,
} from '../src/storage/execution-operations.repository.js';
import { PostgresExecutionRiskRepository } from '../src/storage/execution-risk.repository.js';
import { PostgresExecutionSimulationRepository } from '../src/storage/execution-simulation.repository.js';
import { insertExecutionDecisionEvent } from './helpers/execution-decision-event.js';
import {
  mutateWithTriggersDisabled,
  seedCanonicalV2Source,
} from './helpers/execution-preflight-v2-source-fixture.js';
import { PostgresExecutionPreflightSourceRepository } from '../src/preflight-source/repository.js';

const publicKey = '11111111111111111111111111111111';
const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
const hash = '1'.repeat(64);

void test('reads the exact unleased BUY intent used as a canary target', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const intents = new PostgresExecutionIntentRepository(pool);
    const nowMs = await currentDatabaseTimeMs(pool);
    await insertExecutionDecisionEvent(pool, 'decision:canary-target', publicKey);
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
    const snapshotNowMs = await currentDatabaseTimeMs(pool);
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
    const nowMs = await currentDatabaseTimeMs(pool);
    const template = safetyQualification(nowMs, simulation);
    const qualification = qualificationWithCanarySnapshots(template, walletSnapshot, providerSnapshot);
    const armQueries: string[] = [];
    const repository = new PostgresExecutionOperationsRepository(
      recordingDatabaseSource(pool, armQueries),
    );
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
    await insertExecutionDecisionEvent(pool, 'decision:canary-target', publicKey);
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
    armQueries.length = 0;
    const first = await repository.armCanary(input);
    const firstArmQueries = [...armQueries];
    assert.deepEqual(await repository.armCanary(input), first);
    assert.equal(first.state, 'ARMED');
    const targetLockIndex = firstArmQueries.findIndex((query) =>
      query.includes('FROM execution_intents WHERE id=$1 FOR UPDATE'));
    const promotionIndex = firstArmQueries.findIndex((query) =>
      /UPDATE execution_intents(?: AS intent)?\s+SET\s+live_reserved\s*=\s*TRUE/iu.test(query));
    const admissionIndex = firstArmQueries.findIndex((query) =>
      query.includes('INSERT INTO execution_risk_admission_reports'));
    const publicationIndex = firstArmQueries.findIndex((query) =>
      query.includes('INSERT INTO execution_activation_armaments'));
    assert.ok(targetLockIndex >= 0);
    assert.match(firstArmQueries[targetLockIndex] ?? '', /\blive_reserved\b/u);
    assert.ok(targetLockIndex < promotionIndex);
    assert.ok(promotionIndex < admissionIndex);
    assert.ok(admissionIndex < publicationIndex);
    const counts = await pool.query(`SELECT
      (SELECT COUNT(*) FROM execution_risk_admission_reports)::INTEGER AS reports,
      (SELECT COUNT(*) FROM execution_exposure_reservations)::INTEGER AS reservations,
      (SELECT COUNT(*) FROM execution_provider_usage_counters)::INTEGER AS counters,
      (SELECT COUNT(*) FROM execution_activation_armaments WHERE payload_version=2)::INTEGER AS armaments,
      (SELECT live_reserved FROM execution_intents WHERE id=$1) AS target_live_reserved`, [
      target.intent.id,
    ]);
    assert.deepEqual(counts.rows, [{
      reports: 1, reservations: 1, counters: 1, armaments: 1, target_live_reserved: true,
    }]);
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

void test('arms a paired target only from the exact fresh H2h V2 source using wire V3',
  async (context) => {
    const databaseUrl = testDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      await migrateDatabase({ pool });
      const fixture = await seedCanonicalV2Source(pool);
      const source = await new PostgresExecutionPreflightSourceRepository(pool).export({
        preparationRunId: fixture.runId,
      });
      await pool.query(`INSERT INTO execution_wallet_risk_state (
        generation_id,reconciled_capital_lamports,reserved_exposure_raw,
        conservative_drawdown_raw
      ) VALUES ($1,0,0,0)`, [source.generation.generationId]);
      const armQueries: string[] = [];
      let pauseFinalLineage = false;
      let signalFinalLineage: (() => void) | undefined;
      let releaseFinalLineage: (() => void) | undefined;
      const finalLineageReached = new Promise<void>((resolve) => { signalFinalLineage = resolve; });
      const finalLineageReleased = new Promise<void>((resolve) => { releaseFinalLineage = resolve; });
      const repository = new PostgresExecutionOperationsRepository(
        recordingDatabaseSource(pool, armQueries, async (query) => {
          if (pauseFinalLineage && query.includes('AS lineage_current')) {
            pauseFinalLineage = false;
            signalFinalLineage?.();
            await finalLineageReleased;
          }
        }),
      );
      const nowMs = await currentDatabaseTimeMs(pool);
      const qualification = qualificationWithCanarySnapshots(
        safetyQualification(nowMs, source.simulation, hash, Object.freeze({
          generationId: source.generation.generationId,
          walletPublicKey: source.generation.walletPublicKey,
          genesisHash: source.generation.genesisHash,
          providerId: source.providerSnapshot.providerId,
        })),
        source.walletSnapshot,
        source.providerSnapshot,
      );
      await repository.persistQualification(qualification);
      const resumeAuthorization = createOperatorAuthorization({
        payloadVersion: 1, generationId: qualification.generationId,
        action: 'RESUME', phase: null,
        contextFingerprint: qualification.qualificationFingerprint,
        nonceHash: 'a'.repeat(64), operatorId: 'operator-primary',
        issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
      });
      await repository.recordAuthorization(resumeAuthorization);
      await repository.resume({
        payloadVersion: 1, commandId: 'command:paired-v3-resume',
        generationId: qualification.generationId,
        qualificationId: qualification.qualificationId,
        authorization: resumeAuthorization, operatorId: 'operator-primary',
        occurredAtMs: nowMs,
      });
      const legacyRequest = createCanaryRequest({
        qualification,
        target: source.target.intent,
        walletSnapshot: source.walletSnapshot,
        providerSnapshot: source.providerSnapshot,
        nowMs,
        evidenceExpiresAtMs: source.expiresAtMs,
        armamentExpiresAtMs: source.expiresAtMs,
      });
      const {
        armamentRequestFingerprint: _legacyFingerprint,
        evidenceId: _legacyEvidenceId,
        evidenceFingerprint: _legacyEvidenceFingerprint,
        payloadVersion: _legacyVersion,
        ...requestFields
      } = legacyRequest;
      const request = createExecutionArmamentRequestV3(Object.freeze({
        ...requestFields,
        payloadVersion: 3,
        lineageProof: Object.freeze({
          preparationRunId: source.lineage.preparationRunId,
          preparationRunFingerprint: source.lineage.preparationRunFingerprint,
          pairId: source.lineage.pairId,
          pairFingerprint: source.lineage.pairFingerprint,
          targetAssessmentId: source.lineage.targetAssessmentId,
          targetAssessmentFingerprint: source.lineage.targetAssessmentFingerprint,
          simulationArtifactId: source.lineage.simulationArtifactId,
          simulationArtifactFingerprint: source.lineage.simulationArtifactFingerprint,
          preparationManifestFingerprint: source.lineage.preparationManifestFingerprint,
          candidateId: source.lineage.candidateId,
          candidateEvidenceFingerprint: source.lineage.candidateEvidenceFingerprint,
          proofFingerprint: source.proofFingerprint,
          sourceCapturedAtMs: source.capturedAtMs,
          sourceExpiresAtMs: source.expiresAtMs,
        }),
      }));
      const authorization = createOperatorAuthorizationV2({
        payloadVersion: 2, generationId: qualification.generationId,
        action: 'ARM', phase: 'CANARY',
        contextFingerprint: request.armamentRequestFingerprint,
        nonceHash: 'b'.repeat(64), operatorId: 'operator-primary',
        issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
      });

      const candidateRetention = (await pool.query<{
        eligible_until: string;
        created_at: string;
        purge_after: string;
      }>(`SELECT eligible_until::TEXT,created_at::TEXT,purge_after::TEXT
        FROM trading_candidates WHERE candidate_id=$1`, [source.lineage.candidateId])).rows[0];
      assert.ok(candidateRetention !== undefined);
      await mutateWithTriggersDisabled(pool,
        `UPDATE trading_candidates SET eligible_until=statement_timestamp()-INTERVAL '1 second'
          WHERE candidate_id=$1`, [source.lineage.candidateId]);
      await assert.rejects(repository.armCanary(Object.freeze({
        request, authorization, preflightSource: source,
      })), isRepositoryError('CONFLICT'));
      await assertNoCanaryArmSideEffects(pool);
      await mutateWithTriggersDisabled(pool,
        `UPDATE trading_candidates SET eligible_until=$2 WHERE candidate_id=$1`,
        [source.lineage.candidateId, candidateRetention.eligible_until]);

      await mutateWithTriggersDisabled(pool,
        `UPDATE trading_candidates SET
          created_at=statement_timestamp()-INTERVAL '5 hours',
          purge_after=statement_timestamp()-INTERVAL '1 hour'
          WHERE candidate_id=$1`, [source.lineage.candidateId]);
      await assert.rejects(repository.armCanary(Object.freeze({
        request, authorization, preflightSource: source,
      })), isRepositoryError('CONFLICT'));
      await assertNoCanaryArmSideEffects(pool);
      await mutateWithTriggersDisabled(pool,
        `UPDATE trading_candidates SET created_at=$2,purge_after=$3 WHERE candidate_id=$1`,
        [source.lineage.candidateId, candidateRetention.created_at, candidateRetention.purge_after]);

      await mutateWithTriggersDisabled(pool,
        `UPDATE execution_preflight_intent_pairs SET pair_fingerprint=repeat('f',64)
          WHERE pair_id=$1`, [fixture.pairId]);
      await assert.rejects(repository.armCanary(Object.freeze({
        request, authorization, preflightSource: source,
      })), isRepositoryError('CONFLICT'));
      await assertNoCanaryArmSideEffects(pool);
      await mutateWithTriggersDisabled(pool,
        `UPDATE execution_preflight_intent_pairs SET pair_fingerprint=$2 WHERE pair_id=$1`,
        [fixture.pairId, source.lineage.pairFingerprint]);

      armQueries.length = 0;
      pauseFinalLineage = true;
      const armamentPromise = repository.armCanary(Object.freeze({
        request, authorization, preflightSource: source,
      }));
      await finalLineageReached;
      try {
        await assertCandidateMutationBlocked(pool, source.lineage.candidateId);
      } finally {
        releaseFinalLineage?.();
      }
      const armament = await armamentPromise;
      assert.equal(armament.payloadVersion, 2);
      assert.equal(armament.armamentRequestFingerprint, request.armamentRequestFingerprint);
      assert.equal((await pool.query<{ live_reserved: boolean }>(
        'SELECT live_reserved FROM execution_intents WHERE id=$1',
        [fixture.targetIntentId],
      )).rows[0]?.live_reserved, true);
      const pairLockIndex = armQueries.findIndex((query) =>
        query.includes('FROM execution_preflight_intent_pairs WHERE pair_id=$1 FOR UPDATE'));
      const targetLockIndex = armQueries.findIndex((query) =>
        query.includes('FROM execution_intents WHERE id=$1 FOR UPDATE'));
      const runLockIndex = armQueries.findIndex((query) =>
        query.includes('FROM execution_preflight_intent_preparation_runs WHERE run_id=$1 FOR UPDATE'));
      const proofLockIndex = armQueries.findIndex((query) =>
        query.includes('FROM execution_dry_run_assessments assessment'));
      const causalLockIndex = armQueries.findIndex((query) =>
        query.includes('FOR UPDATE OF candidate,report,decision,source,candidate_event,'));
      const finalLineageIndex = armQueries.findIndex((query) => query.includes('AS lineage_current'));
      const promotionIndex = armQueries.findIndex((query) =>
        /UPDATE execution_intents(?: AS intent)?\s+SET\s+live_reserved\s*=\s*TRUE/iu.test(query));
      assert.ok(pairLockIndex >= 0);
      assert.ok(pairLockIndex < targetLockIndex);
      assert.ok(targetLockIndex < runLockIndex);
      assert.ok(runLockIndex < proofLockIndex);
      assert.match(armQueries[proofLockIndex] ?? '',
        /FOR UPDATE OF assessment,artifact,attempt,simulation,candidate,generation/iu);
      assert.ok(proofLockIndex < causalLockIndex);
      assert.ok(causalLockIndex < finalLineageIndex);
      assert.ok(finalLineageIndex < promotionIndex);
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
      (SELECT live_reserved FROM execution_intents WHERE id=$2) AS target_live_reserved,
      (SELECT reserved_exposure_raw::TEXT FROM execution_wallet_risk_state WHERE generation_id=$1)
        AS reserved_exposure_raw`, [generationId, fixture.target.id]);
    assert.deepEqual(counts.rows, [{
      wallet_snapshots: 0, provider_snapshots: 0, reports: 0, reservations: 0,
      counters: 0, authorizations: 0, armaments: 0, target_live_reserved: false,
      reserved_exposure_raw: '0',
    }]);
  });
});

void test('rolls the live promotion back when canary publication fails', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const fixture = await prepareCanaryArmament(pool);
    await pool.query(`CREATE FUNCTION reject_canary_publication() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected publication failure'; END $$`);
    await pool.query(`CREATE TRIGGER reject_canary_publication
      BEFORE INSERT ON execution_activation_armaments
      FOR EACH ROW EXECUTE FUNCTION reject_canary_publication()`);

    await assert.rejects(fixture.repository.armCanary(Object.freeze({
      request: fixture.request, authorization: fixture.authorization,
    })), isRepositoryError('DATABASE_FAILURE'));

    await assertNoCanaryArmSideEffects(pool);
    const target = await pool.query(`SELECT live_reserved FROM execution_intents WHERE id=$1`, [
      fixture.target.id,
    ]);
    assert.deepEqual(target.rows, [{ live_reserved: false }]);
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
    const target = await pool.query(`SELECT live_reserved FROM execution_intents WHERE id=$1`, [
      fixture.target.id,
    ]);
    assert.deepEqual(target.rows, [{ live_reserved: false }]);
  });
});

void test('rejects an already live-reserved canary target before admission', async (context) => {
  const databaseUrl = testDatabaseUrl(context);
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, async (pool) => {
    await migrateDatabase({ pool });
    const fixture = await prepareCanaryArmament(pool);
    await pool.query(`UPDATE execution_intents SET live_reserved=TRUE WHERE id=$1`, [
      fixture.target.id,
    ]);

    await assert.rejects(fixture.repository.armCanary(Object.freeze({
      request: fixture.request, authorization: fixture.authorization,
    })), isRepositoryError('CONFLICT'));
    await assertNoCanaryArmSideEffects(pool);
  });
});

void test('legacy H2c V2 refuses every paired lane while unpaired targets remain supported',
  async (context) => {
    const databaseUrl = testDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      await migrateDatabase({ pool });
      const fixture = await prepareCanaryArmament(pool);
      const commandHash = '7'.repeat(64);
      const canonicalTarget = createExecutionIntentDraft({
        strategyId: 'creation-entry-v1', strategyVersion: 1,
        positionId: 'position:paired-canary-target',
        candidateId: `candidate_${'6'.repeat(64)}`,
        logicalCommandId: `paper_open_${commandHash}`,
        mint: publicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
        quoteMint: 'So11111111111111111111111111111111111111112',
        quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
        quoteAmountRaw: 40_000n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
        decisionEventId: 'decision:paired-canary-target',
        decisionFingerprint: 'd'.repeat(64),
        requestedAtMs: fixture.nowMs - 1_000, expiresAtMs: fixture.nowMs + 120_000,
      });
      const pair = createExecutionPreflightIntentPairDraft(canonicalTarget);
      await seedCurrentCausalLineage(pool, canonicalTarget);
      const pairClient = await pool.connect();
      try {
        await pairClient.query('BEGIN');
        await createExecutionIntentInTransaction(pairClient, canonicalTarget);
        await createExecutionPreflightIntentPairInTransaction(pairClient, canonicalTarget);
        await pairClient.query('COMMIT');
      } catch (error) {
        await pairClient.query('ROLLBACK');
        throw error;
      } finally {
        pairClient.release();
      }
      const simulationTarget = Object.freeze({
        ...pair.simulationIntent,
        stateRevision: 0n,
      });
      const pairedTarget = Object.freeze({ ...canonicalTarget, stateRevision: 0n });
      const pairedTargetRequest = createCanaryRequest({
        qualification: fixture.qualification, target: pairedTarget,
        walletSnapshot: fixture.walletSnapshot, providerSnapshot: fixture.providerSnapshot,
        nowMs: fixture.nowMs,
      });
      const pairedTargetAuthorization = createOperatorAuthorizationV2({
        payloadVersion: 2, generationId, action: 'ARM', phase: 'CANARY',
        contextFingerprint: pairedTargetRequest.armamentRequestFingerprint,
        nonceHash: '7'.repeat(64), operatorId: 'operator-primary',
        issuedAtMs: fixture.nowMs, expiresAtMs: fixture.nowMs + 60_000,
      });
      const request = createCanaryRequest({
        qualification: fixture.qualification,
        target: simulationTarget,
        walletSnapshot: fixture.walletSnapshot,
        providerSnapshot: fixture.providerSnapshot,
        nowMs: fixture.nowMs,
      });
      const authorization = createOperatorAuthorizationV2({
        payloadVersion: 2, generationId, action: 'ARM', phase: 'CANARY',
        contextFingerprint: request.armamentRequestFingerprint,
        nonceHash: '8'.repeat(64), operatorId: 'operator-primary',
        issuedAtMs: fixture.nowMs, expiresAtMs: fixture.nowMs + 60_000,
      });
      const queries: string[] = [];
      const guardedRepository = new PostgresExecutionOperationsRepository(
        recordingDatabaseSource(pool, queries),
      );

      await assert.rejects(guardedRepository.armCanary(Object.freeze({
        request: pairedTargetRequest, authorization: pairedTargetAuthorization,
      })), isRepositoryError('CONFLICT'));
      await assert.rejects(guardedRepository.armCanary(Object.freeze({ request, authorization })),
        isRepositoryError('CONFLICT'));
      assert.equal(queries.some((query) => /UPDATE execution_intents(?: AS intent)?\s+SET\s+live_reserved\s*=\s*TRUE/iu.test(query)), false);
      await assertNoCanaryArmSideEffects(pool);
      assert.deepEqual((await pool.query(`SELECT live_reserved FROM execution_intents
        WHERE id=$1`, [pair.simulationIntent.id])).rows, [{ live_reserved: false }]);
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
      ownerId: 'canary-lock-holder', leaseMs: 30_000, purpose: 'LIVE_EXECUTE', side: 'BUY',
      generationId,
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
    const nowMs = await currentDatabaseTimeMs(pool);
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
    const nowMs = await currentDatabaseTimeMs(pool);
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
    const nowMs = await currentDatabaseTimeMs(pool);
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
    const qualification = safetyQualification(await currentDatabaseTimeMs(pool), simulation);
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
    const nowMs = await currentDatabaseTimeMs(pool);
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
    const qualification = safetyQualification(await currentDatabaseTimeMs(pool), simulation);
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
      issuedAtMs: qualification.qualifiedAtMs,
      expiresAtMs: qualification.qualifiedAtMs + 60_000,
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
    const nowMs = await currentDatabaseTimeMs(pool);
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
  identity: Readonly<{
    generationId: string;
    walletPublicKey: string;
    genesisHash: string;
    providerId: string;
  }> = Object.freeze({ generationId, walletPublicKey: publicKey,
    genesisHash: publicKey, providerId: 'primary' }),
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
    strategyFingerprint: '3'.repeat(64), generationId: identity.generationId,
    walletPublicKey: identity.walletPublicKey,
    cluster: 'mainnet-beta', genesisHash: identity.genesisHash, providerId: identity.providerId,
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
          walletPublicKey: identity.walletPublicKey,
          genesisHash: identity.genesisHash,
          providerId: identity.providerId,
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
  const nowMs = await currentDatabaseTimeMs(pool);
  const intents = new PostgresExecutionIntentRepository(pool);
  const decisionEventId = `event-${randomUUID()}`;
  await insertExecutionDecisionEvent(pool, decisionEventId, publicKey);
  const created = await intents.create(createExecutionIntentDraft({
    strategyId: 'simulation-strategy', strategyVersion: 1,
    positionId: `position-${randomUUID()}`, logicalCommandId: `command-${randomUUID()}`,
    mint: publicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY',
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 1_000n, baseAmountRaw: null, minimumAmountOutRaw: 850n,
    decisionEventId, decisionFingerprint: hash,
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
  const snapshotNowMs = await currentDatabaseTimeMs(pool);
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
  const nowMs = await currentDatabaseTimeMs(pool);
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
  await insertExecutionDecisionEvent(pool, 'decision:canary-target', publicKey);
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
  evidenceExpiresAtMs?: number;
  armamentExpiresAtMs?: number;
}>): ReturnType<typeof createExecutionArmamentRequestV2> {
  if (input.target.quoteAmountRaw === null) throw new Error('Canary target must have quote input.');
  return createExecutionArmamentRequestV2({
    payloadVersion: 2, qualification: input.qualification, targetIntentId: input.target.id,
    policy: canaryPolicy(), walletSnapshot: input.walletSnapshot, providerSnapshot: input.providerSnapshot,
    allEndpointsUnavailable: false, capturedAtMs: input.nowMs,
    expiresAtMs: input.evidenceExpiresAtMs ?? input.nowMs + 120_000,
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

async function seedCurrentCausalLineage(
  pool: InstanceType<typeof pg.Pool>,
  intent: ExecutionIntentDraftV1,
): Promise<void> {
  if (intent.candidateId === null) throw new TypeError('Candidate lineage is missing.');
  const reportId = `qreport_${'3'.repeat(64)}`;
  const qualificationEventId = `evt_${'4'.repeat(64)}`;
  const candidateEventId = `evt_${'5'.repeat(64)}`;
  const rawEventId = `raw_lineage_${intent.candidateId.slice(-16)}`;
  const signature = `lineage-${intent.candidateId}`;
  const candidatePayload = Object.freeze({ id: intent.candidateId,
    qualificationReportId: reportId, mint: intent.mint });
  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,quote_assets,current_state,
    created_signature,created_slot,created_transaction_index,created_instruction_index,
    detected_at,updated_at
  ) VALUES ($1,'pumpfun','pumpfun','creator','SPL_TOKEN','[]','OBSERVING',
    $2,1,0,0,date_trunc('milliseconds',statement_timestamp()),
    date_trunc('milliseconds',statement_timestamp())) ON CONFLICT (mint) DO NOTHING`,
  [intent.mint, signature]);
  await pool.query(`INSERT INTO raw_chain_events (
    event_id,source,program,mint,signature,slot,transaction_index,instruction_index,
    confirmation_status,observed_at,payload_version,payload,processing_status
  ) VALUES ($1,'pumpfun','pumpfun',$2,$3,1,0,0,'finalized',
    date_trunc('milliseconds',statement_timestamp()),1,'{}','processed')`,
  [rawEventId, intent.mint, signature]);
  for (const event of [
    [qualificationEventId, 'QualificationUpdated', 'qualification', Object.freeze({})],
    [candidateEventId, 'TradingCandidateUpdated', 'paper-decision', Object.freeze({ candidate: candidatePayload })],
    [intent.decisionEventId, 'PaperStrategySessionUpdated', 'paper-decision', Object.freeze({
      session: Object.freeze({ candidateId: intent.candidateId, qualificationReportId: reportId,
        positionId: intent.positionId, mint: intent.mint }),
    })],
  ] as const) {
    await pool.query(`INSERT INTO domain_events (
      event_id,raw_event_id,type,mint,source,program,signature,slot,transaction_index,
      instruction_index,confirmation_status,observed_at,payload_version,payload
    ) VALUES ($1,$2,$3,$4,$5,'pumpfun',$6,1,0,0,'finalized',
      date_trunc('milliseconds',statement_timestamp()),1,$7)`, [
      event[0], rawEventId, event[1], intent.mint, event[2], signature,
      JSON.stringify(event[3]),
    ]);
  }
  await pool.query(`WITH operation AS MATERIALIZED (
    SELECT date_trunc('milliseconds',statement_timestamp()) AS at
  ) INSERT INTO qualification_reports (
    report_id,mint,source_event_id,source_raw_event_id,qualification_event_id,
    profile_id,profile_version,profile_fingerprint,evidence_fingerprint,verdict,
    preparation_score,social_score,onchain_score,total_score,as_of_slot,
    as_of_transaction_index,as_of_instruction_index,confirmation_status,evaluated_at,
    purge_after,payload_version,payload
  ) SELECT $1,$2,$3,$4,$3,'profile',1,repeat('6',64),repeat('7',64),'QUALIFIED',
    15,25,60,100,1,0,0,'finalized',operation.at,operation.at+INTERVAL '4 hours',1,'{}'
    FROM operation`, [reportId, intent.mint, qualificationEventId, rawEventId]);
  await pool.query(`WITH operation AS MATERIALIZED (
    SELECT date_trunc('milliseconds',statement_timestamp()) AS at
  ) INSERT INTO trading_candidates (
    candidate_id,mint,report_id,source_event_id,candidate_event_id,strategy_id,
    strategy_version,evidence_fingerprint,confirmation_status,state,quote_mint,
    quote_decimals,quote_token_program,reason_codes,eligible_until,created_at,
    purge_after,payload_version,payload
  ) SELECT $1,$2,$3,$4,$5,$6,$7,repeat('7',64),'finalized','ELIGIBLE',$8,9,
    'SPL_TOKEN','["QUALIFIED_ENTRY"]',operation.at+INTERVAL '3 minutes',operation.at,
    operation.at+INTERVAL '4 hours',1,$9 FROM operation`, [intent.candidateId, intent.mint,
      reportId, qualificationEventId, candidateEventId, intent.strategyId,
      intent.strategyVersion, intent.quoteMint, JSON.stringify(candidatePayload)]);
  await pool.query(`INSERT INTO paper_positions (
    position_id,mint,quote_mint,quote_decimals,quote_token_program,strategy_id,
    strategy_version,status,base_filled_raw,remaining_base_raw,quote_cost_raw,
    round_trip_loss_bps,entry_trade_id,open_command_hash,trigger_event_id,payload_version,
    payload,opened_at,strategy_session_id,qualification_report_id,candidate_id
  ) VALUES ($1,$2,$3,9,'SPL_TOKEN',$4,$5,'PAPER_HOLDING',1,1,1,0,$6,$7,$8,1,
    '{}',date_trunc('milliseconds',statement_timestamp()),'paper-session',$9,$10)`, [
      intent.positionId, intent.mint, intent.quoteMint, intent.strategyId, intent.strategyVersion,
      `paper_trade_${'8'.repeat(64)}`, `paper_open_command_${'9'.repeat(64)}`,
      qualificationEventId, reportId, intent.candidateId,
    ]);
}

function isRepositoryError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ExecutionOperationsRepositoryError && error.code === code;
}

async function currentDatabaseTimeMs(pool: InstanceType<typeof pg.Pool>): Promise<number> {
  const result = await pool.query<{ readonly database_now_ms: string }>(`SELECT
    trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS database_now_ms`);
  const row = result.rows[0];
  assert.ok(row !== undefined);
  const nowMs = Number(row.database_now_ms);
  assert.equal(Number.isSafeInteger(nowMs), true);
  return nowMs;
}

function testDatabaseUrl(context: Readonly<{ skip(message?: string): void }>): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') return databaseUrl;
  context.skip('TEST_DATABASE_URL absent: execution operations repository test skipped');
  return null;
}

function recordingDatabaseSource(
  pool: InstanceType<typeof pg.Pool>,
  queries: string[],
  afterQuery?: (text: string) => Promise<void>,
): Readonly<{ connect(): Promise<Readonly<{
  query(text: string, values?: readonly unknown[]): Promise<Readonly<{
    rows: readonly Readonly<Record<string, unknown>>[];
    rowCount: number | null;
  }>>;
  release(error?: boolean): void;
}>> }> {
  return Object.freeze({
    connect: async () => {
      const client = await pool.connect();
      return Object.freeze({
        query: async (text: string, values?: readonly unknown[]) => {
          queries.push(text);
          const result = await client.query(text, values as unknown[] | undefined);
          await afterQuery?.(text);
          return Object.freeze({
            rows: result.rows as readonly Readonly<Record<string, unknown>>[],
            rowCount: result.rowCount,
          });
        },
        release: (error?: boolean) => { client.release(error); },
      });
    },
  });
}

async function assertCandidateMutationBlocked(
  pool: InstanceType<typeof pg.Pool>,
  candidateId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role=replica');
    await client.query("SET LOCAL lock_timeout='100ms'");
    await assert.rejects(
      client.query(`UPDATE trading_candidates SET state='REVOKED' WHERE candidate_id=$1`, [candidateId]),
      (error: unknown) => typeof error === 'object' && error !== null
        && 'code' in error && error.code === '55P03',
    );
    await client.query('ROLLBACK');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve assertion failure */ }
    throw error;
  } finally { client.release(); }
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
