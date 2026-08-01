import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import pg from 'pg';
import { CatchUpScanner } from '../src/application/catch-up-scanner.js';
import type {
  IngestionFailure,
  RuntimeHeartbeat,
  TransactionNotification,
} from '../src/domain/transaction-ingestion.js';
import type { NormalizedTransaction } from '../src/solana/rpc/types.js';
import { restoreNormalizedTransactionSnapshot } from '../src/domain/transaction-ingestion.js';
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
      signature: 'finality', confirmationStatus: null,
      expectedMissingFinalityPolls: 0, observedAtMs: 101_000,
    }));
    assert.equal(firstMissing.missingFinalityPolls, 1);
    const concurrentMissing = await Promise.allSettled([
      repository.recordFinalityPoll(Object.freeze({
        signature: 'finality', confirmationStatus: null,
        expectedMissingFinalityPolls: 1, observedAtMs: 102_000,
      })),
      repository.recordFinalityPoll(Object.freeze({
        signature: 'finality', confirmationStatus: null,
        expectedMissingFinalityPolls: 1, observedAtMs: 102_001,
      })),
    ]);
    assert.equal(concurrentMissing.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(concurrentMissing.filter((result) =>
      result.status === 'rejected' && result.reason instanceof TransactionInboxConflictError).length, 1);
    const reset = await repository.recordFinalityPoll(Object.freeze({
      signature: 'finality', confirmationStatus: 'processed',
      expectedMissingFinalityPolls: 2, observedAtMs: 103_000,
    }));
    assert.equal(reset.confirmationStatus, 'confirmed');
    assert.equal(reset.missingFinalityPolls, 0);
    const processedAtMs = new Date((await row(pool, 'finality')).processed_at).getTime();
    assert.deepEqual(await repository.listForFinality(10), [{
      signature: 'finality', slot: 30n, confirmationStatus: 'confirmed',
      missingFinalityPolls: 0, processedAtMs,
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
      signature: 'finality', confirmationStatus: 'orphaned', observedAtMs: 120_000,
    })), TransactionInboxConflictError);

    await repository.enqueue(notification('orphan', 31n));
    const orphan = await repository.claim(120_001, 120);
    assert.ok(orphan);
    await repository.saveSnapshot('orphan', orphan.leaseToken, normalized('orphan', 31n));
    await repository.markProcessed('orphan', orphan.leaseToken, 'processed');
    await repository.enqueueRevision(Object.freeze({
      signature: 'orphan', confirmationStatus: 'orphaned', observedAtMs: 130_000,
    }));
    const orphanRevision = await repository.claim(130_001, 120);
    assert.equal(orphanRevision?.confirmationStatus, 'orphaned');
  });
});

void test('schedules retryable failures, keeps deterministic failures terminal, and counts states', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
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
    assert.equal(await repository.claim(200_001, 120)?.then((value) => value?.signature), 'fatal');

    const fatalClaim = await repository.claim(200_002, 120);
    assert.equal(fatalClaim, null);
    const fatalRow = await row(pool, 'fatal');
    await repository.markFailed('fatal', fatalRow.lease_token, Object.freeze({
      code: 'NORMALIZATION_FAILED', errorName: 'TypeError', retryable: false,
    }));
    assert.equal((await row(pool, 'fatal')).next_attempt_at, null);
    assert.deepEqual(await repository.counts(), {
      pending: 0, processing: 0, processed: 0, failed: 2,
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

    await repository.enqueue(notification('unsafe-error-name', 42n));
    const unsafe = await repository.claim(retryAt + 2, 120);
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
    assert.equal(storedHeartbeat.last_http_slot, '51');
    assert.equal(storedHeartbeat.runtime_state, 'RUNNING');
    assert.equal(storedHeartbeat.last_signature, 'checkpoint');
    assert.deepEqual(storedHeartbeat.payload, { startedAt: '1970-01-01T00:04:50.000Z' });

    await insertTerminal(pool, 'purge-me', new Date(Date.now() - 1_000));
    await insertTerminal(pool, 'keep-me', new Date(Date.now() + 60_000));
    assert.equal((await purgeExpiredFoundationData(pool)).transactionInbox, 1);
    assert.equal((await pool.query("SELECT COUNT(*) FROM chain_transaction_inbox WHERE signature = 'keep-me'")).rows[0]?.count, '1');
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
      WHERE processing_status = 'PENDING'
         OR (processing_status = 'FAILED' AND error_retryable = TRUE
             AND next_attempt_at <= clock_timestamp())
         OR (processing_status = 'PROCESSING' AND lease_expires_at <= clock_timestamp())
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
