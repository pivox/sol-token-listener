import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { assertValidTransactionNotification } from '../src/domain/transaction-ingestion.js';
import type { TransactionNotification } from '../src/domain/transaction-ingestion.js';
import { createPumpFunWorkerAdmissionPolicy } from '../src/domain/worker-admission.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresTransactionInboxRepository } from '../src/storage/transaction-inbox.repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const mint = 'So11111111111111111111111111111111111111112';

void test('validator accepts PUMPSWAP_POOL_TRADE catch-up notifications only with a canonical mint', () => {
  assert.doesNotThrow(() => { assertValidTransactionNotification(poolTrade('valid', 1n)); });
  assert.throws(
    () => { assertValidTransactionNotification(Object.freeze({
      ...poolTrade('missing-mint', 1n), ingestionHintMint: null,
    })); },
    /ingestion hint is invalid/u,
  );
  assert.throws(
    () => { assertValidTransactionNotification(Object.freeze({
      ...poolTrade('pumpfun-catch-up', 1n), ingestionHint: 'PUMPFUN_TRADE',
    })); },
    /catch-up/u,
  );
});

void test('stores a PUMPSWAP_POOL_TRADE notification as a pending tracked trade, idempotently', async (context) => {
  await withInbox(context, async (pool) => {
    const inbox = new PostgresTransactionInboxRepository(pool);
    await inbox.enqueue(poolTrade('pool-trade-store', 10n));
    await inbox.enqueue(poolTrade('pool-trade-store', 10n));
    const stored = await pool.query(`SELECT processing_status,ingestion_priority,
        ingestion_hint,ingestion_hint_mint
      FROM chain_transaction_inbox WHERE signature=$1`, ['pool-trade-store']);
    assert.deepEqual(stored.rows, [{
      processing_status: 'PENDING', ingestion_priority: 'TRACKED_TRADE',
      ingestion_hint: 'PUMPSWAP_POOL_TRADE', ingestion_hint_mint: mint,
    }]);
  });
});

for (const enabled of [true, false]) {
  void test(`claims a PUMPSWAP_POOL_TRADE row with worker admission ${enabled ? 'enabled' : 'disabled'}`,
    async (context) => {
      await withInbox(context, async (pool) => {
        const inbox = new PostgresTransactionInboxRepository(pool, undefined,
          createPumpFunWorkerAdmissionPolicy({ enabled, trackingWindowSeconds: 45 }));
        await inbox.enqueue(poolTrade('pool-trade-claim', 10n));
        if (enabled) {
          const admitted = await pool.query(`SELECT worker_admitted_at IS NOT NULL AS admitted
            FROM chain_transaction_inbox WHERE signature=$1`, ['pool-trade-claim']);
          assert.equal(admitted.rows[0]?.admitted, true);
        }
        const claimed = await inbox.claim(Date.now(), 30);
        assert.equal(claimed?.signature, 'pool-trade-claim');
      });
    });
}

void test('PUMPSWAP_POOL_TRADE rows do not count as non-terminal PumpSwap program work', async (context) => {
  await withInbox(context, async (pool) => {
    const inbox = new PostgresTransactionInboxRepository(pool);
    await inbox.enqueue(poolTrade('pool-trade-guard', 10n));
    assert.equal(await inbox.hasNonTerminalProgramWork(PUMPSWAP_PROGRAM_ID), false);
    await inbox.enqueue(Object.freeze({
      ...poolTrade('pumpswap-none-guard', 11n), ingestionHint: null, ingestionHintMint: null,
    }));
    assert.equal(await inbox.hasNonTerminalProgramWork(PUMPSWAP_PROGRAM_ID), true);
  });
});

function poolTrade(signature: string, slot: bigint): TransactionNotification {
  return Object.freeze({
    signature,
    slot,
    source: 'CATCH_UP',
    ingestionHint: 'PUMPSWAP_POOL_TRADE',
    ingestionHintMint: mint,
    programIds: Object.freeze([PUMPSWAP_PROGRAM_ID]),
    confirmationStatus: 'finalized',
    observedAtMs: 1_000,
  });
}

async function withInbox(
  context: TestContext,
  run: (pool: pg.Pool) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: tracked pool trade ingestion skipped');
    return;
  }
  const schema = `tracked_pool_trade_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await migrateDatabase({ pool });
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}
