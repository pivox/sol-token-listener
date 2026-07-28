import type { ChainCursor } from './types.js';

export function compareCursors(left: ChainCursor, right: ChainCursor): -1 | 0 | 1 {
  const slot = compareBigInt(left.slot, right.slot);
  if (slot !== 0) return slot;

  const transaction = compareNumber(left.transactionIndex, right.transactionIndex);
  if (transaction !== 0) return transaction;

  const instruction = compareNumber(left.instructionIndex, right.instructionIndex);
  if (instruction !== 0) return instruction;

  return compareNumber(left.innerInstructionIndex ?? -1, right.innerInstructionIndex ?? -1);
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
