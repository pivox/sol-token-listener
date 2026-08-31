import { generateKeyPairSync, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  verifySignedSafetyQualificationEvidence,
} from '../src/domain/execution-safety-attestation.js';
import {
  createSafetyQualification,
  EXECUTION_SAFETY_GATE_IDS,
} from '../src/domain/execution-safety-qualification.js';

const keyPair = generateKeyPairSync('ed25519');
const trustedPublicKeyBase64 = keyPair.publicKey.export({
  format: 'der', type: 'spki',
}).toString('base64');

void test('verifies an exact qualification payload signed by the trusted deployment key', () => {
  const payload = qualificationInput();
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8');
  const envelope = {
    payloadVersion: 1,
    algorithm: 'Ed25519',
    signedPayloadBase64: encoded.toString('base64'),
    signatureBase64: sign(null, encoded, keyPair.privateKey).toString('base64'),
  };
  assert.deepEqual(
    verifySignedSafetyQualificationEvidence(envelope, trustedPublicKeyBase64),
    createSafetyQualification(payload),
  );
});

void test('rejects raw gates, a forged payload and an untrusted public key', () => {
  const payload = qualificationInput();
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8');
  const envelope = {
    payloadVersion: 1,
    algorithm: 'Ed25519',
    signedPayloadBase64: encoded.toString('base64'),
    signatureBase64: sign(null, encoded, keyPair.privateKey).toString('base64'),
  };
  const forged = Buffer.from(JSON.stringify({ ...payload, buildHash: 'f'.repeat(64) }), 'utf8');
  assert.throws(() => verifySignedSafetyQualificationEvidence(
    payload.gates,
    trustedPublicKeyBase64,
  ));
  assert.throws(() => verifySignedSafetyQualificationEvidence({
    ...envelope,
    signedPayloadBase64: forged.toString('base64'),
  }, trustedPublicKeyBase64));
  const other = generateKeyPairSync('ed25519').publicKey.export({
    format: 'der', type: 'spki',
  }).toString('base64');
  assert.throws(() => verifySignedSafetyQualificationEvidence(envelope, other));
});

function qualificationInput() {
  const nowMs = 1_788_134_400_000;
  const evidenceTypes = [
    'CI_RUN', 'MIGRATION_TEST', 'ARCHITECTURE_TEST', 'DRY_RUN_TEST',
    'SIMULATION_ARTIFACT', 'FAULT_TEST', 'RECONCILIATION_STATE',
    'PROVIDER_SNAPSHOT', 'STOP_CONTROL_TEST', 'WALLET_SNAPSHOT',
    'MAINNET_SIMULATION_ARTIFACT',
  ] as const;
  return {
    payloadVersion: 1 as const, evaluatorVersion: 1 as const, phase: 'CANARY' as const,
    buildHash: 'a'.repeat(64), configurationFingerprint: 'b'.repeat(64),
    strategyFingerprint: 'c'.repeat(64),
    generationId: `execution_wallet_generation_${'d'.repeat(64)}`,
    walletPublicKey: '11111111111111111111111111111111',
    cluster: 'mainnet-beta' as const, genesisHash: '11111111111111111111111111111111',
    providerId: 'primary', qualifiedAtMs: nowMs, expiresAtMs: nowMs + 300_000,
    gates: EXECUTION_SAFETY_GATE_IDS.map((gateId, index) => ({
      payloadVersion: 1 as const, gateId, status: 'PASSED' as const,
      evidenceType: evidenceTypes[index], evidenceId: `evidence:${index}`,
      evidenceFingerprint: index.toString(16).repeat(64),
      observedAtMs: nowMs - 1_000 + index, expiresAtMs: nowMs + 300_000,
    })),
  };
}
