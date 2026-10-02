import { isProxy } from 'node:util/types';
import {
  MAX_PUMPFUN_TRACKING_WINDOW_SECONDS,
  MIN_PUMPFUN_TRACKING_WINDOW_SECONDS,
} from './worker-admission.js';

const WORKER_ADMISSION_METRICS_KEYS = Object.freeze([
  'version',
  'enabled',
  'trackingWindowSeconds',
  'claimableBacklogCount',
  'classificationPendingCount',
  'oldestClassificationPendingAgeMs',
  'freshMintCount',
  'extendedMintCount',
  'demotedCount',
] as const);
const WORKER_ADMISSION_METRICS_KEY_SET: ReadonlySet<string> = new Set(
  WORKER_ADMISSION_METRICS_KEYS,
);

export interface RuntimeWorkerAdmissionMetricsV1 {
  readonly version: 1;
  readonly enabled: boolean;
  readonly trackingWindowSeconds: number;
  readonly claimableBacklogCount: number;
  readonly classificationPendingCount: number;
  readonly oldestClassificationPendingAgeMs: number | null;
  readonly freshMintCount: number;
  readonly extendedMintCount: number;
  readonly demotedCount: number;
}

export interface RuntimeWorkerAdmissionClockV1 {
  readonly version: 1;
  readonly sampledAtMs: number;
}

export function snapshotRuntimeWorkerAdmissionClock(value: unknown): RuntimeWorkerAdmissionClockV1 {
  const invalidClock = (): TypeError => new TypeError('Runtime worker admission clock is invalid.');
  try {
    if (typeof value !== 'object' || value === null || isProxy(value)
      || Array.isArray(value) || !Object.isFrozen(value)) throw invalidClock();
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidClock();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('version') || !keys.includes('sampledAtMs')) {
      throw invalidClock();
    }
    const version = Object.getOwnPropertyDescriptor(value, 'version');
    const sampledAt = Object.getOwnPropertyDescriptor(value, 'sampledAtMs');
    if (version === undefined || !version.enumerable || !('value' in version)
      || version.value !== 1 || sampledAt === undefined || !sampledAt.enumerable
      || !('value' in sampledAt)) throw invalidClock();
    const sampledAtMs = integer(sampledAt.value, 1, 8_640_000_000_000_000);
    return Object.freeze({ version: 1, sampledAtMs });
  } catch {
    throw invalidClock();
  }
}

export function snapshotRuntimeWorkerAdmissionMetrics(
  value: unknown,
): RuntimeWorkerAdmissionMetricsV1 {
  try {
    const record = exactFrozenRecord(value);
    if (record.version !== 1 || typeof record.enabled !== 'boolean') throw invalid();
    const trackingWindowSeconds = integer(
      record.trackingWindowSeconds,
      MIN_PUMPFUN_TRACKING_WINDOW_SECONDS,
      MAX_PUMPFUN_TRACKING_WINDOW_SECONDS,
    );
    const claimableBacklogCount = integer(record.claimableBacklogCount);
    const classificationPendingCount = integer(record.classificationPendingCount);
    const oldestClassificationPendingAgeMs = record.oldestClassificationPendingAgeMs === null
      ? null
      : integer(record.oldestClassificationPendingAgeMs);
    const freshMintCount = integer(record.freshMintCount);
    const extendedMintCount = integer(record.extendedMintCount);
    const demotedCount = integer(record.demotedCount);

    if ((classificationPendingCount === 0) !== (oldestClassificationPendingAgeMs === null)) {
      throw invalid();
    }
    if (!record.enabled && (
      classificationPendingCount !== 0
      || oldestClassificationPendingAgeMs !== null
      || freshMintCount !== 0
      || extendedMintCount !== 0
      || demotedCount !== 0
    )) {
      throw invalid();
    }

    return Object.freeze({
      version: 1,
      enabled: record.enabled,
      trackingWindowSeconds,
      claimableBacklogCount,
      classificationPendingCount,
      oldestClassificationPendingAgeMs,
      freshMintCount,
      extendedMintCount,
      demotedCount,
    });
  } catch {
    throw invalid();
  }
}

function exactFrozenRecord(
  value: unknown,
): Readonly<Record<(typeof WORKER_ADMISSION_METRICS_KEYS)[number], unknown>> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || isProxy(value)
    || !Object.isFrozen(value)
  ) {
    throw invalid();
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== WORKER_ADMISSION_METRICS_KEYS.length
    || ownKeys.some((key) => (
      typeof key !== 'string' || !WORKER_ADMISSION_METRICS_KEY_SET.has(key)
    ))
  ) {
    throw invalid();
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of WORKER_ADMISSION_METRICS_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw invalid();
    }
    record[key] = descriptor.value;
  }
  return record as Readonly<Record<(typeof WORKER_ADMISSION_METRICS_KEYS)[number], unknown>>;
}

function integer(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < minimum
    || value > maximum
  ) {
    throw invalid();
  }
  return value;
}

function invalid(): TypeError {
  return new TypeError('Runtime worker admission metrics are invalid.');
}
