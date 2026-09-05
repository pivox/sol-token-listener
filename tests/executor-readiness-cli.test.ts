import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  readBoundedEvidenceFile,
  runExecutionReadinessCommand,
} from '../src/executor-readiness/main.js';

void test('renders exactly one redacted JSON manifest', async () => {
  const output = await runExecutionReadinessCommand({ collect: async () => Object.freeze({
    schemaVersion: 'execution-readiness-bootstrap.v1' as const,
    state: 'READINESS_EVIDENCE_COLLECTED' as const,
    generationId: `execution_wallet_generation_${'a'.repeat(64)}`,
    walletPublicKey: '11111111111111111111111111111111', cluster: 'mainnet-beta' as const,
    providerId: 'primary', walletSnapshotId: `execution_wallet_snapshot_${'b'.repeat(64)}`,
    walletSnapshotFingerprint: 'b'.repeat(64),
    providerSnapshotId: `execution_provider_usage_${'c'.repeat(64)}`,
    providerSnapshotFingerprint: 'c'.repeat(64), walletLamports: '1',
    tokenBalanceCount: 0, observedAtMs: 1, expiresAtMs: 2,
    canaryStatus: 'CANARY_NOT_STARTED' as const,
    paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED' as const,
  }) }, new AbortController().signal);
  assert.equal(output.endsWith('\n'), false);
  assert.deepEqual(Object.keys(JSON.parse(output) as object), [
    'schemaVersion', 'state', 'generationId', 'walletPublicKey', 'cluster', 'providerId',
    'walletSnapshotId', 'walletSnapshotFingerprint', 'providerSnapshotId',
    'providerSnapshotFingerprint', 'walletLamports', 'tokenBalanceCount', 'observedAtMs',
    'expiresAtMs', 'canaryStatus', 'paperMainnet49Status',
  ]);
  assert.doesNotMatch(output, /(?:https:|postgresql:|evidencePath|signatureBase64)/u);
});

void test('bounded evidence reader rejects files larger than 128 KiB', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'readiness-evidence-'));
  try {
    const small = join(directory, 'small.json');
    const large = join(directory, 'large.json');
    await writeFile(small, '{}');
    await writeFile(large, 'x'.repeat(131_073));
    assert.equal(await readBoundedEvidenceFile(small), '{}');
    await assert.rejects(readBoundedEvidenceFile(large));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

