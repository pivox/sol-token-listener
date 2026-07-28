import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config/env.js';

const base = {
  SOLANA_HTTP_RPC_URL: 'https://rpc.example.invalid',
  SOLANA_WS_RPC_URL: 'wss://rpc.example.invalid',
};

void test('le mode par défaut est strictement dry-run', () => {
  const config = parseConfig(base);
  assert.equal(config.executionMode, 'dry-run');
});

void test('le live refuse de démarrer sans les quatre verrous explicites', () => {
  assert.throws(() => parseConfig({ ...base, EXECUTION_MODE: 'live' }), /SOLANA_KEYPAIR_PATH/u);
  assert.throws(() => parseConfig({ ...base, EXECUTION_MODE: 'live', SOLANA_KEYPAIR_PATH: '/tmp/id.json' }), /CONFIRM_LIVE_TRADING/u);
});

void test('le live refuse un secret base58 même si un fichier keypair est indiqué', () => {
  assert.throws(() => parseConfig({
    ...base,
    EXECUTION_MODE: 'live',
    SOLANA_KEYPAIR_PATH: '/tmp/id.json',
    SOLANA_PRIVATE_KEY_BASE58: 'secret',
    CONFIRM_LIVE_TRADING: 'I_UNDERSTAND_REAL_FUNDS',
  }), /secret base58/u);
});

void test('les actions dashboard exigent leur confirmation indépendante', () => {
  assert.throws(() => parseConfig({ ...base, DASHBOARD_ACTIONS_ENABLED: 'true' }), /confirmation locale/u);
});
