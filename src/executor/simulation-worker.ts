import type {
  ExecutionSimulationArtifactDraftV1,
} from '../domain/execution-simulation.js';
import { isInternalExecutionAttemptEvaluatorError } from '../executor-simulation/attempt-evaluator.js';
import type { ExecutionIntentReasonCode } from '../domain/execution-intent.js';
import type {
  ClaimedExecutionIntent,
  ExecutionIntentRepository,
} from '../ports/execution-intent-repository.js';
import type { ExecutionSimulationRepository } from '../ports/execution-simulation-repository.js';
import { ExecutionIntentRepositoryError } from '../storage/execution-intent.repository.js';
import { ExecutionSimulationRepositoryError } from '../storage/execution-simulation.repository.js';

export type SimulationRenewBoundary =
  | 'BEFORE_CANONICAL_SNAPSHOT'
  | 'BEFORE_SIMULATION'
  | 'BEFORE_COMMIT';

export interface SimulationAttemptContext {
  readonly claim: ClaimedExecutionIntent;
  readonly attempt: Readonly<{
    readonly intentId: string;
    readonly attemptNumber: number;
    readonly startedAtMs: number;
  }>;
}

export interface SimulationAttemptEvaluator {
  readonly evaluate: (
    context: SimulationAttemptContext,
    signal: AbortSignal,
    renew: (boundary: Exclude<SimulationRenewBoundary, 'BEFORE_COMMIT'>) => Promise<void>,
  ) => Promise<ExecutionSimulationArtifactDraftV1>;
}

export type SimulationOnlyPassResult =
  | 'IDLE'
  | Readonly<{
    readonly kind: 'RECORDED' | 'COMMIT_RECOVERED';
    readonly mode: 'simulation-only';
    readonly intentId: string;
    readonly side: 'BUY' | 'SELL';
    readonly outcome: 'SIMULATION_SUCCEEDED' | 'SIMULATION_FAILED';
    readonly reasonCode: ExecutionIntentReasonCode;
    readonly providerId: string;
  }>;

export interface SimulationOnlyWorkerDependencies {
  readonly intents: Pick<
    ExecutionIntentRepository,
    'claim' | 'transition' | 'beginAttempt' | 'renew'
  >;
  readonly artifacts: ExecutionSimulationRepository;
  readonly evaluator: SimulationAttemptEvaluator;
  readonly ownerId: string;
  readonly leaseMs: number;
  readonly clock?: () => number;
}

export interface SimulationOnlyWorker {
  readonly runOnce: (signal: AbortSignal) => Promise<SimulationOnlyPassResult>;
}

class WorkerCancellationError extends Error {}

export function createSimulationOnlyWorker(
  dependencies: SimulationOnlyWorkerDependencies,
): SimulationOnlyWorker {
  validateDependencies(dependencies);
  let active: Promise<SimulationOnlyPassResult> | null = null;
  const runOnce = (signal: AbortSignal): Promise<SimulationOnlyPassResult> => {
    if (active !== null) return active;
    const tracked = Promise.resolve()
      .then(() => runPass(dependencies, signal))
      .catch((error: unknown) => {
        if (signal.aborted && isAuthenticatedCancellation(error)) return 'IDLE' as const;
        throw error;
      })
      .finally(() => { if (active === tracked) active = null; });
    active = tracked;
    return tracked;
  };
  return Object.freeze({ runOnce });
}

async function runPass(
  dependencies: SimulationOnlyWorkerDependencies,
  signal: AbortSignal,
): Promise<SimulationOnlyPassResult> {
  requireActive(signal);
  let claim = await dependencies.intents.claim(Object.freeze({
    ownerId: dependencies.ownerId,
    leaseMs: dependencies.leaseMs,
    purpose: 'EXECUTE',
  }), signal);
  requireActive(signal);
  if (claim === null) return 'IDLE';

  if (claim.intent.status === 'PENDING' || claim.intent.status === 'RETRY_READY') {
    const previousStatus = claim.intent.status;
    const transitioned = await dependencies.intents.transition(claim, Object.freeze({
      intentId: claim.intent.id,
      expectedStatus: previousStatus,
      nextStatus: 'PROCESSING',
      leaseToken: claim.leaseToken,
      reasonCode: 'EXECUTION_STARTED',
      humanMessage: 'Simulation-only execution intent claimed for processing.',
      activationPhase: 'NONE',
      evidence: Object.freeze({
        payloadVersion: 1,
        attemptNumber: null,
        sourceEventId: null,
        observedAtMs: clockNow(dependencies.clock),
      }),
    }));
    claim = Object.freeze({ ...claim, intent: transitioned });
  }
  if (claim.intent.status !== 'PROCESSING') throw new TypeError('Invalid simulation-only claim.');
  let activeClaim: ClaimedExecutionIntent = claim;
  requireActive(signal);

  const begun = await dependencies.intents.beginAttempt(activeClaim);
  activeClaim = begun.claim;
  const { attempt } = begun;
  requireActive(signal);
  const evaluatorBoundaries = [
    'BEFORE_CANONICAL_SNAPSHOT', 'BEFORE_SIMULATION',
  ] as const;
  let evaluatorBoundaryIndex = 0;
  const renewClaim = async (): Promise<void> => {
    requireActive(signal);
    activeClaim = await dependencies.intents.renew(activeClaim, dependencies.leaseMs);
    requireActive(signal);
  };
  const renewForEvaluator = async (
    boundary: Exclude<SimulationRenewBoundary, 'BEFORE_COMMIT'>,
  ): Promise<void> => {
    if (boundary !== evaluatorBoundaries[evaluatorBoundaryIndex]) {
      throw new TypeError('Invalid simulation renewal boundary.');
    }
    evaluatorBoundaryIndex += 1;
    await renewClaim();
  };
  const draft = await dependencies.evaluator.evaluate(
    Object.freeze({ claim: activeClaim, attempt }),
    signal,
    renewForEvaluator,
  );
  if (evaluatorBoundaryIndex !== evaluatorBoundaries.length) {
    throw new TypeError('Incomplete simulation renewal sequence.');
  }
  assertDraftIdentity(draft, activeClaim, attempt.attemptNumber);
  requireActive(signal);
  await renewClaim();
  requireActive(signal);

  try {
    await dependencies.artifacts.complete(activeClaim, draft, signal);
    return passResult('RECORDED', activeClaim, draft);
  } catch (error) {
    if (!(error instanceof ExecutionSimulationRepositoryError)
      || error.code !== 'COMMIT_OUTCOME_UNKNOWN') throw error;
    const exact = await dependencies.artifacts.findExact(
      draft,
      new AbortController().signal,
    );
    if (exact === null) throw error;
    return passResult('COMMIT_RECOVERED', activeClaim, draft);
  }
}

function passResult(
  kind: 'RECORDED' | 'COMMIT_RECOVERED',
  claim: ClaimedExecutionIntent,
  draft: ExecutionSimulationArtifactDraftV1,
): Exclude<SimulationOnlyPassResult, 'IDLE'> {
  if (draft.intentId !== claim.intent.id) throw new TypeError('Invalid simulation artifact identity.');
  return Object.freeze({
    kind,
    mode: 'simulation-only',
    intentId: draft.intentId,
    side: claim.intent.side,
    outcome: draft.resultKind === 'SUCCESS' ? 'SIMULATION_SUCCEEDED' : 'SIMULATION_FAILED',
    reasonCode: draft.terminalReasonCode,
    providerId: draft.providerId,
  });
}

function assertDraftIdentity(
  draft: ExecutionSimulationArtifactDraftV1,
  claim: ClaimedExecutionIntent,
  attemptNumber: number,
): void {
  const intent = claim.intent;
  if (draft.intentId !== intent.id
    || draft.attemptNumber !== attemptNumber
    || draft.intentStateRevision !== intent.stateRevision
    || draft.strategyId !== intent.strategyId
    || draft.strategyVersion !== intent.strategyVersion
    || draft.decisionFingerprint !== intent.decisionFingerprint) {
    throw new TypeError('Invalid simulation artifact identity.');
  }
}

function requireActive(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) throw new TypeError('Invalid abort signal.');
  if (signal.aborted) throw new WorkerCancellationError();
}

function isAuthenticatedCancellation(error: unknown): boolean {
  return error instanceof WorkerCancellationError
    || isInternalExecutionAttemptEvaluatorError(error, 'OPERATION_ABORTED')
    || (error instanceof ExecutionIntentRepositoryError && error.code === 'OPERATION_ABORTED')
    || (error instanceof ExecutionSimulationRepositoryError && error.code === 'OPERATION_ABORTED');
}

function clockNow(clock: (() => number) | undefined): number {
  const value = (clock ?? Date.now)();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid executor clock.');
  return value;
}

function validateDependencies(value: SimulationOnlyWorkerDependencies): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.ownerId)
    || !Number.isSafeInteger(value.leaseMs) || value.leaseMs <= 0
    || (value.clock !== undefined && typeof value.clock !== 'function')) {
    throw new TypeError('Invalid simulation-only worker dependencies.');
  }
}
