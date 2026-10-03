import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evaluateMainnetObserveCanaryV2, parseMainnetObserveCanaryV2, MAINNET_OBSERVE_CANARY_V2_GATE_NAMES } from '../scripts/lib/mainnet-observe-canary-v2.js';
import { evaluateMainnetObserveCanary, MAINNET_OBSERVE_CANARY_GATE_NAMES } from '../scripts/lib/mainnet-observe-canary-verdict.js';
import { twoGroupHydrationEvidenceFixture, stoppedTwoGroupHydrationEvidenceFixture } from './helpers/two-group-hydration-evidence-fixture.js';

const legacy = JSON.parse(await readFile(new URL('./fixtures/mainnet-observe-canary/32c9bf4-failed.v1.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const names = ['T0', 'T_PLUS_5', 'T_PLUS_15', 'FINAL_PRESTOP'] as const;
function fixture() {
  const input = structuredClone(legacy);
  input.schemaVersion = 'mainnet-observe-canary-input.v2';
  const snapshots = input.snapshots as Record<string, Record<string, unknown>>;
  let rss = 0;
  for (const [index, name] of names.entries()) {
    const sample = snapshots[name];
    assert.ok(sample);
    rss = Math.max(rss, sample.rssBytes as number);
    const evidence = twoGroupHydrationEvidenceFixture();
    evidence.blockHydration.fetches = evidence.blockHydration.locates = evidence.blockHydration.misses = 100 + index * 100;
    evidence.blockResponseMemory.maximumRssBytes = rss;
    Object.assign(sample, evidence);
  }
  const stopped = stoppedTwoGroupHydrationEvidenceFixture();
  stopped.blockHydration.fetches = stopped.blockHydration.locates = stopped.blockHydration.misses = 400;
  stopped.blockResponseMemory.maximumRssBytes = rss;
  Object.assign(input.stoppedHeartbeat as object, stopped);
  return input;
}
function samples(input: Record<string, unknown>) {
  const snapshots = input.snapshots as Record<string, Record<string, unknown>>;
  return [...names.map(name => { const sample = snapshots[name]; assert.ok(sample); return sample; }), input.stoppedHeartbeat as Record<string, unknown>];
}
function sampleAt(input: Record<string, unknown>, index: number) { const sample = samples(input)[index]; assert.ok(sample); return sample; }
function sidecar(sample: Record<string, unknown>, name: string) { return sample[name] as Record<string, unknown>; }

void test('explicit V2 keeps the nineteen safety gates and independent failed decoder evidence', () => {
  const result = evaluateMainnetObserveCanaryV2(fixture());
  assert.equal(result.schemaVersion, 'mainnet-observe-canary-result.v2');
  assert.deepEqual(Object.keys(result.gates), MAINNET_OBSERVE_CANARY_V2_GATE_NAMES);
  assert.equal(MAINNET_OBSERVE_CANARY_GATE_NAMES.length, 19);
  assert.equal(result.gates.capacityEnvelope.verdict, 'PASS');
  assert.equal(result.gates.blockHydration.verdict, 'PASS');
  assert.equal(result.overallVerdict, 'FAIL');
  assert.equal(evaluateMainnetObserveCanary(fixture()).overallVerdict, 'INCONCLUSIVE');
});

void test('missing and malformed evidence remain local, with failure precedence and no getters', () => {
  for (const name of ['blockHydration', 'blockHydrationAdmission', 'ordinaryRpcBudget', 'blockResponseMemory']) {
    for (let index = 0; index < 5; index++) {
      const input = fixture();
      Reflect.deleteProperty(samples(input)[index] as object, name);
      const missing = evaluateMainnetObserveCanaryV2(input);
      assert.equal(missing.gates.capacityEnvelope.reasonCode, 'CAPACITY_EVIDENCE_MISSING');
      assert.equal(missing.overallVerdict, 'FAIL');
      let reads = 0;
      Object.defineProperty(sampleAt(input, index), name, { enumerable: true, get() { reads++; throw new Error('secret'); } });
      const malformed = evaluateMainnetObserveCanaryV2(input);
      assert.equal(malformed.gates.capacityEnvelope.reasonCode, 'CAPACITY_EVIDENCE_MALFORMED');
      assert.equal(reads, 0);
      assert.doesNotMatch(JSON.stringify(malformed), /secret/u);
    }
  }
  const invalid = evaluateMainnetObserveCanaryV2({ schemaVersion: 'mainnet-observe-canary-input.v2' });
  assert.equal(invalid.schemaVersion, 'mainnet-observe-canary-result.v2');
  assert.equal(invalid.gates.capacityEnvelope.verdict, 'FAIL');
});

void test('capacity policy preserves rejection and oversized response observations', () => {
  const input = fixture();
  for (const sample of samples(input).slice(1)) sidecar(sample, 'blockResponseMemory').oversizedResponses = 1;
  assert.equal(evaluateMainnetObserveCanaryV2(input).gates.capacityEnvelope.reasonCode, 'CAPACITY_RESPONSE_SIZE_UNPROVEN');
  delete sampleAt(input, 0).blockHydration;
  for (const sample of samples(input).slice(1)) sidecar(sample, 'ordinaryRpcBudget').localRejections = 1;
  assert.equal(evaluateMainnetObserveCanaryV2(input).gates.capacityEnvelope.reasonCode, 'CAPACITY_LOCAL_ADMISSION_REJECTED');
});

void test('capacity rejects every mixed/unknown sidecar and regressing counter, not falling gauges', () => {
  for (const name of ['blockHydration', 'blockHydrationAdmission', 'ordinaryRpcBudget', 'blockResponseMemory']) {
    for (const change of [{ version: 1 }, { privateKey: 'secret' }]) {
      const input = fixture();
      Object.assign(sidecar(sampleAt(input, 1), name), change);
      assert.equal(evaluateMainnetObserveCanaryV2(input).gates.capacityEnvelope.verdict, 'FAIL');
    }
  }
  const input = fixture();
  sidecar(sampleAt(input, 2), 'blockHydration').fetches = 0;
  assert.equal(evaluateMainnetObserveCanaryV2(input).gates.capacityEnvelope.reasonCode, 'CAPACITY_EVIDENCE_MALFORMED');
  const gauges = fixture();
  Object.assign(sidecar(sampleAt(gauges, 0), 'blockHydration'), { activeGroups: 2, maximumActiveGroups: 2 });
  for (const sample of samples(gauges).slice(1)) sidecar(sample, 'blockHydration').maximumActiveGroups = 2;
  assert.equal(evaluateMainnetObserveCanaryV2(gauges).gates.capacityEnvelope.verdict, 'PASS');
});

void test('capacity requires stopped drain and closed budget without draining rolling starts', () => {
  for (const [name, field] of [['blockHydration', 'activeGroups'], ['blockHydrationAdmission', 'unboundReservations'], ['ordinaryRpcBudget', 'queuedWaiters'], ['blockResponseMemory', 'activeBodies']] as const) {
    const input = fixture();
    const item = sidecar(sampleAt(input, 4), name);
    item[field] = 1;
    if (name === 'blockHydration') item.maximumActiveGroups = 1;
    if (name === 'blockHydrationAdmission') item.maximumAdmitted = 1;
    if (name === 'ordinaryRpcBudget') item.maximumQueuedWaiters = 1;
    delete sampleAt(input, 0).blockResponseMemory;
    assert.equal(evaluateMainnetObserveCanaryV2(input).gates.capacityEnvelope.reasonCode, 'CAPACITY_NOT_DRAINED');
  }
  const input = fixture();
  Object.assign(sidecar(sampleAt(input, 4), 'ordinaryRpcBudget'), { startsInWindow: 1, maximumStartsInWindow: 1 });
  assert.equal(evaluateMainnetObserveCanaryV2(input).gates.capacityEnvelope.verdict, 'PASS');
});

void test('RSS high-water fails even when boundary memory falls and capacity stays bounded', () => {
  const input = fixture();
  for (const sample of samples(input).slice(2)) sidecar(sample, 'blockResponseMemory').maximumRssBytes = 4_000_000_000;
  const result = evaluateMainnetObserveCanaryV2(input);
  assert.equal(result.gates.rss.verdict, 'FAIL');
  assert.equal(result.gates.capacityEnvelope.verdict, 'PASS');
});

void test('V1 golden verdict remains exactly nineteen ordered gates', () => {
  const verdicts = [
    ['FAIL', 'RUNTIME_RECOVERY_UNRESOLVED'], ['PASS', 'RPC_HTTP_429_NONE'],
    ['FAIL', 'BACKLOG_GREW'], ['FAIL', 'TERMINAL_RETRIES_EXHAUSTED'],
    ['PASS', 'IDEMPOTENCE_CONFIRMED'], ['PASS', 'RETENTION_CONFIRMED'],
    ['INCONCLUSIVE', 'TERMINAL_ATTRIBUTION_MISSING'], ['FAIL', 'FIRST_PROCESSING_FAIL'],
    ['FAIL', 'BLOCK_HYDRATION_LIMIT_EXCEEDED'], ['INCONCLUSIVE', 'BLOCK_HYDRATION_ADMISSION_EVIDENCE_MISSING'],
    ['PASS', 'ADMISSION_PROVIDER_AFFINE'], ['INCONCLUSIVE', 'WORKER_ADMISSION_EVIDENCE_MISSING'],
    ['PASS', 'PROVIDER_AFFINITY_STABLE'], ['PASS', 'RSS_WITHIN_LIMIT'],
    ['PASS', 'PUMPSWAP_ISOLATED'], ['PASS', 'FINALITY_HEALTHY'],
    ['PASS', 'VERSIONS_REPLAY_CONFIRMED'], ['PASS', 'SHUTDOWN_CLEAN_WITH_DURABLE_BACKLOG'], ['PASS', 'CLEANUP_COMPLETE'],
  ];
  assert.deepEqual(evaluateMainnetObserveCanary(legacy), {
    schemaVersion: 'mainnet-observe-canary-result.v1', commit: '32c9bf4c35268219184bd054f1e1f643065ecfd6', overallVerdict: 'FAIL',
    gates: Object.fromEntries(MAINNET_OBSERVE_CANARY_GATE_NAMES.map((name, index) => {
      const expected = verdicts[index]; assert.ok(expected);
      return [name, { verdict: expected[0], reasonCode: expected[1] }];
    })),
  });
  const mixed = structuredClone(legacy);
  Object.assign((mixed.snapshots as Record<string, Record<string, unknown>>).T0 as object, twoGroupHydrationEvidenceFixture());
  assert.equal(evaluateMainnetObserveCanary(mixed).overallVerdict, 'INCONCLUSIVE');
});

void test('every boundary enforces exact sidecar identities and independent bounds', () => {
  const mutations = [
    ['blockHydration', { maximumActiveGroups: 3 }], ['blockHydration', { maximumQueuedFetches: 3 }],
    ['blockHydration', { retainedEntries: 65 }], ['blockHydration', { callerConcurrency: 1 }],
    ['blockHydrationAdmission', { maximumAdmitted: 3 }], ['blockHydrationAdmission', { registeredWorkers: 2 }],
    ['ordinaryRpcBudget', { windowMs: 999 }], ['ordinaryRpcBudget', { maximumStartsInWindow: 9 }],
    ['ordinaryRpcBudget', { maximumQueuedWaiters: 65 }], ['blockResponseMemory', { activeBodies: 3 }],
    ['blockResponseMemory', { maximumInFlightBytes: 67_108_865 }], ['blockResponseMemory', { perResponseLimitBytes: 1 }],
  ] as const;
  for (let index = 0; index < 5; index++) {
    for (const name of ['blockHydration', 'blockHydrationAdmission', 'ordinaryRpcBudget', 'blockResponseMemory']) {
      for (const change of [{ version: 1 }, { privateKey: 'private-secret' }]) {
        const input = fixture(); Object.assign(sidecar(sampleAt(input, index), name), change);
        const result = evaluateMainnetObserveCanaryV2(input);
        assert.equal(result.gates.capacityEnvelope.reasonCode, 'CAPACITY_EVIDENCE_MALFORMED');
        assert.doesNotMatch(JSON.stringify(result), /private-secret/u);
      }
    }
    for (const [name, change] of mutations) {
      const input = fixture(); Object.assign(sidecar(sampleAt(input, index), name), change);
      assert.equal(evaluateMainnetObserveCanaryV2(input).gates.capacityEnvelope.reasonCode, 'CAPACITY_EVIDENCE_MALFORMED');
    }
  }
});

void test('every cumulative/max field is monotone including completed role waits and closed budget', () => {
  const hydrationCounters = ['locates', 'hits', 'misses', 'inFlightJoins', 'fetches', 'forcedRefreshes', 'evictions', 'oversizeBypasses', 'fetchFailures', 'epochInvalidations', 'sameGroupJoins', 'maximumActiveGroups', 'maximumQueuedGroups', 'maximumInFlightFetches', 'maximumQueuedFetches', 'maximumUnsettledAfterCancel'];
  const groups = [
    ['blockHydration', hydrationCounters],
    ['blockHydrationAdmission', ['maximumPendingWorkers', 'maximumPendingClassifierGroups', 'maximumAdmitted']],
    ['ordinaryRpcBudget', ['maximumStartsInWindow', 'maximumQueuedWaiters', 'localRejections']],
    ['blockResponseMemory', ['maximumInFlightBytes', 'oversizedResponses', 'maximumRssBytes']],
  ] as const;
  for (const [name, fields] of groups) for (const field of fields) {
    const input = fixture();
    // Install a valid plateau, then reset only at the last boundary.
    for (const sample of samples(input)) sidecar(sample, name)[field] = field === 'maximumRssBytes' ? 4_000_000_000 : 1;
    sidecar(sampleAt(input, 4), name)[field] = 0;
    assert.equal(evaluateMainnetObserveCanaryV2(input).gates.capacityEnvelope.reasonCode, 'CAPACITY_EVIDENCE_MALFORMED', `${name}.${field}`);
  }
  for (const role of ['worker', 'classifier']) for (const field of ['grants', 'cancellations', 'maximumWaitMs']) {
    const input = fixture();
    for (const sample of samples(input)) Object.assign(sidecar(sample, 'blockHydrationAdmission')[role] as object,
      { grants: 2, cancellations: 1, lastWaitMs: 1, maximumWaitMs: 2 });
    (sidecar(sampleAt(input, 4), 'blockHydrationAdmission')[role] as Record<string, unknown>)[field] = field === 'maximumWaitMs' ? 1 : 0;
    assert.equal(evaluateMainnetObserveCanaryV2(input).gates.capacityEnvelope.reasonCode, 'CAPACITY_EVIDENCE_MALFORMED', `${role}.${field}`);
  }
  const reopened = fixture(); sidecar(sampleAt(reopened, 1), 'ordinaryRpcBudget').closed = true;
  assert.equal(evaluateMainnetObserveCanaryV2(reopened).gates.capacityEnvelope.reasonCode, 'CAPACITY_EVIDENCE_MALFORMED');
});

void test('provider membership uses canonical set identity and failure precedes missing cells', () => {
  const input = fixture();
  const rpc = sidecar(sampleAt(input, 1), 'rpcHttpEvidence');
  const providers = rpc.providers as Record<string, unknown>[];
  providers.reverse();
  assert.equal(evaluateMainnetObserveCanaryV2(input).gates.capacityEnvelope.verdict, 'PASS');
  const provider = providers.find(item => item.providerId === 'fallback-3'); assert.ok(provider);
  provider.configured = !provider.configured;
  delete sampleAt(input, 0).ordinaryRpcBudget;
  assert.equal(evaluateMainnetObserveCanaryV2(input).gates.capacityEnvelope.reasonCode, 'CAPACITY_PROVIDER_MEMBERSHIP_CHANGED');
});

void test('the parsed V2 graph is detached and frozen without a V1 concurrency adapter', () => {
  const input = fixture(); const parsed = parseMainnetObserveCanaryV2(input);
  const evidence = parsed.snapshots.T0.blockHydration; assert.equal(evidence.state, 'VALID');
  assert.ok(evidence.state === 'VALID');
  sidecar(sampleAt(input, 0), 'blockHydration').fetches = 99;
  assert.equal(evidence.value.fetches, 100);
  assert.equal(Object.hasOwn(evidence.value, 'callerConcurrency'), false);
  assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(evidence.value));
  assert.ok(Object.isFrozen(evidence.value.queueDelayMs));
});

void test('missing capacity cannot erase proven provider mixing, stopped leases, or core safety failures', () => {
  for (const [gateName, mutate] of [
    ['providerAffinity', (input: Record<string, unknown>) => { input.providerMixingEvidenceCount = 1; }],
    ['shutdown', (input: Record<string, unknown>) => { sampleAt(input, 4).leasedCount = 1; }],
    ['idempotence', (input: Record<string, unknown>) => { sidecar(sampleAt(input, 1), 'inbox').admissionReceiptViolations = 1; }],
    ['retention', (input: Record<string, unknown>) => { sidecar(sampleAt(input, 1), 'inbox').terminalRetentionViolations = 1; }],
    ['decoderQuarantine', (input: Record<string, unknown>) => { sidecar(sampleAt(input, 1), 'decoderQuarantine').unresolvedCount = 1; }],
    ['finality', (input: Record<string, unknown>) => { sidecar(sampleAt(input, 3), 'inbox').finalityContradictions = 1; }],
    ['versionsAndFreshReplay', (input: Record<string, unknown>) => { (input.versionReplayProof as Record<string, unknown>).freshDatabase = false; }],
    ['pumpswap', (input: Record<string, unknown>) => { sampleAt(input, 1).pipelinePumpswap = 'RUNNING'; }],
    ['cleanup', (input: Record<string, unknown>) => { input.cleanupComplete = false; }],
    ['http429', (input: Record<string, unknown>) => { const providers = sidecar(sampleAt(input, 4), 'rpcHttpEvidence').providers as Record<string, unknown>[]; const provider = providers[0]; assert.ok(provider); provider.http429Responses = 1; }],
  ] as const) {
    const input = fixture(); mutate(input); delete sampleAt(input, 0).blockHydration;
    const result = evaluateMainnetObserveCanaryV2(input);
    assert.equal(result.gates[gateName].verdict, 'FAIL', gateName);
    assert.equal(result.overallVerdict, 'FAIL');
  }
});

void test('V2 RSS retains the exact relative ceiling, overflow, and missing evidence semantics', () => {
  const input = fixture(); const baseline = sampleAt(input, 1).rssBytes as number;
  const limit = baseline + Math.max(Math.ceil(baseline / 4), 134_217_728);
  for (const sample of samples(input)) sidecar(sample, 'blockResponseMemory').maximumRssBytes = limit;
  assert.equal(evaluateMainnetObserveCanaryV2(input).gates.rss.verdict, 'PASS');
  sidecar(sampleAt(input, 4), 'blockResponseMemory').maximumRssBytes = limit + 1;
  assert.equal(evaluateMainnetObserveCanaryV2(input).gates.rss.verdict, 'FAIL');
  delete sampleAt(input, 0).blockResponseMemory;
  assert.equal(evaluateMainnetObserveCanaryV2(input).gates.rss.verdict, 'FAIL');
  const missing = fixture(); delete sampleAt(missing, 0).blockResponseMemory;
  assert.equal(evaluateMainnetObserveCanaryV2(missing).gates.rss.verdict, 'INCONCLUSIVE');
  const overflow = fixture(); sampleAt(overflow, 1).rssBytes = Number.MAX_SAFE_INTEGER;
  assert.equal(evaluateMainnetObserveCanaryV2(overflow).gates.rss.reasonCode, 'RSS_LIMIT_OVERFLOW');
});

void test('hydration retains actual fetch/failure/bypass thresholds and admission is cache-independent', () => {
  for (const [field, delta] of [['fetchFailures', 1], ['oversizeBypasses', 2], ['fetches', 100_000]] as const) {
    const input = fixture();
    for (const sample of samples(input).slice(1)) sidecar(sample, 'blockHydration')[field] = field === 'fetches' ? 100 + delta : delta;
    assert.equal(evaluateMainnetObserveCanaryV2(input).gates.blockHydration.verdict, 'FAIL');
  }
  const noFetch = fixture();
  for (const sample of samples(noFetch)) sidecar(sample, 'blockHydration').fetches = 100;
  assert.equal(evaluateMainnetObserveCanaryV2(noFetch).gates.blockHydration.verdict, 'INCONCLUSIVE');
  const independent = fixture();
  const admission = sidecar(sampleAt(independent, 0), 'blockHydrationAdmission');
  admission.pendingClassifierGroups = 2;
  (admission.classifier as Record<string, unknown>).oldestWaitMs = 100;
  for (const sample of samples(independent)) sidecar(sample, 'blockHydrationAdmission').maximumPendingClassifierGroups = 2;
  assert.equal(sidecar(sampleAt(independent, 0), 'blockHydration').queuedGroups, 0);
  assert.equal(evaluateMainnetObserveCanaryV2(independent).gates.capacityEnvelope.verdict, 'PASS');
  assert.equal(evaluateMainnetObserveCanaryV2(independent).gates.blockHydrationAdmission.verdict, 'PASS');
  admission.registeredWorkers = 0;
  assert.equal(evaluateMainnetObserveCanaryV2(independent).gates.blockHydrationAdmission.verdict, 'FAIL');
});

void test('opaque non-enumerable/accessor/proxy sidecars fail locally while hostile core remains unread', () => {
  for (const value of [undefined, new Proxy(twoGroupHydrationEvidenceFixture().blockHydration, {})]) {
    const input = fixture(); sampleAt(input, 0).blockHydration = value;
    const result = evaluateMainnetObserveCanaryV2(input);
    assert.equal(result.gates.capacityEnvelope.verdict, 'FAIL');
    assert.equal(result.gates.terminalFailures.verdict, 'FAIL');
  }
  const hidden = fixture(); Object.defineProperty(sampleAt(hidden, 0), 'ordinaryRpcBudget', { enumerable: false });
  assert.equal(evaluateMainnetObserveCanaryV2(hidden).gates.capacityEnvelope.reasonCode, 'CAPACITY_EVIDENCE_MALFORMED');
  const hostile = fixture(); let reads = 0;
  Object.defineProperty(sampleAt(hostile, 0), 'rssBytes', { enumerable: true, get() { reads++; throw new Error('secret'); } });
  const result = evaluateMainnetObserveCanaryV2(hostile);
  assert.equal(reads, 0); assert.equal(result.gates.capacityEnvelope.verdict, 'FAIL');
  for (const name of MAINNET_OBSERVE_CANARY_GATE_NAMES) assert.equal(result.gates[name].verdict, 'INCONCLUSIVE');
  assert.doesNotMatch(JSON.stringify(result), /secret/u);
});
