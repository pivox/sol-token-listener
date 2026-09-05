import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionReadinessManifest,
  createExecutionWalletGeneration,
  ExecutionReadinessValidationError,
} from '../src/domain/execution-readiness.js';

const WALLET = '2LvenbX1TdhX8EbxGBmcZYiXuZFN4utA8QZY1UgGXwmZ';
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

void test('builds a deterministic wallet generation identity from every causal field', () => {
  const input = Object.freeze({
    walletPublicKey: WALLET,
    cluster: 'mainnet-beta' as const,
    genesisHash: GENESIS,
    generation: 1,
  });
  const generation = createExecutionWalletGeneration(input);
  assert.match(generation.generationId, /^execution_wallet_generation_[0-9a-f]{64}$/u);
  assert.deepEqual(createExecutionWalletGeneration(input), generation);
  assert.ok(Object.isFrozen(generation));
  for (const changed of [
    { ...input, walletPublicKey: '11111111111111111111111111111111' },
    { ...input, cluster: 'devnet' as const },
    { ...input, genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' },
    { ...input, generation: 2 },
  ]) assert.notEqual(createExecutionWalletGeneration(Object.freeze(changed)).generationId,
    generation.generationId);
});

void test('rejects malformed, extended or mutable generation input', () => {
  const valid = { walletPublicKey: WALLET, cluster: 'mainnet-beta', genesisHash: GENESIS,
    generation: 1 };
  for (const input of [valid, Object.freeze({ ...valid, extra: true }),
    Object.freeze({ ...valid, generation: 0 }), Object.freeze({ ...valid, cluster: 'localnet' }),
    Object.freeze({ ...valid, walletPublicKey: 'invalid' })]) {
    assert.throws(() => createExecutionWalletGeneration(input),
      ExecutionReadinessValidationError);
  }
});

void test('creates an exact redacted readiness manifest with decimal financial values', () => {
  const generation = createExecutionWalletGeneration(Object.freeze({
    walletPublicKey: WALLET, cluster: 'mainnet-beta', genesisHash: GENESIS, generation: 1,
  }));
  const manifest = createExecutionReadinessManifest(Object.freeze({
    generationId: generation.generationId,
    walletPublicKey: WALLET,
    cluster: 'mainnet-beta',
    providerId: 'primary',
    walletSnapshotId: `execution_wallet_snapshot_${'a'.repeat(64)}`,
    walletSnapshotFingerprint: 'a'.repeat(64),
    providerSnapshotId: `execution_provider_usage_${'b'.repeat(64)}`,
    providerSnapshotFingerprint: 'b'.repeat(64),
    walletLamports: 465_847_782n,
    tokenBalanceCount: 0,
    observedAtMs: 1_788_000_000_000,
    expiresAtMs: 1_788_000_300_000,
  }));
  assert.deepEqual(manifest, {
    schemaVersion: 'execution-readiness-bootstrap.v1',
    state: 'READINESS_EVIDENCE_COLLECTED',
    generationId: generation.generationId,
    walletPublicKey: WALLET,
    cluster: 'mainnet-beta',
    providerId: 'primary',
    walletSnapshotId: `execution_wallet_snapshot_${'a'.repeat(64)}`,
    walletSnapshotFingerprint: 'a'.repeat(64),
    providerSnapshotId: `execution_provider_usage_${'b'.repeat(64)}`,
    providerSnapshotFingerprint: 'b'.repeat(64),
    walletLamports: '465847782',
    tokenBalanceCount: 0,
    observedAtMs: 1_788_000_000_000,
    expiresAtMs: 1_788_000_300_000,
    canaryStatus: 'CANARY_NOT_STARTED',
    paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED',
  });
  assert.ok(Object.isFrozen(manifest));
});

