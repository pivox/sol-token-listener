import { generateKeyPairSync, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalStringifyJson } from '../src/utils/json.js';
import { createExecutionReadinessService } from '../src/executor-readiness/service.js';

const NOW = 1_788_000_000_000;
const WALLET = '2LvenbX1TdhX8EbxGBmcZYiXuZFN4utA8QZY1UgGXwmZ';
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const keys = generateKeyPairSync('ed25519');
const publicKeyBase64 = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

void test('collects public evidence, commits once and returns a non-executed manifest', async () => {
  const calls: string[] = [];
  const commits: unknown[] = [];
  const service = createExecutionReadinessService({
    config: config(),
    rpc: {
      verifyGenesis: async () => { calls.push('genesis'); },
      observeWallet: async () => { calls.push('wallet'); return Object.freeze({
        slot: 401_000_000n, blockTimeMs: NOW - 1_000, observedAtMs: NOW,
        walletLamports: 465_847_782n, tokenBalanceCount: 1,
      }); },
    },
    repository: { commit: async (input) => { calls.push('commit'); commits.push(input); return input; } },
    readEvidence: async () => { calls.push('evidence'); return signedEvidence(); },
    now: () => NOW,
  });
  const result = await service.collect(new AbortController().signal);
  assert.deepEqual(calls, ['genesis', 'wallet', 'evidence', 'commit']);
  assert.equal(commits.length, 1);
  assert.equal(result.state, 'READINESS_EVIDENCE_COLLECTED');
  assert.equal(result.walletLamports, '465847782');
  assert.equal(result.canaryStatus, 'CANARY_NOT_STARTED');
  assert.equal(result.paperMainnet49Status, 'NON_EXECUTED_NON_VALIDATED');
});

void test('never calls the repository when evidence verification fails', async () => {
  let commits = 0;
  const service = createExecutionReadinessService({
    config: config(),
    rpc: { verifyGenesis: async () => undefined,
      observeWallet: async () => Object.freeze({ slot: 1n, blockTimeMs: null,
        observedAtMs: NOW, walletLamports: 0n, tokenBalanceCount: 0 }) },
    repository: { commit: async (input) => { commits += 1; return input; } },
    readEvidence: async () => '{}',
    now: () => NOW,
  });
  await assert.rejects(service.collect(new AbortController().signal));
  assert.equal(commits, 0);
});

void test('rechecks provider evidence expiry after RPC collection', async () => {
  let commits = 0;
  const times = [NOW, NOW + 300_001];
  const service = createExecutionReadinessService({
    config: config(),
    rpc: { verifyGenesis: async () => undefined,
      observeWallet: async () => Object.freeze({ slot: 1n, blockTimeMs: null,
        observedAtMs: NOW, walletLamports: 0n, tokenBalanceCount: 0 }) },
    repository: { commit: async (input) => { commits += 1; return input; } },
    readEvidence: async () => signedEvidence(),
    now: () => times.shift() ?? NOW + 300_001,
  });
  await assert.rejects(service.collect(new AbortController().signal));
  assert.equal(commits, 0);
});

function config() {
  return Object.freeze({ databaseUrl: 'postgresql://unused', cluster: 'mainnet-beta' as const,
    httpRpcUrl: 'https://unused.invalid', expectedGenesisHash: GENESIS,
    providerId: 'primary', walletPublicKey: WALLET, generationNumber: 1,
    evidencePublicKeyBase64: publicKeyBase64,
    providerEvidencePath: '/outside/repository/provider.json', maximumSlotLag: 8,
    rpcTimeoutMs: 5_000 });
}

function signedEvidence(): string {
  const payload = Object.freeze({ providerId: 'primary', planId: 'paid-mainnet',
    billingPeriodId: '2026-09', billingPeriodStartedAtMs: NOW - 86_400_000,
    billingPeriodEndsAtMs: NOW + 86_400_000, limitUnits: '1000000', usedUnits: '1000',
    measuredAtMs: NOW, expiresAtMs: NOW + 300_000, provenance: 'OPERATOR_REPORT' });
  const encoded = Buffer.from(canonicalStringifyJson(payload));
  return JSON.stringify({ payloadVersion: 1, algorithm: 'Ed25519',
    signedPayloadBase64: encoded.toString('base64'),
    signatureBase64: sign(null, encoded, keys.privateKey).toString('base64') });
}
