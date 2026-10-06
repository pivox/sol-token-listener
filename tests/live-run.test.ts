import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLiveVenueReady, parseLiveRunArgs, runLiveCli } from '../src/cli/live-run.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';

void test('live:run accepts only the documented bounded-session arguments', () => {
  assert.deepEqual(parseLiveRunArgs([]), { stopEntries: false });
  assert.deepEqual(parseLiveRunArgs(['--stop-entries']), { stopEntries: true });
  assert.throws(() => parseLiveRunArgs(['--test-transport']), /Unsupported live:run argument/u);
});

void test('live:run accepts only the implemented SPL/native-SOL PumpSwap profile', () => {
  assert.doesNotThrow(() => { assertLiveVenueReady([NATIVE_MINT.toBase58()]); });
  assert.throws(() => { assertLiveVenueReady([PublicKey.default.toBase58()]); }, /SPL Token or Token-2022 base tokens paired with native SOL\/wSOL/u);
});

void test('live:run fails closed on missing explicit limits before config, keyfile or transport access', async () => {
  await assert.rejects(runLiveCli([], {LIVE_ENABLE:'true'}), /LIVE_EXPECTED_GENESIS_HASH is required/u);
});

void test('live:run refuses the development database default before any RPC preflight', async () => {
  const env = {
    LIVE_ENABLE: 'true',
    LIVE_EXPECTED_GENESIS_HASH: PublicKey.default.toBase58(),
    LIVE_EXPECTED_WALLET: PublicKey.default.toBase58(),
    LIVE_KEYPAIR_FILE: '/tmp/isolated-live-test-key.json',
    LIVE_BUY_AMOUNT_LAMPORTS: '1000',
    LIVE_MAX_EXPOSURE_LAMPORTS: '1000',
    LIVE_MAX_LOSS_LAMPORTS: '500',
    LIVE_EXIT_RESERVE_LAMPORTS: '1000',
    LIVE_MAX_PRIORITY_FEE_LAMPORTS: '0',
    LIVE_MAX_SLIPPAGE_BPS: '100',
    LIVE_MAX_BUYS: '1',
    LIVE_MAX_SESSION_SECONDS: '60',
    SOLANA_HTTP_RPC_URL: 'file:///offline-no-network',
    PAPER_QUOTE_MINT_ALLOWLIST: NATIVE_MINT.toBase58(),
  };
  await assert.rejects(runLiveCli([], env), /DATABASE_URL must be explicitly provided for live/u);
});
