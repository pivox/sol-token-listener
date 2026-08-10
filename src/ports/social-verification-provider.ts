import type { TokenMetadataSnapshot } from '../domain/pumpfun-observation.js';
import type { SocialEvidenceCollectionV1 } from '../domain/social-evidence.js';

export interface SocialVerificationProvider {
  collect(input: Readonly<{
    mint: string;
    sourceLaunchEventId: string;
    metadataSnapshot: TokenMetadataSnapshot;
  }>): Promise<Readonly<{
    metadataSnapshot: TokenMetadataSnapshot;
    collection: SocialEvidenceCollectionV1;
  }>>;
}
