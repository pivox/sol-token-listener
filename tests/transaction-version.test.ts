import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_SUPPORTED_TRANSACTION_VERSION } from '../src/solana/rpc/transaction-version.js';

void test('supports every currently active Solana transaction version for reads', () => {
  assert.equal(MAX_SUPPORTED_TRANSACTION_VERSION, 1);
});
