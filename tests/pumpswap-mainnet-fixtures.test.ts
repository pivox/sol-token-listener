import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decodePumpTransaction } from '../src/launchpads/pumpfun/transaction-decoder.js';
import { decodePumpSwapTransaction } from '../src/markets/pumpswap/transaction-decoder.js';
import { loadMainnetFixture } from './helpers/pumpfun-fixture.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

void test('proves finalized migrate_v2 and canonical PumpSwap create_pool pairing offline', async () => {
  const fixture = await loadMainnetFixture('pumpswap', 'migrate-v2-create-pool-mainnet.json');
  const pump = decodePumpTransaction(fixture.transaction);
  const swap = decodePumpSwapTransaction(fixture.transaction);

  assert.equal(fixture.provenance.transactionIndex, 121);
  assert.equal(fixture.transaction.confirmationStatus, 'FINALIZED');
  assert.equal(pump.migrations.length, 1);
  assert.equal(swap.poolCreations.length, 1);
  assert.deepEqual(swap.issues, []);
  const migration = pump.migrations[0];
  const pool = swap.poolCreations[0];
  assert.ok(migration);
  assert.ok(pool);
  assert.equal(migration.instruction, 'MIGRATE_V2');
  assert.equal(migration.baseTokenProgram, 'TOKEN_2022');
  assert.equal(migration.quoteAsset.mint, WSOL_MINT);
  assert.equal(migration.action.instruction.stackHeight, 1);
  assert.equal(pool.action.name, 'create_pool');
  assert.equal(pool.action.instruction.stackHeight, 2);
  assert.equal(pool.event.instruction.stackHeight, 3);
  assert.equal(pool.index, 0n);
  assert.equal(pool.baseMint, migration.mint);
  assert.equal(pool.quoteMint, migration.quoteAsset.mint);
  assert.equal(pool.pool, migration.announcedPool);
});

void test('decodes a current finalized PumpSwap sell with non-WSOL quote direction', async () => {
  const fixture = await loadMainnetFixture('pumpswap', 'sell-mainnet.json');
  const decoded = decodePumpSwapTransaction(fixture.transaction);

  assert.equal(fixture.provenance.transactionIndex, 1424);
  assert.equal(fixture.transaction.confirmationStatus, 'FINALIZED');
  assert.equal(decoded.poolCreations.length, 0);
  assert.equal(decoded.trades.length, 1);
  assert.deepEqual(decoded.issues, []);
  const trade = decoded.trades[0];
  assert.ok(trade);
  assert.equal(trade.action.name, 'sell');
  assert.equal(trade.kind, 'SELL');
  assert.equal(trade.action.instruction.stackHeight, 1);
  assert.equal(trade.event.instruction.stackHeight, 2);
  assert.equal(trade.baseMint, WSOL_MINT);
  assert.notEqual(trade.quoteMint, WSOL_MINT);
  assert.equal(trade.baseAmountRaw, 1_937_887n);
  assert.equal(trade.quoteAmountRaw, 10_730_229_564n);
});

void test('committed mainnet evidence contains no excluded transport or wallet fields', async () => {
  for (const family of ['pumpfun', 'pumpswap'] as const) {
    const names = family === 'pumpfun'
      ? [
          'create-v2-initial-buy-mainnet.json',
          'sell-cpi-mainnet.json',
          'buy-exact-quote-v2-cpi-mainnet.json',
        ]
      : ['migrate-v2-create-pool-mainnet.json', 'sell-mainnet.json'];
    for (const name of names) {
      const raw = await readFile(new URL(`./fixtures/${family}/${name}`, import.meta.url), 'utf8');
      assert.doesNotMatch(
        raw,
        /"(?:rpcUrl|httpRpcUrl|wsRpcUrl|headers|logMessages|logs|accountKeys|signerKeys|preBalancesLamports|postBalancesLamports|privateKey)"\s*:/iu,
        `${family}/${name}`,
      );
      const fixture = await loadMainnetFixture(family, name);
      assert.equal(fixture.family, family);
      assert.equal(fixture.sanitization.anonymized, false);
    }
  }
});
