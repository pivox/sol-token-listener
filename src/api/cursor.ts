export interface LaunchPagePosition {
  readonly detectedAtMs: number;
  readonly mint: string;
}

export const MAX_CURSOR_ENCODED_LENGTH = 2_048;
export const MAX_CURSOR_DECODED_BYTES = 1_536;
export const MAX_CURSOR_TEXT_LENGTH = 256;
export const MAX_CURSOR_SEQUENCE = 9_223_372_036_854_775_807n;
export const MAX_TIMELINE_SLOT = '9'.repeat(78);
export const MAX_TIMELINE_INDEX = 2_147_483_647;

export interface PaperPositionPagePosition {
  readonly openedAtMs: number;
  readonly id: string;
}

export interface TimelinePagePosition {
  readonly slot: string;
  readonly transactionIndex: number;
  readonly instructionIndex: number;
  readonly innerInstructionIndex: number | null;
  readonly id: string;
}

type CursorTuple = readonly (string | number | null)[];

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

export function encodeTimelineCursor(position: TimelinePagePosition): string {
  assertTimelineSlot(position.slot);
  assertIndex(position.transactionIndex, 'transactionIndex');
  assertIndex(position.instructionIndex, 'instructionIndex');
  if (position.innerInstructionIndex !== null) assertIndex(position.innerInstructionIndex, 'innerInstructionIndex');
  assertText(position.id, 'id');
  return encodeTuple(['timeline', 1, position.slot, position.transactionIndex,
    position.instructionIndex, position.innerInstructionIndex, position.id]);
}

export function decodeTimelineCursor(cursor: string): TimelinePagePosition {
  const tuple = decodeTuple(cursor);
  if (tuple.length !== 7 || tuple[0] !== 'timeline' || tuple[1] !== 1) throw new TypeError('Invalid timeline cursor');
  const position: TimelinePagePosition = {
    slot: requireString(tuple[2]), transactionIndex: requireNumber(tuple[3]),
    instructionIndex: requireNumber(tuple[4]),
    innerInstructionIndex: tuple[5] === null ? null : requireNumber(tuple[5]), id: requireString(tuple[6]),
  };
  assertTimelineSlot(position.slot);
  assertIndex(position.transactionIndex, 'transactionIndex');
  assertIndex(position.instructionIndex, 'instructionIndex');
  if (position.innerInstructionIndex !== null) assertIndex(position.innerInstructionIndex, 'innerInstructionIndex');
  assertText(position.id, 'id');
  if (encodeTimelineCursor(position) !== cursor) throw new TypeError('Non-canonical timeline cursor');
  return Object.freeze(position);
}

export function encodeStreamCursor(sequence: bigint): string {
  if (sequence <= 0n || sequence > MAX_CURSOR_SEQUENCE) {
    throw new TypeError('Stream sequence is outside the supported range');
  }
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
  if (
    sequence <= 0n
    || sequence > MAX_CURSOR_SEQUENCE
    || sequence.toString() !== tuple[2]
    || encodeStreamCursor(sequence) !== cursor
  ) {
    throw new TypeError('Non-canonical events cursor');
  }
  return sequence;
}

function encodeTuple(tuple: CursorTuple): string {
  const encoded = Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
  if (encoded.length > MAX_CURSOR_ENCODED_LENGTH) throw new TypeError('Cursor encoding is too large');
  return encoded;
}

function decodeTuple(cursor: string): readonly unknown[] {
  if (cursor.length > MAX_CURSOR_ENCODED_LENGTH) throw new TypeError('Cursor encoding is too large');
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new TypeError('Invalid cursor encoding');
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.length > MAX_CURSOR_DECODED_BYTES) throw new TypeError('Cursor payload is too large');
  const decoded = bytes.toString('utf8');
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
  if (value.length === 0 || value.length > MAX_CURSOR_TEXT_LENGTH) {
    throw new TypeError(`Invalid ${field}`);
  }
}

function assertIndex(value: number, field: string): void {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > MAX_TIMELINE_INDEX
    || Object.is(value, -0)
  ) throw new TypeError(`Invalid ${field}`);
}

function assertTimelineSlot(value: string): void {
  if (
    !/^(?:0|[1-9]\d*)$/u.test(value)
    || value.length > MAX_TIMELINE_SLOT.length
  ) throw new TypeError('Invalid slot');
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Invalid timeline cursor');
  return value;
}

function requireNumber(value: unknown): number {
  if (typeof value !== 'number') throw new TypeError('Invalid timeline cursor');
  return value;
}
