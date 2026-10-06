import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseMarketPoolOperatorCommand,
  planMarketPoolReseed,
  truncateSignature,
} from '../src/cli/market-pool-checkpoint-operator.js';

const POOL = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const checkpoint = { poolAddress: POOL, slot: 100n, signature: 'a'.repeat(88) };
const frontier = { slot: 200n, signature: 'b'.repeat(88) };
const ready = { checkpoint, frontier, genesisHash: GENESIS, expectedGenesisHash: GENESIS, confirmed: true };

void test('parses an inspect command', () => {
  assert.deepEqual(parseMarketPoolOperatorCommand(['inspect', '--pool', POOL]),
    { action: 'inspect', pool: POOL, confirmed: false });
});

void test('a re-seed needs the explicit confirmation flag to be confirmed', () => {
  assert.deepEqual(parseMarketPoolOperatorCommand(['reseed-at-finalized-frontier', '--pool', POOL]),
    { action: 'reseed', pool: POOL, confirmed: false });
  assert.deepEqual(parseMarketPoolOperatorCommand([
    'reseed-at-finalized-frontier', '--pool', POOL, '--confirm-pool-history-gap',
  ]), { action: 'reseed', pool: POOL, confirmed: true });
});

void test('rejects unknown commands, missing or invalid pools', () => {
  assert.throws(() => parseMarketPoolOperatorCommand(['rebase', '--pool', POOL]), TypeError);
  assert.throws(() => parseMarketPoolOperatorCommand(['inspect']), TypeError);
  assert.throws(() => parseMarketPoolOperatorCommand(['inspect', '--pool', 'nope']), TypeError);
  assert.throws(() => parseMarketPoolOperatorCommand(['inspect', '--pool', POOL, '--confirm-pool-history-gap']), TypeError);
});

void test('plan applies only when confirmed with a matching genesis hash', () => {
  assert.deepEqual(planMarketPoolReseed(ready), { apply: true, refusal: null });
});

void test('plan refuses without confirmation, genesis hash, checkpoint or frontier', () => {
  assert.equal(planMarketPoolReseed({ ...ready, confirmed: false }).refusal, 'CONFIRMATION_REQUIRED');
  assert.equal(planMarketPoolReseed({ ...ready, expectedGenesisHash: undefined }).refusal, 'EXPECTED_GENESIS_HASH_NOT_SET');
  assert.equal(planMarketPoolReseed({ ...ready, expectedGenesisHash: ' ' }).refusal, 'EXPECTED_GENESIS_HASH_NOT_SET');
  assert.equal(planMarketPoolReseed({ ...ready, genesisHash: 'other' }).refusal, 'GENESIS_HASH_MISMATCH');
  assert.equal(planMarketPoolReseed({ ...ready, checkpoint: null }).refusal, 'NO_CHECKPOINT');
  assert.equal(planMarketPoolReseed({ ...ready, frontier: null }).refusal, 'NO_FRONTIER');
  assert.equal(planMarketPoolReseed({ ...ready, frontier: { slot: 99n, signature: 'c' } }).refusal, 'FRONTIER_BEHIND_CHECKPOINT');
  assert.equal(planMarketPoolReseed({ ...ready, confirmed: false }).apply, false);
});

void test('truncates signatures as first8…last8', () => {
  assert.equal(truncateSignature('abcdefgh1234567890ABCDEFGH'), 'abcdefgh…ABCDEFGH');
  assert.equal(truncateSignature('short'), 'short');
  assert.equal(truncateSignature(null), null);
});
