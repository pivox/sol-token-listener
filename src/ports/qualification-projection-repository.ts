import type { DomainEvent } from '../domain/events.js';
import type { TokenMetadataSnapshot } from '../domain/pumpfun-observation.js';
import type {
  QualificationEvaluationInput,
  QualificationReport,
} from '../domain/qualification.js';
import type { TokenLaunch } from '../domain/types.js';

export interface QualificationEvidenceSnapshot {
  readonly mint: string;
  readonly asOfEvent: DomainEvent;
  readonly launch: TokenLaunch;
  readonly metadata: TokenMetadataSnapshot | null;
  readonly creatorHasSold: boolean;
}

export interface QualificationCanonicalSnapshot extends QualificationEvidenceSnapshot {
  readonly asOfRawEventId: string;
}

export interface CanonicalQualificationProjection {
  readonly reportId: string;
  readonly sourceEventId: string;
  readonly sourceRawEventId: string;
  readonly evidenceFingerprint: string;
  readonly evaluation: QualificationEvaluationInput;
  readonly report: QualificationReport;
  readonly qualificationEvent: DomainEvent;
}

export interface QualificationProjectionTransaction {
  readonly loadCanonicalInput: (mint: string) => Promise<QualificationCanonicalSnapshot | null>;
  readonly replaceProjection: (
    projection: CanonicalQualificationProjection,
  ) => Promise<'UPDATED' | 'UNCHANGED'>;
  readonly dissolveCurrent: (mint: string) => Promise<void>;
}

export type QualificationTransactionReplayPolicy = 'none' | 'bounded-serialization';

export interface QualificationProjectionRepository {
  /**
   * Omitted policy means one attempt. Replay opt-in requires an externally
   * side-effect-free callback that reloads and rebuilds on every attempt.
   */
  readonly transact: <TResult>(
    mint: string,
    operation: (transaction: QualificationProjectionTransaction) => Promise<TResult>,
    replayPolicy?: QualificationTransactionReplayPolicy,
  ) => Promise<TResult>;
}
