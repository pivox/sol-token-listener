import assert from 'node:assert/strict';
import test from 'node:test';
import { OperatorApiConfigError, parseOperatorApiConfig } from '../src/operator-api/config.js';

const ENVIRONMENT = Object.freeze({
  OPERATOR_API_DATABASE_URL: 'postgresql://operator:secret@127.0.0.1:5432/sol_token_listener',
  OPERATOR_API_TOKEN: 'a'.repeat(32),
  OPERATOR_API_ALLOWED_ORIGIN: 'http://127.0.0.1:4173',
  SOLANA_HTTP_RPC_URL: 'https://rpc.example/key',
});

void test('parses the operator API environment with loopback defaults', () => {
  assert.deepEqual(parseOperatorApiConfig(ENVIRONMENT), {
    databaseUrl: ENVIRONMENT.OPERATOR_API_DATABASE_URL,
    token: ENVIRONMENT.OPERATOR_API_TOKEN,
    host: '127.0.0.1',
    port: 3100,
    allowedOrigin: 'http://127.0.0.1:4173',
    solanaHttpRpcUrl: 'https://rpc.example/key',
  });
  assert.deepEqual(
    parseOperatorApiConfig({ ...ENVIRONMENT, OPERATOR_API_HOST: 'localhost', OPERATOR_API_PORT: '3999' }),
    { ...parseOperatorApiConfig(ENVIRONMENT), host: 'localhost', port: 3999 },
  );
});

void test('rejects a short token, a bad origin, a bad port and missing variables', () => {
  for (const changed of [
    { OPERATOR_API_TOKEN: 'a'.repeat(31) },
    { OPERATOR_API_TOKEN: `${'a'.repeat(31)} ` },
    { OPERATOR_API_ALLOWED_ORIGIN: 'http://127.0.0.1:4173/' },
    { OPERATOR_API_ALLOWED_ORIGIN: 'http://127.0.0.1:4173/console' },
    { OPERATOR_API_ALLOWED_ORIGIN: '*' },
    { OPERATOR_API_PORT: '0' },
    { OPERATOR_API_PORT: '65536' },
    { OPERATOR_API_PORT: '3100.5' },
    { OPERATOR_API_HOST: '::1' },
    { OPERATOR_API_DATABASE_URL: 'mysql://operator@db/x' },
    { SOLANA_HTTP_RPC_URL: 'wss://rpc.example' },
  ]) {
    assert.throws(() => parseOperatorApiConfig({ ...ENVIRONMENT, ...changed }),
      OperatorApiConfigError, JSON.stringify(changed));
  }
  for (const key of Object.keys(ENVIRONMENT)) {
    const { [key as keyof typeof ENVIRONMENT]: _removed, ...rest } = ENVIRONMENT;
    assert.throws(() => parseOperatorApiConfig(rest), OperatorApiConfigError, key);
  }
  assert.throws(() => parseOperatorApiConfig(null), OperatorApiConfigError);
});

void test('refuses any keypair, live-mode or arming variable in the process environment', () => {
  for (const key of [
    'EXECUTOR_KEYPAIR_PATH', 'SOLANA_PRIVATE_KEY', 'WALLET_SECRET_KEY', 'LIVE_TRADING_ENABLED',
    'EXECUTOR_MODE', 'EXECUTOR_ARMAMENT_ID', 'EXECUTOR_RECOVERY_PHRASE',
  ]) {
    assert.throws(() => parseOperatorApiConfig({ ...ENVIRONMENT, [key]: 'x' }),
      OperatorApiConfigError, key);
  }
});

void test('the configuration error carries no secret', () => {
  try {
    parseOperatorApiConfig({ ...ENVIRONMENT, OPERATOR_API_TOKEN: 'short' });
    assert.fail('expected rejection');
  } catch (error) {
    assert.ok(error instanceof OperatorApiConfigError);
    assert.equal(error.message.includes('short'), false);
    assert.equal(error.message.includes('secret'), false);
  }
});
