import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSafetyQualification,
  EXECUTION_SAFETY_GATE_IDS,
  ExecutionSafetyQualificationValidationError,
} from '../src/domain/execution-safety-qualification.js';

const NOW_MS = 1_788_134_400_000;

void test('creates one deterministic frozen qualification from the eleven canonical gates', () => {
  const qualification = createSafetyQualification(input());
  assert.match(qualification.qualificationId, /^execution_safety_qualification_[0-9a-f]{64}$/u);
  assert.match(qualification.qualificationFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(qualification.expiresAtMs - qualification.qualifiedAtMs, 300_000);
  assert.deepEqual(qualification.gates.map((gate) => gate.gateId), EXECUTION_SAFETY_GATE_IDS);
  assert.equal(Object.isFrozen(qualification), true);
  assert.equal(Object.isFrozen(qualification.gates), true);
  assert.equal(Object.isFrozen(qualification.gates[0]), true);
  assert.deepEqual(createSafetyQualification(input()), qualification);
});

void test('binds identity to build, configuration, strategy, wallet, provider and phase', () => {
  const baseline = createSafetyQualification(input());
  for (const changed of [
    input({ buildHash: 'b'.repeat(64) }),
    input({ configurationFingerprint: 'c'.repeat(64) }),
    input({ strategyFingerprint: 'd'.repeat(64) }),
    input({ phase: 'MICRO_LIVE' }),
    input({ providerId: 'secondary' }),
  ]) {
    assert.notEqual(createSafetyQualification(changed).qualificationFingerprint,
      baseline.qualificationFingerprint);
  }
});

void test('rejects missing, reordered, duplicated, stale and overlong gate evidence', () => {
  const gates = gateEvidence();
  for (const candidate of [
    gates.slice(0, -1),
    [gates[1], gates[0], ...gates.slice(2)],
    [gates[0], gates[0], ...gates.slice(2)],
    gates.map((gate, index) => index === 5 ? { ...gate, expiresAtMs: NOW_MS + 299_999 } : gate),
  ]) assert.throws(
    () => createSafetyQualification(input({ gates: candidate })),
    ExecutionSafetyQualificationValidationError,
  );
  assert.throws(
    () => createSafetyQualification(input({ expiresAtMs: NOW_MS + 300_001 })),
    ExecutionSafetyQualificationValidationError,
  );
});

void test('rejects extra keys, accessors, proxies, unsafe timestamps and malformed identities', () => {
  const withExtra = { ...input(), secret: 'forbidden' };
  const accessor = { ...input() } as Record<string, unknown>;
  Object.defineProperty(accessor, 'providerId', { enumerable: true, get() { throw new Error('secret'); } });
  for (const candidate of [
    withExtra,
    accessor,
    new Proxy(input(), {}),
    input({ qualifiedAtMs: Number.MAX_SAFE_INTEGER + 1 }),
    input({ walletPublicKey: 'not-a-public-key' }),
    input({ cluster: 'devnet' }),
  ]) assert.throws(
    () => createSafetyQualification(candidate),
    (error) => error instanceof ExecutionSafetyQualificationValidationError
      && error.message === 'Invalid execution safety qualification.',
  );
});

function input(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    payloadVersion: 1,
    evaluatorVersion: 1,
    phase: 'CANARY',
    buildHash: 'a'.repeat(64),
    configurationFingerprint: '1'.repeat(64),
    strategyFingerprint: '2'.repeat(64),
    generationId: `execution_wallet_generation_${'3'.repeat(64)}`,
    walletPublicKey: '11111111111111111111111111111111',
    cluster: 'mainnet-beta',
    genesisHash: '11111111111111111111111111111111',
    providerId: 'primary',
    qualifiedAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 300_000,
    gates: gateEvidence(),
    ...overrides,
  };
}

function gateEvidence() {
  return EXECUTION_SAFETY_GATE_IDS.map((gateId, index) => Object.freeze({
    payloadVersion: 1 as const,
    gateId,
    status: 'PASSED' as const,
    evidenceType: [
      'CI_RUN',
      'MIGRATION_TEST',
      'ARCHITECTURE_TEST',
      'DRY_RUN_TEST',
      'SIMULATION_ARTIFACT',
      'FAULT_TEST',
      'RECONCILIATION_STATE',
      'PROVIDER_SNAPSHOT',
      'STOP_CONTROL_TEST',
      'WALLET_SNAPSHOT',
      'MAINNET_SIMULATION_ARTIFACT',
    ][index],
    evidenceId: `evidence:${index}`,
    evidenceFingerprint: index.toString(16).repeat(64),
    observedAtMs: NOW_MS - 1_000 + index,
    expiresAtMs: NOW_MS + 300_000,
  }));
}
