import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import pg from 'pg';
import { LaunchParticipantAnalyticsService } from '../src/application/launch-participant-analytics.service.js';
import { LaunchpadObservationService } from '../src/application/launchpad-observation.service.js';
import { MarketObservationService } from '../src/application/market-observation.service.js';
import { ObservedTransactionPipeline } from '../src/application/observed-transaction-pipeline.js';
import { FinalityReconciler } from '../src/application/finality-reconciler.js';
import { QualificationProjectionService } from '../src/application/qualification-projection.service.js';
import { QualificationRebuildService } from '../src/application/qualification-rebuild.service.js';
import { PersistentListenerHeartbeat } from '../src/application/production-listener-factory.js';
import { PumpSwapObservationPipeline } from '../src/application/pumpswap-observation-pipeline.js';
import { TransactionInboxWorker } from '../src/application/transaction-inbox-worker.js';
import { WalletEvidenceObservationService } from '../src/application/wallet-evidence-observation.service.js';
import { WalletGraphRebuildService } from '../src/application/wallet-graph-rebuild.service.js';
import type { CanonicalMarketPool } from '../src/domain/market.js';
import type { OpenPaperPositionCommand, PaperExecutionQuote } from '../src/domain/paper-trading.js';
import { PUMP_PROGRAM_ID } from '../src/launchpads/pumpfun/constants.js';
import { PumpFunLaunchpadAdapter } from '../src/launchpads/pumpfun/pumpfun-launchpad.adapter.js';
import { decodePumpTransaction } from '../src/launchpads/pumpfun/transaction-decoder.js';
import type {
  DecodedPumpMigration,
  DecodedPumpTrade,
  DecodedPumpTransaction,
} from '../src/launchpads/pumpfun/types.js';
import { PUMPSWAP_PROGRAM_ID } from '../src/markets/pumpswap/constants.js';
import { PumpSwapMarketAdapter } from '../src/markets/pumpswap/pumpswap-market.adapter.js';
import type {
  DecodedPumpSwapPoolCreation,
  DecodedPumpSwapTransaction,
} from '../src/markets/pumpswap/types.js';
import { PaperTradingEngine } from '../src/paper/paper-trading-engine.js';
import { createDefaultQualificationRuleSet, QualificationEngine } from '../src/qualification/qualification-engine.js';
import { SolanaWalletFundingEvidenceExtractor } from '../src/solana/wallet-funding-evidence-extractor.js';
import type { NormalizedInstruction, NormalizedTransaction } from '../src/solana/rpc/types.js';
import type { FinalityProviderPassSource } from '../src/ports/finality-provider-pass.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import { PostgresLaunchpadEventRepository } from '../src/storage/launchpad-event.repository.js';
import { PostgresApiProjectionRepository } from '../src/storage/api-projection.repository.js';
import { PostgresMarketObservationRepository } from '../src/storage/market-observation.repository.js';
import { PostgresPaperDecisionRepository } from '../src/storage/paper-decision.repository.js';
import { PostgresPaperTradingRepository } from '../src/storage/paper-trading.repository.js';
import { PostgresParticipantAnalyticsRepository } from '../src/storage/participant-analytics.repository.js';
import { PostgresQualificationProjectionRepository } from '../src/storage/qualification-projection.repository.js';
import { PostgresTransactionInboxRepository } from '../src/storage/transaction-inbox.repository.js';
import { PostgresWalletEvidenceRepository } from '../src/storage/wallet-evidence.repository.js';
import { PostgresWalletGraphRepository } from '../src/storage/wallet-graph.repository.js';
import { loadPumpFixture } from './helpers/pumpfun-fixture.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const EXTERNAL_BUYER = '8SBKzEQU4nLSzcwF4a74F2iaUDQyTfjGndn6qUWBnrpR';
const BOUNDARIES = Object.freeze([
  'launchpad', 'funding', 'i1', 'i2', 'pumpswap', 'qualification',
] as const);
type Boundary = (typeof BOUNDARIES)[number];
type ReplayStage = Boundary | 'paper';
const FULL_REPLAY: readonly ReplayStage[] = Object.freeze([...BOUNDARIES, 'paper']);

void test('restarts the production PostgreSQL path at every observation boundary', async (context) => {
  await withDatabase(context, async (pool) => {
    const fixture = await loadPumpFixture('create-v2-initial-buy-mainnet.json');
    const transaction = migrationTransaction(fixture.transaction);
    for (const boundary of BOUNDARIES) {
      await truncateRuntimeData(pool);
      assert.deepEqual(await productionCounts(pool), expectedCountsBefore(null), `${boundary}:before`);
      const repository = new PostgresTransactionInboxRepository(pool);
      await repository.enqueue(Object.freeze({
        signature: transaction.signature,
        slot: transaction.slot,
        source: 'WEBSOCKET' as const,
        programIds: Object.freeze([PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort()),
        confirmationStatus: 'confirmed' as const,
        observedAtMs: Date.now(),
      }));

      const firstOrder: ReplayStage[] = [];
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
      assert.deepEqual(
        await productionCounts(pool),
        expectedCountsBefore(boundary),
        `${boundary}:first-attempt`,
      );
      assert.equal(
        await launchState(pool),
        boundary === 'pumpswap' || boundary === 'qualification'
          ? 'PUMPSWAP_ACTIVE'
          : 'OBSERVING',
        `${boundary}:launch-state`,
      );

      const restartOrder: ReplayStage[] = [];
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
        launches: '1', trades: '3', fundingAssessments: '2', creatorProfiles: '1',
        participantSnapshots: '1', walletGraphProfiles: '1', walletGraphSnapshots: '1',
        migrations: '1', marketPools: '1', reserveSnapshots: '1', qualificationReports: '1',
        paperDecisionJobs: '1', paperPositions: '0', paperTrades: '0',
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
      assert.deepEqual(await verticalEvidence(pool), {
        creatorHasSold: true,
        relationships: '2',
        clusters: '1',
      });
      assert.deepEqual(await currentQualificationEvidence(pool), {
        verdict: 'REJECTED',
        creatorEarlySellTriggered: true,
      });

      await assertPaperSafety(pool);
      assert.equal((await productionCounts(pool)).paperPositions, '0', boundary);
      assert.equal((await productionCounts(pool)).paperTrades, '0', boundary);
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

    assert.equal(result.websocketHealthEvidence, 0);
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

void test('processes a compound confirmed-to-orphaned replay and preserves audit', async (context) => {
  await withDatabase(context, async (pool) => {
    const fixture = await loadPumpFixture('create-v2-initial-buy-mainnet.json');
    const confirmed = migrationTransaction(fixture.transaction);
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(Object.freeze({
      signature: confirmed.signature,
      slot: confirmed.slot,
      source: 'WEBSOCKET' as const,
      programIds: Object.freeze([PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort()),
      confirmationStatus: 'confirmed' as const,
      observedAtMs: Date.now(),
    }));
    assert.deepEqual(
      await worker(repository, confirmed, pipeline(pool, null, [])).runOnce(),
      { kind: 'processed', signature: confirmed.signature },
    );
    const beforeAudit = await auditCounts(pool);
    assert.deepEqual(await currentProjectionCounts(pool), {
      participantProfiles: '1', participantPositions: '2', graphProfiles: '1',
      graphRelationships: '2', graphClusters: '1', activeMarketPools: '1',
      currentQualifications: '1',
    });

    const orphanProof = await repository.recordFinalityPoll(Object.freeze({
      signature: confirmed.signature,
      confirmationStatus: null,
      providerId: 'primary' as const,
      expectedMissingFinalityPolls: 0,
      expectedLastMissingFinalityProviderId: null,
      expectedFinalityEvidenceVersion: 0n,
      observedAtMs: Date.now() + 1,
    }));
    assert.ok(orphanProof.lastMissingFinalityProviderId);
    await repository.enqueueRevision(Object.freeze({
      signature: confirmed.signature,
      confirmationStatus: 'orphaned' as const,
      expectedConfirmationStatus: orphanProof.confirmationStatus,
      expectedMissingFinalityPolls: orphanProof.missingFinalityPolls,
      expectedLastMissingFinalityProviderId: orphanProof.lastMissingFinalityProviderId,
      expectedFinalityEvidenceVersion: orphanProof.finalityEvidenceVersion,
      observedAtMs: Date.now() + 2,
    }));
    const orphanOrder: ReplayStage[] = [];
    const orphaned = Object.freeze({ ...confirmed, confirmationStatus: 'ORPHANED' as const });
    const orphanResult = await worker(
      repository, orphaned, pipeline(pool, null, orphanOrder), Date.now() + 2, false,
    ).runOnce();
    assert.deepEqual(
      orphanResult,
      { kind: 'processed', signature: confirmed.signature },
      `orphan stages completed: ${orphanOrder.join(',')}`,
    );
    assert.deepEqual(orphanOrder, FULL_REPLAY);
    assert.deepEqual(await currentProjectionCounts(pool), {
      participantProfiles: '0', participantPositions: '0', graphProfiles: '0',
      graphRelationships: '0', graphClusters: '0', activeMarketPools: '0',
      currentQualifications: '0',
    });
    assert.deepEqual(await auditCounts(pool), beforeAudit);
    const states = (await pool.query(`SELECT
      (SELECT current_state FROM token_launches LIMIT 1) AS launch_state,
      (SELECT confirmation_status FROM wallet_funding_observations LIMIT 1) AS funding_status,
      (SELECT pool_state FROM market_pools LIMIT 1) AS pool_state,
      (SELECT confirmation_status FROM market_pools LIMIT 1) AS pool_confirmation,
      (SELECT COUNT(*)::text FROM token_holders_snapshots) AS participant_snapshots,
      (SELECT COUNT(*)::text FROM wallet_graph_snapshots) AS graph_snapshots`)).rows[0];
    assert.deepEqual(states, {
      launch_state: 'RETRACTED', funding_status: 'confirmed', pool_state: 'retracted',
      pool_confirmation: 'orphaned', participant_snapshots: '1', graph_snapshots: '1',
    });
    assert.deepEqual(await repository.counts(), {
      pending: 0, processing: 0, processed: 1, failed: 0,
      retryableFailed: 0, exhaustedFailed: 0,
    });

    const replayOrder: ReplayStage[] = [];
    await pipeline(pool, null, replayOrder).process(orphaned);
    assert.deepEqual(replayOrder, FULL_REPLAY);
    assert.deepEqual(await auditCounts(pool), beforeAudit);
    assert.deepEqual(await currentProjectionCounts(pool), {
      participantProfiles: '0', participantPositions: '0', graphProfiles: '0',
      graphRelationships: '0', graphClusters: '0', activeMarketPools: '0',
      currentQualifications: '0',
    });
  });
});

void test('resets missing finality evidence after a restart on fallback before accepting its fresh orphan proof', async (context) => {
  await withDatabase(context, async (pool) => {
    const fixture = await loadPumpFixture('create-v2-initial-buy-mainnet.json');
    const transaction = migrationTransaction(fixture.transaction);
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(Object.freeze({
      signature: transaction.signature,
      slot: transaction.slot,
      source: 'WEBSOCKET' as const,
      programIds: Object.freeze([PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort()),
      confirmationStatus: 'confirmed' as const,
      observedAtMs: 1_000,
    }));
    assert.deepEqual(
      await worker(repository, transaction, pipeline(pool, null, [])).runOnce(),
      { kind: 'processed', signature: transaction.signature },
    );

    const primary = new FinalityReconciler(
      missingFinalityPass('primary', transaction.slot).source, repository,
      { limit: 1, missingPollThreshold: 3, now: () => 2_000 },
    );
    await primary.runOnce();
    await primary.runOnce();
    assert.deepEqual(await finalityEvidence(pool, transaction.signature), {
      missingPolls: 2, providerId: 'primary', confirmationStatus: 'confirmed',
      processingStatus: 'PROCESSED',
    });

    const fallback = missingFinalityPass('fallback-1', transaction.slot);
    const restartedFallback = new FinalityReconciler(
      fallback.source, repository,
      { limit: 1, missingPollThreshold: 3, now: () => 3_000 },
    );
    await restartedFallback.runOnce();
    assert.deepEqual(await finalityEvidence(pool, transaction.signature), {
      missingPolls: 1, providerId: 'fallback-1', confirmationStatus: 'confirmed',
      processingStatus: 'PROCESSED',
    });

    await restartedFallback.runOnce();
    await restartedFallback.runOnce();
    assert.deepEqual(await finalityEvidence(pool, transaction.signature), {
      missingPolls: 0, providerId: null, confirmationStatus: 'orphaned',
      processingStatus: 'PENDING',
    });
    assert.deepEqual(fallback.blockProofs, [
      Object.freeze({ providerId: 'fallback-1', slot: transaction.slot }),
    ]);
  });
});

void test('exposes a real retryable failed inbox row through persisted API health', async (context) => {
  await withDatabase(context, async (pool) => {
    const repository = new PostgresTransactionInboxRepository(pool);
    await repository.enqueue(Object.freeze({
      signature: 'retryable-health', slot: 1n, source: 'WEBSOCKET' as const,
      programIds: Object.freeze([PUMP_PROGRAM_ID]), confirmationStatus: 'confirmed' as const,
      observedAtMs: Date.now(),
    }));
    const claim = await repository.claim(Date.now() + 1, 120);
    assert.ok(claim);
    await repository.markFailed(claim.signature, claim.leaseToken, Object.freeze({
      code: 'RPC_TRANSIENT', errorName: 'RpcError', retryable: true,
    }));
    const heartbeat = new PersistentListenerHeartbeat(
      repository,
      { async getSlot() { return 10n; }, async getFinalizedSlot() { return 9n; } },
      () => 'RUNNING', () => 'RUNNING', () => 'RUNNING', () => 'RUNNING',
      { intervalMs: 60_000, shutdownTimeoutMs: 1_000,
        scheduler: { schedule: () => 1, cancel: () => undefined } },
    );
    await heartbeat.start();
    const health = await new PostgresApiProjectionRepository(
      pool,
      () => new Date(),
      { httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'RUNNING', qualification: 'RUNNING', paperDecision: 'RUNNING', social: 'RUNNING' },
    ).getHealth();
    assert.equal(health.heartbeat.backlogCount, 1);
    assert.equal(health.heartbeat.leasedCount, 0);
    assert.equal(health.heartbeat.pendingTransactions, 1);
    assert.notDeepEqual({ status: health.status, backlog: health.heartbeat.backlogCount }, {
      status: 'OK', backlog: 0,
    });
    await heartbeat.stop();
  });
});

void test('counts only qualification reports with canonical active lineage in PostgreSQL health', async (context) => {
  await withDatabase(context, async (pool) => {
    const fixture = await loadPumpFixture('create-v2-initial-buy-mainnet.json');
    const transaction = migrationTransaction(fixture.transaction);
    const inbox = new PostgresTransactionInboxRepository(pool);
    await inbox.enqueue(Object.freeze({
      signature: transaction.signature,
      slot: transaction.slot,
      source: 'WEBSOCKET' as const,
      programIds: Object.freeze([PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID].sort()),
      confirmationStatus: 'confirmed' as const,
      observedAtMs: Date.now(),
    }));
    assert.deepEqual(await worker(inbox, transaction, pipeline(pool, null, [])).runOnce(), {
      kind: 'processed', signature: transaction.signature,
    });
    const health = async () => new PostgresApiProjectionRepository(pool, () => new Date(), {
      httpAvailable: true, pumpfun: 'RUNNING', pumpswap: 'RUNNING', qualification: 'RUNNING',
      paperDecision: 'RUNNING', social: 'RUNNING',
    }).getHealth();
    assert.equal((await health()).qualification.currentCount, 1);
    const lineage = (await pool.query(`SELECT qualification.event_id, qualification.source,
      qualification.program, qualification.signature, qualification.slot,
      qualification.transaction_index, qualification.instruction_index,
      qualification.inner_instruction_index
      FROM qualification_reports AS report
      JOIN domain_events AS qualification ON qualification.event_id = report.qualification_event_id`)).rows[0];
    assert.ok(lineage);
    for (const [column, invalidValue] of [
      ['source', 'invalid-source'],
      ['program', 'invalid-program'],
      ['signature', 'invalid-signature'],
      ['slot', '999999999999999999999999999999'],
    ] as const) {
      await pool.query(`UPDATE domain_events SET ${column} = $1 WHERE event_id = $2`, [
        invalidValue, lineage.event_id,
      ]);
      assert.equal((await health()).qualification.currentCount, 0, column);
      await pool.query(`UPDATE domain_events SET ${column} = $1 WHERE event_id = $2`, [
        lineage[column], lineage.event_id,
      ]);
      assert.equal((await health()).qualification.currentCount, 1, `${column}:restored`);
    }
  });
});

function pipeline(
  pool: InstanceType<typeof pg.Pool>,
  failAt: Boundary | null,
  order: ReplayStage[],
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
  const qualificationEngine = new QualificationEngine(createDefaultQualificationRuleSet(60));
  const qualificationRebuilder = new QualificationRebuildService(qualificationEngine);
  const realQualification = new QualificationProjectionService(
    new PostgresQualificationProjectionRepository(pool, qualificationRebuilder),
    qualificationRebuilder,
    ['So11111111111111111111111111111111111111112'],
  );
  const paperDecisions = new PostgresPaperDecisionRepository(pool, {
    maxAttempts: 5,
    baseDelayMs: 500,
    retentionHours: 4,
    clock: () => 1_800_000_000_000,
  }, qualificationEngine.profileSummary);
  const after = async <T>(boundary: ReplayStage, operation: Promise<T>): Promise<T> => {
    const result = await operation;
    order.push(boundary);
    if (failAt === boundary) throw new Error(`restart after ${boundary}`);
    return result;
  };
  return new ObservedTransactionPipeline(
    launchpadRepository,
    { observe: (...args) => after('launchpad', realLaunchpad.observe(...args).then(async (result) => {
      await pool.query(
        "UPDATE token_launches SET current_state = 'OBSERVING' WHERE current_state = 'DETECTED'",
      );
      return result;
    })) },
    { observe: (...args) => after('funding', realFunding.observe(...args)) },
    { rebuild: (mint, policy) => after('i1', realParticipants.rebuild(mint, policy)) },
    { rebuild: (mint, policy) => after('i2', realGraph.rebuild(mint, policy)) },
    { processObserved: (observed) => after('pumpswap', realMarket.processObserved(observed)) },
    () => 1_800_000_000_000,
    {
      enqueueLatest: (...args) => after('paper', paperDecisions.enqueueLatest(...args)),
    },
    { rebuild: (mint, policy) => after('qualification', realQualification.rebuild(mint, policy)) },
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
      const decoded = decodePumpTransaction(Object.freeze({
        ...transaction,
        instructions: Object.freeze(transaction.instructions.filter((item) => (
          item.instructionIndex !== 6 && item.instructionIndex !== 7
        ))),
      }));
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
        trades: Object.freeze([
          ...decoded.trades,
          ...verticalSliceTrades(decoded),
        ]),
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
    { validate: (_creation, transaction) => Promise.resolve(Object.freeze({
      ...canonical,
      confirmationStatus: transaction.confirmationStatus,
    })) },
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

function verticalSliceTrades(decoded: DecodedPumpTransaction): readonly DecodedPumpTrade[] {
  const creation = decoded.creations[0];
  const initialBuy = decoded.trades[0];
  if (creation === undefined || initialBuy === undefined) {
    throw new Error('Pump fixture vertical slice evidence missing');
  }
  const creatorSellInstruction = cloneInstruction(initialBuy.action.instruction, 6);
  const creatorSellEvent = Object.freeze({
    ...initialBuy.event,
    isBuy: false,
    user: creation.event.creator,
    ixName: 'sell_v2',
  });
  const creatorSell: DecodedPumpTrade = Object.freeze({
    ...initialBuy,
    action: Object.freeze({
      ...initialBuy.action,
      name: 'sell_v2',
      family: 'SELL',
      instruction: creatorSellInstruction,
    }),
    event: creatorSellEvent,
    eventCpi: Object.freeze({
      ...initialBuy.eventCpi,
      event: creatorSellEvent,
      instruction: cloneInstruction(initialBuy.eventCpi.instruction, 6),
    }),
  });
  const externalBuyInstruction = cloneInstruction(
    initialBuy.action.instruction,
    7,
    EXTERNAL_BUYER,
  );
  const externalBuyEvent = Object.freeze({
    ...initialBuy.event,
    user: EXTERNAL_BUYER,
  });
  const externalBuy: DecodedPumpTrade = Object.freeze({
    ...initialBuy,
    action: Object.freeze({
      ...initialBuy.action,
      instruction: externalBuyInstruction,
      accounts: Object.freeze({
        ...initialBuy.action.accounts,
        user: EXTERNAL_BUYER,
      }),
    }),
    event: externalBuyEvent,
    eventCpi: Object.freeze({
      ...initialBuy.eventCpi,
      event: externalBuyEvent,
      instruction: cloneInstruction(initialBuy.eventCpi.instruction, 7),
    }),
  });
  return Object.freeze([creatorSell, externalBuy]);
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
  const decoded = decodePumpTransaction(transaction);
  const initialBuy = decoded.trades[0];
  if (initialBuy === undefined) throw new Error('Pump fixture initial buy missing');
  const balances = [...transaction.preTokenBalances, ...transaction.postTokenBalances];
  const accountCount = Math.max(...balances.map((balance) => balance.accountIndex)) + 1;
  const accountKeys = Array.from({ length: accountCount }, () => '11111111111111111111111111111111');
  accountKeys[0] = '3DQTxiyw5DaSLrQyd6837V61uobTkPbB4KFrqqbNo95F';
  for (const balance of balances) accountKeys[balance.accountIndex] = balance.account;
  return Object.freeze({
    ...transaction,
    confirmationStatus: 'CONFIRMED' as const,
    accountKeys: Object.freeze(accountKeys),
    signerKeys: Object.freeze([accountKeys[0] as string]),
    instructions: Object.freeze([
      ...transaction.instructions,
      instruction(PUMP_PROGRAM_ID, 5, null, 1),
      instruction(PUMPSWAP_PROGRAM_ID, 5, 0, 2),
      cloneInstruction(initialBuy.action.instruction, 6),
      cloneInstruction(initialBuy.action.instruction, 7, EXTERNAL_BUYER),
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

function cloneInstruction(
  source: NormalizedInstruction,
  instructionIndex: number,
  replacementUser?: string,
): NormalizedInstruction {
  const accounts = [...source.accounts];
  if (replacementUser !== undefined) {
    const userIndex = 13;
    if (accounts[userIndex] === undefined) throw new Error('Pump buy user account missing');
    accounts[userIndex] = replacementUser;
  }
  return Object.freeze({
    ...source,
    accounts: Object.freeze(accounts),
    instructionIndex,
    innerInstructionIndex: null,
    parentInstructionIndex: null,
  });
}

async function productionCounts(pool: InstanceType<typeof pg.Pool>) {
  const result = await pool.query<{
    launches: string; trades: string; funding_assessments: string; creator_profiles: string;
    participant_snapshots: string; wallet_graph_profiles: string; wallet_graph_snapshots: string;
    migrations: string; market_pools: string; reserve_snapshots: string;
    qualification_reports: string; paper_decision_jobs: string; paper_positions: string;
    paper_trades: string;
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
    (SELECT COUNT(*) FROM qualification_reports)::text AS qualification_reports,
    (SELECT COUNT(*) FROM paper_decision_jobs)::text AS paper_decision_jobs,
    (SELECT COUNT(*) FROM paper_positions)::text AS paper_positions,
    (SELECT COUNT(*) FROM paper_trades)::text AS paper_trades`);
  const row = result.rows[0];
  if (row === undefined) throw new Error('Production counts missing');
  return Object.freeze({
    launches: row.launches, trades: row.trades, fundingAssessments: row.funding_assessments,
    creatorProfiles: row.creator_profiles, participantSnapshots: row.participant_snapshots,
    walletGraphProfiles: row.wallet_graph_profiles, walletGraphSnapshots: row.wallet_graph_snapshots,
    migrations: row.migrations, marketPools: row.market_pools,
    reserveSnapshots: row.reserve_snapshots, qualificationReports: row.qualification_reports,
    paperDecisionJobs: row.paper_decision_jobs, paperPositions: row.paper_positions,
    paperTrades: row.paper_trades,
  });
}

async function currentProjectionCounts(pool: InstanceType<typeof pg.Pool>) {
  return (await pool.query<{
    participantProfiles: string; participantPositions: string; graphProfiles: string;
    graphRelationships: string; graphClusters: string; activeMarketPools: string;
    currentQualifications: string;
  }>(`SELECT
    (SELECT COUNT(*)::text FROM creator_profiles) AS "participantProfiles",
    (SELECT COUNT(*)::text FROM observed_wallet_positions) AS "participantPositions",
    (SELECT COUNT(*)::text FROM wallet_graph_profiles) AS "graphProfiles",
    (SELECT COUNT(*)::text FROM wallet_relationships) AS "graphRelationships",
    (SELECT COUNT(*)::text FROM wallet_clusters) AS "graphClusters",
    (SELECT COUNT(*)::text FROM market_pools
      WHERE pool_state = 'active' AND confirmation_status <> 'orphaned') AS "activeMarketPools",
    (SELECT COUNT(*)::text FROM qualification_reports
      WHERE superseded_at IS NULL) AS "currentQualifications"`))
    .rows[0];
}

async function auditCounts(pool: InstanceType<typeof pg.Pool>) {
  return (await pool.query<{
    rawChainEvents: string; domainEvents: string; participantSnapshots: string;
    graphSnapshots: string; reserveSnapshots: string;
  }>(`SELECT
    (SELECT COUNT(*)::text FROM raw_chain_events) AS "rawChainEvents",
    (SELECT COUNT(*)::text FROM domain_events) AS "domainEvents",
    (SELECT COUNT(*)::text FROM token_holders_snapshots) AS "participantSnapshots",
    (SELECT COUNT(*)::text FROM wallet_graph_snapshots) AS "graphSnapshots",
    (SELECT COUNT(*)::text FROM market_reserve_snapshots) AS "reserveSnapshots"`)).rows[0];
}

function expectedCountsBefore(boundary: Boundary | null) {
  const completed = boundary === null ? -1 : BOUNDARIES.indexOf(boundary);
  return Object.freeze({
    launches: completed >= 0 ? '1' : '0',
    trades: completed >= 0 ? '3' : '0',
    fundingAssessments: completed >= 1 ? '2' : '0',
    creatorProfiles: completed >= 2 ? '1' : '0',
    participantSnapshots: completed >= 2 ? '1' : '0',
    walletGraphProfiles: completed >= 3 ? '1' : '0',
    walletGraphSnapshots: completed >= 3 ? '1' : '0',
    migrations: completed >= 4 ? '1' : '0',
    marketPools: completed >= 4 ? '1' : '0',
    reserveSnapshots: completed >= 4 ? '1' : '0',
    qualificationReports: completed >= 5 ? '1' : '0',
    paperDecisionJobs: '0', paperPositions: '0', paperTrades: '0',
  });
}

async function verticalEvidence(pool: InstanceType<typeof pg.Pool>): Promise<{
  readonly creatorHasSold: boolean;
  readonly relationships: string;
  readonly clusters: string;
}> {
  const row = (await pool.query<{
    creator_has_sold: boolean;
    relationships: string;
    clusters: string;
  }>(`SELECT
    (SELECT has_sold FROM creator_profiles LIMIT 1) AS creator_has_sold,
    (SELECT COUNT(*)::text FROM wallet_relationships) AS relationships,
    (SELECT COUNT(*)::text FROM wallet_clusters) AS clusters`)).rows[0];
  if (row === undefined) throw new Error('Vertical evidence missing');
  return Object.freeze({
    creatorHasSold: row.creator_has_sold,
    relationships: row.relationships,
    clusters: row.clusters,
  });
}

async function currentQualificationEvidence(pool: InstanceType<typeof pg.Pool>): Promise<{
  readonly verdict: string;
  readonly creatorEarlySellTriggered: boolean;
}> {
  const row = (await pool.query<{
    verdict: string;
    creator_early_sell_triggered: boolean;
  }>(`SELECT report.verdict,
      EXISTS (
        SELECT 1 FROM jsonb_array_elements(report.payload->'conditions') AS condition
        WHERE condition->>'code' = 'CREATOR_EARLY_SELL'
          AND condition->>'status' = 'TRIGGERED'
      ) AS creator_early_sell_triggered
    FROM qualification_reports AS report
    WHERE report.superseded_at IS NULL`)).rows[0];
  if (row === undefined) throw new Error('Current qualification evidence missing');
  return Object.freeze({
    verdict: row.verdict,
    creatorEarlySellTriggered: row.creator_early_sell_triggered,
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

function missingFinalityPass(
  providerId: 'primary' | 'fallback-1',
  slot: bigint,
): Readonly<{
  readonly source: FinalityProviderPassSource;
  readonly blockProofs: readonly Readonly<{ readonly providerId: string; readonly slot: bigint }>[];
}> {
  const blockProofs: Readonly<{ readonly providerId: string; readonly slot: bigint }>[] = [];
  return Object.freeze({
    source: Object.freeze({
      openPass: () => Object.freeze({
        providerId,
        async getHistoryStatuses() { return [null]; },
        async getFinalizedSlot() { return slot + 1n; },
        async getFinalizedBlockSignatures(proofSlot: bigint) {
          blockProofs.push(Object.freeze({ providerId, slot: proofSlot }));
          return [];
        },
      }),
    }),
    blockProofs,
  });
}

async function finalityEvidence(
  pool: InstanceType<typeof pg.Pool>,
  signature: string,
): Promise<{
  readonly missingPolls: number;
  readonly providerId: string | null;
  readonly confirmationStatus: string;
  readonly processingStatus: string;
}> {
  const row = (await pool.query<{
    missing_finality_polls: number;
    last_missing_finality_provider_id: string | null;
    target_confirmation_status: string;
    processing_status: string;
  }>(`SELECT missing_finality_polls, last_missing_finality_provider_id,
      target_confirmation_status, processing_status
    FROM chain_transaction_inbox WHERE signature = $1`, [signature])).rows[0];
  if (row === undefined) throw new Error('Finality evidence row missing');
  return Object.freeze({
    missingPolls: row.missing_finality_polls,
    providerId: row.last_missing_finality_provider_id,
    confirmationStatus: row.target_confirmation_status,
    processingStatus: row.processing_status,
  });
}

async function truncateRuntimeData(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  await pool.query(`TRUNCATE TABLE chain_transaction_inbox, raw_chain_events,
    token_launches, api_event_stream RESTART IDENTITY CASCADE`);
}

async function launchState(pool: InstanceType<typeof pg.Pool>): Promise<string | null> {
  const result = await pool.query<{ current_state: string }>(
    'SELECT current_state FROM token_launches',
  );
  return result.rows[0]?.current_state ?? null;
}

async function assertPaperSafety(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  const repository = new PostgresPaperTradingRepository(pool);
  const profile = createDefaultQualificationRuleSet(60);
  const authority = new QualificationEngine(profile);
  await assert.rejects(
    new PaperTradingEngine({
      executionMode: 'observe', paperQuoteMintAllowlist: ['SOL'], dataRetentionHours: 4,
    }, repository, profile, authority).open({} as OpenPaperPositionCommand),
    hasCode('PAPER_MODE_DISABLED'),
  );
  const watchlisted = openCommand(authority, false);
  await assert.rejects(
    new PaperTradingEngine({
      executionMode: 'paper', paperQuoteMintAllowlist: ['SOL'], dataRetentionHours: 4,
    }, repository, profile, authority).open(watchlisted),
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
  if (confirmationStatus === 'finalized') {
    await pool.query(`INSERT INTO chain_transaction_finality_replay_receipts (
      signature,observed_slot,confirmation_status,finality_evidence_version,
      immutable_fingerprint,replay_completed_at
    ) SELECT signature,observed_slot,target_confirmation_status,finality_evidence_version,
      immutable_fingerprint,processed_at FROM chain_transaction_inbox
      WHERE signature=$1`,[signature]);
  }
}

function openCommand(
  authority: QualificationEngine,
  imageValid = true,
): OpenPaperPositionCommand {
  const triggerEvent = {
    id: 'trigger', type: 'QualificationUpdated' as const, mint: 'MINT', source: 'pumpfun',
    program: 'pump-program', signature: 'signature',
    cursor: { slot: 1n, transactionIndex: 0, instructionIndex: 0, innerInstructionIndex: null },
    confirmationStatus: 'confirmed' as const, blockchainTimeMs: 1, observedAtMs: 1,
    payloadVersion: 1, payload: {},
  };
  const qualification = authority.evaluateAuthorized({
    mint: 'MINT',
    triggerEventId: triggerEvent.id,
  }, {
    evaluatedAtMs: 1,
    signals: { imageValid, socialCrossLinkConfirmed: true, creatorHasNotSold: true },
    blockers: [],
    calibrationFacts: Object.freeze({
      top1HolderBps: null,
      top5HoldersBps: null,
      top10HoldersBps: null,
      maximumRelatedClusterBps: null,
      maximumSharedFunderCount: null,
      buySimulationSucceeded: true,
      sellQuoteAvailable: true,
      roundTripLossBps: 2_000n,
      upstreamConditions: Object.freeze([]),
    }),
  });
  return {
    mint: 'MINT', quoteAsset: { mint: 'SOL', decimals: 9, tokenProgram: 'SPL_TOKEN' },
    strategy: { id: 'recovery', version: 1 },
    trigger: triggerEvent,
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
