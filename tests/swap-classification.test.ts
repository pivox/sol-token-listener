import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransactionSwaps, createSwapEventId } from '../src/dex/raydium-cpmm/swap-classifier.js';
import { loadSwapFixture } from './helpers/fixture.js';

const PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';

void test('classe un BUY Token-2022 par deltas réels des vaults', async () => {
  const { pool, transaction } = await loadSwapFixture('buy-token2022-mainnet.json');
  const events = classifyTransactionSwaps(transaction, PROGRAM, [pool]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'BUY');
  assert.equal(events[0].amountWsolRaw, 90_000_000n);
  assert.equal(events[0].amountTokenRaw, 507_380_634_821_292n);
});

void test('classe un SELL V0 invoqué par CPI et conserve les index intra-slot', async () => {
  const { pool, transaction } = await loadSwapFixture('sell-token2022-v0-cpi-mainnet.json');
  const [event] = classifyTransactionSwaps(transaction, PROGRAM, [pool]);
  assert.ok(event);
  assert.equal(event.kind, 'SELL');
  assert.equal(event.amountTokenRaw, 344_448n);
  assert.equal(event.amountWsolRaw, 15_742n);
  assert.equal(event.cursor.transactionIndex, 478);
  assert.equal(event.cursor.innerInstructionIndex, 11);
});

void test('ignore une transaction échouée', async () => {
  const { pool, transaction } = await loadSwapFixture('buy-token2022-mainnet.json');
  transaction.error = { InstructionError: [1, 'Custom'] };
  assert.deepEqual(classifyTransactionSwaps(transaction, PROGRAM, [pool]), []);
});

void test('ignore un pool ou des vaults qui ne correspondent pas à l’instruction', async () => {
  const { pool, transaction } = await loadSwapFixture('buy-token2022-mainnet.json');
  pool.wsolVault = 'VaultIncorrect111111111111111111111111111111111';
  assert.deepEqual(classifyTransactionSwaps(transaction, PROGRAM, [pool]), []);
});

void test('construit un identifiant de swap déterministe et distinct par instruction interne', () => {
  const a = createSwapEventId('pool', 'signature', 2, 3);
  const b = createSwapEventId('pool', 'signature', 2, 4);
  assert.equal(a, createSwapEventId('pool', 'signature', 2, 3));
  assert.notEqual(a, b);
});
