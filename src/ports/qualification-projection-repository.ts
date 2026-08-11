import type { DomainEvent } from '../domain/events.js';
import type { CreatorProfile, HolderDistribution } from '../domain/participant-analytics.js';
import type { TokenMetadataSnapshot } from '../domain/pumpfun-observation.js';
import type {
  QualificationEvaluationInput,
  QualificationReport,
} from '../domain/qualification.js';
import type { SocialEvidenceCollectionV1 } from '../domain/social-evidence.js';
import type { TokenLaunch } from '../domain/types.js';
import type { WalletGraphAnalysis } from '../domain/wallet-graph.js';

export interface QualificationEvidenceSnapshot {
  readonly mint: string;
  readonly asOfEvent: DomainEvent;
  readonly launch: TokenLaunch;
  readonly metadata: TokenMetadataSnapshot | null;
  readonly social: SocialEvidenceCollectionV1 | null;
  readonly creatorProfile: CreatorProfile | null;
  readonly holderSnapshot: HolderDistribution | null;
  readonly walletGraph: WalletGraphAnalysis | null;
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

export interface QualificationProjectionRepository {
  readonly transact: <TResult>(
    mint: string,
    operation: (transaction: QualificationProjectionTransaction) => Promise<TResult>,
  ) => Promise<TResult>;
}
