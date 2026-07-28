import type { ChainCursor } from './types.js';

export type ChainCursorField =
  | 'slot'
  | 'transactionIndex'
  | 'instructionIndex'
  | 'innerInstructionIndex';

export class InvalidChainCursorError extends Error {
  public constructor(
    public readonly field: ChainCursorField,
    public readonly value: unknown,
  ) {
    super(`Invalid chain cursor ${field}: ${formatCursorValue(value)}`);
    this.name = 'InvalidChainCursorError';
  }
}

export function assertValidTransactionCursor(
  cursor: Pick<ChainCursor, 'slot' | 'transactionIndex'>,
): void {
  if (typeof cursor.slot !== 'bigint' || cursor.slot < 0n) {
    throw new InvalidChainCursorError('slot', cursor.slot);
  }
  assertValidCursorIndex('transactionIndex', cursor.transactionIndex);
}

export function assertValidChainCursor(cursor: ChainCursor): void {
  assertValidTransactionCursor(cursor);
  assertValidCursorIndex('instructionIndex', cursor.instructionIndex);
  if (cursor.innerInstructionIndex !== null) {
    assertValidCursorIndex('innerInstructionIndex', cursor.innerInstructionIndex);
  }
}

export function compareCursors(left: ChainCursor, right: ChainCursor): -1 | 0 | 1 {
  assertValidChainCursor(left);
  assertValidChainCursor(right);

  const slot = compareBigInt(left.slot, right.slot);
  if (slot !== 0) return slot;

  const transaction = compareNumber(left.transactionIndex, right.transactionIndex);
  if (transaction !== 0) return transaction;

  const instruction = compareNumber(left.instructionIndex, right.instructionIndex);
  if (instruction !== 0) return instruction;

  return compareInnerInstructionIndex(
    left.innerInstructionIndex,
    right.innerInstructionIndex,
  );
}

function compareBigInt(left: bigint, right: bigint): -1 | 0 | 1 {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareNumber(left: number, right: number): -1 | 0 | 1 {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareInnerInstructionIndex(
  left: number | null,
  right: number | null,
): -1 | 0 | 1 {
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;
  return compareNumber(left, right);
}

function assertValidCursorIndex(
  field: Exclude<ChainCursorField, 'slot'>,
  value: unknown,
): asserts value is number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || Object.is(value, -0)
  ) {
    throw new InvalidChainCursorError(field, value);
  }
}

function formatCursorValue(value: unknown): string {
  if (Object.is(value, -0)) return '-0';
  if (typeof value === 'bigint') return `${value}n`;
  return String(value);
}
