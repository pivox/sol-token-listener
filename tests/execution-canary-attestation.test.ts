import { generateKeyPairSync, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  verifySignedExecutionCanaryEvidence,
  ExecutionCanaryAttestationValidationError,
} from '../src/domain/execution-canary-attestation.js';
import { createExecutionCanaryEvidence } from '../src/domain/execution-canary.js';
import { canaryEvidenceInput } from './helpers/execution-canary-fixture.js';
import { canonicalStringifyJson, stringifyJson } from '../src/utils/json.js';

const keyPair = generateKeyPairSync('ed25519');
const trustedPublicKeyBase64 = keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

void test('verifies an exact bounded signed CANARY sidecar and returns frozen canonical evidence', () => {
  const payload = canaryEvidenceInput();
  const encoded = Buffer.from(canonicalStringifyJson(payload), 'utf8');
  const envelope = Object.freeze({
    payloadVersion: 1 as const, algorithm: 'Ed25519' as const,
    signedPayloadBase64: encoded.toString('base64'),
    signatureBase64: sign(null, encoded, keyPair.privateKey).toString('base64'),
  });
  assert.deepEqual(verifySignedExecutionCanaryEvidence(envelope, trustedPublicKeyBase64),
    createExecutionCanaryEvidence(payload));
});

void test('rejects a validly signed but mutable envelope before parsing it', () => {
  const payload = canaryEvidenceInput();
  const encoded = Buffer.from(canonicalStringifyJson(payload), 'utf8');
  const envelope = {
    payloadVersion: 1 as const, algorithm: 'Ed25519' as const,
    signedPayloadBase64: encoded.toString('base64'),
    signatureBase64: sign(null, encoded, keyPair.privateKey).toString('base64'),
  };
  assert.throws(() => verifySignedExecutionCanaryEvidence(envelope, trustedPublicKeyBase64),
    ExecutionCanaryAttestationValidationError);
});

void test('rejects a validly signed repository-codec payload whose JSON bytes are non-canonical', () => {
  const text = stringifyJson(canaryEvidenceInput());
  assert.notEqual(text, canonicalStringifyJson(canaryEvidenceInput()));
  const payload = Buffer.from(text, 'utf8');
  const envelope = Object.freeze({
    payloadVersion: 1 as const, algorithm: 'Ed25519' as const,
    signedPayloadBase64: payload.toString('base64'),
    signatureBase64: sign(null, payload, keyPair.privateKey).toString('base64'),
  });
  assert.throws(() => verifySignedExecutionCanaryEvidence(envelope, trustedPublicKeyBase64),
    ExecutionCanaryAttestationValidationError);
});

void test('rejects untrusted keys, non-canonical base64, forged or oversized payloads and mutable envelope objects', () => {
  const payload = canaryEvidenceInput();
  const encoded = Buffer.from(canonicalStringifyJson(payload), 'utf8');
  const envelope = Object.freeze({
    payloadVersion: 1 as const, algorithm: 'Ed25519' as const,
    signedPayloadBase64: encoded.toString('base64'),
    signatureBase64: sign(null, encoded, keyPair.privateKey).toString('base64'),
  });
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  for (const invalid of [
    [envelope, other],
    [Object.freeze({ ...envelope, signedPayloadBase64: `${envelope.signedPayloadBase64}=` }), trustedPublicKeyBase64],
    [Object.freeze({ ...envelope, signatureBase64: sign(null, Buffer.from('{"forged":true}'), keyPair.privateKey).toString('base64') }), trustedPublicKeyBase64],
    [new Proxy(envelope, {}), trustedPublicKeyBase64],
    [Object.freeze({ ...envelope, signedPayloadBase64: Buffer.alloc(131_073).toString('base64') }), trustedPublicKeyBase64],
  ] as const) assert.throws(
    () => verifySignedExecutionCanaryEvidence(invalid[0], invalid[1]),
    ExecutionCanaryAttestationValidationError,
  );
});
