import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExecutionLiveRepositoryError,
  PostgresExecutionLiveRepository,
} from '../src/storage/execution-live.repository.js';
import { PostgresExecutionOperationsRepository } from '../src/storage/execution-operations.repository.js';
import {
  canaryBuyFixture, envelopeBuyFixture, generationId, hash, liveRuntimeLimits as runtimeLimits,
  prepareEnvelope, publicKey, roleSource, type SeededSimulation, seedEnvelopeBase, withProvisionedDatabase,
  withSchema,
} from './helpers/entry-envelope-fixture.js';
import { mutateWithTriggersDisabled } from './helpers/execution-preflight-v2-source-fixture.js';

void test('H2b runnable work starts on an ACTIVE v2 envelope alone and on nothing else', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const operations = new PostgresExecutionOperationsRepository(pool);
    const live = new PostgresExecutionLiveRepository(pool);
    const binding = runnableBinding(simulation);
    await assert.rejects(live.assertRunnableWork(binding), isLiveError('LIVE_EXECUTOR_NO_WORK'));

    const active = await prepareEnvelope(pool, operations, simulation, { nonce: '1' });
    await operations.createEnvelope(active);
    await live.assertRunnableWork(binding);
    // Another generation's envelope never makes this generation runnable.
    await assert.rejects(live.assertRunnableWork(Object.freeze({
      ...binding, generationId: `execution_wallet_generation_${'b'.repeat(64)}`,
    })), isLiveError('LIVE_EXECUTOR_NO_WORK'));

    // REVOKED.
    await operations.revokeEnvelope(Object.freeze({
      generationId, envelopeId: active.envelope.envelopeId,
      operatorId: 'operator-primary', occurredAtMs: Date.now(),
    }));
    await assert.rejects(live.assertRunnableWork(binding), isLiveError('LIVE_EXECUTOR_NO_WORK'));

    // Still ACTIVE in state but past valid_until.
    const lapsed = await prepareEnvelope(pool, operations, simulation, { nonce: '2' });
    await operations.createEnvelope(lapsed);
    await live.assertRunnableWork(binding);
    await mutateWithTriggersDisabled(pool, `UPDATE execution_entry_envelopes SET
      valid_from=date_trunc('milliseconds',statement_timestamp())-INTERVAL '2 hours',
      valid_until=date_trunc('milliseconds',statement_timestamp())-INTERVAL '1 second'
      WHERE envelope_id=$1`, [lapsed.envelope.envelopeId]);
    assert.deepEqual((await pool.query(`SELECT state FROM execution_entry_envelopes
      WHERE envelope_id=$1`, [lapsed.envelope.envelopeId])).rows, [{ state: 'ACTIVE' }]);
    await assert.rejects(live.assertRunnableWork(binding), isLiveError('LIVE_EXECUTOR_NO_WORK'));
    assert.equal((await operations.expireEnvelopes(generationId)).expiredCount, 1);

    // A lot-3 v1 envelope is never armable, so it is not work either.
    await pool.query(`INSERT INTO execution_entry_envelopes (
      envelope_id,generation_id,operator_id,payload_version,fingerprint,per_buy_quote_amount_raw,
      max_buys,max_open_positions,max_total_exposure_raw,max_realized_loss_raw,valid_from,
      valid_until,state,created_at,updated_at
    ) VALUES ('envelope-v1',$1,'operator-primary',1,$2,1000,1,1,1000,1000,
      statement_timestamp()-INTERVAL '1 minute',statement_timestamp()+INTERVAL '1 hour','ACTIVE',
      statement_timestamp(),statement_timestamp())`, [generationId, 'e'.repeat(64)]);
    await assert.rejects(live.assertRunnableWork(binding), isLiveError('LIVE_EXECUTOR_NO_WORK'));
  });
});

void test('ENVELOPE armament signs although its gate bindings are not the target snapshots', async (context) => {
  await withSchema(context, async (pool) => {
    const fixture = await envelopeBuyFixture(pool);
    assert.deepEqual((await pool.query(`SELECT
      bool_or(gate.evidence_fingerprint=armament.target_wallet_snapshot_fingerprint
        OR gate.evidence_fingerprint=armament.target_provider_snapshot_fingerprint) AS any_equal,
      array_agg(qualification.scope) AS scopes
      FROM execution_activation_armaments armament
      JOIN execution_safety_qualifications qualification
        ON qualification.qualification_id=armament.qualification_id
      JOIN execution_safety_gate_evidence gate
        ON gate.qualification_id=qualification.qualification_id AND gate.gate_index IN (7,9)
      WHERE armament.armament_id=$1`, [fixture.armamentId])).rows,
    [{ any_equal: false, scopes: ['ENVELOPE', 'ENVELOPE'] }]);
    const live = new PostgresExecutionLiveRepository(pool);
    const authorization = await live.authorizeExactSigning(fixture.input);
    assert.equal(authorization.binding.armamentId, fixture.armamentId);
    const replay = await live.authorizeExactSigning(fixture.input);
    assert.equal(replay.preSignatureLockId, authorization.preSignatureLockId);
  });
});

void test('ENVELOPE signing keeps every other check: a superseded wallet snapshot is refused', async (context) => {
  await withSchema(context, async (pool) => {
    const fixture = await envelopeBuyFixture(pool);
    await mutateWithTriggersDisabled(pool, `UPDATE execution_wallet_snapshots SET
      superseded_at=date_trunc('milliseconds',statement_timestamp()),
      purge_after=date_trunc('milliseconds',statement_timestamp())+INTERVAL '4 hours'
      WHERE snapshot_fingerprint=(SELECT target_wallet_snapshot_fingerprint
        FROM execution_activation_armaments WHERE armament_id=$1)`, [fixture.armamentId]);
    await assert.rejects(new PostgresExecutionLiveRepository(pool).authorizeExactSigning(fixture.input),
      isLiveError('PREFLIGHT_EXPIRED'));
  });
});

for (const refusal of [
  {
    name: 'gate 7 expires before the signing deadline',
    sql: `UPDATE execution_safety_gate_evidence SET
      expires_at=date_trunc('milliseconds',statement_timestamp())+INTERVAL '1 second'
      WHERE gate_index=7 AND qualification_id=(SELECT qualification_id
        FROM execution_activation_armaments WHERE armament_id=$1)`,
  },
  {
    name: 'gate 9 expires before the signing deadline',
    sql: `UPDATE execution_safety_gate_evidence SET
      expires_at=date_trunc('milliseconds',statement_timestamp())+INTERVAL '1 second'
      WHERE gate_index=9 AND qualification_id=(SELECT qualification_id
        FROM execution_activation_armaments WHERE armament_id=$1)`,
  },
  {
    name: 'the provider snapshot is superseded',
    sql: `UPDATE execution_provider_usage_snapshots SET
      superseded_at=date_trunc('milliseconds',statement_timestamp()),
      purge_after=date_trunc('milliseconds',statement_timestamp())+INTERVAL '4 hours'
      WHERE snapshot_fingerprint=(SELECT target_provider_snapshot_fingerprint
        FROM execution_activation_armaments WHERE armament_id=$1)`,
  },
] as const) {
  void test(`ENVELOPE signing is refused when ${refusal.name}`, async (context) => {
    await withSchema(context, async (pool) => {
      const fixture = await envelopeBuyFixture(pool);
      await mutateWithTriggersDisabled(pool, refusal.sql, [fixture.armamentId]);
      await assert.rejects(new PostgresExecutionLiveRepository(pool).authorizeExactSigning(fixture.input),
        isLiveError('PREFLIGHT_EXPIRED'));
    });
  });
}

void test('PostgreSQL 16 live role starts on an ACTIVE envelope and reads the qualification scope',
  async (context) => {
    await withProvisionedDatabase(context, async (pool) => {
      const liveSource = roleSource(pool, 'sol_token_executor_live');
      const live = new PostgresExecutionLiveRepository(liveSource);
      const operations = new PostgresExecutionOperationsRepository(pool);
      const simulation = await seedEnvelopeBase(pool);
      const binding = runnableBinding(simulation);
      await assert.rejects(live.assertRunnableWork(binding), isLiveError('LIVE_EXECUTOR_NO_WORK'));
      const prepared = await prepareEnvelope(pool, operations, simulation);
      await operations.createEnvelope(prepared);
      await live.assertRunnableWork(binding);
      const client = await liveSource.connect();
      try {
        assert.deepEqual((await client.query(`SELECT scope FROM execution_safety_qualifications
          WHERE qualification_id=$1`, [prepared.qualification.qualificationId])).rows,
        [{ scope: 'ENVELOPE' }]);
      } finally { client.release(); }
      await operations.revokeEnvelope(Object.freeze({
        generationId, envelopeId: prepared.envelope.envelopeId,
        operatorId: 'operator-primary', occurredAtMs: Date.now(),
      }));
      await assert.rejects(live.assertRunnableWork(binding), isLiveError('LIVE_EXECUTOR_NO_WORK'));
    });
  });

for (const scope of ['ENVELOPE', 'CANARY'] as const) {
  void test(`PostgreSQL 16 live role authorizes and replays the BUY signing of a ${scope} armament`,
    async (context) => {
      await withProvisionedDatabase(context, async (pool) => {
        const live = new PostgresExecutionLiveRepository(roleSource(pool, 'sol_token_executor_live'));
        const simulation = await seedEnvelopeBase(pool);
        const fixture = scope === 'ENVELOPE'
          ? await envelopeBuyFixture(pool, simulation) : await canaryBuyFixture(pool, simulation);
        const authorization = await live.authorizeExactSigning(fixture.input);
        assert.equal(authorization.binding.armamentId, fixture.armamentId);
        const replay = await live.authorizeExactSigning(fixture.input);
        assert.equal(replay.preSignatureLockId, authorization.preSignatureLockId);
      });
    });
}

function runnableBinding(simulation: SeededSimulation) {
  return Object.freeze({
    payloadVersion: 1 as const, generationId, phase: 'CANARY' as const, buildHash: hash,
    configurationFingerprint: simulation.configurationFingerprint,
    strategyFingerprint: '3'.repeat(64), walletPublicKey: publicKey,
    cluster: 'mainnet-beta' as const, genesisHash: publicKey, providerId: 'primary',
    ...runtimeLimits,
  });
}

function isLiveError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ExecutionLiveRepositoryError && error.code === code;
}
