import type {
  ExecutionProviderUsageCategory,
  ProviderUsageSnapshotV1,
} from '../domain/execution-provider-quota.js';
import type { ExecutionReconciliationEvidenceV1 } from '../domain/execution-reconciliation.js';
import type {
  ExecutionBuyRiskReasonCode,
  ExecutionOpenPositionRiskInputV1,
  ExecutionRiskPolicyV1,
} from '../domain/execution-risk-policy.js';
import type { ExecutionIntentV1 } from '../domain/execution-intent.js';
import type {
  ExecutionFaultClassification,
  ExecutionFaultStage,
  ExecutionRetryDecision,
} from '../domain/execution-fault-policy.js';

export type ExecutionCluster = 'mainnet-beta' | 'devnet' | 'testnet';

export interface WalletGenerationDraftV1 {
  readonly generationId: string;
  readonly payloadVersion: 1;
  readonly walletPublicKey: string;
  readonly cluster: ExecutionCluster;
  readonly genesisHash: string;
  readonly generation: number;
}

export interface WalletGenerationV1 extends WalletGenerationDraftV1 {
  readonly createdAtMs: number;
  readonly retiredAtMs: number | null;
}

export interface WalletSnapshotDraftV1 {
  readonly snapshotId: string;
  readonly payloadVersion: 1;
  readonly snapshotFingerprint: string;
  readonly generationId: string;
  readonly providerId: string;
  readonly stateRevision: bigint;
  readonly slot: bigint;
  readonly blockTimeMs: number | null;
  readonly observedAtMs: number;
  readonly commitment: 'finalized';
  readonly walletLamports: bigint;
  readonly tokenBalanceCount: number;
  readonly openPositions: readonly ExecutionOpenPositionRiskInputV1[];
  readonly realizedNetPnlRaw: bigint;
}

export type WalletSnapshotV1 = WalletSnapshotDraftV1;

export interface ProviderUsageOperationV1 {
  readonly operationId: string;
  readonly payloadVersion: 1;
  readonly snapshotId: string;
  readonly providerId: string;
  readonly billingPeriodId: string;
  readonly category: ExecutionProviderUsageCategory;
  readonly logicalOperationId: string;
  readonly units: bigint;
}

export interface ProviderRateLimitEventV1 {
  readonly eventId: string;
  readonly payloadVersion: 1;
  readonly providerId: string;
  readonly billingPeriodId: string;
  readonly endpointId: string;
  readonly observedAtMs: number;
}

export interface ExecutionBuyAdmissionInputV1 {
  readonly payloadVersion: 1;
  readonly intent: ExecutionIntentV1;
  readonly policy: ExecutionRiskPolicyV1;
  readonly generationId: string;
  readonly walletSnapshot: WalletSnapshotV1;
  readonly providerSnapshot: ProviderUsageSnapshotV1;
  readonly allEndpointsUnavailable: boolean;
  readonly nowMs: number;
}

export interface ExecutionBuyAdmissionResultV1 {
  readonly payloadVersion: 1;
  readonly decision: 'ADMITTED' | 'REJECTED';
  readonly reasonCode: ExecutionBuyRiskReasonCode
    | 'PROVIDER_USAGE_UNKNOWN'
    | 'PROVIDER_ENTRY_LIMIT_REACHED'
    | 'PROVIDER_EXIT_ONLY'
    | 'DECISION_STALE'
    | 'WALLET_MISMATCH'
    | null;
  readonly reportId: string;
  readonly reservationId: string | null;
  readonly stateRevision: bigint;
}

export interface ExecutionReconciliationCommitV1 {
  readonly payloadVersion: 1;
  readonly evidence: ExecutionReconciliationEvidenceV1;
}

export interface ExecutionReconciliationCommitResultV1 {
  readonly payloadVersion: 1;
  readonly result: 'MATCHED' | 'NO_EFFECT' | 'MISMATCH' | 'UNKNOWN';
  readonly evidenceId: string;
}

export type ExecutionActivationPhase = 'NONE' | 'CANARY' | 'MICRO_LIVE' | 'PILOT';

export type ExecutionFaultReasonCode =
  | 'BUY_SIMULATION_FAILED'
  | 'SELL_SIMULATION_FAILED'
  | 'EXECUTION_PROVIDER_FAILED'
  | 'EXECUTION_BUILD_FAILED'
  | 'EXECUTION_EVIDENCE_INVALID'
  | 'SIGNATURE_PERSIST_FAILED'
  | 'SUBMISSION_AMBIGUOUS'
  | 'CONFIRMATION_TIMEOUT'
  | 'RECONCILIATION_REQUIRED'
  | 'RECONCILIATION_PROVED_NO_EFFECT'
  | 'BALANCE_MISMATCH'
  | 'RESIDUAL_TOKEN_BALANCE'
  | 'DOUBLE_ORDER_SUSPECTED';

export interface ExecutionFaultRecordInputV1 {
  readonly faultId: string;
  readonly payloadVersion: 1;
  readonly generationId: string;
  readonly intentId: string | null;
  readonly activationPhase: ExecutionActivationPhase;
  readonly stage: ExecutionFaultStage;
  readonly side: 'BUY' | 'SELL';
  readonly timing: 'PRE_SIGNATURE' | 'AFTER_SIGNATURE';
  readonly classification: ExecutionFaultClassification;
  readonly exactSignedBytesAvailable: boolean;
  readonly reasonCode: ExecutionFaultReasonCode;
  readonly observedAtMs: number;
}

export interface ExecutionFaultRecordResultV1 {
  readonly payloadVersion: 1;
  readonly faultId: string;
  readonly consecutiveTechnicalFailures: number;
  readonly retryDecision: ExecutionRetryDecision;
  readonly buyBlocked: boolean;
}

export interface ExecutionReconciledSuccessInputV1 {
  readonly payloadVersion: 1;
  readonly evidenceId: string;
  readonly generationId: string;
  readonly activationPhase: ExecutionActivationPhase;
}

export interface ExecutionRiskRepository {
  registerWalletGeneration(input: WalletGenerationDraftV1): Promise<WalletGenerationV1>;
  appendWalletSnapshot(input: WalletSnapshotDraftV1): Promise<WalletSnapshotV1>;
  appendProviderUsage(input: ProviderUsageSnapshotV1): Promise<ProviderUsageSnapshotV1>;
  recordProviderOperation(input: ProviderUsageOperationV1): Promise<'RECORDED' | 'REPLAYED'>;
  recordRateLimit(input: ProviderRateLimitEventV1): Promise<'RECORDED' | 'REPLAYED'>;
  admitBuy(input: ExecutionBuyAdmissionInputV1): Promise<ExecutionBuyAdmissionResultV1>;
  recordFault(input: ExecutionFaultRecordInputV1): Promise<ExecutionFaultRecordResultV1>;
  recordReconciledSuccess(
    input: ExecutionReconciledSuccessInputV1,
  ): Promise<ExecutionFaultRecordResultV1>;
  reconcile(input: ExecutionReconciliationCommitV1): Promise<ExecutionReconciliationCommitResultV1>;
}
