import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import pg from 'pg';
import { CatchUpScanner } from '../src/application/catch-up-scanner.js';
import { FinalityReconciler } from '../src/application/finality-reconciler.js';
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
import type { StrictCatchUpRepository } from '../src/ports/strict-catch-up-repository.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import {
  PostgresTransactionInboxRepository,
  TransactionInboxConflictError,
  TransactionInboxLeaseError,
  TransactionInboxRepositoryError,
} from '../src/storage/transaction-inbox.repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

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
            blockTimeMs: futureBlockTimeMs,
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

void test('keeps an exact finalized receipt aligned on duplicate discovery before purge',async(context)=>{
  await withDatabase(context,async(pool)=>{
    const repository=new PostgresTransactionInboxRepository(pool);
    const signature='finalized-receipt-duplicate';
    await repository.enqueue(notification(signature,42n,'WEBSOCKET','finalized'));
    const claim=await repository.claim(220_000,120);
    assert.ok(claim);
    await repository.saveSnapshot(signature,claim.leaseToken,normalized(signature,42n));
    await repository.markProcessed(signature,claim.leaseToken,'finalized');
    const before=await pool.query(`SELECT inbox.finality_evidence_version::text AS version,
      inbox.updated_at,receipt.finality_evidence_version::text AS receipt_version,
      receipt.replay_completed_at
      FROM chain_transaction_inbox inbox
      JOIN chain_transaction_finality_replay_receipts receipt USING (signature)
      WHERE inbox.signature=$1`,[signature]);

    await repository.enqueue(notification(signature,42n,'CATCH_UP','confirmed',220_001));

    const after=await pool.query(`SELECT inbox.finality_evidence_version::text AS version,
      inbox.updated_at,receipt.finality_evidence_version::text AS receipt_version,
      receipt.replay_completed_at
      FROM chain_transaction_inbox inbox
      JOIN chain_transaction_finality_replay_receipts receipt USING (signature)
      WHERE inbox.signature=$1`,[signature]);
    assert.deepEqual(after.rows,before.rows);
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
      retryableFailed: 1, exhaustedFailed: 0,
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
      retryableFailed: 0, exhaustedFailed: 1,
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
    assert.deepEqual(storedHeartbeat.payload, { startedAt: '1970-01-01T00:04:50.000Z' });

    await insertTerminal(pool, 'purge-me', new Date(Date.now() - 1_000));
    await insertTerminal(pool, 'keep-me', new Date(Date.now() + 60_000));
    await repository.enqueue(notification('failed-purge-me', 51n));
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
    "SELECT pg_advisory_xact_lock(hashtextextended('transaction-inbox:' || $1, 0))",
    'ROLLBACK']);
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
    await pool.query('ANALYZE chain_transaction_inbox');
    const explained = await pool.query(`EXPLAIN (FORMAT JSON)
      SELECT signature FROM chain_transaction_inbox
      WHERE (processing_status = 'PENDING' AND attempts_in_cycle < retry_max_attempts)
         OR (processing_status = 'FAILED' AND error_retryable = TRUE
             AND retry_exhausted_at IS NULL
             AND next_attempt_at <= clock_timestamp()
             AND attempts_in_cycle < retry_max_attempts)
         OR (processing_status = 'PROCESSING' AND lease_expires_at <= clock_timestamp()
             AND attempts_in_cycle < retry_max_attempts)
      ORDER BY observed_slot, signature
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
    assert.equal(claimed?.signature, 'pending-1');
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

function notification(
  signature: string,
  slot: bigint,
  source: TransactionNotification['source'] = 'WEBSOCKET',
  confirmationStatus: TransactionNotification['confirmationStatus'] = 'processed',
  observedAtMs = 1_000,
): TransactionNotification {
  const programIds = source === 'CATCH_UP'
    ? Object.freeze([
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    ])
    : Object.freeze(['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']);
  return Object.freeze({ signature, slot, source, programIds, confirmationStatus, observedAtMs });
}

function checkpoint(
  key: ProcessingCheckpoint['key'],
  slot: bigint,
  signature: string,
  updatedAtMs: number,
): ProcessingCheckpoint {
  return Object.freeze({ key, slot, signature, updatedAtMs });
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
    processed_at, terminal_at, purge_after
  ) VALUES ($1, 1, ARRAY['WEBSOCKET'], ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], 'finalized', 'PROCESSED', $2, $3,
    $4::TIMESTAMPTZ, $4::TIMESTAMPTZ, $4::TIMESTAMPTZ,
    $4::TIMESTAMPTZ + INTERVAL '4 hours')`, [signature, snapshot, 'a'.repeat(64), completedAt]);
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
