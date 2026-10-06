import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseLivePolicy } from '../src/live/live-policy.js';
import { liveConfigSummary } from '../src/cli/live-config-check.js';

const valid = {
  LIVE_ENABLE: 'true',
  LIVE_EXPECTED_GENESIS_HASH: '11111111111111111111111111111111',
  LIVE_EXPECTED_WALLET: '11111111111111111111111111111111',
  LIVE_KEYPAIR_FILE: '/run/secrets/solana-live.json',
  LIVE_BUY_AMOUNT_LAMPORTS: '1000000',
  LIVE_MAX_EXPOSURE_LAMPORTS: '1000000',
  LIVE_MAX_LOSS_LAMPORTS: '500000',
  LIVE_EXIT_RESERVE_LAMPORTS: '1000000',
  LIVE_MAX_PRIORITY_FEE_LAMPORTS: '2',
  LIVE_MAX_SLIPPAGE_BPS: '100',
  LIVE_MAX_BUYS: '1',
  LIVE_MAX_SESSION_SECONDS: '300',
};

void test('live activation and every monetary/session limit must be explicit', () => {
  assert.throws(() => parseLivePolicy({}), /LIVE_ENABLE/u);
  assert.throws(() => parseLivePolicy({ ...valid, LIVE_ENABLE: 'false' }), /LIVE_ENABLE/u);
  assert.throws(() => parseLivePolicy({ ...valid, LIVE_MAX_EXPOSURE_LAMPORTS: undefined }), /LIVE_MAX_EXPOSURE_LAMPORTS/u);
});

void test('initial live policy is bounded to one purchase and rejects incoherent limits', () => {
  assert.throws(() => parseLivePolicy({ ...valid, LIVE_MAX_BUYS: '2' }), /LIVE_MAX_BUYS/u);
  assert.throws(() => parseLivePolicy({ ...valid, LIVE_MAX_EXPOSURE_LAMPORTS: '999999' }), /exposure/iu);
  assert.throws(() => parseLivePolicy({ ...valid, LIVE_EXIT_RESERVE_LAMPORTS: '0' }), /LIVE_EXIT_RESERVE_LAMPORTS/u);
  assert.throws(() => parseLivePolicy({ ...valid, LIVE_MAX_PRIORITY_FEE_LAMPORTS: undefined }), /LIVE_MAX_PRIORITY_FEE_LAMPORTS/u);
  assert.throws(() => parseLivePolicy({ ...valid, LIVE_MAX_PRIORITY_FEE_LAMPORTS: '-1' }), /LIVE_MAX_PRIORITY_FEE_LAMPORTS/u);
  assert.throws(() => parseLivePolicy({ ...valid, LIVE_EXIT_RESERVE_LAMPORTS: '1', LIVE_MAX_PRIORITY_FEE_LAMPORTS: '2' }), /LIVE_EXIT_RESERVE_LAMPORTS must exceed LIVE_MAX_PRIORITY_FEE_LAMPORTS/u);
  assert.throws(() => parseLivePolicy({ ...valid, LIVE_EXIT_RESERVE_LAMPORTS: '2', LIVE_MAX_PRIORITY_FEE_LAMPORTS: '2' }), /LIVE_EXIT_RESERVE_LAMPORTS must exceed LIVE_MAX_PRIORITY_FEE_LAMPORTS/u);
  assert.throws(() => parseLivePolicy({ ...valid, LIVE_MAX_SLIPPAGE_BPS: '10001' }), /LIVE_MAX_SLIPPAGE_BPS/u);
});

void test('policy parser has no signer side effect and returns exact integer limits', () => {
  const policy = parseLivePolicy({ ...valid, LIVE_SECRET_KEY: 'must-not-be-read' });
  assert.equal(parseLivePolicy({ ...valid, LIVE_MAX_PRIORITY_FEE_LAMPORTS: '0' }).maxPriorityFeeLamports, 0n);
  assert.equal('signer' in policy, false);
  assert.deepEqual({
    maxBuys: policy.maxBuys,
    maxConcurrentPositions: policy.maxConcurrentPositions,
    buyAmountLamports: policy.buyAmountLamports,
    maxExposureLamports: policy.maxExposureLamports,
    maxLossLamports: policy.maxLossLamports,
    exitReserveLamports: policy.exitReserveLamports,
    maxPriorityFeeLamports: policy.maxPriorityFeeLamports,
    maxSlippageBps: policy.maxSlippageBps,
    maxSessionSeconds: policy.maxSessionSeconds,
  }, {
    maxBuys: 1,
    maxConcurrentPositions: 1,
    buyAmountLamports: 1_000_000n,
    maxExposureLamports: 1_000_000n,
    maxLossLamports: 500_000n,
    exitReserveLamports: 1_000_000n,
    maxPriorityFeeLamports: 2n,
    maxSlippageBps: 100,
    maxSessionSeconds: 300,
  });
});

void test('config check emits no key path or secret and states that it is not trade readiness', () => {
  const summary = liveConfigSummary({ ...valid, LIVE_SECRET_KEY: 'must-not-be-read' });
  assert.equal(summary.result, 'CONFIGURATION_VALID_ONLY');
  assert.equal(summary.maxPriorityFeeLamports, '2');
  assert.equal(JSON.stringify(summary).includes('/run/secrets'), false);
  assert.equal(JSON.stringify(summary).includes('must-not-be-read'), false);
});

void test('live configuration CLI stays outside dotenv, signer, and transaction submission imports', async () => {
  const source = await readFile(new URL('../src/cli/live-config-check.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /dotenv|Keypair|WalletSigner|sendTransaction|sendRawTransaction|signTransaction|simulateTransaction/u);
});

void test('policy accepts only a temporary external key path and never reads its contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fake-live-key-'));
  const keyPath = join(directory, 'wallet.json');
  const sentinel = 'FAKE_PRIVATE_KEY_SENTINEL_47f9';
  try {
    await writeFile(keyPath, JSON.stringify({ sentinel }), { mode: 0o600 });
    const policy = parseLivePolicy({ ...valid, LIVE_KEYPAIR_FILE: keyPath }, process.cwd());
    assert.equal(policy.keypairFile, keyPath);
    assert.equal(JSON.stringify(policy, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value).includes(sentinel), false);
    assert.equal('signer' in policy, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
