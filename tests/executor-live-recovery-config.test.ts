import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LiveRecoveryConfigError,
  parseLiveRecoveryConfig,
} from '../src/executor-live-recovery/config.js';

void test('parses and freezes the exact read-only finality runtime configuration', () => {
  const config = parseLiveRecoveryConfig(environment());
  assert.deepEqual(config, {
    mode: 'live', recoveryEnabled: true, cluster: 'mainnet-beta',
    databaseUrl: 'postgresql://recovery@127.0.0.1:5432/solanabot',
    pollMs: 1_000, leaseMs: 60_000, databaseStatementTimeoutMs: 3_000,
    shutdownGraceMs: 10_000,
    generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    executorPublicKey: '11111111111111111111111111111111',
    providerId: 'primary', httpRpcUrl: 'https://credential@rpc.example.test/solana',
    expectedGenesisHash: '11111111111111111111111111111111',
    rpcTimeoutMs: 5_000,
    maxRpcCallsPerPass: 8, ownerId: 'live-recovery-a',
    exitTakeProfitBps: 20_000n, exitExternalBuyersTarget: 10,
    exitExternalMinimumBuyRaw: 1_000_000n,
  });
  assert.equal(Object.isFrozen(config), true);
});

void test('EXIT_* are optional, default to the spec values and accept their exact bounds', () => {
  const absent = parseLiveRecoveryConfig(environment({
    EXIT_TAKE_PROFIT_BPS: undefined, EXIT_EXTERNAL_BUYERS_TARGET: undefined,
    EXIT_EXTERNAL_MIN_BUY_RAW: undefined,
  }));
  assert.equal(absent.exitTakeProfitBps, 20_000n);
  assert.equal(absent.exitExternalBuyersTarget, 10);
  assert.equal(absent.exitExternalMinimumBuyRaw, 1_000_000n);
  for (const [overrides, field, expected] of [
    [{ EXIT_TAKE_PROFIT_BPS: '10001' }, 'exitTakeProfitBps', 10_001n],
    [{ EXIT_TAKE_PROFIT_BPS: '100000' }, 'exitTakeProfitBps', 100_000n],
    [{ EXIT_EXTERNAL_BUYERS_TARGET: '1' }, 'exitExternalBuyersTarget', 1],
    [{ EXIT_EXTERNAL_BUYERS_TARGET: '1000' }, 'exitExternalBuyersTarget', 1_000],
    [{ EXIT_EXTERNAL_MIN_BUY_RAW: '1' }, 'exitExternalMinimumBuyRaw', 1n],
    [{ EXIT_EXTERNAL_MIN_BUY_RAW: '18446744073709551615' }, 'exitExternalMinimumBuyRaw',
      18_446_744_073_709_551_615n],
  ] as const) {
    const config = parseLiveRecoveryConfig(environment(overrides));
    assert.equal(config[field], expected, JSON.stringify(overrides));
  }
});

void test('a present but invalid EXIT_* value fails startup', () => {
  for (const overrides of [
    { EXIT_TAKE_PROFIT_BPS: '10000' },
    { EXIT_TAKE_PROFIT_BPS: '100001' },
    { EXIT_TAKE_PROFIT_BPS: '' },
    { EXIT_TAKE_PROFIT_BPS: '020000' },
    { EXIT_TAKE_PROFIT_BPS: '2e4' },
    { EXIT_EXTERNAL_BUYERS_TARGET: '0' },
    { EXIT_EXTERNAL_BUYERS_TARGET: '1001' },
    { EXIT_EXTERNAL_BUYERS_TARGET: '-1' },
    { EXIT_EXTERNAL_BUYERS_TARGET: '10.5' },
    { EXIT_EXTERNAL_MIN_BUY_RAW: '0' },
    { EXIT_EXTERNAL_MIN_BUY_RAW: '18446744073709551616' },
    { EXIT_EXTERNAL_MIN_BUY_RAW: '0x10' },
    { EXIT_EXTERNAL_MIN_BUY_RAW: ' 1000' },
    { EXIT_EXTERNAL_MIN_BUY_RAW: 'abc' },
  ]) assertFailure(environment(overrides));
});

void test('fails closed unless recovery, live mode and mainnet are explicit', () => {
  for (const overrides of [
    { EXECUTOR_LIVE_RECOVERY_ENABLED: undefined },
    { EXECUTOR_LIVE_RECOVERY_ENABLED: 'false' },
    { EXECUTOR_MODE: undefined },
    { EXECUTOR_MODE: 'observe' },
    { SOLANA_CLUSTER: 'devnet' },
    { DATABASE_URL: '' },
    { EXECUTOR_WALLET_GENERATION_ID: undefined },
    { EXECUTOR_PUBLIC_KEY: undefined },
    { EXECUTOR_RPC_PROVIDER_ID: undefined },
    { SOLANA_HTTP_RPC_URL: undefined },
    { SOLANA_EXPECTED_GENESIS_HASH: undefined },
    { EXECUTOR_LIVE_RECOVERY_OWNER_ID: undefined },
  ]) assertFailure(environment(overrides));
});

void test('rejects every secret-bearing variable by presence, including empty values', () => {
  for (const key of [
    'EXECUTOR_PRIVATE_KEY', 'EXECUTOR_SECRET_KEY', 'EXECUTOR_KEYPAIR',
    'EXECUTOR_KEYPAIR_PATH', 'SOLANA_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY_BASE58',
    'SOLANA_SECRET_KEY', 'SOLANA_KEYPAIR', 'SOLANA_KEYPAIR_PATH',
    'WALLET_PRIVATE_KEY', 'WALLET_KEYPAIR', 'WALLET_KEYPAIR_PATH', 'ANCHOR_WALLET',
  ]) {
    assertFailure(environment({ [key]: '' }));
    assertFailure(environment({ [key]: 'sensitive-marker' }), ['sensitive-marker']);
  }
});

void test('rejects unsafe URLs, non-canonical numbers and impossible timing budgets', () => {
  for (const overrides of [
    { SOLANA_HTTP_RPC_URL: 'file:///tmp/socket' },
    { SOLANA_HTTP_RPC_URL: 'https://rpc.example.test/#credential' },
    { EXECUTOR_POLL_MS: '01000' },
    { EXECUTOR_POLL_MS: '60000' },
    { EXECUTOR_LEASE_MS: '2999' },
    { EXECUTOR_DB_STATEMENT_TIMEOUT_MS: '10001' },
    { EXECUTOR_SHUTDOWN_GRACE_MS: '999' },
    { EXECUTOR_RPC_TIMEOUT_MS: '0' },
    { EXECUTOR_MAX_RPC_CALLS_PER_PASS: '5' },
    { EXECUTOR_MAX_RPC_CALLS_PER_PASS: '17' },
    { EXECUTOR_LIVE_RECOVERY_OWNER_ID: 'owner with spaces' },
    { EXECUTOR_RPC_TIMEOUT_MS: '15000' },
  ]) assertFailure(environment(overrides));
});

void test('rejects getters and proxies without exposing input values', () => {
  const getter = environment();
  Object.defineProperty(getter, 'DATABASE_URL', {
    enumerable: true,
    get: () => 'sensitive-getter',
  });
  assertFailure(getter, ['sensitive-getter']);
  assertFailure(new Proxy(environment(), {}));
});

function environment(overrides: Readonly<Record<string, string | undefined>> = {}) {
  return {
    EXECUTOR_LIVE_RECOVERY_ENABLED: 'true',
    EXECUTOR_MODE: 'live',
    SOLANA_CLUSTER: 'mainnet-beta',
    DATABASE_URL: 'postgresql://recovery@127.0.0.1:5432/solanabot',
    EXECUTOR_WALLET_GENERATION_ID: `execution_wallet_generation_${'a'.repeat(64)}`,
    EXECUTOR_PUBLIC_KEY: '11111111111111111111111111111111',
    EXECUTOR_RPC_PROVIDER_ID: 'primary',
    SOLANA_HTTP_RPC_URL: 'https://credential@rpc.example.test/solana',
    SOLANA_EXPECTED_GENESIS_HASH: '11111111111111111111111111111111',
    EXECUTOR_POLL_MS: '1000',
    EXECUTOR_LEASE_MS: '60000',
    EXECUTOR_DB_STATEMENT_TIMEOUT_MS: '3000',
    EXECUTOR_SHUTDOWN_GRACE_MS: '10000',
    EXECUTOR_RPC_TIMEOUT_MS: '5000',
    EXECUTOR_MAX_RPC_CALLS_PER_PASS: '8',
    EXECUTOR_LIVE_RECOVERY_OWNER_ID: 'live-recovery-a',
    ...overrides,
  };
}

function assertFailure(value: unknown, forbidden: readonly string[] = []): void {
  assert.throws(
    () => parseLiveRecoveryConfig(value),
    (error: unknown) => error instanceof LiveRecoveryConfigError
      && error.code === 'INVALID_LIVE_RECOVERY_CONFIG'
      && forbidden.every((secret) => !error.message.includes(secret)),
  );
}
