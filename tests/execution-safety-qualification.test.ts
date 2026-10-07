import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEnvelopeBindingGates,
  createSafetyQualification,
  ENVELOPE_QUALIFICATION_MAXIMUM_TTL_MS,
  EXECUTION_SAFETY_GATE_IDS,
  ExecutionSafetyQualificationValidationError,
  qualificationScope,
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

void test('keeps the CANARY v1 identity byte-identical', () => {
  const qualification = createSafetyQualification(input());
  assert.equal(qualification.qualificationFingerprint,
    'e1df15d5f8b1d596a79d75b03600e2e63fe3fa92a7f45ef801ec121dc6cb055c');
  assert.equal(qualification.qualificationId,
    'execution_safety_qualification_e1df15d5f8b1d596a79d75b03600e2e63fe3fa92a7f45ef801ec121dc6cb055c');
  assert.equal(qualification.payloadVersion, 1);
  assert.equal('scope' in qualification, false);
  assert.equal(qualificationScope(qualification), 'CANARY');
  assert.throws(() => createSafetyQualification(input({ scope: 'CANARY' })),
    ExecutionSafetyQualificationValidationError);
  assert.throws(() => createSafetyQualification(input({ scope: 'ENVELOPE' })),
    ExecutionSafetyQualificationValidationError);
});

void test('creates a frozen ENVELOPE-scoped v2 qualification for up to 24 hours', () => {
  for (const ttl of [1, 3_600_000, ENVELOPE_QUALIFICATION_MAXIMUM_TTL_MS]) {
    const qualification = createSafetyQualification(envelopeInput(ttl));
    assert.equal(qualification.payloadVersion, 2);
    assert.equal(qualificationScope(qualification), 'ENVELOPE');
    assert.equal(qualification.payloadVersion === 2 && qualification.scope, 'ENVELOPE');
    assert.equal(qualification.phase, 'CANARY');
    assert.equal(qualification.expiresAtMs - qualification.qualifiedAtMs, ttl);
    assert.match(qualification.qualificationId, /^execution_safety_qualification_[0-9a-f]{64}$/u);
    assert.equal(Object.isFrozen(qualification), true);
    assert.equal(Object.isFrozen(qualification.gates), true);
    assert.deepEqual(createSafetyQualification(envelopeInput(ttl)), qualification);
  }
  assert.equal(ENVELOPE_QUALIFICATION_MAXIMUM_TTL_MS, 86_400_000);
});

void test('rejects ENVELOPE v2 qualifications outside scope, phase and TTL bounds', () => {
  for (const candidate of [
    envelopeInput(ENVELOPE_QUALIFICATION_MAXIMUM_TTL_MS + 1),
    envelopeInput(0),
    { ...envelopeInput(3_600_000), phase: 'MICRO_LIVE' },
    { ...envelopeInput(3_600_000), phase: 'PILOT' },
    { ...envelopeInput(3_600_000), scope: 'CANARY' },
    { ...envelopeInput(3_600_000), evaluatorVersion: 2 },
    (() => { const { scope: _scope, ...rest } = envelopeInput(3_600_000); return rest; })(),
    { ...envelopeInput(3_600_000), payloadVersion: 3 },
    { ...envelopeInput(3_600_000), extra: true },
  ]) assert.throws(() => createSafetyQualification(candidate),
    ExecutionSafetyQualificationValidationError);
  const accessor = { ...envelopeInput(3_600_000) } as Record<string, unknown>;
  Object.defineProperty(accessor, 'payloadVersion', { enumerable: true, get() { return 2; } });
  assert.throws(() => createSafetyQualification(accessor), ExecutionSafetyQualificationValidationError);
});

void test('requires ENVELOPE gates 7 and 9 to be the deterministic binding evidence', () => {
  const ttl = 3_600_000;
  const valid = envelopeInput(ttl);
  const gates = valid.gates;
  for (const index of [7, 9]) {
    for (const change of [
      { evidenceId: 'evidence:other' },
      { evidenceFingerprint: 'f'.repeat(64) },
    ]) {
      const candidate = { ...valid,
        gates: gates.map((gate, gateIndex) => gateIndex === index ? { ...gate, ...change } : gate) };
      assert.throws(() => createSafetyQualification(candidate),
        ExecutionSafetyQualificationValidationError);
    }
  }
  const otherProvider = createEnvelopeBindingGates({
    generationId: valid.generationId, walletPublicKey: valid.walletPublicKey,
    providerId: 'secondary', observedAtMs: NOW_MS - 1_000, expiresAtMs: NOW_MS + ttl,
  });
  assert.throws(() => createSafetyQualification({ ...valid,
    gates: gates.map((gate, index) => index === 7 ? otherProvider.provider : gate) }),
  ExecutionSafetyQualificationValidationError);
  const binding = createEnvelopeBindingGates({
    generationId: valid.generationId, walletPublicKey: valid.walletPublicKey,
    providerId: valid.providerId, observedAtMs: NOW_MS - 1_000, expiresAtMs: NOW_MS + ttl,
  });
  assert.equal(binding.provider.gateId, 'PROVIDER_EXIT_CAPACITY_VERIFIED');
  assert.equal(binding.provider.evidenceType, 'PROVIDER_SNAPSHOT');
  assert.equal(binding.provider.evidenceId, 'envelope-provider:primary');
  assert.equal(binding.wallet.gateId, 'WALLET_CHAIN_LIMITS_VERIFIED');
  assert.equal(binding.wallet.evidenceType, 'WALLET_SNAPSHOT');
  assert.equal(binding.wallet.evidenceId, valid.generationId);
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.provider), true);
  assert.notEqual(binding.provider.evidenceFingerprint, otherProvider.provider.evidenceFingerprint);
});

void test('ENVELOPE v2 fingerprint differs from the CANARY v1 fingerprint for identical fields', () => {
  const v2 = createSafetyQualification(envelopeInput(300_000));
  const { scope: _scope, ...rest } = envelopeInput(300_000);
  const v1 = createSafetyQualification({ ...rest, payloadVersion: 1 });
  assert.equal(v1.payloadVersion, 1);
  assert.notEqual(v2.qualificationFingerprint, v1.qualificationFingerprint);
  assert.notEqual(v2.qualificationId, v1.qualificationId);
});

function envelopeInput(ttlMs: number) {
  const base = input({ expiresAtMs: NOW_MS + ttlMs });
  const binding = createEnvelopeBindingGates({
    generationId: base.generationId as string, walletPublicKey: base.walletPublicKey as string,
    providerId: base.providerId as string, observedAtMs: NOW_MS - 1_000,
    expiresAtMs: NOW_MS + Math.max(ttlMs, 300_000),
  });
  const gates = gateEvidence().map((gate, index) => index === 7 ? binding.provider
    : index === 9 ? binding.wallet
      : { ...gate, expiresAtMs: NOW_MS + Math.max(ttlMs, 300_000) });
  return { ...base, payloadVersion: 2, scope: 'ENVELOPE', gates } as Record<string, unknown> & {
    generationId: string; walletPublicKey: string; providerId: string;
    gates: readonly Record<string, unknown>[];
  };
}

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
