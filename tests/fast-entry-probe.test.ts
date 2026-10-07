import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import { createExecutionIntentDraft } from '../src/domain/execution-intent.js';
import { createExecutionSimulationArtifactDraft } from '../src/domain/execution-simulation.js';
import {
  FAST_ENTRY_PROBE_QUOTE_AMOUNT_RAW,
  FAST_ENTRY_PROBE_STRATEGY_ID,
} from '../src/domain/fast-entry.js';
import { createSimulationOnlyWorker } from '../src/executor/simulation-worker.js';
import { purgeExpiredFoundationData } from '../src/storage/database.js';
import {
  assertExecutionIntentLineageCurrentInTransaction,
  ExecutionIntentLineageRepositoryError,
} from '../src/storage/execution-intent-lineage.repository.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
import {
  ExecutionOperationsRepositoryError,
  PostgresExecutionOperationsRepository,
} from '../src/storage/execution-operations.repository.js';
import { PostgresExecutionRiskRepository } from '../src/storage/execution-risk.repository.js';
import { PostgresExecutionSimulationRepository } from '../src/storage/execution-simulation.repository.js';
import { PostgresFastEntryRepository } from '../src/storage/fast-entry.repository.js';
import {
  armCanary, armEnvelope, contextQuery, currentDatabaseTimeMs, fastEntryIntent, generationId,
  hash, openEnvelope, PER_BUY, type Pool, PUMP_PROGRAM, publicKey, roleSource, seedEnvelopeBase,
  seedProviderSnapshot, withProvisionedDatabase, withSchema, WSOL,
} from './helpers/entry-envelope-fixture.js';
import { insertExecutionDecisionEvent } from './helpers/execution-decision-event.js';

/*
 * Lot 5a: the fast-entry probe intent exists only so the simulation-only worker can produce the
 * gate-10 artifact. It must never be armed, signed or sent: one refusal per arming path.
 */

const PROBE_CHECK = 'execution_intents_probe_unarmable_check';

void test('envelope arming: auto-arm never offers a probe and armEnvelope refuses it', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const operations = new PostgresExecutionOperationsRepository(pool);
    const prepared = await openEnvelope(pool, operations, simulation);
    await seedProviderSnapshot(pool);
    // Otherwise eligible: per-buy amount, requested inside the envelope window.
    const probeId = await probeRow(pool, PER_BUY, await currentDatabaseTimeMs(pool));
    const view = await operations.readAutoArmContext(contextQuery({ minimumRemainingMs: 0 }));
    assert.equal(view.candidateIntent, null);
    await assert.rejects(armEnvelope(operations, prepared, probeId), isRepositoryError('CONFLICT'));
    await assertNotArmed(pool, probeId);
    assert.deepEqual((await pool.query(`SELECT buys_armed FROM execution_entry_envelopes`)).rows,
      [{ buys_armed: 0 }]);
    // The same query still offers a real fast-entry intent.
    const real = await fastEntryIntent(pool, prepared.envelope, await currentDatabaseTimeMs(pool));
    const offered = await operations.readAutoArmContext(contextQuery({ minimumRemainingMs: 0 }));
    assert.equal(offered.candidateIntent?.intentId, real);
  });
});

void test('CANARY v2 arming refuses a probe target at the DB layer', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    const operations = new PostgresExecutionOperationsRepository(pool);
    await assert.rejects(
      armCanary(pool, operations, simulation, { strategyId: FAST_ENTRY_PROBE_STRATEGY_ID }),
      isRepositoryError('CONFLICT'),
    );
    const probe = (await pool.query<{ readonly id: string }>(`SELECT id FROM execution_intents
      WHERE strategy_id=$1`, [FAST_ENTRY_PROBE_STRATEGY_ID])).rows[0]?.id;
    assert.ok(probe !== undefined);
    await assertNotArmed(pool, probe);
  });
});

void test('CANARY v3 arming: the lineage check refuses a probe target (no paper lineage)', async (context) => {
  await withSchema(context, async (pool) => {
    const probeId = await probeRow(pool, PER_BUY, await currentDatabaseTimeMs(pool));
    const client = await pool.connect();
    try {
      await assert.rejects(assertExecutionIntentLineageCurrentInTransaction(client, probeId),
        (error) => error instanceof ExecutionIntentLineageRepositoryError && error.code === 'LINEAGE_INVALID');
    } finally {
      client.release();
    }
    // And no preflight pair can name it as a v3 target: v3 locks the target by its pair.
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS n FROM execution_preflight_intent_pairs
      WHERE target_intent_id=$1 OR simulation_intent_id=$1`, [probeId])).rows[0]?.n, 0);
    await assertNotArmed(pool, probeId);
  });
});

void test('no probe is written while a v2 envelope is ACTIVE', async (context) => {
  await withSchema(context, async (pool) => {
    const simulation = await seedEnvelopeBase(pool);
    await openEnvelope(pool, new PostgresExecutionOperationsRepository(pool), simulation);
    await listenerProbe(pool, new PostgresFastEntryRepository(pool), 'SKIPPED');
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS n FROM execution_intents
      WHERE strategy_id=$1`, [FAST_ENTRY_PROBE_STRATEGY_ID])).rows[0]?.n, 0);
  });
});

void test('H2b: a probe can never become live_reserved, so no live claim can take it', async (context) => {
  await withSchema(context, async (pool) => {
    const probeId = await probeRow(pool, PER_BUY, await currentDatabaseTimeMs(pool));
    for (const replica of [false, true]) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // A CHECK constraint holds even with every trigger disabled.
        if (replica) await client.query('SET LOCAL session_replication_role=replica');
        await assert.rejects(client.query(`UPDATE execution_intents SET live_reserved=TRUE WHERE id=$1`,
          [probeId]), (error: { code?: string; constraint?: string }) => (
          error.code === '23514' && error.constraint === PROBE_CHECK));
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
    const intents = new PostgresExecutionIntentRepository(pool);
    assert.equal(await intents.claim({
      ownerId: 'probe-live-test', leaseMs: 60_000, purpose: 'LIVE_EXECUTE', side: 'BUY', generationId,
    }), null);
    assert.equal(await intents.claim({
      ownerId: 'probe-live-test', leaseMs: 60_000, purpose: 'LIVE_RECOVER', side: 'BUY',
    }), null);
    await assertNotArmed(pool, probeId);
  });
});

void test('the simulation-only worker simulates a listener probe into the artifact prepare finds',
  async (context) => {
    await withSchema(context, async (pool) => {
      await new PostgresExecutionRiskRepository(pool).registerWalletGeneration({
        generationId, payloadVersion: 1, walletPublicKey: publicKey,
        cluster: 'mainnet-beta', genesisHash: publicKey, generation: 1,
      });
      const probeId = await listenerProbe(pool, new PostgresFastEntryRepository(pool));
      const intents = new PostgresExecutionIntentRepository(pool);
      const worker = createSimulationOnlyWorker({
        intents,
        artifacts: new PostgresExecutionSimulationRepository(pool),
        ownerId: 'probe-simulation-test',
        leaseMs: 30_000,
        evaluator: {
          evaluate: async ({ claim, attempt }, _signal, renew) => {
            await renew('BEFORE_CANONICAL_SNAPSHOT');
            await renew('BEFORE_SIMULATION');
            return successArtifact(claim.intent, attempt.attemptNumber);
          },
        },
      });
      const result = await worker.runOnce(new AbortController().signal);
      assert.ok(result !== 'IDLE');
      assert.equal(result.intentId, probeId);
      assert.equal(result.outcome, 'SIMULATION_SUCCEEDED');
      const facts = await new PostgresExecutionOperationsRepository(pool).prepareEnvelopeFacts(generationId, {
        buildHash: hash, configurationFingerprint: hash, walletPublicKey: publicKey,
        providerId: 'primary', genesisHash: publicKey,
      });
      const artifact = (await pool.query<{ readonly artifact_id: string; readonly strategy_id: string }>(
        `SELECT artifact_id,strategy_id FROM execution_simulation_artifacts WHERE intent_id=$1`,
        [probeId])).rows[0];
      assert.equal(artifact?.strategy_id, FAST_ENTRY_PROBE_STRATEGY_ID);
      assert.equal(facts?.simulation.artifactId, artifact?.artifact_id);
      // Short-lived: terminal with a purge deadline, never left open.
      const row = (await pool.query(`SELECT status,live_reserved,purge_after IS NOT NULL AS purgeable
        FROM execution_intents WHERE id=$1`, [probeId])).rows[0];
      assert.deepEqual({ ...row }, { status: 'SUCCEEDED', live_reserved: false, purgeable: true });
      assert.equal(await worker.runOnce(new AbortController().signal), 'IDLE');
      // Retention is not blocked: once due, the probe and its artifact are purged like any intent.
      await pool.query(`UPDATE execution_intents SET requested_at=requested_at-INTERVAL '5 hours',
        expires_at=expires_at-INTERVAL '5 hours',terminal_at=terminal_at-INTERVAL '5 hours',
        reconciliation_completed_at=reconciliation_completed_at-INTERVAL '5 hours',
        purge_after=purge_after-INTERVAL '5 hours',updated_at=updated_at-INTERVAL '5 hours',
        created_at=created_at-INTERVAL '5 hours'
        WHERE id=$1`, [probeId]);
      const purged = await purgeExpiredFoundationData(pool);
      assert.equal(purged.executionIntents, 1);
      assert.deepEqual({ ...(await pool.query(`SELECT
        (SELECT COUNT(*) FROM execution_intents WHERE id=$1)::INTEGER AS intents,
        (SELECT COUNT(*) FROM execution_simulation_artifacts WHERE intent_id=$1)::INTEGER AS artifacts`,
      [probeId])).rows[0] }, { intents: 0, artifacts: 0 });
    });
  });

void test('the listener role can record a probe under its grants', async (context) => {
  await withProvisionedDatabase(context, async (pool) => {
    const source = roleSource(pool, 'sol_token_listener_writer');
    const repository = new PostgresFastEntryRepository({
      connect: source.connect as never,
      query: async (text: string, values?: readonly unknown[]) => {
        const client = await source.connect();
        try { return await client.query(text, values); } finally { client.release(); }
      },
    });
    const probeId = await listenerProbe(pool, repository);
    assert.deepEqual((await pool.query(`SELECT strategy_id,live_reserved FROM execution_intents
      WHERE id=$1`, [probeId])).rows, [{ strategy_id: FAST_ENTRY_PROBE_STRATEGY_ID, live_reserved: false }]);
  });
});

/** A probe row with chosen amount and request time (the listener uses the probe amount). */
async function probeRow(pool: Pool, amount: bigint, requestedAtMs: number): Promise<string> {
  const decisionEventId = `probe-decision-${randomUUID()}`;
  await insertExecutionDecisionEvent(pool, decisionEventId, publicKey);
  const created = await new PostgresExecutionIntentRepository(pool).create(createExecutionIntentDraft({
    strategyId: FAST_ENTRY_PROBE_STRATEGY_ID, strategyVersion: 1,
    positionId: `fast_probe_position_${randomUUID()}`, logicalCommandId: `entry_probe_${randomUUID()}`,
    mint: publicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint: WSOL,
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9, quoteAmountRaw: amount, baseAmountRaw: null,
    minimumAmountOutRaw: 1n, decisionEventId, decisionFingerprint: hash,
    requestedAtMs, expiresAtMs: requestedAtMs + 120_000,
  }));
  return created.intent.id;
}

/** A probe written by the listener path: a create, then `recordProbe`. */
async function listenerProbe(
  pool: Pool,
  repository: PostgresFastEntryRepository,
  expected: 'RECORDED' | 'SKIPPED' = 'RECORDED',
): Promise<string> {
  const mint = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  const signature = `create-${mint}`;
  const decidedAtMs = await currentDatabaseTimeMs(pool);
  const at = new Date(decidedAtMs - 500);
  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,quote_assets,current_state,
    created_signature,created_slot,created_transaction_index,created_instruction_index,
    created_inner_instruction_index,detected_at,updated_at
  ) VALUES ($1,'pumpfun',$2,$3,'SPL_TOKEN',$4,'DETECTED',$5,100,2,3,NULL,$6,$6)`, [
    mint, PUMP_PROGRAM, creator,
    JSON.stringify([{ mint: WSOL, decimals: 9, tokenProgram: 'SPL_TOKEN' }]), signature, at,
  ]);
  await pool.query(`INSERT INTO domain_events (
    event_id,type,mint,source,program,signature,slot,transaction_index,instruction_index,
    inner_instruction_index,confirmation_status,blockchain_time,observed_at,payload_version,payload
  ) VALUES ($1,'TokenLaunchDetected',$2,'pumpfun',$3,$4,100,2,3,NULL,'confirmed',$5,$5,1,$6)`, [
    `launch-${mint}`, mint, PUMP_PROGRAM, signature, at, JSON.stringify({ launch: { mint, creator } }),
  ]);
  const launch = await repository.readLaunchForSignature(mint, signature);
  assert.ok(launch !== null);
  const result = await repository.recordProbe({
    launch, decidedAtMs, intervalMs: 600_000,
    buyQuote: Object.freeze({
      id: `quote-${randomUUID()}`, inputMint: WSOL, outputMint: mint,
      amountInRaw: FAST_ENTRY_PROBE_QUOTE_AMOUNT_RAW, amountOutRaw: 1_001n, minimumAmountOutRaw: 1_000n,
      feesRaw: 10n, slippageBps: 1_000n, priceImpactBps: 5n, observedAtMs: decidedAtMs, observedSlot: 100n,
    }),
  });
  assert.equal(result.kind, expected);
  return result.kind === 'RECORDED' ? result.intentId : '';
}

function successArtifact(
  intent: Readonly<{
    id: string; stateRevision: bigint; strategyId: string; strategyVersion: number;
    decisionFingerprint: string; quoteAmountRaw: bigint | null;
  }>,
  attemptNumber: number,
) {
  return createExecutionSimulationArtifactDraft({
    intentId: intent.id, attemptNumber, intentStateRevision: intent.stateRevision,
    strategyId: intent.strategyId, strategyVersion: intent.strategyVersion,
    decisionFingerprint: intent.decisionFingerprint,
    resultKind: 'SUCCESS', effectiveVenue: 'PUMP_FUN', providerId: 'primary',
    executorPublicKey: publicKey, expectedGenesisHash: publicKey,
    observedGenesisHash: publicKey, configurationFingerprint: hash,
    quoteFingerprint: hash, snapshotFingerprint: hash, buildFingerprint: hash,
    messageHash: hash, blockhash: publicKey, lastValidBlockHeight: 1_000n,
    blockhashContextSlot: 900n, snapshotSlot: 899n, feeContextSlot: 900n,
    simulationSlot: 901n, amountInRaw: intent.quoteAmountRaw ?? 0n, expectedAmountOutRaw: 1_001n,
    protectedAmountOutRaw: 1_000n, feesRaw: 10n, estimatedFeeLamports: 5_000n,
    simulatedFeePayerLamportDebit: 6_000n, unitsConsumed: 200_000n,
    simulatedBaseDeltaRaw: 1_000n, simulatedQuoteDeltaRaw: -(intent.quoteAmountRaw ?? 0n),
    rpcCallsUsed: 5, rpcCallsLimit: 8, quoteStatus: 'SUCCEEDED',
    buildStatus: 'SUCCEEDED', simulationStatus: 'SUCCEEDED', failureStage: null,
    failureCode: null, terminalReasonCode: 'INTENT_SUCCEEDED',
    logsFingerprint: hash, logsLineCount: 1,
  });
}

async function assertNotArmed(pool: Pool, intentId: string): Promise<void> {
  assert.deepEqual((await pool.query(`SELECT live_reserved,
    (SELECT COUNT(*)::INTEGER FROM execution_activation_armaments WHERE target_intent_id=$1) AS armaments,
    (SELECT COUNT(*)::INTEGER FROM execution_exposure_reservations WHERE intent_id=$1) AS reservations
    FROM execution_intents WHERE id=$1`, [intentId])).rows,
  [{ live_reserved: false, armaments: 0, reservations: 0 }]);
}

function isRepositoryError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ExecutionOperationsRepositoryError && error.code === code;
}
