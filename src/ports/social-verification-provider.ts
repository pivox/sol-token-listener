import type { TokenMetadataSnapshot } from '../domain/pumpfun-observation.js';
import type { SocialEvidenceCollectionV1 } from '../domain/social-evidence.js';

export interface SocialVerificationProvider {
  collect(input: Readonly<{
    mint: string;
    sourceLaunchEventId: string;
    metadataSnapshot: TokenMetadataSnapshot;
  }>): Promise<SocialVerificationResult>;
}

export interface SocialVerificationResult {
  readonly metadataSnapshot: TokenMetadataSnapshot;
  readonly collection: SocialEvidenceCollectionV1;
  readonly retryable: boolean;
}
