import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  PumpBorshReader,
} from '../src/launchpads/pumpfun/borsh-reader.js';
import {
  PUMP_DECODING_ERROR_CODES,
  PumpDecodingError,
  type PumpDecodingErrorCode,
} from '../src/launchpads/pumpfun/errors.js';

void test('décode les entiers Borsh sans float', () => {
  const bytes = Buffer.alloc(18);
  bytes.writeBigUInt64LE(9_007_199_254_740_993n, 0);
  bytes.writeBigInt64LE(-9_007_199_254_740_993n, 8);
  bytes.writeUInt16LE(10_000, 16);
  const reader = new PumpBorshReader(bytes);

  assert.equal(reader.readU64(), 9_007_199_254_740_993n);
  assert.equal(reader.readI64(), -9_007_199_254_740_993n);
  assert.equal(reader.readU16(), 10_000n);
  assert.equal(reader.remaining, 0);
});

void test('décode string et pubkey avec des bornes explicites', () => {
  const key = new PublicKey('So11111111111111111111111111111111111111112');
  const text = Buffer.from('éclair');
  const bytes = Buffer.alloc(4 + text.length + 32);
  bytes.writeUInt32LE(text.length, 0);
  text.copy(bytes, 4);
  key.toBuffer().copy(bytes, 4 + text.length);
  const reader = new PumpBorshReader(bytes);

  assert.equal(reader.readString(32), 'éclair');
  assert.equal(reader.readPubkey(), key.toBase58());
});

void test('échoue de façon typée sur une donnée tronquée', () => {
  assert.throws(
    () => new PumpBorshReader(Uint8Array.of(1)).readU64(),
    (error: unknown) =>
      error instanceof PumpDecodingError
      && error.code === 'PUMP_BORSH_TRUNCATED'
      && error.retryable,
  );
});

void test('rejette un booléen et une chaîne UTF-8 invalides', () => {
  assert.throws(
    () => new PumpBorshReader(Uint8Array.of(2)).readBool(),
    isPumpError('PUMP_BORSH_INVALID'),
  );
  assert.throws(
    () => new PumpBorshReader(Uint8Array.of(1, 0, 0, 0, 0xff))
      .readString(16),
    isPumpError('PUMP_BORSH_INVALID'),
  );
});

void test('borne les longueurs avant toute allocation', () => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(65, 0);

  assert.throws(
    () => new PumpBorshReader(bytes).readString(64),
    isPumpError('PUMP_BORSH_INVALID'),
  );
});

void test('le jeu de codes techniques reste stable', () => {
  const expected: readonly PumpDecodingErrorCode[] = [
    'PUMP_TRANSACTION_INDEX_REQUIRED',
    'PUMP_SCHEMA_UNSUPPORTED',
    'PUMP_BORSH_TRUNCATED',
    'PUMP_BORSH_INVALID',
    'PUMP_ACCOUNT_MISSING',
    'PUMP_STACK_HEIGHT_REQUIRED',
    'PUMP_STACK_HEIGHT_INVALID',
    'PUMP_EVENT_MISSING',
    'PUMP_EVENT_DUPLICATE',
    'PUMP_EVENT_ORPHANED',
    'PUMP_EVENT_AMBIGUOUS',
    'PUMP_EVENT_MISMATCH',
    'PUMP_QUOTE_ASSET_UNRESOLVED',
    'PUMP_QUOTE_ASSET_CONFLICT',
    'PUMP_TOKEN_PROGRAM_UNSUPPORTED',
  ];

  assert.deepEqual(PUMP_DECODING_ERROR_CODES, expected);
});

function isPumpError(code: PumpDecodingErrorCode) {
  return (error: unknown): boolean =>
    error instanceof PumpDecodingError && error.code === code;
}
