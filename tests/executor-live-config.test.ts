import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  LiveExecutorConfigError,
  parseLiveExecutorConfig,
} from '../src/executor-live/config.js';

const WSOL = 'So11111111111111111111111111111111111111112';

void test('documents only the keypair path and safe disabled live defaults', async () => {
  const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(example, /^EXECUTOR_MODE=dry-run$/mu);
  assert.match(example, /^LIVE_TRADING_ENABLED=false$/mu);
  assert.match(example, /^EXECUTOR_KEYPAIR_PATH=$/mu);
  assert.doesNotMatch(
    example,
    /^(?:EXECUTOR_PRIVATE_KEY|EXECUTOR_SECRET_KEY|SOLANA_PRIVATE_KEY)=/mu,
  );
});

void test('parses one exact frozen live executor configuration', () => {
  const config = parseLiveExecutorConfig(environment());
  assert.equal(config.mode, 'live');
  assert.equal(config.liveTradingEnabled, true);
  assert.equal(config.cluster, 'mainnet-beta');
  assert.equal(config.phase, 'CANARY');
  assert.equal(config.keypairPath, '/run/secrets/solana-executor-keypair.json');
  assert.deepEqual(config.quoteMintAllowlist, [WSOL]);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.quoteMintAllowlist), true);
});

void test('requires both explicit live switches and every deployment binding', () => {
  for (const overrides of [
    { EXECUTOR_MODE: undefined },
    { EXECUTOR_MODE: 'simulation-only' },
    { LIVE_TRADING_ENABLED: undefined },
    { LIVE_TRADING_ENABLED: 'false' },
    { SOLANA_CLUSTER: 'devnet' },
    { EXECUTOR_WALLET_GENERATION_ID: undefined },
    { EXECUTOR_PUBLIC_KEY: undefined },
    { EXECUTOR_KEYPAIR_PATH: undefined },
    { EXECUTOR_KEYPAIR_PATH: 'relative.json' },
    { EXECUTOR_KEYPAIR_PATH: '/run/secrets/../key.json' },
    { EXECUTOR_BUILD_HASH: undefined },
    { EXECUTOR_CONFIGURATION_FINGERPRINT: undefined },
    { EXECUTOR_STRATEGY_FINGERPRINT: undefined },
    { EXECUTOR_ACTIVATION_PHASE: 'canary' },
    { SOLANA_EXPECTED_GENESIS_HASH: undefined },
    { LIVE_QUOTE_MINT_ALLOWLIST: `${WSOL},11111111111111111111111111111111` },
  ]) assertConfigFailure(environment(overrides));
});

void test('rejects every alternate secret variable and hostile environment shape', () => {
  for (const key of [
    'EXECUTOR_PRIVATE_KEY', 'EXECUTOR_SECRET_KEY', 'EXECUTOR_KEYPAIR',
    'SOLANA_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY_BASE58', 'SOLANA_SECRET_KEY',
    'SOLANA_KEYPAIR', 'SOLANA_KEYPAIR_PATH', 'WALLET_PRIVATE_KEY',
    'WALLET_KEYPAIR', 'WALLET_KEYPAIR_PATH', 'ANCHOR_WALLET',
  ]) {
    assertConfigFailure(environment({ [key]: 'sensitive-marker' }), ['sensitive-marker']);
    assertConfigFailure(environment({ [key]: '' }));
  }

  const getter = environment();
  Object.defineProperty(getter, 'DATABASE_URL', {
    enumerable: true,
    get: () => 'sensitive-getter',
  });
  assertConfigFailure(getter, ['sensitive-getter']);
  assertConfigFailure(new Proxy(environment(), {}));
});

void test('keeps all financial and duration values canonical and bounded', () => {
  const exact = parseLiveExecutorConfig(environment({
    EXECUTOR_SLIPPAGE_BPS: '10000',
    EXECUTOR_MAX_COMPUTE_UNITS: '1400000',
    EXECUTOR_MAX_FEE_LAMPORTS: '10000000',
    EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT: '10000000000',
    EXECUTOR_RPC_TIMEOUT_MS: '1',
    EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT: '16',
  }));
  assert.equal(exact.slippageBps, 10_000n);
  assert.equal(exact.maxComputeUnits, 1_400_000n);

  for (const overrides of [
    { EXECUTOR_SLIPPAGE_BPS: '10001' },
    { EXECUTOR_SLIPPAGE_BPS: '0500' },
    { EXECUTOR_MAX_COMPUTE_UNITS: '0' },
    { EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS: '1' },
    { EXECUTOR_RPC_TIMEOUT_MS: '0' },
    { EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT: '11' },
    { EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT: '17' },
  ]) assertConfigFailure(environment(overrides));
});

function environment(overrides: Readonly<Record<string, string | undefined>> = {}) {
  return {
    DATABASE_URL: 'postgresql://executor@127.0.0.1:5432/solanabot',
    EXECUTOR_MODE: 'live',
    LIVE_TRADING_ENABLED: 'true',
    SOLANA_CLUSTER: 'mainnet-beta',
    EXECUTOR_WALLET_GENERATION_ID: `execution_wallet_generation_${'a'.repeat(64)}`,
    EXECUTOR_PUBLIC_KEY: '11111111111111111111111111111111',
    EXECUTOR_KEYPAIR_PATH: '/run/secrets/solana-executor-keypair.json',
    EXECUTOR_RPC_PROVIDER_ID: 'primary',
    SOLANA_HTTP_RPC_URL: 'https://operator:credential@rpc.example.test/solana',
    SOLANA_EXPECTED_GENESIS_HASH: '11111111111111111111111111111111',
    EXECUTOR_BUILD_HASH: 'b'.repeat(64),
    EXECUTOR_CONFIGURATION_FINGERPRINT: 'c'.repeat(64),
    EXECUTOR_STRATEGY_FINGERPRINT: 'd'.repeat(64),
    EXECUTOR_ACTIVATION_PHASE: 'CANARY',
    LIVE_QUOTE_MINT_ALLOWLIST: WSOL,
    EXECUTOR_POLL_MS: '1000',
    EXECUTOR_LEASE_MS: '60000',
    EXECUTOR_DB_STATEMENT_TIMEOUT_MS: '3000',
    EXECUTOR_SHUTDOWN_GRACE_MS: '10000',
    EXECUTOR_QUOTE_MAX_AGE_MS: '3000',
    EXECUTOR_SLIPPAGE_BPS: '500',
    EXECUTOR_SNAPSHOT_MAX_SLOT_LAG: '8',
    EXECUTOR_MAX_COMPUTE_UNITS: '300000',
    EXECUTOR_MAX_FEE_LAMPORTS: '100000',
    EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT: '2500000',
    EXECUTOR_MAX_PRIORITY_FEE_LAMPORTS: '0',
    EXECUTOR_RPC_TIMEOUT_MS: '5000',
    EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT: '12',
    ...overrides,
  };
}

function assertConfigFailure(
  value: unknown,
  forbidden: readonly string[] = [],
): void {
  assert.throws(
    () => parseLiveExecutorConfig(value),
    (error: unknown) => error instanceof LiveExecutorConfigError
      && error.code === 'INVALID_LIVE_EXECUTOR_CONFIG'
      && forbidden.every((secret) => !error.message.includes(secret)),
  );
}
