import type { TransactionLocationTarget } from '../solana/rpc/transaction-locator.js';
import type { NormalizedTransaction } from '../solana/rpc/types.js';

export interface TransactionInboxClaimReservation {
  locate(target: TransactionLocationTarget): Promise<NormalizedTransaction>;
  release(): void;
}

export interface TransactionInboxClaimAdmission {
  acquire(signal: AbortSignal): Promise<TransactionInboxClaimReservation | null>;
  close(): void;
}
