import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { verifySignedExecutionCanaryEvidence } from '../src/domain/execution-canary-attestation.js';
import { createExecutionReadinessManifest } from '../src/domain/execution-readiness.js';
import { verifySignedSafetyQualificationEvidence } from '../src/domain/execution-safety-attestation.js';
import { createExecutionPreflightBundlePackage } from '../src/preflight-bundle/service.js';
import { canonicalStringifyJson, parseJson } from '../src/utils/json.js';
import { canaryEvidenceInput } from './helpers/execution-canary-fixture.js';

const PACKAGE_NOW_MS = 1_788_134_400_000;

function omit(value: object, keys: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  ));
}

function encodedDraft(overrides: Readonly<Record<string, unknown>> = {}): string {
  const source = canaryEvidenceInput(overrides);
  if (typeof source.targetIntentId !== 'string') throw new TypeError();
  const qualification = source.qualification;
  const wallet = source.walletSnapshot;
  const provider = source.providerSnapshot;
  return canonicalStringifyJson(Object.freeze({
    schemaVersion: 'execution-preflight-bundle-draft.v1',
    readiness: createExecutionReadinessManifest(Object.freeze({
      generationId: qualification.generationId,
      walletPublicKey: qualification.walletPublicKey,
      cluster: qualification.cluster,
      providerId: qualification.providerId,
      walletSnapshotId: wallet.snapshotId,
      walletSnapshotFingerprint: wallet.snapshotFingerprint,
      providerSnapshotId: provider.snapshotId,
      providerSnapshotFingerprint: provider.snapshotFingerprint,
      walletLamports: wallet.walletLamports,
      tokenBalanceCount: wallet.tokenBalanceCount,
      observedAtMs: wallet.observedAtMs,
      expiresAtMs: provider.expiresAtMs,
    })),
    qualification: omit(qualification, ['qualificationId', 'qualificationFingerprint']),
    canary: Object.freeze({
      payloadVersion: 1,
      targetIntentId: source.targetIntentId,
      policy: omit(source.policy, ['payloadVersion', 'policyFingerprint']),
      walletSnapshot: omit(wallet, ['snapshotId', 'payloadVersion', 'snapshotFingerprint']),
      providerSnapshot: omit(provider, ['snapshotId', 'payloadVersion', 'snapshotFingerprint']),
      allEndpointsUnavailable: false,
      capturedAtMs: source.capturedAtMs,
      expiresAtMs: source.expiresAtMs,
    }),
  }));
}

void test('signs and self-verifies both canonical H2c envelopes', () => {
  const keys = generateKeyPairSync('ed25519');
  const privateKeyText = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const result = createExecutionPreflightBundlePackage(
    encodedDraft(),
    privateKeyText,
    PACKAGE_NOW_MS,
  );
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const qualification = verifySignedSafetyQualificationEvidence(
    deepFreeze(parseJson(result.qualificationEnvelope)),
    publicKey,
  );
  const canary = verifySignedExecutionCanaryEvidence(
    deepFreeze(parseJson(result.canaryEnvelope)),
    publicKey,
  );
  assert.equal(canary.qualification.qualificationId, qualification.qualificationId);
  assert.equal(result.manifest.qualificationId, qualification.qualificationId);
  assert.equal(result.manifest.canaryEvidenceId, canary.evidenceId);
  assert.equal(result.manifest.canaryStatus, 'CANARY_NOT_STARTED');
  assert.equal(result.manifest.liveCapabilityPresent, false);
  assert.doesNotMatch(canonicalStringifyJson(result.manifest), /signatureBase64|signedPayload/u);
});

void test('rejects a non-Ed25519 key and a non-canonical draft', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaText = rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.throws(() => createExecutionPreflightBundlePackage(
    encodedDraft(), rsaText, PACKAGE_NOW_MS,
  ));
  const ed = generateKeyPairSync('ed25519');
  const edText = ed.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.throws(() => createExecutionPreflightBundlePackage(
    ` ${encodedDraft()}`, edText, PACKAGE_NOW_MS,
  ));
  assert.throws(() => createExecutionPreflightBundlePackage(
    encodedDraft(), edText, PACKAGE_NOW_MS + 300_000,
  ));
});

void test('rejects snapshots whose policy-derived freshness lacks the packaging margin', () => {
  const ed = generateKeyPairSync('ed25519');
  const edText = ed.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.throws(() => createExecutionPreflightBundlePackage(encodedDraft({
    walletSnapshot: {
      observedAtMs: PACKAGE_NOW_MS - 60_000,
      blockTimeMs: PACKAGE_NOW_MS - 61_000,
    },
  }), edText, PACKAGE_NOW_MS));
  assert.throws(() => createExecutionPreflightBundlePackage(encodedDraft({
    providerSnapshot: {
      billingPeriodStartedAtMs: PACKAGE_NOW_MS - 400_000,
      measuredAtMs: PACKAGE_NOW_MS - 300_000,
    },
  }), edText, PACKAGE_NOW_MS));
});

function deepFreeze(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
