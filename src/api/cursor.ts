export interface LaunchPagePosition {
  readonly detectedAtMs: number;
  readonly mint: string;
}

export interface PaperPositionPagePosition {
  readonly openedAtMs: number;
  readonly id: string;
}

type CursorTuple = readonly [string, number, number | string, string?];

export function encodeLaunchCursor(position: LaunchPagePosition): string {
  assertTimestamp(position.detectedAtMs, 'detectedAtMs');
  assertText(position.mint, 'mint');
  return encodeTuple(['launches', 1, position.detectedAtMs, position.mint]);
}

export function decodeLaunchCursor(cursor: string): LaunchPagePosition {
  const tuple = decodeTuple(cursor);
  if (tuple.length !== 4 || tuple[0] !== 'launches' || tuple[1] !== 1) {
    throw new TypeError('Invalid launches cursor');
  }
  const detectedAtMs = tuple[2];
  const mint = tuple[3];
  if (typeof detectedAtMs !== 'number' || typeof mint !== 'string') {
    throw new TypeError('Invalid launches cursor');
  }
  const position: LaunchPagePosition = { detectedAtMs, mint };
  assertTimestamp(position.detectedAtMs, 'detectedAtMs');
  assertText(position.mint, 'mint');
  if (encodeLaunchCursor(position) !== cursor) throw new TypeError('Non-canonical launches cursor');
  return Object.freeze(position);
}

export function encodePaperPositionCursor(position: PaperPositionPagePosition): string {
  assertTimestamp(position.openedAtMs, 'openedAtMs');
  assertText(position.id, 'id');
  return encodeTuple(['paper_positions', 1, position.openedAtMs, position.id]);
}

export function decodePaperPositionCursor(cursor: string): PaperPositionPagePosition {
  const tuple = decodeTuple(cursor);
  if (tuple.length !== 4 || tuple[0] !== 'paper_positions' || tuple[1] !== 1) {
    throw new TypeError('Invalid paper positions cursor');
  }
  const openedAtMs = tuple[2];
  const id = tuple[3];
  if (typeof openedAtMs !== 'number' || typeof id !== 'string') {
    throw new TypeError('Invalid paper positions cursor');
  }
  const position: PaperPositionPagePosition = { openedAtMs, id };
  assertTimestamp(position.openedAtMs, 'openedAtMs');
  assertText(position.id, 'id');
  if (encodePaperPositionCursor(position) !== cursor) {
    throw new TypeError('Non-canonical paper positions cursor');
  }
  return Object.freeze(position);
}

export function encodeStreamCursor(sequence: bigint): string {
  if (sequence <= 0n) throw new TypeError('Stream sequence must be positive');
  return encodeTuple(['events', 1, sequence.toString()]);
}

export function decodeStreamCursor(cursor: string): bigint {
  const tuple = decodeTuple(cursor);
  if (tuple.length !== 3 || tuple[0] !== 'events' || tuple[1] !== 1 || typeof tuple[2] !== 'string') {
    throw new TypeError('Invalid events cursor');
  }
  let sequence: bigint;
  try {
    sequence = BigInt(tuple[2]);
  } catch {
    throw new TypeError('Invalid events cursor');
  }
  if (sequence <= 0n || sequence.toString() !== tuple[2] || encodeStreamCursor(sequence) !== cursor) {
    throw new TypeError('Non-canonical events cursor');
  }
  return sequence;
}

function encodeTuple(tuple: CursorTuple): string {
  return Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
}

function decodeTuple(cursor: string): readonly unknown[] {
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new TypeError('Invalid cursor encoding');
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  let value: unknown;
  try {
    value = JSON.parse(decoded) as unknown;
  } catch {
    throw new TypeError('Invalid cursor JSON');
  }
  if (!Array.isArray(value)) throw new TypeError('Invalid cursor JSON');
  return value;
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`Invalid ${field}`);
  }
}

function assertText(value: string, field: string): void {
  if (value.length === 0) throw new TypeError(`Invalid ${field}`);
}
