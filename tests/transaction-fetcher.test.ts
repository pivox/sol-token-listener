import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import { TransactionFetcher, type TransactionFetchClient } from '../src/solana/rpc/transaction-fetcher.js';

void test('requests confirmed transactions with the maximum supported read version', async () => {
  const calls: unknown[][] = [];
  const client = Object.freeze({
    http: Object.freeze({
      async getTransaction(...args: unknown[]): Promise<null> {
        calls.push(args);
        return null;
      },
    }),
  }) as unknown as TransactionFetchClient;

  const result = await new TransactionFetcher(client).fetch('signature', 'CONFIRMED');

  assert.equal(result, null);
  assert.deepEqual(calls, [['signature', {
    commitment: 'confirmed', maxSupportedTransactionVersion: 1,
  }]]);
});

void test('rejects a provider transaction version above the supported read maximum', async () => {
  const payer = new PublicKey('11111111111111111111111111111111');
  const response = {
    slot: 42,
    blockTime: null,
    version: 2,
    transaction: {
      signatures: ['signature'],
      message: {
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 0,
        },
        compiledInstructions: [],
        getAccountKeys() {
          return { length: 1, get: (index: number) => index === 0 ? payer : undefined };
        },
      },
    },
    meta: null,
  } as unknown as VersionedTransactionResponse;
  const client = Object.freeze({
    http: Object.freeze({ async getTransaction(): Promise<VersionedTransactionResponse> { return response; } }),
  }) as unknown as TransactionFetchClient;

  await assert.rejects(
    new TransactionFetcher(client).fetch('signature', 'CONFIRMED'),
    (error: unknown) => error instanceof Error
      && error.message === 'Version de transaction Solana non prise en charge.',
  );
});
