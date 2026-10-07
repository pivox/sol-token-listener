import assert from 'node:assert/strict';
import test from 'node:test';
import { FAST_ENTRY_INTENT_TTL_MS } from '../src/domain/fast-entry.js';
import {
  AUTO_ARM_FAST_ENTRY_INTENT_TTL_MS,
  ExecutionOperationsConfigError,
  parseExecutionAutoArmConfig,
  parseExecutionCanaryArmConfig,
  parseExecutionEnvelopeConfig,
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
  assert.equal(arm.preflightSourcePath, '/tmp/preflight-source.json');
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
    { EXECUTOR_PREFLIGHT_SOURCE_PATH: 'relative.json' },
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

void test('envelope config requires an absolute gate catalog path and the CANARY phase', () => {
  const config = parseExecutionEnvelopeConfig(environment());
  assert.equal(config.gateCatalogPath, '/tmp/gate-catalog.json');
  assert.equal(config.phase, 'CANARY');
  assert.equal(Object.isFrozen(config), true);
  const missing: Record<string, string | undefined> = { ...environment() };
  delete missing.EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH;
  assert.equal(parseExecutionOperationsConfig(missing).phase, 'CANARY');
  for (const changed of [
    missing,
    environment({ EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH: 'relative.json' }),
    environment({ EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH: '/tmp/../gate-catalog.json' }),
    environment({ EXECUTOR_ACTIVATION_PHASE: 'MICRO_LIVE' }),
    environment({ EXECUTOR_ACTIVATION_PHASE: 'PILOT' }),
  ]) assert.throws(() => parseExecutionEnvelopeConfig(changed), ExecutionOperationsConfigError);
});

void test('auto-arm config: arm runtime, https RPC, poll and the TTL / lease guard', () => {
  assert.equal(AUTO_ARM_FAST_ENTRY_INTENT_TTL_MS, FAST_ENTRY_INTENT_TTL_MS);
  const config = parseExecutionAutoArmConfig(autoArmEnvironment());
  assert.equal(Object.isFrozen(config), true);
  assert.equal(config.phase, 'CANARY');
  assert.equal(config.httpRpcUrl, 'https://rpc.example.com/?api-key=secret');
  assert.equal(config.rpcTimeoutMs, 5_000);
  assert.equal(config.pollMs, 1_000);
  assert.equal(config.runtimeLeaseMs, 40_000);
  assert.equal(config.runtimeMaxFeeLamports, 100_000n);
  // A13: 2 x lease + 2 x RPC timeout + 5 s.
  assert.equal(config.minimumRemainingMs, 95_000);
  // The runtime parsing is shared with `arm`.
  const arm = parseExecutionCanaryArmConfig(autoArmEnvironment());
  for (const key of [
    'runtimeQuoteMaxAgeMs', 'runtimeSlippageBps', 'runtimeSnapshotMaxSlotLag',
    'runtimeMaxComputeUnits', 'runtimeMaxFeeLamports', 'runtimeMaxFeePayerLamportDebit',
    'runtimeMaxRpcCallsPerAttempt', 'runtimeLeaseMs',
  ] as const) assert.equal(config[key], arm[key], key);
  assert.equal(parseExecutionAutoArmConfig(autoArmEnvironment({
    EXECUTOR_LEASE_MS: '50000', EXECUTOR_RPC_TIMEOUT_MS: '100', EXECUTOR_AUTO_ARM_POLL_MS: '500',
  })).runtimeLeaseMs, 50_000);
  for (const changed of [
    // 2 x lease + 20 s > 120 s.
    { EXECUTOR_LEASE_MS: '50001', EXECUTOR_RPC_TIMEOUT_MS: '100', EXECUTOR_AUTO_ARM_POLL_MS: '500' },
    { EXECUTOR_LEASE_MS: '120000' },
    // The A13 margin plus one poll no longer fits in the TTL.
    { EXECUTOR_LEASE_MS: '40000', EXECUTOR_RPC_TIMEOUT_MS: '20000' },
    { SOLANA_HTTP_RPC_URL: 'http://rpc.example.com/' },
    { SOLANA_HTTP_RPC_URL: 'https://user:pass@rpc.example.com/' },
    { SOLANA_HTTP_RPC_URL: 'wss://rpc.example.com/' },
    { SOLANA_HTTP_RPC_URL: '' },
    { EXECUTOR_RPC_TIMEOUT_MS: '99' }, { EXECUTOR_RPC_TIMEOUT_MS: '30001' },
    { EXECUTOR_AUTO_ARM_POLL_MS: '499' }, { EXECUTOR_AUTO_ARM_POLL_MS: '60001' },
    { EXECUTOR_ACTIVATION_PHASE: 'MICRO_LIVE' }, { EXECUTOR_ACTIVATION_PHASE: 'PILOT' },
    { LIVE_TRADING_ENABLED: 'true' },
    { EXECUTOR_KEYPAIR_PATH: '/secret/key.json' }, { SOLANA_PRIVATE_KEY: '' },
    { EXECUTOR_EVIDENCE_PRIVATE_KEY_BASE64: 'secret' },
  ]) assert.throws(
    () => parseExecutionAutoArmConfig(autoArmEnvironment(changed)),
    (error) => error instanceof ExecutionOperationsConfigError && !error.message.includes('secret'),
    JSON.stringify(changed),
  );
  for (const key of ['SOLANA_HTTP_RPC_URL', 'EXECUTOR_RPC_TIMEOUT_MS', 'EXECUTOR_AUTO_ARM_POLL_MS',
    'EXECUTOR_LEASE_MS', 'EXECUTOR_SLIPPAGE_BPS']) {
    const missing = Object.fromEntries(
      Object.entries(autoArmEnvironment()).filter(([name]) => name !== key),
    );
    assert.throws(() => parseExecutionAutoArmConfig(missing), ExecutionOperationsConfigError, key);
  }
});

function autoArmEnvironment(overrides: Readonly<Record<string, string>> = {}) {
  return environment({
    EXECUTOR_LEASE_MS: '40000',
    SOLANA_HTTP_RPC_URL: 'https://rpc.example.com/?api-key=secret',
    EXECUTOR_RPC_TIMEOUT_MS: '5000',
    EXECUTOR_AUTO_ARM_POLL_MS: '1000',
    ...overrides,
  });
}

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
    EXECUTOR_PREFLIGHT_SOURCE_PATH: '/tmp/preflight-source.json',
    EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH: '/tmp/gate-catalog.json',
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
