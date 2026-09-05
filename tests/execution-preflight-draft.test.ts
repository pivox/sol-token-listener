import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionPreflightBundle } from '../src/domain/execution-preflight-bundle.js';
import { createExecutionPreflightDraft } from '../src/domain/execution-preflight-draft.js';
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
