import type { ExecutionReconciliationEvidenceV1 } from '../domain/execution-reconciliation.js';
import type {
  ClaimedExecutionIntent,
  ExecutionIntentRepository,
} from './execution-intent-repository.js';
import type {
  ExecutionLiveConfirmationV1,
  ExecutionLiveRepository,
} from './execution-live-repository.js';

export interface ExecutionLiveRecoveryIntentRepository {
  readonly claimConfirmation: (
    ownerId: string,
    leaseMs: number,
    signal?: AbortSignal,
  ) => Promise<ClaimedExecutionIntent | null>;
  readonly claimReconciliation: (
    ownerId: string,
    leaseMs: number,
    signal?: AbortSignal,
  ) => Promise<ClaimedExecutionIntent | null>;
  readonly renew: (
    claim: ClaimedExecutionIntent,
    leaseMs: number,
  ) => Promise<ClaimedExecutionIntent>;
  readonly release: (claim: ClaimedExecutionIntent) => Promise<boolean>;
}

export interface ExecutionLiveRecoveryRepository {
  readonly readConfirmationWork: ExecutionLiveRepository['readConfirmationWork'];
  readonly recordConfirmation: (
    claim: ClaimedExecutionIntent,
    confirmation: ExecutionLiveConfirmationV1,
  ) => Promise<unknown>;
  readonly readReconciliationWork: ExecutionLiveRepository['readReconciliationWork'];
  readonly commitReconciliation: (
    claim: ClaimedExecutionIntent,
    evidence: ExecutionReconciliationEvidenceV1,
  ) => Promise<unknown>;
  readonly createNextDeadlineExitIntent:
    ExecutionLiveRepository['createNextDeadlineExitIntent'];
}

export function createExecutionLiveRecoveryIntentRepository(
  source: Pick<ExecutionIntentRepository, 'claim' | 'renew' | 'release'>,
): ExecutionLiveRecoveryIntentRepository {
  return exactFacade({
    claimConfirmation: (
      ownerId: string,
      leaseMs: number,
      signal?: AbortSignal,
    ) => source.claim(Object.freeze({ ownerId, leaseMs, purpose: 'CONFIRM' }), signal),
    claimReconciliation: (
      ownerId: string,
      leaseMs: number,
      signal?: AbortSignal,
    ) => source.claim(Object.freeze({ ownerId, leaseMs, purpose: 'RECONCILE' }), signal),
    renew: source.renew.bind(source),
    release: source.release.bind(source),
  });
}

export function createExecutionLiveRecoveryRepository(
  source: Pick<ExecutionLiveRepository,
    | 'readConfirmationWork'
    | 'recordConfirmation'
    | 'readReconciliationWork'
    | 'commitReconciliation'
    | 'createNextDeadlineExitIntent'>,
): ExecutionLiveRecoveryRepository {
  return exactFacade({
    readConfirmationWork: source.readConfirmationWork.bind(source),
    recordConfirmation: source.recordConfirmation.bind(source),
    readReconciliationWork: source.readReconciliationWork.bind(source),
    commitReconciliation: source.commitReconciliation.bind(source),
    createNextDeadlineExitIntent: source.createNextDeadlineExitIntent.bind(source),
  });
}

function exactFacade<T extends object>(methods: T): T {
  const facade = Object.create(null) as T;
  return Object.freeze(Object.assign(facade, methods));
}
