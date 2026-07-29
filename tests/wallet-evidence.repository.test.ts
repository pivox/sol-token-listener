import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {
  createWalletFundingAssessmentId,
  createWalletFundingEvidenceId,
  WALLET_FUNDING_PAYLOAD_VERSION,
  type DirectQuoteTransferEvidence,
  type WalletFundingAssessment,
  type WalletFundingBuy,
} from '../src/domain/wallet-funding.js';
import type {
  ChainConfirmationStatus,
} from '../src/domain/types.js';
import type {
  WalletEvidenceBatch,
} from '../src/ports/wallet-evidence-repository.js';
import {
  PostgresWalletEvidenceRepository,
  WalletEvidenceLaunchNotFoundError,
  WalletEvidencePersistenceError,
} from '../src/storage/wallet-evidence.repository.js';
import {
  migrateDatabase,
} from '../src/storage/database.js';

void test('records assessments and evidence atomically in canonical order', async () => {
  const pool = new RecordingPool();
  const repository = new PostgresWalletEvidenceRepository(pool);

  await repository.record(directBatch('processed'));

  assert.deepEqual(pool.queries.slice(0, 2), [
    'BEGIN',
    pool.queries[1],
  ]);
  assert.match(pool.queries[1] ?? '', /wallet_funding_observations.*FOR UPDATE/su);
  assert.equal(pool.queries.some((query) =>
    query.includes('INSERT INTO wallet_funding_observations')), true);
  assert.equal(pool.queries.some((query) =>
    query.includes('INSERT INTO wallet_funding_evidence')), true);
  assert.deepEqual(pool.queries.slice(-1), ['COMMIT']);
  assert.equal(pool.released, true);
});

void test('rolls back and releases when an evidence statement fails', async () => {
  const pool = new RecordingPool('wallet_funding_evidence');
  const repository = new PostgresWalletEvidenceRepository(pool);

  await assert.rejects(
    repository.record(directBatch('processed')),
    (error) =>
      error instanceof WalletEvidencePersistenceError
      && error.cause instanceof Error
      && error.cause.message === 'forced repository failure',
  );

  assert.deepEqual(pool.queries.slice(-1), ['ROLLBACK']);
  assert.equal(pool.released, true);
});

void test('rolls back when the launch required by an assessment is absent', async () => {
  const pool = new RecordingPool(null, true);
  const repository = new PostgresWalletEvidenceRepository(pool);

  await assert.rejects(
    repository.record(noEvidenceBatch('processed')),
    (error) =>
      error instanceof WalletEvidencePersistenceError
      && error.cause instanceof WalletEvidenceLaunchNotFoundError,
  );

  assert.deepEqual(pool.queries.slice(-1), ['ROLLBACK']);
  assert.equal(pool.released, true);
});

void test('replays, advances finality, rejects contradictions and persists no-evidence coverage', async (context) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    context.skip('TEST_DATABASE_URL absent : test PostgreSQL live ignoré');
    return;
  }
  const schema = `wallet_evidence_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^[a-z_][a-z0-9_]*$/u);
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await migrateDatabase({ pool });
    await insertLaunch(pool);
    const repository = new PostgresWalletEvidenceRepository(pool);

    await repository.record(directBatch('processed'));
    await repository.record(directBatch('processed'));
    assert.deepEqual(await counts(pool), ['1', '1']);

    await repository.record(directBatch('confirmed'));
    assert.equal(await storedConfirmation(pool, 'wallet_funding_observations'), 'confirmed');
    assert.equal(await storedConfirmation(pool, 'wallet_funding_evidence'), 'confirmed');

    const changedAmount = directBatch('confirmed', 999n);
    await assert.rejects(
      repository.record(changedAmount),
      (error) =>
        error instanceof WalletEvidencePersistenceError
        && error.cause instanceof Error
        && error.cause.message.includes('immutable'),
    );
    assert.deepEqual(await counts(pool), ['1', '1']);

    await repository.record(directBatch('finalized'));
    await assert.rejects(
      repository.record(directBatch('orphaned')),
      (error) =>
        error instanceof WalletEvidencePersistenceError
        && error.cause instanceof Error
        && error.cause.name === 'ConfirmationStatusConflictError',
    );
    assert.equal(await storedConfirmation(pool, 'wallet_funding_observations'), 'finalized');

    await repository.record(noEvidenceBatch('processed'));
    await repository.record(noEvidenceBatch('orphaned'));
    assert.deepEqual(await counts(pool), ['2', '1']);
    assert.equal(
      await storedConfirmation(
        pool,
        'wallet_funding_observations',
        'no-evidence-trade',
      ),
      'orphaned',
    );
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
});

class RecordingPool {
  public readonly queries: string[] = [];
  public released = false;

  public constructor(
    private readonly failOn: string | null = null,
    private readonly missingLaunch = false,
  ) {}

  public async connect() {
    return {
      query: async (text: string) => {
        this.queries.push(text);
        if (this.failOn !== null && text.includes(`INSERT INTO ${this.failOn}`)) {
          throw new Error('forced repository failure');
        }
        if (text.includes('FOR UPDATE')) {
          return { rows: [], rowCount: 0 };
        }
        if (
          this.missingLaunch
          && text.includes('INSERT INTO wallet_funding_observations')
        ) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      },
      release: () => { this.released = true; },
    };
  }
}

function directBatch(
  confirmationStatus: ChainConfirmationStatus,
  amountRaw = 100n,
): WalletEvidenceBatch {
  const buy = fundingBuy('direct-trade', confirmationStatus);
  const evidenceWithoutId: DirectQuoteTransferEvidence = Object.freeze({
    id: '',
    type: 'DIRECT_QUOTE_TRANSFER',
    confidence: 'STRONG',
    mint: buy.mint,
    buyer: buy.buyer,
    funder: 'funder',
    quoteAsset: buy.quoteAsset,
    amountRaw,
    source: buy.source,
    program: buy.program,
    signature: buy.signature,
    transferCursor: Object.freeze({
      ...buy.cursor,
      instructionIndex: buy.cursor.instructionIndex - 1,
    }),
    buyEventId: buy.eventId,
    buyTradeId: buy.tradeId,
    buyCursor: buy.cursor,
    confirmationStatus,
    blockchainTimeMs: buy.blockchainTimeMs,
    observedAtMs: buy.observedAtMs,
    payloadVersion: WALLET_FUNDING_PAYLOAD_VERSION,
  });
  const evidence = Object.freeze({
    ...evidenceWithoutId,
    id: createWalletFundingEvidenceId(evidenceWithoutId),
  });
  const assessment = assessmentFor(buy, 'STRONG', 1);
  return Object.freeze({
    signature: buy.signature,
    confirmationStatus,
    assessments: Object.freeze([assessment]),
    evidence: Object.freeze([evidence]),
  });
}

function noEvidenceBatch(
  confirmationStatus: ChainConfirmationStatus,
): WalletEvidenceBatch {
  const buy = fundingBuy('no-evidence-trade', confirmationStatus, 4);
  return Object.freeze({
    signature: buy.signature,
    confirmationStatus,
    assessments: Object.freeze([
      assessmentFor(buy, 'NO_EVIDENCE', 0),
    ]),
    evidence: Object.freeze([]),
  });
}

function assessmentFor(
  buy: WalletFundingBuy,
  status: WalletFundingAssessment['status'],
  acceptedEvidenceCount: number,
): WalletFundingAssessment {
  return Object.freeze({
    id: createWalletFundingAssessmentId(buy),
    buy,
    status,
    inspectedTransferCount: acceptedEvidenceCount,
    acceptedEvidenceCount,
    ignoredTransferCount: 0,
    diagnosticCodes: Object.freeze([]),
    payloadVersion: WALLET_FUNDING_PAYLOAD_VERSION,
  });
}

function fundingBuy(
  tradeId: string,
  confirmationStatus: ChainConfirmationStatus,
  instructionIndex = 2,
): WalletFundingBuy {
  return Object.freeze({
    eventId: `${tradeId}-event`,
    tradeId,
    mint: 'mint',
    buyer: 'buyer',
    source: 'pumpfun',
    program: 'pump-program',
    quoteAsset: Object.freeze({
      mint: 'So11111111111111111111111111111111111111112',
      decimals: 9,
      tokenProgram: 'SPL_TOKEN',
    }),
    signature: `${tradeId}-signature`,
    cursor: Object.freeze({
      slot: 10n,
      transactionIndex: 0,
      instructionIndex,
      innerInstructionIndex: null,
    }),
    confirmationStatus,
    blockchainTimeMs: 1_720_000_000_000,
    observedAtMs: 1_720_000_000_100,
  });
}

async function insertLaunch(pool: InstanceType<typeof pg.Pool>): Promise<void> {
  await pool.query(`INSERT INTO token_launches (
    mint, launchpad, program_id, creator, token_program, current_state,
    created_signature, created_slot, created_transaction_index,
    created_instruction_index, detected_at, updated_at
  ) VALUES (
    'mint', 'pumpfun', 'pump-program', 'creator', 'SPL_TOKEN', 'DETECTED',
    'create-signature', 10, 0, 1, NOW(), NOW()
  )`);
}

async function counts(
  pool: InstanceType<typeof pg.Pool>,
): Promise<readonly string[]> {
  const result = await pool.query<{
    readonly observations: string;
    readonly evidence: string;
  }>(`SELECT
    (SELECT COUNT(*) FROM wallet_funding_observations)::text AS observations,
    (SELECT COUNT(*) FROM wallet_funding_evidence)::text AS evidence`);
  return [
    result.rows[0]?.observations ?? '-1',
    result.rows[0]?.evidence ?? '-1',
  ];
}

async function storedConfirmation(
  pool: InstanceType<typeof pg.Pool>,
  table: 'wallet_funding_observations' | 'wallet_funding_evidence',
  tradeId = 'direct-trade',
): Promise<string | undefined> {
  const tradeColumn = table === 'wallet_funding_observations'
    ? 'trade_id'
    : 'buy_trade_id';
  const result = await pool.query(
    `SELECT confirmation_status FROM ${table} WHERE ${tradeColumn} = $1`,
    [tradeId],
  );
  return result.rows[0]?.confirmation_status as string | undefined;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) {
    throw new Error('Unsafe SQL identifier.');
  }
  return `"${identifier}"`;
}
