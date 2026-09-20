import type { CatchUpClassificationReceipt } from '../domain/catch-up-classification.js';
import type { ChainConfirmationStatus } from '../domain/types.js';

export type CatchUpAdmissionCoverageConfirmationStatus = Exclude<
  ChainConfirmationStatus,
  'orphaned'
>;

/** Minimal source-neutral identity used to prove that catch-up work is durable. */
export interface CatchUpAdmissionCoverageCandidate {
  readonly signature: string;
  readonly slot: bigint;
  readonly confirmationStatus: CatchUpAdmissionCoverageConfirmationStatus;
  readonly programIds: readonly string[];
}

export interface CatchUpAdmissionCoverageRepository {
  readExistingCatchUpCoverage(
    candidates: readonly CatchUpAdmissionCoverageCandidate[],
    signal: AbortSignal,
  ): Promise<readonly CatchUpClassificationReceipt[]>;
}
