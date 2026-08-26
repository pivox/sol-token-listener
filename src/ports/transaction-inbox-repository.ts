import type {
  ClaimedTransaction,
  CatchUpGap,
  FinalityCandidate,
  FinalityPollObservation,
  FinalityRevision,
  InboxCounts,
  InboxRecoveryResult,
  IngestionFailure,
  ProcessingCheckpoint,
  RuntimeHeartbeat,
  TransactionNotification,
} from '../domain/transaction-ingestion.js';
import type { ChainConfirmationStatus } from '../domain/types.js';
import type { NormalizedTransaction } from '../solana/rpc/types.js';

export interface TransactionInboxRepository {
  enqueue(value: TransactionNotification): Promise<void>;
  claim(nowMs: number, leaseSeconds: number): Promise<ClaimedTransaction | null>;
  renewLease(signature: string, token: string, untilMs: number): Promise<void>;

  /**
   * Accepts the decoder-facing transaction. The repository implementation owns
   * the one-way conversion through createDurableTransactionSnapshot before it
   * serializes the immutable durable representation.
   */
  saveSnapshot(
    signature: string,
    token: string,
    tx: NormalizedTransaction,
  ): Promise<void>;

  markProcessed(
    signature: string,
    token: string,
    status: ChainConfirmationStatus,
  ): Promise<void>;
  markFailed(signature: string, token: string, failure: IngestionFailure): Promise<void>;
  recoverExhausted(signature: string): Promise<InboxRecoveryResult>;
  listForFinality(limit: number): Promise<readonly FinalityCandidate[]>;
  recordFinalityPoll(value: FinalityPollObservation): Promise<FinalityCandidate>;
  enqueueRevision(value: FinalityRevision): Promise<void>;
  readCheckpoint(key: 'launchpad' | 'market'): Promise<ProcessingCheckpoint | null>;
  storeCheckpoint(value: ProcessingCheckpoint): Promise<void>;
  recordCatchUpGap(value: CatchUpGap): Promise<void>;
  writeHeartbeat(value: RuntimeHeartbeat): Promise<void>;
  counts(): Promise<InboxCounts>;
}
