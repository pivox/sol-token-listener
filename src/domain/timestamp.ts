export type TimestampField =
  | 'observedAtMs'
  | 'blockchainTimeMs'
  | 'occurredAtMs'
  | 'evaluatedAtMs'
  | 'pendingExitTriggerAtMs';

export class InvalidTimestampError extends Error {
  public constructor(
    public readonly field: TimestampField,
    public readonly value: unknown,
  ) {
    super(`Invalid ${field} timestamp: ${formatTimestampValue(value)}`);
    this.name = 'InvalidTimestampError';
  }
}

export function assertValidTimestampMs(
  field: TimestampField,
  value: unknown,
): asserts value is number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || !Number.isSafeInteger(value)
    || value < 0
    || Object.is(value, -0)
  ) {
    throw new InvalidTimestampError(field, value);
  }
}

export function assertValidNullableTimestampMs(
  field: TimestampField,
  value: unknown,
): asserts value is number | null {
  if (value === null) return;
  assertValidTimestampMs(field, value);
}

function formatTimestampValue(value: unknown): string {
  if (typeof value === 'number' && Object.is(value, -0)) return '-0';
  return String(value);
}
