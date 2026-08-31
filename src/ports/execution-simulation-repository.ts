import type {
  ExecutionSimulationArtifactDraftV1,
  ExecutionSimulationArtifactV1,
} from '../domain/execution-simulation.js';
import type { ClaimedExecutionIntent } from './execution-intent-repository.js';

export interface ExecutionSimulationRepository {
  readonly complete: (
    claim: ClaimedExecutionIntent,
    artifact: ExecutionSimulationArtifactDraftV1,
    signal: AbortSignal,
  ) => Promise<ExecutionSimulationArtifactV1>;
  readonly findExact: (
    artifact: ExecutionSimulationArtifactDraftV1,
    signal: AbortSignal,
  ) => Promise<ExecutionSimulationArtifactV1 | null>;
}
