import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  ExecutionPreflightPreparationConfigError,
  parseExecutionPreflightPreparationConfig,
} from '../src/executor-preflight-preparation/config.js';

const DATABASE_URL = 'postgresql://executor@127.0.0.1:5432/executor';
const EXECUTOR_PUBLIC_KEY = 'gCr8XkSUeFUxTpZE8HrZMGC98XdGGVyakeocBNTDibJ';
const EXPECTED_GENESIS_HASH = '2MPoZYQYPdDkMNKdb7Z3U6ypaiddzuNBAqKNBypSh3pN';
const OUTPUT_PATH = '/var/tmp/sol-token-listener/preflight-prepared.json';

void test('parses one explicitly enabled frozen simulation-only preparation config', () => {
  const config = parseExecutionPreflightPreparationConfig(validEnvironment(), '/application');

  assert.equal(Object.isFrozen(config), true);
  assert.deepEqual(Reflect.ownKeys(config), [
    'payloadVersion', 'enabled', 'selectionWindowMs', 'preparationLeaseMs',
    'outputPath', 'executor',
  ]);
  assert.deepEqual(config, {
    payloadVersion: 1,
    enabled: true,
    selectionWindowMs: 120_000,
    preparationLeaseMs: 60_000,
    outputPath: OUTPUT_PATH,
    executor: {
      mode: 'simulation-only',
      databaseUrl: DATABASE_URL,
      pollMs: 1_000,
      leaseMs: 35_000,
      databaseStatementTimeoutMs: 3_000,
      shutdownGraceMs: 10_000,
      executorPublicKey: EXECUTOR_PUBLIC_KEY,
      providerId: 'primary',
      httpRpcUrl: 'https://rpc.example.test',
      expectedGenesisHash: EXPECTED_GENESIS_HASH,
      quoteMaxAgeMs: 3_000,
      slippageBps: 500n,
      snapshotMaxSlotLag: 8,
      maxComputeUnits: 300_000n,
      maxFeeLamports: 100_000n,
      maxFeePayerLamportDebit: 2_500_000n,
      maxPriorityFeeLamports: 0n,
      rpcTimeoutMs: 5_000,
      maxRpcCallsPerAttempt: 8,
      quoteMintAllowlist: ['So11111111111111111111111111111111111111112'],
    },
  });
});

void test('requires explicit enablement, simulation-only mode and an external normalized path', () => {
  for (const overrides of [
    { EXECUTOR_PREFLIGHT_PREPARATION_ENABLED: undefined },
    { EXECUTOR_PREFLIGHT_PREPARATION_ENABLED: 'false' },
    { EXECUTOR_PREFLIGHT_PREPARATION_ENABLED: 'TRUE' },
    { EXECUTOR_MODE: 'dry-run' },
    { EXECUTOR_PREFLIGHT_PREPARATION_OUTPUT_PATH: 'relative.json' },
    { EXECUTOR_PREFLIGHT_PREPARATION_OUTPUT_PATH: '/application/output.json' },
    { EXECUTOR_PREFLIGHT_PREPARATION_OUTPUT_PATH: '/var/tmp/../tmp/output.json' },
  ]) assertInvalid({ ...validEnvironment(), ...overrides });
});

void test('accepts bounded timing overrides only when the preparation lease covers the intent lease', () => {
  const parsed = parseExecutionPreflightPreparationConfig({
    ...validEnvironment(),
    EXECUTOR_PREFLIGHT_PREPARATION_SELECTION_WINDOW_MS: '300000',
    EXECUTOR_PREFLIGHT_PREPARATION_LEASE_MS: '35000',
  }, '/application');
  assert.equal(parsed.selectionWindowMs, 300_000);
  assert.equal(parsed.preparationLeaseMs, 35_000);

  for (const overrides of [
    { EXECUTOR_PREFLIGHT_PREPARATION_SELECTION_WINDOW_MS: '10000' },
    { EXECUTOR_PREFLIGHT_PREPARATION_SELECTION_WINDOW_MS: '300001' },
    { EXECUTOR_PREFLIGHT_PREPARATION_SELECTION_WINDOW_MS: '0120000' },
    { EXECUTOR_PREFLIGHT_PREPARATION_LEASE_MS: '34999' },
    { EXECUTOR_PREFLIGHT_PREPARATION_LEASE_MS: '300001' },
    { EXECUTOR_PREFLIGHT_PREPARATION_LEASE_MS: '60000.0' },
  ]) assertInvalid({ ...validEnvironment(), ...overrides });
});

void test('rejects selector injection and every signing secret with one redacted error', () => {
  for (const key of [
    'EXECUTOR_PREFLIGHT_PAIR_ID',
    'EXECUTOR_PREFLIGHT_TARGET_INTENT_ID',
    'EXECUTOR_PREFLIGHT_SIMULATION_INTENT_ID',
    'EXECUTOR_PREFLIGHT_MINT',
    'EXECUTOR_PREFLIGHT_SQL',
    'EXECUTOR_PRIVATE_KEY',
    'SOLANA_KEYPAIR_PATH',
    'WALLET_PRIVATE_KEY',
  ]) assertInvalid({ ...validEnvironment(), [key]: 'sensitive-value' }, ['sensitive-value']);
});

function validEnvironment(): Record<string, string | undefined> {
  return {
    DATABASE_URL,
    EXECUTOR_MODE: 'simulation-only',
    EXECUTOR_PUBLIC_KEY,
    SOLANA_HTTP_RPC_URL: 'https://rpc.example.test',
    SOLANA_EXPECTED_GENESIS_HASH: EXPECTED_GENESIS_HASH,
    EXECUTOR_PREFLIGHT_PREPARATION_ENABLED: 'true',
    EXECUTOR_PREFLIGHT_PREPARATION_OUTPUT_PATH: OUTPUT_PATH,
  };
}

function assertInvalid(
  environment: Record<string, string | undefined>,
  forbidden: readonly string[] = [],
): void {
  assert.throws(
    () => parseExecutionPreflightPreparationConfig(environment, resolve('/application')),
    (error: unknown) => {
      assert.ok(error instanceof ExecutionPreflightPreparationConfigError);
      assert.equal(error.code, 'INVALID_EXECUTION_PREFLIGHT_PREPARATION_CONFIG');
      assert.equal(error.message, 'Invalid execution preflight preparation configuration.');
      for (const value of forbidden) assert.doesNotMatch(JSON.stringify(error), new RegExp(value, 'u'));
      return true;
    },
  );
}
