import { isProxy } from 'node:util/types';

export interface RuntimeHydrationAdmissionRoleMetricsV1 {
  readonly grants: number;
  readonly cancellations: number;
  readonly oldestWaitMs: number | null;
  readonly lastWaitMs: number | null;
  readonly maximumWaitMs: number | null;
}

export interface RuntimeBlockHydrationAdmissionMetricsV1 {
  readonly version: 1;
  readonly enabled: boolean;
  readonly registeredWorkers: number;
  readonly pendingWorkers: number;
  readonly maximumPendingWorkers: number;
  readonly pendingClassifierGroups: number;
  readonly maximumPendingClassifierGroups: number;
  readonly unboundReservations: number;
  readonly activeGroups: number;
  readonly maximumAdmitted: number;
  readonly worker: RuntimeHydrationAdmissionRoleMetricsV1;
  readonly classifier: RuntimeHydrationAdmissionRoleMetricsV1;
}

const FIELDS = [
  'version', 'enabled', 'registeredWorkers', 'pendingWorkers', 'maximumPendingWorkers',
  'pendingClassifierGroups', 'maximumPendingClassifierGroups', 'unboundReservations',
  'activeGroups', 'maximumAdmitted', 'worker', 'classifier',
] as const;
const ROLE_FIELDS = ['grants', 'cancellations', 'oldestWaitMs', 'lastWaitMs', 'maximumWaitMs'] as const;

/** Accept persisted JSON or runtime metrics without retaining caller-owned graphs. */
export function snapshotRuntimeBlockHydrationAdmissionMetrics(
  value: unknown,
): RuntimeBlockHydrationAdmissionMetricsV1 {
  const record = fields(value, FIELDS);
  if (record.version !== 1 || typeof record.enabled !== 'boolean') throw invalid();
  const registeredWorkers = count(record.registeredWorkers);
  const pendingWorkers = count(record.pendingWorkers);
  const maximumPendingWorkers = count(record.maximumPendingWorkers);
  const pendingClassifierGroups = count(record.pendingClassifierGroups);
  const maximumPendingClassifierGroups = count(record.maximumPendingClassifierGroups);
  const unboundReservations = count(record.unboundReservations);
  const activeGroups = count(record.activeGroups);
  const maximumAdmitted = count(record.maximumAdmitted);
  if (pendingWorkers > registeredWorkers || pendingWorkers > maximumPendingWorkers
    || pendingClassifierGroups > maximumPendingClassifierGroups || maximumPendingClassifierGroups > 1
    || unboundReservations > 1 || activeGroups > 1 || maximumAdmitted > 1
    || unboundReservations + activeGroups > maximumAdmitted) throw invalid();
  return Object.freeze({
    version: 1, enabled: record.enabled, registeredWorkers, pendingWorkers, maximumPendingWorkers,
    pendingClassifierGroups, maximumPendingClassifierGroups, unboundReservations,
    activeGroups, maximumAdmitted,
    worker: role(record.worker, pendingWorkers),
    classifier: role(record.classifier, pendingClassifierGroups),
  });
}

function role(value: unknown, pending: number): RuntimeHydrationAdmissionRoleMetricsV1 {
  const record = fields(value, ROLE_FIELDS);
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

function fields<const T extends readonly string[]>(value: unknown, names: T): Record<T[number], unknown> {
  if (typeof value !== 'object' || value === null || isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key))) throw invalid();
  const result = Object.create(null) as Record<T[number], unknown>;
  for (const name of names) {
    const descriptor = descriptors[name];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) throw invalid();
    result[name as T[number]] = descriptor.value as unknown;
  }
  return result;
}

function nullableCount(value: unknown): number | null { return value === null ? null : count(value); }
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw invalid();
  return value;
}
function invalid(): TypeError { return new TypeError('Runtime block hydration admission metrics are invalid.'); }
