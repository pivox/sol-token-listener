import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExecutionReadinessConfigError,
  parseExecutionReadinessConfig,
} from '../src/executor-readiness/config.js';

const valid = Object.freeze({
  DATABASE_URL: 'postgresql://readiness:secret@127.0.0.1:55433/listener',
  SOLANA_CLUSTER: 'mainnet-beta',
  SOLANA_HTTP_RPC_URL: 'https://mainnet.example.invalid/rpc',
  SOLANA_EXPECTED_GENESIS_HASH: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  EXECUTOR_RPC_PROVIDER_ID: 'primary',
  EXECUTOR_PUBLIC_KEY: '2LvenbX1TdhX8EbxGBmcZYiXuZFN4utA8QZY1UgGXwmZ',
  EXECUTOR_WALLET_GENERATION_NUMBER: '1',
  EXECUTOR_EVIDENCE_PUBLIC_KEY_BASE64: 'MCowBQYDK2VwAyEAqaqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=',
  EXECUTOR_PROVIDER_EVIDENCE_PATH: '/var/run/secrets/provider-evidence.json',
  EXECUTOR_READINESS_MAX_SLOT_LAG: '8',
  EXECUTOR_RPC_TIMEOUT_MS: '5000',
});

void test('parses the exact public Mainnet readiness configuration', () => {
  const result = parseExecutionReadinessConfig(valid);
  assert.equal(result.cluster, 'mainnet-beta');
  assert.equal(result.generationNumber, 1);
  assert.equal(result.maximumSlotLag, 8);
  assert.equal(result.rpcTimeoutMs, 5_000);
  assert.ok(Object.isFrozen(result));
});

void test('rejects non-Mainnet, HTTP, malformed bounds and any known live secret property', () => {
  for (const environment of [
    { ...valid, SOLANA_CLUSTER: 'devnet' },
    { ...valid, SOLANA_HTTP_RPC_URL: 'http://localhost:8899' },
    { ...valid, EXECUTOR_READINESS_MAX_SLOT_LAG: '9' },
    { ...valid, EXECUTOR_WALLET_GENERATION_NUMBER: '0' },
    { ...valid, EXECUTOR_PRIVATE_KEY: '' },
    { ...valid, WALLET_KEYPAIR_PATH: '' },
    { ...valid, RECOVERY_PHRASE: '' },
    { ...valid, LIVE_TRADING_ENABLED: 'false' },
    { ...valid, EXECUTOR_MODE: 'observe' },
  ]) assert.throws(() => parseExecutionReadinessConfig(environment),
    ExecutionReadinessConfigError);
});

