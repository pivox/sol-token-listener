import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionCanaryEvidence,
  ExecutionCanaryValidationError,
} from '../src/domain/execution-canary.js';
import { canaryEvidenceInput } from './helpers/execution-canary-fixture.js';

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
