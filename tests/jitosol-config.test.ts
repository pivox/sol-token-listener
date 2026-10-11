import assert from 'node:assert/strict';
import test from 'node:test';
import { configFingerprint, evaluateObservation, parseJitoBotConfig, redemptionLamports, requiredRedemptionLamports } from '../src/jitosol/config.js';
import type { Observation } from '../src/jitosol/types.js';

const wallet = '11111111111111111111111111111111';
function observation(): Observation {
  const config = parseJitoBotConfig({ walletAddress: wallet });
  return {
    observedAtMs: 100_000,
    quote: { id: 'q1', receivedAtMs: 100_000, contextSlot: 100, routeSlot: 100, inputMint: 'So11111111111111111111111111111111111111112', outputMint: config.jitoMintAddress, inputLamports: '3000000000', minJitoOutUnits: '3011602740', raw: {} },
    pool: { address: config.stakePoolAddress, mint: config.jitoMintAddress, contextSlot: 100, currentEpoch: 10, lastUpdateEpoch: 10, totalLamports: '100000000000', tokenSupply: '100000000000', withdrawalFeeNumerator: '0', withdrawalFeeDenominator: '1000' },
    withdrawal: { available: true, checkedAtMs: 100_000, minimumDelegationLamports: '1000000000', stakeRentLamports: '2282880', tokenAccountRentLamports: '2039280' },
    wallet: { address: wallet, solLamports: '9000000000', jitoUnits: '0' },
  };
}

void test('Jito bot defaults disable execution and bound cycles and financial authority', () => {
  const config = parseJitoBotConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.maxCycles, 1);
  assert.equal(config.maxTotalFeesLamports, '0');
  assert.equal(config.maxRealizedLossLamports, '0');
  assert.equal(config.inputLamports, '3000000000');
  assert.equal(config.reserveLamports, '20000000');
  assert.equal(requiredRedemptionLamports(config), 3_011_602_740n);
});

void test('integer withdrawal fees round up and redemption rounds down', () => {
  assert.equal(redemptionLamports('1001', '1', '1000', '1300000', '1000000'), 1298n);
  assert.equal(redemptionLamports('1', '1', '1000', '1300000', '1000000'), 0n);
  assert.throws(() => redemptionLamports('1', '2', '1', '1', '1'));
});

void test('SPL zero-denominator withdrawal fee means no fee, including the canonical zero-over-zero form', () => {
  assert.equal(redemptionLamports('1001', '0', '0', '1300000', '1000000'), 1301n);
  assert.equal(redemptionLamports('1001', '1', '0', '1300000', '1000000'), 1301n);
  const sample = observation(); sample.pool.withdrawalFeeNumerator = '0'; sample.pool.withdrawalFeeDenominator = '0';
  assert.equal(evaluateObservation(sample, parseJitoBotConfig({ walletAddress: wallet }), 100_000).eligible, true);
});

void test('entry accepts exactly the preregistered net threshold and rejects one lamport less', () => {
  const config = parseJitoBotConfig({ walletAddress: wallet });
  const sample = observation();
  assert.equal(evaluateObservation(sample, config, 100_000).eligible, true);
  sample.quote.minJitoOutUnits = '3011602739';
  assert.equal(evaluateObservation(sample, config, 100_000).eligible, false);
});

void test('entry rejects unavailable, stale, mismatched, undersized and underfunded observations', () => {
  const config = parseJitoBotConfig({ walletAddress: wallet });
  const mutations: ((sample: Observation) => void)[] = [
    (s) => { s.withdrawal.available = false; },
    (s) => { s.withdrawal.checkedAtMs = 1; },
    (s) => { s.observedAtMs = 1; },
    (s) => { s.quote.receivedAtMs = 1; },
    (s) => { s.quote.routeSlot = 1; },
    (s) => { s.pool.contextSlot = 200; },
    (s) => { s.pool.lastUpdateEpoch = 9; },
    (s) => { s.pool.mint = wallet; },
    (s) => { s.quote.inputMint = wallet; },
    (s) => { s.quote.outputMint = wallet; },
    (s) => { s.quote.inputLamports = '1000000000'; },
    (s) => { s.wallet.address = config.jitoMintAddress; },
    (s) => { s.wallet.solLamports = '3019999999'; },
    (s) => { s.withdrawal.minimumDelegationLamports = '4000000000'; },
    (s) => { s.pool.tokenSupply = '0'; },
    (s) => { s.quote.minJitoOutUnits = 'NaN'; },
  ];
  for (const mutate of mutations) {
    const sample = observation(); mutate(sample);
    assert.equal(evaluateObservation(sample, config, 100_000).eligible, false);
  }
});

void test('config rejects unsafe coercions, changed stake amount, and noncanonical mint/pool', () => {
  for (const invalid of [
    { enabled: 'true' }, { enabled: true }, { inputLamports: '1000000000' },
    { walletAddress: 'broken' }, { maxTotalFeesLamports: 100 },
    { maxTotalFeesLamports: '-1' }, { maxCycles: 0 }, { unexpected: true },
    { jitoMintAddress: wallet }, { stakePoolAddress: wallet }, { confirmationDelayMs: 9999 },
    { minProfitLamports: '8999999' }, { networkBudgetLamports: '999999' },
  ]) assert.throws(() => parseJitoBotConfig(invalid), JSON.stringify(invalid));
});

void test('config fingerprint binds wallet and risk settings but permits disabled inspection', () => {
  const config = parseJitoBotConfig({ walletAddress: wallet });
  assert.equal(configFingerprint(config), configFingerprint({ ...config, enabled: true }));
  assert.notEqual(configFingerprint(config), configFingerprint({ ...config, maxCycles: 2 }));
  assert.notEqual(configFingerprint(config), configFingerprint({ ...config, walletAddress: config.jitoMintAddress }));
});
