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
  assert.deepEqual(terminal.baseline, { failed: 10, quarantined: 0, exhausted: 0 });
  assert.deepEqual(terminal.final, { failed: 54, quarantined: 190, exhausted: 2 });
});

void test('fails explained terminal deltas and keeps incomplete grouping inconclusive', () => {
  const complete = cloneFixture();
  const completeTerminal = nested(complete, 'terminalEvidence');
  completeTerminal.baseline = { failed: 10, quarantined: 0, exhausted: 0 };
  completeTerminal.final = { failed: 11, quarantined: 0, exhausted: 0 };
  completeTerminal.groups = [{ processingStatus: 'FAILED', reasonCode: 'PUMP_ACTION_SUPPORTED',
    errorCode: 'RPC_TRANSIENT', count: 1 }];
  assert.equal(evaluateMainnetObserveCanary(complete).gates.terminalFailures.verdict, 'FAIL');

  for (const mutate of [
    (copy: Record<string, unknown>) => { nested(copy, 'terminalEvidence').groups = []; },
    (copy: Record<string, unknown>) => {
      nested(copy, 'terminalEvidence').groups = [{ processingStatus: 'FAILED',
        reasonCode: 'PUMP_ACTION_SUPPORTED', errorCode: null, count: 1 }];
    },
    (copy: Record<string, unknown>) => {
      nested(copy, 'terminalEvidence').groups = [{ processingStatus: 'FAILED',
        reasonCode: 'UNKNOWN_REASON', errorCode: 'RPC_TRANSIENT', count: 1 }];
    },
    (copy: Record<string, unknown>) => {
      nested(copy, 'terminalEvidence').groups = [{ processingStatus: 'FAILED',
        reasonCode: 'PUMP_ACTION_SUPPORTED', errorCode: 'RPC_TRANSIENT', count: 2 }];
    },
  ]) {
    const copy = cloneFixture();
    nested(copy, 'terminalEvidence').baseline = { failed: 10, quarantined: 0, exhausted: 0 };
    nested(copy, 'terminalEvidence').final = { failed: 11, quarantined: 0, exhausted: 0 };
    mutate(copy);
    assert.equal(evaluateMainnetObserveCanary(copy).gates.terminalFailures.verdict,
      'INCONCLUSIVE');
  }
});

void test('reconciles terminal groups per status and rejects exhausted greater than failed', () => {
  const statusMismatch = cloneFixture();
  nested(statusMismatch, 'terminalEvidence').baseline = {
    failed: 10, quarantined: 0, exhausted: 0,
  };
  nested(statusMismatch, 'terminalEvidence').final = {
    failed: 11, quarantined: 1, exhausted: 0,
  };
  nested(statusMismatch, 'terminalEvidence').groups = [
    { processingStatus: 'FAILED', reasonCode: 'PUMP_ACTION_SUPPORTED',
      errorCode: 'RPC_TRANSIENT', count: 2 },
  ];
  assert.equal(evaluateMainnetObserveCanary(statusMismatch).gates.terminalFailures.verdict,
    'INCONCLUSIVE');

  const impossibleExhaustion = cloneFixture();
  nested(impossibleExhaustion, 'terminalEvidence').baseline = {
    failed: 10, quarantined: 0, exhausted: 0,
  };
  nested(impossibleExhaustion, 'terminalEvidence').final = {
    failed: 10, quarantined: 0, exhausted: 11,
  };
  assert.equal(evaluateMainnetObserveCanary(impossibleExhaustion).gates.terminalFailures.verdict,
    'INCONCLUSIVE');
});

void test('captures one process and a strictly advancing first-processing cohort in every snapshot', () => {
  const copy = cloneFixture();
  const samples: number[] = [];
  for (const name of ['T0', 'T_PLUS_5', 'T_PLUS_15', 'FINAL_PRESTOP']) {
    const snapshot = nested(copy, 'snapshots', name);
    assert.equal(snapshot.startedAtMs, 1790313390116);
    const evidence = nested(snapshot, 'firstProcessingCanary');
    assert.equal(evidence.cohortStartedAtMs, 1790313390116);
    samples.push(evidence.sampledAtMs as number);
  }
  const stopped = nested(copy, 'stoppedHeartbeat', 'firstProcessingCanary');
  samples.push(stopped.sampledAtMs as number);
  assert.deepEqual(samples, [...samples].sort((left, right) => left - right));

  nested(copy, 'snapshots', 'T_PLUS_5').startedAtMs = 1790313390117;
  assert.equal(evaluateMainnetObserveCanary(copy).gates.firstProcessing.verdict,
    'INCONCLUSIVE');
});

void test('fails first-processing closed on equal samples, stopped process mismatch and stale PASS evidence', () => {
  const equalSamples = cloneFixture();
  const t0Sample = nested(equalSamples, 'snapshots', 'T0', 'firstProcessingCanary')
    .sampledAtMs;
  nested(equalSamples, 'snapshots', 'T_PLUS_5', 'firstProcessingCanary').sampledAtMs = t0Sample;
  assert.equal(evaluateMainnetObserveCanary(equalSamples).gates.firstProcessing.verdict,
    'INCONCLUSIVE');

  const stoppedProcessMismatch = cloneFixture();
  nested(stoppedProcessMismatch, 'stoppedHeartbeat').startedAtMs = 1790313390117;
  assert.equal(evaluateMainnetObserveCanary(stoppedProcessMismatch).gates.firstProcessing.verdict,
    'INCONCLUSIVE');

  const stoppedNotAfterT15 = cloneFixture();
  const t15Sample = nested(stoppedNotAfterT15, 'snapshots', 'T_PLUS_15',
    'firstProcessingCanary').sampledAtMs;
  nested(stoppedNotAfterT15, 'stoppedHeartbeat', 'firstProcessingCanary').sampledAtMs = t15Sample;
  assert.equal(evaluateMainnetObserveCanary(stoppedNotAfterT15).gates.firstProcessing.verdict,
    'INCONCLUSIVE');

  const stalePass = cloneFixture();
  const stale = passFirstProcessingEvidence(1790313390116, 1790327790116);
  nested(stalePass, 'stoppedHeartbeat').firstProcessingCanary = stale;
  assert.equal(evaluateMainnetObserveCanary(stalePass).gates.firstProcessing.verdict,
    'INCONCLUSIVE');
});

void test('binds first-processing evidence to process, observation and retention time', () => {
  const cases = [cloneFixture(), cloneFixture(), cloneFixture(), cloneFixture()];
  nested(cases[0] ?? {}, 'snapshots', 'T0').observedAtMs = 1790313390115;
  nested(cases[1] ?? {}, 'snapshots', 'T_PLUS_5', 'firstProcessingCanary').sampledAtMs =
    1790313692692;
  nested(cases[2] ?? {}, 'stoppedHeartbeat').observedAtMs = 1790314338244;
  nested(cases[3] ?? {}, 'stoppedHeartbeat', 'firstProcessingCanary').sampledAtMs =
    1790314339763;
  for (const copy of cases) {
    assert.equal(evaluateMainnetObserveCanary(copy).gates.firstProcessing.verdict,
      'INCONCLUSIVE');
  }

  const epochZero = cloneFixture();
  for (const [index, name] of ['T0', 'T_PLUS_5', 'T_PLUS_15', 'FINAL_PRESTOP'].entries()) {
    nested(epochZero, 'snapshots', name).startedAtMs = 0;
    nested(epochZero, 'snapshots', name).firstProcessingCanary =
      passFirstProcessingEvidence(0, 945_001 + index);
  }
  nested(epochZero, 'stoppedHeartbeat').startedAtMs = 0;
  nested(epochZero, 'stoppedHeartbeat').firstProcessingCanary =
    passFirstProcessingEvidence(0, 945_005);
  assert.equal(evaluateMainnetObserveCanary(epochZero).gates.firstProcessing.verdict,
    'INCONCLUSIVE');
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

void test('accepts a finality incident recovered during the window when samples remain healthy', () => {
  const copy = cloneFixture();
  copy.finalityDiagnostics = [
    { event: 'listener.finality_reconciler_degraded', phase: 'DEGRADED',
      reasonCode: 'PROVIDER_UNAVAILABLE', degradedAtMs: 1790313500000,
      observedAtMs: 1790313500000 },
    { event: 'listener.finality_reconciler_recovered', phase: 'RECOVERED',
      reasonCode: null, degradedAtMs: 1790313500000, observedAtMs: 1790313500100 },
  ];

  assert.equal(evaluateMainnetObserveCanary(copy).gates.finality.verdict, 'PASS');
});

void test('freezes finality taxonomy, stop boundary and diagnostic array bounds', () => {
  const unknown = cloneFixture();
  const unknownDiagnostics = unknown.finalityDiagnostics as Record<string, unknown>[];
  assert.ok(unknownDiagnostics[0]);
  unknownDiagnostics[0].reasonCode = 'MADE_UP';
  assert.equal(evaluateMainnetObserveCanary(unknown).overallVerdict, 'INCONCLUSIVE');

  const afterStop = cloneFixture();
  afterStop.finalityDiagnostics = [
    { event: 'listener.finality_reconciler_degraded', phase: 'DEGRADED',
      reasonCode: 'PROVIDER_UNAVAILABLE', degradedAtMs: 1790314339700,
      observedAtMs: 1790314339700 },
    { event: 'listener.finality_reconciler_recovered', phase: 'RECOVERED',
      reasonCode: null, degradedAtMs: 1790314339700, observedAtMs: 1790314339800 },
  ];
  assert.equal(evaluateMainnetObserveCanary(afterStop).gates.finality.verdict, 'FAIL');

  const bounded = cloneFixture();
  bounded.finalityDiagnostics = Array.from({ length: 512 }, (_value, index) => {
    const degradedAtMs = 1790313391000 + index * 2;
    return [
      { event: 'listener.finality_reconciler_degraded', phase: 'DEGRADED',
        reasonCode: 'PROVIDER_UNAVAILABLE', degradedAtMs, observedAtMs: degradedAtMs },
      { event: 'listener.finality_reconciler_recovered', phase: 'RECOVERED',
        reasonCode: null, degradedAtMs, observedAtMs: degradedAtMs + 1 },
    ];
  }).flat();
  assert.equal(evaluateMainnetObserveCanary(bounded).commit,
    '32c9bf4c35268219184bd054f1e1f643065ecfd6');
  (bounded.finalityDiagnostics as unknown[]).push({
    event: 'listener.finality_reconciler_degraded', phase: 'DEGRADED',
    reasonCode: 'PROVIDER_UNAVAILABLE', degradedAtMs: 1790313393000,
    observedAtMs: 1790313393000,
  });
  assert.equal(evaluateMainnetObserveCanary(bounded).commit, null);
});

void test('bounds terminal groups at 128 exact entries', () => {
  const bounded = cloneFixture();
  const terminal = nested(bounded, 'terminalEvidence');
  terminal.baseline = { failed: 10, quarantined: 0, exhausted: 0 };
  terminal.final = { failed: 138, quarantined: 0, exhausted: 0 };
  terminal.groups = Array.from({ length: 128 }, () => ({ processingStatus: 'FAILED',
    reasonCode: 'PUMP_ACTION_SUPPORTED', errorCode: 'RPC_TRANSIENT', count: 1 }));
  assert.equal(evaluateMainnetObserveCanary(bounded).commit,
    '32c9bf4c35268219184bd054f1e1f643065ecfd6');
  (terminal.groups as unknown[]).push({ processingStatus: 'FAILED',
    reasonCode: 'PUMP_ACTION_SUPPORTED', errorCode: 'RPC_TRANSIENT', count: 1 });
  assert.equal(evaluateMainnetObserveCanary(bounded).commit, null);
});

void test('checks RPC counter invariants before classifying traffic volume', () => {
  const late429 = cloneFixture();
  for (const name of ['T0', 'T_PLUS_5', 'T_PLUS_15', 'FINAL_PRESTOP']) {
    const providers = nested(late429, 'snapshots', name, 'rpcHttpEvidence')
      .providers as Record<string, unknown>[];
    assert.ok(providers[0]);
    providers[0].attempts = 39;
    providers[0].http429Responses = name === 'T0' ? 0 : 1;
  }
  const stoppedProviders = nested(late429, 'stoppedHeartbeat', 'rpcHttpEvidence')
    .providers as Record<string, unknown>[];
  assert.ok(stoppedProviders[0]);
  stoppedProviders[0].attempts = 39;
  stoppedProviders[0].http429Responses = 1;
  assert.equal(evaluateMainnetObserveCanary(late429).gates.http429.verdict, 'FAIL');

  const invalidCases = [cloneFixture(), cloneFixture()];
  const unconfigured = nested(invalidCases[0] ?? {}, 'snapshots', 'T_PLUS_5',
    'rpcHttpEvidence').providers as Record<string, unknown>[];
  assert.ok(unconfigured[1]);
  unconfigured[1].attempts = 1;
  const impossible = nested(invalidCases[1] ?? {}, 'snapshots', 'T_PLUS_5',
    'rpcHttpEvidence').providers as Record<string, unknown>[];
  assert.ok(impossible[0]);
  impossible[0].http429Responses = 653;
  for (const invalid of invalidCases) {
    assert.equal(evaluateMainnetObserveCanary(invalid).gates.http429.verdict, 'INCONCLUSIVE');
  }
});

void test('requires the canonical V1 provider membership and bounds provider evidence', () => {
  const omitted = cloneFixture();
  for (const name of ['T0', 'T_PLUS_5', 'T_PLUS_15', 'FINAL_PRESTOP']) {
    const snapshotProviders = nested(omitted, 'snapshots', name, 'rpcHttpEvidence')
      .providers as Record<string, unknown>[];
    snapshotProviders.pop();
  }
  const omittedStopped = nested(omitted, 'stoppedHeartbeat', 'rpcHttpEvidence')
    .providers as Record<string, unknown>[];
  omittedStopped.pop();
  assert.equal(evaluateMainnetObserveCanary(omitted).gates.http429.verdict, 'INCONCLUSIVE');

  const bounded = cloneFixture();
  const providers = nested(bounded, 'snapshots', 'T_PLUS_5', 'rpcHttpEvidence')
    .providers as Record<string, unknown>[];
  for (let index = 4; index < 8; index += 1) providers.push({ providerId: `extra-${index}`,
    configured: false, attempts: 0, http429Responses: 0 });
  assert.equal(evaluateMainnetObserveCanary(bounded).commit,
    '32c9bf4c35268219184bd054f1e1f643065ecfd6');
  providers.push({ providerId: 'extra-8', configured: false, attempts: 0, http429Responses: 0 });
  assert.equal(evaluateMainnetObserveCanary(bounded).commit, null);
});

void test('fails a proved HTTP 429 delta on a common provider before membership drift', () => {
  const copy = cloneFixture();
  const finalProviders = nested(copy, 'snapshots', 'FINAL_PRESTOP', 'rpcHttpEvidence')
    .providers as Record<string, unknown>[];
  const stoppedProviders = nested(copy, 'stoppedHeartbeat', 'rpcHttpEvidence')
    .providers as Record<string, unknown>[];
  assert.ok(finalProviders[0]);
  assert.ok(stoppedProviders[0]);
  finalProviders[0].http429Responses = 1;
  stoppedProviders[0].http429Responses = 1;
  stoppedProviders.push({ providerId: 'late-provider', configured: true,
    attempts: 1, http429Responses: 0 });

  assert.equal(evaluateMainnetObserveCanary(copy).gates.http429.verdict, 'FAIL');
});

void test('treats a cumulative hydration counter reset as inconclusive', () => {
  const copy = cloneFixture();
  nested(copy, 'snapshots', 'T_PLUS_15', 'blockHydration').fetches = 400;
  assert.equal(evaluateMainnetObserveCanary(copy).gates.blockHydration.verdict,
    'INCONCLUSIVE');
});

void test('enforces exact block hydration retention ceilings', () => {
  const boundary = cloneFixture();
  makeHydrationHealthy(boundary);
  const hydration = nested(boundary, 'snapshots', 'T_PLUS_5', 'blockHydration');
  hydration.retainedEntries = 64;
  hydration.retainedBytes = 67_108_864;
  assert.equal(evaluateMainnetObserveCanary(boundary).gates.blockHydration.verdict, 'PASS');
  for (const [field, value] of [['retainedEntries', 65], ['retainedBytes', 67_108_865]] as const) {
    const copy = cloneFixture();
    makeHydrationHealthy(copy);
    nested(copy, 'snapshots', 'T_PLUS_5', 'blockHydration')[field] = value;
    assert.equal(evaluateMainnetObserveCanary(copy).gates.blockHydration.verdict, 'FAIL');
  }
});

void test('derives the RSS ceiling from T+5 with exact integer and overflow boundaries', () => {
  const boundary = cloneFixture();
  nested(boundary, 'snapshots', 'FINAL_PRESTOP').rssBytes = 859_796_480;
  assert.equal(evaluateMainnetObserveCanary(boundary).gates.rss.verdict, 'PASS');
  nested(boundary, 'snapshots', 'FINAL_PRESTOP').rssBytes = 859_796_481;
  assert.equal(evaluateMainnetObserveCanary(boundary).gates.rss.verdict, 'FAIL');

  const fixedFloor = cloneFixture();
  nested(fixedFloor, 'snapshots', 'T_PLUS_5').rssBytes = 1;
  nested(fixedFloor, 'snapshots', 'FINAL_PRESTOP').rssBytes = 134_217_729;
  assert.equal(evaluateMainnetObserveCanary(fixedFloor).gates.rss.verdict, 'PASS');
  nested(fixedFloor, 'snapshots', 'FINAL_PRESTOP').rssBytes = 134_217_730;
  assert.equal(evaluateMainnetObserveCanary(fixedFloor).gates.rss.verdict, 'FAIL');

  const overflow = cloneFixture();
  nested(overflow, 'snapshots', 'T_PLUS_5').rssBytes = Number.MAX_SAFE_INTEGER;
  assert.equal(evaluateMainnetObserveCanary(overflow).gates.rss.verdict, 'INCONCLUSIVE');
});

void test('distinguishes an authenticated periodic pause from generic degradation', () => {
  const copy = cloneFixture();
  const final = nested(copy, 'snapshots', 'FINAL_PRESTOP');
  final.status = 'DEGRADED';
  final.pipelinePumpfun = 'DEGRADED';
  final.subscriberState = 'RUNNING';
  final.scannerState = 'DEGRADED';
  final.periodicPauseEvidence = { version: 1, reasonCode: 'CATCH_UP_PAGE_BUDGET_EXHAUSTED',
    providerId: 'primary', observedAtMs: final.observedAtMs };
  const websocket = nested(final, 'websocket');
  websocket.phase = 'RUNNING';
  websocket.recoveryStatus = 'NOT_REQUIRED';
  websocket.recoveryReasonCode = null;

  const gate = evaluateMainnetObserveCanary(copy).gates.runtime;
  assert.deepEqual(gate, { verdict: 'INCONCLUSIVE', reasonCode: 'RUNTIME_PERIODIC_PAUSE' });
});

void test('requires a running Pump.fun pipeline except for an authenticated degraded pause', () => {
  const stopped = cloneFixture();
  nested(stopped, 'snapshots', 'T_PLUS_5').pipelinePumpfun = 'IDLE';
  assert.equal(evaluateMainnetObserveCanary(stopped).gates.runtime.verdict, 'FAIL');

  const incoherentPause = cloneFixture();
  const final = nested(incoherentPause, 'snapshots', 'FINAL_PRESTOP');
  final.status = 'DEGRADED';
  final.scannerState = 'DEGRADED';
  final.periodicPauseEvidence = { version: 1, reasonCode: 'CATCH_UP_PAGE_BUDGET_EXHAUSTED',
    providerId: 'primary', observedAtMs: final.observedAtMs };
  const websocket = nested(final, 'websocket');
  websocket.recoveryStatus = 'NOT_REQUIRED';
  websocket.recoveryReasonCode = null;
  assert.notEqual(evaluateMainnetObserveCanary(incoherentPause).gates.runtime.verdict, 'PASS');
});

void test('enforces nullable recovery reason only for NOT_REQUIRED recovery', () => {
  const valid = cloneFixture();
  const validRecovery = nested(valid, 'snapshots', 'T0', 'websocket');
  validRecovery.recoveryStatus = 'NOT_REQUIRED';
  validRecovery.recoveryReasonCode = null;
  assert.equal(evaluateMainnetObserveCanary(valid).commit,
    '32c9bf4c35268219184bd054f1e1f643065ecfd6');

  const invalid = cloneFixture();
  nested(invalid, 'snapshots', 'T0', 'websocket').recoveryReasonCode = null;
  assert.equal(evaluateMainnetObserveCanary(invalid).overallVerdict, 'INCONCLUSIVE');
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
  const proxyArray = cloneFixture();
  const originalProviders = nested(proxyArray, 'snapshots', 'T0', 'rpcHttpEvidence')
    .providers as unknown[];
  nested(proxyArray, 'snapshots', 'T0', 'rpcHttpEvidence').providers = new Proxy(originalProviders, {
    get() {
      accessorReads += 1;
      throw new Error('proxy getter must not run');
    },
  });

  for (const input of [
    new Proxy(cloneFixture(), {}), accessor, unexpected, negativeZero, unsafeInteger, secretField,
    proxyArray,
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

function passFirstProcessingEvidence(cohortStartedAtMs: number, sampledAtMs: number):
Record<string, unknown> {
  return {
    version: 1,
    thresholdMs: 45_000,
    cohortCapacity: 50_000,
    cohortStartedAtMs,
    cohortEndsAtMs: cohortStartedAtMs + 900_000,
    sampledAtMs,
    overflowed: false,
    eligibleCount: 1,
    completedCount: 1,
    underThresholdCount: 1,
    atOrAboveThresholdCount: 0,
    pendingCount: 0,
    rightCensoredCount: 0,
    tailCensoredCount: 0,
    terminalCount: 0,
    unavailableCount: 0,
    invalidDurationCount: 0,
    p95Ms: 44_999,
    verdict: 'PASS',
  };
}

function makeHydrationHealthy(copy: Record<string, unknown>): void {
  const names = ['T0', 'T_PLUS_5', 'T_PLUS_15', 'FINAL_PRESTOP'] as const;
  names.forEach((name, index) => {
    const hydration = nested(copy, 'snapshots', name, 'blockHydration');
    hydration.fetches = 10 + index;
    hydration.oversizeBypasses = 0;
    hydration.fetchFailures = 0;
    hydration.epochInvalidations = index;
    hydration.retainedEntries = 0;
    hydration.retainedBytes = 0;
    hydration.inFlightFetches = 0;
    hydration.queuedFetches = 0;
  });
  const stopped = nested(copy, 'stoppedHeartbeat', 'blockHydration');
  stopped.fetches = 14;
  stopped.oversizeBypasses = 0;
  stopped.fetchFailures = 0;
  stopped.epochInvalidations = 4;
}
