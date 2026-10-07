import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionPreflightBundle } from '../src/domain/execution-preflight-bundle.js';
import {
  createEnvelopeQualificationDraft,
  createExecutionPreflightDraft,
  createExecutionPreflightDraftSource,
  createExecutionPreflightDraftSourceProofFingerprint,
} from '../src/domain/execution-preflight-draft.js';
import {
  createEnvelopeBindingGates,
  createMainnetSimulationEvidenceFingerprint,
  createSafetyQualification,
} from '../src/domain/execution-safety-qualification.js';
import { NOW_MS } from './helpers/execution-canary-fixture.js';
import { preflightDraftInputs } from './helpers/execution-preflight-draft-fixture.js';

void test('builds an H2f draft from exact persisted identities and eight static gates', () => {
  const input = preflightDraftInputs();
  const bundle = createExecutionPreflightBundle(
    createExecutionPreflightDraft(input.source, input.catalog),
  );
  assert.equal(bundle.canary.targetIntentId, input.source.target.intent.id);
  assert.equal(bundle.qualification.gates[7]?.evidenceId, input.source.providerSnapshot.snapshotId);
  assert.equal(bundle.qualification.gates[9]?.evidenceId, input.source.walletSnapshot.snapshotId);
  assert.equal(bundle.qualification.gates[10]?.evidenceId, input.source.simulation.artifactId);
  assert.equal(bundle.canary.expiresAtMs, NOW_MS + 60_000);
  assert.notEqual(input.source.simulation.intentId, input.source.target.intent.id);
});

void test('reconstructs the preparation-bound H2h v2 source before a gate catalog exists', () => {
  const input = preflightDraftInputs();
  assert.deepEqual(createExecutionPreflightDraftSource(input.source), input.source);
  assert.throws(() => createExecutionPreflightDraftSource(Object.freeze({ ...input.source,
    readiness: Object.freeze({ ...input.source.readiness, walletLamports: '999' }),
  })), /Invalid execution preflight draft/u);
});

void test('keeps v1 readable but never authorizes its unproved target', () => {
  const input = preflightDraftInputs();
  const legacyIntent = Object.freeze(Object.fromEntries(Object.entries(input.source.target.intent)
    .filter(([key]) => key !== 'candidateId')));
  const legacy = Object.freeze({
    schemaVersion: 'execution-preflight-draft-source.v1' as const,
    readiness: input.source.readiness,
    generation: input.source.generation,
    walletSnapshot: input.source.walletSnapshot,
    providerSnapshot: input.source.providerSnapshot,
    target: Object.freeze({ ...input.source.target, intent: legacyIntent }),
    simulation: input.source.simulation,
    databaseNowMs: input.source.capturedAtMs,
  });
  assert.equal(createExecutionPreflightDraftSource(legacy).schemaVersion,
    'execution-preflight-draft-source.v1');
  assert.throws(() => createExecutionPreflightDraft(legacy, input.catalog),
    /Invalid execution preflight draft/u);
});

void test('rejects forged v2 lineage and proof fingerprints', () => {
  const input = preflightDraftInputs();
  assert.throws(() => createExecutionPreflightDraftSource(Object.freeze({ ...input.source,
    lineage: Object.freeze({ ...input.source.lineage,
      candidateConfirmationStatus: 'orphaned' }),
  })), /Invalid execution preflight draft/u);
  assert.throws(() => createExecutionPreflightDraftSource(Object.freeze({ ...input.source,
    proofFingerprint: 'f'.repeat(64),
  })), /Invalid execution preflight draft/u);
  const { proofFingerprint: _proofFingerprint, ...unsigned } = input.source;
  void _proofFingerprint;
  const forgedRun = Object.freeze({ ...unsigned, lineage: Object.freeze({
    ...unsigned.lineage, preparationRunFingerprint: 'f'.repeat(64),
  }) });
  assert.throws(() => createExecutionPreflightDraftSource(Object.freeze({ ...forgedRun,
    proofFingerprint: createExecutionPreflightDraftSourceProofFingerprint(forgedRun),
  })), /Invalid execution preflight draft/u);
});

void test('rejects stale simulation and target state drift', () => {
  const input = preflightDraftInputs();
  assert.throws(() => createExecutionPreflightDraft(Object.freeze({ ...input.source,
    simulation: Object.freeze({ ...input.source.simulation, recordedAtMs: NOW_MS - 30_001 }),
  }), input.catalog), /Invalid execution preflight draft/u);
  assert.throws(() => createExecutionPreflightDraft(Object.freeze({ ...input.source,
    target: Object.freeze({ ...input.source.target, leaseOwner: 'foreign-worker' }),
  }), input.catalog), /Invalid execution preflight draft/u);
});

void test('recomputes and rejects a forged wallet generation identity', () => {
  const input = preflightDraftInputs();
  assert.throws(() => createExecutionPreflightDraft(Object.freeze({ ...input.source,
    generation: Object.freeze({ ...input.source.generation, generation: 2 }),
  }), input.catalog), /Invalid execution preflight draft/u);
});

void test('reconstructs and rejects a forged simulation artifact fingerprint', () => {
  const input = preflightDraftInputs();
  assert.throws(() => createExecutionPreflightDraft(Object.freeze({ ...input.source,
    simulation: Object.freeze({ ...input.source.simulation, resultFingerprint: 'f'.repeat(64) }),
  }), input.catalog), /Invalid execution preflight draft/u);
});

void test('rejects missing or reordered static gates', () => {
  const input = preflightDraftInputs();
  assert.throws(() => createExecutionPreflightDraft(input.source, Object.freeze({
    ...input.catalog, gates: Object.freeze(input.catalog.gates.slice(1)),
  })), /Invalid execution preflight draft/u);
  assert.throws(() => createExecutionPreflightDraft(input.source, Object.freeze({
    ...input.catalog, gates: Object.freeze([input.catalog.gates[1], input.catalog.gates[0],
      ...input.catalog.gates.slice(2)]),
  })), /Invalid execution preflight draft/u);
});

void test('refuses to fabricate provider exit capacity when quota blocks a new entry', () => {
  const input = preflightDraftInputs();
  const entryBlockedPolicy = Object.freeze({
    ...input.catalog.policy,
    providerEntryCostUnits: 995n,
  });

  assert.throws(() => createExecutionPreflightDraft(input.source, Object.freeze({
    ...input.catalog,
    policy: entryBlockedPolicy,
  })), /Invalid execution preflight draft/u);
});

function envelopeDraftInput(overrides: Readonly<Record<string, unknown>> = {}) {
  const input = preflightDraftInputs();
  const simulation = input.source.simulation;
  if (simulation.buildFingerprint === null) throw new TypeError();
  return {
    catalog: input.catalog,
    generation: {
      generationId: input.source.generation.generationId,
      walletPublicKey: input.source.generation.walletPublicKey,
      genesisHash: input.source.generation.genesisHash,
    },
    providerId: simulation.providerId,
    simulation: {
      artifactId: simulation.artifactId, resultFingerprint: simulation.resultFingerprint,
      recordedAtMs: simulation.recordedAtMs, buildFingerprint: simulation.buildFingerprint as string,
      configurationFingerprint: simulation.configurationFingerprint,
    },
    qualifiedAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 300_000,
    ...overrides,
  };
}

void test('drafts an ENVELOPE qualification accepted by the v2 qualification', () => {
  const input = envelopeDraftInput();
  const draft = createEnvelopeQualificationDraft(input);
  assert.equal(draft.schemaVersion, 'execution-envelope-qualification-draft.v1');
  assert.ok(Object.isFrozen(draft));
  assert.equal('qualificationId' in draft.qualification, false);
  assert.equal('qualificationFingerprint' in draft.qualification, false);
  const qualification = createSafetyQualification(draft.qualification);
  assert.equal(qualification.payloadVersion, 2);
  assert.equal(qualification.expiresAtMs, NOW_MS + 300_000);
  assert.equal(qualification.strategyFingerprint, input.catalog.strategyFingerprint);
  const binding = createEnvelopeBindingGates({
    generationId: input.generation.generationId, walletPublicKey: input.generation.walletPublicKey,
    providerId: input.providerId, observedAtMs: NOW_MS, expiresAtMs: NOW_MS + 300_000,
  });
  assert.deepEqual(qualification.gates[7], binding.provider);
  assert.deepEqual(qualification.gates[9], binding.wallet);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 8].map((index) => qualification.gates[index]),
    input.catalog.gates);
  const simulationGate = qualification.gates[10];
  assert.equal(simulationGate?.evidenceId, input.simulation.artifactId);
  assert.equal(simulationGate?.observedAtMs, input.simulation.recordedAtMs);
  assert.equal(simulationGate?.expiresAtMs, NOW_MS + 300_000);
  assert.equal(simulationGate?.evidenceFingerprint, createMainnetSimulationEvidenceFingerprint({
    artifactId: input.simulation.artifactId, resultFingerprint: input.simulation.resultFingerprint,
    buildHash: input.simulation.buildFingerprint,
    configurationFingerprint: input.simulation.configurationFingerprint,
    strategyFingerprint: input.catalog.strategyFingerprint,
    walletPublicKey: input.generation.walletPublicKey, genesisHash: input.generation.genesisHash,
    providerId: input.providerId,
  }));
});

void test('rejects an envelope draft with a stale catalog gate', () => {
  const input = envelopeDraftInput();
  const gates = input.catalog.gates.map((gate, index) => index === 3
    ? Object.freeze({ ...gate, expiresAtMs: NOW_MS + 299_999 }) : gate);
  assert.throws(() => createEnvelopeQualificationDraft({ ...input,
    catalog: Object.freeze({ ...input.catalog, gates: Object.freeze(gates) }) }),
  /Invalid execution preflight draft/u);
});

void test('rejects an envelope draft beyond 24 hours, from the future or with a wrong catalog', () => {
  assert.throws(() => createEnvelopeQualificationDraft(envelopeDraftInput({
    expiresAtMs: NOW_MS + 86_400_001 })), /Invalid execution preflight draft/u);
  assert.throws(() => createEnvelopeQualificationDraft(envelopeDraftInput({
    expiresAtMs: NOW_MS })), /Invalid execution preflight draft/u);
  const input = envelopeDraftInput();
  assert.throws(() => createEnvelopeQualificationDraft({ ...input,
    simulation: { ...input.simulation, recordedAtMs: NOW_MS + 1 } }),
  /Invalid execution preflight draft/u);
  assert.throws(() => createEnvelopeQualificationDraft({ ...input,
    catalog: Object.freeze({ ...input.catalog, schemaVersion: 'other' }) }),
  /Invalid execution preflight draft/u);
  assert.throws(() => createEnvelopeQualificationDraft({ ...input, extra: true } as typeof input),
    /Invalid execution preflight draft/u);
});
