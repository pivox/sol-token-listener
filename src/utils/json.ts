export const BIGINT_JSON_MARKER = '$solTokenListenerBigInt';
export const MAX_SERIALIZED_BIGINT_DIGITS = 78;

const RESERVED_MARKER_MESSAGE =
  'The $solTokenListenerBigInt singleton object is reserved for bigint serialization.';
const OVERSIZED_BIGINT_MESSAGE = 'Serialized bigint exceeds 78 decimal digits.';
const trustedBigIntMarkers = new WeakMap<object, string>();

export function stringifyJson(value: unknown): string {
  rejectReservedBigIntMarkers(value, new Set<object>());
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (isReservedBigIntMarker(nested) && !isTrustedBigIntMarker(nested)) {
      throw new TypeError(RESERVED_MARKER_MESSAGE);
    }
    if (typeof nested === 'bigint') {
      const decimal = nested.toString();
      if (decimal.replace(/^-/, '').length > MAX_SERIALIZED_BIGINT_DIGITS) {
        throw new RangeError(OVERSIZED_BIGINT_MESSAGE);
      }
      return trustBigIntMarker({ [BIGINT_JSON_MARKER]: decimal });
    }
    return nested;
  });
}

export function parseJson(value: string): unknown {
  return JSON.parse(value, (_key, nested: unknown) => {
    if (!isBigIntMarker(nested)) return nested;
    return BigInt(nested[BIGINT_JSON_MARKER]);
  }) as unknown;
}

export function toJsonValue(value: unknown): unknown {
  const encoded = JSON.parse(stringifyJson(value)) as unknown;
  markEncodedBigIntMarkers(encoded);
  return encoded;
}

export function fromJsonValue(value: unknown): unknown {
  return parseJson(JSON.stringify(value));
}

function rejectReservedBigIntMarkers(value: unknown, ancestors: Set<object>): void {
  if (typeof value !== 'object' || value === null) return;
  if (ancestors.has(value)) return;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) rejectReservedBigIntMarkers(item, ancestors);
      return;
    }
    if (isReservedBigIntMarker(value) && !isTrustedBigIntMarker(value)) {
      throw new TypeError(RESERVED_MARKER_MESSAGE);
    }
    for (const nested of Object.values(value)) rejectReservedBigIntMarkers(nested, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function isReservedBigIntMarker(
  value: unknown,
): value is Record<typeof BIGINT_JSON_MARKER, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === 1 && entries[0]?.[0] === BIGINT_JSON_MARKER;
}

function isBigIntMarker(value: unknown): value is Record<typeof BIGINT_JSON_MARKER, string> {
  if (!isReservedBigIntMarker(value)) return false;
  const encoded = value[BIGINT_JSON_MARKER];
  return typeof encoded === 'string'
    && /^(?:0|-?[1-9]\d*)$/u.test(encoded)
    && encoded.replace(/^-/, '').length <= MAX_SERIALIZED_BIGINT_DIGITS;
}

function markEncodedBigIntMarkers(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  if (isBigIntMarker(value)) {
    trustBigIntMarker(value);
    return;
  }
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    markEncodedBigIntMarkers(nested);
  }
}

function trustBigIntMarker<T extends Record<typeof BIGINT_JSON_MARKER, string>>(value: T): T {
  trustedBigIntMarkers.set(value, value[BIGINT_JSON_MARKER]);
  return value;
}

function isTrustedBigIntMarker(value: object): boolean {
  if (!isBigIntMarker(value)) return false;
  return trustedBigIntMarkers.get(value) === value[BIGINT_JSON_MARKER];
}
