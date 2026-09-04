import {
  ExecutionReconciliationService,
  ExecutionReconciliationServiceError,
} from '../executor-risk/reconciliation-service.js';
import type { LiveConfirmationGateway } from '../executor-live/confirmation-worker.js';
import type {
  ClaimedExecutionIntent,
  ExecutionIntentRepository,
} from '../ports/execution-intent-repository.js';
import type {
  ExecutionLiveConfirmationV1,
  ExecutionLiveRepository,
} from '../ports/execution-live-repository.js';
import type { ExecutionReconciliationEvidenceV1 } from
  '../domain/execution-reconciliation.js';
import type { ExecutionReconciliationGateway } from
  '../ports/execution-reconciliation-gateway.js';
import type { ExecutionReconciliationCommitResultV1 } from
  '../ports/execution-risk-repository.js';
import type { LiveRecoveryConfig } from './config.js';

export type LiveRecoveryLaneResult = 'IDLE' | 'DEFERRED' | 'WORKED';

export type LiveRecoveryLaneErrorCode =
  | 'OPERATION_ABORTED'
  | 'CLAIM_FAILED'
  | 'READ_MODEL_FAILED'
  | 'PROVIDER_MISMATCH'
  | 'GATEWAY_FAILED'
  | 'LEASE_LOST'
  | 'INVALID_EVIDENCE'
  | 'COMMIT_FAILED'
  | 'RELEASE_FAILED'
  | 'DEADLINE_FAILED';

export class LiveRecoveryLaneError extends Error {
  public constructor(public readonly code: LiveRecoveryLaneErrorCode) {
    super('Live recovery lane operation failed.');
    this.name = 'LiveRecoveryLaneError';
  }
}

type RecoveryGateway = ExecutionReconciliationGateway & LiveConfirmationGateway & Readonly<{
  providerId: string;
}>;

export interface LiveRecoveryLaneDependencies {
  readonly config: LiveRecoveryConfig;
  readonly intents: Pick<ExecutionIntentRepository, 'claim' | 'renew' | 'release'>;
  readonly live: Readonly<{
    readReconciliationWork: ExecutionLiveRepository['readReconciliationWork'];
    commitReconciliation(
      claim: ClaimedExecutionIntent,
      evidence: ExecutionReconciliationEvidenceV1,
    ): Promise<unknown>;
    readConfirmationWork: ExecutionLiveRepository['readConfirmationWork'];
    recordConfirmation(
      claim: ClaimedExecutionIntent,
      confirmation: ExecutionLiveConfirmationV1,
    ): Promise<unknown>;
    createNextDeadlineExitIntent: ExecutionLiveRepository['createNextDeadlineExitIntent'];
  }>;
  readonly createGateway: () => RecoveryGateway;
}

export interface LiveRecoveryLanes {
  reconciliation(signal: AbortSignal): Promise<LiveRecoveryLaneResult>;
  confirmation(signal: AbortSignal): Promise<LiveRecoveryLaneResult>;
  deadline(signal: AbortSignal): Promise<LiveRecoveryLaneResult>;
}

export function createLiveRecoveryLanes(
  dependencies: LiveRecoveryLaneDependencies,
): LiveRecoveryLanes {
  const lanes: LiveRecoveryLanes = {
    reconciliation: (signal: AbortSignal) => reconciliationLane(dependencies, signal),
    confirmation: (signal: AbortSignal) => confirmationLane(dependencies, signal),
    deadline: (signal: AbortSignal) => deadlineLane(dependencies, signal),
  };
  return Object.freeze(lanes);
}

async function reconciliationLane(
  dependencies: LiveRecoveryLaneDependencies,
  signal: AbortSignal,
): Promise<LiveRecoveryLaneResult> {
  assertActive(signal);
  const claimed = await claim(dependencies, 'RECONCILE', signal);
  if (claimed === null) return 'IDLE';
  let activeClaim: ClaimedExecutionIntent = claimed;
  let stage: 'READ' | 'GATEWAY' | 'RPC' | 'COMMIT' = 'READ';
  try {
    const work = await dependencies.live.readReconciliationWork(activeClaim);
    stage = 'GATEWAY';
    const gateway = providerGateway(dependencies, work.providerId);
    activeClaim = await renew(dependencies, activeClaim, signal);
    stage = 'RPC';
    const service = new ExecutionReconciliationService(gateway, {
      reconcile: async ({ evidence }): Promise<ExecutionReconciliationCommitResultV1> => {
        activeClaim = await renew(dependencies, activeClaim, signal);
        stage = 'COMMIT';
        await dependencies.live.commitReconciliation(activeClaim, evidence);
        return Object.freeze({
          payloadVersion: 1,
          result: evidence.result,
          evidenceId: evidence.evidenceId,
        });
      },
    });
    await service.reconcile(work.request, signal);
    return 'WORKED';
  } catch (error) {
    const deferred = error instanceof ExecutionReconciliationServiceError
      && error.code === 'READ_FAILED';
    await release(dependencies, activeClaim);
    if (signal.aborted) throw laneFailure('OPERATION_ABORTED');
    if (deferred) return 'DEFERRED';
    if (error instanceof LiveRecoveryLaneError) throw error;
    if (error instanceof ExecutionReconciliationServiceError) {
      throw laneFailure('INVALID_EVIDENCE');
    }
    if (stage === 'READ') throw laneFailure('READ_MODEL_FAILED');
    if (stage === 'GATEWAY') throw laneFailure('GATEWAY_FAILED');
    throw laneFailure('COMMIT_FAILED');
  }
}

async function confirmationLane(
  dependencies: LiveRecoveryLaneDependencies,
  signal: AbortSignal,
): Promise<LiveRecoveryLaneResult> {
  assertActive(signal);
  const claimed = await claim(dependencies, 'CONFIRM', signal);
  if (claimed === null) return 'IDLE';
  let activeClaim: ClaimedExecutionIntent = claimed;
  let stage: 'READ' | 'GATEWAY' | 'COMMIT' = 'READ';
  try {
    const work = await dependencies.live.readConfirmationWork(activeClaim);
    stage = 'GATEWAY';
    const gateway = providerGateway(dependencies, work.providerId);
    activeClaim = await renew(dependencies, activeClaim, signal);
    let observation;
    try {
      observation = await gateway.observeSignature(work.signature, signal);
    } catch {
      await release(dependencies, activeClaim);
      if (signal.aborted) {
        throw new ClaimReleaseHandledError(laneFailure('OPERATION_ABORTED'));
      }
      return 'DEFERRED';
    }
    if (observation.confirmationStatus === 'NOT_FOUND' || observation.observedSlot === null) {
      await release(dependencies, activeClaim);
      return 'DEFERRED';
    }
    activeClaim = await renew(dependencies, activeClaim, signal);
    stage = 'COMMIT';
    await dependencies.live.recordConfirmation(activeClaim, Object.freeze({
      payloadVersion: 1,
      artifactId: work.artifactId,
      expectedRevision: work.expectedRevision,
      signature: work.signature,
      observedSlot: observation.observedSlot,
      observedAtMs: observation.observedAtMs,
    }));
    try {
      await release(dependencies, activeClaim);
    } catch (error) {
      if (error instanceof LiveRecoveryLaneError) {
        throw new ClaimReleaseHandledError(error);
      }
      throw error;
    }
    return 'WORKED';
  } catch (error) {
    if (error instanceof ClaimReleaseHandledError) throw error.cause;
    await release(dependencies, activeClaim);
    if (signal.aborted) throw laneFailure('OPERATION_ABORTED');
    if (error instanceof LiveRecoveryLaneError) throw error;
    if (stage === 'READ') throw laneFailure('READ_MODEL_FAILED');
    if (stage === 'GATEWAY') throw laneFailure('GATEWAY_FAILED');
    throw laneFailure('COMMIT_FAILED');
  }
}

async function deadlineLane(
  dependencies: LiveRecoveryLaneDependencies,
  signal: AbortSignal,
): Promise<LiveRecoveryLaneResult> {
  assertActive(signal);
  try {
    const result = await dependencies.live.createNextDeadlineExitIntent();
    assertActive(signal);
    return result === null || result.kind === 'NOT_DUE' ? 'IDLE' : 'WORKED';
  } catch (error) {
    if (error instanceof LiveRecoveryLaneError) throw error;
    throw laneFailure('DEADLINE_FAILED');
  }
}

async function claim(
  dependencies: LiveRecoveryLaneDependencies,
  purpose: 'CONFIRM' | 'RECONCILE',
  signal: AbortSignal,
): Promise<ClaimedExecutionIntent | null> {
  try {
    return await dependencies.intents.claim(Object.freeze({
      ownerId: dependencies.config.ownerId,
      leaseMs: dependencies.config.leaseMs,
      purpose,
    }), signal);
  } catch {
    if (signal.aborted) throw laneFailure('OPERATION_ABORTED');
    throw laneFailure('CLAIM_FAILED');
  }
}

async function renew(
  dependencies: LiveRecoveryLaneDependencies,
  activeClaim: ClaimedExecutionIntent,
  signal: AbortSignal,
): Promise<ClaimedExecutionIntent> {
  assertActive(signal);
  try {
    return await dependencies.intents.renew(activeClaim, dependencies.config.leaseMs);
  } catch {
    if (signal.aborted) throw laneFailure('OPERATION_ABORTED');
    throw laneFailure('LEASE_LOST');
  }
}

function providerGateway(
  dependencies: LiveRecoveryLaneDependencies,
  durableProviderId: string,
): RecoveryGateway {
  const gateway = dependencies.createGateway();
  if (durableProviderId !== dependencies.config.providerId
    || gateway.providerId !== dependencies.config.providerId) {
    throw laneFailure('PROVIDER_MISMATCH');
  }
  return gateway;
}

async function release(
  dependencies: LiveRecoveryLaneDependencies,
  activeClaim: ClaimedExecutionIntent,
): Promise<void> {
  try {
    if (!await dependencies.intents.release(activeClaim)) throw new Error();
  } catch {
    throw laneFailure('RELEASE_FAILED');
  }
}

class ClaimReleaseHandledError extends Error {
  public constructor(public override readonly cause: LiveRecoveryLaneError) {
    super('Live recovery claim release was already handled.', { cause });
    this.name = 'ClaimReleaseHandledError';
  }
}

function assertActive(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal) || signal.aborted) {
    throw laneFailure('OPERATION_ABORTED');
  }
}

function laneFailure(code: LiveRecoveryLaneErrorCode): LiveRecoveryLaneError {
  return new LiveRecoveryLaneError(code);
}
