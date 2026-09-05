import assert from 'node:assert/strict';
import test from 'node:test';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  ReadinessRpcError,
  SolanaReadinessRpcGateway,
} from '../src/executor-readiness/rpc-gateway.js';

const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const WALLET = '2LvenbX1TdhX8EbxGBmcZYiXuZFN4utA8QZY1UgGXwmZ';

function response(result: unknown, status = 200, id = 1): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status, headers: { 'content-type': 'application/json' },
  });
}

void test('collects balance and both token programs at finalized commitment only', async () => {
  const requests: Readonly<Record<string, unknown>>[] = [];
  const results = [
    GENESIS,
    401_000_000,
    1_788_000_000,
    { context: { slot: 401_000_001 }, value: 465_847_782 },
    { context: { slot: 401_000_002 }, value: [{ pubkey: WALLET }] },
    { context: { slot: 401_000_003 }, value: [{ pubkey: WALLET }, { pubkey: WALLET }] },
  ];
  const fetchMock: typeof fetch = async (_url, init) => {
    const body = init?.body;
    if (typeof body !== 'string') throw new TypeError('Expected string request body.');
    const request = JSON.parse(body) as Readonly<Record<string, unknown>>;
    requests.push(request);
    return response(results.shift(), 200, request.id as number);
  };
  const gateway = new SolanaReadinessRpcGateway({
    providerId: 'primary', httpRpcUrl: 'https://mainnet.example.invalid/rpc',
    expectedGenesisHash: GENESIS, timeoutMs: 1_000,
  }, fetchMock);
  const signal = new AbortController().signal;
  await gateway.verifyGenesis(signal);
  const observed = await gateway.observeWallet(WALLET, 3, signal, () => 1_788_000_000_123);
  assert.deepEqual(observed, {
    slot: 401_000_003n, blockTimeMs: 1_788_000_000_000,
    observedAtMs: 1_788_000_000_123, walletLamports: 465_847_782n,
    tokenBalanceCount: 3,
  });
  assert.deepEqual(requests.map((request) => request.method), [
    'getGenesisHash', 'getSlot', 'getBlockTime', 'getBalance',
    'getTokenAccountsByOwner', 'getTokenAccountsByOwner',
  ]);
  assert.match(JSON.stringify(requests), /finalized/u);
  assert.match(JSON.stringify(requests), new RegExp(TOKEN_PROGRAM_ID.toBase58(), 'u'));
  assert.match(JSON.stringify(requests), new RegExp(TOKEN_2022_PROGRAM_ID.toBase58(), 'u'));
});

void test('fails closed on genesis mismatch, rate limit, oversized body and slot lag', async () => {
  const signal = new AbortController().signal;
  const mismatched = new SolanaReadinessRpcGateway({ providerId: 'primary',
    httpRpcUrl: 'https://mainnet.example.invalid', expectedGenesisHash: GENESIS,
    timeoutMs: 100 }, async () => response('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'));
  await assert.rejects(mismatched.verifyGenesis(signal),
    (error: unknown) => error instanceof ReadinessRpcError && error.code === 'GENESIS_MISMATCH');

  const limited = new SolanaReadinessRpcGateway({ providerId: 'primary',
    httpRpcUrl: 'https://mainnet.example.invalid', expectedGenesisHash: GENESIS,
    timeoutMs: 100 }, async () => new Response('{}', { status: 429 }));
  await assert.rejects(limited.verifyGenesis(signal),
    (error: unknown) => error instanceof ReadinessRpcError && error.code === 'RPC_RATE_LIMITED');

  const oversized = new SolanaReadinessRpcGateway({ providerId: 'primary',
    httpRpcUrl: 'https://mainnet.example.invalid', expectedGenesisHash: GENESIS,
    timeoutMs: 100 }, async () => new Response('x'.repeat(1_048_577)));
  await assert.rejects(oversized.verifyGenesis(signal),
    (error: unknown) => error instanceof ReadinessRpcError
      && error.code === 'RPC_RESPONSE_TOO_LARGE');

  const results = [GENESIS, 100, 1_788_000_000,
    { context: { slot: 100 }, value: 1 },
    { context: { slot: 100 }, value: [] },
    { context: { slot: 109 }, value: [] }];
  const lagged = new SolanaReadinessRpcGateway({ providerId: 'primary',
    httpRpcUrl: 'https://mainnet.example.invalid', expectedGenesisHash: GENESIS,
    timeoutMs: 100 }, async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>;
      return response(results.shift(), 200, request.id as number);
    });
  await lagged.verifyGenesis(signal);
  await assert.rejects(lagged.observeWallet(WALLET, 8, signal),
    (error: unknown) => error instanceof ReadinessRpcError && error.code === 'SLOT_LAG_EXCEEDED');
});

void test('rejects non-canonical JSON-RPC envelopes and mismatched response ids', async () => {
  const config = { providerId: 'primary', httpRpcUrl: 'https://mainnet.example.invalid',
    expectedGenesisHash: GENESIS, timeoutMs: 100 } as const;
  const signal = new AbortController().signal;
  const unexpectedField = new SolanaReadinessRpcGateway(config,
    async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: GENESIS,
      unexpected: true })));
  await assert.rejects(unexpectedField.verifyGenesis(signal),
    (error: unknown) => error instanceof ReadinessRpcError
      && error.code === 'RPC_RESPONSE_INVALID');

  const mismatchedId = new SolanaReadinessRpcGateway(config,
    async () => response(GENESIS, 200, 2));
  await assert.rejects(mismatchedId.verifyGenesis(signal),
    (error: unknown) => error instanceof ReadinessRpcError
      && error.code === 'RPC_RESPONSE_INVALID');
});
