import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExecutionPreflightBundleConfig } from '../src/preflight-bundle/config.js';

const ENV = Object.freeze({
  EXECUTOR_PREFLIGHT_DRAFT_PATH: '/var/run/preflight/draft.json',
  EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH: '/var/run/preflight/evidence.pem',
  EXECUTOR_PREFLIGHT_BUNDLE_OUTPUT_DIRECTORY: '/var/run/preflight/bundle-1',
});

void test('parses only the isolated offline preflight bundle paths', () => {
  assert.deepEqual(parseExecutionPreflightBundleConfig(ENV, '/app'), {
    draftPath: ENV.EXECUTOR_PREFLIGHT_DRAFT_PATH,
    privateKeyPath: ENV.EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH,
    outputDirectory: ENV.EXECUTOR_PREFLIGHT_BUNDLE_OUTPUT_DIRECTORY,
  });
});

void test('rejects checkout paths, duplicate paths and runtime authority', () => {
  assert.throws(() => parseExecutionPreflightBundleConfig(Object.freeze({
    ...ENV, EXECUTOR_PREFLIGHT_DRAFT_PATH: '/app/draft.json',
  }), '/app'));
  assert.throws(() => parseExecutionPreflightBundleConfig(Object.freeze({
    ...ENV, EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH: ENV.EXECUTOR_PREFLIGHT_DRAFT_PATH,
  }), '/app'));
  for (const extra of ['DATABASE_URL', 'SOLANA_HTTP_RPC_URL', 'EXECUTOR_KEYPAIR_PATH',
    'LIVE_TRADING_ENABLED', 'EXECUTOR_MODE']) {
    assert.throws(() => parseExecutionPreflightBundleConfig(Object.freeze({
      ...ENV, [extra]: 'forbidden',
    }), '/app'));
  }
});

