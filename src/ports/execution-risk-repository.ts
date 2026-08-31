import type {
  ExecutionProviderUsageCategory,
  ProviderUsageSnapshotV1,
} from '../domain/execution-provider-quota.js';
import type { ExecutionReconciliationEvidenceV1 } from '../domain/execution-reconciliation.js';

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
  readonly openPositions: number;
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
  readonly intentId: string;
}

export interface ExecutionBuyAdmissionResultV1 {
  readonly payloadVersion: 1;
  readonly decision: 'ADMITTED' | 'REJECTED';
  readonly reportId: string;
  readonly reservationId: string | null;
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

export interface ExecutionRiskRepository {
  registerWalletGeneration(input: WalletGenerationDraftV1): Promise<WalletGenerationV1>;
  appendWalletSnapshot(input: WalletSnapshotDraftV1): Promise<WalletSnapshotV1>;
  appendProviderUsage(input: ProviderUsageSnapshotV1): Promise<ProviderUsageSnapshotV1>;
  recordProviderOperation(input: ProviderUsageOperationV1): Promise<'RECORDED' | 'REPLAYED'>;
  recordRateLimit(input: ProviderRateLimitEventV1): Promise<'RECORDED' | 'REPLAYED'>;
  admitBuy(input: ExecutionBuyAdmissionInputV1): Promise<ExecutionBuyAdmissionResultV1>;
  reconcile(input: ExecutionReconciliationCommitV1): Promise<ExecutionReconciliationCommitResultV1>;
}
