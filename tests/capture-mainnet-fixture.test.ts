import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  parseCaptureArguments,
  resolveCaptureRpcUrl,
  serializeMainnetFixture,
} from '../scripts/capture-fixture.js';
import { loadPumpFixture } from './helpers/pumpfun-fixture.js';

void test('parses only canonical family, signature, index and filename arguments', () => {
  const signature = '1'.repeat(64);
  assert.deepEqual(
    parseCaptureArguments(['pumpswap', signature, '42', 'sell-mainnet.json']),
    { family: 'pumpswap', signature, transactionIndex: 42, outputName: 'sell-mainnet.json' },
  );
  for (const args of [
    ['raydium', signature, '42', 'sell-mainnet.json'],
    ['pumpfun', 'bad', '42', 'sell-mainnet.json'],
    ['pumpfun', signature, '042', 'sell-mainnet.json'],
    ['pumpfun', signature, '42', '../escape.json'],
  ]) {
    assert.throws(() => parseCaptureArguments(args), TypeError);
  }
});

void test('uses only the standard non-empty HTTP RPC variable', () => {
  assert.equal(
    resolveCaptureRpcUrl({ SOLANA_HTTP_RPC_URL: 'https://rpc.example.invalid' }),
    'https://rpc.example.invalid',
  );
  assert.throws(() => resolveCaptureRpcUrl({}), TypeError);
  assert.throws(() => resolveCaptureRpcUrl({ SOLANA_HTTP_RPC_URL: '  ' }), TypeError);
  assert.throws(() => resolveCaptureRpcUrl({ SOLANA_RPC_HTTP_URL: 'https://legacy.invalid' }), TypeError);
});

void test('serializes the strict minimized V1 contract without excluded RPC fields', async () => {
  const source = await loadPumpFixture('sell-cpi-mainnet.json');
  const fixture = serializeMainnetFixture(
    'pumpswap',
    { ...source.transaction, confirmationStatus: 'FINALIZED' },
    '2026-08-08T08:00:00.000Z',
  );

  assert.equal(fixture.schemaVersion, 'solana-mainnet-fixture.v1');
  assert.equal(fixture.family, 'pumpswap');
  assert.deepEqual(fixture.sanitization, {
    contract: 'normalized-public-chain.v1',
    anonymized: false,
  });
  assert.deepEqual(Object.keys(fixture.transaction).sort(), [
    'blockTimeMs', 'computeUnits', 'confirmationStatus', 'error', 'feeLamports',
    'instructions', 'postTokenBalances', 'preTokenBalances', 'signature', 'slot',
    'transactionIndex', 'version',
  ]);
  assert.doesNotMatch(
    JSON.stringify(fixture),
    /rpcUrl|endpoint|headers|logMessages|signerKeys|preBalancesLamports|postBalancesLamports/iu,
  );
});

void test('rejects a non-canonical capture timestamp', async () => {
  const source = await loadPumpFixture('sell-cpi-mainnet.json');

  assert.throws(
    () => serializeMainnetFixture(
      'pumpswap',
      { ...source.transaction, confirmationStatus: 'FINALIZED' },
      '2026-08-08 08:00:00Z',
    ),
    /transaction is invalid/u,
  );
});

void test('capture source remains opt-in and contains no signing or submission capability', async () => {
  const source = await readFile(new URL('../scripts/capture-fixture.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /private.?key|sendTransaction|signTransaction|simulateTransaction/iu);
  assert.match(source, /FINALIZED/u);
  assert.match(source, /new SolanaTransactionLocator\(client\)/u);
  assert.doesNotMatch(
    source,
    /fetch\(\s*args\.signature,\s*'FINALIZED',\s*args\.transactionIndex\s*,?\s*\)/su,
  );
});
