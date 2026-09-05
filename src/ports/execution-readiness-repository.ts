import type { ProviderUsageSnapshotV1 } from '../domain/execution-provider-quota.js';
import type {
  WalletGenerationDraftV1,
  WalletSnapshotDraftV1,
} from './execution-risk-repository.js';

export interface ExecutionReadinessCommitV1 {
  readonly generation: WalletGenerationDraftV1;
  readonly walletSnapshot: WalletSnapshotDraftV1;
  readonly providerSnapshot: ProviderUsageSnapshotV1;
}

export interface ExecutionReadinessRepository {
  commit(input: ExecutionReadinessCommitV1): Promise<ExecutionReadinessCommitV1>;
}

