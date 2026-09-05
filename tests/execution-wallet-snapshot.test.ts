import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionWalletSnapshot,
  ExecutionWalletSnapshotValidationError,
} from '../src/domain/execution-wallet-snapshot.js';

const INPUT = Object.freeze({
  generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
  providerId: 'rpc-primary', stateRevision: 0n, slot: 123n, blockTimeMs: 1_788_134_399_000,
  observedAtMs: 1_788_134_400_000, commitment: 'finalized' as const,
  walletLamports: 1_000_000n, tokenBalanceCount: 0, openPositions: [], realizedNetPnlRaw: 0n,
});

void test('creates a deterministic frozen wallet snapshot whose identity covers every field', () => {
  const first = createExecutionWalletSnapshot(INPUT);
  const replay = createExecutionWalletSnapshot({ ...INPUT, openPositions: [] });
  assert.deepEqual(first, replay);
  assert.match(first.snapshotId, /^execution_wallet_snapshot_[0-9a-f]{64}$/u);
  assert.match(first.snapshotFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.openPositions), true);
  for (const changed of [
    { generationId: `execution_wallet_generation_${'b'.repeat(64)}` }, { providerId: 'rpc-secondary' },
    { stateRevision: 1n }, { slot: 124n }, { blockTimeMs: null }, { observedAtMs: INPUT.observedAtMs + 1 },
    { walletLamports: 999_999n }, { tokenBalanceCount: 1 }, { realizedNetPnlRaw: 1n },
    { openPositions: [{ positionId: 'position-1', costBasisLamports: 1n,
      conservativeLiquidationLamports: null, reconciliationStatus: 'RECONCILED' as const }] },
  ]) assert.notEqual(createExecutionWalletSnapshot({ ...INPUT, ...changed }).snapshotFingerprint,
    first.snapshotFingerprint);
  const positioned = {
    positionId: 'position-1', costBasisLamports: 1n, conservativeLiquidationLamports: null,
    reconciliationStatus: 'RECONCILED' as const,
  };
  const positionedFingerprint = createExecutionWalletSnapshot({ ...INPUT, openPositions: [positioned] }).snapshotFingerprint;
  for (const changed of [
    { positionId: 'position-2' }, { costBasisLamports: 2n },
    { conservativeLiquidationLamports: 0n }, { reconciliationStatus: 'UNKNOWN' as const },
  ]) assert.notEqual(createExecutionWalletSnapshot({ ...INPUT, openPositions: [{ ...positioned, ...changed }] }).snapshotFingerprint,
    positionedFingerprint);
});

void test('rejects fabricated identities, mutable nested values, extra keys and proxies', () => {
  const snapshot = createExecutionWalletSnapshot(INPUT);
  for (const invalid of [
    { ...INPUT, snapshotId: snapshot.snapshotId },
    { ...INPUT, extra: true },
    new Proxy({ ...INPUT }, {}),
  ]) assert.throws(() => createExecutionWalletSnapshot(invalid), ExecutionWalletSnapshotValidationError);
});
