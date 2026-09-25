import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  MAINNET_OBSERVE_CANARY_GATE_NAMES,
  evaluateMainnetObserveCanary,
  type MainnetObserveCanaryGateName,
} from '../scripts/lib/mainnet-observe-canary-verdict.js';

const fixtureUrl = new URL(
  './fixtures/mainnet-observe-canary/32c9bf4-failed.v1.json',
  import.meta.url,
);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8')) as unknown;

void test('keeps the real failed run failed while correcting four obsolete assertions', () => {
  const result = evaluateMainnetObserveCanary(fixture);
  assert.equal(result.overallVerdict, 'FAIL');
  for (const gate of ['catchUpAdmission', 'providerAffinity', 'finality', 'shutdown'] as const) {
    assert.equal(result.gates[gate].verdict, 'PASS');
  }
  for (const gate of [
    'runtime', 'backlog', 'terminalFailures', 'firstProcessing', 'blockHydration',
  ] as const) {
    assert.equal(result.gates[gate].verdict, 'FAIL');
  }
});

void test('accepts same-provider scan and worker sharing with coherent partitions', () => {
  const result = evaluateMainnetObserveCanary(fixture);
  assert.equal(result.gates.catchUpAdmission.verdict, 'PASS');
});

void test('treats positive monotone epoch invalidations as diagnostic', () => {
  const result = evaluateMainnetObserveCanary(fixture);
  assert.equal(result.gates.providerAffinity.verdict, 'PASS');
});

void test('accepts a structurally paired finality incident recovered before T0', () => {
  const result = evaluateMainnetObserveCanary(fixture);
  assert.equal(result.gates.finality.verdict, 'PASS');
});

void test('accepts coherent non-zero durable backlog after a clean shutdown', () => {
  const result = evaluateMainnetObserveCanary(fixture);
  assert.equal(result.gates.shutdown.verdict, 'PASS');
});

void test('uses the stopped RPC counters so a late HTTP 429 cannot be hidden', () => {
  const copy = cloneFixture();
  const stopped = nested(copy, 'stoppedHeartbeat');
  stopped.rpcHttpEvidence = JSON.parse(JSON.stringify(
    nested(copy, 'snapshots', 'FINAL_PRESTOP').rpcHttpEvidence,
  )) as unknown;
  const providers = nested(stopped, 'rpcHttpEvidence').providers as Record<string, unknown>[];
  assert.ok(providers[0]);
  providers[0].attempts = 2045;
  providers[0].http429Responses = 1;

  assert.equal(evaluateMainnetObserveCanary(copy).gates.http429.verdict, 'FAIL');
});

void test('preserves absent run-era terminal grouping instead of inventing reason codes', () => {
  const terminal = nested(cloneFixture(), 'terminalEvidence');
  assert.deepEqual(terminal.groups, []);
});

void test('does not label a generic degraded status as an identified periodic pause', () => {
  const copy = cloneFixture();
  const final = nested(copy, 'snapshots', 'FINAL_PRESTOP');
  final.subscriberState = 'RUNNING';
  final.scannerState = 'RUNNING';
  final.status = 'DEGRADED';
  const websocket = nested(final, 'websocket');
  websocket.phase = 'RUNNING';
  websocket.recoveryStatus = 'RECOVERED';
  websocket.recoveryReasonCode = 'STARTUP';

  assert.equal(evaluateMainnetObserveCanary(copy).gates.runtime.verdict, 'FAIL');
});

void test('rejects unknown closed-enum runtime states as inconclusive evidence', () => {
  const copy = cloneFixture();
  nested(copy, 'snapshots', 'T0').runtimeState = 'UNKNOWN_STATE';

  assert.equal(evaluateMainnetObserveCanary(copy).gates.runtime.verdict, 'INCONCLUSIVE');
});

void test('rejects chronologically out-of-order finality incident pairs', () => {
  const copy = cloneFixture();
  const diagnostics = copy.finalityDiagnostics as Record<string, unknown>[];
  diagnostics.push(
    { event: 'listener.finality_reconciler_degraded', phase: 'DEGRADED',
      reasonCode: 'PROVIDER_UNAVAILABLE', degradedAtMs: 1790313390000,
      observedAtMs: 1790313390000 },
    { event: 'listener.finality_reconciler_recovered', phase: 'RECOVERED',
      reasonCode: null, degradedAtMs: 1790313390000, observedAtMs: 1790313390050 },
  );

  assert.equal(evaluateMainnetObserveCanary(copy).gates.finality.verdict, 'INCONCLUSIVE');
});

void test('classifies unsafe and incomplete gate evidence without allowing unrelated PASS gates to override it', () => {
  const cases: readonly [string, (copy: Record<string, unknown>) => void,
  MainnetObserveCanaryGateName, 'FAIL' | 'INCONCLUSIVE'][] = [
    ['null provider with active scan', (copy) => {
      nested(copy, 'snapshots', 'T_PLUS_5', 'catchUpAdmission').providerId = null;
    }, 'catchUpAdmission', 'INCONCLUSIVE'],
    ['partition mismatch', (copy) => {
      nested(copy, 'snapshots', 'T_PLUS_5', 'catchUpAdmission', 'source').websocketOnly = 1;
    }, 'catchUpAdmission', 'INCONCLUSIVE'],
    ['provider switch without mixing proof', (copy) => {
      nested(copy, 'snapshots', 'T_PLUS_15', 'catchUpAdmission').providerId = 'secondary';
    }, 'providerAffinity', 'INCONCLUSIVE'],
    ['mixed-provider evidence', (copy) => {
      copy.providerMixingEvidenceCount = 1;
    }, 'providerAffinity', 'FAIL'],
    ['unresolved finality incident', (copy) => {
      (copy.finalityDiagnostics as unknown[]).pop();
    }, 'finality', 'FAIL'],
    ['shutdown lease remains', (copy) => {
      nested(copy, 'stoppedHeartbeat').leasedCount = 1;
    }, 'shutdown', 'FAIL'],
    ['shutdown SQL count differs', (copy) => {
      copy.postStopActionableCount = 26741;
    }, 'shutdown', 'INCONCLUSIVE'],
    ['terminal reasons missing', (copy) => {
      nested(copy, 'terminalEvidence').groups = [];
      nested(copy, 'terminalEvidence', 'final').exhausted = 0;
    }, 'terminalFailures', 'INCONCLUSIVE'],
  ];

  for (const [name, mutate, gate, verdict] of cases) {
    const copy = cloneFixture();
    mutate(copy);
    const result = evaluateMainnetObserveCanary(copy);
    assert.equal(result.gates[gate].verdict, verdict, name);
    assert.notEqual(result.overallVerdict, 'PASS', name);
  }
});

void test('returns bounded inconclusive output for hostile or non-exact input without invoking accessors', () => {
  let accessorReads = 0;
  const accessor = cloneFixture();
  Object.defineProperty(accessor, 'commit', {
    enumerable: true,
    get() { accessorReads += 1; return '32c9bf4c35268219184bd054f1e1f643065ecfd6'; },
  });
  const unexpected = cloneFixture();
  unexpected.rpcUrl = 'must-not-leak';
  const negativeZero = cloneFixture();
  nested(negativeZero, 'snapshots', 'T0').backlogCount = -0;
  const unsafeInteger = cloneFixture();
  nested(unsafeInteger, 'snapshots', 'T0').backlogCount = Number.MAX_SAFE_INTEGER + 1;
  const secretField = cloneFixture();
  nested(secretField, 'snapshots', 'T0').privateKey = 'must-not-leak';

  for (const input of [
    new Proxy(cloneFixture(), {}), accessor, unexpected, negativeZero, unsafeInteger, secretField,
  ]) {
    const result = evaluateMainnetObserveCanary(input);
    assert.equal(result.overallVerdict, 'INCONCLUSIVE');
    assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
    assert.deepEqual(Object.keys(result.gates), MAINNET_OBSERVE_CANARY_GATE_NAMES);
  }
  assert.equal(accessorReads, 0);
});

function cloneFixture(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
}

function nested(root: Record<string, unknown>, ...keys: readonly string[]): Record<string, unknown> {
  let value: unknown = root;
  for (const key of keys) {
    assert.equal(typeof value, 'object');
    assert.notEqual(value, null);
    value = (value as Record<string, unknown>)[key];
  }
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}
