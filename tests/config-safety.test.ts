import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

void test('l’API publique est activée localement avec des limites sûres par défaut', () => {
  const config = parseConfig(base);
  assert.equal(config.apiEnabled, true);
  assert.equal(config.apiHost, '127.0.0.1');
  assert.equal(config.apiPort, 3_000);
  assert.equal(config.apiPageLimitDefault, 50);
  assert.equal(config.apiPageLimitMaximum, 200);
  assert.equal(config.apiHolderPositionLimit, 100);
  assert.equal(config.apiHolderSnapshotLimit, 100);
  assert.equal(config.apiWalletClusterLimit, 50);
  assert.equal(config.apiWalletClusterMemberLimit, 50);
  assert.equal(config.apiWalletClusterTotalMemberLimit, 500);
  assert.equal(config.apiSseHeartbeatMs, 15_000);
  assert.equal(config.apiSsePollMs, 1_000);
});

void test('la configuration API refuse les valeurs ambiguës ou hors limites', () => {
  const invalid: readonly Record<string, string>[] = [
    { API_ENABLED: '1' },
    { API_HOST: ' localhost' },
    { API_HOST: 'http://localhost' },
    { API_HOST: '127.0.0.1/path' },
    { API_PORT: '0' },
    { API_PORT: '65536' },
    { API_PAGE_LIMIT_DEFAULT: '201' },
    { API_PAGE_LIMIT_MAX: '201' },
    { API_PAGE_LIMIT_DEFAULT: '51', API_PAGE_LIMIT_MAX: '50' },
    { API_SSE_HEARTBEAT_MS: '999' },
    { API_SSE_POLL_MS: '99' },
    { API_HOLDER_POSITION_LIMIT: '501' },
    { API_HOLDER_SNAPSHOT_LIMIT: '501' },
    { API_WALLET_CLUSTER_LIMIT: '101' },
    { API_WALLET_CLUSTER_MEMBER_LIMIT: '101' },
    { API_WALLET_CLUSTER_TOTAL_MEMBER_LIMIT: '1001' },
  ];
  for (const values of invalid) assert.throws(() => parseConfig({ ...base, ...values }));
});

void test('le modèle d’environnement publie les valeurs API sûres exactes', async () => {
  const source = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  for (const line of [
    'API_ENABLED=true', 'API_HOST=127.0.0.1', 'API_PORT=3000',
    'API_PAGE_LIMIT_DEFAULT=50', 'API_PAGE_LIMIT_MAX=200',
    'API_SSE_HEARTBEAT_MS=15000', 'API_SSE_POLL_MS=1000',
    'API_HOLDER_POSITION_LIMIT=100', 'API_HOLDER_SNAPSHOT_LIMIT=100',
    'API_WALLET_CLUSTER_LIMIT=50', 'API_WALLET_CLUSTER_MEMBER_LIMIT=50',
    'API_WALLET_CLUSTER_TOTAL_MEMBER_LIMIT=500',
  ]) assert.match(source, new RegExp(`^${line}$`, 'mu'));
});
