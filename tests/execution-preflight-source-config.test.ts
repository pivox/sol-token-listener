import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExecutionPreflightSourceConfig } from '../src/preflight-source/config.js';

const ENV = Object.freeze({
  DATABASE_URL: 'postgresql://reader:secret@127.0.0.1:5432/listener',
  EXECUTOR_PREFLIGHT_PREPARATION_RUN_ID:
    `execution_preflight_preparation_${'a'.repeat(64)}`,
  EXECUTOR_PREFLIGHT_SOURCE_PATH: '/var/run/preflight/source.json',
});

void test('parses only explicit persistent identities and one external output', () => {
  assert.deepEqual(parseExecutionPreflightSourceConfig(ENV, '/app'), {
    databaseUrl: ENV.DATABASE_URL,
    preparationRunId: ENV.EXECUTOR_PREFLIGHT_PREPARATION_RUN_ID,
    outputPath: ENV.EXECUTOR_PREFLIGHT_SOURCE_PATH,
  });
});

void test('rejects checkout output, noncanonical IDs and every external capability', () => {
  assert.throws(() => parseExecutionPreflightSourceConfig(Object.freeze({ ...ENV,
    EXECUTOR_PREFLIGHT_SOURCE_PATH: '/app/source.json',
  }), '/app'));
  assert.throws(() => parseExecutionPreflightSourceConfig(Object.freeze({ ...ENV,
    EXECUTOR_PREFLIGHT_PREPARATION_RUN_ID: 'latest',
  }), '/app'));
  for (const key of ['SOLANA_HTTP_RPC_URL', 'SOLANA_WS_RPC_URL', 'HELIUS_API_KEY',
    'EXECUTOR_KEYPAIR_PATH', 'EXECUTOR_PUBLIC_KEY', 'LIVE_TRADING_ENABLED',
    'EXECUTOR_MODE', 'EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH',
    'EXECUTOR_PREFLIGHT_GENERATION_ID', 'EXECUTOR_PREFLIGHT_TARGET_INTENT_ID',
    'EXECUTOR_PREFLIGHT_SIMULATION_ARTIFACT_ID']) {
    assert.throws(() => parseExecutionPreflightSourceConfig(
      Object.freeze({ ...ENV, [key]: 'forbidden' }), '/app'));
  }
});
