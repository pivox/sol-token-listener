import type { CatchUpClassificationReceipt } from '../domain/catch-up-classification.js';
import type { ListenerIngestionProgram } from './listener-ingestion-program.js';
import type { CatchUpSignature } from '../solana/rpc/catch-up-source.js';

export interface StrictCatchUpPageAdmissionResult {
  readonly receipts: readonly CatchUpClassificationReceipt[];
  readonly signaturesClassified: bigint;
  readonly signaturesEnqueued: bigint;
}

/** Optional B3a boundary. Production composition is deferred to B3b. */
export interface StrictCatchUpPageAdmitter {
  admitPage(
    program: ListenerIngestionProgram,
    rows: readonly CatchUpSignature[],
    signal: AbortSignal,
  ): Promise<StrictCatchUpPageAdmissionResult>;
}
