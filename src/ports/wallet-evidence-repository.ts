import type {
  WalletFundingAssessment,
  WalletFundingEvidence,
} from '../domain/wallet-funding.js';
import type {
  ChainConfirmationStatus,
} from '../domain/types.js';

export interface WalletEvidenceBatch {
  readonly signature: string;
  readonly confirmationStatus: ChainConfirmationStatus;
  readonly assessments: readonly WalletFundingAssessment[];
  readonly evidence: readonly WalletFundingEvidence[];
}

export interface WalletEvidenceRepository {
  record(batch: WalletEvidenceBatch): Promise<void>;
}
