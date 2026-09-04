import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExecutionOperationsConfigError,
  parseExecutionCanaryArmConfig,
  parseExecutionOperationsConfig,
} from '../src/executor-operations/config.js';

void test('parses one frozen public-only operations configuration', () => {
  const config = parseExecutionOperationsConfig(environment());
  assert.equal(config.phase, 'CANARY');
  assert.equal(config.providerId, 'primary');
  assert.equal(Object.isFrozen(config), true);
  assert.equal('keypairPath' in config, false);
});

void test('keeps common operations parsing independent of arm-only sidecar and runtime limits', () => {
  const commonEnvironment: Record<string, string | undefined> = { ...environment() };
  delete commonEnvironment.EXECUTOR_CANARY_EVIDENCE_PATH;
  delete commonEnvironment.EXECUTOR_LEASE_MS;
  delete commonEnvironment.EXECUTOR_QUOTE_MAX_AGE_MS;
  delete commonEnvironment.EXECUTOR_SLIPPAGE_BPS;
  delete commonEnvironment.EXECUTOR_SNAPSHOT_MAX_SLOT_LAG;
  delete commonEnvironment.EXECUTOR_MAX_COMPUTE_UNITS;
  delete commonEnvironment.EXECUTOR_MAX_FEE_LAMPORTS;
  delete commonEnvironment.EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT;
  delete commonEnvironment.EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT;
  assert.equal(parseExecutionOperationsConfig(commonEnvironment).phase, 'CANARY');
  const arm = parseExecutionCanaryArmConfig(environment());
  assert.equal(arm.canaryEvidencePath, '/tmp/canary-evidence.json');
  assert.equal(arm.runtimeLeaseMs, 120_000);
  assert.equal(arm.runtimeMaxFeeLamports, 100_000n);
});

void test('rejects missing identities, live enablement and every keypair variable', () => {
  for (const changed of [
    { DATABASE_URL: '' },
    { EXECUTOR_ACTIVATION_PHASE: 'canary' },
    { EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: '' },
    { EXECUTOR_PREFLIGHT_EVIDENCE_PATH: 'relative.json' },
    { LIVE_TRADING_ENABLED: 'true' },
    { EXECUTOR_KEYPAIR_PATH: '/secret/key.json' },
    { EXECUTOR_EVIDENCE_PRIVATE_KEY_BASE64: 'secret' },
    { SOLANA_PRIVATE_KEY: 'secret' },
  ]) assert.throws(
    () => parseExecutionOperationsConfig(environment(changed)),
    (error) => error instanceof ExecutionOperationsConfigError
      && error.code === 'INVALID_EXECUTION_OPERATIONS_CONFIG'
      && !error.message.includes('secret'),
  );
  for (const changed of [
    { EXECUTOR_CANARY_EVIDENCE_PATH: 'relative.json' },
    { EXECUTOR_LEASE_MS: '120001' },
    { EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT: '11' },
  ]) assert.throws(
    () => parseExecutionCanaryArmConfig(environment(changed)),
    (error) => error instanceof ExecutionOperationsConfigError,
  );
});

void test('rejects every secret key even when empty and every non-canonical arm bound', () => {
  for (const key of [
    'EXECUTOR_PRIVATE_KEY', 'EXECUTOR_SECRET_KEY', 'EXECUTOR_KEYPAIR', 'EXECUTOR_KEYPAIR_PATH',
    'SOLANA_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY_BASE58', 'SOLANA_SECRET_KEY', 'SOLANA_KEYPAIR',
    'SOLANA_KEYPAIR_PATH', 'WALLET_PRIVATE_KEY', 'WALLET_KEYPAIR', 'WALLET_KEYPAIR_PATH',
    'ANCHOR_WALLET', 'EXECUTOR_EVIDENCE_PRIVATE_KEY', 'EXECUTOR_EVIDENCE_PRIVATE_KEY_BASE64',
    'EXECUTOR_EVIDENCE_SIGNING_KEY',
  ]) assert.throws(() => parseExecutionOperationsConfig(environment({ [key]: '' })), ExecutionOperationsConfigError);
  for (const changed of [
    { EXECUTOR_LEASE_MS: '2999' }, { EXECUTOR_LEASE_MS: '120001' }, { EXECUTOR_LEASE_MS: '03000' },
    { EXECUTOR_QUOTE_MAX_AGE_MS: '0' }, { EXECUTOR_QUOTE_MAX_AGE_MS: '60001' },
    { EXECUTOR_SLIPPAGE_BPS: '-1' }, { EXECUTOR_SLIPPAGE_BPS: '10001' }, { EXECUTOR_SLIPPAGE_BPS: '00' },
    { EXECUTOR_SNAPSHOT_MAX_SLOT_LAG: '-1' }, { EXECUTOR_SNAPSHOT_MAX_SLOT_LAG: '129' },
    { EXECUTOR_MAX_COMPUTE_UNITS: '0' }, { EXECUTOR_MAX_COMPUTE_UNITS: '1400001' },
    { EXECUTOR_MAX_FEE_LAMPORTS: '-1' }, { EXECUTOR_MAX_FEE_LAMPORTS: '10000001' },
    { EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT: '-1' }, { EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT: '10000000001' },
    { EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT: '11' }, { EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT: '17' },
  ]) assert.throws(() => parseExecutionCanaryArmConfig(environment(changed)), ExecutionOperationsConfigError);
});

function environment(overrides: Readonly<Record<string, string>> = {}) {
  return {
    DATABASE_URL: 'postgresql://localhost/solanabot',
    EXECUTOR_WALLET_GENERATION_ID: `execution_wallet_generation_${'a'.repeat(64)}`,
    EXECUTOR_PUBLIC_KEY: '11111111111111111111111111111111',
    SOLANA_EXPECTED_GENESIS_HASH: '11111111111111111111111111111111',
    EXECUTOR_RPC_PROVIDER_ID: 'primary',
    EXECUTOR_BUILD_HASH: 'b'.repeat(64),
    EXECUTOR_CONFIGURATION_FINGERPRINT: 'c'.repeat(64),
    EXECUTOR_STRATEGY_FINGERPRINT: 'd'.repeat(64),
    EXECUTOR_ACTIVATION_PHASE: 'CANARY',
    EXECUTOR_OPERATOR_ID: 'operator-primary',
    EXECUTOR_PREFLIGHT_EVIDENCE_PATH: '/tmp/preflight-evidence.json',
    EXECUTOR_CANARY_EVIDENCE_PATH: '/tmp/canary-evidence.json',
    EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: 'MCowBQYDK2VwAyEA7Q2ZB8C8QzL4vVfJdGz4g0yP5wVqgYvZx4h7gM9rGgM=',
    EXECUTOR_LEASE_MS: '120000',
    EXECUTOR_QUOTE_MAX_AGE_MS: '3000',
    EXECUTOR_SLIPPAGE_BPS: '500',
    EXECUTOR_SNAPSHOT_MAX_SLOT_LAG: '8',
    EXECUTOR_MAX_COMPUTE_UNITS: '300000',
    EXECUTOR_MAX_FEE_LAMPORTS: '100000',
    EXECUTOR_MAX_FEE_PAYER_LAMPORT_DEBIT: '2500000',
    EXECUTOR_MAX_RPC_CALLS_PER_ATTEMPT: '12',
    LIVE_TRADING_ENABLED: 'false',
    ...overrides,
  };
}
