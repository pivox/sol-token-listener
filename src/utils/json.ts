const BIGINT_MARKER = '$solTokenListenerBigInt';

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (typeof nested === 'bigint') return { [BIGINT_MARKER]: nested.toString() };
    return nested;
  });
}

export function parseJson(value: string): unknown {
  return JSON.parse(value, (_key, nested: unknown) => {
    if (!isBigIntMarker(nested)) return nested;
    return BigInt(nested[BIGINT_MARKER]);
  }) as unknown;
}

export function toJsonValue(value: unknown): unknown {
  return JSON.parse(stringifyJson(value)) as unknown;
}

export function fromJsonValue(value: unknown): unknown {
  return parseJson(JSON.stringify(value));
}

function isBigIntMarker(value: unknown): value is Record<typeof BIGINT_MARKER, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === 1
    && entries[0]?.[0] === BIGINT_MARKER
    && typeof entries[0][1] === 'string'
    && /^-?\d+$/u.test(entries[0][1]);
}
