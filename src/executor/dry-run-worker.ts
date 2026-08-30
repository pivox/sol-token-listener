import { createExecutionDryRunAssessment } from '../domain/execution-dry-run.js';
import type { ExecutionDryRunRepository } from '../ports/execution-dry-run-repository.js';
import type { ExecutionIntentRepository } from '../ports/execution-intent-repository.js';
import { ExecutionDryRunRepositoryError } from '../storage/execution-dry-run.repository.js';

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
  const claim = await dependencies.intents.claim(Object.freeze({
    ownerId: dependencies.ownerId,
    leaseMs: dependencies.leaseMs,
    purpose: 'DRY_RUN',
  }));
  if (cancellationRequested(signal)) return 'IDLE';
  if (claim === null) return 'IDLE';
  const assessment = createExecutionDryRunAssessment(claim.intent);
  try {
    await dependencies.assessments.complete(claim, assessment);
    return 'RECORDED';
  } catch (error) {
    if (cancellationRequested(signal)) return 'IDLE';
    if (!(error instanceof ExecutionDryRunRepositoryError)
      || error.code !== 'COMMIT_OUTCOME_UNKNOWN') throw error;
    const exact = await dependencies.assessments.findExact(assessment);
    if (exact === null) throw error;
    return 'COMMIT_RECOVERED';
  }
}

function cancellationRequested(signal: AbortSignal): boolean {
  return signal.aborted;
}
