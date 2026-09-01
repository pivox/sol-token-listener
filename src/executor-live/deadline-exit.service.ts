import type {
  ExecutionDeadlineExitResultV1,
  ExecutionLiveRepository,
} from '../ports/execution-live-repository.js';

export interface DeadlineExitServiceDependencies {
  readonly repository: Pick<ExecutionLiveRepository, 'createDeadlineExitIntent'>;
}

export interface DeadlineExitServiceInputV1 {
  readonly payloadVersion: 1;
  readonly positionId: string;
  readonly observedAtMs: number;
}

export function createDeadlineExit(
  dependencies: DeadlineExitServiceDependencies,
  input: DeadlineExitServiceInputV1,
): Promise<ExecutionDeadlineExitResultV1> {
  return dependencies.repository.createDeadlineExitIntent(Object.freeze({
    positionId: input.positionId,
    observedAtMs: input.observedAtMs,
  }));
}
