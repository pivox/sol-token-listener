// A BUY accepted by the provider but never included (no priority fee): once the finalized block
// height passes its last valid block height it can never land. The confirmation lane must move
// it out of SUBMITTED so the reconciliation lane can prove NO_EFFECT and release everything.
import assert from 'node:assert/strict';
import test from 'node:test';
import type pg from 'pg';
import { createLiveRecoveryBootstrapDatabase } from '../src/executor-live-recovery/database.js';
import { createLiveRecoveryLanes } from '../src/executor-live-recovery/lanes.js';
import type { LiveRecoveryConfig } from '../src/executor-live-recovery/config.js';
import type { LiveRecoveryLogContext } from '../src/executor-live-recovery/logger.js';
import {
  createExecutionLiveRecoveryIntentRepository,
  createExecutionLiveRecoveryRepository,
  type ExecutionLiveRecoveryIntentRepository,
  type ExecutionLiveRecoveryRepository,
} from '../src/ports/execution-live-recovery-repository.js';
import { withProvisionedDatabase } from './helpers/entry-envelope-fixture.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
import {
  ExecutionLiveRepositoryError,
  PostgresExecutionLiveRepository,
} from '../src/storage/execution-live.repository.js';
import {
  blockhashValidity, createBuyFixture, generationId, requiredDatabaseUrl, rpcBudget,
  signedSimulation, withTemporarySchema,
} from './helpers/live-sell-fixture.js';

type Pool = InstanceType<typeof pg.Pool>;

void test('an accepted BUY whose blockhash expired unobserved is expired, reconciled NO_EFFECT and fully released',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const buy = await acceptedBuyFixture(pool);
      const intents = new PostgresExecutionIntentRepository(pool);
      const { lanes, calls, logs } = expiryLanes(buy, {
        intents: createExecutionLiveRecoveryIntentRepository(intents),
        live: createExecutionLiveRecoveryRepository(buy.live),
      });
      assert.deepEqual(await riskSummary(pool, buy), {
        artifact_state: 'ACCEPTED', artifact_revision: '3', intent_status: 'SUBMITTED',
        last_reason_code: 'SUBMISSION_ACCEPTED', attempt_status: 'STARTED',
        reservation_state: 'RESERVED', open_positions: 1, reserved_exposure_raw: '1000',
        armament_state: 'LOCKED', positions: 0,
      });

      // Pass 1: the confirmation lane expires the unobserved transaction.
      assert.equal(await lanes.confirmation(signal()), 'WORKED');
      assert.deepEqual(calls, ['confirmation:ours', 'height']);
      assert.deepEqual(logs, [{
        level: 'info', event: 'executor_live_recovery.confirmation_expired',
        executionMode: 'live-recovery', lane: 'CONFIRMATION',
      }]);
      assert.deepEqual(await riskSummary(pool, buy), {
        artifact_state: 'AMBIGUOUS', artifact_revision: '4',
        intent_status: 'UNKNOWN_REQUIRES_RECONCILIATION',
        last_reason_code: 'RECONCILIATION_REQUIRED', attempt_status: 'STARTED',
        reservation_state: 'RESERVED', open_positions: 1, reserved_exposure_raw: '1000',
        armament_state: 'LOCKED', positions: 0,
      });
      const journal = await pool.query(`SELECT
        (SELECT json_agg(json_build_object('previous',previous_state,'next',next_state,
          'reason',reason_code) ORDER BY occurred_at,event_id)
          FROM execution_submission_events WHERE artifact_id=$1
            AND previous_state='ACCEPTED') AS artifact_events,
        (SELECT json_agg(json_build_object('previous',previous_status,'next',next_status,
          'reason',reason_code) ORDER BY occurred_at,sequence)
          FROM execution_intent_transitions WHERE intent_id=$2
            AND previous_status='SUBMITTED') AS intent_transitions,
        (SELECT lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
          FROM execution_intents WHERE id=$2) AS lease_released`, [
        buy.artifact.artifactId, buy.claim.intent.id,
      ]);
      assert.deepEqual(journal.rows, [{
        artifact_events: [{ previous: 'ACCEPTED', next: 'AMBIGUOUS', reason: 'RECONCILIATION_REQUIRED' }],
        intent_transitions: [{
          previous: 'SUBMITTED', next: 'UNKNOWN_REQUIRES_RECONCILIATION',
          reason: 'RECONCILIATION_REQUIRED',
        }],
        lease_released: true,
      }]);
      // Nothing is left for the confirmation lane: no more one-second DEFERRED loop.
      assert.equal(await lanes.confirmation(signal()), 'IDLE');

      // Pass 2: the reconciliation lane proves no effect and releases the BUY.
      calls.length = 0;
      assert.equal(await lanes.reconciliation(signal()), 'WORKED');
      assert.deepEqual([...calls].sort(), ['deltas', 'height', 'history', 'transaction']);
      assert.deepEqual(await riskSummary(pool, buy), {
        artifact_state: 'RECONCILED', artifact_revision: '5', intent_status: 'FAILED',
        last_reason_code: 'RECONCILIATION_PROVED_NO_EFFECT', attempt_status: 'ABANDONED',
        reservation_state: 'RELEASED', open_positions: 0, reserved_exposure_raw: '0',
        armament_state: 'REVOKED', positions: 0,
      });
      const proof = await pool.query(`SELECT
        (SELECT json_agg(json_build_object('result',result,'reason',reason_code,
          'height',finalized_block_height::TEXT))
          FROM execution_reconciliation_evidence WHERE intent_id=$1) AS evidence,
        (SELECT json_agg(json_build_object('previous',previous_state,'next',next_state,
          'reason',reason_code) ORDER BY occurred_at,event_id)
          FROM execution_activation_events WHERE armament_id=$2
            AND previous_state='LOCKED') AS armament_events,
        (SELECT terminal_at IS NOT NULL AND purge_after IS NOT NULL
          FROM execution_activation_armaments WHERE armament_id=$2) AS armament_terminal,
        (SELECT COUNT(*)::INTEGER FROM execution_activation_armaments
          WHERE generation_id=$3 AND state IN ('ARMED','LOCKED')) AS active_armaments`, [
        buy.claim.intent.id, buy.artifact.armamentId, generationId,
      ]);
      assert.deepEqual(proof.rows, [{
        evidence: [{
          result: 'NO_EFFECT', reason: 'RECONCILIATION_PROVED_NO_EFFECT',
          height: (buy.artifact.lastValidBlockHeight + 1n).toString(),
        }],
        armament_events: [{ previous: 'LOCKED', next: 'REVOKED', reason: 'ARMAMENT_REVOKED' }],
        armament_terminal: true,
        active_armaments: 0,
      }]);
      assert.equal(await lanes.reconciliation(signal()), 'IDLE');
      assert.equal(await lanes.confirmation(signal()), 'IDLE');
    });
  });

void test('confirmation expiry rejects a stale revision, a non-expired height and a lost lease without side effects',
  async (context) => {
    const databaseUrl = requiredDatabaseUrl(context);
    if (databaseUrl === null) return;
    await withTemporarySchema(databaseUrl, async (pool) => {
      const buy = await acceptedBuyFixture(pool);
      const intents = new PostgresExecutionIntentRepository(pool);
      const claim = await intents.claim({
        ownerId: 'expiry-conflicts', leaseMs: 60_000, purpose: 'CONFIRM',
      });
      assert.ok(claim);
      const work = await buy.live.readConfirmationWork(claim);
      assert.deepEqual(work, {
        payloadVersion: 1, artifactId: buy.artifact.artifactId, expectedRevision: 3n,
        signature: buy.artifact.signature, providerId: 'primary',
        lastValidBlockHeight: buy.artifact.lastValidBlockHeight,
      });
      const expiry = Object.freeze({
        payloadVersion: 1 as const, artifactId: work.artifactId,
        expectedRevision: work.expectedRevision, signature: work.signature,
        finalizedBlockHeight: work.lastValidBlockHeight + 1n, observedAtMs: Date.now() + 2_000,
      });
      const before = await journalCounts(pool, buy);

      await assert.rejects(
        buy.live.recordConfirmationExpiry(claim, { ...expiry, expectedRevision: 4n }),
        (error: unknown) => error instanceof ExecutionLiveRepositoryError
          && error.code === 'LEASE_LOST',
      );
      await assert.rejects(
        buy.live.recordConfirmationExpiry(claim, {
          ...expiry, finalizedBlockHeight: work.lastValidBlockHeight,
        }),
        (error: unknown) => error instanceof ExecutionLiveRepositoryError
          && error.code === 'CONFLICT',
      );
      await assert.rejects(
        buy.live.recordConfirmationExpiry(Object.freeze({
          ...claim, leaseToken: '22222222-2222-4222-8222-222222222222',
        }), expiry),
        (error: unknown) => error instanceof ExecutionLiveRepositoryError
          && error.code === 'LEASE_LOST',
      );
      assert.deepEqual(await journalCounts(pool, buy), before);
      assert.deepEqual(await riskSummary(pool, buy), {
        artifact_state: 'ACCEPTED', artifact_revision: '3', intent_status: 'SUBMITTED',
        last_reason_code: 'SUBMISSION_ACCEPTED', attempt_status: 'STARTED',
        reservation_state: 'RESERVED', open_positions: 1, reserved_exposure_raw: '1000',
        armament_state: 'LOCKED', positions: 0,
      });

      const artifact = await buy.live.recordConfirmationExpiry(claim, expiry);
      assert.equal(artifact.artifactId, buy.artifact.artifactId);
      // The lease is released with the transition: a second call sees neither ACCEPTED nor the lease.
      await assert.rejects(
        buy.live.recordConfirmationExpiry(claim, expiry),
        (error: unknown) => error instanceof ExecutionLiveRepositoryError
          && error.code === 'LEASE_LOST',
      );
      assert.equal(await intents.claim({
        ownerId: 'expiry-conflicts-confirm', leaseMs: 60_000, purpose: 'CONFIRM',
      }), null);
      const reconciliation = await intents.claim({
        ownerId: 'expiry-conflicts-reconcile', leaseMs: 60_000, purpose: 'RECONCILE',
      });
      assert.equal(reconciliation?.intent.status, 'UNKNOWN_REQUIRES_RECONCILIATION');
    });
  });

void test('PostgreSQL 16 recovery role drives the expiry and the NO_EFFECT release end to end',
  async (context) => {
    await withProvisionedDatabase(context, async (pool) => {
      const buy = await acceptedBuyFixture(pool);
      // Exactly how H2a connects: SET ROLE sol_token_executor_live_recovery on every checkout.
      const recovery = createLiveRecoveryBootstrapDatabase(pool, () => Promise.resolve());
      const { lanes, logs } = expiryLanes(buy, recovery);
      try {
        assert.equal(await lanes.confirmation(signal()), 'WORKED');
        assert.equal(await lanes.reconciliation(signal()), 'WORKED');
      } finally {
        await recovery.close();
      }
      assert.deepEqual(logs.map((entry) => entry.event), [
        'executor_live_recovery.confirmation_expired',
      ]);
      assert.deepEqual(await riskSummary(pool, buy), {
        artifact_state: 'RECONCILED', artifact_revision: '5', intent_status: 'FAILED',
        last_reason_code: 'RECONCILIATION_PROVED_NO_EFFECT', attempt_status: 'ABANDONED',
        reservation_state: 'RELEASED', open_positions: 0, reserved_exposure_raw: '0',
        armament_state: 'REVOKED', positions: 0,
      });
    });
  });

/** The recovery lanes over the given repositories, with a gateway proving the BUY never landed. */
function expiryLanes(
  buy: Awaited<ReturnType<typeof acceptedBuyFixture>>,
  repositories: Readonly<{
    intents: ExecutionLiveRecoveryIntentRepository;
    live: ExecutionLiveRecoveryRepository;
  }>,
) {
  const calls: string[] = [];
  const logs: (LiveRecoveryLogContext & { level: string })[] = [];
  const observedAtMs = Date.now() + 2_000;
  const lanes = createLiveRecoveryLanes({
    config: recoveryConfig(),
    intents: repositories.intents,
    live: repositories.live,
    gateway: {
      providerId: 'primary',
      observeSignature: (signature) => {
        calls.push(`confirmation:${signature === buy.artifact.signature ? 'ours' : 'other'}`);
        return Promise.resolve(Object.freeze({
          confirmationStatus: 'NOT_FOUND' as const, observedSlot: null, observedAtMs,
        }));
      },
      readFinalizedBlockHeight: () => {
        calls.push('height');
        return Promise.resolve(buy.artifact.lastValidBlockHeight + 1n);
      },
      readSignatureHistory: () => { calls.push('history'); return Promise.resolve('ABSENT' as const); },
      readNormalizedTransaction: () => { calls.push('transaction'); return Promise.resolve(null); },
      readFinalizedWalletDeltas: () => {
        calls.push('deltas');
        return Promise.resolve(Object.freeze({
          confirmationStatus: 'NOT_FOUND' as const, observedSlot: null,
          feeLamports: 0n, walletLamportDelta: 0n, baseDeltaRaw: 0n, quoteDeltaRaw: 0n,
          unexpectedResidualTokenBalanceRaw: 0n,
          observedAtMs: observedAtMs + 1_000, finalizedAtMs: observedAtMs + 1_000,
        }));
      },
    },
    logger: Object.freeze({
      info: (entry: LiveRecoveryLogContext) => { logs.push({ level: 'info', ...entry }); },
      warn: (entry: LiveRecoveryLogContext) => { logs.push({ level: 'warn', ...entry }); },
      error: (entry: LiveRecoveryLogContext) => { logs.push({ level: 'error', ...entry }); },
    }),
    reportedCappedExits: new Set<string>(),
  });
  return { lanes, calls, logs };
}

/** H2b's real steps up to an ACCEPTED BUY (intent SUBMITTED), then H2b's lease is dropped. */
async function acceptedBuyFixture(pool: Pool) {
  await migrateDatabase({ pool });
  const buy = await createBuyFixture(pool);
  const live = new PostgresExecutionLiveRepository(pool);
  await live.persistSigned({
    payloadVersion: 1, claim: buy.claim, qualificationId: buy.qualificationId,
    preSignatureLockId: buy.preSignatureLockId,
    reservationId: buy.reservationId, artifact: buy.artifact,
    unsignedSimulation: buy.unsignedSimulation,
    rpcBudget,
  });
  const simulated = await live.recordSignedSimulation(buy.claim, signedSimulation(
    buy.artifact, buy.unsignedSimulation, 95n, -1_000n, buy.artifact.signedAtMs + 1,
  ));
  const started = await live.beginSubmission({
    claim: buy.claim, artifactId: buy.artifact.artifactId,
    expectedRevision: simulated.stateRevision, runtime: buy.runtime,
    blockhashValidity: blockhashValidity(buy.artifact, Date.now()),
  });
  await live.recordSubmissionOutcome(buy.claim, {
    payloadVersion: 1, artifactId: buy.artifact.artifactId,
    expectedRevision: started.stateRevision, outcome: 'ACCEPTED',
    returnedSignature: buy.artifact.signature, reasonCode: 'SUBMISSION_ACCEPTED',
    observedAtMs: Date.now(),
  });
  const released = await pool.query(`UPDATE execution_intents SET
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=$1`, [buy.claim.intent.id]);
  assert.equal(released.rowCount, 1);
  return Object.freeze({ ...buy, live });
}

async function riskSummary(
  pool: Pool,
  buy: Awaited<ReturnType<typeof acceptedBuyFixture>>,
): Promise<Record<string, unknown> | undefined> {
  const result = await pool.query<Record<string, unknown>>(`SELECT
    (SELECT state FROM execution_signed_transactions WHERE artifact_id=$1) AS artifact_state,
    (SELECT state_revision::TEXT FROM execution_signed_transactions WHERE artifact_id=$1)
      AS artifact_revision,
    (SELECT status FROM execution_intents WHERE id=$2) AS intent_status,
    (SELECT last_reason_code FROM execution_intents WHERE id=$2) AS last_reason_code,
    (SELECT status FROM execution_attempts WHERE intent_id=$2 AND attempt_number=1)
      AS attempt_status,
    (SELECT state FROM execution_exposure_reservations WHERE intent_id=$2) AS reservation_state,
    (SELECT open_positions FROM execution_wallet_risk_state WHERE generation_id=$3)
      AS open_positions,
    (SELECT reserved_exposure_raw::TEXT FROM execution_wallet_risk_state WHERE generation_id=$3)
      AS reserved_exposure_raw,
    (SELECT state FROM execution_activation_armaments WHERE armament_id=$4) AS armament_state,
    (SELECT COUNT(*)::INTEGER FROM execution_live_positions) AS positions`, [
    buy.artifact.artifactId, buy.claim.intent.id, generationId, buy.artifact.armamentId,
  ]);
  return result.rows[0];
}

async function journalCounts(
  pool: Pool,
  buy: Awaited<ReturnType<typeof acceptedBuyFixture>>,
): Promise<Record<string, unknown> | undefined> {
  const result = await pool.query<Record<string, unknown>>(`SELECT
    (SELECT COUNT(*)::INTEGER FROM execution_submission_events WHERE artifact_id=$1)
      AS submission_events,
    (SELECT COUNT(*)::INTEGER FROM execution_intent_transitions WHERE intent_id=$2)
      AS intent_transitions,
    (SELECT COUNT(*)::INTEGER FROM execution_activation_events) AS activation_events,
    (SELECT state_revision::TEXT FROM execution_intents WHERE id=$2) AS intent_revision`, [
    buy.artifact.artifactId, buy.claim.intent.id,
  ]);
  return result.rows[0];
}

function recoveryConfig(): LiveRecoveryConfig {
  return Object.freeze({
    mode: 'live', recoveryEnabled: true, cluster: 'mainnet-beta',
    databaseUrl: 'postgresql://ignored', pollMs: 100, leaseMs: 60_000,
    databaseStatementTimeoutMs: 3_000, shutdownGraceMs: 10_000,
    generationId, executorPublicKey: '11111111111111111111111111111111', providerId: 'primary',
    httpRpcUrl: 'https://rpc.example.test',
    expectedGenesisHash: '11111111111111111111111111111111',
    rpcTimeoutMs: 5_000, maxRpcCallsPerPass: 8, ownerId: 'expiry-recovery',
    exitTakeProfitBps: 30_000n, exitExternalBuyersTarget: 7, exitExternalMinimumBuyRaw: 5_000n,
  });
}

function signal(): AbortSignal { return new AbortController().signal; }
