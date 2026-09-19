import assert from 'node:assert/strict';
import test from 'node:test';
import { Connection, type FetchFn } from '@solana/web3.js';

void test('accepts a sanitized v1 block response through the Connection read boundary', async () => {
  let fetchCalls = 0;
  const fetch: FetchFn = async (_input, init) => {
    fetchCalls += 1;
    const body = init?.body;
    if (typeof body !== 'string') throw new TypeError('Expected string RPC body.');
    const request = JSON.parse(body) as {
      readonly id: string;
      readonly method: string;
      readonly params: readonly unknown[];
    };
    assert.equal(request.method, 'getBlock');
    assert.deepEqual(request.params, [448_499_778, {
      commitment: 'confirmed', transactionDetails: 'full',
      maxSupportedTransactionVersion: 1, rewards: false,
    }]);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: sanitizedV1Block() }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const connection = new Connection('https://fixture.invalid/rpc', { fetch });

  const block = await connection.getBlock(448_499_778, {
    commitment: 'confirmed', transactionDetails: 'full',
    maxSupportedTransactionVersion: 1, rewards: false,
  });

  assert.equal(block?.transactions[0]?.version, 1);
  assert.equal(block?.transactions[0]?.transaction.message.getAccountKeys().length, 3);
  assert.equal(fetchCalls, 1);
});

function sanitizedV1Block(): object {
  return {
    blockhash: '11111111111111111111111111111111',
    previousBlockhash: '11111111111111111111111111111111',
    parentSlot: 448_499_777,
    blockHeight: 321,
    blockTime: 1_725_000_000,
    rewards: [],
    transactions: [{
      version: 1,
      transaction: {
        signatures: ['1111111111111111111111111111111111111111111111111111111111111111'],
        message: {
          header: {
            numRequiredSignatures: 1,
            numReadonlySignedAccounts: 0,
            numReadonlyUnsignedAccounts: 1,
          },
          accountKeys: [
            '11111111111111111111111111111111',
            'SysvarC1ock11111111111111111111111111111111',
            'ComputeBudget111111111111111111111111111111',
          ],
          recentBlockhash: '11111111111111111111111111111111',
          instructions: [{ programIdIndex: 2, accounts: [1, 0], data: '1', stackHeight: 1 }],
          transactionConfig: {
            priorityFee: 2,
            computeUnitLimit: 19,
            loadedAccountsDataSizeLimit: 32_000,
            heapSize: null,
          },
        },
      },
      meta: {
        err: null,
        fee: 0,
        preBalances: [10, 20, 30],
        postBalances: [10, 20, 30],
        innerInstructions: [],
        logMessages: [],
        preTokenBalances: [],
        postTokenBalances: [],
        rewards: [],
      },
    }],
  };
}
