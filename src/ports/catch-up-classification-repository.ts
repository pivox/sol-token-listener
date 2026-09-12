import type { CatchUpClassification } from '../domain/catch-up-classification.js';

/** Inactive B1 boundary used by the block classifier introduced after this PR. */
export interface CatchUpClassificationRepository {
  recordCatchUpClassification(value: CatchUpClassification): Promise<void>;
}
