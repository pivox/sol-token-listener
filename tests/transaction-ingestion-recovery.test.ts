import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { ObservedPipelineError, ObservedTransactionPipeline } from '../src/application/observed-transaction-pipeline.js';
import type { OpenPaperPositionCommand, PaperExecutionQuote } from '../src/domain/paper-trading.js';
import type { NormalizedTransaction } from '../src/solana/rpc/types.js';
import { PaperTradingEngine } from '../src/paper/paper-trading-engine.js';
import { QualificationEngine, defaultQualificationRuleSet } from '../src/qualification/qualification-engine.js';
import { migrateDatabase, purgeExpiredFoundationData } from '../src/storage/database.js';
import { PostgresPaperTradingRepository } from '../src/storage/paper-trading.repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const BOUNDARIES = Object.freeze(['launchpad', 'funding', 'i1', 'i2', 'pumpswap'] as const);
type Boundary = (typeof BOUNDARIES)[number];
const FULL_REPLAY = Object.freeze(['launchpad', 'funding', 'i1', 'i2', 'pumpswap']);

void test('restarts every observation boundary with full idempotent replay', async (context) => {
  await withDatabase(context, async (pool) => {
    await pool.query(`CREATE TABLE recovery_projection (
      kind TEXT NOT NULL,
      identity TEXT NOT NULL,
      PRIMARY KEY (kind, identity)
    )`);
    for (const boundary of BOUNDARIES) {
      await pool.query('TRUNCATE recovery_projection');
      await assert.rejects(
        recoveryPipeline(pool, boundary, []).process(transaction()),
        ObservedPipelineError,
      );
      const restartOrder: string[] = [];
      await recoveryPipeline(pool, null, restartOrder).process(transaction());
      assert.deepEqual(restartOrder, FULL_REPLAY, boundary);
      assert.deepEqual(await projectionCounts(pool), {
        launches: 1,
        trades: 1,
        fundingAssessments: 1,
        creatorProfiles: 1,
        walletGraphProfiles: 1,
      }, boundary);
    }

    const paperRepository = new PostgresPaperTradingRepository(pool);
    await assert.rejects(
      new PaperTradingEngine({
        executionMode: 'observe', paperQuoteMintAllowlist: ['SOL'], dataRetentionHours: 4,
      }, paperRepository).open({} as OpenPaperPositionCommand),
      hasCode('PAPER_MODE_DISABLED'),
    );
    const watchlisted = openCommand();
    await assert.rejects(
      new PaperTradingEngine({
        executionMode: 'paper', paperQuoteMintAllowlist: ['SOL'], dataRetentionHours: 4,
      }, paperRepository).open({
        ...watchlisted,
        qualification: { ...watchlisted.qualification, verdict: 'WATCHLISTED' },
      }),
      hasCode('QUALIFICATION_NOT_ACCEPTED'),
    );
    assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM paper_positions')).rows[0]?.count), 0);
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

function recoveryPipeline(
  pool: InstanceType<typeof pg.Pool>,
  failAt: Boundary | null,
  order: string[],
): ObservedTransactionPipeline {
  const write = async (kind: string): Promise<void> => {
    await pool.query(
      'INSERT INTO recovery_projection(kind, identity) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [kind, 'MintRecovery'],
    );
  };
  const stage = async (boundary: Boundary, kinds: readonly string[]): Promise<void> => {
    order.push(boundary);
    for (const kind of kinds) await write(kind);
    if (failAt === boundary) throw new Error('simulated restart boundary');
  };
  return new ObservedTransactionPipeline(
    {
      async listTrackedMints() { return new Set<string>(); },
      async listActiveEventsBySignature() { return Object.freeze([]); },
    },
    {
      async observe() {
        await stage('launchpad', ['launches', 'trades']);
        return Object.freeze({
          events: Object.freeze([]),
          affectedMints: Object.freeze(['MintRecovery']),
        });
      },
    },
    {
      async observe() {
        await stage('funding', ['fundingAssessments']);
        return Object.freeze({ assessments: Object.freeze([]), evidence: Object.freeze([]) });
      },
    },
    { async rebuild() { await stage('i1', ['creatorProfiles']); } },
    { async rebuild() { await stage('i2', ['walletGraphProfiles']); } },
    {
      async processObserved() {
        await stage('pumpswap', ['pumpswap']);
        return Object.freeze({ migrations: Object.freeze([]), activations: Object.freeze([]) });
      },
    },
    () => 1_700_000_000_000,
  );
}

async function projectionCounts(pool: InstanceType<typeof pg.Pool>): Promise<Record<string, number>> {
  const rows = (await pool.query<{ kind: string; count: string }>(
    `SELECT kind, COUNT(*) AS count FROM recovery_projection
     WHERE kind = ANY($1) GROUP BY kind`,
    [['launches', 'trades', 'fundingAssessments', 'creatorProfiles', 'walletGraphProfiles']],
  )).rows;
  return Object.fromEntries(rows.map((row) => [row.kind, Number(row.count)]));
}

function transaction(): NormalizedTransaction {
  return {
    signature: 'RecoverySignature', slot: 1n, transactionIndex: 0,
    confirmationStatus: 'CONFIRMED', version: 'legacy', blockTimeMs: 1,
    accountKeys: ['RecoveryAccount'], signerKeys: ['RecoveryAccount'], instructions: [],
    preTokenBalances: [], postTokenBalances: [], preBalancesLamports: [1n],
    postBalancesLamports: [1n], feeLamports: 0n, computeUnits: 1n, logs: [], error: null,
  };
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
