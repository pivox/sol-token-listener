import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { ObservedTransactionPipeline } from '../src/application/observed-transaction-pipeline.js';
import { TransactionInboxWorker } from '../src/application/transaction-inbox-worker.js';
import {
  createBondingCurveTradeObservedEvent,
  createTokenLaunchDetectedEvent,
} from '../src/domain/launchpad-events.js';
import { createInitialDetectedTransition } from '../src/domain/state-transitions.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import type { LaunchpadEventBatch } from '../src/ports/launchpad-event-sink.js';
import type { TransactionNotification } from '../src/domain/transaction-ingestion.js';
import type { NormalizedTransaction } from '../src/solana/rpc/types.js';
import { migrateDatabase } from '../src/storage/database.js';
import { PostgresLaunchpadEventRepository } from '../src/storage/launchpad-event.repository.js';
import { PostgresTransactionInboxRepository } from '../src/storage/transaction-inbox.repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const mint = 'So11111111111111111111111111111111111111112';
const tradeSignature = 'tracked-trade-signature';
const creationSignature = 'tracked-creation-signature';

void test('persists a deferred trade without a body fetch until creation persistence synchronizes its mint', async (context) => {
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: tracked-trade pipeline integration skipped');
    return;
  }
  const schema = `tracked_trade_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await migrateDatabase({ pool });
    const inbox = new PostgresTransactionInboxRepository(pool);
    const launches = new PostgresLaunchpadEventRepository(pool);
    const create = normalized(creationSignature, 10n);
    const trade = normalized(tradeSignature, 11n);
    const creationBatch = creation(creationSignature, mint);
    const tradeBatch = tradeObservation(tradeSignature, mint);
    const pipeline = new ObservedTransactionPipeline(
      launches,
      {
        observe: async (observed) => launches.record(
          observed.signature === creationSignature ? creationBatch : tradeBatch,
        ),
      },
      { observe: async () => ({ assessments: [], evidence: [] }) },
      { rebuild: async () => undefined },
      { rebuild: async () => undefined },
      { processObserved: async () => ({ migrations: [], activations: [], affectedMints: [] }) },
      () => 2_000,
      null,
      null,
      inbox,
    );
    await inbox.enqueue(tradeNotification(tradeSignature, 11n));
    const deferred = await pool.query(`SELECT processing_status,ingestion_priority
      FROM chain_transaction_inbox WHERE signature=$1`, [tradeSignature]);
    assert.deepEqual(deferred.rows[0], {
      processing_status: 'DEFERRED', ingestion_priority: 'NORMAL',
    });

    let locatorCalls = 0;
    const worker = new TransactionInboxWorker(inbox, {
      locate: async () => {
        locatorCalls += 1;
        return trade;
      },
    }, pipeline, { leaseSeconds: 30, renewalIntervalMs: 1_000, idlePollMs: 1_000 });
    assert.deepEqual(await worker.runOnce(), { kind: 'idle' });
    assert.equal(locatorCalls, 0);

    await pipeline.process(create);
    const decision = await pool.query(`SELECT processing_status,ingestion_priority
      FROM chain_transaction_inbox WHERE signature=$1`, [tradeSignature]);
    assert.deepEqual(decision.rows[0], {
      processing_status: 'PENDING', ingestion_priority: 'TRACKED_TRADE',
    });

    assert.deepEqual(await worker.runOnce(), { kind: 'processed', signature: tradeSignature });
    assert.equal(locatorCalls, 1);
    const active = await launches.listActiveEventsBySignature(tradeSignature);
    assert.equal(active.length, 1);
    assert.equal(active[0]?.type, 'BondingCurveTradeObserved');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

function tradeNotification(signature: string, slot: bigint): TransactionNotification {
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

function normalized(signature: string, slot: bigint): NormalizedTransaction {
  return {
    signature, slot, transactionIndex: 0, confirmationStatus: 'PROCESSED', version: 'legacy',
    blockTimeMs: 1_000, accountKeys: [], signerKeys: [], instructions: [],
    preTokenBalances: [], postTokenBalances: [], preBalancesLamports: [], postBalancesLamports: [],
    feeLamports: 0n, computeUnits: null, logs: [], error: null,
  };
}

function envelope(signature: string) {
  return {
    signature,
    confirmationStatus: 'processed' as const,
    blockTimeMs: 1_000,
    observedAtMs: 2_000,
    cursor: { slot: signature === creationSignature ? 10n : 11n, transactionIndex: 0 },
    raw: null,
  };
}

function creation(signature: string, launchMint: string): LaunchpadEventBatch {
  const transaction = envelope(signature);
  const launch = createTokenLaunchDetectedEvent({
    source: 'pumpfun', program: PUMP_PROGRAM_ID, transaction,
    launch: {
      mint: launchMint, creator: 'creator', tokenProgram: 'SPL_TOKEN',
      quoteAssets: [{ mint: 'quote', decimals: 9, tokenProgram: 'SPL_TOKEN' }],
      launchpad: 'pumpfun',
      createdAt: { ...transaction.cursor, instructionIndex: 0, innerInstructionIndex: null },
      parameters: {},
    },
  });
  return Object.freeze({
    source: 'pumpfun', program: PUMP_PROGRAM_ID, signature, confirmationStatus: 'processed',
    events: Object.freeze([launch]), stateTransitionAction: 'apply',
    transitions: Object.freeze([createInitialDetectedTransition(launch)]),
  });
}

function tradeObservation(signature: string, launchMint: string): LaunchpadEventBatch {
  const transaction = envelope(signature);
  const trade = createBondingCurveTradeObservedEvent({
    source: 'pumpfun', program: PUMP_PROGRAM_ID, transaction,
    trade: {
      id: `trade-${signature}`, launchMint, kind: 'BUY', trader: 'buyer',
      baseAmountRaw: 1n, quoteAmountRaw: 2n,
      quoteAsset: { mint: 'quote', decimals: 9, tokenProgram: 'SPL_TOKEN' },
      cursor: { ...transaction.cursor, instructionIndex: 0, innerInstructionIndex: null },
    },
  });
  return Object.freeze({
    source: 'pumpfun', program: PUMP_PROGRAM_ID, signature, confirmationStatus: 'processed',
    events: Object.freeze([trade]), stateTransitionAction: 'apply', transitions: Object.freeze([]),
  });
}
