import { types } from 'node:util';
import {
  FINALITY_RECONCILER_DIAGNOSTIC_REASONS,
  createFinalityReconcilerDiagnostic,
  saturatingDiagnosticIncrement,
  type FinalityReconcilerDiagnosticReason,
  type FinalityReconcilerDiagnosticV1,
} from '../domain/finality-reconciler-diagnostic.js';

export interface FinalityDiagnosticTrackerState {
  readonly degradedAtMs: number | null;
  readonly lastObservedAtMs: number | null;
  readonly consecutiveFailures: number;
  readonly suppressedFailures: number;
  readonly cadencePosition: number;
  readonly latestReasonCode: FinalityReconcilerDiagnosticReason | null;
}

export interface FinalityDiagnosticReduction {
  readonly state: FinalityDiagnosticTrackerState;
  readonly diagnostic: FinalityReconcilerDiagnosticV1 | null;
}

const TRACKER_FIELDS = Object.freeze([
  'degradedAtMs',
  'lastObservedAtMs',
  'consecutiveFailures',
  'suppressedFailures',
  'cadencePosition',
  'latestReasonCode',
] as const);

type TrackerField = (typeof TRACKER_FIELDS)[number];

export function createFinalityDiagnosticTrackerState(
  seed?: unknown,
): FinalityDiagnosticTrackerState {
  if (seed === undefined) return emptyState();
  const fields = readExactTrackerFields(seed);
  const degradedAtMs = optionalTime(fields.degradedAtMs);
  const lastObservedAtMs = optionalTime(fields.lastObservedAtMs);
  const consecutiveFailures = counter(fields.consecutiveFailures);
  const suppressedFailures = counter(fields.suppressedFailures);
  const cadencePosition = fields.cadencePosition;
  const latestReasonCode = optionalReason(fields.latestReasonCode);

  if (!Number.isSafeInteger(cadencePosition)
    || typeof cadencePosition !== 'number'
    || cadencePosition < 0
    || cadencePosition > 11
    || Object.is(cadencePosition, -0)) {
    invalidState();
  }
  const inactive = degradedAtMs === null
    && lastObservedAtMs === null
    && consecutiveFailures === 0
    && suppressedFailures === 0
    && cadencePosition === 0
    && latestReasonCode === null;
  const active = degradedAtMs !== null
    && lastObservedAtMs !== null
    && lastObservedAtMs >= degradedAtMs
    && consecutiveFailures >= 1
    && suppressedFailures <= consecutiveFailures
    && latestReasonCode !== null;
  if (!inactive && !active) invalidState();

  return Object.freeze({
    degradedAtMs,
    lastObservedAtMs,
    consecutiveFailures,
    suppressedFailures,
    cadencePosition,
    latestReasonCode,
  });
}

export function recordFinalityDiagnosticFailure(
  state: FinalityDiagnosticTrackerState,
  reasonCode: FinalityReconcilerDiagnosticReason,
  observedAtMs: number,
): FinalityDiagnosticReduction {
  const current = createFinalityDiagnosticTrackerState(state);
  if (!isReason(reasonCode) || !isTime(observedAtMs)) invalidState();
  const acceptedAtMs = current.lastObservedAtMs === null
    ? observedAtMs
    : Math.max(current.lastObservedAtMs, observedAtMs);

  if (current.degradedAtMs === null) {
    const next = freezeState({
      degradedAtMs: acceptedAtMs,
      lastObservedAtMs: acceptedAtMs,
      consecutiveFailures: 1,
      suppressedFailures: 0,
      cadencePosition: 1,
      latestReasonCode: reasonCode,
    });
    return reduction(next, degradedDiagnostic(next));
  }

  const cadencePosition = current.cadencePosition === 11
    ? 0
    : current.cadencePosition + 1;
  const emitsSummary = cadencePosition === 0;
  const next = freezeState({
    degradedAtMs: current.degradedAtMs,
    lastObservedAtMs: acceptedAtMs,
    consecutiveFailures: saturatingDiagnosticIncrement(current.consecutiveFailures),
    suppressedFailures: emitsSummary
      ? current.suppressedFailures
      : saturatingDiagnosticIncrement(current.suppressedFailures),
    cadencePosition,
    latestReasonCode: reasonCode,
  });
  return reduction(next, emitsSummary ? degradedDiagnostic(next) : null);
}

export function recordFinalityDiagnosticRecovery(
  state: FinalityDiagnosticTrackerState,
  observedAtMs: number,
): FinalityDiagnosticReduction {
  const current = createFinalityDiagnosticTrackerState(state);
  if (!isTime(observedAtMs)) invalidState();
  if (current.degradedAtMs === null || current.lastObservedAtMs === null) {
    return reduction(emptyState(), null);
  }
  const acceptedAtMs = Math.max(current.lastObservedAtMs, observedAtMs);
  const diagnostic = createFinalityReconcilerDiagnostic({
    version: 1,
    phase: 'RECOVERED',
    reasonCode: null,
    degradedAtMs: current.degradedAtMs,
    observedAtMs: acceptedAtMs,
    durationMs: acceptedAtMs - current.degradedAtMs,
    consecutiveFailures: current.consecutiveFailures,
    suppressedFailures: current.suppressedFailures,
  });
  return reduction(emptyState(), diagnostic);
}

function degradedDiagnostic(
  state: FinalityDiagnosticTrackerState,
): FinalityReconcilerDiagnosticV1 {
  if (state.degradedAtMs === null
    || state.lastObservedAtMs === null
    || state.latestReasonCode === null) {
    invalidState();
  }
  return createFinalityReconcilerDiagnostic({
    version: 1,
    phase: 'DEGRADED',
    reasonCode: state.latestReasonCode,
    degradedAtMs: state.degradedAtMs,
    observedAtMs: state.lastObservedAtMs,
    durationMs: state.lastObservedAtMs - state.degradedAtMs,
    consecutiveFailures: state.consecutiveFailures,
    suppressedFailures: state.suppressedFailures,
  });
}

function reduction(
  state: FinalityDiagnosticTrackerState,
  diagnostic: FinalityReconcilerDiagnosticV1 | null,
): FinalityDiagnosticReduction {
  return Object.freeze({ state, diagnostic });
}

function emptyState(): FinalityDiagnosticTrackerState {
  return Object.freeze({
    degradedAtMs: null,
    lastObservedAtMs: null,
    consecutiveFailures: 0,
    suppressedFailures: 0,
    cadencePosition: 0,
    latestReasonCode: null,
  });
}

function freezeState(state: FinalityDiagnosticTrackerState): FinalityDiagnosticTrackerState {
  return Object.freeze({ ...state });
}

function readExactTrackerFields(input: unknown): Record<TrackerField, unknown> {
  try {
    if (typeof input !== 'object'
      || input === null
      || Array.isArray(input)
      || types.isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype) {
      invalidState();
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== TRACKER_FIELDS.length
      || keys.some((key) => typeof key !== 'string'
        || !TRACKER_FIELDS.includes(key as TrackerField))) {
      invalidState();
    }
    const fields = {} as Record<TrackerField, unknown>;
    for (const field of TRACKER_FIELDS) {
      const descriptor = descriptors[field];
      if (descriptor === undefined
        || !('value' in descriptor)
        || descriptor.enumerable !== true) {
        invalidState();
      }
      fields[field] = descriptor.value;
    }
    return fields;
  } catch {
    invalidState();
  }
}

function optionalTime(value: unknown): number | null {
  if (value === null) return null;
  if (!isTime(value)) invalidState();
  return value;
}

function counter(value: unknown): number {
  if (!isTime(value)) invalidState();
  return value;
}

function optionalReason(value: unknown): FinalityReconcilerDiagnosticReason | null {
  if (value === null) return null;
  if (!isReason(value)) invalidState();
  return value;
}

function isReason(value: unknown): value is FinalityReconcilerDiagnosticReason {
  return FINALITY_RECONCILER_DIAGNOSTIC_REASONS.some((reason) => reason === value);
}

function isTime(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0);
}

function invalidState(): never {
  throw new TypeError('Invalid finality diagnostic tracker state.');
}
