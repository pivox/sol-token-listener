import { assertValidTransactionCursor } from '../../domain/cursor.js';
import { assertValidTimestampMs } from '../../domain/timestamp.js';
import type { ObservedChainTransaction } from '../../domain/types.js';
import type { NormalizedTransaction } from './types.js';

const CONFIRMATION_STATUS = {
  PROCESSED: 'processed',
  CONFIRMED: 'confirmed',
  FINALIZED: 'finalized',
  ORPHANED: 'orphaned',
} as const;

export interface SolanaObservedTransaction extends ObservedChainTransaction {
  readonly raw: NormalizedTransaction;
}

export function createSolanaObservedTransaction(
  raw: NormalizedTransaction,
  observedAtMs: number,
): SolanaObservedTransaction {
  if (raw.transactionIndex === null) {
    throw new Error(`Transaction ${raw.signature} sans index canonique.`);
  }
  assertValidTimestampMs('observedAtMs', observedAtMs);
  const cursor = Object.freeze({
    slot: raw.slot,
    transactionIndex: raw.transactionIndex,
  });
  assertValidTransactionCursor(cursor);
  return Object.freeze({
    signature: raw.signature,
    confirmationStatus: CONFIRMATION_STATUS[raw.confirmationStatus],
    blockTimeMs: raw.blockTimeMs,
    observedAtMs,
    cursor,
    raw,
  });
}
