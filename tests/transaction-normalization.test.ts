import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PublicKey,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import {
  normalizeTransaction,
} from '../src/solana/rpc/transaction-fetcher.js';

const PROGRAM = new PublicKey(
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
);
const PAYER = new PublicKey('11111111111111111111111111111111');

function responseWithInnerStackHeight(
  stackHeight: number | null,
): VersionedTransactionResponse {
  const accountKeys = [PAYER, PROGRAM];
  return {
    slot: 10,
    blockTime: null,
    version: 'legacy',
    transaction: {
      signatures: ['signature'],
      message: {
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 1,
        },
        compiledInstructions: [{
          programIdIndex: 1,
          accountKeyIndexes: [],
          data: new Uint8Array(),
        }],
        getAccountKeys: () => ({
          length: accountKeys.length,
          get: (index: number) => accountKeys[index],
        }),
      },
    },
    meta: {
      err: null,
      fee: 0,
      preBalances: [0, 0],
      postBalances: [0, 0],
      innerInstructions: [{
        index: 0,
        instructions: [{
          programIdIndex: 1,
          accounts: [],
          data: '',
          stackHeight,
        }],
      }],
      preTokenBalances: [],
      postTokenBalances: [],
      loadedAddresses: { writable: [], readonly: [] },
      logMessages: [],
      rewards: [],
    },
  } as unknown as VersionedTransactionResponse;
}

void test('préserve le stackHeight RPC réel des instructions internes', () => {
  const transaction = normalizeTransaction(
    responseWithInnerStackHeight(3),
    'CONFIRMED',
    4,
  );

  assert.equal(transaction.instructions[1]?.stackHeight, 3);
});

void test('préserve null lorsque le RPC ne fournit pas de stackHeight', () => {
  const transaction = normalizeTransaction(
    responseWithInnerStackHeight(null),
    'CONFIRMED',
    4,
  );

  assert.equal(transaction.instructions[1]?.stackHeight, null);
});
