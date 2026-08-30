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
  readonly runOnce: () => Promise<DryRunPassResult>;
}

export function createDryRunWorker(dependencies: DryRunWorkerDependencies): DryRunWorker {
  let active: Promise<DryRunPassResult> | null = null;
  const runOnce = (): Promise<DryRunPassResult> => {
    if (active !== null) return active;
    const current = runPass(dependencies).finally(() => {
      if (active === current) active = null;
    });
    active = current;
    return current;
  };
  return Object.freeze({ runOnce });
}

async function runPass(dependencies: DryRunWorkerDependencies): Promise<DryRunPassResult> {
  const claim = await dependencies.intents.claim(Object.freeze({
    ownerId: dependencies.ownerId,
    leaseMs: dependencies.leaseMs,
    purpose: 'DRY_RUN',
  }));
  if (claim === null) return 'IDLE';
  const assessment = createExecutionDryRunAssessment(claim.intent);
  try {
    await dependencies.assessments.complete(claim, assessment);
    return 'RECORDED';
  } catch (error) {
    if (!(error instanceof ExecutionDryRunRepositoryError)
      || error.code !== 'COMMIT_OUTCOME_UNKNOWN') throw error;
    const exact = await dependencies.assessments.findExact(assessment);
    if (exact === null) throw error;
    return 'COMMIT_RECOVERED';
  }
}
