import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorAuthorization } from '../src/domain/execution-operations.js';
import { createEntryEnvelope } from '../src/domain/execution-entry-envelope.js';
import {
  createProviderUsageOperationId,
  createProviderUsageSnapshot,
  type ProviderUsageSnapshotV1,
} from '../src/domain/execution-provider-quota.js';
import { FAST_ENTRY_STRATEGY_ID } from '../src/domain/fast-entry.js';
import { createExecutionRiskPolicy } from '../src/domain/execution-risk-policy.js';
import { parseJson } from '../src/utils/json.js';
import {
  type ExecutionSafetyQualificationV2,
} from '../src/domain/execution-safety-qualification.js';
import { createExecutionWalletSnapshot } from '../src/domain/execution-wallet-snapshot.js';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
import {
  ExecutionOperationsRepositoryError,
  PostgresExecutionOperationsRepository,
} from '../src/storage/execution-operations.repository.js';
import { PostgresExecutionRiskRepository } from '../src/storage/execution-risk.repository.js';
import { insertExecutionDecisionEvent } from './helpers/execution-decision-event.js';
import { mutateWithTriggersDisabled } from './helpers/execution-preflight-v2-source-fixture.js';
import {
  armCanary, canaryQualification,
  armEnvelope, contextQuery, currentDatabaseTimeMs, envelopeArmRequest, envelopeAuthorization,
  envelopeQualification, fastEntryIntent, generationId, hash, HOUR, openEnvelope, PER_BUY,
  type Pool, prepareEnvelope, publicKey, resumeWith, roleSource,
  envelopePolicy, seedEnvelopeBase, seedProviderSnapshot, withProvisionedDatabase,
  withSchema, WSOL,
} from './helpers/entry-envelope-fixture.js';

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
    const storedPolicy = await pool.query<{ readonly risk_policy: string }>(`SELECT
      risk_policy::TEXT AS risk_policy FROM execution_entry_envelopes`);
    const parsedPolicy = parseJson(storedPolicy.rows[0]?.risk_policy ?? '') as Record<string, unknown>;
    const { payloadVersion: _version, policyFingerprint: _fingerprint, ...policyInput } = parsedPolicy;
    assert.deepEqual(createExecutionRiskPolicy(policyInput), prepared.envelope.policy);
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
    // The envelope must be exactly the one its own qualification and fields produce.
    const otherWindow = await prepareEnvelope(pool, repository, simulation,
      { nonce: '3', expiresInMs: 3 * HOUR });
    assert.notEqual(otherWindow.envelope.validUntilMs, prepared.envelope.validUntilMs);
    await assert.rejects(repository.createEnvelope({ ...prepared, envelope: otherWindow.envelope }),
      isRepositoryError('CONFLICT'));
    await assert.rejects(repository.createEnvelope({ ...prepared,
      envelope: Object.freeze({ ...prepared.envelope, maxBuys: 4 }) }), isRepositoryError('CONFLICT'));
    await assert.rejects(repository.createEnvelope({ ...prepared,
      envelope: Object.freeze({ ...prepared.envelope, validUntilMs: prepared.envelope.validUntilMs - 1 }) }),
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

void test('createEnvelope refuses gate 10 evidence older than 24 hours before the DB now', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    await mutateWithTriggersDisabled(pool, `UPDATE execution_simulation_artifacts
      SET recorded_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '25 hours'
      WHERE artifact_id=$1`, [simulation.artifactId]);
    const stale = await pool.query<{ readonly recorded_at_ms: string }>(`SELECT
      trunc(EXTRACT(EPOCH FROM recorded_at)*1000)::TEXT AS recorded_at_ms
      FROM execution_simulation_artifacts WHERE artifact_id=$1`, [simulation.artifactId]);
    // Qualified 23 hours ago: the artifact is within 24 hours of qualifiedAt but not of the DB now.
    const nowMs = await currentDatabaseTimeMs(pool);
    const qualification = envelopeQualification(nowMs - 23 * HOUR,
      { ...simulation, recordedAtMs: Number(stale.rows[0]?.recorded_at_ms) }, 24 * HOUR);
    const envelope = createEntryEnvelope(Object.freeze({
      payloadVersion: 2, qualification, operatorId: 'operator-primary',
      perBuyQuoteAmountRaw: 10_000_000n, maxBuys: 3, maxTotalExposureRaw: 30_000_000n,
      maxRealizedLossRaw: 30_000_000n, maximumHoldingMs: 60_000,
      validFromMs: nowMs, validUntilMs: qualification.expiresAtMs, policy: envelopePolicy(),
    }));
    const authorization = envelopeAuthorization(envelope, nowMs, '7'.repeat(64));
    await repository.recordAuthorization(authorization);
    await assert.rejects(repository.createEnvelope({ envelope, qualification, authorization }),
      isRepositoryError('CONFLICT'));
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_entry_envelopes`)).rows[0]?.count, 0);
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

for (const initialState of ['ACTIVE', 'EXHAUSTED', 'EXPIRED'] as const) {
  void test(`revokeEnvelope revokes the ARMED armament of a ${initialState} envelope and releases its reservation`,
    async (context) => {
      await withSchema(context, async (pool) => {
        const simulation = await seedEnvelopeBase(pool);
        const repository = new PostgresExecutionOperationsRepository(pool);
        // max_buys=1: the real arm itself exhausts the envelope.
        const prepared = await openEnvelope(pool, repository, simulation,
          { maxBuys: initialState === 'EXHAUSTED' ? 1 : 3 });
        await seedProviderSnapshot(pool);
        const intentId = await fastEntryIntent(pool, prepared.envelope, await currentDatabaseTimeMs(pool));
        const armament = await armEnvelope(repository, prepared, intentId);
        assert.equal((await repository.readEnvelopes(generationId))[0]?.state,
          initialState === 'EXHAUSTED' ? 'EXHAUSTED' : 'ACTIVE');
        if (initialState === 'EXPIRED') {
          await moveEnvelopeIntoThePast(pool, prepared.envelope.envelopeId);
          assert.equal((await repository.expireEnvelopes(generationId)).expiredCount, 1);
        }
        const revoked = await repository.revokeEnvelope({
          generationId, envelopeId: prepared.envelope.envelopeId,
          operatorId: 'operator-primary', occurredAtMs: Date.now(),
        });
        assert.equal(revoked.armamentRevoked, true);
        assert.equal(revoked.state, initialState === 'ACTIVE' ? 'REVOKED' : initialState);
        assert.equal(revoked.replayed, false);
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

void test('PostgreSQL 16 operations role arms a CANARY and an ENVELOPE, reads the context, refreshes, revokes and expires (A14, A25)',
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
      // A25: the CANARY path under the real operations role.
      const first = await prepareEnvelope(pool, operations, simulation, { nonce: '1' });
      await operations.createEnvelope(first);
      const canary = await armCanary(pool, operations, simulation);
      assert.equal(canary.state, 'ARMED');
      const revokeFirst = Object.freeze({
        generationId, envelopeId: first.envelope.envelopeId,
        operatorId: 'operator-primary', occurredAtMs: Date.now(),
      });
      assert.equal((await operations.revokeEnvelope(revokeFirst)).armamentRevoked, false);
      // A14: a real ENVELOPE arm under the same role (the CANARY armament is revoked by the stop).
      const second = await prepareEnvelope(pool, operations, simulation,
        { nonce: '2', expiresInMs: 3 * HOUR });
      await operations.createEnvelope(second);
      await stopAndResume(operations, second.qualification, 'role-second');
      const intentId = await fastEntryIntent(pool, second.envelope, await currentDatabaseTimeMs(pool));
      const armed = await operations.readAutoArmContext(contextQuery());
      assert.equal(armed.envelope?.envelopeId, second.envelope.envelopeId);
      assert.equal(armed.candidateIntent?.intentId, intentId);
      const armament = await armEnvelope(operations, second, intentId, SHORT_PROVIDER);
      assert.equal(armament.state, 'ARMED');
      assert.equal((await operations.readAutoArmContext(contextQuery())).activeArmament, 'ARMED');
      const revoked = await operations.revokeEnvelope(Object.freeze({
        generationId, envelopeId: second.envelope.envelopeId,
        operatorId: 'operator-primary', occurredAtMs: Date.now(),
      }));
      assert.equal(revoked.replayed, false);
      assert.equal(revoked.armamentRevoked, true);
      // Refresh needs a LOCKED envelope armament whose BUY SUCCEEDED (H2b state, forged here);
      // it reads and writes only what the role holds, and needs no ACTIVE envelope.
      await lockArmamentAfterBuy(pool, armament.armamentId, intentId, 'SUCCEEDED');
      const due = await operations.readAutoArmContext(contextQuery());
      assert.equal(due.envelope, null);
      assert.equal(due.activeArmament, 'LOCKED');
      // The REVOKED envelope's policy, read under the operations role.
      assert.equal(due.refreshProviderUsageMaxAgeMs, 300_000);
      assert.equal(due.providerRefreshDue, true);
      const refreshed = await operations.refreshEnvelopeProviderSnapshot({
        generationId, maximumAgeMs: 300_000, providerRefreshThresholdMs: 300_000,
      });
      assert.equal(refreshed.refreshed, true);
      assert.equal(refreshed.snapshot?.provenance, 'EXECUTOR_COUNTERS');
      const third = await prepareEnvelope(pool, operations, simulation,
        { nonce: '3', expiresInMs: 4 * HOUR });
      await operations.createEnvelope(third);
      await moveEnvelopeIntoThePast(pool, third.envelope.envelopeId);
      assert.equal((await operations.expireEnvelopes(generationId)).expiredCount, 1);
      assert.deepEqual((await operations.readEnvelopes(generationId)).map((row) => row.state).sort(),
        ['EXPIRED', 'REVOKED', 'REVOKED']);
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

void test('armEnvelope arms a real fast-entry intent bound to its envelope (safety point 6)', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const prepared = await openEnvelope(pool, repository, simulation);
    await seedProviderSnapshot(pool);
    const intentId = await fastEntryIntent(pool, prepared.envelope, await currentDatabaseTimeMs(pool));
    const armament = await armEnvelope(repository, prepared, intentId);
    assert.equal(armament.state, 'ARMED');
    assert.equal(armament.qualification.phase, 'CANARY');
    assert.equal(armament.operatorId, 'operator-primary');
    assert.deepEqual((await pool.query(`SELECT armament.payload_version,armament.phase,armament.state,
      armament.envelope_id,armament.target_strategy_id,armament.qualification_id,
      intent.live_reserved,report.decision,reservation.state AS reservation_state,
      envelope.buys_armed,envelope.state AS envelope_state,
      operator_auth.consumed_at IS NOT NULL AS consumed,operator_auth.operator_id,
      operator_auth.payload_version AS authorization_version,
      (SELECT array_agg(event.reason_code) FROM execution_activation_events event
        WHERE event.armament_id=armament.armament_id) AS events
      FROM execution_activation_armaments armament
      JOIN execution_intents intent ON intent.id=armament.target_intent_id
      JOIN execution_risk_admission_reports report ON report.report_id=armament.target_admission_report_id
      JOIN execution_exposure_reservations reservation
        ON reservation.reservation_id=armament.target_reservation_id
      JOIN execution_entry_envelopes envelope ON envelope.envelope_id=armament.envelope_id
      JOIN execution_operator_authorizations operator_auth
        ON operator_auth.authorization_id=armament.authorization_id`)).rows, [{
      payload_version: 2, phase: 'CANARY', state: 'ARMED', envelope_id: prepared.envelope.envelopeId,
      target_strategy_id: FAST_ENTRY_STRATEGY_ID, qualification_id: prepared.qualification.qualificationId,
      live_reserved: true, decision: 'ADMITTED', reservation_state: 'RESERVED', buys_armed: 1,
      envelope_state: 'ACTIVE', consumed: true, operator_id: 'operator-primary',
      authorization_version: 2, events: ['OPERATOR_ARMED'],
    }]);
    assert.deepEqual((await pool.query(`SELECT provenance FROM execution_provider_usage_snapshots
      WHERE superseded_at IS NULL`)).rows, [{ provenance: 'EXECUTOR_COUNTERS' }]);
    const status = await repository.readStatus(generationId);
    assert.equal(status.activeArmamentId, armament.armamentId);
  });
});

void test('armEnvelope refuses while control is ENTRY_STOP', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const prepared = await openEnvelope(pool, repository, simulation);
    await seedProviderSnapshot(pool);
    const intentId = await fastEntryIntent(pool, prepared.envelope, await currentDatabaseTimeMs(pool));
    await repository.setStop({ payloadVersion: 1, commandId: 'command:stop:control', generationId,
      operatorId: 'operator-primary', occurredAtMs: Date.now() }, 'ENTRY_STOP');
    await assert.rejects(armEnvelope(repository, prepared, intentId),
      isRepositoryError('CONTROL_STOPPED'));
    await assertNothingArmed(pool);
  });
});

for (const ending of ['REVOKED', 'EXPIRED', 'CUT_OFF'] as const) {
  void test(`armEnvelope refuses an envelope that is ${ending}`, async (context) => {
    await withSchema(context, async (pool) => {
      const simulation = await seedEnvelopeBase(pool);
      const repository = new PostgresExecutionOperationsRepository(pool);
      const prepared = await openEnvelope(pool, repository, simulation);
      await seedProviderSnapshot(pool);
      const intentId = await fastEntryIntent(pool, prepared.envelope, await currentDatabaseTimeMs(pool));
      const request = await envelopeArmRequest(repository, prepared, intentId);
      if (ending === 'REVOKED') {
        await repository.revokeEnvelope({ generationId, envelopeId: prepared.envelope.envelopeId,
          operatorId: 'operator-primary', occurredAtMs: Date.now() });
      } else if (ending === 'EXPIRED') {
        await moveEnvelopeIntoThePast(pool, prepared.envelope.envelopeId);
        assert.equal((await repository.expireEnvelopes(generationId)).expiredCount, 1);
      } else {
        // valid_until < now + holding (60 s) + 15 min.
        await mutateWithTriggersDisabled(pool, `UPDATE execution_entry_envelopes
          SET valid_until=date_trunc('milliseconds',statement_timestamp())+INTERVAL '15 minutes'
          WHERE envelope_id=$1`, [prepared.envelope.envelopeId]);
      }
      await assert.rejects(repository.armEnvelope(request), isRepositoryError('ENVELOPE_NOT_ARMABLE'));
      await assertNothingArmed(pool);
    });
  });
}

void test('armEnvelope keeps K=1: a second arm while one is ARMED is a conflict', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const prepared = await openEnvelope(pool, repository, simulation);
    await seedProviderSnapshot(pool);
    const nowMs = await currentDatabaseTimeMs(pool);
    const first = await fastEntryIntent(pool, prepared.envelope, nowMs);
    const second = await fastEntryIntent(pool, prepared.envelope, nowMs);
    await armEnvelope(repository, prepared, first);
    await assert.rejects(armEnvelope(repository, prepared, second), isRepositoryError('ARMAMENT_CONTENDED'));
    assert.deepEqual((await pool.query(`SELECT buys_armed FROM execution_entry_envelopes`)).rows,
      [{ buys_armed: 1 }]);
  });
});

for (const cap of [
  { name: 'max_buys=2', maxBuys: 2, maxTotalExposureRaw: 30_000_000n },
  { name: 'max_total_exposure=2 x per_buy with max_buys=5', maxBuys: 5, maxTotalExposureRaw: 20_000_000n },
] as const) {
  void test(`armEnvelope exhausts the envelope at ${cap.name} and refuses a third arm`, async (context) => {
    await withSchema(context, async (pool) => {
      const simulation = await seedEnvelopeBase(pool);
      const repository = new PostgresExecutionOperationsRepository(pool);
      const prepared = await openEnvelope(pool, repository, simulation,
        { maxBuys: cap.maxBuys, maxTotalExposureRaw: cap.maxTotalExposureRaw });
      await seedProviderSnapshot(pool);
      const nowMs = await currentDatabaseTimeMs(pool);
      const intents = [
        await fastEntryIntent(pool, prepared.envelope, nowMs),
        await fastEntryIntent(pool, prepared.envelope, nowMs),
        await fastEntryIntent(pool, prepared.envelope, nowMs),
      ];
      await armEnvelope(repository, prepared, intents[0] ?? '');
      await stopAndResume(repository, prepared.qualification, 'cap-1');
      assert.equal((await repository.readEnvelopes(generationId))[0]?.state, 'ACTIVE');
      const second = await armEnvelope(repository, prepared, intents[1] ?? '');
      const [exhausted] = await repository.readEnvelopes(generationId);
      assert.equal(exhausted?.state, 'EXHAUSTED');
      assert.equal(exhausted?.buysArmed, 2);
      await stopAndResume(repository, prepared.qualification, 'cap-2');
      // No ACTIVE envelope any more: the daemon would not even try; the repository refuses.
      await assert.rejects(repository.armEnvelope(await envelopeArmRequest(repository, prepared,
        intents[2] ?? '', { provider: { snapshot: second.providerSnapshot, localUsedUnits: 0n } })),
      isRepositoryError('ENVELOPE_NOT_ARMABLE'));
      assert.equal((await repository.readAutoArmContext(contextQuery())).envelope, null);
    });
  });
}

void test('armEnvelope refuses once the realized loss reaches the cap', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const prepared = await openEnvelope(pool, repository, simulation);
    await seedProviderSnapshot(pool);
    const intentId = await fastEntryIntent(pool, prepared.envelope, await currentDatabaseTimeMs(pool));
    await pool.query(`UPDATE execution_entry_envelopes SET realized_loss_raw=max_realized_loss_raw`);
    const armingContext = await repository.readAutoArmContext(contextQuery());
    assert.equal(armingContext.realizedLossRaw, 30_000_000n);
    await assert.rejects(armEnvelope(repository, prepared, intentId), isRepositoryError('ENVELOPE_NOT_ARMABLE'));
    await assertNothingArmed(pool);
  });
});

void test('armEnvelope refuses a non fast-entry intent and a quote other than per_buy', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const prepared = await openEnvelope(pool, repository, simulation);
    await seedProviderSnapshot(pool);
    const nowMs = await currentDatabaseTimeMs(pool);
    await insertExecutionDecisionEvent(pool, 'decision:other-strategy', publicKey);
    const other = await new PostgresExecutionIntentRepository(pool).create(createExecutionIntentDraft({
      strategyId: 'canary-target', strategyVersion: 1,
      positionId: 'position:other-strategy', logicalCommandId: 'command:other-strategy',
      mint: publicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint: WSOL,
      quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9,
      quoteAmountRaw: PER_BUY, baseAmountRaw: null, minimumAmountOutRaw: 1n,
      decisionEventId: 'decision:other-strategy', decisionFingerprint: 'd'.repeat(64),
      requestedAtMs: nowMs, expiresAtMs: nowMs + 120_000,
    }));
    await assert.rejects(armEnvelope(repository, prepared, other.intent.id),
      isRepositoryError('CONFLICT'));
    const smaller = await fastEntryIntent(pool, prepared.envelope, nowMs, PER_BUY / 2n);
    await assert.rejects(armEnvelope(repository, prepared, smaller), isRepositoryError('CONFLICT'));
    await assertNothingArmed(pool);
  });
});

void test('armEnvelope surfaces a provider carry-forward mismatch as PROVIDER_CARRY_FORWARD_STALE and writes nothing',
  async (context) => {
    await withSchema(context, async (pool) => {
      const simulation = await seedEnvelopeBase(pool);
      const repository = new PostgresExecutionOperationsRepository(pool);
      const prepared = await openEnvelope(pool, repository, simulation);
      const base = await seedProviderSnapshot(pool);
      const intentId = await fastEntryIntent(pool, prepared.envelope, await currentDatabaseTimeMs(pool));
      // The daemon read the context, then a counter was recorded before the arm.
      const request = await envelopeArmRequest(repository, prepared, intentId);
      await recordProviderUnits(pool, base, 'late', 2n);
      await assert.rejects(repository.armEnvelope(request), isRepositoryError('PROVIDER_CARRY_FORWARD_STALE'));
      await assertNothingArmed(pool);
      assert.deepEqual((await pool.query(`SELECT snapshot_id FROM execution_provider_usage_snapshots
        WHERE superseded_at IS NULL`)).rows, [{ snapshot_id: base.snapshotId }]);
      // Overstated usage is just as stale.
      const overstated = await envelopeArmRequest(repository, prepared, intentId, { extraUnits: 1n });
      await assert.rejects(repository.armEnvelope(overstated),
        isRepositoryError('PROVIDER_CARRY_FORWARD_STALE'));
      // An operator-reported snapshot is not a carry-forward at all.
      const reported = await envelopeArmRequest(repository, prepared, intentId,
        { provenance: 'OPERATOR_REPORT' });
      await assert.rejects(repository.armEnvelope(reported), isRepositoryError('CONFLICT'));
      await assertNothingArmed(pool);
      // A fresh context carries the late counter forward and arms.
      const armament = await armEnvelope(repository, prepared, intentId);
      assert.equal(armament.providerSnapshot.usedUnits, base.usedUnits + 2n);
    });
  });

void test('the carry-forward sums only the counters of the current billing period (A11)', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const prepared = await openEnvelope(pool, repository, simulation);
    const nowMs = await currentDatabaseTimeMs(pool);
    const risk = new PostgresExecutionRiskRepository(pool);
    const previous = createProviderUsageSnapshot({
      providerId: 'primary', planId: 'plan-1', billingPeriodId: 'period-0',
      billingPeriodStartedAtMs: nowMs - 3 * HOUR, billingPeriodEndsAtMs: nowMs - 2_000,
      limitUnits: 1_000n, usedUnits: 5n, measuredAtMs: nowMs - 40_000, expiresAtMs: nowMs - 5_000,
      provenance: 'OPERATOR_REPORT',
    });
    await risk.appendProviderUsage(previous);
    const current = createProviderUsageSnapshot({
      providerId: 'primary', planId: 'plan-1', billingPeriodId: 'period-1',
      billingPeriodStartedAtMs: nowMs - 2_000, billingPeriodEndsAtMs: nowMs + 3 * HOUR,
      limitUnits: 1_000n, usedUnits: 1n, measuredAtMs: nowMs - 1_000, expiresAtMs: nowMs + 300_000,
      provenance: 'OPERATOR_REPORT',
    });
    // Recorded now, after the current measurement, but billed to the previous period.
    await mutateWithTriggersDisabled(pool, `INSERT INTO execution_provider_usage_counters (
      operation_id,payload_version,snapshot_id,provider_id,billing_period_id,category,
      logical_operation_id,units) VALUES ($1,1,$2,'primary','period-0','ENTRY','old-period',7)`,
    [`execution_provider_operation_${'7'.repeat(64)}`, previous.snapshotId]);
    await risk.appendProviderUsage(current);
    await recordProviderUnits(pool, current, 'same-period', 3n);
    const view = await repository.readAutoArmContext(contextQuery());
    assert.equal(view.provider?.snapshot.snapshotId, current.snapshotId);
    assert.equal(view.provider?.localUsedUnits, 3n);
    const intentId = await fastEntryIntent(pool, prepared.envelope, await currentDatabaseTimeMs(pool));
    const armament = await armEnvelope(repository, prepared, intentId);
    assert.equal(armament.providerSnapshot.usedUnits, 4n);
  });
});

void test('armEnvelope refuses a CANARY qualification and the trigger refuses an envelope link on a CANARY armament',
  async (context) => {
    await withSchema(context, async (pool) => {
      const simulation = await seedEnvelopeBase(pool);
      const repository = new PostgresExecutionOperationsRepository(pool);
      const prepared = await prepareEnvelope(pool, repository, simulation);
      await repository.createEnvelope(prepared);
      const canary = await armCanary(pool, repository, simulation, { returnRequest: true });
      await assert.rejects(repository.armEnvelope({
        request: canary.request, authorization: canary.authorization,
        envelopeId: prepared.envelope.envelopeId,
      }), isRepositoryError('CONFLICT'));
      // The real CANARY armament, copied under a new identity: without an envelope link the
      // guard passes and the active unique index refuses it; with one, the guard refuses it.
      const copy = async (envelopeId: string | null) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`INSERT INTO execution_activation_armaments
            SELECT (jsonb_populate_record(NULL::execution_activation_armaments,
              to_jsonb(armament) || jsonb_build_object('armament_id',$2::TEXT,'envelope_id',$3::TEXT))).*
            FROM execution_activation_armaments armament WHERE armament_id=$1`, [
            canary.armament.armamentId, `execution_activation_armament_${'0'.repeat(64)}`, envelopeId,
          ]);
          return null;
        } catch (error) {
          return (error as { readonly code?: string }).code ?? 'unknown';
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      };
      assert.equal(await copy(null), '23505');
      assert.equal(await copy(prepared.envelope.envelopeId), '55000');
    });
  });

void test('armEnvelope refuses an operator mismatch and a qualification of another envelope with ENVELOPE_NOT_ARMABLE',
  async (context) => {
    await withSchema(context, async (pool) => {
      const simulation = await seedEnvelopeBase(pool);
      const repository = new PostgresExecutionOperationsRepository(pool);
      const first = await openEnvelope(pool, repository, simulation);
      await seedProviderSnapshot(pool);
      const intentId = await fastEntryIntent(pool, first.envelope, await currentDatabaseTimeMs(pool));
      const otherOperator = await envelopeArmRequest(repository, first, intentId,
        { operatorId: 'operator-other' });
      await assert.rejects(repository.armEnvelope(otherOperator),
        isRepositoryError('ENVELOPE_NOT_ARMABLE'));
      // The first envelope is revoked and a second one opened: a request carrying the first
      // envelope's qualification is refused against the second envelope.
      await repository.revokeEnvelope({ generationId, envelopeId: first.envelope.envelopeId,
        operatorId: 'operator-primary', occurredAtMs: Date.now() });
      const second = await prepareEnvelope(pool, repository, simulation,
        { nonce: '2', expiresInMs: 3 * HOUR });
      await repository.createEnvelope(second);
      const later = await fastEntryIntent(pool, second.envelope, await currentDatabaseTimeMs(pool));
      const stale = await envelopeArmRequest(repository, first, later);
      await assert.rejects(repository.armEnvelope({ ...stale, envelopeId: second.envelope.envelopeId }),
        isRepositoryError('ENVELOPE_NOT_ARMABLE'));
      await assertNothingArmed(pool);
    });
  });

void test('armEnvelope surfaces a wallet snapshot superseded concurrently as ARMAMENT_CONTENDED', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const prepared = await openEnvelope(pool, repository, simulation);
    await seedProviderSnapshot(pool);
    const intentId = await fastEntryIntent(pool, prepared.envelope, await currentDatabaseTimeMs(pool));
    const armed = await envelopeArmRequest(repository, prepared, intentId);
    const risk = new PostgresExecutionRiskRepository(pool);
    const wallet = armed.request.walletSnapshot;
    await risk.appendWalletSnapshot(wallet);
    await risk.appendWalletSnapshot(createExecutionWalletSnapshot({
      generationId, providerId: 'primary', stateRevision: wallet.stateRevision, slot: 11n,
      blockTimeMs: wallet.observedAtMs, observedAtMs: wallet.observedAtMs + 20,
      commitment: 'finalized', walletLamports: 230_000_000n, tokenBalanceCount: 0,
      openPositions: [], realizedNetPnlRaw: 0n,
    }));
    await assert.rejects(repository.armEnvelope(armed), isRepositoryError('ARMAMENT_CONTENDED'));
    await assertNothingArmed(pool);
  });
});

void test('readAutoArmContext returns the envelope and picks the oldest eligible fast-entry intent', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const repository = new PostgresExecutionOperationsRepository(pool);
    const empty = await repository.readAutoArmContext(contextQuery());
    assert.equal(empty.envelope, null);
    assert.equal(empty.qualification, null);
    assert.equal(empty.controlState, 'ENTRY_STOP');
    assert.equal(empty.candidateIntent, null);
    assert.equal(empty.provider, null);
    const prepared = await openEnvelope(pool, repository, simulation);
    const base = await seedProviderSnapshot(pool);
    await recordProviderUnits(pool, base, 'context', 4n);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const from = prepared.envelope.validFromMs;
    const excluded = await fastEntryIntent(pool, prepared.envelope, from + 1);
    const leased = await fastEntryIntent(pool, prepared.envelope, from + 2);
    const shortLived = await fastEntryIntent(pool, prepared.envelope, from + 3);
    const preEnvelope = await fastEntryIntent(pool, prepared.envelope, from + 4);
    const smaller = await fastEntryIntent(pool, prepared.envelope, from + 5, PER_BUY / 2n);
    const reasoned = await fastEntryIntent(pool, prepared.envelope, from + 6);
    const oldest = await fastEntryIntent(pool, prepared.envelope, from + 7);
    const next = await fastEntryIntent(pool, prepared.envelope, from + 8);
    await mutateWithTriggersDisabled(pool, `UPDATE execution_intents SET lease_owner='worker',
      lease_token=gen_random_uuid(),
      lease_expires_at=date_trunc('milliseconds',statement_timestamp())+INTERVAL '1 minute'
      WHERE id=$1`, [leased]);
    await mutateWithTriggersDisabled(pool, `UPDATE execution_intents
      SET expires_at=date_trunc('milliseconds',statement_timestamp())+INTERVAL '30 seconds' WHERE id=$1`,
    [shortLived]);
    await mutateWithTriggersDisabled(pool, `UPDATE execution_intents
      SET requested_at=requested_at-INTERVAL '1 second' WHERE id=$1`, [preEnvelope]);
    // A row lockedCanaryTarget would refuse (a reason code while PENDING) is never offered.
    await pool.query(`ALTER TABLE execution_intents
      DROP CONSTRAINT execution_intents_pending_check,
      DROP CONSTRAINT execution_intents_status_reason_check`);
    await mutateWithTriggersDisabled(pool, `UPDATE execution_intents
      SET last_reason_code='EXECUTION_STARTED' WHERE id=$1`, [reasoned]);
    const view = await repository.readAutoArmContext(contextQuery({ excludedIntentIds: [excluded] }));
    assert.ok(Object.isFrozen(view));
    assert.ok(view.databaseNowMs >= from);
    assert.deepEqual(view.envelope, prepared.envelope);
    assert.ok(view.envelope !== null && Object.isFrozen(view.envelope) && Object.isFrozen(view.envelope.policy));
    assert.deepEqual(view.qualification, prepared.qualification);
    assert.equal(view.buysArmed, 0);
    assert.equal(view.realizedLossRaw, 0n);
    assert.equal(view.controlState, 'RUNNING');
    assert.equal(view.riskStateRevision, 0n);
    assert.equal(view.openPositions, 0);
    assert.equal(view.unknownBlock, false);
    assert.equal(view.activeArmament, null);
    assert.deepEqual(view.provider, { snapshot: base, localUsedUnits: 4n });
    assert.equal(view.providerRefreshDue, false);
    assert.equal(view.candidateIntent?.intentId, oldest);
    assert.equal(view.candidateIntent?.strategyId, FAST_ENTRY_STRATEGY_ID);
    assert.equal(view.candidateIntent?.quoteAmountRaw, PER_BUY);
    assert.notEqual(smaller, oldest);
    const skipped = await repository.readAutoArmContext(contextQuery({ excludedIntentIds: [excluded, oldest] }));
    assert.equal(skipped.candidateIntent?.intentId, next);
    // Without the exclusion the oldest eligible one wins, whatever the margin allows.
    const all = await repository.readAutoArmContext(contextQuery({ minimumRemainingMs: 0 }));
    assert.equal(all.candidateIntent?.intentId, excluded);
    const tooShort = await repository.readAutoArmContext(contextQuery({ minimumRemainingMs: 3_600_000 }));
    assert.equal(tooShort.candidateIntent, null);
    await assert.rejects(repository.readAutoArmContext(contextQuery({ excludedIntentIds: ['nope'] })),
      isRepositoryError('INVALID_DATA'));
  });
});

void test('providerRefreshDue follows the armament and the BUY, and refresh carries the counters forward',
  async (context) => {
    await withSchema(context, async (pool) => {
      const simulation = await seedEnvelopeBase(pool);
      const repository = new PostgresExecutionOperationsRepository(pool);
      const prepared = await openEnvelope(pool, repository, simulation);
      await seedProviderSnapshot(pool);
      const intentId = await fastEntryIntent(pool, prepared.envelope, await currentDatabaseTimeMs(pool));
      const armament = await armEnvelope(repository, prepared, intentId, SHORT_PROVIDER);
      const wide = contextQuery();
      const command = { generationId, maximumAgeMs: 300_000, providerRefreshThresholdMs: 300_000 };
      const armed = await repository.readAutoArmContext(wide);
      assert.equal(armed.activeArmament, 'ARMED');
      assert.equal(armed.providerRefreshDue, false);
      assert.equal((await repository.refreshEnvelopeProviderSnapshot(command)).refreshed, false);
      await lockArmamentAfterBuy(pool, armament.armamentId, intentId, 'SUBMITTED');
      const inFlight = await repository.readAutoArmContext(wide);
      assert.equal(inFlight.activeArmament, 'LOCKED');
      assert.equal(inFlight.providerRefreshDue, false);
      assert.equal((await repository.refreshEnvelopeProviderSnapshot(command)).refreshed, false);
      await lockArmamentAfterBuy(pool, armament.armamentId, intentId, 'SUCCEEDED');
      const succeeded = await repository.readAutoArmContext(wide);
      assert.equal(succeeded.providerRefreshDue, true);
      assert.equal(succeeded.refreshProviderUsageMaxAgeMs, 300_000);
      assert.equal((await repository.refreshEnvelopeProviderSnapshot({ ...command,
        providerRefreshThresholdMs: 1 })).refreshed, false);
      // The threshold may not exceed the carried-forward snapshot's own age.
      await assert.rejects(repository.refreshEnvelopeProviderSnapshot({ ...command,
        providerRefreshThresholdMs: command.maximumAgeMs + 1 }), isRepositoryError('INVALID_DATA'));
      const latest = succeeded.provider?.snapshot;
      assert.ok(latest !== undefined);
      // The admission of the arm itself recorded the entry cost (8 units) after the measurement.
      assert.equal(succeeded.provider?.localUsedUnits, 8n);
      await recordProviderUnits(pool, latest, 'sell-quote', 5n);
      const refreshed = await repository.refreshEnvelopeProviderSnapshot(command);
      assert.equal(refreshed.refreshed, true);
      assert.ok(refreshed.snapshot !== null);
      assert.equal(refreshed.snapshot.provenance, 'EXECUTOR_COUNTERS');
      assert.equal(refreshed.snapshot.usedUnits, latest.usedUnits + 8n + 5n);
      assert.equal(refreshed.snapshot.measuredAtMs, refreshed.databaseNowMs);
      assert.equal(refreshed.snapshot.expiresAtMs, refreshed.databaseNowMs + 300_000);
      const after = await repository.readAutoArmContext(wide);
      assert.deepEqual(after.provider, { snapshot: refreshed.snapshot, localUsedUnits: 0n });
      // A12: 300 s left is not within half the 300 s policy max age.
      assert.equal(after.providerRefreshDue, false);
      // Over the limit: a distinct code, nothing written.
      await recordProviderUnits(pool, refreshed.snapshot, 'flood', 5_000n);
      await assert.rejects(repository.refreshEnvelopeProviderSnapshot(command),
        isRepositoryError('PROVIDER_CARRY_FORWARD_REJECTED'));
      assert.equal((await repository.readAutoArmContext(wide)).provider?.snapshot.snapshotId,
        refreshed.snapshot.snapshotId);
    });
  });

void test('after the last arm EXHAUSTS the envelope, a fresh context still has the refresh policy',
  async (context) => {
    await withSchema(context, async (pool) => {
      const simulation = await seedEnvelopeBase(pool);
      const repository = new PostgresExecutionOperationsRepository(pool);
      const prepared = await openEnvelope(pool, repository, simulation, { maxBuys: 1 });
      await seedProviderSnapshot(pool);
      const intentId = await fastEntryIntent(pool, prepared.envelope, await currentDatabaseTimeMs(pool));
      const armament = await armEnvelope(repository, prepared, intentId, SHORT_PROVIDER);
      assert.equal((await repository.readEnvelopes(generationId))[0]?.state, 'EXHAUSTED');
      await lockArmamentAfterBuy(pool, armament.armamentId, intentId, 'SUCCEEDED');
      // A new repository: nothing carried over from the arm.
      const view = await new PostgresExecutionOperationsRepository(pool).readAutoArmContext(contextQuery());
      assert.equal(view.envelope, null);
      assert.equal(view.activeArmament, 'LOCKED');
      assert.equal(view.refreshProviderUsageMaxAgeMs, prepared.envelope.policy.providerUsageMaxAgeMs);
      assert.equal(view.providerRefreshDue, true);
      const refreshed = await repository.refreshEnvelopeProviderSnapshot({
        generationId, maximumAgeMs: 300_000, providerRefreshThresholdMs: 150_000,
      });
      assert.equal(refreshed.refreshed, true);
    });
  });

void test('readAutoArmContext has no refresh policy without an envelope or envelope armament',
  async (context) => {
    await withSchema(context, async (pool) => {
      await seedEnvelopeBase(pool);
      const view = await new PostgresExecutionOperationsRepository(pool).readAutoArmContext(contextQuery());
      assert.equal(view.refreshProviderUsageMaxAgeMs, null);
      assert.equal(view.providerRefreshDue, false);
    });
  });




/** ENTRY_STOP then RESUME: revokes the ARMED armament and releases its reservation. */
async function stopAndResume(
  repository: PostgresExecutionOperationsRepository,
  qualification: ExecutionSafetyQualificationV2,
  tag: string,
): Promise<void> {
  await repository.setStop({ payloadVersion: 1, commandId: `command:stop:${tag}`, generationId,
    operatorId: 'operator-primary', occurredAtMs: Date.now() }, 'ENTRY_STOP');
  await resumeWith(repository, qualification, tag);
}


async function recordProviderUnits(
  pool: Pool,
  snapshot: ProviderUsageSnapshotV1,
  logicalOperationId: string,
  units: bigint,
): Promise<void> {
  const identity = {
    providerId: snapshot.providerId, billingPeriodId: snapshot.billingPeriodId,
    category: 'ENTRY' as const, logicalOperationId,
  };
  assert.equal(await new PostgresExecutionRiskRepository(pool).recordProviderOperation({
    operationId: createProviderUsageOperationId(identity), payloadVersion: 1,
    snapshotId: snapshot.snapshotId, ...identity, units,
  }), 'RECORDED');
}


/** Carried-forward snapshots expire 30 s after the arm: within half the 300 s policy max age. */
const SHORT_PROVIDER = Object.freeze({ providerMaxAgeMs: 30_000 });

async function assertNothingArmed(pool: Pool): Promise<void> {
  assert.deepEqual((await pool.query(`SELECT
    (SELECT COUNT(*)::INTEGER FROM execution_activation_armaments
      WHERE envelope_id IS NOT NULL) AS armaments,
    (SELECT COUNT(*)::INTEGER FROM execution_intents WHERE live_reserved) AS reserved,
    (SELECT COUNT(*)::INTEGER FROM execution_exposure_reservations WHERE state='RESERVED') AS reservations,
    (SELECT COALESCE(SUM(buys_armed),0)::INTEGER FROM execution_entry_envelopes) AS buys_armed,
    (SELECT COUNT(*)::INTEGER FROM execution_operator_authorizations
      WHERE payload_version=2) AS arm_authorizations`)).rows,
  [{ armaments: 0, reserved: 0, reservations: 0, buys_armed: 0, arm_authorizations: 0 }]);
}

/** Forges what H2b leaves behind: the armament LOCKED on its BUY, the BUY at `status`. */
async function lockArmamentAfterBuy(
  pool: Pool,
  armamentId: string,
  intentId: string,
  status: 'SUBMITTED' | 'SUCCEEDED',
): Promise<void> {
  await mutateWithTriggersDisabled(pool, `UPDATE execution_activation_armaments SET
    state='LOCKED',state_revision=1,consumed_buys=1,locked_intent_id=target_intent_id,
    locked_attempt_number=1,locked_reservation_id=target_reservation_id,
    locked_lease_token=gen_random_uuid(),locked_at=date_trunc('milliseconds',statement_timestamp()),
    terminal_at=NULL,purge_after=NULL WHERE armament_id=$1`, [armamentId]);
  await mutateWithTriggersDisabled(pool, status === 'SUBMITTED'
    ? `UPDATE execution_intents SET status='SUBMITTED',last_reason_code='SUBMISSION_ACCEPTED',
      attempt_count=1 WHERE id=$1`
    : `UPDATE execution_intents SET status='SUCCEEDED',last_reason_code='INTENT_SUCCEEDED',
      attempt_count=1,
      terminal_at=GREATEST(date_trunc('milliseconds',statement_timestamp()),requested_at) WHERE id=$1`,
  [intentId]);
}

async function moveEnvelopeIntoThePast(pool: Pool, envelopeId: string) {
  await mutateWithTriggersDisabled(pool, `UPDATE execution_entry_envelopes SET
    valid_from=date_trunc('milliseconds',statement_timestamp())-INTERVAL '2 hours',
    valid_until=date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 second',
    created_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '2 hours',
    updated_at=date_trunc('milliseconds',statement_timestamp())-INTERVAL '2 hours'
    WHERE envelope_id=$1`, [envelopeId]);
}


function isRepositoryError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ExecutionOperationsRepositoryError && error.code === code;
}

