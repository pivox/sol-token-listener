import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import pg from 'pg';
import { LaunchParticipantAnalyticsService } from '../src/application/launch-participant-analytics.service.js';
import { LaunchpadObservationService } from '../src/application/launchpad-observation.service.js';
import { MarketObservationService } from '../src/application/market-observation.service.js';
import { ObservedTransactionPipeline } from '../src/application/observed-transaction-pipeline.js';
import { PumpSwapObservationPipeline } from '../src/application/pumpswap-observation-pipeline.js';
import { TransactionInboxWorker } from '../src/application/transaction-inbox-worker.js';
import { WalletEvidenceObservationService } from '../src/application/wallet-evidence-observation.service.js';
import { WalletGraphRebuildService } from '../src/application/wallet-graph-rebuild.service.js';
import type { CanonicalMarketPool } from '../src/domain/market.js';
import type { OpenPaperPositionCommand, PaperExecutionQuote } from '../src/domain/paper-trading.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PumpFunLaunchpadAdapter } from '../src/launchpads/pumpfun/pumpfun-launchpad.adapter.js';
import { decodePumpTransaction } from '../src/launchpads/pumpfun/transaction-decoder.js';
import type { DecodedPumpMigration, DecodedPumpTransaction } from '../src/launchpads/pumpfun/types.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { PumpSwapMarketAdapter } from '../src/markets/pumpswap/pumpswap-market.adapter.js';
import type {
  DecodedPumpSwapPoolCreation,
  DecodedPumpSwapTransaction,
} from '../src/markets/pumpswap/types.js';
import { PaperTradingEngine } from '../src/paper/paper-trading-engine.js';
import { QualificationEngine, defaultQualificationRuleSet } from '../src/qualification/qualification-engine.js';
import { SolanaWalletFundingEvidenceExtractor } from '../src/solana/wallet-funding-evidence-extractor.js';
import { createSolanaObservedTransaction } from '../src/solana/rpc/observed-transaction.js';
import type { NormalizedInstruction, NormalizedTransaction } from '../src/solana/rpc/types.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import { PostgresLaunchpadEventRepository } from '../src/storage/launchpad-event.repository.js';
import { PostgresMarketObservationRepository } from '../src/storage/market-observation.repository.js';
import { PostgresPaperTradingRepository } from '../src/storage/paper-trading.repository.js';
import { PostgresParticipantAnalyticsRepository } from '../src/storage/participant-analytics.repository.js';
import { PostgresTransactionInboxRepository } from '../src/storage/transaction-inbox.repository.js';
import { PostgresWalletEvidenceRepository } from '../src/storage/wallet-evidence.repository.js';
import { PostgresWalletGraphRepository } from '../src/storage/wallet-graph.repository.js';
import { loadPumpFixture } from './helpers/pumpfun-fixture.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const BOUNDARIES = Object.freeze(['launchpad', 'funding', 'i1', 'i2', 'pumpswap'] as const);
type Boundary = (typeof BOUNDARIES)[number];
const FULL_REPLAY: readonly Boundary[] = BOUNDARIES;

void test('restarts the production PostgreSQL path at every observation boundary', async (context) => {
  await withDatabase(context, async (pool) => {
    const fixture = await loadPumpFixture('create-v2-initial-buy-mainnet.json');
    const transaction = migrationTransaction(fixture.transaction);
    for (const boundary of BOUNDARIES) {
      await truncateRuntimeData(pool);
      await seedObservedLaunch(pool, transaction);
      const repository = new PostgresTransactionInboxRepository(pool);
      await repository.enqueue(Object.freeze({
        signature: transaction.signature,
        slot: transaction.slot,
        source: 'WEBSOCKET' as const,
        programIds: Object.freeze([PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort()),
        confirmationStatus: 'confirmed' as const,
        observedAtMs: Date.now(),
      }));

      const firstOrder: Boundary[] = [];
      const firstWorker = worker(repository, transaction, pipeline(pool, boundary, firstOrder));
      const failed = await firstWorker.runOnce();
      assert.equal(failed.kind, 'failed', boundary);
      assert.deepEqual(firstOrder, FULL_REPLAY.slice(0, BOUNDARIES.indexOf(boundary) + 1), boundary);
      const failedInbox = await inboxRow(pool, transaction.signature);
      assert.deepEqual({
        status: failedInbox.processing_status,
        attempts: failedInbox.attempts,
        errorCode: failedInbox.error_code,
        retryable: failedInbox.error_retryable,
      }, {
        status: 'FAILED', attempts: 1, errorCode: 'PIPELINE_STAGE_FAILED', retryable: true,
      }, boundary);
      assert.ok(failedInbox.normalized_transaction);
      assert.ok(failedInbox.next_attempt_at instanceof Date);

      const restartOrder: Boundary[] = [];
      const restartWorker = worker(
        repository,
        transaction,
        pipeline(pool, null, restartOrder),
        failedInbox.next_attempt_at.getTime() + 1,
        false,
      );
      const restarted = await restartWorker.runOnce();
      assert.deepEqual(restartOrder, FULL_REPLAY, boundary);
      assert.deepEqual(restarted, {
        kind: 'processed', signature: transaction.signature,
      }, boundary);
      assert.deepEqual(await productionCounts(pool), {
        launches: '1', trades: '1', fundingAssessments: '1', creatorProfiles: '1',
        participantSnapshots: '1', walletGraphProfiles: '1', walletGraphSnapshots: '1',
        migrations: '1', marketPools: '1', reserveSnapshots: '1', paperPositions: '0',
      }, boundary);
      const processedInbox = await inboxRow(pool, transaction.signature);
      assert.deepEqual({
        status: processedInbox.processing_status,
        attempts: processedInbox.attempts,
        errorCode: processedInbox.error_code,
        nextAttemptAt: processedInbox.next_attempt_at,
      }, {
        status: 'PROCESSED', attempts: 2, errorCode: null, nextAttemptAt: null,
      }, boundary);
      assert.ok(processedInbox.processed_at instanceof Date);

      await assertPaperSafety(pool);
      assert.equal((await productionCounts(pool)).paperPositions, '0', boundary);
    }
  });
});

void test('terminalizes legacy finality rows for four hours without purging pending finality', async (context) => {
  await withDatabase(context, async (pool) => {
    await pool.query(
      'ALTER TABLE chain_transaction_inbox DROP CONSTRAINT chain_transaction_inbox_terminal_completion_check',
    );
    await insertProcessed(pool, 'recent-finalized', 'finalized', 1);
    await insertProcessed(pool, 'recent-orphaned', 'orphaned', 1);
    await insertProcessed(pool, 'expired-finalized', 'finalized', 5);
    await insertProcessed(pool, 'pending-finality', 'confirmed', 5);

    const result = await purgeExpiredFoundationData(pool);

    assert.equal(result.transactionInbox, 1);
    for (const signature of ['recent-finalized', 'recent-orphaned']) {
      const row = (await pool.query(
        `SELECT terminal_at, purge_after,
           EXTRACT(EPOCH FROM (purge_after - terminal_at)) AS retention_seconds
         FROM chain_transaction_inbox WHERE signature = $1`,
        [signature],
      )).rows[0];
      assert.ok(row?.terminal_at instanceof Date);
      assert.ok(row.purge_after instanceof Date);
      assert.equal(Number(row.retention_seconds), 14_400);
    }
    assert.equal((await pool.query(
      "SELECT COUNT(*) AS count FROM chain_transaction_inbox WHERE signature = 'expired-finalized'",
    )).rows[0]?.count, '0');
    const pending = (await pool.query(
      `SELECT terminal_at, purge_after FROM chain_transaction_inbox
       WHERE signature = 'pending-finality'`,
    )).rows[0];
    assert.deepEqual(pending, { terminal_at: null, purge_after: null });
  });
});

function pipeline(
  pool: InstanceType<typeof pg.Pool>,
  failAt: Boundary | null,
  order: Boundary[],
): ObservedTransactionPipeline {
  const launchpadRepository = new PostgresLaunchpadEventRepository(pool, 4);
  const pump = pumpAdapter();
  const realLaunchpad = new LaunchpadObservationService(pump, launchpadRepository);
  const realFunding = new WalletEvidenceObservationService(
    new SolanaWalletFundingEvidenceExtractor(),
    new PostgresWalletEvidenceRepository(pool),
  );
  const realParticipants = new LaunchParticipantAnalyticsService(
    new PostgresParticipantAnalyticsRepository(pool),
  );
  const realGraph = new WalletGraphRebuildService(new PostgresWalletGraphRepository(pool));
  const realMarket = marketPipeline(pool, pump);
  const after = async <T>(boundary: Boundary, operation: Promise<T>): Promise<T> => {
    const result = await operation;
    order.push(boundary);
    if (failAt === boundary) throw new Error(`restart after ${boundary}`);
    return result;
  };
  return new ObservedTransactionPipeline(
    launchpadRepository,
    { observe: (...args) => after('launchpad', realLaunchpad.observe(...args)) },
    { observe: (...args) => after('funding', realFunding.observe(...args)) },
    { rebuild: (mint) => after('i1', realParticipants.rebuild(mint)) },
    { rebuild: (mint) => after('i2', realGraph.rebuild(mint)) },
    { processObserved: (observed) => after('pumpswap', realMarket.processObserved(observed)) },
    () => 1_800_000_000_000,
  );
}

function worker(
  repository: PostgresTransactionInboxRepository,
  transaction: NormalizedTransaction,
  observedPipeline: ObservedTransactionPipeline,
  now = Date.now(),
  locatorExpected = true,
): TransactionInboxWorker {
  return new TransactionInboxWorker(repository, {
    async locate() {
      assert.equal(locatorExpected, true, 'durable restart must reuse the persisted snapshot');
      return transaction;
    },
  }, observedPipeline, {
    leaseSeconds: 120,
    renewalIntervalMs: 40_000,
    idlePollMs: 1_000,
    now: () => now,
  });
}

function pumpAdapter(): PumpFunLaunchpadAdapter {
  return new PumpFunLaunchpadAdapter(
    { read: () => Promise.reject(new Error('unused bonding curve read')) },
    (transaction) => {
      const decoded = decodePumpTransaction(transaction);
      const creation = decoded.creations[0];
      if (creation === undefined) throw new Error('Pump fixture creation missing');
      const migrationInstruction = transaction.instructions.find((instruction) =>
        instruction.programId === PUMP_PROGRAM_ID
        && instruction.instructionIndex === 5
        && instruction.innerInstructionIndex === null);
      if (migrationInstruction === undefined) throw new Error('Migration seam missing');
      const migration: DecodedPumpMigration = {
        action: {
          name: 'migrate_v2', family: 'MIGRATE', instruction: migrationInstruction,
          accounts: {}, args: {},
        },
        instruction: 'MIGRATE_V2',
        mint: creation.event.mint,
        bondingCurve: creation.event.bondingCurve,
        announcedPool: 'recovery-pool',
        baseTokenProgram: 'TOKEN_2022',
        quoteAsset: creation.quoteAsset,
      };
      return Object.freeze({
        ...decoded,
        migrations: Object.freeze([migration]),
      }) satisfies DecodedPumpTransaction;
    },
  );
}

function marketPipeline(
  pool: InstanceType<typeof pg.Pool>,
  pump: PumpFunLaunchpadAdapter,
): PumpSwapObservationPipeline {
  const canonical = canonicalPool();
  const market = new PumpSwapMarketAdapter(
    () => marketEvidence(),
    { validate: () => Promise.resolve(canonical) },
    { read: () => Promise.resolve({
      pool: canonical.address,
      baseReservesRaw: 10_000n,
      quoteVaultAmountRaw: 20_000n,
      virtualQuoteReservesRaw: 5_000n,
      effectiveQuoteReservesRaw: 25_000n,
      observedSlot: canonical.activatedAt.slot,
      observedAtMs: 1_800_000_000_000,
    }) },
    { quote: () => Promise.reject(new Error('unused market quote')) },
    () => undefined,
  );
  return new PumpSwapObservationPipeline(
    pump,
    market,
    new MarketObservationService(new PostgresMarketObservationRepository(pool, 4)),
    () => 1_800_000_000_000,
  );
}

function marketEvidence(): DecodedPumpSwapTransaction {
  const action = instruction(PUMPSWAP_PROGRAM_ID, 5, 0, 2);
  const creation: DecodedPumpSwapPoolCreation = {
    action: {
      name: 'create_pool', family: 'CREATE_POOL', instruction: action,
      accounts: {
        pool_base_token_account: 'recovery-base-vault',
        pool_quote_token_account: 'recovery-quote-vault',
        lp_mint: 'recovery-lp',
        base_token_program: TOKEN_2022_PROGRAM_ID.toBase58(),
        quote_token_program: TOKEN_PROGRAM_ID.toBase58(),
      },
      args: {},
    },
    event: {
      kind: 'CREATE_POOL', fields: {},
      instruction: instruction(PUMPSWAP_PROGRAM_ID, 5, 1, 3),
      trailingDataHex: '',
    },
    pool: 'recovery-pool', index: 0n, creator: 'recovery-creator',
    baseMint: '4i39ueoavjHaMwv6Lizq5LYjAi4xDqGDEnj7CmS3pump',
    quoteMint: 'So11111111111111111111111111111111111111112',
  };
  return Object.freeze({
    poolCreations: Object.freeze([creation]),
    trades: Object.freeze([]),
    issues: Object.freeze([]),
  });
}

function canonicalPool(): CanonicalMarketPool {
  return Object.freeze({
    address: 'recovery-pool', market: 'pumpswap', programId: PUMPSWAP_PROGRAM_ID,
    baseMint: '4i39ueoavjHaMwv6Lizq5LYjAi4xDqGDEnj7CmS3pump',
    quoteAsset: Object.freeze({
      mint: 'So11111111111111111111111111111111111111112',
      decimals: 9, tokenProgram: 'SPL_TOKEN',
    }),
    index: 0, creator: 'recovery-creator', baseVault: 'recovery-base-vault',
    quoteVault: 'recovery-quote-vault', lpMint: 'recovery-lp',
    baseTokenProgram: 'TOKEN_2022',
    activatedAt: Object.freeze({
      slot: 435_798_633n, transactionIndex: 946, instructionIndex: 5,
      innerInstructionIndex: 0,
    }),
    confirmationStatus: 'confirmed',
  });
}

function migrationTransaction(transaction: NormalizedTransaction): NormalizedTransaction {
  const balances = [...transaction.preTokenBalances, ...transaction.postTokenBalances];
  const accountCount = Math.max(...balances.map((balance) => balance.accountIndex)) + 1;
  const accountKeys = Array.from({ length: accountCount }, () => '11111111111111111111111111111111');
  accountKeys[0] = '3DQTxiyw5DaSLrQyd6837V61uobTkPbB4KFrqqbNo95F';
  for (const balance of balances) accountKeys[balance.accountIndex] = balance.account;
  return Object.freeze({
    ...transaction,
    accountKeys: Object.freeze(accountKeys),
    signerKeys: Object.freeze([accountKeys[0] as string]),
    instructions: Object.freeze([
      ...transaction.instructions,
      instruction(PUMP_PROGRAM_ID, 5, null, 1),
      instruction(PUMPSWAP_PROGRAM_ID, 5, 0, 2),
    ]),
    preBalancesLamports: Object.freeze(accountKeys.map(() => 0n)),
    postBalancesLamports: Object.freeze(accountKeys.map(() => 0n)),
  });
}

function instruction(
  programId: string,
  instructionIndex: number,
  innerInstructionIndex: number | null,
  stackHeight: number,
): NormalizedInstruction {
  return Object.freeze({
    programId, accounts: Object.freeze([]), data: new Uint8Array(), instructionIndex,
    innerInstructionIndex,
    parentInstructionIndex: innerInstructionIndex === null ? null : instructionIndex,
    stackHeight,
  });
}

async function productionCounts(pool: InstanceType<typeof pg.Pool>) {
  const result = await pool.query<{
    launches: string; trades: string; funding_assessments: string; creator_profiles: string;
    participant_snapshots: string; wallet_graph_profiles: string; wallet_graph_snapshots: string;
    migrations: string; market_pools: string; reserve_snapshots: string; paper_positions: string;
  }>(`SELECT
    (SELECT COUNT(*) FROM token_launches)::text AS launches,
    (SELECT COUNT(*) FROM launch_trades)::text AS trades,
    (SELECT COUNT(*) FROM wallet_funding_observations)::text AS funding_assessments,
    (SELECT COUNT(*) FROM creator_profiles)::text AS creator_profiles,
    (SELECT COUNT(*) FROM token_holders_snapshots)::text AS participant_snapshots,
    (SELECT COUNT(*) FROM wallet_graph_profiles)::text AS wallet_graph_profiles,
    (SELECT COUNT(*) FROM wallet_graph_snapshots)::text AS wallet_graph_snapshots,
    (SELECT COUNT(*) FROM migrations)::text AS migrations,
    (SELECT COUNT(*) FROM market_pools)::text AS market_pools,
    (SELECT COUNT(*) FROM market_reserve_snapshots)::text AS reserve_snapshots,
    (SELECT COUNT(*) FROM paper_positions)::text AS paper_positions`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('Production counts missing');
  return Object.freeze({
    launches: row.launches, trades: row.trades, fundingAssessments: row.funding_assessments,
    creatorProfiles: row.creator_profiles, participantSnapshots: row.participant_snapshots,
    walletGraphProfiles: row.wallet_graph_profiles, walletGraphSnapshots: row.wallet_graph_snapshots,
    migrations: row.migrations, marketPools: row.market_pools,
    reserveSnapshots: row.reserve_snapshots, paperPositions: row.paper_positions,
  });
}

async function inboxRow(pool: InstanceType<typeof pg.Pool>, signature: string): Promise<{
  processing_status: string; attempts: number; error_code: string | null;
  error_retryable: boolean | null; normalized_transaction: unknown;
  next_attempt_at: Date | null; processed_at: Date | null;
}> {
  const result = await pool.query<{
    processing_status: string; attempts: number; error_code: string | null;
    error_retryable: boolean | null; normalized_transaction: unknown;
    next_attempt_at: Date | null; processed_at: Date | null;
  }>(`SELECT processing_status, attempts, error_code,
    error_retryable, normalized_transaction, next_attempt_at, processed_at
    FROM chain_transaction_inbox WHERE signature = $1`, [signature]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('Inbox row missing');
  return row;
}

async function truncateRuntimeData(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  await pool.query(`TRUNCATE TABLE chain_transaction_inbox, raw_chain_events,
    token_launches, api_event_stream RESTART IDENTITY CASCADE`);
}

async function seedObservedLaunch(
  pool: InstanceType<typeof pg.Pool>,
  transaction: NormalizedTransaction,
): Promise<void> {
  const repository = new PostgresLaunchpadEventRepository(pool, 4);
  await new LaunchpadObservationService(pumpAdapter(), repository).observe(
    createSolanaObservedTransaction(transaction, 1_800_000_000_000),
    new Set<string>(),
  );
  const result = await pool.query(
    "UPDATE token_launches SET current_state = 'OBSERVING' WHERE current_state = 'DETECTED'",
  );
  assert.equal(result.rowCount, 1);
}

async function assertPaperSafety(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  const repository = new PostgresPaperTradingRepository(pool);
  await assert.rejects(
    new PaperTradingEngine({
      executionMode: 'observe', paperQuoteMintAllowlist: ['SOL'], dataRetentionHours: 4,
    }, repository).open({} as OpenPaperPositionCommand),
    hasCode('PAPER_MODE_DISABLED'),
  );
  const watchlisted = openCommand();
  await assert.rejects(
    new PaperTradingEngine({
      executionMode: 'paper', paperQuoteMintAllowlist: ['SOL'], dataRetentionHours: 4,
    }, repository).open({
      ...watchlisted,
      qualification: { ...watchlisted.qualification, verdict: 'WATCHLISTED' },
    }),
    hasCode('QUALIFICATION_NOT_ACCEPTED'),
  );
}

async function insertProcessed(
  pool: InstanceType<typeof pg.Pool>,
  signature: string,
  confirmationStatus: 'confirmed' | 'finalized' | 'orphaned',
  ageHours: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO chain_transaction_inbox (
       signature, observed_slot, discovery_sources, program_ids, target_confirmation_status,
       processing_status, normalized_transaction, immutable_fingerprint, observed_at, processed_at
     ) VALUES ($1, 1, ARRAY['WEBSOCKET'],
       ARRAY['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], $2, 'PROCESSED',
       '{}'::jsonb, $3, clock_timestamp() - ($4 * INTERVAL '1 hour'),
       clock_timestamp() - ($4 * INTERVAL '1 hour'))`,
    [signature, confirmationStatus, 'a'.repeat(64), ageHours],
  );
}

function openCommand(): OpenPaperPositionCommand {
  const qualification = new QualificationEngine(defaultQualificationRuleSet).evaluate({
    evaluatedAtMs: 1,
    signals: { imageValid: true, socialCrossLinkConfirmed: true, creatorHasNotSold: true },
    blockers: [],
  });
  return {
    mint: 'MINT', quoteAsset: { mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' },
    strategy: { id: 'recovery', version: 1 },
    trigger: {
      id: 'trigger', type: 'QualificationUpdated', mint: 'MINT', source: 'pumpfun',
      program: 'pump-program', signature: 'signature',
      cursor: { slot: 1n, transactionIndex: 0, instructionIndex: 0, innerInstructionIndex: null },
      confirmationStatus: 'confirmed', blockchainTimeMs: 1, observedAtMs: 1,
      payloadVersion: 1, payload: {},
    },
    qualification,
    buyQuote: quote('buy', 'SOL', 'MINT'),
    reverseSellQuote: quote('sell', 'MINT', 'SOL'),
    maximumRoundTripLossBps: 10_000n,
  };
}

function quote(id: string, inputMint: string, outputMint: string): PaperExecutionQuote {
  return {
    id, inputMint, outputMint, amountInRaw: 100n, amountOutRaw: 90n,
    minimumAmountOutRaw: 80n, feesRaw: 1n, slippageBps: 100n,
    priceImpactBps: 50n, observedAtMs: 1, observedSlot: 1n,
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function withDatabase(
  context: { skip(message?: string): void },
  run: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent: PostgreSQL recovery test skipped');
    return;
  }
  const schema = `transaction_recovery_${randomUUID().replaceAll('-', '')}`;
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

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
