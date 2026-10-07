import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
import {
  ExecutionLiveRepositoryError,
  PostgresExecutionLiveRepository,
} from '../src/storage/execution-live.repository.js';
import { PostgresExecutionOperationsRepository } from '../src/storage/execution-operations.repository.js';
import {
  armEnvelope, currentDatabaseTimeMs, fastEntryIntent, generationId, hash, openEnvelope,
  type Pool, prepareEnvelope, publicKey, roleSource, type SeededSimulation, seedEnvelopeBase,
  seedProviderSnapshot, withProvisionedDatabase, withSchema,
} from './helpers/entry-envelope-fixture.js';
import { mutateWithTriggersDisabled } from './helpers/execution-preflight-v2-source-fixture.js';

const runtimeLimits = Object.freeze({
  quoteMaxAgeMs: 60_000, slippageBps: 1_000n, snapshotMaxSlotLag: 8,
  maxComputeUnits: 200_000n, maxFeeLamports: 5_000n,
  maxFeePayerLamportDebit: 100_000n, maxRpcCallsPerAttempt: 12, leaseMs: 3_000,
});

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

function runnableBinding(simulation: SeededSimulation) {
  return Object.freeze({
    payloadVersion: 1 as const, generationId, phase: 'CANARY' as const, buildHash: hash,
    configurationFingerprint: simulation.configurationFingerprint,
    strategyFingerprint: '3'.repeat(64), walletPublicKey: publicKey,
    cluster: 'mainnet-beta' as const, genesisHash: publicKey, providerId: 'primary',
    ...runtimeLimits,
  });
}

/** A fast-entry BUY armed by `armEnvelope`, claimed and begun as H2b does before signing. */
async function envelopeBuyFixture(pool: Pool, seeded?: SeededSimulation) {
  const simulation = seeded ?? await seedEnvelopeBase(pool);
  const operations = new PostgresExecutionOperationsRepository(pool);
  const prepared = await openEnvelope(pool, operations, simulation);
  await seedProviderSnapshot(pool);
  const intentId = await fastEntryIntent(pool, prepared.envelope, await currentDatabaseTimeMs(pool));
  const armament = await armEnvelope(operations, prepared, intentId);
  const intents = new PostgresExecutionIntentRepository(pool);
  const claimed = await intents.claim({
    ownerId: 'envelope-live-test', leaseMs: 60_000, purpose: 'LIVE_EXECUTE',
    side: 'BUY', generationId,
  });
  assert.ok(claimed);
  assert.equal(claimed.intent.id, intentId);
  const nowMs = await currentDatabaseTimeMs(pool);
  const processing = await intents.transition(claimed, {
    intentId, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
    leaseToken: claimed.leaseToken, reasonCode: 'EXECUTION_STARTED',
    humanMessage: 'Prepare an envelope BUY.', activationPhase: 'CANARY',
    evidence: Object.freeze({
      payloadVersion: 1, attemptNumber: null, sourceEventId: null, observedAtMs: nowMs,
    }),
  });
  const begun = await intents.beginAttempt(Object.freeze({ ...claimed, intent: processing }));
  const payer = new PublicKey(publicKey);
  const unsigned = new VersionedTransaction(new TransactionMessage({
    payerKey: payer, recentBlockhash: publicKey, instructions: [],
  }).compileToV0Message());
  const messageBytes = Object.freeze([...unsigned.message.serialize()]);
  const unsignedTransactionBytes = Object.freeze([...unsigned.serialize()]);
  const messageHash = createHash('sha256').update(Uint8Array.from(messageBytes)).digest('hex');
  const quoteObservedAtMs = await currentDatabaseTimeMs(pool);
  const unsignedSimulation = Object.freeze({
    outcome: 'SUCCESS' as const, snapshotFingerprint: '6'.repeat(64),
    buildFingerprint: hash, messageHash, blockhash: publicKey, lastValidBlockHeight: 1_000n,
    blockhashContextSlot: 124n, feeContextSlot: 124n, estimatedFeeLamports: 5_000n,
    simulationSlot: 125n, simulatedFeePayerLamportDebit: 5_000n, unitsConsumed: 25_000n,
    simulatedBaseDeltaRaw: 100n, simulatedQuoteDeltaRaw: -1_000n,
    logsFingerprint: '8'.repeat(64), logsLineCount: 1,
  });
  const material = Object.freeze({
    payloadVersion: 1 as const, walletPublicKey: publicKey, providerId: 'primary',
    side: 'BUY' as const, effectiveVenue: 'PUMP_FUN' as const, snapshotSlot: 124n,
    quoteFingerprint: '7'.repeat(64), quoteObservedAtMs,
    quoteExpiresAtMs: quoteObservedAtMs + 60_000, buildFingerprint: hash,
    snapshotFingerprint: '6'.repeat(64), messageHash, messageBytes,
    unsignedTransactionHash: createHash('sha256')
      .update(Uint8Array.from(unsignedTransactionBytes)).digest('hex'),
    unsignedTransactionBytes, blockhash: publicKey, lastValidBlockHeight: 1_000n,
    unsignedSimulation,
  });
  const runtime = Object.freeze({
    payloadVersion: 1 as const, phase: 'CANARY' as const, buildHash: hash,
    configurationFingerprint: simulation.configurationFingerprint,
    strategyFingerprint: '3'.repeat(64), walletPublicKey: publicKey,
    cluster: 'mainnet-beta' as const, expectedGenesisHash: publicKey,
    observedGenesisHash: publicKey, providerId: 'primary', ...runtimeLimits,
  });
  return Object.freeze({
    armamentId: armament.armamentId,
    input: Object.freeze({
      claim: begun.claim, attempt: begun.attempt, generationId, runtime, material,
    }),
  });
}

function isLiveError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ExecutionLiveRepositoryError && error.code === code;
}
