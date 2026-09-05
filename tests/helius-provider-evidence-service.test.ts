import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { verifySignedProviderUsageEvidence } from
  '../src/domain/execution-provider-attestation.js';
import {
  createHeliusProviderEvidenceService,
} from '../src/provider-evidence/service.js';

const PROJECT_ID = 'a1b2c3d4-e5f6-4890-abcd-ef1234567890';
const NOW_MS = Date.parse('2026-09-05T12:00:00.000Z');

void test('signs canonical H2d evidence and emits only a redacted manifest', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  let written = '';
  const service = createHeliusProviderEvidenceService({
    config: Object.freeze({
      projectId: PROJECT_ID, apiKeyPath: '/secret/api-key', providerId: 'helius-primary',
      privateKeyPath: '/secret/evidence.pem', outputPath: '/evidence/provider.json',
      ttlMs: 300_000, timeoutMs: 5_000,
    }),
    client: { getProjectUsage: async () => validResponse() },
    readProtectedFile: async (path) => path.endsWith('api-key')
      ? 'secret-api-key' : privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    writeEvidence: async (_path, value) => { written = value; },
    now: () => NOW_MS,
  });
  const manifest = await service.collect(new AbortController().signal);
  const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const envelope = JSON.parse(written) as unknown;
  const snapshot = verifySignedProviderUsageEvidence(
    deepFreeze(envelope), publicKeyBase64, 'helius-primary', NOW_MS,
  );
  assert.equal(snapshot.snapshotId, manifest.providerSnapshotId);
  assert.equal(manifest.evidencePublicKeyBase64, publicKeyBase64);
  const output = JSON.stringify(manifest);
  assert.doesNotMatch(output,
    /secret-api-key|BEGIN PRIVATE KEY|creditsRemaining|creditsUsed|business|a1b2c3d4/iu);
  assert.equal(manifest.canaryStatus, 'CANARY_NOT_STARTED');
  assert.equal(manifest.paperMainnet49Status, 'NON_EXECUTED_NON_VALIDATED');
});

void test('does not write or report evidence that expires while it is being signed', async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  let written = false;
  const times = [NOW_MS, NOW_MS + 300_000];
  const service = createHeliusProviderEvidenceService({
    config: Object.freeze({
      projectId: PROJECT_ID, apiKeyPath: '/secret/api-key', providerId: 'helius-primary',
      privateKeyPath: '/secret/evidence.pem', outputPath: '/evidence/provider.json',
      ttlMs: 300_000, timeoutMs: 5_000,
    }),
    client: { getProjectUsage: async () => validResponse() },
    readProtectedFile: async (path) => path.endsWith('api-key')
      ? 'secret-api-key' : privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    writeEvidence: async () => { written = true; },
    now: () => times.shift() ?? NOW_MS + 300_000,
  });
  await assert.rejects(service.collect(new AbortController().signal));
  assert.equal(written, false);
});

function validResponse(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    creditsRemaining: 487_500, creditsUsed: 12_500,
    prepaidCreditsRemaining: 50_000, prepaidCreditsUsed: 0,
    subscriptionDetails: Object.freeze({
      billingCycle: Object.freeze({ start: '2026-09-01', end: '2026-10-01' }),
      creditsLimit: 500_000, plan: 'business',
    }),
    usage: Object.freeze({
      api: 1_200, archival: 0, das: 5_000, grpc: 300, grpcGeyser: 0,
      photon: 0, rpc: 4_500, stream: 100, webhook: 800, websocket: 600,
    }),
  });
}

function deepFreeze(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
