import type { ExecutionIntentRepository } from './execution-intent-repository.js';
import type { ExecutionLiveRepository } from './execution-live-repository.js';
import type { ExecutionSimulationRepository } from './execution-simulation-repository.js';
import type { ExecutionVenueRepository } from './execution-venue-repository.js';

export interface ExecutionLiveRuntimeIntentRepository {
  readonly claim: ExecutionIntentRepository['claim'];
  readonly transition: ExecutionIntentRepository['transition'];
  readonly beginAttempt: ExecutionIntentRepository['beginAttempt'];
  readonly finishAttempt: ExecutionIntentRepository['finishAttempt'];
  readonly renew: ExecutionIntentRepository['renew'];
  readonly release: ExecutionIntentRepository['release'];
}

export interface ExecutionLiveRuntimeVenueRepository {
  readonly findFinalizedCanonicalPumpSwapPool:
    ExecutionVenueRepository['findFinalizedCanonicalPumpSwapPool'];
}

export interface ExecutionLiveRuntimeRepository {
  readonly recoverStrandedPreSignatureLock:
    ExecutionLiveRepository['recoverStrandedPreSignatureLock'];
  readonly assertRunnableWork: ExecutionLiveRepository['assertRunnableWork'];
  readonly readPreparationBinding: ExecutionLiveRepository['readPreparationBinding'];
  readonly authorizeExactSigning: ExecutionLiveRepository['authorizeExactSigning'];
  readonly persistSigned: ExecutionLiveRepository['persistSigned'];
  readonly reserveRpcCall: ExecutionLiveRepository['reserveRpcCall'];
  readonly inspectSignedTransaction: ExecutionLiveRepository['inspectSignedTransaction'];
  readonly recordSignedSimulation: ExecutionLiveRepository['recordSignedSimulation'];
  readonly revokeBeforeSubmission: ExecutionLiveRepository['revokeBeforeSubmission'];
  readonly beginSubmission: ExecutionLiveRepository['beginSubmission'];
  readonly recordSubmissionOutcome: ExecutionLiveRepository['recordSubmissionOutcome'];
}

export interface ExecutionLiveRuntimeSimulationRepository {
  readonly complete: ExecutionSimulationRepository['complete'];
}

export function createExecutionLiveRuntimeIntentRepository(
  source: Pick<ExecutionIntentRepository,
    'claim' | 'transition' | 'beginAttempt' | 'finishAttempt' | 'renew' | 'release'>,
): ExecutionLiveRuntimeIntentRepository {
  return exactFacade({
    claim: source.claim.bind(source),
    transition: source.transition.bind(source),
    beginAttempt: source.beginAttempt.bind(source),
    finishAttempt: source.finishAttempt.bind(source),
    renew: source.renew.bind(source),
    release: source.release.bind(source),
  });
}

export function createExecutionLiveRuntimeVenueRepository(
  source: Pick<ExecutionVenueRepository, 'findFinalizedCanonicalPumpSwapPool'>,
): ExecutionLiveRuntimeVenueRepository {
  return exactFacade({
    findFinalizedCanonicalPumpSwapPool:
      source.findFinalizedCanonicalPumpSwapPool.bind(source),
  });
}

export function createExecutionLiveRuntimeRepository(
  source: Pick<ExecutionLiveRepository,
    | 'recoverStrandedPreSignatureLock'
    | 'assertRunnableWork'
    | 'readPreparationBinding'
    | 'authorizeExactSigning'
    | 'persistSigned'
    | 'reserveRpcCall'
    | 'inspectSignedTransaction'
    | 'recordSignedSimulation'
    | 'revokeBeforeSubmission'
    | 'beginSubmission'
    | 'recordSubmissionOutcome'>,
): ExecutionLiveRuntimeRepository {
  return exactFacade({
    recoverStrandedPreSignatureLock: source.recoverStrandedPreSignatureLock.bind(source),
    assertRunnableWork: source.assertRunnableWork.bind(source),
    readPreparationBinding: source.readPreparationBinding.bind(source),
    authorizeExactSigning: source.authorizeExactSigning.bind(source),
    persistSigned: source.persistSigned.bind(source),
    reserveRpcCall: source.reserveRpcCall.bind(source),
    inspectSignedTransaction: source.inspectSignedTransaction.bind(source),
    recordSignedSimulation: source.recordSignedSimulation.bind(source),
    revokeBeforeSubmission: source.revokeBeforeSubmission.bind(source),
    beginSubmission: source.beginSubmission.bind(source),
    recordSubmissionOutcome: source.recordSubmissionOutcome.bind(source),
  });
}

export function createExecutionLiveRuntimeSimulationRepository(
  source: Pick<ExecutionSimulationRepository, 'complete'>,
): ExecutionLiveRuntimeSimulationRepository {
  return exactFacade({
    complete: source.complete.bind(source),
  });
}

function exactFacade<T extends object>(methods: T): T {
  const facade = Object.create(null) as T;
  return Object.freeze(Object.assign(facade, methods));
}
