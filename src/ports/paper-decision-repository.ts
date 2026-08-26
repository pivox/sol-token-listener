import type { DomainEvent } from '../domain/events.js';
import type { LaunchpadObservationEventV1 } from '../domain/launchpad-events.js';
import type { MarketTrade } from '../domain/market.js';
import type {
  AnyPaperExternalBuyEvidence,
  PaperStrategySession,
} from '../domain/paper-strategy.js';
import type { PaperPosition } from '../domain/paper-trading.js';
import type { CreatorProfile, HolderDistribution } from '../domain/participant-analytics.js';
import type { TokenMetadataSnapshot } from '../domain/pumpfun-observation.js';
import type { QualificationReport } from '../domain/qualification.js';
import type { SocialEvidenceCollectionV1 } from '../domain/social-evidence.js';
import type { TradingCandidateV1 } from '../domain/trading-candidate.js';
import type { ChainConfirmationStatus, TokenLaunch } from '../domain/types.js';
import type { WalletGraphAnalysis } from '../domain/wallet-graph.js';
import type { CanonicalQualificationProjection } from './qualification-projection-repository.js';

export interface PaperDecisionJobInput {
  readonly mint: string;
  readonly sourceEventId: string;
  readonly sourceRawEventId: string;
  readonly sourceConfirmationStatus: ChainConfirmationStatus;
  readonly inputFingerprint: string;
}

export interface ClaimedPaperDecisionJob extends PaperDecisionJobInput {
  readonly jobId: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseToken: string;
  readonly leaseExpiresAtMs: number;
  readonly createdAtMs: number;
}

export interface PaperDecisionQueueCounts {
  readonly pending: number;
  readonly processing: number;
  readonly retryableFailed: number;
  readonly exhausted: number;
}

export interface PaperDecisionSnapshot {
  readonly mint: string;
  readonly asOfEvent: DomainEvent;
  readonly canonicalLaunchActive: boolean;
  readonly hasPaperLineage: boolean;
  readonly launch: TokenLaunch;
  readonly launchDetectedAtMs: number;
  readonly launchConfirmationStatus: ChainConfirmationStatus;
  readonly metadata: TokenMetadataSnapshot | null;
  readonly social: SocialEvidenceCollectionV1 | null;
  readonly creatorProfile: CreatorProfile | null;
  readonly holderSnapshot: HolderDistribution | null;
  readonly walletGraph: WalletGraphAnalysis | null;
  readonly activeLaunchTrades: readonly Extract<
    LaunchpadObservationEventV1,
    { readonly type: 'BondingCurveTradeObserved' }
  >[];
  readonly activeMarketTrades: readonly MarketTrade[];
  readonly currentQualification: CanonicalQualificationProjection | null;
  readonly currentCandidate: TradingCandidateV1 | null;
  readonly currentDecision: Readonly<{
    readonly qualification: CanonicalQualificationProjection;
    readonly candidateEvent: DomainEvent;
  }> | null;
  readonly currentSession: PaperStrategySession | null;
  readonly activePosition: PaperPosition | null;
}

export interface PaperDecisionResult {
  readonly report: QualificationReport;
  readonly qualificationEvent: DomainEvent;
  readonly candidate: TradingCandidateV1;
  readonly candidateEvent: DomainEvent;
  readonly session: PaperStrategySession | null;
  readonly sessionEvent: DomainEvent | null;
  readonly countedExternalBuys: readonly AnyPaperExternalBuyEvidence[];
  readonly requestedAction: 'NONE' | 'OPEN' | 'CLOSE';
}

export interface PaperDecisionFailure {
  readonly code: 'RPC_TRANSIENT' | 'QUOTE_UNAVAILABLE' | 'LEASE_EXPIRED' | 'DECISION_INVALID';
  readonly retryable: boolean;
  readonly terminalResult: PaperDecisionResult | null;
}

export interface PaperDecisionRepository {
  enqueue(input: PaperDecisionJobInput): Promise<void>;
  enqueueActiveSessions(nowMs: number): Promise<number>;
  claim(options: Readonly<{ leaseMs: number; nowMs: number }>): Promise<ClaimedPaperDecisionJob | null>;
  renew(job: ClaimedPaperDecisionJob, nowMs: number, leaseMs: number): Promise<boolean>;
  loadSnapshot(job: ClaimedPaperDecisionJob): Promise<PaperDecisionSnapshot>;
  stageDecision(job: ClaimedPaperDecisionJob, result: PaperDecisionResult): Promise<void>;
  complete(job: ClaimedPaperDecisionJob, result: PaperDecisionResult): Promise<void>;
  completeNoop(job: ClaimedPaperDecisionJob): Promise<void>;
  completeObsolete(job: ClaimedPaperDecisionJob): Promise<void>;
  fail(job: ClaimedPaperDecisionJob, failure: PaperDecisionFailure): Promise<void>;
  counts(): Promise<PaperDecisionQueueCounts>;
}
