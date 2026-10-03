import { isProxy } from 'node:util/types';
import type { RuntimeHydrationAdmissionRoleMetricsV1 } from './block-hydration-admission.js';

export interface RuntimeBlockHydrationMetricsV2 {
  readonly version: 2; readonly enabled: true; readonly configuredGroups: 2;
  readonly locates: number; readonly hits: number; readonly misses: number;
  readonly inFlightJoins: number; readonly fetches: number;
  readonly forcedRefreshes: number; readonly evictions: number;
  readonly oversizeBypasses: number; readonly fetchFailures: number;
  readonly epochInvalidations: number; readonly retainedEntries: number;
  readonly retainedBytes: number; readonly inFlightFetches: number;
  readonly queuedFetches: number;
  readonly queueDelayMs: Readonly<{ last: number | null; maximum: number | null }>;
  readonly activeGroups: number; readonly maximumActiveGroups: number;
  readonly queuedGroups: number; readonly maximumQueuedGroups: number;
  readonly maximumInFlightFetches: number; readonly maximumQueuedFetches: number;
  readonly sameGroupJoins: number; readonly unsettledAfterCancel: number;
  readonly maximumUnsettledAfterCancel: number;
}
export interface RuntimeBlockResponseMemoryMetricsV2 {
  readonly version: 2; readonly perResponseLimitBytes: 33554432;
  readonly totalInFlightLimitBytes: 67108864; readonly activeBodies: number;
  readonly inFlightBytes: number; readonly maximumInFlightBytes: number;
  readonly oversizedResponses: number; readonly maximumRssBytes: number;
}
export interface RuntimeBlockHydrationAdmissionMetricsV2 {
  readonly version: 2; readonly enabled: true; readonly configuredGroups: 2;
  readonly registeredWorkers: number; readonly pendingWorkers: number;
  readonly maximumPendingWorkers: number; readonly pendingClassifierGroups: number;
  readonly maximumPendingClassifierGroups: number; readonly unboundReservations: number;
  readonly activeGroups: number; readonly maximumAdmitted: number;
  readonly worker: RuntimeHydrationAdmissionRoleMetricsV1;
  readonly classifier: RuntimeHydrationAdmissionRoleMetricsV1;
}

export function snapshotRuntimeBlockHydrationAdmissionMetricsV2(value: unknown): RuntimeBlockHydrationAdmissionMetricsV2 {
  const record = fields(value, ['version', 'enabled', 'configuredGroups', 'registeredWorkers', 'pendingWorkers',
    'maximumPendingWorkers', 'pendingClassifierGroups', 'maximumPendingClassifierGroups',
    'unboundReservations', 'activeGroups', 'maximumAdmitted', 'worker', 'classifier']);
  if (record.version !== 2 || record.enabled !== true || record.configuredGroups !== 2) throw invalid();
  const registeredWorkers = count(record.registeredWorkers);
  const pendingWorkers = count(record.pendingWorkers);
  const maximumPendingWorkers = count(record.maximumPendingWorkers);
  const pendingClassifierGroups = count(record.pendingClassifierGroups);
  const maximumPendingClassifierGroups = count(record.maximumPendingClassifierGroups);
  const unboundReservations = count(record.unboundReservations);
  const activeGroups = count(record.activeGroups);
  const maximumAdmitted = count(record.maximumAdmitted);
  if (registeredWorkers > 1 || pendingWorkers > registeredWorkers
    || unboundReservations > 2 || activeGroups > 2) throw invalid();
  pair(pendingWorkers, maximumPendingWorkers, 1);
  pair(pendingClassifierGroups, maximumPendingClassifierGroups, 2);
  pair(unboundReservations + activeGroups, maximumAdmitted, 2);
  return Object.freeze({ version: 2, enabled: true, configuredGroups: 2, registeredWorkers, pendingWorkers,
    maximumPendingWorkers, pendingClassifierGroups, maximumPendingClassifierGroups,
    unboundReservations, activeGroups, maximumAdmitted,
    worker: role(record.worker, pendingWorkers), classifier: role(record.classifier, pendingClassifierGroups) });
}

function role(value: unknown, pending: number): RuntimeHydrationAdmissionRoleMetricsV1 {
  const record = fields(value, ['grants', 'cancellations', 'oldestWaitMs', 'lastWaitMs', 'maximumWaitMs']);
  const grants = count(record.grants);
  const cancellations = count(record.cancellations);
  const oldestWaitMs = nullableCount(record.oldestWaitMs);
  const lastWaitMs = nullableCount(record.lastWaitMs);
  const maximumWaitMs = nullableCount(record.maximumWaitMs);
  if ((pending === 0) !== (oldestWaitMs === null)
    || (lastWaitMs === null) !== (maximumWaitMs === null)
    || (grants === 0 && cancellations === 0) !== (lastWaitMs === null)
    || (lastWaitMs !== null && maximumWaitMs !== null && lastWaitMs > maximumWaitMs)) throw invalid();
  return Object.freeze({ grants, cancellations, oldestWaitMs, lastWaitMs, maximumWaitMs });
}

const HYDRATION_COUNTS = [
  'locates', 'hits', 'misses', 'inFlightJoins', 'fetches', 'forcedRefreshes', 'evictions',
  'oversizeBypasses', 'fetchFailures', 'epochInvalidations', 'retainedEntries', 'retainedBytes',
  'inFlightFetches', 'queuedFetches', 'activeGroups', 'maximumActiveGroups', 'queuedGroups',
  'maximumQueuedGroups', 'maximumInFlightFetches', 'maximumQueuedFetches', 'sameGroupJoins',
  'unsettledAfterCancel', 'maximumUnsettledAfterCancel',
] as const;

export function snapshotRuntimeBlockHydrationMetricsV2(value: unknown): RuntimeBlockHydrationMetricsV2 {
  const record = fields(value, ['version', 'enabled', 'configuredGroups', 'queueDelayMs', ...HYDRATION_COUNTS]);
  if (record.version !== 2 || record.enabled !== true || record.configuredGroups !== 2) throw invalid();
  const counts = Object.fromEntries(HYDRATION_COUNTS.map((name) => [name, count(record[name])])) as
    Record<typeof HYDRATION_COUNTS[number], number>;
  pair(counts.activeGroups, counts.maximumActiveGroups, 2);
  pair(counts.queuedGroups, counts.maximumQueuedGroups, 2);
  pair(counts.inFlightFetches, counts.maximumInFlightFetches, 2);
  pair(counts.queuedFetches, counts.maximumQueuedFetches, 2);
  pair(counts.unsettledAfterCancel, counts.maximumUnsettledAfterCancel, 2);
  if (counts.retainedEntries > 64 || counts.retainedBytes > 67_108_864) throw invalid();
  const delay = fields(record.queueDelayMs, ['last', 'maximum']);
  const last = nullableCount(delay.last);
  const maximum = nullableCount(delay.maximum);
  if (last !== null && maximum !== null && last > maximum) throw invalid();
  return Object.freeze({ version: 2, enabled: true, configuredGroups: 2, ...counts,
    queueDelayMs: Object.freeze({ last, maximum }) });
}

export function snapshotRuntimeBlockResponseMemoryMetricsV2(value: unknown): RuntimeBlockResponseMemoryMetricsV2 {
  const record = fields(value, ['version', 'perResponseLimitBytes', 'totalInFlightLimitBytes',
    'activeBodies', 'inFlightBytes', 'maximumInFlightBytes', 'oversizedResponses', 'maximumRssBytes']);
  if (record.version !== 2 || record.perResponseLimitBytes !== 33_554_432
    || record.totalInFlightLimitBytes !== 67_108_864) throw invalid();
  const activeBodies = count(record.activeBodies);
  const inFlightBytes = count(record.inFlightBytes);
  const maximumInFlightBytes = count(record.maximumInFlightBytes);
  if (activeBodies > 2) throw invalid();
  pair(inFlightBytes, maximumInFlightBytes, 67_108_864);
  return Object.freeze({ version: 2, perResponseLimitBytes: 33_554_432, totalInFlightLimitBytes: 67_108_864,
    activeBodies, inFlightBytes, maximumInFlightBytes, oversizedResponses: count(record.oversizedResponses),
    maximumRssBytes: count(record.maximumRssBytes) });
}

export interface RuntimeOrdinaryRpcBudgetMetricsV2 {
  readonly version: 2; readonly enabled: true; readonly windowMs: 1000;
  readonly maxAttemptsPerWindow: 8; readonly maxWaiters: 64;
  readonly startsInWindow: number; readonly maximumStartsInWindow: number;
  readonly queuedWaiters: number; readonly maximumQueuedWaiters: number;
  readonly localRejections: number; readonly closed: boolean;
}

export interface RuntimeTwoGroupHydrationEvidenceV2 {
  readonly blockHydration: RuntimeBlockHydrationMetricsV2;
  readonly blockHydrationAdmission: RuntimeBlockHydrationAdmissionMetricsV2;
  readonly ordinaryRpcBudget: RuntimeOrdinaryRpcBudgetMetricsV2;
  readonly blockResponseMemory: RuntimeBlockResponseMemoryMetricsV2;
}

/** Validate original own descriptors before copying any sidecar. */
export function snapshotRuntimeTwoGroupHydrationEvidenceV2(value: unknown): RuntimeTwoGroupHydrationEvidenceV2 {
  const record = fields(value, ['blockHydration', 'blockHydrationAdmission', 'ordinaryRpcBudget', 'blockResponseMemory']);
  return Object.freeze({
    blockHydration: snapshotRuntimeBlockHydrationMetricsV2(record.blockHydration),
    blockHydrationAdmission: snapshotRuntimeBlockHydrationAdmissionMetricsV2(record.blockHydrationAdmission),
    ordinaryRpcBudget: snapshotRuntimeOrdinaryRpcBudgetMetricsV2(record.ordinaryRpcBudget),
    blockResponseMemory: snapshotRuntimeBlockResponseMemoryMetricsV2(record.blockResponseMemory),
  });
}

/** Lifecycle policy concerns current gauges only; historical observations remain intact. */
export function assertTwoGroupHydrationEvidenceForState(
  value: RuntimeTwoGroupHydrationEvidenceV2,
  state: 'RUNNING' | 'STOPPED' | 'OTHER',
): void {
  const evidence = snapshotRuntimeTwoGroupHydrationEvidenceV2(value);
  if (state === 'RUNNING' && evidence.blockHydrationAdmission.registeredWorkers !== 1) throw invalid();
  if (state !== 'STOPPED') return;
  for (const name of ['activeGroups', 'queuedGroups', 'inFlightFetches', 'queuedFetches',
    'unsettledAfterCancel', 'retainedEntries', 'retainedBytes'] as const) {
    if (evidence.blockHydration[name] !== 0) throw invalid();
  }
  for (const name of ['pendingWorkers', 'pendingClassifierGroups', 'unboundReservations', 'activeGroups'] as const) {
    if (evidence.blockHydrationAdmission[name] !== 0) throw invalid();
  }
  if (evidence.ordinaryRpcBudget.queuedWaiters !== 0 || !evidence.ordinaryRpcBudget.closed
    || evidence.blockResponseMemory.activeBodies !== 0 || evidence.blockResponseMemory.inFlightBytes !== 0) throw invalid();
}

export function snapshotRuntimeOrdinaryRpcBudgetMetricsV2(value: unknown): RuntimeOrdinaryRpcBudgetMetricsV2 {
  const record = fields(value, ['version', 'enabled', 'windowMs', 'maxAttemptsPerWindow', 'maxWaiters',
    'startsInWindow', 'maximumStartsInWindow', 'queuedWaiters', 'maximumQueuedWaiters', 'localRejections', 'closed']);
  if (record.version !== 2 || record.enabled !== true || record.windowMs !== 1000
    || record.maxAttemptsPerWindow !== 8 || record.maxWaiters !== 64 || typeof record.closed !== 'boolean') throw invalid();
  const startsInWindow = count(record.startsInWindow);
  const maximumStartsInWindow = count(record.maximumStartsInWindow);
  const queuedWaiters = count(record.queuedWaiters);
  const maximumQueuedWaiters = count(record.maximumQueuedWaiters);
  pair(startsInWindow, maximumStartsInWindow, 8);
  pair(queuedWaiters, maximumQueuedWaiters, 64);
  return Object.freeze({ version: 2, enabled: true, windowMs: 1000, maxAttemptsPerWindow: 8, maxWaiters: 64,
    startsInWindow, maximumStartsInWindow, queuedWaiters, maximumQueuedWaiters,
    localRejections: count(record.localRejections), closed: record.closed });
}

function pair(current: number, maximum: number, limit: number): void {
  if (current > maximum || maximum > limit) throw invalid();
}
function invalid(): TypeError { return new TypeError('Two-group hydration evidence is invalid.'); }
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw invalid();
  return value;
}
function nullableCount(value: unknown): number | null { return value === null ? null : count(value); }
function fields<const T extends readonly string[]>(value: unknown, names: T): Record<T[number], unknown> {
  if (typeof value !== 'object' || value === null || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key))) throw invalid();
  const result = Object.create(null) as Record<T[number], unknown>;
  for (const name of names) {
    const descriptor = descriptors[name];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
    result[name as T[number]] = descriptor.value as unknown;
  }
  return result;
}
