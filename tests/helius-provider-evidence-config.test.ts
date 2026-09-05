import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HeliusProviderEvidenceConfigError,
  parseHeliusProviderEvidenceConfig,
} from '../src/provider-evidence/config.js';

const valid = Object.freeze({
  HELIUS_PROJECT_ID: 'a1b2c3d4-e5f6-4890-abcd-ef1234567890',
  HELIUS_API_KEY_PATH: '/var/run/secrets/helius-api-key',
  EXECUTOR_RPC_PROVIDER_ID: 'helius-primary',
  EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH: '/var/run/secrets/provider-key.pem',
  EXECUTOR_PROVIDER_EVIDENCE_PATH: '/var/run/evidence/provider-evidence.json',
  EXECUTOR_PROVIDER_EVIDENCE_TTL_MS: '300000',
  EXECUTOR_PROVIDER_EVIDENCE_TIMEOUT_MS: '5000',
});

void test('parses the isolated Helius evidence producer configuration', () => {
  const result = parseHeliusProviderEvidenceConfig(valid);
  assert.equal(result.projectId, valid.HELIUS_PROJECT_ID);
  assert.equal(result.ttlMs, 300_000);
  assert.equal(result.timeoutMs, 5_000);
  assert.ok(Object.isFrozen(result));
});

void test('rejects bounds, relative paths, aliases and every wallet/live variable name', () => {
  for (const environment of [
    { ...valid, HELIUS_API_KEY_PATH: './api-key' },
    { ...valid, EXECUTOR_PROVIDER_EVIDENCE_TTL_MS: '29999' },
    { ...valid, EXECUTOR_PROVIDER_EVIDENCE_TTL_MS: '300001' },
    { ...valid, EXECUTOR_PROVIDER_EVIDENCE_TIMEOUT_MS: '99' },
    { ...valid, HELIUS_PROJECT_ID: 'not-a-uuid' },
    { ...valid, HELIUS_API_KEY: 'secret' },
    { ...valid, EXECUTOR_KEYPAIR_PATH: '' },
    { ...valid, WALLET_PRIVATE_KEY: '' },
    { ...valid, MNEMONIC: '' },
    { ...valid, LIVE_TRADING_ENABLED: 'false' },
    { ...valid, EXECUTOR_MODE: 'dry-run' },
    { ...valid, SOLANA_HTTP_RPC_URL: 'https://example.invalid' },
    { ...valid, DATABASE_URL: 'postgresql://example.invalid/db' },
  ]) assert.throws(() => parseHeliusProviderEvidenceConfig(environment),
    HeliusProviderEvidenceConfigError);
});

void test('rejects every secret or output path inside the application checkout', () => {
  for (const replacement of [
    { HELIUS_API_KEY_PATH: `${process.cwd()}/secrets/api-key` },
    { EXECUTOR_EVIDENCE_PRIVATE_KEY_PATH: `${process.cwd()}/secrets/evidence.pem` },
    { EXECUTOR_PROVIDER_EVIDENCE_PATH: `${process.cwd()}/evidence/provider.json` },
  ]) assert.throws(() => parseHeliusProviderEvidenceConfig({ ...valid, ...replacement }),
    HeliusProviderEvidenceConfigError);
});
