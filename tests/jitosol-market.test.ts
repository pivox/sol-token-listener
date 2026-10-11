import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { parseJitoBotConfig } from '../src/jitosol/config.js';
import { JupiterClient, JITOSOL_MINT, SOL_MINT, type JupiterQuote } from '../src/jitosol/jupiter.js';
import { observeMarket } from '../src/jitosol/market.js';
import { JITO_POOL_ADDRESS } from '../src/jitosol/stake-pool.js';

const archive = JSON.parse(readFileSync(new URL('./fixtures/jitosol/stake-pool-public.json', import.meta.url), 'utf8')) as {
  slot: number; epoch: number; account: { owner: string; data: [string, string]; lamports: number };
};

function fixture() {
  let now = 100_000;
  let poolSlot = archive.slot;
  let epoch = archive.epoch;
  const calls: string[] = [];
  const account: AccountInfo<Buffer> = { owner: new PublicKey(archive.account.owner), data: Buffer.from(archive.account.data[0], 'base64'), lamports: archive.account.lamports, executable: false, rentEpoch: 0 };
  const raw = {
    inputMint: SOL_MINT.toBase58(), outputMint: JITOSOL_MINT.toBase58(), swapMode: 'ExactIn', instructionVersion: 'V1',
    inAmount: '3000000000', outAmount: '2299035436', otherAmountThreshold: '2296736401', slippageBps: 10,
    platformFee: null, priceImpactPct: '0.0002', contextSlot: archive.slot,
    routePlan: [{ percent: 100, swapInfo: { ammKey: JITO_POOL_ADDRESS.toBase58(), label: 'Whirlpool', inputMint: SOL_MINT.toBase58(), outputMint: JITOSOL_MINT.toBase58(), inAmount: '3000000000', outAmount: '2299035436', updateContextSlot: archive.slot - 1 } }],
  };
  const client = new JupiterClient({ now: () => now, fetch: async () => { calls.push('quote'); return Response.json(raw); } });
  const connection: Pick<Connection, 'getAccountInfoAndContext' | 'getEpochInfo'> = {
    async getAccountInfoAndContext(address, options) {
      assert.equal(address.toBase58(), JITO_POOL_ADDRESS.toBase58(), 'only the public pool may be read');
      assert.deepEqual(options, { commitment: 'confirmed', minContextSlot: archive.slot });
      calls.push('pool');
      return { context: { slot: poolSlot }, value: account };
    },
    async getEpochInfo(options) {
      assert.deepEqual(options, { commitment: 'confirmed', minContextSlot: archive.slot });
      calls.push('epoch');
      return { epoch, absoluteSlot: poolSlot, slotIndex: 1, slotsInEpoch: 432_000 };
    },
  };
  return { client, connection, calls, raw, account, now: () => now,
    advance: (ms: number) => { now += ms; }, setPoolSlot: (slot: number) => { poolSlot = slot; }, setEpoch: (value: number) => { epoch = value; },
  };
}

void test('public observation uses the conservative Jupiter floor and archived integer pool state without wallet calls', async () => {
  const f = fixture();
  const result = await observeMarket({ connection: f.connection, jupiter: f.client, config: parseJitoBotConfig({}), now: f.now });
  assert.equal(result.status, 'observed');
  assert.equal(result.walletChecked, false); assert.equal(result.withdrawalChecked, false); assert.equal(result.executable, false);
  assert.equal(result.minimumJitoOutUnits, '2296736400', 'one unit below the rounded-up API threshold');
  assert.equal(result.minimumRedemptionLamports, '2995888152');
  assert.equal(result.requiredRedemptionLamports, '3011602740');
  assert.equal(result.arithmeticThresholdMet, false);
  assert.equal(result.netSurplusAfterBudgetAndCarryLamports, '-6714588');
  assert.deepEqual(result.freshness, { quote: 'fresh', route: 'fresh', poolQuote: 'fresh', quoteAgeMs: 0, maxRouteSlotLag: 1, poolQuoteSlotGap: 0, allProven: true });
  assert.equal(f.calls[0], 'quote'); assert.deepEqual(f.calls.slice(1).sort(), ['epoch', 'pool']);
  assert.doesNotThrow(() => JSON.stringify(result), 'output contains no BigInt values');
});

void test('missing route update slot remains unproven even when public arithmetic passes the threshold', async () => {
  const f = fixture(); const quote = await f.client.getQuote();
  const generous: JupiterQuote = { ...quote, minimumOutputAtomic: 3_000_000_000n, expectedOutputAtomic: 3_100_000_000n, routePlan: quote.routePlan.map((route) => ({ ...route, updateContextSlot: null })) };
  const result = await observeMarket({ connection: f.connection, jupiter: { getQuote: async () => generous }, config: parseJitoBotConfig({}), now: f.now });
  assert.equal(result.arithmeticThresholdMet, true);
  assert.equal(result.executable, false); assert.equal(result.withdrawalChecked, false);
  assert.equal((result.freshness as Record<string, unknown>).route, 'unproven');
  assert.equal((result.freshness as Record<string, unknown>).allProven, false);
});

void test('public observation marks quote age, route source gap and pool context gap as stale', async () => {
  const f = fixture(); const quote = await f.client.getQuote(); f.advance(6_000); f.setPoolSlot(archive.slot + 100);
  const stale: JupiterQuote = { ...quote, routePlan: quote.routePlan.map((route) => ({ ...route, updateContextSlot: archive.slot - 100 })) };
  const result = await observeMarket({ connection: f.connection, jupiter: { getQuote: async () => stale }, config: parseJitoBotConfig({}), now: f.now });
  assert.deepEqual(result.freshness, { quote: 'stale', route: 'stale', poolQuote: 'stale', quoteAgeMs: 6_000, maxRouteSlotLag: 100, poolQuoteSlotGap: 100, allProven: false });
  assert.equal(result.executable, false);
});

void test('public observation rejects stale pool epoch and wrong pool owner', async () => {
  const f = fixture(); f.setEpoch(archive.epoch + 1);
  await assert.rejects(observeMarket({ connection: f.connection, jupiter: f.client, config: parseJitoBotConfig({}), now: f.now }), /epoch/);
  const g = fixture(); g.account.owner = PublicKey.default;
  await assert.rejects(observeMarket({ connection: g.connection, jupiter: g.client, config: parseJitoBotConfig({}), now: g.now }), /owner/);
});

void test('public observation rejects a different quote ticket before reading the pool', async () => {
  const f = fixture(); const quote = await f.client.getQuote(); f.calls.length = 0;
  await assert.rejects(observeMarket({ connection: f.connection, jupiter: { getQuote: async () => ({ ...quote, inputLamports: 1n }) }, config: parseJitoBotConfig({}), now: f.now }), /input.*amount/);
  assert.deepEqual(f.calls, []);
});
