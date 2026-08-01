export const BIGINT_JSON_MARKER = '$solTokenListenerBigInt';
export const MAX_SERIALIZED_BIGINT_DIGITS = 78;
export const MAX_CANONICAL_JSON_DEPTH = 64;
export const MAX_CANONICAL_JSON_NODES = 10_000;
export const MAX_CANONICAL_JSON_STRING_BYTES = 16_384;
export const MAX_CANONICAL_JSON_TEXT_BYTES = 1_048_576;

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

export function canonicalStringifyJson(value: unknown): string {
  const state = { nodes: 0, textBytes: 0, ancestors: new WeakSet() };
  const serialized = stringifyJson(canonicalJsonValue(value, 0, state));
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CANONICAL_JSON_TEXT_BYTES) {
    throw new RangeError('Canonical JSON exceeds serialized limit.');
  }
  return serialized;
}

function canonicalJsonValue(
  value: unknown,
  depth: number,
  state: { nodes: number; textBytes: number; ancestors: WeakSet<object> },
): unknown {
  if (depth > MAX_CANONICAL_JSON_DEPTH || ++state.nodes > MAX_CANONICAL_JSON_NODES) {
    throw new RangeError('Canonical JSON exceeds structural limits.');
  }
  if (typeof value === 'string') {
    accountCanonicalText(value, state);
    return value;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError('Canonical JSON number is invalid.');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('Canonical JSON value is invalid.');
  if (state.ancestors.has(value)) throw new TypeError('Canonical JSON must be acyclic.');
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key === 'symbol')) throw new TypeError('Canonical JSON symbols are forbidden.');
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        accountCanonicalText(String(index), state);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Canonical JSON array is invalid.');
        result.push(canonicalJsonValue(descriptor.value, depth + 1, state));
      }
      if (keys.length !== value.length + 1) throw new TypeError('Canonical JSON array keys are invalid.');
      return result;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Canonical JSON object prototype is invalid.');
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) throw new TypeError('Canonical JSON symbols are forbidden.');
    for (const key of keys as string[]) accountCanonicalText(key, state);
    if (isTrustedBigIntMarker(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, BIGINT_JSON_MARKER);
      if (descriptor === undefined || !('value' in descriptor)) throw new TypeError('Canonical JSON property is invalid.');
      canonicalJsonValue(descriptor.value, depth + 1, state);
      return value;
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Canonical JSON property is invalid.');
      result[key] = canonicalJsonValue(descriptor.value, depth + 1, state);
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function accountCanonicalText(
  value: string,
  state: { textBytes: number },
): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (
    bytes > MAX_CANONICAL_JSON_STRING_BYTES
    || state.textBytes + bytes > MAX_CANONICAL_JSON_TEXT_BYTES
  ) throw new RangeError('Canonical JSON exceeds text limits.');
  state.textBytes += bytes;
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
