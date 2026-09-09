import type { StrictCatchUpFailure } from '../domain/strict-catch-up.js';
import type { StrictCatchUpRun } from '../domain/strict-catch-up-run.js';
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
  readActiveStrictCatchUpRun(key: ProcessingCheckpointKey): Promise<StrictCatchUpRun | null>;
  readStrictCatchUpRun(
    key: ProcessingCheckpointKey,
    previous: ProcessingCheckpoint,
    providerId: StrictCatchUpRun['providerId'],
  ): Promise<StrictCatchUpRun | null>;
  createStrictCatchUpRun(value: StrictCatchUpRun): Promise<StrictCatchUpRun>;
  advanceStrictCatchUpRun(expected: StrictCatchUpRun, next: StrictCatchUpRun): Promise<void>;
  completeStrictCatchUpRun(value: {
    readonly run: StrictCatchUpRun;
    readonly nextCheckpoint: ProcessingCheckpoint;
  }): Promise<void>;
  failStrictCatchUpRun(expected: StrictCatchUpRun, failed: StrictCatchUpRun): Promise<void>;
  supersedeStaleStrictCatchUpRun(expected: StrictCatchUpRun, atMs: number): Promise<void>;
}
