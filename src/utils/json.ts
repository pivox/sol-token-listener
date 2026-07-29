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
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === BIGINT_JSON_MARKER;
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
  const original = value[BIGINT_JSON_MARKER];
  Object.defineProperty(value, BIGINT_JSON_MARKER, {
    value: original,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  Object.freeze(value);
  trustedBigIntMarkers.set(value, original);
  return value;
}

function isTrustedBigIntMarker(value: object): boolean {
  const original = trustedBigIntMarkers.get(value);
  if (original === undefined || !isReservedBigIntMarker(value)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, BIGINT_JSON_MARKER);
  if (descriptor === undefined) return false;
  return descriptor.value === original
    && descriptor.enumerable === true
    && descriptor.writable === false
    && descriptor.configurable === false;
}
