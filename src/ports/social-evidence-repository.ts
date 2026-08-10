import type { TokenMetadataSnapshot } from '../domain/pumpfun-observation.js';
import type { SocialEvidenceCollectionV1 } from '../domain/social-evidence.js';

export interface ClaimedSocialJob {
  readonly id: string;
  readonly mint: string;
  readonly sourceLaunchEventId: string;
  readonly metadataUri: string | null;
  readonly attempts: number;
  readonly attemptsInCycle: number;
  readonly leaseToken: string;
  readonly leaseExpiresAtMs: number;
}

export type SocialJobResult =
  | Readonly<{
      status: 'RESOLVED';
      metadataSnapshot: TokenMetadataSnapshot;
      collection: SocialEvidenceCollectionV1;
    }>
  | Readonly<{
      status: 'METADATA_FAILED';
      metadataSnapshot: TokenMetadataSnapshot;
      collection: SocialEvidenceCollectionV1;
    }>;

export interface SocialJobFailure {
  readonly code: 'HTTP_TRANSIENT' | 'PROVIDER_UNAVAILABLE' | 'LEASE_EXPIRED';
  readonly retryable: boolean;
  readonly observedAtMs: number;
}

export interface SocialJobCounts {
  readonly pending: number;
  readonly processing: number;
  readonly retryableFailed: number;
  readonly exhausted: number;
}

export interface SocialEvidenceRepository {
  claim(options: Readonly<{ leaseMs: number; nowMs: number }>): Promise<ClaimedSocialJob | null>;
  renew(jobId: string, leaseToken: string, leaseMs: number, nowMs: number): Promise<boolean>;
  complete(job: ClaimedSocialJob, result: SocialJobResult): Promise<void>;
  fail(job: ClaimedSocialJob, failure: SocialJobFailure): Promise<void>;
  counts(): Promise<SocialJobCounts>;
}

