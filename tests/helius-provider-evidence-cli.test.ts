import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  readProtectedFile,
  runHeliusProviderEvidenceCommand,
  writeAtomicEvidence,
} from '../src/provider-evidence/main.js';

void test('reads only owner-protected regular files and writes atomic mode 0600 evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helius-provider-evidence-'));
  try {
    const protectedPath = join(directory, 'protected');
    const openPath = join(directory, 'open');
    const outputPath = join(directory, 'evidence.json');
    const symlinkPath = join(directory, 'evidence-link.json');
    const protectedSymlinkPath = join(directory, 'protected-link');
    await writeFile(protectedPath, 'secret\n', { mode: 0o600 });
    await writeFile(openPath, 'secret\n', { mode: 0o644 });
    await symlink(protectedPath, protectedSymlinkPath);
    assert.equal(await readProtectedFile(protectedPath), 'secret\n');
    await assert.rejects(readProtectedFile(openPath));
    await assert.rejects(readProtectedFile(protectedSymlinkPath));
    await writeAtomicEvidence(outputPath, '{"safe":true}');
    assert.equal(await readFile(outputPath, 'utf8'), '{"safe":true}');
    assert.equal((await lstat(outputPath)).mode & 0o777, 0o600);
    await symlink(outputPath, symlinkPath);
    await assert.rejects(writeAtomicEvidence(symlinkPath, '{}'));
    await assert.rejects(writeAtomicEvidence(join(directory, 'large.json'),
      'x'.repeat(131_073)));
    await chmod(protectedPath, 0o400);
    assert.equal(await readProtectedFile(protectedPath), 'secret\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('renders exactly one redacted non-canary manifest', async () => {
  const output = await runHeliusProviderEvidenceCommand({
    collect: async () => Object.freeze({
      schemaVersion: 'helius-provider-evidence.v1' as const,
      state: 'PROVIDER_EVIDENCE_COLLECTED' as const,
      providerId: 'helius-primary', projectFingerprint: 'a'.repeat(64),
      providerSnapshotId: `execution_provider_usage_${'b'.repeat(64)}`,
      providerSnapshotFingerprint: 'b'.repeat(64),
      measuredAtMs: 1, expiresAtMs: 2,
      evidencePublicKeyBase64: 'MCowBQYDK2VwAyEAqaqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=',
      canaryStatus: 'CANARY_NOT_STARTED' as const,
      paperMainnet49Status: 'NON_EXECUTED_NON_VALIDATED' as const,
    }),
  }, new AbortController().signal);
  assert.equal(output.endsWith('\n'), false);
  assert.deepEqual(Object.keys(JSON.parse(output) as object), [
    'schemaVersion', 'state', 'providerId', 'projectFingerprint',
    'providerSnapshotId', 'providerSnapshotFingerprint', 'measuredAtMs',
    'expiresAtMs', 'evidencePublicKeyBase64', 'canaryStatus',
    'paperMainnet49Status',
  ]);
  assert.doesNotMatch(output, /api-key|private|projectId|credits|https:/iu);
});
