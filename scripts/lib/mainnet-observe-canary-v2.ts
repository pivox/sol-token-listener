import {
  snapshotRuntimeBlockHydrationMetricsV2,
  snapshotRuntimeBlockHydrationAdmissionMetricsV2,
  snapshotRuntimeOrdinaryRpcBudgetMetricsV2,
  snapshotRuntimeBlockResponseMemoryMetricsV2,
  type RuntimeBlockHydrationMetricsV2,
  type RuntimeBlockHydrationAdmissionMetricsV2,
  type RuntimeOrdinaryRpcBudgetMetricsV2,
  type RuntimeBlockResponseMemoryMetricsV2,
} from '../../src/domain/two-group-hydration-evidence.js';
import {
  MAINNET_OBSERVE_CANARY_GATE_NAMES,
  parseMainnetObserveCanaryCore,
  evaluateMainnetObserveCanarySafetyGates,
  type MainnetObserveCanaryCoreInput,
  type MainnetObserveCanaryVerdict,
  type MainnetObserveCanaryGateResultV1,
} from './mainnet-observe-canary-verdict.js';

export const MAINNET_OBSERVE_CANARY_V2_GATE_NAMES = [...MAINNET_OBSERVE_CANARY_GATE_NAMES, 'capacityEnvelope'] as const;
export type MainnetObserveCanaryV2GateName = typeof MAINNET_OBSERVE_CANARY_V2_GATE_NAMES[number];
export interface MainnetObserveCanaryResultV2 {
  readonly schemaVersion: 'mainnet-observe-canary-result.v2';
  readonly commit: string | null;
  readonly overallVerdict: MainnetObserveCanaryVerdict;
  readonly gates: Readonly<Record<MainnetObserveCanaryV2GateName, MainnetObserveCanaryGateResultV1>>;
}
export type V2Evidence<T> = Readonly<{ state: 'MISSING' | 'MALFORMED'; value: null }>
  | Readonly<{ state: 'VALID'; value: T }>;
interface Sidecars {
  readonly blockHydration: V2Evidence<RuntimeBlockHydrationMetricsV2>;
  readonly blockHydrationAdmission: V2Evidence<RuntimeBlockHydrationAdmissionMetricsV2>;
  readonly ordinaryRpcBudget: V2Evidence<RuntimeOrdinaryRpcBudgetMetricsV2>;
  readonly blockResponseMemory: V2Evidence<RuntimeBlockResponseMemoryMetricsV2>;
}
export type MainnetObserveCanaryInputV2 = Omit<MainnetObserveCanaryCoreInput, 'snapshots' | 'stoppedHeartbeat'> & Readonly<{
  snapshots: Readonly<Record<'T0' | 'T_PLUS_5' | 'T_PLUS_15' | 'FINAL_PRESTOP', MainnetObserveCanaryCoreInput['snapshots']['T0'] & Sidecars>>;
  stoppedHeartbeat: MainnetObserveCanaryCoreInput['stoppedHeartbeat'] & Sidecars;
}>;
const names = ['T0', 'T_PLUS_5', 'T_PLUS_15', 'FINAL_PRESTOP'] as const;
const sidecarNames = ['blockHydration', 'blockHydrationAdmission', 'ordinaryRpcBudget', 'blockResponseMemory'] as const;

function parseV2Sidecar<T>(input: object, name: string, snapshot: (value: unknown) => T): V2Evidence<T> {
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  if (descriptor === undefined) return Object.freeze({ state: 'MISSING', value: null });
  if (!descriptor.enumerable || !('value' in descriptor)) return Object.freeze({ state: 'MALFORMED', value: null });
  try { return Object.freeze({ state: 'VALID', value: snapshot(descriptor.value) }); }
  catch { return Object.freeze({ state: 'MALFORMED', value: null }); }
}
export function parseMainnetObserveCanaryV2(input: unknown): MainnetObserveCanaryInputV2 {
  return parseMainnetObserveCanaryCore(input, 'mainnet-observe-canary-input.v2', value => Object.freeze({
    blockHydration: parseV2Sidecar(value, 'blockHydration', snapshotRuntimeBlockHydrationMetricsV2),
    blockHydrationAdmission: parseV2Sidecar(value, 'blockHydrationAdmission', snapshotRuntimeBlockHydrationAdmissionMetricsV2),
    ordinaryRpcBudget: parseV2Sidecar(value, 'ordinaryRpcBudget', snapshotRuntimeOrdinaryRpcBudgetMetricsV2),
    blockResponseMemory: parseV2Sidecar(value, 'blockResponseMemory', snapshotRuntimeBlockResponseMemoryMetricsV2),
  }));
}
function gate(verdict: MainnetObserveCanaryVerdict, reasonCode: string): MainnetObserveCanaryGateResultV1 {
  return Object.freeze({ verdict, reasonCode });
}
function result(commit: string | null, source: Readonly<Record<MainnetObserveCanaryV2GateName, MainnetObserveCanaryGateResultV1>>): MainnetObserveCanaryResultV2 {
  const gates = Object.freeze(Object.fromEntries(MAINNET_OBSERVE_CANARY_V2_GATE_NAMES.map(name => [name, source[name]]))) as MainnetObserveCanaryResultV2['gates'];
  const verdicts = Object.values(gates).map(value => value.verdict);
  return Object.freeze({ schemaVersion: 'mainnet-observe-canary-result.v2', commit,
    overallVerdict: verdicts.includes('FAIL') ? 'FAIL' : verdicts.includes('INCONCLUSIVE') ? 'INCONCLUSIVE' : 'PASS', gates });
}
export function evaluateMainnetObserveCanaryV2(input: unknown, terminalAttribution?: unknown): MainnetObserveCanaryResultV2 {
  let evidence: MainnetObserveCanaryInputV2;
  try { evidence = parseMainnetObserveCanaryV2(input); }
  catch {
    const gates = Object.fromEntries(MAINNET_OBSERVE_CANARY_V2_GATE_NAMES.map(name => [name,
      name === 'capacityEnvelope' ? gate('FAIL', 'CAPACITY_EVIDENCE_MALFORMED') : gate('INCONCLUSIVE', 'INVALID_EVIDENCE')])) as Record<MainnetObserveCanaryV2GateName, MainnetObserveCanaryGateResultV1>;
    return result(null, gates);
  }
  const safety = evaluateMainnetObserveCanarySafetyGates(evidence, terminalAttribution);
  return result(evidence.commit, { ...safety, blockHydration: hydration(evidence),
    blockHydrationAdmission: admission(evidence), providerAffinity: affinity(evidence),
    shutdown: shutdown(evidence), rss: rss(evidence, safety.rss), capacityEnvelope: capacity(evidence) });
}
function samples(input: MainnetObserveCanaryInputV2): readonly (MainnetObserveCanaryCoreInput['stoppedHeartbeat'] & Sidecars)[] {
  return [...names.map(name => input.snapshots[name]), input.stoppedHeartbeat];
}
function cells<T>(input: MainnetObserveCanaryInputV2, select: (sample: Sidecars) => V2Evidence<T>): readonly V2Evidence<T>[] {
  return samples(input).map(select);
}
function valid<T>(evidence: readonly V2Evidence<T>[]): T[] {
  return evidence.flatMap(item => item.state === 'VALID' ? [item.value] : []);
}
function regresses<T>(evidence: readonly V2Evidence<T>[], fields: readonly ((value: T) => number | null)[]): boolean {
  const values = valid(evidence);
  return fields.some(field => values.some((value, index) => {
    if (index === 0) return false;
    const previous = values[index - 1];
    if (previous === undefined) return false;
    const before = field(previous);
    const after = field(value);
    return before !== null && (after === null || after < before);
  }));
}
const hydrationCounters = ['locates', 'hits', 'misses', 'inFlightJoins', 'fetches', 'forcedRefreshes', 'evictions', 'oversizeBypasses', 'fetchFailures', 'epochInvalidations', 'sameGroupJoins', 'maximumActiveGroups', 'maximumQueuedGroups', 'maximumInFlightFetches', 'maximumQueuedFetches', 'maximumUnsettledAfterCancel'] as const;
const hydrationWork = ['activeGroups', 'queuedGroups', 'inFlightFetches', 'queuedFetches', 'unsettledAfterCancel', 'retainedEntries', 'retainedBytes'] as const;
const admissionWork = ['pendingWorkers', 'pendingClassifierGroups', 'unboundReservations', 'activeGroups'] as const;
function notDrained(sample: Sidecars): boolean {
  const { blockHydration, blockHydrationAdmission, ordinaryRpcBudget, blockResponseMemory } = sample;
  return (blockHydration.state === 'VALID' && hydrationWork.some(name => blockHydration.value[name] !== 0))
    || (blockHydrationAdmission.state === 'VALID' && admissionWork.some(name => blockHydrationAdmission.value[name] !== 0))
    || (ordinaryRpcBudget.state === 'VALID' && (ordinaryRpcBudget.value.queuedWaiters !== 0 || !ordinaryRpcBudget.value.closed))
    || (blockResponseMemory.state === 'VALID' && (blockResponseMemory.value.activeBodies !== 0 || blockResponseMemory.value.inFlightBytes !== 0));
}
function capacity(input: MainnetObserveCanaryInputV2): MainnetObserveCanaryGateResultV1 {
  const all = samples(input);
  const hydration = cells(input, sample => sample.blockHydration);
  const admission = cells(input, sample => sample.blockHydrationAdmission);
  const budget = cells(input, sample => sample.ordinaryRpcBudget);
  const memory = cells(input, sample => sample.blockResponseMemory);
  // Validate each population independently. Missing samples cannot erase a proved failure,
  // and admission/cache gauges describe different phases rather than equal populations.
  const malformed = all.some(sample => sidecarNames.some(name => sample[name].state === 'MALFORMED'))
    || regresses(hydration, hydrationCounters.map(name => (value): number => value[name]))
    || regresses(admission, [(value): number => value.maximumPendingWorkers, (value): number => value.maximumPendingClassifierGroups, (value): number => value.maximumAdmitted,
      ...(['worker', 'classifier'] as const).flatMap(role => (['grants', 'cancellations', 'maximumWaitMs'] as const).map(name => (value: RuntimeBlockHydrationAdmissionMetricsV2): number | null => value[role][name]))])
    || regresses(budget, [(value): number => value.maximumStartsInWindow, (value): number => value.maximumQueuedWaiters, (value): number => value.localRejections])
    || regresses(memory, [(value): number => value.maximumInFlightBytes, (value): number => value.oversizedResponses, (value): number => value.maximumRssBytes])
    || names.some(name => input.snapshots[name].runtimeState === 'RUNNING' && input.snapshots[name].blockHydrationAdmission.state === 'VALID' && input.snapshots[name].blockHydrationAdmission.value.registeredWorkers !== 1)
    || valid(budget).some((value, index, values) => index > 0 && values[index - 1]?.closed === true && !value.closed);
  if (malformed) return gate('FAIL', 'CAPACITY_EVIDENCE_MALFORMED');
  const membership = all.map(sample => JSON.stringify(sample.rpcHttpEvidence.providers.map(provider => [provider.providerId, provider.configured] as const).sort((a, b) => a[0].localeCompare(b[0]))));
  if (membership.some(value => value !== membership[0])) return gate('FAIL', 'CAPACITY_PROVIDER_MEMBERSHIP_CHANGED');
  if (notDrained(input.stoppedHeartbeat)) return gate('FAIL', 'CAPACITY_NOT_DRAINED');
  if (valid(budget).some(value => value.localRejections > 0)) return gate('FAIL', 'CAPACITY_LOCAL_ADMISSION_REJECTED');
  if (all.some(sample => sidecarNames.some(name => sample[name].state === 'MISSING'))) return gate('INCONCLUSIVE', 'CAPACITY_EVIDENCE_MISSING');
  if (valid(memory).some(value => value.oversizedResponses > 0)) return gate('INCONCLUSIVE', 'CAPACITY_RESPONSE_SIZE_UNPROVEN');
  return gate('PASS', 'CAPACITY_ENVELOPE_BOUNDED');
}
function hydration(input: MainnetObserveCanaryInputV2): MainnetObserveCanaryGateResultV1 {
  const evidence = cells(input, sample => sample.blockHydration);
  if (evidence.some(value => value.state === 'MALFORMED') || regresses(evidence, hydrationCounters.map(name => (value): number => value[name]))) return gate('FAIL', 'BLOCK_HYDRATION_CONTRACT_INVALID');
  const stopped = input.stoppedHeartbeat.blockHydration;
  if (stopped.state === 'VALID' && hydrationWork.some(name => stopped.value[name] !== 0)) return gate('FAIL', 'BLOCK_HYDRATION_NOT_DRAINED');
  // Any readable pair can prove a limit violation even when another sample is missing.
  const observed = names.flatMap(name => { const sample = input.snapshots[name]; return sample.blockHydration.state === 'VALID' ? [{ time: sample.observedAtMs, value: sample.blockHydration.value }] : []; });
  const first = observed[0]; const last = observed.at(-1);
  if (first !== undefined && last !== undefined && first !== last) {
    const fetches = last.value.fetches - first.value.fetches;
    const failures = last.value.fetchFailures - first.value.fetchFailures;
    const oversize = last.value.oversizeBypasses - first.value.oversizeBypasses;
    const elapsed = (last.time - first.time) / 1_000;
    if (failures > 0 || oversize > 1 || (elapsed > 0 && fetches / elapsed > 4)) return gate('FAIL', 'BLOCK_HYDRATION_LIMIT_EXCEEDED');
  }
  if (evidence.some(value => value.state === 'MISSING')) return gate('INCONCLUSIVE', 'BLOCK_HYDRATION_EVIDENCE_MISSING');
  if (first === undefined || last === undefined || last.value.fetches <= first.value.fetches || last.time <= first.time) return gate('INCONCLUSIVE', 'BLOCK_HYDRATION_COUNTERS_INCOHERENT');
  return gate('PASS', 'BLOCK_HYDRATION_WITHIN_LIMITS');
}
function admission(input: MainnetObserveCanaryInputV2): MainnetObserveCanaryGateResultV1 {
  const evidence = cells(input, sample => sample.blockHydrationAdmission);
  if (evidence.some(value => value.state === 'MALFORMED') || names.some(name => {
    const sample = input.snapshots[name]; return sample.runtimeState === 'RUNNING' && sample.blockHydrationAdmission.state === 'VALID' && sample.blockHydrationAdmission.value.registeredWorkers !== 1;
  })) return gate('FAIL', 'BLOCK_HYDRATION_ADMISSION_EVIDENCE_MALFORMED');
  const stopped = input.stoppedHeartbeat.blockHydrationAdmission;
  if (stopped.state === 'VALID' && admissionWork.some(name => stopped.value[name] !== 0)) return gate('FAIL', 'BLOCK_HYDRATION_ADMISSION_NOT_DRAINED');
  if (evidence.some(value => value.state === 'MISSING')) return gate('INCONCLUSIVE', 'BLOCK_HYDRATION_ADMISSION_EVIDENCE_MISSING');
  return gate('PASS', 'BLOCK_HYDRATION_ADMISSION_BOUNDED');
}
function affinity(input: MainnetObserveCanaryInputV2): MainnetObserveCanaryGateResultV1 {
  if (input.providerMixingEvidenceCount > 0) return gate('FAIL', 'PROVIDER_MIXING_OBSERVED');
  const evidence = names.map(name => input.snapshots[name].blockHydration);
  if (evidence.some(value => value.state === 'MALFORMED')) return gate('FAIL', 'BLOCK_HYDRATION_CONTRACT_INVALID');
  if (regresses(evidence, [(value): number => value.epochInvalidations])) return gate('INCONCLUSIVE', 'EPOCH_COUNTER_RESET');
  if (evidence.some(value => value.state === 'MISSING')) return gate('INCONCLUSIVE', 'BLOCK_HYDRATION_EVIDENCE_MISSING');
  const ids = names.map(name => input.snapshots[name].catchUpAdmission.providerId);
  if (ids.some(id => id === null)) return gate('INCONCLUSIVE', 'AFFINITY_PROVIDER_MISSING');
  return ids.every(id => id === ids[0]) ? gate('PASS', 'PROVIDER_AFFINITY_STABLE') : gate('INCONCLUSIVE', 'PROVIDER_SWITCH_UNPROVEN');
}
function shutdown(input: MainnetObserveCanaryInputV2): MainnetObserveCanaryGateResultV1 {
  const stopped = input.stoppedHeartbeat;
  if ([stopped.runtimeState, stopped.subscriberState, stopped.scannerState, stopped.workerState, stopped.reconcilerState].some(state => state !== 'STOPPED')
    || stopped.leasedCount !== 0 || stopped.catchUpAdmission.scanActive || stopped.catchUpAdmission.workerClaimReady || stopped.catchUpAdmission.providerId !== null || notDrained(stopped)) return gate('FAIL', 'SHUTDOWN_RESIDUAL_WORK');
  if (sidecarNames.some(name => stopped[name].state === 'MALFORMED')) return gate('FAIL', 'CAPACITY_EVIDENCE_MALFORMED');
  const total = (value: Readonly<Record<string, number>>): bigint => Object.values(value).reduce((sum, count) => sum + BigInt(count), 0n);
  if (total(stopped.catchUpAdmission.source) !== BigInt(stopped.backlogCount) || total(stopped.catchUpAdmission.priority) !== BigInt(stopped.backlogCount) || input.postStopActionableCount !== stopped.backlogCount) return gate('INCONCLUSIVE', 'SHUTDOWN_DURABLE_COUNTS_INCOHERENT');
  if (sidecarNames.some(name => stopped[name].state === 'MISSING')) return gate('INCONCLUSIVE', 'CAPACITY_EVIDENCE_MISSING');
  return gate('PASS', 'SHUTDOWN_CLEAN_WITH_DURABLE_BACKLOG');
}
function rss(input: MainnetObserveCanaryInputV2, boundary: MainnetObserveCanaryGateResultV1): MainnetObserveCanaryGateResultV1 {
  const baseline = BigInt(input.snapshots.T_PLUS_5.rssBytes);
  const proportional = (baseline + 3n) / 4n;
  const limit = baseline + (proportional > 134_217_728n ? proportional : 134_217_728n);
  if (limit > BigInt(Number.MAX_SAFE_INTEGER)) return gate('INCONCLUSIVE', 'RSS_LIMIT_OVERFLOW');
  const evidence = cells(input, sample => sample.blockResponseMemory);
  if (boundary.verdict === 'FAIL' || valid(evidence).some(value => BigInt(value.maximumRssBytes) > limit)) return gate('FAIL', 'RSS_LIMIT_EXCEEDED');
  if (evidence.some(value => value.state === 'MALFORMED')) return gate('INCONCLUSIVE', 'RSS_EVIDENCE_MALFORMED');
  if (evidence.some(value => value.state === 'MISSING')) return gate('INCONCLUSIVE', 'RSS_EVIDENCE_MISSING');
  return boundary;
}
