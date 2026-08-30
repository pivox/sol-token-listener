import { createExecutionDryRunAssessment } from '../domain/execution-dry-run.js';
import type { ExecutionDryRunRepository } from '../ports/execution-dry-run-repository.js';
import type { ExecutionIntentRepository } from '../ports/execution-intent-repository.js';
import { ExecutionDryRunRepositoryError } from '../storage/execution-dry-run.repository.js';
import { ExecutionIntentRepositoryError } from '../storage/execution-intent.repository.js';

export type DryRunPassResult = 'IDLE' | 'RECORDED' | 'COMMIT_RECOVERED';

export interface DryRunWorkerDependencies {
  readonly intents: Pick<ExecutionIntentRepository, 'claim'>;
  readonly assessments: ExecutionDryRunRepository;
  readonly ownerId: string;
  readonly leaseMs: number;
}

export interface DryRunWorker {
  readonly runOnce: (signal: AbortSignal) => Promise<DryRunPassResult>;
}

export function createDryRunWorker(dependencies: DryRunWorkerDependencies): DryRunWorker {
  let active: Promise<DryRunPassResult> | null = null;
  const runOnce = (signal: AbortSignal): Promise<DryRunPassResult> => {
    if (active !== null) return active;
    const tracked = Promise.resolve().then(() => runPass(dependencies, signal)).finally(() => {
      if (active === tracked) active = null;
    });
    active = tracked;
    return tracked;
  };
  return Object.freeze({ runOnce });
}

async function runPass(
  dependencies: DryRunWorkerDependencies,
  signal: AbortSignal,
): Promise<DryRunPassResult> {
  if (cancellationRequested(signal)) return 'IDLE';
  let claim;
  try {
    claim = await dependencies.intents.claim(Object.freeze({
      ownerId: dependencies.ownerId,
      leaseMs: dependencies.leaseMs,
      purpose: 'DRY_RUN',
    }), signal);
  } catch (error) {
    if (error instanceof ExecutionIntentRepositoryError
      && error.code === 'OPERATION_ABORTED'
      && cancellationRequested(signal)) return 'IDLE';
    throw error;
  }
  if (cancellationRequested(signal)) return 'IDLE';
  if (claim === null) return 'IDLE';
  const assessment = createExecutionDryRunAssessment(claim.intent);
  try {
    await dependencies.assessments.complete(claim, assessment, signal);
    return 'RECORDED';
  } catch (error) {
    if (error instanceof ExecutionDryRunRepositoryError
      && error.code === 'OPERATION_ABORTED'
      && cancellationRequested(signal)) return 'IDLE';
    if (!(error instanceof ExecutionDryRunRepositoryError)
      || error.code !== 'COMMIT_OUTCOME_UNKNOWN') throw error;
    if (cancellationRequested(signal)) return 'IDLE';
    let exact;
    try {
      exact = await dependencies.assessments.findExact(assessment, signal);
    } catch (recoveryError) {
      if (recoveryError instanceof ExecutionDryRunRepositoryError
        && recoveryError.code === 'OPERATION_ABORTED'
        && cancellationRequested(signal)) return 'IDLE';
      throw recoveryError;
    }
    if (exact === null) throw error;
    return 'COMMIT_RECOVERED';
  }
}

function cancellationRequested(signal: AbortSignal): boolean {
  return signal.aborted;
}
