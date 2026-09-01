import type { ExecutionReconciliationEvidenceV1 } from '../domain/execution-reconciliation.js';
import {
  ExecutionReconciliationService,
  type ExecutionReconciliationRequestV1,
} from '../executor-risk/reconciliation-service.js';
import type { ExecutionReconciliationGateway } from '../ports/execution-reconciliation-gateway.js';
import type { ClaimedExecutionIntent } from '../ports/execution-intent-repository.js';
import type { ExecutionReconciliationCommitResultV1 } from '../ports/execution-risk-repository.js';

export interface LiveReconciliationWorkerDependencies {
  readonly gateway: ExecutionReconciliationGateway;
  readonly repository: Readonly<{
    commitReconciliation(
      claim: ClaimedExecutionIntent,
      evidence: ExecutionReconciliationEvidenceV1,
    ): Promise<unknown>;
  }>;
}

export interface LiveReconciliationWorkerInputV1 {
  readonly payloadVersion: 1;
  readonly claim: ClaimedExecutionIntent;
  readonly request: ExecutionReconciliationRequestV1;
}

export type LiveReconciliationWorkerResultV1 = Readonly<{
  readonly payloadVersion: 1;
  readonly kind: 'MATCHED' | 'NO_EFFECT' | 'MISMATCH' | 'UNKNOWN';
  readonly evidenceId: string;
}>;

export async function reconcileLiveSubmission(
  dependencies: LiveReconciliationWorkerDependencies,
  input: LiveReconciliationWorkerInputV1,
  signal: AbortSignal,
): Promise<LiveReconciliationWorkerResultV1> {
  const service = new ExecutionReconciliationService(dependencies.gateway, {
    reconcile: async ({ evidence }): Promise<ExecutionReconciliationCommitResultV1> => {
      await dependencies.repository.commitReconciliation(input.claim, evidence);
      return Object.freeze({
        payloadVersion: 1,
        result: evidence.result,
        evidenceId: evidence.evidenceId,
      });
    },
  });
  const result = await service.reconcile(input.request, signal);
  return Object.freeze({
    payloadVersion: 1,
    kind: result.result,
    evidenceId: result.evidenceId,
  });
}
