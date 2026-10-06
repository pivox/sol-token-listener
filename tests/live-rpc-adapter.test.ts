import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@solana/web3.js';
import { PublicKey, TransactionMessage } from '@solana/web3.js';
import { SolanaLiveTransactionRpc } from '../src/live/solana-live-transaction-rpc.js';

void test('live RPC adapter uses bounded no-retry send and history-aware confirmation reads', async () => {
  const calls: { name: string; args: readonly unknown[] }[] = [];
  const connection = {
    getLatestBlockhash: async (...args: unknown[]) => { calls.push({ name: 'latest', args }); return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 500 }; },
    sendRawTransaction: async (...args: unknown[]) => { calls.push({ name: 'send', args }); return 'sig'; },
    getSignatureStatuses: async (...args: unknown[]) => { calls.push({ name: 'status', args }); return { value: [{ confirmationStatus: 'confirmed', err: null }] }; },
    getBlockHeight: async (...args: unknown[]) => { calls.push({ name: 'height', args }); return 400; },
    getTransaction: async (...args: unknown[]) => { calls.push({ name: 'transaction', args }); return { slot: 700, meta: { fee: 5_000, err: null } }; },
    getBalanceAndContext: async (...args: unknown[]) => { calls.push({ name: 'balance', args }); return { context: { slot: 701 }, value: 99_000 }; },
    getFeeForMessage: async (...args: unknown[]) => { calls.push({ name: 'fee', args }); return { context: { slot: 701 }, value: 5_123 }; },
    getMinimumBalanceForRentExemption: async (...args: unknown[]) => { calls.push({ name: 'rent', args }); return 2_000_000; },
  } as unknown as Connection;
  const rpc = new SolanaLiveTransactionRpc(connection, 'confirmed');
  const latest = await rpc.getLatestBlockhash();
  await rpc.sendRawTransaction(Uint8Array.of(1, 2, 3));
  const status = await rpc.getSignatureStatus('sig');
  const height = await rpc.getBlockHeight();
  const transaction = await rpc.getTransaction('sig');
  const fee = await rpc.getMessageFee(new TransactionMessage({payerKey:PublicKey.default,recentBlockhash:PublicKey.default.toBase58(),instructions:[]}).compileToV0Message());
  const balance = await rpc.getWalletBalance(PublicKey.default.toBase58());
  const rent = await rpc.getTokenAccountRentExemption();

  assert.deepEqual(latest, { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 500 });
  assert.equal(status?.confirmationStatus, 'confirmed');
  assert.equal(height, 400);
  assert.equal(transaction?.meta?.fee, 5_000);
  assert.equal(fee?.lamports, 5_123n);
  assert.equal(fee?.contextSlot, 701n);
  assert.equal(balance?.lamports, 99_000n);
  assert.equal(balance?.contextSlot, 701n);
  assert.equal(rent, 2_000_000n);
  assert.equal((calls.find((call) => call.name === 'balance')?.args[0] as PublicKey).toBase58(), PublicKey.default.toBase58());
  assert.equal(calls.find((call) => call.name === 'rent')?.args[0], 165);
  assert.deepEqual(calls.find((call) => call.name === 'send')?.args[1], {
    maxRetries: 0, preflightCommitment: 'confirmed',
  });
  assert.deepEqual(calls.find((call) => call.name === 'status')?.args[1], { searchTransactionHistory: true });
  assert.deepEqual(calls.find((call) => call.name === 'transaction')?.args[1], {
    commitment: 'confirmed', maxSupportedTransactionVersion: 0,
  });
});
