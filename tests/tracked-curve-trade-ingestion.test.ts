import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { assertValidTransactionNotification } from '../src/domain/transaction-ingestion.js';
import type { TransactionNotification } from '../src/domain/transaction-ingestion.js';
import { createPumpFunWorkerAdmissionPolicy } from '../src/domain/worker-admission.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresTransactionInboxRepository } from '../src/storage/transaction-inbox.repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const mint = 'So11111111111111111111111111111111111111112';

void test('validator accepts PUMPFUN_CURVE_TRADE catch-up notifications only with a canonical mint', () => {
  assert.doesNotThrow(() => { assertValidTransactionNotification(curveTrade('valid', 1n)); });
  assert.throws(
    () => { assertValidTransactionNotification(Object.freeze({
      ...curveTrade('missing-mint', 1n), ingestionHintMint: null,
    })); },
    /ingestion hint is invalid/u,
  );
  assert.throws(
    () => { assertValidTransactionNotification(Object.freeze({
      ...curveTrade('pumpfun-hint-catch-up', 1n), ingestionHint: 'PUMPFUN_TRADE',
    })); },
    /catch-up/u,
  );
  assert.throws(
    () => { assertValidTransactionNotification(Object.freeze({
      ...curveTrade('curve-trade-websocket', 1n), source: 'WEBSOCKET',
    })); },
    /ingestion hint is invalid/u,
  );
});

void test('stores a PUMPFUN_CURVE_TRADE notification as a pending tracked trade, idempotently', async (context) => {
  await withInbox(context, async (pool) => {
    const inbox = new PostgresTransactionInboxRepository(pool);
    await inbox.enqueue(curveTrade('curve-trade-store', 10n));
    await inbox.enqueue(curveTrade('curve-trade-store', 10n));
    const stored = await pool.query(`SELECT processing_status,ingestion_priority,
        ingestion_hint,ingestion_hint_mint
      FROM chain_transaction_inbox WHERE signature=$1`, ['curve-trade-store']);
    assert.deepEqual(stored.rows, [{
      processing_status: 'PENDING', ingestion_priority: 'TRACKED_TRADE',
      ingestion_hint: 'PUMPFUN_CURVE_TRADE', ingestion_hint_mint: mint,
    }]);
  });
});

for (const enabled of [true, false]) {
  void test(`claims a PUMPFUN_CURVE_TRADE row with worker admission ${enabled ? 'enabled' : 'disabled'}`,
    async (context) => {
      await withInbox(context, async (pool) => {
        const inbox = new PostgresTransactionInboxRepository(pool, undefined,
          createPumpFunWorkerAdmissionPolicy({ enabled, trackingWindowSeconds: 45 }));
        await inbox.enqueue(curveTrade('curve-trade-claim', 10n));
        if (enabled) {
          const admitted = await pool.query(`SELECT worker_admitted_at IS NOT NULL AS admitted
            FROM chain_transaction_inbox WHERE signature=$1`, ['curve-trade-claim']);
          assert.equal(admitted.rows[0]?.admitted, true);
        }
        const claimed = await inbox.claim(Date.now(), 30);
        assert.equal(claimed?.signature, 'curve-trade-claim');
      });
    });
}

for (const enabled of [true, false]) {
  void test(`claims tracked PUMPFUN_TRADE rows before older PUMPFUN_CURVE_TRADE rows with worker admission ${enabled ? 'enabled' : 'disabled'}`,
    async (context) => {
      await withInbox(context, async (pool) => {
        await insertTrackedLaunch(pool);
        const inbox = new PostgresTransactionInboxRepository(pool, undefined,
          createPumpFunWorkerAdmissionPolicy({ enabled, trackingWindowSeconds: 45 }));
        await inbox.enqueue(curveTrade('curve-trade-older', 100n));
        await inbox.enqueue(websocketTrade('pumpfun-trade-newer', 200n));
        const first = await inbox.claim(Date.now(), 30);
        const second = await inbox.claim(Date.now(), 30);
        assert.deepEqual([first?.signature, second?.signature],
          ['pumpfun-trade-newer', 'curve-trade-older']);
      });
    });
}

void test('PUMPFUN_CURVE_TRADE rows do not count as non-terminal Pump program work', async (context) => {
  await withInbox(context, async (pool) => {
    const inbox = new PostgresTransactionInboxRepository(pool);
    await inbox.enqueue(curveTrade('curve-trade-guard', 10n));
    assert.equal(await inbox.hasNonTerminalProgramWork(PUMP_PROGRAM_ID), false);
    await inbox.enqueue(Object.freeze({
      ...curveTrade('pump-none-guard', 11n), ingestionHint: null, ingestionHintMint: null,
    }));
    assert.equal(await inbox.hasNonTerminalProgramWork(PUMP_PROGRAM_ID), true);
  });
});

for (const enabled of [true, false]) {
  void test(`claims PUMPFUN_TRADE, then PUMPFUN_CURVE_TRADE, then PUMPSWAP_POOL_TRADE at the same slot with worker admission ${enabled ? 'enabled' : 'disabled'}`,
    async (context) => {
      await withInbox(context, async (pool) => {
        await insertTrackedLaunch(pool);
        const inbox = new PostgresTransactionInboxRepository(pool, undefined,
          createPumpFunWorkerAdmissionPolicy({ enabled, trackingWindowSeconds: 45 }));
        await inbox.enqueue(Object.freeze({
          ...curveTrade('a-pool', 100n),
          ingestionHint: 'PUMPSWAP_POOL_TRADE',
          programIds: Object.freeze([PUMPSWAP_PROGRAM_ID]),
        }));
        await inbox.enqueue(curveTrade('b-curve', 100n));
        await inbox.enqueue(websocketTrade('c-websocket', 100n));
        const claimed: (string | undefined)[] = [];
        for (let index = 0; index < 3; index += 1) {
          claimed.push((await inbox.claim(Date.now(), 30))?.signature);
        }
        assert.deepEqual(claimed, ['c-websocket', 'b-curve', 'a-pool']);
      });
    });
}

function curveTrade(signature: string, slot: bigint): TransactionNotification {
  return Object.freeze({
    signature,
    slot,
    source: 'CATCH_UP',
    ingestionHint: 'PUMPFUN_CURVE_TRADE',
    ingestionHintMint: mint,
    programIds: Object.freeze([PUMP_PROGRAM_ID]),
    confirmationStatus: 'finalized',
    observedAtMs: 1_000,
  });
}

function websocketTrade(signature: string, slot: bigint): TransactionNotification {
  return Object.freeze({
    signature,
    slot,
    source: 'WEBSOCKET',
    ingestionHint: 'PUMPFUN_TRADE',
    ingestionHintMint: mint,
    programIds: Object.freeze([PUMP_PROGRAM_ID]),
    confirmationStatus: 'processed',
    observedAtMs: 1_000,
  });
}

async function insertTrackedLaunch(pool: pg.Pool): Promise<void> {
  await pool.query(`INSERT INTO token_launches (
    mint, launchpad, program_id, creator, token_program, current_state, created_signature,
    created_slot, created_transaction_index, created_instruction_index, detected_at, updated_at
  ) VALUES ($1,'pumpfun',$2,$1,$2,'OBSERVING','tracked-launch',1,0,0,clock_timestamp(),clock_timestamp())`,
  [mint, PUMP_PROGRAM_ID]);
  await pool.query(`INSERT INTO domain_events (
    event_id,type,mint,source,program,signature,slot,transaction_index,instruction_index,
    inner_instruction_index,confirmation_status,observed_at,payload_version,payload
  ) VALUES ('tracked-launch-event','TokenLaunchDetected',$1,'pumpfun',$2,
    'tracked-launch',1,0,0,NULL,'confirmed',clock_timestamp(),1,'{}'::jsonb)`,
  [mint, PUMP_PROGRAM_ID]);
}

async function withInbox(
  context: TestContext,
  run: (pool: pg.Pool) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: tracked pool trade ingestion skipped');
    return;
  }
  const schema = `tracked_curve_trade_${randomUUID().replaceAll('-', '')}`;
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
