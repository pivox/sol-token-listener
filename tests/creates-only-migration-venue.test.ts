// Lot 4b Task 8: creates-only already records the post-migration venue of a tracked mint, with
// no new feed. The curve poller polls the bonding curve, the migrate transaction names that
// account, so it is enqueued as PUMPFUN_CURVE_TRADE; the observed pipeline's pumpswap stage
// then writes migrations + market_pools, which the live SELL router reads.
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { PublicKey } from '@solana/web3.js';
import { MarketObservationService } from '../src/application/market-observation.service.js';
import { ObservedTransactionPipeline } from '../src/application/observed-transaction-pipeline.js';
import { PumpSwapObservationPipeline } from '../src/application/pumpswap-observation-pipeline.js';
import { TrackedPoolPoller } from '../src/application/tracked-pool-poller.js';
import type { CanonicalMarketPool } from '../src/domain/market.js';
import {
  assertValidTransactionNotification,
  type TransactionNotification,
} from '../src/domain/transaction-ingestion.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { bondingCurvePda } from '../src/launchpads/pumpfun/official-sdk.js';
import { PumpFunLaunchpadAdapter } from '../src/launchpads/pumpfun/pumpfun-launchpad.adapter.js';
import { decodePumpTransaction } from '../src/launchpads/pumpfun/transaction-decoder.js';
import type { DecodedPumpMigration } from '../src/launchpads/pumpfun/types.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { PumpSwapMarketAdapter } from '../src/markets/pumpswap/pumpswap-market.adapter.js';
import type { DecodedPumpSwapPoolCreation } from '../src/markets/pumpswap/types.js';
import type { SolanaObservedTransaction } from '../src/solana/rpc/observed-transaction.js';
import type { NormalizedTransaction } from '../src/solana/rpc/types.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresExecutionVenueRepository } from '../src/storage/execution-venue.repository.js';
import { PostgresLaunchpadEventRepository } from '../src/storage/launchpad-event.repository.js';
import { PostgresMarketObservationRepository } from '../src/storage/market-observation.repository.js';
import { selectTrackedCurves } from '../src/storage/tracked-curve.repository.js';
import type { PoolCheckpoint } from '../src/storage/tracked-pool.repository.js';
import { PostgresTransactionInboxRepository } from '../src/storage/transaction-inbox.repository.js';
import { loadMainnetFixture } from './helpers/pumpfun-fixture.js';

type TestPool = InstanceType<typeof pg.Pool>;

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

async function migrateFixture() {
  const fixture = await loadMainnetFixture('pumpswap', 'migrate-v2-create-pool-mainnet.json');
  const migration = decodePumpTransaction(fixture.transaction).migrations[0];
  assert.ok(migration);
  return Object.freeze({ transaction: fixture.transaction, migration });
}

// ---------------------------------------------------------------------------------------------
// 1. Decoder and poller level.
// ---------------------------------------------------------------------------------------------

void test('the migrate transaction names the polled bonding curve and is enqueued as a valid '
  + 'PUMPFUN_CURVE_TRADE of the tracked mint', async () => {
  const { transaction, migration } = await migrateFixture();
  const curve = bondingCurvePda(new PublicKey(migration.mint)).toBase58();
  assert.equal(migration.bondingCurve, curve);
  // An account of the top-level Pump migrate instruction: the chain's signature index lists the
  // transaction for it (static or lookup-table loaded alike).
  assert.equal(migration.action.accounts.bonding_curve, curve);
  assert.ok(namedAccounts(transaction).has(curve));
  assert.ok(transaction.instructions.some((instruction) => instruction.programId === PUMP_PROGRAM_ID
    && instruction.innerInstructionIndex === null && instruction.accounts.includes(curve)));

  const enqueued: TransactionNotification[] = [];
  const poller = curvePoller(transaction, migration, {
    enqueue: (notification) => {
      enqueued.push(notification);
      return Promise.resolve();
    },
  });
  await poller.start();
  await poller.close();
  assert.equal(enqueued.length, 1);
  const notification = enqueued[0];
  assert.ok(notification);
  assert.doesNotThrow(() => { assertValidTransactionNotification(notification); });
  assert.deepEqual({
    signature: notification.signature, slot: notification.slot,
    hint: notification.ingestionHint, mint: notification.ingestionHintMint,
    programIds: notification.programIds,
  }, {
    signature: transaction.signature, slot: transaction.slot,
    hint: 'PUMPFUN_CURVE_TRADE', mint: migration.mint, programIds: [PUMP_PROGRAM_ID],
  });
});

// ---------------------------------------------------------------------------------------------
// 2 and 3. Pipeline and PostgreSQL level.
// ---------------------------------------------------------------------------------------------

void test('creates-only records migrations and market_pools for a migrating tracked mint, the '
  + 'SELL venue finds the pool and the curve poller drops the mint', async (context) => {
  await withSchema(context, async (pool) => {
    const { transaction, migration } = await migrateFixture();
    await seedLaunch(pool, migration.mint, transaction.slot - 100n);
    assert.deepEqual((await selectTrackedCurves(pool, [migration.mint])).map((curve) => ({
      poolAddress: curve.poolAddress, baseMint: curve.baseMint,
    })), [{ poolAddress: migration.bondingCurve, baseMint: migration.mint }]);

    // The poller enqueues into the real inbox.
    const inbox = new PostgresTransactionInboxRepository(pool);
    const poller = curvePoller(transaction, migration, inbox, async () =>
      selectTrackedCurves(pool, [migration.mint]));
    await poller.start();
    await poller.close();
    const stored = await pool.query(`SELECT processing_status,ingestion_priority,ingestion_hint,
      ingestion_hint_mint FROM chain_transaction_inbox WHERE signature=$1`, [
      transaction.signature,
    ]);
    assert.deepEqual(stored.rows, [{
      processing_status: 'PENDING', ingestion_priority: 'TRACKED_TRADE',
      ingestion_hint: 'PUMPFUN_CURVE_TRADE', ingestion_hint_mint: migration.mint,
    }]);

    const result = await observedPipeline(pool, migration).process(transaction, Date.now());
    assert.equal(result.marketMigrationCount, 1);
    assert.equal(result.marketActivationCount, 1);

    const venue = await new PostgresExecutionVenueRepository(pool)
      .findFinalizedCanonicalPumpSwapPool({ mint: migration.mint, quoteMint: WSOL_MINT });
    assert.ok(venue);
    assert.equal(venue.poolAddress, migration.announcedPool);
    assert.equal(venue.baseMint, migration.mint);
    assert.deepEqual(await selectTrackedCurves(pool, [migration.mint]), []);
  });
});

// ---------------------------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------------------------

/** Every account the transaction names (the sanitized fixture keeps them per instruction). */
function namedAccounts(transaction: NormalizedTransaction): ReadonlySet<string> {
  return new Set([
    ...transaction.accountKeys,
    ...transaction.instructions.flatMap((instruction) => instruction.accounts),
  ]);
}

/**
 * The creates-only curve poller (production wiring: PUMPFUN_CURVE_TRADE, Pump program) over a
 * faked finalized signature index: an address lists the fixture transaction only when that
 * transaction names it, then the tracked curve's creation signature (the checkpoint).
 */
function curvePoller(
  transaction: NormalizedTransaction,
  migration: DecodedPumpMigration,
  inbox: { enqueue(value: TransactionNotification): Promise<void> },
  listTrackedPools: () => Promise<readonly Readonly<{
    poolAddress: string; baseMint: string; activationSignature: string; activationSlot: bigint;
  }>[]> = () => Promise.resolve([{
    poolAddress: bondingCurvePda(new PublicKey(migration.mint)).toBase58(),
    baseMint: migration.mint, activationSignature: 'create-signature',
    activationSlot: transaction.slot - 100n,
  }]),
): TrackedPoolPoller {
  const checkpoints = new Map<string, PoolCheckpoint>();
  return new TrackedPoolPoller({
    repository: {
      listTrackedPools: () => listTrackedPools(),
      readCheckpoint: (address) => Promise.resolve(checkpoints.get(address) ?? null),
      seedCheckpoint: (target, value) => {
        checkpoints.set(target.poolAddress, value);
        return Promise.resolve();
      },
      storeCheckpoint: (address, value) => {
        checkpoints.set(address, value);
        return Promise.resolve();
      },
    },
    inbox,
    rpc: {
      getSignaturesForAddress: (address, options) => {
        const checkpoint = checkpoints.get(address.toBase58());
        assert.ok(checkpoint);
        const history = [
          ...(namedAccounts(transaction).has(address.toBase58())
            ? [{ signature: transaction.signature, slot: Number(transaction.slot) }] : []),
          { signature: checkpoint.signature, slot: Number(checkpoint.slot) },
        ].map((row) => ({ ...row, confirmationStatus: 'finalized', blockTime: null, err: null }));
        const start = options.before === undefined ? 0
          : history.findIndex((row) => row.signature === options.before) + 1;
        const page = [];
        for (let index = start; index < history.length && page.length < options.limit; index += 1) {
          if (history[index]?.signature === options.until) break;
          page.push(history[index]);
        }
        return Promise.resolve(page);
      },
    },
    ingestionHint: 'PUMPFUN_CURVE_TRADE',
    programId: PUMP_PROGRAM_ID,
    intervalMs: 60_000,
    trackingWindowSeconds: 3_600,
    shutdownTimeoutMs: 1_000,
    scheduler: {
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
    },
  });
}

/**
 * The listener's observed pipeline with the real Pump and PumpSwap decoders and PostgreSQL
 * projections. Only the RPC reads are stubbed: the pool validator returns the canonical pool the
 * chain holds for this creation, and the reserve reader a fixed snapshot.
 */
function observedPipeline(pool: TestPool, migration: DecodedPumpMigration) {
  const market = new PumpSwapMarketAdapter(
    undefined,
    { validate: (creation, observed) => Promise.resolve(canonicalPool(creation, observed, migration)) },
    {
      read: (target) => Promise.resolve({
        pool: target.address, baseReservesRaw: 10_000n, quoteVaultAmountRaw: 20_000n,
        virtualQuoteReservesRaw: 5_000n, effectiveQuoteReservesRaw: 25_000n,
        observedSlot: target.activatedAt.slot, observedAtMs: Date.now(),
      }),
    },
    { quote: () => Promise.reject(new Error('unused')) },
    () => undefined,
  );
  const pumpswap = new PumpSwapObservationPipeline(
    new PumpFunLaunchpadAdapter({ read: () => Promise.reject(new Error('unused')) }),
    market,
    new MarketObservationService(new PostgresMarketObservationRepository(pool)),
  );
  return new ObservedTransactionPipeline(
    new PostgresLaunchpadEventRepository(pool),
    // The migrate transaction carries no curve trade nor creation.
    { observe: () => Promise.resolve({ events: [], affectedMints: [] }) },
    pumpswap,
  );
}

function canonicalPool(
  creation: DecodedPumpSwapPoolCreation,
  observed: SolanaObservedTransaction,
  migration: DecodedPumpMigration,
): CanonicalMarketPool {
  const account = (name: string): string => {
    const value = creation.action.accounts[name];
    assert.ok(value !== undefined, name);
    return value;
  };
  return {
    address: creation.pool, market: 'pumpswap', programId: PUMPSWAP_PROGRAM_ID,
    baseMint: creation.baseMint, quoteAsset: migration.quoteAsset, index: 0,
    creator: creation.creator, baseVault: account('pool_base_token_account'),
    quoteVault: account('pool_quote_token_account'), lpMint: account('lp_mint'),
    baseTokenProgram: migration.baseTokenProgram,
    activatedAt: {
      slot: observed.cursor.slot, transactionIndex: observed.cursor.transactionIndex,
      instructionIndex: creation.action.instruction.instructionIndex,
      innerInstructionIndex: creation.action.instruction.innerInstructionIndex,
    },
    confirmationStatus: observed.confirmationStatus,
  };
}

async function seedLaunch(pool: TestPool, mint: string, slot: bigint): Promise<void> {
  await pool.query(`INSERT INTO token_launches (
    mint,launchpad,program_id,creator,token_program,quote_assets,current_state,
    created_signature,created_slot,created_transaction_index,created_instruction_index,
    created_inner_instruction_index,detected_at,updated_at
  ) VALUES ($1,'pumpfun','pump','creator','TOKEN_2022','[]','DETECTED','create-signature',$2,0,0,
    NULL,now(),now())`, [mint, slot.toString()]);
}

async function withSchema(
  context: TestContext,
  callback: (pool: TestPool) => Promise<void>,
): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: creates-only migration venue test skipped');
    return;
  }
  const schema = `creates_only_venue_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrateDatabase({ pool });
    await callback(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}
