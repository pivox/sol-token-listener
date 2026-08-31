import type {
  ExecutionDryRunAssessmentDraftV1,
  ExecutionDryRunAssessmentV1,
} from '../domain/execution-dry-run.js';
import type { ClaimedExecutionIntent } from './execution-intent-repository.js';

export interface ExecutionDryRunRepository {
  readonly complete: (
    claim: ClaimedExecutionIntent,
    assessment: ExecutionDryRunAssessmentDraftV1,
    signal: AbortSignal,
  ) => Promise<ExecutionDryRunAssessmentV1>;
  readonly findExact: (
    assessment: ExecutionDryRunAssessmentDraftV1,
    signal: AbortSignal,
  ) => Promise<ExecutionDryRunAssessmentV1 | null>;
}
