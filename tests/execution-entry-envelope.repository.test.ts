import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import {
  createExecutionArmamentRequestV2,
  createOperatorAuthorization,
  createOperatorAuthorizationV2,
  type ExecutionOperatorAuthorizationV1,
} from '../src/domain/execution-operations.js';
import { createEntryEnvelope, type EntryEnvelopeV2 } from '../src/domain/execution-entry-envelope.js';
import { createProviderUsageSnapshot } from '../src/domain/execution-provider-quota.js';
import { createExecutionRiskPolicy } from '../src/domain/execution-risk-policy.js';
import {
  createEnvelopeBindingGates,
  createMainnetSimulationEvidenceFingerprint,
  createSafetyQualification,
  EXECUTION_SAFETY_GATE_IDS,
  type ExecutionSafetyQualificationV1,
  type ExecutionSafetyQualificationV2,
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
import { insertExecutionDecisionEvent } from './helpers/execution-decision-event.js';
import { mutateWithTriggersDisabled } from './helpers/execution-preflight-v2-source-fixture.js';
import { acquireExecutorRoleTestLock } from './postgres-role-test-lock.js';
import { waitForBackendDrain } from './helpers/postgres-backend-drain.js';

type Pool = InstanceType<typeof pg.Pool>;

const publicKey = '11111111111111111111111111111111';
const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
const hash = '1'.repeat(64);
const WSOL = 'So11111111111111111111111111111111111111112';
const HOUR = 3_600_000;
const scriptUrl = new URL('../scripts/provision-executor-roles.sql', import.meta.url);
const SOL_TOKEN_ROLES = [
  'sol_token_listener_writer', 'sol_token_executor_worker', 'sol_token_executor_live',
  'sol_token_executor_live_recovery', 'sol_token_executor_operations',
  'sol_token_executor_readiness', 'sol_token_operator_reader', 'sol_token_public_api',
  'sol_token_retention_worker',
] as const;

void test('prepareEnvelopeFacts returns the generation, the DB now and the latest fresh matching SUCCESS artifact', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const query = Object.freeze({
      buildHash: hash, configurationFingerprint: simulation.configurationFingerprint,
      walletPublicKey: publicKey, providerId: 'primary', genesisHash: publicKey,
    });
    const before = await currentDatabaseTimeMs(pool);
    const facts = await repository.prepareEnvelopeFacts(generationId, query);
    assert.ok(facts !== null);
    assert.equal(facts.payloadVersion, 1);
    assert.ok(facts.databaseNowMs >= before);
    assert.deepEqual(facts.generation, { generationId, walletPublicKey: publicKey, genesisHash: publicKey });
    assert.deepEqual(facts.simulation, {
      artifactId: simulation.artifactId,
      resultFingerprint: simulation.resultFingerprint,
      recordedAtMs: simulation.recordedAtMs,
      buildFingerprint: hash,
      configurationFingerprint: simulation.configurationFingerprint,
    });
    assert.equal(await repository.prepareEnvelopeFacts(generationId, { ...query, providerId: 'other' }), null);
    assert.equal(await repository.prepareEnvelopeFacts(generationId,
      { ...query, buildHash: '2'.repeat(64) }), null);
    await assert.rejects(repository.prepareEnvelopeFacts(generationId,
      { ...query, walletPublicKey: WSOL }), isRepositoryError('CONFLICT'));
    await assert.rejects(repository.prepareEnvelopeFacts(
      `execution_wallet_generation_${'b'.repeat(64)}`, query), isRepositoryError('CONFLICT'));
    // Safety point 1: a SUCCESS artifact older than 24 hours is not evidence any more.
    await mutateWithTriggersDisabled(pool, `UPDATE execution_simulation_artifacts
      SET recorded_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '25 hours'
      WHERE artifact_id=$1`, [simulation.artifactId]);
    assert.equal(await repository.prepareEnvelopeFacts(generationId, query), null);
  });
});

void test('createEnvelope binds an ACTIVE v2 envelope, its ENVELOPE qualification and the consumed authorization', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const prepared = await prepareEnvelope(pool, repository, simulation);
    const created = await repository.createEnvelope(prepared);
    assert.deepEqual(created, prepared.envelope);
    const envelope = await pool.query(`SELECT envelope_id,payload_version,state,generation_id,
      operator_id,fingerprint,per_buy_quote_amount_raw::TEXT AS per_buy,max_buys,max_open_positions,
      max_total_exposure_raw::TEXT AS max_exposure,max_realized_loss_raw::TEXT AS max_loss,
      buys_armed,realized_loss_raw::TEXT AS realized_loss,revoked_at,authorization_id,
      policy_fingerprint,maximum_holding_ms,
      trunc(EXTRACT(EPOCH FROM valid_from)*1000)::TEXT AS valid_from_ms,
      trunc(EXTRACT(EPOCH FROM valid_until)*1000)::TEXT AS valid_until_ms,
      created_at=valid_from AND updated_at=valid_from AS stamped,
      risk_policy->>'policyFingerprint' AS stored_policy_fingerprint
      FROM execution_entry_envelopes`);
    assert.deepEqual(envelope.rows, [{
      envelope_id: prepared.envelope.envelopeId, payload_version: 2, state: 'ACTIVE',
      generation_id: generationId, operator_id: 'operator-primary',
      fingerprint: prepared.envelope.fingerprint, per_buy: '10000000', max_buys: 3,
      max_open_positions: 1, max_exposure: '30000000', max_loss: '30000000', buys_armed: 0,
      realized_loss: '0', revoked_at: null, authorization_id: prepared.authorization.authorizationId,
      policy_fingerprint: prepared.envelope.policy.policyFingerprint, maximum_holding_ms: 60_000,
      valid_from_ms: String(prepared.envelope.validFromMs),
      valid_until_ms: String(prepared.envelope.validUntilMs), stamped: true,
      stored_policy_fingerprint: prepared.envelope.policy.policyFingerprint,
    }]);
    const qualification = await pool.query(`SELECT qualification_id,payload_version,scope,envelope_id,
      (SELECT COUNT(*)::INTEGER FROM execution_safety_gate_evidence gate
        WHERE gate.qualification_id=qualification.qualification_id) AS gates
      FROM execution_safety_qualifications qualification`);
    assert.deepEqual(qualification.rows, [{
      qualification_id: prepared.qualification.qualificationId, payload_version: 2,
      scope: 'ENVELOPE', envelope_id: prepared.envelope.envelopeId, gates: 11,
    }]);
    const authorization = await pool.query(`SELECT consumed_at IS NOT NULL AS consumed
      FROM execution_operator_authorizations WHERE authorization_id=$1`,
    [prepared.authorization.authorizationId]);
    assert.deepEqual(authorization.rows, [{ consumed: true }]);
    assert.deepEqual(await repository.readQualification(prepared.qualification.qualificationId),
      prepared.qualification);
    const envelopes = await repository.readEnvelopes(generationId);
    assert.equal(envelopes.length, 1);
    assert.deepEqual(envelopes[0], {
      envelopeId: prepared.envelope.envelopeId, payloadVersion: 2,
      fingerprint: prepared.envelope.fingerprint, generationId, operatorId: 'operator-primary',
      perBuyQuoteAmountRaw: 10_000_000n, maxBuys: 3, maxOpenPositions: 1,
      maxTotalExposureRaw: 30_000_000n, maxRealizedLossRaw: 30_000_000n,
      validFromMs: prepared.envelope.validFromMs, validUntilMs: prepared.envelope.validUntilMs,
      state: 'ACTIVE', buysArmed: 0, realizedLossRaw: 0n, revokedAtMs: null,
      createdAtMs: prepared.envelope.validFromMs, updatedAtMs: prepared.envelope.validFromMs,
      authorizationId: prepared.authorization.authorizationId,
      policyFingerprint: prepared.envelope.policy.policyFingerprint, maximumHoldingMs: 60_000,
      qualificationId: prepared.qualification.qualificationId,
    });
    // The authorization is single use: replaying the creation is a conflict, not a second envelope.
    await assert.rejects(repository.createEnvelope(prepared), isRepositoryError('CONFLICT'));
  });
});

void test('createEnvelope refuses a v1 qualification, a mismatched or unconsumable authorization and absent evidence', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const prepared = await prepareEnvelope(pool, repository, simulation);
    const nowMs = await currentDatabaseTimeMs(pool);
    const v1 = canaryQualification(nowMs, simulation);
    await assert.rejects(repository.createEnvelope({
      ...prepared, qualification: v1 as unknown as ExecutionSafetyQualificationV2,
    }), isRepositoryError('CONFLICT'));
    const mismatched = createOperatorAuthorization({
      payloadVersion: 1, generationId, action: 'ENVELOPE', phase: null,
      contextFingerprint: 'f'.repeat(64), nonceHash: '6'.repeat(64),
      operatorId: 'operator-primary', issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
    });
    await repository.recordAuthorization(mismatched);
    await assert.rejects(repository.createEnvelope({ ...prepared, authorization: mismatched }),
      isRepositoryError('CONFLICT'));
    const resume = createOperatorAuthorization({
      payloadVersion: 1, generationId, action: 'RESUME', phase: null,
      contextFingerprint: prepared.envelope.fingerprint, nonceHash: '5'.repeat(64),
      operatorId: 'operator-primary', issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
    });
    await assert.rejects(repository.createEnvelope({ ...prepared, authorization: resume }),
      isRepositoryError('CONFLICT'));
    const unrecorded = envelopeAuthorization(prepared.envelope, nowMs, '4'.repeat(64));
    await assert.rejects(repository.createEnvelope({ ...prepared, authorization: unrecorded }),
      isRepositoryError('CONFLICT'));
    // No SUCCESS artifact behind gate 10.
    await mutateWithTriggersDisabled(pool, `UPDATE execution_simulation_artifacts
      SET artifact_id=$2 WHERE artifact_id=$1`, [
      simulation.artifactId, `execution_simulation_artifact_${'0'.repeat(64)}`,
    ]);
    await assert.rejects(repository.createEnvelope(prepared), isRepositoryError('CONFLICT'));
    assert.deepEqual((await pool.query(`SELECT
      (SELECT COUNT(*)::INTEGER FROM execution_entry_envelopes) AS envelopes,
      (SELECT COUNT(*)::INTEGER FROM execution_safety_qualifications) AS qualifications,
      (SELECT COUNT(*)::INTEGER FROM execution_operator_authorizations
        WHERE consumed_at IS NOT NULL) AS consumed`)).rows,
    [{ envelopes: 0, qualifications: 0, consumed: 0 }]);
  });
});

void test('createEnvelope refuses a second ACTIVE envelope and expires one past valid_until first', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const first = await prepareEnvelope(pool, repository, simulation, { nonce: '1' });
    await repository.createEnvelope(first);
    const second = await prepareEnvelope(pool, repository, simulation,
      { nonce: '2', expiresInMs: 3 * HOUR });
    await assert.rejects(repository.createEnvelope(second), isRepositoryError('CONFLICT'));
    assert.deepEqual((await pool.query(`SELECT consumed_at IS NULL AS unconsumed
      FROM execution_operator_authorizations WHERE authorization_id=$1`,
    [second.authorization.authorizationId])).rows, [{ unconsumed: true }]);
    await moveEnvelopeIntoThePast(pool, first.envelope.envelopeId);
    await repository.createEnvelope(second);
    const states = await pool.query(`SELECT envelope_id,state FROM execution_entry_envelopes
      ORDER BY state`);
    assert.deepEqual(states.rows, [
      { envelope_id: second.envelope.envelopeId, state: 'ACTIVE' },
      { envelope_id: first.envelope.envelopeId, state: 'EXPIRED' },
    ]);
  });
});

void test('persistQualification still refuses an ENVELOPE qualification and keeps v1 unchanged', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const nowMs = await currentDatabaseTimeMs(pool);
    await assert.rejects(repository.persistQualification(envelopeQualification(nowMs, simulation)),
      isRepositoryError('CONFLICT'));
    const v1 = canaryQualification(nowMs, simulation);
    assert.deepEqual(await repository.persistQualification(v1), v1);
    assert.deepEqual((await pool.query(`SELECT payload_version,scope,envelope_id
      FROM execution_safety_qualifications`)).rows,
    [{ payload_version: 1, scope: 'CANARY', envelope_id: null }]);
  });
});

void test('revokeEnvelope never touches an ARMED CANARY armament and replays (A10)', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const prepared = await prepareEnvelope(pool, repository, simulation);
    await repository.createEnvelope(prepared);
    const armament = await armCanary(pool, repository, simulation);
    const command = Object.freeze({
      generationId, envelopeId: prepared.envelope.envelopeId,
      operatorId: 'operator-primary', occurredAtMs: Date.now(),
    });
    const revoked = await repository.revokeEnvelope(command);
    assert.equal(revoked.state, 'REVOKED');
    assert.equal(revoked.replayed, false);
    assert.equal(revoked.armamentRevoked, false);
    const replay = await repository.revokeEnvelope(command);
    assert.equal(replay.state, 'REVOKED');
    assert.equal(replay.replayed, true);
    assert.deepEqual((await pool.query(`SELECT armament.state,reservation.state AS reservation_state
      FROM execution_activation_armaments armament
      JOIN execution_exposure_reservations reservation
        ON reservation.reservation_id=armament.target_reservation_id
      WHERE armament.armament_id=$1`, [armament.armamentId])).rows,
    [{ state: 'ARMED', reservation_state: 'RESERVED' }]);
    assert.deepEqual((await pool.query(`SELECT state,revoked_at IS NOT NULL AS revoked,
      updated_at>=created_at AS monotonic FROM execution_entry_envelopes`)).rows,
    [{ state: 'REVOKED', revoked: true, monotonic: true }]);
    await assert.rejects(repository.revokeEnvelope({
      ...command, envelopeId: `execution_entry_envelope_${'0'.repeat(64)}`,
    }), isRepositoryError('CONFLICT'));
  });
});

for (const initialState of ['ACTIVE', 'EXHAUSTED'] as const) {
  void test(`revokeEnvelope revokes the ARMED armament of a ${initialState} envelope and releases its reservation`,
    async (context) => {
      await withSchema(context, async (pool) => {
        const simulation = await seedEnvelopeBase(pool);
        const repository = new PostgresExecutionOperationsRepository(pool);
        const prepared = await prepareEnvelope(pool, repository, simulation);
        await repository.createEnvelope(prepared);
        const armament = await armCanary(pool, repository, simulation);
        await bindArmamentToEnvelope(pool, armament.armamentId, prepared.envelope.envelopeId);
        if (initialState === 'EXHAUSTED') {
          await mutateWithTriggersDisabled(pool, `UPDATE execution_entry_envelopes
            SET state='EXHAUSTED',buys_armed=1 WHERE envelope_id=$1`, [prepared.envelope.envelopeId]);
        }
        const revoked = await repository.revokeEnvelope({
          generationId, envelopeId: prepared.envelope.envelopeId,
          operatorId: 'operator-primary', occurredAtMs: Date.now(),
        });
        assert.equal(revoked.armamentRevoked, true);
        assert.equal(revoked.state, initialState === 'ACTIVE' ? 'REVOKED' : 'EXHAUSTED');
        assert.deepEqual((await pool.query(`SELECT armament.state,reservation.state AS reservation_state,
          risk.reserved_exposure_raw::TEXT AS reserved_exposure_raw,risk.open_positions
          FROM execution_activation_armaments armament
          JOIN execution_exposure_reservations reservation
            ON reservation.reservation_id=armament.target_reservation_id
          JOIN execution_wallet_risk_state risk ON risk.generation_id=armament.generation_id
          WHERE armament.armament_id=$1`, [armament.armamentId])).rows, [{
          state: 'REVOKED', reservation_state: 'RELEASED', reserved_exposure_raw: '0', open_positions: 0,
        }]);
      });
    });
}

void test('expireEnvelopes expires only ACTIVE envelopes past valid_until', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const prepared = await prepareEnvelope(pool, repository, simulation);
    await repository.createEnvelope(prepared);
    const before = await currentDatabaseTimeMs(pool);
    const none = await repository.expireEnvelopes(generationId);
    assert.equal(none.expiredCount, 0);
    assert.ok(none.databaseNowMs >= before);
    await moveEnvelopeIntoThePast(pool, prepared.envelope.envelopeId);
    assert.equal((await repository.expireEnvelopes(generationId)).expiredCount, 1);
    assert.equal((await repository.expireEnvelopes(generationId)).expiredCount, 0);
    const [summary] = await repository.readEnvelopes(generationId);
    assert.equal(summary?.state, 'EXPIRED');
    assert.ok((summary?.updatedAtMs ?? 0) >= before);
  });
});

void test('PostgreSQL 16 operations role creates, revokes and expires envelopes and arms a CANARY (A14, A25)',
  async (context) => {
    await withProvisionedDatabase(context, async (pool) => {
      const operations = new PostgresExecutionOperationsRepository(roleSource(pool,
        'sol_token_executor_operations'));
      const simulation = await seedEnvelopeBase(pool);
      const facts = await operations.prepareEnvelopeFacts(generationId, {
        buildHash: hash, configurationFingerprint: simulation.configurationFingerprint,
        walletPublicKey: publicKey, providerId: 'primary', genesisHash: publicKey,
      });
      assert.equal(facts?.simulation.artifactId, simulation.artifactId);
      const first = await prepareEnvelope(pool, operations, simulation, { nonce: '1' });
      await operations.createEnvelope(first);
      const armament = await armCanary(pool, operations, simulation);
      assert.equal(armament.state, 'ARMED');
      const revokeCommand = Object.freeze({
        generationId, envelopeId: first.envelope.envelopeId,
        operatorId: 'operator-primary', occurredAtMs: Date.now(),
      });
      assert.equal((await operations.revokeEnvelope(revokeCommand)).armamentRevoked, false);
      await bindArmamentToEnvelope(pool, armament.armamentId, first.envelope.envelopeId);
      const replay = await operations.revokeEnvelope(revokeCommand);
      assert.equal(replay.replayed, true);
      assert.equal(replay.armamentRevoked, true);
      const second = await prepareEnvelope(pool, operations, simulation,
        { nonce: '2', expiresInMs: 3 * HOUR });
      await operations.createEnvelope(second);
      await moveEnvelopeIntoThePast(pool, second.envelope.envelopeId);
      assert.equal((await operations.expireEnvelopes(generationId)).expiredCount, 1);
      assert.deepEqual((await operations.readEnvelopes(generationId)).map((row) => row.state).sort(),
        ['EXPIRED', 'REVOKED']);
      const updateEnvelopeId = await pool.query<{ readonly role: string; readonly table: string }>(`
        SELECT role.rolname AS role,target.relname AS table
        FROM pg_roles role CROSS JOIN (VALUES ('execution_activation_armaments'),
          ('execution_safety_qualifications')) AS target(relname)
        WHERE role.rolname = ANY($1::TEXT[])
          AND has_column_privilege(role.oid,target.relname,'envelope_id','UPDATE')`,
      [[...SOL_TOKEN_ROLES]]);
      assert.deepEqual(updateEnvelopeId.rows, []);
    });
  });

interface PreparedEnvelope {
  readonly envelope: EntryEnvelopeV2;
  readonly qualification: ExecutionSafetyQualificationV2;
  readonly authorization: ExecutionOperatorAuthorizationV1;
}

async function prepareEnvelope(
  pool: Pool,
  repository: PostgresExecutionOperationsRepository,
  simulation: SeededSimulation,
  options: Readonly<{ nonce?: string; expiresInMs?: number }> = {},
): Promise<PreparedEnvelope> {
  const nowMs = await currentDatabaseTimeMs(pool);
  const qualification = envelopeQualification(nowMs, simulation, options.expiresInMs);
  const envelope = createEntryEnvelope(Object.freeze({
    payloadVersion: 2, qualification, operatorId: 'operator-primary',
    perBuyQuoteAmountRaw: 10_000_000n, maxBuys: 3, maxTotalExposureRaw: 30_000_000n,
    maxRealizedLossRaw: 30_000_000n, maximumHoldingMs: 60_000,
    validFromMs: nowMs, validUntilMs: qualification.expiresAtMs, policy: envelopePolicy(),
  }));
  const authorization = envelopeAuthorization(envelope, nowMs,
    (options.nonce ?? '7').repeat(64));
  await repository.recordAuthorization(authorization);
  return Object.freeze({ envelope, qualification, authorization });
}

function envelopeAuthorization(
  envelope: EntryEnvelopeV2,
  nowMs: number,
  nonceHash: string,
): ExecutionOperatorAuthorizationV1 {
  return createOperatorAuthorization({
    payloadVersion: 1, generationId, action: 'ENVELOPE', phase: null,
    contextFingerprint: envelope.fingerprint, nonceHash, operatorId: envelope.operatorId,
    issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
  });
}

function staticGates(nowMs: number, expiresAtMs: number, simulation: SeededSimulation) {
  const evidenceTypes = [
    'CI_RUN', 'MIGRATION_TEST', 'ARCHITECTURE_TEST', 'DRY_RUN_TEST',
    'SIMULATION_ARTIFACT', 'FAULT_TEST', 'RECONCILIATION_STATE',
    'PROVIDER_SNAPSHOT', 'STOP_CONTROL_TEST', 'WALLET_SNAPSHOT',
    'MAINNET_SIMULATION_ARTIFACT',
  ] as const;
  return EXECUTION_SAFETY_GATE_IDS.map((gateId, index) => ({
    payloadVersion: 1, gateId, status: 'PASSED', evidenceType: evidenceTypes[index],
    evidenceId: gateId === 'MAINNET_PREFLIGHT_SIMULATED' ? simulation.artifactId : `evidence:${index}`,
    evidenceFingerprint: gateId === 'MAINNET_PREFLIGHT_SIMULATED'
      ? createMainnetSimulationEvidenceFingerprint({
        artifactId: simulation.artifactId, resultFingerprint: simulation.resultFingerprint,
        buildHash: hash, configurationFingerprint: simulation.configurationFingerprint,
        strategyFingerprint: '3'.repeat(64), walletPublicKey: publicKey,
        genesisHash: publicKey, providerId: 'primary',
      })
      : index.toString(16).repeat(64),
    observedAtMs: gateId === 'MAINNET_PREFLIGHT_SIMULATED'
      ? simulation.recordedAtMs : nowMs - 1_000 + index,
    expiresAtMs,
  }));
}

function envelopeQualification(
  nowMs: number,
  simulation: SeededSimulation,
  expiresInMs = 2 * HOUR,
): ExecutionSafetyQualificationV2 {
  const expiresAtMs = nowMs + expiresInMs;
  const binding = createEnvelopeBindingGates({
    generationId, walletPublicKey: publicKey, providerId: 'primary',
    observedAtMs: nowMs, expiresAtMs,
  });
  const gates = staticGates(nowMs, expiresAtMs, simulation).map((gate, index) => (
    index === 7 ? binding.provider : index === 9 ? binding.wallet : gate));
  const qualification = createSafetyQualification({
    payloadVersion: 2, scope: 'ENVELOPE', evaluatorVersion: 1, phase: 'CANARY',
    buildHash: hash, configurationFingerprint: simulation.configurationFingerprint,
    strategyFingerprint: '3'.repeat(64), generationId, walletPublicKey: publicKey,
    cluster: 'mainnet-beta', genesisHash: publicKey, providerId: 'primary',
    qualifiedAtMs: nowMs, expiresAtMs, gates,
  });
  assert.equal(qualification.payloadVersion, 2);
  return qualification;
}

function canaryQualification(
  nowMs: number,
  simulation: SeededSimulation,
  snapshots?: Readonly<{
    wallet: ReturnType<typeof createExecutionWalletSnapshot>;
    provider: ReturnType<typeof createProviderUsageSnapshot>;
  }>,
): ExecutionSafetyQualificationV1 {
  const gates = staticGates(nowMs, nowMs + 300_000, simulation).map((gate) => (
    snapshots !== undefined && gate.gateId === 'WALLET_CHAIN_LIMITS_VERIFIED'
      ? { ...gate, evidenceId: snapshots.wallet.snapshotId,
        evidenceFingerprint: snapshots.wallet.snapshotFingerprint }
      : snapshots !== undefined && gate.gateId === 'PROVIDER_EXIT_CAPACITY_VERIFIED'
        ? { ...gate, evidenceId: snapshots.provider.snapshotId,
          evidenceFingerprint: snapshots.provider.snapshotFingerprint }
        : gate));
  const qualification = createSafetyQualification({
    payloadVersion: 1, evaluatorVersion: 1, phase: 'CANARY',
    buildHash: hash, configurationFingerprint: simulation.configurationFingerprint,
    strategyFingerprint: '3'.repeat(64), generationId, walletPublicKey: publicKey,
    cluster: 'mainnet-beta', genesisHash: publicKey, providerId: 'primary',
    qualifiedAtMs: nowMs, expiresAtMs: nowMs + 300_000, gates,
  });
  assert.equal(qualification.payloadVersion, 1);
  return qualification;
}

function envelopePolicy() {
  return createExecutionRiskPolicy({
    quoteMintAllowlist: [WSOL],
    initialCapitalLamports: 230_000_000n,
    maximumCapitalLamports: 230_000_000n,
    positionSizeBps: 1_000n,
    maximumOpenPositions: 1,
    maximumTotalExposureBps: 500n,
    drawdownPauseBps: 2_500n,
    feeReserveLamports: 20_000_000n,
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

function canaryPolicy() {
  return createExecutionRiskPolicy({
    quoteMintAllowlist: [WSOL],
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

/** The CANARY v2 path of tests/execution-operations.repository.test.ts, through `repository`. */
async function armCanary(
  pool: Pool,
  repository: PostgresExecutionOperationsRepository,
  simulation: SeededSimulation,
) {
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
  const nowMs = await currentDatabaseTimeMs(pool);
  const qualification = canaryQualification(nowMs, simulation,
    { wallet: walletSnapshot, provider: providerSnapshot });
  await repository.persistQualification(qualification);
  const resumeAuthorization = createOperatorAuthorization({
    payloadVersion: 1, generationId, action: 'RESUME', phase: null,
    contextFingerprint: qualification.qualificationFingerprint, nonceHash: '9'.repeat(64),
    operatorId: 'operator-primary', issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
  });
  await repository.recordAuthorization(resumeAuthorization);
  await repository.resume({
    payloadVersion: 1, commandId: 'command:envelope-canary-resume', generationId,
    qualificationId: qualification.qualificationId, authorization: resumeAuthorization,
    operatorId: 'operator-primary', occurredAtMs: nowMs,
  });
  await insertExecutionDecisionEvent(pool, 'decision:canary-target', publicKey);
  const target = await new PostgresExecutionIntentRepository(pool).create(createExecutionIntentDraft({
    strategyId: 'canary-target', strategyVersion: 1,
    positionId: 'position:canary-target', logicalCommandId: 'command:canary-target',
    mint: publicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint: WSOL,
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
    quoteAmountRaw: 40_000n, baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: 'decision:canary-target', decisionFingerprint: 'd'.repeat(64),
    requestedAtMs: nowMs - 1_000, expiresAtMs: nowMs + 120_000,
  }));
  const request = createExecutionArmamentRequestV2({
    payloadVersion: 2, qualification, targetIntentId: target.intent.id, policy: canaryPolicy(),
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
  const authorization = createOperatorAuthorizationV2({
    payloadVersion: 2, generationId, action: 'ARM', phase: 'CANARY',
    contextFingerprint: request.armamentRequestFingerprint, nonceHash: 'e'.repeat(64),
    operatorId: 'operator-primary', issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
  });
  return repository.armCanary(Object.freeze({ request, authorization }));
}

/** Seeds what a real envelope armament (Task 6) would carry: the armament's envelope link. */
async function bindArmamentToEnvelope(pool: Pool, armamentId: string, envelopeId: string) {
  await mutateWithTriggersDisabled(pool, `UPDATE execution_activation_armaments
    SET envelope_id=$2 WHERE armament_id=$1`, [armamentId, envelopeId]);
}

async function moveEnvelopeIntoThePast(pool: Pool, envelopeId: string) {
  await mutateWithTriggersDisabled(pool, `UPDATE execution_entry_envelopes SET
    valid_from=date_trunc('milliseconds',statement_timestamp())-INTERVAL '2 hours',
    valid_until=date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 second',
    created_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '2 hours',
    updated_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '2 hours'
    WHERE envelope_id=$1`, [envelopeId]);
}

type SeededSimulation = Awaited<ReturnType<typeof seedSuccessfulSimulation>>;

async function seedEnvelopeBase(pool: Pool): Promise<SeededSimulation> {
  await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
    generationId, payloadVersion: 1, walletPublicKey: publicKey,
    cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
  });
  return seedSuccessfulSimulation(pool);
}

async function seedSuccessfulSimulation(pool: Pool) {
  const nowMs = await currentDatabaseTimeMs(pool);
  const intents = new PostgresExecutionIntentRepository(pool);
  const decisionEventId = `event-${randomUUID()}`;
  await insertExecutionDecisionEvent(pool, decisionEventId, publicKey);
  const created = await intents.create(createExecutionIntentDraft({
    strategyId: 'simulation-strategy', strategyVersion: 1,
    positionId: `position-${randomUUID()}`, logicalCommandId: `command-${randomUUID()}`,
    mint: publicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint: WSOL,
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

function isRepositoryError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ExecutionOperationsRepositoryError && error.code === code;
}

async function currentDatabaseTimeMs(pool: Pool): Promise<number> {
  const result = await pool.query<{ readonly now_ms: string }>(`SELECT
    trunc(EXTRACT(EPOCH FROM statement_timestamp())*1000)::TEXT AS now_ms`);
  const nowMs = Number(result.rows[0]?.now_ms);
  assert.equal(Number.isSafeInteger(nowMs), true);
  return nowMs;
}

/** Runs every repository transaction on its own connection under `SET ROLE role`. */
function roleSource(pool: Pool, role: string) {
  return Object.freeze({
    connect: async () => {
      const client = await pool.connect();
      await client.query(`SET ROLE ${role}`);
      return Object.freeze({
        query: async (text: string, values?: readonly unknown[]) => {
          const result = await client.query(text, values === undefined ? undefined : [...values]);
          return { rows: result.rows as readonly Readonly<Record<string, unknown>>[], rowCount: result.rowCount };
        },
        // The role is session state: the connection is discarded instead of being reset.
        release: () => { client.release(true); },
      });
    },
  });
}

async function withSchema(context: TestContext, callback: (pool: Pool) => Promise<void>): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: entry envelope repository test skipped');
    return;
  }
  const schema = `entry_envelope_repository_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    await migrateDatabase({ pool });
    await callback(pool);
  } finally {
    try { await pool.end(); } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally { await admin.end(); }
    }
  }
}

async function withProvisionedDatabase(
  context: TestContext,
  callback: (pool: Pool) => Promise<void>,
): Promise<void> {
  const configuredUrl = process.env.TEST_DATABASE_URL;
  if (configuredUrl === undefined || configuredUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL is not configured.');
    return;
  }
  const maintenance = new pg.Pool({ connectionString: configuredUrl });
  const capability = (await maintenance.query<{
    readonly rolsuper: boolean; readonly rolcreatedb: boolean; readonly version: number;
  }>(`SELECT rolsuper,rolcreatedb,current_setting('server_version_num')::INTEGER AS version
    FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if (!capability?.rolsuper || !capability.rolcreatedb || capability.version < 160_000) {
    await maintenance.end();
    context.skip('PostgreSQL 16 superuser with CREATEDB is required.');
    return;
  }
  const release = await acquireExecutorRoleTestLock(maintenance);
  const databaseName = `entry_envelope_roles_${randomUUID().replaceAll('-', '')}`;
  const isolatedUrl = new URL(configuredUrl);
  isolatedUrl.pathname = `/${databaseName}`;
  let isolated: Pool | undefined;
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    isolated = new pg.Pool({ connectionString: isolatedUrl.href, max: 4 });
    await migrateDatabase({ pool: isolated });
    const provisioningSql = await readFile(scriptUrl, 'utf8');
    await isolated.query(provisioningSql);
    await isolated.query(provisioningSql);
    await callback(isolated);
  } finally {
    try {
      await isolated?.end();
      await waitForBackendDrain(maintenance, databaseName);
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } finally {
      try { await release(); } finally { await maintenance.end(); }
    }
  }
}
