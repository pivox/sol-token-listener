import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionCanaryEvidence,
  ExecutionCanaryValidationError,
} from '../src/domain/execution-canary.js';
import { canaryEvidenceInput, envelopeCanaryEvidenceInput } from './helpers/execution-canary-fixture.js';

void test('creates deterministic frozen evidence bound to exact qualification gates and snapshots', () => {
  const evidence = createExecutionCanaryEvidence(canaryEvidenceInput());
  assert.match(evidence.evidenceId, /^execution_canary_evidence_[0-9a-f]{64}$/u);
  assert.match(evidence.evidenceFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(evidence.allEndpointsUnavailable, false);
  assert.notEqual(createExecutionCanaryEvidence({
    ...canaryEvidenceInput(), targetIntentId: `execution_intent_${'f'.repeat(64)}`,
  }).evidenceFingerprint, evidence.evidenceFingerprint);
});

void test('rejects divergent gates, mutable nested objects, all-endpoints-unavailable and non-exact payloads', () => {
  const input = canaryEvidenceInput();
  for (const invalid of [
    { ...input, allEndpointsUnavailable: true },
    { ...input, qualification: { ...input.qualification } },
    { ...input, targetIntentId: 'invalid' },
    { ...input, extra: true },
    new Proxy(input, {}),
  ]) assert.throws(() => createExecutionCanaryEvidence(invalid), ExecutionCanaryValidationError);
});

void test('keeps CANARY v1 evidence byte-identical and bound to exact snapshot ids', () => {
  const input = canaryEvidenceInput();
  assert.equal(createExecutionCanaryEvidence(input).evidenceFingerprint,
    'a092c637dcc636d4d6e1dccf64f91506ddccb2fbdade161561efd76686e20f56');
  const otherWallet = canaryEvidenceInput({ walletSnapshot: { walletLamports: 999_999n } }).walletSnapshot;
  const otherProvider = canaryEvidenceInput({ providerSnapshot: { usedUnits: 2n } }).providerSnapshot;
  assert.throws(() => createExecutionCanaryEvidence({ ...input, walletSnapshot: otherWallet }),
    ExecutionCanaryValidationError);
  assert.throws(() => createExecutionCanaryEvidence({ ...input, providerSnapshot: otherProvider }),
    ExecutionCanaryValidationError);
});

void test('binds ENVELOPE v2 evidence to generation and provider identities, not snapshot ids', () => {
  const input = envelopeCanaryEvidenceInput();
  const evidence = createExecutionCanaryEvidence(input);
  assert.equal(evidence.qualification.payloadVersion, 2);
  const otherWallet = canaryEvidenceInput({ walletSnapshot: { walletLamports: 999_999n } }).walletSnapshot;
  const otherProvider = canaryEvidenceInput({ providerSnapshot: { usedUnits: 2n } }).providerSnapshot;
  assert.notEqual(otherWallet.snapshotId, input.walletSnapshot.snapshotId);
  assert.notEqual(otherProvider.snapshotId, input.providerSnapshot.snapshotId);
  const accepted = createExecutionCanaryEvidence({ ...input, walletSnapshot: otherWallet,
    providerSnapshot: otherProvider });
  assert.notEqual(accepted.evidenceFingerprint, evidence.evidenceFingerprint);
  for (const invalid of [
    { ...input, walletSnapshot: canaryEvidenceInput({ walletSnapshot: { providerId: 'secondary' } }).walletSnapshot },
    { ...input, walletSnapshot: canaryEvidenceInput({ walletSnapshot: {
      generationId: `execution_wallet_generation_${'e'.repeat(64)}` } }).walletSnapshot },
    { ...input, providerSnapshot: canaryEvidenceInput({ providerSnapshot: { providerId: 'secondary' } }).providerSnapshot },
    { ...input, qualification: { ...input.qualification } },
  ]) assert.throws(() => createExecutionCanaryEvidence(invalid), ExecutionCanaryValidationError);
});
