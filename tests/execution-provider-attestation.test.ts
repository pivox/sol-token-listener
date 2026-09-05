import { generateKeyPairSync, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExecutionProviderAttestationValidationError,
  verifySignedProviderUsageEvidence,
} from '../src/domain/execution-provider-attestation.js';
import { canonicalStringifyJson } from '../src/utils/json.js';

const NOW = 1_788_000_000_000;
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

function payload(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    providerId: 'primary', planId: 'paid-mainnet', billingPeriodId: '2026-09',
    billingPeriodStartedAtMs: NOW - 86_400_000,
    billingPeriodEndsAtMs: NOW + 86_400_000,
    limitUnits: '1000000', usedUnits: '1000', measuredAtMs: NOW,
    expiresAtMs: NOW + 300_000, provenance: 'OPERATOR_REPORT', ...overrides,
  });
}

function envelope(value = payload()): Readonly<Record<string, unknown>> {
  const encoded = Buffer.from(canonicalStringifyJson(value));
  return Object.freeze({
    payloadVersion: 1, algorithm: 'Ed25519', signedPayloadBase64: encoded.toString('base64'),
    signatureBase64: sign(null, encoded, keys.privateKey).toString('base64'),
  });
}

void test('verifies canonical provider evidence and returns the domain snapshot', () => {
  const result = verifySignedProviderUsageEvidence(envelope(), publicKey, 'primary', NOW);
  assert.equal(result.providerId, 'primary');
  assert.equal(result.limitUnits, 1_000_000n);
  assert.equal(result.usedUnits, 1_000n);
  assert.match(result.snapshotId, /^execution_provider_usage_[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(result));
});

void test('enforces provider binding, time bounds, provenance and signed canonical bytes', () => {
  const otherKeys = generateKeyPairSync('ed25519');
  const otherPublic = otherKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const invalid: readonly [unknown, string, string, number][] = [
    [envelope(), otherPublic, 'primary', NOW],
    [envelope(), publicKey, 'secondary', NOW],
    [envelope(payload({ measuredAtMs: NOW + 1 })), publicKey, 'primary', NOW],
    [envelope(payload({ expiresAtMs: NOW + 300_001 })), publicKey, 'primary', NOW],
    [envelope(payload({ provenance: 'AUTHORITATIVE_PROBE', expiresAtMs: NOW + 900_001 })),
      publicKey, 'primary', NOW],
    [envelope(payload({ provenance: 'UNKNOWN' })), publicKey, 'primary', NOW],
    [{ ...envelope() }, publicKey, 'primary', NOW],
  ];
  for (const args of invalid) assert.throws(
    () => verifySignedProviderUsageEvidence(args[0], args[1], args[2], args[3]),
    ExecutionProviderAttestationValidationError,
  );
});

