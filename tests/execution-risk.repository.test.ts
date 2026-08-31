import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createProviderUsageSnapshot } from '../src/domain/execution-provider-quota.js';
import {
  ExecutionRiskRepositoryError,
  PostgresExecutionRiskRepository,
} from '../src/storage/execution-risk.repository.js';
import { migrateDatabase } from '../src/storage/database.js';

const publicKey = '11111111111111111111111111111111';
const genesisHash = '2'.repeat(32);

void test('wallet generation and snapshot writes replay exactly and reject conflicts', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution risk repository wallet test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_risk_repository_wallet', async (pool) => {
    await migrateDatabase({ pool });
    const repository = new PostgresExecutionRiskRepository(pool);
    const generation = generationDraft('a', 1);
    const created = await repository.registerWalletGeneration(generation);
    assert.deepEqual(await repository.registerWalletGeneration(generation), created);
    assert.equal(created.walletPublicKey, publicKey);
    await assert.rejects(
      repository.registerWalletGeneration(generationDraft('b', 2)),
      isRepositoryError('CONFLICT'),
    );

    const snapshot = walletSnapshotDraft(created.generationId, 'c', 0n);
    assert.deepEqual(await repository.appendWalletSnapshot(snapshot), snapshot);
    assert.deepEqual(await repository.appendWalletSnapshot(snapshot), snapshot);
    await assert.rejects(
      repository.appendWalletSnapshot({ ...snapshot, snapshotId: id('wallet_snapshot', 'd') }),
      isRepositoryError('CONFLICT'),
    );
    const positioned = walletSnapshotDraft(created.generationId, 'e', 1n, [{
      positionId: 'position:test',
      costBasisLamports: 500n,
      conservativeLiquidationLamports: 450n,
      reconciliationStatus: 'RECONCILED',
    }]);
    assert.deepEqual(await repository.appendWalletSnapshot(positioned), positioned);
  });
});

void test('provider usage is monotone and operations and 429 events are idempotent', async (context) => {
  const databaseUrl = testDatabaseUrl(context, 'execution risk repository provider test');
  if (databaseUrl === null) return;
  await withTemporarySchema(databaseUrl, 'execution_risk_repository_provider', async (pool) => {
    await migrateDatabase({ pool });
    const repository = new PostgresExecutionRiskRepository(pool);
    const first = providerSnapshot(1_000, 1_100, 10);
    assert.deepEqual(await repository.appendProviderUsage(first), first);
    assert.deepEqual(await repository.appendProviderUsage(first), first);
    await assert.rejects(
      repository.appendProviderUsage(providerSnapshot(900, 1_050, 11)),
      isRepositoryError('STALE_MEASUREMENT'),
    );

    const operation = {
      operationId: `execution_provider_operation_${'d'.repeat(64)}`,
      payloadVersion: 1 as const,
      snapshotId: first.snapshotId,
      providerId: first.providerId,
      billingPeriodId: first.billingPeriodId,
      category: 'ENTRY' as const,
      logicalOperationId: 'intent:test',
      units: 3n,
    };
    assert.equal(await repository.recordProviderOperation(operation), 'RECORDED');
    assert.equal(await repository.recordProviderOperation(operation), 'REPLAYED');
    await assert.rejects(
      repository.recordProviderOperation({ ...operation, units: 4n }),
      isRepositoryError('CONFLICT'),
    );

    const rateLimit = {
      eventId: `execution_provider_rate_limit_${'e'.repeat(64)}`,
      payloadVersion: 1 as const,
      providerId: first.providerId,
      billingPeriodId: first.billingPeriodId,
      endpointId: 'primary',
      observedAtMs: 1_050,
    };
    assert.equal(await repository.recordRateLimit(rateLimit), 'RECORDED');
    assert.equal(await repository.recordRateLimit(rateLimit), 'REPLAYED');
    await assert.rejects(
      repository.recordRateLimit({ ...rateLimit, endpointId: 'secondary' }),
      isRepositoryError('CONFLICT'),
    );
  });
});

void test('repository failures expose only a fixed redacted error', async () => {
  const repository = new PostgresExecutionRiskRepository({
    async connect() {
      throw new Error('postgresql://operator:secret@private.invalid/database');
    },
  });
  await assert.rejects(repository.registerWalletGeneration(generationDraft('f', 1)), (error) => {
    assert.equal(error instanceof ExecutionRiskRepositoryError, true);
    assert.equal((error as Error).message, 'Execution risk repository operation failed.');
    assert.equal(String(error).includes('secret'), false);
    assert.equal((error as Error & { readonly cause?: unknown }).cause, undefined);
    return true;
  });
});

void test('repository rejects malformed rows without exposing their contents', async () => {
  const calls: string[] = [];
  const repository = new PostgresExecutionRiskRepository({
    async connect() {
      return {
        async query(text: string) {
          calls.push(text);
          if (text.includes('FROM execution_wallet_generations')) {
            return { rowCount: 1, rows: [{ generation_id: 'hostile-secret' }] };
          }
          return { rowCount: null, rows: [] };
        },
        release() {},
      };
    },
  });
  await assert.rejects(
    repository.registerWalletGeneration(generationDraft('f', 1)),
    isRepositoryError('INVALID_DATA'),
  );
  assert.equal(calls.at(-1), 'ROLLBACK');
});

void test('a commit ambiguity is fail-closed and redacted', async () => {
  const repository = new PostgresExecutionRiskRepository({
    async connect() {
      return {
        async query(text: string) {
          if (text === 'COMMIT') throw new Error('secret commit transport failure');
          if (text.includes('FROM execution_wallet_generations')) {
            return { rowCount: 0, rows: [] };
          }
          if (text.includes('INSERT INTO execution_wallet_generations')) {
            return { rowCount: 1, rows: [generationRow('f')] };
          }
          return { rowCount: 1, rows: [] };
        },
        release() {},
      };
    },
  });
  await assert.rejects(
    repository.registerWalletGeneration(generationDraft('f', 1)),
    isRepositoryError('COMMIT_OUTCOME_UNKNOWN'),
  );
});

function generationDraft(seed: string, generation: number) {
  return Object.freeze({
    generationId: id('wallet_generation', seed),
    payloadVersion: 1 as const,
    walletPublicKey: publicKey,
    cluster: 'mainnet-beta' as const,
    genesisHash,
    generation,
  });
}

function generationRow(seed: string) {
  return {
    generation_id: id('wallet_generation', seed),
    payload_version: 1,
    wallet_public_key: publicKey,
    cluster: 'mainnet-beta',
    genesis_hash: genesisHash,
    generation: 1,
    created_at_ms: '1000',
    retired_at_ms: null,
  };
}

function walletSnapshotDraft(
  generationId: string,
  seed: string,
  stateRevision: bigint,
  openPositions: readonly Readonly<{
    positionId: string;
    costBasisLamports: bigint;
    conservativeLiquidationLamports: bigint | null;
    reconciliationStatus: 'RECONCILED' | 'UNKNOWN';
  }>[] = [],
) {
  return Object.freeze({
    snapshotId: id('wallet_snapshot', seed),
    payloadVersion: 1 as const,
    snapshotFingerprint: seed.repeat(64),
    generationId,
    providerId: 'rpc-primary',
    stateRevision,
    slot: 123n,
    blockTimeMs: 1_000 as number | null,
    observedAtMs: 1_001,
    commitment: 'finalized' as const,
    walletLamports: 1_000_000n,
    tokenBalanceCount: 0,
    openPositions: Object.freeze(openPositions),
    realizedNetPnlRaw: 0n,
  });
}

function providerSnapshot(startedAtMs: number, measuredAtMs: number, usedUnits: number) {
  return createProviderUsageSnapshot({
    providerId: 'rpc-primary',
    planId: 'public-v1',
    billingPeriodId: `period-${startedAtMs}`,
    billingPeriodStartedAtMs: startedAtMs,
    billingPeriodEndsAtMs: 100_000,
    limitUnits: 10_000n,
    usedUnits: BigInt(usedUnits),
    measuredAtMs,
    expiresAtMs: measuredAtMs + 30_000,
    provenance: 'AUTHORITATIVE_PROBE',
  });
}

function id(kind: 'wallet_generation' | 'wallet_snapshot', seed: string): string {
  return `execution_${kind}_${seed.repeat(64)}`;
}

function isRepositoryError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ExecutionRiskRepositoryError && error.code === code;
}

function testDatabaseUrl(
  context: Readonly<{ skip(message?: string): void }>,
  label: string,
): string | null {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim() !== '') return databaseUrl;
  context.skip(`TEST_DATABASE_URL absent: ${label} skipped`);
  return null;
}

async function withTemporarySchema(
  databaseUrl: string,
  prefix: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    options: `-c search_path=${quoteIdentifier(schema)}`,
  });
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    created = true;
    await pool.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await callback(pool);
  } finally {
    try {
      await pool.end();
    } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Unsafe SQL identifier.');
  return `"${value}"`;
}
