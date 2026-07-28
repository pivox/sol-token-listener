import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config/env.js';

const base = {
  SOLANA_HTTP_RPC_URL: 'https://rpc.example.invalid',
  SOLANA_WS_RPC_URL: 'wss://rpc.example.invalid',
};

void test('le mode par défaut est strictement observe', () => {
  const config = parseConfig(base);
  assert.equal(config.executionMode, 'observe');
});

void test('le mode paper est accepté avec SOL dans son allowlist initiale', () => {
  const config = parseConfig({ ...base, EXECUTION_MODE: 'paper' });
  assert.equal(config.executionMode, 'paper');
  assert.deepEqual(config.paperQuoteMintAllowlist, [config.wsolMint]);
});

void test('le live est toujours refusé dans la V1', () => {
  assert.throws(() => parseConfig({
    ...base,
    EXECUTION_MODE: 'live',
  }), /observe.*paper/u);
});

void test('toute configuration de clé privée est refusée', () => {
  assert.throws(() => parseConfig({
    ...base,
    SOLANA_KEYPAIR_PATH: '/tmp/id.json',
  }), /private key/u);
  assert.throws(() => parseConfig({
    ...base,
    SOLANA_PRIVATE_KEY_BASE58: 'secret',
  }), /private key/u);
});

void test('les actions dashboard exigent leur confirmation indépendante', () => {
  assert.throws(() => parseConfig({ ...base, DASHBOARD_ACTIONS_ENABLED: 'true' }), /read-only/u);
});

void test('le seuil de qualification est borné et vaut 60 par défaut', () => {
  assert.equal(parseConfig(base).qualificationMinimumScore, 60);
  assert.throws(
    () => parseConfig({ ...base, QUALIFICATION_MIN_SCORE: '101' }),
    /QUALIFICATION_MIN_SCORE/u,
  );
});
