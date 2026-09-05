import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionReadinessManifest } from '../src/domain/execution-readiness.js';
import {
  createExecutionPreflightBundle,
  type ExecutionPreflightBundleDraftV1,
} from '../src/domain/execution-preflight-bundle.js';
import { canaryEvidenceInput } from './helpers/execution-canary-fixture.js';

function omit(
  value: object,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  ));
}

function validDraft(): ExecutionPreflightBundleDraftV1 {
  const source = canaryEvidenceInput();
  const qualification = source.qualification;
  const walletSnapshot = source.walletSnapshot;
  const providerSnapshot = source.providerSnapshot;
  if (typeof source.targetIntentId !== 'string'
    || typeof source.capturedAtMs !== 'number'
    || typeof source.expiresAtMs !== 'number') throw new TypeError();
  const readiness = createExecutionReadinessManifest(Object.freeze({
    generationId: qualification.generationId,
    walletPublicKey: qualification.walletPublicKey,
    cluster: qualification.cluster,
    providerId: qualification.providerId,
    walletSnapshotId: walletSnapshot.snapshotId,
    walletSnapshotFingerprint: walletSnapshot.snapshotFingerprint,
    providerSnapshotId: providerSnapshot.snapshotId,
    providerSnapshotFingerprint: providerSnapshot.snapshotFingerprint,
    walletLamports: walletSnapshot.walletLamports,
    tokenBalanceCount: walletSnapshot.tokenBalanceCount,
    observedAtMs: walletSnapshot.observedAtMs,
    expiresAtMs: providerSnapshot.expiresAtMs,
  }));
  return Object.freeze({
    schemaVersion: 'execution-preflight-bundle-draft.v1',
    readiness,
    qualification: omit(qualification, ['qualificationId', 'qualificationFingerprint']),
    canary: Object.freeze({
      payloadVersion: 1,
      targetIntentId: source.targetIntentId,
      policy: omit(source.policy, ['payloadVersion', 'policyFingerprint']),
      walletSnapshot: omit(walletSnapshot, ['snapshotId', 'payloadVersion', 'snapshotFingerprint']),
      providerSnapshot: omit(providerSnapshot, ['snapshotId', 'payloadVersion', 'snapshotFingerprint']),
      allEndpointsUnavailable: false,
      capturedAtMs: source.capturedAtMs,
      expiresAtMs: source.expiresAtMs,
    }),
  });
}

void test('reconstructs exact qualification and canary evidence from a strict H2d-bound draft', () => {
  const draft = validDraft();
  const bundle = createExecutionPreflightBundle(draft);
  assert.equal(bundle.qualification.qualificationId, canaryEvidenceInput().qualification.qualificationId);
  assert.equal(bundle.canary.targetIntentId, canaryEvidenceInput().targetIntentId);
  assert.equal(bundle.canary.walletSnapshot.snapshotId, draft.readiness.walletSnapshotId);
  assert.equal(bundle.canary.providerSnapshot.snapshotId, draft.readiness.providerSnapshotId);
});

void test('rejects readiness identity drift and unknown draft fields', () => {
  const draft = validDraft();
  assert.throws(() => createExecutionPreflightBundle(Object.freeze({
    ...draft,
    readiness: Object.freeze({ ...draft.readiness, providerId: 'other-provider' }),
  })), /Invalid execution preflight bundle/u);
  assert.throws(() => createExecutionPreflightBundle(Object.freeze({ ...draft, arm: true })),
    /Invalid execution preflight bundle/u);
});

void test('rejects a sidecar not exactly bound to the H2d snapshots', () => {
  const draft = validDraft();
  assert.throws(() => createExecutionPreflightBundle(Object.freeze({
    ...draft,
    canary: Object.freeze({
      ...draft.canary,
      walletSnapshot: Object.freeze({
        ...draft.canary.walletSnapshot,
        walletLamports: 999_999n,
      }),
    }),
  })), /Invalid execution preflight bundle/u);
});
