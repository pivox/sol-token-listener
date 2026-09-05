import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExecutionPreflightDraftConfig } from '../src/preflight-draft/config.js';

const ENV = Object.freeze({
  EXECUTOR_PREFLIGHT_SOURCE_PATH: '/var/run/preflight/source.json',
  EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH: '/var/run/preflight/gates.json',
  EXECUTOR_PREFLIGHT_DRAFT_PATH: '/var/run/preflight/draft.json',
});

void test('parses only three isolated offline paths', () => {
  assert.deepEqual(parseExecutionPreflightDraftConfig(ENV, '/app'), {
    sourcePath: ENV.EXECUTOR_PREFLIGHT_SOURCE_PATH,
    gateCatalogPath: ENV.EXECUTOR_PREFLIGHT_GATE_CATALOG_PATH,
    outputPath: ENV.EXECUTOR_PREFLIGHT_DRAFT_PATH,
  });
});

void test('rejects checkout, duplicate and runtime-authority paths', () => {
  assert.throws(() => parseExecutionPreflightDraftConfig(Object.freeze({ ...ENV,
    EXECUTOR_PREFLIGHT_SOURCE_PATH: '/app/source.json',
  }), '/app'));
  assert.throws(() => parseExecutionPreflightDraftConfig(Object.freeze({ ...ENV,
    EXECUTOR_PREFLIGHT_DRAFT_PATH: ENV.EXECUTOR_PREFLIGHT_SOURCE_PATH,
  }), '/app'));
  for (const key of ['DATABASE_URL', 'SOLANA_HTTP_RPC_URL', 'HELIUS_API_KEY',
    'HELIUS_PROJECT_ID', 'EXECUTOR_KEYPAIR_PATH', 'EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH',
    'LIVE_TRADING_ENABLED', 'EXECUTOR_MODE']) {
    assert.throws(() => parseExecutionPreflightDraftConfig(
      Object.freeze({ ...ENV, [key]: 'forbidden' }), '/app'));
  }
});
