import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIVE_RECOVERY_MIGRATION_CATALOG,
  LiveRecoveryStartupError,
  validateLiveRecoveryStartup,
  validateLiveRecoveryMigrationFiles,
} from '../src/executor-live-recovery/startup-validator.js';
import type { LiveRecoveryConfig } from '../src/executor-live-recovery/config.js';

const GENERATION_ID = `execution_wallet_generation_${'a'.repeat(64)}`;
const PUBLIC_KEY = '11111111111111111111111111111111';

void test('pins every migration through 037 to a non-placeholder sha256', async () => {
  assert.equal(LIVE_RECOVERY_MIGRATION_CATALOG.length, 37);
  assert.equal(
    LIVE_RECOVERY_MIGRATION_CATALOG.at(-1)?.name,
    '037_execution_live_orchestration.sql',
  );
  for (const entry of LIVE_RECOVERY_MIGRATION_CATALOG) {
    assert.match(entry.name, /^\d{3}_[a-z0-9_-]+\.sql$/u);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/u);
    assert.notEqual(entry.sha256, '0'.repeat(64));
    assert.equal(Object.isFrozen(entry), true);
  }
  assert.equal(Object.isFrozen(LIVE_RECOVERY_MIGRATION_CATALOG), true);
  await validateLiveRecoveryMigrationFiles();
});

void test('validates role, exact migration history, generation and open-work affinity in order', async () => {
  const calls: string[] = [];
  const database = databaseFor(calls);
  const evidence = await validateLiveRecoveryStartup(database, config());
  assert.deepEqual(calls, ['role', 'migrations', 'generation', 'work']);
  assert.deepEqual(evidence, {
    payloadVersion: 1,
    role: 'sol_token_executor_live',
    migrationHead: '037_execution_live_orchestration.sql',
    generationId: GENERATION_ID,
    providerId: 'primary',
  });
  assert.equal(Object.isFrozen(evidence), true);
});

void test('fails closed on role capabilities, migration drift, generation drift and open-work drift', async () => {
  const cases = [
    databaseFor([], { role: 'postgres' }),
    databaseFor([], { roleSuper: true }),
    databaseFor([], { migrations: LIVE_RECOVERY_MIGRATION_CATALOG.slice(0, -1).map((item) => item.name) }),
    databaseFor([], { migrations: [...LIVE_RECOVERY_MIGRATION_CATALOG.map((item) => item.name), '999_unknown.sql'] }),
    databaseFor([], { generationWallet: 'Vote111111111111111111111111111111111111111' }),
    databaseFor([], { generationRetired: '2026-09-04T00:00:00.000Z' }),
    databaseFor([], { divergentWork: '1' }),
  ];
  const expected = [
    'DATABASE_ROLE_INVALID', 'DATABASE_ROLE_INVALID', 'MIGRATION_HISTORY_INVALID',
    'MIGRATION_HISTORY_INVALID', 'GENERATION_BINDING_INVALID',
    'GENERATION_BINDING_INVALID', 'OPEN_WORK_BINDING_INVALID',
  ];
  for (const [index, database] of cases.entries()) {
    await assert.rejects(
      validateLiveRecoveryStartup(database, config(), { validateFiles: false }),
      (error: unknown) => error instanceof LiveRecoveryStartupError
        && error.code === expected[index],
    );
  }
});

void test('wraps database failures without leaking their message', async () => {
  await assert.rejects(
    validateLiveRecoveryStartup({
      query: () => Promise.reject(new Error('postgresql://secret@database')),
    }, config(), { validateFiles: false }),
    (error: unknown) => error instanceof LiveRecoveryStartupError
      && error.code === 'DATABASE_READ_FAILED'
      && !error.message.includes('secret'),
  );
});

interface Overrides {
  readonly role?: string;
  readonly roleSuper?: boolean;
  readonly migrations?: readonly string[];
  readonly generationWallet?: string;
  readonly generationRetired?: string | null;
  readonly divergentWork?: string;
}

function databaseFor(calls: string[], overrides: Overrides = {}) {
  return {
    async query(text: string, values?: readonly unknown[]) {
      if (text.includes('current_user')) {
        calls.push('role');
        return result({
          current_role: overrides.role ?? 'sol_token_executor_live',
          role_super: overrides.roleSuper ?? false,
          role_bypass_rls: false,
          role_replication: false,
        });
      }
      if (text.includes('migration_history')) {
        calls.push('migrations');
        return {
          rows: (overrides.migrations ?? LIVE_RECOVERY_MIGRATION_CATALOG.map((item) => item.name))
            .map((version) => ({ version })),
          rowCount: LIVE_RECOVERY_MIGRATION_CATALOG.length,
        };
      }
      if (text.includes('FROM execution_wallet_generations')) {
        calls.push('generation');
        assert.deepEqual(values, [GENERATION_ID]);
        return result({
          generation_id: GENERATION_ID,
          wallet_public_key: overrides.generationWallet ?? PUBLIC_KEY,
          cluster: 'mainnet-beta',
          genesis_hash: PUBLIC_KEY,
          retired_at: overrides.generationRetired ?? null,
        });
      }
      if (text.includes('divergent_work_count')) {
        calls.push('work');
        assert.deepEqual(values, [GENERATION_ID, PUBLIC_KEY, 'primary']);
        return result({ divergent_work_count: overrides.divergentWork ?? '0' });
      }
      throw new Error('Unexpected query.');
    },
  };
}

function result(row: Readonly<Record<string, unknown>>) {
  return { rows: [row], rowCount: 1 };
}

function config(): LiveRecoveryConfig {
  return Object.freeze({
    mode: 'live', recoveryEnabled: true, cluster: 'mainnet-beta',
    databaseUrl: 'postgresql://ignored', pollMs: 1_000, leaseMs: 60_000,
    databaseStatementTimeoutMs: 3_000, shutdownGraceMs: 10_000,
    generationId: GENERATION_ID, executorPublicKey: PUBLIC_KEY,
    providerId: 'primary', httpRpcUrl: 'https://rpc.example.test',
    expectedGenesisHash: PUBLIC_KEY, rpcTimeoutMs: 5_000,
    maxRpcCallsPerPass: 8, ownerId: 'recovery-a',
  });
}
