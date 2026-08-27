import type { StrictCatchUpFailure } from '../domain/strict-catch-up.js';
import type {
  ProcessingCheckpoint,
  ProcessingCheckpointKey,
  TransactionNotification,
} from '../domain/transaction-ingestion.js';

export interface StrictCatchUpRepository {
  enqueue(value: TransactionNotification): Promise<void>;
  readCheckpoint(key: ProcessingCheckpointKey): Promise<ProcessingCheckpoint | null>;
  compareAndSwapCheckpoint(
    expected: ProcessingCheckpoint | null,
    next: ProcessingCheckpoint,
  ): Promise<void>;
  recordStrictCatchUpFailure(value: StrictCatchUpFailure): Promise<void>;
  resolveStrictCatchUpFailures(
    key: ProcessingCheckpointKey,
    previous: ProcessingCheckpoint | null,
  ): Promise<void>;
}
