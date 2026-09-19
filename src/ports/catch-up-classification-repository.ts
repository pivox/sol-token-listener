import type {
  CatchUpClassification,
  CatchUpClassificationReceipt,
} from '../domain/catch-up-classification.js';

/** Inactive B1 boundary used by the block classifier introduced after this PR. */
export interface CatchUpClassificationRepository {
  recordCatchUpClassification(
    value: CatchUpClassification,
    signal?: AbortSignal,
  ): Promise<CatchUpClassificationReceipt>;
}
