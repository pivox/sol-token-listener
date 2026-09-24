import { types } from 'node:util';

export const FINALITY_RECONCILER_DIAGNOSTIC_REASONS = Object.freeze([
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_CHANGED',
  'FINALITY_LIST',
  'FINALITY_PASS',
  'FINALITY_HISTORY',
  'FINALITY_ROOT',
  'FINALITY_POLL',
  'FINALITY_BLOCK',
  'FINALITY_REVISION',
  'FINALITY_CLOCK',
  'FINALITY_CONTRADICTION',
  'UNKNOWN',
] as const);

export type FinalityReconcilerDiagnosticReason =
  (typeof FINALITY_RECONCILER_DIAGNOSTIC_REASONS)[number];

export interface FinalityReconcilerDiagnosticV1 {
  readonly version: 1;
  readonly phase: 'DEGRADED' | 'RECOVERED';
  readonly reasonCode: FinalityReconcilerDiagnosticReason | null;
  readonly degradedAtMs: number;
  readonly observedAtMs: number;
  readonly durationMs: number;
  readonly consecutiveFailures: number;
  readonly suppressedFailures: number;
}

const DIAGNOSTIC_FIELDS = Object.freeze([
  'version',
  'phase',
  'reasonCode',
  'degradedAtMs',
  'observedAtMs',
  'durationMs',
  'consecutiveFailures',
  'suppressedFailures',
] as const);

type DiagnosticField = (typeof DIAGNOSTIC_FIELDS)[number];

export function createFinalityReconcilerDiagnostic(
  input: unknown,
): FinalityReconcilerDiagnosticV1 {
  const fields = readExactFields(input);
  if (fields.version !== 1
    || !isPhase(fields.phase)
    || !isSafeNonNegativeInteger(fields.degradedAtMs)
    || !isSafeNonNegativeInteger(fields.observedAtMs)
    || !isSafeNonNegativeInteger(fields.durationMs)
    || !isSafeNonNegativeInteger(fields.consecutiveFailures)
    || !isSafeNonNegativeInteger(fields.suppressedFailures)
    || fields.consecutiveFailures < 1
    || fields.suppressedFailures > fields.consecutiveFailures
    || !isReachableSuppressionCount(
      fields.consecutiveFailures,
      fields.suppressedFailures,
    )
    || fields.observedAtMs < fields.degradedAtMs
    || fields.durationMs !== fields.observedAtMs - fields.degradedAtMs) {
    invalid();
  }
  let reasonCode: FinalityReconcilerDiagnosticReason | null;
  if (fields.phase === 'DEGRADED') {
    if (!isReason(fields.reasonCode)) invalid();
    reasonCode = fields.reasonCode;
  } else {
    if (fields.reasonCode !== null) invalid();
    reasonCode = null;
  }

  return Object.freeze({
    version: 1,
    phase: fields.phase,
    reasonCode,
    degradedAtMs: fields.degradedAtMs,
    observedAtMs: fields.observedAtMs,
    durationMs: fields.durationMs,
    consecutiveFailures: fields.consecutiveFailures,
    suppressedFailures: fields.suppressedFailures,
  });
}

export function saturatingDiagnosticIncrement(value: number): number {
  if (!isSafeNonNegativeInteger(value)) invalid();
  return value === Number.MAX_SAFE_INTEGER ? value : value + 1;
}

function readExactFields(input: unknown): Record<DiagnosticField, unknown> {
  try {
    if (typeof input !== 'object'
      || input === null
      || Array.isArray(input)
      || types.isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype) {
      invalid();
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== DIAGNOSTIC_FIELDS.length
      || keys.some((key) => typeof key !== 'string'
        || !DIAGNOSTIC_FIELDS.includes(key as DiagnosticField))) {
      invalid();
    }

    const fields = {} as Record<DiagnosticField, unknown>;
    for (const field of DIAGNOSTIC_FIELDS) {
      const descriptor = descriptors[field];
      if (descriptor === undefined
        || !('value' in descriptor)
        || descriptor.enumerable !== true) {
        invalid();
      }
      fields[field] = descriptor.value;
    }
    return fields;
  } catch {
    invalid();
  }
}

function isPhase(value: unknown): value is FinalityReconcilerDiagnosticV1['phase'] {
  return value === 'DEGRADED' || value === 'RECOVERED';
}

function isReason(value: unknown): value is FinalityReconcilerDiagnosticReason {
  return FINALITY_RECONCILER_DIAGNOSTIC_REASONS.some((reason) => reason === value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0);
}

function isReachableSuppressionCount(
  consecutiveFailures: number,
  suppressedFailures: number,
): boolean {
  const firstSaturatedSuppressionCount = consecutiveFailures
    - 1
    - Math.floor(consecutiveFailures / 12);
  return consecutiveFailures === Number.MAX_SAFE_INTEGER
    ? suppressedFailures >= firstSaturatedSuppressionCount
    : suppressedFailures === firstSaturatedSuppressionCount;
}

function invalid(): never {
  throw new TypeError('Invalid finality reconciler diagnostic.');
}
