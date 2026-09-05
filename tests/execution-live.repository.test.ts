import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import bs58 from 'bs58';
import pg from 'pg';
import {
  Keypair, SystemProgram, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
  createOperatorAuthorization,
  createExecutionArmamentRequestV2,
  createOperatorAuthorizationV2,
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
import { createExecutionWalletSnapshot } from '../src/domain/execution-wallet-snapshot.js';
import { evaluateExecutionReconciliation } from '../src/domain/execution-reconciliation.js';
import { createSignedTransactionArtifact } from '../src/domain/execution-live.js';
import {
  createExecutionLiveSignedSimulationEvidence,
  createExecutionLiveUnsignedSimulationEvidenceIdentity,
} from
  '../src/domain/execution-live-signed-simulation.js';
import type { ExecutionSimulationEvidenceV1 } from
  '../src/ports/execution-simulation-gateway.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresExecutionIntentRepository } from '../src/storage/execution-intent.repository.js';
import {
  ExecutionLiveRepositoryError,
  PostgresExecutionLiveRepository,
} from '../src/storage/execution-live.repository.js';
import { PostgresExecutionOperationsRepository } from '../src/storage/execution-operations.repository.js';
import { PostgresExecutionRiskRepository } from '../src/storage/execution-risk.repository.js';
import { PostgresExecutionSimulationRepository } from '../src/storage/execution-simulation.repository.js';
import { createLiveRecoveryBootstrapDatabase } from
  '../src/executor-live-recovery/database.js';
import { acquireExecutorRoleTestLock } from './postgres-role-test-lock.js';

const generationId = `execution_wallet_generation_${'a'.repeat(64)}`;
const walletPublicKey = '11111111111111111111111111111111';
const quoteMint = 'So11111111111111111111111111111111111111112';
const fingerprint = '1'.repeat(64);
const exactBuyWallet = Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 17));
const exactBuyWalletPublicKey = exactBuyWallet.publicKey.toBase58();
const roleProvisioningUrl = new URL('../scripts/provision-executor-roles.sql', import.meta.url);

function submissionPreflight(artifact: ReturnType<typeof createSignedTransactionArtifact>) {
  return Object.freeze({
    runtime: Object.freeze({
      payloadVersion: 1 as const, phase: 'CANARY' as const,
      buildHash: artifact.buildFingerprint, configurationFingerprint: fingerprint,
      strategyFingerprint: '3'.repeat(64), walletPublicKey: artifact.walletPublicKey,
      cluster: 'mainnet-beta' as const, expectedGenesisHash: artifact.walletPublicKey,
      observedGenesisHash: artifact.walletPublicKey, providerId: artifact.providerId,
      quoteMaxAgeMs: 60_000, slippageBps: 100n, snapshotMaxSlotLag: 8,
      maxComputeUnits: 200_000n, maxFeeLamports: 5_000n,
      maxFeePayerLamportDebit: 100_000n, maxRpcCallsPerAttempt: 12, leaseMs: 3_000,
    }),
    blockhashValidity: Object.freeze({
      payloadVersion: 1 as const, providerId: artifact.providerId,
      blockhash: artifact.blockhash, valid: true as const,
      observedBlockHeight: artifact.lastValidBlockHeight - 1n,
      contextSlot: 127n, observedAtMs: Date.now() - 1_000,
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

void test('deadline scanner uses one PostgreSQL clock, exact deadline and oldest-first order',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: deadline scanner clock test skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await openPositionFixture(pool);
      assert.equal(await fixture.live.createNextDeadlineExitIntent(), null);
      const dueAtMs = await makePositionDue(pool, fixture.position.positionId);

      const queries: string[] = [];
      const scanner = deadlineClockRepository(
        pool, dueAtMs, Object.freeze({ queries }),
      );
      const result = await scanner.createNextDeadlineExitIntent();
      assert.equal(result?.kind, 'CREATED');
      assert.equal(result?.intent?.side, 'SELL');
      assert.equal(result?.intent?.logicalCommandId,
        `maximum-holding:${fixture.position.positionId}`);
      assert.equal(result?.intent?.baseAmountRaw, fixture.position.baseAmountRaw);
      assert.equal(result?.intent?.requestedAtMs, dueAtMs);
      assert.equal((result?.intent?.expiresAtMs ?? 0) - (result?.intent?.requestedAtMs ?? 0),
        120_000);

      const normalized = queries.map((query) => query.replaceAll(/\s+/gu, ' ').trim());
      const globalLock = normalized.findIndex((query) =>
        query.includes("hashtextextended('execution-live-deadline-scan:v1', 51007)"));
      const sellPresenceLock = normalized.findIndex((query) =>
        query.includes("hashtextextended('execution-live-sell-presence:v1', 51008)"));
      const clock = normalized.findIndex((query) =>
        query.includes('execution_live_deadline_clock'));
      const candidate = normalized.findIndex((query) =>
        query.includes("position.state='OPEN'") && query.includes('exit_deadline_at <='));
      const generationLock = normalized.findIndex((query) =>
        query.includes('hashtextextended($1, 51005)'));
      const rowLock = normalized.findIndex((query) => query.includes('FOR UPDATE OF position'));
      assert.ok(globalLock >= 0 && globalLock < sellPresenceLock);
      assert.ok(sellPresenceLock < clock);
      assert.ok(clock < candidate && candidate < generationLock && generationLock < rowLock);
      assert.match(normalized[candidate] ?? '',
        /ORDER BY position\.exit_deadline_at ASC,position\.position_id ASC LIMIT 1/u);
    });
  });

void test('two concurrent deadline scanners create one deterministic SELL intent',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: concurrent deadline scanner test skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await openPositionFixture(pool);
      const dueAtMs = await makePositionDue(pool, fixture.position.positionId);
      const scanner = deadlineClockRepository(pool, dueAtMs);
      const results = await Promise.all([
        scanner.createNextDeadlineExitIntent(),
        scanner.createNextDeadlineExitIntent(),
      ]);
      assert.equal(results.filter((result) => result?.kind === 'CREATED').length, 1);
      assert.equal(results.filter((result) => result === null).length, 1);
      const durable = await pool.query(`SELECT
        (SELECT COUNT(*)::INTEGER FROM execution_intents
          WHERE logical_command_id=$1 AND side='SELL') AS intents,
        (SELECT state FROM execution_live_positions WHERE position_id=$2) AS position_state`, [
        `maximum-holding:${fixture.position.positionId}`, fixture.position.positionId,
      ]);
      assert.deepEqual(durable.rows, [{ intents: 1, position_state: 'EXIT_PENDING' }]);
    });
  });

void test('deadline scanner commit-unknown retries safely through durable targeted replay',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: deadline scanner commit-unknown test skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await openPositionFixture(pool);
      const before = await pool.query<{ readonly state_revision: string }>(`SELECT
        state_revision::TEXT AS state_revision FROM execution_live_positions WHERE position_id=$1`, [
        fixture.position.positionId,
      ]);
      const initialRevision = BigInt(before.rows[0]?.state_revision ?? '-1');
      const dueAtMs = await makePositionDue(pool, fixture.position.positionId);
      const uncertain = deadlineClockRepository(pool, dueAtMs,
        Object.freeze({ failFirstCommitAfterSuccess: true }));
      await assert.rejects(
        uncertain.createNextDeadlineExitIntent(),
        isLiveRepositoryError('COMMIT_OUTCOME_UNKNOWN'),
      );
      assert.equal(
        await deadlineClockRepository(pool, dueAtMs)
          .createNextDeadlineExitIntent(),
        null,
      );
      const committed = await pool.query<{
        readonly state: string;
        readonly state_revision: string;
        readonly exit_intent_id: string | null;
      }>(`SELECT state,state_revision::TEXT AS state_revision,exit_intent_id
        FROM execution_live_positions WHERE position_id=$1`, [fixture.position.positionId]);
      assert.equal(committed.rows[0]?.state, 'EXIT_PENDING');
      assert.equal(BigInt(committed.rows[0]?.state_revision ?? '-1'), initialRevision + 1n);
      assert.match(committed.rows[0]?.exit_intent_id ?? '', /^execution_intent_[0-9a-f]{64}$/u);
      const replay = await fixture.live.createDeadlineExitIntent({
        positionId: fixture.position.positionId,
        observedAtMs: dueAtMs,
      });
      assert.equal(replay.kind, 'REPLAYED');
      assert.equal(replay.intent?.id, committed.rows[0]?.exit_intent_id);
      const count = await pool.query<{ readonly count: number }>(`SELECT COUNT(*)::INTEGER AS count
        FROM execution_intents WHERE logical_command_id=$1`, [
        `maximum-holding:${fixture.position.positionId}`,
      ]);
      assert.deepEqual(count.rows, [{ count: 1 }]);
    });
  });

void test('targeted deadline creation wins safely while a scanner waits on its global lock',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: scanner versus targeted deadline test skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await openPositionFixture(pool);
      const dueAtMs = await makePositionDue(pool, fixture.position.positionId);
      const blocker = await pool.connect();
      let scanner: Promise<unknown> | null = null;
      try {
        await blocker.query('BEGIN');
        await blocker.query(`SELECT pg_advisory_xact_lock(
          hashtextextended('execution-live-deadline-scan:v1', 51007))`);
        scanner = deadlineClockRepository(pool, dueAtMs)
          .createNextDeadlineExitIntent();
        const targeted = await fixture.live.createDeadlineExitIntent({
          positionId: fixture.position.positionId,
          observedAtMs: dueAtMs,
        });
        assert.equal(targeted.kind, 'CREATED');
        await blocker.query('COMMIT');
        assert.equal(await scanner, null);
      } finally {
        try { await blocker.query('ROLLBACK'); } catch { /* transaction already closed */ }
        blocker.release();
        if (scanner !== null) await scanner.catch(() => undefined);
      }
    });
  });

void test('targeted deadline creation rejects a caller timestamp ahead of fresh PostgreSQL time',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: future deadline timestamp test skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await openPositionFixture(pool);
      const nowMs = await databaseNowMs(pool);
      const futureObservedAtMs = Math.max(nowMs, fixture.position.exitDeadlineAtMs) + 60_000;
      await assert.rejects(
        fixture.live.createDeadlineExitIntent({
          positionId: fixture.position.positionId,
          observedAtMs: futureObservedAtMs,
        }),
        isLiveRepositoryError('INVALID_INPUT'),
      );
      const durable = await pool.query(`SELECT state,state_revision::TEXT AS state_revision,
        exit_intent_id FROM execution_live_positions WHERE position_id=$1`, [
        fixture.position.positionId,
      ]);
      assert.deepEqual(durable.rows, [{
        state: 'OPEN', state_revision: '0', exit_intent_id: null,
      }]);
    });
  });

void test('targeted deadline replay never widens its caller-provided observation bound',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: stable deadline replay bound test skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await openPositionFixture(pool);
      const dueAtMs = await makePositionDue(pool, fixture.position.positionId);
      const created = await fixture.live.createDeadlineExitIntent({
        positionId: fixture.position.positionId,
        observedAtMs: dueAtMs + 2_000,
      });
      assert.equal(created.kind, 'CREATED');
      await assert.rejects(
        fixture.live.createDeadlineExitIntent({
          positionId: fixture.position.positionId,
          observedAtMs: dueAtMs + 1_000,
        }),
        isLiveRepositoryError('INVALID_DATA'),
      );
      const exactReplay = await fixture.live.createDeadlineExitIntent({
        positionId: fixture.position.positionId,
        observedAtMs: dueAtMs + 2_000,
      });
      assert.equal(exactReplay.kind, 'REPLAYED');
      assert.equal(exactReplay.intent?.id, created.intent?.id);
    });
  });

void test('scanner queued before targeted creation yields one CREATED and one stable REPLAYED',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: scanner targeted generation race skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await openPositionFixture(pool);
      const dueAtMs = await makePositionDue(pool, fixture.position.positionId);
      const selected = deferred<true>();
      const blocker = await pool.connect();
      const observer = await pool.connect();
      let released = false;
      try {
        await blocker.query('BEGIN');
        const blockerPid = (await blocker.query<{ readonly pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )).rows[0]?.pid;
        assert.ok(Number.isInteger(blockerPid));
        await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 51005))', [
          generationId,
        ]);
        const scanner = deadlineClockRepository(pool, dueAtMs, Object.freeze({
          onCandidateSelected: () => { selected.resolve(true); },
        })).createNextDeadlineExitIntent();
        await selected.promise;
        const targeted = fixture.live.createDeadlineExitIntent({
          positionId: fixture.position.positionId,
          observedAtMs: dueAtMs,
        });
        let queuedWorkers = 0;
        for (let attempt = 0; attempt < 100 && queuedWorkers < 1; attempt += 1) {
          const observed = await observer.query<{ readonly queued_workers: number }>(`SELECT
            COUNT(*)::INTEGER AS queued_workers FROM pg_stat_activity activity
            WHERE $1::INTEGER = ANY(pg_blocking_pids(activity.pid))`, [blockerPid]);
          queuedWorkers = observed.rows[0]?.queued_workers ?? 0;
          if (queuedWorkers < 1) await observer.query('SELECT pg_sleep(0.01)');
        }
        assert.equal(queuedWorkers, 1);
        const targetedState = await Promise.race([
          targeted.then(() => 'SETTLED' as const),
          observer.query('SELECT pg_sleep(0.05)').then(() => 'WAITING' as const),
        ]);
        assert.equal(targetedState, 'WAITING');
        await blocker.query('COMMIT');
        released = true;
        const results = await Promise.all([scanner, targeted]);
        assert.deepEqual(results.map((result) => result?.kind).sort(), ['CREATED', 'REPLAYED']);
        assert.equal(results[0]?.intent?.id, results[1]?.intent?.id);
      } finally {
        if (!released) await blocker.query('ROLLBACK');
        blocker.release();
        observer.release();
      }
    });
  });

void test('deadline scanner selects the oldest of two due PostgreSQL candidates',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: two-candidate deadline ordering test skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await openPositionFixture(pool);
      const nowMs = await databaseNowMs(pool);
      const oldestDeadlineMs = nowMs - 60_000;
      const newerDeadlineMs = nowMs - 30_000;
      await setPositionDeadline(pool, fixture.position.positionId, oldestDeadlineMs);
      const newerPositionId = `execution_live_position_${'b'.repeat(64)}`;
      const newerGenerationId = `execution_wallet_generation_${'b'.repeat(64)}`;
      await pool.query(`UPDATE execution_wallet_generations SET
        retired_at=date_trunc('milliseconds',statement_timestamp()) WHERE generation_id=$1`, [
        generationId,
      ]);
      await pool.query(`INSERT INTO execution_wallet_generations (
        generation_id,payload_version,wallet_public_key,cluster,genesis_hash,generation
      ) VALUES ($1,1,$2,'mainnet-beta',$2,1)`, [newerGenerationId, quoteMint]);
      const newerBuy = createExecutionIntentDraft({
        strategyId: 'deadline-ordering-fixture',
        strategyVersion: 1,
        positionId: 'deadline-ordering-fixture-position',
        logicalCommandId: 'deadline-ordering-fixture-buy',
        mint: walletPublicKey,
        side: 'BUY',
        venuePolicy: 'PUMP_FUN_ONLY',
        quoteMint,
        quoteTokenProgram: 'SPL_TOKEN',
        quoteDecimals: 9,
        quoteAmountRaw: 1n,
        baseAmountRaw: null,
        minimumAmountOutRaw: 1n,
        decisionEventId: 'deadline-ordering-fixture-event',
        decisionFingerprint: 'd'.repeat(64),
        requestedAtMs: nowMs - 120_000,
        expiresAtMs: nowMs + 120_000,
      });
      await new PostgresExecutionIntentRepository(pool).create(newerBuy);
      await pool.query(`INSERT INTO execution_live_positions (
        position_id,payload_version,buy_intent_id,generation_id,armament_id,wallet_public_key,
        mint,quote_mint,entry_venue,quote_cost_raw,base_amount_raw,remaining_base_raw,
        fee_lamports,maximum_holding_ms,opened_at,exit_deadline_at,
        entry_reconciliation_fingerprint,state,state_revision
      ) SELECT $2,1,$6,$3,armament_id,$4,mint,quote_mint,entry_venue,
        quote_cost_raw,base_amount_raw,remaining_base_raw,fee_lamports,maximum_holding_ms,
        TIMESTAMPTZ 'epoch'+(($5::BIGINT-maximum_holding_ms)*INTERVAL '1 millisecond'),
        TIMESTAMPTZ 'epoch'+($5::BIGINT*INTERVAL '1 millisecond'),
        entry_reconciliation_fingerprint,'OPEN',0
        FROM execution_live_positions WHERE position_id=$1`, [
        fixture.position.positionId, newerPositionId, newerGenerationId, quoteMint, newerDeadlineMs,
        newerBuy.id,
      ]);

      const result = await fixture.live.createNextDeadlineExitIntent();
      assert.equal(result?.kind, 'CREATED');
      assert.equal(result?.intent?.positionId, fixture.position.positionId);
      const states = await pool.query(`SELECT position_id,state FROM execution_live_positions
        WHERE position_id=ANY($1::TEXT[])`, [[
        fixture.position.positionId, newerPositionId,
      ]]);
      assert.deepEqual(Object.fromEntries(states.rows.map((row) => [row.position_id, row.state])), {
        [fixture.position.positionId]: 'EXIT_PENDING',
        [newerPositionId]: 'OPEN',
      });
    });
  });

void test('worker read-models expose fenced provider-affine inputs without signed bytes',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: live worker read-model integration skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const aboveSafeInteger = 9_007_199_254_740_993n;
      const fixture = await acceptedBuyFixture(pool, aboveSafeInteger);
      const live = fixture.live;
      await clearLease(pool, fixture.claim.intent.id);
      const intents = new PostgresExecutionIntentRepository(pool);
      const confirmationClaim = await intents.claim({
        ownerId: 'confirmation-read-model', leaseMs: 60_000, purpose: 'CONFIRM',
      });
      assert.ok(confirmationClaim);

      const readQueries: string[] = [];
      const reader = new PostgresExecutionLiveRepository({
        connect: async () => {
          const client = await pool.connect();
          return {
            query: async (text: string, values?: readonly unknown[]) => {
              readQueries.push(text);
              const result = await client.query(text, values as unknown[] | undefined);
              return { rows: result.rows as readonly Readonly<Record<string, unknown>>[],
                rowCount: result.rowCount };
            },
            release: (error?: boolean) => { client.release(error); },
          };
        },
      });
      const confirmation = await reader.readConfirmationWork(confirmationClaim);
      assert.deepEqual(confirmation, {
        payloadVersion: 1,
        artifactId: fixture.artifact.artifactId,
        expectedRevision: 3n,
        signature: fixture.artifact.signature,
        providerId: 'primary',
      });
      await live.recordConfirmation(confirmationClaim, Object.freeze({
        payloadVersion: 1,
        artifactId: confirmation.artifactId,
        expectedRevision: confirmation.expectedRevision,
        signature: confirmation.signature,
        observedSlot: 127n,
        observedAtMs: Date.now() + 2_000,
      }));

      const releasedLease = await pool.query(`SELECT lease_owner,lease_token,
        lease_expires_at FROM execution_intents WHERE id=$1`, [fixture.claim.intent.id]);
      assert.deepEqual(releasedLease.rows, [{
        lease_owner: null, lease_token: null, lease_expires_at: null,
      }]);

      const reconciliationClaim = await intents.claim({
        ownerId: 'reconciliation-read-model', leaseMs: 60_000, purpose: 'RECONCILE',
      });
      assert.ok(reconciliationClaim);
      await pool.query(`UPDATE execution_wallet_generations SET
        retired_at=date_trunc('milliseconds',statement_timestamp())
        WHERE generation_id=$1`, [generationId]);
      const reconciliation = await reader.readReconciliationWork(reconciliationClaim);
      assert.equal(reconciliation.providerId, 'primary');
      assert.deepEqual(reconciliation.request, {
        payloadVersion: 1,
        expected: {
          intentId: fixture.claim.intent.id,
          attemptNumber: 1,
          walletGeneration: 1,
          providerId: 'primary',
          side: 'BUY',
          signature: fixture.artifact.signature,
          blockhash: fixture.artifact.blockhash,
          lastValidBlockHeight: aboveSafeInteger,
          messageHash: fixture.artifact.messageHash,
          buildFingerprint: fixture.artifact.buildFingerprint,
          snapshotFingerprint: fixture.artifact.snapshotFingerprint,
          maximumFeeLamports: fixture.unsignedSimulation.estimatedFeeLamports,
          maximumFeePayerLamportDebit:
            fixture.unsignedSimulation.simulatedFeePayerLamportDebit,
        },
        walletDeltaRequest: {
          signature: fixture.artifact.signature,
          walletPublicKey: fixture.artifact.walletPublicKey,
          mint: fixture.artifact.walletPublicKey,
          quoteMint,
          side: 'BUY',
        },
      });
      const workerQueries = readQueries.filter((query) =>
        query.includes('execution_live_confirmation_work')
          || query.includes('execution_live_reconciliation_work'));
      assert.equal(workerQueries.length, 2);
      for (const query of workerQueries) {
        assert.doesNotMatch(query, /signed_transaction_bytes|transaction\.\*/u);
      }
    });
  });

void test('confirmation read-model rechecks the lease after waiting on durable row locks',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: confirmation read-model lease race skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await acceptedBuyFixture(pool);
      await clearLease(pool, fixture.claim.intent.id);
      const claim = await new PostgresExecutionIntentRepository(pool).claim({
        ownerId: 'confirmation-lease-race', leaseMs: 60_000, purpose: 'CONFIRM',
      });
      assert.ok(claim);
      const blocker = await pool.connect();
      const observer = await pool.connect();
      let pending: Promise<unknown> | null = null;
      let blockerReleased = false;
      try {
        await blocker.query('BEGIN');
        const blockerPid = (await blocker.query<{ readonly pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )).rows[0]?.pid;
        assert.ok(Number.isInteger(blockerPid));
        await blocker.query('SELECT id FROM execution_intents WHERE id=$1 FOR UPDATE', [
          claim.intent.id,
        ]);
        pending = fixture.live.readConfirmationWork(claim);
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
          const observed = await observer.query<{ readonly blocked: boolean }>(`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity activity
            WHERE $1::INTEGER = ANY(pg_blocking_pids(activity.pid))
          ) AS blocked`, [blockerPid]);
          blocked = observed.rows[0]?.blocked === true;
          if (!blocked) await observer.query('SELECT pg_sleep(0.01)');
        }
        assert.equal(blocked, true, 'confirmation read-model did not wait on the intent lock');
        await blocker.query(`UPDATE execution_intents SET lease_expires_at=date_trunc(
          'milliseconds',statement_timestamp()+INTERVAL '100 milliseconds') WHERE id=$1`, [
          claim.intent.id,
        ]);
        await blocker.query('SELECT pg_sleep(0.2)');
        await blocker.query('COMMIT');
        blockerReleased = true;
        await assert.rejects(pending, isLiveRepositoryError('LEASE_LOST'));
      } finally {
        if (!blockerReleased) await blocker.query('ROLLBACK');
        blocker.release();
        observer.release();
        if (pending !== null) await pending.catch(() => undefined);
      }
      const unchanged = await pool.query(`SELECT
        (SELECT status FROM execution_intents WHERE id=$1) AS intent_status,
        (SELECT state FROM execution_signed_transactions WHERE artifact_id=$2) AS artifact_state,
        (SELECT COUNT(*)::INTEGER FROM execution_submission_events WHERE artifact_id=$2)
          AS submission_events`, [claim.intent.id, fixture.artifact.artifactId]);
      assert.deepEqual(unchanged.rows, [{
        intent_status: 'SUBMITTED', artifact_state: 'ACCEPTED', submission_events: 4,
      }]);
  });
});

void test('confirmation rejects a lease that expires while waiting on the intent lock',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: confirmation commit lease race skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await acceptedBuyFixture(pool);
      await clearLease(pool, fixture.claim.intent.id);
      const claim = await new PostgresExecutionIntentRepository(pool).claim({
        ownerId: 'confirmation-commit-lease-race', leaseMs: 60_000, purpose: 'CONFIRM',
      });
      assert.ok(claim);
      const confirmation = await fixture.live.readConfirmationWork(claim);
      const stateSql = `SELECT
        (SELECT state FROM execution_signed_transactions WHERE artifact_id=$1) AS artifact_state,
        (SELECT state_revision::TEXT FROM execution_signed_transactions WHERE artifact_id=$1)
          AS artifact_revision,
        (SELECT status FROM execution_intents WHERE id=$2) AS intent_status,
        (SELECT state_revision::TEXT FROM execution_intents WHERE id=$2) AS intent_revision,
        (SELECT COUNT(*)::INTEGER FROM execution_submission_events WHERE artifact_id=$1)
          AS submission_events,
        (SELECT COUNT(*)::INTEGER FROM execution_intent_transitions WHERE intent_id=$2)
          AS intent_transitions`;
      const stateValues = [fixture.artifact.artifactId, claim.intent.id];
      const baseline = await pool.query(stateSql, stateValues);
      const blocker = await pool.connect();
      const observer = await pool.connect();
      let pending: Promise<unknown> | null = null;
      let blockerReleased = false;
      try {
        await blocker.query('BEGIN');
        const blockerPid = (await blocker.query<{ readonly pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )).rows[0]?.pid;
        assert.ok(Number.isInteger(blockerPid));
        await blocker.query('SELECT id FROM execution_intents WHERE id=$1 FOR UPDATE', [
          claim.intent.id,
        ]);
        pending = fixture.live.recordConfirmation(claim, Object.freeze({
          payloadVersion: 1,
          artifactId: confirmation.artifactId,
          expectedRevision: confirmation.expectedRevision,
          signature: confirmation.signature,
          observedSlot: 127n,
          observedAtMs: Date.now() + 2_000,
        }));
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
          const observed = await observer.query<{ readonly blocked: boolean }>(`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity activity
            WHERE $1::INTEGER = ANY(pg_blocking_pids(activity.pid))
          ) AS blocked`, [blockerPid]);
          blocked = observed.rows[0]?.blocked === true;
          if (!blocked) await observer.query('SELECT pg_sleep(0.01)');
        }
        assert.equal(blocked, true, 'confirmation did not wait on the intent row lock');
        await blocker.query(`UPDATE execution_intents SET
          lease_expires_at=date_trunc('milliseconds',statement_timestamp()+INTERVAL '100 milliseconds')
          WHERE id=$1`, [claim.intent.id]);
        await blocker.query('SELECT pg_sleep(0.2)');
        await blocker.query('COMMIT');
        blockerReleased = true;
        await assert.rejects(pending, isLiveRepositoryError('LEASE_LOST'));
      } finally {
        if (!blockerReleased) await blocker.query('ROLLBACK');
        blocker.release();
        observer.release();
        if (pending !== null) await pending.catch(() => undefined);
      }
      const after = await pool.query(stateSql, stateValues);
      assert.deepEqual(after.rows, baseline.rows);
    });
  });

void test('worker read-models reject provider, owner and generation divergence without mutation',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: live worker divergence tests skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await acceptedBuyFixture(pool);
      await clearLease(pool, fixture.claim.intent.id);
      const confirmationClaim = await new PostgresExecutionIntentRepository(pool).claim({
        ownerId: 'confirmation-divergence', leaseMs: 60_000, purpose: 'CONFIRM',
      });
      assert.ok(confirmationClaim);
      await assert.rejects(fixture.live.readConfirmationWork(Object.freeze({
        ...confirmationClaim, leaseOwner: 'forged-confirmation-owner',
      })), isLiveRepositoryError('LEASE_LOST'));
      await assert.rejects(fixture.live.readConfirmationWork(Object.freeze({
        ...confirmationClaim, leaseToken: randomUUID(),
      })), isLiveRepositoryError('LEASE_LOST'));
      await pool.query('UPDATE execution_intents SET attempt_count=2 WHERE id=$1', [
        confirmationClaim.intent.id,
      ]);
      await assert.rejects(
        fixture.live.readConfirmationWork(confirmationClaim),
        isLiveRepositoryError('CONFLICT'),
      );
      await pool.query('UPDATE execution_intents SET attempt_count=1 WHERE id=$1', [
        confirmationClaim.intent.id,
      ]);
      await pool.query(`UPDATE execution_attempts SET provider_id='secondary'
        WHERE intent_id=$1 AND attempt_number=1`, [confirmationClaim.intent.id]);
      await assert.rejects(
        fixture.live.readConfirmationWork(confirmationClaim),
        isLiveRepositoryError('INVALID_DATA'),
      );
      const unchanged = await pool.query(`SELECT
        (SELECT status FROM execution_intents WHERE id=$1) AS intent_status,
        (SELECT state FROM execution_signed_transactions WHERE artifact_id=$2) AS artifact_state,
        (SELECT COUNT(*)::INTEGER FROM execution_submission_events WHERE artifact_id=$2)
          AS submission_events`, [confirmationClaim.intent.id, fixture.artifact.artifactId]);
      assert.deepEqual(unchanged.rows, [{
        intent_status: 'SUBMITTED', artifact_state: 'ACCEPTED', submission_events: 4,
      }]);
    });
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await acceptedBuyFixture(pool);
      await clearLease(pool, fixture.claim.intent.id);
      const intents = new PostgresExecutionIntentRepository(pool);
      const confirmationClaim = await intents.claim({
        ownerId: 'confirmation-before-generation-divergence',
        leaseMs: 60_000,
        purpose: 'CONFIRM',
      });
      assert.ok(confirmationClaim);
      const confirmation = await fixture.live.readConfirmationWork(confirmationClaim);
      await fixture.live.recordConfirmation(confirmationClaim, Object.freeze({
        payloadVersion: 1,
        artifactId: confirmation.artifactId,
        expectedRevision: confirmation.expectedRevision,
        signature: confirmation.signature,
        observedSlot: 127n,
        observedAtMs: Date.now() + 2_000,
      }));
      const reconciliationClaim = await intents.claim({
        ownerId: 'generation-divergence', leaseMs: 60_000, purpose: 'RECONCILE',
      });
      assert.ok(reconciliationClaim);
      await pool.query(`UPDATE execution_wallet_generations SET wallet_public_key=$2
        WHERE generation_id=$1`, [generationId, quoteMint]);
      await assert.rejects(
        fixture.live.readReconciliationWork(reconciliationClaim),
        isLiveRepositoryError('INVALID_DATA'),
      );
      const unchanged = await pool.query(`SELECT
        (SELECT status FROM execution_intents WHERE id=$1) AS intent_status,
        (SELECT state FROM execution_signed_transactions WHERE artifact_id=$2) AS artifact_state,
        (SELECT COUNT(*)::INTEGER FROM execution_reconciliation_evidence WHERE intent_id=$1)
          AS evidence_count`, [reconciliationClaim.intent.id, fixture.artifact.artifactId]);
      assert.deepEqual(unchanged.rows, [{
        intent_status: 'CONFIRMED', artifact_state: 'CONFIRMED', evidence_count: 0,
      }]);
    });
  });

void test('confirmation read-model rejects a causally divergent artifact identity',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: artifact identity divergence test skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await acceptedBuyFixture(pool);
      await clearLease(pool, fixture.claim.intent.id);
      const claim = await new PostgresExecutionIntentRepository(pool).claim({
        ownerId: 'artifact-identity-divergence', leaseMs: 60_000, purpose: 'CONFIRM',
      });
      assert.ok(claim);
      await disableSignedTransactionUpdateGuards(pool);
      const divergentMessageHash = 'd'.repeat(64);
      await pool.query(`UPDATE execution_signed_transactions SET message_hash=$2
        WHERE artifact_id=$1`, [fixture.artifact.artifactId, divergentMessageHash]);
      await pool.query(`UPDATE execution_attempts SET reconciliation_message_hash=$2
        WHERE intent_id=$1 AND attempt_number=1`, [claim.intent.id, divergentMessageHash]);

      await assert.rejects(
        fixture.live.readConfirmationWork(claim),
        isLiveRepositoryError('INVALID_DATA'),
      );
    });
  });

void test('confirmation read-model rejects a non-canonical 64-byte signature encoding',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: canonical signature test skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await acceptedBuyFixture(pool);
      await clearLease(pool, fixture.claim.intent.id);
      const claim = await new PostgresExecutionIntentRepository(pool).claim({
        ownerId: 'non-canonical-signature', leaseMs: 60_000, purpose: 'CONFIRM',
      });
      assert.ok(claim);
      const nonCanonicalSignature = 'z'.repeat(64);
      assert.notEqual(bs58.decode(nonCanonicalSignature).byteLength, 64);
      await disableSignedTransactionUpdateGuards(pool);
      await pool.query(`UPDATE execution_signed_transactions SET signature=$2
        WHERE artifact_id=$1`, [fixture.artifact.artifactId, nonCanonicalSignature]);
      await pool.query(`UPDATE execution_attempts SET reconciliation_signature=$2
        WHERE intent_id=$1 AND attempt_number=1`, [claim.intent.id, nonCanonicalSignature]);

      await assert.rejects(
        fixture.live.readConfirmationWork(claim),
        isLiveRepositoryError('INVALID_DATA'),
      );
    });
  });

void test('reconciliation read-model rejects non-canonical Solana keys and blockhashes',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: canonical Solana identity test skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const { fixture, claim } = await confirmedBuyReconciliationFixture(pool);
      const nonCanonicalPublicKey = 'z'.repeat(32);
      assert.notEqual(bs58.decode(nonCanonicalPublicKey).byteLength, 32);
      await pool.query('UPDATE execution_intents SET mint=$2 WHERE id=$1', [
        claim.intent.id, nonCanonicalPublicKey,
      ]);
      await assert.rejects(
        fixture.live.readReconciliationWork(claim),
        isLiveRepositoryError('INVALID_DATA'),
      );
    });
    await withTemporarySchema(databaseUrl, async (pool) => {
      const { fixture, claim } = await confirmedBuyReconciliationFixture(pool);
      const nonCanonicalBlockhash = 'z'.repeat(32);
      assert.notEqual(bs58.decode(nonCanonicalBlockhash).byteLength, 32);
      await disableSignedTransactionUpdateGuards(pool);
      await pool.query(`UPDATE execution_signed_transactions SET blockhash=$2
        WHERE artifact_id=$1`, [fixture.artifact.artifactId, nonCanonicalBlockhash]);
      await pool.query(`UPDATE execution_attempts SET reconciliation_blockhash=$2
        WHERE intent_id=$1 AND attempt_number=1`, [claim.intent.id, nonCanonicalBlockhash]);
      await assert.rejects(
        fixture.live.readReconciliationWork(claim),
        isLiveRepositoryError('INVALID_DATA'),
      );
    });
  });

void test('reconciliation read-model enforces the durable intent and artifact state matrix',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: worker state matrix test skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const { fixture, claim } = await confirmedBuyReconciliationFixture(pool);
      await disableSignedTransactionUpdateGuards(pool);
      await pool.query(`UPDATE execution_signed_transactions SET state='ACCEPTED'
        WHERE artifact_id=$1`, [fixture.artifact.artifactId]);
      await assert.rejects(
        fixture.live.readReconciliationWork(claim),
        isLiveRepositoryError('INVALID_DATA'),
      );
    });
  });

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
      preSignatureLockId: fixture.preSignatureLockId,
      qualificationId: fixture.qualificationId,
      reservationId: fixture.reservationId,
      artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
      rpcBudget: fixture.rpcBudget,
    });

    const persisted = await Promise.all([
      repository.persistSigned(input),
      repository.persistSigned(input),
    ]);

    assert.deepEqual(persisted.map((result) => result.artifact), [
      fixture.artifact, fixture.artifact,
    ]);
    assert.deepEqual(persisted.map((result) => Object.freeze({
      status: result.claim.intent.status,
      revision: result.claim.intent.stateRevision,
    })), [
      { status: 'SIGNED_NOT_SUBMITTED', revision: fixture.claim.intent.stateRevision + 2n },
      { status: 'SIGNED_NOT_SUBMITTED', revision: fixture.claim.intent.stateRevision + 2n },
    ]);
    const persistedClaim = persisted[0]?.claim;
    assert.ok(persistedClaim);
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
      claim: persistedClaim, artifactId: fixture.artifact.artifactId,
    });
    assert.equal(authenticated.state, 'PERSISTED');
    assert.deepEqual(authenticated.artifact.signedTransactionBytes,
      fixture.artifact.signedTransactionBytes);
    const futureRevisionClaim = Object.freeze({
      ...fixture.claim,
      intent: Object.freeze({
        ...fixture.claim.intent,
        stateRevision: fixture.claim.intent.stateRevision + 3n,
      }),
    });
    await assert.rejects(
      repository.inspectSignedTransaction({ claim: futureRevisionClaim }),
      isLiveRepositoryError('INVALID_DATA'),
    );
    const recovered = await repository.inspectSignedTransaction({ claim: fixture.claim });
    assert.equal(recovered?.state, 'PERSISTED');
    assert.ok(recovered !== null && 'artifact' in recovered);
    assert.equal(recovered.artifact.artifactId, fixture.artifact.artifactId);
    assert.deepEqual(recovered.unsignedSimulation, fixture.unsignedSimulation);
    assert.equal(recovered.claim.intent.status, 'SIGNED_NOT_SUBMITTED');
    assert.equal(
      recovered.claim.intent.stateRevision,
      fixture.claim.intent.stateRevision + 2n,
    );
    const renewedRecoveredClaim = await new PostgresExecutionIntentRepository(pool).renew(
      recovered.claim,
      60_000,
    );
    assert.equal(renewedRecoveredClaim.intent.status, 'SIGNED_NOT_SUBMITTED');
    assert.equal(renewedRecoveredClaim.intent.stateRevision, recovered.claim.intent.stateRevision);
    const signedEvidenceMetrics = Object.freeze({
      simulationSlot: 126n, unitsConsumed: 26_000n,
      feePayerLamportDebit: 5_500n, baseDeltaRaw: 95n, quoteDeltaRaw: -1_000n,
      observedAtMs: fixture.artifact.signedAtMs + 1,
    });
    await assert.rejects(repository.recordSignedSimulation(
      persistedClaim,
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
      persistedClaim, signedEvidence,
    );
    assert.equal(signedSimulation.state, 'SIGNED_SIMULATED');
    assert.equal(signedSimulation.stateRevision, 1n);
    assert.deepEqual(
      await repository.recordSignedSimulation(persistedClaim, signedEvidence),
      signedSimulation,
    );
    const recoveredSignedSimulation = await repository.inspectSignedTransaction({
      claim: fixture.claim,
    });
    assert.equal(recoveredSignedSimulation?.state, 'SIGNED_SIMULATED');
    assert.ok(recoveredSignedSimulation !== null && 'artifact' in recoveredSignedSimulation);
    assert.equal(recoveredSignedSimulation.claim.intent.status, 'SIGNED_NOT_SUBMITTED');
    assert.equal(
      recoveredSignedSimulation.claim.intent.stateRevision,
      fixture.claim.intent.stateRevision + 2n,
    );
    const renewedSignedSimulationClaim = await new PostgresExecutionIntentRepository(pool).renew(
      recoveredSignedSimulation.claim,
      60_000,
    );
    assert.equal(
      renewedSignedSimulationClaim.intent.stateRevision,
      recoveredSignedSimulation.claim.intent.stateRevision,
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
      claim: persistedClaim,
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
    const outcome = await repository.recordSubmissionOutcome(persistedClaim, Object.freeze({
      payloadVersion: 1,
      artifactId: fixture.artifact.artifactId,
      expectedRevision: submissionStarted.stateRevision,
      outcome: 'ACCEPTED',
      returnedSignature: fixture.artifact.signature,
      reasonCode: 'SUBMISSION_ACCEPTED',
      observedAtMs: Date.now(),
    }));
    assert.equal(outcome.claim.intent.status, 'SUBMITTED');
    assert.equal(
      outcome.claim.intent.stateRevision,
      persistedClaim.intent.stateRevision + 1n,
    );
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
      observedAtMs: Date.now(),
    } as const);
    await repository.recordConfirmation(outcome.claim, entryConfirmation);
    await repository.recordConfirmation(outcome.claim, entryConfirmation);
    const reconciliationClaim = await new PostgresExecutionIntentRepository(pool).claim({
      ownerId: 'entry-reconciliation-after-confirmation',
      leaseMs: 60_000,
      purpose: 'RECONCILE',
    });
    assert.ok(reconciliationClaim);
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
    const entryReconciliationAtMs = Date.now();
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
        observedAtMs: entryReconciliationAtMs,
        finalizedAtMs: entryReconciliationAtMs,
      }),
    });
    const reconciled = await repository.commitReconciliation(
      reconciliationClaim,
      reconciliation,
    );
    assert.equal(reconciled.result, 'MATCHED');
    assert.equal(reconciled.position?.baseAmountRaw, 95n);
    assert.equal(reconciled.exitAuthorization?.maximumBaseAmountRaw, 95n);
    const replayedEntry = await repository.commitReconciliation(
      reconciliationClaim,
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
    const dueAtMs = await makePositionDue(pool, reconciled.position.positionId);
    const notDue = await repository.createDeadlineExitIntent({
      positionId: reconciled.position.positionId,
      observedAtMs: dueAtMs - 1,
    });
    assert.equal(notDue.kind, 'NOT_DUE');
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
    const sellLastValidBlockHeight = 9_007_199_254_740_993n;
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
      walletPublicKey: fixture.artifact.walletPublicKey,
      side: 'SELL',
      effectiveVenue: 'PUMP_FUN',
      messageHash: 'a'.repeat(64),
      buildFingerprint: fixture.artifact.buildFingerprint,
      snapshotFingerprint: 'c'.repeat(64),
      quoteFingerprint: 'e'.repeat(64),
      quoteObservedAtMs: exitTimelineMs,
      quoteExpiresAtMs: exitTimelineMs + 60_000,
      blockhash: fixture.artifact.walletPublicKey,
      lastValidBlockHeight: sellLastValidBlockHeight,
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
      preSignatureLockId: null,
      qualificationId: fixture.qualificationId,
      reservationId: null,
      artifact: exitArtifact,
      unsignedSimulation: exitUnsignedSimulation,
      rpcBudget: fixture.rpcBudget,
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
      observedAtMs: Date.now(),
    }));
    await clearLease(pool, exitBegun.claim.intent.id);
    const exitReconciliationClaim = await new PostgresExecutionIntentRepository(pool).claim({
      ownerId: 'live-exit-reconciliation', leaseMs: 60_000, purpose: 'RECONCILE',
    });
    assert.ok(exitReconciliationClaim);
    const exitWork = await repository.readReconciliationWork(exitReconciliationClaim);
    assert.equal(exitWork.providerId, exitArtifact.providerId);
    assert.equal(exitWork.request.expected.side, 'SELL');
    assert.equal(exitWork.request.expected.signature, exitArtifact.signature);
    assert.equal(exitWork.request.expected.lastValidBlockHeight, sellLastValidBlockHeight);
    assert.equal(exitWork.request.walletDeltaRequest.mint, exitBegun.claim.intent.mint);
    assert.equal(exitWork.request.walletDeltaRequest.quoteMint, exitBegun.claim.intent.quoteMint);
    const exitObservedAtMs = Date.now();
    const exitExpected = Object.freeze({
      intentId: exitArtifact.intentId,
      attemptNumber: exitArtifact.attemptNumber,
      walletGeneration: 1,
      providerId: exitArtifact.providerId,
      side: 'SELL' as const,
      signature: exitArtifact.signature,
      blockhash: exitArtifact.blockhash,
      lastValidBlockHeight: exitArtifact.lastValidBlockHeight,
      messageHash: exitArtifact.messageHash,
      buildFingerprint: exitArtifact.buildFingerprint,
      snapshotFingerprint: exitArtifact.snapshotFingerprint,
      maximumFeeLamports: exitUnsignedSimulation.estimatedFeeLamports,
      maximumFeePayerLamportDebit:
        exitUnsignedSimulation.simulatedFeePayerLamportDebit,
    });
    const firstExitUnknown = evaluateExecutionReconciliation({
      expected: exitExpected,
      observed: Object.freeze({
        signatureHistory: 'UNKNOWN', confirmationStatus: 'NOT_FOUND',
        finalizedBlockHeight: sellLastValidBlockHeight, observedSlot: null,
        transaction: null, feeLamports: 0n, walletLamportDelta: 0n,
        baseDeltaRaw: 0n, quoteDeltaRaw: 0n,
        unexpectedResidualTokenBalanceRaw: 0n,
        observedAtMs: exitObservedAtMs, finalizedAtMs: null,
      }),
    });
    assert.equal((await repository.commitReconciliation(
      exitReconciliationClaim,
      firstExitUnknown,
    )).result, 'UNKNOWN');
    const secondExitClaim = await new PostgresExecutionIntentRepository(pool).claim({
      ownerId: 'live-exit-reconciliation-second', leaseMs: 60_000, purpose: 'RECONCILE',
    });
    assert.ok(secondExitClaim);
    const secondExitUnknown = evaluateExecutionReconciliation({
      expected: exitExpected,
      observed: Object.freeze({
        signatureHistory: 'UNKNOWN', confirmationStatus: 'NOT_FOUND',
        finalizedBlockHeight: sellLastValidBlockHeight, observedSlot: null,
        transaction: null, feeLamports: 0n, walletLamportDelta: 0n,
        baseDeltaRaw: 0n, quoteDeltaRaw: 0n,
        unexpectedResidualTokenBalanceRaw: 0n,
        observedAtMs: exitObservedAtMs + 1, finalizedAtMs: null,
      }),
    });
    assert.equal((await repository.commitReconciliation(
      secondExitClaim,
      secondExitUnknown,
    )).result, 'UNKNOWN');
    const finalExitClaim = await new PostgresExecutionIntentRepository(pool).claim({
      ownerId: 'live-exit-reconciliation-final', leaseMs: 60_000, purpose: 'RECONCILE',
    });
    assert.ok(finalExitClaim);
    const exitEvidence = evaluateExecutionReconciliation({
      expected: exitExpected,
      observed: Object.freeze({
        signatureHistory: 'PRESENT', confirmationStatus: 'FINALIZED',
        finalizedBlockHeight: sellLastValidBlockHeight + 1n, observedSlot: 204n,
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
        observedAtMs: exitObservedAtMs + 2,
        finalizedAtMs: exitObservedAtMs + 3,
      }),
    });
    const exitReconciled = await repository.commitReconciliation(
      finalExitClaim,
      exitEvidence,
    );
    assert.equal(exitReconciled.result, 'MATCHED');
    const replayedExitReconciliation = await repository.commitReconciliation(
      exitReconciliationClaim,
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
    assert.equal(lateEntryReplay.position?.stateRevision, 3n);
    assert.equal(lateEntryReplay.exitAuthorization?.state, 'CONSUMED');
    assert.equal(lateEntryReplay.exitAuthorization?.stateRevision, 2n);
    const inferredExitConfirmation = await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_submission_events WHERE artifact_id=$1
        AND previous_state='AMBIGUOUS' AND next_state='CONFIRMED'`, [exitArtifact.artifactId]);
    assert.equal(inferredExitConfirmation.rows[0]?.count, 1);
  });
});

void test('BUY persistence commits only the exact authorized V2 pre-signature lock',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: exact BUY persistence test skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await exactBuyPersistenceFixture(pool);
      const unsigned = VersionedTransaction.deserialize(
        Uint8Array.from(fixture.authorization.material.unsignedTransactionBytes),
      );
      const signed = VersionedTransaction.deserialize(
        Uint8Array.from(fixture.input.artifact.signedTransactionBytes),
      );
      assert.deepEqual(signed.message.serialize(), unsigned.message.serialize());
      assert.deepEqual(
        signed.message.serialize(),
        Uint8Array.from(fixture.authorization.material.messageBytes),
      );

      const authorized = await exactBuyLockState(pool, fixture);
      assert.deepEqual(authorized, {
        lockState: 'AUTHORIZED', lockRevision: '0', armamentState: 'LOCKED',
        armamentRevision: '1', consumedBuys: 1, artifacts: 0,
      });

      const persisted = await fixture.live.persistSigned(fixture.input);
      assert.deepEqual(persisted.artifact, fixture.input.artifact);
      assert.deepEqual(await fixture.live.persistSigned(fixture.input), persisted);
      assert.deepEqual(await exactBuyLockState(pool, fixture), {
        lockState: 'SIGNED_PERSISTED', lockRevision: '1', armamentState: 'LOCKED',
        armamentRevision: '1', consumedBuys: 1, artifacts: 1,
      });
    });
  });

void test('BUY persistence rejects a missing or mismatched exact pre-signature lock without side effects',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: exact BUY persistence test skipped');
      return;
    }
    for (const preSignatureLockId of [
      null,
      `execution_pre_signature_lock_${'f'.repeat(64)}`,
    ]) {
      await withTemporarySchema(databaseUrl, async (pool) => {
        const fixture = await exactBuyPersistenceFixture(pool);
        await assert.rejects(fixture.live.persistSigned(Object.freeze({
          ...fixture.input,
          preSignatureLockId,
        })));
        assert.deepEqual(await exactBuyLockState(pool, fixture), {
          lockState: 'AUTHORIZED', lockRevision: '0', armamentState: 'LOCKED',
          armamentRevision: '1', consumedBuys: 1, artifacts: 0,
        });
      });
    }
  });

void test('BUY persistence rejects signed V0 bytes whose reconstructed unsigned envelope differs',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: exact BUY persistence test skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await exactBuyPersistenceFixture(pool);
      const substituted = new VersionedTransaction(new TransactionMessage({
        payerKey: exactBuyWallet.publicKey,
        recentBlockhash: exactBuyWalletPublicKey,
        instructions: [SystemProgram.transfer({
          fromPubkey: exactBuyWallet.publicKey,
          toPubkey: exactBuyWallet.publicKey,
          lamports: 1,
        })],
      }).compileToV0Message());
      substituted.sign([exactBuyWallet]);
      const substitutedMessageHash = sha256([...substituted.message.serialize()]);
      const mismatchedArtifact = createSignedTransactionArtifact({
        payloadVersion: fixture.input.artifact.payloadVersion,
        specificationVersion: fixture.input.artifact.specificationVersion,
        intentId: fixture.input.artifact.intentId,
        attemptNumber: fixture.input.artifact.attemptNumber,
        generationId: fixture.input.artifact.generationId,
        armamentId: fixture.input.artifact.armamentId,
        reservationId: fixture.input.artifact.reservationId,
        exitAuthorizationId: fixture.input.artifact.exitAuthorizationId,
        providerId: fixture.input.artifact.providerId,
        walletPublicKey: fixture.input.artifact.walletPublicKey,
        side: fixture.input.artifact.side,
        effectiveVenue: fixture.input.artifact.effectiveVenue,
        messageHash: substitutedMessageHash,
        buildFingerprint: fixture.input.artifact.buildFingerprint,
        snapshotFingerprint: fixture.input.artifact.snapshotFingerprint,
        quoteFingerprint: fixture.input.artifact.quoteFingerprint,
        quoteObservedAtMs: fixture.input.artifact.quoteObservedAtMs,
        quoteExpiresAtMs: fixture.input.artifact.quoteExpiresAtMs,
        blockhash: fixture.input.artifact.blockhash,
        lastValidBlockHeight: fixture.input.artifact.lastValidBlockHeight,
        signature: bs58.encode(substituted.signatures[0] ?? new Uint8Array(64)),
        signedTransactionBytes: substituted.serialize(),
        signedAtMs: fixture.input.artifact.signedAtMs,
      });
      assert.notDeepEqual(
        VersionedTransaction.deserialize(Uint8Array.from(mismatchedArtifact.signedTransactionBytes))
          .message.serialize(),
        Uint8Array.from(fixture.authorization.material.messageBytes),
      );
      await assert.rejects(fixture.live.persistSigned(Object.freeze({
        ...fixture.input,
        artifact: mismatchedArtifact,
        unsignedSimulation: Object.freeze({
          ...fixture.input.unsignedSimulation,
          messageHash: substitutedMessageHash,
        }),
      })));
      assert.deepEqual(await exactBuyLockState(pool, fixture), {
        lockState: 'AUTHORIZED', lockRevision: '0', armamentState: 'LOCKED',
        armamentRevision: '1', consumedBuys: 1, artifacts: 0,
      });
    });
  });

void test('RPC reservations remain bounded across repository instances and process recovery',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: live RPC budget integration skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await liveFixture(pool);
      const first = new PostgresExecutionLiveRepository(pool);
      const second = new PostgresExecutionLiveRepository(pool);
      const persisted = await first.persistSigned(Object.freeze({
        payloadVersion: 1,
        claim: fixture.claim,
        preSignatureLockId: fixture.preSignatureLockId,
        qualificationId: fixture.qualificationId,
        reservationId: fixture.reservationId,
        artifact: fixture.artifact,
        unsignedSimulation: fixture.unsignedSimulation,
        rpcBudget: Object.freeze({ payloadVersion: 1, callsUsed: 5, callsLimit: 12 }),
      }));

      const reserve = (repository: PostgresExecutionLiveRepository) =>
        repository.reserveRpcCall(Object.freeze({
          payloadVersion: 1,
          claim: persisted.claim,
          artifactId: fixture.artifact.artifactId,
        }));
      const reservations = await Promise.all([
        reserve(first), reserve(second), reserve(first), reserve(second),
        reserve(first), reserve(second), reserve(first),
      ]);
      assert.deepEqual(
        reservations.map((result) => result.callsReserved).sort((left, right) => left - right),
        [6, 7, 8, 9, 10, 11, 12],
      );
      await assert.rejects(reserve(second), isLiveRepositoryError('RPC_CALL_BUDGET_EXHAUSTED'));

      const replay = await first.persistSigned(Object.freeze({
        payloadVersion: 1,
        claim: fixture.claim,
        preSignatureLockId: fixture.preSignatureLockId,
        qualificationId: fixture.qualificationId,
        reservationId: fixture.reservationId,
        artifact: fixture.artifact,
        unsignedSimulation: fixture.unsignedSimulation,
        rpcBudget: Object.freeze({ payloadVersion: 1, callsUsed: 5, callsLimit: 12 }),
      }));
      assert.equal(replay.artifact.artifactId, fixture.artifact.artifactId);

      const durable = await pool.query(`SELECT initial_calls_used,calls_reserved,calls_limit
        FROM execution_live_rpc_budgets WHERE artifact_id=$1`, [fixture.artifact.artifactId]);
      assert.deepEqual(durable.rows, [{
        initial_calls_used: 5, calls_reserved: 12, calls_limit: 12,
      }]);

      const signed = await first.recordSignedSimulation(
        persisted.claim,
        signedSimulationEvidence(fixture.artifact, fixture.unsignedSimulation, {
          simulationSlot: 126n,
          unitsConsumed: 26_000n,
          feePayerLamportDebit: 5_500n,
          baseDeltaRaw: 95n,
          quoteDeltaRaw: -1_000n,
          observedAtMs: fixture.artifact.signedAtMs + 1,
        }),
      );
      await first.beginSubmission({
        claim: persisted.claim,
        artifactId: fixture.artifact.artifactId,
        expectedRevision: signed.stateRevision,
        ...submissionPreflight(fixture.artifact),
      });
      await assert.rejects(reserve(first), isLiveRepositoryError('LEASE_LOST'));
    });
  });

void test('exact signing authorization resolves and consumes the BUY preparation authority',
  async (context) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: preparation binding integration skipped');
      return;
    }
    await withTemporarySchema(databaseUrl, async (pool) => {
      const fixture = await liveFixture(pool);
      const binding = fixture.authorization.binding;

      assert.deepEqual(binding, {
        payloadVersion: 1,
        side: 'BUY',
        generationId,
        qualificationId: fixture.qualificationId,
        armamentId: fixture.armamentId,
        reservationId: fixture.reservationId,
        exitAuthorizationId: null,
        providerId: fixture.artifact.providerId,
        walletPublicKey: fixture.artifact.walletPublicKey,
      });

      const baseline = submissionPreflight(fixture.artifact).runtime;
      await assert.rejects(
        new PostgresExecutionLiveRepository(pool).readPreparationBinding({
          claim: fixture.claim, generationId, runtime: baseline,
        }),
        isLiveRepositoryError('PREFLIGHT_EXPIRED'),
      );
      await new PostgresExecutionOperationsRepository(pool).setStop({
        payloadVersion: 1,
        commandId: `command:preparation-stop:${randomUUID()}`,
        generationId,
        operatorId: 'operator-primary',
        occurredAtMs: Date.now(),
      }, 'ENTRY_STOP');
      await assert.rejects(
        new PostgresExecutionLiveRepository(pool).readPreparationBinding({
          claim: fixture.claim,
          generationId,
          runtime: baseline,
        }),
        isLiveRepositoryError('PREFLIGHT_EXPIRED'),
      );
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
      preSignatureLockId: fixture.preSignatureLockId,
      qualificationId: fixture.qualificationId, reservationId: fixture.reservationId,
      artifact: fixture.artifact, unsignedSimulation: fixture.unsignedSimulation,
      rpcBudget: fixture.rpcBudget,
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
      preSignatureLockId: fixture.preSignatureLockId,
      qualificationId: fixture.qualificationId,
      reservationId: fixture.reservationId, artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
      rpcBudget: fixture.rpcBudget,
    })), (error: unknown) => error instanceof ExecutionLiveRepositoryError
      && error.code === 'CONTROL_STOPPED');
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM execution_signed_transactions`)).rows[0]?.count, 0);
  });
});

for (const scenario of ['RETIRED_GENERATION', 'RUNTIME_BINDING', 'EXPOSURE_LIMIT',
  'DRAWDOWN_DRIFT', 'PROVIDER_USAGE_DRIFT', 'PROVIDER_RATE_LIMIT_DRIFT',
  'BLOCKHASH_EXPIRED'] as const) {
  void test(`atomic submission gate rejects ${scenario} without durable authorization`,
    async (context) => {
      const databaseUrl = process.env.TEST_DATABASE_URL;
      if (databaseUrl === undefined || databaseUrl.trim() === '') {
        context.skip('TEST_DATABASE_URL absent: atomic live gate test skipped');
        return;
      }
      await withTemporarySchema(databaseUrl, async (pool) => {
        const fixture = await liveFixture(pool);
        const repository = new PostgresExecutionLiveRepository(pool);
        await repository.persistSigned(Object.freeze({
          payloadVersion: 1, claim: fixture.claim,
          preSignatureLockId: fixture.preSignatureLockId,
          qualificationId: fixture.qualificationId,
          reservationId: fixture.reservationId,
          artifact: fixture.artifact,
          unsignedSimulation: fixture.unsignedSimulation,
          rpcBudget: fixture.rpcBudget,
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
      preSignatureLockId: fixture.preSignatureLockId,
      qualificationId: fixture.qualificationId,
      reservationId: fixture.reservationId,
      artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
      rpcBudget: fixture.rpcBudget,
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

void test('lease expiry while reconciliation waits on the intent lock fails closed', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: live reconciliation lease race test skipped');
    return;
  }
  await withTemporarySchema(databaseUrl, async (pool) => {
    const fixture = await liveFixture(pool);
    const repository = new PostgresExecutionLiveRepository(pool);
    await repository.persistSigned(Object.freeze({
      payloadVersion: 1, claim: fixture.claim,
      preSignatureLockId: fixture.preSignatureLockId,
      qualificationId: fixture.qualificationId,
      reservationId: fixture.reservationId,
      artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
      rpcBudget: fixture.rpcBudget,
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
    const stateSql = `SELECT
      (SELECT state FROM execution_signed_transactions WHERE artifact_id=$1) AS artifact_state,
      (SELECT state_revision::TEXT FROM execution_signed_transactions WHERE artifact_id=$1)
        AS artifact_revision,
      (SELECT state FROM execution_exposure_reservations WHERE intent_id=$2)
        AS reservation_state,
      (SELECT state_revision::TEXT FROM execution_exposure_reservations WHERE intent_id=$2)
        AS reservation_revision,
      (SELECT status FROM execution_intents WHERE id=$2) AS intent_status,
      (SELECT state_revision::TEXT FROM execution_intents WHERE id=$2) AS intent_revision,
      (SELECT status FROM execution_attempts WHERE intent_id=$2 AND attempt_number=1)
        AS attempt_status,
      (SELECT state_revision::TEXT FROM execution_wallet_risk_state WHERE generation_id=$3)
        AS risk_revision,
      (SELECT reserved_exposure_raw::TEXT FROM execution_wallet_risk_state
        WHERE generation_id=$3) AS reserved_exposure_raw,
      (SELECT open_positions FROM execution_wallet_risk_state WHERE generation_id=$3)
        AS open_positions,
      (SELECT unknown_block FROM execution_wallet_risk_state WHERE generation_id=$3)
        AS unknown_block,
      (SELECT COUNT(*)::INTEGER FROM execution_reconciliation_evidence WHERE intent_id=$2)
        AS evidence_count,
      (SELECT COUNT(*)::INTEGER FROM execution_live_positions) AS positions,
      (SELECT COUNT(*)::INTEGER FROM execution_submission_events WHERE artifact_id=$1)
        AS submission_events,
      (SELECT COUNT(*)::INTEGER FROM execution_intent_transitions WHERE intent_id=$2)
        AS transitions`;
    const stateValues = [fixture.artifact.artifactId, fixture.claim.intent.id, generationId];
    const baseline = await pool.query(stateSql, stateValues);
    const blocker = await pool.connect();
    const observer = await pool.connect();
    let pending: Promise<unknown> | null = null;
    let blockerReleased = false;
    try {
      await blocker.query('BEGIN');
      const blockerIdentity = await blocker.query<{ readonly pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      const blockerPid = blockerIdentity.rows[0]?.pid;
      assert.ok(Number.isInteger(blockerPid));
      await blocker.query('SELECT id FROM execution_intents WHERE id=$1 FOR UPDATE', [
        fixture.claim.intent.id,
      ]);
      pending = repository.commitReconciliation(fixture.claim, evidence);
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        const observed = await observer.query<{ readonly blocked: boolean }>(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity activity
          WHERE $1::INTEGER = ANY(pg_blocking_pids(activity.pid))
        ) AS blocked`, [blockerPid]);
        blocked = observed.rows[0]?.blocked === true;
        if (!blocked) await observer.query('SELECT pg_sleep(0.01)');
      }
      assert.equal(blocked, true, 'reconciliation did not wait on the intent row lock');
      await blocker.query(`UPDATE execution_intents SET
        lease_expires_at=date_trunc('milliseconds',statement_timestamp()+INTERVAL '100 milliseconds')
        WHERE id=$1`, [fixture.claim.intent.id]);
      await blocker.query('SELECT pg_sleep(0.2)');
      await blocker.query('COMMIT');
      blockerReleased = true;
      await assert.rejects(pending, isLiveRepositoryError('LEASE_LOST'));
    } finally {
      if (!blockerReleased) await blocker.query('ROLLBACK');
      blocker.release();
      observer.release();
      if (pending !== null) await pending.catch(() => undefined);
    }
    const after = await pool.query(stateSql, stateValues);
    assert.deepEqual(after.rows, baseline.rows);
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
      preSignatureLockId: fixture.preSignatureLockId,
      qualificationId: fixture.qualificationId,
      reservationId: fixture.reservationId,
      artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
      rpcBudget: fixture.rpcBudget,
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
    const expected = Object.freeze({
      intentId: fixture.claim.intent.id,
      attemptNumber: fixture.artifact.attemptNumber,
      walletGeneration: 1,
      providerId: fixture.artifact.providerId,
      side: 'BUY' as const,
      signature: fixture.artifact.signature,
      blockhash: fixture.artifact.blockhash,
      lastValidBlockHeight: fixture.artifact.lastValidBlockHeight,
      messageHash: fixture.artifact.messageHash,
      buildFingerprint: fixture.artifact.buildFingerprint,
      snapshotFingerprint: fixture.artifact.snapshotFingerprint,
      maximumFeeLamports: fixture.unsignedSimulation.estimatedFeeLamports,
      maximumFeePayerLamportDebit:
        fixture.unsignedSimulation.simulatedFeePayerLamportDebit,
    });
    const unknownEvidence = evaluateExecutionReconciliation({
      expected,
      observed: Object.freeze({
        signatureHistory: 'UNKNOWN', confirmationStatus: 'NOT_FOUND',
        finalizedBlockHeight: 999n, observedSlot: null, transaction: null,
        feeLamports: 0n, walletLamportDelta: 0n,
        baseDeltaRaw: 0n, quoteDeltaRaw: 0n,
        unexpectedResidualTokenBalanceRaw: 0n,
        observedAtMs: observedAtMs - 1, finalizedAtMs: null,
      }),
    });
    const unknown = await repository.commitReconciliation(fixture.claim, unknownEvidence);
    assert.equal(unknown.result, 'UNKNOWN');
    const releasedUnknown = await pool.query(
      'SELECT lease_owner,lease_token FROM execution_intents WHERE id=$1',
      [fixture.claim.intent.id],
    );
    assert.deepEqual(releasedUnknown.rows, [{ lease_owner: null, lease_token: null }]);
    const pendingClaim = await new PostgresExecutionIntentRepository(pool).claim({
      ownerId: 'live-reconciliation-pending',
      leaseMs: 60_000,
      purpose: 'RECONCILE',
    });
    assert.ok(pendingClaim);
    const repeatedUnknownEvidence = evaluateExecutionReconciliation({
      expected,
      observed: Object.freeze({
        signatureHistory: 'UNKNOWN', confirmationStatus: 'NOT_FOUND',
        finalizedBlockHeight: 999n, observedSlot: null, transaction: null,
        feeLamports: 0n, walletLamportDelta: 0n,
        baseDeltaRaw: 0n, quoteDeltaRaw: 0n,
        unexpectedResidualTokenBalanceRaw: 0n,
        observedAtMs, finalizedAtMs: null,
      }),
    });
    const repeatedUnknown = await repository.commitReconciliation(
      pendingClaim,
      repeatedUnknownEvidence,
    );
    assert.equal(repeatedUnknown.result, 'UNKNOWN');
    const releasedRepeatedUnknown = await pool.query(
      'SELECT lease_owner,lease_token FROM execution_intents WHERE id=$1',
      [fixture.claim.intent.id],
    );
    assert.deepEqual(releasedRepeatedUnknown.rows, [{ lease_owner: null, lease_token: null }]);
    const evidence = evaluateExecutionReconciliation({
      expected,
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
        observedAtMs: observedAtMs + 1, finalizedAtMs: observedAtMs + 1_000,
      }),
    });

    const replacementLeaseOwner = 'live-reconciliation-replacement';
    const rollbackSql = `SELECT
      (SELECT state FROM execution_signed_transactions WHERE artifact_id=$1) AS artifact_state,
      (SELECT state_revision::TEXT FROM execution_signed_transactions WHERE artifact_id=$1)
        AS artifact_revision,
      (SELECT state FROM execution_exposure_reservations WHERE intent_id=$2)
        AS reservation_state,
      (SELECT state_revision::TEXT FROM execution_exposure_reservations WHERE intent_id=$2)
        AS reservation_revision,
      (SELECT status FROM execution_intents WHERE id=$2) AS intent_status,
      (SELECT state_revision::TEXT FROM execution_intents WHERE id=$2) AS intent_revision,
      (SELECT lease_owner FROM execution_intents WHERE id=$2) AS lease_owner,
      (SELECT lease_token::TEXT FROM execution_intents WHERE id=$2) AS lease_token,
      (SELECT status FROM execution_attempts WHERE intent_id=$2 AND attempt_number=1)
        AS attempt_status,
      (SELECT state_revision::TEXT FROM execution_wallet_risk_state WHERE generation_id=$3)
        AS risk_revision,
      (SELECT reserved_exposure_raw::TEXT FROM execution_wallet_risk_state
        WHERE generation_id=$3) AS reserved_exposure_raw,
      (SELECT open_positions FROM execution_wallet_risk_state WHERE generation_id=$3)
        AS open_positions,
      (SELECT unknown_block FROM execution_wallet_risk_state WHERE generation_id=$3)
        AS unknown_block,
      (SELECT COUNT(*)::INTEGER FROM execution_reconciliation_evidence WHERE intent_id=$2)
        AS evidence_count,
      (SELECT COUNT(*)::INTEGER FROM execution_live_positions) AS positions,
      (SELECT COUNT(*)::INTEGER FROM execution_submission_events WHERE artifact_id=$1)
        AS submission_events,
      (SELECT COUNT(*)::INTEGER FROM execution_intent_transitions WHERE intent_id=$2)
        AS transitions`;
    const rollbackValues = [
      fixture.artifact.artifactId, fixture.claim.intent.id, generationId,
    ];
    const beforeRejectedReconciliation = await pool.query(rollbackSql, rollbackValues);
    await assert.rejects(
      repository.commitReconciliation(fixture.claim, evidence),
      isLiveRepositoryError('LEASE_LOST'),
    );
    const afterRejectedReconciliation = await pool.query(rollbackSql, rollbackValues);
    assert.deepEqual(afterRejectedReconciliation.rows, beforeRejectedReconciliation.rows);
    const replacementClaim = await new PostgresExecutionIntentRepository(pool).claim({
      ownerId: replacementLeaseOwner,
      leaseMs: 60_000,
      purpose: 'RECONCILE',
    });
    assert.ok(replacementClaim);
    assert.equal(replacementClaim.intent.id, fixture.claim.intent.id);
    const result = await repository.commitReconciliation(replacementClaim, evidence);

    assert.equal(result.result, 'MATCHED');
    assert.equal(result.position?.baseAmountRaw, 95n);
    const beforeForgedReplay = await pool.query(rollbackSql, rollbackValues);
    const forgedReplay = Object.freeze({
      ...evidence,
      observedAtMs: evidence.observedAtMs + 1,
    });
    await assert.rejects(
      repository.commitReconciliation(fixture.claim, forgedReplay),
      isLiveRepositoryError('CONFLICT'),
    );
    const afterForgedReplay = await pool.query(rollbackSql, rollbackValues);
    assert.deepEqual(afterForgedReplay.rows, beforeForgedReplay.rows);
    const replayed = await repository.commitReconciliation(fixture.claim, evidence);
    assert.equal(replayed.result, 'MATCHED');
    assert.equal(replayed.position?.positionId, result.position?.positionId);
    const beforeUnknownReplay = await pool.query(rollbackSql, rollbackValues);
    const replayedUnknown = await repository.commitReconciliation(fixture.claim, unknownEvidence);
    assert.equal(replayedUnknown.result, 'UNKNOWN');
    const afterUnknownReplay = await pool.query(rollbackSql, rollbackValues);
    assert.deepEqual(afterUnknownReplay.rows, beforeUnknownReplay.rows);
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
      preSignatureLockId: fixture.preSignatureLockId,
      qualificationId: fixture.qualificationId,
      reservationId: fixture.reservationId, artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
      rpcBudget: fixture.rpcBudget,
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
      preSignatureLockId: fixture.preSignatureLockId,
      qualificationId: fixture.qualificationId,
      reservationId: fixture.reservationId, artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
      rpcBudget: fixture.rpcBudget,
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
      preSignatureLockId: fixture.preSignatureLockId,
      qualificationId: fixture.qualificationId,
      reservationId: fixture.reservationId,
      artifact: fixture.artifact,
      unsignedSimulation: fixture.unsignedSimulation,
      rpcBudget: fixture.rpcBudget,
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

void test('PostgreSQL 16 recovery authority commits finality and creates a deadline SELL',
  async (context) => {
    const configuredUrl = process.env.TEST_DATABASE_URL;
    if (configuredUrl === undefined || configuredUrl.trim() === '') {
      context.skip('TEST_DATABASE_URL absent: recovery authority integration skipped');
      return;
    }
    const baseUrl = new URL(configuredUrl);
    const maintenance = new pg.Pool({ connectionString: baseUrl.href });
    const capabilities = await maintenance.query<{
      readonly rolsuper: boolean;
      readonly rolcreatedb: boolean;
      readonly server_version_number: number;
    }>(`SELECT role.rolsuper,role.rolcreatedb,
      current_setting('server_version_num')::INTEGER AS server_version_number
      FROM pg_roles role WHERE role.rolname=current_user`);
    const capability = capabilities.rows[0];
    if (!capability?.rolsuper || !capability.rolcreatedb
      || capability.server_version_number < 160_000) {
      await maintenance.end();
      context.skip('PostgreSQL 16 superuser with CREATEDB is required.');
      return;
    }
    const releaseRoleTestLock = await acquireExecutorRoleTestLock(maintenance);

    const suffix = randomUUID().replaceAll('-', '');
    const databaseName = `h2a_runtime_test_${suffix}`;
    const loginName = `h2a_runtime_${suffix}`;
    const password = randomUUID().replaceAll('-', '');
    const isolatedUrl = new URL(baseUrl);
    isolatedUrl.pathname = `/${databaseName}`;
    let isolated: InstanceType<typeof pg.Pool> | undefined;
    let recoveryDatabase: ReturnType<typeof createLiveRecoveryBootstrapDatabase> | undefined;
    try {
      await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0`);
      isolated = new pg.Pool({ connectionString: isolatedUrl.href });
      const fixture = await acceptedBuyFixture(isolated);
      await clearLease(isolated, fixture.claim.intent.id);
      const provisioning = await readFile(roleProvisioningUrl, 'utf8');
      await isolated.query(provisioning);
      await isolated.query(provisioning);
      await maintenance.query(`CREATE ROLE ${quoteIdentifier(loginName)} LOGIN NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
        PASSWORD ${quoteLiteral(password)}`);
      await maintenance.query(`GRANT sol_token_executor_live_recovery
        TO ${quoteIdentifier(loginName)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);

      const loginUrl = new URL(isolatedUrl);
      loginUrl.username = loginName;
      loginUrl.password = password;
      const loginPool = new pg.Pool({ connectionString: loginUrl.href, max: 2 });
      recoveryDatabase = createLiveRecoveryBootstrapDatabase(loginPool, () => loginPool.end());

      const confirmationClaim = await recoveryDatabase.intents.claimConfirmation(
        'h2a-confirmation', 60_000,
      );
      assert.ok(confirmationClaim);
      const confirmation = await recoveryDatabase.live.readConfirmationWork(confirmationClaim);
      const confirmationObservedAtMs = Date.now() + 2_000;
      await recoveryDatabase.live.recordConfirmation(confirmationClaim, Object.freeze({
        payloadVersion: 1,
        artifactId: confirmation.artifactId,
        expectedRevision: confirmation.expectedRevision,
        signature: confirmation.signature,
        observedSlot: 127n,
        observedAtMs: confirmationObservedAtMs,
      }));

      const unknownClaim = await recoveryDatabase.intents.claimReconciliation(
        'h2a-reconciliation-unknown', 60_000,
      );
      assert.ok(unknownClaim);
      const reconciliation = await recoveryDatabase.live.readReconciliationWork(unknownClaim);
      const unknown = evaluateExecutionReconciliation({
        expected: reconciliation.request.expected,
        observed: Object.freeze({
          signatureHistory: 'UNKNOWN', confirmationStatus: 'NOT_FOUND',
          finalizedBlockHeight: 1_000n, observedSlot: null, transaction: null,
          feeLamports: 0n, walletLamportDelta: 0n, baseDeltaRaw: 0n,
          quoteDeltaRaw: 0n, unexpectedResidualTokenBalanceRaw: 0n,
          observedAtMs: confirmationObservedAtMs + 1_000, finalizedAtMs: null,
        }),
      });
      await recoveryDatabase.live.commitReconciliation(unknownClaim, unknown);
      assert.equal((await isolated.query(
        'SELECT status FROM execution_intents WHERE id=$1',
        [fixture.claim.intent.id],
      )).rows[0]?.status, 'UNKNOWN_REQUIRES_RECONCILIATION');
      await assert.rejects(recoveryDatabase.startup.query(`INSERT INTO execution_control_events (
        event_id,payload_version,event_fingerprint,generation_id,previous_state,next_state,
        reason_code,qualification_id,authorization_id,operator_id,actor_type,actor_id,occurred_at
      ) VALUES ($1,1,$2,$3,'ENTRY_STOP','HARD_STOP','OPERATOR_HARD_STOP',NULL,NULL,
        'forged-operator','OPERATOR','forged-operator',statement_timestamp())`, [
        `execution_control_event_${'e'.repeat(64)}`, 'e'.repeat(64),
        fixture.artifact.generationId,
      ]), (error: unknown) => typeof error === 'object' && error !== null
        && 'code' in error && error.code === '42501');

      const matchedClaim = await recoveryDatabase.intents.claimReconciliation(
        'h2a-reconciliation-matched', 60_000,
      );
      assert.ok(matchedClaim);
      const matchedWork = await recoveryDatabase.live.readReconciliationWork(matchedClaim);
      const matched = evaluateExecutionReconciliation({
        expected: matchedWork.request.expected,
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
          observedAtMs: confirmationObservedAtMs + 2_000,
          finalizedAtMs: confirmationObservedAtMs + 3_000,
        }),
      });
      await recoveryDatabase.live.commitReconciliation(matchedClaim, matched);
      const durable = await isolated.query<{
        readonly position_id: string;
        readonly unknown_resolved: boolean;
        readonly artifact_state: string;
      }>(`SELECT position.position_id,
          EXISTS (SELECT 1 FROM execution_reconciliation_evidence evidence
            WHERE evidence.intent_id=$1 AND evidence.result='UNKNOWN'
              AND evidence.resolved_by_evidence_id IS NOT NULL) AS unknown_resolved,
          transaction.state AS artifact_state
        FROM execution_live_positions position
        JOIN execution_signed_transactions transaction
          ON transaction.intent_id=position.buy_intent_id
        WHERE position.buy_intent_id=$1 AND position.state='OPEN'`,
        [fixture.claim.intent.id],
      );
      assert.equal(durable.rows[0]?.unknown_resolved, true);
      assert.equal(durable.rows[0]?.artifact_state, 'RECONCILED');
      const positionId = durable.rows[0]?.position_id;
      assert.ok(positionId);

      try {
        await makePositionDue(isolated, positionId);
      } finally {
        await isolated.query(`ALTER TABLE execution_live_positions
          ENABLE TRIGGER execution_live_positions_guarded_update`);
      }
      const deadline = await recoveryDatabase.live.createNextDeadlineExitIntent();
      assert.equal(deadline?.kind, 'CREATED');
      assert.equal(deadline?.intent?.side, 'SELL');
      const exit = await isolated.query(`SELECT position.state,
        position.exit_intent_id,intent.status,intent.base_amount_raw::TEXT AS base_amount_raw
        FROM execution_live_positions position
        JOIN execution_intents intent ON intent.id=position.exit_intent_id
        WHERE position.position_id=$1`, [positionId]);
      assert.deepEqual(exit.rows, [{
        state: 'EXIT_PENDING', exit_intent_id: deadline?.intent?.id,
        status: 'PENDING', base_amount_raw: '95',
      }]);
    } finally {
      try {
        if (recoveryDatabase !== undefined) await recoveryDatabase.close();
        if (isolated !== undefined) await isolated.end();
        await maintenance.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname=$1 AND pid<>pg_backend_pid()`,
          [databaseName],
        );
        await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
        await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(loginName)}`);
      } finally {
        try { await releaseRoleTestLock(); } finally { await maintenance.end(); }
      }
    }
  });

async function liveFixture(
  pool: InstanceType<typeof pg.Pool>,
  quoteLifetimeMs = 60_000,
  maximumCanaryCapitalLamports = 500_000n,
  lastValidBlockHeight = 1_000n,
) {
  return exactBuyPersistenceFixture(pool, Object.freeze({
    quoteLifetimeMs, maximumCanaryCapitalLamports, lastValidBlockHeight,
  }));
}

async function exactBuyPersistenceFixture(
  pool: InstanceType<typeof pg.Pool>,
  options: Readonly<{
    readonly quoteLifetimeMs?: number;
    readonly maximumCanaryCapitalLamports?: bigint;
    readonly lastValidBlockHeight?: bigint;
  }> = {},
) {
  const quoteLifetimeMs = options.quoteLifetimeMs ?? 60_000;
  const maximumCanaryCapitalLamports = options.maximumCanaryCapitalLamports ?? 500_000n;
  const lastValidBlockHeight = options.lastValidBlockHeight ?? 1_000n;
  await migrateDatabase({ pool });
  const risk = new PostgresExecutionRiskRepository(pool);
  const intents = new PostgresExecutionIntentRepository(pool);
  await risk.registerWalletGeneration({
    generationId, payloadVersion: 1, walletPublicKey: exactBuyWalletPublicKey,
    cluster: 'mainnet-beta', genesisHash: exactBuyWalletPublicKey, generation: 1,
  });
  const snapshotNowMs = Date.now();
  const walletSnapshot = createExecutionWalletSnapshot({
    generationId, providerId: 'primary', stateRevision: 0n, slot: 123n,
    blockTimeMs: snapshotNowMs - 100, observedAtMs: snapshotNowMs - 50,
    commitment: 'finalized', walletLamports: 1_000_000n, tokenBalanceCount: 0,
    openPositions: [], realizedNetPnlRaw: 0n,
  });
  const providerSnapshot = createProviderUsageSnapshot({
    providerId: 'primary', planId: 'canary-v1', billingPeriodId: `period-${snapshotNowMs}`,
    billingPeriodStartedAtMs: snapshotNowMs - 60_000,
    billingPeriodEndsAtMs: snapshotNowMs + 600_000, limitUnits: 1_000n, usedUnits: 1n,
    measuredAtMs: snapshotNowMs - 50, expiresAtMs: snapshotNowMs + 300_000,
    provenance: 'OPERATOR_REPORT',
  });
  const simulation = await seedSuccessfulSimulation(pool, exactBuyWalletPublicKey);
  const nowMs = Date.now();
  const qualification = qualificationWithCanarySnapshots(
    safetyQualification(nowMs, simulation, exactBuyWalletPublicKey),
    walletSnapshot,
    providerSnapshot,
  );
  const operations = new PostgresExecutionOperationsRepository(pool);
  await operations.persistQualification(qualification);
  const resumeAuthorization = createOperatorAuthorization({
    payloadVersion: 1, generationId, action: 'RESUME', phase: null,
    contextFingerprint: qualification.qualificationFingerprint, nonceHash: '9'.repeat(64),
    operatorId: 'operator-primary', issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
  });
  await operations.recordAuthorization(resumeAuthorization);
  await operations.resume({
    payloadVersion: 1, commandId: `command:exact-buy-resume:${randomUUID()}`, generationId,
    qualificationId: qualification.qualificationId, authorization: resumeAuthorization,
    operatorId: 'operator-primary', occurredAtMs: nowMs,
  });
  const target = await intents.create(createExecutionIntentDraft({
    strategyId: 'exact-buy-target', strategyVersion: 1,
    positionId: `position:exact-buy:${randomUUID()}`,
    logicalCommandId: `command:exact-buy:${randomUUID()}`,
    mint: exactBuyWalletPublicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint,
    quoteTokenProgram: 'SPL_TOKEN', quoteDecimals: 9, quoteAmountRaw: 1_000n,
    baseAmountRaw: null, minimumAmountOutRaw: 1n,
    decisionEventId: `decision:exact-buy:${randomUUID()}`,
    decisionFingerprint: 'd'.repeat(64), requestedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 120_000,
  }));
  const request = createExecutionArmamentRequestV2({
    payloadVersion: 2, qualification, targetIntentId: target.intent.id,
    policy: exactBuyCanaryPolicy(), walletSnapshot, providerSnapshot,
    allEndpointsUnavailable: false, capturedAtMs: nowMs, expiresAtMs: nowMs + 120_000,
    target: {
      intentId: target.intent.id, stateRevision: target.intent.stateRevision,
      strategyId: target.intent.strategyId, strategyVersion: target.intent.strategyVersion,
      decisionFingerprint: target.intent.decisionFingerprint, mint: target.intent.mint,
      quoteMint: target.intent.quoteMint, quoteAmountRaw: target.intent.quoteAmountRaw,
    },
    maximumBuys: 1, maximumCapitalLamports: maximumCanaryCapitalLamports,
    maximumExposureBps: 500n,
    maximumOpenPositions: 1, maximumHoldingMs: 30_000, runtimeQuoteMaxAgeMs: 60_000,
    runtimeSlippageBps: 100n, runtimeSnapshotMaxSlotLag: 8,
    runtimeMaxComputeUnits: 200_000n, runtimeMaxFeeLamports: 5_000n,
    runtimeMaxFeePayerLamportDebit: 100_000n, runtimeMaxRpcCallsPerAttempt: 12,
    runtimeLeaseMs: 3_000, armedAtMs: nowMs, armamentExpiresAtMs: nowMs + 120_000,
    operatorId: 'operator-primary', operatorReason: 'Mainnet canary manually approved.',
  });
  const armamentAuthorization = createOperatorAuthorizationV2({
    payloadVersion: 2, generationId, action: 'ARM', phase: 'CANARY',
    contextFingerprint: request.armamentRequestFingerprint, nonceHash: 'e'.repeat(64),
    operatorId: 'operator-primary', issuedAtMs: nowMs, expiresAtMs: nowMs + 60_000,
  });
  await operations.armCanary(Object.freeze({ request, authorization: armamentAuthorization }));
  const claimed = await intents.claim({
    ownerId: 'exact-buy-lock-holder', leaseMs: 30_000,
    purpose: 'LIVE_EXECUTE', side: 'BUY', generationId,
  });
  assert.ok(claimed);
  const processingIntent = await intents.transition(claimed, {
    intentId: claimed.intent.id, expectedStatus: 'PENDING', nextStatus: 'PROCESSING',
    leaseToken: claimed.leaseToken, reasonCode: 'EXECUTION_STARTED',
    humanMessage: 'Exact BUY signing test started.', activationPhase: 'CANARY',
    evidence: Object.freeze({
      payloadVersion: 1, attemptNumber: null, sourceEventId: null, observedAtMs: nowMs,
    }),
  });
  const begun = await intents.beginAttempt(Object.freeze({ ...claimed, intent: processingIntent }));
  const unsigned = new VersionedTransaction(new TransactionMessage({
    payerKey: exactBuyWallet.publicKey, recentBlockhash: exactBuyWalletPublicKey, instructions: [],
  }).compileToV0Message());
  const messageBytes = Object.freeze([...unsigned.message.serialize()]);
  const unsignedTransactionBytes = Object.freeze([...unsigned.serialize()]);
  const quoteObservedAtMs = Date.now();
  const material = Object.freeze({
    payloadVersion: 1 as const, walletPublicKey: exactBuyWalletPublicKey, providerId: 'primary',
    side: 'BUY' as const, effectiveVenue: 'PUMP_FUN' as const, snapshotSlot: 125n,
    quoteFingerprint: '7'.repeat(64), quoteObservedAtMs,
    quoteExpiresAtMs: quoteObservedAtMs + quoteLifetimeMs,
    buildFingerprint: qualification.buildHash,
    snapshotFingerprint: walletSnapshot.snapshotFingerprint,
    messageHash: sha256(messageBytes), messageBytes,
    unsignedTransactionHash: sha256(unsignedTransactionBytes), unsignedTransactionBytes,
    blockhash: exactBuyWalletPublicKey, lastValidBlockHeight,
    unsignedSimulation: Object.freeze({
      outcome: 'SUCCESS' as const, snapshotFingerprint: walletSnapshot.snapshotFingerprint,
      buildFingerprint: qualification.buildHash, messageHash: sha256(messageBytes),
      blockhash: exactBuyWalletPublicKey, lastValidBlockHeight,
      blockhashContextSlot: 125n, feeContextSlot: 125n, estimatedFeeLamports: 5_000n,
      simulationSlot: 125n, simulatedFeePayerLamportDebit: 5_000n, unitsConsumed: 25_000n,
      simulatedBaseDeltaRaw: 100n, simulatedQuoteDeltaRaw: -1_000n,
      logsFingerprint: '8'.repeat(64), logsLineCount: 1,
    }),
  });
  const runtime = Object.freeze({
    payloadVersion: 1 as const, phase: 'CANARY' as const, buildHash: qualification.buildHash,
    configurationFingerprint: qualification.configurationFingerprint,
    strategyFingerprint: qualification.strategyFingerprint, walletPublicKey: exactBuyWalletPublicKey,
    cluster: 'mainnet-beta' as const, expectedGenesisHash: exactBuyWalletPublicKey,
    observedGenesisHash: exactBuyWalletPublicKey, providerId: 'primary', quoteMaxAgeMs: 60_000,
    slippageBps: 100n, snapshotMaxSlotLag: 8, maxComputeUnits: 200_000n,
    maxFeeLamports: 5_000n, maxFeePayerLamportDebit: 100_000n,
    maxRpcCallsPerAttempt: 12, leaseMs: 3_000,
  });
  const live = new PostgresExecutionLiveRepository(pool);
  const authorization = await live.authorizeExactSigning(Object.freeze({
    claim: begun.claim, attempt: begun.attempt, generationId, runtime, material,
  }));
  assert.ok(authorization.binding.armamentId !== null);
  assert.ok(authorization.binding.reservationId !== null);
  assert.ok(authorization.preSignatureLockId !== null);
  const signed = VersionedTransaction.deserialize(
    Uint8Array.from(authorization.material.unsignedTransactionBytes),
  );
  signed.sign([exactBuyWallet]);
  const artifact = createSignedTransactionArtifact({
    payloadVersion: 1, specificationVersion: 1, intentId: begun.claim.intent.id,
    attemptNumber: begun.attempt.attemptNumber, generationId,
    armamentId: authorization.binding.armamentId,
    reservationId: authorization.binding.reservationId, exitAuthorizationId: null,
    providerId: authorization.binding.providerId, walletPublicKey: exactBuyWalletPublicKey,
    side: 'BUY', effectiveVenue: authorization.material.effectiveVenue,
    messageHash: authorization.material.messageHash,
    buildFingerprint: authorization.material.buildFingerprint,
    snapshotFingerprint: authorization.material.snapshotFingerprint,
    quoteFingerprint: authorization.material.quoteFingerprint,
    quoteObservedAtMs: authorization.material.quoteObservedAtMs,
    quoteExpiresAtMs: authorization.material.quoteExpiresAtMs,
    blockhash: authorization.material.blockhash,
    lastValidBlockHeight: authorization.material.lastValidBlockHeight,
    signature: bs58.encode(signed.signatures[0] ?? new Uint8Array(64)),
    signedTransactionBytes: signed.serialize(), signedAtMs: Date.now(),
  });
  const input = Object.freeze({
    payloadVersion: 1 as const, claim: begun.claim,
    preSignatureLockId: authorization.preSignatureLockId,
    qualificationId: authorization.binding.qualificationId,
    reservationId: authorization.binding.reservationId, artifact,
    unsignedSimulation: authorization.material.unsignedSimulation,
    rpcBudget: Object.freeze({ payloadVersion: 1 as const, callsUsed: 5, callsLimit: 12 }),
  });
  return Object.freeze({
    live, input, authorization, claim: begun.claim, artifact,
    unsignedSimulation: authorization.material.unsignedSimulation,
    rpcBudget: input.rpcBudget, providerSnapshot,
    armamentId: authorization.binding.armamentId,
    qualificationId: authorization.binding.qualificationId,
    reservationId: authorization.binding.reservationId,
    preSignatureLockId: authorization.preSignatureLockId,
  });
}

function exactBuyCanaryPolicy() {
  return createExecutionRiskPolicy({
    quoteMintAllowlist: [quoteMint], initialCapitalLamports: 1_000_000n,
    maximumCapitalLamports: 1_000_000n, positionSizeBps: 1_000n,
    maximumOpenPositions: 1, maximumTotalExposureBps: 500n, drawdownPauseBps: 2_500n,
    feeReserveLamports: 100_000n, walletSnapshotMaxAgeMs: 60_000,
    providerUsageMaxAgeMs: 300_000, providerEntryCostUnits: 8n,
    providerExitCostUnitsPerPosition: 4n, providerConfirmationCostUnitsPerPosition: 2n,
    providerReconciliationCostUnitsPerPosition: 3n, providerSafetyMarginUnits: 5n,
    maximumConsecutiveTechnicalFailures: 2,
  });
}

async function exactBuyLockState(
  pool: InstanceType<typeof pg.Pool>,
  fixture: Awaited<ReturnType<typeof exactBuyPersistenceFixture>>,
) {
  const state = await pool.query(`SELECT lock.state AS lock_state,
    lock.state_revision::TEXT AS lock_revision,armament.state AS armament_state,
    armament.state_revision::TEXT AS armament_revision,armament.consumed_buys,
    (SELECT COUNT(*)::INTEGER FROM execution_signed_transactions) AS artifacts
    FROM execution_pre_signature_locks lock
    JOIN execution_activation_armaments armament ON armament.armament_id=lock.armament_id
    WHERE lock.lock_id=$1`, [fixture.authorization.preSignatureLockId]);
  assert.equal(state.rowCount, 1);
  const row = state.rows[0];
  assert.ok(row);
  return Object.freeze({
    lockState: row.lock_state, lockRevision: row.lock_revision,
    armamentState: row.armament_state, armamentRevision: row.armament_revision,
    consumedBuys: row.consumed_buys, artifacts: row.artifacts,
  });
}

function sha256(bytes: readonly number[]): string {
  return createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
}

async function clearLease(
  pool: InstanceType<typeof pg.Pool>,
  intentId: string,
): Promise<void> {
  const result = await pool.query(`UPDATE execution_intents SET
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
    WHERE id=$1`, [intentId]);
  assert.equal(result.rowCount, 1);
}

async function acceptedBuyFixture(
  pool: InstanceType<typeof pg.Pool>,
  lastValidBlockHeight = 1_000n,
) {
  const fixture = await liveFixture(pool, 60_000, 500_000n, lastValidBlockHeight);
  const live = new PostgresExecutionLiveRepository(pool);
  await live.persistSigned(Object.freeze({
    payloadVersion: 1, claim: fixture.claim,
    preSignatureLockId: fixture.preSignatureLockId,
    qualificationId: fixture.qualificationId,
    reservationId: fixture.reservationId,
    artifact: fixture.artifact,
    unsignedSimulation: fixture.unsignedSimulation,
    rpcBudget: fixture.rpcBudget,
  }));
  const signed = await live.recordSignedSimulation(
    fixture.claim,
    signedSimulationEvidence(fixture.artifact, fixture.unsignedSimulation, {
      simulationSlot: 126n, unitsConsumed: 26_000n,
      feePayerLamportDebit: 5_500n, baseDeltaRaw: 95n, quoteDeltaRaw: -1_000n,
      observedAtMs: fixture.artifact.signedAtMs + 1,
    }),
  );
  const started = await live.beginSubmission({
    claim: fixture.claim,
    artifactId: fixture.artifact.artifactId,
    expectedRevision: signed.stateRevision,
    ...submissionPreflight(fixture.artifact),
  });
  await live.recordSubmissionOutcome(fixture.claim, Object.freeze({
    payloadVersion: 1,
    artifactId: fixture.artifact.artifactId,
    expectedRevision: started.stateRevision,
    outcome: 'ACCEPTED',
    returnedSignature: fixture.artifact.signature,
    reasonCode: 'SUBMISSION_ACCEPTED',
    observedAtMs: Date.now() + 1_000,
  }));
  return Object.freeze({ ...fixture, live });
}

async function confirmedBuyReconciliationFixture(pool: InstanceType<typeof pg.Pool>) {
  const fixture = await acceptedBuyFixture(pool);
  const intents = new PostgresExecutionIntentRepository(pool);
  await clearLease(pool, fixture.claim.intent.id);
  const confirmationClaim = await intents.claim({
    ownerId: 'prepare-confirmed-buy', leaseMs: 60_000, purpose: 'CONFIRM',
  });
  assert.ok(confirmationClaim);
  const confirmation = await fixture.live.readConfirmationWork(confirmationClaim);
  await fixture.live.recordConfirmation(confirmationClaim, Object.freeze({
    payloadVersion: 1,
    artifactId: confirmation.artifactId,
    expectedRevision: confirmation.expectedRevision,
    signature: confirmation.signature,
    observedSlot: 127n,
    observedAtMs: Date.now() + 2_000,
  }));
  const claim = await intents.claim({
    ownerId: 'reconcile-confirmed-buy', leaseMs: 60_000, purpose: 'RECONCILE',
  });
  assert.ok(claim);
  return Object.freeze({ fixture, claim });
}

async function disableSignedTransactionUpdateGuards(
  pool: InstanceType<typeof pg.Pool>,
): Promise<void> {
  await pool.query(`ALTER TABLE execution_signed_transactions
    DISABLE TRIGGER execution_signed_transactions_guarded_update`);
  await pool.query(`ALTER TABLE execution_signed_transactions
    DISABLE TRIGGER execution_signed_transactions_event_required`);
  await pool.query(`ALTER TABLE execution_attempts
    DISABLE TRIGGER execution_attempt_expectation_immutable`);
}

async function openPositionFixture(pool: InstanceType<typeof pg.Pool>) {
  const fixture = await acceptedBuyFixture(pool);
  const intents = new PostgresExecutionIntentRepository(pool);
  const submittedIntent = await intents.read(fixture.claim.intent.id);
  assert.ok(submittedIntent);
  const submittedClaim = Object.freeze({ ...fixture.claim, intent: submittedIntent });
  const confirmation = await fixture.live.readConfirmationWork(submittedClaim);
  const confirmationObservedAtMs = Date.now() + 2_000;
  await fixture.live.recordConfirmation(submittedClaim, Object.freeze({
    payloadVersion: 1,
    artifactId: confirmation.artifactId,
    expectedRevision: confirmation.expectedRevision,
    signature: confirmation.signature,
    observedSlot: 127n,
    observedAtMs: confirmationObservedAtMs,
  }));
  const confirmedClaim = await intents.claim({
    ownerId: 'open-position-reconciliation', leaseMs: 60_000, purpose: 'RECONCILE',
  });
  assert.ok(confirmedClaim);
  const reconciliation = await fixture.live.readReconciliationWork(confirmedClaim);
  const evidence = evaluateExecutionReconciliation({
    expected: reconciliation.request.expected,
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
      observedAtMs: confirmationObservedAtMs + 1_000,
      finalizedAtMs: confirmationObservedAtMs + 2_000,
    }),
  });
  const committed = await fixture.live.commitReconciliation(confirmedClaim, evidence);
  assert.equal(committed.result, 'MATCHED');
  assert.ok(committed.position);
  return Object.freeze({ ...fixture, position: committed.position });
}

function deadlineClockRepository(
  pool: InstanceType<typeof pg.Pool>,
  deadlineClockMs: number,
  options: Readonly<{
    readonly queries?: string[];
    readonly failFirstCommitAfterSuccess?: boolean;
    readonly onCandidateSelected?: () => void;
  }> = {},
): PostgresExecutionLiveRepository {
  let failCommit = options.failFirstCommitAfterSuccess === true;
  return new PostgresExecutionLiveRepository({
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text: string, values?: readonly unknown[]) => {
          options.queries?.push(text);
          if (text.includes('execution_live_deadline_clock')) {
            return { rows: [{ deadline_clock_ms: String(deadlineClockMs) }], rowCount: 1 };
          }
          const result = await client.query(text, values as unknown[] | undefined);
          if (text.includes('ORDER BY position.exit_deadline_at ASC,position.position_id ASC LIMIT 1')
            && result.rows.length === 1) options.onCandidateSelected?.();
          if (text === 'COMMIT' && failCommit) {
            failCommit = false;
            throw new Error('simulated deadline commit acknowledgement loss');
          }
          return {
            rows: result.rows as readonly Readonly<Record<string, unknown>>[],
            rowCount: result.rowCount,
          };
        },
        release: (error?: boolean) => { client.release(error); },
      };
    },
  });
}

async function databaseNowMs(pool: InstanceType<typeof pg.Pool>): Promise<number> {
  const result = await pool.query<{ readonly now_ms: string }>(`SELECT
    trunc(EXTRACT(EPOCH FROM date_trunc('milliseconds',statement_timestamp()))*1000)::TEXT
      AS now_ms`);
  const nowMs = Number(result.rows[0]?.now_ms);
  assert.ok(Number.isSafeInteger(nowMs));
  return nowMs;
}

async function makePositionDue(
  pool: InstanceType<typeof pg.Pool>,
  positionId: string,
): Promise<number> {
  const dueAtMs = (await databaseNowMs(pool)) - 60_000;
  await setPositionDeadline(pool, positionId, dueAtMs);
  return dueAtMs;
}

async function setPositionDeadline(
  pool: InstanceType<typeof pg.Pool>,
  positionId: string,
  deadlineAtMs: number,
): Promise<void> {
  await pool.query(`ALTER TABLE execution_live_positions
    DISABLE TRIGGER execution_live_positions_guarded_update`);
  const updated = await pool.query(`UPDATE execution_live_positions SET
    opened_at=TIMESTAMPTZ 'epoch'+(($2::BIGINT-maximum_holding_ms)*INTERVAL '1 millisecond'),
    exit_deadline_at=TIMESTAMPTZ 'epoch'+($2::BIGINT*INTERVAL '1 millisecond')
    WHERE position_id=$1`, [positionId, deadlineAtMs]);
  assert.equal(updated.rowCount, 1);
}

function deferred<TValue>(): Readonly<{
  readonly promise: Promise<TValue>;
  readonly resolve: (value: TValue) => void;
}> {
  let resolvePromise: ((value: TValue) => void) | undefined;
  const promise = new Promise<TValue>((resolve) => { resolvePromise = resolve; });
  return Object.freeze({
    promise,
    resolve: (value: TValue) => {
      assert.ok(resolvePromise !== undefined);
      resolvePromise(value);
    },
  });
}

function safetyQualification(
  nowMs: number,
  simulation: Awaited<ReturnType<typeof seedSuccessfulSimulation>>,
  qualifiedWalletPublicKey = walletPublicKey,
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
    strategyFingerprint: '3'.repeat(64), generationId, walletPublicKey: qualifiedWalletPublicKey,
    cluster: 'mainnet-beta', genesisHash: qualifiedWalletPublicKey, providerId: 'primary',
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
          strategyFingerprint: '3'.repeat(64), walletPublicKey: qualifiedWalletPublicKey,
          genesisHash: qualifiedWalletPublicKey, providerId: 'primary',
        }) : index.toString(16).repeat(64),
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
    payloadVersion: template.payloadVersion, evaluatorVersion: template.evaluatorVersion,
    phase: template.phase, buildHash: template.buildHash,
    configurationFingerprint: template.configurationFingerprint,
    strategyFingerprint: template.strategyFingerprint, generationId: template.generationId,
    walletPublicKey: template.walletPublicKey, cluster: template.cluster,
    genesisHash: template.genesisHash, providerId: template.providerId,
    qualifiedAtMs: template.qualifiedAtMs, expiresAtMs: template.expiresAtMs,
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

async function seedSuccessfulSimulation(
  pool: InstanceType<typeof pg.Pool>,
  simulationWalletPublicKey = walletPublicKey,
) {
  const nowMs = Date.now();
  const intents = new PostgresExecutionIntentRepository(pool);
  const created = await intents.create(createExecutionIntentDraft({
    strategyId: 'simulation-strategy', strategyVersion: 1,
    positionId: `position-${randomUUID()}`, logicalCommandId: `command-${randomUUID()}`,
    mint: simulationWalletPublicKey, side: 'BUY', venuePolicy: 'PUMP_FUN_ONLY', quoteMint,
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
    executorPublicKey: simulationWalletPublicKey, expectedGenesisHash: simulationWalletPublicKey,
    observedGenesisHash: simulationWalletPublicKey, configurationFingerprint: fingerprint,
    quoteFingerprint: fingerprint, snapshotFingerprint: fingerprint,
    buildFingerprint: fingerprint, messageHash: fingerprint, blockhash: simulationWalletPublicKey,
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

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
