import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createProviderUsageSnapshot } from '../src/domain/execution-provider-quota.js';
import { createExecutionWalletGeneration } from '../src/domain/execution-readiness.js';
import { createExecutionWalletSnapshot } from '../src/domain/execution-wallet-snapshot.js';
import {
  ExecutionReadinessRepositoryError,
  PostgresExecutionReadinessRepository,
} from '../src/storage/execution-readiness.repository.js';
import type { ExecutionRiskPool } from '../src/storage/execution-risk.repository.js';
import { migrateDatabase } from '../src/storage/database.js';
import { acquireExecutorRoleTestLock } from './postgres-role-test-lock.js';

const WALLET = '2LvenbX1TdhX8EbxGBmcZYiXuZFN4utA8QZY1UgGXwmZ';
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

void test('commits generation and both snapshots atomically and replays exactly', async (context) => {
  const url = databaseUrl(context);
  if (url === null) return;
  await withSchema(url, async (pool) => {
    const repository = new PostgresExecutionReadinessRepository(pool);
    const input = commitInput();
    assert.deepEqual(await repository.commit(input), input);
    assert.deepEqual(await repository.commit(input), input);
    const counts = (await pool.query(`SELECT
      (SELECT COUNT(*) FROM execution_wallet_generations)::INTEGER AS generations,
      (SELECT COUNT(*) FROM execution_wallet_risk_state)::INTEGER AS risk_states,
      (SELECT COUNT(*) FROM execution_wallet_snapshots)::INTEGER AS wallet_snapshots,
      (SELECT COUNT(*) FROM execution_provider_usage_snapshots)::INTEGER AS provider_snapshots`)).rows[0];
    assert.deepEqual(counts, { generations: 1, risk_states: 1,
      wallet_snapshots: 1, provider_snapshots: 1 });
  });
});

void test('rolls back every readiness projection when the provider insert fails', async (context) => {
  const url = databaseUrl(context);
  if (url === null) return;
  await withSchema(url, async (pool) => {
    const failingPool: ExecutionRiskPool = {
      async connect() {
        const client = await pool.connect();
        return {
          query: async (text, values) => {
            if (text.includes('INSERT INTO execution_provider_usage_snapshots')) {
              throw new Error('injected');
            }
            return client.query(text, values === undefined ? undefined : [...values]);
          },
          release: (error) => { client.release(error); },
        };
      },
    };
    await assert.rejects(new PostgresExecutionReadinessRepository(failingPool).commit(commitInput()),
      ExecutionReadinessRepositoryError);
    const counts = (await pool.query(`SELECT
      (SELECT COUNT(*) FROM execution_wallet_generations)::INTEGER AS generations,
      (SELECT COUNT(*) FROM execution_wallet_snapshots)::INTEGER AS wallet_snapshots`)).rows[0];
    assert.deepEqual(counts, { generations: 0, wallet_snapshots: 0 });
  });
});

void test('rejects additional nested readiness evidence fields before connecting', async () => {
  let connectionAttempted = false;
  const pool: ExecutionRiskPool = {
    async connect() {
      connectionAttempted = true;
      throw new Error('must not connect');
    },
  };
  const repository = new PostgresExecutionReadinessRepository(pool);
  const input = commitInput();
  const generationWithExtra = Object.freeze({ ...input.generation, unexpected: true });
  await assert.rejects(
    repository.commit(Object.freeze({ ...input, generation: generationWithExtra }) as never),
    (error: unknown) => error instanceof ExecutionReadinessRepositoryError
      && error.code === 'INVALID_INPUT',
  );
  const providerWithExtra = Object.freeze({ ...input.providerSnapshot, unexpected: true });
  await assert.rejects(
    repository.commit(Object.freeze({ ...input, providerSnapshot: providerWithExtra }) as never),
    (error: unknown) => error instanceof ExecutionReadinessRepositoryError
      && error.code === 'INVALID_INPUT',
  );
  assert.equal(connectionAttempted, false);
});

void test('rejects an active position for the wallet before appending snapshots', async () => {
  const queries: string[] = [];
  const releases: boolean[] = [];
  const pool: ExecutionRiskPool = { async connect() { return {
    query: async (text) => {
      queries.push(text);
      if (text.includes('FROM execution_wallet_generations')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO execution_wallet_generations')
        || text.includes('INSERT INTO execution_wallet_risk_state')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('FROM execution_wallet_risk_state')) return { rows: [{
        state_revision: '0', reconciled_capital_lamports: '0', reserved_exposure_raw: '0',
        open_positions: 0, conservative_drawdown_raw: '0', consecutive_technical_failures: 0,
        last_technical_failure_reason_code: null, unknown_block: false,
      }], rowCount: 1 };
      if (text.includes('FROM execution_live_positions')) {
        return { rows: [{ active_position_count: '1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: null };
    },
    release: (evict = false) => { releases.push(evict); },
  }; } };
  await assert.rejects(new PostgresExecutionReadinessRepository(pool).commit(commitInput()),
    (error: unknown) => error instanceof ExecutionReadinessRepositoryError
      && error.code === 'CONFLICT');
  assert.equal(queries.some((query) => query.includes('execution_wallet_snapshots')), false);
  assert.deepEqual(releases, [true]);
});

void test('rolls back when provider evidence is stale at the database commit boundary',
  async (context) => {
  const url = databaseUrl(context);
  if (url === null) return;
  await withSchema(url, async (pool) => {
    const interceptedPool: ExecutionRiskPool = { async connect() {
      const client = await pool.connect();
      return {
        query: async (text, values) => text.includes('AS evidence_fresh')
          ? { rows: [{ evidence_fresh: false }], rowCount: 1 }
          : client.query(text, values === undefined ? undefined : [...values]),
        release: (error) => { client.release(error); },
      };
    } };
    await assert.rejects(
      new PostgresExecutionReadinessRepository(interceptedPool).commit(commitInput()),
      (error: unknown) => error instanceof ExecutionReadinessRepositoryError
        && error.code === 'CONFLICT',
    );
    const counts = (await pool.query(`SELECT
      (SELECT COUNT(*) FROM execution_wallet_generations)::INTEGER AS generations,
      (SELECT COUNT(*) FROM execution_provider_usage_snapshots)::INTEGER AS providers`)).rows[0];
    assert.deepEqual(counts, { generations: 0, providers: 0 });
  });
});

function commitInput() {
  const nowMs = Date.now();
  const generation = createExecutionWalletGeneration(Object.freeze({
    walletPublicKey: WALLET, cluster: 'mainnet-beta' as const,
    genesisHash: GENESIS, generation: 1,
  }));
  const walletSnapshot = createExecutionWalletSnapshot(Object.freeze({
    generationId: generation.generationId, providerId: 'primary', stateRevision: 0n,
    slot: 401_000_000n, blockTimeMs: nowMs - 1_000,
    observedAtMs: nowMs, commitment: 'finalized' as const,
    walletLamports: 465_847_782n, tokenBalanceCount: 0,
    openPositions: Object.freeze([]), realizedNetPnlRaw: 0n,
  }));
  const providerSnapshot = createProviderUsageSnapshot(Object.freeze({
    providerId: 'primary', planId: 'paid-mainnet', billingPeriodId: '2026-09',
    billingPeriodStartedAtMs: nowMs - 86_400_000,
    billingPeriodEndsAtMs: nowMs + 86_400_000,
    limitUnits: 1_000_000n, usedUnits: 1_000n,
    measuredAtMs: nowMs, expiresAtMs: nowMs + 300_000,
    provenance: 'OPERATOR_REPORT' as const,
  }));
  return Object.freeze({ generation, walletSnapshot, providerSnapshot });
}

function databaseUrl(context: Readonly<{ skip(message?: string): void }>): string | null {
  const value = process.env.TEST_DATABASE_URL;
  if (value !== undefined && value.trim().length > 0) return value;
  context.skip('TEST_DATABASE_URL absent: readiness repository integration skipped');
  return null;
}

async function withSchema(
  databaseUrlValue: string,
  callback: (pool: InstanceType<typeof pg.Pool>) => Promise<void>,
): Promise<void> {
  const schema = `execution_readiness_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrlValue });
  const pool = new pg.Pool({ connectionString: databaseUrlValue,
    options: `-c search_path=${schema}` });
  const releaseRoleLock = await acquireExecutorRoleTestLock(admin);
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await migrateDatabase({ pool });
    await callback(pool);
  } finally {
    try {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      try { await releaseRoleLock(); } finally { await admin.end(); }
    }
  }
}
