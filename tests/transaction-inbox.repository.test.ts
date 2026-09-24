import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import { TransactionInboxWorker } from '../src/application/transaction-inbox-worker.js';
import { PersistentListenerHeartbeat } from '../src/application/production-listener-factory.js';
import { createRpcHttpEvidenceRecorder } from '../src/solana/rpc/rpc-http-evidence.js';
import { createPumpDecodingError, PUMP_DECODING_ERROR_CODES } from '../src/launchpads/pumpfun/errors.js';
import { createPumpSwapDecodingError, PUMPSWAP_DECODING_ERROR_CODES } from '../src/markets/pumpswap/errors.js';
import { failurePipeline, failureTransaction, realPumpPipeline, malformedPumpTransaction } from './observed-pipeline-failure-fixtures.js';
import pg from 'pg';
import { CatchUpScanner } from '../src/application/catch-up-scanner.js';
import { FinalityReconciler } from '../src/application/finality-reconciler.js';
import { createCatchUpClassification } from '../src/domain/catch-up-classification.js';
import type {
  IngestionFailure,
  FinalityCandidate,
  ProcessingCheckpoint,
  RuntimeHeartbeat,
  TransactionNotification,
} from '../src/domain/transaction-ingestion.js';
import type { NormalizedTransaction } from '../src/solana/rpc/types.js';
import {
  createCatchUpGap,
  MAX_FINALITY_EVIDENCE_VERSION,
  restoreNormalizedTransactionSnapshot,
} from '../src/domain/transaction-ingestion.js';
import {
  createStrictCatchUpFailure,
  type StrictCatchUpFailure,
} from '../src/domain/strict-catch-up.js';
import {
  advanceStrictCatchUpRun,
  createStrictCatchUpRun,
  terminalizeStrictCatchUpRun,
  type StrictCatchUpRun,
} from '../src/domain/strict-catch-up-run.js';
import type { StrictCatchUpRepository } from '../src/ports/strict-catch-up-repository.js';
import type { CatchUpAdmissionCoverageCandidate } from '../src/ports/catch-up-admission-coverage-repository.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import {
  PostgresTransactionInboxRepository,
  TransactionInboxConflictError,
  TransactionInboxLeaseError,
  TransactionInboxRepositoryError,
} from '../src/storage/transaction-inbox.repository.js';
import {
  FIRST_PROCESSING_COHORT_CAPACITY,
  FIRST_PROCESSING_COHORT_DURATION_MS,
  FIRST_PROCESSING_THRESHOLD_MS,
  createFirstProcessingCanaryEvidence,
} from '../src/domain/first-processing-canary.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const tradeMint = 'So11111111111111111111111111111111111111112';

void test('schedules one retained worker decoder quarantine from its immutable snapshot', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool, Object.freeze({
      maxAttempts: 5, baseDelayMs: 60_000,
    }));
    const signature = 'decoder-quarantine-scheduled';
    await repository.enqueue(notification(signature, 901n, 'WEBSOCKET', 'confirmed'));
    const claimed = await repository.claim(Date.now(), 30);
    assert.ok(claimed);
    await repository.saveSnapshot(signature, claimed.leaseToken, normalized(signature, 901n));
    await repository.markFailed(signature, claimed.leaseToken, Object.freeze({
      code: 'PIPELINE_STAGE_FAILED',
      errorName: 'ObservedPipelineFailure.v1.launchpad_observation.PUMP_SCHEMA_UNSUPPORTED',
      retryable: false,
    }));
    const quarantined = await row(pool, signature);
    assert.equal(quarantined.processing_status, 'FAILED');
    assert.equal(await repository.claim(Date.now() + 1, 30), null);

    assert.deepEqual(await repository.recoverDecoderQuarantine(signature), {
      code: 'DECODER_RECOVERY_SCHEDULED', signature,
    });

    const recovered = await row(pool, signature);
    assert.equal(recovered.processing_status, 'PENDING');
    assert.equal(recovered.attempts, quarantined.attempts);
    assert.equal(recovered.attempts_in_cycle, 0);
    assert.deepEqual(recovered.normalized_transaction, quarantined.normalized_transaction);
    assert.equal(recovered.immutable_fingerprint, quarantined.immutable_fingerprint);
    assert.equal(recovered.observed_slot, quarantined.observed_slot);
    assert.deepEqual(recovered.discovery_sources, quarantined.discovery_sources);
    assert.deepEqual(recovered.program_ids, quarantined.program_ids);
    assert.equal(recovered.target_confirmation_status, quarantined.target_confirmation_status);
    assert.equal(recovered.observed_at.getTime(), quarantined.observed_at.getTime());
    assert.equal(recovered.first_detected_at.getTime(), quarantined.first_detected_at.getTime());
    assert.equal(recovered.first_processed_at, quarantined.first_processed_at);
    assert.equal(recovered.first_processing_evidence_unavailable,
      quarantined.first_processing_evidence_unavailable);
    for (const field of ['lease_token', 'lease_expires_at', 'error_code', 'error_name',
      'error_retryable', 'next_attempt_at', 'retry_exhausted_at', 'processed_at',
      'terminal_at', 'purge_after'] as const) {
      assert.equal(recovered[field], null, field);
    }
    assert.equal(recovered.manual_recovery_count, 1);
    assert.ok(recovered.last_manual_recovery_at instanceof Date);
    assert.equal(recovered.decoder_recovery_used, true);
    const receipt = (await pool.query(
      'SELECT * FROM transaction_inbox_decoder_recoveries WHERE signature=$1', [signature],
    )).rows[0];
    assert.deepEqual({
      signature: receipt?.signature,
      kind: receipt?.quarantine_kind,
      reason: receipt?.worker_reason_code,
      fingerprint: receipt?.snapshot_fingerprint,
      quarantinedAt: receipt?.quarantined_at?.getTime(),
      recoveredAt: receipt?.recovered_at?.getTime(),
      source: receipt?.recovery_source,
      retentionMs: receipt?.purge_after?.getTime() - receipt?.recovered_at?.getTime(),
    }, {
      signature, kind: 'WORKER_SNAPSHOT', reason: 'PUMP_SCHEMA_UNSUPPORTED',
      fingerprint: quarantined.immutable_fingerprint,
      quarantinedAt: quarantined.terminal_at.getTime(),
      recoveredAt: recovered.last_manual_recovery_at.getTime(),
      source: 'LOCAL_CLI', retentionMs: 14_400_000,
    });
  });
});

void test('serializes concurrent decoder recoveries and makes every replay idempotent', async (context) => {
  await withDatabase(context, async (pool) => {
    const signature = 'decoder-quarantine-concurrent';
    const firstRepository = new PostgresTransactionInboxRepository(pool);
    const staleToken = await storeWorkerDecoderQuarantine(
      firstRepository, signature, 902n, 'PUMP_BORSH_TRUNCATED',
    );
    const secondRepository = new PostgresTransactionInboxRepository(pool);

    const results = await Promise.all([
      firstRepository.recoverDecoderQuarantine(signature),
      secondRepository.recoverDecoderQuarantine(signature),
    ]);
    assert.deepEqual(results.map((result) => result.code).sort(), [
      'DECODER_RECOVERY_ALREADY_SCHEDULED', 'DECODER_RECOVERY_SCHEDULED',
    ]);
    assert.deepEqual(await firstRepository.recoverDecoderQuarantine(signature), {
      code: 'DECODER_RECOVERY_ALREADY_SCHEDULED', signature,
    });
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM transaction_inbox_decoder_recoveries WHERE signature=$1',
      [signature],
    )).rows[0]?.count, 1);
    assert.equal((await row(pool, signature)).manual_recovery_count, 1);
    const claimed = await firstRepository.claim(Date.now(), 30);
    assert.equal(claimed?.signature, signature);
    assert.deepEqual(await secondRepository.recoverDecoderQuarantine(signature), {
      code: 'DECODER_RECOVERY_ALREADY_SCHEDULED', signature,
    });
    await assert.rejects(firstRepository.markFailed(signature, staleToken, Object.freeze({
      code: 'PIPELINE_STAGE_FAILED',
      errorName: 'ObservedPipelineFailure.v1.launchpad_observation.PUMP_BORSH_TRUNCATED',
      retryable: false,
    })), TransactionInboxLeaseError);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM transaction_inbox_decoder_recoveries WHERE signature=$1',
      [signature],
    )).rows[0]?.count, 1);
  });
});

void test('keeps decoder recovery idempotent after worker completion and receipt expiry', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const signature = 'decoder-quarantine-durable-idempotency';
    await storeWorkerDecoderQuarantine(
      repository, signature, 9021n, 'PUMP_SCHEMA_UNSUPPORTED',
    );
    assert.deepEqual(await repository.recoverDecoderQuarantine(signature), {
      code: 'DECODER_RECOVERY_SCHEDULED', signature,
    });
    const claimed = await repository.claim(Date.now(), 30);
    assert.equal(claimed?.signature, signature);
    await repository.markProcessed(signature, claimed.leaseToken, 'confirmed');
    assert.deepEqual(await repository.recoverDecoderQuarantine(signature), {
      code: 'DECODER_RECOVERY_ALREADY_SCHEDULED', signature,
    });

    await pool.query(`WITH expiry AS MATERIALIZED (
      SELECT date_trunc('milliseconds',clock_timestamp()) AS at
    ) UPDATE transaction_inbox_decoder_recoveries SET
      quarantined_at=expiry.at-INTERVAL '4 hours',
      recovered_at=expiry.at-INTERVAL '4 hours',
      purge_after=expiry.at
      FROM expiry WHERE signature=$1`, [signature]);
    assert.equal((await purgeExpiredFoundationData(pool)).transactionInboxDecoderRecoveries, 1);
    assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER AS count
      FROM transaction_inbox_decoder_recoveries WHERE signature=$1`, [signature])).rows[0]?.count, 0);

    await repository.enqueueRevision(Object.freeze({
      signature, confirmationStatus: 'finalized', observedAtMs: Date.now() + 1,
    }));
    const replay = await repository.claim(Date.now() + 2, 30);
    assert.equal(replay?.signature, signature);
    await repository.markFailed(signature, replay.leaseToken, Object.freeze({
      code: 'PIPELINE_STAGE_FAILED',
      errorName: 'ObservedPipelineFailure.v1.launchpad_observation.PUMP_SCHEMA_UNSUPPORTED',
      retryable: false,
    }));
    const failed = await row(pool, signature);
    assert.equal(failed.decoder_quarantine_eligible_at, null);
    assert.equal(failed.decoder_recovery_used, true);
    assert.equal((await repository.counts()).decoderQuarantinedCount, 0);
    assert.deepEqual(await repository.recoverDecoderQuarantine(signature), {
      code: 'DECODER_RECOVERY_ALREADY_SCHEDULED', signature,
    });
    await assert.rejects(
      pool.query(`UPDATE chain_transaction_inbox
        SET decoder_recovery_used=FALSE WHERE signature=$1`, [signature]),
      { code: '23514' },
    );
  });
});

void test('samples decoder recovery time only after the row lock and rejects a crossed deadline', async (context) => {
  await withDatabase(context, async (pool) => {
    const signature = 'decoder-quarantine-lock-deadline';
    const repository = new PostgresTransactionInboxRepository(pool);
    await storeWorkerDecoderQuarantine(
      repository, signature, 903n, 'PUMP_SCHEMA_UNSUPPORTED',
    );
    await pool.query(`WITH boundary AS MATERIALIZED (
      SELECT date_trunc('milliseconds',clock_timestamp())+INTERVAL '250 milliseconds' AS at
    ) UPDATE chain_transaction_inbox SET
      terminal_at=boundary.at-INTERVAL '4 hours',purge_after=boundary.at
      FROM boundary WHERE signature=$1`, [signature]);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT signature FROM chain_transaction_inbox WHERE signature=$1 FOR UPDATE',
        [signature],
      );
      const recovery = repository.recoverDecoderQuarantine(signature);
      await waitForActiveLockWait(pool, 'FROM chain_transaction_inbox inbox');
      await pool.query("SELECT pg_sleep(0.3)");
      await blocker.query('COMMIT');

      assert.deepEqual(await settlesWithin(recovery, 2_000), {
        code: 'DECODER_RECOVERY_EXPIRED', signature,
      });
      assert.equal((await row(pool, signature)).processing_status, 'FAILED');
      assert.equal((await pool.query(
        'SELECT COUNT(*)::INTEGER AS count FROM transaction_inbox_decoder_recoveries WHERE signature=$1',
        [signature],
      )).rows[0]?.count, 0);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
});

void test('fails closed for every non-worker, malformed, processed, retryable and expired state', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool, Object.freeze({
      maxAttempts: 5, baseDelayMs: 60_000,
    }));
    assert.deepEqual(await repository.recoverDecoderQuarantine('decoder-missing'), {
      code: 'DECODER_RECOVERY_NOT_FOUND', signature: 'decoder-missing',
    });
    const failures = [
      ['decoder-ordinary', 'NORMALIZATION_FAILED', 'TypeError', false],
      ['decoder-invalid', 'PIPELINE_STAGE_FAILED',
        'ObservedPipelineFailure.v1.launchpad_observation.PUMP_BORSH_INVALID', false],
      ['decoder-retryable', 'RPC_TRANSIENT', 'RpcError', true],
    ] as const;
    for (const [index, [signature, code, errorName, retryable]] of failures.entries()) {
      await repository.enqueue(notification(signature, 910n + BigInt(index), 'WEBSOCKET', 'confirmed'));
      const claimed = await repository.claim(Date.now(), 30);
      assert.ok(claimed);
      await repository.saveSnapshot(signature, claimed.leaseToken, normalized(signature, claimed.slot));
      await repository.markFailed(signature, claimed.leaseToken, Object.freeze({
        code, errorName, retryable,
      }));
    }
    await repository.enqueue(notification('decoder-processed', 913n, 'WEBSOCKET', 'confirmed'));
    const processed = await repository.claim(Date.now(), 30);
    assert.ok(processed);
    await repository.saveSnapshot(
      'decoder-processed', processed.leaseToken, normalized('decoder-processed', 913n),
    );
    await repository.markProcessed('decoder-processed', processed.leaseToken, 'confirmed');
    await storeWorkerDecoderQuarantine(
      repository, 'decoder-expired', 914n, 'PUMP_SCHEMA_UNSUPPORTED',
    );
    await pool.query(`UPDATE chain_transaction_inbox SET
      terminal_at=date_trunc('milliseconds',clock_timestamp()-INTERVAL '4 hours'),
      purge_after=date_trunc('milliseconds',clock_timestamp())
      WHERE signature='decoder-expired'`);
    await storeWorkerDecoderQuarantine(
      repository, 'decoder-malformed', 915n, 'PUMP_SCHEMA_UNSUPPORTED',
    );
    await pool.query(
      "UPDATE chain_transaction_inbox SET normalized_transaction='{}'::jsonb WHERE signature='decoder-malformed'",
    );
    await storeWorkerDecoderQuarantine(
      repository, 'decoder-missing-snapshot', 916n, 'PUMP_SCHEMA_UNSUPPORTED',
    );
    await storeWorkerDecoderQuarantine(
      repository, 'decoder-missing-fingerprint', 917n, 'PUMP_SCHEMA_UNSUPPORTED',
    );
    await pool.query(
      'ALTER TABLE chain_transaction_inbox DROP CONSTRAINT chain_transaction_inbox_snapshot_check',
    );
    await pool.query(`UPDATE chain_transaction_inbox SET
      normalized_transaction=NULL,immutable_fingerprint=NULL
      WHERE signature='decoder-missing-snapshot'`);
    await pool.query(`UPDATE chain_transaction_inbox SET immutable_fingerprint=NULL
      WHERE signature='decoder-missing-fingerprint'`);

    for (const signature of ['decoder-ordinary', 'decoder-invalid', 'decoder-retryable',
      'decoder-processed', 'decoder-malformed', 'decoder-missing-snapshot',
      'decoder-missing-fingerprint'] as const) {
      const before = await recoveryState(pool, signature);
      assert.deepEqual(await repository.recoverDecoderQuarantine(signature), {
        code: 'DECODER_RECOVERY_NOT_ELIGIBLE', signature,
      });
      assert.deepEqual(await recoveryState(pool, signature), before);
    }
    const expiredBefore = await recoveryState(pool, 'decoder-expired');
    assert.deepEqual(await repository.recoverDecoderQuarantine('decoder-expired'), {
      code: 'DECODER_RECOVERY_EXPIRED', signature: 'decoder-expired',
    });
    assert.deepEqual(await recoveryState(pool, 'decoder-expired'), expiredBefore);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM transaction_inbox_decoder_recoveries',
    )).rows[0]?.count, 0);
  });
});

void test('rejects every catch-up PUMP_SCHEMA_UNSUPPORTED origin without changing its evidence', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    for (const [signature, fingerprint] of [
      ['catch-up-decoder-origin', 'a'.repeat(64)],
      ['catch-up-normalization-origin', 'b'.repeat(64)],
      ['catch-up-multi-mint-origin', 'c'.repeat(64)],
      ['catch-up-overflow-origin', 'd'.repeat(64)],
    ] as const) {
      await repository.recordCatchUpClassification(createCatchUpClassification({
        ...catchUpClassificationInput(signature),
        disposition: 'QUARANTINED', reasonCode: 'PUMP_SCHEMA_UNSUPPORTED',
        ingestionHint: null, ingestionHintMint: null, mints: [],
        evidenceFingerprint: fingerprint,
      }));
      const before = await row(pool, signature);
      assert.deepEqual(await repository.recoverDecoderQuarantine(signature), {
        code: 'DECODER_RECOVERY_NOT_ELIGIBLE', signature,
      });
      assert.deepEqual(await row(pool, signature), before);
    }
  });
});

void test('rediscovery and finality attempts never extend a worker quarantine deadline', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const signature = 'decoder-quarantine-interactions';
    await storeWorkerDecoderQuarantine(
      repository, signature, 918n, 'PUMP_SCHEMA_UNSUPPORTED',
    );
    const initial = await row(pool, signature);
    await repository.enqueue(notification(
      signature, 918n, 'CATCH_UP', 'finalized', Date.now() + 1,
    ));
    const rediscovered = await row(pool, signature);
    assert.equal(rediscovered.terminal_at.getTime(), initial.terminal_at.getTime());
    assert.equal(rediscovered.purge_after.getTime(), initial.purge_after.getTime());
    await repository.recordCatchUpClassification(createCatchUpClassification({
      ...catchUpClassificationInput(signature), slot: 918n,
    }));
    const classified = await row(pool, signature);
    assert.equal(classified.processing_status, 'FAILED');
    assert.equal(classified.terminal_at.getTime(), initial.terminal_at.getTime());
    assert.equal(classified.purge_after.getTime(), initial.purge_after.getTime());
    await assert.rejects(repository.enqueueRevision(Object.freeze({
      signature, confirmationStatus: 'finalized', observedAtMs: Date.now() + 2,
    })), TransactionInboxConflictError);
    const afterFinality = await row(pool, signature);
    assert.equal(afterFinality.terminal_at.getTime(), initial.terminal_at.getTime());
    assert.equal(afterFinality.purge_after.getTime(), initial.purge_after.getTime());

    assert.deepEqual(await repository.recoverDecoderQuarantine(signature), {
      code: 'DECODER_RECOVERY_SCHEDULED', signature,
    });
    const recovered = await row(pool, signature);
    assert.equal(recovered.target_confirmation_status, 'finalized');
    assert.equal(recovered.catch_up_disposition, 'ACTIONABLE');
    assert.equal(recovered.catch_up_evidence_fingerprint, classified.catch_up_evidence_fingerprint);
  });
});

void test('purges decoder recovery receipts at their own exact deadline without deleting inbox work', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(notification('receipt-boundary', 920n, 'WEBSOCKET', 'confirmed'));
    await pool.query(`WITH purge_clock AS MATERIALIZED (
      SELECT date_trunc('milliseconds',clock_timestamp()) AS at
    ) INSERT INTO transaction_inbox_decoder_recoveries (
      signature,quarantine_kind,worker_reason_code,snapshot_fingerprint,
      quarantined_at,recovered_at,recovery_source,purge_after
    ) SELECT 'receipt-boundary','WORKER_SNAPSHOT','PUMP_SCHEMA_UNSUPPORTED',repeat('a',64),
      at-INTERVAL '4 hours',at-INTERVAL '4 hours','LOCAL_CLI',at FROM purge_clock`);
    await pool.query(`WITH retained_clock AS MATERIALIZED (
      SELECT date_trunc('milliseconds',clock_timestamp()) AS at
    ) INSERT INTO transaction_inbox_decoder_recoveries (
      signature,quarantine_kind,worker_reason_code,snapshot_fingerprint,
      quarantined_at,recovered_at,recovery_source,purge_after
    ) SELECT 'receipt-retained','WORKER_SNAPSHOT','PUMP_BORSH_TRUNCATED',repeat('b',64),
      at,at,'LOCAL_CLI',at+INTERVAL '4 hours' FROM retained_clock`);

    const purged = await purgeExpiredFoundationData(pool);

    assert.equal(purged.transactionInboxDecoderRecoveries, 1);
    assert.deepEqual((await pool.query(
      'SELECT signature FROM transaction_inbox_decoder_recoveries ORDER BY signature',
    )).rows, [{ signature: 'receipt-retained' }]);
    assert.equal((await row(pool, 'receipt-boundary')).processing_status, 'PENDING');
  });
});

void test('heartbeat persists a detached first processing canary snapshot and rejects malformed evidence before I/O', async () => {
  const queryCalls: unknown[][] = [];
  const repository = new PostgresTransactionInboxRepository({
    async query(_text, values) {
      queryCalls.push(values === undefined ? [] : [...values]);
      return { rows: [], rowCount: 1 };
    },
    async connect() { throw new Error('not used'); },
  });
  const owned = Object.freeze({ ...firstProcessingHeartbeatEvidence() });
  const heartbeat: RuntimeHeartbeat = Object.freeze({
    runtimeState: 'RUNNING', subscriberState: 'RUNNING', scannerState: 'RUNNING',
    workerState: 'RUNNING', reconcilerState: 'RUNNING', startedAtMs: 1_000,
    updatedAtMs: 2_000, lastHttpSlot: null, lastWebsocketSlot: null,
    lastFinalizedSlot: null, lastSignature: null, backlogCount: 0, leasedCount: 0,
    exhaustedCount: 0, firstProcessingCanary: owned,
  });
  await repository.writeHeartbeat(heartbeat);
  assert.equal(queryCalls.length, 1);
  assert.deepEqual(queryCalls[0]?.[14], {
    startedAt: '1970-01-01T00:00:01.000Z',
    firstProcessingCanary: firstProcessingHeartbeatEvidence(),
  });
  const { firstProcessingCanary: omitted, ...legacy } = heartbeat;
  assert.ok(omitted);
  await repository.writeHeartbeat(Object.freeze({ ...legacy, updatedAtMs: 3_000 }));
  assert.deepEqual(queryCalls[1]?.[14], { startedAt: '1970-01-01T00:00:01.000Z' });
  await assert.rejects(repository.writeHeartbeat(Object.freeze({
    ...heartbeat,
    updatedAtMs: 4_000,
    firstProcessingCanary: new Proxy(firstProcessingHeartbeatEvidence(), {}),
  })), TransactionInboxRepositoryError);
  assert.equal(queryCalls.length, 2);
});

function firstProcessingHeartbeatEvidence() {
  return createFirstProcessingCanaryEvidence({
    version: 1, thresholdMs: 45_000, cohortCapacity: 50_000,
    cohortStartedAtMs: 1_000, cohortEndsAtMs: 901_000, sampledAtMs: 946_000,
    overflowed: false, eligibleCount: 0, completedCount: 0, underThresholdCount: 0,
    atOrAboveThresholdCount: 0, pendingCount: 0, rightCensoredCount: 0, tailCensoredCount: 0,
    terminalCount: 0, unavailableCount: 0, invalidDurationCount: 0, p95Ms: null,
    verdict: 'INCONCLUSIVE',
  });
}

void test('first processing time survives lease loss, finality replay, orphaning, and exhausted recovery', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool, Object.freeze({
      maxAttempts: 1, baseDelayMs: 500,
    }));
    const signature = 'first-processing-finality';
    await repository.enqueue(notification(signature, 801n, 'WEBSOCKET', 'confirmed'));
    const initial = await repository.claim(Date.now(), 30);
    assert.ok(initial);
    await assert.rejects(repository.markProcessed(signature, 'lost-lease', 'confirmed'), TransactionInboxLeaseError);
    assert.equal((await row(pool, signature)).first_processed_at, null);
    await repository.saveSnapshot(signature, initial.leaseToken, normalized(signature, 801n));
    await repository.markProcessed(signature, initial.leaseToken, 'confirmed');
    const firstCompleted = new Date((await row(pool, signature)).first_processed_at).getTime();
    const completed = new Date((await row(pool, signature)).processed_at).getTime();
    assert.equal(firstCompleted, completed);
    assert.equal(Number.isSafeInteger(firstCompleted), true);

    await repository.enqueueRevision(Object.freeze({
      signature, confirmationStatus: 'finalized', observedAtMs: Date.now() + 1,
    }));
    const finalityReplay = await repository.claim(Date.now() + 2, 30);
    assert.ok(finalityReplay);
    await repository.markProcessed(signature, finalityReplay.leaseToken, 'finalized');
    assert.equal(new Date((await row(pool, signature)).first_processed_at).getTime(), firstCompleted);

    const orphanSignature = 'first-processing-orphan';
    await repository.enqueue(notification(orphanSignature, 803n, 'WEBSOCKET', 'confirmed'));
    const orphanInitial = await repository.claim(Date.now() + 3, 30);
    assert.ok(orphanInitial);
    await repository.saveSnapshot(orphanSignature, orphanInitial.leaseToken, normalized(orphanSignature, 803n));
    await repository.markProcessed(orphanSignature, orphanInitial.leaseToken, 'confirmed');
    const orphanFirstCompleted = new Date((await row(pool, orphanSignature)).first_processed_at).getTime();
    const orphanProof = await repository.recordFinalityPoll(Object.freeze({
      signature: orphanSignature, confirmationStatus: null, providerId: 'primary' as const,
      expectedMissingFinalityPolls: 0, expectedLastMissingFinalityProviderId: null,
      expectedFinalityEvidenceVersion: 0n, observedAtMs: Date.now() + 4,
    }));
    if (orphanProof.lastMissingFinalityProviderId === null) throw new Error('Expected orphan proof provider.');
    await repository.enqueueRevision(Object.freeze({
      signature: orphanSignature, confirmationStatus: 'orphaned' as const,
      expectedConfirmationStatus: orphanProof.confirmationStatus,
      expectedMissingFinalityPolls: orphanProof.missingFinalityPolls,
      expectedLastMissingFinalityProviderId: orphanProof.lastMissingFinalityProviderId,
      expectedFinalityEvidenceVersion: orphanProof.finalityEvidenceVersion,
      observedAtMs: Date.now() + 5,
    }));
    assert.equal(new Date((await row(pool, orphanSignature)).first_processed_at).getTime(), orphanFirstCompleted);
    const orphanReplay = await repository.claim(Date.now() + 6, 30);
    assert.ok(orphanReplay);
    await repository.markProcessed(orphanSignature, orphanReplay.leaseToken, 'orphaned');
    assert.equal(new Date((await row(pool, orphanSignature)).first_processed_at).getTime(), orphanFirstCompleted);

    const recoverySignature = 'first-processing-recovery';
    await repository.enqueue(notification(recoverySignature, 802n, 'WEBSOCKET', 'confirmed'));
    const recoveryInitial = await repository.claim(Date.now() + 3, 30);
    assert.ok(recoveryInitial);
    await repository.saveSnapshot(recoverySignature, recoveryInitial.leaseToken, normalized(recoverySignature, 802n));
    await repository.markProcessed(recoverySignature, recoveryInitial.leaseToken, 'confirmed');
    const recoveryFirstCompleted = new Date((await row(pool, recoverySignature)).first_processed_at).getTime();
    await repository.enqueueRevision(Object.freeze({
      signature: recoverySignature, confirmationStatus: 'finalized', observedAtMs: Date.now() + 4,
    }));
    const failedReplay = await repository.claim(Date.now() + 5, 30);
    assert.ok(failedReplay);
    await repository.markFailed(recoverySignature, failedReplay.leaseToken, Object.freeze({
      code: 'RPC_TRANSIENT', errorName: 'RpcError', retryable: true,
    }));
    assert.deepEqual(await repository.recoverExhausted(recoverySignature), {
      code: 'RECOVERY_SCHEDULED', signature: recoverySignature,
    });
    assert.equal((await row(pool, recoverySignature)).processed_at, null);
    assert.equal(new Date((await row(pool, recoverySignature)).first_processed_at).getTime(), recoveryFirstCompleted);
    const recovered = await repository.claim(Date.now() + 6, 30);
    assert.ok(recovered);
    if (recovered.normalizedTransaction === null) {
      await repository.saveSnapshot(recoverySignature, recovered.leaseToken, normalized(recoverySignature, 802n));
    }
    await repository.markProcessed(recoverySignature, recovered.leaseToken, 'finalized');
    assert.equal(new Date((await row(pool, recoverySignature)).first_processed_at).getTime(), recoveryFirstCompleted);

    const automaticRetryRepository = new PostgresTransactionInboxRepository(pool, Object.freeze({
      maxAttempts: 2, baseDelayMs: 1,
    }));
    const automaticRetrySignature = 'first-processing-automatic-retry';
    await automaticRetryRepository.enqueue(notification(automaticRetrySignature, 804n, 'WEBSOCKET', 'confirmed'));
    const automaticInitial = await automaticRetryRepository.claim(Date.now() + 7, 30);
    assert.ok(automaticInitial);
    await automaticRetryRepository.saveSnapshot(
      automaticRetrySignature, automaticInitial.leaseToken, normalized(automaticRetrySignature, 804n),
    );
    await automaticRetryRepository.markProcessed(automaticRetrySignature, automaticInitial.leaseToken, 'confirmed');
    const automaticFirstCompleted = new Date((await row(pool, automaticRetrySignature)).first_processed_at).getTime();
    await automaticRetryRepository.enqueueRevision(Object.freeze({
      signature: automaticRetrySignature, confirmationStatus: 'finalized', observedAtMs: Date.now() + 8,
    }));
    const automaticFailedReplay = await automaticRetryRepository.claim(Date.now() + 9, 30);
    assert.ok(automaticFailedReplay);
    await automaticRetryRepository.markFailed(automaticRetrySignature, automaticFailedReplay.leaseToken, Object.freeze({
      code: 'RPC_TRANSIENT', errorName: 'RpcError', retryable: true,
    }));
    const automaticRetryAt = new Date((await row(pool, automaticRetrySignature)).next_attempt_at).getTime();
    const automaticRetry = await automaticRetryRepository.claim(automaticRetryAt + 1, 30);
    assert.ok(automaticRetry);
    if (automaticRetry.normalizedTransaction === null) {
      await automaticRetryRepository.saveSnapshot(
        automaticRetrySignature, automaticRetry.leaseToken, normalized(automaticRetrySignature, 804n),
      );
    }
    await automaticRetryRepository.markProcessed(automaticRetrySignature, automaticRetry.leaseToken, 'finalized');
    const automaticRetryStored = await row(pool, automaticRetrySignature);
    assert.equal(new Date(automaticRetryStored.first_processed_at).getTime(), automaticFirstCompleted);
  });
});

void test('markProcessed preserves a microsecond updated_at later within the completion millisecond', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const signature = 'first-processing-microsecond-updated-at';
    await repository.enqueue(notification(signature, 805n, 'WEBSOCKET', 'confirmed'));
    const claim = await repository.claim(Date.now(), 30);
    assert.ok(claim);
    await repository.saveSnapshot(signature, claim.leaseToken, normalized(signature, 805n));

    const schema = (await pool.query<{ readonly schema_name: unknown }>(
      'SELECT current_schema() AS schema_name',
    )).rows[0]?.schema_name;
    assert.equal(typeof schema, 'string');
    if (typeof schema !== 'string') throw new TypeError('Expected an isolated test schema.');
    const completedAtMs = Date.now() + 60_000;
    const completedAt = new Date(completedAtMs).toISOString();
    const updatedAt = `${completedAt.slice(0, -1).replace(/\.\d{3}$/u, `.${String(completedAtMs % 1_000).padStart(3, '0')}500`)}Z`;
    await pool.query(`UPDATE chain_transaction_inbox SET updated_at=$2::TIMESTAMPTZ
      WHERE signature=$1`, [signature, updatedAt]);
    await pool.query(`CREATE FUNCTION ${quoteIdentifier(schema)}.clock_timestamp()
      RETURNS TIMESTAMPTZ LANGUAGE SQL IMMUTABLE
      AS $$ SELECT TIMESTAMPTZ '${completedAt}' $$`);
    await pool.query(`SET search_path = ${quoteIdentifier(schema)}, pg_catalog`);

    await repository.markProcessed(signature, claim.leaseToken, 'confirmed');
    const stored = (await pool.query(`SELECT
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
      to_char(processed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS processed_at,
      to_char(first_processed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS first_processed_at
      FROM chain_transaction_inbox WHERE signature=$1`, [signature])).rows[0];
    const expectedCompleted = `${completedAt.slice(0, -1).replace(/\.(\d{3})$/u, '.$1000')}Z`;
    assert.deepEqual(stored, { updated_at: updatedAt, processed_at: expectedCompleted,
      first_processed_at: expectedCompleted });
  });
});

void test('a partially purged four-hour cohort can never recover a PASS', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const startedAtMs = Date.now() - 14_400_000 - 1_000;
    await insertCanaryInboxRow(pool, 'canary-purged', startedAtMs, startedAtMs + 1_000, 'PROCESSED');
    await insertCanaryInboxRow(pool, 'canary-retained', startedAtMs + 1, startedAtMs + 1_001, 'PROCESSED');
    await pool.query(`UPDATE chain_transaction_inbox SET
      target_confirmation_status='finalized', terminal_at=processed_at,
      purge_after=processed_at+INTERVAL '4 hours'
      WHERE signature='canary-purged'`);
    await pool.query(`INSERT INTO chain_transaction_finality_replay_receipts (
      signature, observed_slot, confirmation_status, finality_evidence_version,
      immutable_fingerprint, replay_completed_at
    ) SELECT signature, observed_slot, target_confirmation_status,
      finality_evidence_version, immutable_fingerprint, processed_at
      FROM chain_transaction_inbox WHERE signature='canary-purged'`);

    const purged = await purgeExpiredFoundationData(pool);
    assert.equal(purged.transactionInbox, 1);
    const evidence = await repository.firstProcessingCanary(startedAtMs);
    assert.equal(evidence.eligibleCount, 1);
    assert.equal(evidence.completedCount, 1);
    assert.equal(evidence.p95Ms, 1_000);
    assert.equal(evidence.verdict, 'INCONCLUSIVE');
  });
});

void test('retention anchors post-migration classifications to durable detection time', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const classifiedAtMs = Date.now() - 14_400_001;
    const cohortStartedAtMs = await repository.beginFirstProcessingCanary();
    const classification = createCatchUpClassification({
      ...catchUpClassificationInput('canary-detection-anchored-retention'),
      observedAtMs: classifiedAtMs,
      classifiedAtMs,
      disposition: 'IGNORED',
      reasonCode: 'NO_SUPPORTED_PUMP_ACTION',
      ingestionHint: null,
      ingestionHintMint: null,
      mints: [],
    });
    await repository.recordCatchUpClassification(classification);
    const before = (await pool.query<{
      readonly first_detected_at: Date;
      readonly catch_up_classified_at: Date;
      readonly purge_after: Date;
    }>(`SELECT first_detected_at,catch_up_classified_at,purge_after
      FROM chain_transaction_inbox WHERE signature=$1`, [classification.signature])).rows[0];
    assert.ok(before);
    assert.ok(before.first_detected_at instanceof Date);
    assert.ok(before.first_detected_at.getTime() >= cohortStartedAtMs);
    assert.ok(before.catch_up_classified_at.getTime() < cohortStartedAtMs);
    assert.ok(before.purge_after.getTime() <= Date.now());
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, observed_at, first_detected_at, error_code, error_name,
      error_retryable, terminal_at, purge_after
    ) VALUES ('legacy-null-detection-retention', 2, ARRAY['CATCH_UP'], ARRAY[$1],
      'confirmed', 'FAILED', to_timestamp($2::BIGINT / 1000.0), NULL,
      'NORMALIZATION_FAILED', 'LegacyFailure', FALSE,
      to_timestamp($2::BIGINT / 1000.0), to_timestamp($2::BIGINT / 1000.0)+INTERVAL '4 hours')`,
    [PUMP_PROGRAM_ID, classifiedAtMs]);

    assert.equal((await purgeExpiredFoundationData(pool)).transactionInbox, 1);
    assert.equal((await pool.query(`SELECT COUNT(*) FROM chain_transaction_inbox
      WHERE signature=$1`, [classification.signature])).rows[0]?.count, '1');
    assert.equal((await pool.query(`SELECT COUNT(*) FROM chain_transaction_inbox
      WHERE signature='legacy-null-detection-retention'`)).rows[0]?.count, '0');

    const schema = (await pool.query<{ readonly schema_name: unknown }>(
      'SELECT current_schema() AS schema_name',
    )).rows[0]?.schema_name;
    assert.equal(typeof schema, 'string');
    if (typeof schema !== 'string') throw new TypeError('Expected an isolated test schema.');
    const deletionAt = new Date(before.first_detected_at.getTime() + 14_400_000).toISOString();
    await pool.query(`CREATE FUNCTION ${quoteIdentifier(schema)}.clock_timestamp()
      RETURNS TIMESTAMPTZ LANGUAGE SQL IMMUTABLE
      AS $$ SELECT TIMESTAMPTZ '${deletionAt}' $$`);
    await pool.query(`SET search_path = ${quoteIdentifier(schema)}, pg_catalog`);

    assert.equal((await purgeExpiredFoundationData(pool)).transactionInbox, 1);
    assert.equal((await pool.query(`SELECT COUNT(*) FROM chain_transaction_inbox
      WHERE signature=$1`, [classification.signature])).rows[0]?.count, '0');
  });
});

void test('aggregates a bounded first-processing cohort with PostgreSQL timing and no identifiers', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const startedAtMs = Date.now() - FIRST_PROCESSING_COHORT_DURATION_MS - 100_000;
    const databaseClockSql = `SELECT
      (EXTRACT(EPOCH FROM date_trunc('milliseconds', clock_timestamp())) * 1000)::BIGINT
        AS now_ms`;
    const databaseBeforeMs = Number((await pool.query(databaseClockSql)).rows[0]?.now_ms);
    const databaseStartedAtMs = await repository.beginFirstProcessingCanary();
    const databaseAfterMs = Number((await pool.query(databaseClockSql)).rows[0]?.now_ms);
    assert.equal(Number.isSafeInteger(databaseBeforeMs), true);
    assert.equal(Number.isSafeInteger(databaseStartedAtMs), true);
    assert.equal(Number.isSafeInteger(databaseAfterMs), true);
    assert.ok(databaseStartedAtMs >= databaseBeforeMs);
    assert.ok(databaseStartedAtMs <= databaseAfterMs);

    await insertCanaryInboxRow(pool, 'canary-under', startedAtMs + 1, startedAtMs + 45_000);
    await insertCanaryInboxRow(pool, 'canary-at', startedAtMs + 2, startedAtMs + 45_002);
    await insertCanaryInboxRow(pool, 'canary-invalid', startedAtMs + 4, startedAtMs + 3);
    await insertCanaryInboxRow(pool, 'canary-unavailable', startedAtMs + 5, null, 'PENDING', true);
    await insertCanaryInboxRow(pool, 'canary-failed-nonretryable-a', startedAtMs + 6, null, 'FAILED');
    await insertCanaryInboxRow(pool, 'canary-failed-nonretryable-b', startedAtMs + 7, null, 'FAILED');
    await insertCanaryInboxRow(pool, 'canary-failed-nonretryable-c', startedAtMs + 8, null, 'FAILED');
    await insertCanaryInboxRow(pool, 'canary-failed', startedAtMs + 9, null, 'FAILED');
    await insertCanaryInboxRow(pool, 'canary-exhausted', startedAtMs + 10, null, 'FAILED', false, true);
    await insertCanaryInboxRow(pool, 'canary-tail', startedAtMs + 11, null);
    await insertCanaryInboxRow(pool, 'canary-upper-bound', startedAtMs + FIRST_PROCESSING_COHORT_DURATION_MS, null);

    const evidence = await repository.firstProcessingCanary(startedAtMs);
    assert.deepEqual(evidence, {
      version: 1, thresholdMs: FIRST_PROCESSING_THRESHOLD_MS,
      cohortCapacity: FIRST_PROCESSING_COHORT_CAPACITY,
      cohortStartedAtMs: startedAtMs,
      cohortEndsAtMs: startedAtMs + FIRST_PROCESSING_COHORT_DURATION_MS,
      sampledAtMs: evidence.sampledAtMs, overflowed: false,
      eligibleCount: 10, completedCount: 2, underThresholdCount: 1,
      atOrAboveThresholdCount: 1, pendingCount: 1, rightCensoredCount: 0,
      tailCensoredCount: 1, terminalCount: 5, unavailableCount: 1,
      invalidDurationCount: 1, p95Ms: 45_000, verdict: 'FAIL',
    });
    assert.equal(evidence.sampledAtMs >= startedAtMs + FIRST_PROCESSING_COHORT_DURATION_MS,
      true);
    assert.equal('signature' in evidence, false);
    assert.equal('mint' in evidence, false);
    assert.equal('programId' in evidence, false);
  });
});

void test('uses a 50,001st deterministic overflow probe without counting it in the cohort', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const startedAtMs = Date.now() - FIRST_PROCESSING_COHORT_DURATION_MS - 100_000;
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, observed_at, first_detected_at
    ) SELECT 'canary-cap-' || LPAD(series::TEXT, 5, '0'), series, ARRAY['WEBSOCKET'],
      ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'confirmed', 'PENDING',
      to_timestamp(($1::BIGINT - 3600000) / 1000.0), to_timestamp($1::BIGINT / 1000.0)
      FROM generate_series(1, $2) AS series`, [startedAtMs, FIRST_PROCESSING_COHORT_CAPACITY + 1]);

    const evidence = await repository.firstProcessingCanary(startedAtMs);
    assert.equal(evidence.overflowed, true);
    assert.equal(evidence.eligibleCount, FIRST_PROCESSING_COHORT_CAPACITY);
    assert.equal(evidence.tailCensoredCount, FIRST_PROCESSING_COHORT_CAPACITY);
    assert.equal(evidence.verdict, 'INCONCLUSIVE');
  });
});

void test('classifies an incomplete fresh cohort as right-censored', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const startedAtMs = Date.now() - 10;
    await insertCanaryInboxRow(pool, 'canary-right-censored', startedAtMs, null);

    const evidence = await repository.firstProcessingCanary(startedAtMs);
    assert.equal(evidence.eligibleCount, 1);
    assert.equal(evidence.pendingCount, 1);
    assert.equal(evidence.rightCensoredCount, 1);
    assert.equal(evidence.tailCensoredCount, 0);
    assert.equal(evidence.p95Ms, null);
    assert.equal(evidence.verdict, 'INCONCLUSIVE');
  });
});

void test('counts one completed duration, excludes pre-cohort and historical rows', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const startedAtMs = Date.now() - FIRST_PROCESSING_COHORT_DURATION_MS - 100_000;
    await insertCanaryInboxRow(pool, 'canary-single-completed', startedAtMs, startedAtMs + 44_999);
    await insertCanaryInboxRow(pool, 'canary-before-start', startedAtMs - 1, startedAtMs + 44_998);
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, observed_at, first_detected_at, first_processing_evidence_unavailable
    ) VALUES ('canary-historical', 2, ARRAY['WEBSOCKET'],
      ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'confirmed', 'PENDING',
      to_timestamp($1::BIGINT / 1000.0), NULL, TRUE)`, [startedAtMs]);

    const evidence = await repository.firstProcessingCanary(startedAtMs);
    assert.equal(evidence.eligibleCount, 1);
    assert.equal(evidence.completedCount, 1);
    assert.equal(evidence.p95Ms, 44_999);
    assert.equal(evidence.verdict, 'PASS');
  });
});

void test('worker-eligible cohort: excludes only exact never-worker-touched catch-up outcomes', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const startedAtMs = Date.now() - 1_000;
    const classificationOnly = [
      createCatchUpClassification({ ...catchUpClassificationInput('canary-ignored-solana-failed'),
        observedAtMs: startedAtMs, classifiedAtMs: startedAtMs + 1,
        disposition: 'IGNORED', reasonCode: 'SOLANA_TRANSACTION_FAILED',
        ingestionHint: null, ingestionHintMint: null, mints: [],
      }),
      createCatchUpClassification({ ...catchUpClassificationInput('canary-deferred-valid'),
        observedAtMs: startedAtMs, classifiedAtMs: startedAtMs + 2,
        disposition: 'DEFERRED', reasonCode: 'PUMP_TRADE_UNTRACKED',
        ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: tradeMint, mints: [tradeMint],
      }),
      createCatchUpClassification({ ...catchUpClassificationInput('canary-ignored-valid'),
        observedAtMs: startedAtMs, classifiedAtMs: startedAtMs + 3,
        disposition: 'IGNORED', reasonCode: 'NO_SUPPORTED_PUMP_ACTION',
        ingestionHint: null, ingestionHintMint: null, mints: [],
      }),
    ];
    const blocking = [
      createCatchUpClassification({ ...catchUpClassificationInput('canary-quarantined-valid'),
        observedAtMs: startedAtMs, classifiedAtMs: startedAtMs + 4,
        disposition: 'QUARANTINED', reasonCode: 'PUMP_SCHEMA_UNSUPPORTED',
        ingestionHint: null, ingestionHintMint: null, mints: [],
      }),
    ];
    for (const classification of [...classificationOnly, ...blocking]) {
      const receipt = await repository.recordCatchUpClassification(classification);
      assert.equal(receipt.admission, 'NOT_ENQUEUED');
      assert.equal((await row(pool, classification.signature)).catch_up_enqueued, false);
    }

    const evidence = await repository.firstProcessingCanary(startedAtMs);
    assert.equal(evidence.eligibleCount, 1);
    assert.equal(evidence.terminalCount, 1);
    assert.equal(evidence.pendingCount, 0);
    assert.equal(evidence.verdict, 'INCONCLUSIVE');
  });
});

void test('worker-eligible cohort: keeps unrelated, incomplete, contradictory and failed rows fail-closed', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const startedAtMs = Date.now() - 1_000;
    await repository.enqueue(Object.freeze({
      ...tradeNotification('canary-unrelated-deferred', 1n),
      observedAtMs: startedAtMs,
    }));
    await insertCanaryInboxRow(
      pool,
      'canary-genuine-worker-failed',
      startedAtMs + 1,
      null,
      'FAILED',
    );
    await repository.enqueue(Object.freeze({
      ...notification('canary-incomplete-classification', 2n),
      observedAtMs: startedAtMs,
    }));
    await repository.enqueue(Object.freeze({
      ...notification('canary-contradictory-classification', 3n),
      observedAtMs: startedAtMs,
    }));
    await pool.query(`UPDATE chain_transaction_inbox SET attempts=1
      WHERE signature='canary-contradictory-classification'`);
    await repository.recordCatchUpClassification(createCatchUpClassification({
      ...catchUpClassificationInput('canary-contradictory-classification'),
      slot: 3n,
      observedAtMs: startedAtMs,
      classifiedAtMs: startedAtMs + 2,
      disposition: 'IGNORED',
      reasonCode: 'NO_SUPPORTED_PUMP_ACTION',
      ingestionHint: null,
      ingestionHintMint: null,
      mints: [],
    }));
    await pool.query(`ALTER TABLE chain_transaction_inbox
      DROP CONSTRAINT chain_transaction_inbox_catch_up_classification_check`);
    await pool.query(`UPDATE chain_transaction_inbox SET catch_up_classification_version=1
      WHERE signature='canary-incomplete-classification'`);

    const evidence = await repository.firstProcessingCanary(startedAtMs);
    assert.equal(evidence.eligibleCount, 4);
    assert.equal(evidence.terminalCount, 2);
    assert.equal(evidence.pendingCount, 2);
    assert.equal(evidence.verdict, 'INCONCLUSIVE');
  });
});

void test('worker-eligible cohort: includes a deferred row after real promotion and processing', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const startedAtMs = Date.now() - 1_000;
    const signature = 'canary-promoted-deferred';
    await repository.recordCatchUpClassification(createCatchUpClassification({
      ...catchUpClassificationInput(signature),
      observedAtMs: startedAtMs,
      classifiedAtMs: startedAtMs + 1,
      disposition: 'DEFERRED',
      reasonCode: 'PUMP_TRADE_UNTRACKED',
      ingestionHint: 'PUMPFUN_TRADE',
      ingestionHintMint: tradeMint,
      mints: [tradeMint],
    }));
    const initiallyDeferred = await row(pool, signature);
    const firstDetectedAtMs = new Date(initiallyDeferred.first_detected_at).getTime();
    assert.equal(initiallyDeferred.processing_status, 'DEFERRED');
    assert.equal(initiallyDeferred.catch_up_enqueued, false);

    await insertTrackedLaunch(pool);
    await repository.syncTrackedMint(tradeMint);
    const promoted = await row(pool, signature);
    assert.equal(promoted.processing_status, 'PENDING');
    assert.equal(promoted.catch_up_enqueued, false);
    assert.equal(new Date(promoted.first_detected_at).getTime(), firstDetectedAtMs);

    const claimed = await repository.claim(Date.now(), 30);
    assert.ok(claimed);
    assert.equal(claimed.signature, signature);
    assert.equal((await row(pool, signature)).processing_status, 'PROCESSING');
    await repository.saveSnapshot(signature, claimed.leaseToken, normalized(signature, 1n));
    await repository.markProcessed(signature, claimed.leaseToken, 'confirmed');
    const processed = await row(pool, signature);
    const firstProcessedAtMs = new Date(processed.first_processed_at).getTime();
    assert.equal(processed.processing_status, 'PROCESSED');
    assert.equal(processed.catch_up_enqueued, false);
    assert.equal(new Date(processed.first_detected_at).getTime(), firstDetectedAtMs);

    const evidence = await repository.firstProcessingCanary(startedAtMs);
    assert.equal(evidence.eligibleCount, 1);
    assert.equal(evidence.completedCount, 1);
    assert.equal(evidence.p95Ms, firstProcessedAtMs - firstDetectedAtMs);
  });
});

void test('worker-eligible cohort: keeps every individual worker-history contradiction', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const startedAtMs = Date.now() - 1_000;
    const contradictions = [
      "attempts=1",
      "attempts_in_cycle=1",
      "lease_token='active-lease', lease_expires_at=clock_timestamp()+INTERVAL '1 minute'",
      "normalized_transaction='{}'::JSONB",
      `immutable_fingerprint='${'b'.repeat(64)}'`,
      "processed_at=first_detected_at+INTERVAL '1 millisecond'",
      "first_processed_at=first_detected_at+INTERVAL '1 millisecond'",
      "manual_recovery_count=1, last_manual_recovery_at=first_detected_at+INTERVAL '1 millisecond'",
      "next_attempt_at=first_detected_at+INTERVAL '1 millisecond'",
      "retry_exhausted_at=first_detected_at+INTERVAL '1 millisecond'",
      "error_code='RPC_TRANSIENT', error_name='CanaryFailure', error_retryable=TRUE",
      "missing_finality_polls=1, last_missing_finality_provider_id='primary'",
      "finality_evidence_version=1",
      "first_processing_evidence_unavailable=TRUE",
      "catch_up_admission_priority='NORMAL'",
    ] as const;
    for (let index = 0; index < contradictions.length; index += 1) {
      const signature = `canary-worker-history-${index}`;
      await repository.recordCatchUpClassification(createCatchUpClassification({
        ...catchUpClassificationInput(signature),
        observedAtMs: startedAtMs,
        classifiedAtMs: startedAtMs + index + 1,
        disposition: 'DEFERRED',
        reasonCode: 'PUMP_TRADE_UNTRACKED',
        ingestionHint: 'PUMPFUN_TRADE',
        ingestionHintMint: tradeMint,
        mints: [tradeMint],
      }));
    }

    const checks = await pool.query<{ readonly conname: string }>(`SELECT conname
      FROM pg_constraint WHERE conrelid='chain_transaction_inbox'::REGCLASS AND contype='c'`);
    for (const { conname } of checks.rows) {
      await pool.query(`ALTER TABLE chain_transaction_inbox DROP CONSTRAINT ${quoteIdentifier(conname)}`);
    }
    await pool.query(`DROP TRIGGER IF EXISTS chain_transaction_inbox_first_processing_guard
      ON chain_transaction_inbox`);
    for (let index = 0; index < contradictions.length; index += 1) {
      await pool.query(`UPDATE chain_transaction_inbox SET ${contradictions[index]}
        WHERE signature=$1`, [`canary-worker-history-${index}`]);
    }

    const evidence = await repository.firstProcessingCanary(startedAtMs);
    assert.equal(evidence.eligibleCount, contradictions.length);
    assert.equal(
      evidence.completedCount + evidence.terminalCount + evidence.unavailableCount,
      contradictions.length,
    );
    assert.equal(evidence.verdict, 'INCONCLUSIVE');
  });
});

void test('worker-eligible cohort: excludes classification-only rows before capacity probing', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const startedAtMs = Date.now() - FIRST_PROCESSING_COHORT_DURATION_MS - 100_000;
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, observed_at, first_detected_at, terminal_at, purge_after,
      catch_up_classification_version, catch_up_disposition, catch_up_reason_code,
      catch_up_action_key, catch_up_mints, catch_up_evidence_fingerprint,
      catch_up_classified_at, catch_up_enqueued, catch_up_admission_priority
    ) SELECT 'canary-classification-only-' || LPAD(series::TEXT, 5, '0'), series,
      ARRAY['CATCH_UP'], ARRAY[$3], 'confirmed', 'IGNORED',
      to_timestamp($1::BIGINT / 1000.0), to_timestamp($1::BIGINT / 1000.0),
      to_timestamp($1::BIGINT / 1000.0),
      to_timestamp($1::BIGINT / 1000.0) + INTERVAL '4 hours',
      1, 'IGNORED', 'NO_SUPPORTED_PUMP_ACTION', 'NONE', ARRAY[]::TEXT[], $4,
      to_timestamp($1::BIGINT / 1000.0), FALSE, NULL
      FROM generate_series(1, $2) AS series`, [
      startedAtMs,
      FIRST_PROCESSING_COHORT_CAPACITY + 1,
      PUMP_PROGRAM_ID,
      'c'.repeat(64),
    ]);
    await insertCanaryInboxRow(
      pool,
      'canary-capacity-worker-eligible',
      startedAtMs + 1,
      null,
    );

    const evidence = await repository.firstProcessingCanary(startedAtMs);
    assert.equal(evidence.overflowed, false);
    assert.equal(evidence.eligibleCount, 1);
    assert.equal(evidence.tailCensoredCount, 1);
  });
});

void test('classifies valid nonretryable and exhausted FAILED rows before their required terminal timestamps', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const startedAtMs = Date.now() - 1_000;
    await insertCanaryInboxRow(pool, 'canary-failed-nonretryable', startedAtMs, null, 'FAILED');
    await insertCanaryInboxRow(pool, 'canary-failed-exhausted', startedAtMs + 1, null,
      'FAILED', false, true);

    const nonretryable = await row(pool, 'canary-failed-nonretryable');
    const exhausted = await row(pool, 'canary-failed-exhausted');
    assert.equal(nonretryable.error_retryable, false);
    assert.equal(nonretryable.retry_exhausted_at, null);
    assert.notEqual(nonretryable.terminal_at, null);
    assert.equal(exhausted.error_retryable, true);
    assert.notEqual(exhausted.retry_exhausted_at, null);
    assert.notEqual(exhausted.terminal_at, null);
    const evidence = await repository.firstProcessingCanary(startedAtMs);
    assert.equal(evidence.eligibleCount, 2);
    assert.equal(evidence.terminalCount, 2);
  });
});

void test('classifies the 44,999/45,000 right/tail boundary through the repository', async (context) => {
  await withDatabase(context, async (pool) => {
    const sampledAtMs = Date.parse('2026-01-01T00:00:45.000Z');
    const startedAtMs = sampledAtMs - 60_000;
    await insertCanaryInboxRow(pool, 'canary-right-boundary', sampledAtMs - 44_999, null);
    await insertCanaryInboxRow(pool, 'canary-tail-boundary', sampledAtMs - 45_000, null);

    const client = await pool.connect();
    try {
      const schema = (await client.query<{ readonly schema_name: unknown }>(
        'SELECT current_schema() AS schema_name',
      )).rows[0]?.schema_name;
      assert.equal(typeof schema, 'string');
      if (typeof schema !== 'string') throw new TypeError('Expected an isolated test schema.');
      await client.query(`CREATE FUNCTION ${quoteIdentifier(schema)}.clock_timestamp()
        RETURNS TIMESTAMPTZ LANGUAGE SQL IMMUTABLE
        AS $$ SELECT to_timestamp(${sampledAtMs} / 1000.0) $$`);
      await client.query(`SET search_path = ${quoteIdentifier(schema)}, pg_catalog`);
      const repository = new PostgresTransactionInboxRepository({
        async query(text, values) {
          return client.query(text, values === undefined ? undefined : [...values]);
        },
        async connect() { throw new Error('No connection needed.'); },
      });

      const evidence = await repository.firstProcessingCanary(startedAtMs);
      assert.equal(evidence.sampledAtMs, sampledAtMs);
      assert.equal(evidence.eligibleCount, 2);
      assert.equal(evidence.pendingCount, 2);
      assert.equal(evidence.rightCensoredCount, 1);
      assert.equal(evidence.tailCensoredCount, 1);
    } finally {
      client.release();
    }
  });
});

void test('RPC HTTP heartbeat persistence serializes only detached fixed evidence fields', async () => {
  const recorder = createRpcHttpEvidenceRecorder();
  recorder.recordAttempt('primary');
  recorder.recordHttp429('primary');
  const rpcHttpEvidence = recorder.snapshot(['primary']);
  const heartbeat = rpcEvidenceHeartbeat();
  let payload: unknown;
  const repository = new PostgresTransactionInboxRepository({
    async connect() { throw new Error('No connection needed.'); },
    async query(_sql, values) { payload = values?.[14]; return { rows: [], rowCount: 1 }; },
  });
  await repository.writeHeartbeat(Object.freeze({ ...heartbeat, rpcHttpEvidence }));
  assert.deepEqual(payload, { startedAt: '1970-01-01T00:00:01.000Z', rpcHttpEvidence });
  assert.notEqual((payload as { rpcHttpEvidence: unknown }).rpcHttpEvidence, rpcHttpEvidence);
});

void test('RPC HTTP heartbeat persistence rejects present malformed evidence before querying', async () => {
  const valid = createRpcHttpEvidenceRecorder().snapshot(['primary']);
  let queries = 0;
  let accessorReads = 0;
  const repository = new PostgresTransactionInboxRepository({
    async connect() { throw new Error('No connection needed.'); },
    async query() { queries += 1; return { rows: [], rowCount: 1 }; },
  });
  for (const rpcHttpEvidence of [undefined, null, new Proxy(valid, {}),
    Object.freeze({ ...valid, providers: new Proxy(valid.providers, {}) }),
    Object.freeze({ ...valid, endpoint: 'private-secret' }),
    Object.freeze({ ...valid, get overflowed() { accessorReads += 1; return false; } }),
  ]) {
    await assert.rejects(repository.writeHeartbeat(Object.freeze({ ...rpcEvidenceHeartbeat(), rpcHttpEvidence }) as RuntimeHeartbeat),
      (error: unknown) => {
        assert.ok(error instanceof TransactionInboxRepositoryError);
        assert.doesNotMatch(String(error), /private-secret/u);
        return true;
      });
  }
  assert.equal(queries, 0);
  assert.equal(accessorReads, 0);
});

void test('persists RPC HTTP evidence in RUNNING and STOPPED heartbeat JSON and supports historical omission', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const recorder = createRpcHttpEvidenceRecorder();
    const heartbeat = rpcEvidenceHeartbeat();
    for (const [index, runtimeState] of (['RUNNING', 'STOPPED'] as const).entries()) {
      recorder.recordAttempt('primary');
      if (runtimeState === 'STOPPED') recorder.recordHttp429('primary');
      const rpcHttpEvidence = recorder.snapshot(['primary']);
      await repository.writeHeartbeat(Object.freeze({ ...heartbeat, runtimeState,
        updatedAtMs: 2_000 + index * 1_000, rpcHttpEvidence,
      }));
      const row = (await pool.query('SELECT runtime_state, payload FROM listener_heartbeats')).rows[0];
      assert.equal(row?.runtime_state, runtimeState);
      assert.deepEqual(row?.payload, { startedAt: '1970-01-01T00:00:01.000Z', rpcHttpEvidence });
    }
    await repository.writeHeartbeat(Object.freeze({ ...heartbeat, updatedAtMs: 4_000 }));
    assert.deepEqual((await pool.query('SELECT payload FROM listener_heartbeats')).rows[0]?.payload,
      { startedAt: '1970-01-01T00:00:01.000Z' });
  });
});

function rpcEvidenceHeartbeat(): RuntimeHeartbeat {
  return Object.freeze({
    runtimeState: 'RUNNING', subscriberState: 'RUNNING', scannerState: 'RUNNING',
    workerState: 'RUNNING', reconcilerState: 'RUNNING', startedAtMs: 1_000,
    updatedAtMs: 2_000, lastHttpSlot: null, lastWebsocketSlot: null,
    lastFinalizedSlot: null, lastSignature: null, backlogCount: 0, leasedCount: 0, exhaustedCount: 0,
  });
}

void test('catch-up admission counts partition actionable work by source and priority in one query', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await insertTrackedLaunch(pool);
    await repository.enqueue(notification('normal', 1n));
    await repository.recordCatchUpClassification(catchUpClassification('launch'));
    await repository.enqueue(tradeNotification('trade', 2n));
    await repository.enqueue(pumpCatchUpNotification('trade', 2n));
    await repository.enqueue(notification('retry', 3n, 'CATCH_UP'));
    await repository.enqueue(notification('fatal', 4n));
    await repository.enqueue(notification('exhausted', 5n));
    await repository.enqueue(notification('processed', 6n));
    await pool.query(`UPDATE chain_transaction_inbox SET processing_status='FAILED',
      error_code='RPC_TRANSIENT', error_name='RpcError', error_retryable=TRUE,
      next_attempt_at=clock_timestamp() WHERE signature='retry'`);
    await pool.query(`UPDATE chain_transaction_inbox SET processing_status='FAILED',
      error_code='NORMALIZATION_FAILED', error_name='TypeError', error_retryable=FALSE,
      terminal_at=now(), purge_after=now()+INTERVAL '4 hours'
      WHERE signature='fatal'`);
    await pool.query(`UPDATE chain_transaction_inbox SET processing_status='FAILED',
      error_code='RPC_TRANSIENT', error_name='RpcError', error_retryable=TRUE,
      retry_exhausted_at=now(), terminal_at=now(), purge_after=now()+INTERVAL '4 hours'
      WHERE signature='exhausted'`);
    await pool.query(`UPDATE chain_transaction_inbox SET processing_status='PROCESSED',
      processed_at=clock_timestamp(), normalized_transaction='{}'::jsonb,
      immutable_fingerprint=repeat('a',64) WHERE signature='processed'`);
    const claim = await repository.claim(Date.now(), 30);
    assert.equal(claim?.signature, 'launch');
    await repository.enqueue(tradeNotification('deferred', 7n, '11111111111111111111111111111111'));
    for (const [signature, disposition, reasonCode] of [
      ['ignored', 'IGNORED', 'NO_SUPPORTED_PUMP_ACTION'],
      ['quarantined', 'QUARANTINED', 'PUMP_SCHEMA_UNSUPPORTED'],
    ] as const) {
      await repository.recordCatchUpClassification(createCatchUpClassification({
        ...catchUpClassificationInput(signature), disposition, reasonCode,
        ingestionHint: null, ingestionHintMint: null, mints: [],
      }));
    }
    const queries: string[] = [];
    const measured = new PostgresTransactionInboxRepository({
      connect: () => pool.connect(),
      query: async (sql, values) => { queries.push(sql); return pool.query(sql, values === undefined ? undefined : [...values]); },
    });
    const counts = await measured.counts();
    assert.equal(queries.length, 1);
    assert.deepEqual(counts, {
      pending: 2, processing: 1, processed: 1, failed: 3, retryableFailed: 1,
      exhaustedFailed: 1, decoderQuarantinedCount: 0,
      catchUpAdmission: {
        actionableBacklogBySource: { websocketOnly: 1, catchUpOnly: 2, websocketAndCatchUp: 1 },
        actionableBacklogByPriority: { normal: 2, launchCandidate: 1, trackedTrade: 1 },
        deferredCount: 1, ignoredCount: 1, quarantinedCount: 1,
      },
    });
    assert.ok(Object.isFrozen(counts.catchUpAdmission));
    assert.ok(Object.isFrozen(counts.catchUpAdmission.actionableBacklogBySource));
    assert.ok(Object.isFrozen(counts.catchUpAdmission.actionableBacklogByPriority));
  });
});

void test('counts only retained unresolved worker decoder quarantines and clears the aggregate on recovery', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await storeWorkerDecoderQuarantine(
      repository, 'decoder-count-retained', 930n, 'PUMP_SCHEMA_UNSUPPORTED',
    );
    await storeWorkerDecoderQuarantine(
      repository, 'decoder-count-expired', 931n, 'PUMP_BORSH_TRUNCATED',
    );
    await storeWorkerDecoderQuarantine(
      repository, 'decoder-count-malformed', 932n, 'PUMP_SCHEMA_UNSUPPORTED',
    );
    await pool.query(`UPDATE chain_transaction_inbox SET
      normalized_transaction='{}'::jsonb
      WHERE signature='decoder-count-malformed'`);
    await storeWorkerDecoderQuarantine(
      repository, 'decoder-count-fingerprint-drift', 933n, 'PUMP_BORSH_TRUNCATED',
    );
    await pool.query(`UPDATE chain_transaction_inbox SET
      immutable_fingerprint=repeat('a',64)
      WHERE signature='decoder-count-fingerprint-drift'`);
    await storeWorkerDecoderQuarantine(
      repository, 'decoder-count-saturated', 934n, 'PUMP_SCHEMA_UNSUPPORTED',
    );
    await pool.query(`UPDATE chain_transaction_inbox SET
      manual_recovery_count=2147483647,last_manual_recovery_at=terminal_at
      WHERE signature='decoder-count-saturated'`);
    await pool.query(`UPDATE chain_transaction_inbox SET
      terminal_at=date_trunc('milliseconds',clock_timestamp()-INTERVAL '4 hours'),
      purge_after=date_trunc('milliseconds',clock_timestamp())
      WHERE signature='decoder-count-expired'`);
    await repository.recordCatchUpClassification(createCatchUpClassification({
      ...catchUpClassificationInput('decoder-count-catch-up'),
      disposition: 'QUARANTINED', reasonCode: 'PUMP_SCHEMA_UNSUPPORTED',
      ingestionHint: null, ingestionHintMint: null, mints: [],
    }));
    await repository.enqueue(notification('decoder-count-processed', 935n));
    const claimed = await repository.claim(Date.now(), 30);
    assert.equal(claimed?.signature, 'decoder-count-processed');
    await repository.saveSnapshot(
      claimed.signature, claimed.leaseToken, normalized(claimed.signature, claimed.slot),
    );
    await repository.markProcessed(claimed.signature, claimed.leaseToken, 'finalized');

    const countQueries: string[] = [];
    const measured = new PostgresTransactionInboxRepository({
      connect: () => pool.connect(),
      query: async (sql, values) => {
        countQueries.push(sql);
        return pool.query(sql, values === undefined ? undefined : [...values]);
      },
    });
    assert.equal((await measured.counts()).decoderQuarantinedCount, 1);
    assert.equal(countQueries.length, 1);
    assert.deepEqual(await repository.recoverDecoderQuarantine('decoder-count-retained'), {
      code: 'DECODER_RECOVERY_SCHEDULED', signature: 'decoder-count-retained',
    });
    assert.equal((await repository.counts()).decoderQuarantinedCount, 0);
    const replay = await repository.claim(Date.now(), 30);
    assert.equal(replay?.signature, 'decoder-count-retained');
    await repository.markFailed(replay.signature, replay.leaseToken, Object.freeze({
      code: 'PIPELINE_STAGE_FAILED',
      errorName: 'ObservedPipelineFailure.v1.launchpad_observation.PUMP_SCHEMA_UNSUPPORTED',
      retryable: false,
    }));
    assert.equal((await repository.counts()).decoderQuarantinedCount, 0);
    assert.deepEqual(await repository.recoverDecoderQuarantine('decoder-count-retained'), {
      code: 'DECODER_RECOVERY_ALREADY_SCHEDULED', signature: 'decoder-count-retained',
    });
  });
});

void test('persists detached decoder quarantine heartbeat metrics and supports legacy omission', async () => {
  const captured: unknown[][] = [];
  const repository = new PostgresTransactionInboxRepository({
    async query(_text, values) {
      captured.push(values === undefined ? [] : [...values]);
      return { rows: [], rowCount: 1 };
    },
    async connect() { throw new Error('not used'); },
  });
  const owned = Object.freeze({ version: 1 as const, unresolvedCount: 2 });
  const heartbeat: RuntimeHeartbeat = Object.freeze({
    ...rpcEvidenceHeartbeat(), decoderQuarantine: owned,
  });
  await repository.writeHeartbeat(heartbeat);
  assert.deepEqual(captured[0]?.[14], {
    startedAt: '1970-01-01T00:00:01.000Z',
    decoderQuarantine: { version: 1, unresolvedCount: 2 },
  });
  assert.notEqual(
    (captured[0]?.[14] as { readonly decoderQuarantine?: unknown }).decoderQuarantine,
    owned,
  );
  const { decoderQuarantine: omitted, ...legacy } = heartbeat;
  assert.ok(omitted);
  await repository.writeHeartbeat(Object.freeze({ ...legacy, updatedAtMs: 3_000 }));
  assert.deepEqual(captured[1]?.[14], { startedAt: '1970-01-01T00:00:01.000Z' });
});

void test('persists optional catch-up admission heartbeat metrics and rejects invalid payloads', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const catchUpAdmission = Object.freeze({ version: 1 as const, enabled: true,
      providerId: 'primary' as const, scanActive: false, workerClaimReady: true,
      actionableBacklogBySource: Object.freeze({ websocketOnly: 1, catchUpOnly: 1, websocketAndCatchUp: 1 }),
      actionableBacklogByPriority: Object.freeze({ normal: 1, launchCandidate: 1, trackedTrade: 1 }),
      deferredCount: 2, ignoredCount: 3, quarantinedCount: 4,
    });
    const heartbeat: RuntimeHeartbeat = Object.freeze({
      runtimeState: 'RUNNING', subscriberState: 'RUNNING', scannerState: 'RUNNING',
      workerState: 'RUNNING', reconcilerState: 'RUNNING', startedAtMs: 1_000,
      updatedAtMs: 2_000, lastHttpSlot: null, lastWebsocketSlot: null,
      lastFinalizedSlot: null, lastSignature: null, backlogCount: 3, leasedCount: 0,
      exhaustedCount: 0, catchUpAdmission,
    });
    await repository.writeHeartbeat(heartbeat);
    assert.deepEqual((await pool.query('SELECT payload FROM listener_heartbeats')).rows[0]?.payload, {
      startedAt: '1970-01-01T00:00:01.000Z', catchUpAdmission,
    });
    await assert.rejects(repository.writeHeartbeat(Object.freeze({ ...heartbeat, updatedAtMs: 3_000,
      catchUpAdmission: Object.freeze({ ...catchUpAdmission, providerId: 'https://private-secret.invalid' }),
    }) as unknown as RuntimeHeartbeat), (error: unknown) => {
      assert.ok(error instanceof TransactionInboxRepositoryError);
      assert.doesNotMatch(String(error), /private-secret/u);
      return true;
    });
    const { catchUpAdmission: omitted, ...legacy } = heartbeat;
    assert.ok(omitted);
    await repository.writeHeartbeat(Object.freeze({ ...legacy, updatedAtMs: 4_000 }));
    assert.deepEqual((await pool.query('SELECT payload FROM listener_heartbeats')).rows[0]?.payload, {
      startedAt: '1970-01-01T00:00:01.000Z',
    });
  });
});

for (const [location, boundary] of [
  ['metrics', 'callback'], ['metrics', 'repository'],
  ['source', 'callback'], ['source', 'repository'],
  ['priority', 'callback'], ['priority', 'repository'],
] as const) {
  void test(`${boundary} canonicalizes catch-up admission ${location} proxies before PostgreSQL serialization`, async (context) => {
    await withDatabase(context, async (pool) => {
      const repository = new PostgresTransactionInboxRepository(pool);
      const counts = await repository.counts();
      const expected = Object.freeze({ version: 1 as const, enabled: true,
        providerId: 'primary' as const, scanActive: false, workerClaimReady: true,
        ...counts.catchUpAdmission,
      });
      let serializationReads = 0;
      const handler: ProxyHandler<object> = {
        get(target, key, receiver) {
          if (key === 'toJSON') {
            serializationReads += 1;
            return () => ({ endpoint: 'https://private-proxy-secret.invalid' });
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      };
      const metrics = location === 'metrics' ? new Proxy<typeof expected>(expected, handler) : Object.freeze({
        ...expected,
        ...(location === 'source'
          ? { actionableBacklogBySource: new Proxy<typeof expected.actionableBacklogBySource>(expected.actionableBacklogBySource, handler) }
          : { actionableBacklogByPriority: new Proxy<typeof expected.actionableBacklogByPriority>(expected.actionableBacklogByPriority, handler) }),
      });
      if (boundary === 'repository') {
        await repository.writeHeartbeat(Object.freeze({
          runtimeState: 'RUNNING', subscriberState: 'RUNNING', scannerState: 'RUNNING',
          workerState: 'RUNNING', reconcilerState: 'RUNNING', startedAtMs: 1_000,
          updatedAtMs: 2_000, lastHttpSlot: null, lastWebsocketSlot: null,
          lastFinalizedSlot: null, lastSignature: null, backlogCount: 0, leasedCount: 0,
          exhaustedCount: 0, catchUpAdmission: metrics,
        }));
        const payload: unknown = (await pool.query('SELECT payload FROM listener_heartbeats')).rows[0]?.payload;
        assert.deepEqual(payload, { startedAt: '1970-01-01T00:00:01.000Z', catchUpAdmission: expected });
        assert.equal(serializationReads, 0);
        assert.doesNotMatch(JSON.stringify(payload), /private-proxy-secret/u);
        return;
      }
      let written: RuntimeHeartbeat | undefined;
      const heartbeat = new PersistentListenerHeartbeat({
        counts: () => repository.counts(),
        beginFirstProcessingCanary: () => repository.beginFirstProcessingCanary(),
        firstProcessingCanary: (cohortStartedAtMs) => repository.firstProcessingCanary(cohortStartedAtMs),
        async writeHeartbeat(value) { written = value; await repository.writeHeartbeat(value); },
      }, { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
      () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', {
        intervalMs: 5, shutdownTimeoutMs: 100,
        scheduler: { schedule: () => 0, cancel: () => undefined },
        catchUpAdmissionMetrics: () => metrics,
      });
      try {
        await heartbeat.start();
        const payload: unknown = (await pool.query('SELECT payload FROM listener_heartbeats')).rows[0]?.payload;
        assert.ok(written);
        assert.deepEqual(payload, {
          startedAt: new Date(written.startedAtMs).toISOString(), catchUpAdmission: expected,
          decoderQuarantine: written.decoderQuarantine,
          firstProcessingCanary: written.firstProcessingCanary,
        });
        assert.equal(serializationReads, 0);
        assert.notEqual(written.catchUpAdmission, metrics);
        assert.notEqual(written.catchUpAdmission?.actionableBacklogBySource, metrics.actionableBacklogBySource);
        assert.notEqual(written.catchUpAdmission?.actionableBacklogByPriority, metrics.actionableBacklogByPriority);
        assert.ok(Object.isFrozen(written.catchUpAdmission));
        assert.ok(Object.isFrozen(written.catchUpAdmission?.actionableBacklogBySource));
        assert.ok(Object.isFrozen(written.catchUpAdmission?.actionableBacklogByPriority));
        assert.doesNotMatch(JSON.stringify(payload), /private-proxy-secret/u);
      } finally { await heartbeat.stop(); }
    });
  });
}

void test('catch-up admission counts reject malformed PostgreSQL values and inconsistent dimensions', async () => {
  const valid = {
    pending: '1', processing: '1', processed: '0', failed: '1', retryable_failed: '1', exhausted_failed: '0',
    decoder_quarantined: '0',
    websocket_only: '1', catch_up_only: '1', websocket_and_catch_up: '1',
    normal: '1', launch_candidate: '1', tracked_trade: '1', deferred: '0', ignored: '0', quarantined: '0',
  };
  for (const field of ['websocket_only', 'catch_up_only', 'websocket_and_catch_up',
    'normal', 'launch_candidate', 'tracked_trade', 'deferred', 'ignored', 'quarantined']) {
    for (const value of [-1, -0, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, undefined,
      '-1', '01', '1.5', '9007199254740992', 'https://private-secret.invalid']) {
      const repository = new PostgresTransactionInboxRepository({
        async connect() { throw new Error('Not used.'); },
        async query<Row extends pg.QueryResultRow>(): Promise<pg.QueryResult<Row>> {
          return { rows: [{ ...valid, [field]: value }] as unknown as Row[], rowCount: 1,
            command: 'SELECT', oid: 0, fields: [] };
        },
      });
      await assert.rejects(repository.counts(), (error: unknown) => {
        assert.ok(error instanceof TransactionInboxRepositoryError);
        assert.doesNotMatch(String(error), /private-secret/u);
        return true;
      });
    }
  }
  for (const patch of [{ websocket_only: '2' }, { tracked_trade: '2' }]) {
    const repository = new PostgresTransactionInboxRepository({
      async connect() { throw new Error('Not used.'); },
      async query<Row extends pg.QueryResultRow>(): Promise<pg.QueryResult<Row>> {
        return { rows: [{ ...valid, ...patch }] as unknown as Row[], rowCount: 1,
          command: 'SELECT', oid: 0, fields: [] };
      },
    });
    await assert.rejects(repository.counts(), TransactionInboxRepositoryError);
  }
});

void test('keeps durable ingestion independent of launchpad and market adapter imports', async () => {
  const source = await readFile(new URL('../src/storage/transaction-inbox.repository.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"][^'"]*(?:launchpads|markets)\//u);
});

void test('reads existing WebSocket, classified and terminal catch-up coverage without mutation', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const websocket = catchUpCoverageCandidate('coverage-websocket', 81n, 'processed');
    const classified = catchUpCoverageCandidate('coverage-classified', 82n, 'confirmed');
    const terminal = catchUpCoverageCandidate('coverage-terminal', 83n, 'confirmed');
    const missing = catchUpCoverageCandidate('coverage-missing', 84n, 'processed');
    await repository.enqueue(notification(terminal.signature, terminal.slot, 'WEBSOCKET', 'finalized'));
    const claim = await repository.claim(Date.now(), 30);
    assert.equal(claim?.signature, terminal.signature);
    if (claim === null) throw new Error('Expected terminal coverage claim.');
    await repository.saveSnapshot(terminal.signature, claim.leaseToken,
      normalized(terminal.signature, terminal.slot));
    await repository.markProcessed(terminal.signature, claim.leaseToken, 'finalized');
    await pool.query('DELETE FROM chain_transaction_inbox WHERE signature=$1', [terminal.signature]);
    await repository.enqueue(notification(websocket.signature, websocket.slot, 'WEBSOCKET', 'processed'));
    await repository.recordCatchUpClassification(createCatchUpClassification({
      ...catchUpClassificationInput(classified.signature), slot: classified.slot,
      confirmationStatus: classified.confirmationStatus,
    }));
    const before = await row(pool, websocket.signature);

    assert.deepEqual(await repository.readExistingCatchUpCoverage(
      [websocket, classified, terminal, missing], new AbortController().signal,
    ), [
      catchUpCoverageReceipt(websocket),
      catchUpCoverageReceipt(classified),
      catchUpCoverageReceipt(terminal),
    ]);
    assert.deepEqual(await row(pool, websocket.signature), before);
    assert.deepEqual((await row(pool, websocket.signature)).discovery_sources, ['WEBSOCKET']);
  });
});

void test('leaves finality advancement uncovered and fails closed on coverage identity conflicts', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const processed = catchUpCoverageCandidate('coverage-finality-advance', 85n, 'processed');
    await repository.enqueue(notification(processed.signature, processed.slot, 'WEBSOCKET', 'processed'));
    assert.deepEqual(await repository.readExistingCatchUpCoverage([
      catchUpCoverageCandidate(processed.signature, processed.slot, 'confirmed'),
    ], new AbortController().signal), []);
    await assert.rejects(repository.readExistingCatchUpCoverage([
      catchUpCoverageCandidate(processed.signature, 86n, 'processed'),
    ], new AbortController().signal), TransactionInboxConflictError);
  });
});

void test('covers WebSocket provenance after mutable trade routing converges to NONE', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const candidate = catchUpCoverageCandidate('coverage-trade-hint-converged', 86n, 'processed');
    await repository.recordCatchUpClassification(createCatchUpClassification({
      ...catchUpClassificationInput(candidate.signature), slot: candidate.slot,
      confirmationStatus: candidate.confirmationStatus,
      disposition: 'DEFERRED', reasonCode: 'PUMP_TRADE_UNTRACKED',
      ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: tradeMint, mints: [tradeMint],
    }));
    await repository.enqueue(notification(
      candidate.signature, candidate.slot, 'WEBSOCKET', candidate.confirmationStatus,
    ));
    const stored = await row(pool, candidate.signature);
    assert.equal(stored.ingestion_hint, 'NONE');
    assert.deepEqual(stored.discovery_sources, ['WEBSOCKET', 'CATCH_UP']);
    assert.deepEqual(await repository.readExistingCatchUpCoverage(
      [candidate], new AbortController().signal,
    ), [catchUpCoverageReceipt(candidate)]);
  });
});

void test('fails closed on success and failed-transaction outcome contradictions in both arrival orders', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const terminal = failedCatchUpClassification('coverage-terminal-failed-conflict', 89n);
    await repository.enqueue(notification(terminal.signature, terminal.slot, 'WEBSOCKET', 'finalized'));
    const claim = await repository.claim(Date.now(), 30);
    assert.equal(claim?.signature, terminal.signature);
    if (claim === null) throw new Error('Expected terminal conflict claim.');
    await repository.saveSnapshot(terminal.signature, claim.leaseToken,
      normalized(terminal.signature, terminal.slot));
    await repository.markProcessed(terminal.signature, claim.leaseToken, 'finalized');
    await pool.query('DELETE FROM chain_transaction_inbox WHERE signature=$1', [terminal.signature]);
    await assert.rejects(repository.recordCatchUpClassification(terminal), TransactionInboxConflictError);

    const successFirst = failedCatchUpClassification('coverage-success-first', 87n);
    await repository.enqueue(notification(successFirst.signature, successFirst.slot, 'WEBSOCKET', 'processed'));
    await assert.rejects(repository.recordCatchUpClassification(successFirst), TransactionInboxConflictError);

    const failedFirst = failedCatchUpClassification('coverage-failed-first', 88n);
    assert.equal((await repository.recordCatchUpClassification(failedFirst)).persistence, 'RECORDED');
    assert.equal((await repository.recordCatchUpClassification(failedFirst)).persistence, 'REPLAYED');
    await assert.rejects(
      repository.enqueue(notification(failedFirst.signature, failedFirst.slot, 'WEBSOCKET', 'processed')),
      TransactionInboxConflictError,
    );
  });
});

void test('returns exact fresh receipts for actionable, deferred and terminal classifications', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const actionable = catchUpClassification('receipt-fresh-actionable');
    const deferred = createCatchUpClassification({
      ...catchUpClassificationInput('receipt-fresh-deferred'),
      disposition: 'DEFERRED', reasonCode: 'PUMP_TRADE_UNTRACKED',
      ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: tradeMint,
    });
    const ignored = createCatchUpClassification({
      ...catchUpClassificationInput('receipt-fresh-ignored'),
      disposition: 'IGNORED', reasonCode: 'NO_SUPPORTED_PUMP_ACTION',
      ingestionHint: null, ingestionHintMint: null, mints: [],
    });

    assert.deepEqual(await repository.recordCatchUpClassification(actionable), {
      signature: actionable.signature, slot: actionable.slot, disposition: 'ACTIONABLE',
      persistence: 'RECORDED', admission: 'ENQUEUED', ingestionPriority: 'LAUNCH_CANDIDATE',
    });
    assert.deepEqual(await repository.recordCatchUpClassification(deferred), {
      signature: deferred.signature, slot: deferred.slot, disposition: 'DEFERRED',
      persistence: 'RECORDED', admission: 'NOT_ENQUEUED', ingestionPriority: null,
    });
    assert.deepEqual(await repository.recordCatchUpClassification(ignored), {
      signature: ignored.signature, slot: ignored.slot, disposition: 'IGNORED',
      persistence: 'RECORDED', admission: 'NOT_ENQUEUED', ingestionPriority: null,
    });
    assert.equal((await row(pool, actionable.signature)).catch_up_enqueued, true);
    assert.equal((await row(pool, actionable.signature)).catch_up_admission_priority, 'LAUNCH_CANDIDATE');
    assert.equal((await row(pool, deferred.signature)).catch_up_enqueued, false);
    assert.equal((await row(pool, deferred.signature)).catch_up_admission_priority, null);
    assert.equal((await row(pool, ignored.signature)).catch_up_enqueued, false);
    assert.equal((await row(pool, ignored.signature)).catch_up_admission_priority, null);
  });
});

void test('returns semantic replay receipts without rewriting historical catch-up admission', async (context) => {
  await withDatabase(context, async (pool) => {
    await insertTrackedLaunch(pool);
    const repository = new PostgresTransactionInboxRepository(pool);
    const classification = createCatchUpClassification({
      ...catchUpClassificationInput('receipt-replayed-tracked-deferred'),
      disposition: 'DEFERRED', reasonCode: 'PUMP_TRADE_UNTRACKED',
      ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: tradeMint,
    });
    const recorded = await repository.recordCatchUpClassification(classification);
    assert.deepEqual(recorded, {
      signature: classification.signature, slot: classification.slot, disposition: 'DEFERRED',
      persistence: 'RECORDED', admission: 'ENQUEUED', ingestionPriority: 'TRACKED_TRADE',
    });

    await pool.query('UPDATE token_launches SET terminal_at=clock_timestamp() WHERE mint=$1', [tradeMint]);
    await repository.syncTrackedMint(tradeMint);
    const replayed = await repository.recordCatchUpClassification(createCatchUpClassification({
      ...classification, observedAtMs: 2_000, classifiedAtMs: 2_001,
    }));

    assert.equal(replayed.persistence, 'REPLAYED');
    assert.equal(replayed.admission, 'ENQUEUED');
    assert.equal(replayed.ingestionPriority, 'TRACKED_TRADE');
    const stored = await row(pool, classification.signature);
    assert.equal(stored.catch_up_enqueued, true);
    assert.equal(stored.catch_up_admission_priority, 'TRACKED_TRADE');
    assert.equal(stored.ingestion_priority, 'NORMAL');
    assert.equal(stored.processing_status, 'DEFERRED');
  });
});

void test('records catch-up evidence on pristine WebSocket work without a second admission', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const classification = catchUpClassification('receipt-websocket-pristine');
    await repository.enqueue(notification(
      classification.signature, classification.slot, 'WEBSOCKET', 'processed', 1_000,
      'PUMPFUN_CREATE',
    ));

    const receipt = await repository.recordCatchUpClassification(classification);

    assert.deepEqual(receipt, {
      signature: classification.signature, slot: classification.slot, disposition: 'ACTIONABLE',
      persistence: 'RECORDED', admission: 'NOT_ENQUEUED', ingestionPriority: null,
    });
    const stored = await row(pool, classification.signature);
    assert.equal(stored.catch_up_enqueued, false);
    assert.equal(stored.catch_up_admission_priority, null);
    assert.equal(stored.processing_status, 'PENDING');
    assert.equal(stored.ingestion_priority, 'LAUNCH_CANDIDATE');
    assert.deepEqual(stored.discovery_sources, ['WEBSOCKET', 'CATCH_UP']);
  });
});

void test('records catch-up admission when tracked membership promotes existing deferred WebSocket work', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const promotedSignature = 'receipt-websocket-deferred-promotion';
    await repository.enqueue(tradeNotification(promotedSignature, 1n));
    assert.equal((await row(pool, promotedSignature)).processing_status, 'DEFERRED');
    await insertTrackedLaunch(pool);
    const promotedClassification = createCatchUpClassification({
      ...catchUpClassificationInput(promotedSignature),
      disposition: 'DEFERRED', reasonCode: 'PUMP_TRADE_UNTRACKED',
      ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: tradeMint,
    });

    assert.deepEqual(await repository.recordCatchUpClassification(promotedClassification), {
      signature: promotedSignature, slot: 1n, disposition: 'DEFERRED',
      persistence: 'RECORDED', admission: 'ENQUEUED', ingestionPriority: 'TRACKED_TRADE',
    });
    const promoted = await row(pool, promotedSignature);
    assert.equal(promoted.processing_status, 'PENDING');
    assert.equal(promoted.ingestion_priority, 'TRACKED_TRADE');
    assert.equal(promoted.catch_up_enqueued, true);
    assert.equal(promoted.catch_up_admission_priority, 'TRACKED_TRADE');
    assert.deepEqual(await repository.recordCatchUpClassification(promotedClassification), {
      signature: promotedSignature, slot: 1n, disposition: 'DEFERRED',
      persistence: 'REPLAYED', admission: 'ENQUEUED', ingestionPriority: 'TRACKED_TRADE',
    });

    const pendingSignature = 'receipt-websocket-existing-pending';
    await repository.enqueue(tradeNotification(pendingSignature, 2n));
    const pendingClassification = createCatchUpClassification({
      ...catchUpClassificationInput(pendingSignature), slot: 2n,
      disposition: 'DEFERRED', reasonCode: 'PUMP_TRADE_UNTRACKED',
      ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: tradeMint,
    });
    assert.deepEqual(await repository.recordCatchUpClassification(pendingClassification), {
      signature: pendingSignature, slot: 2n, disposition: 'DEFERRED',
      persistence: 'RECORDED', admission: 'NOT_ENQUEUED', ingestionPriority: null,
    });
    assert.equal((await row(pool, pendingSignature)).catch_up_enqueued, false);
    assert.equal((await row(pool, pendingSignature)).catch_up_admission_priority, null);
  });
});

void test('annotates non-pristine WebSocket work while preserving its active processing cycle', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const classification = catchUpClassification('receipt-websocket-processing');
    await repository.enqueue(notification(
      classification.signature, classification.slot, 'WEBSOCKET', 'processed', 1_000,
      'PUMPFUN_CREATE',
    ));
    const claim = await repository.claim(1_001, 30);
    assert.equal(claim?.signature, classification.signature);

    const receipt = await repository.recordCatchUpClassification(classification);

    assert.equal(receipt.persistence, 'RECORDED');
    assert.equal(receipt.admission, 'NOT_ENQUEUED');
    const stored = await row(pool, classification.signature);
    assert.equal(stored.processing_status, 'PROCESSING');
    assert.equal(stored.lease_token, claim.leaseToken);
    assert.equal(stored.attempts, 1);
    assert.equal(stored.catch_up_enqueued, false);
    assert.equal(stored.catch_up_disposition, 'ACTIONABLE');
  });
});

void test('terminal classifications terminalize pristine WebSocket work and preserve active lifecycle state', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const pristineSignature = 'receipt-websocket-terminal-pristine';
    await repository.enqueue(notification(pristineSignature, 1n, 'WEBSOCKET', 'processed', 1_000));
    const pristineClassification = createCatchUpClassification({
      ...catchUpClassificationInput(pristineSignature),
      disposition: 'IGNORED', reasonCode: 'NO_SUPPORTED_PUMP_ACTION',
      ingestionHint: null, ingestionHintMint: null, mints: [],
    });
    assert.equal((await repository.recordCatchUpClassification(pristineClassification)).admission,
      'NOT_ENQUEUED');
    const pristine = await row(pool, pristineSignature);
    assert.equal(pristine.processing_status, 'IGNORED');
    assert.equal(pristine.catch_up_enqueued, false);
    assert.equal(pristine.terminal_at.getTime(), pristineClassification.classifiedAtMs);

    const signature = 'receipt-websocket-terminal-processing';
    await repository.enqueue(notification(signature, 1n, 'WEBSOCKET', 'processed', 1_000));
    const claim = await repository.claim(1_001, 30);
    assert.equal(claim?.signature, signature);
    const classification = createCatchUpClassification({
      ...catchUpClassificationInput(signature),
      disposition: 'IGNORED', reasonCode: 'NO_SUPPORTED_PUMP_ACTION',
      ingestionHint: null, ingestionHintMint: null, mints: [],
    });

    const receipt = await repository.recordCatchUpClassification(classification);

    assert.deepEqual(receipt, {
      signature, slot: 1n, disposition: 'IGNORED', persistence: 'RECORDED',
      admission: 'NOT_ENQUEUED', ingestionPriority: null,
    });
    const stored = await row(pool, signature);
    assert.equal(stored.processing_status, 'PROCESSING');
    assert.equal(stored.lease_token, claim.leaseToken);
    assert.equal(stored.catch_up_disposition, 'IGNORED');
    assert.equal(stored.catch_up_enqueued, false);
  });
});

void test('ordinary finality discovery replays a nonterminal WebSocket lifecycle with terminal catch-up evidence', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const signature = 'receipt-websocket-terminal-finality-replay';
    await repository.enqueue(notification(signature, 1n, 'WEBSOCKET', 'confirmed', 1_000));
    const claim = await repository.claim(1_001, 30);
    assert.ok(claim);
    await repository.saveSnapshot(signature, claim.leaseToken, normalized(signature, 1n));
    await repository.markProcessed(signature, claim.leaseToken, 'confirmed');
    const classification = createCatchUpClassification({
      ...catchUpClassificationInput(signature),
      disposition: 'IGNORED', reasonCode: 'NO_SUPPORTED_PUMP_ACTION',
      ingestionHint: null, ingestionHintMint: null, mints: [],
    });
    await repository.recordCatchUpClassification(classification);
    assert.equal((await row(pool, signature)).processing_status, 'PROCESSED');

    const finalizedDiscovery = Object.freeze({
      ...notification(signature, 1n, 'WEBSOCKET', 'finalized', 2_000, 'PUMPFUN_CREATE'),
      programIds: Object.freeze([PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort()),
    });
    await repository.enqueue(finalizedDiscovery);
    await repository.enqueue(Object.freeze({ ...finalizedDiscovery, observedAtMs: 2_001 }));

    const replayed = await row(pool, signature);
    assert.equal(replayed.target_confirmation_status, 'finalized');
    assert.equal(replayed.processing_status, 'PENDING');
    assert.equal(replayed.processed_at, null);
    assert.equal(replayed.ingestion_priority, 'NORMAL');
    assert.equal(replayed.ingestion_hint, 'NONE');
    assert.equal(replayed.ingestion_hint_mint, null);
    assert.equal(replayed.catch_up_disposition, 'IGNORED');
    assert.equal(replayed.catch_up_enqueued, false);
    assert.deepEqual(replayed.program_ids, [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort());
    assert.equal((await repository.claim(2_002, 30))?.signature, signature);
  });
});

void test('reopens confirmed WebSocket work for finalized replay while recording no catch-up admission', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const signature = 'receipt-websocket-confirmed-finalized';
    await repository.enqueue(notification(
      signature, 1n, 'WEBSOCKET', 'confirmed', 1_000, 'PUMPFUN_CREATE',
    ));
    const claim = await repository.claim(1_001, 30);
    assert.ok(claim);
    await repository.saveSnapshot(signature, claim.leaseToken, normalized(signature, 1n));
    await repository.markProcessed(signature, claim.leaseToken, 'confirmed');
    const finalized = createCatchUpClassification({
      ...catchUpClassificationInput(signature), confirmationStatus: 'finalized',
      observedAtMs: 2_000, classifiedAtMs: 2_001,
    });

    const receipt = await repository.recordCatchUpClassification(finalized);

    assert.deepEqual(receipt, {
      signature, slot: 1n, disposition: 'ACTIONABLE', persistence: 'RECORDED',
      admission: 'NOT_ENQUEUED', ingestionPriority: null,
    });
    const stored = await row(pool, signature);
    assert.equal(stored.target_confirmation_status, 'finalized');
    assert.equal(stored.processing_status, 'PENDING');
    assert.equal(stored.processed_at, null);
    assert.equal(stored.finality_evidence_version, '1');
    assert.equal(stored.catch_up_enqueued, false);
  });
});

void test('atomically persists an actionable catch-up classification as one inbox row', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const classification = catchUpClassification('classified-actionable');
    await repository.recordCatchUpClassification(classification);
    const stored = await row(pool, classification.signature);
    assert.deepEqual({
      status: stored.processing_status,
      source: stored.discovery_sources,
      hint: stored.ingestion_hint,
      version: stored.catch_up_classification_version,
      disposition: stored.catch_up_disposition,
      reason: stored.catch_up_reason_code,
      actionKey: stored.catch_up_action_key,
      mints: stored.catch_up_mints,
      fingerprint: stored.catch_up_evidence_fingerprint,
      classifiedAtMs: stored.catch_up_classified_at.getTime(),
    }, {
      status: 'PENDING', source: ['CATCH_UP'], hint: 'PUMPFUN_CREATE', version: 1,
      disposition: 'ACTIONABLE', reason: 'PUMP_ACTION_SUPPORTED',
      actionKey: 'PUMPFUN_CREATE',
      mints: [tradeMint], fingerprint: 'a'.repeat(64), classifiedAtMs: 1_001,
    });
    assert.equal((await repository.claim(1_001, 30))?.signature, classification.signature);
  });
});

void test('persists ignored and quarantined classifications as non-claimable four-hour evidence', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    for (const [signature, disposition, reasonCode] of [
      ['classified-ignored', 'IGNORED', 'NO_SUPPORTED_PUMP_ACTION'],
      ['classified-quarantined', 'QUARANTINED', 'PUMP_SCHEMA_UNSUPPORTED'],
    ] as const) {
      const classification = createCatchUpClassification({
        ...catchUpClassificationInput(signature), disposition, reasonCode,
        ingestionHint: null, ingestionHintMint: null, mints: [],
      });
      await repository.recordCatchUpClassification(classification);
      const stored = await row(pool, signature);
      assert.equal(stored.processing_status, disposition);
      assert.equal(stored.terminal_at.getTime(), classification.classifiedAtMs);
      assert.equal(stored.purge_after.getTime() - stored.terminal_at.getTime(), 14_400_000);
    }
    assert.equal(await repository.claim(1_001, 30), null);
    assert.deepEqual(await repository.counts(), {
      pending: 0, processing: 0, processed: 0, failed: 0,
      retryableFailed: 0, exhaustedFailed: 0, decoderQuarantinedCount: 0,
      catchUpAdmission: {
        actionableBacklogBySource: { websocketOnly: 0, catchUpOnly: 0, websocketAndCatchUp: 0 },
        actionableBacklogByPriority: { normal: 0, launchCandidate: 0, trackedTrade: 0 },
        deferredCount: 0, ignoredCount: 1, quarantinedCount: 1,
      },
    });
  });
});

void test('ordinary discovery converges terminal catch-up evidence without resurrecting it', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    for (const [signature, disposition, reasonCode] of [
      ['classified-ignored-discovery', 'IGNORED', 'NO_SUPPORTED_PUMP_ACTION'],
      ['classified-quarantined-discovery', 'QUARANTINED', 'PUMP_SCHEMA_UNSUPPORTED'],
    ] as const) {
      const classification = createCatchUpClassification({
        ...catchUpClassificationInput(signature), disposition, reasonCode,
        ingestionHint: null, ingestionHintMint: null, mints: [],
      });
      await repository.recordCatchUpClassification(classification);
      const before = await row(pool, signature);
      const discovery = Object.freeze({
        ...notification(signature, classification.slot, 'WEBSOCKET', 'finalized', 1_002,
          'PUMPFUN_CREATE'),
        programIds: Object.freeze([PUMPSWAP_PROGRAM_ID]),
      });

      await repository.enqueue(discovery);
      await repository.enqueue(discovery);

      const stored = await row(pool, signature);
      assert.deepEqual(stored.discovery_sources, ['WEBSOCKET', 'CATCH_UP']);
      assert.deepEqual(stored.program_ids, [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort());
      assert.equal(stored.target_confirmation_status, 'finalized');
      assert.equal(stored.processing_status, disposition);
      assert.equal(stored.ingestion_priority, 'NORMAL');
      assert.equal(stored.ingestion_hint, 'NONE');
      assert.equal(stored.ingestion_hint_mint, null);
      assert.equal(stored.finality_evidence_version, '0');
      assert.equal(stored.terminal_at.getTime(), before.terminal_at.getTime());
      assert.equal(stored.purge_after.getTime(), before.purge_after.getTime());
    }
    assert.equal(await repository.claim(1_003, 30), null);
  });
});

void test('replays semantic classification with a newer clock without extending durable timestamps', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    for (const [signature, disposition, reasonCode, ingestionHint, ingestionHintMint] of [
      ['classified-replay-actionable', 'ACTIONABLE', 'PUMP_ACTION_SUPPORTED', 'PUMPFUN_CREATE', null],
      ['classified-replay-deferred', 'DEFERRED', 'PUMP_TRADE_UNTRACKED', 'PUMPFUN_TRADE', tradeMint],
      ['classified-replay-ignored', 'IGNORED', 'NO_SUPPORTED_PUMP_ACTION', null, null],
      ['classified-replay-quarantined', 'QUARANTINED', 'PUMP_SCHEMA_UNSUPPORTED', null, null],
    ] as const) {
      const classification = createCatchUpClassification({
        ...catchUpClassificationInput(signature),
        disposition, reasonCode, ingestionHint, ingestionHintMint,
        mints: disposition === 'IGNORED' || disposition === 'QUARANTINED'
          ? Object.freeze([]) : Object.freeze([tradeMint]),
      });
      await repository.recordCatchUpClassification(classification);
      const before = await row(pool, classification.signature);

      await repository.recordCatchUpClassification(createCatchUpClassification({
        ...classification,
        observedAtMs: 2_000,
        classifiedAtMs: 2_001,
      }));

      const replayed = await row(pool, classification.signature);
      assert.equal(replayed.observed_at.getTime(), before.observed_at.getTime());
      assert.equal(replayed.catch_up_classified_at.getTime(), before.catch_up_classified_at.getTime());
      assert.equal(replayed.terminal_at?.getTime() ?? null, before.terminal_at?.getTime() ?? null);
      assert.equal(replayed.purge_after?.getTime() ?? null, before.purge_after?.getTime() ?? null);
    }
  });
});

void test('semantic classification replay still rejects immutable contradictions', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const classification = createCatchUpClassification({
      ...catchUpClassificationInput('classified-replay-contradiction'),
      ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: tradeMint,
      mints: ['11111111111111111111111111111111', tradeMint].sort(),
    });
    await repository.recordCatchUpClassification(classification);
    const before = await row(pool, classification.signature);
    for (const changed of [
      { evidenceFingerprint: 'b'.repeat(64) },
      { disposition: 'DEFERRED', reasonCode: 'PUMP_TRADE_UNTRACKED' },
    ]) {
      const contradictory = createCatchUpClassification({
        ...catchUpClassificationInput(classification.signature),
        ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: tradeMint,
        mints: ['11111111111111111111111111111111', tradeMint].sort(),
        ...changed,
      });
      await assert.rejects(repository.recordCatchUpClassification(contradictory), (error: unknown) =>
        error instanceof TransactionInboxConflictError && error.conflict === 'classification');
    }
    assert.deepEqual(await row(pool, classification.signature), before);
  });
});

void test('semantic deferred replay clears its original retention only when the mint becomes active', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const classification = createCatchUpClassification({
      ...catchUpClassificationInput('classified-deferred-replay-promotion'),
      disposition: 'DEFERRED', reasonCode: 'PUMP_TRADE_UNTRACKED',
      ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: tradeMint,
    });
    await repository.recordCatchUpClassification(classification);
    const before = await row(pool, classification.signature);
    assert.equal(before.processing_status, 'DEFERRED');
    assert.equal(before.terminal_at.getTime(), classification.classifiedAtMs);
    assert.equal(before.purge_after.getTime(), classification.classifiedAtMs + 14_400_000);

    await insertTrackedLaunch(pool);
    await repository.recordCatchUpClassification(createCatchUpClassification({
      ...classification,
      observedAtMs: 2_000,
      classifiedAtMs: 2_001,
    }));

    const promoted = await row(pool, classification.signature);
    assert.equal(promoted.processing_status, 'PENDING');
    assert.equal(promoted.ingestion_priority, 'TRACKED_TRADE');
    assert.equal(promoted.terminal_at, null);
    assert.equal(promoted.purge_after, null);
    assert.equal(promoted.observed_at.getTime(), before.observed_at.getTime());
    assert.equal(promoted.catch_up_classified_at.getTime(), before.catch_up_classified_at.getTime());
  });
});

void test('semantic deferred replay starts retention when an unsynchronized mint becomes inactive', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const classification = createCatchUpClassification({
      ...catchUpClassificationInput('classified-deferred-replay-demotion'),
      disposition: 'DEFERRED', reasonCode: 'PUMP_TRADE_UNTRACKED',
      ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: tradeMint,
    });
    await insertTrackedLaunch(pool);
    await repository.recordCatchUpClassification(classification);
    const admitted = await row(pool, classification.signature);
    assert.equal(admitted.processing_status, 'PENDING');
    assert.equal(admitted.terminal_at, null);
    assert.equal(admitted.purge_after, null);

    await pool.query('UPDATE token_launches SET terminal_at=clock_timestamp() WHERE mint=$1', [tradeMint]);
    await repository.recordCatchUpClassification(createCatchUpClassification({
      ...classification,
      observedAtMs: 2_000,
      classifiedAtMs: 2_001,
    }));

    const deferred = await row(pool, classification.signature);
    assert.equal(deferred.processing_status, 'DEFERRED');
    assert.equal(deferred.ingestion_priority, 'NORMAL');
    assert.equal(deferred.terminal_at.getTime(), 2_001);
    assert.equal(deferred.purge_after.getTime(), 2_001 + 14_400_000);
    assert.equal(deferred.observed_at.getTime(), classification.observedAtMs);
    assert.equal(deferred.catch_up_classified_at.getTime(), classification.classifiedAtMs);

    await repository.recordCatchUpClassification(createCatchUpClassification({
      ...classification,
      observedAtMs: 3_000,
      classifiedAtMs: 3_001,
    }));
    const replayed = await row(pool, classification.signature);
    assert.equal(replayed.terminal_at.getTime(), deferred.terminal_at.getTime());
    assert.equal(replayed.purge_after.getTime(), deferred.purge_after.getTime());
    assert.equal(replayed.catch_up_classified_at.getTime(), classification.classifiedAtMs);
  });
});

void test('classification replay merges admissible programs and advances confirmed evidence to finalized', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const initial = catchUpClassification('classified-convergent-replay');
    await repository.recordCatchUpClassification(initial);
    const replay = createCatchUpClassification({
      ...catchUpClassificationInput(initial.signature),
      programIds: Object.freeze([PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort()),
      confirmationStatus: 'finalized',
    });

    await repository.recordCatchUpClassification(replay);

    const stored = await row(pool, initial.signature);
    assert.deepEqual(stored.program_ids, [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort());
    assert.equal(stored.target_confirmation_status, 'finalized');
    assert.equal(stored.ingestion_hint, 'PUMPFUN_CREATE');
    assert.equal(stored.ingestion_hint_mint, null);

    await repository.recordCatchUpClassification(initial);
    const staleReplay = await row(pool, initial.signature);
    assert.deepEqual(staleReplay.program_ids, [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort());
    assert.equal(staleReplay.target_confirmation_status, 'finalized');
  });
});

void test('classification finality replay reprocesses a confirmed snapshot before projecting finalized', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const initial = catchUpClassification('classified-processed-finality-replay');
    await repository.recordCatchUpClassification(initial);
    const firstClaim = await repository.claim(1_001, 30);
    assert.ok(firstClaim);
    await repository.saveSnapshot(initial.signature, firstClaim.leaseToken,
      normalized(initial.signature, initial.slot));
    await repository.markProcessed(initial.signature, firstClaim.leaseToken, 'confirmed');

    const finalizedReplay = createCatchUpClassification({
      ...catchUpClassificationInput(initial.signature),
      confirmationStatus: 'finalized',
      observedAtMs: 2_000,
      classifiedAtMs: 2_001,
    });
    await repository.recordCatchUpClassification(finalizedReplay);

    const replayPending = await row(pool, initial.signature);
    assert.equal(replayPending.target_confirmation_status, 'finalized');
    assert.equal(replayPending.processing_status, 'PENDING');
    assert.equal(replayPending.processed_at, null);
    assert.equal(replayPending.terminal_at, null);
    assert.equal(replayPending.purge_after, null);
    assert.equal(replayPending.finality_evidence_version, '1');
    assert.equal(replayPending.observed_at.getTime(), initial.observedAtMs);
    assert.equal(replayPending.catch_up_classified_at.getTime(), initial.classifiedAtMs);
    const secondClaim = await repository.claim(1_003, 30);
    assert.ok(secondClaim?.normalizedTransaction);
    assert.equal(secondClaim.confirmationStatus, 'finalized');
    await repository.saveSnapshot(initial.signature, secondClaim.leaseToken,
      normalized(initial.signature, initial.slot));
    await repository.markProcessed(initial.signature, secondClaim.leaseToken, 'finalized');
    assert.equal((await row(pool, initial.signature)).processing_status, 'PROCESSED');
    assert.equal(await repository.claim(1_004, 30), null);
  });
});

void test('classification replay rejects a changed immutable action hint', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const initial = catchUpClassification('classified-action-contradiction');
    await repository.recordCatchUpClassification(initial);
    const contradictory = createCatchUpClassification({
      ...catchUpClassificationInput(initial.signature),
      ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: tradeMint,
    });

    await assert.rejects(repository.recordCatchUpClassification(contradictory), (error: unknown) =>
      error instanceof TransactionInboxConflictError && error.conflict === 'classification');
    assert.equal((await row(pool, initial.signature)).ingestion_hint, 'PUMPFUN_CREATE');
  });
});

void test('trade classification replay preserves immutable trade evidence after multi-program hint convergence', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const classification = createCatchUpClassification({
      ...catchUpClassificationInput('classified-trade-multi-program'),
      ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: tradeMint,
    });
    await repository.recordCatchUpClassification(classification);
    await repository.enqueue(Object.freeze({
      ...notification(classification.signature, classification.slot, 'CATCH_UP', 'finalized'),
      programIds: Object.freeze([PUMPSWAP_PROGRAM_ID]),
    }));
    assert.deepEqual(ingestionDecision(await row(pool, classification.signature)), {
      processing_status: 'PENDING', ingestion_priority: 'NORMAL',
      ingestion_hint: 'NONE', ingestion_hint_mint: null,
    });

    await repository.recordCatchUpClassification(createCatchUpClassification({
      ...catchUpClassificationInput(classification.signature),
      ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: tradeMint,
      programIds: Object.freeze([PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort()),
      confirmationStatus: 'finalized',
    }));
    const replayed = await row(pool, classification.signature);
    assert.deepEqual(replayed.program_ids, [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort());
    assert.equal(replayed.target_confirmation_status, 'finalized');
    assert.equal(replayed.ingestion_hint, 'NONE');

    await assert.rejects(repository.recordCatchUpClassification(createCatchUpClassification({
      ...catchUpClassificationInput(classification.signature),
      programIds: Object.freeze([PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort()),
      confirmationStatus: 'finalized',
    })), (error: unknown) =>
      error instanceof TransactionInboxConflictError && error.conflict === 'classification');
  });
});

void test('deferred classification shares the mint lock and admits a concurrently active mint without deadlock', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const blocker = await pool.connect();
    const classification = createCatchUpClassification({
      ...catchUpClassificationInput('classified-projection-race'),
      disposition: 'DEFERRED', reasonCode: 'PUMP_TRADE_UNTRACKED',
      ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: tradeMint,
    });
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('transaction-inbox-mint:' || $1, 0))",
        [tradeMint],
      );
      const record = repository.recordCatchUpClassification(classification);
      await waitForActiveAdvisoryWait(pool, 'transaction-inbox-mint:');
      await insertTrackedLaunch(pool);
      const sync = repository.syncTrackedMint(tradeMint);
      await blocker.query('COMMIT');
      await Promise.all([record, sync]);

      assert.deepEqual(ingestionDecision(await row(pool, classification.signature)), {
        processing_status: 'PENDING', ingestion_priority: 'TRACKED_TRADE',
        ingestion_hint: 'PUMPFUN_TRADE', ingestion_hint_mint: tradeMint,
      });
      assert.equal((await row(pool, classification.signature)).terminal_at, null);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
});

void test('classification and enqueue use one mint-before-signature lock order for the same trade', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const blocker = await pool.connect();
    const signature = 'classified-enqueue-lock-order';
    const classification = createCatchUpClassification({
      ...catchUpClassificationInput(signature),
      disposition: 'DEFERRED', reasonCode: 'PUMP_TRADE_UNTRACKED',
      ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: tradeMint,
    });
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('transaction-inbox-mint:' || $1, 0))",
        [tradeMint],
      );
      const record = repository.recordCatchUpClassification(classification);
      await waitForActiveAdvisoryWait(pool, 'transaction-inbox-mint:', 1);
      const enqueue = repository.enqueue(tradeNotification(signature, classification.slot));
      await waitForActiveAdvisoryWait(pool, 'transaction-inbox-mint:', 2);
      await insertTrackedLaunch(pool);
      await blocker.query('COMMIT');
      await settlesWithin(Promise.all([record, enqueue]), 2_000);

      assert.deepEqual(ingestionDecision(await row(pool, signature)), {
        processing_status: 'PENDING', ingestion_priority: 'TRACKED_TRADE',
        ingestion_hint: 'PUMPFUN_TRADE', ingestion_hint_mint: tradeMint,
      });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
});

void test('adds classification to a pristine discovery atomically and rolls back a rejected write', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const classification = catchUpClassification('classified-existing');
    await repository.enqueue(notification(classification.signature, classification.slot));
    await repository.recordCatchUpClassification(classification);
    assert.deepEqual((await row(pool, classification.signature)).discovery_sources,
      ['WEBSOCKET', 'CATCH_UP']);

    await pool.query(`CREATE FUNCTION reject_classification_for_test() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN IF NEW.signature='classified-rollback' AND NEW.catch_up_disposition IS NOT NULL
        THEN RAISE EXCEPTION 'forced'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER reject_classification_for_test BEFORE INSERT OR UPDATE
      ON chain_transaction_inbox FOR EACH ROW EXECUTE FUNCTION reject_classification_for_test()`);
    await assert.rejects(repository.recordCatchUpClassification(catchUpClassification('classified-rollback')),
      TransactionInboxRepositoryError);
    assert.equal((await pool.query("SELECT COUNT(*) FROM chain_transaction_inbox WHERE signature='classified-rollback'"))
      .rows[0]?.count, '0');
  });
});

void test('rejects mutable and non-canonical classification before database access', async () => {
  let accesses = 0;
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => { accesses += 1; throw new Error('must not connect'); },
    query: async () => { accesses += 1; throw new Error('must not query'); },
  });
  const classification = catchUpClassification('classified-invalid');
  await assert.rejects(repository.recordCatchUpClassification({ ...classification }),
    TransactionInboxRepositoryError);
  assert.equal(accesses, 0);
});

void test('defers untracked trade hints durably without claims, finality, retry or actionable counts', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(tradeNotification('untracked', 1n));
    const stored = await row(pool, 'untracked');
    assert.deepEqual(ingestionDecision(stored), {
      processing_status: 'DEFERRED', ingestion_priority: 'NORMAL',
      ingestion_hint: 'PUMPFUN_TRADE', ingestion_hint_mint: tradeMint,
    });
    assert.equal(stored.purge_after.getTime() - stored.terminal_at.getTime(), 14_400_000);
    assert.equal(await repository.claim(Date.now(), 30), null);
    assert.deepEqual(await repository.listForFinality(10), []);
    assert.deepEqual(await repository.recoverExhausted('untracked'), {
      code: 'RECOVERY_NOT_ELIGIBLE', signature: 'untracked',
    });
    assert.deepEqual(await repository.counts(), {
      pending: 0, processing: 0, processed: 0, failed: 0, retryableFailed: 0,
      exhaustedFailed: 0, decoderQuarantinedCount: 0,
      catchUpAdmission: {
        actionableBacklogBySource: { websocketOnly: 0, catchUpOnly: 0, websocketAndCatchUp: 0 },
        actionableBacklogByPriority: { normal: 0, launchCandidate: 0, trackedTrade: 0 },
        deferredCount: 1, ignoredCount: 0, quarantinedCount: 0,
      },
    });
    assert.deepEqual(await row(pool, 'untracked'), stored);
  });
});

void test('uses canonical active launch membership at enqueue and rejects terminal membership', async (context) => {
  await withDatabase(context, async (pool) => {
    await insertTrackedLaunch(pool);
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(tradeNotification('tracked', 10n));
    assert.deepEqual(ingestionDecision(await row(pool, 'tracked')), {
      processing_status: 'PENDING', ingestion_priority: 'TRACKED_TRADE',
      ingestion_hint: 'PUMPFUN_TRADE', ingestion_hint_mint: tradeMint,
    });
    await pool.query('UPDATE token_launches SET terminal_at=clock_timestamp()');
    await repository.enqueue(tradeNotification('terminal', 11n));
    assert.equal((await row(pool, 'terminal')).processing_status, 'DEFERRED');
  });
});

void test('catch-up replay preserves a deferred decision and retention while unknown signatures stay normal', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(tradeNotification('replayed-trade', 1n));
    const original = await row(pool, 'replayed-trade');
    await repository.enqueue(pumpCatchUpNotification('replayed-trade', 1n, 'confirmed'));
    await repository.enqueue(tradeNotification('replayed-trade', 1n));
    const replayed = await row(pool, 'replayed-trade');
    assert.deepEqual(ingestionDecision(replayed), ingestionDecision(original));
    assert.deepEqual(replayed.terminal_at, original.terminal_at);
    assert.deepEqual(replayed.purge_after, original.purge_after);
    assert.equal(replayed.finality_evidence_version, '0');
    assert.deepEqual(replayed.discovery_sources, ['WEBSOCKET', 'CATCH_UP']);
    await repository.enqueue(notification('unknown-catch-up', 2n, 'CATCH_UP'));
    assert.equal((await repository.claim(Date.now(), 30))?.signature, 'unknown-catch-up');
  });
});

void test('late create reactivates deferred signatures and never downgrades to trade or NONE', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(tradeNotification('late-create', 1n));
    await repository.enqueue(notification('late-create', 1n, 'WEBSOCKET', 'processed', 1000, 'PUMPFUN_CREATE'));
    await repository.enqueue(tradeNotification('late-create', 1n));
    await repository.enqueue(notification('late-create', 1n, 'CATCH_UP'));
    const stored = await row(pool, 'late-create');
    assert.deepEqual(ingestionDecision(stored), {
      processing_status: 'PENDING', ingestion_priority: 'LAUNCH_CANDIDATE',
      ingestion_hint: 'PUMPFUN_CREATE', ingestion_hint_mint: null,
    });
    assert.equal(stored.terminal_at, null);
    assert.equal(stored.purge_after, null);
    assert.equal((await repository.claim(Date.now(), 30))?.signature, 'late-create');
  });
});

void test('multi-adapter discoveries remain normal in both orders across restart, replay and inactive synchronization', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    for (const reversed of [false, true]) {
      const signature = `multi-adapter-${reversed}`;
      const pump = tradeNotification(signature, 1n);
      const swap = Object.freeze({ ...notification(signature, 1n), programIds: Object.freeze([PUMPSWAP_PROGRAM_ID]) });
      for (const discovery of reversed ? [swap, pump] : [pump, swap]) await repository.enqueue(discovery);
      const restarted = new PostgresTransactionInboxRepository(pool);
      await restarted.enqueue(pump);
      await restarted.enqueue(Object.freeze({ ...swap, source: 'CATCH_UP' as const }));
      await restarted.syncTrackedMint(tradeMint);
      const stored = await row(pool, signature);
      assert.deepEqual(ingestionDecision(stored), {
        processing_status: 'PENDING', ingestion_priority: 'NORMAL', ingestion_hint: 'NONE', ingestion_hint_mint: null,
      });
      assert.equal(stored.terminal_at, null);
      assert.equal(stored.purge_after, null);
      assert.deepEqual(stored.program_ids, [PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort());
      assert.equal((await restarted.claim(Date.now(), 30))?.signature, signature);
    }
  });
});

void test('inactive synchronization repairs legacy multi-adapter deferred and pending decisions', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(tradeNotification('legacy-multi-deferred', 1n));
    await insertTrackedLaunch(pool);
    await repository.enqueue(tradeNotification('legacy-multi-pending', 2n));
    await pool.query('UPDATE chain_transaction_inbox SET program_ids=$1', [[PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort()]);
    await pool.query('UPDATE token_launches SET terminal_at=clock_timestamp()');
    await repository.syncTrackedMint(tradeMint);
    for (const signature of ['legacy-multi-deferred', 'legacy-multi-pending']) {
      const stored = await row(pool, signature);
      assert.deepEqual(ingestionDecision(stored), {
        processing_status: 'PENDING', ingestion_priority: 'NORMAL', ingestion_hint: 'NONE', ingestion_hint_mint: null,
      });
      assert.equal(stored.terminal_at, null);
      assert.equal(stored.purge_after, null);
      assert.equal((await repository.claim(Date.now(), 30))?.signature, signature);
    }
  });
});

void test('ambiguous WebSocket NONE stays normal while catch-up-only NONE may gain a trade decision', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(notification('ambiguous-websocket', 1n));
    await repository.enqueue(pumpCatchUpNotification('catch-up-only', 2n));
    const restarted = new PostgresTransactionInboxRepository(pool);
    await restarted.enqueue(tradeNotification('ambiguous-websocket', 1n));
    await restarted.enqueue(tradeNotification('catch-up-only', 2n));
    assert.deepEqual(ingestionDecision(await row(pool, 'ambiguous-websocket')), {
      processing_status: 'PENDING', ingestion_priority: 'NORMAL', ingestion_hint: 'NONE', ingestion_hint_mint: null,
    });
    assert.equal((await row(pool, 'catch-up-only')).processing_status, 'DEFERRED');
    await restarted.syncTrackedMint(tradeMint);
    assert.equal((await restarted.claim(Date.now(), 30))?.signature, 'ambiguous-websocket');
  });
});

void test('contradictory trade hints become durably normal across restart and duplicate hints', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(tradeNotification('conflicting-mint', 1n));
    await repository.enqueue(tradeNotification('conflicting-mint', 1n, PUMP_PROGRAM_ID));
    const restarted = new PostgresTransactionInboxRepository(pool);
    await restarted.enqueue(tradeNotification('conflicting-mint', 1n));
    await restarted.enqueue(tradeNotification('conflicting-mint', 1n, PUMP_PROGRAM_ID));
    await restarted.syncTrackedMint(tradeMint);
    assert.deepEqual(ingestionDecision(await row(pool, 'conflicting-mint')), {
      processing_status: 'PENDING', ingestion_priority: 'NORMAL', ingestion_hint: 'NONE', ingestion_hint_mint: null,
    });
    assert.equal((await restarted.claim(Date.now(), 30))?.signature, 'conflicting-mint');
  });
});

void test('only pristine normal discoveries may become deferred after a more precise trade hint', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(pumpCatchUpNotification('pristine', 1n));
    await repository.enqueue(pumpCatchUpNotification('pristine', 1n));
    await repository.enqueue(tradeNotification('pristine', 1n));
    assert.equal((await row(pool, 'pristine')).processing_status, 'DEFERRED');
    await repository.enqueue(notification('leased-trade', 2n));
    const leased = await repository.claim(Date.now(), 30);
    assert.ok(leased);
    await repository.enqueue(tradeNotification('leased-trade', 2n));
    assert.equal((await row(pool, 'leased-trade')).processing_status, 'PROCESSING');
    await repository.saveSnapshot(leased.signature, leased.leaseToken, normalized(leased.signature, 2n));
    await repository.markProcessed(leased.signature, leased.leaseToken, 'processed');
    await repository.enqueue(tradeNotification('leased-trade', 2n));
    assert.equal((await row(pool, 'leased-trade')).processing_status, 'PROCESSED');
    await repository.enqueue(notification('snapshot-trade', 3n));
    await pool.query(`UPDATE chain_transaction_inbox SET normalized_transaction='{}',
      immutable_fingerprint=$1 WHERE signature='snapshot-trade'`, ['a'.repeat(64)]);
    await repository.enqueue(tradeNotification('snapshot-trade', 3n));
    assert.equal((await row(pool, 'snapshot-trade')).processing_status, 'PENDING');
  });
});

void test('syncTrackedMint reactivates all deferred trades and deactivates only unattempted pending trades', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    for (let index = 1; index <= 4; index += 1) {
      await repository.enqueue(tradeNotification(`sync-${index}`, BigInt(index)));
    }
    await insertTrackedLaunch(pool);
    await repository.syncTrackedMint(tradeMint);
    for (let index = 1; index <= 4; index += 1) {
      const stored = await row(pool, `sync-${index}`);
      assert.equal(stored.processing_status, 'PENDING');
      assert.equal(stored.ingestion_priority, 'TRACKED_TRADE');
      assert.equal(stored.terminal_at, null);
      assert.equal(stored.purge_after, null);
    }
    const lease = await repository.claim(Date.now(), 30);
    assert.equal(lease?.signature, 'sync-1');
    await pool.query("UPDATE chain_transaction_inbox SET attempts=1 WHERE signature='sync-2'");
    await pool.query('UPDATE token_launches SET terminal_at=clock_timestamp()');
    await repository.syncTrackedMint(tradeMint);
    assert.equal((await row(pool, 'sync-1')).processing_status, 'PROCESSING');
    assert.equal((await row(pool, 'sync-2')).processing_status, 'PENDING');
    const third = await row(pool, 'sync-3');
    const fourth = await row(pool, 'sync-4');
    assert.equal(third.processing_status, 'DEFERRED');
    assert.equal(fourth.processing_status, 'DEFERRED');
    assert.deepEqual(third.terminal_at, fourth.terminal_at);
    assert.equal(third.purge_after.getTime() - third.terminal_at.getTime(), 14_400_000);
    await repository.syncTrackedMint(tradeMint);
    assert.deepEqual((await row(pool, 'sync-3')).terminal_at, third.terminal_at);
    await pool.query('DELETE FROM token_launches WHERE mint=$1', [tradeMint]);
    await repository.syncTrackedMint(tradeMint);
    assert.equal((await row(pool, 'sync-2')).processing_status, 'PENDING');
  });
});

void test('syncTrackedMint uses a mint-selective index for activation and deactivation amid 100000 unrelated rows', async (context) => {
  await withDatabase(context, async (pool) => {
    const version = await pool.query("SELECT current_setting('server_version_num')::INTEGER / 10000 AS major");
    assert.equal(version.rows[0]?.major, 16);
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, ingestion_hint, ingestion_hint_mint, observed_at, terminal_at, purge_after
    ) SELECT 'unrelated-' || value, value, ARRAY['WEBSOCKET'], ARRAY[$1], 'confirmed',
      CASE WHEN value % 3 = 0 THEN 'DEFERRED' ELSE 'PENDING' END,
      CASE WHEN value % 3 = 1 THEN 'NONE' ELSE 'PUMPFUN_TRADE' END,
      CASE WHEN value % 3 <> 1 THEN $2 END, at,
      CASE WHEN value % 3 = 0 THEN at END,
      CASE WHEN value % 3 = 0 THEN at + INTERVAL '4 hours' END
      FROM generate_series(1, 100000) value CROSS JOIN (SELECT NOW() AS at) observed`,
    [PUMP_PROGRAM_ID, '1'.repeat(32)]);
    const plans: ExplainPlan[] = [];
    // Delegate every operation to PG16. Explain the exact repository UPDATE in
    // a savepoint, then roll it back before running the ordinary operation.
    const repository = new PostgresTransactionInboxRepository({
      query: (sql, values) => pool.query(sql, [...(values ?? [])]),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: () => { client.release(); },
          query: async (sql, values) => {
            if (sql.includes('UPDATE chain_transaction_inbox inbox SET')) {
              await client.query('SAVEPOINT explain_sync');
              try {
                const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [...(values ?? [])]);
                plans.push(result.rows[0]?.['QUERY PLAN']?.[0]?.Plan);
              } finally {
                await client.query('ROLLBACK TO SAVEPOINT explain_sync');
                await client.query('RELEASE SAVEPOINT explain_sync');
              }
            }
            return client.query(sql, [...(values ?? [])]);
          },
        };
      },
    });
    for (let index = 0; index < 3; index += 1) {
      await repository.enqueue(tradeNotification(`selected-${index}`, BigInt(index)));
    }
    await pool.query('ANALYZE chain_transaction_inbox');
    await insertTrackedLaunch(pool);
    await repository.syncTrackedMint(tradeMint);
    assert.equal((await row(pool, 'selected-0')).processing_status, 'PENDING');
    await pool.query('UPDATE token_launches SET terminal_at=clock_timestamp()');
    await repository.syncTrackedMint(tradeMint);
    assert.equal((await row(pool, 'selected-0')).processing_status, 'DEFERRED');
    assert.equal(plans.length, 2);
    for (const [index, plan] of plans.entries()) {
      assert.ok(plan);
      const nodes = flattenPlan(plan);
      const inboxScans = nodes.filter((node) => node['Relation Name'] === 'chain_transaction_inbox'
        && String(node['Node Type']).includes('Scan'));
      const evidence = JSON.stringify(inboxScans);
      context.diagnostic(`${index === 0 ? 'activation' : 'deactivation'} inbox scan: ${JSON.stringify(inboxScans.map((node) => ({
        type: node['Node Type'], index: node['Index Name'], rows: node['Actual Rows'],
        removed: node['Rows Removed by Filter'], blocks: Number(node['Shared Hit Blocks']) + Number(node['Shared Read Blocks']),
        milliseconds: node['Actual Total Time'],
      })))}`);
      assert.equal(inboxScans.some((node) => node['Node Type'] === 'Seq Scan'), false, evidence);
      assert.ok(nodes.some((node) => node['Index Name'] === 'chain_transaction_inbox_tracked_mint_idx'), evidence);
      assert.equal(inboxScans.reduce((sum, node) => sum + Number(node['Actual Rows']), 0), 3, evidence);
      assert.ok(inboxScans.every((node) => Number(node['Rows Removed by Filter'] ?? 0) <= 3), evidence);
      assert.ok(inboxScans.every((node) =>
        Number(node['Shared Hit Blocks'] ?? 0) + Number(node['Shared Read Blocks'] ?? 0) < 64), evidence);
    }
  });
});

void test('validates syncTrackedMint and trade notification mints before checking out a database client', async () => {
  let calls = 0;
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => { calls += 1; throw new Error('must not connect'); },
    query: async () => { calls += 1; throw new Error('must not query'); },
  });
  for (const mint of ['', '0'.repeat(32), '1'.repeat(33), `${tradeMint} `]) {
    await assert.rejects(repository.syncTrackedMint(mint), TransactionInboxRepositoryError);
    await assert.rejects(repository.enqueue(tradeNotification('invalid', 1n, mint)), TransactionInboxRepositoryError);
  }
  assert.equal(calls, 0);
});

void test('concurrent trade, catch-up and create discoveries converge without resurrection or downgrade', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    for (let index = 0; index < 8; index += 1) {
      const signature = `concurrent-trade-${index}`;
      const operations = [
        () => repository.enqueue(pumpCatchUpNotification(signature, 1n)),
        () => repository.enqueue(tradeNotification(signature, 1n)),
      ];
      if (index % 2 === 0) operations.reverse();
      await Promise.all(operations.map((operation) => operation()));
      const stored = await row(pool, signature);
      assert.equal(stored.processing_status, 'DEFERRED');
      assert.deepEqual(stored.discovery_sources, ['WEBSOCKET', 'CATCH_UP']);
      await Promise.all([
        repository.enqueue(notification(signature, 1n, 'WEBSOCKET', 'processed', 1000, 'PUMPFUN_CREATE')),
        repository.enqueue(tradeNotification(signature, 1n)),
        repository.enqueue(notification(signature, 1n, 'CATCH_UP')),
      ]);
      assert.equal((await row(pool, signature)).ingestion_priority, 'LAUNCH_CANDIDATE');
    }
  });
});

void test('trade enqueue and canonical projection synchronization converge under the shared mint lock', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('transaction-inbox-mint:' || $1, 0))", [tradeMint]);
      const enqueue = repository.enqueue(tradeNotification('projection-race', 1n));
      const sync = repository.syncTrackedMint(tradeMint);
      await insertTrackedLaunch(pool);
      await blocker.query('COMMIT');
      await Promise.all([enqueue, sync]);
      assert.equal((await row(pool, 'projection-race')).ingestion_priority, 'TRACKED_TRADE');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
});

void test('shares urgent FIFO and the 32-to-1 fairness budget between creates and tracked trades', async (context) => {
  await withDatabase(context, async (pool) => {
    await insertTrackedLaunch(pool);
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(notification('normal-shared-fairness', 0n, 'CATCH_UP'));
    for (let index = 0; index < 34; index += 1) {
      const signature = `urgent-${String(index).padStart(2, '0')}`;
      await repository.enqueue(index % 2 === 0
        ? notification(signature, BigInt(index + 1), 'WEBSOCKET', 'processed', 1000, 'PUMPFUN_CREATE')
        : tradeNotification(signature, BigInt(index + 1)));
    }
    const now = Date.now();
    for (let index = 0; index < 32; index += 1) {
      assert.equal((await repository.claim(now, 120))?.signature, `urgent-${String(index).padStart(2, '0')}`);
    }
    assert.equal((await repository.claim(now, 120))?.signature, 'normal-shared-fairness');
    assert.equal((await repository.claim(now, 120))?.signature, 'urgent-32');
    assert.equal((await repository.claim(now, 120))?.signature, 'urgent-33');
  });
});

void test('rejects corrupt stored hint combinations without mutation', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(notification('corrupt-hint', 2n));
    await pool.query('ALTER TABLE chain_transaction_inbox DROP CONSTRAINT chain_transaction_inbox_ingestion_hint_check');
    await pool.query("UPDATE chain_transaction_inbox SET ingestion_hint_mint=$1 WHERE signature='corrupt-hint'", [tradeMint]);
    await assert.rejects(repository.enqueue(notification('corrupt-hint', 2n)), TransactionInboxRepositoryError);
  });
});

interface StrictCatchUpRunRepository extends StrictCatchUpRepository {
  readStrictCatchUpRun(key: ProcessingCheckpoint['key'], previous: ProcessingCheckpoint, providerId: StrictCatchUpRun['providerId']): Promise<StrictCatchUpRun | null>;
  readActiveStrictCatchUpRun(key: ProcessingCheckpoint['key']): Promise<StrictCatchUpRun | null>;
  createStrictCatchUpRun(value: StrictCatchUpRun): Promise<StrictCatchUpRun>;
  advanceStrictCatchUpRun(expected: StrictCatchUpRun, next: StrictCatchUpRun): Promise<void>;
  completeStrictCatchUpRun(value: {
    readonly run: StrictCatchUpRun;
    readonly nextCheckpoint: ProcessingCheckpoint;
  }): Promise<void>;
  failStrictCatchUpRun(expected: StrictCatchUpRun, failed: StrictCatchUpRun): Promise<void>;
  supersedeStaleStrictCatchUpRun(expected: StrictCatchUpRun, atMs: number): Promise<void>;
}

void test('reads no active strict catch-up run when its key has no row', async () => {
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => { throw new Error('transaction access must not occur'); },
    query: async () => ({ rows: [], rowCount: 0 }),
  }) as unknown as StrictCatchUpRunRepository;

  assert.equal(await repository.readActiveStrictCatchUpRun('launchpad'), null);
});

void test('reads exact historical strict runs in every state and rejects corrupt history', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool) as unknown as StrictCatchUpRunRepository;
    const previous = checkpoint('launchpad', 110n, 'historical-previous', 700_000);
    const run = strictCatchUpRun(previous, 'primary', 700_001);
    assert.equal(await repository.readStrictCatchUpRun('launchpad', previous, 'primary'), null);
    await repository.compareAndSwapCheckpoint(null, previous);
    await repository.createStrictCatchUpRun(run);
    assert.deepEqual(await repository.readStrictCatchUpRun('launchpad', previous, 'primary'), run);
    const failed = terminalizeStrictCatchUpRun(run, {
      state: 'FAILED', terminalReason: 'CATCH_UP_WINDOW_EXCEEDED', completedAtMs: 700_002,
    });
    await repository.failStrictCatchUpRun(run, failed);
    assert.deepEqual(await repository.readStrictCatchUpRun('launchpad', previous, 'primary'), failed);
    assert.deepEqual(await repository.readStrictCatchUpRun('launchpad', Object.freeze({ ...previous, updatedAtMs: 800_000 }), 'primary'), failed);
    assert.equal(await repository.readStrictCatchUpRun('launchpad', previous, 'fallback-1'), null);
    assert.equal(await repository.readStrictCatchUpRun('launchpad', Object.freeze({ ...previous, slot: 111n }), 'primary'), null);
    assert.equal(await repository.readStrictCatchUpRun('launchpad', Object.freeze({ ...previous, signature: 'other' }), 'primary'), null);
    assert.equal(await repository.readStrictCatchUpRun('market', Object.freeze({ ...previous, key: 'market' }), 'primary'), null);
    for (const state of ['COMPLETED', 'SUPERSEDED'] as const) {
      const terminal = terminalizeStrictCatchUpRun(run, {
        state, terminalReason: state === 'COMPLETED' ? null : 'CHECKPOINT_SUPERSEDED', completedAtMs: 700_002,
      });
      await pool.query('UPDATE listener_strict_catch_up_runs SET state = $1, terminal_reason = $2 WHERE run_id = $3',
        [state, terminal.terminalReason, run.runId]);
      assert.deepEqual(await repository.readStrictCatchUpRun('launchpad', previous, 'primary'), terminal);
    }
    await pool.query('ALTER TABLE listener_strict_catch_up_runs DROP CONSTRAINT listener_strict_catch_up_runs_cursor_order_check');
    await pool.query('UPDATE listener_strict_catch_up_runs SET before_signature = previous_signature WHERE run_id = $1', [run.runId]);
    await assert.rejects(repository.readStrictCatchUpRun('launchpad', previous, 'primary'), (error: unknown) => {
      assert.ok(error instanceof TransactionInboxRepositoryError);
      assertNoSecretSurface(error, 'historical-previous');
      return true;
    });
  });
});

void test('validates historical strict run lookup inputs before I/O and redacts row count failures', async () => {
  let accesses = 0;
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => { throw new Error('must not connect'); },
    query: async () => { accesses += 1; return { rows: [], rowCount: 0 }; },
  }) as unknown as StrictCatchUpRunRepository;
  const previous = checkpoint('launchpad', 10n, 'history-secret', 1_000);
  for (const [key, boundary, provider] of [
    ['invalid', previous, 'primary'],
    ['market', previous, 'primary'],
    ['launchpad', { ...previous }, 'primary'],
    ['launchpad', previous, 'https://provider-secret.invalid'],
    ['launchpad', Object.freeze({ ...previous, signature: ' padded' }), 'primary'],
  ] as const) {
    await assert.rejects(repository.readStrictCatchUpRun(key as never, boundary, provider as never), TransactionInboxRepositoryError);
  }
  assert.equal(accesses, 0);
  for (const result of [{ rows: [], rowCount: 1 }, { rows: [{}], rowCount: 0 }, { rows: [{}, {}], rowCount: 2 }]) {
    const inconsistent = new PostgresTransactionInboxRepository({
      connect: async () => { throw new Error('must not connect'); }, query: async () => result,
    }) as unknown as StrictCatchUpRunRepository;
    await assert.rejects(inconsistent.readStrictCatchUpRun('launchpad', previous, 'primary'), (error: unknown) => {
      assert.ok(error instanceof TransactionInboxRepositoryError);
      assertNoSecretSurface(error, 'history-secret');
      return true;
    });
  }
});

void test('processes a catch-up row at scan time when blockchain time is in the future', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const scanAtMs = Date.now();
    const futureBlockTimeMs = scanAtMs + 86_400_000;
    const scanner = new CatchUpScanner({
      async list(programId: string) {
        if (programId === PUMP_PROGRAM_ID) {
          return [Object.freeze({
            signature: 'future-block-time', slot: 9n, confirmationStatus: 'confirmed' as const,
            blockTimeMs: futureBlockTimeMs, transactionFailed: false,
          })];
        }
        assert.equal(programId, PUMPSWAP_PROGRAM_ID);
        return [];
      },
    }, repository, { pageSize: 2, maxPages: 2, now: () => scanAtMs });

    await scanner.scan();

    assert.equal(new Date((await row(pool, 'future-block-time')).observed_at).getTime(), scanAtMs);
    assert.deepEqual(await repository.readCheckpoint('launchpad'), Object.freeze({
      key: 'launchpad', signature: 'future-block-time', slot: 9n, updatedAtMs: scanAtMs,
    }));
    const claim = await repository.claim(scanAtMs, 120);
    assert.ok(claim);
    await repository.saveSnapshot('future-block-time', claim.leaseToken, {
      ...normalized('future-block-time', 9n), blockTimeMs: futureBlockTimeMs,
    });
    assert.equal(
      new Date((await row(pool, 'future-block-time')).blockchain_time).getTime(),
      futureBlockTimeMs,
    );
    await repository.markProcessed('future-block-time', claim.leaseToken, 'confirmed');
    assert.equal((await row(pool, 'future-block-time')).processing_status, 'PROCESSED');
  });
});

void test('merges discoveries, rejects identity contradictions, and claims concurrently without duplication', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(notification('shared', 10n, 'WEBSOCKET', 'processed', 1_000));
    await repository.enqueue(notification('shared', 10n, 'CATCH_UP', 'confirmed', 1_100));
    const stored = await row(pool, 'shared');
    assert.deepEqual(stored.discovery_sources, ['WEBSOCKET', 'CATCH_UP']);
    assert.deepEqual(stored.program_ids, [
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    ]);
    assert.equal(stored.target_confirmation_status, 'confirmed');
    await assert.rejects(
      repository.enqueue(notification('shared', 11n, 'WEBSOCKET', 'confirmed', 1_200)),
      (error) => {
        assert.ok(error instanceof TransactionInboxConflictError);
        assert.equal(error.conflict, 'identity');
        assert.equal(error.message, 'Transaction inbox immutable state conflicts.');
        assert.deepEqual(error.failures, []);
        assert.equal(Object.hasOwn(error, 'cause'), false);
        return true;
      },
    );

    await repository.enqueue(notification('second', 11n, 'WEBSOCKET', 'processed', 1_100));
    const [first, second] = await Promise.all([
      repository.claim(2_000, 120),
      repository.claim(2_000, 120),
    ]);
    assert.deepEqual(new Set([first?.signature, second?.signature]), new Set(['shared', 'second']));
    assert.notEqual(first?.leaseToken, second?.leaseToken);
    assert.equal(await repository.claim(2_001, 120), null);

    await Promise.all([
      repository.enqueue(notification('parallel-discovery', 12n, 'WEBSOCKET', 'processed', 2_100)),
      repository.enqueue(notification('parallel-discovery', 12n, 'CATCH_UP', 'confirmed', 2_101)),
    ]);
    const parallel = await row(pool, 'parallel-discovery');
    assert.deepEqual(parallel.discovery_sources, ['WEBSOCKET', 'CATCH_UP']);
    assert.equal(parallel.target_confirmation_status, 'confirmed');
  });
});

void test('upgrades duplicate creation hints monotonically and claims a late launch before normal backlog', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, observed_at
    ) SELECT 'normal-' || value, value, ARRAY['CATCH_UP'], ARRAY[$1], 'confirmed',
      'PENDING', clock_timestamp()
      FROM generate_series(1, 2000) value`, [PUMP_PROGRAM_ID]);
    await repository.enqueue(notification(
      'normal-upgraded',
      2_001n,
      'CATCH_UP',
      'confirmed',
      1_000,
    ));
    await repository.enqueue(notification(
      'normal-upgraded',
      2_001n,
      'WEBSOCKET',
      'confirmed',
      1_001,
      'PUMPFUN_CREATE',
    ));
    await repository.enqueue(notification(
      'candidate-first',
      2_002n,
      'WEBSOCKET',
      'confirmed',
      1_002,
      'PUMPFUN_CREATE',
    ));
    await repository.enqueue(notification(
      'candidate-first',
      2_002n,
      'CATCH_UP',
      'confirmed',
      1_003,
    ));

    assert.equal((await row(pool, 'normal-upgraded')).ingestion_priority, 'LAUNCH_CANDIDATE');
    assert.equal((await row(pool, 'candidate-first')).ingestion_priority, 'LAUNCH_CANDIDATE');
    assert.equal((await repository.claim(2_000, 120))?.signature, 'normal-upgraded');
  });
});

void test('concurrent normal and creation discoveries converge to launch priority', async (context) => {
  await withDatabase(context, async (pool) => {
    if (databaseUrl === undefined) throw new Error('Database URL unexpectedly absent.');
    const schema = (await pool.query<{ readonly schema: string }>(
      'SELECT current_schema() AS schema',
    )).rows[0]?.schema;
    assert.ok(schema);
    const contenderPool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    try {
      const first = new PostgresTransactionInboxRepository(pool);
      const second = new PostgresTransactionInboxRepository(contenderPool);
      await Promise.all([
        first.enqueue(notification('parallel-priority', 2_100n, 'CATCH_UP')),
        second.enqueue(notification(
          'parallel-priority',
          2_100n,
          'WEBSOCKET',
          'processed',
          1_001,
          'PUMPFUN_CREATE',
        )),
      ]);

      const stored = await row(pool, 'parallel-priority');
      assert.equal(stored.ingestion_priority, 'LAUNCH_CANDIDATE');
      assert.deepEqual(stored.discovery_sources, ['WEBSOCKET', 'CATCH_UP']);
    } finally {
      await contenderPool.end();
    }
  });
});

void test('bounds normal starvation after 32 consecutive launch-candidate claims', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(notification('normal-fairness', 1n, 'CATCH_UP'));
    for (let index = 1; index <= 33; index += 1) {
      await repository.enqueue(notification(
        `launch-${String(index).padStart(2, '0')}`,
        BigInt(100 + index),
        'WEBSOCKET',
        'processed',
        1_000 + index,
        'PUMPFUN_CREATE',
      ));
    }
    const terminalFailure: IngestionFailure = Object.freeze({
      code: 'NORMALIZATION_FAILED', errorName: 'ExpectedTestFailure', retryable: false,
    });
    for (let index = 1; index <= 32; index += 1) {
      const claim = await repository.claim(2_000 + index, 120);
      assert.equal(claim?.signature, `launch-${String(index).padStart(2, '0')}`);
      if (claim === null) throw new Error('Expected a launch claim.');
      await repository.markFailed(claim.signature, claim.leaseToken, terminalFailure);
    }

    assert.equal((await repository.claim(3_000, 120))?.signature, 'normal-fairness');
  });
});

void test('leases expire, renew, and reject stale tokens on every leased mutation', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(notification('lease', 20n));
    const first = await repository.claim(10_000, 2);
    assert.ok(first);
    await repository.renewLease('lease', first.leaseToken, 18_000);
    await repository.renewLease('lease', first.leaseToken, 16_000);
    assert.equal(new Date((await row(pool, 'lease')).lease_expires_at).getTime(), 18_000);
    await Promise.all([
      repository.renewLease('lease', first.leaseToken, 20_000),
      repository.renewLease('lease', first.leaseToken, 19_000),
    ]);
    assert.equal(new Date((await row(pool, 'lease')).lease_expires_at).getTime(), 20_000);
    assert.equal(await repository.claim(12_001, 2), null);
    assert.equal(await repository.claim(19_999, 2), null);
    const reclaimed = await repository.claim(20_001, 2);
    assert.ok(reclaimed);
    assert.notEqual(reclaimed.leaseToken, first.leaseToken);
    assert.equal(reclaimed.attempts, 2);

    const stale = first.leaseToken;
    const failure: IngestionFailure = Object.freeze({
      code: 'RPC_TRANSIENT', errorName: 'RpcError', retryable: true,
    });
    await assert.rejects(repository.renewLease('lease', stale, 20_000), (error) => {
      assert.ok(error instanceof TransactionInboxLeaseError);
      assert.equal(error.message, 'Transaction inbox lease is stale or missing.');
      assert.deepEqual(error.failures, []);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
    await assert.rejects(repository.saveSnapshot('lease', stale, normalized('lease', 20n)), TransactionInboxLeaseError);
    await assert.rejects(repository.markProcessed('lease', stale, 'confirmed'), TransactionInboxLeaseError);
    await assert.rejects(repository.markFailed('lease', stale, failure), TransactionInboxLeaseError);
  });
});

void test('stores canonical bigint/base64 snapshots idempotently and rejects conflicts', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(notification('snapshot', 9_007_199_254_740_993n));
    const claim = await repository.claim(50_000, 120);
    assert.ok(claim);
    const transaction = normalized('snapshot', 9_007_199_254_740_993n);
    await repository.saveSnapshot('snapshot', claim.leaseToken, transaction);
    await repository.saveSnapshot('snapshot', claim.leaseToken, transaction);
    const stored = await row(pool, 'snapshot');
    assert.equal(stored.normalized_transaction.slot.$solTokenListenerBigInt, '9007199254740993');
    assert.equal(stored.normalized_transaction.feeLamports.$solTokenListenerBigInt, '9007199254740995');
    assert.equal(stored.normalized_transaction.instructions[0].dataBase64, 'AAH/');
    assert.match(stored.immutable_fingerprint, /^[0-9a-f]{64}$/u);

    await assert.rejects(
      repository.saveSnapshot('snapshot', claim.leaseToken, {
        ...transaction, feeLamports: transaction.feeLamports + 1n,
      }),
      TransactionInboxConflictError,
    );
    const replay = await repository.claim(50_001, 120);
    assert.equal(replay, null);
  });
});

void test('rejects negative zero before JSONB and restores other finite snapshot numbers', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(notification('negative-zero', 21n));
    const negativeZeroClaim = await repository.claim(60_000, 120);
    assert.ok(negativeZeroClaim);
    await assert.rejects(repository.saveSnapshot(
      'negative-zero',
      negativeZeroClaim.leaseToken,
      { ...normalized('negative-zero', 21n), error: { nested: { value: -0 } } },
    ), TransactionInboxRepositoryError);
    assert.equal((await row(pool, 'negative-zero')).normalized_transaction, null);
    await repository.markFailed('negative-zero', negativeZeroClaim.leaseToken, Object.freeze({
      code: 'NORMALIZATION_FAILED', errorName: 'TypeError', retryable: false,
    }));

    await repository.enqueue(notification('finite-numbers', 22n));
    const finiteClaim = await repository.claim(60_001, 120);
    assert.ok(finiteClaim);
    await repository.saveSnapshot('finite-numbers', finiteClaim.leaseToken, {
      ...normalized('finite-numbers', 22n),
      error: { negative: -1.25, positiveZero: 0, positive: 1.25 },
    });
    const stored = await row(pool, 'finite-numbers');
    assert.deepEqual(stored.normalized_transaction.error, {
      negative: -1.25, positive: 1.25, positiveZero: 0,
    });
    assert.equal(Object.is(stored.normalized_transaction.error.positiveZero, -0), false);
    await repository.markFailed('finite-numbers', finiteClaim.leaseToken, Object.freeze({
      code: 'RPC_TRANSIENT', errorName: 'RpcError', retryable: true,
    }));
    const retryAt = new Date((await row(pool, 'finite-numbers')).next_attempt_at).getTime();
    const replay = await repository.claim(retryAt + 1, 120);
    assert.ok(replay?.normalizedTransaction);
    const restored = restoreNormalizedTransactionSnapshot(replay.normalizedTransaction);
    assert.deepEqual(restored.error, { negative: -1.25, positive: 1.25, positiveZero: 0 });
    assert.equal(Object.is((restored.error as { positiveZero: number }).positiveZero, -0), false);
  });
});

void test('reconciles processing finality, replays immutable revisions, and rejects terminal conflicts', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(notification('finality', 30n));
    const initial = await repository.claim(100_000, 120);
    assert.ok(initial);
    await repository.saveSnapshot('finality', initial.leaseToken, normalized('finality', 30n));
    await repository.markProcessed('finality', initial.leaseToken, 'confirmed');
    const firstMissing = await repository.recordFinalityPoll(Object.freeze({
      signature: 'finality', confirmationStatus: null, providerId: 'primary' as const,
      expectedMissingFinalityPolls: 0, expectedLastMissingFinalityProviderId: null,
      expectedFinalityEvidenceVersion: 0n, observedAtMs: 101_000,
    }));
    assert.deepEqual(finalityProof(firstMissing), {
      confirmationStatus: 'confirmed', missingFinalityPolls: 1,
      lastMissingFinalityProviderId: 'primary', finalityEvidenceVersion: 1n,
    });
    const concurrentMissing = await Promise.allSettled([
      repository.recordFinalityPoll(Object.freeze({
        signature: 'finality', confirmationStatus: null, providerId: 'primary' as const,
        expectedMissingFinalityPolls: 1, expectedLastMissingFinalityProviderId: 'primary' as const,
        expectedFinalityEvidenceVersion: 1n, observedAtMs: 102_000,
      })),
      repository.recordFinalityPoll(Object.freeze({
        signature: 'finality', confirmationStatus: null, providerId: 'fallback-1' as const,
        expectedMissingFinalityPolls: 1, expectedLastMissingFinalityProviderId: 'fallback-1' as const,
        expectedFinalityEvidenceVersion: 1n, observedAtMs: 102_001,
      })),
    ]);
    assert.equal(concurrentMissing.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(concurrentMissing.filter((result) =>
      result.status === 'rejected' && result.reason instanceof TransactionInboxConflictError).length, 1);
    const fallbackMissing = await repository.recordFinalityPoll(Object.freeze({
      signature: 'finality', confirmationStatus: null, providerId: 'fallback-1' as const,
      expectedMissingFinalityPolls: 2, expectedLastMissingFinalityProviderId: 'primary' as const,
      expectedFinalityEvidenceVersion: 2n, observedAtMs: 102_500,
    }));
    assert.deepEqual(finalityProof(fallbackMissing), {
      confirmationStatus: 'confirmed', missingFinalityPolls: 1,
      lastMissingFinalityProviderId: 'fallback-1', finalityEvidenceVersion: 3n,
    });
    const reset = await repository.recordFinalityPoll(Object.freeze({
      signature: 'finality', confirmationStatus: 'processed',
      providerId: 'primary' as const, expectedMissingFinalityPolls: 1,
      expectedLastMissingFinalityProviderId: 'fallback-1' as const,
      expectedFinalityEvidenceVersion: 3n, observedAtMs: 103_000,
    }));
    assert.equal(reset.confirmationStatus, 'confirmed');
    assert.deepEqual(finalityProof(reset), {
      confirmationStatus: 'confirmed', missingFinalityPolls: 0,
      lastMissingFinalityProviderId: null, finalityEvidenceVersion: 4n,
    });
    const processedAtMs = new Date((await row(pool, 'finality')).processed_at).getTime();
    assert.deepEqual(await repository.listForFinality(10), [{
      signature: 'finality', slot: 30n, confirmationStatus: 'confirmed',
      missingFinalityPolls: 0, lastMissingFinalityProviderId: null,
      finalityEvidenceVersion: 4n, processedAtMs,
    }]);

    await repository.enqueueRevision(Object.freeze({
      signature: 'finality', confirmationStatus: 'finalized', observedAtMs: 110_000,
    }));
    const revision = await repository.claim(110_001, 120);
    assert.ok(revision?.normalizedTransaction);
    assert.equal(revision.confirmationStatus, 'finalized');
    assert.equal(revision.normalizedTransaction.signature, 'finality');
    await repository.markProcessed('finality', revision.leaseToken, 'finalized');
    const terminal = await row(pool, 'finality');
    assert.equal(terminal.processing_status, 'PROCESSED');
    assert.equal(new Date(terminal.purge_after).getTime() - new Date(terminal.terminal_at).getTime(), 4 * 60 * 60 * 1_000);
    await assert.rejects(repository.enqueueRevision(Object.freeze({
      signature: 'finality', confirmationStatus: 'orphaned',
      expectedConfirmationStatus: 'confirmed' as const,
      expectedMissingFinalityPolls: 1, expectedLastMissingFinalityProviderId: 'primary' as const,
      expectedFinalityEvidenceVersion: 4n, observedAtMs: 120_000,
    })), TransactionInboxConflictError);

    await repository.enqueue(notification('orphan', 31n));
    const orphan = await repository.claim(120_001, 120);
    assert.ok(orphan);
    await repository.saveSnapshot('orphan', orphan.leaseToken, normalized('orphan', 31n));
    await repository.markProcessed('orphan', orphan.leaseToken, 'processed');
    const orphanProof = await repository.recordFinalityPoll(Object.freeze({
      signature: 'orphan', confirmationStatus: null, providerId: 'primary' as const,
      expectedMissingFinalityPolls: 0, expectedLastMissingFinalityProviderId: null,
      expectedFinalityEvidenceVersion: 0n, observedAtMs: 129_000,
    }));
    assert.ok(orphanProof.lastMissingFinalityProviderId);
    await repository.enqueueRevision(Object.freeze({
      signature: 'orphan', confirmationStatus: 'orphaned',
      expectedConfirmationStatus: orphanProof.confirmationStatus,
      expectedMissingFinalityPolls: orphanProof.missingFinalityPolls,
      expectedLastMissingFinalityProviderId: orphanProof.lastMissingFinalityProviderId,
      expectedFinalityEvidenceVersion: orphanProof.finalityEvidenceVersion,
      observedAtMs: 130_000,
    }));
    const orphanRevision = await repository.claim(130_001, 120);
    assert.equal(orphanRevision?.confirmationStatus, 'orphaned');
  });
});

void test('rotates a bounded finality page after every durable poll using database time', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    for (const [index, signature] of [
      'finality-fairness-0', 'finality-fairness-1', 'finality-fairness-2',
    ].entries()) {
      await pool.query(`INSERT INTO chain_transaction_inbox (
        signature, observed_slot, discovery_sources, program_ids,
        target_confirmation_status, processing_status, normalized_transaction,
        immutable_fingerprint, observed_at, processed_at, created_at, updated_at
      ) VALUES (
        $1, $2::BIGINT, ARRAY['WEBSOCKET'], ARRAY[$3], 'confirmed', 'PROCESSED',
        '{}'::JSONB, $4, '2000-01-01T00:00:00Z'::TIMESTAMPTZ,
        '2000-01-01T00:00:00Z'::TIMESTAMPTZ + ($2::BIGINT * INTERVAL '1 second'),
        '2000-01-01T00:00:00Z'::TIMESTAMPTZ,
        '2000-01-01T00:00:00Z'::TIMESTAMPTZ + ($2::BIGINT * INTERVAL '1 second')
      )`, [signature, index + 1, PUMP_PROGRAM_ID, 'a'.repeat(64)]);
    }

    const firstPage = await repository.listForFinality(2);
    assert.deepEqual(firstPage.map(({ signature }) => signature), [
      'finality-fairness-0', 'finality-fairness-1',
    ]);
    const first = firstPage[0];
    assert.ok(first);
    await repository.recordFinalityPoll(Object.freeze({
      signature: first.signature,
      confirmationStatus: null,
      providerId: 'primary' as const,
      expectedMissingFinalityPolls: first.missingFinalityPolls,
      expectedLastMissingFinalityProviderId: first.lastMissingFinalityProviderId,
      expectedFinalityEvidenceVersion: first.finalityEvidenceVersion,
      observedAtMs: 0,
    }));

    const nextPage = await repository.listForFinality(2);
    assert.deepEqual(nextPage.map(({ signature }) => signature), [
      'finality-fairness-1', 'finality-fairness-2',
    ]);
    assert.equal(nextPage.some(({ signature }) => signature === first.signature), false);
  });
});

void test('starts a fresh retry cycle for a durable finality replay', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool, Object.freeze({
      maxAttempts: 1,
      baseDelayMs: 500,
    }));
    await repository.enqueue(notification('cycle-replay', 39n));
    const first = await repository.claim(190_000, 120);
    assert.ok(first);
    await repository.saveSnapshot(
      'cycle-replay', first.leaseToken, normalized('cycle-replay', 39n),
    );
    await repository.markProcessed('cycle-replay', first.leaseToken, 'processed');
    await repository.enqueueRevision(Object.freeze({
      signature: 'cycle-replay', confirmationStatus: 'finalized', observedAtMs: 191_000,
    }));

    const replay = await repository.claim(191_001, 120);
    assert.ok(replay);
    assert.equal(replay.attempts, 2);
    assert.equal((await row(pool, 'cycle-replay')).attempts_in_cycle, 1);
  });
});

void test('guards orphan revisions with the complete finality proof and accepts idempotent replays', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(notification('proof', 40n));
    const initial = await repository.claim(200_000, 120);
    assert.ok(initial);
    await repository.saveSnapshot('proof', initial.leaseToken, normalized('proof', 40n));
    await repository.markProcessed('proof', initial.leaseToken, 'confirmed');

    const first = await repository.recordFinalityPoll(Object.freeze({
      signature: 'proof', confirmationStatus: null, providerId: 'primary' as const,
      expectedMissingFinalityPolls: 0, expectedLastMissingFinalityProviderId: null,
      expectedFinalityEvidenceVersion: 0n, observedAtMs: 201_000,
    }));
    await repository.enqueue(notification('proof', 40n, 'WEBSOCKET', 'confirmed', 201_001));
    assert.deepEqual(finalityProof(await onlyFinalityCandidate(repository, 'proof')), {
      confirmationStatus: 'confirmed', missingFinalityPolls: 0,
      lastMissingFinalityProviderId: null, finalityEvidenceVersion: 2n,
    });

    const one = await repository.recordFinalityPoll(Object.freeze({
      signature: 'proof', confirmationStatus: null, providerId: 'primary' as const,
      expectedMissingFinalityPolls: 0, expectedLastMissingFinalityProviderId: null,
      expectedFinalityEvidenceVersion: 2n, observedAtMs: 201_002,
    }));
    const two = await repository.recordFinalityPoll(Object.freeze({
      signature: 'proof', confirmationStatus: null, providerId: 'primary' as const,
      expectedMissingFinalityPolls: 1, expectedLastMissingFinalityProviderId: 'primary' as const,
      expectedFinalityEvidenceVersion: 3n, observedAtMs: 201_003,
    }));
    const proof = await repository.recordFinalityPoll(Object.freeze({
      signature: 'proof', confirmationStatus: null, providerId: 'primary' as const,
      expectedMissingFinalityPolls: 2, expectedLastMissingFinalityProviderId: 'primary' as const,
      expectedFinalityEvidenceVersion: 4n, observedAtMs: 201_004,
    }));
    assert.equal(proof.missingFinalityPolls, 3);
    const currentTuple = await finalityRowTuple(pool, 'proof');
    for (const staleRevision of [
      Object.freeze({
        ...orphanRevision(proof, 201_004),
        expectedMissingFinalityPolls: proof.missingFinalityPolls - 1,
      }),
      Object.freeze({
        ...orphanRevision(proof, 201_005),
        expectedLastMissingFinalityProviderId: 'fallback-1' as const,
      }),
      Object.freeze({
        ...orphanRevision(proof, 201_006),
        expectedFinalityEvidenceVersion: proof.finalityEvidenceVersion - 1n,
      }),
      Object.freeze({
        ...orphanRevision(proof, 201_007),
        expectedConfirmationStatus: 'processed' as const,
      }),
    ]) {
      await assertFinalityConflict(repository.enqueueRevision(staleRevision));
      assert.deepEqual(await finalityRowTuple(pool, 'proof'), currentTuple);
    }
    await assert.rejects(repository.recordFinalityPoll(Object.freeze({
      signature: 'proof', confirmationStatus: null, providerId: 'primary' as const,
      expectedMissingFinalityPolls: 2, expectedLastMissingFinalityProviderId: 'primary' as const,
      expectedFinalityEvidenceVersion: proof.finalityEvidenceVersion, observedAtMs: 201_005,
    })), TransactionInboxConflictError);
    await assert.rejects(repository.recordFinalityPoll(Object.freeze({
      signature: 'proof', confirmationStatus: null, providerId: 'primary' as const,
      expectedMissingFinalityPolls: proof.missingFinalityPolls,
      expectedLastMissingFinalityProviderId: 'fallback-1' as const,
      expectedFinalityEvidenceVersion: proof.finalityEvidenceVersion, observedAtMs: 201_006,
    })), TransactionInboxConflictError);
    await assert.rejects(repository.recordFinalityPoll(Object.freeze({
      signature: 'proof', confirmationStatus: null, providerId: 'primary' as const,
      expectedMissingFinalityPolls: proof.missingFinalityPolls,
      expectedLastMissingFinalityProviderId: proof.lastMissingFinalityProviderId,
      expectedFinalityEvidenceVersion: proof.finalityEvidenceVersion - 1n, observedAtMs: 201_007,
    })), TransactionInboxConflictError);

    await repository.recordFinalityPoll(Object.freeze({
      signature: 'proof', confirmationStatus: 'confirmed', providerId: 'primary' as const,
      expectedMissingFinalityPolls: proof.missingFinalityPolls,
      expectedLastMissingFinalityProviderId: proof.lastMissingFinalityProviderId,
      expectedFinalityEvidenceVersion: proof.finalityEvidenceVersion, observedAtMs: 201_008,
    }));
    let aba = await repository.recordFinalityPoll(Object.freeze({
      signature: 'proof', confirmationStatus: null, providerId: 'primary' as const,
      expectedMissingFinalityPolls: 0, expectedLastMissingFinalityProviderId: null,
      expectedFinalityEvidenceVersion: 6n, observedAtMs: 201_009,
    }));
    aba = await repository.recordFinalityPoll(Object.freeze({
      signature: 'proof', confirmationStatus: null, providerId: 'primary' as const,
      expectedMissingFinalityPolls: aba.missingFinalityPolls,
      expectedLastMissingFinalityProviderId: aba.lastMissingFinalityProviderId,
      expectedFinalityEvidenceVersion: aba.finalityEvidenceVersion, observedAtMs: 201_010,
    }));
    aba = await repository.recordFinalityPoll(Object.freeze({
      signature: 'proof', confirmationStatus: null, providerId: 'primary' as const,
      expectedMissingFinalityPolls: aba.missingFinalityPolls,
      expectedLastMissingFinalityProviderId: aba.lastMissingFinalityProviderId,
      expectedFinalityEvidenceVersion: aba.finalityEvidenceVersion, observedAtMs: 201_011,
    }));
    assert.deepEqual(finalityProof(aba), {
      confirmationStatus: proof.confirmationStatus, missingFinalityPolls: proof.missingFinalityPolls,
      lastMissingFinalityProviderId: proof.lastMissingFinalityProviderId,
      finalityEvidenceVersion: 9n,
    });
    const abaTuple = await finalityRowTuple(pool, 'proof');
    await assertFinalityConflict(repository.enqueueRevision(orphanRevision(proof, 201_012)));
    assert.deepEqual(await finalityRowTuple(pool, 'proof'), abaTuple);

    await repository.enqueueRevision(orphanRevision(aba, 201_013));
    let stored = await row(pool, 'proof');
    assert.deepEqual({
      processing: stored.processing_status, confirmation: stored.target_confirmation_status,
      missing: stored.missing_finality_polls, provider: stored.last_missing_finality_provider_id,
      version: BigInt(stored.finality_evidence_version),
    }, {
      processing: 'PENDING', confirmation: 'orphaned', missing: 0, provider: null, version: 10n,
    });
    await repository.enqueueRevision(orphanRevision(aba, 201_014));
    assert.equal(BigInt((await row(pool, 'proof')).finality_evidence_version), 10n);
    const replay = await repository.claim(201_015, 120);
    assert.ok(replay);
    await repository.markProcessed('proof', replay.leaseToken, 'orphaned');
    await repository.enqueueRevision(orphanRevision(aba, 201_016));
    stored = await row(pool, 'proof');
    assert.equal(stored.processing_status, 'PROCESSED');
    assert.equal(BigInt(stored.finality_evidence_version), 11n);

    assert.equal(first.finalityEvidenceVersion, 1n);
    assert.equal(one.finalityEvidenceVersion, 3n);
    assert.equal(two.finalityEvidenceVersion, 4n);
  });
});

void test('fails closed at the PostgreSQL finality evidence version limit without mutation', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(notification('max-finality-version', 41n));
    const initial = await repository.claim(210_000, 120);
    assert.ok(initial);
    await repository.saveSnapshot(
      'max-finality-version', initial.leaseToken, normalized('max-finality-version', 41n),
    );
    await repository.markProcessed('max-finality-version', initial.leaseToken, 'confirmed');
    await pool.query(
      `UPDATE chain_transaction_inbox
       SET finality_evidence_version = 9223372036854775807
       WHERE signature = 'max-finality-version'`,
    );
    const before = await row(pool, 'max-finality-version');
    await assert.rejects(repository.recordFinalityPoll(Object.freeze({
      signature: 'max-finality-version', confirmationStatus: null, providerId: 'primary' as const,
      expectedMissingFinalityPolls: 0, expectedLastMissingFinalityProviderId: null,
      expectedFinalityEvidenceVersion: 9_223_372_036_854_775_807n, observedAtMs: 210_001,
    })), TransactionInboxConflictError);
    await assert.rejects(
      repository.enqueue(notification('max-finality-version', 41n, 'WEBSOCKET', 'confirmed', 210_002)),
      TransactionInboxConflictError,
    );
    const after = await row(pool, 'max-finality-version');
    assert.deepEqual({
      missing: after.missing_finality_polls,
      provider: after.last_missing_finality_provider_id,
      version: after.finality_evidence_version,
    }, {
      missing: before.missing_finality_polls,
      provider: before.last_missing_finality_provider_id,
      version: before.finality_evidence_version,
    });
  });
});

void test('finalizes and replays a processed confirmed row while saturating an exhausted evidence version',async(context)=>{
  await withDatabase(context,async(pool)=>{
    const repository=new PostgresTransactionInboxRepository(pool);
    const signature='1'.repeat(64);
    await repository.enqueue(notification(signature,42n));
    const initial=await repository.claim(220_000,120);
    assert.ok(initial);
    await repository.saveSnapshot(signature,initial.leaseToken,normalized(signature,42n));
    await repository.markProcessed(signature,initial.leaseToken,'confirmed');
    await pool.query(`UPDATE chain_transaction_inbox
      SET finality_evidence_version=$2,missing_finality_polls=1,
        last_missing_finality_provider_id='primary' WHERE signature=$1`,[
      signature,MAX_FINALITY_EVIDENCE_VERSION.toString(),
    ]);
    const before=await finalityRowTuple(pool,signature);
    await assertFinalityConflict(repository.enqueueRevision(Object.freeze({
      signature,confirmationStatus:'orphaned' as const,
      expectedConfirmationStatus:'confirmed' as const,expectedMissingFinalityPolls:1,
      expectedLastMissingFinalityProviderId:'primary' as const,
      expectedFinalityEvidenceVersion:MAX_FINALITY_EVIDENCE_VERSION,
      observedAtMs:220_001,
    })));
    for(const [confirmationStatus,observedAtMs] of [
      [null,220_002],['confirmed',220_003],
    ] as const){
      await assertFinalityConflict(repository.recordFinalityPoll(Object.freeze({
        signature,confirmationStatus,providerId:'primary' as const,
        expectedMissingFinalityPolls:1,
        expectedLastMissingFinalityProviderId:'primary' as const,
        expectedFinalityEvidenceVersion:MAX_FINALITY_EVIDENCE_VERSION,observedAtMs,
      })));
    }
    assert.deepEqual(await finalityRowTuple(pool,signature),before);

    await repository.enqueueRevision(Object.freeze({
      signature,confirmationStatus:'finalized' as const,observedAtMs:220_004,
    }));
    assert.deepEqual(await finalityRowTuple(pool,signature),{
      confirmationStatus:'finalized',processingStatus:'PENDING',missingFinalityPolls:0,
      lastMissingFinalityProviderId:null,
      finalityEvidenceVersion:MAX_FINALITY_EVIDENCE_VERSION.toString(),
    });
    const replay=await repository.claim(220_005,120);
    assert.ok(replay);
    await repository.markProcessed(signature,replay.leaseToken,'finalized');
    await repository.enqueueRevision(Object.freeze({
      signature,confirmationStatus:'finalized' as const,observedAtMs:220_006,
    }));
    assert.deepEqual(await finalityRowTuple(pool,signature),{
      confirmationStatus:'finalized',processingStatus:'PROCESSED',missingFinalityPolls:0,
      lastMissingFinalityProviderId:null,
      finalityEvidenceVersion:MAX_FINALITY_EVIDENCE_VERSION.toString(),
    });
  });
});

void test('the reconciler emits a finalized MAX revision and the replay removes it from the next page',async(context)=>{
  await withDatabase(context,async(pool)=>{
    const repository=new PostgresTransactionInboxRepository(pool);
    const signature='2'.repeat(64);
    await repository.enqueue(notification(signature,43n));
    const initial=await repository.claim(230_000,120);
    assert.ok(initial);
    await repository.saveSnapshot(signature,initial.leaseToken,normalized(signature,43n));
    await repository.markProcessed(signature,initial.leaseToken,'confirmed');
    await pool.query(`UPDATE chain_transaction_inbox
      SET finality_evidence_version=$2 WHERE signature=$1`,[
      signature,MAX_FINALITY_EVIDENCE_VERSION.toString(),
    ]);
    const reconciler=new FinalityReconciler({
      openPass(){return{
        providerId:'primary' as const,
        async getHistoryStatuses(){return Object.freeze([
          Object.freeze({ slot:43n,confirmationStatus:'finalized' as const }),
        ]);},
        async getFinalizedSlot(){return 43n;},
        async getFinalizedBlockSignatures(){throw new Error('block should not be read');},
      };},
    },repository,{ limit:1,now:()=>230_001 });

    assert.deepEqual(await reconciler.runOnce(),{
      candidateCount:1,pollCount:0,revisionCount:1,
    });
    assert.deepEqual(await finalityRowTuple(pool,signature),{
      confirmationStatus:'finalized',processingStatus:'PENDING',missingFinalityPolls:0,
      lastMissingFinalityProviderId:null,
      finalityEvidenceVersion:MAX_FINALITY_EVIDENCE_VERSION.toString(),
    });
    const replay=await repository.claim(230_002,120);
    assert.ok(replay);
    await repository.markProcessed(signature,replay.leaseToken,'finalized');
    assert.deepEqual(await reconciler.runOnce(),{
      candidateCount:0,pollCount:0,revisionCount:0,
    });
  });
});

void test('saturates finality evidence when processing a finalized terminal revision at the PostgreSQL limit', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const signature = 'max-finalized-terminal';
    await repository.enqueue(notification(signature, 42n));
    const initial = await repository.claim(220_000, 120);
    assert.ok(initial);
    await repository.saveSnapshot(signature, initial.leaseToken, normalized(signature, 42n));
    await repository.markProcessed(signature, initial.leaseToken, 'confirmed');
    await pool.query(
      `UPDATE chain_transaction_inbox
       SET finality_evidence_version = $2
       WHERE signature = $1`,
      [signature, (MAX_FINALITY_EVIDENCE_VERSION - 1n).toString()],
    );

    await repository.enqueueRevision(Object.freeze({
      signature, confirmationStatus: 'finalized' as const, observedAtMs: 220_001,
    }));
    let stored = await row(pool, signature);
    assert.deepEqual({
      processing: stored.processing_status,
      confirmation: stored.target_confirmation_status,
      version: BigInt(stored.finality_evidence_version),
    }, {
      processing: 'PENDING', confirmation: 'finalized', version: MAX_FINALITY_EVIDENCE_VERSION,
    });
    const replay = await repository.claim(220_002, 120);
    assert.ok(replay);
    await repository.markProcessed(signature, replay.leaseToken, 'finalized');
    await repository.enqueueRevision(Object.freeze({
      signature, confirmationStatus: 'finalized' as const, observedAtMs: 220_003,
    }));
    stored = await row(pool, signature);
    assert.deepEqual({
      processing: stored.processing_status,
      confirmation: stored.target_confirmation_status,
      version: BigInt(stored.finality_evidence_version),
    }, {
      processing: 'PROCESSED', confirmation: 'finalized', version: MAX_FINALITY_EVIDENCE_VERSION,
    });
    await assertFinalityConflict(repository.recordFinalityPoll(Object.freeze({
      signature, confirmationStatus: null, providerId: 'primary' as const,
      expectedMissingFinalityPolls: 0, expectedLastMissingFinalityProviderId: null,
      expectedFinalityEvidenceVersion: MAX_FINALITY_EVIDENCE_VERSION, observedAtMs: 220_004,
    })));
  });
});

void test('rolls back finalized completion when a divergent durable replay receipt exists',async(context)=>{
  await withDatabase(context,async(pool)=>{
    const repository=new PostgresTransactionInboxRepository(pool);
    const signature='divergent-finalized-receipt';
    await repository.enqueue(notification(signature,42n));
    const initial=await repository.claim(220_000,120);
    assert.ok(initial);
    await repository.saveSnapshot(signature,initial.leaseToken,normalized(signature,42n));
    await repository.markProcessed(signature,initial.leaseToken,'confirmed');
    await repository.enqueueRevision(Object.freeze({
      signature,confirmationStatus:'finalized' as const,observedAtMs:220_001,
    }));
    const replay=await repository.claim(220_002,120);
    assert.ok(replay);
    await pool.query(`INSERT INTO chain_transaction_finality_replay_receipts (
      signature,observed_slot,confirmation_status,finality_evidence_version,
      immutable_fingerprint,replay_completed_at
    ) VALUES ($1,42,'finalized',999,$2,$3)`,[
      signature,'b'.repeat(64),new Date(200_000),
    ]);

    await assert.rejects(
      repository.markProcessed(signature,replay.leaseToken,'finalized'),
      TransactionInboxLeaseError,
    );
    const stored=await row(pool,signature);
    assert.equal(stored.processing_status,'PROCESSING');
    assert.equal(stored.target_confirmation_status,'finalized');
    assert.equal((await pool.query(`SELECT immutable_fingerprint
      FROM chain_transaction_finality_replay_receipts WHERE signature=$1`,[
      signature,
    ])).rows[0]?.immutable_fingerprint,'b'.repeat(64));
  });
});

void test('merges late finalized discovery provenance without changing terminal proof',async(context)=>{
  await withDatabase(context,async(pool)=>{
    const repository=new PostgresTransactionInboxRepository(pool);
    const signature='finalized-receipt-duplicate';
    await repository.enqueue(notification(signature,42n,'WEBSOCKET','finalized'));
    const claim=await repository.claim(220_000,120);
    assert.ok(claim);
    await repository.saveSnapshot(signature,claim.leaseToken,normalized(signature,42n));
    await repository.markProcessed(signature,claim.leaseToken,'finalized');
    const before=await pool.query(`SELECT inbox.discovery_sources,inbox.program_ids,
      inbox.target_confirmation_status,inbox.finality_evidence_version::text AS version,
      inbox.processed_at,receipt.finality_evidence_version::text AS receipt_version,
      receipt.immutable_fingerprint,receipt.replay_completed_at
      FROM chain_transaction_inbox inbox
      JOIN chain_transaction_finality_replay_receipts receipt USING (signature)
      WHERE inbox.signature=$1`,[signature]);

    await repository.enqueue(notification(signature,42n,'CATCH_UP','confirmed',220_001));

    const after=await pool.query(`SELECT inbox.discovery_sources,inbox.program_ids,
      inbox.target_confirmation_status,inbox.finality_evidence_version::text AS version,
      inbox.processed_at,receipt.finality_evidence_version::text AS receipt_version,
      receipt.immutable_fingerprint,receipt.replay_completed_at
      FROM chain_transaction_inbox inbox
      JOIN chain_transaction_finality_replay_receipts receipt USING (signature)
      WHERE inbox.signature=$1`,[signature]);
    assert.deepEqual(after.rows,[{
      ...before.rows[0],
      discovery_sources:['WEBSOCKET','CATCH_UP'],
      program_ids:[
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
      ],
    }]);
  });
});

void test('uses a purged finalized receipt as a terminal enqueue tombstone',async(context)=>{
  await withDatabase(context,async(pool)=>{
    const repository=new PostgresTransactionInboxRepository(pool);
    const signature='finalized-receipt-tombstone';
    await repository.enqueue(notification(signature,43n,'WEBSOCKET','finalized'));
    const claim=await repository.claim(230_000,120);
    assert.ok(claim);
    await repository.saveSnapshot(signature,claim.leaseToken,normalized(signature,43n));
    await repository.markProcessed(signature,claim.leaseToken,'finalized');
    await pool.query('DELETE FROM chain_transaction_inbox WHERE signature=$1',[signature]);

    await repository.enqueue(notification(signature,43n,'CATCH_UP','confirmed',230_001));
    assert.equal((await pool.query(
      'SELECT COUNT(*) FROM chain_transaction_inbox WHERE signature=$1',[signature],
    )).rows[0]?.count,'0');
    await assert.rejects(
      repository.enqueue(notification(signature,44n,'WEBSOCKET','finalized',230_002)),
      TransactionInboxConflictError,
    );
    await assert.rejects(repository.enqueueRevision(Object.freeze({
      signature,
      confirmationStatus: 'orphaned',
      expectedConfirmationStatus: 'confirmed',
      expectedMissingFinalityPolls: 1,
      expectedLastMissingFinalityProviderId: 'primary',
      expectedFinalityEvidenceVersion: 1n,
      observedAtMs: 230_003,
    })), TransactionInboxConflictError);
  });
});

void test('uses a purged orphaned receipt as a non-resurrectable terminal tombstone',async(context)=>{
  await withDatabase(context,async(pool)=>{
    const repository=new PostgresTransactionInboxRepository(pool);
    const signature='orphaned-receipt-tombstone';
    await repository.enqueue(notification(signature,44n,'WEBSOCKET','confirmed'));
    const claim=await repository.claim(240_000,120);
    assert.ok(claim);
    await repository.saveSnapshot(signature,claim.leaseToken,normalized(signature,44n));
    await pool.query(`UPDATE chain_transaction_inbox SET target_confirmation_status='orphaned'
      WHERE signature=$1`,[signature]);
    await repository.markProcessed(signature,claim.leaseToken,'orphaned');
    await pool.query('DELETE FROM chain_transaction_inbox WHERE signature=$1',[signature]);

    await assert.rejects(
      repository.enqueue(notification(signature,44n,'CATCH_UP','confirmed',240_001)),
      TransactionInboxConflictError,
    );
    assert.equal((await pool.query(
      'SELECT COUNT(*) FROM chain_transaction_inbox WHERE signature=$1',[signature],
    )).rows[0]?.count,'0');
    assert.equal((await pool.query(`SELECT confirmation_status
      FROM chain_transaction_finality_replay_receipts WHERE signature=$1`,[signature]))
      .rows[0]?.confirmation_status,'orphaned');
  });
});

void test('uses a purged finalized receipt as a terminal classification tombstone', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const signature = 'finalized-classification-tombstone';
    await repository.enqueue(notification(signature, 45n, 'WEBSOCKET', 'finalized'));
    const claim = await repository.claim(250_000, 120);
    assert.ok(claim);
    await repository.saveSnapshot(signature, claim.leaseToken, normalized(signature, 45n));
    await repository.markProcessed(signature, claim.leaseToken, 'finalized');
    await pool.query('DELETE FROM chain_transaction_inbox WHERE signature=$1', [signature]);

    const replay = createCatchUpClassification({
      ...catchUpClassificationInput(signature), slot: 45n, confirmationStatus: 'confirmed',
    });
    assert.deepEqual(await repository.recordCatchUpClassification(replay), {
      signature, slot: 45n, disposition: null, persistence: 'ALREADY_ADMITTED',
      admission: 'NOT_ENQUEUED', ingestionPriority: null,
    });
    assert.equal((await pool.query(
      'SELECT COUNT(*) FROM chain_transaction_inbox WHERE signature=$1', [signature],
    )).rows[0]?.count, '0');
    await assert.rejects(repository.recordCatchUpClassification(createCatchUpClassification({
      ...catchUpClassificationInput(signature), slot: 46n, confirmationStatus: 'finalized',
    })), TransactionInboxConflictError);
  });
});

void test('uses a purged orphaned receipt as a non-resurrectable classification tombstone', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const signature = 'orphaned-classification-tombstone';
    await repository.enqueue(notification(signature, 46n, 'WEBSOCKET', 'confirmed'));
    const claim = await repository.claim(260_000, 120);
    assert.ok(claim);
    await repository.saveSnapshot(signature, claim.leaseToken, normalized(signature, 46n));
    await pool.query(
      "UPDATE chain_transaction_inbox SET target_confirmation_status='orphaned' WHERE signature=$1",
      [signature],
    );
    await repository.markProcessed(signature, claim.leaseToken, 'orphaned');
    await pool.query('DELETE FROM chain_transaction_inbox WHERE signature=$1', [signature]);

    await assert.rejects(repository.recordCatchUpClassification(createCatchUpClassification({
      ...catchUpClassificationInput(signature), slot: 46n, confirmationStatus: 'confirmed',
    })), TransactionInboxConflictError);
    assert.equal((await pool.query(
      'SELECT COUNT(*) FROM chain_transaction_inbox WHERE signature=$1', [signature],
    )).rows[0]?.count, '0');
  });
});

void test('saturates finality evidence when processing an orphaned terminal revision at the PostgreSQL limit', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const signature = 'max-orphaned-terminal';
    await repository.enqueue(notification(signature, 43n));
    const initial = await repository.claim(230_000, 120);
    assert.ok(initial);
    await repository.saveSnapshot(signature, initial.leaseToken, normalized(signature, 43n));
    await repository.markProcessed(signature, initial.leaseToken, 'confirmed');
    await pool.query(
      `UPDATE chain_transaction_inbox
       SET finality_evidence_version = $2,
           missing_finality_polls = $3,
           last_missing_finality_provider_id = $4
       WHERE signature = $1`,
      [
        signature,
        (MAX_FINALITY_EVIDENCE_VERSION - 1n).toString(),
        1,
        'primary',
      ],
    );

    await repository.enqueueRevision(Object.freeze({
      signature,
      confirmationStatus: 'orphaned' as const,
      expectedConfirmationStatus: 'confirmed' as const,
      expectedMissingFinalityPolls: 1,
      expectedLastMissingFinalityProviderId: 'primary' as const,
      expectedFinalityEvidenceVersion: MAX_FINALITY_EVIDENCE_VERSION - 1n,
      observedAtMs: 230_001,
    }));
    let stored = await row(pool, signature);
    assert.deepEqual({
      processing: stored.processing_status,
      confirmation: stored.target_confirmation_status,
      missing: stored.missing_finality_polls,
      provider: stored.last_missing_finality_provider_id,
      version: BigInt(stored.finality_evidence_version),
    }, {
      processing: 'PENDING', confirmation: 'orphaned', missing: 0, provider: null,
      version: MAX_FINALITY_EVIDENCE_VERSION,
    });
    const replay = await repository.claim(230_002, 120);
    assert.ok(replay);
    await repository.markProcessed(signature, replay.leaseToken, 'orphaned');
    await repository.enqueueRevision(Object.freeze({
      signature,
      confirmationStatus: 'orphaned' as const,
      expectedConfirmationStatus: 'confirmed' as const,
      expectedMissingFinalityPolls: 1,
      expectedLastMissingFinalityProviderId: 'primary' as const,
      expectedFinalityEvidenceVersion: MAX_FINALITY_EVIDENCE_VERSION - 1n,
      observedAtMs: 230_003,
    }));
    stored = await row(pool, signature);
    assert.deepEqual({
      processing: stored.processing_status,
      confirmation: stored.target_confirmation_status,
      missing: stored.missing_finality_polls,
      provider: stored.last_missing_finality_provider_id,
      version: BigInt(stored.finality_evidence_version),
    }, {
      processing: 'PROCESSED', confirmation: 'orphaned', missing: 0, provider: null,
      version: MAX_FINALITY_EVIDENCE_VERSION,
    });
    await assertFinalityConflict(repository.recordFinalityPoll(Object.freeze({
      signature, confirmationStatus: null, providerId: 'primary' as const,
      expectedMissingFinalityPolls: 0, expectedLastMissingFinalityProviderId: null,
      expectedFinalityEvidenceVersion: MAX_FINALITY_EVIDENCE_VERSION, observedAtMs: 230_004,
    })));
  });
});

void test('terminalizes a capped expired lease and claims the next row atomically', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool, Object.freeze({
      maxAttempts: 2,
      baseDelayMs: 500,
    }));
    await repository.enqueue(notification('expired-capped', 39n));
    const first = await repository.claim(195_000, 1);
    assert.ok(first);
    const second = await repository.claim(first.leaseExpiresAtMs + 1, 1);
    assert.ok(second);
    assert.equal(second.signature, 'expired-capped');
    await repository.enqueue(notification('after-expired', 40n));

    const next = await repository.claim(second.leaseExpiresAtMs + 1, 1);
    assert.equal(next?.signature, 'after-expired');
    const expired = await row(pool, 'expired-capped');
    assert.equal(expired.processing_status, 'FAILED');
    assert.equal(expired.error_code, 'WORKER_LEASE_EXPIRED');
    assert.equal(expired.error_name, 'TransactionInboxLeaseExpired');
    assert.equal(expired.error_retryable, true);
    assert.ok(expired.retry_exhausted_at);
    assert.ok(expired.terminal_at);
    assert.equal(expired.next_attempt_at, null);
  });
});

void test('persists every internal pipeline code terminal at the first PostgreSQL claim without secrets', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const cases = [
      ...PUMP_DECODING_ERROR_CODES.map((code) => ({ code, stage: 'launchpad_observation' as const,
        origin: createPumpDecodingError(code, true, 'secret provider URL', 'secret signature') })),
      ...PUMPSWAP_DECODING_ERROR_CODES.map((code) => ({ code, stage: 'pumpswap_observation' as const,
        origin: createPumpSwapDecodingError(code, 'secret provider URL', 'secret signature') })),
    ];
    for (const [index, scenario] of cases.entries()) {
      const signature = `taxonomy-${index}`;
      await repository.enqueue(notification(signature, 1n, 'WEBSOCKET', 'confirmed'));
      const worker = new TransactionInboxWorker(repository, {
        async locate() { return failureTransaction(signature); },
      }, failurePipeline(() => { throw scenario.origin; }, scenario.stage), {
        leaseSeconds: 30, renewalIntervalMs: 1000, idlePollMs: 100,
      });
      assert.equal((await worker.runOnce()).kind, 'failed');
      await worker.close();
      const stored = await row(pool, signature);
      assert.equal(stored.error_code, 'PIPELINE_STAGE_FAILED');
      assert.equal(stored.error_name, `ObservedPipelineFailure.v1.${scenario.stage}.${scenario.code}`);
      assert.equal(stored.error_retryable, false);
      assert.equal(stored.attempts_in_cycle, 1);
      assert.equal(stored.next_attempt_at, null);
      assert.equal(stored.retry_exhausted_at, null);
      assert.ok(stored.terminal_at);
      assert.equal(stored.purge_after.getTime() - stored.terminal_at.getTime(), 14_400_000);
      assert.ok(stored.normalized_transaction);
      assert.doesNotMatch(JSON.stringify(stored), /secret|provider URL/);
      assert.equal(await repository.claim(Date.now() + 60000, 30), null);
    }
  });
});

void test('PostgreSQL real Pump decode failures terminalize fresh and legacy-snapshot replay without RPC', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool, { maxAttempts: 5, baseDelayMs: 1000 });
    for (const replay of [false, true]) {
      for (const code of ['PUMP_BORSH_INVALID', 'PUMP_BORSH_TRUNCATED', 'PUMP_ACCOUNT_MISSING'] as const) {
        const signature = `real-${code}-${replay}`;
        const transaction = malformedPumpTransaction(code, signature);
        await repository.enqueue(notification(signature, 1n, 'WEBSOCKET', 'confirmed'));
        let now = Date.now();
        if (replay) {
          const seed = await repository.claim(now, 30);
          assert.ok(seed);
          await repository.saveSnapshot(signature, seed.leaseToken, transaction);
          await repository.markFailed(signature, seed.leaseToken, Object.freeze({
            code: 'PIPELINE_STAGE_FAILED', errorName: 'ObservedPipelineFailure.v1.unclassified.UNKNOWN', retryable: true,
          }));
          // Existing legacy rows remain readable; no new legacy writes through the repository.
          await pool.query("UPDATE chain_transaction_inbox SET error_name='ObservedPipelineError' WHERE signature=$1", [signature]);
          now = new Date((await row(pool, signature)).next_attempt_at).getTime() + 1;
        }
        const worker = new TransactionInboxWorker(repository, {
          async locate() { assert.equal(replay, false); return transaction; },
        }, realPumpPipeline(), { leaseSeconds: 30, renewalIntervalMs: 1000, idlePollMs: 100, now: () => now });
        assert.equal((await worker.runOnce()).kind, 'failed');
        await worker.close();
        const stored = await row(pool, signature);
        assert.equal(stored.error_name, `ObservedPipelineFailure.v1.launchpad_observation.${code}`);
        assert.equal(stored.error_retryable, false);
        assert.equal(stored.attempts_in_cycle, replay ? 2 : 1);
        assert.ok(stored.terminal_at);
        assert.equal(stored.next_attempt_at, null);
        assert.equal(await repository.claim(now + 60000, 30), null);
      }
    }
  });
});

void test('PostgreSQL snapshot replay stays offline and foreign DB/RPC failures remain scheduled', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool, { maxAttempts: 5, baseDelayMs: 1000 });
    for (const stage of ['load_tracked_mints', 'pumpswap_observation'] as const) {
      const signature = `transient-${stage}`;
      await repository.enqueue(notification(signature, 1n, 'WEBSOCKET', 'confirmed'));
      const first = await repository.claim(Date.now(), 30);
      assert.ok(first);
      await repository.saveSnapshot(signature, first.leaseToken, failureTransaction(signature));
      await repository.markFailed(signature, first.leaseToken, Object.freeze({
        code: 'PIPELINE_STAGE_FAILED', errorName: 'ObservedPipelineFailure.v1.unclassified.UNKNOWN', retryable: true,
      }));
      const retryAt = new Date((await row(pool, signature)).next_attempt_at).getTime();
      let now = retryAt + 1;
      const worker = new TransactionInboxWorker(repository, {
        async locate() { assert.fail('snapshot replay must not invoke RPC locator'); },
      }, failurePipeline(() => { throw new Error('secret DB/RPC URL'); }, stage), {
        leaseSeconds: 30, renewalIntervalMs: 1000, idlePollMs: 100, now: () => now,
      });
      assert.equal((await worker.runOnce()).kind, 'failed');
      await worker.close();
      const stored = await row(pool, signature);
      assert.equal(stored.error_name, `ObservedPipelineFailure.v1.${stage}.UNKNOWN`);
      assert.equal(stored.error_retryable, true);
      assert.equal(stored.terminal_at, null);
      assert.ok(stored.next_attempt_at);
      assert.doesNotMatch(JSON.stringify(stored), /secret/);
      now = new Date(stored.next_attempt_at).getTime() + 1;
      const retried = await repository.claim(now, 30);
      assert.ok(retried);
      // Finish the synthetic row so the next scenario has its own claim.
      await repository.markProcessed(signature, retried.leaseToken, 'confirmed');
    }
  });
});

void test('schedules retryable failures, keeps deterministic failures terminal, and counts states', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool, Object.freeze({
      maxAttempts: 3,
      baseDelayMs: 1_000,
    }));
    await repository.enqueue(notification('retry', 40n));
    await repository.enqueue(notification('fatal', 41n));
    const retry = await repository.claim(200_000, 120);
    assert.ok(retry);
    await repository.markFailed('retry', retry.leaseToken, Object.freeze({
      code: 'RPC_TRANSIENT', errorName: 'RpcError', retryable: true,
    }));
    const failed = await row(pool, 'retry');
    assert.equal(failed.error_code, 'RPC_TRANSIENT');
    assert.equal(failed.error_name, 'RpcError');
    assert.ok(failed.next_attempt_at);
    assert.equal(
      new Date(failed.next_attempt_at).getTime() - new Date(failed.updated_at).getTime(),
      1_000,
    );
    assert.equal(failed.retry_max_attempts, 3);
    assert.equal(failed.retry_base_delay_ms, 1_000);
    assert.equal(failed.attempts_in_cycle, 1);
    assert.equal(await repository.claim(200_001, 120)?.then((value) => value?.signature), 'fatal');

    const fatalClaim = await repository.claim(200_002, 120);
    assert.equal(fatalClaim, null);
    const fatalRow = await row(pool, 'fatal');
    await repository.markFailed('fatal', fatalRow.lease_token, Object.freeze({
      code: 'NORMALIZATION_FAILED', errorName: 'TypeError', retryable: false,
    }));
    const terminalFailure = await row(pool, 'fatal');
    assert.equal(terminalFailure.next_attempt_at, null);
    assert.ok(terminalFailure.terminal_at);
    assert.equal(
      new Date(terminalFailure.purge_after).getTime()
        - new Date(terminalFailure.terminal_at).getTime(),
      4 * 60 * 60 * 1_000,
    );
    assert.deepEqual(await repository.counts(), {
      pending: 0, processing: 0, processed: 0, failed: 2,
      retryableFailed: 1, exhaustedFailed: 0, decoderQuarantinedCount: 0,
      catchUpAdmission: {
        actionableBacklogBySource: { websocketOnly: 1, catchUpOnly: 0, websocketAndCatchUp: 0 },
        actionableBacklogByPriority: { normal: 1, launchCandidate: 0, trackedTrade: 0 },
        deferredCount: 0, ignoredCount: 0, quarantinedCount: 0,
      },
    });
    const retryAt = new Date(failed.next_attempt_at).getTime();
    assert.equal(await repository.claim(retryAt - 1, 120), null);
    const retried = await repository.claim(retryAt + 1, 120);
    assert.ok(retried);
    assert.equal(retried.signature, 'retry');
    assert.equal(retried.attempts, 2);
    await repository.markFailed('retry', retried.leaseToken, Object.freeze({
      code: 'RPC_TRANSIENT', errorName: 'RpcError', retryable: true,
    }));
    let capped = await row(pool, 'retry');
    assert.equal(
      new Date(capped.next_attempt_at).getTime() - new Date(capped.updated_at).getTime(),
      2_000,
    );
    const nextAttemptMs = new Date(capped.next_attempt_at).getTime();
    const finalClaim = await repository.claim(nextAttemptMs + 1, 120);
    assert.equal(finalClaim?.attempts, 3);
    assert.equal(finalClaim.signature, 'retry');
    await repository.markFailed('retry', finalClaim.leaseToken, Object.freeze({
      code: 'RPC_TRANSIENT', errorName: 'RpcError', retryable: true,
    }));
    capped = await row(pool, 'retry');
    assert.equal(capped.attempts_in_cycle, 3);
    assert.equal(capped.next_attempt_at, null);
    assert.ok(capped.retry_exhausted_at);
    assert.ok(capped.terminal_at);
    assert.equal(
      new Date(capped.purge_after).getTime() - new Date(capped.terminal_at).getTime(),
      4 * 60 * 60 * 1_000,
    );
    assert.equal(await repository.claim(Date.now() + 86_400_000, 120), null);
    assert.deepEqual(await repository.counts(), {
      pending: 0, processing: 0, processed: 0, failed: 2,
      retryableFailed: 0, exhaustedFailed: 1, decoderQuarantinedCount: 0,
      catchUpAdmission: {
        actionableBacklogBySource: { websocketOnly: 0, catchUpOnly: 0, websocketAndCatchUp: 0 },
        actionableBacklogByPriority: { normal: 0, launchCandidate: 0, trackedTrade: 0 },
        deferredCount: 0, ignoredCount: 0, quarantinedCount: 0,
      },
    });

    await repository.enqueue(notification('unsafe-error-name', 42n));
    const unsafe = await repository.claim(Date.now() + 86_400_001, 120);
    assert.ok(unsafe);
    assert.equal(unsafe.signature, 'unsafe-error-name');
    await assert.rejects(repository.markFailed(
      'unsafe-error-name', unsafe.leaseToken,
      Object.freeze({
        code: 'RPC_TRANSIENT',
        errorName: 'https://rpc.invalid/key?token=secret',
        retryable: true,
      }),
    ), TransactionInboxRepositoryError);
    const unsafeRow = await row(pool, 'unsafe-error-name');
    assert.equal(unsafeRow.processing_status, 'PROCESSING');
    assert.equal(unsafeRow.error_name, null);
  });
});

void test('recovers one exhausted cycle idempotently without erasing lifetime attempts', async (context) => {
  await withDatabase(context, async (pool) => {
    const firstPolicy = new PostgresTransactionInboxRepository(pool, Object.freeze({
      maxAttempts: 1,
      baseDelayMs: 500,
    }));
    await firstPolicy.enqueue(notification('manual-recovery', 43n));
    const first = await firstPolicy.claim(210_000, 120);
    assert.ok(first);
    await firstPolicy.markFailed('manual-recovery', first.leaseToken, Object.freeze({
      code: 'RPC_TRANSIENT', errorName: 'RpcError', retryable: true,
    }));

    const currentPolicy = new PostgresTransactionInboxRepository(pool, Object.freeze({
      maxAttempts: 2,
      baseDelayMs: 1_000,
    }));
    assert.deepEqual(await currentPolicy.recoverExhausted('manual-recovery'), {
      code: 'RECOVERY_SCHEDULED', signature: 'manual-recovery',
    });
    const recovered = await row(pool, 'manual-recovery');
    assert.equal(recovered.processing_status, 'PENDING');
    assert.equal(recovered.attempts, 1);
    assert.equal(recovered.attempts_in_cycle, 0);
    assert.equal(recovered.retry_max_attempts, 2);
    assert.equal(recovered.retry_base_delay_ms, 1_000);
    assert.equal(recovered.error_code, null);
    assert.equal(recovered.retry_exhausted_at, null);
    assert.equal(recovered.terminal_at, null);
    assert.equal(recovered.purge_after, null);
    assert.equal(recovered.manual_recovery_count, 1);
    assert.ok(recovered.last_manual_recovery_at);

    assert.deepEqual(await currentPolicy.recoverExhausted('manual-recovery'), {
      code: 'RECOVERY_ALREADY_SCHEDULED', signature: 'manual-recovery',
    });
    assert.equal((await row(pool, 'manual-recovery')).manual_recovery_count, 1);
    assert.equal((await pool.query(
      "SELECT COUNT(*) FROM transaction_inbox_recoveries WHERE signature = 'manual-recovery'",
    )).rows[0]?.count, '1');

    const second = await currentPolicy.claim(Date.now() + 1_000, 120);
    assert.ok(second);
    assert.equal(second.attempts, 2);
    assert.equal((await row(pool, 'manual-recovery')).attempts_in_cycle, 1);
    await currentPolicy.markFailed('manual-recovery', second.leaseToken, Object.freeze({
      code: 'RPC_TRANSIENT', errorName: 'RpcError', retryable: true,
    }));
    assert.ok((await row(pool, 'manual-recovery')).next_attempt_at);

    assert.deepEqual(await currentPolicy.recoverExhausted('missing'), {
      code: 'RECOVERY_NOT_FOUND', signature: 'missing',
    });
    assert.deepEqual(await currentPolicy.recoverExhausted('manual-recovery'), {
      code: 'RECOVERY_NOT_ELIGIBLE', signature: 'manual-recovery',
    });
  });
});

void test('stores monotonic checkpoints, runtime heartbeats, and purges only terminal work', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    assert.equal(await repository.readCheckpoint('launchpad'), null);
    await repository.storeCheckpoint(Object.freeze({
      key: 'launchpad', slot: 50n, signature: 'checkpoint', updatedAtMs: 300_000,
    }));
    await repository.storeCheckpoint(Object.freeze({
      key: 'launchpad', slot: 50n, signature: 'checkpoint', updatedAtMs: 300_001,
    }));
    await repository.storeCheckpoint(Object.freeze({
      key: 'launchpad', slot: 50n, signature: 'new-same-slot-head', updatedAtMs: 300_002,
    }));
    assert.deepEqual(await repository.readCheckpoint('launchpad'), {
      key: 'launchpad', slot: 50n, signature: 'new-same-slot-head', updatedAtMs: 300_002,
    });
    await assert.rejects(repository.storeCheckpoint(Object.freeze({
      key: 'launchpad', slot: 50n, signature: 'stale-same-slot-head', updatedAtMs: 300_001,
    })), TransactionInboxConflictError);
    await assert.rejects(repository.storeCheckpoint(Object.freeze({
      key: 'launchpad', slot: 49n, signature: 'older', updatedAtMs: 300_003,
    })), TransactionInboxConflictError);

    const heartbeat: RuntimeHeartbeat = Object.freeze({
      runtimeState: 'RUNNING', subscriberState: 'RUNNING', scannerState: 'RUNNING',
      workerState: 'RUNNING', reconcilerState: 'RUNNING', startedAtMs: 290_000,
      updatedAtMs: 300_000, lastHttpSlot: 51n, lastWebsocketSlot: 50n,
      lastFinalizedSlot: 49n, lastSignature: 'checkpoint', backlogCount: 3, leasedCount: 1,
      exhaustedCount: 0,
      blockHydration: Object.freeze({
        version: 1, enabled: true, callerConcurrency: 1,
        locates: 3, hits: 2, misses: 1, inFlightJoins: 0, fetches: 1,
        forcedRefreshes: 0, evictions: 0, oversizeBypasses: 0, fetchFailures: 0,
        epochInvalidations: 0, retainedEntries: 1, retainedBytes: 1024,
        inFlightFetches: 0, queuedFetches: 0,
        queueDelayMs: Object.freeze({ last: 0, maximum: 0 }),
      }),
    });
    await repository.writeHeartbeat(heartbeat);
    await repository.writeHeartbeat(Object.freeze({
      ...heartbeat,
      runtimeState: 'DEGRADED',
      subscriberState: 'STOPPED',
      updatedAtMs: 299_999,
      lastHttpSlot: 1n,
      lastSignature: 'stale',
      backlogCount: 0,
      leasedCount: 0,
    }));
    await repository.writeHeartbeat(Object.freeze({
      ...heartbeat,
      runtimeState: 'STOPPED',
      updatedAtMs: 300_000,
      lastHttpSlot: 2n,
      lastSignature: 'equal-conflict',
    }));
    const storedHeartbeat = (await pool.query(
      "SELECT * FROM listener_heartbeats WHERE service_key = 'transaction-listener'",
    )).rows[0];
    assert.equal(storedHeartbeat.pending_transactions, 3);
    assert.equal(storedHeartbeat.leased_transactions, 1);
    assert.equal(storedHeartbeat.exhausted_transactions, 0);
    assert.equal(storedHeartbeat.last_http_slot, '51');
    assert.equal(storedHeartbeat.runtime_state, 'RUNNING');
    assert.equal(storedHeartbeat.last_signature, 'checkpoint');
    assert.deepEqual(storedHeartbeat.payload, {
      startedAt: '1970-01-01T00:04:50.000Z',
      blockHydration: heartbeat.blockHydration,
    });

    await insertTerminal(pool, 'purge-me', new Date(Date.now() - 1_000));
    await insertTerminal(pool, 'keep-me', new Date(Date.now() + 60_000));
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, observed_at, first_detected_at
    ) VALUES ('failed-purge-me', 51, ARRAY['WEBSOCKET'], ARRAY[$1],
      'processed', 'PENDING', clock_timestamp(), NULL)`, [PUMP_PROGRAM_ID]);
    const failedClaim = await repository.claim(Date.now(), 120);
    assert.equal(failedClaim?.signature, 'failed-purge-me');
    await repository.markFailed('failed-purge-me', failedClaim.leaseToken, Object.freeze({
      code: 'NORMALIZATION_FAILED', errorName: 'TypeError', retryable: false,
    }));
    await pool.query(`UPDATE chain_transaction_inbox inbox
      SET terminal_at = retained.terminal_at,
          purge_after = retained.terminal_at + INTERVAL '4 hours'
      FROM (SELECT clock_timestamp() - INTERVAL '5 hours' AS terminal_at) retained
      WHERE inbox.signature = 'failed-purge-me'`);
    await pool.query(`WITH recovery_clock AS MATERIALIZED (
      SELECT clock_timestamp() AS recovered_at
    )
    INSERT INTO transaction_inbox_recoveries (
      signature, exhausted_at, recovered_at, lifetime_attempts, cycle_attempts,
      retry_max_attempts, retry_base_delay_ms, recovery_source, purge_after
    )
    SELECT 'failed-purge-me', recovered_at - INTERVAL '1 hour', recovered_at,
           1, 1, 1, 500, 'LOCAL_CLI', recovered_at + INTERVAL '4 hours'
    FROM recovery_clock`);
    const firstPurge = await purgeExpiredFoundationData(pool);
    assert.equal(firstPurge.websocketHealthEvidence, 0);
    assert.equal(firstPurge.transactionInbox, 2);
    assert.equal(firstPurge.transactionInboxRecoveries, 0);
    assert.equal((await pool.query("SELECT COUNT(*) FROM chain_transaction_inbox WHERE signature = 'keep-me'")).rows[0]?.count, '1');
    assert.equal((await pool.query(
      "SELECT COUNT(*) FROM chain_transaction_inbox WHERE signature = 'failed-purge-me'",
    )).rows[0]?.count, '0');
    assert.equal((await pool.query(
      "SELECT COUNT(*) FROM transaction_inbox_recoveries WHERE signature = 'failed-purge-me'",
    )).rows[0]?.count, '1');

    await pool.query(`UPDATE transaction_inbox_recoveries
      SET exhausted_at = TIMESTAMPTZ '2020-01-01T00:00:00Z',
          recovered_at = TIMESTAMPTZ '2020-01-01T01:00:00Z',
          purge_after = TIMESTAMPTZ '2020-01-01T05:00:00Z'
      WHERE signature = 'failed-purge-me'`);
    const secondPurge = await purgeExpiredFoundationData(pool);
    assert.equal(secondPurge.websocketHealthEvidence, 0);
    assert.equal(secondPurge.transactionInbox, 0);
    assert.equal(secondPurge.transactionInboxRecoveries, 1);
  });
});

void test('records a catch-up gap and replays its logical cursor independently of observation time', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.storeCheckpoint(Object.freeze({
      key: 'launchpad', slot: 40n, signature: 'previous', updatedAtMs: 300_000,
    }));
    const gap = createCatchUpGap(
      Object.freeze({ key: 'launchpad', slot: 40n, signature: 'previous', updatedAtMs: 300_000 }),
      Object.freeze({ key: 'launchpad', slot: 50n, signature: 'baseline', updatedAtMs: 301_000 }),
      301_000,
    );
    const concurrentReplay = createCatchUpGap(
      Object.freeze({ key: 'launchpad', slot: 40n, signature: 'previous', updatedAtMs: 300_000 }),
      Object.freeze({ key: 'launchpad', slot: 50n, signature: 'baseline', updatedAtMs: 302_000 }),
      302_000,
    );
    assert.equal(concurrentReplay.gapId, gap.gapId);

    await repository.recordCatchUpGap(gap);
    await repository.recordCatchUpGap(concurrentReplay);

    assert.deepEqual(await repository.readCheckpoint('launchpad'), {
      key: 'launchpad', slot: 50n, signature: 'baseline', updatedAtMs: 301_000,
    });
    const rows = await pool.query(
      `SELECT gap_id,checkpoint_key,previous_slot,baseline_slot,
         (EXTRACT(EPOCH FROM observed_at) * 1000)::bigint AS observed_at_ms,
         (EXTRACT(EPOCH FROM purge_after) * 1000)::bigint AS purge_after_ms
       FROM listener_catch_up_gaps`,
    );
    assert.deepEqual(rows.rows, [{
      gap_id: gap.gapId,
      checkpoint_key: 'launchpad',
      previous_slot: '40',
      baseline_slot: '50',
      observed_at_ms: '301000',
      purge_after_ms: '14701000',
    }]);
  });
});

void test('uses exact checkpoint CAS identities and rejects invalid strict checkpoint inputs before I/O', async () => {
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => { throw new Error('database access must not occur'); },
    query: async () => { throw new Error('database access must not occur'); },
  });
  const strictRepository: StrictCatchUpRepository = repository;
  const valid = checkpoint('launchpad', 40n, 'strict-valid', 300_000);

  await assert.rejects(
    strictRepository.compareAndSwapCheckpoint(null, { ...valid } as ProcessingCheckpoint),
    (error) => error instanceof TransactionInboxRepositoryError
      && error.message === 'Transaction inbox repository operation failed.',
  );
  await assert.rejects(
    strictRepository.compareAndSwapCheckpoint(
      checkpoint('market', 40n, 'foreign-key', 300_000), valid,
    ),
    (error) => error instanceof TransactionInboxRepositoryError
      && error.message === 'Transaction inbox repository operation failed.',
  );
  await assert.rejects(
    strictRepository.compareAndSwapCheckpoint(
      null,
      checkpoint('launchpad', 10n ** 78n, 'outside-postgresql-numeric-bound', 300_000),
    ),
    (error) => error instanceof TransactionInboxRepositoryError
      && error.message === 'Transaction inbox repository operation failed.',
  );
  await assert.rejects(
    strictRepository.resolveStrictCatchUpFailures('invalid' as never, null),
    (error) => error instanceof TransactionInboxRepositoryError
      && error.message === 'Transaction inbox repository operation failed.',
  );
});

void test('persists resumable strict catch-up progress and atomically completes its checkpoint', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool) as unknown as StrictCatchUpRunRepository;
    const previous = checkpoint('launchpad', 40n, 'run-previous', 100_000);
    const run = createStrictCatchUpRun({
      checkpointKey: 'launchpad',
      previous,
      providerId: 'primary',
      observedHead: Object.freeze({ slot: 44n, signature: 'run-head' }),
      beforeSignature: 'run-first-cursor',
      lastAcceptedSlot: 44n,
      pagesScanned: 1n,
      signaturesEnqueued: 2n,
      signaturesClassified: 2n,
      revision: 0n,
      startedAtMs: 100_000,
      updatedAtMs: 100_001,
    });
    const advanced = advanceStrictCatchUpRun(run, {
      beforeSignature: 'run-next-cursor',
      lastAcceptedSlot: 42n,
      pagesScanned: 2n,
      signaturesEnqueued: 4n,
      signaturesClassified: 4n,
      updatedAtMs: 100_002,
    });
    const completed = terminalizeStrictCatchUpRun(advanced, {
      state: 'COMPLETED', terminalReason: null, completedAtMs: 100_003,
    });
    const next = checkpoint('launchpad', 44n, 'run-head', 100_003);

    await repository.compareAndSwapCheckpoint(null, previous);
    assert.deepEqual(await repository.createStrictCatchUpRun(run), run);
    assert.deepEqual(await repository.readActiveStrictCatchUpRun('launchpad'), run);
    await repository.advanceStrictCatchUpRun(run, advanced);
    assert.deepEqual(await repository.readActiveStrictCatchUpRun('launchpad'), advanced);
    await repository.completeStrictCatchUpRun({ run: advanced, nextCheckpoint: next });

    assert.equal(await repository.readActiveStrictCatchUpRun('launchpad'), null);
    assert.deepEqual(await repository.readCheckpoint('launchpad'), next);
    assert.deepEqual(await strictCatchUpRunRow(pool, completed.runId), {
      state: 'COMPLETED', revision: '2', previous_slot: '40',
      observed_head_slot: '44', last_accepted_slot: '42', pages_scanned: '2',
      signatures_enqueued: '4', signatures_classified: '4',
      updated_at_ms: '100003', completed_at_ms: '100003', purge_after_ms: '14500003',
    });
  });
});

void test('rolls back strict completion when the frozen checkpoint boundary is stale', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool) as unknown as StrictCatchUpRunRepository;
    const previous = checkpoint('launchpad', 60n, 'stale-completion-previous', 200_000);
    const run = strictCatchUpRun(previous, 'primary', 200_001);
    await repository.compareAndSwapCheckpoint(null, previous);
    await repository.createStrictCatchUpRun(run);
    const concurrent = checkpoint('launchpad', 61n, 'concurrent-checkpoint', 200_002);
    await repository.compareAndSwapCheckpoint(previous, concurrent);

    await assert.rejects(
      repository.completeStrictCatchUpRun({
        run,
        nextCheckpoint: checkpoint('launchpad', 64n, 'strict-run-head-primary', 200_003),
      }),
      (error) => error instanceof TransactionInboxConflictError && error.conflict === 'checkpoint',
    );
    assert.deepEqual(await repository.readCheckpoint('launchpad'), concurrent);
    assert.deepEqual(await repository.readActiveStrictCatchUpRun('launchpad'), run);
  });
});

void test('terminalizes failed and stale superseded runs without moving checkpoints', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool) as unknown as StrictCatchUpRunRepository;
    const previous = checkpoint('market', 70n, 'terminal-previous', 300_000);
    const failedRun = strictCatchUpRun(previous, 'primary', 300_001);
    const failed = terminalizeStrictCatchUpRun(failedRun, {
      state: 'FAILED', terminalReason: 'CATCH_UP_WINDOW_EXCEEDED', completedAtMs: 300_002,
    });
    await repository.compareAndSwapCheckpoint(null, previous);
    await repository.createStrictCatchUpRun(failedRun);
    await repository.failStrictCatchUpRun(failedRun, failed);
    assert.deepEqual(await repository.readCheckpoint('market'), previous);
    assert.equal(await repository.readActiveStrictCatchUpRun('market'), null);

    const supersededRun = strictCatchUpRun(previous, 'fallback-1', 300_003);
    await repository.createStrictCatchUpRun(supersededRun);
    await assert.rejects(
      repository.supersedeStaleStrictCatchUpRun(supersededRun, 300_004),
      TransactionInboxConflictError,
    );
    const changed = checkpoint('market', 71n, 'terminal-concurrent', 300_004);
    await repository.compareAndSwapCheckpoint(previous, changed);
    await repository.supersedeStaleStrictCatchUpRun(supersededRun, 300_005);
    await repository.supersedeStaleStrictCatchUpRun(supersededRun, 300_005);
    assert.deepEqual(await repository.readCheckpoint('market'), changed);
    assert.equal(await repository.readActiveStrictCatchUpRun('market'), null);
  });
});

void test('rejects obsolete strict progress and failure after the checkpoint advances first', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool) as unknown as StrictCatchUpRunRepository;
    const previous = checkpoint('market', 75n, 'checkpoint-first-previous', 350_000);
    const run = strictCatchUpRun(previous, 'primary', 350_001);
    const advancedRun = advanceStrictCatchUpRun(run, {
      beforeSignature: 'checkpoint-first-cursor', lastAcceptedSlot: 77n,
      pagesScanned: 2n, signaturesEnqueued: 3n, signaturesClassified: 3n, updatedAtMs: 350_002,
    });
    const failedRun = terminalizeStrictCatchUpRun(run, {
      state: 'FAILED', terminalReason: 'CATCH_UP_WINDOW_EXCEEDED', completedAtMs: 350_003,
    });
    const checkpointFirst = checkpoint('market', 76n, 'checkpoint-first-advanced', 350_002);
    await repository.compareAndSwapCheckpoint(null, previous);
    await repository.createStrictCatchUpRun(run);
    await repository.compareAndSwapCheckpoint(previous, checkpointFirst);

    await assert.rejects(repository.advanceStrictCatchUpRun(run, advancedRun), (error) =>
      error instanceof TransactionInboxConflictError && error.conflict === 'checkpoint');
    await assert.rejects(repository.failStrictCatchUpRun(run, failedRun), (error) =>
      error instanceof TransactionInboxConflictError && error.conflict === 'checkpoint');
    assert.deepEqual(await repository.readActiveStrictCatchUpRun('market'), run);
    assert.deepEqual(await repository.readCheckpoint('market'), checkpointFirst);

    await repository.supersedeStaleStrictCatchUpRun(run, 350_004);
    assert.equal((await strictCatchUpRunRow(pool, run.runId) as { state: string }).state, 'SUPERSEDED');
    assert.deepEqual(await repository.readCheckpoint('market'), checkpointFirst);
  });
});

void test('allows only one concurrent strict run progress writer', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool) as unknown as StrictCatchUpRunRepository;
    const previous = checkpoint('launchpad', 80n, 'concurrent-run-previous', 400_000);
    const run = strictCatchUpRun(previous, 'primary', 400_001);
    const first = advanceStrictCatchUpRun(run, {
      beforeSignature: 'concurrent-first-cursor', lastAcceptedSlot: 82n,
      pagesScanned: 2n, signaturesEnqueued: 3n, signaturesClassified: 3n, updatedAtMs: 400_002,
    });
    const second = advanceStrictCatchUpRun(run, {
      beforeSignature: 'concurrent-second-cursor', lastAcceptedSlot: 81n,
      pagesScanned: 2n, signaturesEnqueued: 3n, signaturesClassified: 3n, updatedAtMs: 400_003,
    });
    await repository.compareAndSwapCheckpoint(null, previous);
    await repository.createStrictCatchUpRun(run);
    const outcomes = await Promise.allSettled([
      repository.advanceStrictCatchUpRun(run, first),
      repository.advanceStrictCatchUpRun(run, second),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected'
      && outcome.reason instanceof TransactionInboxConflictError).length, 1);
  });
});

void test('replays only an exact immutable strict run creation', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool) as unknown as StrictCatchUpRunRepository;
    const previous = checkpoint('market', 90n, 'replay-previous', 500_000);
    const run = strictCatchUpRun(previous, 'primary', 500_001);
    const alteredSnapshot = Object.freeze({ ...run, updatedAtMs: 500_002 });
    await repository.compareAndSwapCheckpoint(null, previous);
    assert.deepEqual(await repository.createStrictCatchUpRun(run), run);
    assert.deepEqual(await repository.createStrictCatchUpRun(run), run);
    await assert.rejects(
      repository.createStrictCatchUpRun(alteredSnapshot),
      (error) => error instanceof TransactionInboxConflictError && error.conflict === 'checkpoint',
    );
  });
});

void test('rejects mutable strict run inputs before database access', async () => {
  let accesses = 0;
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => {
      accesses += 1;
      throw new Error('database access must not occur');
    },
    query: async () => {
      accesses += 1;
      throw new Error('database access must not occur');
    },
  }) as unknown as StrictCatchUpRunRepository;
  const run = strictCatchUpRun(checkpoint('launchpad', 100n, 'invalid-run-previous', 600_000), 'primary', 600_001);

  await assert.rejects(repository.createStrictCatchUpRun({ ...run }), TransactionInboxRepositoryError);
  assert.equal(accesses, 0);
});

void test('snapshots strict completion inputs before its first database await', async () => {
  const previous = checkpoint('launchpad', 120n, 'snapshot-previous', 800_000);
  const run = strictCatchUpRun(previous, 'primary', 800_001);
  const original = checkpoint('launchpad', 124n, 'strict-run-head-primary', 800_002);
  const replaced = checkpoint('launchpad', 124n, 'strict-run-head-primary', 800_003);
  let releaseConnect: (() => void) | undefined;
  let startedConnect: (() => void) | undefined;
  const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
  const connectStarted = new Promise<void>((resolve) => { startedConnect = resolve; });
  let checkpointUpdateValues: readonly unknown[] | undefined;
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => {
      startedConnect?.();
      await connectGate;
      return {
        query: async (text: string, values?: readonly unknown[]) => {
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
          if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
          if (text.includes('FROM processing_checkpoints')) {
            return { rows: [{ checkpoint_key: 'launchpad', slot: '120', signature: 'snapshot-previous', updated_at: new Date(800_000) }], rowCount: 1 };
          }
          if (text.includes('UPDATE processing_checkpoints')) {
            checkpointUpdateValues = values;
            return { rows: [], rowCount: 1 };
          }
          if (text.includes('UPDATE listener_strict_catch_up_runs')) return { rows: [], rowCount: 1 };
          if (text.includes('UPDATE listener_strict_catch_up_failures')) return { rows: [], rowCount: 0 };
          throw new Error('Unexpected strict completion query.');
        },
        release: () => {},
      };
    },
    query: async () => { throw new Error('not used'); },
  }) as unknown as StrictCatchUpRunRepository;
  const wrapper: { run: StrictCatchUpRun; nextCheckpoint: ProcessingCheckpoint } = { run, nextCheckpoint: original };
  const completion = repository.completeStrictCatchUpRun(wrapper);
  await connectStarted;
  wrapper.nextCheckpoint = replaced;
  releaseConnect?.();
  await completion;
  assert.equal((checkpointUpdateValues?.[3] as Date).getTime(), original.updatedAtMs);
});

void test('rejects strict completion accessors and proxies before getters, traps, or database access', async () => {
  const previous = checkpoint('market', 130n, 'completion-shape-previous', 900_000);
  const run = strictCatchUpRun(previous, 'primary', 900_001);
  const next = checkpoint('market', 134n, 'strict-run-head-primary', 900_002);
  let accesses = 0;
  let getters = 0;
  let traps = 0;
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => { accesses += 1; throw new Error('database access must not occur'); },
    query: async () => { accesses += 1; throw new Error('database access must not occur'); },
  }) as unknown as StrictCatchUpRunRepository;
  const accessor = Object.defineProperties({}, {
    run: { enumerable: true, value: run },
    nextCheckpoint: { enumerable: true, get: () => { getters += 1; return next; } },
  });
  const proxy = new Proxy({ run, nextCheckpoint: next }, {
    get: () => { traps += 1; return next; },
  });

  await assert.rejects(repository.completeStrictCatchUpRun(accessor as never), TransactionInboxRepositoryError);
  await assert.rejects(repository.completeStrictCatchUpRun(proxy as never), TransactionInboxRepositoryError);
  assert.equal(getters, 0);
  assert.equal(traps, 0);
  assert.equal(accesses, 0);
});

void test('rejects skipped and regressed strict progress revisions before database access', async () => {
  const run = strictCatchUpRun(checkpoint('launchpad', 140n, 'revision-previous', 1_000_000), 'primary', 1_000_001);
  const successor = advanceStrictCatchUpRun(run, {
    beforeSignature: 'revision-next-cursor', lastAcceptedSlot: 142n,
    pagesScanned: 2n, signaturesEnqueued: 3n, signaturesClassified: 3n, updatedAtMs: 1_000_002,
  });
  const skipped = Object.freeze({ ...successor, revision: 2n });
  const regressed = Object.freeze({ ...successor, revision: 0n });
  let accesses = 0;
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => { accesses += 1; throw new Error('database access must not occur'); },
    query: async () => { accesses += 1; throw new Error('database access must not occur'); },
  }) as unknown as StrictCatchUpRunRepository;

  await assert.rejects(repository.advanceStrictCatchUpRun(run, skipped), TransactionInboxRepositoryError);
  await assert.rejects(repository.advanceStrictCatchUpRun(run, regressed), TransactionInboxRepositoryError);
  assert.equal(accesses, 0);
});

void test('rolls back checkpoint completion and strict failure resolution when terminalization fails', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool) as unknown as StrictCatchUpRunRepository;
    const previous = checkpoint('launchpad', 150n, 'trigger-previous', 1_100_000);
    const run = strictCatchUpRun(previous, 'primary', 1_100_001);
    const failure = strictFailure('launchpad', previous, 'primary', 154n, 1_100_002);
    await repository.compareAndSwapCheckpoint(null, previous);
    await repository.createStrictCatchUpRun(run);
    await repository.recordStrictCatchUpFailure(failure);
    await pool.query(`CREATE FUNCTION reject_strict_run_completion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced terminalization failure'; END;
      $$`);
    await pool.query(`CREATE TRIGGER reject_strict_run_completion BEFORE UPDATE ON listener_strict_catch_up_runs
      FOR EACH ROW EXECUTE FUNCTION reject_strict_run_completion()`);

    await assert.rejects(repository.completeStrictCatchUpRun({
      run,
      nextCheckpoint: checkpoint('launchpad', 154n, 'strict-run-head-primary', 1_100_003),
    }), TransactionInboxRepositoryError);
    assert.deepEqual(await repository.readCheckpoint('launchpad'), previous);
    assert.deepEqual(await repository.readActiveStrictCatchUpRun('launchpad'), run);
    const storedFailure = await pool.query(
      'SELECT resolved_at FROM listener_strict_catch_up_failures WHERE failure_id = $1',
      [failure.failureId],
    );
    assert.equal(storedFailure.rows[0]?.resolved_at, null);
  });
});

void test('rejects corrupt strict run rows and redacts repository failures', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool) as unknown as StrictCatchUpRunRepository;
    const previous = checkpoint('launchpad', 110n, 'corrupt-run-previous', 700_000);
    const run = strictCatchUpRun(previous, 'primary', 700_001);
    await repository.compareAndSwapCheckpoint(null, previous);
    await repository.createStrictCatchUpRun(run);
    await pool.query('ALTER TABLE listener_strict_catch_up_runs DROP CONSTRAINT listener_strict_catch_up_runs_cursor_order_check');
    await pool.query(
      'UPDATE listener_strict_catch_up_runs SET before_signature = previous_signature WHERE run_id = $1',
      [run.runId],
    );
    await assert.rejects(repository.readActiveStrictCatchUpRun('launchpad'), TransactionInboxRepositoryError);
  });

  const secret = 'postgresql://strict-run-secret@db.invalid/listener';
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => { throw new Error('not used'); },
    query: async () => { throw new Error(secret); },
  }) as unknown as StrictCatchUpRunRepository;
  await assert.rejects(repository.readActiveStrictCatchUpRun('market'), (error) => {
    assert.ok(error instanceof TransactionInboxRepositoryError);
    assertNoSecretSurface(error, secret);
    return true;
  });
});

void test('rejects non-canonical strict checkpoint signatures before I/O and accepts 128 UTF-8 bytes', async () => {
  const valid = checkpoint('launchpad', 41n, 'strict-signature', 300_000);
  for (const signature of [' leading', 'trailing ', 'a'.repeat(129), 'é'.repeat(65)]) {
    let connections = 0;
    const repository = new PostgresTransactionInboxRepository({
      connect: async () => {
        connections += 1;
        throw new Error('database access must not occur');
      },
      query: async () => { throw new Error('database access must not occur'); },
    });
    const invalid = checkpoint('launchpad', 40n, signature, 300_000);
    await assert.rejects(repository.compareAndSwapCheckpoint(null, invalid), TransactionInboxRepositoryError);
    await assert.rejects(repository.compareAndSwapCheckpoint(invalid, valid), TransactionInboxRepositoryError);
    await assert.rejects(
      repository.resolveStrictCatchUpFailures('launchpad', invalid),
      TransactionInboxRepositoryError,
    );
    assert.equal(connections, 0);
  }

  const exactSignature = 'é'.repeat(64);
  let connections = 0;
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => {
      connections += 1;
      return {
        query: async (text: string) => {
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
            return { rows: [], rowCount: 0 };
          }
          if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
          if (text.includes('INSERT INTO processing_checkpoints')) return { rows: [], rowCount: 1 };
          if (text.includes('UPDATE listener_strict_catch_up_failures')) {
            return { rows: [], rowCount: 0 };
          }
          throw new Error('Unexpected strict checkpoint query.');
        },
        release: () => {},
      };
    },
    query: async () => ({ rows: [], rowCount: 0 }),
  });
  await repository.compareAndSwapCheckpoint(
    null,
    checkpoint('launchpad', 42n, exactSignature, 300_000),
  );
  assert.equal(connections, 1);
});

void test('compares strict checkpoints by exact key slot and signature without timestamp identity', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const first = checkpoint('launchpad', 40n, 'first-head', 300_000);
    const sameSlot = checkpoint('launchpad', 40n, 'same-slot-head', 300_001);
    const second = checkpoint('launchpad', 41n, 'second-head', 300_002);

    await repository.compareAndSwapCheckpoint(null, first);
    await repository.compareAndSwapCheckpoint(
      checkpoint('launchpad', 40n, 'first-head', 1), sameSlot,
    );
    await repository.compareAndSwapCheckpoint(
      checkpoint('launchpad', 40n, 'same-slot-head', 2), second,
    );
    assert.deepEqual(await repository.readCheckpoint('launchpad'), second);

    await assert.rejects(
      repository.compareAndSwapCheckpoint(first, checkpoint('launchpad', 42n, 'stale', 300_003)),
      (error) => error instanceof TransactionInboxConflictError && error.conflict === 'checkpoint',
    );
    await assert.rejects(
      repository.compareAndSwapCheckpoint(
        checkpoint('launchpad', 41n, 'wrong-head', 300_002),
        checkpoint('launchpad', 42n, 'wrong-expected', 300_003),
      ),
      (error) => error instanceof TransactionInboxConflictError && error.conflict === 'checkpoint',
    );
    await assert.rejects(
      repository.compareAndSwapCheckpoint(second, checkpoint('launchpad', 40n, 'older', 300_003)),
      (error) => error instanceof TransactionInboxConflictError && error.conflict === 'checkpoint',
    );
  });
});

void test('allows one concurrent exact strict checkpoint CAS winner', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const expected = checkpoint('market', 50n, 'concurrent-base', 400_000);
    await repository.compareAndSwapCheckpoint(null, expected);
    const outcomes = await Promise.allSettled([
      repository.compareAndSwapCheckpoint(expected, checkpoint('market', 51n, 'winner-a', 400_001)),
      repository.compareAndSwapCheckpoint(expected, checkpoint('market', 52n, 'winner-b', 400_002)),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) =>
      outcome.status === 'rejected' && outcome.reason instanceof TransactionInboxConflictError).length, 1);
  });
});

void test('resolves strict failure evidence inside a successful CAS but not a failed CAS', async () => {
  const successfulQueries: string[] = [];
  const successfulRepository = new PostgresTransactionInboxRepository({
    connect: async () => ({
      query: async (text: string) => {
        successfulQueries.push(text);
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (text.includes('INSERT INTO processing_checkpoints')) return { rows: [], rowCount: 1 };
        if (text.includes('UPDATE listener_strict_catch_up_failures')) {
          return { rows: [], rowCount: 0 };
        }
        throw new Error('Unexpected successful strict CAS query.');
      },
      release: () => {},
    }),
    query: async () => ({ rows: [], rowCount: 0 }),
  });
  await successfulRepository.compareAndSwapCheckpoint(
    null,
    checkpoint('launchpad', 50n, 'successful-cas', 400_000),
  );
  const successfulResolution = successfulQueries.find((text) =>
    text.includes('UPDATE listener_strict_catch_up_failures'));
  assert.match(
    successfulResolution ?? '',
    /WITH resolution_clock AS[\s\S]*clock_timestamp\(\)[\s\S]*UPDATE/u,
  );
  assert.equal(successfulResolution?.match(/clock_timestamp\(\)/gu)?.length, 1);

  const failedQueries: string[] = [];
  const failedRepository = new PostgresTransactionInboxRepository({
    connect: async () => ({
      query: async (text: string) => {
        failedQueries.push(text);
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (text.includes('UPDATE processing_checkpoints')) return { rows: [], rowCount: 0 };
        throw new Error('Unexpected failed strict CAS query.');
      },
      release: () => {},
    }),
    query: async () => ({ rows: [], rowCount: 0 }),
  });
  await assert.rejects(
    failedRepository.compareAndSwapCheckpoint(
      checkpoint('market', 50n, 'failed-cas', 400_000),
      checkpoint('market', 51n, 'failed-cas-next', 400_001),
    ),
    TransactionInboxConflictError,
  );
  assert.equal(failedQueries.some((text) => text.includes('UPDATE listener_strict_catch_up_failures')), false);
});

void test('captures one database clock for explicit strict failure resolution', async () => {
  const calls: { readonly text: string; readonly values: readonly unknown[] | undefined }[] = [];
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => ({
      query: async (text: string, values?: readonly unknown[]) => {
        calls.push({ text, values });
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (text.includes('UPDATE listener_strict_catch_up_failures')) {
          return { rows: [], rowCount: 0 };
        }
        throw new Error('Unexpected explicit strict resolution query.');
      },
      release: () => {},
    }),
    query: async () => ({ rows: [], rowCount: 0 }),
  });

  await repository.resolveStrictCatchUpFailures('launchpad', null);

  const resolution = calls.find(({ text }) => text.includes('UPDATE listener_strict_catch_up_failures'));
  assert.ok(resolution);
  assert.match(resolution.text, /WITH resolution_clock AS[\s\S]*clock_timestamp\(\)[\s\S]*UPDATE/u);
  assert.equal(resolution.text.match(/clock_timestamp\(\)/gu)?.length, 1);
  assert.deepEqual(resolution.values, ['launchpad']);
});

void test('locks the checkpoint before recording strict catch-up evidence', async () => {
  const queries: string[] = [];
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => ({
      query: async (text: string) => {
        queries.push(text);
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (text.includes('FROM processing_checkpoints')) return { rows: [], rowCount: 0 };
        if (text.includes('INSERT INTO listener_strict_catch_up_failures')) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error('Unexpected strict failure record query.');
      },
      release: () => {},
    }),
    query: async () => ({ rows: [], rowCount: 0 }),
  });
  await repository.recordStrictCatchUpFailure(
    strictFailure('launchpad', null, 'primary', 50n, 400_000),
  );
  const lockIndex = queries.findIndex((text) => text.includes('pg_advisory_xact_lock'));
  const checkpointIndex = queries.findIndex((text) => text.includes('FROM processing_checkpoints'));
  const insertIndex = queries.findIndex((text) => text.includes('INSERT INTO listener_strict_catch_up_failures'));
  assert.ok(lockIndex > 0);
  assert.ok(checkpointIndex > lockIndex);
  assert.ok(insertIndex > checkpointIndex);
});

void test('anchors obsolete strict failure retention to one database resolution clock', async () => {
  const queries: string[] = [];
  const previous = checkpoint('launchpad', 50n, 'stale-boundary', 400_000);
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => ({
      query: async (text: string) => {
        queries.push(text);
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (text.includes('FROM processing_checkpoints')) {
          return {
            rows: [{
              checkpoint_key: 'launchpad', slot: '51', signature: 'advanced-boundary',
              updated_at: new Date(401_000),
            }],
            rowCount: 1,
          };
        }
        if (text.includes('INSERT INTO listener_strict_catch_up_failures')) {
          return { rows: [], rowCount: 1 };
        }
        if (text.includes('UPDATE listener_strict_catch_up_failures')) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error('Unexpected obsolete strict failure record query.');
      },
      release: () => {},
    }),
    query: async () => ({ rows: [], rowCount: 0 }),
  });

  await repository.recordStrictCatchUpFailure(
    strictFailure('launchpad', previous, 'primary', 51n, 402_000),
  );

  const insertion = queries.find((text) => text.includes('INSERT INTO listener_strict_catch_up_failures'));
  assert.doesNotMatch(insertion ?? '', /resolved_at|purge_after/u);
  const resolution = queries.find((text) => text.includes('UPDATE listener_strict_catch_up_failures'));
  assert.match(resolution ?? '', /WITH resolution_clock AS[\s\S]*clock_timestamp\(\)[\s\S]*UPDATE/u);
  assert.equal(resolution?.match(/clock_timestamp\(\)/gu)?.length, 1);
});

void test('leaves strict race evidence resolved in record-first and CAS-first orders', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const resolutionWindowStartedAt = Date.now();
    const recordFirst = strictFailure('launchpad', null, 'primary', 50n, 30_000);
    await repository.recordStrictCatchUpFailure(recordFirst);
    const firstAdvance = checkpoint('launchpad', 50n, 'record-first-advance', 20_000);
    await repository.compareAndSwapCheckpoint(null, firstAdvance);

    const delayedAdvance = checkpoint('launchpad', 51n, 'cas-first-advance', 26_000);
    await repository.compareAndSwapCheckpoint(firstAdvance, delayedAdvance);
    const casFirst = strictFailure('launchpad', firstAdvance, 'fallback-1', 51n, 25_000);
    await repository.recordStrictCatchUpFailure(casFirst);

    const failedPrevious = checkpoint('market', 60n, 'failed-cas-previous', 40_000);
    await repository.compareAndSwapCheckpoint(null, failedPrevious);
    const failedCas = strictFailure('market', failedPrevious, 'fallback-2', 60n, 41_000);
    await repository.recordStrictCatchUpFailure(failedCas);
    await assert.rejects(
      repository.compareAndSwapCheckpoint(
        checkpoint('market', 60n, 'wrong-failed-cas-expected', 40_000),
        checkpoint('market', 61n, 'failed-cas-next', 42_000),
      ),
      TransactionInboxConflictError,
    );
    const resolutionWindowFinishedAt = Date.now();

    const rows = await pool.query(
      `SELECT failure_id, resolved_at IS NOT NULL AS resolved,
         resolved_at, purge_after
       FROM listener_strict_catch_up_failures WHERE failure_id = ANY($1::TEXT[]) ORDER BY failure_id`,
      [[recordFirst.failureId, casFirst.failureId, failedCas.failureId]],
    );
    for (const failure of [recordFirst, casFirst]) {
      const row = rows.rows.find(({ failure_id: failureId }) => failureId === failure.failureId);
      assert.equal(row?.resolved, true);
      assert.ok(row?.resolved_at instanceof Date);
      assert.ok(row?.purge_after instanceof Date);
      assert.ok(row.resolved_at.getTime() >= resolutionWindowStartedAt);
      assert.ok(row.resolved_at.getTime() <= resolutionWindowFinishedAt);
      assert.ok(row.resolved_at.getTime() >= failure.detectedAtMs);
      assert.equal(row.purge_after.getTime() - row.resolved_at.getTime(), 4 * 60 * 60 * 1_000);
    }
    assert.deepEqual(
      rows.rows.find(({ failure_id: failureId }) => failureId === failedCas.failureId),
      { failure_id: failedCas.failureId, resolved: false, resolved_at: null, purge_after: null },
    );
  });
});

void test('records immutable strict failures once and resolves only the exact nullable boundary', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const lifecycleStartedAt = Date.now();
    const absentPrimary = strictFailure('launchpad', null, 'primary', 99n, 500_000);
    const absentFallback = strictFailure('launchpad', null, 'fallback-1', 99n, 500_001);
    const previous = checkpoint('launchpad', 45n, 'resolved-boundary', 499_000);
    const present = strictFailure('launchpad', previous, 'primary', 100n, 500_002);
    const otherPrevious = checkpoint('launchpad', 46n, 'other-boundary', 499_001);
    const otherBoundary = strictFailure('launchpad', otherPrevious, 'fallback-2', 101n, 500_003);
    const otherKeyPrevious = checkpoint('market', 47n, 'other-key-boundary', 499_002);
    const otherKey = strictFailure('market', otherKeyPrevious, 'fallback-3', 102n, 500_004);

    await repository.recordStrictCatchUpFailure(absentPrimary);
    await repository.recordStrictCatchUpFailure(Object.freeze({ ...absentPrimary, detectedAtMs: 600_000 }));
    await repository.recordStrictCatchUpFailure(absentFallback);
    await repository.compareAndSwapCheckpoint(null, previous);
    await repository.recordStrictCatchUpFailure(present);
    await repository.recordStrictCatchUpFailure(otherBoundary);
    await repository.compareAndSwapCheckpoint(null, otherKeyPrevious);
    await repository.recordStrictCatchUpFailure(otherKey);
    const lifecycleFinishedAt = Date.now();

    const replayed = await pool.query(
      `SELECT (EXTRACT(EPOCH FROM detected_at) * 1000)::bigint AS detected_at_ms
       FROM listener_strict_catch_up_failures WHERE failure_id = $1`,
      [absentPrimary.failureId],
    );
    assert.equal(replayed.rows[0]?.detected_at_ms, '500000');

    await repository.resolveStrictCatchUpFailures('launchpad', null);
    const rows = await pool.query(
      `SELECT failure_id, resolved_at IS NOT NULL AS resolved,
         resolved_at, purge_after
       FROM listener_strict_catch_up_failures ORDER BY failure_id`,
    );
    const absentRows = rows.rows.filter((row) =>
      row.failure_id === absentPrimary.failureId || row.failure_id === absentFallback.failureId);
    for (const row of [
      ...absentRows,
      rows.rows.find(({ failure_id: failureId }) => failureId === otherBoundary.failureId),
    ]) {
      assert.equal(row?.resolved, true);
      assert.ok(row?.resolved_at instanceof Date);
      assert.ok(row?.purge_after instanceof Date);
      assert.ok(row.resolved_at.getTime() >= lifecycleStartedAt);
      assert.ok(row.resolved_at.getTime() <= lifecycleFinishedAt);
      assert.equal(row.purge_after.getTime() - row.resolved_at.getTime(), 4 * 60 * 60 * 1_000);
    }
    assert.deepEqual(rows.rows.find((row) => row.failure_id === present.failureId), {
      failure_id: present.failureId, resolved: false, resolved_at: null, purge_after: null,
    });
    assert.deepEqual(rows.rows.find((row) => row.failure_id === otherKey.failureId), {
      failure_id: otherKey.failureId, resolved: false, resolved_at: null, purge_after: null,
    });

    const resolutionStartedAt = Date.now();
    await repository.resolveStrictCatchUpFailures('launchpad', previous);
    const resolutionFinishedAt = Date.now();
    await repository.resolveStrictCatchUpFailures('launchpad', previous);
    const resolvedPresent = await pool.query(
      `SELECT resolved_at IS NOT NULL AS resolved, resolved_at, purge_after
       FROM listener_strict_catch_up_failures WHERE failure_id = $1`,
      [present.failureId],
    );
    assert.equal(resolvedPresent.rows[0]?.resolved, true);
    assert.ok(resolvedPresent.rows[0]?.resolved_at instanceof Date);
    assert.ok(resolvedPresent.rows[0]?.purge_after instanceof Date);
    const resolvedAtMs = resolvedPresent.rows[0].resolved_at.getTime();
    const purgeAfterMs = resolvedPresent.rows[0].purge_after.getTime();
    assert.ok(resolvedAtMs >= resolutionStartedAt);
    assert.ok(resolvedAtMs <= resolutionFinishedAt);
    assert.equal(purgeAfterMs - resolvedAtMs, 4 * 60 * 60 * 1_000);
    const retainedOtherKey = await pool.query(
      `SELECT failure_id, resolved_at IS NOT NULL AS resolved, purge_after
       FROM listener_strict_catch_up_failures WHERE failure_id = $1`,
      [otherKey.failureId],
    );
    assert.deepEqual(retainedOtherKey.rows, [
      { failure_id: otherKey.failureId, resolved: false, purge_after: null },
    ]);
  });
});

void test('redacts strict failure identity conflicts', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    const failure = strictFailure('market', null, 'primary', 88n, 800_000);
    await repository.recordStrictCatchUpFailure(failure);
    await pool.query(
      'UPDATE listener_strict_catch_up_failures SET provider_id = $2 WHERE failure_id = $1',
      [failure.failureId, 'fallback-3'],
    );
    await assert.rejects(repository.recordStrictCatchUpFailure(failure), (error) =>
      error instanceof TransactionInboxConflictError
      && error.conflict === 'checkpoint'
      && !error.message.includes('fallback-3'));
  });
});

void test('redacts strict failure transactional database failures', async () => {
  const secret = 'postgresql://strict-failure-secret@db.invalid/listener';
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => ({
      query: async (text: string) => {
        if (text === 'ROLLBACK') throw new Error(secret);
        throw new Error(secret);
      },
      release: () => {},
    }),
    query: async () => ({ rows: [], rowCount: 0 }),
  });
  await assert.rejects(repository.recordStrictCatchUpFailure(
    strictFailure('market', null, 'primary', 88n, 800_000),
  ), (error) => {
    assert.ok(error instanceof TransactionInboxRepositoryError);
    assertNoSecretSurface(error, secret);
    return true;
  });
});

void test('wraps malformed rows and database rollback failures in safe typed errors', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(notification('fingerprint-corrupt', 59n));
    const fingerprintClaim = await repository.claim(399_000, 120);
    assert.ok(fingerprintClaim);
    await repository.saveSnapshot(
      'fingerprint-corrupt', fingerprintClaim.leaseToken,
      normalized('fingerprint-corrupt', 59n),
    );
    await repository.markFailed('fingerprint-corrupt', fingerprintClaim.leaseToken, Object.freeze({
      code: 'RPC_TRANSIENT', errorName: 'RpcError', retryable: true,
    }));
    const retryAt = new Date((await row(pool, 'fingerprint-corrupt')).next_attempt_at).getTime();
    await pool.query(
      "UPDATE chain_transaction_inbox SET immutable_fingerprint = $2 WHERE signature = $1",
      ['fingerprint-corrupt', '0'.repeat(64)],
    );
    await assert.rejects(repository.claim(retryAt + 1, 120), TransactionInboxRepositoryError);

    await repository.enqueue(notification('corrupt', 60n));
    await pool.query('ALTER TABLE chain_transaction_inbox DROP CONSTRAINT chain_transaction_inbox_observed_slot_check');
    await pool.query("UPDATE chain_transaction_inbox SET observed_slot = -1 WHERE signature = 'corrupt'");
    await assert.rejects(repository.claim(400_000, 120), (error) =>
      error instanceof TransactionInboxRepositoryError
      && error.message === 'Transaction inbox repository operation failed.'
      && !error.message.includes('observed_slot'));

    await repository.enqueue(notification('program-corrupt', 61n));
    await pool.query(
      'ALTER TABLE chain_transaction_inbox DROP CONSTRAINT chain_transaction_inbox_program_ids_check',
    );
    await pool.query(
      "UPDATE chain_transaction_inbox SET program_ids = ARRAY['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'] WHERE signature = 'program-corrupt'",
    );
    await assert.rejects(
      repository.enqueue(notification('program-corrupt', 61n)),
      TransactionInboxRepositoryError,
    );
  });
});

void test('rolls back and releases a checked-out client after a database failure', async () => {
  const queries: string[] = [];
  let released = false;
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes('pg_advisory_xact_lock')) throw new Error('postgresql://secret@host/db');
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  };
  const pool = {
    connect: async () => client,
    query: async () => ({ rows: [], rowCount: 0 }),
  };
  const repository = new PostgresTransactionInboxRepository(pool);
  await assert.rejects(repository.enqueue(notification('rollback', 1n)), (error) =>
    error instanceof TransactionInboxRepositoryError
    && error.message === 'Transaction inbox repository operation failed.'
    && !error.message.includes('secret'));
  assert.deepEqual(queries, ['BEGIN',
    "SELECT pg_advisory_xact_lock_shared(hashtextextended('foundation-retention-fence:v1', 0))",
    'ROLLBACK']);
  assert.equal(released, true);
});

void test('checks the optional classification signal after durable writes and before commit', async () => {
  const queries: string[] = [];
  let released = false;
  const controller = new AbortController();
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.includes('FROM chain_transaction_inbox WHERE signature=$1 FOR UPDATE')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM chain_transaction_finality_replay_receipts')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('INSERT INTO chain_transaction_inbox')) {
        controller.abort();
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  };
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => client,
    query: async () => ({ rows: [], rowCount: 0 }),
  });

  await assert.rejects(
    repository.recordCatchUpClassification(catchUpClassification('classification-abort'), controller.signal),
    TransactionInboxRepositoryError,
  );
  assert.equal(queries.includes('COMMIT'), false);
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.equal(released, true);
});

void test('uses an ordered partial index for a large mixed claim backlog', async (context) => {
  await withDatabase(context, async (pool) => {
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, observed_at
    ) SELECT 'pending-' || value, value + 20000, ARRAY['WEBSOCKET'], ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'processed',
      'PENDING', clock_timestamp()
      FROM generate_series(1, 10000) value`);
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, error_code, error_name, error_retryable, next_attempt_at, observed_at
    ) SELECT 'retry-' || value, value, ARRAY['WEBSOCKET'], ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'processed',
      'FAILED', 'RPC_TRANSIENT', 'RpcError', TRUE, clock_timestamp() + INTERVAL '1 day',
      clock_timestamp()
      FROM generate_series(1, 10000) value`);
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, lease_token, lease_expires_at, observed_at
    ) SELECT 'leased-' || value, value + 10000, ARRAY['WEBSOCKET'], ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'processed',
      'PROCESSING', 'lease-' || value, clock_timestamp() + INTERVAL '1 day',
      clock_timestamp()
      FROM generate_series(1, 10000) value`);
    await pool.query(`INSERT INTO chain_transaction_inbox (
      signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
      processing_status, observed_at, ingestion_priority
    ) VALUES (
      'late-launch', 99999, ARRAY['WEBSOCKET'],
      ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'processed',
      'PENDING', clock_timestamp(), 'LAUNCH_CANDIDATE'
    )`);
    await pool.query('ANALYZE chain_transaction_inbox');
    const version = await pool.query<{ readonly major: string }>(
      "SELECT current_setting('server_version_num')::INTEGER / 10000 AS major",
    );
    assert.equal(version.rows[0]?.major, 16);
    const explained = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT signature, ingestion_priority FROM chain_transaction_inbox
      WHERE (processing_status = 'PENDING' AND attempts_in_cycle < retry_max_attempts)
         OR (processing_status = 'FAILED' AND error_retryable = TRUE
             AND retry_exhausted_at IS NULL
             AND next_attempt_at <= clock_timestamp()
             AND attempts_in_cycle < retry_max_attempts)
         OR (processing_status = 'PROCESSING' AND lease_expires_at <= clock_timestamp()
             AND attempts_in_cycle < retry_max_attempts)
      ORDER BY (ingestion_priority <> 'NORMAL') DESC, observed_slot, signature
      FOR UPDATE SKIP LOCKED
      LIMIT 1`);
    const plan = explained.rows[0]?.['QUERY PLAN']?.[0]?.Plan;
    assert.ok(plan);
    const nodes = flattenPlan(plan);
    assert.equal(plan['Node Type'], 'Limit');
    assert.equal(plan['Plan Rows'], 1);
    assert.equal(nodes.some((node) => node['Node Type'] === 'Seq Scan'), false);
    assert.equal(nodes.some((node) => node['Node Type'] === 'Sort'), false);
    assert.equal(nodes.some((node) =>
      node['Index Name'] === 'chain_transaction_inbox_claim_order_idx'), true);
    const claimed = await new PostgresTransactionInboxRepository(pool).claim(Date.now(), 120);
    assert.equal(claimed?.signature, 'late-launch');
  });
});

void test('does not retain raw external failures on any public error surface', async () => {
  const urlSecret = 'postgresql://reader:private-token@db.invalid/ledger';
  const identifierSecret = 'StaticIdentifierLookingSecret';
  let nameReads = 0;
  const hostile = new Error(urlSecret);
  Object.defineProperty(hostile, 'name', {
    get: () => {
      nameReads += 1;
      return identifierSecret;
    },
  });
  const pool = {
    connect: async () => { throw new Error('not used'); },
    query: async () => { throw hostile; },
  };
  const repository = new PostgresTransactionInboxRepository(pool);
  await assert.rejects(repository.counts(), (error) => {
    assert.ok(error instanceof TransactionInboxRepositoryError);
    assertNoSecretSurface(error, urlSecret, identifierSecret);
    assert.deepEqual(error.failures, [{
      stage: 'operation',
      failureKind: 'DATABASE_OPERATION',
      errorName: 'TransactionInboxDatabaseOperationError',
    }]);
    assert.ok(Object.isFrozen(error.failures));
    assert.ok(Object.isFrozen(error.failures[0]));
    return true;
  });
  assert.equal(nameReads, 0);
});

void test('does not introspect a proxy thrown by the database boundary', async () => {
  let trapCalls = 0;
  const hostile = new Proxy(new Error('proxy-static-secret'), {
    get: () => { trapCalls += 1; throw new Error('proxy get trap'); },
    getOwnPropertyDescriptor: () => { trapCalls += 1; throw new Error('proxy descriptor trap'); },
    getPrototypeOf: () => { trapCalls += 1; throw new Error('proxy prototype trap'); },
    ownKeys: () => { trapCalls += 1; throw new Error('proxy ownKeys trap'); },
  });
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => { throw new Error('not used'); },
    query: async () => { throw hostile; },
  });
  await assert.rejects(repository.counts(), (error) =>
    error instanceof TransactionInboxRepositoryError
    && error.failures[0]?.failureKind === 'DATABASE_OPERATION');
  assert.equal(trapCalls, 0);
});

void test('sanitizes externally constructed repository error subclasses without retaining identity', async () => {
  const secret = 'postgresql://subclass:external-secret@db.invalid/ledger';
  class ExternalLeaseError extends TransactionInboxLeaseError {
    public readonly externalSecret = secret;

    public constructor() {
      super();
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: true,
        value: new Error(secret),
      });
    }
  }
  const hostile = new ExternalLeaseError();
  const repository = repositoryThrowing(hostile);

  await assert.rejects(repository.counts(), (error) => {
    assert.ok(error instanceof TransactionInboxRepositoryError);
    assert.equal(error instanceof TransactionInboxLeaseError, false);
    assert.notEqual(error, hostile);
    assert.deepEqual(error.failures, [{
      stage: 'operation',
      failureKind: 'DATABASE_OPERATION',
      errorName: 'TransactionInboxDatabaseOperationError',
    }]);
    assertNoSecretSurface(error, secret);
    return true;
  });
});

void test('sanitizes externally constructed conflict errors and prototype forgeries', async () => {
  const constructorSecret = 'constructor-owned-conflict-secret';
  const external = new TransactionInboxConflictError('identity');
  Object.defineProperties(external, {
    cause: { enumerable: true, value: new Error(constructorSecret) },
    externalSecret: { enumerable: true, value: constructorSecret },
  });
  await assert.rejects(repositoryThrowing(external).counts(), (error) => {
    assert.ok(error instanceof TransactionInboxRepositoryError);
    assert.equal(error instanceof TransactionInboxConflictError, false);
    assert.notEqual(error, external);
    assertNoSecretSurface(error, constructorSecret);
    return true;
  });

  const forgedSecret = 'prototype-forged-conflict-secret';
  const forged = Object.create(TransactionInboxConflictError.prototype) as object;
  Object.defineProperty(forged, 'externalSecret', { enumerable: true, value: forgedSecret });
  await assert.rejects(repositoryThrowing(forged).counts(), (error) => {
    assert.ok(error instanceof TransactionInboxRepositoryError);
    assert.equal(error instanceof TransactionInboxConflictError, false);
    assert.notEqual(error, forged);
    assertNoSecretSurface(error, forgedSecret);
    return true;
  });
});

void test('sanitizes a previously emitted internal error when an external pool replays it', async () => {
  const internalRepository = new PostgresTransactionInboxRepository({
    connect: async () => { throw new Error('not used'); },
    query: async () => ({ rows: [], rowCount: 0 }),
  });
  let emitted: TransactionInboxLeaseError | undefined;
  try {
    await internalRepository.renewLease('lease', 'stale-token', 20_000);
    assert.fail('Expected the stale lease operation to reject.');
  } catch (error) {
    assert.ok(error instanceof TransactionInboxLeaseError);
    emitted = error;
  }
  assert.ok(emitted);

  const secret = 'replayed-internal-error-secret';
  Object.defineProperties(emitted, {
    cause: { enumerable: true, value: new Error(secret) },
    externalSecret: { enumerable: true, value: secret },
  });
  await assert.rejects(repositoryThrowing(emitted).counts(), (error) => {
    assert.ok(error instanceof TransactionInboxRepositoryError);
    assert.equal(error instanceof TransactionInboxLeaseError, false);
    assert.notEqual(error, emitted);
    assert.deepEqual(error.failures, [{
      stage: 'operation',
      failureKind: 'DATABASE_OPERATION',
      errorName: 'TransactionInboxDatabaseOperationError',
    }]);
    assertNoSecretSurface(error, secret);
    return true;
  });
});

void test('sanitizes a replayed terminal repository wrapper', async () => {
  let emitted: TransactionInboxRepositoryError | undefined;
  try {
    await repositoryThrowing(new Error('initial external failure')).counts();
    assert.fail('Expected the external database failure to reject.');
  } catch (error) {
    assert.ok(error instanceof TransactionInboxRepositoryError);
    emitted = error;
  }
  assert.ok(emitted);

  const secret = 'replayed-terminal-wrapper-secret';
  Object.defineProperties(emitted, {
    cause: { enumerable: true, value: new Error(secret) },
    externalSecret: { enumerable: true, value: secret },
  });
  await assert.rejects(repositoryThrowing(emitted).counts(), (error) => {
    assert.ok(error instanceof TransactionInboxRepositoryError);
    assert.notEqual(error, emitted);
    assert.deepEqual(error.failures, [{
      stage: 'operation',
      failureKind: 'DATABASE_OPERATION',
      errorName: 'TransactionInboxDatabaseOperationError',
    }]);
    assertNoSecretSurface(error, secret);
    return true;
  });
});

void test('preserves primary and rollback failure categories without retaining their secrets', async () => {
  const primarySecret = 'https://rpc.invalid/key?token=primary-secret';
  const rollbackSecret = 'postgresql://admin:rollback-secret@db.invalid/ledger';
  let released = false;
  let primaryNameReads = 0;
  let rollbackTrapCalls = 0;
  const primaryFailure = new Error(primarySecret);
  Object.defineProperty(primaryFailure, 'name', {
    get: () => {
      primaryNameReads += 1;
      return 'PrimaryIdentifierSecret';
    },
  });
  const rollbackFailure = new Proxy(new Error(rollbackSecret), {
    get: () => { rollbackTrapCalls += 1; throw new Error(rollbackSecret); },
    getOwnPropertyDescriptor: () => { rollbackTrapCalls += 1; throw new Error(rollbackSecret); },
    getPrototypeOf: () => { rollbackTrapCalls += 1; throw new Error(rollbackSecret); },
    ownKeys: () => { rollbackTrapCalls += 1; throw new Error(rollbackSecret); },
  });
  const client = {
    query: async (text: string) => {
      if (text.includes('pg_advisory_xact_lock')) {
        throw primaryFailure;
      }
      if (text === 'ROLLBACK') throw rollbackFailure;
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  };
  const repository = new PostgresTransactionInboxRepository({
    connect: async () => client,
    query: async () => ({ rows: [], rowCount: 0 }),
  });
  await assert.rejects(repository.enqueue(notification('rollback-redaction', 1n)), (error) => {
    assert.ok(error instanceof TransactionInboxRepositoryError);
    assert.deepEqual(error.failures, [
      {
        stage: 'primary',
        failureKind: 'DATABASE_OPERATION',
        errorName: 'TransactionInboxDatabaseOperationError',
      },
      {
        stage: 'rollback',
        failureKind: 'DATABASE_ROLLBACK',
        errorName: 'TransactionInboxDatabaseRollbackError',
      },
    ]);
    assertNoSecretSurface(error, primarySecret, rollbackSecret, 'PrimaryIdentifierSecret');
    return true;
  });
  assert.equal(released, true);
  assert.equal(primaryNameReads, 0);
  assert.equal(rollbackTrapCalls, 0);
});

async function withDatabase(
  context: { skip(message?: string): void },
  run: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent : test PostgreSQL live ignoré');
    return;
  }
  const schema = `transaction_inbox_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool });
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function waitForActiveAdvisoryWait(
  pool: InstanceType<typeof pg.Pool>,
  queryFragment: string,
  minimumCount = 1,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM pg_stat_activity
      WHERE state='active' AND wait_event_type='Lock' AND wait_event='advisory'
        AND query LIKE '%' || $1 || '%'`, [queryFragment]);
    if ((result.rows[0] as { readonly count?: unknown } | undefined)?.count === minimumCount) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error('Expected a bounded advisory-lock wait.');
}

async function waitForActiveLockWait(
  pool: InstanceType<typeof pg.Pool>,
  queryFragment: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM pg_stat_activity
      WHERE state='active' AND wait_event_type='Lock'
        AND query LIKE '%' || $1 || '%'`, [queryFragment]);
    if ((result.rows[0] as { readonly count?: unknown } | undefined)?.count === 1) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error('Expected a bounded row-lock wait.');
}

async function settlesWithin<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        handle = setTimeout(() => { reject(new Error('Concurrent operation exceeded its bound.')); }, timeoutMs);
      }),
    ]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

function notification(
  signature: string,
  slot: bigint,
  source: TransactionNotification['source'] = 'WEBSOCKET',
  confirmationStatus: TransactionNotification['confirmationStatus'] = 'processed',
  observedAtMs = 1_000,
  ingestionHint: TransactionNotification['ingestionHint'] = null,
): TransactionNotification {
  const programIds = source === 'CATCH_UP'
    ? Object.freeze([
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    ])
    : Object.freeze(['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']);
  return Object.freeze({
    signature, slot, source, ingestionHint, ingestionHintMint: null, programIds, confirmationStatus, observedAtMs,
  });
}

function tradeNotification(signature: string, slot: bigint, mint = tradeMint): TransactionNotification {
  return Object.freeze({ ...notification(signature, slot),
    ingestionHint: 'PUMPFUN_TRADE', ingestionHintMint: mint,
  });
}

function pumpCatchUpNotification(signature: string, slot: bigint,
  confirmationStatus: TransactionNotification['confirmationStatus'] = 'processed'): TransactionNotification {
  return Object.freeze({ ...notification(signature, slot, 'CATCH_UP', confirmationStatus),
    programIds: Object.freeze([PUMP_PROGRAM_ID]),
  });
}

function catchUpClassificationInput(signature: string) {
  return {
    signature, slot: 1n, programIds: Object.freeze([PUMP_PROGRAM_ID]),
    confirmationStatus: 'confirmed' as const, observedAtMs: 1_000,
    ingestionHint: 'PUMPFUN_CREATE' as const, ingestionHintMint: null,
    classificationVersion: 1 as const, disposition: 'ACTIONABLE' as const,
    reasonCode: 'PUMP_ACTION_SUPPORTED' as const, mints: Object.freeze([tradeMint]),
    evidenceFingerprint: 'a'.repeat(64), classifiedAtMs: 1_001,
  };
}

function catchUpClassification(signature: string) {
  return createCatchUpClassification(catchUpClassificationInput(signature));
}

function ingestionDecision(stored: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(['processing_status', 'ingestion_priority', 'ingestion_hint', 'ingestion_hint_mint']
    .map((key) => [key, stored[key]]));
}

async function insertTrackedLaunch(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  await pool.query(`INSERT INTO token_launches (
    mint, launchpad, program_id, creator, token_program, current_state, created_signature,
    created_slot, created_transaction_index, created_instruction_index, detected_at, updated_at
  ) VALUES ($1,'pumpfun',$2,$1,$2,'OBSERVING','tracked-launch',1,0,0,clock_timestamp(),clock_timestamp())`,
  [tradeMint, PUMP_PROGRAM_ID]);
}

function checkpoint(
  key: ProcessingCheckpoint['key'],
  slot: bigint,
  signature: string,
  updatedAtMs: number,
): ProcessingCheckpoint {
  return Object.freeze({ key, slot, signature, updatedAtMs });
}

function strictCatchUpRun(
  previous: ProcessingCheckpoint,
  providerId: StrictCatchUpRun['providerId'],
  updatedAtMs: number,
): StrictCatchUpRun {
  return createStrictCatchUpRun({
    checkpointKey: previous.key,
    previous,
    providerId,
    observedHead: Object.freeze({
      slot: previous.slot + 4n,
      signature: `strict-run-head-${providerId}`,
    }),
    beforeSignature: `strict-run-first-${providerId}`,
    lastAcceptedSlot: previous.slot + 4n,
    pagesScanned: 1n,
    signaturesEnqueued: 2n,
    signaturesClassified: 2n,
    revision: 0n,
    startedAtMs: updatedAtMs,
    updatedAtMs,
  });
}

function strictFailure(
  checkpointKey: ProcessingCheckpoint['key'],
  previous: ProcessingCheckpoint | null,
  providerId: StrictCatchUpFailure['providerId'],
  observedHeadSlot: bigint | null,
  detectedAtMs: number,
): StrictCatchUpFailure {
  return createStrictCatchUpFailure({
    checkpointKey,
    previous,
    providerId,
    observedHeadSlot,
    detectedAtMs,
  });
}

function normalized(signature: string, slot: bigint): NormalizedTransaction {
  return {
    signature, slot, transactionIndex: 0, confirmationStatus: 'PROCESSED', version: 'legacy',
    blockTimeMs: 999, accountKeys: ['account'], signerKeys: ['account'],
    instructions: [{
      programId: 'program', accounts: ['account'], data: Uint8Array.from([0, 1, 255]),
      instructionIndex: 0, innerInstructionIndex: null, parentInstructionIndex: null,
      stackHeight: null,
    }],
    preTokenBalances: [], postTokenBalances: [],
    preBalancesLamports: [9_007_199_254_740_994n], postBalancesLamports: [9_007_199_254_740_993n],
    feeLamports: 9_007_199_254_740_995n, computeUnits: 123n, logs: ['ok'], error: null,
  };
}

function finalityProof(value: {
  readonly confirmationStatus: 'processed' | 'confirmed';
  readonly missingFinalityPolls: number;
  readonly lastMissingFinalityProviderId: string | null;
  readonly finalityEvidenceVersion: bigint;
}): object {
  return {
    confirmationStatus: value.confirmationStatus,
    missingFinalityPolls: value.missingFinalityPolls,
    lastMissingFinalityProviderId: value.lastMissingFinalityProviderId,
    finalityEvidenceVersion: value.finalityEvidenceVersion,
  };
}

async function onlyFinalityCandidate(
  repository: PostgresTransactionInboxRepository,
  signature: string,
) {
  const candidates = await repository.listForFinality(1);
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  if (candidate === undefined) throw new Error('Expected finality candidate.');
  assert.equal(candidate.signature, signature);
  return candidate;
}

function orphanRevision(
  value: FinalityCandidate,
  observedAtMs: number,
) {
  if (value.lastMissingFinalityProviderId === null) throw new Error('Expected an orphan proof.');
  return Object.freeze({
    signature: 'proof', confirmationStatus: 'orphaned' as const,
    expectedConfirmationStatus: value.confirmationStatus,
    expectedMissingFinalityPolls: value.missingFinalityPolls,
    expectedLastMissingFinalityProviderId: value.lastMissingFinalityProviderId,
    expectedFinalityEvidenceVersion: value.finalityEvidenceVersion,
    observedAtMs,
  });
}

async function assertFinalityConflict(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof TransactionInboxConflictError);
    assert.equal(error.conflict, 'finality');
    return true;
  });
}

async function finalityRowTuple(
  pool: InstanceType<typeof pg.Pool>,
  signature: string,
): Promise<object> {
  const stored = await row(pool, signature);
  return {
    confirmationStatus: stored.target_confirmation_status,
    processingStatus: stored.processing_status,
    missingFinalityPolls: stored.missing_finality_polls,
    lastMissingFinalityProviderId: stored.last_missing_finality_provider_id,
    finalityEvidenceVersion: stored.finality_evidence_version,
  };
}

async function row(pool: InstanceType<typeof pg.Pool>, signature: string): Promise<any> {
  return (await pool.query('SELECT * FROM chain_transaction_inbox WHERE signature = $1', [signature])).rows[0];
}

async function storeWorkerDecoderQuarantine(
  repository: PostgresTransactionInboxRepository,
  signature: string,
  slot: bigint,
  reasonCode: 'PUMP_SCHEMA_UNSUPPORTED' | 'PUMP_BORSH_TRUNCATED',
): Promise<string> {
  await repository.enqueue(notification(signature, slot, 'WEBSOCKET', 'confirmed'));
  const claimed = await repository.claim(Date.now(), 30);
  assert.equal(claimed?.signature, signature);
  await repository.saveSnapshot(signature, claimed.leaseToken, normalized(signature, slot));
  await repository.markFailed(signature, claimed.leaseToken, Object.freeze({
    code: 'PIPELINE_STAGE_FAILED',
    errorName: `ObservedPipelineFailure.v1.launchpad_observation.${reasonCode}`,
    retryable: false,
  }));
  return claimed.leaseToken;
}

async function recoveryState(
  pool: InstanceType<typeof pg.Pool>,
  signature: string,
): Promise<unknown> {
  return (await pool.query(`SELECT processing_status,attempts,attempts_in_cycle,
    lease_token,lease_expires_at,error_code,error_name,error_retryable,next_attempt_at,
    retry_exhausted_at,processed_at,terminal_at,purge_after,manual_recovery_count,
    last_manual_recovery_at,normalized_transaction,immutable_fingerprint,updated_at
    FROM chain_transaction_inbox WHERE signature=$1`, [signature])).rows[0];
}

function catchUpCoverageCandidate(
  signature: string,
  slot: bigint,
  confirmationStatus: 'processed' | 'confirmed' | 'finalized',
): CatchUpAdmissionCoverageCandidate {
  return Object.freeze({ signature, slot, confirmationStatus,
    programIds: Object.freeze([PUMP_PROGRAM_ID]) });
}

function catchUpCoverageReceipt(value: CatchUpAdmissionCoverageCandidate) {
  return Object.freeze({ signature: value.signature, slot: value.slot, disposition: null,
    persistence: 'ALREADY_ADMITTED' as const, admission: 'NOT_ENQUEUED' as const,
    ingestionPriority: null });
}

function failedCatchUpClassification(signature: string, slot: bigint) {
  return createCatchUpClassification({
    ...catchUpClassificationInput(signature), slot,
    disposition: 'IGNORED', reasonCode: 'SOLANA_TRANSACTION_FAILED',
    ingestionHint: null, ingestionHintMint: null, mints: [],
  });
}

async function insertCanaryInboxRow(
  pool: InstanceType<typeof pg.Pool>,
  signature: string,
  detectedAtMs: number,
  processedAtMs: number | null,
  processingStatus = 'PENDING',
  unavailable = false,
  exhausted = false,
): Promise<void> {
  await pool.query(`INSERT INTO chain_transaction_inbox (
    signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
    processing_status, normalized_transaction, immutable_fingerprint, observed_at,
    processed_at, first_detected_at, first_processed_at, first_processing_evidence_unavailable,
    terminal_at, purge_after, error_code, error_name, error_retryable, retry_exhausted_at
  ) VALUES (
    $1, 1, ARRAY['WEBSOCKET'], ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'confirmed',
    $4, CASE WHEN $3::BIGINT IS NULL THEN NULL ELSE '{}'::JSONB END,
    CASE WHEN $3::BIGINT IS NULL THEN NULL ELSE $7 END, to_timestamp(($2::BIGINT - 3600000) / 1000.0),
    CASE WHEN $3::BIGINT IS NULL THEN NULL ELSE to_timestamp($3::BIGINT / 1000.0) END,
    to_timestamp($2::BIGINT / 1000.0), CASE WHEN $3::BIGINT IS NULL THEN NULL ELSE to_timestamp($3::BIGINT / 1000.0) END,
    $5::BOOLEAN, CASE WHEN $4::TEXT='FAILED' THEN to_timestamp($2::BIGINT / 1000.0) END,
    CASE WHEN $4::TEXT='FAILED' THEN to_timestamp($2::BIGINT / 1000.0) + INTERVAL '4 hours' END,
    CASE WHEN $4::TEXT='FAILED' THEN 'RPC_TRANSIENT' END,
    CASE WHEN $4::TEXT='FAILED' THEN 'CanaryFailure' END,
    CASE WHEN $4::TEXT='FAILED' THEN $6::BOOLEAN ELSE NULL END,
    CASE WHEN $6::BOOLEAN THEN to_timestamp(($2::BIGINT + 1) / 1000.0) ELSE NULL END
  )`, [signature, detectedAtMs, processedAtMs, processingStatus, unavailable, exhausted, 'a'.repeat(64)]);
}

async function strictCatchUpRunRow(
  pool: InstanceType<typeof pg.Pool>,
  runId: string,
): Promise<object> {
  const result = await pool.query(`SELECT state, revision, previous_slot, observed_head_slot,
    last_accepted_slot, pages_scanned, signatures_enqueued, signatures_classified,
    (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_at_ms,
    (EXTRACT(EPOCH FROM completed_at) * 1000)::bigint AS completed_at_ms,
    (EXTRACT(EPOCH FROM purge_after) * 1000)::bigint AS purge_after_ms
    FROM listener_strict_catch_up_runs WHERE run_id = $1`, [runId]);
  return result.rows[0] as object;
}

async function insertTerminal(
  pool: InstanceType<typeof pg.Pool>,
  signature: string,
  terminalAt: Date,
): Promise<void> {
  const snapshot = { signature };
  const completedAt = new Date(terminalAt.getTime() - (4 * 60 * 60 * 1_000));
  await pool.query(`INSERT INTO chain_transaction_inbox (
    signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
    processing_status, normalized_transaction, immutable_fingerprint, observed_at,
    processed_at, terminal_at, purge_after, first_detected_at
  ) VALUES ($1, 1, ARRAY['WEBSOCKET'], ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'finalized', 'PROCESSED', $2, $3,
    $4::TIMESTAMPTZ, $4::TIMESTAMPTZ, $4::TIMESTAMPTZ,
    $4::TIMESTAMPTZ + INTERVAL '4 hours', NULL)`, [signature, snapshot, 'a'.repeat(64), completedAt]);
  await pool.query(`INSERT INTO chain_transaction_finality_replay_receipts (
    signature,observed_slot,confirmation_status,finality_evidence_version,
    immutable_fingerprint,replay_completed_at
  ) VALUES ($1,1,'finalized',0,$2,$3)`,[
    signature,'a'.repeat(64),completedAt,
  ]);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertNoSecretSurface(value: unknown, ...secrets: readonly string[]): void {
  const surfaces = [inspect(value, { depth: 20 }), JSON.stringify(value), ownPropertyText(value)];
  for (const secret of secrets) {
    for (const surface of surfaces) assert.doesNotMatch(surface, new RegExp(escapeRegex(secret), 'u'));
  }
}

function repositoryThrowing(value: unknown): PostgresTransactionInboxRepository {
  return new PostgresTransactionInboxRepository({
    connect: async () => { throw new Error('not used'); },
    query: async () => { throw value; },
  });
}

function ownPropertyText(value: unknown, seen = new Set<object>()): string {
  if (typeof value !== 'object' || value === null) return String(value);
  if (seen.has(value)) return '[cycle]';
  seen.add(value);
  return Reflect.ownKeys(value).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return String(key);
    return `${String(key)}:${ownPropertyText(descriptor.value, seen)}`;
  }).join('|');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

type ExplainPlan = Record<string, unknown> & { readonly Plans?: readonly ExplainPlan[] };

function flattenPlan(plan: ExplainPlan): ExplainPlan[] {
  return [plan, ...(plan.Plans ?? []).flatMap((nested) => flattenPlan(nested))];
}
