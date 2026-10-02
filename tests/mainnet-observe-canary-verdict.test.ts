import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
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
const representativeSignature = '1'.repeat(64);

function hydrationAdmissionEvidence() {
  return { version: 1, enabled: true, registeredWorkers: 2, pendingWorkers: 0,
    maximumPendingWorkers: 2, pendingClassifierGroups: 0, maximumPendingClassifierGroups: 1,
    unboundReservations: 0, activeGroups: 0, maximumAdmitted: 1,
    worker: { grants: 2, cancellations: 0, oldestWaitMs: null, lastWaitMs: 2, maximumWaitMs: 5 },
    classifier: { grants: 1, cancellations: 0, oldestWaitMs: null, lastWaitMs: 3, maximumWaitMs: 3 } };
}

void test('admits bounded hydration evidence including historical worker maxima after handles close', () => {
  const copy = cloneFixture();
  nested(copy, 'stoppedHeartbeat', 'blockHydrationAdmission').registeredWorkers = 0;
  const ongoing = nested(copy, 'snapshots', 'T_PLUS_5', 'blockHydrationAdmission');
  ongoing.pendingWorkers = 1;
  nested(ongoing, 'worker').oldestWaitMs = 100;
  assert.deepEqual(evaluateMainnetObserveCanary(copy).gates.blockHydrationAdmission,
    { verdict: 'PASS', reasonCode: 'BLOCK_HYDRATION_ADMISSION_BOUNDED' });
});

void test('old evidence is inconclusive only for the new hydration admission guarantee', () => {
  const copy = cloneFixture();
  for (const name of WORKER_ADMISSION_SNAPSHOT_NAMES) delete nested(copy, 'snapshots', name).blockHydrationAdmission;
  delete nested(copy, 'stoppedHeartbeat').blockHydrationAdmission;
  assert.deepEqual(evaluateMainnetObserveCanary(copy).gates.blockHydrationAdmission,
    { verdict: 'INCONCLUSIVE', reasonCode: 'BLOCK_HYDRATION_ADMISSION_EVIDENCE_MISSING' });
  assert.equal(evaluateMainnetObserveCanary(copy).gates.catchUpAdmission.verdict, 'PASS');
});

void test('hydration admission fails present malformed or over-bound evidence and requires stopped drain', () => {
  for (const field of ['maximumAdmitted', 'maximumPendingClassifierGroups', 'unboundReservations', 'activeGroups']) {
    const copy = cloneFixture();
    nested(copy, 'snapshots', 'T_PLUS_5', 'blockHydrationAdmission')[field] = 2;
    assert.equal(evaluateMainnetObserveCanary(copy).gates.blockHydrationAdmission.verdict, 'FAIL', field);
  }
  for (const overrides of [{ pendingWorkers: 3 }, { pendingWorkers: 1 },
    { unboundReservations: 1, activeGroups: 1 }, { maximumAdmitted: 0, activeGroups: 1 },
    { version: 2 }, { secret: 'private-admission-secret' }]) {
    const copy = cloneFixture();
    Object.assign(nested(copy, 'snapshots', 'T_PLUS_15', 'blockHydrationAdmission'), overrides);
    const result = evaluateMainnetObserveCanary(copy);
    assert.equal(result.gates.blockHydrationAdmission.verdict, 'FAIL');
    assert.doesNotMatch(JSON.stringify(result), /private-admission-secret/u);
  }
  for (const field of ['pendingWorkers', 'pendingClassifierGroups', 'unboundReservations', 'activeGroups']) {
    const copy = cloneFixture();
    const stopped = nested(copy, 'stoppedHeartbeat', 'blockHydrationAdmission');
    stopped[field] = 1;
    if (field === 'pendingWorkers') nested(stopped, 'worker').oldestWaitMs = 10;
    if (field === 'pendingClassifierGroups') nested(stopped, 'classifier').oldestWaitMs = 10;
    assert.equal(evaluateMainnetObserveCanary(copy).gates.blockHydrationAdmission.verdict, 'FAIL', field);
  }
  const disabled = cloneFixture();
  nested(disabled, 'snapshots', 'T0', 'blockHydrationAdmission').enabled = false;
  assert.equal(evaluateMainnetObserveCanary(disabled).gates.blockHydrationAdmission.verdict, 'INCONCLUSIVE');
});

void test('hydration admission isolates hostile optional evidence without invoking accessors', () => {
  const copy = cloneFixture();
  let reads = 0;
  Object.defineProperty(nested(copy, 'snapshots', 'T0'), 'blockHydrationAdmission', {
    enumerable: true, get() { reads += 1; throw new Error('private-admission-secret'); },
  });
  const result = evaluateMainnetObserveCanary(copy);
  assert.equal(result.gates.blockHydrationAdmission.verdict, 'FAIL');
  assert.equal(result.gates.catchUpAdmission.verdict, 'PASS');
  assert.doesNotMatch(JSON.stringify(result), /private-admission-secret/u);
  assert.equal(reads, 0);
});

void test('proven undrained hydration admission fails despite another missing or disabled sample', () => {
  for (const missing of [false, true]) {
    const copy = cloneFixture();
    nested(copy, 'stoppedHeartbeat', 'blockHydrationAdmission').activeGroups = 1;
    if (missing) delete nested(copy, 'snapshots', 'T0').blockHydrationAdmission;
    else nested(copy, 'snapshots', 'T0', 'blockHydrationAdmission').enabled = false;
    assert.deepEqual(evaluateMainnetObserveCanary(copy).gates.blockHydrationAdmission,
      { verdict: 'FAIL', reasonCode: 'BLOCK_HYDRATION_ADMISSION_NOT_DRAINED' });
  }
});

void test('keeps the real failed run failed while correcting four obsolete assertions', () => {
  const result = evaluateMainnetObserveCanary(fixture);
  assert.equal(result.overallVerdict, 'FAIL');
  assert.deepEqual(result.gates.blockHydrationAdmission, {
    verdict: 'INCONCLUSIVE', reasonCode: 'BLOCK_HYDRATION_ADMISSION_EVIDENCE_MISSING',
  });
  assert.deepEqual(result.gates.workerAdmission, {
    verdict: 'INCONCLUSIVE',
    reasonCode: 'WORKER_ADMISSION_EVIDENCE_MISSING',
  });
  for (const gate of ['catchUpAdmission', 'providerAffinity', 'finality', 'shutdown'] as const) {
    assert.equal(result.gates[gate].verdict, 'PASS');
  }
  for (const gate of [
    'runtime', 'backlog', 'terminalFailures', 'firstProcessing', 'blockHydration',
  ] as const) {
    assert.equal(result.gates[gate].verdict, 'FAIL');
  }
});

void test('passes coherent bounded worker admission evidence through durable STOPPED', () => {
  const copy = passingWorkerAdmissionFixture();
  const t0 = nested(copy, 'snapshots', 'T0');
  assert.ok((nested(t0, 'workerAdmission').classificationPendingCount as number) > 0);
  assert.ok((nested(t0, 'workerAdmission').claimableBacklogCount as number)
    < (t0.backlogCount as number));

  assert.deepEqual(evaluateMainnetObserveCanary(copy).gates.workerAdmission, {
    verdict: 'PASS',
    reasonCode: 'WORKER_ADMISSION_BOUNDED',
  });
});

void test('fails worker admission at the exact 45-second pending boundary', () => {
  const eligible = passingWorkerAdmissionFixture();
  nested(eligible, 'snapshots', 'FINAL_PRESTOP', 'workerAdmission')
    .oldestClassificationPendingAgeMs = 44_999;
  assert.equal(evaluateMainnetObserveCanary(eligible).gates.workerAdmission.verdict, 'PASS');

  const expired = passingWorkerAdmissionFixture();
  nested(expired, 'snapshots', 'FINAL_PRESTOP', 'workerAdmission')
    .oldestClassificationPendingAgeMs = 45_000;
  assert.deepEqual(evaluateMainnetObserveCanary(expired).gates.workerAdmission, {
    verdict: 'FAIL',
    reasonCode: 'WORKER_ADMISSION_PENDING_EXPIRED',
  });
});

void test('fails classification debt or claimable backlog growth after T+5', () => {
  const pendingGrowth = passingWorkerAdmissionFixture();
  nested(pendingGrowth, 'snapshots', 'T_PLUS_15', 'workerAdmission')
    .classificationPendingCount = 2;
  assert.deepEqual(evaluateMainnetObserveCanary(pendingGrowth).gates.workerAdmission, {
    verdict: 'FAIL',
    reasonCode: 'WORKER_ADMISSION_CLASSIFICATION_GREW',
  });

  const backlogGrowth = passingWorkerAdmissionFixture();
  setClaimableBacklog(backlogGrowth, 'T_PLUS_15', 10);
  assert.deepEqual(evaluateMainnetObserveCanary(backlogGrowth).gates.workerAdmission, {
    verdict: 'FAIL',
    reasonCode: 'WORKER_ADMISSION_BACKLOG_GREW',
  });
});

void test('checks worker admission population and post-stop proof before failure trends', () => {
  const impossiblePopulation = passingWorkerAdmissionFixture();
  const t15 = nested(impossiblePopulation, 'snapshots', 'T_PLUS_15');
  const t15Backlog = t15.backlogCount as number;
  nested(t15, 'workerAdmission').claimableBacklogCount = t15Backlog - 2;
  nested(t15, 'workerAdmission').classificationPendingCount = t15Backlog;
  nested(t15, 'workerAdmission').oldestClassificationPendingAgeMs = 45_000;
  assert.deepEqual(evaluateMainnetObserveCanary(impossiblePopulation).gates.workerAdmission, {
    verdict: 'INCONCLUSIVE',
    reasonCode: 'WORKER_ADMISSION_BACKLOG_INCOHERENT',
  });

  const missingPostStopProof = passingWorkerAdmissionFixture();
  delete missingPostStopProof.postStopWorkerAdmissionClaimableCount;
  nested(missingPostStopProof, 'snapshots', 'FINAL_PRESTOP', 'workerAdmission')
    .oldestClassificationPendingAgeMs = 45_000;
  assert.deepEqual(evaluateMainnetObserveCanary(missingPostStopProof).gates.workerAdmission, {
    verdict: 'INCONCLUSIVE',
    reasonCode: 'WORKER_ADMISSION_POST_STOP_EVIDENCE_MISSING',
  });
});

void test('keeps STOPPED SQL count disagreement inconclusive', () => {
  const copy = passingWorkerAdmissionFixture();
  copy.postStopWorkerAdmissionClaimableCount = 7;

  assert.deepEqual(evaluateMainnetObserveCanary(copy).gates.workerAdmission, {
    verdict: 'INCONCLUSIVE',
    reasonCode: 'WORKER_ADMISSION_POST_STOP_COUNT_INCOHERENT',
  });
});

void test('requires dedicated post-stop worker evidence and only a subset of legacy backlog', () => {
  const missing = passingWorkerAdmissionFixture();
  delete missing.postStopWorkerAdmissionClaimableCount;
  assert.deepEqual(evaluateMainnetObserveCanary(missing).gates.workerAdmission, {
    verdict: 'INCONCLUSIVE',
    reasonCode: 'WORKER_ADMISSION_POST_STOP_EVIDENCE_MISSING',
  });

  const malformed = passingWorkerAdmissionFixture();
  malformed.postStopWorkerAdmissionClaimableCount = '6';
  assert.deepEqual(evaluateMainnetObserveCanary(malformed).gates.workerAdmission, {
    verdict: 'INCONCLUSIVE',
    reasonCode: 'WORKER_ADMISSION_POST_STOP_EVIDENCE_MALFORMED',
  });

  const exceedsLegacy = passingWorkerAdmissionFixture();
  nested(exceedsLegacy, 'snapshots', 'T0', 'workerAdmission').claimableBacklogCount = 21;
  assert.deepEqual(evaluateMainnetObserveCanary(exceedsLegacy).gates.workerAdmission, {
    verdict: 'INCONCLUSIVE',
    reasonCode: 'WORKER_ADMISSION_BACKLOG_INCOHERENT',
  });
});

void test('keeps missing, malformed, disabled and non-chronological worker evidence inconclusive', () => {
  const missing = passingWorkerAdmissionFixture();
  delete nested(missing, 'snapshots', 'T_PLUS_15').workerAdmission;
  const malformed = passingWorkerAdmissionFixture();
  nested(malformed, 'snapshots', 'T_PLUS_15', 'workerAdmission').version = 2;
  const disabled = passingWorkerAdmissionFixture();
  nested(disabled, 'snapshots', 'T_PLUS_15').workerAdmission = {
    version: 1, enabled: false, trackingWindowSeconds: 45, claimableBacklogCount: 8,
    classificationPendingCount: 0, oldestClassificationPendingAgeMs: null,
    freshMintCount: 0, extendedMintCount: 0, demotedCount: 0,
  };
  const nonChronological = passingWorkerAdmissionFixture();
  nested(nonChronological, 'stoppedHeartbeat').observedAtMs =
    nested(nonChronological, 'snapshots', 'FINAL_PRESTOP').observedAtMs;

  for (const [name, candidate] of [
    ['missing', missing], ['malformed', malformed], ['disabled', disabled],
    ['non-chronological', nonChronological],
  ] as const) {
    assert.equal(
      evaluateMainnetObserveCanary(candidate).gates.workerAdmission.verdict,
      'INCONCLUSIVE',
      name,
    );
  }
});

void test('rejects identifiers and arbitrary labels from worker admission evidence', () => {
  for (const [field, value] of [
    ['signature', 'private-signature'],
    ['mint', 'private-mint'],
    ['wallet', 'private-wallet'],
    ['label', 'private-label'],
  ] as const) {
    const copy = passingWorkerAdmissionFixture();
    nested(copy, 'snapshots', 'T0', 'workerAdmission')[field] = value;
    const result = evaluateMainnetObserveCanary(copy);
    assert.equal(result.gates.workerAdmission.verdict, 'INCONCLUSIVE', field);
    assert.equal(JSON.stringify(result).includes(value), false, field);
  }
});

void test('contains a hostile worker admission accessor without degrading independent gates', () => {
  let reads = 0;
  const copy = passingWorkerAdmissionFixture();
  Object.defineProperty(nested(copy, 'snapshots', 'T0'), 'workerAdmission', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('worker evidence accessor must not run');
    },
  });

  const result = evaluateMainnetObserveCanary(copy);
  assert.equal(reads, 0);
  assert.equal(result.gates.workerAdmission.verdict, 'INCONCLUSIVE');
  assert.equal(result.gates.catchUpAdmission.verdict, 'PASS');
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
  assert.equal(evaluateMainnetObserveCanary(
    complete,
    terminalAttribution({ terminalFailed: 11 }),
  ).gates.terminalFailures.verdict, 'FAIL');

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
    'FAIL');

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

void test('fails a proven new terminal worker failure but does not mislabel retry-pending work', () => {
  const terminal = terminalNeutralFixture();
  nested(terminal, 'terminalEvidence').baseline = {
    failed: 0, quarantined: 0, exhausted: 0,
  };
  nested(terminal, 'terminalEvidence').final = {
    failed: 1, quarantined: 0, exhausted: 0,
  };

  const provenTerminal = terminalAttribution({ terminalFailed: 1 });
  assert.deepEqual(evaluateMainnetObserveCanary(terminal, provenTerminal).gates.terminalFailures, {
    verdict: 'FAIL',
    reasonCode: 'TERMINAL_FAILURES_OBSERVED',
  });
  assert.deepEqual(evaluateMainnetObserveCanary(
    terminal,
    terminalAttribution({ terminalFailed: 1, incompleteOccurrences: 1 }),
  ).gates.terminalFailures, {
    verdict: 'FAIL',
    reasonCode: 'TERMINAL_FAILURES_OBSERVED',
  });

  const retryPending = terminalAttribution({ retryPendingFailed: 1 });
  assert.deepEqual(evaluateMainnetObserveCanary(terminal, retryPending).gates.terminalFailures, {
    verdict: 'PASS',
    reasonCode: 'TERMINAL_NONE',
  });
});

void test('keeps an ambiguous terminal composition inconclusive without a baseline by state', () => {
  const growth = terminalNeutralFixture();
  nested(growth, 'terminalEvidence').baseline = {
    failed: 10, quarantined: 0, exhausted: 0,
  };
  nested(growth, 'terminalEvidence').final = {
    failed: 11, quarantined: 0, exhausted: 0,
  };
  assert.deepEqual(evaluateMainnetObserveCanary(
    growth,
    terminalAttribution({ terminalFailed: 1, retryPendingFailed: 10 }),
  ).gates.terminalFailures, {
    verdict: 'INCONCLUSIVE',
    reasonCode: 'TERMINAL_ATTRIBUTION_BASELINE_STATE_UNKNOWN',
  });

  const stableTotal = terminalNeutralFixture();
  nested(stableTotal, 'terminalEvidence').baseline = {
    failed: 1, quarantined: 0, exhausted: 0,
  };
  nested(stableTotal, 'terminalEvidence').final = {
    failed: 1, quarantined: 0, exhausted: 0,
  };
  assert.deepEqual(evaluateMainnetObserveCanary(
    stableTotal,
    terminalAttribution({ terminalFailed: 1 }),
  ).gates.terminalFailures, {
    verdict: 'INCONCLUSIVE',
    reasonCode: 'TERMINAL_ATTRIBUTION_BASELINE_STATE_UNKNOWN',
  });
});

void test('keeps proven exhaustion and quarantine FAIL even without usable attribution', () => {
  const exhausted = terminalNeutralFixture();
  nested(exhausted, 'terminalEvidence').baseline = {
    failed: 1, quarantined: 0, exhausted: 0,
  };
  nested(exhausted, 'terminalEvidence').final = {
    failed: 2, quarantined: 0, exhausted: 1,
  };
  assert.deepEqual(evaluateMainnetObserveCanary(exhausted).gates.terminalFailures, {
    verdict: 'FAIL',
    reasonCode: 'TERMINAL_RETRIES_EXHAUSTED',
  });

  const quarantined = terminalNeutralFixture();
  nested(quarantined, 'terminalEvidence').final = {
    failed: 0, quarantined: 1, exhausted: 0,
  };
  assert.deepEqual(
    evaluateMainnetObserveCanary(quarantined, { privateKey: 'must-not-leak' }).gates.terminalFailures,
    { verdict: 'FAIL', reasonCode: 'TERMINAL_FAILURES_OBSERVED' },
  );
});

void test('keeps funding retry-pending neutral and fifth-attempt exhaustion terminal', () => {
  const retryPending = terminalNeutralFixture();
  nested(retryPending, 'terminalEvidence').final = {
    failed: 1, quarantined: 0, exhausted: 0,
  };
  assert.deepEqual(evaluateMainnetObserveCanary(retryPending, terminalAttribution({
    retryPendingFailed: 1,
    diagnosticGroups: [fundingDiagnosticGroup('FUNDING_OBSERVATION_VALIDATE', false)],
  })).gates.terminalFailures, {
    verdict: 'PASS',
    reasonCode: 'TERMINAL_NONE',
  });

  const exhausted = terminalNeutralFixture();
  nested(exhausted, 'terminalEvidence').final = {
    failed: 1, quarantined: 0, exhausted: 1,
  };
  assert.deepEqual(evaluateMainnetObserveCanary(exhausted, terminalAttribution({
    terminalFailed: 1,
    diagnosticGroups: [fundingDiagnosticGroup('FUNDING_OBSERVATION_RECORD', true)],
  })).gates.terminalFailures, {
    verdict: 'FAIL',
    reasonCode: 'TERMINAL_RETRIES_EXHAUSTED',
  });
});

void test('fails closed when required terminal attribution is missing, malformed or unreconciled', () => {
  const neutral = terminalNeutralFixture();
  const cases: readonly [string, unknown][] = [
    ['missing', undefined],
    ['malformed', { schemaVersion: 'mainnet-terminal-attribution.v1', rpcUrl: 'secret' }],
    ['unreconciled', terminalAttribution({ retryPendingFailed: 1 })],
    ['current overflow', terminalAttribution({ currentOverflowRows: 1 })],
    ['diagnostic overflow', terminalAttribution({ diagnosticOverflowOccurrences: 1 })],
    ['unavailable', terminalAttribution({ unavailableOccurrences: 1 })],
    ['incomplete', terminalAttribution({ incompleteOccurrences: 1 })],
  ];

  for (const [name, attribution] of cases) {
    const result = evaluateMainnetObserveCanary(neutral, attribution);
    assert.equal(result.gates.terminalFailures.verdict, 'INCONCLUSIVE', name);
    assert.equal(result.gates.decoderQuarantine.verdict, 'INCONCLUSIVE', name);
    assert.equal(JSON.stringify(result).includes('secret'), false, name);
  }
});

void test('keeps positive exhaustion and quarantine deltas ahead of population decreases', () => {
  for (const kind of ['exhausted', 'quarantined'] as const) {
    const input = terminalNeutralFixture();
    nested(input, 'terminalEvidence').baseline = { failed: 10, exhausted: 0, quarantined: 0 };
    nested(input, 'terminalEvidence').final = { failed: 9, exhausted: 0, quarantined: 0, [kind]: 1 };
    assert.deepEqual(evaluateMainnetObserveCanary(input).gates.terminalFailures, {
      verdict: 'FAIL',
      reasonCode: kind === 'exhausted' ? 'TERMINAL_RETRIES_EXHAUSTED' : 'TERMINAL_FAILURES_OBSERVED',
    });
  }
});

void test('keeps proven current terminal failure despite missing or malformed diagnostic sections', () => {
  const input = terminalNeutralFixture();
  nested(input, 'terminalEvidence', 'final').failed = 1;
  for (const section of ['diagnosticOccurrences', 'incompleteAttribution']) {
    for (const malformed of [false, true]) {
      const attribution = terminalAttribution({ terminalFailed: 1 });
      if (malformed) attribution[section] = { invalid: true };
      else Reflect.deleteProperty(attribution, section);
      assert.deepEqual(evaluateMainnetObserveCanary(input, attribution).gates.terminalFailures, {
        verdict: 'FAIL', reasonCode: 'TERMINAL_FAILURES_OBSERVED',
      });
    }
  }
});

void test('fails decoder on current authenticated Borsh even without usable occurrences', () => {
  const input = terminalNeutralFixture();
  nested(input, 'terminalEvidence', 'final').failed = 1;
  for (const occurrenceState of ['empty', 'missing', 'malformed']) {
    const attribution = terminalAttribution({ terminalFailed: 1 });
    const groups = nested(attribution, 'currentPopulation').groups as Record<string, unknown>[];
    const group = groups[0];
    assert.ok(group);
    group.normalizedErrorName = 'ObservedPipelineFailure.v1.launchpad_observation.PUMP_BORSH_INVALID';
    if (occurrenceState === 'missing') delete attribution.diagnosticOccurrences;
    if (occurrenceState === 'malformed') attribution.diagnosticOccurrences = { invalid: true };
    assert.deepEqual(evaluateMainnetObserveCanary(input, attribution).gates.decoderQuarantine, {
      verdict: 'FAIL', reasonCode: 'DECODER_PUMP_BORSH_INVALID',
    });
  }
});

void test('keeps decoder occurrence failure despite missing or malformed current population', () => {
  for (const diagnostic of [pumpInvalidWorkerGroup(), catchUpDecoderQuarantineGroup()]) {
    for (const malformed of [false, true]) {
      const attribution = terminalAttribution({ diagnosticGroups: [diagnostic] });
      if (malformed) attribution.currentPopulation = { invalid: true };
      else delete attribution.currentPopulation;
      assert.equal(evaluateMainnetObserveCanary(terminalNeutralFixture(), attribution)
        .gates.decoderQuarantine.verdict, 'FAIL');
    }
  }
});

void test('requires every valid attribution section before either gate can pass', () => {
  for (const section of ['currentPopulation', 'diagnosticOccurrences', 'incompleteAttribution']) {
    for (const malformed of [false, true]) {
      const attribution = terminalAttribution();
      if (malformed) attribution[section] = { invalid: true };
      else Reflect.deleteProperty(attribution, section);
      const result = evaluateMainnetObserveCanary(terminalNeutralFixture(), attribution);
      for (const gate of ['terminalFailures', 'decoderQuarantine'] as const) {
        assert.deepEqual(result.gates[gate], {
          verdict: 'INCONCLUSIVE',
          reasonCode: malformed ? 'TERMINAL_ATTRIBUTION_MALFORMED' : 'TERMINAL_ATTRIBUTION_MISSING',
        });
      }
    }
  }
});

void test('keeps a proven terminal lower bound despite overflow or unreconciled population', () => {
  for (const currentOverflowRows of [0, 1]) {
    const attribution = terminalAttribution({ terminalFailed: 1, currentOverflowRows });
    assert.deepEqual(evaluateMainnetObserveCanary(terminalNeutralFixture(), attribution)
      .gates.terminalFailures, {
      verdict: 'FAIL', reasonCode: 'TERMINAL_FAILURES_OBSERVED',
    });
  }
  const decreased = terminalNeutralFixture();
  nested(decreased, 'terminalEvidence', 'baseline').failed = 1;
  assert.equal(evaluateMainnetObserveCanary(decreased, terminalAttribution({ terminalFailed: 2 }))
    .gates.terminalFailures.verdict, 'FAIL');
});

void test('fails decoder gate on Pump Borsh worker evidence and catch-up decoder quarantine', () => {
  const neutral = terminalNeutralFixture();
  const workerInvalid = terminalAttribution({ diagnosticGroups: [pumpInvalidWorkerGroup()] });
  const workerResult = evaluateMainnetObserveCanary(neutral, workerInvalid);
  assert.deepEqual(workerResult.gates.decoderQuarantine, {
    verdict: 'FAIL',
    reasonCode: 'DECODER_PUMP_BORSH_INVALID',
  });
  assert.equal(JSON.stringify(workerResult).includes(representativeSignature), false);

  const catchUpDecoder = terminalAttribution({
    diagnosticGroups: [catchUpDecoderQuarantineGroup()],
  });
  assert.deepEqual(evaluateMainnetObserveCanary(neutral, catchUpDecoder).gates.decoderQuarantine, {
    verdict: 'FAIL',
    reasonCode: 'DECODER_CATCH_UP_QUARANTINE',
  });
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
    }, 'terminalFailures', 'FAIL'],
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
  const copy = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
  for (const name of WORKER_ADMISSION_SNAPSHOT_NAMES) nested(copy, 'snapshots', name).blockHydrationAdmission = hydrationAdmissionEvidence();
  nested(copy, 'stoppedHeartbeat').blockHydrationAdmission = hydrationAdmissionEvidence();
  return copy;
}

function terminalNeutralFixture(): Record<string, unknown> {
  const copy = cloneFixture();
  nested(copy, 'terminalEvidence').baseline = { failed: 0, quarantined: 0, exhausted: 0 };
  nested(copy, 'terminalEvidence').final = { failed: 0, quarantined: 0, exhausted: 0 };
  nested(copy, 'terminalEvidence').groups = [];
  for (const name of WORKER_ADMISSION_SNAPSHOT_NAMES) {
    nested(copy, 'snapshots', name, 'decoderQuarantine').unresolvedCount = 0;
  }
  return copy;
}

function terminalAttribution(options: Readonly<{
  terminalFailed?: number;
  retryPendingFailed?: number;
  currentOverflowRows?: number;
  diagnosticOverflowOccurrences?: number;
  unavailableOccurrences?: number;
  incompleteOccurrences?: number;
  diagnosticGroups?: readonly Record<string, unknown>[];
}> = {}): Record<string, unknown> {
  const terminalFailed = options.terminalFailed ?? 0;
  const retryPendingFailed = options.retryPendingFailed ?? 0;
  const currentOverflowRows = options.currentOverflowRows ?? 0;
  const diagnosticOverflowOccurrences = options.diagnosticOverflowOccurrences ?? 0;
  const requestedUnavailableOccurrences = options.unavailableOccurrences ?? 0;
  const incompleteOccurrences = options.incompleteOccurrences ?? 0;
  const diagnosticGroups = [...(options.diagnosticGroups ?? [])];
  const existingUnavailableOccurrences = diagnosticGroups.reduce(
    (sum, group) => sum + (group.diagnosticCode === 'UNAVAILABLE'
      || group.completeness === 'UNAVAILABLE' ? group.count as number : 0),
    0,
  );
  if (requestedUnavailableOccurrences > existingUnavailableOccurrences) {
    diagnosticGroups.push({
      source: 'WORKER', processingOutcome: 'FAILED', workerCycleAttempt: 1,
      workerRecoveryCount: 0, retryable: true, retryExhausted: false,
      stage: null, originCode: null, diagnosticCode: 'UNAVAILABLE',
      catchUpCauseKind: null, catchUpReasonCode: null, completeness: 'UNAVAILABLE',
      pumpWire: null, count: requestedUnavailableOccurrences - existingUnavailableOccurrences,
      representative: null,
    });
  }
  const unavailableOccurrences = diagnosticGroups.reduce(
    (sum, group) => sum + (group.diagnosticCode === 'UNAVAILABLE'
      || group.completeness === 'UNAVAILABLE' ? group.count as number : 0),
    0,
  );
  const currentGroups: Record<string, unknown>[] = [];
  if (retryPendingFailed > 0) {
    currentGroups.push({
      processingStatus: 'FAILED',
      normalizedErrorName: 'LEGACY_RPC_ERROR',
      retryable: true,
      failureState: 'RETRY_PENDING',
      attempts: 1,
      attemptsInCycle: 1,
      catchUpReasonCode: null,
      count: retryPendingFailed,
    });
  }
  if (terminalFailed > 0) {
    currentGroups.push({
      processingStatus: 'FAILED',
      normalizedErrorName: 'LEGACY_LEASE_EXPIRED',
      retryable: false,
      failureState: 'TERMINAL',
      attempts: 3,
      attemptsInCycle: 3,
      catchUpReasonCode: null,
      count: terminalFailed,
    });
  }
  currentGroups.sort((left, right) => Buffer.compare(
    Buffer.from(String(left.normalizedErrorName), 'utf8'),
    Buffer.from(String(right.normalizedErrorName), 'utf8'),
  ));
  const retainedCurrentRows = terminalFailed + retryPendingFailed;
  const retainedOccurrences = diagnosticGroups.reduce(
    (sum, group) => sum + (group.count as number),
    0,
  );
  return {
    schemaVersion: 'mainnet-terminal-attribution.v1',
    currentPopulation: {
      totalRows: retainedCurrentRows + currentOverflowRows,
      retainedRows: retainedCurrentRows,
      unavailableRows: 0,
      overflow: {
        groupCount: currentOverflowRows > 0 ? 1 : 0,
        rowCount: currentOverflowRows,
      },
      groups: currentGroups,
    },
    diagnosticOccurrences: {
      totalOccurrences: retainedOccurrences + diagnosticOverflowOccurrences,
      retainedOccurrences,
      unavailableOccurrences,
      overflow: {
        groupCount: diagnosticOverflowOccurrences > 0 ? 1 : 0,
        occurrenceCount: diagnosticOverflowOccurrences,
      },
      groups: diagnosticGroups,
    },
    incompleteAttribution: {
      parentRows: incompleteOccurrences > 0 ? 1 : 0,
      missingOccurrences: incompleteOccurrences,
    },
  };
}

function pumpInvalidWorkerGroup(): Record<string, unknown> {
  return {
    source: 'WORKER', processingOutcome: 'FAILED', workerCycleAttempt: 1,
    workerRecoveryCount: 0, retryable: false, retryExhausted: false,
    stage: 'launchpad_observation', originCode: 'PUMP_BORSH_INVALID',
    diagnosticCode: 'PUMP_BORSH_INVALID',
    catchUpCauseKind: null, catchUpReasonCode: null, completeness: 'COMPLETE',
    pumpWire: {
      surface: 'INSTRUCTION', location: 'OUTER', discriminatorHex: '181ec828051c0777',
      idlName: 'buy', totalBytes: 24, payloadBytes: 16, suffixBytes: null,
    },
    count: 1,
    representative: {
      signature: representativeSignature, slot: 1, transactionIndex: 0,
      confirmationStatus: 'finalized', instructionIndex: 1, innerInstructionIndex: null,
    },
  };
}

function fundingDiagnosticGroup(
  diagnosticCode: string,
  retryExhausted: boolean,
): Record<string, unknown> {
  return {
    source: 'WORKER', processingOutcome: 'FAILED', workerCycleAttempt: retryExhausted ? 5 : 1,
    workerRecoveryCount: 0, retryable: true, retryExhausted,
    stage: 'funding_observation', originCode: null, diagnosticCode,
    catchUpCauseKind: null, catchUpReasonCode: null, completeness: 'COMPLETE',
    pumpWire: null, count: 1, representative: null,
  };
}

function catchUpDecoderQuarantineGroup(): Record<string, unknown> {
  return {
    source: 'CATCH_UP', processingOutcome: 'QUARANTINED', workerCycleAttempt: null,
    workerRecoveryCount: null, retryable: null, retryExhausted: null,
    stage: 'launchpad_observation', originCode: 'PUMP_BORSH_INVALID',
    diagnosticCode: 'UNAVAILABLE',
    catchUpCauseKind: 'PUMP_DECODER', catchUpReasonCode: 'PUMP_SCHEMA_UNSUPPORTED',
    completeness: 'COMPLETE', pumpWire: null, count: 1, representative: null,
  };
}

const WORKER_ADMISSION_SNAPSHOT_NAMES = [
  'T0', 'T_PLUS_5', 'T_PLUS_15', 'FINAL_PRESTOP',
] as const;

function passingWorkerAdmissionFixture(): Record<string, unknown> {
  const copy = cloneFixture();
  const claimable = [10, 9, 8, 7] as const;
  const legacyBacklog = [20, 18, 16, 14] as const;
  const pending = [2, 1, 1, 1] as const;
  const ages = [1_000, 2_000, 30_000, 44_999] as const;
  WORKER_ADMISSION_SNAPSHOT_NAMES.forEach((name, index) => {
    const snapshot = nested(copy, 'snapshots', name);
    const claimableBacklogCount = claimable[index] ?? 0;
    snapshot.workerAdmission = workerAdmissionEvidence({
      claimableBacklogCount,
      classificationPendingCount: pending[index] ?? 0,
      oldestClassificationPendingAgeMs: ages[index] ?? null,
      freshMintCount: 3,
      extendedMintCount: 2,
      demotedCount: index,
    });
    setHeartbeatBacklog(snapshot, legacyBacklog[index] ?? claimableBacklogCount);
  });
  const stopped = nested(copy, 'stoppedHeartbeat');
  stopped.workerAdmission = workerAdmissionEvidence({
    claimableBacklogCount: 6,
    classificationPendingCount: 0,
    oldestClassificationPendingAgeMs: null,
    freshMintCount: 2,
    extendedMintCount: 1,
    demotedCount: 4,
  });
  setHeartbeatBacklog(stopped, 12);
  copy.postStopActionableCount = 12;
  copy.postStopWorkerAdmissionClaimableCount = 6;
  return copy;
}

function workerAdmissionEvidence(overrides: Readonly<Record<string, unknown>>):
Record<string, unknown> {
  return {
    version: 1,
    enabled: true,
    trackingWindowSeconds: 45,
    claimableBacklogCount: 0,
    classificationPendingCount: 0,
    oldestClassificationPendingAgeMs: null,
    freshMintCount: 0,
    extendedMintCount: 0,
    demotedCount: 0,
    ...overrides,
  };
}

function setClaimableBacklog(
  copy: Record<string, unknown>,
  name: (typeof WORKER_ADMISSION_SNAPSHOT_NAMES)[number],
  count: number,
): void {
  const snapshot = nested(copy, 'snapshots', name);
  nested(snapshot, 'workerAdmission').claimableBacklogCount = count;
}

function setHeartbeatBacklog(heartbeat: Record<string, unknown>, count: number): void {
  heartbeat.backlogCount = count;
  const admission = nested(heartbeat, 'catchUpAdmission');
  admission.source = { websocketOnly: count, catchUpOnly: 0, websocketAndCatchUp: 0 };
  admission.priority = { normal: count, launchCandidate: 0, trackedTrade: 0 };
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
