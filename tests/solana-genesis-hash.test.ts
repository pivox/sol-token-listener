import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  SolanaGenesisHashError,
  canonicalSolanaGenesisHash,
  requireSolanaGenesisHash,
} from '../src/domain/solana-genesis-hash.js';

const CANONICAL = bs58.encode(Uint8Array.from({ length: 32 }, () => 7));

void test('accepts only a canonical base58 Solana genesis hash decoding to exactly 32 bytes', () => {
  assert.equal(canonicalSolanaGenesisHash(CANONICAL), true);
  for (const value of [
    '',
    ' ',
    ` ${CANONICAL}`,
    `${CANONICAL} `,
    `${CANONICAL.slice(0, -1)}0`,
    bs58.encode(Uint8Array.from({ length: 31 }, () => 7)),
    bs58.encode(Uint8Array.from({ length: 33 }, () => 7)),
  ]) assert.equal(canonicalSolanaGenesisHash(value), false);
});

void test('requires a canonical genesis hash when the listener is enabled', () => {
  assert.equal(requireSolanaGenesisHash(CANONICAL, true), CANONICAL);
  assert.throws(() => requireSolanaGenesisHash(undefined, true), (error: unknown) => {
    assert.ok(error instanceof SolanaGenesisHashError);
    assert.equal(error.field, 'SOLANA_EXPECTED_GENESIS_HASH');
    assert.equal(error.message, 'SOLANA_EXPECTED_GENESIS_HASH is invalid.');
    assert.equal(Object.isFrozen(error), true);
    assert.doesNotMatch(String(error), /secret|hostname|query/i);
    return true;
  });
});

void test('returns null only for omitted genesis hash while the listener is disabled', () => {
  assert.equal(requireSolanaGenesisHash(undefined, false), null);
  assert.equal(requireSolanaGenesisHash('', false), null);
  assert.equal(requireSolanaGenesisHash(CANONICAL, false), CANONICAL);
  assert.throws(() => requireSolanaGenesisHash(`${CANONICAL} `, false), SolanaGenesisHashError);
});
