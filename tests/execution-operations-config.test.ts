import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExecutionOperationsConfigError,
  parseExecutionOperationsConfig,
} from '../src/executor-operations/config.js';

void test('parses one frozen public-only operations configuration', () => {
  const config = parseExecutionOperationsConfig(environment());
  assert.equal(config.phase, 'CANARY');
  assert.equal(config.providerId, 'primary');
  assert.equal(Object.isFrozen(config), true);
  assert.equal('keypairPath' in config, false);
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
    EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: 'MCowBQYDK2VwAyEA7Q2ZB8C8QzL4vVfJdGz4g0yP5wVqgYvZx4h7gM9rGgM=',
    LIVE_TRADING_ENABLED: 'false',
    ...overrides,
  };
}
