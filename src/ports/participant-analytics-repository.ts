import type { ParticipantAnalyticsDerivedEventV1 } from '../domain/participant-analytics-events.js';
import type {
  ParticipantAnalyticsInput,
  ParticipantAnalyticsProjection,
} from '../domain/participant-analytics.js';

export interface ParticipantAnalyticsTransaction {
  loadCanonicalInput(mint: string): Promise<ParticipantAnalyticsInput | null>;
  replaceProjection(
    projection: ParticipantAnalyticsProjection,
    events: readonly ParticipantAnalyticsDerivedEventV1[],
  ): Promise<void>;
}

export interface ParticipantAnalyticsRepository {
  transact<TResult>(
    mint: string,
    operation: (
      transaction: ParticipantAnalyticsTransaction,
    ) => Promise<TResult>,
  ): Promise<TResult>;
}
